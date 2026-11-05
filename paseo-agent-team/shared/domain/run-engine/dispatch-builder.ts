import type {
  RunAssignment,
  RunEffectIntent,
  RunNonceEntry,
  RunRecord,
  RunTaskSpec,
  RunWorkspace,
} from "../../schemas/run-engine/ledger";
import { type BudgetPredebit, predebit } from "./budget";
import { resolveD } from "./delivery-binding";
import { dispatchRequirement, structuralSeats } from "./dispatch-requirement";
import { devEndpoint, producerEpoch } from "./gates";
import { findLockConflicts, type LockConflict, type VerifiedScope } from "./locks";
import { type ReduceFacts, type ReduceResult, reduceRun } from "./reducer";
import { reviewRequirement } from "./tier";
import { assignmentPhase, type RunDispatchEvent } from "./transitions";

/**
 * Producer dispatch constructor (plan 11.4). `task-dispatched` makes the caller assemble the whole
 * assignment, nonce, intent and claims; the reducer only validates. This module assembles them and
 * makes the two decisions the reducer does not: a cross-Run lock grant and a budget reservation.
 *
 * It is pure. Every identifier and the clock come from the caller, so a stored record plus the same
 * input always yields the same event, and nothing here can send a message.
 *
 * `buildDispatch` is the producer path (`member`, `coordinator`). `buildReviewDispatch` is the
 * reviewer and smoker path: it binds the assignment to the task's current delivery, takes no claims
 * (the task keeps the ones it was granted until it is done) and does no lock check.
 */

/**
 * The repo-wide exclusive resource of the M2 workspace policy. Every task claims it, so only one
 * task per repository is in flight, from implementation through review and smoke until it is done.
 * `hot` claims conflict only with the same name in the same repository; they ignore paths, which is
 * why this is not expressed as a `directory` claim on the repository root (`.` is not a valid path).
 */
export const REPO_EXCLUSIVE_RESOURCE = "repo-exclusive";

type RunResourceClaim = RunRecord["resources"][number];

export type DispatchProfile = {
  id: string;
  name: string;
  provider: string;
  model: string | null;
  family: string | null;
};

export type DispatchBuildInput = {
  taskId: string;
  seatId: string;
  purpose?: "member" | "coordinator";
  profile: DispatchProfile;
  /** One value per assignment. In M2 every assignment of a Run may carry the same value. */
  workspace: RunWorkspace;
  /**
   * The host adapter's verdict on every scope of the task (realpath, short names, junctions).
   * Each declared scope must appear here as `verified: true`; nothing here is derived from the task.
   */
  scopes: readonly VerifiedScope[];
  /** Why this seat was chosen; stored on the assignment. */
  reason: string;
  /** Claims held by every other Run, from `store.update`. An untrusted view refuses the grant. */
  otherResources:
    | { trusted: true; claims: readonly RunResourceClaim[] }
    | { trusted: false; claims: readonly RunResourceClaim[] };
  ids: {
    assignmentId: string;
    nonce: string;
    messageId: string;
    intentId: string;
    claimId(index: number): string;
  };
  now: string;
  payload: {
    /** SHA-256 hex of the compiled prompt; the text itself is never stored. */
    hash: string;
    templateVersion: number;
    semanticArgs?: Record<string, unknown>;
  };
};

export type DispatchRefusal =
  | "task-missing"
  | "task-not-dispatchable"
  | "seat-unavailable"
  | "scope-unverified"
  | "other-runs-untrusted"
  | "lock-conflict"
  | "budget-missing"
  | "budget-exhausted"
  | "duplicate-dispatch"
  // Review and smoke only:
  | "delivery-missing"
  | "seat-unqualified"
  | "seat-not-independent"
  | "family-not-independent"
  | "smoke-checklist-invalid"
  | "dev-target-invalid";

export type DispatchBuild =
  | {
      ok: true;
      event: RunDispatchEvent;
      budget: Extract<BudgetPredebit, { status: "reserved" }>;
    }
  | {
      ok: false;
      reason: DispatchRefusal;
      /** Present for `lock-conflict`. Other Runs' conflicts report a namespaced task id. */
      conflicts?: readonly LockConflict[];
    };

type TaskScope = RunTaskSpec["scopes"][number];

function sameScope(declared: TaskScope, verified: VerifiedScope): boolean {
  return (
    verified.verified &&
    verified.repoId === declared.repoId &&
    verified.kind === declared.kind &&
    verified.path === declared.path &&
    verified.access === declared.access
  );
}

/**
 * Other Runs' claims keep their own task ids, and `t1` exists in every Run. `findLockConflicts`
 * lets a task keep its own unfrozen claim, so a foreign claim must never share the requester's id.
 * Task ids cannot contain `:`, so the prefix cannot collide with a real one.
 */
function foreignResources(claims: readonly RunResourceClaim[]): Pick<RunRecord, "resources"> {
  return {
    resources: claims.map((claim) => ({ ...claim, taskId: `other-run:${claim.taskId}` })),
  };
}

export function buildDispatch(record: RunRecord, input: DispatchBuildInput): DispatchBuild {
  const task = record.tasks.find((entry) => entry.spec.id === input.taskId);
  if (!task) return { ok: false, reason: "task-missing" };
  // A rework attempt keeps the claims it already holds; only a first attempt asks for them.
  const rework = task.state === "rework";
  if (task.state !== "ready" && !rework) return { ok: false, reason: "task-not-dispatchable" };

  const seat = record.roster.find((entry) => entry.seatId === input.seatId);
  if (!seat?.enabled || seat.agentId === null) return { ok: false, reason: "seat-unavailable" };

  const { ids } = input;
  const idempotencyKey = `dispatch:${record.runId}:${ids.assignmentId}`;
  if (
    record.outbox.some(
      (intent) => intent.messageId === ids.messageId || intent.idempotencyKey === idempotencyKey,
    ) ||
    record.assignments.some((entry) => entry.assignmentId === ids.assignmentId) ||
    record.nonceRegistry.some((entry) => entry.nonce === ids.nonce)
  ) {
    return { ok: false, reason: "duplicate-dispatch" };
  }

  let claims: RunResourceClaim[] = [];
  if (!rework) {
    for (const declared of task.spec.scopes) {
      if (!input.scopes.some((verified) => sameScope(declared, verified))) {
        return { ok: false, reason: "scope-unverified" };
      }
    }
    if (!input.otherResources.trusted) return { ok: false, reason: "other-runs-untrusted" };

    // The repo-exclusive resource is named, so it carries the repository of the first scope. A task
    // spans exactly the repositories it declares; one claim per repository keeps them serialized.
    const repoIds = [...new Set(task.spec.scopes.map((scope) => scope.repoId))];
    const requestScopes: VerifiedScope[] = [
      ...task.spec.scopes.map((scope): VerifiedScope => ({ ...scope, verified: true })),
      ...repoIds.map(
        (repoId): VerifiedScope => ({
          repoId,
          kind: "hot",
          path: REPO_EXCLUSIVE_RESOURCE,
          access: "write",
          verified: true,
        }),
      ),
    ];
    const request = {
      taskId: task.spec.id,
      phase: "implementation" as const,
      scopes: requestScopes,
    };
    const own = findLockConflicts(record, request);
    const foreign = findLockConflicts(foreignResources(input.otherResources.claims), request);
    if (!own.ok || !foreign.ok) return { ok: false, reason: "scope-unverified" };
    const conflicts = [...own.conflicts, ...foreign.conflicts];
    if (conflicts.length > 0) return { ok: false, reason: "lock-conflict", conflicts };

    claims = requestScopes.map((scope, index) => ({
      claimId: ids.claimId(index),
      taskId: task.spec.id,
      originAssignmentId: ids.assignmentId,
      repoId: scope.repoId,
      kind: scope.kind,
      path: scope.path,
      access: scope.access,
      frozen: false,
      createdAt: input.now,
    }));
  }

  const reservation = predebit(record, {
    seatId: seat.seatId,
    intentKey: idempotencyKey,
    messageId: ids.messageId,
    amount: 1,
    revision: record.revision,
  });
  if (reservation.status === "already-counted") return { ok: false, reason: "duplicate-dispatch" };
  if (reservation.status === "exhausted") {
    return {
      ok: false,
      reason: reservation.reason === "missing" ? "budget-missing" : "budget-exhausted",
    };
  }

  const attempt = task.attempts + 1;
  const assignment: RunAssignment = {
    assignmentId: ids.assignmentId,
    taskId: task.spec.id,
    seatId: seat.seatId,
    agentId: seat.agentId,
    profileId: input.profile.id,
    profileName: input.profile.name,
    provider: input.profile.provider,
    model: input.profile.model,
    family: input.profile.family,
    channelId: seat.channelId,
    tier: seat.tier,
    reason: input.reason,
    purpose: input.purpose ?? "member",
    workspace: input.workspace,
    attempt,
    nonce: ids.nonce,
    messageId: ids.messageId,
    delivery: null,
    acceptedProof: null,
    endedEventKey: null,
    turnId: null,
    state: "assigned",
    createdAt: input.now,
    startedAt: null,
    endedAt: null,
  };
  const nonce: RunNonceEntry = {
    nonce: ids.nonce,
    runId: record.runId,
    taskId: task.spec.id,
    assignmentId: ids.assignmentId,
    attempt,
    phase: "implementation",
    agentId: seat.agentId,
    seatId: seat.seatId,
    issuedAt: input.now,
    acceptedAt: null,
    acceptedEventKey: null,
    revokedAt: null,
    revokeReason: null,
  };
  const intent: RunEffectIntent = {
    id: ids.intentId,
    kind: "dispatch",
    recipient: seat.agentId,
    messageId: ids.messageId,
    idempotencyKey,
    payloadHash: input.payload.hash,
    templateVersion: input.payload.templateVersion,
    state: "prepared",
    recoverySendCount: 0,
    createdAt: input.now,
    confirmedAt: null,
    localCancellation: null,
    taskId: task.spec.id,
    assignmentId: ids.assignmentId,
    semanticArgs: input.payload.semanticArgs ?? {},
  };
  return {
    ok: true,
    budget: reservation,
    event: {
      kind: "task-dispatched",
      taskId: task.spec.id,
      assignment,
      nonce,
      intent,
      claims,
      reissueOfAssignmentId: null,
    },
  };
}

export type ReviewDispatchInput = {
  taskId: string;
  seatId: string;
  purpose: "reviewer" | "smoker";
  profile: DispatchProfile;
  /** Taken from real git state at dispatch; its `baseRef` is the HEAD being reviewed or smoked. */
  workspace: RunWorkspace;
  reason: string;
  /** Smoke only: the registered DEV target this smoker is to use. */
  devServerId?: string;
  ids: { assignmentId: string; nonce: string; messageId: string; intentId: string };
  now: string;
  payload: DispatchBuildInput["payload"];
};

/** Smoke check ids double as the report's check ids: they must be usable as such. */
export function smokeChecklistUsable(checklist: readonly string[]): boolean {
  return (
    checklist.length > 0 &&
    new Set(checklist).size === checklist.length &&
    checklist.every((id) => id.length > 0 && id.length <= 64)
  );
}

/**
 * Reviewer or smoker dispatch for the task's current delivery. Independence is checked here and
 * again by the gates: the seat and agent must differ from the producer's, and an L1 review needs a
 * different model family. The reducer remains the final judge of phase and capacity.
 */
export function buildReviewDispatch(record: RunRecord, input: ReviewDispatchInput): DispatchBuild {
  const task = record.tasks.find((entry) => entry.spec.id === input.taskId);
  if (!task) return { ok: false, reason: "task-missing" };
  if (task.state !== "review") return { ok: false, reason: "task-not-dispatchable" };
  const resolved = resolveD(record, task.spec.id);
  if (resolved.kind !== "ok") return { ok: false, reason: "delivery-missing" };
  const producer = resolved.d.producer;

  const smoke = input.purpose === "smoker";
  const requirement = dispatchRequirement(task, smoke ? "smoke" : "review");
  if (requirement.kind !== "required") return { ok: false, reason: "seat-unqualified" };
  const seat = record.roster.find((entry) => entry.seatId === input.seatId);
  if (!seat?.enabled || seat.agentId === null) return { ok: false, reason: "seat-unavailable" };
  if (!structuralSeats(record.roster, requirement).some((entry) => entry.seatId === seat.seatId)) {
    return { ok: false, reason: "seat-unqualified" };
  }
  if (seat.seatId === producer.seatId || seat.agentId === producer.agentId) {
    return { ok: false, reason: "seat-not-independent" };
  }
  if (!smoke && reviewRequirement(producerEpoch(task, producer)).level === "L1") {
    if (producer.family === null || input.profile.family === null) {
      return { ok: false, reason: "family-not-independent" };
    }
    if (producer.family === input.profile.family) {
      return { ok: false, reason: "family-not-independent" };
    }
  }
  if (smoke) {
    if (!smokeChecklistUsable(task.spec.smokeChecklist)) {
      return { ok: false, reason: "smoke-checklist-invalid" };
    }
    const target = record.policy.devTargets.find((entry) => entry.serverId === input.devServerId);
    if (!target || devEndpoint(target.host) === null) {
      return { ok: false, reason: "dev-target-invalid" };
    }
  }

  const { ids } = input;
  const idempotencyKey = `dispatch:${record.runId}:${ids.assignmentId}`;
  if (
    record.outbox.some(
      (intent) => intent.messageId === ids.messageId || intent.idempotencyKey === idempotencyKey,
    ) ||
    record.assignments.some((entry) => entry.assignmentId === ids.assignmentId) ||
    record.nonceRegistry.some((entry) => entry.nonce === ids.nonce)
  ) {
    return { ok: false, reason: "duplicate-dispatch" };
  }
  const reservation = predebit(record, {
    seatId: seat.seatId,
    intentKey: idempotencyKey,
    messageId: ids.messageId,
    amount: 1,
    revision: record.revision,
  });
  if (reservation.status === "already-counted") return { ok: false, reason: "duplicate-dispatch" };
  if (reservation.status === "exhausted") {
    return {
      ok: false,
      reason: reservation.reason === "missing" ? "budget-missing" : "budget-exhausted",
    };
  }

  const assignment: RunAssignment = {
    assignmentId: ids.assignmentId,
    taskId: task.spec.id,
    seatId: seat.seatId,
    agentId: seat.agentId,
    profileId: input.profile.id,
    profileName: input.profile.name,
    provider: input.profile.provider,
    model: input.profile.model,
    family: input.profile.family,
    channelId: seat.channelId,
    tier: seat.tier,
    reason: input.reason,
    purpose: input.purpose,
    workspace: input.workspace,
    attempt: producer.attempt,
    nonce: ids.nonce,
    messageId: ids.messageId,
    delivery: { producerAssignmentId: producer.assignmentId },
    acceptedProof: null,
    endedEventKey: null,
    turnId: null,
    state: "assigned",
    createdAt: input.now,
    startedAt: null,
    endedAt: null,
  };
  const nonce: RunNonceEntry = {
    nonce: ids.nonce,
    runId: record.runId,
    taskId: task.spec.id,
    assignmentId: ids.assignmentId,
    attempt: producer.attempt,
    phase: assignmentPhase(assignment),
    agentId: seat.agentId,
    seatId: seat.seatId,
    issuedAt: input.now,
    acceptedAt: null,
    acceptedEventKey: null,
    revokedAt: null,
    revokeReason: null,
  };
  const intent: RunEffectIntent = {
    id: ids.intentId,
    kind: "dispatch",
    recipient: seat.agentId,
    messageId: ids.messageId,
    idempotencyKey,
    payloadHash: input.payload.hash,
    templateVersion: input.payload.templateVersion,
    state: "prepared",
    recoverySendCount: 0,
    createdAt: input.now,
    confirmedAt: null,
    localCancellation: null,
    taskId: task.spec.id,
    assignmentId: ids.assignmentId,
    semanticArgs: input.payload.semanticArgs ?? {},
  };
  return {
    ok: true,
    budget: reservation,
    event: {
      kind: "task-dispatched",
      taskId: task.spec.id,
      assignment,
      nonce,
      intent,
      claims: [],
      reissueOfAssignmentId: null,
    },
  };
}

/**
 * Commits a built dispatch: the reducer applies the event, and the budget reservation lands in the
 * same record. The reducer does not touch `budgets`, so without this step a dispatch would be free.
 * Both happen on one returned record, which the caller commits atomically with `store.update`.
 */
export function applyDispatch(
  record: RunRecord,
  built: Extract<DispatchBuild, { ok: true }>,
  facts: ReduceFacts,
): ReduceResult {
  const result = reduceRun(record, built.event, facts);
  if (!result.ok) return result;
  const entries = result.next.budgets.entries;
  const index = entries.findIndex(
    (entry) =>
      entry.scope === built.budget.entry.scope && entry.subjectId === built.budget.entry.subjectId,
  );
  if (index === -1) entries.push(built.budget.entry);
  else entries[index] = built.budget.entry;
  return result;
}

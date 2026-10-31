import type {
  RunAssignment,
  RunCancellationEvidence,
  RunDecisionBinding,
  RunEffectIntent,
  RunEventReceipt,
  RunNonceEntry,
  RunRecord,
  RunTaskRecord,
} from "../../schemas/run-engine/ledger";
import {
  RunCancellationEvidenceSchema,
  RunIdRefSchema,
  RunTimeSchema,
} from "../../schemas/run-engine/ledger";
import type {
  RunDecisionBlock,
  RunReviewReportBlock,
  RunSmokeReportBlock,
  RunTaskDagBlock,
  RunTaskReportBlock,
} from "../../schemas/run-engine/protocol";

export type Binding = RunDecisionBinding;
export type ArchiveIntent = Extract<RunEffectIntent, { kind: "archive" }>;

/** Internal observation may be non-quiescent; only a valid subset is persisted as 167 evidence. */
export type CancellationObservation = {
  assignmentId: string;
  lastTurnId: string | null;
  endedEventKey: string | null;
  refresh: {
    agentId: string;
    status: "initializing" | "idle" | "running" | "closed" | "error" | "missing";
    activeTurn: boolean;
    observedAt: string;
  } | null;
  observationSeq: number;
  cancelIntentId: string;
  receipt: RunCancellationEvidence["receipt"];
};

/** Input allows non-quiescent observations; malformed fields never become clearance facts. */
export function validCancellationObservation(value: unknown): value is CancellationObservation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const observation = value as Record<string, unknown>;
  const fields = [
    "assignmentId",
    "lastTurnId",
    "endedEventKey",
    "observationSeq",
    "cancelIntentId",
    "receipt",
  ] as const;
  if (
    !fields.every(
      (field) => RunCancellationEvidenceSchema.shape[field].safeParse(observation[field]).success,
    )
  )
    return false;
  const refresh = observation.refresh;
  if (refresh === null) return true;
  if (typeof refresh !== "object" || refresh === null || Array.isArray(refresh)) return false;
  const fieldsOfRefresh = refresh as Record<string, unknown>;
  return (
    RunIdRefSchema.safeParse(fieldsOfRefresh.agentId).success &&
    ["initializing", "idle", "running", "closed", "error", "missing"].includes(
      fieldsOfRefresh.status as string,
    ) &&
    typeof fieldsOfRefresh.activeTurn === "boolean" &&
    RunTimeSchema.safeParse(fieldsOfRefresh.observedAt).success
  );
}

export type RunDispatchEvent = {
  kind: "task-dispatched";
  taskId: string;
  assignment: RunAssignment;
  nonce: RunNonceEntry;
  intent: RunEffectIntent;
  claims?: readonly RunRecord["resources"][number][];
  reissueOfAssignmentId: string | null;
};

/** Derived ledger facts are not public reducer commands. */
export const RUN_COUNTER_EVENTS = {
  reworkCount: "rework_started",
  qualityFailures: "quality_failed",
  evidenceReturns: "evidence_returned",
} as const;

export function assignmentPhase(
  assignment: Pick<RunAssignment, "purpose">,
): "implementation" | "review" | "smoke" {
  return assignment.purpose === "reviewer"
    ? "review"
    : assignment.purpose === "smoker"
      ? "smoke"
      : "implementation";
}

/** All assignment purposes are delivered by dispatch; archive/wake/reopen are separate effects. */
export function dispatchIntentMatches(assignment: RunAssignment, intent: RunEffectIntent): boolean {
  return (
    intent.kind === "dispatch" &&
    intent.assignmentId === assignment.assignmentId &&
    intent.taskId === assignment.taskId &&
    intent.messageId === assignment.messageId &&
    intent.recipient === assignment.agentId
  );
}

/** JSON object insertion order is not part of a frozen task definition. */
export function sameStoredValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => sameStoredValue(value, b[index]))
    );
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameStoredValue(left[key], right[key]))
  );
}

/**
 * Complete internal reducer vocabulary. Wire schemas remain unchanged; cancellation intents and
 * observations are engine-internal 194 payloads, not public RPC commands.
 */
export type RunReducerEvent =
  | { kind: "dag-accepted"; block: RunTaskDagBlock }
  | {
      kind: "dag-revised";
      block: RunTaskDagBlock;
      controlNonceDigest: string;
      cancelIntents: readonly Binding[];
      preparedCancelIntents: readonly ArchiveIntent[];
    }
  | RunDispatchEvent
  | { kind: "turn-started"; assignmentId: string; agentId: string; turnId: string }
  | { kind: "turn-ended"; assignmentId: string; endedEventKey: string }
  | { kind: "task-report"; block: RunTaskReportBlock }
  | { kind: "review-report"; block: RunReviewReportBlock }
  | { kind: "smoke-report"; block: RunSmokeReportBlock }
  | { kind: "decision"; block: RunDecisionBlock }
  | {
      kind: "cancel-requested";
      taskIds: readonly [string];
      reason: string;
      controlNonceDigest: string;
      cancelIntents: readonly Binding[];
      preparedCancelIntents: readonly ArchiveIntent[];
    }
  | {
      kind: "cancellation-checked";
      taskId: string;
      evidence: CancellationObservation;
      decisionId: string;
    }
  | { kind: "run-paused" }
  | { kind: "run-resumed" }
  | { kind: "run-finished" }
  | {
      kind: "run-cancelled";
      reason: string;
      controlNonceDigest: string;
      cancelIntents: readonly Binding[];
      preparedCancelIntents: readonly ArchiveIntent[];
    }
  | { kind: "observation-recorded"; receipt: RunEventReceipt };

export const RUN_REDUCER_EVENT_KINDS = [
  "dag-accepted",
  "dag-revised",
  "task-dispatched",
  "turn-started",
  "turn-ended",
  "task-report",
  "review-report",
  "smoke-report",
  "decision",
  "cancel-requested",
  "cancellation-checked",
  "run-paused",
  "run-resumed",
  "run-finished",
  "run-cancelled",
  "observation-recorded",
] as const;

/** Event kinds that B deliberately does not implement; reject loudly instead of ignoring. */
export const BATCH_B_UNSUPPORTED = [
  "work-accepted",
  "review-passed",
  "smoke-passed",
  "dependency-satisfied",
  "force-done",
  "force-transition",
  "dispatch-requested",
] as const;

export type RunFactSource = {
  now: string;
  newId: (kind: string) => string;
};

export function taskById(record: RunRecord, taskId: string): RunTaskRecord | undefined {
  return record.tasks.find((task) => task.spec.id === taskId);
}

export function assignmentById(record: RunRecord, assignmentId: string): RunAssignment | undefined {
  return record.assignments.find((entry) => entry.assignmentId === assignmentId);
}

/** The only settlement proof for an assignment is a true turn-ended receipt, never a report. */
export function isNormalEnded(record: RunRecord, assignment: RunAssignment): boolean {
  if (
    assignment.state !== "ended" ||
    assignment.turnId === null ||
    assignment.endedEventKey === null ||
    assignment.endedAt === null
  ) {
    return false;
  }
  return record.eventReceipts.some(
    (receipt) =>
      receipt.eventKey === assignment.endedEventKey &&
      receipt.kind === "turn_ended" &&
      receipt.agentId === assignment.agentId &&
      receipt.turnId === assignment.turnId &&
      receipt.receivedAt === assignment.endedAt &&
      receipt.seq <= record.counters.observationSeq,
  );
}

function dispatchIntents(record: RunRecord, assignmentId: string): RunEffectIntent[] {
  return record.outbox.filter(
    (intent) => intent.kind === "dispatch" && intent.assignmentId === assignmentId,
  );
}

type CancelStamp = NonNullable<RunEffectIntent["localCancellation"]>;

export function isCancellationKind(kind: string): kind is CancelStamp["cause"] {
  return kind === "cancel-requested" || kind === "dag-revised" || kind === "run-cancelled";
}

/** Unknown turns cannot be explained away by a never-sent marker. Known historical actors can. */
function hasTurnFacts(record: RunRecord, assignment: RunAssignment): boolean {
  return (
    assignment.turnId !== null ||
    assignment.startedAt !== null ||
    assignment.endedAt !== null ||
    assignment.endedEventKey !== null ||
    record.eventReceipts.some(
      (receipt) =>
        receipt.agentId === assignment.agentId &&
        (receipt.kind === "turn_started" || receipt.kind === "turn_ended") &&
        Date.parse(receipt.receivedAt) >= Date.parse(assignment.createdAt) &&
        !record.assignments.some(
          (other) =>
            other.assignmentId !== assignment.assignmentId &&
            other.agentId === receipt.agentId &&
            other.turnId !== null &&
            other.turnId === receipt.turnId,
        ),
    )
  );
}

/** Evaluates the source prepared state before the transaction writes a cancellation marker. */
export function canCancelLocally(
  record: RunRecord,
  assignment: RunAssignment,
  intent: RunEffectIntent,
): boolean {
  return (
    assignment.state === "assigned" &&
    assignment.acceptedProof === null &&
    !hasTurnFacts(record, assignment) &&
    dispatchIntents(record, assignment.assignmentId).length === 1 &&
    dispatchIntentMatches(assignment, intent) &&
    intent.state === "prepared" &&
    intent.recoverySendCount === 0 &&
    intent.confirmedAt === null &&
    intent.localCancellation === null
  );
}

/** Retained events authenticate exact server audit; a compressed prefix uses typed witnesses. */
export function cancellationAuditValid(
  record: RunRecord,
  taskId: string,
  stamp: Pick<CancelStamp, "eventSeq" | "at" | "cause">,
): boolean {
  if (stamp.eventSeq <= 0 || stamp.eventSeq > record.counters.eventsThroughSeq) return false;
  if (Date.parse(stamp.at) > Date.parse(record.updatedAt)) return false;
  if (stamp.eventSeq <= (record.checkpoint?.throughSeq ?? 0)) return true;
  const event = record.events.find((entry) => entry.seq === stamp.eventSeq);
  if (!event || event.kind !== stamp.cause || event.at !== stamp.at) return false;
  let scope: unknown;
  if (event.kind === "cancel-requested") scope = event.payload.taskIds;
  else if (event.kind === "dag-revised") {
    const block = event.payload.block;
    scope =
      block !== null && typeof block === "object" && !Array.isArray(block)
        ? (block as Record<string, unknown>).cancelTaskIds
        : undefined;
  } else if (event.kind === "run-cancelled") scope = record.tasks.map((task) => task.spec.id);
  if (!Array.isArray(scope) || !scope.includes(taskId)) return false;
  const locals = record.outbox
    .filter(
      (intent) =>
        intent.localCancellation?.eventSeq === stamp.eventSeq &&
        intent.localCancellation.at === stamp.at &&
        intent.localCancellation.cause === stamp.cause,
    )
    .map((intent) => intent.id)
    .sort();
  const superseded = record.decisions
    .filter(
      (decision) =>
        decision.state === "superseded" &&
        decision.resolution?.eventSeq === stamp.eventSeq &&
        decision.resolution.at === stamp.at &&
        decision.resolution.cause === stamp.cause,
    )
    .map((decision) => decision.decisionId)
    .sort();
  return sameStoredValue(event.payload.audit, {
    localIntentIds: locals,
    supersededDecisionIds: superseded,
  });
}

export function isLocalNeverSent(record: RunRecord, assignment: RunAssignment): boolean {
  if (
    assignment.acceptedProof !== null ||
    (assignment.state !== "assigned" && assignment.state !== "cancelled") ||
    hasTurnFacts(record, assignment)
  )
    return false;
  const intents = dispatchIntents(record, assignment.assignmentId);
  if (intents.length !== 1) return false;
  const intent = intents[0] as RunEffectIntent;
  const local = intent.localCancellation;
  const nonce = record.nonceRegistry.find(
    (entry) => entry.assignmentId === assignment.assignmentId && entry.nonce === assignment.nonce,
  );
  return (
    dispatchIntentMatches(assignment, intent) &&
    intent.state === "failed" &&
    local !== null &&
    local.reason === "cancel-before-send" &&
    Date.parse(local.at) >= Date.parse(assignment.createdAt) &&
    Date.parse(local.at) >= Date.parse(intent.createdAt) &&
    intent.recoverySendCount === 0 &&
    intent.confirmedAt === null &&
    nonce !== undefined &&
    nonce.acceptedAt === null &&
    nonce.acceptedEventKey === null &&
    nonce.revokedAt === local.at &&
    nonce.revokeReason === "cancel-before-send" &&
    cancellationAuditValid(record, assignment.taskId, local)
  );
}

function actorSettledBy(record: RunRecord, assignment: RunAssignment, at?: string): boolean {
  const limit = at === undefined ? Number.POSITIVE_INFINITY : Date.parse(at);
  if (isLocalNeverSent(record, assignment)) {
    return record.outbox.some(
      (intent) =>
        intent.assignmentId === assignment.assignmentId &&
        intent.localCancellation !== null &&
        Date.parse(intent.localCancellation.at) <= limit,
    );
  }
  if (isNormalEnded(record, assignment)) return Date.parse(assignment.endedAt as string) <= limit;
  if (!isComplete167(record, assignment)) return false;
  const proof = assignment.cancellation as RunCancellationEvidence;
  const ended = record.eventReceipts.find((receipt) => receipt.eventKey === proof.endedEventKey);
  return (
    ended !== undefined &&
    Date.parse(ended.receivedAt) <= limit &&
    Date.parse(proof.refresh.observedAt) <= limit &&
    Date.parse(proof.receipt.confirmedAt as string) <= limit
  );
}

export function isActorSettled(record: RunRecord, assignment: RunAssignment): boolean {
  return actorSettledBy(record, assignment);
}

/** Confirmed side effects need their own retained completion facts, not only a state label. */
export function hasUnsettledEffects(record: RunRecord, taskId?: string, at?: string): boolean {
  return record.outbox.some((intent) => {
    if (taskId !== undefined && intent.taskId !== taskId) return false;
    const assignment = record.assignments.find(
      (entry) => entry.assignmentId === intent.assignmentId,
    );
    if (intent.state === "failed" && intent.localCancellation !== null) {
      return (
        !assignment ||
        !isLocalNeverSent(record, assignment) ||
        !actorSettledBy(record, assignment, at)
      );
    }
    if (
      intent.state !== "confirmed" ||
      intent.confirmedAt === null ||
      (at !== undefined && Date.parse(intent.confirmedAt) > Date.parse(at))
    ) {
      // An archive/dispatch receipt can prove an outcome-unknown operation settled.
      if (
        assignment &&
        (intent.state === "sending" || intent.state === "outcome-unknown") &&
        actorSettledBy(record, assignment, at)
      ) {
        if (intent.kind === "dispatch" && dispatchIntentMatches(assignment, intent)) return false;
        if (
          intent.kind === "archive" &&
          assignment.cancellation?.cancelIntentId === intent.id &&
          isComplete167(record, assignment)
        )
          return false;
      }
      return true;
    }
    if (!assignment || !actorSettledBy(record, assignment, at)) return true;
    if (intent.kind === "dispatch") return !dispatchIntentMatches(assignment, intent);
    if (intent.kind === "archive") {
      return (
        assignment.cancellation?.cancelIntentId !== intent.id || !isComplete167(record, assignment)
      );
    }
    return true;
  });
}

export function noEffectsResolutionValid(
  record: RunRecord,
  decision: RunRecord["decisions"][number],
): boolean {
  const resolution = decision.resolution;
  const task = record.tasks.find((entry) => entry.spec.id === decision.subjectId);
  if (
    decision.state !== "superseded" ||
    decision.category !== "D1" ||
    !task ||
    decision.dedupeKey !== `cancel:${task.spec.id}` ||
    decision.cancelIntents?.length !== 0 ||
    decision.answer !== null ||
    decision.answeredAt !== null ||
    !resolution ||
    resolution.witness.taskId !== task.spec.id ||
    task.state !== "cancelled" ||
    task.releaseDecisionId === decision.decisionId ||
    Date.parse(resolution.at) < Date.parse(decision.createdAt) ||
    record.resources.some((claim) => claim.taskId === task.spec.id) ||
    outstandingAssignments(record, task.spec.id).length > 0 ||
    hasUnsettledEffects(record, task.spec.id, resolution.at) ||
    !record.assignments
      .filter((assignment) => assignment.taskId === task.spec.id)
      .every((assignment) => actorSettledBy(record, assignment, resolution.at)) ||
    !cancellationAuditValid(record, task.spec.id, resolution)
  )
    return false;
  const ids = record.outbox
    .filter(
      (intent) =>
        intent.taskId === task.spec.id &&
        intent.localCancellation !== null &&
        intent.localCancellation.eventSeq === resolution.eventSeq &&
        intent.localCancellation.at === resolution.at &&
        intent.localCancellation.cause === resolution.cause,
    )
    .map((intent) => intent.id)
    .sort();
  return sameStoredValue(ids, resolution.witness.localIntentIds);
}

export function isComplete167(record: RunRecord, assignment: RunAssignment): boolean {
  const evidence = assignment.cancellation;
  if (evidence === undefined || evidence === null) return false;
  if (
    evidence.assignmentId !== assignment.assignmentId ||
    evidence.receipt.kind !== "archive" ||
    evidence.receipt.confirmedAt === null ||
    evidence.receipt.externalId === null ||
    evidence.endedEventKey === null ||
    evidence.lastTurnId === null ||
    evidence.lastTurnId !== assignment.turnId ||
    evidence.refresh.agentId !== assignment.agentId ||
    evidence.observationSeq === 0 ||
    evidence.observationSeq > record.counters.observationSeq
  ) {
    return false;
  }
  const ended = record.eventReceipts.find(
    (receipt) =>
      receipt.eventKey === evidence.endedEventKey &&
      receipt.kind === "turn_ended" &&
      receipt.agentId === assignment.agentId &&
      receipt.turnId === evidence.lastTurnId,
  );
  if (
    !ended ||
    ended.seq > evidence.observationSeq ||
    (assignment.endedAt !== null && assignment.endedAt !== ended.receivedAt) ||
    Date.parse(evidence.refresh.observedAt) < Date.parse(ended.receivedAt)
  )
    return false;
  const intent = record.outbox.find((entry) => entry.id === evidence.cancelIntentId);
  if (
    intent?.kind !== "archive" ||
    intent.taskId !== assignment.taskId ||
    intent.assignmentId !== assignment.assignmentId ||
    intent.recipient !== assignment.agentId ||
    !["sending", "confirmed", "outcome-unknown"].includes(intent.state) ||
    (intent.state === "confirmed" && intent.confirmedAt === null)
  )
    return false;
  if (
    !cancelPairs(record, assignment.taskId).some(
      (pair) => pair.assignmentId === assignment.assignmentId && pair.intentId === intent.id,
    )
  )
    return false;
  if (
    record.assignments.some(
      (other) =>
        other.assignmentId !== assignment.assignmentId &&
        other.cancellation?.receipt.kind === "archive" &&
        other.cancellation.receipt.externalId === evidence.receipt.externalId,
    )
  )
    return false;
  const through =
    taskById(record, assignment.taskId)?.state === "cancelled"
      ? evidence.observationSeq
      : record.counters.observationSeq;
  return (
    evidence.refresh.activeTurn === false &&
    ["idle", "closed", "missing"].includes(evidence.refresh.status) &&
    !record.eventReceipts.some(
      (receipt) =>
        receipt.seq > ended.seq &&
        receipt.seq <= through &&
        receipt.kind === "turn_started" &&
        receipt.agentId === assignment.agentId,
    )
  );
}

/** Fixed old cancellation pairs never disappear when a later NormalEnded arrives. */
export function cancelPairs(record: RunRecord, taskId: string): Binding[] {
  return record.decisions
    .filter(
      (decision) =>
        decision.category === "D1" &&
        decision.subjectId === taskId &&
        decision.dedupeKey === `cancel:${taskId}` &&
        decision.cancelIntents !== null,
    )
    .flatMap((decision) => decision.cancelIntents ?? []);
}

export function cancellationAuthorization(record: RunRecord, taskId: string) {
  return record.decisions.find(
    (decision) =>
      decision.category === "D1" &&
      decision.subjectId === taskId &&
      decision.dedupeKey === `cancel:${taskId}` &&
      decision.state === "answered" &&
      decision.answer !== null &&
      (decision.answer.action === "cancel" || decision.answer.action === "assign-seat") &&
      decision.answer.taskIds.includes(taskId),
  );
}

export function outstandingAssignments(
  record: RunRecord,
  taskId: string,
): readonly RunAssignment[] {
  const paired = new Set(cancelPairs(record, taskId).map((pair) => pair.assignmentId));
  return record.assignments.filter((assignment) => {
    if (assignment.taskId !== taskId) return false;
    if (paired.has(assignment.assignmentId)) return true;
    if (isLocalNeverSent(record, assignment)) return false;
    if (isComplete167(record, assignment)) return false;
    if (isNormalEnded(record, assignment)) return false;
    return true;
  });
}

/** Exact pair coverage over old pairs plus current unsettled actors; no silent prefix. */
export function cancelCoverage(
  record: RunRecord,
  taskIds: readonly string[],
  pairs: readonly Binding[],
): { ok: true } | { ok: false; reason: string } {
  const tasks = new Set(taskIds);
  const expected = new Set<string>();
  for (const taskId of tasks) {
    for (const assignment of outstandingAssignments(record, taskId)) {
      expected.add(assignment.assignmentId);
    }
    const old = cancelPairs(record, taskId);
    for (const pair of old) {
      expected.add(pair.assignmentId);
      if (
        pairs.some(
          (candidate) =>
            candidate.assignmentId === pair.assignmentId && candidate.intentId !== pair.intentId,
        )
      )
        return { ok: false, reason: "fixed-pair-intent" };
    }
    if (
      record.decisions.some(
        (decision) => decision.dedupeKey === `cancel:${taskId}` && decision.state === "answered",
      ) &&
      pairs.some(
        (pair) =>
          assignmentById(record, pair.assignmentId)?.taskId === taskId &&
          !old.some((prior) => prior.assignmentId === pair.assignmentId),
      )
    )
      return { ok: false, reason: "answered-pairs-fixed" };
  }
  const seen = new Set<string>();
  for (const pair of pairs) {
    if (seen.has(pair.assignmentId)) return { ok: false, reason: "duplicate-pair" };
    seen.add(pair.assignmentId);
    const assignment = assignmentById(record, pair.assignmentId);
    if (assignment === undefined || !tasks.has(assignment.taskId)) {
      return { ok: false, reason: "cross-task-pair" };
    }
    const intent = record.outbox.find((entry) => entry.id === pair.intentId);
    if (
      intent === undefined ||
      intent.kind !== "archive" ||
      intent.taskId !== assignment.taskId ||
      intent.assignmentId !== assignment.assignmentId ||
      intent.recipient !== assignment.agentId
    ) {
      return { ok: false, reason: "pair-intent-binding" };
    }
  }
  if (seen.size !== expected.size || [...expected].some((id) => !seen.has(id))) {
    return { ok: false, reason: "incomplete-coverage" };
  }
  return { ok: true };
}

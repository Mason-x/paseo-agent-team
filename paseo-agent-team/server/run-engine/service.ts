import { randomUUID } from "node:crypto";
import { judgedNothing, resolveD } from "../../shared/domain/run-engine/delivery-binding";
import {
  applyDispatch,
  buildDispatch,
  buildReviewDispatch,
  type DispatchBuild,
} from "../../shared/domain/run-engine/dispatch-builder";
import { checkReviewGate, devEndpoint, producerEpoch } from "../../shared/domain/run-engine/gates";
import {
  producerSemanticArgs,
  reviewerSemanticArgs,
  reworkSemanticArgs,
  smokerSemanticArgs,
  templateVersionFor,
} from "../../shared/domain/run-engine/prompt-template";
import {
  eligibleReviewSeats,
  planDispatchWithReasons,
  type SchedulerContext,
  type SchedulerMode,
  type SeatDenial,
  type SeatRuntime,
} from "../../shared/domain/run-engine/scheduler";
import { reviewRequirement } from "../../shared/domain/run-engine/tier";
import type { PaseoEnginePort, PortAgentSnapshot } from "../../shared/paseo/port";
import type { RunRecord, RunTaskRecord } from "../../shared/schemas/run-engine/ledger";
import { type DispatchIntent, type Effects, type OutboxReport, payloadHash } from "./effects";
import {
  deliveredFiles,
  dispatchWorkspace,
  inspectRepo,
  prepareEvidenceDir,
  verifyScopes,
} from "./repo";
import type { OtherResources, RunStore } from "./store";

/**
 * Engine service, single-task path (plan 11.4, M2). One call moves at most one unit of work to a
 * seat: the producer of a ready task, the reviewer of a delivered task, or the smoker of a reviewed
 * task. It gathers the facts that need IO (live seat state, real git state, verified scopes, the
 * delivered diff), then commits the dispatch in one synchronous store update, then runs the outbox.
 *
 * Everything that waits happens before the store lock is taken. The facts can go stale in that gap,
 * which is safe: the committed update re-checks the task, the seat, the locks and the budget
 * against the record it actually holds, and the reducer refuses a stale choice.
 *
 * Not here yet: DAG admission and rework. `compile` is injected (the production one is
 * `compileDispatch` in `prompt-template.ts`) and must ignore `payloadHash`, which is not known until
 * it has run. A judge is only dispatched while HEAD is the delivered commit, on the producer's
 * branch, with a clean tree, and the commit's real diff against the producer's base equals what the
 * report claimed and stays inside the write scope; anything else is reported as blocked and left
 * for a person, never cleaned up.
 */

export type SeatSource = {
  profile: {
    id: string;
    name: string;
    provider: string;
    model: string | null;
    family: string | null;
  };
  /** The Profile is usable right now (resolver's judgement; the ledger's channel state is separate). */
  available: boolean;
  /** Frozen roster declaration order, for the ranking tie-break. */
  order: number;
};

export type EngineServiceOptions = {
  store: Pick<RunStore, "get" | "update">;
  port: PaseoEnginePort;
  effects: Pick<Effects, "runOutbox">;
  /** Static facts about a roster seat. `null` leaves the seat out of scheduling. */
  resolveSeat(record: RunRecord, seatId: string): SeatSource | null;
  /** The shared start Workspace of the Run (M2). `null` blocks dispatch. */
  resolveWorkspace(record: RunRecord): { workspaceId: string; directory: string } | null;
  compile(intent: DispatchIntent, record: RunRecord): string | null;
  ids?: { uuid(): string };
  clock?: { now(): string };
  log?: (message: string, detail?: unknown) => void;
};

export type DispatchPurpose = "member" | "reviewer" | "smoker";

export type DispatchNextResult =
  | { status: "run-unavailable" }
  | { status: "idle" }
  | {
      status: "waiting";
      taskId: string;
      reason: "no-seat";
      denials: readonly SeatDenial[];
    }
  | { status: "blocked"; taskId: string; reason: string; detail?: unknown }
  | {
      status: "dispatched";
      taskId: string;
      purpose: DispatchPurpose;
      assignmentId: string;
      seatId: string;
      outbox: OutboxReport;
    };

const SCHEDULER_MODES: readonly SchedulerMode[] = [
  "sota",
  "economy",
  "economy-all",
  "collaborative",
];

function schedulerMode(record: RunRecord): SchedulerMode {
  const raw = record.team.rawMode as SchedulerMode;
  return SCHEDULER_MODES.includes(raw) ? raw : "sota";
}

function hasPending(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

type Work =
  | { kind: "produce"; task: RunTaskRecord }
  | { kind: "reviewer" | "smoker"; task: RunTaskRecord };

/**
 * The next unit of work, in task order. A delivered task needs a reviewer until one is bound to its
 * current producer, and then (if it has a smoke) a smoker once the review gate has passed. A judge
 * that was dispatched but has not reported keeps the task waiting; it is never dispatched twice.
 */
function nextWork(record: RunRecord): Work | null {
  for (const task of record.tasks) {
    if (task.state === "ready" || task.state === "rework") return { kind: "produce", task };
    if (task.state !== "review") continue;
    // Sent back for rework but the judges are not all finished yet: nothing to dispatch.
    if (task.phase === "awaiting-rework") continue;
    const resolved = resolveD(record, task.spec.id);
    if (resolved.kind !== "ok") continue;
    const producerId = resolved.d.producer.assignmentId;
    // A judge that ended by saying it could not judge (a person has since retried) left the delivery
    // unjudged: it does not count, so the next one is sent. One that is still working, or has judged, does.
    const bound = (purpose: "reviewer" | "smoker") =>
      record.assignments.some(
        (entry) =>
          entry.purpose === purpose &&
          entry.delivery?.producerAssignmentId === producerId &&
          !(entry.state === "ended" && judgedNothing(entry)),
      );
    if (!bound("reviewer")) return { kind: "reviewer", task };
    if (task.spec.devSmoke && !bound("smoker") && checkReviewGate(record, task).ok) {
      return { kind: "smoker", task };
    }
  }
  return null;
}

function sameFiles(claimed: readonly string[], actual: readonly string[]): boolean {
  const normalize = (files: readonly string[]) =>
    [...new Set(files.map((file) => file.replaceAll("\\", "/")))].sort();
  const left = normalize(claimed);
  const right = normalize(actual);
  return left.length === right.length && left.every((file, index) => file === right[index]);
}

export function createEngineService(options: EngineServiceOptions) {
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const uuid = options.ids?.uuid ?? (() => randomUUID());
  const log = options.log ?? (() => undefined);
  const chains = new Map<string, Promise<unknown>>();

  async function liveSnapshot(agentId: string): Promise<PortAgentSnapshot | "unreadable"> {
    try {
      const refreshed = await options.port.agents.ref(agentId).refresh();
      return refreshed?.agent ?? "unreadable";
    } catch (error) {
      log(`cannot read agent ${agentId}`, error);
      return "unreadable";
    }
  }

  async function seatFacts(record: RunRecord): Promise<SeatRuntime[]> {
    const seats: SeatRuntime[] = [];
    for (const seat of record.roster) {
      const source = options.resolveSeat(record, seat.seatId);
      if (!source) continue;
      const snapshot = seat.agentId === null ? "unreadable" : await liveSnapshot(seat.agentId);
      const readable = snapshot !== "unreadable";
      const channel = record.channels.find((entry) => entry.channelId === seat.channelId);
      const mine = record.assignments.filter((entry) => entry.seatId === seat.seatId);
      seats.push({
        seatId: seat.seatId,
        profileId: source.profile.id,
        agentId: seat.agentId,
        enabled: seat.enabled,
        idle: readable && snapshot.status === "idle" && !snapshot.activeTurn,
        permissionPending: readable && hasPending(snapshot.pendingPermissions),
        degraded:
          !readable ||
          Boolean(snapshot.lastError) ||
          snapshot.status === "error" ||
          snapshot.status === "closed",
        channelState: channel?.state ?? "unknown",
        available: source.available,
        load: mine.filter((entry) => entry.state === "assigned" || entry.state === "in_progress")
          .length,
        // Quality failures this seat's earlier producer work ran into: a tie-break, not a gate.
        qualityRework: mine.filter(
          (entry) =>
            ["member", "coordinator", "reopen"].includes(entry.purpose) &&
            (record.tasks.find((task) => task.spec.id === entry.taskId)?.qualityFailures ?? 0) > 0,
        ).length,
        order: source.order,
      });
    }
    return seats;
  }

  /**
   * The one synchronous store update every dispatch goes through: build, apply the reducer, compile
   * the prompt from the finished record, and only then fill in its real hash. Returning `null`
   * leaves the ledger untouched.
   */
  async function commit(
    runId: string,
    spec: {
      taskId: string;
      purpose: DispatchPurpose;
      seatId: string;
      assignmentId: string;
      intentId: string;
    },
    build: (current: RunRecord, otherResources: OtherResources) => DispatchBuild,
  ): Promise<DispatchNextResult> {
    const { taskId } = spec;
    const holder: { result: DispatchNextResult | null } = { result: null };
    await options.store.update(runId, (current, update) => {
      const built = build(current, update.otherResources);
      if (!built.ok) {
        holder.result = {
          status: "blocked",
          taskId,
          reason: built.reason,
          detail: built.conflicts,
        };
        return null;
      }
      const applied = applyDispatch(current, built, {
        now: clock.now(),
        // The only ids the reducer asks for are decision ids, and the ledger requires a UUID.
        newId: () => uuid(),
      });
      if (!applied.ok) {
        holder.result = {
          status: "blocked",
          taskId,
          reason: `reducer-${applied.code}`,
          detail: applied.params,
        };
        return null;
      }
      const intent = applied.next.outbox.find((entry) => entry.id === built.event.intent.id);
      if (intent?.kind !== "dispatch") {
        holder.result = { status: "blocked", taskId, reason: "intent-missing" };
        return null;
      }
      const text = options.compile(intent, applied.next);
      if (text === null) {
        holder.result = { status: "blocked", taskId, reason: "payload-unbuilt" };
        return null;
      }
      intent.payloadHash = payloadHash(text);
      holder.result = {
        status: "dispatched",
        taskId,
        purpose: spec.purpose,
        assignmentId: spec.assignmentId,
        seatId: spec.seatId,
        outbox: { status: "ok", sent: [], reconciled: [], unknown: [], failed: [] },
      };
      return applied.next;
    });
    const result = holder.result;
    if (result === null) return { status: "blocked", taskId, reason: "no-result" };
    if (result.status !== "dispatched") return result;
    return { ...result, outbox: await options.effects.runOutbox(runId) };
  }

  function ids(taskId: string, tag: string, attempt: number) {
    const short = uuid().replace(/-/gu, "").slice(0, 8);
    return {
      short,
      assignmentId: `assignment-${taskId}-${tag}${attempt}-${short}`,
      intentId: `intent-${taskId}-${tag}${attempt}-${short}`,
    };
  }

  async function dispatchProducer(
    runId: string,
    record: RunRecord,
    task: RunTaskRecord,
  ): Promise<DispatchNextResult> {
    const taskId = task.spec.id;
    const rework = task.state === "rework";
    const version = templateVersionFor("member", { rework });
    if (version === null) return { status: "blocked", taskId, reason: "template-missing" };
    // A rework continues from the previous delivery, which must still be what the repository holds.
    let previousDelivery: { branch: string; commit: string } | null = null;
    if (rework) {
      const resolved = resolveD(record, taskId);
      const { producer, proof } = resolved.kind === "ok" ? resolved.d : {};
      if (!producer || !proof || producer.workspace === null || proof.ref.kind !== "git-commit") {
        return { status: "blocked", taskId, reason: "delivery-missing" };
      }
      previousDelivery = {
        branch: producer.workspace.branch,
        commit: proof.ref.value.toLowerCase(),
      };
    }

    const context: SchedulerContext = {
      now: clock.now(),
      mode: schedulerMode(record),
      seats: await seatFacts(record),
      profileAllowed: () => true,
    };
    const plan = planDispatchWithReasons(record, context);
    const proposal = plan.proposals.find((entry) => entry.taskId === taskId);
    if (!proposal) {
      const block = plan.blocked.find((entry) => entry.taskId === taskId);
      return { status: "waiting", taskId, reason: "no-seat", denials: block?.reasons ?? [] };
    }
    const source = options.resolveSeat(record, proposal.seatId);
    if (!source) return { status: "blocked", taskId, reason: "seat-unresolved" };

    const location = options.resolveWorkspace(record);
    if (!location) return { status: "blocked", taskId, reason: "workspace-unresolved" };
    const inspected = await inspectRepo(location.directory);
    if (!inspected.ok) {
      return {
        status: "blocked",
        taskId,
        reason: `repo-${inspected.reason}`,
        detail: inspected.detail,
      };
    }
    if (previousDelivery !== null) {
      if (inspected.repo.branch !== previousDelivery.branch) {
        return { status: "blocked", taskId, reason: "delivery-branch-changed" };
      }
      if (inspected.repo.headSha?.toLowerCase() !== previousDelivery.commit) {
        return { status: "blocked", taskId, reason: "delivery-not-at-head" };
      }
    }
    const workspace = dispatchWorkspace(inspected.repo, location.workspaceId);
    if (!workspace.ok)
      return { status: "blocked", taskId, reason: `workspace-${workspace.reason}` };
    const verified = await verifyScopes(inspected.repo, task.spec.scopes);
    if (!verified.ok) {
      return { status: "blocked", taskId, reason: "scope-rejected", detail: verified.rejected };
    }

    const attempt = task.attempts + 1;
    const named = ids(taskId, "a", attempt);
    const evidence = await prepareEvidenceDir(
      inspected.repo,
      record.policy.evidenceRoot,
      named.assignmentId,
    );
    if (!evidence.ok) {
      return { status: "blocked", taskId, reason: `evidence-root-${evidence.reason}` };
    }
    // Pinned now so the prompt can be rebuilt byte for byte later from the ledger alone.
    const argFacts = { repoRoot: inspected.repo.root, evidenceDir: evidence.dir };
    const semanticArgs = rework
      ? reworkSemanticArgs(task.spec, argFacts)
      : producerSemanticArgs(task.spec, argFacts);

    return commit(
      runId,
      {
        taskId,
        purpose: "member",
        seatId: proposal.seatId,
        assignmentId: named.assignmentId,
        intentId: named.intentId,
      },
      (current, otherResources) =>
        buildDispatch(current, {
          taskId,
          seatId: proposal.seatId,
          profile: source.profile,
          workspace: workspace.workspace,
          scopes: verified.scopes,
          reason: proposal.qualification,
          otherResources,
          ids: {
            assignmentId: named.assignmentId,
            nonce: uuid(),
            messageId: uuid(),
            intentId: named.intentId,
            claimId: (index) => `claim-${taskId}-${named.short}-${index}`,
          },
          now: clock.now(),
          // Replaced in `commit`: the real hash is that of the prompt compiled from the new record.
          payload: { hash: "0".repeat(64), templateVersion: version, semanticArgs },
        }),
    );
  }

  async function dispatchJudge(
    runId: string,
    record: RunRecord,
    task: RunTaskRecord,
    purpose: "reviewer" | "smoker",
  ): Promise<DispatchNextResult> {
    const taskId = task.spec.id;
    const version = templateVersionFor(purpose);
    if (version === null) return { status: "blocked", taskId, reason: "template-missing" };
    const resolved = resolveD(record, taskId);
    if (resolved.kind !== "ok") return { status: "blocked", taskId, reason: "delivery-missing" };
    const { producer, proof } = resolved.d;
    if (proof.ref.kind !== "git-commit" || producer.workspace === null) {
      return { status: "blocked", taskId, reason: "delivery-ref-unsupported" };
    }
    const delivered = proof.ref.value.toLowerCase();

    const context: SchedulerContext = {
      now: clock.now(),
      mode: schedulerMode(record),
      seats: await seatFacts(record),
      profileAllowed: () => true,
    };
    const action = purpose === "reviewer" ? "review" : "smoke";
    const eligibility = eligibleReviewSeats(
      record,
      taskId,
      action,
      context,
      new Set([producer.seatId]),
    );
    // An L1 review needs another model family; the scheduler does not know families.
    const familyMatters =
      purpose === "reviewer" && reviewRequirement(producerEpoch(task, producer)).level === "L1";
    const candidate = eligibility.candidates.find((entry) => {
      const source = options.resolveSeat(record, entry.seatId);
      if (!source) return false;
      return (
        !familyMatters ||
        (source.profile.family !== null && source.profile.family !== producer.family)
      );
    });
    if (!candidate) {
      return { status: "waiting", taskId, reason: "no-seat", denials: eligibility.denials };
    }
    const source = options.resolveSeat(record, candidate.seatId);
    if (!source) return { status: "blocked", taskId, reason: "seat-unresolved" };

    const location = options.resolveWorkspace(record);
    if (!location) return { status: "blocked", taskId, reason: "workspace-unresolved" };
    const inspected = await inspectRepo(location.directory);
    if (!inspected.ok) {
      return {
        status: "blocked",
        taskId,
        reason: `repo-${inspected.reason}`,
        detail: inspected.detail,
      };
    }
    const repo = inspected.repo;
    if (repo.branch !== producer.workspace.branch) {
      return { status: "blocked", taskId, reason: "delivery-branch-changed" };
    }
    if (repo.headSha?.toLowerCase() !== delivered) {
      return { status: "blocked", taskId, reason: "delivery-not-at-head" };
    }
    const workspace = dispatchWorkspace(repo, location.workspaceId);
    if (!workspace.ok)
      return { status: "blocked", taskId, reason: `workspace-${workspace.reason}` };

    // The gate only sees what the report claims, and it has already held the claim to the write
    // scope; so a real diff that equals the claim is inside the scope too. Anything else (a file
    // the member changed and did not report) is left for a person, never reviewed as if clean.
    const actual = await deliveredFiles(repo, producer.workspace.baseRef, delivered);
    if (!actual.ok) return { status: "blocked", taskId, reason: `delivery-${actual.reason}` };
    if (!sameFiles(proof.changedFiles, actual.files)) {
      return {
        status: "blocked",
        taskId,
        reason: "delivery-diff-mismatch",
        detail: { claimed: proof.changedFiles, actual: actual.files },
      };
    }

    let devServerId: string | undefined;
    if (purpose === "smoker") {
      devServerId = record.policy.devTargets.find(
        (entry) => devEndpoint(entry.host) !== null,
      )?.serverId;
      if (devServerId === undefined) {
        return { status: "blocked", taskId, reason: "dev-target-invalid" };
      }
    }

    const named = ids(taskId, purpose === "reviewer" ? "r" : "s", producer.attempt);
    const evidence = await prepareEvidenceDir(repo, record.policy.evidenceRoot, named.assignmentId);
    if (!evidence.ok) {
      return { status: "blocked", taskId, reason: `evidence-root-${evidence.reason}` };
    }
    const facts = { repoRoot: repo.root, evidenceDir: evidence.dir };
    const semanticArgs =
      devServerId === undefined
        ? reviewerSemanticArgs(task.spec, facts)
        : smokerSemanticArgs(task.spec, { ...facts, devServerId });

    return commit(
      runId,
      {
        taskId,
        purpose,
        seatId: candidate.seatId,
        assignmentId: named.assignmentId,
        intentId: named.intentId,
      },
      (current) =>
        buildReviewDispatch(current, {
          taskId,
          seatId: candidate.seatId,
          purpose,
          profile: source.profile,
          workspace: workspace.workspace,
          reason: candidate.qualification,
          devServerId,
          ids: {
            assignmentId: named.assignmentId,
            nonce: uuid(),
            messageId: uuid(),
            intentId: named.intentId,
          },
          now: clock.now(),
          payload: { hash: "0".repeat(64), templateVersion: version, semanticArgs },
        }),
    );
  }

  async function dispatchNextUnlocked(runId: string): Promise<DispatchNextResult> {
    const read = await options.store.get(runId);
    if (read.status !== "ok") return { status: "run-unavailable" };
    // Only an active Run dispatches: paused, finished and cancelled ones, and one still waiting for
    // its DAG, have nothing to send.
    if (read.record.lifecycle !== "active") return { status: "idle" };
    const work = nextWork(read.record);
    if (!work) return { status: "idle" };
    return work.kind === "produce"
      ? dispatchProducer(runId, read.record, work.task)
      : dispatchJudge(runId, read.record, work.task, work.kind);
  }

  return {
    /**
     * Moves the next unit of work (producer, reviewer or smoker, in task order) to the best
     * available seat and sends it. Calls for one Run are serialized in this process; across
     * processes the store's lock and CAS decide.
     */
    dispatchNext(runId: string): Promise<DispatchNextResult> {
      const previous = chains.get(runId) ?? Promise.resolve();
      const run = previous.catch(() => undefined).then(() => dispatchNextUnlocked(runId));
      chains.set(
        runId,
        run.catch(() => undefined),
      );
      return run;
    },
  };
}

export type EngineService = ReturnType<typeof createEngineService>;

import { randomUUID } from "node:crypto";
import { cancelPending } from "../../shared/domain/run-engine/cancel-request";
import {
  CAPACITY_REFUSE_ALERT,
  CAPACITY_WARN_ALERT,
  type CompactionLimits,
  capacityIssue,
} from "../../shared/domain/run-engine/compaction";
import {
  judgedNothing,
  producerHead,
  resolveD,
  resolveProducerProof,
} from "../../shared/domain/run-engine/delivery-binding";
import {
  applyDispatch,
  buildDispatch,
  buildEvidenceReissue,
  buildReviewDispatch,
  type DispatchBuild,
} from "../../shared/domain/run-engine/dispatch-builder";
import {
  EVIDENCE_TEMPLATE_VERSION,
  evidenceIssueCanBeRepaired,
  evidenceRepairOf,
} from "../../shared/domain/run-engine/evidence-repair";
import {
  FAILED_LIMIT_ALERT_PREFIX,
  failedLimitAlert,
  failedTaskLimit,
} from "../../shared/domain/run-engine/failure-limit";
import {
  checkEvidenceGate,
  checkReviewGate,
  devEndpoint,
  producerEpoch,
} from "../../shared/domain/run-engine/gates";
import { isAgentArchived } from "../../shared/domain/run-engine/lost-turn";
import {
  producerSemanticArgs,
  reviewerSemanticArgs,
  reworkSemanticArgs,
  smokerSemanticArgs,
  templateVersionFor,
} from "../../shared/domain/run-engine/prompt-template";
import { raiseAlert, resolveAlerts } from "../../shared/domain/run-engine/run-alert";
import { rebindBlocker } from "../../shared/domain/run-engine/run-record";
import {
  eligibleReviewSeats,
  heldByClosedSeat,
  planDispatchWithReasons,
  type SchedulerContext,
  type SchedulerMode,
  type SeatDenial,
  type SeatRuntime,
} from "../../shared/domain/run-engine/scheduler";
import {
  SEAT_CLOSED_ALERT,
  SEAT_CLOSED_ALERT_PREFIX,
} from "../../shared/domain/run-engine/seat-closed";
import {
  readSeatRebuilds,
  rebuildsOfSeat,
  rebuildTitle,
  SEAT_REBUILD_MAX_PER_SEAT,
  settleRebuildAlerts,
} from "../../shared/domain/run-engine/seat-rebuild";
import {
  classifySeatForReopen,
  mayReopen,
  REOPEN_READS_PER_PASS,
  REOPEN_TIMEOUT_MS,
  reopenKey,
  reopenOrder,
} from "../../shared/domain/run-engine/seat-reopen";
import { reviewRequirement } from "../../shared/domain/run-engine/tier";
import { isNormalEnded } from "../../shared/domain/run-engine/transitions";
import type { PaseoEnginePort, PortAgentSnapshot } from "../../shared/paseo/port";
import type {
  RunAssignment,
  RunRecord,
  RunTaskRecord,
} from "../../shared/schemas/run-engine/ledger";
import { alertIdFor } from "./digest";
import { type DispatchIntent, type Effects, type OutboxReport, payloadHash } from "./effects";
import type { ReadFailure } from "./read-retry";
import {
  deliveredFiles,
  dispatchWorkspace,
  inspectRepo,
  prepareEvidenceDir,
  verifyScopes,
} from "./repo";
import {
  checkRebuildable,
  hasCreatingRebuild,
  type RebuildDeps,
  type RebuildHost,
  resumeRebuilds,
  startRebuild,
  warnCannotRebuild,
} from "./seat-rebuild";
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
  /**
   * Told when the live state of a seat could not be read before a dispatch. The caller may write that
   * down so the read is tried again later (`read-retry.ts`); the dispatch is not retried by this.
   */
  onReadFailure?: (runId: string, failure: ReadFailure) => void | Promise<void>;
  /** Lower thresholds for tests; the defaults are the ledger-sized ones in `compaction.ts`. */
  capacityLimits?: Partial<CompactionLimits>;
  /** How long reading a closed member's history to reopen it may take (default 30 s). */
  reopenTimeoutMs?: number;
  /**
   * What rebuilding a member's Agent needs from the host (T11b). Absent, the Engine reopens closed seats
   * as before and never rebuilds one.
   */
  rebuild?: Omit<RebuildHost, "reopenAgent">;
  /** How long a person's "check now" lets a seat be rebuilt a second time (default 2 minutes). */
  rebuildPermitMs?: number;
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
  | {
      status: "blocked";
      taskId: string;
      reason: string;
      detail?: unknown;
      /** For a budget refusal: the seat whose budget it is (not part of any wire shape). */
      seatId?: string;
    }
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
  | { kind: "produce" | "evidence"; task: RunTaskRecord }
  | { kind: "reviewer" | "smoker"; task: RunTaskRecord };

/**
 * The next unit of work, in task order. A delivered task needs a reviewer until one is bound to its
 * current producer, and then (if it has a smoke) a smoker once the review gate has passed. A judge
 * that was dispatched but has not reported keeps the task waiting; it is never dispatched twice.
 * With `startNew` false a task that has not started (`ready`) is passed over, so the failed-task gate
 * can still reach the work under way behind it (a rework, a review, a smoke, a supplement).
 */
function nextWork(
  record: RunRecord,
  options: { startNew: boolean } = { startNew: true },
): Work | null {
  // A supplement keeps the repository claim already held by its task. Consider it before new
  // tasks, which otherwise can be blocked by that claim and prevent the holder from progressing.
  if (record.schemaVersion === 2) {
    for (const task of record.tasks) {
      if (
        (task.state !== "assigned" && task.state !== "in_progress") ||
        task.evidenceReturns === 0
      ) {
        continue;
      }
      const head = producerHead(record, task.spec.id);
      if (
        head.kind === "ok" &&
        isNormalEnded(record, head.assignment) &&
        resolveProducerProof(record, head.assignment.assignmentId) &&
        !checkEvidenceGate(record, task).ok
      ) {
        return { kind: "evidence", task };
      }
    }
  }
  for (const task of record.tasks) {
    // A task that has not started yet (`ready`) is skipped when nothing new may start, and the walk goes
    // on to the work already under way: a rework, a review, a smoke.
    if (task.state === "ready" && !options.startNew) continue;
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
          !(entry.state === "ended" && judgedNothing(record, entry)),
      );
    if (!bound("reviewer")) return { kind: "reviewer", task };
    if (task.spec.devSmoke && !bound("smoker") && checkReviewGate(record, task).ok) {
      return { kind: "smoker", task };
    }
  }
  return null;
}

/**
 * An L1 review needs another model family than the producer's; the scheduler does not know families.
 * Every other judge (a lower tier, a smoke) may be of any family.
 */
function judgeFamilyAllows(
  task: RunTaskRecord,
  producer: RunAssignment,
  purpose: "reviewer" | "smoker",
  source: SeatSource,
): boolean {
  const familyMatters =
    purpose === "reviewer" && reviewRequirement(producerEpoch(task, producer)).level === "L1";
  return (
    !familyMatters || (source.profile.family !== null && source.profile.family !== producer.family)
  );
}

/** The refusal of a seat the host reads as closed (a denial, not a blocked reason). */
function closedDenial(seatId: string): SeatDenial {
  const reason: SeatDenial["reason"] = "seat-closed";
  return { seatId, reason };
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
  /**
   * The closed seats this process has already tried to reopen by themselves, by (Run, seat, Agent). A
   * person's "check now" clears the Run's entries (`grantReopen`) and so allows one more try each.
   */
  const reopenTried = new Set<string>();
  /**
   * The closed seats whose reading was tried by this process and did not bring them back (it threw, timed out
   * or left the seat closed), by the same key. Unlike `reopenTried` a person's "check now" does not clear it:
   * it says what happened, not whether to try again. A seat that never ran is only rebuilt once it is in here.
   */
  const reopenFailed = new Set<string>();
  /**
   * A Run a person has just asked to check (`grantReopen`) until when: only then may a seat that already
   * had a rebuild that failed be rebuilt a second time. An automatic pass (a restart's recovery, a hook) never
   * gives it, and a failed rebuild is not a permission.
   */
  const rebuildPermit = new Map<string, number>();
  /** The seat facts the last dispatch of each Run was planned with, so reopening ranks the same way. */
  const lastSeatFacts = new Map<string, readonly SeatRuntime[]>();

  async function liveSnapshot(
    runId: string,
    agentId: string,
  ): Promise<PortAgentSnapshot | "unreadable"> {
    try {
      const refreshed = await options.port.agents.ref(agentId).refresh();
      return refreshed?.agent ?? "unreadable";
    } catch (error) {
      log(`cannot read agent ${agentId}`, error);
      // The read threw, so it may work a moment later: let the owner of the retries know.
      try {
        await options.onReadFailure?.(runId, { type: "seat", agentId });
      } catch (reportError) {
        log(`could not report the failed read of ${agentId}`, reportError);
      }
      return "unreadable";
    }
  }

  async function seatFacts(record: RunRecord): Promise<SeatRuntime[]> {
    const seats: SeatRuntime[] = [];
    for (const seat of record.roster) {
      const source = options.resolveSeat(record, seat.seatId);
      if (!source) continue;
      const snapshot =
        seat.agentId === null ? "unreadable" : await liveSnapshot(record.runId, seat.agentId);
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
        // Archived seats take no work for the rest of this Run: nothing here resumes one.
        archived: isAgentArchived(record, seat.agentId),
        // Read as closed: a restart leaves it so, and nothing here reopens it (see `heldByClosedSeat`).
        closed: readable && snapshot.status === "closed",
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
    lastSeatFacts.set(record.runId, seats);
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
          ...(built.reason === "budget-exhausted" || built.reason === "budget-missing"
            ? { seatId: spec.seatId }
            : {}),
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

  async function dispatchEvidence(
    runId: string,
    record: RunRecord,
    task: RunTaskRecord,
  ): Promise<DispatchNextResult> {
    const taskId = task.spec.id;
    if (record.launch.state === "failed" || record.launch.state === "cancelled") {
      return { status: "blocked", taskId, reason: "launch-unavailable" };
    }
    const head = producerHead(record, taskId);
    if (head.kind !== "ok") return { status: "blocked", taskId, reason: "delivery-missing" };
    const previous = head.assignment;
    const rootId = evidenceRepairOf(record, previous)?.rootAssignmentId ?? previous.assignmentId;
    const root = record.assignments.find((entry) => entry.assignmentId === rootId);
    const proof = resolveProducerProof(record, rootId);
    if (!root || root.workspace === null || !proof || proof.ref.kind !== "git-commit") {
      return { status: "blocked", taskId, reason: "delivery-ref-unsupported" };
    }
    const gate = checkEvidenceGate(record, task);
    if (gate.ok) return { status: "idle" };
    const issue = gate.issues[0];
    const reason = issue?.params.reason;
    if (!evidenceIssueCanBeRepaired(reason)) {
      return { status: "blocked", taskId, reason: "evidence-not-repairable" };
    }
    if (task.evidenceReturns > record.policy.perTask.evidenceReturns) {
      return { status: "blocked", taskId, reason: "evidence-return-limit" };
    }
    const seat = (await seatFacts(record)).find((entry) => entry.seatId === previous.seatId);
    // The producer's own Agent reads as closed (a restart left it so): a wait like any other closed
    // seat, so it is reopened by reading its history and the person is told when it cannot be.
    if (
      seat &&
      seat.closed === true &&
      seat.archived !== true &&
      seat.agentId === previous.agentId &&
      seat.enabled &&
      seat.available &&
      !record.policy.disabledChannels.includes(previous.channelId) &&
      !record.policy.disabledProfileIds.includes(previous.profileId)
    ) {
      return {
        status: "waiting",
        taskId,
        reason: "no-seat",
        denials: [closedDenial(seat.seatId)],
      };
    }
    if (
      !seat ||
      seat.agentId !== previous.agentId ||
      !seat.enabled ||
      !seat.available ||
      !seat.idle ||
      seat.permissionPending ||
      seat.degraded ||
      seat.channelState !== "available" ||
      record.policy.disabledChannels.includes(previous.channelId) ||
      record.policy.disabledProfileIds.includes(previous.profileId)
    ) {
      return { status: "blocked", taskId, reason: "evidence-seat-unavailable" };
    }
    const location = options.resolveWorkspace(record);
    if (!location || location.workspaceId !== root.workspace.id) {
      return { status: "blocked", taskId, reason: "workspace-unresolved" };
    }
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
    const delivered = proof.ref.value.toLowerCase();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(delivered)) {
      return { status: "blocked", taskId, reason: "delivery-ref-unsupported" };
    }
    if (repo.branch !== root.workspace.branch) {
      return { status: "blocked", taskId, reason: "delivery-branch-changed" };
    }
    if (repo.headSha?.toLowerCase() !== delivered) {
      return { status: "blocked", taskId, reason: "delivery-not-at-head" };
    }
    const workspace = dispatchWorkspace(repo, location.workspaceId);
    if (!workspace.ok)
      return { status: "blocked", taskId, reason: `workspace-${workspace.reason}` };
    const verified = await verifyScopes(repo, task.spec.scopes);
    if (!verified.ok) {
      return { status: "blocked", taskId, reason: "scope-rejected", detail: verified.rejected };
    }
    const actual = await deliveredFiles(repo, root.workspace.baseRef, delivered);
    if (!actual.ok) return { status: "blocked", taskId, reason: `delivery-${actual.reason}` };
    if (!sameFiles(proof.changedFiles, actual.files)) {
      return { status: "blocked", taskId, reason: "delivery-diff-mismatch" };
    }
    const named = ids(taskId, "e", task.evidenceReturns);
    const evidence = await prepareEvidenceDir(repo, record.policy.evidenceRoot, named.assignmentId);
    if (!evidence.ok)
      return { status: "blocked", taskId, reason: `evidence-root-${evidence.reason}` };
    const semanticArgs = {
      ...producerSemanticArgs(task.spec, { repoRoot: repo.root, evidenceDir: evidence.dir }),
      template: "evidence",
      evidenceDiagnostic: {
        reason: String(reason).slice(0, 100),
        path: (issue?.path.map(String).join(".") ?? "").slice(0, 200),
      },
    };
    return commit(
      runId,
      {
        taskId,
        purpose: "member",
        seatId: previous.seatId,
        assignmentId: named.assignmentId,
        intentId: named.intentId,
      },
      (current, otherResources) =>
        buildEvidenceReissue(current, {
          taskId,
          predecessorAssignmentId: previous.assignmentId,
          scopes: verified.scopes,
          otherResources,
          ids: {
            assignmentId: named.assignmentId,
            nonce: uuid(),
            messageId: uuid(),
            intentId: named.intentId,
          },
          now: clock.now(),
          payload: {
            hash: "0".repeat(64),
            templateVersion: EVIDENCE_TEMPLATE_VERSION,
            semanticArgs,
          },
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
    const candidate = eligibility.candidates.find((entry) => {
      const source = options.resolveSeat(record, entry.seatId);
      return source !== null && judgeFamilyAllows(task, producer, purpose, source);
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

  /** One alert per kind, found again by its text, so asking again writes nothing. */
  async function noteCapacity(runId: string, level: "refuse" | "warn"): Promise<void> {
    const summary = level === "refuse" ? CAPACITY_REFUSE_ALERT : CAPACITY_WARN_ALERT;
    try {
      await options.store.update(runId, (current) => {
        const raised = raiseAlert(
          current,
          {
            alertId: alertIdFor(summary),
            severity: level === "refuse" ? "critical" : "warning",
            summary,
          },
          clock.now(),
        );
        return raised.changed ? raised.next : null;
      });
    } catch (error) {
      log(`could not note the ledger capacity of ${runId}`, error);
    }
  }

  /**
   * One critical alert while the failed-task limit is exceeded and a task that has not started is held
   * back by it, found again by its fixed prefix so asking again writes nothing. Once the count is back within the limit the alert is taken down, but
   * only if there is one to take down: a Run that never exceeded it is never written to for this.
   */
  async function noteFailedLimit(runId: string, limit: number): Promise<void> {
    try {
      await options.store.update(runId, (current) => {
        const raised = raiseAlert(
          current,
          {
            alertId: alertIdFor(FAILED_LIMIT_ALERT_PREFIX),
            severity: "critical",
            summary: failedLimitAlert(limit),
          },
          clock.now(),
        );
        return raised.changed ? raised.next : null;
      });
    } catch (error) {
      log(`could not note the failed-task limit of ${runId}`, error);
    }
  }

  function hasOpenFailedLimitAlert(record: RunRecord): boolean {
    return record.alerts.some(
      (alert) => alert.state !== "resolved" && alert.summary.startsWith(FAILED_LIMIT_ALERT_PREFIX),
    );
  }

  async function clearFailedLimit(runId: string): Promise<void> {
    try {
      await options.store.update(runId, (current) => {
        const resolved = resolveAlerts(
          current,
          (alert) => alert.summary.startsWith(FAILED_LIMIT_ALERT_PREFIX),
          clock.now(),
        );
        return resolved.changed ? resolved.next : null;
      });
    } catch (error) {
      log(`could not take down the failed-task alert of ${runId}`, error);
    }
  }

  function hasOpenSeatClosedAlert(record: RunRecord): boolean {
    return record.alerts.some(
      (alert) => alert.state !== "resolved" && alert.summary.startsWith(SEAT_CLOSED_ALERT_PREFIX),
    );
  }

  /**
   * Takes down the rebuild alerts that no longer tell the truth (`settleRebuildAlerts`). Only a Run that has
   * ever had one is looked at, so a Run that never rebuilt is not written to.
   */
  async function noteRebuildAlerts(
    runId: string,
    record: RunRecord,
    state: { held: boolean; over: boolean },
  ): Promise<void> {
    const mine = record.alerts.some(
      (alert) => alert.state !== "resolved" && alert.alertId.startsWith("rebuild-"),
    );
    if (!mine && readSeatRebuilds(record).kind !== "valid") return;
    try {
      await options.store.update(runId, (current) => {
        const next = settleRebuildAlerts(current, state, clock.now());
        return next === current ? null : next;
      });
    } catch (error) {
      log(`could not take down the rebuild alerts of ${runId}`, error);
    }
  }

  /**
   * One warning while the task this pass looked at is held back only by closed seats, found again by its
   * fixed prefix so asking again writes nothing. It is taken down once that stops being true (a seat
   * is idle again, a pass went on to something else, or there is nothing left to dispatch), and only if
   * there is one to take down.
   */
  async function noteSeatClosed(
    runId: string,
    record: RunRecord,
    result: DispatchNextResult | null,
  ): Promise<void> {
    const held = result?.status === "waiting" && heldByClosedSeat(result.denials);
    await noteRebuildAlerts(runId, record, { held, over: false });
    if (held === hasOpenSeatClosedAlert(record)) return;
    try {
      await options.store.update(runId, (current) => {
        if (held) {
          if (hasOpenSeatClosedAlert(current)) return null;
          const raised = raiseAlert(
            current,
            {
              alertId: alertIdFor(SEAT_CLOSED_ALERT_PREFIX),
              severity: "warning",
              summary: SEAT_CLOSED_ALERT,
            },
            clock.now(),
          );
          return raised.changed ? raised.next : null;
        }
        const resolved = resolveAlerts(
          current,
          (alert) => alert.summary.startsWith(SEAT_CLOSED_ALERT_PREFIX),
          clock.now(),
        );
        return resolved.changed ? resolved.next : null;
      });
    } catch (error) {
      log(`could not note the closed seats of ${runId}`, error);
    }
  }

  /**
   * The closed seats the work waits for that are worth reading, in the scheduler's own order (`rankCandidates`:
   * load, quality rework, frozen order, seat id). A seat is worth reading only if, once it reads idle, the
   * scheduler would hand it the work: it carries no other work (a supplement goes back to the producer that
   * already holds the task, so it is the exception), its Profile and channel are usable and nothing waits for
   * a permission. A review that needs another family is also limited to seats that family gate allows. The facts
   * are the ones the dispatch that refused the work was planned with.
   */
  function reopenCandidates(
    record: RunRecord,
    work: Work,
    denials: readonly SeatDenial[],
  ): { seatId: string; agentId: string }[] {
    const facts = lastSeatFacts.get(record.runId) ?? [];
    const resolved = work.kind === "reviewer" ? resolveD(record, work.task.spec.id) : null;
    const ordered = reopenOrder(
      facts,
      denials.filter((denial) => denial.reason === "seat-closed").map((denial) => denial.seatId),
      {
        ignoreLoad: work.kind === "evidence",
        allows: (seat) => {
          const source = options.resolveSeat(record, seat.seatId);
          if (source === null) return false;
          if (work.kind !== "reviewer") return true;
          return (
            resolved?.kind === "ok" &&
            judgeFamilyAllows(work.task, resolved.d.producer, "reviewer", source)
          );
        },
      },
    );
    return ordered.flatMap((seatId) => {
      const agentId = facts.find((entry) => entry.seatId === seatId)?.agentId;
      return agentId === null || agentId === undefined ? [] : [{ seatId, agentId }];
    });
  }

  /**
   * Reads the tail of the member's timeline, which is what makes the host load a closed Agent again
   * (reading a snapshot does not), then looks at it once more. It sends nothing and calls no model.
   * Reopened means: it reads idle and has no turn running.
   */
  async function reopenByReading(agentId: string): Promise<boolean> {
    const handle = options.port.agents.ref(agentId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("reading the history timed out")),
        options.reopenTimeoutMs ?? REOPEN_TIMEOUT_MS,
      );
    });
    const reading = (async () => {
      await handle.timeline.refetch({ direction: "tail", limit: 1, projection: "canonical" });
      return handle.refresh();
    })();
    // If the timeout wins, the read may still fail later: nobody waits for it, so say nothing.
    reading.catch(() => undefined);
    try {
      const refreshed = await Promise.race([reading, timeout]);
      const snapshot = refreshed?.agent;
      return snapshot !== undefined && snapshot.status === "idle" && !snapshot.activeTurn;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Tries to reopen the closed seats the work waits for, in scheduling order, stopping at the first one that
   * reads idle. `budget` counts the reads of the whole pass, which may come back here after a reopened seat
   * still did not take the work: at most `REOPEN_READS_PER_PASS` in all. A seat is only read when it has not been
   * tried by this process since the last "check now" (a failed read is only logged: the warning stays),
   * and only when its history says reading can work (`seat-reopen.ts`). True when one is open again.
   */
  async function reopenClosedSeats(
    runId: string,
    record: RunRecord,
    work: Work,
    denials: readonly SeatDenial[],
    budget: { reads: number },
  ): Promise<boolean> {
    for (const seat of reopenCandidates(record, work, denials)) {
      if (budget.reads >= REOPEN_READS_PER_PASS) break;
      if (!mayReopen(record, seat.agentId)) continue;
      const key = reopenKey(runId, seat.seatId, seat.agentId);
      if (reopenTried.has(key)) continue;
      reopenTried.add(key);
      budget.reads += 1;
      try {
        if (await reopenByReading(seat.agentId)) {
          reopenFailed.delete(key);
          log(`reopened the closed seat ${seat.seatId} of ${runId} by reading its history`);
          return true;
        }
        reopenFailed.add(key);
        log(
          `the closed seat ${seat.seatId} of ${runId} does not read idle after its history was read`,
        );
      } catch (error) {
        reopenFailed.add(key);
        log(`could not reopen the closed seat ${seat.seatId} of ${runId}`, error);
      }
    }
    return false;
  }

  /**
   * The seat to rebuild, if any: the first closed seat, in the order the closed seats are read, that can be
   * and should be. One that cannot (a seat that has been archived, one that still carries work, one that
   * could still be reopened by reading, one whose spec is gone) is passed over and does not hold up the
   * ones behind it; one that cannot be rebuilt but would need to be gets its own warning. Only one is
   * started. Returns true when a seat was given a new Agent.
   */
  async function rebuildFirstPossible(
    runId: string,
    work: Work,
    denials: readonly SeatDenial[],
  ): Promise<boolean> {
    const rebuild = options.rebuild;
    if (!rebuild) return false;
    const read = await options.store.get(runId);
    if (read.status !== "ok") return false;
    const record = read.record;
    if (record.lifecycle !== "active" || cancelPending(record)) return false;
    if (record.launch.state !== "running") return false;
    const deps: RebuildDeps = { store: options.store, host: hostFor(rebuild), clock, log };
    const rebuilds = readSeatRebuilds(record);
    const items = rebuilds.kind === "valid" ? rebuilds.items : [];
    const permitted = (rebuildPermit.get(runId) ?? 0) > Date.parse(clock.now());
    for (const seat of reopenCandidates(record, work, denials)) {
      if (isAgentArchived(record, seat.agentId)) continue;
      const kind = classifySeatForReopen(record, seat.agentId);
      // Reading can bring a P seat back, and a seat that never ran has to fail to be read first.
      if (kind === "P") continue;
      if (kind === "N" && !reopenFailed.has(reopenKey(runId, seat.seatId, seat.agentId))) continue;
      // The records of this Run cannot be read: nothing is started or continued, and the Run says so.
      if (rebuilds.kind === "invalid") {
        await warnCannotRebuild(deps, runId, seat.seatId, "records-unreadable");
        return false;
      }
      // Something is still being made, or this seat has had all its tries.
      if (items.some((item) => item.state === "creating")) return false;
      const mine = rebuildsOfSeat(items, seat.seatId);
      if (mine.length >= SEAT_REBUILD_MAX_PER_SEAT) continue;
      // A second try is a person's to ask for.
      if (mine.length >= 1 && !permitted) continue;
      // The member-lost settler has not closed its turn yet, or something is on its way to it: not now.
      if (rebindBlocker(record, seat.seatId, seat.agentId) !== null) continue;
      const checked = await checkRebuildable(deps.host, record, seat.seatId);
      if (!checked.ok) {
        await warnCannotRebuild(deps, runId, seat.seatId, checked.why);
        continue;
      }
      const generation = (mine.length + 1) as 1 | 2;
      if (generation > 1) rebuildPermit.delete(runId);
      log(`rebuilding the closed seat ${seat.seatId} of ${runId} (try ${generation})`);
      const outcome = await startRebuild(
        deps,
        runId,
        {
          seatId: seat.seatId,
          fromAgentId: seat.agentId,
          generation,
          reason: kind === "C" ? "turn-cut-off" : "never-ran-unopenable",
        },
        rebuildTitle(checked.spec.title, generation),
      );
      return outcome.status === "bound";
    }
    return false;
  }

  /** The host's side of a rebuild: what the caller supplied, and reading a parent so it can have children. */
  function hostFor(rebuild: NonNullable<EngineServiceOptions["rebuild"]>): RebuildHost {
    return { ...rebuild, reopenAgent: reopenByReading };
  }

  async function dispatchNextUnlocked(
    runId: string,
    mayReopenSeats = true,
    quiet = false,
    mayRebuild = true,
  ): Promise<DispatchNextResult> {
    let read = await options.store.get(runId);
    if (read.status !== "ok") return { status: "run-unavailable" };
    // A rebuild a restart cut off is carried on first, whatever state the Run is in: the Agent it made (or
    // will make, with the same key) belongs to the seat.
    if (options.rebuild && hasCreatingRebuild(read.record)) {
      await resumeRebuilds(
        { store: options.store, host: hostFor(options.rebuild), clock, log },
        runId,
      );
      read = await options.store.get(runId);
      if (read.status !== "ok") return { status: "run-unavailable" };
    }
    // Only an active Run dispatches: paused, finished and cancelled ones, and one still waiting for
    // its DAG, have nothing to send. A paused Run is the one exception to "nothing to do": a person may
    // cancel failed tasks while it is paused, and then the failed-task alert is no longer true, so it is
    // taken down here (and only here: nothing is sent and the Run is not resumed). A Run that has no such
    // alert, or is still over the limit, is not written to. The closed-seat warning is taken down once
    // for a Run that is over (finished or cancelled: nothing waits for a seat any more); a paused Run
    // keeps it, because it is still true.
    if (read.record.lifecycle !== "active") {
      if (
        (read.record.lifecycle === "finished" || read.record.lifecycle === "cancelled") &&
        hasOpenSeatClosedAlert(read.record)
      ) {
        await noteSeatClosed(runId, read.record, null);
      }
      if (read.record.lifecycle === "finished" || read.record.lifecycle === "cancelled") {
        await noteRebuildAlerts(runId, read.record, { held: false, over: true });
      }
      if (
        read.record.lifecycle === "paused" &&
        !failedTaskLimit(read.record).exceeded &&
        hasOpenFailedLimitAlert(read.record)
      ) {
        await clearFailedLimit(runId);
      }
      return { status: "idle" };
    }
    // Near a ledger limit nothing new starts, so what is in flight can still be taken in and finished.
    const capacity = capacityIssue(read.record, {
      bytesHigh: read.needsCompaction,
      limits: options.capacityLimits,
    });
    if (capacity !== null) await noteCapacity(runId, capacity.level);
    const failures = failedTaskLimit(read.record);
    if (!failures.exceeded && hasOpenFailedLimitAlert(read.record)) {
      await clearFailedLimit(runId);
    }
    const first = nextWork(read.record);
    if (!first) {
      await noteSeatClosed(runId, read.record, null);
      return { status: "idle" };
    }
    if (capacity?.level === "refuse") {
      return { status: "blocked", taskId: first.task.spec.id, reason: "ledger-capacity" };
    }
    let work: Work = first;
    let record = read.record;
    // More failed tasks than the policy allows: no task that has not started yet is started (a `ready`
    // one, which includes a failed task a person has just sent back to the start). What is already under
    // way goes on: the review, the smoke, the supplement and the rework of a task that has begun, and
    // the paths that do not come through here (intake, repair, the outbox). A task held back must not
    // hide the work behind it, so the walk skips it, and the seat planning does not see it either (it
    // would otherwise be given the seat the work under way needs).
    if (failures.exceeded) {
      const held = read.record.tasks.some((entry) => entry.state === "ready");
      if (held) await noteFailedLimit(runId, failures.limit);
      const underway = nextWork(read.record, { startNew: false });
      if (underway === null) {
        return { status: "blocked", taskId: first.task.spec.id, reason: "failed-task-limit" };
      }
      work = underway;
      record = {
        ...read.record,
        tasks: read.record.tasks.filter((entry) => entry.state !== "ready"),
      };
    }
    const result =
      work.kind === "produce"
        ? await dispatchProducer(runId, record, work.task)
        : work.kind === "evidence"
          ? await dispatchEvidence(runId, record, work.task)
          : await dispatchJudge(runId, record, work.task, work.kind);
    // Held back only by closed seats: read the history of the ones that may come back before refusing
    // them. After each one that opens the dispatch is looked at again (that look reads nothing); if it
    // still waits for a closed seat (the reopened one did not take the work), the next candidate is read,
    // up to the pass's budget.
    let latest = result;
    const budget = { reads: 0 };
    while (
      mayReopenSeats &&
      latest.status === "waiting" &&
      heldByClosedSeat(latest.denials) &&
      !cancelPending(read.record) &&
      (await reopenClosedSeats(runId, read.record, work, latest.denials, budget))
    ) {
      // A look that still waits says nothing about the warning yet: the next candidate may take the work.
      latest = await dispatchNextUnlocked(runId, false, true, false);
      if (latest.status !== "waiting") return latest;
    }
    // Still held back only by closed seats after every read: one that cannot come back by being read is
    // rebuilt, a member's Agent made again from the spec the Run was started with. A supplement is the one
    // piece of work that cannot go to a new Agent (it must be the original producer), so it never rebuilds.
    if (
      mayRebuild &&
      options.rebuild &&
      work.kind !== "evidence" &&
      latest.status === "waiting" &&
      heldByClosedSeat(latest.denials) &&
      (await rebuildFirstPossible(runId, work, latest.denials))
    ) {
      // The seat has its new Agent. Whether to send anything is decided on the Run as it is now, not on the
      // snapshot this pass began with: a pause or a cancellation may have come while it was being made.
      const after = await options.store.get(runId);
      if (
        after.status !== "ok" ||
        after.record.lifecycle !== "active" ||
        cancelPending(after.record)
      ) {
        return latest;
      }
      latest = await dispatchNextUnlocked(runId, false, true, false);
      if (latest.status !== "waiting") return latest;
    }
    // Quiet: this is one of those looks; if it still waits, the pass that asked for it settles the warning.
    if (!(quiet && latest.status === "waiting")) await noteSeatClosed(runId, read.record, latest);
    return latest;
  }

  return {
    /**
     * A person asked to check now: the closed seats of this Run may each be tried once more. Nothing is
     * read here; the next dispatch does it.
     */
    grantReopen(runId: string): void {
      for (const key of [...reopenTried]) {
        if ((JSON.parse(key) as string[])[0] === runId) reopenTried.delete(key);
      }
      // The same click is what lets a seat whose rebuild failed be rebuilt once more, for a little while.
      rebuildPermit.set(runId, Date.parse(clock.now()) + (options.rebuildPermitMs ?? 120_000));
    },

    /**
     * Moves the next unit of work (producer, reviewer or smoker, in task order) to the best
     * available seat and sends it. Calls for one Run are serialized in this process; across
     * processes the store's lock and CAS decide.
     */
    dispatchNext(runId: string): Promise<DispatchNextResult> {
      const previous = chains.get(runId) ?? Promise.resolve();
      const run = previous
        .catch(() => undefined)
        .then(() => dispatchNextUnlocked(runId))
        // A person's click is good for the first look it brings, and for no other.
        .finally(() => rebuildPermit.delete(runId));
      chains.set(
        runId,
        run.catch(() => undefined),
      );
      return run;
    },
  };
}

export type EngineService = ReturnType<typeof createEngineService>;

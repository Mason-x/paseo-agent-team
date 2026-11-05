import { randomUUID } from "node:crypto";
import { applyDispatch, buildDispatch } from "../../shared/domain/run-engine/dispatch-builder";
import { producerSemanticArgs } from "../../shared/domain/run-engine/prompt-template";
import {
  planDispatchWithReasons,
  type SchedulerContext,
  type SchedulerMode,
  type SeatDenial,
  type SeatRuntime,
} from "../../shared/domain/run-engine/scheduler";
import type { PaseoEnginePort, PortAgentSnapshot } from "../../shared/paseo/port";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { type DispatchIntent, type Effects, type OutboxReport, payloadHash } from "./effects";
import { dispatchWorkspace, inspectRepo, prepareEvidenceDir, verifyScopes } from "./repo";
import type { RunStore } from "./store";

/**
 * Engine service, single-task single-seat path (plan 11.4, M2). One call moves at most one ready
 * task to a seat: it gathers the facts that need IO (live seat state, real git state, verified
 * scopes), then commits the dispatch in one synchronous store update, then runs the outbox.
 *
 * Everything that waits happens before the store lock is taken. The facts can go stale in that gap,
 * which is safe: the committed update re-checks the task, the seat, the locks and the budget
 * against the record it actually holds, and the reducer refuses a stale choice.
 *
 * Not here yet: DAG admission, review and smoke dispatch, and rework. `compile` is injected (the
 * production one is `compileDispatch` in `prompt-template.ts`) and must ignore `payloadHash`, which
 * is not known until it has run. The semantic arguments pinned here are the producer template's.
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
  templateVersion: number;
  ids?: { uuid(): string };
  clock?: { now(): string };
  log?: (message: string, detail?: unknown) => void;
};

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

  async function dispatchNextUnlocked(runId: string): Promise<DispatchNextResult> {
    const read = await options.store.get(runId);
    if (read.status !== "ok") return { status: "run-unavailable" };
    const record = read.record;
    const task = record.tasks.find((entry) => entry.state === "ready");
    if (!task) return { status: "idle" };
    const taskId = task.spec.id;

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
    const workspace = dispatchWorkspace(inspected.repo, location.workspaceId);
    if (!workspace.ok)
      return { status: "blocked", taskId, reason: `workspace-${workspace.reason}` };
    const verified = await verifyScopes(inspected.repo, task.spec.scopes);
    if (!verified.ok) {
      return { status: "blocked", taskId, reason: "scope-rejected", detail: verified.rejected };
    }

    const stamp = uuid();
    const short = stamp.replace(/-/gu, "").slice(0, 8);
    const attempt = task.attempts + 1;
    const assignmentId = `assignment-${taskId}-a${attempt}-${short}`;
    const evidence = await prepareEvidenceDir(
      inspected.repo,
      record.policy.evidenceRoot,
      assignmentId,
    );
    if (!evidence.ok) {
      return { status: "blocked", taskId, reason: `evidence-root-${evidence.reason}` };
    }
    // Pinned now so the prompt can be rebuilt byte for byte later from the ledger alone.
    const semanticArgs = producerSemanticArgs(task.spec, {
      repoRoot: inspected.repo.root,
      evidenceDir: evidence.dir,
    });
    const holder: { result: DispatchNextResult | null } = { result: null };

    await options.store.update(runId, (current, update) => {
      const built = buildDispatch(current, {
        taskId,
        seatId: proposal.seatId,
        profile: source.profile,
        workspace: workspace.workspace,
        scopes: verified.scopes,
        reason: proposal.qualification,
        otherResources: update.otherResources,
        ids: {
          assignmentId,
          nonce: uuid(),
          messageId: uuid(),
          intentId: `intent-${taskId}-a${attempt}-${short}`,
          claimId: (index) => `claim-${taskId}-${short}-${index}`,
        },
        now: clock.now(),
        // Replaced below: the real hash is that of the prompt compiled from the finished record.
        payload: {
          hash: "0".repeat(64),
          templateVersion: options.templateVersion,
          semanticArgs,
        },
      });
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
        newId: (kind) => `${kind}-${uuid()}`,
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
        assignmentId,
        seatId: proposal.seatId,
        outbox: { status: "ok", sent: [], reconciled: [], unknown: [], failed: [] },
      };
      return applied.next;
    });

    const result = holder.result;
    if (result === null) return { status: "blocked", taskId, reason: "no-result" };
    if (result.status !== "dispatched") return result;
    return { ...result, outbox: await options.effects.runOutbox(runId) };
  }

  return {
    /**
     * Moves the first ready task to the best available seat and sends it. Calls for one Run are
     * serialized in this process; across processes the store's lock and CAS decide.
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

import { randomUUID } from "node:crypto";
import { reduceRun } from "../../shared/domain/run-engine/reducer";
import { noteTask } from "../../shared/domain/run-engine/task-note";
import type { DagIntake } from "./dag";
import type { Intake } from "./intake";
import type { IngestResult, ObserverHookEvent, ObserverHost, RunObserver } from "./observer";
import type { DispatchNextResult, EngineService } from "./service";
import type { RunStore } from "./store";

/**
 * The Engine's event loop: what runs when something happened, and nothing else. There is no timer
 * here. A hook says a turn ended, a permission was answered or an agent appeared; the driver records
 * it, settles whatever the agent reported (a plan or a task report), and then pushes the Run forward
 * with `kick` until it has nothing more to dispatch. When a Run has no event and no due work it costs
 * no model call and no host read.
 *
 * `kick` is also the entry for a person's "try again" (a dirty tree was cleaned, a seat is free):
 * a Run that is blocked on something no hook announces moves only when someone kicks it.
 */

export type KickReport = {
  /** How many dispatches this kick made. */
  dispatched: number;
  /** Why it stopped: idle, waiting for a seat, blocked, or the Run is not active. */
  last: DispatchNextResult;
  finished: boolean;
};

export type DriverOptions = {
  store: Pick<RunStore, "get" | "update" | "list" | "runsForAgent">;
  observer: Pick<RunObserver, "ingest" | "flush" | "reconcile">;
  host: ObserverHost;
  intake: Pick<Intake, "settleAgent">;
  dagIntake: Pick<DagIntake, "settleCoordinator">;
  service: Pick<EngineService, "dispatchNext">;
  clock?: { now(): string };
  ids?: { uuid(): string };
  log?: (message: string, detail?: unknown) => void;
};

/** Upper bound of dispatches one kick may make, so a bug cannot spin it. */
const MAX_STEPS = 32;

/** The reason shown on a task that could not be moved, in the words the Runs page is built around. */
function reasonOf(result: DispatchNextResult): string | null {
  if (result.status === "blocked") return `dispatch-blocked:${result.reason}`;
  if (result.status === "waiting") {
    const why = [...new Set(result.denials.map((denial) => denial.reason))].sort().join(",");
    return `waiting-for-seat${why ? `:${why}` : ""}`;
  }
  return null;
}

export function createEngineDriver(options: DriverOptions) {
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const uuid = options.ids?.uuid ?? (() => randomUUID());
  const log = options.log ?? (() => undefined);
  /** The kick running for a Run, and the Runs that were kicked again while it ran. */
  const inflight = new Map<string, Promise<KickReport>>();
  const again = new Set<string>();

  /** Shows on the task why it did not move. Changes nothing else, and says nothing twice. */
  async function show(runId: string, result: DispatchNextResult): Promise<void> {
    const reason = reasonOf(result);
    if (reason === null || (result.status !== "blocked" && result.status !== "waiting")) return;
    const { taskId } = result;
    await options.store.update(runId, (current) => {
      const noted = noteTask(current, taskId, reason, { now: clock.now() });
      return noted.ok && noted.changed ? noted.next : null;
    });
  }

  /** A Run whose every task is done or cancelled, with nothing left to settle, is finished. */
  async function finishIfDone(runId: string): Promise<boolean> {
    let finished = false;
    await options.store.update(runId, (current) => {
      if (current.lifecycle !== "active" || current.tasks.length === 0) return null;
      if (!current.tasks.every((task) => task.state === "done" || task.state === "cancelled")) {
        return null;
      }
      const reduced = reduceRun(
        current,
        { kind: "run-finished" },
        { now: clock.now(), newId: () => uuid() },
      );
      if (!reduced.ok) return null;
      finished = true;
      return reduced.next;
    });
    return finished;
  }

  async function pass(runId: string): Promise<KickReport> {
    let dispatched = 0;
    let last: DispatchNextResult = { status: "idle" };
    for (let step = 0; step < MAX_STEPS; step += 1) {
      last = await options.service.dispatchNext(runId);
      if (last.status !== "dispatched") break;
      dispatched += 1;
    }
    await show(runId, last);
    const finished = await finishIfDone(runId);
    return { dispatched, last, finished };
  }

  /**
   * Pushes one Run forward. Calls for one Run are coalesced: while a kick runs, further kicks only
   * ask it to look once more when it is done, so a burst of hooks costs one extra pass, not one each.
   */
  function kick(runId: string): Promise<KickReport> {
    const running = inflight.get(runId);
    if (running) {
      again.add(runId);
      return running;
    }
    const run = (async () => {
      try {
        let report: KickReport;
        do {
          again.delete(runId);
          report = await pass(runId);
        } while (again.has(runId) && !report.finished);
        return report;
      } finally {
        inflight.delete(runId);
        again.delete(runId);
      }
    })();
    inflight.set(runId, run);
    return run;
  }

  /** Settles what `agentId` reported, then kicks every Run that names it. Never throws. */
  async function settleAndKick(agentId: string): Promise<void> {
    try {
      await options.intake.settleAgent(agentId);
      await options.dagIntake.settleCoordinator(agentId);
      for (const runId of await options.store.runsForAgent(agentId)) await kick(runId);
    } catch (error) {
      log(`engine could not move on after ${agentId}`, error);
    }
  }

  return {
    kick,

    /**
     * One host hook. The hook is recorded first (that is the observer's job and is idempotent), and
     * a turn that ended is then settled even when the hook was a duplicate: the first delivery may
     * have been recorded and then failed to settle, and a repeat is the only retry it gets.
     */
    async onHook(event: ObserverHookEvent): Promise<IngestResult> {
      const ingested = await options.observer.ingest(event);
      if (ingested.status !== "recorded" && ingested.status !== "duplicate") return ingested;
      if (event.name === "agent.turn_ended") await settleAndKick(event.agentId);
      else if (event.name === "agent.permission_resolved" || event.name === "agent.created") {
        try {
          for (const runId of await options.store.runsForAgent(event.agentId)) await kick(runId);
        } catch (error) {
          log(`engine could not kick after ${event.name}`, error);
        }
      }
      return ingested;
    },

    /**
     * After a restart: records the turns the host finished while nothing was listening, then settles
     * every agent a live Run is waiting on and kicks each Run. Hooks are not assumed to have arrived.
     */
    async recover(): Promise<{ runs: number }> {
      await options.observer.flush();
      await options.observer.reconcile(options.host);
      const listed = await options.store.list();
      let runs = 0;
      for (const entry of listed.entries) {
        if (entry.lifecycle === "finished" || entry.lifecycle === "cancelled") continue;
        const read = await options.store.get(entry.runId);
        if (read.status !== "ok") continue;
        runs += 1;
        const waiting = new Set<string>();
        for (const assignment of read.record.assignments) {
          if (assignment.state === "assigned" || assignment.state === "in_progress") {
            waiting.add(assignment.agentId);
          }
        }
        const coordinator = read.record.roster.find((seat) => seat.seatId === "coordinator");
        if (coordinator?.agentId) waiting.add(coordinator.agentId);
        for (const agentId of waiting) {
          try {
            await options.intake.settleAgent(agentId);
            await options.dagIntake.settleCoordinator(agentId);
          } catch (error) {
            log(`engine could not settle ${agentId} on recovery`, error);
          }
        }
        try {
          await kick(entry.runId);
        } catch (error) {
          log(`engine could not kick ${entry.runId} on recovery`, error);
        }
      }
      return { runs };
    },
  };
}

export type EngineDriver = ReturnType<typeof createEngineDriver>;

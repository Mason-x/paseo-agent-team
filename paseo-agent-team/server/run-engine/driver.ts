import { randomUUID } from "node:crypto";
import { budgetExhaustedAlert, budgetStatus } from "../../shared/domain/run-engine/budget";
import {
  openStuckDecision,
  stoppedTasksWithoutDecision,
} from "../../shared/domain/run-engine/decision-answer";
import { reduceRun } from "../../shared/domain/run-engine/reducer";
import { raiseAlert } from "../../shared/domain/run-engine/run-alert";
import { noteTask } from "../../shared/domain/run-engine/task-note";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import type { CancelFinisher } from "./cancel";
import type { Compactor } from "./compact";
import type { DagIntake } from "./dag";
import { alertIdFor, sha256Hex } from "./digest";
import type { Intake } from "./intake";
import type { MemberLostSettler } from "./member-lost";
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

/** What a person's retry did, in words that carry no prompt, nonce or outbox argument. */
export type RetryReport = {
  status: "ok" | "unavailable";
  /** Messages sent to members by this retry. */
  dispatched: number;
  finished: boolean;
  /** Why it stopped: `idle`, `waiting`, `blocked`, `dispatched` or `run-unavailable`. */
  last: DispatchNextResult["status"];
  /** A short code for a task that could not move, e.g. `dispatch-blocked:workspace-dirty`. */
  reason: string | null;
};

export type DriverOptions = {
  store: Pick<RunStore, "get" | "update" | "list" | "runsForAgent">;
  observer: Pick<RunObserver, "ingest" | "flush" | "reconcile">;
  host: ObserverHost;
  /**
   * The host `recover` reconciles with, when it must be stricter than `host`: reconcile records a
   * turn as ended without a hook saying so, so it should not treat a running turn as finished.
   * Defaults to `host`.
   */
  reconcileHost?: ObserverHost;
  intake: Pick<Intake, "settleAgent">;
  dagIntake: Pick<DagIntake, "settleCoordinator">;
  service: Pick<EngineService, "dispatchNext">;
  /**
   * The outbox executor. With it, a recovery or a retry also settles the messages whose delivery was
   * unknown (by the host's echo, never by sending again) and sends the ones that were prepared and
   * never went out because the process stopped in between. Without it neither happens.
   */
  outbox?: { run(runId: string): Promise<unknown> };
  /**
   * Called when a pass of a Run is over, whatever it did. Used to take down the alerts of reads that
   * were tried again and no longer matter. It must not move the Run; its failure is logged only.
   */
  onPassed?: (runId: string) => void | Promise<void>;
  /** Folds the old events of a Run into its checkpoint at the start of a pass (`compact.ts`). */
  compactor?: Pick<Compactor, "compactIfNeeded">;
  /** Finishes a cancellation that was asked for, at the start of a pass (`cancel.ts`). */
  cancelFinisher?: Pick<CancelFinisher, "finish">;
  /**
   * Settles the turns Paseo cut off by closing or archiving a member, at the start of a pass and before
   * a cancellation is finished (`member-lost.ts`). Its failure is logged and does not stop the pass.
   */
  memberLost?: Pick<MemberLostSettler, "settle">;
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
      let next = noted.ok && noted.changed ? noted.next : current;
      let changed = noted.ok && noted.changed;
      // A seat whose turns ran out says so once per limit, with the way out.
      if (
        result.status === "blocked" &&
        result.reason === "budget-exhausted" &&
        result.seatId !== undefined
      ) {
        const status = budgetStatus(current, result.seatId);
        if (status !== null) {
          const summary = budgetExhaustedAlert(
            result.seatId,
            status.entry.reserved,
            status.entry.limit,
          );
          const raised = raiseAlert(
            next,
            { alertId: alertIdFor(summary), severity: "warning", summary },
            clock.now(),
          );
          if (raised.changed) {
            next = raised.next;
            changed = true;
          }
        }
      }
      return changed ? next : null;
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

  /**
   * A task that a member or a judge stopped (`blocked` or `failed`) waits on a person, and a person
   * answers a decision. This gives every such task one, once: nothing is written when it has one.
   */
  async function openMissingDecisions(runId: string): Promise<void> {
    await options.store.update(runId, (current) => {
      let next = current;
      let changed = false;
      for (const stopped of stoppedTasksWithoutDecision(current)) {
        const opened = openStuckDecision(next, {
          ...stopped,
          decisionId: uuid(),
          controlNonceDigest: sha256Hex(uuid()),
          now: clock.now(),
        });
        if (opened.changed) {
          next = opened.next;
          changed = true;
        }
      }
      return changed ? next : null;
    });
  }

  async function pass(runId: string): Promise<KickReport> {
    if (options.compactor) {
      // Its own commit, before anything else of this pass; a failure is logged inside and does not stop the pass.
      const read = await options.store.get(runId);
      if (read.status === "ok") {
        await options.compactor.compactIfNeeded(runId, { bytesHigh: read.needsCompaction });
      }
    }
    if (options.memberLost) {
      // Its own commit, and the first thing a pass does about the members: a turn it settles is one the
      // cancellation below may then count as ended. It never throws, and writes nothing when no turn was cut.
      await options.memberLost.settle(runId);
    }
    if (options.cancelFinisher) {
      // Its own commit; it never throws, and a Run it cancels has nothing more to dispatch below.
      await options.cancelFinisher.finish(runId);
    }
    let dispatched = 0;
    let last: DispatchNextResult = { status: "idle" };
    for (let step = 0; step < MAX_STEPS; step += 1) {
      last = await options.service.dispatchNext(runId);
      if (last.status !== "dispatched") break;
      dispatched += 1;
    }
    await show(runId, last);
    await openMissingDecisions(runId);
    const finished = await finishIfDone(runId);
    try {
      await options.onPassed?.(runId);
    } catch (error) {
      log(`engine could not close out a pass of ${runId}`, error);
    }
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

  /** Settles what a live Run waits on: the agents of its open assignments and the coordinator's plan. */
  async function settleWaiting(runId: string, record: RunRecord): Promise<void> {
    const waiting = new Set<string>();
    for (const assignment of record.assignments) {
      if (assignment.state === "assigned" || assignment.state === "in_progress") {
        waiting.add(assignment.agentId);
      }
    }
    const coordinator = record.roster.find((seat) => seat.seatId === "coordinator");
    if (coordinator?.agentId) waiting.add(coordinator.agentId);
    for (const agentId of waiting) {
      try {
        await options.intake.settleAgent(agentId);
        await options.dagIntake.settleCoordinator(agentId);
      } catch (error) {
        log(`engine could not settle ${agentId} on recovery`, error);
      }
    }
    // A launch that failed (its agents archived by preference) or was cancelled leaves a request that
    // was prepared and will never be sent: nothing may be sent for it now.
    const launch = record.launch.state;
    if (options.outbox !== undefined && launch !== "failed" && launch !== "cancelled") {
      try {
        await options.outbox.run(runId);
      } catch (error) {
        log(`engine could not run the outbox of ${runId}`, error);
      }
    }
  }

  const retrying = new Map<string, Promise<RetryReport>>();

  async function retryNow(runId: string): Promise<RetryReport> {
    const read = await options.store.get(runId);
    if (read.status !== "ok") {
      return {
        status: "unavailable",
        dispatched: 0,
        finished: false,
        last: "run-unavailable",
        reason: null,
      };
    }
    const lifecycle = read.record.lifecycle;
    if (lifecycle === "finished" || lifecycle === "cancelled") {
      return {
        status: "ok",
        dispatched: 0,
        finished: lifecycle === "finished",
        last: "idle",
        reason: null,
      };
    }
    // Before the host is read for turns whose hook was lost: that read takes a closed Agent for one with
    // no turn and would record the cut-off turn as ended by the host. The settler writes the receipt the
    // read would have (same key), so the read finds it already recorded.
    await options.memberLost?.settle(runId);
    await options.observer.reconcile(options.reconcileHost ?? options.host, { runId });
    const fresh = await options.store.get(runId);
    await settleWaiting(runId, fresh.status === "ok" ? fresh.record : read.record);
    const report = await kick(runId);
    return {
      status: "ok",
      dispatched: report.dispatched,
      finished: report.finished,
      last: report.last.status,
      reason: reasonOf(report.last),
    };
  }

  /** Runs a write was committed for while a retry of them was running (that retry may be past it). */
  const retryAfterWrite = new Set<string>();

  /**
   * A person's retry joins the one that is running. A retry asked for by a write (`afterWrite`: a
   * re-plan or an answer was just committed) is different: the running one began before the write
   * and may be past the step that would have seen it (the outbox, the dispatch), so one more starts
   * when it is done. A burst of such writes costs one more pass, not one each.
   */
  function retryRun(runId: string, options: { afterWrite?: boolean } = {}): Promise<RetryReport> {
    const running = retrying.get(runId);
    if (running) {
      if (options.afterWrite) retryAfterWrite.add(runId);
      return running;
    }
    const run = (async () => {
      try {
        let report: RetryReport;
        do {
          retryAfterWrite.delete(runId);
          report = await retryNow(runId);
        } while (retryAfterWrite.has(runId));
        return report;
      } finally {
        retrying.delete(runId);
        retryAfterWrite.delete(runId);
      }
    })();
    retrying.set(runId, run);
    return run;
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
      else if (
        event.name === "agent.permission_resolved" ||
        event.name === "agent.created" ||
        // A member closed or archived mid-turn: the pass settles the turn the host will not end.
        event.name === "agent.closed" ||
        event.name === "agent.archived"
      ) {
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
      if (options.memberLost) {
        // Flush, then settle, then reconcile: the flush records a buffered `agent.closed`, so the settler
        // can use it; the settle comes before the reconcile for the reason given in `retryNow`. A Run with
        // no turn that may have been cut off costs no host read and writes nothing.
        for (const entry of (await options.store.list()).entries) {
          if (entry.lifecycle === "finished" || entry.lifecycle === "cancelled") continue;
          await options.memberLost.settle(entry.runId);
        }
      }
      await options.observer.reconcile(options.reconcileHost ?? options.host);
      const listed = await options.store.list();
      let runs = 0;
      for (const entry of listed.entries) {
        if (entry.lifecycle === "finished" || entry.lifecycle === "cancelled") continue;
        const read = await options.store.get(entry.runId);
        if (read.status !== "ok") continue;
        runs += 1;
        await settleWaiting(entry.runId, read.record);
        try {
          await kick(entry.runId);
        } catch (error) {
          log(`engine could not kick ${entry.runId} on recovery`, error);
        }
      }
      return { runs };
    },

    /**
     * A person's "try again" for one Run: what recovery does, for this Run only. It reads the host for
     * a turn whose hook was lost, settles what the Run is waiting on, settles the messages whose
     * delivery was unknown by their echo and sends the ones that were prepared and never left, then
     * pushes the Run forward. Nothing it does can send a message twice (the outbox's own rule), and
     * nothing it does needs a hook: a dirty tree that was cleaned, a seat that came back.
     *
     * Calls for one Run join the one that is running, so pressing it again costs nothing. It does not
     * release a frozen task, answer a decision or cancel anything.
     */
    retryRun,
  };
}

export type EngineDriver = ReturnType<typeof createEngineDriver>;

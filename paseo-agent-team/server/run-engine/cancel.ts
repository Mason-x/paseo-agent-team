import { randomUUID } from "node:crypto";
import {
  agentsToRead,
  CANCEL_COMPLETED_EVENT,
  CANCEL_INVALID_ALERT,
  CANCEL_PENDING_ALERT,
  CANCEL_TASK_REASON,
  type CancelRequest,
  cancelStuckAlert,
  planCancelFinish,
  readCancelRequest,
  type SeatView,
  withCancelRequest,
} from "../../shared/domain/run-engine/cancel-request";
import { closeEndedAttempt } from "../../shared/domain/run-engine/decision-answer";
import { isDecisionPending } from "../../shared/domain/run-engine/decision-state";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import { reduceRun } from "../../shared/domain/run-engine/reducer";
import { raiseAlert, resolveAlerts } from "../../shared/domain/run-engine/run-alert";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { alertIdFor, sha256Hex } from "./digest";
import type { ReadFailure } from "./read-retry";
import type { RunStore } from "./store";

/**
 * Finishes a cancellation that was asked for (`run.cancel`). It runs at the start of every pass of the
 * driver, so a hook, a recovery or a person's kick all push it on. It never sends a message, never
 * archives and never interrupts: the only thing it asks the host is the live state of an agent whose
 * turn the ledger says ended.
 *
 *  - With a turn still running, a delivery not settled, or an agent that cannot be read, it writes
 *    nothing and says what it waits for. A read that failed is handed to the read re-checks.
 *  - When every running turn is proven ended it works in ONE commit: the plan is worked out again on
 *    the record as it is then (a second finisher, or a turn that started meanwhile, changes the answer
 *    and nothing is written), the attempts are closed on the turns the host reported, the reducer's own
 *    `run-cancelled` cancels every unfinished task, and a task that still holds a claim kept from a
 *    delivery that was sent is released the way a person's answer does it (A2): the reducer's D1 for it
 *    is answered `cancel` on the request's behalf and the task is cancelled again.
 *  - A result in which a task is neither done nor cancelled is not committed. A critical alert names
 *    why, and the request stays pending.
 */

export type CancelFinishReport =
  /** No pending cancellation for this Run. */
  | { status: "none" }
  | { status: "waiting"; turns: number; deliveries: number }
  | { status: "finished"; tasks: number }
  | { status: "stuck"; code: string };

export type CancelFinisherOptions = {
  store: Pick<RunStore, "get" | "update">;
  /** The live state of an agent; null when the host has none. Read only. */
  readSeat(agentId: string): Promise<{ status: string; activeTurn: boolean } | null>;
  /** Told when a read failed, so it is tried again and the Run says so. */
  onReadFailure?: (runId: string, failure: ReadFailure) => void | Promise<void>;
  clock?: { now(): string };
  ids?: { uuid(): string };
  log?: (message: string, detail?: unknown) => void;
};

type Outcome = CancelFinishReport;

export function createCancelFinisher(options: CancelFinisherOptions) {
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const uuid = options.ids?.uuid ?? (() => randomUUID());
  const log = options.log ?? (() => undefined);

  async function raise(runId: string, summary: string, severity: "critical"): Promise<void> {
    await options.store.update(runId, (current) => {
      const raised = raiseAlert(
        current,
        { alertId: alertIdFor(summary), severity, summary },
        clock.now(),
      );
      return raised.changed ? raised.next : null;
    });
  }

  async function readSeats(runId: string, record: RunRecord): Promise<Map<string, SeatView>> {
    const seats = new Map<string, SeatView>();
    for (const agentId of agentsToRead(record)) {
      try {
        // null: the host answered and has no such agent (deleted): it has no turn running. A read that
        // throws is a failed read and proves nothing.
        const seat = await options.readSeat(agentId);
        seats.set(agentId, seat ?? "absent");
      } catch (error) {
        seats.set(agentId, "unreadable");
        log(`cancel could not read ${agentId}`, error);
        try {
          await options.onReadFailure?.(runId, { type: "seat", agentId });
        } catch (failure) {
          log(`cancel could not note the failed read of ${agentId}`, failure);
        }
      }
    }
    return seats;
  }

  /** The record after the cancellation, or the code that says why it cannot be committed. */
  function cancelAll(
    current: RunRecord,
    request: CancelRequest,
    close: { assignmentId: string; turnId: string; endedEventKey: string }[],
    now: string,
  ): { ok: true; next: RunRecord; tasks: number } | { ok: false; code: string } {
    let working = current;
    for (const ended of close) {
      const closed = closeEndedAttempt(working, { ...ended, now, leaveNonce: true });
      if (!closed.ok) return { ok: false, code: closed.reason };
      working = closed.next;
    }
    const facts = { now, newId: () => uuid() };
    const cancelled = reduceRun(
      working,
      {
        kind: "run-cancelled",
        reason: CANCEL_TASK_REASON,
        controlNonceDigest: sha256Hex(uuid()),
        cancelIntents: [],
        preparedCancelIntents: [],
      },
      facts,
    );
    if (!cancelled.ok) {
      return { ok: false, code: `reducer-${String(cancelled.params.reason ?? cancelled.code)}` };
    }
    working = cancelled.next;
    // A task that holds a claim kept from a delivery that was sent is frozen by the reducer, which opens
    // its D1. The request is the authorization: answer it `cancel` and cancel the task again.
    for (const task of working.tasks) {
      if (task.state === "cancelled" || task.state === "done") continue;
      const id = task.spec.id;
      const release = working.decisions.find(
        (decision) =>
          decision.category === "D1" &&
          decision.subjectId === id &&
          decision.dedupeKey === `cancel:${id}` &&
          decision.cancelIntents?.length === 0 &&
          isDecisionPending(decision),
      );
      if (release === undefined) continue;
      working = structuredClone(working);
      const target = working.decisions.find(
        (decision) => decision.decisionId === release.decisionId,
      );
      if (target === undefined) continue;
      target.state = "answered";
      target.answeredAt = now;
      target.answer = {
        action: "cancel",
        taskIds: [id],
        answeredAt: now,
        requestId: request.requestId,
        reason: request.reason.slice(0, 600),
        via: "run-cancel",
      };
      const again = reduceRun(
        working,
        {
          kind: "cancel-requested",
          taskIds: [id],
          reason: CANCEL_TASK_REASON,
          controlNonceDigest: sha256Hex(uuid()),
          cancelIntents: [],
          preparedCancelIntents: [],
        },
        facts,
      );
      if (!again.ok)
        return { ok: false, code: `reducer-${String(again.params.reason ?? again.code)}` };
      working = again.next;
    }
    const left = working.tasks.filter(
      (task) => task.state !== "cancelled" && task.state !== "done",
    );
    if (left.length > 0) return { ok: false, code: "task-not-cancelled" };
    const cancelledTasks = working.tasks.filter((task) => task.state === "cancelled").length;
    let next = withCancelRequest(working, { ...request, completedAt: now });
    next = resolveAlerts(next, (alert) => alert.summary === CANCEL_PENDING_ALERT, now).next;
    const seq = next.counters.eventsThroughSeq + 1;
    next.counters.eventsThroughSeq = seq;
    next.events.push({
      seq,
      kind: CANCEL_COMPLETED_EVENT,
      at: now,
      payload: { requestId: request.requestId, tasks: cancelledTasks },
    });
    next.updatedAt = now;
    const checked = checkLedgerInvariants(next);
    if (!checked.ok) {
      return { ok: false, code: `ledger-refused:${checked.violations[0]?.invariant ?? "?"}` };
    }
    return { ok: true, next, tasks: cancelledTasks };
  }

  return {
    /** Never throws. */
    async finish(runId: string): Promise<CancelFinishReport> {
      try {
        const read = await options.store.get(runId);
        if (read.status !== "ok") return { status: "none" };
        const record = read.record;
        if (record.lifecycle === "cancelled" || record.lifecycle === "finished") {
          return { status: "none" };
        }
        const request = readCancelRequest(record);
        if (request.kind === "absent") return { status: "none" };
        if (request.kind === "invalid") {
          await raise(runId, CANCEL_INVALID_ALERT, "critical");
          return { status: "stuck", code: "request-unreadable" };
        }
        if (request.value.completedAt !== null) return { status: "none" };

        const seats = await readSeats(runId, record);
        const first = planCancelFinish(record, seats);
        if (first.kind === "wait") {
          return { status: "waiting", turns: first.turns, deliveries: first.deliveries };
        }

        const outcome: { value: Outcome } = { value: { status: "none" } };
        await options.store.update(runId, (current) => {
          const now = readCancelRequest(current);
          if (
            now.kind !== "valid" ||
            now.value.completedAt !== null ||
            current.lifecycle === "cancelled" ||
            current.lifecycle === "finished"
          ) {
            return null;
          }
          // The record may have moved since it was read: judge again on the one that is committed.
          const plan = planCancelFinish(current, seats);
          if (plan.kind === "wait") {
            outcome.value = { status: "waiting", turns: plan.turns, deliveries: plan.deliveries };
            return null;
          }
          const done = cancelAll(current, now.value, plan.close, clock.now());
          if (!done.ok) {
            outcome.value = { status: "stuck", code: done.code };
            return null;
          }
          outcome.value = { status: "finished", tasks: done.tasks };
          return done.next;
        });
        if (outcome.value.status === "stuck") {
          await raise(runId, cancelStuckAlert(outcome.value.code), "critical");
        }
        return outcome.value;
      } catch (error) {
        log(`cancel of ${runId} could not be finished`, error);
        return { status: "none" };
      }
    },
  };
}

export type CancelFinisher = ReturnType<typeof createCancelFinisher>;

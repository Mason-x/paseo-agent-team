import type { RunRecord } from "../../schemas/run-engine/ledger";

/**
 * Records why a task is not moving, as `waitingReason` plus an audit event. It changes no state, no
 * counter and no claim: the task stays where it is, so nothing is released and nothing is retried.
 * Used for facts the reducer has no event for (a reply with no report, a rejected block, a dispatch
 * that could not be made) so the Runs page can say why.
 *
 * Asking for the reason the task already shows is a no-op (`changed: false`), so a repeated
 * observation does not grow the ledger. The record is copied; the caller's value is never mutated.
 */
export type TaskNote =
  | { ok: true; changed: boolean; next: RunRecord }
  | { ok: false; code: "task-missing" };

const MAX_REASON = 600;

export function noteTask(
  record: RunRecord,
  taskId: string,
  reason: string,
  facts: { now: string; detail?: Record<string, unknown> },
): TaskNote {
  const index = record.tasks.findIndex((entry) => entry.spec.id === taskId);
  const current = record.tasks[index];
  if (index < 0 || current === undefined) return { ok: false, code: "task-missing" };
  const text = reason.slice(0, MAX_REASON);
  if (current.waitingReason === text) return { ok: true, changed: false, next: record };

  const next = structuredClone(record);
  const task = next.tasks[index];
  if (task === undefined) return { ok: false, code: "task-missing" };
  task.waitingReason = text;
  const seq = next.counters.eventsThroughSeq + 1;
  next.counters.eventsThroughSeq = seq;
  next.events.push({
    seq,
    kind: "task-note",
    at: facts.now,
    payload: { taskId, reason: text, ...(facts.detail ? { detail: facts.detail } : {}) },
  });
  next.updatedAt = facts.now;
  return { ok: true, changed: true, next };
}

import { resolveD } from "../../../shared/domain/run-engine/delivery-binding";
import { reduceRun } from "../../../shared/domain/run-engine/reducer";
import type { RunRecord } from "../../../shared/schemas/run-engine/ledger";

type ReplyKind = "task-report" | "review-report" | "smoke-report";

/** After the fixed creation times the pure fixtures use; a service test passes the real clock. */
export const DEFAULT_NOW = "2026-11-05T13:00:00.000Z";

/**
 * Drives a dispatched assignment through the reducer exactly as the observer would: the host echoes
 * the dispatch, the turn starts, the report is accepted, the turn ends. Pure, so it also runs inside
 * a store mutator. The `now` of every step must not be earlier than the assignment's own creation.
 * `block` receives the assignment's identity fields (runId, taskId, attempt, nonce, assignmentId).
 */
export function recordReply(
  record: RunRecord,
  assignmentId: string,
  kind: ReplyKind,
  block: (identity: Record<string, unknown>) => Record<string, unknown>,
  now = DEFAULT_NOW,
): RunRecord {
  const facts = { now, newId: (name: string) => `${name}-flow` };
  const start = structuredClone(record);
  const assignment = start.assignments.find((entry) => entry.assignmentId === assignmentId);
  const intent = start.outbox.find(
    (entry) => entry.kind === "dispatch" && entry.assignmentId === assignmentId,
  );
  if (!assignment || !intent) throw new Error(`no dispatched assignment ${assignmentId}`);
  Object.assign(intent, { state: "confirmed", confirmedAt: now });

  const turnId = `turn-${assignmentId}`;
  const endedEventKey = `${assignment.agentId}|${turnId}|turn_ended`;
  const steps = [
    { kind: "turn-started", assignmentId, agentId: assignment.agentId, turnId },
    {
      kind,
      block: block({
        protocolVersion: 1,
        runId: start.runId,
        taskId: assignment.taskId,
        attempt: assignment.attempt,
        nonce: assignment.nonce,
        assignmentId,
      }),
    },
    {
      kind: "observation-recorded",
      receipt: {
        eventKey: endedEventKey,
        kind: "turn_ended",
        agentId: assignment.agentId,
        turnId,
        seq: 0,
        receivedAt: now,
        dedupeKey: endedEventKey,
        disposition: "accepted",
      },
    },
    { kind: "turn-ended", assignmentId, endedEventKey },
  ];
  let current = start;
  for (const step of steps) {
    const result = reduceRun(current, step as never, facts);
    if (!result.ok) {
      throw new Error(`${step.kind} refused: ${JSON.stringify(result.params)}`);
    }
    current = result.next;
  }
  return current;
}

/** A reviewer's verdict on the task's current delivery. */
export function recordReview(
  record: RunRecord,
  assignmentId: string,
  review: {
    verdict: "可合入" | "修改后合入" | "不可合入";
    blockers?: { id: string; summary: string; path: string | null }[];
  },
  now?: string,
): RunRecord {
  const assignment = record.assignments.find((entry) => entry.assignmentId === assignmentId);
  const resolved = resolveD(record, assignment?.taskId ?? "");
  if (resolved.kind !== "ok") throw new Error("nothing to review");
  return recordReply(
    record,
    assignmentId,
    "review-report",
    (identity) => ({
      ...identity,
      reviewedRef: resolved.d.ref,
      verdict: review.verdict,
      blockers: review.blockers ?? [],
      probes: [],
    }),
    now,
  );
}

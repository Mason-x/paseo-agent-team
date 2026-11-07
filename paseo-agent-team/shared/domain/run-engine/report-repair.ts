import type { RunAssignment, RunEffectIntent, RunRecord } from "../../schemas/run-engine/ledger";

/**
 * Asking a member to send its report again (plan 11.4, item 3, gap 1).
 *
 * A report the strict parser refuses, or no report at all, used to leave the task waiting with a
 * reason and nobody to act on it. The repair is one more message to the SAME assignment: it is a
 * `wake` intent that names the assignment, so it travels through the outbox like every send (prepared,
 * sending, confirmed, never sent twice). It does no business work again: the member is asked only to
 * restate what it already did.
 *
 * What stays the same: the assignment, its nonce and its turn rules. A refused report never accepted
 * the nonce, so the repaired report is checked exactly like the first one. What changes is where the
 * reply is read from: the reply to the newest repair message that went out (`replyAnchor`).
 *
 * Bounded by the task's `protocolFailures` against `policy.perTask.protocolResends`. Like the other
 * controlled changes that have no reducer event (`noteTask`, `transitionIntent`), this is a pure
 * function on the record that writes an audit event; the reducer's vocabulary is not extended.
 */

export const REPAIR_PURPOSE = "repair";

const SENT_STATES: readonly string[] = ["sending", "confirmed", "outcome-unknown"];
export const MAX_REPAIR_ISSUES = 5;
const MAX_ISSUE_TEXT = 200;

type Wake = Extract<RunEffectIntent, { kind: "wake" }>;

/** The protocol blocks an assignment's reply may carry. A judge may also say it could not do its job. */
export const REPORT_KINDS_BY_PURPOSE: Record<RunAssignment["purpose"], readonly string[] | null> = {
  member: ["task-report"],
  coordinator: ["task-report"],
  reopen: ["task-report"],
  reviewer: ["review-report", "task-report"],
  smoker: ["smoke-report", "task-report"],
  probe: null,
};

export function isRepairWake(intent: RunEffectIntent): intent is Wake {
  return intent.kind === "wake" && intent.semanticArgs.purpose === REPAIR_PURPOSE;
}

/** The repair messages of one assignment, oldest first. */
export function repairWakes(record: RunRecord, assignmentId: string): Wake[] {
  return record.outbox.filter(
    (intent): intent is Wake => isRepairWake(intent) && intent.assignmentId === assignmentId,
  );
}

/**
 * The message whose reply holds the report to read: the newest repair that went out, else the
 * dispatch. A repair that is only prepared (or failed to build) has no reply yet.
 */
export function replyAnchor(
  record: RunRecord,
  assignment: Pick<RunAssignment, "assignmentId" | "messageId">,
): string {
  const sent = repairWakes(record, assignment.assignmentId).filter((intent) =>
    SENT_STATES.includes(intent.state),
  );
  return sent.at(-1)?.messageId ?? assignment.messageId;
}

export type RepairIssue = { path: string; message: string };

export type RepairRequest = {
  assignmentId: string;
  /** The message the problem was read from (`replyAnchor` at that time). */
  anchor: string;
  /** Why the report is not usable, e.g. `report-rejected:schema-invalid` or `report-missing`. */
  reason: string;
  issues: readonly RepairIssue[];
  intentId: string;
  messageId: string;
  payloadHash: string;
  templateVersion: number;
  now: string;
};

export type RepairResult =
  | { ok: true; next: RecordWithRepair; ordinal: number; limit: number }
  | {
      ok: false;
      code:
        | "assignment-missing"
        | "assignment-not-open"
        | "no-reply-kinds"
        /** The problem was read from an older message than the newest repair: nothing to add. */
        | "stale-anchor"
        /** A repair is prepared and not yet sent: wait for it. */
        | "repair-pending"
        | "limit-reached";
    };

type RecordWithRepair = RunRecord;

/** At most `MAX_REPAIR_ISSUES` diagnostics, each field cut to a bounded length (shared with the plan re-send). */
export function trimIssues(issues: readonly RepairIssue[]): RepairIssue[] {
  return issues.slice(0, MAX_REPAIR_ISSUES).map((issue) => ({
    path: issue.path.slice(0, MAX_ISSUE_TEXT),
    message: issue.message.slice(0, MAX_ISSUE_TEXT),
  }));
}

export function requestReportRepair(record: RunRecord, input: RepairRequest): RepairResult {
  const assignment = record.assignments.find((entry) => entry.assignmentId === input.assignmentId);
  if (!assignment) return { ok: false, code: "assignment-missing" };
  if (
    (assignment.state !== "assigned" && assignment.state !== "in_progress") ||
    assignment.acceptedProof !== null
  ) {
    return { ok: false, code: "assignment-not-open" };
  }
  const kinds = REPORT_KINDS_BY_PURPOSE[assignment.purpose];
  if (kinds === null) return { ok: false, code: "no-reply-kinds" };
  const index = record.tasks.findIndex((entry) => entry.spec.id === assignment.taskId);
  const task = record.tasks[index];
  if (task === undefined) return { ok: false, code: "assignment-missing" };

  const repairs = repairWakes(record, assignment.assignmentId);
  if (repairs.some((intent) => intent.state === "prepared")) {
    return { ok: false, code: "repair-pending" };
  }
  if (input.anchor !== replyAnchor(record, assignment)) return { ok: false, code: "stale-anchor" };
  const limit = record.policy.perTask.protocolResends;
  if (task.protocolFailures >= limit) return { ok: false, code: "limit-reached" };

  const ordinal = task.protocolFailures + 1;
  const next = structuredClone(record);
  const nextTask = next.tasks[index];
  if (nextTask === undefined) return { ok: false, code: "assignment-missing" };
  nextTask.protocolFailures = ordinal;
  nextTask.waitingReason = `report-repair-requested:${input.reason}`.slice(0, 600);
  next.outbox.push({
    id: input.intentId,
    kind: "wake",
    recipient: assignment.agentId,
    messageId: input.messageId,
    idempotencyKey: `repair:${record.runId}:${assignment.assignmentId}:${ordinal}`,
    payloadHash: input.payloadHash,
    templateVersion: input.templateVersion,
    state: "prepared",
    recoverySendCount: 0,
    createdAt: input.now,
    confirmedAt: null,
    localCancellation: null,
    taskId: assignment.taskId,
    assignmentId: assignment.assignmentId,
    semanticArgs: {
      purpose: REPAIR_PURPOSE,
      ordinal,
      limit,
      reason: input.reason.slice(0, 200),
      issues: trimIssues(input.issues),
      kinds: [...kinds],
    },
  });
  const seq = next.counters.eventsThroughSeq + 1;
  next.counters.eventsThroughSeq = seq;
  next.events.push({
    seq,
    kind: "report-repair-requested",
    at: input.now,
    payload: {
      taskId: assignment.taskId,
      assignmentId: assignment.assignmentId,
      intentId: input.intentId,
      reason: input.reason.slice(0, 200),
      ordinal,
    },
  });
  next.updatedAt = input.now;
  return { ok: true, next, ordinal, limit };
}

/**
 * Drops the repair messages of an assignment once it has its report. Like the plan request that
 * leaves the outbox when its plan is in, a confirmed message that belongs to a settled actor must
 * not keep the Run from finishing; the audit event keeps the fact that it was sent.
 */
export function settleRepairs(record: RunRecord, assignmentId: string, now: string): RunRecord {
  const repairs = repairWakes(record, assignmentId);
  if (repairs.length === 0) return record;
  const gone = new Set(repairs.map((intent) => intent.id));
  const seq = record.counters.eventsThroughSeq + 1;
  return {
    ...record,
    outbox: record.outbox.filter((intent) => !gone.has(intent.id)),
    counters: { ...record.counters, eventsThroughSeq: seq },
    events: [
      ...record.events,
      {
        seq,
        kind: "report-repair-settled",
        at: now,
        payload: {
          assignmentId,
          intents: repairs.map((intent) => ({ intentId: intent.id, state: intent.state })),
        },
      },
    ],
    updatedAt: now,
  };
}

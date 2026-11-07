import type {
  RunAssignment,
  RunRecord,
  RunStoredTaskReport,
} from "../../schemas/run-engine/ledger";
import { RunStoredTaskReportSchema } from "../../schemas/run-engine/ledger";
import { isDecisionPending } from "./decision-state";
import { producerHead, resolveD } from "./delivery-binding";
import { reduceRun } from "./reducer";
import { settleRepairs } from "./report-repair";
import { hasUnsettledEffects, isNormalEnded } from "./transitions";

/**
 * Answering a decision a person is asked about (P06). A decision "waits for a person" when a task
 * stopped in a way the Engine will not undo by itself:
 *
 *  - D3 / D4 (`quality:<producer>:D3|D4`, opened by the reducer): the quality ladder or the attempt
 *    cap ran out. D3 leaves the task `failed`, D4 leaves it `blocked` and frozen.
 *  - D1 `stuck:<assignment>` (opened by `openStuckDecision`): a member or a judge reported `blocked` or
 *    `failed`, so the task is frozen with no decision to answer.
 *  - D1 `stuck:<assignment>` (opened by `openLimboDecision`): a producer's turn ended and the report it
 *    left cannot be used, and the Engine has asked for it as often as it may. The task is not frozen
 *    (it is still `assigned`); it only has nobody to wait for.
 *
 * The one answer is `retry`: one more attempt, taken from where the stop happened. What it does depends
 * on what stopped (`planResume`), and it never does more than one thing:
 *
 *   rework   the delivery failed review or smoke and exists: the task goes back to `rework`, keeps its
 *            claims (unfrozen) and the next dispatch is the ordinary rework one;
 *   fresh    a producer stopped without a delivery: the task goes back to `ready` and its claims are
 *            released, so the next dispatch asks for them again against every other Run;
 *   rejudge  a reviewer or smoker could not do its job on a delivery that stands: the task goes back to
 *            `review`, keeps its claims (unfrozen) and the judge is dispatched again;
 *   abandon  a producer's turn ended without a usable report: the attempt is closed on the turn the host
 *            reported ended (the reducer's own `turn-started` and `turn-ended`), its unanswered
 *            re-sends leave the outbox, its nonce is revoked, and then it is a `fresh` attempt.
 *
 * Nothing is released that is not proven stopped: every assignment of the task must have ended on a
 * recorded `turn_ended` (the same standard the reducer asks before another attempt), nothing the task
 * sent may be unsettled, and no cancellation may be pending. The Run must be `active`.
 *
 * Counters and gates are not touched. A retry is exactly one more attempt: the caps are measured at the
 * next quality failure, which opens the next decision. `reject`, `cancel`, `assign-seat` and the budget
 * answers are not here (cancellation and the full release path are later work).
 *
 * Like `noteTask` and `transitionIntent`, pure functions on the record that write an audit event; the
 * reducer's `decision` event stays unsupported and its vocabulary is not extended.
 */

type Decision = RunRecord["decisions"][number];
type Task = RunRecord["tasks"][number];

const PRODUCER_PURPOSES: readonly RunAssignment["purpose"][] = ["member", "coordinator", "reopen"];
const OPEN_ASSIGNMENT: readonly RunAssignment["state"][] = ["assigned", "in_progress"];
const OPEN_TASK: readonly Task["state"][] = ["assigned", "in_progress"];

export const STUCK_KEY_PREFIX = "stuck:";
export const QUALITY_KEY_PREFIX = "quality:";
export const DECISION_OPENED_EVENT = "decision-opened";
export const DECISION_ANSWERED_EVENT = "decision-answered";

export type AnswerableKind =
  | { kind: "quality"; level: "D3" | "D4"; producerAssignmentId: string }
  | { kind: "stuck"; assignmentId: string };

/** What a decision is about, or `null` when this build cannot answer it (cancellation, approval, ...). */
export function classifyDecision(decision: Decision): AnswerableKind | null {
  if (decision.subjectId === null || decision.cancelIntents !== null) return null;
  const key = decision.dedupeKey;
  if (
    key.startsWith(QUALITY_KEY_PREFIX) &&
    (decision.category === "D3" || decision.category === "D4")
  ) {
    const suffix = `:${decision.category}`;
    if (!key.endsWith(suffix)) return null;
    const producerAssignmentId = key.slice(QUALITY_KEY_PREFIX.length, key.length - suffix.length);
    if (producerAssignmentId === "") return null;
    return { kind: "quality", level: decision.category, producerAssignmentId };
  }
  if (key.startsWith(STUCK_KEY_PREFIX) && decision.category === "D1") {
    const assignmentId = key.slice(STUCK_KEY_PREFIX.length);
    return assignmentId === "" ? null : { kind: "stuck", assignmentId };
  }
  return null;
}

/** The answers a person may give right now, for the Runs page. Empty when it cannot be answered. */
export function answerableActions(decision: Decision): "retry"[] {
  return isDecisionPending(decision) && classifyDecision(decision) !== null ? ["retry"] : [];
}

function taskOf(record: RunRecord, taskId: string): Task | undefined {
  return record.tasks.find((task) => task.spec.id === taskId);
}

function isBlockedOrFailedReport(proof: RunAssignment["acceptedProof"]): boolean {
  const parsed = RunStoredTaskReportSchema.safeParse(proof);
  return parsed.success && parsed.data.status !== "done";
}

function stoppedReport(assignment: RunAssignment): RunStoredTaskReport | null {
  const parsed = RunStoredTaskReportSchema.safeParse(assignment.acceptedProof);
  return parsed.success && parsed.data.status !== "done" ? parsed.data : null;
}

function audit(next: RunRecord, kind: string, now: string, payload: Record<string, unknown>): void {
  const seq = next.counters.eventsThroughSeq + 1;
  next.counters.eventsThroughSeq = seq;
  next.events.push({ seq, kind, at: now, payload });
  next.updatedAt = now;
}

// --- opening ---------------------------------------------------------------------------------

export type StuckOpening = {
  taskId: string;
  /** The assignment whose report stopped the task (its proof is a blocked or failed task report). */
  assignmentId: string;
  decisionId: string;
  /** SHA-256 of a nonce nobody keeps: decisions are answered by id, never by a block carrying a nonce. */
  controlNonceDigest: string;
  now: string;
};

/** Why a task is stopped, in the words of the report that stopped it. */
function stoppedSummary(task: Task, assignment: RunAssignment): string {
  const report = stoppedReport(assignment);
  const who =
    assignment.purpose === "reviewer"
      ? "审查者"
      : assignment.purpose === "smoker"
        ? "冒烟者"
        : "生产者";
  const code = report?.reasonCode ?? task.waitingReason ?? "unknown";
  return `${who}无法完成任务 ${task.spec.id}（${report?.status ?? "blocked"}：${code}）。任务已冻结，可在确认环境后重试。`.slice(
    0,
    4096,
  );
}

/**
 * Opens the decision a stopped task waits on. Does nothing when the task already has a decision
 * waiting (of any kind) or when this stop already has one, so calling it again writes nothing.
 */
export function openStuckDecision(
  record: RunRecord,
  input: StuckOpening,
): { changed: false } | { changed: true; next: RunRecord } {
  const task = taskOf(record, input.taskId);
  const assignment = record.assignments.find((entry) => entry.assignmentId === input.assignmentId);
  if (task === undefined || assignment === undefined || assignment.taskId !== input.taskId) {
    return { changed: false };
  }
  if (task.state !== "blocked" && task.state !== "failed") return { changed: false };
  if (!isBlockedOrFailedReport(assignment.acceptedProof)) return { changed: false };
  const dedupeKey = `${STUCK_KEY_PREFIX}${input.assignmentId}`;
  if (
    record.decisions.some(
      (entry) =>
        entry.dedupeKey === dedupeKey ||
        (entry.subjectId === input.taskId && isDecisionPending(entry)),
    )
  ) {
    return { changed: false };
  }
  const next = structuredClone(record);
  next.decisions.push({
    decisionId: input.decisionId,
    category: "D1",
    controlNonceDigest: input.controlNonceDigest,
    state: "open",
    dedupeKey,
    cancelIntents: null,
    subjectId: input.taskId,
    summary: stoppedSummary(task, assignment),
    createdAt: input.now,
    answeredAt: null,
    answer: null,
    resolution: null,
  });
  audit(next, DECISION_OPENED_EVENT, input.now, {
    decisionId: input.decisionId,
    category: "D1",
    taskId: input.taskId,
    dedupeKey,
  });
  return { changed: true, next };
}

export type LimboOpening = {
  taskId: string;
  assignmentId: string;
  /** Why the report is unusable, e.g. `report-missing` or `report-rejected:schema-invalid`. */
  reason: string;
  /** The turn whose reply was read, and the host's receipt that it ended. */
  turnId: string;
  decisionId: string;
  controlNonceDigest: string;
  now: string;
};

/**
 * Opens the decision for a producer whose turn ended with no report the Engine can use and no re-send
 * left to ask for. Refuses (writes nothing) unless the host's `turn_ended` receipt for that turn is in
 * the ledger: that receipt is what lets the attempt be closed later without guessing. The task keeps its
 * state; the decision records which turn and which receipt, so the answer does not have to look them up.
 */
export function openLimboDecision(
  record: RunRecord,
  input: LimboOpening,
): { changed: false } | { changed: true; next: RunRecord } {
  const task = taskOf(record, input.taskId);
  const assignment = record.assignments.find((entry) => entry.assignmentId === input.assignmentId);
  if (task === undefined || assignment === undefined || assignment.taskId !== input.taskId) {
    return { changed: false };
  }
  if (!PRODUCER_PURPOSES.includes(assignment.purpose)) return { changed: false };
  if (assignment.acceptedProof !== null || !OPEN_ASSIGNMENT.includes(assignment.state)) {
    return { changed: false };
  }
  if (!OPEN_TASK.includes(task.state) || task.currentAssignmentId !== assignment.assignmentId) {
    return { changed: false };
  }
  const ended = record.eventReceipts.find(
    (receipt) =>
      receipt.kind === "turn_ended" &&
      receipt.agentId === assignment.agentId &&
      receipt.turnId === input.turnId,
  );
  if (ended === undefined) return { changed: false };
  const dedupeKey = `${STUCK_KEY_PREFIX}${input.assignmentId}`;
  if (
    record.decisions.some(
      (entry) =>
        entry.dedupeKey === dedupeKey ||
        (entry.subjectId === input.taskId && isDecisionPending(entry)),
    )
  ) {
    return { changed: false };
  }
  const next = structuredClone(record);
  next.decisions.push({
    decisionId: input.decisionId,
    category: "D1",
    controlNonceDigest: input.controlNonceDigest,
    state: "open",
    dedupeKey,
    cancelIntents: null,
    subjectId: input.taskId,
    summary:
      `生产者的回合已结束，但没有可用的报告（${input.reason.slice(0, 200)}），补报次数已用尽。` +
      "可放弃本次尝试并重试。",
    createdAt: input.now,
    answeredAt: null,
    answer: null,
    resolution: null,
    limbo: {
      turnId: input.turnId,
      endedEventKey: ended.eventKey,
      reason: input.reason.slice(0, 200),
    },
  } as Decision);
  audit(next, DECISION_OPENED_EVENT, input.now, {
    decisionId: input.decisionId,
    category: "D1",
    taskId: input.taskId,
    dedupeKey,
  });
  return { changed: true, next };
}

/**
 * The stopped tasks that wait on nobody: `blocked` or `failed`, no decision waiting, and a current
 * assignment whose accepted proof is the blocked or failed report that stopped it. Cancellations have
 * their own decision and are not found here.
 */
export function stoppedTasksWithoutDecision(
  record: RunRecord,
): { taskId: string; assignmentId: string }[] {
  const found: { taskId: string; assignmentId: string }[] = [];
  for (const task of record.tasks) {
    if (task.state !== "blocked" && task.state !== "failed") continue;
    if (
      record.decisions.some((entry) => entry.subjectId === task.spec.id && isDecisionPending(entry))
    ) {
      continue;
    }
    if (record.decisions.some((entry) => entry.dedupeKey === `cancel:${task.spec.id}`)) continue;
    const assignment = record.assignments.find(
      (entry) => entry.assignmentId === task.currentAssignmentId,
    );
    if (assignment === undefined || !isBlockedOrFailedReport(assignment.acceptedProof)) continue;
    found.push({ taskId: task.spec.id, assignmentId: assignment.assignmentId });
  }
  return found;
}

// --- answering -------------------------------------------------------------------------------

export type AnswerRequest = {
  decisionId: string;
  requestId: string;
  /** The revision the caller read; a different one now is `revision-conflict`. */
  expectedRevision: number;
  reason: string;
  action: "retry";
  now: string;
};

export type AnswerRefusal =
  | { code: "decision-missing" }
  | { code: "revision-conflict"; current: number }
  | { code: "decision-answered" }
  | { code: "decision-not-answerable"; category: string }
  | { code: "action-unsupported"; action: string }
  | { code: "run-not-active"; lifecycle: string }
  | { code: "task-not-releasable"; reason: string };

export type AnswerResult =
  | { ok: true; replayed: false; next: RunRecord; taskId: string }
  | { ok: true; replayed: true; taskId: string | null }
  | ({ ok: false } & AnswerRefusal);

type Resume =
  | { kind: "rework" }
  | { kind: "fresh" }
  | { kind: "rejudge"; phase: "review" | "smoke" }
  | { kind: "abandon"; assignmentId: string; turnId: string; endedEventKey: string };

type Planned = { ok: true; resume: Resume } | { ok: false; reason: string };

function limboEvidence(decision: Decision): { turnId: string; endedEventKey: string } | null {
  const raw = (decision as Decision & { limbo?: unknown }).limbo;
  if (typeof raw !== "object" || raw === null) return null;
  const { turnId, endedEventKey } = raw as Record<string, unknown>;
  if (typeof turnId !== "string" || typeof endedEventKey !== "string") return null;
  return { turnId, endedEventKey };
}

/**
 * Works out what the retry would do and whether it may, from the ledger alone (the decision's own words
 * are only a pointer). A reason code says what is in the way. That the actors are settled and nothing is
 * left unsettled is judged afterwards, on the record the retry would leave (`answerDecision`).
 */
function planResume(
  record: RunRecord,
  decision: Decision,
  kind: AnswerableKind,
  taskId: string,
): Planned {
  const task = taskOf(record, taskId);
  if (task === undefined) return { ok: false, reason: "task-missing" };
  if (record.decisions.some((entry) => entry.dedupeKey === `cancel:${taskId}`)) {
    return { ok: false, reason: "cancellation" };
  }

  if (kind.kind === "quality") {
    const expected = kind.level === "D3" ? "failed" : "blocked";
    if (task.state !== expected) return { ok: false, reason: "state-changed" };
    const head = producerHead(record, taskId);
    if (head.kind !== "ok" || head.assignment.assignmentId !== kind.producerAssignmentId) {
      return { ok: false, reason: "decision-stale" };
    }
    if (resolveD(record, taskId).kind !== "ok") return { ok: false, reason: "delivery-missing" };
    return { ok: true, resume: { kind: "rework" } };
  }

  const assignment = record.assignments.find((entry) => entry.assignmentId === kind.assignmentId);
  if (
    assignment === undefined ||
    assignment.taskId !== taskId ||
    task.currentAssignmentId !== assignment.assignmentId
  ) {
    return { ok: false, reason: "decision-stale" };
  }

  if (assignment.acceptedProof === null) {
    // A producer whose turn ended with nothing usable (`openLimboDecision`): still `assigned`.
    const evidence = limboEvidence(decision);
    if (evidence === null || !PRODUCER_PURPOSES.includes(assignment.purpose)) {
      return { ok: false, reason: "decision-stale" };
    }
    if (!OPEN_ASSIGNMENT.includes(assignment.state) || !OPEN_TASK.includes(task.state)) {
      return { ok: false, reason: "state-changed" };
    }
    const ended = record.eventReceipts.find(
      (receipt) =>
        receipt.eventKey === evidence.endedEventKey &&
        receipt.kind === "turn_ended" &&
        receipt.agentId === assignment.agentId &&
        receipt.turnId === evidence.turnId,
    );
    if (ended === undefined) return { ok: false, reason: "turn-not-ended" };
    if (assignment.attempt !== task.attempts) return { ok: false, reason: "decision-stale" };
    return {
      ok: true,
      resume: {
        kind: "abandon",
        assignmentId: assignment.assignmentId,
        turnId: evidence.turnId,
        endedEventKey: evidence.endedEventKey,
      },
    };
  }

  if (!isBlockedOrFailedReport(assignment.acceptedProof)) {
    return { ok: false, reason: "decision-stale" };
  }
  if (task.state !== "blocked" && task.state !== "failed") {
    return { ok: false, reason: "state-changed" };
  }
  if (assignment.purpose === "reviewer" || assignment.purpose === "smoker") {
    // A judge that could not judge says nothing about the delivery; it stands only if it can be found.
    if (task.state !== "blocked") return { ok: false, reason: "state-changed" };
    if (resolveD(record, taskId).kind !== "ok") return { ok: false, reason: "delivery-missing" };
    return {
      ok: true,
      resume: { kind: "rejudge", phase: assignment.purpose === "reviewer" ? "review" : "smoke" },
    };
  }
  if (assignment.attempt !== task.attempts) return { ok: false, reason: "decision-stale" };
  return { ok: true, resume: { kind: "fresh" } };
}

/**
 * Closes the attempt of a producer whose turn ended without a usable report, with the reducer's own
 * events on the turn and the receipt the host gave: `turn-started` if the attempt never recorded one,
 * then `turn-ended`. The attempt's unanswered re-sends leave the outbox, and its nonce, never accepted,
 * is revoked so nothing it might still say can be taken for a report.
 */
function abandonAttempt(
  record: RunRecord,
  resume: Extract<Resume, { kind: "abandon" }>,
  now: string,
): { ok: true; next: RunRecord } | { ok: false; reason: string } {
  const assignment = record.assignments.find((entry) => entry.assignmentId === resume.assignmentId);
  if (assignment === undefined) return { ok: false, reason: "decision-stale" };
  const facts = { now, newId: () => "unused" };
  let working = record;
  const steps: Parameters<typeof reduceRun>[1][] = [];
  if (assignment.state === "assigned") {
    steps.push({
      kind: "turn-started",
      assignmentId: assignment.assignmentId,
      agentId: assignment.agentId,
      turnId: resume.turnId,
    });
  }
  steps.push({
    kind: "turn-ended",
    assignmentId: assignment.assignmentId,
    endedEventKey: resume.endedEventKey,
  });
  for (const step of steps) {
    const reduced = reduceRun(working, step, facts);
    if (!reduced.ok) return { ok: false, reason: `reducer-${String(reduced.params.reason ?? "")}` };
    working = reduced.next;
  }
  working = settleRepairs(working, assignment.assignmentId, now);
  const nonce = working.nonceRegistry.find(
    (entry) => entry.assignmentId === assignment.assignmentId && entry.nonce === assignment.nonce,
  );
  if (nonce && nonce.acceptedAt === null && nonce.revokedAt === null) {
    nonce.revokedAt = now;
    nonce.revokeReason = "abandoned-by-retry";
  }
  return { ok: true, next: working };
}

function find(record: RunRecord, decisionId: string): Decision | undefined {
  return record.decisions.find((entry) => entry.decisionId === decisionId);
}

export function answerDecision(record: RunRecord, input: AnswerRequest): AnswerResult {
  const decision = find(record, input.decisionId);
  if (decision === undefined) return { ok: false, code: "decision-missing" };
  const answer = decision.answer as (Decision["answer"] & { requestId?: unknown }) | null;
  if (decision.state === "answered") {
    // The same request again is the same answer; anyone else's answer stands.
    if (answer?.requestId === input.requestId && answer.action === input.action) {
      return { ok: true, replayed: true, taskId: decision.subjectId };
    }
    return { ok: false, code: "decision-answered" };
  }
  if (record.revision !== input.expectedRevision) {
    return { ok: false, code: "revision-conflict", current: record.revision };
  }
  const kind = isDecisionPending(decision) ? classifyDecision(decision) : null;
  if (kind === null || decision.subjectId === null) {
    return { ok: false, code: "decision-not-answerable", category: decision.category };
  }
  if (input.action !== "retry")
    return { ok: false, code: "action-unsupported", action: input.action };
  if (record.lifecycle !== "active") {
    return { ok: false, code: "run-not-active", lifecycle: record.lifecycle };
  }
  const taskId = decision.subjectId;
  const planned = planResume(record, decision, kind, taskId);
  if (!planned.ok) return { ok: false, code: "task-not-releasable", reason: planned.reason };

  let next = structuredClone(record);
  if (planned.resume.kind === "abandon") {
    const closed = abandonAttempt(next, planned.resume, input.now);
    if (!closed.ok) return { ok: false, code: "task-not-releasable", reason: closed.reason };
    next = closed.next;
  }
  // Nothing is released that is not proven stopped. Judged on the record the retry would leave, so an
  // attempt that was just closed counts as closed, and a re-send nobody answered no longer counts.
  if (next.assignments.some((entry) => entry.taskId === taskId && !isNormalEnded(next, entry))) {
    return { ok: false, code: "task-not-releasable", reason: "actors-unsettled" };
  }
  if (hasUnsettledEffects(next, taskId)) {
    return { ok: false, code: "task-not-releasable", reason: "effects-unsettled" };
  }

  const nextDecision = find(next, input.decisionId) as Decision;
  nextDecision.state = "answered";
  nextDecision.answeredAt = input.now;
  nextDecision.answer = {
    action: input.action,
    taskIds: [taskId],
    answeredAt: input.now,
    requestId: input.requestId,
    reason: input.reason.slice(0, 600),
  };
  const task = taskOf(next, taskId) as Task;
  const claims = next.resources.filter((claim) => claim.taskId === taskId);
  switch (planned.resume.kind) {
    case "rework":
      task.state = "rework";
      task.phase = undefined;
      break;
    case "rejudge":
      task.state = "review";
      task.phase = planned.resume.phase;
      break;
    case "fresh":
    case "abandon":
      task.state = "ready";
      task.phase = undefined;
      task.currentAssignmentId = null;
      // Nothing may hold a claim while `ready`: the next dispatch asks for them again, against everyone.
      next.resources = next.resources.filter((claim) => claim.taskId !== taskId);
      break;
  }
  if (planned.resume.kind === "rework" || planned.resume.kind === "rejudge") {
    for (const claim of claims) claim.frozen = false;
  }
  task.frozenClaimId = null;
  task.waitingReason = "retry-approved";
  task.releaseDecisionId = decision.decisionId;
  audit(next, DECISION_ANSWERED_EVENT, input.now, {
    decisionId: decision.decisionId,
    taskId,
    action: input.action,
    resume: planned.resume.kind,
    requestId: input.requestId,
  });
  return { ok: true, replayed: false, next, taskId };
}

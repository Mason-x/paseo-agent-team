import type {
  RunAssignment,
  RunRecord,
  RunStoredTaskReport,
} from "../../schemas/run-engine/ledger";
import { RunStoredTaskReportSchema } from "../../schemas/run-engine/ledger";
import { cancelPending } from "./cancel-request";
import { isDecisionPending } from "./decision-state";
import { producerHead, resolveD } from "./delivery-binding";
import { evidenceRepairOf } from "./evidence-repair";
import { closedSince, HOST_LOST_CODE, MEMBER_LOST_CODE } from "./lost-turn";
import { reduceRun } from "./reducer";
import { replyAnchor, settleRepairs } from "./report-repair";
import { hasUnsettledEffects, isNormalEnded, outstandingAssignments } from "./transitions";
import { anchorSince, ownTurn, receiptOccurrence } from "./turn-occurrence";

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
 * `retry` is one more attempt, taken from where the stop happened. What it does depends
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
 * next quality failure, which opens the next decision.
 *
 * The other answer is `cancel` (`answerCancel`): the task is cancelled, its claims are released, and so
 * is everything that depends on it. It asks for the same proof as a retry (every turn of the task ended,
 * nothing it sent unsettled) and then goes through the reducer's own cancellation: the task is frozen and
 * the reducer's D1 `cancel:<task>` is answered `cancel` in the same commit, which is the authorization
 * that lets the second `cancel-requested` release a claim kept from a delivery that was sent. Code that
 * was committed stays where it is. `evidence-stuck:<assignment>` is the decision for a task stopped by a
 * member's answer to an evidence request: a retry would throw the delivery away, so only `cancel` is
 * offered for it. `reject`, `assign-seat` and the budget answers are not here.
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
export const EVIDENCE_STUCK_KEY_PREFIX = "evidence-stuck:";
export const DECISION_OPENED_EVENT = "decision-opened";
export const DECISION_ANSWERED_EVENT = "decision-answered";

export type AnswerableKind =
  | { kind: "quality"; level: "D3" | "D4"; producerAssignmentId: string }
  | { kind: "stuck"; assignmentId: string }
  | { kind: "evidence-stuck"; assignmentId: string };

export type DecisionAction = "retry" | "cancel";

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
  if (key.startsWith(EVIDENCE_STUCK_KEY_PREFIX) && decision.category === "D1") {
    const assignmentId = key.slice(EVIDENCE_STUCK_KEY_PREFIX.length);
    return assignmentId === "" ? null : { kind: "evidence-stuck", assignmentId };
  }
  return null;
}

export type DecisionKind =
  | "quality-d3"
  | "quality-d4"
  | "stuck-producer"
  | "stuck-judge"
  | "limbo-producer"
  | "member-lost"
  | "host-lost"
  | "evidence-stuck"
  | "cancel"
  | "other";

/** A redacted display kind derived from existing facts, without changing what can be answered. */
export function decisionKindOf(
  record: Pick<RunRecord, "assignments">,
  decision: Decision,
): DecisionKind {
  if (
    decision.category === "D1" &&
    decision.subjectId !== null &&
    decision.dedupeKey === `cancel:${decision.subjectId}`
  )
    return "cancel";
  const kind = classifyDecision(decision);
  if (kind === null) return "other";
  if (kind.kind === "quality") return kind.level === "D3" ? "quality-d3" : "quality-d4";
  const lost = limboEvidence(decision) !== null && limboReason(decision) === MEMBER_LOST_CODE;
  if (kind.kind === "evidence-stuck") return lost ? "member-lost" : "evidence-stuck";
  const assignment = record.assignments.find((entry) => entry.assignmentId === kind.assignmentId);
  if (!assignment || assignment.taskId !== decision.subjectId) return "other";
  if (assignment.purpose === "reviewer" || assignment.purpose === "smoker") {
    return lost ? "member-lost" : "stuck-judge";
  }
  if (!PRODUCER_PURPOSES.includes(assignment.purpose)) return "other";
  if (limboEvidence(decision) === null) return "stuck-producer";
  const reason = limboReason(decision);
  if (reason === MEMBER_LOST_CODE) return "member-lost";
  return reason === HOST_LOST_CODE ? "host-lost" : "limbo-producer";
}

/** What each kind of decision can be answered with; a supplement stopped by a member has no retry. */
function actionsOfKind(kind: AnswerableKind): DecisionAction[] {
  return kind.kind === "evidence-stuck" ? ["cancel"] : ["retry", "cancel"];
}

/** The record fields that decide what a person may answer; the receipts are optional for a bare lifecycle. */
type AnswerContext = Pick<RunRecord, "lifecycle"> & Partial<Pick<RunRecord, "eventReceipts">>;

/**
 * A decision about a turn the host cut off (the member was closed or archived after the turn began) is
 * answered with `cancel` only: whatever the turn left behind is not a report to try again, and the
 * member cannot be asked again. Judged from the receipts, not from the decision's kind, so a real
 * `turn_ended` that came first and a decision opened for a missing report are covered too. One opened as
 * `host-lost` is cut by an `archived` receipt only (T9d): a `closed` one is what a graceful stop of the
 * daemon writes for every agent, and the member is usable again after it.
 */
function turnWasCut(record: AnswerContext, decision: Decision, kind: AnswerableKind): boolean {
  if (kind.kind !== "stuck") return false;
  const evidence = limboEvidence(decision);
  if (evidence === null) return false;
  // The Engine opened this one because the host closed the member under the turn (`member-lost.ts`).
  if (limboReason(decision) === MEMBER_LOST_CODE) return true;
  if (record.eventReceipts === undefined) return false;
  const ended = record.eventReceipts.find(
    (receipt) =>
      receipt.eventKey === evidence.endedEventKey &&
      receipt.kind === "turn_ended" &&
      receipt.turnId === evidence.turnId,
  );
  if (ended?.agentId === undefined || ended.agentId === null) return false;
  return closedSince(
    { eventReceipts: record.eventReceipts },
    ended.agentId,
    evidence.turnId,
    receiptOccurrence(ended),
    limboReason(decision) === HOST_LOST_CODE ? ["archived"] : ["closed", "archived"],
  );
}

function actionsFor(
  record: AnswerContext,
  decision: Decision,
  kind: AnswerableKind,
): DecisionAction[] {
  return turnWasCut(record, decision, kind) ? ["cancel"] : actionsOfKind(kind);
}

/**
 * The answers a person may give right now, for the Runs page. Empty when it cannot be answered, and
 * while the Run is not `active` (a paused Run answers nothing).
 */
export function answerableActions(record: AnswerContext, decision: Decision): DecisionAction[] {
  if (record.lifecycle !== "active" || cancelPending(record) || !isDecisionPending(decision)) {
    return [];
  }
  const kind = classifyDecision(decision);
  return kind === null ? [] : actionsFor(record, decision, kind);
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
  // A supplement of the evidence chain that a member answered with blocked or failed has its own key:
  // its decision never offers a retry, which would throw the delivery away.
  const evidence = evidenceRepairOf(record, assignment) !== null;
  if (task.state !== "blocked" && task.state !== "failed") return { changed: false };
  if (!isBlockedOrFailedReport(assignment.acceptedProof)) return { changed: false };
  const dedupeKey = `${evidence ? EVIDENCE_STUCK_KEY_PREFIX : STUCK_KEY_PREFIX}${input.assignmentId}`;
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
    summary: evidence
      ? `补证请求没有完成（${stoppedReport(assignment)?.status ?? "blocked"}），任务 ${task.spec.id} 已冻结；只能取消这个任务。`
      : stoppedSummary(task, assignment),
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

/** What a person is told at a limbo decision, for the reason it was opened with. */
function limboSummary(reason: string, replyLost = false): string {
  if (replyLost && (reason === MEMBER_LOST_CODE || reason === HOST_LOST_CODE)) {
    // The host said the turn ended, but its reply cannot be found any more (T9b).
    return (
      "成员的回合已结束，但它的回复已丢失（派发消息已不在成员的历史里），没有报告。" +
      "成员可能已做完一部分：请先看它的分支，并确认它的进程已经停了。" +
      (reason === MEMBER_LOST_CODE
        ? "成员已被关闭或归档，只能取消这个任务。"
        : "可放弃这次尝试后重试，或取消这个任务。")
    );
  }
  if (reason === MEMBER_LOST_CODE) {
    return (
      "成员的 Agent 在回合进行中被关闭或归档，这一回合被切断，没有报告。只能取消这个任务：" +
      "成员不能再被追问，已归档的席位在本 Run 里不会再派活。"
    );
  }
  if (reason === HOST_LOST_CODE) {
    return (
      "宿主丢失了成员的这一回合（宿主重启后，派发消息已不在成员的历史里），没有报告。" +
      "可放弃这次尝试后重试，或取消这个任务。宿主重启后成员的进程可能还在运行：重试或取消之前请先确认它已经停止。"
    );
  }
  return (
    `生产者的回合已结束，但没有可用的报告（${reason.slice(0, 200)}），补报次数已用尽。` +
    "可放弃本次尝试并重试。"
  );
}

export type LimboOpening = {
  taskId: string;
  assignmentId: string;
  /** Why the report is unusable, e.g. `report-missing` or `report-rejected:schema-invalid`. */
  reason: string;
  /** The turn whose reply was read, and the host's receipt that it ended. */
  turnId: string;
  /** The turn-ended receipt the Engine just wrote for this turn, when it is known (T4a, T4b). */
  endedEventKey?: string;
  /**
   * The host's own end of the turn is on the ledger but the reply is lost (T9b): only the text a person
   * reads changes, not the decision, its key or what can be answered.
   */
  replyLost?: boolean;
  decisionId: string;
  controlNonceDigest: string;
  now: string;
};

/**
 * Whether the attempt has an unanswered decision of the kind `openLimboDecision` opens (the producer's
 * turn ended with no usable report, or the member or its turn was lost). While one is open, a reply
 * read for the attempt is not taken in: a person answers the decision. Cancellation decisions are
 * a different thing and never block a report (A5).
 */
export function hasUnansweredLimbo(
  record: Pick<RunRecord, "decisions">,
  assignmentId: string,
): boolean {
  return record.decisions.some((decision) => {
    if (!isDecisionPending(decision) || limboEvidence(decision) === null) return false;
    const kind = classifyDecision(decision);
    return (
      kind !== null &&
      (kind.kind === "stuck" || kind.kind === "evidence-stuck") &&
      kind.assignmentId === assignmentId
    );
  });
}

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
  // A member lost mid-turn (T4a) is also the way out for a judge or a supplement whose turn was cut: the
  // task waits in `review` for a report that cannot come, and the only answer is to cancel it.
  const lost = input.reason === MEMBER_LOST_CODE;
  const supplement = evidenceRepairOf(record, assignment) !== null;
  if (supplement && !lost) return { changed: false };
  const judge = assignment.purpose === "reviewer" || assignment.purpose === "smoker";
  if (!PRODUCER_PURPOSES.includes(assignment.purpose) && !(lost && judge)) {
    return { changed: false };
  }
  if (assignment.acceptedProof !== null || !OPEN_ASSIGNMENT.includes(assignment.state)) {
    return { changed: false };
  }
  const inReview = lost && (judge || supplement) && task.state === "review";
  if (
    (!OPEN_TASK.includes(task.state) && !inReview) ||
    task.currentAssignmentId !== assignment.assignmentId
  ) {
    return { changed: false };
  }
  // The end that belongs to this attempt's own turn: the one the Engine just wrote, or else the earliest
  // appearance of the turn id after the message the reply answers.
  const ended =
    input.endedEventKey !== undefined
      ? record.eventReceipts.find(
          (receipt) =>
            receipt.eventKey === input.endedEventKey &&
            receipt.kind === "turn_ended" &&
            receipt.agentId === assignment.agentId &&
            receipt.turnId === input.turnId,
        )
      : ownTurn(record, {
          agentId: assignment.agentId,
          turnId: input.turnId,
          since: anchorSince(record, replyAnchor(record, assignment), assignment),
        })?.ended;
  if (ended === undefined) return { changed: false };
  const dedupeKey = `${supplement ? EVIDENCE_STUCK_KEY_PREFIX : STUCK_KEY_PREFIX}${input.assignmentId}`;
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
    summary: limboSummary(input.reason, input.replyLost === true),
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
  action: DecisionAction;
  now: string;
  /** Ids for what a cancellation opens (the reducer's own decision). */
  newId?: (kind: string) => string;
  /** SHA-256 of a nonce nobody keeps, for the cancellation events (shared code has no crypto). */
  controlNonceDigest?: string;
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
  | { ok: true; replayed: false; next: RunRecord; taskId: string; cancelled?: string[] }
  | { ok: true; replayed: true; taskId: string | null }
  | ({ ok: false } & AnswerRefusal);

type Resume =
  | { kind: "rework" }
  | { kind: "fresh" }
  | { kind: "rejudge"; phase: "review" | "smoke" }
  | { kind: "abandon"; assignmentId: string; turnId: string; endedEventKey: string };

type Planned = { ok: true; resume: Resume } | { ok: false; reason: string };

function limboReason(decision: Decision): string | null {
  const raw = (decision as Decision & { limbo?: unknown }).limbo;
  if (typeof raw !== "object" || raw === null) return null;
  const { reason } = raw as Record<string, unknown>;
  return typeof reason === "string" ? reason : null;
}

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

  if (evidenceRepairOf(record, assignment)) return { ok: false, reason: "decision-stale" };
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

/** The attempt of a producer whose turn ended, and the receipt the host gave for it. */
export type EndedAttempt = {
  assignmentId: string;
  turnId: string;
  endedEventKey: string;
  now: string;
  /**
   * Leave the nonce to the caller. A retry revokes it here because the task leaves the attempt at once;
   * a cancellation does not, because the task is still `assigned` until the reducer freezes or cancels it,
   * and a revoked nonce on a live attempt breaks the ledger invariants (the reducer revokes it itself).
   */
  leaveNonce?: boolean;
};

/**
 * Closes the attempt of a producer whose turn ended without a usable report, with the reducer's own
 * events on the turn and the receipt the host gave: `turn-started` if the attempt never recorded one,
 * then `turn-ended`. The attempt's unanswered re-sends leave the outbox, and its nonce, never accepted,
 * is revoked so nothing it might still say can be taken for a report. A retry and a cancellation both
 * start from here.
 */
export function closeEndedAttempt(
  record: RunRecord,
  resume: EndedAttempt,
): { ok: true; next: RunRecord } | { ok: false; reason: string } {
  const { now } = resume;
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
  if (!resume.leaveNonce && nonce && nonce.acceptedAt === null && nonce.revokedAt === null) {
    nonce.revokedAt = now;
    nonce.revokeReason = "abandoned-by-retry";
  }
  return { ok: true, next: working };
}

/** Every task that cannot run once `taskId` is cancelled: those that depend on it, through any chain. */
function downstreamOf(record: RunRecord, taskId: string): string[] {
  const found = new Set<string>([taskId]);
  const order: string[] = [];
  for (let grew = true; grew; ) {
    grew = false;
    for (const task of record.tasks) {
      if (found.has(task.spec.id) || !task.spec.deps.some((dep) => found.has(dep))) continue;
      found.add(task.spec.id);
      order.push(task.spec.id);
      grew = true;
    }
  }
  return order;
}

type CancelPlan = { ok: true; close: EndedAttempt | null } | { ok: false; reason: string };

/**
 * Whether the stop the decision is about is still the task's stop, and what has to be closed first. The
 * same questions as `planResume`, without its need for a delivery to go back to: a task can be
 * cancelled whether or not anything was delivered.
 */
function planCancel(
  record: RunRecord,
  decision: Decision,
  kind: AnswerableKind,
  taskId: string,
  now: string,
): CancelPlan {
  const task = taskOf(record, taskId);
  if (task === undefined) return { ok: false, reason: "task-missing" };
  if (task.state === "done" || task.state === "cancelled")
    return { ok: false, reason: "state-changed" };
  if (kind.kind === "quality") {
    const expected = kind.level === "D3" ? "failed" : "blocked";
    if (task.state !== expected) return { ok: false, reason: "state-changed" };
    const head = producerHead(record, taskId);
    if (head.kind !== "ok" || head.assignment.assignmentId !== kind.producerAssignmentId) {
      return { ok: false, reason: "decision-stale" };
    }
    return { ok: true, close: null };
  }
  const assignment = record.assignments.find((entry) => entry.assignmentId === kind.assignmentId);
  if (
    assignment === undefined ||
    assignment.taskId !== taskId ||
    task.currentAssignmentId !== assignment.assignmentId
  ) {
    return { ok: false, reason: "decision-stale" };
  }
  const supplement = evidenceRepairOf(record, assignment) !== null;
  if (supplement !== (kind.kind === "evidence-stuck"))
    return { ok: false, reason: "decision-stale" };
  if (assignment.acceptedProof === null) {
    // A producer whose turn ended with nothing usable (`openLimboDecision`): close the attempt first.
    // A judge or a supplement whose turn the host cut off (`member-lost`) is closed the same way.
    const evidence = limboEvidence(decision);
    const lost = limboReason(decision) === MEMBER_LOST_CODE;
    const judge = assignment.purpose === "reviewer" || assignment.purpose === "smoker";
    if (evidence === null || !(PRODUCER_PURPOSES.includes(assignment.purpose) || (lost && judge))) {
      return { ok: false, reason: "decision-stale" };
    }
    const taskStateOk = OPEN_TASK.includes(task.state) || (lost && task.state === "review");
    if (!OPEN_ASSIGNMENT.includes(assignment.state) || !taskStateOk) {
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
    return {
      ok: true,
      close: {
        assignmentId: assignment.assignmentId,
        turnId: evidence.turnId,
        endedEventKey: evidence.endedEventKey,
        now,
        leaveNonce: true,
      },
    };
  }
  if (!isBlockedOrFailedReport(assignment.acceptedProof)) {
    return { ok: false, reason: "decision-stale" };
  }
  if (task.state !== "blocked" && task.state !== "failed") {
    return { ok: false, reason: "state-changed" };
  }
  return { ok: true, close: null };
}

/**
 * `cancel`: the task and everything that depends on it are cancelled, in one commit or not at all.
 * The task goes through the reducer's own `cancel-requested` (a task with no claim is cancelled by it;
 * one that holds a claim kept from a delivery that was sent is frozen and the reducer opens its D1
 * `cancel:<task>`). That D1 is then answered `cancel` on the person's behalf (`via` names the decision
 * they answered) and a second `cancel-requested` releases the claim: the reducer's authorization.
 */
function answerCancel(
  record: RunRecord,
  decision: Decision,
  kind: AnswerableKind,
  taskId: string,
  input: AnswerRequest,
): AnswerResult {
  const refuse = (reason: string): AnswerResult => ({
    ok: false,
    code: "task-not-releasable",
    reason,
  });
  const { newId, controlNonceDigest } = input;
  if (newId === undefined || controlNonceDigest === undefined)
    return refuse("cancel-facts-missing");
  const planned = planCancel(record, decision, kind, taskId, input.now);
  if (!planned.ok) return refuse(planned.reason);
  let next = structuredClone(record);
  if (planned.close !== null) {
    const closed = closeEndedAttempt(next, planned.close);
    if (!closed.ok) return refuse(closed.reason);
    next = closed.next;
  }
  // Nothing is released that is not proven stopped.
  if (outstandingAssignments(next, taskId).length > 0) return refuse("actors-unsettled");
  if (hasUnsettledEffects(next, taskId)) return refuse("effects-unsettled");
  // Everything that depends on the task can never run; each must be untouched so far.
  const downstream = downstreamOf(next, taskId).filter(
    (id) => taskOf(next, id)?.state !== "cancelled",
  );
  for (const id of downstream) {
    const dependent = taskOf(next, id) as Task;
    if (
      dependent.state !== "pending" ||
      next.assignments.some((entry) => entry.taskId === id) ||
      next.resources.some((claim) => claim.taskId === id)
    ) {
      return refuse("dependent-active");
    }
  }

  const facts = { now: input.now, newId };
  const cancel = (id: string): string | null => {
    const reduced = reduceRun(
      next,
      {
        kind: "cancel-requested",
        taskIds: [id],
        reason: "decision-cancel",
        controlNonceDigest,
        cancelIntents: [],
        preparedCancelIntents: [],
      },
      facts,
    );
    if (!reduced.ok) return `reducer-${String(reduced.params.reason ?? reduced.code)}`;
    next = reduced.next;
    return null;
  };
  const answer = (target: Decision, taskIds: string[], via?: string): void => {
    target.state = "answered";
    target.answeredAt = input.now;
    target.answer = {
      action: "cancel",
      taskIds,
      answeredAt: input.now,
      requestId: input.requestId,
      reason: input.reason.slice(0, 600),
      ...(via === undefined ? {} : { via }),
    };
  };

  const first = cancel(taskId);
  if (first !== null) return refuse(first);
  if (taskOf(next, taskId)?.state !== "cancelled") {
    // Frozen: it holds a claim kept from a delivery that was sent. The reducer's D1 is the
    // authorization to release it, and the person has just answered `cancel`.
    const cancelDecision = next.decisions.find(
      (entry) =>
        entry.category === "D1" &&
        entry.subjectId === taskId &&
        entry.dedupeKey === `cancel:${taskId}` &&
        entry.cancelIntents?.length === 0 &&
        isDecisionPending(entry),
    );
    if (cancelDecision === undefined) return refuse("cancel-not-released");
    answer(cancelDecision, [taskId], decision.decisionId);
    const second = cancel(taskId);
    if (second !== null) return refuse(second);
    if (taskOf(next, taskId)?.state !== "cancelled") return refuse("cancel-not-released");
  }
  for (const id of downstream) {
    const failure = cancel(id);
    if (failure !== null) return refuse(failure);
  }

  const cancelled = [taskId, ...downstream];
  answer(find(next, input.decisionId) as Decision, cancelled);
  // The release is bound to the decision that authorized it (the reducer's D1 when there was one).
  const task = taskOf(next, taskId) as Task;
  task.releaseDecisionId ??= decision.decisionId;
  audit(next, DECISION_ANSWERED_EVENT, input.now, {
    decisionId: decision.decisionId,
    taskId,
    action: "cancel",
    cancelled,
    requestId: input.requestId,
  });
  return { ok: true, replayed: false, next, taskId, cancelled };
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
  if (!actionsFor(record, decision, kind).includes(input.action)) {
    return { ok: false, code: "action-unsupported", action: input.action };
  }
  if (record.lifecycle !== "active") {
    return { ok: false, code: "run-not-active", lifecycle: record.lifecycle };
  }
  const taskId = decision.subjectId;
  if (input.action === "cancel") return answerCancel(record, decision, kind, taskId, input);
  const planned = planResume(record, decision, kind, taskId);
  if (!planned.ok) return { ok: false, code: "task-not-releasable", reason: planned.reason };

  let next = structuredClone(record);
  if (planned.resume.kind === "abandon") {
    const closed = closeEndedAttempt(next, { ...planned.resume, now: input.now });
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

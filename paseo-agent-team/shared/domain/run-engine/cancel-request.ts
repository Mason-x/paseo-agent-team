import { z } from "zod";
import { type RunRecord, RunTimeSchema } from "../../schemas/run-engine/ledger";
import { canCancelLocally } from "./transitions";
import { provenEndedTurn, type SeatView } from "./turn-proof";

/**
 * Cancelling a whole Run (A5): a request is written first, new dispatches stop, and the Run is cancelled
 * once every turn that was running is proven ended. Nothing is sent to a member, nothing is archived and
 * nothing is interrupted on the way, so it costs no model call.
 *
 * The request is a passthrough block of its own, `cancelRequest`, read by `readCancelRequest` like
 * `readRetries` and `launch.dagControl`: the ledger schema is not touched, a program that does not know
 * the block keeps it as it is, and a block that does not read back is not guessed at. It lives outside
 * `events` on purpose: the history is compacted (A1), and "a cancellation was asked for and has not
 * finished" must be remembered for as long as it is true.
 */

export const CANCEL_REQUEST_VERSION = 1;
export const CANCEL_REQUEST_EVENT = "run-cancel-requested";
export const CANCEL_COMPLETED_EVENT = "run-cancel-completed";
/** The reason every task gets when the Run is cancelled: a code, the person's words are in the request. */
export const CANCEL_TASK_REASON = "run-cancel";

/** Fixed texts, so the same alert is found again (the alert id is derived from the text). */
export const CANCEL_PENDING_ALERT =
  "已请求取消这个 Run：不再派发新任务，等进行中的回合结束后取消全部未完成的任务并释放占用。";
export const CANCEL_INVALID_ALERT =
  "这个 Run 有一个读不懂的取消请求：已停止自动处理，请检查台账，不要续办。";
export const cancelStuckAlert = (code: string): string => `取消没有完成：${code}`;

const CancelRequestSchema = z.strictObject({
  version: z.literal(CANCEL_REQUEST_VERSION),
  requestId: z.string().min(1).max(128),
  reason: z.string().min(1).max(600),
  requestedAt: RunTimeSchema,
  completedAt: RunTimeSchema.nullable(),
});
export type CancelRequest = z.infer<typeof CancelRequestSchema>;

export type CancelRequestRead =
  | { kind: "absent" }
  /** There, but not readable: treated as "a cancellation is wanted", never as "none". */
  | { kind: "invalid" }
  | { kind: "valid"; value: CancelRequest };

export function readCancelRequest(record: object): CancelRequestRead {
  const raw = (record as Record<string, unknown>).cancelRequest;
  if (raw === undefined) return { kind: "absent" };
  const parsed = CancelRequestSchema.safeParse(raw);
  return parsed.success ? { kind: "valid", value: parsed.data } : { kind: "invalid" };
}

/** True while a cancellation is asked for and not finished (an unreadable request counts). */
export function cancelPending(record: object): boolean {
  const read = readCancelRequest(record);
  return read.kind === "invalid" || (read.kind === "valid" && read.value.completedAt === null);
}

/** A copy of the record with the request in it. */
export function withCancelRequest(record: RunRecord, value: CancelRequest): RunRecord {
  const next = structuredClone(record);
  (next as Record<string, unknown>).cancelRequest = value;
  return next;
}

export type { SeatView };

export type EndedTurn = { assignmentId: string; turnId: string; endedEventKey: string };

export type CancelFinishPlan =
  | { kind: "wait"; turns: number; deliveries: number }
  | { kind: "finish"; close: EndedTurn[] };

const OPEN = new Set(["assigned", "in_progress"]);

/**
 * The assignments the Run is still waiting on, apart from those that never left (a dispatch that is only
 * prepared is withdrawn by `run-cancelled` itself).
 */
function waitedOn(record: RunRecord) {
  return record.assignments.filter((assignment) => {
    if (!OPEN.has(assignment.state)) return false;
    const dispatches = record.outbox.filter(
      (intent) => intent.kind === "dispatch" && intent.assignmentId === assignment.assignmentId,
    );
    const only = dispatches.length === 1 ? dispatches[0] : undefined;
    return !(only !== undefined && canCancelLocally(record, assignment, only));
  });
}

/** The agents whose live state has to be read before the plan can say anything. */
export function agentsToRead(record: RunRecord): string[] {
  return [...new Set(waitedOn(record).map((assignment) => assignment.agentId))].sort();
}

/**
 * Whether the Run can be cancelled now, and which attempts are closed on a turn the host reported ended.
 *
 * A turn counts as ended only on the host's own receipt: a `turn_ended` for the agent that came after the
 * assignment was made (and is the assignment's own turn when it has one), no `turn_started` after it, and
 * the live state of the agent being idle or closed with no active turn. Anything else is a turn still
 * being waited for. A message whose delivery is not settled (`sending`, `outcome-unknown`) may still start
 * one, so it is waited for as well. `seats = "assume-idle"` is for the answer to a request, which reads no
 * host: it counts what the ledger alone cannot prove.
 */
export function planCancelFinish(
  record: RunRecord,
  seats: ReadonlyMap<string, SeatView> | "assume-idle",
): CancelFinishPlan {
  const deliveries = record.outbox.filter(
    (intent) => intent.state === "sending" || intent.state === "outcome-unknown",
  ).length;
  let turns = 0;
  const close: EndedTurn[] = [];
  for (const assignment of waitedOn(record)) {
    const seat =
      seats === "assume-idle"
        ? { status: "idle", activeTurn: false }
        : seats.get(assignment.agentId);
    // The same proof the settlement of a lost reply uses (turn-proof.ts).
    const ended = provenEndedTurn(record, assignment, seat);
    if (ended === undefined) {
      turns += 1;
      continue;
    }
    close.push({
      assignmentId: assignment.assignmentId,
      turnId: ended.turnId,
      endedEventKey: ended.eventKey,
    });
  }
  return turns + deliveries > 0 ? { kind: "wait", turns, deliveries } : { kind: "finish", close };
}

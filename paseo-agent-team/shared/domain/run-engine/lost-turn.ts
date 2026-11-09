import type { RunAssignment, RunEventReceipt, RunRecord } from "../../schemas/run-engine/ledger";
import { evidenceRepairOf } from "./evidence-repair";
import {
  LOST_TURN_CODE,
  LOST_TURN_SETTLE_DELAY_MS,
  READ_RETRY_EVENT,
  type ReadRetryItem,
  readReadRetries,
  targetStillWaited,
} from "./read-retry";
import { replyAnchor } from "./report-repair";
import { ENGINE_SETTLER, receiptOccurrence, sameTurnOccurrence } from "./turn-occurrence";

/**
 * A member's turn that Paseo cut off because the person closed or archived the member's Agent (T4a).
 *
 * The host does not promise a `turn_ended` for such a turn (closing an Agent drops it from the host
 * before anyone is told), so the Engine would wait for a turn end that never comes. When the ledger and
 * the host's own live state together prove that the session is closed and no turn is running, the turn
 * is over: `findClosedTurns` says which ones. Pure functions on the record; reading the host and writing
 * are in `server/run-engine/member-lost.ts`.
 *
 * A second kind of lost turn (T4b) is the one the host lost by restarting: the member is alive and idle,
 * but the dispatch is no longer in its history, so the reads of its reply failed until they were used
 * up. `findLostTurns` says which ones a further look, at least `LOST_TURN_SETTLE_DELAY_MS` later, shows
 * to be lost. It is only for a member the host reads as idle: a closed one is a closed turn.
 *
 * What proves a closed turn (all of these, for one assignment):
 *  a. it waits for a report: open, no accepted proof, and its dispatch was confirmed delivered;
 *  b. its turn is known: the agent's newest `turn_started` after the assignment was made (the
 *     assignment's own turn when it has one). A member closed with no `turn_started` on record is not
 *     settled: nothing says which turn was cut;
 *  c. that turn has no `turn_ended` receipt;
 *  d. the session is closed: a `closed` receipt after that `turn_started`, or the host reads the agent
 *     as `closed` right now. An `archived` receipt alone is not enough: the host writes it before it
 *     closes the session;
 *  e. no `turn_started` of the agent after it (the person reopened the member and it works again);
 *  f. the host read is usable and shows no running turn. An agent the host no longer has counts as
 *     having no turn; a failed read counts as nothing.
 */

export const MEMBER_LOST_CODE = "member-lost";
export const SEAT_ARCHIVED_CODE = "seat-archived";
/** `outcome` of the receipt the Engine writes for a turn the host closed under the member. */
export const AGENT_CLOSED_OUTCOME = "agent-closed";
export { ENGINE_SETTLER };
/** The reason code of the decision, and the `outcome` of the receipt, for a turn the host lost (T4b). */
export const HOST_LOST_CODE = "host-lost";
export const HOST_LOST_OUTCOME = "host-lost";
export { LOST_TURN_SETTLE_DELAY_MS };

/** What one read of an agent showed. `absent`: the host has no such agent. `unreadable`: asking failed. */
export type SeatRead = { status: string; activeTurn: boolean } | "absent" | "unreadable";

export type ClosedTurnBasis = {
  closedBy: "receipt" | "host-read";
  /** The `closed` receipt, when that is the evidence. */
  closedReceiptKey: string | null;
};

export type ClosedTurn = {
  assignmentId: string;
  taskId: string;
  agentId: string;
  turnId: string;
  /** Which appearance of the turn id this is (see turn-occurrence.ts): the end settled for it carries it. */
  occurrence: number;
  basis: ClosedTurnBasis;
};

export type ClosedTurnCandidate = {
  assignment: RunAssignment;
  started: RunEventReceipt;
  /** The first `closed` receipt after the turn started, if the ledger has one. */
  closed: RunEventReceipt | null;
};

const OPEN: readonly RunAssignment["state"][] = ["assigned", "in_progress"];
const REPORT_PURPOSES: readonly RunAssignment["purpose"][] = [
  "member",
  "coordinator",
  "reopen",
  "reviewer",
  "smoker",
];

/** A receipt the Engine wrote for a turn the host closed (not one the host reported). */
export function isEngineSettled(receipt: Pick<RunEventReceipt, "kind">): boolean {
  return (
    receipt.kind === "turn_ended" &&
    (receipt as { settledBy?: unknown }).settledBy === ENGINE_SETTLER
  );
}

/** The turn-ended receipts the Engine wrote for `assignment`'s turn, if any. */
export function engineSettledEnd(
  record: Pick<RunRecord, "eventReceipts">,
  assignment: Pick<RunAssignment, "agentId" | "turnId" | "createdAt">,
): RunEventReceipt | undefined {
  return record.eventReceipts.find(
    (receipt) =>
      isEngineSettled(receipt) &&
      receipt.agentId === assignment.agentId &&
      receipt.turnId !== null &&
      // A turn id can come back after a restart: the end must also have been written after the
      // assignment, or it is an older assignment's.
      (assignment.turnId === null
        ? Date.parse(receipt.receivedAt) > Date.parse(assignment.createdAt)
        : receipt.turnId === assignment.turnId &&
          Date.parse(receipt.receivedAt) >= Date.parse(assignment.createdAt)),
  );
}

/** Whether the host told us this agent was archived: its seat takes no work for the rest of the Run. */
export function isAgentArchived(
  record: Pick<RunRecord, "eventReceipts">,
  agentId: string | null,
): boolean {
  return (
    agentId !== null &&
    record.eventReceipts.some(
      (receipt) => receipt.kind === "archived" && receipt.agentId === agentId,
    )
  );
}

function dispatchConfirmed(record: RunRecord, assignment: RunAssignment): boolean {
  return record.outbox.some(
    (intent) =>
      intent.kind === "dispatch" &&
      intent.assignmentId === assignment.assignmentId &&
      intent.state === "confirmed",
  );
}

/** Conditions a, b, c and the ledger half of d and e: the turns that may have been cut off. */
export function closedTurnCandidates(record: RunRecord): ClosedTurnCandidate[] {
  const found: ClosedTurnCandidate[] = [];
  for (const assignment of record.assignments) {
    if (!OPEN.includes(assignment.state) || assignment.acceptedProof !== null) continue;
    if (!REPORT_PURPOSES.includes(assignment.purpose)) continue;
    if (!dispatchConfirmed(record, assignment)) continue;
    const started = record.eventReceipts
      .filter(
        (receipt) =>
          receipt.kind === "turn_started" &&
          receipt.agentId === assignment.agentId &&
          receipt.turnId !== null &&
          Date.parse(receipt.receivedAt) > Date.parse(assignment.createdAt),
      )
      .sort((a, b) => b.seq - a.seq)[0];
    if (started === undefined) continue;
    if (assignment.turnId !== null && started.turnId !== assignment.turnId) continue;
    const ended = record.eventReceipts.some(
      (receipt) => receipt.kind === "turn_ended" && sameTurnOccurrence(receipt, started),
    );
    if (ended) continue;
    const closed =
      record.eventReceipts
        .filter(
          (receipt) =>
            receipt.kind === "closed" &&
            receipt.agentId === assignment.agentId &&
            receipt.seq > started.seq,
        )
        .sort((a, b) => a.seq - b.seq)[0] ?? null;
    found.push({ assignment, started, closed });
  }
  return found;
}

/** The agents `findClosedTurns` needs a host read for. */
export function agentsToCheck(record: RunRecord): string[] {
  return [
    ...new Set(closedTurnCandidates(record).map((candidate) => candidate.assignment.agentId)),
  ].sort();
}

function noTurnRunning(seat: SeatRead | undefined): boolean {
  if (seat === undefined || seat === "unreadable") return false;
  if (seat === "absent") return true;
  return !seat.activeTurn && seat.status !== "running" && seat.status !== "initializing";
}

/** The turns that were closed under their member, and what showed it. Writes nothing. */
export function findClosedTurns(
  record: RunRecord,
  seats: ReadonlyMap<string, SeatRead>,
): ClosedTurn[] {
  const turns: ClosedTurn[] = [];
  for (const { assignment, started, closed } of closedTurnCandidates(record)) {
    const seat = seats.get(assignment.agentId);
    if (!noTurnRunning(seat)) continue;
    let basis: ClosedTurnBasis | null = null;
    if (closed !== null) basis = { closedBy: "receipt", closedReceiptKey: closed.eventKey };
    else if (seat !== undefined && typeof seat === "object" && seat.status === "closed") {
      basis = { closedBy: "host-read", closedReceiptKey: null };
    }
    if (basis === null || started.turnId === null) continue;
    turns.push({
      assignmentId: assignment.assignmentId,
      taskId: assignment.taskId,
      agentId: assignment.agentId,
      turnId: started.turnId,
      occurrence: receiptOccurrence(started),
      basis,
    });
  }
  return turns;
}

/**
 * Whether the host closed or archived `agentId` after the turn `turnId` began. Such a turn was cut off,
 * so whatever came of it is not a report to retry: the decision about it only offers `cancel`.
 */
export function closedSince(
  record: Pick<RunRecord, "eventReceipts">,
  agentId: string,
  turnId: string,
  occurrence?: number,
): boolean {
  // One appearance of the turn id: the one asked for, else the newest.
  const mine = (kind: string) => {
    const same = record.eventReceipts.filter(
      (receipt) =>
        receipt.kind === kind && receipt.agentId === agentId && receipt.turnId === turnId,
    );
    return occurrence === undefined
      ? same.sort((a, b) => receiptOccurrence(b) - receiptOccurrence(a) || b.seq - a.seq)[0]
      : same.find((receipt) => receiptOccurrence(receipt) === occurrence);
  };
  const started = mine("turn_started");
  const ended = mine("turn_ended");
  const since = started?.seq ?? ended?.seq ?? 0;
  return record.eventReceipts.some(
    (receipt) =>
      (receipt.kind === "closed" || receipt.kind === "archived") &&
      receipt.agentId === agentId &&
      receipt.seq > since,
  );
}

// --- a turn the host lost (T4b) -----------------------------------------------------------------

const PRODUCER_PURPOSES: readonly RunAssignment["purpose"][] = ["member", "coordinator", "reopen"];
const UNSETTLED_DELIVERY: readonly string[] = ["prepared", "sending", "outcome-unknown"];

/** What was seen for the receipt of a turn the host lost. */
export type HostLostBasis = {
  /** When the re-checks of the reply were used up (the last failure of the item). */
  firstNotFoundAt: string;
  /** When the look that settles the turn found the dispatch missing again. */
  secondNotFoundAt: string;
  /** What the host said the member was doing then: always `idle`. */
  seatStatus: string;
};

export type LostTurn = {
  assignmentId: string;
  taskId: string;
  agentId: string;
  turnId: string;
  /** Which appearance of the turn id this is (see turn-occurrence.ts). */
  occurrence: number;
  basis: HostLostBasis;
  /** The used-up re-check of the reply, whose alert is taken down with the settlement. */
  item: ReadRetryItem;
};

export type LostTurnCandidate = {
  assignment: RunAssignment;
  started: RunEventReceipt;
  item: ReadRetryItem;
  /** The message whose reply is read again. */
  anchorMessageId: string;
  /** When the item was used up. */
  heldAt: string;
};

/** What a read of the reply of a dispatch showed, and when it was read. */
export type LostReplyRead = { dispatchNotFound: boolean; at: string };

/** The time the used-up item went to `held`, from the audit events of its changes. */
function heldAtOf(record: RunRecord, item: ReadRetryItem): string | null {
  let found: { seq: number; at: string } | null = null;
  for (const event of record.events) {
    if (event.kind !== READ_RETRY_EVENT) continue;
    const payload = event.payload as Record<string, unknown> | undefined;
    if (
      payload?.key !== item.key ||
      payload.generation !== item.generation ||
      payload.state !== "held"
    ) {
      continue;
    }
    if (found === null || event.seq > found.seq) found = { seq: event.seq, at: event.at };
  }
  return found?.at ?? null;
}

function deliveryUnsettled(record: RunRecord, assignment: RunAssignment): boolean {
  return record.outbox.some(
    (intent) =>
      UNSETTLED_DELIVERY.includes(intent.state) &&
      (intent.taskId === assignment.taskId || intent.recipient === assignment.agentId),
  );
}

/**
 * The turns that may have been lost by a host restart, judged from the ledger alone: conditions a, c, d
 * and f of T4b, and that the used-up re-check is at least `LOST_TURN_SETTLE_DELAY_MS` old at `now`.
 *  a. the reads of the reply of this assignment are used up, with `incomplete:dispatch-not-found`
 *     (a v1 Run has no such record, so none of its turns is found);
 *  c. the dispatch was confirmed delivered, for an assignment that is open and has no report;
 *  d. one turn of the agent began after the assignment was made (its own, when the assignment has one),
 *     and nothing of the agent came after it: no later `turn_started`, no `turn_ended` of any turn;
 *  f. no message for the task or to the agent is still on its way, or of unknown fate.
 * Only a producer's own task turn is found. A judge's or smoke tester's turn is left out by its purpose;
 * a supplement (an evidence request: purpose `member`, with an `evidenceRepair`) is left out here too,
 * because the decision for it has no way to try again and `openLimboDecision` would refuse it, so the
 * host would be read for nothing. Those turns, and a re-report turn (the agent began a second turn after
 * the assignment, which condition d rules out), stay with the way out of A21.
 */
export function lostTurnCandidates(record: RunRecord, now: string): LostTurnCandidate[] {
  const block = readReadRetries(record);
  if (block.kind !== "valid") return [];
  const found: LostTurnCandidate[] = [];
  for (const assignment of record.assignments) {
    if (!OPEN.includes(assignment.state) || assignment.acceptedProof !== null) continue;
    if (!PRODUCER_PURPOSES.includes(assignment.purpose)) continue;
    if (evidenceRepairOf(record, assignment) !== null) continue;
    if (!dispatchConfirmed(record, assignment)) continue;
    if (deliveryUnsettled(record, assignment)) continue;
    const item = block.items.find(
      (entry) =>
        entry.state === "held" &&
        entry.lastCode === LOST_TURN_CODE &&
        entry.target.type === "reply" &&
        entry.target.assignmentId === assignment.assignmentId &&
        entry.target.anchorMessageId === replyAnchor(record, assignment) &&
        targetStillWaited(record, entry.target),
    );
    if (item === undefined || item.target.type !== "reply") continue;
    const heldAt = heldAtOf(record, item);
    if (heldAt === null) continue;
    if (Date.parse(now) - Date.parse(heldAt) < LOST_TURN_SETTLE_DELAY_MS) continue;
    const starts = record.eventReceipts.filter(
      (receipt) =>
        receipt.kind === "turn_started" &&
        receipt.agentId === assignment.agentId &&
        receipt.turnId !== null &&
        Date.parse(receipt.receivedAt) > Date.parse(assignment.createdAt),
    );
    const [started] = starts;
    if (starts.length !== 1 || started === undefined) continue;
    if (assignment.turnId !== null && started.turnId !== assignment.turnId) continue;
    const later = record.eventReceipts.some(
      (receipt) =>
        receipt.kind === "turn_ended" &&
        receipt.agentId === assignment.agentId &&
        (receipt.seq > started.seq || sameTurnOccurrence(receipt, started)),
    );
    if (later) continue;
    // A member the host closed or archived after the turn began is a closed turn (T4a), not a lost one.
    if (
      started.turnId !== null &&
      closedSince(record, assignment.agentId, started.turnId, receiptOccurrence(started))
    )
      continue;
    found.push({ assignment, started, item, anchorMessageId: item.target.anchorMessageId, heldAt });
  }
  return found;
}

/**
 * The turns a host restart lost, and what showed it. Writes nothing. On top of `lostTurnCandidates`:
 *  b. a look at the host (`reads`, by assignment: the reply of the dispatch) still finds the dispatch
 *     missing, and it was made at least `LOST_TURN_SETTLE_DELAY_MS` after the re-checks were used up;
 *  e. the host reads the member as idle with no turn running. A closed one is `findClosedTurns`'s;
 *     one that cannot be read, is absent or is not idle is not settled.
 */
export function findLostTurns(
  record: RunRecord,
  seats: ReadonlyMap<string, SeatRead>,
  reads: ReadonlyMap<string, LostReplyRead>,
  now: string,
): LostTurn[] {
  const turns: LostTurn[] = [];
  for (const { assignment, started, item, heldAt } of lostTurnCandidates(record, now)) {
    const seat = seats.get(assignment.agentId);
    if (seat === undefined || typeof seat !== "object") continue;
    if (seat.status !== "idle" || seat.activeTurn) continue;
    const read = reads.get(assignment.assignmentId);
    if (read === undefined || !read.dispatchNotFound) continue;
    if (Date.parse(read.at) - Date.parse(heldAt) < LOST_TURN_SETTLE_DELAY_MS) continue;
    if (started.turnId === null) continue;
    turns.push({
      assignmentId: assignment.assignmentId,
      taskId: assignment.taskId,
      agentId: assignment.agentId,
      turnId: started.turnId,
      occurrence: receiptOccurrence(started),
      basis: { firstNotFoundAt: heldAt, secondNotFoundAt: read.at, seatStatus: seat.status },
      item,
    });
  }
  return turns;
}

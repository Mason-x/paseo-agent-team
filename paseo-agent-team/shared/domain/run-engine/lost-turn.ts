import type { RunAssignment, RunEventReceipt, RunRecord } from "../../schemas/run-engine/ledger";

/**
 * A member's turn that Paseo cut off because the person closed or archived the member's Agent (T4a).
 *
 * The host does not promise a `turn_ended` for such a turn (closing an Agent drops it from the host
 * before anyone is told), so the Engine would wait for a turn end that never comes. When the ledger and
 * the host's own live state together prove that the session is closed and no turn is running, the turn
 * is over: `findClosedTurns` says which ones. Pure functions on the record; reading the host and writing
 * are in `server/run-engine/member-lost.ts`.
 *
 * What proves it (all of these, for one assignment):
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
export const ENGINE_SETTLER = "engine";

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
      (assignment.turnId === null
        ? Date.parse(receipt.receivedAt) > Date.parse(assignment.createdAt)
        : receipt.turnId === assignment.turnId),
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
      (receipt) =>
        receipt.kind === "turn_ended" &&
        receipt.agentId === assignment.agentId &&
        receipt.turnId === started.turnId,
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
): boolean {
  const started = record.eventReceipts.find(
    (receipt) =>
      receipt.kind === "turn_started" && receipt.agentId === agentId && receipt.turnId === turnId,
  );
  const ended = record.eventReceipts.find(
    (receipt) =>
      receipt.kind === "turn_ended" && receipt.agentId === agentId && receipt.turnId === turnId,
  );
  const since = started?.seq ?? ended?.seq ?? 0;
  return record.eventReceipts.some(
    (receipt) =>
      (receipt.kind === "closed" || receipt.kind === "archived") &&
      receipt.agentId === agentId &&
      receipt.seq > since,
  );
}

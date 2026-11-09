import type { RunAssignment, RunEventReceipt, RunRecord } from "../../schemas/run-engine/ledger";
import { startedAfterEnded } from "./turn-occurrence";

/**
 * What proves that the turn an assignment is waiting on has ended. One pure function, used by the
 * cancellation of a Run (`planCancelFinish`) and by the settlement of a reply the host lost
 * (`findLostReplies`), so the two can never disagree about what counts as "the turn is over".
 *
 * A turn counts as ended only on the host's own receipt: a `turn_ended` of the assignment's agent that came
 * after the assignment was made (and is the assignment's own turn when it has one), no `turn_started` of the
 * agent after it, and the live state of the agent being idle or closed with no active turn.
 */

/**
 * What the host says of an agent right now. `unreadable`: asking failed, which proves nothing.
 * `absent`: the host answered and has no such agent (it was deleted), so it has no turn running.
 */
export type SeatView = { status: string; activeTurn: boolean } | "unreadable" | "absent";

type Proofed = Pick<RunAssignment, "agentId" | "turnId" | "createdAt">;

/**
 * The newest `turn_ended` of the assignment's agent after the assignment was made, unless the agent began
 * a turn after it. Judged from the ledger alone: the live state of the agent is not asked.
 */
export function latestEndedTurn(
  record: Pick<RunRecord, "eventReceipts">,
  assignment: Proofed,
): (RunEventReceipt & { turnId: string }) | undefined {
  const ended = record.eventReceipts
    .filter(
      (receipt) =>
        receipt.kind === "turn_ended" &&
        receipt.agentId === assignment.agentId &&
        receipt.turnId !== null &&
        Date.parse(receipt.receivedAt) >= Date.parse(assignment.createdAt) &&
        (assignment.turnId === null || receipt.turnId === assignment.turnId),
    )
    .sort((a, b) => b.seq - a.seq)[0];
  if (ended === undefined || ended.turnId === null || startedAfterEnded(record, ended)) {
    return undefined;
  }
  return ended as RunEventReceipt & { turnId: string };
}

/** Whether a read of the agent shows it at rest: idle or closed with no turn running, or not there at all. */
export function seatAtRest(seat: SeatView | undefined): boolean {
  return (
    seat === "absent" ||
    (seat !== undefined &&
      seat !== "unreadable" &&
      (seat.status === "idle" || seat.status === "closed") &&
      !seat.activeTurn)
  );
}

/**
 * The `turn_ended` receipt that proves the assignment's turn is over, or undefined when it is not proved:
 * `latestEndedTurn`, and the agent at rest on this read of it.
 */
export function provenEndedTurn(
  record: Pick<RunRecord, "eventReceipts">,
  assignment: Proofed,
  seat: SeatView | undefined,
): (RunEventReceipt & { turnId: string }) | undefined {
  if (!seatAtRest(seat)) return undefined;
  return latestEndedTurn(record, assignment);
}

import type { RunRecord } from "../../schemas/run-engine/ledger";
import { predebit } from "./budget";
import { COORDINATOR_SEAT_ID } from "./dag-admission";
import { isPlanRequest } from "./plan-repair";

/**
 * The coordinator's turn budget. The coordinator is asked for a plan once when the Run starts and
 * once more for every re-plan a person asks for; each of those is a model call, so each takes one turn
 * from one entry of `budgets.entries` (`{ scope: "seat", subjectId: "coordinator" }`), the same kind of
 * entry every seat has. The limit is the frozen policy's `run.strategicTurns`, copied into the entry the
 * first time it is needed: the policy itself is never written, and a person who adds turns changes the
 * entry (`increaseSeatBudget`), exactly as for a seat.
 *
 * What is counted is the plan request and the re-plan. A format re-send of the plan is not: it is
 * bounded by `protocolResends`, like the re-send of a member's report. Nothing is given back: a turn
 * taken is taken, as for every seat (the way out of too few is more turns).
 *
 * A Run written before this contract has no entry. It gets one on first use, with `reserved` set to
 * the plan requests the outbox still holds, whatever their state: the outbox is never compacted, so
 * the same count comes out for an old Run and a new one. That is a lower bound on what the Run used.
 *
 * Pure. This module imports `dag-admission` for the coordinator's seat id, and `budget.ts` (which
 * `dag-admission` imports) does not import it back.
 */

function entryIndex(record: RunRecord): number {
  return record.budgets.entries.findIndex(
    (entry) => entry.scope === "seat" && entry.subjectId === COORDINATOR_SEAT_ID,
  );
}

/**
 * The record with the coordinator's entry in it. A record that has one comes back as it is (the same
 * object); one that has none comes back as a copy that has one, and the argument is not touched.
 */
export function ensureCoordinatorBudget(record: RunRecord): RunRecord {
  if (entryIndex(record) >= 0) return record;
  const next = structuredClone(record);
  next.budgets.entries.push({
    scope: "seat",
    subjectId: COORDINATOR_SEAT_ID,
    limit: record.policy.run.strategicTurns,
    reserved: record.outbox.filter(isPlanRequest).length,
    confirmed: 0,
    observedTurns: 0,
  });
  return next;
}

export type CoordinatorReservation =
  | { status: "reserved"; next: RunRecord }
  | { status: "already-counted" }
  | { status: "exhausted" };

/**
 * One coordinator turn, taken in the same commit as the intent it pays for. `intentKey` and `messageId`
 * are the intent's own: an intent already in the outbox under either has been paid for. The record that
 * comes back is a copy; the argument is not touched.
 */
export function reserveCoordinatorTurn(
  record: RunRecord,
  intentKey: string,
  messageId: string,
): CoordinatorReservation {
  const based = ensureCoordinatorBudget(record);
  const debit = predebit(based, {
    seatId: COORDINATOR_SEAT_ID,
    intentKey,
    messageId,
    amount: 1,
    revision: record.revision,
  });
  if (debit.status === "already-counted") return { status: "already-counted" };
  if (debit.status === "exhausted") return { status: "exhausted" };
  const next = structuredClone(based);
  next.budgets.entries[entryIndex(next)] = debit.entry;
  return { status: "reserved", next };
}

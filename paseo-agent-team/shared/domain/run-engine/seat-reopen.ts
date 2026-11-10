import type { RunRecord } from "../../schemas/run-engine/ledger";
import { isEngineSettled } from "./lost-turn";

/**
 * Whether a closed member may be reopened by reading its history (T11a), from the receipts alone.
 *
 * A daemon restart leaves every member that was not mid-turn closed, and the host reopens an Agent when
 * its timeline is read. What that reopening needs depends on what the member has done in this Run:
 *  - `P`: it has finished a turn in this Run (a `turn_ended` with no outcome or `completed`, written by
 *    the host: a turn the Engine settled itself says nothing about the member), so its session is on
 *    disk and reading it brings it back;
 *  - `N`: it has never started a turn in this Run. A Claude member that never ran has no session to
 *    resume and is opened afresh from its stored configuration; a Codex one cannot be opened (its
 *    thread exists, its rollout does not), and reading it fails harmlessly;
 *  - `C`: it started a turn and none of its turns finished. A session id may exist whose conversation
 *    never reached the disk, so reading would say "idle" for a member whose next turn fails: not tried.
 *
 * Pure: it reads nothing from the host and writes nothing.
 */
export type SeatReopenClass = "P" | "N" | "C";

/** At most this many closed seats are read in one pass. */
export const REOPEN_READS_PER_PASS = 2;

/** How long one read of a closed member's history may take before it is given up on. */
export const REOPEN_TIMEOUT_MS = 30_000;

export function classifySeatForReopen(
  record: Pick<RunRecord, "eventReceipts">,
  agentId: string,
): SeatReopenClass {
  let turned = false;
  for (const receipt of record.eventReceipts) {
    if (receipt.agentId !== agentId) continue;
    if (receipt.kind !== "turn_started" && receipt.kind !== "turn_ended") continue;
    turned = true;
    if (receipt.kind !== "turn_ended" || isEngineSettled(receipt)) continue;
    const outcome = (receipt as { outcome?: unknown }).outcome;
    if (outcome === undefined || outcome === "completed") return "P";
  }
  return turned ? "C" : "N";
}

/** `P` and `N` are tried; `C` is left to be rebuilt. */
export function mayReopen(record: Pick<RunRecord, "eventReceipts">, agentId: string): boolean {
  return classifySeatForReopen(record, agentId) !== "C";
}

/** What one automatic try is counted against: a Run, a seat and the Agent it holds. */
export function reopenKey(runId: string, seatId: string, agentId: string): string {
  return JSON.stringify([runId, seatId, agentId]);
}

import type { RunRecord } from "../../schemas/run-engine/ledger";
import { COORDINATOR_SEAT_ID } from "./dag-admission";
import { isEngineSettled } from "./lost-turn";
import { rankCandidates, type SeatChoice, type SeatRuntime } from "./scheduler";
import { readSeatRebuilds } from "./seat-rebuild";

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
  // Any turn receipt of the agent counts as having turned: a member with only an end on record (a turn
  // the Engine settled, or one that failed) is C, not N, which is the careful side. In practice every end
  // the Engine writes follows a start, so the difference does not come up.
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

/**
 * When the Agent of a seat was made, as far as the ledger can tell: the first `created` receipt of the
 * Agent; for an Agent a rebuild made, the time the rebuild was asked for (it is made after that); otherwise
 * the Run's own creation (the launch made the Agent after it).
 */
export function agentBuiltAt(
  record: Pick<RunRecord, "eventReceipts" | "createdAt" | "schemaVersion" | "launch">,
  agentId: string,
): string {
  let built: string | null = null;
  const earlier = (at: string) => {
    if (built === null || Date.parse(at) < Date.parse(built)) built = at;
  };
  for (const receipt of record.eventReceipts) {
    if (receipt.kind === "created" && receipt.agentId === agentId) earlier(receipt.receivedAt);
  }
  if (built !== null) return built;
  const rebuilds = readSeatRebuilds(record as Parameters<typeof readSeatRebuilds>[0]);
  if (rebuilds.kind === "valid") {
    for (const item of rebuilds.items) {
      if (item.toAgentId === agentId) earlier(item.requestedAt);
    }
  }
  return built ?? record.createdAt;
}

/**
 * Whether a seat has to have its history read once before this process sends it anything, even though the
 * host says it is idle (E2b). After a kill the host reads a member that is not in a turn as idle without a
 * closed receipt, so a member that never ran a turn in this Run and was made before this process began (a
 * Codex one cannot be opened: its rollout does not exist) looks fine until a send fails and the delivery is
 * left of unknown outcome for good. All three must hold: it never started a turn in this Run (`N`), its Agent
 * is older than this process, and it is not the coordinator. A seat made by this process, or one that
 * has finished a turn, is never asked for.
 */
export function needsFirstRead(
  record: Pick<RunRecord, "eventReceipts" | "createdAt" | "schemaVersion" | "launch">,
  input: { seatId: string; agentId: string; processStart: string },
): boolean {
  if (input.seatId === COORDINATOR_SEAT_ID) return false;
  if (classifySeatForReopen(record, input.agentId) !== "N") return false;
  return Date.parse(agentBuiltAt(record, input.agentId)) < Date.parse(input.processStart);
}

/** `P` and `N` are tried; `C` is left to be rebuilt. */
export function mayReopen(record: Pick<RunRecord, "eventReceipts">, agentId: string): boolean {
  return classifySeatForReopen(record, agentId) !== "C";
}

/**
 * The closed seats worth reading, best first, in the scheduler's own order (`rankCandidates`: load, quality
 * rework, frozen order, seat id). A seat is worth reading only if, once it reads idle, the scheduler would hand
 * it the work: it carries no other work, its Profile and channel are usable, nothing waits for a permission,
 * and `allows` (the caller's own gate, e.g. the family of a reviewer) agrees. `ignoreLoad` is for a
 * supplement, which goes back to the producer that already holds the task.
 */
export function reopenOrder(
  seats: readonly SeatRuntime[],
  closedSeatIds: Iterable<string>,
  options: { ignoreLoad?: boolean; allows?: (seat: SeatRuntime) => boolean } = {},
): string[] {
  const wanted = new Set(closedSeatIds);
  const ranked: SeatChoice[] = [];
  for (const seat of seats) {
    if (!wanted.has(seat.seatId) || seat.agentId === null) continue;
    if (seat.permissionPending || !seat.available || seat.channelState !== "available") continue;
    if (seat.load > 0 && options.ignoreLoad !== true) continue;
    if (options.allows?.(seat) === false) continue;
    ranked.push({
      seatId: seat.seatId,
      profileId: seat.profileId,
      load: seat.load,
      qualityRework: seat.qualityRework,
      order: seat.order,
      qualification: "reopen",
    });
  }
  return rankCandidates(ranked).map((choice) => choice.seatId);
}

/** What one automatic try is counted against: a Run, a seat and the Agent it holds. */
export function reopenKey(runId: string, seatId: string, agentId: string): string {
  return JSON.stringify([runId, seatId, agentId]);
}

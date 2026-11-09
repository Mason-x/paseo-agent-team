import { randomUUID } from "node:crypto";
import { openLimboDecision } from "../../shared/domain/run-engine/decision-answer";
import {
  AGENT_CLOSED_OUTCOME,
  agentsToCheck,
  ENGINE_SETTLER,
  findClosedTurns,
  findLostTurns,
  HOST_LOST_CODE,
  HOST_LOST_OUTCOME,
  type LostReplyRead,
  lostTurnCandidates,
  MEMBER_LOST_CODE,
  type SeatRead,
} from "../../shared/domain/run-engine/lost-turn";
import { resolveItemAlerts } from "../../shared/domain/run-engine/read-retry";
import { noteTask } from "../../shared/domain/run-engine/task-note";
import type { RunEventReceipt, RunRecord } from "../../shared/schemas/run-engine/ledger";
import { alertIdFor, sha256Hex } from "./digest";
import { appendObservation } from "./observer";
import type { ReplyWindow } from "./protocol";
import type { ReadFailure } from "./read-retry";
import type { RunStore } from "./store";

/**
 * A member's turn that Paseo cut off by closing or archiving its Agent (T4a). The host does not
 * promise a `turn_ended` for such a turn, so a Run would wait for it forever. When the ledger and the
 * host's live state together prove the session is closed and no turn is running (`findClosedTurns`),
 * the Engine records the turn as ended and opens the decision a person answers, in one commit:
 *
 *  - the receipt goes through the observer's own appender (`appendObservation`), so it is numbered and
 *    deduplicated like a host receipt, and has the key the host's would have: a `turn_ended` that comes
 *    late is a duplicate and dropped;
 *  - the decision is the limbo decision (`openLimboDecision`) with the reason `member-lost`, which a
 *    person can only answer with `cancel`.
 *
 * The same settler also settles a turn the host lost by restarting (T4b): the member is idle in Paseo,
 * the dispatch is gone from its history, and the re-checks of the reply were used up with
 * `incomplete:dispatch-not-found` at least `LOST_TURN_SETTLE_DELAY_MS` ago. A look now (a kick, a hook or
 * a recovery; there is no timer) that finds the dispatch missing again records the turn as ended with
 * `outcome: "host-lost"`, opens the ordinary limbo decision (reason `host-lost`, retry or cancel) and takes
 * down the alert of the used-up re-checks, in the same commit. It runs at the same place as the closed
 * turns, before the host is reconciled, so the receipt is the Engine's own and not an inference.
 *
 * Reads the host, never writes to it: no message, no archive. A pass that finds nothing to settle
 * writes nothing, and asks the host nothing unless a turn might have been cut off or lost.
 */

export type MemberLostOptions = {
  store: Pick<RunStore, "get" | "update">;
  /** The live state of an agent; null when the host has none. Read only. */
  readSeat(agentId: string): Promise<{ status: string; activeTurn: boolean } | null>;
  /**
   * The reply window of an agent for a message. Read only. Without it a turn the host lost (T4b) is
   * never settled.
   */
  readReply?(agentId: string, messageId: string): Promise<ReplyWindow>;
  /** Told when a read failed, so it is tried again. */
  onReadFailure?: (runId: string, failure: ReadFailure) => void | Promise<void>;
  clock?: { now(): string };
  ids?: { uuid(): string };
  log?: (message: string, detail?: unknown) => void;
};

export function createMemberLostSettler(options: MemberLostOptions) {
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const uuid = options.ids?.uuid ?? (() => randomUUID());
  const log = options.log ?? (() => undefined);

  async function readSeats(
    runId: string,
    agentIds: readonly string[],
  ): Promise<Map<string, SeatRead>> {
    const seats = new Map<string, SeatRead>();
    for (const agentId of agentIds) {
      try {
        seats.set(agentId, (await options.readSeat(agentId)) ?? "absent");
      } catch (error) {
        seats.set(agentId, "unreadable");
        log(`could not read ${agentId} to see whether it was closed`, error);
        try {
          await options.onReadFailure?.(runId, { type: "seat", agentId });
        } catch (failure) {
          log(`could not note the failed read of ${agentId}`, failure);
        }
      }
    }
    return seats;
  }

  /** The record with the closed turns settled, or null when there is nothing to settle. */
  function settleIn(
    current: RunRecord,
    seats: ReadonlyMap<string, SeatRead>,
    reads: ReadonlyMap<string, LostReplyRead>,
    now: string,
  ): { next: RunRecord; turns: number } | null {
    let next = current;
    let turns = 0;
    for (const turn of findClosedTurns(current, seats)) {
      const key = `turn_ended:${turn.agentId}:${turn.turnId}`;
      const receipt = {
        eventKey: key,
        kind: "turn_ended",
        agentId: turn.agentId,
        turnId: turn.turnId,
        dedupeKey: key,
        disposition: "observed",
        outcome: AGENT_CLOSED_OUTCOME,
        settledBy: ENGINE_SETTLER,
        basis: { ...turn.basis },
      } as Omit<RunEventReceipt, "seq" | "receivedAt">;
      const appended = appendObservation(next, receipt, now, uuid);
      if (appended.status !== "appended") continue;
      next = appended.next;
      turns += 1;
      const opened = openLimboDecision(next, {
        taskId: turn.taskId,
        assignmentId: turn.assignmentId,
        reason: MEMBER_LOST_CODE,
        turnId: turn.turnId,
        decisionId: uuid(),
        controlNonceDigest: sha256Hex(uuid()),
        now,
      });
      if (opened.changed) next = opened.next;
      const noted = noteTask(next, turn.taskId, MEMBER_LOST_CODE, {
        now,
        detail: { assignmentId: turn.assignmentId },
      });
      if (noted.ok && noted.changed) next = noted.next;
    }
    // A turn the host lost, on the record the closed turns left: one that was just settled has its
    // receipt now and is not found again.
    for (const turn of findLostTurns(next, seats, reads, now)) {
      const key = `turn_ended:${turn.agentId}:${turn.turnId}`;
      const receipt = {
        eventKey: key,
        kind: "turn_ended",
        agentId: turn.agentId,
        turnId: turn.turnId,
        dedupeKey: key,
        disposition: "observed",
        outcome: HOST_LOST_OUTCOME,
        settledBy: ENGINE_SETTLER,
        basis: { ...turn.basis },
      } as Omit<RunEventReceipt, "seq" | "receivedAt">;
      const appended = appendObservation(next, receipt, now, uuid);
      if (appended.status !== "appended") continue;
      // The receipt and the decision go together or not at all: a turn that cannot be given a decision
      // (its task moved on) is left as it is.
      const opened = openLimboDecision(appended.next, {
        taskId: turn.taskId,
        assignmentId: turn.assignmentId,
        reason: HOST_LOST_CODE,
        turnId: turn.turnId,
        decisionId: uuid(),
        controlNonceDigest: sha256Hex(uuid()),
        now,
      });
      if (!opened.changed) continue;
      next = resolveItemAlerts(opened.next, turn.item, now, alertIdFor);
      turns += 1;
      const noted = noteTask(next, turn.taskId, HOST_LOST_CODE, {
        now,
        detail: { assignmentId: turn.assignmentId },
      });
      if (noted.ok && noted.changed) next = noted.next;
    }
    return turns === 0 ? null : { next, turns };
  }

  return {
    /** Settles the turns of one Run that were closed under their member. Never throws. */
    async settle(runId: string): Promise<{ settled: number }> {
      try {
        const read = await options.store.get(runId);
        if (read.status !== "ok") return { settled: 0 };
        const lifecycle = read.record.lifecycle;
        if (lifecycle === "finished" || lifecycle === "cancelled") return { settled: 0 };
        const lostCandidates =
          options.readReply === undefined ? [] : lostTurnCandidates(read.record, clock.now());
        const agents = [
          ...new Set([
            ...agentsToCheck(read.record),
            ...lostCandidates.map((candidate) => candidate.assignment.agentId),
          ]),
        ].sort();
        if (agents.length === 0) return { settled: 0 };
        const seats = await readSeats(runId, agents);
        // Only a member the host reads as idle is asked for the reply again: any other reading settles
        // nothing, so it costs nothing.
        const reads = new Map<string, LostReplyRead>();
        for (const candidate of lostCandidates) {
          const seat = seats.get(candidate.assignment.agentId);
          if (seat === undefined || typeof seat !== "object" || seat.status !== "idle") continue;
          try {
            const window = await options.readReply?.(
              candidate.assignment.agentId,
              candidate.anchorMessageId,
            );
            if (window === undefined) continue;
            reads.set(candidate.assignment.assignmentId, {
              dispatchNotFound: !window.complete && window.reason === "dispatch-not-found",
              at: clock.now(),
            });
          } catch (error) {
            log(`could not read the reply of ${candidate.assignment.agentId} again`, error);
          }
        }
        let settled = 0;
        await options.store.update(runId, (current) => {
          if (current.lifecycle === "finished" || current.lifecycle === "cancelled") return null;
          // The host was read against the record as it was. A receipt that came in since (a turn that
          // ended, or began again) may change the answer, and the hook that recorded it runs another
          // pass: settle nothing on a read that may be out of date.
          if (current.counters.observationSeq !== read.record.counters.observationSeq) return null;
          const result = settleIn(current, seats, reads, clock.now());
          if (result === null) return null;
          settled = result.turns;
          return result.next;
        });
        return { settled };
      } catch (error) {
        log(`could not settle the closed members of ${runId}`, error);
        return { settled: 0 };
      }
    },
  };
}

export type MemberLostSettler = ReturnType<typeof createMemberLostSettler>;

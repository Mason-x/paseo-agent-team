import { randomUUID } from "node:crypto";
import { cancelPending } from "../../shared/domain/run-engine/cancel-request";
import { openLimboDecision } from "../../shared/domain/run-engine/decision-answer";
import {
  AGENT_CLOSED_OUTCOME,
  agentsToCheck,
  type ClosedTurnRef,
  closedSince,
  closedTurnCandidates,
  ENGINE_SETTLER,
  findLostReplies,
  findLostTurns,
  HOST_LOST_CODE,
  HOST_LOST_OUTCOME,
  type LostReplyRead,
  lostReplyCandidates,
  lostReplyKind,
  lostTurnCandidates,
  MEMBER_LOST_CODE,
  noTurnRunning,
  planClosedTurns,
  reopensBeforeLost,
  type SeatRead,
} from "../../shared/domain/run-engine/lost-turn";
import { resolveItemAlerts } from "../../shared/domain/run-engine/read-retry";
import { raiseAlert, resolveAlerts } from "../../shared/domain/run-engine/run-alert";
import {
  CLOSING_TURN_ALERT,
  CLOSING_TURN_ALERT_PREFIX,
} from "../../shared/domain/run-engine/seat-closed";
import { noteTask } from "../../shared/domain/run-engine/task-note";
import { receiptOccurrence, turnKey } from "../../shared/domain/run-engine/turn-occurrence";
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
 * A third kind (T9b) is a reply the host lost after it had reported the turn's end (a forced archive, the
 * cascade of archiving the coordinator, a daemon stop): there is no receipt to write, only the decision
 * (`member-lost` when the member reads as closed or was archived; else `host-lost` for a producer's own
 * task turn or a reviewer, a `closed` receipt alone does not change that) and the alert coming down
 * (`findLostReplies`); the reply of that attempt is never taken in afterwards (the intake's gate).
 *
 * A producer's task turn or a reviewer's turn whose member is only closed (not archived, not gone from the
 * host) is not settled at once (T11e). A restart leaves every member closed and reading its history opens it
 * again, so the first look that sees such a member closed reads its history once (a failed read is
 * remembered and not repeated until a person asks to check) and raises a warning; the first look at least
 * `CLOSED_TURN_WAIT_MS` after the member was first seen closed (the host's `closed` receipt, else the first
 * look, kept in memory only) settles the turn: `host-lost` (retry or cancel) when the member reads idle
 * with no turn running, else `member-lost` as before with the host's own error in the task note. A member
 * with a turn running at that time is left alone. The warning is taken down in the commit that settles.
 *
 * While the whole Run is being cancelled (A5) both kinds are recorded as ended but open no decision: the
 * receipt is what lets the cancellation finish, and a decision would outlive the Run with nobody able
 * to answer it.
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
  /**
   * Reads a closed member's history to bring it back (`reopenByReading`). Sends nothing. Throws when the
   * read fails or takes too long. Without it a closed member is never reopened.
   */
  reopenSeat?(agentId: string): Promise<"idle" | "busy" | "closed">;
  /** The agents held while their turn waits to be settled; the host reads of those answer `turn-open`. */
  watch?: ClosingWatch;
  clock?: { now(): string };
  ids?: { uuid(): string };
  log?: (message: string, detail?: unknown) => void;
};

/**
 * Which agents the Engine is holding right now (T11e), by Run. In memory only: a restart loses it and the
 * next look holds them again. `holds` is what the host reads ask.
 */
export function createClosingWatch() {
  const byRun = new Map<string, Set<string>>();
  return {
    holds(agentId: string): boolean {
      for (const agents of byRun.values()) if (agents.has(agentId)) return true;
      return false;
    },
    set(runId: string, agentIds: Iterable<string>): void {
      const agents = new Set(agentIds);
      if (agents.size === 0) byRun.delete(runId);
      else byRun.set(runId, agents);
    },
    release(agentId: string): void {
      for (const agents of byRun.values()) agents.delete(agentId);
    },
  };
}

export type ClosingWatch = ReturnType<typeof createClosingWatch>;

const MAX_HOST_ERROR = 400;

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, MAX_HOST_ERROR);
}

export function createMemberLostSettler(options: MemberLostOptions) {
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const uuid = options.ids?.uuid ?? (() => randomUUID());
  const log = options.log ?? (() => undefined);
  const watch = options.watch ?? createClosingWatch();
  /** When this process first saw the member of a cut-off turn closed, by (Run, assignment, turn). */
  const seen = new Map<string, string>();
  /** The members this process has read the history of to reopen them, by (Run, agent). */
  const reopenTried = new Set<string>();
  /** What the host said when that read failed, by the same key. */
  const hostErrors = new Map<string, string>();
  const chains = new Map<string, Promise<unknown>>();

  const seenKey = (runId: string, ref: ClosedTurnRef) =>
    JSON.stringify([runId, ref.assignmentId, ref.turnId, ref.occurrence]);
  const agentKey = (runId: string, agentId: string) => JSON.stringify([runId, agentId]);

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

  /**
   * The record with the closed turns settled, and the agents whose turn still waits. `next` is null when
   * nothing was written.
   */
  function settleIn(
    current: RunRecord,
    seats: ReadonlyMap<string, SeatRead>,
    reads: ReadonlyMap<string, LostReplyRead>,
    now: string,
  ): { next: RunRecord | null; turns: number; waiting: string[] } {
    let next = current;
    let turns = 0;
    const cancelling = cancelPending(current);
    const runId = current.runId;
    const plan = planClosedTurns(current, seats, {
      now,
      cancelling,
      seenAt: (ref) => seen.get(seenKey(runId, ref)) ?? null,
    });
    // A member that is closed but may come back: the turn waits, and says so.
    const hasAlert = current.alerts.some(
      (alert) => alert.state !== "resolved" && alert.summary.startsWith(CLOSING_TURN_ALERT_PREFIX),
    );
    let alertChanged = false;
    if (plan.waiting.length > 0) {
      const raised = raiseAlert(
        next,
        {
          alertId: alertIdFor(CLOSING_TURN_ALERT_PREFIX),
          severity: "warning",
          summary: CLOSING_TURN_ALERT,
        },
        now,
      );
      if (raised.changed) {
        next = raised.next;
        alertChanged = true;
      }
    }
    // The member reads idle again after the wait: the turn was lost with the restart (`host-lost`).
    for (const turn of plan.hostLost) {
      const key =
        turnKey("turn_ended", turn.agentId, turn.turnId, turn.occurrence) ??
        `turn_ended:${turn.agentId}:${turn.turnId}`;
      const receipt = {
        eventKey: key,
        kind: "turn_ended",
        agentId: turn.agentId,
        turnId: turn.turnId,
        dedupeKey: key,
        disposition: "observed",
        outcome: HOST_LOST_OUTCOME,
        settledBy: ENGINE_SETTLER,
        basis: { ...turn.basis, seatStatus: "idle" },
      } as Omit<RunEventReceipt, "seq" | "receivedAt">;
      const appended = appendObservation(next, receipt, now, uuid);
      if (appended.status !== "appended") continue;
      // The receipt and the decision go together or not at all.
      const opened = openLimboDecision(appended.next, {
        taskId: turn.taskId,
        assignmentId: turn.assignmentId,
        reason: HOST_LOST_CODE,
        turnId: turn.turnId,
        endedEventKey: key,
        decisionId: uuid(),
        controlNonceDigest: sha256Hex(uuid()),
        now,
      });
      if (!opened.changed) continue;
      next = opened.next;
      turns += 1;
      const noted = noteTask(next, turn.taskId, HOST_LOST_CODE, {
        now,
        detail: { assignmentId: turn.assignmentId },
      });
      if (noted.ok && noted.changed) next = noted.next;
    }
    for (const turn of plan.lost) {
      const key =
        turnKey("turn_ended", turn.agentId, turn.turnId, turn.occurrence) ??
        `turn_ended:${turn.agentId}:${turn.turnId}`;
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
      // The whole Run is being cancelled: the receipt is what lets the cancellation finish, and no
      // decision is opened, for none could be answered once the Run is cancelled.
      if (cancelling) continue;
      const opened = openLimboDecision(next, {
        taskId: turn.taskId,
        assignmentId: turn.assignmentId,
        reason: MEMBER_LOST_CODE,
        turnId: turn.turnId,
        endedEventKey: key,
        decisionId: uuid(),
        controlNonceDigest: sha256Hex(uuid()),
        now,
      });
      if (opened.changed) next = opened.next;
      const hostError = hostErrors.get(agentKey(runId, turn.agentId));
      const noted = noteTask(next, turn.taskId, MEMBER_LOST_CODE, {
        now,
        detail: {
          assignmentId: turn.assignmentId,
          ...(hostError === undefined ? {} : { hostError }),
        },
      });
      if (noted.ok && noted.changed) next = noted.next;
    }
    // Nothing waits any more: the warning comes down, in this commit.
    if (plan.waiting.length === 0 && hasAlert) {
      const resolved = resolveAlerts(
        next,
        (alert) => alert.summary.startsWith(CLOSING_TURN_ALERT_PREFIX),
        now,
      );
      if (resolved.changed) {
        next = resolved.next;
        alertChanged = true;
      }
    }
    // A turn the host lost, on the record the closed turns left: one that was just settled has its
    // receipt now and is not found again.
    for (const turn of findLostTurns(next, seats, reads, now)) {
      const key =
        turnKey("turn_ended", turn.agentId, turn.turnId, turn.occurrence) ??
        `turn_ended:${turn.agentId}:${turn.turnId}`;
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
      if (cancelling) {
        // The whole Run is being cancelled: the receipt lets the cancellation finish (A5 waits for
        // it) and the alert of the used-up re-check goes, but no decision is opened for a Run that
        // is about to be cancelled, for it could never be answered.
        next = resolveItemAlerts(appended.next, turn.item, now, alertIdFor);
        turns += 1;
        continue;
      }
      // The receipt and the decision go together or not at all: a turn that cannot be given a decision
      // (its task moved on) is left as it is.
      const opened = openLimboDecision(appended.next, {
        taskId: turn.taskId,
        assignmentId: turn.assignmentId,
        reason: HOST_LOST_CODE,
        turnId: turn.turnId,
        endedEventKey: key,
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
    // A reply the host lost after it had said the turn ended (T9b): no receipt (the host's own end is on
    // the ledger), only the decision and the alert coming down. While the whole Run is being cancelled
    // nothing is opened: the cancellation takes the host's end as it is.
    if (!cancelling) {
      for (const lost of findLostReplies(next, seats, reads, now)) {
        const opened = openLimboDecision(next, {
          taskId: lost.taskId,
          assignmentId: lost.assignmentId,
          reason: lost.kind,
          turnId: lost.turnId,
          endedEventKey: lost.endedEventKey,
          replyLost: true,
          decisionId: uuid(),
          controlNonceDigest: sha256Hex(uuid()),
          now,
        });
        // A turn that cannot be given a decision (its task moved on) is left as it is, alert included.
        if (!opened.changed) continue;
        next = resolveItemAlerts(opened.next, lost.item, now, alertIdFor);
        turns += 1;
        const noted = noteTask(next, lost.taskId, lost.kind, {
          now,
          detail: { assignmentId: lost.assignmentId },
        });
        if (noted.ok && noted.changed) next = noted.next;
      }
    }
    return {
      next: turns === 0 && !alertChanged ? null : next,
      turns,
      waiting: [...new Set(plan.waiting.map((turn) => turn.agentId))].sort(),
    };
  }

  /**
   * Notes which cut-off turns have a member that is closed, and reads the history of each such member once
   * to reopen it. `seats` is updated with what the member reads like afterwards.
   */
  async function tryReopen(
    runId: string,
    record: RunRecord,
    seats: Map<string, SeatRead>,
  ): Promise<void> {
    const now = clock.now();
    const present = new Set<string>();
    const agents = new Set<string>();
    for (const { assignment, started, closed } of closedTurnCandidates(record)) {
      if (!reopensBeforeLost(record, assignment) || started.turnId === null) continue;
      const ref: ClosedTurnRef = {
        assignmentId: assignment.assignmentId,
        agentId: assignment.agentId,
        turnId: started.turnId,
        occurrence: receiptOccurrence(started),
      };
      const key = seenKey(runId, ref);
      present.add(key);
      agents.add(assignment.agentId);
      const seat = seats.get(assignment.agentId);
      if (
        !noTurnRunning(seat) ||
        seat === undefined ||
        seat === "absent" ||
        seat === "unreadable"
      ) {
        continue;
      }
      if (closedSince(record, ref.agentId, ref.turnId, ref.occurrence, ["archived"])) continue;
      const closedNow = closed !== null || seat.status === "closed" || seen.has(key);
      if (!closedNow) continue;
      if (!seen.has(key)) seen.set(key, now);
      if (seat.status !== "closed" || options.reopenSeat === undefined) continue;
      const tried = agentKey(runId, assignment.agentId);
      if (reopenTried.has(tried)) continue;
      reopenTried.add(tried);
      try {
        const reading = await options.reopenSeat(assignment.agentId);
        hostErrors.delete(tried);
        log(`read the history of the closed member ${assignment.agentId} of ${runId}: ${reading}`);
      } catch (error) {
        hostErrors.set(tried, errorText(error));
        log(`could not reopen the closed member ${assignment.agentId} of ${runId}`, error);
      }
      // What it reads like now. A look that fails leaves the reading as it was.
      const again = (await readSeats(runId, [assignment.agentId])).get(assignment.agentId);
      if (again !== undefined && again !== "unreadable") seats.set(assignment.agentId, again);
    }
    // What this process remembers about turns and members that are no longer cut off is dropped.
    for (const key of [...seen.keys()]) {
      if ((JSON.parse(key) as string[])[0] === runId && !present.has(key)) seen.delete(key);
    }
    for (const key of [...reopenTried, ...hostErrors.keys()]) {
      const [run, agent] = JSON.parse(key) as string[];
      if (run === runId && agent !== undefined && !agents.has(agent)) {
        reopenTried.delete(key);
        hostErrors.delete(key);
      }
    }
  }

  async function settleOnce(runId: string): Promise<{ settled: number }> {
    try {
      const read = await options.store.get(runId);
      if (read.status !== "ok") return { settled: 0 };
      const lifecycle = read.record.lifecycle;
      if (lifecycle === "finished" || lifecycle === "cancelled") return { settled: 0 };
      const lostCandidates =
        options.readReply === undefined ? [] : lostTurnCandidates(read.record, clock.now());
      // Replies lost after the host said the turn ended (T9b). Not while the Run is being cancelled: this
      // check only saves the host reads; the check inside the update below is the one that decides, and
      // it also covers a cancellation asked for between these reads and the commit.
      const replyCandidates =
        options.readReply === undefined || cancelPending(read.record)
          ? []
          : lostReplyCandidates(read.record, clock.now());
      const agents = [
        ...new Set([
          ...agentsToCheck(read.record),
          ...lostCandidates.map((candidate) => candidate.assignment.agentId),
          ...replyCandidates.map((candidate) => candidate.assignment.agentId),
        ]),
      ].sort();
      const warned = read.record.alerts.some(
        (alert) =>
          alert.state !== "resolved" && alert.summary.startsWith(CLOSING_TURN_ALERT_PREFIX),
      );
      if (agents.length === 0 && !warned) {
        watch.set(runId, []);
        await tryReopen(runId, read.record, new Map());
        return { settled: 0 };
      }
      const seats = await readSeats(runId, agents);
      if (!cancelPending(read.record)) await tryReopen(runId, read.record, seats);
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
      // The same for a lost reply: a member that is idle or closed, and only when a decision could be
      // opened for it on this read.
      for (const candidate of replyCandidates) {
        const seat = seats.get(candidate.assignment.agentId);
        if (lostReplyKind(read.record, candidate.assignment, seat) === null) continue;
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
      const held: { agents: string[] | null } = { agents: null };
      await options.store.update(runId, (current) => {
        if (current.lifecycle === "finished" || current.lifecycle === "cancelled") return null;
        // The host was read against the record as it was. A receipt that came in since (a turn that
        // ended, or began again) may change the answer, and the hook that recorded it runs another
        // pass: settle nothing on a read that may be out of date.
        if (current.counters.observationSeq !== read.record.counters.observationSeq) return null;
        const result = settleIn(current, seats, reads, clock.now());
        held.agents = result.waiting;
        settled = result.turns;
        return result.next;
      });
      if (held.agents !== null) watch.set(runId, held.agents);
      return { settled };
    } catch (error) {
      log(`could not settle the closed members of ${runId}`, error);
      return { settled: 0 };
    }
  }

  return {
    /** Settles the turns of one Run that were closed under their member. Never throws. */
    settle(runId: string): Promise<{ settled: number }> {
      const previous = chains.get(runId) ?? Promise.resolve();
      const run = previous.catch(() => undefined).then(() => settleOnce(runId));
      chains.set(
        runId,
        run.catch(() => undefined),
      );
      return run;
    },

    /** A person's "check now": each closed member of the Run may have its history read once more. */
    grantReopen(runId: string): void {
      for (const key of [...reopenTried]) {
        if ((JSON.parse(key) as string[])[0] === runId) reopenTried.delete(key);
      }
    },

    /** Whether the host reads of this agent are held back (its cut-off turn waits to be settled). */
    holds: (agentId: string): boolean => watch.holds(agentId),

    /** The agent started or ended a turn: it is not waiting on a cut-off turn any more. */
    release: (agentId: string): void => watch.release(agentId),
  };
}

export type MemberLostSettler = ReturnType<typeof createMemberLostSettler>;

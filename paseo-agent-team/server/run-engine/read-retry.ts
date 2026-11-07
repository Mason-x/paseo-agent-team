import {
  beginTries,
  finishTries,
  hasInterruptedTry,
  nextDueMs,
  noteReadFailure,
  type ObservedRun,
  type ReadRetryTarget,
  type StartedTry,
  sweepReadRetries,
  type TryOutcome,
} from "../../shared/domain/run-engine/read-retry";
import { alertIdFor, sha256Hex } from "./digest";
import type { ReplyWindow } from "./protocol";
import type { RunStore } from "./store";

/**
 * Runs the read-only re-checks that `shared/domain/run-engine/read-retry.ts` keeps on the ledger.
 *
 * It holds two functions that read (the reply window of an agent, the live state of a seat) and no
 * function that writes to a host: it cannot send, create, archive, answer a permission, settle a report
 * or dispatch, so nothing it does can cost a model call. When nothing is waiting there is no timer.
 *
 * One timer, set for the earliest due time. The due times are timestamps on the ledger, so the timer is
 * only a wake-up: it is set again from the ledger after a restart, it never fires early after the clock
 * went back (the wait is worked out from the clock each time, in pieces of at most 30 seconds), and a
 * clock that jumped forward finds everything that is due and gives each item one try, not a catch-up.
 */

export type ReadFailure =
  | { type: "seat"; agentId: string }
  | {
      type: "reply";
      agentId: string;
      taskId: string;
      assignmentId: string;
      anchorMessageId: string;
    };

export type ReadRetryOptions = {
  store: Pick<RunStore, "get" | "update" | "list">;
  /** Reads the reply window of an agent for a message. Read only. */
  readReply(agentId: string, messageId: string): Promise<ReplyWindow>;
  /** Reads the live state of an agent; throws when it cannot. Read only. */
  readSeat(agentId: string): Promise<void>;
  clock?: { now(): string };
  /** Runs `run` after `ms`; returns what cancels it. Defaults to `setTimeout`. */
  schedule?: (run: () => void, ms: number) => () => void;
  log?: (message: string, detail?: unknown) => void;
};

/** The longest one wait is: a clock that changed is noticed within this long. */
const MAX_WAIT_MS = 30_000;
const MIN_WAIT_MS = 25;
/** How long a Run whose tries could not be recorded is left alone before it is looked at again. */
const ERROR_BACKOFF_MS = 5_000;

function errorCode(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[\w.:-]{1,64}$/u.test(code)) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && /^[\w.:-]{1,64}$/u.test(name)) return name;
  }
  return "read-error";
}

function sourceOf(dagRevision: number, failure: ReadFailure): string {
  return failure.type === "seat"
    ? `seat|${dagRevision}|${failure.agentId}`
    : `reply|${dagRevision}|${failure.assignmentId}|${failure.anchorMessageId}`;
}

export function createReadRetry(options: ReadRetryOptions) {
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const log = options.log ?? (() => undefined);
  const schedule =
    options.schedule ??
    ((run: () => void, ms: number) => {
      const timer = setTimeout(run, ms);
      // A pending re-check must not keep a stopping process alive.
      timer.unref?.();
      return () => clearTimeout(timer);
    });
  /** When each Run next has a try due, in milliseconds. */
  const due = new Map<string, number>();
  /** The items that failed since the last pass of their Run. */
  const noted = new Map<string, Set<string>>();
  const chains = new Map<string, Promise<unknown>>();
  let cancelTimer: (() => void) | null = null;
  let closed = false;
  let firing = false;

  const nowMs = () => Date.parse(clock.now());

  function track(runId: string, record: ObservedRun): void {
    const at = hasInterruptedTry(record) ? nowMs() : nextDueMs(record);
    if (at === null) due.delete(runId);
    else due.set(runId, at);
  }

  function arm(): void {
    cancelTimer?.();
    cancelTimer = null;
    if (closed || due.size === 0) return;
    const earliest = Math.min(...due.values());
    const wait = Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, earliest - nowMs()));
    cancelTimer = schedule(() => void fire(), wait);
  }

  function exclusive<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const previous = chains.get(runId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    chains.set(
      runId,
      run.catch(() => undefined),
    );
    return run;
  }

  async function tryOne(started: StartedTry): Promise<TryOutcome> {
    const { key, generation, target } = started;
    try {
      if (target.type === "seat") {
        await options.readSeat(target.agentId);
        return { key, generation, ok: true, observedAt: clock.now() };
      }
      const window = await options.readReply(target.agentId, target.anchorMessageId);
      if (!window.complete) {
        return { key, generation, ok: false, code: `incomplete:${window.reason}` };
      }
      return { key, generation, ok: true, observedAt: clock.now(), turnId: window.turnId };
    } catch (error) {
      return { key, generation, ok: false, code: errorCode(error) };
    }
  }

  async function processRun(runId: string): Promise<void> {
    try {
      let started: StartedTry[] = [];
      // 1. Count the tries before any read: a process that stops now has still used them.
      const begun = await options.store.update(runId, (current) => {
        const result = beginTries(current, clock.now(), alertIdFor);
        started = result.started;
        return result.change.changed ? result.change.next : null;
      });
      track(runId, begun.record);
      if (started.length === 0) return;
      // 2. Read, outside the ledger. Nothing here writes to a host.
      const outcomes: TryOutcome[] = [];
      for (const one of started) {
        if (closed) return;
        outcomes.push(await tryOne(one));
      }
      // 3. Record what the reads found. A reply that was read gets the receipt that is already on the
      //    ledger for its turn, never a new one.
      const ended = await options.store.update(runId, (current) => {
        const withReceipts = outcomes.map((outcome) => {
          if (!outcome.ok || outcome.turnId === undefined) return outcome;
          const item = started.find((entry) => entry.key === outcome.key);
          const agentId = item?.target.agentId;
          const receipt = current.eventReceipts.find(
            (entry) =>
              entry.kind === "turn_ended" &&
              entry.agentId === agentId &&
              entry.turnId === outcome.turnId,
          );
          return receipt ? { ...outcome, receiptKey: receipt.eventKey } : outcome;
        });
        const result = finishTries(current, withReceipts, clock.now(), alertIdFor);
        return result.changed ? result.next : null;
      });
      track(runId, ended.record);
    } catch (error) {
      log(`read re-check of ${runId} could not be recorded`, error);
      due.set(runId, nowMs() + ERROR_BACKOFF_MS);
    }
  }

  async function fire(): Promise<void> {
    cancelTimer?.();
    cancelTimer = null;
    if (closed || firing) return;
    firing = true;
    try {
      const now = nowMs();
      for (const [runId, at] of [...due]) {
        if (closed) break;
        if (at <= now) await exclusive(runId, () => processRun(runId));
      }
    } finally {
      firing = false;
      arm();
    }
  }

  return {
    /**
     * A host read failed with an error. Writes down that it should be read again, unless this Run
     * is not given retries. Never throws: a failed note must not break the work that failed to read.
     */
    async note(runId: string, failure: ReadFailure): Promise<void> {
      if (closed) return;
      try {
        let key = "";
        const result = await options.store.update(runId, (current) => {
          const sourceKey = sourceOf(current.dagRevision, failure);
          key = `rr-${sha256Hex(sourceKey).slice(0, 24)}`;
          const target: ReadRetryTarget =
            failure.type === "seat"
              ? { type: "seat", agentId: failure.agentId }
              : {
                  type: "reply",
                  agentId: failure.agentId,
                  taskId: failure.taskId,
                  assignmentId: failure.assignmentId,
                  anchorMessageId: failure.anchorMessageId,
                };
          const noted = noteReadFailure(current, { key, sourceKey, target }, clock.now());
          return noted.changed ? noted.next : null;
        });
        const keys = noted.get(runId) ?? new Set<string>();
        keys.add(key);
        noted.set(runId, keys);
        track(runId, result.record);
        arm();
      } catch (error) {
        log(`could not note a failed read for ${runId}`, error);
      }
    },

    /**
     * Called when a pass of a Run is over: takes down the alerts of items that no longer matter. A
     * reply that was waited for and has been taken in ends its alert; so does a pass in which the same
     * seat read did not fail again.
     */
    async sweep(runId: string): Promise<void> {
      const keys = noted.get(runId) ?? new Set<string>();
      noted.delete(runId);
      try {
        await options.store.update(runId, (current) => {
          const result = sweepReadRetries(current, keys, clock.now(), alertIdFor);
          return result.changed ? result.next : null;
        });
      } catch (error) {
        log(`could not sweep read re-checks of ${runId}`, error);
      }
    },

    /** Looks at every Run on the ledger and sets the timer from what is due. Safe to call again. */
    async start(): Promise<void> {
      if (closed) return;
      try {
        const listed = await options.store.list();
        for (const entry of listed.entries) {
          if (entry.lifecycle === "finished" || entry.lifecycle === "cancelled") {
            due.delete(entry.runId);
            continue;
          }
          const read = await options.store.get(entry.runId);
          if (read.status === "ok") track(entry.runId, read.record);
        }
      } catch (error) {
        log("could not read the ledger for read re-checks", error);
      }
      arm();
    },

    /** Stops the timer and waits for a try that is running. Tries cut off here count as used. */
    async dispose(): Promise<void> {
      closed = true;
      cancelTimer?.();
      cancelTimer = null;
      await Promise.allSettled([...chains.values()]);
    },

    /** For tests and diagnostics: whether a timer is set, and for how many Runs a try is due. */
    get armed(): boolean {
      return cancelTimer !== null;
    },
    get pendingRuns(): number {
      return due.size;
    },
    /** Runs what is due now, as the timer would. */
    fire,
  };
}

export type ReadRetry = ReturnType<typeof createReadRetry>;

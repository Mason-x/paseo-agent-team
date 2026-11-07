/**
 * A steady poll with two rules the page needs:
 *
 *  - It asks once right away and then every `intervalMs`, but never while an earlier ask has not
 *    answered. A slow host therefore costs a skipped beat, not a pile of overlapping reads.
 *  - It can be stopped and started again (a page that is not in front stops asking, and asks again
 *    at once when it comes back). A stopped poller never fires, and an ask that was in flight when it
 *    stopped is not waited for.
 *
 * Timers are injected so the rules are testable without a clock.
 */

export type PollTimers = {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

const REAL_TIMERS: PollTimers = {
  set: (callback, ms) => setInterval(callback, ms),
  clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export function createPoller(options: {
  intervalMs: number;
  tick: () => Promise<void> | void;
  timers?: PollTimers;
}) {
  const timers = options.timers ?? REAL_TIMERS;
  let handle: unknown = null;
  let busy = false;
  let generation = 0;

  async function ask(): Promise<void> {
    if (busy) return;
    busy = true;
    const mine = generation;
    try {
      await options.tick();
    } catch {
      // The tick reports its own errors; a failed ask must not stop the poll.
    } finally {
      // A stop (and start) that happened meanwhile owns `busy` now.
      if (mine === generation) busy = false;
    }
  }

  return {
    get running(): boolean {
      return handle !== null;
    },
    /** Asks now, then on every beat. Starting a running poller does nothing. */
    start(): void {
      if (handle !== null) return;
      generation += 1;
      busy = false;
      void ask();
      handle = timers.set(() => void ask(), options.intervalMs);
    },
    stop(): void {
      if (handle === null) return;
      timers.clear(handle);
      handle = null;
      generation += 1;
      busy = false;
    },
  };
}

export type Poller = ReturnType<typeof createPoller>;

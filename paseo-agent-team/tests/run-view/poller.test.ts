import { describe, expect, test, vi } from "vitest";

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
}));

import { createPoller, type PollTimers } from "../../client/runs/engine/poller";
import { isVisibleAppState } from "../../client/shared/use-page-visible";

/** A clock the test turns by hand. */
function fakeTimers() {
  const beats = new Map<number, () => void>();
  let next = 1;
  const timers: PollTimers = {
    set: (callback) => {
      const handle = next++;
      beats.set(handle, callback);
      return handle;
    },
    clear: (handle) => {
      beats.delete(handle as number);
    },
  };
  return {
    timers,
    beat: () => {
      for (const callback of [...beats.values()]) callback();
    },
    get active() {
      return beats.size;
    },
  };
}

/** A tick the test finishes by hand. */
function slowTick() {
  const pending: Array<() => void> = [];
  let calls = 0;
  return {
    tick: () => {
      calls += 1;
      return new Promise<void>((resolve) => pending.push(resolve));
    },
    finish: async () => {
      for (const resolve of pending.splice(0)) resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    /** Answers only the oldest ask still out. */
    finishOldest: async () => {
      pending.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    },
    get calls() {
      return calls;
    },
  };
}

describe("createPoller", () => {
  test("asks at once, then on every beat once the last ask has answered", async () => {
    const clock = fakeTimers();
    const tick = slowTick();
    const poller = createPoller({ intervalMs: 5000, tick: tick.tick, timers: clock.timers });
    poller.start();
    expect(tick.calls).toBe(1);
    await tick.finish();
    clock.beat();
    expect(tick.calls).toBe(2);
    await tick.finish();
    clock.beat();
    clock.beat();
    // The third ask is in flight, so the fourth beat is skipped.
    expect(tick.calls).toBe(3);
    poller.stop();
  });

  test("a beat while an ask has not answered is skipped, not queued", async () => {
    const clock = fakeTimers();
    const tick = slowTick();
    const poller = createPoller({ intervalMs: 5000, tick: tick.tick, timers: clock.timers });
    poller.start();
    clock.beat();
    clock.beat();
    clock.beat();
    expect(tick.calls).toBe(1);
    await tick.finish();
    clock.beat();
    expect(tick.calls).toBe(2);
    poller.stop();
  });

  test("a failed ask does not stop the poll", async () => {
    const clock = fakeTimers();
    let calls = 0;
    const poller = createPoller({
      intervalMs: 5000,
      tick: async () => {
        calls += 1;
        throw new Error("host down");
      },
      timers: clock.timers,
    });
    poller.start();
    await Promise.resolve();
    await Promise.resolve();
    clock.beat();
    await Promise.resolve();
    expect(calls).toBe(2);
    expect(poller.running).toBe(true);
    poller.stop();
  });

  test("stopped, it never fires again, and starting it again asks at once", () => {
    const clock = fakeTimers();
    const tick = slowTick();
    const poller = createPoller({ intervalMs: 5000, tick: tick.tick, timers: clock.timers });
    poller.start();
    expect(poller.running).toBe(true);
    poller.stop();
    expect(poller.running).toBe(false);
    expect(clock.active).toBe(0);
    clock.beat();
    expect(tick.calls).toBe(1);

    poller.start();
    expect(tick.calls).toBe(2);
    expect(clock.active).toBe(1);
    poller.stop();
  });

  test("an ask that was in flight when it stopped does not block the next start", async () => {
    const clock = fakeTimers();
    const tick = slowTick();
    const poller = createPoller({ intervalMs: 5000, tick: tick.tick, timers: clock.timers });
    poller.start();
    poller.stop();
    poller.start();
    // Two asks are out. The old one answering late must not make the new one look finished.
    expect(tick.calls).toBe(2);
    await tick.finishOldest();
    clock.beat();
    expect(tick.calls).toBe(2);
    // Once the new one answers, the next beat asks again.
    await tick.finish();
    clock.beat();
    expect(tick.calls).toBe(3);
    poller.stop();
  });

  test("starting a running poller, or stopping a stopped one, does nothing", () => {
    const clock = fakeTimers();
    const tick = slowTick();
    const poller = createPoller({ intervalMs: 5000, tick: tick.tick, timers: clock.timers });
    poller.stop();
    poller.start();
    poller.start();
    expect(tick.calls).toBe(1);
    expect(clock.active).toBe(1);
    poller.stop();
    poller.stop();
    expect(clock.active).toBe(0);
  });
});

describe("the page is in front", () => {
  test("everything but the background and inactive states counts as in front", () => {
    expect(isVisibleAppState("active")).toBe(true);
    expect(isVisibleAppState(undefined)).toBe(true);
    expect(isVisibleAppState(null)).toBe(true);
    expect(isVisibleAppState("background")).toBe(false);
    expect(isVisibleAppState("inactive")).toBe(false);
  });
});

import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { alertIdFor } from "../../server/run-engine/digest";
import { createRunObserver } from "../../server/run-engine/observer";
import type { ReplyWindow } from "../../server/run-engine/protocol";
import { createReadRetry, type ReadFailure } from "../../server/run-engine/read-retry";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import {
  beginTries,
  emptyReadRetries,
  readReadRetries,
} from "../../shared/domain/run-engine/read-retry";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import {
  ASSIGNMENT_T2,
  assignmentsForRun,
  dispatchIntent,
  MESSAGE_T2,
  noncesForRun,
  withLedger,
} from "../fixtures/run-engine/base";

/**
 * The executor of the read re-checks, against a real store: the tries survive a restart, a try is
 * counted before the read, the timer exists only while something waits and never fires early, and
 * nothing it holds can write to a host. Failure modes:
 *  - a restart starting the tries over, or handing out one that was cut off;
 *  - a clock that went back making a try early, or one that jumped forward making a storm of them;
 *  - a timer left running for nothing, for a finished Run, or after the service stopped;
 *  - a used-up item being read again.
 */

const RUN_ID = "run-rtr001-a1";
const T0 = Date.parse("2026-11-08T10:00:00.000Z");

let home: string;
let store: RunStore;

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), "run-read-retry-")));
  await mkdir(path.join(home, "paseo"));
  store = createRunStore({ home: path.join(home, "paseo"), lock: { acquireTimeoutMs: 300 } });
  await store.initialize();
});

afterEach(async () => {
  await store.close().catch(() => undefined);
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function record(options: { schemaVersion?: 1 | 2; block?: boolean } = {}): RunRecord {
  const value = withLedger({
    runId: RUN_ID,
    revision: 1,
    previousDigest: "",
    assignments: assignmentsForRun(RUN_ID),
    nonceRegistry: noncesForRun(RUN_ID),
  });
  value.schemaVersion = options.schemaVersion ?? 2;
  if (options.block !== false) (value as Record<string, unknown>).readRetries = emptyReadRetries();
  return value;
}

async function stored(): Promise<RunRecord> {
  const read = await store.get(RUN_ID);
  if (read.status !== "ok") throw new Error(`run unreadable: ${read.status}`);
  return read.record;
}

const items = async () => {
  const block = readReadRetries(await stored());
  if (block.kind !== "valid") throw new Error(`block is ${block.kind}`);
  return block.items;
};

const REPLY: ReadFailure = {
  type: "reply",
  agentId: "agent-b1",
  taskId: "t2",
  assignmentId: ASSIGNMENT_T2,
  anchorMessageId: MESSAGE_T2,
};
const SEAT: ReadFailure = { type: "seat", agentId: "agent-b1" };

const complete = (turnId = "turn-9"): ReplyWindow => ({
  complete: true,
  turnId,
  text: "",
  bytes: 0,
});

/** A clock the test moves, a scheduler it can look at, and reads whose answers it chooses. */
function harness(target: RunStore = store) {
  const clock = { at: T0 };
  const timers: { ms: number; cancelled: boolean }[] = [];
  const calls = { reply: 0, seat: 0 };
  const answers: { reply: (() => Promise<ReplyWindow>)[]; seat: (() => Promise<void>)[] } = {
    reply: [],
    seat: [],
  };
  const retry = createReadRetry({
    store: target,
    clock: { now: () => new Date(clock.at).toISOString() },
    schedule: (_run, ms) => {
      const timer = { ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    readReply: async () => {
      calls.reply += 1;
      const answer = answers.reply.shift();
      if (!answer) throw new Error("the host did not answer");
      return answer();
    },
    readSeat: async () => {
      calls.seat += 1;
      const answer = answers.seat.shift();
      if (!answer) throw new Error("the host did not answer");
      return answer();
    },
  });
  const live = () => timers.filter((timer) => !timer.cancelled);
  return { retry, clock, timers, calls, answers, live };
}

describe("after a failed read", () => {
  test("it is written down, a timer is set for the first try, and nothing is read before it is due", async () => {
    await store.create(record());
    const h = harness();
    await h.retry.note(RUN_ID, REPLY);
    expect((await items())[0]).toMatchObject({ state: "waiting", attemptsStarted: 0 });
    expect(h.live().map((timer) => timer.ms)).toEqual([1000]);

    h.clock.at = T0 + 999;
    await h.retry.fire();
    expect(h.calls).toEqual({ reply: 0, seat: 0 });
    h.answers.reply.push(async () => complete());
    h.clock.at = T0 + 1000;
    await h.retry.fire();
    expect(h.calls.reply).toBe(1);
  });

  test("the same failure noted again is still one item", async () => {
    await store.create(record());
    const h = harness();
    await h.retry.note(RUN_ID, REPLY);
    await h.retry.note(RUN_ID, REPLY);
    expect(await items()).toHaveLength(1);
  });

  test("a Run that was not given retries is not written to", async () => {
    for (const options of [{ schemaVersion: 1 as const }, { block: false }]) {
      await store.close();
      await rm(path.join(home, "paseo"), { recursive: true, force: true });
      await mkdir(path.join(home, "paseo"));
      store = createRunStore({ home: path.join(home, "paseo"), lock: { acquireTimeoutMs: 300 } });
      await store.initialize();
      await store.create(record(options));
      const before = await store.get(RUN_ID);
      const h = harness();
      await h.retry.note(RUN_ID, REPLY);
      expect(await store.get(RUN_ID)).toEqual(before);
      expect(h.live()).toHaveLength(0);
    }
  });
});

describe("the tries", () => {
  test("three failures 1, 2 and 4 seconds apart use the item up; it is never read again and no timer is left", async () => {
    await store.create(record());
    const h = harness();
    await h.retry.note(RUN_ID, REPLY);
    for (const wait of [1000, 2000, 4000]) {
      h.clock.at += wait;
      await h.retry.fire();
    }
    expect(h.calls.reply).toBe(3);
    const used = (await items())[0];
    expect(used).toMatchObject({ state: "held", attemptsStarted: 3, lastCode: "Error" });
    const after = await stored();
    expect(after.alerts).toHaveLength(1);
    expect(after.alerts[0]?.summary).toContain("读取重试已用尽");

    // A day later: still three reads, and nothing is set to run.
    h.clock.at += 24 * 3_600_000;
    await h.retry.fire();
    expect(h.calls.reply).toBe(3);
    expect(h.retry.armed).toBe(false);
    expect(h.live()).toHaveLength(0);
    expect(h.retry.pendingRuns).toBe(0);
  });

  test("an incomplete window is a failed try, and carries its reason", async () => {
    await store.create(record());
    const h = harness();
    await h.retry.note(RUN_ID, REPLY);
    h.answers.reply.push(async () => ({ complete: false, reason: "turn-open" }) as ReplyWindow);
    h.clock.at += 1000;
    await h.retry.fire();
    expect((await items())[0]).toMatchObject({
      state: "waiting",
      lastCode: "incomplete:turn-open",
    });
  });

  test("a read that works again leaves one warning and changes nothing else on the Run", async () => {
    await store.create(record());
    const observer = createRunObserver({ store });
    await observer.ingest({ name: "agent.turn_ended", agentId: "agent-b1", turnId: "turn-9" });
    const h = harness();
    await h.retry.note(RUN_ID, REPLY);
    const before = await stored();
    h.answers.reply.push(async () => complete("turn-9"));
    h.clock.at += 1000;
    await h.retry.fire();

    const after = await stored();
    const [item] = await items();
    expect(item).toMatchObject({ state: "resolved", result: { turnId: "turn-9" } });
    // The receipt is the one the observer wrote, not a new one.
    expect(item?.result?.receiptKey).toBe(
      before.eventReceipts.find((entry) => entry.turnId === "turn-9")?.eventKey,
    );
    expect(after.alerts).toHaveLength(1);
    expect(after.alerts[0]?.summary).toContain("读取恢复，报告未入账，请 kick");
    expect(after.tasks).toEqual(before.tasks);
    expect(after.assignments).toEqual(before.assignments);
    expect(after.outbox).toEqual(before.outbox);
    expect(after.resources).toEqual(before.resources);
    expect(h.live()).toHaveLength(0);
  });

  test("a seat read is the same, through the seat function", async () => {
    await store.create(record());
    const h = harness();
    h.answers.seat.push(async () => undefined);
    await h.retry.note(RUN_ID, SEAT);
    h.clock.at += 1000;
    await h.retry.fire();
    expect(h.calls).toEqual({ reply: 0, seat: 1 });
    expect((await items())[0]).toMatchObject({ state: "resolved" });
  });
});

describe("a restart", () => {
  test("works the due time out again from the ledger instead of starting over", async () => {
    await store.create(record());
    const first = harness();
    await first.retry.note(RUN_ID, REPLY);
    await first.retry.dispose();

    // A new process, 400 ms later, with its own store handle on the same ledger.
    await store.close();
    store = createRunStore({ home: path.join(home, "paseo"), lock: { acquireTimeoutMs: 300 } });
    await store.initialize();
    const second = harness();
    second.clock.at = T0 + 400;
    await second.retry.start();
    expect(second.live().map((timer) => timer.ms)).toEqual([600]);
    expect(second.calls.reply).toBe(0);
    second.answers.reply.push(async () => complete());
    second.clock.at = T0 + 1000;
    await second.retry.fire();
    expect(second.calls.reply).toBe(1);
  });

  test("a try that was counted and cut off is used: nothing is read for it, and the next one waits", async () => {
    await store.create(record());
    const first = harness();
    await first.retry.note(RUN_ID, REPLY);
    // The process dies after the try was counted and before the read.
    await store.update(RUN_ID, (current) => {
      const begun = beginTries(current, new Date(T0 + 1000).toISOString(), alertIdFor);
      return begun.change.changed ? begun.change.next : null;
    });
    expect((await items())[0]).toMatchObject({ state: "checking", attemptsStarted: 1 });

    const second = harness();
    second.clock.at = T0 + 5000;
    await second.retry.start();
    expect(second.live()).toHaveLength(1);
    await second.retry.fire();
    expect(second.calls).toEqual({ reply: 0, seat: 0 });
    expect((await items())[0]).toMatchObject({
      state: "waiting",
      attemptsStarted: 1,
      lastCode: "interrupted",
      nextAt: new Date(T0 + 5000 + 2000).toISOString(),
    });
  });
});

describe("the clock", () => {
  test("a clock that went back never makes a try early, and the wait is cut to 30 seconds", async () => {
    await store.create(record());
    const h = harness();
    await h.retry.note(RUN_ID, REPLY);
    h.clock.at = T0 - 3_600_000;
    await h.retry.fire();
    expect(h.calls.reply).toBe(0);
    expect(h.live().map((timer) => timer.ms)).toEqual([30_000]);
  });

  test("a clock that jumped forward gives each due item one try, not several", async () => {
    await store.create(record());
    const h = harness();
    await h.retry.note(RUN_ID, REPLY);
    await h.retry.note(RUN_ID, SEAT);
    h.answers.reply.push(async () => complete());
    h.answers.seat.push(async () => undefined);
    h.clock.at = T0 + 7 * 24 * 3_600_000;
    await h.retry.fire();
    expect(h.calls).toEqual({ reply: 1, seat: 1 });
    await h.retry.fire();
    expect(h.calls).toEqual({ reply: 1, seat: 1 });
  });
});

describe("when there is nothing to do", () => {
  test("no timer is set for a Run with an empty block, and none for a Run that is over", async () => {
    await store.create(record());
    const empty = harness();
    await empty.retry.start();
    expect(empty.timers).toHaveLength(0);
    expect(empty.retry.armed).toBe(false);

    const h = harness();
    await h.retry.note(RUN_ID, REPLY);
    await store.update(RUN_ID, (current) => {
      current.lifecycle = "finished";
      return current;
    });
    const later = harness();
    await later.retry.start();
    expect(later.live()).toHaveLength(0);
    await later.retry.fire();
    expect(later.calls).toEqual({ reply: 0, seat: 0 });
  });

  test("a Run that ends while an item waits is not read, and does not keep the timer spinning", async () => {
    await store.create(record());
    const h = harness();
    await h.retry.note(RUN_ID, REPLY);
    await store.update(RUN_ID, (current) => {
      current.lifecycle = "finished";
      return current;
    });
    h.clock.at += 1000;
    await h.retry.fire();
    expect(h.calls).toEqual({ reply: 0, seat: 0 });
    expect(h.live()).toHaveLength(0);
    expect(h.retry.pendingRuns).toBe(0);
  });

  test("once stopped it sets no timer, reads nothing and writes nothing", async () => {
    await store.create(record());
    const h = harness();
    await h.retry.note(RUN_ID, REPLY);
    await h.retry.dispose();
    expect(h.live()).toHaveLength(0);
    const before = await store.get(RUN_ID);
    await h.retry.note(RUN_ID, SEAT);
    h.clock.at += 10_000;
    await h.retry.fire();
    expect(h.calls).toEqual({ reply: 0, seat: 0 });
    expect(await store.get(RUN_ID)).toEqual(before);
  });
});

describe("a pass of the Run", () => {
  test("takes the alert of a reply down once the report is no longer waited for", async () => {
    await store.create(record());
    const h = harness();
    await h.retry.note(RUN_ID, REPLY);
    h.answers.reply.push(async () => complete());
    h.clock.at += 1000;
    await h.retry.fire();
    await h.retry.sweep(RUN_ID);
    expect((await stored()).alerts[0]?.state).toBe("open");

    // A repair request went out for the same assignment: the reply to read is now another one, so
    // the reply this item was about is no longer waited for.
    await store.update(RUN_ID, (current) => {
      current.outbox.push({
        ...dispatchIntent({
          id: "intent-repair-rtr",
          kind: "wake",
          taskId: "t2",
          assignmentId: ASSIGNMENT_T2,
          messageId: "99999999-9999-4999-8999-999999999999",
          idempotencyKey: "repair-rtr",
        }),
        kind: "wake",
        semanticArgs: { purpose: "repair" },
      } as RunRecord["outbox"][number]);
      return current;
    });
    await h.retry.sweep(RUN_ID);
    expect((await stored()).alerts[0]?.state).toBe("resolved");
  });
});

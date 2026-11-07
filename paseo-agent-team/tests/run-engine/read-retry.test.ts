import { describe, expect, test } from "vitest";
import { alertIdFor } from "../../server/run-engine/digest";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import {
  beginTries,
  emptyReadRetries,
  finishTries,
  hasInterruptedTry,
  nextDueMs,
  noteReadFailure,
  READ_RETRY_DELAYS_MS,
  READ_RETRY_MAX_ITEMS,
  type ReadRetryTarget,
  readReadRetries,
  readRetryAlertSummary,
  sweepReadRetries,
} from "../../shared/domain/run-engine/read-retry";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { ASSIGNMENT_T2, MESSAGE_T2, NORMAL_RUN_LEDGER } from "../fixtures/run-engine/base";

/**
 * Failure modes this file guards:
 *  - a Run that was not given retries (v1, or no block) being written to, or a damaged block being
 *    "repaired" by overwriting it;
 *  - a try that is not counted before the read, so a restart hands out a free one;
 *  - the same failure making a second item, or a used-up item being tried again;
 *  - an alert that says "recovered" for something that is no longer waited on, or one that never ends.
 */

const T0 = "2026-11-08T10:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

const REPLY: ReadRetryTarget = {
  type: "reply",
  agentId: "agent-b1",
  taskId: "t2",
  assignmentId: ASSIGNMENT_T2,
  anchorMessageId: MESSAGE_T2,
};
const SEAT: ReadRetryTarget = { type: "seat", agentId: "agent-b1" };

function run(): RunRecord {
  const record = structuredClone(NORMAL_RUN_LEDGER);
  record.schemaVersion = 2;
  (record as Record<string, unknown>).readRetries = emptyReadRetries();
  return record;
}

function noted(record: RunRecord, key: string, target: ReadRetryTarget, now = T0): RunRecord {
  const result = noteReadFailure(record, { key, sourceKey: `source-${key}`, target }, now);
  if (!result.changed) throw new Error("the failure was not noted");
  return result.next;
}

const items = (record: RunRecord) => {
  const block = readReadRetries(record);
  if (block.kind !== "valid") throw new Error(`block is ${block.kind}`);
  return block.items;
};

/** Counts a try at its due time and fails it, the way the executor does for a read that throws. */
function failedTry(record: RunRecord, now: string, code = "read-error"): RunRecord {
  const begun = beginTries(record, now, alertIdFor);
  const [one] = begun.started;
  if (!one || !begun.change.changed) throw new Error("no try was due");
  const finished = finishTries(
    begun.change.next,
    [{ key: one.key, generation: one.generation, ok: false, code }],
    now,
    alertIdFor,
  );
  if (!finished.changed) throw new Error("the try was not ended");
  return finished.next;
}

describe("the block", () => {
  test("a Run is given retries only when it is v2 and carries a valid block", () => {
    const v1 = run();
    v1.schemaVersion = 1;
    expect(readReadRetries(v1)).toEqual({ kind: "absent" });
    const without = run();
    delete (without as Record<string, unknown>).readRetries;
    expect(readReadRetries(without)).toEqual({ kind: "absent" });
    expect(readReadRetries(run())).toEqual({ kind: "valid", items: [] });
    for (const record of [v1, without]) {
      expect(noteReadFailure(record, { key: "k", sourceKey: "s", target: SEAT }, T0).changed).toBe(
        false,
      );
    }
  });

  test("a damaged block is left exactly as it is, and nothing is retried for it", () => {
    for (const damaged of [
      { version: 2, items: [] },
      { version: 1, items: "no" },
      { version: 1, items: [], extra: true },
      {
        version: 1,
        items: [
          {
            key: "k",
            generation: 1,
            target: SEAT,
            sourceKey: "s",
            attemptsStarted: 0,
            scheduledAt: T0,
            nextAt: null,
            state: "waiting",
          },
        ],
      },
      {
        version: 1,
        items: [
          {
            key: "k",
            generation: 1,
            target: SEAT,
            sourceKey: "s",
            attemptsStarted: 4,
            scheduledAt: T0,
            nextAt: null,
            state: "held",
            lastCode: "x",
          },
        ],
      },
    ]) {
      const record = run();
      (record as Record<string, unknown>).readRetries = damaged;
      const before = structuredClone(record);
      expect(readReadRetries(record)).toEqual({ kind: "invalid" });
      expect(noteReadFailure(record, { key: "k", sourceKey: "s", target: SEAT }, T0).changed).toBe(
        false,
      );
      expect(beginTries(record, at(10_000), alertIdFor).change.changed).toBe(false);
      expect(nextDueMs(record)).toBeNull();
      expect(record).toEqual(before);
    }
  });

  test("a finished Run, or one whose launch failed, takes no new item", () => {
    const finished = run();
    finished.lifecycle = "finished";
    expect(noteReadFailure(finished, { key: "k", sourceKey: "s", target: SEAT }, T0).changed).toBe(
      false,
    );
    const failedLaunch = run();
    failedLaunch.launch.state = "failed";
    expect(
      noteReadFailure(failedLaunch, { key: "k", sourceKey: "s", target: SEAT }, T0).changed,
    ).toBe(false);
  });
});

describe("noting a failure", () => {
  test("makes one waiting item due after the first delay, with an audit event, and the ledger stays valid", () => {
    const record = noted(run(), "k1", REPLY);
    expect(items(record)).toEqual([
      expect.objectContaining({
        key: "k1",
        generation: 1,
        attemptsStarted: 0,
        state: "waiting",
        scheduledAt: T0,
        nextAt: at(READ_RETRY_DELAYS_MS[0]),
      }),
    ]);
    expect(record.events.at(-1)).toMatchObject({
      kind: "read-retry-changed",
      payload: { key: "k1", generation: 1, state: "waiting", attemptsStarted: 0 },
    });
    expect(checkLedgerInvariants(record)).toEqual({ ok: true });
    expect(nextDueMs(record)).toBe(Date.parse(at(1000)));
  });

  test("the same source is one item: a repeat while it waits, is tried or is used up changes nothing", () => {
    const waiting = noted(run(), "k1", REPLY);
    expect(
      noteReadFailure(waiting, { key: "k1", sourceKey: "source-k1", target: REPLY }, at(500))
        .changed,
    ).toBe(false);
    const checking = beginTries(waiting, at(1000), alertIdFor).change.next;
    expect(
      noteReadFailure(checking, { key: "k1", sourceKey: "source-k1", target: REPLY }, at(1001))
        .changed,
    ).toBe(false);
    let used = waiting;
    for (const ms of [1000, 3000, 7000]) used = failedTry(used, at(ms));
    expect(items(used)[0]?.state).toBe("held");
    expect(
      noteReadFailure(used, { key: "k1", sourceKey: "source-k1", target: REPLY }, at(9000)).changed,
    ).toBe(false);
  });

  test("an item that came out fine and fails again starts a new generation with its tries back", () => {
    const waiting = noted(run(), "k1", SEAT);
    const begun = beginTries(waiting, at(1000), alertIdFor);
    const done = finishTries(
      begun.change.next,
      [{ key: "k1", generation: 1, ok: true, observedAt: at(1000) }],
      at(1000),
      alertIdFor,
    );
    expect(items(done.next)[0]).toMatchObject({ state: "resolved" });
    const again = noted(done.next, "k1", SEAT, at(60_000));
    expect(items(again)).toHaveLength(1);
    expect(items(again)[0]).toMatchObject({
      generation: 2,
      attemptsStarted: 0,
      state: "waiting",
      nextAt: at(61_000),
    });
    expect(items(again)[0]?.result).toBeUndefined();
  });

  test("a full block drops its oldest resolved item, and refuses when none is resolved", () => {
    let record = run();
    for (let index = 0; index < READ_RETRY_MAX_ITEMS; index += 1) {
      record = noted(record, `k${index}`, SEAT, at(index));
    }
    expect(items(record)).toHaveLength(READ_RETRY_MAX_ITEMS);
    expect(
      noteReadFailure(record, { key: "extra", sourceKey: "s", target: SEAT }, at(500)).changed,
    ).toBe(false);
    // Resolve the second item; it is the oldest resolved one, so it gives way.
    const block = readReadRetries(record);
    if (block.kind !== "valid") throw new Error("block");
    const edited = structuredClone(record);
    const list = (edited as unknown as { readRetries: { items: Record<string, unknown>[] } })
      .readRetries.items;
    Object.assign(list[1] ?? {}, { state: "resolved", nextAt: null });
    const made = noteReadFailure(edited, { key: "extra", sourceKey: "s", target: SEAT }, at(500));
    expect(made.changed).toBe(true);
    const keys = items(made.next).map((item) => item.key);
    expect(keys).toHaveLength(READ_RETRY_MAX_ITEMS);
    expect(keys).toContain("extra");
    expect(keys).not.toContain("k1");
  });
});

describe("the tries", () => {
  test("nothing is tried before it is due, and a try is counted before the read", () => {
    const waiting = noted(run(), "k1", REPLY);
    expect(beginTries(waiting, at(999), alertIdFor)).toMatchObject({
      change: { changed: false },
      started: [],
    });
    const begun = beginTries(waiting, at(1000), alertIdFor);
    expect(begun.started).toEqual([{ key: "k1", generation: 1, target: REPLY }]);
    // The ledger already says "checking, one try used" while the read has not happened.
    expect(items(begun.change.next)[0]).toMatchObject({
      state: "checking",
      attemptsStarted: 1,
      nextAt: null,
    });
    expect(hasInterruptedTry(begun.change.next)).toBe(true);
    expect(nextDueMs(begun.change.next)).toBeNull();
    expect(checkLedgerInvariants(begun.change.next)).toEqual({ ok: true });
  });

  test("three tries 1, 2 and 4 seconds apart; the third failure uses the item up and says so once", () => {
    let record = noted(run(), "k1", REPLY);
    record = failedTry(record, at(1000), "timeout");
    expect(items(record)[0]).toMatchObject({
      state: "waiting",
      attemptsStarted: 1,
      nextAt: at(1000 + 2000),
      lastCode: "timeout",
    });
    record = failedTry(record, at(3000), "timeout");
    expect(items(record)[0]).toMatchObject({
      state: "waiting",
      attemptsStarted: 2,
      nextAt: at(3000 + 4000),
    });
    expect(record.alerts).toHaveLength(0);
    record = failedTry(record, at(7000), "timeout");
    const used = items(record)[0];
    expect(used).toMatchObject({
      state: "held",
      attemptsStarted: 3,
      nextAt: null,
      lastCode: "timeout",
    });
    expect(record.alerts).toHaveLength(1);
    expect(record.alerts[0]).toMatchObject({ state: "open", severity: "warning" });
    expect(record.alerts[0]?.summary).toBe(readRetryAlertSummary(used as never));
    expect(record.alerts[0]?.summary).toContain("读取重试已用尽");
    // Used up means no more tries, whatever time it is.
    expect(nextDueMs(record)).toBeNull();
    expect(beginTries(record, at(10 * 60_000), alertIdFor).change.changed).toBe(false);
    expect(checkLedgerInvariants(record)).toEqual({ ok: true });
  });

  test("a try cut off by a restart is used: it waits for the next one, or is used up on the third", () => {
    const waiting = noted(run(), "k1", REPLY);
    const cut = beginTries(waiting, at(1000), alertIdFor).change.next;
    const resumed = beginTries(cut, at(50_000), alertIdFor);
    expect(resumed.started).toEqual([]);
    expect(items(resumed.change.next)[0]).toMatchObject({
      state: "waiting",
      attemptsStarted: 1,
      lastCode: "interrupted",
      nextAt: at(50_000 + 2000),
    });
    // The third try cut off: nothing is left, and the item says so.
    let last = noted(run(), "k2", REPLY);
    last = failedTry(last, at(1000));
    last = failedTry(last, at(3000));
    const third = beginTries(last, at(7000), alertIdFor).change.next;
    expect(items(third)[0]).toMatchObject({ state: "checking", attemptsStarted: 3 });
    const gone = beginTries(third, at(90_000), alertIdFor);
    expect(items(gone.change.next)[0]).toMatchObject({
      state: "held",
      lastCode: "interrupted",
    });
    expect(gone.change.next.alerts).toHaveLength(1);
  });

  test("a clock that jumped forward gives every due item one try, not several", () => {
    let record = noted(run(), "a", REPLY, at(0));
    record = noted(record, "b", SEAT, at(500));
    const begun = beginTries(record, at(24 * 3_600_000), alertIdFor);
    expect(begun.started.map((one) => one.key).sort()).toEqual(["a", "b"]);
    expect(items(begun.change.next).map((item) => item.attemptsStarted)).toEqual([1, 1]);
  });
});

describe("what a try found", () => {
  test("a read that works again resolves the item and asks a person to kick; nothing else moves", () => {
    const waiting = noted(run(), "k1", REPLY);
    const taskBefore = structuredClone(waiting.tasks);
    const assignmentBefore = structuredClone(waiting.assignments);
    const begun = beginTries(waiting, at(1000), alertIdFor);
    const done = finishTries(
      begun.change.next,
      [
        {
          key: "k1",
          generation: 1,
          ok: true,
          observedAt: at(1100),
          turnId: "turn-9",
          receiptKey: "agent-b1|turn-9|turn_ended",
        },
      ],
      at(1100),
      alertIdFor,
    );
    expect(items(done.next)[0]).toMatchObject({
      state: "resolved",
      result: { observedAt: at(1100), turnId: "turn-9", receiptKey: "agent-b1|turn-9|turn_ended" },
    });
    expect(done.next.alerts).toHaveLength(1);
    expect(done.next.alerts[0]?.summary).toContain("读取恢复，报告未入账，请 kick");
    // The report is not taken in, the task and the assignment are as they were.
    expect(done.next.tasks).toEqual(taskBefore);
    expect(done.next.assignments).toEqual(assignmentBefore);
    expect(checkLedgerInvariants(done.next)).toEqual({ ok: true });
  });

  test("a read that works for something no longer waited on raises nothing", () => {
    const waiting = noted(run(), "k1", REPLY);
    const begun = beginTries(waiting, at(1000), alertIdFor);
    const moved = structuredClone(begun.change.next);
    const assignment = moved.assignments.find((entry) => entry.assignmentId === ASSIGNMENT_T2);
    if (assignment) assignment.state = "ended";
    const done = finishTries(
      moved,
      [{ key: "k1", generation: 1, ok: true, observedAt: at(1100) }],
      at(1100),
      alertIdFor,
    );
    expect(items(done.next)[0]).toMatchObject({ state: "resolved", lastCode: "superseded" });
    expect(items(done.next)[0]?.result).toBeUndefined();
    expect(done.next.alerts).toHaveLength(0);
  });

  test("an outcome for another generation, or for an item not being tried, is dropped", () => {
    const waiting = noted(run(), "k1", REPLY);
    const begun = beginTries(waiting, at(1000), alertIdFor);
    expect(
      finishTries(
        begun.change.next,
        [{ key: "k1", generation: 7, ok: true, observedAt: at(1100) }],
        at(1100),
        alertIdFor,
      ).changed,
    ).toBe(false);
    expect(
      finishTries(
        waiting,
        [{ key: "k1", generation: 1, ok: true, observedAt: at(1100) }],
        at(1100),
        alertIdFor,
      ).changed,
    ).toBe(false);
  });
});

describe("taking an alert down", () => {
  function recovered(target: ReadRetryTarget): RunRecord {
    const waiting = noted(run(), "k1", target);
    const begun = beginTries(waiting, at(1000), alertIdFor);
    return finishTries(
      begun.change.next,
      [{ key: "k1", generation: 1, ok: true, observedAt: at(1100) }],
      at(1100),
      alertIdFor,
    ).next;
  }

  test("the alert of a reply stays while the report is waited for, and ends when it is taken in", () => {
    const record = recovered(REPLY);
    expect(sweepReadRetries(record, new Set(), at(2000), alertIdFor).changed).toBe(false);
    const taken = structuredClone(record);
    const assignment = taken.assignments.find((entry) => entry.assignmentId === ASSIGNMENT_T2);
    if (assignment) assignment.state = "ended";
    const swept = sweepReadRetries(taken, new Set(), at(2000), alertIdFor);
    expect(swept.changed).toBe(true);
    expect(swept.next.alerts[0]?.state).toBe("resolved");
    // Asking again writes nothing.
    expect(sweepReadRetries(swept.next, new Set(), at(3000), alertIdFor).changed).toBe(false);
  });

  test("the alert of a seat ends at the next pass in which that read did not fail again", () => {
    const record = recovered(SEAT);
    expect(sweepReadRetries(record, new Set(["k1"]), at(2000), alertIdFor).changed).toBe(false);
    const swept = sweepReadRetries(record, new Set(), at(2000), alertIdFor);
    expect(swept.next.alerts[0]?.state).toBe("resolved");
  });

  test("when the Run finishes every alert of the block ends", () => {
    const record = recovered(REPLY);
    record.lifecycle = "finished";
    expect(
      sweepReadRetries(record, new Set(["k1"]), at(2000), alertIdFor).next.alerts[0]?.state,
    ).toBe("resolved");
  });
});

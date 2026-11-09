import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createRunObserver,
  type ObserverHookEvent,
  type ObserverHost,
} from "../../server/run-engine/observer";
import { buildReplyWindow, type TimelineEntryLike } from "../../server/run-engine/protocol";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import { planCancelFinish } from "../../shared/domain/run-engine/cancel-request";
import { hasUnansweredLimbo } from "../../shared/domain/run-engine/decision-answer";
import {
  anchorSince,
  ENGINE_SETTLER,
  ownTurn,
  receiptOccurrence,
  resolveHookOccurrence,
  sameTurnOccurrence,
  startedAfterEnded,
  turnKey,
} from "../../shared/domain/run-engine/turn-occurrence";
import type { RunEventReceipt, RunRecord } from "../../shared/schemas/run-engine/ledger";
import {
  ASSIGNMENT_T2,
  assignmentsForRun,
  MESSAGE_T2,
  noncesForRun,
  withLedger,
} from "../fixtures/run-engine/base";

/**
 * T9a: the host numbers turns per session object, so after a restart a new turn can carry the id of an
 * old one. Each case runs for both ledger versions and both host numberings (a claude-style session
 * counts from 1, a codex-style one from 0), with a plugin "restart" being a new observer.
 */

const AGENT = "agent-b1";
const homes: string[] = [];
const stores: RunStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

async function newStore(): Promise<RunStore> {
  const home = await mkdtemp(path.join(tmpdir(), "run-turn-reuse-"));
  homes.push(home);
  const store = createRunStore({ home, lock: { acquireTimeoutMs: 300 } });
  stores.push(store);
  await store.initialize();
  return store;
}

function ledger(runId: string, schemaVersion: 1 | 2): RunRecord {
  const assignments = assignmentsForRun(runId).map((entry) =>
    entry.assignmentId === ASSIGNMENT_T2 ? { ...entry, state: "in_progress" as const } : entry,
  );
  return withLedger({
    runId,
    schemaVersion,
    revision: 1,
    previousDigest: "",
    resources: [],
    assignments,
    nonceRegistry: noncesForRun(runId),
  });
}

/** A clock a test moves by hand. Every "plugin process" gets its own start time from it. */
function clock(start: string) {
  let ms = Date.parse(start);
  return {
    now: () => new Date(ms).toISOString(),
    tick(by = 1000) {
      ms += by;
    },
  };
}

const receiptsOf = async (store: RunStore, runId: string) => {
  const read = await store.get(runId);
  return read.status === "ok" ? read.record.eventReceipts : [];
};
const turnKeysOf = async (store: RunStore, runId: string) =>
  (await receiptsOf(store, runId))
    .filter(
      (receipt) =>
        (receipt.kind === "turn_started" || receipt.kind === "turn_ended") &&
        receipt.eventKey.startsWith("turn_"),
    )
    .map((receipt) => receipt.eventKey);
const revisionOf = async (store: RunStore, runId: string) => {
  const read = await store.get(runId);
  return read.status === "ok" ? read.revision : -1;
};

const started = (turnId: string): ObserverHookEvent => ({
  name: "agent.turn_started",
  agentId: AGENT,
  turnId,
});
const ended = (turnId: string, outcome?: string): ObserverHookEvent => ({
  name: "agent.turn_ended",
  agentId: AGENT,
  turnId,
  ...(outcome === undefined ? {} : { outcome: { kind: outcome } }),
});

describe.each([
  ["v1 ledger, host counts from 1", 1 as const, (n: number) => `foreground-turn-${n}`],
  ["v1 ledger, host counts from 0", 1 as const, (n: number) => `codex-turn-${n - 1}`],
  ["v2 ledger, host counts from 1", 2 as const, (n: number) => `foreground-turn-${n}`],
  ["v2 ledger, host counts from 0", 2 as const, (n: number) => `codex-turn-${n - 1}`],
])("%s", (_label, schemaVersion, tid) => {
  const RUN = "run-trep01-a1";
  async function setup() {
    const store = await newStore();
    await store.create(ledger(RUN, schemaVersion));
    const time = clock("2026-11-09T10:00:00.000Z");
    const process = () => {
      time.tick(60_000);
      return createRunObserver({ store, clock: time });
    };
    return { store, time, process };
  }

  test("after a restart a repeated turn id is recorded as a new appearance, start and end alike (cases 1-3)", async () => {
    const { store, process } = await setup();
    const before = process();
    expect((await before.ingest(started(tid(1)))).status).toBe("recorded");
    expect((await before.ingest(ended(tid(1), "canceled"))).status).toBe("recorded");

    const after = process();
    expect(await after.ingest(started(tid(1)))).toEqual({ status: "recorded", runId: RUN });
    expect(await after.ingest(ended(tid(1), "completed"))).toEqual({
      status: "recorded",
      runId: RUN,
    });
    expect(await turnKeysOf(store, RUN)).toEqual([
      `turn_started:${AGENT}:${tid(1)}`,
      `turn_ended:${AGENT}:${tid(1)}`,
      `turn_started:${AGENT}:${tid(1)}#2`,
      `turn_ended:${AGENT}:${tid(1)}#2`,
    ]);
    // The receipt still carries the bare turn id.
    expect((await receiptsOf(store, RUN)).at(-1)).toMatchObject({
      turnId: tid(1),
      outcome: "completed",
    });
  });

  test("in one process a start replayed after the end is a duplicate and leaves no open turn (case 4)", async () => {
    const { store, process } = await setup();
    await process().ingest(started(tid(1)));
    await process().ingest(ended(tid(1)));
    const live = process();
    await live.ingest(started(tid(1)));
    await live.ingest(ended(tid(1)));
    const count = (await receiptsOf(store, RUN)).length;
    const revision = await revisionOf(store, RUN);
    expect(await live.ingest(started(tid(1)))).toEqual({ status: "duplicate", runId: RUN });
    expect(await live.ingest(ended(tid(1)))).toEqual({ status: "duplicate", runId: RUN });
    expect((await receiptsOf(store, RUN)).length).toBe(count);
    expect(await revisionOf(store, RUN)).toBe(revision);
    // Every start has its end.
    const keys = await turnKeysOf(store, RUN);
    for (const key of keys.filter((entry) => entry.startsWith("turn_started"))) {
      expect(keys).toContain(key.replace("turn_started", "turn_ended"));
    }
  });

  test("a turn that spans a plugin reload has exactly one effective end (case 5)", async () => {
    const { store, process } = await setup();
    await process().ingest(started(tid(1)));
    const reloaded = process();
    expect(await reloaded.ingest(ended(tid(1)))).toEqual({ status: "recorded", runId: RUN });
    expect(await reloaded.ingest(ended(tid(1)))).toEqual({ status: "duplicate", runId: RUN });
    expect(await turnKeysOf(store, RUN)).toEqual([
      `turn_started:${AGENT}:${tid(1)}`,
      `turn_ended:${AGENT}:${tid(1)}`,
    ]);
  });

  test("a recovery with nothing new writes nothing, and the next new turn is still seen (case 6)", async () => {
    const { store, process } = await setup();
    const old = process();
    await old.ingest(started(tid(1)));
    await old.ingest(ended(tid(1)));
    const reloaded = process();
    const host: ObserverHost = {
      replyWindow: async () => ({ complete: true, turnId: tid(1), text: "x", bytes: 1 }),
    };
    const revision = await revisionOf(store, RUN);
    const summary = await reloaded.reconcile(host);
    expect(await revisionOf(store, RUN)).toBe(revision);
    expect(summary.recorded).toBe(0);
    // The history the reconcile found does not make the next turn with the same id a duplicate.
    expect((await reloaded.ingest(started(tid(1)))).status).toBe("recorded");
    expect((await turnKeysOf(store, RUN)).at(-1)).toBe(`turn_started:${AGENT}:${tid(1)}#2`);
  });

  test("two hooks for the same new turn at once record one appearance", async () => {
    const { store, process } = await setup();
    const old = process();
    await old.ingest(started(tid(1)));
    await old.ingest(ended(tid(1)));
    const live = process();
    const results = await Promise.all([
      live.ingest(started(tid(1))),
      live.ingest(started(tid(1))),
      live.ingest(started(tid(1))),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["duplicate", "duplicate", "recorded"]);
    await live.ingest(ended(tid(1)));
    expect((await turnKeysOf(store, RUN)).slice(2)).toEqual([
      `turn_started:${AGENT}:${tid(1)}#2`,
      `turn_ended:${AGENT}:${tid(1)}#2`,
    ]);
  });

  test("an end that comes before its own start belongs to the same appearance", async () => {
    const { store, process } = await setup();
    const old = process();
    await old.ingest(started(tid(1)));
    await old.ingest(ended(tid(1)));
    const live = process();
    await live.ingest(ended(tid(1)));
    await live.ingest(started(tid(1)));
    expect((await turnKeysOf(store, RUN)).slice(2)).toEqual([
      `turn_ended:${AGENT}:${tid(1)}#2`,
      `turn_started:${AGENT}:${tid(1)}#2`,
    ]);
    const record = (await store.get(RUN)) as { record: RunRecord };
    const last = record.record.eventReceipts.at(-1) as RunEventReceipt;
    const first = record.record.eventReceipts.at(-2) as RunEventReceipt;
    expect(sameTurnOccurrence(first, last)).toBe(true);
    // The late start is not "the member started again".
    expect(startedAfterEnded(record.record, first)).toBe(false);
  });

  test("an old turn's reconcile does not take the new turn's receipts, nor the other way round", async () => {
    const { store, process } = await setup();
    const old = process();
    await old.ingest(started(tid(1)));
    await old.ingest(ended(tid(1), "canceled"));
    const live = process();
    await live.ingest(started(tid(1)));
    const read = await store.get(RUN);
    const record = (read as { record: RunRecord }).record;
    // The assignment's own message was sent long before either turn: its turn is the first appearance.
    expect(ownTurn(record, { agentId: AGENT, turnId: tid(1), since: null })).toMatchObject({
      occurrence: 1,
    });
    // A message made after the first appearance began belongs to the second.
    const firstStart = record.eventReceipts.find(
      (r) => r.kind === "turn_started",
    ) as RunEventReceipt;
    const since = new Date(Date.parse(firstStart.receivedAt) + 1).toISOString();
    expect(ownTurn(record, { agentId: AGENT, turnId: tid(1), since })).toMatchObject({
      occurrence: 2,
      ended: undefined,
    });
    // The reconcile of an old reply (anchored before the restart) finds the old end: a duplicate.
    const host: ObserverHost = {
      replyWindow: async () => ({ complete: true, turnId: tid(1), text: "x", bytes: 1 }),
    };
    const revision = await revisionOf(store, RUN);
    expect((await live.reconcile(host)).recorded).toBe(0);
    expect(await revisionOf(store, RUN)).toBe(revision);
  });

  test("many restarts number the appearances in order, #9 before #10", async () => {
    const { store, process } = await setup();
    for (let round = 0; round < 11; round += 1) {
      const live = process();
      await live.ingest(started(tid(1)));
      await live.ingest(ended(tid(1)));
    }
    const keys = await turnKeysOf(store, RUN);
    expect(keys).toHaveLength(22);
    expect(keys.at(-1)).toBe(`turn_ended:${AGENT}:${tid(1)}#11`);
    const record = ((await store.get(RUN)) as { record: RunRecord }).record;
    expect(record.eventReceipts.map(receiptOccurrence).slice(-2)).toEqual([11, 11]);
  });

  test("a turn id with '#' keeps the old key: a repeat is a duplicate, never a collision", async () => {
    const { store, process } = await setup();
    const odd = `${tid(1)}#2`;
    const old = process();
    await old.ingest(started(odd));
    await old.ingest(started(tid(1)));
    const live = process();
    expect(await live.ingest(started(odd))).toEqual({ status: "duplicate", runId: RUN });
    expect(await turnKeysOf(store, RUN)).toEqual([
      `turn_started:${AGENT}:${odd}`,
      `turn_started:${AGENT}:${tid(1)}`,
    ]);
  });
});

describe("turn keys", () => {
  test("the first appearance keeps the old key, later ones add #n", () => {
    expect(turnKey("turn_started", "a", "t", 1)).toBe("turn_started:a:t");
    expect(turnKey("turn_ended", "a", "t", 2)).toBe("turn_ended:a:t#2");
    expect(turnKey("turn_ended", "a", "t", 10)).toBe("turn_ended:a:t#10");
  });

  test("an appearance that cannot be encoded is refused, never truncated", () => {
    expect(turnKey("turn_started", "a", "x#2", 2)).toBeNull();
    // 'turn_started:' is 13 characters: 13 + agent + 1 + turn + '#2' is the key length.
    const agent = "a".repeat(100);
    const fits = "t".repeat(256 - 13 - 100 - 1 - 2);
    expect(turnKey("turn_started", agent, fits, 2)?.length).toBe(256);
    expect(turnKey("turn_started", agent, `${fits}t`, 2)).toBeNull();
    // The first appearance of an old, long key is never touched.
    expect(turnKey("turn_started", agent, `${fits}tt`, 1)).toBe(`turn_started:${agent}:${fits}tt`);
  });

  test("an unknown or malformed old key counts as the first appearance", () => {
    const base = { kind: "turn_ended" as const, agentId: "a", turnId: "t" };
    expect(receiptOccurrence({ ...base, eventKey: "turn_ended:a:t" })).toBe(1);
    expect(receiptOccurrence({ ...base, eventKey: "turn_ended:a:t#2" })).toBe(2);
    expect(receiptOccurrence({ ...base, eventKey: "turn_ended:a:t#02" })).toBe(1);
    expect(receiptOccurrence({ ...base, eventKey: "turn_ended:a:t#1" })).toBe(1);
    expect(receiptOccurrence({ ...base, eventKey: "turn_ended:a:t#x" })).toBe(1);
    expect(receiptOccurrence({ ...base, eventKey: "a|t|turn_ended" })).toBe(1);
    expect(receiptOccurrence({ ...base, turnId: "t#2", eventKey: "turn_ended:a:t#2" })).toBe(1);
  });
});

describe("which appearance a hook is", () => {
  const receipt = (
    kind: "turn_started" | "turn_ended",
    n: number,
    at: string,
    extra: Record<string, unknown> = {},
  ): RunEventReceipt =>
    ({
      eventKey: turnKey(kind, AGENT, "T", n) as string,
      dedupeKey: turnKey(kind, AGENT, "T", n) as string,
      kind,
      agentId: AGENT,
      turnId: "T",
      seq: 1,
      receivedAt: at,
      disposition: "observed",
      ...extra,
    }) as RunEventReceipt;
  const resolve = (
    kind: "turn_started" | "turn_ended",
    receipts: RunEventReceipt[],
    processStart = "2026-11-09T12:00:00.000Z",
  ) =>
    resolveHookOccurrence(
      { eventReceipts: receipts },
      { kind, agentId: AGENT, turnId: "T", processStart },
    );

  test("an end the Engine wrote for a turn the host never ended takes the late real end as its own", () => {
    const old = [
      receipt("turn_started", 1, "2026-11-09T10:00:00.000Z"),
      receipt("turn_ended", 1, "2026-11-09T10:05:00.000Z", { settledBy: ENGINE_SETTLER }),
    ];
    expect(resolve("turn_ended", old)).toBe(1);
    // A host-written end is not that: a second end is a new turn whose start was missed.
    expect(
      resolve("turn_ended", [
        receipt("turn_started", 1, "2026-11-09T10:00:00.000Z"),
        receipt("turn_ended", 1, "2026-11-09T10:05:00.000Z"),
      ]),
    ).toBe(2);
  });

  test("a start with an older appearance on record is a new one; with none, the first", () => {
    expect(resolve("turn_started", [])).toBe(1);
    expect(resolve("turn_started", [receipt("turn_started", 1, "2026-11-09T10:00:00.000Z")])).toBe(
      2,
    );
    expect(
      resolve("turn_started", [
        receipt("turn_started", 1, "2026-11-09T10:00:00.000Z"),
        receipt("turn_started", 2, "2026-11-09T12:30:00.000Z"),
      ]),
    ).toBe(2);
  });
});

describe("a start that is not a restart", () => {
  test("the cancellation wait ends when the turn that ended is idle, even if its start came late", async () => {
    const store = await newStore();
    const record = ledger("run-trep02-a1", 1);
    const mine = record.assignments.find((entry) => entry.assignmentId === ASSIGNMENT_T2);
    if (mine) mine.turnId = "T1";
    await store.create(record);
    const time = clock("2026-11-09T10:00:00.000Z");
    const live = createRunObserver({ store, clock: time });
    time.tick();
    await live.ingest(ended("T1"));
    time.tick();
    await live.ingest(started("T1"));
    const read = ((await store.get("run-trep02-a1")) as { record: RunRecord }).record;
    expect(planCancelFinish(read, "assume-idle").kind).toBe("finish");
  });
});

describe("the gate that keeps a reply out while a person is asked", () => {
  const decision = (overrides: Record<string, unknown>) =>
    ({
      decisionId: "d1",
      category: "D1",
      state: "open",
      dedupeKey: "stuck:assignment-1",
      cancelIntents: null,
      subjectId: "t2",
      limbo: { turnId: "T", endedEventKey: "turn_ended:a:T", reason: "member-lost" },
      ...overrides,
    }) as unknown as RunRecord["decisions"][number];
  const has = (decisions: RunRecord["decisions"]) =>
    hasUnansweredLimbo({ decisions }, "assignment-1");

  test("an open or waiting limbo decision of this attempt closes it; nothing else does", () => {
    expect(has([decision({})])).toBe(true);
    expect(has([decision({ state: "waiting-human" })])).toBe(true);
    expect(has([decision({ dedupeKey: "evidence-stuck:assignment-1" })])).toBe(true);
    expect(has([decision({ state: "answered" })])).toBe(false);
    // An ordinary stuck decision (no limbo evidence) and another attempt's do not.
    expect(has([decision({ limbo: undefined })])).toBe(false);
    expect(has([decision({ dedupeKey: "stuck:assignment-2" })])).toBe(false);
    // A cancellation decision never closes it (A5).
    expect(has([decision({ dedupeKey: "cancel:t2", cancelIntents: [], limbo: undefined })])).toBe(
      false,
    );
  });
});

describe("anchors", () => {
  test("a reply is anchored on the creation of the message that asked for it", () => {
    const record = withLedger({ outbox: [] }) as RunRecord;
    expect(anchorSince(record, MESSAGE_T2, "fallback-time")).toBe("fallback-time");
    expect(anchorSince(record, MESSAGE_T2, null)).toBeNull();
    const withIntent = {
      ...record,
      outbox: [{ messageId: MESSAGE_T2, createdAt: "2026-11-05T12:00:00.000Z" }],
    } as unknown as RunRecord;
    expect(anchorSince(withIntent, MESSAGE_T2, "fallback-time")).toBe("2026-11-05T12:00:00.000Z");
  });
});

describe("a reply window that runs over several user messages of one turn id (case 10)", () => {
  const entry = (
    seq: number,
    type: string,
    text: string,
    turnId: string,
    messageId?: string,
  ): TimelineEntryLike => ({
    item: { type, text, ...(messageId === undefined ? {} : { messageId }) },
    turnId,
    seqStart: seq,
    seqEnd: seq,
  });
  const page = (entries: TimelineEntryLike[]) => ({
    entries,
    epoch: "e1",
    hasOlder: false,
    hasNewer: false,
    gap: false,
    staleCursor: false,
    reset: false,
  });

  test("a message typed into the running turn does not cut off the report that follows it", () => {
    const window = buildReplyWindow({
      pages: [
        page([
          entry(1, "user_message", "dispatch", "T", "m-dispatch"),
          entry(2, "assistant_message", "working", "T"),
          entry(3, "user_message", "a person steers", "T", "m-steer"),
          entry(4, "assistant_message", "REPORT", "T"),
        ]),
      ],
      dispatchMessageId: "m-dispatch",
    });
    expect(window).toMatchObject({ complete: true, turnId: "T" });
    expect(window.complete && window.text).toBe("working\nREPORT");
  });

  test("a later turn that reused the id is read into the same window (the residual the gate covers)", () => {
    const window = buildReplyWindow({
      pages: [
        page([
          entry(1, "user_message", "dispatch", "T", "m-dispatch"),
          entry(2, "assistant_message", "interrupted", "T"),
          entry(3, "user_message", "only reply OK", "T", "m-ok"),
          entry(4, "assistant_message", "OK", "T"),
        ]),
      ],
      dispatchMessageId: "m-dispatch",
    });
    expect(window.complete && window.text).toBe("interrupted\nOK");
  });
});

describe("an end that comes first while an earlier appearance never ended (a known limit)", () => {
  test("it is attached to the earlier appearance and the late start becomes an unended #2: the cancellation waits", async () => {
    const store = await newStore();
    const record = ledger("run-trep03-a1", 1);
    const mine = record.assignments.find((entry) => entry.assignmentId === ASSIGNMENT_T2);
    if (mine) mine.turnId = "T1";
    await store.create(record);
    const time = clock("2026-11-09T10:00:00.000Z");
    const killed = createRunObserver({ store, clock: time });
    time.tick();
    await killed.ingest(started("T1"));
    // The daemon was killed: no end for it. After the restart the new turn's end comes before its start.
    time.tick(60_000);
    const live = createRunObserver({ store, clock: time });
    await live.ingest(ended("T1"));
    time.tick();
    await live.ingest(started("T1"));
    const read = ((await store.get("run-trep03-a1")) as { record: RunRecord }).record;
    const keys = read.eventReceipts
      .map((r) => r.eventKey)
      .filter((k) => k.endsWith(":T1") || k.endsWith("#2"));
    expect(keys).toEqual([
      `turn_started:${AGENT}:T1`,
      `turn_ended:${AGENT}:T1`,
      `turn_started:${AGENT}:T1#2`,
    ]);
    // The two inputs cannot be told apart from a replay, so nothing is guessed: the Run waits for a
    // person (or the next turn end) instead of cancelling on a turn that may still be running.
    expect(planCancelFinish(read, "assume-idle").kind).toBe("wait");
  });
});

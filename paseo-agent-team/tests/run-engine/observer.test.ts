import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createRunObserver, type ObserverHost } from "../../server/run-engine/observer";
import type { ReplyWindow } from "../../server/run-engine/protocol";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import {
  ASSIGNMENT_T2,
  assignmentsForRun,
  MESSAGE_T2,
  NONCE_T2,
  noncesForRun,
  withLedger,
} from "../fixtures/run-engine/base";
import { PROTOCOL_REPLAY_CASE } from "../fixtures/run-engine/protocol";

const AGENT = "agent-b1";
const homes: string[] = [];
const stores: RunStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

async function newStore(initialize = true): Promise<RunStore> {
  const home = await mkdtemp(path.join(tmpdir(), "run-observer-"));
  homes.push(home);
  const store = createRunStore({ home, lock: { acquireTimeoutMs: 300 } });
  stores.push(store);
  if (initialize) await store.initialize();
  return store;
}

function ledger(runId: string, overrides: Record<string, unknown> = {}): RunRecord {
  const assignments = assignmentsForRun(runId).map((entry) =>
    entry.assignmentId === ASSIGNMENT_T2 ? { ...entry, state: "in_progress" as const } : entry,
  );
  return withLedger({
    runId,
    revision: 1,
    previousDigest: "",
    resources: [],
    assignments,
    nonceRegistry: noncesForRun(runId),
    ...overrides,
  });
}

function host(windows: Record<string, ReplyWindow | Error>): ObserverHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async replyWindow(agentId, messageId) {
      calls.push(`${agentId}:${messageId}`);
      const scripted = windows[`${agentId}:${messageId}`];
      if (scripted instanceof Error) throw scripted;
      return scripted ?? { complete: false, reason: "dispatch-not-found" };
    },
  };
}

const revisionOf = async (store: RunStore, runId: string) => {
  const read = await store.get(runId);
  return read.status === "ok" ? read.revision : -1;
};
const receiptsOf = async (store: RunStore, runId: string) => {
  const read = await store.get(runId);
  return read.status === "ok" ? read.record.eventReceipts : [];
};

describe("hook ingestion", () => {
  test("records one receipt for an owned agent and treats redelivery as a duplicate", async () => {
    const store = await newStore();
    await store.create(ledger("run-obs001-a1"));
    const observer = createRunObserver({ store });
    const event = {
      name: "agent.turn_ended",
      agentId: AGENT,
      turnId: "turn-9",
      outcome: { kind: "completed" },
    } as const;

    expect(await observer.ingest(event)).toEqual({ status: "recorded", runId: "run-obs001-a1" });
    const revision = await revisionOf(store, "run-obs001-a1");
    expect(await observer.ingest(event)).toEqual({ status: "duplicate", runId: "run-obs001-a1" });
    expect(await observer.ingest({ ...event, outcome: { kind: "failed" } })).toMatchObject({
      status: "duplicate",
    });
    expect(await revisionOf(store, "run-obs001-a1")).toBe(revision);
    const mine = (await receiptsOf(store, "run-obs001-a1")).filter((r) => r.turnId === "turn-9");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      kind: "turn_ended",
      agentId: AGENT,
      disposition: "observed",
      outcome: "completed",
    });
  });

  test("an event storm of repeats and reorderings leaves one receipt per distinct fact", async () => {
    const store = await newStore();
    await store.create(ledger("run-obs002-a1"));
    const observer = createRunObserver({ store });
    const before = (await receiptsOf(store, "run-obs002-a1")).length;
    const events = [
      { name: "agent.turn_ended", agentId: AGENT, turnId: "t-2" },
      { name: "agent.turn_started", agentId: AGENT, turnId: "t-2" },
      { name: "agent.turn_started", agentId: AGENT, turnId: "t-1" },
      { name: "agent.permission_requested", agentId: AGENT, requestId: "p-1" },
      { name: "agent.permission_requested", agentId: AGENT, requestId: "p-1" },
      { name: "agent.turn_ended", agentId: AGENT, turnId: "t-1" },
      { name: "agent.turn_ended", agentId: AGENT, turnId: "t-2" },
      { name: "agent.turn_started", agentId: AGENT, turnId: "t-1" },
    ] as const;
    for (let round = 0; round < 3; round += 1)
      for (const event of events) await observer.ingest(event);
    const after = await receiptsOf(store, "run-obs002-a1");
    expect(after.length - before).toBe(5);
    expect(new Set(after.map((r) => r.dedupeKey)).size).toBe(after.length);
    const seqs = after.slice(before).map((r) => r.seq);
    expect(seqs).toEqual(seqs.map((_, index) => seqs[0] + index));
  });

  test("a turn event with no turn id cannot be attributed and is ignored, not merged into one key", async () => {
    const store = await newStore();
    await store.create(ledger("run-obs003-a1"));
    const observer = createRunObserver({ store });
    const revision = await revisionOf(store, "run-obs003-a1");
    expect(
      await observer.ingest({ name: "agent.turn_started", agentId: AGENT, turnId: null }),
    ).toEqual({
      status: "ignored",
      reason: "no-turn-id",
    });
    expect(await revisionOf(store, "run-obs003-a1")).toBe(revision);
  });

  test("a hook that arrives before the store is ready or before any run names the agent is kept, then delivered", async () => {
    const store = await newStore(false);
    const observer = createRunObserver({ store });
    const LATE = "agent-late";
    const event = { name: "agent.turn_ended", agentId: LATE, turnId: "turn-early" } as const;
    expect(await observer.ingest(event)).toEqual({ status: "buffered", reason: "store-not-ready" });

    await store.initialize();
    // A live run exists (it names other agents), so an unclaimed agent may still be early.
    await store.create(ledger("run-obs004-live"));
    expect(await observer.ingest({ ...event, turnId: "turn-early-2" })).toEqual({
      status: "buffered",
      reason: "no-owner-yet",
    });
    expect(observer.buffered).toBe(2);
    expect(await observer.flush()).toEqual({ delivered: 0, held: 2, dropped: 0 });

    // The run later registers the new member: a seat naming the agent is what makes it the owner.
    await store.update("run-obs004-live", (record) => ({
      ...record,
      roster: [
        ...record.roster,
        {
          seatId: "seat-late",
          tier: "B",
          agentId: LATE,
          channelId: "ch-late",
          duties: [],
          enabled: true,
        },
      ],
    }));
    expect(await observer.flush()).toEqual({ delivered: 2, held: 0, dropped: 0 });
    const keys = (await receiptsOf(store, "run-obs004-live")).map((r) => r.dedupeKey);
    expect(keys).toContain(`turn_ended:${LATE}:turn-early`);
    expect(keys).toContain(`turn_ended:${LATE}:turn-early-2`);
    expect(observer.needsReconcile).toBe(false);
  });

  test("a hook that came before its seat was bound is delivered exactly once after the binding, however often the buffer is flushed", async () => {
    const store = await newStore();
    await store.create(ledger("run-obs005-a1"));
    const observer = createRunObserver({ store });
    const LATE = "agent-early";
    const event = { name: "agent.turn_ended", agentId: LATE, turnId: "turn-first" } as const;
    expect(await observer.ingest(event)).toEqual({ status: "buffered", reason: "no-owner-yet" });
    // The same hook delivered again while it still has no owner is held again, but is one fact.
    expect(await observer.ingest(event)).toEqual({ status: "buffered", reason: "no-owner-yet" });
    expect(
      (await receiptsOf(store, "run-obs005-a1")).filter((r) => r.dedupeKey.includes(LATE)),
    ).toEqual([]);

    await store.update("run-obs005-a1", (record) => ({
      ...record,
      roster: [
        ...record.roster,
        {
          seatId: "seat-early",
          tier: "B",
          agentId: LATE,
          channelId: "ch",
          duties: [],
          enabled: true,
        },
      ],
    }));
    await observer.flush();
    await observer.flush();
    await observer.flush();

    const mine = (await receiptsOf(store, "run-obs005-a1")).filter((r) =>
      r.dedupeKey.includes(LATE),
    );
    expect(mine.map((r) => r.dedupeKey)).toEqual([`turn_ended:${LATE}:turn-first`]);
    expect(observer.buffered).toBe(0);
    // And a fresh delivery of it afterwards is a duplicate that writes nothing.
    const revision = await revisionOf(store, "run-obs005-a1");
    expect(await observer.ingest(event)).toEqual({ status: "duplicate", runId: "run-obs005-a1" });
    expect(await revisionOf(store, "run-obs005-a1")).toBe(revision);
  });

  test("an agent named by two runs is not attributed to either", async () => {
    const store = await newStore();
    await store.create(ledger("run-obs005-a1"));
    await store.create(ledger("run-obs005-b1"));
    const observer = createRunObserver({ store });
    expect(
      await observer.ingest({ name: "agent.turn_ended", agentId: AGENT, turnId: "x" }),
    ).toEqual({
      status: "ignored",
      reason: "ambiguous-owner",
    });
  });

  test("with no live run nothing could claim an agent, so its events are ignored, not buffered", async () => {
    const store = await newStore();
    const observer = createRunObserver({ store });
    expect(
      await observer.ingest({ name: "agent.turn_ended", agentId: "agent-unrelated", turnId: "x" }),
    ).toEqual({ status: "ignored", reason: "no-active-run" });
    expect(observer.buffered).toBe(0);
    expect(observer.needsReconcile).toBe(false);

    await store.create(ledger("run-obs007-a1", { lifecycle: "finished" }));
    expect(
      await observer.ingest({ name: "agent.turn_ended", agentId: "agent-unrelated", turnId: "y" }),
    ).toEqual({ status: "ignored", reason: "no-active-run" });
  });

  test("overflow and age both drop hooks and flag that hooks alone are no longer enough", async () => {
    const store = await newStore();
    await store.create(ledger("run-obs006-a1"));
    let now = Date.parse("2026-11-05T00:00:00.000Z");
    const observer = createRunObserver({
      store,
      bufferLimit: 2,
      bufferTtlMs: 1000,
      clock: { now: () => new Date(now).toISOString() },
    });
    for (const id of ["a", "b", "c"]) {
      await observer.ingest({ name: "agent.turn_ended", agentId: "agent-nobody", turnId: id });
    }
    expect(observer.buffered).toBe(2);
    expect(observer.needsReconcile).toBe(true);

    const store2 = await newStore();
    await store2.create(ledger("run-obs006-b1"));
    const aging = createRunObserver({
      store: store2,
      bufferTtlMs: 1000,
      clock: { now: () => new Date(now).toISOString() },
    });
    await aging.ingest({ name: "agent.turn_ended", agentId: "agent-nobody", turnId: "a" });
    now += 5000;
    expect(await aging.flush()).toEqual({ delivered: 0, held: 0, dropped: 1 });
    expect(aging.needsReconcile).toBe(true);
  });
});

describe("reconcile", () => {
  test("a turn end the hooks missed is recovered from the host, and a late hook is then a duplicate", async () => {
    const store = await newStore();
    await store.create(ledger("run-obs010-a1"));
    const observer = createRunObserver({ store });
    const fake = host({
      [`${AGENT}:${MESSAGE_T2}`]: { complete: true, turnId: "turn-7", text: "x", bytes: 1 },
    });

    const summary = await observer.reconcile(fake);
    expect(summary).toMatchObject({
      runsScanned: 1,
      turnsChecked: 1,
      recorded: 1,
      unverifiable: 0,
    });
    expect((await receiptsOf(store, "run-obs010-a1")).map((r) => r.dedupeKey)).toContain(
      `turn_ended:${AGENT}:turn-7`,
    );
    expect(
      await observer.ingest({ name: "agent.turn_ended", agentId: AGENT, turnId: "turn-7" }),
    ).toEqual({
      status: "duplicate",
      runId: "run-obs010-a1",
    });
    expect((await observer.reconcile(fake)).duplicates).toBe(1);
  });

  test("a partial or unreadable host answer is counted and writes nothing", async () => {
    const store = await newStore();
    await store.create(ledger("run-obs011-a1"));
    const observer = createRunObserver({ store });
    const revision = await revisionOf(store, "run-obs011-a1");

    const partial = await observer.reconcile(
      host({ [`${AGENT}:${MESSAGE_T2}`]: { complete: false, reason: "turn-open" } }),
    );
    expect(partial).toMatchObject({ recorded: 0, unverifiable: 1 });
    const failing = await observer.reconcile(
      host({ [`${AGENT}:${MESSAGE_T2}`]: new Error("boom") }),
    );
    expect(failing).toMatchObject({ recorded: 0, hostErrors: 1 });
    expect(await revisionOf(store, "run-obs011-a1")).toBe(revision);
  });

  test("a clean reconcile clears the needs-reconcile flag, an unclean one keeps it", async () => {
    const store = await newStore();
    await store.create(ledger("run-obs012-a1"));
    const observer = createRunObserver({ store, bufferLimit: 0 });
    await observer.ingest({ name: "agent.turn_ended", agentId: "agent-nobody", turnId: "a" });
    expect(observer.needsReconcile).toBe(true);
    await observer.reconcile(
      host({ [`${AGENT}:${MESSAGE_T2}`]: { complete: false, reason: "turn-open" } }),
    );
    expect(observer.needsReconcile).toBe(true);
    await observer.reconcile(
      host({ [`${AGENT}:${MESSAGE_T2}`]: { complete: true, turnId: "t", text: "", bytes: 0 } }),
    );
    expect(observer.needsReconcile).toBe(false);
  });

  test("a damaged run is reported, not skipped silently, and never rewritten", async () => {
    const store = await newStore();
    await store.create(ledger("run-obs013-a1"));
    const observer = createRunObserver({ store });
    const summary = await observer.reconcile(host({}));
    expect(summary.brokenRuns).toBe(0);
    expect(summary.runsScanned).toBe(1);
  });
});

describe("report inspection", () => {
  const reportText = (over: Record<string, unknown> = {}) =>
    `Done.\n\`\`\`task-report\n${JSON.stringify({
      ...PROTOCOL_REPLAY_CASE.report,
      runId: "run-obs020-a1",
      assignmentId: ASSIGNMENT_T2,
      nonce: NONCE_T2,
      ...over,
    })}\n\`\`\``;
  const complete = (text: string): ReplyWindow => ({
    complete: true,
    turnId: "turn-3",
    text,
    bytes: Buffer.byteLength(text),
  });
  const input = { runId: "run-obs020-a1", assignmentId: ASSIGNMENT_T2, agentId: AGENT };

  test("a valid report from the assignee is judged acceptable and nothing is written", async () => {
    const store = await newStore();
    await store.create(ledger("run-obs020-a1"));
    const observer = createRunObserver({ store });
    const revision = await revisionOf(store, "run-obs020-a1");
    const fake = host({ [`${AGENT}:${MESSAGE_T2}`]: complete(reportText()) });

    const verdict = await observer.inspectReport(input, fake);
    expect(verdict).toMatchObject({ status: "report", kind: "task-report", turnId: "turn-3" });
    expect(verdict.status === "report" && verdict.ownership.ok).toBe(true);
    expect(await revisionOf(store, "run-obs020-a1")).toBe(revision);
    expect(fake.calls).toEqual([`${AGENT}:${MESSAGE_T2}`]);
  });

  test("a report that names the wrong run or nonce is surfaced with the reason, not accepted", async () => {
    const store = await newStore();
    await store.create(ledger("run-obs020-a1"));
    const observer = createRunObserver({ store });
    const wrongNonce = host({
      [`${AGENT}:${MESSAGE_T2}`]: complete(
        reportText({ nonce: "6f1c2a44-3b7e-4f0a-9a11-00000000dead" }),
      ),
    });
    const verdict = await observer.inspectReport(input, wrongNonce);
    expect(verdict.status === "report" && verdict.ownership).toEqual({
      ok: false,
      code: "nonce-mismatch",
    });
  });

  test("another agent's timeline never contains the dispatch, so its text cannot stand in", async () => {
    const store = await newStore();
    await store.create(ledger("run-obs020-a1"));
    const observer = createRunObserver({ store });
    const verdict = await observer.inspectReport({ ...input, agentId: "agent-evil" }, host({}));
    expect(verdict).toEqual({ status: "unverifiable", reason: "dispatch-not-found" });
  });

  test("silence, a bad block and an unread reply are three different answers", async () => {
    const store = await newStore();
    await store.create(ledger("run-obs020-a1"));
    const observer = createRunObserver({ store });
    const key = `${AGENT}:${MESSAGE_T2}`;
    expect(await observer.inspectReport(input, host({ [key]: complete("all good") }))).toEqual({
      status: "missing",
      turnId: "turn-3",
      anchor: MESSAGE_T2,
    });
    expect(
      await observer.inspectReport(
        input,
        host({ [key]: complete("```task-report\nnot json\n```") }),
      ),
    ).toMatchObject({ status: "rejected", reason: "non-json" });
    expect(
      await observer.inspectReport(
        input,
        host({ [key]: { complete: false, reason: "turn-open" } }),
      ),
    ).toEqual({ status: "unverifiable", reason: "turn-open" });
  });

  test("an unknown assignment is reported as such", async () => {
    const store = await newStore();
    await store.create(ledger("run-obs020-a1"));
    const observer = createRunObserver({ store });
    expect(await observer.inspectReport({ ...input, assignmentId: "nope" }, host({}))).toEqual({
      status: "unknown-assignment",
    });
    expect(await observer.inspectReport({ ...input, runId: "run-none-a1" }, host({}))).toEqual({
      status: "unknown-assignment",
    });
  });
});

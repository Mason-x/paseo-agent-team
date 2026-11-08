import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createCompactor } from "../../server/run-engine/compact";
import { sha256Hex } from "../../server/run-engine/digest";
import { createEngineDriver } from "../../server/run-engine/driver";
import { createEngineService } from "../../server/run-engine/service";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import type { PaseoEnginePort } from "../../shared/paseo/port";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { readyRun } from "./support/ready-run";

/**
 * The compactor and the capacity guard against a real store. Failure modes:
 *  - compaction merged into another write, written twice, or changing a v1 / v2 record's version
 *    or anything it was not asked to touch;
 *  - the driver never compacting, or compacting a Run that has little to compact;
 *  - the service starting new work at a limit, or writing the same alert every time it is asked.
 */

const RUN_ID = "run-cmp001-a1";
const small = { compactAt: 10, keepNewest: 3 } as const;
const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

let home: string;
let store: RunStore;

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), "run-compaction-")));
  await mkdir(path.join(home, "paseo"));
  store = createRunStore({ home: path.join(home, "paseo"), lock: { acquireTimeoutMs: 300 } });
  await store.initialize();
});

afterEach(async () => {
  await store.close().catch(() => undefined);
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function record(count: number, schemaVersion: 1 | 2 = 2, lifecycle?: RunRecord["lifecycle"]) {
  const value = readyRun({ runId: RUN_ID });
  value.schemaVersion = schemaVersion;
  if (lifecycle) value.lifecycle = lifecycle;
  value.events = Array.from({ length: count }, (_, index) => ({
    seq: index + 1,
    kind: "audit-note",
    at: at(index * 1000),
    payload: {},
  }));
  value.counters.eventsThroughSeq = count;
  value.updatedAt = at(99_999_999);
  delete value.checkpoint;
  return value;
}

async function stored(): Promise<RunRecord> {
  const read = await store.get(RUN_ID);
  if (read.status !== "ok") throw new Error(`run unreadable: ${read.status}`);
  return read.record;
}

describe("the compactor", () => {
  test.each([1, 2] as const)(
    "a v%i record is compacted in one commit and only the history changes",
    async (schemaVersion) => {
      await store.create(record(30, schemaVersion));
      const before = await stored();
      const compactor = createCompactor({ store, limits: small });
      expect(await compactor.compactIfNeeded(RUN_ID, { bytesHigh: false })).toBe(true);
      const after = await stored();
      expect(after.revision).toBe(before.revision + 1);
      expect(after.schemaVersion).toBe(schemaVersion);
      expect(after.checkpoint?.throughSeq).toBe(27);
      expect(after.events.map((event) => event.seq)).toEqual([28, 29, 30, 31]);
      expect(checkLedgerInvariants(after)).toEqual({ ok: true });
      // Everything that is not history is as it was, field for field.
      const {
        events: _a,
        checkpoint: _b,
        counters: _c,
        revision: _d,
        previousDigest: _e,
        updatedAt: _f,
        ...rest
      } = after;
      const {
        events: _g,
        checkpoint: _h,
        counters: _i,
        revision: _j,
        previousDigest: _k,
        updatedAt: _l,
        ...was
      } = before;
      expect(rest).toEqual(was);
      // Asked again with nothing new to fold: no commit.
      expect(await compactor.compactIfNeeded(RUN_ID, { bytesHigh: false })).toBe(false);
      expect((await stored()).revision).toBe(after.revision);
    },
  );

  test("the second compaction's digest is chained to the first", async () => {
    await store.create(record(30));
    const compactor = createCompactor({ store, limits: small });
    await compactor.compactIfNeeded(RUN_ID, { bytesHigh: false });
    const first = (await stored()).checkpoint;
    // More history arrives, then the next compaction folds a second prefix.
    await store.update(RUN_ID, (current) => {
      for (let index = 0; index < 20; index += 1) {
        const seq = current.counters.eventsThroughSeq + 1;
        current.counters.eventsThroughSeq = seq;
        current.events.push({ seq, kind: "audit-note", at: at(40_000 + index), payload: {} });
      }
      return current;
    });
    const beforeSecond = await stored();
    await compactor.compactIfNeeded(RUN_ID, { bytesHigh: false });
    const second = (await stored()).checkpoint;
    expect(second?.throughSeq).toBeGreaterThan(first?.throughSeq ?? 0);
    const dropped = beforeSecond.events.filter((event) => event.seq <= (second?.throughSeq ?? 0));
    expect(second?.historyDigest).toBe(
      sha256Hex(JSON.stringify({ previous: first?.historyDigest, events: dropped })),
    );
  });

  test("a size problem alone triggers it, a short quiet history does not", async () => {
    await store.create(record(6));
    const compactor = createCompactor({ store, limits: small });
    expect(await compactor.compactIfNeeded(RUN_ID, { bytesHigh: false })).toBe(false);
    expect(await compactor.compactIfNeeded(RUN_ID, { bytesHigh: true })).toBe(true);
    expect((await stored()).checkpoint?.throughSeq).toBe(3);
  });

  test("a Run that cannot be written is left alone and the error does not escape", async () => {
    const logs: string[] = [];
    const compactor = createCompactor({
      store,
      limits: small,
      log: (message) => logs.push(message),
    });
    expect(await compactor.compactIfNeeded("run-nope00-a1", { bytesHigh: true })).toBe(false);
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe("the driver", () => {
  function driver(compactor?: ReturnType<typeof createCompactor>) {
    return createEngineDriver({
      store,
      observer: {
        ingest: async () => ({ status: "duplicate", runId: RUN_ID }) as never,
        flush: async () => ({ delivered: 0 }) as never,
        reconcile: async () => ({}) as never,
      },
      host: { replyWindow: async () => ({ complete: false, reason: "dispatch-not-found" }) },
      intake: { settleAgent: async () => [] },
      dagIntake: { settleCoordinator: async () => [] },
      service: { dispatchNext: async () => ({ status: "idle" as const }) },
      compactor,
    });
  }

  test("a pass compacts first, once, and a Run with little history is left alone", async () => {
    await store.create(record(30, 2, "active"));
    const before = await stored();
    await driver(createCompactor({ store, limits: small })).kick(RUN_ID);
    const after = await stored();
    expect(after.checkpoint?.throughSeq).toBe(27);
    expect(after.revision).toBe(before.revision + 1);
    await driver(createCompactor({ store, limits: small })).kick(RUN_ID);
    expect((await stored()).revision).toBe(after.revision);
  });

  test("without a compactor nothing is compacted", async () => {
    await store.create(record(30, 2, "active"));
    await driver().kick(RUN_ID);
    expect((await stored()).checkpoint).toBeUndefined();
  });
});

describe("the capacity guard", () => {
  const port: PaseoEnginePort = {
    agents: {
      ref: () => {
        throw new Error("no host call is expected before the guard decides");
      },
    },
  };

  function service(limits: Parameters<typeof createEngineService>[0]["capacityLimits"]) {
    return createEngineService({
      store,
      port,
      effects: {
        runOutbox: async () => ({
          status: "ok",
          sent: [],
          reconciled: [],
          unknown: [],
          failed: [],
        }),
      },
      resolveSeat: () => null,
      resolveWorkspace: () => null,
      compile: () => null,
      capacityLimits: limits,
    });
  }

  test("at a limit nothing new starts, with a critical alert written once", async () => {
    const value = record(1, 2, "active");
    // t2 is ready; the receipts are what is near the limit.
    await store.create(value);
    const receipts = (await stored()).eventReceipts.length;
    const guarded = service({ refuseAt: Math.max(1, receipts) });
    const first = await guarded.dispatchNext(RUN_ID);
    expect(first).toMatchObject({ status: "blocked", reason: "ledger-capacity" });
    const afterFirst = await stored();
    expect(afterFirst.alerts).toHaveLength(1);
    expect(afterFirst.alerts[0]).toMatchObject({ severity: "critical", state: "open" });
    expect(afterFirst.alerts[0]?.summary).toContain("已停止新的派发");
    await guarded.dispatchNext(RUN_ID);
    const afterSecond = await stored();
    expect(afterSecond.alerts).toHaveLength(1);
    expect(afterSecond.revision).toBe(afterFirst.revision);
  });

  test("below the limits the guard says nothing and writes nothing", async () => {
    await store.create(record(1, 2, "active"));
    const before = await stored();
    const result = await service(undefined).dispatchNext(RUN_ID);
    expect(result).not.toMatchObject({ reason: "ledger-capacity" });
    expect((await stored()).alerts).toEqual(before.alerts);
  });

  test("a Run that is not active is not guarded or touched", async () => {
    await store.create(record(1, 2, "paused"));
    const before = await stored();
    expect(await service({ refuseAt: 1 }).dispatchNext(RUN_ID)).toEqual({ status: "idle" });
    expect((await stored()).revision).toBe(before.revision);
  });
});

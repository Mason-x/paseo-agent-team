import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLifecycleControl } from "../../server/run-engine/lifecycle";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { readyRun } from "./support/ready-run";

const RUN_ID = "run-life01-a1";

let home: string;
let store: RunStore;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "run-life-"));
  store = createRunStore({ home, lock: { acquireTimeoutMs: 300 } });
  await store.initialize();
});

afterEach(async () => {
  await store.close().catch(() => undefined);
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function seed(lifecycle: RunRecord["lifecycle"] = "active") {
  const record = readyRun({ runId: RUN_ID });
  record.lifecycle = lifecycle;
  await store.create(record);
}

async function stored(): Promise<RunRecord> {
  const read = await store.get(RUN_ID);
  if (read.status !== "ok") throw new Error(`run unreadable: ${read.status}`);
  return read.record;
}

const kinds = (record: RunRecord) => record.events.map((event) => event.kind);

function control(retryRun = vi.fn(async () => ({}) as never)) {
  return {
    retryRun,
    ...createLifecycleControl({
      store,
      driver: { retryRun },
      clock: { now: () => "2026-11-08T12:00:00.000Z" },
    }),
  };
}

describe("pause", () => {
  test("an active Run is paused by the reducer's own event, once", async () => {
    await seed();
    const before = await stored();
    const out = await control().pause(RUN_ID);
    expect(out).toEqual({ status: "applied", lifecycle: "paused", revision: before.revision + 1 });
    const after = await stored();
    expect(after.lifecycle).toBe("paused");
    expect(kinds(after).filter((kind) => kind === "run-paused")).toHaveLength(1);
  });

  test("pausing a paused Run changes nothing, not even the revision", async () => {
    await seed("paused");
    const before = await stored();
    expect(await control().pause(RUN_ID)).toEqual({ status: "unchanged", lifecycle: "paused" });
    expect((await stored()).revision).toBe(before.revision);
  });

  test.each(["bootstrapping", "awaiting-dag", "finished", "cancelled"] as const)(
    "a %s Run is refused with its own lifecycle named, and nothing is written",
    async (lifecycle) => {
      await seed(lifecycle);
      const before = await stored();
      const out = await control().pause(RUN_ID);
      expect(out).toMatchObject({ status: "refused", lifecycle });
      expect((await stored()).revision).toBe(before.revision);
    },
  );

  test("two pauses at once write one event", async () => {
    await seed();
    const c = control();
    const [a, b] = await Promise.all([c.pause(RUN_ID), c.pause(RUN_ID)]);
    expect([a.status, b.status].sort()).toEqual(["applied", "unchanged"]);
    expect(kinds(await stored()).filter((kind) => kind === "run-paused")).toHaveLength(1);
  });

  test("a pause never pushes the Run", async () => {
    await seed();
    const c = control();
    await c.pause(RUN_ID);
    expect(c.retryRun).not.toHaveBeenCalled();
  });

  test("an unknown Run is unavailable, not a throw", async () => {
    expect(await control().pause("run-nosuch-a1")).toEqual({ status: "run-unavailable" });
  });
});

describe("resume", () => {
  test("a paused Run becomes active and the driver is asked to push it, as after a write", async () => {
    await seed("paused");
    const c = control();
    const out = await c.resume(RUN_ID);
    expect(out).toMatchObject({ status: "applied", lifecycle: "active" });
    expect((await stored()).lifecycle).toBe("active");
    expect(c.retryRun).toHaveBeenCalledTimes(1);
    expect(c.retryRun).toHaveBeenCalledWith(RUN_ID, { afterWrite: true });
  });

  test("resuming an active Run writes nothing and pushes nothing", async () => {
    await seed();
    const before = await stored();
    const c = control();
    expect(await c.resume(RUN_ID)).toEqual({ status: "unchanged", lifecycle: "active" });
    expect((await stored()).revision).toBe(before.revision);
    expect(c.retryRun).not.toHaveBeenCalled();
  });

  test.each(["bootstrapping", "awaiting-dag", "finished", "cancelled"] as const)(
    "a %s Run cannot be resumed",
    async (lifecycle) => {
      await seed(lifecycle);
      const c = control();
      expect(await c.resume(RUN_ID)).toMatchObject({ status: "refused", lifecycle });
      expect(c.retryRun).not.toHaveBeenCalled();
    },
  );

  test("a push that fails does not undo the resume", async () => {
    await seed("paused");
    const c = control(
      vi.fn(async () => {
        throw new Error("host down");
      }),
    );
    expect(await c.resume(RUN_ID)).toMatchObject({ status: "applied" });
    expect((await stored()).lifecycle).toBe("active");
  });

  test("pause then resume then pause is three transitions in the ledger, in order", async () => {
    await seed();
    const c = control();
    await c.pause(RUN_ID);
    await c.resume(RUN_ID);
    await c.pause(RUN_ID);
    const after = await stored();
    expect(after.lifecycle).toBe("paused");
    expect(
      kinds(after).filter((kind) => kind.startsWith("run-p") || kind === "run-resumed"),
    ).toEqual(["run-paused", "run-resumed", "run-paused"]);
  });
});

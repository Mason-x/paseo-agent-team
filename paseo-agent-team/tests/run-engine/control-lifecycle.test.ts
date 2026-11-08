import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createRunControl, LIFECYCLE_REQUEST_EVENT } from "../../server/run-engine/control";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import type { RunLifecycleInput } from "../../shared/schemas/run-engine/rpc-actions";
import { readyRun } from "./support/ready-run";

/**
 * Pause and resume as RPCs (A3), with a real store. Failure modes this file guards:
 *  - a pause or resume that is allowed from a lifecycle the ledger does not allow it from;
 *  - the same request applied twice, or a different request taken for a repeat;
 *  - the checks in the wrong order (a repeat that is answered as a stale revision);
 *  - a write that changes more than the lifecycle, the audit event and the counters, or that
 *    reserialises a v1 record as v2;
 *  - a resume that does not ask the driver to push the Run on, or a pause that does;
 *  - an answer that carries anything of the ledger beyond counts, ids and short codes.
 */

const RUN_ID = "run-life02-a1";
const NOW = "2026-11-08T12:00:00.000Z";

let home: string;
let store: RunStore;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "run-ctl-life-"));
  store = createRunStore({ home, lock: { acquireTimeoutMs: 300 } });
  await store.initialize();
});

afterEach(async () => {
  await store.close().catch(() => undefined);
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function seed(
  lifecycle: RunRecord["lifecycle"] = "active",
  schemaVersion: 1 | 2 = 2,
): Promise<void> {
  const record = { ...readyRun({ runId: RUN_ID }), schemaVersion };
  record.lifecycle = lifecycle;
  await store.create(record);
}

async function stored(): Promise<RunRecord> {
  const read = await store.get(RUN_ID);
  if (read.status !== "ok") throw new Error(`run unreadable: ${read.status}`);
  return read.record;
}

function control() {
  const retryRun = vi.fn(async () => ({}) as never);
  const made = createRunControl({
    store,
    ensureReady: async () => undefined,
    driver: { retryRun },
    clock: { now: () => NOW },
  });
  return { ...made, retryRun };
}

const request = (revision: number, extra: Partial<RunLifecycleInput> = {}): RunLifecycleInput => ({
  runContractVersion: 1,
  runId: RUN_ID,
  requestId: "req-1",
  expectedRevision: revision,
  reason: "from the page",
  ...extra,
});

const kinds = (record: RunRecord) => record.events.map((event) => event.kind);
const codeOf = (out: { issues: { code: string }[] }) => out.issues[0]?.code;

describe("pause", () => {
  test("an active Run is paused: one step, the reducer's event plus the audit event", async () => {
    await seed();
    const before = await stored();
    const c = control();
    const out = await c.pause(request(before.revision));
    expect(out).toEqual({
      runContractVersion: 1,
      status: "applied",
      revision: before.revision + 1,
      lifecycle: "paused",
      issues: [],
    });
    await c.idle();
    const after = await stored();
    expect(after.lifecycle).toBe("paused");
    expect(kinds(after).slice(before.events.length)).toEqual([
      "run-paused",
      LIFECYCLE_REQUEST_EVENT,
    ]);
    expect(after.events.at(-1)?.payload).toEqual({
      requestId: "req-1",
      action: "pause",
      reason: "from the page",
    });
    // A pause moves nothing on.
    expect(c.retryRun).not.toHaveBeenCalled();
  });

  test("the same request again is the same request: replayed, nothing written", async () => {
    await seed();
    const c = control();
    const first = await c.pause(request((await stored()).revision));
    const written = await stored();
    const again = await c.pause(request(written.revision - 1));
    expect(again).toMatchObject({
      status: "replayed",
      revision: written.revision,
      lifecycle: "paused",
    });
    expect(first.status).toBe("applied");
    const after = await stored();
    expect(after.revision).toBe(written.revision);
    expect(kinds(after).filter((kind) => kind === LIFECYCLE_REQUEST_EVENT)).toHaveLength(1);
  });

  test("a repeat is found before the revision is checked, so a Run that moved on still answers replayed", async () => {
    await seed();
    const c = control();
    await c.pause(request((await stored()).revision));
    await c.resume(request((await stored()).revision, { requestId: "req-2" }));
    // The Run is active again and its revision is far from the one of the first request.
    const out = await c.pause(request(1));
    expect(out.status).toBe("replayed");
  });

  test("the same id for another reason, or for the other action, is request-id-reused", async () => {
    await seed();
    const c = control();
    await c.pause(request((await stored()).revision));
    const revision = (await stored()).revision;
    expect(codeOf(await c.pause(request(revision, { reason: "another reason" })))).toBe(
      "request-id-reused",
    );
    expect(codeOf(await c.resume(request(revision)))).toBe("request-id-reused");
    expect((await stored()).revision).toBe(revision);
  });

  test("an old revision is refused with the current one, and nothing is written", async () => {
    await seed();
    const before = await stored();
    const out = await control().pause(request(before.revision + 3));
    expect(out).toMatchObject({
      status: "rejected",
      revision: before.revision,
      lifecycle: "active",
    });
    expect(out.issues[0]).toMatchObject({
      code: "revision-conflict",
      params: { current: before.revision },
      action: "refresh",
    });
    expect((await stored()).revision).toBe(before.revision);
  });

  test.each(["bootstrapping", "awaiting-dag", "paused", "finished", "cancelled"] as const)(
    "a %s Run cannot be paused: lifecycle-not-allowed names the lifecycle and nothing is written",
    async (lifecycle) => {
      await seed(lifecycle);
      const before = await stored();
      const out = await control().pause(request(before.revision));
      expect(out).toMatchObject({ status: "rejected", lifecycle });
      expect(out.issues[0]).toMatchObject({ code: "lifecycle-not-allowed", params: { lifecycle } });
      expect(await stored()).toEqual(before);
    },
  );

  test("a Run that is not there is an answer with a code, not a throw", async () => {
    const out = await control().pause(request(1, { runId: "run-nosuch-a1" }));
    expect(out).toMatchObject({ status: "rejected", revision: 0, lifecycle: null });
    expect(codeOf(out)).toBe("run-missing");
  });
});

describe("resume", () => {
  test("a paused Run becomes active and the driver is asked to push it on, as after a write", async () => {
    await seed("paused");
    const before = await stored();
    const c = control();
    const out = await c.resume(request(before.revision));
    expect(out).toMatchObject({
      status: "applied",
      revision: before.revision + 1,
      lifecycle: "active",
    });
    await c.idle();
    expect((await stored()).lifecycle).toBe("active");
    expect(c.retryRun).toHaveBeenCalledTimes(1);
    expect(c.retryRun).toHaveBeenCalledWith(RUN_ID, { afterWrite: true });
    const after = await stored();
    expect(kinds(after).slice(before.events.length)).toEqual([
      "run-resumed",
      LIFECYCLE_REQUEST_EVENT,
    ]);
  });

  test("a repeat of a resume does not push again", async () => {
    await seed("paused");
    const c = control();
    await c.resume(request((await stored()).revision));
    await c.idle();
    const again = await c.resume(request(1));
    await c.idle();
    expect(again.status).toBe("replayed");
    expect(c.retryRun).toHaveBeenCalledTimes(1);
  });

  test.each(["bootstrapping", "awaiting-dag", "active", "finished", "cancelled"] as const)(
    "a %s Run cannot be resumed and the driver is not asked",
    async (lifecycle) => {
      await seed(lifecycle);
      const before = await stored();
      const c = control();
      const out = await c.resume(request(before.revision));
      await c.idle();
      expect(codeOf(out)).toBe("lifecycle-not-allowed");
      expect(c.retryRun).not.toHaveBeenCalled();
      expect(await stored()).toEqual(before);
    },
  );

  test("a push that fails does not undo the resume", async () => {
    await seed("paused");
    const retryRun = vi.fn(async () => {
      throw new Error("host down");
    });
    const c = createRunControl({
      store,
      ensureReady: async () => undefined,
      driver: { retryRun },
      clock: { now: () => NOW },
    });
    expect((await c.resume(request((await stored()).revision))).status).toBe("applied");
    await c.idle();
    expect((await stored()).lifecycle).toBe("active");
  });
});

describe("what a write changes", () => {
  test.each([1, 2] as const)(
    "a pause and a resume of a v%s record change only the lifecycle, the audit trail and the counters, and keep the version",
    async (version) => {
      await seed("active", version);
      const before = await stored();
      const c = control();
      await c.pause(request(before.revision));
      await c.resume(request((await stored()).revision, { requestId: "req-2" }));
      await c.idle();
      const after = await stored();
      expect(after.schemaVersion).toBe(version);
      expect(after.lifecycle).toBe("active");
      const strip = (record: RunRecord) => {
        const copy: Record<string, unknown> = structuredClone(record) as never;
        for (const key of ["revision", "previousDigest", "updatedAt", "events", "counters"]) {
          delete copy[key];
        }
        return copy;
      };
      expect(strip(after)).toEqual(strip(before));
      expect(after.events.slice(0, before.events.length)).toEqual(before.events);
      expect(after.counters.eventsThroughSeq).toBe(before.counters.eventsThroughSeq + 4);
    },
  );

  test("the answer names counts, ids and codes only", async () => {
    await seed();
    const out = await control().pause(request((await stored()).revision));
    expect(Object.keys(out).sort()).toEqual([
      "issues",
      "lifecycle",
      "revision",
      "runContractVersion",
      "status",
    ]);
    const text = JSON.stringify(out);
    for (const secret of ["nonce", "prompt", "semanticArgs", "outbox"]) {
      expect(text).not.toContain(secret);
    }
  });
});

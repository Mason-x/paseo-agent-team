import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { confirmDesignJobsContainment, resolveDesignDataRoot } from "../server/designer/data-root";
import {
  createDesignJobStore,
  createProcessLiveness,
  DESIGN_RECORD_MAX_BYTES,
  DESIGN_RECORD_VERSION,
  type DesignStoreFs,
  type StoredDesignJob,
} from "../server/designer/store";
import { DESIGN_HASH, DESIGN_JOB_ID, designJob, designResult } from "./design-fixtures";

const homes: string[] = [];
const NOW = "2026-10-26T00:00:00.000Z";
const clock = { now: () => NOW };
let sequence = 0;
const ids = { next: () => `id-${++sequence}` };

async function home(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-design-ledger-"));
  homes.push(directory);
  return directory;
}

function record(
  jobId = DESIGN_JOB_ID,
  revision = "33333333-3333-4333-8333-333333333333",
): StoredDesignJob {
  return {
    schemaVersion: DESIGN_RECORD_VERSION,
    job: designJob({ jobId, stateRevision: revision, attempt: 1 }),
    request: "给后台做一次改版",
    requestHash: DESIGN_HASH,
    mode: "sota",
    selectionIntent: null,
    creation: null,
    attempts: [
      {
        attempt: 1,
        nonce: "b".repeat(32),
        messageId: "55555555-5555-4555-8555-555555555555",
        promptHash: DESIGN_HASH,
        epoch: "epoch-1",
        endCursor: null,
        summary: null,
        ack: "pending",
      },
    ],
    proposal: { raw: true },
    result: null,
    reuseFingerprints: {},
    leaseOwner: null,
    receipts: { [designJob().clientRequestId]: jobId },
    outcomeUnknown: false,
  };
}

function jobsDirectory(directory: string): string {
  return path.join(directory, "agent-team-designer", "v1", "jobs");
}

function rootDirectory(directory: string): string {
  return path.join(directory, "agent-team-designer", "v1");
}

function lockRecord(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    ownerToken: "old-owner",
    pid: 9,
    startedAt: NOW,
    processStartedAt: null,
    ...overrides,
  });
}

async function writeLock(directory: string, name: string, content: string): Promise<void> {
  await mkdir(rootDirectory(directory), { recursive: true });
  await writeFile(path.join(rootDirectory(directory), name), content, "utf8");
}

function realFs(overrides: Partial<DesignStoreFs> = {}): DesignStoreFs {
  return {
    mkdir: async (target) => {
      await mkdir(target, { recursive: true });
    },
    readFile: (target) => readFile(target, "utf8"),
    writeFile: async (target, content) => {
      await writeFile(target, content, "utf8");
    },
    rename,
    rm: (target) => rm(target, { force: true }),
    readdir,
    openExclusive: async (target, content) => {
      const handle = await open(target, "wx");
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    ...overrides,
  };
}

function latch(parties: number): { wait(): Promise<void> } {
  let arrived = 0;
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    async wait() {
      arrived += 1;
      if (arrived === parties) release();
      await released;
    },
  };
}

afterEach(async () => {
  sequence = 0;
  await Promise.all(
    homes.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("design job ledger", () => {
  test("writes atomically and keeps one file per job", async () => {
    const directory = await home();
    const store = createDesignJobStore({
      home: directory,
      clock,
      ids,
      pid: 10,
      processes: { isAlive: () => false },
    });
    await store.initialize();
    const first = record();
    await store.create(first);
    const jobs = path.join(directory, "agent-team-designer", "v1", "jobs");
    expect(await readFile(path.join(jobs, `${DESIGN_JOB_ID}.json`), "utf8")).toContain(
      DESIGN_JOB_ID,
    );
    expect((await store.list()).map((item) => item.job.jobId)).toEqual([DESIGN_JOB_ID]);
    await expect(store.create(first)).rejects.toMatchObject({ issue: "exists" });
  }, 10000);

  test("removes the temporary file when rename keeps failing", async () => {
    const directory = await home();
    const failing: DesignStoreFs = {
      mkdir: async (target) => {
        await mkdir(target, { recursive: true });
      },
      readFile: (target) => readFile(target, "utf8"),
      writeFile: async (target, content) => {
        await writeFile(target, content, "utf8");
      },
      rename: () => Promise.reject(new Error("busy")),
      rm: (target) => rm(target, { force: true }),
      readdir,
      openExclusive: async (target, content) => {
        const handle = await open(target, "wx");
        await handle.writeFile(content);
        await handle.close();
      },
    };
    const store = createDesignJobStore({
      home: directory,
      fs: failing,
      clock,
      ids,
      pid: 10,
      processes: { isAlive: () => false },
    });
    await store.initialize();
    await expect(store.create(record())).rejects.toThrow("busy");
    const jobs = path.join(directory, "agent-team-designer", "v1", "jobs");
    const names = await readdir(jobs);
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(names.filter((name) => name.endsWith(".json"))).toEqual([]);
  }, 10000);

  test("rejects revision conflicts and unknown record versions", async () => {
    const directory = await home();
    const store = createDesignJobStore({
      home: directory,
      clock,
      ids,
      pid: 10,
      processes: { isAlive: () => false },
    });
    await store.initialize();
    const current = record();
    await store.create(current);
    const next = record(DESIGN_JOB_ID, "66666666-6666-4666-8666-666666666666");
    await expect(store.update(DESIGN_JOB_ID, "stale", next)).rejects.toMatchObject({
      issue: "conflict",
    });
    const file = path.join(directory, "agent-team-designer", "v1", "jobs", `${DESIGN_JOB_ID}.json`);
    await writeFile(file, JSON.stringify({ ...current, schemaVersion: 2 }), "utf8");
    expect(await store.problems()).toEqual([
      { name: `${DESIGN_JOB_ID}.json`, reason: "unknown-version" },
    ]);
    expect(await store.list()).toEqual([]);
  }, 10000);

  test("keeps the request hash after a terminal record drops its proposal", async () => {
    const directory = await home();
    const store = createDesignJobStore({
      home: directory,
      clock,
      ids,
      pid: 10,
      processes: { isAlive: () => false },
    });
    await store.initialize();
    const current = record();
    await store.create(current);
    const finished = record();
    finished.job = {
      ...finished.job,
      state: "saved",
      stateRevision: "77777777-7777-4777-8777-777777777777",
    };
    await store.update(DESIGN_JOB_ID, current.job.stateRevision, finished);
    const stored = await store.get(DESIGN_JOB_ID);
    expect(stored?.proposal).toBeNull();
    expect(stored?.requestHash).toBe(DESIGN_HASH);
    expect(stored?.receipts[current.job.clientRequestId]).toBe(DESIGN_JOB_ID);
  }, 10000);

  test("refuses a missing, relative, or escaped home and a symlinked jobs directory", async () => {
    await expect(
      createDesignJobStore({ home: undefined, clock, ids }).initialize(),
    ).rejects.toMatchObject({ issue: "unavailable" });
    await expect(
      createDesignJobStore({ home: "relative-home", clock, ids }).initialize(),
    ).rejects.toMatchObject({ issue: "unavailable" });
    const directory = await home();
    const outside = await home();
    const jobs = path.join(directory, "agent-team-designer", "v1", "jobs");
    await mkdir(path.dirname(jobs), { recursive: true });
    await symlink(outside, jobs, "junction");
    const root = await resolveDesignDataRoot(directory);
    await expect(confirmDesignJobsContainment(root)).rejects.toMatchObject({ reason: "escape" });
    expect((await lstat(jobs)).isSymbolicLink()).toBe(true);
    await expect(
      createDesignJobStore({ home: directory, clock, ids, pid: 10 }).initialize(),
    ).rejects.toMatchObject({ issue: "unavailable" });
  }, 10000);

  test("does not take a lock whose owner is alive or unverifiable", async () => {
    const directory = await home();
    const first = createDesignJobStore({
      home: directory,
      clock,
      ids,
      pid: 41,
      processes: { isAlive: () => false },
    });
    await first.initialize();
    const running = createDesignJobStore({
      home: directory,
      clock,
      ids,
      pid: 42,
      processes: { isAlive: () => true },
    });
    await expect(running.initialize()).rejects.toMatchObject({ issue: "unavailable" });
    const unknown = createDesignJobStore({
      home: directory,
      clock,
      ids,
      pid: 43,
      processes: { isAlive: () => "unknown" },
    });
    await expect(unknown.initialize()).rejects.toMatchObject({ issue: "unavailable" });
  }, 10000);

  test("rejects unsafe ids, invalid writes, and terminal resurrection", async () => {
    const directory = await home();
    const store = createDesignJobStore({
      home: directory,
      clock,
      ids,
      pid: 10,
      processes: { isAlive: () => false },
    });
    await store.initialize();
    expect(await store.get("../outside")).toBeNull();
    const current = record();
    await store.create(current);
    await expect(
      store.update(DESIGN_JOB_ID, current.job.stateRevision, {
        ...current,
        mode: "nonsense",
      } as unknown as StoredDesignJob),
    ).rejects.toMatchObject({ issue: "corrupt" });
    const saved = record();
    saved.job = {
      ...saved.job,
      state: "saved",
      stateRevision: "77777777-7777-4777-8777-777777777777",
    };
    await store.update(DESIGN_JOB_ID, current.job.stateRevision, saved);
    const revived = record();
    revived.job = {
      ...revived.job,
      state: "designing",
      stateRevision: "88888888-8888-4888-8888-888888888888",
    };
    await expect(
      store.update(DESIGN_JOB_ID, saved.job.stateRevision, revived),
    ).rejects.toMatchObject({ issue: "conflict" });
    await store.dispose();
    const reopened = createDesignJobStore({
      home: directory,
      clock,
      ids,
      pid: 11,
      processes: { isAlive: () => false },
    });
    await reopened.initialize();
    expect((await reopened.get(DESIGN_JOB_ID))?.job.state).toBe("saved");
  }, 10000);

  test("reclaims a dead lock with exactly one winner on the real filesystem", async () => {
    const directory = await home();
    await writeLock(directory, ".lock", lockRecord());
    const barrier = latch(2);
    const files = realFs({
      async openExclusive(target, content) {
        if (target.endsWith(".lock.reclaim")) await barrier.wait();
        const handle = await open(target, "wx");
        try {
          await handle.writeFile(content, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      },
    });
    const processes = { isAlive: (candidate: number) => candidate !== 9 };
    const make = (pid: number) =>
      createDesignJobStore({ home: directory, fs: files, clock, ids, pid, processes });
    const results = await Promise.allSettled([make(11).initialize(), make(12).initialize()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toMatchObject({ issue: "unavailable" });
    }
    const winner = results.findIndex((result) => result.status === "fulfilled");
    const lock = JSON.parse(
      await readFile(path.join(rootDirectory(directory), ".lock"), "utf8"),
    ) as { pid: number };
    expect(lock.pid).toBe(winner === 0 ? 11 : 12);
    expect(
      (await readdir(rootDirectory(directory))).some((name) => name.startsWith(".lock.stale-")),
    ).toBe(false);
  }, 10000);

  test("reclaims a dead lock and sweeps stale lock artifacts", async () => {
    const directory = await home();
    await writeLock(directory, ".lock", lockRecord());
    await writeLock(directory, ".lock.stale-old", lockRecord());
    await writeLock(directory, ".lock.reclaim.stale-old", lockRecord());
    const store = createDesignJobStore({
      home: directory,
      clock,
      ids,
      pid: 10,
      processes: { isAlive: () => false },
    });
    await store.initialize();
    const lock = JSON.parse(
      await readFile(path.join(rootDirectory(directory), ".lock"), "utf8"),
    ) as {
      ownerToken: string;
      pid: number;
    };
    expect(lock.pid).toBe(10);
    expect(lock.ownerToken).not.toBe("old-owner");
    const rootNames = await readdir(rootDirectory(directory));
    expect(rootNames).not.toContain(".lock.stale-old");
    expect(rootNames).not.toContain(".lock.reclaim.stale-old");
    await store.create(record());
    expect((await store.get(DESIGN_JOB_ID))?.job.jobId).toBe(DESIGN_JOB_ID);
  }, 10000);

  test("does not steal a live guard and tolerates a stale guard", async () => {
    const directory = await home();
    await writeLock(directory, ".lock", lockRecord());
    await writeLock(directory, ".lock.reclaim", lockRecord({ pid: 77, startedAt: NOW }));
    const liveGuard = createDesignJobStore({
      home: directory,
      clock,
      ids,
      pid: 10,
      processes: {
        isAlive: (candidate) => candidate === 77,
        startedAt: () => null,
      },
    });
    await expect(liveGuard.initialize()).rejects.toMatchObject({ issue: "unavailable" });
    expect(await readFile(path.join(rootDirectory(directory), ".lock"), "utf8")).toContain(
      "old-owner",
    );

    await writeLock(
      directory,
      ".lock.reclaim",
      lockRecord({ pid: 77, startedAt: "2020-01-01T00:00:00.000Z" }),
    );
    const staleGuard = createDesignJobStore({
      home: directory,
      clock,
      ids,
      pid: 10,
      processes: {
        isAlive: (candidate) => candidate === 77,
        startedAt: () => null,
      },
    });
    await staleGuard.initialize();
    expect(
      (await readdir(rootDirectory(directory))).some((name) =>
        name.startsWith(".lock.reclaim.stale-"),
      ),
    ).toBe(false);
  }, 10000);

  test("compares process start times as the same quantity and fails closed when unavailable", async () => {
    const start = "2026-01-01T00:00:00.000Z";
    const make = async (actual: string | null, recorded: string | null = start) => {
      const directory = await home();
      await writeLock(directory, ".lock", lockRecord({ pid: 42, processStartedAt: recorded }));
      return createDesignJobStore({
        home: directory,
        clock,
        ids,
        pid: 10,
        processes: {
          isAlive: (candidate) => candidate === 42,
          startedAt: (candidate) => (candidate === 42 ? actual : null),
        },
      }).initialize();
    };
    await expect(make(start)).rejects.toMatchObject({ issue: "unavailable" });
    await expect(make(null)).rejects.toMatchObject({ issue: "unavailable" });
    await expect(make(start, null)).rejects.toMatchObject({ issue: "unavailable" });
    await expect(make("2026-02-01T00:00:00.000Z")).resolves.toBeUndefined();
  }, 10000);

  test("reinitializes after dispose and tolerates a missing lock on dispose", async () => {
    const directory = await home();
    const store = createDesignJobStore({
      home: directory,
      clock,
      ids,
      pid: 10,
      processes: { isAlive: () => false },
    });
    await store.initialize();
    await store.create(record());
    await store.dispose();
    await store.initialize();
    expect((await store.get(DESIGN_JOB_ID))?.job.jobId).toBe(DESIGN_JOB_ID);
    await rm(path.join(rootDirectory(directory), ".lock"), { force: true });
    await expect(store.dispose()).resolves.toBeUndefined();
    await store.initialize();
    expect((await store.get(DESIGN_JOB_ID))?.job.jobId).toBe(DESIGN_JOB_ID);
    await writeLock(directory, ".lock", "not-json");
    await expect(store.dispose()).resolves.toBeUndefined();
  }, 10000);

  test("default process liveness distinguishes alive, ESRCH, EPERM, and same-pid startup", () => {
    const liveness = createProcessLiveness((pid) => {
      if (pid === 1) return;
      if (pid === 2) throw Object.assign(new Error("denied"), { code: "EPERM" });
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    expect(liveness.isAlive(1)).toBe(true);
    expect(liveness.isAlive(2)).toBe("unknown");
    expect(liveness.isAlive(3)).toBe(false);
    expect(liveness.startedAt?.(process.pid)).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(liveness.startedAt?.(process.pid + 1)).toBeNull();
  });

  test("rejects corrupt or unreadable lock files without overwriting them", async () => {
    const directory = await home();
    await writeLock(directory, ".lock", "not-json");
    const invalid = createDesignJobStore({
      home: directory,
      clock,
      ids,
      pid: 10,
      processes: { isAlive: () => false },
    });
    await expect(invalid.initialize()).rejects.toMatchObject({ issue: "unavailable" });
    expect(await readFile(path.join(rootDirectory(directory), ".lock"), "utf8")).toBe("not-json");

    await writeLock(directory, ".lock", lockRecord({ version: 2 }));
    const schema = createDesignJobStore({
      home: directory,
      clock,
      ids,
      pid: 10,
      processes: { isAlive: () => false },
    });
    await expect(schema.initialize()).rejects.toMatchObject({ issue: "unavailable" });

    await writeLock(directory, ".lock", lockRecord());
    const unreadable = createDesignJobStore({
      home: directory,
      fs: realFs({
        readFile: async (target) => {
          if (target.endsWith(".lock")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
          return readFile(target, "utf8");
        },
      }),
      clock,
      ids,
      pid: 10,
      processes: { isAlive: () => false },
    });
    await expect(unreadable.initialize()).rejects.toMatchObject({ issue: "unavailable" });
  }, 10000);

  test("allows exactly one concurrent create and one concurrent update", async () => {
    const directory = await home();
    const store = createDesignJobStore({
      home: directory,
      clock,
      ids,
      pid: 10,
      processes: { isAlive: () => false },
    });
    await store.initialize();
    const creates = await Promise.allSettled([store.create(record()), store.create(record())]);
    expect(creates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(creates.filter((result) => result.status === "rejected")).toHaveLength(1);
    const first = record(DESIGN_JOB_ID, "77777777-7777-4777-8777-777777777777");
    const second = record(DESIGN_JOB_ID, "88888888-8888-4888-8888-888888888888");
    const updates = await Promise.allSettled([
      store.update(DESIGN_JOB_ID, record().job.stateRevision, first),
      store.update(DESIGN_JOB_ID, record().job.stateRevision, second),
    ]);
    expect(updates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(updates.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(
      store.update("99999999-9999-4999-8999-999999999999", record().job.stateRevision, record()),
    ).rejects.toMatchObject({ issue: "missing" });
  }, 10000);

  test("enforces record size, receipt monotonicity, and terminal proposal cleanup", async () => {
    const directory = await home();
    const store = createDesignJobStore({
      home: directory,
      clock,
      ids,
      pid: 10,
      processes: { isAlive: () => false },
    });
    await store.initialize();
    const tooLarge = record();
    tooLarge.request = "x".repeat(DESIGN_RECORD_MAX_BYTES);
    await expect(store.create(tooLarge)).rejects.toMatchObject({ issue: "too-large" });
    expect(await store.get(DESIGN_JOB_ID)).toBeNull();

    const current = record();
    await store.create(current);
    const oversizedUpdate = record(DESIGN_JOB_ID, "77777777-7777-4777-8777-777777777777");
    oversizedUpdate.request = "x".repeat(DESIGN_RECORD_MAX_BYTES);
    await expect(
      store.update(DESIGN_JOB_ID, current.job.stateRevision, oversizedUpdate),
    ).rejects.toMatchObject({ issue: "too-large" });

    const noReceipts = record(DESIGN_JOB_ID, "88888888-8888-4888-8888-888888888888");
    noReceipts.receipts = {};
    await expect(
      store.update(DESIGN_JOB_ID, current.job.stateRevision, noReceipts),
    ).rejects.toMatchObject({ issue: "conflict" });

    for (const state of ["failed", "canceled"] as const) {
      const jobId =
        state === "failed"
          ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
          : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const terminal = record(jobId, "77777777-7777-4777-8777-777777777777");
      terminal.job = {
        ...terminal.job,
        state,
        stateRevision: "99999999-9999-4999-8999-999999999999",
      };
      terminal.result = designResult({ jobId });
      await store.create(record(jobId));
      await store.update(jobId, record(jobId).job.stateRevision, terminal);
      const stored = await store.get(jobId);
      expect(stored?.proposal).toBeNull();
      expect(stored?.request).toBe(terminal.request);
      expect(stored?.receipts).toEqual(terminal.receipts);
      expect(stored?.result?.jobId).toBe(jobId);
    }
  }, 10000);

  test("retries rename with backoff, cleans temp files, and never overwrites on read errors", async () => {
    const directory = await home();
    let renames = 0;
    const sleeps: number[] = [];
    const store = createDesignJobStore({
      home: directory,
      fs: realFs({
        async rename(from, to) {
          if (from.endsWith(".tmp")) {
            renames += 1;
            if (renames < 3) throw Object.assign(new Error("busy"), { code: "EBUSY" });
          }
          await rename(from, to);
        },
      }),
      clock,
      ids,
      pid: 10,
      processes: { isAlive: () => false },
      sleep: {
        async sleep(milliseconds) {
          sleeps.push(milliseconds);
        },
      },
    });
    await store.initialize();
    await store.create(record());
    expect(renames).toBe(3);
    expect(sleeps).toEqual([10, 20]);

    const failingDirectory = await home();
    const failingWrite = createDesignJobStore({
      home: failingDirectory,
      fs: realFs({
        writeFile: async () => {
          throw Object.assign(new Error("full"), { code: "ENOSPC" });
        },
      }),
      clock,
      ids,
      pid: 10,
      processes: { isAlive: () => false },
    });
    await failingWrite.initialize();
    await expect(failingWrite.create(record())).rejects.toThrow("full");
    expect(
      (await readdir(jobsDirectory(failingDirectory))).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  }, 10000);

  test("does not overwrite an existing job when reading it fails, and reports corrupt requests", async () => {
    const directory = await home();
    const normal = createDesignJobStore({
      home: directory,
      clock,
      ids,
      pid: 10,
      processes: { isAlive: () => false },
    });
    await normal.initialize();
    const current = record();
    await normal.create(current);
    const file = path.join(jobsDirectory(directory), `${DESIGN_JOB_ID}.json`);
    const before = await readFile(file, "utf8");
    const busy = createDesignJobStore({
      home: directory,
      fs: realFs({
        readFile: async (target) => {
          if (target.endsWith(`${DESIGN_JOB_ID}.json`)) {
            throw Object.assign(new Error("busy"), { code: "EBUSY" });
          }
          return readFile(target, "utf8");
        },
      }),
      clock,
      ids,
      pid: 11,
      processes: { isAlive: () => false },
    });
    await busy.initialize();
    await expect(busy.create(current)).rejects.toMatchObject({ issue: "unavailable" });
    expect(await readFile(file, "utf8")).toBe(before);

    const corruptId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await writeFile(
      path.join(jobsDirectory(directory), `${corruptId}.json`),
      JSON.stringify({ job: { clientRequestId: current.job.clientRequestId } }),
      "utf8",
    );
    await expect(normal.findRequest(current.job.clientRequestId)).rejects.toMatchObject({
      issue: "corrupt",
    });
    expect(await normal.problems()).toEqual(
      expect.arrayContaining([{ name: `${corruptId}.json`, reason: "corrupt" }]),
    );
  }, 10000);
  test("finds requests, skips temp files, reports malformed names, and rejects unsafe ids", async () => {
    const directory = await home();
    const jobs = jobsDirectory(directory);
    await mkdir(jobs, { recursive: true });
    const staleTemp = path.join(jobs, `.${DESIGN_JOB_ID}.deadbeef.tmp`);
    await writeFile(staleTemp, "partial", "utf8");
    const store = createDesignJobStore({
      home: directory,
      clock,
      ids,
      pid: 10,
      processes: { isAlive: () => false },
    });
    await store.initialize();
    expect(await readdir(jobs)).not.toContain(path.basename(staleTemp));

    const current = record();
    await store.create(current);
    expect((await store.findRequest(current.job.clientRequestId))?.job.jobId).toBe(DESIGN_JOB_ID);
    expect(await store.findRequest("dddddddd-dddd-4ddd-8ddd-dddddddddddd")).toBeNull();
    const temporary = path.join(jobs, `.${DESIGN_JOB_ID}.12345678.tmp`);
    await writeFile(temporary, "partial", "utf8");
    expect((await store.list()).map((item) => item.job.jobId)).toEqual([DESIGN_JOB_ID]);

    const wrongName = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await writeFile(path.join(jobs, `${wrongName}.json`), JSON.stringify(current), "utf8");
    expect(await store.problems()).toEqual(
      expect.arrayContaining([{ name: `${wrongName}.json`, reason: "corrupt" }]),
    );
    expect(await store.get("A".concat(DESIGN_JOB_ID.slice(1)))).toBeNull();
    expect(await store.get("a/b")).toBeNull();
    expect(await store.get("C:\\outside")).toBeNull();
    const other = record("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await expect(
      store.update(DESIGN_JOB_ID, current.job.stateRevision, other),
    ).rejects.toMatchObject({ issue: "conflict" });
  }, 10000);
  test("unrelated new-version and corrupt records do not block a new request", async () => {
    const directory = await home();
    const jobs = jobsDirectory(directory);
    await mkdir(jobs, { recursive: true });
    const oldRequest = "99999999-9999-4999-8999-999999999999";
    await writeFile(
      path.join(jobs, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json"),
      JSON.stringify({
        ...record("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        schemaVersion: 2,
        job: {
          ...record().job,
          jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          clientRequestId: oldRequest,
        },
      }),
      "utf8",
    );
    await writeFile(path.join(jobs, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.json"), "{bad", "utf8");
    const store = createDesignJobStore({
      home: directory,
      clock,
      ids,
      pid: 10,
      processes: { isAlive: () => false },
    });
    await store.initialize();
    const newRequest = "77777777-7777-4777-8777-777777777777";
    expect(await store.findRequest(newRequest)).toBeNull();
    const fresh = record("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    fresh.job = { ...fresh.job, clientRequestId: newRequest };
    await store.create(fresh);
    expect((await store.findRequest(newRequest))?.job.jobId).toBe(fresh.job.jobId);
    await expect(store.findRequest(oldRequest)).rejects.toMatchObject({ issue: "unknown-version" });
  }, 10000);
  test("takes over one stale guard with exactly one winner", async () => {
    const directory = await home();
    await writeLock(directory, ".lock", lockRecord());
    await writeLock(
      directory,
      ".lock.reclaim",
      lockRecord({ pid: 77, startedAt: "2020-01-01T00:00:00.000Z" }),
    );
    const barrier = latch(2);
    const files = realFs({
      async rename(from, to) {
        if (from.endsWith(".lock.reclaim")) await barrier.wait();
        await rename(from, to);
      },
    });
    const processes = {
      isAlive: (candidate: number) => candidate !== 9,
      startedAt: () => null,
    };
    const make = (pid: number) =>
      createDesignJobStore({ home: directory, fs: files, clock, ids, pid, processes });
    const results = await Promise.allSettled([make(21).initialize(), make(22).initialize()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = results.findIndex((result) => result.status === "fulfilled");
    const lock = JSON.parse(
      await readFile(path.join(rootDirectory(directory), ".lock"), "utf8"),
    ) as { pid: number };
    expect(lock.pid).toBe(winner === 0 ? 21 : 22);
  }, 10000);

  test("reclaims a lock left before the current boot and explains an unverifiable live lock", async () => {
    const lockPath = (directory: string) => path.join(rootDirectory(directory), ".lock");
    const old = await home();
    await writeLock(
      old,
      ".lock",
      lockRecord({
        pid: 42,
        startedAt: "2020-01-01T00:00:00.000Z",
        processStartedAt: "2020-01-01T00:00:01.000Z",
      }),
    );
    const bootedLater = createDesignJobStore({
      home: old,
      clock,
      ids,
      pid: 10,
      bootTime: () => Date.parse(NOW),
      processes: { isAlive: () => true, startedAt: () => null },
    });
    await expect(bootedLater.initialize()).resolves.toBeUndefined();

    const suspect = await home();
    await writeLock(
      suspect,
      ".lock",
      lockRecord({
        pid: 42,
        startedAt: "2020-01-01T00:00:00.000Z",
        processStartedAt: new Date(Date.parse(NOW) + 60_000).toISOString(),
      }),
    );
    const notBeforeBoot = createDesignJobStore({
      home: suspect,
      clock,
      ids,
      pid: 10,
      bootTime: () => Date.parse(NOW),
      processes: { isAlive: () => true, startedAt: () => null },
    });
    await expect(notBeforeBoot.initialize()).rejects.toMatchObject({ issue: "unavailable" });

    const live = await home();
    await writeLock(live, ".lock", lockRecord({ pid: 42 }));
    const refused = createDesignJobStore({
      home: live,
      clock,
      ids,
      pid: 10,
      bootTime: () => Date.parse(NOW) - 60 * 60_000,
      processes: { isAlive: () => true, startedAt: () => null },
    });
    const error = await refused.initialize().catch((reason: unknown) => reason);
    expect(error).toMatchObject({ issue: "unavailable" });
    expect((error as { detail?: string }).detail).toContain(lockPath(live));
    expect((error as { detail?: string }).detail).toContain("pid 42");
  }, 10000);

  test("keeps the default process start stable across repeated queries", () => {
    const liveness = createProcessLiveness(() => undefined);
    expect(liveness.startedAt?.(process.pid)).toBe(liveness.startedAt?.(process.pid));
  });
});

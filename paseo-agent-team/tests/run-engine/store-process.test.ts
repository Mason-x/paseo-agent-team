// Real-process tests: a crash is a genuine process exit at a chosen file-system step, and lock
// contention is a second live process. The child entry is bundled with rolldown (already a
// dependency of vitest) so no TypeScript runner is needed.
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createRunStore } from "../../server/run-engine/store";
import { assignmentsForRun, noncesForRun, withLedger } from "../fixtures/run-engine/base";

const here = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = "run-proc01-a1";

let workDir = "";
let childScript = "";
const homes: string[] = [];
const stores: Array<{ close(): Promise<void> }> = [];

type ChildResult = { code: number | null; stdout: string };

function runChild(mode: string, args: Record<string, unknown>): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childScript, mode, JSON.stringify(args)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}

function startHolder(home: string) {
  const child = spawn(process.execPath, [childScript, "hold", JSON.stringify({ home })], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = new Promise<void>((resolve, reject) => {
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      if (buffer.includes("\n")) resolve();
    });
    child.on("error", reject);
    child.on("close", () => reject(new Error(`holder exited early: ${buffer}`)));
  });
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  return { child, ready, closed };
}

async function tempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "run-store-proc-"));
  homes.push(home);
  return home;
}

async function openStore(home: string, acquireTimeoutMs = 2000) {
  const store = createRunStore({ home, lock: { acquireTimeoutMs } });
  stores.push(store);
  await store.initialize();
  return store;
}

async function seedRun(home: string) {
  const store = await openStore(home);
  await store.create(
    withLedger({
      runId: RUN_ID,
      revision: 1,
      previousDigest: "",
      resources: [],
      assignments: assignmentsForRun(RUN_ID),
      nonceRegistry: noncesForRun(RUN_ID),
    }),
  );
  const read = await store.get(RUN_ID);
  await store.close();
  if (read.status !== "ok") throw new Error("seed failed");
  return read;
}

const recordsDir = (home: string) => path.join(home, "agent-team-runs", "v1", "runs");

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "run-store-child-"));
  const bundle = await rolldown({
    input: path.join(here, "support", "store-child.ts"),
    platform: "node",
    logLevel: "silent",
  });
  await bundle.write({ file: path.join(workDir, "child.mjs"), format: "esm" });
  await bundle.close();
  childScript = path.join(workDir, "child.mjs");
}, 60_000);

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("crash windows around the commit rename", () => {
  test.each([
    ["after-tmp", 1],
    ["before-rename", 1],
    ["after-rename", 2],
  ] as const)(
    "a process killed at %s leaves revision %i and the next store recovers",
    async (point, expectedRevision) => {
      const home = await tempHome();
      const seeded = await seedRun(home);

      const crashed = await runChild("update-crash", { home, runId: RUN_ID, point });
      expect(crashed.code).toBe(41);
      expect(crashed.stdout).not.toContain("crashed");

      const store = await openStore(home);
      const read = await store.get(RUN_ID);
      expect(read).toMatchObject({ status: "ok", revision: expectedRevision });
      if (read.status !== "ok") return;
      expect(read.record.dagRevision).toBe(seeded.record.dagRevision + (expectedRevision - 1));
      // Either the old bytes survive intact or the new ones landed whole; never a mixture.
      expect(read.record.previousDigest).toBe(expectedRevision === 1 ? "" : seeded.digest);
      const leftovers = (await readdir(recordsDir(home))).filter((name) => name.endsWith(".tmp"));
      expect(leftovers).toEqual([]);

      // The recovered store is a normal writer: the next commit chains on whatever survived.
      const next = await store.update(RUN_ID, (record) => ({
        ...record,
        dagRevision: record.dagRevision + 1,
      }));
      expect(next).toMatchObject({ status: "committed", revision: expectedRevision + 1 });
    },
  );

  test("a crash before rename leaves the committed bytes identical on disk", async () => {
    const home = await tempHome();
    await seedRun(home);
    const file = path.join(recordsDir(home), `${RUN_ID}.json`);
    const before = await readFile(file, "utf8");
    const crashed = await runChild("update-crash", { home, runId: RUN_ID, point: "before-rename" });
    expect(crashed.code).toBe(41);
    expect(await readFile(file, "utf8")).toBe(before);
  });
});

describe("two live processes", () => {
  test("a store cannot become writer while another process holds the ledger, and takes over after it dies", async () => {
    const home = await tempHome();
    await seedRun(home);
    const holder = startHolder(home);
    await holder.ready;

    const rival = createRunStore({ home, lock: { acquireTimeoutMs: 300 } });
    stores.push(rival);
    await expect(rival.initialize()).rejects.toMatchObject({ code: "lock-contended" });
    expect(rival.ready).toBe(false);
    // A store that never became writer must refuse to mutate anything.
    await expect(rival.update(RUN_ID, (record) => record)).rejects.toMatchObject({
      code: "not-initialized",
    });

    holder.child.kill();
    await holder.closed;

    const successor = await openStore(home);
    await expect(successor.get(RUN_ID)).resolves.toMatchObject({ status: "ok", revision: 1 });
  });

  test("a child that fails to take the lock exits without touching the record", async () => {
    const home = await tempHome();
    await seedRun(home);
    const file = path.join(recordsDir(home), `${RUN_ID}.json`);
    const before = await readFile(file, "utf8");
    const holder = startHolder(home);
    await holder.ready;

    const blocked = await runChild("update-crash", {
      home,
      runId: RUN_ID,
      point: "after-rename",
      acquireTimeoutMs: 200,
    });
    expect(blocked.code).toBe(3);
    expect(blocked.stdout).toContain("lock-contended");
    expect(await readFile(file, "utf8")).toBe(before);

    holder.child.kill();
    await holder.closed;
  });
});

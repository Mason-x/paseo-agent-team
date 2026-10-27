// Integration tests exercise real timers and real processes on purpose: cross-process lock
// contention, kill/reclaim, and crash points cannot be reproduced with fake in-process timers.
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import {
  type AtomicJsonCodec,
  type AtomicJsonFile,
  createAtomicJson,
  ensureLedgerDirs,
  type LedgerRoots,
  resolveLedgerRoots,
} from "../../server/ledger/atomic-json";
import { acquireProcessLock } from "../../server/ledger/process-lock";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const atomicUrl = pathToFileURL(path.join(pluginRoot, "server/ledger/atomic-json.ts")).href;
const lockUrl = pathToFileURL(path.join(pluginRoot, "server/ledger/process-lock.ts")).href;

const recordSchema = z.looseObject({
  schemaVersion: z.number(),
  revision: z.number(),
  previousDigest: z.string(),
  value: z.string(),
});
type TestRecord = z.infer<typeof recordSchema>;

const codec: AtomicJsonCodec<TestRecord> = {
  schemaVersion: 1,
  parse(value) {
    return recordSchema.parse(value);
  },
  readHeader(record) {
    return {
      schemaVersion: record.schemaVersion,
      revision: record.revision,
      previousDigest: record.previousDigest,
    };
  },
  withHeader(record, header) {
    return { ...record, ...header };
  },
};

const replySchema = z.looseObject({
  ok: z.boolean().optional(),
  token: z.string().optional(),
  pid: z.number().optional(),
  code: z.string().optional(),
  status: z.string().optional(),
  revision: z.number().optional(),
  reason: z.string().optional(),
  diagnostic: z.string().optional(),
  error: z.string().optional(),
});
type ChildReply = z.infer<typeof replySchema>;

const readySchema = z.looseObject({
  revision: z.number(),
  digest: z.string(),
  pid: z.number(),
});

type ChildOutcome = { code: number | null; reply: ChildReply | null; stderr: string };

const homes: string[] = [];
let childScript = "";

const childSource = `
import * as fsp from "node:fs/promises";
import * as atomic from ${JSON.stringify(atomicUrl)};
import * as locks from ${JSON.stringify(lockUrl)};

const [mode, raw] = process.argv.slice(2);
const args = raw ? JSON.parse(raw) : {};
async function waitFor(file) {
  for (;;) {
    try {
      await fsp.access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}
if (args.barrier) await waitFor(args.barrier);
const codec = {
  schemaVersion: 1,
  parse(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value;
  },
  readHeader(record) {
    return {
      schemaVersion: record.schemaVersion,
      revision: record.revision,
      previousDigest: record.previousDigest,
    };
  },
  withHeader(record, header) {
    return { ...record, ...header };
  },
};
function openStore(files) {
  return atomic.createAtomicJson({
    file: args.file,
    issuesDir: args.issuesDir,
    containmentRoot: args.root,
    codec,
    fs: files,
  });
}
try {
  if (mode === "lock") {
    const lock = await locks.acquireProcessLock({
      file: args.file,
      acquireTimeoutMs: args.timeout,
      retryDelayMs: 10,
      ownerToken: args.token,
    });
    console.log(JSON.stringify({ ok: true, token: lock.ownerToken, pid: process.pid }));
    if (args.holdMs) await new Promise((resolve) => setTimeout(resolve, args.holdMs));
    if (!args.keep) await lock.release();
    process.exit(0);
  }
  if (mode === "lock-crash") {
    const lock = await locks.acquireProcessLock({
      file: args.file,
      acquireTimeoutMs: 2000,
      retryDelayMs: 10,
    });
    console.log(JSON.stringify({ ok: true, token: lock.ownerToken, pid: process.pid }));
    process.exit(7);
  }
  if (mode === "lock-hold") {
    const lock = await locks.acquireProcessLock({
      file: args.file,
      acquireTimeoutMs: 2000,
      retryDelayMs: 10,
    });
    console.log(JSON.stringify({ ok: true, token: lock.ownerToken, pid: process.pid }));
    await new Promise((resolve) => setTimeout(resolve, 60000));
  }
  if (mode === "atomic-write") {
    const base = atomic.nodeLedgerFs;
    const files = {
      ...base,
      async writeFileExclusive(target, content) {
        await base.writeFileExclusive(target, content);
        if (args.point === "after-tmp" && target.endsWith(".tmp")) process.exit(41);
      },
      async rename(from, to) {
        if (args.point === "before-rename") process.exit(41);
        await base.rename(from, to);
        if (args.point === "after-rename") process.exit(41);
      },
    };
    const store = openStore(files);
    const result = await store.commit(args.record, args.cas);
    console.log(JSON.stringify({ ok: true, revision: result.revision }));
    process.exit(0);
  }
  if (mode === "atomic-read") {
    const result = await openStore().read();
    console.log(JSON.stringify(
      result.status === "ok"
        ? { status: "ok", revision: result.revision }
        : result.status === "corrupt"
          ? { status: "corrupt", reason: result.reason, diagnostic: result.diagnostic }
          : { status: result.status },
    ));
    process.exit(0);
  }
  if (mode === "atomic-shared-read") {
    const store = openStore();
    const current = await store.read();
    if (current.status !== "ok") {
      console.log(JSON.stringify({ ok: false, code: current.status }));
      process.exit(0);
    }
    await fsp.writeFile(
      args.ready,
      JSON.stringify({ revision: current.revision, digest: current.digest, pid: process.pid }),
    );
    await waitFor(args.go);
    try {
      const result = await store.commit(
        {
          ...current.record,
          revision: current.revision + 1,
          previousDigest: current.digest,
          value: args.value,
        },
        { revision: current.revision, digest: current.digest },
      );
      console.log(JSON.stringify({ ok: true, revision: result.revision, value: args.value }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, code: error.code ?? "unknown" }));
    }
    process.exit(0);
  }
  if (mode === "atomic-stale-locked") {
    const store = openStore();
    const current = await store.read();
    if (current.status !== "ok") {
      console.log(JSON.stringify({ ok: false, code: current.status }));
      process.exit(0);
    }
    await fsp.writeFile(
      args.ready,
      JSON.stringify({ revision: current.revision, digest: current.digest, pid: process.pid }),
    );
    await waitFor(args.go);
    const lock = await locks.acquireProcessLock({
      file: args.lockFile,
      acquireTimeoutMs: 10_000,
      retryDelayMs: 10,
    });
    try {
      const result = await store.commit(
        {
          ...current.record,
          revision: current.revision + 1,
          previousDigest: current.digest,
          value: args.value,
        },
        { revision: current.revision, digest: current.digest },
      );
      console.log(JSON.stringify({ ok: true, revision: result.revision, value: args.value }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, code: error.code ?? "unknown" }));
    } finally {
      await lock.release();
    }
    process.exit(0);
  }
  if (mode === "atomic-locked-write") {
    const lock = await locks.acquireProcessLock({
      file: args.lockFile,
      acquireTimeoutMs: 10_000,
      retryDelayMs: 10,
    });
    try {
      const store = openStore();
      const current = await store.read();
      if (current.status !== "ok") throw new Error(current.status);
      const result = await store.commit(
        {
          ...current.record,
          revision: current.revision + 1,
          previousDigest: current.digest,
          value: args.value ?? "racer",
        },
        { revision: current.revision, digest: current.digest },
      );
      console.log(JSON.stringify({ ok: true, revision: result.revision, value: args.value ?? "racer" }));
      await lock.release();
    } catch (error) {
      console.log(JSON.stringify({ ok: false, code: error.code ?? "unknown" }));
    }
    process.exit(0);
  }
  console.log(JSON.stringify({ ok: false, code: "bad-mode" }));
  process.exit(2);
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code ?? "unknown", error: String(error) }));
  process.exit(1);
}
`;

function replyOf(stdout: string): ChildReply | null {
  const line = stdout.trim().split(/\r?\n/u).at(-1);
  if (line === undefined || line === "") return null;
  try {
    return replySchema.parse(JSON.parse(line));
  } catch {
    return null;
  }
}

function spawnChild(mode: string, args: Record<string, unknown>) {
  const child = spawn(process.execPath, [childScript, mode, JSON.stringify(args)], {
    cwd: pluginRoot,
    env: { ...process.env, PASEO_HOME: path.dirname(childScript) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const { promise, resolve } = Promise.withResolvers<ChildOutcome>();
  const timer = setTimeout(() => child.kill(), 30_000);
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ code, reply: replyOf(stdout), stderr });
  });
  return { child, done: promise };
}

function runChild(mode: string, args: Record<string, unknown>): Promise<ChildOutcome> {
  return spawnChild(mode, args).done;
}

async function homeFixture(name: string): Promise<{ home: string; roots: LedgerRoots }> {
  const home = await mkdtemp(path.join(tmpdir(), `r04a-${name}-`));
  homes.push(home);
  const roots = await resolveLedgerRoots(home);
  await ensureLedgerDirs(roots);
  return { home, roots };
}

function storeFor(
  roots: LedgerRoots,
  name: string,
  limits?: { softBytes?: number; hardBytes?: number },
): AtomicJsonFile<TestRecord> {
  return createAtomicJson<TestRecord>({
    file: path.join(roots.records, `${name}.json`),
    issuesDir: roots.issues,
    containmentRoot: roots.home,
    codec,
    limits,
  });
}

function baseRecord(): TestRecord {
  return { schemaVersion: 1, revision: 1, previousDigest: "", value: "base" };
}

async function createBase(
  store: AtomicJsonFile<TestRecord>,
): Promise<TestRecord & { digest: string }> {
  await store.commit(baseRecord(), { revision: 0, digest: "" });
  const current = await store.read();
  if (current.status !== "ok") throw new Error(`unexpected ${current.status}`);
  return { ...current.record, digest: current.digest };
}

async function barrierRace(
  count: number,
  mode: string,
  args: Record<string, unknown>,
): Promise<ChildOutcome[]> {
  const barrier = path.join(path.dirname(childScript), `barrier-${Date.now()}-${Math.random()}`);
  const children = Array.from({ length: count }, () => runChild(mode, { ...args, barrier }));
  await writeFile(barrier, "go");
  return Promise.all(children);
}

async function waitForPath(file: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      await stat(file);
      return;
    } catch {
      // Keep polling until the child writes the rendezvous file or the deadline passes.
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForLockPid(file: string, pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const parsed = replySchema.partial().parse(JSON.parse(await readFile(file, "utf8")));
      if (parsed.pid === pid) return;
    } catch {
      // Keep polling until the child writes the lock or the deadline passes.
    }
    if (Date.now() >= deadline) throw new Error(`lock ${file} was not written by pid ${pid}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeAll(async () => {
  const harness = await mkdtemp(path.join(tmpdir(), "r04a-harness-"));
  homes.push(harness);
  childScript = path.join(harness, "child.mjs");
  await writeFile(childScript, childSource);
});

afterAll(async () => {
  for (const home of homes) {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("ledger on the real filesystem", () => {
  test("uses a private temp home and never falls back to ~/.paseo", async () => {
    const { home, roots } = await homeFixture("roots");
    expect(home.startsWith(path.resolve(tmpdir()))).toBe(true);
    expect(home.startsWith(path.join(homedir(), ".paseo"))).toBe(false);
    expect(roots.records.startsWith(roots.home)).toBe(true);
    await expect(resolveLedgerRoots(undefined)).rejects.toMatchObject({ code: "root-missing" });
    await expect(resolveLedgerRoots("relative/home")).rejects.toMatchObject({
      code: "root-relative",
    });
  }, 20_000);

  test("rejects a junction that escapes home before creating it", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "r04a-junction-"));
    const outside = await mkdtemp(path.join(tmpdir(), "r04a-outside-"));
    homes.push(home, outside);
    await symlink(
      outside,
      path.join(home, "agent-team-runs"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const roots = await resolveLedgerRoots(home);
    await expect(ensureLedgerDirs(roots)).rejects.toMatchObject({ code: "path-escape" });
    await expect(stat(path.join(outside, "v1"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  test("acquires and releases the real root lock in-process", async () => {
    const { roots } = await homeFixture("inproc-lock");
    const lockFile = path.join(roots.root, ".lock");
    const lock = await acquireProcessLock({ file: lockFile, acquireTimeoutMs: 1000 });
    await lock.assertHeld();
    await lock.release();
    await expect(stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
    const again = await acquireProcessLock({ file: lockFile, acquireTimeoutMs: 1000 });
    await again.release();
  }, 20_000);

  test("lets exactly one of four processes hold the root lock", async () => {
    const { home, roots } = await homeFixture("race");
    const lockFile = path.join(roots.root, ".lock");
    const outcomes = await barrierRace(4, "lock", {
      file: lockFile,
      timeout: 300,
      holdMs: 1200,
    });
    expect(outcomes.filter((outcome) => outcome.reply?.ok === true)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.reply?.code === "lock-contended")).toHaveLength(3);
    expect(home).toBe(roots.home);
    const fifth = await runChild("lock", { file: lockFile, timeout: 1000 });
    expect(fifth.reply?.ok).toBe(true);
  }, 20_000);

  test("reclaims after a hard crash and after a killed holder", async () => {
    const { roots } = await homeFixture("reclaim");
    const lockFile = path.join(roots.root, ".lock");
    const crashed = await runChild("lock-crash", { file: lockFile });
    expect(crashed.code).toBe(7);
    const crashedLock = replySchema
      .extend({ ownerToken: z.string() })
      .parse(JSON.parse(await readFile(lockFile, "utf8")));
    expect(crashedLock.pid).toBe(crashed.reply?.pid);
    const recovered = await runChild("lock", { file: lockFile, timeout: 1500 });
    expect(recovered.reply?.ok).toBe(true);
    expect(recovered.reply?.token).not.toBe(crashedLock.ownerToken);

    const holder = spawnChild("lock-hold", { file: lockFile });
    if (holder.child.pid === undefined) throw new Error("holder pid missing");
    await waitForLockPid(lockFile, holder.child.pid);
    const held = await runChild("lock", { file: lockFile, timeout: 200 });
    expect(held.reply?.code).toBe("lock-contended");
    holder.child.kill();
    await holder.done;
    const afterKill = await runChild("lock", { file: lockFile, timeout: 2000 });
    expect(afterKill.reply?.ok).toBe(true);
  }, 30_000);

  test("lets exactly one of two processes reclaim the same dead lock", async () => {
    const { roots } = await homeFixture("reclaim-race");
    const lockFile = path.join(roots.root, ".lock");
    await writeFile(
      lockFile,
      JSON.stringify({
        version: 1,
        ownerToken: "dead",
        pid: 999_999,
        startedAt: new Date().toISOString(),
        processStartedAt: null,
      }),
    );
    const outcomes = await barrierRace(2, "lock", {
      file: lockFile,
      timeout: 600,
      holdMs: 1500,
      keep: true,
    });
    const winners = outcomes.filter((outcome) => outcome.reply?.ok === true);
    expect(winners).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.reply?.code === "lock-contended")).toHaveLength(1);
    const finalLock = replySchema
      .extend({ ownerToken: z.string() })
      .parse(JSON.parse(await readFile(lockFile, "utf8")));
    expect(finalLock.ownerToken).toBe(winners[0]?.reply?.token);
  }, 20_000);

  test("keeps the old record at every crash point before rename and the new one after rename", async () => {
    for (const point of ["after-tmp", "before-rename", "after-rename"]) {
      const { roots } = await homeFixture(`crash-${point}`);
      const store = storeFor(roots, "run");
      const current = await createBase(store);
      const before = await readFile(store.file);
      const outcome = await runChild("atomic-write", {
        file: store.file,
        issuesDir: roots.issues,
        root: roots.home,
        point,
        record: {
          ...current,
          revision: 2,
          previousDigest: current.digest,
          value: point,
        },
        cas: { revision: 1, digest: current.digest },
      });
      expect(outcome.code).toBe(41);
      const after = await readFile(store.file);
      if (point === "after-rename") {
        expect(JSON.parse(after.toString("utf8")).revision).toBe(2);
      } else {
        expect(after.equals(before)).toBe(true);
        const temps = (await readdir(roots.records)).filter((name) => name.endsWith(".tmp"));
        expect(temps.length).toBeGreaterThan(0);
      }
      await store.sweepTemporary();
      expect((await readdir(roots.records)).filter((name) => name.endsWith(".tmp"))).toHaveLength(
        0,
      );
    }
  }, 30_000);

  test("rejects the loser when two processes commit from the same read", async () => {
    const { home, roots } = await homeFixture("cas-shared-read");
    const store = storeFor(roots, "run");
    const base = await createBase(store);
    const baseArgs = { file: store.file, issuesDir: roots.issues, root: roots.home };
    const readyA = path.join(home, "ready-a");
    const readyB = path.join(home, "ready-b");
    const goA = path.join(home, "go-a");
    const goB = path.join(home, "go-b");
    const childA = spawnChild("atomic-shared-read", {
      ...baseArgs,
      ready: readyA,
      go: goA,
      value: "alpha",
    });
    const childB = spawnChild("atomic-shared-read", {
      ...baseArgs,
      ready: readyB,
      go: goB,
      value: "beta",
    });
    await Promise.all([waitForPath(readyA), waitForPath(readyB)]);
    const readA = readySchema.parse(JSON.parse(await readFile(readyA, "utf8")));
    const readB = readySchema.parse(JSON.parse(await readFile(readyB, "utf8")));
    expect(readA).toMatchObject({ revision: 1, digest: base.digest });
    expect(readB).toMatchObject({ revision: 1, digest: base.digest });
    expect(readA.pid).not.toBe(readB.pid);

    await writeFile(goA, "go");
    const first = await childA.done;
    expect(first.reply).toMatchObject({ ok: true, revision: 2, value: "alpha" });
    const between = await store.read();
    if (between.status !== "ok") throw new Error(`unexpected ${between.status}`);
    expect(between.revision).toBe(2);
    expect(between.record.value).toBe("alpha");
    const alphaDigest = between.digest;

    await writeFile(goB, "go");
    const second = await childB.done;
    expect(second.reply).toMatchObject({ ok: false, code: "cas-mismatch" });

    const final = await store.read();
    if (final.status !== "ok") throw new Error(`unexpected ${final.status}`);
    expect(final.revision).toBe(2);
    expect(final.record.value).toBe("alpha");
    expect(final.record.value).not.toBe("beta");
    expect(final.digest).toBe(alphaDigest);
    const names = await readdir(roots.records);
    expect(names.filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
    expect(names).toEqual([path.basename(store.file)]);
  }, 30_000);

  test("serializes two lock writers on the latest revision", async () => {
    const { home, roots } = await homeFixture("cas-locked");
    const store = storeFor(roots, "run");
    await createBase(store);
    const barrier = path.join(home, "barrier");
    const lockFile = path.join(roots.root, ".lock");
    const baseArgs = {
      file: store.file,
      issuesDir: roots.issues,
      root: roots.home,
      lockFile,
      barrier,
    };
    const first = spawnChild("atomic-locked-write", { ...baseArgs, value: "first" });
    const second = spawnChild("atomic-locked-write", { ...baseArgs, value: "second" });
    await writeFile(barrier, "go");
    const [outcomeA, outcomeB] = await Promise.all([first.done, second.done]);
    expect(outcomeA.reply).toMatchObject({ ok: true });
    expect(outcomeB.reply).toMatchObject({ ok: true });
    const revisions = [outcomeA.reply?.revision, outcomeB.reply?.revision].sort();
    expect(revisions).toEqual([2, 3]);
    const lastWriter = outcomeA.reply?.revision === 3 ? outcomeA.reply : outcomeB.reply;
    const final = await store.read();
    if (final.status !== "ok") throw new Error(`unexpected ${final.status}`);
    expect(final.revision).toBe(3);
    expect(final.record.value).toBe(lastWriter?.value);
    expect(["first", "second"]).toContain(final.record.value);
  }, 30_000);

  test("rejects a stale read even when the retry holds the lock", async () => {
    const { home, roots } = await homeFixture("cas-stale-locked");
    const store = storeFor(roots, "run");
    const base = await createBase(store);
    const ready = path.join(home, "ready");
    const go = path.join(home, "go");
    const lockFile = path.join(roots.root, ".lock");
    const baseArgs = { file: store.file, issuesDir: roots.issues, root: roots.home, lockFile };
    const stale = spawnChild("atomic-stale-locked", {
      ...baseArgs,
      ready,
      go,
      value: "stale",
    });
    await waitForPath(ready);
    const staleRead = readySchema.parse(JSON.parse(await readFile(ready, "utf8")));
    expect(staleRead).toMatchObject({ revision: 1, digest: base.digest });

    const winner = await runChild("atomic-locked-write", { ...baseArgs, value: "winner" });
    expect(winner.reply).toMatchObject({ ok: true, revision: 2, value: "winner" });

    await writeFile(go, "go");
    const rejected = await stale.done;
    expect(rejected.reply).toMatchObject({ ok: false, code: "cas-mismatch" });
    const final = await store.read();
    if (final.status !== "ok") throw new Error(`unexpected ${final.status}`);
    expect(final.revision).toBe(2);
    expect(final.record.value).toBe("winner");
  }, 30_000);

  test("isolates corrupt and unknown-version records without rewriting them", async () => {
    const { roots } = await homeFixture("corrupt");
    const store = storeFor(roots, "run");
    const corrupt = '{"schemaVersion":1,"revision":1,';
    await writeFile(store.file, corrupt);
    const corruptReply = await runChild("atomic-read", {
      file: store.file,
      issuesDir: roots.issues,
      root: roots.home,
    });
    expect(corruptReply.reply).toMatchObject({
      status: "corrupt",
      reason: "json",
      diagnostic: "disk",
    });
    expect(await readFile(store.file, "utf8")).toBe(corrupt);
    expect((await readdir(roots.issues)).length).toBe(1);

    const unknown = `${JSON.stringify({ schemaVersion: 99, revision: 1, previousDigest: "" })}\n`;
    await writeFile(store.file, unknown);
    const unknownReply = await runChild("atomic-read", {
      file: store.file,
      issuesDir: roots.issues,
      root: roots.home,
    });
    expect(unknownReply.reply).toMatchObject({ status: "unknown-version" });
    expect(await readFile(store.file, "utf8")).toBe(unknown);
  }, 20_000);

  test("rejects an oversize record on the real filesystem", async () => {
    const { roots } = await homeFixture("oversize");
    const store = storeFor(roots, "run", { softBytes: 8, hardBytes: 16 });
    await writeFile(store.file, "x".repeat(64));
    const result = await store.read();
    expect(result.status).toBe("corrupt");
    if (result.status === "corrupt") {
      expect(result.reason).toBe("oversize");
      expect(result.issuePath).not.toBeNull();
    }
  }, 20_000);
});

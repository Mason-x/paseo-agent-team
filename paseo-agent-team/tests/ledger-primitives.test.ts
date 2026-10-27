import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  type AtomicJsonCodec,
  AtomicJsonError,
  type AtomicJsonFile,
  createAtomicJson,
  ensureLedgerDirs,
  type LedgerFs,
  resolveLedgerRoots,
} from "../server/ledger/atomic-json";
import {
  acquireProcessLock,
  createProcessLiveness,
  type LockFs,
  type ProcessLiveness,
} from "../server/ledger/process-lock";

const HOME = path.resolve("/tmp/r04a-unit-home");
const OUTSIDE = path.resolve("/tmp/r04a-outside");
const NOW = "2026-10-27T00:00:00.000Z";

function fsError(code?: string): Error & { code?: string } {
  return Object.assign(new Error(code ?? "unknown"), { code });
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

class FakeDisk {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();
  readonly realpaths = new Map<string, string>();
  readonly writes: string[] = [];
  readonly events: string[] = [];
  readonly renameFailures: (string | null)[] = [];
  issueWriteFailure = false;
  recordWriteFailure: string | null = null;
  lockWriteFailure: string | null = null;
  guardWriteFailure: string | null = null;
  readFailure: string | null = null;
  readdirFailure = false;

  addDir(target: string): void {
    this.dirs.add(path.resolve(target));
  }

  readText(target: string): string {
    const value = this.files.get(path.resolve(target));
    if (value === undefined) throw fsError("ENOENT");
    return value;
  }

  asLedgerFs(): LedgerFs {
    const disk = this;
    return {
      async mkdir(target) {
        disk.addDir(target);
      },
      async readFile(target) {
        if (disk.readFailure !== null) throw fsError(disk.readFailure);
        return Buffer.from(disk.readText(target), "utf8");
      },
      async hashFile(target) {
        return digest(disk.readText(target));
      },
      async statSize(target) {
        const value = disk.files.get(path.resolve(target));
        return value === undefined ? null : Buffer.byteLength(value, "utf8");
      },
      async writeFileExclusive(target, content) {
        const resolved = path.resolve(target);
        disk.events.push(`write:${resolved}`);
        disk.writes.push(resolved);
        const isIssue = resolved.includes(`${path.sep}issues${path.sep}`);
        if (disk.recordWriteFailure !== null && !isIssue) throw fsError(disk.recordWriteFailure);
        if (disk.issueWriteFailure && isIssue) {
          throw fsError("EACCES");
        }
        if (disk.files.has(resolved)) throw fsError("EEXIST");
        disk.files.set(resolved, content);
      },
      async rename(from, to) {
        disk.events.push("rename");
        const failure = disk.renameFailures.shift();
        if (failure === null) throw new Error("rename failed without a code");
        if (failure !== undefined) throw fsError(failure);
        const source = path.resolve(from);
        const destination = path.resolve(to);
        const value = disk.files.get(source);
        if (value === undefined) throw fsError("ENOENT");
        disk.files.set(destination, value);
        disk.files.delete(source);
      },
      async rm(target) {
        disk.files.delete(path.resolve(target));
      },
      async readdir(target) {
        if (disk.readdirFailure) throw fsError("EACCES");
        const directory = path.resolve(target);
        return [...disk.files.keys()]
          .filter((file) => path.dirname(file) === directory)
          .map((file) => path.basename(file));
      },
      async realpath(target) {
        const resolved = path.resolve(target);
        const mapped = disk.realpaths.get(resolved);
        if (mapped !== undefined) return mapped;
        for (const [from, to] of disk.realpaths) {
          const relative = path.relative(from, resolved);
          if (
            relative !== "" &&
            !path.isAbsolute(relative) &&
            !relative.split(/[/\\]/u).includes("..")
          ) {
            return path.resolve(to, relative);
          }
        }
        if (disk.dirs.has(resolved) || disk.files.has(resolved)) return resolved;
        throw fsError("ENOENT");
      },
    };
  }

  asLockFs(): LockFs {
    const disk = this;
    return {
      async readFile(target) {
        if (disk.readFailure !== null) throw fsError(disk.readFailure);
        return disk.readText(target);
      },
      async writeFileExclusive(target, content) {
        const resolved = path.resolve(target);
        disk.events.push(`write:${resolved}`);
        disk.writes.push(resolved);
        if (disk.guardWriteFailure !== null && resolved.endsWith(".reclaim")) {
          throw fsError(disk.guardWriteFailure);
        }
        if (disk.lockWriteFailure !== null) throw fsError(disk.lockWriteFailure);
        if (disk.files.has(resolved)) throw fsError("EEXIST");
        disk.files.set(resolved, content);
      },
      async rename(from, to) {
        disk.events.push("rename");
        const source = path.resolve(from);
        const destination = path.resolve(to);
        const value = disk.files.get(source);
        if (value === undefined) throw fsError("ENOENT");
        disk.files.set(destination, value);
        disk.files.delete(source);
      },
      async rm(target) {
        disk.files.delete(path.resolve(target));
      },
      async readdir(target) {
        if (disk.readdirFailure) throw fsError("EACCES");
        const directory = path.resolve(target);
        return [...disk.files.keys()]
          .filter((file) => path.dirname(file) === directory)
          .map((file) => path.basename(file));
      },
    };
  }
}

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
  invariant(record) {
    return record.value.length > 200 ? ["value exceeds 200 characters"] : [];
  },
};

function record(revision = 1, previousDigest = "", value = "value"): TestRecord {
  return { schemaVersion: 1, revision, previousDigest, value };
}

class FakeClock {
  time = Date.parse(NOW);

  now(): string {
    return new Date(this.time).toISOString();
  }

  advance(milliseconds: number): void {
    this.time += milliseconds;
  }
}

function ids() {
  let sequence = 0;
  return { next: () => `id-${++sequence}` };
}

async function atomicFixture(options?: {
  disk?: FakeDisk;
  limits?: { softBytes?: number; hardBytes?: number };
  guard?: () => void | Promise<void>;
  onIssueError?: (error: unknown) => void;
  codec?: AtomicJsonCodec<TestRecord>;
}) {
  const disk = options?.disk ?? new FakeDisk();
  disk.addDir(HOME);
  const files = disk.asLedgerFs();
  const roots = await resolveLedgerRoots(HOME, files);
  await ensureLedgerDirs(roots, files);
  const store = createAtomicJson<TestRecord>({
    file: path.join(roots.records, "run-test.json"),
    issuesDir: roots.issues,
    containmentRoot: roots.home,
    codec: options?.codec ?? codec,
    fs: files,
    clock: new FakeClock(),
    ids: ids(),
    sleep: { async sleep() {} },
    limits: options?.limits,
    guard: options?.guard,
    onIssueError: options?.onIssueError,
  });
  return { disk, roots, store };
}

async function createFirst(store: AtomicJsonFile<TestRecord>) {
  await store.commit(record(), { revision: 0, digest: "" });
  const current = await store.read();
  if (current.status !== "ok") throw new Error(`unexpected ${current.status}`);
  return current;
}

describe("atomic-json roots", () => {
  test("requires an explicit absolute readable home and never falls back", async () => {
    const disk = new FakeDisk();
    disk.addDir(HOME);
    const files = disk.asLedgerFs();
    await expect(resolveLedgerRoots(undefined, files)).rejects.toMatchObject({
      code: "root-missing",
    });
    await expect(resolveLedgerRoots("", files)).rejects.toMatchObject({ code: "root-missing" });
    await expect(resolveLedgerRoots("relative/home", files)).rejects.toMatchObject({
      code: "root-relative",
    });
    await expect(
      resolveLedgerRoots(path.resolve("/tmp/missing-home"), files),
    ).rejects.toMatchObject({ code: "root-unreadable" });
    const roots = await resolveLedgerRoots(HOME, files);
    expect(roots.records.startsWith(HOME)).toBe(true);
    expect(roots.issues.startsWith(HOME)).toBe(true);
  });

  test("rejects a records directory that resolves outside home before writing", async () => {
    const disk = new FakeDisk();
    disk.addDir(HOME);
    const files = disk.asLedgerFs();
    const roots = await resolveLedgerRoots(HOME, files);
    disk.realpaths.set(roots.records, path.join(OUTSIDE, "runs"));
    await expect(ensureLedgerDirs(roots, files)).rejects.toBeInstanceOf(AtomicJsonError);
    await expect(ensureLedgerDirs(roots, files)).rejects.toMatchObject({ code: "path-escape" });
  });

  test("does not create directories until ensureLedgerDirs runs", async () => {
    const disk = new FakeDisk();
    disk.addDir(HOME);
    const roots = await resolveLedgerRoots(HOME, disk.asLedgerFs());
    expect(disk.dirs.has(roots.root)).toBe(false);
    expect(disk.dirs.has(roots.records)).toBe(false);
    await ensureLedgerDirs(roots, disk.asLedgerFs());
    expect(disk.dirs.has(roots.records)).toBe(true);
  });
});

describe("atomic-json read/commit", () => {
  test("creates, preserves unknown nested fields, and advances the digest chain", async () => {
    const { disk, store } = await atomicFixture();
    const first = record();
    const extended = { ...first, extra: { nested: [1, { deep: true }] } };
    await store.commit(extended, { revision: 0, digest: "" });
    const created = await store.read();
    expect(created.status).toBe("ok");
    if (created.status !== "ok") return;
    const text = disk.readText(store.file);
    expect(JSON.parse(text)).toMatchObject({ extra: { nested: [1, { deep: true }] } });
    await store.commit(
      { ...created.record, revision: 2, previousDigest: created.digest, value: "two" },
      { revision: 1, digest: created.digest },
    );
    const updated = await store.read();
    expect(updated.status).toBe("ok");
    if (updated.status !== "ok") return;
    expect(updated.revision).toBe(2);
    expect(JSON.parse(disk.readText(store.file))).toMatchObject({
      extra: { nested: [1, { deep: true }] },
      value: "two",
    });
    expect(disk.events.filter((event) => event === "rename")).toHaveLength(2);
  });

  test("rejects stale digests, stale revisions, bad headers, and duplicate creates", async () => {
    const { store } = await atomicFixture();
    const created = await createFirst(store);
    await expect(
      store.commit(record(2, created.digest, "two"), {
        revision: 1,
        digest: `sha256:${"0".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "cas-mismatch" });
    await expect(
      store.commit(record(2, created.digest, "two"), { revision: 0, digest: created.digest }),
    ).rejects.toMatchObject({ code: "cas-mismatch" });
    await expect(
      store.commit(record(3, created.digest, "three"), { revision: 1, digest: created.digest }),
    ).rejects.toMatchObject({ code: "header-invalid" });
    await expect(
      store.commit(record(2, `sha256:${"1".repeat(64)}`, "two"), {
        revision: 1,
        digest: created.digest,
      }),
    ).rejects.toMatchObject({ code: "header-invalid" });
    await expect(store.commit(record(), { revision: 0, digest: "" })).rejects.toMatchObject({
      code: "cas-mismatch",
    });
    const unchanged = await store.read();
    expect(unchanged.status).toBe("ok");
    if (unchanged.status === "ok") expect(unchanged.revision).toBe(1);
  });

  test("rejects a sequential stale CAS write from an earlier read (no lock)", async () => {
    const { disk, store } = await atomicFixture();
    const created = await createFirst(store);
    const second = createAtomicJson<TestRecord>({
      file: store.file,
      issuesDir: path.join(path.dirname(store.file), "..", "issues"),
      containmentRoot: HOME,
      codec,
      fs: disk.asLedgerFs(),
    });
    const other = await second.read();
    expect(other.status).toBe("ok");
    if (other.status !== "ok") return;
    await store.commit(record(2, created.digest, "first"), {
      revision: 1,
      digest: created.digest,
    });
    await expect(
      second.commit(record(2, other.digest, "second"), {
        revision: 1,
        digest: other.digest,
      }),
    ).rejects.toBeInstanceOf(AtomicJsonError);
  });

  test("calls the guard after the temp write and before rename", async () => {
    const disk = new FakeDisk();
    const { store } = await atomicFixture({
      disk,
      guard() {
        disk.events.push("guard");
      },
    });
    await store.commit(record(), { revision: 0, digest: "" });
    const guardAt = disk.events.indexOf("guard");
    const writeAt = disk.events.findIndex((event) => event.startsWith("write:"));
    expect(guardAt).toBeGreaterThan(writeAt);
    expect(guardAt).toBeLessThan(disk.events.lastIndexOf("rename"));
  });

  test("leaves no write when the guard fails", async () => {
    const disk = new FakeDisk();
    const { store } = await atomicFixture({
      disk,
      guard() {
        throw new Error("lock-lost");
      },
    });
    await expect(store.commit(record(), { revision: 0, digest: "" })).rejects.toThrow("lock-lost");
    expect(disk.files.size).toBe(0);
    expect(disk.events.some((event) => event === "rename")).toBe(false);
  });
});

describe("atomic-json limits and quarantine", () => {
  test("retries Windows rename failures and gives up after eight attempts", async () => {
    const sleeps: number[] = [];
    const disk = new FakeDisk();
    disk.addDir(HOME);
    const files = disk.asLedgerFs();
    const roots = await resolveLedgerRoots(HOME, files);
    await ensureLedgerDirs(roots, files);
    const store = createAtomicJson<TestRecord>({
      file: path.join(roots.records, "run-test.json"),
      issuesDir: roots.issues,
      containmentRoot: roots.home,
      codec,
      fs: files,
      clock: new FakeClock(),
      ids: ids(),
      sleep: {
        async sleep(milliseconds) {
          sleeps.push(milliseconds);
        },
      },
    });
    disk.renameFailures.push("EBUSY", "EBUSY");
    await store.commit(record(), { revision: 0, digest: "" });
    expect(sleeps).toEqual([10, 20]);
    const created = await store.read();
    expect(created.status).toBe("ok");
    disk.renameFailures.push(...Array(8).fill("EBUSY"));
    if (created.status !== "ok") return;
    await expect(
      store.commit(record(2, created.digest, "two"), { revision: 1, digest: created.digest }),
    ).rejects.toMatchObject({ code: "rename-failed" });
    expect(disk.readText(store.file)).toContain('"revision":1');
    expect(disk.readText(store.file)).not.toContain('"revision":2');
  });

  test("retries a rename failure without an error code", async () => {
    const disk = new FakeDisk();
    const { store } = await atomicFixture({ disk });
    disk.renameFailures.push(null);
    await store.commit(record(), { revision: 0, digest: "" });
    const created = await store.read();
    expect(created.status).toBe("ok");
  });

  test("enforces soft and hard byte limits before writing", async () => {
    const softDisk = new FakeDisk();
    const soft = await atomicFixture({
      disk: softDisk,
      limits: { softBytes: 10, hardBytes: 1000 },
    });
    await soft.store.commit(record(), { revision: 0, digest: "" });
    const created = await soft.store.read();
    expect(created.status).toBe("ok");
    if (created.status === "ok") expect(created.needsCompaction).toBe(true);

    const hardDisk = new FakeDisk();
    const hard = await atomicFixture({ disk: hardDisk, limits: { softBytes: 10, hardBytes: 20 } });
    await expect(hard.store.commit(record(), { revision: 0, digest: "" })).rejects.toMatchObject({
      code: "too-large",
    });
    expect(hardDisk.files.size).toBe(0);
  });

  test("isolates corrupt records, deduplicates issues, and degrades when issues fail", async () => {
    const { disk, store } = await atomicFixture();
    disk.files.set(store.file, '{"schemaVersion":1,"revision":1,"previousDigest":"",');
    const errors: unknown[] = [];
    const corruptStore = createAtomicJson<TestRecord>({
      file: store.file,
      issuesDir: path.join(path.dirname(store.file), "..", "issues"),
      containmentRoot: HOME,
      codec,
      fs: disk.asLedgerFs(),
      clock: new FakeClock(),
      ids: ids(),
      onIssueError: (error) => errors.push(error),
    });
    const first = await corruptStore.read();
    expect(first.status).toBe("corrupt");
    if (first.status !== "corrupt") return;
    expect(first.reason).toBe("json");
    expect(first.issuePath).not.toBeNull();
    expect(disk.readText(store.file)).toBe('{"schemaVersion":1,"revision":1,"previousDigest":"",');
    const writes = disk.writes.length;
    const second = await corruptStore.read();
    expect(second.status).toBe("corrupt");
    expect(disk.writes.length).toBe(writes);

    disk.issueWriteFailure = true;
    disk.files.set(store.file, '{"broken":true');
    const memoryOnly = await corruptStore.read();
    expect(memoryOnly.status).toBe("corrupt");
    if (memoryOnly.status === "corrupt") {
      expect(memoryOnly.issuePath).toBeNull();
      expect(memoryOnly.diagnostic).toBe("memory");
    }
    expect(errors.length).toBeGreaterThan(0);
  });

  test("treats a higher schemaVersion as read-only and does not write issues", async () => {
    const { disk, store } = await atomicFixture();
    const body = `${JSON.stringify({ schemaVersion: 9, revision: 1, previousDigest: "" })}\n`;
    disk.files.set(store.file, body);
    const result = await store.read();
    expect(result).toMatchObject({ status: "unknown-version", schemaVersion: 9 });
    expect(disk.readText(store.file)).toBe(body);
    expect(disk.dirs.has(path.join(path.dirname(store.file), "..", "issues"))).toBe(false);
    await expect(store.commit(record(), { revision: 0, digest: "" })).rejects.toMatchObject({
      code: "unknown-version",
    });
  });

  test("rejects oversize reads without loading the record and names the issue", async () => {
    const disk = new FakeDisk();
    const { store } = await atomicFixture({ disk, limits: { hardBytes: 16, softBytes: 8 } });
    disk.files.set(store.file, "x".repeat(32));
    const result = await store.read();
    expect(result.status).toBe("corrupt");
    if (result.status !== "corrupt") return;
    expect(result.reason).toBe("oversize");
    expect(result.issuePath).not.toBeNull();
  });

  test("sweeps only its own temporary files", async () => {
    const { disk, store } = await atomicFixture();
    const directory = path.dirname(store.file);
    const own = path.join(directory, `.${path.basename(store.file)}.id-9.tmp`);
    const foreign = path.join(directory, "unrelated.tmp");
    disk.files.set(own, "tmp");
    disk.files.set(foreign, "tmp");
    expect(await store.sweepTemporary()).toBe(1);
    expect(disk.files.has(own)).toBe(false);
    expect(disk.files.has(foreign)).toBe(true);
  });
});

function liveness(options: {
  alive?: boolean | "unknown" | ((pid: number) => boolean | "unknown");
  actual?: string | null;
}): ProcessLiveness {
  return {
    isAlive(pid) {
      return typeof options.alive === "function" ? options.alive(pid) : (options.alive ?? false);
    },
    startedAt() {
      return options.actual ?? null;
    },
  };
}

async function lockFixture(options?: {
  disk?: FakeDisk;
  processes?: ProcessLiveness;
  acquireTimeoutMs?: number;
}) {
  const disk = options?.disk ?? new FakeDisk();
  disk.addDir(HOME);
  const clock = new FakeClock();
  const lockPath = path.join(HOME, ".lock");
  const result = await acquireProcessLock({
    file: lockPath,
    files: disk.asLockFs(),
    clock,
    ids: ids(),
    sleeper: {
      async sleep(milliseconds) {
        clock.advance(milliseconds);
      },
    },
    processes: options?.processes ?? liveness({ alive: false }),
    pid: 111,
    ownerToken: "mine",
    acquireTimeoutMs: options?.acquireTimeoutMs ?? 100,
    retryDelayMs: 10,
    staleGuardMs: 30_000,
    bootTime: () => Date.parse(NOW),
  });
  return { disk, clock, lock: result, lockPath };
}

describe("process-lock", () => {
  test("acquires with a readback token and releases idempotently", async () => {
    const { disk, lock, lockPath } = await lockFixture();
    expect(lock.ownerToken).toBe("mine");
    expect(JSON.parse(disk.readText(lockPath))).toMatchObject({
      version: 1,
      ownerToken: "mine",
      pid: 111,
      processStartedAt: null,
    });
    await lock.assertHeld();
    await lock.release();
    expect(disk.files.has(lockPath)).toBe(false);
    await lock.release();
  });

  test("does not steal a live lock and times out with holder details", async () => {
    const disk = new FakeDisk();
    disk.addDir(HOME);
    const lockPath = path.join(HOME, ".lock");
    disk.files.set(
      lockPath,
      JSON.stringify({
        version: 1,
        ownerToken: "other",
        pid: 222,
        startedAt: NOW,
        processStartedAt: NOW,
      }),
    );
    const clock = new FakeClock();
    await expect(
      acquireProcessLock({
        file: lockPath,
        files: disk.asLockFs(),
        clock,
        ids: ids(),
        sleeper: {
          async sleep(milliseconds) {
            clock.advance(milliseconds);
          },
        },
        processes: liveness({ alive: true, actual: NOW }),
        pid: 111,
        ownerToken: "mine",
        acquireTimeoutMs: 50,
        retryDelayMs: 10,
        bootTime: () => Date.parse(NOW),
      }),
    ).rejects.toMatchObject({ code: "lock-contended", holder: { pid: 222 } });
    expect(JSON.parse(disk.readText(lockPath)).ownerToken).toBe("other");
  });

  test("reclaims dead pids, previous boots, and verified pid reuse only", async () => {
    const dead = new FakeDisk();
    dead.addDir(HOME);
    const deadPath = path.join(HOME, ".lock");
    dead.files.set(
      deadPath,
      JSON.stringify({
        version: 1,
        ownerToken: "old",
        pid: 999_999,
        startedAt: NOW,
        processStartedAt: null,
      }),
    );
    const acquired = await lockFixture({ disk: dead, processes: liveness({ alive: false }) });
    expect(acquired.lock.ownerToken).toBe("mine");
    expect(JSON.parse(dead.readText(deadPath)).ownerToken).toBe("mine");

    const reused = new FakeDisk();
    reused.addDir(HOME);
    const reusedPath = path.join(HOME, ".lock");
    reused.files.set(
      reusedPath,
      JSON.stringify({
        version: 1,
        ownerToken: "old",
        pid: 333,
        startedAt: NOW,
        processStartedAt: "2026-10-26T00:00:00.000Z",
      }),
    );
    const reusedLock = await lockFixture({
      disk: reused,
      processes: liveness({ alive: true, actual: NOW }),
    });
    expect(reusedLock.lock.ownerToken).toBe("mine");

    const unknown = new FakeDisk();
    unknown.addDir(HOME);
    const unknownPath = path.join(HOME, ".lock");
    unknown.files.set(
      unknownPath,
      JSON.stringify({
        version: 1,
        ownerToken: "old",
        pid: 444,
        startedAt: NOW,
        processStartedAt: null,
      }),
    );
    await expect(
      lockFixture({ disk: unknown, processes: liveness({ alive: "unknown" }) }),
    ).rejects.toMatchObject({ code: "lock-contended" });
  });

  test("reclaims a previous-boot lock but not a lock created before boot whose process outlived it", async () => {
    const bootTime = Date.parse(NOW);
    const crossBoot = new FakeDisk();
    crossBoot.addDir(HOME);
    const crossBootPath = path.join(HOME, ".lock");
    crossBoot.files.set(
      crossBootPath,
      JSON.stringify({
        version: 1,
        ownerToken: "old",
        pid: 555,
        startedAt: "2026-10-26T20:00:00.000Z",
        processStartedAt: "2026-10-26T20:00:00.000Z",
      }),
    );
    const acquired = await lockFixture({
      disk: crossBoot,
      processes: liveness({ alive: true, actual: NOW }),
    });
    expect(acquired.lock.ownerToken).toBe("mine");

    const stillLive = new FakeDisk();
    stillLive.addDir(HOME);
    const stillLivePath = path.join(HOME, ".lock");
    stillLive.files.set(
      stillLivePath,
      JSON.stringify({
        version: 1,
        ownerToken: "old",
        pid: 666,
        startedAt: "2026-10-26T20:00:00.000Z",
        processStartedAt: "2026-10-27T00:01:00.000Z",
      }),
    );
    const clock = new FakeClock();
    await expect(
      acquireProcessLock({
        file: stillLivePath,
        files: stillLive.asLockFs(),
        clock,
        ids: ids(),
        sleeper: {
          async sleep(milliseconds) {
            clock.advance(milliseconds);
          },
        },
        processes: liveness({ alive: true, actual: "2026-10-27T00:01:00.000Z" }),
        pid: 111,
        ownerToken: "mine",
        acquireTimeoutMs: 50,
        retryDelayMs: 10,
        bootTime: () => bootTime,
      }),
    ).rejects.toMatchObject({ code: "lock-contended" });
  });

  test("fails closed on a corrupt lock and on a corrupt reclaim guard", async () => {
    const disk = new FakeDisk();
    disk.addDir(HOME);
    const lockPath = path.join(HOME, ".lock");
    disk.files.set(lockPath, "not-json");
    await expect(lockFixture({ disk })).rejects.toMatchObject({ code: "lock-corrupt" });

    const guarded = new FakeDisk();
    guarded.addDir(HOME);
    const guardedPath = path.join(HOME, ".lock");
    guarded.files.set(
      guardedPath,
      JSON.stringify({
        version: 1,
        ownerToken: "old",
        pid: 999_999,
        startedAt: NOW,
        processStartedAt: null,
      }),
    );
    guarded.files.set(`${guardedPath}.reclaim`, "broken");
    await expect(lockFixture({ disk: guarded })).rejects.toMatchObject({ code: "lock-corrupt" });
    expect(guarded.readText(guardedPath)).toContain('"ownerToken":"old"');
  });

  test("steals a stale reclaim guard and leaves neither guard nor stale file", async () => {
    const disk = new FakeDisk();
    disk.addDir(HOME);
    const lockPath = path.join(HOME, ".lock");
    disk.files.set(
      lockPath,
      JSON.stringify({
        version: 1,
        ownerToken: "old",
        pid: 999_999,
        startedAt: NOW,
        processStartedAt: null,
      }),
    );
    disk.files.set(
      `${lockPath}.reclaim`,
      JSON.stringify({
        version: 1,
        ownerToken: "guard",
        pid: 999_998,
        startedAt: "2026-10-26T23:00:00.000Z",
        processStartedAt: null,
      }),
    );
    const acquired = await lockFixture({ disk });
    expect(acquired.lock.ownerToken).toBe("mine");
    expect(disk.files.has(`${lockPath}.reclaim`)).toBe(false);
    expect([...disk.files.keys()].some((file) => file.includes(".reclaim.stale-"))).toBe(false);
  });

  test("refuses to wait on a live reclaim guard", async () => {
    const disk = new FakeDisk();
    disk.addDir(HOME);
    const lockPath = path.join(HOME, ".lock");
    disk.files.set(
      lockPath,
      JSON.stringify({
        version: 1,
        ownerToken: "old",
        pid: 999_999,
        startedAt: NOW,
        processStartedAt: null,
      }),
    );
    disk.files.set(
      `${lockPath}.reclaim`,
      JSON.stringify({
        version: 1,
        ownerToken: "guard",
        pid: 777,
        startedAt: NOW,
        processStartedAt: NOW,
      }),
    );
    await expect(
      lockFixture({ disk, processes: liveness({ alive: (pid) => pid === 777 }) }),
    ).rejects.toMatchObject({ code: "lock-contended" });
    expect(disk.readText(lockPath)).toContain('"ownerToken":"old"');
  });

  test("releases idempotently after deletion and refuses to delete a corrupt lock", async () => {
    const missing = await lockFixture();
    missing.disk.files.delete(missing.lockPath);
    await missing.lock.release();
    await missing.lock.release();

    const corrupt = await lockFixture();
    corrupt.disk.files.set(corrupt.lockPath, "garbage");
    await expect(corrupt.lock.release()).rejects.toMatchObject({ code: "lock-corrupt" });
    expect(corrupt.disk.readText(corrupt.lockPath)).toBe("garbage");
  });

  test("surfaces a reclaim guard write failure", async () => {
    const disk = new FakeDisk();
    disk.addDir(HOME);
    const lockPath = path.join(HOME, ".lock");
    disk.files.set(
      lockPath,
      JSON.stringify({
        version: 1,
        ownerToken: "old",
        pid: 999_999,
        startedAt: NOW,
        processStartedAt: null,
      }),
    );
    disk.guardWriteFailure = "ENOSPC";
    await expect(lockFixture({ disk })).rejects.toMatchObject({ code: "lock-unavailable" });
  });

  test("reports lock loss when the file is replaced or removed", async () => {
    const { disk, lock, lockPath } = await lockFixture();
    disk.files.set(
      lockPath,
      JSON.stringify({
        version: 1,
        ownerToken: "other",
        pid: 222,
        startedAt: NOW,
        processStartedAt: null,
      }),
    );
    await expect(lock.assertHeld()).rejects.toMatchObject({ code: "lock-lost" });
    await expect(lock.release()).rejects.toMatchObject({ code: "lock-lost" });
    expect(disk.readText(lockPath)).toContain('"ownerToken":"other"');

    disk.files.delete(lockPath);
    await expect(lock.assertHeld()).rejects.toMatchObject({ code: "lock-lost" });
  });
});

describe("atomic-json failure branches", () => {
  test("classifies malformed bodies and headers as schema corruption", async () => {
    const bodies = [
      "[]",
      "{}",
      JSON.stringify({ schemaVersion: "1" }),
      JSON.stringify({ schemaVersion: 1, revision: 0, previousDigest: "", value: "x" }),
      JSON.stringify({ schemaVersion: 1, revision: 2, previousDigest: "nope", value: "x" }),
      JSON.stringify({ schemaVersion: 1, revision: 1, previousDigest: "", value: 1 }),
    ];
    for (const body of bodies) {
      const { disk, store } = await atomicFixture();
      disk.files.set(store.file, body);
      const result = await store.read();
      expect(result.status).toBe("corrupt");
      if (result.status === "corrupt") expect(result.reason).toBe("schema");
    }
  });

  test("rejects invariant violations and unencodable records", async () => {
    const { store } = await atomicFixture();
    await expect(
      store.commit(record(1, "", "x".repeat(201)), { revision: 0, digest: "" }),
    ).rejects.toMatchObject({ code: "invalid-record" });
    const circular: TestRecord & { self?: unknown } = record();
    circular.self = circular;
    await expect(store.commit(circular, { revision: 0, digest: "" })).rejects.toMatchObject({
      code: "invalid-record",
    });
  });

  test("rejects a missing record with a non-zero CAS, an oversize current record, and a corrupt current record", async () => {
    const missing = await atomicFixture();
    await expect(
      missing.store.commit(record(), { revision: 1, digest: `sha256:${"0".repeat(64)}` }),
    ).rejects.toMatchObject({ code: "cas-mismatch" });

    const oversize = await atomicFixture({ limits: { hardBytes: 16, softBytes: 8 } });
    oversize.disk.files.set(oversize.store.file, "x".repeat(32));
    await expect(
      oversize.store.commit(record(), { revision: 0, digest: "" }),
    ).rejects.toMatchObject({ code: "corrupt" });

    const corrupt = await atomicFixture();
    corrupt.disk.files.set(corrupt.store.file, "{");
    await expect(corrupt.store.commit(record(), { revision: 0, digest: "" })).rejects.toMatchObject(
      { code: "corrupt" },
    );
    expect(corrupt.disk.files.size).toBeGreaterThan(1);
  });

  test("surfaces write, read, and sweep failures", async () => {
    const writes = await atomicFixture();
    writes.disk.recordWriteFailure = "ENOSPC";
    await expect(writes.store.commit(record(), { revision: 0, digest: "" })).rejects.toMatchObject({
      code: "write-failed",
    });

    const reads = await atomicFixture();
    await createFirst(reads.store);
    reads.disk.readFailure = "EIO";
    await expect(reads.store.read()).rejects.toMatchObject({ code: "unreadable" });

    const sweeps = await atomicFixture();
    sweeps.disk.readdirFailure = true;
    await expect(sweeps.store.sweepTemporary()).rejects.toMatchObject({ code: "unreadable" });
  });

  test("turns an unwritable issue into a memory-only diagnosis", async () => {
    const errors: unknown[] = [];
    const { disk, store } = await atomicFixture({ onIssueError: (error) => errors.push(error) });
    disk.files.set(store.file, "{");
    disk.renameFailures.push(...Array(8).fill("EBUSY"));
    const result = await store.read();
    expect(result.status).toBe("corrupt");
    if (result.status === "corrupt") {
      expect(result.issuePath).toBeNull();
      expect(result.diagnostic).toBe("memory");
    }
    expect(errors.length).toBe(1);
  });

  test("treats a throwing header accessor as corruption and a header-invalid commit", async () => {
    const broken: AtomicJsonCodec<TestRecord> = {
      ...codec,
      readHeader() {
        throw new Error("header missing");
      },
    };
    const { disk, store } = await atomicFixture({ codec: broken });
    disk.files.set(
      store.file,
      `${JSON.stringify({ schemaVersion: 1, revision: 1, previousDigest: "", value: "x" })}\n`,
    );
    const result = await store.read();
    expect(result.status).toBe("corrupt");
    if (result.status === "corrupt") expect(result.reason).toBe("schema");
    const fresh = await atomicFixture({ codec: broken });
    await expect(fresh.store.commit(record(), { revision: 0, digest: "" })).rejects.toMatchObject({
      code: "header-invalid",
    });
  });
});

describe("process-lock failure branches", () => {
  test("rejects a relative path and surfaces unreadable or unwritable lock files", async () => {
    await expect(acquireProcessLock({ file: "relative.lock" })).rejects.toMatchObject({
      code: "lock-unavailable",
    });

    const unreadable = new FakeDisk();
    unreadable.addDir(HOME);
    unreadable.readFailure = "EIO";
    await expect(lockFixture({ disk: unreadable })).rejects.toMatchObject({
      code: "lock-unavailable",
    });

    const unwritable = new FakeDisk();
    unwritable.addDir(HOME);
    unwritable.lockWriteFailure = "ENOSPC";
    await expect(lockFixture({ disk: unwritable })).rejects.toMatchObject({
      code: "lock-unavailable",
    });
  });

  test("classifies EPERM liveness as unknown and only knows its own process start", () => {
    const denied = createProcessLiveness(() => {
      throw fsError("EPERM");
    });
    expect(denied.isAlive(1)).toBe("unknown");
    const missing = createProcessLiveness(() => {
      throw fsError("ESRCH");
    });
    expect(missing.isAlive(1)).toBe(false);
    const own = createProcessLiveness();
    expect(own.startedAt?.(process.pid)).not.toBeNull();
    expect(own.startedAt?.(process.pid + 1)).toBeNull();
  });
});

describe("atomic-json containment on existing records", () => {
  test("rejects a record behind a junction that escapes home", async () => {
    const disk = new FakeDisk();
    const { store } = await atomicFixture({ disk });
    const created = await createFirst(store);
    const records = path.dirname(store.file);
    disk.realpaths.set(records, path.join(OUTSIDE, "runs"));
    await expect(store.read()).rejects.toMatchObject({ code: "path-escape" });
    expect(created.revision).toBe(1);
  });
});

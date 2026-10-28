import { randomUUID } from "node:crypto";
import { type FileHandle, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { uptime } from "node:os";
import path from "node:path";

const GUARD_SUFFIX = ".reclaim";
const GUARD_STALE_MS = 30_000;
const BOOT_TIME_TOLERANCE_MS = 60 * 60 * 1000;
const RETRY_DELAY_MAX_MS = 200;

export type LockRecord = {
  version: 1;
  ownerToken: string;
  pid: number;
  startedAt: string;
  processStartedAt: string | null;
};

export type LockFs = {
  readFile(target: string): Promise<string>;
  writeFileExclusive(target: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(target: string): Promise<void>;
  readdir(target: string): Promise<string[]>;
};

export type ProcessLiveness = {
  isAlive(pid: number): boolean | "unknown";
  startedAt?(pid: number): string | null;
};

export type ProcessLockErrorCode =
  | "lock-contended"
  | "lock-corrupt"
  | "lock-lost"
  | "lock-unavailable";

export type LockHolder = {
  pid: number;
  startedAt: string;
  processStartedAt: string | null;
};

export class ProcessLockError extends Error {
  readonly code: ProcessLockErrorCode;
  readonly holder?: LockHolder;

  constructor(code: ProcessLockErrorCode, detail: string, holder?: LockHolder) {
    super(`process lock ${code}: ${detail}`);
    this.name = "ProcessLockError";
    this.code = code;
    this.holder = holder;
  }
}

export type ProcessLock = {
  readonly ownerToken: string;
  readonly file: string;
  assertHeld(): Promise<void>;
  release(): Promise<void>;
};

type LockClock = { now(): string };
type LockIds = { next(): string };
type LockSleeper = { sleep(milliseconds: number): Promise<void> };

type KillProbe = (pid: number, signal: 0) => unknown;

export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** EPERM proves the pid exists but not whose it is; fail closed. */
export function createProcessLiveness(kill: KillProbe = process.kill): ProcessLiveness {
  // Compute the process start once so a later initialize cannot cross a second boundary.
  const ownStartedAt = new Date(
    Math.floor((Date.now() - process.uptime() * 1000) / 1000) * 1000,
  ).toISOString();
  return {
    isAlive(candidate) {
      try {
        kill(candidate, 0);
        return true;
      } catch (error) {
        return errorCode(error) === "EPERM" ? "unknown" : false;
      }
    },
    startedAt(candidate) {
      return candidate === process.pid ? ownStartedAt : null;
    },
  };
}

export const defaultProcessLiveness = createProcessLiveness();

/** Windows can return these from open(wx) while the previous handle is still settling. */
export const TRANSIENT_EXCLUSIVE_OPEN_CODES = {
  EPERM: true,
  EBUSY: true,
  EACCES: true,
} as const;
export const EXCLUSIVE_OPEN_ATTEMPTS = 5;
export const EXCLUSIVE_OPEN_BACKOFF_MS = 20;
export const EXCLUSIVE_OPEN_BUDGET_MS = 200;

export type ExclusiveOpenDeps = {
  openFile?: (target: string, flags: string) => Promise<FileHandle>;
  sleeper?: LockSleeper;
  now?: () => number;
};

export function isTransientExclusiveOpenError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && Object.hasOwn(TRANSIENT_EXCLUSIVE_OPEN_CODES, code);
}

/** open(wx) with a bounded retry for transient Windows codes. EEXIST is not retried. */
export async function openExclusive(
  target: string,
  deps: ExclusiveOpenDeps = {},
): Promise<FileHandle> {
  const openFile = deps.openFile ?? open;
  const sleeper = deps.sleeper ?? defaultSleeper;
  const now = deps.now ?? Date.now;
  const started = now();
  let lastError: unknown;
  for (let attempt = 1; attempt <= EXCLUSIVE_OPEN_ATTEMPTS; attempt += 1) {
    try {
      return await openFile(target, "wx");
    } catch (error) {
      lastError = error;
      if (!isTransientExclusiveOpenError(error)) throw error;
      if (attempt === EXCLUSIVE_OPEN_ATTEMPTS || now() - started >= EXCLUSIVE_OPEN_BUDGET_MS) {
        throw error;
      }
      await sleeper.sleep(EXCLUSIVE_OPEN_BACKOFF_MS * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`exclusive open failed for ${target}`);
}

export function createNodeLockFs(deps: ExclusiveOpenDeps = {}): LockFs {
  return {
    readFile(target) {
      return readFile(target, "utf8");
    },
    async writeFileExclusive(target, content) {
      const handle = await openExclusive(target, deps);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    rename,
    async rm(target) {
      await rm(target, { force: true });
    },
    readdir,
  };
}

export const nodeLockFs: LockFs = createNodeLockFs();

const defaultClock: LockClock = { now: () => new Date().toISOString() };
const defaultIds: LockIds = { next: randomUUID };
const defaultSleeper: LockSleeper = {
  sleep(milliseconds) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, milliseconds);
    return promise;
  },
};

function parseLock(raw: string): LockRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (!("version" in value) || value.version !== 1) return null;
  const ownerToken = "ownerToken" in value ? value.ownerToken : undefined;
  if (typeof ownerToken !== "string" || ownerToken.length === 0) return null;
  const candidatePid = "pid" in value ? value.pid : undefined;
  if (typeof candidatePid !== "number" || !Number.isInteger(candidatePid) || candidatePid < 0) {
    return null;
  }
  const startedAt = "startedAt" in value ? value.startedAt : undefined;
  if (typeof startedAt !== "string" || !Number.isFinite(Date.parse(startedAt))) return null;
  const processStartedAt = "processStartedAt" in value ? value.processStartedAt : null;
  if (
    processStartedAt !== null &&
    (typeof processStartedAt !== "string" || !Number.isFinite(Date.parse(processStartedAt)))
  ) {
    return null;
  }
  return { version: 1, ownerToken, pid: candidatePid, startedAt, processStartedAt };
}

async function readLock(files: LockFs, target: string): Promise<LockRecord | null | "corrupt"> {
  let raw: string;
  try {
    raw = await files.readFile(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new ProcessLockError("lock-unavailable", messageOf(error));
  }
  return parseLock(raw) ?? "corrupt";
}

function holderOf(lock: LockRecord): LockHolder {
  return { pid: lock.pid, startedAt: lock.startedAt, processStartedAt: lock.processStartedAt };
}

/** A live lock is never stolen. Dead pids, previous-boot locks, and verified pid reuse are. */
function isReclaimable(lock: LockRecord, processes: ProcessLiveness, bootTimeMs: number): boolean {
  const lockStarted = Date.parse(lock.startedAt);
  const processStarted = lock.processStartedAt ? Date.parse(lock.processStartedAt) : Number.NaN;
  if (
    Number.isFinite(lockStarted) &&
    Number.isFinite(processStarted) &&
    Number.isFinite(bootTimeMs) &&
    lockStarted < bootTimeMs - BOOT_TIME_TOLERANCE_MS &&
    processStarted < bootTimeMs
  ) {
    return true;
  }
  const alive = processes.isAlive(lock.pid);
  if (alive === false) return true;
  if (alive !== true) return false;
  const recorded = lock.processStartedAt ?? null;
  const actual = processes.startedAt?.(lock.pid) ?? null;
  return recorded !== null && actual !== null && recorded !== actual;
}

async function releaseGuard(files: LockFs, guardPath: string, token: string): Promise<void> {
  try {
    const guard = await readLock(files, guardPath);
    if (guard !== null && guard !== "corrupt" && guard.ownerToken === token) {
      await files.rm(guardPath);
    }
  } catch {
    // A missing/damaged guard must not keep the lock acquisition half-finished.
  }
}

async function sweepStale(files: LockFs, file: string): Promise<void> {
  const directory = path.dirname(file);
  const base = path.basename(file);
  let names: string[];
  try {
    names = await files.readdir(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(`${base}.stale-`) || name.startsWith(`${base}${GUARD_SUFFIX}.stale-`)) {
      await files.rm(path.join(directory, name)).catch(() => undefined);
    }
  }
}

async function tryReclaim(
  files: LockFs,
  file: string,
  observed: LockRecord,
  mine: LockRecord,
  encoded: string,
  options: {
    processes: ProcessLiveness;
    clock: LockClock;
    ids: LockIds;
    staleGuardMs: number;
    bootTimeMs: number;
  },
): Promise<boolean> {
  const guardPath = `${file}${GUARD_SUFFIX}`;
  const guardToken = options.ids.next();
  const guard: LockRecord = {
    version: 1,
    ownerToken: guardToken,
    pid: mine.pid,
    startedAt: options.clock.now(),
    processStartedAt: mine.processStartedAt,
  };
  const guardEncoded = `${JSON.stringify(guard)}\n`;
  let ownsGuard = false;
  try {
    try {
      await files.writeFileExclusive(guardPath, guardEncoded);
      ownsGuard = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw new ProcessLockError("lock-unavailable", messageOf(error));
      }
      const existing = await readLock(files, guardPath);
      if (existing === null) return false;
      if (existing === "corrupt") {
        throw new ProcessLockError(
          "lock-corrupt",
          `reclaim guard ${guardPath} is malformed; inspect and remove it manually`,
        );
      }
      const age = Date.parse(options.clock.now()) - Date.parse(existing.startedAt);
      const dead = options.processes.isAlive(existing.pid) === false;
      if (!dead && !(Number.isFinite(age) && age >= options.staleGuardMs)) return false;
      try {
        await files.rename(guardPath, `${guardPath}.stale-${guardToken}`);
      } catch {
        return false;
      }
      try {
        await files.writeFileExclusive(guardPath, guardEncoded);
        ownsGuard = true;
      } catch {
        return false;
      }
    }

    const current = await readLock(files, file);
    if (current === null) return false;
    if (current === "corrupt") {
      throw new ProcessLockError(
        "lock-corrupt",
        `lock file ${file} is malformed; inspect and remove it manually`,
      );
    }
    if (
      current.ownerToken !== observed.ownerToken ||
      current.pid !== observed.pid ||
      !isReclaimable(current, options.processes, options.bootTimeMs)
    ) {
      return false;
    }
    const guardBeforeRemove = await readLock(files, guardPath);
    if (guardBeforeRemove === null || guardBeforeRemove === "corrupt") return false;
    if (guardBeforeRemove.ownerToken !== guardToken) return false;
    await files.rm(file);
    const guardBeforeCreate = await readLock(files, guardPath);
    if (guardBeforeCreate === null || guardBeforeCreate === "corrupt") return false;
    if (guardBeforeCreate.ownerToken !== guardToken) return false;
    try {
      await files.writeFileExclusive(file, encoded);
    } catch (error) {
      if (errorCode(error) === "EEXIST") return false;
      throw new ProcessLockError("lock-unavailable", messageOf(error));
    }
    const written = await readLock(files, file);
    return written !== null && written !== "corrupt" && written.ownerToken === mine.ownerToken;
  } finally {
    if (ownsGuard) await releaseGuard(files, guardPath, guardToken);
  }
}

function createHandle(files: LockFs, file: string, ownerToken: string): ProcessLock {
  let held = true;
  return {
    ownerToken,
    file,
    async assertHeld() {
      const current = await readLock(files, file);
      if (current === null || current === "corrupt" || current.ownerToken !== ownerToken) {
        throw new ProcessLockError(
          "lock-lost",
          `no longer owns ${file}`,
          current !== null && current !== "corrupt" ? holderOf(current) : undefined,
        );
      }
    },
    async release() {
      if (!held) return;
      const current = await readLock(files, file);
      if (current === null) {
        held = false;
        return;
      }
      if (current === "corrupt") {
        throw new ProcessLockError("lock-corrupt", `lock file ${file} is malformed`);
      }
      if (current.ownerToken !== ownerToken) {
        throw new ProcessLockError("lock-lost", `no longer owns ${file}`, holderOf(current));
      }
      // Drop the file first. If rm fails (Windows handle / EPERM), keep `held` so
      // a later release() can retry instead of leaving an orphan lock forever.
      try {
        await files.rm(file);
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          held = false;
          return;
        }
        throw new ProcessLockError(
          "lock-unavailable",
          `failed to remove ${file}: ${messageOf(error)}`,
        );
      }
      held = false;
    },
  };
}

export type ProcessLockOptions = {
  file: string;
  ownerToken?: string;
  pid?: number;
  files?: LockFs;
  clock?: LockClock;
  ids?: LockIds;
  sleeper?: LockSleeper;
  processes?: ProcessLiveness;
  bootTime?: () => number;
  acquireTimeoutMs?: number;
  retryDelayMs?: number;
  staleGuardMs?: number;
};

export async function acquireProcessLock(options: ProcessLockOptions): Promise<ProcessLock> {
  if (!path.isAbsolute(options.file)) {
    throw new ProcessLockError("lock-unavailable", `lock path must be absolute: ${options.file}`);
  }
  const files = options.files ?? nodeLockFs;
  const clock = options.clock ?? defaultClock;
  const ids = options.ids ?? defaultIds;
  const sleeper = options.sleeper ?? defaultSleeper;
  const processes = options.processes ?? defaultProcessLiveness;
  const pid = options.pid ?? process.pid;
  const acquireTimeoutMs = options.acquireTimeoutMs ?? 10_000;
  const retryDelayMs = options.retryDelayMs ?? 25;
  const staleGuardMs = options.staleGuardMs ?? GUARD_STALE_MS;
  const bootTime = options.bootTime ?? (() => Date.parse(clock.now()) - uptime() * 1000);
  const file = path.resolve(options.file);
  const ownerToken = options.ownerToken ?? ids.next();
  const startedAt = clock.now();
  const mine: LockRecord = {
    version: 1,
    ownerToken,
    pid,
    startedAt,
    processStartedAt: processes.startedAt?.(pid) ?? null,
  };
  const encoded = `${JSON.stringify(mine)}\n`;
  const deadline = Date.parse(startedAt) + acquireTimeoutMs;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    try {
      await files.writeFileExclusive(file, encoded);
      const written = await readLock(files, file);
      if (written === null || written === "corrupt" || written.ownerToken !== ownerToken) {
        throw new ProcessLockError("lock-unavailable", `readback failed for ${file}`);
      }
      await sweepStale(files, file);
      return createHandle(files, file, ownerToken);
    } catch (error) {
      if (error instanceof ProcessLockError) throw error;
      if (errorCode(error) !== "EEXIST") {
        throw new ProcessLockError("lock-unavailable", messageOf(error));
      }
    }

    const observed = await readLock(files, file);
    if (observed === "corrupt") {
      throw new ProcessLockError(
        "lock-corrupt",
        `lock file ${file} is malformed; inspect and remove it manually`,
      );
    }
    if (observed === null) {
      if (Date.parse(clock.now()) >= deadline) {
        throw new ProcessLockError("lock-contended", `lock ${file} churned before acquisition`);
      }
      await sleeper.sleep(Math.min(retryDelayMs * attempt, RETRY_DELAY_MAX_MS));
      continue;
    }
    if (isReclaimable(observed, processes, bootTime())) {
      const reclaimed = await tryReclaim(files, file, observed, mine, encoded, {
        processes,
        clock,
        ids,
        staleGuardMs,
        bootTimeMs: bootTime(),
      });
      if (reclaimed) {
        const written = await readLock(files, file);
        if (written !== null && written !== "corrupt" && written.ownerToken === ownerToken) {
          await sweepStale(files, file);
          return createHandle(files, file, ownerToken);
        }
        throw new ProcessLockError("lock-unavailable", `reclaim readback failed for ${file}`);
      }
    }
    if (Date.parse(clock.now()) >= deadline) {
      throw new ProcessLockError(
        "lock-contended",
        `held by pid ${observed.pid} since ${observed.startedAt}`,
        holderOf(observed),
      );
    }
    await sleeper.sleep(Math.min(retryDelayMs * attempt, RETRY_DELAY_MAX_MS));
  }
}

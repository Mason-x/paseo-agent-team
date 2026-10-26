import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { uptime } from "node:os";
import path from "node:path";
import { z } from "zod";
import { utf8ByteLength } from "../../shared/domain/design-output";
import {
  DesignHashSchema,
  type DesignJob,
  DesignJobSchema,
  DesignNonceSchema,
  type DesignResult,
  DesignResultSchema,
  DesignTimeSchema,
  DesignUuidSchema,
} from "../../shared/schemas/design";
import {
  CoordinatorPreviewSchema,
  ModeIssueSchema,
  ModeLaunchPreviewSchema,
  SeatBudgetSchema,
  SeatCountsSchema,
  SeatPreviewSchema,
  SeatProfileSchema,
} from "../../shared/schemas/launch-preview";
import { TeamModeSchema } from "../../shared/schemas/team-mode";
import { designZh } from "../../shared/zh/design";
import {
  confirmDesignJobsContainment,
  type DesignDataRoot,
  DesignDataRootErrorException,
  designJobPath,
  isContained,
  resolveDesignDataRoot,
} from "./data-root";

export const DESIGN_RECORD_VERSION = 1;
export const DESIGN_RECORD_MAX_BYTES = 512 * 1024;
const LOCK_NAME = ".lock";
const RECLAIM_GUARD_NAME = ".reclaim";
const GUARD_STALE_MS = 30_000;
const BOOT_TIME_TOLERANCE_MS = 60 * 60 * 1000;
const RENAME_ATTEMPTS = 8;
const TEMP_FILE = /^\.[0-9a-f-]{36}\..+\.tmp$/iu;
const TERMINAL = new Set(["saved", "failed", "canceled"]);

export type DesignClock = { now(): string };
export type DesignIds = { next(): string };
export type ProcessLiveness = {
  isAlive(pid: number): boolean | "unknown";
  startedAt?(pid: number): string | null;
};
export type DesignSleeper = { sleep(milliseconds: number): Promise<void> };
export type DesignStoreFs = {
  mkdir(path: string): Promise<void>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  openExclusive(path: string, content: string): Promise<void>;
};
export type DesignAttemptRecord = {
  attempt: 1 | 2 | 3;
  nonce: string;
  messageId: string;
  promptHash: string;
  epoch: string | null;
  endCursor: string | null;
  summary: string | null;
  ack: "pending" | "acked" | "unknown";
  turnId?: string | null;
  lastError?: string | null;
};
export type StoredDesignJob = {
  schemaVersion: number;
  job: DesignJob;
  request: string;
  requestHash: string;
  mode: z.infer<typeof TeamModeSchema>;
  selectionIntent: string | null;
  creation: { intentHash: string; idempotencyKey: string } | null;
  attempts: DesignAttemptRecord[];
  proposal: unknown;
  result: DesignResult | null;
  reuseFingerprints: Record<string, string>;
  leaseOwner: string | null;
  receipts: Record<string, string>;
  outcomeUnknown: boolean;
};
const AttemptRecordSchema = z.object({
  attempt: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  nonce: DesignNonceSchema,
  messageId: DesignUuidSchema,
  promptHash: DesignHashSchema,
  epoch: z.string().nullable(),
  endCursor: z.string().nullable(),
  summary: z.string().nullable(),
  ack: z.enum(["pending", "acked", "unknown"]),
  turnId: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
});
const LedgerModeIssueSchema = ModeIssueSchema.strip();
const LedgerSeatProfileSchema = SeatProfileSchema.strip();
const LedgerSeatPreviewSchema = SeatPreviewSchema.strip().extend({
  profile: LedgerSeatProfileSchema.nullable(),
  issues: z.array(LedgerModeIssueSchema),
});
const LedgerCoordinatorPreviewSchema = CoordinatorPreviewSchema.strip().extend({
  profile: LedgerSeatProfileSchema.nullable(),
  issues: z.array(LedgerModeIssueSchema),
});
const LedgerModeLaunchPreviewSchema = ModeLaunchPreviewSchema.strip().extend({
  coordinator: LedgerCoordinatorPreviewSchema,
  seats: z.array(LedgerSeatPreviewSchema),
  counts: SeatCountsSchema.strip(),
  budget: SeatBudgetSchema.strip(),
  issues: z.array(LedgerModeIssueSchema),
});
/** Future preview fields are accepted for reading and stripped to the current DTO. */
export const StoredDesignResultSchema = DesignResultSchema.extend({
  preview: LedgerModeLaunchPreviewSchema,
});
export const StoredDesignJobSchema = z.object({
  schemaVersion: z.number().int().positive(),
  job: DesignJobSchema,
  request: z.string(),
  requestHash: DesignHashSchema,
  mode: TeamModeSchema,
  selectionIntent: z.string().nullable(),
  creation: z.object({ intentHash: DesignHashSchema, idempotencyKey: z.string() }).nullable(),
  attempts: z.array(AttemptRecordSchema).max(3),
  proposal: z.unknown().nullable(),
  result: StoredDesignResultSchema.nullable(),
  reuseFingerprints: z.record(z.string(), DesignHashSchema),
  leaseOwner: z.string().nullable(),
  receipts: z.record(z.string(), z.string()),
  outcomeUnknown: z.boolean(),
});
export type DesignStoreIssue =
  | "unavailable"
  | "exists"
  | "missing"
  | "conflict"
  | "too-large"
  | "unknown-version"
  | "corrupt";
export class DesignStoreError extends Error {
  readonly issue: DesignStoreIssue;
  readonly detail?: string;
  constructor(issue: DesignStoreIssue, detail?: string) {
    super(detail ?? `design store ${issue}`);
    this.name = "DesignStoreError";
    this.issue = issue;
    this.detail = detail;
  }
}
export type DesignStoreProblem = { name: string; reason: "unknown-version" | "corrupt" };
export interface DesignJobStore {
  initialize(): Promise<void>;
  dispose(): Promise<void>;
  list(): Promise<StoredDesignJob[]>;
  problems(): Promise<DesignStoreProblem[]>;
  get(jobId: string): Promise<StoredDesignJob | null>;
  findRequest(clientRequestId: string): Promise<StoredDesignJob | null>;
  create(job: StoredDesignJob): Promise<void>;
  update(jobId: string, expectedRevision: string, next: StoredDesignJob): Promise<void>;
}
type LockFile = {
  version: 1;
  ownerToken: string;
  pid: number;
  startedAt: string;
  processStartedAt?: string | null;
};
const LockSchema = z.object({
  version: z.literal(1),
  ownerToken: z.string(),
  pid: z.number().int().nonnegative(),
  startedAt: DesignTimeSchema,
  // Optional for locks written before process-start tracking. Missing => pid reuse cannot be
  // verified, so a live lock is never stolen.
  processStartedAt: z.string().nullable().optional(),
});
const defaultFs: DesignStoreFs = {
  async mkdir(target) {
    await mkdir(target, { recursive: true });
  },
  async readFile(target) {
    return readFile(target, "utf8");
  },
  async writeFile(target, content) {
    const handle = await open(target, "w");
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
  async readdir(target) {
    return readdir(target);
  },
  async openExclusive(target, content) {
    const handle = await open(target, "wx");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};
function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}
function rawClientRequestId(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !("job" in parsed)) return null;
  const job = parsed.job;
  if (!job || typeof job !== "object" || !("clientRequestId" in job)) return null;
  return typeof job.clientRequestId === "string" ? job.clientRequestId : null;
}

function parseRecord(raw: string, file: string): StoredDesignJob | DesignStoreProblem["reason"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "corrupt";
  }
  const version = z.object({ schemaVersion: z.number() }).safeParse(parsed);
  if (!version.success) return "corrupt";
  if (version.data.schemaVersion !== DESIGN_RECORD_VERSION) return "unknown-version";
  const record = StoredDesignJobSchema.safeParse(parsed);
  if (!record.success || path.basename(file, ".json") !== record.data.job.jobId) return "corrupt";
  return record.data;
}
type KillProbe = (pid: number, signal: 0) => unknown;

/** Default liveness probe. EPERM proves the pid exists but not whose it is; fail closed. */
export function createProcessLiveness(kill: KillProbe = process.kill): ProcessLiveness {
  // Compute the process start once. Recomputing from uptime can cross a second boundary and make
  // the same process look like a different pid owner on a later initialize.
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

async function readLockFile(files: DesignStoreFs, lockPath: string): Promise<LockFile> {
  let raw: string;
  try {
    raw = await files.readFile(lockPath);
  } catch {
    throw new DesignStoreError("unavailable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DesignStoreError("unavailable");
  }
  const record = LockSchema.safeParse(parsed);
  if (!record.success) throw new DesignStoreError("unavailable");
  return record.data;
}

/** A live lock is never stolen. Dead pids, previous-boot locks, and verified pid reuse are. */
function isReclaimable(lock: LockFile, processes: ProcessLiveness, bootTimeMs: number): boolean {
  const lockStarted = Date.parse(lock.startedAt);
  const processStarted = lock.processStartedAt ? Date.parse(lock.processStartedAt) : NaN;
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

function lockUnavailable(lockPath: string, lock: LockFile): DesignStoreError {
  return new DesignStoreError(
    "unavailable",
    `${designZh.storageUnavailable}：锁文件 ${lockPath} 被 pid ${lock.pid} 持有（建锁 ${lock.startedAt}）。确认该进程已退出后可手动删除锁文件。`,
  );
}

async function acquireReclaimGuard(
  files: DesignStoreFs,
  processes: ProcessLiveness,
  clock: DesignClock,
  lockPath: string,
  token: string,
  pid: number,
): Promise<string> {
  const guardPath = `${lockPath}${RECLAIM_GUARD_NAME}`;
  const guard: LockFile = {
    version: 1,
    ownerToken: token,
    pid,
    startedAt: clock.now(),
    processStartedAt: processes.startedAt?.(pid) ?? null,
  };
  const encoded = `${JSON.stringify(guard)}\n`;
  try {
    await files.openExclusive(guardPath, encoded);
    return guardPath;
  } catch {
    const existing = await readLockFile(files, guardPath);
    const age = Date.parse(clock.now()) - Date.parse(existing.startedAt);
    const dead = processes.isAlive(existing.pid) === false;
    if (!dead && !(Number.isFinite(age) && age >= GUARD_STALE_MS)) {
      throw new DesignStoreError("unavailable");
    }
    try {
      await files.rename(guardPath, `${guardPath}.stale-${token}`);
    } catch {
      throw new DesignStoreError("unavailable");
    }
    try {
      await files.openExclusive(guardPath, encoded);
    } catch {
      throw new DesignStoreError("unavailable");
    }
    return guardPath;
  }
}

async function releaseReclaimGuard(
  files: DesignStoreFs,
  guardPath: string,
  token: string,
): Promise<void> {
  try {
    const guard = await readLockFile(files, guardPath);
    if (guard.ownerToken === token) await files.rm(guardPath);
  } catch {
    // A missing or damaged guard must not keep the store half-initialized.
  }
}

/**
 * Reclaim under a separate exclusive guard. Both contenders try to create the guard; only one can.
 * The winner re-reads the original lock under that guard and verifies the same ownerToken+pid is
 * still dead before removing it. A loser never renames or removes the winner's live lock, so two
 * instances cannot both acquire the ledger.
 */
async function reclaimAndCreateLock(
  files: DesignStoreFs,
  processes: ProcessLiveness,
  clock: DesignClock,
  ids: DesignIds,
  lockPath: string,
  encodedLock: string,
  pid: number,
  bootTimeMs: number,
): Promise<void> {
  const observed = await readLockFile(files, lockPath);
  if (!isReclaimable(observed, processes, bootTimeMs)) throw lockUnavailable(lockPath, observed);
  const guardToken = ids.next();
  const guardPath = await acquireReclaimGuard(files, processes, clock, lockPath, guardToken, pid);
  try {
    const current = await readLockFile(files, lockPath);
    if (
      current.ownerToken !== observed.ownerToken ||
      current.pid !== observed.pid ||
      !isReclaimable(current, processes, bootTimeMs)
    ) {
      throw lockUnavailable(lockPath, current);
    }
    const guardBeforeRemove = await readLockFile(files, guardPath);
    if (guardBeforeRemove.ownerToken !== guardToken) {
      throw new DesignStoreError("unavailable");
    }
    await files.rm(lockPath);
    const guardBeforeCreate = await readLockFile(files, guardPath);
    if (guardBeforeCreate.ownerToken !== guardToken) {
      throw new DesignStoreError("unavailable");
    }
    try {
      await files.openExclusive(lockPath, encodedLock);
    } catch {
      throw new DesignStoreError("unavailable");
    }
  } finally {
    await releaseReclaimGuard(files, guardPath, guardToken);
  }
}

async function sweepStaleLocks(files: DesignStoreFs, rootPath: string): Promise<void> {
  for (const name of await files.readdir(rootPath)) {
    if (name.startsWith(".lock.stale-") || name.startsWith(".lock.reclaim.stale-")) {
      await files.rm(path.join(rootPath, name));
    }
  }
}

async function sweepTemporaryFiles(files: DesignStoreFs, jobs: string): Promise<void> {
  for (const name of await files.readdir(jobs))
    if (TEMP_FILE.test(name)) await files.rm(path.join(jobs, name));
}
export function createDesignJobStore(options: {
  home: string | undefined;
  fs?: DesignStoreFs;
  clock?: DesignClock;
  ids?: DesignIds;
  pid?: number;
  processes?: ProcessLiveness;
  sleep?: DesignSleeper;
  bootTime?: () => number;
}): DesignJobStore {
  const files = options.fs ?? defaultFs;
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  // Anchor boot time to the injected clock so fixed-clock tests do not misclassify their locks.
  // In production this is equivalent to Date.now() - os.uptime()*1000.
  const bootTime = options.bootTime ?? (() => Date.parse(clock.now()) - uptime() * 1000);
  const ids = options.ids ?? { next: () => randomUUID() };
  const pid = options.pid ?? process.pid;
  const processes = options.processes ?? defaultProcessLiveness;
  const sleeper = options.sleep ?? {
    sleep(milliseconds: number) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, milliseconds);
      return promise;
    },
  };
  let root: DesignDataRoot | null = null;
  let ownerToken: string | null = null;
  let disposed = false;
  let queue: Promise<void> = Promise.resolve();
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = queue.then(operation, operation);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const requireRoot = (): DesignDataRoot => {
    if (!root || !ownerToken || disposed) throw new DesignStoreError("unavailable");
    return root;
  };
  async function writeRecord(dataRoot: DesignDataRoot, record: StoredDesignJob): Promise<void> {
    const parsed = StoredDesignJobSchema.safeParse(record);
    if (!parsed.success) throw new DesignStoreError("corrupt");
    const encoded = `${JSON.stringify(parsed.data)}\n`;
    if (utf8ByteLength(encoded) > DESIGN_RECORD_MAX_BYTES) throw new DesignStoreError("too-large");
    const destination = designJobPath(dataRoot, parsed.data.job.jobId);
    const temporary = path.join(dataRoot.jobs, `.${parsed.data.job.jobId}.${ids.next()}.tmp`);
    if (!isContained(dataRoot.jobs, temporary)) throw new DesignStoreError("unavailable");
    try {
      await files.writeFile(temporary, encoded);
    } catch (error) {
      await files.rm(temporary);
      throw error;
    }
    for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
      try {
        await files.rename(temporary, destination);
        return;
      } catch (error) {
        const code = errorCode(error);
        const retryable =
          code === "EBUSY" || code === "EPERM" || code === "EACCES" || code === undefined;
        if (!retryable || attempt === RENAME_ATTEMPTS) {
          await files.rm(temporary);
          throw error;
        }
        await sleeper.sleep(10 * attempt);
      }
    }
  }
  async function readNamed(
    dataRoot: DesignDataRoot,
    name: string,
  ): Promise<StoredDesignJob | DesignStoreProblem> {
    const file = path.join(dataRoot.jobs, name);
    const parsed = parseRecord(await files.readFile(file), file);
    return typeof parsed === "string" ? { name, reason: parsed } : parsed;
  }
  async function readOne(dataRoot: DesignDataRoot, jobId: string): Promise<StoredDesignJob | null> {
    let file: string;
    try {
      file = designJobPath(dataRoot, jobId);
    } catch {
      return null;
    }
    let raw: string;
    try {
      raw = await files.readFile(file);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw new DesignStoreError("unavailable");
    }
    const parsed = parseRecord(raw, file);
    if (parsed === "unknown-version") throw new DesignStoreError("unknown-version");
    if (parsed === "corrupt") throw new DesignStoreError("corrupt");
    return parsed;
  }
  return {
    async initialize() {
      if (ownerToken && !disposed) return;
      let resolved: DesignDataRoot;
      try {
        resolved = await resolveDesignDataRoot(options.home);
      } catch (error) {
        if (error instanceof DesignDataRootErrorException)
          throw new DesignStoreError("unavailable");
        throw error;
      }
      await files.mkdir(resolved.jobs);
      try {
        await confirmDesignJobsContainment(resolved);
      } catch (error) {
        if (error instanceof DesignDataRootErrorException)
          throw new DesignStoreError("unavailable");
        throw error;
      }
      root = resolved;
      const lockPath = path.join(resolved.root, LOCK_NAME);
      const nextLock: LockFile = {
        version: 1,
        ownerToken: ids.next(),
        pid,
        startedAt: clock.now(),
        processStartedAt: processes.startedAt?.(pid) ?? null,
      };
      const encoded = `${JSON.stringify(nextLock)}\n`;
      try {
        await files.openExclusive(lockPath, encoded);
      } catch {
        await reclaimAndCreateLock(
          files,
          processes,
          clock,
          ids,
          lockPath,
          encoded,
          pid,
          bootTime(),
        );
      }
      const written = LockSchema.parse(JSON.parse(await files.readFile(lockPath)));
      if (written.ownerToken !== nextLock.ownerToken) throw new DesignStoreError("unavailable");
      ownerToken = nextLock.ownerToken;
      disposed = false;
      await sweepTemporaryFiles(files, resolved.jobs);
      await sweepStaleLocks(files, resolved.root);
    },
    async dispose() {
      await exclusive(async () => {
        const currentRoot = root;
        const token = ownerToken;
        // Release in-memory state first: a missing or damaged lock must not leave the instance
        // half-disposed, and initialize() may fully rebuild it afterwards.
        root = null;
        ownerToken = null;
        disposed = true;
        if (!currentRoot || !token) return;
        const lockPath = path.join(currentRoot.root, LOCK_NAME);
        try {
          const current = LockSchema.parse(JSON.parse(await files.readFile(lockPath)));
          if (current.ownerToken === token) await files.rm(lockPath);
        } catch {
          // Missing/corrupt lock: memory is already released; nothing else is safe to delete.
        }
      });
    },
    list() {
      return exclusive(async () => {
        const dataRoot = requireRoot();
        const records: StoredDesignJob[] = [];
        for (const name of (await files.readdir(dataRoot.jobs)).filter(
          (name) => name.endsWith(".json") && !name.startsWith("."),
        )) {
          const parsed = await readNamed(dataRoot, name);
          if (!("reason" in parsed)) records.push(parsed);
        }
        return records;
      });
    },
    problems() {
      return exclusive(async () => {
        const dataRoot = requireRoot();
        const found: DesignStoreProblem[] = [];
        for (const name of (await files.readdir(dataRoot.jobs)).filter(
          (name) => name.endsWith(".json") && !name.startsWith("."),
        )) {
          const parsed = await readNamed(dataRoot, name);
          if ("reason" in parsed) found.push(parsed);
        }
        return found;
      });
    },
    get(jobId) {
      return exclusive(() => readOne(requireRoot(), jobId));
    },
    findRequest(clientRequestId) {
      return exclusive(async () => {
        const dataRoot = requireRoot();
        let found: StoredDesignJob | null = null;
        for (const name of await files.readdir(dataRoot.jobs)) {
          if (!name.endsWith(".json") || name.startsWith(".")) continue;
          const file = path.join(dataRoot.jobs, name);
          let raw: string;
          try {
            raw = await files.readFile(file);
          } catch (error) {
            if (errorCode(error) === "ENOENT") continue;
            throw new DesignStoreError("unavailable");
          }
          const parsed = parseRecord(raw, file);
          if (typeof parsed === "string") {
            // An unrelated damaged/unknown-version record must not block a new request. Only a
            // record that claims the same clientRequestId is unsafe to ignore.
            if (rawClientRequestId(raw) === clientRequestId) {
              throw new DesignStoreError(
                parsed === "unknown-version" ? "unknown-version" : "corrupt",
              );
            }
            continue;
          }
          if (found === null && parsed.job.clientRequestId === clientRequestId) found = parsed;
        }
        return found;
      });
    },
    create(job) {
      return exclusive(async () => {
        const dataRoot = requireRoot();
        if (await readOne(dataRoot, job.job.jobId)) throw new DesignStoreError("exists");
        await writeRecord(dataRoot, job);
      });
    },
    update(jobId, expectedRevision, next) {
      return exclusive(async () => {
        const dataRoot = requireRoot();
        const current = await readOne(dataRoot, jobId);
        if (!current) throw new DesignStoreError("missing");
        if (current.job.stateRevision !== expectedRevision || next.job.jobId !== jobId)
          throw new DesignStoreError("conflict");
        const currentTerminal = TERMINAL.has(current.job.state);
        const nextTerminal = TERMINAL.has(next.job.state);
        if (
          (currentTerminal && !nextTerminal) ||
          next.requestHash !== current.requestHash ||
          next.job.clientRequestId !== current.job.clientRequestId
        )
          throw new DesignStoreError("conflict");
        // Receipts are append-only idempotency evidence: existing keys may not be dropped or
        // rewritten by a later update.
        for (const [key, value] of Object.entries(current.receipts)) {
          if (next.receipts[key] !== value) throw new DesignStoreError("conflict");
        }
        await writeRecord(dataRoot, nextTerminal ? { ...next, proposal: null } : next);
      });
    },
  };
}

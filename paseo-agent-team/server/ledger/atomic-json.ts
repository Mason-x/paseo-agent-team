import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

/** 7MiB: callers should compact before the next commit adds more history. */
export const LEDGER_RECORD_SOFT_BYTES = 7 * 1024 * 1024;
/** 8MiB: hard rejection before any temp file is created. */
export const LEDGER_RECORD_HARD_BYTES = 8 * 1024 * 1024;
const RENAME_ATTEMPTS = 8;
const RENAME_RETRY_BASE_MS = 10;
const RETRYABLE_RENAME_CODES: Record<string, true> = {
  EBUSY: true,
  EPERM: true,
  EACCES: true,
  EAGAIN: true,
};
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ISSUE_DETAIL_MAX = 4096;

export type LedgerFs = {
  mkdir(target: string): Promise<void>;
  readFile(target: string): Promise<Uint8Array>;
  hashFile(target: string): Promise<string>;
  statSize(target: string): Promise<number | null>;
  writeFileExclusive(target: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(target: string): Promise<void>;
  readdir(target: string): Promise<string[]>;
  realpath(target: string): Promise<string>;
};

export type LedgerRoots = {
  home: string;
  root: string;
  records: string;
  issues: string;
};

export type LedgerHeader = {
  schemaVersion: number;
  revision: number;
  previousDigest: string;
};

export type AtomicJsonCodec<T> = {
  schemaVersion: number;
  parse(value: unknown): T;
  readHeader(record: T): LedgerHeader;
  withHeader(record: T, header: LedgerHeader): T;
  invariant?(record: T): string[];
};

export type AtomicJsonErrorCode =
  | "root-missing"
  | "root-relative"
  | "root-unreadable"
  | "path-escape"
  | "cas-mismatch"
  | "header-invalid"
  | "invalid-record"
  | "too-large"
  | "unreadable"
  | "write-failed"
  | "rename-failed"
  | "corrupt"
  | "unknown-version";

export class AtomicJsonError extends Error {
  readonly code: AtomicJsonErrorCode;
  readonly detail?: string;

  constructor(code: AtomicJsonErrorCode, detail?: string) {
    super(detail ? `atomic json ${code}: ${detail}` : `atomic json ${code}`);
    this.name = "AtomicJsonError";
    this.code = code;
    this.detail = detail;
  }
}

export type AtomicRead<T> =
  | {
      status: "ok";
      record: T;
      revision: number;
      digest: string;
      bytes: number;
      needsCompaction: boolean;
    }
  | { status: "missing" }
  | { status: "unknown-version"; schemaVersion: number; digest: string; bytes: number }
  | {
      status: "corrupt";
      reason: "json" | "schema" | "invariant" | "oversize";
      digest: string | null;
      issuePath: string | null;
      diagnostic: "disk" | "memory";
    };

export type AtomicCommitResult = {
  revision: number;
  digest: string;
  bytes: number;
  needsCompaction: boolean;
};

export type AtomicJsonFile<T> = {
  readonly file: string;
  read(): Promise<AtomicRead<T>>;
  commit(next: T, cas: { revision: number; digest: string }): Promise<AtomicCommitResult>;
  sweepTemporary(): Promise<number>;
};

type LedgerClock = { now(): string };
type LedgerIds = { next(): string };
type LedgerSleeper = { sleep(milliseconds: number): Promise<void> };

export function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function encodeRecord(value: unknown): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new AtomicJsonError("invalid-record", messageOf(error));
  }
  if (typeof encoded !== "string") throw new AtomicJsonError("invalid-record", "not encodable");
  return `${encoded}\n`;
}

function isContained(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return !relative.split(/[/\\]/u).includes("..");
}

/**
 * Containment for paths that do not exist yet: resolve the nearest existing ancestor, then check
 * its real path plus the missing suffix. This rejects junctions/symlinks that point outside home
 * before the first mkdir or write creates anything behind them.
 */
async function assertContained(
  files: LedgerFs,
  home: string,
  target: string,
  code: AtomicJsonErrorCode = "path-escape",
): Promise<void> {
  const resolved = path.resolve(target);
  if (!isContained(home, resolved)) throw new AtomicJsonError(code, target);
  const suffix: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      const real = await files.realpath(current);
      const reconstructed = path.resolve(real, ...suffix);
      if (!isContained(home, reconstructed)) throw new AtomicJsonError(code, target);
      return;
    } catch (error) {
      if (error instanceof AtomicJsonError) throw error;
      const errorWithCode = errorCode(error);
      if (errorWithCode === "ENOTDIR") throw new AtomicJsonError(code, target);
      if (errorWithCode !== "ENOENT") throw new AtomicJsonError("unreadable", target);
      const parent = path.dirname(current);
      if (parent === current) throw new AtomicJsonError(code, target);
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

export const nodeLedgerFs: LedgerFs = {
  async mkdir(target) {
    await mkdir(target, { recursive: true });
  },
  readFile(target) {
    return readFile(target);
  },
  hashFile(target) {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const hash = createHash("sha256");
    createReadStream(target)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(`sha256:${hash.digest("hex")}`));
    return promise;
  },
  async statSize(target) {
    try {
      return (await stat(target)).size;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  },
  async writeFileExclusive(target, content) {
    const handle = await open(target, "wx");
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
  realpath,
};

const defaultClock: LedgerClock = { now: () => new Date().toISOString() };
const defaultIds: LedgerIds = { next: randomUUID };
const defaultSleeper: LedgerSleeper = {
  sleep(milliseconds) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, milliseconds);
    return promise;
  },
};

export async function resolveLedgerRoots(
  home: string | undefined,
  files: LedgerFs = nodeLedgerFs,
): Promise<LedgerRoots> {
  if (home === undefined || home.trim() === "") {
    throw new AtomicJsonError("root-missing", "explicit PASEO_HOME is required");
  }
  if (!path.isAbsolute(home)) throw new AtomicJsonError("root-relative", home);
  let homeReal: string;
  try {
    homeReal = await files.realpath(home);
  } catch (error) {
    throw new AtomicJsonError("root-unreadable", messageOf(error));
  }
  const root = path.resolve(homeReal, "agent-team-runs", "v1");
  const records = path.resolve(root, "runs");
  const issues = path.resolve(root, "issues");
  if (!isContained(homeReal, root) || !isContained(root, records) || !isContained(root, issues)) {
    throw new AtomicJsonError("path-escape", root);
  }
  return { home: homeReal, root, records, issues };
}

export async function ensureLedgerDirs(
  roots: LedgerRoots,
  files: LedgerFs = nodeLedgerFs,
): Promise<void> {
  // Check before mkdir: a junction at agent-team-runs/v1 must be rejected before it creates
  // anything outside home.
  await assertContained(files, roots.home, roots.records);
  await files.mkdir(roots.root);
  await files.mkdir(roots.records);
  await assertContained(files, roots.home, roots.records);
}

type Parsed<T> =
  | { status: "ok"; record: T; header: LedgerHeader }
  | { status: "unknown-version"; schemaVersion: number }
  | { status: "corrupt"; reason: "json" | "schema" | "invariant"; detail: string };

function validateHeader(header: unknown, schemaVersion: number): string | null {
  if (typeof header !== "object" || header === null) return "header is not an object";
  if (!("schemaVersion" in header) || header.schemaVersion !== schemaVersion) {
    return "header schemaVersion mismatch";
  }
  const revision = "revision" in header ? header.revision : undefined;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    return "header revision must be a positive integer";
  }
  const previousDigest = "previousDigest" in header ? header.previousDigest : undefined;
  if (typeof previousDigest !== "string") return "header previousDigest is not a string";
  if (revision === 1) {
    if (previousDigest !== "") return "first revision must not have a previous digest";
  } else if (!DIGEST_PATTERN.test(previousDigest)) {
    return "header previousDigest is malformed";
  }
  return null;
}

function parseBytes<T>(bytes: Uint8Array, codec: AtomicJsonCodec<T>): Parsed<T> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    return { status: "corrupt", reason: "json", detail: messageOf(error) };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { status: "corrupt", reason: "schema", detail: "record is not an object" };
  }
  if (!("schemaVersion" in value)) {
    return { status: "corrupt", reason: "schema", detail: "schemaVersion missing" };
  }
  const version = value.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return { status: "corrupt", reason: "schema", detail: "schemaVersion is not an integer" };
  }
  if (version !== codec.schemaVersion) return { status: "unknown-version", schemaVersion: version };
  let record: T;
  try {
    record = codec.parse(value);
  } catch (error) {
    return { status: "corrupt", reason: "schema", detail: messageOf(error) };
  }
  let header: LedgerHeader;
  try {
    header = codec.readHeader(record);
  } catch (error) {
    return { status: "corrupt", reason: "schema", detail: messageOf(error) };
  }
  const headerProblem = validateHeader(header, codec.schemaVersion);
  if (headerProblem !== null) return { status: "corrupt", reason: "schema", detail: headerProblem };
  const violations = codec.invariant?.(record) ?? [];
  if (violations.length > 0) {
    return {
      status: "corrupt",
      reason: "invariant",
      detail: violations.slice(0, 20).join("; ").slice(0, ISSUE_DETAIL_MAX),
    };
  }
  return { status: "ok", record, header };
}

/**
 * A single atomic JSON record file. `commit` is read-check-write and is NOT mutually exclusive
 * across processes: callers MUST hold the root ProcessLock across read→commit and pass `guard`
 * (normally `lock.assertHeld`) so a lost lock aborts before rename. Stale revision/digest writers
 * are still rejected, but two writers holding the same CAS without the lock can lose an update.
 */
export function createAtomicJson<T>(options: {
  file: string;
  issuesDir: string;
  containmentRoot: string;
  codec: AtomicJsonCodec<T>;
  fs?: LedgerFs;
  clock?: LedgerClock;
  ids?: LedgerIds;
  sleep?: LedgerSleeper;
  limits?: { softBytes?: number; hardBytes?: number };
  /** Called immediately before the rename. Required whenever >1 process may commit. */
  guard?: () => void | Promise<void>;
  onIssueError?: (error: unknown) => void;
}): AtomicJsonFile<T> {
  const files = options.fs ?? nodeLedgerFs;
  const clock = options.clock ?? defaultClock;
  const ids = options.ids ?? defaultIds;
  const sleeper = options.sleep ?? defaultSleeper;
  const hardBytes = Math.max(1, options.limits?.hardBytes ?? LEDGER_RECORD_HARD_BYTES);
  const softBytes = Math.min(hardBytes, options.limits?.softBytes ?? LEDGER_RECORD_SOFT_BYTES);
  const file = path.resolve(options.file);
  const issuesDir = path.resolve(options.issuesDir);
  const root = path.resolve(options.containmentRoot);
  if (!isContained(root, file)) throw new AtomicJsonError("path-escape", file);
  if (!isContained(root, issuesDir)) throw new AtomicJsonError("path-escape", issuesDir);

  const temporaryName = (name: string): string => `.${path.basename(name)}.${ids.next()}.tmp`;

  async function renameWithRetry(from: string, to: string): Promise<void> {
    for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
      try {
        await files.rename(from, to);
        return;
      } catch (error) {
        const code = errorCode(error);
        // Windows can surface failures without a code; treat those as retryable like P1.
        const retryable = code === undefined || RETRYABLE_RENAME_CODES[code] === true;
        if (!retryable || attempt === RENAME_ATTEMPTS) {
          throw new AtomicJsonError("rename-failed", `${from} -> ${to}: ${messageOf(error)}`);
        }
        await sleeper.sleep(RENAME_RETRY_BASE_MS * attempt);
      }
    }
  }

  async function quarantine(
    reason: "json" | "schema" | "invariant" | "oversize",
    digest: string | null,
    detail: string,
  ): Promise<{ path: string | null; diagnostic: "disk" | "memory" }> {
    const key = (digest ?? "unknown").replace(/^sha256:/u, "");
    const issuePath = path.join(issuesDir, `${key}.${reason}.json`);
    try {
      await assertContained(files, root, issuesDir);
      if ((await files.statSize(issuePath)) !== null) {
        return { path: issuePath, diagnostic: "disk" };
      }
      await files.mkdir(issuesDir);
      const body = `${JSON.stringify({
        issueVersion: 1,
        fileDigest: digest,
        fileName: path.basename(file),
        reason,
        detail: detail.slice(0, ISSUE_DETAIL_MAX),
        detectedAt: clock.now(),
      })}\n`;
      const temporary = path.join(issuesDir, temporaryName(issuePath));
      await files.writeFileExclusive(temporary, body);
      try {
        await renameWithRetry(temporary, issuePath);
      } catch (error) {
        await files.rm(temporary).catch(() => undefined);
        throw error;
      }
      return { path: issuePath, diagnostic: "disk" };
    } catch (error) {
      options.onIssueError?.(error);
      return { path: null, diagnostic: "memory" };
    }
  }

  async function readRaw(): Promise<
    | { status: "missing" }
    | { status: "oversize"; size: number; digest: string | null }
    | { status: "bytes"; bytes: Uint8Array }
  > {
    await assertContained(files, root, file);
    let size: number | null;
    try {
      size = await files.statSize(file);
    } catch (error) {
      throw new AtomicJsonError("unreadable", messageOf(error));
    }
    if (size === null) return { status: "missing" };
    if (size > hardBytes) {
      let digest: string | null = null;
      try {
        digest = await files.hashFile(file);
      } catch {
        digest = null;
      }
      return { status: "oversize", size, digest };
    }
    let bytes: Uint8Array;
    try {
      bytes = await files.readFile(file);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { status: "missing" };
      throw new AtomicJsonError("unreadable", messageOf(error));
    }
    // The file can grow between stat and read; re-check the bytes we actually hold.
    if (bytes.byteLength > hardBytes) {
      let digest: string | null = null;
      try {
        digest = await files.hashFile(file);
      } catch {
        digest = null;
      }
      return { status: "oversize", size: bytes.byteLength, digest };
    }
    return { status: "bytes", bytes };
  }

  async function read(): Promise<AtomicRead<T>> {
    const raw = await readRaw();
    if (raw.status === "missing") return { status: "missing" };
    if (raw.status === "oversize") {
      const issue = await quarantine(
        "oversize",
        raw.digest,
        `record is ${raw.size} bytes; hard limit is ${hardBytes}`,
      );
      return {
        status: "corrupt",
        reason: "oversize",
        digest: raw.digest,
        issuePath: issue.path,
        diagnostic: issue.diagnostic,
      };
    }
    const digest = sha256(raw.bytes);
    const parsed = parseBytes(raw.bytes, options.codec);
    if (parsed.status === "unknown-version") {
      return {
        status: "unknown-version",
        schemaVersion: parsed.schemaVersion,
        digest,
        bytes: raw.bytes.byteLength,
      };
    }
    if (parsed.status === "corrupt") {
      const issue = await quarantine(parsed.reason, digest, parsed.detail);
      return {
        status: "corrupt",
        reason: parsed.reason,
        digest,
        issuePath: issue.path,
        diagnostic: issue.diagnostic,
      };
    }
    return {
      status: "ok",
      record: parsed.record,
      revision: parsed.header.revision,
      digest,
      bytes: raw.bytes.byteLength,
      needsCompaction: raw.bytes.byteLength >= softBytes,
    };
  }

  async function commit(
    next: T,
    cas: { revision: number; digest: string },
  ): Promise<AtomicCommitResult> {
    await assertContained(files, root, file);
    let currentDigest = "";
    const raw = await readRaw();
    if (raw.status === "missing") {
      if (cas.revision !== 0 || cas.digest !== "") {
        throw new AtomicJsonError("cas-mismatch", "record is missing");
      }
    } else if (raw.status === "oversize") {
      throw new AtomicJsonError("corrupt", "record exceeds the hard limit");
    } else {
      const parsed = parseBytes(raw.bytes, options.codec);
      if (parsed.status === "unknown-version") {
        throw new AtomicJsonError("unknown-version", String(parsed.schemaVersion));
      }
      if (parsed.status === "corrupt") {
        await quarantine(parsed.reason, sha256(raw.bytes), parsed.detail);
        throw new AtomicJsonError("corrupt", parsed.detail);
      }
      currentDigest = sha256(raw.bytes);
      if (currentDigest !== cas.digest) {
        throw new AtomicJsonError("cas-mismatch", "file digest changed");
      }
      if (parsed.header.revision !== cas.revision) {
        throw new AtomicJsonError("cas-mismatch", "revision changed");
      }
    }

    let header: LedgerHeader;
    try {
      header = options.codec.readHeader(next);
    } catch (error) {
      throw new AtomicJsonError("header-invalid", messageOf(error));
    }
    const headerProblem = validateHeader(header, options.codec.schemaVersion);
    if (headerProblem !== null) throw new AtomicJsonError("header-invalid", headerProblem);
    if (header.revision !== cas.revision + 1) {
      throw new AtomicJsonError("header-invalid", "next revision must be previous + 1");
    }
    if (header.previousDigest !== currentDigest) {
      throw new AtomicJsonError("header-invalid", "previousDigest does not match the current file");
    }
    const violations = options.codec.invariant?.(next) ?? [];
    if (violations.length > 0) {
      throw new AtomicJsonError("invalid-record", violations.slice(0, 20).join("; "));
    }
    const encoded = encodeRecord(next);
    const bytes = Buffer.byteLength(encoded, "utf8");
    if (bytes > hardBytes) {
      throw new AtomicJsonError("too-large", `${bytes} > ${hardBytes}`);
    }

    const temporary = path.join(path.dirname(file), temporaryName(file));
    await assertContained(files, root, temporary);
    try {
      await files.writeFileExclusive(temporary, encoded);
    } catch (error) {
      await files.rm(temporary).catch(() => undefined);
      throw new AtomicJsonError("write-failed", messageOf(error));
    }
    try {
      await options.guard?.();
      await renameWithRetry(temporary, file);
    } catch (error) {
      await files.rm(temporary).catch(() => undefined);
      throw error;
    }
    const digest = sha256(Buffer.from(encoded, "utf8"));
    return { revision: header.revision, digest, bytes, needsCompaction: bytes >= softBytes };
  }

  async function sweepTemporary(): Promise<number> {
    const directory = path.dirname(file);
    const prefix = `.${path.basename(file)}.`;
    let names: string[];
    try {
      names = await files.readdir(directory);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return 0;
      throw new AtomicJsonError("unreadable", messageOf(error));
    }
    let removed = 0;
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
      await files.rm(path.join(directory, name)).catch(() => undefined);
      removed += 1;
    }
    return removed;
  }

  return { file, read, commit, sweepTemporary };
}

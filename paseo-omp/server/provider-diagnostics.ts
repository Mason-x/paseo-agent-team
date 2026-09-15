import { spawn } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { access, type FileHandle, lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { type OmpConfig, OmpConfigSchema } from "../shared/omp-config";
import type {
  getOmpProviderHealth,
  OmpLspDiagnostics,
  OmpMcpDiagnostics,
  OmpProcessDiagnostics,
  OmpProviderHealth,
  OmpVersion,
  OmpVersionStatus,
  PathState,
} from "../shared/provider-diagnostics";
import { ompAgentDir } from "./paths";

const VERSION_TIMEOUT_MS = 3_000;
const HELP_TIMEOUT_MS = 3_000;
const KILL_GRACE_MS = 2_000;
const MAX_VERSION_BYTES = 2_048;
const MAX_HELP_BYTES = 65_536;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_MCP_MANIFEST_BYTES = 64 * 1024;
const HEALTH_CACHE_TTL_MS = 30_000;

const AGENT_DB_FILENAME = "agent.db";
const HISTORY_DB_FILENAME = "history.db";
// Matches the `--session-dir` default omp documents in its own `--help` output and the layout
// providers.md describes for terminal-started session import (`~/.omp/agent/sessions`).
const SESSION_DIR_NAME = "sessions";
const MCP_MANIFEST_FILENAME = "mcp.json";
const CONFIG_FILENAMES = ["config.yml", "config.yaml"] as const;
const WINDOWS_DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const WINDOWS_DEFAULT_SYSTEM_ROOT = "C:\\Windows";

// Only these variables ever reach a diagnostic probe's environment. Daemon credentials, API
// keys, and MCP headers — everything a real provider session legitimately inherits — are
// deliberately excluded; a `--version`/`--help` probe never needs them.
const PROBE_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "TEMP",
  "TMP",
  "PATHEXT",
  "LANG",
  "LC_ALL",
] as const;

export function buildProbeEnv(sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PROBE_ENV_ALLOWLIST) {
    const value = sourceEnv[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

const STATEFUL_CONFIG_ENV = [
  "OMP_PROFILE",
  "PI_PROFILE",
  "PI_CODING_AGENT_DIR",
  "PI_CONFIG_DIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
] as const;

export function buildStatefulCommandEnv(sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = buildProbeEnv(sourceEnv);
  for (const key of STATEFUL_CONFIG_ENV) {
    const value = sourceEnv[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** The minimal child-process shape a probe needs: readable stdio, exit reporting, and cleanup. */
export interface ProbeReadable {
  on(event: "data", listener: (chunk: Buffer) => void): void;
  removeAllListeners(): void;
  destroy(): void;
}

export interface ProbeChildProcess {
  readonly pid: number | undefined;
  readonly stdout: ProbeReadable;
  readonly stderr: ProbeReadable;
  onError(listener: (error: NodeJS.ErrnoException) => void): void;
  onClose(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  removeAllListeners(): void;
  /** Non-recursive kill for cleaning up helper processes such as taskkill itself. */
  terminateDirect(signal: NodeJS.Signals): boolean;
  /** Resolves true only after the complete provider process tree is confirmed terminated. */
  terminateTree(graceMs: number): Promise<boolean>;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
) => ProbeChildProcess;

export type SignalProcess = (pid: number, signal: NodeJS.Signals | 0) => void;

export type DeadlineScheduler = (callback: () => void, delayMs: number) => () => void;

function scheduleDeadline(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
}

function waitMs(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function processIsGone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ESRCH";
}

/**
 * TERM→KILL escalation targets the detached POSIX process group, not just the leader. Both
 * signals are attempted on schedule even if the leader closes after TERM, then signal 0 verifies
 * the group is gone within the final bound.
 */
export async function terminatePosixProcessTree(
  pid: number,
  graceMs: number,
  signalProcess: SignalProcess = process.kill,
  wait: (ms: number) => Promise<void> = waitMs,
): Promise<boolean> {
  try {
    signalProcess(-pid, "SIGTERM");
  } catch (error) {
    if (!processIsGone(error)) return false;
  }
  await wait(graceMs);
  try {
    signalProcess(-pid, "SIGKILL");
  } catch (error) {
    if (!processIsGone(error)) return false;
  }
  await wait(graceMs);
  try {
    signalProcess(-pid, 0);
    return false;
  } catch (error) {
    return processIsGone(error);
  }
}

/**
 * Terminates a Windows process tree via absolute System32/taskkill.exe. stdout/stderr are drained,
 * error/close handlers are installed synchronously, and a timed-out taskkill is itself killed
 * directly (never recursively) before a bounded final close wait. False propagates any failure.
 */
export async function killWindowsProcessTree(
  pid: number,
  spawnFn: SpawnFn,
  systemRoot: string,
  deadlineMs: number,
  schedule: DeadlineScheduler = scheduleDeadline,
): Promise<boolean> {
  const taskkillPath = join(systemRoot, "System32", "taskkill.exe");
  const { promise, resolve } = Promise.withResolvers<boolean>();
  let settled = false;
  let timedOut = false;
  let cancelDeadline = () => {};
  let cancelFinalDeadline = () => {};
  const finish = (success: boolean) => {
    if (settled) return;
    settled = true;
    cancelDeadline();
    cancelFinalDeadline();
    child.stdout.destroy();
    child.stderr.destroy();
    resolve(success);
  };

  let child: ProbeChildProcess;
  try {
    child = spawnFn(taskkillPath, ["/pid", String(pid), "/t", "/f"], buildProbeEnv(process.env));
  } catch {
    return false;
  }
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  child.onError(() => finish(false));
  child.onClose((code, signal) => finish(!timedOut && code === 0 && signal === null));
  cancelDeadline = schedule(() => {
    timedOut = true;
    try {
      child.terminateDirect("SIGKILL");
    } catch {
      finish(false);
      return;
    }
    cancelFinalDeadline = schedule(() => finish(false), deadlineMs);
  }, deadlineMs);
  return promise;
}

export function defaultSpawn(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): ProbeChildProcess {
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env,
    detached: process.platform !== "win32",
  });
  return {
    pid: child.pid,
    stdout: child.stdout,
    stderr: child.stderr,
    onError: (listener) => {
      child.on("error", listener);
    },
    onClose: (listener) => {
      child.on("close", listener);
    },
    removeAllListeners: () => {
      child.removeAllListeners();
    },
    terminateDirect: (signal) => child.kill(signal),
    terminateTree: async (graceMs) => {
      if (child.pid === undefined) return true;
      if (process.platform === "win32") {
        return killWindowsProcessTree(
          child.pid,
          defaultSpawn,
          process.env.SystemRoot ?? WINDOWS_DEFAULT_SYSTEM_ROOT,
          graceMs,
        );
      }
      return terminatePosixProcessTree(child.pid, graceMs);
    },
  };
}
async function isRegularExecutableFile(
  candidate: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  let stats: Stats;
  try {
    stats = await stat(candidate);
  } catch {
    return false;
  }
  if (!stats.isFile()) return false;
  if (platform === "win32") return true; // The X_OK bit is not meaningful on Windows.
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function windowsExecutableCandidates(base: string, pathExt: string): string[] {
  if (/\.[^./\\]+$/.test(base)) return [base];
  const extensions = pathExt
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  return extensions.length > 0 ? extensions.map((ext) => base + ext) : [base];
}

export interface ResolveExecutableOptions {
  cwd: string;
  platform: NodeJS.Platform;
  pathExt: string;
}

/**
 * Resolves the omp executable purely from the filesystem: a literal path (containing a
 * separator) is checked directly; otherwise every `pathDirs` entry is probed in the given order,
 * exactly mirroring how a real launch would find the same binary. No shell is ever invoked to do
 * this lookup. An empty PATH entry conventionally means "current directory" in POSIX shells; that
 * legacy behavior is deliberately not honored here so an attacker-writable daemon cwd can never
 * shadow the real binary. A relative PATH entry resolves against the explicit `cwd`, never a
 * process-global implicit cwd. The final match is realpath'd so a resolved symlink is reported
 * consistently as its canonical target rather than the link path.
 */
export async function resolveExecutablePath(
  command: string,
  pathDirs: readonly string[],
  options: ResolveExecutableOptions,
): Promise<string | null> {
  const isWindows = options.platform === "win32";
  const isLiteralPath = command.includes("/") || (isWindows && command.includes(sep));
  const bases: string[] = [];
  if (isLiteralPath) {
    bases.push(isAbsolute(command) ? command : join(options.cwd, command));
  } else {
    for (const dir of pathDirs) {
      if (dir.length === 0) continue;
      bases.push(isAbsolute(dir) ? join(dir, command) : join(options.cwd, dir, command));
    }
  }
  for (const base of bases) {
    const candidates = isWindows ? windowsExecutableCandidates(base, options.pathExt) : [base];
    for (const candidate of candidates) {
      if (!(await isRegularExecutableFile(candidate, options.platform))) continue;
      try {
        return await realpath(candidate);
      } catch {
        // Candidate disappeared or its link chain changed between stat and canonicalization.
      }
    }
  }
  return null;
}

export type BoundedRunOutcome = "exited" | "spawn-error" | "timeout";

export interface BoundedRun {
  outcome: BoundedRunOutcome;
  stdout: string;
  truncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** ENOENT vs everything else, so "not found" and "found but unrunnable" stay distinct. */
  spawnErrorCode: string | null;
  /** True when tree termination/verification failed or the leader missed its final close bound. */
  cleanupFailed: boolean;
}

/**
 * Runs one bounded, argv-only subprocess with a minimal allowlisted environment. stderr is
 * drained and discarded, never inspected or forwarded. On timeout the full process tree is
 * signaled (TERM, then KILL after `killGraceMs`, independent of whether the immediate leader has
 * already closed) and the promise still waits, bounded by one more `killGraceMs`, for the close
 * event so exit status is real whenever the process cooperates, and cleanup failure is reported
 * when it does not.
 */
export function runBounded(
  spawnFn: SpawnFn,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  killGraceMs: number,
  maxBytes: number,
  cwd?: string,
): Promise<BoundedRun> {
  const { promise, resolve } = Promise.withResolvers<BoundedRun>();
  let child: ProbeChildProcess;
  try {
    child = spawnFn(command, args, env, cwd);
  } catch (error) {
    resolve({
      outcome: "spawn-error",
      stdout: "",
      truncated: false,
      exitCode: null,
      signal: null,
      spawnErrorCode: (error as NodeJS.ErrnoException)?.code ?? null,
      cleanupFailed: false,
    });
    return promise;
  }

  let settled = false;
  const stdoutChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let truncated = false;
  let timedOut = false;
  let leaderClosed = false;
  let leaderExitCode: number | null = null;
  let leaderSignal: NodeJS.Signals | null = null;
  let treeCleanupDone = false;
  let treeCleanupSucceeded = false;
  let finalLeaderTimer: ReturnType<typeof setTimeout> | undefined;
  const getStdout = () => Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8");

  const cleanupListeners = () => {
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    child.removeAllListeners();
    clearTimeout(deadlineTimer);
    clearTimeout(finalLeaderTimer);
  };
  const finish = (result: BoundedRun) => {
    if (settled) return;
    settled = true;
    cleanupListeners();
    resolve(result);
  };
  const finishTimedOut = (cleanupFailed: boolean) => {
    finish({
      outcome: "timeout",
      stdout: getStdout(),
      truncated,
      exitCode: leaderExitCode,
      signal: leaderSignal,
      spawnErrorCode: null,
      cleanupFailed,
    });
  };
  const settleAfterCleanup = () => {
    if (!treeCleanupDone) return;
    if (leaderClosed) {
      finishTimedOut(!treeCleanupSucceeded);
      return;
    }
    finalLeaderTimer = setTimeout(() => finishTimedOut(true), killGraceMs);
  };

  const deadlineTimer = setTimeout(() => {
    timedOut = true;
    void child
      .terminateTree(killGraceMs)
      .then((success) => {
        treeCleanupSucceeded = success;
      })
      .catch(() => {
        treeCleanupSucceeded = false;
      })
      .finally(() => {
        treeCleanupDone = true;
        settleAfterCleanup();
      });
  }, timeoutMs);

  child.onError((error) => {
    if (timedOut) {
      leaderClosed = true;
      settleAfterCleanup();
      return;
    }
    finish({
      outcome: "spawn-error",
      stdout: getStdout(),
      truncated,
      exitCode: null,
      signal: null,
      spawnErrorCode: error.code ?? null,
      cleanupFailed: false,
    });
  });
  child.stdout.on("data", (chunk: Buffer) => {
    const remaining = maxBytes - stdoutBytes;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    if (chunk.length > remaining) truncated = true;
    const accepted = chunk.subarray(0, remaining);
    stdoutChunks.push(accepted);
    stdoutBytes += accepted.length;
  });
  child.stderr.on("data", () => {
    // Intentionally discarded: never stored, parsed, or forwarded across the RPC boundary.
  });
  child.onClose((code, signal) => {
    leaderClosed = true;
    leaderExitCode = code;
    leaderSignal = signal;
    if (timedOut) {
      settleAfterCleanup();
      return;
    }
    finish({
      outcome: "exited",
      stdout: getStdout(),
      truncated,
      exitCode: code,
      signal,
      spawnErrorCode: null,
      cleanupFailed: false,
    });
  });

  return promise;
}

// Anchored against the entire trimmed stdout (not merely one of several lines) so extra output,
// build metadata after a `+`, or a prefix/suffix can never be mistaken for the version. Digit
// groups are bounded to 4 characters and prerelease text to 32, so nothing unbounded parses out.
const VERSION_LINE_PATTERN =
  /^omp\/(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:-([0-9A-Za-z][0-9A-Za-z.]{0,31}))?$/;

/** Requires the whole trimmed probe output to be exactly one canonical version line. */
function parseCanonicalVersionLine(stdout: string): OmpVersion | null {
  const line = stdout.trim();
  if (line.includes("\n") || line.includes("\r")) return null;
  const match = VERSION_LINE_PATTERN.exec(line);
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ?? null,
  };
}

function toVersionOutcome(result: BoundedRun): {
  status: OmpVersionStatus;
  version: OmpVersion | null;
} {
  if (result.outcome === "timeout") return { status: "timeout", version: null };
  if (result.outcome === "spawn-error") {
    return {
      status: result.spawnErrorCode === "ENOENT" ? "not-found" : "unrunnable",
      version: null,
    };
  }
  // Only a clean, unsignaled, non-truncated exit can ever license "ok"; a nonzero exit or a
  // delivered signal is a probe failure regardless of how plausible the stdout looks.
  const exitedCleanly = result.exitCode === 0 && result.signal === null;
  if (!exitedCleanly) return { status: "probe-failed", version: null };
  if (result.truncated) return { status: "malformed", version: null };
  const version = parseCanonicalVersionLine(result.stdout);
  return version ? { status: "ok", version } : { status: "malformed", version: null };
}

// Matches the exact flag line omp documents for `--mode`, not a bare "rpc-ui" substring that
// could appear anywhere in unrelated text.
const RPC_UI_HELP_PATTERN = /--mode=<value>\s+Output mode:.*\brpc-ui\b/i;
// Matches the exact "Available Tools" listing line for the built-in lsp tool.
const LSP_TOOL_PATTERN = /^\s*lsp\s+-\s+Language server protocol/im;

/** A clean, non-empty, non-truncated, zero-exit help dump is required before trusting either a
 * positive or a negative match. */
function helpResultUsable(result: BoundedRun): boolean {
  return (
    result.outcome === "exited" &&
    result.exitCode === 0 &&
    result.signal === null &&
    !result.truncated &&
    result.stdout.trim().length > 0
  );
}

function detectRpcUiSupport(result: BoundedRun): boolean | null {
  return helpResultUsable(result) ? RPC_UI_HELP_PATTERN.test(result.stdout) : null;
}

function computeLspDiagnostics(result: BoundedRun): OmpLspDiagnostics {
  if (!helpResultUsable(result)) return { status: "unknown" };
  return { status: LSP_TOOL_PATTERN.test(result.stdout) ? "supported" : "not-advertised" };
}
export interface OmpAvailabilityProbeOptions {
  command: readonly [string, ...string[]];
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  spawnFn?: SpawnFn;
}

export async function probeOmpAvailability(options: OmpAvailabilityProbeOptions): Promise<{
  status: "missing" | "unrunnable" | "incompatible" | "available";
  diagnostic?: string;
}> {
  const environment = options.environment ?? process.env;
  const [command, ...prefixArgs] = options.command;
  const resolvedPath = await resolveExecutablePath(
    command,
    (environment.PATH ?? "").split(delimiter),
    {
      cwd: options.cwd,
      platform: options.platform ?? process.platform,
      pathExt: environment.PATHEXT ?? WINDOWS_DEFAULT_PATHEXT,
    },
  );
  if (!resolvedPath) return { status: "missing", diagnostic: "OMP executable was not found" };

  const operationTimeout = Math.max(1, Math.min(options.timeoutMs ?? VERSION_TIMEOUT_MS, 60_000));
  const killGraceMs = Math.min(KILL_GRACE_MS, Math.max(1, Math.floor(operationTimeout / 4)));
  const probeTimeoutMs = Math.max(1, operationTimeout - killGraceMs * 2);
  const probeEnv = buildProbeEnv(environment);
  const [versionRun, helpRun] = await Promise.all([
    runBounded(
      options.spawnFn ?? defaultSpawn,
      resolvedPath,
      [...prefixArgs, "--version"],
      probeEnv,
      probeTimeoutMs,
      killGraceMs,
      MAX_VERSION_BYTES,
      options.cwd,
    ),
    runBounded(
      options.spawnFn ?? defaultSpawn,
      resolvedPath,
      [...prefixArgs, "--help"],
      probeEnv,
      probeTimeoutMs,
      killGraceMs,
      MAX_HELP_BYTES,
      options.cwd,
    ),
  ]);
  const version = toVersionOutcome(versionRun);
  if (versionRun.cleanupFailed || helpRun.cleanupFailed) {
    return { status: "unrunnable", diagnostic: "OMP availability probe cleanup failed" };
  }
  if (version.status === "not-found") {
    return { status: "missing", diagnostic: "OMP executable was not found" };
  }
  if (version.status === "malformed") {
    return { status: "incompatible", diagnostic: "OMP returned an unrecognized version" };
  }
  if (version.status !== "ok") {
    return { status: "unrunnable", diagnostic: `OMP version probe ${version.status}` };
  }
  const rpcUiSupported = detectRpcUiSupport(helpRun);
  if (rpcUiSupported === false) {
    return { status: "incompatible", diagnostic: "OMP does not advertise rpc-ui support" };
  }
  if (rpcUiSupported === null) {
    return { status: "unrunnable", diagnostic: "OMP rpc-ui compatibility probe failed" };
  }
  return { status: "available" };
}

function isEnoent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "EACCES" || code === "EPERM";
}

/**
 * Classifies a known diagnostic path without following symlinks. A symlink is "wrong-type"
 * rather than an invitation to read an arbitrary target outside omp's expected state tree.
 * Directories additionally require both read and traverse (X_OK) access before "available";
 * a directory that exists but cannot be listed is not usable state, so it is "invalid".
 */
async function classifyPath(path: string, kind: "file" | "directory"): Promise<PathState> {
  let pathStats: Stats;
  try {
    pathStats = await lstat(path);
  } catch (error) {
    return isEnoent(error) ? "missing" : "unreadable";
  }
  if (pathStats.isSymbolicLink()) return "wrong-type";
  const matchesKind = kind === "file" ? pathStats.isFile() : pathStats.isDirectory();
  if (!matchesKind) return "wrong-type";
  const mode = kind === "file" ? constants.R_OK : constants.R_OK | constants.X_OK;
  try {
    await access(path, mode);
  } catch {
    return "unreadable";
  }
  return "available";
}

type BoundedFileRead =
  | { state: "available"; text: string }
  | { state: "missing" | "unreadable" | "wrong-type" | "invalid" };
/** Bounded, no-symlink file read shared by the config and MCP-manifest readers. */
async function readBoundedNoSymlinkFile(path: string, maxBytes: number): Promise<BoundedFileRead> {
  let pathStats: Stats;
  try {
    pathStats = await lstat(path);
  } catch (error) {
    return { state: isEnoent(error) ? "missing" : "unreadable" };
  }
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) return { state: "wrong-type" };

  let handle: FileHandle | undefined;
  try {
    const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollowFlag);
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) return { state: "wrong-type" };
    if (openedStats.size > maxBytes) return { state: "invalid" };
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) return { state: "invalid" };
    return { state: "available", text: buffer.subarray(0, bytesRead).toString("utf8") };
  } catch (error) {
    return { state: isPermissionError(error) ? "unreadable" : "invalid" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

interface SafeConfigResult {
  path: string;
  state: PathState;
  config: OmpConfig | null;
}

/**
 * Reads omp's config.yml/.yaml with the same safe-allowlist schema the config surface uses, but
 * classifies anything that parses to a non-mapping root or fails the allowed-section schema
 * (including an invalid `memory.backend`) as "invalid" rather than silently degrading to an
 * empty-but-"available" config — a health check must not call a broken config healthy.
 */
async function readSafeConfig(agentDir: string): Promise<SafeConfigResult> {
  const canonicalPath = join(agentDir, CONFIG_FILENAMES[0]);
  for (const filename of CONFIG_FILENAMES) {
    const path = join(agentDir, filename);
    const fileRead = await readBoundedNoSymlinkFile(path, MAX_CONFIG_BYTES);
    if (fileRead.state === "missing") continue;
    if (fileRead.state !== "available" || !("text" in fileRead)) {
      return { path, state: fileRead.state, config: null };
    }
    try {
      const raw: unknown = parseYaml(fileRead.text);
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return { path, state: "invalid", config: null };
      }
      const parsed = OmpConfigSchema.safeParse(raw);
      if (!parsed.success) return { path, state: "invalid", config: null };
      return { path, state: "available", config: parsed.data };
    } catch {
      return { path, state: "invalid", config: null };
    }
  }
  return { path: canonicalPath, state: "missing", config: null };
}

const McpManifestSchema = z
  .object({ mcpServers: z.record(z.string(), z.unknown()).optional() })
  .passthrough();

/**
 * Reports only a bounded count from omp's mcp.json manifest. Server identifiers and every nested
 * command/env/header/URL remain server-side and never cross the RPC boundary.
 */
async function computeMcpDiagnostics(agentDir: string): Promise<OmpMcpDiagnostics> {
  const fileRead = await readBoundedNoSymlinkFile(
    join(agentDir, MCP_MANIFEST_FILENAME),
    MAX_MCP_MANIFEST_BYTES,
  );
  if (fileRead.state === "missing") {
    return {
      status: "unavailable",
      serverCount: null,
      reason: `No ${MCP_MANIFEST_FILENAME} manifest found under the agent root`,
    };
  }
  if (fileRead.state === "wrong-type") {
    return {
      status: "wrong-type",
      serverCount: null,
      reason: `${MCP_MANIFEST_FILENAME} under the agent root is not a regular file`,
    };
  }
  if (fileRead.state === "unreadable") {
    return {
      status: "unreadable",
      serverCount: null,
      reason: `${MCP_MANIFEST_FILENAME} under the agent root could not be read`,
    };
  }
  if (fileRead.state === "invalid") {
    return {
      status: "invalid",
      serverCount: null,
      reason: `${MCP_MANIFEST_FILENAME} under the agent root is too large or unstable`,
    };
  }
  if (!("text" in fileRead)) {
    return {
      status: "invalid",
      serverCount: null,
      reason: `${MCP_MANIFEST_FILENAME} under the agent root could not be read`,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fileRead.text);
  } catch {
    return {
      status: "invalid",
      serverCount: null,
      reason: `${MCP_MANIFEST_FILENAME} under the agent root is not valid JSON`,
    };
  }
  const parsed = McpManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: "invalid",
      serverCount: null,
      reason: `${MCP_MANIFEST_FILENAME} under the agent root does not match the expected shape`,
    };
  }
  return {
    status: "configured",
    serverCount: Object.keys(parsed.data.mcpServers ?? {}).length,
    reason: null,
  };
}

export interface ProcessDiagnosticsFs {
  readdir(path: string): Promise<string[]>;
  lstat(path: string): Promise<Stats>;
}

const processDiagnosticsFs: ProcessDiagnosticsFs = { readdir, lstat };

/**
 * Counts only regular, non-symlink meta.json entries. Missing/wrong entries are expected and
 * ignored; any other read/stat failure makes the result partial rather than silently hiding it.
 */
export async function computeProcessDiagnostics(
  hubRunRoot: string,
  fs: ProcessDiagnosticsFs = processDiagnosticsFs,
): Promise<OmpProcessDiagnostics> {
  let projectHashes: string[];
  try {
    const rootStats = await fs.lstat(hubRunRoot);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      return { status: "unavailable", trackedCount: null };
    }
    projectHashes = await fs.readdir(hubRunRoot);
  } catch (error) {
    return { status: isEnoent(error) ? "unavailable" : "unknown", trackedCount: null };
  }
  let trackedCount = 0;
  let partial = false;
  for (const hash of projectHashes) {
    const projectDir = join(hubRunRoot, hash);
    const daemonsDir = join(projectDir, "daemons");
    try {
      const projectStats = await fs.lstat(projectDir);
      if (projectStats.isSymbolicLink() || !projectStats.isDirectory()) continue;
      const daemonStats = await fs.lstat(daemonsDir);
      if (daemonStats.isSymbolicLink() || !daemonStats.isDirectory()) continue;
    } catch (error) {
      if (!isEnoent(error)) partial = true;
      continue;
    }

    let daemonNames: string[];
    try {
      daemonNames = await fs.readdir(daemonsDir);
    } catch (error) {
      if (!isEnoent(error)) partial = true;
      continue;
    }
    for (const name of daemonNames) {
      try {
        const metaStats = await fs.lstat(join(daemonsDir, name, "meta.json"));
        if (!metaStats.isSymbolicLink() && metaStats.isFile()) trackedCount += 1;
      } catch (error) {
        if (!isEnoent(error)) partial = true;
      }
    }
  }
  return { status: partial ? "partial" : "ok", trackedCount };
}

function homeRelative(path: string, homeDir: string): string | null {
  if (path === homeDir) return "~";
  const suffix = relative(homeDir, path);
  if (suffix === "" || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    return null;
  }
  return `~/${suffix.split(sep).join("/")}`;
}

/** External locations always collapse to the same constant; no basename or raw env value leaks. */
function sanitizeRootPath(path: string, homeDir: string): string {
  return homeRelative(path, homeDir) ?? "<custom path>";
}

function sanitizeDerivedPath(rawRoot: string, sanitizedRoot: string, fullPath: string): string {
  const suffix = relative(rawRoot, fullPath);
  if (suffix === "" || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    return sanitizedRoot;
  }
  return `${sanitizedRoot}/${suffix.split(sep).join("/")}`;
}

export interface ProviderDiagnosticsDeps {
  agentDir: string;
  command: string;
  pathDirs: readonly string[];
  cwd: string;
  platform: NodeJS.Platform;
  pathExt: string;
  env: NodeJS.ProcessEnv;
  spawnFn: SpawnFn;
  hubRunRoot: string;
  homeDir: string;
  versionTimeoutMs?: number;
  helpTimeoutMs?: number;
  killGraceMs?: number;
  maxVersionBytes?: number;
  maxHelpBytes?: number;
}

export async function computeOmpProviderHealth(
  deps: ProviderDiagnosticsDeps,
): Promise<OmpProviderHealth> {
  const agentDir = resolve(deps.agentDir);
  const homeDir = resolve(deps.homeDir);
  const versionTimeoutMs = deps.versionTimeoutMs ?? VERSION_TIMEOUT_MS;
  const helpTimeoutMs = deps.helpTimeoutMs ?? HELP_TIMEOUT_MS;
  const killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS;
  const maxVersionBytes = deps.maxVersionBytes ?? MAX_VERSION_BYTES;
  const maxHelpBytes = deps.maxHelpBytes ?? MAX_HELP_BYTES;
  const probeEnv = buildProbeEnv(deps.env);

  const resolvedPath = await resolveExecutablePath(deps.command, deps.pathDirs, {
    cwd: deps.cwd,
    platform: deps.platform,
    pathExt: deps.pathExt,
  });
  const installed = resolvedPath !== null;

  const [versionRun, helpRun] = await Promise.all([
    installed
      ? runBounded(
          deps.spawnFn,
          resolvedPath,
          ["--version"],
          probeEnv,
          versionTimeoutMs,
          killGraceMs,
          maxVersionBytes,
          deps.cwd,
        )
      : null,
    installed
      ? runBounded(
          deps.spawnFn,
          resolvedPath,
          ["--help"],
          probeEnv,
          helpTimeoutMs,
          killGraceMs,
          maxHelpBytes,
          deps.cwd,
        )
      : null,
  ]);

  const versionOutcome = versionRun
    ? toVersionOutcome(versionRun)
    : { status: "not-found" as const, version: null };
  const rpcUiSupported = helpRun ? detectRpcUiSupport(helpRun) : null;
  const lsp = helpRun ? computeLspDiagnostics(helpRun) : { status: "unknown" as const };
  const processCleanupFailed = Boolean(versionRun?.cleanupFailed || helpRun?.cleanupFailed);

  const agentDbPath = join(agentDir, AGENT_DB_FILENAME);
  const historyDbPath = join(agentDir, HISTORY_DB_FILENAME);
  const sessionRoot = join(agentDir, SESSION_DIR_NAME);
  const [
    configResult,
    agentRootState,
    sessionRootState,
    agentDbState,
    historyDbState,
    mcp,
    processDiagnostics,
  ] = await Promise.all([
    readSafeConfig(agentDir),
    classifyPath(agentDir, "directory"),
    classifyPath(sessionRoot, "directory"),
    classifyPath(agentDbPath, "file"),
    classifyPath(historyDbPath, "file"),
    computeMcpDiagnostics(agentDir),
    computeProcessDiagnostics(resolve(deps.hubRunRoot)),
  ]);
  const configState = configResult.state;
  const sanitizedAgentRoot = sanitizeRootPath(agentDir, homeDir);

  return {
    binary: {
      installed,
      resolvedPath: resolvedPath ? sanitizeRootPath(resolve(resolvedPath), homeDir) : null,
      version: versionOutcome.version,
      versionStatus: versionOutcome.status,
      processCleanupFailed,
    },
    rpcUi: {
      checked: installed,
      supported: rpcUiSupported,
    },
    lsp,
    mcp,
    process: processDiagnostics,
    roots: {
      agentRoot: sanitizedAgentRoot,
      agentRootState,
      configPath: sanitizeDerivedPath(agentDir, sanitizedAgentRoot, configResult.path),
      configState,
      sessionRoot: sanitizeDerivedPath(agentDir, sanitizedAgentRoot, sessionRoot),
      sessionRootState,
    },
    databases: {
      agentDbState,
      historyDbState,
    },
    memoryBackend:
      configState === "available" ? (configResult.config?.memory?.backend ?? null) : null,
    checkedAt: new Date().toISOString(),
  };
}

const cachedHealth = new Map<string, { value: OmpProviderHealth; expiresAt: number }>();
const inFlightHealth = new Map<string, Promise<OmpProviderHealth>>();

function defaultHubRunRoot(): string {
  return process.env.PASEO_OMP_RUN_DIR ?? join(homedir(), ".omp", "run", "daemons");
}

/**
 * Single-flights and short-TTL-caches the health computation so several connected clients
 * polling or refreshing around the same time never each launch their own `--version`/`--help`
 * subprocess pair; they share one in-flight probe or its just-completed result. `force` skips a
 * still-fresh cached value but still joins an in-flight probe rather than starting a duplicate.
 */
export async function resolveGetOmpProviderHealth(
  input: RpcInput<typeof getOmpProviderHealth>,
): Promise<OmpProviderHealth> {
  const cwd = input.cwd ?? process.cwd();
  const now = Date.now();
  const cached = cachedHealth.get(cwd);
  if (!input.force && cached && cached.expiresAt > now) return cached.value;
  const inFlight = inFlightHealth.get(cwd);
  if (inFlight) return inFlight;

  const computation = computeOmpProviderHealth({
    agentDir: ompAgentDir(),
    command: process.env.OMP_COMMAND ?? "omp",
    pathDirs: (process.env.PATH ?? "").split(delimiter),
    cwd,
    platform: process.platform,
    pathExt: process.env.PATHEXT ?? WINDOWS_DEFAULT_PATHEXT,
    env: process.env,
    spawnFn: defaultSpawn,
    hubRunRoot: defaultHubRunRoot(),
    homeDir: homedir(),
  })
    .then((value) => {
      cachedHealth.set(cwd, { value, expiresAt: Date.now() + HEALTH_CACHE_TTL_MS });
      return value;
    })
    .finally(() => {
      inFlightHealth.delete(cwd);
    });
  inFlightHealth.set(cwd, computation);
  return computation;
}

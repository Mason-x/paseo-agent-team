import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { type GateAttempt, type Run, TEAM_DIR } from "../shared/run";
import { changedFiles, dirtyFiles, head } from "./git";

export const TAIL_LINES = 80;
const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;

/** `**` crosses directories, `*` and `?` do not. A trailing `/` means the whole directory. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.endsWith("/") ? `${glob}**` : glob;
  let out = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === "*" && g[i + 1] === "*") {
      out += g[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += g[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export const matchesAny = (file: string, globs: string[]) =>
  globs.some((g) => globToRegExp(g).test(file));

export function policyViolations(files: string[], protectedPaths: string[], allowed?: string[]) {
  const out: string[] = [];
  for (const f of files) {
    if (matchesAny(f, protectedPaths)) out.push(`protected path changed: ${f}`);
    else if (allowed?.length && !matchesAny(f, allowed)) out.push(`outside allowed paths: ${f}`);
  }
  return out;
}

/** The last `n` lines of a file, reading at most the final 64 KiB. */
export async function tailLines(file: string, n = TAIL_LINES): Promise<string> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, size - length);
    const lines = buf.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines.slice(-n).join("\n");
  } finally {
    await handle.close();
  }
}

type CheckResult = GateAttempt["checks"][number];

function runCommand(opts: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutSec: number;
  logPath: string;
  maxBytes: number;
  signal?: AbortSignal;
}): Promise<{ exitCode: number | null; durationMs: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const log = createWriteStream(opts.logPath);
    const posix = process.platform !== "win32";
    const child = spawn(opts.command, {
      cwd: opts.cwd,
      env: opts.env,
      shell: true,
      detached: posix,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let written = 0;
    let truncated = false;
    const sink = (chunk: Buffer) => {
      if (written >= opts.maxBytes) {
        truncated = true;
        return;
      }
      const piece = chunk.subarray(0, opts.maxBytes - written);
      written += piece.length;
      log.write(piece);
    };
    child.stdout.on("data", sink);
    child.stderr.on("data", sink);
    const kill = () => {
      try {
        if (posix && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutSec * 1000);
    opts.signal?.addEventListener("abort", kill, { once: true });
    const finish = (exitCode: number | null, note?: string) => {
      clearTimeout(timer);
      if (truncated) log.write(`\n[output truncated at ${opts.maxBytes} bytes]\n`);
      if (timedOut) log.write(`\n[timed out after ${opts.timeoutSec}s]\n`);
      if (note) log.write(`\n[${note}]\n`);
      log.end(() =>
        resolve({ exitCode: timedOut ? null : exitCode, durationMs: Date.now() - started }),
      );
    };
    child.on("error", (e) => finish(null, `spawn failed: ${e.message}`));
    child.on("close", (code) => finish(code));
  });
}

export type GateOptions = { now?: () => string; maxLogBytes?: number; signal?: AbortSignal };

/** Runs the frozen gate commands for one candidate commit in the writer's worktree (Spec 9). */
export async function runGate(
  run: Run,
  n: number,
  sha: string,
  opts: GateOptions = {},
): Promise<GateAttempt> {
  const now = opts.now ?? (() => new Date().toISOString());
  const cwd = run.workspace.path;
  const attempt: GateAttempt = {
    n,
    sha,
    startedAt: now(),
    checks: [],
    policyViolations: [],
    summary: run.attempts.find((a) => a.n === n)?.summary,
  };
  const done = (result: NonNullable<GateAttempt["result"]>, error?: string): GateAttempt => ({
    ...attempt,
    result,
    finishedAt: now(),
    ...(error ? { error } : {}),
  });
  try {
    const current = await head(cwd);
    if (current !== sha)
      return done("error", `HEAD is ${current.slice(0, 8)}, not the submitted ${sha.slice(0, 8)}`);
    const dirty = await dirtyFiles(cwd);
    if (dirty.length) return done("error", `uncommitted files: ${dirty.slice(0, 10).join(", ")}`);

    const { protectedPaths, allowedPaths } = run.task;
    attempt.policyViolations = policyViolations(
      await changedFiles(cwd, run.repo.baseSha, sha),
      protectedPaths,
      allowedPaths,
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PASEO_TEAM_RUN: run.id,
      PASEO_TEAM_SEAT: "writer",
    };
    for (const [k, v] of Object.entries(run.task.env)) {
      env[k] = v.replaceAll("{runId}", run.id).replaceAll("{seat}", "writer");
    }
    const dir = path.join(cwd, TEAM_DIR, "gate", String(n));
    await mkdir(dir, { recursive: true });
    const used = new Set<string>();
    for (const cmd of run.task.gateCommands) {
      let base = cmd.name.replace(/[^\w.-]/g, "_");
      while (used.has(base)) base += "_";
      used.add(base);
      const logFile = `${TEAM_DIR}/gate/${n}/${base}.log`;
      const r = await runCommand({
        command: cmd.command,
        cwd,
        env,
        timeoutSec: cmd.timeoutSec,
        logPath: path.join(cwd, logFile),
        maxBytes: opts.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES,
        signal: opts.signal,
      });
      attempt.checks.push({
        name: cmd.name,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        logFile,
      } satisfies CheckResult);
    }
    const ok =
      attempt.checks.every((c) => c.exitCode === 0) && attempt.policyViolations.length === 0;
    return done(ok ? "pass" : "fail");
  } catch (error) {
    return done("error", error instanceof Error ? error.message : String(error));
  }
}

/** One gate at a time across the whole host, so test suites do not starve each other (Spec 9). */
export function createGateRunner() {
  const active = new Set<string>();
  const stop = new AbortController();
  let tail: Promise<unknown> = Promise.resolve();
  return {
    isRunning: (runId: string) => active.has(runId),
    stopAll: () => stop.abort(),
    run(run: Run, n: number, sha: string, opts: GateOptions = {}): Promise<GateAttempt> {
      active.add(run.id);
      // A stopped gate must not report: after a restart reconcile runs it again (AC8).
      const job = tail.then(async () => {
        if (stop.signal.aborted) throw new Error("gate stopped");
        const attempt = await runGate(run, n, sha, { ...opts, signal: stop.signal });
        if (stop.signal.aborted) throw new Error("gate stopped");
        return attempt;
      });
      tail = job.catch(() => undefined);
      return job.finally(() => active.delete(run.id));
    },
  };
}

/** What the writer is told after a failed gate: failing checks, log paths and the last lines of each. */
export async function failureReport(run: Run, a: GateAttempt): Promise<string> {
  const parts: string[] = [];
  if (a.error) parts.push(`门禁没能运行：${a.error}`);
  for (const v of a.policyViolations) parts.push(`策略违规：${v}`);
  for (const c of a.checks.filter((x) => x.exitCode !== 0)) {
    const tail = await tailLines(path.join(run.workspace.path, c.logFile)).catch(
      () => "(日志读取失败)",
    );
    const code = c.exitCode === null ? "超时或被终止" : `退出码 ${c.exitCode}`;
    parts.push(
      `检查 ${c.name} 失败（${code}），完整日志 ${c.logFile}，末尾 ${TAIL_LINES} 行：\n${tail}`,
    );
  }
  return parts.join("\n\n");
}

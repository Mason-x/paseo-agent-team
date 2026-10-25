import type { Relation, Sha } from "../../shared/version";
import type { ExecPort, ExecResult } from "./process";

/** Variables that can retarget git away from the checkout we intend to touch. */
const STRIPPED_GIT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
];

export type GitRun = {
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export type GitPort = {
  run(request: GitRun): Promise<ExecResult>;
};

export function createGit(exec: ExecPort, baseEnv: NodeJS.ProcessEnv = process.env): GitPort {
  return {
    run(request) {
      const env: NodeJS.ProcessEnv = {
        ...baseEnv,
        ...request.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
      };
      for (const key of STRIPPED_GIT_ENV) delete env[key];
      for (const key of Object.keys(env)) {
        if (key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_"))
          delete env[key];
      }
      return exec.run({
        file: "git",
        args: request.args,
        cwd: request.cwd,
        env,
        timeoutMs: request.timeoutMs,
      });
    },
  };
}

export function gitOk(result: ExecResult): boolean {
  return result.exitCode === 0 && !result.timedOut;
}

export function gitText(result: ExecResult): string {
  return result.stdout.replace(/\0/g, "").trim();
}

/** Porcelain v1 with NUL records, including ignored-excluded untracked files. */
export function parseDirty(stdout: string): boolean {
  return stdout.split("\0").some((record) => record.length > 0);
}

export type AheadBehind = { ahead: number; behind: number };

export function parseAheadBehind(stdout: string): AheadBehind | null {
  const match = stdout.trim().match(/^(\d+)\s+(\d+)$/);
  if (!match) return null;
  return { ahead: Number(match[1]), behind: Number(match[2]) };
}

export function relationFromCounts(counts: AheadBehind | null, same: boolean): Relation {
  if (same) return "equal";
  if (!counts) return "unknown";
  if (counts.ahead === 0 && counts.behind === 0) return "unrelated";
  if (counts.ahead > 0 && counts.behind > 0) return "diverged";
  if (counts.ahead > 0) return "ahead";
  if (counts.behind > 0) return "behind";
  return "unknown";
}

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function asSha(value: string): Sha | null {
  const text = value.trim().toLowerCase();
  return SHA_RE.test(text) ? text : null;
}

/** Reject anything git could treat as an option or a refspec rewrite. */
export function safeRef(value: string): boolean {
  if (!value || value.startsWith("-") || value.includes("..")) return false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || " ~^:?*[\\".includes(char)) return false;
  }
  return true;
}

export function forbiddenArg(args: readonly string[]): boolean {
  return args.some(
    (arg) =>
      arg === "--hard" || arg === "--force" || arg === "-f" || arg === "stash" || arg === "clean",
  );
}

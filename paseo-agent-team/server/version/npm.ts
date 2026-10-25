import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import type { ExecPort } from "./process";

export type NpmResolution =
  | { ok: true; cli: string; nodePath: string }
  | { ok: false; detail: string };

const PROBE_BUDGET_MS = 10_000;

/** Resolve npm before any git write. Electron's execPath is not assumed to ship npm. */
export async function resolveNpmCli(input: {
  exec: ExecPort;
  nodePath: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  timeoutMs?: number;
  exists?: (candidate: string) => Promise<boolean>;
}): Promise<NpmResolution> {
  const exists = input.exists ?? fileExists;
  const budget = input.timeoutMs ?? PROBE_BUDGET_MS;
  const started = Date.now();
  const nodePath = await runtimeNode(input.nodePath, input.env, input.platform, exists);
  if (!nodePath) {
    return {
      ok: false,
      detail: "node was not found on PATH; install Node and retry, or update the checkout manually",
    };
  }
  const candidates = await npmCandidates(nodePath, input.env, input.platform, exists);
  for (const candidate of candidates) {
    const remaining = budget - (Date.now() - started);
    if (remaining <= 0) break;
    const result = await input.exec
      .run({
        file: nodePath,
        args: [candidate, "--version"],
        env: input.env,
        timeoutMs: Math.min(remaining, budget),
      })
      .catch(() => null);
    if (result?.exitCode === 0 && result.stdout.trim())
      return { ok: true, cli: candidate, nodePath };
  }
  return {
    ok: false,
    detail:
      "npm-cli.js was not found beside Node or on PATH; install npm and retry, or update the checkout manually",
  };
}

export async function npmCandidates(
  nodePath: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (candidate: string) => Promise<boolean> = fileExists,
): Promise<string[]> {
  const candidates: string[] = [];
  const configured = env.npm_execpath;
  if (configured && !configured.includes("\0") && path.basename(configured) === "npm-cli.js") {
    candidates.push(path.resolve(configured));
  }
  const nodeDir = path.dirname(nodePath);
  candidates.push(
    platform === "win32"
      ? path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js")
      : path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  );
  const command = platform === "win32" ? "npm.cmd" : "npm";
  for (const directory of pathEntries(env)) {
    const launcher = path.join(directory, command);
    if (!(await exists(launcher))) continue;
    const resolved = platform === "win32" ? launcher : ((await realPathOf(launcher)) ?? launcher);
    candidates.push(
      platform === "win32"
        ? path.join(path.dirname(resolved), "node_modules", "npm", "bin", "npm-cli.js")
        : path.join(
            path.dirname(resolved),
            "..",
            "lib",
            "node_modules",
            "npm",
            "bin",
            "npm-cli.js",
          ),
    );
  }
  const accepted: string[] = [];
  for (const candidate of candidates.map((candidate) => path.resolve(candidate))) {
    if (path.basename(candidate) !== "npm-cli.js" || accepted.includes(candidate)) continue;
    if (await exists(candidate)) accepted.push(candidate);
  }
  return accepted;
}

/** Electron cannot be trusted to run npm. A real `node` on PATH is required instead. */
export async function runtimeNode(
  execPath: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (candidate: string) => Promise<boolean> = fileExists,
): Promise<string | null> {
  if (path.basename(execPath).toLowerCase().startsWith("node")) return execPath;
  const names = platform === "win32" ? ["node.exe", "node"] : ["node"];
  for (const directory of pathEntries(env)) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? env.Path ?? "")
    .split(path.delimiter)
    .filter((directory) => directory && !directory.includes("\0"));
}

async function realPathOf(candidate: string): Promise<string | null> {
  try {
    return await realpath(candidate);
  } catch {
    return null;
  }
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

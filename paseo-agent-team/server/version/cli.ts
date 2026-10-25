import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { type Blocker, blocker, PLUGIN_ID } from "../../shared/version";
import type { ExecPort, ExecResult } from "./process";

export type CliCommand = "reload" | "ls" | "update";

export type CliInvocation = {
  file: string;
  args: readonly string[];
  cwd: string;
};

export type ResolvedCli = { entry: string; via: "node" } | { blocker: Blocker };

const ENTRY = path.join("node_modules", "@getpaseo", "cli", "dist", "index.js");

/** Only the plugin install's own CLI. A missing entry is a blocker, never PATH `paseo`. */
export async function resolveCliEntry(
  pluginDir: string,
  exists: (candidate: string) => Promise<boolean> = realCli,
): Promise<ResolvedCli> {
  const entry = path.resolve(pluginDir, ENTRY);
  const root = path.resolve(pluginDir);
  if (!entry.startsWith(root + path.sep)) {
    return {
      blocker: blocker("cli_missing", "install_cli", "cli path escaped the plugin directory"),
    };
  }
  if (!(await exists(entry))) {
    return {
      blocker: blocker(
        "cli_missing",
        "manual_update",
        "bundled @getpaseo/cli entry is not installed",
      ),
    };
  }
  return { entry, via: "node" };
}

async function realCli(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.R_OK);
    const real = await realpath(candidate);
    const root = await realpath(
      path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(candidate))))),
    );
    return real.startsWith(root + path.sep);
  } catch {
    return false;
  }
}

export function cliArgs(input: { command: CliCommand; home: string; ref?: string }): string[] {
  if (input.command === "reload")
    return ["plugin", "reload", PLUGIN_ID, "--json", "--home", input.home];
  if (input.command === "ls") return ["plugin", "ls", PLUGIN_ID, "--json", "--home", input.home];
  return ["plugin", "update", PLUGIN_ID, "--ref", input.ref ?? "", "--json", "--home", input.home];
}

export async function runCli(
  exec: ExecPort,
  node: string,
  entry: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ExecResult> {
  return exec.run({
    file: node,
    args: [entry, ...args],
    env,
    timeoutMs,
    maxOutputBytes: 1024 * 1024,
  });
}

export type PluginListItem = {
  id?: string;
  status?: string;
  error?: string;
  path?: string;
  installation?: { currentRevision?: string; identity?: { kind?: string } };
};

/** `--json` prints the raw list item, or `{ error }` on failure. */
export function parseCliJson(
  stdout: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
  const text = stdout.trim();
  if (!text) return { ok: false, message: "cli produced no json" };
  try {
    const value = JSON.parse(text) as unknown;
    if (
      value &&
      typeof value === "object" &&
      "error" in value &&
      value.error &&
      typeof value.error === "object"
    ) {
      const message =
        "message" in value.error && typeof value.error.message === "string"
          ? value.error.message
          : "";
      return { ok: false, message: message || "cli error" };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, message: "cli json parse failed" };
  }
}

export function pluginRunning(value: unknown): {
  running: boolean;
  error: string | null;
  revision: string | null;
} {
  const item = Array.isArray(value) ? value[0] : value;
  if (!item || typeof item !== "object")
    return { running: false, error: "plugin list was empty", revision: null };
  const record = item as PluginListItem;
  return {
    running: record.status === "running" && !record.error,
    error: record.error ?? null,
    revision: record.installation?.currentRevision ?? null,
  };
}

export function manualUpdateCommand(home: string, sha: string): string {
  return `paseo plugin update ${PLUGIN_ID} --ref ${sha} --home ${home}`;
}

export type CliLocation = CliInvocation;

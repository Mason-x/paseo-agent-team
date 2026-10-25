import { describe, expect, test } from "vitest";
import { decideUpdate } from "../server/version/decide";
import type { ExecResult } from "../server/version/process";
import { createVersionService, type VersionDeps } from "../server/version/service";
import { blocker } from "../shared/version";

const HOME = "C:\\paseo-dev";
const PLUGIN = "C:\\repo\\paseo-agent-team";
const SHA = "a".repeat(40);
const REQUEST = "11111111-1111-4111-8111-111111111111";

function execResult(stdout = "", exitCode = 0): ExecResult {
  return { exitCode, stdout, stderr: "", timedOut: false, truncated: false };
}

function gitScript(mode: "dirty" | "ahead" | "diverged" | "detached" | "no-upstream") {
  const calls: string[][] = [];
  return {
    calls,
    git: {
      async run(request: { args: readonly string[] }) {
        calls.push([...request.args]);
        const joined = request.args.join(" ");
        if (joined.includes("show-toplevel")) return execResult("C:\\repo");
        if (joined === "rev-parse HEAD") return execResult(SHA);
        if (joined.includes("--abbrev-ref HEAD"))
          return execResult(mode === "detached" ? "HEAD" : "main");
        if (joined.includes("porcelain")) return execResult(mode === "dirty" ? "?? new.txt\0" : "");
        if (joined.includes("MERGE_HEAD")) return execResult("", 1);
        if (joined.includes("@{upstream}") && joined.includes("abbrev-ref")) {
          return mode === "no-upstream" ? execResult("fatal", 128) : execResult("origin/main");
        }
        if (joined.includes("--left-right")) {
          if (mode === "ahead") return execResult("1\t0");
          if (mode === "diverged") return execResult("2\t3");
          return execResult("0\t1");
        }
        if (joined.includes("ls-files")) return execResult("paseo-agent-team/paseo-plugin.json");
        if (joined.includes("get-url"))
          return execResult("https://github.com/Mason-x/paseo-agent-team.git");
        if (joined.includes("ls-remote --tags"))
          return execResult(`${"b".repeat(40)} refs/tags/paseo-agent-team-v0.3.0`);
        return execResult("", 1);
      },
    },
  };
}

function service(
  mode: "dirty" | "ahead" | "diverged" | "detached" | "no-upstream",
  home = `${HOME}\\`,
) {
  const script = gitScript(mode);
  const deps: VersionDeps = {
    env: home ? { PASEO_HOME: home } : {},
    files: {
      async readText(file) {
        if (file.endsWith("package.json"))
          return JSON.stringify({ name: "@mason-x/paseo-agent-team", version: "0.2.3" });
        if (file.endsWith("paseo-plugin.json")) return JSON.stringify({ id: "paseo-agent-team" });
        if (file.endsWith("server-id")) return "server-1";
        throw new Error(`missing ${file}`);
      },
      writeAtomic: async () => {},
      exclusiveCreate: async () => true,
      remove: async () => {},
    },
    exec: { run: async () => execResult() },
    git: script.git,
    clock: {
      now: () => Date.parse("2026-10-25T00:00:00.000Z"),
      iso: () => "2026-10-25T00:00:00.000Z",
    },
    ids: { uuid: () => "22222222-2222-4222-8222-222222222222" },
    fetch: async () => ({ status: 404, headers: { get: () => null }, text: async () => "" }),
    bootId: "33333333-3333-4333-8333-333333333333",
    platform: "win32",
    pathExists: () => true,
  };
  return { deps, calls: script.calls };
}

describe("unsafe checkouts", () => {
  test.each(["dirty", "ahead", "diverged", "detached", "no-upstream"] as const)(
    "%s reports a blocker and runs no write command",
    async (mode) => {
      const { deps, calls } = service(mode);
      const versions = createVersionService(deps);
      const started = await versions.check(
        {
          config: {
            get: async () => ({
              config: { plugins: { "paseo-agent-team": { source: "directory", path: PLUGIN } } },
            }),
          },
        },
        REQUEST,
      );
      expect(started.ok).toBe(true);
      if (!started.ok || !started.job.result) throw new Error("expected a check result");
      expect(started.job.result.canUpdate).toBe(false);
      const writes = calls.filter((args: string[]) =>
        args.some((arg: string) => ["fetch", "merge", "reset", "clean", "stash"].includes(arg)),
      );
      expect(writes).toEqual([]);
      expect(calls.join(" ")).not.toMatch(/hard|force|stash/);
    },
  );

  test("a missing PASEO_HOME never falls back to the default home", async () => {
    const { deps, calls } = service("dirty", "");
    deps.env = {};
    const versions = createVersionService(deps);
    const info = await versions.get({ config: { get: async () => ({ config: {} }) } });
    expect(info.info.blockers.map((item) => item.code)).toContain("home_unavailable");
    expect(calls).toEqual([]);
    expect(info.info.current.pluginPath).toBeNull();
  });

  test("dirty still counts as an available update while update stays disabled", () => {
    expect(
      decideUpdate({
        source: "directory",
        registry: false,
        relation: "behind",
        sameCommit: false,
        blockers: [blocker("dirty", "inspect_local_changes")],
        cliAvailable: true,
      }).canUpdate,
    ).toBe(false);
  });
});

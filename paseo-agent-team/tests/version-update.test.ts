import path from "node:path";
import { describe, expect, test } from "vitest";
import { cliArgs, manualUpdateCommand } from "../server/version/cli";
import type { ExecResult, FilesPort } from "../server/version/process";
import { createVersionService } from "../server/version/service";
import { createStore, storeRoot } from "../server/version/store";
import type { Job, VersionInfo } from "../shared/version";

const HOME = "C:\\paseo-dev";
const PLUGIN = "C:\\repo\\paseo-agent-team";
const OLD = "a".repeat(40);
const TARGET = "b".repeat(40);
const REQUEST = "11111111-1111-4111-8111-111111111111";
const CHECK = "22222222-2222-4222-8222-222222222222";

function result(stdout = "", exitCode = 0): ExecResult {
  return { exitCode, stdout, stderr: "", timedOut: false, truncated: false };
}

type MemoryFiles = FilesPort & { data: Map<string, string> };

function memoryFiles(initial: Record<string, string> = {}): MemoryFiles {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async readText(file) {
      const text = data.get(file);
      if (text === undefined) throw new Error(`missing ${file}`);
      return text;
    },
    async writeAtomic(file, text) {
      data.set(file, text);
    },
    async exclusiveCreate(file, text) {
      if (data.has(file)) return false;
      data.set(file, text);
      return true;
    },
    async remove(file) {
      data.delete(file);
    },
  };
}

function info(canUpdate: boolean): VersionInfo {
  return {
    schemaVersion: 1,
    current: {
      packageVersion: "0.2.3",
      commit: OLD,
      branch: "main",
      dirty: false,
      pluginPath: PLUGIN,
      repositoryPath: "C:\\repo",
      observedAt: "2026-10-25T00:00:00.000Z",
    },
    installSource: { kind: "directory", path: PLUGIN, isGit: true },
    remote: {
      state: "ready",
      repositoryLatest: {
        kind: "release-tag",
        version: "0.3.0",
        commit: TARGET,
        ref: "refs/tags/paseo-agent-team-v0.3.0",
        sourceUrl: "https://github.com/Mason-x/paseo-agent-team.git",
      },
      installTarget: {
        kind: "release-tag",
        version: "0.3.0",
        commit: TARGET,
        ref: "refs/tags/paseo-agent-team-v0.3.0",
        sourceUrl: "https://github.com/Mason-x/paseo-agent-team.git",
      },
      checkedAt: "2026-10-25T00:00:00.000Z",
      stale: false,
      error: null,
    },
    relation: "behind",
    pendingCommits: null,
    updateAvailable: true,
    canUpdate,
    cliAvailable: true,
    checkId: CHECK,
    blockers: [],
  };
}

function baseDeps(files: ReturnType<typeof memoryFiles>) {
  const spawned: string[] = [];
  return {
    spawned,
    deps: {
      env: { PASEO_HOME: HOME },
      files,
      exec: {
        async run(request: { args: readonly string[] }) {
          if (request.args.includes("--version")) return result("11.19.1\n");
          if (request.args.includes("--self-test")) return result("ok\n");
          return result();
        },
      },
      git: {
        async run(request: { args: readonly string[] }) {
          const joined = request.args.join(" ");
          if (joined.includes("show-toplevel")) return result("C:\\repo");
          if (joined === "rev-parse HEAD") return result(OLD);
          if (joined.includes("porcelain")) return result("");
          if (joined.includes("MERGE_HEAD")) return result("", 1);
          if (joined.includes("@{upstream}")) return result("origin/main");
          if (joined.includes("--left-right")) return result("0\t1");
          if (joined.includes("ls-files")) return result("paseo-agent-team/paseo-plugin.json");
          if (joined.includes("get-url"))
            return result("https://github.com/Mason-x/paseo-agent-team.git");
          return result("", 1);
        },
      },
      clock: {
        now: () => Date.parse("2026-10-25T00:00:00.000Z"),
        iso: () => "2026-10-25T00:00:00.000Z",
      },
      ids: { uuid: () => "66666666-6666-4666-8666-666666666666" },
      fetch: async () => ({ status: 404, headers: { get: () => null }, text: async () => "" }),
      bootId: "77777777-7777-4777-8777-777777777777",
      platform: "win32" as const,
      pathExists: () => true,
      cliExists: async (candidate: string) => files.data.has(candidate),
      runnerSource: "C:\\repo\\paseo-agent-team\\server\\version\\runner.mjs",
      spawnRunner: async (file: string) => {
        spawned.push(file);
      },
    },
  };
}

const paseo = {
  config: {
    get: async () => ({
      config: { plugins: { "paseo-agent-team": { source: "directory", path: PLUGIN } } },
    }),
  },
};

describe("update start", () => {
  test("repeats the same request id and rejects a second update while locked", async () => {
    const root = storeRoot(HOME, "server-1");
    const files = memoryFiles({
      [path.join(HOME, "server-id")]: "server-1",
      [path.join(PLUGIN, "package.json")]: JSON.stringify({
        name: "@mason-x/paseo-agent-team",
        version: "0.2.3",
      }),
      [path.join(PLUGIN, "paseo-plugin.json")]: JSON.stringify({ id: "paseo-agent-team" }),
      [path.join(PLUGIN, "node_modules", "@getpaseo", "cli", "dist", "index.js")]: "export {}\n",
      [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]:
        "export {}\n",
      [path.join(root, "checks", `${CHECK}.json`)]: JSON.stringify({
        id: CHECK,
        savedAt: "2026-10-25T00:00:00.000Z",
        info: info(true),
        remoteUrl: "https://github.com/Mason-x/paseo-agent-team.git",
        targetRef: "refs/tags/paseo-agent-team-v0.3.0",
        pluginSubpath: "paseo-agent-team",
        serverId: "server-1",
      }),
      [path.join(PLUGIN, "server", "version", "runner.mjs")]: "export {}\n",
    });
    const { deps, spawned } = baseDeps(files);
    const versions = createVersionService(deps);
    const first = await versions.startUpdate(paseo, REQUEST, CHECK);
    const second = await versions.startUpdate(paseo, REQUEST, CHECK);
    expect(first.ok && second.ok && first.job.id === second.job.id).toBe(true);
    expect(spawned).toHaveLength(1);
    const other = await versions.startUpdate(paseo, "88888888-8888-4888-8888-888888888888", CHECK);
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.blockers[0]?.code).toBe("concurrent_update");
    const joined = [...files.data.values()].join("\n");
    expect(joined).not.toMatch(/reset --hard|stash|checkout -f|--force/);
  });

  test("a managed git install without the bundled CLI returns a manual command", async () => {
    const managed = path.join(
      HOME,
      "plugins",
      "paseo-agent-team",
      "12345678-1234-4234-8234-123456789abc",
      "checkout",
      "paseo-agent-team",
    );
    const files = memoryFiles({
      [path.join(HOME, "server-id")]: "server-1",
      [path.join(managed, "package.json")]: JSON.stringify({
        name: "@mason-x/paseo-agent-team",
        version: "0.2.3",
      }),
      [path.join(managed, "paseo-plugin.json")]: JSON.stringify({ id: "paseo-agent-team" }),
      [path.join(HOME, "plugins", "sources.json")]: JSON.stringify({
        "paseo-agent-team": {
          kind: "git",
          remote: "https://github.com/Mason-x/paseo-agent-team.git",
        },
      }),
      [path.join(storeRoot(HOME, "server-1"), "checks", `${CHECK}.json`)]: JSON.stringify({
        id: CHECK,
        savedAt: "2026-10-25T00:00:00.000Z",
        info: {
          ...info(true),
          current: { ...info(true).current, pluginPath: managed, commit: OLD },
          installSource: {
            kind: "git",
            remote: "https://github.com/Mason-x/paseo-agent-team.git",
            pluginPath: "paseo-agent-team",
            installedCommit: OLD,
            ref: null,
            registry: null,
          },
        },
        remoteUrl: "https://github.com/Mason-x/paseo-agent-team.git",
        targetRef: "refs/tags/paseo-agent-team-v0.3.0",
        pluginSubpath: "paseo-agent-team",
        serverId: "server-1",
      }),
    });
    const { deps } = baseDeps(files);
    deps.git = { run: async () => result(OLD) };
    const versions = createVersionService(deps);
    const started = await versions.startUpdate(
      {
        config: {
          get: async () => ({
            config: { plugins: { "paseo-agent-team": { source: "directory", path: managed } } },
          }),
        },
      },
      REQUEST,
      CHECK,
    );
    expect(started.ok).toBe(false);
    if (!started.ok) {
      expect(started.blockers[0]?.code).toBe("cli_missing");
      expect(started.blockers[0]?.detail).toContain(manualUpdateCommand(HOME, TARGET));
    }
  });

  test("cli arguments always name the explicit home and never a destructive git flag", () => {
    expect(cliArgs({ command: "reload", home: HOME }).join(" ")).toContain(`--home ${HOME}`);
    expect(cliArgs({ command: "update", home: HOME, ref: TARGET }).join(" ")).not.toMatch(
      /--hard|--force|stash/,
    );
    const store = createStore(memoryFiles(), storeRoot(HOME, "server-1"));
    expect(store.root).toContain("agent-team-runtime");
  });
  test("legacy update jobs still load while a legacy check result is rejected", async () => {
    const files = memoryFiles({ [path.join(HOME, "server-id")]: "server-1" });
    const store = createStore(files, storeRoot(HOME, "server-1"));
    const base = {
      schemaVersion: 1,
      requestId: REQUEST,
      kind: "update",
      phase: "fetching",
      seq: 1,
      startedAt: "2026-10-25T00:00:00.000Z",
      updatedAt: "2026-10-25T00:00:00.000Z",
      finishedAt: null,
      from: null,
      target: null,
      result: null,
      error: null,
      rollback: "not-needed",
    };
    const runningId = "44444444-4444-4444-8444-444444444444";
    const doneId = "55555555-5555-4555-8555-555555555555";
    const checkId = "66666666-6666-4666-8666-666666666666";
    const legacyResult = JSON.parse(JSON.stringify(info(true))) as Record<string, unknown>;
    delete legacyResult.pendingCommits;
    await files.writeAtomic(
      path.join(store.jobDir(runningId), "status.json"),
      JSON.stringify({ ...base, id: runningId, state: "running" }),
    );
    await files.writeAtomic(
      path.join(store.jobDir(doneId), "status.json"),
      JSON.stringify({
        ...base,
        id: doneId,
        state: "succeeded",
        phase: "done",
        finishedAt: "2026-10-25T00:01:00.000Z",
      }),
    );
    await files.writeAtomic(
      path.join(store.jobDir(checkId), "status.json"),
      JSON.stringify({
        ...base,
        id: checkId,
        kind: "check",
        state: "succeeded",
        result: legacyResult,
      }),
    );
    expect((await store.readJob(runningId))?.state).toBe("running");
    expect((await store.readJob(doneId))?.state).toBe("succeeded");
    expect(await store.readJob(checkId)).toBeNull();
  });
});

void (0 as unknown as Job);

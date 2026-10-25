import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { confirmPendingBoot } from "../server/version/boot";
import { cliArgs, parseCliJson, pluginRunning, resolveCliEntry } from "../server/version/cli";
import { createGit, forbiddenArg, safeRef } from "../server/version/git";
import {
  classifyManagedPath,
  parseSources,
  resolveExplicitHome,
} from "../server/version/local-install";
import { npmCandidates, resolveNpmCli, runtimeNode } from "../server/version/npm";
import { type ExecResult, type FilesPort, nodeExec, nodeFiles } from "../server/version/process";
import { parseSymrefHead } from "../server/version/remote";
import { main, runRequest } from "../server/version/runner.mjs";
import { createVersionService } from "../server/version/service";
import { createStore, storeRoot } from "../server/version/store";

const HOME = path.join("C:\\", "paseo-dev");
const PLUGIN = path.join("C:\\", "repo", "paseo-agent-team");
const OLD = "a".repeat(40);
const TARGET = "b".repeat(40);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function ok(stdout = "", exitCode = 0): ExecResult {
  return { exitCode, stdout, stderr: "", timedOut: false, truncated: false };
}

function filesFrom(initial: Record<string, string>): FilesPort & { data: Map<string, string> } {
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

function directoryGit(extra: Record<string, ExecResult> = {}) {
  return {
    async run(request: { args: readonly string[] }) {
      const joined = request.args.join(" ");
      for (const [needle, value] of Object.entries(extra)) {
        if (joined.includes(needle)) return value;
      }
      if (joined.includes("show-toplevel")) return ok("C:\\repo");
      if (joined === "rev-parse HEAD") return ok(OLD);
      if (joined.includes("--abbrev-ref HEAD")) return ok("main");
      if (joined.includes("porcelain")) return ok("");
      if (joined.includes("MERGE_HEAD")) return ok("", 1);
      if (joined.includes("@{upstream}")) return ok("origin/main");
      if (joined.includes("--left-right")) return ok("0\t1");
      if (joined.includes("ls-files")) return ok("paseo-agent-team/paseo-plugin.json");
      if (joined.includes("get-url")) return ok("https://github.com/Mason-x/paseo-agent-team.git");
      if (joined.includes("ls-remote --tags")) {
        return ok(`${TARGET} refs/tags/paseo-agent-team-v0.3.0\n`);
      }
      if (joined.includes("cat-file")) return ok("");
      if (joined.includes("merge-base --is-ancestor")) return ok("");
      if (joined.startsWith("show ")) {
        return ok(JSON.stringify({ name: "@mason-x/paseo-agent-team", version: "0.3.0" }));
      }
      return ok("", 1);
    },
  };
}

function serviceDeps(files: ReturnType<typeof filesFrom>, git = directoryGit()) {
  return {
    env: { PASEO_HOME: HOME },
    files,
    exec: { run: async () => ok("ok\n") },
    git,
    clock: {
      now: () => Date.parse("2026-10-25T00:00:00.000Z"),
      iso: () => "2026-10-25T00:00:00.000Z",
    },
    ids: (() => {
      const ids = [
        "22222222-2222-4222-8222-222222222222",
        "66666666-6666-4666-8666-666666666666",
        "99999999-9999-4999-8999-999999999999",
      ];
      return { uuid: () => ids.shift() ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    })(),
    fetch: async () => ({
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ name: "@mason-x/paseo-agent-team", version: "0.3.0" }),
    }),
    bootId: "77777777-7777-4777-8777-777777777777",
    platform: "win32" as const,
    pathExists: () => true,
    cliExists: async (candidate: string) => files.data.has(candidate),
    runnerSource: path.join(PLUGIN, "server", "version", "runner.mjs"),
    spawnRunner: async () => {},
  };
}

function seededFiles() {
  return filesFrom({
    [path.join(HOME, "server-id")]: "server-1",
    [path.join(PLUGIN, "package.json")]: JSON.stringify({
      name: "@mason-x/paseo-agent-team",
      version: "0.2.3",
    }),
    [path.join(PLUGIN, "paseo-plugin.json")]: JSON.stringify({ id: "paseo-agent-team" }),
    [path.join(PLUGIN, "node_modules", "@getpaseo", "cli", "dist", "index.js")]: "export {}\n",
    [path.join(PLUGIN, "server", "version", "runner.mjs")]: "export {}\n",
  });
}

const paseo = {
  config: {
    get: async () => ({
      config: { plugins: { "paseo-agent-team": { source: "directory", path: PLUGIN } } },
    }),
  },
};

describe("version flow", () => {
  test("a clean behind checkout can update to the stable tag", async () => {
    const versions = createVersionService(serviceDeps(seededFiles()));
    const checked = await versions.check(paseo, "11111111-1111-4111-8111-111111111111");
    expect(checked.ok).toBe(true);
    if (!checked.ok || !checked.job.result) throw new Error("check failed");
    expect(checked.job.result.updateAvailable).toBe(true);
    expect(checked.job.result.canUpdate).toBe(true);
    expect(checked.job.result.remote.installTarget?.kind).toBe("release-tag");
    const started = await versions.startUpdate(
      paseo,
      "12345678-1234-4234-8234-123456789abc",
      checked.job.result.checkId ?? "",
    );
    expect(started.ok).toBe(true);
  });

  test("no stable tag falls back to the remote default branch", async () => {
    const git = directoryGit({
      "ls-remote --tags": ok(""),
      "ls-remote --symref": ok(`ref: refs/heads/trunk HEAD\n${TARGET} HEAD\n`),
    });
    const versions = createVersionService(serviceDeps(seededFiles(), git));
    const checked = await versions.check(paseo, "11111111-1111-4111-8111-111111111111");
    if (!checked.ok || !checked.job.result) throw new Error("check failed");
    expect(checked.job.result.remote.installTarget?.kind).toBe("default-branch");
    expect(checked.job.result.remote.installTarget?.ref).toBe("refs/heads/trunk");
  });

  test("npm and registry installs stay display-only", () => {
    const home = path.resolve(HOME);
    const npmPath = path.join(
      home,
      "plugins",
      "paseo-agent-team",
      "12345678-1234-4234-8234-123456789abc",
      "node_modules",
      "@mason-x",
      "paseo-agent-team",
    );
    expect(classifyManagedPath(home, npmPath).kind).toBe("npm");
    expect(parseSources("{").kind).toBe("unreadable");
    expect(
      parseSources(
        JSON.stringify({
          "paseo-agent-team": { kind: "npm", registry: { url: "https://example.test", id: "x" } },
        }),
      ).kind,
    ).toBe("npm");
    expect(resolveExplicitHome({ PASEO_HOME: "relative" }, "win32").ok).toBe(false);
    expect(resolveExplicitHome({ PASEO_HOME: "C:\\dev\0" }, "win32").ok).toBe(false);
    expect(safeRef("refs/heads/main")).toBe(true);
    expect(safeRef("-bad")).toBe(false);
    expect(forbiddenArg(["reset", "--hard"])).toBe(true);
    expect(parseSymrefHead("not a symref")).toBeNull();
  });

  test("node adapters and the job store round-trip without a daemon", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-team-store-"));
    roots.push(directory);
    const files = nodeFiles();
    const exec = nodeExec();
    const target = path.join(directory, "note.txt");
    await files.writeAtomic(target, "hello");
    const missing = await exec
      .run({ file: "definitely-missing-binary", args: ["--version"], timeoutMs: 1000 })
      .catch((error: Error) => error);
    expect(missing).toBeInstanceOf(Error);
    const timed = await exec.run({
      file: process.execPath,
      args: ["-e", "setTimeout(() => {}, 5000)"],
      timeoutMs: 50,
    });
    expect(timed.timedOut).toBe(true);
    await expect(files.readText(path.join(directory, "missing-note"), 10)).rejects.toThrow();
    await files.writeAtomic(path.join(directory, "big.txt"), "abcdef");
    await expect(files.readText(path.join(directory, "big.txt"), 2)).rejects.toThrow(/size/);
    await files.remove(path.join(directory, "big.txt"));
    expect(parseCliJson("{")).toEqual({ ok: false, message: "cli json parse failed" });
    expect(parseCliJson('{"error":{}}')).toEqual({ ok: false, message: "cli error" });
    expect(pluginRunning(null).running).toBe(false);
    const versions = createVersionService({
      ...serviceDeps(seededFiles()),
      spawnRunner: undefined,
    });
    const checked = await versions.check(paseo, "11111111-1111-4111-8111-111111111111");
    if (!checked.ok || !checked.job.result?.checkId) throw new Error("check failed");
    await files.remove(path.join(directory, "big.txt"));
    const started = await versions.startUpdate(
      paseo,
      "12345678-1234-4234-8234-123456789abc",
      checked.job.result.checkId,
    );
    expect(started.ok).toBe(true);
    expect(await files.exclusiveCreate(target, "again")).toBe(false);
    await files.remove(target);
    const ran = await exec.run({
      file: process.execPath,
      args: ["-e", "process.stdout.write('hi')"],
      timeoutMs: 5000,
    });
    expect(ran.stdout).toBe("hi");
    expect(ran.exitCode).toBe(0);
    const store = createStore(files, storeRoot(directory, "server-1"));
    expect(
      await store.tryLock({
        jobId: "44444444-4444-4444-8444-444444444444",
        ownerPid: 1,
        acquiredAt: "2026-10-25T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      await store.tryLock({
        jobId: "55555555-5555-4555-8555-555555555555",
        ownerPid: 2,
        acquiredAt: "2026-10-25T00:00:00.000Z",
      }),
    ).toBe(false);
    await store.unlock("44444444-4444-4444-8444-444444444444");
    const git = createGit(
      { run: async (request) => ok(request.env?.GIT_OPTIONAL_LOCKS ?? "") },
      { GIT_DIR: "redirect", PATH: process.env.PATH },
    );
    const stripped = await git.run({ args: ["status"], cwd: directory });
    expect(stripped.stdout).toBe("0");
  });

  test("the runner reaches done when the new boot confirms the target", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-team-success-"));
    roots.push(directory);
    let head = OLD;
    const git = async (args: string[]) => {
      if (args.includes("--show-toplevel"))
        return { exitCode: 0, stdout: path.join(directory, "repo"), stderr: "" };
      if (args[0] === "remote" && args.length === 1)
        return { exitCode: 0, stdout: "origin\n", stderr: "" };
      if (args[0] === "remote" && args[1] === "get-url")
        return { exitCode: 0, stdout: "file:///upstream.git\n", stderr: "" };
      if (args[0] === "fetch" || args.includes("merge") || args[0] === "reset") {
        if (args.includes("merge")) head = TARGET;
        if (args[0] === "reset") head = OLD;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse" && String(args[1]).includes("refs/agent-team-updates"))
        return { exitCode: 0, stdout: TARGET, stderr: "" };
      if (args[0] === "merge-base") return { exitCode: 0, stdout: "", stderr: "" };
      if (args.includes("porcelain")) return { exitCode: 0, stdout: "", stderr: "" };
      if (args.includes("--abbrev-ref") && args.includes("HEAD"))
        return { exitCode: 0, stdout: "main", stderr: "" };
      if (args.includes("@{upstream}")) return { exitCode: 0, stdout: "origin/main", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "HEAD")
        return { exitCode: 0, stdout: head, stderr: "" };
      if (args[0] === "cat-file") return { exitCode: 1, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const { request, jobFile } = await stage(directory);
    await runRequest(request, {
      git,
      exec: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ status: "running" }),
        stderr: "",
      }),
      now: () => "2026-10-25T00:02:00.000Z",
      sleep: async () => {},
      attempts: 1,
      readBoot: () => ({ bootId: "boot-new", commit: TARGET, packageVersion: "0.3.0" }),
    });
    const finished = JSON.parse(await nodeFiles().readText(jobFile, 100000));
    expect(finished.state).toBe("succeeded");
  });

  test("a managed update that cannot prove the old install stays recovery_required", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-team-managed-"));
    roots.push(directory);
    const { request, jobFile } = await stage(directory, { mode: "managed-git" });
    await runRequest(request, {
      git: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      exec: async (_file: string, args: string[]) => ({
        exitCode: args.includes("update") ? 1 : 0,
        stdout: JSON.stringify({ status: "failed", error: "missing" }),
        stderr: "update failed",
      }),
      now: () => "2026-10-25T00:02:00.000Z",
      sleep: async () => {},
      attempts: 1,
      readBoot: () => null,
    });
    expect(JSON.parse(await nodeFiles().readText(jobFile, 100000)).state).toBe("recovery_required");
  });

  test("cli json and the self-test entry stay local", async () => {
    expect(parseCliJson("").ok).toBe(false);
    expect(parseCliJson('{"error":{"message":"no"}}').ok).toBe(false);
    expect(
      pluginRunning([{ status: "running", installation: { currentRevision: OLD } }]).running,
    ).toBe(true);
    expect(cliArgs({ command: "ls", home: HOME })).toContain("--home");
    const missing = await resolveCliEntry(PLUGIN, async () => false);
    expect("blocker" in missing).toBe(true);
    const io = { stdout: { write: () => {} }, stderr: { write: () => {} } };
    expect(await main(["--self-test"], io)).toBe(0);
    expect(await main([], io)).toBe(2);
  });

  test("runner failures stop at the failing phase and malformed jobs do not load", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-team-phases-"));
    roots.push(directory);
    const clean = async (args: string[], head = OLD) => {
      if (args.includes("--show-toplevel"))
        return { exitCode: 0, stdout: path.join(directory, "repo"), stderr: "" };
      if (args[0] === "remote" && args.length === 1)
        return { exitCode: 0, stdout: "origin\n", stderr: "" };
      if (args[0] === "remote" && args[1] === "get-url")
        return { exitCode: 0, stdout: "file:///upstream.git\n", stderr: "" };
      if (args.includes("porcelain")) return { exitCode: 0, stdout: "", stderr: "" };
      if (args.includes("--abbrev-ref") && args.includes("HEAD"))
        return { exitCode: 0, stdout: "main", stderr: "" };
      if (args.includes("@{upstream}")) return { exitCode: 0, stdout: "origin/main", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "HEAD")
        return { exitCode: 0, stdout: head, stderr: "" };
      if (args[0] === "cat-file") return { exitCode: 1, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const mergeFail = await stage(directory);
    await runRequest(mergeFail.request, {
      git: async (args: string[]) =>
        args.includes("merge") ? { exitCode: 1, stdout: "", stderr: "ff failed" } : clean(args),
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      now: () => "2026-10-25T00:03:00.000Z",
      sleep: async () => {},
      attempts: 1,
      readBoot: () => null,
    });
    expect(["verifying_target", "fast_forwarding"]).toContain(
      JSON.parse(await nodeFiles().readText(mergeFail.jobFile, 100000)).phase,
    );

    const reloadFail = await stage(path.join(directory, "reload"), {
      jobId: "55555555-5555-4555-8555-555555555555",
    });
    await runRequest(reloadFail.request, {
      git: async (args: string[]) => clean(args, args.includes("merge") ? TARGET : TARGET),
      exec: async (_file: string, args: string[]) => ({
        exitCode: args.includes("reload") ? 1 : 0,
        stdout: "",
        stderr: "reload failed",
      }),
      now: () => "2026-10-25T00:03:00.000Z",
      sleep: async () => {},
      attempts: 1,
      readBoot: () => null,
    });
    const reloadJob = JSON.parse(await nodeFiles().readText(reloadFail.jobFile, 100000));
    expect(["blocked", "rolling_back", "recovery_required"]).toContain(reloadJob.state);

    const files = nodeFiles();
    const store = createStore(files, storeRoot(directory, "missing"));
    expect(await store.readJob("not-a-uuid")).toBeNull();
    expect(await store.jobForRequest("not-a-uuid")).toBeNull();
    expect(await store.readLatest()).toBeNull();
    expect(await store.readLock()).toBeNull();
    const io = { stdout: { write: () => {} }, stderr: { write: () => {} } };
    expect(await main(["--request"], io)).toBe(2);
  });

  test("a reloaded service writes the boot file the runner reads", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-team-boot-"));
    roots.push(directory);
    const files = nodeFiles();
    const { request, jobFile } = await stage(directory);
    await files.writeAtomic(path.join(directory, "server-id"), "server-1");
    await files.writeAtomic(
      path.join(storeRoot(directory, "server-1"), "active.lock"),
      JSON.stringify({ jobId: request.jobId, ownerPid: 1, acquiredAt: "2026-10-25T00:00:00.000Z" }),
    );
    const running = {
      ...JSON.parse(await files.readText(jobFile, 100000)),
      state: "running",
      phase: "verifying_runtime",
    };
    await files.writeAtomic(jobFile, JSON.stringify(running));
    await files.writeAtomic(
      path.join(request.pluginDir, "package.json"),
      JSON.stringify({ name: "@mason-x/paseo-agent-team", version: "0.3.0" }),
    );
    await files.writeAtomic(
      path.join(path.dirname(jobFile), "request.json"),
      JSON.stringify(request),
    );
    await confirmPendingBoot({
      env: { PASEO_HOME: directory },
      files,
      bootId: "boot-new",
      log: () => {},
    });
    const boot = JSON.parse(
      await files.readText(path.join(storeRoot(directory, "server-1"), "boot.json"), 10000),
    );
    expect(boot.bootId).toBe("boot-new");
    expect(boot.packageVersion).toBe("0.3.0");
  });

  test("a real commit written by boot confirmation lets the runner succeed", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-team-boot-git-"));
    roots.push(directory);
    const plugin = path.join(directory, "plugin");
    const git = (args: string[], cwd = plugin) =>
      spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], {
        cwd,
        encoding: "utf8",
      });
    git(["init"], directory);
    await nodeFiles().writeAtomic(path.join(plugin, "README.md"), "fixture\n");
    git(["add", "README.md"]);
    git(["commit", "-m", "fixture"]);
    const commit = git(["rev-parse", "HEAD"]).stdout.trim();
    const { request, jobFile } = await stage(directory, {
      mode: "managed-git",
      pluginDir: plugin,
      targetSha: commit,
      targetVersion: "0.3.0",
    });
    await nodeFiles().writeAtomic(path.join(directory, "server-id"), "server-1");
    await nodeFiles().writeAtomic(
      path.join(storeRoot(directory, "server-1"), "active.lock"),
      JSON.stringify({ jobId: request.jobId, ownerPid: 1, acquiredAt: "2026-10-25T00:00:00.000Z" }),
    );
    const running = {
      ...JSON.parse(await nodeFiles().readText(jobFile, 100000)),
      state: "running",
      phase: "verifying_runtime",
    };
    await nodeFiles().writeAtomic(jobFile, JSON.stringify(running));
    await nodeFiles().writeAtomic(
      path.join(plugin, "package.json"),
      JSON.stringify({ version: "0.3.0" }),
    );
    await nodeFiles().writeAtomic(
      path.join(path.dirname(jobFile), "request.json"),
      JSON.stringify(request),
    );
    await confirmPendingBoot({
      env: { PASEO_HOME: directory, GIT_DIR: directory },
      files: nodeFiles(),
      bootId: "boot-new",
      log: () => {},
    });
    const boot = JSON.parse(
      await nodeFiles().readText(path.join(storeRoot(directory, "server-1"), "boot.json"), 10000),
    );
    expect(boot.commit).toBe(commit);
    await runRequest(request, {
      git: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      exec: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ status: "running" }),
        stderr: "",
      }),
      now: () => "2026-10-25T00:09:00.000Z",
      sleep: async () => {},
      attempts: 2,
      verifyTimeoutMs: 1_000,
      intervalMs: 10,
    });
    expect(JSON.parse(await nodeFiles().readText(jobFile, 100000)).state).toBe("succeeded");
  });

  test("boot confirmation with a different commit makes the runner fail", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-team-boot-mismatch-"));
    roots.push(directory);
    const { request, jobFile } = await stage(directory, { mode: "managed-git" });
    await nodeFiles().writeAtomic(
      path.join(storeRoot(directory, "server-1"), "boot.json"),
      JSON.stringify({ bootId: "boot-new", commit: OLD, packageVersion: "0.3.0" }),
    );
    await runRequest(request, {
      git: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      exec: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ status: "running" }),
        stderr: "",
      }),
      now: () => "2026-10-25T00:09:00.000Z",
      sleep: async () => {},
      attempts: 1,
      verifyTimeoutMs: 0,
      intervalMs: 10,
    });
    expect(JSON.parse(await nodeFiles().readText(jobFile, 100000)).error.code).toBe(
      "runtime_verify_failed",
    );
  });

  test("boot confirmation skips a quiet home and survives a broken checkout", async () => {
    const messages: string[] = [];
    await confirmPendingBoot({
      env: {},
      bootId: "boot-new",
      log: (message) => messages.push(message),
    });
    const directory = await mkdtemp(path.join(tmpdir(), "agent-team-boot-broken-"));
    roots.push(directory);
    const { request, jobFile } = await stage(directory);
    await nodeFiles().writeAtomic(path.join(directory, "server-id"), "server-1");
    await nodeFiles().writeAtomic(
      path.join(storeRoot(directory, "server-1"), "active.lock"),
      JSON.stringify({ jobId: request.jobId, ownerPid: 1, acquiredAt: "2026-10-25T00:00:00.000Z" }),
    );
    const running = {
      ...JSON.parse(await nodeFiles().readText(jobFile, 100000)),
      state: "running",
      phase: "reloading",
    };
    await nodeFiles().writeAtomic(jobFile, JSON.stringify(running));
    await nodeFiles().writeAtomic(
      path.join(path.dirname(jobFile), "request.json"),
      JSON.stringify(request),
    );
    await nodeFiles().writeAtomic(path.join(request.pluginDir, "package.json"), "{");
    await confirmPendingBoot({
      env: { PASEO_HOME: directory, GIT_DIR: directory, GIT_CONFIG_KEY_0: "remote.origin.url" },
      files: nodeFiles(),
      bootId: "boot-broken",
      log: (message) => messages.push(message),
    });
    const boot = JSON.parse(
      await nodeFiles().readText(path.join(storeRoot(directory, "server-1"), "boot.json"), 10000),
    );
    expect(boot.packageVersion).toBeNull();
    expect(boot.commit).toBeNull();
    expect(messages).toEqual([]);
    const hanging = path.join(directory, "hang.mjs");
    await nodeFiles().writeAtomic(hanging, "setTimeout(() => {}, 30_000);\n");
    const started = Date.now();
    await confirmPendingBoot({
      env: { PASEO_HOME: directory },
      files: nodeFiles(),
      bootId: "boot-timeout",
      gitPath: process.execPath,
      gitTimeoutMs: 50,
    });
    expect(Date.now() - started).toBeLessThan(8_000);
    await confirmPendingBoot({
      env: { PASEO_HOME: directory },
      files: nodeFiles(),
      bootId: "boot-missing-git",
      gitPath: path.join(directory, "missing-git"),
      log: (message) => messages.push(message),
    });
    expect(messages).toEqual([]);
  });

  test("npm resolution checks configured, Node, and PATH candidates", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-team-npm-"));
    roots.push(directory);
    const cli = path.join(directory, "npm-cli.js");
    await nodeFiles().writeAtomic(cli, "export {}\n");
    const resolved = await resolveNpmCli({
      exec: {
        async run(request) {
          return ok(
            request.args.includes(cli) ? "11.0.0\n" : "",
            request.args.includes(cli) ? 0 : 1,
          );
        },
      },
      nodePath: process.execPath,
      env: { npm_execpath: cli, PATH: directory },
      platform: "win32",
    });
    expect(resolved.ok && resolved.cli).toBe(cli);
    expect(
      (await npmCandidates(process.execPath, { PATH: "" }, "linux")).some((candidate) =>
        candidate.includes(`${path.sep}lib${path.sep}`),
      ),
    ).toBe(false);
    const missing = await resolveNpmCli({
      exec: {
        async run() {
          return ok("", 1);
        },
      },
      nodePath: process.execPath,
      env: { PATH: "" },
      platform: "win32",
    });
    expect(missing.ok).toBe(false);
  });

  test("PATH npm resolution skips missing directories and non-npm launchers", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-team-npm-path-"));
    roots.push(directory);
    const empty = path.join(directory, "empty");
    const bin = path.join(directory, "bin");
    const lib = path.join(directory, "lib", "node_modules", "npm", "bin");
    const cli = path.join(lib, "npm-cli.js");
    const pnpm = path.join(directory, "pnpm.cjs");
    await nodeFiles().writeAtomic(cli, "export {}\n");
    await nodeFiles().writeAtomic(path.join(bin, "npm"), "#!/bin/sh\n");
    await nodeFiles().writeAtomic(pnpm, "export {}\n");
    const present = new Set([cli, path.join(bin, "npm"), path.join(bin, "node"), pnpm]);
    const exists = async (candidate: string) => present.has(candidate);
    const candidates = await npmCandidates(
      path.join(bin, "node"),
      { PATH: `${empty}${path.delimiter}${bin}`, npm_execpath: pnpm },
      "linux",
      exists,
    );
    expect(candidates).toEqual([cli]);
    const electron = path.join(directory, "Paseo.exe");
    expect(
      await runtimeNode(electron, { PATH: `${empty}${path.delimiter}${bin}` }, "win32", exists),
    ).toBe(path.join(bin, "node"));
    expect(await runtimeNode(electron, { PATH: empty }, "win32", exists)).toBeNull();
    const resolved = await resolveNpmCli({
      exec: {
        async run(request) {
          return ok(
            request.file.endsWith("node") ? "11.0.0\n" : "",
            request.file.endsWith("node") ? 0 : 1,
          );
        },
      },
      nodePath: electron,
      env: { PATH: `${empty}${path.delimiter}${bin}` },
      platform: "linux",
      exists,
    });
    expect(resolved.ok && resolved.cli).toBe(cli);
    if (resolved.ok) expect(resolved.nodePath).toBe(path.join(bin, "node"));
  });

  test("a lock acquired before a missing runner is released", async () => {
    const files = seededFiles();
    files.data.delete(path.join(PLUGIN, "server", "version", "runner.mjs"));
    const versions = createVersionService(serviceDeps(files));
    const checked = await versions.check(paseo, "11111111-1111-4111-8111-111111111111");
    if (!checked.ok || !checked.job.result?.checkId) throw new Error("check failed");
    const started = await versions.startUpdate(
      paseo,
      "12345678-1234-4234-8234-123456789abc",
      checked.job.result.checkId,
    );
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.blockers[0]?.detail).toContain("active.lock");
    expect(files.data.has(path.join(storeRoot(HOME, "server-1"), "active.lock"))).toBe(false);
  });

  test("a stale lock from a dead process does not block the next update", async () => {
    const files = seededFiles();
    files.data.set(
      path.join(storeRoot(HOME, "server-1"), "active.lock"),
      JSON.stringify({
        jobId: "44444444-4444-4444-8444-444444444444",
        ownerPid: 999999,
        acquiredAt: "2026-10-25T00:00:00.000Z",
      }),
    );
    const versions = createVersionService(serviceDeps(files));
    const checked = await versions.check(paseo, "11111111-1111-4111-8111-111111111111");
    if (!checked.ok || !checked.job.result?.checkId) throw new Error("check failed");
    const started = await versions.startUpdate(
      paseo,
      "12345678-1234-4234-8234-123456789abc",
      checked.job.result.checkId,
    );
    expect(started.ok).toBe(true);
  });

  test("a failed managed update that still runs the old revision is rolled back", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-team-managed-old-"));
    roots.push(directory);
    const { request, jobFile } = await stage(directory, { mode: "managed-git" });
    await runRequest(request, {
      git: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      exec: async (_file: string, args: string[]) => ({
        exitCode: args.includes("update") ? 1 : 0,
        stdout: JSON.stringify({ status: "running", installation: { currentRevision: OLD } }),
        stderr: "update failed",
      }),
      now: () => "2026-10-25T00:04:00.000Z",
      sleep: async () => {},
      attempts: 1,
      readBoot: () => null,
    });
    expect(JSON.parse(await nodeFiles().readText(jobFile, 100000)).state).toBe("rolled_back");
  });

  test("a check that throws is failed instead of staying running", async () => {
    const deps = serviceDeps(seededFiles());
    deps.git = {
      async run(request: { args: readonly string[] }) {
        if (request.args.includes("ls-remote")) throw new Error("check timed out");
        return directoryGit().run(request);
      },
    };
    const versions = createVersionService(deps);
    const checked = await versions.check(paseo, "11111111-1111-4111-8111-111111111111");
    expect(checked.ok ? checked.job.error?.code : null).toBe("command_failed");

    const again = await versions.check(paseo, "12121212-1212-4212-8212-121212121212");
    expect(again.ok && again.job.state).toBe("failed");
  });

  test("credential URLs are stripped before a request is persisted", async () => {
    const files = seededFiles();
    const deps = serviceDeps(
      files,
      directoryGit({
        "get-url": ok("https://user:secret@github.com/Mason-x/paseo-agent-team.git"),
      }),
    );
    const versions = createVersionService(deps);
    const checked = await versions.check(paseo, "11111111-1111-4111-8111-111111111111");
    if (!checked.ok || !checked.job.result?.checkId) throw new Error("check failed");
    const started = await versions.startUpdate(
      paseo,
      "12345678-1234-4234-8234-123456789abc",
      checked.job.result.checkId,
    );
    expect(started.ok).toBe(true);
    const persisted = [...files.data.values()].join("\n");
    expect(persisted).not.toContain("secret");
    expect(persisted).toContain("https://github.com/Mason-x/paseo-agent-team.git");
  });
});

async function stage(directory: string, extra: Record<string, unknown> = {}) {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const jobId =
    typeof extra.jobId === "string" ? extra.jobId : "44444444-4444-4444-8444-444444444444";
  const jobDir = path.join(
    directory,
    "agent-team-runtime",
    "v1",
    createHash("sha256").update("server-1\0paseo-agent-team").digest("hex").slice(0, 24),
    "updates",
    "jobs",
    jobId,
  );
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(
    path.join(jobDir, "status.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: jobId,
      requestId: "55555555-5555-4555-8555-555555555555",
      kind: "update",
      state: "queued",
      phase: "preflight",
      seq: 0,
      startedAt: "2026-10-25T00:00:00.000Z",
      updatedAt: "2026-10-25T00:00:00.000Z",
      finishedAt: null,
      from: null,
      target: null,
      result: null,
      error: null,
      rollback: "not-needed",
    }),
  );
  return {
    jobFile: path.join(jobDir, "status.json"),
    request: {
      home: directory,
      serverId: "server-1",
      jobId,
      pluginDir: path.join(directory, "plugin"),
      repositoryPath: path.join(directory, "repo"),
      remoteUrl: "file:///upstream.git",
      pluginSubpath: "paseo-agent-team",
      npmCli: path.join(directory, "npm-cli.js"),
      targetRef: "refs/heads/main",
      mode: "directory" as const,
      fromCommit: OLD,
      fromVersion: "0.2.3",
      targetSha: TARGET,
      targetVersion: "0.3.0",
      oldBootId: "boot-old",
      cliEntry: path.join(directory, "cli.js"),
      nodePath: process.execPath,
      ...extra,
    },
  };
}

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { defaultPorts, main, npmCli, runRequest } from "../server/version/runner.mjs";

const OLD = "a".repeat(40);
const TARGET = "b".repeat(40);
const JOB = "44444444-4444-4444-8444-444444444444";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function stage(extra: Record<string, unknown> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-team-runner-"));
  roots.push(directory);
  const request = {
    home: directory,
    serverId: "server-1",
    jobId: JOB,
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
  };
  Object.assign(request, extra);
  const jobDir = path.join(
    directory,
    "agent-team-runtime",
    "v1",
    createHash("sha256").update("server-1\0paseo-agent-team").digest("hex").slice(0, 24),
    "updates",
    "jobs",
    JOB,
  );
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(path.join(jobDir, "status.json"), JSON.stringify(baseJob()));
  writeFileSync(
    path.join(path.dirname(path.dirname(jobDir)), "active.lock"),
    JSON.stringify({ jobId: JOB }),
  );
  return { request, jobFile: path.join(jobDir, "status.json"), directory };
}

function baseJob() {
  return {
    schemaVersion: 1,
    id: JOB,
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
  };
}

type Fake = { exitCode?: number; stdout?: string; stderr?: string };

function scripted(gitCases: Array<[string, Fake]>, execCases: Fake[] = []) {
  const gitArgs: string[][] = [];
  const execArgs: string[][] = [];
  return {
    gitArgs,
    execArgs,
    async git(args: string[]) {
      gitArgs.push(args);
      const joined = args.join(" ");
      const found = gitCases.find(([needle]) => joined.includes(needle));
      return {
        exitCode: found?.[1].exitCode ?? 0,
        stdout: found?.[1].stdout ?? "",
        stderr: found?.[1].stderr ?? "",
      };
    },
    async exec(_file: string, args: string[]) {
      execArgs.push(args);
      return (
        execCases.shift() ?? {
          exitCode: 0,
          stdout: '{"id":"paseo-agent-team","status":"running"}',
          stderr: "",
        }
      );
    },
    now: () => "2026-10-25T00:01:00.000Z",
    sleep: async () => {},
  };
}

const cleanGit: Array<[string, Fake]> = [
  ["show-toplevel", { stdout: "" }],
  ["porcelain", { stdout: "" }],
  ["abbrev-ref HEAD", { stdout: "main" }],
  ["@{upstream}", { stdout: "origin/main" }],
  ["rev-parse HEAD", { stdout: OLD }],
  ["cat-file", { exitCode: 1 }],
  ["rev-parse refs/agent-team-updates", { stdout: TARGET }],
  ["merge-base --is-ancestor a", { exitCode: 0 }],
];

describe("runner destinations", () => {
  test("fetch failure stops before merge or npm", async () => {
    const { request, jobFile } = await stage();
    const ports = scripted([...cleanGit, ["fetch", { exitCode: 128, stderr: "network" }]]);
    const git = async (args: string[]) => {
      ports.gitArgs.push(args);
      if (args.includes("--show-toplevel"))
        return { exitCode: 0, stdout: request.repositoryPath, stderr: "" };
      if (args[0] === "remote" && args[1] === undefined)
        return { exitCode: 0, stdout: "origin\n", stderr: "" };
      if (args[0] === "remote" && args[1] === "get-url")
        return { exitCode: 0, stdout: `${request.remoteUrl}\n`, stderr: "" };
      if (args[0] === "fetch") return { exitCode: 128, stdout: "", stderr: "network" };
      if (args.includes("porcelain")) return { exitCode: 0, stdout: "", stderr: "" };
      if (args.includes("--abbrev-ref") && args.includes("HEAD"))
        return { exitCode: 0, stdout: "main", stderr: "" };
      if (args.includes("@{upstream}")) return { exitCode: 0, stdout: "origin/main", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "HEAD")
        return { exitCode: 0, stdout: OLD, stderr: "" };
      if (args[0] === "cat-file") return { exitCode: 1, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await runRequest(request, { ...ports, git, attempts: 1, readBoot: () => null });
    const job = JSON.parse(await readFile(jobFile, "utf8"));
    expect(job.state).toBe("failed");
    expect(job.phase).toBe("fetching");
    expect(ports.gitArgs.some((args) => args.includes("merge") || args.includes("reset"))).toBe(
      false,
    );
    expect(ports.execArgs).toEqual([]);
  });

  test("npm ci failure rolls back only while HEAD is still the target and the tree is clean", async () => {
    const { request, jobFile } = await stage();
    let head = OLD;
    const gitArgs: string[][] = [];
    const git = async (args: string[]) => {
      gitArgs.push(args);
      if (args.includes("--show-toplevel"))
        return { exitCode: 0, stdout: request.repositoryPath, stderr: "" };
      if (args[0] === "remote" && args.length === 1)
        return { exitCode: 0, stdout: "origin\n", stderr: "" };
      if (args[0] === "remote" && args[1] === "get-url")
        return { exitCode: 0, stdout: `${request.remoteUrl}\n`, stderr: "" };
      if (args[0] === "fetch") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args[1]?.includes("refs/agent-team-updates"))
        return { exitCode: 0, stdout: TARGET, stderr: "" };
      if (args[0] === "merge-base")
        return {
          exitCode: args.includes(OLD) && args.includes(TARGET) ? 0 : 1,
          stdout: "",
          stderr: "",
        };
      if (args.includes("porcelain"))
        return { exitCode: 0, stdout: "?? node_modules/\0", stderr: "" };
      if (args.includes("--abbrev-ref") && args.includes("HEAD"))
        return { exitCode: 0, stdout: "main", stderr: "" };
      if (args.includes("@{upstream}")) return { exitCode: 0, stdout: "origin/main", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "HEAD")
        return { exitCode: 0, stdout: head, stderr: "" };
      if (args[0] === "cat-file") return { exitCode: 1, stdout: "", stderr: "" };
      if (args.includes("merge")) {
        head = TARGET;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "reset") {
        expect(args).toEqual(["reset", "--keep", OLD]);
        head = OLD;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    let npm = 0;
    const exec = async (_file: string, args: string[]) => {
      if (args.includes("ci")) {
        npm += 1;
        return npm === 1
          ? { exitCode: 1, stdout: "", stderr: "lock mismatch" }
          : { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args.includes("reload"))
        return { exitCode: 0, stdout: '{"status":"running"}', stderr: "" };
      return {
        exitCode: 0,
        stdout: JSON.stringify({ status: "running", installation: { currentRevision: OLD } }),
        stderr: "",
      };
    };
    await runRequest(request, {
      git,
      exec,
      now: () => "2026-10-25T00:01:00.000Z",
      sleep: async () => {},
      attempts: 1,
      readBoot: () => ({ bootId: "boot-new", commit: OLD, packageVersion: "0.2.3" }),
    });
    const job = JSON.parse(await readFile(jobFile, "utf8"));
    expect(job.state).toBe("rolled_back");
    expect(job.rollback).toBe("restored");
    expect(
      gitArgs.some(
        (args) => args.includes("--hard") || args.includes("stash") || args.includes("--force"),
      ),
    ).toBe(false);
  });

  test("rollback refuses when the worktree changed after the fast-forward", async () => {
    const { request, jobFile } = await stage();
    let head = OLD;
    const git = async (args: string[]) => {
      if (args[0] === "remote" && args.length === 1)
        return { exitCode: 0, stdout: "origin\n", stderr: "" };
      if (args[0] === "remote" && args[1] === "get-url")
        return { exitCode: 0, stdout: `${request.remoteUrl}\n`, stderr: "" };
      if (args.includes("--show-toplevel"))
        return { exitCode: 0, stdout: request.repositoryPath, stderr: "" };
      if (args[0] === "fetch" || args[0] === "merge") {
        if (args[0] === "merge") head = TARGET;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse" && String(args[1]).includes("refs/agent-team-updates"))
        return { exitCode: 0, stdout: TARGET, stderr: "" };
      if (args[0] === "merge-base") return { exitCode: 0, stdout: "", stderr: "" };
      if (args.includes("porcelain"))
        return {
          exitCode: 0,
          stdout: args.includes("HEAD") && head === TARGET ? "?? user.txt\0" : "",
          stderr: "",
        };
      if (args.includes("--abbrev-ref") && args.includes("HEAD"))
        return { exitCode: 0, stdout: "main", stderr: "" };
      if (args.includes("@{upstream}")) return { exitCode: 0, stdout: "origin/main", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "HEAD")
        return { exitCode: 0, stdout: head, stderr: "" };
      if (args[0] === "cat-file") return { exitCode: 1, stdout: "", stderr: "" };
      if (args[0] === "reset") throw new Error("reset must not run");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await runRequest(request, {
      git,
      exec: async () => ({ exitCode: 1, stdout: "", stderr: "npm failed" }),
      now: () => "2026-10-25T00:01:00.000Z",
      sleep: async () => {},
      attempts: 1,
      readBoot: () => null,
    });
    const job = JSON.parse(await readFile(jobFile, "utf8"));
    expect(job.state).toBe("recovery_required");
    expect(job.error.code).toBe("concurrent_local_change");
  });

  test("the process entry and default git runner execute against a temporary repository", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-team-real-"));
    roots.push(directory);
    const repo = path.join(directory, "repo");
    mkdirSync(repo);
    const git = (args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    git(["init"]);
    writeFileSync(path.join(repo, "README.md"), "fixture\n");
    git(["add", "README.md"]);
    git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "fixture"]);
    const ports = defaultPorts({});
    const status = await ports.git(["status", "--porcelain"], repo, 20_000);
    expect(status.exitCode).toBe(0);
    const missing = await ports.exec("definitely-missing-binary", ["--version"], {
      timeoutMs: 1000,
    });
    expect(missing.exitCode).toBe(127);
    const request = path.join(directory, "request.json");
    writeFileSync(request, JSON.stringify({ home: directory, serverId: "missing", jobId: JOB }));
    const entry = spawnSync(process.execPath, ["server/version/runner.mjs", "--request", request], {
      cwd: path.resolve("."),
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(entry.status).not.toBe(0);
    const self = spawnSync(process.execPath, ["server/version/runner.mjs", "--self-test"], {
      cwd: path.resolve("."),
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(self.stdout).toContain("ok");
  }, 30_000);

  test("managed success stops in the succeeded state", async () => {
    const managed = await stage({ mode: "managed-git" });
    await runRequest(managed.request, {
      git: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      exec: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ status: "running" }),
        stderr: "",
      }),
      now: () => "2026-10-25T00:05:00.000Z",
      sleep: async () => {},
      attempts: 1,
      readBoot: () => ({ bootId: "boot-new", commit: TARGET, packageVersion: "0.3.0" }),
    });
    const managedJob = JSON.parse(readFileSync(managed.jobFile, "utf8"));
    expect(managedJob.error?.code ?? managedJob.state).toBe("succeeded");
  });

  test("a missing npm stops on npm_missing", async () => {
    const noNpm = await stage({ npmCli: "" });
    let head: string = OLD;
    await runRequest(noNpm.request, {
      git: async (args: string[]) => {
        if (args.includes("merge")) head = TARGET;
        if (args[0] === "remote" && args.length === 1)
          return { exitCode: 0, stdout: "origin\n", stderr: "" };
        if (args[0] === "remote")
          return { exitCode: 0, stdout: `${noNpm.request.remoteUrl}\n`, stderr: "" };
        if (args.includes("--show-toplevel"))
          return { exitCode: 0, stdout: noNpm.request.repositoryPath ?? "", stderr: "" };
        if (args.includes("porcelain") || args[0] === "fetch")
          return { exitCode: 0, stdout: "", stderr: "" };
        if (args.includes("--abbrev-ref") && args.includes("HEAD") && !args.includes("@{upstream}"))
          return { exitCode: 0, stdout: "main", stderr: "" };
        if (args.includes("@{upstream}")) return { exitCode: 0, stdout: "origin/main", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "HEAD")
          return { exitCode: 0, stdout: head, stderr: "" };
        if (args[0] === "rev-parse" && String(args[1]).includes("refs/agent-team-updates"))
          return { exitCode: 0, stdout: TARGET, stderr: "" };
        if (args[0] === "merge-base") return { exitCode: 0, stdout: "", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      now: () => "2026-10-25T00:05:00.000Z",
      sleep: async () => {},
      attempts: 1,
      readBoot: () => null,
    });
    expect(JSON.parse(readFileSync(noNpm.jobFile, "utf8")).error.code).toBe("npm_missing");
    expect(npmCli(process.execPath)).toContain("npm-cli.js");
  });

  test("an unsafe checkout target stops on unsupported_checkout", async () => {
    const unsafe = await stage({ targetRef: "refs/heads/../escape" });
    await runRequest(unsafe.request, {
      git: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      exec: async () => ({ exitCode: 0, stdout: "not-json", stderr: "" }),
      now: () => "2026-10-25T00:06:00.000Z",
      sleep: async () => {},
      attempts: 1,
      readBoot: () => null,
    });
    expect(JSON.parse(readFileSync(unsafe.jobFile, "utf8")).error.code).toBe(
      "unsupported_checkout",
    );
  });

  test("a throwing git runner needs recovery", async () => {
    const thrown = await stage({});
    await runRequest(thrown.request, {
      git: async () => {
        throw new Error("git exploded");
      },
      now: () => "2026-10-25T00:07:00.000Z",
      sleep: async () => {},
      attempts: 1,
      readBoot: () => null,
    });
    expect(JSON.parse(readFileSync(thrown.jobFile, "utf8")).state).toBe("recovery_required");
  });

  test("a detached HEAD stops on detached_head", async () => {
    const detached = await stage({});
    await runRequest(detached.request, {
      git: async (args: string[]) => {
        if (args.includes("--show-toplevel"))
          return { exitCode: 0, stdout: detached.request.repositoryPath, stderr: "" };
        if (args.includes("porcelain")) return { exitCode: 0, stdout: "", stderr: "" };
        if (args.includes("--abbrev-ref") && args.includes("HEAD"))
          return { exitCode: 0, stdout: "HEAD", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      now: () => "2026-10-25T00:08:00.000Z",
      sleep: async () => {},
      attempts: 1,
      readBoot: () => null,
    });
    expect(JSON.parse(readFileSync(detached.jobFile, "utf8")).error.code).toBe("detached_head");
  });

  test("the CLI entry reports request-path mistakes", async () => {
    const io = { stdout: { write: () => {} }, stderr: { write: () => {} } };
    expect(await main(["--request"], io)).toBe(2);
    expect(await main(["--request", path.join(tmpdir(), "missing-request.json")], io)).toBe(1);
  });
});

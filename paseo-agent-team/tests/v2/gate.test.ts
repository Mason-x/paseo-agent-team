import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGateRunner,
  failureReport,
  globToRegExp,
  policyViolations,
  runGate,
  tailLines,
} from "../../v2/server/gate";
import type { GateCommand, Run } from "../../v2/shared/run";
import { makeRun } from "./fixtures";
import { commit, tempRepo, write } from "./repo";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function setup(commands: GateCommand[], patch: Partial<Run["task"]> = {}) {
  const r = tempRepo();
  cleanups.push(r.cleanup);
  const wt = r.worktree("writer", "team/r-20261112-0001/writer");
  const run = makeRun({
    workspace: { id: "ws", path: wt, branch: "team/r-20261112-0001/writer" },
    repo: { sourceCheckout: r.dir, baseRef: "main", baseSha: r.base },
    task: {
      file: ".team/task.md",
      gateCommands: commands,
      protectedPaths: ["tests/**", ".github/**"],
      env: {},
      ...patch,
    },
  });
  return { r, wt, run, sha: commit(wt, "src/a.ts", "export const a = 1;\n") };
}
const cmd = (name: string, command: string, timeoutSec = 30): GateCommand => ({
  name,
  command,
  timeoutSec,
});

describe("glob matching", () => {
  it("handles **, *, ? and trailing-slash directories", () => {
    expect(globToRegExp("tests/**").test("tests/a/b.ts")).toBe(true);
    expect(globToRegExp("tests/**").test("src/tests/a.ts")).toBe(false);
    expect(globToRegExp("**/*.test.ts").test("src/x/a.test.ts")).toBe(true);
    expect(globToRegExp("**/*.test.ts").test("a.test.ts")).toBe(true);
    expect(globToRegExp("*.json").test("a/b.json")).toBe(false);
    expect(globToRegExp("paseo-team.json").test("paseo-team.json")).toBe(true);
    expect(globToRegExp("paseo-team.json").test("paseo-team-json")).toBe(false);
    expect(globToRegExp(".github/").test(".github/workflows/ci.yml")).toBe(true);
  });

  it("policyViolations flags protected paths and paths outside the allow-list", () => {
    expect(policyViolations(["src/a.ts", "tests/a.ts"], ["tests/**"])).toEqual([
      "protected path changed: tests/a.ts",
    ]);
    expect(policyViolations(["src/a.ts", "docs/x.md"], [], ["src/**"])).toEqual([
      "outside allowed paths: docs/x.md",
    ]);
  });
});

describe("runGate", () => {
  it("passes when every command exits 0, and keeps the full output", async () => {
    const { run, sha, wt } = setup([
      cmd("build", "echo built"),
      cmd("test", "echo ok && echo more"),
    ]);
    const a = await runGate(run, 1, sha);
    expect(a.result).toBe("pass");
    expect(a.checks.map((c) => c.exitCode)).toEqual([0, 0]);
    expect(readFileSync(path.join(wt, ".team/gate/1/test.log"), "utf8")).toBe("ok\nmore\n");
  });

  it("runs every command after a failure so the writer sees all problems (AC2)", async () => {
    const { run, sha, wt } = setup([
      cmd("lint", "echo lint-problem >&2; exit 3"),
      cmd("test", "echo second"),
    ]);
    const a = await runGate(run, 1, sha);
    expect(a.result).toBe("fail");
    expect(a.checks.map((c) => c.exitCode)).toEqual([3, 0]);
    const report = await failureReport(run, a);
    const log = readFileSync(path.join(wt, ".team/gate/1/lint.log"), "utf8");
    expect(log).toBe("lint-problem\n");
    expect(report).toContain("lint-problem");
    expect(report).toContain(".team/gate/1/lint.log");
    expect(report).not.toContain("second");
  });

  it("kills a command that exceeds its timeout and records no exit code", async () => {
    const { run, sha, wt } = setup([cmd("slow", "sleep 10", 1)]);
    const started = Date.now();
    const a = await runGate(run, 1, sha);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(a.result).toBe("fail");
    expect(a.checks[0]?.exitCode).toBeNull();
    expect(readFileSync(path.join(wt, ".team/gate/1/slow.log"), "utf8")).toContain(
      "timed out after 1s",
    );
  });

  it("fails and names the files when a protected path was changed (AC3)", async () => {
    const { run, wt } = setup([cmd("test", "echo ran")]);
    const sha = commit(wt, "tests/a.test.ts", "weakened");
    const a = await runGate(run, 1, sha);
    expect(a.result).toBe("fail");
    expect(a.policyViolations).toEqual(["protected path changed: tests/a.test.ts"]);
    expect(a.checks).toHaveLength(1); // commands still ran
    expect(await failureReport(run, a)).toContain("tests/a.test.ts");
  });

  it("enforces allowedPaths when set", async () => {
    const { run, wt } = setup([cmd("t", "true")], { allowedPaths: ["src/**"] });
    const sha = commit(wt, "docs/x.md", "x");
    expect((await runGate(run, 1, sha)).policyViolations).toContain(
      "outside allowed paths: docs/x.md",
    );
  });

  it("runs the frozen commands even if task.md was rewritten (AC4)", async () => {
    const { run, sha, wt } = setup([cmd("test", "echo frozen")]);
    write(wt, ".team/task.md", "## 怎么验证\n\n`echo hacked`\n");
    const a = await runGate(run, 1, sha);
    expect(readFileSync(path.join(wt, a.checks[0]?.logFile as string), "utf8")).toBe("frozen\n");
  });

  it("returns an error attempt when HEAD moved or the tree is dirty", async () => {
    const { run, sha, wt } = setup([cmd("t", "true")]);
    write(wt, "scratch.txt", "x");
    const dirty = await runGate(run, 1, sha);
    expect(dirty).toMatchObject({ result: "error" });
    expect(dirty.error).toContain("scratch.txt");
    const moved = commit(wt, "b.ts", "b");
    const stale = await runGate(run, 2, sha);
    expect(stale.result).toBe("error");
    expect(stale.error).toContain(moved.slice(0, 8));
  });

  it("truncates huge output but keeps the tail readable", async () => {
    const { run, sha, wt } = setup([cmd("noisy", "yes line | head -c 100000; echo; exit 1")]);
    const a = await runGate(run, 1, sha, { maxLogBytes: 2000 });
    const file = path.join(wt, a.checks[0]?.logFile as string);
    expect(statSync(file).size).toBeLessThan(2200);
    expect(await tailLines(file, 3)).toContain("[output truncated at 2000 bytes]");
  });

  it("expands {runId} and {seat} in env templates", async () => {
    const { run, sha, wt } = setup([cmd("env", 'echo "$DB/$PASEO_TEAM_SEAT"')], {
      env: { DB: "app_{runId}_{seat}" },
    });
    const a = await runGate(run, 1, sha);
    expect(readFileSync(path.join(wt, a.checks[0]?.logFile as string), "utf8")).toBe(
      "app_r-20261112-0001_writer/writer\n",
    );
  });

  it("tailLines returns only the last lines", async () => {
    const { wt } = setup([]);
    write(wt, "big.log", Array.from({ length: 500 }, (_, i) => `l${i}`).join("\n"));
    const t = await tailLines(path.join(wt, "big.log"), 80);
    expect(t.split("\n")).toHaveLength(80);
    expect(t.endsWith("l499")).toBe(true);
  });
});

describe("createGateRunner", () => {
  it("runs one gate at a time and reports which Runs are running", async () => {
    const a = setup([
      cmd("t", "echo a-start >> ../order.txt; sleep 1; echo a-end >> ../order.txt"),
    ]);
    const b = setup([
      cmd("t", "echo b-start >> ../order.txt; sleep 0.2; echo b-end >> ../order.txt"),
    ]);
    const runner = createGateRunner();
    const first = runner.run(a.run, 1, a.sha);
    const second = runner.run({ ...b.run, id: "r-other" }, 1, b.sha);
    expect(runner.isRunning(a.run.id)).toBe(true);
    expect(runner.isRunning("r-other")).toBe(true);
    await Promise.all([first, second]);
    expect(runner.isRunning(a.run.id)).toBe(false);
    // each gate wrote into its own parent dir; the serial order shows in timestamps
    const aEnd = statSync(path.join(a.r.root, "order.txt")).mtimeMs;
    const bStart = statSync(path.join(b.r.root, "order.txt")).birthtimeMs;
    expect(bStart).toBeGreaterThanOrEqual(aEnd - 5);
  });

  it("stopAll terminates a running command", async () => {
    const a = setup([cmd("t", "sleep 30", 60)]);
    const runner = createGateRunner();
    const job = runner.run(a.run, 1, a.sha);
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    runner.stopAll();
    await expect(job).rejects.toThrow("gate stopped"); // never reported as a failed attempt
    expect(Date.now() - started).toBeLessThan(5000);
    expect(runner.isRunning(a.run.id)).toBe(false);
  });
});

import { describe, expect, test } from "vitest";
import {
  bucketOf,
  buildRunRows,
  filterCounts,
  filterRows,
  isLive,
  runTask,
  runTimeLabel,
  taskFromTitle,
} from "../shared/domain/run-list";
import type { RunAgentSnapshot, TeamRun } from "../shared/domain/run-progress";
import { runProgress, visibleCountStates } from "../shared/domain/run-progress";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function agent(id: string, overrides: Partial<RunAgentSnapshot> = {}): RunAgentSnapshot {
  return {
    id,
    title: id,
    provider: "claude",
    model: null,
    status: "idle",
    createdAt: iso(DAY),
    updatedAt: iso(DAY),
    ...overrides,
  };
}

const finished = { lastUsage: { inputTokens: 1 }, attentionTimestamp: iso(DAY) };

/** One run per phase, started `startedAgo` ms before NOW. */
function run(runId: string, phase: string, startedAgo = HOUR): TeamRun {
  const coordinator = {
    running: agent("c", { status: "running", lastUserMessageAt: iso(startedAgo) }),
    starting: agent("c", { status: "idle" }),
    attention: agent("c", { status: "running", pendingPermissions: [{}] }),
    failed: agent("c", { status: "error" }),
    done: agent("c", { status: "idle", ...finished }),
    closed: agent("c", { status: "closed" }),
  }[phase];
  return {
    runId,
    teamName: "Team",
    coordinator,
    members: [agent("m", { ...finished })],
    startedAt: iso(startedAgo),
    lastActivityAt: iso(startedAgo),
  };
}

describe("run buckets", () => {
  test("every phase belongs to exactly one bucket", () => {
    expect(bucketOf("needs-you")).toBe("attention");
    expect(bucketOf("failed")).toBe("attention");
    expect(bucketOf("starting")).toBe("active");
    expect(bucketOf("running")).toBe("active");
    expect(bucketOf("done")).toBe("ended");
    expect(bucketOf("idle")).toBe("ended");
  });

  test("only ended runs are not live", () => {
    expect(isLive("running")).toBe(true);
    expect(isLive("needs-you")).toBe(true);
    expect(isLive("done")).toBe(false);
    expect(isLive("idle")).toBe(false);
  });
});

describe("buildRunRows", () => {
  const runs = [
    run("old-done", "done", 30 * DAY),
    run("new-done", "done", DAY),
    run("running", "running", 2 * HOUR),
    run("needs", "attention", 5 * HOUR),
    run("closed", "closed", 3 * DAY),
  ];

  test("puts what needs a person first, then live runs, then history newest first", () => {
    expect(buildRunRows(runs).map((row) => row.run.runId)).toEqual([
      "needs",
      "running",
      "new-done",
      "closed",
      "old-done",
    ]);
  });

  test("filters and counts by bucket", () => {
    const rows = buildRunRows(runs);
    expect(filterCounts(rows)).toEqual({ all: 5, attention: 1, active: 1, ended: 3 });
    expect(filterRows(rows, "ended").map((row) => row.run.runId)).toEqual([
      "new-done",
      "closed",
      "old-done",
    ]);
    expect(filterRows(rows, "all")).toHaveLength(5);
    expect(filterRows(rows, "attention")).toHaveLength(1);
  });

  test("does not reorder the runs it was given", () => {
    const input = [...runs];
    buildRunRows(input);
    expect(input.map((entry) => entry.runId)).toEqual(runs.map((entry) => entry.runId));
  });
});

describe("runTimeLabel", () => {
  test("a live run says how long it has been running", () => {
    expect(runTimeLabel(run("r", "running", 5 * MIN), "running", NOW)).toBe("已运行 5 分钟");
    expect(runTimeLabel(run("r", "running", 3 * HOUR), "running", NOW)).toBe("已运行 3 小时");
    expect(runTimeLabel(run("r", "attention", 2 * DAY), "needs-you", NOW)).toBe("已运行 2 天");
    expect(runTimeLabel(run("r", "starting", 10_000), "starting", NOW)).toBe("刚刚启动");
  });

  test("a finished run says when it finished, never that it 'ran' for days", () => {
    const old = { ...run("r", "done", 30 * DAY), lastActivityAt: iso(28 * DAY) };
    expect(runTimeLabel(old, "done", NOW)).toBe("28 天前完成");
    expect(runTimeLabel(run("r", "closed", 2 * HOUR), "idle", NOW)).toBe("2 小时前结束");
    expect(runTimeLabel(run("r", "done", 10_000), "done", NOW)).toBe("刚刚完成");
    expect(runTimeLabel(run("r", "closed", 10_000), "idle", NOW)).toBe("刚刚结束");
  });

  test("unreadable timestamps and clock skew degrade quietly", () => {
    const broken = { ...run("r", "running"), startedAt: "", lastActivityAt: "" };
    expect(runTimeLabel(broken, "running", NOW)).toBe("刚刚启动");
    expect(runTimeLabel(broken, "done", NOW)).toBe("刚刚完成");
    expect(runTimeLabel(run("r", "running", -HOUR), "running", NOW)).toBe("刚刚启动");
  });
});

describe("runTask", () => {
  const legacy = [
    {
      runId: "old",
      teamId: "t",
      teamName: "T",
      workspaceId: "w",
      coordinatorAgentId: "c",
      memberAgentIds: [],
      taskExcerpt: "From preferences",
      createdAt: iso(DAY),
    },
  ];

  test("prefers the label on the coordinator, then falls back to saved preferences", () => {
    expect(runTask({ ...run("old", "done"), task: "From label" }, legacy)).toBe("From label");
    expect(runTask(run("old", "done"), legacy)).toBe("From preferences");
    expect(runTask(run("unknown", "done"), legacy)).toBeUndefined();
  });

  test("last resort: the start of the task in the coordinator's name", () => {
    const named = run("unknown", "done");
    if (named.coordinator)
      named.coordinator.title = "[Team] 视频制作团队: 执行 test12 视频制作运行。ES 项目 426d927";
    expect(runTask(named, legacy)).toBe("执行 test12 视频制作运行。ES 项目 426d927");
    expect(runTask({ ...named, task: "From label" }, legacy)).toBe("From label");
  });
});

describe("taskFromTitle", () => {
  test("reads the task after the team name, with either colon", () => {
    expect(taskFromTitle("[Team] Coding Team: Add Stripe")).toBe("Add Stripe");
    expect(taskFromTitle("[Team] 编码团队：添加支付")).toBe("添加支付");
    expect(taskFromTitle("[Team] Team: keep: later colons")).toBe("keep: later colons");
  });

  test("ignores titles that are not a launch coordinator's", () => {
    for (const title of [
      undefined,
      null,
      "",
      "Architect · Coding Team",
      "[Team] Team:",
      "[Team] Team:   ",
    ]) {
      expect(taskFromTitle(title)).toBeUndefined();
    }
  });
});

describe("member counts on a run header", () => {
  const counts = (phase: string) => {
    const progress = runProgress({
      coordinator: run("r", phase).coordinator,
      members: [agent("a", finished), agent("b"), agent("c", { status: "closed" })],
    });
    return visibleCountStates(progress);
  };

  test("a live run lists members still waiting for work", () => {
    expect(counts("running")).toEqual(["delivered", "not-started", "closed"]);
  });

  test("a finished run leaves out members that never got work", () => {
    expect(counts("done")).toEqual(["delivered", "closed"]);
  });
});

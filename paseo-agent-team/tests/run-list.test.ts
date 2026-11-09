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
import { zh } from "../shared/zh";

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

  test("an idle coordinator with a failed member needs attention and sorts first", () => {
    const memberFailed: TeamRun = {
      runId: "member-failed",
      teamName: "Team",
      coordinator: agent("c", { status: "idle", ...finished }),
      members: [agent("m", { status: "error", ...finished })],
      startedAt: iso(HOUR),
      lastActivityAt: iso(HOUR),
    };
    const rows = buildRunRows([run("done", "done", 2 * HOUR), memberFailed]);
    expect(rows.map((row) => row.run.runId)).toEqual(["member-failed", "done"]);
    expect(rows[0]?.progress.phase).toBe("needs-you");
    expect(filterCounts(rows)).toEqual({ all: 2, attention: 1, active: 0, ended: 1 });
    expect(filterRows(rows, "attention").map((row) => row.run.runId)).toEqual(["member-failed"]);
    expect(filterRows(rows, "ended").map((row) => row.run.runId)).toEqual(["done"]);
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

/**
 * An Engine Run is also launched with agent labels, so the label-derived list finds it too and,
 * from the coordinator alone (idle between wake-ups), calls it "done". The ledger knows better:
 * its lifecycle wins for any Run the Engine list names. Failure modes: a blocked active Run counted
 * as ended, a cancelled Run called completed, an unknown lifecycle passed off as success.
 */
describe("Engine lifecycle over agent state", () => {
  /** What the label-derived list sees for every Engine Run: an idle coordinator whose turn is over. */
  const looksDone = () => run("run-e", "done", 2 * HOUR);
  const engine = (lifecycle: string, needsAttention = false) => [
    { runId: "run-e", lifecycle, needsAttention },
  ];
  const phaseOf = (lifecycle: string, needsAttention = false) =>
    buildRunRows([looksDone()], engine(lifecycle, needsAttention))[0]?.progress.phase;

  test("the agent-only reading of an Engine Run is 'done' (the defect this guards)", () => {
    expect(buildRunRows([looksDone()])[0]?.progress.phase).toBe("done");
  });

  test("active with a blocked task or open decision is not done and not ended", () => {
    const rows = buildRunRows([looksDone()], engine("active", true));
    expect(rows[0]?.progress.phase).toBe("needs-you");
    expect(filterCounts(rows)).toEqual({ all: 1, attention: 1, active: 0, ended: 0 });
    expect(filterRows(rows, "ended")).toEqual([]);
    expect(isLive("needs-you")).toBe(true);
    expect(runTimeLabel(rows[0]?.run ?? looksDone(), "needs-you", NOW)).toContain("已运行");
  });

  test("active with nothing to answer is running, in the active bucket", () => {
    const rows = buildRunRows([looksDone()], engine("active"));
    expect(rows[0]?.progress.phase).toBe("running");
    expect(filterCounts(rows)).toEqual({ all: 1, attention: 0, active: 1, ended: 0 });
  });

  test("cancelled is its own phase: ended, labelled as cancelled, never as completed", () => {
    expect(phaseOf("cancelled")).toBe("cancelled");
    expect(bucketOf("cancelled")).toBe("ended");
    expect(isLive("cancelled")).toBe(false);
    expect(zh.phaseCancelled).toBe("已取消");
    expect(zh.phaseCancelled).not.toBe(zh.phaseDone);
    expect(zh.phaseCancelled).not.toBe(zh.phaseIdle);
    const cancelled = { ...looksDone(), lastActivityAt: iso(3 * HOUR) };
    expect(runTimeLabel(cancelled, "cancelled", NOW)).toBe("3 小时前取消");
    expect(runTimeLabel({ ...cancelled, lastActivityAt: iso(10_000) }, "cancelled", NOW)).toBe(
      "刚刚取消",
    );
    expect(runTimeLabel(cancelled, "cancelled", NOW)).not.toContain("完成");
  });

  test("only a finished lifecycle is done", () => {
    expect(phaseOf("finished")).toBe("done");
    // A finished Run the agents still show working is still finished: the ledger wins.
    const working = { ...looksDone(), coordinator: agent("c", { status: "running" }) };
    expect(buildRunRows([working], engine("finished"))[0]?.progress.phase).toBe("done");
  });

  test("the other lifecycles map to what a person can do about them", () => {
    expect(phaseOf("bootstrapping")).toBe("starting");
    expect(phaseOf("awaiting-dag")).toBe("running");
    // Paused waits for a person to resume it, whether or not anything is blocked.
    expect(phaseOf("paused")).toBe("needs-you");
    expect(phaseOf("paused", true)).toBe("needs-you");
  });

  test("an unknown lifecycle never reads as completed: done falls back to the general 'ended'", () => {
    expect(phaseOf("archived-v9")).toBe("idle");
    expect(phaseOf("")).toBe("idle");
    // A state the agents show as live stays live; only the claim of success is withheld.
    const working = { ...looksDone(), coordinator: agent("c", { status: "running" }) };
    expect(buildRunRows([working], engine("archived-v9"))[0]?.progress.phase).toBe("running");
  });

  test("a Run the Engine does not list keeps its agent-derived phase", () => {
    const rows = buildRunRows(
      [looksDone(), run("run-chain", "done", HOUR)],
      engine("active", true),
    );
    expect(rows.find((row) => row.run.runId === "run-chain")?.progress.phase).toBe("done");
    expect(buildRunRows([run("run-chain", "done", HOUR)], [])[0]?.progress.phase).toBe("done");
  });

  test("rows are re-sorted by the ledger's phase: the blocked Run comes before older finished ones", () => {
    const rows = buildRunRows(
      [run("older-done", "done", 5 * HOUR), looksDone(), run("newer-done", "done", HOUR)],
      engine("active", true),
    );
    expect(rows.map((row) => row.run.runId)).toEqual(["run-e", "newer-done", "older-done"]);
  });

  test("the member counts of a cancelled Run leave out members that never got work", () => {
    const progress = runProgress({
      coordinator: looksDone().coordinator,
      members: [agent("a", finished), agent("b")],
    });
    expect(visibleCountStates({ ...progress, phase: "cancelled" })).toEqual(["delivered"]);
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

/**
 * The first paint of the Runs page: the Engine list has not answered yet, so no Run is known to be an
 * Engine Run, and a Run whose agents look finished would be shown as completed until the answer
 * arrives (a blocked or cancelled Run for a moment as a success). Failure modes: that claim of success
 * on the first paint, a loading mark that never goes away, one that hides a failed query.
 */
describe("a Run that looks finished before the Engine list has answered", () => {
  const looksDone = () => run("run-e", "done", 2 * HOUR);
  const running = () => run("run-r", "running", HOUR);
  const needsYou = () => run("run-n", "attention", HOUR);
  const standing = (lifecycle: string, needsAttention = false) => [
    { runId: "run-e", lifecycle, needsAttention },
  ];
  const phases = (rows: ReturnType<typeof buildRunRows>) =>
    Object.fromEntries(rows.map((row) => [row.run.runId, row.progress.phase]));

  test("pending (no data, no error): shown as reading, not completed; every other reading is untouched", () => {
    const rows = buildRunRows([looksDone(), running(), needsYou()], [], "pending");
    expect(phases(rows)).toEqual({ "run-e": "loading", "run-r": "running", "run-n": "needs-you" });
    expect(zh.phaseLoading).toBe("读取中");
    expect(zh.phaseLoading).not.toBe(zh.phaseDone);
    // Nothing is claimed about how it ended: ended bucket as before, no follow-up, no "completed" in its age.
    expect(bucketOf("loading")).toBe("ended");
    expect(isLive("loading")).toBe(false);
    const label = runTimeLabel(
      rows.find((row) => row.run.runId === "run-e")?.run ?? looksDone(),
      "loading",
      NOW,
    );
    expect(label).toBe("2 小时前有活动");
    expect(label).not.toContain("完成");
    expect(label).not.toContain("结束");
    expect(filterCounts(rows)).toEqual({ all: 3, attention: 1, active: 1, ended: 1 });
  });

  test("pending with the other readings that already are not 'completed': nothing is changed", () => {
    expect(phases(buildRunRows([run("run-c", "closed")], [], "pending"))).toEqual({
      "run-c": "idle",
    });
  });

  test("answered (ready): the ledger's lifecycle decides, and a Run the list does not name keeps its reading", () => {
    expect(phases(buildRunRows([looksDone()], standing("active", true), "ready"))).toEqual({
      "run-e": "needs-you",
    });
    expect(phases(buildRunRows([looksDone()], standing("cancelled"), "ready"))).toEqual({
      "run-e": "cancelled",
    });
    // A Run only the agents know about, once the Engine has answered, is what its agents say: done.
    expect(phases(buildRunRows([looksDone()], [], "ready"))).toEqual({ "run-e": "done" });
    // The default is "answered": callers that never pass a status see the reading they always did.
    expect(phases(buildRunRows([looksDone()]))).toEqual({ "run-e": "done" });
  });

  test("failed (the query gave an error): back to the agents' reading, not loading for ever", () => {
    expect(phases(buildRunRows([looksDone(), running()], [], "error"))).toEqual({
      "run-e": "done",
      "run-r": "running",
    });
  });
});

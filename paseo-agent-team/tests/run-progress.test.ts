import { describe, expect, test } from "vitest";
import { buildRunRows, filterRows, showsFollowUp } from "../shared/domain/run-list";
import {
  digestCacheKey,
  digestTimeline,
  excerpt,
  groupTeamRuns,
  hasRun,
  memberState,
  type RunAgentSnapshot,
  runProgress,
} from "../shared/domain/run-progress";
import { LABELS } from "../shared/paseo/labels";

const T0 = "2026-10-01T10:00:00.000Z";
const T1 = "2026-10-01T10:05:00.000Z";
const T2 = "2026-10-01T10:10:00.000Z";

function agent(id: string, overrides: Partial<RunAgentSnapshot> = {}): RunAgentSnapshot {
  return {
    id,
    title: id,
    provider: "claude",
    model: "opus",
    status: "idle",
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

const coordinatorLabels = (runId = "run-1") => ({
  [LABELS.run]: runId,
  [LABELS.kind]: "coordinator",
  [LABELS.team]: "coding-team",
  [LABELS.teamName]: "Coding Team",
  [LABELS.task]: "Add Stripe",
});
const memberLabels = (runId = "run-1") => ({ [LABELS.run]: runId, [LABELS.kind]: "member" });

describe("memberState", () => {
  test("a pending permission outranks everything else", () => {
    expect(memberState(agent("a", { status: "running", pendingPermissions: [{}] }))).toBe(
      "needs-input",
    );
    expect(memberState(agent("a", { attentionReason: "permission" }))).toBe("needs-input");
    expect(
      memberState(
        agent("a", { status: "idle", attentionReason: "error", pendingPermissions: [{}] }),
      ),
    ).toBe("needs-input");
  });

  test("maps lifecycle states", () => {
    expect(memberState(agent("a", { status: "error" }))).toBe("failed");
    expect(memberState(agent("a", { status: "running" }))).toBe("working");
    expect(memberState(agent("a", { status: "closed" }))).toBe("closed");
  });

  test("a new member is not started until it receives a prompt", () => {
    expect(memberState(agent("a", { status: "initializing" }))).toBe("not-started");
    expect(memberState(agent("a", { status: "initializing", lastUserMessageAt: T1 }))).toBe(
      "working",
    );
    expect(memberState(agent("a"))).toBe("not-started");
  });

  test("an idle member that was prompted has delivered", () => {
    expect(memberState(agent("a", { lastUserMessageAt: T1 }))).toBe("delivered");
  });

  // Members are prompted by the coordinator's send_agent_prompt, which Paseo records as an
  // agent message: lastUserMessageAt stays null, but the finished turn leaves usage behind.
  test("a member that only took a prompt from another agent still counts as delivered", () => {
    const promptedByAgent = agent("a", {
      lastUserMessageAt: null,
      lastUsage: { inputTokens: 12 },
      attentionTimestamp: T1,
      attentionReason: "finished",
    });
    expect(memberState(promptedByAgent)).toBe("delivered");
    expect(memberState({ ...promptedByAgent, status: "running" })).toBe("working");
    expect(memberState({ ...promptedByAgent, status: "initializing" })).toBe("working");
  });

  test("a freshly created member has never run", () => {
    const fresh = agent("a", {
      lastUserMessageAt: null,
      lastUsage: undefined,
      attentionTimestamp: null,
      attentionReason: null,
      requiresAttention: false,
    });
    expect(hasRun(fresh)).toBe(false);
    expect(memberState(fresh)).toBe("not-started");
  });

  test("any single sign of a finished or prompted turn counts as having run", () => {
    expect(hasRun(agent("a", { lastUserMessageAt: T1 }))).toBe(true);
    expect(hasRun(agent("a", { lastUsage: { outputTokens: 1 } }))).toBe(true);
    expect(hasRun(agent("a", { attentionTimestamp: T1 }))).toBe(true);
  });
});

describe("groupTeamRuns", () => {
  test("groups agents by run label and orders runs newest first", () => {
    const runs = groupTeamRuns([
      agent("old-coord", { labels: coordinatorLabels("run-old"), createdAt: T0 }),
      agent("new-coord", { labels: coordinatorLabels("run-new"), createdAt: T2 }),
      agent("new-m2", { labels: memberLabels("run-new"), createdAt: T2 }),
      agent("new-m1", { labels: memberLabels("run-new"), createdAt: T1 }),
      agent("loose"),
    ]);
    expect(runs.map((run) => run.runId)).toEqual(["run-new", "run-old"]);
    expect(runs[0]?.members.map((member) => member.id)).toEqual(["new-m1", "new-m2"]);
  });

  test("reads team, task, and workspace from the coordinator", () => {
    const [run] = groupTeamRuns([
      agent("coord", { labels: coordinatorLabels(), workspaceId: "ws-1", createdAt: T1 }),
      agent("m", { labels: memberLabels(), updatedAt: T2 }),
    ]);
    expect(run).toMatchObject({
      teamId: "coding-team",
      teamName: "Coding Team",
      task: "Add Stripe",
      workspaceId: "ws-1",
      startedAt: T1,
      lastActivityAt: T2,
    });
    expect(run?.coordinator?.id).toBe("coord");
  });

  test("skips archived agents, and still groups a run whose coordinator is gone", () => {
    const runs = groupTeamRuns([
      agent("coord", { labels: coordinatorLabels(), archivedAt: T2 }),
      agent("m1", { labels: memberLabels(), createdAt: T1, workspaceId: "ws-9" }),
      agent("m2", { labels: memberLabels(), createdAt: T0 }),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ coordinator: undefined, startedAt: T0, workspaceId: "ws-9" });
    expect(runs[0]?.members).toHaveLength(2);
  });

  test("ignores blank run labels", () => {
    expect(groupTeamRuns([agent("a", { labels: { [LABELS.run]: "  " } })])).toEqual([]);
  });
});

describe("runProgress", () => {
  const coordinator = (overrides: Partial<RunAgentSnapshot> = {}) =>
    agent("coord", { labels: coordinatorLabels(), lastUserMessageAt: T1, ...overrides });

  test("counts members and what they have delivered", () => {
    const progress = runProgress({
      coordinator: coordinator({ status: "running" }),
      members: [
        agent("m1", { lastUserMessageAt: T1 }),
        agent("m2", { status: "running", lastUserMessageAt: T1 }),
        agent("m3"),
        agent("m4", { status: "error", lastUserMessageAt: T1 }),
      ],
    });
    expect(progress).toMatchObject({ assigned: 3, delivered: 1, total: 4 });
    expect(progress.counts).toEqual({
      "needs-input": 0,
      failed: 1,
      working: 1,
      delivered: 1,
      "not-started": 1,
      closed: 0,
    });
  });

  test("members prompted only by agents are assigned and delivered", () => {
    const delivered = (id: string) =>
      agent(id, { lastUsage: { inputTokens: 1 }, attentionTimestamp: T1 });
    const progress = runProgress({
      coordinator: coordinator({ status: "idle" }),
      members: [delivered("m1"), delivered("m2")],
    });
    expect(progress).toMatchObject({ phase: "done", assigned: 2, delivered: 2, total: 2 });
  });

  test("starting: the coordinator has not received its kickoff", () => {
    const progress = runProgress({
      coordinator: coordinator({ lastUserMessageAt: null }),
      members: [agent("m")],
    });
    expect(progress.phase).toBe("starting");
  });

  test("running: the coordinator or any member is working", () => {
    const running = { coordinator: coordinator({ status: "running" }), members: [] };
    expect(runProgress(running).phase).toBe("running");
    expect(showsFollowUp(running, runProgress(running).phase)).toBe(true);
    expect(
      runProgress({
        coordinator: coordinator({ status: "idle" }),
        members: [
          agent("busy", { status: "running", lastUserMessageAt: T1 }),
          agent("stuck", { status: "error", lastUserMessageAt: T1 }),
        ],
      }).phase,
    ).toBe("running");
    expect(
      runProgress({
        coordinator: coordinator({ status: "initializing" }),
        members: [],
      }).phase,
    ).toBe("running");
    expect(
      runProgress({
        coordinator: coordinator(),
        members: [agent("m", { status: "running", lastUserMessageAt: T1 })],
      }).phase,
    ).toBe("running");
  });

  test("needs-you: the coordinator or a member waits on a permission", () => {
    const waiting = { coordinator: coordinator({ pendingPermissions: [{}] }), members: [] };
    expect(runProgress(waiting).phase).toBe("needs-you");
    expect(showsFollowUp(waiting, runProgress(waiting).phase)).toBe(true);
    expect(
      runProgress({
        coordinator: coordinator({ status: "running" }),
        members: [agent("m", { attentionReason: "permission" })],
      }).phase,
    ).toBe("needs-you");
  });

  test("needs-you: an idle coordinator with a member error is not finished", () => {
    const run = {
      runId: "run-1",
      coordinator: coordinator({ status: "idle" }),
      members: [agent("m", { status: "error", lastUserMessageAt: T1, lastError: "usage limit" })],
      startedAt: T0,
      lastActivityAt: T1,
    };
    const progress = runProgress(run);
    expect(progress.phase).toBe("needs-you");
    expect(progress.counts.failed).toBe(1);
    expect(showsFollowUp(run, progress.phase)).toBe(true);
    const rows = buildRunRows([run]);
    expect(filterRows(rows, "attention").map((row) => row.run.runId)).toEqual(["run-1"]);
    expect(filterRows(rows, "ended")).toEqual([]);
    expect(
      runProgress({
        coordinator: coordinator({ status: "idle" }),
        members: [
          agent("stuck", { status: "error", lastUserMessageAt: T1 }),
          agent("ok", { lastUserMessageAt: T1 }),
        ],
      }).phase,
    ).toBe("needs-you");
  });

  test("needs-you: an idle member flagged with an error attention is not finished", () => {
    const member = agent("m", { status: "idle", attentionReason: "error", lastUserMessageAt: T1 });
    expect(memberState(member)).toBe("failed");
    const run = { coordinator: coordinator({ status: "idle" }), members: [member] };
    const progress = runProgress(run);
    expect(progress.phase).toBe("needs-you");
    expect(showsFollowUp(run, progress.phase)).toBe(true);
  });

  test("a member flagged with an error while still running stays working", () => {
    const retrying = agent("m", {
      status: "running",
      attentionReason: "error",
      lastUserMessageAt: T1,
    });
    expect(memberState(retrying)).toBe("working");
    expect(
      memberState(
        agent("m", { status: "initializing", attentionReason: "error", lastUserMessageAt: T1 }),
      ),
    ).toBe("working");
    expect(
      runProgress({ coordinator: coordinator({ status: "idle" }), members: [retrying] }).phase,
    ).toBe("running");
  });

  test("failed: the coordinator errored", () => {
    const run = { coordinator: coordinator({ status: "error" }), members: [] };
    expect(runProgress(run).phase).toBe("failed");
    expect(showsFollowUp(run, runProgress(run).phase)).toBe(true);
    expect(
      runProgress({
        coordinator: coordinator({ status: "error" }),
        members: [agent("m", { status: "error", lastUserMessageAt: T1 })],
      }).phase,
    ).toBe("failed");
  });

  test("failed: an idle coordinator with an unread error attention is not done", () => {
    const run = {
      coordinator: coordinator({ status: "idle", attentionReason: "error" }),
      members: [agent("m", { lastUserMessageAt: T1 })],
    };
    expect(runProgress(run).phase).toBe("failed");
    expect(showsFollowUp(run, runProgress(run).phase)).toBe(true);
    expect(
      runProgress({
        coordinator: coordinator({
          status: "idle",
          attentionReason: "error",
          pendingPermissions: [{}],
        }),
        members: [],
      }).phase,
    ).toBe("needs-you");
    expect(
      runProgress({
        coordinator: coordinator({ status: "running", attentionReason: "error" }),
        members: [],
      }).phase,
    ).toBe("running");
  });

  test("done: the coordinator went idle and nobody is working", () => {
    const run = {
      coordinator: coordinator(),
      members: [agent("m", { lastUserMessageAt: T1 })],
    };
    const progress = runProgress(run);
    expect(progress.phase).toBe("done");
    expect(showsFollowUp(run, progress.phase)).toBe(false);
  });

  test("idle: the coordinator is closed, or there is none", () => {
    const closed = { coordinator: coordinator({ status: "closed" }), members: [] };
    expect(runProgress(closed).phase).toBe("idle");
    expect(showsFollowUp(closed, "idle")).toBe(false);
    expect(runProgress({ members: [agent("m")] }).phase).toBe("idle");
    expect(showsFollowUp({ coordinator: undefined }, "needs-you")).toBe(false);
  });
});

describe("digestTimeline", () => {
  const user = (text: string, at = T0) => ({ item: { type: "user_message", text }, timestamp: at });
  const assistant = (text: string, at = T0) => ({
    item: { type: "assistant_message", text },
    timestamp: at,
  });
  const todo = (items: unknown[], at = T0) => ({ item: { type: "todo", items }, timestamp: at });

  test("pairs the newest assignment with the reply that follows it", () => {
    const digest = digestTimeline([
      user("first task", T0),
      assistant("first done", T0),
      user("second task", T1),
      { item: { type: "tool_call" }, timestamp: T1 },
      assistant("working on the second", T2),
    ]);
    expect(digest.assignment).toEqual({ text: "second task", at: T1 });
    expect(digest.report).toEqual({ text: "working on the second", at: T2 });
  });

  test("an old reply is not the report for a newer assignment", () => {
    const digest = digestTimeline([
      user("first", T0),
      assistant("first done", T0),
      user("second", T1),
    ]);
    expect(digest.assignment?.text).toBe("second");
    expect(digest.report).toBeUndefined();
  });

  test("the newest of several replies wins", () => {
    const digest = digestTimeline([user("task"), assistant("draft", T1), assistant("final", T2)]);
    expect(digest.report).toEqual({ text: "final", at: T2 });
  });

  test("a tail that never reaches the prompt still shows the latest reply", () => {
    const digest = digestTimeline([assistant("earlier", T0), assistant("latest", T1)]);
    expect(digest.assignment).toBeUndefined();
    expect(digest.report?.text).toBe("latest");
  });

  test("summarises the newest todo list", () => {
    const digest = digestTimeline([
      todo([{ text: "old", completed: true }], T0),
      user("task", T1),
      todo(
        [
          { text: "design", completed: true },
          { text: "build", completed: false, status: "in_progress", activeForm: "Building" },
          { text: "ship", completed: false, status: "pending" },
          { text: "legacy done", status: "completed" },
        ],
        T2,
      ),
    ]);
    expect(digest.todos).toEqual({ done: 2, total: 4, active: "Building" });
  });

  test("falls back to the first open item when none is in progress", () => {
    const digest = digestTimeline([todo([{ text: "one", completed: true }, { text: "two" }])]);
    expect(digest.todos).toEqual({ done: 1, total: 2, active: "two" });
  });

  const agentMessage = (event: string, text: string, at = T0) => ({
    item: {
      type: "tool_call",
      name: "agent_message",
      status: "completed",
      agentMessage: { event, sender: { id: "coord", title: "Lead" }, text },
    },
    timestamp: at,
  });

  test("a prompt sent by another agent is the member's assignment", () => {
    const digest = digestTimeline([
      agentMessage("message", "用一个词回答：草通常是什么颜色？", T0),
      { item: { type: "reasoning", text: "thinking" }, timestamp: T1 },
      assistant("绿色", T2),
    ]);
    expect(digest.assignment).toEqual({ text: "用一个词回答：草通常是什么颜色？", at: T0 });
    expect(digest.report).toEqual({ text: "绿色", at: T2 });
  });

  test("a completion notice is not an assignment", () => {
    const digest = digestTimeline([
      user("# Task\nAdd Stripe", T0),
      assistant("delegating", T1),
      agentMessage("finished", "Agent m1 (Architect) finished", T2),
      assistant("both done", T2),
    ]);
    expect(digest.assignment).toEqual({ text: "# Task Add Stripe", at: T0 });
    expect(digest.report?.text).toBe("both done");
  });

  test("agent messages with an unexpected shape are ignored", () => {
    const digest = digestTimeline([
      { item: { type: "tool_call", name: "agent_message", agentMessage: "text" }, timestamp: T0 },
      {
        item: { type: "tool_call", name: "agent_message", agentMessage: { event: "message" } },
        timestamp: T0,
      },
      { item: { type: "tool_call", name: "agent_message" }, timestamp: T0 },
      {
        item: { type: "tool_call", name: "other", agentMessage: { event: "message", text: "x" } },
        timestamp: T0,
      },
    ]);
    expect(digest).toEqual({});
  });

  test("skips empty text, unknown item types, and malformed entries", () => {
    const digest = digestTimeline([
      null as never,
      { item: "oops", timestamp: T0 },
      { item: { type: "future-item", data: 1 }, timestamp: T0 },
      user("   ", T0),
      assistant("", T0),
      todo([], T0),
      todo("nope" as never, T0),
      todo([null, 4, { text: 3 }], T1),
    ]);
    expect(digest.assignment).toBeUndefined();
    expect(digest.report).toBeUndefined();
    expect(digest.todos).toEqual({ done: 0, total: 3 });
  });

  test("excerpt collapses whitespace and bounds the length", () => {
    expect(excerpt("  a \n\n b\t c ")).toBe("a b c");
    const long = excerpt("word ".repeat(100), 20);
    expect(long.length).toBeLessThanOrEqual(20);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("digestCacheKey", () => {
  const working = (overrides: Partial<RunAgentSnapshot> = {}) =>
    agent("a", { status: "running", ...overrides });

  test("a working agent keeps one key however often it updates", () => {
    expect(digestCacheKey(working({ updatedAt: T0 }))).toEqual(
      digestCacheKey(working({ updatedAt: T2 })),
    );
  });

  test("each finished turn gets its own key", () => {
    const first = digestCacheKey(agent("a", { status: "idle", updatedAt: T1 }));
    const second = digestCacheKey(agent("a", { status: "idle", updatedAt: T2 }));
    expect(first).not.toEqual(second);
  });

  // Paseo clears the finished/attention flags straight away for an agent that is being viewed,
  // so two finished turns can look the same in every flag. They must still not share a key.
  test("finished turns differ even when no attention flag ever shows", () => {
    const quiet = { attentionReason: null, attentionTimestamp: null, lastUserMessageAt: T0 };
    const afterFirstTurn = agent("a", { status: "idle", updatedAt: T1, ...quiet });
    const afterSecondTurn = agent("a", { status: "idle", updatedAt: T2, ...quiet });
    expect(digestCacheKey(afterFirstTurn)).not.toEqual(digestCacheKey(afterSecondTurn));
  });

  test("starting and stopping work changes the key, and agents never share one", () => {
    const idle = agent("a", { status: "idle", updatedAt: T1 });
    expect(digestCacheKey(idle)).not.toEqual(digestCacheKey(working({ updatedAt: T1 })));
    expect(digestCacheKey(idle)).not.toEqual(digestCacheKey(agent("b", { updatedAt: T1 })));
    expect(digestCacheKey(agent("a", { status: "error", updatedAt: T1 }))).not.toEqual(
      digestCacheKey(idle),
    );
  });
});

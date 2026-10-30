import { describe, expect, test } from "vitest";
import {
  alertRows,
  blockedLabel,
  budgetRows,
  buildEngineModel,
  channelRows,
  dagLayout,
  decisionRows,
  displayText,
  ENGINE_FAILURE_CODES,
  engineGetState,
  historyRows,
  layerFailures,
  lockView,
  MAX_DAG_NODES,
  needsYou,
  shortTime,
  stateNeedsYou,
  taskBadge,
  taskRow,
} from "../../shared/domain/run-engine/view";
import {
  RUN_READ_FAILURE_CODES,
  type RunDetailView,
  RunDetailViewSchema,
  type RunHistoryPage,
  type RunTaskView,
} from "../../shared/schemas/run-engine/rpc";

const AT = "2026-10-29T01:02:03.000Z";

function task(id: string, overrides: Partial<RunTaskView> = {}): RunTaskView {
  return {
    taskId: id,
    title: `Task ${id}`,
    state: "ready",
    phase: null,
    level: "L1",
    tier: "B",
    execution: "write",
    assignee: null,
    attempts: 0,
    protocolFailures: 0,
    evidenceReturns: 0,
    reworkCount: 0,
    qualityFailures: 0,
    currentTier: "B",
    escalations: [],
    blockedBy: null,
    waitingReason: null,
    frozen: false,
    ...overrides,
  };
}

function dagOf(spec: Array<[string, string[], number]>): RunDetailView["dag"] {
  return {
    revision: 1,
    tasks: spec.map(([taskId, deps, layer]) => ({
      taskId,
      title: `Task ${taskId}`,
      layer,
      deps,
      state: "ready",
    })),
  };
}

function runView(overrides: Partial<RunDetailView> = {}): RunDetailView {
  const tasks = overrides.tasks ?? [task("T1")];
  return {
    runId: "run-view-a1",
    revision: 3,
    lifecycle: "active",
    team: { id: "team", name: "Team", rawMode: "economy", modeContract: 2, plannerVersion: 2 },
    dagRevision: 1,
    dag: {
      revision: 1,
      tasks: tasks.map((entry) => ({
        taskId: entry.taskId,
        title: entry.title,
        layer: 0,
        deps: [],
        state: entry.state,
      })),
    },
    tasks,
    locks: [],
    capacity: { configuredLimit: 2, effectiveLimit: 2, inUse: 0 },
    budgets: [],
    decisions: [],
    channels: [],
    alerts: [],
    metrics: {
      strategicTurns: 0,
      workerEvents: 0,
      decisions: 0,
      tasks: tasks.length,
      reworks: 0,
      firstReviewAccepted: 0,
      coverage: "complete",
    },
    capabilities: { runEngine: 1, observationOnly: true, enabled: false, supportedControls: [] },
    issues: [],
    ...overrides,
  };
}

function page(seqs: number[], nextCursor: string | null = null): RunHistoryPage {
  return {
    events: seqs.map((seq) => ({
      seq,
      kind: seq % 2 === 0 ? "task-report" : "vendor-event",
      at: AT,
      taskId: "T1",
      summary: `event ${seq}`,
    })),
    nextCursor,
  };
}

const ready = (run = runView(), history = page([1, 2])) => ({
  runContractVersion: 1,
  status: "ready",
  run,
  history,
  issues: [],
});

describe("displayText", () => {
  test("strips controls, bidi and zero-width marks, folds whitespace", () => {
    expect(displayText("a\nb‮c​d\u0007e⁦f", 50)).toBe("a bcd ef");
    expect(displayText("  x   y  ", 50)).toBe("x y");
    expect(displayText("a\u200cb\u200dc", 50)).toBe("abc");
    expect(displayText("‏؜", 50, "fb")).toBe("fb");
  });

  test("cuts by code point and never leaves a lone surrogate", () => {
    const cut = displayText("😀".repeat(10), 4);
    expect([...cut]).toHaveLength(4);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.isWellFormed()).toBe(true);
    expect(displayText("abc", 3)).toBe("abc");
  });

  test("non-strings and empty input use the fallback", () => {
    expect(displayText(undefined, 5, "fb")).toBe("fb");
    expect(displayText("", 5, "fb")).toBe("fb");
    expect(displayText("\n\t", 5)).toBe("");
  });

  test("markdown and HTML stay literal characters", () => {
    expect(displayText("**bold** <b>x</b> [l](http://x)", 80)).toBe(
      "**bold** <b>x</b> [l](http://x)",
    );
  });

  test("shortTime is stable and tolerates garbage", () => {
    expect(shortTime(AT)).toBe("2026-10-29 01:02:03");
    expect(shortTime("later\n")).toBe("later");
  });
});

describe("engineGetState", () => {
  test("ready carries run, history and de-duplicated notices", () => {
    const state = engineGetState({
      ...ready(),
      issues: [
        {
          code: "history-cursor-expired",
          severity: "warning",
          path: [],
          params: {},
          action: "refresh",
        },
        {
          code: "history-cursor-expired",
          severity: "warning",
          path: [],
          params: {},
          action: "refresh",
        },
        { code: "future-code", severity: "info", path: [], params: {}, action: "none" },
      ],
    });
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.notices).toHaveLength(2);
    expect(state.notices[1]).toContain("future-code");
  });

  test("unchanged keeps the revision", () => {
    expect(engineGetState({ runContractVersion: 1, status: "unchanged", revision: 4 })).toEqual({
      kind: "unchanged",
      revision: 4,
    });
  });

  test.each([
    ["missing", "run-missing", "missing"],
    ["corrupt", "run-corrupt", "corrupt"],
    ["unknown-version", "run-unknown-version", "unknown-version"],
    ["corrupt", "run-projection-invalid", "projection-invalid"],
  ] as const)("%s failure with code %s shows %s", (status, code, expected) => {
    const state = engineGetState({
      runContractVersion: 1,
      status,
      run: null,
      issues: [{ code, severity: "error", path: [], params: {}, action: "refresh" }],
    });
    expect(state).toEqual({ kind: "failure", failure: expected, detail: null });
  });

  test("a failure code outside the frozen list falls back to the status and shows the code", () => {
    const state = engineGetState({
      runContractVersion: 1,
      status: "corrupt",
      run: null,
      issues: [
        { code: "RUN_CORRUPT\n", severity: "error", path: [], params: {}, action: "refresh" },
      ],
    });
    expect(state).toEqual({ kind: "failure", failure: "corrupt", detail: "RUN_CORRUPT" });
  });

  test("a failure without any issue uses the status", () => {
    expect(
      engineGetState({ runContractVersion: 1, status: "missing", run: null, issues: [] }),
    ).toEqual({ kind: "failure", failure: "missing", detail: null });
  });

  test.each([
    ["an unknown status", { runContractVersion: 1, status: "teleported", run: null, issues: [] }],
    [
      "an unknown contract version",
      { runContractVersion: 2, status: "missing", run: null, issues: [] },
    ],
    [
      "a ready result without history",
      { runContractVersion: 1, status: "ready", run: runView(), issues: [] },
    ],
    [
      "a failure that carries a run",
      { runContractVersion: 1, status: "corrupt", run: runView(), issues: [] },
    ],
    ["text", "nope"],
    ["null", null],
    ["undefined", undefined],
  ])("%s means refresh the plugin and never retry", (_name, raw) => {
    expect(engineGetState(raw)).toEqual({ kind: "refresh-plugin" });
  });

  test("every frozen failure code has a handled branch", () => {
    expect([...ENGINE_FAILURE_CODES]).toEqual([...RUN_READ_FAILURE_CODES]);
    expect(ENGINE_FAILURE_CODES).toContain("run-projection-invalid");
  });

  test("stateNeedsYou never calls an unreadable run fine", () => {
    expect(stateNeedsYou({ kind: "unchanged", revision: 1 }).level).toBe("ok");
    expect(stateNeedsYou({ kind: "refresh-plugin" }).level).toBe("needs-you");
    expect(stateNeedsYou({ kind: "failure", failure: "corrupt", detail: null }).level).toBe(
      "needs-you",
    );
    const readyState = engineGetState(ready());
    expect(stateNeedsYou(readyState).level).toBe("ok");
  });
});

describe("dagLayout", () => {
  const diamond = dagOf([
    ["D", ["B", "C"], 2],
    ["B", ["A"], 1],
    ["C", ["A"], 1],
    ["A", [], 0],
  ]);

  test("columns group by topological layer and keep declaration order inside a layer", () => {
    const layout = dagLayout(diamond, "columns");
    expect(layout.layers.map((layer) => layer.nodes.map((node) => node.taskId))).toEqual([
      ["A"],
      ["B", "C"],
      ["D"],
    ]);
    expect(layout.edges).toEqual([
      { from: "B", to: "D" },
      { from: "C", to: "D" },
      { from: "A", to: "B" },
      { from: "A", to: "C" },
    ]);
    expect(layout.anomalies).toBe(0);
    expect(layout.truncated).toBeNull();
  });

  test("the compact list has the same layers and no edges", () => {
    const layout = dagLayout(diamond, "list");
    expect(layout.mode).toBe("list");
    expect(layout.edges).toEqual([]);
    expect(layout.layers[2]?.nodes[0]?.depsLabel).toContain("B");
    expect(layout.layers[0]?.nodes[0]?.depsLabel).toContain("无依赖");
  });

  test("a missing dependency or a non-increasing layer is counted, never drawn", () => {
    const layout = dagLayout(
      dagOf([
        ["A", [], 0],
        ["B", ["ghost"], 1],
        ["C", ["B"], 1],
      ]),
      "columns",
    );
    expect(layout.anomalies).toBe(2);
    expect(layout.edges).toEqual([]);
  });

  test("an empty graph has no layers", () => {
    expect(dagLayout(dagOf([]), "columns").layers).toEqual([]);
  });

  test("more than 64 nodes are cut and reported", () => {
    const many = dagOf(
      Array.from({ length: 70 }, (_, i) => [`N${i}`, [], 0] as [string, string[], number]),
    );
    const layout = dagLayout(many, "list");
    expect(layout.layers[0]?.nodes).toHaveLength(MAX_DAG_NODES);
    expect(layout.truncated).toEqual({ shown: 64, total: 70 });
  });
});

describe("taskBadge", () => {
  test.each([
    ["done", null, false, "完成", "success"],
    ["failed", null, false, "失败", "danger"],
    ["blocked", "frozen", true, "阻塞 · 冻结待静止", "warning"],
    ["in_progress", "implementation", false, "进行中", "accent"],
    ["review", "smoke", false, "审查中 · 冒烟", "accent"],
    ["review", "awaiting-rework", false, "审查中 · 待返工", "accent"],
    ["rework", null, true, "返工 · 已冻结", "warning"],
    ["pending", null, false, "待依赖", "muted"],
  ] as const)("%s/%s", (state, phase, frozen, label, tone) => {
    expect(taskBadge(state, phase, frozen)).toEqual({ label, tone });
  });

  test("an unknown state or phase is shown as given with a neutral tone", () => {
    expect(taskBadge("teleporting", "warp", false)).toEqual({
      label: "teleporting · warp",
      tone: "neutral",
    });
    expect(taskBadge("a\nb", null, false).label).toBe("a b");
  });
});

describe("taskRow and blockedLabel", () => {
  const base = {
    tasks: [] as RunTaskView[],
    locks: [
      {
        claimId: "claim-1",
        taskId: "T9",
        repoId: "r",
        kind: "file" as const,
        path: "src/a.ts",
        access: "write" as const,
        frozen: false,
      },
    ],
    decisions: [
      {
        decisionId: "11111111-1111-4111-8111-111111111111",
        category: "D1",
        state: "open" as const,
        subjectId: "T1",
        summary: "s",
        createdAt: AT,
        answeredAction: null,
      },
    ],
    history: [] as RunHistoryPage["events"],
  };
  const label = (kind: string, ref: string | null) =>
    blockedLabel({ kind: kind as never, ref }, base);

  test("each blockedBy kind has its own wording; null is nothing", () => {
    expect(blockedLabel(null, base)).toBeNull();
    expect(label("dependency", "T0")).toBe("等待依赖 T0");
    expect(label("dependency", null)).toBe("等待依赖");
    expect(label("lock", "claim-1")).toBe("被 T9 持有的锁阻塞");
    expect(label("lock", "claim-x")).toBe("被锁阻塞（claim-x）");
    expect(label("lock", null)).toBe("被锁阻塞");
    expect(label("decision", "11111111-1111-4111-8111-111111111111")).toBe("等待决策 D1");
    expect(label("decision", null)).toBe("等待决策");
    expect(label("permission", "agent-1")).toBe("等待权限回应（agent-1）");
    expect(label("permission", null)).toBe("等待权限回应");
    expect(label("capacity", null)).toBe("并发名额已满");
    expect(label("channel", "claude")).toBe("渠道暂不可用（claude）");
    expect(label("channel", null)).toBe("渠道暂不可用");
    expect(label("seat", null)).toBe("缺少合格席位");
    expect(label("other", null)).toBe("等待处理");
    expect(label("weather", null)).toBe("weather");
  });

  test("layer failures subtract the last escalation baseline and never go negative", () => {
    const esc = (qualityFailures: number) => ({
      fromTier: "B",
      toTier: "A",
      atAttempt: 3,
      qualityFailures,
      at: AT,
    });
    expect(layerFailures({ qualityFailures: 2, escalations: [] })).toBe(2);
    expect(layerFailures({ qualityFailures: 4, escalations: [esc(3)] })).toBe(1);
    expect(layerFailures({ qualityFailures: 9, escalations: [esc(3), esc(6)] })).toBe(3);
    expect(layerFailures({ qualityFailures: 1, escalations: [esc(5)] })).toBe(0);
  });

  test("a row shows tier chain, assignee, counts and the newest event of that task", () => {
    const escalated = task("T1", {
      state: "rework",
      level: "L2",
      currentTier: "A",
      attempts: 4,
      reworkCount: 2,
      evidenceReturns: 1,
      protocolFailures: 1,
      qualityFailures: 4,
      escalations: [{ fromTier: "B", toTier: "A", atAttempt: 3, qualityFailures: 3, at: AT }],
      assignee: {
        seatId: "seat-a1",
        agentId: "agent-1",
        profileId: "p",
        profileName: "Sonnet\nX",
        provider: "claude",
        model: null,
        channelId: "claude",
      },
      waitingReason: "line‮",
      blockedBy: { kind: "dependency", ref: "T0" },
    });
    const events = page([1, 2, 5]).events;
    const row = taskRow(escalated, { ...base, history: events });
    expect(row.tierLine).toBe("L2 · 当前层 B→A");
    expect(row.assignee).toBe("seat-a1 · Sonnet X · claude");
    expect(row.counts).toEqual([
      "尝试 4",
      "返工 2",
      "证据退回 1",
      "协议失败 1",
      "质量失败 4（本层 1）",
    ]);
    expect(row.escalations).toEqual(["第 3 次尝试后升层 B→A"]);
    expect(row.waiting).toBe("line");
    expect(row.blocked).toBe("等待依赖 T0");
    expect(row.lastEvent).toContain("vendor-event".length > 0 ? "event 5" : "");
    expect(row.lastEvent).toContain("2026-10-29 01:02:03");
  });

  test("an unassigned task without events has no assignee and no last event", () => {
    const row = taskRow(task("T2"), base);
    expect(row.assignee).toBe("尚未指派");
    expect(row.lastEvent).toBeNull();
    expect(row.waiting).toBeNull();
    expect(row.tierLine).toBe("L1 · 当前层 B");
  });

  test("state, level and every escalation tier are cleaned for display", () => {
    const dirty = task("T1", {
      state: "RUN\u202eNING",
      level: "L\u202e2",
      tier: "B\u202e",
      currentTier: "B",
      escalations: [
        { fromTier: "B\u202e", toTier: "A\u202e", atAttempt: 2, qualityFailures: 1, at: AT },
      ],
    });
    const row = taskRow(dirty, base);
    expect(row.badge.label).toBe("RUNNING");
    expect(row.tierLine).toBe("L2 · 当前层 B→A");
    expect(row.escalations).toEqual(["第 2 次尝试后升层 B→A"]);
    const layout = dagLayout(
      {
        revision: 1,
        tasks: [{ taskId: "T1", title: "x", layer: 0, deps: [], state: "RUN\u202eNING" }],
      },
      "columns",
    );
    expect(layout.layers[0]?.nodes[0]?.state).toBe("RUNNING");
  });

  test("blank titles fall back to a cleaned task id in rows, DAG and lock groups", () => {
    const blank = task("T\u202e", { title: " " });
    expect(taskRow(blank, base).title).toBe("T");
    const layout = dagLayout(
      {
        revision: 1,
        tasks: [{ taskId: "T\u202e", title: " ", layer: 0, deps: [], state: "ready" }],
      },
      "columns",
    );
    expect(layout.layers[0]?.nodes[0]?.title).toBe("T");
    const locks = lockView({
      locks: [
        {
          claimId: "c1",
          taskId: "T\u202e",
          repoId: "r",
          kind: "file",
          path: "a.ts",
          access: "write",
          frozen: false,
        },
      ],
      tasks: [],
      capacity: { configuredLimit: 1, effectiveLimit: 1, inUse: 0 },
    });
    expect(locks.groups[0]?.title).toBe("T");
  });
});

describe("lockView", () => {
  const lock = (claimId: string, taskId: string, over: Record<string, unknown> = {}) => ({
    claimId,
    taskId,
    repoId: "r",
    kind: "file" as const,
    path: `src/${claimId}.ts`,
    access: "write" as const,
    frozen: false,
    ...over,
  });

  test("groups by holder, labels hot/tool as named resources and lists waiters", () => {
    const view = lockView({
      locks: [
        lock("c1", "T1"),
        lock("c2", "T1", { kind: "hot", path: "package-lock.json", frozen: true }),
        lock("c3", "T2", { kind: "tool", path: "npm:install", access: "read" }),
        lock("c4", "T3", { kind: "directory", path: "src" }),
      ],
      tasks: [
        task("T1"),
        task("T2"),
        task("T3"),
        task("T4", { blockedBy: { kind: "lock", ref: "c1" } }),
        task("T5", { blockedBy: { kind: "lock", ref: "c1" } }),
        task("T6", { blockedBy: { kind: "lock", ref: "missing" } }),
        task("T7", { blockedBy: { kind: "lock", ref: null } }),
      ],
      capacity: { configuredLimit: 1, effectiveLimit: 2, inUse: 2 },
    });
    expect(view.groups.map((group) => group.taskId)).toEqual(["T1", "T2", "T3"]);
    expect(view.groups[0]?.waiters).toEqual(["T4", "T5"]);
    expect(
      view.groups[0]?.claims.map((c) => [c.kindLabel, c.target, c.accessLabel, c.frozen]),
    ).toEqual([
      ["文件", "src/c1.ts", "写", false],
      ["热点", "package-lock.json", "写", true],
    ]);
    expect(view.groups[1]?.claims[0]?.kindLabel).toBe("工具");
    expect(view.groups[1]?.claims[0]?.accessLabel).toBe("读");
    expect(view.groups[2]?.claims[0]?.kindLabel).toBe("目录");
    expect(view.capacity).toEqual({ text: "占用 2 / 配置 1（有效 2）", over: true });
  });

  test("no locks and capacity within the configured limit", () => {
    const view = lockView({
      locks: [],
      tasks: [],
      capacity: { configuredLimit: 2, effectiveLimit: 2, inUse: 2 },
    });
    expect(view.groups).toEqual([]);
    expect(view.capacity.over).toBe(false);
  });

  test("a lock held by an unknown task still shows, titled by its id", () => {
    const view = lockView({
      locks: [lock("c1", "ghost", { path: "a‮b.ts" })],
      tasks: [],
      capacity: { configuredLimit: 1, effectiveLimit: 1, inUse: 0 },
    });
    expect(view.groups[0]?.title).toBe("ghost");
    expect(view.groups[0]?.claims[0]?.target).toBe("ab.ts");
  });

  test("unknown kinds and access values are shown as given", () => {
    const view = lockView({
      locks: [lock("c1", "T1", { kind: "vault", access: "admin" })],
      tasks: [task("T1")],
      capacity: { configuredLimit: 1, effectiveLimit: 1, inUse: 0 },
    });
    expect(view.groups[0]?.claims[0]).toMatchObject({ kindLabel: "vault", accessLabel: "admin" });
  });
});

describe("budgetRows", () => {
  test("reserved, confirmed and observed turns stay three separate numbers", () => {
    const rows = budgetRows([
      { scope: "seat", subjectId: "seat-1", limit: 6, reserved: 3, confirmed: 2, observedTurns: 1 },
      { scope: "group", subjectId: "g", limit: 4, reserved: 4, confirmed: 0, observedTurns: 0 },
      { scope: "seat", subjectId: "zero", limit: 0, reserved: 0, confirmed: 0, observedTurns: 0 },
    ]);
    expect(rows[0]).toMatchObject({
      scopeLabel: "席位",
      reserved: "预扣 3",
      confirmed: "确认 2",
      observed: "观察回合 1",
      limit: "上限 6",
      ratio: 0.5,
      exhausted: false,
    });
    expect(rows[1]).toMatchObject({ scopeLabel: "分组", ratio: 1, exhausted: true });
    expect(rows[2]?.ratio).toBeNull();
    expect(budgetRows([])).toEqual([]);
  });
});

describe("decisions, channels and alerts", () => {
  const decision = (id: string, over: Record<string, unknown> = {}) => ({
    decisionId: `1111111${id}-1111-4111-8111-111111111111`,
    category: "D1",
    state: "open" as const,
    subjectId: null,
    summary: "need\nyou",
    createdAt: AT,
    answeredAction: null,
    ...over,
  });

  test("open decisions come first, then by time; answered ones show the chosen action", () => {
    const rows = decisionRows(
      [
        decision("1", { state: "answered", answeredAction: "cancel", subjectId: "T1" }),
        decision("2", {
          createdAt: "2026-10-29T02:00:00.000Z",
          category: "D4",
          subjectId: "ghost",
        }),
        decision("3", { state: "waiting-human", category: "D9" }),
        decision("4", { state: "answered", answeredAction: "quantum" }),
      ],
      [task("T1", { title: "Login" })],
    );
    expect(rows.map((row) => row.open)).toEqual([true, true, false, false]);
    expect(rows[0]?.stateLabel).toBe("等待人工");
    expect(rows[0]?.category).toBe("D9");
    expect(rows[1]).toMatchObject({ category: "D4 预算", subject: "ghost" });
    expect(rows[2]).toMatchObject({ subject: "Login", answered: "已选择：取消" });
    expect(rows[3]?.answered).toBe("已选择：quantum");
    expect(rows[0]?.summary).toBe("need you");
    expect(rows[0]?.answered).toBeNull();
  });

  test("a decision with an unknown state shows it as given", () => {
    const [row] = decisionRows([decision("1", { state: "limbo" })], []);
    expect(row?.stateLabel).toBe("limbo");
  });

  test("a superseded decision is not pending and is labelled 已失效", () => {
    const [row] = decisionRows([decision("1", { state: "superseded" })], []);
    expect(row).toMatchObject({ open: false, stateLabel: "已失效", answered: null });
  });

  test("channels show the recovery lower bound only when paused", () => {
    const rows = channelRows([
      {
        channelId: "claude",
        state: "available",
        unavailableUntil: null,
        code: null,
        source: "usage-source",
        observedAt: AT,
      },
      {
        channelId: "codex",
        state: "paused",
        unavailableUntil: AT,
        code: "quota",
        source: "structured-error",
        observedAt: AT,
      },
      {
        channelId: "x",
        state: "paused",
        unavailableUntil: null,
        code: null,
        source: "human",
        observedAt: AT,
      },
      {
        channelId: "y",
        state: "unknown",
        unavailableUntil: null,
        code: null,
        source: "human",
        observedAt: AT,
      },
    ]);
    expect(rows[0]).toMatchObject({ paused: false, until: null, code: null });
    expect(rows[1]).toMatchObject({
      paused: true,
      until: "恢复下界 2026-10-29 01:02:03",
      code: "原因代码 quota",
    });
    expect(rows[2]?.until).toBe("恢复下界未设置");
    expect(rows[3]?.stateLabel).toBe("未知");
  });

  test("open alerts first, then by severity", () => {
    const alert = (alertId: string, severity: string, state: string, createdAt = AT) => ({
      alertId,
      severity: severity as never,
      state: state as never,
      summary: "s",
      createdAt,
    });
    const rows = alertRows([
      alert("a1", "info", "open"),
      alert("a2", "critical", "resolved"),
      alert("a3", "critical", "open"),
      alert("a4", "warning", "open"),
      alert("a5", "mystery", "open"),
    ]);
    expect(rows.map((row) => row.alertId)).toEqual(["a3", "a4", "a1", "a5", "a2"]);
    expect(rows[0]).toMatchObject({ critical: true, open: true, severity: "严重" });
    expect(rows[3]?.severity).toBe("mystery");
    expect(rows[4]?.stateLabel).toBe("已解决");
  });
});

describe("needsYou", () => {
  const base = {
    lifecycle: "active",
    tasks: [task("T1")],
    decisions: [] as RunDetailView["decisions"],
    alerts: [] as RunDetailView["alerts"],
    channels: [] as RunDetailView["channels"],
    capacity: { configuredLimit: 2, effectiveLimit: 2, inUse: 0 },
  };
  const openDecision = {
    decisionId: "11111111-1111-4111-8111-111111111111",
    category: "D1",
    state: "open" as const,
    subjectId: null,
    summary: "s",
    createdAt: AT,
    answeredAction: null,
  };

  test("a clean run is ok", () => {
    expect(needsYou(base)).toEqual({ level: "ok", reasons: [] });
  });

  test("an open or waiting-human decision needs you; an answered one does not", () => {
    expect(needsYou({ ...base, decisions: [openDecision] }).level).toBe("needs-you");
    expect(
      needsYou({ ...base, decisions: [{ ...openDecision, state: "waiting-human" }] }).level,
    ).toBe("needs-you");
    expect(needsYou({ ...base, decisions: [{ ...openDecision, state: "answered" }] }).level).toBe(
      "ok",
    );
    expect(needsYou({ ...base, decisions: [{ ...openDecision, state: "superseded" }] }).level).toBe(
      "ok",
    );
  });

  test("a pending permission on assigned, in-progress, review, or rework needs you", () => {
    const permission = { kind: "permission" as const, ref: "agent-b1" };
    for (const state of ["assigned", "in_progress", "review", "rework"] as const) {
      expect(needsYou({ ...base, tasks: [task("T1", { state, blockedBy: permission })] })).toEqual({
        level: "needs-you",
        reasons: ["1 个任务等待权限处理"],
      });
    }
    expect(
      needsYou({ ...base, tasks: [task("T1", { state: "ready", blockedBy: permission })] }),
    ).toEqual({ level: "ok", reasons: [] });
  });

  test("a blocked or failed task needs you", () => {
    expect(needsYou({ ...base, tasks: [task("T1", { state: "blocked" })] }).level).toBe(
      "needs-you",
    );
    expect(needsYou({ ...base, tasks: [task("T1", { state: "failed" })] }).level).toBe("needs-you");
    expect(needsYou({ ...base, tasks: [task("T1", { state: "cancelled" })] }).level).toBe("ok");
  });

  test("only an open critical alert needs you", () => {
    const alert = (severity: "critical" | "warning", state: "open" | "resolved") => ({
      alertId: "a",
      severity,
      state,
      summary: "s",
      createdAt: AT,
    });
    expect(needsYou({ ...base, alerts: [alert("critical", "open")] }).level).toBe("needs-you");
    expect(needsYou({ ...base, alerts: [alert("warning", "open")] }).level).toBe("ok");
    expect(needsYou({ ...base, alerts: [alert("critical", "resolved")] }).level).toBe("ok");
  });

  test("a paused run, a paused channel or an over-capacity run is waiting", () => {
    expect(needsYou({ ...base, lifecycle: "paused" })).toMatchObject({ level: "waiting" });
    expect(
      needsYou({
        ...base,
        channels: [
          {
            channelId: "c",
            state: "paused",
            unavailableUntil: null,
            code: null,
            source: "human",
            observedAt: AT,
          },
        ],
      }).level,
    ).toBe("waiting");
    expect(
      needsYou({ ...base, capacity: { configuredLimit: 1, effectiveLimit: 2, inUse: 2 } }).level,
    ).toBe("waiting");
  });

  test("a finished run with an unanswered decision is still needs-you", () => {
    const result = needsYou({ ...base, lifecycle: "finished", decisions: [openDecision] });
    expect(result.level).toBe("needs-you");
    expect(result.reasons[0]).toContain("1");
  });

  test("urgent reasons come before waiting ones", () => {
    const result = needsYou({
      ...base,
      lifecycle: "paused",
      decisions: [openDecision],
    });
    expect(result.level).toBe("needs-you");
    expect(result.reasons).toHaveLength(2);
  });
});

describe("historyRows", () => {
  test("merges pages, drops repeated seq and shows the newest first", () => {
    const rows = historyRows([page([6, 7, 8], "c1"), page([4, 5, 6], "c2"), page([1, 2, 3])]);
    expect(rows.map((row) => row.seq)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  });

  test("known kinds get copy and their task; unknown kinds show the summary", () => {
    const rows = historyRows([
      {
        events: [
          { seq: 1, kind: "task-report", at: AT, taskId: "T1", summary: "ignored" },
          { seq: 2, kind: "vendor-x", at: AT, taskId: "T1", summary: "vendor\nsummary" },
          { seq: 3, kind: "vendor-y", at: AT, taskId: null, summary: "\u0007" },
          { seq: 4, kind: "turn_ended", at: AT, taskId: null, summary: "x" },
        ],
        nextCursor: null,
      },
    ]);
    const bySeq = new Map(rows.map((row) => [row.seq, row]));
    expect(bySeq.get(1)).toMatchObject({ label: "任务报告", detail: "T1", known: true });
    expect(bySeq.get(2)).toMatchObject({ label: "vendor summary", detail: null, known: false });
    expect(bySeq.get(3)?.label).toBe("vendor-y");
    expect(bySeq.get(4)).toMatchObject({ label: "回合结束", known: true });
  });

  test("no pages, no rows", () => {
    expect(historyRows([])).toEqual([]);
  });

  test("a newer page wins a conflicting duplicate seq", () => {
    const rows = historyRows([
      {
        events: [{ seq: 5, kind: "vendor-x", at: AT, taskId: null, summary: "NEW-5" }],
        nextCursor: null,
      },
      {
        events: [{ seq: 5, kind: "vendor-x", at: AT, taskId: null, summary: "OLD-5" }],
        nextCursor: null,
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("NEW-5");
  });
});

describe("buildEngineModel", () => {
  const state = () => {
    const parsed = engineGetState(
      ready(
        runView({
          tasks: [task("T1", { title: "**x**\n<b>" })],
          team: { id: "t", name: "Team‮", rawMode: "m", modeContract: 2, plannerVersion: 2 },
        }),
        page([3, 4], "cursor-old"),
      ),
    );
    if (parsed.kind !== "ready") throw new Error("expected ready");
    return parsed;
  };

  test("wide and compact only change the DAG mode", () => {
    expect(buildEngineModel(state(), [], false).dag.mode).toBe("columns");
    expect(buildEngineModel(state(), [], true).dag.mode).toBe("list");
  });

  test("history merges the older pages and the cursor is the oldest page's", () => {
    const model = buildEngineModel(state(), [page([1, 2], "cursor-older"), page([0], null)], false);
    expect(model.history.map((row) => row.seq)).toEqual([4, 3, 2, 1, 0]);
    expect(model.nextCursor).toBeNull();
    expect(buildEngineModel(state(), [page([1, 2], "cursor-older")], false).nextCursor).toBe(
      "cursor-older",
    );
    expect(buildEngineModel(state(), [], false).nextCursor).toBe("cursor-old");
  });

  test("server text is cleaned and the run is labelled", () => {
    const model = buildEngineModel(state(), [], false);
    expect(model.teamName).toBe("Team");
    expect(model.lifecycle).toBe("运行中");
    expect(model.tasks[0]?.title).toBe("**x** <b>");
    expect(model.runId).toBe("run-view-a1");
    expect(model.needs.level).toBe("ok");
  });

  test("an unknown lifecycle is shown as given", () => {
    const parsed = engineGetState(ready(runView({ lifecycle: "hibernating" })));
    if (parsed.kind !== "ready") throw new Error("expected ready");
    expect(buildEngineModel(parsed, [], false).lifecycle).toBe("hibernating");
  });

  test("the DTO the tests build is itself a valid RunDetailView", () => {
    expect(RunDetailViewSchema.safeParse(runView()).success).toBe(true);
  });
});

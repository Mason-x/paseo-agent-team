import { createElement as h } from "react";
// @ts-expect-error react-test-renderer ships no types here; TestRenderer below is the subset used.
import * as reactTestRenderer from "react-test-renderer";
import { describe, expect, test, vi } from "vitest";

vi.mock("react-native", () => {
  const host = (name: string) => (props: Record<string, unknown>) =>
    h(name, props, props.children as never);
  return {
    View: host("View"),
    Text: host("Text"),
    Pressable: host("Pressable"),
    Platform: { OS: "web" },
  };
});
vi.mock("@getpaseo/plugin/client/react-native", () => {
  const modal = Object.assign(
    (props: Record<string, unknown>) =>
      props.open ? h("Modal", props, props.children as never) : null,
    {
      Content: (props: Record<string, unknown>) =>
        h("ModalContent", props, props.children as never),
    },
  );
  return {
    ScrollView: (props: Record<string, unknown>) => h("ScrollView", props, props.children as never),
    Modal: modal,
    TextInput: (props: Record<string, unknown>) => h("TextInput", props),
    Icon: () => null,
  };
});

import { EngineView } from "../../client/runs/engine/EngineView";
import {
  buildEngineModel,
  type EngineState,
  engineGetState,
} from "../../shared/domain/run-engine/view";
import type {
  RunDetailView,
  RunHistoryPage,
  RunTaskView,
} from "../../shared/schemas/run-engine/rpc";
import { runEngineZh as zh } from "../../shared/zh/run-engine";

type Node = {
  type: unknown;
  props: Record<string, unknown>;
  findAll(predicate: (node: Node) => boolean): Node[];
};
type TestRenderer = {
  act(callback: () => Promise<void> | void): Promise<void>;
  create(element: unknown): { root: Node; unmount(): void };
};
const renderer = reactTestRenderer as unknown as TestRenderer;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AT = "2026-10-29T01:02:03.000Z";
const theme = new Proxy({ colors: new Proxy({}, { get: () => "#000" }) }, {}) as never;
const layout = { compact: false };

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
      kind: "task-report",
      at: AT,
      taskId: "T1",
      summary: `e${seq}`,
    })),
    nextCursor,
  };
}

function ready(run = runView(), history = page([1, 2], "older")): EngineState {
  const state = engineGetState({
    runContractVersion: 1,
    status: "ready",
    run,
    history,
    issues: [],
  });
  if (state.kind !== "ready") throw new Error("expected ready");
  return state;
}

async function mount(state: EngineState | null, overrides: Record<string, unknown> = {}) {
  let view!: { root: Node; unmount(): void };
  await renderer.act(async () => {
    view = renderer.create(
      h(EngineView, {
        theme,
        layout,
        state,
        onRefresh: vi.fn(),
        onLoadOlder: vi.fn(),
        ...overrides,
      } as never),
    );
  });
  return view;
}

function textNodes(root: Node): string[] {
  return root
    .findAll((node) => node.type === "Text")
    .map((node) =>
      Array.isArray(node.props.children)
        ? node.props.children.join("")
        : String(node.props.children ?? ""),
    );
}
function button(root: Node, label: string): Node | undefined {
  return root.findAll(
    (node) => node.type === "Pressable" && node.props.accessibilityLabel === label,
  )[0];
}

describe("EngineView mounted rendering", () => {
  test("renders server text literally, uses DTO capabilities, and exposes only read/refresh controls", async () => {
    const canary = runView({
      team: { id: "t", name: "Team‮ **x**", rawMode: "m", modeContract: 2, plannerVersion: 2 },
      tasks: [task("T1", { title: "**x**\n<b>\u202e" })],
    });
    const view = await mount(ready(canary));
    const text = textNodes(view.root);
    expect(text).toContain("**x** <b>");
    expect(view.root.findAll((node) => node.type === "b")).toHaveLength(0);
    // No controls were handed to the view, so it neither draws a button for one nor claims read-only.
    expect(text.join("\n")).not.toContain(zh.controls.title);
    expect(text.join("\n")).not.toContain("只读");
    const labels = view.root
      .findAll((node) => node.type === "Pressable")
      .map((node) => node.props.accessibilityLabel);
    expect(labels).toEqual(expect.arrayContaining(["展开 T1", "加载更早"]));
    expect(
      labels.every((label) => ["展开 T1", "加载更早", "收起 T1", "刷新"].includes(String(label))),
    ).toBe(true);
    await renderer.act(async () =>
      (
        view.root.findAll((node) => node.type === "Pressable")[0]?.props.onPress as
          | (() => void)
          | undefined
      )?.(),
    );
    expect(textNodes(view.root).join("\n")).toContain("尝试 0");
    const collapse = button(view.root, "收起 T1");
    expect(collapse).toBeDefined();
    await renderer.act(async () => (collapse?.props.onPress as (() => void) | undefined)?.());
    expect(textNodes(view.root).join("\n")).not.toContain("尝试 0");
    await renderer.act(async () => view.unmount());
  });

  test("header needs-you badge reports a pending permission", async () => {
    const view = await mount(
      ready(
        runView({
          tasks: [
            task("T1", {
              state: "in_progress",
              blockedBy: { kind: "permission", ref: "agent-b1" },
            }),
          ],
        }),
      ),
    );
    const text = textNodes(view.root).join("\n");
    expect(text).toContain(zh.level.needsYou);
    expect(text).toContain("1 个任务等待权限处理");
    await renderer.act(async () => view.unmount());
  });

  test("header needs-you badge reports review and rework permission without claiming a unique actor", async () => {
    for (const state of ["review", "rework"] as const) {
      const view = await mount(
        ready(
          runView({
            tasks: [
              task("T1", {
                state,
                blockedBy: { kind: "permission", ref: "agent-b1" },
              }),
            ],
          }),
        ),
      );
      const text = textNodes(view.root).join("\n");
      expect(text).toContain(zh.level.needsYou);
      expect(text).toContain("1 个任务等待权限处理");
      expect(text).not.toContain("唯一");
      await renderer.act(async () => view.unmount());
    }
  });

  test("ready plus permission does not raise needs-you on mount", async () => {
    const view = await mount(
      ready(
        runView({
          tasks: [
            task("T1", {
              state: "ready",
              blockedBy: { kind: "permission", ref: "agent-b1" },
            }),
          ],
        }),
      ),
    );
    const text = textNodes(view.root).join("\n");
    expect(text).not.toContain("1 个任务等待权限处理");
    await renderer.act(async () => view.unmount());
  });

  test("zero-width joiners never reach Text", async () => {
    const view = await mount(
      ready(
        runView({
          team: {
            id: "t",
            name: "A\u200cB\u200dC",
            rawMode: "m",
            modeContract: 2,
            plannerVersion: 2,
          },
          tasks: [task("T1", { title: "T\u200c1\u200dX" })],
        }),
      ),
    );
    const text = textNodes(view.root).join("\n");
    expect(text).toContain("ABC");
    expect(text).toContain("T1X");
    expect(text).not.toContain("\u200c");
    expect(text).not.toContain("\u200d");
    await renderer.act(async () => view.unmount());
  });

  test("unchanged is a W01 handoff and renders neither a fake ready nor a failure card", async () => {
    const view = await mount({ kind: "unchanged", revision: 4 });
    expect(view.root.findAll((node) => node.type === "Text")).toHaveLength(0);
    expect(view.root.findAll((node) => node.type === "Pressable")).toHaveLength(0);
    await renderer.act(async () => view.unmount());
  });

  test("schema-valid lifecycle names stay strings through the model and real mount", async () => {
    const cases = [
      ["active", "运行中"],
      ["hibernating", "hibernating"],
      ["__proto__", "__proto__"],
      ["constructor", "constructor"],
      ["toString", "toString"],
    ] as const;
    for (const [lifecycle, expected] of cases) {
      const state = ready(runView({ lifecycle }));
      if (state.kind !== "ready") throw new Error("expected ready");
      const model = buildEngineModel(state, [], false);
      expect(typeof model.lifecycle).toBe("string");
      const view = await mount(state);
      expect(textNodes(view.root).join("\n")).toContain(expected);
      await renderer.act(async () => view.unmount());
    }
  });

  test("loads older by cursor and refresh works from failure states", async () => {
    const onLoadOlder = vi.fn();
    const view = await mount(ready(), { onLoadOlder });
    const older = button(view.root, "加载更早");
    await renderer.act(async () => (older?.props.onPress as (() => void) | undefined)?.());
    expect(onLoadOlder).toHaveBeenCalledWith("older");
    await renderer.act(async () => view.unmount());

    const onRefresh = vi.fn();
    for (const state of [
      engineGetState({ runContractVersion: 1, status: "missing", run: null, issues: [] }),
      engineGetState({ runContractVersion: 1, status: "corrupt", run: null, issues: [] }),
      engineGetState({ runContractVersion: 1, status: "unknown-version", run: null, issues: [] }),
      engineGetState({
        runContractVersion: 1,
        status: "corrupt",
        run: null,
        issues: [
          {
            code: "run-projection-invalid",
            severity: "error",
            path: [],
            params: {},
            action: "refresh",
          },
        ],
      }),
      engineGetState({ nonsense: true }),
    ]) {
      const failure = await mount(state, { onRefresh });
      expect(textNodes(failure.root).join("\n")).toMatch(
        /找不到|无法读取|更新版本|无法显示|刷新插件/,
      );
      await renderer.act(async () =>
        (button(failure.root, zh.refresh)?.props.onPress as (() => void) | undefined)?.(),
      );
      expect(onRefresh).toHaveBeenCalled();
      await renderer.act(async () => failure.unmount());
      onRefresh.mockClear();
    }
  });

  test("compact layout uses the layered list while wide mode keeps the columns", async () => {
    const wide = await mount(ready());
    expect(wide.root.findAll((node) => node.type === "ScrollView")).toHaveLength(2);
    await renderer.act(async () => wide.unmount());
    const compact = await mount(ready(), { layout: { compact: true } });
    expect(compact.root.findAll((node) => node.type === "ScrollView")).toHaveLength(1);
    expect(textNodes(compact.root).join("\n")).toContain("第 1 层");
    await renderer.act(async () => compact.unmount());
  });

  test("the view never calls itself read-only, whatever the fixed DTO flag says", async () => {
    const view = await mount(
      ready(
        runView({
          capabilities: {
            runEngine: 1,
            observationOnly: false,
            enabled: false,
            supportedControls: [],
          },
        }),
      ),
    );
    expect(textNodes(view.root).join("\n")).not.toContain("只读");
    expect(view.root.findAll((node) => node.type === "Pressable").length).toBeGreaterThan(0);
    await renderer.act(async () => view.unmount());
  });

  test("budget rows show a read-only ratio and n/a without merging the three counts", async () => {
    const view = await mount(
      ready(
        runView({
          budgets: [
            {
              scope: "seat",
              subjectId: "seat-1",
              limit: 4,
              reserved: 2,
              confirmed: 0,
              observedTurns: 0,
            },
            {
              scope: "group",
              subjectId: "g",
              limit: 0,
              reserved: 0,
              confirmed: 0,
              observedTurns: 0,
            },
          ],
        }),
      ),
    );
    const text = textNodes(view.root).join("\n");
    expect(text).toContain("预扣 2 · 确认 0 · 观察回合 0 · 上限 4");
    expect(text).toContain("比例 50%");
    expect(text).toContain("比例 n/a");
    await renderer.act(async () => view.unmount());
  });

  test("history renders newest first across older pages and disables paging while loading", async () => {
    const view = await mount(ready(runView(), page([5, 6], "head")), {
      older: [page([3, 4], "tail")],
    });
    const text = textNodes(view.root).join("\n");
    const six = text.indexOf("#6");
    const five = text.indexOf("#5");
    const four = text.indexOf("#4");
    const three = text.indexOf("#3");
    expect(six).toBeGreaterThanOrEqual(0);
    expect(six).toBeLessThan(five);
    expect(five).toBeLessThan(four);
    expect(four).toBeLessThan(three);
    expect(button(view.root, "加载更早")?.props.disabled).toBe(false);
    await renderer.act(async () => view.unmount());

    const loading = await mount(ready(), { loadingOlder: true });
    expect(button(loading.root, "加载更早")?.props.disabled).toBe(true);
    await renderer.act(async () => loading.unmount());
  });
});

describe("EngineView controls", () => {
  const DECISION = "6f1c2a44-3b7e-4f0a-9a11-000000000001";
  const retryDecision = (): RunDetailView["decisions"][number] => ({
    decisionId: DECISION,
    category: "D3",
    state: "open",
    subjectId: "T1",
    summary: "质量阶梯已用完",
    createdAt: AT,
    answeredAction: null,
    actions: ["retry"],
  });
  const withControls = (names: string[], extra: Partial<RunDetailView> = {}) =>
    ready(
      runView({
        capabilities: {
          runEngine: 1,
          observationOnly: true,
          enabled: false,
          supportedControls: names,
        },
        ...extra,
      }),
    );
  const handlers = () => ({
    state: { pending: null, notice: null } as never,
    onReplan: vi.fn(),
    onRetry: vi.fn(),
    onKick: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onDismiss: vi.fn(),
  });
  const press = (root: Node, label: string) =>
    renderer.act(async () => (button(root, label)?.props.onPress as (() => void) | undefined)?.());
  const disabled = (root: Node, label: string) =>
    (button(root, label)?.props.accessibilityState as { disabled?: boolean } | undefined)?.disabled;

  test("a button appears only for a control the server named", async () => {
    const view = await mount(withControls(["kick"]), { controls: handlers() });
    expect(button(view.root, zh.controls.kick.button)).toBeDefined();
    expect(button(view.root, zh.controls.replan.submit)).toBeUndefined();
    expect(textNodes(view.root).join("\n")).not.toContain(zh.noControls);
    await renderer.act(async () => view.unmount());
  });

  test("pause and resume appear only when named, each calls its own handler without a confirmation, and pause says what it does", async () => {
    const calls = handlers();
    const running = await mount(withControls(["kick", "pause"]), { controls: calls });
    expect(button(running.root, zh.controls.resume.button)).toBeUndefined();
    expect(textNodes(running.root).join("\n")).toContain(zh.controls.pause.help);
    await press(running.root, zh.controls.pause.button);
    expect(calls.onPause).toHaveBeenCalledTimes(1);
    expect(calls.onResume).not.toHaveBeenCalled();
    await renderer.act(async () => running.unmount());

    const paused = await mount(withControls(["kick", "resume"]), { controls: calls });
    expect(button(paused.root, zh.controls.pause.button)).toBeUndefined();
    await press(paused.root, zh.controls.resume.button);
    expect(calls.onResume).toHaveBeenCalledTimes(1);
    await renderer.act(async () => paused.unmount());

    const busy = await mount(withControls(["pause"]), {
      controls: { ...calls, state: { pending: "pause", notice: null } },
    });
    expect(disabled(busy.root, zh.controls.pause.button)).toBe(true);
    await renderer.act(async () => busy.unmount());
  });

  test("nothing named: no button, and the view says there is nothing to do", async () => {
    const view = await mount(withControls([]), { controls: handlers() });
    expect(button(view.root, zh.controls.kick.button)).toBeUndefined();
    expect(button(view.root, zh.controls.replan.submit)).toBeUndefined();
    expect(textNodes(view.root).join("\n")).toContain(zh.noControls);
    await renderer.act(async () => view.unmount());
  });

  test("no controls handed in: not even the section is drawn", async () => {
    const view = await mount(withControls(["kick", "replan", "decide"]));
    expect(textNodes(view.root).join("\n")).not.toContain(zh.controls.title);
    await renderer.act(async () => view.unmount());
  });

  test("kick calls the handler, and all buttons are disabled while a request is in flight", async () => {
    const calls = handlers();
    const view = await mount(withControls(["kick", "replan"]), { controls: calls });
    expect(disabled(view.root, zh.controls.kick.button)).toBe(false);
    await press(view.root, zh.controls.kick.button);
    expect(calls.onKick).toHaveBeenCalledTimes(1);
    await renderer.act(async () => view.unmount());

    const busy = await mount(withControls(["kick", "replan"]), {
      controls: { ...calls, state: { pending: "kick", notice: null } },
    });
    expect(disabled(busy.root, zh.controls.kick.button)).toBe(true);
    expect(disabled(busy.root, zh.controls.replan.submit)).toBe(true);
    expect(textNodes(busy.root).join("\n")).toContain(zh.controls.pending);
    await renderer.act(async () => busy.unmount());
  });

  test("replan needs a reason: a blank press only says so, a written one is sent", async () => {
    const calls = handlers();
    const view = await mount(withControls(["replan"]), { controls: calls });
    await press(view.root, zh.controls.replan.submit);
    expect(calls.onReplan).not.toHaveBeenCalled();
    expect(textNodes(view.root).join("\n")).toContain(zh.controls.replan.needReason);

    const input = view.root.findAll((node) => node.type === "TextInput")[0];
    await renderer.act(async () =>
      (input?.props.onChangeText as ((text: string) => void) | undefined)?.("缺少 API"),
    );
    expect(textNodes(view.root).join("\n")).not.toContain(zh.controls.replan.needReason);
    await press(view.root, zh.controls.replan.submit);
    expect(calls.onReplan).toHaveBeenCalledWith("缺少 API");
    await renderer.act(async () => view.unmount());
  });

  test("a retry is offered per decision, and needs a confirmation that says what it will do", async () => {
    const calls = handlers();
    const view = await mount(
      withControls(["decide"], {
        decisions: [retryDecision()],
        tasks: [task("T1", { title: "Core" })],
      }),
      { controls: calls },
    );
    const label = `${zh.controls.retry.button} Core`;
    await press(view.root, label);
    expect(calls.onRetry).not.toHaveBeenCalled();
    const dialog = view.root.findAll((node) => node.type === "Modal")[0];
    expect(dialog?.props.title).toBe(zh.controls.retry.confirmTitle);
    expect(textNodes(view.root).join("\n")).toContain(zh.controls.retry.explain.D3 as string);

    await press(view.root, zh.controls.retry.confirm);
    expect(calls.onRetry).toHaveBeenCalledTimes(1);
    expect(calls.onRetry.mock.calls[0]?.[0]).toMatchObject({
      decisionId: DECISION,
      category: "D3",
    });
    await renderer.act(async () => view.unmount());
  });

  test("cancelling the confirmation sends nothing", async () => {
    const calls = handlers();
    const view = await mount(
      withControls(["decide"], {
        decisions: [retryDecision()],
        tasks: [task("T1", { title: "Core" })],
      }),
      { controls: calls },
    );
    await press(view.root, `${zh.controls.retry.button} Core`);
    await press(view.root, zh.controls.retry.cancel);
    expect(calls.onRetry).not.toHaveBeenCalled();
    expect(view.root.findAll((node) => node.type === "Modal")).toHaveLength(0);
    await renderer.act(async () => view.unmount());
  });

  test("a decision the server did not offer a retry for gets no button", async () => {
    const view = await mount(
      withControls(["decide"], { decisions: [{ ...retryDecision(), actions: [] }] }),
      { controls: handlers() },
    );
    expect(
      view.root
        .findAll((node) => node.type === "Pressable")
        .some((node) => String(node.props.accessibilityLabel).startsWith(zh.controls.retry.button)),
    ).toBe(false);
    await renderer.act(async () => view.unmount());
  });

  test("the answer is shown in words and can be dismissed", async () => {
    const calls = handlers();
    const notice = { tone: "warning", text: "Run 在你查看之后又有了变化", refresh: true };
    const view = await mount(withControls(["kick"]), {
      controls: { ...calls, state: { pending: null, notice } },
    });
    expect(textNodes(view.root).join("\n")).toContain(notice.text);
    await press(view.root, notice.text);
    expect(calls.onDismiss).toHaveBeenCalledTimes(1);
    await renderer.act(async () => view.unmount());
  });
});

describe("EngineView says why, who and what next", () => {
  test("an expanded task shows the three lines for its waiting reason", async () => {
    const view = await mount(
      ready(
        runView({
          tasks: [
            task("T1", {
              state: "in_progress",
              waitingReason: "dispatch-blocked:workspace-dirty",
            }),
          ],
        }),
      ),
    );
    await renderer.act(async () =>
      (button(view.root, "展开 T1")?.props.onPress as (() => void) | undefined)?.(),
    );
    const text = textNodes(view.root).join("\n");
    expect(text).toContain(`${zh.explain.why}：`);
    expect(text).toContain("工作树不干净");
    expect(text).toContain(`${zh.explain.who}：`);
    expect(text).toContain(`${zh.explain.next}：`);
    await renderer.act(async () => view.unmount());
  });

  test("a decision says who answers it, and whether this page can", async () => {
    const view = await mount(
      ready(
        runView({
          decisions: [
            {
              decisionId: "6f1c2a44-3b7e-4f0a-9a11-000000000001",
              category: "D3",
              state: "open",
              subjectId: "T1",
              summary: "x",
              createdAt: AT,
              answeredAction: null,
              actions: ["retry"],
            },
          ],
        }),
      ),
    );
    const text = textNodes(view.root).join("\n");
    expect(text).toContain(`${zh.explain.who}：你`);
    await renderer.act(async () => view.unmount());
  });

  test("every history event carries its cause, and a kind nobody has words for is not hidden", async () => {
    const history = {
      events: [
        { seq: 1, kind: "task-dispatched", at: AT, taskId: "T1", summary: "task-dispatched" },
        { seq: 2, kind: "from-the-future", at: AT, taskId: null, summary: "from-the-future" },
      ],
      nextCursor: null,
    };
    const view = await mount(ready(runView(), history));
    const text = textNodes(view.root).join("\n");
    expect(text).toContain("有合格席位和锁");
    expect(text).toContain("没有这类事件的说明");
    await renderer.act(async () => view.unmount());
  });
});

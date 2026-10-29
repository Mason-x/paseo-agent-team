import { createElement as h } from "react";
// @ts-expect-error react-test-renderer ships no types here; TestRenderer below is the subset used.
import * as reactTestRenderer from "react-test-renderer";
import { describe, expect, test, vi } from "vitest";

vi.mock("react-native", () => {
  const host = (name: string) => (props: Record<string, unknown>) =>
    h(name, props, props.children as never);
  return { View: host("View"), Text: host("Text"), Pressable: host("Pressable") };
});
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  ScrollView: (props: Record<string, unknown>) => h("ScrollView", props, props.children as never),
}));

import { EngineView } from "../../client/runs/engine/EngineView";
import { type EngineState, engineGetState } from "../../shared/domain/run-engine/view";
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
    expect(text.join("\n")).toContain(zh.readOnly);
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
    await renderer.act(async () => view.unmount());
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

  test("a false DTO capability hides the read-only banner without adding controls", async () => {
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
    expect(textNodes(view.root).join("\n")).not.toContain(zh.readOnly);
    expect(view.root.findAll((node) => node.type === "Pressable").length).toBeGreaterThan(0);
    await renderer.act(async () => view.unmount());
  });
});

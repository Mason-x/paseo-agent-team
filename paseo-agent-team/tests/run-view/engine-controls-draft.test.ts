import { createElement as h, useState } from "react";
// @ts-expect-error react-test-renderer ships no types here; TestRenderer below is the subset used.
import * as reactTestRenderer from "react-test-renderer";
import { beforeEach, describe, expect, test, vi } from "vitest";

const shared = vi.hoisted(() => ({
  /** What `useEngineRun` answers for each run: the page's polling state, set by the test. */
  sessions: new Map<string, { state: unknown; older: unknown[] }>(),
  /** One function per RPC for every render, so the controls' runner never restarts on its own. */
  rpc: new Map<string, ReturnType<typeof vi.fn>>(),
  /** What each RPC answers; `applied` unless the test says otherwise. */
  answers: new Map<string, unknown>(),
  refresh: vi.fn(async () => undefined),
}));

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
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (contract: { name: string }) => {
    const known = shared.rpc.get(contract.name);
    if (known !== undefined) return known;
    const made = vi.fn(async () => shared.answers.get(contract.name));
    shared.rpc.set(contract.name, made);
    return made;
  },
}));
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
    // An uncontrolled box, as on the screen: it shows what it was seeded with when it was drawn, then what
    // is typed into it. A later `defaultValue` changes nothing; only drawing the box again does.
    TextInput: (props: Record<string, unknown>) => {
      const [shown, setShown] = useState(String(props.defaultValue ?? ""));
      return h("TextInput", {
        ...props,
        shown,
        onChangeText: (text: string) => {
          setShown(text);
          (props.onChangeText as ((text: string) => void) | undefined)?.(text);
        },
      });
    },
    Icon: () => null,
  };
});
// The detail pane's own polling is not under test: the test says what each poll answered.
vi.mock("../../client/runs/engine/use-engine-run", () => ({
  useEngineRun: (_hostId: string, runId: string) => ({
    session: shared.sessions.get(runId) ?? { state: null, older: [] },
    error: null,
    loadingOlder: false,
    refresh: shared.refresh,
    loadOlder: async () => undefined,
  }),
}));

import { RunDetailPane } from "../../client/runs/engine/EngineRunsSection";
import { type EngineState, engineGetState } from "../../shared/domain/run-engine/view";
import {
  runBudgetRpc,
  runCancelRpc,
  runDecideRpc,
  runReplanRpc,
} from "../../shared/rpc/run-engine";
import type { RunDetailView } from "../../shared/schemas/run-engine/rpc";
import { runEngineZh as zh } from "../../shared/zh/run-engine";

/**
 * The reasons a person types for a new plan and for cancelling a Run are written in a text box, then
 * the Runs page polls. A poll that cannot show the Run (the read failed, the page was offline, an
 * `unchanged` answer that did not line up) takes the controls off the screen; when the Run comes
 * back the controls are drawn again. The words the person had written must still be in the box, and
 * the request must carry them. Failure modes: an empty box after the page flickered, a draft that
 * follows the person to another Run, a draft that is sent again after it was already used.
 */

type Node = {
  type: unknown;
  props: Record<string, unknown>;
  findAll(predicate: (node: Node) => boolean): Node[];
};
type Mounted = { root: Node; unmount(): void; update(element: unknown): void };
type TestRenderer = {
  act(callback: () => Promise<void> | void): Promise<void>;
  create(element: unknown): Mounted;
};
const renderer = reactTestRenderer as unknown as TestRenderer;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const theme = new Proxy({ colors: new Proxy({}, { get: () => "#000" }) }, {}) as never;
const layout = { compact: false };

function runView(
  runId: string,
  revision: number,
  controls: string[],
  extra: Partial<RunDetailView> = {},
): RunDetailView {
  return {
    runId,
    revision,
    lifecycle: "active",
    team: { id: "team", name: "Team", rawMode: "economy", modeContract: 2, plannerVersion: 2 },
    dagRevision: 1,
    dag: { revision: 1, tasks: [] },
    tasks: [],
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
      tasks: 0,
      reworks: 0,
      firstReviewAccepted: 0,
      coverage: "complete",
    },
    capabilities: {
      runEngine: 1,
      observationOnly: true,
      enabled: false,
      supportedControls: controls,
    },
    issues: [],
    ...extra,
  };
}

const HISTORY = { events: [], nextCursor: null };

/** A ready answer. Every call builds a new object: a poll's answer never is the one before it. */
function ready(
  runId: string,
  revision: number,
  controls: string[],
  extra: Partial<RunDetailView> = {},
): EngineState {
  const state = engineGetState({
    runContractVersion: 1,
    status: "ready",
    run: runView(runId, revision, controls, extra),
    history: HISTORY,
    issues: [],
  });
  if (state.kind !== "ready") throw new Error("expected ready");
  return state;
}

/** The three ways a poll does not give back a Run the page can show. */
const NOT_READY: { name: string; state: () => EngineState | null }[] = [
  {
    name: "the Run could not be read",
    state: () =>
      engineGetState({ runContractVersion: 1, status: "missing", issues: [] }) as EngineState,
  },
  { name: "the host is not connected (nothing known yet)", state: () => null },
  {
    name: "an unchanged answer that carries no Run",
    state: () => ({ kind: "unchanged", revision: 3 }),
  },
];

function show(runId: string, state: EngineState | null) {
  shared.sessions.set(runId, { state, older: [] });
}

const pane = (runId: string) => h(RunDetailPane, { theme, layout, hostId: "host", runId } as never);

async function mount(runId: string) {
  let view!: Mounted;
  await renderer.act(async () => {
    view = renderer.create(pane(runId));
  });
  return view;
}
/** The page renders again with whatever the last poll answered. */
const render = (view: Mounted, runId: string) => renderer.act(async () => view.update(pane(runId)));

function inputs(root: Node, label: string): Node[] {
  return root.findAll(
    (node) => node.type === "TextInput" && node.props.accessibilityLabel === label,
  );
}
function button(root: Node, label: string): Node | undefined {
  return root.findAll(
    (node) => node.type === "Pressable" && node.props.accessibilityLabel === label,
  )[0];
}
const press = (root: Node, label: string) =>
  renderer.act(async () => (button(root, label)?.props.onPress as (() => void) | undefined)?.());
const type = (root: Node, label: string, text: string) =>
  renderer.act(async () =>
    (inputs(root, label)[0]?.props.onChangeText as ((text: string) => void) | undefined)?.(text),
  );
const texts = (root: Node) =>
  root
    .findAll((node) => node.type === "Text")
    .map((node) =>
      Array.isArray(node.props.children)
        ? node.props.children.join("")
        : String(node.props.children ?? ""),
    )
    .join("\n");
/** The text the box shows. */
const draftIn = (root: Node, label: string) => inputs(root, label)[0]?.props.shown;
const sent = (name: string) => shared.rpc.get(name)?.mock.calls ?? [];

/** The two places a reason is typed, with the step that sends it. */
const FIELDS = [
  {
    name: "a new plan",
    controls: ["replan"],
    label: zh.controls.replan.reasonLabel,
    rpc: runReplanRpc.name,
    submit: async (root: Node) => {
      await press(root, zh.controls.replan.submit);
    },
    needReason: zh.controls.replan.needReason,
    answer: { runContractVersion: 1, status: "applied", revision: 4, epoch: 2, issues: [] },
  },
  {
    name: "cancelling the Run",
    controls: ["cancel"],
    label: zh.controls.cancelRun.reasonLabel,
    rpc: runCancelRpc.name,
    submit: async (root: Node) => {
      await press(root, zh.controls.cancelRun.submit);
      await press(root, zh.controls.cancelRun.confirm);
    },
    needReason: zh.controls.cancelRun.needReason,
    answer: {
      runContractVersion: 1,
      status: "applied",
      revision: 4,
      lifecycle: "cancelled",
      waiting: null,
      issues: [],
    },
  },
] as const;

beforeEach(() => {
  shared.sessions.clear();
  shared.rpc.clear();
  shared.answers.clear();
  shared.refresh.mockClear();
});

describe.each(FIELDS)("the reason typed for $name", (field) => {
  beforeEach(() => {
    shared.answers.set(field.rpc, field.answer);
  });

  test.each(NOT_READY)(
    "is still there, and is what is sent, after a poll where $name",
    async (notReady) => {
      show("run-aaa-111", ready("run-aaa-111", 3, [...field.controls]));
      const view = await mount("run-aaa-111");
      await type(view.root, field.label, "缺少 API");

      show("run-aaa-111", notReady.state());
      await render(view, "run-aaa-111");
      expect(inputs(view.root, field.label)).toHaveLength(0);

      show("run-aaa-111", ready("run-aaa-111", 4, [...field.controls]));
      await render(view, "run-aaa-111");
      expect(draftIn(view.root, field.label)).toBe("缺少 API");

      await field.submit(view.root);
      expect(sent(field.rpc)).toHaveLength(1);
      expect(sent(field.rpc)[0]?.[0]).toMatchObject({ runId: "run-aaa-111", reason: "缺少 API" });
      await renderer.act(async () => view.unmount());
    },
  );

  test("survives several polls that lose the Run in a row, and the last text typed wins", async () => {
    show("run-aaa-111", ready("run-aaa-111", 3, [...field.controls]));
    const view = await mount("run-aaa-111");
    await type(view.root, field.label, "缺少");
    for (const notReady of NOT_READY) {
      show("run-aaa-111", notReady.state());
      await render(view, "run-aaa-111");
    }
    show("run-aaa-111", ready("run-aaa-111", 4, [...field.controls]));
    await render(view, "run-aaa-111");
    expect(draftIn(view.root, field.label)).toBe("缺少");
    await type(view.root, field.label, "缺少 API");
    show("run-aaa-111", NOT_READY[0]?.state() ?? null);
    await render(view, "run-aaa-111");
    show("run-aaa-111", ready("run-aaa-111", 5, [...field.controls]));
    await render(view, "run-aaa-111");
    expect(draftIn(view.root, field.label)).toBe("缺少 API");
    await renderer.act(async () => view.unmount());
  });

  // The page draws one pane per Run, so the pane never really switches Runs; this keeps the key honest.
  test("is not shared with another Run's detail, and is still there when the first one is drawn again", async () => {
    show("run-aaa-111", ready("run-aaa-111", 3, [...field.controls]));
    show("run-bbb-222", ready("run-bbb-222", 7, [...field.controls]));
    const view = await mount("run-aaa-111");
    await type(view.root, field.label, "缺少 API");

    await render(view, "run-bbb-222");
    expect(draftIn(view.root, field.label) ?? "").toBe("");
    await field.submit(view.root);
    expect(sent(field.rpc)).toHaveLength(0);
    expect(texts(view.root)).toContain(field.needReason);

    await render(view, "run-aaa-111");
    expect(draftIn(view.root, field.label)).toBe("缺少 API");
    await renderer.act(async () => view.unmount());
  });

  test("is used once: after the server took it the box is empty and nothing is sent again", async () => {
    show("run-aaa-111", ready("run-aaa-111", 3, [...field.controls]));
    const view = await mount("run-aaa-111");
    await type(view.root, field.label, "缺少 API");
    await field.submit(view.root);
    expect(sent(field.rpc)).toHaveLength(1);

    show("run-aaa-111", ready("run-aaa-111", 4, [...field.controls]));
    await render(view, "run-aaa-111");
    expect(draftIn(view.root, field.label) ?? "").toBe("");
    await field.submit(view.root);
    expect(sent(field.rpc)).toHaveLength(1);
    expect(texts(view.root)).toContain(field.needReason);
    await renderer.act(async () => view.unmount());
  });

  test("is kept when the server refused the request, so it can be tried again", async () => {
    shared.answers.set(field.rpc, {
      ...field.answer,
      status: "rejected",
      issues: [{ code: "revision-conflict", severity: "error", params: {} }],
    });
    show("run-aaa-111", ready("run-aaa-111", 3, [...field.controls]));
    const view = await mount("run-aaa-111");
    await type(view.root, field.label, "缺少 API");
    await field.submit(view.root);
    expect(sent(field.rpc)).toHaveLength(1);

    show("run-aaa-111", ready("run-aaa-111", 4, [...field.controls]));
    await render(view, "run-aaa-111");
    expect(draftIn(view.root, field.label)).toBe("缺少 API");
    await renderer.act(async () => view.unmount());
  });

  test("stays an uncontrolled input: no value is handed to it, and nothing is written while the IME composes", async () => {
    show("run-aaa-111", ready("run-aaa-111", 3, [...field.controls]));
    const view = await mount("run-aaa-111");
    const input = () => inputs(view.root, field.label)[0];
    expect(input()).toBeDefined();
    expect(Object.hasOwn(input()?.props ?? {}, "value")).toBe(false);

    const call = (name: string, ...args: unknown[]) =>
      renderer.act(async () =>
        (input()?.props[name] as ((...a: unknown[]) => void) | undefined)?.(...args),
      );
    await type(view.root, field.label, "缺少");
    await call("onCompositionStart");
    await call("onChangeText", "缺少 ni");
    // The person is still composing: the half-written text is not the draft yet, and the box was
    // not given anything to show in its place.
    expect(Object.hasOwn(input()?.props ?? {}, "value")).toBe(false);
    show("run-aaa-111", NOT_READY[0]?.state() ?? null);
    await render(view, "run-aaa-111");
    show("run-aaa-111", ready("run-aaa-111", 4, [...field.controls]));
    await render(view, "run-aaa-111");
    expect(draftIn(view.root, field.label)).toBe("缺少");

    // The box was drawn again, so its composition state is new: the person starts composing again,
    // and the half-written text is again not the draft (a poll that loses the Run now takes it away).
    await call("onCompositionStart");
    await call("onChangeText", "缺少 你好");
    expect(Object.hasOwn(input()?.props ?? {}, "value")).toBe(false);
    show("run-aaa-111", NOT_READY[1]?.state() ?? null);
    await render(view, "run-aaa-111");
    show("run-aaa-111", ready("run-aaa-111", 5, [...field.controls]));
    await render(view, "run-aaa-111");
    expect(draftIn(view.root, field.label)).toBe("缺少");

    // Finished composing: now the text is the draft.
    await call("onCompositionStart");
    await call("onChangeText", "缺少 你好");
    await call("onCompositionEnd");
    show("run-aaa-111", NOT_READY[2]?.state() ?? null);
    await render(view, "run-aaa-111");
    show("run-aaa-111", ready("run-aaa-111", 6, [...field.controls]));
    await render(view, "run-aaa-111");
    expect(draftIn(view.root, field.label)).toBe("缺少 你好");
    expect(Object.hasOwn(input()?.props ?? {}, "value")).toBe(false);
    await renderer.act(async () => view.unmount());
  });

  // The request carries at most 600 characters; the box does not let more be typed, so nothing is
  // cut out of sight and then cleared with the rest once the server took it.
  test("holds at most the 600 characters a request carries", async () => {
    show("run-aaa-111", ready("run-aaa-111", 3, [...field.controls]));
    const view = await mount("run-aaa-111");
    expect(inputs(view.root, field.label)[0]?.props.maxLength).toBe(600);
    await renderer.act(async () => view.unmount());
  });
});

const DECISION = "6f1c2a44-3b7e-4f0a-9a11-000000000001";
const SEAT = "seat-b1";
const AT = "2026-10-29T01:02:03.000Z";

/** One failed task with a retry and a cancel on offer, and one seat out of turns. */
const OFFERS: Partial<RunDetailView> = {
  decisions: [
    {
      decisionId: DECISION,
      category: "D3",
      state: "open",
      subjectId: "T1",
      summary: "质量阶梯已用完",
      createdAt: AT,
      answeredAction: null,
      actions: ["retry", "cancel"],
    },
  ],
  budgets: [
    { scope: "seat", subjectId: SEAT, limit: 2, reserved: 2, confirmed: 1, observedTurns: 1 },
  ],
};
const ALL_CONTROLS = ["decide", "budget", "cancel"];
const offered = (runId: string, revision: number, extra: Partial<RunDetailView> = OFFERS) =>
  ready(runId, revision, ALL_CONTROLS, extra);
const BY_LABEL = `${zh.controls.budget.byLabel} ${SEAT}`;
const dialogs = (root: Node) => root.findAll((node) => node.type === "Modal");
const dialogTitles = (root: Node) => dialogs(root).map((node) => node.props.title);

/** Every confirmation of the controls: how it is opened, what it says, and what pressing it sends. */
const CONFIRMATIONS = [
  {
    name: "retrying a task",
    title: zh.controls.retry.confirmTitle,
    open: async (root: Node) => {
      await press(root, `${zh.controls.retry.button} T1`);
    },
    confirm: zh.controls.retry.confirm,
    cancel: zh.controls.retry.cancel,
    rpc: runDecideRpc.name,
    answer: {
      runContractVersion: 1,
      status: "applied",
      revision: 4,
      decisionId: DECISION,
      taskId: "T1",
      issues: [],
    },
    sends: { decisionId: DECISION, answer: { action: "retry" } },
  },
  {
    name: "cancelling a task",
    title: zh.controls.cancelTask.confirmTitle,
    open: async (root: Node) => {
      await press(root, `${zh.controls.cancelTask.button} T1`);
    },
    confirm: zh.controls.cancelTask.confirm,
    cancel: zh.controls.cancelTask.cancel,
    rpc: runDecideRpc.name,
    answer: {
      runContractVersion: 1,
      status: "applied",
      revision: 4,
      decisionId: DECISION,
      taskId: "T1",
      issues: [],
    },
    sends: { decisionId: DECISION, answer: { action: "cancel" } },
  },
  {
    name: "adding turns to a seat",
    title: zh.controls.budget.confirmTitle,
    open: async (root: Node) => {
      await type(root, BY_LABEL, "12");
      await press(root, `${zh.controls.budget.button} ${SEAT}`);
    },
    confirm: zh.controls.budget.confirm,
    cancel: zh.controls.budget.cancel,
    rpc: runBudgetRpc.name,
    answer: {
      runContractVersion: 1,
      status: "applied",
      revision: 4,
      seatId: SEAT,
      limit: 14,
      issues: [],
    },
    sends: { seatId: SEAT, by: 12 },
    says: zh.controls.budget.willBe(SEAT, 12, 14),
  },
  {
    name: "cancelling the Run",
    title: zh.controls.cancelRun.confirmTitle,
    open: async (root: Node) => {
      await type(root, zh.controls.cancelRun.reasonLabel, "缺少 API");
      await press(root, zh.controls.cancelRun.submit);
    },
    confirm: zh.controls.cancelRun.confirm,
    cancel: zh.controls.cancelRun.cancel,
    rpc: runCancelRpc.name,
    answer: {
      runContractVersion: 1,
      status: "applied",
      revision: 4,
      lifecycle: "cancelled",
      waiting: null,
      issues: [],
    },
    sends: { reason: "缺少 API" },
  },
] as const;

// The pane stays on the screen while a poll cannot show the Run, but the controls (the turns box and every
// confirmation) are drawn off it; they must come back as the person left them.
describe("the turns box of the controls", () => {
  beforeEach(() => {
    shared.answers.set(runBudgetRpc.name, CONFIRMATIONS[2].answer);
  });

  test.each(NOT_READY)(
    "keeps the number typed, and adds that many, after a poll where $name",
    async (notReady) => {
      show("run-aaa-111", offered("run-aaa-111", 3));
      const view = await mount("run-aaa-111");
      expect(draftIn(view.root, BY_LABEL)).toBe("4");
      await type(view.root, BY_LABEL, "12");

      show("run-aaa-111", notReady.state());
      await render(view, "run-aaa-111");
      expect(inputs(view.root, BY_LABEL)).toHaveLength(0);
      show("run-aaa-111", offered("run-aaa-111", 4));
      await render(view, "run-aaa-111");
      expect(draftIn(view.root, BY_LABEL)).toBe("12");

      await press(view.root, `${zh.controls.budget.button} ${SEAT}`);
      await press(view.root, zh.controls.budget.confirm);
      expect(sent(runBudgetRpc.name)).toHaveLength(1);
      expect(sent(runBudgetRpc.name)[0]?.[0]).toMatchObject({ seatId: SEAT, by: 12 });
      await renderer.act(async () => view.unmount());
    },
  );

  test("is not shared with another Run's detail, and is still there when the first one is drawn again", async () => {
    show("run-aaa-111", offered("run-aaa-111", 3));
    show("run-bbb-222", offered("run-bbb-222", 7));
    const view = await mount("run-aaa-111");
    await type(view.root, BY_LABEL, "12");
    await render(view, "run-bbb-222");
    expect(draftIn(view.root, BY_LABEL)).toBe("4");
    await render(view, "run-aaa-111");
    expect(draftIn(view.root, BY_LABEL)).toBe("12");
    await renderer.act(async () => view.unmount());
  });

  test("stays an uncontrolled input: no value is handed to it", async () => {
    show("run-aaa-111", offered("run-aaa-111", 3));
    const view = await mount("run-aaa-111");
    await type(view.root, BY_LABEL, "12");
    expect(Object.hasOwn(inputs(view.root, BY_LABEL)[0]?.props ?? {}, "value")).toBe(false);
    await renderer.act(async () => view.unmount());
  });
});

describe.each(CONFIRMATIONS)("the confirmation for $name", (confirmation) => {
  beforeEach(() => {
    shared.answers.set(confirmation.rpc, confirmation.answer);
  });

  test.each(NOT_READY)(
    "is still open after a poll where $name, and sending it closes it",
    async (notReady) => {
      show("run-aaa-111", offered("run-aaa-111", 3));
      const view = await mount("run-aaa-111");
      await confirmation.open(view.root);
      expect(dialogTitles(view.root)).toEqual([confirmation.title]);

      show("run-aaa-111", notReady.state());
      await render(view, "run-aaa-111");
      expect(dialogs(view.root)).toHaveLength(0);
      show("run-aaa-111", offered("run-aaa-111", 4));
      await render(view, "run-aaa-111");
      expect(dialogTitles(view.root)).toEqual([confirmation.title]);
      if ("says" in confirmation) expect(texts(view.root)).toContain(confirmation.says);
      expect(sent(confirmation.rpc)).toHaveLength(0);

      await press(view.root, confirmation.confirm);
      expect(sent(confirmation.rpc)).toHaveLength(1);
      expect(sent(confirmation.rpc)[0]?.[0]).toMatchObject(confirmation.sends);
      expect(dialogs(view.root)).toHaveLength(0);
      show("run-aaa-111", offered("run-aaa-111", 5));
      await render(view, "run-aaa-111");
      expect(dialogs(view.root)).toHaveLength(0);
      await renderer.act(async () => view.unmount());
    },
  );

  test("stays shut after the person cancelled it, whatever the polls do", async () => {
    show("run-aaa-111", offered("run-aaa-111", 3));
    const view = await mount("run-aaa-111");
    await confirmation.open(view.root);
    await press(view.root, confirmation.cancel);
    expect(dialogs(view.root)).toHaveLength(0);

    show("run-aaa-111", NOT_READY[0]?.state() ?? null);
    await render(view, "run-aaa-111");
    show("run-aaa-111", offered("run-aaa-111", 4));
    await render(view, "run-aaa-111");
    expect(dialogs(view.root)).toHaveLength(0);
    expect(sent(confirmation.rpc)).toHaveLength(0);
    await renderer.act(async () => view.unmount());
  });

  test("is not shown for another Run's detail, and is still open when the first one is drawn again", async () => {
    show("run-aaa-111", offered("run-aaa-111", 3));
    show("run-bbb-222", offered("run-bbb-222", 7));
    const view = await mount("run-aaa-111");
    await confirmation.open(view.root);
    await render(view, "run-bbb-222");
    expect(dialogs(view.root)).toHaveLength(0);
    await render(view, "run-aaa-111");
    expect(dialogTitles(view.root)).toEqual([confirmation.title]);
    await renderer.act(async () => view.unmount());
  });
});

describe("a confirmation whose offer is gone", () => {
  test("is dropped, and does not open again when the same offer comes back later", async () => {
    show("run-aaa-111", offered("run-aaa-111", 3));
    const view = await mount("run-aaa-111");
    await press(view.root, `${zh.controls.retry.button} T1`);
    await type(view.root, BY_LABEL, "12");
    expect(dialogs(view.root)).toHaveLength(1);

    // The decision was answered elsewhere: nothing is offered any more.
    show("run-aaa-111", offered("run-aaa-111", 4, { decisions: [], budgets: [] }));
    await render(view, "run-aaa-111");
    expect(dialogs(view.root)).toHaveLength(0);

    show("run-aaa-111", offered("run-aaa-111", 5));
    await render(view, "run-aaa-111");
    expect(dialogs(view.root)).toHaveLength(0);
    await renderer.act(async () => view.unmount());
  });
});

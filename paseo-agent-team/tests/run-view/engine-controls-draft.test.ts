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
import { runCancelRpc, runReplanRpc } from "../../shared/rpc/run-engine";
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

function runView(runId: string, revision: number, controls: string[]): RunDetailView {
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
  };
}

const HISTORY = { events: [], nextCursor: null };

/** A ready answer. Every call builds a new object: a poll's answer never is the one before it. */
function ready(runId: string, revision: number, controls: string[]): EngineState {
  const state = engineGetState({
    runContractVersion: 1,
    status: "ready",
    run: runView(runId, revision, controls),
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

  test("does not follow the person to another Run, and is waiting when they come back", async () => {
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

    await call("onChangeText", "缺少 你好");
    await call("onCompositionEnd");
    show("run-aaa-111", NOT_READY[1]?.state() ?? null);
    await render(view, "run-aaa-111");
    show("run-aaa-111", ready("run-aaa-111", 5, [...field.controls]));
    await render(view, "run-aaa-111");
    expect(draftIn(view.root, field.label)).toBe("缺少 你好");
    expect(Object.hasOwn(input()?.props ?? {}, "value")).toBe(false);
    await renderer.act(async () => view.unmount());
  });
});

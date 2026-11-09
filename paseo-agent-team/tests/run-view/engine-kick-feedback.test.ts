import { createElement as h, useState } from "react";
// @ts-expect-error react-test-renderer ships no types here; TestRenderer below is the subset used.
import * as reactTestRenderer from "react-test-renderer";
import { beforeEach, describe, expect, test, vi } from "vitest";

const shared = vi.hoisted(() => ({
  sessions: new Map<string, { state: unknown; older: unknown[] }>(),
  rpc: new Map<string, ReturnType<typeof vi.fn>>(),
  answers: new Map<string, unknown>(),
  refresh: vi.fn(async () => undefined),
  /** What the next read of the Run changes (the Run moves on); null leaves it as it is. */
  advance: null as (() => void) | null,
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
    TextInput: (props: Record<string, unknown>) => h("TextInput", props),
    Icon: () => null,
  };
});
vi.mock("../../client/runs/engine/use-engine-run", () => ({
  useEngineRun: (_hostId: string, runId: string) => {
    // As the real hook: a read that gives a new state draws the pane again.
    const [, redraw] = useState(0);
    return {
      session: shared.sessions.get(runId) ?? { state: null, older: [] },
      error: null,
      loadingOlder: false,
      refresh: async () => {
        await shared.refresh();
        shared.advance?.();
        redraw((count) => count + 1);
      },
      loadOlder: async () => undefined,
    };
  },
}));

import { RunDetailPane } from "../../client/runs/engine/EngineRunsSection";
import { engineGetState } from "../../shared/domain/run-engine/view";
import { runKickRpc } from "../../shared/rpc/run-engine";
import { runEngineZh as zh } from "../../shared/zh/run-engine";

type Node = {
  type: unknown;
  parent: Node | null;
  props: Record<string, unknown>;
  children: unknown[];
  findAll(predicate: (node: Node) => boolean): Node[];
};
type Mounted = { root: Node; unmount(): void };
type TestRenderer = {
  act(callback: () => Promise<void> | void): Promise<void>;
  create(element: unknown): Mounted;
};
const renderer = reactTestRenderer as unknown as TestRenderer;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const theme = new Proxy({ colors: new Proxy({}, { get: () => "#000" }) }, {}) as never;
const RUN = "run-kick-111";

function readyState(controls: string[], revision = 30, lifecycle = "active") {
  const state = engineGetState({
    runContractVersion: 1,
    status: "ready",
    run: {
      runId: RUN,
      revision,
      lifecycle: lifecycle as never,
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
    },
    history: { events: [], nextCursor: null },
    issues: [],
  });
  if (state.kind !== "ready") throw new Error("expected ready");
  return state;
}

const textOf = (node: Node): string =>
  node.children
    .map((child) => (typeof child === "string" ? child : textOf(child as Node)))
    .join("");

beforeEach(() => {
  shared.sessions.clear();
  shared.rpc.clear();
  shared.answers.clear();
  shared.refresh.mockClear();
  shared.advance = null;
});

const IDLE_TEXT = "已检查：没有需要推进的事";

const KICK_OUTPUT = {
  runContractVersion: 1,
  status: "ok",
  outcome: "idle",
  dispatched: 0,
  revision: 30,
  reason: null,
  issues: [],
};

async function mount(controls: string[]) {
  shared.sessions.set(RUN, { state: readyState(controls), older: [] });
  let view!: Mounted;
  await renderer.act(async () => {
    view = renderer.create(
      h(RunDetailPane, { theme, layout: { compact: false }, hostId: "host", runId: RUN } as never),
    );
  });
  return view;
}
const pressable = (root: Node, label: string) =>
  root.findAll((node) => node.type === "Pressable" && node.props.accessibilityLabel === label)[0];
const press = (root: Node, label: string) => {
  const onPress = pressable(root, label)?.props.onPress as (() => void) | undefined;
  if (onPress === undefined) throw new Error(`no button "${label}"`);
  return renderer.act(async () => onPress());
};
/** The View the button sits in (the test renderer's parents also include the components around it). */
function groupOf(button: Node | undefined): Node {
  let node = button?.parent ?? null;
  while (node !== null && node.type !== "View") node = node.parent;
  if (node === null) throw new Error("the button is not in a group");
  return node;
}
const contains = (group: Node, inner: Node | undefined) =>
  group.findAll((node) => node === inner).length > 0;
const noticeNodes = (root: Node, text: string) =>
  root.findAll((node) => node.type === "Text" && textOf(node) === text);

describe("the notice after pressing the check button", () => {
  beforeEach(() => {
    shared.answers.set(runKickRpc.name, KICK_OUTPUT);
  });

  test("says in words that the check was made and found nothing to do", async () => {
    expect(zh.controls.result.kick.idle).toBe(IDLE_TEXT);
    const view = await mount(["kick", "pause"]);
    await press(view.root, zh.controls.kick.button);
    expect(noticeNodes(view.root, IDLE_TEXT)).toHaveLength(1);
    await renderer.act(async () => view.unmount());
  });

  // The controls are a long column (replan, retry, kick, pause, budget, cancel, ...). A sentence at the
  // end of the column is below the screen for the person who pressed the button: it has to be where the
  // button is.
  test("is drawn in the group of the button that was pressed, not at the end of all the controls", async () => {
    const view = await mount(["kick", "pause", "cancel"]);
    await press(view.root, zh.controls.kick.button);
    const [notice] = noticeNodes(view.root, IDLE_TEXT);
    expect(notice).toBeDefined();
    expect(contains(groupOf(pressable(view.root, zh.controls.kick.button)), notice)).toBe(true);
    // and it is not drawn a second time at the end of the controls
    expect(noticeNodes(view.root, IDLE_TEXT)).toHaveLength(1);
    await renderer.act(async () => view.unmount());
  });

  test("goes away when it is tapped, and the notice of another control stays where it was", async () => {
    shared.answers.set("agent-team.run.pause", {
      runContractVersion: 1,
      status: "applied",
      revision: 31,
      lifecycle: "paused",
      issues: [],
    });
    const view = await mount(["kick", "pause"]);
    await press(view.root, zh.controls.kick.button);
    await press(view.root, IDLE_TEXT);
    expect(noticeNodes(view.root, IDLE_TEXT)).toHaveLength(0);

    await press(view.root, zh.controls.pause.button);
    const paused = noticeNodes(view.root, zh.controls.pause.applied);
    expect(paused).toHaveLength(1);
    expect(contains(groupOf(pressable(view.root, zh.controls.kick.button)), paused[0])).toBe(false);
    expect(contains(groupOf(pressable(view.root, zh.controls.pause.button)), paused[0])).toBe(
      false,
    );
    await renderer.act(async () => view.unmount());
  });
});

describe("the answer of a kick that finishes the Run", () => {
  const FINISHED_OUTPUT = { ...KICK_OUTPUT, outcome: "finished", revision: 31 };

  // The kick group is only there while the server offers a kick. A kick that finishes the Run takes the
  // offer away with the next read, and the group goes with it: the answer must not go with it.
  test("is still said, once, after the read that takes the kick away", async () => {
    shared.answers.set(runKickRpc.name, FINISHED_OUTPUT);
    shared.advance = () => {
      shared.sessions.set(RUN, { state: readyState([], 31, "finished"), older: [] });
    };
    const view = await mount(["kick", "pause"]);
    expect(pressable(view.root, zh.controls.kick.button)).toBeDefined();
    await press(view.root, zh.controls.kick.button);

    expect(pressable(view.root, zh.controls.kick.button)).toBeUndefined();
    expect(noticeNodes(view.root, zh.controls.result.kick.finished)).toHaveLength(1);
    await renderer.act(async () => view.unmount());
  });

  test("is said once, in the kick group, when the read leaves the kick on offer", async () => {
    shared.answers.set(runKickRpc.name, KICK_OUTPUT);
    shared.advance = () => {
      shared.sessions.set(RUN, { state: readyState(["kick", "pause"], 31), older: [] });
    };
    const view = await mount(["kick", "pause"]);
    await press(view.root, zh.controls.kick.button);
    const notices = noticeNodes(view.root, IDLE_TEXT);
    expect(notices).toHaveLength(1);
    expect(contains(groupOf(pressable(view.root, zh.controls.kick.button)), notices[0])).toBe(true);
    await renderer.act(async () => view.unmount());
  });
});

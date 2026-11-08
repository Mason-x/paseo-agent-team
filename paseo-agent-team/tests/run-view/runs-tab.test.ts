import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement as h } from "react";
// @ts-expect-error react-test-renderer ships no types here; TestRenderer below is the subset used.
import * as reactTestRenderer from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const shared = vi.hoisted(() => ({
  /** What `run.list` answers, set by the test from the real server-side query. */
  list: null as null | ((input: unknown) => Promise<unknown>),
  /** The runs the label-derived list (the coordinator chain) finds on the host. */
  labelled: [] as unknown[],
  /** How many `run.list` calls have answered (or failed): the page has what the host knows when it is above 0. */
  answered: 0,
}));

vi.mock("react-native", () => {
  const host = (name: string) => (props: Record<string, unknown>) =>
    h(name, props, props.children as never);
  return {
    View: host("View"),
    Text: host("Text"),
    Pressable: host("Pressable"),
    Platform: { OS: "web" },
    AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
  };
});
vi.mock("@getpaseo/plugin/client", () => {
  // One function for every render: a new one each time would restart the page's poller on every render.
  const call = async (input: unknown) => {
    try {
      return await shared.list?.(input);
    } finally {
      shared.answered += 1;
    }
  };
  return { usePaseo: () => ({}), useRpc: () => call };
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
    useToast: () => ({ show: () => undefined, error: () => undefined }),
  };
});
vi.mock("../../client/runs/use-team-runs", () => ({
  useTeamRuns: () => ({
    runs: shared.labelled,
    workspaceNames: new Map(),
    error: null,
    isPending: false,
    refetch: async () => undefined,
  }),
}));

import { RunsTab } from "../../client/runs/RunsTab";
import { createRunQueries } from "../../server/run-engine/queries";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import type { RunAgentSnapshot, TeamRun } from "../../shared/domain/run-progress";
import { runEngineZh } from "../../shared/zh/run-engine";
import { bootstrapRun } from "../run-engine/support/bootstrap-run";
import { waitUntil } from "./support/wait-until";

/**
 * The Runs page lists the Engine's Runs (from the ledger, through `run.list`) above the Runs the
 * coordinator chain left on the host (from agent labels). The two lists never share state, so the page
 * needs nothing from the switch that starts Engine Runs: a Run that was started stays in front of the
 * person, next to the older ones. Failure modes: one list hiding the other, or the page asking for a
 * decision the switch alone could take away.
 */

type Node = {
  type: unknown;
  props: Record<string, unknown>;
  children: unknown[];
  findAll(predicate: (node: Node) => boolean): Node[];
};
type TestRenderer = {
  act(callback: () => Promise<void> | void): Promise<void>;
  create(element: unknown): { root: Node; unmount(): void };
};
const renderer = reactTestRenderer as unknown as TestRenderer;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const theme = new Proxy({ colors: new Proxy({}, { get: () => "#000" }) }, {}) as never;
const layout = { compact: false };

let home: string;
let store: RunStore;

beforeEach(async () => {
  shared.answered = 0;
  home = await realpath(await mkdtemp(path.join(tmpdir(), "run-tab-")));
  await mkdir(path.join(home, "paseo"));
  store = createRunStore({ home: path.join(home, "paseo"), lock: { acquireTimeoutMs: 300 } });
  await store.initialize();
});

afterEach(async () => {
  shared.list = null;
  shared.labelled = [];
  await store.close().catch(() => undefined);
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function agent(id: string): RunAgentSnapshot {
  const at = new Date().toISOString();
  return {
    id,
    title: id,
    provider: "claude",
    model: null,
    status: "running",
    createdAt: at,
    updatedAt: at,
    lastUserMessageAt: at,
  };
}

const textOf = (root: Node): string =>
  root
    .findAll((node) => node.type === "Text")
    .map((node) => node.children.filter((child) => typeof child === "string").join(""))
    .join("\n");

/** Renders the page and waits until the list has answered and the text satisfies `until`. */
async function render(
  until: (text: string) => boolean = () => true,
): Promise<{ text: string; unmount(): void }> {
  const navigation = {} as never;
  let tree: ReturnType<TestRenderer["create"]> | undefined;
  await renderer.act(async () => {
    tree = renderer.create(
      h(RunsTab, { theme, layout, hostId: "host-1", navigation, legacyRuns: [] }),
    );
  });
  if (!tree) throw new Error("not rendered");
  const page = tree;
  // The list answers on the first tick of its poller: wait for that, not for a guess of how long it takes.
  await waitUntil(renderer.act, () => shared.answered > 0 && until(textOf(page.root)), {
    label: "the Runs page to show the list",
  });
  // What the answer set in motion in React (one more turn), then read.
  await renderer.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { text: textOf(page.root), unmount: () => page.unmount() };
}

describe("the Runs page with an Engine Run and a coordinator-chain Run on the same host", () => {
  test("both are listed together; neither list hides, replaces or invents the other", async () => {
    const engineRun = bootstrapRun({ runId: "run-tab001-a1" });
    engineRun.team.name = "Engine team";
    await store.create(engineRun);
    const queries = createRunQueries({ store, ensureReady: async () => undefined });
    shared.list = (input) => queries.list(input as never);
    const chain: TeamRun = {
      runId: "run-legacy-0001",
      teamName: "Chain team",
      coordinator: agent("legacy-coordinator"),
      members: [agent("legacy-member")],
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };
    shared.labelled = [chain];

    const page = await render(
      (text) => text.includes("Engine team") && text.includes("Chain team"),
    );
    // The Engine section, with the Run from the ledger, and the label-derived Run beneath it.
    expect(page.text).toContain(runEngineZh.list.title);
    expect(page.text).toContain("Engine team");
    expect(page.text).toContain("Chain team");
    expect(page.text.indexOf("Engine team")).toBeLessThan(page.text.indexOf("Chain team"));
    page.unmount();
  });

  test("with no Engine Run the page is what it was: the Engine section is not drawn and the chain's Run is", async () => {
    const queries = createRunQueries({ store, ensureReady: async () => undefined });
    shared.list = (input) => queries.list(input as never);
    shared.labelled = [
      {
        runId: "run-legacy-0002",
        teamName: "Chain team",
        coordinator: agent("legacy-coordinator"),
        members: [agent("legacy-member")],
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
      } satisfies TeamRun,
    ];
    const page = await render((text) => text.includes("Chain team"));
    expect(page.text).not.toContain(runEngineZh.list.title);
    expect(page.text).toContain("Chain team");
    page.unmount();
  });
});

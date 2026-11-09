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
  /** How many `run.list` calls have been made (answered or not). */
  asked: 0,
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
    shared.asked += 1;
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
// The expanded card reads the coordinator's timeline; none is needed to see which phase it names.
vi.mock("../../client/crew/use-digest", () => ({
  useTimelineDigest: () => ({ data: undefined, isPending: false }),
}));
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
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { zh } from "../../shared/zh";
import { runEngineZh } from "../../shared/zh/run-engine";
import { bootstrapRun } from "../run-engine/support/bootstrap-run";
import { readyRun } from "../run-engine/support/ready-run";
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
  shared.asked = 0;
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
  /** The list is asked but never answers (yet): wait for the question, not for the answer. */
  options: { unanswered?: boolean } = {},
): Promise<{
  text: string;
  /** The page text as it is now (after something happened since the render returned). */
  read(): string;
  unmount(): void;
  open(label: string): Promise<string>;
}> {
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
  const reached = () => (options.unanswered ? shared.asked > 0 : shared.answered > 0);
  await waitUntil(renderer.act, () => reached() && until(textOf(page.root)), {
    label: "the Runs page to show the list",
  });
  // What the answer set in motion in React (one more turn), then read.
  await renderer.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    text: textOf(page.root),
    read: () => textOf(page.root),
    unmount: () => page.unmount(),
    /** Presses the button with this accessibility label and returns the page text afterwards. */
    async open(label) {
      const button = page.root.findAll((node) => node.props.accessibilityLabel === label)[0];
      if (!button) throw new Error(`no button labelled ${label}`);
      await renderer.act(async () => {
        (button.props.onPress as () => void)();
      });
      return textOf(page.root);
    },
  };
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

  describe.each([2, 1] as const)(
    "a Run in both lists is described by the ledger, not by its idle coordinator (schema v%i)",
    (schemaVersion) => {
      const at = new Date().toISOString();
      const idle = (id: string): RunAgentSnapshot => ({
        ...agent(id),
        status: "idle",
        lastUsage: { inputTokens: 1 },
        attentionTimestamp: at,
      });
      const countOf = (text: string, needle: string) => text.split(needle).length - 1;

      /** One Run in the ledger and the same Run, with an idle coordinator, in the label-derived list. */
      async function seed(lifecycle: RunRecord["lifecycle"], blocked: boolean): Promise<void> {
        const runId = `run-tab00${schemaVersion}-x1`;
        const record = { ...readyRun({ runId }), schemaVersion };
        record.lifecycle = lifecycle;
        if (blocked) {
          const task = record.tasks.find((entry) => entry.spec.id === "t2");
          if (!task) throw new Error("fixture lost t2");
          task.state = "blocked";
        }
        await store.create(record);
        const queries = createRunQueries({ store, ensureReady: async () => undefined });
        shared.list = (input) => queries.list(input as never);
        shared.labelled = [
          {
            runId,
            teamName: "Chain team",
            coordinator: idle("coord"),
            members: [idle("member")],
            startedAt: at,
            lastActivityAt: at,
          } satisfies TeamRun,
        ];
      }

      test("active and blocked: needs a person, never completed, not counted as ended", async () => {
        await seed("active", true);
        const page = await render((text) => text.includes(zh.phaseNeedsYou));
        expect(page.text).toContain(zh.phaseNeedsYou);
        expect(page.text).toContain(`${zh.filterAttention} 1`);
        expect(page.text).toContain(`${zh.filterEnded} 0`);
        expect(page.text).not.toContain(zh.phaseDone);
        // Opening the card names the same phase in its plan line, not the idle coordinator's.
        const opened = await page.open(`${zh.progress} Chain team`);
        expect(opened).toContain(`${zh.plan} · ${zh.phaseNeedsYou}`);
        expect(opened).not.toContain(zh.phaseDone);
        page.unmount();
      });

      test("cancelled: ended, and called cancelled by the card as well as by the Engine section", async () => {
        await seed("cancelled", false);
        const page = await render((text) => countOf(text, zh.phaseCancelled) >= 2);
        expect(countOf(page.text, zh.phaseCancelled)).toBe(2);
        expect(page.text).toContain(`${zh.filterEnded} 1`);
        expect(page.text).not.toContain(zh.phaseDone);
        page.unmount();
      });

      test("finished is the only lifecycle shown as completed", async () => {
        await seed("finished", false);
        const page = await render((text) => text.includes(zh.phaseDone));
        expect(countOf(page.text, zh.phaseDone)).toBe(1);
        expect(page.text).toContain(`${zh.filterEnded} 1`);
        page.unmount();
      });
    },
  );

  describe.each([2, 1] as const)(
    "the first paint, before the Engine list has answered (schema v%i)",
    (schemaVersion) => {
      const at = new Date().toISOString();
      const idle = (id: string): RunAgentSnapshot => ({
        ...agent(id),
        status: "idle",
        lastUsage: { inputTokens: 1 },
        attentionTimestamp: at,
      });
      const runId = `run-tab10${schemaVersion}-f1`;

      /** A Run that is blocked in the ledger and, by its idle coordinator, looks finished. */
      async function seedBlocked(): Promise<ReturnType<typeof createRunQueries>> {
        const record = { ...readyRun({ runId }), schemaVersion };
        record.lifecycle = "active";
        const task = record.tasks.find((entry) => entry.spec.id === "t2");
        if (!task) throw new Error("fixture lost t2");
        task.state = "blocked";
        await store.create(record);
        shared.labelled = [
          {
            runId,
            teamName: "Chain team",
            coordinator: idle("coord"),
            members: [idle("member")],
            startedAt: at,
            lastActivityAt: at,
          } satisfies TeamRun,
        ];
        return createRunQueries({ store, ensureReady: async () => undefined });
      }

      test("pending: the Run is read, not completed; once the list answers the ledger's word replaces it", async () => {
        const queries = await seedBlocked();
        let answer: (value: unknown) => void = () => undefined;
        shared.list = (input) =>
          new Promise((resolve) => {
            answer = () => resolve(queries.list(input as never));
          });
        const page = await render((text) => text.includes("Chain team"), { unanswered: true });
        expect(page.text).toContain(zh.phaseLoading);
        expect(page.text).not.toContain(zh.phaseDone);
        expect(page.text).toContain(`${zh.filterEnded} 1`);

        // The answer comes: the blocked Run needs a person, on the same page.
        await renderer.act(async () => {
          answer(undefined);
        });
        await waitUntil(renderer.act, () => page.read().includes(zh.phaseNeedsYou), {
          label: "the page to show the ledger's phase after the answer",
        });
        const text = page.read();
        expect(text).not.toContain(zh.phaseLoading);
        expect(text).not.toContain(zh.phaseDone);
        expect(text).toContain(`${zh.filterAttention} 1`);
        page.unmount();
      });

      test("the list failed: the page falls back to the agents' reading and does not stay on reading", async () => {
        await seedBlocked();
        shared.list = async () => {
          throw new Error("run.list is down");
        };
        const page = await render((text) => text.includes(zh.phaseDone));
        expect(page.text).toContain(zh.phaseDone);
        expect(page.text).not.toContain(zh.phaseLoading);
        page.unmount();
      });

      test("the list answered and does not name the Run: the agents' reading stands", async () => {
        shared.labelled = [
          {
            runId: "run-legacy-0003",
            teamName: "Chain team",
            coordinator: idle("coord"),
            members: [idle("member")],
            startedAt: at,
            lastActivityAt: at,
          } satisfies TeamRun,
        ];
        const queries = createRunQueries({ store, ensureReady: async () => undefined });
        shared.list = (input) => queries.list(input as never);
        const page = await render((text) => text.includes(zh.phaseDone));
        expect(page.text).toContain(zh.phaseDone);
        expect(page.text).not.toContain(zh.phaseLoading);
        page.unmount();
      });
    },
  );

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

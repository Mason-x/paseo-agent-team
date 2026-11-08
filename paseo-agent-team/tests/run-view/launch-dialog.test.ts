import { createElement as h } from "react";
// @ts-expect-error react-test-renderer ships no types here; TestRenderer below is the subset used.
import * as reactTestRenderer from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const shared = vi.hoisted(() => ({
  /** What each launch RPC answers, by RPC name; set by the test. */
  handlers: {} as Record<string, (input: unknown) => unknown>,
  calls: [] as { name: string; input: unknown }[],
  toasts: [] as { text: string; options: unknown }[],
  copied: [] as string[],
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
vi.mock("@getpaseo/plugin/client", () => {
  // One function per RPC: a new one on each render would restart the dialog's status poll.
  const cache = new Map<string, (input: unknown) => Promise<unknown>>();
  return {
    useRpc: (contract: { name: string }) => {
      const known = cache.get(contract.name);
      if (known) return known;
      const call = async (input: unknown) => {
        shared.calls.push({ name: contract.name, input });
        const handler = shared.handlers[contract.name];
        if (!handler) throw new Error(`no handler for ${contract.name}`);
        return handler(input);
      };
      cache.set(contract.name, call);
      return call;
    },
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
  const toast = {
    show: (text: string, options: unknown) => shared.toasts.push({ text, options }),
  };
  return {
    ScrollView: (props: Record<string, unknown>) => h("ScrollView", props, props.children as never),
    Modal: modal,
    TextInput: (props: Record<string, unknown>) => h("TextInput", props),
    Icon: () => null,
    useToast: () => toast,
    copyText: async (text: string) => {
      shared.copied.push(text);
    },
  };
});
vi.mock("../../client/launch/use-launch-context", () => {
  const context = { projects: [], workspaces: [], loading: false, error: null };
  return { useLaunchContext: () => context };
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LaunchDialog } from "../../client/launch/LaunchDialog";
import { buildLaunchPlan } from "../../shared/domain/launch-plan";
import type { LaunchJob } from "../../shared/rpc";
import { zh } from "../../shared/zh";
import { runEngineZh } from "../../shared/zh/run-engine";
import {
  allAvailable,
  architect,
  claudeOpus,
  codexXhigh,
  codingTeam,
  developer,
  techLead,
} from "../fixtures";
import { policy } from "../fixtures/run-engine/base";

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

const theme = new Proxy({ colors: new Proxy({}, { get: () => "#000" }) }, {}) as never;
const layout = { compact: false } as never;

// The Team's launch gate, as the host computes it (the same planner the existing preview tests use).
const seat = (seatId: string, duties: string[], tier = "B") => ({
  seatId,
  tier,
  duties,
  channelId: "claude",
  enabled: true,
});
const members = [
  { roleId: "architect", seatId: "seat-a", enabled: true },
  { roleId: "developer", instanceLabel: "Backend", seatId: "seat-d", enabled: true },
];
function planFor(seats: unknown[], supported: boolean) {
  return buildLaunchPlan({
    team: {
      ...codingTeam,
      members,
      runEngine: { version: 1, enabled: true, seats, policy: policy() },
    },
    roles: [techLead, architect, developer],
    profiles: [claudeOpus, codexXhigh],
    availability: allAvailable,
    workspaceId: "ws-1",
    task: "Add Stripe subscriptions to the billing page.",
    runId: "run-1",
    maxMembers: 8,
    runEngineSupported: supported,
  });
}

/** An accepted preview: only what the dialog and `LaunchPreview` read. */
function acceptedPreview(warnings: string[]) {
  return {
    ok: true,
    preview: {
      coordinator: {
        roleId: "tech-lead",
        roleName: "Tech Lead",
        profile: null,
        source: "role-preferred",
        issues: [],
      },
      seats: [],
      counts: { logical: 2, physical: 2, eager: 2, deferred: 0, escalation: 0, sotaPotential: 0 },
      budget: { economy: 0, sota: 0, unknown: 0, deferredSota: 0 },
      issues: [],
      warnings,
      planHash: "hash-1",
    },
  };
}

function job(overrides: Partial<LaunchJob> = {}): LaunchJob {
  return {
    runId: "run-1",
    teamId: "team-1",
    teamName: "Team",
    state: "running",
    step: "kickoff",
    memberTotal: 2,
    memberIds: [],
    warnings: [],
    startedAt: "2026-11-08T00:00:00.000Z",
    ...overrides,
  };
}

const texts = (root: Node) =>
  root
    .findAll((node) => node.type === "Text")
    .map((node) =>
      Array.isArray(node.props.children)
        ? node.props.children.join("")
        : String(node.props.children ?? ""),
    )
    .join("\n");
/** The node, or a failure that names it: a missing control is a test failure, not a silent no-op. */
const button = (root: Node, label: string): Node => {
  const node = root.findAll(
    (entry) => entry.type === "Pressable" && entry.props.accessibilityLabel === label,
  )[0];
  if (node === undefined) throw new Error(`no button labelled "${label}"`);
  return node;
};

const settle = async () => {
  for (let round = 0; round < 6; round += 1) {
    await renderer.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

async function mount(onLaunched = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let view!: { root: Node; unmount(): void };
  await renderer.act(async () => {
    view = renderer.create(
      h(
        QueryClientProvider,
        { client },
        h(LaunchDialog, {
          theme,
          layout,
          open: true,
          adapter: {},
          hostId: "host-1",
          teams: [{ id: "team-1", name: "Team", coordinatorRoleId: "tech-lead", members: [] }],
          roles: [],
          initialTeamId: "team-1",
          lockTeam: true,
          initialTask: "Add Stripe subscriptions to the billing page.",
          workspaceId: "ws-1",
          onClose: () => undefined,
          onLaunched,
        } as never),
      ),
    );
  });
  await settle();
  return { view, onLaunched };
}

const startCalls = () => shared.calls.filter((call) => call.name === "agent-team.launch.start");

beforeEach(() => {
  shared.handlers = {};
  shared.calls = [];
  shared.toasts = [];
  shared.copied = [];
});
afterEach(() => {
  shared.handlers = {};
});

describe("the launch dialog shows what the Engine launch gate says", () => {
  test("a host that cannot run the Engine: the blocker is shown, the old chain is not offered, and launch stays off", async () => {
    const plan = planFor([seat("seat-a", ["implement"]), seat("seat-d", ["review"])], false);
    shared.handlers["agent-team.launch.preview"] = () => ({
      ok: false,
      blockers: plan.blockers,
      warnings: plan.warnings,
      issues: [],
    });
    const { view } = await mount();
    expect(texts(view.root)).toContain(runEngineZh.launch.unsupported);
    expect(button(view.root, zh.launch).props.disabled).toBe(true);
    await renderer.act(async () => (button(view.root, zh.launch).props.onPress as () => void)());
    expect(startCalls()).toEqual([]);
    await renderer.act(async () => view.unmount());
  });

  test("a roster that does not match the Team names the missing seat", async () => {
    const plan = planFor([seat("seat-a", ["implement"])], true);
    shared.handlers["agent-team.launch.preview"] = () => ({
      ok: false,
      blockers: plan.blockers,
      warnings: plan.warnings,
      issues: [],
    });
    const { view } = await mount();
    expect(texts(view.root)).toContain(runEngineZh.launch.seatMissing("seat-d"));
    expect(button(view.root, zh.launch).props.disabled).toBe(true);
    await renderer.act(async () => view.unmount());
  });

  test("a warning is shown next to an enabled launch button", async () => {
    const plan = planFor(
      [seat("seat-a", ["implement"], "A"), seat("seat-d", ["review"], "B")],
      true,
    );
    expect(plan.blockers).toEqual([]);
    shared.handlers["agent-team.launch.preview"] = () => acceptedPreview(plan.warnings);
    const { view } = await mount();
    expect(texts(view.root)).toContain(runEngineZh.launch.reviewerTierMissing("seat-a", "L3", "A"));
    expect(button(view.root, zh.launch).props.disabled).toBe(false);
    await renderer.act(async () => view.unmount());
  });
});

describe("the launch dialog tells a person what an Engine launch is doing", () => {
  async function launchWith(startJob: LaunchJob) {
    shared.handlers["agent-team.launch.preview"] = () => acceptedPreview([]);
    shared.handlers["agent-team.launch.start"] = () => ({ ok: true, job: startJob });
    shared.handlers["agent-team.launch.status"] = () => ({ job: startJob });
    const mounted = await mount();
    await renderer.act(async () =>
      (button(mounted.view.root, zh.launch).props.onPress as () => void)(),
    );
    await settle();
    return mounted;
  }

  test("kickoff-pending: the plan request is submitted, it takes minutes, do not start again", async () => {
    const { view } = await launchWith(job({ engine: { launchState: "kickoff-pending" } }));
    const text = texts(view.root);
    expect(text).toContain(runEngineZh.launchJob.sendingPlanRequest);
    expect(text).toContain("计划请求");
    expect(text).toContain("几分钟");
    expect(text).toContain("不要重复启动");
    // Not the coordinator chain's wording.
    expect(text).not.toContain(zh.sendingKickoff);
    expect(startCalls()).toHaveLength(1);
    await renderer.act(async () => view.unmount());
  });

  test("the coordinator chain's last step keeps its own wording", async () => {
    const { view } = await launchWith(job());
    const text = texts(view.root);
    expect(text).toContain(zh.sendingKickoff);
    expect(text).not.toContain(runEngineZh.launchJob.sendingPlanRequest);
    await renderer.act(async () => view.unmount());
  });

  test("a finished launch whose plan request is not yet confirmed says the Engine checks by itself", async () => {
    const { view, onLaunched } = await launchWith(
      job({ state: "succeeded", step: "done", engine: { launchState: "kickoff-pending" } }),
    );
    expect(shared.toasts.map((toast) => toast.text)).toEqual([runEngineZh.launchJob.donePending]);
    expect(onLaunched).toHaveBeenCalledTimes(1);
    expect(onLaunched).toHaveBeenCalledWith("run-1", undefined);
    await renderer.act(async () => view.unmount());
  });

  test("a failed launch shows the error, its detail and the kickoff message to copy", async () => {
    const { view } = await launchWith(
      job({
        state: "failed",
        step: "kickoff",
        engine: { launchState: "failed" },
        error: {
          message: "计划请求没有发出",
          detail: "host said no",
          step: "kickoff",
          archived: false,
          agentIdsKept: ["a1", "a2"],
          kickoffMessage: "the kickoff message",
        },
      }),
    );
    const text = texts(view.root);
    expect(text).toContain("计划请求没有发出");
    expect(text).toContain(zh.errorDetail("host said no"));
    await renderer.act(async () =>
      (button(view.root, zh.copyKickoff).props.onPress as () => void)(),
    );
    expect(shared.copied).toEqual(["the kickoff message"]);
    // A job that failed is not announced as launched.
    expect(shared.toasts).toEqual([]);
    await renderer.act(async () => view.unmount());
  });
});

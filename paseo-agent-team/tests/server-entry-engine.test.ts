import type { PluginServerContext } from "@getpaseo/plugin/server";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import contribute from "../index.server";
import { preferences } from "./fakes";
import { architect, codingTeam, developer, techLead } from "./fixtures";

/**
 * How the plugin entry hands the host's hooks to the Run Engine. The runtime itself is replaced by a
 * recorder: what matters here is that every host event reaches `onHook` in the shape the observer
 * reads, with the handle the host supplied, and that a failing Engine never breaks the host's hook
 * handler. The Engine's own behaviour is covered against the real runtime in tests/run-engine.
 */

const runtime = vi.hoisted(() => ({
  onHook: vi.fn<(event: unknown, paseo: unknown) => Promise<void>>(),
  bind: vi.fn<(paseo: unknown) => void>(),
  launchHost: { supported: false, identity: vi.fn(), start: vi.fn() },
  control: {
    replan: vi.fn<(input: unknown) => Promise<unknown>>(),
    decide: vi.fn<(input: unknown) => Promise<unknown>>(),
    kick: vi.fn<(input: unknown) => Promise<unknown>>(),
  },
  created: vi.fn(),
}));

vi.mock("../server/run-engine/runtime", () => ({
  RUN_ENGINE_ENV: "PASEO_AGENT_TEAM_RUN_ENGINE",
  createEngineRuntime: (options: unknown) => {
    runtime.created(options);
    return runtime;
  },
}));

type Handler = (input: unknown, context: { paseo: unknown }) => unknown;
type HookHandler = (event: unknown, context: { paseo: unknown }) => unknown;

const originalPaseoHome = process.env.PASEO_HOME;
beforeAll(() => {
  delete process.env.PASEO_HOME;
});
afterAll(() => {
  if (originalPaseoHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = originalPaseoHome;
});
beforeEach(() => {
  runtime.onHook.mockReset();
  runtime.onHook.mockResolvedValue(undefined);
  runtime.bind.mockReset();
  runtime.created.mockReset();
  for (const control of Object.values(runtime.control)) {
    control.mockReset();
    control.mockResolvedValue({ answered: true });
  }
});

function fakeServer() {
  const handlers = new Map<string, Handler>();
  const hooks = new Map<string, HookHandler[]>();
  const documents: Record<string, unknown> = {
    "agent-team-roles": { roles: [techLead, architect, developer] },
    "agent-team-teams": { teams: [codingTeam] },
    "agent-team-preferences": preferences,
  };
  const server = {
    registerSettings: (definition: { id: string }) => ({
      read: async () => ({
        status: "ready" as const,
        revision: "r1",
        values: documents[definition.id],
      }),
      subscribe: () => () => {},
    }),
    handle: (contract: { name: string }, handler: Handler) => {
      handlers.set(contract.name, handler);
    },
    on: (name: string, handler: HookHandler) => {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      return () => undefined;
    },
    before: () => () => {},
    registerProvider: vi.fn(),
    registerUsageSource: vi.fn(),
  };
  return { server: server as unknown as PluginServerContext, handlers, hooks };
}

/** Fires every handler registered for a host event, the way the host would. */
async function fire(
  hooks: Map<string, HookHandler[]>,
  name: string,
  event: unknown,
  paseo: unknown,
) {
  return Promise.allSettled((hooks.get(name) ?? []).map((handler) => handler(event, { paseo })));
}

describe("host hooks reach the Run Engine", () => {
  const paseo = { marker: "host-handle" };

  test.each([
    [
      "agent.turn_started",
      { agent: { id: "a1" }, turnId: "t1" },
      { name: "agent.turn_started", agentId: "a1", turnId: "t1" },
    ],
    [
      "agent.turn_ended",
      { agent: { id: "a1" }, turnId: "t1", outcome: { kind: "completed", extra: "dropped" } },
      { name: "agent.turn_ended", agentId: "a1", turnId: "t1", outcome: { kind: "completed" } },
    ],
    [
      "agent.permission_requested",
      { agent: { id: "a1" }, request: { id: "req-1", detail: "dropped" } },
      { name: "agent.permission_requested", agentId: "a1", requestId: "req-1" },
    ],
    [
      "agent.permission_resolved",
      { agent: { id: "a1" }, requestId: "req-1" },
      { name: "agent.permission_resolved", agentId: "a1", requestId: "req-1" },
    ],
    ["agent.created", { agent: { id: "a1" } }, { name: "agent.created", agentId: "a1" }],
    ["agent.closed", { agent: { id: "a1" } }, { name: "agent.closed", agentId: "a1" }],
    ["agent.archived", { agent: { id: "a1" } }, { name: "agent.archived", agentId: "a1" }],
  ])("%s is passed on, with the host's handle", async (name, event, expected) => {
    const { server, hooks } = fakeServer();
    contribute(server);
    await fire(hooks, name, event, paseo);
    expect(runtime.onHook).toHaveBeenCalledOnce();
    expect(runtime.onHook).toHaveBeenCalledWith(expected, paseo);
  });

  test("a failing Engine never makes the host's hook handler throw", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      runtime.onHook.mockRejectedValue(new Error("ledger exploded"));
      const { server, hooks } = fakeServer();
      contribute(server);
      for (const name of [...hooks.keys()]) {
        const settled = await fire(
          hooks,
          name,
          {
            agent: { id: "a1" },
            turnId: "t",
            request: { id: "r" },
            requestId: "r",
            outcome: { kind: "completed" },
          },
          paseo,
        );
        expect(settled.every((entry) => entry.status === "fulfilled")).toBe(true);
      }
      expect(log).toHaveBeenCalledWith(expect.stringContaining("run engine failed on"));
    } finally {
      log.mockRestore();
    }
  });

  test("a hook that throws synchronously in the Engine is contained the same way", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      runtime.onHook.mockImplementation(() => {
        throw new Error("sync failure");
      });
      const { server, hooks } = fakeServer();
      contribute(server);
      const settled = await fire(hooks, "agent.created", { agent: { id: "a1" } }, paseo);
      expect(settled.every((entry) => entry.status === "fulfilled")).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});

describe("the Paseo handle is bound where the host supplies one", () => {
  test.each([
    [
      "agent-team.launch.preview",
      { teamId: "none", task: "x", target: { kind: "workspace", workspaceId: "w" } },
    ],
    [
      "agent-team.launch.start",
      { teamId: "none", task: "x", target: { kind: "workspace", workspaceId: "w" } },
    ],
    ["agent-team.run.list", {}],
    ["agent-team.run.get", { runId: "run-x" }],
    ["agent-team.run.replan", { runId: "run-x" }],
    ["agent-team.run.decide", { runId: "run-x" }],
    ["agent-team.run.kick", { runId: "run-x" }],
  ])("%s", async (name, input) => {
    const { server, handlers } = fakeServer();
    contribute(server);
    const paseo = {
      config: { get: async () => ({ config: {} }) },
      providers: { listAvailable: async () => ({ providers: [] }) },
      projects: { list: async () => ({ projects: [] }) },
      workspaces: {
        list: async () => ({ entries: [], pageInfo: { hasMore: false } }),
        ref: () => ({ refresh: async () => null }),
      },
    };
    await Promise.resolve(handlers.get(name)?.(input, { paseo })).catch(() => undefined);
    expect(runtime.bind).toHaveBeenCalledWith(paseo);
  });

  test("each writing control reaches its own method of the Engine, with the input as the host sent it", async () => {
    const { server, handlers } = fakeServer();
    contribute(server);
    const paseo = { marker: "host-handle" };
    for (const [name, method] of [
      ["agent-team.run.replan", "replan"],
      ["agent-team.run.decide", "decide"],
      ["agent-team.run.kick", "kick"],
    ] as const) {
      const input = { runId: "run-x", marker: name };
      await expect(handlers.get(name)?.(input, { paseo })).resolves.toEqual({ answered: true });
      expect(runtime.control[method]).toHaveBeenCalledExactlyOnceWith(input);
      for (const other of Object.keys(runtime.control) as (keyof typeof runtime.control)[]) {
        if (other !== method) expect(runtime.control[other]).not.toHaveBeenCalled();
      }
      for (const control of Object.values(runtime.control)) control.mockClear();
    }
  });

  test("the launch service is given the Engine's launch host", () => {
    const { server } = fakeServer();
    contribute(server);
    expect(runtime.created).toHaveBeenCalledOnce();
  });
});

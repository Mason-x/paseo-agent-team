import type { PluginServerContext } from "@getpaseo/plugin/server";
import { describe, expect, test, vi } from "vitest";
import contribute from "../index.server";
import { RoleSchema } from "../shared/schemas/role";
import { TeamSchema } from "../shared/schemas/team";
import { fakePort, preferences } from "./fakes";
import { architect, codingTeam, developer, techLead } from "./fixtures";

type Handler = (input: unknown, context: { paseo: unknown }) => unknown;

/** Stands in for the daemon's plugin context and records what the plugin registers. */
function fakeServer() {
  const settings: string[] = [];
  const handlers = new Map<string, Handler>();
  const documents: Record<string, unknown> = {
    "agent-team-roles": { roles: [techLead, architect, developer] },
    "agent-team-teams": { teams: [codingTeam] },
    "agent-team-preferences": preferences,
  };
  const server = {
    registerSettings: vi.fn((definition: { id: string }) => {
      settings.push(definition.id);
      return {
        read: async () => ({
          status: "ready" as const,
          revision: "r1",
          values: documents[definition.id],
        }),
        subscribe: () => () => {},
      };
    }),
    handle: vi.fn((contract: { name: string }, handler: Handler) => {
      handlers.set(contract.name, handler);
    }),
    on: vi.fn(() => () => {}),
    before: vi.fn(() => () => {}),
    registerProvider: vi.fn(),
    registerUsageSource: vi.fn(),
  };
  return { server: server as unknown as PluginServerContext, settings, handlers };
}

function handler(handlers: Map<string, Handler>, name: string): Handler {
  const found = handlers.get(name);
  if (!found) throw new Error(`RPC ${name} was not registered`);
  return found;
}

describe("server entry", () => {
  test("registers the three settings documents and the plugin RPCs", () => {
    const { server, settings, handlers } = fakeServer();
    const cleanup = contribute(server);
    expect(settings).toEqual(["agent-team-roles", "agent-team-teams", "agent-team-preferences"]);
    expect([...handlers.keys()].sort()).toEqual([
      "agent-team.launch.start",
      "agent-team.launch.status",
      "agent-team.templates.examples",
    ]);
    expect(typeof cleanup).toBe("function");
    expect(() => cleanup()).not.toThrow();
  });

  test("starts a launch through the settings and Paseo it is given, then reports on it", async () => {
    const { server, handlers } = fakeServer();
    contribute(server);
    const { port, created } = fakePort();
    const started = (await handler(handlers, "agent-team.launch.start")(
      {
        teamId: "coding-team",
        task: "Add Stripe",
        target: { kind: "workspace", workspaceId: "ws-1" },
      },
      { paseo: port },
    )) as { ok: boolean; job: { runId: string } };
    expect(started.ok).toBe(true);

    const status = handler(handlers, "agent-team.launch.status");
    await vi.waitFor(async () => {
      const { job } = (await status({ runId: started.job.runId }, { paseo: port })) as {
        job: { state: string } | null;
      };
      expect(job?.state).toBe("succeeded");
    });
    expect(created).toHaveLength(3);
    expect(await status({ runId: "run-unknown" }, { paseo: port })).toEqual({ job: null });
  });

  test("serves example Roles and Teams bound to this host's Profiles", async () => {
    const { server, handlers } = fakeServer();
    contribute(server);
    const { port } = fakePort();
    const catalog = (await handler(handlers, "agent-team.templates.examples")(
      {},
      { paseo: port },
    )) as { roles: unknown[]; teams: unknown[] };
    expect(catalog.roles.length).toBeGreaterThan(10);
    for (const role of catalog.roles) RoleSchema.parse(role);
    for (const team of catalog.teams) TeamSchema.parse(team);
    const profileIds = new Set(["claude-opus-high", "codex-xhigh"]);
    expect(
      catalog.roles.every((role) =>
        profileIds.has(
          (role as { preferredProfiles: Array<{ profileId: string }> }).preferredProfiles[0]
            ?.profileId ?? "",
        ),
      ),
    ).toBe(true);
  });

  test("still serves the examples, unbound, when Profiles cannot be read", async () => {
    const { server, handlers } = fakeServer();
    contribute(server);
    const { port } = fakePort();
    port.config.get.mockRejectedValue(new Error("daemon offline"));
    const catalog = (await handler(handlers, "agent-team.templates.examples")(
      {},
      { paseo: port },
    )) as { roles: Array<{ preferredProfiles: Array<{ profileId: string }> }> };
    expect(catalog.roles[0]?.preferredProfiles[0]?.profileId).toBe("unbound");
  });
});

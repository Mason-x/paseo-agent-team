import type { PluginServerContext } from "@getpaseo/plugin/server";
import { describe, expect, test, vi } from "vitest";
import contribute from "../index.server";
import { exampleCatalog } from "../server/templates";
import { defaultCatalogPreviewRpc, exampleCatalogRpc } from "../shared/rpc";
import { RoleSchema } from "../shared/schemas/role";
import { TeamSchema } from "../shared/schemas/team";
import { sourceProfiles } from "./default-presets.fixtures";
import { fakePort, preferences } from "./fakes";
import { architect, codingTeam, developer, techLead } from "./fixtures";

type Handler = (input: unknown, context: { paseo: unknown }) => unknown;

/** Stands in for the daemon's plugin context and records what the plugin registers. */
function fakeServer() {
  const settings: string[] = [];
  const handlers = new Map<string, Handler>();
  const revisions: Record<string, string> = {};
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
          revision: revisions[definition.id] ?? "r1",
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
  return {
    server: server as unknown as PluginServerContext,
    settings,
    handlers,
    documents,
    revisions,
  };
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
      "agent-team.templates.defaults.preview",
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

  test("serves exactly 22 default Roles bound to this host's Profiles and no Teams", async () => {
    const { server, handlers } = fakeServer();
    contribute(server);
    const { port } = fakePort({ agentProfiles: sourceProfiles });
    const catalog = (await handler(handlers, "agent-team.templates.examples")(
      {},
      { paseo: port },
    )) as { roles: unknown[]; teams: unknown[] };
    expect(catalog.roles).toHaveLength(22);
    expect(catalog.teams).toEqual([]);
    expect(exampleCatalogRpc.output.parse(catalog)).toEqual(catalog);
    for (const role of catalog.roles) RoleSchema.parse(role);
    for (const team of catalog.teams) TeamSchema.parse(team);
    const profileIds = new Set(sourceProfiles.map((profile) => profile.id));
    expect(
      catalog.roles.every((role) =>
        profileIds.has(
          (role as { preferredProfiles: Array<{ profileId: string }> }).preferredProfiles[0]
            ?.profileId ?? "",
        ),
      ),
    ).toBe(true);
  });

  test("examples fails explicitly when Profiles cannot be read", async () => {
    const { server, handlers } = fakeServer();
    contribute(server);
    const { port } = fakePort();
    port.config.get.mockRejectedValue(new Error("daemon offline"));
    await expect(
      handler(handlers, "agent-team.templates.examples")({}, { paseo: port }),
    ).rejects.toThrow("daemon offline");
  });

  test("preview reads the registered settings again and returns each request's latest revisions", async () => {
    const { server, handlers, documents, revisions } = fakeServer();
    contribute(server);
    const { port } = fakePort({ agentProfiles: sourceProfiles });
    const preview = handler(handlers, "agent-team.templates.defaults.preview");
    const first = defaultCatalogPreviewRpc.output.parse(
      await preview({ allowUnboundOnProfileError: false }, { paseo: port }),
    );
    expect(first).toMatchObject({ ok: true, revisions: { roles: "r1", preferences: "r1" } });
    documents["agent-team-roles"] = {
      roles: [exampleCatalog(sourceProfiles, "first-import").roles[0]],
    };
    documents["agent-team-preferences"] = {
      ...preferences,
      defaultPresets: { catalogRevision: "old", seenRoleIds: ["lead-tech"] },
    };
    revisions["agent-team-roles"] = "roles-r2";
    revisions["agent-team-preferences"] = "prefs-r2";
    const next = defaultCatalogPreviewRpc.output.parse(
      await preview({ allowUnboundOnProfileError: false }, { paseo: port }),
    );
    expect(next).toMatchObject({
      ok: true,
      revisions: { roles: "roles-r2", preferences: "prefs-r2" },
    });
    if (!next.ok) throw new Error("expected successful preview");
    expect(next.roles[0].kind).toBe("same");
    expect(next.roles[1].kind).toBe("deleted");
  });

  test("preview blocks a Profile read error unless explicitly importing unbound", async () => {
    const { server, handlers } = fakeServer();
    contribute(server);
    const { port } = fakePort();
    port.config.get.mockRejectedValue(new Error("daemon offline"));
    const preview = handler(handlers, "agent-team.templates.defaults.preview");
    expect(await preview({ allowUnboundOnProfileError: false }, { paseo: port })).toMatchObject({
      ok: false,
      blockers: [{ code: "profiles-unavailable" }],
    });
    const allowed = defaultCatalogPreviewRpc.output.parse(
      await preview({ allowUnboundOnProfileError: true }, { paseo: port }),
    );
    expect(allowed).toMatchObject({
      ok: true,
      warnings: expect.arrayContaining(["无法读取 Profile，已全部标为未绑定。"]),
    });
  });
});

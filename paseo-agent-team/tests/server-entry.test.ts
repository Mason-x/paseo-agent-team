import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import contribute, { createDesignTurnEndedHandler } from "../index.server";
import {
  DESIGN_AGENT_LABEL,
  DESIGN_AGENT_VERSION_LABEL,
  type DesignHookEvent,
} from "../server/designer/hooks";
import type { StoredDesignJob } from "../server/designer/store";
import { exampleCatalog } from "../server/templates";
import type { DesignAdapter, DesignPaseoPort } from "../shared/paseo/port";
import { defaultCatalogPreviewRpc, exampleCatalogRpc } from "../shared/rpc";
import { RoleSchema } from "../shared/schemas/role";
import { TeamSchema } from "../shared/schemas/team";
import { sourceProfiles } from "./default-presets.fixtures";
import {
  DESIGN_CLIENT_REQUEST_ID,
  DESIGN_HASH,
  DESIGN_JOB_ID,
  DESIGN_LEASE_ID,
  DESIGN_STATE_REVISION,
} from "./design-fixtures";
import { fakePort, preferences } from "./fakes";
import { architect, codingTeam, developer, techLead } from "./fixtures";

type Handler = (input: unknown, context: { paseo: unknown }) => unknown;
type HookHandler = (event: unknown, context: { paseo: unknown }) => unknown;

const originalPaseoHome = process.env.PASEO_HOME;
beforeAll(() => {
  // Unit tests never read or lock the real host's ledger.
  delete process.env.PASEO_HOME;
});
afterAll(() => {
  if (originalPaseoHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = originalPaseoHome;
});

/** Stands in for the daemon's plugin context and records what the plugin registers. */
function fakeServer() {
  const settings: string[] = [];
  const readCounts: Record<string, number> = {};
  const handlers = new Map<string, Handler>();
  const hooks = new Map<string, HookHandler[]>();
  const revisions: Record<string, string> = {};
  const documents: Record<string, unknown> = {
    "agent-team-roles": { roles: [techLead, architect, developer] },
    "agent-team-teams": { teams: [codingTeam] },
    "agent-team-preferences": preferences,
  };
  const handle = vi.fn((contract: { name: string }, handler: Handler) => {
    handlers.set(contract.name, handler);
  });
  const server = {
    registerSettings: vi.fn((definition: { id: string }) => {
      settings.push(definition.id);
      return {
        read: async () => {
          readCounts[definition.id] = (readCounts[definition.id] ?? 0) + 1;
          return {
            status: "ready" as const,
            revision: revisions[definition.id] ?? "r1",
            values: documents[definition.id],
          };
        },
        subscribe: () => () => {},
      };
    }),
    handle,
    on: vi.fn((name: string, handler: HookHandler) => {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      return () =>
        hooks.set(
          name,
          (hooks.get(name) ?? []).filter((item) => item !== handler),
        );
    }),
    before: vi.fn(() => () => {}),
    registerProvider: vi.fn(),
    registerUsageSource: vi.fn(),
  };
  return {
    server: server as unknown as PluginServerContext,
    handle,
    settings,
    handlers,
    hooks,
    documents,
    revisions,
    readCounts,
  };
}

function handler(handlers: Map<string, Handler>, name: string): Handler {
  const found = handlers.get(name);
  if (!found) throw new Error(`RPC ${name} was not registered`);
  return found;
}

describe("server entry", () => {
  test("registers the three settings documents and the plugin RPCs", async () => {
    const { server, handle, settings, handlers, hooks } = fakeServer();
    const cleanup = contribute(server);
    expect(settings).toEqual(["agent-team-roles", "agent-team-teams", "agent-team-preferences"]);
    expect([...handlers.keys()].sort()).toEqual([
      "agent-team.design.cancel",
      "agent-team.design.continue",
      "agent-team.design.mark-saved",
      "agent-team.design.prepare-save",
      "agent-team.design.result",
      "agent-team.design.save-failed",
      "agent-team.design.start",
      "agent-team.design.status",
      "agent-team.launch.preview",
      "agent-team.launch.start",
      "agent-team.launch.status",
      "agent-team.team.plan",
      "agent-team.templates.defaults.preview",
      "agent-team.templates.examples",
      "agent-team.version.check",
      "agent-team.version.get",
      "agent-team.version.runtime",
      "agent-team.version.update.start",
      "agent-team.version.update.status",
    ]);
    expect([...handlers.keys()]).toHaveLength(19);
    expect(handle).toHaveBeenCalledTimes(19);
    expect(new Set(handle.mock.calls.map(([contract]) => contract.name)).size).toBe(19);
    expect([...hooks.keys()]).toEqual(["agent.turn_ended"]);
    expect(hooks.get("agent.turn_ended")).toHaveLength(1);
    expect(server.before).not.toHaveBeenCalled();
    expect(typeof cleanup).toBe("function");
    await cleanup();
  });

  test("team.plan is registered once and its probe reads neither settings nor host facts", async () => {
    const { server, handle, handlers, readCounts } = fakeServer();
    const cleanup = contribute(server);
    try {
      expect(
        handle.mock.calls.filter(([contract]) => contract.name === "agent-team.team.plan"),
      ).toHaveLength(1);
      const { port } = fakePort();
      const output = (await handler(handlers, "agent-team.team.plan")(
        { items: [] },
        { paseo: port },
      )) as {
        schemaVersion: number;
        capabilities: { modeContract: number; designRolePolicy: number };
        context: unknown;
        results: unknown[];
      };
      expect(output.schemaVersion).toBe(1);
      expect(output.capabilities.modeContract).toBe(2);
      expect(output.capabilities.designRolePolicy).toBe(1);
      expect(output.context).toBeNull();
      expect(output.results).toEqual([]);
      // 76: the handler forwards without pre-reading; the probe touches no settings or adapter.
      expect(readCounts).toEqual({});
      expect(port.config.get).not.toHaveBeenCalled();
      expect(port.providers.listAvailable).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  test("version RPCs stay local when PASEO_HOME is absent", async () => {
    const previous = process.env.PASEO_HOME;
    delete process.env.PASEO_HOME;
    try {
      const { server, handlers } = fakeServer();
      contribute(server);
      const { port } = fakePort();
      const info = (await handler(handlers, "agent-team.version.get")({}, { paseo: port })) as {
        info: { blockers: Array<{ code: string }> };
      };
      expect(info.info.blockers.some((item) => item.code === "home_unavailable")).toBe(true);
      const checked = (await handler(handlers, "agent-team.version.check")(
        { requestId: "11111111-1111-4111-8111-111111111111" },
        { paseo: port },
      )) as { ok: boolean };
      expect(checked.ok).toBe(true);
      const started = (await handler(handlers, "agent-team.version.update.start")(
        {
          requestId: "22222222-2222-4222-8222-222222222222",
          checkId: "33333333-3333-4333-8333-333333333333",
        },
        { paseo: port },
      )) as { ok: boolean };
      expect(started.ok).toBe(false);
      const status = (await handler(handlers, "agent-team.version.update.status")(
        {},
        { paseo: port },
      )) as {
        job: { kind: string } | null;
      };
      expect(status.job?.kind).toBe("check");
      const runtime = (await handler(handlers, "agent-team.version.runtime")(
        {},
        { paseo: port },
      )) as {
        pluginId: string;
      };
      expect(runtime.pluginId).toBe("paseo-agent-team");
    } finally {
      if (previous === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = previous;
    }
  });

  test("previews a launch through the same settings without creating agents", async () => {
    const { server, handlers } = fakeServer();
    contribute(server);
    const { port, created } = fakePort();
    const preview = (await handler(handlers, "agent-team.launch.preview")(
      {
        teamId: "coding-team",
        task: "Add Stripe",
        target: { kind: "workspace", workspaceId: "ws-1" },
        mode: "sota",
      },
      { paseo: port },
    )) as { ok: boolean; preview?: { planHash: string } };
    expect(preview.ok).toBe(true);
    expect(preview.preview?.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(created).toHaveLength(0);
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

  test("serves exactly 13 default Roles bound to this host's Profiles and no Teams", async () => {
    const { server, handlers } = fakeServer();
    contribute(server);
    const { port } = fakePort({ agentProfiles: sourceProfiles });
    const catalog = (await handler(handlers, "agent-team.templates.examples")(
      {},
      { paseo: port },
    )) as { roles: unknown[]; teams: unknown[] };
    expect(catalog.roles).toHaveLength(13);
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
  test("design RPCs fail explicitly when PASEO_HOME is absent", async () => {
    const { server, handlers } = fakeServer();
    const cleanup = contribute(server);
    const { port } = fakePort();
    const status = await handler(handlers, "agent-team.design.status")({}, { paseo: port });
    expect(status).toMatchObject({
      ok: false,
      issues: [{ code: "DESIGN_STORAGE_UNAVAILABLE" }],
    });
    await cleanup();
  });

  test("all eight design RPCs are wired to the service", async () => {
    const { server, handlers } = fakeServer();
    const cleanup = contribute(server);
    const { port } = fakePort();
    const inputs = {
      "agent-team.design.start": { clientRequestId: DESIGN_CLIENT_REQUEST_ID, request: "改版" },
      "agent-team.design.status": {},
      "agent-team.design.result": { jobId: DESIGN_JOB_ID },
      "agent-team.design.prepare-save": {
        jobId: DESIGN_JOB_ID,
        resultId: DESIGN_HASH,
        clientId: DESIGN_CLIENT_REQUEST_ID,
      },
      "agent-team.design.mark-saved": { jobId: DESIGN_JOB_ID, resultId: DESIGN_HASH },
      "agent-team.design.save-failed": {
        jobId: DESIGN_JOB_ID,
        resultId: DESIGN_HASH,
        leaseId: DESIGN_LEASE_ID,
        phase: "roles",
        reason: "write-failed",
      },
      "agent-team.design.cancel": { jobId: DESIGN_JOB_ID },
      "agent-team.design.continue": {
        jobId: DESIGN_JOB_ID,
        expectedRevision: DESIGN_STATE_REVISION,
        action: "recheck",
      },
    };
    for (const [name, input] of Object.entries(inputs)) {
      expect(await handler(handlers, name)(input, { paseo: port })).toMatchObject({
        ok: false,
        issues: [{ code: "DESIGN_STORAGE_UNAVAILABLE" }],
      });
    }
    await cleanup();
  });

  test("retries ledger initialization after the first lock failure", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-team-entry-retry-"));
    const previous = process.env.PASEO_HOME;
    process.env.PASEO_HOME = home;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const versionDir = join(home, "agent-team-designer", "v1");
      const lock = join(versionDir, ".lock");
      await mkdir(versionDir, { recursive: true });
      await writeFile(
        lock,
        JSON.stringify({
          version: 1,
          ownerToken: "held-by-another-instance",
          pid: process.pid,
          startedAt: new Date().toISOString(),
          processStartedAt: null,
        }),
      );
      const { server, handlers } = fakeServer();
      const cleanup = contribute(server);
      const { port } = fakePort();
      const status = handler(handlers, "agent-team.design.status");
      expect(await status({}, { paseo: port })).toMatchObject({
        ok: false,
        issues: [{ code: "DESIGN_STORAGE_UNAVAILABLE" }],
      });
      await rm(lock);
      expect(await status({}, { paseo: port })).toMatchObject({ ok: true });
      await cleanup();
    } finally {
      logged.mockRestore();
      if (previous === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  });

  test("cleanup releases the design ledger lock", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-team-entry-"));
    const previous = process.env.PASEO_HOME;
    process.env.PASEO_HOME = home;
    try {
      const { server, handlers, hooks } = fakeServer();
      const cleanup = contribute(server);
      const { port } = fakePort();
      const status = handler(handlers, "agent-team.design.status");
      await vi.waitFor(
        async () => {
          expect(await status({}, { paseo: port })).toMatchObject({ ok: true });
        },
        { timeout: 5_000 },
      );
      const lock = join(home, "agent-team-designer", "v1", ".lock");
      expect(existsSync(lock)).toBe(true);
      await cleanup();
      expect(existsSync(lock)).toBe(false);
      expect(await status({}, { paseo: port })).toMatchObject({ ok: false });
      expect(hooks.get("agent.turn_ended")).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("design turn-ended hook wiring", () => {
  const JOB_ID = "44444444-4444-4444-8444-444444444444";
  const labels = {
    [DESIGN_AGENT_LABEL]: JOB_ID,
    [DESIGN_AGENT_VERSION_LABEL]: "1",
  };

  function event(agentId: string, agentLabels?: Record<string, string>): DesignHookEvent {
    return {
      agent: { id: agentId, ...(agentLabels ? { labels: agentLabels } : {}) },
      turnId: "turn-1",
      outcome: { kind: "completed" },
    };
  }

  function record(
    creation: StoredDesignJob["creation"] = {
      request: null,
    } as StoredDesignJob["creation"],
  ): StoredDesignJob {
    return {
      job: { jobId: JOB_ID, agentId: JOB_ID },
      creation,
    } as unknown as StoredDesignJob;
  }

  test("the hook no longer depends on the stored creation request", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "index.server.ts"), "utf8");
    expect(source).not.toMatch(/record\.creation/);
  });

  test("an unrelated agent exits before binding the adapter or enqueuing", async () => {
    const getRecord = vi.fn(async () => null);
    const onTurnEnded = vi.fn(async () => {});
    const bindAdapter = vi.fn(() => ({}) as DesignAdapter);
    const turnEnded = createDesignTurnEndedHandler({
      getRecord: getRecord as unknown as Parameters<
        typeof createDesignTurnEndedHandler
      >[0]["getRecord"],
      hooks: { onTurnEnded },
      bindAdapter,
    });
    await turnEnded(event("55555555-5555-4555-8555-555555555555", { "agent-team.run": "run-1" }), {
      paseo: {} as DesignPaseoPort,
    });
    expect(getRecord).not.toHaveBeenCalled();
    expect(bindAdapter).not.toHaveBeenCalled();
    expect(onTurnEnded).not.toHaveBeenCalled();
  });

  test("forged design labels still require a matching ledger record", async () => {
    const getRecord = vi.fn(async () => null);
    const onTurnEnded = vi.fn(async () => {});
    const bindAdapter = vi.fn(() => ({}) as DesignAdapter);
    const turnEnded = createDesignTurnEndedHandler({
      getRecord: getRecord as unknown as Parameters<
        typeof createDesignTurnEndedHandler
      >[0]["getRecord"],
      hooks: { onTurnEnded },
      bindAdapter,
    });
    await turnEnded(event("55555555-5555-4555-8555-555555555555", labels), {
      paseo: {} as DesignPaseoPort,
    });
    expect(getRecord).toHaveBeenCalledOnce();
    expect(bindAdapter).not.toHaveBeenCalled();
    expect(onTurnEnded).not.toHaveBeenCalled();
  });

  test("creation.request null still reaches the service with rebuilt labels", async () => {
    const getRecord = vi.fn(async () => record());
    const onTurnEnded = vi.fn(async () => {});
    const bindAdapter = vi.fn(() => ({}) as DesignAdapter);
    const turnEnded = createDesignTurnEndedHandler({
      getRecord: getRecord as unknown as Parameters<
        typeof createDesignTurnEndedHandler
      >[0]["getRecord"],
      hooks: { onTurnEnded },
      bindAdapter,
    });
    const paseo = {} as DesignPaseoPort;
    await turnEnded(event(JOB_ID), { paseo });
    expect(bindAdapter).toHaveBeenCalledWith(paseo);
    expect(bindAdapter.mock.invocationCallOrder[0]).toBeLessThan(
      onTurnEnded.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(onTurnEnded).toHaveBeenCalledWith({
      agent: { id: JOB_ID, labels },
      turnId: "turn-1",
      outcome: { kind: "completed" },
    });
  });

  test("a null creation still reaches the service with rebuilt labels", async () => {
    const getRecord = vi.fn(async () => record(null));
    const onTurnEnded = vi.fn(async () => {});
    const bindAdapter = vi.fn(() => ({}) as DesignAdapter);
    const turnEnded = createDesignTurnEndedHandler({
      getRecord: getRecord as unknown as Parameters<
        typeof createDesignTurnEndedHandler
      >[0]["getRecord"],
      hooks: { onTurnEnded },
      bindAdapter,
    });
    await turnEnded(event(JOB_ID), { paseo: {} as DesignPaseoPort });
    expect(bindAdapter).toHaveBeenCalledOnce();
    expect(onTurnEnded).toHaveBeenCalledWith({
      agent: { id: JOB_ID, labels },
      turnId: "turn-1",
      outcome: { kind: "completed" },
    });
  });

  test("forged design labels on an owned agent are replaced by the ledger jobId", async () => {
    const getRecord = vi.fn(async () => record(null));
    const onTurnEnded = vi.fn(async () => {});
    const bindAdapter = vi.fn(() => ({}) as DesignAdapter);
    const turnEnded = createDesignTurnEndedHandler({
      getRecord: getRecord as unknown as Parameters<
        typeof createDesignTurnEndedHandler
      >[0]["getRecord"],
      hooks: { onTurnEnded },
      bindAdapter,
    });
    await turnEnded(
      event(JOB_ID, {
        [DESIGN_AGENT_LABEL]: "66666666-6666-4666-8666-666666666666",
        [DESIGN_AGENT_VERSION_LABEL]: "1",
      }),
      { paseo: {} as DesignPaseoPort },
    );
    expect(onTurnEnded).toHaveBeenCalledWith({
      agent: { id: JOB_ID, labels },
      turnId: "turn-1",
      outcome: { kind: "completed" },
    });
  });
});

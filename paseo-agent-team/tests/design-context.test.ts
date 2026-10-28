import { describe, expect, test, vi } from "vitest";
import {
  type DesignContextCapabilities,
  type DesignContextJob,
  type DesignSettingsReader,
  type DesignSettingsSnapshot,
  describeModeRouting,
  readDesignContext,
} from "../server/designer/context";
import {
  type EconomyPolicy,
  normalizeEconomyPolicy,
  resolveCoordinatorProfile,
  resolveModeProfile,
} from "../shared/domain/mode-resolver";
import type { PaseoProfile, ProviderAvailability } from "../shared/paseo/adapter";
import type { DesignAdapter, DesignWorkspaceSummary } from "../shared/paseo/design-port";
import type { Preferences } from "../shared/schemas/preferences";
import { PreferencesSchema } from "../shared/schemas/preferences";
import { type Role, RoleSchema } from "../shared/schemas/role";
import type { RolesDocument, TeamsDocument } from "../shared/settings";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const CARRIER_ID = "carrier-workspace";
const TARGET_ID = "target-workspace";
const CAPABILITIES: DesignContextCapabilities = {
  onDemand: true,
  expansion: false,
  collaboration: false,
};
const PREFERENCES: Preferences = PreferencesSchema.parse({});
const ROLES: RolesDocument = { roles: [] };
const TEAMS: TeamsDocument = { teams: [] };

const CHEAP_PROFILE: PaseoProfile = {
  id: "cheap-deepseek",
  name: "DeepSeek",
  provider: "omp",
  model: "opencode-go/deepseek-v4.1-flash",
};

const CHEAP_ROLE: Role = RoleSchema.parse({
  id: "eng-cheap",
  name: "Cheap Eng",
  mission: "实现指定模块",
  responsibilities: ["实现"],
  systemPrompt: "按范围实现",
  preferredProfiles: [{ profileId: "missing-profile" }],
  fallbackProfiles: [],
  executionPolicy: { tier: "execution", taskKind: "coding" },
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const CHEAP_PREFERENCES: Preferences = PreferencesSchema.parse({
  economy: {
    allSeats: {
      version: 1,
      profiles: [
        {
          profileId: CHEAP_PROFILE.id,
          enabled: true,
          costClass: "low",
          family: "deepseek",
          boundModel: { provider: "omp", model: "opencode-go/deepseek-v4.1-flash" },
        },
      ],
      routes: { execution: [CHEAP_PROFILE.id], coordinator: [CHEAP_PROFILE.id] },
    },
  },
});
const EMPTY_TIMELINE = {
  epoch: "epoch-1",
  direction: "tail" as const,
  projection: "projected" as const,
  entries: [],
  startCursor: null,
  endCursor: null,
  hasOlder: false,
  hasNewer: false,
  reset: false,
  gap: false,
  staleCursor: false,
};

const CARRIER: DesignWorkspaceSummary = {
  id: CARRIER_ID,
  name: "承载工作区",
  title: null,
  projectId: "project-1",
  projectName: "项目",
  directory: "/carrier",
  internal: false,
  archivingAt: null,
  activityAt: "2026-10-25T00:00:00.000Z",
  background: false,
  status: "running",
};

const TARGET: DesignWorkspaceSummary = {
  ...CARRIER,
  id: TARGET_ID,
  name: "目标工作区",
  title: "目标工作区",
  directory: "/target",
};

function job(overrides: Partial<DesignContextJob> = {}): DesignContextJob {
  return {
    jobId: JOB_ID,
    mode: "sota",
    carrierWorkspaceId: CARRIER_ID,
    targetWorkspaceId: null,
    ...overrides,
  };
}

function adapter(overrides: Partial<DesignAdapter> = {}): DesignAdapter {
  return {
    readConfig: async () => ({ agentProfiles: [] }),
    listProviderAvailability: async () => [],
    listRecentWorkspaces: async () => ({ workspaces: [], nextCursor: null, hasMore: false }),
    getDesignWorkspace: async () => null,
    createDesignAgent: async () => ({ agentId: "agent-1" }),
    getDesignAgent: async () => null,
    listDesignAgents: async () => ({ agents: [], nextCursor: null, hasMore: false }),
    readDesignTimeline: async () => EMPTY_TIMELINE,
    sendDesignMessage: async () => {},
    archiveDesignAgent: async () => {},
    ...overrides,
  };
}

type ReaderCalls = {
  roles: ReturnType<typeof vi.fn>;
  teams: ReturnType<typeof vi.fn>;
  preferences: ReturnType<typeof vi.fn>;
};

function readers(
  invalid?: "roles" | "teams" | "preferences",
  settings: { roles?: RolesDocument; preferences?: Preferences } = {},
): {
  readers: {
    roles: DesignSettingsReader<RolesDocument>;
    teams: DesignSettingsReader<TeamsDocument>;
    preferences: DesignSettingsReader<Preferences>;
  };
  calls: ReaderCalls;
} {
  function read<T>(
    document: "roles" | "teams" | "preferences",
    values: T,
  ): Promise<DesignSettingsSnapshot<T>> {
    return Promise.resolve(
      document === invalid
        ? { status: "invalid", revision: `bad-${document}`, error: "SETTINGS_SECRET" }
        : { status: "ready", revision: `rev-${document}`, values },
    );
  }
  const calls = {
    roles: vi.fn(() => read("roles", settings.roles ?? ROLES)),
    teams: vi.fn(() => read("teams", TEAMS)),
    preferences: vi.fn(() => read("preferences", settings.preferences ?? PREFERENCES)),
  };
  return {
    readers: {
      roles: { read: calls.roles },
      teams: { read: calls.teams },
      preferences: { read: calls.preferences },
    },
    calls,
  };
}

function profiles() {
  return [
    {
      id: "profile-1",
      name: "Claude Max",
      provider: "claude",
      model: "opus",
      modeId: "auto",
      thinkingOptionId: "max",
      featureValues: { fast: true },
      notes: "notes",
      icon: "icon",
      color: "blue",
    },
  ];
}

describe("design context", () => {
  test("reads config once, projects profiles from that snapshot, and returns revisions", async () => {
    const readConfig = vi.fn(async () => ({ agentProfiles: profiles() }));
    const listAvailability = vi.fn(async () => [{ provider: "claude", available: true }]);
    const workspace = vi.fn(async (id: string) => (id === CARRIER_ID ? CARRIER : TARGET));
    const r = readers();
    const result = await readDesignContext(
      job({ targetWorkspaceId: TARGET_ID }),
      r.readers,
      adapter({
        readConfig,
        listProviderAvailability: listAvailability,
        getDesignWorkspace: workspace,
      }),
      CAPABILITIES,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readConfig).toHaveBeenCalledTimes(1);
    expect(r.calls.roles).toHaveBeenCalledTimes(1);
    expect(r.calls.teams).toHaveBeenCalledTimes(1);
    expect(r.calls.preferences).toHaveBeenCalledTimes(1);
    expect(workspace).toHaveBeenCalledWith(CARRIER_ID);
    expect(workspace).toHaveBeenCalledWith(TARGET_ID);
    expect(result.context.revisions).toEqual({
      roles: "rev-roles",
      teams: "rev-teams",
      preferences: "rev-preferences",
    });
    expect(result.context.profiles).toEqual(profiles());
    expect(result.context.availability).toEqual([{ provider: "claude", available: true }]);
    expect(result.context.carrierWorkspace.id).toBe(CARRIER_ID);
    expect(result.context.targetWorkspace?.id).toBe(TARGET_ID);
    expect(result.context.capabilities).toEqual(CAPABILITIES);
  });

  test("a failed config is an explicit error and never becomes an empty healthy host", async () => {
    const readConfig = vi.fn(async () => {
      throw new Error("config secret");
    });
    const result = await readDesignContext(
      job(),
      readers().readers,
      adapter({ readConfig, getDesignWorkspace: async () => CARRIER }),
      CAPABILITIES,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "DESIGN_CONFIG_UNAVAILABLE",
        path: ["config"],
        action: "refresh",
      }),
    ]);
    expect(readConfig).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("config secret");
  });

  test("a failed availability read has its own config error path", async () => {
    const result = await readDesignContext(
      job(),
      readers().readers,
      adapter({
        listProviderAvailability: async () => {
          throw new Error("availability secret");
        },
        getDesignWorkspace: async () => CARRIER,
      }),
      CAPABILITIES,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "DESIGN_CONFIG_UNAVAILABLE",
        path: ["availability"],
        action: "refresh",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("availability secret");
  });

  test("invalid settings identify the exact document and do not leak the parser message", async () => {
    for (const document of ["roles", "teams", "preferences"] as const) {
      const r = readers(document);
      const result = await readDesignContext(
        job(),
        r.readers,
        adapter({ getDesignWorkspace: async () => CARRIER }),
        CAPABILITIES,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: "DESIGN_SETTINGS_INVALID",
          path: [document],
          action: "inspect",
        }),
      ]);
      expect(JSON.stringify(result)).not.toContain("SETTINGS_SECRET");
    }
  });

  test("selects the most recent usable carrier when the job has none", async () => {
    const list = vi.fn(async () => ({
      workspaces: [
        { ...CARRIER, id: TARGET_ID },
        { ...CARRIER, id: "internal-workspace", internal: true },
        { ...CARRIER, id: "archiving-workspace", archivingAt: "2026-10-26T00:00:00.000Z" },
        { ...CARRIER, id: "chosen-workspace" },
      ],
      nextCursor: null,
      hasMore: false,
    }));
    const refresh = vi.fn(async (id: string) => ({ ...CARRIER, id }));
    const result = await readDesignContext(
      job({ carrierWorkspaceId: null, targetWorkspaceId: TARGET_ID }),
      readers().readers,
      adapter({ listRecentWorkspaces: list, getDesignWorkspace: refresh }),
      CAPABILITIES,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(list).toHaveBeenCalledWith({ limit: 50 });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledWith(TARGET_ID);
    expect(refresh).toHaveBeenCalledWith("chosen-workspace");
    expect(result.context.carrierWorkspaceId).toBe("chosen-workspace");
    expect(result.context.targetWorkspaceId).toBe(TARGET_ID);
  });

  test("uses activity order even when the workspace page is oldest-first", async () => {
    const oldest = {
      ...CARRIER,
      id: "oldest-workspace",
      activityAt: "2026-01-01T00:00:00.000Z",
    };
    const newest = {
      ...CARRIER,
      id: "newest-workspace",
      activityAt: "2026-10-01T00:00:00.000Z",
    };
    const list = vi.fn(async () => ({
      workspaces: [oldest, newest],
      nextCursor: null,
      hasMore: false,
    }));
    const refresh = vi.fn(async (id: string) => ({ ...CARRIER, id }));
    const result = await readDesignContext(
      job({ carrierWorkspaceId: null }),
      readers().readers,
      adapter({ listRecentWorkspaces: list, getDesignWorkspace: refresh }),
      CAPABILITIES,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.carrierWorkspaceId).toBe("newest-workspace");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith("newest-workspace");
  });

  test("a target that is the only workspace reports the dedicated no-workspace reason", async () => {
    const list = vi.fn(async () => ({
      workspaces: [{ ...TARGET, activityAt: "2026-10-26T00:00:00.000Z" }],
      nextCursor: null,
      hasMore: false,
    }));
    const result = await readDesignContext(
      job({ carrierWorkspaceId: null, targetWorkspaceId: TARGET_ID }),
      readers().readers,
      adapter({
        listRecentWorkspaces: list,
        getDesignWorkspace: async (id) => ({ ...CARRIER, id }),
      }),
      CAPABILITIES,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "DESIGN_NO_WORKSPACE",
        path: ["carrier"],
        params: { reason: "target-is-only-workspace" },
        action: "choose-workspace",
      }),
    ]);
  });

  test("an explicit carrier equal to target is rejected before refresh", async () => {
    const getWorkspace = vi.fn(async () => TARGET);
    const result = await readDesignContext(
      job({ carrierWorkspaceId: TARGET_ID, targetWorkspaceId: TARGET_ID }),
      readers().readers,
      adapter({ getDesignWorkspace: getWorkspace }),
      CAPABILITIES,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "DESIGN_NO_WORKSPACE",
        path: ["carrier"],
        params: { reason: "target-is-only-workspace" },
      }),
    ]);
    expect(getWorkspace).toHaveBeenCalledTimes(1);
    expect(getWorkspace).toHaveBeenCalledWith(TARGET_ID);
  });

  test("an unreadable workspace list is a carrier error, not an empty host", async () => {
    const result = await readDesignContext(
      job({ carrierWorkspaceId: null }),
      readers().readers,
      adapter({
        listRecentWorkspaces: async () => {
          throw new Error("list failed");
        },
      }),
      CAPABILITIES,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "DESIGN_WORKSPACE_UNAVAILABLE",
        path: ["carrier"],
        params: { reason: "unreadable" },
        action: "choose-workspace",
      }),
    ]);
  });

  test("malformed config shapes are config errors while an empty profile list stays valid", async () => {
    const malformed: unknown[] = [
      {},
      null,
      "config",
      { agentProfiles: {} },
      { agentProfiles: "profiles" },
      { profiles: [] },
    ];
    for (const config of malformed) {
      const readConfig = vi.fn(async () => config);
      const result = await readDesignContext(
        job(),
        readers().readers,
        adapter({ readConfig, getDesignWorkspace: async () => CARRIER }),
        CAPABILITIES,
      );
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: "DESIGN_CONFIG_UNAVAILABLE",
          path: ["profiles"],
          action: "refresh",
        }),
      ]);
      expect(readConfig).toHaveBeenCalledTimes(1);
    }

    const empty = await readDesignContext(
      job(),
      readers().readers,
      adapter({
        readConfig: async () => ({ agentProfiles: [] }),
        getDesignWorkspace: async () => CARRIER,
      }),
      CAPABILITIES,
    );
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.context.profiles).toEqual([]);
  });

  test("missing, archiving, internal, and unreadable carriers stay distinct", async () => {
    const cases = [
      {
        name: "missing",
        getWorkspace: async () => null,
        reason: "missing",
        issue: "DESIGN_WORKSPACE_UNAVAILABLE",
        path: ["carrier"],
      },
      {
        name: "unreadable",
        getWorkspace: async () => {
          throw new Error("refresh failed");
        },
        reason: "unreadable",
        issue: "DESIGN_WORKSPACE_UNAVAILABLE",
        path: ["carrier"],
      },
      {
        name: "archiving",
        getWorkspace: async () => ({ ...CARRIER, archivingAt: "2026-10-26T00:00:00.000Z" }),
        reason: "archiving",
        issue: "DESIGN_WORKSPACE_UNAVAILABLE",
        path: ["carrier"],
      },
      {
        name: "internal",
        getWorkspace: async () => ({ ...CARRIER, internal: true }),
        reason: "internal",
        issue: "DESIGN_WORKSPACE_UNAVAILABLE",
        path: ["carrier"],
      },
    ] as const;
    for (const item of cases) {
      const result = await readDesignContext(
        job(),
        readers().readers,
        adapter({ getDesignWorkspace: item.getWorkspace }),
        CAPABILITIES,
      );
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: item.issue,
          path: item.path,
          params: expect.objectContaining({ reason: item.reason }),
          action: "choose-workspace",
        }),
      ]);
    }

    const noCarrier = await readDesignContext(
      job({ carrierWorkspaceId: null }),
      readers().readers,
      adapter(),
      CAPABILITIES,
    );
    expect(noCarrier.ok).toBe(false);
    if (noCarrier.ok) return;
    expect(noCarrier.issues).toEqual([
      expect.objectContaining({ code: "DESIGN_NO_WORKSPACE", path: ["carrier"] }),
    ]);
  });

  test("target workspace failures use the target slot and never substitute the carrier", async () => {
    const getWorkspace = vi.fn(async (id: string) => {
      if (id === CARRIER_ID) return CARRIER;
      return null;
    });
    const result = await readDesignContext(
      job({ targetWorkspaceId: TARGET_ID }),
      readers().readers,
      adapter({ getDesignWorkspace: getWorkspace }),
      CAPABILITIES,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "DESIGN_WORKSPACE_UNAVAILABLE",
        path: ["target"],
        params: { workspaceId: TARGET_ID, reason: "missing" },
      }),
    ]);
    expect(getWorkspace).toHaveBeenCalledWith(CARRIER_ID);
    expect(getWorkspace).toHaveBeenCalledWith(TARGET_ID);

    const carrierMissing = await readDesignContext(
      job({ targetWorkspaceId: TARGET_ID }),
      readers().readers,
      adapter({
        getDesignWorkspace: async (id) => (id === TARGET_ID ? TARGET : null),
      }),
      CAPABILITIES,
    );
    expect(carrierMissing.ok).toBe(false);
    if (carrierMissing.ok) return;
    expect(carrierMissing.issues).toEqual([
      expect.objectContaining({
        path: ["carrier"],
        params: { workspaceId: CARRIER_ID, reason: "missing" },
      }),
    ]);
  });

  test("a missing target is not fetched and stays null", async () => {
    const getWorkspace = vi.fn(async () => CARRIER);
    const result = await readDesignContext(
      job({ targetWorkspaceId: null }),
      readers().readers,
      adapter({ getDesignWorkspace: getWorkspace }),
      CAPABILITIES,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(getWorkspace).toHaveBeenCalledTimes(1);
    expect(result.context.targetWorkspace).toBeNull();
    expect(result.context.targetWorkspaceId).toBeNull();
  });

  test("tools readiness is not a context repair issue", async () => {
    const result = await readDesignContext(
      job(),
      readers().readers,
      adapter({
        readConfig: async () => ({
          agentProfiles: [],
          mcp: { enabled: false, injectIntoAgents: false },
        }),
        getDesignWorkspace: async () => CARRIER,
      }),
      CAPABILITIES,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.daemonConfig).toEqual({
      agentProfiles: [],
      mcp: { enabled: false, injectIntoAgents: false },
    });
  });

  test("economy-all computes one route table and per-use verdicts", async () => {
    const result = await readDesignContext(
      job({ mode: "economy-all" }),
      readers(undefined, {
        roles: { roles: [CHEAP_ROLE] },
        preferences: CHEAP_PREFERENCES,
      }).readers,
      adapter({
        readConfig: async () => ({ agentProfiles: [CHEAP_PROFILE] }),
        listProviderAvailability: async () => [{ provider: "omp", available: true }],
        getDesignWorkspace: async () => CARRIER,
      }),
      CAPABILITIES,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const routing = result.context.modeRouting;
    expect(routing?.status).toBe("ready");
    if (routing?.status !== "ready") return;
    const execution = routing.routes.find(
      (row) => row.route === "execution" && row.taskKind === "coding",
    );
    expect(execution?.candidates).toEqual([
      { profileId: CHEAP_PROFILE.id, family: "deepseek", eligible: true, reported: false },
    ]);
    expect(result.context.roleLaunchTables.member[CHEAP_ROLE.id]?.launchable).toBe(true);
    expect(result.context.roleLaunchTables.coordinator[CHEAP_ROLE.id]?.launchable).toBe(true);
    // The legacy projection is the member table, not a second computation.
    expect(result.context.roleLaunch[CHEAP_ROLE.id]).toEqual(
      result.context.roleLaunchTables.member[CHEAP_ROLE.id],
    );
  });

  test("legacy modes carry no economy-all route table", async () => {
    const result = await readDesignContext(
      job({ mode: "economy" }),
      readers(undefined, {
        roles: { roles: [CHEAP_ROLE] },
        preferences: CHEAP_PREFERENCES,
      }).readers,
      adapter({
        readConfig: async () => ({ agentProfiles: [CHEAP_PROFILE] }),
        listProviderAvailability: async () => [{ provider: "omp", available: true }],
        getDesignWorkspace: async () => CARRIER,
      }),
      CAPABILITIES,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("modeRouting" in result.context).toBe(false);
    expect(result.context.roleLaunchTables.member[CHEAP_ROLE.id]).toEqual(
      result.context.roleLaunch[CHEAP_ROLE.id],
    );
  });

  test("an unreadable all-seats policy keeps the routing invalid, not empty", async () => {
    const result = await readDesignContext(
      job({ mode: "economy-all" }),
      readers(undefined, {
        roles: { roles: [CHEAP_ROLE] },
        preferences: PreferencesSchema.parse({
          economy: { allSeats: { version: 99 } },
        }),
      }).readers,
      adapter({
        readConfig: async () => ({ agentProfiles: [CHEAP_PROFILE] }),
        listProviderAvailability: async () => [{ provider: "omp", available: true }],
        getDesignWorkspace: async () => CARRIER,
      }),
      CAPABILITIES,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.modeRouting).toEqual({
      status: "invalid",
      reason: "unknown-version",
    });
  });
});

const ROUTES = ["coordinator", "decision", "execution", "escalation", "retain"] as const;
const ROUTE_TASK_KINDS = ["coding", "testing", "acceptance", "codebase", "ops", "general"] as const;

const ROUTE_PROFILES: PaseoProfile[] = [
  { id: "haiku", name: "Haiku", provider: "claude", model: "claude-haiku-4-5" },
  { id: "deepseek", name: "DeepSeek", provider: "omp", model: "opencode-go/deepseek-v4.1-flash" },
  { id: "sonnet", name: "Sonnet", provider: "claude", model: "claude-sonnet-5" },
];

const HAIKU_ENTRY = {
  profileId: "haiku",
  enabled: true,
  costClass: "low",
  family: "haiku",
  boundModel: { provider: "claude", model: "claude-haiku-4-5" },
};
const DEEPSEEK_ENTRY = {
  profileId: "deepseek",
  enabled: true,
  costClass: "low",
  family: "deepseek",
  boundModel: { provider: "omp", model: "opencode-go/deepseek-v4.1-flash" },
};
const SONNET_ENTRY = {
  profileId: "sonnet",
  enabled: true,
  costClass: "low",
  family: "sonnet",
  boundModel: { provider: "claude", model: "claude-sonnet-5" },
};
const MISSING_ENTRY = {
  profileId: "missing",
  enabled: true,
  costClass: "low",
  family: "deepseek",
  boundModel: { provider: "omp", model: "opencode-go/deepseek-v4.1-flash" },
};

function routePolicy(input: {
  profiles: unknown[];
  routes: Record<string, string[]>;
  executionTaskOrder?: Record<string, string[]>;
  profileBudget?: Record<string, string>;
}): EconomyPolicy {
  const normalized = normalizeEconomyPolicy(
    {
      pool: [],
      taskOrder: {},
      profileBudget: input.profileBudget ?? {},
      allSeats: {
        version: 1,
        profiles: input.profiles,
        routes: input.routes,
        ...(input.executionTaskOrder === undefined
          ? {}
          : { executionTaskOrder: input.executionTaskOrder }),
      },
    },
    ROUTE_PROFILES,
  );
  if (!normalized.ok) throw new Error("unexpected policy failure");
  return normalized.value;
}

function routeRole(
  route: (typeof ROUTES)[number],
  taskKind: (typeof ROUTE_TASK_KINDS)[number],
): Role {
  return RoleSchema.parse({
    id: `role-${route}`,
    name: `role ${route}`,
    mission: "使命",
    responsibilities: ["职责"],
    systemPrompt: "系统提示",
    preferredProfiles: [{ profileId: "missing-binding" }],
    fallbackProfiles: [],
    executionPolicy: { tier: route === "coordinator" ? "decision" : route, taskKind },
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

function reportedRejections(row: {
  candidates: readonly { profileId: string; reported: boolean; reason?: string }[];
}): { profileId: string; reason: unknown }[] {
  return row.candidates
    .filter((entry) => entry.reported)
    .map((entry) => ({ profileId: entry.profileId, reason: entry.reason }));
}

function plannerRejections(
  issues: readonly { code: string; profileId?: string; params: Record<string, unknown> }[],
): { profileId: string | undefined; reason: unknown }[] {
  return issues
    .filter((issue) => issue.code === "MODE_CHEAP_PROFILE_INVALID")
    .map((issue) => ({ profileId: issue.profileId, reason: issue.params.reason }));
}

describe("economy-all route table witness", () => {
  test("the first eligible candidate is the planner's pick on every route and task kind", () => {
    const economy = routePolicy({
      profiles: [HAIKU_ENTRY, DEEPSEEK_ENTRY],
      routes: {
        coordinator: ["deepseek", "haiku"],
        decision: ["haiku"],
        execution: ["haiku", "deepseek"],
        escalation: ["haiku"],
        retain: ["haiku"],
      },
      executionTaskOrder: { coding: ["deepseek", "haiku"] },
    });
    const availability: ProviderAvailability[] = [
      { provider: "claude", available: true },
      { provider: "omp", available: true },
    ];
    const routing = describeModeRouting({ profiles: ROUTE_PROFILES, availability, economy });
    if (routing.status !== "ready") throw new Error("expected a ready routing");
    const host = { status: "ready" as const, profiles: ROUTE_PROFILES, availability };
    for (const route of ROUTES) {
      for (const taskKind of route === "execution" ? ROUTE_TASK_KINDS : [null]) {
        const resolved =
          route === "coordinator"
            ? resolveCoordinatorProfile({
                mode: "economy-all",
                role: routeRole(route, "coding"),
                host,
                economy,
              })
            : resolveModeProfile({
                mode: "economy-all",
                role: routeRole(route, taskKind ?? "coding"),
                kind: "member",
                host,
                economy,
              });
        const row = routing.routes.find(
          (entry) => entry.route === route && entry.taskKind === taskKind,
        );
        expect(row).toBeDefined();
        const eligible = row?.candidates.filter((entry) => entry.eligible) ?? [];
        expect(eligible.length).toBeGreaterThan(0);
        const picked = resolved.ok
          ? "selection" in resolved
            ? resolved.selection.profile.id
            : resolved.value.profile?.id
          : undefined;
        expect(picked).toBe(eligible[0]?.profileId);
      }
    }
  });

  test("a failing route reports exactly the planner's rejections", () => {
    const economy = routePolicy({
      profiles: [SONNET_ENTRY, MISSING_ENTRY, DEEPSEEK_ENTRY],
      routes: {
        coordinator: ["sonnet", "missing", "deepseek"],
        decision: ["sonnet", "missing", "deepseek"],
        execution: ["sonnet", "missing", "deepseek"],
        escalation: ["sonnet", "missing", "deepseek"],
        retain: ["sonnet", "missing", "deepseek"],
      },
      profileBudget: { sonnet: "sota" },
    });
    const availability: ProviderAvailability[] = [{ provider: "claude", available: true }];
    const routing = describeModeRouting({ profiles: ROUTE_PROFILES, availability, economy });
    if (routing.status !== "ready") throw new Error("expected a ready routing");
    const host = { status: "ready" as const, profiles: ROUTE_PROFILES, availability };
    const rowFor = (route: (typeof ROUTES)[number]) =>
      routing.routes.find(
        (entry) =>
          entry.route === route && entry.taskKind === (route === "execution" ? "coding" : null),
      );
    for (const route of ROUTES) {
      const role = routeRole(route, "coding");
      const row = rowFor(route);
      expect(row).toBeDefined();
      if (row === undefined) return;
      if (route === "coordinator") {
        const resolved = resolveCoordinatorProfile({ mode: "economy-all", role, host, economy });
        expect(resolved.ok).toBe(false);
        if (resolved.ok) return;
        // The coordinator entry must name the same rejected candidates the table reports.
        expect(reportedRejections(row)).toEqual(plannerRejections(resolved.issues));
        continue;
      }
      const resolved = resolveModeProfile({
        mode: "economy-all",
        role,
        kind: "member",
        host,
        economy,
      });
      if (route === "escalation") {
        // A standby seat stays blocked instead of disappearing, with the same evidence.
        expect(resolved.ok && resolved.value.unavailable).toBe(true);
      } else {
        expect(resolved.ok).toBe(false);
      }
      // Member rejections match the table for budget-conflict, unverified and missing-live.
      expect(reportedRejections(row)).toEqual(plannerRejections(resolved.issues ?? []));
    }
  });

  test("a route id outside the allowlist is only counted, never reported", () => {
    const base = routePolicy({ profiles: [DEEPSEEK_ENTRY], routes: {} });
    if (base.allSeats?.status !== "ready") throw new Error("expected a ready policy");
    const economy: EconomyPolicy = {
      ...base,
      allSeats: { ...base.allSeats, routes: { execution: ["ghost"] }, executionTaskOrder: {} },
    };
    const availability: ProviderAvailability[] = [{ provider: "omp", available: true }];
    const routing = describeModeRouting({ profiles: ROUTE_PROFILES, availability, economy });
    if (routing.status !== "ready") throw new Error("expected a ready routing");
    const row = routing.routes.find(
      (entry) => entry.route === "execution" && entry.taskKind === "coding",
    );
    expect(row?.candidates).toEqual([
      {
        profileId: "ghost",
        family: null,
        eligible: false,
        reason: "outside-list",
        reported: false,
      },
    ]);
    const resolved = resolveModeProfile({
      mode: "economy-all",
      role: routeRole("execution", "coding"),
      kind: "member",
      host: { status: "ready", profiles: ROUTE_PROFILES, availability },
      economy,
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(plannerRejections(resolved.issues)).toEqual([]);
  });
});

// B03 spec: the real team.plan service feeds the real B03 view models. No RPC mocks for the
// planning path; only the transport is a direct service call.
import { describe, expect, test, vi } from "vitest";
import { profileBindingLabels } from "../../client/domain/validation";
import {
  buildTeamModelRows,
  buildTeamSummary,
  createTeamPlanClient,
  draftRowKey,
  familyHintsFromEconomy,
  TEAM_PLAN_CACHE_TTL_MS,
  TEAM_PLAN_DEBOUNCE_MS,
  TEAM_PLAN_MAX_DRAFT_MEMBERS,
  type TeamPlanDraftRequest,
} from "../../client/teams/team-plan-state";
import { createTeamPlanService } from "../../server/team-plan-service";
import type { Preferences } from "../../shared/schemas/preferences";
import type { Role } from "../../shared/schemas/role";
import type { Team } from "../../shared/schemas/team";
import type { TeamPlanInput, TeamPlanOutput } from "../../shared/schemas/team-plan";
import type { RolesDocument, TeamsDocument } from "../../shared/settings";
import { teamPlanZh } from "../../shared/zh/team-plan";
import { fakePort, healthyConfig, preferences } from "../fakes";
import { architect, claudeOpus, codingTeam, developer, techLead } from "../fixtures";
import { DesignSettingsStore } from "../helpers/design-settings-store";

const team = (id: string, overrides: Partial<Team> = {}): Team => ({
  ...codingTeam,
  id,
  name: id,
  ...overrides,
});

const storedTeams = [
  team("t-sota"),
  team("t-standard", { mode: "economy" }),
  team("t-all", { mode: "economy-all" }),
  team("t-unknown", { mode: "turbo" }),
  team("t-disabled", {
    members: [
      { roleId: architect.id, enabled: true },
      { roleId: developer.id, enabled: false },
    ],
  }),
  team("t-no-coordinator", { coordinatorRoleId: "gone" }),
  team("t-1"),
  team("t-2"),
  team("t-3"),
  team("t-4"),
];

function settingsStore(teams: readonly Team[] = storedTeams) {
  return new DesignSettingsStore({
    roles: { roles: [techLead, architect, developer] },
    teams: { teams: [...teams] },
    preferences: preferences as Preferences,
  });
}

function readers(settings: DesignSettingsStore) {
  return {
    roles: { read: async () => state<RolesDocument>(settings, "roles") },
    teams: { read: async () => state<TeamsDocument>(settings, "teams") },
    preferences: { read: async () => state<Preferences>(settings, "preferences") },
  };
}

function state<T>(settings: DesignSettingsStore, key: "roles" | "teams" | "preferences") {
  const read = settings.read(key);
  return { status: "ready" as const, revision: read.revision, values: read.values as T };
}

function clock() {
  let now = 0;
  let serial = 0;
  const timers: Array<{ id: number; at: number; run: () => void; done: boolean }> = [];
  return {
    now: () => now,
    schedule: (run: () => void, ms: number) => {
      serial += 1;
      timers.push({ id: serial, at: now + ms, run, done: false });
      return serial;
    },
    cancel: (handle: unknown) => {
      const timer = timers.find((entry) => entry.id === handle);
      if (timer) timer.done = true;
    },
    advance: (ms: number) => {
      now += ms;
      for (const timer of [...timers].sort((left, right) => left.at - right.at)) {
        if (timer.done || timer.at > now) continue;
        timer.done = true;
        timer.run();
      }
    },
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function setup(teams: readonly Team[] = storedTeams) {
  const settings = settingsStore(teams);
  const port = fakePort(healthyConfig).port;
  const service = createTeamPlanService({
    readers: readers(settings),
    now: () => new Date("2026-10-01T10:00:00.000Z"),
  });
  let sends = 0;
  const calls: TeamPlanInput[] = [];
  const send = (input: TeamPlanInput): Promise<TeamPlanOutput> => {
    sends += 1;
    calls.push(input);
    return service.plan(input, port);
  };
  const fake = clock();
  const client = createTeamPlanClient({
    send,
    now: fake.now,
    schedule: fake.schedule,
    cancel: fake.cancel,
  });
  client.setScope({
    hostId: "host",
    profiles: healthyConfig.agentProfiles,
    revisions: settings.revisions(),
  });
  return {
    settings,
    port,
    service,
    client,
    fake,
    calls,
    sends: () => sends,
  };
}

describe("first screen", () => {
  test("ten Teams make one request and the summaries match the rows", async () => {
    const fixture = setup();
    fixture.client.planTeams(storedTeams);
    await vi.waitFor(() => expect(fixture.sends()).toBe(1));
    await vi.waitFor(() => expect(fixture.client.getBatchView().results.size).toBe(10));
    const view = fixture.client.getBatchView();
    expect(view.hasContext).toBe(true);

    const summary = (id: string) => {
      const result = view.results.get(id);
      if (!result) throw new Error(`missing ${id}`);
      return buildTeamSummary({ result, hasContext: view.hasContext });
    };

    const sota = summary("t-sota");
    expect(sota.kind).toBe("summary");
    if (sota.kind === "summary") {
      expect(sota.total).toBe(3);
      expect(sota.groupsText).toContain("Opus ×2");
      expect(sota.groupsText).toContain("Codex xhigh ×1");
      expect(sota.unresolvedText).toBeNull();
    }
    expect(summary("t-standard").kind).toBe("summary");

    // A settings revision change clears the cache and forces a fresh batch.
    fixture.client.setScope({
      hostId: "host",
      profiles: healthyConfig.agentProfiles,
      revisions: { ...fixture.settings.revisions(), teams: "changed" },
    });
    expect(fixture.client.getBatchView().results.size).toBe(0);
    fixture.client.planTeams(storedTeams);
    await vi.waitFor(() => expect(fixture.sends()).toBe(2));
    const all = summary("t-all");
    expect(all.kind).toBe("summary");
    if (all.kind === "summary") {
      expect(all.unresolvedText).toContain("未解析 ×3");
    }
    const unknown = summary("t-unknown");
    expect(unknown.kind).toBe("unknown-mode");
    if (unknown.kind === "unknown-mode") expect(unknown.text).toContain("turbo");
    const disabled = summary("t-disabled");
    expect(disabled.kind).toBe("summary");
    if (disabled.kind === "summary") expect(disabled.total).toBe(2);
    const noCoordinator = summary("t-no-coordinator");
    expect(noCoordinator.kind).toBe("summary");
    if (noCoordinator.kind === "summary") expect(noCoordinator.unresolvedText).toContain("未解析");
  });

  test("a missing Team is distinct from a read failure", async () => {
    const fixture = setup();
    fixture.client.planTeams([...storedTeams, team("t-ghost")]);
    await vi.waitFor(() => expect(fixture.client.getBatchView().results.size).toBe(11));
    const view = fixture.client.getBatchView();
    const ghost = view.results.get("t-ghost");
    if (!ghost) throw new Error("missing ghost result");
    expect(buildTeamSummary({ result: ghost, hasContext: view.hasContext })).toEqual({
      kind: "missing-team",
      text: expect.any(String),
    });

    const broken = fakePort(healthyConfig);
    broken.port.config.get.mockRejectedValue(new Error("config off"));
    const settings = settingsStore([team("t-one")]);
    const service = createTeamPlanService({ readers: readers(settings) });
    const output = await service.plan(
      { items: [{ key: "t-one", kind: "saved", teamId: "t-one" }] },
      broken.port,
    );
    const result = output.results[0];
    if (!result) throw new Error("missing result");
    const summary = buildTeamSummary({ result, hasContext: output.context !== null });
    expect(summary.kind).toBe("unavailable");
  });

  test("an empty catalog probes once and never opens a batch", async () => {
    const fixture = setup([]);
    fixture.client.probe();
    await vi.waitFor(() => expect(fixture.sends()).toBe(1));
    await vi.waitFor(() => expect(fixture.client.getBatchView().modeContract).toBe("v2"));
    expect(fixture.calls[0]?.items).toEqual([]);
    expect(fixture.client.getBatchView().modeContract).toBe("v2");
  });

  test("only an explicit method-not-found is legacy", async () => {
    const legacy = createTeamPlanClient({
      send: async () => {
        throw new Error("Method not found: agent-team.team.plan");
      },
      now: () => 0,
      schedule: () => 0,
      cancel: () => undefined,
    });
    legacy.setScope({
      hostId: "host",
      profiles: healthyConfig.agentProfiles,
      revisions: { roles: "r", teams: "t", preferences: "p" },
    });
    legacy.probe();
    await vi.waitFor(() => expect(legacy.getBatchView().modeContract).toBe("legacy"));
    legacy.planTeams([storedTeams[0] as Team]);
    expect(legacy.getBatchView().results.size).toBe(0);
  });
});

describe("draft editor", () => {
  const draft = (overrides: Partial<TeamPlanDraftRequest> = {}): TeamPlanDraftRequest => ({
    sessionId: "editor",
    mode: "economy-all",
    coordinatorRoleId: techLead.id,
    members: [
      { rowKey: `seat:${architect.id}`, roleId: architect.id, enabled: true },
      { rowKey: "member:1", roleId: developer.id, enabled: false },
    ],
    ...overrides,
  });

  test("200ms debounce then rows keep disabled states and pool entry points", async () => {
    const fixture = setup();
    fixture.client.requestDraft(draft());
    fixture.fake.advance(199);
    await flush();
    expect(fixture.sends()).toBe(0);
    fixture.fake.advance(1);
    await vi.waitFor(() => expect(fixture.sends()).toBe(1));
    const item = fixture.calls[0]?.items[0];
    expect(item?.kind).toBe("draft");

    await vi.waitFor(() => expect(fixture.client.getDraftState("editor").status).toBe("result"));
    const state = fixture.client.getDraftState("editor");
    if (state.status !== "result") return;
    const rows = buildTeamModelRows({
      result: state.result,
      labels: new Map([["member:1", "Backend"]]),
    });
    const disabled = rows.find((row) => !row.enabled);
    expect(disabled).toMatchObject({
      instanceLabel: "Backend",
      profileName: null,
      actions: [],
    });
    const blocked = rows.filter((row) => row.enabled && row.profileName === null);
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.every((row) => row.actions.some((action) => action.kind === "economy"))).toBe(
      true,
    );
    // Pool/route failures never offer Role rebinding as the remedy.
    expect(blocked.every((row) => !row.actions.some((action) => action.kind === "role"))).toBe(
      true,
    );
  });

  test("an older draft response never replaces the newer one", async () => {
    const fixture = setup();
    const resolvers: Array<(value: TeamPlanOutput) => void> = [];
    const gated = createTeamPlanClient({
      send: (input) => {
        fixture.calls.push(input);
        const { promise, resolve } = Promise.withResolvers<TeamPlanOutput>();
        resolvers.push(resolve);
        return promise;
      },
      now: fixture.fake.now,
      schedule: fixture.fake.schedule,
      cancel: fixture.fake.cancel,
    });
    gated.setScope({
      hostId: "host",
      profiles: healthyConfig.agentProfiles,
      revisions: fixture.settings.revisions(),
    });
    gated.requestDraft(draft({ mode: "sota" }));
    fixture.fake.advance(200);
    await flush();
    gated.requestDraft(draft({ mode: "economy" }));
    fixture.fake.advance(200);
    await flush();
    expect(resolvers).toHaveLength(2);

    const newest = await fixture.service.plan(fixture.calls[1] as TeamPlanInput, fixture.port);
    resolvers[1]?.(newest);
    await flush();
    const older = await fixture.service.plan(fixture.calls[0] as TeamPlanInput, fixture.port);
    resolvers[0]?.(older);
    await vi.waitFor(() => expect(gated.getDraftState("editor").status).toBe("result"));
    const state = gated.getDraftState("editor");
    expect(state.status).toBe("result");
    if (state.status === "result") expect(state.result.effectiveMode).toBe("economy");
  });
});

describe("row actions", () => {
  test("a Role-binding blocker opens the Role with its configured Profile", async () => {
    const fixture = setup([team("t-bind")]);
    fixture.client.requestDraft({
      sessionId: "editor",
      mode: "sota",
      coordinatorRoleId: techLead.id,
      members: [{ rowKey: "member:0", roleId: "developer", enabled: true }],
    });
    fixture.fake.advance(200);
    await vi.waitFor(() => expect(fixture.client.getDraftState("editor").status).toBe("result"));
    const state = fixture.client.getDraftState("editor");
    if (state.status !== "result") throw new Error("expected a draft result");
    const row = state.result.rows.find((entry) => entry.kind === "member");
    const views = buildTeamModelRows({ result: state.result });
    const view = views.find((entry) => entry.rowKey === row?.rowKey);
    // Healthy host: the bound Codex Profile resolves, so no action is invented.
    expect(view?.profileName).toBe("Codex xhigh");
    expect(view?.actions).toEqual([]);
  });

  test("economy-all row keys stay unique across physical seats", async () => {
    const fixture = setup();
    fixture.client.requestDraft({
      sessionId: "editor",
      mode: "economy-all",
      coordinatorRoleId: techLead.id,
      members: [
        { rowKey: `seat:${architect.id}`, roleId: architect.id, enabled: true },
        { rowKey: "member:1", roleId: developer.id, enabled: false },
      ],
    });
    fixture.fake.advance(200);
    await vi.waitFor(() => expect(fixture.client.getDraftState("editor").status).toBe("result"));
    const state = fixture.client.getDraftState("editor");
    if (state.status !== "result") throw new Error("expected a draft result");
    const views = buildTeamModelRows({ result: state.result });
    expect(new Set(views.map((view) => view.key)).size).toBe(views.length);
    expect(views.every((view) => view.rowKey.length > 0)).toBe(true);
  });
});

describe("collaboration rows", () => {
  const sonnet = {
    id: "claude-sonnet",
    name: "Sonnet",
    provider: "claude",
    model: "claude-sonnet-4-6",
  };
  const deepseek = {
    id: "deepseek-coding",
    name: "DeepSeek",
    provider: "deepseek",
    model: "deepseek-coder",
  };
  const fullstack: Role = {
    ...architect,
    id: "eng-fullstack",
    name: "Fullstack",
    executionPolicy: { tier: "execution", taskKind: "coding" },
    preferredProfiles: [{ profileId: sonnet.id }],
    fallbackProfiles: [{ profileId: deepseek.id }],
  };
  const collaborative = team("t-collab", {
    mode: "collaborative",
    members: [
      { roleId: fullstack.id, seatId: "fs-1", enabled: true },
      { roleId: fullstack.id, seatId: "fs-2", enabled: false },
    ],
  });
  const poolPreferences: Preferences = {
    ...preferences,
    economy: {
      pool: [
        {
          profileId: sonnet.id,
          family: "sonnet",
          enabled: true,
          boundModel: { provider: "claude", model: sonnet.model },
        },
        {
          profileId: deepseek.id,
          family: "deepseek",
          enabled: true,
          boundModel: { provider: "deepseek", model: deepseek.model },
        },
      ],
    },
  };

  test("one draft row expands to several physical rows that share rowKey and differ by seatId", async () => {
    const settings = new DesignSettingsStore({
      roles: { roles: [techLead, fullstack] },
      teams: { teams: [collaborative] },
      preferences: poolPreferences,
    });
    const port = fakePort({
      agentProfiles: [claudeOpus, sonnet, deepseek],
      mcp: { enabled: true, injectIntoAgents: true },
    }).port;
    port.providers.listAvailable.mockResolvedValue({
      providers: [
        { provider: "claude", available: true },
        { provider: "codex", available: true },
        { provider: "deepseek", available: true },
      ],
    });
    const service = createTeamPlanService({ readers: readers(settings) });
    const fake = clock();
    const client = createTeamPlanClient({
      send: (input) => service.plan(input, port),
      now: fake.now,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    client.setScope({
      hostId: "host",
      profiles: [claudeOpus, sonnet, deepseek],
      revisions: settings.revisions(),
    });
    client.requestDraft({
      sessionId: "editor",
      mode: "collaborative",
      coordinatorRoleId: techLead.id,
      collaboration: { replicas: 2 },
      members: [{ rowKey: "seat:fs-1", roleId: fullstack.id, enabled: true }],
    });
    fake.advance(200);
    await vi.waitFor(() => expect(client.getDraftState("editor").status).toBe("result"));
    const state = client.getDraftState("editor");
    if (state.status !== "result") throw new Error("expected a draft result");
    const views = buildTeamModelRows({ result: state.result });
    const cohort = views.filter((view) => view.rowKey === "seat:fs-1");
    expect(cohort.length).toBeGreaterThanOrEqual(2);
    expect(new Set(cohort.map((view) => view.key)).size).toBe(cohort.length);
  });
});

describe("all-seats outage", () => {
  test("a cheap-route outage offers only the economy route, with a layer/route", async () => {
    const cheap = {
      id: "cheap-deepseek",
      name: "Cheap DeepSeek",
      provider: "deepseek",
      model: "deepseek-coder",
    };
    const outageTeam = team("t-outage", { mode: "economy-all" });
    const settings = new DesignSettingsStore({
      roles: { roles: [techLead, architect, developer] },
      teams: { teams: [outageTeam] },
      preferences: {
        ...preferences,
        economy: {
          allSeats: {
            version: 1,
            profiles: [
              {
                profileId: cheap.id,
                enabled: true,
                costClass: "low",
                family: "deepseek",
                boundModel: { provider: "deepseek", model: cheap.model },
              },
            ],
            routes: {
              coordinator: [cheap.id],
              decision: [cheap.id],
              execution: [cheap.id],
              escalation: [cheap.id],
              retain: [cheap.id],
            },
          },
        },
      },
    });
    const port = fakePort({
      agentProfiles: [claudeOpus, cheap],
      mcp: { enabled: true, injectIntoAgents: true },
    }).port;
    port.providers.listAvailable.mockResolvedValue({
      providers: [
        { provider: "claude", available: true },
        { provider: "deepseek", available: false, error: "quota" },
      ],
    });
    const service = createTeamPlanService({ readers: readers(settings) });
    const output = await service.plan(
      { items: [{ key: "t-outage", kind: "saved", teamId: "t-outage" }] },
      port,
    );
    const result = output.results[0];
    if (!result) throw new Error("missing result");
    expect(result.status).toBe("blocked");
    const views = buildTeamModelRows({ result });
    expect(views.length).toBeGreaterThan(0);
    for (const view of views) {
      expect(view.actions.some((action) => action.kind === "role")).toBe(false);
      const economy = view.actions.find((action) => action.kind === "economy");
      expect(economy).toBeDefined();
      if (economy?.kind === "economy") {
        expect(economy.layer).toBe("allSeats");
        expect(economy.route).toBeTruthy();
      }
    }
  });
});

describe("family hints from the real policy", () => {
  test("a tuple-matched all-seats entry is the only hint", () => {
    const hints = familyHintsFromEconomy(
      {
        allSeats: {
          version: 1,
          profiles: [
            {
              profileId: "codex-xhigh",
              enabled: true,
              costClass: "low",
              family: "deepseek",
              boundModel: { provider: "codex", model: "gpt-5.5" },
            },
          ],
          routes: {},
        },
      },
      healthyConfig.agentProfiles,
    );
    expect(hints).toEqual([
      { profileId: "codex-xhigh", provider: "codex", model: "gpt-5.5", family: "deepseek" },
    ]);
  });
});

// T2-32 independent additions. Kept separate from the implementer's cases; nothing above is
// edited. These assert externally visible client behavior, not helper internals.
describe("acceptance additions: first screen, cache, and degradation", () => {
  test("the first batch itself carries the capability answer; no separate probe RPC", async () => {
    const fixture = setup();
    fixture.client.planTeams(storedTeams);
    await vi.waitFor(() => expect(fixture.client.getBatchView().results.size).toBe(10));
    expect(fixture.sends()).toBe(1);
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]?.items).toHaveLength(10);
    expect(fixture.calls[0]?.items.every((item) => item.kind === "saved")).toBe(true);
    expect(fixture.client.getBatchView().modeContract).toBe("v2");
    expect(fixture.client.getBatchView().pending).toBe(false);
  });

  test("a repeat inside 60s is cached; expiry and a Profile tuple change both invalidate", async () => {
    const fixture = setup();
    fixture.client.planTeams(storedTeams);
    await vi.waitFor(() => expect(fixture.sends()).toBe(1));

    fixture.client.planTeams(storedTeams);
    await flush();
    expect(fixture.sends()).toBe(1);

    fixture.fake.advance(TEAM_PLAN_CACHE_TTL_MS + 1);
    fixture.client.planTeams(storedTeams);
    await vi.waitFor(() => expect(fixture.sends()).toBe(2));

    fixture.client.setScope({
      hostId: "host",
      profiles: healthyConfig.agentProfiles.map((profile) =>
        profile.id === "claude-opus-high" ? { ...profile, model: "opus-next" } : profile,
      ),
      revisions: fixture.settings.revisions(),
    });
    expect(fixture.client.getBatchView().results.size).toBe(0);
    fixture.client.planTeams(storedTeams);
    await vi.waitFor(() => expect(fixture.sends()).toBe(3));
  });

  test("a transport failure is unknown and retryable, never legacy", async () => {
    let sends = 0;
    const client = createTeamPlanClient({
      send: async () => {
        sends += 1;
        throw new Error("socket closed");
      },
      now: () => 0,
      schedule: () => 0,
      cancel: () => undefined,
    });
    client.setScope({
      hostId: "host",
      profiles: healthyConfig.agentProfiles,
      revisions: { roles: "r", teams: "t", preferences: "p" },
    });
    client.probe();
    await vi.waitFor(() => expect(client.getBatchView().loaded).toBe(true));
    expect(client.getBatchView().modeContract).toBe("unknown");
    expect(client.getBatchView().error).toBe(teamPlanZh.loadFailed);
    client.probe();
    await vi.waitFor(() => expect(sends).toBe(2));
  });

  test("only a method-not-found plan turns the batch legacy", async () => {
    let sends = 0;
    const client = createTeamPlanClient({
      send: async () => {
        sends += 1;
        throw new Error("Method not found: agent-team.team.plan");
      },
      now: () => 0,
      schedule: () => 0,
      cancel: () => undefined,
    });
    client.setScope({
      hostId: "host",
      profiles: healthyConfig.agentProfiles,
      revisions: { roles: "r", teams: "t", preferences: "p" },
    });
    client.planTeams([storedTeams[0] as Team]);
    await vi.waitFor(() => expect(client.getBatchView().modeContract).toBe("legacy"));
    expect(sends).toBe(1);
    expect(client.getBatchView().results.size).toBe(0);
    expect(client.getBatchView().error).toBeNull();
  });

  test("a missing Team uses its own copy, distinct from a read failure", async () => {
    const fixture = setup();
    fixture.client.planTeams([...storedTeams, team("t-ghost")]);
    await vi.waitFor(() => expect(fixture.client.getBatchView().results.size).toBe(11));
    const view = fixture.client.getBatchView();
    const ghost = view.results.get("t-ghost");
    if (!ghost) throw new Error("missing ghost");
    expect(buildTeamSummary({ result: ghost, hasContext: view.hasContext })).toEqual({
      kind: "missing-team",
      text: teamPlanZh.teamMissing,
    });

    const broken = fakePort(healthyConfig);
    broken.port.config.get.mockRejectedValue(new Error("config off"));
    const settings = settingsStore([team("t-one")]);
    const output = await createTeamPlanService({ readers: readers(settings) }).plan(
      { items: [{ key: "t-one", kind: "saved", teamId: "t-one" }] },
      broken.port,
    );
    const result = output.results[0];
    if (!result) throw new Error("missing result");
    const readFailure = buildTeamSummary({ result, hasContext: output.context !== null });
    expect(readFailure.kind).toBe("unavailable");
    if (readFailure.kind === "unavailable") {
      expect(readFailure.text).not.toBe(teamPlanZh.teamMissing);
      expect(readFailure.text.length).toBeGreaterThan(0);
    }
  });
});

describe("acceptance additions: draft identity and debounce", () => {
  const draft = (): TeamPlanDraftRequest => ({
    sessionId: "editor",
    mode: "economy-all",
    coordinatorRoleId: techLead.id,
    members: [
      { rowKey: `seat:${architect.id}`, roleId: architect.id, enabled: true },
      { rowKey: "member:1", roleId: developer.id, enabled: false },
    ],
  });

  test("the debounce is inside 150–250ms and the payload has selections only", async () => {
    expect(TEAM_PLAN_DEBOUNCE_MS).toBeGreaterThanOrEqual(150);
    expect(TEAM_PLAN_DEBOUNCE_MS).toBeLessThanOrEqual(250);
    const fixture = setup();
    fixture.client.requestDraft(draft());
    fixture.fake.advance(149);
    await flush();
    expect(fixture.sends()).toBe(0);
    fixture.fake.advance(51);
    await vi.waitFor(() => expect(fixture.sends()).toBe(1));

    const item = fixture.calls[0]?.items[0];
    if (item?.kind !== "draft") throw new Error("expected draft input");
    expect(item.draft.mode).toBe("economy-all");
    expect(item.draft.members).toHaveLength(2);
    for (const member of item.draft.members) {
      for (const key of Object.keys(member)) {
        expect(["rowKey", "roleId", "instanceLabel", "enabled"]).toContain(key);
      }
    }
    expect(JSON.stringify(item)).not.toMatch(/profile|systemPrompt|featureValues/u);
  });

  test("switching host discards an in-flight draft response", async () => {
    const fixture = setup();
    const resolvers: Array<(value: TeamPlanOutput) => void> = [];
    const gated = createTeamPlanClient({
      send: (input) => {
        fixture.calls.push(input);
        const { promise, resolve } = Promise.withResolvers<TeamPlanOutput>();
        resolvers.push(resolve);
        return promise;
      },
      now: fixture.fake.now,
      schedule: fixture.fake.schedule,
      cancel: fixture.fake.cancel,
    });
    gated.setScope({
      hostId: "host",
      profiles: healthyConfig.agentProfiles,
      revisions: fixture.settings.revisions(),
    });
    gated.requestDraft(draft());
    fixture.fake.advance(TEAM_PLAN_DEBOUNCE_MS);
    await flush();
    expect(resolvers).toHaveLength(1);
    gated.setScope({
      hostId: "other-host",
      profiles: healthyConfig.agentProfiles,
      revisions: fixture.settings.revisions(),
    });
    const output = await fixture.service.plan(fixture.calls[0] as TeamPlanInput, fixture.port);
    resolvers[0]?.(output);
    await flush();
    expect(gated.getDraftState("editor")).toEqual({ status: "idle" });
  });
});

describe("acceptance additions: collaboration, disabled, standby, bindings", () => {
  test("collaboration keeps one rowKey with distinct seatIds and logical seats", async () => {
    const sonnet = {
      id: "claude-sonnet",
      name: "Sonnet",
      provider: "claude",
      model: "claude-sonnet-4-6",
    };
    const deepseek = {
      id: "deepseek-coding",
      name: "DeepSeek",
      provider: "deepseek",
      model: "deepseek-coder",
    };
    const fullstack: Role = {
      ...architect,
      id: "eng-fullstack",
      name: "Fullstack",
      executionPolicy: { tier: "execution", taskKind: "coding" },
      preferredProfiles: [{ profileId: sonnet.id }],
      fallbackProfiles: [{ profileId: deepseek.id }],
    };
    const collaborative = team("t-collab", {
      mode: "collaborative",
      members: [{ roleId: fullstack.id, seatId: "fs-1", enabled: true }],
    });
    const settings = new DesignSettingsStore({
      roles: { roles: [techLead, fullstack] },
      teams: { teams: [collaborative] },
      preferences: {
        ...preferences,
        economy: {
          pool: [
            {
              profileId: sonnet.id,
              family: "sonnet",
              enabled: true,
              boundModel: { provider: "claude", model: sonnet.model },
            },
            {
              profileId: deepseek.id,
              family: "deepseek",
              enabled: true,
              boundModel: { provider: "deepseek", model: deepseek.model },
            },
          ],
        },
      } as Preferences,
    });
    const port = fakePort({
      agentProfiles: [claudeOpus, sonnet, deepseek],
      mcp: { enabled: true, injectIntoAgents: true },
    }).port;
    port.providers.listAvailable.mockResolvedValue({
      providers: [
        { provider: "claude", available: true },
        { provider: "codex", available: true },
        { provider: "deepseek", available: true },
      ],
    });
    const fake = clock();
    const client = createTeamPlanClient({
      send: (input) => createTeamPlanService({ readers: readers(settings) }).plan(input, port),
      now: fake.now,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    client.setScope({
      hostId: "host",
      profiles: [claudeOpus, sonnet, deepseek],
      revisions: settings.revisions(),
    });
    client.requestDraft({
      sessionId: "editor",
      mode: "collaborative",
      coordinatorRoleId: techLead.id,
      collaboration: { replicas: 2 },
      members: [{ rowKey: "seat:fs-1", roleId: fullstack.id, enabled: true }],
    });
    fake.advance(TEAM_PLAN_DEBOUNCE_MS);
    await vi.waitFor(() => expect(client.getDraftState("editor").status).toBe("result"));
    const state = client.getDraftState("editor");
    if (state.status !== "result") throw new Error("expected result");
    const cohort = state.result.rows.filter((row) => row.rowKey === "seat:fs-1");
    expect(cohort.length).toBeGreaterThanOrEqual(2);
    expect(new Set(cohort.map((row) => row.rowKey)).size).toBe(1);
    expect(new Set(cohort.map((row) => row.seatId)).size).toBe(cohort.length);
    expect(cohort.every((row) => typeof row.logicalSeatId === "string")).toBe(true);
    expect(cohort.every((row) => row.seatId !== undefined)).toBe(true);
  });

  test("a disabled member is excluded from the summary and has no model row action", async () => {
    const fixture = setup([
      team("t-off", {
        members: [
          { roleId: architect.id, enabled: true },
          { roleId: developer.id, enabled: false },
        ],
      }),
    ]);
    fixture.client.planTeams([
      team("t-off", {
        members: [
          { roleId: architect.id, enabled: true },
          { roleId: developer.id, enabled: false },
        ],
      }),
    ]);
    await vi.waitFor(() => expect(fixture.client.getBatchView().results.size).toBe(1));
    const result = fixture.client.getBatchView().results.get("t-off");
    if (!result) throw new Error("missing result");
    const summary = buildTeamSummary({
      result,
      hasContext: fixture.client.getBatchView().hasContext,
    });
    expect(summary).toMatchObject({ kind: "summary", total: 2, unresolvedText: null });
    const rows = buildTeamModelRows({ result });
    const disabled = rows.find((row) => !row.enabled);
    expect(disabled).toMatchObject({ profileName: null, actions: [] });
  });

  test("coordinator and standby physical seats count in the summary", async () => {
    const sonnet = {
      id: "claude-sonnet",
      name: "Sonnet",
      provider: "claude",
      model: "claude-sonnet-4-6",
    };
    const deepseek = {
      id: "deepseek-coding",
      name: "DeepSeek",
      provider: "deepseek",
      model: "deepseek-coder",
    };
    const escalationRole: Role = {
      ...architect,
      id: "eng-escalation",
      name: "Escalation",
      executionPolicy: { tier: "escalation", taskKind: "coding" },
      preferredProfiles: [{ profileId: sonnet.id }],
      fallbackProfiles: [],
    };
    const economyTeam = team("t-economy-standby", {
      mode: "economy-all",
      members: [{ roleId: escalationRole.id, enabled: true }],
    });
    const allSeats = {
      version: 1,
      profiles: [
        {
          profileId: sonnet.id,
          enabled: true,
          costClass: "low",
          family: "sonnet",
          boundModel: { provider: sonnet.provider, model: sonnet.model },
        },
        {
          profileId: deepseek.id,
          enabled: true,
          costClass: "low",
          family: "deepseek",
          boundModel: { provider: deepseek.provider, model: deepseek.model },
        },
      ],
      routes: {
        coordinator: [sonnet.id],
        decision: [sonnet.id],
        execution: [deepseek.id],
        escalation: [sonnet.id],
        retain: [sonnet.id],
      },
    };
    const settings = new DesignSettingsStore({
      roles: { roles: [techLead, escalationRole] },
      teams: { teams: [economyTeam] },
      preferences: { ...preferences, economy: { allSeats } } as Preferences,
    });
    const port = fakePort({
      agentProfiles: [claudeOpus, sonnet, deepseek],
      mcp: { enabled: true, injectIntoAgents: true },
    }).port;
    port.providers.listAvailable.mockResolvedValue({
      providers: [
        { provider: "claude", available: true },
        { provider: "codex", available: true },
        { provider: "deepseek", available: true },
      ],
    });
    const output = await createTeamPlanService({ readers: readers(settings) }).plan(
      { items: [{ key: "x", kind: "saved", teamId: economyTeam.id }] },
      port,
    );
    const result = output.results[0];
    if (!result) throw new Error("missing result");
    const summary = buildTeamSummary({ result, hasContext: output.context !== null });
    expect(summary).toMatchObject({
      kind: "summary",
      total: 2,
      groupsText: teamPlanZh.groupWithStandby("Sonnet", 2, 1),
    });
    const rows = buildTeamModelRows({ result });
    expect(rows.filter((row) => row.kind === "coordinator")).toHaveLength(1);
    expect(rows.filter((row) => row.standby)).toHaveLength(1);
  });

  test("Role cards keep stored binding order and live > snapshot > hint precedence", () => {
    const role: Role = {
      ...architect,
      preferredProfiles: [
        { profileId: claudeOpus.id },
        { profileId: "gone-snapshot", nameSnapshot: "Stored Name" },
        { profileId: "gone-hint", hint: { name: "Hint Name", provider: "claude" } },
        { profileId: "gone-bare" },
      ],
      fallbackProfiles: [],
    };
    const labels = profileBindingLabels(role, [claudeOpus]);
    expect(labels.preferred.map((entry) => entry.label)).toEqual([
      claudeOpus.name,
      "Stored Name",
      "Hint Name",
      null,
    ]);
    expect(labels.preferred.map((entry) => entry.missing)).toEqual([false, true, true, true]);
    expect(labels.fallback).toEqual([]);
  });

  test("a missing binding offers the Role target; an economy row offers the all-seats route", async () => {
    const ghostRole: Role = {
      ...architect,
      id: "ghost-binding",
      name: "Ghost binding",
      preferredProfiles: [{ profileId: "p-gone" }],
      fallbackProfiles: [],
    };
    const settings = new DesignSettingsStore({
      roles: { roles: [techLead, ghostRole] },
      teams: { teams: [] },
      preferences: preferences as Preferences,
    });
    const port = fakePort(healthyConfig).port;
    const fixture = setup();
    const service = createTeamPlanService({ readers: readers(settings) });
    const output = await service.plan(
      {
        items: [
          {
            key: "draft",
            kind: "draft",
            draft: {
              mode: "sota",
              coordinatorRoleId: techLead.id,
              members: [{ rowKey: "member:0", roleId: ghostRole.id, enabled: true }],
            },
          },
        ],
      },
      port,
    );
    const result = output.results[0];
    if (!result) throw new Error("missing result");
    const row = buildTeamModelRows({ result }).find((entry) => entry.roleId === ghostRole.id);
    expect(row?.profileName).toBeNull();
    // AC-0b.9: roleId is mandatory; the Profile hint is optional when no candidate is known.
    expect(row?.actions).toContainEqual({ kind: "role", roleId: ghostRole.id });

    // Default economy-all with no all-seats policy: the row's remedy is the route list.
    fixture.client.requestDraft({
      sessionId: "editor",
      mode: "economy-all",
      coordinatorRoleId: techLead.id,
      members: [{ rowKey: "member:0", roleId: architect.id, enabled: true }],
    });
    fixture.fake.advance(TEAM_PLAN_DEBOUNCE_MS);
    await vi.waitFor(() => expect(fixture.client.getDraftState("editor").status).toBe("result"));
    const state = fixture.client.getDraftState("editor");
    if (state.status !== "result") throw new Error("expected result");
    const views = buildTeamModelRows({ result: state.result });
    const economyAction = views
      .flatMap((view) => view.actions)
      .find((action) => action.kind === "economy");
    // K4: economy-all always targets the all-seats layer; the route is optional when the
    // blocked row has no derived route.
    expect(economyAction).toMatchObject({ kind: "economy", layer: "allSeats" });
  });

  test("draft rowKey rules: stored seat ids, index fallback, reserved and duplicate keys", async () => {
    expect(draftRowKey({ seatId: "fs-1" }, 0)).toBe("seat:fs-1");
    expect(draftRowKey({}, 3)).toBe("member:3");

    const fixture = setup();
    const cases: [TeamPlanDraftRequest, string][] = [
      [
        {
          sessionId: "editor",
          members: [{ rowKey: "coordinator", roleId: architect.id, enabled: true }],
        },
        teamPlanZh.reservedRowKey,
      ],
      [
        {
          sessionId: "editor",
          members: [
            { rowKey: "member:0", roleId: architect.id, enabled: true },
            { rowKey: "member:0", roleId: developer.id, enabled: true },
          ],
        },
        teamPlanZh.duplicateRowKey,
      ],
      [
        {
          sessionId: "editor",
          members: Array.from({ length: TEAM_PLAN_MAX_DRAFT_MEMBERS + 1 }, (_, index) => ({
            rowKey: `member:${index}`,
            roleId: architect.id,
            enabled: true,
          })),
        },
        teamPlanZh.tooManyMembers(TEAM_PLAN_MAX_DRAFT_MEMBERS),
      ],
    ];
    for (const [request, message] of cases) {
      fixture.client.requestDraft(request);
      await flush();
      expect(fixture.client.getDraftState("editor")).toMatchObject({
        status: "error",
        reason: "invalid",
        message,
      });
    }
    expect(fixture.sends()).toBe(0);
  });

  test("an availability query failure is unverified, never a ready selected Profile", async () => {
    const broken = fakePort(healthyConfig);
    broken.port.providers.listAvailable.mockRejectedValue(new Error("availability off"));
    const settings = settingsStore([team("t-one")]);
    const output = await createTeamPlanService({ readers: readers(settings) }).plan(
      { items: [{ key: "t-one", kind: "saved", teamId: "t-one" }] },
      broken.port,
    );
    const result = output.results[0];
    if (!result) throw new Error("missing result");
    const rows = buildTeamModelRows({ result });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.availability === "unverified")).toBe(true);
    expect(rows.every((row) => row.availabilityLabel === teamPlanZh.availability.unverified)).toBe(
      true,
    );
  });
});

import { describe, expect, test, vi } from "vitest";
import { createLaunchService } from "../server/launch-service";
import type { SettingsReader } from "../server/planning-context";
import { createTeamPlanService, TEAM_PLAN_CAPABILITIES } from "../server/team-plan-service";
import type { PaseoProfile } from "../shared/paseo/adapter";
import type { Preferences } from "../shared/schemas/preferences";
import type { Role } from "../shared/schemas/role";
import type { Team } from "../shared/schemas/team";
import type { TeamPlanInput, TeamPlanOutput } from "../shared/schemas/team-plan";
import { TeamPlanOutputSchema } from "../shared/schemas/team-plan";
import type { RolesDocument, TeamsDocument } from "../shared/settings";
import { fakePort, invalid, preferences } from "./fakes";
import { architect, claudeOpus, codexXhigh, codingTeam, developer, techLead } from "./fixtures";

const sonnet: PaseoProfile = {
  id: "claude-sonnet",
  name: "Claude Sonnet",
  provider: "claude",
  model: "claude-sonnet-4-6",
};

const deepseek: PaseoProfile = {
  id: "deepseek-coding",
  name: "DeepSeek Coding",
  provider: "deepseek",
  model: "deepseek-coder",
};

const cheapConfig = {
  agentProfiles: [claudeOpus, codexXhigh, sonnet, deepseek],
  mcp: { enabled: true, injectIntoAgents: true },
};

const allSeatsPolicy = {
  version: 1,
  profiles: [
    {
      profileId: sonnet.id,
      enabled: true,
      costClass: "low" as const,
      family: "sonnet",
      boundModel: { provider: sonnet.provider, model: sonnet.model },
    },
    {
      profileId: deepseek.id,
      enabled: true,
      costClass: "low" as const,
      family: "deepseek",
      boundModel: { provider: deepseek.provider, model: deepseek.model },
    },
  ],
  routes: {
    coordinator: [sonnet.id],
    decision: [sonnet.id, deepseek.id],
    execution: [deepseek.id, sonnet.id],
    escalation: [sonnet.id],
    retain: [sonnet.id],
  },
};

const cheapPreferences: Preferences = {
  ...preferences,
  economy: { allSeats: allSeatsPolicy },
};

const economyTeam: Team = { ...codingTeam, id: "economy-team", mode: "economy-all" };
const unknownTeam: Team = { ...codingTeam, id: "unknown-team", mode: "turbo" };
const standardTeam: Team = { ...codingTeam, id: "standard-team", mode: "economy" };

const onWorkspace = {
  teamId: codingTeam.id,
  task: "Add Stripe",
  target: { kind: "workspace" as const, workspaceId: "ws-1" },
};

function reading<T>(values: T, revision = "rev-1") {
  return { read: vi.fn(async () => ({ status: "ready" as const, values, revision })) };
}

function setup(
  options: {
    roles?: SettingsReader<RolesDocument>;
    teams?: SettingsReader<TeamsDocument>;
    preferences?: SettingsReader<Preferences>;
    config?: unknown;
    now?: () => Date;
  } = {},
) {
  const fake = fakePort(options.config ?? cheapConfig);
  const roles = options.roles ?? reading({ roles: [techLead, architect, developer] });
  const teams =
    options.teams ?? reading({ teams: [codingTeam, economyTeam, unknownTeam, standardTeam] });
  const prefs = options.preferences ?? reading(cheapPreferences);
  const log = vi.fn();
  const service = createTeamPlanService({
    readers: { roles, teams, preferences: prefs },
    now: options.now ?? (() => new Date("2026-10-01T10:00:00.000Z")),
    log,
  });
  return { ...fake, service, log, roles, teams, prefs };
}

function valid(output: TeamPlanOutput): TeamPlanOutput {
  const parsed = TeamPlanOutputSchema.parse(output);
  expect(parsed.results).toHaveLength(output.results.length);
  return parsed;
}

function resultOf(output: TeamPlanOutput, key: string) {
  const result = output.results.find((entry) => entry.key === key);
  if (!result) throw new Error(`missing result ${key}`);
  return result;
}

function saved(key: string, teamId: string): TeamPlanInput["items"][number] {
  return { key, kind: "saved", teamId };
}

describe("team plan parity with launch preview", () => {
  test("rows match the coordinator and every seat of the same snapshot", async () => {
    const fixture = setup();
    const preview = await createLaunchService({
      roles: fixture.roles,
      teams: fixture.teams,
      preferences: fixture.prefs,
    }).preview({ ...onWorkspace, teamId: standardTeam.id }, fixture.port);
    if (!preview.ok) throw new Error(`unexpected blockers: ${preview.blockers.join(", ")}`);

    const output = valid(
      await fixture.service.plan({ items: [saved("s", standardTeam.id)] }, fixture.port),
    );
    const result = resultOf(output, "s");
    expect(result.status).toBe("ready");
    expect(result.effectiveMode).toBe("economy");
    const coordinator = result.rows.find((row) => row.kind === "coordinator");
    expect(coordinator?.profile?.id).toBe(preview.preview.coordinator.profile?.id);
    expect(coordinator?.source).toBe(preview.preview.coordinator.source);
    expect(coordinator?.budget).toBe(preview.preview.coordinator.budget);
    expect(coordinator?.budgetBasis).toBe(preview.preview.coordinator.budgetBasis);
    expect(coordinator?.availability).toBe("available");

    for (const seat of preview.preview.seats) {
      const row = result.rows.find((entry) => entry.seatId === seat.seatId);
      if (!row) throw new Error(`missing row for seat ${seat.seatId}`);
      expect(row.profile?.id).toBe(seat.profile?.id);
      expect(row.source).toBe(seat.source);
      expect(row.budget).toBe(seat.budget);
      expect(row.budgetBasis).toBe(seat.budgetBasis);
      expect(row.availability).toBe("available");
      expect(row.issues).toEqual(seat.issues);
    }
  });

  test("economy-all rows match the preview on a cheap host", async () => {
    const fixture = setup();
    const preview = await createLaunchService({
      roles: fixture.roles,
      teams: fixture.teams,
      preferences: fixture.prefs,
    }).preview({ ...onWorkspace, teamId: economyTeam.id, contractVersion: 2 }, fixture.port);
    if (!preview.ok) throw new Error(`unexpected blockers: ${preview.blockers.join(", ")}`);
    const output = valid(
      await fixture.service.plan({ items: [saved("s", economyTeam.id)] }, fixture.port),
    );
    const result = resultOf(output, "s");
    expect(result.status).toBe("ready");
    expect(result.effectiveMode).toBe("economy-all");
    const coordinator = result.rows.find((row) => row.kind === "coordinator");
    expect(coordinator).toMatchObject({
      profile: { id: sonnet.id },
      source: "economy-pool",
      route: "coordinator",
    });
    for (const seat of preview.preview.seats) {
      const row = result.rows.find((entry) => entry.seatId === seat.seatId);
      if (!row) throw new Error(`missing row for seat ${seat.seatId}`);
      expect({ id: row.profile?.id, source: row.source }).toEqual({
        id: seat.profile?.id,
        source: seat.source,
      });
    }
  });
});

describe("team plan batching and probe", () => {
  test("one batch reads each source once regardless of item count", async () => {
    const fixture = setup();
    const drafts: TeamPlanInput["items"] = Array.from({ length: 5 }, (_, index) => ({
      key: `d${index}`,
      kind: "draft" as const,
      draft: {
        mode: "sota",
        coordinatorRoleId: techLead.id,
        members: [
          { rowKey: `r${index}-1`, roleId: architect.id, enabled: true },
          { rowKey: `r${index}-2`, roleId: developer.id, enabled: true },
        ],
      },
    }));
    const items: TeamPlanInput["items"] = [
      saved("s1", codingTeam.id),
      saved("s2", economyTeam.id),
      saved("s3", unknownTeam.id),
      saved("s4", standardTeam.id),
      saved("s5", "missing-team"),
      ...drafts,
    ];
    const output = valid(await fixture.service.plan({ items }, fixture.port));
    expect(output.results).toHaveLength(10);
    expect(output.context).not.toBeNull();
    expect(fixture.roles.read).toHaveBeenCalledTimes(1);
    expect(fixture.teams.read).toHaveBeenCalledTimes(1);
    expect(fixture.prefs.read).toHaveBeenCalledTimes(1);
    expect(fixture.port.config.get).toHaveBeenCalledTimes(1);
    expect(fixture.port.providers.listAvailable).toHaveBeenCalledTimes(1);
    expect(fixture.port.projects.list).not.toHaveBeenCalled();
    expect(fixture.port.workspaces.list).not.toHaveBeenCalled();
    expect(fixture.port.workspaces.ref).not.toHaveBeenCalled();
  });

  test("the empty probe returns capabilities without reading anything", async () => {
    const fixture = setup();
    const output = valid(await fixture.service.plan({ items: [] }, fixture.port));
    expect(output).toMatchObject({
      capabilities: TEAM_PLAN_CAPABILITIES,
      context: null,
      results: [],
    });
    expect(output.capabilities.supportedModes).toContain("economy-all");
    expect(fixture.roles.read).not.toHaveBeenCalled();
    expect(fixture.teams.read).not.toHaveBeenCalled();
    expect(fixture.prefs.read).not.toHaveBeenCalled();
    expect(fixture.port.config.get).not.toHaveBeenCalled();
    expect(fixture.port.providers.listAvailable).not.toHaveBeenCalled();
  });

  test("a missing saved Team is unavailable with no issue, unlike a failed snapshot", async () => {
    const fixture = setup();
    const output = valid(
      await fixture.service.plan({ items: [saved("missing", "nope")] }, fixture.port),
    );
    const result = resultOf(output, "missing");
    expect(result).toMatchObject({
      status: "unavailable",
      effectiveMode: null,
      selectionFingerprint: null,
      rows: [],
      issues: [],
    });
    expect(output.context).not.toBeNull();
  });
});

describe("team plan failure paths", () => {
  test("a failed config read makes the whole batch unavailable with a reason", async () => {
    const fixture = setup();
    fixture.port.config.get.mockRejectedValue(new Error("connect /secret/path token=ABC"));
    const output = valid(
      await fixture.service.plan(
        { items: [saved("a", codingTeam.id), saved("b", economyTeam.id)] },
        fixture.port,
      ),
    );
    expect(output.context).toBeNull();
    for (const result of output.results) {
      expect(result.status).toBe("unavailable");
      expect(result.rows).toEqual([]);
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          code: "MODE_CONTEXT_UNAVAILABLE",
          params: expect.objectContaining({ reason: "config-read-failed" }),
        }),
      );
    }
    expect(JSON.stringify(output)).not.toContain("/secret/path");
    expect(JSON.stringify(output)).not.toContain("token=ABC");
    expect(fixture.log).toHaveBeenCalled();
  });

  test("invalid settings make the batch unavailable and name the document", async () => {
    const fixture = setup({ roles: invalid() });
    const output = valid(
      await fixture.service.plan({ items: [saved("a", codingTeam.id)] }, fixture.port),
    );
    expect(output.context).toBeNull();
    expect(resultOf(output, "a").issues).toContainEqual(
      expect.objectContaining({
        code: "MODE_CONTEXT_UNAVAILABLE",
        params: expect.objectContaining({ reason: "settings-invalid", document: "roles" }),
      }),
    );
  });

  test("an availability failure blocks the new modes but leaves SOTA ready and unverified", async () => {
    const fixture = setup();
    fixture.port.providers.listAvailable.mockRejectedValue(new Error("providers offline"));
    const output = valid(
      await fixture.service.plan(
        { items: [saved("sota", codingTeam.id), saved("all", economyTeam.id)] },
        fixture.port,
      ),
    );
    const sota = resultOf(output, "sota");
    expect(sota.status).toBe("ready");
    expect(sota.rows.every((row) => row.availability === "unverified")).toBe(true);
    const all = resultOf(output, "all");
    expect(all.status).toBe("blocked");
    expect(all.issues).toContainEqual(
      expect.objectContaining({ code: "MODE_CONTEXT_UNAVAILABLE" }),
    );
  });

  test("an unknown stored mode keeps the raw value and is blocked", async () => {
    const fixture = setup();
    const result = resultOf(
      valid(await fixture.service.plan({ items: [saved("u", unknownTeam.id)] }, fixture.port)),
      "u",
    );
    expect(result).toMatchObject({ status: "blocked", effectiveMode: null, rawMode: "turbo" });
    expect(result.rows.every((row) => row.profile === null)).toBe(true);
  });
});

describe("team plan rows", () => {
  test("disabled members become explicit rows and never claim a selection", async () => {
    const disabled: Team = {
      ...codingTeam,
      id: "disabled-team",
      members: [
        { roleId: architect.id, enabled: true },
        { roleId: developer.id, enabled: false },
      ],
    };
    const fixture = setup({ teams: reading({ teams: [disabled] }) });
    const result = resultOf(
      valid(await fixture.service.plan({ items: [saved("d", disabled.id)] }, fixture.port)),
      "d",
    );
    const row = result.rows.find((entry) => entry.enabled === false);
    expect(row).toMatchObject({
      roleId: developer.id,
      profile: null,
      enabled: false,
      budget: "unknown",
      budgetBasis: "conservative-default",
    });
  });

  test("saved row keys come from stored members, not derived seat ids", async () => {
    const keyed: Team = {
      ...codingTeam,
      id: "keyed-team",
      members: [
        { roleId: architect.id, seatId: "stored-seat", enabled: true },
        { roleId: developer.id, enabled: true },
      ],
    };
    const fixture = setup({ teams: reading({ teams: [keyed] }) });
    const result = resultOf(
      valid(await fixture.service.plan({ items: [saved("k", keyed.id)] }, fixture.port)),
      "k",
    );
    expect(result.rows.map((row) => row.rowKey)).toEqual([
      "coordinator",
      "seat:stored-seat",
      "member:1",
    ]);
    expect(result.rows.find((row) => row.rowKey === "seat:stored-seat")?.seatId).toBe(
      "stored-seat",
    );
  });

  test("logical seat ids mirror seat-plan when an explicit id collides", async () => {
    const team: Team = {
      ...codingTeam,
      id: "collision-team",
      members: [
        { roleId: architect.id, enabled: true },
        { roleId: developer.id, seatId: "seat-1", enabled: true },
      ],
    };
    const fixture = setup({ teams: reading({ teams: [team] }) });
    const result = resultOf(
      valid(await fixture.service.plan({ items: [saved("c", team.id)] }, fixture.port)),
      "c",
    );
    expect(
      result.rows
        .filter((row) => row.kind === "member")
        .map((row) => ({ rowKey: row.rowKey, logicalSeatId: row.logicalSeatId })),
    ).toEqual([
      { rowKey: "member:0", logicalSeatId: "seat-1-2" },
      { rowKey: "seat:seat-1", logicalSeatId: "seat-1" },
    ]);
  });

  test("a legacy coordinator failure is blocked with a member-shaped issue", async () => {
    const brokenCoordinator: Role = {
      ...techLead,
      preferredProfiles: [{ profileId: "ghost" }],
      fallbackProfiles: [],
    };
    const team: Team = { ...codingTeam, id: "broken-team" };
    const fixture = setup({
      roles: reading({ roles: [brokenCoordinator, architect, developer] }),
      teams: reading({ teams: [team] }),
    });
    const result = resultOf(
      valid(await fixture.service.plan({ items: [saved("b", team.id)] }, fixture.port)),
      "b",
    );
    expect(result.status).toBe("blocked");
    const coordinator = result.rows.find((row) => row.kind === "coordinator");
    expect(coordinator?.profile).toBeNull();
    expect(coordinator?.issues).toContainEqual(
      expect.objectContaining({
        code: "MODE_PROFILE_UNRESOLVED",
        severity: "blocker",
        roleId: brokenCoordinator.id,
        params: expect.objectContaining({ reason: "all-missing" }),
      }),
    );
  });

  test("draft members keep their row key across physical rows", async () => {
    const memberRole: Role = {
      ...developer,
      id: "eng-fullstack",
      name: "Fullstack",
      executionPolicy: { tier: "execution", taskKind: "coding" },
      preferredProfiles: [{ profileId: sonnet.id }],
      fallbackProfiles: [{ profileId: deepseek.id }],
    };
    const input: TeamPlanInput = {
      items: [
        {
          key: "draft",
          kind: "draft",
          draft: {
            mode: "collaborative",
            coordinatorRoleId: techLead.id,
            collaboration: { replicas: 2 },
            members: [
              { rowKey: "backend", roleId: memberRole.id, enabled: true },
              { rowKey: "disabled", roleId: memberRole.id, enabled: false },
            ],
          },
        },
      ],
    };
    const pooled: Preferences = {
      ...preferences,
      economy: {
        pool: [
          {
            profileId: sonnet.id,
            family: "sonnet",
            enabled: true,
            boundModel: { provider: sonnet.provider, model: sonnet.model },
          },
          {
            profileId: deepseek.id,
            family: "deepseek",
            enabled: true,
            boundModel: { provider: deepseek.provider, model: deepseek.model },
          },
        ],
      },
    };
    const fixture = setup({
      roles: reading({ roles: [techLead, memberRole] }),
      teams: reading({ teams: [] }),
      preferences: reading(pooled),
    });
    fixture.port.providers.listAvailable.mockResolvedValue({
      providers: [
        { provider: "claude", available: true },
        { provider: "codex", available: true },
        { provider: "deepseek", available: true },
      ],
    });
    const result = resultOf(valid(await fixture.service.plan(input, fixture.port)), "draft");
    const physical = result.rows.filter((row) => row.rowKey === "backend");
    expect(physical.length).toBeGreaterThanOrEqual(2);
    expect(new Set(physical.map((row) => row.seatId)).size).toBe(physical.length);
    expect(physical.every((row) => row.logicalSeatId === "backend")).toBe(true);
    expect(physical.filter((row) => row.purpose === "candidate")).toHaveLength(2);
    expect(result.rows.find((row) => row.rowKey === "disabled")).toMatchObject({
      enabled: false,
      profile: null,
    });
  });

  test("a draft row may not take the coordinator row key", async () => {
    const fixture = setup();
    const input: TeamPlanInput = {
      items: [
        {
          key: "bad",
          kind: "draft",
          draft: { members: [{ rowKey: "coordinator", roleId: developer.id, enabled: true }] },
        },
      ],
    };
    const result = resultOf(valid(await fixture.service.plan(input, fixture.port)), "bad");
    expect(result.status).toBe("blocked");
    expect(result.rows).toEqual([]);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "MODE_SEAT_DUPLICATE",
        params: expect.objectContaining({ reason: "row-key-reserved" }),
      }),
    );
  });

  test("an empty draft is blocked instead of looking ready", async () => {
    const fixture = setup();
    const input: TeamPlanInput = {
      items: [
        {
          key: "empty",
          kind: "draft",
          draft: { mode: "sota", coordinatorRoleId: techLead.id, members: [] },
        },
      ],
    };
    const result = resultOf(valid(await fixture.service.plan(input, fixture.port)), "empty");
    expect(result.status).toBe("blocked");
    expect(result.rows.filter((row) => row.kind === "member")).toEqual([]);
  });
});

describe("team plan status agrees with launch preview", () => {
  test("a preview that fails for a non-tool reason is blocked here too", async () => {
    const stale: Team = { ...codingTeam, id: "stale-team", memberCreation: "on-demand" };
    for (const fixture of [
      {
        name: "unknown mode",
        team: unknownTeam,
        roles: { roles: [techLead, architect, developer] },
        prefs: cheapPreferences,
      },
      {
        name: "missing coordinator role",
        team: { ...codingTeam, id: "no-coordinator", coordinatorRoleId: "gone" },
        roles: { roles: [architect, developer] },
        prefs: cheapPreferences,
      },
      {
        name: "no enabled members",
        team: {
          ...codingTeam,
          id: "nobody",
          members: [{ roleId: architect.id, enabled: false }],
        },
        roles: { roles: [techLead, architect, developer] },
        prefs: cheapPreferences,
      },
      {
        name: "stale escalation-only",
        team: stale,
        roles: { roles: [techLead, architect, developer] },
        prefs: cheapPreferences,
      },
      {
        name: "legacy coordinator failure",
        team: { ...codingTeam, id: "broken-legacy" },
        roles: {
          roles: [
            { ...techLead, preferredProfiles: [{ profileId: "ghost" }], fallbackProfiles: [] },
            architect,
            developer,
          ],
        },
        prefs: cheapPreferences,
      },
    ]) {
      const fake = fakePort(cheapConfig);
      const readers = {
        roles: reading(fixture.roles),
        teams: reading({ teams: [fixture.team] }),
        preferences: reading(fixture.prefs),
      };
      const preview = await createLaunchService(readers).preview(
        { ...onWorkspace, teamId: fixture.team.id },
        fake.port,
      );
      expect(preview.ok, fixture.name).toBe(false);
      const plans = createTeamPlanService({ readers });
      const result = resultOf(
        valid(await plans.plan({ items: [saved("x", fixture.team.id)] }, fake.port)),
        "x",
      );
      expect(result.status, fixture.name).toBe("blocked");
    }
  });

  test("a launchable Team is ready, and preview is ok", async () => {
    const fixture = setup();
    const preview = await createLaunchService({
      roles: fixture.roles,
      teams: fixture.teams,
      preferences: fixture.prefs,
    }).preview(onWorkspace, fixture.port);
    expect(preview.ok).toBe(true);
    const result = resultOf(
      valid(await fixture.service.plan({ items: [saved("x", codingTeam.id)] }, fixture.port)),
      "x",
    );
    expect(result.status).toBe("ready");
  });
});

describe("team plan selection fingerprint", () => {
  test("ignores checkedAt and unreferenced names, follows host runtime tuples", async () => {
    const first = setup({ now: () => new Date("2026-10-01T10:00:00.000Z") });
    const one = valid(await first.service.plan({ items: [saved("s", codingTeam.id)] }, first.port));
    const second = setup({ now: () => new Date("2026-10-02T10:00:00.000Z") });
    const two = valid(
      await second.service.plan({ items: [saved("s", codingTeam.id)] }, second.port),
    );
    expect(resultOf(two, "s").selectionFingerprint).toBe(resultOf(one, "s").selectionFingerprint);
    expect(two.checkedAt).not.toBe(one.checkedAt);

    const renamed = setup({
      config: {
        ...cheapConfig,
        agentProfiles: cheapConfig.agentProfiles.map((profile) =>
          profile.id === codexXhigh.id ? { ...profile, name: "Renamed" } : profile,
        ),
      },
    });
    const rename = valid(
      await renamed.service.plan({ items: [saved("s", codingTeam.id)] }, renamed.port),
    );
    expect(resultOf(rename, "s").selectionFingerprint).toBe(
      resultOf(one, "s").selectionFingerprint,
    );
    expect(rename.context?.profilesFingerprint).not.toBe(one.context?.profilesFingerprint);

    const rebound = setup({
      config: {
        ...cheapConfig,
        agentProfiles: cheapConfig.agentProfiles.map((profile) =>
          profile.id === codexXhigh.id ? { ...profile, thinkingOptionId: "high" } : profile,
        ),
      },
    });
    const tuple = valid(
      await rebound.service.plan({ items: [saved("s", codingTeam.id)] }, rebound.port),
    );
    expect(resultOf(tuple, "s").selectionFingerprint).not.toBe(
      resultOf(one, "s").selectionFingerprint,
    );
  });
});

describe("shared snapshot constants", () => {
  test("capabilities advertise the mode contract and runtime flags", async () => {
    const fixture = setup();
    const output = valid(await fixture.service.plan({ items: [] }, fixture.port));
    expect(output.capabilities).toEqual({
      modeContract: 2,
      designRolePolicy: 1,
      supportedModes: expect.arrayContaining(["sota", "economy", "economy-all", "collaborative"]),
      runtimeCapabilities: { onDemand: false, expansion: false, collaboration: false },
    });
  });
});

// P1 V01b contract integration: the real planning kernel, launch plan, and both RPC services over
// one settings/host snapshot. Expectations come from 04 §8 and 01 AC-0b/0c/0d (plus X1–X12), not
// from the current implementation shape. No fake planner here: only Paseo/settings ports are fakes.
import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import {
  buildDesignRoleGapViews,
  createDesignRetryCache,
  planDesignGapRetry,
} from "../client/designer/submission-state";
import { createTeamPlanClient } from "../client/teams/team-plan-state";
import { describeModeRouting } from "../server/designer/context";
import { checkGapEconomyEligibility } from "../server/designer/planning";
import { createLaunchService } from "../server/launch-service";
import type { SettingsReader } from "../server/planning-context";
import { createTeamPlanService } from "../server/team-plan-service";
import { launchPlanFingerprint } from "../shared/domain/launch-hash";
import { buildLaunchPlan, type LaunchPlan } from "../shared/domain/launch-plan";
import { toModeLaunchPreview } from "../shared/domain/launch-preview";
import { type EconomyPolicy, normalizeEconomyPolicy } from "../shared/domain/mode-resolver";
import { buildSeatPlan } from "../shared/domain/seat-plan";
import { buildTeamModelPlan } from "../shared/domain/team-model-plan";
import type { PaseoProfile, ProviderAvailability } from "../shared/paseo/adapter";
import { type DesignJob, DesignRoleGapSchema } from "../shared/schemas/design";
import type { Preferences } from "../shared/schemas/preferences";
import type { Role } from "../shared/schemas/role";
import type { Team } from "../shared/schemas/team";
import type { TeamPlanInput, TeamPlanOutput } from "../shared/schemas/team-plan";
import { TeamPlanOutputSchema } from "../shared/schemas/team-plan";
import type { RolesDocument, TeamsDocument } from "../shared/settings";
import { zh } from "../shared/zh";
import { designJob } from "./design-fixtures";
import { fakePort, preferences } from "./fakes";
import {
  architect,
  claudeOpus,
  codexXhigh,
  codingTeam,
  developer,
  role,
  techLead,
} from "./fixtures";

const sonnet: PaseoProfile = {
  id: "p-sonnet",
  name: "Sonnet",
  provider: "claude",
  model: "claude-sonnet-4-6",
};
const deepseek: PaseoProfile = {
  id: "p-deepseek",
  name: "DeepSeek",
  provider: "codex",
  model: "deepseek-coder",
};
const profiles: PaseoProfile[] = [claudeOpus, codexXhigh, sonnet, deepseek];
const available: ProviderAvailability[] = [
  { provider: "claude", available: true },
  { provider: "codex", available: true },
];
const capabilities = { onDemand: true, expansion: true, collaboration: true };
const daemonConfig = { mcp: { enabled: true, injectIntoAgents: true } };
const emptyEconomy = economyOf({ pool: [], taskOrder: {}, profileBudget: {} });
const standardEconomy = economyOf({
  pool: [
    {
      profileId: deepseek.id,
      family: "deepseek",
      enabled: true,
      boundModel: { provider: deepseek.provider, model: deepseek.model },
    },
  ],
  taskOrder: {},
  profileBudget: {},
});

const decisionRole = role({
  id: "decision-role",
  name: "Decision",
  executionPolicy: { tier: "decision", taskKind: "general" },
});
const executionRole = role({
  id: "execution-role",
  name: "Execution",
  executionPolicy: { tier: "execution", taskKind: "coding" },
});
const escalationRole = role({
  id: "escalation-role",
  name: "Escalation",
  executionPolicy: { tier: "escalation", taskKind: "coding" },
});
const retainRole = role({
  id: "retain-role",
  name: "Retain",
  executionPolicy: { tier: "retain", taskKind: "general" },
});
const allRoles: Role[] = [
  techLead,
  architect,
  developer,
  decisionRole,
  executionRole,
  escalationRole,
  retainRole,
];

const tierTeam: Team = {
  ...codingTeam,
  id: "tier-team",
  mode: "economy-all",
  members: [
    { roleId: decisionRole.id, enabled: true },
    { roleId: executionRole.id, enabled: true },
    { roleId: escalationRole.id, enabled: true },
    { roleId: retainRole.id, enabled: true },
  ],
};

const allSeatsRoutes = {
  coordinator: [sonnet.id],
  decision: [sonnet.id],
  execution: [deepseek.id],
  escalation: [sonnet.id],
  retain: [sonnet.id],
};

function entry(profile: PaseoProfile, family: string, extra: Record<string, unknown> = {}) {
  return {
    profileId: profile.id,
    enabled: true,
    costClass: "low",
    family,
    boundModel: { provider: profile.provider, model: profile.model },
    ...extra,
  };
}

function allSeatsPolicy(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    profiles: [entry(sonnet, "sonnet"), entry(deepseek, "deepseek")],
    routes: allSeatsRoutes,
    ...overrides,
  };
}

function economyOf(raw: Record<string, unknown>): EconomyPolicy {
  const normalized = normalizeEconomyPolicy(raw, profiles);
  if (!normalized.ok) throw new Error(`economy fixture invalid: ${JSON.stringify(raw)}`);
  return normalized.value;
}

function launch(
  team: Team,
  economy: EconomyPolicy,
  overrides: {
    runtimeCapabilities?: typeof capabilities;
    hostAvailability?: ProviderAvailability[];
    roles?: readonly Role[];
  } = {},
) {
  return buildLaunchPlan({
    team,
    roles: overrides.roles ?? allRoles,
    profiles,
    availability: overrides.hostAvailability ?? available,
    workspaceId: "ws-1",
    task: "Add Stripe",
    runId: "run-v01b",
    maxMembers: 8,
    host: {
      status: "ready",
      profiles,
      availability: overrides.hostAvailability ?? available,
    },
    economy,
    runtimeCapabilities: overrides.runtimeCapabilities ?? capabilities,
    daemonConfig,
  });
}

function seat(plan: LaunchPlan, roleId: string) {
  const found = plan.seats.find((item) => item.roleId === roleId);
  if (!found) throw new Error(`missing seat ${roleId}`);
  return found;
}

function issueCodes(plan: LaunchPlan): string[] {
  return plan.seatIssues.map((issue) => issue.code);
}

describe("P1 contract integration: legacy sota / standard modes", () => {
  test("sota keeps every Role binding and reports no mode issues", () => {
    const plan = launch({ ...codingTeam, mode: "sota" }, emptyEconomy);
    expect(plan.blockers).toEqual([]);
    expect(plan.coordinator.profile.id).toBe(claudeOpus.id);
    expect(seat(plan, architect.id).selected.profile?.id).toBe(claudeOpus.id);
    expect(seat(plan, developer.id).selected.profile?.id).toBe(codexXhigh.id);
    expect(plan.seatIssues.filter((issue) => issue.code.startsWith("MODE_CHEAP"))).toEqual([]);
  });

  const executionTeam: Team = {
    ...codingTeam,
    mode: "economy",
    members: [{ roleId: executionRole.id, enabled: true }],
  };

  test("standard: the execution pool is used, the coordinator keeps its binding", () => {
    const plan = launch(executionTeam, standardEconomy);
    expect(plan.blockers).toEqual([]);
    expect(plan.coordinator.profile.id).toBe(claudeOpus.id);
    const member = seat(plan, executionRole.id).selected;
    expect(member.profile?.id).toBe(deepseek.id);
    expect(member.budget).toBe("economy");
    expect(member.budgetBasis).toBe("pool");
  });

  test("standard with an empty pool falls back to the original binding with a warning", () => {
    const plan = launch(executionTeam, emptyEconomy);
    expect(plan.blockers).toEqual([]);
    expect(seat(plan, executionRole.id).selected.profile?.id).toBe(claudeOpus.id);
    expect(issueCodes(plan)).toContain("MODE_POOL_EMPTY");
  });

  test("an unavailable pool provider falls back to the Role binding with a warning", () => {
    const plan = launch(executionTeam, standardEconomy, {
      hostAvailability: [
        { provider: "claude", available: true },
        { provider: "codex", available: false },
      ],
    });
    expect(plan.blockers).toEqual([]);
    const member = seat(plan, executionRole.id).selected;
    expect(member.profile?.id).toBe(claudeOpus.id);
    expect(member.source).toBe("role-preferred");
    expect(issueCodes(plan)).toContain("MODE_POOL_UNAVAILABLE");
  });
});

describe("P1 contract integration: economy-all routes", () => {
  const economyAll = economyOf({
    pool: [],
    taskOrder: {},
    profileBudget: {},
    allSeats: allSeatsPolicy(),
  });

  test("all five routes select their own Profile and keep the route budget basis", () => {
    const plan = launch(tierTeam, economyAll);
    expect(plan.blockers).toEqual([]);
    expect(plan.coordinatorSelected?.route).toBe("coordinator");
    expect(plan.coordinator.profile.id).toBe(sonnet.id);
    expect(seat(plan, decisionRole.id).selected).toMatchObject({
      profile: { id: sonnet.id },
      route: "decision",
      budgetBasis: "route",
    });
    expect(seat(plan, executionRole.id).selected).toMatchObject({
      profile: { id: deepseek.id },
      route: "execution",
      budgetBasis: "route",
    });
    expect(seat(plan, retainRole.id).selected).toMatchObject({
      profile: { id: sonnet.id },
      route: "retain",
      budgetBasis: "route",
    });
    expect(seat(plan, escalationRole.id).selected.standby).toBe(true);
  });

  test("an empty escalation route keeps the standby seat visible and blocked", () => {
    const filteredRoutes = { ...allSeatsRoutes, escalation: [] };
    const economy = economyOf({
      pool: [],
      taskOrder: {},
      profileBudget: {},
      allSeats: allSeatsPolicy({ routes: filteredRoutes }),
    });
    const plan = launch(tierTeam, economy);
    const standby = seat(plan, escalationRole.id).selected;
    expect(standby.unavailable).toBe(true);
    expect(plan.blockers.length).toBeGreaterThan(0);
    expect(
      plan.seatIssues.some(
        (issue) =>
          issue.code === "MODE_CHEAP_ROUTE_UNAVAILABLE" &&
          issue.params.route === "escalation" &&
          issue.params.reason === "route-empty",
      ),
    ).toBe(true);
  });

  test("a high-cost live Profile is rejected even when the entry claims a cheap family", () => {
    const economy = economyOf({
      pool: [],
      taskOrder: {},
      profileBudget: {},
      allSeats: allSeatsPolicy({
        profiles: [
          entry(sonnet, "sonnet"),
          entry(claudeOpus, "sonnet"),
          entry(deepseek, "deepseek"),
        ],
        routes: { ...allSeatsRoutes, execution: [claudeOpus.id] },
      }),
    });
    const plan = launch(tierTeam, economy);
    expect(plan.blockers.length).toBeGreaterThan(0);
    expect(
      plan.seatIssues.some(
        (issue) =>
          issue.code === "MODE_CHEAP_PROFILE_INVALID" &&
          issue.params.profileId === claudeOpus.id &&
          issue.params.reason === "high-cost-family",
      ),
    ).toBe(true);
  });

  test("a tuple change invalidates the saved allowlist entry", () => {
    const changed = entry(sonnet, "sonnet", {
      boundModel: { provider: sonnet.provider, model: "claude-opus-5" },
    });
    const economy = economyOf({
      pool: [],
      taskOrder: {},
      profileBudget: {},
      allSeats: allSeatsPolicy({ profiles: [changed, entry(deepseek, "deepseek")] }),
    });
    const plan = launch(tierTeam, economy);
    expect(plan.blockers.length).toBeGreaterThan(0);
    expect(
      plan.seatIssues.some(
        (issue) =>
          issue.code === "MODE_CHEAP_PROFILE_INVALID" &&
          issue.params.profileId === sonnet.id &&
          issue.params.reason === "tuple-changed",
      ),
    ).toBe(true);
  });

  test("a non-economy budget label conflicts with the cheap route", () => {
    const economy = economyOf({
      pool: [],
      taskOrder: {},
      profileBudget: { [sonnet.id]: "sota" },
      allSeats: allSeatsPolicy({
        routes: { ...allSeatsRoutes, execution: [sonnet.id] },
      }),
    });
    const plan = launch(tierTeam, economy);
    expect(plan.blockers.length).toBeGreaterThan(0);
    expect(
      plan.seatIssues.some(
        (issue) =>
          issue.code === "MODE_CHEAP_PROFILE_INVALID" &&
          issue.params.profileId === sonnet.id &&
          issue.params.reason === "budget-conflict",
      ),
    ).toBe(true);
  });
});

describe("P1 contract integration: unknown mode and collaboration gating", () => {
  test("an unknown stored mode blocks planning and the preview keeps rawMode only", () => {
    const team = { ...codingTeam, mode: "turbo" };
    const modelPlan = buildTeamModelPlan({
      team,
      roles: allRoles,
      host: { status: "ready", profiles, availability: available },
      economy: emptyEconomy,
      maxMembers: 8,
      runtimeCapabilities: capabilities,
    });
    expect(modelPlan.effectiveMode).toBeNull();
    expect(modelPlan.rawMode).toBe("turbo");
    const plan = launch(team, emptyEconomy);
    expect(plan.blockers.length).toBeGreaterThan(0);
    expect(plan.rawMode).toBe("turbo");
    const preview = toModeLaunchPreview(plan, "hash", [], emptyEconomy);
    expect(preview.requestedMode).toBeUndefined();
    expect(preview.rawMode).toBe("turbo");
    expect(preview.issues.some((issue) => issue.code === "MODE_UNKNOWN")).toBe(true);
  });

  test("collaborative mode without the runtime capability is blocked", () => {
    const plan = launch({ ...codingTeam, mode: "collaborative" }, emptyEconomy, {
      runtimeCapabilities: { onDemand: true, expansion: true, collaboration: false },
    });
    expect(plan.blockers).toContain(zh.modes.collaborationRuntimeUnavailable);
  });
});

describe("P1 contract integration: seat shape", () => {
  test("duplicate instances block and a disabled member is not planned", () => {
    const team: Team = {
      ...codingTeam,
      members: [
        { roleId: developer.id, instanceLabel: "Backend", enabled: true },
        { roleId: developer.id, instanceLabel: "Backend", enabled: true },
        { roleId: architect.id, enabled: false },
      ],
    };
    const seatPlan = buildSeatPlan({
      team,
      roles: allRoles,
      host: { status: "ready", profiles, availability: available },
      economy: emptyEconomy,
      maxMembers: 8,
      runtimeCapabilities: capabilities,
    });
    expect(seatPlan.issues.map((issue) => issue.code)).toContain("MODE_SEAT_DUPLICATE");
    expect(seatPlan.seats.some((item) => item.roleId === architect.id)).toBe(false);
  });
});

describe("P1 contract integration: RPC services share one snapshot", () => {
  const economyAllPreferences: Preferences = {
    ...preferences,
    economy: {
      allSeats: allSeatsPolicy(),
    },
  };

  function reading<T>(values: T): SettingsReader<T> {
    return { read: async () => ({ status: "ready", values, revision: "rev-1" }) };
  }

  function readers() {
    return {
      roles: reading<RolesDocument>({ roles: allRoles }),
      teams: reading<TeamsDocument>({
        teams: [
          { ...codingTeam, mode: "economy" },
          tierTeam,
          { ...codingTeam, id: "unknown-team", mode: "turbo" },
        ],
      }),
      preferences: reading<Preferences>(economyAllPreferences),
    };
  }

  function planInput(teamId: string): TeamPlanInput {
    return { items: [{ key: `saved:${teamId}`, kind: "saved", teamId }] };
  }

  test("team.plan and launch.preview agree for standard and economy-all", async () => {
    const settings = readers();
    const fixture = fakePort({
      agentProfiles: profiles,
      mcp: { enabled: true, injectIntoAgents: true },
    });
    const port = fixture.port;
    const planService = createTeamPlanService({ readers: settings });
    const launchService = createLaunchService(settings);

    for (const teamId of ["coding-team", "tier-team"]) {
      const preview = await launchService.preview(
        {
          teamId,
          task: "Add Stripe",
          target: { kind: "workspace", workspaceId: "ws-1" },
          contractVersion: 2,
        },
        port,
      );
      expect(preview.ok, teamId).toBe(true);
      if (!preview.ok) continue;
      const output: TeamPlanOutput = TeamPlanOutputSchema.parse(
        await planService.plan(planInput(teamId), port),
      );
      const result = output.results[0];
      if (!result) throw new Error("missing plan result");
      expect(result.status, teamId).toBe("ready");
      const coordinator = result.rows.find((row) => row.kind === "coordinator");
      expect(coordinator?.profile?.id, teamId).toBe(preview.preview.coordinator.profile?.id);
      expect(coordinator?.source, teamId).toBe(preview.preview.coordinator.source);
      expect(coordinator?.budget, teamId).toBe(preview.preview.coordinator.budget);
      expect(coordinator?.budgetBasis, teamId).toBe(preview.preview.coordinator.budgetBasis);
      const memberRows = result.rows.filter((row) => row.kind === "member");
      const previewSeats = [...preview.preview.seats].sort((left, right) =>
        left.roleId.localeCompare(right.roleId),
      );
      expect(memberRows.length, teamId).toBe(previewSeats.length);
      for (const [index, row] of [...memberRows]
        .sort((left, right) => (left.roleId ?? "").localeCompare(right.roleId ?? ""))
        .entries()) {
        const seatPreview = previewSeats[index];
        expect(row.roleId, `${teamId}/${row.roleId}`).toBe(seatPreview?.roleId);
        expect(row.profile?.id, `${teamId}/${row.roleId}`).toBe(seatPreview?.profile?.id);
        expect(row.source, `${teamId}/${row.roleId}`).toBe(seatPreview?.source);
        expect(row.budget, `${teamId}/${row.roleId}`).toBe(seatPreview?.budget);
        expect(row.budgetBasis, `${teamId}/${row.roleId}`).toBe(seatPreview?.budgetBasis);
      }
    }
  });

  test("the mode access gate refuses a legacy caller before any host read", async () => {
    const settings = readers();
    const fixture = fakePort({ agentProfiles: profiles });
    const port = fixture.port;
    const service = createLaunchService(settings);

    for (const input of [
      { teamId: tierTeam.id, mode: undefined },
      { teamId: tierTeam.id, mode: "sota" as const },
      { teamId: "unknown-team", mode: undefined },
    ]) {
      const reply = await service.preview(
        {
          teamId: input.teamId,
          task: "Add Stripe",
          target: { kind: "workspace", workspaceId: "ws-1" },
          ...(input.mode === undefined ? {} : { mode: input.mode }),
        },
        port,
      );
      expect(reply.ok).toBe(false);
      if (!reply.ok) {
        expect(reply.issues[0]).toMatchObject({
          code: "MODE_UNKNOWN",
          params: { reason: "contract-required" },
        });
      }
      // The gate is after the settings read and before any host or target read.
      expect(port.config.get).not.toHaveBeenCalled();
      expect(port.providers.listAvailable).not.toHaveBeenCalled();
      expect(fixture.create).not.toHaveBeenCalled();
    }
    const unknown = await service.preview(
      {
        teamId: "unknown-team",
        task: "Add Stripe",
        target: { kind: "workspace", workspaceId: "ws-1" },
        contractVersion: 2,
      },
      port,
    );
    expect(unknown.ok).toBe(false);
    expect(fixture.create).not.toHaveBeenCalled();
  });
});

describe("P1 contract integration: legacy fingerprint", () => {
  // Hashes computed from the same input at baseline 75ec305 (probe kept out of the repo).
  const LEGACY_GOLDEN: Record<string, string> = {
    sota: "918b9ad79896acf8510aa61a25732f13e0f6986faccf9cc14b4a141d9fca6b60",
    economy: "bc35b3629ddc12eea2f91f001c216d0f0ea58b70c96896d98dc5ca2f7b44bc7e",
    collaborative: "ebf23a5a06c9f541a2912de577471faf10e0987101f8bcfa664c5076e77110b0",
  };

  function fingerprintOf(mode: "sota" | "economy" | "collaborative"): string {
    const team = { ...codingTeam, mode };
    const plan = launch(team, emptyEconomy);
    return launchPlanFingerprint({
      team,
      roles: allRoles,
      plan,
      host: { status: "ready", profiles, availability: available },
      economy: emptyEconomy,
      target: { kind: "workspace", workspaceId: "ws-1" },
      task: "Add Stripe",
      maxMembers: 8,
      runtimeCapabilities: capabilities,
    });
  }

  test("sota / economy / collaborative keep their 75ec305 fingerprints", () => {
    for (const mode of ["sota", "economy", "collaborative"] as const) {
      expect(createHash("sha256").update(fingerprintOf(mode)).digest("hex"), mode).toBe(
        LEGACY_GOLDEN[mode],
      );
    }
  });
});

describe("AC-0b.7 / B03: the saved-Team first paint batches its RPCs", () => {
  test("ten Teams arrive in one team.plan request and the cache is used for the next paint", async () => {
    const calls: TeamPlanInput[] = [];
    const client = createTeamPlanClient({
      send: async (input) => {
        calls.push(input);
        return TeamPlanOutputSchema.parse({
          schemaVersion: 1,
          capabilities: {
            modeContract: 2,
            designRolePolicy: 1,
            supportedModes: ["sota", "economy", "collaborative", "economy-all"],
            runtimeCapabilities: capabilities,
          },
          checkedAt: "2026-10-01T10:00:00.000Z",
          context: null,
          results: input.items.map((item) => ({
            key: item.key,
            status: "unavailable",
            effectiveMode: null,
            selectionFingerprint: null,
            rows: [],
            issues: [],
          })),
        });
      },
    });
    client.setScope({
      hostId: "host",
      profiles,
      revisions: { roles: "r1", teams: "t1", preferences: "p1" },
    });
    const teams = Array.from(
      { length: 10 },
      (_, index): Team => ({
        ...codingTeam,
        id: `t-${index}`,
        name: `Team ${index}`,
      }),
    );
    client.planTeams(teams);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.items).toHaveLength(10);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(1);
    client.planTeams(teams);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(1);
    client.destroy();
  });
});

describe("AC-0c.8 / C04: a gap job offers its exits and a prefilled retry", () => {
  test("the card shows both gap exits and the retry form starts from the original request", () => {
    const gap = {
      responsibility: "数据库迁移评审",
      reason: "现有 Role 不承担迁移评审",
      use: "member" as const,
      profiles: [
        {
          id: "p-sonnet",
          name: "Sonnet",
          provider: "claude",
          model: "claude-sonnet-4-6",
        },
      ],
      suggestedRole: {
        id: "qa-migration",
        name: "【质量】迁移评审",
        responsibilities: ["评审迁移脚本"],
        executionPolicy: { tier: "decision" as const, taskKind: "general" as const },
      },
    };
    const job: DesignJob = designJob({
      state: "failed",
      mode: "sota",
      existingRolesOnly: true,
      outputContractVersion: 2,
      roleGap: [gap],
      resultId: null,
      carrierWorkspaceId: "ws-carrier",
      targetWorkspaceId: "ws-target",
      allowed: { cancel: false, save: false, launch: false, continueAction: null },
    });
    expect(buildDesignRoleGapViews(job)).toHaveLength(1);
    expect(buildDesignRoleGapViews(job)[0]?.suggestedRole?.id).toBe("qa-migration");

    const cache = createDesignRetryCache();
    cache.remember(job.jobId, {
      clientRequestId: job.clientRequestId,
      request: "原始需求全文",
      mode: job.mode,
      profileId: "p-sonnet",
    });
    const plan = planDesignGapRetry(job, cache.get(job.jobId), () => "retry-nonce");
    if (!plan.ok) throw new Error("retry prefill missing");
    expect(plan.prefill).toMatchObject({
      text: "原始需求全文",
      workspaceId: "ws-target",
      mode: "sota",
      profileChoice: "p-sonnet",
      existingRolesOnly: false,
      confirmReplace: true,
    });
    expect(planDesignGapRetry(job, null)).toEqual({
      ok: false,
      reason: "request-unavailable",
    });
  });
});

describe("AC-0d.16 / C02: economy-all gap suggestions are route-backed", () => {
  test("a suggested Profile outside the execution route is rejected before the retry", () => {
    const economy = economyOf({
      pool: [],
      taskOrder: {},
      profileBudget: {},
      allSeats: allSeatsPolicy(),
    });
    const routing = describeModeRouting({ profiles, availability: available, economy });
    const gap = (profileId: string) =>
      DesignRoleGapSchema.parse({
        kind: "missing-role",
        responsibility: "负责数据库迁移",
        reason: "目录没有承担迁移的 Role",
        use: "member",
        profiles: { kind: "existing", profileIds: [profileId] },
        suggestedRole: {
          id: "eng-data",
          name: "【工程】数据迁移",
          responsibilities: ["迁移"],
          executionPolicy: { tier: "execution", taskKind: "coding" },
        },
      });
    expect(
      checkGapEconomyEligibility({ mode: "economy-all", gap: gap(deepseek.id), routing }),
    ).toEqual([]);
    const rejected = checkGapEconomyEligibility({
      mode: "economy-all",
      gap: gap(sonnet.id),
      routing,
    });
    expect(rejected[0]?.params).toMatchObject({
      modeCode: "MODE_CHEAP_PROFILE_INVALID",
      route: "execution",
      profileId: sonnet.id,
    });
  });
});

test.todo("AC-0d.17 / I01: one label/description source for all surfaces — I01 not integrated");
test.todo("AC-0d.14 / D03: CLI mode negotiation and help — D03 not integrated");

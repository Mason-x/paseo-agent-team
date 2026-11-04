// Real planning and RPC services over fake settings and Paseo ports: no daemon is contacted.
import { describe, expect, test, vi } from "vitest";
import {
  buildDesignRoleGapViews,
  createDesignRetryCache,
  planDesignGapRetry,
} from "../client/designer/submission-state";
import { createTeamPlanClient } from "../client/teams/team-plan-state";
import { createLaunchService } from "../server/launch-service";
import type { SettingsReader } from "../server/planning-context";
import { createTeamPlanService } from "../server/team-plan-service";
import { buildLaunchPlan } from "../shared/domain/launch-plan";
import { buildSeatPlan } from "../shared/domain/seat-plan";
import type { PaseoProfile } from "../shared/paseo/adapter";
import { type DesignJob, DesignRoleGapSchema, RoleGapReportSchema } from "../shared/schemas/design";
import type { Preferences } from "../shared/schemas/preferences";
import type { Team } from "../shared/schemas/team";
import type { TeamPlanInput } from "../shared/schemas/team-plan";
import { TeamPlanOutputSchema } from "../shared/schemas/team-plan";
import type { RolesDocument, TeamsDocument } from "../shared/settings";
import { designJob } from "./design-fixtures";
import { fakePort, preferences } from "./fakes";
import { architect, claudeOpus, codexXhigh, codingTeam, developer, techLead } from "./fixtures";

const profiles: PaseoProfile[] = [claudeOpus, codexXhigh];
const availability = [
  { provider: "claude", available: true },
  { provider: "codex", available: true },
];
const roles = [techLead, architect, developer];
const capabilities = { onDemand: true, expansion: true, collaboration: true };
const legacyPreferences: Preferences = {
  ...preferences,
  economy: { allSeats: { version: 1, routes: { coordinator: [], execution: [] } } },
};

function reading<T>(values: T): SettingsReader<T> {
  return { read: async () => ({ status: "ready", values, revision: "rev-1" }) };
}

function readers() {
  return {
    roles: reading<RolesDocument>({ roles }),
    teams: reading<TeamsDocument>({
      teams: [
        { ...codingTeam, mode: "economy" },
        { ...codingTeam, id: "all-team", mode: "economy-all" },
        { ...codingTeam, id: "unknown-team", mode: "turbo" },
      ],
    }),
    preferences: reading<Preferences>(legacyPreferences),
  };
}

function launch(team: Team) {
  return buildLaunchPlan({
    team,
    roles,
    profiles,
    availability,
    workspaceId: "ws-1",
    task: "Add Stripe",
    runId: "run-v01b",
    maxMembers: 8,
    host: { status: "ready", profiles, availability },
    runtimeCapabilities: capabilities,
    daemonConfig: { mcp: { enabled: true, injectIntoAgents: true } },
  });
}

describe("single-path planning integration", () => {
  test("the flagship bindings are used even with old stored modes and collaboration", () => {
    for (const mode of ["sota", "economy", "economy-all", "collaborative", "turbo"]) {
      const plan = launch({
        ...codingTeam,
        mode,
        collaboration: { replicas: 3, judgeRoleId: "architect" },
      });
      expect(plan.blockers, mode).toEqual([]);
      expect(plan.coordinator.profile.id, mode).toBe(claudeOpus.id);
      expect(
        plan.seats.map((seat) => [seat.roleId, seat.selected.profile.id]),
        mode,
      ).toEqual([
        [architect.id, claudeOpus.id],
        [developer.id, codexXhigh.id],
      ]);
      expect(
        plan.seats.every((seat) => seat.purpose === "member"),
        mode,
      ).toBe(true);
    }
  });

  test("duplicate instances block and a disabled member is not planned", () => {
    const team: Team = {
      ...codingTeam,
      members: [
        { roleId: developer.id, instanceLabel: "Backend", enabled: true },
        { roleId: developer.id, instanceLabel: "Backend", enabled: true },
        { roleId: architect.id, enabled: false },
      ],
    };
    const plan = buildSeatPlan({
      team,
      roles,
      host: { status: "ready", profiles, availability },
      maxMembers: 8,
      runtimeCapabilities: capabilities,
    });
    expect(plan.issues.map((issue) => issue.code)).toContain("MODE_SEAT_DUPLICATE");
    expect(plan.seats.some((seat) => seat.roleId === architect.id)).toBe(false);
  });

  test("team.plan and launch.preview agree on every binding for historical Teams", async () => {
    const settings = readers();
    const fixture = fakePort({
      agentProfiles: profiles,
      mcp: { enabled: true, injectIntoAgents: true },
    });
    const teamPlans = createTeamPlanService({ readers: settings });
    const launches = createLaunchService(settings);
    for (const teamId of ["coding-team", "all-team", "unknown-team"]) {
      const preview = await launches.preview(
        { teamId, task: "Add Stripe", target: { kind: "workspace", workspaceId: "ws-1" } },
        fixture.port,
      );
      expect(preview.ok, teamId).toBe(true);
      if (!preview.ok) throw new Error(`preview blocked: ${preview.blockers.join(", ")}`);
      const output = TeamPlanOutputSchema.parse(
        await teamPlans.plan({ items: [{ key: teamId, kind: "saved", teamId }] }, fixture.port),
      );
      const result = output.results[0];
      if (!result) throw new Error("missing plan result");
      expect(result.status, teamId).toBe("ready");
      expect(result.effectiveMode, teamId).toBe("sota");
      const coordinator = result.rows.find((row) => row.kind === "coordinator");
      expect(coordinator?.profile?.id, teamId).toBe(preview.preview.coordinator.profile?.id);
      expect(coordinator?.source, teamId).toBe(preview.preview.coordinator.source);
      expect(coordinator?.budget, teamId).toBe(preview.preview.coordinator.budget);
      expect(coordinator?.budgetBasis, teamId).toBe(preview.preview.coordinator.budgetBasis);
      const members = result.rows.filter((row) => row.kind === "member");
      expect(members, teamId).toHaveLength(preview.preview.seats.length);
      for (const seat of preview.preview.seats) {
        const row = members.find((entry) => entry.seatId === seat.seatId);
        expect(row, `${teamId}/${seat.roleId}`).toMatchObject({
          roleId: seat.roleId,
          profile: seat.profile,
          source: seat.source,
          budget: seat.budget,
          budgetBasis: seat.budgetBasis,
        });
      }
    }
  });

  test("retired request overrides are blocked before host or target reads", async () => {
    const fixture = fakePort({ agentProfiles: profiles });
    const service = createLaunchService(readers());
    for (const mode of ["economy", "economy-all", "collaborative"] as const) {
      for (const contractVersion of [undefined, 2, 3]) {
        const reply = await service.preview(
          {
            teamId: codingTeam.id,
            task: "Add Stripe",
            target: { kind: "workspace", workspaceId: "ws-1" },
            mode,
            ...(contractVersion === undefined ? {} : { contractVersion }),
          },
          fixture.port,
        );
        expect(reply.ok, `${mode}/${contractVersion}`).toBe(false);
        if (reply.ok) throw new Error("retired request unexpectedly succeeded");
        expect(reply.issues[0]).toMatchObject({
          code: "MODE_UNKNOWN",
          params: { reason: "retired" },
        });
      }
    }
    expect(fixture.port.config.get).not.toHaveBeenCalled();
    expect(fixture.port.providers.listAvailable).not.toHaveBeenCalled();
    expect(fixture.port.workspaces.list).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
  });
});

describe("saved-Team first paint", () => {
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
            supportedModes: ["sota"],
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
      (_, index): Team => ({ ...codingTeam, id: `t-${index}`, name: `Team ${index}` }),
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

describe("a gap job offers its exits and a prefilled retry", () => {
  test("the card shows both gap exits and the retry form starts from the original request", () => {
    const profile = {
      id: "p-sonnet",
      name: "Sonnet",
      provider: "claude",
      model: "claude-sonnet-4-6",
    };
    const proposal = DesignRoleGapSchema.parse({
      kind: "missing-role",
      responsibility: "数据库迁移评审",
      reason: "现有 Role 不承担迁移评审",
      use: "member",
      profiles: { kind: "existing", profileIds: [profile.id] },
      suggestedRole: {
        id: "qa-migration",
        name: "【质量】迁移评审",
        responsibilities: ["评审迁移脚本"],
        executionPolicy: { tier: "decision", taskKind: "general" },
      },
    });
    if (proposal.kind !== "missing-role") throw new Error("fixture must be a missing-role gap");
    const suggested = RoleGapReportSchema.parse({
      responsibility: proposal.responsibility,
      reason: proposal.reason,
      use: proposal.use,
      profiles: [profile],
      suggestedRole: proposal.suggestedRole,
    });
    const unlaunchable = RoleGapReportSchema.parse({
      responsibility: "数据库迁移执行",
      reason: "绑定的 Profile 在本 host 不可用",
      use: "member",
      profiles: [profile],
      unlaunchableRole: {
        roleId: "qa-migration",
        roleName: "【质量】迁移评审",
        unavailableProfileIds: [profile.id],
        profileNames: [profile.name],
      },
    });
    const job: DesignJob = designJob({
      state: "failed",
      mode: "sota",
      existingRolesOnly: true,
      outputContractVersion: 2,
      roleGap: [suggested, unlaunchable],
      resultId: null,
      carrierWorkspaceId: "ws-carrier",
      targetWorkspaceId: "ws-target",
      allowed: { cancel: false, save: false, launch: false, continueAction: null },
    });
    const views = buildDesignRoleGapViews(job);
    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({
      suggestedRole: { id: "qa-migration" },
      primary: { kind: "create-role" },
    });
    expect(views[1]).toMatchObject({
      primary: { kind: "open-role", roleId: "qa-migration", profileId: profile.id },
    });

    const cache = createDesignRetryCache();
    cache.remember(job.jobId, {
      clientRequestId: job.clientRequestId,
      request: "原始需求全文",
      mode: job.mode,
      profileId: "p-sonnet",
    });
    const plan = planDesignGapRetry(job, cache.get(job.jobId), () => "retry-nonce");
    if (!plan.ok) throw new Error("retry prefill missing");
    expect(plan.prefill).toEqual({
      nonce: "retry-nonce",
      text: "原始需求全文",
      workspaceId: "ws-target",
      profileChoice: "p-sonnet",
      existingRolesOnly: false,
      confirmReplace: true,
    });
    expect(planDesignGapRetry(job, null)).toEqual({ ok: false, reason: "request-unavailable" });
  });
});

test.todo("AC-0d.17 / I01: one label/description source for all surfaces — I01 not integrated");
test.todo("AC-0d.14 / D03: CLI mode negotiation and help — D03 not integrated");

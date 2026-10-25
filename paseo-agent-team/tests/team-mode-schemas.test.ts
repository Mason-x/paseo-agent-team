import { describe, expect, test } from "vitest";
import { PreferencesSchema } from "../shared/schemas/preferences";
import { RoleSchema } from "../shared/schemas/role";
import { TeamSchema } from "../shared/schemas/team";
import { RoleTierSchema, TaskKindSchema, TeamModeSchema } from "../shared/schemas/team-mode";
import { architect, codingTeam, NOW } from "./fixtures";

const baseTeam = {
  id: "large-team",
  name: "Large Team",
  coordinatorRoleId: "lead-tech",
  createdAt: NOW,
  updatedAt: NOW,
};

function manyMembers(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    roleId: "developer",
    instanceLabel: `Seat ${index + 1}`,
    seatId: `seat-${index + 1}`,
    enabled: true,
  }));
}

describe("team mode storage schemas", () => {
  test("command enums stay strict while stored documents are tolerant", () => {
    expect(TeamModeSchema.options).toEqual(["sota", "economy", "collaborative"]);
    expect(RoleTierSchema.options).toEqual(["decision", "execution", "escalation", "retain"]);
    expect(TaskKindSchema.options).toEqual([
      "coding",
      "testing",
      "acceptance",
      "codebase",
      "ops",
      "general",
    ]);
    expect(TeamModeSchema.safeParse("quantum").success).toBe(false);
    expect(RoleTierSchema.safeParse("economy").success).toBe(false);
    expect(TaskKindSchema.safeParse("delivery").success).toBe(false);
  });

  test("legacy Role, Team, and Preferences documents stay readable", () => {
    expect(RoleSchema.parse(architect)).toEqual(architect);
    expect(RoleSchema.parse(architect)).not.toHaveProperty("executionPolicy");
    expect(TeamSchema.parse(codingTeam)).toEqual(codingTeam);
    expect(TeamSchema.parse(codingTeam)).not.toHaveProperty("mode");
    const preferences = PreferencesSchema.parse({ maxMembers: 8 });
    expect(preferences.maxMembers).toBe(8);
    expect(preferences.economy).toBeUndefined();
    expect(preferences.quotaRecovery).toBeUndefined();
  });

  test("unknown mode, member creation, tier, task kind, and family values never invalidate a document", () => {
    const team = TeamSchema.parse({
      ...baseTeam,
      mode: "quantum",
      memberCreation: "sometimes",
      collaboration: { replicas: 4, judgeRoleId: "qa-test", futureJudge: "keep" },
      members: manyMembers(1),
    });
    expect(team.mode).toBe("quantum");
    expect(team.memberCreation).toBe("sometimes");
    expect(team.collaboration).toEqual({
      replicas: 4,
      judgeRoleId: "qa-test",
      futureJudge: "keep",
    });

    const role = RoleSchema.parse({
      ...architect,
      executionPolicy: { tier: "economy-plus", taskKind: "delivery", future: true },
    });
    expect(role.executionPolicy).toEqual({
      tier: "economy-plus",
      taskKind: "delivery",
      future: true,
    });

    const preferences = PreferencesSchema.parse({
      economy: {
        pool: [{ profileId: "profile-1", family: "unverified-family", future: 1 }],
        taskOrder: { delivery: ["profile-1"] },
        profileBudget: { "profile-2": "sponsor" },
        futurePolicy: true,
      },
    });
    expect(preferences.economy).toEqual({
      pool: [{ profileId: "profile-1", family: "unverified-family", future: 1 }],
      taskOrder: { delivery: ["profile-1"] },
      profileBudget: { "profile-2": "sponsor" },
      futurePolicy: true,
    });
  });

  test("unknown top-level fields survive a round-trip in every document", () => {
    expect(RoleSchema.parse({ ...architect, futureRoleField: { kept: true } })).toMatchObject({
      futureRoleField: { kept: true },
    });
    expect(
      TeamSchema.parse({
        ...baseTeam,
        members: [{ roleId: "developer", enabled: true, seatId: "seat-1", futureMember: 1 }],
        futureTeamField: ["kept"],
      }),
    ).toMatchObject({
      futureTeamField: ["kept"],
      members: [{ roleId: "developer", enabled: true, seatId: "seat-1", futureMember: 1 }],
    });
    expect(PreferencesSchema.parse({ futurePreference: "kept" })).toMatchObject({
      futurePreference: "kept",
    });
  });

  test("a Team may store more than 16 and more than 64 members without truncation", () => {
    const seventeen = TeamSchema.parse({ ...baseTeam, members: manyMembers(17) });
    expect(seventeen.members).toHaveLength(17);
    expect(seventeen.members.at(-1)?.seatId).toBe("seat-17");

    const sixtyFive = TeamSchema.parse({ ...baseTeam, members: manyMembers(65) });
    expect(sixtyFive.members).toHaveLength(65);
    expect(sixtyFive.members.at(-1)).toMatchObject({
      roleId: "developer",
      seatId: "seat-65",
      instanceLabel: "Seat 65",
    });
    // The storage schema keeps its structural rules even beyond the old cap.
    expect(
      TeamSchema.safeParse({
        ...baseTeam,
        members: [{ roleId: "developer" }, { roleId: "developer" }],
      }).success,
    ).toBe(false);
    expect(TeamSchema.safeParse({ ...baseTeam, members: [] }).success).toBe(false);
  });

  test("writing economy keeps every other preference and preset field", () => {
    const parsed = PreferencesSchema.parse({
      maxMembers: 12,
      archiveOnLaunchFailure: false,
      recentRuns: [
        {
          runId: "run-1",
          teamId: "coding-team",
          teamName: "Coding Team",
          workspaceId: "workspace-1",
          coordinatorAgentId: "agent-1",
          memberAgentIds: ["agent-2"],
          taskExcerpt: "Do the work",
          createdAt: NOW,
        },
      ],
      templatesImportedAt: NOW,
      designerProfile: { profileId: "designer", future: true },
      defaultPresets: { catalogRevision: "rev", seenRoleIds: ["lead-tech"] },
      economy: {
        pool: [{ profileId: "economy-1", family: "deepseek", enabled: true }],
      },
      quotaRecovery: { mode: "notify", futureMode: "manual" },
    });
    expect(parsed).toMatchObject({
      maxMembers: 12,
      archiveOnLaunchFailure: false,
      templatesImportedAt: NOW,
      designerProfile: { profileId: "designer", future: true },
      defaultPresets: { catalogRevision: "rev", seenRoleIds: ["lead-tech"] },
      economy: { pool: [{ profileId: "economy-1", family: "deepseek", enabled: true }] },
      quotaRecovery: { mode: "notify", futureMode: "manual" },
    });
    expect(parsed.recentRuns).toHaveLength(1);
  });

  test("invalid nested values are preserved for the normalizer instead of being dropped", () => {
    const economy = {
      pool: [{ profileId: 5 }, "bad", { profileId: "profile-1", family: 7, enabled: "yes" }],
      taskOrder: { coding: "not-an-array" },
      profileBudget: { "profile-2": 9 },
      futurePolicy: true,
    };
    const preferences = PreferencesSchema.parse({
      maxMembers: 12,
      economy,
      quotaRecovery: { mode: 5 },
    });
    expect(preferences.maxMembers).toBe(12);
    // The exact user data survives a read so the next preferences write cannot delete it.
    expect(preferences.economy).toEqual(economy);
    expect(preferences.quotaRecovery).toEqual({ mode: 5 });

    const role = RoleSchema.parse({
      ...architect,
      executionPolicy: { tier: 5, future: true },
    });
    expect(role.executionPolicy).toEqual({ tier: 5, future: true });

    const team = TeamSchema.parse({
      ...baseTeam,
      members: manyMembers(1),
      collaboration: { replicas: "many", judgeRoleId: 7, future: 1 },
    });
    expect(team.collaboration).toEqual({ replicas: "many", judgeRoleId: 7, future: 1 });
  });

  test("the default seat cap is 24 with no storage upper bound", () => {
    expect(PreferencesSchema.parse({}).maxMembers).toBe(24);
    expect(PreferencesSchema.parse({ maxMembers: 1 }).maxMembers).toBe(1);
    expect(PreferencesSchema.parse({ maxMembers: 64 }).maxMembers).toBe(64);
    expect(PreferencesSchema.parse({ maxMembers: 200 }).maxMembers).toBe(200);
    expect(PreferencesSchema.safeParse({ maxMembers: 0 }).success).toBe(false);
    expect(PreferencesSchema.safeParse({ maxMembers: 2.5 }).success).toBe(false);
  });
});

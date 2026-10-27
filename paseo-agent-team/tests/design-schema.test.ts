import { describe, expect, test } from "vitest";
import { z } from "zod";
import { utf8ByteLength } from "../shared/domain/design-output";
import {
  DESIGN_ISSUE_CODES,
  DesignJobSchema,
  DesignOutputV2Schema,
  DesignProfileChoiceSchema,
  DesignProposalSchema,
  DesignRequestSchema,
  DesignResultSchema,
  DesignRoleGapProposalSchema,
  DesignRoleGapSchema,
  DesignStartInputSchema,
  DesignStateSchema,
  DesignTeamDraftSchema,
  DesignTeamProposalV2Schema,
  RoleGapReportSchema,
} from "../shared/schemas/design";
import { StoredDesignerOriginSchema } from "../shared/schemas/design-origin";
import { PreferencesSchema } from "../shared/schemas/preferences";
import { RoleSchema } from "../shared/schemas/role";
import { TeamSchema } from "../shared/schemas/team";
import {
  DESIGN_JOB_ID,
  designJob,
  designProposal,
  designResult,
  newDesignRole,
} from "./design-fixtures";
import { architect, codingTeam, NOW } from "./fixtures";

describe("stored designer origin", () => {
  test("is tolerant and preserves future metadata", () => {
    expect(StoredDesignerOriginSchema.parse({})).toEqual({});
    expect(
      StoredDesignerOriginSchema.parse({
        jobId: DESIGN_JOB_ID,
        createdAt: NOW,
        requestExcerpt: "改版",
        futureField: "kept",
      }),
    ).toEqual({
      jobId: DESIGN_JOB_ID,
      createdAt: NOW,
      requestExcerpt: "改版",
      futureField: "kept",
    });
  });

  test("Role and Team round-trip source and designer metadata, including future fields", () => {
    const role = RoleSchema.parse({
      ...architect,
      source: "team-designer",
      designer: { jobId: DESIGN_JOB_ID, createdAt: NOW, future: "kept" },
    });
    expect(role.source).toBe("team-designer");
    expect(role.designer).toEqual({
      jobId: DESIGN_JOB_ID,
      createdAt: NOW,
      future: "kept",
    });

    const team = TeamSchema.parse({
      ...codingTeam,
      source: "team-designer",
      designer: { jobId: DESIGN_JOB_ID, requestExcerpt: "改版" },
    });
    expect(team.source).toBe("team-designer");
    expect(team.designer).toEqual({ jobId: DESIGN_JOB_ID, requestExcerpt: "改版" });
  });

  test("a damaged designer block drops only the origin, never the Role, Team, or Preferences document", () => {
    expect(RoleSchema.parse({ ...architect, designer: { jobId: 42 } }).designer).toBe(undefined);
    expect(RoleSchema.parse({ ...architect, designer: "broken" }).id).toBe(architect.id);
    expect(TeamSchema.parse({ ...codingTeam, designer: null }).id).toBe(codingTeam.id);
    expect(TeamSchema.parse({ ...codingTeam, designer: { createdAt: 1 } }).designer).toBe(
      undefined,
    );

    const preferences = PreferencesSchema.parse({
      maxMembers: 8,
      designerProfile: { profileId: "claude-opus-high", nameSnapshot: "Opus", future: "kept" },
      futurePreference: "kept",
    });
    expect(preferences.designerProfile).toEqual({
      profileId: "claude-opus-high",
      nameSnapshot: "Opus",
      future: "kept",
    });
    expect(preferences.futurePreference).toBe("kept");
    expect(
      PreferencesSchema.parse({ designerProfile: { profileId: 42 } }).designerProfile,
    ).toBeUndefined();
    expect(PreferencesSchema.parse({ designerProfile: "broken" }).maxMembers).toBe(24);
  });

  test("documents written before the designer fields remain readable", () => {
    expect(RoleSchema.parse(architect).designer).toBeUndefined();
    expect(TeamSchema.parse(codingTeam).designer).toBeUndefined();
    const legacy = PreferencesSchema.parse({ maxMembers: 8, recentRuns: [] });
    expect(legacy.maxMembers).toBe(8);
    expect(legacy.designerProfile).toBeUndefined();
  });
});

describe("design request limits", () => {
  test("trims before counting, including full-width whitespace", () => {
    expect(DesignRequestSchema.parse("  给后台做改版\n")).toBe("给后台做改版");
    expect(DesignRequestSchema.parse("　\n需求\t　")).toBe("需求");
    expect(DesignRequestSchema.safeParse("   ").success).toBe(false);
    expect(DesignRequestSchema.safeParse("　　").success).toBe(false);
  });

  test("accepts 4000 code points and rejects 4001", () => {
    expect(DesignRequestSchema.safeParse("字".repeat(4000)).success).toBe(true);
    expect(DesignRequestSchema.safeParse("字".repeat(4001)).success).toBe(false);
  });

  test("counts code points, not UTF-16 units or UTF-8 bytes", () => {
    const emoji = "😀".repeat(4000);
    expect(emoji.length).toBe(8000);
    expect(utf8ByteLength(emoji)).toBe(16000);
    expect(DesignRequestSchema.parse(emoji)).toBe(emoji);
    expect(DesignRequestSchema.safeParse(`${emoji}😀`).success).toBe(false);
  });
});

describe("strict model output", () => {
  test("accepts a complete proposal", () => {
    const proposal = designProposal();
    expect(DesignProposalSchema.parse(proposal)).toEqual(proposal);
  });

  test("rejects unknown fields at every model-output level", () => {
    const proposal = designProposal();
    const role = newDesignRole();
    const invalid = [
      { ...proposal, extra: true },
      { ...proposal, team: { ...proposal.team, extra: true } },
      {
        ...proposal,
        team: {
          ...proposal.team,
          members: [{ ...proposal.team.members[0], extra: true }],
        },
      },
      {
        ...proposal,
        team: { ...proposal.team, collaboration: { replicas: 2, extra: true } },
      },
      { ...proposal, reuse: [{ ...proposal.reuse[0], extra: true }] },
      {
        ...proposal,
        profileChoices: [{ ...proposal.profileChoices[0], extra: true }],
      },
      { ...proposal, newRoles: [{ ...role, extra: true }] },
      {
        ...proposal,
        newRoles: [{ ...role, preferredProfiles: [{ profileId: "p1", extra: true }] }],
      },
      {
        ...proposal,
        newRoles: [{ ...role, executionPolicy: { ...role.executionPolicy, extra: true } }],
      },
    ];

    for (const value of invalid) {
      expect(DesignProposalSchema.safeParse(value).success).toBe(false);
    }
  });

  test("enforces the new-Role limit, required preferred Profile, and non-empty reasons", () => {
    const proposal = designProposal();
    const roles = ["a", "b", "c", "d"].map((suffix) =>
      newDesignRole({ id: `role-${suffix}`, name: `Role ${suffix.toUpperCase()}` }),
    );
    expect(
      DesignProposalSchema.safeParse({ ...proposal, newRoles: roles.slice(0, 3) }).success,
    ).toBe(true);
    expect(DesignProposalSchema.safeParse({ ...proposal, newRoles: roles }).success).toBe(false);
    expect(
      DesignProposalSchema.safeParse({
        ...proposal,
        newRoles: [{ ...roles[0], preferredProfiles: [] }],
      }).success,
    ).toBe(false);
    expect(
      DesignProposalSchema.safeParse({
        ...proposal,
        newRoles: [{ ...roles[0], noveltyReason: "   " }],
      }).success,
    ).toBe(false);
    expect(
      DesignProposalSchema.safeParse({
        ...proposal,
        profileChoices: [
          { target: "coordinator", profileIds: ["p1"], reason: "   " },
          proposal.profileChoices[1],
        ],
      }).success,
    ).toBe(false);
    expect(
      DesignProfileChoiceSchema.safeParse({
        target: "m1",
        profileIds: ["p1"],
        reason: "负责实现。",
      }).success,
    ).toBe(true);
  });

  test("member keys keep their wire format; m1..m64 remains a semantic check", () => {
    const draft = (key: string) => ({
      ...designProposal().team,
      members: [{ key, roleId: "architect" }],
    });
    expect(DesignTeamDraftSchema.safeParse(draft("m1")).success).toBe(true);
    expect(DesignTeamDraftSchema.safeParse(draft("m64")).success).toBe(true);
    expect(DesignTeamDraftSchema.safeParse(draft("m65")).success).toBe(true);
    expect(DesignTeamDraftSchema.safeParse(draft("m0")).success).toBe(false);
    expect(DesignTeamDraftSchema.safeParse(draft("m01")).success).toBe(false);
    expect(DesignTeamDraftSchema.safeParse(draft("m100")).success).toBe(false);
    expect(
      DesignProfileChoiceSchema.safeParse({ target: "m0", profileIds: [], reason: "x" }).success,
    ).toBe(false);
  });
});

describe("RPC input and DTO shapes", () => {
  test("start is strict, defaults to sota, and rejects conflicting Profile switches", () => {
    const base = { clientRequestId: DESIGN_JOB_ID, request: "给后台做改版" };
    expect(DesignStartInputSchema.parse(base).mode).toBe("sota");
    expect(DesignStartInputSchema.safeParse({ ...base, extra: true }).success).toBe(false);
    expect(
      DesignStartInputSchema.safeParse({
        ...base,
        profileId: "p1",
        useDefaultProfileHints: true,
      }).success,
    ).toBe(false);
    expect(
      DesignStartInputSchema.safeParse({ ...base, profileId: "p1", useDefaultProfileHints: false })
        .success,
    ).toBe(true);
  });

  test("Job, Result, and issue-bearing DTOs accept the fixed contract", () => {
    expect(DesignJobSchema.parse(designJob())).toMatchObject({
      jobId: DESIGN_JOB_ID,
      state: "starting",
      attempt: 0,
    });
    expect(DesignResultSchema.parse(designResult())).toMatchObject({
      jobId: DESIGN_JOB_ID,
      resultId: "a".repeat(64),
      mode: "sota",
    });
  });
});

describe("output contract v2", () => {
  const teamV2 = {
    ...designProposal(),
    version: 2 as const,
    kind: "team" as const,
  };
  const gap = {
    kind: "missing-role" as const,
    responsibility: "专门负责数据库迁移评审",
    reason: "现有 Role 不承担数据库迁移评审。",
    use: "member" as const,
    profiles: { kind: "existing" as const, profileIds: ["codex-xhigh"] },
    suggestedRole: {
      id: "eng-migration-reviewer",
      name: "【工程】迁移评审",
      responsibilities: ["评审迁移脚本"],
      executionPolicy: { tier: "execution" as const, taskKind: "codebase" as const },
    },
  };
  const gapProposal = {
    version: 2 as const,
    kind: "role-gap" as const,
    jobId: DESIGN_JOB_ID,
    attempt: 1,
    nonce: "b".repeat(32),
    summary: "现有 Role 覆盖不了迁移评审。",
    gaps: [gap],
  };

  test("team v2 reuses the draft shape and only adds version and kind", () => {
    expect(DesignTeamProposalV2Schema.safeParse(teamV2).success).toBe(true);
    expect(DesignTeamProposalV2Schema.safeParse({ ...teamV2, kind: "role-gap" }).success).toBe(
      false,
    );
    expect(DesignTeamProposalV2Schema.safeParse({ ...teamV2, kind: undefined }).success).toBe(
      false,
    );
    // The v1 decoder never accepts a v2 body: the two contracts are selected, not guessed.
    expect(DesignProposalSchema.safeParse(teamV2).success).toBe(false);
  });

  test("role-gap is strict, bounded, and cannot smuggle a Team", () => {
    expect(DesignRoleGapProposalSchema.safeParse(gapProposal).success).toBe(true);
    expect(DesignOutputV2Schema.parse(gapProposal)).toMatchObject({ kind: "role-gap" });
    expect(
      DesignRoleGapProposalSchema.safeParse({
        ...gapProposal,
        team: designProposal().team,
      }).success,
    ).toBe(false);
    expect(
      DesignRoleGapProposalSchema.safeParse({
        ...gapProposal,
        newRoles: [newDesignRole()],
      }).success,
    ).toBe(false);
    expect(
      DesignRoleGapProposalSchema.safeParse({ ...gapProposal, profileChoices: [] }).success,
    ).toBe(false);
    expect(DesignRoleGapProposalSchema.safeParse({ ...gapProposal, gaps: [] }).success).toBe(false);
    expect(
      DesignRoleGapProposalSchema.safeParse({
        ...gapProposal,
        gaps: Array.from({ length: 9 }, () => gap),
      }).success,
    ).toBe(false);
  });

  test("gap fields enforce the documented bounds and Profile uniqueness", () => {
    const parse = (patch: Record<string, unknown>) =>
      DesignRoleGapSchema.safeParse({ ...gap, ...patch }).success;
    expect(parse({ responsibility: "x".repeat(601) })).toBe(false);
    expect(parse({ reason: "" })).toBe(false);
    expect(
      parse({
        suggestedRole: { ...gap.suggestedRole, responsibilities: Array(9).fill("要点") },
      }),
    ).toBe(false);
    expect(parse({ profiles: { kind: "existing", profileIds: ["p1", "p2", "p3", "p4"] } })).toBe(
      false,
    );
    expect(parse({ profiles: { kind: "existing", profileIds: ["p1", "p1"] } })).toBe(false);
    expect(parse({ profiles: { kind: "existing", profileIds: [] } })).toBe(false);
    expect(parse({ profiles: { kind: "none", reason: "" } })).toBe(false);
    expect(parse({ profiles: { kind: "none", reason: "host 无合适 Profile" } })).toBe(true);
    expect(
      DesignRoleGapSchema.safeParse({
        kind: "unlaunchable-role",
        roleId: "architect",
        responsibility: gap.responsibility,
        reason: gap.reason,
        use: gap.use,
        profiles: gap.profiles,
      }).success,
    ).toBe(true);
  });

  test("role-gap reports carry server-resolved names and stay bounded", () => {
    const report = {
      responsibility: gap.responsibility,
      reason: gap.reason,
      use: gap.use,
      profiles: [{ id: "codex-xhigh", name: "Codex xhigh", provider: "codex" }],
      suggestedRole: gap.suggestedRole,
    };
    expect(RoleGapReportSchema.parse(report)).toMatchObject({ use: "member" });
    expect(RoleGapReportSchema.safeParse({ ...report, profiles: Array(4).fill({}) }).success).toBe(
      false,
    );
    expect(
      RoleGapReportSchema.parse({
        ...report,
        unlaunchableRole: {
          roleId: "architect",
          roleName: "Architect",
          unavailableProfileIds: ["codex-xhigh"],
          profileNames: ["Codex xhigh"],
          futureField: "stripped",
        },
        futureField: "stripped",
      }),
    ).not.toHaveProperty("futureField");
  });
});

describe("start input record rule", () => {
  const base = { clientRequestId: DESIGN_JOB_ID, request: "给后台做改版" };

  test("existingRolesOnly keeps omission distinct from an explicit value", () => {
    expect(DesignStartInputSchema.parse(base).existingRolesOnly).toBeUndefined();
    expect(
      DesignStartInputSchema.parse({ ...base, existingRolesOnly: true }).existingRolesOnly,
    ).toBe(true);
    expect(
      DesignStartInputSchema.parse({ ...base, existingRolesOnly: false }).existingRolesOnly,
    ).toBe(false);
  });

  test("contractVersion accepts any integer and is normalized later, never defaulted", () => {
    expect(DesignStartInputSchema.parse(base).contractVersion).toBeUndefined();
    expect(DesignStartInputSchema.parse({ ...base, contractVersion: 2 }).contractVersion).toBe(2);
    expect(DesignStartInputSchema.parse({ ...base, contractVersion: 1 }).contractVersion).toBe(1);
    expect(DesignStartInputSchema.parse({ ...base, contractVersion: 3 }).contractVersion).toBe(3);
    expect(DesignStartInputSchema.safeParse({ ...base, contractVersion: 2.5 }).success).toBe(false);
    expect(DesignStartInputSchema.safeParse({ ...base, contractVersion: "2" }).success).toBe(false);
  });
});

describe("legacy client projection", () => {
  // Baseline shape copied literally: a non-strict object strips fields it does not know, which is
  // what an un-updated client sees after the plugin updates under it.
  const BaselineJobSchema = z.object({
    jobId: z.string(),
    state: z.enum([
      "starting",
      "designing",
      "validating",
      "fixing",
      "ready",
      "saving",
      "saved",
      "needs_continue",
      "save_conflict",
      "canceling",
      "canceled",
      "failed",
    ]),
    mode: z.enum(["sota", "economy", "collaborative"]),
    attempt: z.number(),
    issues: z.array(
      z.object({
        code: z.string(),
        severity: z.enum(["error", "warning"]),
        path: z.array(z.union([z.string(), z.number()])),
        params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
        action: z.enum([
          "none",
          "refresh",
          "repair",
          "choose-profile",
          "choose-workspace",
          "retry-save",
          "inspect",
        ]),
      }),
    ),
  });

  test("a baseline schema reads a v2 job and strips the new fields", () => {
    const job = designJob({
      existingRolesOnly: true,
      outputContractVersion: 2,
      roleGap: [
        {
          responsibility: "迁移评审",
          reason: "现有 Role 不覆盖",
          use: "member",
          profiles: [{ id: "codex-xhigh", name: "Codex xhigh", provider: "codex" }],
        },
      ],
    });
    expect(DesignJobSchema.safeParse(job).success).toBe(true);
    const projected = BaselineJobSchema.parse(job);
    expect(projected).not.toHaveProperty("existingRolesOnly");
    expect(projected).not.toHaveProperty("outputContractVersion");
    expect(projected).not.toHaveProperty("roleGap");
  });

  test("state, mode, and issue-code vocabularies are unchanged", () => {
    expect(DesignStateSchema.options).toEqual([
      "starting",
      "designing",
      "validating",
      "fixing",
      "ready",
      "saving",
      "saved",
      "needs_continue",
      "save_conflict",
      "canceling",
      "canceled",
      "failed",
    ]);
    // Snapshot of the baseline vocabulary: contract v2 adds no code, only params.
    expect([...DESIGN_ISSUE_CODES]).toEqual([
      "DESIGN_INPUT_INVALID",
      "DESIGN_REQUEST_CONFLICT",
      "DESIGN_MODE_UNAVAILABLE",
      "DESIGN_STORAGE_UNAVAILABLE",
      "DESIGN_BUSY",
      "DESIGN_DISCOVERY_INCOMPLETE",
      "DESIGN_JOB_NOT_FOUND",
      "DESIGN_STATE_CHANGED",
      "DESIGN_CONFIG_UNAVAILABLE",
      "DESIGN_SETTINGS_INVALID",
      "DESIGN_NO_WORKSPACE",
      "DESIGN_WORKSPACE_UNAVAILABLE",
      "DESIGN_PROFILE_UNAVAILABLE",
      "DESIGN_INPUT_TOO_LARGE",
      "DESIGN_OUTPUT_MISSING",
      "DESIGN_OUTPUT_MULTIPLE",
      "DESIGN_OUTPUT_TOO_LARGE",
      "DESIGN_OUTPUT_JSON",
      "DESIGN_OUTPUT_SCHEMA",
      "DESIGN_OUTPUT_IDENTITY",
      "DESIGN_TIMELINE_INCOMPLETE",
      "DESIGN_EXTERNAL_INPUT",
      "DESIGN_REUSE_INVALID",
      "DESIGN_ROLE_ID_CONFLICT",
      "DESIGN_ROLE_NAME_CONFLICT",
      "DESIGN_ROLE_NAMING",
      "DESIGN_ROLE_UNUSED",
      "DESIGN_NEW_ROLE_LIMIT",
      "DESIGN_TEAM_INVALID",
      "DESIGN_MEMBER_LIMIT",
      "DESIGN_PROFILE_MISSING",
      "DESIGN_PROFILE_DUPLICATE",
      "DESIGN_PROFILE_CHOICE",
      "DESIGN_PROVIDER_UNAVAILABLE",
      "DESIGN_MODE_PLAN_INVALID",
      "DESIGN_LAUNCH_BLOCKED",
      "DESIGN_TEAM_RENAMED",
      "DESIGN_CONTEXT_CHANGED",
      "DESIGN_TEAM_ID_CONFLICT",
      "DESIGN_RESULT_STALE",
      "DESIGN_SAVE_BUSY",
      "DESIGN_SAVE_LEASE_EXPIRED",
      "DESIGN_SAVE_CONFLICT",
      "DESIGN_SAVE_FAILED",
      "DESIGN_SAVE_UNKNOWN",
      "DESIGN_COMPENSATION_UNSAFE",
      "DESIGN_NOT_SAVED",
      "DESIGN_SAVED_MODIFIED",
      "DESIGN_RECOVERY_INCOMPLETE",
      "DESIGN_RETRY_EXHAUSTED",
      "DESIGN_AGENT_FAILED",
      "DESIGN_CANCEL_FAILED",
    ]);
  });

  test("a legacy job without the new fields still parses", () => {
    const parsed = DesignJobSchema.parse(designJob());
    expect(parsed.existingRolesOnly).toBeUndefined();
    expect(parsed.roleGap).toBeUndefined();
  });
});

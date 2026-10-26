import { describe, expect, test } from "vitest";
import { utf8ByteLength } from "../shared/domain/design-output";
import {
  DesignJobSchema,
  DesignProfileChoiceSchema,
  DesignProposalSchema,
  DesignRequestSchema,
  DesignResultSchema,
  DesignStartInputSchema,
  DesignTeamDraftSchema,
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

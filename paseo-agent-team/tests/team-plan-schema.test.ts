import { describe, expect, test } from "vitest";
import {
  emptyTeamPlanProbe,
  TEAM_PLAN_DESIGN_ROLE_POLICY,
  teamPlanRpc,
} from "../shared/rpc/team-plan";
import {
  TEAM_PLAN_MAX_DRAFT_ROWS,
  TEAM_PLAN_MAX_ITEMS,
  TeamPlanInputSchema,
  TeamPlanOutputSchema,
} from "../shared/schemas/team-plan";

function draftMember(index: number) {
  return { rowKey: `row-${index}`, roleId: "eng-dev", enabled: true };
}

function draftItem(key = "draft-1") {
  return {
    key,
    kind: "draft" as const,
    draft: {
      mode: "economy",
      coordinatorRoleId: "lead",
      members: [draftMember(1)],
    },
  };
}

const row = {
  rowKey: "seat-1",
  kind: "member" as const,
  roleId: "eng-dev",
  roleName: "【工程】开发",
  tier: "execution" as const,
  taskKind: "coding" as const,
  enabled: true,
  purpose: "member" as const,
  activation: "eager" as const,
  profile: {
    id: "profile-1",
    name: "Claude Opus",
    provider: "claude",
    model: "opus-4",
  },
  source: "role-preferred",
  budget: "sota" as const,
  budgetBasis: "host" as const,
  availability: "available" as const,
  configuredProfiles: [],
  issues: [],
};

const output = {
  schemaVersion: 1,
  capabilities: {
    modeContract: 2,
    designRolePolicy: 1,
    supportedModes: ["sota", "economy", "economy-all", "collaborative", "quantum"],
    runtimeCapabilities: { onDemand: false, expansion: false, collaboration: false },
  },
  checkedAt: "2026-10-27T12:00:00.000Z",
  context: {
    revisions: { roles: "r1", teams: "t1", preferences: "p1" },
    profilesFingerprint: "profiles-1",
    availabilityFingerprint: "availability-1",
  },
  results: [
    {
      key: "draft-1",
      status: "ready",
      effectiveMode: "economy",
      selectionFingerprint: "selection-1",
      rows: [row],
      issues: [],
    },
  ],
};

describe("team plan input", () => {
  test("defines the read-only wire name and a valid empty capability probe", () => {
    expect(teamPlanRpc.name).toBe("agent-team.team.plan");
    expect(TEAM_PLAN_DESIGN_ROLE_POLICY).toBe(1);
    const probe = emptyTeamPlanProbe();
    expect(probe).toEqual({ items: [] });
    expect(TeamPlanInputSchema.safeParse(probe).success).toBe(true);
  });

  test("accepts a saved item, a draft item, and the empty capability probe", () => {
    expect(TeamPlanInputSchema.safeParse({ items: [] }).success).toBe(true);
    const parsed = TeamPlanInputSchema.parse({
      items: [{ key: "saved-1", kind: "saved", teamId: "coding-team" }, draftItem()],
    });
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[1]).toMatchObject({ kind: "draft", draft: { mode: "economy" } });
  });

  test("keeps an incomplete draft faithful instead of inventing fields", () => {
    const parsed = TeamPlanInputSchema.parse({
      items: [
        {
          key: "draft-empty",
          kind: "draft",
          draft: {
            members: [{ rowKey: "row-a", enabled: true }],
            collaboration: { replicas: 2, futureKey: true },
          },
        },
      ],
    });
    const item = parsed.items[0];
    expect(item.kind).toBe("draft");
    if (item.kind !== "draft") throw new Error("expected draft");
    expect(item.draft.mode).toBeUndefined();
    expect(item.draft.members[0]?.roleId).toBeUndefined();
    expect(item.draft.collaboration).toMatchObject({ replicas: 2, futureKey: true });

    const emptyDraft = TeamPlanInputSchema.parse({
      items: [{ key: "draft-empty", kind: "draft", draft: { members: [], mode: "x".repeat(300) } }],
    });
    expect(emptyDraft.items[0]).toMatchObject({ kind: "draft", draft: { members: [] } });
  });

  test("rejects unknown keys at every hand-written level", () => {
    expect(TeamPlanInputSchema.safeParse({ items: [], extra: true }).success).toBe(false);
    expect(
      TeamPlanInputSchema.safeParse({
        items: [{ key: "saved-1", kind: "saved", teamId: "coding-team", extra: true }],
      }).success,
    ).toBe(false);
    expect(
      TeamPlanInputSchema.safeParse({
        items: [{ ...draftItem(), extra: true }],
      }).success,
    ).toBe(false);
    expect(
      TeamPlanInputSchema.safeParse({
        items: [
          {
            key: "draft-1",
            kind: "draft",
            draft: { members: [{ rowKey: "row-a", enabled: true, extra: true }] },
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("rejects duplicate keys, duplicate draft rowKeys, and an empty rowKey", () => {
    const duplicateKeys = TeamPlanInputSchema.safeParse({
      items: [draftItem("same"), draftItem("same")],
    });
    expect(duplicateKeys.success).toBe(false);
    if (!duplicateKeys.success) {
      expect(duplicateKeys.error.issues.map((issue) => issue.message)).toContain(
        "teamPlan.duplicateKey",
      );
    }
    expect(
      TeamPlanInputSchema.safeParse({
        items: [
          {
            key: "draft-1",
            kind: "draft",
            draft: {
              members: [
                { rowKey: "row-a", enabled: true },
                { rowKey: "row-a", enabled: false },
              ],
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      TeamPlanInputSchema.safeParse({
        items: [
          { key: "draft-1", kind: "draft", draft: { members: [{ rowKey: "", enabled: true }] } },
        ],
      }).success,
    ).toBe(false);
  });

  test("bounds items at 20/21 and draft rows at 256/257", () => {
    const twenty = Array.from({ length: TEAM_PLAN_MAX_ITEMS }, (_, index) =>
      draftItem(`k${index}`),
    );
    expect(TeamPlanInputSchema.safeParse({ items: twenty }).success).toBe(true);
    expect(TeamPlanInputSchema.safeParse({ items: [...twenty, draftItem("k20")] }).success).toBe(
      false,
    );

    const full = {
      key: "draft-full",
      kind: "draft" as const,
      draft: {
        members: Array.from({ length: TEAM_PLAN_MAX_DRAFT_ROWS }, (_, index) => draftMember(index)),
      },
    };
    expect(TeamPlanInputSchema.safeParse({ items: [full] }).success).toBe(true);
    expect(
      TeamPlanInputSchema.safeParse({
        items: [
          {
            ...full,
            draft: {
              members: [...full.draft.members, draftMember(TEAM_PLAN_MAX_DRAFT_ROWS)],
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("rejects an envelope over 128 KiB rather than truncating it", () => {
    const heavy = {
      key: "draft-heavy",
      kind: "draft" as const,
      draft: {
        members: Array.from({ length: TEAM_PLAN_MAX_DRAFT_ROWS }, (_, index) => ({
          rowKey: `row-${index}-${"x".repeat(240)}`,
          roleId: "r".repeat(256),
          enabled: true,
        })),
      },
    };
    const result = TeamPlanInputSchema.safeParse({ items: [heavy] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain("teamPlan.inputTooLarge");
  });
});

describe("team plan output", () => {
  test("round-trips the strict contract and keeps an open source string", () => {
    const parsed = TeamPlanOutputSchema.parse(output);
    expect(parsed.results[0]?.rows[0]).toMatchObject({
      rowKey: "seat-1",
      profile: { id: "profile-1" },
      source: "role-preferred",
    });

    const future = TeamPlanOutputSchema.parse({
      ...output,
      results: [
        {
          ...output.results[0],
          rows: [{ ...row, source: "economy-cheap-route" }],
        },
      ],
    });
    expect(future.results[0]?.rows[0]?.source).toBe("economy-cheap-route");
    expect(future.capabilities.supportedModes).toContain("quantum");
  });

  test("allows a blocked row with no selected Profile and an unknown raw mode", () => {
    const parsed = TeamPlanOutputSchema.parse({
      ...output,
      context: null,
      results: [
        {
          key: "saved-1",
          status: "blocked",
          rawMode: "turbo",
          effectiveMode: null,
          selectionFingerprint: null,
          rows: [{ ...row, profile: null, enabled: false, issues: [] }],
          issues: [],
        },
      ],
    });
    expect(parsed.results[0]?.effectiveMode).toBeNull();
    expect(parsed.results[0]?.rows[0]?.profile).toBeNull();
  });

  test("rejects unknown keys, unknown budgets, and the wrong schema version", () => {
    expect(TeamPlanOutputSchema.safeParse({ ...output, extra: true }).success).toBe(false);
    expect(
      TeamPlanOutputSchema.safeParse({
        ...output,
        results: [{ ...output.results[0], rows: [{ ...row, budget: "cheap" }] }],
      }).success,
    ).toBe(false);
    expect(TeamPlanOutputSchema.safeParse({ ...output, schemaVersion: 2 }).success).toBe(false);
    expect(
      TeamPlanOutputSchema.safeParse({
        ...output,
        results: [{ ...output.results[0], status: "thinking" }],
      }).success,
    ).toBe(false);
  });
});

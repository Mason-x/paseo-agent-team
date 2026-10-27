// B01 spec: team.plan strict DTO and the model-summary contract. Real schemas/functions only;
// every case pins AC-0b.* behavior and must stay green against the B01 implementation.
import { describe, expect, test } from "vitest";
import { MODE_CONTRACT_VERSION, TEAM_MODES } from "../../shared/domain/mode-contract";
import { type ModelFamilyHint, summarizeModelRows } from "../../shared/domain/model-summary";
import { emptyTeamPlanProbe } from "../../shared/rpc/team-plan";
import {
  TEAM_PLAN_DESIGN_ROLE_POLICY,
  TEAM_PLAN_MAX_DRAFT_ROWS,
  TEAM_PLAN_MAX_INPUT_BYTES,
  TEAM_PLAN_MAX_ITEMS,
  TEAM_PLAN_SCHEMA_VERSION,
  type TeamPlanInput,
  TeamPlanInputSchema,
  type TeamPlanOutput,
  TeamPlanOutputSchema,
  type TeamPlanRow,
} from "../../shared/schemas/team-plan";

function planRow(
  overrides: Partial<Omit<TeamPlanRow, "profile">> & { profile?: TeamPlanRow["profile"] } = {},
): TeamPlanRow {
  return {
    rowKey: "seat-1",
    kind: "member",
    roleId: "eng-fullstack",
    roleName: "Developer",
    tier: "execution",
    taskKind: "coding",
    enabled: true,
    purpose: "member",
    activation: "eager",
    profile: {
      id: "profile-opus",
      name: "Opus Primary",
      provider: "claude",
      model: "claude-opus-4",
    },
    source: "role-preferred",
    budget: "sota",
    budgetBasis: "host",
    availability: "available",
    configuredProfiles: [],
    issues: [],
    ...overrides,
  };
}

function planResult(
  key: string,
  rows: TeamPlanRow[] = [planRow()],
): TeamPlanOutput["results"][number] {
  return {
    key,
    status: "ready",
    effectiveMode: "sota",
    selectionFingerprint: "fp-1",
    rows,
    issues: [],
  };
}

function planOutput(overrides: Partial<TeamPlanOutput> = {}): TeamPlanOutput {
  return {
    schemaVersion: TEAM_PLAN_SCHEMA_VERSION,
    capabilities: {
      modeContract: MODE_CONTRACT_VERSION,
      designRolePolicy: TEAM_PLAN_DESIGN_ROLE_POLICY,
      supportedModes: [...TEAM_MODES],
      runtimeCapabilities: { onDemand: false, expansion: false, collaboration: false },
    },
    checkedAt: "2026-10-27T12:00:00.000Z",
    context: null,
    results: [planResult("saved-1")],
    ...overrides,
  };
}

function draftItem(key: string, rowCount = 1): TeamPlanInput["items"][number] {
  return {
    key,
    kind: "draft",
    draft: {
      mode: "economy",
      coordinatorRoleId: "lead-orchestrator",
      members: Array.from({ length: rowCount }, (_, index) => ({
        rowKey: `${key}-row-${index}`,
        roleId: "eng-fullstack",
        enabled: true,
      })),
    },
  };
}

function summarize(
  rows: TeamPlanRow[],
  overrides: Partial<Parameters<typeof summarizeModelRows>[0]> = {},
) {
  return summarizeModelRows({ status: "ready", effectiveMode: "economy", rows, ...overrides });
}

function summaryOf(
  rows: TeamPlanRow[],
  overrides: Partial<Parameters<typeof summarizeModelRows>[0]> = {},
) {
  const result = summarize(rows, overrides);
  if (result.status !== "summary") throw new Error(`expected a summary, got ${result.reason}`);
  return result;
}

describe("team plan input contract", () => {
  // AC-0b.3: saved/draft is a discriminated union; incomplete drafts stop only at transport types.
  test("discriminates saved and draft items", () => {
    const parsed = TeamPlanInputSchema.safeParse({
      items: [{ key: "saved-1", kind: "saved", teamId: "coding-team" }, draftItem("draft-1")],
    });
    expect(parsed.success).toBe(true);

    const invalid = [
      { key: "saved-1", kind: "saved" },
      { key: "draft-1", kind: "draft" },
      { key: "saved-1", kind: "saved", teamId: "coding-team", draft: { members: [] } },
      { key: "draft-1", kind: "draft", teamId: "coding-team", draft: { members: [] } },
      { key: "x", kind: "team", teamId: "coding-team" },
    ];
    for (const item of invalid) {
      expect(TeamPlanInputSchema.safeParse({ items: [item] }).success).toBe(false);
    }
  });

  // AC-0b.3: batches and drafts are bounded; duplicate keys are rejected, never merged.
  test("enforces batch, draft-row, and uniqueness bounds", () => {
    const items = Array.from({ length: TEAM_PLAN_MAX_ITEMS }, (_, index) => draftItem(`k${index}`));
    expect(TeamPlanInputSchema.safeParse({ items }).success).toBe(true);
    expect(TeamPlanInputSchema.safeParse({ items: [...items, draftItem("k20")] }).success).toBe(
      false,
    );

    const fullDraft = draftItem("full", TEAM_PLAN_MAX_DRAFT_ROWS);
    expect(TeamPlanInputSchema.safeParse({ items: [fullDraft] }).success).toBe(true);
    expect(
      TeamPlanInputSchema.safeParse({ items: [draftItem("full", TEAM_PLAN_MAX_DRAFT_ROWS + 1)] })
        .success,
    ).toBe(false);

    expect(
      TeamPlanInputSchema.safeParse({ items: [draftItem("same"), draftItem("same")] }).success,
    ).toBe(false);
    const duplicateRows = {
      key: "draft-1",
      kind: "draft",
      draft: {
        members: [
          { rowKey: "row-a", enabled: true },
          { rowKey: "row-a", enabled: false },
        ],
      },
    };
    const duplicate = TeamPlanInputSchema.safeParse({ items: [duplicateRows] });
    expect(duplicate.success).toBe(false);
    if (!duplicate.success) {
      expect(duplicate.error.issues.map((issue) => issue.message)).toContain(
        "teamPlan.duplicateRowKey",
      );
    }
  });

  // AC-0b.3: the 128 KiB cap is an envelope check; a full 256-row draft still fits.
  test("rejects an envelope over 128 KiB instead of truncating it", () => {
    const long = {
      key: "draft-heavy",
      kind: "draft" as const,
      draft: {
        members: Array.from({ length: TEAM_PLAN_MAX_DRAFT_ROWS }, (_, index) => ({
          rowKey: `r${index}`,
          roleId: "x".repeat(600),
          enabled: true,
        })),
      },
    };
    expect(JSON.stringify({ items: [long] }).length).toBeGreaterThan(TEAM_PLAN_MAX_INPUT_BYTES);
    const tooLarge = TeamPlanInputSchema.safeParse({ items: [long] });
    expect(tooLarge.success).toBe(false);
    if (!tooLarge.success) {
      expect(tooLarge.error.issues.map((issue) => issue.message)).toContain(
        "teamPlan.inputTooLarge",
      );
    }
  });

  // AC-0b.13 / AC-0b.16: items:[] is the probe; capabilities use D01's contract constants.
  test("the empty-items probe carries the current capability contract", () => {
    expect(emptyTeamPlanProbe()).toEqual({ items: [] });
    expect(TeamPlanInputSchema.safeParse(emptyTeamPlanProbe()).success).toBe(true);

    const probe = {
      schemaVersion: TEAM_PLAN_SCHEMA_VERSION,
      capabilities: {
        modeContract: MODE_CONTRACT_VERSION,
        designRolePolicy: TEAM_PLAN_DESIGN_ROLE_POLICY,
        supportedModes: [...TEAM_MODES],
        runtimeCapabilities: { onDemand: true, expansion: false, collaboration: false },
      },
      checkedAt: "2026-10-27T12:00:00.000Z",
      context: null,
      results: [],
    } satisfies TeamPlanOutput;
    const parsed = TeamPlanOutputSchema.parse(probe);
    expect(parsed.capabilities.modeContract).toBe(2);
    expect(parsed.capabilities.supportedModes).toEqual([...TEAM_MODES]);
    expect(parsed.capabilities.supportedModes).toContain("economy-all");
    expect(parsed.capabilities.designRolePolicy).toBe(TEAM_PLAN_DESIGN_ROLE_POLICY);
    expect(parsed.context).toBeNull();
    expect(parsed.results).toEqual([]);
  });
});

describe("team plan output contract", () => {
  // AC-0b.15: a versioned strict object; capabilities are required, not optional extras.
  test("requires the schema version and full capabilities", () => {
    expect(TeamPlanOutputSchema.safeParse(planOutput()).success).toBe(true);
    expect(TeamPlanOutputSchema.safeParse({ ...planOutput(), schemaVersion: 0 }).success).toBe(
      false,
    );
    expect(TeamPlanOutputSchema.safeParse({ ...planOutput(), schemaVersion: 2 }).success).toBe(
      false,
    );

    const { capabilities, ...withoutCapabilities } = planOutput();
    expect(TeamPlanOutputSchema.safeParse(withoutCapabilities).success).toBe(false);
    const missingRuntime = { ...capabilities, runtimeCapabilities: undefined };
    expect(
      TeamPlanOutputSchema.safeParse({ ...planOutput(), capabilities: missingRuntime }).success,
    ).toBe(false);
    expect(
      TeamPlanOutputSchema.safeParse({
        ...planOutput(),
        capabilities: { ...capabilities, modeContract: -1 },
      }).success,
    ).toBe(false);
  });

  // AC-0b.4 / AC-0b.15: results are bounded by the same batch size as the request.
  test("bounds results at 20", () => {
    const twenty = Array.from({ length: TEAM_PLAN_MAX_ITEMS }, (_, index) =>
      planResult(`k${index}`),
    );
    expect(TeamPlanOutputSchema.safeParse(planOutput({ results: twenty })).success).toBe(true);
    expect(
      TeamPlanOutputSchema.safeParse({
        ...planOutput(),
        results: [...twenty, planResult("k20")],
      }).success,
    ).toBe(false);
  });

  // AC-0b.1 / AC-0b.15: no host internals, prompts, or a second selector may ride along.
  test("rejects internal and ad-hoc fields at every level", () => {
    const withFallback = Object.assign(planRow(), { fallbackProfile: { id: "p" } });
    const withEnv = Object.assign(planRow(), { env: { TOKEN: "x" } });
    const attempts = [
      { ...planOutput(), notes: "internal" },
      { ...planOutput(), workspaceId: "ws-1" },
      { ...planOutput(), results: [{ ...planResult("saved-1"), systemPrompt: "secret" }] },
      { ...planOutput(), results: [{ ...planResult("saved-1"), mcp: { enabled: true } }] },
      { ...planOutput(), results: [planResult("saved-1", [withFallback])] },
      { ...planOutput(), results: [planResult("saved-1", [withEnv])] },
    ];
    for (const attempt of attempts) {
      expect(TeamPlanOutputSchema.safeParse(attempt).success).toBe(false);
    }
  });

  // AC-0b.4: rows carry the real tuple and an open source; selection enums stay closed.
  test("keeps the real provider/model/mode/thinking tuple on a row", () => {
    const row = planRow({
      profile: {
        id: "profile-sonnet",
        name: "Sonnet High",
        provider: "claude",
        model: "claude-sonnet-4",
        modeId: "full",
        thinkingOptionId: "high",
      },
      source: "economy-cheap-route",
      budget: "economy",
      budgetBasis: "pool",
      availability: "unverified",
    });
    const parsed = TeamPlanOutputSchema.parse(
      planOutput({ results: [planResult("saved-1", [row])] }),
    );
    expect(parsed.results[0]?.rows[0]?.profile).toEqual({
      id: "profile-sonnet",
      name: "Sonnet High",
      provider: "claude",
      model: "claude-sonnet-4",
      modeId: "full",
      thinkingOptionId: "high",
    });
    expect(parsed.results[0]?.rows[0]?.source).toBe("economy-cheap-route");

    expect(
      TeamPlanOutputSchema.safeParse(
        planOutput({
          results: [planResult("saved-1", [planRow({ budget: "cheap" as TeamPlanRow["budget"] })])],
        }),
      ).success,
    ).toBe(false);
    expect(
      TeamPlanOutputSchema.safeParse(
        planOutput({
          results: [
            planResult("saved-1", [
              planRow({ availability: "maybe" as TeamPlanRow["availability"] }),
            ]),
          ],
        }),
      ).success,
    ).toBe(false);
    expect(
      TeamPlanOutputSchema.safeParse(
        planOutput({
          results: [
            planResult("saved-1", [
              planRow({ budgetBasis: "guess" as TeamPlanRow["budgetBasis"] }),
            ]),
          ],
        }),
      ).success,
    ).toBe(false);
    const blocked = planRow({ enabled: false, profile: null, issues: [] });
    expect(
      TeamPlanOutputSchema.safeParse(planOutput({ results: [planResult("saved-1", [blocked])] }))
        .success,
    ).toBe(true);
  });
});

describe("model summary contract", () => {
  // AC-0b.6: coordinator and standby rows count, disabled rows never do, total reconciles.
  test("counts the coordinator and standby seats while excluding disabled rows", () => {
    const result = summaryOf([
      planRow({ rowKey: "coordinator", kind: "coordinator", roleId: "lead-orchestrator" }),
      planRow({
        rowKey: "standby",
        purpose: "escalation",
        activation: "escalation-only",
        profile: { id: "p-sonnet", name: "Sonnet", provider: "claude", model: "sonnet-4" },
      }),
      planRow({ rowKey: "disabled", enabled: false, profile: null }),
    ]);
    expect(result.total).toBe(2);
    expect(result.groups).toEqual([
      { key: "family:opus", label: "Opus", count: 1, standby: 0 },
      { key: "family:sonnet", label: "Sonnet", count: 1, standby: 1 },
    ]);
    expect(result.unresolved).toEqual({ count: 0, reasons: [] });
    expect(result.total).toBe(result.groups.reduce((sum, group) => sum + group.count, 0));
  });

  // AC-0b.6: unresolved rows expand by reason; a provider failure is not "unbound".
  test("groups unresolved rows by reason", () => {
    const issue = (code: string, params: Record<string, string> = {}) => ({
      code,
      severity: "blocker" as const,
      params,
    });
    const result = summaryOf([
      planRow({ rowKey: "a", profile: null }),
      planRow({ rowKey: "b", profile: null }),
      planRow({
        rowKey: "c",
        profile: null,
        issues: [issue("MODE_PROFILE_UNRESOLVED", { reason: "all-missing" })],
      }),
      planRow({ rowKey: "d", profile: null, availability: "unavailable" }),
      planRow({ rowKey: "e", profile: null, availability: "unverified" }),
      planRow({ rowKey: "f", profile: null, roleId: null }),
      planRow({ rowKey: "g", profile: null, issues: [issue("MODE_POOL_EMPTY")] }),
    ]);
    expect(result.total).toBe(7);
    expect(result.unresolved.count).toBe(7);
    expect(result.unresolved.reasons[0]).toEqual({ reason: "unbound", count: 2 });
    const byReason = Object.fromEntries(
      result.unresolved.reasons.map((entry) => [entry.reason, entry.count]),
    );
    expect(byReason).toMatchObject({
      "profile-missing": 1,
      "provider-unavailable": 1,
      unverified: 1,
      "role-missing": 1,
      policy: 1,
    });
    expect(byReason.unbound).toBe(2);
  });

  // AC-0b.6: auto/missing models are unresolved families, not unresolved seats.
  test("a selected Profile with auto or missing model stays a row, not an unresolved count", () => {
    const auto = summaryOf([
      planRow({
        rowKey: "a",
        profile: { id: "p-auto", name: "Auto Profile", provider: "claude", model: "auto" },
      }),
      planRow({ rowKey: "b", profile: { id: "p-none", name: "No Model", provider: "claude" } }),
    ]);
    expect(auto.unresolved.count).toBe(0);
    expect(auto.groups).toEqual([
      { key: "profile:p-auto", label: "Auto Profile", count: 1, standby: 0 },
      { key: "profile:p-none", label: "No Model", count: 1, standby: 0 },
    ]);

    const hints: ModelFamilyHint[] = [
      { profileId: "p-auto", provider: "claude", model: "auto", family: "sonnet" },
      { profileId: "p-none", provider: "claude", model: "old-model", family: "sonnet" },
    ];
    const hinted = summaryOf(
      [
        planRow({
          rowKey: "a",
          profile: { id: "p-auto", name: "Auto Profile", provider: "claude", model: "auto" },
        }),
        planRow({ rowKey: "b", profile: { id: "p-none", name: "No Model", provider: "claude" } }),
      ],
      { familyHints: hints },
    );
    // Only the tuple-matched hint applies; the stale model keeps its own Profile label.
    expect(hinted.groups.map((group) => group.key).sort()).toEqual([
      "family:sonnet",
      "profile:p-none",
    ]);
  });

  // AC-0b.4 / AC-0b.6: physical rows are never collapsed when only tuple fields differ.
  test("keeps rows differing only in provider/model/mode/thinking distinct", () => {
    const base = { id: "p-same", name: "Same Profile", provider: "claude", model: "claude-opus-4" };
    const low = planRow({
      rowKey: "a",
      profile: { ...base, modeId: "fast", thinkingOptionId: "low" },
    });
    const high = planRow({
      rowKey: "b",
      profile: { ...base, modeId: "full", thinkingOptionId: "xhigh" },
    });
    const movedProvider = planRow({ rowKey: "c", profile: { ...base, provider: "omp" } });
    const movedModel = planRow({ rowKey: "d", profile: { ...base, model: "claude-sonnet-4" } });
    expect(low.profile).not.toEqual(high.profile);
    expect(low.profile).not.toEqual(movedProvider.profile);
    expect(low.profile).not.toEqual(movedModel.profile);

    const summary = summaryOf([low, high, movedProvider, movedModel]);
    expect(summary.total).toBe(4);
    expect(summary.groups).toEqual([
      { key: "family:opus", label: "Opus", count: 3, standby: 0 },
      { key: "family:sonnet", label: "Sonnet", count: 1, standby: 0 },
    ]);
    const parsed = TeamPlanOutputSchema.parse(
      planOutput({ results: [planResult("saved-1", [low, high, movedProvider, movedModel])] }),
    );
    expect(parsed.results[0]?.rows.map((row) => row.profile?.thinkingOptionId)).toEqual([
      "low",
      "xhigh",
      undefined,
      undefined,
    ]);
  });

  // AC-0b.6 / AC-0b.12: no summary without a recognized mode or a readable host.
  test("unknown mode and unavailable host produce no summary", () => {
    expect(
      summarize([planRow()], { effectiveMode: null, rawMode: "turbo", status: "blocked" }),
    ).toEqual({
      status: "none",
      reason: "unknown-mode",
      rawMode: "turbo",
    });
    expect(summarize([planRow()], { status: "unavailable" })).toEqual({
      status: "none",
      reason: "unavailable",
    });
    expect(summaryOf([planRow()], { status: "blocked" }).total).toBe(1);
  });

  // AC-0b.6: count descending, then label, then key — stable for equal counts.
  test("sorts groups by count, label, then key", () => {
    const result = summaryOf([
      planRow({ rowKey: "a" }),
      planRow({ rowKey: "b" }),
      planRow({
        rowKey: "c",
        profile: { id: "p-ds", name: "DeepSeek", provider: "omp", model: "deepseek-v4" },
      }),
      planRow({
        rowKey: "d",
        profile: { id: "p-grok", name: "Grok", provider: "omp", model: "grok-4" },
      }),
      planRow({
        rowKey: "e",
        profile: { id: "p-sonnet", name: "Sonnet", provider: "claude", model: "sonnet-4" },
      }),
      planRow({
        rowKey: "f",
        profile: { id: "p-b", name: "Mystery", provider: "claude", model: "mystery" },
      }),
      planRow({
        rowKey: "g",
        profile: { id: "p-a", name: "Mystery", provider: "claude", model: "mystery" },
      }),
    ]);
    expect(result.groups.map((group) => group.key)).toEqual([
      "family:opus",
      "family:deepseek",
      "family:grok",
      "profile:p-a",
      "profile:p-b",
      "family:sonnet",
    ]);
  });
});

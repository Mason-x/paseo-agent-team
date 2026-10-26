import { describe, expect, test } from "vitest";
import {
  type AvailableProfileSelection,
  type EconomyPolicy,
  type HostSnapshot,
  normalizeEconomyPolicy,
  normalizeMode,
  type ProfileSelection,
  resolveModeProfile,
  selectCollaborationProfiles,
  type UnavailableProfileSelection,
} from "../shared/domain/mode-resolver";
import type { PaseoProfile, ProviderAvailability } from "../shared/paseo/adapter";
import type { Role } from "../shared/schemas/role";
import type { StoredEconomyEntry, TeamMode } from "../shared/schemas/team-mode";
import { role } from "./fixtures";

function expectAvailable(
  selection: ProfileSelection,
): asserts selection is AvailableProfileSelection {
  expect(selection.unavailable).toBe(false);
  if (selection.unavailable) throw new Error("expected an available selection");
}

function expectUnavailable(
  selection: ProfileSelection,
): asserts selection is UnavailableProfileSelection {
  expect(selection.unavailable).toBe(true);
  if (!selection.unavailable) throw new Error("expected an unavailable selection");
}

function profileIds(selections: readonly ProfileSelection[]): string[] {
  return selections.map((selection) => {
    expectAvailable(selection);
    return selection.profile.id;
  });
}

function firstAvailable(selections: readonly ProfileSelection[]): AvailableProfileSelection {
  const [first] = selections;
  if (!first) throw new Error("expected at least one selection");
  expectAvailable(first);
  return first;
}

// Real pool names/provider/model from the host's exported fixture; IDs stay synthetic so the test
// never depends on a machine Profile ID.
const deepseek: PaseoProfile = {
  id: "profile-deepseek",
  name: "DeepSeek-V4.1-Flash-Max",
  provider: "omp",
  model: "opencode-go/deepseek-v4.1-flash",
  modeId: "full",
  thinkingOptionId: "max",
  notes: "用量几乎无限制",
};
const grokXhigh: PaseoProfile = {
  id: "profile-grok-xhigh",
  name: "Grok-4.7-Xhigh",
  provider: "omp",
  model: "CPA/grok-4.7",
  modeId: "full",
  thinkingOptionId: "xhigh",
};
const grokXhighFast: PaseoProfile = {
  id: "profile-grok-xhigh-fast",
  name: "Grok-4.7-Xhigh-Fast",
  provider: "omp",
  model: "cursor/grok-4.7-500k-fast",
  modeId: "full",
  thinkingOptionId: "xhigh",
};
const grok46Fast: PaseoProfile = {
  id: "profile-grok-46-fast",
  name: "Grok-4.6-High-Fast",
  provider: "omp",
  model: "cursor/cursor-grok-4.6-fast",
  modeId: "full",
  thinkingOptionId: "high",
};
const claude: PaseoProfile = {
  id: "profile-claude-opus",
  name: "Claude-Opus-5.5-Max",
  provider: "claude",
  model: "claude-opus-5-5",
  modeId: "auto",
  thinkingOptionId: "max",
  notes: "用量几乎无限制",
};
const gpt: PaseoProfile = {
  id: "profile-gpt",
  name: "GPT-6-Astra-Max",
  provider: "codex",
  model: "gpt-6-astra",
  modeId: "auto-review",
  thinkingOptionId: "max",
};
const gemini: PaseoProfile = {
  id: "profile-gemini",
  name: "Gemini-3.8-flash-High",
  provider: "omp",
  model: "CPA/gemini-3.8-flash-high",
  modeId: "full",
  thinkingOptionId: "high",
};

const allProfiles = [deepseek, grokXhigh, grokXhighFast, grok46Fast, claude, gpt, gemini];

const available: ProviderAvailability[] = [
  { provider: "claude", available: true },
  { provider: "codex", available: true },
  { provider: "omp", available: true },
];

function entries(overrides: Record<string, boolean> = {}): StoredEconomyEntry[] {
  return [deepseek, grokXhigh, grokXhighFast, grok46Fast].map((profile) => ({
    profileId: profile.id,
    nameSnapshot: profile.name,
    family: profile.provider === "omp" && profile.id === deepseek.id ? "deepseek" : "grok",
    enabled: overrides[profile.id] ?? true,
    boundModel: { provider: profile.provider, model: profile.model },
  }));
}

const poolIds = [deepseek.id, grokXhigh.id, grokXhighFast.id, grok46Fast.id];
const taskOrder = {
  coding: poolIds,
  testing: poolIds,
  acceptance: poolIds,
  codebase: poolIds,
  ops: [grokXhigh.id, grokXhighFast.id, grok46Fast.id, deepseek.id],
  general: poolIds,
};

function normalize(
  pool = entries(),
  order?: Record<string, string[]>,
  profileBudget: Record<string, string> = {},
) {
  const ids = new Set(pool.map((entry) => entry.profileId));
  const effectiveOrder =
    order ??
    Object.fromEntries(
      Object.entries(taskOrder).map(([kind, list]) => [
        kind,
        list.filter((profileId) => ids.has(profileId)),
      ]),
    );
  const result = normalizeEconomyPolicy(
    { pool, taskOrder: effectiveOrder, profileBudget },
    allProfiles,
  );
  if (!result.ok) throw new Error("unexpected policy failure");
  return result;
}

const policy = normalize().value;

function roleOf(id: string, overrides: Partial<Role> = {}): Role {
  return role({
    id,
    name: `Role ${id}`,
    preferredProfiles: [{ profileId: claude.id, nameSnapshot: claude.name }],
    ...overrides,
  });
}

function resolve(
  roleId: string,
  mode: TeamMode,
  options: {
    kind?: "coordinator" | "member";
    economy?: EconomyPolicy;
    availability?: ProviderAvailability[];
    host?: HostSnapshot;
    excludedProfileIds?: ReadonlySet<string>;
  } = {},
) {
  return resolveModeProfile({
    mode,
    role: roleOf(roleId),
    kind: options.kind ?? "member",
    host: options.host ?? {
      status: "ready",
      profiles: allProfiles,
      availability: options.availability ?? available,
    },
    economy: options.economy ?? policy,
    excludedProfileIds: options.excludedProfileIds,
  });
}

describe("normalizeMode", () => {
  test("defaults an absent or blank mode to sota", () => {
    expect(normalizeMode(undefined)).toEqual({ ok: true, value: "sota", issues: [] });
    expect(normalizeMode("  ")).toEqual({ ok: true, value: "sota", issues: [] });
    for (const mode of ["sota", "economy", "collaborative"] as const) {
      expect(normalizeMode(mode)).toEqual({ ok: true, value: mode, issues: [] });
    }
    expect(normalizeMode(" economy ")).toEqual({ ok: true, value: "economy", issues: [] });
  });

  test("reports an unsupported mode as a blocker instead of silently defaulting", () => {
    expect(normalizeMode("quantum")).toEqual({
      ok: false,
      issues: [{ code: "MODE_UNKNOWN", severity: "blocker", params: { value: "quantum" } }],
    });
  });
});

describe("normalizeEconomyPolicy", () => {
  test("normalizes family case and verifies it against the stored boundModel", () => {
    const result = normalize([
      {
        ...entries()[0],
        family: " DeepSeek ",
        boundModel: { provider: "omp", model: deepseek.model },
      },
      { ...entries()[1], boundModel: undefined },
      { ...entries()[2], boundModel: { provider: "omp", model: "another-model" } },
      { ...entries()[3], boundModel: { provider: "claude", model: grok46Fast.model } },
    ]);
    expect(result.value.pool).toEqual([
      { profileId: deepseek.id, family: "deepseek", enabled: true },
      { profileId: grokXhigh.id, enabled: true },
      { profileId: grokXhighFast.id, enabled: true },
      { profileId: grok46Fast.id, enabled: true },
    ]);
    expect(
      (result.issues ?? []).filter((issue) => issue.code === "MODE_FAMILY_MISSING"),
    ).toMatchObject([
      { params: { profileId: grokXhigh.id, reason: "bound-model-missing" } },
      { params: { profileId: grokXhighFast.id, reason: "bound-model-changed" } },
      { params: { profileId: grok46Fast.id, reason: "bound-model-changed" } },
    ]);
  });

  test("keeps the first duplicate, ignores out-of-pool order entries, and reports both", () => {
    const result = normalize([entries()[0], { ...entries()[0], family: "other" }, entries()[1]], {
      coding: [gpt.id, deepseek.id, deepseek.id, grokXhigh.id],
    });
    expect(result.value.pool.map((entry) => entry.profileId)).toEqual([deepseek.id, grokXhigh.id]);
    expect(result.value.taskOrder.coding).toEqual([deepseek.id, grokXhigh.id]);
    expect(result.issues).toMatchObject([
      { code: "MODE_POOL_DUPLICATE", params: { profileId: deepseek.id } },
      { code: "MODE_POOL_ORDER_IGNORED", params: { kind: "coding", profileId: gpt.id } },
    ]);
  });

  test("marks missing Profiles, unknown task kinds, and invalid budgets", () => {
    const result = normalize(
      [{ profileId: "profile-missing", family: "deepseek", enabled: true }, entries()[0]],
      { delivery: [deepseek.id], coding: [deepseek.id] },
      { [deepseek.id]: "sota", "profile-outside": "sponsor", [claude.id]: "sota" },
    );
    expect(result.issues).toMatchObject([
      { code: "MODE_POOL_ENTRY_MISSING", params: { profileId: "profile-missing" } },
      { code: "MODE_POOL_ORDER_IGNORED", params: { kind: "delivery" } },
      {
        code: "MODE_POOL_CONFIG_INVALID",
        params: { field: "profileBudget", profileId: deepseek.id, value: "sota" },
      },
      {
        code: "MODE_POOL_CONFIG_INVALID",
        params: { field: "profileBudget", profileId: "profile-outside", value: "sponsor" },
      },
    ]);
    // A pool Profile always consumes the pool; an outside Profile may be labeled SOTA.
    expect(result.value.profileBudget).toEqual({
      "profile-missing": "economy",
      [deepseek.id]: "economy",
      [claude.id]: "sota",
    });
  });

  test("a blank saved model means unspecified, while a blank against a real model is a change", () => {
    const modelLess: PaseoProfile = {
      id: "profile-model-less",
      name: "Model-less",
      provider: "claude",
    };
    const verified = normalizeEconomyPolicy(
      {
        pool: [
          {
            profileId: modelLess.id,
            family: "claude",
            boundModel: { provider: "claude", model: "" },
          },
        ],
      },
      [...allProfiles, modelLess],
    );
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.value.pool).toEqual([
      { profileId: modelLess.id, family: "claude", enabled: true },
    ]);
    expect(verified.issues).toEqual([]);

    const changed = normalizeEconomyPolicy(
      {
        pool: [
          {
            profileId: deepseek.id,
            family: "deepseek",
            boundModel: { provider: "omp", model: "" },
          },
        ],
      },
      allProfiles,
    );
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.value.pool).toEqual([{ profileId: deepseek.id, enabled: true }]);
    expect(changed.issues).toMatchObject([
      {
        code: "MODE_FAMILY_MISSING",
        params: { profileId: deepseek.id, reason: "bound-model-changed" },
      },
    ]);
  });

  test("every budget label for a pool Profile is ignored", () => {
    const result = normalize(entries(), taskOrder, { [deepseek.id]: "unknown" });
    expect(result.issues).toMatchObject([
      {
        code: "MODE_POOL_CONFIG_INVALID",
        params: { field: "profileBudget", profileId: deepseek.id, value: "unknown" },
      },
    ]);
    expect(result.value.profileBudget[deepseek.id]).toBe("economy");
  });

  test("one malformed pool entry is reported in place without losing the rest", () => {
    const result = normalizeEconomyPolicy(
      {
        pool: [
          { profileId: 5 },
          "bad",
          {
            profileId: deepseek.id,
            family: "deepseek",
            boundModel: { provider: "omp", model: deepseek.model },
          },
          {
            profileId: grokXhigh.id,
            family: "grok",
            enabled: "yes",
            boundModel: { provider: "omp", model: grokXhigh.model },
          },
        ],
        taskOrder: { coding: "not-an-array", testing: [7, deepseek.id] },
        profileBudget: { [deepseek.id]: 5 },
      },
      allProfiles,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pool).toEqual([
      { profileId: deepseek.id, family: "deepseek", enabled: true },
      { profileId: grokXhigh.id, family: "grok", enabled: true },
    ]);
    expect(result.issues).toMatchObject([
      { code: "MODE_POOL_CONFIG_INVALID", params: { field: "pool", index: 0, reason: "entry" } },
      { code: "MODE_POOL_CONFIG_INVALID", params: { field: "pool", index: 1, reason: "entry" } },
      {
        code: "MODE_POOL_CONFIG_INVALID",
        params: { field: "pool", index: 3, reason: "enabled" },
      },
      {
        code: "MODE_POOL_CONFIG_INVALID",
        params: { field: "taskOrder", kind: "coding", reason: "shape" },
      },
      {
        code: "MODE_POOL_CONFIG_INVALID",
        params: { field: "taskOrder", kind: "testing", index: 0, reason: "entry" },
      },
      {
        code: "MODE_POOL_CONFIG_INVALID",
        params: { field: "profileBudget", profileId: deepseek.id, value: 5 },
      },
    ]);
  });

  test("a malformed economy block is a warning; over-limit read-only config is reported once", () => {
    expect(normalizeEconomyPolicy({ pool: "nope" }, allProfiles)).toEqual({
      ok: true,
      value: { pool: [], taskOrder: {}, profileBudget: {} },
      issues: [
        {
          code: "MODE_POOL_CONFIG_INVALID",
          severity: "warning",
          params: { field: "pool", reason: "shape" },
        },
      ],
    });
    const ids = Array.from({ length: 33 }, (_, index) => `profile-${index}`);
    const large = normalize(
      ids.map((profileId) => ({ profileId })),
      { coding: ids },
    );
    expect(large.value.pool).toHaveLength(33);
    expect(
      (large.issues ?? []).filter((issue) => issue.code === "MODE_POOL_CONFIG_INVALID"),
    ).toMatchObject([
      { params: { field: "pool", count: 33, limit: 32 } },
      { params: { field: "taskOrder", kind: "coding", count: 33, limit: 32 } },
    ]);
  });
});

describe("resolveModeProfile", () => {
  test("decision, retain, coordinator, and escalation seats keep their original binding in every mode", () => {
    for (const mode of ["sota", "economy", "collaborative"] as const) {
      for (const roleId of ["lead-tech", "qa-review", "research-web", "eng-expert"]) {
        const result = resolve(roleId, mode);
        expect(result.ok, `${mode}/${roleId}`).toBe(true);
        if (!result.ok) continue;
        expectAvailable(result.value);
        expect(result.value.profile.id, `${mode}/${roleId}`).toBe(claude.id);
        expect(result.value.source).toBe("role-preferred");
        expect(result.value.budget).toBe("unknown");
        expect(result.value.budgetBasis).toBe("conservative-default");
        // The expert is only planned as standby outside SOTA; other seats are always active.
        expect(result.value.standby, `${mode}/${roleId}`).toBe(
          roleId === "eng-expert" && mode !== "sota",
        );
      }
      const coordinator = resolve("eng-fullstack", mode, { kind: "coordinator" });
      expect(coordinator.ok).toBe(true);
      if (coordinator.ok) {
        expectAvailable(coordinator.value);
        expect(coordinator.value.profile.id).toBe(claude.id);
        expect(coordinator.value.standby).toBe(false);
      }
    }

    // Only execution seats move; the escalation expert stays on its SOTA Profile as standby.
    const economyExecution = resolve("eng-fullstack", "economy");
    expect(economyExecution.ok).toBe(true);
    if (economyExecution.ok) {
      expectAvailable(economyExecution.value);
      expect(economyExecution.value.profile.id).toBe(deepseek.id);
      expect(economyExecution.value.standby).toBe(false);
    }
    const economyExpert = resolve("eng-expert", "economy");
    expect(economyExpert.ok).toBe(true);
    if (economyExpert.ok) {
      expectAvailable(economyExpert.value);
      expect(economyExpert.value.profile.id).toBe(claude.id);
      expect(economyExpert.value.standby).toBe(true);
      expect(economyExpert.value.unavailable).toBe(false);
    }
  });

  test("task order picks DeepSeek for coding/testing/acceptance/codebase and Grok for ops", () => {
    for (const roleId of ["eng-fullstack", "qa-test", "qa-acceptance", "research-codebase"]) {
      const result = resolve(roleId, "economy");
      expect(result.ok, roleId).toBe(true);
      if (result.ok) {
        expectAvailable(result.value);
        expect(result.value.profile.id, roleId).toBe(deepseek.id);
        expect(result.value.source).toBe("economy-pool");
        expect(result.value.budget).toBe("economy");
        expect(result.value.budgetBasis).toBe("pool");
        expect(result.value.family).toBe("deepseek");
      }
    }
    const ops = resolve("eng-ops", "economy");
    expect(ops.ok).toBe(true);
    if (ops.ok) {
      expectAvailable(ops.value);
      expect(ops.value.profile.id).toBe(grokXhigh.id);
      expect(ops.value.family).toBe("grok");
    }
  });

  test("a disabled first choice falls through the remaining order without dropping either Fast Profile", () => {
    const noDeepseek = normalize(entries({ [deepseek.id]: false })).value;
    expect(resolve("eng-fullstack", "economy", { economy: noDeepseek })).toMatchObject({
      ok: true,
      value: { profile: { id: grokXhigh.id } },
    });
    const noGrokXhigh = normalize(entries({ [grokXhigh.id]: false })).value;
    expect(resolve("eng-ops", "economy", { economy: noGrokXhigh })).toMatchObject({
      ok: true,
      value: { profile: { id: grokXhighFast.id } },
    });

    const fastOnly = normalize(entries({ [deepseek.id]: false, [grokXhigh.id]: false })).value;
    expect(resolve("eng-fullstack", "economy", { economy: fastOnly })).toMatchObject({
      ok: true,
      value: { profile: { id: grokXhighFast.id } },
    });

    const oldestFast = normalize(
      entries({ [deepseek.id]: false, [grokXhigh.id]: false, [grokXhighFast.id]: false }),
    ).value;
    expect(resolve("eng-fullstack", "economy", { economy: oldestFast })).toMatchObject({
      ok: true,
      value: { profile: { id: grok46Fast.id } },
    });
  });

  test("an empty pool, all-missing entries, and an unavailable provider each fall back to the original binding", () => {
    const empty = normalizeEconomyPolicy({}, allProfiles);
    if (!empty.ok) throw new Error("unexpected failure");
    const emptyResult = resolve("eng-fullstack", "economy", { economy: empty.value });
    expect(emptyResult).toMatchObject({
      ok: true,
      value: { profile: { id: claude.id } },
    });
    if (emptyResult.ok) {
      expect(
        emptyResult.issues?.some(
          (issue) => issue.code === "MODE_POOL_EMPTY" && issue.severity === "warning",
        ),
      ).toBe(true);
      expect(emptyResult.value.source).toBe("role-preferred");
    }

    const missing = normalize([
      { profileId: "profile-missing-1", family: "deepseek", enabled: true },
      { profileId: "profile-missing-2", family: "grok", enabled: true },
    ]);
    const missingResult = resolve("eng-fullstack", "economy", { economy: missing.value });
    expect(missingResult).toMatchObject({ ok: true, value: { profile: { id: claude.id } } });
    if (missingResult.ok) {
      expect(missingResult.issues).toMatchObject([
        { code: "MODE_POOL_UNAVAILABLE", params: { missing: 2 } },
      ]);
    }

    const ompDown = available.map((entry) =>
      entry.provider === "omp" ? { ...entry, available: false, reason: "offline" } : entry,
    );
    const downResult = resolve("eng-fullstack", "economy", { availability: ompDown });
    expect(downResult).toMatchObject({ ok: true, value: { profile: { id: claude.id } } });
    if (downResult.ok) {
      expect(downResult.issues).toMatchObject([
        {
          code: "MODE_POOL_UNAVAILABLE",
          params: { unavailable: 4, provider: "omp" },
        },
      ]);
    }
  });

  test("a missing availability row is unverified for the pool but keeps the legacy original binding", () => {
    const result = resolve("eng-fullstack", "economy", { availability: [] });
    expect(result).toMatchObject({ ok: true, value: { profile: { id: claude.id } } });
    if (result.ok) {
      expect(result.issues).toMatchObject([
        { code: "MODE_POOL_UNAVAILABLE", params: { unverified: 4 } },
      ]);
    }
  });

  test("the original binding failing is the only economy blocker", () => {
    const allDown = available.map((entry) => ({ ...entry, available: false }));
    const result = resolve("eng-fullstack", "economy", { availability: allDown });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toMatchObject([
        { code: "MODE_POOL_UNAVAILABLE", severity: "warning" },
        {
          code: "MODE_PROFILE_UNRESOLVED",
          severity: "blocker",
          roleId: "eng-fullstack",
          params: { reason: "provider-unavailable" },
        },
      ]);
    }
  });

  test("an unverified availability query blocks new modes but keeps legacy SOTA", () => {
    const unverified: HostSnapshot = {
      status: "ready",
      profiles: allProfiles,
      availability: [],
      availabilityUnverified: true,
    };
    const economy = resolve("eng-fullstack", "economy", { host: unverified });
    expect(economy.ok).toBe(false);
    if (!economy.ok) {
      expect(economy.issues).toEqual([
        {
          code: "MODE_CONTEXT_UNAVAILABLE",
          severity: "blocker",
          params: { reason: "availability-unverified", mode: "economy" },
        },
      ]);
    }

    const sota = resolve("eng-fullstack", "sota", { host: unverified });
    expect(sota).toMatchObject({
      ok: true,
      value: { profile: { id: claude.id }, source: "role-preferred" },
    });

    const collaboration = selectCollaborationProfiles({
      role: roleOf("eng-fullstack"),
      host: unverified,
      economy: policy,
      requestedReplicas: 2,
    });
    expect(collaboration.ok).toBe(false);
    if (!collaboration.ok) {
      expect(collaboration.issues).toContainEqual(
        expect.objectContaining({
          code: "MODE_CONTEXT_UNAVAILABLE",
          params: expect.objectContaining({ reason: "availability-unverified" }),
        }),
      );
    }
  });

  test("a failed Profile/availability query is a context blocker, never an empty pool or a selection", () => {
    const host: HostSnapshot = { status: "unavailable", reason: "query failed" };
    for (const mode of ["sota", "economy", "collaborative"] as const) {
      const result = resolve("eng-fullstack", mode, { host });
      expect(result.ok, mode).toBe(false);
      if (!result.ok) {
        expect(result.issues).toEqual([
          {
            code: "MODE_CONTEXT_UNAVAILABLE",
            severity: "blocker",
            params: { reason: "query failed" },
          },
        ]);
      }
    }
    const collaboration = selectCollaborationProfiles({
      role: roleOf("eng-fullstack"),
      host,
      economy: policy,
      requestedReplicas: 2,
    });
    expect(collaboration).toMatchObject({
      ok: false,
      issues: [{ code: "MODE_CONTEXT_UNAVAILABLE", severity: "blocker" }],
    });
  });

  test("budgets come from the host label, never from Profile notes", () => {
    const labeled = normalize(entries(), taskOrder, { [claude.id]: "sota" }).value;
    const sotaSeat = resolve("research-web", "economy", { economy: labeled });
    expect(sotaSeat).toMatchObject({
      ok: true,
      value: { budget: "sota", budgetBasis: "host" },
    });
    const unknownLabel = normalize(entries(), taskOrder, { [claude.id]: "unknown" }).value;
    expect(resolve("research-web", "economy", { economy: unknownLabel })).toMatchObject({
      ok: true,
      value: { budget: "unknown", budgetBasis: "host" },
    });
    expect(resolve("research-web", "economy")).toMatchObject({
      ok: true,
      value: { budget: "unknown", budgetBasis: "conservative-default" },
    });
    // A pool Profile stays economy even if a stored label tried to make it SOTA.
    const invalidLabel = normalize(entries(), taskOrder, { [deepseek.id]: "sota" }).value;
    expect(resolve("eng-fullstack", "economy", { economy: invalidLabel })).toMatchObject({
      ok: true,
      value: { budget: "economy", budgetBasis: "pool" },
    });
  });

  test("a coordinator's ignored tier is surfaced as a warning, not a blocker", () => {
    const result = resolveModeProfile({
      mode: "sota",
      role: roleOf("eng-fullstack", { executionPolicy: { tier: "economy" } }),
      kind: "coordinator",
      host: { status: "ready", profiles: allProfiles, availability: available },
      economy: policy,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectAvailable(result.value);
    expect(result.value.profile.id).toBe(claude.id);
    expect(result.value.issues).toMatchObject([
      {
        code: "MODE_ROLE_POLICY_UNKNOWN",
        severity: "warning",
        roleId: "eng-fullstack",
        params: { field: "tier", value: "economy" },
      },
    ]);
    expect(result.issues).toEqual(result.value.issues);
  });

  test("excluded Profiles are skipped, and excluding the whole pool falls back", () => {
    expect(
      resolve("eng-fullstack", "economy", {
        excludedProfileIds: new Set([deepseek.id]),
      }),
    ).toMatchObject({ ok: true, value: { profile: { id: grokXhigh.id } } });

    const noneLeft = resolve("eng-fullstack", "economy", {
      excludedProfileIds: new Set(poolIds),
    });
    expect(noneLeft).toMatchObject({ ok: true, value: { profile: { id: claude.id } } });
    if (noneLeft.ok) {
      expect(noneLeft.issues).toMatchObject([
        { code: "MODE_POOL_UNAVAILABLE", params: { excluded: 4 } },
      ]);
    }
  });

  test("an original binding that sits in the pool is billed as pool budget", () => {
    const result = resolveModeProfile({
      mode: "economy",
      role: roleOf("research-web", {
        preferredProfiles: [{ profileId: deepseek.id, nameSnapshot: deepseek.name }],
      }),
      kind: "member",
      host: { status: "ready", profiles: allProfiles, availability: available },
      economy: policy,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        profile: { id: deepseek.id },
        source: "role-preferred",
        budget: "economy",
        budgetBasis: "pool",
        standby: false,
      },
    });
  });

  test("excluded Profiles also apply to the original binding, with a clear all-excluded issue", () => {
    const blocked = resolve("lead-tech", "sota", {
      excludedProfileIds: new Set([claude.id]),
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.issues).toMatchObject([
        {
          code: "MODE_PROFILE_UNRESOLVED",
          severity: "blocker",
          roleId: "lead-tech",
          params: { reason: "all-excluded" },
        },
      ]);
    }

    const withFallback = roleOf("lead-tech", {
      fallbackProfiles: [{ profileId: gpt.id, nameSnapshot: gpt.name }],
    });
    const partial = resolveModeProfile({
      mode: "sota",
      role: withFallback,
      kind: "member",
      host: { status: "ready", profiles: allProfiles, availability: available },
      economy: policy,
      excludedProfileIds: new Set([claude.id]),
    });
    expect(partial).toMatchObject({
      ok: true,
      value: { profile: { id: gpt.id }, source: "role-fallback", standby: false },
    });
  });

  test("an excluded escalation channel is an unavailable standby, not a blocker", () => {
    const result = resolve("eng-expert", "economy", {
      excludedProfileIds: new Set([claude.id]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectUnavailable(result.value);
    expect(result.value.profile).toBeNull();
    expect(result.value.source).toBe("unavailable");
    expect(result.value.standby).toBe(true);
    expect(result.issues).toMatchObject([
      {
        code: "MODE_ESCALATION_UNAVAILABLE",
        severity: "warning",
        params: { reason: "all-excluded" },
      },
    ]);
  });

  test("a disabled Role is a blocker, and unavailable escalation is a marked standby", () => {
    const disabledRole = resolveModeProfile({
      mode: "sota",
      role: roleOf("eng-fullstack", { enabled: false }),
      kind: "member",
      host: { status: "ready", profiles: allProfiles, availability: available },
      economy: policy,
    });
    expect(disabledRole).toEqual({
      ok: false,
      issues: [
        { code: "MODE_ROLE_DISABLED", severity: "blocker", roleId: "eng-fullstack", params: {} },
      ],
    });

    const allDown = available.map((entry) => ({ ...entry, available: false }));
    const standby = resolve("eng-expert", "economy", { availability: allDown });
    expect(standby.ok).toBe(true);
    if (!standby.ok) return;
    expectUnavailable(standby.value);
    expect(standby.value.profile).toBeNull();
    expect(standby.value.source).toBe("unavailable");
    expect(standby.value.standby).toBe(true);
    expect(standby.value.budget).toBe("unknown");
    expect(standby.value.budgetBasis).toBe("conservative-default");
    expect(standby.issues).toMatchObject([
      {
        code: "MODE_ESCALATION_UNAVAILABLE",
        severity: "warning",
        params: { reason: "provider-unavailable" },
      },
    ]);
  });
});

describe("selectCollaborationProfiles", () => {
  const collaboration = (
    requestedReplicas: 2 | 3,
    economy = policy,
    availability = available,
    excludedProfileIds?: ReadonlySet<string>,
  ) =>
    selectCollaborationProfiles({
      role: roleOf("eng-fullstack"),
      host: { status: "ready", profiles: allProfiles, availability },
      economy,
      requestedReplicas,
      excludedProfileIds,
    });

  test("three Grok versions plus DeepSeek form two families, and a three-way request reduces to two", () => {
    const result = collaboration(3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.effectiveReplicas).toBe(2);
    expect(profileIds(result.value.selections)).toEqual([deepseek.id, grokXhigh.id]);
    expect(result.value.selections.map((selection) => selection.family)).toEqual([
      "deepseek",
      "grok",
    ]);
    expect(result.value.issues).toMatchObject([
      { code: "MODE_FAMILIES_REDUCED", params: { requested: 3, families: 2 } },
    ]);
    // Family is independent of provider: both paths run on omp.
    expect(
      result.value.selections.map((selection) => {
        expectAvailable(selection);
        return selection.profile.provider;
      }),
    ).toEqual(["omp", "omp"]);
    expect(result.value.selections.every((selection) => selection.budgetBasis === "pool")).toBe(
      true,
    );
    // Same-family later versions are returned as failure alternates, not extra paths.
    expect(result.value.selections[0].alternates).toEqual([]);
    expect(result.value.selections[1].alternates).toEqual([grokXhighFast.id, grok46Fast.id]);
    expect(result.value.selections.every((selection) => !selection.standby)).toBe(true);
  });

  test("two-way requests use two families without a reduction warning", () => {
    const result = collaboration(2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.effectiveReplicas).toBe(2);
      expect(result.value.selections).toHaveLength(2);
      expect(result.value.issues).toEqual([]);
    }
  });

  test("one family is not collaboration: the original binding is used and marked", () => {
    const onlyDeepseek = normalize([entries()[0]]).value;
    const result = collaboration(2, onlyDeepseek);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.effectiveReplicas).toBe(1);
    expect(result.value.selections).toMatchObject([
      { profile: { id: claude.id }, source: "role-preferred" },
    ]);
    expect(result.value.issues).toMatchObject([
      { code: "MODE_COLLAB_UNAVAILABLE", params: { families: 1, requested: 2 } },
    ]);
  });

  test("an unverified family does not count as an extra path", () => {
    const unverified = normalize([
      entries()[0],
      {
        profileId: gemini.id,
        family: "gemini",
        enabled: true,
        // No boundModel: the saved family cannot be trusted after the Profile may have changed.
      },
    ]);
    expect(unverified.issues).toMatchObject([
      {
        code: "MODE_FAMILY_MISSING",
        params: { profileId: gemini.id, reason: "bound-model-missing" },
      },
    ]);
    const result = collaboration(2, unverified.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.effectiveReplicas).toBe(1);
    expect(firstAvailable(result.value.selections).profile.id).toBe(claude.id);
    expect(result.value.issues).toMatchObject([
      { code: "MODE_COLLAB_UNAVAILABLE", params: { families: 1, requested: 2 } },
    ]);
  });

  test("a repeated Profile cannot be counted twice, and taskOrder outside the pool is ignored", () => {
    const duplicated: EconomyPolicy = {
      pool: [
        { profileId: deepseek.id, family: "deepseek", enabled: true },
        { profileId: deepseek.id, family: "deepseek-alt", enabled: true },
      ],
      taskOrder: { coding: [gpt.id, deepseek.id] },
      profileBudget: {},
    };
    const result = selectCollaborationProfiles({
      role: roleOf("eng-fullstack"),
      host: { status: "ready", profiles: allProfiles, availability: available },
      economy: duplicated,
      requestedReplicas: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.effectiveReplicas).toBe(1);
    expect(firstAvailable(result.value.selections).profile.id).toBe(claude.id);

    // The ordering hint is honored for an in-pool id and cannot introduce the out-of-pool GPT.
    const reordered = selectCollaborationProfiles({
      role: roleOf("eng-fullstack"),
      host: { status: "ready", profiles: allProfiles, availability: available },
      economy: {
        pool: [
          { profileId: grokXhigh.id, family: "grok", enabled: true },
          { profileId: deepseek.id, family: "deepseek", enabled: true },
        ],
        taskOrder: { coding: [gpt.id, deepseek.id] },
        profileBudget: {},
      },
      requestedReplicas: 2,
    });
    expect(reordered.ok).toBe(true);
    if (reordered.ok) {
      expect(profileIds(reordered.value.selections)).toEqual([deepseek.id, grokXhigh.id]);
    }
  });

  test("an empty pool reports both the empty pool and the missing collaboration, then falls back", () => {
    const result = collaboration(2, { pool: [], taskOrder: {}, profileBudget: {} });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.effectiveReplicas).toBe(1);
      expect(result.value.issues.map((issue) => issue.code)).toEqual([
        "MODE_POOL_EMPTY",
        "MODE_COLLAB_UNAVAILABLE",
      ]);
    }
  });

  test("unverified availability blocks every family and reports the counts", () => {
    const result = collaboration(2, policy, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.effectiveReplicas).toBe(1);
    // The original binding keeps the legacy missing-availability behavior.
    expect(firstAvailable(result.value.selections).profile.id).toBe(claude.id);
    expect(result.value.issues).toMatchObject([
      {
        code: "MODE_POOL_UNAVAILABLE",
        params: {
          pool: 4,
          disabled: 0,
          missing: 0,
          unavailable: 0,
          unverified: 4,
          withoutFamily: 0,
        },
      },
      { code: "MODE_COLLAB_UNAVAILABLE", params: { families: 0, requested: 2 } },
    ]);
  });

  test("disabled, missing, family-less, and unavailable candidates are each counted once", () => {
    const mixed = normalize([
      { ...entries()[1], enabled: false },
      { profileId: "profile-missing", family: "deepseek", enabled: true },
      entries()[0],
      { profileId: gemini.id, family: "gemini", enabled: true },
    ]);
    const ompDown = available.map((entry) =>
      entry.provider === "omp" ? { ...entry, available: false } : entry,
    );
    const result = collaboration(2, mixed.value, ompDown);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.effectiveReplicas).toBe(1);
    expect(firstAvailable(result.value.selections).profile.id).toBe(claude.id);
    expect(result.value.issues).toMatchObject([
      {
        code: "MODE_POOL_UNAVAILABLE",
        params: {
          pool: 4,
          disabled: 1,
          missing: 1,
          unavailable: 1,
          unverified: 0,
          withoutFamily: 1,
        },
      },
      { code: "MODE_COLLAB_UNAVAILABLE", params: { families: 0, requested: 2 } },
    ]);
  });

  test("decision and retain Roles never form an economy cohort", () => {
    const result = selectCollaborationProfiles({
      role: roleOf("research-web"),
      host: { status: "ready", profiles: allProfiles, availability: available },
      economy: policy,
      requestedReplicas: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.effectiveReplicas).toBe(1);
    expect(result.value.selections).toMatchObject([
      { profile: { id: claude.id }, source: "role-preferred" },
    ]);
    expect(result.value.issues).toMatchObject([
      { code: "MODE_NO_EXECUTION_COHORT", severity: "warning" },
    ]);
  });

  test("collaboration honors exclusions in candidates and in the fallback", () => {
    const onlyGrok = collaboration(
      2,
      policy,
      available,
      new Set([deepseek.id, grokXhighFast.id, grok46Fast.id]),
    );
    expect(onlyGrok.ok).toBe(true);
    if (!onlyGrok.ok) return;
    expect(onlyGrok.value.effectiveReplicas).toBe(1);
    expect(firstAvailable(onlyGrok.value.selections).profile.id).toBe(claude.id);

    const noneLeft = collaboration(2, policy, available, new Set([...poolIds, claude.id]));
    expect(noneLeft.ok).toBe(false);
    if (!noneLeft.ok) {
      expect(noneLeft.issues).toMatchObject([
        { code: "MODE_POOL_UNAVAILABLE", params: { excluded: 4 } },
        { code: "MODE_COLLAB_UNAVAILABLE", params: { families: 0 } },
        {
          code: "MODE_PROFILE_UNRESOLVED",
          severity: "blocker",
          params: { reason: "all-excluded" },
        },
      ]);
    }
  });

  test("a disabled Role cannot form a collaborative cohort", () => {
    const result = selectCollaborationProfiles({
      role: roleOf("eng-fullstack", { enabled: false }),
      host: { status: "ready", profiles: allProfiles, availability: available },
      economy: policy,
      requestedReplicas: 2,
    });
    expect(result).toEqual({
      ok: false,
      issues: [
        { code: "MODE_ROLE_DISABLED", severity: "blocker", roleId: "eng-fullstack", params: {} },
      ],
    });
  });

  test("an escalation Role in a cohort call is returned as standby", () => {
    const result = selectCollaborationProfiles({
      role: roleOf("eng-expert"),
      host: { status: "ready", profiles: allProfiles, availability: available },
      economy: policy,
      requestedReplicas: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.effectiveReplicas).toBe(1);
    const first = firstAvailable(result.value.selections);
    expect(first.profile.id).toBe(claude.id);
    expect(first.source).toBe("role-preferred");
    expect(first.standby).toBe(true);
    expect(first.unavailable).toBe(false);
    expect(result.value.issues).toMatchObject([
      { code: "MODE_NO_EXECUTION_COHORT", severity: "warning" },
    ]);
  });

  test("a single-family fallback whose original binding also fails is a blocker", () => {
    const onlyDeepseek = normalize([entries()[0]]).value;
    const claudeDown = available.map((entry) =>
      entry.provider === "claude" ? { ...entry, available: false } : entry,
    );
    const result = collaboration(2, onlyDeepseek, claudeDown);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toMatchObject([
        { code: "MODE_COLLAB_UNAVAILABLE", severity: "warning" },
        {
          code: "MODE_PROFILE_UNRESOLVED",
          severity: "blocker",
          params: { reason: "provider-unavailable" },
        },
      ]);
    }
  });
});

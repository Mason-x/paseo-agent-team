import { describe, expect, test } from "vitest";
import {
  addPoolEntry,
  applySuggestedPool,
  buildStoredEconomy,
  DEFAULT_MAX_MEMBERS,
  decideEconomySave,
  draftFromStored,
  effectiveTaskOrder,
  familyIsInvalid,
  familyNeedsRebind,
  MAX_MAX_MEMBERS,
  mergeEconomyPreferences,
  movePoolEntry,
  moveTaskOrder,
  needsLiveProfilesForSave,
  normalizeFamily,
  preselectSuggestedPool,
  rebindPoolFamily,
  removePoolEntry,
  removeProfileBudget,
  resetTaskOrder,
  resolveMaxMembersForSave,
  setPoolEnabled,
  setPoolFamily,
  setProfileBudget,
} from "../client/settings/economy-pool";
import type { PaseoProfile } from "../shared/paseo/adapter";
import { PreferencesSchema } from "../shared/schemas/preferences";
import { NOW } from "./fixtures";

const profiles: PaseoProfile[] = [
  {
    id: "p-deepseek",
    name: "DeepSeek-V4.1-Flash-Max",
    provider: "omp",
    model: "deepseek-v4",
  },
  { id: "p-grok", name: "Grok-4.7-Xhigh", provider: "omp", model: "grok-4.7" },
  { id: "p-grok-fast", name: "Grok-4.7-Xhigh-Fast", provider: "omp", model: "grok-4.7-fast" },
  { id: "p-grok-old", name: "Grok-4.6-High-Fast", provider: "omp", model: "grok-4.6" },
  { id: "p-other", name: "Other", provider: "claude", model: "opus" },
];

const base = draftFromStored(undefined);

describe("family normalization", () => {
  test("trims and lowercases a valid family", () => {
    expect(normalizeFamily("  Grok-4.7 ")).toBe("grok-4.7");
    expect(familyIsInvalid("  Grok-4.7 ")).toBe(false);
  });

  test("rejects spaces and empty input", () => {
    expect(normalizeFamily("")).toBe("");
    expect(normalizeFamily("grok family")).toBe("");
    expect(familyIsInvalid("grok family")).toBe(true);
    expect(familyIsInvalid("   ")).toBe(false);
  });
});

describe("pool editing", () => {
  test("deduplicates and moves entries", () => {
    const once = addPoolEntry(base, "p-grok");
    expect(addPoolEntry(once, "p-grok")).toBe(once);
    const two = addPoolEntry(once, "p-deepseek");
    expect(two.pool.map((entry) => entry.profileId)).toEqual(["p-grok", "p-deepseek"]);
    expect(movePoolEntry(two, 0, 1).pool.map((entry) => entry.profileId)).toEqual([
      "p-deepseek",
      "p-grok",
    ]);
  });

  test("family and enabled changes stay per entry", () => {
    const draft = setPoolEnabled(
      setPoolFamily(addPoolEntry(base, "p-grok"), "p-grok", "Grok"),
      "p-grok",
      false,
    );
    expect(draft.pool[0]).toMatchObject({
      profileId: "p-grok",
      family: "Grok",
      familyTouched: true,
      enabled: false,
    });
  });

  test("removing an entry also removes it from task orders and budgets", () => {
    let draft = addPoolEntry(addPoolEntry(base, "p-grok"), "p-deepseek");
    draft = { ...draft, taskOrder: { coding: ["p-grok", "p-deepseek"] } };
    const next = removePoolEntry(draft, "p-grok");
    expect(next.pool.map((entry) => entry.profileId)).toEqual(["p-deepseek"]);
    expect(next.taskOrder.coding).toEqual(["p-deepseek"]);
    expect(next.removed).toContain("p-grok");
  });

  test("stored task order deduplicates ids and drops entries outside the pool", () => {
    const draft = draftFromStored({
      pool: [{ profileId: "p-grok" }],
      taskOrder: { coding: ["p-grok", "p-grok", "p-other"] },
    });
    expect(draft.taskOrder.coding).toEqual(["p-grok"]);
  });

  test("task order starts from the pool and can be reset", () => {
    const draft = addPoolEntry(addPoolEntry(base, "p-grok"), "p-deepseek");
    expect(effectiveTaskOrder(draft, "coding")).toEqual(["p-grok", "p-deepseek"]);
    const moved = moveTaskOrder(draft, "coding", 1, -1);
    expect(effectiveTaskOrder(moved, "coding")).toEqual(["p-deepseek", "p-grok"]);
    expect(effectiveTaskOrder(resetTaskOrder(moved, "coding"), "coding")).toEqual([
      "p-grok",
      "p-deepseek",
    ]);
  });

  test("a pool Profile cannot also be budget-labelled", () => {
    const draft = setProfileBudget(addPoolEntry(base, "p-grok"), "p-grok", "sota");
    expect(draft.profileBudget).toEqual({});
    const labelled = setProfileBudget(base, "p-other", "sota");
    expect(labelled.profileBudget).toEqual({ "p-other": "sota" });
    expect(removeProfileBudget(labelled, "p-other").profileBudget).toEqual({});
  });
});

describe("local suggestions", () => {
  test("maps unique omp names to real Profile ids and skips missing or ambiguous names", () => {
    const grok = profiles[1];
    if (!grok) throw new Error("fixture missing");
    const duplicated = [...profiles, { ...grok, id: "p-grok-2" }];
    const suggestions = [
      { name: "deepseek-v4.1-flash-max", family: "deepseek" },
      { name: "Grok-4.7-Xhigh", family: "grok" },
      { name: "Missing", family: "other" },
    ];
    expect(
      preselectSuggestedPool(profiles, suggestions).map(({ profileId, family }) => ({
        profileId,
        family,
      })),
    ).toEqual([
      { profileId: "p-deepseek", family: "deepseek" },
      { profileId: "p-grok", family: "grok" },
    ]);
    expect(preselectSuggestedPool(duplicated, suggestions).map((entry) => entry.profileId)).toEqual(
      ["p-deepseek"],
    );
  });

  test("rejects a same-named Profile from a non-omp provider", () => {
    const entries = preselectSuggestedPool(
      [{ id: "p-claude", name: "Grok-4.7-Xhigh", provider: "claude", model: "x" }],
      [{ name: "Grok-4.7-Xhigh", family: "grok" }],
    );
    expect(entries).toEqual([]);
  });

  test("applying suggestions never removes existing entries and clears their labels", () => {
    let draft = addPoolEntry(base, "p-other");
    draft = setProfileBudget(draft, "p-grok", "sota");
    const next = applySuggestedPool(draft, profiles);
    expect(next.pool.map((entry) => entry.profileId)).toEqual([
      "p-other",
      "p-deepseek",
      "p-grok",
      "p-grok-fast",
      "p-grok-old",
    ]);
    expect(next.profileBudget["p-grok"]).toBeUndefined();
  });
});

describe("maxMembers", () => {
  test("accepts 1–64 for an edited value", () => {
    expect(DEFAULT_MAX_MEMBERS).toBe(24);
    expect(MAX_MAX_MEMBERS).toBe(64);
    expect(resolveMaxMembersForSave("24", 8, 8)).toEqual({ ok: true, value: 24, write: true });
    expect(resolveMaxMembersForSave("65", 8, 8)).toEqual({ ok: false });
    expect(resolveMaxMembersForSave("2.5", 8, 8)).toEqual({ ok: false });
  });

  test("an untouched legacy value is preserved and not validated", () => {
    expect(resolveMaxMembersForSave("100", 100, 100)).toEqual({
      ok: true,
      value: 100,
      write: false,
    });
    expect(resolveMaxMembersForSave("100", 100, 120)).toEqual({
      ok: true,
      value: 120,
      write: false,
    });
  });
});

describe("bound model preservation", () => {
  const raw = {
    pool: [
      {
        profileId: "p-grok",
        family: "grok",
        boundModel: { provider: "omp", model: "old-model" },
      },
    ],
  };

  test("untouched entries keep their old boundModel even when the live Profile changed", () => {
    const draft = draftFromStored(raw);
    const entry = draft.pool[0];
    if (!entry) throw new Error("fixture missing");
    expect(familyNeedsRebind(entry, profiles[1])).toBe(true);
    const stored = buildStoredEconomy(raw, draft, profiles);
    expect(stored.pool?.[0]).toMatchObject({
      family: "grok",
      boundModel: { provider: "omp", model: "old-model" },
    });
  });

  test("editing the family or explicitly rebinding writes the live tuple", () => {
    const edited = setPoolFamily(draftFromStored(raw), "p-grok", "grok");
    expect(buildStoredEconomy(raw, edited, profiles).pool?.[0]).toMatchObject({
      boundModel: { provider: "omp", model: "grok-4.7" },
    });
    const rebound = rebindPoolFamily(draftFromStored(raw), "p-grok");
    expect(buildStoredEconomy(raw, rebound, profiles).pool?.[0]).toMatchObject({
      boundModel: { provider: "omp", model: "grok-4.7" },
    });
  });

  test("a new family without a saved boundModel adopts the live tuple", () => {
    const draft = addPoolEntry(base, "p-grok", "grok");
    expect(buildStoredEconomy(undefined, draft, profiles).pool?.[0]).toMatchObject({
      boundModel: { provider: "omp", model: "grok-4.7" },
    });
  });

  test("family validation blocks only new or edited bindings when the live Profile is unavailable", () => {
    expect(needsLiveProfilesForSave(addPoolEntry(base, "p-grok", "grok"), [])).toBe(true);
    expect(needsLiveProfilesForSave(draftFromStored(raw), [])).toBe(false);
    const unboundLegacy = draftFromStored({
      pool: [{ profileId: "p-grok", family: "grok" }],
    });
    expect(needsLiveProfilesForSave(unboundLegacy, [])).toBe(false);
    expect(needsLiveProfilesForSave(setPoolFamily(unboundLegacy, "p-grok", "grok"), [])).toBe(true);
  });
});

describe("unreadable stored data", () => {
  test("unknown entries, duplicates, invalid budgets, and invalid families survive an untouched save", () => {
    const raw = {
      pool: [
        { profileId: "p-grok", family: "Bad Fam!", boundModel: { provider: "omp", model: "x" } },
        { profileRef: "future" },
        { profileId: "p-grok", family: "second" },
      ],
      profileBudget: { p9: "premium", "p-other": "sota" },
    };
    const draft = draftFromStored(raw);
    const stored = buildStoredEconomy(raw, draft, profiles);
    expect(stored.pool).toHaveLength(3);
    expect(stored.pool?.[0]).toMatchObject({
      profileId: "p-grok",
      family: "Bad Fam!",
      boundModel: { provider: "omp", model: "x" },
    });
    expect(stored.pool?.[1]).toEqual({ profileRef: "future" });
    expect(stored.pool?.[2]).toEqual({ profileId: "p-grok", family: "second" });
    expect(stored.profileBudget).toEqual({ p9: "premium", "p-other": "sota" });
  });
});

describe("preferences merge", () => {
  test("keeps every other host field while writing economy and an edited maxMembers", () => {
    const current = PreferencesSchema.parse({
      maxMembers: 8,
      recentRuns: [
        {
          runId: "run-1",
          teamId: "team",
          teamName: "Team",
          workspaceId: "ws",
          coordinatorAgentId: "agent",
          memberAgentIds: [],
          taskExcerpt: "task",
          createdAt: NOW,
        },
      ],
      templatesImportedAt: NOW,
      defaultPresets: { catalogRevision: "cat", seenRoleIds: ["qa-test"] },
      designerProfile: "designer",
    });
    const draft = {
      ...addPoolEntry(base, "p-grok", "grok"),
      taskOrder: { coding: ["p-grok"] },
      profileBudget: { "p-other": "sota" as const },
    };
    const next = mergeEconomyPreferences(current, draft, profiles, { maxMembers: 30 });
    expect(next.maxMembers).toBe(30);
    expect(next.recentRuns).toEqual(current.recentRuns);
    expect(next.templatesImportedAt).toBe(NOW);
    expect(next.defaultPresets).toEqual(current.defaultPresets);
    expect((next as Record<string, unknown>).designerProfile).toBe("designer");
    expect(next.economy?.pool).toEqual([
      expect.objectContaining({
        profileId: "p-grok",
        family: "grok",
        boundModel: { provider: "omp", model: "grok-4.7" },
        nameSnapshot: "Grok-4.7-Xhigh",
      }),
    ]);
  });

  test("omitting maxMembers leaves the latest value", () => {
    const current = PreferencesSchema.parse({ maxMembers: 100 });
    const next = mergeEconomyPreferences(current, base, profiles);
    expect(next.maxMembers).toBe(100);
  });
});

describe("save conflict and overwrite", () => {
  const latest = PreferencesSchema.parse({
    maxMembers: 12,
    recentRuns: [],
    economy: {
      pool: [{ profileId: "p-grok", family: "grok" }],
      taskOrder: {},
      profileBudget: {},
    },
  });
  const opened = {
    maxMembers: 8,
    economy: {
      pool: [{ profileId: "p-deepseek", family: "deepseek" }],
      taskOrder: {},
      profileBudget: {},
    },
  };

  test("detects external economy or max changes", () => {
    expect(decideEconomySave(opened, latest)).toBe("conflict");
    const sameEconomy = PreferencesSchema.parse({
      ...latest,
      maxMembers: 8,
      economy: opened.economy,
    });
    expect(decideEconomySave(opened, sameEconomy)).toBe("write");
    expect(decideEconomySave(opened, sameEconomy, true)).toBe("write");
    const onlyOtherFields = PreferencesSchema.parse({
      ...latest,
      maxMembers: 8,
      recentRuns: [],
      economy: opened.economy,
    });
    expect(decideEconomySave(opened, onlyOtherFields)).toBe("write");
  });

  test("explicit overwrite builds from the opened block", () => {
    const draft = draftFromStored(opened.economy);
    const next = mergeEconomyPreferences(latest, draft, profiles, {
      maxMembers: 9,
      economyBase: opened.economy,
    });
    expect(next.maxMembers).toBe(9);
    expect(next.economy?.pool).toEqual([expect.objectContaining({ profileId: "p-deepseek" })]);
  });
});

import { describe, expect, test } from "vitest";
import {
  ALL_SEATS_ROUTES,
  addAllSeatsProfile,
  addAllSeatsRouteEntry,
  addPoolEntry,
  allSeatsStoredVersion,
  applySuggestedAllSeats,
  applySuggestedPool,
  buildStoredEconomy,
  cheapFamilyOf,
  checkAllSeatsEntry,
  DEFAULT_MAX_MEMBERS,
  decideEconomySave,
  draftFromStored,
  effectiveAllSeatsTaskOrder,
  effectiveTaskOrder,
  familyIsInvalid,
  familyNeedsRebind,
  MAX_MAX_MEMBERS,
  mergeEconomyPreferences,
  moveAllSeatsRouteEntry,
  moveAllSeatsTaskOrder,
  movePoolEntry,
  moveTaskOrder,
  needsLiveProfilesForSave,
  normalizeFamily,
  preselectSuggestedPool,
  rebindAllSeatsProfile,
  rebindPoolFamily,
  removeAllSeatsProfile,
  removeAllSeatsRouteEntry,
  removePoolEntry,
  removeProfileBudget,
  resetAllSeatsTaskOrder,
  resetTaskOrder,
  resolveMaxMembersForSave,
  setAllSeatsEnabled,
  setPoolEnabled,
  setPoolFamily,
  setProfileBudget,
} from "../client/settings/economy-pool";
import type { PaseoProfile, ProviderAvailability } from "../shared/paseo/adapter";
import { PreferencesSchema } from "../shared/schemas/preferences";
import {
  ALL_SEATS_WRITER_LIMIT,
  StoredAllSeatsPolicySchema,
  TaskKindSchema,
} from "../shared/schemas/team-mode";
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

/** The written block, viewed as the route/task-order maps the assertions walk. */
function asStoredAllSeats(raw: unknown): {
  routes: Record<string, string[]>;
  executionTaskOrder: Record<string, string[]>;
} {
  const block = raw as {
    routes?: Record<string, string[]>;
    executionTaskOrder?: Record<string, string[]>;
  };
  return { routes: block.routes ?? {}, executionTaskOrder: block.executionTaskOrder ?? {} };
}

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
      designerProfile: { profileId: "designer", future: "kept" },
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
    expect(next.designerProfile).toEqual({ profileId: "designer", future: "kept" });
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

describe("economy-all allowlist", () => {
  const live: PaseoProfile[] = [
    { id: "p-sonnet", name: "Claude Sonnet", provider: "claude", model: "claude-sonnet-4-6" },
    { id: "p-deepseek", name: "DeepSeek", provider: "omp", model: "deepseek-v4" },
    { id: "p-grok", name: "Grok", provider: "omp", model: "grok-4.6" },
    { id: "p-opus", name: "Cheap Lite", provider: "claude", model: "claude-opus-5" },
    { id: "p-auto", name: "Auto", provider: "omp", model: "auto" },
    { id: "p-unbound", name: "No Model", provider: "omp" },
  ];
  const available: ProviderAvailability[] = [
    { provider: "claude", available: true },
    { provider: "omp", available: true },
  ];
  const storedAllSeats = {
    version: 1,
    profiles: [
      {
        profileId: "p-sonnet",
        nameSnapshot: "Claude Sonnet",
        enabled: true,
        costClass: "low",
        family: "sonnet",
        boundModel: { provider: "claude", model: "claude-sonnet-4-6" },
        futureEntryField: { keep: 1 },
      },
      {
        profileId: "p-deepseek",
        enabled: false,
        costClass: "low",
        family: "deepseek",
        boundModel: { provider: "omp", model: "deepseek-v4" },
      },
      { profileId: "p-sonnet", family: "second" },
      { profileRef: "future" },
    ],
    routes: {
      coordinator: ["p-sonnet", "p-sonnet", "p-gone"],
      decision: ["p-deepseek"],
      execution: ["p-deepseek", "p-sonnet"],
      escalation: [],
      retain: ["p-sonnet"],
      review: ["p-sonnet"],
    },
    executionTaskOrder: {
      coding: ["p-sonnet", "p-deepseek"],
      ops: ["p-deepseek"],
      future: ["p-sonnet"],
    },
    futureBlockField: { keep: "all-seats" },
  };

  test("reads the allowlist, five routes, and task order without inventing entries", () => {
    const draft = draftFromStored({ allSeats: storedAllSeats });
    expect(draft.allSeats.profiles.map((entry) => entry.profileId)).toEqual([
      "p-sonnet",
      "p-deepseek",
    ]);
    expect(draft.allSeats.profiles[1]).toMatchObject({ enabled: false, family: "deepseek" });
    expect(draft.allSeats.routes).toEqual({
      coordinator: ["p-sonnet"],
      decision: ["p-deepseek"],
      execution: ["p-deepseek", "p-sonnet"],
      escalation: [],
      retain: ["p-sonnet"],
    });
    expect(draft.allSeats.executionTaskOrder).toEqual({
      coding: ["p-sonnet", "p-deepseek"],
      ops: ["p-deepseek"],
    });
    expect(draft.allSeats.touched).toBe(false);
  });

  test("a future block version is remembered for the warning, not reset", () => {
    expect(
      allSeatsStoredVersion(draftFromStored({ allSeats: storedAllSeats }).allSeats),
    ).toBeNull();
    const future = draftFromStored({ allSeats: { ...storedAllSeats, version: 99 } });
    expect(allSeatsStoredVersion(future.allSeats)).toBe("99");
    expect(future.allSeats.profiles).toHaveLength(2);
    expect(allSeatsStoredVersion(draftFromStored(undefined).allSeats)).toBeNull();
  });

  test("only a live, resolved low-cost model can join the allowlist", () => {
    expect(cheapFamilyOf({ model: "claude-sonnet-4-6" })).toBe("sonnet");
    expect(cheapFamilyOf({ model: "grok-4.6" })).toBe("grok");
    expect(cheapFamilyOf({ model: "claude-opus-5" })).toBeNull();
    expect(cheapFamilyOf({ model: "auto" })).toBeNull();
    expect(cheapFamilyOf({ model: "gemini-3" })).toBeNull();
    expect(cheapFamilyOf({})).toBeNull();

    let draft = draftFromStored(undefined);
    for (const id of ["p-opus", "p-auto", "p-unbound"]) {
      const profile = live.find((entry) => entry.id === id);
      if (!profile) throw new Error("fixture missing");
      draft = addAllSeatsProfile(draft, profile);
    }
    expect(draft.allSeats.profiles).toEqual([]);
    expect(draft.allSeats.touched).toBe(false);

    const sonnet = live[0];
    if (!sonnet) throw new Error("fixture missing");
    const added = addAllSeatsProfile(draft, sonnet);
    expect(added.allSeats.profiles[0]).toMatchObject({
      profileId: "p-sonnet",
      family: "sonnet",
      enabled: true,
      familyTouched: true,
    });
    expect(added.allSeats.touched).toBe(true);
  });

  test("the writer limit caps the allowlist but never rewrites an existing one", () => {
    let draft = draftFromStored(undefined);
    const generated: PaseoProfile[] = [];
    for (let index = 0; index < ALL_SEATS_WRITER_LIMIT + 4; index += 1) {
      const profile = {
        id: `p-${index}`,
        name: `DeepSeek ${index}`,
        provider: "omp",
        model: "deepseek-v4",
      };
      generated.push(profile);
      draft = addAllSeatsProfile(draft, profile);
    }
    expect(draft.allSeats.profiles).toHaveLength(ALL_SEATS_WRITER_LIMIT);
    const stored = buildStoredEconomy(undefined, draft, generated);
    const policy = StoredAllSeatsPolicySchema.parse(stored.allSeats);
    expect(policy.version).toBe(1);
    expect(Array.isArray(policy.profiles) ? policy.profiles.length : 0).toBe(
      ALL_SEATS_WRITER_LIMIT,
    );
  });

  test("eligibility reports the exact exclusion and never treats unknown as available", () => {
    const draft = draftFromStored({ allSeats: storedAllSeats }).allSeats;
    const [sonnet, deepseek] = draft.profiles;
    if (!sonnet || !deepseek) throw new Error("fixture missing");

    expect(checkAllSeatsEntry(sonnet, live, available)).toEqual({
      liveFamily: "sonnet",
      exclusion: null,
    });
    expect(checkAllSeatsEntry(deepseek, live, available).exclusion).toBeNull();
    expect(checkAllSeatsEntry(sonnet, live, null).exclusion).toBe("provider-unverified");
    expect(
      checkAllSeatsEntry(sonnet, live, [{ provider: "claude", available: false }]).exclusion,
    ).toBe("provider-unavailable");
    expect(
      checkAllSeatsEntry(sonnet, live, [{ provider: "claude", available: false, reason: "token" }])
        .providerReason,
    ).toBe("token");

    const found = (id: string) => live.find((entry) => entry.id === id);
    const opus = found("p-opus");
    const auto = found("p-auto");
    if (!opus || !auto) throw new Error("fixture missing");
    expect(
      checkAllSeatsEntry({ ...sonnet, profileId: "p-opus" }, [opus], available).exclusion,
    ).toBe("family-high-cost");
    expect(
      checkAllSeatsEntry({ ...sonnet, profileId: "p-auto" }, [auto], available).exclusion,
    ).toBe("model-unresolved");
    expect(checkAllSeatsEntry({ ...sonnet, profileId: "p-gone" }, live, available).exclusion).toBe(
      "profile-missing",
    );

    // A saved family this version does not support, or a re-pointed tuple, must be re-confirmed.
    expect(
      checkAllSeatsEntry({ ...sonnet, originalFamily: "claude-sonnet-4-6" }, live, available)
        .exclusion,
    ).toBe("needs-rebind");
    const repointed = live.map((entry) =>
      entry.id === "p-sonnet" ? { ...entry, model: "claude-sonnet-5" } : entry,
    );
    expect(checkAllSeatsEntry(sonnet, repointed, available).exclusion).toBe("needs-rebind");
    const rebound = rebindAllSeatsProfile(
      draftFromStored({ allSeats: storedAllSeats }),
      "p-sonnet",
      repointed[0] as PaseoProfile,
    );
    const reboundEntry = rebound.allSeats.profiles[0];
    if (!reboundEntry) throw new Error("fixture missing");
    expect(checkAllSeatsEntry(reboundEntry, repointed, available).exclusion).toBeNull();
  });

  test("removing an allowlist entry also clears it from every route and task order", () => {
    const raw = { allSeats: storedAllSeats };
    const next = removeAllSeatsProfile(draftFromStored(raw), "p-sonnet");
    expect(next.allSeats.profiles.map((entry) => entry.profileId)).toEqual(["p-deepseek"]);
    expect(next.allSeats.routes).toEqual({
      coordinator: [],
      decision: ["p-deepseek"],
      execution: ["p-deepseek"],
      escalation: [],
      retain: [],
    });
    expect(next.allSeats.executionTaskOrder).toEqual({
      coding: ["p-deepseek"],
      ops: ["p-deepseek"],
    });
    expect(next.allSeats.removed).toContain("p-sonnet");
    const stored = buildStoredEconomy(raw, next, live);
    expect(stored.allSeats).toMatchObject({
      profiles: [expect.objectContaining({ profileId: "p-deepseek" }), { profileRef: "future" }],
    });
    const known = asStoredAllSeats(stored.allSeats);
    for (const route of ALL_SEATS_ROUTES) {
      expect(known.routes[route] ?? []).not.toContain("p-sonnet");
    }
    for (const kind of TaskKindSchema.options) {
      expect(known.executionTaskOrder[kind] ?? []).not.toContain("p-sonnet");
    }
    // An unknown layer this version cannot read is preserved verbatim, not silently filtered.
    expect(known.routes.review).toEqual(["p-sonnet"]);
  });

  test("routes only accept allowlisted ids, cap at the limit, and reorder in place", () => {
    let draft = draftFromStored({ allSeats: storedAllSeats });
    draft = addAllSeatsRouteEntry(draft, "decision", "p-gone");
    draft = addAllSeatsRouteEntry(draft, "decision", "p-sonnet");
    draft = addAllSeatsRouteEntry(draft, "decision", "p-sonnet");
    expect(draft.allSeats.routes.decision).toEqual(["p-deepseek", "p-sonnet"]);
    expect(draft.allSeats.routes.coordinator).toEqual(["p-sonnet"]);

    draft = moveAllSeatsRouteEntry(draft, "decision", 1, -1);
    expect(draft.allSeats.routes.decision).toEqual(["p-sonnet", "p-deepseek"]);
    draft = removeAllSeatsRouteEntry(draft, "decision", "p-sonnet");
    expect(draft.allSeats.routes.decision).toEqual(["p-deepseek"]);

    let full = draftFromStored(undefined);
    for (let index = 0; index < ALL_SEATS_WRITER_LIMIT + 2; index += 1) {
      full = addAllSeatsProfile(full, {
        id: `p-${index}`,
        name: `DeepSeek ${index}`,
        provider: "omp",
        model: "deepseek-v4",
      });
      full = addAllSeatsRouteEntry(full, "retain", `p-${index}`);
    }
    expect(full.allSeats.routes.retain).toHaveLength(ALL_SEATS_WRITER_LIMIT);
  });

  test("the execution task order only reorders ids inside the execution route", () => {
    let draft = draftFromStored({ allSeats: storedAllSeats });
    draft = setAllSeatsEnabled(draft, "p-deepseek", true);
    expect(draft.allSeats.profiles[1]?.enabled).toBe(true);
    expect(effectiveAllSeatsTaskOrder(draft, "coding")).toEqual(["p-sonnet", "p-deepseek"]);
    expect(effectiveAllSeatsTaskOrder(draft, "ops")).toEqual(["p-deepseek", "p-sonnet"]);
    draft = moveAllSeatsTaskOrder(draft, "coding", 1, -1);
    expect(effectiveAllSeatsTaskOrder(draft, "coding")).toEqual(["p-deepseek", "p-sonnet"]);
    draft = resetAllSeatsTaskOrder(draft, "coding");
    expect(draft.allSeats.executionTaskOrder.coding).toBeUndefined();
    expect(effectiveAllSeatsTaskOrder(draft, "coding")).toEqual(["p-deepseek", "p-sonnet"]);
    // A route removal drops the id from the task order too.
    draft = removeAllSeatsRouteEntry(draft, "execution", "p-sonnet");
    expect(effectiveAllSeatsTaskOrder(draft, "coding")).toEqual(["p-deepseek"]);
  });

  test("suggestions fill the five routes from live low-cost families, draft only", () => {
    const draft = draftFromStored(undefined);
    const next = applySuggestedAllSeats(draft, live);
    expect(next.allSeats.profiles.map((entry) => entry.profileId)).toEqual([
      "p-sonnet",
      "p-deepseek",
      "p-grok",
    ]);
    expect(next.allSeats.routes).toEqual({
      coordinator: ["p-sonnet"],
      decision: ["p-sonnet"],
      execution: ["p-deepseek", "p-grok"],
      escalation: ["p-sonnet"],
      retain: ["p-sonnet"],
    });
    expect(effectiveAllSeatsTaskOrder(next, "coding")).toEqual(["p-deepseek", "p-grok"]);
    expect(effectiveAllSeatsTaskOrder(next, "ops")).toEqual(["p-grok", "p-deepseek"]);
    expect(new Set(next.allSeats.profiles.map((entry) => entry.profileId)).has("p-opus")).toBe(
      false,
    );
    expect(draft.allSeats.profiles).toEqual([]);

    const kept = applySuggestedAllSeats(
      draftFromStored({
        allSeats: {
          version: 1,
          profiles: [
            {
              profileId: "p-opus",
              family: "opus",
              enabled: true,
              costClass: "low",
              boundModel: { provider: "claude", model: "claude-opus-5" },
            },
          ],
        },
      }),
      live,
    );
    expect(kept.allSeats.profiles[0]?.profileId).toBe("p-opus");
  });
});

describe("economy-all stored block", () => {
  const sonnet: PaseoProfile = {
    id: "p-sonnet",
    name: "Claude Sonnet",
    provider: "claude",
    model: "claude-sonnet-4-6",
  };
  const raw = {
    pool: [{ profileId: "p-grok", family: "grok" }],
    allSeats: {
      version: 99,
      profiles: [
        {
          profileId: "p-sonnet",
          family: "sonnet",
          enabled: true,
          costClass: "low",
          boundModel: { provider: "claude", model: "claude-sonnet-4-6" },
          futureEntryField: { keep: "entry" },
        },
      ],
      routes: {
        coordinator: ["p-sonnet"],
        execution: ["p-sonnet"],
        review: ["p-sonnet"],
      },
      executionTaskOrder: { coding: ["p-sonnet"] },
      futureBlockField: { keep: "block" },
    },
    futureEconomyField: { keep: "economy" },
  };

  test("an untouched block survives a save byte for byte, even a future version", () => {
    const draft = draftFromStored(raw);
    const current = PreferencesSchema.parse({ maxMembers: 10, economy: raw });
    const next = mergeEconomyPreferences(current, draft, [sonnet]);
    expect(next.economy?.allSeats).toEqual(raw.allSeats);
    expect(next.economy).toMatchObject({ futureEconomyField: { keep: "economy" } });
  });

  test("an edited block writes v1 with the live tuple and keeps unknown siblings", () => {
    const draft = setAllSeatsEnabled(draftFromStored(raw), "p-sonnet", false);
    const current = PreferencesSchema.parse({ maxMembers: 10, economy: raw });
    const next = mergeEconomyPreferences(current, draft, [sonnet]);
    expect(next.economy?.allSeats).toMatchObject({
      version: 1,
      futureBlockField: { keep: "block" },
      routes: {
        coordinator: ["p-sonnet"],
        execution: ["p-sonnet"],
        review: ["p-sonnet"],
      },
      executionTaskOrder: { coding: ["p-sonnet"] },
      profiles: [
        {
          profileId: "p-sonnet",
          enabled: false,
          costClass: "low",
          family: "sonnet",
          boundModel: { provider: "claude", model: "claude-sonnet-4-6" },
          futureEntryField: { keep: "entry" },
        },
      ],
    });
    expect(next.economy).toMatchObject({ futureEconomyField: { keep: "economy" } });
    expect(next.economy?.pool).toEqual([
      expect.objectContaining({ profileId: "p-grok", family: "grok" }),
    ]);
  });

  test("adding an entry records the verified family, tuple, and live name", () => {
    const draft = addAllSeatsProfile(draftFromStored(undefined), sonnet);
    const stored = buildStoredEconomy(undefined, draft, [sonnet]);
    expect(stored.allSeats).toEqual({
      version: 1,
      profiles: [
        {
          profileId: "p-sonnet",
          enabled: true,
          costClass: "low",
          family: "sonnet",
          boundModel: { provider: "claude", model: "claude-sonnet-4-6" },
          nameSnapshot: "Claude Sonnet",
        },
      ],
      routes: {},
      executionTaskOrder: {},
    });
    // A stored-only allowlist id this version cannot read survives an edit elsewhere.
    const unknown = draftFromStored({
      allSeats: {
        version: 1,
        profiles: [{ profileRef: "future" }, { profileId: "p-sonnet", family: "sonnet" }],
      },
    });
    const edited = setAllSeatsEnabled(unknown, "p-sonnet", false);
    const kept = buildStoredEconomy(
      { allSeats: { version: 1, profiles: [{ profileRef: "future" }] } },
      edited,
      [sonnet],
    );
    expect(kept.allSeats).toMatchObject({
      profiles: [{ profileRef: "future" }, expect.objectContaining({ profileId: "p-sonnet" })],
    });
  });

  test("the save gate needs a live Profile only for a new or re-confirmed entry", () => {
    const live = [sonnet];
    const added = addAllSeatsProfile(draftFromStored(undefined), sonnet);
    expect(needsLiveProfilesForSave(added, live)).toBe(false);
    expect(needsLiveProfilesForSave(added, [])).toBe(true);
    const legacy = draftFromStored({
      allSeats: {
        version: 1,
        profiles: [{ profileId: "p-gone", family: "grok" }],
        routes: { retain: ["p-gone"] },
      },
    });
    expect(needsLiveProfilesForSave(legacy, [])).toBe(false);
    // A re-confirmed live entry is checked against its own Profile, not a neighbour.
    const reConfirmed = rebindAllSeatsProfile(
      draftFromStored({
        allSeats: { version: 1, profiles: [{ profileId: "p-sonnet", family: "haiku" }] },
      }),
      "p-sonnet",
      sonnet,
    );
    expect(needsLiveProfilesForSave(reConfirmed, [sonnet])).toBe(false);
    expect(needsLiveProfilesForSave(reConfirmed, [])).toBe(true);
  });

  test("a changed allowlist or task order is a save conflict, not an overwrite", () => {
    const opened = {
      maxMembers: 10,
      economy: { allSeats: { version: 1, routes: { retain: [] } } },
    };
    const latest = PreferencesSchema.parse({
      maxMembers: 10,
      economy: { allSeats: { version: 1, routes: { retain: ["p-sonnet"] } } },
    });
    expect(decideEconomySave(opened, latest)).toBe("conflict");
    expect(decideEconomySave({ maxMembers: 10, economy: latest.economy }, latest)).toBe("write");
  });

  test("the editor keeps unrelated host fields when writing the block", () => {
    const current = PreferencesSchema.parse({
      maxMembers: 10,
      recentRuns: [],
      designerProfile: { profileId: "designer", future: "kept" },
      defaultPresets: { catalogRevision: "cat", seenRoleIds: [] },
      economy: { allSeats: { version: 1 } },
    });
    const draft = addAllSeatsProfile(draftFromStored(current.economy), sonnet);
    const next = mergeEconomyPreferences(current, draft, [sonnet]);
    expect(next.designerProfile).toEqual({ profileId: "designer", future: "kept" });
    expect(next.defaultPresets).toEqual(current.defaultPresets);
    expect(next.economy?.allSeats).toMatchObject({
      profiles: [expect.objectContaining({ profileId: "p-sonnet" })],
    });
  });
});

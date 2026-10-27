import { describe, expect, test } from "vitest";
import { exampleCatalog, materializeDefaultCatalog } from "../server/templates";
import { bindProfileHints, normalizeProfileName } from "../shared/domain/profile-binding";
import { resolveProfile } from "../shared/domain/profile-resolver";
import type { PaseoProfile } from "../shared/paseo/adapter";
import type { ProfileHint } from "../shared/schemas/default-catalog";
import { RoleSchema } from "../shared/schemas/role";
import { sourceProfiles } from "./default-presets.fixtures";
import { NOW } from "./fixtures";

const hint: ProfileHint = {
  name: "Model-High｜创意写作",
  provider: "claude",
  model: "model",
  modeId: "auto",
  thinkingOptionId: "high",
};
const profile: PaseoProfile = { id: "one", ...hint, notes: "does not participate in identity" };
const bind = (profiles: PaseoProfile[], hints = [hint]) =>
  bindProfileHints("test-role", hints, [], profiles);

describe("strict Profile hint binding", () => {
  test("normalizes NFKC, trim, repeated whitespace, and case without losing suffixes or hyphens", () => {
    expect(normalizeProfileName("  Ｍｏｄｅｌ\t HIGH｜创意写作  ")).toBe("model high|创意写作");
    const normalized = bind([{ ...profile, name: "  MODEL-ＨＩＧＨ|创意写作  " }]);
    expect(normalized.preferredProfiles[0]).toEqual({
      profileId: "one",
      nameSnapshot: "  MODEL-ＨＩＧＨ|创意写作  ",
      hint,
    });
    expect(normalized.bindingReport[0]).toMatchObject({ method: "normalized-name", reason: null });
    expect(normalizeProfileName("Model High")).not.toBe(normalizeProfileName("Model-High"));
  });

  test("a renamed Profile binds only if its exact runtime tuple is unique", () => {
    expect(bind([{ ...profile, name: "Renamed" }]).bindingReport[0]).toMatchObject({
      method: "runtime",
      profileId: "one",
      candidateNames: ["Renamed"],
    });
    const result = bind([
      { ...profile, name: "Renamed" },
      { ...profile, id: "two", name: "Another" },
    ]);
    expect(result.preferredProfiles[0].profileId).toBe("unbound:default:test-role:preferred:0");
    expect(result.bindingReport[0]).toMatchObject({
      method: "unbound",
      reason: "ambiguous",
      candidateNames: ["Renamed", "Another"],
    });
  });

  test("a single verbatim name breaks a normalized runtime tie; otherwise it stays ambiguous", () => {
    const chosen = bind([profile, { ...profile, id: "two", name: " MODEL-High|创意写作 " }]);
    expect(chosen.preferredProfiles[0].profileId).toBe(profile.id);
    expect(chosen.bindingReport[0]).toMatchObject({
      method: "exact",
      reason: null,
      profileId: profile.id,
      candidateNames: [profile.name, " MODEL-High|创意写作 "],
    });
    expect(
      bind([
        { ...profile, name: " Model-High｜创意写作 " },
        { ...profile, id: "two", name: "MODEL-High｜创意写作" },
      ]).bindingReport[0],
    ).toMatchObject({ method: "unbound", reason: "ambiguous" });
    // Two verbatim matches are still ambiguous; the rule only accepts exactly one.
    expect(bind([profile, { ...profile, id: "two" }]).bindingReport[0]).toMatchObject({
      method: "unbound",
      reason: "ambiguous",
    });
  });

  test.each(["provider", "model", "modeId", "thinkingOptionId"] as const)(
    "same-name changed %s stays unbound despite another unique runtime match",
    (field) => {
      const changed = { ...profile, [field]: "changed" };
      const result = bind([changed, { ...profile, id: "other", name: "Renamed" }]);
      expect(result.bindingReport[0]).toMatchObject({
        method: "unbound",
        reason: "config-changed",
        candidateNames: [hint.name],
      });
      expect(result.preferredProfiles[0].nameSnapshot).toBe(hint.name);
    },
  );

  test("absent runtime fields match absence, not wildcards; empty strings normalize to absence", () => {
    const minimal = { name: "Minimal", provider: "codex" };
    expect(bind([{ id: "minimal", ...minimal }], [minimal]).preferredProfiles[0].profileId).toBe(
      "minimal",
    );
    expect(
      bind([{ id: "minimal", ...minimal, model: "host-default" }], [minimal]).bindingReport[0]
        .reason,
    ).toBe("config-changed");
    for (const field of ["model", "modeId", "thinkingOptionId"] as const) {
      expect(
        bind([{ id: "minimal", ...minimal, [field]: "" }], [minimal]).bindingReport[0],
      ).toMatchObject({ method: "exact", reason: null });
      expect(
        bind([{ id: "minimal", ...minimal }], [{ ...minimal, [field]: "" }]).bindingReport[0],
      ).toMatchObject({ method: "exact", reason: null });
    }
  });

  test("same normalized name disambiguates runtime twins regardless of host ordering", () => {
    const twins = [{ ...profile, id: "other", name: "General" }, profile];
    expect(bind(twins).preferredProfiles[0].profileId).toBe(profile.id);
    // Renaming Opus Medium leaves two Profiles with its runtime: the hint must not pick one.
    const medium = sourceProfiles.find((entry) => entry.name === "Claude-Opus-5.5-Medium");
    if (!medium) throw new Error("Missing Opus Medium fixture");
    const renamed = [
      ...sourceProfiles.map((entry) =>
        entry === medium ? { ...entry, name: "Opus Medium" } : entry,
      ),
      { ...medium, id: "agent_profile_twin", name: "Opus Medium twin" },
    ];
    const { bindingReport } = materializeDefaultCatalog(renamed, NOW);
    const mediumReports = bindingReport.filter(
      (entry) => entry.hint.name === "Claude-Opus-5.5-Medium",
    );
    expect(mediumReports.length).toBeGreaterThan(0);
    expect(
      mediumReports.every((entry) => entry.method === "unbound" && entry.reason === "ambiguous"),
    ).toBe(true);
    expect(bindingReport.find((entry) => entry.hint.name === "Claude-Opus-5.5-Max")).toMatchObject({
      method: "exact",
    });
  });

  test("placeholder IDs avoid real IDs and suffix collisions deterministically across both lists", () => {
    const base = "unbound:default:test-role:preferred:0";
    const profiles = [base, `${base}:1`, "unbound:default:test-role:fallback:0"].map((id) => ({
      ...profile,
      id,
      name: "Other",
      provider: "other",
    }));
    const result = bindProfileHints("test-role", [hint, hint], [hint], profiles);
    const refs = [...result.preferredProfiles, ...result.fallbackProfiles];
    expect(refs.map((ref) => ref.profileId)).toEqual([
      `${base}:2`,
      "unbound:default:test-role:preferred:1",
      "unbound:default:test-role:fallback:0:1",
    ]);
    expect(new Set(refs.map((ref) => ref.profileId)).size).toBe(3);
    expect(bindProfileHints("test-role", [hint, hint], [hint], profiles)).toEqual(result);
    expect(result.bindingReport.every((entry) => entry.reason === "missing")).toBe(true);
  });

  test("deduplicates real bindings within each list and preserves order and every hint's report", () => {
    const other = { ...hint, name: "Second", thinkingOptionId: "max" };
    const result = bindProfileHints(
      "test-role",
      [hint, { ...hint, name: "Old name" }, other],
      [hint, hint],
      [profile, { id: "two", ...other }],
    );
    expect(result.preferredProfiles.map((ref) => ref.profileId)).toEqual(["one", "two"]);
    expect(result.fallbackProfiles.map((ref) => ref.profileId)).toEqual(["one"]);
    expect(result.bindingReport.map((entry) => entry.deduplicated)).toEqual([
      false,
      true,
      false,
      false,
      true,
    ]);
  });

  test("all preferred missing still passes schema and resolves an available fallback", () => {
    const role = exampleCatalog(sourceProfiles, NOW).roles[0];
    const fallbackId = role.fallbackProfiles[0].profileId;
    const profiles = sourceProfiles.filter((entry) => entry.id === fallbackId);
    const rebound = exampleCatalog(profiles, NOW).roles[0];
    RoleSchema.parse(rebound);
    expect(rebound.preferredProfiles.every((ref) => ref.profileId.startsWith("unbound:"))).toBe(
      true,
    );
    expect(resolveProfile(rebound, profiles, [])).toMatchObject({
      ok: true,
      source: "role-fallback",
      profile: { id: fallbackId },
    });
  });

  test("an unavailable provider does not affect binding; resolver handles it at launch", () => {
    const role = exampleCatalog(sourceProfiles, NOW).roles[0];
    const result = resolveProfile(role, sourceProfiles, [{ provider: "claude", available: false }]);
    expect(role.preferredProfiles[0].profileId).toBe(
      sourceProfiles.find((entry) => entry.name === "Claude-Opus-5.5-Medium")?.id,
    );
    expect(result).toMatchObject({ ok: true, profile: { provider: "omp" } });
  });
});

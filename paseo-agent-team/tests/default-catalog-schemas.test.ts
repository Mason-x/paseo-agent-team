import { describe, expect, test } from "vitest";
import { exampleCatalog } from "../server/templates";
import { ProfileHintSchema } from "../shared/schemas/default-catalog";
import { MAX_SEEN_PRESET_ROLE_IDS, PreferencesSchema } from "../shared/schemas/preferences";
import { ProfileRefSchema } from "../shared/schemas/profile-ref";
import { RoleSchema } from "../shared/schemas/role";
import { architect, NOW } from "./fixtures";

describe("optional default preset persistence", () => {
  test("legacy references, Roles, and preferences need no migration", () => {
    const ref = { profileId: "legacy", nameSnapshot: "Legacy" };
    expect(ProfileRefSchema.parse(ref)).toEqual(ref);
    expect(RoleSchema.parse(architect)).toEqual(architect);
    expect(PreferencesSchema.parse({})).toEqual({
      maxMembers: 24,
      archiveOnLaunchFailure: true,
      recentRuns: [],
    });
    expect(
      RoleSchema.parse({ ...architect, source: "team-designer", customExtension: true }),
    ).toMatchObject({ source: "team-designer", customExtension: true });
  });

  test("unknown hint fields are stripped, and a damaged hint or origin never rejects the Role", () => {
    const preset = exampleCatalog([], NOW).roles[0];
    expect(RoleSchema.parse(preset)).toEqual(preset);
    const hint = preset.preferredProfiles[0].hint;
    const stripped = ProfileHintSchema.parse({ ...hint, notes: "host notes" });
    expect(stripped).toEqual(hint);
    expect(stripped).not.toHaveProperty("notes");
    expect(
      ProfileRefSchema.parse({ profileId: "one", hint: { name: "", provider: "codex" } }),
    ).toEqual({ profileId: "one" });
    expect(
      ProfileRefSchema.parse({ profileId: "one", hint: { name: "Hint", provider: "codex" } }),
    ).toMatchObject({ hint: { name: "Hint", provider: "codex" } });

    const damaged = RoleSchema.parse({
      ...preset,
      preset: { ...preset.preset, catalogId: "" },
    });
    expect(damaged.preset).toBeUndefined();
    expect(damaged.preferredProfiles).toEqual(preset.preferredProfiles);
    expect(RoleSchema.parse({ ...preset, preset: "broken" }).preset).toBeUndefined();
    // The origin is tolerant of newer writers too: no literal catalog id, no hash shape, and
    // unknown keys survive a round-trip.
    expect(
      RoleSchema.parse({
        ...preset,
        preset: { ...preset.preset, catalogRevision: "next", future: 1 },
      }).preset,
    ).toMatchObject({ catalogRevision: "next", future: 1 });
  });

  test("history deduplicates and keeps the newest ids instead of invalidating preferences", () => {
    const defaultPresets = {
      catalogRevision: "defaults-old",
      seenRoleIds: ["lead-tech", "eng-fullstack", "lead-tech"],
      lastSyncedAt: NOW,
    };
    expect(PreferencesSchema.parse({ defaultPresets }).defaultPresets).toEqual({
      ...defaultPresets,
      seenRoleIds: ["lead-tech", "eng-fullstack"],
    });
    const overflow = Array.from(
      { length: MAX_SEEN_PRESET_ROLE_IDS + 5 },
      (_, index) => `role-${index}`,
    );
    expect(
      PreferencesSchema.parse({ defaultPresets: { ...defaultPresets, seenRoleIds: overflow } })
        .defaultPresets?.seenRoleIds,
    ).toEqual(overflow.slice(-MAX_SEEN_PRESET_ROLE_IDS));
    // Any string id is tolerated, non-string entries are dropped individually, and a damaged
    // block drops only preset history.
    expect(
      PreferencesSchema.parse({
        defaultPresets: {
          ...defaultPresets,
          seenRoleIds: ["Invalid_ID", 7, null, { id: "x" }, "ok", "Invalid_ID"],
        },
      }).defaultPresets?.seenRoleIds,
    ).toEqual(["Invalid_ID", "ok"]);
    const longTimestamp = "x".repeat(5000);
    expect(
      PreferencesSchema.parse({
        defaultPresets: { ...defaultPresets, lastSyncedAt: longTimestamp },
      }).defaultPresets?.lastSyncedAt,
    ).toBe(longTimestamp);
    expect(PreferencesSchema.parse({ maxMembers: 3, defaultPresets: { seenRoleIds: [] } })).toEqual(
      { maxMembers: 3, archiveOnLaunchFailure: true, recentRuns: [] },
    );
    expect(
      PreferencesSchema.parse({ defaultPresets: { ...defaultPresets, future: true } })
        .defaultPresets,
    ).toEqual({ ...defaultPresets, seenRoleIds: ["lead-tech", "eng-fullstack"] });
  });
});

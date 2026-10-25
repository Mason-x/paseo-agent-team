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
      maxMembers: 8,
      archiveOnLaunchFailure: true,
      recentRuns: [],
    });
    expect(
      RoleSchema.parse({ ...architect, source: "team-designer", customExtension: true }),
    ).toMatchObject({ source: "team-designer", customExtension: true });
  });

  test("hint and origin survive schema parsing, while unknown hint fields are rejected", () => {
    const preset = exampleCatalog([], NOW).roles[0];
    expect(RoleSchema.parse(preset)).toEqual(preset);
    expect(
      ProfileHintSchema.safeParse({ ...preset.preferredProfiles[0].hint, notes: "host notes" })
        .success,
    ).toBe(false);
    expect(
      RoleSchema.safeParse({ ...preset, preset: { ...preset.preset, appliedHash: "invalid hash" } })
        .success,
    ).toBe(false);
    expect(
      ProfileRefSchema.parse({ profileId: "one", hint: { name: "Hint", provider: "codex" } }),
    ).toMatchObject({ hint: { name: "Hint", provider: "codex" } });
  });

  test("history is an ordered deduplicated set with a hard limit and no silent truncation", () => {
    const defaultPresets = {
      catalogRevision: "defaults-old",
      seenRoleIds: ["lead-tech", "eng-fullstack", "lead-tech"],
      lastSyncedAt: NOW,
    };
    expect(PreferencesSchema.parse({ defaultPresets }).defaultPresets).toEqual({
      ...defaultPresets,
      seenRoleIds: ["lead-tech", "eng-fullstack"],
    });
    expect(
      PreferencesSchema.safeParse({
        defaultPresets: {
          ...defaultPresets,
          seenRoleIds: Array.from(
            { length: MAX_SEEN_PRESET_ROLE_IDS + 1 },
            (_, index) => `role-${index}`,
          ),
        },
      }).success,
    ).toBe(false);
    expect(
      PreferencesSchema.safeParse({
        defaultPresets: { ...defaultPresets, seenRoleIds: ["Invalid_ID"] },
      }).success,
    ).toBe(false);
    expect(PreferencesSchema.safeParse({ defaultPresets: { seenRoleIds: [] } }).success).toBe(
      false,
    );
  });
});

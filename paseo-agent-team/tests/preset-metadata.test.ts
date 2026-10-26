import { describe, expect, test } from "vitest";
import {
  addProfileRef,
  copyRole,
  copyTeam,
  keepRoleMetadata,
  keepTeamMetadata,
  mergeRoleExecutionPolicy,
  moveProfileRef,
  newProfileRef,
  removeProfileRef,
} from "../client/catalog/preset-metadata";
import { DEFAULT_CATALOG_ID } from "../shared/schemas/default-catalog";
import { codingTeam, NOW, role } from "./fixtures";

const stored = role({
  id: "stored",
  name: "Stored",
  description: "Old description",
  source: "preset",
  designer: { jobId: "job-1" },
  custom: { keep: true },
  preset: {
    catalogId: DEFAULT_CATALOG_ID,
    templateId: "stored",
    catalogRevision: "catalog-1",
    templateHash: "a".repeat(64),
    appliedHash: "b".repeat(64),
    importedAt: NOW,
  },
  preferredProfiles: [
    {
      profileId: "profile-a",
      nameSnapshot: "Profile A",
      hint: { name: "Profile A", provider: "claude", model: "opus" },
    },
  ],
});

describe("editor metadata", () => {
  test("keeps source, preset, designer, and unknown Role extensions", () => {
    const edited = keepRoleMetadata(stored, {
      ...stored,
      name: "Renamed",
      description: undefined,
      updatedAt: "2026-10-25T00:00:00.000Z",
    });
    expect(edited).toMatchObject({
      name: "Renamed",
      source: "preset",
      preset: stored.preset,
      designer: { jobId: "job-1" },
      custom: { keep: true },
    });
    expect(edited.description).toBeUndefined();
  });

  test("does not invent metadata for a new Role", () => {
    const fresh = role({ id: "fresh", name: "Fresh" });
    expect(keepRoleMetadata(null, fresh)).toBe(fresh);
  });

  test("merges role execution policy without dropping unknown policy fields", () => {
    expect(
      mergeRoleExecutionPolicy(
        { tier: "retain", taskKind: "general", custom: true },
        {
          tier: "execution",
          taskKind: "coding",
          tierTouched: true,
          taskKindTouched: true,
        },
      ),
    ).toEqual({ tier: "execution", taskKind: "coding", custom: true });
    expect(
      mergeRoleExecutionPolicy(
        { tier: 5, taskKind: { future: true }, custom: true },
        { tier: "", taskKind: "", tierTouched: false, taskKindTouched: false },
      ),
    ).toEqual({ tier: 5, taskKind: { future: true }, custom: true });
    expect(
      mergeRoleExecutionPolicy(
        { tier: "retain", custom: true },
        { tier: "", taskKind: "", tierTouched: true, taskKindTouched: true },
      ),
    ).toEqual({ custom: true });
    expect(
      mergeRoleExecutionPolicy(undefined, {
        tier: "",
        taskKind: "",
        tierTouched: false,
        taskKindTouched: false,
      }),
    ).toBeUndefined();
  });

  test("keeps Team designer and unknown extensions", () => {
    const withDesigner = {
      ...codingTeam,
      designer: { jobId: "job-2" },
      custom: { keep: true },
    };
    const edited = keepTeamMetadata(withDesigner, {
      ...withDesigner,
      name: "Renamed Team",
      operatingRules: undefined,
    });
    expect(edited).toMatchObject({
      name: "Renamed Team",
      designer: { jobId: "job-2" },
      custom: { keep: true },
    });
    expect(edited.operatingRules).toBeUndefined();
  });

  test("the Team form owns mode fields while metadata and extensions survive", () => {
    const withMode = {
      ...codingTeam,
      mode: "collaborative",
      collaboration: { replicas: 3, judgeRoleId: "qa-review" },
      designer: { jobId: "job-4" },
      custom: { keep: true },
    };
    const edited = keepTeamMetadata(withMode, {
      ...withMode,
      mode: "sota",
      collaboration: undefined,
      name: "Mode changed",
    });
    expect(edited.mode).toBe("sota");
    expect(edited.collaboration).toBeUndefined();
    expect(edited.designer).toEqual({ jobId: "job-4" });
    expect(edited.custom).toEqual({ keep: true });
  });
});

describe("copies", () => {
  test("strip preset origin and designer but keep other extensions", () => {
    const copy = copyRole(stored, "stored-copy", "Stored 副本", NOW);
    expect(copy.id).toBe("stored-copy");
    expect(copy.source).toBeUndefined();
    expect(copy.preset).toBeUndefined();
    expect(copy.designer).toBeUndefined();
    expect(copy.custom).toEqual({ keep: true });
    expect(copy.preferredProfiles[0]?.hint).toEqual(stored.preferredProfiles[0]?.hint);
  });

  test("strip Team origin fields", () => {
    const team = {
      ...codingTeam,
      source: "preset",
      designer: { jobId: "job-3" },
      custom: { keep: true },
    };
    const copy = copyTeam(team, "coding-copy", "Coding 副本", NOW);
    expect(copy.source).toBeUndefined();
    expect(copy.designer).toBeUndefined();
    expect(copy.custom).toEqual({ keep: true });
  });
});

describe("profile references", () => {
  const profile = { id: "profile-b", name: "Profile B", provider: "codex" };

  test("a newly picked reference has no hint", () => {
    expect(newProfileRef(profile)).toEqual({
      profileId: "profile-b",
      nameSnapshot: "Profile B",
    });
    expect(addProfileRef(stored.preferredProfiles, profile)).toEqual([
      stored.preferredProfiles[0],
      { profileId: "profile-b", nameSnapshot: "Profile B" },
    ]);
  });

  test("moving and removing untouched references keeps their hints", () => {
    const moved = moveProfileRef(stored.preferredProfiles, 0, 1);
    expect(moved).toEqual(stored.preferredProfiles);
    const second = {
      profileId: "profile-c",
      nameSnapshot: "Profile C",
      hint: { name: "C", provider: "x" },
    };
    expect(moveProfileRef([stored.preferredProfiles[0], second], 0, 1)).toEqual([
      second,
      stored.preferredProfiles[0],
    ]);
    expect(removeProfileRef([stored.preferredProfiles[0], second], 0)).toEqual([second]);
  });
});

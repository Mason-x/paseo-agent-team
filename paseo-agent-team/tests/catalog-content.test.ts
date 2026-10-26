import { describe, expect, test } from "vitest";
import { exampleCatalog } from "../server/templates";
import { hashCatalogContent } from "../server/templates/hash";
import {
  applyPresetSelection,
  applyPresetSelectionDocument,
  canonicalize,
  changedCatalogFields,
  diffPresetRoles,
  type PresetSelection,
  recordPresetSync,
} from "../shared/domain/catalog-content";
import type { PresetRolePreview } from "../shared/schemas/default-catalog";
import {
  MAX_SEEN_PRESET_ROLE_IDS,
  type Preferences,
  PreferencesSchema,
} from "../shared/schemas/preferences";
import { type Role, RoleSchema } from "../shared/schemas/role";
import { expectedBindings, expectedRoleContent, sourceProfiles } from "./default-presets.fixtures";
import { architect, NOW, role } from "./fixtures";

const LATER = "2026-10-25T12:00:00.000Z";
const REVISIONS = { roles: "roles-rev-1", preferences: "preferences-rev-1" };
const candidates = exampleCatalog(sourceProfiles, LATER).roles;
const originals = exampleCatalog(sourceProfiles, NOW).roles;
const hashes = (roles: readonly Role[]) =>
  Object.fromEntries(roles.map((role) => [role.id, hashCatalogContent(role)]));
const diff = (roles: Role[], seen: string[] = []) =>
  diffPresetRoles(roles, candidates, seen, hashes(roles));
const snapshot = (rows: readonly PresetRolePreview[]) => ({ roles: rows, revisions: REVISIONS });
const apply = (
  roles: readonly Role[],
  rows: readonly PresetRolePreview[],
  selection: PresetSelection = {},
  now = LATER,
) => applyPresetSelection({ roles, revision: REVISIONS.roles }, snapshot(rows), selection, now);
const sync = (
  values: Preferences,
  roles: readonly Role[],
  rows: readonly PresetRolePreview[] = [],
  now = LATER,
) =>
  recordPresetSync({ values, revision: REVISIONS.preferences }, snapshot(rows), roles, "new", now);

function presetOf(role: Role): NonNullable<Role["preset"]> {
  if (!role.preset) throw new Error("Expected a materialized preset");
  return role.preset;
}

describe("canonical content and SHA256", () => {
  test("stable object keys and undefined omission; arrays retain order and normalize undefined to null", () => {
    expect(
      canonicalize({ z: undefined, b: { z: 1, a: 2 }, a: [undefined, null, { z: 1, a: 2 }] }),
    ).toBe('{"a":[null,null,{"a":2,"z":1}],"b":{"a":2,"z":1}}');
    expect(hashCatalogContent({ b: 2, a: 1 })).toBe(
      hashCatalogContent({ a: 1, b: 2, absent: undefined }),
    );
    expect(hashCatalogContent({ a: [1, 2] })).not.toBe(hashCatalogContent({ a: [2, 1] }));
    expect(hashCatalogContent({ a: null })).not.toBe(hashCatalogContent({}));
    expect(hashCatalogContent({})).toBe(
      "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    );
  });

  test("only top-level management fields are excluded; nested MCP keys are content", () => {
    expect(hashCatalogContent(originals[0])).toBe(
      hashCatalogContent({
        ...originals[0],
        updatedAt: LATER,
        createdAt: LATER,
        preset: {},
        source: "other",
        designer: { jobId: "x" },
      }),
    );
    expect(hashCatalogContent({ mcpServers: { source: "first" } })).not.toBe(
      hashCatalogContent({ mcpServers: { source: "second" } }),
    );
    expect(changedCatalogFields(originals[0], candidates[0])).toEqual([]);
  });
});

describe("default preset diff and selected merge", () => {
  test("reports missing, local/template changes, deleted history, same, and user ID collision", () => {
    const local = { ...originals[1], systemPrompt: "User edits" };
    const updated: Role = {
      ...originals[2],
      preset: { ...presetOf(originals[2]), templateHash: "a".repeat(64) },
    };
    const collision = role({ id: candidates[3].id, name: "User role" });
    const current = [originals[0], local, updated, collision];
    const rows = diff(current, [candidates[4].id]);
    expect(rows[0]).toMatchObject({
      kind: "same",
      defaultAction: "keep",
      templateChanged: false,
      locallyChanged: false,
      changedFields: [],
    });
    expect(rows[1]).toMatchObject({
      kind: "changed",
      defaultAction: "keep",
      templateChanged: false,
      locallyChanged: true,
      changedFields: ["systemPrompt"],
    });
    expect(rows[2]).toMatchObject({ kind: "same", templateChanged: true, locallyChanged: false });
    expect(rows[3]).toMatchObject({
      kind: "id-collision",
      defaultAction: "keep",
      before: collision,
    });
    expect(rows[4]).toMatchObject({ kind: "deleted", defaultAction: "skip", changedFields: [] });
    expect(rows[5]).toMatchObject({ kind: "missing", defaultAction: "add" });
  });

  test("a pre-preset catalog with no markers reports identical content as same", () => {
    // Build the host catalog recorded before preset metadata existed: fixture content plus the
    // fixture's expected profile-ID sequences, no source/preset markers, no hints.
    const unmarked: Role[] = expectedRoleContent.map((template) => {
      const { preferredHints: _preferred, fallbackHints: _fallback, ...content } = template;
      const binding = expectedBindings.find((entry) => entry.id === template.id);
      if (!binding) throw new Error(`Missing fixture binding for ${template.id}`);
      const refs = (ids: readonly string[]) =>
        ids.map((profileId) => {
          const profile = sourceProfiles.find((entry) => entry.id === profileId);
          return profile ? { profileId, nameSnapshot: profile.name } : { profileId };
        });
      return {
        ...content,
        preferredProfiles: refs(binding.preferred),
        fallbackProfiles: refs(binding.fallback),
        createdAt: NOW,
        updatedAt: NOW,
      };
    });
    expect(unmarked).toHaveLength(22);
    expect(unmarked.every((entry) => entry.executionPolicy === undefined)).toBe(true);
    const rows = diff(unmarked);
    expect(rows).toHaveLength(22);
    expect(rows.every((row) => row.kind === "same")).toBe(true);
    expect(rows.every((row) => row.defaultAction === "keep")).toBe(true);
    expect(rows.every((row) => row.changedFields.length === 0 && !row.locallyChanged)).toBe(true);

    // A tier the user explicitly changed is still a real content difference.
    const retiered = unmarked.map((entry, index) =>
      index === 0 ? { ...entry, executionPolicy: { tier: "retain", taskKind: "general" } } : entry,
    );
    expect(diff(retiered, [retiered[0].id])[0]).toMatchObject({
      kind: "changed",
      changedFields: ["executionPolicy"],
      defaultAction: "keep",
      locallyChanged: true,
    });
    expect(
      diff(retiered, [retiered[0].id])
        .slice(1)
        .every((row) => row.kind === "same"),
    ).toBe(true);

    // A partial block inherits the missing field from the known-id default before comparing.
    const partial = unmarked.map((entry, index) =>
      index === 0 ? { ...entry, executionPolicy: { tier: "decision" } } : entry,
    );
    expect(diff(partial).every((row) => row.kind === "same")).toBe(true);

    const edited = unmarked.map((entry, index) =>
      index === 0 ? { ...entry, systemPrompt: "User rewrite" } : entry,
    );
    expect(diff(edited)[0]).toMatchObject({
      kind: "id-collision",
      changedFields: ["systemPrompt"],
      defaultAction: "keep",
      locallyChanged: true,
    });
    expect(
      diff(edited)
        .slice(1)
        .every((row) => row.kind === "same"),
    ).toBe(true);

    // Renaming a Profile changes nameSnapshot only; the ProfileRef identity is unchanged.
    const renamed = unmarked.map((entry, index) =>
      index === 0
        ? {
            ...entry,
            preferredProfiles: entry.preferredProfiles.map((ref, position) =>
              position === 0 ? { ...ref, nameSnapshot: "Renamed Profile" } : ref,
            ),
          }
        : entry,
    );
    expect(diff(renamed)[0]).toMatchObject({ kind: "same", changedFields: [] });

    const rebound = unmarked.map((entry, index) =>
      index === 0
        ? {
            ...entry,
            preferredProfiles: [
              { ...entry.preferredProfiles[0], profileId: "another-profile" },
              ...entry.preferredProfiles.slice(1),
            ],
          }
        : entry,
    );
    expect(diff(rebound)[0]).toMatchObject({
      kind: "id-collision",
      changedFields: ["preferredProfiles"],
    });
    // Missing content fields are filled by RoleSchema defaults before comparison.
    const defaulted = role({ id: "schema-defaults", name: "Defaults" });
    const {
      enabled: _enabled,
      outputContract: _output,
      restrictions: _restrictions,
      fallbackProfiles: _fallback,
      ...minimal
    } = defaulted;
    expect(changedCatalogFields(minimal as Role, defaulted)).toEqual([]);
  });

  test("seen unmarked Roles report preset updates instead of ID collisions", () => {
    const unmarked = originals.map(({ source: _source, preset: _preset, ...entry }) => entry);
    const edited = unmarked.map((entry, index) =>
      index === 0 ? { ...entry, systemPrompt: "Text from the previous catalog" } : entry,
    );
    // Without history the same id is a user-owned conflict.
    expect(diff(edited)[0]).toMatchObject({
      kind: "id-collision",
      changedFields: ["systemPrompt"],
    });
    // Once the history attributes the id to the preset, it is an update, never a collision.
    expect(diff(edited, [unmarked[0].id])[0]).toMatchObject({
      kind: "changed",
      defaultAction: "keep",
      changedFields: ["systemPrompt"],
      templateChanged: false,
      locallyChanged: true,
    });
    expect(diff(unmarked, [unmarked[0].id])[0]).toMatchObject({
      kind: "same",
      defaultAction: "keep",
      changedFields: [],
    });
  });

  test("reports preset updates separately from local edits using the import hashes", () => {
    const before: Role = {
      ...originals[0],
      description: "Previous template",
      preset: { ...presetOf(originals[0]), templateHash: "b".repeat(64) },
    };
    presetOf(before).appliedHash = hashCatalogContent(before);
    expect(diff([before])[0]).toMatchObject({
      kind: "changed",
      changedFields: ["description"],
      templateChanged: true,
      locallyChanged: false,
      defaultAction: "keep",
    });
    const edited = { ...before, mission: "User mission" };
    expect(diff([edited])[0]).toMatchObject({
      kind: "changed",
      templateChanged: true,
      locallyChanged: true,
      changedFields: ["description", "mission"],
    });
  });

  test("writes only selected preset rows into the raw document", () => {
    const unrelated = { id: "custom-role", name: "Custom", future: true };
    const raw = { roles: [unrelated], futureDoc: { keep: true } };
    const rows = diff([]);
    const selected = Object.fromEntries(
      rows.map((row) => [
        row.id,
        row.id === candidates[0].id ? ("add" as const) : ("skip" as const),
      ]),
    );
    const result = applyPresetSelectionDocument(
      { roles: [], raw, revision: REVISIONS.roles },
      snapshot(rows),
      selected,
      LATER,
    );
    expect(result.document.futureDoc).toEqual({ keep: true });
    const written = result.document.roles;
    expect(Array.isArray(written)).toBe(true);
    if (Array.isArray(written)) {
      expect(written[0]).toBe(unrelated);
      expect(written).toHaveLength(2);
      expect(written[1]).toMatchObject({ id: candidates[0].id, source: "preset" });
    }
    expect(result.roles).toEqual([expect.objectContaining({ id: candidates[0].id })]);
  });

  test("default selection appends only the 12 missing presets; all 13 existing Roles are byte-identical", () => {
    const current = [
      ...originals
        .slice(0, 10)
        .map((entry, index) =>
          index < 2 ? { ...entry, systemPrompt: "User edits", custom: { keep: true } } : entry,
        ),
      architect,
      role({ id: "custom-one", name: "One" }),
      role({ id: "custom-two", name: "Two" }),
    ];
    const snapshots = current.map((entry) => JSON.stringify(entry));
    const result = apply(current, diff(current));
    expect(result).toHaveLength(25);
    expect(result.slice(0, current.length).map((entry) => JSON.stringify(entry))).toEqual(
      snapshots,
    );
    for (const [index, entry] of current.entries()) expect(result[index]).toBe(entry);
    expect(current).toHaveLength(13);
  });

  test("an explicit adoption preserves createdAt, rebinds Profiles, and updates origin/hashes", () => {
    const old = exampleCatalog([], NOW).roles[0];
    const current = [
      { ...old, systemPrompt: "Modified", extension: "keep on adoption" },
      architect,
    ];
    const rows = diff(current);
    expect(rows[0].changedFields).toEqual([
      "extension",
      "fallbackProfiles",
      "preferredProfiles",
      "systemPrompt",
    ]);
    const selection = Object.fromEntries(
      rows.map((row) => [row.id, row.id === old.id ? ("adopt" as const) : ("skip" as const)]),
    );
    const result = apply(current, rows, selection);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      ...candidates[0],
      createdAt: NOW,
      updatedAt: LATER,
      extension: "keep on adoption",
    });
    // Extensions are outside the preset baseline, so the applied hash stays the candidate's and
    // the next preview reports them as a local difference.
    expect(result[0].preset?.appliedHash).toBe(candidates[0].preset?.appliedHash);
    expect(result[0].preset?.importedAt).toBe(LATER);
    expect(result[0].preferredProfiles[0].profileId).toBe(
      candidates[0].preferredProfiles[0].profileId,
    );
    expect(result[1]).toBe(architect);
    expect(current[0].systemPrompt).toBe("Modified");
  });

  test("a matching revision changes only the selected rows", () => {
    const current = [originals[0], originals[1], architect];
    const before = current.map((entry) => JSON.stringify(entry));
    const result = apply(current, diff(current), { [originals[0].id]: "adopt" });
    expect(JSON.stringify(result[1])).toBe(before[1]);
    expect(JSON.stringify(result[2])).toBe(before[2]);
    expect(result[1]).toBe(current[1]);
    expect(result[2]).toBe(current[2]);
    expect(result[0].preset?.importedAt).toBe(LATER);
    expect(result[0].updatedAt).toBe(LATER);
  });

  test("merge and sync require the revisions the preview was read at", () => {
    const rows = diff([originals[0]]);
    expect(() =>
      applyPresetSelection(
        { roles: [originals[0]], revision: "stale-roles" },
        snapshot(rows),
        { [originals[0].id]: "adopt" },
        LATER,
      ),
    ).toThrow("目录已被更新");
    expect(() =>
      recordPresetSync(
        { values: PreferencesSchema.parse({}), revision: "stale-preferences" },
        snapshot(rows),
        [originals[0]],
        "new",
        LATER,
      ),
    ).toThrow("目录已被更新");
    const selection = Object.fromEntries(
      rows.map((row) => [
        row.id,
        row.id === originals[0].id ? ("adopt" as const) : ("skip" as const),
      ]),
    );
    const result = apply([originals[0]], rows, selection);
    expect(result).toHaveLength(1);
    expect(result[0].preset?.importedAt).toBe(LATER);
    expect(sync(PreferencesSchema.parse({}), [originals[0]], rows)).toMatchObject({
      templatesImportedAt: LATER,
    });
  });

  test("deleted presets are opt-in; skipped missing rows are not added; order stays stable", () => {
    const rows = diff([], [candidates[0].id]);
    const selected = Object.fromEntries(
      rows.map((row) => [
        row.id,
        row.id === candidates[0].id ? ("add" as const) : ("skip" as const),
      ]),
    );
    const result = apply([], rows, selected);
    expect(result).toEqual([candidates[0]]);
    expect(apply([], rows).map((entry) => entry.id)).not.toContain(candidates[0].id);
  });

  test("adoption keeps the row's unknown fields and designer while the preset wins", () => {
    const collision = RoleSchema.parse({
      ...role({ id: candidates[0].id, name: "Local" }),
      futureTop: { keep: true },
      designer: { jobId: "designer-job" },
    });
    const rows = diff([collision]);
    const selection = Object.fromEntries(
      rows.map((row) => [row.id, row.id === collision.id ? ("adopt" as const) : ("skip" as const)]),
    );
    const result = apply([collision], rows, selection);
    expect(result[0]).toMatchObject({
      id: candidates[0].id,
      name: candidates[0].name,
      source: "preset",
      futureTop: { keep: true },
      designer: { jobId: "designer-job" },
    });
    expect(result[0]?.preset?.templateId).toBe(candidates[0].id);
  });

  test("explicit adoption of a reviewed ID collision is possible, default still keeps it", () => {
    const collision = role({ id: candidates[0].id, name: "Local" });
    const result = apply([collision], diff([collision]), { [collision.id]: "adopt" });
    expect(result[0]).toEqual({ ...candidates[0], createdAt: NOW });
  });

  test("merge rejects selected stale rows, unexpected occupied IDs, and mismatched candidates", () => {
    const rows = diff([originals[0]]);
    expect(() =>
      apply([{ ...originals[0], updatedAt: "another writer" }], rows, {
        [originals[0].id]: "adopt",
      }),
    ).toThrow("目录已被更新");
    expect(() => apply([originals[0]], diff([]))).toThrow("目录已被更新");
    const missing = diff([])[0];
    expect(() => apply([], [{ ...missing, candidate: candidates[1] }])).toThrow("目录已被更新");
    expect(() => apply([], [{ ...missing, candidate: architect }])).toThrow("目录已被更新");
    expect(() => apply([], [missing], { [missing.id]: "adopt" })).toThrow("选择无效");
    expect(() => apply([originals[0]], [rows[0]], { [rows[0].id]: "add" })).toThrow("选择无效");
  });

  test("sync preferences deduplicate history, recover origins, and retain unrelated preferences", () => {
    const preferences = PreferencesSchema.parse({
      maxMembers: 12,
      archiveOnLaunchFailure: false,
      defaultPresets: { catalogRevision: "old", seenRoleIds: ["deleted-role", originals[0].id] },
    });
    const next = sync(
      preferences,
      [originals[0], originals[1], architect],
      diff([originals[0], originals[1], architect]),
    );
    expect(next).toEqual({
      ...preferences,
      templatesImportedAt: LATER,
      defaultPresets: {
        catalogRevision: "new",
        seenRoleIds: ["deleted-role", originals[0].id, originals[1].id],
        lastSyncedAt: LATER,
      },
    });
    expect(sync(next, [originals[1]], diff([originals[1]]), NOW).templatesImportedAt).toBe(LATER);
    const recovered = sync(PreferencesSchema.parse({}), [originals[0]], diff([originals[0]]), NOW);
    expect(recovered.defaultPresets?.seenRoleIds).toEqual([originals[0].id]);
    const changedId = { ...originals[0], id: "renamed-role" };
    expect(
      sync(PreferencesSchema.parse({}), [changedId], diff([changedId]), NOW).defaultPresets
        ?.seenRoleIds,
    ).toEqual([]);
    const tooMany = PreferencesSchema.parse({
      defaultPresets: {
        catalogRevision: "old",
        seenRoleIds: Array.from(
          { length: MAX_SEEN_PRESET_ROLE_IDS },
          (_, index) => `role-${index}`,
        ),
      },
    });
    const truncated = sync(tooMany, [originals[0]], diff([originals[0]]), NOW);
    expect(truncated.defaultPresets?.seenRoleIds).toHaveLength(MAX_SEEN_PRESET_ROLE_IDS);
    expect(truncated.defaultPresets?.seenRoleIds[0]).toBe("role-1");
    expect(truncated.defaultPresets?.seenRoleIds.at(-1)).toBe(originals[0].id);
  });

  test("sync records only marked origins and present same rows", () => {
    const unmarked = originals.map(({ source: _source, preset: _preset, ...entry }) => entry);
    const empty = PreferencesSchema.parse({});
    const rows = diff(unmarked);
    expect(rows.every((row) => row.kind === "same")).toBe(true);
    expect(sync(empty, [unmarked[0], unmarked[1]], rows).defaultPresets?.seenRoleIds).toEqual([
      unmarked[0].id,
      unmarked[1].id,
    ]);
    // Without the preview rows an unmarked Role is not evidence of a preset origin.
    expect(sync(empty, [unmarked[0]]).defaultPresets?.seenRoleIds).toEqual([]);
    // A user-built Role that reuses a preset id stays a conflict and is never marked seen.
    const collision = role({ id: candidates[0].id, name: "Local" });
    expect(diff([collision])[0].kind).toBe("id-collision");
    expect(sync(empty, [collision], diff([collision])).defaultPresets?.seenRoleIds).toEqual([]);
    // A same row whose Role was removed before the write is not recorded either.
    expect(sync(empty, [], rows).defaultPresets?.seenRoleIds).toEqual([]);
  });
});

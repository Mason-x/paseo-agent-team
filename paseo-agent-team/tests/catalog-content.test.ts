import { describe, expect, test } from "vitest";
import { exampleCatalog } from "../server/templates";
import { hashCatalogContent } from "../server/templates/hash";
import {
  applyPresetSelection,
  canonicalize,
  changedCatalogFields,
  diffPresetRoles,
  recordPresetSync,
} from "../shared/domain/catalog-content";
import { PreferencesSchema } from "../shared/schemas/preferences";
import type { Role } from "../shared/schemas/role";
import { sourceProfiles } from "./default-presets.fixtures";
import { architect, NOW, role } from "./fixtures";

const LATER = "2026-10-25T12:00:00.000Z";
const candidates = exampleCatalog(sourceProfiles, LATER).roles;
const originals = exampleCatalog(sourceProfiles, NOW).roles;
const hashes = (roles: readonly Role[]) =>
  Object.fromEntries(roles.map((role) => [role.id, hashCatalogContent(role)]));
const diff = (roles: Role[], seen: string[] = []) =>
  diffPresetRoles(roles, candidates, seen, hashes(roles));

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
    // A user-owned ID is a conflict even when its content happens to equal the preset.
    const { source: _source, preset: _preset, ...userRole } = originals[0];
    expect(diff([userRole])[0]).toMatchObject({
      kind: "id-collision",
      changedFields: [],
      defaultAction: "keep",
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
    const result = applyPresetSelection(current, diff(current), {}, LATER);
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
      { ...old, systemPrompt: "Modified", extension: "remove on adoption" },
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
    const result = applyPresetSelection(current, rows, selection, LATER);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ ...candidates[0], createdAt: NOW, updatedAt: LATER });
    expect(result[0].preset?.appliedHash).toBe(hashCatalogContent(result[0]));
    expect(result[0].preferredProfiles[0].profileId).toBe(
      candidates[0].preferredProfiles[0].profileId,
    );
    expect(result[1]).toBe(architect);
    expect(current[0].systemPrompt).toBe("Modified");
  });

  test("deleted presets are opt-in; skipped missing rows are not added; order stays stable", () => {
    const rows = diff([], [candidates[0].id]);
    const selected = Object.fromEntries(
      rows.map((row) => [
        row.id,
        row.id === candidates[0].id ? ("add" as const) : ("skip" as const),
      ]),
    );
    const result = applyPresetSelection([], rows, selected, LATER);
    expect(result).toEqual([candidates[0]]);
    expect(applyPresetSelection([], rows, {}, LATER).map((entry) => entry.id)).not.toContain(
      candidates[0].id,
    );
  });

  test("explicit adoption of a reviewed ID collision is possible, default still keeps it", () => {
    const collision = role({ id: candidates[0].id, name: "Local" });
    const result = applyPresetSelection(
      [collision],
      diff([collision]),
      { [collision.id]: "adopt" },
      LATER,
    );
    expect(result[0]).toEqual({ ...candidates[0], createdAt: NOW });
  });

  test("merge rejects selected stale rows, unexpected occupied IDs, and mismatched candidates", () => {
    const rows = diff([originals[0]]);
    expect(() =>
      applyPresetSelection(
        [{ ...originals[0], updatedAt: "another writer" }],
        rows,
        { [originals[0].id]: "adopt" },
        LATER,
      ),
    ).toThrow("目录已被更新");
    expect(() => applyPresetSelection([originals[0]], diff([]), {}, LATER)).toThrow("目录已被更新");
    const missing = diff([])[0];
    expect(() =>
      applyPresetSelection([], [{ ...missing, candidate: candidates[1] }], {}, LATER),
    ).toThrow("目录已被更新");
    expect(() =>
      applyPresetSelection([], [{ ...missing, candidate: architect }], {}, LATER),
    ).toThrow("目录已被更新");
    expect(() => applyPresetSelection([], [missing], { [missing.id]: "adopt" }, LATER)).toThrow(
      "选择无效",
    );
    expect(() =>
      applyPresetSelection([originals[0]], [rows[0]], { [rows[0].id]: "add" }, LATER),
    ).toThrow("选择无效");
  });

  test("sync preferences deduplicate history, recover origins, and retain unrelated preferences", () => {
    const preferences = PreferencesSchema.parse({
      maxMembers: 12,
      archiveOnLaunchFailure: false,
      defaultPresets: { catalogRevision: "old", seenRoleIds: ["deleted-role", originals[0].id] },
    });
    const next = recordPresetSync(
      preferences,
      [originals[0], originals[1], architect],
      "new",
      LATER,
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
    expect(recordPresetSync(next, [originals[1]], "new", NOW).templatesImportedAt).toBe(LATER);
    const recovered = recordPresetSync(PreferencesSchema.parse({}), [originals[0]], "new", NOW);
    expect(recovered.defaultPresets?.seenRoleIds).toEqual([originals[0].id]);
    const changedId = { ...originals[0], id: "renamed-role" };
    expect(
      recordPresetSync(PreferencesSchema.parse({}), [changedId], "new", NOW).defaultPresets
        ?.seenRoleIds,
    ).toEqual([]);
    const tooMany = PreferencesSchema.parse({
      defaultPresets: {
        catalogRevision: "old",
        seenRoleIds: Array.from({ length: 1000 }, (_, index) => `role-${index}`),
      },
    });
    expect(() => recordPresetSync(tooMany, [originals[0]], "new", NOW)).toThrow();
  });
});

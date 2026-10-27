import { describe, expect, test, vi } from "vitest";
import {
  importDefaultPresets,
  type PresetGateway,
  type PreviewSuccess,
  retryPresetPreferences,
  syncDefaultPresets,
} from "../client/catalog/preset-service";
import { defaultPresetSelection } from "../client/catalog/preset-state";
import { exampleCatalog } from "../server/templates";
import type { Preferences } from "../shared/schemas/preferences";
import { PreferencesSchema } from "../shared/schemas/preferences";
import type { Role } from "../shared/schemas/role";
import { RolesDocumentSchema } from "../shared/settings";
import { zh } from "../shared/zh";
import { sourceProfiles } from "./default-presets.fixtures";
import { architect, NOW } from "./fixtures";

const candidates = exampleCatalog(sourceProfiles, NOW).roles.slice(0, 2);

function preview(
  revisions: { roles: string; preferences: string } = { roles: "r1", preferences: "p1" },
): PreviewSuccess {
  return {
    ok: true,
    catalogRevision: "catalog-1",
    generatedAt: NOW,
    revisions,
    roles: candidates.map((candidate) => ({
      id: candidate.id,
      kind: "missing",
      candidate,
      changedFields: [],
      templateChanged: false,
      locallyChanged: false,
      defaultAction: "add",
    })),
    bindingReport: [],
    warnings: [],
  };
}

const preferences: Preferences = PreferencesSchema.parse({
  maxMembers: 3,
  recentRuns: [],
});

function readyRoles(roles: readonly Role[], revision: string, raw: unknown = { roles }) {
  return {
    status: "ready" as const,
    values: RolesDocumentSchema.parse({ roles }),
    raw,
    revision,
  };
}

function readyPreferences(values: Preferences, revision: string) {
  return { status: "ready" as const, values, raw: values, revision };
}

function gateway(overrides: Partial<PresetGateway> = {}): PresetGateway {
  return {
    preview: vi.fn(async () => preview()),
    readRoles: vi.fn(async () => readyRoles([], "r1")),
    readPreferences: vi.fn(async () => readyPreferences(preferences, "p1")),
    saveRolesDocument: vi.fn(async () => "saved" as const),
    savePreferences: vi.fn(async () => "saved" as const),
    reloadRoles: vi.fn(async () => undefined),
    reloadPreferences: vi.fn(async () => undefined),
    ...overrides,
  };
}

const importOptions = { allowUnbound: false, onlyWhenUnimported: true, now: NOW };

describe("first-open import", () => {
  test("writes Roles once, then the preferences record", async () => {
    const fake = gateway();
    const result = await importDefaultPresets(fake, importOptions);
    expect(result.kind).toBe("imported");
    expect(fake.preview).toHaveBeenCalledWith(false);
    expect(fake.saveRolesDocument).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(fake.saveRolesDocument).mock.calls[0];
    expect(saved?.[0].roles).toHaveLength(2);
    expect(saved?.[1]).toBe("r1");
    expect(fake.savePreferences).toHaveBeenCalledTimes(1);
    const prefs = vi.mocked(fake.savePreferences).mock.calls[0]?.[0];
    expect(prefs?.templatesImportedAt).toBe(NOW);
    expect(prefs?.defaultPresets?.catalogRevision).toBe("catalog-1");
    expect(prefs?.defaultPresets?.seenRoleIds).toEqual(candidates.map((role) => role.id));
  });

  test("does nothing when history says the user already imported", async () => {
    const fake = gateway({
      readPreferences: vi.fn(async () =>
        readyPreferences(
          PreferencesSchema.parse({ ...preferences, templatesImportedAt: NOW }),
          "p1",
        ),
      ),
    });
    expect(await importDefaultPresets(fake, importOptions)).toEqual({ kind: "already-present" });
    expect(fake.saveRolesDocument).not.toHaveBeenCalled();
    expect(fake.savePreferences).not.toHaveBeenCalled();
  });

  test("does nothing when another window created Roles first", async () => {
    const fake = gateway({
      readRoles: vi.fn(async () => readyRoles(candidates, "r1")),
    });
    expect(await importDefaultPresets(fake, importOptions)).toEqual({ kind: "already-present" });
    expect(fake.saveRolesDocument).not.toHaveBeenCalled();
  });

  test("reports a Profile read failure as forceable instead of writing", async () => {
    const fake = gateway({
      preview: vi.fn(async () => ({
        ok: false as const,
        blockers: [
          {
            code: "profiles-unavailable" as const,
            message: "无法读取 Profile",
          },
        ],
      })),
    });
    const result = await importDefaultPresets(fake, importOptions);
    expect(result).toMatchObject({ kind: "blocked", canForce: true });
    expect(fake.saveRolesDocument).not.toHaveBeenCalled();
  });

  test("re-previews when a document moved between the preview and the write", async () => {
    const fake = gateway({
      preview: vi
        .fn<PresetGateway["preview"]>()
        .mockResolvedValueOnce(preview({ roles: "r1", preferences: "p1" }))
        .mockResolvedValueOnce(preview({ roles: "r2", preferences: "p1" })),
      readRoles: vi.fn(async () => readyRoles([], "r2")),
    });
    const result = await importDefaultPresets(fake, importOptions);
    expect(result.kind).toBe("imported");
    expect(fake.preview).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fake.saveRolesDocument).mock.calls[0]?.[1]).toBe("r2");
  });

  test("a Roles conflict observes the other import and does not write preferences", async () => {
    const fake = gateway({
      saveRolesDocument: vi.fn(async () => "conflict" as const),
      readRoles: vi
        .fn<PresetGateway["readRoles"]>()
        .mockResolvedValueOnce(readyRoles([], "r1"))
        .mockResolvedValueOnce(readyRoles(candidates, "r2")),
    });
    expect(await importDefaultPresets(fake, importOptions)).toEqual({ kind: "already-present" });
    expect(fake.savePreferences).not.toHaveBeenCalled();
  });

  test("an invalid Roles write is not treated as another window's import", async () => {
    const fake = gateway({ saveRolesDocument: vi.fn(async () => "invalid" as const) });
    const result = await importDefaultPresets(fake, importOptions);
    expect(result).toMatchObject({ kind: "failed", message: zh.defaultPresetsInvalidData });
    expect(fake.savePreferences).not.toHaveBeenCalled();
  });

  test("a preferences conflict only rewrites preferences", async () => {
    let revision = "p1";
    let saves = 0;
    const fake = gateway({
      readPreferences: vi.fn(async () => readyPreferences(preferences, revision)),
      savePreferences: vi.fn(async () => {
        saves += 1;
        if (saves === 1) {
          revision = "p2";
          return "conflict";
        }
        return "saved";
      }),
    });
    expect((await importDefaultPresets(fake, importOptions)).kind).toBe("imported");
    expect(fake.saveRolesDocument).toHaveBeenCalledTimes(1);
    expect(fake.savePreferences).toHaveBeenCalledTimes(2);
    const retried = vi.mocked(fake.savePreferences).mock.calls[1]?.[0];
    expect(retried?.maxMembers).toBe(3);
    expect(retried?.defaultPresets?.seenRoleIds).toEqual(candidates.map((role) => role.id));
  });

  test("reports a preferences failure after the Roles write", async () => {
    const fake = gateway({ savePreferences: vi.fn(async () => "conflict" as const) });
    const result = await importDefaultPresets(fake, importOptions);
    expect(result).toMatchObject({ kind: "preferences-failed" });
    if (result.kind === "preferences-failed") {
      expect(result.roles).toHaveLength(2);
    }
    expect(fake.saveRolesDocument).toHaveBeenCalledTimes(1);
    expect(fake.savePreferences).toHaveBeenCalledTimes(2);
  });

  test("the manual retry writes only preferences", async () => {
    const fake = gateway();
    const current = preview();
    const roles = candidates;
    expect(await retryPresetPreferences(fake, current, roles, NOW)).toBe("saved");
    expect(fake.saveRolesDocument).not.toHaveBeenCalled();
    expect(fake.savePreferences).toHaveBeenCalledTimes(1);
  });
});

function sameContentPreview(
  roles: readonly Role[],
  revisions = { roles: "r1", preferences: "p1" },
): PreviewSuccess {
  return {
    ok: true,
    catalogRevision: "catalog-1",
    generatedAt: NOW,
    revisions,
    roles: roles.map((candidate) => ({
      id: candidate.id,
      kind: "same",
      candidate,
      before: candidate,
      changedFields: [],
      templateChanged: false,
      locallyChanged: false,
      defaultAction: "keep",
    })),
    bindingReport: [],
    warnings: [],
  };
}

function rolesSnapshot(roles: readonly Role[], revision: string) {
  return readyRoles(roles, revision);
}

describe("default preset sync", () => {
  test("writes only selected rows onto the raw document, preserving unrelated data", async () => {
    const unrelated = { ...architect, futureRoleKey: "keep" };
    const rawDocument = {
      roles: [unrelated],
      futureDocKey: { keep: true },
    };
    const fake = gateway({
      readRoles: vi.fn(async () => readyRoles([unrelated], "r1", rawDocument)),
      saveRolesDocument: vi.fn(async () => "saved" as const),
    });
    const current = preview();
    const selection = defaultPresetSelection(current.roles);

    const result = await syncDefaultPresets(fake, { preview: current, selection, now: NOW });
    expect(result).toMatchObject({ kind: "synced", wroteRoles: true });
    const savedDocument = vi.mocked(fake.saveRolesDocument).mock.calls[0]?.[0];
    expect(savedDocument?.futureDocKey).toEqual({ keep: true });
    const savedRoles =
      savedDocument && Array.isArray(savedDocument.roles) ? savedDocument.roles : [];
    expect(savedRoles[0]).toEqual(unrelated);
    expect(savedRoles).toHaveLength(3);
    expect(vi.mocked(fake.saveRolesDocument).mock.calls[0]?.[1]).toBe("r1");
  });
  test("applies the selected rows and records the sync", async () => {
    const fake = gateway();
    const current = preview();
    const selection = defaultPresetSelection(current.roles);
    const result = await syncDefaultPresets(fake, { preview: current, selection, now: NOW });
    expect(result).toMatchObject({ kind: "synced", wroteRoles: true });
    expect(fake.saveRolesDocument).toHaveBeenCalledTimes(1);
    expect(fake.savePreferences).toHaveBeenCalledTimes(1);
  });

  test("skips the Roles write when every row is kept", async () => {
    const current = preview();
    const selection = Object.fromEntries(current.roles.map((row) => [row.id, "skip" as const]));
    const fake = gateway();
    const result = await syncDefaultPresets(fake, { preview: current, selection, now: NOW });
    expect(result).toMatchObject({ kind: "synced", wroteRoles: false });
    expect(fake.saveRolesDocument).not.toHaveBeenCalled();
    expect(fake.savePreferences).toHaveBeenCalledTimes(1);
  });

  test("a moved Roles revision re-previews and requires confirmation", async () => {
    const initial = preview({ roles: "r1", preferences: "p1" });
    const fresh = preview({ roles: "r2", preferences: "p1" });
    const fake = gateway({
      preview: vi.fn(async () => fresh),
      readRoles: vi.fn(async () => rolesSnapshot([], "r2")),
    });
    const result = await syncDefaultPresets(fake, {
      preview: initial,
      selection: { [initial.roles[0]?.id ?? ""]: "skip" },
      now: NOW,
    });
    expect(result.kind).toBe("needs-confirmation");
    if (result.kind === "needs-confirmation") {
      expect(result.selection[initial.roles[0]?.id ?? ""]).toBe("skip");
    }
    expect(fake.reloadRoles).toHaveBeenCalled();
    expect(fake.saveRolesDocument).not.toHaveBeenCalled();
  });

  test("a Roles save conflict re-previews without writing preferences", async () => {
    const initial = preview();
    const fresh = preview({ roles: "r2", preferences: "p1" });
    const fake = gateway({
      preview: vi.fn(async () => fresh),
      saveRolesDocument: vi.fn(async () => "conflict" as const),
    });
    const result = await syncDefaultPresets(fake, {
      preview: initial,
      selection: { [initial.roles[0]?.id ?? ""]: "skip" },
      now: NOW,
    });
    expect(result.kind).toBe("needs-confirmation");
    if (result.kind === "needs-confirmation") {
      expect(result.selection[initial.roles[0]?.id ?? ""]).toBe("skip");
    }
    expect(fake.savePreferences).not.toHaveBeenCalled();
  });

  test("a preferences conflict after a Roles write never writes Roles twice", async () => {
    let revision = "p1";
    let saves = 0;
    const fake = gateway({
      readPreferences: vi.fn(async () => readyPreferences(preferences, revision)),
      savePreferences: vi.fn(async () => {
        saves += 1;
        if (saves === 1) {
          revision = "p2";
          return "conflict";
        }
        return "saved";
      }),
    });
    const current = preview();
    const result = await syncDefaultPresets(fake, {
      preview: current,
      selection: defaultPresetSelection(current.roles),
      now: NOW,
    });
    expect(result.kind).toBe("synced");
    expect(fake.saveRolesDocument).toHaveBeenCalledTimes(1);
    expect(fake.savePreferences).toHaveBeenCalledTimes(2);
  });

  test("reports preferences failure only after the Roles write", async () => {
    const fake = gateway({ savePreferences: vi.fn(async () => "failed" as const) });
    const current = preview();
    const result = await syncDefaultPresets(fake, {
      preview: current,
      selection: defaultPresetSelection(current.roles),
      now: NOW,
    });
    expect(result).toMatchObject({ kind: "failed", rolesImported: true });
    expect(fake.saveRolesDocument).toHaveBeenCalledTimes(1);
  });

  test("an invalid Roles write is not reported as a catalog conflict", async () => {
    const fake = gateway({ saveRolesDocument: vi.fn(async () => "invalid" as const) });
    const current = preview();
    const result = await syncDefaultPresets(fake, {
      preview: current,
      selection: defaultPresetSelection(current.roles),
      now: NOW,
    });
    expect(result).toMatchObject({ kind: "failed", rolesImported: false });
    if (result.kind === "failed") expect(result.message).toBe(zh.defaultPresetsInvalidData);
    expect(fake.savePreferences).not.toHaveBeenCalled();
  });

  test("an invalid preferences write is not retried as a conflict", async () => {
    const fake = gateway({ savePreferences: vi.fn(async () => "invalid" as const) });
    const result = await importDefaultPresets(fake, importOptions);
    expect(result).toMatchObject({ kind: "preferences-failed" });
    if (result.kind === "preferences-failed") {
      expect(result.message).toBe(zh.defaultPresetsPreferencesInvalid);
    }
    expect(fake.savePreferences).toHaveBeenCalledTimes(1);
  });

  test("does not touch anything when the Roles document is invalid", async () => {
    const fake = gateway({
      readRoles: vi.fn(async () => ({
        status: "invalid" as const,
        error: "broken",
      })),
    });
    const current = preview();
    const result = await syncDefaultPresets(fake, {
      preview: current,
      selection: defaultPresetSelection(current.roles),
      now: NOW,
    });
    expect(result).toMatchObject({ kind: "failed", rolesImported: false });
    expect(fake.saveRolesDocument).not.toHaveBeenCalled();
    expect(fake.savePreferences).not.toHaveBeenCalled();
  });

  test("same-content previews keep every row", async () => {
    const current = sameContentPreview(candidates);
    expect(defaultPresetSelection(current.roles)).toEqual(
      Object.fromEntries(candidates.map((role) => [role.id, "keep"])),
    );
  });

  test("two concurrent first-open imports leave one Role set and one preferences write", async () => {
    const allCandidates = exampleCatalog(sourceProfiles, NOW).roles;
    let roles: Role[] = [];
    let storedPreferences = preferences;
    let rolesRevision = "1";
    let preferencesRevision = "1";
    let preferenceWrites = 0;
    const currentPreview = (): PreviewSuccess => ({
      ok: true,
      catalogRevision: "catalog-1",
      generatedAt: NOW,
      revisions: { roles: rolesRevision, preferences: preferencesRevision },
      roles: allCandidates.map((candidate) => ({
        id: candidate.id,
        kind: "missing",
        candidate,
        changedFields: [],
        templateChanged: false,
        locallyChanged: false,
        defaultAction: "add",
      })),
      bindingReport: [],
      warnings: [],
    });
    const fake: PresetGateway = {
      preview: vi.fn(async () => currentPreview()),
      readRoles: vi.fn(async () => rolesSnapshot(roles, rolesRevision)),
      readPreferences: vi.fn(async () => readyPreferences(storedPreferences, preferencesRevision)),
      saveRolesDocument: vi.fn(async (values, revision) => {
        if (revision !== rolesRevision) return "conflict";
        const nextRoles = values.roles;
        if (!Array.isArray(nextRoles)) return "invalid";
        roles = nextRoles as Role[];
        rolesRevision = String(Number(rolesRevision) + 1);
        return "saved";
      }),
      savePreferences: vi.fn(async (values, revision) => {
        if (revision !== preferencesRevision) return "conflict";
        storedPreferences = values;
        preferencesRevision = String(Number(preferencesRevision) + 1);
        preferenceWrites += 1;
        return "saved";
      }),
      reloadRoles: vi.fn(async () => undefined),
      reloadPreferences: vi.fn(async () => undefined),
    };

    const results = await Promise.all([
      importDefaultPresets(fake, importOptions),
      importDefaultPresets(fake, importOptions),
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual(["already-present", "imported"]);
    expect(roles).toHaveLength(13);
    expect(new Set(roles.map((role) => role.id)).size).toBe(13);
    expect(preferenceWrites).toBe(1);
    expect(storedPreferences.defaultPresets?.seenRoleIds).toHaveLength(13);
  });
});

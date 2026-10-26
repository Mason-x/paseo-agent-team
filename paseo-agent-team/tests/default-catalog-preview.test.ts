import { describe, expect, test, vi } from "vitest";
import { exampleCatalog, previewDefaultCatalog } from "../server/templates";
import { DefaultCatalogPreviewResultSchema } from "../shared/schemas/default-catalog";
import { PreferencesSchema } from "../shared/schemas/preferences";
import { sourceProfiles } from "./default-presets.fixtures";
import { NOW } from "./fixtures";

function readyDeps() {
  return {
    roles: {
      read: vi.fn(async () => ({
        status: "ready" as const,
        revision: "roles-rev",
        values: { roles: [] },
      })),
    },
    preferences: {
      read: vi.fn(async () => ({
        status: "ready" as const,
        revision: "prefs-rev",
        values: PreferencesSchema.parse({}),
      })),
    },
    listProfiles: vi.fn(async () => sourceProfiles),
    now: () => NOW,
  };
}

describe("default catalog preview", () => {
  test("returns fresh revisions, full typed rows/report, no Profile notes, and no settings writes", async () => {
    const deps = readyDeps();
    const preview = await previewDefaultCatalog({ allowUnboundOnProfileError: false }, deps);
    expect(DefaultCatalogPreviewResultSchema.parse(preview)).toEqual(preview);
    expect(preview).toMatchObject({
      ok: true,
      generatedAt: NOW,
      revisions: { roles: "roles-rev", preferences: "prefs-rev" },
      warnings: [],
    });
    if (!preview.ok) throw new Error("unexpected blocked preview");
    expect(preview.roles).toHaveLength(23);
    expect(
      preview.roles.every((row) => row.kind === "missing" && row.defaultAction === "add"),
    ).toBe(true);
    expect(preview.bindingReport.length).toBeGreaterThan(23);
    expect(preview.bindingReport.every((entry) => entry.method === "exact")).toBe(true);
    expect(JSON.stringify(preview)).not.toContain('"notes"');
    expect(deps.roles.read).toHaveBeenCalledTimes(1);
    expect(deps.preferences.read).toHaveBeenCalledTimes(1);
  });

  test("Profile failure blocks by default, and explicit manual opt-in produces unbound Roles", async () => {
    const deps = readyDeps();
    deps.listProfiles.mockRejectedValue(new Error("config offline"));
    expect(await previewDefaultCatalog({ allowUnboundOnProfileError: false }, deps)).toEqual({
      ok: false,
      blockers: [
        { code: "profiles-unavailable", message: expect.stringContaining("无法读取 Profile") },
      ],
    });
    const preview = await previewDefaultCatalog({ allowUnboundOnProfileError: true }, deps);
    expect(DefaultCatalogPreviewResultSchema.parse(preview)).toEqual(preview);
    if (!preview.ok) throw new Error("manual import should be available");
    expect(preview.warnings).toContain("无法读取 Profile，已全部标为未绑定。");
    expect(
      preview.bindingReport.every(
        (entry) => entry.method === "unbound" && entry.reason === "missing",
      ),
    ).toBe(true);
    expect(
      preview.roles.every((row) =>
        [...row.candidate.preferredProfiles, ...row.candidate.fallbackProfiles].every((ref) =>
          ref.profileId.startsWith("unbound:default:"),
        ),
      ),
    ).toBe(true);
  });

  test("an actually empty host is a valid preview without a Profile read-error warning", async () => {
    const deps = readyDeps();
    deps.listProfiles.mockResolvedValue([]);
    const preview = await previewDefaultCatalog({ allowUnboundOnProfileError: false }, deps);
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.warnings.join(" ")).toContain("未绑定");
      expect(preview.warnings.join(" ")).not.toContain("无法读取");
    }
  });

  test("reports unique runtime renames and leaves ambiguous twins unbound", async () => {
    const deps = readyDeps();
    deps.listProfiles.mockResolvedValue(
      sourceProfiles.map((profile) => ({ ...profile, name: `Renamed ${profile.id}` })),
    );
    const preview = await previewDefaultCatalog({ allowUnboundOnProfileError: false }, deps);
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.warnings.join(" ")).toContain("按唯一运行配置匹配");
      expect(preview.bindingReport.some((entry) => entry.reason === "ambiguous")).toBe(true);
    }
  });

  test("invalid documents block preview and Profile reads even with manual opt-in", async () => {
    const deps = readyDeps();
    const preview = await previewDefaultCatalog(
      { allowUnboundOnProfileError: true },
      {
        ...deps,
        roles: { read: async () => ({ status: "invalid", revision: "bad", error: "bad roles" }) },
        preferences: {
          read: async () => ({ status: "invalid", revision: "bad", error: "bad preferences" }),
        },
      },
    );
    expect(preview).toEqual({
      ok: false,
      blockers: [
        { code: "settings-invalid", document: "roles", message: "bad roles" },
        { code: "settings-invalid", document: "preferences", message: "bad preferences" },
      ],
    });
    expect(deps.listProfiles).not.toHaveBeenCalled();
  });

  test("settings read failures return explicit blockers instead of treating documents as empty", async () => {
    const deps = readyDeps();
    deps.roles.read.mockRejectedValue(new Error("disk offline"));
    deps.preferences.read.mockRejectedValue(new Error("disk offline"));
    expect(await previewDefaultCatalog({ allowUnboundOnProfileError: false }, deps)).toEqual({
      ok: false,
      blockers: [
        { code: "settings-unavailable", document: "roles", message: expect.any(String) },
        { code: "settings-unavailable", document: "preferences", message: expect.any(String) },
      ],
    });
    expect(deps.listProfiles).not.toHaveBeenCalled();
  });

  test("uses current Roles and deletion preferences, and can use the system clock", async () => {
    const deps = readyDeps();
    const preview = await previewDefaultCatalog(
      { allowUnboundOnProfileError: false },
      {
        ...deps,
        now: undefined,
        roles: {
          read: async () => ({
            status: "ready",
            revision: "new-roles",
            values: { roles: [exampleCatalog(sourceProfiles, NOW).roles[0]] },
          }),
        },
        preferences: {
          read: async () => ({
            status: "ready",
            revision: "new-prefs",
            values: PreferencesSchema.parse({
              defaultPresets: { catalogRevision: "old", seenRoleIds: ["lead-tech"] },
            }),
          }),
        },
      },
    );
    if (!preview.ok) throw new Error("unexpected blocked preview");
    expect(Date.parse(preview.generatedAt)).not.toBeNaN();
    expect(preview.revisions).toEqual({ roles: "new-roles", preferences: "new-prefs" });
    expect(preview.roles[0].kind).toBe("same");
    expect(preview.roles.find((row) => row.id === "lead-tech")).toMatchObject({
      kind: "deleted",
      defaultAction: "skip",
    });
  });
});

import { describe, expect, test } from "vitest";
import {
  allowedPresetActions,
  autoImportAttemptKey,
  carryPresetSelection,
  countBindingReport,
  countPresetActions,
  defaultPresetSelection,
  resolveEmptyCatalogMode,
  selectionNeedsRoleWrite,
} from "../client/catalog/preset-state";
import type { BindingReportEntry, PresetRolePreview } from "../shared/schemas/default-catalog";
import { DEFAULT_CATALOG_ID } from "../shared/schemas/default-catalog";
import { NOW, role } from "./fixtures";

const candidate = role({
  id: "preset-role",
  name: "Preset Role",
  source: "preset",
  preset: {
    catalogId: DEFAULT_CATALOG_ID,
    templateId: "preset-role",
    catalogRevision: "catalog-1",
    templateHash: "a".repeat(64),
    appliedHash: "b".repeat(64),
    importedAt: NOW,
  },
});

function row(
  overrides: Partial<PresetRolePreview> & Pick<PresetRolePreview, "id" | "kind">,
): PresetRolePreview {
  return {
    candidate,
    changedFields: [],
    templateChanged: false,
    locallyChanged: false,
    defaultAction: "keep",
    ...overrides,
  };
}

describe("catalog empty-state mode", () => {
  test("starts an automatic import only for two empty catalogs without history", () => {
    expect(resolveEmptyCatalogMode({ rolesCount: 0, teamsCount: 0 })).toBe("auto-import");
    expect(
      resolveEmptyCatalogMode({ rolesCount: 0, teamsCount: 0, templatesImportedAt: NOW }),
    ).toBe("manual-import");
  });

  test("offers Team guidance when Roles exist but Teams do not", () => {
    expect(resolveEmptyCatalogMode({ rolesCount: 3, teamsCount: 0 })).toBe("team-guidance");
  });

  test("still offers a manual import when Roles are empty but Teams remain", () => {
    expect(resolveEmptyCatalogMode({ rolesCount: 0, teamsCount: 1 })).toBe("manual-import");
    expect(
      resolveEmptyCatalogMode({ rolesCount: 0, teamsCount: 1, templatesImportedAt: NOW }),
    ).toBe("manual-import");
  });

  test("does nothing once both catalogs have data", () => {
    expect(resolveEmptyCatalogMode({ rolesCount: 2, teamsCount: 1 })).toBe("none");
  });
});

describe("auto-import deduplication", () => {
  test("keys an attempt by host and every document revision", () => {
    const first = autoImportAttemptKey("host-a", {
      roles: "r1",
      teams: "t1",
      preferences: "p1",
    });
    expect(first).toBe(
      autoImportAttemptKey("host-a", {
        roles: "r1",
        teams: "t1",
        preferences: "p1",
      }),
    );
    expect(first).not.toBe(
      autoImportAttemptKey("host-b", { roles: "r1", teams: "t1", preferences: "p1" }),
    );
    expect(first).not.toBe(
      autoImportAttemptKey("host-a", { roles: "r2", teams: "t1", preferences: "p1" }),
    );
  });
});

describe("preset selection", () => {
  const rows = [
    row({ id: "missing", kind: "missing", defaultAction: "add" }),
    row({ id: "changed", kind: "changed", before: candidate, defaultAction: "keep" }),
    row({ id: "deleted", kind: "deleted", defaultAction: "skip" }),
    row({ id: "collision", kind: "id-collision", before: candidate, defaultAction: "keep" }),
    row({ id: "same", kind: "same", before: candidate, defaultAction: "keep" }),
  ];

  test("uses the preview's default action for each kind", () => {
    expect(defaultPresetSelection(rows)).toEqual({
      missing: "add",
      changed: "keep",
      deleted: "skip",
      collision: "keep",
      same: "keep",
    });
  });

  test("only compatible previous choices survive a re-preview", () => {
    expect(
      carryPresetSelection(
        { missing: "skip", changed: "adopt", deleted: "add", collision: "keep" },
        rows,
      ),
    ).toEqual({
      missing: "skip",
      changed: "adopt",
      deleted: "add",
      collision: "keep",
      same: "keep",
    });
    const nowUnchanged = [row({ id: "changed", kind: "same", before: candidate })];
    expect(carryPresetSelection({ changed: "adopt" }, nowUnchanged)).toEqual({
      changed: "keep",
    });
  });

  test("allows the actions the merge function accepts for each row", () => {
    expect(allowedPresetActions(rows[0])).toEqual(["add", "skip"]);
    expect(allowedPresetActions(rows[1])).toEqual(["adopt", "keep"]);
    expect(allowedPresetActions(rows[3])).toEqual(["keep"]);
  });

  test("detects whether a selection writes Roles and counts the changes", () => {
    const defaults = defaultPresetSelection(rows);
    expect(selectionNeedsRoleWrite(rows, defaults)).toBe(true);
    expect(countPresetActions(rows, defaults)).toEqual({ add: 1, adopt: 0 });
    expect(selectionNeedsRoleWrite(rows, { ...defaults, missing: "skip" })).toBe(false);
    expect(countPresetActions(rows, { ...defaults, changed: "adopt", missing: "skip" })).toEqual({
      add: 0,
      adopt: 1,
    });
  });

  test("counts binding report entries by method", () => {
    const entry = (method: BindingReportEntry["method"]): BindingReportEntry => ({
      roleId: "role",
      list: "preferred",
      index: 0,
      hint: { name: "Hint", provider: "claude" },
      method,
      reason: method === "unbound" ? "missing" : null,
      candidateNames: [],
      deduplicated: false,
    });
    expect(
      countBindingReport([entry("unbound"), entry("runtime"), entry("exact"), entry("runtime")]),
    ).toEqual({ unbound: 1, runtime: 2 });
  });
});

import { DEFAULT_CATALOG_ID, type PresetRolePreview } from "../schemas/default-catalog";
import { type Preferences, PreferencesSchema } from "../schemas/preferences";
import type { Role } from "../schemas/role";
import { zh } from "../zh";

const MANAGEMENT_FIELDS = new Set(["createdAt", "updatedAt", "source", "preset", "designer"]);

function contentOf(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !MANAGEMENT_FIELDS.has(key)));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry) ?? null);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

/**
 * Hash input: only top-level management fields are omitted, including future designer metadata.
 * Nested keys are sorted; array order and null are significant. Undefined object values are
 * absent, and undefined array items become null, following JSON semantics. Schema defaults
 * (empty fallback/output/restriction lists and enabled=true) are applied before this boundary.
 */
export function canonicalize(value: Record<string, unknown>): string {
  return JSON.stringify(canonicalValue(contentOf(value)));
}

export function changedCatalogFields(before: Role, candidate: Role): string[] {
  const left = contentOf(before);
  const right = contentOf(candidate);
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter(
      (key) =>
        JSON.stringify(canonicalValue(left[key])) !== JSON.stringify(canonicalValue(right[key])),
    )
    .sort();
}

export function isDefaultPresetRole(
  role: Role,
): role is Role & { source: "preset"; preset: NonNullable<Role["preset"]> } {
  return (
    role.source === "preset" &&
    role.preset?.catalogId === DEFAULT_CATALOG_ID &&
    role.preset.templateId === role.id
  );
}

/** SHA256 is supplied by the server; shared/client code never computes hashes. */
export function diffPresetRoles(
  currentRoles: readonly Role[],
  candidates: readonly Role[],
  seenRoleIds: readonly string[],
  currentHashes: Readonly<Record<string, string>>,
): PresetRolePreview[] {
  const current = new Map(currentRoles.map((role) => [role.id, role]));
  const seen = new Set([
    ...seenRoleIds,
    ...currentRoles.filter(isDefaultPresetRole).map((role) => role.id),
  ]);
  return candidates.map((candidate) => {
    const before = current.get(candidate.id);
    const common = {
      id: candidate.id,
      candidate,
      templateChanged: false,
      locallyChanged: false,
    };
    if (!before) {
      return {
        ...common,
        kind: seen.has(candidate.id) ? "deleted" : "missing",
        defaultAction: seen.has(candidate.id) ? "skip" : "add",
        changedFields: [],
      };
    }
    const changedFields = changedCatalogFields(before, candidate);
    if (!isDefaultPresetRole(before)) {
      return {
        ...common,
        before,
        kind: "id-collision",
        locallyChanged: true,
        defaultAction: "keep",
        changedFields,
      };
    }
    return {
      ...common,
      before,
      kind: changedFields.length ? "changed" : "same",
      defaultAction: "keep",
      changedFields,
      templateChanged: before.preset?.templateHash !== candidate.preset?.templateHash,
      locallyChanged: currentHashes[before.id] !== before.preset?.appliedHash,
    };
  });
}

export type PresetAction = "add" | "adopt" | "keep" | "skip";
export type PresetSelection = Readonly<Record<string, PresetAction | undefined>>;

/**
 * Use the preview's revisions with settings.save. This pure merge additionally rejects stale
 * selected rows, never overwrites an unseen Role, and preserves all unselected objects verbatim.
 * candidate already contains the server's fresh binding and both hashes.
 */
export function applyPresetSelection(
  currentRoles: readonly Role[],
  preview: readonly PresetRolePreview[],
  selection: PresetSelection,
  now: string,
): Role[] {
  const roles = [...currentRoles];
  for (const row of preview) {
    const action = selection[row.id] ?? row.defaultAction;
    if (action === "keep" || action === "skip") continue;
    const index = roles.findIndex((role) => role.id === row.id);
    const current = roles[index];
    if (
      row.candidate.id !== row.id ||
      !isDefaultPresetRole(row.candidate) ||
      (row.before
        ? !current ||
          JSON.stringify(canonicalValue(current)) !== JSON.stringify(canonicalValue(row.before))
        : !!current)
    ) {
      throw new Error(zh.defaultPresetsCatalogChanged);
    }
    if ((row.before && action !== "adopt") || (!row.before && action !== "add")) {
      throw new Error(zh.defaultPresetsInvalidSelection);
    }
    const role: Role = {
      ...row.candidate,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      preset: { ...row.candidate.preset, importedAt: now },
    };
    if (current) roles[index] = role;
    else roles.push(role);
  }
  return roles;
}

/** Call only after the Role write succeeds; retry a preference conflict with fresh preferences. */
export function recordPresetSync(
  preferences: Preferences,
  roles: readonly Role[],
  catalogRevision: string,
  now: string,
): Preferences {
  return PreferencesSchema.parse({
    ...preferences,
    templatesImportedAt: preferences.templatesImportedAt ?? now,
    defaultPresets: {
      catalogRevision,
      seenRoleIds: [
        ...(preferences.defaultPresets?.seenRoleIds ?? []),
        ...roles.filter(isDefaultPresetRole).map((role) => role.id),
      ],
      lastSyncedAt: now,
    },
  });
}

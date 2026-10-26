import { DEFAULT_CATALOG_ID, type PresetRolePreview } from "../schemas/default-catalog";
import { type Preferences, PreferencesSchema } from "../schemas/preferences";
import { type Role, RoleSchema } from "../schemas/role";
import { zh } from "../zh";
import { DEFAULT_ROLE_EXECUTION } from "./role-execution";

const MANAGEMENT_FIELDS = new Set(["createdAt", "updatedAt", "source", "preset", "designer"]);
const REFERENCE_FIELDS = ["preferredProfiles", "fallbackProfiles"] as const;

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

/**
 * The single definition of "same content" used by the preset preview and sync history.
 * Both sides pass through RoleSchema first so schema defaults (empty restrictions/outputContract,
 * enabled=true, and so on) are present. Management metadata never participates: createdAt,
 * updatedAt, source, preset, designer. preferredProfiles/fallbackProfiles compare only their
 * profileId sequence, ignoring nameSnapshot and hint, so renaming a Profile cannot make every
 * preset look changed. Every other top-level field, including extensions, compares canonically.
 * A missing executionPolicy compares as the known-id default: that is the tier planning actually
 * applies, so an unmarked pre-tier Role is not reported as a user collision on first sync.
 */
function comparableContent(value: Role): Record<string, unknown> {
  const parsed = RoleSchema.parse(value);
  const content = contentOf(parsed);
  const fallback = DEFAULT_ROLE_EXECUTION[parsed.id];
  const policy = content.executionPolicy;
  if (policy === undefined) {
    if (fallback) content.executionPolicy = fallback;
  } else if (fallback && typeof policy === "object" && policy !== null && !Array.isArray(policy)) {
    // Compare the tier planning actually applies: a present block with only one explicit field
    // still inherits the other from the known-id default. Invalid values remain visible.
    const explicit = policy as Record<string, unknown>;
    content.executionPolicy = {
      ...explicit,
      ...(explicit.tier === undefined ? { tier: fallback.tier } : {}),
      ...(explicit.taskKind === undefined ? { taskKind: fallback.taskKind } : {}),
    };
  }
  for (const key of REFERENCE_FIELDS) content[key] = parsed[key].map((ref) => ref.profileId);
  return content;
}

export function changedCatalogFields(before: Role, candidate: Role): string[] {
  const left = comparableContent(before);
  const right = comparableContent(candidate);
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
      // The real catalog installed before preset metadata existed has no source/preset markers.
      // Same content is the same Role: a first sync must not show a phantom ID conflict.
      if (changedFields.length === 0) {
        return { ...common, before, kind: "same", defaultAction: "keep", changedFields };
      }
      // A different Role whose id the history already attributes to this preset is an older
      // import without origin metadata. Report a preset update, not a user ID collision. With no
      // applied-hash baseline the difference cannot be attributed, so it is flagged as local.
      if (seen.has(before.id)) {
        return {
          ...common,
          before,
          kind: "changed",
          locallyChanged: true,
          defaultAction: "keep",
          changedFields,
        };
      }
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

/** The preview fields every merge must be paired with: rows plus the revisions they were read at. */
export type PresetPreviewSnapshot = {
  roles: readonly PresetRolePreview[];
  revisions: { roles: string; preferences: string };
};

/**
 * Merge only into the Roles array whose revision equals preview.revisions.roles. A mismatch means
 * another writer changed the document after the preview; re-read, recompute, and reconfirm rather
 * than saving a stale base (which would silently drop concurrent additions). Save the result with
 * current.revision as the compare-and-set revision. Rows are revalidated against current.roles, and
 * every unselected Role is kept verbatim. candidate already contains the server's fresh binding
 * and both hashes.
 */
export function applyPresetSelection(
  current: { roles: readonly Role[]; revision: string },
  preview: PresetPreviewSnapshot,
  selection: PresetSelection,
  now: string,
): Role[] {
  if (current.revision !== preview.revisions.roles) {
    throw new Error(zh.defaultPresetsCatalogChanged);
  }
  const roles = [...current.roles];
  for (const row of preview.roles) {
    const action = selection[row.id] ?? row.defaultAction;
    if (action === "keep" || action === "skip") continue;
    const index = roles.findIndex((role) => role.id === row.id);
    const existing = roles[index];
    if (
      row.candidate.id !== row.id ||
      !isDefaultPresetRole(row.candidate) ||
      (row.before
        ? !existing ||
          JSON.stringify(canonicalValue(existing)) !== JSON.stringify(canonicalValue(row.before))
        : !!existing)
    ) {
      throw new Error(zh.defaultPresetsCatalogChanged);
    }
    if ((row.before && action !== "adopt") || (!row.before && action !== "add")) {
      throw new Error(zh.defaultPresetsInvalidSelection);
    }
    const role: Role = {
      ...row.candidate,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      preset: { ...row.candidate.preset, importedAt: now },
    };
    if (existing) roles[index] = role;
    else roles.push(role);
  }
  return roles;
}

function rawDocument(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function rawRowId(row: unknown): string | null {
  if (!row || typeof row !== "object" || !("id" in row)) return null;
  return typeof row.id === "string" ? row.id : null;
}

/**
 * Build the write document for a preset selection from the raw settings read: only selected rows
 * are replaced or appended. Unrelated rows and unknown top-level keys therefore survive, matching
 * the editor and design-save write paths instead of rewriting the parsed document.
 */
export function applyPresetSelectionDocument(
  current: { roles: readonly Role[]; raw: unknown; revision: string },
  preview: PresetPreviewSnapshot,
  selection: PresetSelection,
  now: string,
): { roles: Role[]; document: Record<string, unknown> } {
  const roles = applyPresetSelection(
    { roles: current.roles, revision: current.revision },
    preview,
    selection,
    now,
  );
  const changed = new Set<string>();
  for (const row of preview.roles) {
    const action = selection[row.id] ?? row.defaultAction;
    if (action === "add" || action === "adopt") changed.add(row.id);
  }
  const byId = new Map(roles.map((role) => [role.id, role]));
  const document = rawDocument(current.raw);
  const rawRows = document && Array.isArray(document.roles) ? document.roles : current.roles;
  const seen = new Set<string>();
  const merged: unknown[] = rawRows.map((row) => {
    const id = rawRowId(row);
    if (!id || !changed.has(id)) return row;
    seen.add(id);
    return byId.get(id) ?? row;
  });
  for (const id of changed) {
    const role = byId.get(id);
    if (role && !seen.has(id)) merged.push(role);
  }
  return { roles, document: { ...(document ?? {}), roles: merged } };
}

/**
 * Call only after the Role write succeeds. Pass the same preview result the Roles write was based
 * on: current.revision must equal preview.revisions.preferences, otherwise another writer changed
 * preferences after the preview; re-read, recompute, and retry with fresh values instead of
 * overwriting their changes. Record only Roles that carry a preset origin plus preview rows that
 * are classified "same" and still present, so a user-built Role that merely reuses a preset id is
 * never marked as seen. Frontend: pass the `agent-team.templates.defaults.preview` result as
 * `preview` (it is structurally compatible) and settings.save(result, current.revision).
 */
export function recordPresetSync(
  current: { values: Preferences; revision: string },
  preview: PresetPreviewSnapshot,
  roles: readonly Role[],
  catalogRevision: string,
  now: string,
): Preferences {
  if (current.revision !== preview.revisions.preferences) {
    throw new Error(zh.defaultPresetsCatalogChanged);
  }
  const seen = new Set<string>();
  for (const role of roles) if (isDefaultPresetRole(role)) seen.add(role.id);
  const present = new Set(roles.map((role) => role.id));
  for (const row of preview.roles) {
    if (row.kind === "same" && present.has(row.id)) seen.add(row.id);
  }
  return PreferencesSchema.parse({
    ...current.values,
    templatesImportedAt: current.values.templatesImportedAt ?? now,
    defaultPresets: {
      catalogRevision,
      seenRoleIds: [...(current.values.defaultPresets?.seenRoleIds ?? []), ...seen],
      lastSyncedAt: now,
    },
  });
}

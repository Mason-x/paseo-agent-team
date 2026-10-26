import {
  applyPresetSelectionDocument,
  type PresetSelection,
  recordPresetSync,
} from "../../shared/domain/catalog-content";
import type {
  CatalogBlocker,
  DefaultCatalogPreviewResult,
} from "../../shared/schemas/default-catalog";
import type { Preferences } from "../../shared/schemas/preferences";
import type { Role } from "../../shared/schemas/role";
import type { RolesDocument } from "../../shared/settings";
import { zh } from "../../shared/zh";
import {
  carryPresetSelection,
  defaultPresetSelection,
  selectionNeedsRoleWrite,
} from "./preset-state";

export type PreviewSuccess = Extract<DefaultCatalogPreviewResult, { ok: true }>;

export type SettingsSnapshot<Values> =
  | { status: "ready"; values: Values; raw: unknown; revision: string }
  | { status: "invalid"; error: string };

/** The settings write result, mapped from the host's saved/conflict/invalid answer. */
export type WriteResult = "saved" | "conflict" | "invalid" | "failed";

/** Everything the import and sync flows need, independent of React so the flows can be tested. */
export type PresetGateway = {
  preview(allowUnboundOnProfileError: boolean): Promise<DefaultCatalogPreviewResult>;
  readRoles(): Promise<SettingsSnapshot<RolesDocument>>;
  readPreferences(): Promise<SettingsSnapshot<Preferences>>;
  saveRolesDocument(values: Record<string, unknown>, revision: string): Promise<WriteResult>;
  savePreferences(values: Preferences, revision: string): Promise<WriteResult>;
  reloadRoles(): Promise<void>;
  reloadPreferences(): Promise<void>;
};

const MAX_PREVIEW_ATTEMPTS = 2;
const MAX_PREFERENCE_ATTEMPTS = 2;

export function previewFailureMessage(blockers: readonly CatalogBlocker[]): string {
  return (
    blockers.map((blocker) => blocker.message).join("\n") || zh.defaultPresetsSettingsUnavailable
  );
}

/**
 * Preference rows and seen history do not depend on the preferences revision. Replacing only the
 * guard with the revision just read lets a retry merge into the latest values; recordPresetSync
 * then validates that same revision, so the CAS check still runs against the fresh state.
 */
export function withPreferencesRevision(preview: PreviewSuccess, revision: string): PreviewSuccess {
  return { ...preview, revisions: { ...preview.revisions, preferences: revision } };
}

async function savePreferencesOnly(
  gateway: PresetGateway,
  preview: PreviewSuccess,
  roles: readonly Role[],
  now: string,
): Promise<WriteResult> {
  for (let attempt = 0; attempt < MAX_PREFERENCE_ATTEMPTS; attempt += 1) {
    const preferences = await gateway.readPreferences();
    if (preferences.status !== "ready") return "invalid";
    let values: Preferences;
    try {
      values = recordPresetSync(
        preferences,
        withPreferencesRevision(preview, preferences.revision),
        roles,
        preview.catalogRevision,
        now,
      );
    } catch {
      return "invalid";
    }
    const result = await gateway.savePreferences(values, preferences.revision);
    if (result === "saved") {
      try {
        await gateway.reloadPreferences();
      } catch {
        // The write already succeeded; the host event will refresh the hook.
      }
      return "saved";
    }
    if (result !== "conflict") return result;
    await gateway.reloadPreferences();
  }
  return "conflict";
}

/** Retry only the preferences record after a successful Roles write. */
export function retryPresetPreferences(
  gateway: PresetGateway,
  preview: PreviewSuccess,
  roles: readonly Role[],
  now: string,
): Promise<WriteResult> {
  return savePreferencesOnly(gateway, preview, roles, now);
}

export type PresetImportResult =
  | { kind: "imported"; preview: PreviewSuccess; roles: Role[] }
  | { kind: "already-present" }
  | { kind: "blocked"; blockers: CatalogBlocker[]; canForce: boolean }
  | { kind: "preferences-failed"; preview: PreviewSuccess; roles: Role[]; message: string }
  | { kind: "failed"; message: string };

/**
 * First-open import. All writes go through the compare-and-set gateway: Roles first, preferences
 * second. A Roles conflict means another window finished the import, so observe and stop rather
 * than overwrite it. A preferences failure after a successful Roles write never replays the Roles.
 */
export async function importDefaultPresets(
  gateway: PresetGateway,
  options: { allowUnbound: boolean; onlyWhenUnimported: boolean; now: string },
): Promise<PresetImportResult> {
  let previewResult = await gateway.preview(options.allowUnbound);
  if (!previewResult.ok) {
    return {
      kind: "blocked",
      blockers: previewResult.blockers,
      canForce: previewResult.blockers.some((blocker) => blocker.code === "profiles-unavailable"),
    };
  }
  let preview = previewResult;

  for (let attempt = 0; attempt < MAX_PREVIEW_ATTEMPTS; attempt += 1) {
    const rolesState = await gateway.readRoles();
    const preferencesState = await gateway.readPreferences();
    if (rolesState.status !== "ready" || preferencesState.status !== "ready") {
      return { kind: "failed", message: zh.defaultPresetsSettingsUnavailable };
    }
    if (rolesState.values.roles.length > 0) return { kind: "already-present" };
    if (options.onlyWhenUnimported && preferencesState.values.templatesImportedAt) {
      return { kind: "already-present" };
    }
    if (
      rolesState.revision !== preview.revisions.roles ||
      preferencesState.revision !== preview.revisions.preferences
    ) {
      if (attempt + 1 >= MAX_PREVIEW_ATTEMPTS) {
        return { kind: "failed", message: zh.defaultPresetsSettingsUnavailable };
      }
      previewResult = await gateway.preview(options.allowUnbound);
      if (!previewResult.ok) {
        return {
          kind: "blocked",
          blockers: previewResult.blockers,
          canForce: previewResult.blockers.some(
            (blocker) => blocker.code === "profiles-unavailable",
          ),
        };
      }
      preview = previewResult;
      continue;
    }

    let selectionResult: { roles: Role[]; document: Record<string, unknown> };
    try {
      selectionResult = applyPresetSelectionDocument(
        { roles: rolesState.values.roles, raw: rolesState.raw, revision: rolesState.revision },
        preview,
        defaultPresetSelection(preview.roles),
        options.now,
      );
    } catch {
      if (attempt + 1 >= MAX_PREVIEW_ATTEMPTS) {
        return { kind: "failed", message: zh.defaultPresetsCatalogChanged };
      }
      previewResult = await gateway.preview(options.allowUnbound);
      if (!previewResult.ok) {
        return {
          kind: "blocked",
          blockers: previewResult.blockers,
          canForce: previewResult.blockers.some(
            (blocker) => blocker.code === "profiles-unavailable",
          ),
        };
      }
      preview = previewResult;
      continue;
    }

    const roles = selectionResult.roles;
    const rolesWrite = await gateway.saveRolesDocument(
      selectionResult.document,
      rolesState.revision,
    );
    if (rolesWrite !== "saved") {
      try {
        await gateway.reloadRoles();
      } catch {
        // The direct read below is the authority for conflict observation.
      }
      if (rolesWrite === "invalid") {
        return { kind: "failed", message: zh.defaultPresetsInvalidData };
      }
      if (rolesWrite === "failed") {
        return { kind: "failed", message: zh.defaultPresetsWriteFailed };
      }
      const after = await gateway.readRoles();
      if (after.status === "ready" && after.values.roles.length > 0) {
        return { kind: "already-present" };
      }
      return { kind: "failed", message: zh.defaultPresetsCatalogChanged };
    }
    try {
      await gateway.reloadRoles();
    } catch {
      // The write already succeeded; the host event will refresh the hook.
    }

    const preferencesWrite = await savePreferencesOnly(gateway, preview, roles, options.now);
    if (preferencesWrite !== "saved") {
      return {
        kind: "preferences-failed",
        preview,
        roles,
        message:
          preferencesWrite === "invalid"
            ? zh.defaultPresetsPreferencesInvalid
            : zh.defaultPresetsPreferencesFailed,
      };
    }
    return { kind: "imported", preview, roles };
  }
  return { kind: "failed", message: zh.defaultPresetsSettingsUnavailable };
}

export type PresetSyncResult =
  | { kind: "synced"; preview: PreviewSuccess; roles: Role[]; wroteRoles: boolean }
  | {
      kind: "needs-confirmation";
      preview: PreviewSuccess;
      selection: PresetSelection;
      message: string;
    }
  | { kind: "failed"; message: string; rolesImported: boolean };

async function repreviewForConfirmation(
  gateway: PresetGateway,
  selection: PresetSelection,
  message: string,
): Promise<PresetSyncResult> {
  await Promise.all([gateway.reloadRoles(), gateway.reloadPreferences()]);
  const preview = await gateway.preview(false);
  if (!preview.ok) {
    return {
      kind: "failed",
      message: previewFailureMessage(preview.blockers),
      rolesImported: false,
    };
  }
  return {
    kind: "needs-confirmation",
    preview,
    selection: carryPresetSelection(selection, preview.roles),
    message,
  };
}

/**
 * Apply a user-confirmed selection. When the Roles document moved, or the write loses a CAS race,
 * return a fresh preview and the user's compatible choices: nothing is written until they confirm
 * again. Preferences are retried alone after a roles write, never with a second Roles save.
 */
export async function syncDefaultPresets(
  gateway: PresetGateway,
  input: { preview: PreviewSuccess; selection: PresetSelection; now: string },
): Promise<PresetSyncResult> {
  const rolesState = await gateway.readRoles();
  if (rolesState.status !== "ready") {
    return { kind: "failed", message: zh.defaultPresetsSettingsUnavailable, rolesImported: false };
  }
  if (rolesState.revision !== input.preview.revisions.roles) {
    return repreviewForConfirmation(gateway, input.selection, zh.defaultPresetsCatalogChanged);
  }

  let roles = rolesState.values.roles;
  let wroteRoles = false;
  if (selectionNeedsRoleWrite(input.preview.roles, input.selection)) {
    let selectionResult: { roles: Role[]; document: Record<string, unknown> };
    try {
      selectionResult = applyPresetSelectionDocument(
        { roles: rolesState.values.roles, raw: rolesState.raw, revision: rolesState.revision },
        input.preview,
        input.selection,
        input.now,
      );
    } catch {
      return repreviewForConfirmation(gateway, input.selection, zh.defaultPresetsCatalogChanged);
    }
    roles = selectionResult.roles;
    const write = await gateway.saveRolesDocument(selectionResult.document, rolesState.revision);
    if (write === "invalid") {
      return { kind: "failed", message: zh.defaultPresetsInvalidData, rolesImported: false };
    }
    if (write === "failed") {
      return { kind: "failed", message: zh.defaultPresetsWriteFailed, rolesImported: false };
    }
    if (write === "conflict") {
      return repreviewForConfirmation(gateway, input.selection, zh.defaultPresetsCatalogChanged);
    }
    try {
      await gateway.reloadRoles();
    } catch {
      // The write already succeeded; the host event will refresh the hook.
    }
    wroteRoles = true;
  }

  const preferencesWrite = await savePreferencesOnly(gateway, input.preview, roles, input.now);
  if (preferencesWrite !== "saved") {
    return {
      kind: "failed",
      message:
        preferencesWrite === "invalid"
          ? zh.defaultPresetsPreferencesInvalid
          : preferencesWrite === "conflict"
            ? zh.defaultPresetsCatalogChanged
            : zh.defaultPresetsPreferencesFailed,
      rolesImported: wroteRoles,
    };
  }
  return { kind: "synced", preview: input.preview, roles, wroteRoles };
}

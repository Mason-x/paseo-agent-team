import { diffPresetRoles } from "../../shared/domain/catalog-content";
import { bindProfileHints } from "../../shared/domain/profile-binding";
import {
  type CatalogBlocker,
  DEFAULT_CATALOG_ID,
  type DefaultCatalogPreviewInput,
  type DefaultCatalogPreviewResult,
} from "../../shared/schemas/default-catalog";
import type { Preferences } from "../../shared/schemas/preferences";
import type { Role } from "../../shared/schemas/role";
import type { RolesDocument } from "../../shared/settings";
import { zh } from "../../shared/zh";
import { defaultCatalogRevision, defaultRoleTemplates } from "./default-catalog";
import { hashCatalogContent } from "./hash";
import type { ExampleCatalog, HostProfile, MaterializedDefaultCatalog } from "./types";

export { defaultCatalogRevision, defaultRoleTemplates } from "./default-catalog";
export type { ExampleCatalog, HostProfile } from "./types";

export function materializeDefaultCatalog(
  profiles: readonly HostProfile[],
  now: string,
): MaterializedDefaultCatalog {
  const bindingReport: MaterializedDefaultCatalog["bindingReport"] = [];
  const roles: Role[] = defaultRoleTemplates.map((template) => {
    const { preferredHints, fallbackHints, ...content } = template;
    const bound = bindProfileHints(template.id, preferredHints, fallbackHints, profiles);
    bindingReport.push(...bound.bindingReport);
    const role = {
      ...content,
      preferredProfiles: bound.preferredProfiles,
      fallbackProfiles: bound.fallbackProfiles,
      createdAt: now,
      updatedAt: now,
      source: "preset",
    };
    return {
      ...role,
      preset: {
        catalogId: DEFAULT_CATALOG_ID,
        templateId: template.id,
        catalogRevision: defaultCatalogRevision,
        templateHash: hashCatalogContent(template),
        appliedHash: hashCatalogContent(role),
        importedAt: now,
      },
    };
  });
  return { roles, teams: [], bindingReport };
}

export function exampleCatalog(profiles: readonly HostProfile[], now: string): ExampleCatalog {
  const { roles, teams } = materializeDefaultCatalog(profiles, now);
  return { roles, teams };
}

type SettingsReader<Values> = {
  read(): Promise<
    | { status: "ready"; revision: string; values: Values }
    | { status: "invalid"; revision: string; error: string }
  >;
};

/** Each request reads the registered stores again, rather than using startup snapshots. */
export async function previewDefaultCatalog(
  input: DefaultCatalogPreviewInput,
  deps: {
    roles: SettingsReader<RolesDocument>;
    preferences: SettingsReader<Preferences>;
    listProfiles: () => Promise<HostProfile[]>;
    now?: () => string;
  },
): Promise<DefaultCatalogPreviewResult> {
  const states = await Promise.allSettled([deps.roles.read(), deps.preferences.read()]);
  const blockers: CatalogBlocker[] = [];
  for (const [index, state] of states.entries()) {
    const document = index === 0 ? "roles" : "preferences";
    if (state.status === "rejected") {
      blockers.push({
        code: "settings-unavailable",
        document,
        message: zh.defaultPresetsSettingsUnavailable,
      });
    } else if (state.value.status === "invalid") {
      blockers.push({
        code: "settings-invalid",
        document,
        message: state.value.error.slice(0, 2000),
      });
    }
  }
  const [roleState, preferencesState] = states;
  if (
    roleState.status !== "fulfilled" ||
    preferencesState.status !== "fulfilled" ||
    roleState.value.status !== "ready" ||
    preferencesState.value.status !== "ready"
  ) {
    return { ok: false, blockers };
  }
  const warnings: string[] = [];
  let profiles: HostProfile[];
  try {
    profiles = await deps.listProfiles();
  } catch {
    if (!input.allowUnboundOnProfileError) {
      return {
        ok: false,
        blockers: [{ code: "profiles-unavailable", message: zh.defaultPresetsProfilesReadFailed }],
      };
    }
    profiles = [];
    warnings.push(zh.defaultPresetsAllUnbound);
  }
  const now = deps.now?.() ?? new Date().toISOString();
  const catalog = materializeDefaultCatalog(profiles, now);
  const unbound = catalog.bindingReport.filter((entry) => entry.method === "unbound").length;
  if (unbound > 0) warnings.push(zh.defaultPresetsUnboundCount(unbound));
  const runtime = catalog.bindingReport.filter((entry) => entry.method === "runtime").length;
  if (runtime > 0) warnings.push(zh.defaultPresetsRuntimeCount(runtime));
  const currentRoles = roleState.value.values.roles;
  return {
    ok: true,
    catalogRevision: defaultCatalogRevision,
    generatedAt: now,
    revisions: { roles: roleState.value.revision, preferences: preferencesState.value.revision },
    roles: diffPresetRoles(
      currentRoles,
      catalog.roles,
      preferencesState.value.values.defaultPresets?.seenRoleIds ?? [],
      Object.fromEntries(currentRoles.map((role) => [role.id, hashCatalogContent(role)])),
    ),
    bindingReport: catalog.bindingReport,
    warnings,
  };
}

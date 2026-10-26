import type { PresetAction, PresetSelection } from "../../shared/domain/catalog-content";
import type { BindingReportEntry, PresetRolePreview } from "../../shared/schemas/default-catalog";

/** What the first screen should offer when the two catalogs are empty. */
export type EmptyCatalogMode = "auto-import" | "manual-import" | "team-guidance" | "none";

export function resolveEmptyCatalogMode(input: {
  rolesCount: number;
  teamsCount: number;
  templatesImportedAt?: string;
}): EmptyCatalogMode {
  if (input.rolesCount === 0) {
    // Teams without Roles still need the import entry; never auto-import into a non-empty Team catalog.
    if (input.teamsCount === 0 && !input.templatesImportedAt) return "auto-import";
    return "manual-import";
  }
  return input.teamsCount === 0 ? "team-guidance" : "none";
}

/** One auto-import attempt per host and document revision; a failure is not retried forever. */
export function autoImportAttemptKey(
  hostId: string,
  revisions: { roles: string; teams: string; preferences: string },
): string {
  return [hostId, revisions.roles, revisions.teams, revisions.preferences].join("\u0000");
}

/** Actions a row accepts in the dialog; a user-owned ID collision can only be kept. */
export function allowedPresetActions(row: PresetRolePreview): readonly PresetAction[] {
  if (!row.before) return ["add", "skip"];
  if (row.kind === "changed") return ["adopt", "keep"];
  return ["keep"];
}

export function defaultPresetSelection(rows: readonly PresetRolePreview[]): PresetSelection {
  return Object.fromEntries(rows.map((row) => [row.id, row.defaultAction]));
}

/**
 * Keep the user's previous choices across a re-preview where they still make sense. A row that
 * changed kind falls back to its new default instead of replaying an incompatible action.
 */
export function carryPresetSelection(
  previous: PresetSelection,
  rows: readonly PresetRolePreview[],
): PresetSelection {
  const next: Record<string, PresetAction | undefined> = defaultPresetSelection(rows);
  for (const row of rows) {
    const action = previous[row.id];
    if (action && allowedPresetActions(row).includes(action)) next[row.id] = action;
  }
  return next;
}

export function selectionNeedsRoleWrite(
  rows: readonly PresetRolePreview[],
  selection: PresetSelection,
): boolean {
  return rows.some((row) => {
    const action = selection[row.id] ?? row.defaultAction;
    return row.before ? action === "adopt" : action === "add";
  });
}

export function countBindingReport(report: readonly BindingReportEntry[]): {
  unbound: number;
  runtime: number;
} {
  let unbound = 0;
  let runtime = 0;
  for (const entry of report) {
    if (entry.method === "unbound") unbound += 1;
    else if (entry.method === "runtime") runtime += 1;
  }
  return { unbound, runtime };
}

/** Actions that would change the Roles document, for the dialog's confirm summary. */
export function countPresetActions(
  rows: readonly PresetRolePreview[],
  selection: PresetSelection,
): { add: number; adopt: number } {
  let add = 0;
  let adopt = 0;
  for (const row of rows) {
    const action = selection[row.id] ?? row.defaultAction;
    if (!row.before && action === "add") add += 1;
    if (row.before && action === "adopt") adopt += 1;
  }
  return { add, adopt };
}

import type { ModeLaunchPreview } from "../schemas/launch-preview";
import type { Preferences } from "../schemas/preferences";
import type { Role } from "../schemas/role";
import type { Team } from "../schemas/team";
import type { TeamMode } from "../schemas/team-mode";
import type { HostSnapshot, ProfileSelection } from "./mode-resolver";
import type { ModeIssue } from "./role-execution";

/**
 * The only seam to 5A's mode-aware planning. This module stays pure: it defines the port and its
 * result aggregate, while server/designer/planning.ts supplies the production adapter.
 *
 * T2's HostSnapshot and ProfileSelection are imported from mode-resolver. `host` is required so a
 * failed Profile/availability query can never be flattened into empty arrays and mistaken for a
 * healthy host; the adapter returns `{status:"unavailable"}` and the planner reports
 * MODE_CONTEXT_UNAVAILABLE, which G2 maps to DESIGN_CONFIG_UNAVAILABLE.
 *
 * The production adapter calls T3's buildSeatPlan and T4's toModeLaunchPreview directly; no
 * selection algorithm is duplicated in this file.
 */
export type DesignPlanningCapabilities = {
  onDemand: boolean;
  expansion: boolean;
  collaboration: boolean;
};

export type DesignPlanningInput = {
  jobId: string;
  team: Team;
  roles: readonly Role[];
  host: HostSnapshot;
  preferences: Preferences;
  daemonConfig: unknown;
  mode: TeamMode;
  workspaceId: string;
  request: string;
};

/**
 * Profile IDs the planner expects for one logical seat, in candidate order. A standby selection
 * is not creatable yet and contributes none, which is why a DesignProfileChoice may carry an empty
 * profileIds array for that seat. G2 uses this for memberReasons.expectedProfileIds and G4 uses it
 * for the per-seat preview.
 */
export function availableProfileIds(selections: readonly ProfileSelection[]): string[] {
  return selections.flatMap((selection) => (selection.unavailable ? [] : [selection.profile.id]));
}

/**
 * Aggregates the mode issues with the launch warnings/blockers already produced by 5A. It does not
 * replace T1's Result: per-Role resolution still returns Result<RoleExecutionPolicy, ModeIssue[]>
 * and callers must check its `ok` before building this aggregate.
 *
 * A failed check never carries a fabricated preview; G2 only materializes when `ok` is true. An
 * unavailable HostSnapshot surfaces as MODE_CONTEXT_UNAVAILABLE in `issues` on the failure branch.
 */
export type DesignPlanCheck =
  | {
      ok: true;
      preview: ModeLaunchPreview;
      issues: readonly ModeIssue[];
      launchWarnings: readonly string[];
    }
  | {
      ok: false;
      issues: readonly ModeIssue[];
      launchBlockers: readonly string[];
      launchWarnings: readonly string[];
    };

export interface DesignPlanningPort {
  plan(input: DesignPlanningInput): DesignPlanCheck;
}

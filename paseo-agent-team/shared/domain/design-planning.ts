import type { DesignOutputContractVersion } from "../schemas/design";
import { DESIGN_OUTPUT_CONTRACT_VERSION } from "../schemas/design";
import type { ModeLaunchPreview } from "../schemas/launch-preview";
import type { Preferences } from "../schemas/preferences";
import type { Role } from "../schemas/role";
import type { Team } from "../schemas/team";
import type { TeamMode } from "../schemas/team-mode";
import { checkModeAccess, MODE_CONTRACT_VERSION, type ModeContractVersion } from "./mode-contract";
import type { HostSnapshot, ProfileSelection } from "./mode-resolver";
import type { ModeIssue } from "./role-execution";

/**
 * The only seam to the Team planner. This module stays pure: it defines the port and its result
 * aggregate, while server/designer/planning.ts supplies the production adapter.
 *
 * HostSnapshot and ProfileSelection are imported from mode-resolver. `host` is required so a
 * failed Profile/availability query can never be flattened into empty arrays and mistaken for a
 * healthy host; the adapter returns `{status:"unavailable"}` and the planner reports
 * MODE_CONTEXT_UNAVAILABLE, which G2 maps to DESIGN_CONFIG_UNAVAILABLE.
 *
 * The production adapter calls buildSeatPlan and toModeLaunchPreview directly; no selection
 * algorithm is duplicated in this file.
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
  workspaceId: string;
  request: string;
};

/**
 * Profile IDs the planner expects for one logical seat, in candidate order. G2 uses this for
 * memberReasons.expectedProfileIds and G4 uses it for the per-seat preview.
 */
export function availableProfileIds(selections: readonly ProfileSelection[]): string[] {
  return selections.map((selection) => selection.profile.id);
}

/**
 * The rule for a *new* request: existing Roles only unless the caller explicitly turns it off.
 * A record never calls this again — its stored boolean is the authority (04 §6.1).
 */
export function normalizeExistingRolesOnly(raw: boolean | undefined): boolean {
  return raw ?? true;
}

/**
 * The one mapping from the record rule to the new-Role limit: 0 while existing-roles-only, 3 for
 * the legacy contract. Initial validation, save revalidation, and compensation all read this, and
 * a missing rule only means "legacy" — a v2 output is rejected before it ever gets here.
 */
export function designNewRoleLimit(rules: { existingRolesOnly?: boolean } | undefined): 0 | 3 {
  return rules?.existingRolesOnly === true ? 0 : 3;
}

/** A job created by this build writes contract 2; legacy records keep their stored 1. */
export function designContractVersionForNewJob(): DesignOutputContractVersion {
  return DESIGN_OUTPUT_CONTRACT_VERSION;
}

export type DesignModeAccess =
  | { ok: true }
  | {
      ok: false;
      reason: "retired";
      /** The requested mode, so the caller can report it verbatim. */
      value: TeamMode;
      contractVersion: ModeContractVersion;
    };

/**
 * Access check for a design request. The mode is retired: an absent value or `sota` runs and the
 * mode is otherwise ignored; any other mode is refused. Unknown mode strings are rejected by the
 * RPC schema before this point. The service maps a denial to DESIGN_MODE_UNAVAILABLE.
 */
export function designModeAccess(input: {
  mode: TeamMode;
  contractVersion?: number;
}): DesignModeAccess {
  if (checkModeAccess({ requestedMode: input.mode }).ok) return { ok: true };
  return {
    ok: false,
    reason: "retired",
    value: input.mode,
    contractVersion: MODE_CONTRACT_VERSION,
  };
}

/**
 * Aggregates the planning issues with the launch warnings/blockers already produced by the Team
 * planner. Callers must check the per-seat resolution `ok` before building this aggregate.
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

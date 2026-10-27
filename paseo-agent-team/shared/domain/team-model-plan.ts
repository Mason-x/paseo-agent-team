import type { Role } from "../schemas/role";
import type { Team } from "../schemas/team";
import type { TeamMode } from "../schemas/team-mode";
import { readStoredMode } from "./mode-contract";
import {
  type AvailableProfileSelection,
  type EconomyPolicy,
  type HostSnapshot,
  resolveCoordinatorProfile,
} from "./mode-resolver";
import type { ModeIssue } from "./role-execution";
import { buildSeatPlan, type RuntimeCapabilities, type SeatPlan } from "./seat-plan";

/** The fields planning reads from a Team; drafts never need ids, names, or timestamps. */
export type TeamPlanningFields = Pick<
  Team,
  "mode" | "coordinatorRoleId" | "members" | "memberCreation" | "collaboration"
>;

export type TeamModelCoordinator = {
  role: Role | null;
  selection: AvailableProfileSelection | null;
  warnings: readonly string[];
  /** Legacy resolveProfile reason (e.g. provider-unavailable); the caller localizes it. */
  legacyFailureReason: string | null;
  issues: readonly ModeIssue[];
};

export type TeamModelPlan = {
  effectiveMode: TeamMode | null;
  rawMode?: string;
  team: TeamPlanningFields;
  seatPlan: SeatPlan;
  coordinator: TeamModelCoordinator;
  issues: readonly ModeIssue[];
  blockers: readonly ModeIssue[];
};

export type BuildTeamModelPlanInput = {
  team: TeamPlanningFields;
  roles: readonly Role[];
  host: HostSnapshot;
  economy: EconomyPolicy;
  maxMembers: number;
  runtimeCapabilities?: RuntimeCapabilities;
  /** Launch-time override; otherwise the stored Team mode is read. */
  mode?: TeamMode;
};

/**
 * The single model-planning kernel shared by launch preview/start, team.plan, and design planning.
 * It selects Profiles and reports issues; prompts, labels, target checks, and blocker copy stay in
 * their callers.
 */
export function buildTeamModelPlan(input: BuildTeamModelPlanInput): TeamModelPlan {
  const stored = readStoredMode(input.team.mode);
  const effectiveMode = input.mode ?? (stored.status === "known" ? stored.mode : null);
  const rawMode = effectiveMode === null && stored.status === "unknown" ? stored.raw : undefined;

  const seatPlan = buildSeatPlan({
    team: input.team,
    roles: input.roles,
    host: input.host,
    economy: input.economy,
    maxMembers: input.maxMembers,
    ...(effectiveMode === null ? {} : { mode: effectiveMode }),
    runtimeCapabilities: input.runtimeCapabilities,
  });

  const issues: ModeIssue[] = [...seatPlan.issues];
  const role = input.roles.find((entry) => entry.id === input.team.coordinatorRoleId) ?? null;
  let coordinator: TeamModelCoordinator = {
    role,
    selection: null,
    warnings: [],
    legacyFailureReason: null,
    issues: [],
  };
  if (effectiveMode !== null && role !== null) {
    const resolved = resolveCoordinatorProfile({
      mode: effectiveMode,
      role,
      host: input.host,
      economy: input.economy,
    });
    if (resolved.ok) {
      coordinator = {
        role,
        selection: resolved.selection,
        warnings: resolved.warnings,
        legacyFailureReason: null,
        issues: [],
      };
    } else {
      coordinator = {
        role,
        selection: null,
        warnings: [],
        legacyFailureReason: resolved.legacyReason ?? null,
        issues: resolved.issues,
      };
    }
  }
  issues.push(...coordinator.issues);
  const blockers = issues.filter((entry) => entry.severity === "blocker");
  return {
    effectiveMode,
    ...(rawMode === undefined ? {} : { rawMode }),
    team: input.team,
    seatPlan,
    coordinator,
    issues,
    blockers,
  };
}

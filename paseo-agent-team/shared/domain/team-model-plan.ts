import type { Role } from "../schemas/role";
import type { Team } from "../schemas/team";
import {
  type HostSnapshot,
  type ProfileSelection,
  resolveCoordinatorProfile,
} from "./mode-resolver";
import { reviewFamilyIssue } from "./review-family";
import type { ModeIssue } from "./role-execution";
import { buildSeatPlan, type RuntimeCapabilities, type SeatPlan } from "./seat-plan";

/**
 * The fields planning reads from a Team; drafts never need ids, names, or timestamps. A stored
 * `mode` or `collaboration` is deliberately not among them: those fields are retired.
 */
export type TeamPlanningFields = Pick<Team, "coordinatorRoleId" | "members" | "memberCreation">;

export type TeamModelCoordinator = {
  role: Role | null;
  selection: ProfileSelection | null;
  warnings: readonly string[];
  /** resolveProfile's reason (e.g. provider-unavailable); the caller localizes it. */
  legacyFailureReason: string | null;
};

export type TeamModelPlan = {
  /** Always "sota": the DTOs keep their `mode` field, but there is one planning path. */
  effectiveMode: "sota";
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
  maxMembers: number;
  runtimeCapabilities?: RuntimeCapabilities;
};

/**
 * The single model-planning kernel shared by launch preview/start, team.plan, and design planning.
 * It selects Profiles and reports issues; prompts, labels, target checks, and blocker copy stay in
 * their callers.
 */
export function buildTeamModelPlan(input: BuildTeamModelPlanInput): TeamModelPlan {
  const seatPlan = buildSeatPlan({
    team: input.team,
    roles: input.roles,
    host: input.host,
    maxMembers: input.maxMembers,
    runtimeCapabilities: input.runtimeCapabilities,
  });

  const role = input.roles.find((entry) => entry.id === input.team.coordinatorRoleId) ?? null;
  let coordinator: TeamModelCoordinator = {
    role,
    selection: null,
    warnings: [],
    legacyFailureReason: null,
  };
  if (role !== null) {
    const resolved = resolveCoordinatorProfile({ role, host: input.host });
    coordinator = resolved.ok
      ? {
          role,
          selection: resolved.selection,
          warnings: resolved.warnings,
          legacyFailureReason: null,
        }
      : { role, selection: null, warnings: [], legacyFailureReason: resolved.legacyReason };
  }

  const issues: ModeIssue[] = [...seatPlan.issues];
  const reviewIssue = reviewFamilyIssue(seatPlan.seats);
  if (reviewIssue !== null) issues.push(reviewIssue);
  const blockers = issues.filter((entry) => entry.severity === "blocker");
  return {
    effectiveMode: "sota",
    team: input.team,
    seatPlan,
    coordinator,
    issues,
    blockers,
  };
}

import type { PaseoProfile } from "../paseo/adapter";
import type { CoordinatorPreview, ModeLaunchPreview, SeatPreview } from "../schemas/launch-preview";
import type { LaunchPlan } from "./launch-plan";
import { budgetOf, type EconomyPolicy, type ProfileSelection } from "./mode-resolver";
import type { ModeIssue } from "./role-execution";

function profileTuple(profile: PaseoProfile) {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    ...(profile.model === undefined ? {} : { model: profile.model }),
    ...(profile.modeId === undefined ? {} : { modeId: profile.modeId }),
    ...(profile.thinkingOptionId === undefined
      ? {}
      : { thinkingOptionId: profile.thinkingOptionId }),
  };
}

function profileOf(selection: ProfileSelection) {
  return selection.unavailable ? null : profileTuple(selection.profile);
}

function issueKey(issue: ModeIssue): string {
  return JSON.stringify([
    issue.code,
    issue.severity,
    issue.seatId ?? null,
    issue.roleId ?? null,
    issue.profileId ?? null,
    Object.entries(issue.params).sort(([left], [right]) => left.localeCompare(right)),
  ]);
}

function dedupeIssues(issues: readonly ModeIssue[]): ModeIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = issueKey(issue);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function issuesOf(selection: ProfileSelection) {
  return selection.issues.map((issue) => ({
    code: issue.code,
    severity: issue.severity,
    ...(issue.roleId === undefined ? {} : { roleId: issue.roleId }),
    ...(issue.seatId === undefined ? {} : { seatId: issue.seatId }),
    ...(issue.profileId === undefined ? {} : { profileId: issue.profileId }),
    params: issue.params,
  }));
}

/** Maps an internal launch plan to the app-facing preview DTO; prompts, MCP, and notes stay out. */
export function toModeLaunchPreview(
  plan: LaunchPlan,
  planHash: string,
  extraIssues: readonly ModeIssue[],
  economy: EconomyPolicy,
): ModeLaunchPreview {
  const seats: SeatPreview[] = plan.seats.map((seat) => ({
    seatId: seat.seatId,
    logicalSeatId: seat.logicalSeatId,
    roleId: seat.roleId,
    roleName: seat.roleName,
    ...(seat.instanceLabel === undefined ? {} : { instanceLabel: seat.instanceLabel }),
    purpose: seat.purpose,
    activation: seat.activation,
    ...(seat.cohortId === undefined ? {} : { cohortId: seat.cohortId }),
    profile: profileOf(seat.selected),
    source: seat.selected.source,
    ...(seat.selected.family === undefined ? {} : { family: seat.selected.family }),
    alternates: [...(seat.selected.alternates ?? [])],
    budget: seat.selected.budget,
    budgetBasis: seat.selected.budgetBasis,
    standby: seat.selected.standby,
    unavailable: seat.selected.unavailable,
    issues: issuesOf(seat.selected),
  }));

  const coordinatorProfile =
    plan.coordinator.profile.id === "missing" ? null : profileTuple(plan.coordinator.profile);
  const coordinatorBudget =
    plan.coordinator.profile.id === "missing"
      ? undefined
      : budgetOf(plan.coordinator.profile.id, economy);
  // SOTA is the host's explicit original-binding mode, so an unlabeled seat there is SOTA budget.
  const effectiveCoordinatorBudget =
    plan.mode === "sota" &&
    coordinatorBudget?.budget === "unknown" &&
    coordinatorBudget.basis === "conservative-default"
      ? { budget: "sota" as const, basis: "host" as const }
      : coordinatorBudget;
  const coordinator: CoordinatorPreview = {
    roleId: plan.coordinator.role.id,
    roleName: plan.coordinator.role.name,
    profile: coordinatorProfile,
    source: plan.coordinator.source === "role-fallback" ? "role-fallback" : "role-preferred",
    ...(effectiveCoordinatorBudget === undefined
      ? {}
      : {
          budget: effectiveCoordinatorBudget.budget,
          budgetBasis: effectiveCoordinatorBudget.basis,
        }),
    issues: [],
  };

  return {
    requestedMode: plan.mode,
    coordinator,
    seats,
    counts: plan.seatCounts,
    budget: plan.seatBudget,
    issues: dedupeIssues([...extraIssues, ...plan.seatIssues]),
    warnings: plan.warnings,
    planHash,
  };
}

import type { PaseoProfile } from "../paseo/adapter";
import type { CoordinatorPreview, ModeLaunchPreview, SeatPreview } from "../schemas/launch-preview";
import { type LaunchPlan, warningIssueText } from "./launch-plan";
import { FIXED_BUDGET, type ProfileSelection } from "./mode-resolver";
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

/** Preview and start share these warnings; text is the identity, so two rows stay distinct. */
export function launchPreviewWarnings(plan: LaunchPlan): string[] {
  const warnings = [...plan.warnings];
  for (const issue of plan.seatIssues) {
    if (issue.severity !== "warning") continue;
    const text = warningIssueText(issue, plan.seats);
    if (!warnings.includes(text)) warnings.push(text);
  }
  return warnings;
}

/**
 * Maps an internal launch plan to the app-facing preview DTO; prompts, MCP, and notes stay out.
 * The DTO keeps every field an older page parses: standby / unavailable are false, alternates are
 * empty, and the budget label is the fixed `unknown` on the `host` basis.
 */
export function toModeLaunchPreview(plan: LaunchPlan, planHash: string): ModeLaunchPreview {
  const seats: SeatPreview[] = plan.seats.map((seat) => ({
    seatId: seat.seatId,
    logicalSeatId: seat.logicalSeatId,
    roleId: seat.roleId,
    roleName: seat.roleName,
    ...(seat.instanceLabel === undefined ? {} : { instanceLabel: seat.instanceLabel }),
    purpose: seat.purpose,
    activation: seat.activation,
    profile: profileTuple(seat.selected.profile),
    source: seat.selected.source,
    alternates: [],
    budget: FIXED_BUDGET.budget,
    budgetBasis: FIXED_BUDGET.budgetBasis,
    standby: false,
    unavailable: false,
    issues: issuesOf(seat.selected),
  }));

  const missing = plan.coordinator.profile.id === "missing";
  const coordinator: CoordinatorPreview = {
    roleId: plan.coordinator.role.id,
    roleName: plan.coordinator.role.name,
    profile: missing ? null : profileTuple(plan.coordinator.profile),
    source: plan.coordinator.source === "role-fallback" ? "role-fallback" : "role-preferred",
    ...(missing ? {} : { budget: FIXED_BUDGET.budget, budgetBasis: FIXED_BUDGET.budgetBasis }),
    issues: [],
  };

  return {
    requestedMode: plan.mode,
    coordinator,
    seats,
    counts: plan.seatCounts,
    budget: plan.seatBudget,
    issues: dedupeIssues(plan.seatIssues),
    warnings: launchPreviewWarnings(plan),
    planHash,
  };
}

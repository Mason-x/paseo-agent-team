import { routeOf } from "../../shared/domain/cheap-routing";
import type {
  DesignPlanCheck,
  DesignPlanningCapabilities,
  DesignPlanningInput,
  DesignPlanningPort,
} from "../../shared/domain/design-planning";
import { buildLaunchPlan } from "../../shared/domain/launch-plan";
import { launchPreviewWarnings, toModeLaunchPreview } from "../../shared/domain/launch-preview";
import { LAUNCH_RUNTIME_CAPABILITIES } from "../../shared/domain/launch-runtime";
import { type EconomyPolicy, normalizeEconomyPolicy } from "../../shared/domain/mode-resolver";
import type { DesignIssue, DesignRoleGap } from "../../shared/schemas/design";
import type { TeamMode } from "../../shared/schemas/team-mode";
import { hashLaunchPlan } from "../launch-hash";
import type { DesignModeRouting } from "./context";

const EMPTY_ECONOMY: EconomyPolicy = { pool: [], taskOrder: {}, profileBudget: {} };

/** Thin production adapter over T2 (mode), T3 (seats), and T4 (preview/hash). */
export function createDesignPlanner(
  capabilities: DesignPlanningCapabilities = LAUNCH_RUNTIME_CAPABILITIES,
): DesignPlanningPort {
  return { plan: (input) => planDesign(input, capabilities) };
}

export function planDesign(
  input: DesignPlanningInput,
  capabilities: DesignPlanningCapabilities = LAUNCH_RUNTIME_CAPABILITIES,
): DesignPlanCheck {
  const economy = normalizeEconomyPolicy(
    input.preferences.economy,
    input.host.status === "ready" ? input.host.profiles : [],
  );
  const economyValue = economy.ok ? economy.value : EMPTY_ECONOMY;
  const economyIssues = economy.ok ? (economy.issues ?? []) : economy.issues;
  const profiles = input.host.status === "ready" ? input.host.profiles : [];
  const availability = input.host.status === "ready" ? input.host.availability : [];

  const plan = buildLaunchPlan({
    team: input.team,
    roles: input.roles,
    profiles,
    availability,
    workspaceId: input.workspaceId,
    task: input.request,
    runId: `design-${input.jobId}`,
    maxMembers: input.preferences.maxMembers,
    mode: input.mode,
    host: input.host,
    economy: economyValue,
    runtimeCapabilities: capabilities,
    daemonConfig: input.daemonConfig,
  });
  const issues = [...economyIssues, ...plan.seatIssues];
  const launchBlockers = [...plan.blockers];
  // Display-only fingerprint. The LaunchDialog must run launch.preview again so the user
  // confirms the same plan that will be started.
  const planHash = hashLaunchPlan({
    team: plan.team,
    roles: input.roles,
    plan,
    host: input.host,
    economy: economyValue,
    target: { kind: "workspace", workspaceId: input.workspaceId },
    task: input.request,
    maxMembers: input.preferences.maxMembers,
    runtimeCapabilities: capabilities,
  });
  if (launchBlockers.length > 0) {
    return {
      ok: false,
      issues,
      launchBlockers,
      launchWarnings: launchPreviewWarnings(plan, economyIssues),
    };
  }
  return {
    ok: true,
    preview: toModeLaunchPreview(plan, planHash, economyIssues, economyValue),
    issues,
    launchWarnings: launchPreviewWarnings(plan, economyIssues),
  };
}

/**
 * AC-0d.16 for a suggested Profile: in economy-all a new Role's Profile must be a candidate of
 * the route its own `use` and `executionPolicy` pick, and that candidate must pass D02's cheap
 * eligibility. The route table comes from the context snapshot, so this never re-plans the team;
 * launching still re-derives everything through D02. Returns no issue when the mode is legacy or
 * the gap is an `unlaunchable-role` (the inventory verdict already covers it).
 */
export function checkGapEconomyEligibility(input: {
  mode: TeamMode;
  gap: DesignRoleGap;
  routing: DesignModeRouting | undefined;
  path?: DesignIssue["path"];
}): DesignIssue[] {
  if (input.mode !== "economy-all") return [];
  if (input.gap.kind !== "missing-role") return [];
  const path = input.path ?? [];
  const routing = input.routing;
  // A `none` claim names no Profile, so it needs no route evidence; the non-empty reason is
  // schema-enforced. Only a missing snapshot (wiring bug) stays an internal error: absent or
  // invalid policies are exactly the cases the prompt tells the model to answer with `none`.
  if (input.gap.profiles.kind === "none") {
    return routing === undefined
      ? [modePlanIssue(path, { modeCode: "MODE_CHEAP_POLICY_REQUIRED", reason: "routing-missing" })]
      : [];
  }
  if (routing === undefined || routing.status === "absent") {
    return [modePlanIssue(path, { modeCode: "MODE_CHEAP_POLICY_REQUIRED", reason: "absent" })];
  }
  if (routing.status === "invalid") {
    return [
      modePlanIssue(path, { modeCode: "MODE_CHEAP_POLICY_REQUIRED", reason: routing.reason }),
    ];
  }
  const { use, profiles, suggestedRole } = input.gap;
  const policy = suggestedRole.executionPolicy;
  const route = routeOf(use === "coordinator" ? "coordinator" : "member", policy.tier);
  const taskKind = route === "execution" ? policy.taskKind : null;
  const row = routing.routes.find((entry) => entry.route === route && entry.taskKind === taskKind);
  if (row === undefined || row.candidates.length === 0) {
    return [modePlanIssue(path, { modeCode: "MODE_CHEAP_ROUTE_UNAVAILABLE", route })];
  }
  const issues: DesignIssue[] = [];
  for (const [index, profileId] of profiles.profileIds.entries()) {
    const candidate = row.candidates.find((entry) => entry.profileId === profileId);
    if (candidate?.eligible === true) continue;
    issues.push(
      modePlanIssue([...path, "profiles", "profileIds", index], {
        modeCode: "MODE_CHEAP_PROFILE_INVALID",
        route,
        profileId,
        reason: candidate?.reason ?? "outside-list",
      }),
    );
  }
  return issues;
}

function modePlanIssue(
  path: DesignIssue["path"],
  params: Record<string, string | number>,
): DesignIssue {
  return {
    code: "DESIGN_MODE_PLAN_INVALID",
    severity: "error",
    path,
    params,
    action: "repair",
  };
}

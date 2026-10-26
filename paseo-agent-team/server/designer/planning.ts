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
import { hashLaunchPlan } from "../launch-hash";

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

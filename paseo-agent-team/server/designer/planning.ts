import type {
  DesignPlanCheck,
  DesignPlanningCapabilities,
  DesignPlanningInput,
  DesignPlanningPort,
} from "../../shared/domain/design-planning";
import { buildLaunchPlan } from "../../shared/domain/launch-plan";
import { launchPreviewWarnings, toModeLaunchPreview } from "../../shared/domain/launch-preview";
import { LAUNCH_RUNTIME_CAPABILITIES } from "../../shared/domain/launch-runtime";
import { hashLaunchPlan } from "../launch-hash";

/** Thin production adapter over the Team planner (seats), the preview mapping, and the hash. */
export function createDesignPlanner(
  capabilities: DesignPlanningCapabilities = LAUNCH_RUNTIME_CAPABILITIES,
): DesignPlanningPort {
  return { plan: (input) => planDesign(input, capabilities) };
}

export function planDesign(
  input: DesignPlanningInput,
  capabilities: DesignPlanningCapabilities = LAUNCH_RUNTIME_CAPABILITIES,
): DesignPlanCheck {
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
    host: input.host,
    runtimeCapabilities: capabilities,
    daemonConfig: input.daemonConfig,
  });
  const issues = [...plan.seatIssues];
  const launchBlockers = [...plan.blockers];
  // Display-only fingerprint. The LaunchDialog must run launch.preview again so the user
  // confirms the same plan that will be started.
  const planHash = hashLaunchPlan({
    team: plan.team,
    roles: input.roles,
    plan,
    host: input.host,
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
      launchWarnings: launchPreviewWarnings(plan),
    };
  }
  return {
    ok: true,
    preview: toModeLaunchPreview(plan, planHash),
    issues,
    launchWarnings: launchPreviewWarnings(plan),
  };
}

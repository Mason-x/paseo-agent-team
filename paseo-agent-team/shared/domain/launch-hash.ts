import type { PaseoProfile, ProviderAvailability } from "../paseo/adapter";
import type { Role } from "../schemas/role";
import type { Team } from "../schemas/team";
import { canonicalize } from "./catalog-content";
import type { LaunchPlan } from "./launch-plan";
import type { HostSnapshot } from "./mode-resolver";
import { omitRetired } from "./retired-fields";
import { MAX_RUNTIME_MEMBERS, type RuntimeCapabilities } from "./seat-plan";

export type LaunchHashTarget =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "new-workspace"; projectId: string; title?: string };

export type LaunchPlanHashInput = {
  team: Team;
  roles: readonly Role[];
  plan: LaunchPlan;
  host: HostSnapshot;
  target: LaunchHashTarget;
  task: string;
  maxMembers: number;
  runtimeCapabilities: RuntimeCapabilities;
};

/**
 * Bumped when the planner's inputs change shape. A preview made before the single-path planner
 * (no version, or 2) can never match a fingerprint made by this one, so it asks for a new preview.
 */
export const LAUNCH_PLANNER_VERSION = 3;

function profileTuple(profile: PaseoProfile): Record<string, unknown> {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    model: profile.model ?? null,
    modeId: profile.modeId ?? null,
    thinkingOptionId: profile.thinkingOptionId ?? null,
    featureValues: profile.featureValues ?? null,
  };
}

function selectedProfileIds(plan: LaunchPlan): Set<string> {
  const ids = new Set<string>();
  if (plan.coordinator.profile.id !== "missing") ids.add(plan.coordinator.profile.id);
  for (const seat of plan.seats) ids.add(seat.selected.profile.id);
  return ids;
}

/**
 * Canonical launch fingerprint input. The hash covers only what can change this launch plan: the
 * selected Team, its referenced Roles, selected Profile runtime tuples, maxMembers, availability,
 * runtime capabilities, target, and task. Retired settings keys (a Team's mode and collaboration, a
 * Role's executionPolicy) are left out: planning ignores them, so saving them away cannot change a
 * launch. Seat ids, run ids, unrelated Roles or Teams, document revisions, Profile notes, and other
 * preference fields are deliberately absent.
 */
export function launchPlanFingerprint(input: LaunchPlanHashInput): string {
  const referencedRoleIds = new Set<string>([
    input.team.coordinatorRoleId,
    ...input.team.members.map((member) => member.roleId),
  ]);
  const roles = input.roles
    .filter((role) => referencedRoleIds.has(role.id))
    .map((role) => canonicalize(omitRetired("role", role) as unknown as Record<string, unknown>))
    .sort();

  const profileIds = selectedProfileIds(input.plan);
  const profiles =
    input.host.status === "ready"
      ? input.host.profiles
          .filter((profile) => profileIds.has(profile.id))
          .map(profileTuple)
          .sort((left, right) => String(left.id).localeCompare(String(right.id)))
      : null;
  const providers = new Set((profiles ?? []).map((profile) => String(profile.provider)));
  const availability: ProviderAvailability[] | null =
    input.host.status === "ready"
      ? input.host.availability
          .filter((entry) => providers.has(entry.provider))
          .sort((left, right) => left.provider.localeCompare(right.provider))
      : null;

  const seats = input.plan.seats.map((seat) => ({
    roleId: seat.roleId,
    instanceLabel: seat.instanceLabel ?? null,
    purpose: seat.purpose,
    activation: seat.activation,
    profileId: seat.selected.profile.id,
    source: seat.selected.source,
  }));

  const payload: Record<string, unknown> = {
    plannerVersion: LAUNCH_PLANNER_VERSION,
    team: canonicalize(omitRetired("team", input.team) as unknown as Record<string, unknown>),
    roles,
    coordinator: {
      roleId: input.plan.coordinator.role.id,
      profileId:
        input.plan.coordinator.profile.id === "missing" ? null : input.plan.coordinator.profile.id,
      source: input.plan.coordinator.source,
    },
    seats,
    profiles,
    availability,
    target: input.target,
    task: input.task.trim(),
    maxMembers: Math.min(input.maxMembers, MAX_RUNTIME_MEMBERS),
    runtimeCapabilities: input.runtimeCapabilities,
  };
  return canonicalize(payload);
}

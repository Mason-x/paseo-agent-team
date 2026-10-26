import type { PaseoProfile, ProviderAvailability } from "../paseo/adapter";
import type { Role } from "../schemas/role";
import type { Team } from "../schemas/team";
import { canonicalize } from "./catalog-content";
import type { LaunchPlan } from "./launch-plan";
import type { EconomyPolicy, HostSnapshot } from "./mode-resolver";
import { MAX_RUNTIME_MEMBERS, type RuntimeCapabilities } from "./seat-plan";

export type LaunchHashTarget =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "new-workspace"; projectId: string; title?: string };

export type LaunchPlanHashInput = {
  team: Team;
  roles: readonly Role[];
  plan: LaunchPlan;
  host: HostSnapshot;
  economy: EconomyPolicy;
  target: LaunchHashTarget;
  task: string;
  maxMembers: number;
  runtimeCapabilities: RuntimeCapabilities;
};

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

function selectedProfileIds(plan: LaunchPlan, economy: EconomyPolicy): Set<string> {
  const ids = new Set<string>(economy.pool.map((entry) => entry.profileId));
  if (plan.coordinator.profile.id !== "missing") ids.add(plan.coordinator.profile.id);
  for (const seat of plan.seats) {
    if (seat.selected.unavailable) continue;
    ids.add(seat.selected.profile.id);
    for (const alternate of seat.selected.alternates ?? []) ids.add(alternate);
  }
  return ids;
}

/**
 * Canonical launch fingerprint input. The hash covers only what can change this launch plan: the
 * selected Team, its referenced Roles, selected Profile runtime tuples, economy policy, maxMembers,
 * availability, mode, runtime capabilities, target, and task. Seat ids, run ids, unrelated Roles
 * or Teams, document revisions, Profile notes, and other preference fields are deliberately absent.
 */
export function launchPlanFingerprint(input: LaunchPlanHashInput): string {
  const referencedRoleIds = new Set<string>([
    input.team.coordinatorRoleId,
    ...input.team.members.map((member) => member.roleId),
  ]);
  const roles = input.roles
    .filter((role) => referencedRoleIds.has(role.id))
    .map((role) => canonicalize(role as unknown as Record<string, unknown>))
    .sort();

  const profileIds = selectedProfileIds(input.plan, input.economy);
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
    profileId: seat.selected.unavailable ? null : seat.selected.profile.id,
    source: seat.selected.source,
    family: seat.selected.family ?? null,
    alternates: [...(seat.selected.alternates ?? [])],
    budget: seat.selected.budget,
    budgetBasis: seat.selected.budgetBasis,
    standby: seat.selected.standby,
    unavailable: seat.selected.unavailable,
  }));

  const payload: Record<string, unknown> = {
    mode: input.plan.mode,
    team: canonicalize(input.team as unknown as Record<string, unknown>),
    roles,
    coordinator: {
      roleId: input.plan.coordinator.role.id,
      profileId:
        input.plan.coordinator.profile.id === "missing" ? null : input.plan.coordinator.profile.id,
      source: input.plan.coordinator.source,
    },
    seats,
    economy: {
      pool: input.economy.pool,
      taskOrder: input.economy.taskOrder,
      profileBudget: input.economy.profileBudget,
    },
    profiles,
    availability,
    target: input.target,
    task: input.task.trim(),
    maxMembers: Math.min(input.maxMembers, MAX_RUNTIME_MEMBERS),
    runtimeCapabilities: input.runtimeCapabilities,
  };
  return canonicalize(payload);
}

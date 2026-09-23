import type { Role } from "../../shared/schemas/role";
import type { Team, TeamMember } from "../../shared/schemas/team";
import { zh } from "../../shared/zh";
import type { PaseoProfile, ProviderAvailability } from "../paseo/adapter";
import { teamLabels } from "../paseo/labels";
import { type ProfileSource, resolveProfile } from "./profile-resolver";
import {
  compileCoordinatorSystemPrompt,
  compileKickoffMessage,
  compileMemberSystemPrompt,
} from "./prompt-compiler";

export type PlannedAgent = {
  kind: "coordinator" | "member";
  role: Role;
  instanceLabel?: string;
  profile: PaseoProfile;
  source: ProfileSource;
  title: string;
  labels: Record<string, string>;
  systemPrompt: string;
};

export type LaunchPlan = {
  runId: string;
  team: Team;
  workspaceId: string;
  task: string;
  coordinator: PlannedAgent;
  members: PlannedAgent[];
  kickoffMessage: string;
  warnings: string[];
  blockers: string[];
};

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1).trimEnd();
}

function memberTitle(role: Role, team: Team, instanceLabel?: string): string {
  const instance = instanceLabel ? ` (${instanceLabel})` : "";
  return truncate(`${role.name}${instance} · ${team.name}`, 60);
}

function coordinatorTitle(team: Team, task: string): string {
  return truncate(`${zh.teamTitlePrefix} ${team.name}: ${task.slice(0, 30)}`, 60);
}

function roleLabel(role: Role, instanceLabel?: string): string {
  return instanceLabel ? `${role.name} (${instanceLabel})` : role.name;
}

export function buildLaunchPlan(input: {
  team: Team | undefined;
  roles: readonly Role[];
  profiles: readonly PaseoProfile[];
  availability: readonly ProviderAvailability[];
  workspaceId: string;
  task: string;
  runId: string;
  maxMembers: number;
  coordinatorToolsHint?: string | null;
}): LaunchPlan {
  const warnings: string[] = [];
  const blockers: string[] = [];
  const task = input.task.trim();
  if (!task) blockers.push(zh.taskRequired);

  const emptyCoordinator = {
    kind: "coordinator" as const,
    role: {
      id: "missing",
      name: zh.missing,
      mission: "missing",
      responsibilities: ["missing"],
      restrictions: [],
      systemPrompt: "missing",
      outputContract: [],
      preferredProfiles: [{ profileId: "missing" }],
      fallbackProfiles: [],
      enabled: false,
      createdAt: "",
      updatedAt: "",
    } satisfies Role,
    profile: { id: "missing", name: zh.missing, provider: "missing" },
    source: "role-preferred" as const,
    title: zh.missing,
    labels: {},
    systemPrompt: "",
  };

  if (!input.team) {
    blockers.push(zh.teamDoesNotExist);
    return {
      runId: input.runId,
      team: {
        id: "missing",
        name: zh.missing,
        coordinatorRoleId: "missing",
        members: [{ roleId: "missing", enabled: true }],
        enabled: false,
        createdAt: "",
        updatedAt: "",
      },
      workspaceId: input.workspaceId,
      task,
      coordinator: emptyCoordinator,
      members: [],
      kickoffMessage: "",
      warnings,
      blockers,
    };
  }

  const team = input.team;

  const coordinatorRole = input.roles.find((role) => role.id === team.coordinatorRoleId);
  if (!coordinatorRole) {
    blockers.push(zh.coordinatorMissing(team.coordinatorRoleId));
  }

  const enabledMembers: Array<{ member: TeamMember; role: Role }> = [];
  for (const member of team.members) {
    const role = input.roles.find((entry) => entry.id === member.roleId);
    if (!role) {
      if (member.enabled) blockers.push(zh.memberMissing(member.roleId));
      continue;
    }
    if (!member.enabled) {
      warnings.push(zh.skippingDisabled(roleLabel(role, member.instanceLabel)));
      continue;
    }
    enabledMembers.push({ member, role });
  }

  if (enabledMembers.length === 0) {
    blockers.push(zh.noEnabledMembers);
  } else if (enabledMembers.length > input.maxMembers) {
    blockers.push(zh.exceedMax(enabledMembers.length, input.maxMembers));
  }

  let coordinator: PlannedAgent = emptyCoordinator;
  if (coordinatorRole) {
    const resolved = resolveProfile(coordinatorRole, input.profiles, input.availability);
    if (!resolved.ok) {
      blockers.push(zh.coordinatorProfileFail(resolved.reason));
    } else {
      warnings.push(...resolved.warnings);
      const title = coordinatorTitle(team, task);
      coordinator = {
        kind: "coordinator",
        role: coordinatorRole,
        profile: resolved.profile,
        source: resolved.source,
        title,
        labels: teamLabels({
          runId: input.runId,
          teamId: team.id,
          teamName: team.name,
          roleId: coordinatorRole.id,
          roleName: coordinatorRole.name,
          kind: "coordinator",
        }),
        systemPrompt: compileCoordinatorSystemPrompt({ role: coordinatorRole, team }),
      };
      if (input.coordinatorToolsHint) warnings.push(input.coordinatorToolsHint);
    }
  }

  const members: PlannedAgent[] = [];
  for (const { member, role } of enabledMembers) {
    const resolved = resolveProfile(role, input.profiles, input.availability);
    if (!resolved.ok) {
      blockers.push(zh.memberProfileFail(roleLabel(role, member.instanceLabel), resolved.reason));
      continue;
    }
    warnings.push(...resolved.warnings);
    const title = memberTitle(role, team, member.instanceLabel);
    members.push({
      kind: "member",
      role,
      instanceLabel: member.instanceLabel,
      profile: resolved.profile,
      source: resolved.source,
      title,
      labels: teamLabels({
        runId: input.runId,
        teamId: team.id,
        teamName: team.name,
        roleId: role.id,
        roleName: role.name,
        kind: "member",
        instanceLabel: member.instanceLabel,
      }),
      systemPrompt: compileMemberSystemPrompt({
        role,
        teamName: team.name,
        coordinatorTitle: coordinator.title,
        instanceLabel: member.instanceLabel,
      }),
    });
  }

  const kickoffMessage = compileKickoffMessage({
    task,
    runId: input.runId,
    roster: [
      {
        agentId: "(coordinator)",
        role: coordinator.role,
        profile: coordinator.profile,
      },
      ...members.map((member) => ({
        agentId: "(pending)",
        role: member.role,
        instanceLabel: member.instanceLabel,
        profile: member.profile,
      })),
    ],
  });

  return {
    runId: input.runId,
    team,
    workspaceId: input.workspaceId,
    task,
    coordinator,
    members,
    kickoffMessage,
    warnings: [...new Set(warnings)],
    blockers,
  };
}

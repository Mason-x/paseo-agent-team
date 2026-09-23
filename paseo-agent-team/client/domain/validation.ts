import type { Role } from "../../shared/schemas/role";
import type { Team } from "../../shared/schemas/team";
import { zh } from "../../shared/zh";
import type { PaseoProfile } from "../paseo/adapter";

export type MissingProfileWarning = {
  roleId: string;
  roleName: string;
  profileId: string;
  nameSnapshot?: string;
};

export type TeamRoleWarning = {
  teamId: string;
  teamName: string;
  missingRoleIds: string[];
};

export function missingProfileRefs(
  roles: readonly Role[],
  profiles: readonly PaseoProfile[],
): MissingProfileWarning[] {
  const ids = new Set(profiles.map((profile) => profile.id));
  const warnings: MissingProfileWarning[] = [];
  for (const role of roles) {
    for (const ref of [...role.preferredProfiles, ...role.fallbackProfiles]) {
      if (!ids.has(ref.profileId)) {
        warnings.push({
          roleId: role.id,
          roleName: role.name,
          profileId: ref.profileId,
          nameSnapshot: ref.nameSnapshot,
        });
      }
    }
  }
  return warnings;
}

export function teamsUsingRole(teams: readonly Team[], roleId: string): Team[] {
  return teams.filter(
    (team) =>
      team.coordinatorRoleId === roleId || team.members.some((member) => member.roleId === roleId),
  );
}

export function teamRoleWarnings(
  teams: readonly Team[],
  roles: readonly Role[],
): TeamRoleWarning[] {
  const byId = new Map(roles.map((role) => [role.id, role]));
  return teams.map((team) => {
    const referenced = [team.coordinatorRoleId, ...team.members.map((member) => member.roleId)];
    const missingRoleIds = [...new Set(referenced.filter((id) => !byId.has(id)))];
    return { teamId: team.id, teamName: team.name, missingRoleIds };
  });
}

export function preferredProfileLabel(
  role: Role,
  profiles: readonly PaseoProfile[],
): { name: string; missing: boolean } {
  const preferred = role.preferredProfiles[0];
  if (!preferred) return { name: zh.noProfile, missing: true };
  const live = profiles.find((profile) => profile.id === preferred.profileId);
  if (live) return { name: live.name, missing: false };
  return {
    name: zh.missingProfile(preferred.nameSnapshot ?? preferred.profileId),
    missing: true,
  };
}

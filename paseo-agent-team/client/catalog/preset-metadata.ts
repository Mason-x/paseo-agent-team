import type { PaseoProfile } from "../../shared/paseo/adapter";
import type { ProfileRef } from "../../shared/schemas/profile-ref";
import { type Role, RoleSchema } from "../../shared/schemas/role";
import { type Team, TeamSchema } from "../../shared/schemas/team";

/** Fields the Role editor owns; everything else on a stored Role is metadata or an extension. */
const ROLE_FORM_FIELDS: Record<string, true> = {
  id: true,
  name: true,
  description: true,
  mission: true,
  responsibilities: true,
  restrictions: true,
  systemPrompt: true,
  outputContract: true,
  preferredProfiles: true,
  fallbackProfiles: true,
  mcpServers: true,
  color: true,
  icon: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
};

/** Fields the Team editor owns; a future `designer` field and other extensions survive a save. */
const TEAM_FORM_FIELDS: Record<string, true> = {
  id: true,
  name: true,
  description: true,
  coordinatorRoleId: true,
  members: true,
  operatingRules: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
};

/** Keep source/preset/designer and unknown top-level keys while the form's own fields win. */
export function keepRoleMetadata(original: Role | null, next: Role): Role {
  if (!original) return next;
  const extensions = Object.fromEntries(
    Object.entries(original).filter(([key]) => !ROLE_FORM_FIELDS[key]),
  );
  return RoleSchema.parse({ ...extensions, ...next });
}

export function keepTeamMetadata(original: Team | null, next: Team): Team {
  if (!original) return next;
  const extensions = Object.fromEntries(
    Object.entries(original).filter(([key]) => !TEAM_FORM_FIELDS[key]),
  );
  return TeamSchema.parse({ ...extensions, ...next });
}

/** A copy is user-owned: it must not claim a preset origin or another Team's designer job. */
export function copyRole(role: Role, id: string, name: string, now: string): Role {
  const { source: _source, preset: _preset, designer: _designer, ...rest } = role;
  return RoleSchema.parse({ ...rest, id, name, createdAt: now, updatedAt: now });
}

export function copyTeam(team: Team, id: string, name: string, now: string): Team {
  const { source: _source, preset: _preset, designer: _designer, ...rest } = team;
  return TeamSchema.parse({ ...rest, id, name, createdAt: now, updatedAt: now });
}

/** A newly picked Profile reference carries no hint; only an untouched stored reference keeps one. */
export function newProfileRef(profile: PaseoProfile): ProfileRef {
  return { profileId: profile.id, nameSnapshot: profile.name };
}

export function addProfileRef(refs: readonly ProfileRef[], profile: PaseoProfile): ProfileRef[] {
  if (refs.some((ref) => ref.profileId === profile.id)) return [...refs];
  return [...refs, newProfileRef(profile)];
}

/** Reordering carries the exact stored references, hints included. */
export function moveProfileRef(
  refs: readonly ProfileRef[],
  index: number,
  direction: -1 | 1,
): ProfileRef[] {
  const target = index + direction;
  if (target < 0 || target >= refs.length) return [...refs];
  const next = [...refs];
  const [item] = next.splice(index, 1);
  if (item) next.splice(target, 0, item);
  return next;
}

export function removeProfileRef(refs: readonly ProfileRef[], index: number): ProfileRef[] {
  return refs.filter((_, itemIndex) => itemIndex !== index);
}

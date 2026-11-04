import { omitRetired } from "../../shared/domain/retired-fields";
import type { PaseoProfile } from "../../shared/paseo/adapter";
import type { ProfileRef } from "../../shared/schemas/profile-ref";
import { type Role, RoleSchema } from "../../shared/schemas/role";
import { type Team, TeamSchema } from "../../shared/schemas/team";
import { createSeatId } from "../teams/team-mode-edit";

/**
 * `retireLegacyFields` is true only when the TARGET host's capability probe said it no longer reads
 * the retired keys (.notes/274 E2, see ./retirement.ts). Every other case writes the object back the
 * way the earlier version would have, so a host that still reads those keys keeps them.
 */
export type RetireOptions = { retireLegacyFields?: boolean };

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
  memberCreation: true,
  coordinatorRoleId: true,
  members: true,
  operatingRules: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
};

/**
 * Keep source/preset/designer and unknown top-level keys while the form's own fields win. The
 * retired `executionPolicy` is no longer a form field, so it rides along with the other extensions
 * and is dropped here, from this Role only, when the target host retires it.
 */
export function keepRoleMetadata(
  original: Role | null,
  next: Role,
  options: RetireOptions = {},
): Role {
  if (!original) return next;
  const extensions = Object.fromEntries(
    Object.entries(original).filter(([key]) => !ROLE_FORM_FIELDS[key]),
  );
  const merged = { ...extensions, ...next };
  return RoleSchema.parse(
    options.retireLegacyFields === true ? omitRetired("role", merged) : merged,
  );
}

/** Same rule for a Team: `mode` and `collaboration` are extensions now, dropped only on a retiring host. */
export function keepTeamMetadata(
  original: Team | null,
  next: Team,
  options: RetireOptions = {},
): Team {
  if (!original) return next;
  const extensions = Object.fromEntries(
    Object.entries(original).filter(([key]) => !TEAM_FORM_FIELDS[key]),
  );
  const merged = { ...extensions, ...next };
  return TeamSchema.parse(
    options.retireLegacyFields === true ? omitRetired("team", merged) : merged,
  );
}

/** A copy is user-owned: it must not claim a preset origin or another Team's designer job. */
export function copyRole(
  role: Role,
  id: string,
  name: string,
  now: string,
  options: RetireOptions = {},
): Role {
  const { source: _source, preset: _preset, designer: _designer, ...rest } = role;
  const copy = { ...rest, id, name, createdAt: now, updatedAt: now };
  return RoleSchema.parse(options.retireLegacyFields === true ? omitRetired("role", copy) : copy);
}

export function copyTeam(
  team: Team,
  id: string,
  name: string,
  now: string,
  options: RetireOptions & { nowMs?: number; random?: () => number } = {},
): Team {
  const { source: _source, preset: _preset, designer: _designer, ...rest } = team;
  const parsedNow = Date.parse(now);
  const nowMs = options.nowMs ?? (Number.isFinite(parsedNow) ? parsedNow : Date.now());
  const random = options.random ?? Math.random;
  const seats = new Set<string>();
  const members = rest.members.map((member) => {
    const seatId = createSeatId(seats, nowMs, random);
    seats.add(seatId);
    return { ...member, seatId };
  });
  const copy = { ...rest, members, id, name, createdAt: now, updatedAt: now };
  return TeamSchema.parse(options.retireLegacyFields === true ? omitRetired("team", copy) : copy);
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

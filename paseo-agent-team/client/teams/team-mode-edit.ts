import { retiredModeLabel } from "../../shared/domain/mode-contract";
import type { Role } from "../../shared/schemas/role";
import type { Team, TeamMember } from "../../shared/schemas/team";
import { zh } from "../../shared/zh";
import type { MemberCreation } from "../shared/team-mode-options";

export function readMemberCreation(raw: string | undefined): MemberCreation {
  return raw === "eager" || raw === "on-demand" ? raw : "";
}

/**
 * Put only the user-edited member-creation choice into the saved Team. An untouched value
 * (including one this version cannot read) is left exactly as stored; an old Team with none keeps
 * it absent. The retired mode fields are never produced here (.notes/274).
 */
export function buildMemberCreationField(input: {
  original: Pick<Team, "memberCreation"> | null;
  memberCreation: MemberCreation;
  memberCreationTouched: boolean;
}): { memberCreation?: string } {
  const memberCreation = input.memberCreationTouched
    ? input.memberCreation || undefined
    : input.original?.memberCreation;
  return memberCreation === undefined ? {} : { memberCreation };
}

/** What a Team still stores of the retired mode settings; read only to word the E1 notice. */
export type RetiredTeamNotice = { modeLabel: string | null; collaboration: boolean };

export function readRetiredTeamNotice(
  team: Pick<Team, "mode" | "collaboration"> | null | undefined,
): RetiredTeamNotice | null {
  if (!team) return null;
  const modeLabel = retiredModeLabel(team.mode);
  const collaboration = team.collaboration !== undefined;
  return modeLabel === null && !collaboration ? null : { modeLabel, collaboration };
}

/** The one-line notices (E1); empty when the Team carries nothing retired. */
export function retiredTeamNoticeLines(notice: RetiredTeamNotice | null): string[] {
  if (notice === null) return [];
  return [
    ...(notice.modeLabel === null ? [] : [zh.retiredTeamMode(notice.modeLabel)]),
    ...(notice.collaboration ? [zh.retiredTeamCollaboration] : []),
  ];
}

const SEAT_SUFFIX_RADIX = 36 ** 4;

export function createSeatId(
  existing: ReadonlySet<string>,
  now: number = Date.now(),
  random: () => number = Math.random,
): string {
  const base = `seat-${now.toString(36)}-${Math.floor(random() * SEAT_SUFFIX_RADIX)
    .toString(36)
    .padStart(4, "0")}`;
  let candidate = base;
  let n = 2;
  while (existing.has(candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

export function newTeamMember(
  roles: readonly Role[],
  coordinatorRoleId: string,
  existingSeatIds: ReadonlySet<string>,
  now: number = Date.now(),
  random: () => number = Math.random,
): TeamMember {
  const role = roles.find((entry) => entry.id !== coordinatorRoleId);
  return {
    roleId: role?.id ?? "member",
    seatId: createSeatId(existingSeatIds, now, random),
    enabled: true,
  };
}

export function uniqueInstanceLabel(base: string, existingLabels: ReadonlySet<string>): string {
  const root = (base.trim() || zh.member).slice(0, 34);
  let candidate = `${root} ${zh.copySuffix}`.slice(0, 40);
  let n = 2;
  while (existingLabels.has(candidate)) {
    const suffix = ` ${zh.copySuffix} ${n}`;
    candidate = `${root.slice(0, 40 - suffix.length)}${suffix}`;
    n += 1;
  }
  return candidate;
}

function nextLetterLabel(base: string, existingLabels: ReadonlySet<string>): string {
  const root = (base.trim() || zh.member).slice(0, 34);
  for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    const candidate = `${root} ${letter}`.slice(0, 40);
    if (!existingLabels.has(candidate)) return candidate;
  }
  return uniqueInstanceLabel(root, existingLabels);
}

function isLetterLabel(base: string, label: string): boolean {
  const root = `${base.trim() || zh.member} `;
  if (!label.startsWith(root)) return false;
  const suffix = label.slice(root.length);
  return /^[A-Z]$/.test(suffix);
}

/**
 * Duplicate one seat and, when the original had no label, name both sides A/B (then C…) so the
 * Team satisfies the duplicate-Role label rule without a second manual edit.
 */
export function duplicateMemberPair(
  original: TeamMember,
  roleName: string,
  members: readonly TeamMember[],
  now: number = Date.now(),
  random: () => number = Math.random,
): { original: TeamMember; copy: TeamMember } {
  const base = roleName.trim() || original.roleId;
  const labels = usedInstanceLabels(members);
  const seats = usedSeatIds(members);
  const originalLabel = original.instanceLabel?.trim()
    ? original.instanceLabel
    : nextLetterLabel(base, labels);
  labels.add(originalLabel);
  const copyLabel = isLetterLabel(base, originalLabel)
    ? nextLetterLabel(base, labels)
    : uniqueInstanceLabel(originalLabel, labels);
  const originalSeat = original.seatId ?? createSeatId(seats, now, random);
  seats.add(originalSeat);
  const copySeat = createSeatId(seats, now, random);
  return {
    original: {
      ...original,
      seatId: originalSeat,
      instanceLabel: originalLabel,
    },
    copy: {
      ...original,
      seatId: copySeat,
      instanceLabel: copyLabel,
    },
  };
}

/** Seat ids already used by a Team, or an empty set for a new Team. */
export function usedSeatIds(members: readonly TeamMember[]): Set<string> {
  return new Set(members.flatMap((member) => (member.seatId ? [member.seatId] : [])));
}

export function usedInstanceLabels(members: readonly TeamMember[]): Set<string> {
  return new Set(members.flatMap((member) => (member.instanceLabel ? [member.instanceLabel] : [])));
}

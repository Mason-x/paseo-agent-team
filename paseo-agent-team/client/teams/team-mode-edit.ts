import { modeToStore, readStoredMode } from "../../shared/domain/mode-contract";
import type { Role } from "../../shared/schemas/role";
import type { TeamMember } from "../../shared/schemas/team";
import type { StoredCollaboration, TeamMode } from "../../shared/schemas/team-mode";
import { zh } from "../../shared/zh";
import type { MemberCreation } from "../shared/team-mode-options";

export type StoredModeRead = { mode: TeamMode; unknown: string | null };

/**
 * The picker needs a concrete mode, so an unreadable stored value selects the SOTA default in the
 * form — but `unknown` carries the raw value, the editor warns with it, and an untouched save
 * writes the original back (never `sota`).
 */
export function readStoredTeamMode(raw: string | undefined): StoredModeRead {
  const stored = readStoredMode(raw);
  return stored.status === "known"
    ? { mode: stored.mode, unknown: null }
    : { mode: "sota", unknown: stored.raw };
}

export function readMemberCreation(raw: string | undefined): MemberCreation {
  return raw === "eager" || raw === "on-demand" ? raw : "";
}

export type CollaborationDraft = {
  replicas: 2 | 3;
  judgeRoleId: string;
  escalationRoleId: string;
};

export function readCollaboration(raw: StoredCollaboration | undefined): CollaborationDraft {
  return {
    replicas: raw?.replicas === 3 ? 3 : 2,
    judgeRoleId: typeof raw?.judgeRoleId === "string" ? raw.judgeRoleId : "",
    escalationRoleId: typeof raw?.escalationRoleId === "string" ? raw.escalationRoleId : "",
  };
}

export type CollaborationTouched = {
  replicas: boolean;
  judgeRoleId: boolean;
  escalationRoleId: boolean;
};

/**
 * Collaboration is configuration for switching back, so an existing block survives other modes.
 * Untouched fields (including values this version cannot read) are left exactly as stored.
 */
export function buildCollaboration(
  original: StoredCollaboration | undefined,
  draft: CollaborationDraft,
  mode: TeamMode,
  touched: CollaborationTouched = {
    replicas: false,
    judgeRoleId: false,
    escalationRoleId: false,
  },
): StoredCollaboration | undefined {
  const anyTouched = touched.replicas || touched.judgeRoleId || touched.escalationRoleId;
  if (!anyTouched && original) return original;
  if (!anyTouched && !original && mode !== "collaborative") return undefined;
  const block: Record<string, unknown> = { ...(original ?? {}) };
  if (!original || touched.replicas) block.replicas = draft.replicas;
  if (touched.judgeRoleId) {
    if (draft.judgeRoleId) block.judgeRoleId = draft.judgeRoleId;
    else delete block.judgeRoleId;
  }
  if (touched.escalationRoleId) {
    if (draft.escalationRoleId) block.escalationRoleId = draft.escalationRoleId;
    else delete block.escalationRoleId;
  }
  return block;
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

export type TeamModeFields = {
  mode?: string;
  memberCreation?: string;
  collaboration?: StoredCollaboration;
};

/**
 * Put only user-edited mode fields into the saved Team. Untouched values (including unknown ones)
 * are preserved; an old Team with no mode keeps it absent.
 */
export function buildTeamModeFields(input: {
  original: { mode?: string; memberCreation?: string; collaboration?: StoredCollaboration } | null;
  mode: TeamMode;
  modeTouched: boolean;
  memberCreation: MemberCreation;
  memberCreationTouched: boolean;
  collaboration: CollaborationDraft;
  collaborationTouched: CollaborationTouched;
}): TeamModeFields {
  const mode = modeToStore({
    original: input.original?.mode,
    selected: input.mode,
    touched: input.modeTouched,
  });
  const memberCreation = input.memberCreationTouched
    ? input.memberCreation || undefined
    : input.original?.memberCreation;
  const collaboration = buildCollaboration(
    input.original?.collaboration,
    input.collaboration,
    input.mode,
    input.collaborationTouched,
  );
  return {
    ...(mode === undefined ? {} : { mode }),
    ...(memberCreation === undefined ? {} : { memberCreation }),
    ...(collaboration === undefined ? {} : { collaboration }),
  };
}

/** Seat ids already used by a Team, or an empty set for a new Team. */
export function usedSeatIds(members: readonly TeamMember[]): Set<string> {
  return new Set(members.flatMap((member) => (member.seatId ? [member.seatId] : [])));
}

export function usedInstanceLabels(members: readonly TeamMember[]): Set<string> {
  return new Set(members.flatMap((member) => (member.instanceLabel ? [member.instanceLabel] : [])));
}

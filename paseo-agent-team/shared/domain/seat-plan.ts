import type { Role } from "../schemas/role";
import type { Team, TeamMember } from "../schemas/team";
import { type HostSnapshot, type ProfileSelection, resolveSeatProfile } from "./mode-resolver";
import type { ModeIssue, ModeIssueCode } from "./role-execution";

// Storage keeps a saved host limit of any size; a single launch never creates more than this.
export const MAX_RUNTIME_MEMBERS = 64;

// Every planned seat is an ordinary member, created now or on demand. The wider DTO enums
// (candidate / judge / escalation, escalation-only) belong to retired modes and are never produced.
export type SeatPurpose = "member";
export type SeatActivation = "eager" | "on-demand";

export type PlannedSeat = {
  seatId: string;
  logicalSeatId: string;
  roleId: string;
  roleName: string;
  instanceLabel?: string;
  purpose: SeatPurpose;
  activation: SeatActivation;
  selected: ProfileSelection;
};

export type SeatCounts = {
  logical: number;
  physical: number;
  eager: number;
  deferred: number;
  /** Always 0: there are no standby escalation seats. Kept so the preview DTO keeps its shape. */
  escalation: number;
  /** Seats that may consume SOTA budget (budget is sota or unknown): every seat. */
  sotaPotential: number;
};

export type SeatBudgetCounts = {
  economy: number;
  sota: number;
  unknown: number;
  /** Always 0: standby seats do not exist. */
  deferredSota: number;
};

export type SeatPlan = {
  seats: PlannedSeat[];
  counts: SeatCounts;
  budget: SeatBudgetCounts;
  issues: ModeIssue[];
  blockers: ModeIssue[];
};

export type RuntimeCapabilities = {
  onDemand: boolean;
  expansion: boolean;
  collaboration: boolean;
};

export type BuildSeatPlanInput = {
  team: Pick<Team, "members" | "memberCreation">;
  roles: readonly Role[];
  host: HostSnapshot;
  maxMembers: number;
  /** Omitted means "planning only": explicit on-demand creation is not gated. */
  runtimeCapabilities?: RuntimeCapabilities;
};

const EMPTY_COUNTS: SeatCounts = {
  logical: 0,
  physical: 0,
  eager: 0,
  deferred: 0,
  escalation: 0,
  sotaPotential: 0,
};

const EMPTY_BUDGET: SeatBudgetCounts = { economy: 0, sota: 0, unknown: 0, deferredSota: 0 };

type Entry = {
  index: number;
  member: TeamMember;
  logicalSeatId: string;
  instanceLabel?: string;
  role?: Role;
  single?: ProfileSelection;
};

function issue(
  code: ModeIssueCode,
  severity: "warning" | "blocker",
  params: Record<string, string | number | boolean>,
  extra: { roleId?: string; seatId?: string; profileId?: string } = {},
): ModeIssue {
  return { code, severity, params, ...extra };
}

/** Deterministic avoidance: explicit ids win, then generated ids take the next free suffix. */
function uniqueSeatId(base: string, taken: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * Bounded seat planning. Each enabled Team member is one logical seat and one physical seat, bound
 * to its Role's preferred -> fallback Profile. Legacy members without a seatId get a
 * snapshot-local key from their array index, so the same Team snapshot always plans the same ids.
 * A stored mode, collaboration block, or Role tier is never read.
 */
export function buildSeatPlan(input: BuildSeatPlanInput): SeatPlan {
  const issues: ModeIssue[] = [];
  const blockers: ModeIssue[] = [];
  const push = (entry: ModeIssue): void => {
    issues.push(entry);
    if (entry.severity === "blocker") blockers.push(entry);
  };

  const enabledCount = input.team.members.filter((member) => member.enabled).length;
  if (input.host.status === "unavailable") {
    push(
      issue("MODE_CONTEXT_UNAVAILABLE", "blocker", {
        reason: input.host.reason ?? "context-unavailable",
      }),
    );
    return {
      seats: [],
      counts: { ...EMPTY_COUNTS, logical: enabledCount },
      budget: EMPTY_BUDGET,
      issues,
      blockers,
    };
  }
  if (input.host.status === "ready" && input.host.availabilityUnverified) {
    // The availability query failed but Profiles were readable: plan as usual and say so.
    push(issue("MODE_CONTEXT_UNAVAILABLE", "warning", { reason: "availability-unverified" }));
  }

  const rawCreation = input.team.memberCreation?.trim();
  const explicitCreation =
    rawCreation === "eager" || rawCreation === "on-demand" ? rawCreation : undefined;
  const onDemandAvailable = input.runtimeCapabilities?.onDemand !== false;
  let memberActivation: SeatActivation = "eager";
  if (explicitCreation) {
    memberActivation = explicitCreation;
  } else if (rawCreation) {
    // Stored values stay readable; a value this version cannot run blocks the plan instead of
    // silently becoming the default.
    push(issue("MODE_UNKNOWN", "blocker", { field: "memberCreation", value: rawCreation }));
  }
  if (explicitCreation === "on-demand" && !onDemandAvailable) {
    push(issue("MODE_ONDEMAND_UNAVAILABLE", "blocker", { reason: "explicit-on-demand" }));
  }

  const roleById = new Map(input.roles.map((role) => [role.id, role]));
  const roleCounts = new Map<string, number>();
  for (const member of input.team.members) {
    if (!member.enabled) continue;
    roleCounts.set(member.roleId, (roleCounts.get(member.roleId) ?? 0) + 1);
  }

  const explicitSeatIds = new Set<string>();
  for (const member of input.team.members) {
    if (!member.enabled) continue;
    const explicit = member.seatId?.trim();
    if (!explicit) continue;
    if (explicitSeatIds.has(explicit)) {
      push(
        issue("MODE_SEAT_DUPLICATE", "blocker", { seatId: explicit }, { roleId: member.roleId }),
      );
    } else {
      explicitSeatIds.add(explicit);
    }
  }
  const takenSeatIds = new Set(explicitSeatIds);

  const labelsByRole = new Map<string, Map<string, string>>();
  const reportedMissingLabel = new Set<string>();
  const entries: Entry[] = [];
  for (const [index, member] of input.team.members.entries()) {
    if (!member.enabled) continue;
    const explicit = member.seatId?.trim();
    const logicalSeatId = explicit || uniqueSeatId(`seat-${index + 1}`, takenSeatIds);
    const label = member.instanceLabel?.trim();
    const instanceLabel = label ? label : undefined;

    if (instanceLabel) {
      // Labels only need to be distinct within one Role; two Roles may both call a seat "Backend".
      const normalizedLabel = instanceLabel.toLowerCase();
      const seen = labelsByRole.get(member.roleId) ?? new Map<string, string>();
      const previous = seen.get(normalizedLabel);
      if (previous !== undefined) {
        // Teams saved before labels were required could repeat one exactly: keep launching them
        // with a warning.
        push(
          issue(
            "MODE_SEAT_DUPLICATE",
            "warning",
            { instanceLabel, roleId: member.roleId },
            { roleId: member.roleId, seatId: logicalSeatId },
          ),
        );
      } else {
        seen.set(normalizedLabel, instanceLabel);
        labelsByRole.set(member.roleId, seen);
      }
    } else if (
      (roleCounts.get(member.roleId) ?? 0) > 1 &&
      !reportedMissingLabel.has(member.roleId)
    ) {
      reportedMissingLabel.add(member.roleId);
      push(
        issue(
          "MODE_SEAT_DUPLICATE",
          "blocker",
          { roleId: member.roleId, reason: "instance-label-required" },
          { roleId: member.roleId, seatId: logicalSeatId },
        ),
      );
    }

    entries.push({ index, member, logicalSeatId, instanceLabel });
  }

  const withEntryContext = (entry: Entry, entryIssue: ModeIssue): ModeIssue => ({
    ...entryIssue,
    seatId: entryIssue.seatId ?? entry.logicalSeatId,
    params:
      entry.instanceLabel && entryIssue.params.instanceLabel === undefined
        ? { ...entryIssue.params, instanceLabel: entry.instanceLabel }
        : entryIssue.params,
  });

  for (const entry of entries) {
    const role = roleById.get(entry.member.roleId);
    entry.role = role;
    if (!role) {
      push(
        issue(
          "MODE_PROFILE_UNRESOLVED",
          "blocker",
          { reason: "role-missing" },
          { roleId: entry.member.roleId, seatId: entry.logicalSeatId },
        ),
      );
      continue;
    }

    // Teams from before Roles could be disabled launched them as written. Keep that behavior with
    // a warning instead of a blocker.
    const roleForPlan = role.enabled ? role : { ...role, enabled: true };
    if (!role.enabled) {
      push(
        issue(
          "MODE_ROLE_DISABLED",
          "warning",
          {},
          { roleId: role.id, seatId: entry.logicalSeatId },
        ),
      );
    }

    const resolved = resolveSeatProfile({ role: roleForPlan, host: input.host });
    if (!resolved.ok) {
      for (const entryIssue of resolved.issues) push(withEntryContext(entry, entryIssue));
      continue;
    }
    for (const entryIssue of resolved.issues ?? []) push(withEntryContext(entry, entryIssue));
    entry.single = resolved.value;
  }

  const seats: PlannedSeat[] = [];
  for (const entry of entries) {
    if (!entry.role || !entry.single) continue;
    seats.push({
      seatId: entry.logicalSeatId,
      logicalSeatId: entry.logicalSeatId,
      roleId: entry.role.id,
      roleName: entry.role.name,
      ...(entry.instanceLabel === undefined ? {} : { instanceLabel: entry.instanceLabel }),
      purpose: "member",
      activation: memberActivation,
      selected: entry.single,
    });
  }

  const memberLimit = Math.min(input.maxMembers, MAX_RUNTIME_MEMBERS);
  if (seats.length > memberLimit) {
    push(
      issue("MODE_MEMBER_LIMIT", "blocker", {
        members: seats.length,
        limit: memberLimit,
      }),
    );
  }

  const counts: SeatCounts = {
    logical: enabledCount,
    physical: seats.length,
    eager: seats.filter((seat) => seat.activation === "eager").length,
    deferred: seats.filter((seat) => seat.activation === "on-demand").length,
    escalation: 0,
    sotaPotential: seats.length,
  };
  const budget: SeatBudgetCounts = {
    economy: 0,
    sota: 0,
    unknown: seats.length,
    deferredSota: 0,
  };

  return { seats, counts, budget, issues, blockers };
}

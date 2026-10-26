import type { Role } from "../schemas/role";
import type { Team, TeamMember } from "../schemas/team";
import type { RoleTier, TeamMode } from "../schemas/team-mode";
import {
  type EconomyPolicy,
  type HostSnapshot,
  normalizeMode,
  type ProfileSelection,
  resolveModeProfile,
  selectCollaborationProfiles,
} from "./mode-resolver";
import {
  issueValue,
  type ModeIssue,
  type ModeIssueCode,
  resolveRoleExecution,
} from "./role-execution";

// Storage keeps a saved host limit of any size; a single launch never creates more than this.
export const MAX_RUNTIME_MEMBERS = 64;

const DEFAULT_JUDGE_ROLE_IDS = ["qa-test", "qa-acceptance"] as const;

export type SeatPurpose = "member" | "candidate" | "judge" | "escalation";
export type SeatActivation = "eager" | "on-demand" | "escalation-only";

export type PlannedSeat = {
  seatId: string;
  logicalSeatId: string;
  roleId: string;
  roleName: string;
  instanceLabel?: string;
  purpose: SeatPurpose;
  activation: SeatActivation;
  cohortId?: string;
  selected: ProfileSelection;
};

export type SeatCounts = {
  logical: number;
  physical: number;
  eager: number;
  deferred: number;
  escalation: number;
  /** Seats that may consume SOTA budget (budget is sota or unknown). */
  sotaPotential: number;
};

export type SeatBudgetCounts = {
  economy: number;
  sota: number;
  unknown: number;
  /** Standby seats that may later consume SOTA (or unverified) budget; not all deferred seats. */
  deferredSota: number;
};

export type SeatPlan = {
  mode: TeamMode;
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
  team: Team;
  roles: readonly Role[];
  host: HostSnapshot;
  economy: EconomyPolicy;
  maxMembers: number;
  /** Launch-time override; otherwise the Team's stored mode (default sota). */
  mode?: TeamMode;
  /** Omitted means "planning only": the D4 defaults apply without runtime gating. */
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
  tier?: RoleTier;
  single?: ProfileSelection;
  cohort?: { selections: ProfileSelection[] };
  judge?: boolean;
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
 * Bounded seat planning. Each enabled Team member is one logical seat; in collaborative mode an
 * execution seat expands into one candidate per family. Legacy members without a seatId get a
 * snapshot-local key from their array index, so the same Team snapshot always plans the same ids.
 */
export function buildSeatPlan(input: BuildSeatPlanInput): SeatPlan {
  const issues: ModeIssue[] = [];
  const blockers: ModeIssue[] = [];
  const push = (entry: ModeIssue): void => {
    issues.push(entry);
    if (entry.severity === "blocker") blockers.push(entry);
  };

  let mode: TeamMode = "sota";
  if (input.mode !== undefined) {
    mode = input.mode;
  } else {
    const normalized = normalizeMode(input.team.mode);
    if (normalized.ok) mode = normalized.value;
    else {
      normalized.issues.forEach(push);
      const enabled = input.team.members.filter((member) => member.enabled).length;
      return {
        mode,
        seats: [],
        counts: { ...EMPTY_COUNTS, logical: enabled },
        budget: EMPTY_BUDGET,
        issues,
        blockers,
      };
    }
  }

  const enabledCount = input.team.members.filter((member) => member.enabled).length;
  const rawCreation = input.team.memberCreation?.trim();
  const explicitCreation =
    rawCreation === "eager" || rawCreation === "on-demand" ? rawCreation : undefined;
  const onDemandAvailable = input.runtimeCapabilities?.onDemand !== false;
  let memberActivation: Exclude<SeatActivation, "escalation-only"> =
    mode === "sota" ? "eager" : "on-demand";
  if (explicitCreation) {
    memberActivation = explicitCreation;
  } else if (rawCreation) {
    // Stored values stay readable; a value this version cannot run blocks the plan instead of
    // silently becoming the mode default.
    push(issue("MODE_UNKNOWN", "blocker", { field: "memberCreation", value: rawCreation }));
  } else if (!onDemandAvailable && mode === "economy") {
    // Transitional 5A behavior: a Team that never chose on-demand runs eagerly instead of
    // making the economy mode unusable before the on-demand runtime exists.
    memberActivation = "eager";
    push(issue("MODE_ONDEMAND_FALLBACK_EAGER", "warning", { mode }));
  }
  if (mode === "collaborative" && !onDemandAvailable) {
    // Collaboration always needs on-demand dispatch, even when the pool is empty or degrades to
    // a single path; whether a candidate seat was produced is irrelevant here.
    push(
      issue("MODE_ONDEMAND_UNAVAILABLE", "blocker", {
        mode,
        reason: "collaboration",
      }),
    );
  } else if (explicitCreation === "on-demand" && !onDemandAvailable) {
    push(
      issue("MODE_ONDEMAND_UNAVAILABLE", "blocker", {
        mode,
        reason: "explicit-on-demand",
      }),
    );
  }

  const collaboration = input.team.collaboration;
  let requestedReplicas: 2 | 3 = 2;
  if (mode === "collaborative" && collaboration?.replicas !== undefined) {
    if (collaboration.replicas === 2 || collaboration.replicas === 3) {
      requestedReplicas = collaboration.replicas;
    } else {
      push(
        issue("MODE_UNKNOWN", "blocker", {
          field: "replicas",
          value: issueValue(collaboration.replicas),
        }),
      );
    }
  }

  let explicitJudgeRoleId: string | undefined;
  if (mode === "collaborative" && collaboration?.judgeRoleId !== undefined) {
    if (
      typeof collaboration.judgeRoleId === "string" &&
      collaboration.judgeRoleId.trim().length > 0
    ) {
      explicitJudgeRoleId = collaboration.judgeRoleId.trim();
    } else {
      push(
        issue("MODE_JUDGE_REQUIRED", "blocker", {
          reason: "judge-invalid",
          value: issueValue(collaboration.judgeRoleId),
        }),
      );
    }
  }

  let requiredEscalationRoleId: string | undefined;
  if (mode !== "sota" && collaboration?.escalationRoleId !== undefined) {
    if (
      typeof collaboration.escalationRoleId === "string" &&
      collaboration.escalationRoleId.trim().length > 0
    ) {
      requiredEscalationRoleId = collaboration.escalationRoleId.trim();
    } else {
      push(
        issue("MODE_ESCALATION_INVALID", "blocker", {
          reason: "escalation-invalid",
          value: issueValue(collaboration.escalationRoleId),
        }),
      );
    }
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
        // SOTA Teams from before T3 could repeat a label exactly; keep launching them with a
        // warning. The new modes require distinct labels.
        const severity: "warning" | "blocker" = mode === "sota" ? "warning" : "blocker";
        push(
          issue(
            "MODE_SEAT_DUPLICATE",
            severity,
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

    // SOTA Teams from before T3 launched disabled Roles as written. Keep that behavior with a
    // warning; the new modes treat a disabled Role as a blocker.
    const roleForPlan = mode === "sota" && !role.enabled ? { ...role, enabled: true } : role;
    if (mode === "sota" && !role.enabled) {
      push(
        issue(
          "MODE_ROLE_DISABLED",
          "warning",
          { mode },
          { roleId: role.id, seatId: entry.logicalSeatId },
        ),
      );
    }

    const execution = resolveRoleExecution(roleForPlan, "member");
    if (!execution.ok) {
      if (mode === "sota") {
        for (const entryIssue of execution.issues) {
          push({ ...withEntryContext(entry, entryIssue), severity: "warning" });
        }
      } else {
        for (const entryIssue of execution.issues) push(withEntryContext(entry, entryIssue));
        continue;
      }
    } else {
      for (const entryIssue of execution.issues ?? []) push(withEntryContext(entry, entryIssue));
      entry.tier = execution.value.tier;
    }

    if (mode === "collaborative" && entry.tier === "execution") {
      const cohort = selectCollaborationProfiles({
        role: roleForPlan,
        host: input.host,
        economy: input.economy,
        requestedReplicas,
      });
      if (!cohort.ok) {
        for (const entryIssue of cohort.issues) push(withEntryContext(entry, entryIssue));
        continue;
      }
      for (const entryIssue of cohort.issues ?? []) push(withEntryContext(entry, entryIssue));
      if (cohort.value.effectiveReplicas >= 2) {
        entry.cohort = { selections: cohort.value.selections };
      } else {
        entry.single = cohort.value.selections[0];
      }
      continue;
    }

    const resolved = resolveModeProfile({
      mode,
      // SOTA ignores the tier entirely; an invalid explicit policy was already downgraded above.
      role: mode === "sota" ? { ...roleForPlan, executionPolicy: undefined } : roleForPlan,
      kind: "member",
      host: input.host,
      economy: input.economy,
    });
    if (!resolved.ok) {
      for (const entryIssue of resolved.issues) push(withEntryContext(entry, entryIssue));
      continue;
    }
    for (const entryIssue of resolved.issues ?? []) push(withEntryContext(entry, entryIssue));
    entry.single = resolved.value;
  }

  // Static collaboration roles: choose one independent judge before expanding cohorts, and plan a
  // standby seat per cohort when no shared escalation Role exists.
  let judgeSelection: ProfileSelection | undefined;
  const hasCohorts = entries.some((entry) => entry.cohort !== undefined);
  if (mode === "collaborative" && hasCohorts) {
    let candidates: Entry[] = [];
    if (explicitJudgeRoleId) {
      candidates = entries.filter((entry) => entry.member.roleId === explicitJudgeRoleId);
      if (candidates.length === 0) {
        push(
          issue(
            "MODE_JUDGE_REQUIRED",
            "blocker",
            { reason: "judge-missing" },
            { roleId: explicitJudgeRoleId },
          ),
        );
      }
    } else {
      for (const roleId of DEFAULT_JUDGE_ROLE_IDS) {
        candidates = entries.filter(
          (entry) => entry.member.roleId === roleId && entry.role?.enabled !== false,
        );
        if (candidates.length > 0) break;
      }
    }

    const candidate =
      candidates.find((entry) => entry.role && entry.role.enabled !== false) ?? candidates[0];
    if (candidate) {
      if (!candidate.role || candidate.role.enabled === false) {
        push(
          issue(
            "MODE_JUDGE_REQUIRED",
            "blocker",
            { reason: "judge-disabled" },
            { roleId: candidate.member.roleId, seatId: candidate.logicalSeatId },
          ),
        );
      } else {
        const candidateCohort = candidate.cohort;
        candidate.judge = true;
        // The judge never answers as a candidate.
        candidate.cohort = undefined;
        if (!entries.some((entry) => entry !== candidate && entry.cohort !== undefined)) {
          // The only candidate is also the judge: this group cannot be independent.
          candidate.judge = false;
          candidate.cohort = candidateCohort;
          push(
            issue(
              "MODE_JUDGE_REQUIRED",
              "blocker",
              { reason: "judge-is-candidate" },
              { roleId: candidate.member.roleId, seatId: candidate.logicalSeatId },
            ),
          );
        } else {
          const resolved = resolveModeProfile({
            mode: "sota",
            role: candidate.role,
            kind: "member",
            host: input.host,
            economy: input.economy,
          });
          if (resolved.ok) {
            judgeSelection = resolved.value;
            for (const entryIssue of resolved.issues ?? []) {
              push(withEntryContext(candidate, entryIssue));
            }
          } else {
            for (const entryIssue of resolved.issues) {
              push(withEntryContext(candidate, entryIssue));
            }
          }
        }
      }
    } else if (!explicitJudgeRoleId) {
      push(issue("MODE_JUDGE_REQUIRED", "blocker", { reason: "judge-missing" }));
    }
  }

  const seats: PlannedSeat[] = [];
  const addSeat = (seat: PlannedSeat): void => {
    seats.push(seat);
  };

  for (const entry of entries) {
    if (!entry.role) continue;
    if (entry.judge) {
      if (judgeSelection) {
        addSeat({
          seatId: entry.logicalSeatId,
          logicalSeatId: entry.logicalSeatId,
          roleId: entry.role.id,
          roleName: entry.role.name,
          ...(entry.instanceLabel === undefined ? {} : { instanceLabel: entry.instanceLabel }),
          purpose: "judge",
          activation: memberActivation,
          selected: judgeSelection,
        });
      }
      continue;
    }
    if (entry.cohort) {
      const cohortId = `${entry.logicalSeatId}-cohort`;
      entry.cohort.selections.forEach((selection, candidateIndex) => {
        addSeat({
          seatId: uniqueSeatId(`${entry.logicalSeatId}-c${candidateIndex + 1}`, takenSeatIds),
          logicalSeatId: entry.logicalSeatId,
          roleId: entry.role?.id ?? entry.member.roleId,
          roleName: entry.role?.name ?? entry.member.roleId,
          ...(entry.instanceLabel === undefined ? {} : { instanceLabel: entry.instanceLabel }),
          purpose: "candidate",
          activation: memberActivation,
          cohortId,
          selected: selection,
        });
      });
      continue;
    }
    if (!entry.single) continue;
    const escalationStandby = mode !== "sota" && entry.tier === "escalation";
    addSeat({
      seatId: entry.logicalSeatId,
      logicalSeatId: entry.logicalSeatId,
      roleId: entry.role.id,
      roleName: entry.role.name,
      ...(entry.instanceLabel === undefined ? {} : { instanceLabel: entry.instanceLabel }),
      purpose: escalationStandby ? "escalation" : "member",
      activation: escalationStandby ? "escalation-only" : memberActivation,
      selected: entry.single,
    });
  }

  // No shared escalation Role: reserve the cohort Role's original binding once per cohort.
  if (mode === "collaborative" && !seats.some((seat) => seat.activation === "escalation-only")) {
    const cohorts = new Map<string, PlannedSeat>();
    for (const seat of seats) {
      if (seat.purpose === "candidate" && seat.cohortId && !cohorts.has(seat.cohortId)) {
        cohorts.set(seat.cohortId, seat);
      }
    }
    for (const seat of cohorts.values()) {
      const role = roleById.get(seat.roleId);
      if (!role) continue;
      const original = resolveModeProfile({
        mode: "sota",
        role,
        kind: "member",
        host: input.host,
        economy: input.economy,
      });
      if (!original.ok) {
        const reason = (original.issues[0]?.params.reason as string | undefined) ?? "unresolved";
        push(
          issue(
            "MODE_ESCALATION_UNAVAILABLE",
            "warning",
            { reason },
            { roleId: role.id, seatId: seat.seatId },
          ),
        );
        continue;
      }
      addSeat({
        seatId: uniqueSeatId(`${seat.logicalSeatId}-e1`, takenSeatIds),
        logicalSeatId: seat.logicalSeatId,
        roleId: role.id,
        roleName: role.name,
        ...(seat.instanceLabel === undefined ? {} : { instanceLabel: seat.instanceLabel }),
        purpose: "escalation",
        activation: "escalation-only",
        cohortId: seat.cohortId,
        selected: original.value,
      });
    }
  }

  if (requiredEscalationRoleId && mode !== "sota") {
    const escalationEntry = entries.find(
      (entry) => entry.member.roleId === requiredEscalationRoleId,
    );
    let configValid = true;
    if (!escalationEntry) {
      configValid = false;
      push(
        issue(
          "MODE_ESCALATION_INVALID",
          "blocker",
          { reason: "escalation-missing" },
          { roleId: requiredEscalationRoleId },
        ),
      );
    } else if (!escalationEntry.role || escalationEntry.role.enabled === false) {
      configValid = false;
      push(
        issue(
          "MODE_ESCALATION_INVALID",
          "blocker",
          { reason: "escalation-disabled" },
          { roleId: requiredEscalationRoleId, seatId: escalationEntry.logicalSeatId },
        ),
      );
    } else if (escalationEntry.tier !== "escalation") {
      configValid = false;
      push(
        issue(
          "MODE_ESCALATION_INVALID",
          "blocker",
          { reason: "escalation-not-escalation-tier" },
          { roleId: requiredEscalationRoleId, seatId: escalationEntry.logicalSeatId },
        ),
      );
    } else if (escalationEntry.judge) {
      // A judge cannot also be the standby escalation channel.
      configValid = false;
      push(
        issue(
          "MODE_ESCALATION_INVALID",
          "blocker",
          { reason: "escalation-is-judge" },
          { roleId: requiredEscalationRoleId, seatId: escalationEntry.logicalSeatId },
        ),
      );
    }

    if (configValid) {
      const channel = seats.find(
        (seat) => seat.roleId === requiredEscalationRoleId && seat.activation === "escalation-only",
      );
      if (!channel) {
        push(
          issue(
            "MODE_ESCALATION_UNAVAILABLE",
            "blocker",
            { reason: "missing" },
            { roleId: requiredEscalationRoleId },
          ),
        );
      } else if (channel.selected.unavailable) {
        const reason =
          channel.selected.issues.find((entry) => entry.code === "MODE_ESCALATION_UNAVAILABLE")
            ?.params.reason ?? "unavailable";
        push(
          issue(
            "MODE_ESCALATION_UNAVAILABLE",
            "blocker",
            { reason },
            { roleId: requiredEscalationRoleId, seatId: channel.seatId },
          ),
        );
      }
    }
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
    escalation: seats.filter((seat) => seat.activation === "escalation-only").length,
    sotaPotential: seats.filter((seat) => seat.selected.budget !== "economy").length,
  };
  const budget: SeatBudgetCounts = {
    economy: seats.filter((seat) => seat.selected.budget === "economy").length,
    sota: seats.filter((seat) => seat.selected.budget === "sota").length,
    unknown: seats.filter((seat) => seat.selected.budget === "unknown").length,
    deferredSota: seats.filter(
      (seat) => seat.activation === "escalation-only" && seat.selected.budget !== "economy",
    ).length,
  };

  return { mode, seats, counts, budget, issues, blockers };
}

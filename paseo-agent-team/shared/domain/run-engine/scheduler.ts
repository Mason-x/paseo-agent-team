import type {
  RunPolicySnapshot,
  RunRecord,
  RunSeatSnapshot,
  RunTier,
} from "../../schemas/run-engine/ledger";

export type SchedulerMode = "sota" | "economy" | "economy-all" | "collaborative";

/** One live seat fact. The caller resolves Profile/channel/health; R03b never queries a host. */
export type SeatRuntime = {
  seatId: string;
  profileId: string;
  agentId: string | null;
  enabled: boolean;
  idle: boolean;
  permissionPending: boolean;
  degraded: boolean;
  channelState: "available" | "paused" | "unknown";
  available: boolean;
  /** Current assignments (0 or 1 in batch B). */
  load: number;
  /** Historical quality rework count for the ordering tie-break. */
  qualityRework: number;
  /** Frozen roster declaration order. */
  order: number;
};

export type SchedulerContext = {
  now: string;
  mode: SchedulerMode;
  seats: readonly SeatRuntime[];
  /** economy-all: only cheap, currently eligible Profiles may be selected. */
  profileAllowed?: (profileId: string) => boolean;
  /** Optional task duty; when present a seat must declare it. */
  requiredDuty?: string;
};

export type SeatChoice = {
  seatId: string;
  profileId: string;
  load: number;
  qualityRework: number;
  order: number;
  /** Why this seat qualified (stable, human-readable, no worker text). */
  qualification: string;
};

export type SeatDenial = {
  seatId: string;
  reason:
    | "disabled"
    | "agent-missing"
    | "busy"
    | "permission"
    | "degraded"
    | "channel"
    | "profile-unavailable"
    | "tier"
    | "duty"
    | "mode"
    | "disabled-profile";
};

export type SeatEligibility = {
  candidates: readonly SeatChoice[];
  denials: readonly SeatDenial[];
  /** No dispatch is possible for this task; the reducer decides whether to open D1. */
  blocked: "not-ready" | "no-seat" | null;
};

export type DispatchProposal = {
  taskId: string;
  seatId: string;
  profileId: string;
  qualification: string;
};

const TIER_RANK: Readonly<Record<RunTier, number>> = { B: 0, A: 1, S: 2 };

/** 05 §5: L1–L2 need B, L3 needs A, L4 needs S. */
function requiredTier(level: string): RunTier {
  if (level === "L4") return "S";
  if (level === "L3") return "A";
  return "B";
}

function rosterSeat(
  record: Pick<RunRecord, "roster">,
  seatId: string,
): RunSeatSnapshot | undefined {
  return record.roster.find((seat) => seat.seatId === seatId);
}

/**
 * Ready is the reducer's decision. Scheduling only accepts task.state==="ready" and a null
 * waitingReason; it does not derive readiness from dependencies (R3b-2).
 */
export function eligibleSeats(
  record: Pick<RunRecord, "tasks" | "roster" | "policy">,
  taskId: string,
  ctx: SchedulerContext,
): SeatEligibility {
  const task = record.tasks.find((entry) => entry.spec.id === taskId);
  if (task?.state !== "ready" || task.waitingReason !== null) {
    return { candidates: [], denials: [], blocked: "not-ready" };
  }
  const required = requiredTier(task.spec.level);
  const denials: SeatDenial[] = [];
  const candidates: SeatChoice[] = [];
  for (const seat of ctx.seats) {
    const roster = rosterSeat(record, seat.seatId);
    if (!roster?.enabled || !seat.enabled) {
      denials.push({ seatId: seat.seatId, reason: "disabled" });
      continue;
    }
    if (seat.agentId === null || roster.agentId === null) {
      denials.push({ seatId: seat.seatId, reason: "agent-missing" });
      continue;
    }
    if (!seat.idle || seat.load > 0) {
      denials.push({ seatId: seat.seatId, reason: "busy" });
      continue;
    }
    if (seat.permissionPending) {
      denials.push({ seatId: seat.seatId, reason: "permission" });
      continue;
    }
    if (seat.degraded) {
      denials.push({ seatId: seat.seatId, reason: "degraded" });
      continue;
    }
    if (seat.channelState !== "available") {
      denials.push({ seatId: seat.seatId, reason: "channel" });
      continue;
    }
    if (!seat.available) {
      denials.push({ seatId: seat.seatId, reason: "profile-unavailable" });
      continue;
    }
    if (TIER_RANK[roster.tier] < TIER_RANK[required]) {
      denials.push({ seatId: seat.seatId, reason: "tier" });
      continue;
    }
    if (ctx.requiredDuty !== undefined && !roster.duties.includes(ctx.requiredDuty)) {
      denials.push({ seatId: seat.seatId, reason: "duty" });
      continue;
    }
    if (ctx.mode === "economy-all" && ctx.profileAllowed?.(seat.profileId) !== true) {
      denials.push({ seatId: seat.seatId, reason: "mode" });
      continue;
    }
    if (record.policy.disabledProfileIds.includes(seat.profileId)) {
      denials.push({ seatId: seat.seatId, reason: "disabled-profile" });
      continue;
    }
    candidates.push({
      seatId: seat.seatId,
      profileId: seat.profileId,
      load: seat.load,
      qualityRework: seat.qualityRework,
      order: seat.order,
      qualification: `tier=${roster.tier},load=${seat.load},rework=${seat.qualityRework}`,
    });
  }
  return {
    candidates: rankCandidates(candidates),
    denials,
    blocked: candidates.length === 0 ? "no-seat" : null,
  };
}

/** Total order: load, historical quality rework, frozen seat order, then seatId. */
export function rankCandidates(candidates: readonly SeatChoice[]): readonly SeatChoice[] {
  return [...candidates].sort(
    (left, right) =>
      left.load - right.load ||
      left.qualityRework - right.qualityRework ||
      left.order - right.order ||
      left.seatId.localeCompare(right.seatId),
  );
}

/**
 * Advisory only: one proposal per ready task. Capacity (`slotAvailable`), lock grants, attempt and
 * phase are reducer decisions; R03b never returns an event or a next record.
 */
export function planDispatch(
  record: Pick<RunRecord, "tasks" | "roster" | "policy">,
  ctx: SchedulerContext,
): readonly DispatchProposal[] {
  const proposals: DispatchProposal[] = [];
  for (const task of record.tasks) {
    if (task.state !== "ready" || task.waitingReason !== null) continue;
    const choice = eligibleSeats(record, task.spec.id, ctx).candidates[0];
    if (!choice) continue;
    proposals.push({
      taskId: task.spec.id,
      seatId: choice.seatId,
      profileId: choice.profileId,
      qualification: choice.qualification,
    });
  }
  return proposals;
}

/** Deterministic program-generated names; a collision bumps the numeric suffix. */
export function dispatchLabels(
  runToken: string,
  taskId: string,
  attempt: number,
  sequence: number,
  taken: ReadonlySet<string> = new Set(),
): { branchName: string; worktreeSlug: string; workspaceName: string } {
  const token = runToken.replace(/[^a-z0-9]/gu, "").slice(0, 10) || "run";
  const task = taskId.replace(/[^a-z0-9-]/gu, "-").replace(/^-+|-+$/gu, "") || "task";
  let suffix = Math.max(1, Math.trunc(sequence));
  let name = `re-${token}-${task}-a${Math.max(1, Math.trunc(attempt))}-${suffix}`;
  while (taken.has(name)) {
    suffix += 1;
    name = `re-${token}-${task}-a${Math.max(1, Math.trunc(attempt))}-${suffix}`;
  }
  return { branchName: name, worktreeSlug: name, workspaceName: name };
}

export type QualityFailurePlan =
  | { kind: "rework"; layerFailures: number }
  | { kind: "escalate"; nextTier: "A" | "S"; layerFailures: 0 }
  | { kind: "blocked"; decision: "D3" | "D4"; reason: string };

export type QualityFailureInput = {
  tier: RunTier;
  /** Quality failures including the one being classified. */
  qualityFailures: number;
  /** Escalations already applied (B→A counts 1, A→S counts 2). */
  escalations: number;
  /** Implementation attempts spent, including the failed current attempt. */
  attempts: number;
};

/**
 * Single source for rework/escalation/D3 (AC-RE5.1/5.2). The reducer supplies counters and applies
 * the result; no other module may re-derive the B→A→S rule.
 */
export function nextQualityFailure(
  input: QualityFailureInput,
  policy: Pick<RunPolicySnapshot, "perTask">,
): QualityFailurePlan {
  const perLayer = policy.perTask.reworkPerLayer + 1;
  const layerFailures = Math.max(0, input.qualityFailures - input.escalations * perLayer);
  if (input.attempts >= policy.perTask.implementationAttempts) {
    return { kind: "blocked", decision: "D4", reason: "implementation-attempts" };
  }
  if (layerFailures < perLayer) return { kind: "rework", layerFailures };
  if (input.tier === "S") {
    return { kind: "blocked", decision: "D3", reason: "S-quality-failure" };
  }
  return {
    kind: "escalate",
    nextTier: input.tier === "B" ? "A" : "S",
    layerFailures: 0,
  };
}

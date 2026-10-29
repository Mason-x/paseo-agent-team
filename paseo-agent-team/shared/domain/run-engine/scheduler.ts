import type {
  RunPolicySnapshot,
  RunRecord,
  RunSeatSnapshot,
  RunTaskRecord,
} from "../../schemas/run-engine/ledger";
import { executionTier, layerFailures } from "./tier";

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
    | "disabled-profile"
    | "disabled-channel";
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

function rosterSeat(
  record: Pick<RunRecord, "roster">,
  seatId: string,
): RunSeatSnapshot | undefined {
  return record.roster.find((seat) => seat.seatId === seatId);
}

/**
 * Ready is the reducer's decision. Scheduling only consumes task.state==="ready";
 * waitingReason is display text, never a second readiness gate (R3b-2).
 */
export function eligibleSeats(
  record: Pick<RunRecord, "tasks" | "roster" | "policy">,
  taskId: string,
  ctx: SchedulerContext,
): SeatEligibility {
  const task = record.tasks.find((entry) => entry.spec.id === taskId);
  if (task?.state !== "ready") {
    return { candidates: [], denials: [], blocked: "not-ready" };
  }
  const required = executionTier(task);
  const denials: SeatDenial[] = [];
  const candidates: SeatChoice[] = [];
  for (const seat of ctx.seats) {
    const roster = rosterSeat(record, seat.seatId);
    if (!roster?.enabled || !seat.enabled) {
      denials.push({ seatId: seat.seatId, reason: "disabled" });
      continue;
    }
    // Structural qualification comes first. An unrelated seat's busy state cannot imply that
    // this task has same-tier capability to wait for (159 / I2).
    if (roster.tier !== required) {
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
    if (record.policy.disabledChannels.includes(roster.channelId)) {
      denials.push({ seatId: seat.seatId, reason: "disabled-channel" });
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

/** Code-unit comparison: independent of ICU/locale, unlike localeCompare. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Total order: load, historical quality rework, frozen seat order, then seatId. */
export function rankCandidates(candidates: readonly SeatChoice[]): readonly SeatChoice[] {
  return [...candidates].sort(
    (left, right) =>
      left.load - right.load ||
      left.qualityRework - right.qualityRework ||
      left.order - right.order ||
      compareText(left.seatId, right.seatId),
  );
}

/**
 * Advisory only: one proposal per ready task. Capacity (`slotAvailable`), lock grants, attempt and
 * phase are reducer decisions; R03b never returns an event or a next record.
 */
export type DispatchBlock = {
  taskId: string;
  /** D1 only when no structurally capable same-tier seat exists; temporary shortage waits. */
  decision: "D1" | "wait";
  reasons: readonly SeatDenial[];
};

export type DispatchPlan = {
  proposals: readonly DispatchProposal[];
  blocked: readonly DispatchBlock[];
};

const TEMPORARY_DENIALS: ReadonlySet<SeatDenial["reason"]> = new Set([
  "agent-missing",
  "busy",
  "permission",
  "degraded",
  "channel",
  "profile-unavailable",
]);

/**
 * Advisory plan: one proposal per ready task, simulating one-slot occupancy so the same seat is
 * never proposed twice. A task blocked only by temporary occupancy/permission/channel waits; D1
 * is reserved for "no structurally capable same-tier seat", not ordinary scheduling pressure.
 */
export function planDispatchWithReasons(
  record: Pick<RunRecord, "tasks" | "roster" | "policy">,
  ctx: SchedulerContext,
): DispatchPlan {
  const seats = ctx.seats.map((seat) => ({ ...seat }));
  const proposals: DispatchProposal[] = [];
  const blocked: DispatchBlock[] = [];
  for (const task of record.tasks) {
    if (task.state !== "ready") continue;
    const eligibility = eligibleSeats(record, task.spec.id, { ...ctx, seats });
    const choice = eligibility.candidates[0];
    if (!choice) {
      const temporary = eligibility.denials.some((denial) => TEMPORARY_DENIALS.has(denial.reason));
      blocked.push({
        taskId: task.spec.id,
        decision: temporary ? "wait" : "D1",
        reasons: eligibility.denials,
      });
      continue;
    }
    proposals.push({
      taskId: task.spec.id,
      seatId: choice.seatId,
      profileId: choice.profileId,
      qualification: choice.qualification,
    });
    const selected = seats.find((seat) => seat.seatId === choice.seatId);
    if (selected) selected.load += 1;
  }
  return { proposals, blocked };
}

/** Backward-compatible proposal-only view; use planDispatchWithReasons for D1 evidence. */
export function planDispatch(
  record: Pick<RunRecord, "tasks" | "roster" | "policy">,
  ctx: SchedulerContext,
): readonly DispatchProposal[] {
  return planDispatchWithReasons(record, ctx).proposals;
}

/** FNV-1a 32-bit, used only to disambiguate lossy task-id slugs deterministically. */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

/** Deterministic program-generated names; a collision bumps the numeric suffix. */
export function dispatchLabels(
  runToken: string,
  taskId: string,
  attempt: number,
  sequence: number,
  taken: ReadonlySet<string> = new Set(),
): { branchName: string; worktreeSlug: string; workspaceName: string } {
  const token =
    runToken
      .replace(/^run-/u, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/gu, "")
      .slice(0, 10) || "run";
  const lowerTask = taskId.toLowerCase();
  const slug = lowerTask.replace(/[^a-z0-9-]/gu, "-").replace(/^-+|-+$/gu, "");
  const caseChanged = taskId !== lowerTask;
  const task =
    slug === lowerTask && !caseChanged && slug !== ""
      ? slug
      : `${slug || "task"}-${shortHash(taskId)}`;
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

/** Counters include the failure being classified; escalations are the already applied epochs. */
export type QualityFailureInput = Pick<
  RunTaskRecord,
  "spec" | "qualityFailures" | "escalations" | "attempts"
>;

/**
 * Single source for rework/escalation/D3 (AC-RE5.1/5.2). The reducer supplies counters and applies
 * the result; no other module may re-derive the B→A→S rule.
 */
export function nextQualityFailure(
  input: QualityFailureInput,
  policy: Pick<RunPolicySnapshot, "perTask">,
): QualityFailurePlan {
  const perLayer = policy.perTask.reworkPerLayer + 1;
  const failures = layerFailures(input);
  const tier = executionTier(input);
  // Quality ladder first: S exhaustion is D3 even when the attempt cap is also reached.
  if (tier === "S" && failures >= perLayer) {
    return { kind: "blocked", decision: "D3", reason: "S-quality-failure" };
  }
  const next =
    failures < perLayer
      ? ({ kind: "rework", layerFailures: failures } as const)
      : ({
          kind: "escalate",
          nextTier: tier === "B" ? "A" : "S",
          layerFailures: 0,
        } as const);
  // Rework/escalation needs another implementation attempt; the cap is the only D4 here.
  if (input.attempts >= policy.perTask.implementationAttempts) {
    return { kind: "blocked", decision: "D4", reason: "implementation-attempts" };
  }
  return next;
}

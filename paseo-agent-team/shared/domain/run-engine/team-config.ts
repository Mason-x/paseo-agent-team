import {
  type RunTeamEngineConfig,
  RunTeamEngineConfigSchema,
} from "../../schemas/run-engine/config";
import { runEngineZh } from "../../zh/run-engine";

/**
 * How a stored `Team.runEngine` block reads (H-R1=A). The block rides inside the Team document as
 * an unvalidated extension, so every launch-side question goes through here instead of trusting
 * the stored shape:
 *
 * - `absent`   no block: the Team uses the original coordinator chain.
 * - `disabled` a valid block with `enabled: false`: same, the block is kept for later.
 * - `enabled`  a valid block with `enabled: true`.
 * - `invalid`  a block that does not parse. It is never read as "defaults" and never as "off":
 *              launch refuses it unless the stored block says `enabled: false` itself.
 */
export type TeamRunEngine =
  | { status: "absent" }
  | { status: "disabled"; config: RunTeamEngineConfig }
  | { status: "enabled"; config: RunTeamEngineConfig }
  | {
      status: "invalid";
      /** `path: message` lines only; stored values are never echoed back. */
      issues: string[];
      /** The stored block explicitly says it is off, so a damaged remainder cannot start anything. */
      explicitlyDisabled: boolean;
    };

const MAX_REPORTED_ISSUES = 5;

export function resolveTeamRunEngine(team: { runEngine?: unknown }): TeamRunEngine {
  const raw = team.runEngine;
  if (raw === undefined || raw === null) return { status: "absent" };

  const parsed = RunTeamEngineConfigSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data.enabled
      ? { status: "enabled", config: parsed.data }
      : { status: "disabled", config: parsed.data };
  }

  const explicitlyDisabled =
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    (raw as { enabled?: unknown }).enabled === false;
  return {
    status: "invalid",
    explicitlyDisabled,
    issues: parsed.error.issues
      .slice(0, MAX_REPORTED_ISSUES)
      .map((issue) => `${issue.path.join(".") || "runEngine"}: ${issue.message}`),
  };
}

export type EngineLaunchGate = {
  blockers: string[];
  warnings: string[];
  /** True when the launch must go through the Engine instead of the coordinator chain. */
  engine: boolean;
};

/**
 * Launch gate for one Team. `logicalSeatIds` are the seat ids planning resolved for the Team's
 * enabled members (explicit `seatId`, or the derived positional one), so the Engine roster is
 * checked against the very seats that would be created. `engineSupported` is the runtime flag:
 * while it is false an enabled Team is refused rather than quietly run on the old chain.
 */
export function engineLaunchGate(input: {
  resolution: TeamRunEngine;
  logicalSeatIds: readonly string[];
  engineSupported: boolean;
  /** The Profile each planned seat resolved to, for the warnings that depend on it. */
  seatProfiles?: readonly SeatProfileFacts[];
}): EngineLaunchGate {
  const { resolution } = input;
  const zh = runEngineZh.launch;

  if (resolution.status === "absent" || resolution.status === "disabled") {
    return { blockers: [], warnings: [], engine: false };
  }
  if (resolution.status === "invalid") {
    return resolution.explicitlyDisabled
      ? { blockers: [], warnings: [zh.invalidButDisabled(resolution.issues)], engine: false }
      : { blockers: [zh.invalid(resolution.issues)], warnings: [], engine: false };
  }

  const blockers: string[] = [];
  const planned = new Set(input.logicalSeatIds);
  const configured = new Map<string, boolean>();
  for (const seat of resolution.config.seats) {
    if (configured.has(seat.seatId)) {
      blockers.push(zh.seatDuplicate(seat.seatId));
      continue;
    }
    configured.set(seat.seatId, seat.enabled);
    if (!planned.has(seat.seatId)) blockers.push(zh.seatUnknown(seat.seatId));
  }
  for (const seatId of input.logicalSeatIds) {
    if (!configured.has(seatId)) blockers.push(zh.seatMissing(seatId));
  }
  if (!resolution.config.seats.some((seat) => seat.enabled)) blockers.push(zh.noEnabledSeat);
  // The plan request is the coordinator's first turn: with none, the Run could never ask for a plan.
  if (resolution.config.policy.run.strategicTurns < 1) blockers.push(zh.coordinatorBudgetEmpty);
  if (!input.engineSupported) blockers.push(zh.unsupported);

  const warnings = [
    ...reviewerCoverageWarnings(resolution.config.seats),
    ...codexAccessWarnings(resolution.config.seats, input.seatProfiles ?? []),
  ];
  return { blockers, warnings, engine: true };
}

/** The Profile facts a seat warning needs; `modeId` is the Profile's launch mode, if it has one. */
export type SeatProfileFacts = { seatId: string; provider: string; modeId?: string };

type SeatFacts = RunTeamEngineConfig["seats"][number];

/** Duty names the Engine's own prompts use; a roster that names none of them is not judged. */
const DUTY = { produce: "implement", review: "review", smoke: "smoke" } as const;

/**
 * The reviewer a task of each level needs (L1 -> B, L2 and L3 -> A, L4 -> S), seen from the seat
 * that produces it: a B seat produces L1 and L2 work, an A seat L3, an S seat L4. A seat never
 * reviews its own work, so a producer needs another enabled seat with the review duty at each tier.
 * Warnings only: whether a Run needs a level is not known before the coordinator plans.
 */
const REVIEW_TIERS: Record<string, { tier: string; level: string }[]> = {
  B: [
    { tier: "B", level: "L1" },
    { tier: "A", level: "L2" },
  ],
  A: [{ tier: "A", level: "L3" }],
  S: [{ tier: "S", level: "L4" }],
};

function reviewerCoverageWarnings(seats: readonly SeatFacts[]): string[] {
  const zh = runEngineZh.launch;
  const enabled = seats.filter((seat) => seat.enabled);
  const producers = enabled.filter((seat) => seat.duties.includes(DUTY.produce));
  const reviewers = enabled.filter((seat) => seat.duties.includes(DUTY.review));
  if (producers.length === 0 || reviewers.length === 0) return [];
  const warnings: string[] = [];
  for (const producer of producers) {
    for (const need of REVIEW_TIERS[producer.tier] ?? []) {
      const covered = reviewers.some(
        (reviewer) => reviewer.seatId !== producer.seatId && reviewer.tier === need.tier,
      );
      if (!covered) {
        warnings.push(zh.reviewerTierMissing(producer.seatId, need.level, need.tier));
      }
    }
  }
  return warnings;
}

function codexAccessWarnings(
  seats: readonly SeatFacts[],
  profiles: readonly SeatProfileFacts[],
): string[] {
  const zh = runEngineZh.launch;
  const warnings: string[] = [];
  for (const seat of seats) {
    if (!seat.enabled) continue;
    const duty = [DUTY.produce, DUTY.smoke].find((name) => seat.duties.includes(name));
    if (duty === undefined) continue;
    const profile = profiles.find((entry) => entry.seatId === seat.seatId);
    if (profile?.provider === "codex" && profile.modeId !== "full-access") {
      warnings.push(zh.codexNeedsFullAccess(seat.seatId, duty));
    }
  }
  return warnings;
}

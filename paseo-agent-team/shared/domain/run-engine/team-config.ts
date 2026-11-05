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
  if (!input.engineSupported) blockers.push(zh.unsupported);

  return { blockers, warnings: [], engine: true };
}

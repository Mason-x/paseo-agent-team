import { RunTeamEngineConfigSchema } from "../../schemas/run-engine/config";
import { runEngineZh } from "../../zh/run-engine";
import { displayText } from "./display-text";
import {
  engineLaunchGate,
  resolveTeamRunEngine,
  type SeatProfileFacts,
  type TeamRunEngine,
} from "./team-config";

/**
 * Editing `Team.runEngine` from the Team editor, apart from React so it can be tested.
 *
 * The block is stored as an unvalidated extension of the Team (`team-config.ts` is its only reader).
 * Every function here takes the stored value as it is (`unknown`) and returns a new value; it changes
 * the fields it knows by name and carries everything else through untouched, at the block, seat and
 * policy level, so a field a newer version wrote is not lost by saving here. A block that does not
 * parse is never rewritten into "defaults": it is only replaced when the person says so
 * (`startFresh`).
 *
 * What is checked is exactly what launch checks: `RunTeamEngineConfigSchema` for the shape, and
 * `engineLaunchGate` for the roster against the Team's seats, the reviewer coverage and the Codex
 * access warnings. Nothing is decided here that launch would decide otherwise.
 */

export const ENGINE_TIERS = ["S", "A", "B"] as const;
export type EngineTier = (typeof ENGINE_TIERS)[number];
/** The duty names the Engine's own prompts use (`team-config.ts` `DUTY`). */
export const ENGINE_DUTIES = ["implement", "review", "smoke"] as const;

/** The channel the Engine counts a seat under; it is the provider of the seat's Profile. */
export const ENGINE_AUTO_EVIDENCE_ROOT = "auto";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The ids planning gives the enabled members: the explicit `seatId`, or `seat-<index+1>` made unique. */
export function logicalSeatIdsOf(
  members: readonly { seatId?: string | undefined; enabled: boolean }[],
): string[] {
  const taken = new Set<string>();
  for (const member of members) {
    const explicit = member.seatId?.trim();
    if (member.enabled && explicit) taken.add(explicit);
  }
  const ids: string[] = [];
  for (const [index, member] of members.entries()) {
    if (!member.enabled) continue;
    const explicit = member.seatId?.trim();
    if (explicit) {
      ids.push(explicit);
      continue;
    }
    let candidate = `seat-${index + 1}`;
    let suffix = 2;
    while (taken.has(candidate)) {
      candidate = `seat-${index + 1}-${suffix}`;
      suffix += 1;
    }
    taken.add(candidate);
    ids.push(candidate);
  }
  return ids;
}

/** Defaults a person starts from; every number is shown and can be changed before saving. */
export const DEFAULT_ENGINE_LIMITS = {
  configuredConcurrency: 2,
  perTask: { protocolResends: 2, evidenceReturns: 3, reworkPerLayer: 2, implementationAttempts: 6 },
  run: { failedTasks: 3, strategicTurns: 12 },
  seatTurnBudget: 12,
} as const;

function newSeat(seatId: string): Json {
  return { seatId, tier: "B", duties: ["implement"], channelId: "", enabled: true };
}

function newBudget(seatId: string): Json {
  return {
    scope: "seat",
    subjectId: seatId,
    limit: DEFAULT_ENGINE_LIMITS.seatTurnBudget,
    reserved: 0,
    confirmed: 0,
    observedTurns: 0,
  };
}

/** A block for a Team that has none: disabled until a person turns it on, one seat per Team seat. */
export function defaultEngineBlock(seatIds: readonly string[]): Json {
  return {
    version: 1,
    enabled: false,
    seats: seatIds.map(newSeat),
    policy: {
      policyVersion: 1,
      configuredConcurrency: DEFAULT_ENGINE_LIMITS.configuredConcurrency,
      perTask: { ...DEFAULT_ENGINE_LIMITS.perTask },
      run: { ...DEFAULT_ENGINE_LIMITS.run },
      seatBudgets: seatIds.map(newBudget),
      groupBudgets: [],
      controlAttempts: { probe: 2, reopen: 2 },
      disabledProfileIds: [],
      disabledChannels: [],
      capabilityRulesVersion: "2026-10-27",
      devTargets: [],
      evidenceRoot: ENGINE_AUTO_EVIDENCE_ROOT,
      requestLimits: { burst: 8, perMinute: 12 },
      archiveResume: { seatRevival: "explicit-resume-seat", keepsArchivedAssignments: true },
      capacity: { softBytes: 7 * 1024 * 1024 },
    },
  };
}

// --- reading ------------------------------------------------------------------------------------

export type EngineSeatView = {
  seatId: string;
  tier: string;
  duties: string[];
  channelId: string;
  enabled: boolean;
};

export type EngineEditState = {
  /**
   * What launch would make of the stored block, except that an `invalid` block this editor can
   * still work with (it has the shape of a block: a version, seats and a policy, only some value is
   * not complete yet, e.g. a seat with no channel) is `incomplete`; `invalid` is left for a block
   * that is not a block this editor can read.
   */
  status: TeamRunEngine["status"] | "incomplete";
  enabled: boolean;
  seats: EngineSeatView[];
  numbers: {
    configuredConcurrency: number | null;
    protocolResends: number | null;
    evidenceReturns: number | null;
    reworkPerLayer: number | null;
    implementationAttempts: number | null;
    failedTasks: number | null;
    strategicTurns: number | null;
  };
  /** Shape problems of the stored block, in words, for the person to see. */
  issues: string[];
  /** Seat ids the Team has no member for (launch refuses them). */
  orphanSeats: string[];
  /** Team seats the block has no seat for (launch refuses them). */
  missingSeats: string[];
};

/** The block has the shape this editor writes: a version 1 object with seats and a policy. */
export function isEditableBlock(block: unknown): boolean {
  return (
    isObject(block) &&
    block.version === 1 &&
    Array.isArray(block.seats) &&
    block.seats.every(isObject) &&
    isObject(block.policy)
  );
}

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export function readEngineEdit(block: unknown, seatIds: readonly string[]): EngineEditState {
  const resolution = resolveTeamRunEngine({ runEngine: block });
  const root = isObject(block) ? block : {};
  const policy = isObject(root.policy) ? root.policy : {};
  const perTask = isObject(policy.perTask) ? policy.perTask : {};
  const run = isObject(policy.run) ? policy.run : {};
  const seats: EngineSeatView[] = Array.isArray(root.seats)
    ? root.seats.filter(isObject).map((seat) => ({
        seatId: displayText(seat.seatId, 128, ""),
        tier: displayText(seat.tier, 8, ""),
        duties: Array.isArray(seat.duties)
          ? seat.duties.filter((duty): duty is string => typeof duty === "string")
          : [],
        channelId: typeof seat.channelId === "string" ? seat.channelId : "",
        enabled: seat.enabled === true,
      }))
    : [];
  const known = new Set(seats.map((seat) => seat.seatId));
  const planned = new Set(seatIds);
  return {
    status:
      resolution.status === "invalid" && isEditableBlock(block) ? "incomplete" : resolution.status,
    enabled: resolution.status === "enabled" || (isObject(block) && block.enabled === true),
    seats,
    numbers: {
      configuredConcurrency: num(policy.configuredConcurrency),
      protocolResends: num(perTask.protocolResends),
      evidenceReturns: num(perTask.evidenceReturns),
      reworkPerLayer: num(perTask.reworkPerLayer),
      implementationAttempts: num(perTask.implementationAttempts),
      failedTasks: num(run.failedTasks),
      strategicTurns: num(run.strategicTurns),
    },
    issues: resolution.status === "invalid" ? resolution.issues : [],
    orphanSeats: seats.map((seat) => seat.seatId).filter((id) => !planned.has(id)),
    missingSeats: seatIds.filter((id) => !known.has(id)),
  };
}

// --- writing ------------------------------------------------------------------------------------

const copy = (block: unknown): Json => (isObject(block) ? structuredClone(block) : {});

/**
 * Turns the block on or off. With no block, "on" starts from the defaults; "off" keeps the block as
 * it is and only flips the flag. A block that is not the shape this editor writes is not touched.
 */
export function setEngineEnabled(
  block: unknown,
  enabled: boolean,
  seatIds: readonly string[],
): Json {
  const status = resolveTeamRunEngine({ runEngine: block }).status;
  if (status === "absent") return { ...defaultEngineBlock(seatIds), enabled };
  // A block this editor cannot read is left exactly as it is: only `startFreshEngineBlock` replaces it.
  if (status === "invalid" && !isEditableBlock(block)) return copy(block);
  const next = copy(block);
  next.enabled = enabled;
  return next;
}

/** Replaces a block that does not read with the defaults. The only way a damaged block is rewritten. */
export function startFreshEngineBlock(seatIds: readonly string[]): Json {
  return defaultEngineBlock(seatIds);
}

/** Adds a seat (and its budget) for every Team seat the block lacks; nothing else changes. */
export function addMissingSeats(block: unknown, seatIds: readonly string[]): Json {
  const next = copy(block);
  const seats = Array.isArray(next.seats) ? next.seats : [];
  const known = new Set(seats.filter(isObject).map((seat) => seat.seatId));
  const policy = isObject(next.policy) ? next.policy : {};
  const budgets = Array.isArray(policy.seatBudgets) ? policy.seatBudgets : [];
  for (const seatId of seatIds) {
    if (known.has(seatId)) continue;
    seats.push(newSeat(seatId));
    if (
      !budgets.some(
        (entry) => isObject(entry) && entry.scope === "seat" && entry.subjectId === seatId,
      )
    ) {
      budgets.push(newBudget(seatId));
    }
  }
  next.seats = seats;
  if (isObject(next.policy)) next.policy = { ...policy, seatBudgets: budgets };
  return next;
}

/** Drops the seats the Team has no member for (launch refuses them), and only those. */
export function removeOrphanSeats(block: unknown, seatIds: readonly string[]): Json {
  const next = copy(block);
  const planned = new Set(seatIds);
  if (Array.isArray(next.seats)) {
    next.seats = next.seats.filter((seat) => !isObject(seat) || planned.has(String(seat.seatId)));
  }
  return next;
}

export type SeatPatch = Partial<Pick<EngineSeatView, "tier" | "channelId" | "enabled">> & {
  /** Turn one duty on or off. */
  duty?: { name: string; on: boolean };
};

export function setEngineSeat(block: unknown, seatId: string, patch: SeatPatch): Json {
  const next = copy(block);
  if (!Array.isArray(next.seats)) return next;
  next.seats = next.seats.map((seat) => {
    if (!isObject(seat) || seat.seatId !== seatId) return seat;
    const changed: Json = { ...seat };
    if (patch.tier !== undefined) changed.tier = patch.tier;
    if (patch.channelId !== undefined) changed.channelId = patch.channelId;
    if (patch.enabled !== undefined) changed.enabled = patch.enabled;
    if (patch.duty !== undefined) {
      const duties = Array.isArray(seat.duties)
        ? seat.duties.filter((entry): entry is string => typeof entry === "string")
        : [];
      const rest = duties.filter((entry) => entry !== patch.duty?.name);
      changed.duties = patch.duty.on ? [...rest, patch.duty.name] : rest;
    }
    return changed;
  });
  return next;
}

export const ENGINE_NUMBER_FIELDS = [
  "configuredConcurrency",
  "protocolResends",
  "evidenceReturns",
  "reworkPerLayer",
  "implementationAttempts",
  "failedTasks",
  "strategicTurns",
] as const;
export type EngineNumberField = (typeof ENGINE_NUMBER_FIELDS)[number];

const NUMBER_PATH: Record<EngineNumberField, readonly [string] | readonly [string, string]> = {
  configuredConcurrency: ["configuredConcurrency"],
  protocolResends: ["perTask", "protocolResends"],
  evidenceReturns: ["perTask", "evidenceReturns"],
  reworkPerLayer: ["perTask", "reworkPerLayer"],
  implementationAttempts: ["perTask", "implementationAttempts"],
  failedTasks: ["run", "failedTasks"],
  strategicTurns: ["run", "strategicTurns"],
};

/** Sets one policy number. The text is stored only when it is a whole number; the schema bounds judge it. */
export function setEngineNumber(block: unknown, field: EngineNumberField, text: string): Json {
  const next = copy(block);
  const value = /^\s*-?\d+\s*$/u.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(value)) return next;
  const policy = isObject(next.policy) ? { ...next.policy } : {};
  const path = NUMBER_PATH[field];
  if (path.length === 1) {
    policy[path[0]] = value;
  } else {
    const inner = isObject(policy[path[0]]) ? { ...(policy[path[0]] as Json) } : {};
    inner[path[1]] = value;
    policy[path[0]] = inner;
  }
  next.policy = policy;
  return next;
}

// --- judging ------------------------------------------------------------------------------------

export type EngineEvaluation = {
  /** Shape problems, one line each (path and message; stored values are never echoed). */
  issues: string[];
  /** What launch would refuse for. */
  blockers: string[];
  /** What launch would warn about. */
  warnings: string[];
  /** True when launch would take the Engine path and nothing blocks it. */
  ready: boolean;
};

const MAX_LINES = 8;

export function evaluateEngineBlock(
  block: unknown,
  input: { seatIds: readonly string[]; seatProfiles?: readonly SeatProfileFacts[] },
): EngineEvaluation {
  const resolution = resolveTeamRunEngine({ runEngine: block });
  if (resolution.status === "absent" || resolution.status === "disabled") {
    // A disabled block is still checked for shape, so a person sees a problem before turning it on.
    const parsed = isObject(block) ? RunTeamEngineConfigSchema.safeParse(block) : null;
    return {
      issues: parsed && !parsed.success ? shapeIssues(parsed.error.issues) : [],
      blockers: [],
      warnings: [],
      ready: false,
    };
  }
  const gate = engineLaunchGate({
    resolution,
    logicalSeatIds: input.seatIds,
    engineSupported: true,
    seatProfiles: input.seatProfiles,
  });
  return {
    issues: resolution.status === "invalid" ? resolution.issues.slice(0, MAX_LINES) : [],
    blockers: gate.blockers,
    warnings: gate.warnings,
    ready: resolution.status === "enabled" && gate.blockers.length === 0,
  };
}

function shapeIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string[] {
  return issues
    .slice(0, MAX_LINES)
    .map((issue) => `${issue.path.map(String).join(".") || "runEngine"}: ${issue.message}`);
}

/** The words for a field's label; kept with the model so the screen and the tests agree. */
export function engineNumberLabel(field: EngineNumberField): string {
  return runEngineZh.teamEditor.numbers[field];
}

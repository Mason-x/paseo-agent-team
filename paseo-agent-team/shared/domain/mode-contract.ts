import type { TeamMode } from "../schemas/team-mode";
import type { ModeIssue } from "./role-execution";

// The team-mode contract: stored, wire, and display values, the projection for contract-v1 peers,
// and the contract-v2 access gate. Stored values never change meaning: `economy` is the original
// mode (shown as 标准) and `economy-all` is the all-seats cheap mode (shown as 经济). Nothing here
// migrates or rewrites settings.
//
// Pure and table-driven. Scripts may import this file through Node's type stripping (as the
// catalog generator imports role-execution.ts), so every import stays type-only and the lists are
// declared here; tests pin them to TeamModeSchema.

/** Every mode this version runs, in picker order: 旗舰 / 标准 / 经济 / 协作. */
export const TEAM_MODES = [
  "sota",
  "economy",
  "economy-all",
  "collaborative",
] as const satisfies readonly TeamMode[];

/** The modes a contract-v1 peer (baseline App, daemon, or script) can parse. */
export const LEGACY_TEAM_MODES = [
  "sota",
  "economy",
  "collaborative",
] as const satisfies readonly TeamMode[];

export type LegacyTeamMode = (typeof LEGACY_TEAM_MODES)[number];

/** Current mode contract. A request without contractVersion is a v1 (legacy) caller. */
export const MODE_CONTRACT_VERSION = 2;
export type ModeContractVersion = 1 | typeof MODE_CONTRACT_VERSION;

/**
 * The single mode -> display identity table. Copy binds to these keys, so every surface (Team
 * editor, designer, Team plan, launch preview) names a mode the same way, and no two modes share a
 * name: stored `economy` is the standard mode; `economy-all` is the one called economy.
 */
export const TEAM_MODE_DISPLAY = {
  sota: "flagship",
  economy: "standard",
  "economy-all": "economy",
  collaborative: "collaborative",
} as const satisfies Record<TeamMode, string>;

export type TeamModeDisplay = (typeof TEAM_MODE_DISPLAY)[TeamMode];

/** Option A: the stored and the wire value are the mode itself; no alias is ever written. */
const STORED_MODE_VALUE = {
  sota: "sota",
  economy: "economy",
  "economy-all": "economy-all",
  collaborative: "collaborative",
} as const satisfies Record<TeamMode, string>;

/** The lowest contract that can carry each mode. */
const MODE_MIN_CONTRACT = {
  sota: 1,
  economy: 1,
  "economy-all": 2,
  collaborative: 1,
} as const satisfies Record<TeamMode, ModeContractVersion>;

export function isTeamMode(value: string): value is TeamMode {
  return Object.hasOwn(STORED_MODE_VALUE, value);
}

export function isLegacyTeamMode(value: string): value is LegacyTeamMode {
  return isTeamMode(value) && MODE_MIN_CONTRACT[value] === 1;
}

export function teamModeDisplay(mode: TeamMode): TeamModeDisplay {
  return TEAM_MODE_DISPLAY[mode];
}

export function modeMinContract(mode: TeamMode): ModeContractVersion {
  return MODE_MIN_CONTRACT[mode];
}

export type StoredModeRead =
  | { status: "known"; mode: TeamMode; display: TeamModeDisplay; defaulted: boolean }
  | { status: "unknown"; raw: string };

/**
 * Team.mode -> mode, read exactly as planning reads it: absent or blank is the SOTA default (never
 * written back); a value this version does not know stays raw so the editor can warn with it and
 * a save that leaves the mode untouched keeps it byte for byte.
 */
export function readStoredMode(raw: string | undefined): StoredModeRead {
  const candidate = raw?.trim();
  if (candidate === undefined || candidate === "") {
    return { status: "known", mode: "sota", display: TEAM_MODE_DISPLAY.sota, defaulted: true };
  }
  if (isTeamMode(candidate)) {
    return {
      status: "known",
      mode: candidate,
      display: TEAM_MODE_DISPLAY[candidate],
      defaulted: false,
    };
  }
  return { status: "unknown", raw: raw ?? "" };
}

/** The value written when a user explicitly chooses a mode. */
export function storedModeValue(mode: TeamMode): string {
  return STORED_MODE_VALUE[mode];
}

/**
 * Save mapping. An untouched mode keeps the exact stored value (absent, legacy economy, or a value
 * this version cannot read); only an explicit choice writes, and each choice has its own value.
 */
export function modeToStore(input: {
  original: string | undefined;
  selected: TeamMode;
  touched: boolean;
}): string | undefined {
  return input.touched ? STORED_MODE_VALUE[input.selected] : input.original;
}

/** Contract-v1 projection: a legacy peer is only ever told about modes it can parse. */
export function projectLegacyMode(mode: TeamMode): LegacyTeamMode | null {
  return isLegacyTeamMode(mode) ? mode : null;
}

/**
 * The one contract-version normalizer, shared by request handling, the access gate, and the
 * capability probe. Only the integer 2 is v2; absent, 1, 3, 0, negative, fractional, or non-numeric
 * values are the legacy contract. A request schema decides separately whether to reject a
 * non-integer outright (design start does: `z.number().int()`).
 */
export function normalizeContractVersion(raw: unknown): ModeContractVersion {
  return raw === MODE_CONTRACT_VERSION ? MODE_CONTRACT_VERSION : 1;
}

/** A request opts into contract v2 only with an explicit 2; absence is the legacy contract. */
export function requestContractVersion(input: { contractVersion?: number }): ModeContractVersion {
  return normalizeContractVersion(input.contractVersion);
}

export type ModeAccessDenial = {
  /** The saved Team mode or the request's own override is the value the caller cannot carry. */
  subject: "team" | "request";
  value: string;
};

export type ModeAccessResult =
  | { ok: true }
  | { ok: false; denial: ModeAccessDenial; issue: ModeIssue };

function contractIssue(value: string): ModeIssue {
  // MODE_UNKNOWN is a code baseline clients already render; a new code would reach a stale page
  // as a bare fallback. The caller adds the refresh hint to its blocker text.
  return {
    code: "MODE_UNKNOWN",
    severity: "blocker",
    params: {
      field: "mode",
      value,
      reason: "contract-required",
      contractVersion: MODE_CONTRACT_VERSION,
    },
  };
}

/**
 * Access gate for launch preview/start, checked after reading the current Team and before applying
 * any override. A contract-v1 caller may not request a mode it cannot carry, and may not launch a
 * Team whose saved mode it cannot represent even with a legacy override: a stale page shows such a
 * Team as SOTA and would send mode:sota. A v2 caller always passes (planning still blocks an
 * unknown saved mode that is not overridden).
 */
export function checkModeAccess(input: {
  storedMode: string | undefined;
  requestedMode?: TeamMode;
  /** Raw caller value; normalized with `normalizeContractVersion`. */
  contractVersion: unknown;
}): ModeAccessResult {
  if (normalizeContractVersion(input.contractVersion) === MODE_CONTRACT_VERSION) {
    return { ok: true };
  }
  const stored = readStoredMode(input.storedMode);
  if (stored.status === "unknown") {
    return {
      ok: false,
      denial: { subject: "team", value: stored.raw },
      issue: contractIssue(stored.raw),
    };
  }
  if (!isLegacyTeamMode(stored.mode)) {
    return {
      ok: false,
      denial: { subject: "team", value: stored.mode },
      issue: contractIssue(stored.mode),
    };
  }
  if (input.requestedMode !== undefined && !isLegacyTeamMode(input.requestedMode)) {
    return {
      ok: false,
      denial: { subject: "request", value: input.requestedMode },
      issue: contractIssue(input.requestedMode),
    };
  }
  return { ok: true };
}

/** What a client learned from the capability probe (agent-team.team.plan with items: []). */
export type ModeContractProbe =
  | { kind: "capabilities"; modeContract?: unknown }
  | { kind: "method-not-found" }
  | { kind: "failed" };

export type ModeContractSupport = "v2" | "legacy" | "unknown";

/**
 * Only an explicit method-not-found means an older daemon. A transport or host failure is
 * "unknown": retry, never treat it as a missing capability.
 */
export function modeContractSupport(probe: ModeContractProbe): ModeContractSupport {
  if (probe.kind === "method-not-found") return "legacy";
  if (probe.kind === "failed") return "unknown";
  return normalizeContractVersion(probe.modeContract) === MODE_CONTRACT_VERSION ? "v2" : "legacy";
}

/**
 * Whether a client may write or launch a mode against this daemon. Legacy modes always work; a
 * new mode needs a confirmed v2 daemon and is never sent as a legacy mode instead.
 */
export function modeUsable(mode: TeamMode, support: ModeContractSupport): boolean {
  return MODE_MIN_CONTRACT[mode] === 1 || support === "v2";
}

/** Accepted script spellings, in help order. */
export const CLI_MODE_SPELLINGS = [
  "sota",
  "standard",
  "economy",
  "economy-all",
  "collaborative",
] as const;

export type CliModeRead =
  | { ok: true; mode: TeamMode; legacySpelling: boolean }
  | { ok: false; value: string };

/**
 * Script/CLI `--mode`. `standard` is the display name of the stored `economy`; the old spelling
 * `economy` keeps that meaning (legacySpelling lets the script say it means 标准); `economy-all` is
 * the new economy mode. Anything else is rejected, never guessed.
 */
export function readCliMode(raw: string): CliModeRead {
  const value = raw.trim();
  if (value === "standard") return { ok: true, mode: "economy", legacySpelling: false };
  if (value === "economy") return { ok: true, mode: "economy", legacySpelling: true };
  if (isTeamMode(value)) return { ok: true, mode: value, legacySpelling: false };
  return { ok: false, value: raw };
}

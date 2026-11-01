import type { TeamMode } from "../schemas/team-mode";
import { RETIRED_MODE_LABEL } from "../schemas/team-mode";
import type { ModeIssue } from "./role-execution";

// What is left of the team-mode contract (.notes/274). There is one planning path, so a mode is no
// longer a choice: the stored `Team.mode` is ignored, a request that names any mode other than the
// default is refused with a refresh hint, and the capability probe tells a client whether the host
// it talks to also ignores the retired settings keys. The wire names (settings ids, RPC names,
// `contractVersion`) are unchanged.
//
// Pure and table-driven. Scripts may import this file through Node's type stripping, so imports
// stay light and the lists are declared here.

/** The only mode this version plans; the preview / team.plan DTOs still carry the field. */
export const SUPPORTED_TEAM_MODES = ["sota"] as const satisfies readonly TeamMode[];

/** Current mode contract. A request without contractVersion is a v1 (legacy) caller. */
export const MODE_CONTRACT_VERSION = 2;
export type ModeContractVersion = 1 | typeof MODE_CONTRACT_VERSION;

export function isTeamMode(value: string): value is TeamMode {
  return Object.hasOwn(RETIRED_MODE_LABEL, value);
}

/**
 * The display name of a retired stored `Team.mode`, for the one-line editor hint; null when there
 * is nothing worth saying (absent, blank, or the default). A value this version cannot read comes
 * back as itself, so the hint can still quote it. The stored value never reaches planning.
 */
export function retiredModeLabel(raw: string | undefined): string | null {
  const candidate = raw?.trim();
  if (candidate === undefined || candidate === "" || candidate === "sota") return null;
  return isTeamMode(candidate) ? RETIRED_MODE_LABEL[candidate] : candidate;
}

/**
 * The one contract-version normalizer, shared by request handling and the capability probe. Only
 * the integer 2 is v2; absent, 1, 3, 0, negative, fractional, or non-numeric values are the legacy
 * contract. A request schema decides separately whether to reject a non-integer outright (design
 * start does: `z.number().int()`).
 */
export function normalizeContractVersion(raw: unknown): ModeContractVersion {
  return raw === MODE_CONTRACT_VERSION ? MODE_CONTRACT_VERSION : 1;
}

/** A request opts into contract v2 only with an explicit 2; absence is the legacy contract. */
export function requestContractVersion(input: { contractVersion?: number }): ModeContractVersion {
  return normalizeContractVersion(input.contractVersion);
}

export type ModeAccessResult = { ok: true } | { ok: false; value: string; issue: ModeIssue };

/**
 * Gate for launch preview/start. A request override that is absent or `sota` runs; any other mode
 * is retired and refused with `MODE_UNKNOWN` (reason "retired"), a code every earlier page already
 * renders. The caller adds the refresh hint to its blocker text. The saved Team's own mode is not
 * checked: it is ignored, never refused.
 */
export function checkModeAccess(input: { requestedMode?: string }): ModeAccessResult {
  const requested = input.requestedMode;
  if (requested === undefined || requested === "sota") return { ok: true };
  return {
    ok: false,
    value: requested,
    issue: {
      code: "MODE_UNKNOWN",
      severity: "blocker",
      params: {
        field: "mode",
        value: requested,
        reason: "retired",
        contractVersion: MODE_CONTRACT_VERSION,
      },
    },
  };
}

/** What a client learned from the capability probe (agent-team.team.plan with items: []). */
export type ModeContractProbe =
  | { kind: "capabilities"; modeContract?: unknown; retiresLegacyFields?: unknown }
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
 * E2: whether a write may drop the retired settings keys. Only a probe that came back from the
 * same host with `retiresLegacyFields: true` says so. An earlier daemon (no such field), a daemon
 * that predates the method, and a failed probe all mean "write the object back the way the earlier
 * version would have", so a host that still reads those keys keeps them.
 */
export function legacyFieldRetirement(probe: ModeContractProbe | undefined): boolean {
  return probe !== undefined && probe.kind === "capabilities" && probe.retiresLegacyFields === true;
}

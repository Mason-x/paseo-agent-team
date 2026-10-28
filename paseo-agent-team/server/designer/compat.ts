import { isLegacyTeamMode, MODE_CONTRACT_VERSION } from "../../shared/domain/mode-contract";
import {
  type DesignIssue,
  type DesignJob,
  DesignJobSchema,
  type DesignResult,
  DesignResultSchema,
} from "../../shared/schemas/design";
import type { TeamMode } from "../../shared/schemas/team-mode";

// Contract projection for design replies. Pure functions, no host dependency.
//
// Two jobs, both applied at the service boundary and nowhere else:
// 1. Strip: the ledger keeps keys a newer writer added (passthrough). Anything that leaves the
//    service is first projected through the strip-mode DTO schemas, so those keys never reach an
//    RPC reply, a hash, or an identity.
// 2. Legacy callers (contract 1, i.e. every caller that does not say 2) only understand the three
//    baseline modes. A job in a newer mode is hidden from lists and answered with the existing
//    DESIGN_MODE_UNAVAILABLE issue, so one new enum value can never break a baseline page's parse.

/** Fields that exist only for a contract-2 reader; a baseline reader neither needs nor expects them. */
const CONTRACT_2_JOB_FIELDS = [
  "existingRolesOnly",
  "outputContractVersion",
  "roleGap",
  "gapRetry",
] as const;

export type DesignContract = 1 | typeof MODE_CONTRACT_VERSION;

/** True when a caller of this contract can represent the mode. */
export function modeVisibleTo(mode: TeamMode, contract: DesignContract): boolean {
  return contract === MODE_CONTRACT_VERSION || isLegacyTeamMode(mode);
}

/** The existing issue a legacy caller receives for a job or mode it cannot represent. */
export function legacyModeIssue(
  mode: TeamMode,
  reason: "contract-required" | "hidden-by-contract" = "contract-required",
  extra: Record<string, string | number | boolean> = {},
): DesignIssue {
  return {
    code: "DESIGN_MODE_UNAVAILABLE",
    severity: "error",
    path: ["mode"],
    params: { mode, reason, contractVersion: MODE_CONTRACT_VERSION, ...extra },
    action: "refresh",
  };
}

/** Strip unknown keys through the DTO schema; a legacy reader also loses the contract-2 fields. */
export function projectJobForContract(
  job: DesignJob,
  contract: DesignContract,
  options: { keepGapRetry?: boolean } = {},
): DesignJob {
  // A stored Job may carry an extension with the transient seed's name. Only a caller that has
  // re-derived a seed from the root record may keep it; every other projection drops it first.
  const source = options.keepGapRetry === true ? job : withoutGapRetry(job);
  const parsed = DesignJobSchema.safeParse(source);
  const stripped: DesignJob = parsed.success ? parsed.data : source;
  if (contract === MODE_CONTRACT_VERSION) return stripped;
  const copy: DesignJob = { ...stripped };
  for (const key of CONTRACT_2_JOB_FIELDS) delete copy[key];
  return copy;
}

/** The transient gap seed is never part of a stored or generally projected Job. */
export function withoutGapRetry(job: DesignJob): DesignJob {
  if (!("gapRetry" in job)) return job;
  const { gapRetry: _stored, ...rest } = job;
  return rest as DesignJob;
}

export function projectResultForContract(result: DesignResult | null): DesignResult | null {
  if (result === null) return null;
  const parsed = DesignResultSchema.safeParse(result);
  return parsed.success ? parsed.data : result;
}

export type StatusProjection = {
  jobs: DesignJob[];
  truncated: boolean;
  discoveryIssues: DesignIssue[];
};

/**
 * A job list for a caller of this contract. Hidden jobs are not a page boundary, so `truncated`
 * is set and one issue says why (the count lets a user tell it apart from the 50-job cap).
 */
export function projectStatusForContract(
  input: StatusProjection,
  contract: DesignContract,
  options: { keepGapRetry?: boolean } = {},
): StatusProjection {
  const visible = input.jobs.filter((job) => modeVisibleTo(job.mode, contract));
  const hidden = input.jobs.length - visible.length;
  const jobs = visible.map((job) => projectJobForContract(job, contract, options));
  if (hidden === 0) return { ...input, jobs };
  const firstHidden = input.jobs.find((job) => !modeVisibleTo(job.mode, contract));
  return {
    jobs,
    truncated: true,
    discoveryIssues: [
      ...input.discoveryIssues,
      legacyModeIssue(firstHidden?.mode ?? "economy-all", "hidden-by-contract", { hidden }),
    ],
  };
}

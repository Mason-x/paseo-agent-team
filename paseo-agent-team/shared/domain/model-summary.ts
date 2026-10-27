import type { TeamMode } from "../schemas/team-mode";
import type { TeamPlanRow } from "../schemas/team-plan";
import {
  identifyModelFamily,
  type ModelFamily,
  modelFamilyName,
  sameModelTuple,
  storedModelFamily,
} from "./model-family";

/**
 * Optional explicit family classification. A caller may pass entries built from a live, tuple-matched
 * economy entry; only a matching provider/model tuple counts, so a renamed or re-pointed Profile
 * falls back to its own id instead of inheriting a stale family.
 */
export type ModelFamilyHint = {
  profileId: string;
  provider: string;
  model?: string;
  /** Stored family string; it is validated with storedModelFamily before use. */
  family: string;
};

export type ModelSummaryReason =
  | "unbound"
  | "role-missing"
  | "profile-missing"
  | "provider-unavailable"
  | "unverified"
  /** economy-all: nothing is configured for the seat's route (policy absent, list or route empty). */
  | "route-unavailable"
  /** economy-all: candidates exist but none is an eligible low-cost Profile. */
  | "no-cheap-profile"
  | "policy";

export type ModelSummaryGroup = {
  key: string;
  label: string;
  count: number;
  standby: number;
};

export type ModelSummaryUnresolved = {
  count: number;
  reasons: readonly { reason: ModelSummaryReason; count: number }[];
};

export type ModelSummary =
  | {
      status: "summary";
      total: number;
      groups: readonly ModelSummaryGroup[];
      unresolved: ModelSummaryUnresolved;
    }
  | { status: "none"; reason: "unknown-mode" | "unavailable"; rawMode?: string };

export type ModelSummaryInput = {
  status: "ready" | "blocked" | "unavailable";
  effectiveMode: TeamMode | null;
  rawMode?: string;
  rows: readonly TeamPlanRow[];
  familyHints?: readonly ModelFamilyHint[];
};

const ISSUE_REASON: Readonly<Record<string, ModelSummaryReason>> = {
  "role-missing": "role-missing",
  "all-missing": "profile-missing",
  "no-candidates": "profile-missing",
  "provider-unavailable": "provider-unavailable",
  "availability-unverified": "unverified",
  "all-excluded": "policy",
};

/** economy-all route failures by their stable `reason` (see routeFailureReason). */
const CHEAP_ROUTE_REASON: Readonly<Record<string, ModelSummaryReason>> = {
  "list-empty": "route-unavailable",
  "route-empty": "route-unavailable",
  "profile-missing": "profile-missing",
  "provider-unavailable": "provider-unavailable",
  "availability-unverified": "unverified",
  "all-disabled": "no-cheap-profile",
  "model-unverified": "no-cheap-profile",
  "no-eligible": "no-cheap-profile",
};

function cheapReasonOf(issues: TeamPlanRow["issues"]): ModelSummaryReason | null {
  const route = issues.find((issue) => issue.code === "MODE_CHEAP_ROUTE_UNAVAILABLE");
  if (route) {
    const reason = typeof route.params.reason === "string" ? route.params.reason : "";
    return CHEAP_ROUTE_REASON[reason] ?? "route-unavailable";
  }
  if (issues.some((issue) => issue.code === "MODE_CHEAP_POLICY_REQUIRED")) {
    return "route-unavailable";
  }
  if (issues.some((issue) => issue.code === "MODE_CHEAP_PROFILE_INVALID")) {
    return "no-cheap-profile";
  }
  return null;
}

/**
 * Why an enabled physical row has no selected Profile. Issue detail wins over the availability
 * snapshot; "user has not bound a Profile" and "the provider is down" must not collapse into one
 * bucket, and a disabled Role is policy, not an unbound seat.
 */
export function unresolvedReasonOf(
  row: Pick<TeamPlanRow, "roleId" | "issues" | "availability">,
): ModelSummaryReason {
  if (row.roleId === null) return "role-missing";
  for (const issue of row.issues) {
    if (issue.code !== "MODE_PROFILE_UNRESOLVED") continue;
    const reason = typeof issue.params.reason === "string" ? issue.params.reason : "";
    return ISSUE_REASON[reason] ?? "unbound";
  }
  const cheap = cheapReasonOf(row.issues);
  if (cheap !== null) return cheap;
  if (row.availability === "unverified") return "unverified";
  if (row.availability === "unavailable") return "provider-unavailable";
  if (row.issues.length > 0) return "policy";
  return "unbound";
}

function hintedFamily(
  profile: { id: string; provider: string; model?: string },
  hints: readonly ModelFamilyHint[] | undefined,
): ModelFamily | undefined {
  for (const hint of hints ?? []) {
    if (hint.profileId !== profile.id) continue;
    const saved = { provider: hint.provider, model: hint.model };
    const live = { provider: profile.provider, model: profile.model };
    if (!sameModelTuple(saved, live)) continue;
    const family = storedModelFamily(hint.family);
    if (family !== undefined) return family;
  }
  return undefined;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function groupOf(
  profile: { id: string; name: string; provider: string; model?: string },
  hints: readonly ModelFamilyHint[] | undefined,
): { key: string; label: string } {
  const match = identifyModelFamily({ model: profile.model });
  if (match.status === "identified") {
    return { key: `family:${match.family}`, label: modelFamilyName(match.family) };
  }
  const hinted = hintedFamily(profile, hints);
  if (hinted !== undefined) {
    return { key: `family:${hinted}`, label: modelFamilyName(hinted) };
  }
  // A Profile name is evidence only as a label; it never identifies a family.
  return { key: `profile:${profile.id}`, label: profile.name.trim() || profile.id };
}

/**
 * Group enabled physical rows by model family. Coordinator and standby escalation rows count;
 * disabled rows never do. An unknown mode (or an unavailable host) yields no summary at all, so a
 * card can never show an authoritative-looking count it cannot justify.
 */
export function summarizeModelRows(input: ModelSummaryInput): ModelSummary {
  if (input.status === "unavailable") return { status: "none", reason: "unavailable" };
  if (input.effectiveMode === null) {
    return {
      status: "none",
      reason: "unknown-mode",
      ...(input.rawMode === undefined ? {} : { rawMode: input.rawMode }),
    };
  }

  const groups = new Map<string, ModelSummaryGroup>();
  const reasons = new Map<ModelSummaryReason, number>();
  let unresolved = 0;

  for (const row of input.rows) {
    if (!row.enabled) continue;
    if (row.profile === null) {
      unresolved += 1;
      const reason = unresolvedReasonOf(row);
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      continue;
    }
    const { key, label } = groupOf(row.profile, input.familyHints);
    const group = groups.get(key) ?? { key, label, count: 0, standby: 0 };
    group.count += 1;
    if (row.activation === "escalation-only") group.standby += 1;
    groups.set(key, group);
  }

  const sortedGroups = [...groups.values()].sort(
    (left, right) =>
      right.count - left.count ||
      compareText(left.label, right.label) ||
      compareText(left.key, right.key),
  );
  const sortedReasons = [...reasons.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || compareText(left.reason, right.reason));
  const total = sortedGroups.reduce((sum, group) => sum + group.count, 0) + unresolved;

  return {
    status: "summary",
    total,
    groups: sortedGroups,
    unresolved: { count: unresolved, reasons: sortedReasons },
  };
}

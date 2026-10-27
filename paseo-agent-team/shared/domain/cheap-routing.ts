import type { PaseoProfile, ProviderAvailability } from "../paseo/adapter";
import type { RoleTier, TaskKind } from "../schemas/team-mode";
import {
  identifyModelFamily,
  type ModelFamily,
  sameModelTuple,
  storedModelFamily,
} from "./model-family";

export type AllSeatsRoute = "coordinator" | "decision" | "execution" | "escalation" | "retain";

/** One statically validated allowlist entry. `live` is resolved dynamically by the caller. */
export type AllSeatsEntry = {
  profileId: string;
  enabled: boolean;
  family: ModelFamily;
  boundModel: { provider: string; model: string };
  nameSnapshot?: string;
};

export type CheapInvalidReason =
  | "high-cost-family"
  | "tuple-changed"
  | "family-mismatch"
  | "family-unknown"
  | "family-ambiguous"
  | "model-missing"
  | "model-auto"
  | "disabled"
  | "budget-conflict"
  | "unverified"
  | "unavailable"
  | "outside-list"
  | "duplicate";

export type RouteOrder = {
  routes: Partial<Record<AllSeatsRoute, readonly string[]>>;
  executionTaskOrder?: Partial<Record<TaskKind, readonly string[]>>;
};

/** The seat's route. The coordinator has its own route even when its Role tier is decision. */
export function routeOf(kind: "coordinator" | "member", tier: RoleTier): AllSeatsRoute {
  if (kind === "coordinator") return "coordinator";
  if (tier === "decision" || tier === "execution" || tier === "escalation") return tier;
  return "retain";
}

/** executionTaskOrder only reorders inside the execution route; every other route keeps its list. */
export function orderedRouteIds(
  order: RouteOrder,
  route: AllSeatsRoute,
  taskKind: TaskKind | undefined,
): readonly string[] {
  const routeIds = [...new Set(order.routes[route] ?? [])];
  if (route !== "execution" || taskKind === undefined) return routeIds;
  const allowed = new Set(routeIds);
  const ordered: string[] = [];
  for (const id of order.executionTaskOrder?.[taskKind] ?? []) {
    if (allowed.has(id) && !ordered.includes(id)) ordered.push(id);
  }
  for (const id of routeIds) if (!ordered.includes(id)) ordered.push(id);
  return ordered;
}

export type CheapCandidateInput = {
  entry: AllSeatsEntry;
  live: PaseoProfile | undefined;
  route: AllSeatsRoute;
  /** Explicit budget label from profileBudget; pool membership is handled by the caller. */
  profileBudget?: "economy" | "sota" | "unknown";
  availability: readonly ProviderAvailability[];
  excludedProfileIds?: ReadonlySet<string>;
};

export type CheapCandidateCheck =
  | { ok: true; family: ModelFamily }
  | { ok: false; reason: CheapInvalidReason };

/**
 * Dynamic eligibility for one route candidate. Static fields were already validated; this checks
 * the live tuple, the live model family (never the Profile name), budget, and availability.
 */
export function evaluateCheapCandidate(input: CheapCandidateInput): CheapCandidateCheck {
  if (!input.entry.enabled) return { ok: false, reason: "disabled" };
  if (input.excludedProfileIds?.has(input.entry.profileId)) {
    return { ok: false, reason: "outside-list" };
  }
  if (!input.live) return { ok: false, reason: "outside-list" };
  if (!sameModelTuple(input.entry.boundModel, input.live)) {
    return { ok: false, reason: "tuple-changed" };
  }
  if (input.profileBudget === "sota" || input.profileBudget === "unknown") {
    return { ok: false, reason: "budget-conflict" };
  }
  const availability = input.availability.find((row) => row.provider === input.live?.provider);
  if (!availability) return { ok: false, reason: "unverified" };
  if (!availability.available) return { ok: false, reason: "unavailable" };
  const match = identifyModelFamily({ model: input.live.model });
  if (match.status === "unresolved") {
    const reason =
      match.reason === "model-missing"
        ? "model-missing"
        : match.reason === "model-auto"
          ? "model-auto"
          : match.reason === "family-ambiguous"
            ? "family-ambiguous"
            : "family-unknown";
    return { ok: false, reason };
  }
  if (match.cost !== "low") return { ok: false, reason: "high-cost-family" };
  if (match.family !== input.entry.family) return { ok: false, reason: "family-mismatch" };
  return { ok: true, family: match.family };
}

/** Stored family string -> supported family (used by the static policy reader). */
export function entryFamily(raw: unknown): ModelFamily | undefined {
  return storedModelFamily(raw);
}

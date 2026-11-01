import type { PaseoProfile, ProviderAvailability } from "../paseo/adapter";
import type { Role } from "../schemas/role";
import type { BudgetBasis } from "../schemas/team-mode";
import { type ProfileResolution, resolveProfile } from "./profile-resolver";
import type { ModeIssue, ModeIssueCode, Result } from "./role-execution";

// The single planning path (.notes/274): every seat takes its Role's preferred Profiles, then the
// fallback ones, and nothing else. The team mode, the economy pool, the all-seats routes, the
// collaboration cohorts and the Role tier are retired; stored values still decode but are never
// read here.

/**
 * Budget label of a seat in the preview / team.plan DTO. The DTO keeps its shape for older pages;
 * this version never labels a budget, so every seat reports `unknown` on the `host` basis.
 */
export type BudgetLabel = "economy" | "sota" | "unknown";
export const FIXED_BUDGET: { budget: BudgetLabel; budgetBasis: BudgetBasis } = {
  budget: "unknown",
  budgetBasis: "host",
};

/** A seat that can be planned and created now. */
export type ProfileSelection = {
  profile: PaseoProfile;
  source: "role-preferred" | "role-fallback";
  issues: ModeIssue[];
};

// The host state is not optional: callers cannot hand over Profiles/availability without saying
// whether the query succeeded. A failed query must block, not look like an empty or healthy pool.
export type HostSnapshot =
  | {
      status: "ready";
      profiles: readonly PaseoProfile[];
      availability: readonly ProviderAvailability[];
      /** True when the provider availability query failed but Profiles were readable. */
      availabilityUnverified?: boolean;
    }
  | { status: "unavailable"; reason?: string };

function blocker(
  code: ModeIssueCode,
  params: Record<string, string | number | boolean>,
  extra: { roleId?: string; profileId?: string } = {},
): ModeIssue {
  return { code, severity: "blocker", params, ...extra };
}

/**
 * Per-seat selection. The Role's preferred Profiles are tried in order, then its fallbacks; a
 * provider that reports itself unavailable is skipped. An unreadable availability query is not an
 * error here (resolveProfile treats a provider without a row as usable) and is reported once by
 * seat planning as a warning. Only a Role whose every binding fails blocks the seat.
 */
export function resolveSeatProfile(input: {
  role: Role;
  host: HostSnapshot;
}): Result<ProfileSelection, ModeIssue[]> {
  if (input.host.status === "unavailable") {
    return {
      ok: false,
      issues: [
        blocker("MODE_CONTEXT_UNAVAILABLE", {
          ...(input.host.reason === undefined ? {} : { reason: input.host.reason }),
        }),
      ],
    };
  }
  if (!input.role.enabled) {
    return {
      ok: false,
      issues: [blocker("MODE_ROLE_DISABLED", {}, { roleId: input.role.id })],
    };
  }
  const resolved: ProfileResolution = resolveProfile(
    input.role,
    input.host.profiles,
    input.host.availability,
  );
  if (!resolved.ok) {
    return {
      ok: false,
      issues: [
        blocker("MODE_PROFILE_UNRESOLVED", { reason: resolved.reason }, { roleId: input.role.id }),
      ],
    };
  }
  return {
    ok: true,
    value: { profile: resolved.profile, source: resolved.source, issues: [] },
    issues: [],
  };
}

export type CoordinatorResolution =
  | {
      ok: true;
      selection: ProfileSelection;
      warnings: string[];
    }
  | { ok: false; legacyReason: string };

/**
 * Coordinator selection: the Role's own binding through resolveProfile, with its readable
 * warnings (missing Profile, unavailable provider, fallback in use). The coordinator is not
 * subject to the seat-level enabled check, exactly as before.
 */
export function resolveCoordinatorProfile(input: {
  role: Role;
  host: HostSnapshot;
}): CoordinatorResolution {
  const profiles = input.host.status === "ready" ? input.host.profiles : [];
  const availability = input.host.status === "ready" ? input.host.availability : [];
  const resolved = resolveProfile(input.role, profiles, availability);
  if (!resolved.ok) return { ok: false, legacyReason: resolved.reason };
  return {
    ok: true,
    selection: { profile: resolved.profile, source: resolved.source, issues: [] },
    warnings: resolved.warnings,
  };
}

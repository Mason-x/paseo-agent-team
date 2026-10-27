import { z } from "zod";
import type { PaseoProfile, ProviderAvailability } from "../paseo/adapter";
import type { Role } from "../schemas/role";
import {
  ALL_SEATS_POLICY_VERSION,
  ALL_SEATS_WRITER_LIMIT,
  type RoleTier,
  StoredAllSeatsEntrySchema,
  StoredAllSeatsPolicySchema,
  type StoredEconomyPolicy,
  StoredEconomyPolicySchema,
  type TaskKind,
  type TeamMode,
  TeamModeSchema,
} from "../schemas/team-mode";
import {
  type AllSeatsEntry,
  type AllSeatsRoute,
  entryFamily,
  evaluateCheapCandidate,
  orderedRouteIds,
  type RouteOrder,
  routeOf,
} from "./cheap-routing";
import { type ProfileResolution, resolveProfile } from "./profile-resolver";
import {
  issueValue,
  isTaskKind,
  type ModeIssue,
  type ModeIssueCode,
  type Result,
  resolveRoleExecution,
} from "./role-execution";

// Model family, normalized and verified against the stored boundModel before it can count as a
// collaboration path. Provider is not a family: two families may share one provider.
const FAMILY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// Writer/form limits. Reading a larger saved pool only reports that it needs tidying; it is never
// truncated to look complete.
const WRITER_POOL_LIMIT = 32;
const WRITER_TASK_ORDER_LIMIT = 32;

export type EconomyBudget = "economy" | "sota" | "unknown";

export type EconomyPoolEntry = {
  profileId: string;
  family?: string;
  enabled: boolean;
};

export type EconomyPolicy = {
  pool: readonly EconomyPoolEntry[];
  taskOrder: Partial<Record<TaskKind, readonly string[]>>;
  profileBudget: Readonly<Record<string, EconomyBudget>>;
  /** Read-only all-seats policy. Absent means economy-all has no configured source. */
  allSeats?: AllSeatsPolicy;
};

export type AllSeatsPolicy =
  | {
      status: "ready";
      version: typeof ALL_SEATS_POLICY_VERSION;
      profiles: readonly AllSeatsEntry[];
      routes: Partial<Record<AllSeatsRoute, readonly string[]>>;
      executionTaskOrder: Partial<Record<TaskKind, readonly string[]>>;
      issues: readonly ModeIssue[];
    }
  | { status: "absent" }
  | {
      status: "invalid";
      reason: "unknown-version" | "shape";
      version?: unknown;
      issues: readonly ModeIssue[];
    };

type ProfileSelectionBase = {
  budget: EconomyBudget;
  budgetBasis: "host" | "pool" | "conservative-default";
  family?: string;
  /** Cheap-route identity for economy-all; omitted for legacy modes. */
  route?: AllSeatsRoute;
  /** Same-family later candidates (profileIds), in pool order, for measured failure replacement. */
  alternates?: readonly string[];
  /** True for an escalation channel planned in economy/collaborative mode; never create it early. */
  standby: boolean;
  issues: ModeIssue[];
};

/** A seat that can be planned/created now. */
export type AvailableProfileSelection = ProfileSelectionBase & {
  unavailable: false;
  profile: PaseoProfile;
  source: "role-preferred" | "role-fallback" | "economy-pool";
};

/** An escalation channel that is only planned; it cannot be created or dispatched yet. */
export type UnavailableProfileSelection = ProfileSelectionBase & {
  unavailable: true;
  standby: true;
  profile: null;
  source: "unavailable";
};

// `unavailable` is the discriminant: T3/T4 can narrow once instead of rechecking profile null at
// every call site.
export type ProfileSelection = AvailableProfileSelection | UnavailableProfileSelection;

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

export type ResolveModeProfileInput = {
  mode: TeamMode;
  role: Role;
  kind: "coordinator" | "member";
  host: HostSnapshot;
  economy: EconomyPolicy;
  excludedProfileIds?: ReadonlySet<string>;
};

export type SelectCollaborationProfilesInput = {
  role: Role;
  host: HostSnapshot;
  economy: EconomyPolicy;
  requestedReplicas: 2 | 3;
  excludedProfileIds?: ReadonlySet<string>;
};

export type CollaborationSelection = {
  selections: ProfileSelection[];
  effectiveReplicas: 1 | 2 | 3;
  issues: ModeIssue[];
};

function warning(
  code: ModeIssueCode,
  params: Record<string, string | number | boolean>,
  extra: { roleId?: string; profileId?: string } = {},
): ModeIssue {
  return { code, severity: "warning", params, ...extra };
}

function blocker(
  code: ModeIssueCode,
  params: Record<string, string | number | boolean>,
  extra: { roleId?: string; profileId?: string } = {},
): ModeIssue {
  return { code, severity: "blocker", params, ...extra };
}

export function normalizeMode(raw: string | undefined): Result<TeamMode, ModeIssue[]> {
  const candidate = raw?.trim();
  if (candidate === undefined || candidate === "") {
    return { ok: true, value: "sota", issues: [] };
  }
  const parsed = TeamModeSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, value: parsed.data, issues: [] };
  return {
    ok: false,
    issues: [blocker("MODE_UNKNOWN", { value: candidate })],
  };
}

function normalizeFamily(raw: string | undefined): string | undefined {
  const family = raw?.trim().toLowerCase();
  if (!family || !FAMILY_PATTERN.test(family)) return undefined;
  return family;
}

const ALL_SEATS_ROUTES = [
  "coordinator",
  "decision",
  "execution",
  "escalation",
  "retain",
] as const satisfies readonly AllSeatsRoute[];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function allSeatsIssue(
  code: ModeIssueCode,
  params: Record<string, string | number | boolean>,
  extra: { roleId?: string; profileId?: string } = {},
): ModeIssue {
  return { code, severity: "warning", params, ...extra };
}

/**
 * Static all-seats policy: entries, family/tuple against the live Profiles, allowlist references,
 * and writer limits. Dynamic facts (live family cost, availability, exclusions) stay in
 * resolveCheapSeat. Configuration problems live in `allSeats.issues`, never in Result.issues, so
 * legacy previews gain no noise.
 */
function normalizeAllSeats(raw: unknown, profiles: readonly PaseoProfile[]): AllSeatsPolicy {
  if (raw === undefined || raw === null) return { status: "absent" };
  const parsed = StoredAllSeatsPolicySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: "invalid",
      reason: "shape",
      issues: [allSeatsIssue("MODE_CHEAP_POLICY_REQUIRED", { reason: "shape" })],
    };
  }
  const version = parsed.data.version;
  if (version !== ALL_SEATS_POLICY_VERSION) {
    return {
      status: "invalid",
      reason: version === undefined ? "shape" : "unknown-version",
      ...(version === undefined ? {} : { version }),
      issues: [
        allSeatsIssue("MODE_CHEAP_POLICY_REQUIRED", {
          reason: version === undefined ? "shape" : "unknown-version",
          ...(typeof version === "string" || typeof version === "number" ? { version } : {}),
        }),
      ],
    };
  }
  if (!Array.isArray(parsed.data.profiles) || !isPlainRecord(parsed.data.routes)) {
    return {
      status: "invalid",
      reason: "shape",
      issues: [allSeatsIssue("MODE_CHEAP_POLICY_REQUIRED", { reason: "shape" })],
    };
  }

  const liveProfiles = new Map(profiles.map((profile) => [profile.id, profile]));
  const issues: ModeIssue[] = [];
  const entries: AllSeatsEntry[] = [];
  const seen = new Set<string>();
  for (const rawEntry of parsed.data.profiles) {
    const entry = StoredAllSeatsEntrySchema.safeParse(rawEntry);
    if (!entry.success) {
      issues.push(allSeatsIssue("MODE_CHEAP_PROFILE_INVALID", { reason: "shape" }));
      continue;
    }
    if (seen.has(entry.data.profileId)) {
      issues.push(
        allSeatsIssue("MODE_CHEAP_PROFILE_INVALID", {
          profileId: entry.data.profileId,
          reason: "duplicate",
        }),
      );
      continue;
    }
    seen.add(entry.data.profileId);
    const family = entryFamily(entry.data.family);
    if (family === undefined) {
      issues.push(
        allSeatsIssue(
          "MODE_CHEAP_PROFILE_INVALID",
          { reason: "family-unknown" },
          { profileId: entry.data.profileId },
        ),
      );
      continue;
    }
    const live = liveProfiles.get(entry.data.profileId);
    if (live) {
      const tuple = {
        provider: entry.data.boundModel.provider,
        model: entry.data.boundModel.model,
      };
      if (tuple.provider !== live.provider || tuple.model !== (live.model ?? "")) {
        issues.push(
          allSeatsIssue(
            "MODE_CHEAP_PROFILE_INVALID",
            { reason: "tuple-changed" },
            { profileId: entry.data.profileId },
          ),
        );
      }
    }
    entries.push({
      profileId: entry.data.profileId,
      enabled: entry.data.enabled,
      family,
      boundModel: { provider: entry.data.boundModel.provider, model: entry.data.boundModel.model },
      ...(entry.data.nameSnapshot === undefined ? {} : { nameSnapshot: entry.data.nameSnapshot }),
    });
  }
  if (entries.length > ALL_SEATS_WRITER_LIMIT) {
    issues.push(
      allSeatsIssue("MODE_CHEAP_POLICY_REQUIRED", {
        reason: "limit",
        count: entries.length,
        limit: ALL_SEATS_WRITER_LIMIT,
      }),
    );
  }

  const entryIds = new Set(entries.map((entry) => entry.profileId));
  const routes: Partial<Record<AllSeatsRoute, readonly string[]>> = {};
  for (const route of ALL_SEATS_ROUTES) {
    const rawIds = parsed.data.routes[route];
    if (rawIds === undefined) continue;
    if (!Array.isArray(rawIds)) {
      issues.push(allSeatsIssue("MODE_CHEAP_ROUTE_UNAVAILABLE", { route, reason: "shape" }));
      continue;
    }
    const kept: string[] = [];
    for (const rawId of rawIds) {
      if (typeof rawId !== "string") {
        issues.push(allSeatsIssue("MODE_CHEAP_ROUTE_UNAVAILABLE", { route, reason: "shape" }));
        continue;
      }
      if (!entryIds.has(rawId)) {
        issues.push(
          allSeatsIssue("MODE_CHEAP_PROFILE_INVALID", {
            route,
            profileId: rawId,
            reason: "outside-list",
          }),
        );
        continue;
      }
      if (kept.includes(rawId)) {
        issues.push(
          allSeatsIssue(
            "MODE_CHEAP_PROFILE_INVALID",
            { route, profileId: rawId, reason: "duplicate" },
            { profileId: rawId },
          ),
        );
        continue;
      }
      kept.push(rawId);
    }
    if (rawIds.length > ALL_SEATS_WRITER_LIMIT) {
      issues.push(
        allSeatsIssue("MODE_CHEAP_POLICY_REQUIRED", {
          route,
          reason: "limit",
          count: rawIds.length,
          limit: ALL_SEATS_WRITER_LIMIT,
        }),
      );
    }
    routes[route] = kept;
  }

  const executionIds = new Set(routes.execution ?? []);
  const executionTaskOrder: Partial<Record<TaskKind, readonly string[]>> = {};
  if (isPlainRecord(parsed.data.executionTaskOrder)) {
    for (const [kind, rawIds] of Object.entries(parsed.data.executionTaskOrder)) {
      if (!isTaskKind(kind) || !Array.isArray(rawIds)) {
        issues.push(
          allSeatsIssue("MODE_CHEAP_ROUTE_UNAVAILABLE", { route: "execution", reason: "order" }),
        );
        continue;
      }
      const kept: string[] = [];
      for (const rawId of rawIds) {
        if (typeof rawId !== "string" || !executionIds.has(rawId)) {
          issues.push(
            allSeatsIssue("MODE_CHEAP_ROUTE_UNAVAILABLE", {
              route: "execution",
              reason: "order",
            }),
          );
          continue;
        }
        if (!kept.includes(rawId)) kept.push(rawId);
      }
      if (rawIds.length > ALL_SEATS_WRITER_LIMIT) {
        issues.push(
          allSeatsIssue("MODE_CHEAP_POLICY_REQUIRED", {
            route: "execution",
            reason: "limit",
            count: rawIds.length,
            limit: ALL_SEATS_WRITER_LIMIT,
          }),
        );
      }
      executionTaskOrder[kind] = kept;
    }
  }

  return {
    status: "ready",
    version: ALL_SEATS_POLICY_VERSION,
    profiles: entries,
    routes,
    executionTaskOrder,
    issues,
  };
}

// One raw economy entry / boundModel. Parsing them individually keeps a bad row local: the pool
// still yields every other entry, and the issue names the exact index.
const StoredPoolEntryShapeSchema = z
  .object({
    profileId: z.string().min(1),
    family: z.unknown().optional(),
    enabled: z.unknown().optional(),
    boundModel: z.unknown().optional(),
  })
  .passthrough();

const StoredBoundModelShapeSchema = z
  .object({ provider: z.unknown(), model: z.unknown().optional() })
  .passthrough();

/**
 * Stored pool -> normalized policy. Duplicates keep the first entry, taskOrder entries outside the
 * pool are dropped (the pool stays the only source of usable Profiles), and a family counts only
 * when it is well-formed and its saved boundModel still matches the live provider/model tuple.
 */
export function normalizeEconomyPolicy(
  raw: unknown,
  profiles: readonly PaseoProfile[],
): Result<EconomyPolicy, ModeIssue[]> {
  const parsed = StoredEconomyPolicySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    // Unreachable on the normal settings path: a container with the wrong basic type makes the
    // stored document invalid before it reaches here, per "storage still validates basic types".
    // This branch is a defensive fallback for direct callers and future writers.
    const field = parsed.error.issues[0]?.path.join(".") || "economy";
    // Configuration problems never block on their own: the seat falls back to its original
    // binding, and only a failing original binding is a blocker.
    return {
      ok: true,
      value: { pool: [], taskOrder: {}, profileBudget: {} },
      issues: [warning("MODE_POOL_CONFIG_INVALID", { field, reason: "shape" })],
    };
  }

  const stored: StoredEconomyPolicy = parsed.data;
  const liveProfiles = new Map(profiles.map((profile) => [profile.id, profile]));
  const issues: ModeIssue[] = [];
  const seen = new Set<string>();
  const pool: EconomyPoolEntry[] = [];

  for (const [index, rawEntry] of (stored.pool ?? []).entries()) {
    const parsedEntry = StoredPoolEntryShapeSchema.safeParse(rawEntry);
    if (!parsedEntry.success) {
      issues.push(warning("MODE_POOL_CONFIG_INVALID", { field: "pool", index, reason: "entry" }));
      continue;
    }
    const entry = parsedEntry.data;
    const profileId = entry.profileId;
    if (seen.has(profileId)) {
      issues.push(warning("MODE_POOL_DUPLICATE", { profileId }));
      continue;
    }
    seen.add(profileId);

    const live = liveProfiles.get(profileId);
    if (!live) {
      issues.push(warning("MODE_POOL_ENTRY_MISSING", { profileId }));
    }

    const normalizedFamily =
      typeof entry.family === "string" ? normalizeFamily(entry.family) : undefined;
    let family: string | undefined;
    if (!normalizedFamily) {
      issues.push(
        warning("MODE_FAMILY_MISSING", {
          profileId,
          reason: typeof entry.family === "string" ? "family-invalid" : "family-missing",
        }),
      );
    } else if (!live) {
      // A missing Profile cannot be verified; the missing entry itself is already reported.
      family = undefined;
    } else {
      const bound = StoredBoundModelShapeSchema.safeParse(entry.boundModel);
      const provider =
        bound.success && typeof bound.data.provider === "string" && bound.data.provider !== ""
          ? bound.data.provider
          : undefined;
      if (provider === undefined) {
        issues.push(warning("MODE_FAMILY_MISSING", { profileId, reason: "bound-model-missing" }));
      } else {
        // "": undefined, matching the binding rule that a blank string means "not specified".
        const savedModel =
          bound.success && typeof bound.data.model === "string" && bound.data.model !== ""
            ? bound.data.model
            : undefined;
        const liveModel = live.model === "" ? undefined : live.model;
        if (provider !== live.provider || savedModel !== liveModel) {
          // A renamed or re-pointed Profile no longer proves the saved family.
          issues.push(warning("MODE_FAMILY_MISSING", { profileId, reason: "bound-model-changed" }));
        } else {
          family = normalizedFamily;
        }
      }
    }

    let enabled = true;
    if (entry.enabled !== undefined) {
      if (typeof entry.enabled === "boolean") enabled = entry.enabled;
      else
        issues.push(
          warning("MODE_POOL_CONFIG_INVALID", { field: "pool", index, reason: "enabled" }),
        );
    }

    pool.push({
      profileId,
      ...(family === undefined ? {} : { family }),
      enabled,
    });
  }

  if (pool.length > WRITER_POOL_LIMIT) {
    issues.push(
      warning("MODE_POOL_CONFIG_INVALID", {
        field: "pool",
        count: pool.length,
        limit: WRITER_POOL_LIMIT,
      }),
    );
  }

  const poolIds = new Set(pool.map((entry) => entry.profileId));
  const taskOrder: Partial<Record<TaskKind, readonly string[]>> = {};
  for (const [kind, rawIds] of Object.entries(stored.taskOrder ?? {})) {
    if (!isTaskKind(kind)) {
      issues.push(warning("MODE_POOL_ORDER_IGNORED", { kind }));
      continue;
    }
    if (!Array.isArray(rawIds)) {
      issues.push(
        warning("MODE_POOL_CONFIG_INVALID", { field: "taskOrder", kind, reason: "shape" }),
      );
      continue;
    }
    const kept: string[] = [];
    for (const [index, rawId] of rawIds.entries()) {
      if (typeof rawId !== "string") {
        issues.push(
          warning("MODE_POOL_CONFIG_INVALID", {
            field: "taskOrder",
            kind,
            index,
            reason: "entry",
          }),
        );
        continue;
      }
      // taskOrder is an ordering hint, never a second pool.
      if (!poolIds.has(rawId)) {
        issues.push(warning("MODE_POOL_ORDER_IGNORED", { kind, profileId: rawId }));
        continue;
      }
      if (!kept.includes(rawId)) kept.push(rawId);
    }
    if (rawIds.length > WRITER_TASK_ORDER_LIMIT) {
      issues.push(
        warning("MODE_POOL_CONFIG_INVALID", {
          field: "taskOrder",
          kind,
          count: rawIds.length,
          limit: WRITER_TASK_ORDER_LIMIT,
        }),
      );
    }
    taskOrder[kind] = kept;
  }

  const profileBudget: Record<string, EconomyBudget> = {};
  for (const entry of pool) profileBudget[entry.profileId] = "economy";
  for (const [profileId, budget] of Object.entries(stored.profileBudget ?? {})) {
    if (profileId in profileBudget) {
      // A pool Profile always consumes the pool; any label for it is ignored.
      issues.push(
        warning("MODE_POOL_CONFIG_INVALID", {
          field: "profileBudget",
          profileId,
          value: issueValue(budget),
        }),
      );
      continue;
    }
    if (budget !== "economy" && budget !== "sota" && budget !== "unknown") {
      issues.push(
        warning("MODE_POOL_CONFIG_INVALID", {
          field: "profileBudget",
          profileId,
          value: issueValue(budget),
        }),
      );
      continue;
    }
    profileBudget[profileId] = budget;
  }

  return {
    ok: true,
    value: {
      pool,
      taskOrder,
      profileBudget,
      allSeats: normalizeAllSeats(stored.allSeats, profiles),
    },
    issues,
  };
}

function availabilityOf(
  profile: PaseoProfile,
  availability: readonly ProviderAvailability[],
): "available" | "unavailable" | "unverified" {
  const row = availability.find((entry) => entry.provider === profile.provider);
  if (!row) return "unverified";
  return row.available ? "available" : "unavailable";
}

export function budgetOf(
  profileId: string,
  economy: EconomyPolicy,
): { budget: EconomyBudget; basis: "host" | "pool" | "conservative-default" } {
  // A Profile that sits in the economy pool consumes pool budget even when reached through the
  // Role's original binding (fallback must not relabel it as host/SOTA).
  if (economy.pool.some((entry) => entry.profileId === profileId)) {
    return { budget: "economy", basis: "pool" };
  }
  const labeled = economy.profileBudget[profileId];
  if (labeled === undefined) return { budget: "unknown", basis: "conservative-default" };
  return { budget: labeled, basis: "host" };
}

/** taskOrder for the task kind, then the pool order, with no repeats and no out-of-pool ids. */
function orderedPoolEntries(
  economy: EconomyPolicy,
  taskKind: TaskKind,
): readonly EconomyPoolEntry[] {
  const byId = new Map(economy.pool.map((entry) => [entry.profileId, entry]));
  const seen = new Set<string>();
  const ordered: EconomyPoolEntry[] = [];
  const ids = [
    ...(economy.taskOrder[taskKind] ?? []),
    ...economy.pool.map((entry) => entry.profileId),
  ];
  for (const profileId of ids) {
    if (seen.has(profileId)) continue;
    seen.add(profileId);
    const entry = byId.get(profileId);
    if (entry) ordered.push(entry);
  }
  return ordered;
}

type PoolAttempt = {
  selection?: { profile: PaseoProfile; family?: string };
  issues: ModeIssue[];
};

/**
 * First enabled, existing, definitely available Profile in taskOrder/pool order. Anything else is
 * counted once into a single summary issue; a missing availability row is "unverified", never
 * "available", for pool and collaboration candidates.
 */
function selectFromPool(input: {
  taskKind: TaskKind;
  economy: EconomyPolicy;
  profiles: readonly PaseoProfile[];
  availability: readonly ProviderAvailability[];
  excludedProfileIds?: ReadonlySet<string>;
}): PoolAttempt {
  if (input.economy.pool.length === 0) {
    return { issues: [warning("MODE_POOL_EMPTY", {})] };
  }

  const liveProfiles = new Map(input.profiles.map((profile) => [profile.id, profile]));
  let disabled = 0;
  let missing = 0;
  let unavailable = 0;
  let unverified = 0;
  let excluded = 0;
  const unavailableProviders = new Set<string>();

  for (const entry of orderedPoolEntries(input.economy, input.taskKind)) {
    const profile = liveProfiles.get(entry.profileId);
    if (!entry.enabled) {
      disabled += 1;
      continue;
    }
    if (input.excludedProfileIds?.has(entry.profileId)) {
      excluded += 1;
      continue;
    }
    if (!profile) {
      missing += 1;
      continue;
    }
    const state = availabilityOf(profile, input.availability);
    if (state === "unverified") {
      unverified += 1;
      continue;
    }
    if (state === "unavailable") {
      unavailable += 1;
      unavailableProviders.add(profile.provider);
      continue;
    }
    return { selection: { profile, family: entry.family }, issues: [] };
  }

  const params: Record<string, string | number> = {
    pool: input.economy.pool.length,
    disabled,
    missing,
    unavailable,
    unverified,
    excluded,
  };
  if (unavailableProviders.size === 1) {
    params.provider = [...unavailableProviders][0] as string;
  }
  return { issues: [warning("MODE_POOL_UNAVAILABLE", params)] };
}

function originalSelection(
  input: {
    role: Role;
    profiles: readonly PaseoProfile[];
    availability: readonly ProviderAvailability[];
    economy: EconomyPolicy;
    excludedProfileIds?: ReadonlySet<string>;
  },
  issues: ModeIssue[],
  standby: boolean,
): Result<ProfileSelection, ModeIssue[]> {
  const excluded = input.excludedProfileIds;
  const preferredProfiles = input.role.preferredProfiles.filter(
    (ref) => !excluded?.has(ref.profileId),
  );
  const fallbackProfiles = input.role.fallbackProfiles.filter(
    (ref) => !excluded?.has(ref.profileId),
  );
  const role: Role = { ...input.role, preferredProfiles, fallbackProfiles };
  const unavailable = (reason: string): Result<ProfileSelection, ModeIssue[]> => {
    const unavailableIssues = [
      ...issues,
      warning("MODE_ESCALATION_UNAVAILABLE", { reason }, { roleId: input.role.id }),
    ];
    return {
      ok: true,
      value: {
        profile: null,
        source: "unavailable",
        budget: "unknown",
        budgetBasis: "conservative-default",
        standby: true,
        unavailable: true,
        issues: unavailableIssues,
      },
      issues: unavailableIssues,
    };
  };

  if (preferredProfiles.length + fallbackProfiles.length === 0) {
    // Every original candidate was excluded (for example because it just hit its quota).
    if (standby) return unavailable("all-excluded");
    return {
      ok: false,
      issues: [
        ...issues,
        blocker("MODE_PROFILE_UNRESOLVED", { reason: "all-excluded" }, { roleId: input.role.id }),
      ],
    };
  }

  const resolved: ProfileResolution = resolveProfile(role, input.profiles, input.availability);
  if (!resolved.ok) {
    if (standby) return unavailable(resolved.reason);
    return {
      ok: false,
      issues: [
        ...issues,
        blocker("MODE_PROFILE_UNRESOLVED", { reason: resolved.reason }, { roleId: input.role.id }),
      ],
    };
  }
  const budget = budgetOf(resolved.profile.id, input.economy);
  return {
    ok: true,
    value: {
      profile: resolved.profile,
      source: resolved.source,
      budget: budget.budget,
      budgetBasis: budget.basis,
      standby,
      unavailable: false,
      issues,
    },
    issues,
  };
}

function resolveCheapSeat(input: {
  role: Role;
  kind: "coordinator" | "member";
  tier: RoleTier;
  taskKind: TaskKind;
  host: Extract<HostSnapshot, { status: "ready" }>;
  economy: EconomyPolicy;
  excludedProfileIds?: ReadonlySet<string>;
}): Result<ProfileSelection, ModeIssue[]> {
  const route = routeOf(input.kind, input.tier);
  const policy = input.economy.allSeats;
  if (!policy || policy.status === "absent") {
    return {
      ok: false,
      issues: [
        blocker(
          "MODE_CHEAP_POLICY_REQUIRED",
          { route, reason: "absent" },
          { roleId: input.role.id },
        ),
      ],
    };
  }
  if (policy.status === "invalid") {
    return {
      ok: false,
      issues: [
        blocker(
          "MODE_CHEAP_POLICY_REQUIRED",
          {
            route,
            reason: policy.reason,
            ...(policy.version === undefined ? {} : { version: String(policy.version) }),
          },
          { roleId: input.role.id },
        ),
      ],
    };
  }
  const order: RouteOrder = {
    routes: policy.routes,
    executionTaskOrder: policy.executionTaskOrder,
  };
  const ids = orderedRouteIds(order, route, input.taskKind);
  const liveProfiles = new Map(input.host.profiles.map((profile) => [profile.id, profile]));
  const entries = new Map(policy.profiles.map((entry) => [entry.profileId, entry]));
  const counts = {
    candidates: ids.length,
    disabled: 0,
    missing: 0,
    unavailable: 0,
    unverified: 0,
    invalid: 0,
    outsideList: 0,
    excluded: 0,
  };
  const profileIssues: ModeIssue[] = [];

  for (const profileId of ids) {
    if (input.excludedProfileIds?.has(profileId)) {
      counts.excluded += 1;
      continue;
    }
    const entry = entries.get(profileId);
    const live = liveProfiles.get(profileId);
    if (!entry) {
      counts.outsideList += 1;
      continue;
    }
    if (!live) {
      counts.missing += 1;
      profileIssues.push(
        blocker(
          "MODE_CHEAP_PROFILE_INVALID",
          { route, profileId, reason: "outside-list" },
          { roleId: input.role.id, profileId },
        ),
      );
      continue;
    }
    const budgetLabel = input.economy.profileBudget[profileId];
    const check = evaluateCheapCandidate({
      entry,
      live,
      route,
      ...(budgetLabel === undefined ? {} : { profileBudget: budgetLabel }),
      availability: input.host.availability,
      excludedProfileIds: input.excludedProfileIds,
    });
    if (check.ok) {
      return {
        ok: true,
        value: {
          profile: live,
          source: "economy-pool",
          budget: "economy",
          budgetBasis: "pool",
          family: check.family,
          route,
          standby: input.tier === "escalation",
          unavailable: false,
          issues: [],
        },
        issues: [],
      };
    }
    if (check.reason === "disabled") counts.disabled += 1;
    else if (check.reason === "unavailable") counts.unavailable += 1;
    else if (check.reason === "unverified") counts.unverified += 1;
    else counts.invalid += 1;
    profileIssues.push(
      blocker(
        "MODE_CHEAP_PROFILE_INVALID",
        { route, profileId, reason: check.reason },
        { roleId: input.role.id, profileId },
      ),
    );
  }

  const failureIssues = [
    ...profileIssues,
    blocker(
      "MODE_CHEAP_ROUTE_UNAVAILABLE",
      {
        route,
        candidates: counts.candidates,
        disabled: counts.disabled,
        missing: counts.missing,
        unavailable: counts.unavailable,
        unverified: counts.unverified,
        invalid: counts.invalid,
        outsideList: counts.outsideList,
        excluded: counts.excluded,
      },
      { roleId: input.role.id },
    ),
  ];
  if (input.tier === "escalation") {
    // The standby seat stays visible (and blocked) instead of disappearing from the plan.
    return {
      ok: true,
      value: {
        profile: null,
        source: "unavailable",
        budget: "unknown",
        budgetBasis: "conservative-default",
        standby: true,
        unavailable: true,
        issues: failureIssues,
      },
      issues: failureIssues,
    };
  }
  return { ok: false, issues: failureIssues };
}

/**
 * Per-seat mode selection. Coordinator, decision, retain, and escalation seats keep the Role's
 * original binding; only execution seats use the economy pool. A pool miss falls back to the same
 * original binding once, and only a failed original binding blocks the seat.
 */
export function resolveModeProfile(
  input: ResolveModeProfileInput,
): Result<ProfileSelection, ModeIssue[]> {
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
  const { profiles, availability } = input.host;

  if (input.host.availabilityUnverified && input.mode !== "sota") {
    // An unreadable availability query must not become an empty, healthy pool; SOTA keeps its
    // legacy behavior (see seat planning), while the new modes refuse to plan.
    return {
      ok: false,
      issues: [
        blocker("MODE_CONTEXT_UNAVAILABLE", {
          reason: "availability-unverified",
          mode: input.mode,
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

  const execution = resolveRoleExecution(input.role, input.kind);
  if (!execution.ok) return execution;

  const policy = execution.value;
  const policyIssues = execution.issues ?? [];
  const original = {
    role: input.role,
    profiles,
    availability,
    economy: input.economy,
    excludedProfileIds: input.excludedProfileIds,
  };

  if (input.mode === "economy-all") {
    return resolveCheapSeat({
      role: input.role,
      kind: input.kind,
      tier: policy.tier,
      taskKind: policy.taskKind,
      host: input.host,
      economy: input.economy,
      ...(input.excludedProfileIds === undefined
        ? {}
        : { excludedProfileIds: input.excludedProfileIds }),
    });
  }

  if (input.kind === "coordinator" || policy.tier !== "execution" || input.mode === "sota") {
    return originalSelection(
      original,
      policyIssues,
      policy.tier === "escalation" && input.mode !== "sota",
    );
  }

  const attempt = selectFromPool({
    taskKind: policy.taskKind,
    economy: input.economy,
    profiles,
    availability,
    excludedProfileIds: input.excludedProfileIds,
  });
  if (attempt.selection) {
    return {
      ok: true,
      value: {
        profile: attempt.selection.profile,
        source: "economy-pool",
        budget: "economy",
        budgetBasis: "pool",
        ...(attempt.selection.family === undefined ? {} : { family: attempt.selection.family }),
        standby: false,
        unavailable: false,
        issues: policyIssues,
      },
      issues: policyIssues,
    };
  }
  return originalSelection(original, [...policyIssues, ...attempt.issues], false);
}

export type CoordinatorResolution =
  | { ok: true; selection: AvailableProfileSelection; warnings: string[] }
  | { ok: false; legacyReason?: string; issues: ModeIssue[] };

/**
 * Coordinator selection. Legacy modes keep resolveProfile's exact source/warnings/budget; the new
 * economy-all mode uses the coordinator cheap route and never falls back to the original binding.
 */
export function resolveCoordinatorProfile(input: {
  mode: TeamMode;
  role: Role;
  host: HostSnapshot;
  economy: EconomyPolicy;
  excludedProfileIds?: ReadonlySet<string>;
}): CoordinatorResolution {
  if (input.mode === "economy-all") {
    const resolved = resolveModeProfile({
      mode: input.mode,
      role: input.role,
      kind: "coordinator",
      host: input.host,
      economy: input.economy,
      ...(input.excludedProfileIds === undefined
        ? {}
        : { excludedProfileIds: input.excludedProfileIds }),
    });
    if (!resolved.ok) return { ok: false, issues: resolved.issues ?? [] };
    if (resolved.value.unavailable) {
      return { ok: false, issues: resolved.issues ?? [] };
    }
    return { ok: true, selection: resolved.value, warnings: [] };
  }
  const profiles = input.host.status === "ready" ? input.host.profiles : [];
  const availability = input.host.status === "ready" ? input.host.availability : [];
  const resolved = resolveProfile(input.role, profiles, availability);
  if (!resolved.ok) return { ok: false, legacyReason: resolved.reason, issues: [] };
  const budget = budgetOf(resolved.profile.id, input.economy);
  return {
    ok: true,
    selection: {
      profile: resolved.profile,
      source: resolved.source,
      budget: budget.budget,
      budgetBasis: budget.basis,
      standby: false,
      unavailable: false,
      issues: [],
    },
    warnings: resolved.warnings,
  };
}

/**
 * Collaborative cohort: the first candidate per verified family, in taskOrder/pool order, up to
 * the requested 2 or 3 paths. One family is not collaboration, so the seat returns to the original
 * binding; SOTA Profiles are never used to pad a two-way cohort.
 */
export function selectCollaborationProfiles(
  input: SelectCollaborationProfilesInput,
): Result<CollaborationSelection, ModeIssue[]> {
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
  const { profiles, availability } = input.host;

  if (input.host.availabilityUnverified) {
    // Collaboration is a new-mode operation; an unreadable availability query must block it.
    return {
      ok: false,
      issues: [
        blocker("MODE_CONTEXT_UNAVAILABLE", {
          reason: "availability-unverified",
          mode: "collaborative",
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

  const execution = resolveRoleExecution(input.role, "member");
  if (!execution.ok) return execution;
  const taskKind = execution.value.taskKind;

  const original = {
    role: input.role,
    profiles,
    availability,
    economy: input.economy,
    excludedProfileIds: input.excludedProfileIds,
  };
  const issues: ModeIssue[] = [...(execution.issues ?? [])];
  const fallback = (standby = false): Result<CollaborationSelection, ModeIssue[]> => {
    const selection = originalSelection(original, [], standby);
    if (!selection.ok) {
      return { ok: false, issues: [...issues, ...selection.issues] };
    }
    return {
      ok: true,
      value: {
        selections: [{ ...selection.value, issues }],
        effectiveReplicas: 1,
        issues,
      },
      issues,
    };
  };

  if (execution.value.tier !== "execution") {
    // Decision, retain, and escalation seats keep their original binding even when a caller asks
    // for a cohort; only execution work fans out across economy families.
    issues.push(warning("MODE_NO_EXECUTION_COHORT", { roleId: input.role.id }));
    return fallback(execution.value.tier === "escalation");
  }

  if (input.economy.pool.length === 0) {
    issues.push(warning("MODE_POOL_EMPTY", {}));
    issues.push(
      warning("MODE_COLLAB_UNAVAILABLE", { families: 0, requested: input.requestedReplicas }),
    );
    return fallback();
  }

  const liveProfiles = new Map(profiles.map((profile) => [profile.id, profile]));
  // Verified family -> its first candidate plus every later same-family candidate (failure
  // alternates). Collection continues past the requested path count so alternates are complete.
  const families = new Map<string, { profile: PaseoProfile; alternates: string[] }>();
  let disabled = 0;
  let excluded = 0;
  let missing = 0;
  let unavailable = 0;
  let unverified = 0;
  let withoutFamily = 0;
  const unavailableProviders = new Set<string>();

  for (const entry of orderedPoolEntries(input.economy, taskKind)) {
    if (!entry.enabled) {
      disabled += 1;
      continue;
    }
    if (input.excludedProfileIds?.has(entry.profileId)) {
      excluded += 1;
      continue;
    }
    const profile = liveProfiles.get(entry.profileId);
    if (!profile) {
      missing += 1;
      continue;
    }
    if (entry.family === undefined) {
      withoutFamily += 1;
      continue;
    }
    const state = availabilityOf(profile, availability);
    if (state === "unverified") {
      unverified += 1;
      continue;
    }
    if (state === "unavailable") {
      unavailable += 1;
      unavailableProviders.add(profile.provider);
      continue;
    }
    const group = families.get(entry.family);
    if (group) group.alternates.push(entry.profileId);
    else families.set(entry.family, { profile, alternates: [] });
  }

  const selected = [...families.entries()].slice(0, input.requestedReplicas);
  if (selected.length >= 2) {
    if (selected.length < input.requestedReplicas) {
      issues.push(
        warning("MODE_FAMILIES_REDUCED", {
          requested: input.requestedReplicas,
          families: selected.length,
        }),
      );
    }
    const selections: ProfileSelection[] = selected.map(([family, group]) => ({
      profile: group.profile,
      source: "economy-pool",
      budget: "economy",
      budgetBasis: "pool",
      family,
      alternates: group.alternates,
      standby: false,
      unavailable: false,
      issues: [],
    }));
    return {
      ok: true,
      value: { selections, effectiveReplicas: selections.length as 2 | 3, issues },
      issues,
    };
  }

  if (selected.length === 1) {
    issues.push(
      warning("MODE_COLLAB_UNAVAILABLE", {
        families: 1,
        requested: input.requestedReplicas,
      }),
    );
  } else {
    const params: Record<string, string | number> = {
      pool: input.economy.pool.length,
      disabled,
      excluded,
      missing,
      unavailable,
      unverified,
      withoutFamily,
    };
    if (unavailableProviders.size === 1) {
      params.provider = [...unavailableProviders][0] as string;
    }
    issues.push(warning("MODE_POOL_UNAVAILABLE", params));
    issues.push(
      warning("MODE_COLLAB_UNAVAILABLE", {
        families: 0,
        requested: input.requestedReplicas,
      }),
    );
  }
  return fallback();
}

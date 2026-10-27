import type { EconomyBudget } from "../../shared/domain/mode-resolver";
import {
  identifyModelFamily,
  MODEL_FAMILIES,
  type ModelFamily,
  namesHighCostFamily,
  sameModelTuple,
  storedModelFamily,
} from "../../shared/domain/model-family";
import { evaluateCheapCandidate } from "../../shared/domain/cheap-routing";
import { isTaskKind } from "../../shared/domain/role-execution";
import type { PaseoProfile, ProviderAvailability } from "../../shared/paseo/adapter";
import { type Preferences, PreferencesSchema } from "../../shared/schemas/preferences";
import {
  ALL_SEATS_POLICY_VERSION,
  ALL_SEATS_WRITER_LIMIT,
  type AllSeatsRoute,
  StoredAllSeatsEntrySchema,
  type StoredEconomyPolicy,
  type TaskKind,
} from "../../shared/schemas/team-mode";

const FAMILY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TASK_KINDS: readonly TaskKind[] = [
  "coding",
  "testing",
  "acceptance",
  "codebase",
  "ops",
  "general",
];
const BUDGETS: Readonly<Record<EconomyBudget, true>> = {
  economy: true,
  sota: true,
  unknown: true,
};

export const DEFAULT_MAX_MEMBERS = 24;
export const MAX_MAX_MEMBERS = 64;

export type PoolEntryDraft = {
  profileId: string;
  /** Raw text shown in the form; invalid text stays visible until the user edits it. */
  family: string;
  enabled: boolean;
  originalFamily: string;
  originalBoundModel: unknown | null;
  familyTouched: boolean;
};

export type EconomyDraft = {
  pool: PoolEntryDraft[];
  taskOrder: Partial<Record<TaskKind, string[]>>;
  profileBudget: Record<string, EconomyBudget>;
  /** User removals, so unknown raw siblings can stay while the requested id goes away. */
  removed: string[];
  removedBudgets: string[];
  /** The economy-all allowlist and its five routes. Untouched, the stored block is preserved. */
  allSeats: AllSeatsDraft;
};

/** Every route the economy-all policy plans: coordinator, decision, execution, escalation, retain. */
export const ALL_SEATS_ROUTES = [
  "coordinator",
  "decision",
  "execution",
  "escalation",
  "retain",
] as const satisfies readonly AllSeatsRoute[];

export type AllSeatsEntryDraft = {
  profileId: string;
  /** The family key verified against the live provider/model, written with the tuple. */
  family: string;
  enabled: boolean;
  originalFamily: string;
  originalBoundModel: unknown | null;
  /** A new or explicitly re-confirmed entry re-reads the live family and tuple on save. */
  familyTouched: boolean;
};

export type AllSeatsDraft = {
  /** The stored block version, kept only for the warning; an explicit edit writes v1. */
  storedVersion: unknown;
  profiles: AllSeatsEntryDraft[];
  routes: Record<AllSeatsRoute, string[]>;
  executionTaskOrder: Partial<Record<TaskKind, string[]>>;
  removed: string[];
  /** Nothing in this block was edited: the stored block survives the save byte for byte. */
  touched: boolean;
};

export function emptyAllSeatsDraft(): AllSeatsDraft {
  return {
    storedVersion: undefined,
    profiles: [],
    routes: { coordinator: [], decision: [], execution: [], escalation: [], retain: [] },
    executionTaskOrder: {},
    removed: [],
    touched: false,
  };
}

/** The stored version when this version cannot read it, or null when there is nothing to warn about. */
export function allSeatsStoredVersion(draft: AllSeatsDraft): string | null {
  const version = draft.storedVersion;
  if (version === undefined || version === ALL_SEATS_POLICY_VERSION) return null;
  return typeof version === "string" ? version : (JSON.stringify(version) ?? String(version));
}

export type EconomyEditorState = EconomyDraft & { maxMembers: number };

export type EconomyOpenedSnapshot = {
  economy: unknown;
  maxMembers: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function normalizeFamily(value: string): string {
  const family = value.trim().toLowerCase();
  return FAMILY_PATTERN.test(family) ? family : "";
}

export function familyIsInvalid(value: string): boolean {
  return value.trim() !== "" && normalizeFamily(value) === "";
}

function liveBinding(profile: PaseoProfile): { provider: string; model?: string } {
  return { provider: profile.provider, ...(profile.model ? { model: profile.model } : {}) };
}

function savedBinding(value: unknown): { provider: string; model?: string } | null {
  const record = asRecord(value);
  if (!record || typeof record.provider !== "string" || record.provider === "") return null;
  return {
    provider: record.provider,
    ...(typeof record.model === "string" && record.model !== "" ? { model: record.model } : {}),
  };
}

/** A saved family is no longer credible after its Profile is re-pointed. */
export function familyNeedsRebind(
  entry: PoolEntryDraft,
  profile: PaseoProfile | undefined,
): boolean {
  if (!profile || entry.familyTouched || !normalizeFamily(entry.family)) return false;
  const saved = savedBinding(entry.originalBoundModel);
  if (!saved) return false;
  const live = liveBinding(profile);
  return saved.provider !== live.provider || saved.model !== live.model;
}

export function draftFromStored(raw: unknown): EconomyDraft {
  const base = asRecord(raw);
  const pool: PoolEntryDraft[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(base?.pool) ? base.pool : []) {
    const entry = asRecord(item);
    if (!entry || typeof entry.profileId !== "string" || seen.has(entry.profileId)) continue;
    seen.add(entry.profileId);
    const family = typeof entry.family === "string" ? entry.family : "";
    pool.push({
      profileId: entry.profileId,
      family,
      enabled: entry.enabled !== false,
      originalFamily: family,
      originalBoundModel: entry.boundModel === undefined ? null : entry.boundModel,
      familyTouched: false,
    });
  }
  const poolIds = new Set(pool.map((entry) => entry.profileId));
  const taskOrder: Partial<Record<TaskKind, string[]>> = {};
  const rawOrder = asRecord(base?.taskOrder);
  for (const [kind, ids] of Object.entries(rawOrder ?? {})) {
    if (!isTaskKind(kind) || !Array.isArray(ids)) continue;
    const seenIds = new Set<string>();
    const kept: string[] = [];
    for (const id of ids) {
      if (typeof id !== "string" || !poolIds.has(id) || seenIds.has(id)) continue;
      seenIds.add(id);
      kept.push(id);
    }
    if (kept.length > 0) taskOrder[kind] = kept;
  }
  const profileBudget: Record<string, EconomyBudget> = {};
  for (const [profileId, budget] of Object.entries(asRecord(base?.profileBudget) ?? {})) {
    if (
      !poolIds.has(profileId) &&
      typeof budget === "string" &&
      BUDGETS[budget as EconomyBudget] === true
    ) {
      profileBudget[profileId] = budget as EconomyBudget;
    }
  }
  return {
    pool,
    taskOrder,
    profileBudget,
    removed: [],
    removedBudgets: [],
    allSeats: readAllSeats(base?.allSeats),
  };
}

/** Ids kept in order: strings only, inside the allowlist, first occurrence wins. */
function uniqueKnownIds(value: unknown, allowed: ReadonlySet<string>): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || !allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    kept.push(id);
  }
  return kept;
}

/**
 * Read the economy-all policy leniently: an unreadable entry, route, or task order entry is
 * skipped individually and reported by planning, never by failing the whole block. The stored
 * version is remembered so the editor can warn before an explicit edit rewrites the block.
 */
function readAllSeats(raw: unknown): AllSeatsDraft {
  const draft = emptyAllSeatsDraft();
  const base = asRecord(raw);
  if (!base) return draft;
  draft.storedVersion = base.version;
  const seen = new Set<string>();
  for (const item of Array.isArray(base.profiles) ? base.profiles : []) {
    const entry = asRecord(item);
    if (!entry || typeof entry.profileId !== "string" || entry.profileId === "") continue;
    if (seen.has(entry.profileId)) continue;
    seen.add(entry.profileId);
    const family = typeof entry.family === "string" ? entry.family : "";
    draft.profiles.push({
      profileId: entry.profileId,
      family,
      enabled: entry.enabled !== false,
      originalFamily: family,
      originalBoundModel: entry.boundModel === undefined ? null : entry.boundModel,
      familyTouched: false,
    });
  }
  const rawRoutes = asRecord(base.routes) ?? {};
  for (const route of ALL_SEATS_ROUTES) {
    draft.routes[route] = uniqueKnownIds(rawRoutes[route], seen);
  }
  for (const [kind, ids] of Object.entries(asRecord(base.executionTaskOrder) ?? {})) {
    if (!isTaskKind(kind)) continue;
    const kept = uniqueKnownIds(ids, seen);
    if (kept.length > 0) draft.executionTaskOrder[kind] = kept;
  }
  return draft;
}

export function moveInList<T>(items: readonly T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (target < 0 || target >= items.length) return [...items];
  const next = [...items];
  const [item] = next.splice(index, 1);
  if (item !== undefined) next.splice(target, 0, item);
  return next;
}

export function addPoolEntry(draft: EconomyDraft, profileId: string, family = ""): EconomyDraft {
  if (draft.pool.some((entry) => entry.profileId === profileId)) return draft;
  return {
    ...draft,
    pool: [
      ...draft.pool,
      {
        profileId,
        family,
        enabled: true,
        originalFamily: "",
        originalBoundModel: null,
        familyTouched: false,
      },
    ],
    removed: draft.removed.filter((id) => id !== profileId),
    removedBudgets: draft.removedBudgets.filter((id) => id !== profileId),
  };
}

export function removePoolEntry(draft: EconomyDraft, profileId: string): EconomyDraft {
  const taskOrder: Partial<Record<TaskKind, string[]>> = {};
  for (const [kind, ids] of Object.entries(draft.taskOrder)) {
    const kept = (ids ?? []).filter((id) => id !== profileId);
    if (kept.length > 0) taskOrder[kind as TaskKind] = kept;
  }
  const profileBudget = { ...draft.profileBudget };
  delete profileBudget[profileId];
  return {
    ...draft,
    pool: draft.pool.filter((entry) => entry.profileId !== profileId),
    taskOrder,
    profileBudget,
    removed: draft.removed.includes(profileId) ? draft.removed : [...draft.removed, profileId],
    removedBudgets: draft.removedBudgets.includes(profileId)
      ? draft.removedBudgets
      : [...draft.removedBudgets, profileId],
  };
}

export function movePoolEntry(draft: EconomyDraft, index: number, direction: -1 | 1): EconomyDraft {
  return { ...draft, pool: moveInList(draft.pool, index, direction) };
}

export function setPoolFamily(
  draft: EconomyDraft,
  profileId: string,
  family: string,
): EconomyDraft {
  return {
    ...draft,
    pool: draft.pool.map((entry) =>
      entry.profileId === profileId ? { ...entry, family, familyTouched: true } : entry,
    ),
  };
}

/** Explicitly accept the live provider/model after a Profile was re-pointed. */
export function rebindPoolFamily(draft: EconomyDraft, profileId: string): EconomyDraft {
  return {
    ...draft,
    pool: draft.pool.map((entry) =>
      entry.profileId === profileId ? { ...entry, familyTouched: true } : entry,
    ),
  };
}

export function setPoolEnabled(
  draft: EconomyDraft,
  profileId: string,
  enabled: boolean,
): EconomyDraft {
  return {
    ...draft,
    pool: draft.pool.map((entry) =>
      entry.profileId === profileId ? { ...entry, enabled } : entry,
    ),
  };
}

export function effectiveTaskOrder(draft: EconomyDraft, kind: TaskKind): string[] {
  const poolIds = draft.pool.map((entry) => entry.profileId);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const profileId of [...(draft.taskOrder[kind] ?? []), ...poolIds]) {
    if (seen.has(profileId) || !poolIds.includes(profileId)) continue;
    seen.add(profileId);
    ordered.push(profileId);
  }
  return ordered;
}

export function moveTaskOrder(
  draft: EconomyDraft,
  kind: TaskKind,
  index: number,
  direction: -1 | 1,
): EconomyDraft {
  const order = moveInList(effectiveTaskOrder(draft, kind), index, direction);
  return { ...draft, taskOrder: { ...draft.taskOrder, [kind]: order } };
}

export function resetTaskOrder(draft: EconomyDraft, kind: TaskKind): EconomyDraft {
  const taskOrder = { ...draft.taskOrder };
  delete taskOrder[kind];
  return { ...draft, taskOrder };
}

export function setProfileBudget(
  draft: EconomyDraft,
  profileId: string,
  budget: EconomyBudget,
): EconomyDraft {
  if (draft.pool.some((entry) => entry.profileId === profileId)) return draft;
  return {
    ...draft,
    profileBudget: { ...draft.profileBudget, [profileId]: budget },
    removedBudgets: draft.removedBudgets.filter((id) => id !== profileId),
  };
}

export function removeProfileBudget(draft: EconomyDraft, profileId: string): EconomyDraft {
  const profileBudget = { ...draft.profileBudget };
  delete profileBudget[profileId];
  return {
    ...draft,
    profileBudget,
    removedBudgets: draft.removedBudgets.includes(profileId)
      ? draft.removedBudgets
      : [...draft.removedBudgets, profileId],
  };
}

// ---------------------------------------------------------------------------------------------
// Economy-all ("全席位") policy: allowlist, five routes, and the execution task order.
// Nothing here decides eligibility at launch time — planning re-verifies every tuple. The editor
// derives the family from the live model, never from a Profile name, and only writes a family it
// has seen as a supported low-cost one.
// ---------------------------------------------------------------------------------------------

export const SUGGESTED_DECISION_FAMILIES: readonly ModelFamily[] = ["sonnet"];
export const SUGGESTED_EXECUTION_FAMILIES: readonly ModelFamily[] = ["deepseek", "grok"];

/** The supported low-cost family of a live Profile, or null when the model id does not resolve. */
export function cheapFamilyOf(profile: { model?: string }): ModelFamily | null {
  const match = identifyModelFamily({ model: profile.model });
  return match.status === "identified" && match.cost === "low" ? match.family : null;
}

export type AllSeatsExclusionReason =
  | "profile-missing"
  | "model-unresolved"
  | "family-high-cost"
  | "needs-rebind"
  | "provider-unavailable"
  | "provider-unverified"
  | "budget-conflict";

export type AllSeatsEntryCheck = {
  liveFamily: ModelFamily | null;
  exclusion: AllSeatsExclusionReason | null;
  providerReason?: string;
};

/** A saved family and tuple still describe the live Profile (the pool's existing rule). */
function allSeatsBindingVerified(entry: AllSeatsEntryDraft, profile: PaseoProfile): boolean {
  if (entry.familyTouched) return true;
  if (!entry.originalFamily) return false;
  const storedFamily = storedModelFamily(entry.originalFamily);
  if (!storedFamily || MODEL_FAMILIES[storedFamily].cost !== "low") return false;
  const saved = savedBinding(entry.originalBoundModel);
  return saved !== null && sameModelTuple(saved, liveBinding(profile));
}

/**
 * Display-side eligibility. The model identity and the saved binding are checked here (they decide
 * what the editor shows and writes); the budget label, the family match, and the provider
 * availability come from the planner's own `evaluateCheapCandidate`, so "合格" here and a launch
 * blocker can never disagree. `availability` null means the query has not answered, which is never
 * treated as available. `profileBudget` is the explicit label that would be saved for this
 * Profile (pool members carry none). Disabled entries keep their reason; the editor labels them
 * separately.
 */
export function checkAllSeatsEntry(
  entry: AllSeatsEntryDraft,
  profiles: readonly PaseoProfile[],
  availability?: readonly ProviderAvailability[] | null,
  profileBudget?: EconomyBudget,
): AllSeatsEntryCheck {
  const profile = profiles.find((item) => item.id === entry.profileId);
  if (!profile) return { liveFamily: null, exclusion: "profile-missing" };
  const match = identifyModelFamily({ model: profile.model });
  if (match.status !== "identified") {
    return {
      liveFamily: null,
      exclusion: namesHighCostFamily(match) ? "family-high-cost" : "model-unresolved",
    };
  }
  if (match.cost === "high") return { liveFamily: match.family, exclusion: "family-high-cost" };
  if (match.cost === "unknown") {
    return { liveFamily: match.family, exclusion: "model-unresolved" };
  }
  if (!allSeatsBindingVerified(entry, profile)) {
    return { liveFamily: match.family, exclusion: "needs-rebind" };
  }
  const family = storedModelFamily(entry.familyTouched ? entry.family : entry.originalFamily);
  const live = liveBinding(profile);
  const verdict = evaluateCheapCandidate({
    entry: {
      profileId: entry.profileId,
      enabled: true,
      family: family ?? match.family,
      boundModel: { provider: live.provider, model: live.model ?? "" },
    },
    live: profile,
    route: "execution",
    ...(profileBudget === undefined ? {} : { profileBudget }),
    availability: availability ?? [],
  });
  if (verdict.ok) return { liveFamily: match.family, exclusion: null };
  const row = availability?.find((item) => item.provider === profile.provider);
  switch (verdict.reason) {
    case "budget-conflict":
      return { liveFamily: match.family, exclusion: "budget-conflict" };
    case "unverified":
      return { liveFamily: match.family, exclusion: "provider-unverified" };
    case "unavailable":
      return {
        liveFamily: match.family,
        exclusion: "provider-unavailable",
        ...(row?.reason === undefined ? {} : { providerReason: row.reason }),
      };
    case "high-cost-family":
      return { liveFamily: match.family, exclusion: "family-high-cost" };
    case "model-missing":
    case "model-auto":
    case "family-unknown":
    case "family-ambiguous":
      return { liveFamily: match.family, exclusion: "model-unresolved" };
    default:
      // family-mismatch, tuple-changed: the saved claim no longer describes the live Profile.
      return { liveFamily: match.family, exclusion: "needs-rebind" };
  }
}

/** A new or re-confirmed entry can only be written with a live, resolved low-cost Profile. */
export function allSeatsEntryNeedsLiveProfile(
  entry: AllSeatsEntryDraft,
  live: ReadonlyMap<string, PaseoProfile>,
): boolean {
  if (!entry.familyTouched && entry.originalFamily) return false;
  const profile = live.get(entry.profileId);
  return !profile || cheapFamilyOf(profile) === null;
}

function editAllSeats(draft: EconomyDraft, allSeats: AllSeatsDraft): EconomyDraft {
  return { ...draft, allSeats: { ...allSeats, touched: true } };
}

/** Add a live Profile whose model resolves to a supported low-cost family. */
export function addAllSeatsProfile(draft: EconomyDraft, profile: PaseoProfile): EconomyDraft {
  const { allSeats } = draft;
  if (allSeats.profiles.length >= ALL_SEATS_WRITER_LIMIT) return draft;
  if (allSeats.profiles.some((entry) => entry.profileId === profile.id)) return draft;
  const family = cheapFamilyOf(profile);
  if (!family) return draft;
  return editAllSeats(draft, {
    ...allSeats,
    profiles: [
      ...allSeats.profiles,
      {
        profileId: profile.id,
        family,
        enabled: true,
        originalFamily: "",
        originalBoundModel: null,
        familyTouched: true,
      },
    ],
    removed: allSeats.removed.filter((id) => id !== profile.id),
  });
}

export function removeAllSeatsProfile(draft: EconomyDraft, profileId: string): EconomyDraft {
  const { allSeats } = draft;
  if (!allSeats.profiles.some((entry) => entry.profileId === profileId)) return draft;
  const routes = { ...allSeats.routes };
  for (const route of ALL_SEATS_ROUTES) {
    routes[route] = routes[route].filter((id) => id !== profileId);
  }
  const executionTaskOrder: Partial<Record<TaskKind, string[]>> = {};
  for (const [kind, ids] of Object.entries(allSeats.executionTaskOrder)) {
    const kept = (ids ?? []).filter((id) => id !== profileId);
    if (kept.length > 0) executionTaskOrder[kind as TaskKind] = kept;
  }
  return editAllSeats(draft, {
    ...allSeats,
    profiles: allSeats.profiles.filter((entry) => entry.profileId !== profileId),
    routes,
    executionTaskOrder,
    removed: allSeats.removed.includes(profileId)
      ? allSeats.removed
      : [...allSeats.removed, profileId],
  });
}

export function setAllSeatsEnabled(
  draft: EconomyDraft,
  profileId: string,
  enabled: boolean,
): EconomyDraft {
  const { allSeats } = draft;
  if (!allSeats.profiles.some((entry) => entry.profileId === profileId)) return draft;
  return editAllSeats(draft, {
    ...allSeats,
    profiles: allSeats.profiles.map((entry) =>
      entry.profileId === profileId ? { ...entry, enabled } : entry,
    ),
  });
}

/** Accept the live family and provider/model tuple after a Profile was re-pointed. */
export function rebindAllSeatsProfile(
  draft: EconomyDraft,
  profileId: string,
  profile: PaseoProfile,
): EconomyDraft {
  const family = cheapFamilyOf(profile);
  if (!family) return draft;
  const { allSeats } = draft;
  if (!allSeats.profiles.some((entry) => entry.profileId === profileId)) return draft;
  return editAllSeats(draft, {
    ...allSeats,
    profiles: allSeats.profiles.map((entry) =>
      entry.profileId === profileId ? { ...entry, family, familyTouched: true } : entry,
    ),
  });
}

export function addAllSeatsRouteEntry(
  draft: EconomyDraft,
  route: AllSeatsRoute,
  profileId: string,
): EconomyDraft {
  const { allSeats } = draft;
  if (!allSeats.profiles.some((entry) => entry.profileId === profileId)) return draft;
  const current = allSeats.routes[route];
  if (current.includes(profileId) || current.length >= ALL_SEATS_WRITER_LIMIT) return draft;
  const routes = { ...allSeats.routes };
  routes[route] = [...current, profileId];
  return editAllSeats(draft, { ...allSeats, routes });
}

export function removeAllSeatsRouteEntry(
  draft: EconomyDraft,
  route: AllSeatsRoute,
  profileId: string,
): EconomyDraft {
  const { allSeats } = draft;
  if (!allSeats.routes[route].includes(profileId)) return draft;
  const routes = { ...allSeats.routes };
  routes[route] = allSeats.routes[route].filter((id) => id !== profileId);
  const executionTaskOrder = { ...allSeats.executionTaskOrder };
  for (const [kind, ids] of Object.entries(executionTaskOrder)) {
    const kept = (ids ?? []).filter((id) => id !== profileId);
    if (kept.length > 0) executionTaskOrder[kind as TaskKind] = kept;
    else delete executionTaskOrder[kind as TaskKind];
  }
  return editAllSeats(draft, { ...allSeats, routes, executionTaskOrder });
}

export function moveAllSeatsRouteEntry(
  draft: EconomyDraft,
  route: AllSeatsRoute,
  index: number,
  direction: -1 | 1,
): EconomyDraft {
  const { allSeats } = draft;
  const routes = { ...allSeats.routes };
  routes[route] = moveInList(allSeats.routes[route], index, direction);
  return editAllSeats(draft, { ...allSeats, routes });
}

/** The execution route order with the task-kind override in front, filtered inside the route. */
export function effectiveAllSeatsTaskOrder(draft: EconomyDraft, kind: TaskKind): string[] {
  const route = draft.allSeats.routes.execution;
  const inRoute = new Set(route);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const profileId of [...(draft.allSeats.executionTaskOrder[kind] ?? []), ...route]) {
    if (seen.has(profileId) || !inRoute.has(profileId)) continue;
    seen.add(profileId);
    ordered.push(profileId);
  }
  return ordered;
}

export function moveAllSeatsTaskOrder(
  draft: EconomyDraft,
  kind: TaskKind,
  index: number,
  direction: -1 | 1,
): EconomyDraft {
  const order = moveInList(effectiveAllSeatsTaskOrder(draft, kind), index, direction);
  const { allSeats } = draft;
  return editAllSeats(draft, {
    ...allSeats,
    executionTaskOrder: { ...allSeats.executionTaskOrder, [kind]: order },
  });
}

export function resetAllSeatsTaskOrder(draft: EconomyDraft, kind: TaskKind): EconomyDraft {
  const { allSeats } = draft;
  const executionTaskOrder = { ...allSeats.executionTaskOrder };
  delete executionTaskOrder[kind];
  return editAllSeats(draft, { ...allSeats, executionTaskOrder });
}

/**
 * A Grok 4.7 Profile. Suggestions leave it out (H5: the default must not add Grok-4.7); a hand
 * configured entry stays. The model id is the evidence; the Profile name only widens the exclusion,
 * which is safe because this never decides eligibility.
 */
export function isGrok47(profile: { name?: string; model?: string }): boolean {
  const pattern = /grok[^a-z0-9]*4[^a-z0-9]*7(?![0-9])/i;
  return pattern.test(profile.model ?? "") || pattern.test(profile.name ?? "");
}

/**
 * Fill the allowlist and routes from the live low-cost Profiles: Sonnet for coordinator, decision,
 * escalation, and retain; DeepSeek then Grok for execution, with ops/acceptance preferring Grok.
 * Advice only: it edits the draft and never saves. Grok 4.7 is never suggested, an existing entry
 * is never removed, and a route or task order the user already configured is left as it is.
 */
export function applySuggestedAllSeats(
  draft: EconomyDraft,
  profiles: readonly PaseoProfile[],
): EconomyDraft {
  const suggested = profiles.flatMap((profile) => {
    const family = cheapFamilyOf(profile);
    if (!family || isGrok47(profile)) return [];
    if (!SUGGESTED_DECISION_FAMILIES.includes(family)) {
      if (!SUGGESTED_EXECUTION_FAMILIES.includes(family)) return [];
    }
    return [{ profile, family }];
  });
  if (suggested.length === 0) return draft;
  let next = draft;
  for (const { profile } of suggested) next = addAllSeatsProfile(next, profile);
  const familyById = new Map(suggested.map(({ profile, family }) => [profile.id, family]));
  const idsFor = (families: readonly ModelFamily[]): string[] =>
    next.allSeats.profiles
      .map((entry) => entry.profileId)
      .filter((id) => {
        const family = familyById.get(id);
        return family !== undefined && families.includes(family);
      })
      .slice(0, ALL_SEATS_WRITER_LIMIT);
  const decision = idsFor(SUGGESTED_DECISION_FAMILIES);
  const execution = idsFor(SUGGESTED_EXECUTION_FAMILIES);
  const deepseek = execution.filter((id) => familyById.get(id) === "deepseek");
  const grok = execution.filter((id) => familyById.get(id) === "grok");
  const executionOrder = [...deepseek, ...grok].slice(0, ALL_SEATS_WRITER_LIMIT);
  const grokFirst = [...grok, ...deepseek].slice(0, ALL_SEATS_WRITER_LIMIT);
  const suggestedRoutes: Record<AllSeatsRoute, string[]> = {
    coordinator: decision,
    decision,
    execution,
    escalation: decision,
    retain: decision,
  };
  const current = next.allSeats;
  const routes = { ...current.routes };
  for (const route of ALL_SEATS_ROUTES) {
    if (current.routes[route].length === 0) routes[route] = suggestedRoutes[route];
  }
  const suggestedOrder: Partial<Record<TaskKind, string[]>> = {
    coding: executionOrder,
    testing: executionOrder,
    codebase: executionOrder,
    general: executionOrder,
    ops: grokFirst,
    acceptance: grokFirst,
  };
  const executionTaskOrder = { ...current.executionTaskOrder };
  for (const [kind, ids] of Object.entries(suggestedOrder)) {
    if (current.executionTaskOrder[kind as TaskKind] === undefined) {
      executionTaskOrder[kind as TaskKind] = ids;
    }
  }
  return editAllSeats(next, { ...current, routes, executionTaskOrder });
}

export type EconomySuggestion = { name: string; family: string };

/** Local advice only. A missing, ambiguous, or non-omp name never becomes a guessed Profile id. */
export const LOCAL_ECONOMY_SUGGESTIONS: readonly EconomySuggestion[] = [
  { name: "DeepSeek-V4.1-Flash-Max", family: "deepseek" },
  { name: "Grok-4.7-Xhigh", family: "grok" },
  { name: "Grok-4.7-Xhigh-Fast", family: "grok" },
  { name: "Grok-4.6-High-Fast", family: "grok" },
];

export function preselectSuggestedPool(
  profiles: readonly PaseoProfile[],
  suggestions: readonly EconomySuggestion[] = LOCAL_ECONOMY_SUGGESTIONS,
): PoolEntryDraft[] {
  const byName = new Map<string, PaseoProfile[]>();
  for (const profile of profiles) {
    if (profile.provider !== "omp") continue;
    const key = profile.name.trim().toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), profile]);
  }
  const entries: PoolEntryDraft[] = [];
  const seen = new Set<string>();
  for (const suggestion of suggestions) {
    const matches = byName.get(suggestion.name.trim().toLowerCase()) ?? [];
    if (matches.length !== 1) continue;
    const profile = matches[0];
    if (!profile || seen.has(profile.id)) continue;
    seen.add(profile.id);
    entries.push({
      profileId: profile.id,
      family: suggestion.family,
      enabled: true,
      originalFamily: "",
      originalBoundModel: null,
      familyTouched: false,
    });
  }
  return entries;
}

export function applySuggestedPool(
  draft: EconomyDraft,
  profiles: readonly PaseoProfile[],
): EconomyDraft {
  let next = draft;
  for (const entry of preselectSuggestedPool(profiles)) {
    if (next.pool.some((item) => item.profileId === entry.profileId)) continue;
    next = {
      ...next,
      pool: [...next.pool, entry],
      profileBudget: Object.fromEntries(
        Object.entries(next.profileBudget).filter(([id]) => id !== entry.profileId),
      ),
      removed: next.removed.filter((id) => id !== entry.profileId),
      removedBudgets: next.removedBudgets.filter((id) => id !== entry.profileId),
    };
  }
  return next;
}

export type MaxMembersResolution = { ok: true; value: number; write: boolean } | { ok: false };

/**
 * Only validate a changed value. An unchanged legacy value (even >64) is written back untouched;
 * the runtime clamps it, but the editor must not silently lower a user's stored limit.
 */
export function resolveMaxMembersForSave(
  text: string,
  openedMaxMembers: number,
  latestMaxMembers: number,
): MaxMembersResolution {
  if (text.trim() === String(openedMaxMembers)) {
    return { ok: true, value: latestMaxMembers, write: false };
  }
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1 || value > MAX_MAX_MEMBERS) return { ok: false };
  return { ok: true, value, write: true };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonical(entry) ?? null);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonical(value ?? null));
}

export type EconomySaveDecision = "write" | "conflict";

/** External changes to the economy block or maxMembers require an explicit overwrite/reload. */
export function decideEconomySave(
  opened: EconomyOpenedSnapshot,
  latest: Preferences,
  forceOverwrite = false,
): EconomySaveDecision {
  if (forceOverwrite) return "write";
  if (opened.maxMembers !== latest.maxMembers) return "conflict";
  return stableJson(opened.economy) === stableJson(latest.economy) ? "write" : "conflict";
}

export function needsLiveProfilesForSave(
  draft: EconomyDraft,
  profiles: readonly PaseoProfile[],
): boolean {
  const live = new Set(profiles.map((profile) => profile.id));
  const poolNeedsProfiles = draft.pool.some((entry) => {
    if (!normalizeFamily(entry.family)) return false;
    // Only a new entry or one whose family the user touched requires a live Profile. An untouched
    // legacy unbound entry is preserved as-is, so editing only maxMembers must not be blocked.
    const needsBinding =
      entry.familyTouched || (!entry.originalFamily && entry.originalBoundModel === null);
    return needsBinding && !live.has(entry.profileId);
  });
  if (poolNeedsProfiles) return true;
  const liveById = new Map(profiles.map((profile) => [profile.id, profile]));
  return draft.allSeats.profiles.some((entry) => allSeatsEntryNeedsLiveProfile(entry, liveById));
}

function buildPoolEntry(
  entry: PoolEntryDraft,
  raw: Record<string, unknown> | undefined,
  profile: PaseoProfile | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...(raw ?? {}),
    profileId: entry.profileId,
    enabled: entry.enabled,
  };
  if (entry.familyTouched) {
    const family = normalizeFamily(entry.family);
    if (family) {
      out.family = family;
      if (profile) out.boundModel = liveBinding(profile);
      else delete out.boundModel;
    } else {
      delete out.family;
      delete out.boundModel;
    }
  } else {
    // Preserve the original raw family (including invalid/future text) and boundModel. A new or
    // previously unbound valid family may adopt the live tuple.
    const originalFamily = normalizeFamily(entry.originalFamily);
    const currentFamily = normalizeFamily(entry.family);
    if (!entry.originalFamily && currentFamily) {
      out.family = currentFamily;
      if (profile) out.boundModel = liveBinding(profile);
    } else if (entry.originalBoundModel === null && originalFamily && profile) {
      out.boundModel = liveBinding(profile);
    }
  }
  if (profile?.name) out.nameSnapshot = profile.name;
  return out;
}

/** Build a stored economy block while preserving unreadable entries, duplicates, and extensions. */
export function buildStoredEconomy(
  raw: unknown,
  draft: EconomyDraft,
  profiles: readonly PaseoProfile[],
): StoredEconomyPolicy {
  const base = asRecord(raw) ?? {};
  const rawPool = Array.isArray(base.pool) ? base.pool : [];
  const rawById = new Map<string, Record<string, unknown>>();
  for (const item of rawPool) {
    const entry = asRecord(item);
    if (entry && typeof entry.profileId === "string" && !rawById.has(entry.profileId)) {
      rawById.set(entry.profileId, entry);
    }
  }
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  const draftById = new Map(draft.pool.map((entry) => [entry.profileId, entry]));
  const removed = new Set(draft.removed);
  const consumed = new Set<string>();
  const pool: unknown[] = [];
  for (const item of rawPool) {
    const entry = asRecord(item);
    const profileId = entry && typeof entry.profileId === "string" ? entry.profileId : null;
    if (!profileId) {
      pool.push(item);
      continue;
    }
    if (removed.has(profileId)) continue;
    const wanted = draftById.get(profileId);
    if (wanted && !consumed.has(profileId)) {
      pool.push(buildPoolEntry(wanted, entry ?? undefined, profilesById.get(profileId)));
      consumed.add(profileId);
    } else {
      // Duplicate or unknown raw sibling: keep it exactly as stored.
      pool.push(item);
    }
  }
  for (const entry of draft.pool) {
    if (consumed.has(entry.profileId)) continue;
    pool.push(
      buildPoolEntry(entry, rawById.get(entry.profileId), profilesById.get(entry.profileId)),
    );
  }
  const poolIds = new Set(
    pool.flatMap((entry) => {
      const record = asRecord(entry);
      return record && typeof record.profileId === "string" ? [record.profileId] : [];
    }),
  );
  const rawOrder = asRecord(base.taskOrder) ?? {};
  const taskOrder: Record<string, unknown> = { ...rawOrder };
  for (const kind of TASK_KINDS) {
    const order = (draft.taskOrder[kind] ?? []).filter((id) => poolIds.has(id));
    if (order.length > 0) taskOrder[kind] = order;
    else delete taskOrder[kind];
  }
  const rawBudget = asRecord(base.profileBudget) ?? {};
  const profileBudget: Record<string, unknown> = { ...rawBudget };
  for (const profileId of poolIds) delete profileBudget[profileId];
  for (const profileId of draft.removedBudgets) delete profileBudget[profileId];
  for (const [profileId, budget] of Object.entries(draft.profileBudget)) {
    if (!poolIds.has(profileId) && BUDGETS[budget] === true) profileBudget[profileId] = budget;
  }
  return {
    ...base,
    pool,
    taskOrder,
    profileBudget,
    // An untouched block (including a future version) is left exactly as stored by the spread.
    ...(draft.allSeats.touched
      ? { allSeats: buildStoredAllSeats(base.allSeats, draft.allSeats, profilesById) }
      : {}),
  };
}

/**
 * Write one allowlist entry, and only what the user touched. An entry nobody edited is returned
 * exactly as stored: no costClass rewrite, no tuple stamped on an entry that never had one, no
 * refreshed nameSnapshot. A toggled entry changes only `enabled`. A new or re-confirmed entry
 * writes the live low-cost family and tuple it was verified against, never a typed-in claim.
 */
function buildAllSeatsEntry(
  entry: AllSeatsEntryDraft,
  raw: Record<string, unknown> | undefined,
  profile: PaseoProfile | undefined,
): Record<string, unknown> {
  if (raw && !entry.familyTouched) {
    return (raw.enabled !== false) === entry.enabled ? raw : { ...raw, enabled: entry.enabled };
  }
  const out: Record<string, unknown> = {
    ...(raw ?? {}),
    profileId: entry.profileId,
    enabled: entry.enabled,
    costClass: "low",
  };
  const family = profile ? cheapFamilyOf(profile) : null;
  if (family) {
    out.family = family;
    if (profile) out.boundModel = liveBinding(profile);
  } else if (entry.family) {
    out.family = entry.family;
  }
  // Writer shape: a new or re-confirmed entry must carry the family and the verified live tuple.
  StoredAllSeatsEntrySchema.parse(out);
  if (profile?.name) out.nameSnapshot = profile.name;
  return out;
}

/** Build the economy-all block for an explicitly edited draft, keeping unknown raw siblings. */
function buildStoredAllSeats(
  raw: unknown,
  draft: AllSeatsDraft,
  profilesById: ReadonlyMap<string, PaseoProfile>,
): Record<string, unknown> {
  const base = asRecord(raw) ?? {};
  const rawProfiles = Array.isArray(base.profiles) ? base.profiles : [];
  const rawById = new Map<string, Record<string, unknown>>();
  for (const item of rawProfiles) {
    const entry = asRecord(item);
    if (entry && typeof entry.profileId === "string" && !rawById.has(entry.profileId)) {
      rawById.set(entry.profileId, entry);
    }
  }
  const draftById = new Map(draft.profiles.map((entry) => [entry.profileId, entry]));
  const removed = new Set(draft.removed);
  const consumed = new Set<string>();
  const profiles: unknown[] = [];
  for (const item of rawProfiles) {
    const entry = asRecord(item);
    const profileId = entry && typeof entry.profileId === "string" ? entry.profileId : null;
    if (!profileId) {
      profiles.push(item);
      continue;
    }
    if (removed.has(profileId)) continue;
    const wanted = draftById.get(profileId);
    if (!wanted) {
      // An id this version cannot read (removed by a newer writer): preserve the stored entry.
      profiles.push(item);
      continue;
    }
    // A duplicate of an allowlisted id is not a second allowlist entry: keep the first only.
    if (consumed.has(profileId)) continue;
    profiles.push(buildAllSeatsEntry(wanted, entry ?? undefined, profilesById.get(profileId)));
    consumed.add(profileId);
  }
  for (const entry of draft.profiles) {
    if (consumed.has(entry.profileId)) continue;
    profiles.push(
      buildAllSeatsEntry(entry, rawById.get(entry.profileId), profilesById.get(entry.profileId)),
    );
  }
  const allow = new Set(
    profiles.flatMap((entry) => {
      const record = asRecord(entry);
      return record && typeof record.profileId === "string" ? [record.profileId] : [];
    }),
  );
  const rawRoutes = asRecord(base.routes) ?? {};
  const routes: Record<string, unknown> = { ...rawRoutes };
  for (const route of ALL_SEATS_ROUTES) {
    const ids = draft.routes[route].filter((id) => allow.has(id));
    if (ids.length > 0) routes[route] = ids;
    else delete routes[route];
  }
  const rawOrder = asRecord(base.executionTaskOrder) ?? {};
  const executionTaskOrder: Record<string, unknown> = { ...rawOrder };
  const execution = new Set(draft.routes.execution.filter((id) => allow.has(id)));
  for (const kind of TASK_KINDS) {
    const ids = (draft.executionTaskOrder[kind] ?? []).filter((id) => execution.has(id));
    if (ids.length > 0) executionTaskOrder[kind] = ids;
    else delete executionTaskOrder[kind];
  }
  return {
    ...base,
    version: ALL_SEATS_POLICY_VERSION,
    profiles,
    routes,
    executionTaskOrder,
  };
}

export type EconomyMergeOptions = {
  maxMembers?: number;
  /** For an explicit overwrite, build from the opened raw block instead of the latest one. */
  economyBase?: unknown;
};

/** Fresh preferences + editor state: other host fields survive every write. */
export function mergeEconomyPreferences(
  current: Preferences,
  draft: EconomyDraft,
  profiles: readonly PaseoProfile[],
  options: EconomyMergeOptions = {},
): Preferences {
  return PreferencesSchema.parse({
    ...current,
    maxMembers: options.maxMembers ?? current.maxMembers,
    economy: buildStoredEconomy(options.economyBase ?? current.economy, draft, profiles),
  });
}

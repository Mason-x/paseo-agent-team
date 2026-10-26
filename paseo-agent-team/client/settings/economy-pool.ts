import type { EconomyBudget } from "../../shared/domain/mode-resolver";
import { isTaskKind } from "../../shared/domain/role-execution";
import type { PaseoProfile } from "../../shared/paseo/adapter";
import { type Preferences, PreferencesSchema } from "../../shared/schemas/preferences";
import type { StoredEconomyPolicy, TaskKind } from "../../shared/schemas/team-mode";

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
};

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
  return { pool, taskOrder, profileBudget, removed: [], removedBudgets: [] };
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
  return draft.pool.some((entry) => {
    if (!normalizeFamily(entry.family)) return false;
    // Only a new entry or one whose family the user touched requires a live Profile. An untouched
    // legacy unbound entry is preserved as-is, so editing only maxMembers must not be blocked.
    const needsBinding =
      entry.familyTouched || (!entry.originalFamily && entry.originalBoundModel === null);
    return needsBinding && !live.has(entry.profileId);
  });
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
  return { ...base, pool, taskOrder, profileBudget };
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

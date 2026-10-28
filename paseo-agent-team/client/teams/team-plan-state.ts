import type { ModeContractSupport } from "../../shared/domain/mode-contract";
import { modeContractSupport } from "../../shared/domain/mode-contract";
import {
  identifyModelFamily,
  sameModelTuple,
  storedModelFamily,
} from "../../shared/domain/model-family";
import {
  type ModelFamilyHint,
  type ModelSummaryReason,
  summarizeModelRows,
  unresolvedReasonOf,
} from "../../shared/domain/model-summary";
import type { ModeIssue } from "../../shared/domain/role-execution";
import type { PaseoProfile } from "../../shared/paseo/adapter";
import type { ModeIssueDto } from "../../shared/schemas/launch-preview";
import type { Team } from "../../shared/schemas/team";
import {
  AllSeatsRouteSchema,
  StoredAllSeatsEntrySchema,
  StoredAllSeatsPolicySchema,
  type StoredCollaboration,
  StoredEconomyEntrySchema,
  type StoredEconomyPolicy,
} from "../../shared/schemas/team-mode";
import {
  TEAM_PLAN_MAX_ITEMS,
  type TeamPlanInput,
  type TeamPlanOutput,
  type TeamPlanResult,
  type TeamPlanRow,
} from "../../shared/schemas/team-plan";
import { zh } from "../../shared/zh";
import { cheapIssueText } from "../../shared/zh/mode-plan";
import { teamPlanZh } from "../../shared/zh/team-plan";
import { modeIssueText } from "../launch/launch-preview-state";
import { formatLaunchBudget } from "../shared/budget-format";

/**
 * Pure client core for `agent-team.team.plan`: request identity, batching, debounce, cache, probe
 * classification, and the view models the Team list/editor render. No React and no host imports;
 * `use-team-plans.ts` only adapts it to hooks.
 */

export const TEAM_PLAN_DEBOUNCE_MS = 200;
export const TEAM_PLAN_CACHE_TTL_MS = 60_000;
export const TEAM_PLAN_MAX_CONCURRENT_CHUNKS = 2;
export const TEAM_PLAN_MAX_DRAFT_MEMBERS = 64;

export type TeamPlanRevisions = { roles: string; teams: string; preferences: string };

export type TeamPlanScope = {
  hostId: string;
  profiles: readonly PaseoProfile[];
  revisions: TeamPlanRevisions;
};

export type TeamPlanSend = (input: TeamPlanInput) => Promise<TeamPlanOutput>;

export type TeamPlanDraftRequest = {
  /** Stable editor session; only one in-flight draft per session. */
  sessionId: string;
  mode?: string;
  coordinatorRoleId?: string;
  memberCreation?: string;
  collaboration?: StoredCollaboration;
  members: readonly {
    rowKey: string;
    roleId?: string;
    instanceLabel?: string;
    enabled: boolean;
  }[];
};

export type TeamPlanDraftState =
  | { status: "idle" }
  | { status: "pending"; key: string }
  | { status: "result"; key: string; result: TeamPlanResult }
  | { status: "error"; key: string; reason: "legacy" | "failed" | "invalid"; message: string };

export type TeamPlanBatchView = {
  results: ReadonlyMap<string, TeamPlanResult>;
  hasContext: boolean;
  failedKeys: ReadonlySet<string>;
  modeContract: ModeContractSupport;
  loaded: boolean;
  pending: boolean;
  error: string | null;
  checkedAt: string | null;
};

export type TeamPlanClient = {
  setScope(scope: TeamPlanScope): void;
  planTeams(teams: readonly Team[]): void;
  probe(): void;
  requestDraft(request: TeamPlanDraftRequest): void;
  getBatchView(): TeamPlanBatchView;
  getDraftState(sessionId: string): TeamPlanDraftState;
  modeContract(): ModeContractSupport;
  subscribe(listener: () => void): () => void;
  invalidate(): void;
  destroy(): void;
};

type ClientOptions = {
  send: TeamPlanSend;
  now?: () => number;
  debounceMs?: number;
  ttlMs?: number;
  chunkSize?: number;
  maxConcurrent?: number;
  schedule?: (run: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
};

/** Sorted-key JSON so equal payloads share one cache/request identity. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortValue(entry)]),
    );
  }
  return value;
}

export function profileTupleSignature(profiles: readonly PaseoProfile[]): string {
  return stableJson(
    profiles
      .map((profile) => ({
        id: profile.id,
        name: profile.name,
        provider: profile.provider,
        model: profile.model ?? null,
        modeId: profile.modeId ?? null,
        thinkingOptionId: profile.thinkingOptionId ?? null,
      }))
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
}

export function scopeSignature(scope: TeamPlanScope): string {
  return stableJson({
    hostId: scope.hostId,
    profiles: profileTupleSignature(scope.profiles),
    revisions: scope.revisions,
  });
}

function isAutomaticModel(model: string | undefined): boolean {
  const value = model?.trim().toLowerCase();
  return value === undefined || value === "" || value === "auto" || value === "default";
}

/**
 * B01's rule: hints may only come from a live, tuple-matched policy record. Auto/missing models
 * never become a family, and a stored family that contradicts the live model is discarded.
 */
export function familyHintsFromEconomy(
  economy: StoredEconomyPolicy | undefined,
  profiles: readonly PaseoProfile[],
): ModelFamilyHint[] {
  if (!economy) return [];
  const live = new Map(profiles.map((profile) => [profile.id, profile]));
  const hints = new Map<string, ModelFamilyHint>();

  function add(profileId: string, family: string | undefined, bound: unknown): void {
    if (hints.has(profileId)) return;
    const resolved = storedModelFamily(family);
    const profile = live.get(profileId);
    if (!resolved || !profile || isAutomaticModel(profile.model)) return;
    const tuple = bound as { provider?: unknown; model?: unknown } | undefined;
    if (!tuple || typeof tuple.provider !== "string") return;
    if (!sameModelTuple(tuple as { provider: string; model?: string }, profile)) return;
    const match = identifyModelFamily({ model: profile.model });
    if (match.status === "identified" && match.family !== resolved) return;
    hints.set(profileId, {
      profileId,
      provider: profile.provider,
      ...(profile.model === undefined ? {} : { model: profile.model }),
      family: resolved,
    });
  }

  for (const raw of economy.pool ?? []) {
    const entry = StoredEconomyEntrySchema.safeParse(raw);
    if (!entry.success) continue;
    add(entry.data.profileId, entry.data.family, entry.data.boundModel);
  }
  const allSeats = StoredAllSeatsPolicySchema.safeParse(economy.allSeats);
  if (allSeats.success && Array.isArray(allSeats.data.profiles)) {
    for (const raw of allSeats.data.profiles) {
      const entry = StoredAllSeatsEntrySchema.safeParse(raw);
      if (!entry.success) continue;
      add(entry.data.profileId, entry.data.family, entry.data.boundModel);
    }
  }
  return [...hints.values()];
}

const REASON_LABELS: Readonly<Record<ModelSummaryReason, string>> = {
  unbound: teamPlanZh.reasons.unbound,
  "role-missing": teamPlanZh.reasons.roleMissing,
  "profile-missing": teamPlanZh.reasons.profileMissing,
  "provider-unavailable": teamPlanZh.reasons.providerUnavailable,
  unverified: teamPlanZh.reasons.unverified,
  "route-unavailable": teamPlanZh.reasons.routeUnavailable,
  "no-cheap-profile": teamPlanZh.reasons.noCheapProfile,
  policy: teamPlanZh.reasons.policy,
};

export function reasonLabel(reason: ModelSummaryReason): string {
  return REASON_LABELS[reason];
}

export type TeamSummaryView =
  | { kind: "empty" }
  | { kind: "pending" }
  | {
      kind: "summary";
      total: number;
      groupsText: string;
      unresolvedText: string | null;
      tone: "neutral" | "warning";
    }
  | { kind: "unknown-mode"; text: string }
  | { kind: "missing-team"; text: string }
  | { kind: "unavailable"; text: string };

function issueText(issue: ModeIssueDto): string {
  // The server only emits codes from the closed planner table; the DTO keeps them as strings so a
  // newer daemon cannot break this client. cheapIssueText reads params only.
  return issue.code.startsWith("MODE_CHEAP_")
    ? cheapIssueText(issue as ModeIssue)
    : modeIssueText(issue);
}

export function buildTeamSummary(input: {
  result: TeamPlanResult;
  hints?: readonly ModelFamilyHint[];
  /** Only a response with a non-null context can distinguish a missing Team from a read failure. */
  hasContext: boolean;
}): TeamSummaryView {
  const { result } = input;
  if (result.status === "unavailable") {
    if (result.issues.length === 0 && input.hasContext) {
      return { kind: "missing-team", text: teamPlanZh.teamMissing };
    }
    const first = result.issues[0];
    return { kind: "unavailable", text: first ? issueText(first) : teamPlanZh.loadFailed };
  }
  if (result.effectiveMode === null) {
    return { kind: "unknown-mode", text: teamPlanZh.unknownMode(result.rawMode ?? "") };
  }
  const summary = summarizeModelRows({
    status: result.status,
    effectiveMode: result.effectiveMode,
    ...(result.rawMode === undefined ? {} : { rawMode: result.rawMode }),
    rows: result.rows,
    ...(input.hints === undefined ? {} : { familyHints: input.hints }),
  });
  if (summary.status === "none") {
    return summary.reason === "unknown-mode"
      ? { kind: "unknown-mode", text: teamPlanZh.unknownMode(summary.rawMode ?? "") }
      : { kind: "unavailable", text: teamPlanZh.loadFailed };
  }
  if (summary.total === 0) return { kind: "empty" };
  const groupsText = summary.groups
    .map((group) =>
      group.standby > 0
        ? teamPlanZh.groupWithStandby(group.label, group.count, group.standby)
        : teamPlanZh.group(group.label, group.count),
    )
    .join(" · ");
  const reasons = summary.unresolved.reasons
    .map((entry) => teamPlanZh.reasonCount(reasonLabel(entry.reason), entry.count))
    .join("、");
  return {
    kind: "summary",
    total: summary.total,
    groupsText,
    unresolvedText:
      summary.unresolved.count === 0
        ? null
        : teamPlanZh.unresolved(summary.unresolved.count, reasons),
    tone: summary.unresolved.count > 0 ? "warning" : "neutral",
  };
}

export type TeamBindingTarget =
  | { kind: "role"; roleId: string; profileId?: string }
  | { kind: "economy"; layer: "standard" | "allSeats"; route?: string };

export type TeamModelRowView = {
  key: string;
  rowKey: string;
  kind: "coordinator" | "member";
  roleId: string | null;
  roleName: string;
  instanceLabel: string | null;
  enabled: boolean;
  profileName: string | null;
  profileMeta: string | null;
  source: string;
  budget: string;
  availability: "available" | "unavailable" | "unverified";
  availabilityLabel: string;
  configuredNames: readonly string[];
  reasons: readonly string[];
  actions: readonly TeamBindingTarget[];
  standby: boolean;
  purposeLabel: string | null;
  activationLabel: string | null;
};

// Same table as the launch preview: a source is never re-worded for this page.
const SOURCE_LABELS: Readonly<Record<string, string>> = {
  "role-preferred": zh.modes.sourcePreferred,
  "role-fallback": zh.modes.sourceFallback,
  "economy-pool": zh.modes.sourceEconomyPool,
  unavailable: zh.modes.sourceUnavailable,
};

const AVAILABILITY_LABELS: Readonly<Record<TeamModelRowView["availability"], string>> = {
  available: teamPlanZh.availability.available,
  unavailable: teamPlanZh.availability.unavailable,
  unverified: teamPlanZh.availability.unverified,
};

const PURPOSE_LABELS: Readonly<Record<string, string>> = {
  member: teamPlanZh.purpose.member,
  candidate: teamPlanZh.purpose.candidate,
  judge: teamPlanZh.purpose.judge,
  escalation: teamPlanZh.purpose.escalation,
};

const ACTIVATION_LABELS: Readonly<Record<string, string>> = {
  eager: teamPlanZh.activation.eager,
  "on-demand": teamPlanZh.activation.onDemand,
  "escalation-only": teamPlanZh.activation.escalationOnly,
};

const POOL_CODES = /^MODE_(CHEAP|POOL)_/u;
const BINDING_REASONS: Readonly<Record<string, true>> = {
  unbound: true,
  "profile-missing": true,
  "provider-unavailable": true,
  unverified: true,
};

/**
 * The two entry points a problem row may offer. Pool/route problems never open the Role editor
 * alone; economy-all targets the all-seats layer and standard targets the standard pool.
 */
function rowActions(row: TeamPlanRow, mode: TeamPlanResult["effectiveMode"]): TeamBindingTarget[] {
  if (!row.enabled) return [];
  const actions: TeamBindingTarget[] = [];
  const poolIssue = row.issues.some((issue) => POOL_CODES.test(issue.code));
  const unresolved = row.profile === null ? unresolvedReasonOf(row) : null;
  const economyNeeded =
    poolIssue ||
    unresolved === "route-unavailable" ||
    unresolved === "no-cheap-profile" ||
    unresolved === "policy";
  if (economyNeeded) {
    const route = row.route === undefined ? null : AllSeatsRouteSchema.safeParse(row.route);
    actions.push({
      kind: "economy",
      layer: mode === "economy-all" || row.route !== undefined ? "allSeats" : "standard",
      ...(route?.success ? { route: route.data } : {}),
    });
  }
  const bindingProblem =
    row.issues.some(
      (issue) => issue.code === "MODE_PROFILE_UNRESOLVED" || issue.code === "MODE_ROLE_DISABLED",
    ) ||
    (unresolved !== null && BINDING_REASONS[unresolved] === true);
  if (row.roleId !== null && bindingProblem) {
    const profileId = row.profile?.id ?? row.configuredProfiles[0]?.id;
    actions.push({
      kind: "role",
      roleId: row.roleId,
      ...(profileId === undefined ? {} : { profileId }),
    });
  }
  return actions;
}

export function buildTeamModelRows(input: {
  result: TeamPlanResult;
  /** rowKey -> instance label, from the editor draft; the DTO does not carry it. */
  labels?: ReadonlyMap<string, string>;
}): TeamModelRowView[] {
  return input.result.rows.map((row, index) => {
    const profile = row.profile;
    return {
      key: `${row.rowKey}:${row.seatId ?? row.logicalSeatId ?? index}`,
      rowKey: row.rowKey,
      kind: row.kind,
      roleId: row.roleId,
      roleName: row.roleName,
      instanceLabel: input.labels?.get(row.rowKey) ?? null,
      enabled: row.enabled,
      profileName: profile?.name ?? null,
      profileMeta:
        profile === null
          ? null
          : `${profile.provider}${profile.model === undefined ? "" : `/${profile.model}`}`,
      source: SOURCE_LABELS[row.source] ?? row.source,
      budget: formatLaunchBudget(row.budget, row.budgetBasis),
      availability: row.availability,
      availabilityLabel: AVAILABILITY_LABELS[row.availability],
      configuredNames: row.configuredProfiles.map((entry) => entry.name),
      reasons:
        profile === null && row.issues.length === 0
          ? [reasonLabel(unresolvedReasonOf(row))]
          : [...new Set(row.issues.map(issueText))],
      actions: rowActions(row, input.result.effectiveMode),
      standby: row.activation === "escalation-only",
      purposeLabel: row.purpose === undefined ? null : (PURPOSE_LABELS[row.purpose] ?? null),
      activationLabel:
        row.activation === undefined ? null : (ACTIVATION_LABELS[row.activation] ?? null),
    };
  });
}

/** Result-level issues not attached to a single row (unknown mode, member limit, policy). */
export function buildTeamPlanIssues(
  result: TeamPlanResult,
): { text: string; severity: "warning" | "blocker" }[] {
  return result.issues.map((issue) => ({ text: issueText(issue), severity: issue.severity }));
}

export function draftRowKey(member: { seatId?: string }, index: number): string {
  return member.seatId ? `seat:${member.seatId}` : `member:${index}`;
}

export type DraftInputProblem = "duplicate-row-key" | "reserved-coordinator" | "too-many-members";

export function draftInputProblem(request: TeamPlanDraftRequest): DraftInputProblem | null {
  if (request.members.length > TEAM_PLAN_MAX_DRAFT_MEMBERS) return "too-many-members";
  const keys = new Set<string>();
  for (const member of request.members) {
    if (member.rowKey === "coordinator") return "reserved-coordinator";
    if (keys.has(member.rowKey)) return "duplicate-row-key";
    keys.add(member.rowKey);
  }
  return null;
}

function draftInput(request: TeamPlanDraftRequest, key: string): TeamPlanInput {
  return {
    items: [
      {
        key,
        kind: "draft",
        draft: {
          ...(request.mode === undefined ? {} : { mode: request.mode }),
          ...(request.coordinatorRoleId === undefined
            ? {}
            : { coordinatorRoleId: request.coordinatorRoleId }),
          ...(request.memberCreation === undefined
            ? {}
            : { memberCreation: request.memberCreation }),
          ...(request.collaboration === undefined ? {} : { collaboration: request.collaboration }),
          members: request.members.map((member) => ({
            rowKey: member.rowKey,
            ...(member.roleId === undefined ? {} : { roleId: member.roleId }),
            ...(member.instanceLabel === undefined ? {} : { instanceLabel: member.instanceLabel }),
            enabled: member.enabled,
          })),
        },
      },
    ],
  };
}

function savedInput(teams: readonly Team[]): TeamPlanInput {
  return { items: teams.map((team) => ({ key: team.id, kind: "saved", teamId: team.id })) };
}

export function isMethodNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return (
    lower.includes("method not found") ||
    lower.includes("unknown method") ||
    lower.includes("no such method") ||
    lower.includes("not registered") ||
    lower.includes("method_not_found") ||
    lower.includes("method-not-found")
  );
}

export function createTeamPlanClient(options: ClientOptions): TeamPlanClient {
  const now = options.now ?? (() => Date.now());
  const debounceMs = options.debounceMs ?? TEAM_PLAN_DEBOUNCE_MS;
  const ttlMs = options.ttlMs ?? TEAM_PLAN_CACHE_TTL_MS;
  const chunkSize = options.chunkSize ?? TEAM_PLAN_MAX_ITEMS;
  const maxConcurrent = options.maxConcurrent ?? TEAM_PLAN_MAX_CONCURRENT_CHUNKS;
  const schedule = options.schedule ?? ((run, ms) => setTimeout(run, ms));
  const cancel =
    options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let scope: TeamPlanScope | null = null;
  let scopeKey = "";
  let epoch = 0;
  let modeContract: ModeContractSupport = "unknown";
  let loaded = false;
  let checkedAt: string | null = null;
  let hasContext = false;
  let batchError: string | null = null;
  let batchRequest = 0;
  let running = 0;
  let pendingChunks: Array<{ request: number; items: TeamPlanInput["items"] }> = [];
  let pending = false;
  let pendingTotal = 0;
  let pendingDone = 0;
  let cacheKey: string | null = null;
  let inFlightKey: string | null = null;
  const results = new Map<string, TeamPlanResult>();
  const failedKeys = new Set<string>();
  const cache = new Map<
    string,
    {
      at: number;
      results: Map<string, TeamPlanResult>;
      checkedAt: string | null;
      hasContext: boolean;
    }
  >();
  let probedScope = "";
  const draftTimers = new Map<string, { handle: unknown }>();
  const draftSeq = new Map<string, number>();
  const draftScheduled = new Map<string, string>();
  const draftStates = new Map<string, TeamPlanDraftState>();
  const listeners = new Set<() => void>();
  const timers = new Set<{ handle: unknown }>();
  let destroyed = false;

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function setMode(support: ModeContractSupport): void {
    if (modeContract === support) return;
    modeContract = support;
    if (support === "legacy") {
      results.clear();
      failedKeys.clear();
      batchError = null;
    }
  }

  function applyOutput(output: TeamPlanOutput, request: number, keys: readonly string[]): void {
    if (request !== batchRequest || destroyed) return;
    checkedAt = output.checkedAt;
    hasContext = output.context !== null;
    setMode(
      modeContractSupport({
        kind: "capabilities",
        modeContract: output.capabilities.modeContract,
      }),
    );
    const seen = new Set<string>();
    for (const result of output.results) {
      results.set(result.key, result);
      seen.add(result.key);
    }
    for (const key of keys) {
      if (seen.has(key)) failedKeys.delete(key);
      else failedKeys.add(key);
    }
    loaded = true;
  }

  function applyCached(cached: {
    results: Map<string, TeamPlanResult>;
    checkedAt: string | null;
    hasContext: boolean;
  }): void {
    results.clear();
    failedKeys.clear();
    for (const [key, result] of cached.results) results.set(key, result);
    checkedAt = cached.checkedAt;
    hasContext = cached.hasContext;
    batchError = null;
    loaded = true;
  }

  function completeChunk(): void {
    pendingDone += 1;
    if (pendingDone < pendingTotal) return;
    pending = false;
    inFlightKey = null;
    if (batchError === null && failedKeys.size === 0 && cacheKey !== null) {
      cache.set(cacheKey, {
        at: now(),
        results: new Map(results),
        checkedAt,
        hasContext,
      });
    }
    cacheKey = null;
    notify();
  }

  function pump(): void {
    while (running < maxConcurrent && pendingChunks.length > 0) {
      const chunk = pendingChunks.shift();
      if (!chunk) break;
      running += 1;
      pending = true;
      const input: TeamPlanInput = { items: chunk.items };
      const keys = chunk.items.map((item) => item.key);
      const requestEpoch = epoch;
      void Promise.resolve()
        .then(() => options.send(input))
        .then(
          (output) => {
            if (requestEpoch !== epoch) return;
            applyOutput(output, chunk.request, keys);
          },
          (error: unknown) => {
            if (requestEpoch !== epoch) return;
            if (isMethodNotFound(error)) {
              setMode("legacy");
              loaded = true;
            } else {
              batchError = teamPlanZh.loadFailed;
              if (modeContract !== "v2") setMode("unknown");
              for (const key of keys) {
                results.delete(key);
                failedKeys.add(key);
              }
            }
          },
        )
        .finally(() => {
          running -= 1;
          if (chunk.request === batchRequest) completeChunk();
          pump();
        });
    }
    pending = running > 0 || pendingChunks.length > 0;
  }

  function clearDraft(sessionId: string): void {
    const timer = draftTimers.get(sessionId);
    if (timer) cancel(timer.handle);
    draftTimers.delete(sessionId);
    draftScheduled.delete(sessionId);
    draftStates.delete(sessionId);
  }

  return {
    setScope(next) {
      const nextKey = scopeSignature(next);
      if (nextKey === scopeKey) return;
      scope = next;
      scopeKey = nextKey;
      epoch += 1;
      results.clear();
      failedKeys.clear();
      cache.clear();
      batchError = null;
      pendingChunks = [];
      pending = false;
      pendingTotal = 0;
      pendingDone = 0;
      inFlightKey = null;
      checkedAt = null;
      hasContext = false;
      probedScope = "";
      for (const sessionId of new Set([...draftTimers.keys(), ...draftScheduled.keys()])) {
        clearDraft(sessionId);
      }
      notify();
    },

    planTeams(teams) {
      if (destroyed || scope === null || teams.length === 0) return;
      if (modeContract === "legacy") return;
      const input = savedInput(teams);
      const key = `${scopeKey}|${stableJson(input)}`;
      if (inFlightKey === key) return;
      const cached = cache.get(key);
      if (cached && now() - cached.at <= ttlMs) {
        applyCached(cached);
        notify();
        return;
      }
      batchRequest += 1;
      const request = batchRequest;
      results.clear();
      failedKeys.clear();
      batchError = null;
      pendingChunks = [];
      pendingTotal = 0;
      pendingDone = 0;
      const items = [...input.items];
      for (let index = 0; index < items.length; index += chunkSize) {
        pendingChunks.push({ request, items: items.slice(index, index + chunkSize) });
      }
      pendingTotal = pendingChunks.length;
      cacheKey = key;
      inFlightKey = key;
      pump();
      notify();
    },

    probe() {
      if (destroyed || scope === null || probedScope === scopeKey) return;
      probedScope = scopeKey;
      const requestEpoch = epoch;
      void Promise.resolve()
        .then(() => options.send({ items: [] }))
        .then(
          (output) => {
            if (requestEpoch !== epoch) return;
            setMode(
              modeContractSupport({
                kind: "capabilities",
                modeContract: output.capabilities.modeContract,
              }),
            );
            loaded = true;
            notify();
          },
          (error: unknown) => {
            if (requestEpoch !== epoch) return;
            if (isMethodNotFound(error)) {
              setMode("legacy");
            } else {
              setMode("unknown");
              batchError = teamPlanZh.loadFailed;
              // A failed transport is retryable; the next probe must be allowed to run.
              probedScope = "";
            }
            loaded = true;
            notify();
          },
        );
    },

    requestDraft(request) {
      if (destroyed || scope === null) return;
      const problem = draftInputProblem(request);
      const nextSeq = (draftSeq.get(request.sessionId) ?? 0) + 1;
      const requestKey = `${request.sessionId}:${nextSeq}`;
      if (problem !== null) {
        const pendingTimer = draftTimers.get(request.sessionId);
        if (pendingTimer) cancel(pendingTimer.handle);
        draftTimers.delete(request.sessionId);
        draftScheduled.delete(request.sessionId);
        draftStates.set(request.sessionId, {
          status: "error",
          key: requestKey,
          reason: "invalid",
          message:
            problem === "reserved-coordinator"
              ? teamPlanZh.reservedRowKey
              : problem === "duplicate-row-key"
                ? teamPlanZh.duplicateRowKey
                : teamPlanZh.tooManyMembers(TEAM_PLAN_MAX_DRAFT_MEMBERS),
        });
        notify();
        return;
      }
      const scheduled = stableJson({ ...request, sessionId: undefined });
      if (draftScheduled.get(request.sessionId) === scheduled) return;
      const previous = draftTimers.get(request.sessionId);
      if (previous) cancel(previous.handle);
      draftScheduled.set(request.sessionId, scheduled);
      draftSeq.set(request.sessionId, nextSeq);
      draftStates.set(request.sessionId, { status: "pending", key: requestKey });
      const requestEpoch = epoch;
      const timer = {
        handle: schedule(() => {
          timers.delete(timer);
          draftTimers.delete(request.sessionId);
          if (destroyed || epoch !== requestEpoch) return;
          const seq = draftSeq.get(request.sessionId);
          if (seq !== nextSeq) return;
          void Promise.resolve()
            .then(() => options.send(draftInput(request, requestKey)))
            .then(
              (output) => {
                if (destroyed || epoch !== requestEpoch) return;
                if (draftSeq.get(request.sessionId) !== nextSeq) return;
                const result = output.results[0];
                if (!result) {
                  draftStates.set(request.sessionId, {
                    status: "error",
                    key: requestKey,
                    reason: "failed",
                    message: teamPlanZh.loadFailed,
                  });
                } else {
                  draftStates.set(request.sessionId, {
                    status: "result",
                    key: requestKey,
                    result,
                  });
                  setMode(
                    modeContractSupport({
                      kind: "capabilities",
                      modeContract: output.capabilities.modeContract,
                    }),
                  );
                }
                notify();
              },
              (error: unknown) => {
                if (destroyed || epoch !== requestEpoch) return;
                if (isMethodNotFound(error)) {
                  setMode("legacy");
                  draftStates.set(request.sessionId, {
                    status: "error",
                    key: requestKey,
                    reason: "legacy",
                    message: teamPlanZh.legacyUnavailable,
                  });
                } else {
                  draftStates.set(request.sessionId, {
                    status: "error",
                    key: requestKey,
                    reason: "failed",
                    message: teamPlanZh.loadFailed,
                  });
                }
                notify();
              },
            );
        }, debounceMs),
      };
      timers.add(timer);
      draftTimers.set(request.sessionId, timer);
      notify();
    },

    getBatchView() {
      return {
        results: new Map(results),
        hasContext,
        failedKeys: new Set(failedKeys),
        modeContract,
        loaded,
        pending,
        error: batchError,
        checkedAt,
      };
    },

    getDraftState(sessionId) {
      return draftStates.get(sessionId) ?? { status: "idle" };
    },

    modeContract() {
      return modeContract;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    invalidate() {
      epoch += 1;
      results.clear();
      failedKeys.clear();
      cache.clear();
      batchError = null;
      pendingChunks = [];
      pending = false;
      pendingTotal = 0;
      pendingDone = 0;
      cacheKey = null;
      inFlightKey = null;
      checkedAt = null;
      hasContext = false;
      probedScope = "";
      for (const sessionId of new Set([...draftTimers.keys(), ...draftScheduled.keys()])) {
        clearDraft(sessionId);
      }
      notify();
    },

    destroy() {
      destroyed = true;
      epoch += 1;
      for (const timer of timers) cancel(timer.handle);
      timers.clear();
      draftTimers.clear();
      listeners.clear();
    },
  };
}

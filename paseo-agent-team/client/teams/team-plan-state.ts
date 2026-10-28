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
  type TeamPlanContext,
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
/** Maximum age of a visible plan/availability snapshot before an automatic refetch. */
export const TEAM_PLAN_REFRESH_MS = 60_000;
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
  /** The host whose scope produced this view; consumers must compare before trusting the contract. */
  scopeHostId?: string | null;
  results: ReadonlyMap<string, TeamPlanResult>;
  hasContext: boolean;
  context: TeamPlanContext | null;
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
  cancelDraft(sessionId: string): void;
  getBatchView(): TeamPlanBatchView;
  getDraftState(sessionId: string): TeamPlanDraftState;
  modeContract(): ModeContractSupport;
  subscribe(listener: () => void): () => void;
  /** Mark the tab visible/hidden: a visible tab refreshes at most every refreshMs. */
  setActive(active: boolean): void;
  /** Clear and immediately replan the last saved list (or probe an empty one). */
  refresh(): void;
  /** Refresh only if the last successful snapshot is older than refreshMs. */
  refreshIfStale(): void;
  /** Drop a cached capability and probe again (e.g. after a same-host daemon upgrade). */
  renegotiate(): void;
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
  refreshMs?: number;
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
      /** Pool/route remedies for the card itself; rows keep their own actions in the editor. */
      actions: readonly Extract<TeamBindingTarget, { kind: "economy" }>[];
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

/**
 * The card-level pool/route remedies. One per layer/route, in row order; a Team whose only
 * problems are Role bindings gets none (those stay on the row's "rebind" entry).
 */
export function economyActionsForResult(
  result: TeamPlanResult,
): Extract<TeamBindingTarget, { kind: "economy" }>[] {
  const seen = new Set<string>();
  const actions: Extract<TeamBindingTarget, { kind: "economy" }>[] = [];
  for (const row of result.rows) {
    for (const action of rowActions(row, result.effectiveMode)) {
      if (action.kind !== "economy") continue;
      const key = `${action.layer}:${action.route ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      actions.push(action);
    }
  }
  return actions;
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
    actions: economyActionsForResult(result),
    unresolvedText:
      summary.unresolved.count === 0
        ? null
        : teamPlanZh.unresolved(summary.unresolved.count, reasons),
    tone: summary.unresolved.count > 0 ? "warning" : "neutral",
  };
}

/** Global plan error is shown even with no cards; per-card failures cover a healthy v2 list. */
export function shouldShowPlanError(input: {
  modeContract: ModeContractSupport;
  error: string | null;
  summaryCount: number;
}): boolean {
  return (
    input.modeContract !== "legacy" &&
    input.error !== null &&
    (input.modeContract === "unknown" || input.summaryCount === 0)
  );
}

export function buildTeamSummaries(input: {
  results: ReadonlyMap<string, TeamPlanResult>;
  failedKeys: ReadonlySet<string>;
  hasContext: boolean;
  error: string | null;
  hints?: readonly ModelFamilyHint[];
}): Map<string, TeamSummaryView> {
  const built = new Map<string, TeamSummaryView>();
  for (const [key, result] of input.results) {
    built.set(
      key,
      buildTeamSummary({
        result,
        hasContext: input.hasContext,
        ...(input.hints === undefined ? {} : { hints: input.hints }),
      }),
    );
  }
  for (const key of input.failedKeys) {
    if (built.has(key)) continue;
    built.set(key, { kind: "unavailable", text: input.error ?? teamPlanZh.loadFailed });
  }
  return built;
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
  /** Why there is no runnable selection; null when a Profile is selected or the seat is disabled. */
  profileStatus: string | null;
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
function rowRoute(row: TeamPlanRow): string | undefined {
  if (row.route !== undefined) return row.route;
  for (const issue of row.issues) {
    const route = issue.params.route;
    if (typeof route === "string" && route !== "") return route;
  }
  return undefined;
}

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
  const routeValue = rowRoute(row);
  if (economyNeeded) {
    const route = routeValue === undefined ? null : AllSeatsRouteSchema.safeParse(routeValue);
    actions.push({
      kind: "economy",
      layer: mode === "economy-all" || routeValue !== undefined ? "allSeats" : "standard",
      ...(route?.success ? { route: route.data } : {}),
    });
  }
  // A cheap-route outage is never a Role-binding problem: only a real binding issue/fact may open
  // the Role editor, and a pool reason (provider unavailable etc.) must never add one implicitly.
  const explicitBinding = row.issues.some(
    (issue) => issue.code === "MODE_PROFILE_UNRESOLVED" || issue.code === "MODE_ROLE_DISABLED",
  );
  const bindingByFact = !poolIssue && unresolved !== null && BINDING_REASONS[unresolved] === true;
  if (row.roleId !== null && (explicitBinding || bindingByFact)) {
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
    const unbound =
      profile === null &&
      row.issues.some(
        (issue) =>
          issue.code === "MODE_PROFILE_UNRESOLVED" &&
          (issue.params.reason === "no-candidates" || issue.params.reason === "unbound"),
      );
    return {
      key: `${row.rowKey}:${row.seatId ?? row.logicalSeatId ?? index}`,
      rowKey: row.rowKey,
      kind: row.kind,
      roleId: row.roleId,
      roleName: row.roleName,
      instanceLabel: input.labels?.get(row.rowKey) ?? null,
      enabled: row.enabled,
      profileName: profile?.name ?? null,
      profileStatus:
        profile !== null || !row.enabled
          ? null
          : unbound
            ? teamPlanZh.noProfile
            : teamPlanZh.noSelection,
      profileMeta:
        profile === null
          ? null
          : `${profile.provider}${profile.model === undefined ? "" : `/${profile.model}`}`,
      source: Object.hasOwn(SOURCE_LABELS, row.source)
        ? (SOURCE_LABELS[row.source] as string)
        : row.source,
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

/** One meta line for a row: a blocked row still shows source/budget/availability. */
export function modelRowMeta(view: TeamModelRowView): string {
  return (
    view.profileName === null
      ? [view.source, view.budget, view.availabilityLabel]
      : [view.profileMeta, view.source, view.budget, view.availabilityLabel]
  )
    .filter((part): part is string => Boolean(part))
    .join(" · ");
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
  // A method-shaped phrase is required. A generic "RPC transport: unknown host" is a retryable
  // transport failure even though it mentions "rpc" and "unknown".
  if (
    /method[ _-]?not[ _-]?found|unknown method|no such method|method_not_found|method-not-found|procedure not found/u.test(
      lower,
    )
  ) {
    return true;
  }
  // Some hosts only include the method name plus a missing/absent phrase; still require both.
  return (
    lower.includes("team.plan") && /not found|not registered|not exist|unknown|no such/u.test(lower)
  );
}

/**
 * Mount/unmount lifecycle for a shared client. A StrictMode remount (detach immediately followed
 * by attach) cancels the pending destroy; only a real unmount reaches destroy. Detach stops the
 * refresh loop immediately, so a fast unmount never leaves a timer polling.
 */
/**
 * Host shims may report null/undefined/"unknown" before the app state is known; only background
 * and inactive mean "not visible". Everything else starts (and resumes) the visible refresh loop.
 */
/** A view from another host never exposes its contract; the consumer sees unknown until aligned. */
export function modeContractForHost(
  view: Pick<TeamPlanBatchView, "scopeHostId" | "modeContract">,
  hostId: string,
): ModeContractSupport {
  return view.scopeHostId === hostId ? view.modeContract : "unknown";
}

export function isAppStateActive(state: string | null | undefined): boolean {
  return state !== "background" && state !== "inactive";
}

export function createClientLifecycle(
  client: TeamPlanClient,
  options: {
    schedule?: (run: () => void, ms: number) => unknown;
    cancel?: (handle: unknown) => void;
  } = {},
): { attach: () => void; detach: () => void } {
  const schedule = options.schedule ?? ((run, ms) => setTimeout(run, ms));
  const cancel =
    options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let destroyTimer: { handle: unknown } | null = null;
  return {
    attach() {
      if (destroyTimer !== null) {
        cancel(destroyTimer.handle);
        destroyTimer = null;
      }
    },
    detach() {
      client.setActive(false);
      if (destroyTimer !== null) cancel(destroyTimer.handle);
      destroyTimer = {
        handle: schedule(() => {
          destroyTimer = null;
          client.destroy();
        }, 0),
      };
    },
  };
}

export function createTeamPlanClient(options: ClientOptions): TeamPlanClient {
  const now = options.now ?? (() => Date.now());
  const debounceMs = options.debounceMs ?? TEAM_PLAN_DEBOUNCE_MS;
  const ttlMs = options.ttlMs ?? TEAM_PLAN_CACHE_TTL_MS;
  const chunkSize = options.chunkSize ?? TEAM_PLAN_MAX_ITEMS;
  const maxConcurrent = options.maxConcurrent ?? TEAM_PLAN_MAX_CONCURRENT_CHUNKS;
  const refreshMs = options.refreshMs ?? TEAM_PLAN_REFRESH_MS;
  const schedule = options.schedule ?? ((run, ms) => setTimeout(run, ms));
  const cancel =
    options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let scope: TeamPlanScope | null = null;
  let scopeHostId: string | null = null;
  let scopeKey = "";
  let epoch = 0;
  let modeContract: ModeContractSupport = "unknown";
  let loaded = false;
  let checkedAt: string | null = null;
  let hasContext = false;
  let context: TeamPlanContext | null = null;
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
      context: TeamPlanContext | null;
    }
  >();
  let probedScope = "";
  let lastSavedTeams: readonly Team[] = [];
  let lastRefreshAt: number | null = null;
  let probeInFlight = false;
  let active = false;
  let refreshTimer: { handle: unknown } | null = null;
  const draftTimers = new Map<string, { handle: unknown }>();
  const draftSeq = new Map<string, number>();
  const draftScheduled = new Map<string, string>();
  const draftStates = new Map<string, TeamPlanDraftState>();
  const lastDraftRequests = new Map<string, TeamPlanDraftRequest>();
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
      // New-mode planning is hidden; never leave a draft error or an in-flight draft behind.
      for (const sessionId of new Set([
        ...lastDraftRequests.keys(),
        ...draftTimers.keys(),
        ...draftScheduled.keys(),
      ])) {
        clearDraftTimer(sessionId);
        lastDraftRequests.delete(sessionId);
        draftSeq.set(sessionId, (draftSeq.get(sessionId) ?? 0) + 1);
        draftStates.set(sessionId, { status: "idle" });
      }
    }
  }

  function applyOutput(output: TeamPlanOutput, request: number, keys: readonly string[]): void {
    if (request !== batchRequest || destroyed) return;
    checkedAt = output.checkedAt;
    hasContext = output.context !== null;
    const previous = context;
    context = output.context;
    if (
      previous !== null &&
      context !== null &&
      (previous.profilesFingerprint !== context.profilesFingerprint ||
        previous.availabilityFingerprint !== context.availabilityFingerprint ||
        previous.revisions.roles !== context.revisions.roles ||
        previous.revisions.teams !== context.revisions.teams ||
        previous.revisions.preferences !== context.revisions.preferences)
    ) {
      // A new host snapshot invalidates every cached plan, not only this batch.
      cache.clear();
    }
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
    context: TeamPlanContext | null;
  }): void {
    results.clear();
    failedKeys.clear();
    for (const [key, result] of cached.results) results.set(key, result);
    checkedAt = cached.checkedAt;
    hasContext = cached.hasContext;
    context = cached.context;
    batchError = null;
    loaded = true;
  }

  function completeChunk(): void {
    pendingDone += 1;
    if (pendingDone < pendingTotal) return;
    pending = false;
    inFlightKey = null;
    lastRefreshAt = now();
    if (batchError === null && failedKeys.size === 0 && cacheKey !== null) {
      cache.set(cacheKey, {
        at: now(),
        results: new Map(results),
        checkedAt,
        hasContext,
        context,
      });
    }
    cacheKey = null;
    notify();
  }

  function pump(): void {
    if (destroyed) return;
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
            if (requestEpoch !== epoch || chunk.request !== batchRequest) return;
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
          if (destroyed) return;
          if (chunk.request === batchRequest) completeChunk();
          pump();
        });
    }
    pending = running > 0 || pendingChunks.length > 0;
  }

  function clearDraftTimer(sessionId: string): void {
    const timer = draftTimers.get(sessionId);
    if (timer) cancel(timer.handle);
    draftTimers.delete(sessionId);
    draftScheduled.delete(sessionId);
  }

  function resetDraftSession(sessionId: string): void {
    clearDraftTimer(sessionId);
    draftStates.delete(sessionId);
  }

  function cancelDraftSession(sessionId: string): void {
    draftSeq.set(sessionId, (draftSeq.get(sessionId) ?? 0) + 1);
    resetDraftSession(sessionId);
    lastDraftRequests.delete(sessionId);
  }

  function clearRefresh(): void {
    if (refreshTimer) cancel(refreshTimer.handle);
    refreshTimer = null;
  }

  function scheduleRefresh(delayMs = refreshMs): void {
    clearRefresh();
    if (!active || destroyed) return;
    refreshTimer = {
      handle: schedule(() => {
        refreshTimer = null;
        if (!active || destroyed) return;
        if (pending || inFlightKey !== null || probeInFlight) {
          // A request is already in flight; the next tick will refresh after it settles.
          scheduleRefresh();
          return;
        }
        reload(false);
        scheduleRefresh();
      }, delayMs),
    };
  }

  function enqueueDraft(request: TeamPlanDraftRequest): void {
    if (destroyed || scope === null) return;
    if (modeContract === "legacy") {
      clearDraftTimer(request.sessionId);
      lastDraftRequests.delete(request.sessionId);
      draftStates.set(request.sessionId, { status: "idle" });
      notify();
      return;
    }
    const problem = draftInputProblem(request);
    const nextSeq = (draftSeq.get(request.sessionId) ?? 0) + 1;
    const requestKey = `${request.sessionId}:${nextSeq}`;
    if (problem !== null) {
      clearDraftTimer(request.sessionId);
      lastDraftRequests.delete(request.sessionId);
      draftSeq.set(request.sessionId, nextSeq);
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
    clearDraftTimer(request.sessionId);
    draftScheduled.set(request.sessionId, scheduled);
    draftSeq.set(request.sessionId, nextSeq);
    lastDraftRequests.set(request.sessionId, request);
    draftStates.set(request.sessionId, { status: "pending", key: requestKey });
    const requestEpoch = epoch;
    const timer = {
      handle: schedule(() => {
        timers.delete(timer);
        draftTimers.delete(request.sessionId);
        if (destroyed || epoch !== requestEpoch) return;
        if (draftSeq.get(request.sessionId) !== nextSeq) return;
        if (modeContract === "legacy") {
          draftStates.set(request.sessionId, { status: "idle" });
          notify();
          return;
        }
        void Promise.resolve()
          .then(() => options.send(draftInput(request, requestKey)))
          .then(
            (output) => {
              if (destroyed || epoch !== requestEpoch) return;
              if (draftSeq.get(request.sessionId) !== nextSeq) return;
              if (modeContract === "legacy") {
                draftStates.set(request.sessionId, { status: "idle" });
                notify();
                return;
              }
              const result = output.results[0];
              if (!result || result.key !== requestKey) {
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
              if (draftSeq.get(request.sessionId) !== nextSeq) return;
              if (isMethodNotFound(error)) {
                // The capability was discovered mid-flight: hide the new UI instead of showing a
                // planning error for a method this daemon does not have.
                setMode("legacy");
                draftStates.set(request.sessionId, { status: "idle" });
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
  }

  function rescheduleDrafts(): void {
    for (const request of lastDraftRequests.values()) {
      draftScheduled.delete(request.sessionId);
      enqueueDraft(request);
    }
  }

  function sendSaved(teams: readonly Team[]): void {
    lastSavedTeams = [...teams];
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
  }

  function sendProbe(): void {
    if (destroyed || scope === null || probedScope === scopeKey) return;
    probedScope = scopeKey;
    probeInFlight = true;
    const requestEpoch = epoch;
    void Promise.resolve()
      .then(() => options.send({ items: [] }))
      .then(
        (output) => {
          probeInFlight = false;
          if (requestEpoch !== epoch) return;
          setMode(
            modeContractSupport({
              kind: "capabilities",
              modeContract: output.capabilities.modeContract,
            }),
          );
          loaded = true;
          lastRefreshAt = now();
          notify();
        },
        (error: unknown) => {
          probeInFlight = false;
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
          lastRefreshAt = now();
          notify();
        },
      );
  }

  function reload(renegotiateSupport: boolean): void {
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
    context = null;
    probedScope = "";
    probeInFlight = false;
    if (renegotiateSupport) {
      modeContract = "unknown";
      loaded = false;
    }
    for (const sessionId of new Set([...draftTimers.keys(), ...draftScheduled.keys()])) {
      resetDraftSession(sessionId);
    }
    if (lastSavedTeams.length === 0) {
      if (modeContract === "unknown") sendProbe();
    } else {
      sendSaved(lastSavedTeams);
    }
    rescheduleDrafts();
    notify();
  }

  return {
    setScope(next) {
      const nextKey = scopeSignature(next);
      if (nextKey === scopeKey) return;
      const hostChanged = scope !== null && scope.hostId !== next.hostId;
      scope = next;
      scopeHostId = next.hostId;
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
      context = null;
      probedScope = "";
      probeInFlight = false;
      lastRefreshAt = null;
      if (hostChanged) {
        modeContract = "unknown";
        loaded = false;
        lastSavedTeams = [];
        for (const sessionId of new Set([...lastDraftRequests.keys(), ...draftSeq.keys()])) {
          cancelDraftSession(sessionId);
        }
      } else {
        for (const sessionId of new Set([...draftTimers.keys(), ...draftScheduled.keys()])) {
          resetDraftSession(sessionId);
        }
        rescheduleDrafts();
      }
      notify();
    },

    planTeams(teams) {
      sendSaved(teams);
    },

    probe() {
      sendProbe();
    },

    requestDraft(request) {
      enqueueDraft(request);
    },

    cancelDraft(sessionId) {
      cancelDraftSession(sessionId);
      notify();
    },

    getBatchView() {
      return {
        scopeHostId,
        results: new Map(results),
        hasContext,
        context,
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

    setActive(next) {
      if (active === next) return;
      active = next;
      if (active) {
        const stale = lastRefreshAt !== null && now() - lastRefreshAt >= refreshMs;
        if (stale) reload(false);
        scheduleRefresh(
          stale || lastRefreshAt === null
            ? refreshMs
            : Math.max(0, refreshMs - (now() - lastRefreshAt)),
        );
      } else {
        clearRefresh();
      }
    },

    refresh() {
      reload(false);
      scheduleRefresh();
    },

    refreshIfStale() {
      if (pending || inFlightKey !== null || probeInFlight) return;
      if (lastRefreshAt === null || now() - lastRefreshAt >= refreshMs) {
        reload(false);
        scheduleRefresh();
      }
    },

    renegotiate() {
      reload(true);
      scheduleRefresh();
    },

    invalidate() {
      reload(false);
      scheduleRefresh();
    },

    destroy() {
      destroyed = true;
      active = false;
      clearRefresh();
      epoch += 1;
      batchRequest += 1;
      pendingChunks = [];
      pending = false;
      pendingTotal = 0;
      pendingDone = 0;
      cacheKey = null;
      inFlightKey = null;
      probeInFlight = false;
      for (const timer of timers) cancel(timer.handle);
      timers.clear();
      draftTimers.clear();
      listeners.clear();
    },
  };
}

import { canonicalDesignContent } from "../../shared/domain/design-content";
import { planDesignCompensation, verifySavedDesign } from "../../shared/domain/design-merge";
import { extractDesignOutput } from "../../shared/domain/design-output";
import {
  type DesignPlanningPort,
  designContractVersionForNewJob,
  designModeAccess,
  normalizeExistingRolesOnly,
} from "../../shared/domain/design-planning";
import {
  allocateDesignTeamId,
  type DesignValidationContext,
  finalizeDesignIssues,
  materializeDesign,
  roleGapFinalIssue,
  validateDesign,
  validateMaterializedDesign,
  validateRoleGap,
} from "../../shared/domain/design-validation";
import { isTeamMode, requestContractVersion } from "../../shared/domain/mode-contract";
import { type EconomyPolicy, normalizeEconomyPolicy } from "../../shared/domain/mode-resolver";
import type { PaseoProfile } from "../../shared/paseo/adapter";
import {
  buildDesignLabels,
  toDiscoveryPort,
  toTimelinePort,
} from "../../shared/paseo/design-bridge";
import {
  type CreateDesignAgentInput,
  DESIGN_LABEL_KEYS,
  type DesignAdapter,
} from "../../shared/paseo/design-port";
import type {
  DesignCancelInput,
  DesignContinueInput,
  DesignGapRetry,
  DesignIssue,
  DesignJob,
  DesignMarkSavedInput,
  DesignPrepareSaveInput,
  DesignResult,
  DesignResultInput,
  DesignSaveFailedInput,
  DesignStartInput,
  DesignStatusInput,
  DesignTeamProposal,
  RoleGapReport,
} from "../../shared/schemas/design";
import { DesignGapRetrySchema, DesignResultSchema } from "../../shared/schemas/design";
import type { Preferences } from "../../shared/schemas/preferences";
import { ProfileRefSchema } from "../../shared/schemas/profile-ref";
import {
  type DesignContract,
  legacyModeIssue,
  modeVisibleTo,
  projectJobForContract,
  projectResultForContract,
  projectStatusForContract,
  withoutGapRetry,
} from "./compat";
import {
  type DesignContextCapabilities,
  type DesignContextSnapshot,
  type DesignSettingsReaders,
  readDesignContext,
} from "./context";
import { bindDesignerProfile, DESIGNER_SYSTEM_PROMPT } from "./definition";
import { checkGapEconomyEligibility } from "./planning";
import {
  buildDesignCorrection,
  buildDesignKickoff,
  type DesignPromptContext,
  type ExpectedDesignChoice,
  summarizeProfiles,
} from "./prompt";
import { permissionSummary, reconcileDesignJob } from "./recovery";
import {
  DESIGN_RECORD_VERSION,
  type DesignAttemptRecord,
  type DesignJobStore,
  type StoredDesignJob,
} from "./store";

const DESIGN_ACTIVE = new Set([
  "starting",
  "designing",
  "validating",
  "fixing",
  "ready",
  "saving",
  "needs_continue",
  "save_conflict",
  "canceling",
]);
const TERMINAL = new Set(["saved", "failed", "canceled"]);
const RECONCILE_STATES = new Set(["designing", "fixing"]);
const LEASE_MS = 120_000;
const PENDING_SEND_TIMEOUT_MS = 30_000;
const MAX_ISSUE_REASON_CHARS = 1000;
const MAX_LISTED_PROFILES = 12;

export type DesignServiceDeps = {
  store: DesignJobStore;
  readers: DesignSettingsReaders;
  getAdapter: () => DesignAdapter | null;
  planner: DesignPlanningPort;
  clock: { now(): string };
  ids: { next(): string };
  hasher: (content: string) => string;
  capabilities: DesignContextCapabilities;
  log?: (message: string, cause?: unknown) => void;
};

export type DesignTurnEndedEvent = {
  agent: { id: string; labels?: Record<string, string> };
  turnId?: string | null;
  outcome?: { kind: "completed" | "failed" | "canceled"; error?: unknown; reason?: unknown };
};

function failure(
  issues: readonly DesignIssue[],
  job: DesignJob | null = null,
): { ok: false; issues: DesignIssue[]; issuesTruncated: number; job: DesignJob | null } {
  const finalized = finalizeDesignIssues(issues);
  return { ok: false, issues: finalized.issues, issuesTruncated: finalized.issuesTruncated, job };
}

function error(
  code: DesignIssue["code"],
  path: DesignIssue["path"] = [],
  params: DesignIssue["params"] = {},
  action: DesignIssue["action"] = "repair",
): DesignIssue {
  return { code, severity: "error", path, params, action };
}

function active(job: DesignJob): boolean {
  return DESIGN_ACTIVE.has(job.state);
}

function needsReconcile(record: StoredDesignJob): boolean {
  const job = record.job;
  return (
    job.state === "starting" ||
    job.state === "canceling" ||
    RECONCILE_STATES.has(job.state) ||
    (job.state === "needs_continue" && !job.agentCreated && record.creation !== null)
  );
}

function allowedFor(state: DesignJob["state"]): DesignJob["allowed"] {
  const cancel = [
    "starting",
    "designing",
    "validating",
    "fixing",
    "ready",
    "saving",
    "needs_continue",
    "save_conflict",
    "canceling",
  ].includes(state);
  return {
    cancel,
    save: state === "ready" || state === "save_conflict",
    launch: state === "saved",
    continueAction: state === "needs_continue" ? "repair" : null,
  };
}

function profileSummary(profile: PaseoProfile) {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    ...(profile.model !== undefined ? { model: profile.model } : {}),
    ...(profile.modeId !== undefined ? { modeId: profile.modeId } : {}),
    ...(profile.thinkingOptionId !== undefined
      ? { thinkingOptionId: profile.thinkingOptionId }
      : {}),
  };
}

function nonceOf(ids: { next(): string }): string {
  return ids.next().replace(/-/gu, "").slice(0, 32);
}

function designAttempt(value: number): 1 | 2 | 3 {
  return value === 1 ? 1 : value === 2 ? 2 : 3;
}

function hashPayload(hasher: (content: string) => string, value: unknown): string {
  return hasher(canonicalDesignContent(value));
}

type LeaseOwnerPair = { clientId: string; leaseId: string };

function parseLeaseOwner(value: string | null): LeaseOwnerPair | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    if (!("clientId" in parsed) || !("leaseId" in parsed)) return null;
    return typeof parsed.clientId === "string" && typeof parsed.leaseId === "string"
      ? { clientId: parsed.clientId, leaseId: parsed.leaseId }
      : null;
  } catch {
    return null;
  }
}

function encodeLeaseOwner(clientId: string, leaseId: string): string {
  return JSON.stringify({ clientId, leaseId });
}

function excerpt(value: string, max: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  const points = Array.from(line);
  return points.length <= max
    ? line
    : `${points
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`;
}

function sendTimeOf(attempt: DesignAttemptRecord | undefined): number | null {
  if (!attempt?.sentAt) return null;
  const parsed = Date.parse(attempt.sentAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function profileResolutionIssue(issue: DesignIssue): boolean {
  return (
    issue.code === "DESIGN_MODE_PLAN_INVALID" && issue.params.modeCode === "MODE_PROFILE_UNRESOLVED"
  );
}

function boundedReason(prefix: string, entries: readonly string[], suffix: string): string {
  const listed: string[] = [];
  for (const entry of entries) {
    if (listed.length >= MAX_LISTED_PROFILES) break;
    const candidate = `${prefix}${[...listed, entry].join("；")}`;
    if (candidate.length > MAX_ISSUE_REASON_CHARS - suffix.length - 8) break;
    listed.push(entry);
  }
  const omitted = entries.length - listed.length;
  const raw = `${prefix}${listed.join("；")}${omitted > 0 ? `；另有 ${omitted} 个` : ""}${suffix}`;
  return raw.length <= MAX_ISSUE_REASON_CHARS
    ? raw
    : `${raw.slice(0, MAX_ISSUE_REASON_CHARS - 1)}…`;
}

function roleWrittenByJob(
  record: StoredDesignJob,
  roles: readonly { id: string; source?: string; designer?: unknown }[],
): boolean {
  if (!record.result) return false;
  return record.result.newRoles.some((candidate) =>
    roles.some((role) => {
      if (role.id !== candidate.id || role.source !== "team-designer") return false;
      const designer = role.designer;
      return (
        !!designer &&
        typeof designer === "object" &&
        "jobId" in designer &&
        designer.jobId === record.job.jobId
      );
    }),
  );
}

function uncertainCreate(cause: unknown): boolean {
  const text =
    cause instanceof Error
      ? `${cause.name} ${cause.message}`
      : typeof cause === "string"
        ? cause
        : JSON.stringify(cause);
  return text.includes("request_key_conflict") || text.includes("request_outcome_unknown");
}

function issueFromStore(errorValue: unknown): DesignIssue {
  if (errorValue && typeof errorValue === "object" && "issue" in errorValue) {
    const issue = errorValue.issue;
    if (issue === "corrupt")
      return error("DESIGN_SETTINGS_INVALID", [], { reason: "ledger-corrupt" }, "inspect");
    if (issue === "too-large")
      return error("DESIGN_OUTPUT_TOO_LARGE", [], { reason: "ledger" }, "none");
  }
  return error("DESIGN_STORAGE_UNAVAILABLE", [], { reason: "ledger" }, "refresh");
}

function savedDesignerProfileId(preferences: Preferences): string | undefined {
  if (!("designerProfile" in preferences)) return undefined;
  const parsed = ProfileRefSchema.safeParse(preferences.designerProfile);
  return parsed.success ? parsed.data.profileId : undefined;
}

function chooseDesignerProfile(
  input: DesignStartInput,
  context: DesignContextSnapshot,
): { ok: true; profile: PaseoProfile } | { ok: false; issues: DesignIssue[] } {
  const unavailable = (profileId: string) =>
    error("DESIGN_PROFILE_UNAVAILABLE", ["profile"], { profileId }, "choose-profile");
  const available = (profile: PaseoProfile) =>
    context.availability.find((entry) => entry.provider === profile.provider)?.available === true;
  if (input.profileId) {
    const profile = context.profiles.find((item) => item.id === input.profileId);
    return profile && available(profile)
      ? { ok: true, profile }
      : { ok: false, issues: [unavailable(input.profileId)] };
  }
  if (!input.useDefaultProfileHints) {
    const saved = savedDesignerProfileId(context.preferences);
    if (saved) {
      const profile = context.profiles.find((item) => item.id === saved);
      return profile && available(profile)
        ? { ok: true, profile }
        : { ok: false, issues: [unavailable(saved)] };
    }
  }
  const binding = bindDesignerProfile(context.profiles);
  for (const ref of [...binding.preferredProfiles, ...binding.fallbackProfiles]) {
    const profile = context.profiles.find((item) => item.id === ref.profileId);
    if (profile && available(profile)) return { ok: true, profile };
  }
  return {
    ok: false,
    issues: [error("DESIGN_PROFILE_UNAVAILABLE", ["profile"], {}, "choose-profile")],
  };
}

function economyOf(context: DesignContextSnapshot): EconomyPolicy {
  const normalized = normalizeEconomyPolicy(context.preferences.economy, context.profiles);
  return normalized.ok ? normalized.value : { pool: [], taskOrder: {}, profileBudget: {} };
}

function promptContext(
  record: StoredDesignJob,
  context: DesignContextSnapshot,
  expectedChoices: readonly ExpectedDesignChoice[] = [],
): DesignPromptContext {
  const economy = economyOf(context);
  const roles = context.roles.map((role) => {
    // Two separate planner verdicts: a Role can launch as a member and fail as coordinator, so
    // neither is ever derived from the other. A Role the tables do not know is "cannot launch,
    // unverified", never "launchable".
    const launch = context.roleLaunchTables.member[role.id] ?? {
      launchable: false,
      unavailableProfileIds: [],
      verified: false,
    };
    const coordinatorLaunch = context.roleLaunchTables.coordinator[role.id] ?? {
      launchable: false,
      unavailableProfileIds: [],
      verified: false,
    };
    return {
      id: role.id,
      name: role.name,
      enabled: role.enabled,
      mission: role.mission,
      responsibilities: role.responsibilities,
      preferredProfileIds: role.preferredProfiles.map((ref) => ref.profileId),
      fallbackProfileIds: role.fallbackProfiles.map((ref) => ref.profileId),
      launchable: launch.launchable,
      unavailableProfileIds: launch.unavailableProfileIds,
      coordinatorLaunchable: coordinatorLaunch.launchable,
      launchVerified: launch.verified,
      coordinatorLaunchVerified: coordinatorLaunch.verified,
      ...(typeof role.executionPolicy?.tier === "string" &&
      typeof role.executionPolicy.taskKind === "string"
        ? { tier: role.executionPolicy.tier, taskKind: role.executionPolicy.taskKind }
        : {}),
    };
  });
  return {
    request: record.request,
    requestedMode: record.mode,
    runtimeCapabilities: context.capabilities,
    maxMembers: Math.min(context.preferences.maxMembers, 64),
    target: context.targetWorkspace
      ? {
          id: context.targetWorkspace.id,
          name: context.targetWorkspace.name,
          path: context.targetWorkspace.directory,
        }
      : null,
    carrierWorkspaceId: context.carrierWorkspaceId,
    roles,
    profiles: summarizeProfiles(context.profiles, context.availability, economy),
    economy: { pool: economy.pool, taskOrder: economy.taskOrder },
    occupiedRoleIds: context.roles.map((role) => role.id),
    occupiedRoleNames: context.roles.map((role) => role.name),
    occupiedTeams: context.teams.map((team) => ({ id: team.id, name: team.name })),
    expectedChoices,
    // The record's own contract and rule, passed as stored: a version 1 record is (1, false) and
    // must never go through the default for new requests (that would flip it to "on").
    outputContractVersion: record.outputContractVersion,
    existingRolesOnly: record.existingRolesOnly,
    // economy-all route evidence, copied from the snapshot and never recomputed here.
    ...(context.modeRouting === undefined ? {} : { modeRouting: context.modeRouting }),
  };
}

function validationContext(
  record: StoredDesignJob,
  context: DesignContextSnapshot,
  attempt: 1 | 2 | 3,
  hasher: (content: string) => string,
): DesignValidationContext {
  const attemptRecord = record.attempts.find((item) => item.attempt === attempt);
  return {
    request: record.request,
    mode: record.mode,
    jobId: record.job.jobId,
    attempt,
    nonce: attemptRecord?.nonce ?? "",
    roles: context.roles,
    teams: context.teams,
    preferences: context.preferences,
    host: { status: "ready", profiles: context.profiles, availability: context.availability },
    daemonConfig: context.daemonConfig,
    carrierWorkspaceId: context.carrierWorkspaceId,
    targetWorkspaceId: context.targetWorkspaceId,
    capabilities: context.capabilities,
    hasher,
    // Per-use verdicts from the same planner; `unlaunchable-role` is judged by the use it names.
    roleLaunch: context.roleLaunchTables,
  };
}

/**
 * The rules a record validates under, derived from the record and nothing else. Every shared
 * validator that takes `rules` gets this object (validateMaterializedDesign would otherwise fall
 * back to the legacy limit of 3), so initial validation, re-materialization, save re-validation,
 * recheck, and gap validation cannot disagree.
 */
function validationRules(record: StoredDesignJob): { existingRolesOnly: boolean } {
  return { existingRolesOnly: record.existingRolesOnly };
}

/**
 * The retry seed of a Role-gap job, read from the record: its request text and the Profile intent
 * of its selection. Anything that does not parse or fit the bounds yields no seed (the client then
 * asks the user to re-enter the request); it is never guessed or truncated.
 */
function gapRetryOf(record: StoredDesignJob): DesignGapRetry | undefined {
  if (record.roleGap === null) return undefined;
  let intent: unknown;
  try {
    intent = JSON.parse(record.selectionIntent ?? "");
  } catch {
    return undefined;
  }
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return undefined;
  const source = intent as Record<string, unknown>;
  // A present field must already have the contract's type. Explicitly bad data omits the whole
  // seed; only a field the historical shape may omit falls back to its default.
  if ("profileId" in source && source.profileId !== null && typeof source.profileId !== "string") {
    return undefined;
  }
  if ("useDefaultProfileHints" in source && typeof source.useDefaultProfileHints !== "boolean") {
    return undefined;
  }
  const parsed = DesignGapRetrySchema.safeParse({
    request: record.request,
    profileId: source.profileId ?? null,
    useDefaultProfileHints: source.useDefaultProfileHints ?? false,
  });
  return parsed.success ? parsed.data : undefined;
}

function identityFor(
  record: StoredDesignJob,
  proposal: DesignTeamProposal,
  context: DesignContextSnapshot,
) {
  const allocated = allocateDesignTeamId(
    proposal.team.id,
    new Set(context.teams.map((team) => team.id)),
  );
  if (!allocated.ok) return allocated;
  const logicalSeatIds = Object.fromEntries(
    proposal.team.members.map((member) => [member.key, `seat-${record.job.jobId}-${member.key}`]),
  );
  return {
    ok: true as const,
    identity: { teamId: allocated.value, createdAt: record.job.createdAt, logicalSeatIds },
    warnings: allocated.issues,
  };
}

function expectedChoicesFromMismatches(
  proposal: DesignTeamProposal | null,
  mismatches: readonly { target: string; expectedProfileIds: string[]; reason: string }[],
): ExpectedDesignChoice[] {
  if (!proposal) return [];
  const team = proposal.team;
  return mismatches
    .filter((mismatch) => mismatch.reason === "mismatch")
    .flatMap((mismatch) => {
      const roleId =
        mismatch.target === "coordinator"
          ? team.coordinatorRoleId
          : team.members.find((member) => member.key === mismatch.target)?.roleId;
      return roleId
        ? [{ target: mismatch.target, roleId, expectedProfileIds: mismatch.expectedProfileIds }]
        : [];
    });
}

function startInputFromRecord(record: StoredDesignJob): DesignStartInput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.selectionIntent ?? "");
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const workspaceId = "workspaceId" in parsed ? parsed.workspaceId : undefined;
  const profileId = "profileId" in parsed ? parsed.profileId : undefined;
  const useDefaultProfileHints =
    "useDefaultProfileHints" in parsed ? parsed.useDefaultProfileHints : undefined;
  return {
    clientRequestId: record.job.clientRequestId,
    request: record.request,
    mode: record.mode,
    ...(typeof workspaceId === "string" ? { workspaceId } : {}),
    ...(typeof profileId === "string" ? { profileId } : {}),
    ...(typeof useDefaultProfileHints === "boolean" ? { useDefaultProfileHints } : {}),
    // The record's own rule, never the default for new requests: a legacy record stays false.
    existingRolesOnly: record.existingRolesOnly,
  };
}

/**
 * The one answer to "this clientRequestId already has a job", shared by the normal path and the
 * create-raced path (so the two cannot drift). A version-2 record is compared by its v2 hash only.
 * A version-1 record (created before the rule existed) is compared by its original payload hash
 * and only when the caller omits the rule or sends false — what it meant when it was created; an
 * explicit true is a different request. The new default (true) never reinterprets an old record.
 */
function resolveExistingRequest(
  existing: StoredDesignJob,
  input: DesignStartInput,
  v2Hash: string,
  base: Record<string, unknown>,
  hasher: (content: string) => string,
) {
  const conflict = failure(
    [
      error(
        "DESIGN_REQUEST_CONFLICT",
        ["clientRequestId"],
        { clientRequestId: input.clientRequestId },
        "inspect",
      ),
    ],
    existing.job,
  );
  if (existing.requestHashVersion === 2) {
    return existing.requestHash === v2Hash ? { ok: true as const, job: existing.job } : conflict;
  }
  if (input.existingRolesOnly === true) return conflict;
  return existing.requestHash === hashPayload(hasher, base)
    ? { ok: true as const, job: existing.job }
    : conflict;
}

export function createDesignService(deps: DesignServiceDeps) {
  const scopeId = deps.ids.next();
  const queues = new Map<string, Promise<unknown>>();
  const pending = new Set<string>();
  const observed = new Set<string>();
  const creating = new Set<string>();
  let admission: Promise<unknown> = Promise.resolve();
  let disposed = false;
  const log = deps.log ?? (() => {});

  function enqueue<T>(jobId: string, task: () => Promise<T>, coalesce = true): Promise<T> {
    if (coalesce) {
      if (pending.has(jobId)) return Promise.resolve(undefined as T);
      pending.add(jobId);
    }
    const previous = queues.get(jobId) ?? Promise.resolve();
    const run = previous.then(task, task);
    queues.set(
      jobId,
      run.catch(() => undefined),
    );
    return coalesce
      ? run.finally(() => {
          pending.delete(jobId);
        })
      : run;
  }

  function withAdmission<T>(task: () => Promise<T>): Promise<T> {
    const run = admission.then(task, task);
    admission = run.catch(() => undefined);
    return run;
  }

  async function requireAdapter(): Promise<DesignAdapter | null> {
    return deps.getAdapter();
  }

  async function readContext(
    record: StoredDesignJob,
  ): Promise<{ ok: true; context: DesignContextSnapshot } | { ok: false; issues: DesignIssue[] }> {
    const adapter = await requireAdapter();
    if (!adapter)
      return {
        ok: false,
        issues: [error("DESIGN_CONFIG_UNAVAILABLE", [], { source: "adapter" }, "refresh")],
      };
    const result = await readDesignContext(
      {
        jobId: record.job.jobId,
        mode: record.mode,
        carrierWorkspaceId: record.job.carrierWorkspaceId,
        targetWorkspaceId: record.job.targetWorkspaceId,
      },
      deps.readers,
      adapter,
      deps.capabilities,
    );
    return result.ok ? { ok: true, context: result.context } : { ok: false, issues: result.issues };
  }

  async function updateRecord(
    jobId: string,
    mutate: (record: StoredDesignJob) => StoredDesignJob,
  ): Promise<StoredDesignJob> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await deps.store.get(jobId);
      if (!current) throw new Error("design job missing");
      const next = mutate(structuredClone(current));
      if (next.creation?.request && (next.job.agentCreated || TERMINAL.has(next.job.state))) {
        next.creation = { ...next.creation, request: null };
      }
      next.job.stateRevision = deps.ids.next();
      next.job.updatedAt = deps.clock.now();
      try {
        await deps.store.update(jobId, current.job.stateRevision, next);
        return next;
      } catch (cause) {
        if (!(cause && typeof cause === "object" && "issue" in cause && cause.issue === "conflict"))
          throw cause;
      }
    }
    throw new Error("design job revision conflict");
  }

  /**
   * CAS update that re-checks the freshly read record first: when `proceed` says no (the job was
   * canceled or reached a terminal state meanwhile) nothing is written and null is returned.
   */
  async function updateRecordIf(
    jobId: string,
    proceed: (record: StoredDesignJob) => boolean,
    mutate: (record: StoredDesignJob) => StoredDesignJob,
  ): Promise<StoredDesignJob | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await deps.store.get(jobId);
      if (!current || !proceed(current)) return null;
      const next = mutate(structuredClone(current));
      if (next.creation?.request && (next.job.agentCreated || TERMINAL.has(next.job.state))) {
        next.creation = { ...next.creation, request: null };
      }
      next.job.stateRevision = deps.ids.next();
      next.job.updatedAt = deps.clock.now();
      try {
        await deps.store.update(jobId, current.job.stateRevision, next);
        return next;
      } catch (cause) {
        if (!(cause && typeof cause === "object" && "issue" in cause && cause.issue === "conflict"))
          throw cause;
      }
    }
    throw new Error("design job revision conflict");
  }

  async function failJob(
    jobId: string,
    issues: readonly DesignIssue[],
    state: "failed" | "needs_continue" = "failed",
  ) {
    const finalized = finalizeDesignIssues(issues);
    return updateRecord(jobId, (record) => ({
      ...record,
      job: {
        ...record.job,
        state,
        issues: finalized.issues,
        issuesTruncated: finalized.issuesTruncated,
        ...(state === "failed" ? { finishedAt: deps.clock.now() } : {}),
        allowed: allowedFor(state),
      },
    }));
  }

  /**
   * Terminal state of a design that reported a gap in the existing Roles: failed, with the
   * server-verified gaps and no result (nothing to save, compensate, or launch). One CAS; it is
   * re-checked against cancellation and terminal states at write time, and a repeated hook or
   * status replay cannot write it twice (a terminal job is never touched again).
   */
  async function finishWithRoleGap(
    jobId: string,
    attempt: 1 | 2 | 3,
    reported: readonly RoleGapReport[],
  ) {
    const gaps = [...reported];
    const issue = roleGapFinalIssue(gaps);
    const finalized = finalizeDesignIssues([issue]);
    await updateRecordIf(
      jobId,
      (current) =>
        RECONCILE_STATES.has(current.job.state) &&
        !current.job.cancelRequested &&
        current.existingRolesOnly &&
        current.outputContractVersion === 2 &&
        current.roleGap === null,
      (current) => ({
        ...current,
        proposal: null,
        result: null,
        roleGap: gaps,
        job: {
          ...current.job,
          state: "failed",
          attempt,
          finishedAt: deps.clock.now(),
          resultId: null,
          saveState: "none",
          saveLeaseExpiresAt: null,
          issues: finalized.issues,
          issuesTruncated: finalized.issuesTruncated,
          roleGap: gaps,
          allowed: allowedFor("failed"),
        },
      }),
    );
  }

  async function processCandidate(
    record: StoredDesignJob,
    attemptText: string,
    attempt: 1 | 2 | 3,
    allowCorrection: boolean,
  ) {
    const contextResult = await readContext(record);
    if (!contextResult.ok) {
      await failJob(record.job.jobId, contextResult.issues, "needs_continue");
      return;
    }
    const context = contextResult.context;
    const extracted = extractDesignOutput({
      text: attemptText,
      jobId: record.job.jobId,
      attempt,
      nonce: record.attempts.find((item) => item.attempt === attempt)?.nonce ?? "",
      // The record picks the decoder; a legacy job keeps reading the v1 shape on a new build.
      outputContractVersion: record.outputContractVersion,
    });
    if (!extracted.ok) {
      await handleFailure(record, context, extracted.issues, null, null, allowCorrection);
      return;
    }
    if (extracted.kind === "role-gap") {
      const gapValidation = validateRoleGap(
        extracted.gap,
        validationContext(record, context, attempt, deps.hasher),
        validationRules(record),
      );
      if (!gapValidation.ok) {
        await handleFailure(
          record,
          context,
          gapValidation.issues,
          null,
          null,
          allowCorrection,
          "role-gap",
        );
        return;
      }
      // economy-all: a suggested Profile must be a cheap candidate of the route its own use and
      // tier pick. An issue is a correction round (same budget of 3), not a terminal state.
      const eligibility = extracted.gap.gaps.flatMap((gap, index) =>
        checkGapEconomyEligibility({
          mode: record.mode,
          gap,
          routing: context.modeRouting,
          path: ["gaps", index],
        }),
      );
      if (eligibility.length > 0) {
        await handleFailure(record, context, eligibility, null, null, allowCorrection, "role-gap");
        return;
      }
      await finishWithRoleGap(record.job.jobId, attempt, gapValidation.value.gaps);
      return;
    }
    const proposal = extracted.proposal;
    const identityResult = identityFor(record, proposal, context);
    if (!identityResult.ok) {
      await handleFailure(
        record,
        context,
        identityResult.issues,
        proposal,
        null,
        allowCorrection,
        "team",
      );
      return;
    }
    const validation = validateDesign(
      proposal,
      validationContext(record, context, attempt, deps.hasher),
      deps.planner,
      identityResult.identity,
      validationRules(record),
    );
    if (!validation.ok) {
      await handleFailure(
        record,
        context,
        validation.issues,
        proposal,
        validation.choiceMismatches ?? null,
        allowCorrection,
        "team",
      );
      return;
    }
    const validationCtx = validationContext(record, context, attempt, deps.hasher);
    const core = materializeDesign(validation.value, validationCtx, identityResult.identity);
    const planningFingerprint = deps.hasher(
      canonicalDesignContent({
        core,
        revisions: context.revisions,
        capabilities: context.capabilities,
      }),
    );
    const resultId = deps.hasher(canonicalDesignContent({ ...core, planningFingerprint }));
    let result: DesignResult;
    try {
      result = DesignResultSchema.parse({ ...core, resultId, planningFingerprint });
    } catch (cause) {
      log("materialized result failed schema", cause);
      await failJob(record.job.jobId, [error("DESIGN_OUTPUT_SCHEMA", ["result"], {}, "inspect")]);
      return;
    }
    const rematerialized = validateMaterializedDesign(
      result,
      validationCtx,
      deps.planner,
      validationRules(record),
    );
    if (!rematerialized.ok) {
      await handleFailure(
        record,
        context,
        rematerialized.issues,
        proposal,
        null,
        allowCorrection,
        "team",
      );
      return;
    }
    await updateRecord(record.job.jobId, (current) => ({
      ...current,
      result,
      proposal,
      job: {
        ...current.job,
        state: "ready",
        attempt,
        resultId,
        issues: validation.issues,
        issuesTruncated: validation.issuesTruncated,
        saveState: "none",
        saveLeaseExpiresAt: null,
        allowed: allowedFor("ready"),
      },
    }));
  }

  function profileResolutionFailure(
    issues: readonly DesignIssue[],
    context: DesignContextSnapshot,
  ): { roles: string[]; available: ReturnType<typeof summarizeProfiles> } | null {
    const profileIssues = issues.filter(profileResolutionIssue);
    if (profileIssues.length === 0) return null;
    const roles = new Set<string>();
    for (const role of context.roles) {
      if (context.roleLaunchTables.member[role.id]?.launchable === false) {
        roles.add(`${role.name} (${role.id})`);
      }
    }
    for (const issue of profileIssues) {
      const roleId = issue.params.roleId;
      if (typeof roleId !== "string") continue;
      const role = context.roles.find((item) => item.id === roleId);
      roles.add(role ? `${role.name} (${role.id})` : roleId);
    }
    return {
      roles: [...roles],
      available: summarizeProfiles(
        context.profiles,
        context.availability,
        economyOf(context),
      ).filter((profile) => profile.available),
    };
  }

  async function handleFailure(
    record: StoredDesignJob,
    context: DesignContextSnapshot,
    inputIssues: readonly DesignIssue[],
    proposal: DesignTeamProposal | null,
    mismatches:
      | readonly {
          target: string;
          actualProfileIds: string[];
          expectedProfileIds: string[];
          reason: string;
        }[]
      | null,
    allowCorrection: boolean,
    /**
     * What the decoded output was (team or role-gap), so the correction round keeps its template.
     * Undefined when decoding itself failed (fence, JSON, schema, identity): the correction then
     * uses the same default template set as the kickoff.
     */
    previousOutputKind?: "team" | "role-gap",
  ) {
    const profileFailure = profileResolutionFailure(inputIssues, context);
    let issues = inputIssues;
    if (profileFailure) {
      const roles = profileFailure.roles.length > 0 ? profileFailure.roles : ["所选 Role"];
      if (profileFailure.available.length === 0) {
        const actionable = error(
          "DESIGN_LAUNCH_BLOCKED",
          ["plan", "profiles"],
          {
            reason: boundedReason(
              "本 host 没有可用 Profile。请先在 Role 编辑器为以下 Role 绑定 Profile：",
              roles,
              "",
            ),
          },
          "choose-profile",
        );
        await failJob(record.job.jobId, [...inputIssues, actionable]);
        return;
      }
      const profileList = profileFailure.available.map(
        (profile) => `${profile.id} / ${profile.name} / ${profile.family ?? "未标注"}`,
      );
      const aggregate = error(
        "DESIGN_LAUNCH_BLOCKED",
        ["plan", "profiles"],
        {
          reason: boundedReason(
            `以下 Role 在本 host 不可启动：${roles.join("、")}。可用 Profile（id / 名称 / family）：`,
            profileList,
            "。请改用其他 Role，或用这些 Profile 新建 Role。",
          ),
        },
        "repair",
      );
      issues = [
        ...inputIssues
          .filter((issue) => !profileResolutionIssue(issue))
          .map((issue) =>
            issue.code === "DESIGN_LAUNCH_BLOCKED"
              ? { ...issue, action: "repair" as const }
              : issue,
          ),
        aggregate,
      ];
    }
    const finalized = finalizeDesignIssues(issues);
    if (!allowCorrection) {
      await failJob(record.job.jobId, finalized.issues, "needs_continue");
      return;
    }
    const attempt = record.job.attempt;
    const repairable =
      finalized.issues.length > 0 && finalized.issues.every((issue) => issue.action === "repair");
    if (attempt < 1 || attempt >= 3 || !repairable) {
      await failJob(record.job.jobId, finalized.issues);
      return;
    }
    const adapter = await requireAdapter();
    if (!adapter) {
      await failJob(
        record.job.jobId,
        [error("DESIGN_CONFIG_UNAVAILABLE", ["adapter"], { source: "adapter" }, "refresh")],
        "needs_continue",
      );
      return;
    }
    const nextAttempt = (attempt + 1) as 1 | 2 | 3;
    const nonce = nonceOf(deps.ids);
    const expectedChoices = expectedChoicesFromMismatches(proposal, mismatches ?? []);
    const correction = buildDesignCorrection({
      jobId: record.job.jobId,
      attempt: nextAttempt,
      nonce,
      issues: finalized.issues,
      context: promptContext(record, context, expectedChoices),
      expectedChoices,
      ...(previousOutputKind === undefined ? {} : { previousOutputKind }),
    });
    if (!correction.ok) {
      await failJob(
        record.job.jobId,
        [...finalized.issues, ...correction.issues],
        "needs_continue",
      );
      return;
    }
    const messageId = deps.ids.next();
    const attemptRecord: DesignAttemptRecord = {
      attempt: nextAttempt,
      nonce,
      messageId,
      promptHash: deps.hasher(correction.text),
      epoch: null,
      endCursor: null,
      summary: null,
      ack: "pending",
      sentAt: deps.clock.now(),
      lastError: null,
    };
    const nextRecord = await updateRecord(record.job.jobId, (current) => ({
      ...current,
      attempts: [...current.attempts, attemptRecord],
      proposal,
      job: {
        ...current.job,
        state: "fixing",
        attempt: nextAttempt,
        issues: finalized.issues,
        issuesTruncated: finalized.issuesTruncated,
        allowed: allowedFor("fixing"),
      },
    }));
    try {
      await adapter.sendDesignMessage({
        agentId: nextRecord.job.agentId,
        text: correction.text,
        messageId,
      });
      await updateRecord(record.job.jobId, (current) => ({
        ...current,
        attempts: current.attempts.map((item) =>
          item.attempt === nextAttempt ? { ...item, ack: "acked" } : item,
        ),
        job: { ...current.job, state: "designing", allowed: allowedFor("designing") },
      }));
    } catch (cause) {
      log("design correction send is uncertain", cause);
      await updateRecord(record.job.jobId, (current) => ({
        ...current,
        attempts: current.attempts.map((item) =>
          item.attempt === nextAttempt ? { ...item, ack: "unknown" } : item,
        ),
        outcomeUnknown: true,
        job: {
          ...current.job,
          state: "needs_continue",
          issues: [
            ...finalized.issues,
            error("DESIGN_STATE_CHANGED", [], { reason: "send-unknown" }, "inspect"),
          ],
          allowed: allowedFor("needs_continue"),
        },
      }));
    }
  }

  async function runStart(jobId: string, input: DesignStartInput) {
    const record = await deps.store.get(jobId);
    if (!record) return;
    const adapter = await requireAdapter();
    if (!adapter) {
      await failJob(jobId, [
        error("DESIGN_CONFIG_UNAVAILABLE", [], { source: "adapter" }, "refresh"),
      ]);
      return;
    }
    const contextResult = await readContext(record);
    if (!contextResult.ok) {
      await failJob(jobId, contextResult.issues);
      return;
    }
    const context = contextResult.context;
    const selected = chooseDesignerProfile(input, context);
    if (!selected.ok) {
      await failJob(jobId, selected.issues);
      return;
    }
    const attempt: 1 = 1;
    const nonce = nonceOf(deps.ids);
    const kickoff = buildDesignKickoff({
      jobId,
      attempt,
      nonce,
      context: promptContext(record, context),
    });
    if (!kickoff.ok) {
      await failJob(jobId, kickoff.issues);
      return;
    }
    const messageId = deps.ids.next();
    const attemptRecord: DesignAttemptRecord = {
      attempt,
      nonce,
      messageId,
      promptHash: deps.hasher(kickoff.text),
      epoch: null,
      endCursor: null,
      summary: null,
      ack: "pending",
      sentAt: deps.clock.now(),
      lastError: null,
    };
    const labels = buildDesignLabels({
      jobId,
      clientRequestId: record.job.clientRequestId,
      requestHash: record.requestHash,
      mode: record.mode,
      request: record.request,
    });
    const createRequest: CreateDesignAgentInput = {
      agentId: jobId,
      idempotencyKey: `agent-team-design:${jobId}`,
      workspaceId: context.targetWorkspaceId ?? context.carrierWorkspaceId,
      title: excerpt(record.request, 40),
      labels,
      profile: {
        provider: selected.profile.provider,
        ...(selected.profile.model !== undefined ? { model: selected.profile.model } : {}),
        ...(selected.profile.modeId !== undefined ? { modeId: selected.profile.modeId } : {}),
        ...(selected.profile.thinkingOptionId !== undefined
          ? { thinkingOptionId: selected.profile.thinkingOptionId }
          : {}),
        ...(selected.profile.featureValues !== undefined
          ? { featureValues: selected.profile.featureValues }
          : {}),
      },
      systemPrompt: DESIGNER_SYSTEM_PROMPT,
      prompt: kickoff.text,
      clientMessageId: messageId,
    };
    const beforeIntent = await deps.store.get(jobId);
    if (!beforeIntent || beforeIntent.job.cancelRequested) {
      if (beforeIntent) {
        await updateRecord(jobId, (current) => ({
          ...current,
          job: {
            ...current.job,
            state: "canceled",
            cancelRequested: true,
            finishedAt: deps.clock.now(),
            allowed: allowedFor("canceled"),
          },
        }));
      }
      return;
    }
    const intentHash = deps.hasher(
      canonicalDesignContent({
        agentId: jobId,
        workspaceId: context.targetWorkspaceId ?? context.carrierWorkspaceId,
        profile: selected.profile,
        promptHash: attemptRecord.promptHash,
        labels,
      }),
    );
    await updateRecord(jobId, (current) => ({
      ...current,
      creation: {
        intentHash,
        idempotencyKey: `agent-team-design:${jobId}`,
        request: createRequest,
      },
      attempts: [attemptRecord],
      job: {
        ...current.job,
        state: "designing",
        attempt,
        designerProfile: profileSummary(selected.profile),
        carrierWorkspaceId: context.carrierWorkspaceId,
        targetWorkspaceId: context.targetWorkspaceId,
        agentStatus: "initializing",
        allowed: allowedFor("designing"),
      },
    }));
    const afterIntent = await deps.store.get(jobId);
    if (!afterIntent || afterIntent.job.cancelRequested) {
      if (afterIntent) {
        await updateRecord(jobId, (current) => ({
          ...current,
          job: {
            ...current.job,
            state: "canceled",
            cancelRequested: true,
            finishedAt: deps.clock.now(),
            allowed: allowedFor("canceled"),
          },
        }));
      }
      return;
    }
    creating.add(jobId);
    try {
      await adapter.createDesignAgent(createRequest);
      const afterCreate = await markAgentCreated(jobId, "idle");
      if (afterCreate.job.cancelRequested) await archiveForCancel(jobId);
    } catch (cause) {
      log("design agent create failed", cause);
      await handleCreateFailure(jobId, adapter, cause);
    } finally {
      creating.delete(jobId);
    }
  }

  async function recoverPendingSend(
    record: StoredDesignJob,
    adapter: DesignAdapter,
  ): Promise<"acked" | "unknown" | "wait"> {
    const attempt = record.attempts.find((item) => item.attempt === record.job.attempt);
    if (attempt?.ack !== "pending") return "acked";
    const page = await adapter.readDesignTimeline({
      agentId: record.job.agentId,
      direction: "tail",
      limit: 100,
    });
    const echoed = page.entries.some(
      (entry) =>
        entry.type === "user_message" &&
        (entry.messageId === attempt.messageId || entry.clientMessageId === attempt.messageId),
    );
    if (echoed) {
      await updateRecord(record.job.jobId, (current) => ({
        ...current,
        attempts: current.attempts.map((item) =>
          item.attempt === attempt.attempt ? { ...item, ack: "acked" } : item,
        ),
        job: {
          ...current.job,
          state: current.job.state === "fixing" ? "designing" : current.job.state,
          allowed: allowedFor(current.job.state === "fixing" ? "designing" : current.job.state),
        },
      }));
      return "acked";
    }
    const sentAt = sendTimeOf(attempt);
    const age = Date.parse(deps.clock.now()) - (sentAt ?? Date.parse(record.job.updatedAt));
    if (Number.isFinite(age) && age >= PENDING_SEND_TIMEOUT_MS) {
      await updateRecord(record.job.jobId, (current) => ({
        ...current,
        outcomeUnknown: true,
        job: {
          ...current.job,
          state: "needs_continue",
          allowed: allowedFor("needs_continue"),
          issues: [
            ...current.job.issues,
            error("DESIGN_STATE_CHANGED", ["send"], { reason: "send-unknown" }, "inspect"),
          ],
        },
      }));
      return "unknown";
    }
    return "wait";
  }

  async function resumeStarting(record: StoredDesignJob) {
    if (record.job.state !== "starting" || record.job.cancelRequested) return;
    const adapter = await requireAdapter();
    if (!adapter) return;
    if (record.creation) {
      const agent = await adapter.getDesignAgent(record.job.agentId).catch(() => null);
      if (agent) {
        await updateRecord(record.job.jobId, (current) => ({
          ...current,
          job: {
            ...current.job,
            state: "designing",
            agentCreated: true,
            agentStatus: agent.status,
            allowed: allowedFor("designing"),
          },
        }));
        return;
      }
      await failJob(record.job.jobId, [
        error("DESIGN_RECOVERY_INCOMPLETE", ["agent"], { reason: "create-unconfirmed" }, "inspect"),
      ]);
      return;
    }
    const input = startInputFromRecord(record);
    if (!input) {
      await failJob(record.job.jobId, [
        error("DESIGN_RECOVERY_INCOMPLETE", ["selectionIntent"], {}, "inspect"),
      ]);
      return;
    }
    await runStart(record.job.jobId, input);
  }

  async function reconcile(jobId: string) {
    let record = await deps.store.get(jobId);
    if (!record || TERMINAL.has(record.job.state)) return;
    if (record.job.cancelRequested || record.job.state === "canceling") {
      await resolveCancellation(jobId);
      return;
    }
    if (record.job.state === "starting") {
      await resumeStarting(record);
      return;
    }
    if (record.job.state === "designing" && !record.job.agentCreated) {
      await resumeUnconfirmedCreate(record);
      return;
    }
    if (record.job.state === "needs_continue" && !record.job.agentCreated && record.creation) {
      const adapter = await requireAdapter();
      if (!adapter) return;
      const agent = await providerAgent(record, adapter).catch(() => null);
      if (!agent) return;
      const claimed = await claimDiscoveredAgent(record, agent);
      if (!claimed) return;
      record = claimed;
    }
    if (!RECONCILE_STATES.has(record.job.state)) return;
    const adapter = await requireAdapter();
    if (!adapter) return;
    if (record.job.state === "fixing") {
      const recovered = await recoverPendingSend(record, adapter);
      if (recovered !== "wait") return;
    }
    const fact = await reconcileDesignJob(
      { discovery: toDiscoveryPort(adapter), timeline: toTimelinePort(adapter) },
      deps.store,
      jobId,
    );
    const agent = fact.agent;
    const permissions = agent ? permissionSummary(agent) : null;
    let currentRecord = record;
    const observedTurnId = fact.attempt?.status === "complete" ? fact.attempt.turnId : null;
    if (
      observedTurnId !== null &&
      (record.job.attempt === 1 || record.job.attempt === 2 || record.job.attempt === 3)
    ) {
      const attemptNumber = record.job.attempt;
      const recorded = record.attempts.find((item) => item.attempt === attemptNumber);
      if (recorded && !recorded.turnId) {
        currentRecord = await updateRecord(jobId, (current) => ({
          ...current,
          attempts: current.attempts.map((item) =>
            item.attempt === attemptNumber ? { ...item, turnId: observedTurnId } : item,
          ),
        }));
      }
    }
    if (fact.observation === "ready-candidate" && fact.attempt?.status === "complete") {
      if (
        currentRecord.job.attempt !== 1 &&
        currentRecord.job.attempt !== 2 &&
        currentRecord.job.attempt !== 3
      )
        return;
      await processCandidate(
        currentRecord,
        fact.attempt.text,
        currentRecord.job.attempt,
        observed.has(jobId),
      );
      return;
    }
    if (fact.observation === "attempt-error") {
      await failJob(jobId, [error("DESIGN_AGENT_FAILED", ["agent"], {}, "inspect")]);
      return;
    }
    if (fact.observation === "external-input") {
      await failJob(
        jobId,
        [error("DESIGN_EXTERNAL_INPUT", ["attempt"], {}, "inspect")],
        "needs_continue",
      );
      return;
    }
    if (fact.observation === "needs-continue") {
      await failJob(
        jobId,
        [error("DESIGN_TIMELINE_INCOMPLETE", ["attempt"], { reason: fact.observation }, "inspect")],
        "needs_continue",
      );
      return;
    }
    if (fact.observation === "unclaimed") {
      await failJob(
        jobId,
        [error("DESIGN_RECOVERY_INCOMPLETE", ["agent"], { reason: "unclaimed" }, "inspect")],
        "needs_continue",
      );
      return;
    }
    if (agent && permissions) {
      const changed =
        record.job.agentStatus !== agent.status ||
        record.job.requiresAttention !== (agent.status !== "idle" && agent.status !== "running") ||
        record.job.attentionReason !== agent.attentionReason ||
        record.job.permissionsTruncated !== permissions.permissionsTruncated ||
        JSON.stringify(record.job.pendingPermissions) !==
          JSON.stringify(permissions.pendingPermissions);
      if (changed) {
        await updateRecord(jobId, (current) => ({
          ...current,
          job: {
            ...current.job,
            agentStatus: agent.status,
            requiresAttention: agent.status !== "idle" && agent.status !== "running",
            attentionReason: agent.attentionReason,
            pendingPermissions: permissions.pendingPermissions,
            permissionsTruncated: permissions.permissionsTruncated,
          },
        }));
      }
    }
  }

  async function providerAgent(
    record: StoredDesignJob,
    adapter: DesignAdapter,
  ): Promise<Awaited<ReturnType<ReturnType<typeof toDiscoveryPort>["refresh"]>>> {
    const agent = await toDiscoveryPort(adapter).refresh(record.job.agentId);
    if (
      !agent ||
      agent.agentId !== record.job.agentId ||
      agent.labels[DESIGN_LABEL_KEYS.job] !== record.job.jobId ||
      agent.labels[DESIGN_LABEL_KEYS.version] !== "1" ||
      agent.labels[DESIGN_LABEL_KEYS.requestHash] !== record.requestHash
    )
      return null;
    return agent;
  }

  async function markAgentCreated(
    jobId: string,
    status: "initializing" | "idle" | "running" | "closed" | "error",
  ) {
    return updateRecord(jobId, (current) => ({
      ...current,
      attempts: current.attempts.map((item) =>
        item.attempt === current.job.attempt && item.ack === "pending"
          ? { ...item, ack: "acked" }
          : item,
      ),
      job: {
        ...current.job,
        agentCreated: true,
        agentStatus: status,
        state: current.job.cancelRequested ? "canceling" : "designing",
        allowed: allowedFor(current.job.cancelRequested ? "canceling" : "designing"),
      },
    }));
  }

  async function claimDiscoveredAgent(
    record: StoredDesignJob,
    agent: Awaited<ReturnType<typeof providerAgent>>,
  ) {
    if (!agent) return null;
    const updated = await markAgentCreated(record.job.jobId, agent.status);
    if (updated.job.cancelRequested) await archiveForCancel(record.job.jobId);
    return updated;
  }

  async function handleCreateFailure(
    jobId: string,
    adapter: DesignAdapter,
    cause: unknown,
  ): Promise<void> {
    const current = await deps.store.get(jobId);
    if (!current) return;
    const discovered = await providerAgent(current, adapter).catch(() => null);
    if (discovered) {
      await claimDiscoveredAgent(current, discovered);
      return;
    }
    if (current.job.cancelRequested) {
      await resolveCancellation(jobId);
      return;
    }
    if (uncertainCreate(cause)) {
      await updateRecord(jobId, (record) => ({
        ...record,
        outcomeUnknown: true,
        job: {
          ...record.job,
          state: "needs_continue",
          issues: [
            ...record.job.issues,
            error(
              "DESIGN_STATE_CHANGED",
              ["agent"],
              { step: "create", reason: "outcome-unknown" },
              "inspect",
            ),
          ],
          allowed: allowedFor("needs_continue"),
        },
      }));
      return;
    }
    await failJob(jobId, [error("DESIGN_AGENT_FAILED", ["agent"], { step: "create" }, "inspect")]);
  }

  async function resumeUnconfirmedCreate(record: StoredDesignJob): Promise<void> {
    const adapter = await requireAdapter();
    if (!adapter) {
      await failJob(
        record.job.jobId,
        [error("DESIGN_CONFIG_UNAVAILABLE", [], { source: "adapter" }, "refresh")],
        "failed",
      );
      return;
    }
    const agent = await providerAgent(record, adapter).catch(() => null);
    if (agent) {
      await claimDiscoveredAgent(record, agent);
      return;
    }
    if (record.job.cancelRequested) {
      await resolveCancellation(record.job.jobId);
      return;
    }
    if (!record.creation?.request) {
      await failJob(
        record.job.jobId,
        [
          error(
            "DESIGN_RECOVERY_INCOMPLETE",
            ["agent"],
            { reason: "create-request-missing" },
            "inspect",
          ),
        ],
        "failed",
      );
      return;
    }
    creating.add(record.job.jobId);
    try {
      await adapter.createDesignAgent(record.creation.request);
      await markAgentCreated(record.job.jobId, "idle");
    } catch (cause) {
      log("design agent replay failed", cause);
      await handleCreateFailure(record.job.jobId, adapter, cause);
    } finally {
      creating.delete(record.job.jobId);
    }
  }

  async function resolveCancellation(jobId: string): Promise<DesignJob> {
    const record = await deps.store.get(jobId);
    if (!record) throw new Error("design job missing");
    if (TERMINAL.has(record.job.state)) return record.job;
    if (record.job.agentCreated) return await archiveForCancel(jobId);
    if (creating.has(jobId)) return record.job;
    if (!record.creation) {
      const updated = await updateRecord(jobId, (current) => ({
        ...current,
        job: {
          ...current.job,
          state: "canceled",
          cancelRequested: true,
          finishedAt: deps.clock.now(),
          allowed: allowedFor("canceled"),
        },
      }));
      return updated.job;
    }
    const adapter = await requireAdapter();
    if (!adapter) {
      const failed = await failJob(
        jobId,
        [error("DESIGN_CANCEL_FAILED", ["agent"], {}, "inspect")],
        "needs_continue",
      );
      return failed.job;
    }
    let agent: Awaited<ReturnType<typeof providerAgent>>;
    try {
      agent = await providerAgent(record, adapter);
    } catch (cause) {
      log("design cancel discovery failed", cause);
      const failed = await failJob(
        jobId,
        [error("DESIGN_CANCEL_FAILED", ["agent"], {}, "inspect")],
        "needs_continue",
      );
      return failed.job;
    }
    if (!agent) {
      const updated = await updateRecord(jobId, (current) => ({
        ...current,
        job: {
          ...current.job,
          state: "canceled",
          cancelRequested: true,
          finishedAt: deps.clock.now(),
          allowed: allowedFor("canceled"),
        },
      }));
      return updated.job;
    }
    await updateRecord(jobId, (current) => ({
      ...current,
      job: {
        ...current.job,
        agentCreated: true,
        agentStatus: agent.status,
      },
    }));
    return await archiveForCancel(jobId);
  }

  async function archiveForCancel(jobId: string): Promise<DesignJob> {
    const current = await deps.store.get(jobId);
    if (!current) throw new Error("design job missing");
    if (TERMINAL.has(current.job.state)) return current.job;
    const adapter = await requireAdapter();
    if (current.job.agentCreated) {
      if (!adapter) {
        const failed = await failJob(
          jobId,
          [error("DESIGN_CANCEL_FAILED", ["agent"], {}, "inspect")],
          "needs_continue",
        );
        return failed.job;
      }
      try {
        await adapter.archiveDesignAgent(current.job.agentId);
      } catch (cause) {
        log("design cancel archive failed", cause);
        const failed = await failJob(
          jobId,
          [error("DESIGN_CANCEL_FAILED", ["agent"], {}, "inspect")],
          "needs_continue",
        );
        return failed.job;
      }
    }
    const updated = await updateRecord(jobId, (record) => ({
      ...record,
      job: {
        ...record.job,
        state: "canceled",
        cancelRequested: true,
        finishedAt: deps.clock.now(),
        allowed: allowedFor("canceled"),
      },
    }));
    return updated.job;
  }

  async function handleTerminalOutcome(jobId: string, event: DesignTurnEndedEvent) {
    const record = await deps.store.get(jobId);
    if (!record || TERMINAL.has(record.job.state)) return;
    if (record.job.state !== "designing" && record.job.state !== "fixing") return;
    const currentAttempt = record.attempts.find((item) => item.attempt === record.job.attempt);
    if (!event.turnId) {
      await reconcile(jobId);
      return;
    }
    const identity = currentAttempt?.turnId ?? null;
    const fallback = currentAttempt?.messageId ?? null;
    const earlier = record.attempts.some(
      (item) =>
        item.attempt < record.job.attempt && item.turnId !== null && item.turnId === event.turnId,
    );
    if (earlier) return;
    if (identity === null && event.turnId !== fallback) {
      await reconcile(jobId);
      return;
    }
    if (identity !== null && identity !== event.turnId && event.turnId !== fallback) return;
    if (event.outcome?.kind === "canceled") {
      await archiveForCancel(jobId);
      return;
    }
    if (event.outcome?.kind === "failed") {
      await failJob(jobId, [
        error("DESIGN_AGENT_FAILED", ["agent"], { reason: "failed" }, "inspect"),
      ]);
      return;
    }
    await reconcile(jobId);
  }

  /**
   * Refuses, before anything is read or written, a by-job call from a caller whose contract cannot
   * represent the job's mode (a baseline page asking about an economy-all job). A store problem
   * is not this function's to report; the call's own path surfaces it.
   */
  async function contractBlock(jobId: string, raw: number | undefined) {
    const contract = requestContractVersion({ contractVersion: raw });
    if (contract === 2) return null;
    try {
      const record = await deps.store.get(jobId);
      if (record && !modeVisibleTo(record.mode, contract)) {
        return failure([legacyModeIssue(record.mode)]);
      }
    } catch {
      return null;
    }
    return null;
  }

  /** Every reply leaves through here: DTO strip, then the caller's contract projection. */
  function finishReply<T>(
    reply: T,
    contract: DesignContract,
    options: { keepGapRetry?: boolean } = {},
  ): T {
    if (!reply || typeof reply !== "object") return reply;
    const out: Record<string, unknown> = { ...(reply as Record<string, unknown>) };
    const job = out.job as DesignJob | null | undefined;
    if (job) out.job = projectJobForContract(job, contract);
    if ("result" in out && out.result) {
      out.result = projectResultForContract(out.result as DesignResult);
    }
    if (Array.isArray(out.jobs)) {
      Object.assign(
        out,
        projectStatusForContract(
          {
            jobs: out.jobs as DesignJob[],
            truncated: Boolean(out.truncated),
            discoveryIssues: (out.discoveryIssues ?? []) as DesignIssue[],
          },
          contract,
          options,
        ),
      );
    }
    const prepared = out.prepared as Record<string, unknown> | undefined;
    if (prepared) {
      out.prepared = {
        ...prepared,
        ...(prepared.job
          ? { job: projectJobForContract(prepared.job as DesignJob, contract) }
          : {}),
        ...(prepared.result
          ? { result: projectResultForContract(prepared.result as DesignResult) }
          : {}),
      };
    }
    return out as T;
  }

  function wrapReply<I extends { contractVersion?: number }, R>(
    method: (input: I) => Promise<R>,
    options: { keepGapRetry?: boolean } = {},
  ): (input: I) => Promise<R> {
    return async (input) =>
      finishReply(
        await method(input),
        requestContractVersion({ contractVersion: input.contractVersion }),
        options,
      );
  }

  const api = {
    async start(input: DesignStartInput) {
      return withAdmission(async () => {
        if (disposed)
          return failure([
            error("DESIGN_STORAGE_UNAVAILABLE", [], { reason: "disposed" }, "refresh"),
          ]);
        if (input.mode === "collaborative" && !deps.capabilities.collaboration) {
          return failure([
            error("DESIGN_MODE_UNAVAILABLE", ["mode"], { mode: input.mode }, "none"),
          ]);
        }
        const mode = input.mode ?? "sota";
        // The access gate comes before any store read, hash, or agent: a caller that did not say
        // contract 2 (or a mode this build does not know) is refused with nothing touched.
        if (
          !isTeamMode(mode) ||
          !designModeAccess({ mode, contractVersion: input.contractVersion }).ok
        ) {
          return failure([legacyModeIssue(mode)]);
        }
        const request = input.request.trim();
        const rules = normalizeExistingRolesOnly(input.existingRolesOnly);
        const base = {
          request,
          mode,
          workspaceId: input.workspaceId ?? null,
          profileId: input.profileId ?? null,
          useDefaultProfileHints: input.useDefaultProfileHints ?? false,
        };
        // payloadVersion 2 adds the rule; contractVersion, clientRequestId, time, and nonce are
        // never part of it. An omitted rule and an explicit true hash alike; false differs.
        const payload = { payloadVersion: 2, ...base, existingRolesOnly: rules };
        const requestHash = hashPayload(deps.hasher, payload);
        try {
          const existing = await deps.store.findRequest(input.clientRequestId);
          if (existing) {
            return resolveExistingRequest(existing, input, requestHash, base, deps.hasher);
          }
          const records = await deps.store.list();
          if (records.filter((record) => active(record.job)).length >= 3) {
            return failure([error("DESIGN_BUSY", [], { limit: 3 }, "none")]);
          }
          const now = deps.clock.now();
          const jobId = deps.ids.next();
          const job: DesignJob = {
            jobId,
            clientRequestId: input.clientRequestId,
            stateRevision: deps.ids.next(),
            state: "starting",
            attempt: 0,
            mode,
            createdAt: now,
            updatedAt: now,
            finishedAt: null,
            requestExcerpt: excerpt(request, 160),
            agentId: jobId,
            agentCreated: false,
            carrierWorkspaceId: null,
            targetWorkspaceId: input.workspaceId ?? null,
            designerProfile: null,
            agentStatus: null,
            requiresAttention: false,
            attentionReason: null,
            pendingPermissions: [],
            permissionsTruncated: false,
            resultId: null,
            savedTeamId: null,
            saveState: "none",
            cancelRequested: false,
            needsCleanup: false,
            issues: [],
            issuesTruncated: 0,
            recovered: false,
            saveLeaseExpiresAt: null,
            allowed: allowedFor("starting"),
            // The Job DTO's copy of the record rules (the root below is the authority).
            existingRolesOnly: rules,
            outputContractVersion: designContractVersionForNewJob(),
            roleGap: null,
          };
          const record: StoredDesignJob = {
            schemaVersion: DESIGN_RECORD_VERSION,
            job,
            request,
            requestHash,
            requestHashVersion: 2,
            outputContractVersion: designContractVersionForNewJob(),
            existingRolesOnly: rules,
            roleGap: null,
            mode,
            selectionIntent: JSON.stringify(payload),
            creation: null,
            attempts: [],
            proposal: null,
            result: null,
            reuseFingerprints: {},
            leaseOwner: null,
            receipts: { [input.clientRequestId]: jobId },
            outcomeUnknown: false,
          };
          try {
            await deps.store.create(record);
          } catch (cause) {
            const raced = await deps.store.findRequest(input.clientRequestId);
            if (raced) return resolveExistingRequest(raced, input, requestHash, base, deps.hasher);
            return failure([issueFromStore(cause)]);
          }
          void enqueue(jobId, () => runStart(jobId, input)).catch((cause) =>
            log("design start failed", cause),
          );
          return { ok: true as const, job };
        } catch (cause) {
          return failure([issueFromStore(cause)]);
        }
      });
    },

    async status(input: DesignStatusInput) {
      try {
        if (input.jobId) {
          const blocked = await contractBlock(input.jobId, input.contractVersion);
          if (blocked) return blocked;
          const record = await deps.store.get(input.jobId);
          if (!record)
            return failure([
              error("DESIGN_JOB_NOT_FOUND", ["jobId"], { jobId: input.jobId }, "refresh"),
            ]);
          if (needsReconcile(record)) {
            void enqueue(record.job.jobId, () => reconcile(record.job.jobId)).catch((cause) =>
              log("design reconcile failed", cause),
            );
          }
          // The retry seed rides on this by-id read only; a list never carries request text.
          const job = withoutGapRetry(record.job);
          const gapRetry = gapRetryOf(record);
          return {
            ok: true as const,
            scopeId,
            jobs: [gapRetry === undefined ? job : { ...job, gapRetry }],
            truncated: false,
            discoveryIssues: [],
          };
        }
        const records = await deps.store.list();
        const problems = await deps.store.problems();
        const sorted = [...records].sort((a, b) => {
          const activeOrder = Number(active(b.job)) - Number(active(a.job));
          return activeOrder !== 0 ? activeOrder : b.job.updatedAt.localeCompare(a.job.updatedAt);
        });
        for (const record of sorted.filter((entry) => needsReconcile(entry)).slice(0, 50)) {
          void enqueue(record.job.jobId, () => reconcile(record.job.jobId)).catch((cause) =>
            log("design reconcile failed", cause),
          );
        }
        const discoveryIssues = problems.map((problem) =>
          error(
            "DESIGN_RECOVERY_INCOMPLETE",
            ["ledger"],
            { name: problem.name, reason: problem.reason },
            "inspect",
          ),
        );
        return {
          ok: true as const,
          scopeId,
          jobs: sorted.slice(0, 50).map((record) => withoutGapRetry(record.job)),
          truncated: sorted.length > 50,
          discoveryIssues,
        };
      } catch (cause) {
        return failure([issueFromStore(cause)]);
      }
    },

    async result(input: DesignResultInput) {
      const blocked = await contractBlock(input.jobId, input.contractVersion);
      if (blocked) return blocked;
      try {
        const record = await deps.store.get(input.jobId);
        if (!record)
          return failure([
            error("DESIGN_JOB_NOT_FOUND", ["jobId"], { jobId: input.jobId }, "refresh"),
          ]);
        return {
          ok: true as const,
          job: withoutGapRetry(record.job),
          request: record.request,
          result: record.result,
        };
      } catch (cause) {
        return failure([issueFromStore(cause)]);
      }
    },

    async prepareSave(input: DesignPrepareSaveInput) {
      const blocked = await contractBlock(input.jobId, input.contractVersion);
      if (blocked) return blocked;
      try {
        const record = await deps.store.get(input.jobId);
        if (!record)
          return failure([
            error("DESIGN_JOB_NOT_FOUND", ["jobId"], { jobId: input.jobId }, "refresh"),
          ]);
        if (record.job.state === "saved")
          return {
            ok: true as const,
            prepared: { outcome: "already-saved" as const, job: record.job },
          };
        if (record.roleGap !== null) {
          // A gap has no result to save, so the stale-result answer below would be misleading.
          return failure(
            [error("DESIGN_STATE_CHANGED", ["state"], { reason: "role-gap" }, "refresh")],
            record.job,
          );
        }
        if (
          !record.result ||
          record.job.resultId !== input.resultId ||
          record.result.resultId !== input.resultId
        ) {
          return failure(
            [error("DESIGN_RESULT_STALE", ["resultId"], { resultId: input.resultId }, "refresh")],
            record.job,
          );
        }
        const canceledCompensation =
          input.intent === "compensate" && record.job.state === "canceled";
        if (
          (record.job.cancelRequested || record.job.state === "canceling") &&
          !canceledCompensation
        ) {
          return failure(
            [error("DESIGN_STATE_CHANGED", ["state"], { state: record.job.state }, "refresh")],
            record.job,
          );
        }
        const leaseExpires = record.job.saveLeaseExpiresAt
          ? Date.parse(record.job.saveLeaseExpiresAt)
          : Number.NaN;
        const leaseOwner = parseLeaseOwner(record.leaseOwner);
        const validWriteLease =
          leaseOwner !== null &&
          Number.isFinite(leaseExpires) &&
          leaseExpires > Date.parse(deps.clock.now());
        if (input.intent === "compensate" && validWriteLease) {
          return failure([error("DESIGN_SAVE_BUSY", ["lease"], {}, "refresh")], record.job);
        }
        if (
          record.job.state === "saving" &&
          leaseOwner &&
          leaseOwner.clientId !== input.clientId &&
          Number.isFinite(leaseExpires) &&
          leaseExpires > Date.parse(deps.clock.now())
        ) {
          return failure([error("DESIGN_SAVE_BUSY", ["lease"], {}, "refresh")], record.job);
        }
        if (
          !canceledCompensation &&
          record.job.state !== "ready" &&
          record.job.state !== "save_conflict" &&
          !(record.job.state === "saving" && leaseOwner?.clientId === input.clientId)
        ) {
          return failure(
            [error("DESIGN_STATE_CHANGED", ["state"], { state: record.job.state }, "refresh")],
            record.job,
          );
        }
        if (input.leaseId && leaseOwner && leaseOwner.leaseId !== input.leaseId) {
          return failure(
            [
              error(
                "DESIGN_SAVE_LEASE_EXPIRED",
                ["leaseId"],
                { leaseId: input.leaseId },
                "retry-save",
              ),
            ],
            record.job,
          );
        }
        const contextResult = await readContext(record);
        if (!contextResult.ok) return failure(contextResult.issues, record.job);
        const context = contextResult.context;
        const validated = validateMaterializedDesign(
          record.result,
          validationContext(record, context, designAttempt(record.result.attempt), deps.hasher),
          deps.planner,
          validationRules(record),
        );
        if (!validated.ok) {
          if (canceledCompensation) {
            const finalized = finalizeDesignIssues(validated.issues);
            const updated = await updateRecord(record.job.jobId, (current) => ({
              ...current,
              job: {
                ...current.job,
                issues: finalized.issues,
                issuesTruncated: finalized.issuesTruncated,
              },
            }));
            return failure(finalized.issues, updated.job);
          }
          await failJob(record.job.jobId, validated.issues, "needs_continue");
          return failure(validated.issues, record.job);
        }
        if (canceledCompensation) {
          const leaseExpired =
            leaseOwner !== null &&
            Number.isFinite(leaseExpires) &&
            leaseExpires <= Date.parse(deps.clock.now());
          if (leaseOwner !== null && !leaseExpired) {
            return failure([error("DESIGN_SAVE_BUSY", ["lease"], {}, "refresh")], record.job);
          }
          if (!record.job.needsCleanup) {
            return failure(
              [
                error(
                  "DESIGN_STATE_CHANGED",
                  ["cleanup"],
                  { state: record.job.state, reason: "no-cleanup" },
                  "refresh",
                ),
              ],
              record.job,
            );
          }
        }
        if (
          input.intent === "compensate" &&
          record.job.state !== "save_conflict" &&
          !record.job.needsCleanup &&
          !canceledCompensation
        ) {
          return failure(
            [error("DESIGN_STATE_CHANGED", ["state"], { state: record.job.state }, "refresh")],
            record.job,
          );
        }
        if (
          input.intent === "compensate" &&
          (record.outcomeUnknown || record.job.saveState === "unknown")
        ) {
          return failure(
            [
              error(
                "DESIGN_SAVE_UNKNOWN",
                ["receipt"],
                { reason: "write-outcome-unknown" },
                "inspect",
              ),
            ],
            record.job,
          );
        }
        if (canceledCompensation && !roleWrittenByJob(record, context.roles)) {
          return failure(
            [error("DESIGN_NOT_SAVED", ["newRoles"], { reason: "no-written-role" }, "inspect")],
            record.job,
          );
        }
        const leaseId = input.leaseId ?? deps.ids.next();
        const expiresAt = new Date(Date.parse(deps.clock.now()) + LEASE_MS).toISOString();
        const lease = { id: leaseId, expiresAt };
        if (input.intent === "compensate") {
          const compensation = planDesignCompensation({
            roles: { values: { roles: [...context.roles] }, revision: context.revisions.roles },
            teams: { values: { teams: [...context.teams] }, revision: context.revisions.teams },
            result: record.result,
            authorizedRoleIds: record.result.newRoles.map((role) => role.id),
          });
          const updated = await updateRecord(record.job.jobId, (current) => ({
            ...current,
            leaseOwner: encodeLeaseOwner(input.clientId, leaseId),
            job: {
              ...current.job,
              state: canceledCompensation ? current.job.state : "saving",
              saveLeaseExpiresAt: expiresAt,
              allowed: canceledCompensation ? current.job.allowed : allowedFor("saving"),
            },
          }));
          return {
            ok: true as const,
            prepared: {
              outcome: "compensate" as const,
              job: updated.job,
              result: record.result,
              lease,
              base: context.revisions,
              removableRoleIds: compensation.removeRoleIds,
            },
          };
        }
        const updated = await updateRecord(record.job.jobId, (current) => ({
          ...current,
          leaseOwner: encodeLeaseOwner(input.clientId, leaseId),
          job: {
            ...current.job,
            state: "saving",
            saveLeaseExpiresAt: expiresAt,
            allowed: allowedFor("saving"),
          },
        }));
        return {
          ok: true as const,
          prepared: {
            outcome: "write" as const,
            job: updated.job,
            result: record.result,
            lease,
            base: context.revisions,
          },
        };
      } catch (cause) {
        return failure([issueFromStore(cause)]);
      }
    },

    async markSaved(input: DesignMarkSavedInput) {
      const blocked = await contractBlock(input.jobId, input.contractVersion);
      if (blocked) return blocked;
      try {
        const record = await deps.store.get(input.jobId);
        if (!record)
          return failure([
            error("DESIGN_JOB_NOT_FOUND", ["jobId"], { jobId: input.jobId }, "refresh"),
          ]);
        if (record.job.state === "saved") return { ok: true as const, job: record.job };
        if (!record.result || input.resultId !== record.result.resultId) {
          return failure(
            [error("DESIGN_RESULT_STALE", ["resultId"], { resultId: input.resultId }, "refresh")],
            record.job,
          );
        }
        const markLease = parseLeaseOwner(record.leaseOwner);
        if (input.leaseId && markLease && markLease.leaseId !== input.leaseId) {
          return failure(
            [
              error(
                "DESIGN_SAVE_LEASE_EXPIRED",
                ["leaseId"],
                { leaseId: input.leaseId },
                "retry-save",
              ),
            ],
            record.job,
          );
        }
        const contextResult = await readContext(record);
        if (!contextResult.ok) return failure(contextResult.issues, record.job);
        const verified = verifySavedDesign({
          roles: { roles: [...contextResult.context.roles] },
          teams: { teams: [...contextResult.context.teams] },
          result: record.result,
        });
        if (verified.kind === "committed") {
          const updated = await updateRecord(record.job.jobId, (current) => ({
            ...current,
            leaseOwner: null,
            outcomeUnknown: false,
            job: {
              ...current.job,
              state: "saved",
              resultId: record.result?.resultId ?? current.job.resultId,
              savedTeamId: verified.teamId,
              saveState: "committed",
              saveLeaseExpiresAt: null,
              finishedAt: deps.clock.now(),
              allowed: allowedFor("saved"),
            },
          }));
          return { ok: true as const, job: updated.job };
        }
        const issues =
          verified.kind === "conflict"
            ? verified.issues
            : [error("DESIGN_NOT_SAVED", ["team"], { state: verified.kind }, "inspect")];
        if (
          verified.kind !== "conflict" &&
          (record.job.saveState === "unknown" || record.outcomeUnknown)
        ) {
          const cleared = await updateRecord(record.job.jobId, (current) => ({
            ...current,
            leaseOwner: null,
            outcomeUnknown: false,
            job: {
              ...current.job,
              state: "save_conflict",
              saveState: verified.kind,
              needsCleanup: verified.kind === "roles-only",
              saveLeaseExpiresAt: null,
              allowed: allowedFor("save_conflict"),
            },
          }));
          return failure(issues, cleared.job);
        }
        return failure(issues, record.job);
      } catch (cause) {
        return failure([issueFromStore(cause)]);
      }
    },

    async saveFailed(input: DesignSaveFailedInput) {
      const blocked = await contractBlock(input.jobId, input.contractVersion);
      if (blocked) return blocked;
      try {
        const record = await deps.store.get(input.jobId);
        if (!record)
          return failure([
            error("DESIGN_JOB_NOT_FOUND", ["jobId"], { jobId: input.jobId }, "refresh"),
          ]);
        if (record.job.state === "saved") return { ok: true as const, job: record.job };
        if (!record.result || input.resultId !== record.result.resultId) {
          return failure(
            [error("DESIGN_RESULT_STALE", ["resultId"], { resultId: input.resultId }, "refresh")],
            record.job,
          );
        }
        const failedLease = parseLeaseOwner(record.leaseOwner);
        if (!failedLease || failedLease.leaseId !== input.leaseId) {
          return failure(
            [
              error(
                "DESIGN_SAVE_LEASE_EXPIRED",
                ["leaseId"],
                { leaseId: input.leaseId },
                "retry-save",
              ),
            ],
            record.job,
          );
        }
        const canceled = record.job.cancelRequested || input.reason === "compensated";
        const state: DesignJob["state"] = canceled ? "canceled" : "save_conflict";
        const canceledAfterRoles =
          input.reason === "canceled" &&
          input.phase === "team" &&
          record.result.newRoles.length > 0;
        const compensated = input.reason === "compensated";
        const issue = error(
          input.reason === "compensated" ? "DESIGN_COMPENSATION_UNSAFE" : "DESIGN_SAVE_FAILED",
          ["save"],
          { phase: input.phase, reason: input.reason },
          "retry-save",
        );
        if (input.reason === "compensated" && record.job.agentCreated) {
          const adapter = await requireAdapter();
          if (!adapter) {
            return failure([error("DESIGN_CANCEL_FAILED", ["agent"], {}, "inspect")], record.job);
          }
          try {
            await adapter.archiveDesignAgent(record.job.agentId);
          } catch (cause) {
            log("design compensation archive failed", cause);
            return failure([error("DESIGN_CANCEL_FAILED", ["agent"], {}, "inspect")], record.job);
          }
        }
        const updated = await updateRecord(record.job.jobId, (current) => ({
          ...current,
          leaseOwner: null,
          outcomeUnknown: input.reason === "unknown",
          job: {
            ...current.job,
            state,
            saveState: compensated
              ? "none"
              : input.reason === "unknown"
                ? "unknown"
                : input.reason === "partial" || canceledAfterRoles
                  ? "roles-only"
                  : current.job.saveState,
            saveLeaseExpiresAt: null,
            needsCleanup: compensated
              ? false
              : input.reason === "partial" || canceledAfterRoles
                ? true
                : current.job.needsCleanup,
            issues: [...current.job.issues, issue],
            finishedAt: state === "canceled" ? deps.clock.now() : current.job.finishedAt,
            allowed: allowedFor(state),
          },
        }));
        return { ok: true as const, job: updated.job };
      } catch (cause) {
        return failure([issueFromStore(cause)]);
      }
    },

    async cancel(input: DesignCancelInput) {
      const blocked = await contractBlock(input.jobId, input.contractVersion);
      if (blocked) return blocked;
      try {
        const record = await deps.store.get(input.jobId);
        if (!record)
          return failure([
            error("DESIGN_JOB_NOT_FOUND", ["jobId"], { jobId: input.jobId }, "refresh"),
          ]);
        if (["saved", "failed", "canceled"].includes(record.job.state))
          return { ok: true as const, job: record.job };
        await updateRecord(record.job.jobId, (current) => ({
          ...current,
          job: {
            ...current.job,
            cancelRequested: true,
            state: "canceling",
            allowed: allowedFor("canceling"),
          },
        }));
        const resolved = await resolveCancellation(record.job.jobId);
        return { ok: true as const, job: resolved };
      } catch (cause) {
        return failure([issueFromStore(cause)]);
      }
    },

    async continue(input: DesignContinueInput) {
      const blocked = await contractBlock(input.jobId, input.contractVersion);
      if (blocked) return blocked;
      try {
        const record = await deps.store.get(input.jobId);
        if (!record)
          return failure([
            error("DESIGN_JOB_NOT_FOUND", ["jobId"], { jobId: input.jobId }, "refresh"),
          ]);
        if (record.roleGap !== null) {
          // A gap is final: retrying is a new request, never an in-place continue.
          return failure(
            [error("DESIGN_STATE_CHANGED", ["state"], { reason: "role-gap" }, "refresh")],
            record.job,
          );
        }
        if (record.job.stateRevision !== input.expectedRevision) {
          return failure(
            [error("DESIGN_STATE_CHANGED", ["stateRevision"], {}, "refresh")],
            record.job,
          );
        }
        const continueLease = parseLeaseOwner(record.leaseOwner);
        const continueLeaseActive =
          continueLease !== null &&
          record.job.saveLeaseExpiresAt !== null &&
          Date.parse(record.job.saveLeaseExpiresAt) > Date.parse(deps.clock.now());
        if (continueLeaseActive) {
          return failure([error("DESIGN_SAVE_BUSY", ["lease"], {}, "refresh")], record.job);
        }
        if (input.action === "repair" && !record.job.agentCreated) {
          return failure(
            [
              error(
                "DESIGN_RECOVERY_INCOMPLETE",
                ["agent"],
                { reason: "create-unconfirmed" },
                "refresh",
              ),
            ],
            record.job,
          );
        }
        if (input.action === "recheck") {
          if (record.job.state !== "needs_continue" && record.job.state !== "ready") {
            return failure(
              [error("DESIGN_STATE_CHANGED", ["state"], { state: record.job.state }, "refresh")],
              record.job,
            );
          }
          if (!record.result)
            return failure([error("DESIGN_NOT_SAVED", ["result"], {}, "inspect")], record.job);
          const contextResult = await readContext(record);
          if (!contextResult.ok) return failure(contextResult.issues, record.job);
          const checked = validateMaterializedDesign(
            record.result,
            validationContext(
              record,
              contextResult.context,
              designAttempt(record.result.attempt),
              deps.hasher,
            ),
            deps.planner,
            validationRules(record),
          );
          if (!checked.ok) return failure(checked.issues, record.job);
          const updated = await updateRecord(record.job.jobId, (current) => ({
            ...current,
            job: {
              ...current.job,
              state: "ready",
              issues: checked.issues,
              allowed: allowedFor("ready"),
            },
          }));
          return { ok: true as const, job: updated.job };
        }
        if (record.job.state !== "needs_continue") {
          return failure(
            [error("DESIGN_STATE_CHANGED", ["state"], { state: record.job.state }, "refresh")],
            record.job,
          );
        }
        if (record.job.attempt >= 3) {
          return failure([error("DESIGN_RETRY_EXHAUSTED", ["attempt"], {}, "none")], record.job);
        }
        const nextAttempt = (record.job.attempt + 1) as 1 | 2 | 3;
        if (record.attempts.some((item) => item.attempt === nextAttempt)) {
          return failure(
            [error("DESIGN_STATE_CHANGED", ["attempt"], { reason: "already-sent" }, "inspect")],
            record.job,
          );
        }
        const repairAdapter = input.action === "repair" ? await requireAdapter() : null;
        if (input.action === "repair" && !repairAdapter) {
          return failure(
            [error("DESIGN_CONFIG_UNAVAILABLE", ["adapter"], { source: "adapter" }, "refresh")],
            record.job,
          );
        }
        if (input.action === "repair" && repairAdapter) {
          let live: Awaited<ReturnType<typeof repairAdapter.getDesignAgent>>;
          try {
            live = await repairAdapter.getDesignAgent(record.job.agentId);
          } catch (cause) {
            log("design repair agent refresh failed", cause);
            return failure(
              [
                error(
                  "DESIGN_CONFIG_UNAVAILABLE",
                  ["agent"],
                  { reason: "refresh-failed" },
                  "refresh",
                ),
              ],
              record.job,
            );
          }
          if (!live) {
            return failure(
              [error("DESIGN_RECOVERY_INCOMPLETE", ["agent"], { reason: "missing" }, "refresh")],
              record.job,
            );
          }
          if (live.archivedAt !== null) {
            return failure(
              [error("DESIGN_STATE_CHANGED", ["agent"], { reason: "archived" }, "refresh")],
              record.job,
            );
          }
          if (live.status === "closed") {
            return failure(
              [error("DESIGN_STATE_CHANGED", ["agent"], { reason: "closed" }, "refresh")],
              record.job,
            );
          }
          if (live.status === "error") {
            return failure(
              [error("DESIGN_AGENT_FAILED", ["agent"], { reason: "error" }, "inspect")],
              record.job,
            );
          }
          if (live.activeTurn || live.status === "running" || live.status === "initializing") {
            return failure(
              [error("DESIGN_STATE_CHANGED", ["agent"], { reason: "running" }, "refresh")],
              record.job,
            );
          }
        }
        const contextResult = await readContext(record);
        if (!contextResult.ok) return failure(contextResult.issues, record.job);
        const adapter = await requireAdapter();
        if (!adapter) {
          return failure(
            [error("DESIGN_CONFIG_UNAVAILABLE", ["adapter"], { source: "adapter" }, "refresh")],
            record.job,
          );
        }
        const nonce = nonceOf(deps.ids);
        const correction = buildDesignCorrection({
          jobId: record.job.jobId,
          attempt: nextAttempt,
          nonce,
          issues: record.job.issues,
          context: promptContext(record, contextResult.context),
          expectedChoices: [],
        });
        if (!correction.ok)
          return failure([...record.job.issues, ...correction.issues], record.job);
        const messageId = deps.ids.next();
        const attemptRecord: DesignAttemptRecord = {
          attempt: nextAttempt,
          nonce,
          messageId,
          promptHash: deps.hasher(correction.text),
          epoch: null,
          endCursor: null,
          summary: null,
          ack: "pending",
          sentAt: deps.clock.now(),
          lastError: null,
        };
        const updated = await updateRecord(record.job.jobId, (current) => ({
          ...current,
          outcomeUnknown: false,
          attempts: [
            ...current.attempts.filter((item) => item.attempt !== nextAttempt),
            attemptRecord,
          ],
          job: {
            ...current.job,
            state: "fixing",
            attempt: nextAttempt,
            allowed: allowedFor("fixing"),
          },
        }));
        try {
          await adapter.sendDesignMessage({
            agentId: updated.job.agentId,
            text: correction.text,
            messageId,
          });
          const acknowledged = await updateRecord(record.job.jobId, (current) => ({
            ...current,
            attempts: current.attempts.map((item) =>
              item.attempt === nextAttempt ? { ...item, ack: "acked" } : item,
            ),
            job: { ...current.job, state: "designing", allowed: allowedFor("designing") },
          }));
          return { ok: true as const, job: acknowledged.job };
        } catch (cause) {
          log("design continue repair send failed", cause);
          const uncertain = await updateRecord(record.job.jobId, (current) => ({
            ...current,
            outcomeUnknown: true,
            attempts: current.attempts.map((item) =>
              item.attempt === nextAttempt ? { ...item, ack: "unknown" } : item,
            ),
            job: {
              ...current.job,
              state: "needs_continue",
              allowed: allowedFor("needs_continue"),
              issues: [
                ...current.job.issues,
                error("DESIGN_STATE_CHANGED", ["send"], { reason: "send-unknown" }, "inspect"),
              ],
            },
          }));
          return { ok: true as const, job: uncertain.job };
        }
      } catch (cause) {
        return failure([issueFromStore(cause)]);
      }
    },

    enqueueReconcile(jobId: string) {
      void enqueue(jobId, () => reconcile(jobId)).catch((cause) =>
        log("design reconcile failed", cause),
      );
    },

    async onTurnEnded(event: DesignTurnEndedEvent) {
      const labels = event.agent.labels ?? {};
      const jobId = labels[DESIGN_LABEL_KEYS.job];
      if (!jobId || labels[DESIGN_LABEL_KEYS.version] !== "1") return;
      const record = await deps.store.get(jobId).catch(() => null);
      if (!record || record.job.agentId !== event.agent.id) return;
      observed.add(jobId);
      await enqueue(jobId, () => handleTerminalOutcome(jobId, event), false);
    },

    async dispose() {
      disposed = true;
      await deps.store.dispose();
    },
  };
  return {
    ...api,
    start: wrapReply(api.start),
    status: wrapReply(api.status, { keepGapRetry: true }),
    result: wrapReply(api.result),
    prepareSave: wrapReply(api.prepareSave),
    markSaved: wrapReply(api.markSaved),
    saveFailed: wrapReply(api.saveFailed),
    cancel: wrapReply(api.cancel),
    continue: wrapReply(api.continue),
  };
}

export type DesignService = ReturnType<typeof createDesignService>;

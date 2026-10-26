import {
  mergeDesign,
  planDesignCompensation,
  type SavedDesignCheck,
  verifySavedDesign,
} from "../../shared/domain/design-merge";
import { finalizeDesignIssues } from "../../shared/domain/design-validation";
import type { DesignIssue, DesignJob, DesignResult } from "../../shared/schemas/design";
import type { Preferences } from "../../shared/schemas/preferences";
import type { Role } from "../../shared/schemas/role";
import type { Team } from "../../shared/schemas/team";
import type { RolesDocument, TeamsDocument } from "../../shared/settings";
import type {
  DesignSaveGateway,
  DesignSettingsSnapshot,
  DesignWriteResult,
} from "./design-gateway";

export type DesignSaveOutcome =
  | { status: "saved"; teamId: string }
  | { status: "waiting"; job: DesignJob; issues: DesignIssue[] }
  | { status: "blocked"; issues: DesignIssue[] };

export type DesignCompensationOutcome =
  | { status: "compensated"; job: DesignJob; removedRoleIds: string[]; retainedRoleIds: string[] }
  | { status: "waiting"; job: DesignJob; issues: DesignIssue[] }
  | { status: "blocked"; issues: DesignIssue[] };

/** A timed-out or failed write may still land, so compensation must not run until it is settled. */
export type DesignUnknownWrites = {
  mark(jobId: string): void;
  has(jobId: string): boolean;
};

export type DesignSaveDeps = {
  gateway: DesignSaveGateway;
  /** Injected so lease expiry and tests are deterministic; never read a hidden clock. */
  now: () => number;
  signal?: AbortSignal;
  /** Per-RPC bound. A timed-out write is an unknown write, not a retryable conflict. */
  timeoutMs?: number;
  /** Shared per-host run memory: any unknown write blocks compensation for that job. */
  unknownWrites?: DesignUnknownWrites;
};

/** Three write attempts per phase; stages keep separate counters. */
const MAX_CONFLICT_RETRIES = 3;
const MAX_STEPS = 16;
const MAX_LEASE_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

type Ready<Values> = Extract<DesignSettingsSnapshot<Values>, { status: "ready" }>;

type FreshRead =
  | {
      ok: true;
      roles: Ready<RolesDocument>;
      teams: Ready<TeamsDocument>;
      preferences: Ready<Preferences>;
    }
  | { ok: false; issues: DesignIssue[] };

type ReadPair =
  | { ok: true; roles: Ready<RolesDocument>; teams: Ready<TeamsDocument> }
  | { ok: false };

type ReadPairReady = Extract<ReadPair, { ok: true }>;

function issue(
  code: DesignIssue["code"],
  path: DesignIssue["path"] = [],
  action: DesignIssue["action"] = "inspect",
  params: DesignIssue["params"] = {},
): DesignIssue {
  return { code, severity: "error", path, params, action };
}

function blocked(issues: readonly DesignIssue[]): DesignSaveOutcome {
  return { status: "blocked", issues: finalizeDesignIssues(issues).issues };
}

function waiting(job: DesignJob, issues: readonly DesignIssue[]): DesignSaveOutcome {
  return { status: "waiting", job, issues: finalizeDesignIssues(issues).issues };
}

function compensationBlocked(issues: readonly DesignIssue[]): DesignCompensationOutcome {
  return { status: "blocked", issues: finalizeDesignIssues(issues).issues };
}

function compensationWaiting(
  job: DesignJob,
  issues: readonly DesignIssue[],
): DesignCompensationOutcome {
  return { status: "waiting", job, issues: finalizeDesignIssues(issues).issues };
}

function invalidRead(): { status: "invalid"; error: string } {
  return { status: "invalid", error: "" };
}

/**
 * Bound every host call. A timeout resolves the caller with the failure value; the original
 * promise may still settle later, but its result is ignored. No timer keeps the promise pending.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => T): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  const { promise: bounded, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
  promise.then(
    (value) => {
      clearTimeout(timer);
      resolve(value);
    },
    (error) => {
      clearTimeout(timer);
      reject(error);
    },
  );
  return bounded;
}

async function bounded<T>(
  call: () => Promise<T>,
  timeoutMs: number,
  fallback: () => T,
): Promise<T> {
  try {
    return await withTimeout(call(), timeoutMs, fallback);
  } catch {
    return fallback();
  }
}

function timeoutOf(deps: DesignSaveDeps): number {
  return deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

async function readFresh(gateway: DesignSaveGateway, timeoutMs: number): Promise<FreshRead> {
  const [roles, teams, preferences] = await Promise.all([
    bounded(() => gateway.readRoles(), timeoutMs, invalidRead),
    bounded(() => gateway.readTeams(), timeoutMs, invalidRead),
    bounded(() => gateway.readPreferences(), timeoutMs, invalidRead),
  ]);
  if (roles.status !== "ready" || teams.status !== "ready" || preferences.status !== "ready") {
    return {
      ok: false,
      issues: [issue("DESIGN_SETTINGS_INVALID", ["settings"], "refresh")],
    };
  }
  return { ok: true, roles, teams, preferences };
}

async function readBack(
  gateway: DesignSaveGateway,
  result: DesignResult,
  timeoutMs: number,
): Promise<SavedDesignCheck | null> {
  const [roles, teams] = await Promise.all([
    bounded(() => gateway.readRoles(), timeoutMs, invalidRead),
    bounded(() => gateway.readTeams(), timeoutMs, invalidRead),
  ]);
  if (roles.status !== "ready" || teams.status !== "ready") return null;
  return verifySavedDesign({ roles: roles.values, teams: teams.values, result });
}

async function readPair(gateway: DesignSaveGateway, timeoutMs: number): Promise<ReadPair> {
  const [roles, teams] = await Promise.all([
    bounded(() => gateway.readRoles(), timeoutMs, invalidRead),
    bounded(() => gateway.readTeams(), timeoutMs, invalidRead),
  ]);
  if (roles.status !== "ready" || teams.status !== "ready") return { ok: false };
  return { ok: true, roles, teams };
}

async function tryMarkSaved(
  gateway: DesignSaveGateway,
  input: { jobId: string; resultId: string },
  leaseId: string | undefined,
  timeoutMs: number,
) {
  return bounded(
    () =>
      gateway.markSaved({
        jobId: input.jobId,
        resultId: input.resultId,
        ...(leaseId ? { leaseId } : {}),
      }),
    timeoutMs,
    () => null,
  );
}

/**
 * Tell the server what actually happened. The reply's job carries the read-back saveState; a
 * failed receipt never changes the local result or triggers another write.
 */
async function recordFailure(
  gateway: DesignSaveGateway,
  input: { jobId: string; resultId: string },
  job: DesignJob,
  phase: "roles" | "team" | "compensation",
  reason:
    | "conflict-exhausted"
    | "write-failed"
    | "unknown"
    | "compensated"
    | "partial"
    | "canceled",
  leaseId: string | undefined,
  timeoutMs: number,
): Promise<DesignJob> {
  if (!leaseId) return job;
  const reply = await bounded(
    () =>
      gateway.saveFailed({
        jobId: input.jobId,
        resultId: input.resultId,
        leaseId,
        phase,
        reason,
      }),
    timeoutMs,
    () => null,
  );
  return reply?.ok ? reply.job : job;
}

/**
 * Confirm the receipt. If markSaved is lost after a committed write, read back and retry only the
 * receipt; the Team is never written again. A failed receipt retry is reported as waiting.
 */
async function complete(
  gateway: DesignSaveGateway,
  input: { jobId: string; resultId: string },
  job: DesignJob,
  leaseId: string | undefined,
  result: DesignResult | undefined,
  timeoutMs: number,
): Promise<DesignSaveOutcome> {
  const first = await tryMarkSaved(gateway, input, leaseId, timeoutMs);
  if (first?.ok) {
    const teamId = first.job.savedTeamId ?? result?.team.id ?? job.savedTeamId;
    if (teamId) return { status: "saved", teamId };
    return waiting(first.job, [issue("DESIGN_SAVE_UNKNOWN", ["save"], "inspect")]);
  }
  if (result) {
    const check = await readBack(gateway, result, timeoutMs);
    if (check?.kind === "committed") {
      const second = await tryMarkSaved(gateway, input, leaseId, timeoutMs);
      if (second?.ok) {
        return { status: "saved", teamId: second.job.savedTeamId ?? check.teamId };
      }
      return waiting(
        second && !second.ok ? (second.job ?? job) : job,
        second && !second.ok ? second.issues : [issue("DESIGN_SAVE_UNKNOWN", ["save"], "inspect")],
      );
    }
    if (check?.kind === "conflict") return waiting(job, check.issues);
  }
  const current = first && !first.ok ? (first.job ?? job) : job;
  const issues = first && !first.ok ? first.issues : [];
  return waiting(
    current,
    issues.length > 0 ? issues : [issue("DESIGN_SAVE_UNKNOWN", ["save"], "inspect")],
  );
}

/**
 * An explicit invalid/failed write is never retried blindly. Read back: a committed Team only
 * needs its receipt; anything else records the partial state through saveFailed. Nothing is
 * deleted and no compensation runs here.
 */
async function settleUnknown(
  gateway: DesignSaveGateway,
  input: { jobId: string; resultId: string },
  job: DesignJob,
  result: DesignResult,
  leaseId: string | undefined,
  write: Extract<DesignWriteResult, "invalid" | "failed">,
  phase: "roles" | "team",
  timeoutMs: number,
): Promise<DesignSaveOutcome> {
  const check = await readBack(gateway, result, timeoutMs);
  if (check?.kind === "committed") {
    return complete(gateway, input, job, leaseId, result, timeoutMs);
  }
  const reason = write === "invalid" ? "write-failed" : "unknown";
  const uncommitted =
    phase === "team" || write === "failed" || (check?.kind !== undefined && check.kind !== "none");
  const recorded = uncommitted
    ? await recordFailure(gateway, input, job, phase, reason, leaseId, timeoutMs)
    : job;
  if (check?.kind === "conflict") return waiting(recorded, check.issues);
  return waiting(recorded, [
    issue(
      write === "invalid" ? "DESIGN_SAVE_FAILED" : "DESIGN_SAVE_UNKNOWN",
      ["save", phase],
      "inspect",
      { phase, result: check?.kind ?? "unreadable" },
    ),
  ]);
}

async function exhausted(
  gateway: DesignSaveGateway,
  input: { jobId: string; resultId: string },
  job: DesignJob,
  phase: "roles" | "team",
  leaseId: string,
  timeoutMs: number,
): Promise<DesignSaveOutcome> {
  const current = await recordFailure(
    gateway,
    input,
    job,
    phase,
    "conflict-exhausted",
    leaseId,
    timeoutMs,
  );
  return waiting(current, [
    issue("DESIGN_SAVE_CONFLICT", ["save", phase], "retry-save", { phase }),
  ]);
}

function leaseExpired(expiresAt: string, now: () => number): boolean {
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) && now() >= expiry;
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function rawRows(raw: unknown, key: "roles" | "teams"): unknown[] {
  const rows = asRecord(raw)[key];
  return Array.isArray(rows) ? rows : [];
}

function appendRows(
  raw: unknown,
  key: "roles" | "teams",
  rows: readonly unknown[],
): Record<string, unknown> {
  return { ...asRecord(raw), [key]: [...rawRows(raw, key), ...rows] };
}

function roleIdOf(row: unknown): string | undefined {
  if (!row || typeof row !== "object") return undefined;
  const id = (row as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}

function removeRoles(raw: unknown, remove: ReadonlySet<string>): Record<string, unknown> {
  return {
    ...asRecord(raw),
    roles: rawRows(raw, "roles").filter((row) => {
      const id = roleIdOf(row);
      return !(id && remove.has(id));
    }),
  };
}

function referencedRoleIds(teams: readonly Team[]): Set<string> {
  const ids = new Set<string>();
  for (const team of teams) {
    ids.add(team.coordinatorRoleId);
    for (const member of team.members) ids.add(member.roleId);
    if (team.collaboration) {
      if (typeof team.collaboration.judgeRoleId === "string") {
        ids.add(team.collaboration.judgeRoleId);
      }
      if (typeof team.collaboration.escalationRoleId === "string") {
        ids.add(team.collaboration.escalationRoleId);
      }
    }
  }
  return ids;
}

function abortedOutcome(job: DesignJob | undefined, writeAttempted: boolean): DesignSaveOutcome {
  if (writeAttempted && job) {
    return waiting(job, [issue("DESIGN_SAVE_UNKNOWN", ["save"], "none")]);
  }
  if (job) return waiting(job, [issue("DESIGN_NOT_SAVED", ["save"], "retry-save")]);
  return blocked([issue("DESIGN_NOT_SAVED", ["save"], "retry-save")]);
}

/**
 * Save one prepared design: fresh reads paired with their revisions, Role CAS first, then
 * re-prepare/fresh read/merge, then the Team CAS. Only explicit conflicts retry (three per
 * phase); failed, invalid, and timed-out writes are read back and recorded through saveFailed.
 * This function keeps no state between calls and never deletes anything.
 */
export async function saveDesign(
  input: { jobId: string; resultId: string; clientId: string },
  deps: DesignSaveDeps,
): Promise<DesignSaveOutcome> {
  const { gateway, signal, now, unknownWrites } = deps;
  const timeoutMs = timeoutOf(deps);
  let leaseId: string | undefined;
  let job: DesignJob | undefined;
  let rolesCommitted = false;
  let writeAttempted = false;
  let roleConflicts = 0;
  let teamConflicts = 0;
  let leaseRetries = 0;
  let steps = 0;

  const aborted = () => signal?.aborted === true;
  const canceledOutcome = async (): Promise<DesignSaveOutcome> => {
    if (!rolesCommitted || !job) return abortedOutcome(job, writeAttempted);
    const recorded = await recordFailure(
      gateway,
      input,
      job,
      "team",
      "canceled",
      leaseId,
      timeoutMs,
    );
    return waiting(recorded, [issue("DESIGN_SAVE_UNKNOWN", ["save"], "none")]);
  };
  const failAfterRoles = async (issues: readonly DesignIssue[], reason: "partial" | "canceled") => {
    if (!rolesCommitted || !job) return blocked(issues);
    const recorded = await recordFailure(gateway, input, job, "team", reason, leaseId, timeoutMs);
    return waiting(recorded, issues);
  };

  while (steps < MAX_STEPS) {
    steps += 1;
    if (aborted()) return canceledOutcome();

    const preparedReply = await bounded(
      () =>
        gateway.prepareSave({
          jobId: input.jobId,
          resultId: input.resultId,
          clientId: input.clientId,
          ...(leaseId ? { leaseId } : {}),
        }),
      timeoutMs,
      () => null,
    );
    if (!preparedReply) {
      return failAfterRoles([issue("DESIGN_SAVE_FAILED", ["prepare"], "retry-save")], "partial");
    }
    if (!preparedReply.ok) {
      return failAfterRoles(preparedReply.issues, "partial");
    }

    const prepared = preparedReply.prepared;
    job = prepared.job;
    if (prepared.outcome === "already-saved") {
      return complete(gateway, input, prepared.job, undefined, undefined, timeoutMs);
    }
    if (prepared.outcome === "compensate") {
      // saveDesign never asks to compensate; writing a Team under that lease is forbidden.
      return failAfterRoles(
        [issue("DESIGN_SAVE_UNKNOWN", ["prepare"], "inspect", { outcome: "compensate" })],
        "partial",
      );
    }
    leaseId = prepared.lease.id;

    if (leaseExpired(prepared.lease.expiresAt, now)) {
      leaseRetries += 1;
      if (leaseRetries >= MAX_LEASE_RETRIES) {
        return failAfterRoles(
          [issue("DESIGN_SAVE_LEASE_EXPIRED", ["prepare"], "retry-save")],
          rolesCommitted ? "partial" : "canceled",
        );
      }
      continue;
    }
    leaseRetries = 0;

    const fresh = await readFresh(gateway, timeoutMs);
    if (!fresh.ok) return failAfterRoles(fresh.issues, "partial");

    const merged = mergeDesign({
      roles: fresh.roles,
      teams: fresh.teams,
      preferences: fresh.preferences,
      result: prepared.result,
      base: prepared.base,
    });
    if (merged.kind === "blocked") {
      if (!merged.issues.every((entry) => entry.code === "DESIGN_SAVE_CONFLICT")) {
        return failAfterRoles(merged.issues, "partial");
      }
      if (rolesCommitted) {
        teamConflicts += 1;
        if (teamConflicts >= MAX_CONFLICT_RETRIES) {
          return exhausted(gateway, input, job, "team", leaseId, timeoutMs);
        }
      } else {
        roleConflicts += 1;
        if (roleConflicts >= MAX_CONFLICT_RETRIES) {
          return exhausted(gateway, input, job, "roles", leaseId, timeoutMs);
        }
      }
      continue;
    }
    if (merged.kind === "already-saved") {
      return complete(gateway, input, job, leaseId, prepared.result, timeoutMs);
    }

    if (merged.rolesChanged) {
      if (aborted()) return canceledOutcome();
      if (leaseExpired(prepared.lease.expiresAt, now)) continue;
      writeAttempted = true;
      const rows = merged.addedRoleIds
        .map((id) => merged.roles.roles.find((role) => role.id === id))
        .filter((role): role is Role => role !== undefined);
      const write = await bounded(
        () => gateway.saveRoles(appendRows(fresh.roles.raw, "roles", rows), fresh.roles.revision),
        timeoutMs,
        () => "failed" as const,
      );
      if (write === "saved") {
        rolesCommitted = true;
        await bounded(
          () => gateway.reloadRoles(),
          timeoutMs,
          () => undefined,
        );
        continue;
      }
      if (write === "conflict") {
        roleConflicts += 1;
        if (roleConflicts >= MAX_CONFLICT_RETRIES) {
          return exhausted(gateway, input, job, "roles", leaseId, timeoutMs);
        }
        await bounded(
          () => gateway.reloadRoles(),
          timeoutMs,
          () => undefined,
        );
        continue;
      }
      if (write === "failed") unknownWrites?.mark(input.jobId);
      return settleUnknown(
        gateway,
        input,
        job,
        prepared.result,
        leaseId,
        write,
        "roles",
        timeoutMs,
      );
    }

    if (aborted()) return canceledOutcome();
    if (leaseExpired(prepared.lease.expiresAt, now)) continue;
    const team = merged.teams.teams.find((candidate) => candidate.id === merged.teamId);
    if (!merged.teamsChanged || !team) {
      return complete(gateway, input, job, leaseId, prepared.result, timeoutMs);
    }
    writeAttempted = true;
    const write = await bounded(
      () => gateway.saveTeams(appendRows(fresh.teams.raw, "teams", [team]), fresh.teams.revision),
      timeoutMs,
      () => "failed" as const,
    );
    if (write === "saved") {
      return complete(gateway, input, job, leaseId, prepared.result, timeoutMs);
    }
    if (write === "conflict") {
      teamConflicts += 1;
      if (teamConflicts >= MAX_CONFLICT_RETRIES) {
        return exhausted(gateway, input, job, "team", leaseId, timeoutMs);
      }
      await bounded(
        () => gateway.reloadTeams(),
        timeoutMs,
        () => undefined,
      );
      continue;
    }
    if (write === "failed") unknownWrites?.mark(input.jobId);
    return settleUnknown(gateway, input, job, prepared.result, leaseId, write, "team", timeoutMs);
  }

  if (job) {
    const recorded = rolesCommitted
      ? await recordFailure(gateway, input, job, "team", "unknown", leaseId, timeoutMs)
      : job;
    return waiting(recorded, [issue("DESIGN_SAVE_UNKNOWN", ["save"], "inspect")]);
  }
  return blocked([issue("DESIGN_SAVE_FAILED", ["save"], "retry-save")]);
}

/**
 * Execute the explicit compensation path. Only Roles authorized by the server and proven by
 * planDesignCompensation to be this job's untouched, unreferenced rows are removed. Unknown
 * writes never delete; a race that re-references a removed Role restores only missing own Roles.
 */
export async function compensateDesign(
  input: { jobId: string; resultId: string; clientId: string },
  deps: DesignSaveDeps,
): Promise<DesignCompensationOutcome> {
  const { gateway, signal, now, unknownWrites } = deps;
  const timeoutMs = timeoutOf(deps);
  let leaseId: string | undefined;
  let job: DesignJob | undefined;
  let conflicts = 0;
  let leaseRetries = 0;
  let steps = 0;
  let writeAttempted = false;

  const aborted = () => signal?.aborted === true;

  while (steps < MAX_STEPS) {
    steps += 1;
    if (aborted()) {
      return writeAttempted && job
        ? compensationWaiting(job, [issue("DESIGN_SAVE_UNKNOWN", ["compensation"], "none")])
        : compensationBlocked([issue("DESIGN_NOT_SAVED", ["compensation"], "retry-save")]);
    }

    const preparedReply = await bounded(
      () =>
        gateway.prepareSave({
          jobId: input.jobId,
          resultId: input.resultId,
          clientId: input.clientId,
          intent: "compensate",
          ...(leaseId ? { leaseId } : {}),
        }),
      timeoutMs,
      () => null,
    );
    if (!preparedReply) {
      return compensationBlocked([issue("DESIGN_SAVE_FAILED", ["prepare"], "retry-save")]);
    }
    if (!preparedReply.ok) return compensationBlocked(preparedReply.issues);

    const prepared = preparedReply.prepared;
    if (prepared.outcome === "already-saved") {
      return compensationWaiting(prepared.job, [
        issue("DESIGN_SAVED_MODIFIED", ["prepare"], "inspect", { outcome: "already-saved" }),
      ]);
    }
    if (prepared.outcome !== "compensate") {
      return compensationBlocked([
        issue("DESIGN_COMPENSATION_UNSAFE", ["prepare"], "inspect", {
          outcome: prepared.outcome,
        }),
      ]);
    }
    job = prepared.job;
    const activeJob = prepared.job;
    leaseId = prepared.lease.id;
    if (unknownWrites?.has(input.jobId)) {
      return compensationWaiting(job, [
        issue("DESIGN_SAVE_UNKNOWN", ["compensation"], "inspect", { reason: "unknown-write" }),
      ]);
    }

    if (leaseExpired(prepared.lease.expiresAt, now)) {
      leaseRetries += 1;
      if (leaseRetries >= MAX_LEASE_RETRIES) {
        return compensationWaiting(job, [
          issue("DESIGN_SAVE_LEASE_EXPIRED", ["prepare"], "retry-save"),
        ]);
      }
      continue;
    }
    leaseRetries = 0;

    const fresh = await readFresh(gateway, timeoutMs);
    if (!fresh.ok) return compensationBlocked(fresh.issues);
    if (
      fresh.roles.revision !== prepared.base.roles ||
      fresh.teams.revision !== prepared.base.teams ||
      fresh.preferences.revision !== prepared.base.preferences
    ) {
      conflicts += 1;
      if (conflicts >= MAX_CONFLICT_RETRIES) {
        return compensationWaiting(job, [
          issue("DESIGN_SAVE_CONFLICT", ["compensation"], "retry-save"),
        ]);
      }
      continue;
    }

    const check = verifySavedDesign({
      roles: fresh.roles.values,
      teams: fresh.teams.values,
      result: prepared.result,
    });
    if (check.kind === "committed") {
      return compensationWaiting(job, [
        issue("DESIGN_SAVED_MODIFIED", ["compensation"], "inspect", { state: check.kind }),
      ]);
    }
    if (check.kind === "conflict") return compensationWaiting(job, check.issues);

    const plan = planDesignCompensation({
      roles: { values: fresh.roles.values, revision: fresh.roles.revision },
      teams: { values: fresh.teams.values, revision: fresh.teams.revision },
      result: prepared.result,
      authorizedRoleIds: prepared.removableRoleIds,
    });
    if (plan.removeRoleIds.length === 0) {
      if (plan.issues.length > 0) return compensationWaiting(job, plan.issues);
      if (plan.retainedRoleIds.length > 0) {
        return compensationWaiting(job, [
          issue("DESIGN_COMPENSATION_UNSAFE", ["compensation"], "inspect", {
            retained: plan.retainedRoleIds.length,
          }),
        ]);
      }
      const recorded = await recordFailure(
        gateway,
        input,
        job,
        "compensation",
        "compensated",
        leaseId,
        timeoutMs,
      );
      return {
        status: "compensated",
        job: recorded,
        removedRoleIds: [],
        retainedRoleIds: plan.retainedRoleIds,
      };
    }
    if (aborted()) {
      return compensationWaiting(job, [issue("DESIGN_NOT_SAVED", ["compensation"], "retry-save")]);
    }
    if (leaseExpired(prepared.lease.expiresAt, now)) {
      leaseRetries += 1;
      if (leaseRetries >= MAX_LEASE_RETRIES) {
        return compensationWaiting(job, [
          issue("DESIGN_SAVE_LEASE_EXPIRED", ["compensation"], "retry-save"),
        ]);
      }
      continue;
    }

    writeAttempted = true;
    const remove = new Set(plan.removeRoleIds);
    const write = await bounded(
      () => gateway.saveRoles(removeRoles(fresh.roles.raw, remove), fresh.roles.revision),
      timeoutMs,
      () => "failed" as const,
    );
    if (write === "conflict") {
      conflicts += 1;
      if (conflicts >= MAX_CONFLICT_RETRIES) {
        const recorded = await recordFailure(
          gateway,
          input,
          job,
          "compensation",
          "conflict-exhausted",
          leaseId,
          timeoutMs,
        );
        return compensationWaiting(recorded, [
          issue("DESIGN_SAVE_CONFLICT", ["compensation"], "retry-save"),
        ]);
      }
      continue;
    }
    const finishDelete = async (
      after: ReadPairReady,
      activeJob: DesignJob,
    ): Promise<DesignCompensationOutcome> => {
      const referenced = referencedRoleIds(after.teams.values.teams);
      const needsRestore = plan.removeRoleIds.some((roleId) => referenced.has(roleId));
      if (needsRestore) {
        const missing = prepared.result.newRoles.filter(
          (candidate) => !after.roles.values.roles.some((role) => role.id === candidate.id),
        );
        if (missing.length > 0) {
          const restore = await bounded(
            () =>
              gateway.saveRoles(
                appendRows(after.roles.raw, "roles", missing),
                after.roles.revision,
              ),
            timeoutMs,
            () => "failed" as const,
          );
          const recorded = await recordFailure(
            gateway,
            input,
            activeJob,
            "compensation",
            restore === "saved" ? "partial" : "unknown",
            leaseId,
            timeoutMs,
          );
          return compensationWaiting(recorded, [
            issue("DESIGN_COMPENSATION_UNSAFE", ["compensation"], "inspect", {
              restored: restore === "saved",
            }),
          ]);
        }
      }

      const finalCheck = verifySavedDesign({
        roles: after.roles.values,
        teams: after.teams.values,
        result: prepared.result,
      });
      const removed = plan.removeRoleIds.filter(
        (roleId) => !after.roles.values.roles.some((role) => role.id === roleId),
      );
      const clean =
        finalCheck.kind === "none" &&
        plan.issues.length === 0 &&
        removed.length === plan.removeRoleIds.length;
      const recorded = await recordFailure(
        gateway,
        input,
        activeJob,
        "compensation",
        clean ? "compensated" : "partial",
        leaseId,
        timeoutMs,
      );
      if (clean) {
        return {
          status: "compensated",
          job: recorded,
          removedRoleIds: plan.removeRoleIds,
          retainedRoleIds: plan.retainedRoleIds,
        };
      }
      return compensationWaiting(recorded, [
        ...plan.issues,
        issue("DESIGN_COMPENSATION_UNSAFE", ["compensation"], "inspect", {
          state: finalCheck.kind,
          remaining: plan.removeRoleIds.length - removed.length,
        }),
      ]);
    };

    if (write !== "saved") {
      const after = await readPair(gateway, timeoutMs);
      if (after.ok) {
        const remaining = plan.removeRoleIds.filter((roleId) =>
          after.roles.values.roles.some((role) => role.id === roleId),
        );
        if (remaining.length === plan.removeRoleIds.length) {
          const recorded = await recordFailure(
            gateway,
            input,
            job,
            "compensation",
            write === "invalid" ? "write-failed" : "unknown",
            leaseId,
            timeoutMs,
          );
          return compensationWaiting(recorded, [
            issue(
              write === "invalid" ? "DESIGN_SAVE_FAILED" : "DESIGN_SAVE_UNKNOWN",
              ["compensation"],
              "inspect",
            ),
          ]);
        }
        return finishDelete(after, activeJob);
      }
      const recorded = await recordFailure(
        gateway,
        input,
        job,
        "compensation",
        "unknown",
        leaseId,
        timeoutMs,
      );
      return compensationWaiting(recorded, [
        issue("DESIGN_SAVE_UNKNOWN", ["compensation"], "inspect"),
      ]);
    }

    const after = await readPair(gateway, timeoutMs);
    if (!after.ok) {
      const recorded = await recordFailure(
        gateway,
        input,
        job,
        "compensation",
        "unknown",
        leaseId,
        timeoutMs,
      );
      return compensationWaiting(recorded, [
        issue("DESIGN_SAVE_UNKNOWN", ["compensation"], "inspect"),
      ]);
    }
    return finishDelete(after, activeJob);
  }

  if (job) {
    return compensationWaiting(job, [issue("DESIGN_SAVE_UNKNOWN", ["compensation"], "inspect")]);
  }
  return compensationBlocked([issue("DESIGN_SAVE_FAILED", ["compensation"], "retry-save")]);
}

import { cancelPending } from "../../shared/domain/run-engine/cancel-request";
import { answerableActions } from "../../shared/domain/run-engine/decision-answer";
import { occupiesExecutionSlot } from "../../shared/domain/run-engine/invariants";
import type { RunRecord, RunTaskRecord } from "../../shared/schemas/run-engine/ledger";
import {
  type RunDetailView,
  RunDetailViewSchema,
  type RunHistoryEntryView,
  type RunHistoryPage,
  type RunIssueView,
  type RunSummaryView,
  RunSummaryViewSchema,
  type RunTaskView,
  runHistoryCursorExpiredIssue,
} from "../../shared/schemas/run-engine/rpc";
import { RUN_ACTION_CONTROLS } from "../../shared/schemas/run-engine/rpc-actions";

/**
 * Ledger record -> redacted view DTOs. Pure and read-only.
 *
 * Nothing here copies a nonce, a prompt, an outbox payload, an event payload or a decision's control
 * digest: every field is picked by name, never spread, so a field a newer writer added cannot leak.
 */

export const OBSERVATION_CAPABILITIES = {
  runEngine: 1,
  observationOnly: true,
  enabled: false,
  supportedControls: [] as string[],
} as const;

/**
 * The controls this Run can use right now, from its own ledger. Only the controls that exist are ever
 * named: `kick` while the Run is live, `replan` while it waits for a plan a person must ask for again,
 * `decide` while a decision of a kind this build can answer is waiting, `pause` while the Run is
 * active and `resume` while it is paused, `cancel` until a cancellation is asked for. While one is
 * pending only `kick` is left.
 */
export function supportedControlsOf(
  record: Pick<RunRecord, "lifecycle" | "decisions"> & {
    launch?: Pick<RunRecord["launch"], "state">;
  },
): string[] {
  const live = record.lifecycle !== "finished" && record.lifecycle !== "cancelled";
  // A cancellation that was asked for (or that cannot be read) decides the rest: kick still looks.
  const cancelling = cancelPending(record);
  const starting = record.launch?.state === "preparing" || record.launch?.state === "creating";
  const usable: Record<(typeof RUN_ACTION_CONTROLS)[number], boolean> = {
    replan: record.lifecycle === "awaiting-dag" && !cancelling,
    decide:
      !cancelling &&
      record.decisions.some((decision) => answerableActions(record, decision).length > 0),
    kick: live,
    pause: record.lifecycle === "active" && !cancelling,
    resume: record.lifecycle === "paused" && !cancelling,
    cancel: live && !cancelling && !starting,
  };
  return RUN_ACTION_CONTROLS.filter((name) => usable[name]);
}

export const HISTORY_PAGE_SIZE = 50;

const TERMINAL_TASK_STATES = new Set(["done", "failed", "cancelled"]);

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function unresolvedPermissionAgent(record: RunRecord, agentId: string): boolean {
  const resolved = new Set(
    record.eventReceipts.filter((r) => r.kind === "permission_resolved").map((r) => r.eventKey),
  );
  return record.eventReceipts.some(
    (receipt) =>
      receipt.kind === "permission_requested" &&
      receipt.agentId === agentId &&
      !resolved.has(receipt.eventKey.replace(/^permission_requested:/u, "permission_resolved:")),
  );
}

function blockedBy(record: RunRecord, task: RunTaskRecord): RunTaskView["blockedBy"] {
  if (TERMINAL_TASK_STATES.has(task.state)) return null;
  const byId = new Map(record.tasks.map((entry) => [entry.spec.id, entry]));
  if (task.state === "pending") {
    const dep = task.spec.deps.find((id) => byId.get(id)?.state !== "done");
    if (dep !== undefined) return { kind: "dependency", ref: clip(dep, 128) };
  }
  if (task.phase === "frozen" || (task.state === "blocked" && task.frozenClaimId !== null)) {
    return { kind: "lock", ref: task.frozenClaimId };
  }
  const decision = record.decisions.find(
    (entry) =>
      entry.subjectId === task.spec.id &&
      (entry.state === "open" || entry.state === "waiting-human"),
  );
  if (decision) return { kind: "decision", ref: decision.decisionId };
  const assignment = record.assignments.find(
    (entry) => entry.assignmentId === task.currentAssignmentId,
  );
  if (assignment && unresolvedPermissionAgent(record, assignment.agentId)) {
    return { kind: "permission", ref: clip(assignment.agentId, 128) };
  }
  if (task.waitingReason !== null) return { kind: "other", ref: null };
  return null;
}

function taskView(record: RunRecord, task: RunTaskRecord): RunTaskView {
  const assignment = record.assignments.find(
    (entry) => entry.assignmentId === task.currentAssignmentId,
  );
  const last = task.escalations.at(-1);
  return {
    taskId: task.spec.id,
    title: task.spec.title,
    state: task.state,
    phase: task.phase ?? null,
    level: task.spec.level,
    tier: task.spec.tier,
    execution: task.spec.execution,
    assignee: assignment
      ? {
          seatId: assignment.seatId,
          agentId: assignment.agentId,
          profileId: assignment.profileId,
          profileName: assignment.profileName,
          provider: assignment.provider,
          model: assignment.model,
          channelId: assignment.channelId,
        }
      : null,
    attempts: task.attempts,
    protocolFailures: task.protocolFailures,
    evidenceReturns: task.evidenceReturns,
    reworkCount: task.reworkCount,
    qualityFailures: task.qualityFailures,
    currentTier: last?.toTier ?? task.spec.tier,
    escalations: task.escalations.map((entry) => ({
      fromTier: entry.fromTier,
      toTier: entry.toTier,
      atAttempt: entry.atAttempt,
      qualityFailures: entry.qualityFailures,
      at: entry.at,
    })),
    blockedBy: blockedBy(record, task),
    waitingReason: task.waitingReason,
    frozen: task.phase === "frozen",
  };
}

function layers(record: RunRecord): Map<string, number> {
  const byId = new Map(record.tasks.map((task) => [task.spec.id, task]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    // A cycle or a missing dependency yields 0 here; the view schema then refuses the projection.
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let deepest = -1;
    for (const dep of byId.get(id)?.spec.deps ?? []) {
      if (byId.has(dep)) deepest = Math.max(deepest, visit(dep));
    }
    visiting.delete(id);
    depth.set(id, deepest + 1);
    return deepest + 1;
  };
  for (const id of byId.keys()) visit(id);
  return depth;
}

export type ProjectedDetail =
  | { ok: true; view: RunDetailView }
  | { ok: false; issues: RunIssueView[] };

function projectionInvalid(): RunIssueView {
  return {
    code: "run-projection-invalid",
    severity: "error",
    path: [],
    params: {},
    action: "inspect",
  };
}

export function projectDetail(record: RunRecord): ProjectedDetail {
  const depth = layers(record);
  const tasks = record.tasks.map((task) => taskView(record, task));
  const active = record.tasks.filter((task) => occupiesExecutionSlot(record, task)).length;
  const frozen = record.tasks.filter(
    (task) =>
      (task.state === "blocked" || task.state === "failed") &&
      record.resources.some((claim) => claim.taskId === task.spec.id),
  ).length;
  const candidate = {
    runId: record.runId,
    revision: record.revision,
    lifecycle: record.lifecycle,
    team: {
      id: record.team.id,
      name: record.team.name,
      rawMode: record.team.rawMode,
      modeContract: record.team.modeContract,
      plannerVersion: record.team.plannerVersion,
    },
    dagRevision: record.dagRevision,
    dag: {
      revision: record.dagRevision,
      tasks: record.tasks.map((task) => ({
        taskId: task.spec.id,
        title: task.spec.title,
        layer: depth.get(task.spec.id) ?? 0,
        deps: [...task.spec.deps],
        state: task.state,
      })),
    },
    tasks,
    locks: record.resources.map((claim) => ({
      claimId: claim.claimId,
      taskId: claim.taskId,
      repoId: claim.repoId,
      kind: claim.kind,
      path: claim.path,
      access: claim.access,
      frozen: claim.frozen,
    })),
    capacity: {
      configuredLimit: record.policy.configuredConcurrency,
      effectiveLimit: record.policy.configuredConcurrency + frozen,
      inUse: active,
    },
    budgets: record.budgets.entries.map((entry) => ({
      scope: entry.scope,
      subjectId: entry.subjectId,
      limit: entry.limit,
      reserved: entry.reserved,
      confirmed: entry.confirmed,
      observedTurns: entry.observedTurns,
    })),
    decisions: record.decisions.map((decision) => ({
      decisionId: decision.decisionId,
      category: decision.category,
      state: decision.state,
      subjectId: decision.subjectId,
      summary: decision.summary,
      createdAt: decision.createdAt,
      answeredAction: decision.answer?.action ?? null,
      actions: answerableActions(record, decision),
    })),
    channels: record.channels.map((channel) => ({
      channelId: channel.channelId,
      state: channel.state,
      unavailableUntil: channel.unavailableUntil,
      code: channel.code,
      source: channel.source,
      observedAt: channel.observedAt,
    })),
    alerts: record.alerts.map((alert) => ({
      alertId: alert.alertId,
      state: alert.state,
      severity: alert.severity,
      summary: alert.summary,
      createdAt: alert.createdAt,
    })),
    metrics: {
      strategicTurns: record.metrics.strategicTurns,
      workerEvents: record.metrics.workerEvents,
      decisions: record.metrics.decisions,
      tasks: record.metrics.tasks,
      reworks: record.metrics.reworks,
      firstReviewAccepted: record.metrics.firstReviewAccepted,
      coverage: record.metrics.coverage,
    },
    capabilities: { ...OBSERVATION_CAPABILITIES, supportedControls: supportedControlsOf(record) },
    issues: [] as RunIssueView[],
  };
  const parsed = RunDetailViewSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, issues: [projectionInvalid()] };
  return { ok: true, view: parsed.data };
}

const ATTENTION_STATES = new Set(["failed", "blocked"]);

export function projectSummary(record: RunRecord): RunSummaryView | null {
  const stateCounts: Record<string, number> = {};
  for (const task of record.tasks) stateCounts[task.state] = (stateCounts[task.state] ?? 0) + 1;
  const needsAttention =
    record.tasks.some((task) => ATTENTION_STATES.has(task.state)) ||
    record.decisions.some((entry) => entry.state === "open" || entry.state === "waiting-human") ||
    record.alerts.some((alert) => alert.state === "open" && alert.severity !== "info");
  const parsed = RunSummaryViewSchema.safeParse({
    runId: record.runId,
    revision: record.revision,
    lifecycle: record.lifecycle,
    teamName: record.team.name,
    stateCounts,
    needsAttention,
    updatedAt: record.updatedAt,
  });
  return parsed.success ? parsed.data : null;
}

// --- history ------------------------------------------------------------------------------------

type CursorBody = { r: string; b: number; c: number };

/** Opaque, bound to run + position + checkpoint so a compacted history invalidates it. */
export function encodeHistoryCursor(runId: string, beforeSeq: number, checkpoint: number): string {
  const body: CursorBody = { r: runId, b: beforeSeq, c: checkpoint };
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

function decodeHistoryCursor(cursor: string): CursorBody | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null) return null;
    const { r, b, c } = value as Record<string, unknown>;
    if (typeof r !== "string" || !Number.isInteger(b) || !Number.isInteger(c)) return null;
    return { r, b: b as number, c: c as number };
  } catch {
    return null;
  }
}

function eventTaskId(payload: Record<string, unknown>): string | null {
  const direct = payload.taskId;
  if (typeof direct === "string" && direct.length > 0) return clip(direct, 64);
  const block = payload.block;
  if (typeof block === "object" && block !== null) {
    const nested = (block as Record<string, unknown>).taskId;
    if (typeof nested === "string" && nested.length > 0) return clip(nested, 64);
  }
  return null;
}

export function historyPage(
  record: RunRecord,
  cursor: string | undefined,
  limit: number = HISTORY_PAGE_SIZE,
): { page: RunHistoryPage; issues: RunIssueView[] } {
  const checkpoint = record.checkpoint?.throughSeq ?? 0;
  const issues: RunIssueView[] = [];
  let before = Number.POSITIVE_INFINITY;
  if (cursor !== undefined) {
    const decoded = decodeHistoryCursor(cursor);
    if (decoded && decoded.r === record.runId && decoded.c === checkpoint && decoded.b > 0) {
      before = decoded.b;
    } else {
      issues.push(runHistoryCursorExpiredIssue());
    }
  }
  const size = Math.min(Math.max(1, limit), HISTORY_PAGE_SIZE);
  const older = record.events.filter((event) => event.seq < before).sort((a, b) => b.seq - a.seq);
  const taken = older.slice(0, size);
  const hasMore = older.length > taken.length;
  const events: RunHistoryEntryView[] = taken
    .map((event) => ({
      seq: event.seq,
      kind: clip(event.kind, 64),
      at: event.at,
      taskId: eventTaskId(event.payload),
      // The kind is the whole summary: payloads can carry prompts or digests and are never exposed.
      summary: clip(event.kind, 600),
    }))
    .sort((a, b) => a.seq - b.seq);
  const oldest = events[0];
  return {
    page: {
      events,
      nextCursor:
        hasMore && oldest ? encodeHistoryCursor(record.runId, oldest.seq, checkpoint) : null,
      ...(record.checkpoint === undefined
        ? {}
        : { compactedThroughSeq: record.checkpoint.throughSeq }),
    },
    issues,
  };
}

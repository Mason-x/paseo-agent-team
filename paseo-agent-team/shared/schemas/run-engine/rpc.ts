import { z } from "zod";
import {
  RunDecisionAnswerActionSchema,
  RunIdRefSchema,
  RunIdSchema,
  RunPathSchema,
} from "./ledger";

/**
 * Run Engine RPC contracts (05 §8). Shapes only: nothing here registers a handler.
 *
 * Inputs are strict and carry `runContractVersion` (unknown versions are rejected with a readable
 * issue by the service). Outputs are NON-strict objects built from explicit, redacted view DTOs —
 * they never reuse ledger schemas, so passthrough storage fields (nonces, outbox payloads,
 * template arguments) cannot leak through a Get/List response. The two type families are not
 * interchangeable: a ledger record is not assignable to a view.
 */

export const RUN_CONTRACT_VERSION = 1;

const ContractShape = {
  runContractVersion: z.literal(RUN_CONTRACT_VERSION),
};

const Text = (max: number) => z.string().min(1).max(max);

export const RunIssueViewSchema = z.object({
  code: Text(64),
  severity: z.enum(["error", "warning", "info"]),
  path: z.array(z.union([z.string(), z.number().int()])),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  action: z.enum(["none", "refresh", "inspect", "retry", "acknowledge"]),
});
export type RunIssueView = z.infer<typeof RunIssueViewSchema>;

/**
 * run.get returns the first history page plus this issue when a `historyCursor` no longer matches
 * the run/event sequence (opaque cursor bound to runId + beforeSeq + checkpointThroughSeq). Paging
 * then restarts at the newest page.
 */
export const RUN_HISTORY_CURSOR_EXPIRED = "history-cursor-expired";

export function runHistoryCursorExpiredIssue(): RunIssueView {
  return {
    code: RUN_HISTORY_CURSOR_EXPIRED,
    severity: "warning",
    path: ["historyCursor"],
    params: {},
    action: "refresh",
  };
}

export const RunCapabilitiesSchema = z.object({
  runEngine: z.literal(1),
  /** Batch B: diagnose only; no writes, no task advance. */
  observationOnly: z.boolean(),
  enabled: z.boolean(),
  supportedControls: z.array(Text(64)).max(16),
});

export const RunTaskEscalationViewSchema = z.object({
  fromTier: Text(1),
  toTier: Text(1),
  atAttempt: z.number().int().nonnegative(),
  qualityFailures: z.number().int().nonnegative(),
  at: z.string().datetime(),
});

/**
 * Structured block source derived by R06 from the ledger (never parsed from waitingReason):
 * dependency→first unfinished dep taskId; decision→open decision id or null;
 * permission→agentId; lock→claimId; capacity/channel/seat as follows; other→null.
 * `channel` carries channelId; `seat`/`capacity` carry null; `other` carries null.
 */
export const RunTaskBlockedBySchema = z.object({
  kind: z.enum([
    "dependency",
    "decision",
    "other",
    "permission",
    "lock",
    "capacity",
    "channel",
    "seat",
  ]),
  ref: Text(128).nullable(),
});

/** Redacted task row. No nonce, no payload, no prompt. */
export const RunTaskViewSchema = z.object({
  taskId: Text(64),
  title: Text(120),
  state: Text(32),
  phase: Text(32).nullable(),
  level: Text(2),
  tier: Text(1),
  execution: z.enum(["write", "read"]),
  assignee: z
    .object({
      seatId: RunIdRefSchema,
      agentId: RunIdRefSchema,
      profileId: RunIdRefSchema,
      profileName: Text(200),
      provider: Text(64),
      model: Text(128).nullable(),
      channelId: Text(128),
    })
    .nullable(),
  attempts: z.number().int().nonnegative(),
  protocolFailures: z.number().int().nonnegative(),
  evidenceReturns: z.number().int().nonnegative(),
  reworkCount: z.number().int().nonnegative(),
  qualityFailures: z.number().int().nonnegative(),
  /** executionTier: last escalation's toTier, else the frozen spec tier. */
  currentTier: z.enum(["B", "A", "S"]),
  escalations: z.array(RunTaskEscalationViewSchema).max(2),
  /** Structured reason; waitingReason remains human-readable fallback. */
  blockedBy: RunTaskBlockedBySchema.nullable(),
  waitingReason: Text(600).nullable(),
  frozen: z.boolean(),
});
export type RunTaskView = z.infer<typeof RunTaskViewSchema>;

/** One DAG node: dependencies are task ids, layer is the topological depth (0 for no deps). */
export const RunDagTaskViewSchema = z.object({
  taskId: Text(64),
  title: Text(120),
  layer: z.number().int().nonnegative(),
  deps: z.array(Text(64)).max(64),
  state: Text(32),
});
export type RunDagTaskView = z.infer<typeof RunDagTaskViewSchema>;

export const RunDagViewSchema = z.object({
  revision: z.number().int().nonnegative(),
  tasks: z.array(RunDagTaskViewSchema).max(64),
});
export type RunDagView = z.infer<typeof RunDagViewSchema>;

/** A redacted history page: no payload, nonce, prompt, or assignment internals. */
export const RunHistoryEntryViewSchema = z.object({
  seq: z.number().int().nonnegative(),
  kind: Text(64),
  at: z.string().datetime(),
  taskId: Text(64).nullable(),
  summary: Text(600),
});
export type RunHistoryEntryView = z.infer<typeof RunHistoryEntryViewSchema>;

/**
 * History direction is frozen: the first page is the newest ≤50 events, events inside a page are
 * ascending by seq, and nextCursor walks toward older events. All history stays redacted.
 */
export const RunHistoryPageSchema = z.object({
  events: z.array(RunHistoryEntryViewSchema).max(50),
  nextCursor: Text(256).nullable(),
  /** Events up to this sequence number were folded into the checkpoint and are no longer listed. */
  compactedThroughSeq: z.number().int().nonnegative().optional(),
});

/** Frozen failure codes for R07 copy; lower-case hyphen style. */
export const RUN_READ_FAILURE_CODES = [
  "run-missing",
  "run-corrupt",
  "run-unknown-version",
  "run-projection-invalid",
] as const;
export type RunHistoryPage = z.infer<typeof RunHistoryPageSchema>;

export const RunLockViewSchema = z.object({
  claimId: RunIdRefSchema,
  taskId: Text(64),
  repoId: Text(256),
  /** hot/tool locks are named repo resources; path carries that name, not a repo path. */
  kind: z.enum(["file", "directory", "hot", "tool"]),
  path: RunPathSchema,
  access: z.enum(["read", "write"]),
  frozen: z.boolean(),
});

export const RunCapacityViewSchema = z.object({
  configuredLimit: z.number().int().positive(),
  effectiveLimit: z.number().int().positive(),
  inUse: z.number().int().nonnegative(),
});

export const RunBudgetViewSchema = z.object({
  scope: z.enum(["seat", "group"]),
  subjectId: RunIdRefSchema,
  limit: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative(),
  confirmed: z.number().int().nonnegative(),
  observedTurns: z.number().int().nonnegative(),
});

export const RunDecisionViewSchema = z.object({
  decisionId: z.string().uuid(),
  category: Text(2),
  /** Open string: newer servers may introduce kinds that older clients can still display. */
  kind: Text(32).optional(),
  state: z.enum(["open", "answered", "waiting-human", "superseded"]),
  subjectId: RunIdRefSchema.nullable(),
  summary: Text(4096),
  createdAt: z.string().datetime(),
  /** The accepted action when answered; null while open. */
  answeredAction: RunDecisionAnswerActionSchema.nullable(),
  /**
   * What a person can answer with right now (`run.decide`): empty, or absent from an older server,
   * when this build cannot answer it. Derived from the ledger by the server; the client only shows it.
   */
  actions: z.array(RunDecisionAnswerActionSchema).max(8).optional(),
});

export const RunChannelViewSchema = z.object({
  channelId: Text(128),
  state: z.enum(["available", "paused", "unknown"]),
  unavailableUntil: z.string().datetime().nullable(),
  code: Text(128).nullable(),
  source: z.enum(["structured-error", "human", "usage-source"]),
  observedAt: z.string().datetime(),
});

export const RunAlertViewSchema = z.object({
  alertId: RunIdRefSchema,
  state: z.enum(["open", "acknowledged", "resolved"]),
  severity: z.enum(["info", "warning", "critical"]),
  summary: Text(1000),
  createdAt: z.string().datetime(),
});

export const RunMetricsViewSchema = z.object({
  strategicTurns: z.number().int().nonnegative(),
  workerEvents: z.number().int().nonnegative(),
  decisions: z.number().int().nonnegative(),
  tasks: z.number().int().nonnegative(),
  reworks: z.number().int().nonnegative(),
  firstReviewAccepted: z.number().int().nonnegative(),
  coverage: z.enum(["complete", "partial", "unknown"]),
});

export const RunDetailViewSchema = z
  .object({
    runId: RunIdSchema,
    revision: z.number().int().nonnegative(),
    lifecycle: Text(32),
    team: z.object({
      id: Text(64),
      name: Text(200),
      rawMode: Text(64),
      modeContract: z.number().int().positive(),
      plannerVersion: z.number().int().positive(),
    }),
    dagRevision: z.number().int().nonnegative(),
    dag: RunDagViewSchema,
    tasks: z.array(RunTaskViewSchema).max(64),
    locks: z.array(RunLockViewSchema).max(4096),
    capacity: RunCapacityViewSchema,
    budgets: z.array(RunBudgetViewSchema).max(256),
    decisions: z.array(RunDecisionViewSchema).max(1024),
    channels: z.array(RunChannelViewSchema).max(256),
    alerts: z.array(RunAlertViewSchema).max(1024),
    metrics: RunMetricsViewSchema,
    /** B always declares observation-only and no write controls; R07 renders read-only. */
    capabilities: RunCapabilitiesSchema,
    issues: z.array(RunIssueViewSchema).max(100),
  })
  .superRefine((view, ctx) => {
    if (view.dag.revision !== view.dagRevision) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dag", "revision"],
        message: "dag.revision must equal dagRevision",
      });
    }
    const rows = new Map<string, RunTaskView>();
    for (const [index, task] of view.tasks.entries()) {
      if (rows.has(task.taskId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tasks", index, "taskId"],
          message: "taskId must be unique",
        });
      }
      rows.set(task.taskId, task);
    }
    const nodes = new Map<string, RunDagTaskView>();
    for (const [index, node] of view.dag.tasks.entries()) {
      if (nodes.has(node.taskId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dag", "tasks", index, "taskId"],
          message: "dag taskId must be unique",
        });
      }
      nodes.set(node.taskId, node);
      const row = rows.get(node.taskId);
      if (!row) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dag", "tasks", index, "taskId"],
          message: "dag task has no matching task row",
        });
        continue;
      }
      if (row.title !== node.title || row.state !== node.state) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dag", "tasks", index],
          message: "dag title/state must match the task row",
        });
      }
      if (new Set(node.deps).size !== node.deps.length || node.deps.includes(node.taskId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dag", "tasks", index, "deps"],
          message: "deps must be unique and must not contain the task itself",
        });
      }
      for (const dep of node.deps) {
        if (!rows.has(dep)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["dag", "tasks", index, "deps"],
            message: "dependency must reference an existing task",
          });
        }
      }
    }
    for (const [index, task] of view.tasks.entries()) {
      const expected = task.escalations.at(-1)?.toTier ?? task.tier;
      if (task.currentTier !== expected) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tasks", index, "currentTier"],
          message: "currentTier must match the last escalation or spec tier",
        });
      }
    }
    for (const id of rows.keys()) {
      if (!nodes.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dag", "tasks"],
          message: "dag must contain every task row",
        });
      }
    }
    const visiting = new Set<string>();
    const depths = new Map<string, number>();
    const depthOf = (id: string): number | null => {
      const cached = depths.get(id);
      if (cached !== undefined) return cached;
      if (visiting.has(id)) return null;
      const node = nodes.get(id);
      if (!node) return null;
      visiting.add(id);
      let deepest = -1;
      for (const dep of node.deps) {
        const depth = depthOf(dep);
        if (depth === null) return null;
        if (depth > deepest) deepest = depth;
      }
      visiting.delete(id);
      const depth = deepest + 1;
      depths.set(id, depth);
      return depth;
    };
    for (const [index, node] of view.dag.tasks.entries()) {
      const depth = depthOf(node.taskId);
      if (depth === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dag", "tasks", index, "deps"],
          message: "deps must form a DAG",
        });
        continue;
      }
      if (depth !== node.layer) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dag", "tasks", index, "layer"],
          message: "layer must be the topological depth",
        });
      }
    }
  });
export type RunDetailView = z.infer<typeof RunDetailViewSchema>;

export const RunSummaryViewSchema = z.object({
  runId: RunIdSchema,
  revision: z.number().int().nonnegative(),
  lifecycle: Text(32),
  teamName: Text(200),
  stateCounts: z.record(z.string(), z.number().int().nonnegative()),
  needsAttention: z.boolean(),
  updatedAt: z.string().datetime(),
});
export type RunSummaryView = z.infer<typeof RunSummaryViewSchema>;

export const RunHealthEntrySchema = z.object({
  runId: RunIdSchema.nullable(),
  status: z.enum(["ok", "unknown-version", "corrupt", "unavailable"]),
  summary: Text(600),
});

const RunInputShape = {
  ...ContractShape,
  runId: RunIdSchema,
};

// --- run.list -------------------------------------------------------------------------------

export const RunListInputSchema = z.strictObject({
  ...ContractShape,
  cursor: Text(256).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type RunListInput = z.input<typeof RunListInputSchema>;

export const RunListOutputSchema = z.object({
  ...ContractShape,
  capabilities: RunCapabilitiesSchema,
  runs: z.array(RunSummaryViewSchema).max(50),
  nextCursor: Text(256).nullable(),
  health: z.array(RunHealthEntrySchema).max(50),
});

// --- run.get --------------------------------------------------------------------------------

export const RunGetInputSchema = z
  .strictObject({
    ...RunInputShape,
    knownRevision: z.number().int().nonnegative().optional(),
    historyCursor: Text(256).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.historyCursor !== undefined && input.knownRevision !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["historyCursor"],
        message: "historyCursor cannot be combined with knownRevision",
      });
    }
  });
export type RunGetInput = z.input<typeof RunGetInputSchema>;

const RunGetFailure = (status: "unknown-version" | "corrupt" | "missing") =>
  z.object({
    ...ContractShape,
    status: z.literal(status),
    run: z.null(),
    issues: z.array(RunIssueViewSchema).max(100),
  });

/** A discriminated union: ready always has run+history; failures always have run:null. */
export const RunGetOutputSchema = z.discriminatedUnion("status", [
  z.object({
    ...ContractShape,
    status: z.literal("unchanged"),
    revision: z.number().int().nonnegative(),
  }),
  z.object({
    ...ContractShape,
    status: z.literal("ready"),
    run: RunDetailViewSchema,
    history: RunHistoryPageSchema,
    issues: z.array(RunIssueViewSchema).max(100),
  }),
  RunGetFailure("unknown-version"),
  RunGetFailure("corrupt"),
  RunGetFailure("missing"),
]);

// --- run.reconcile (observation only; recovery is a later batch) ----------------------------

export const RunObservationViewSchema = z.object({
  kind: Text(64),
  agentId: RunIdRefSchema.nullable(),
  turnId: Text(128).nullable(),
  observedAt: z.string().datetime(),
  summary: Text(600),
});

export const RunReconcileProposalSchema = z.object({
  action: z.enum(["refresh-observation", "resume-request", "none"]),
  targetId: RunIdRefSchema.nullable(),
  reason: Text(600),
});

export const RunReconcileInputSchema = z.strictObject({
  ...RunInputShape,
  requestId: Text(128),
  expectedRevision: z.number().int().nonnegative(),
  reason: z.enum(["startup", "manual"]),
});
export type RunReconcileInput = z.input<typeof RunReconcileInputSchema>;

/** No "recovery result" field: batch B/C recovery is applied only by `resume-request`. */
export const RunReconcileOutputSchema = z.object({
  ...ContractShape,
  diagnosisId: RunIdRefSchema,
  baseRevision: z.number().int().nonnegative(),
  observations: z.array(RunObservationViewSchema).max(256),
  proposedActions: z.array(RunReconcileProposalSchema).max(32),
  issues: z.array(RunIssueViewSchema).max(100),
});

// --- run.approve ----------------------------------------------------------------------------

export const RunApproveInputSchema = z.strictObject({
  ...RunInputShape,
  decisionId: z.string().uuid(),
  requestId: Text(128),
  expectedRevision: z.number().int().nonnegative(),
  subjectHash: z.string().regex(/^[a-f0-9]{64}$/),
  approve: z.boolean(),
  reason: Text(600),
});
export type RunApproveInput = z.input<typeof RunApproveInputSchema>;

export const RunApprovalViewSchema = z.object({
  approvalId: RunIdRefSchema,
  decisionId: z.string().uuid(),
  approve: z.boolean(),
  approvedAt: z.string().datetime(),
  consumedAt: z.string().datetime().nullable(),
});

export const RunApproveOutputSchema = z.object({
  ...ContractShape,
  approval: RunApprovalViewSchema,
  revision: z.number().int().nonnegative(),
});

// --- run.control (explicit whitelist; no force-done) ---------------------------------------

export const RUN_CONTROL_ACTIONS = [
  "pause",
  "resume-request",
  "defer-channel",
  "resume-seat",
  "adopt-seat",
  "ack-alert",
  "budget",
  "cancel",
  "archive-terminal",
] as const;

export const RunControlActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("pause") }),
  z.strictObject({
    action: z.literal("resume-request"),
    diagnosisId: RunIdRefSchema,
    baseRevision: z.number().int().nonnegative(),
  }),
  z.strictObject({
    action: z.literal("defer-channel"),
    channelId: Text(128),
    until: z.string().datetime(),
  }),
  z.strictObject({ action: z.literal("resume-seat"), seatId: RunIdRefSchema }),
  z.strictObject({ action: z.literal("adopt-seat"), seatId: RunIdRefSchema }),
  z.strictObject({ action: z.literal("ack-alert"), alertId: RunIdRefSchema }),
  z.strictObject({
    action: z.literal("budget"),
    scope: z.enum(["seat", "task-attempts", "strategic-turns"]),
    subjectId: RunIdRefSchema,
    delta: z.number().int().min(1).max(1024),
    policyRevision: z.number().int().nonnegative(),
  }),
  z.strictObject({
    action: z.literal("cancel"),
    // Empty means nothing is cancelled, which is not a cancellation request.
    taskIds: z.array(Text(64)).min(1).max(64),
  }),
  z.strictObject({ action: z.literal("archive-terminal") }),
]);
export type RunControlAction = z.infer<typeof RunControlActionSchema>;

export const RunControlInputSchema = z.strictObject({
  ...RunInputShape,
  requestId: Text(128),
  expectedRevision: z.number().int().nonnegative(),
  reason: Text(600),
  action: RunControlActionSchema,
});
export type RunControlInput = z.input<typeof RunControlInputSchema>;

export const RunControlOutputSchema = z.object({
  ...ContractShape,
  requestId: Text(128),
  revision: z.number().int().nonnegative(),
  decisionId: z.string().uuid().nullable(),
  issues: z.array(RunIssueViewSchema).max(100),
});

// --- run.export (bounded, redacted, read-only) ---------------------------------------------

export const RunExportInputSchema = z.strictObject({
  ...RunInputShape,
  cursor: Text(256).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type RunExportInput = z.input<typeof RunExportInputSchema>;

export const RunExportItemSchema = z.object({
  kind: z.enum(["task", "assignment", "evidence", "decision", "alert", "event"]),
  id: RunIdRefSchema,
  summary: Text(1000),
  at: z.string().datetime(),
});

export const RunExportOutputSchema = z.object({
  ...ContractShape,
  runId: RunIdSchema,
  status: z.enum(["ready", "unknown-version", "corrupt", "missing"]),
  redacted: z.literal(true),
  items: z.array(RunExportItemSchema).max(200),
  nextCursor: Text(256).nullable(),
  issues: z.array(RunIssueViewSchema).max(100),
});

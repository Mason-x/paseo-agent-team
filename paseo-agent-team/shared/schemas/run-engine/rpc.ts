import { z } from "zod";
import { RunIdRefSchema, RunIdSchema, RunPathSchema } from "./ledger";

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
  waitingReason: Text(600).nullable(),
  frozen: z.boolean(),
});
export type RunTaskView = z.infer<typeof RunTaskViewSchema>;

export const RunLockViewSchema = z.object({
  claimId: RunIdRefSchema,
  taskId: Text(64),
  repoId: Text(256),
  kind: z.enum(["file", "directory"]),
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
  state: z.enum(["open", "answered", "waiting-human"]),
  subjectId: RunIdRefSchema.nullable(),
  summary: Text(4096),
  createdAt: z.string().datetime(),
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

export const RunDetailViewSchema = z.object({
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
  tasks: z.array(RunTaskViewSchema).max(64),
  locks: z.array(RunLockViewSchema).max(4096),
  capacity: RunCapacityViewSchema,
  budgets: z.array(RunBudgetViewSchema).max(256),
  decisions: z.array(RunDecisionViewSchema).max(1024),
  channels: z.array(RunChannelViewSchema).max(256),
  alerts: z.array(RunAlertViewSchema).max(1024),
  metrics: RunMetricsViewSchema,
  issues: z.array(RunIssueViewSchema).max(100),
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

export const RunCapabilitiesSchema = z.object({
  runEngine: z.literal(1),
  /** Batch B: diagnose only; no writes, no task advance. */
  observationOnly: z.boolean(),
  enabled: z.boolean(),
  supportedControls: z.array(Text(64)).max(16),
});

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

export const RunGetInputSchema = z.strictObject({
  ...RunInputShape,
  knownRevision: z.number().int().nonnegative().optional(),
});
export type RunGetInput = z.input<typeof RunGetInputSchema>;

export const RunGetOutputSchema = z.union([
  z.object({
    ...ContractShape,
    status: z.literal("unchanged"),
    revision: z.number().int().nonnegative(),
  }),
  z.object({
    ...ContractShape,
    status: z.enum(["ready", "unknown-version", "corrupt", "missing"]),
    run: RunDetailViewSchema.nullable(),
    issues: z.array(RunIssueViewSchema).max(100),
  }),
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
    taskIds: z.array(Text(64)).max(64),
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

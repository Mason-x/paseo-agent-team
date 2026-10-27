import { z } from "zod";
import {
  DiffRefShape,
  GitCommitRefShape,
  RunEvidenceRequirementShape,
  RunEvidenceShape,
  RunIdRefSchema,
  RunIrreversibleSpecShape,
  RunPathSchema,
  RunScopeShape,
  RunTaskSpecShape,
} from "./ledger";

/**
 * The five strict protocol blocks (05 §3, AC-RE2.1–2.9).
 *
 * One authorized reply window carries exactly one block; the fence scanner (R02) enforces the
 * single-block rule and the 32KiB/256KiB budgets. These schemas are strict at every level: an
 * unknown field or an unknown `protocolVersion` rejects the whole block, never "best effort".
 *
 * Identity: `runId`, `taskId`, `attempt`, `nonce` plus `protocolVersion`. Report blocks also carry
 * `assignmentId` (required) and `messageId` (OPTIONAL: the engine fills it from the dispatch
 * record; the model is never asked for it, because the dispatch template does not inline it).
 * Control blocks use the reserved task ids `_dag` / `_decision:<id>`, do not carry an assignment,
 * and their `attempt` is fixed to 1: their idempotency keys are `dagRevision` / `decisionId`.
 *
 * Field caps here are contract bounds, not the byte budget; byte accounting stays in R02.
 */

export const RUN_PROTOCOL_VERSION = 1;

const ControlTaskIdSchema = z.union([
  z.literal("_dag"),
  z.string().regex(/^_decision:[a-z0-9-]{1,64}$/),
]);

const IdentityShape = {
  protocolVersion: z.literal(RUN_PROTOCOL_VERSION),
  runId: z
    .string()
    .max(96)
    .regex(/^run-[a-z0-9]+-[a-z0-9]+$/),
  taskId: z.string().min(1).max(96),
  attempt: z.number().int().min(1),
  nonce: z.string().uuid(),
};

const ControlIdentityShape = {
  ...IdentityShape,
  taskId: ControlTaskIdSchema,
  /** Fixed to 1: DAG revision and decision id are the control idempotency keys. */
  attempt: z.literal(1),
};

const ReportIdentityShape = {
  ...IdentityShape,
  /** Business task ids never start with the reserved control prefix. */
  taskId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  assignmentId: RunIdRefSchema,
  /** Engine-filled after parse; optional on the wire so a model cannot fail a report over it. */
  messageId: z.string().uuid().optional(),
};

export const RunTaskDagIdentitySchema = z.strictObject(ControlIdentityShape);

const BudgetRequestShape = {
  scope: z.enum(["seat", "task-attempts", "strategic-turns"]),
  subjectId: RunIdRefSchema,
  requestedLimit: z.number().int().min(0).max(1024),
  reason: z.string().min(1).max(600),
};
export const RunBudgetRequestSchema = z.strictObject(BudgetRequestShape);
export type RunBudgetRequest = z.infer<typeof RunBudgetRequestSchema>;

const TASK_DAG_MAX_TASKS = 64;

/** Nested objects are strict too: a protocol block has no passthrough anywhere. */
const StrictArtifactRefSchema = z.discriminatedUnion("kind", [
  z.strictObject(GitCommitRefShape),
  z.strictObject(DiffRefShape),
]);

const StrictEvidenceSchema = z.strictObject({
  ...RunEvidenceShape,
  ref: StrictArtifactRefSchema,
  coverage: z
    .strictObject({
      lines: z.number().min(0).max(100),
      functions: z.number().min(0).max(100),
    })
    .optional(),
  isolation: z.strictObject({ homePath: RunPathSchema, outsideRealHome: z.boolean() }).optional(),
});

const ProtocolTaskSpecSchema = z.strictObject({
  ...RunTaskSpecShape,
  scopes: z.array(z.strictObject(RunScopeShape)).min(1).max(64),
  evidence: z.array(z.strictObject(RunEvidenceRequirementShape)).min(1).max(64),
  irreversible: z
    .strictObject({ ...RunIrreversibleSpecShape, artifactRef: StrictArtifactRefSchema.nullable() })
    .nullable(),
});

export const RunTaskDagBlockSchema = z.strictObject({
  ...ControlIdentityShape,
  dagRevision: z.number().int().min(1),
  expectedDagRevision: z.number().int().min(0),
  tasks: z.array(ProtocolTaskSpecSchema).min(1).max(TASK_DAG_MAX_TASKS),
  cancelTaskIds: z.array(z.string().min(1).max(64)).max(TASK_DAG_MAX_TASKS),
  budgetRequests: z.array(RunBudgetRequestSchema).max(32),
});
export type RunTaskDagBlock = z.infer<typeof RunTaskDagBlockSchema>;

export const RUN_TASK_REPORT_STATUSES = ["done", "blocked", "failed"] as const;

const TaskReportDoneShape = {
  ...ReportIdentityShape,
  status: z.literal("done"),
  /** A read-only task may legitimately change no file; the evidence gate decides more. */
  changedFiles: z.array(RunPathSchema).max(512),
  ref: StrictArtifactRefSchema,
  workspace: z.strictObject({
    id: RunIdRefSchema,
    branch: z.string().min(1).max(256),
    baseRef: z.string().min(1).max(256),
  }),
  evidence: z.array(StrictEvidenceSchema).min(1).max(64),
};

const TaskReportNotDoneShape = {
  ...ReportIdentityShape,
  status: z.enum(["blocked", "failed"]),
  reasonCode: z.string().min(1).max(64),
  summary: z.string().min(1).max(1000),
  evidence: z.array(StrictEvidenceSchema).max(64),
};

export const RunTaskReportBlockSchema = z.discriminatedUnion("status", [
  z.strictObject(TaskReportDoneShape),
  z.strictObject(TaskReportNotDoneShape),
]);
export type RunTaskReportBlock = z.infer<typeof RunTaskReportBlockSchema>;

export const RUN_REVIEW_VERDICTS = ["可合入", "修改后合入", "不可合入"] as const;

export const RunReviewReportBlockSchema = z.strictObject({
  ...ReportIdentityShape,
  reviewedRef: StrictArtifactRefSchema,
  verdict: z.enum(RUN_REVIEW_VERDICTS),
  blockers: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(64),
        summary: z.string().min(1).max(600),
        path: RunPathSchema.nullable(),
      }),
    )
    .max(40),
  probes: z.array(StrictEvidenceSchema).max(64),
});
export type RunReviewReportBlock = z.infer<typeof RunReviewReportBlockSchema>;

export const RunSmokeReportBlockSchema = z.strictObject({
  ...ReportIdentityShape,
  testedRef: StrictArtifactRefSchema,
  devHost: z.string().min(1).max(256),
  devServerId: z.string().min(1).max(128),
  devHome: RunPathSchema,
  checks: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(64),
        /** No skip value: an inapplicable check must be removed by a spec revision first. */
        result: z.enum(["pass", "fail"]),
        evidencePath: RunPathSchema,
      }),
    )
    .min(1)
    .max(64),
});
export type RunSmokeReportBlock = z.infer<typeof RunSmokeReportBlockSchema>;

export const RUN_DECISION_ACTIONS = [
  "replan",
  "assign-seat",
  "increase-budget",
  "retry",
  "cancel",
  "defer-channel",
  "resume-seat",
  "reject",
] as const;
export const RunDecisionActionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("replan"),
    nextDagRevision: z.number().int().min(1),
  }),
  z.strictObject({
    action: z.literal("assign-seat"),
    taskId: z.string().min(1).max(64),
    seatId: RunIdRefSchema,
  }),
  z.strictObject({
    action: z.literal("increase-budget"),
    scope: z.enum(["seat", "task-attempts", "strategic-turns"]),
    subjectId: RunIdRefSchema,
    delta: z.number().int().min(1).max(1024),
    reason: z.string().min(1).max(600),
  }),
  z.strictObject({
    action: z.literal("retry"),
    taskId: z.string().min(1).max(64),
    reason: z.string().min(1).max(600),
  }),
  z.strictObject({
    action: z.literal("cancel"),
    taskIds: z.array(z.string().min(1).max(64)).min(1).max(64),
    reason: z.string().min(1).max(600),
  }),
  z.strictObject({
    action: z.literal("defer-channel"),
    channelId: z.string().min(1).max(128),
    until: z.string().datetime(),
    reason: z.string().min(1).max(600),
  }),
  z.strictObject({
    action: z.literal("resume-seat"),
    seatId: RunIdRefSchema,
    reason: z.string().min(1).max(600),
  }),
  z.strictObject({
    action: z.literal("reject"),
    reason: z.string().min(1).max(600),
  }),
]);
export type RunDecisionAction = z.infer<typeof RunDecisionActionSchema>;

export const RunDecisionBlockSchema = z.strictObject({
  ...ControlIdentityShape,
  decisionId: z.string().uuid(),
  action: RunDecisionActionSchema,
});
export type RunDecisionBlock = z.infer<typeof RunDecisionBlockSchema>;

/** The block union for scanners that already know the fence name. */
export const RunProtocolBlockSchema = z.union([
  RunTaskDagBlockSchema,
  RunTaskReportBlockSchema,
  RunReviewReportBlockSchema,
  RunSmokeReportBlockSchema,
  RunDecisionBlockSchema,
]);
export type RunProtocolBlock = z.infer<typeof RunProtocolBlockSchema>;

export const RUN_PROTOCOL_BLOCKS = [
  "task-dag",
  "task-report",
  "review-report",
  "smoke-report",
  "decision",
] as const;
export type RunProtocolBlockName = (typeof RUN_PROTOCOL_BLOCKS)[number];

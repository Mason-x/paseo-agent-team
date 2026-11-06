import { z } from "zod";
import {
  RunEvidenceRequirementShape,
  RunIdRefSchema,
  RunIrreversibleSpecShape,
  RunPathSchema,
  RunScopeShape,
  RunTaskSpecShape,
  refineTaskSpec,
} from "./ledger";
import {
  DiffRefShape,
  GitCommitRefShape,
  ReportBlockerShape,
  ReportCheckShape,
  ReportCoverageShape,
  ReportEvidenceFields,
  ReportIdentityShape,
  ReportIsolationShape,
  ReportWorkspaceShape,
  RUN_PROTOCOL_VERSION,
  RunDispatchDutiesShape,
  RunTaskIdSchema,
} from "./proof-shapes";

export { RUN_PROTOCOL_VERSION } from "./proof-shapes";

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

export const RunTaskDagIdentitySchema = z.strictObject(ControlIdentityShape);

const BudgetRequestShape = {
  scope: z.enum(["seat", "task-attempts", "strategic-turns"]),
  subjectId: RunIdRefSchema,
  requestedLimit: z.number().int().min(0).max(1024),
  reason: z.string().min(1).max(600),
};
function refineBudgetSubject(
  value: { scope: "seat" | "task-attempts" | "strategic-turns"; subjectId: string },
  ctx: z.RefinementCtx,
): void {
  if (value.scope === "task-attempts" && !RunTaskIdSchema.safeParse(value.subjectId).success) {
    ctx.addIssue({
      code: "custom",
      path: ["subjectId"],
      message: "task-attempts subjectId must be a lowercase business TaskId",
    });
  }
}

export const RunBudgetRequestSchema = z
  .strictObject(BudgetRequestShape)
  .superRefine(refineBudgetSubject);
export type RunBudgetRequest = z.infer<typeof RunBudgetRequestSchema>;

const TASK_DAG_MAX_TASKS = 64;

/** Nested objects are strict too: a protocol block has no passthrough anywhere. */
const StrictArtifactRefSchema = z.discriminatedUnion("kind", [
  z.strictObject(GitCommitRefShape),
  z.strictObject(DiffRefShape),
]);

const StrictEvidenceSchema = z.strictObject({
  ...ReportEvidenceFields,
  ref: StrictArtifactRefSchema,
  coverage: z.strictObject(ReportCoverageShape).optional(),
  isolation: z.strictObject(ReportIsolationShape).optional(),
});

const ProtocolTaskSpecSchema = z
  .strictObject({
    ...RunTaskSpecShape,
    dispatchDuties: z.strictObject(RunDispatchDutiesShape),
    scopes: z.array(z.strictObject(RunScopeShape)).min(1).max(64),
    evidence: z.array(z.strictObject(RunEvidenceRequirementShape)).min(1).max(64),
    irreversible: z
      .strictObject({
        ...RunIrreversibleSpecShape,
        artifactRef: StrictArtifactRefSchema.nullable(),
      })
      .nullable(),
  })
  .superRefine(refineTaskSpec);

export const RunTaskDagBlockSchema = z.strictObject({
  ...ControlIdentityShape,
  dagRevision: z.number().int().min(1),
  expectedDagRevision: z.number().int().min(0),
  tasks: z.array(ProtocolTaskSpecSchema).min(1).max(TASK_DAG_MAX_TASKS),
  cancelTaskIds: z.array(RunTaskIdSchema).max(TASK_DAG_MAX_TASKS),
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
  workspace: z.strictObject(ReportWorkspaceShape),
  evidence: z.array(StrictEvidenceSchema).min(1).max(64),
};

const TaskReportNotDoneShape = {
  ...ReportIdentityShape,
  status: z.enum(["blocked", "failed"]),
  reasonCode: z.string().min(1).max(64),
  summary: z.string().min(1).max(1000),
  /**
   * Optional, read as `[]`. A blocked or failed report has no delivery ref, and every entry needs one,
   * so the honest form is no entries; refusing a whole report for leaving the key out would turn an
   * honest stop into a missing report. Nothing reads these entries.
   */
  evidence: z.array(StrictEvidenceSchema).max(64).default([]),
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
  blockers: z.array(z.strictObject(ReportBlockerShape)).max(40),
  probes: z.array(StrictEvidenceSchema).max(64),
});
export type RunReviewReportBlock = z.infer<typeof RunReviewReportBlockSchema>;

export const RunSmokeReportBlockSchema = z.strictObject({
  ...ReportIdentityShape,
  testedRef: StrictArtifactRefSchema,
  devHost: z.string().min(1).max(256),
  devServerId: z.string().min(1).max(128),
  devHome: RunPathSchema,
  checks: z.array(z.strictObject(ReportCheckShape)).min(1).max(64),
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
export const RunDecisionActionSchema = z
  .discriminatedUnion("action", [
    z.strictObject({
      action: z.literal("replan"),
      nextDagRevision: z.number().int().min(1),
    }),
    z.strictObject({
      action: z.literal("assign-seat"),
      taskId: RunTaskIdSchema,
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
      taskId: RunTaskIdSchema,
      reason: z.string().min(1).max(600),
    }),
    z.strictObject({
      action: z.literal("cancel"),
      taskIds: z.array(RunTaskIdSchema).min(1).max(64),
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
  ])
  .superRefine((action, ctx) => {
    if (action.action === "increase-budget") refineBudgetSubject(action, ctx);
  });
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

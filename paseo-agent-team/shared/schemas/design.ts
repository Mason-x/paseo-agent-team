import { z } from "zod";
import { checkDesignRequest } from "../domain/design-request";
import { DescriptionSchema, ShortTextSchema, SlugSchema, StringListSchema } from "./common";
import { RoleSchema } from "./role";
import { TeamSchema } from "./team";
import { RoleTierSchema, TaskKindSchema, TeamModeSchema } from "./team-mode";

/** Shared primitives. Model output and RPC input stay strict; DTOs use tolerant objects. */
export const DesignUuidSchema = z.string().uuid();
export const DesignIdSchema = z.string().min(1).max(256);
export const DesignTimeSchema = z.string().datetime();
export const DesignHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const DesignNonceSchema = z.string().regex(/^[a-f0-9]{32}$/);
export const DesignAttemptSchema = z.number().int().min(1).max(3);
export const DesignReasonSchema = z.string().trim().min(1).max(600);
export const DesignMemberKeySchema = z.string().regex(/^m[1-9][0-9]?$/);
export const DesignChoiceTargetSchema = z.union([z.literal("coordinator"), DesignMemberKeySchema]);

export type DesignMemberKey = z.infer<typeof DesignMemberKeySchema>;
export type DesignChoiceTarget = z.infer<typeof DesignChoiceTargetSchema>;

// Reuses the single code-point counter from design-request.ts; trimming happens before the check
// so the stored request is exactly what the limit measured. Byte limits for the model's fenced
// JSON block live in design-output.ts, not here.
export const DesignRequestSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => checkDesignRequest(value).ok, { message: "design.inputInvalid" });

export type DesignRequest = z.infer<typeof DesignRequestSchema>;

export const ProposalProfileRefSchema = z.strictObject({
  profileId: DesignIdSchema,
});

export type ProposalProfileRef = z.infer<typeof ProposalProfileRefSchema>;

export const NewDesignRoleSchema = z.strictObject({
  id: SlugSchema,
  name: ShortTextSchema,
  description: DescriptionSchema.optional(),
  mission: z.string().trim().min(1).max(2000),
  responsibilities: StringListSchema.min(1),
  restrictions: StringListSchema,
  systemPrompt: z.string().trim().min(1).max(20000),
  outputContract: StringListSchema,
  preferredProfiles: z.array(ProposalProfileRefSchema).min(1).max(5),
  fallbackProfiles: z.array(ProposalProfileRefSchema).max(5),
  executionPolicy: z.strictObject({
    tier: RoleTierSchema,
    taskKind: TaskKindSchema,
  }),
  color: z.string().max(32).optional(),
  icon: z.string().max(64).optional(),
  noveltyReason: DesignReasonSchema,
});

export type NewDesignRole = z.infer<typeof NewDesignRoleSchema>;

export const DesignTeamDraftSchema = z.strictObject({
  id: SlugSchema,
  name: ShortTextSchema,
  description: DescriptionSchema.optional(),
  mode: TeamModeSchema,
  coordinatorRoleId: SlugSchema,
  members: z
    .array(
      z.strictObject({
        key: DesignMemberKeySchema,
        roleId: SlugSchema,
        instanceLabel: ShortTextSchema.optional(),
      }),
    )
    .min(1)
    .max(64),
  collaboration: z
    .strictObject({
      replicas: z.union([z.literal(2), z.literal(3)]),
      judgeRoleId: SlugSchema.optional(),
      escalationRoleId: SlugSchema.optional(),
    })
    .optional(),
  operatingRules: z.string().trim().max(4000).optional(),
});

export type DesignTeamDraft = z.infer<typeof DesignTeamDraftSchema>;

export const DesignProfileChoiceSchema = z.strictObject({
  target: DesignChoiceTargetSchema,
  // Empty only for a standby escalation seat the planner reports as unavailable.
  profileIds: z.array(DesignIdSchema).max(3),
  reason: DesignReasonSchema,
});

export type DesignProfileChoice = z.infer<typeof DesignProfileChoiceSchema>;

export const DesignProposalSchema = z.strictObject({
  version: z.literal(1),
  jobId: DesignUuidSchema,
  attempt: DesignAttemptSchema,
  nonce: DesignNonceSchema,
  summary: z.string().trim().min(1).max(1000),
  team: DesignTeamDraftSchema,
  reuse: z.array(z.strictObject({ roleId: SlugSchema, reason: DesignReasonSchema })).max(65),
  newRoles: z.array(NewDesignRoleSchema).max(3),
  profileChoices: z.array(DesignProfileChoiceSchema).min(2).max(65),
});

export type DesignProposal = z.infer<typeof DesignProposalSchema>;

/** The fixed error vocabulary. Rendered text lives in shared/zh/design.ts. */
export const DESIGN_ISSUE_CODES = [
  "DESIGN_INPUT_INVALID",
  "DESIGN_REQUEST_CONFLICT",
  "DESIGN_MODE_UNAVAILABLE",
  "DESIGN_STORAGE_UNAVAILABLE",
  "DESIGN_BUSY",
  "DESIGN_DISCOVERY_INCOMPLETE",
  "DESIGN_JOB_NOT_FOUND",
  "DESIGN_STATE_CHANGED",
  "DESIGN_CONFIG_UNAVAILABLE",
  "DESIGN_SETTINGS_INVALID",
  "DESIGN_NO_WORKSPACE",
  "DESIGN_WORKSPACE_UNAVAILABLE",
  "DESIGN_PROFILE_UNAVAILABLE",
  "DESIGN_INPUT_TOO_LARGE",
  "DESIGN_OUTPUT_MISSING",
  "DESIGN_OUTPUT_MULTIPLE",
  "DESIGN_OUTPUT_TOO_LARGE",
  "DESIGN_OUTPUT_JSON",
  "DESIGN_OUTPUT_SCHEMA",
  "DESIGN_OUTPUT_IDENTITY",
  "DESIGN_TIMELINE_INCOMPLETE",
  "DESIGN_EXTERNAL_INPUT",
  "DESIGN_REUSE_INVALID",
  "DESIGN_ROLE_ID_CONFLICT",
  "DESIGN_ROLE_NAME_CONFLICT",
  "DESIGN_ROLE_NAMING",
  "DESIGN_ROLE_UNUSED",
  "DESIGN_NEW_ROLE_LIMIT",
  "DESIGN_TEAM_INVALID",
  "DESIGN_MEMBER_LIMIT",
  "DESIGN_PROFILE_MISSING",
  "DESIGN_PROFILE_DUPLICATE",
  "DESIGN_PROFILE_CHOICE",
  "DESIGN_PROVIDER_UNAVAILABLE",
  "DESIGN_MODE_PLAN_INVALID",
  "DESIGN_LAUNCH_BLOCKED",
  "DESIGN_TEAM_RENAMED",
  "DESIGN_CONTEXT_CHANGED",
  "DESIGN_TEAM_ID_CONFLICT",
  "DESIGN_RESULT_STALE",
  "DESIGN_SAVE_BUSY",
  "DESIGN_SAVE_LEASE_EXPIRED",
  "DESIGN_SAVE_CONFLICT",
  "DESIGN_SAVE_FAILED",
  "DESIGN_SAVE_UNKNOWN",
  "DESIGN_COMPENSATION_UNSAFE",
  "DESIGN_NOT_SAVED",
  "DESIGN_SAVED_MODIFIED",
  "DESIGN_RECOVERY_INCOMPLETE",
  "DESIGN_RETRY_EXHAUSTED",
  "DESIGN_AGENT_FAILED",
  "DESIGN_CANCEL_FAILED",
] as const;

export const DesignIssueCodeSchema = z.enum(DESIGN_ISSUE_CODES);
export type DesignIssueCode = z.infer<typeof DesignIssueCodeSchema>;

export const DesignIssueSeveritySchema = z.enum(["error", "warning"]);
export type DesignIssueSeverity = z.infer<typeof DesignIssueSeveritySchema>;

export const DesignIssueActionSchema = z.enum([
  "none",
  "refresh",
  "repair",
  "choose-profile",
  "choose-workspace",
  "retry-save",
  "inspect",
]);
export type DesignIssueAction = z.infer<typeof DesignIssueActionSchema>;

export const DesignIssueSchema = z.object({
  code: DesignIssueCodeSchema,
  severity: DesignIssueSeveritySchema,
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  action: DesignIssueActionSchema,
});

export type DesignIssue = z.infer<typeof DesignIssueSchema>;

export const DesignStateSchema = z.enum([
  "starting",
  "designing",
  "validating",
  "fixing",
  "ready",
  "saving",
  "saved",
  "needs_continue",
  "save_conflict",
  "canceling",
  "canceled",
  "failed",
]);

export type DesignState = z.infer<typeof DesignStateSchema>;

export const ProfileSummarySchema = z.object({
  id: DesignIdSchema,
  name: z.string(),
  provider: DesignIdSchema,
  model: z.string().optional(),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
});

export type ProfileSummary = z.infer<typeof ProfileSummarySchema>;

/**
 * TODO(5A): stand-in for 5A T4's shared ModeLaunchPreviewSchema. T2's HostSnapshot/ProfileSelection
 * are already imported by design-planning; T3's seat expansion and T4's per-physical-seat
 * projection (Profile/source/family/budget/reason) are still pending. Replace this schema and its
 * type with T4's exact exports when T4 merges; do not extend this stub in G2.
 */
export const ModeLaunchPreviewSeatSchema = z
  .object({
    seatId: z.string().optional(),
    logicalSeatId: z.string().optional(),
    roleId: z.string().optional(),
    profileId: z.string().nullable().optional(),
    source: z.string().optional(),
    family: z.string().optional(),
    budget: z.unknown().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

export const ModeLaunchPreviewSchema = z
  .object({
    mode: TeamModeSchema.optional(),
    seats: z.array(ModeLaunchPreviewSeatSchema),
  })
  .passthrough();

export type ModeLaunchPreview = z.infer<typeof ModeLaunchPreviewSchema>;

export const DesignJobSchema = z.object({
  jobId: DesignUuidSchema,
  clientRequestId: DesignUuidSchema,
  stateRevision: DesignUuidSchema,
  state: DesignStateSchema,
  attempt: z.number().int().min(0).max(3),
  mode: TeamModeSchema,
  createdAt: DesignTimeSchema,
  updatedAt: DesignTimeSchema,
  finishedAt: DesignTimeSchema.nullable(),
  requestExcerpt: z.string(),
  agentId: DesignUuidSchema,
  agentCreated: z.boolean(),
  carrierWorkspaceId: DesignIdSchema.nullable(),
  targetWorkspaceId: DesignIdSchema.nullable(),
  designerProfile: ProfileSummarySchema.nullable(),
  agentStatus: z.enum(["initializing", "idle", "running", "closed", "error"]).nullable(),
  requiresAttention: z.boolean(),
  attentionReason: z.enum(["finished", "error", "permission"]).nullable(),
  pendingPermissions: z.array(
    z.object({
      id: DesignIdSchema,
      kind: z.enum(["tool", "plan", "question", "mode", "other"]),
      title: z.string(),
      description: z.string().optional(),
    }),
  ),
  permissionsTruncated: z.boolean(),
  resultId: DesignHashSchema.nullable(),
  savedTeamId: SlugSchema.nullable(),
  saveState: z.enum(["none", "roles-only", "committed", "unknown"]),
  cancelRequested: z.boolean(),
  needsCleanup: z.boolean(),
  issues: z.array(DesignIssueSchema),
  issuesTruncated: z.number().int().nonnegative(),
  recovered: z.boolean(),
  saveLeaseExpiresAt: DesignTimeSchema.nullable(),
  allowed: z.object({
    cancel: z.boolean(),
    save: z.boolean(),
    launch: z.boolean(),
    continueAction: z.enum(["recheck", "repair"]).nullable(),
  }),
});

export type DesignJob = z.infer<typeof DesignJobSchema>;

export const MemberReasonSchema = z.object({
  target: DesignChoiceTargetSchema,
  logicalSeatId: DesignIdSchema,
  reason: z.string(),
  expectedProfileIds: z.array(DesignIdSchema),
});

export type MemberReason = z.infer<typeof MemberReasonSchema>;

export const DesignResultSchema = z.object({
  version: z.literal(1),
  jobId: DesignUuidSchema,
  resultId: DesignHashSchema,
  attempt: DesignAttemptSchema,
  materializedAt: DesignTimeSchema,
  request: DesignRequestSchema,
  mode: TeamModeSchema,
  summary: z.string(),
  carrierWorkspaceId: DesignIdSchema,
  targetWorkspaceId: DesignIdSchema.nullable(),
  team: TeamSchema,
  newRoles: z.array(RoleSchema),
  reuse: z.array(
    z.object({
      roleId: SlugSchema,
      behaviorHash: DesignHashSchema,
      reason: z.string(),
    }),
  ),
  memberReasons: z.array(MemberReasonSchema),
  preview: ModeLaunchPreviewSchema,
  planningFingerprint: DesignHashSchema,
  warnings: z.array(DesignIssueSchema),
});

export type DesignResult = z.infer<typeof DesignResultSchema>;

export const DesignBaseRevisionsSchema = z.object({
  roles: z.string(),
  teams: z.string(),
  preferences: z.string(),
});

export type DesignBaseRevisions = z.infer<typeof DesignBaseRevisionsSchema>;

export const DesignLeaseSchema = z.object({
  id: DesignUuidSchema,
  expiresAt: DesignTimeSchema,
});

export type DesignLease = z.infer<typeof DesignLeaseSchema>;

export const DesignFailureSchema = z.object({
  ok: z.literal(false),
  issues: z.array(DesignIssueSchema),
  issuesTruncated: z.number().int().nonnegative().default(0),
  job: DesignJobSchema.nullable(),
});

export type DesignFailure = z.infer<typeof DesignFailureSchema>;

function reply<T extends z.ZodRawShape>(shape: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), ...shape }),
    DesignFailureSchema,
  ]);
}

export const DesignStartInputSchema = z
  .strictObject({
    clientRequestId: DesignUuidSchema,
    request: DesignRequestSchema,
    mode: TeamModeSchema.default("sota"),
    workspaceId: DesignIdSchema.optional(),
    profileId: DesignIdSchema.optional(),
    useDefaultProfileHints: z.boolean().optional(),
  })
  .refine((value) => !(value.profileId && value.useDefaultProfileHints), {
    message: "design.inputInvalid",
  });

export const DesignStartOutputSchema = reply({ job: DesignJobSchema });

export const DesignStatusInputSchema = z.strictObject({
  jobId: DesignUuidSchema.optional(),
});

export const DesignStatusOutputSchema = reply({
  scopeId: DesignUuidSchema,
  jobs: z.array(DesignJobSchema),
  truncated: z.boolean(),
  discoveryIssues: z.array(DesignIssueSchema),
});

export const DesignResultInputSchema = z.strictObject({
  jobId: DesignUuidSchema,
});

export const DesignResultOutputSchema = reply({
  job: DesignJobSchema,
  request: DesignRequestSchema,
  result: DesignResultSchema.nullable(),
});

export const DesignPreparedSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("write"),
    job: DesignJobSchema,
    result: DesignResultSchema,
    lease: DesignLeaseSchema,
    base: DesignBaseRevisionsSchema,
  }),
  z.object({
    outcome: z.literal("compensate"),
    job: DesignJobSchema,
    result: DesignResultSchema,
    lease: DesignLeaseSchema,
    base: DesignBaseRevisionsSchema,
    removableRoleIds: z.array(SlugSchema),
  }),
  z.object({
    outcome: z.literal("already-saved"),
    job: DesignJobSchema,
  }),
]);

export type DesignPrepared = z.infer<typeof DesignPreparedSchema>;

export const DesignPrepareSaveInputSchema = z.strictObject({
  jobId: DesignUuidSchema,
  resultId: DesignHashSchema,
  clientId: DesignUuidSchema,
  leaseId: DesignUuidSchema.optional(),
  intent: z.enum(["save", "compensate"]).default("save"),
});

export const DesignPrepareSaveOutputSchema = reply({ prepared: DesignPreparedSchema });

export const DesignMarkSavedInputSchema = z.strictObject({
  jobId: DesignUuidSchema,
  resultId: DesignHashSchema,
  leaseId: DesignUuidSchema.optional(),
});

export const DesignMarkSavedOutputSchema = reply({ job: DesignJobSchema });

export const DesignSaveFailedInputSchema = z.strictObject({
  jobId: DesignUuidSchema,
  resultId: DesignHashSchema,
  leaseId: DesignUuidSchema,
  phase: z.enum(["roles", "team", "compensation"]),
  reason: z.enum([
    "conflict-exhausted",
    "write-failed",
    "unknown",
    "compensated",
    "partial",
    "canceled",
  ]),
});

export const DesignSaveFailedOutputSchema = reply({ job: DesignJobSchema });

export const DesignCancelInputSchema = z.strictObject({
  jobId: DesignUuidSchema,
});

export const DesignCancelOutputSchema = reply({ job: DesignJobSchema });

export const DesignContinueInputSchema = z.strictObject({
  jobId: DesignUuidSchema,
  expectedRevision: DesignUuidSchema,
  action: z.enum(["recheck", "repair"]),
});

export const DesignContinueOutputSchema = reply({ job: DesignJobSchema });

export type DesignStartInput = z.input<typeof DesignStartInputSchema>;
export type DesignStartOutput = z.output<typeof DesignStartOutputSchema>;
export type DesignStatusInput = z.input<typeof DesignStatusInputSchema>;
export type DesignStatusOutput = z.output<typeof DesignStatusOutputSchema>;
export type DesignResultInput = z.input<typeof DesignResultInputSchema>;
export type DesignResultOutput = z.output<typeof DesignResultOutputSchema>;
export type DesignPrepareSaveInput = z.input<typeof DesignPrepareSaveInputSchema>;
export type DesignPrepareSaveOutput = z.output<typeof DesignPrepareSaveOutputSchema>;
export type DesignMarkSavedInput = z.input<typeof DesignMarkSavedInputSchema>;
export type DesignMarkSavedOutput = z.output<typeof DesignMarkSavedOutputSchema>;
export type DesignSaveFailedInput = z.input<typeof DesignSaveFailedInputSchema>;
export type DesignSaveFailedOutput = z.output<typeof DesignSaveFailedOutputSchema>;
export type DesignCancelInput = z.input<typeof DesignCancelInputSchema>;
export type DesignCancelOutput = z.output<typeof DesignCancelOutputSchema>;
export type DesignContinueInput = z.input<typeof DesignContinueInputSchema>;
export type DesignContinueOutput = z.output<typeof DesignContinueOutputSchema>;

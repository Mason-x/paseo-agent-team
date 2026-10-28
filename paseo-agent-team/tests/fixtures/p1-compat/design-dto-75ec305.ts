// Frozen subset of 75ec305's design DTOs, copied literally (git show 75ec305:…/schemas/*).
// This fixture must not import today's design/launch/team/role schemas: its job is to reject what
// an old reader rejects, even when the current schemas grew new optional fields.
import { z } from "zod";

const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const ShortTextSchema = z.string().trim().min(1).max(40);
const DescriptionSchema = z.string().trim().max(160);
const StringListSchema = z.array(z.string().trim().min(1).max(500)).max(30);
const DesignUuidSchema = z.string().uuid();
const DesignIdSchema = z.string().min(1).max(256);
const DesignTimeSchema = z.string().datetime();
const DesignHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const DesignAttemptSchema = z.number().int().min(1).max(3);
const TeamModeSchema = z.enum(["sota", "economy", "collaborative"]);

const DesignRequestSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value !== "" && [...value].length <= 4000, {
    message: "design.inputInvalid",
  });

const DesignIssueCodeSchema = z.enum([
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
]);

const DesignIssueSchema = z.object({
  code: DesignIssueCodeSchema,
  severity: z.enum(["error", "warning"]),
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  action: z.enum([
    "none",
    "refresh",
    "repair",
    "choose-profile",
    "choose-workspace",
    "retry-save",
    "inspect",
  ]),
});

const ProfileSummarySchema = z.object({
  id: DesignIdSchema,
  name: z.string(),
  provider: DesignIdSchema,
  model: z.string().optional(),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
});

const SeatProfileSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  provider: z.string().min(1),
  model: z.string().optional(),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
});

const ModeIssueSchema = z.strictObject({
  code: z.string().min(1).max(64),
  severity: z.enum(["warning", "blocker"]),
  roleId: z.string().optional(),
  seatId: z.string().optional(),
  profileId: z.string().optional(),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

const SeatPreviewSchema = z.strictObject({
  seatId: z.string().min(1),
  logicalSeatId: z.string().min(1),
  roleId: z.string().min(1),
  roleName: z.string(),
  instanceLabel: z.string().optional(),
  purpose: z.enum(["member", "candidate", "judge", "escalation"]),
  activation: z.enum(["eager", "on-demand", "escalation-only"]),
  cohortId: z.string().optional(),
  profile: SeatProfileSchema.nullable(),
  source: z.enum(["role-preferred", "role-fallback", "economy-pool", "unavailable"]),
  family: z.string().optional(),
  alternates: z.array(z.string()),
  budget: z.enum(["economy", "sota", "unknown"]),
  budgetBasis: z.enum(["host", "pool", "conservative-default"]),
  standby: z.boolean(),
  unavailable: z.boolean(),
  issues: z.array(ModeIssueSchema),
});

const CoordinatorPreviewSchema = z.strictObject({
  roleId: z.string().min(1),
  roleName: z.string(),
  profile: SeatProfileSchema.nullable(),
  source: z.enum(["role-preferred", "role-fallback", "unavailable"]),
  budget: z.enum(["economy", "sota", "unknown"]).optional(),
  budgetBasis: z.enum(["host", "pool", "conservative-default"]).optional(),
  issues: z.array(ModeIssueSchema),
});

const SeatCountsSchema = z.strictObject({
  logical: z.number().int().min(0),
  physical: z.number().int().min(0),
  eager: z.number().int().min(0),
  deferred: z.number().int().min(0),
  escalation: z.number().int().min(0),
  sotaPotential: z.number().int().min(0),
});

const SeatBudgetSchema = z.strictObject({
  economy: z.number().int().min(0),
  sota: z.number().int().min(0),
  unknown: z.number().int().min(0),
  deferredSota: z.number().int().min(0),
});

const ModeLaunchPreviewSchema = z.strictObject({
  requestedMode: TeamModeSchema,
  coordinator: CoordinatorPreviewSchema,
  seats: z.array(SeatPreviewSchema),
  counts: SeatCountsSchema,
  budget: SeatBudgetSchema,
  issues: z.array(ModeIssueSchema),
  warnings: z.array(z.string()),
  planHash: z.string().min(1).max(128),
});

const ProfileHintSchema = z
  .object({
    name: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().optional(),
    modeId: z.string().optional(),
    thinkingOptionId: z.string().optional(),
  })
  .passthrough();

const ProfileRefSchema = z
  .object({
    profileId: z.string().min(1),
    nameSnapshot: z.string().optional(),
    hint: ProfileHintSchema.optional().catch(undefined),
  })
  .passthrough();

const StoredDesignerOriginSchema = z
  .object({
    jobId: z.string().optional(),
    createdAt: z.string().optional(),
    requestExcerpt: z.string().optional(),
  })
  .passthrough();

const StoredRoleExecutionPolicySchema = z
  .object({ tier: z.unknown().optional(), taskKind: z.unknown().optional() })
  .passthrough();

const StoredCollaborationSchema = z
  .object({
    replicas: z.unknown().optional(),
    judgeRoleId: z.unknown().optional(),
    escalationRoleId: z.unknown().optional(),
  })
  .passthrough();

const PresetOriginSchema = z
  .object({
    catalogId: z.string().min(1),
    templateId: z.string().min(1),
    catalogRevision: z.string(),
    templateHash: z.string(),
    appliedHash: z.string(),
    importedAt: z.string(),
  })
  .passthrough();

const TeamMemberSchema = z
  .object({
    roleId: SlugSchema,
    instanceLabel: ShortTextSchema.optional(),
    seatId: z.string().optional(),
    enabled: z.boolean().default(true),
  })
  .passthrough();

const TeamSchema = z
  .object({
    id: SlugSchema,
    name: ShortTextSchema,
    description: DescriptionSchema.optional(),
    memberCreation: z.string().optional(),
    mode: z.string().optional(),
    collaboration: StoredCollaborationSchema.optional(),
    coordinatorRoleId: SlugSchema,
    members: z.array(TeamMemberSchema).min(1),
    operatingRules: z.string().trim().max(4000).optional(),
    enabled: z.boolean().default(true),
    createdAt: z.string(),
    updatedAt: z.string(),
    source: z.string().optional(),
    designer: StoredDesignerOriginSchema.optional().catch(undefined),
  })
  .passthrough();

const RoleSchema = z
  .object({
    id: SlugSchema,
    name: ShortTextSchema,
    description: DescriptionSchema.optional(),
    mission: z.string().trim().min(1).max(2000),
    responsibilities: StringListSchema.min(1),
    restrictions: StringListSchema.default([]),
    systemPrompt: z.string().trim().min(1).max(20000),
    outputContract: StringListSchema.default([]),
    preferredProfiles: z.array(ProfileRefSchema).min(1).max(5),
    fallbackProfiles: z.array(ProfileRefSchema).max(5).default([]),
    color: z.string().max(32).optional(),
    icon: z.string().max(64).optional(),
    enabled: z.boolean().default(true),
    createdAt: z.string(),
    updatedAt: z.string(),
    executionPolicy: StoredRoleExecutionPolicySchema.optional(),
    source: z.string().optional(),
    designer: StoredDesignerOriginSchema.optional().catch(undefined),
    preset: PresetOriginSchema.optional().catch(undefined),
  })
  .passthrough();

export const baselineMode = TeamModeSchema;

export const baselineJob = z.object({
  jobId: DesignUuidSchema,
  clientRequestId: DesignUuidSchema,
  stateRevision: DesignUuidSchema,
  state: z.enum([
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
  ]),
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

export const baselineResult = z.object({
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
  memberReasons: z.array(
    z.object({
      target: z.union([z.literal("coordinator"), z.string().regex(/^m[1-9][0-9]?$/)]),
      logicalSeatId: DesignIdSchema,
      reason: z.string(),
      expectedProfileIds: z.array(DesignIdSchema),
    }),
  ),
  preview: ModeLaunchPreviewSchema,
  planningFingerprint: DesignHashSchema,
  warnings: z.array(DesignIssueSchema),
});

export const baselineFailure = z.object({
  ok: z.literal(false),
  issues: z.array(DesignIssueSchema),
  issuesTruncated: z.number().int().nonnegative().default(0),
  job: baselineJob.nullable(),
});

export const baselineStatusSuccess = z.object({
  ok: z.literal(true),
  scopeId: DesignUuidSchema,
  jobs: z.array(baselineJob),
  truncated: z.boolean(),
  discoveryIssues: z.array(DesignIssueSchema),
});

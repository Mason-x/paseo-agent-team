import { z } from "zod";
import { RoleTierSchema, TaskKindSchema } from "../team-mode";

/**
 * Persisted Run Engine ledger (contract only; the store lives in server/run-engine).
 *
 * Storage rules (05 §2 / AC-RE1.3):
 * - Every stored object is tolerant at every level: unknown fields from a newer writer are kept
 *   through a read/write cycle, so a field this build does not know never disappears. Arrays are
 *   parsed element by element with the same rule.
 * - Enum *values* stay strict for a given `schemaVersion`: an unrecognized state or kind is a
 *   damaged record for this version, not something to guess. Adding a state/kind therefore
 *   requires a `schemaVersion` bump (and the v1 reader must keep leaving v2 bytes untouched).
 * - `schemaVersion` is the record version; the directory `v1` is the layout version. A record with
 *   a different `schemaVersion` never reaches these schemas: the store classifies it before
 *   parsing. These schemas only describe version 1.
 * - No secrets: no API keys, env, MCP headers, full prompts or logs. Evidence stores bounded
 *   summaries plus paths; `artifactPath` root checks belong to the evidence gate (R05), not here.
 *
 * Nothing in this module performs I/O, scheduling, or recovery.
 */

export const RUN_SCHEMA_VERSION = 1;

/** AC-RE1.12 hard capacity. A Run never truncates history or silently splits; it stops instead. */
export const RUN_MAX_TASKS = 64;
export const RUN_SOFT_BYTES = 7 * 1024 * 1024;
export const RUN_HARD_BYTES = 8 * 1024 * 1024;

export const RunIdSchema = z
  .string()
  .max(96)
  .regex(/^run-[a-z0-9]+-[a-z0-9]+$/);
export const RunDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const RunNonceSchema = z.string().uuid();
export const RunTimeSchema = z.string().datetime();
export const RunIdRefSchema = z.string().min(1).max(128);
export const RunPathSchema = z.string().min(1).max(512);
export const RunRevisionSchema = z.number().int().nonnegative();
export const RunSeqSchema = z.number().int().nonnegative();

export const RUN_TASK_STATES = [
  "pending",
  "ready",
  "assigned",
  "in_progress",
  "review",
  "rework",
  "done",
  "failed",
  "blocked",
  "cancelled",
] as const;
export const RunTaskStateSchema = z.enum(RUN_TASK_STATES);
export type RunTaskState = z.infer<typeof RunTaskStateSchema>;

/**
 * Waiting sub-states inside `review`. `review/awaiting-rework` is `state:"review"` +
 * `phase:"awaiting-rework"` (no separate state value); R03/R05/R07 must read it this way.
 */
export const RUN_TASK_PHASES = ["implementation", "review", "smoke", "awaiting-rework"] as const;
export const RunTaskPhaseSchema = z.enum(RUN_TASK_PHASES);
export type RunTaskPhase = z.infer<typeof RunTaskPhaseSchema>;

export const RUN_TIERS = ["S", "A", "B"] as const;
export const RunTierSchema = z.enum(RUN_TIERS);
export type RunTier = z.infer<typeof RunTierSchema>;

export const RUN_LEVELS = ["L1", "L2", "L3", "L4"] as const;
export const RunLevelSchema = z.enum(RUN_LEVELS);
export type RunLevel = z.infer<typeof RunLevelSchema>;

export const RUN_LIFECYCLES = [
  "bootstrapping",
  "awaiting-dag",
  "active",
  "paused",
  "finished",
  "cancelled",
] as const;
export const RunLifecycleSchema = z.enum(RUN_LIFECYCLES);
export type RunLifecycle = z.infer<typeof RunLifecycleSchema>;

export const RUN_ASSIGNMENT_PURPOSES = [
  "member",
  "coordinator",
  "reviewer",
  "smoker",
  "probe",
  "reopen",
] as const;
export const RunAssignmentPurposeSchema = z.enum(RUN_ASSIGNMENT_PURPOSES);

export const RUN_ASSIGNMENT_STATES = [
  "assigned",
  "in_progress",
  "ended",
  "cancelled",
  "failed",
] as const;
export const RunAssignmentStateSchema = z.enum(RUN_ASSIGNMENT_STATES);

/** Artifact identity of a delivery (05 §3). A diff hash is never a git ref. */
export const GitCommitRefShape = {
  kind: z.literal("git-commit"),
  value: z.string().min(1).max(128),
};
export const DiffRefShape = {
  kind: z.literal("diff-sha256"),
  value: RunDigestSchema,
  baseCommit: z.string().min(1).max(128),
  patchPath: RunPathSchema,
};

export const RunArtifactRefSchema = z.discriminatedUnion("kind", [
  z.object(GitCommitRefShape).passthrough(),
  z.object(DiffRefShape).passthrough(),
]);
export type RunArtifactRef = z.infer<typeof RunArtifactRefSchema>;

export const RunScopeShape = {
  repoId: z.string().min(1).max(256),
  kind: z.enum(["file", "directory"]),
  path: RunPathSchema,
  access: z.enum(["read", "write"]),
};
export const RunScopeSchema = z.object(RunScopeShape).passthrough();

export const RunEvidenceRequirementShape = {
  id: z.string().min(1).max(64),
  command: z.string().min(1).max(2000).nullable(),
  artifactKind: z.string().min(1).max(64),
  minLines: z.number().int().min(0).max(100).optional(),
  minFunctions: z.number().int().min(0).max(100).optional(),
  requiresIsolatedHome: z.boolean(),
};
export const RunEvidenceRequirementSchema = z.object(RunEvidenceRequirementShape).passthrough();

export const RunIrreversibleSpecShape = {
  kind: z.enum(["push", "pr", "merge", "real-instance-change", "other"]),
  target: z.string().min(1).max(512),
  description: z.string().min(1).max(600),
  artifactRef: RunArtifactRefSchema.nullable(),
};
export const RunIrreversibleSpecSchema = z.object(RunIrreversibleSpecShape).passthrough();

/** Stored task definition. The protocol's strict TaskSpec reuses this exact shape. */
export const RunTaskSpecShape = {
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(120),
  goal: z.string().min(1).max(2000),
  group: z.string().min(1).max(64),
  deps: z.array(z.string().min(1).max(64)).max(RUN_MAX_TASKS),
  level: RunLevelSchema,
  tier: RunTierSchema,
  execution: z.enum(["write", "read"]),
  scopes: z.array(RunScopeSchema).min(1).max(64),
  acceptance: z.array(z.string().min(1).max(500)).min(1).max(64),
  evidence: z.array(RunEvidenceRequirementSchema).min(1).max(64),
  devSmoke: z.boolean(),
  smokeChecklist: z.array(z.string().min(1).max(500)).max(64),
  irreversible: RunIrreversibleSpecSchema.nullable(),
  reviewPolicy: z.literal("required"),
  implementationPolicy: z.enum(["default", "a-with-s-plan"]),
  architectureTaskId: z.string().min(1).max(64).nullable(),
};
export const RunTaskSpecSchema = z.object(RunTaskSpecShape).passthrough();
export type RunTaskSpec = z.infer<typeof RunTaskSpecSchema>;

/** Evidence summary (05 §3): bounded, redacted, path-only; secrets never enter the ledger. */
export const RunEvidenceShape = {
  id: z.string().min(1).max(64),
  command: z.string().min(1).max(2000).nullable(),
  exitCode: z.number().int(),
  summary: z.string().min(1).max(600),
  artifactPath: RunPathSchema,
  ref: RunArtifactRefSchema,
  coverage: z
    .object({ lines: z.number().min(0).max(100), functions: z.number().min(0).max(100) })
    .passthrough()
    .optional(),
  isolation: z
    .object({ homePath: RunPathSchema, outsideRealHome: z.boolean() })
    .passthrough()
    .optional(),
};
export const RunEvidenceSchema = z.object(RunEvidenceShape).passthrough();
export type RunEvidence = z.infer<typeof RunEvidenceSchema>;

export const RunWorkspaceSchema = z
  .object({
    id: RunIdRefSchema,
    branch: z.string().min(1).max(256),
    baseRef: z.string().min(1).max(256),
  })
  .passthrough();
export type RunWorkspace = z.infer<typeof RunWorkspaceSchema>;

/**
 * Static-quiescence evidence (05 §4 B1). It records what was observed; it does not decide.
 * `endedEventKey === null` or an unconfirmed receipt means quiescence is NOT proven, and the
 * invariant checker treats the task/claim as still held.
 */
export const RunCancellationEvidenceSchema = z
  .object({
    assignmentId: RunIdRefSchema,
    lastTurnId: z.string().min(1).max(128).nullable(),
    endedEventKey: z.string().min(1).max(256).nullable(),
    refreshObservedAt: RunTimeSchema,
    /** Must be ≥ the observationSeq at the refresh that produced this evidence. */
    observationSeq: RunSeqSchema,
    cancelIntentId: RunIdRefSchema,
    receipt: z
      .object({
        kind: z.enum(["archive", "none"]),
        confirmedAt: RunTimeSchema.nullable(),
        externalId: z.string().min(1).max(128).nullable(),
      })
      .passthrough(),
  })
  .passthrough();
export type RunCancellationEvidence = z.infer<typeof RunCancellationEvidenceSchema>;

/**
 * One-time reopen permission for a closed seat (05 §6 B3, review I-1). `intentId` and
 * `expiresAt` are mandatory: a grant is valid only for the dispatch intent it was issued for and
 * only until it expires. A failed reopen creates a NEW assignment (new nonce, same attempt),
 * never a second use of this grant.
 */
export const RunReopenGrantSchema = z
  .object({
    grantId: RunIdRefSchema,
    seatId: RunIdRefSchema,
    agentId: RunIdRefSchema,
    intentId: RunIdRefSchema,
    messageId: z.string().uuid(),
    status: z.enum(["issued", "consumed", "expired"]),
    createdAt: RunTimeSchema,
    expiresAt: RunTimeSchema,
    consumedAt: RunTimeSchema.nullable(),
  })
  .passthrough();
export type RunReopenGrant = z.infer<typeof RunReopenGrantSchema>;

export const RunAssignmentSchema = z
  .object({
    assignmentId: RunIdRefSchema,
    taskId: z.string().min(1).max(64),
    seatId: RunIdRefSchema,
    agentId: RunIdRefSchema,
    profileId: RunIdRefSchema,
    profileName: z.string().min(1).max(200),
    provider: z.string().min(1).max(64),
    model: z.string().min(1).max(128).nullable(),
    family: z.string().min(1).max(64).nullable(),
    channelId: z.string().min(1).max(128),
    tier: RunTierSchema,
    reason: z.string().min(1).max(600),
    purpose: RunAssignmentPurposeSchema,
    workspace: RunWorkspaceSchema.nullable(),
    attempt: z.number().int().min(1),
    nonce: RunNonceSchema,
    messageId: z.string().uuid().nullable(),
    turnId: z.string().min(1).max(128).nullable(),
    state: RunAssignmentStateSchema,
    createdAt: RunTimeSchema,
    startedAt: RunTimeSchema.nullable(),
    endedAt: RunTimeSchema.nullable(),
    cancellation: RunCancellationEvidenceSchema.nullable().optional(),
    reopenGrantId: RunIdRefSchema.nullable().optional(),
    reopenOfAssignmentId: RunIdRefSchema.nullable().optional(),
    supersededByAssignmentId: RunIdRefSchema.nullable().optional(),
  })
  .passthrough();
export type RunAssignment = z.infer<typeof RunAssignmentSchema>;

export const RunNonceEntrySchema = z
  .object({
    nonce: RunNonceSchema,
    runId: RunIdSchema,
    taskId: z.string().min(1).max(64),
    assignmentId: RunIdRefSchema.nullable(),
    attempt: z.number().int().min(1),
    phase: RunTaskPhaseSchema,
    agentId: RunIdRefSchema,
    seatId: RunIdRefSchema,
    issuedAt: RunTimeSchema,
    acceptedAt: RunTimeSchema.nullable(),
    acceptedEventKey: z.string().min(1).max(256).nullable(),
    revokedAt: RunTimeSchema.nullable(),
    revokeReason: z.string().min(1).max(200).nullable(),
  })
  .passthrough();
export type RunNonceEntry = z.infer<typeof RunNonceEntrySchema>;

export const RUN_EVENT_RECEIPT_KINDS = [
  "turn_started",
  "turn_ended",
  "permission_requested",
  "permission_resolved",
  "created",
  "closed",
  "archived",
  "workspace_archived",
] as const;
export const RunEventReceiptSchema = z
  .object({
    eventKey: z.string().min(1).max(256),
    kind: z.enum(RUN_EVENT_RECEIPT_KINDS),
    agentId: RunIdRefSchema.nullable(),
    turnId: z.string().min(1).max(128).nullable(),
    seq: RunSeqSchema,
    receivedAt: RunTimeSchema,
    dedupeKey: z.string().min(1).max(256),
    disposition: z.enum(["accepted", "ignored", "audit-only", "observed"]),
  })
  .passthrough();
export type RunEventReceipt = z.infer<typeof RunEventReceiptSchema>;

/** A stored event. `kind` is the only mutation vocabulary; R03 owns the reducer. */
export const RunEventSchema = z
  .object({
    seq: RunSeqSchema,
    kind: z.string().min(1).max(64),
    at: RunTimeSchema,
    payload: z.record(z.string(), z.unknown()),
  })
  .passthrough();
export type RunEvent = z.infer<typeof RunEventSchema>;

/**
 * Monotonic counters. They are part of the compressed checkpoint (I6): after compression the
 * counters still come from `checkpoint.counters` plus the remaining events, so counts can always
 * be recomputed. `observationSeq` never decreases across checkpoints.
 */
export const RunCountersSchema = z
  .object({
    observationSeq: RunSeqSchema,
    eventsThroughSeq: RunSeqSchema,
    probeAttempts: z.number().int().nonnegative(),
    reopenAttempts: z.number().int().nonnegative(),
  })
  .passthrough();
export type RunCounters = z.infer<typeof RunCountersSchema>;

export const RunHistoryCheckpointSchema = z
  .object({
    throughSeq: RunSeqSchema,
    historyDigest: RunDigestSchema,
    counters: RunCountersSchema,
    /** Digest of each accepted nonce for de-duplication; the nonce itself is not retained here. */
    acceptedNonceDigests: z.array(RunDigestSchema).max(4096),
    terminalAssignmentIds: z.array(RunIdRefSchema).max(4096),
  })
  .passthrough();
export type RunHistoryCheckpoint = z.infer<typeof RunHistoryCheckpointSchema>;

export const RunSeatSnapshotSchema = z
  .object({
    seatId: RunIdRefSchema,
    tier: RunTierSchema,
    agentId: RunIdRefSchema,
    channelId: z.string().min(1).max(128),
    duties: z.array(z.string().min(1).max(64)).max(16),
    enabled: z.boolean(),
  })
  .passthrough();
export type RunSeatSnapshot = z.infer<typeof RunSeatSnapshotSchema>;

export const RunResourceClaimSchema = z
  .object({
    claimId: RunIdRefSchema,
    taskId: z.string().min(1).max(64),
    repoId: z.string().min(1).max(256),
    kind: z.enum(["file", "directory"]),
    path: RunPathSchema,
    access: z.enum(["read", "write"]),
    frozen: z.boolean(),
    createdAt: RunTimeSchema,
  })
  .passthrough();

export const RunBudgetEntrySchema = z
  .object({
    scope: z.enum(["seat", "group"]),
    subjectId: RunIdRefSchema,
    limit: z.number().int().nonnegative(),
    reserved: z.number().int().nonnegative(),
    confirmed: z.number().int().nonnegative(),
    observedTurns: z.number().int().nonnegative(),
  })
  .passthrough();

export const RunDecisionPointSchema = z
  .object({
    decisionId: z.string().uuid(),
    category: z.enum(["D1", "D2", "D3", "D4", "D5", "D6", "D7"]),
    state: z.enum(["open", "answered", "waiting-human"]),
    dedupeKey: z.string().min(1).max(256),
    subjectId: RunIdRefSchema.nullable(),
    summary: z.string().min(1).max(4096),
    createdAt: RunTimeSchema,
    answeredAt: RunTimeSchema.nullable(),
  })
  .passthrough();

export const RunApprovalSchema = z
  .object({
    approvalId: RunIdRefSchema,
    decisionId: z.string().uuid(),
    requestId: z.string().min(1).max(128),
    subjectHash: RunDigestSchema,
    approve: z.boolean(),
    reason: z.string().min(1).max(600),
    approvedAt: RunTimeSchema,
    consumedAt: RunTimeSchema.nullable(),
  })
  .passthrough();

export const RunChannelAvailabilitySchema = z
  .object({
    channelId: z.string().min(1).max(128),
    profileIds: z.array(RunIdRefSchema).max(64),
    state: z.enum(["available", "paused", "unknown"]),
    unavailableUntil: RunTimeSchema.nullable(),
    scope: z.enum(["session", "channel"]),
    source: z.enum(["structured-error", "human", "usage-source"]),
    code: z.string().min(1).max(128).nullable(),
    observedAt: RunTimeSchema,
    incidentId: RunIdRefSchema,
    revision: RunRevisionSchema,
  })
  .passthrough();

export const RunAlertSchema = z
  .object({
    alertId: RunIdRefSchema,
    state: z.enum(["open", "acknowledged", "resolved"]),
    severity: z.enum(["info", "warning", "critical"]),
    summary: z.string().min(1).max(1000),
    createdAt: RunTimeSchema,
    acknowledgedAt: RunTimeSchema.nullable(),
    resolvedAt: RunTimeSchema.nullable(),
  })
  .passthrough();

export const RunMetricsBookSchema = z
  .object({
    strategicTurns: z.number().int().nonnegative(),
    workerEvents: z.number().int().nonnegative(),
    decisions: z.number().int().nonnegative(),
    tasks: z.number().int().nonnegative(),
    reworks: z.number().int().nonnegative(),
    firstReviewAccepted: z.number().int().nonnegative(),
    coverage: z.enum(["complete", "partial", "unknown"]),
  })
  .passthrough();

/**
 * Frozen planning basis (05 §5 / AC-RE4.9, review B1). Dispatch re-runs P1's
 * `buildTeamModelPlan` with exactly these inputs; it never re-reads mutable Team/Role/settings.
 */
export const RunModelPlanBasisSchema = z
  .object({
    launchPlanFingerprint: RunDigestSchema,
    mode: z.string().min(1).max(64),
    targetWorkspaceId: z.string().min(1).max(128).nullable(),
    task: z.string().min(1).max(4000),
    maxMembers: z.number().int().min(1),
    runtimeCapabilities: z
      .object({
        onDemand: z.boolean(),
        expansion: z.boolean(),
        collaboration: z.boolean(),
      })
      .passthrough(),
    team: z
      .object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(200),
        rawMode: z.string().min(1).max(64),
        modeContract: z.number().int().min(1),
        plannerVersion: z.number().int().min(1),
        coordinatorRoleId: z.string().min(1).max(64),
        members: z
          .array(
            z
              .object({
                seatId: z.string().min(1).max(64).optional(),
                roleId: z.string().min(1).max(64),
                instanceLabel: z.string().min(1).max(40).optional(),
                enabled: z.boolean(),
              })
              .passthrough(),
          )
          .max(256),
        memberCreation: z.string().max(64).nullable(),
        collaboration: z.record(z.string(), z.unknown()).nullable(),
      })
      .passthrough(),
    roles: z
      .array(
        z
          .object({
            roleId: z.string().min(1).max(64),
            roleName: z.string().min(1).max(200),
            enabled: z.boolean(),
            executionPolicy: z
              .object({
                tier: RoleTierSchema,
                taskKind: TaskKindSchema,
              })
              .passthrough()
              .nullable(),
            preferredProfiles: z.array(z.record(z.string(), z.unknown())).max(64),
            fallbackProfiles: z.array(z.record(z.string(), z.unknown())).max(64),
          })
          .passthrough(),
      )
      .max(256),
    /** Normalized economy policy, including allSeats, exactly as P1 planning consumes it. */
    economy: z.record(z.string(), z.unknown()).nullable(),
    /** P1 profile tuple shape: provider/model plus the runtime selection fields. */
    profileTuples: z
      .array(
        z
          .object({
            profileId: z.string().min(1).max(128),
            provider: z.string().min(1).max(64),
            model: z.string().min(1).max(128).optional(),
            modeId: z.string().min(1).max(128).optional(),
            thinkingOptionId: z.string().min(1).max(128).optional(),
            featureValues: z.record(z.string(), z.unknown()).optional(),
          })
          .passthrough(),
      )
      .max(512),
    rosterFingerprint: RunDigestSchema,
  })
  .passthrough();
export type RunModelPlanBasis = z.infer<typeof RunModelPlanBasisSchema>;

export const RunTaskRecordSchema = z
  .object({
    spec: RunTaskSpecSchema,
    state: RunTaskStateSchema,
    phase: RunTaskPhaseSchema.optional(),
    waitingReason: z.string().min(1).max(600).nullable(),
    ref: RunArtifactRefSchema.nullable(),
    changedFiles: z.array(RunPathSchema).max(512),
    currentAssignmentId: RunIdRefSchema.nullable(),
    attempts: z.number().int().min(0),
    protocolFailures: z.number().int().nonnegative(),
    evidenceReturns: z.number().int().nonnegative(),
    reworkCount: z.number().int().nonnegative(),
    qualityFailures: z.number().int().nonnegative(),
    escalations: z.array(z.record(z.string(), z.unknown())).max(16),
    frozenClaimId: RunIdRefSchema.nullable(),
    /** Explicit decision that released a frozen/blocked task (05 §4 B1); never implicit. */
    releaseDecisionId: z.string().uuid().nullable(),
  })
  .passthrough();
export type RunTaskRecord = z.infer<typeof RunTaskRecordSchema>;

/**
 * Outbox intent. Branches are discriminated by `kind`:
 * - business kinds carry `taskId`/`assignmentId` and never `controlAttempt`;
 * - `probe`/`reopen` are control intents: `controlAttempt` is mandatory, `probe` carries only the
 *   channel + control nonce and `noBusinessWrites`, and has no task scope.
 * Whether a probe target actually holds a claim is a runtime invariant (R05/R08), not schema.
 */
const IntentBaseShape = {
  id: RunIdRefSchema,
  recipient: RunIdRefSchema,
  messageId: z.string().uuid(),
  idempotencyKey: z.string().min(1).max(256),
  payloadHash: RunDigestSchema,
  templateVersion: z.number().int().min(1),
  state: z.enum(["prepared", "sending", "confirmed", "outcome-unknown", "failed"]),
  recoverySendCount: z.number().int().nonnegative().max(1),
  createdAt: RunTimeSchema,
  confirmedAt: RunTimeSchema.nullable(),
};

export const RunEffectIntentSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...IntentBaseShape,
        kind: z.literal("dispatch"),
        taskId: z.string().min(1).max(64),
        assignmentId: RunIdRefSchema,
        semanticArgs: z.record(z.string(), z.unknown()),
      })
      .passthrough(),
    z
      .object({
        ...IntentBaseShape,
        kind: z.literal("create-agent"),
        taskId: z.string().min(1).max(64),
        assignmentId: RunIdRefSchema.nullable(),
        semanticArgs: z.record(z.string(), z.unknown()),
      })
      .passthrough(),
    z
      .object({
        ...IntentBaseShape,
        kind: z.literal("create-workspace"),
        taskId: z.string().min(1).max(64),
        assignmentId: RunIdRefSchema.nullable(),
        semanticArgs: z.record(z.string(), z.unknown()),
      })
      .passthrough(),
    z
      .object({
        ...IntentBaseShape,
        kind: z.literal("wake"),
        taskId: z.string().min(1).max(64),
        assignmentId: RunIdRefSchema.nullable(),
        semanticArgs: z.record(z.string(), z.unknown()),
      })
      .passthrough(),
    z
      .object({
        ...IntentBaseShape,
        kind: z.literal("archive"),
        taskId: z.string().min(1).max(64),
        assignmentId: RunIdRefSchema.nullable(),
        semanticArgs: z.record(z.string(), z.unknown()),
      })
      .passthrough(),
    z
      .object({
        ...IntentBaseShape,
        kind: z.literal("reopen"),
        taskId: z.string().min(1).max(64),
        assignmentId: RunIdRefSchema.nullable(),
        controlAttempt: z.number().int().min(1),
        semanticArgs: z.record(z.string(), z.unknown()),
      })
      .passthrough(),
    z
      .object({
        ...IntentBaseShape,
        kind: z.literal("probe"),
        controlAttempt: z.number().int().min(1),
        semanticArgs: z
          .object({
            channelId: z.string().min(1).max(128),
            controlNonce: RunNonceSchema,
            noBusinessWrites: z.literal(true),
          })
          .passthrough(),
      })
      .passthrough(),
  ])
  .superRefine((intent, ctx) => {
    // Branch exclusivity is semantic, not a "future field": a business intent must not fake a
    // control counter, and a probe must not smuggle a task scope.
    const isControl = intent.kind === "probe" || intent.kind === "reopen";
    if (!isControl && "controlAttempt" in intent) {
      ctx.addIssue({
        code: "custom",
        message: "controlAttempt is only valid on probe/reopen intents",
        path: ["controlAttempt"],
      });
    }
    if (intent.kind === "probe" && ("taskId" in intent || "assignmentId" in intent)) {
      ctx.addIssue({
        code: "custom",
        message: "a probe intent has no task scope",
        path: ["taskId"],
      });
    }
  });
export type RunEffectIntent = z.infer<typeof RunEffectIntentSchema>;

export const RunRecordSchema = z
  .object({
    schemaVersion: z.literal(RUN_SCHEMA_VERSION),
    runId: RunIdSchema,
    revision: RunRevisionSchema,
    previousDigest: RunDigestSchema,
    createdAt: RunTimeSchema,
    updatedAt: RunTimeSchema,
    hostBinding: z.object({ serverId: z.string().min(1).max(128) }).passthrough(),
    launch: z
      .object({
        requestId: z.string().min(1).max(128),
        requestHash: RunDigestSchema,
        planHash: RunDigestSchema,
        state: z.enum([
          "preparing",
          "creating",
          "kickoff-pending",
          "running",
          "failed",
          "cancelled",
        ]),
        modelPlan: RunModelPlanBasisSchema,
      })
      .passthrough(),
    team: z
      .object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(200),
        rawMode: z.string().min(1).max(64),
        /** Negotiated P1 value; never hard-code 2 (AC-RE1.13). */
        modeContract: z.number().int().min(1),
        plannerVersion: z.number().int().min(1),
        modelPlanHash: RunDigestSchema,
      })
      .passthrough(),
    lifecycle: RunLifecycleSchema,
    policy: z.record(z.string(), z.unknown()),
    roster: z.array(RunSeatSnapshotSchema).max(64),
    dagRevision: z.number().int().min(0),
    tasks: z.array(RunTaskRecordSchema).max(RUN_MAX_TASKS),
    resources: z.array(RunResourceClaimSchema).max(4096),
    assignments: z.array(RunAssignmentSchema).max(4096),
    reopenGrants: z.array(RunReopenGrantSchema).max(1024),
    outbox: z.array(RunEffectIntentSchema).max(4096),
    nonceRegistry: z.array(RunNonceEntrySchema).max(8192),
    eventReceipts: z.array(RunEventReceiptSchema).max(8192),
    events: z.array(RunEventSchema).max(8192),
    checkpoint: RunHistoryCheckpointSchema.optional(),
    counters: RunCountersSchema,
    budgets: z
      .object({
        entries: z.array(RunBudgetEntrySchema).max(256),
      })
      .passthrough(),
    decisions: z.array(RunDecisionPointSchema).max(1024),
    approvals: z.array(RunApprovalSchema).max(1024),
    channels: z.array(RunChannelAvailabilitySchema).max(256),
    alerts: z.array(RunAlertSchema).max(1024),
    metrics: RunMetricsBookSchema,
  })
  .passthrough();
export type RunRecord = z.infer<typeof RunRecordSchema>;

/** Stored policy snapshot. Its stored copy is tolerant; config.ts owns the writer shape. */
export const RunPolicySnapshotSchema = z
  .object({
    policyVersion: z.number().int().min(1),
    configuredConcurrency: z.number().int().min(1).max(64),
    perTask: z
      .object({
        protocolResends: z.number().int().min(0).max(10),
        evidenceReturns: z.number().int().min(0).max(10),
        reworkPerLayer: z.number().int().min(0).max(5),
        implementationAttempts: z.number().int().min(1).max(32),
      })
      .passthrough(),
    run: z
      .object({
        failedTasks: z.number().int().min(0).max(64),
        strategicTurns: z.number().int().min(0).max(256),
      })
      .passthrough(),
    seatBudgets: z.array(RunBudgetEntrySchema).max(64),
    groupBudgets: z.array(RunBudgetEntrySchema).max(64),
    controlAttempts: z
      .object({
        probe: z.number().int().min(0).max(32),
        reopen: z.number().int().min(0).max(32),
      })
      .passthrough(),
    disabledProfileIds: z.array(RunIdRefSchema).max(512),
    disabledChannels: z.array(z.string().min(1).max(128)).max(256),
    capabilityRulesVersion: z.string().min(1).max(64),
    devTargets: z
      .array(
        z
          .object({
            serverId: z.string().min(1).max(128),
            host: z.string().min(1).max(256),
            home: RunPathSchema,
          })
          .passthrough(),
      )
      .max(16),
    evidenceRoot: RunPathSchema,
    requestLimits: z
      .object({
        burst: z.number().int().min(1).max(64),
        perMinute: z.number().int().min(1).max(600),
      })
      .passthrough(),
    /** archived seats revive only by an explicit resume-seat control (05 §6 B3). */
    archiveResume: z
      .object({
        seatRevival: z.literal("explicit-resume-seat"),
        keepsArchivedAssignments: z.boolean(),
      })
      .passthrough(),
    capacity: z
      .object({
        softBytes: z.number().int().min(1).max(RUN_SOFT_BYTES).optional(),
      })
      .passthrough(),
  })
  .passthrough();

// Shared builders for the offline Run Engine fixtures, aligned with the implemented R01 ledger
// contract (`shared/schemas/run-engine/ledger.ts`). Data only: no IO, no runtime product imports
// (types are imported type-only), and every value is a plain JSON object.
import type {
  RunAssignment,
  RunCancellationEvidence,
  RunEffectIntent,
  RunPolicySnapshot,
  RunRecord,
  RunResourceClaim,
  RunTaskRecord,
  RunTaskSpec,
} from "./types";

export const REPO_ID = "repo-re-verify";
export const RUN_ID = "run-rec0re-a1";
export const AT_CREATED = "2026-10-27T12:00:00.000Z";
export const AT_UPDATED = "2026-10-27T12:34:56.000Z";

/** R01 digests are bare lowercase hex, never prefixed (RunDigestSchema). */
export const DIGEST_A = "a".repeat(64);
export const DIGEST_B = "b".repeat(64);
export const DIGEST_C = "c".repeat(64);
export const DIGEST_D = "d".repeat(64);
export const DIGEST_E = "e".repeat(64);
export const DIGEST_F = "f".repeat(64);
export const DIGEST_1 = "1".repeat(64);
export const DIGEST_2 = "2".repeat(64);

export const NONCE_T1 = "6f1c2a44-3b7e-4f0a-9a11-000000000001";
export const NONCE_T2 = "6f1c2a44-3b7e-4f0a-9a11-000000000002";
export const NONCE_T3 = "6f1c2a44-3b7e-4f0a-9a11-000000000003";
export const NONCE_PROBE = "6f1c2a44-3b7e-4f0a-9a11-000000000006";

export const MESSAGE_T1 = "11111111-1111-4111-8111-111111111111";
export const MESSAGE_T2 = "22222222-2222-4222-8222-222222222222";
export const MESSAGE_CANCEL = "33333333-3333-4333-8333-333333333333";
export const MESSAGE_PROBE = "44444444-4444-4444-8444-444444444444";
export const MESSAGE_REOPEN = "55555555-5555-4555-8555-555555555555";
export const DECISION_D1 = "66666666-6666-4666-8666-666666666666";
export const DECISION_D4 = "77777777-7777-4777-8777-777777777777";
export const DECISION_D6 = "88888888-8888-4888-8888-888888888888";

export const PROFILE_HAIKU = {
  id: "profile-dev-haiku",
  name: "DEV Haiku 5.5",
  provider: "claude",
  model: "claude-haiku-5-5",
  family: "haiku",
  channelId: "claude",
} as const;

export const ASSIGNMENT_T2 = "assignment-t2-a1";
export const CLAIM_T2 = "claim-t2";
export const INTENT_T2 = "intent-t2-a1";
export const INTENT_T1 = "intent-t1-a1";
export const INTENT_CANCEL = "intent-cancel-t2";

export function spec(
  id: string,
  title: string,
  overrides: Record<string, unknown> = {},
): RunTaskSpec {
  return {
    id,
    title,
    goal: `Deliver ${id} within the declared scope.`,
    group: "core",
    deps: [],
    level: "L2",
    tier: "B",
    execution: "write",
    scopes: [
      { repoId: REPO_ID, kind: "file", path: `src/${id.toLowerCase()}.ts`, access: "write" },
    ],
    acceptance: ["AC-1"],
    evidence: [
      {
        id: "five-gates",
        command: "npm run check && npm run typecheck && npm test",
        artifactKind: "command-output",
        requiresIsolatedHome: true,
      },
    ],
    devSmoke: false,
    smokeChecklist: [],
    irreversible: null,
    reviewPolicy: "required",
    implementationPolicy: "default",
    architectureTaskId: null,
    ...overrides,
  } as RunTaskSpec;
}

export function taskRecord(
  specValue: RunTaskSpec,
  overrides: Partial<RunTaskRecord> & Record<string, unknown> = {},
): RunTaskRecord {
  return {
    spec: specValue,
    state: "pending",
    waitingReason: null,
    ref: null,
    changedFiles: [],
    currentAssignmentId: null,
    attempts: 0,
    protocolFailures: 0,
    evidenceReturns: 0,
    reworkCount: 0,
    qualityFailures: 0,
    escalations: [],
    frozenClaimId: null,
    releaseDecisionId: null,
    ...overrides,
  };
}

/** A ready task with sane defaults; the fixture name stays `task()` for readability. */
export function task(
  id: string,
  title: string,
  overrides: Partial<RunTaskRecord> & Record<string, unknown> = {},
  specOverrides: Record<string, unknown> = {},
): RunTaskRecord {
  return taskRecord(spec(id, title, specOverrides), overrides);
}

export function assignment(
  overrides: Partial<RunAssignment> & Record<string, unknown> = {},
): RunAssignment {
  return {
    assignmentId: ASSIGNMENT_T2,
    taskId: "T2",
    seatId: "seat-b1",
    agentId: "agent-b1",
    profileId: PROFILE_HAIKU.id,
    profileName: PROFILE_HAIKU.name,
    provider: PROFILE_HAIKU.provider,
    model: PROFILE_HAIKU.model,
    family: PROFILE_HAIKU.family,
    channelId: PROFILE_HAIKU.channelId,
    tier: "B",
    reason: "L2/B: lowest load, last quality pass",
    purpose: "member",
    workspace: { id: "ws-run-rec0re-a1-t2", branch: "re-rec0rea1-t2-a1-1", baseRef: "main" },
    attempt: 1,
    nonce: NONCE_T2,
    messageId: MESSAGE_T2,
    turnId: null,
    state: "assigned",
    createdAt: AT_CREATED,
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

export function dispatchIntent(
  overrides: Partial<RunEffectIntent> & Record<string, unknown> = {},
): RunEffectIntent {
  return {
    id: INTENT_T2,
    kind: "dispatch",
    recipient: "agent-b1",
    messageId: MESSAGE_T2,
    idempotencyKey: "dispatch-T2-a1",
    payloadHash: DIGEST_A,
    templateVersion: 1,
    state: "confirmed",
    recoverySendCount: 0,
    createdAt: AT_CREATED,
    confirmedAt: AT_CREATED,
    taskId: "T2",
    assignmentId: ASSIGNMENT_T2,
    semanticArgs: { promptBytes: 4096 },
    ...overrides,
  } as RunEffectIntent;
}

export function probeIntent(
  overrides: Partial<RunEffectIntent> & Record<string, unknown> = {},
): RunEffectIntent {
  return {
    id: "intent-probe-1",
    kind: "probe",
    recipient: "agent-s1",
    messageId: MESSAGE_PROBE,
    idempotencyKey: "probe-claude-1",
    payloadHash: DIGEST_B,
    templateVersion: 1,
    state: "prepared",
    recoverySendCount: 0,
    createdAt: AT_CREATED,
    confirmedAt: null,
    controlAttempt: 1,
    semanticArgs: { channelId: "claude", controlNonce: NONCE_PROBE, noBusinessWrites: true },
    ...overrides,
  } as RunEffectIntent;
}

export function reopenIntent(
  overrides: Partial<RunEffectIntent> & Record<string, unknown> = {},
): RunEffectIntent {
  return {
    id: "intent-reopen-t2",
    kind: "reopen",
    recipient: "agent-b1",
    messageId: MESSAGE_REOPEN,
    idempotencyKey: "reopen-T2-1",
    payloadHash: DIGEST_C,
    templateVersion: 1,
    state: "prepared",
    recoverySendCount: 0,
    createdAt: AT_UPDATED,
    confirmedAt: null,
    taskId: "T2",
    assignmentId: ASSIGNMENT_T2,
    controlAttempt: 1,
    semanticArgs: { reason: "closed-while-assigned" },
    ...overrides,
  } as RunEffectIntent;
}

export function claim(
  overrides: Partial<RunResourceClaim> & Record<string, unknown> = {},
): RunResourceClaim {
  return {
    claimId: CLAIM_T2,
    taskId: "T2",
    repoId: REPO_ID,
    kind: "file",
    path: "src/t2.ts",
    access: "write",
    frozen: false,
    createdAt: AT_CREATED,
    ...overrides,
  };
}

export function policy(
  overrides: Partial<RunPolicySnapshot> & Record<string, unknown> = {},
): RunPolicySnapshot {
  return {
    policyVersion: 1,
    configuredConcurrency: 4,
    perTask: {
      protocolResends: 2,
      evidenceReturns: 3,
      reworkPerLayer: 2,
      implementationAttempts: 6,
    },
    run: { failedTasks: 3, strategicTurns: 12 },
    seatBudgets: [
      {
        scope: "seat",
        subjectId: "seat-b1",
        limit: 6,
        reserved: 1,
        confirmed: 1,
        observedTurns: 1,
      },
    ],
    groupBudgets: [],
    controlAttempts: { probe: 2, reopen: 2 },
    disabledProfileIds: [],
    disabledChannels: [],
    capabilityRulesVersion: "2026-10-27",
    devTargets: [{ serverId: "dev-server-1", host: "127.0.0.1:6799", home: "/tmp/dev-home" }],
    evidenceRoot: "evidence",
    requestLimits: { burst: 8, perMinute: 12 },
    archiveResume: { seatRevival: "explicit-resume-seat", keepsArchivedAssignments: true },
    capacity: { softBytes: 7 * 1024 * 1024 },
    ...overrides,
  } as RunPolicySnapshot;
}

export function modelPlan(overrides: Record<string, unknown> = {}) {
  return {
    launchPlanFingerprint: DIGEST_1,
    mode: "economy-all",
    targetWorkspaceId: null,
    task: "Baseline launch task",
    maxMembers: 8,
    runtimeCapabilities: { onDemand: false, expansion: false, collaboration: false },
    team: {
      id: "team-re-verify",
      name: "RE Verify Team",
      rawMode: "economy-all",
      modeContract: 2,
      plannerVersion: 2,
      coordinatorRoleId: "lead-orchestrator",
      members: [{ seatId: "seat-b1", roleId: "eng-fullstack", enabled: true }],
      memberCreation: "eager",
      collaboration: null,
    },
    roles: [
      {
        roleId: "eng-fullstack",
        roleName: "Developer",
        enabled: true,
        executionPolicy: { tier: "execution", taskKind: "coding" },
        preferredProfiles: [{ profileId: PROFILE_HAIKU.id, hint: { name: PROFILE_HAIKU.name } }],
        fallbackProfiles: [],
      },
    ],
    economy: { pool: [], allSeats: null },
    profileTuples: [
      {
        profileId: PROFILE_HAIKU.id,
        provider: PROFILE_HAIKU.provider,
        model: PROFILE_HAIKU.model,
        modeId: "full",
        thinkingOptionId: "high",
      },
    ],
    rosterFingerprint: DIGEST_2,
    ...overrides,
  };
}

export const QUIESCENT_CANCELLATION: RunCancellationEvidence = {
  assignmentId: ASSIGNMENT_T2,
  lastTurnId: "turn-7",
  endedEventKey: "agent-b1|turn-7|turn_ended",
  refreshObservedAt: AT_UPDATED,
  observationSeq: 7,
  cancelIntentId: INTENT_CANCEL,
  receipt: { kind: "archive", confirmedAt: AT_UPDATED, externalId: "archive-1" },
};

export const PARTIAL_CANCELLATION: RunCancellationEvidence = {
  ...QUIESCENT_CANCELLATION,
  receipt: { kind: "none", confirmedAt: null, externalId: null },
};

const T1 = taskRecord(spec("T1", "Core API surface"), {
  state: "done",
  ref: { kind: "git-commit", value: "9f3c1a7" },
  changedFiles: ["src/t1.ts"],
  attempts: 1,
  reviews: [
    {
      reviewerAgentId: "agent-b2",
      reviewerSeatId: "seat-b2",
      verdict: "可合入",
      reviewedRef: { kind: "git-commit", value: "9f3c1a7" },
      blockers: [],
    },
  ],
});

const T2 = taskRecord(spec("T2", "Core implementation"), {
  state: "in_progress",
  phase: "implementation",
  currentAssignmentId: ASSIGNMENT_T2,
  attempts: 1,
});

const T3 = taskRecord(spec("T3", "Operator docs", { group: "docs", deps: ["T2"] }), {
  state: "pending",
});

export { T1, T2, T3 };

export const NORMAL_RUN_LEDGER: RunRecord = {
  schemaVersion: 1,
  runId: RUN_ID,
  revision: 7,
  previousDigest: DIGEST_A,
  createdAt: AT_CREATED,
  updatedAt: AT_UPDATED,
  hostBinding: { serverId: "srv-dev-1" },
  launch: {
    requestId: "req-rec0re-a1",
    requestHash: DIGEST_B,
    planHash: DIGEST_1,
    state: "running",
    modelPlan: modelPlan() as RunRecord["launch"]["modelPlan"],
  },
  team: {
    id: "team-re-verify",
    name: "RE Verify Team",
    rawMode: "economy-all",
    modeContract: 2,
    plannerVersion: 2,
    modelPlanHash: DIGEST_C,
  },
  lifecycle: "active",
  policy: policy(),
  roster: [
    {
      seatId: "seat-s1",
      tier: "S",
      agentId: "agent-s1",
      channelId: "claude",
      duties: ["coordinate"],
      enabled: true,
    },
    {
      seatId: "seat-b1",
      tier: "B",
      agentId: "agent-b1",
      channelId: "claude",
      duties: ["implement"],
      enabled: true,
    },
    {
      seatId: "seat-b2",
      tier: "B",
      agentId: "agent-b2",
      channelId: "claude",
      duties: ["review"],
      enabled: true,
    },
  ],
  dagRevision: 1,
  tasks: [T1, T2, T3],
  resources: [claim()],
  assignments: [assignment()],
  reopenGrants: [],
  outbox: [
    dispatchIntent({
      id: INTENT_T1,
      taskId: "T1",
      assignmentId: "assignment-t1-a1",
      messageId: MESSAGE_T1,
      idempotencyKey: "dispatch-T1-a1",
    }),
    dispatchIntent(),
  ],
  nonceRegistry: [
    {
      nonce: NONCE_T1,
      runId: RUN_ID,
      taskId: "T1",
      assignmentId: "assignment-t1-a1",
      attempt: 1,
      phase: "implementation",
      agentId: "agent-b1",
      seatId: "seat-b1",
      issuedAt: AT_CREATED,
      acceptedAt: AT_CREATED,
      acceptedEventKey: "agent-b1|turn-6|turn_ended",
      revokedAt: null,
      revokeReason: null,
    },
    {
      nonce: NONCE_T2,
      runId: RUN_ID,
      taskId: "T2",
      assignmentId: ASSIGNMENT_T2,
      attempt: 1,
      phase: "implementation",
      agentId: "agent-b1",
      seatId: "seat-b1",
      issuedAt: AT_UPDATED,
      acceptedAt: null,
      acceptedEventKey: null,
      revokedAt: null,
      revokeReason: null,
    },
  ],
  eventReceipts: [
    {
      eventKey: "agent-b1|turn-7|turn_ended",
      kind: "turn_ended",
      agentId: "agent-b1",
      turnId: "turn-7",
      seq: 7,
      receivedAt: AT_UPDATED,
      dedupeKey: "agent-b1|turn-7|turn_ended",
      disposition: "accepted",
    },
  ],
  events: [
    { seq: 1, kind: "run_created", at: AT_CREATED, payload: {} },
    { seq: 2, kind: "dag_accepted", at: AT_CREATED, payload: { dagRevision: 1 } },
    { seq: 3, kind: "task_assigned", at: AT_CREATED, payload: { taskId: "T1" } },
    { seq: 4, kind: "task_transition", at: AT_CREATED, payload: { taskId: "T1", to: "done" } },
    { seq: 5, kind: "task_assigned", at: AT_UPDATED, payload: { taskId: "T2" } },
    { seq: 6, kind: "turn_started", at: AT_UPDATED, payload: { taskId: "T2", turnId: "turn-7" } },
    { seq: 7, kind: "turn_ended", at: AT_UPDATED, payload: { taskId: "T2", turnId: "turn-7" } },
  ],
  counters: { observationSeq: 7, eventsThroughSeq: 7, probeAttempts: 0, reopenAttempts: 0 },
  budgets: {
    entries: [
      {
        scope: "seat",
        subjectId: "seat-s1",
        limit: 12,
        reserved: 2,
        confirmed: 1,
        observedTurns: 1,
      },
      {
        scope: "seat",
        subjectId: "seat-b1",
        limit: 6,
        reserved: 1,
        confirmed: 1,
        observedTurns: 1,
      },
    ],
  },
  decisions: [],
  approvals: [],
  channels: [
    {
      channelId: "claude",
      profileIds: [PROFILE_HAIKU.id],
      state: "available",
      unavailableUntil: null,
      scope: "channel",
      source: "usage-source",
      code: null,
      observedAt: AT_UPDATED,
      incidentId: "incident-claude-0",
      revision: 1,
    },
    {
      channelId: "codex",
      profileIds: ["profile-dev-luna"],
      state: "available",
      unavailableUntil: null,
      scope: "channel",
      source: "usage-source",
      code: null,
      observedAt: AT_UPDATED,
      incidentId: "incident-codex-0",
      revision: 1,
    },
  ],
  alerts: [],
  metrics: {
    strategicTurns: 1,
    workerEvents: 3,
    decisions: 0,
    tasks: 3,
    reworks: 0,
    firstReviewAccepted: 1,
    coverage: "complete",
  },
};

/** Copy the normal ledger with top-level overrides; nested arrays are replaced, not merged. */
export function withLedger(overrides: Partial<RunRecord> & Record<string, unknown>): RunRecord {
  return { ...NORMAL_RUN_LEDGER, ...overrides };
}

export const POLICY = policy();

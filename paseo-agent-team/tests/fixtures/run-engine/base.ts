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
  RunTaskEscalation,
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
export const NONCE_T1_REVIEW = "6f1c2a44-3b7e-4f0a-9a11-000000000004";
export const NONCE_PROBE = "6f1c2a44-3b7e-4f0a-9a11-000000000006";

export const MESSAGE_T1 = "11111111-1111-4111-8111-111111111111";
export const MESSAGE_T2 = "22222222-2222-4222-8222-222222222222";
export const MESSAGE_CANCEL = "33333333-3333-4333-8333-333333333333";
export const MESSAGE_PROBE = "44444444-4444-4444-8444-444444444444";
export const MESSAGE_REOPEN = "55555555-5555-4555-8555-555555555555";
export const MESSAGE_T1_REVIEW = "66666666-6666-4666-8666-666666666668";
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
  const merged = {
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
  } as Record<string, unknown>;
  return {
    ...merged,
    dispatchDuties: overrides.dispatchDuties ?? {
      produce: "implement",
      review: "review",
      smoke: merged.devSmoke ? "smoke" : null,
    },
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

export function escalation(
  overrides: Partial<RunTaskEscalation> & Record<string, unknown> = {},
): RunTaskEscalation {
  return {
    fromTier: "B",
    toTier: "A",
    atAttempt: 3,
    qualityFailures: 3,
    at: AT_UPDATED,
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
    taskId: "t2",
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
    delivery: null,
    acceptedProof: null,
    endedEventKey: null,
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
    idempotencyKey: "dispatch-t2-a1",
    payloadHash: DIGEST_A,
    templateVersion: 1,
    state: "confirmed",
    recoverySendCount: 0,
    createdAt: AT_CREATED,
    confirmedAt: AT_CREATED,
    localCancellation: null,
    taskId: "t2",
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
    localCancellation: null,
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
    idempotencyKey: "reopen-t2-1",
    payloadHash: DIGEST_C,
    templateVersion: 1,
    state: "prepared",
    recoverySendCount: 0,
    createdAt: AT_UPDATED,
    confirmedAt: null,
    localCancellation: null,
    taskId: "t2",
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
    taskId: "t2",
    originAssignmentId: ASSIGNMENT_T2,
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
    p1PlanHash: DIGEST_1,
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
  refresh: {
    agentId: "agent-b1",
    status: "idle",
    activeTurn: false,
    observedAt: AT_UPDATED,
  },
  observationSeq: 7,
  cancelIntentId: INTENT_CANCEL,
  receipt: { kind: "archive", confirmedAt: AT_UPDATED, externalId: "archive-1" },
};

export const PARTIAL_CANCELLATION: RunCancellationEvidence = {
  ...QUIESCENT_CANCELLATION,
  receipt: { kind: "none", confirmedAt: null, externalId: null },
};

const t1 = taskRecord(spec("t1", "Core API surface"), {
  state: "done",
  ref: { kind: "git-commit", value: "9f3c1a7" },
  changedFiles: ["src/t1.ts"],
  attempts: 1,
});

const t2 = taskRecord(spec("t2", "Core implementation"), {
  state: "in_progress",
  phase: "implementation",
  currentAssignmentId: ASSIGNMENT_T2,
  attempts: 1,
});

const t3 = taskRecord(spec("t3", "Operator docs", { group: "docs", deps: ["t2"] }), {
  state: "pending",
});

export { t1, t2, t3 };

export const NORMAL_RUN_LEDGER: RunRecord = {
  schemaVersion: 1,
  runId: RUN_ID,
  revision: 7,
  previousDigest: `sha256:${DIGEST_A}`,
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
    modelPlanHash: DIGEST_1,
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
  tasks: [t1, t2, t3],
  resources: [claim()],
  assignments: [
    assignment({
      assignmentId: "assignment-t1-a1",
      taskId: "t1",
      attempt: 1,
      nonce: NONCE_T1,
      messageId: MESSAGE_T1,
      state: "ended",
      turnId: "turn-6",
      startedAt: AT_CREATED,
      endedAt: AT_UPDATED,
      endedEventKey: "agent-b1|turn-6|turn_ended",
      acceptedProof: {
        protocolVersion: 1,
        runId: RUN_ID,
        taskId: "t1",
        attempt: 1,
        nonce: NONCE_T1,
        assignmentId: "assignment-t1-a1",
        messageId: MESSAGE_T1,
        status: "done",
        changedFiles: ["src/t1.ts"],
        ref: { kind: "git-commit", value: "9f3c1a7" },
        workspace: { id: "ws-run-rec0re-a1-t1", branch: "re-rec0rea1-t1-a1-1", baseRef: "main" },
        evidence: [
          {
            id: "five-gates",
            command: "npm run check && npm run typecheck && npm test",
            exitCode: 0,
            summary: "all gates passed",
            artifactPath: "evidence/t1.log",
            ref: { kind: "git-commit", value: "9f3c1a7" },
            isolation: {
              homePath: "C:/Users/cc/AppData/Local/Temp/run-home",
              outsideRealHome: true,
            },
          },
        ],
      },
    }),
    assignment({
      assignmentId: "assignment-t1-r1",
      taskId: "t1",
      seatId: "seat-b2",
      agentId: "agent-b2",
      tier: "A",
      reason: "L2/A: reviewer",
      purpose: "reviewer",
      attempt: 1,
      nonce: NONCE_T1_REVIEW,
      messageId: MESSAGE_T1_REVIEW,
      delivery: { producerAssignmentId: "assignment-t1-a1" },
      acceptedProof: {
        protocolVersion: 1,
        runId: RUN_ID,
        taskId: "t1",
        attempt: 1,
        nonce: NONCE_T1_REVIEW,
        assignmentId: "assignment-t1-r1",
        messageId: MESSAGE_T1_REVIEW,
        reviewedRef: { kind: "git-commit", value: "9f3c1a7" },
        verdict: "可合入",
        blockers: [],
        probes: [],
      },
      state: "ended",
      turnId: "turn-8",
      startedAt: AT_UPDATED,
      endedAt: AT_UPDATED,
      endedEventKey: "agent-b2|turn-8|turn_ended",
    }),
    assignment(),
  ],
  reopenGrants: [],
  outbox: [
    dispatchIntent({
      id: INTENT_T1,
      taskId: "t1",
      assignmentId: "assignment-t1-a1",
      messageId: MESSAGE_T1,
      idempotencyKey: "dispatch-t1-a1",
    }),
    dispatchIntent({
      id: "intent-t1-r1",
      taskId: "t1",
      assignmentId: "assignment-t1-r1",
      recipient: "agent-b2",
      messageId: MESSAGE_T1_REVIEW,
      idempotencyKey: "dispatch-t1-r1",
    }),
    dispatchIntent(),
  ],
  nonceRegistry: [
    {
      nonce: NONCE_T1,
      runId: RUN_ID,
      taskId: "t1",
      assignmentId: "assignment-t1-a1",
      attempt: 1,
      phase: "implementation",
      agentId: "agent-b1",
      seatId: "seat-b1",
      issuedAt: AT_CREATED,
      acceptedAt: AT_UPDATED,
      acceptedEventKey: "proof:assignment-t1-a1",
      revokedAt: null,
      revokeReason: null,
    },
    {
      nonce: NONCE_T1_REVIEW,
      runId: RUN_ID,
      taskId: "t1",
      assignmentId: "assignment-t1-r1",
      attempt: 1,
      phase: "review",
      agentId: "agent-b2",
      seatId: "seat-b2",
      issuedAt: AT_CREATED,
      acceptedAt: AT_UPDATED,
      acceptedEventKey: "proof:assignment-t1-r1",
      revokedAt: null,
      revokeReason: null,
    },
    {
      nonce: NONCE_T2,
      runId: RUN_ID,
      taskId: "t2",
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
      eventKey: "agent-b1|turn-6|turn_ended",
      kind: "turn_ended",
      agentId: "agent-b1",
      turnId: "turn-6",
      seq: 6,
      receivedAt: AT_UPDATED,
      dedupeKey: "agent-b1|turn-6|turn_ended",
      disposition: "accepted",
    },
    {
      eventKey: "agent-b2|turn-8|turn_ended",
      kind: "turn_ended",
      agentId: "agent-b2",
      turnId: "turn-8",
      seq: 8,
      receivedAt: AT_UPDATED,
      dedupeKey: "agent-b2|turn-8|turn_ended",
      disposition: "accepted",
    },
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
    { seq: 3, kind: "task_assigned", at: AT_CREATED, payload: { taskId: "t1" } },
    { seq: 4, kind: "task_transition", at: AT_CREATED, payload: { taskId: "t1", to: "done" } },
    { seq: 5, kind: "task_assigned", at: AT_UPDATED, payload: { taskId: "t2" } },
    { seq: 6, kind: "turn_started", at: AT_UPDATED, payload: { taskId: "t2", turnId: "turn-7" } },
    { seq: 7, kind: "turn_ended", at: AT_UPDATED, payload: { taskId: "t2", turnId: "turn-7" } },
  ],
  counters: { observationSeq: 8, eventsThroughSeq: 7, probeAttempts: 0, reopenAttempts: 0 },
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

/**
 * Adapt the pre-R01g sample shapes to the frozen contract. This is fixture-only data shaping:
 * task mirrors become the matching assignment's acceptedProof, and existing facts fill the new
 * fields. It never invents acceptance for an assignment without a stored report.
 */
function lowerBusinessIds(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\bT([0-9]+)\b/g, (_m, n) => `t${n}`);
  if (Array.isArray(value)) return value.map(lowerBusinessIds);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        lowerBusinessIds(entry),
      ]),
    );
  }
  return value;
}

function normalizeTaskReport(
  report: Record<string, unknown>,
  task: any,
  assignment: any,
  runId: string,
) {
  const status = String(report.status ?? "blocked");
  const base = {
    ...report,
    protocolVersion: 1,
    runId,
    taskId: task.spec.id,
    attempt: assignment.attempt,
    nonce: assignment.nonce,
    assignmentId: assignment.assignmentId,
    messageId: assignment.messageId,
    status,
  };
  if (status === "done") {
    const ref = report.ref ?? task.ref ?? { kind: "git-commit", value: "9f3c1a7" };
    const evidence = Array.isArray(report.evidence) ? report.evidence : [];
    return {
      ...base,
      status: "done",
      changedFiles: Array.isArray(report.changedFiles) ? report.changedFiles : [],
      ref,
      workspace: report.workspace ??
        assignment.workspace ?? {
          id: `ws-${task.spec.id}`,
          branch: `re-${task.spec.id}`,
          baseRef: "main",
        },
      evidence: (evidence.length > 0 ? evidence : [{}]).map((entry: any) => ({
        ...entry,
        id: entry.id ?? "fixture-evidence",
        command: entry.command ?? null,
        exitCode: entry.exitCode ?? 1,
        summary: entry.summary ?? "fixture evidence",
        artifactPath: entry.artifactPath ?? "evidence/fixture.log",
        ref: entry.ref ?? ref,
      })),
    };
  }
  return {
    ...base,
    status,
    reasonCode: report.reasonCode ?? status,
    summary: report.summary ?? "fixture report",
    evidence: Array.isArray(report.evidence) ? report.evidence : [],
  };
}

function normalizeReview(
  review: Record<string, unknown>,
  task: any,
  assignment: any,
  runId: string,
) {
  return {
    ...review,
    protocolVersion: 1,
    runId,
    taskId: task.spec.id,
    attempt: assignment.attempt,
    nonce: assignment.nonce,
    assignmentId: assignment.assignmentId,
    messageId: assignment.messageId,
    reviewedRef: review.reviewedRef ?? task.ref ?? { kind: "git-commit", value: "9f3c1a7" },
    verdict: review.verdict ?? "可合入",
    blockers: Array.isArray(review.blockers) ? review.blockers : [],
    probes: Array.isArray(review.probes) ? review.probes : [],
  };
}

function normalizeSmoke(
  report: Record<string, unknown>,
  task: any,
  assignment: any,
  runId: string,
) {
  return {
    ...report,
    protocolVersion: 1,
    runId,
    taskId: task.spec.id,
    attempt: assignment.attempt,
    nonce: assignment.nonce,
    assignmentId: assignment.assignmentId,
    messageId: assignment.messageId,
    testedRef: report.testedRef ?? task.ref ?? { kind: "git-commit", value: "9f3c1a7" },
    devHost: report.devHost ?? "127.0.0.1:6799",
    devServerId: report.devServerId ?? "dev-server-1",
    devHome: report.devHome ?? "/tmp/dev-home",
    checks: Array.isArray(report.checks) ? report.checks : [],
  };
}

function modernizeRecord(input: RunRecord): RunRecord {
  const record = lowerBusinessIds(structuredClone(input)) as any;
  const assignments: any[] = (record.assignments as any[]) ?? [];
  const receipts: any[] = (record.eventReceipts as any[]) ?? [];

  for (const task of record.tasks as any[]) {
    task.spec.dispatchDuties ??= {
      produce: "implement",
      review: "review",
      smoke: task.spec.devSmoke ? "smoke" : null,
    };
    const report = task.report;
    const reviews = Array.isArray(task.reviews) ? task.reviews : [];
    const smoke = task.smokeReport;
    delete task.report;
    delete task.reviews;
    delete task.smokeReport;

    const producers = assignments.filter(
      (entry) =>
        entry.taskId === task.spec.id &&
        ["member", "coordinator", "reopen"].includes(entry.purpose),
    );
    const reviewers = assignments.filter(
      (entry) => entry.taskId === task.spec.id && entry.purpose === "reviewer",
    );
    const smokers = assignments.filter(
      (entry) => entry.taskId === task.spec.id && entry.purpose === "smoker",
    );
    const producerId = producers[0]?.assignmentId ?? `assignment-${task.spec.id}-a1`;
    if (report !== undefined && producers[0]) {
      producers[0].acceptedProof = normalizeTaskReport(report, task, producers[0], record.runId);
    }
    for (const [index, review] of reviews.entries()) {
      const reviewer =
        reviewers.find((entry) => entry.agentId === review.reviewerAgentId) ?? reviewers[index];
      if (reviewer) {
        reviewer.acceptedProof = normalizeReview(review, task, reviewer, record.runId);
      }
    }
    if (smoke !== undefined) {
      let smoker = smokers[0];
      if (!smoker) {
        const suffix = String(assignments.length + 1).padStart(12, "0");
        smoker = {
          assignmentId: `assignment-${task.spec.id}-smoke`,
          taskId: task.spec.id,
          seatId: "seat-s1",
          agentId: "agent-s1",
          profileId: PROFILE_HAIKU.id,
          profileName: PROFILE_HAIKU.name,
          provider: PROFILE_HAIKU.provider,
          model: PROFILE_HAIKU.model,
          family: PROFILE_HAIKU.family,
          channelId: PROFILE_HAIKU.channelId,
          tier: "A",
          reason: "fixture smoke assignment",
          purpose: "smoker",
          workspace: {
            id: `ws-${task.spec.id}-smoke`,
            branch: `re-${task.spec.id}-smoke`,
            baseRef: "main",
          },
          attempt: Math.max(1, task.attempts),
          nonce: `90000000-0000-4000-8000-${suffix}`,
          messageId: `91000000-0000-4000-8000-${suffix}`,
          delivery: { producerAssignmentId: producerId },
          acceptedProof: null,
          endedEventKey: null,
          turnId: null,
          state: "ended",
          createdAt: AT_CREATED,
          startedAt: AT_CREATED,
          endedAt: AT_UPDATED,
        };
        assignments.push(smoker);
        record.nonceRegistry ??= [];
        record.nonceRegistry.push({
          nonce: smoker.nonce,
          runId: record.runId,
          taskId: task.spec.id,
          assignmentId: smoker.assignmentId,
          attempt: smoker.attempt,
          phase: "smoke",
          agentId: smoker.agentId,
          seatId: smoker.seatId,
          issuedAt: AT_CREATED,
          acceptedAt: AT_UPDATED,
          acceptedEventKey: `proof:${smoker.assignmentId}`,
          revokedAt: null,
          revokeReason: null,
        });
        record.outbox ??= [];
        record.outbox.push({
          id: `intent-${smoker.assignmentId}`,
          kind: "dispatch",
          recipient: smoker.agentId,
          messageId: smoker.messageId,
          idempotencyKey: `dispatch-${smoker.assignmentId}`,
          payloadHash: DIGEST_A,
          templateVersion: 1,
          state: "confirmed",
          recoverySendCount: 0,
          createdAt: AT_CREATED,
          confirmedAt: AT_CREATED,
          localCancellation: null,
          taskId: task.spec.id,
          assignmentId: smoker.assignmentId,
          semanticArgs: { promptBytes: 1 },
        });
      }
      smoker.acceptedProof = normalizeSmoke(smoke, task, smoker, record.runId);
    }
  }

  for (const assignment of assignments) {
    const r = assignment.purpose === "reviewer" || assignment.purpose === "smoker";
    assignment.delivery ??= r
      ? {
          producerAssignmentId:
            assignments.find(
              (entry) =>
                entry.taskId === assignment.taskId &&
                ["member", "coordinator", "reopen"].includes(entry.purpose),
            )?.assignmentId ?? `assignment-${assignment.taskId}-a1`,
        }
      : null;
    if (!r) assignment.delivery = null;
    if (assignment.acceptedProof === undefined) assignment.acceptedProof = null;
    if (assignment.state === "ended" || assignment.state === "cancelled") {
      const receipt = receipts.find(
        (entry) =>
          entry.kind === "turn_ended" &&
          entry.agentId === assignment.agentId &&
          entry.turnId === assignment.turnId,
      );
      assignment.endedEventKey = receipt?.eventKey ?? null;
    } else {
      assignment.endedEventKey = null;
    }
    const nonce = (record.nonceRegistry as any[]).find(
      (entry) => entry.assignmentId === assignment.assignmentId,
    );
    if (nonce) {
      if (assignment.acceptedProof !== null) {
        nonce.acceptedAt = assignment.endedAt ?? AT_UPDATED;
        nonce.acceptedEventKey = `proof:${assignment.assignmentId}`;
      } else {
        nonce.acceptedAt = null;
        nonce.acceptedEventKey = null;
      }
    }
  }

  for (const claim of (record.resources as any[]) ?? []) {
    claim.originAssignmentId ??=
      assignments.find(
        (entry) =>
          entry.taskId === claim.taskId &&
          ["member", "coordinator", "reopen"].includes(entry.purpose),
      )?.assignmentId ?? `assignment-${claim.taskId}-a1`;
  }
  for (const intent of (record.outbox as any[]) ?? []) {
    intent.localCancellation ??= null;
  }
  for (const assignment of assignments) {
    if (
      assignment.acceptedProof !== null &&
      !(record.outbox as any[]).some(
        (entry) => entry.kind === "dispatch" && entry.assignmentId === assignment.assignmentId,
      )
    ) {
      (record.outbox as any[]).push({
        id: `intent-${assignment.assignmentId}`,
        kind: "dispatch",
        recipient: assignment.agentId,
        messageId: assignment.messageId,
        idempotencyKey: `dispatch-${assignment.assignmentId}`,
        payloadHash: DIGEST_A,
        templateVersion: 1,
        state: "confirmed",
        recoverySendCount: 0,
        createdAt: assignment.createdAt ?? AT_CREATED,
        confirmedAt: assignment.endedAt ?? AT_UPDATED,
        localCancellation: null,
        taskId: assignment.taskId,
        assignmentId: assignment.assignmentId,
        semanticArgs: { promptBytes: 1 },
      });
    }
  }
  for (const decision of (record.decisions as any[]) ?? []) {
    const cancelIntentId = decision.cancelIntentId;
    delete decision.cancelIntentId;
    const exactCancel =
      decision.category === "D1" &&
      decision.subjectId !== null &&
      decision.dedupeKey === `cancel:${decision.subjectId}`;
    if (!exactCancel) {
      decision.cancelIntents = null;
      decision.resolution = null;
      continue;
    }
    const existing = Array.isArray(decision.cancelIntents) ? decision.cancelIntents : [];
    if (existing.length === 0) {
      const binding = (record.outbox as any[]).find(
        (entry) =>
          entry.kind === "archive" &&
          entry.taskId === decision.subjectId &&
          (entry.id === cancelIntentId || entry.assignmentId !== null),
      );
      if (binding) {
        existing.push({ assignmentId: binding.assignmentId, intentId: binding.id });
      }
    }
    decision.cancelIntents = existing.sort((a: any, b: any) =>
      a.assignmentId < b.assignmentId ? -1 : a.assignmentId > b.assignmentId ? 1 : 0,
    );
    decision.resolution = decision.resolution ?? null;
  }
  return record as RunRecord;
}

/** Copy the normal ledger with top-level overrides; nested arrays are replaced, not merged. */
export function withLedger(overrides: Partial<RunRecord> & Record<string, unknown>): RunRecord {
  const next = { ...NORMAL_RUN_LEDGER, ...overrides };
  // A rebased sample belongs to its own Run: inherited nonce registrations must not keep the
  // NORMAL runId (strict I5 run binding). Explicit nonceRegistry overrides stay intentional.
  if (typeof overrides.runId === "string" && overrides.nonceRegistry === undefined) {
    next.nonceRegistry = next.nonceRegistry.map((entry) => ({
      ...entry,
      runId: overrides.runId as string,
    }));
  }
  return modernizeRecord(next);
}

export const POLICY = policy();

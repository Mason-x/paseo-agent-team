import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { hashLaunchPlan } from "../server/launch-hash";
import { type AtomicJsonCodec, createAtomicJson } from "../server/ledger/atomic-json";
import { buildLaunchPlan } from "../shared/domain/launch-plan";
import type { EconomyPolicy } from "../shared/domain/mode-resolver";
import type { PaseoProfile, ProviderAvailability } from "../shared/paseo/adapter";
import { RunTeamEngineConfigSchema } from "../shared/schemas/run-engine/config";
import {
  RUN_HARD_BYTES,
  RUN_MAX_TASKS,
  RUN_SCHEMA_VERSION,
  RUN_SOFT_BYTES,
  RUN_TASK_PHASES,
  RunDecisionPointSchema,
  RunEffectIntentSchema,
  RunEventReceiptSchema,
  RunHistoryCheckpointSchema,
  RunNonceEntrySchema,
  RunPolicySnapshotSchema,
  type RunRecord,
  RunRecordSchema,
  RunReopenGrantSchema,
  RunResourceClaimSchema,
  RunTaskPhaseSchema,
  RunTaskRecordSchema,
} from "../shared/schemas/run-engine/ledger";
import {
  RunDecisionBlockSchema,
  RunReviewReportBlockSchema,
  RunSmokeReportBlockSchema,
  RunTaskDagBlockSchema,
  RunTaskReportBlockSchema,
} from "../shared/schemas/run-engine/protocol";
import {
  RUN_HISTORY_CURSOR_EXPIRED,
  RunControlInputSchema,
  type RunDetailView,
  RunDetailViewSchema,
  RunGetInputSchema,
  RunGetOutputSchema,
  RunIssueViewSchema,
  RunReconcileOutputSchema,
  runHistoryCursorExpiredIssue,
} from "../shared/schemas/run-engine/rpc";
import { architect, claudeOpus, codexXhigh, codingTeam, developer, techLead } from "./fixtures";

const NOW = "2026-10-27T12:00:00.000Z";
const RUN_ID = "run-abc123-xyz789";
const DIGEST = "a".repeat(64);
const NONCE = "11111111-1111-4111-8111-111111111111";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const DECISION_ID = "44444444-4444-4444-8444-444444444444";
const ASSIGNMENT_ID = "assignment-1";

function artifactRef() {
  return { kind: "git-commit" as const, value: "abc1234" };
}

function taskSpec(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    title: "Ship the change",
    goal: "Implement the requested change.",
    group: "core",
    deps: [],
    level: "L1",
    tier: "B",
    execution: "write",
    scopes: [{ repoId: "repo-a", kind: "file", path: "src/a.ts", access: "write" }],
    acceptance: ["AC1"],
    evidence: [
      { id: "tests", command: "npm test", artifactKind: "log", requiresIsolatedHome: true },
    ],
    devSmoke: false,
    smokeChecklist: [],
    irreversible: null,
    reviewPolicy: "required",
    implementationPolicy: "default",
    architectureTaskId: null,
    ...overrides,
  };
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    id: "tests",
    command: "npm test",
    exitCode: 0,
    summary: "1146 tests passed",
    artifactPath: "evidence/tests.log",
    ref: artifactRef(),
    ...overrides,
  };
}

function taskRecord(overrides: Record<string, unknown> = {}) {
  return {
    spec: taskSpec(),
    state: "ready",
    phase: undefined,
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

function assignment(overrides: Record<string, unknown> = {}) {
  return {
    assignmentId: ASSIGNMENT_ID,
    taskId: "t1",
    seatId: "seat-b1",
    agentId: "agent-1",
    profileId: "profile-1",
    profileName: "DeepSeek",
    provider: "omp",
    model: "deepseek-v4",
    family: "deepseek",
    channelId: "channel-a",
    tier: "B",
    reason: "first B seat by load",
    purpose: "member",
    workspace: { id: "ws-1", branch: "re-abc-t1-a1", baseRef: "main" },
    attempt: 1,
    nonce: NONCE,
    messageId: MESSAGE_ID,
    turnId: null,
    state: "assigned",
    createdAt: NOW,
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

function modelPlan(overrides: Record<string, unknown> = {}) {
  return {
    p1PlanHash: DIGEST,
    mode: "economy-all",
    targetWorkspaceId: null,
    task: "run the sealed DAG",
    maxMembers: 8,
    runtimeCapabilities: { onDemand: false, expansion: false, collaboration: false },
    team: {
      id: "team-1",
      name: "Engine Team",
      rawMode: "economy-all",
      modeContract: 3,
      plannerVersion: 2,
      coordinatorRoleId: "lead",
      members: [{ seatId: "seat-b1", roleId: "dev", enabled: true }],
      memberCreation: "eager",
      collaboration: null,
    },
    roles: [
      {
        roleId: "dev",
        roleName: "Developer",
        enabled: true,
        executionPolicy: { tier: "execution", taskKind: "coding" },
        preferredProfiles: [{ profileId: "profile-1", hint: { name: "DeepSeek" } }],
        fallbackProfiles: [],
      },
    ],
    economy: {
      pool: [{ profileId: "profile-1", family: "deepseek", enabled: true }],
      allSeats: { version: 1, profiles: [], routes: {}, executionTaskOrder: {} },
    },
    profileTuples: [
      {
        profileId: "profile-1",
        provider: "omp",
        model: "deepseek-v4",
        modeId: "default",
        thinkingOptionId: "high",
        featureValues: { fast: false },
      },
    ],
    rosterFingerprint: DIGEST,
    ...overrides,
  };
}

function policy(overrides: Record<string, unknown> = {}) {
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
    seatBudgets: [],
    groupBudgets: [],
    controlAttempts: { probe: 2, reopen: 2 },
    disabledProfileIds: [],
    disabledChannels: [],
    capabilityRulesVersion: "p1-v1",
    devTargets: [{ serverId: "srv-dev", host: "127.0.0.1:7777", home: "/tmp/dev-home" }],
    evidenceRoot: "evidence",
    requestLimits: { burst: 8, perMinute: 12 },
    archiveResume: { seatRevival: "explicit-resume-seat", keepsArchivedAssignments: true },
    capacity: { softBytes: RUN_SOFT_BYTES },
    ...overrides,
  };
}

function runRecord(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId: RUN_ID,
    revision: 3,
    previousDigest: `sha256:${DIGEST}`,
    createdAt: NOW,
    updatedAt: NOW,
    hostBinding: { serverId: "srv-1" },
    launch: {
      requestId: "req-1",
      requestHash: DIGEST,
      planHash: DIGEST,
      state: "running",
      modelPlan: modelPlan(),
    },
    team: {
      id: "team-1",
      name: "Engine Team",
      rawMode: "economy-all",
      modeContract: 3,
      plannerVersion: 2,
      modelPlanHash: DIGEST,
    },
    lifecycle: "active",
    policy: policy(),
    roster: [
      {
        seatId: "seat-b1",
        tier: "B",
        agentId: "agent-1",
        channelId: "channel-a",
        duties: ["dev"],
        enabled: true,
      },
    ],
    dagRevision: 1,
    tasks: [taskRecord()],
    resources: [
      {
        claimId: "claim-1",
        taskId: "t1",
        repoId: "repo-a",
        kind: "file",
        path: "src/a.ts",
        access: "write",
        frozen: false,
        createdAt: NOW,
      },
    ],
    assignments: [assignment()],
    reopenGrants: [],
    outbox: [],
    nonceRegistry: [],
    eventReceipts: [],
    events: [],
    counters: { observationSeq: 4, eventsThroughSeq: 0, probeAttempts: 0, reopenAttempts: 0 },
    budgets: { entries: [] },
    decisions: [],
    approvals: [],
    channels: [],
    alerts: [],
    metrics: {
      strategicTurns: 0,
      workerEvents: 0,
      decisions: 0,
      tasks: 1,
      reworks: 0,
      firstReviewAccepted: 0,
      coverage: "complete",
    },
    ...overrides,
  };
}

describe("ledger records are tolerant, versioned, and bounded", () => {
  test("a complete RunRecord parses and keeps unknown fields at every level", () => {
    const raw = runRecord({
      futureTop: { keep: true },
      launch: {
        ...runRecord().launch,
        modelPlan: modelPlan({ futurePlanField: 1 }),
        futureLaunchField: "kept",
      },
      tasks: [taskRecord({ futureTaskField: { keep: 1 }, spec: taskSpec({ futureSpec: true }) })],
      assignments: [assignment({ futureAssignment: "kept" })],
      counters: { ...runRecord().counters, futureCounter: 5 },
    });
    const parsed = RunRecordSchema.parse(raw);
    expect(parsed.futureTop).toEqual({ keep: true });
    expect(parsed.launch.modelPlan.futurePlanField).toBe(1);
    expect(parsed.tasks[0]).toMatchObject({ futureTaskField: { keep: 1 } });
    expect(parsed.assignments[0]).toMatchObject({ futureAssignment: "kept" });
    expect(parsed.counters.futureCounter).toBe(5);
    // Round-trip keeps them, which is the property the store relies on.
    expect(RunRecordSchema.parse(parsed)).toEqual(parsed);
  });

  test("schemaVersion, ids, digests, revisions, and the two header shapes are exact", () => {
    expect(RunRecordSchema.safeParse(runRecord({ schemaVersion: 2 })).success).toBe(false);
    expect(RunRecordSchema.safeParse(runRecord({ runId: "run-abc" })).success).toBe(false);
    expect(RunRecordSchema.safeParse(runRecord({ runId: "run-AbC-xyz" })).success).toBe(false);
    expect(RunRecordSchema.safeParse(runRecord({ revision: -1 })).success).toBe(false);
    expect(RunRecordSchema.safeParse(runRecord({ lifecycle: "paused" })).success).toBe(true);
    // A state this version does not know is a damaged v1 record, not passthrough data.
    expect(
      RunRecordSchema.safeParse(runRecord({ tasks: [taskRecord({ state: "holding" })] })).success,
    ).toBe(false);

    // F11: revision 1 is "", later revisions are sha256:<64>, and bare 64hex is not a header.
    expect(RunRecordSchema.safeParse(runRecord({ revision: 1, previousDigest: "" })).success).toBe(
      true,
    );
    expect(
      RunRecordSchema.safeParse(runRecord({ revision: 1, previousDigest: `sha256:${DIGEST}` }))
        .success,
    ).toBe(false);
    expect(RunRecordSchema.safeParse(runRecord({ revision: 2, previousDigest: "" })).success).toBe(
      false,
    );
    expect(
      RunRecordSchema.safeParse(runRecord({ revision: 2, previousDigest: DIGEST })).success,
    ).toBe(false);
    expect(RunRecordSchema.safeParse(runRecord({ previousDigest: "abc" })).success).toBe(false);

    // 143 I1: revision 0 is not a persisted header (validateHeader needs revision >= 1), whatever
    // the digest says. Only the record root is tightened.
    for (const previousDigest of ["", `sha256:${DIGEST}`]) {
      const zero = RunRecordSchema.safeParse(runRecord({ revision: 0, previousDigest }));
      expect(zero.success, `revision 0 / "${previousDigest}"`).toBe(false);
      if (!zero.success) {
        expect(zero.error.issues.map((issue) => issue.path.join("."))).toContain("revision");
      }
    }

    // F15: the two copies of the P1 plan digest must agree.
    const split = runRecord({
      team: { ...runRecord().team, modelPlanHash: "b".repeat(64) },
    });
    expect(RunRecordSchema.safeParse(split).success).toBe(false);
  });

  test("the hard capacity is enforced by the schema", () => {
    const tasks = Array.from({ length: RUN_MAX_TASKS + 1 }, (_value, index) =>
      taskRecord({ spec: taskSpec({ id: `t${index + 1}` }) }),
    );
    expect(RunRecordSchema.safeParse(runRecord({ tasks })).success).toBe(false);
    expect(
      RunRecordSchema.safeParse(
        runRecord({
          tasks: tasks.slice(0, RUN_MAX_TASKS),
        }),
      ).success,
    ).toBe(true);
    expect(RUN_HARD_BYTES).toBe(8 * 1024 * 1024);
    expect(RUN_SOFT_BYTES).toBeLessThan(RUN_HARD_BYTES);
  });

  test("counters and the compressed checkpoint carry the same counters", () => {
    const checkpoint = {
      throughSeq: 10,
      historyDigest: DIGEST,
      counters: { observationSeq: 10, eventsThroughSeq: 10, probeAttempts: 1, reopenAttempts: 2 },
      acceptedNonceDigests: [DIGEST],
      terminalAssignmentIds: [ASSIGNMENT_ID],
    };
    expect(RunHistoryCheckpointSchema.parse(checkpoint)).toMatchObject({
      counters: { probeAttempts: 1, reopenAttempts: 2 },
    });
    expect(RunRecordSchema.parse(runRecord({ checkpoint })).checkpoint).toEqual(checkpoint);
    expect(
      RunHistoryCheckpointSchema.safeParse({
        ...checkpoint,
        acceptedNonceDigests: ["not-a-digest"],
      }).success,
    ).toBe(false);
  });

  test("the frozen model-plan basis includes Team, Role, economy, and full profile tuples", () => {
    // Negotiated value is an integer, not the literal 2 (AC-RE1.13).
    const parsedBasis = RunRecordSchema.parse(runRecord()).launch.modelPlan;
    expect(parsedBasis.team.modeContract).toBe(3);
    expect(parsedBasis.team.members[0]).toMatchObject({ roleId: "dev", enabled: true });
    expect(parsedBasis.roles[0]).toMatchObject({
      roleId: "dev",
      executionPolicy: { tier: "execution", taskKind: "coding" },
    });
    expect(parsedBasis.profileTuples[0]).toMatchObject({
      modeId: "default",
      thinkingOptionId: "high",
      featureValues: { fast: false },
    });
    expect(parsedBasis.economy).toMatchObject({ allSeats: { version: 1 } });

    const missingRoles = { ...modelPlan(), roles: undefined };
    expect(
      RunRecordSchema.safeParse(
        runRecord({ launch: { ...runRecord().launch, modelPlan: missingRoles } }),
      ).success,
    ).toBe(false);
  });

  test("outbox intents: control fields only on control intents", () => {
    const dispatch = {
      id: "intent-1",
      kind: "dispatch",
      recipient: "agent-1",
      messageId: MESSAGE_ID,
      idempotencyKey: "dispatch-t1-a1",
      payloadHash: DIGEST,
      templateVersion: 1,
      state: "prepared",
      recoverySendCount: 0,
      createdAt: NOW,
      confirmedAt: null,
      taskId: "t1",
      assignmentId: ASSIGNMENT_ID,
      semanticArgs: { promptBytes: 100 },
    };
    expect(RunEffectIntentSchema.parse(dispatch)).toMatchObject({ kind: "dispatch" });

    const probe = {
      id: dispatch.id,
      kind: "probe",
      recipient: dispatch.recipient,
      messageId: dispatch.messageId,
      idempotencyKey: dispatch.idempotencyKey,
      payloadHash: dispatch.payloadHash,
      templateVersion: dispatch.templateVersion,
      state: dispatch.state,
      recoverySendCount: dispatch.recoverySendCount,
      createdAt: dispatch.createdAt,
      confirmedAt: dispatch.confirmedAt,
      controlAttempt: 1,
      semanticArgs: { channelId: "channel-a", controlNonce: NONCE, noBusinessWrites: true },
    };
    expect(RunEffectIntentSchema.safeParse(probe).success).toBe(true);
    expect(RunEffectIntentSchema.safeParse({ ...probe, controlAttempt: undefined }).success).toBe(
      false,
    );
    expect(RunEffectIntentSchema.safeParse({ ...probe, taskId: "t1" }).success).toBe(false);
    expect(
      RunEffectIntentSchema.safeParse({
        ...probe,
        kind: "reopen",
        taskId: "t1",
        assignmentId: null,
      }).success,
    ).toBe(true);
    expect(
      RunEffectIntentSchema.safeParse({
        ...probe,
        semanticArgs: { channelId: "channel-a", controlNonce: NONCE },
      }).success,
    ).toBe(false);
    // A business intent is not forced to invent a control counter, nor allowed to fake one.
    expect(RunEffectIntentSchema.safeParse(dispatch).success).toBe(true);
    expect(RunEffectIntentSchema.safeParse({ ...dispatch, controlAttempt: 1 }).success).toBe(false);
    expect(RunEffectIntentSchema.safeParse({ ...dispatch, recoverySendCount: 2 }).success).toBe(
      false,
    );
  });

  test("nonce, receipt, and reopen-grant records are bounded and stateful", () => {
    const nonceEntry = {
      nonce: NONCE,
      runId: RUN_ID,
      taskId: "t1",
      assignmentId: ASSIGNMENT_ID,
      attempt: 1,
      phase: "implementation",
      agentId: "agent-1",
      seatId: "seat-b1",
      issuedAt: NOW,
      acceptedAt: null,
      acceptedEventKey: null,
      revokedAt: null,
      revokeReason: null,
    };
    expect(RunNonceEntrySchema.parse(nonceEntry)).toMatchObject({ nonce: NONCE });
    expect(RunNonceEntrySchema.safeParse({ ...nonceEntry, nonce: "not-a-uuid" }).success).toBe(
      false,
    );
    expect(RunNonceEntrySchema.safeParse({ ...nonceEntry, phase: "holding" }).success).toBe(false);

    const receipt = {
      eventKey: "agent-1:turn-1:turn_started",
      kind: "turn_started",
      agentId: "agent-1",
      turnId: "turn-1",
      seq: 1,
      receivedAt: NOW,
      dedupeKey: "agent-1:turn-1",
      disposition: "accepted",
    };
    expect(RunEventReceiptSchema.parse(receipt)).toMatchObject({ disposition: "accepted" });
    expect(RunEventReceiptSchema.safeParse({ ...receipt, disposition: "maybe" }).success).toBe(
      false,
    );

    const grant = {
      grantId: "grant-1",
      seatId: "seat-b1",
      agentId: "agent-1",
      intentId: "intent-reopen-1",
      messageId: MESSAGE_ID,
      status: "issued",
      createdAt: NOW,
      expiresAt: NOW,
      consumedAt: null,
    };
    expect(RunReopenGrantSchema.parse(grant)).toMatchObject({ status: "issued" });
    // A grant without an expiry or dispatch intent is not a grant.
    expect(RunReopenGrantSchema.safeParse({ ...grant, expiresAt: undefined }).success).toBe(false);
    expect(RunReopenGrantSchema.safeParse({ ...grant, intentId: undefined }).success).toBe(false);
    expect(RunReopenGrantSchema.safeParse({ ...grant, status: "used" }).success).toBe(false);
    // status and consumedAt must agree.
    expect(RunReopenGrantSchema.safeParse({ ...grant, consumedAt: NOW }).success).toBe(false);
    expect(
      RunReopenGrantSchema.safeParse({ ...grant, status: "consumed", consumedAt: null }).success,
    ).toBe(false);
    expect(
      RunReopenGrantSchema.safeParse({ ...grant, status: "consumed", consumedAt: NOW }).success,
    ).toBe(true);
  });

  test("RunRecord embeds the typed policy snapshot and rejects unknown policy versions", () => {
    expect(RunRecordSchema.parse(runRecord()).policy.policyVersion).toBe(1);
    // Empty block, missing version, and a future version are all refused: an unknown policy is
    // never interpreted as "looser defaults" (AC-RE5.2).
    expect(RunRecordSchema.safeParse(runRecord({ policy: {} })).success).toBe(false);
    expect(
      RunRecordSchema.safeParse(runRecord({ policy: { ...policy(), policyVersion: undefined } }))
        .success,
    ).toBe(false);
    expect(
      RunRecordSchema.safeParse(runRecord({ policy: { ...policy(), policyVersion: 2 } })).success,
    ).toBe(false);
  });

  test("a roster seat may be configured without an agent", () => {
    const unbound = runRecord({
      roster: [
        {
          seatId: "seat-a1",
          tier: "A",
          agentId: null,
          channelId: "channel-a",
          duties: ["review"],
          enabled: true,
        },
      ],
    });
    expect(RunRecordSchema.parse(unbound).roster[0]).toMatchObject({ agentId: null });
    expect(
      RunRecordSchema.safeParse({
        ...unbound,
        roster: [{ ...unbound.roster[0], agentId: undefined }],
      }).success,
    ).toBe(false);
  });

  test("stored policy carries archive-resume, control attempts, and only a soft capacity", () => {
    expect(RunPolicySnapshotSchema.parse(policy())).toMatchObject({
      archiveResume: { seatRevival: "explicit-resume-seat" },
      controlAttempts: { probe: 2, reopen: 2 },
    });
    expect(
      RunPolicySnapshotSchema.safeParse({ ...policy(), archiveResume: undefined }).success,
    ).toBe(false);
    expect(
      RunPolicySnapshotSchema.safeParse({
        ...policy(),
        capacity: { softBytes: RUN_HARD_BYTES + 1 },
      }).success,
    ).toBe(false);
  });
});

describe("protocol blocks are strict and identity-bound", () => {
  const controlIdentity = {
    protocolVersion: 1 as const,
    runId: RUN_ID,
    taskId: "_dag",
    attempt: 1 as const,
    nonce: NONCE,
  };
  const reportIdentity = {
    protocolVersion: 1 as const,
    runId: RUN_ID,
    taskId: "t1",
    attempt: 1 as const,
    nonce: NONCE,
    assignmentId: ASSIGNMENT_ID,
  };

  test("task-dag uses the reserved control id and rejects business ids or attempt ≠ 1", () => {
    const dag = {
      ...controlIdentity,
      dagRevision: 2,
      expectedDagRevision: 1,
      tasks: [taskSpec()],
      cancelTaskIds: [],
      budgetRequests: [
        { scope: "seat", subjectId: "seat-s1", requestedLimit: 2, reason: "S review" },
      ],
    };
    expect(RunTaskDagBlockSchema.parse(dag)).toMatchObject({ dagRevision: 2 });
    expect(RunTaskDagBlockSchema.safeParse({ ...dag, taskId: "t1" }).success).toBe(false);
    expect(RunTaskDagBlockSchema.safeParse({ ...dag, attempt: 2 }).success).toBe(false);
    expect(RunTaskDagBlockSchema.safeParse({ ...dag, expectedDagRevision: -1 }).success).toBe(
      false,
    );
    expect(RunTaskDagBlockSchema.safeParse({ ...dag, futureField: true }).success).toBe(false);
    expect(
      RunTaskDagBlockSchema.safeParse({ ...dag, tasks: Array(65).fill(taskSpec()) }).success,
    ).toBe(false);
  });

  test("task-dag rejects unknown nested fields and unknown protocol versions", () => {
    const dag = {
      ...controlIdentity,
      dagRevision: 2,
      expectedDagRevision: 1,
      tasks: [
        taskSpec({ scopes: [{ repoId: "r", kind: "file", path: "a", access: "write", extra: 1 }] }),
      ],
      cancelTaskIds: [],
      budgetRequests: [],
    };
    expect(RunTaskDagBlockSchema.safeParse(dag).success).toBe(false);
    expect(
      RunTaskDagBlockSchema.safeParse({
        ...dag,
        tasks: [taskSpec()],
        protocolVersion: 2,
      }).success,
    ).toBe(false);
  });

  test("task-report allows an empty changedFiles for read tasks and an engine-filled messageId", () => {
    const done = {
      ...reportIdentity,
      status: "done",
      changedFiles: [],
      ref: artifactRef(),
      workspace: { id: "ws-1", branch: "b", baseRef: "main" },
      evidence: [evidence()],
    };
    expect(RunTaskReportBlockSchema.parse(done)).toMatchObject({ status: "done" });
    expect(RunTaskReportBlockSchema.safeParse({ ...done, messageId: MESSAGE_ID }).success).toBe(
      true,
    );
    expect(RunTaskReportBlockSchema.safeParse({ ...done, assignmentId: undefined }).success).toBe(
      false,
    );
    expect(RunTaskReportBlockSchema.safeParse({ ...done, messageId: "not-a-uuid" }).success).toBe(
      false,
    );
    const blocked = {
      ...reportIdentity,
      status: "blocked",
      reasonCode: "NEED_ACCESS",
      summary: "cannot reach host",
      evidence: [],
    };
    expect(RunTaskReportBlockSchema.parse(blocked)).toMatchObject({ status: "blocked" });
    expect(RunTaskReportBlockSchema.safeParse({ ...blocked, status: "done" }).success).toBe(false);
    expect(RunTaskReportBlockSchema.safeParse({ ...done, extraField: 1 }).success).toBe(false);
    expect(
      RunTaskReportBlockSchema.safeParse({
        ...done,
        ref: { kind: "diff-sha256", value: DIGEST, baseCommit: "c1", patchPath: "p.diff" },
      }).success,
    ).toBe(true);
    expect(RunTaskReportBlockSchema.safeParse({ ...done, attempt: 0 }).success).toBe(false);
  });

  test("review and smoke reports use their fixed vocabularies", () => {
    const review = {
      ...reportIdentity,
      reviewedRef: artifactRef(),
      verdict: "可合入",
      blockers: [],
      probes: [evidence({ id: "probe" })],
    };
    expect(RunReviewReportBlockSchema.parse(review).verdict).toBe("可合入");
    expect(
      RunReviewReportBlockSchema.safeParse({
        ...review,
        verdict: "修改后合入",
        blockers: [{ id: "b1", summary: "fix", path: null }],
      }).success,
    ).toBe(true);
    expect(RunReviewReportBlockSchema.safeParse({ ...review, verdict: "approved" }).success).toBe(
      false,
    );
    expect(
      RunReviewReportBlockSchema.safeParse({
        ...review,
        blockers: Array(41).fill({ id: "b", summary: "s", path: null }),
      }).success,
    ).toBe(false);

    const smoke = {
      ...reportIdentity,
      testedRef: artifactRef(),
      devHost: "127.0.0.1:7777",
      devServerId: "srv-dev",
      devHome: "/tmp/dev-home",
      checks: [{ id: "ui", result: "pass", evidencePath: "evidence/ui.png" }],
    };
    expect(RunSmokeReportBlockSchema.parse(smoke).checks[0]?.result).toBe("pass");
    expect(
      RunSmokeReportBlockSchema.safeParse({
        ...smoke,
        checks: [{ id: "ui", result: "skip", evidencePath: "x" }],
      }).success,
    ).toBe(false);
    expect(RunSmokeReportBlockSchema.safeParse({ ...smoke, checks: [] }).success).toBe(false);
  });

  test("decision actions are a strict whitelist with no way to set done", () => {
    const base = { ...controlIdentity, taskId: "_decision:abc-1", decisionId: DECISION_ID };
    const actions = [
      { action: "replan", nextDagRevision: 3 },
      { action: "assign-seat", taskId: "t1", seatId: "seat-a1" },
      { action: "increase-budget", scope: "seat", subjectId: "seat-s1", delta: 1, reason: "more" },
      { action: "retry", taskId: "t1", reason: "retry" },
      { action: "cancel", taskIds: ["t1"], reason: "stop" },
      { action: "defer-channel", channelId: "channel-a", until: NOW, reason: "quota" },
      { action: "resume-seat", seatId: "seat-b1", reason: "back" },
      { action: "reject", reason: "no" },
    ];
    for (const action of actions) {
      expect(RunDecisionBlockSchema.safeParse({ ...base, action }).success).toBe(true);
    }
    expect(
      RunDecisionBlockSchema.safeParse({ ...base, action: { action: "set-done", taskId: "t1" } })
        .success,
    ).toBe(false);
    expect(
      RunDecisionBlockSchema.safeParse({ ...base, action: { action: "force-done" } }).success,
    ).toBe(false);
    // The block cannot also carry a DAG.
    expect(
      RunDecisionBlockSchema.safeParse({
        ...base,
        action: { action: "reject", reason: "no" },
        tasks: [taskSpec()],
      }).success,
    ).toBe(false);
    expect(
      RunDecisionBlockSchema.safeParse({
        ...base,
        action: { action: "replan", nextDagRevision: 0 },
      }).success,
    ).toBe(false);
  });
});

describe("R01c decision nonce digest and frozen phase", () => {
  const decision = {
    decisionId: "55555555-5555-4555-8555-555555555555",
    category: "D1",
    controlNonceDigest: "a".repeat(64),
    state: "open",
    dedupeKey: "run: D1: decision",
    subjectId: null,
    summary: "A decision needs a reply.",
    createdAt: NOW,
    answeredAt: null,
  };

  test("a decision carries a bare 64hex control nonce digest", () => {
    expect(RunDecisionPointSchema.safeParse(decision).success).toBe(true);
    const invalid = [
      { ...decision, controlNonceDigest: "A".repeat(64) },
      { ...decision, controlNonceDigest: `sha256:${"a".repeat(64)}` },
      { ...decision, controlNonceDigest: "11111111-1111-4111-8111-111111111111" },
      { ...decision, controlNonceDigest: "a".repeat(63) },
      (() => {
        const { controlNonceDigest: _omit, ...missing } = decision;
        return missing;
      })(),
    ];
    for (const value of invalid) {
      const parsed = RunDecisionPointSchema.safeParse(value);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues).toHaveLength(1);
        expect(parsed.error.issues[0]?.path).toEqual(["controlNonceDigest"]);
      }
    }
  });

  test("hot/tool claims are legal enum values and conflict semantics stay out of the schema", () => {
    const base = {
      claimId: "claim-hot-1",
      taskId: "T1",
      repoId: "repo-1",
      path: "repo:hotspot",
      access: "write",
      frozen: false,
      createdAt: NOW,
    };
    for (const kind of ["hot", "tool"] as const) {
      expect(RunResourceClaimSchema.safeParse({ ...base, kind }).success).toBe(true);
    }
    const invalid = RunResourceClaimSchema.safeParse({ ...base, kind: "glob" });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues).toHaveLength(1);
      expect(invalid.error.issues[0]?.path).toEqual(["kind"]);
    }
    const readOnly = RunResourceClaimSchema.safeParse({ ...base, kind: "hot", access: "read" });
    expect(readOnly.success).toBe(false);
    if (!readOnly.success) {
      expect(readOnly.error.issues).toHaveLength(1);
      expect(readOnly.error.issues[0]?.path).toEqual(["access"]);
    }
  });

  test("frozen is a legal phase and an unknown phase is a single-defect rejection", () => {
    expect(RUN_TASK_PHASES).toContain("frozen");
    expect(RunTaskPhaseSchema.safeParse("frozen").success).toBe(true);
    expect(
      RunTaskRecordSchema.safeParse(taskRecord({ state: "blocked", phase: "frozen" })).success,
    ).toBe(true);
    expect(
      RunTaskRecordSchema.safeParse(taskRecord({ state: "blocked", phase: "frozen" })).success,
    ).toBe(true);
    expect(
      RunTaskRecordSchema.safeParse(taskRecord({ state: "blocked", phase: undefined })).success,
    ).toBe(true);
    const invalidPhases = [
      { state: "ready", phase: "frozen" },
      { state: "in_progress", phase: "frozen" },
      { state: "review", phase: "frozen" },
      { state: "done", phase: "frozen" },
      { state: "cancelled", phase: "frozen" },
      { state: "done", phase: "awaiting-rework" },
      { state: "blocked", phase: "awaiting-rework" },
    ];
    for (const value of invalidPhases) {
      const invalid = RunTaskRecordSchema.safeParse(taskRecord(value));
      expect(invalid.success).toBe(false);
      if (!invalid.success) {
        expect(invalid.error.issues).toHaveLength(1);
        expect(invalid.error.issues[0]?.path).toEqual(["phase"]);
      }
    }
    const unknown = RunTaskRecordSchema.safeParse(
      taskRecord({ state: "review", phase: "holding" }),
    );
    expect(unknown.success).toBe(false);
    if (!unknown.success) {
      expect(unknown.error.issues).toHaveLength(1);
      expect(unknown.error.issues[0]?.path).toEqual(["phase"]);
    }
  });
});

describe("R01d escalation chain", () => {
  const a = {
    fromTier: "B",
    toTier: "A",
    atAttempt: 3,
    qualityFailures: 3,
    at: NOW,
  };
  const sTier = { ...a, fromTier: "A", toTier: "S", atAttempt: 6, qualityFailures: 6 };
  const r01dTask = (overrides: Record<string, unknown>) =>
    taskRecord({ attempts: 10, qualityFailures: 10, ...overrides });

  test("B→A and B→A→S chains parse; two entries are the maximum", () => {
    expect(RunTaskRecordSchema.safeParse(r01dTask({ escalations: [a] })).success).toBe(true);
    expect(RunTaskRecordSchema.safeParse(r01dTask({ escalations: [a, sTier] })).success).toBe(true);
    const tooMany = RunTaskRecordSchema.safeParse(r01dTask({ escalations: [a, sTier, a] }));
    expect(tooMany.success).toBe(false);
    if (!tooMany.success) {
      expect(tooMany.error.issues.some((issue) => issue.path[0] === "escalations")).toBe(true);
    }
  });

  test("A start can escalate only to S; S start cannot escalate at all", () => {
    const aStart = r01dTask({
      spec: taskSpec({ level: "L3", tier: "A" }),
      escalations: [sTier],
    });
    expect(RunTaskRecordSchema.safeParse(aStart).success).toBe(true);

    const sStart = r01dTask({
      spec: taskSpec({ level: "L4", tier: "S" }),
      escalations: [{ ...a, fromTier: "S", toTier: "S" }],
    });
    const rejected = RunTaskRecordSchema.safeParse(sStart);
    expect(rejected.success).toBe(false);
    if (!rejected.success) {
      expect(rejected.error.issues).toHaveLength(1);
      expect(rejected.error.issues[0]?.path).toEqual(["escalations", 0, "toTier"]);
    }
  });

  test("wrong fromTier, skipped toTier, missing field and bad attempt are single defects", () => {
    const cases: Array<{ value: unknown; path: (string | number)[] }> = [
      {
        value: r01dTask({ escalations: [{ ...a, fromTier: "A" }] }),
        path: ["escalations", 0, "fromTier"],
      },
      {
        value: r01dTask({ escalations: [{ ...a, toTier: "S" }] }),
        path: ["escalations", 0, "toTier"],
      },
      {
        value: r01dTask({ escalations: [a, { ...sTier, fromTier: "B" }] }),
        path: ["escalations", 1, "fromTier"],
      },
      {
        value: r01dTask({ escalations: [{ ...a, atAttempt: 0 }] }),
        path: ["escalations", 0, "atAttempt"],
      },
      {
        value: r01dTask({
          escalations: [{ fromTier: "B", toTier: "A", atAttempt: 1, at: NOW }],
        }),
        path: ["escalations", 0, "qualityFailures"],
      },
    ];
    for (const entry of cases) {
      const parsed = RunTaskRecordSchema.safeParse(entry.value);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues).toHaveLength(1);
        expect(parsed.error.issues[0]?.path).toEqual(entry.path);
      }
    }
  });
});

describe("R01e spec tier consistency and escalation counters", () => {
  test("default tiers follow level, except a-with-s-plan L4/A", () => {
    for (const [level, tier] of [
      ["L1", "B"],
      ["L2", "B"],
      ["L3", "A"],
      ["L4", "S"],
    ] as const) {
      expect(
        RunTaskRecordSchema.safeParse(taskRecord({ spec: taskSpec({ level, tier }) })).success,
      ).toBe(true);
    }
    expect(
      RunTaskRecordSchema.safeParse(
        taskRecord({
          spec: taskSpec({
            level: "L4",
            tier: "A",
            implementationPolicy: "a-with-s-plan",
            architectureTaskId: "T0",
          }),
        }),
      ).success,
    ).toBe(true);

    const mismatches: Array<{ spec: Record<string, unknown>; path: (string | number)[] }> = [
      { spec: { level: "L4", tier: "B" }, path: ["spec", "tier"] },
      { spec: { level: "L1", tier: "S" }, path: ["spec", "tier"] },
      {
        spec: {
          level: "L3",
          tier: "A",
          implementationPolicy: "a-with-s-plan",
          architectureTaskId: "T0",
        },
        path: ["spec", "level"],
      },
      {
        spec: {
          level: "L4",
          tier: "B",
          implementationPolicy: "a-with-s-plan",
          architectureTaskId: "T0",
        },
        path: ["spec", "tier"],
      },
    ];
    for (const entry of mismatches) {
      const parsed = RunTaskRecordSchema.safeParse(taskRecord({ spec: taskSpec(entry.spec) }));
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues).toHaveLength(1);
        expect(parsed.error.issues[0]?.path).toEqual(entry.path);
      }
    }
  });

  test("escalation counters are monotonic and bounded by the task totals", () => {
    const base = { fromTier: "B", toTier: "A", atAttempt: 3, qualityFailures: 3, at: NOW };
    const cases: Array<{ task: ReturnType<typeof taskRecord>; path: (string | number)[] }> = [
      {
        task: taskRecord({
          attempts: 4,
          qualityFailures: 4,
          escalations: [
            base,
            { ...base, fromTier: "A", toTier: "S", atAttempt: 4, qualityFailures: 1 },
          ],
        }),
        path: ["escalations", 1, "qualityFailures"],
      },
      {
        task: taskRecord({
          attempts: 10,
          qualityFailures: 10,
          escalations: [{ ...base, qualityFailures: 99 }],
        }),
        path: ["escalations", 0, "qualityFailures"],
      },
      {
        task: taskRecord({
          attempts: 2,
          qualityFailures: 3,
          escalations: [{ ...base, atAttempt: 3 }],
        }),
        path: ["escalations", 0, "atAttempt"],
      },
    ];
    for (const entry of cases) {
      const parsed = RunTaskRecordSchema.safeParse(entry.task);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues).toHaveLength(1);
        expect(parsed.error.issues[0]?.path).toEqual(entry.path);
      }
    }
  });

  test("a third escalation is rejected by the array cap, not only by the S rule", () => {
    const a = { fromTier: "B", toTier: "A", atAttempt: 3, qualityFailures: 3, at: NOW };
    const s = { ...a, fromTier: "A", toTier: "S", atAttempt: 6, qualityFailures: 6 };
    const parsed = RunTaskRecordSchema.safeParse(
      taskRecord({
        attempts: 6,
        qualityFailures: 6,
        escalations: [a, s, { ...s, fromTier: "S", toTier: "S" }],
      }),
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some(
          (issue) => issue.path[0] === "escalations" && issue.path.length === 1,
        ),
      ).toBe(true);
    }
  });
});

describe("RunRecord persists through the real AtomicJsonCodec", () => {
  test("create/read/update/CAS keep the codec header and unknown fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "r01b-codec-"));
    try {
      const codec: AtomicJsonCodec<RunRecord> = {
        schemaVersion: RUN_SCHEMA_VERSION,
        parse: (value) => RunRecordSchema.parse(value),
        readHeader: (record) => ({
          schemaVersion: record.schemaVersion,
          revision: record.revision,
          previousDigest: record.previousDigest,
        }),
        withHeader: (record, header) => RunRecordSchema.parse({ ...record, ...header }),
      };
      const store = createAtomicJson({
        file: path.join(root, "run.json"),
        issuesDir: path.join(root, "issues"),
        containmentRoot: root,
        codec,
      });
      const firstRecord = RunRecordSchema.parse(
        runRecord({
          revision: 1,
          previousDigest: "",
          futureTop: { keep: true },
          launch: { ...runRecord().launch, futureLaunch: "kept" },
        }),
      );
      await store.commit(firstRecord, { revision: 0, digest: "" });
      const first = await store.read();
      if (first.status !== "ok") throw new Error(`first read: ${first.status}`);
      expect(first.record.previousDigest).toBe("");
      expect(first.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(first.record.futureTop).toEqual({ keep: true });
      expect(first.record.launch.futureLaunch).toBe("kept");

      await store.commit(
        RunRecordSchema.parse(
          runRecord({
            revision: 2,
            previousDigest: first.digest,
            futureTop: { keep: true },
            launch: { ...runRecord().launch, futureLaunch: "kept" },
          }),
        ),
        { revision: 1, digest: first.digest },
      );
      const second = await store.read();
      if (second.status !== "ok") throw new Error(`second read: ${second.status}`);
      expect(second.record.previousDigest).toBe(first.digest);
      expect(second.record.futureTop).toEqual({ keep: true });
      expect(second.record.launch.futureLaunch).toBe("kept");

      await expect(
        store.commit(
          RunRecordSchema.parse(runRecord({ revision: 3, previousDigest: second.digest })),
          { revision: 1, digest: first.digest },
        ),
      ).rejects.toThrow(/cas-mismatch|changed/);
      await expect(
        store.commit(
          RunRecordSchema.parse(
            runRecord({ revision: 3, previousDigest: `sha256:${"b".repeat(64)}` }),
          ),
          { revision: 2, digest: second.digest },
        ),
      ).rejects.toThrow(/header-invalid|previousDigest/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("revision 0 is rejected by the schema and by the codec header check alike", () => {
  test("the same record that RunRecordSchema refuses never reaches the disk", async () => {
    const zero = runRecord({ revision: 0, previousDigest: `sha256:${DIGEST}` });
    expect(RunRecordSchema.safeParse(zero).success).toBe(false);

    const root = await mkdtemp(path.join(tmpdir(), "r01b-rev0-"));
    try {
      // A lenient parse isolates the codec header check from the schema.
      const codec: AtomicJsonCodec<RunRecord> = {
        schemaVersion: RUN_SCHEMA_VERSION,
        parse: (value) => value as RunRecord,
        readHeader: (record) => ({
          schemaVersion: record.schemaVersion,
          revision: record.revision,
          previousDigest: record.previousDigest,
        }),
        withHeader: (record, header) => ({ ...record, ...header }) as RunRecord,
      };
      const store = createAtomicJson({
        file: path.join(root, "run.json"),
        issuesDir: path.join(root, "issues"),
        containmentRoot: root,
        codec,
      });
      await expect(
        store.commit(zero as unknown as RunRecord, { revision: 0, digest: "" }),
      ).rejects.toThrow(/header-invalid|positive integer/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("F15 reuses the real hashLaunchPlan digest", () => {
  test("p1PlanHash and modelPlanHash are the same bare 64hex", () => {
    const team = { ...codingTeam, mode: "sota" as const };
    const roles = [techLead, architect, developer];
    const profiles: PaseoProfile[] = [claudeOpus, codexXhigh];
    const availability: ProviderAvailability[] = [
      { provider: "claude", available: true },
      { provider: "codex", available: true },
    ];
    const economy: EconomyPolicy = { pool: [], taskOrder: {}, profileBudget: {} };
    const runtimeCapabilities = { onDemand: true, expansion: true, collaboration: true };
    const task = "Add Stripe";
    const plan = buildLaunchPlan({
      team,
      roles,
      profiles,
      availability,
      workspaceId: "ws-1",
      task,
      runId: "run-f15",
      maxMembers: 8,
      economy,
      runtimeCapabilities,
      daemonConfig: { mcp: { enabled: true, injectIntoAgents: true } },
    });
    const digest = hashLaunchPlan({
      team,
      roles,
      plan,
      host: { status: "ready", profiles, availability },
      economy,
      target: { kind: "workspace", workspaceId: "ws-1" },
      task,
      maxMembers: 8,
      runtimeCapabilities,
    });
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    const parsed = RunRecordSchema.parse(
      runRecord({
        launch: { ...runRecord().launch, modelPlan: modelPlan({ p1PlanHash: digest }) },
        team: { ...runRecord().team, modelPlanHash: digest },
      }),
    );
    expect(parsed.launch.modelPlan.p1PlanHash).toBe(digest);
    expect(parsed.team.modelPlanHash).toBe(digest);

    const { p1PlanHash: _omitted, ...legacyPlan } = modelPlan();
    expect(
      RunRecordSchema.safeParse(
        runRecord({ launch: { ...runRecord().launch, modelPlan: legacyPlan } }),
      ).success,
    ).toBe(false);
  });
});

describe("RPC contracts reject unknown input and never leak ledger internals", () => {
  test("inputs are strict and carry the run contract version", () => {
    expect(RunGetInputSchema.safeParse({ runContractVersion: 1, runId: RUN_ID }).success).toBe(
      true,
    );
    expect(RunGetInputSchema.safeParse({ runId: RUN_ID }).success).toBe(false);
    expect(RunGetInputSchema.safeParse({ runContractVersion: 2, runId: RUN_ID }).success).toBe(
      false,
    );
    expect(
      RunGetInputSchema.safeParse({ runContractVersion: 1, runId: RUN_ID, extra: 1 }).success,
    ).toBe(false);
    expect(
      RunGetInputSchema.safeParse({
        runContractVersion: 1,
        runId: RUN_ID,
        historyCursor: "cursor-1",
        limit: 50,
      }).success,
    ).toBe(true);
    expect(
      RunGetInputSchema.safeParse({
        runContractVersion: 1,
        runId: RUN_ID,
        knownRevision: 3,
        historyCursor: "cursor-1",
      }).success,
    ).toBe(false);
    for (const limit of [0, 51]) {
      expect(
        RunGetInputSchema.safeParse({ runContractVersion: 1, runId: RUN_ID, limit }).success,
      ).toBe(false);
    }
  });

  test("run.get returns unchanged or a redacted view with no nonce/prompt fields", () => {
    expect(
      RunGetOutputSchema.parse({ runContractVersion: 1, status: "unchanged", revision: 3 }),
    ).toMatchObject({ status: "unchanged" });

    const view = {
      runId: RUN_ID,
      revision: 3,
      lifecycle: "active",
      team: {
        id: "team-1",
        name: "Engine Team",
        rawMode: "economy-all",
        modeContract: 3,
        plannerVersion: 2,
      },
      dagRevision: 1,
      dag: {
        revision: 1,
        tasks: [{ taskId: "t1", title: "Ship", layer: 0, deps: [], state: "review" }],
      },
      tasks: [
        {
          taskId: "t1",
          title: "Ship",
          state: "review",
          phase: "awaiting-rework",
          level: "L1",
          tier: "B",
          execution: "write",
          assignee: null,
          attempts: 1,
          protocolFailures: 0,
          evidenceReturns: 0,
          reworkCount: 1,
          waitingReason: null,
          frozen: false,
        },
      ],
      locks: [
        {
          claimId: "claim-hot",
          taskId: "t1",
          repoId: "repo-1",
          kind: "hot",
          path: "repo:hotspot",
          access: "write",
          frozen: false,
        },
        {
          claimId: "claim-tool",
          taskId: "t1",
          repoId: "repo-1",
          kind: "tool",
          path: "npm:install",
          access: "write",
          frozen: false,
        },
      ],
      capacity: { configuredLimit: 4, effectiveLimit: 4, inUse: 1 },
      budgets: [],
      decisions: [
        {
          decisionId: "66666666-6666-4666-8666-666666666666",
          category: "D1",
          state: "open",
          subjectId: null,
          summary: "A decision",
          createdAt: NOW,
          controlNonceDigest: "d".repeat(64),
          nonce: "raw-control-nonce",
        },
      ],
      channels: [],
      alerts: [],
      metrics: {
        strategicTurns: 0,
        workerEvents: 4,
        decisions: 0,
        tasks: 1,
        reworks: 1,
        firstReviewAccepted: 0,
        coverage: "partial",
      },
      issues: [],
    };
    const parsed = RunDetailViewSchema.parse(view);
    const ready = RunGetOutputSchema.parse({
      runContractVersion: 1,
      status: "ready",
      run: parsed,
      history: {
        events: [
          {
            seq: 1,
            kind: "task_started",
            at: NOW,
            taskId: "t1",
            summary: "started t1",
          },
        ],
        nextCursor: null,
      },
      issues: [],
    });
    const serialized = JSON.stringify(ready);
    for (const forbidden of ["prompt", "payloadHash", "semanticArgs", "recoverySend"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).not.toMatch(/nonce/iu);
    expect(serialized).not.toContain("d".repeat(64));
    expect(parsed.tasks[0]).toMatchObject({ phase: "awaiting-rework", frozen: false });

    // Q1: ready always carries run+history; the failure branches never do.
    expect(
      RunGetOutputSchema.safeParse({
        runContractVersion: 1,
        status: "ready",
        run: null,
        history: { events: [], nextCursor: null },
        issues: [],
      }).success,
    ).toBe(false);
    expect(
      RunGetOutputSchema.safeParse({
        runContractVersion: 1,
        status: "ready",
        run: parsed,
        issues: [],
      }).success,
    ).toBe(false);
    for (const status of ["unknown-version", "corrupt", "missing"] as const) {
      expect(
        RunGetOutputSchema.safeParse({
          runContractVersion: 1,
          status,
          run: null,
          issues: [],
        }).success,
      ).toBe(true);
    }

    // 144 I2: a failure branch never carries a run, and a ready result needs both run and history.
    for (const status of ["unknown-version", "corrupt", "missing"] as const) {
      const withRun = RunGetOutputSchema.safeParse({
        runContractVersion: 1,
        status,
        run: parsed,
        issues: [],
      });
      expect(withRun.success, `${status} with a run`).toBe(false);
      if (!withRun.success) {
        expect(withRun.error.issues.map((issue) => issue.path.join("."))).toContain("run");
      }
    }
    expect(
      RunGetOutputSchema.safeParse({
        runContractVersion: 1,
        status: "ready",
        history: { events: [], nextCursor: null },
        issues: [],
      }).success,
      "ready without a run",
    ).toBe(false);
    // The view never carries history on unchanged or failure results: it is parsed away.
    const unchangedWithHistory = RunGetOutputSchema.parse({
      runContractVersion: 1,
      status: "unchanged",
      revision: 3,
      history: { events: [], nextCursor: null },
    });
    expect("history" in unchangedWithHistory).toBe(false);

    // 144 S4: an expired cursor is a fixed warning, and the first page still comes back.
    const expired = runHistoryCursorExpiredIssue();
    expect(expired.code).toBe("history-cursor-expired");
    expect(RUN_HISTORY_CURSOR_EXPIRED).toBe(expired.code);
    expect(RunIssueViewSchema.parse(expired)).toEqual(expired);
    expect(expired).toMatchObject({ severity: "warning", action: "refresh" });
    expect(RunGetOutputSchema.parse({ ...ready, issues: [expired] })).toMatchObject({
      status: "ready",
      issues: [{ code: "history-cursor-expired" }],
    });

    // R1b-1: layer is the topological depth, and deps must exist.
    const dagNode = view.dag.tasks[0];
    const firstRow = view.tasks[0];
    if (!dagNode || !firstRow) throw new Error("fixture node/row missing");
    const wrongLayer = {
      ...view,
      dag: { revision: 1, tasks: [{ ...dagNode, layer: 1 }] },
    };
    expect(RunDetailViewSchema.safeParse(wrongLayer).success).toBe(false);
    const missingDep = {
      ...view,
      dag: { revision: 1, tasks: [{ ...dagNode, deps: ["missing"] }] },
    };
    expect(RunDetailViewSchema.safeParse(missingDep).success).toBe(false);
    const secondRow = { ...firstRow, taskId: "t2", title: "Then" };
    const dagSecond = { ...dagNode, taskId: "t2", title: "Then", deps: ["t1"], layer: 1 };
    const twoRows = [firstRow, secondRow];
    // Every case starts from this valid two-node graph and changes exactly one thing.
    const validTwo = { ...view, dag: { revision: 1, tasks: [dagNode, dagSecond] }, tasks: twoRows };
    expect(RunDetailViewSchema.safeParse(validTwo).success).toBe(true);

    // Declaration order need not be topological: a diamond whose join node comes first is valid.
    const thirdRow = { ...firstRow, taskId: "t3", title: "Join" };
    const join = { ...dagNode, taskId: "t3", title: "Join", deps: ["t1", "t2"], layer: 2 };
    const diamond = {
      ...view,
      dag: { revision: 1, tasks: [join, dagNode, dagSecond] },
      tasks: [firstRow, secondRow, thirdRow],
    };
    expect(RunDetailViewSchema.safeParse(diamond).success).toBe(true);

    const issuePaths = (candidate: unknown): string[] | null => {
      const result = RunDetailViewSchema.safeParse(candidate);
      return result.success ? null : result.error.issues.map((issue) => issue.path.join("."));
    };
    const dagCases: { id: string; dag: unknown; path: string; only?: boolean }[] = [
      {
        id: "revision",
        dag: { revision: 2, tasks: [dagNode, dagSecond] },
        path: "dag.revision",
        only: true,
      },
      {
        id: "title",
        dag: { revision: 1, tasks: [dagNode, { ...dagSecond, title: "Other" }] },
        path: "dag.tasks.1",
        only: true,
      },
      {
        id: "state",
        dag: { revision: 1, tasks: [dagNode, { ...dagSecond, state: "done" }] },
        path: "dag.tasks.1",
        only: true,
      },
      {
        id: "layer-disagrees-with-deps",
        dag: { revision: 1, tasks: [dagNode, { ...dagSecond, layer: 0 }] },
        path: "dag.tasks.1.layer",
        only: true,
      },
      {
        id: "self-dep",
        dag: { revision: 1, tasks: [dagNode, { ...dagSecond, deps: ["t1", "t2"] }] },
        path: "dag.tasks.1.deps",
      },
      {
        id: "duplicate-dep",
        dag: { revision: 1, tasks: [dagNode, { ...dagSecond, deps: ["t1", "t1"] }] },
        path: "dag.tasks.1.deps",
        only: true,
      },
      {
        id: "missing-dep",
        dag: { revision: 1, tasks: [dagNode, { ...dagSecond, deps: ["ghost"] }] },
        path: "dag.tasks.1.deps",
      },
      {
        id: "missing-dag-task",
        dag: { revision: 1, tasks: [dagNode] },
        path: "dag.tasks",
        only: true,
      },
      {
        id: "duplicate-dag-task",
        dag: { revision: 1, tasks: [dagNode, dagSecond, dagSecond] },
        path: "dag.tasks.2.taskId",
        only: true,
      },
      {
        id: "cycle",
        dag: {
          revision: 1,
          tasks: [
            { ...dagNode, deps: ["t2"], layer: 1 },
            { ...dagSecond, deps: ["t1"], layer: 1 },
          ],
        },
        path: "dag.tasks.0.deps",
      },
    ];
    for (const entry of dagCases) {
      const paths = issuePaths({ ...view, dag: entry.dag, tasks: twoRows });
      expect(paths, entry.id).not.toBeNull();
      expect(paths, entry.id).toContain(entry.path);
      // A case that must fail for exactly one reason is not allowed to fail for another.
      if (entry.only) expect(paths, entry.id).toEqual([entry.path]);
    }
    // Compile-time guard: a parsed ledger record is structurally incompatible with the view.
    const ledgerRecord: RunRecord = RunRecordSchema.parse(runRecord());
    // @ts-expect-error a ledger record must not be assignable to the redacted view
    const notAView: RunDetailView = ledgerRecord;
    void notAView;
  });

  test("reconcile is observation-only and control has no force-done", () => {
    const reconcile = {
      runContractVersion: 1,
      diagnosisId: "diag-1",
      baseRevision: 3,
      observations: [
        {
          kind: "agent-closed",
          agentId: "agent-1",
          turnId: null,
          observedAt: NOW,
          summary: "closed",
        },
      ],
      proposedActions: [{ action: "refresh-observation", targetId: "agent-1", reason: "recheck" }],
      issues: [],
    };
    expect(RunReconcileOutputSchema.parse(reconcile)).toMatchObject({ diagnosisId: "diag-1" });
    expect(
      RunReconcileOutputSchema.parse({ ...reconcile, recoveryResult: { applied: true } }),
    ).not.toHaveProperty("recoveryResult");

    const control = {
      runContractVersion: 1,
      runId: RUN_ID,
      requestId: "req-c1",
      expectedRevision: 3,
      reason: "pause",
      action: { action: "pause" },
    };
    expect(RunControlInputSchema.safeParse(control).success).toBe(true);
    expect(
      RunControlInputSchema.safeParse({ ...control, action: { action: "force-done" } }).success,
    ).toBe(false);
    expect(
      RunControlInputSchema.safeParse({
        ...control,
        action: { action: "resume-request", diagnosisId: "diag-1", baseRevision: 3 },
      }).success,
    ).toBe(true);
    expect(
      RunControlInputSchema.safeParse({
        ...control,
        action: {
          action: "budget",
          scope: "seat",
          subjectId: "seat-s1",
          delta: 1,
          policyRevision: 1,
        },
      }).success,
    ).toBe(true);
  });
});

describe("Team configuration", () => {
  test("a valid block parses and keeps unknown fields", () => {
    const config = {
      version: 1,
      enabled: true,
      seats: [
        { seatId: "seat-b1", tier: "B", duties: ["dev"], channelId: "channel-a", enabled: true },
      ],
      policy: policy(),
      futureBlock: "kept",
    };
    expect(RunTeamEngineConfigSchema.parse(config)).toMatchObject({
      enabled: true,
      futureBlock: "kept",
    });
  });

  test("policyVersion is required and capacity cannot exceed the hard constant", () => {
    const config = {
      version: 1,
      enabled: true,
      seats: [
        {
          seatId: "seat-b1",
          tier: "B",
          duties: ["dev"],
          channelId: "channel-a",
          enabled: true,
        },
      ],
      policy: policy(),
    };
    expect(
      RunTeamEngineConfigSchema.safeParse({
        ...config,
        policy: { ...policy(), policyVersion: undefined },
      }).success,
    ).toBe(false);
    expect(
      RunTeamEngineConfigSchema.safeParse({
        ...config,
        policy: { ...policy(), capacity: { softBytes: RUN_HARD_BYTES + 1 } },
      }).success,
    ).toBe(false);
    expect(
      RunTeamEngineConfigSchema.safeParse({
        ...config,
        seats: [{ ...config.seats[0], tier: "X" }],
      }).success,
    ).toBe(false);
  });
});

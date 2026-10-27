import { describe, expect, test } from "vitest";
import { RunTeamEngineConfigSchema } from "../shared/schemas/run-engine/config";
import {
  RUN_HARD_BYTES,
  RUN_MAX_TASKS,
  RUN_SCHEMA_VERSION,
  RUN_SOFT_BYTES,
  RunEffectIntentSchema,
  RunEventReceiptSchema,
  RunHistoryCheckpointSchema,
  RunNonceEntrySchema,
  RunPolicySnapshotSchema,
  type RunRecord,
  RunRecordSchema,
  RunReopenGrantSchema,
} from "../shared/schemas/run-engine/ledger";
import {
  RunDecisionBlockSchema,
  RunReviewReportBlockSchema,
  RunSmokeReportBlockSchema,
  RunTaskDagBlockSchema,
  RunTaskReportBlockSchema,
} from "../shared/schemas/run-engine/protocol";
import {
  RunControlInputSchema,
  type RunDetailView,
  RunDetailViewSchema,
  RunGetInputSchema,
  RunGetOutputSchema,
  RunReconcileOutputSchema,
} from "../shared/schemas/run-engine/rpc";

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
    launchPlanFingerprint: DIGEST,
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
    previousDigest: DIGEST,
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

  test("schemaVersion, ids, digests, and revisions are exact", () => {
    expect(RunRecordSchema.safeParse(runRecord({ schemaVersion: 2 })).success).toBe(false);
    expect(RunRecordSchema.safeParse(runRecord({ runId: "run-abc" })).success).toBe(false);
    expect(RunRecordSchema.safeParse(runRecord({ runId: "run-AbC-xyz" })).success).toBe(false);
    expect(RunRecordSchema.safeParse(runRecord({ revision: -1 })).success).toBe(false);
    expect(RunRecordSchema.safeParse(runRecord({ previousDigest: "abc" })).success).toBe(false);
    expect(RunRecordSchema.safeParse(runRecord({ lifecycle: "paused" })).success).toBe(true);
    // A state this version does not know is a damaged v1 record, not passthrough data.
    expect(
      RunRecordSchema.safeParse(runRecord({ tasks: [taskRecord({ state: "holding" })] })).success,
    ).toBe(false);
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
      locks: [],
      capacity: { configuredLimit: 4, effectiveLimit: 4, inUse: 1 },
      budgets: [],
      decisions: [],
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
    const serialized = JSON.stringify(parsed);
    for (const forbidden of ["nonce", "prompt", "payloadHash", "semanticArgs", "recoverySend"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(parsed.tasks[0]).toMatchObject({ phase: "awaiting-rework", frozen: false });
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

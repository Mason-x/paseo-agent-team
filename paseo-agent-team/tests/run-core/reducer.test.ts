// biome-ignore-all lint/style/noNonNullAssertion: fixture builders guarantee these indices.
import { describe, expect, test } from "vitest";
import {
  checkLedgerInvariants,
  occupiesExecutionSlot,
} from "../../shared/domain/run-engine/invariants";
import { reduceRun } from "../../shared/domain/run-engine/reducer";
import type { ArchiveIntent, RunReducerEvent } from "../../shared/domain/run-engine/transitions";
import type { RunEventReceipt, RunRecord } from "../../shared/schemas/run-engine/ledger";
import { RunRecordSchema } from "../../shared/schemas/run-engine/ledger";
import type {
  RunReviewReportBlock,
  RunSmokeReportBlock,
  RunTaskReportBlock,
} from "../../shared/schemas/run-engine/protocol";
import {
  ASSIGNMENT_T2,
  AT_UPDATED,
  assignment,
  CANCELLATION_AUTHORIZED_FROZEN_LEDGER,
  claim,
  DECISION_D1,
  dispatchIntent,
  INTENT_CANCEL,
  MESSAGE_CANCEL,
  MESSAGE_T2,
  NONCE_T2,
  NONCE_T2_REVIEW,
  NORMAL_RUN_LEDGER,
  QUIESCENT_CANCELLATION,
  spec,
  taskRecord,
} from "../fixtures/run-engine";

const CONTROL_DIGEST = "9".repeat(64);
let nextId = 0;
const facts = {
  now: AT_UPDATED,
  newId: (_kind: string) => {
    nextId += 1;
    return `90000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
  },
};

function taskOf(record: RunRecord, id: string) {
  const found = record.tasks.find((entry) => entry.spec.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

function assertDispatchBaseline(record: RunRecord): void {
  expect(RunRecordSchema.safeParse(record).success).toBe(true);
  const invariants = checkLedgerInvariants(record);
  expect(invariants.ok, JSON.stringify(invariants)).toBe(true);
}

function report(overrides: Partial<RunTaskReportBlock> = {}): RunTaskReportBlock {
  return {
    protocolVersion: 1,
    runId: NORMAL_RUN_LEDGER.runId,
    taskId: "t2",
    attempt: 1,
    nonce: NONCE_T2,
    assignmentId: ASSIGNMENT_T2,
    status: "done",
    changedFiles: ["src/t2.ts"],
    ref: { kind: "git-commit", value: "9f3c1a7" },
    workspace: {
      id: "ws-run-rec0re-a1-t2",
      branch: "re-rec0rea1-t2-a1-1",
      baseRef: "main",
    },
    evidence: [
      {
        id: "five-gates",
        command: "npm run check && npm run typecheck && npm test",
        exitCode: 0,
        summary: "all gates passed",
        artifactPath: "evidence/check.log",
        ref: { kind: "git-commit", value: "9f3c1a7" },
        isolation: {
          homePath: "C:/Users/cc/AppData/Local/Temp/run-home",
          outsideRealHome: true,
        },
      },
    ],
    ...overrides,
  } as RunTaskReportBlock;
}

/** A legal blocked/failed report: unlike done, it carries no ref, workspace or changedFiles. */
function notDoneReport(status: "blocked" | "failed"): RunTaskReportBlock {
  return {
    protocolVersion: 1,
    runId: NORMAL_RUN_LEDGER.runId,
    taskId: "t2",
    attempt: 1,
    nonce: NONCE_T2,
    assignmentId: ASSIGNMENT_T2,
    status,
    reasonCode: "needs-help",
    summary: "stuck",
    evidence: [],
  };
}

function reviewerAssignment() {
  return assignment({
    assignmentId: "assignment-t2-r1",
    seatId: "seat-b2",
    agentId: "agent-b2",
    purpose: "reviewer",
    tier: "A",
    family: "codex",
    nonce: NONCE_T2_REVIEW,
    messageId: "11111111-2222-4222-8222-222222222222",
    delivery: { producerAssignmentId: ASSIGNMENT_T2 },
  });
}

function review(overrides: Partial<RunReviewReportBlock> = {}): RunReviewReportBlock {
  return {
    protocolVersion: 1,
    runId: NORMAL_RUN_LEDGER.runId,
    taskId: "t2",
    attempt: 1,
    nonce: NONCE_T2_REVIEW,
    assignmentId: "assignment-t2-r1",
    reviewedRef: { kind: "git-commit", value: "9f3c1a7" },
    verdict: "可合入",
    blockers: [],
    probes: [],
    ...overrides,
  } as RunReviewReportBlock;
}

function receipt(overrides: Partial<RunEventReceipt> = {}): RunEventReceipt {
  return {
    eventKey: "agent-b1|turn-7|turn_ended",
    kind: "turn_ended",
    agentId: "agent-b1",
    turnId: "turn-7",
    seq: 8,
    receivedAt: AT_UPDATED,
    dedupeKey: "dedupe-turn-7",
    disposition: "observed",
    ...overrides,
  };
}

function reduceOrThrow(record: RunRecord, event: RunReducerEvent): RunRecord {
  const baseline = structuredClone(record);
  expect(RunRecordSchema.safeParse(record).success).toBe(true);
  expect(checkLedgerInvariants(record).ok).toBe(true);
  const result = reduceRun(record, event, facts);
  expect(record).toEqual(baseline);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(JSON.stringify(result));
  expect(RunRecordSchema.safeParse(result.next).success).toBe(true);
  expect(checkLedgerInvariants(result.next).ok).toBe(true);
  return result.next;
}

function observeAndEndDispatch(record: RunRecord, assignmentId: string): RunRecord {
  const assignment = record.assignments.find((entry) => entry.assignmentId === assignmentId);
  if (!assignment || assignment.turnId === null) throw new Error("unstarted assignment");
  const endedEventKey = `${assignment.agentId}|${assignment.turnId}|turn_ended`;
  const observed = reduceOrThrow(record, {
    kind: "observation-recorded",
    receipt: {
      eventKey: endedEventKey,
      kind: "turn_ended",
      agentId: assignment.agentId,
      turnId: assignment.turnId,
      seq: record.counters.observationSeq + 1,
      receivedAt: AT_UPDATED,
      dedupeKey: endedEventKey,
      disposition: "accepted",
    },
  });
  return reduceOrThrow(observed, { kind: "turn-ended", assignmentId, endedEventKey });
}

type TestArchiveIntent = ArchiveIntent & { assignmentId: string };

function archiveIntent(overrides: Record<string, unknown> = {}): TestArchiveIntent {
  return dispatchIntent({
    id: INTENT_CANCEL,
    kind: "archive",
    assignmentId: ASSIGNMENT_T2,
    taskId: "t2",
    recipient: "agent-b1",
    messageId: MESSAGE_CANCEL,
    idempotencyKey: "cancel-t2-1",
    state: "prepared",
    confirmedAt: null,
    localCancellation: null,
    ...overrides,
  }) as TestArchiveIntent;
}

function cancelEvent(
  intent: TestArchiveIntent,
  taskIds: string[] = ["t2"],
  controlNonceDigest = CONTROL_DIGEST,
) {
  return {
    kind: "cancel-requested" as const,
    taskIds: taskIds as [string],
    reason: "cancel",
    cancelIntents: [{ assignmentId: intent.assignmentId, intentId: intent.id }],
    preparedCancelIntents: [intent],
    controlNonceDigest,
  };
}

function frozenNormal(record = structuredClone(NORMAL_RUN_LEDGER)): RunRecord {
  assertDispatchBaseline(record);
  return reduceOrThrow(record, cancelEvent(archiveIntent()));
}

function ensureRoleSeat(
  record: RunRecord,
  seatId: string,
  agentId: string,
  duty: "implement" | "review" | "smoke",
  tier: "A" | "B" | "S" = "A",
): void {
  if (record.roster.some((entry) => entry.seatId === seatId)) return;
  record.roster.push({
    seatId,
    tier,
    agentId,
    channelId: "claude",
    duties: [duty],
    enabled: true,
  });
}

function ensureDispatchSeat(
  record: RunRecord,
  seatId = "seat-b7",
  agentId = "agent-b7",
  tier: "A" | "B" | "S" = "B",
): void {
  if (record.roster.some((entry) => entry.seatId === seatId)) return;
  record.roster.push({
    seatId,
    tier,
    agentId,
    channelId: "claude",
    duties: ["implement"],
    enabled: true,
  });
}

function dispatchReviewerViaEvent(record: RunRecord): RunRecord {
  const assignment = reviewerAssignment();
  return reduceOrThrow(record, {
    kind: "task-dispatched",
    taskId: "t2",
    assignment,
    nonce: {
      nonce: assignment.nonce,
      runId: record.runId,
      taskId: "t2",
      assignmentId: assignment.assignmentId,
      attempt: 1,
      phase: "review",
      agentId: assignment.agentId,
      seatId: assignment.seatId,
      issuedAt: AT_UPDATED,
      acceptedAt: null,
      acceptedEventKey: null,
      revokedAt: null,
      revokeReason: null,
    },
    intent: dispatchIntent({
      id: `intent-${assignment.assignmentId}`,
      kind: "dispatch",
      taskId: "t2",
      assignmentId: assignment.assignmentId,
      recipient: assignment.agentId,
      messageId: assignment.messageId,
      idempotencyKey: `dispatch-${assignment.assignmentId}`,
      state: "confirmed",
      confirmedAt: AT_UPDATED,
      localCancellation: null,
    }),
    reissueOfAssignmentId: null,
  });
}

function producerDoneFlow(): RunRecord {
  let record = structuredClone(NORMAL_RUN_LEDGER);
  assertDispatchBaseline(record);
  record = reduceOrThrow(record, {
    kind: "turn-started",
    assignmentId: ASSIGNMENT_T2,
    agentId: "agent-b1",
    turnId: "turn-producer",
  });
  record = reduceOrThrow(record, { kind: "task-report", block: report() });
  return observeAndEndDispatch(record, ASSIGNMENT_T2);
}

function reviewReadyFlow(): RunRecord {
  let record = producerDoneFlow();
  record = dispatchReviewerViaEvent(record);
  return reduceOrThrow(record, {
    kind: "turn-started",
    assignmentId: "assignment-t2-r1",
    agentId: "agent-b2",
    turnId: "turn-review",
  });
}

function dispatchReviewer(
  record: RunRecord,
  options: {
    id: string;
    seatId: string;
    agentId: string;
    nonce: string;
    tier?: "A" | "B" | "S";
  },
): RunRecord {
  const tier = options.tier ?? "A";
  ensureRoleSeat(record, options.seatId, options.agentId, "review", tier);
  const reviewer = assignment({
    assignmentId: options.id,
    taskId: "t2",
    seatId: options.seatId,
    agentId: options.agentId,
    purpose: "reviewer",
    tier,
    family: "codex",
    nonce: options.nonce,
    messageId: "11111111-4444-4444-8444-444444444444",
    delivery: { producerAssignmentId: ASSIGNMENT_T2 },
  });
  return reduceOrThrow(record, {
    kind: "task-dispatched",
    taskId: "t2",
    assignment: reviewer,
    nonce: {
      nonce: reviewer.nonce,
      runId: record.runId,
      taskId: "t2",
      assignmentId: reviewer.assignmentId,
      attempt: 1,
      phase: "review",
      agentId: reviewer.agentId,
      seatId: reviewer.seatId,
      issuedAt: AT_UPDATED,
      acceptedAt: null,
      acceptedEventKey: null,
      revokedAt: null,
      revokeReason: null,
    },
    intent: dispatchIntent({
      id: `intent-${reviewer.assignmentId}`,
      kind: "dispatch",
      taskId: "t2",
      assignmentId: reviewer.assignmentId,
      recipient: reviewer.agentId,
      messageId: reviewer.messageId,
      idempotencyKey: `dispatch-${reviewer.assignmentId}`,
      state: "confirmed",
      confirmedAt: AT_UPDATED,
      localCancellation: null,
    }),
    reissueOfAssignmentId: null,
  });
}

function dispatchSmoker(record: RunRecord): RunRecord {
  ensureRoleSeat(record, "seat-b3", "agent-b3", "smoke", "A");
  const smoker = assignment({
    assignmentId: "assignment-t2-smoke",
    taskId: "t2",
    seatId: "seat-b3",
    agentId: "agent-b3",
    purpose: "smoker",
    tier: "A",
    family: "codex",
    nonce: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    messageId: "11111111-3333-4333-8333-333333333333",
    delivery: { producerAssignmentId: ASSIGNMENT_T2 },
  });
  return reduceOrThrow(record, {
    kind: "task-dispatched",
    taskId: "t2",
    assignment: smoker,
    nonce: {
      nonce: smoker.nonce,
      runId: record.runId,
      taskId: "t2",
      assignmentId: smoker.assignmentId,
      attempt: 1,
      phase: "smoke",
      agentId: smoker.agentId,
      seatId: smoker.seatId,
      issuedAt: AT_UPDATED,
      acceptedAt: null,
      acceptedEventKey: null,
      revokedAt: null,
      revokeReason: null,
    },
    intent: dispatchIntent({
      id: `intent-${smoker.assignmentId}`,
      kind: "dispatch",
      taskId: "t2",
      assignmentId: smoker.assignmentId,
      recipient: smoker.agentId,
      messageId: smoker.messageId,
      idempotencyKey: `dispatch-${smoker.assignmentId}`,
      state: "confirmed",
      confirmedAt: AT_UPDATED,
      localCancellation: null,
    }),
    reissueOfAssignmentId: null,
  });
}

function smokeBlock(overrides: Partial<RunSmokeReportBlock> = {}): RunSmokeReportBlock {
  return {
    protocolVersion: 1,
    runId: NORMAL_RUN_LEDGER.runId,
    taskId: "t2",
    attempt: 1,
    nonce: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    assignmentId: "assignment-t2-smoke",
    testedRef: { kind: "git-commit", value: "9f3c1a7" },
    devHost: "127.0.0.1:6799",
    devServerId: "dev-server-1",
    devHome: "/tmp/dev-home",
    checks: [{ id: "open runs", result: "pass", evidencePath: "evidence/smoke.png" }],
    ...overrides,
  };
}

function smokePhaseFlow(): { record: RunRecord; smokerId: string } {
  let record = producerDoneFlow();
  const task = taskOf(record, "t2");
  task.spec = {
    ...task.spec,
    devSmoke: true,
    smokeChecklist: ["open runs"],
    dispatchDuties: { ...task.spec.dispatchDuties, smoke: "smoke" },
  };
  record.policy = {
    ...record.policy,
    devTargets: [{ serverId: "dev-server-1", host: "127.0.0.1:6799", home: "/tmp/dev-home" }],
  };
  record = dispatchReviewerViaEvent(record);
  record = reduceOrThrow(record, {
    kind: "turn-started",
    assignmentId: "assignment-t2-r1",
    agentId: "agent-b2",
    turnId: "turn-review",
  });
  record = reduceOrThrow(record, { kind: "review-report", block: review() });
  record = observeAndEndDispatch(record, "assignment-t2-r1");
  record = dispatchSmoker(record);
  record = reduceOrThrow(record, {
    kind: "turn-started",
    assignmentId: "assignment-t2-smoke",
    agentId: "agent-b3",
    turnId: "turn-smoke",
  });
  return { record, smokerId: "assignment-t2-smoke" };
}

function l4ReadyFlow(): RunRecord {
  let record = structuredClone(NORMAL_RUN_LEDGER);
  assertDispatchBaseline(record);
  ensureRoleSeat(record, "seat-s7", "agent-s7", "implement", "S");
  const task = taskOf(record, "t2");
  task.spec = { ...task.spec, level: "L4", tier: "S" };
  const producer = record.assignments.find((entry) => entry.assignmentId === ASSIGNMENT_T2);
  if (!producer) throw new Error("missing producer");
  producer.seatId = "seat-s7";
  producer.agentId = "agent-s7";
  producer.tier = "S";
  producer.family = "codex";
  const producerNonce = record.nonceRegistry.find((entry) => entry.assignmentId === ASSIGNMENT_T2);
  if (!producerNonce) throw new Error("missing producer nonce");
  producerNonce.agentId = "agent-s7";
  producerNonce.seatId = "seat-s7";
  const producerIntent = record.outbox.find((entry) => entry.assignmentId === ASSIGNMENT_T2);
  if (!producerIntent) throw new Error("missing producer intent");
  producerIntent.recipient = "agent-s7";
  record = reduceOrThrow(record, {
    kind: "turn-started",
    assignmentId: ASSIGNMENT_T2,
    agentId: "agent-s7",
    turnId: "turn-producer",
  });
  record = reduceOrThrow(record, { kind: "task-report", block: report() });
  record = observeAndEndDispatch(record, ASSIGNMENT_T2);
  record = dispatchReviewer(record, {
    id: "assignment-t2-r1",
    seatId: "seat-s8",
    agentId: "agent-s8",
    nonce: NONCE_T2_REVIEW,
    tier: "S",
  });
  return reduceOrThrow(record, {
    kind: "turn-started",
    assignmentId: "assignment-t2-r1",
    agentId: "agent-s8",
    turnId: "turn-review",
  });
}

function negativeReviewFlow(): RunRecord {
  let record = structuredClone(NORMAL_RUN_LEDGER);
  assertDispatchBaseline(record);
  record = reduceOrThrow(record, {
    kind: "turn-started",
    assignmentId: ASSIGNMENT_T2,
    agentId: "agent-b1",
    turnId: "turn-producer",
  });
  record = reduceOrThrow(record, { kind: "task-report", block: report() });
  record = observeAndEndDispatch(record, ASSIGNMENT_T2);
  record = dispatchReviewerViaEvent(record);
  record = reduceOrThrow(record, {
    kind: "turn-started",
    assignmentId: "assignment-t2-r1",
    agentId: "agent-b2",
    turnId: "turn-review",
  });
  return reduceOrThrow(record, {
    kind: "review-report",
    block: review({ verdict: "不可合入" }),
  });
}

describe("reduceRun", () => {
  test("forged gate events are not in the public vocabulary", () => {
    const result = reduceRun(
      structuredClone(NORMAL_RUN_LEDGER),
      { kind: "review-passed" } as never,
      facts,
    );
    expect(result).toMatchObject({
      ok: false,
      code: "RUN_EVENT_INVALID",
      params: { reason: "unsupported-in-batch-b" },
    });
  });

  test("an observation only advances observation state", () => {
    const before = structuredClone(NORMAL_RUN_LEDGER);
    const result = reduceRun(before, { kind: "observation-recorded", receipt: receipt() }, facts);
    expect(result.ok).toBe(true);
    expect(before).toEqual(NORMAL_RUN_LEDGER);
    if (!result.ok) return;
    expect(result.next.counters.observationSeq).toBe(NORMAL_RUN_LEDGER.counters.observationSeq + 1);
    expect(result.next.tasks).toEqual(NORMAL_RUN_LEDGER.tasks);
    const duplicate = reduceRun(
      result.next,
      { kind: "observation-recorded", receipt: receipt() },
      facts,
    );
    expect(duplicate).toMatchObject({ ok: true });
    if (duplicate.ok) expect(duplicate.next.events).toHaveLength(result.next.events.length);
  });

  test("a done report and independent review move T2 to done and ready T3", () => {
    let record = reviewReadyFlow();
    record = reduceOrThrow(record, { kind: "review-report", block: review() });
    record = observeAndEndDispatch(record, "assignment-t2-r1");
    expect(taskOf(record, "t2").state).toBe("done");
    expect(taskOf(record, "t3").state).toBe("ready");
    expect(record.resources).toEqual([]);
  });

  test("incomplete evidence stays in progress and increments evidenceReturns", () => {
    const bad = report({
      evidence: [
        {
          id: "five-gates",
          command: "npm run check && npm run typecheck && npm test",
          exitCode: 1,
          summary: "failed",
          artifactPath: "evidence/check.log",
          ref: { kind: "git-commit", value: "9f3c1a7" },
        },
      ],
    });
    const result = reduceRun(
      structuredClone(NORMAL_RUN_LEDGER),
      { kind: "task-report", block: bad },
      facts,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const task = taskOf(result.next, "t2");
    expect(task.state).toBe("in_progress");
    expect(task.evidenceReturns).toBe(1);
  });

  test("raw decision replies are rejected until the control nonce exists", () => {
    const actions = [
      { action: "replan", nextDagRevision: 2 },
      { action: "retry", taskId: "t2", reason: "retry" },
      { action: "cancel", taskIds: ["t2"], reason: "cancel" },
    ];
    for (const action of actions) {
      const record = structuredClone(NORMAL_RUN_LEDGER);
      record.decisions = [
        {
          decisionId: DECISION_D1,
          category: "D1",
          controlNonceDigest: CONTROL_DIGEST,
          state: "open",
          dedupeKey: `decision-${action.action}`,
          subjectId: "t2",
          summary: "decision",
          createdAt: AT_UPDATED,
          answeredAt: null,
          answer: null,
          cancelIntents: null,
          resolution: null,
        },
      ];
      const result = reduceRun(
        record,
        {
          kind: "decision",
          block: {
            protocolVersion: 1,
            runId: record.runId,
            taskId: `_decision:${DECISION_D1}`,
            attempt: 1,
            nonce: NONCE_T2,
            decisionId: DECISION_D1,
            action,
          },
        } as never,
        facts,
      );
      expect(result).toMatchObject({
        ok: false,
        code: "RUN_EVENT_INVALID",
        params: { reason: "unsupported-in-batch-b" },
      });
      expect(record.decisions[0]?.state).toBe("open");
    }
  });

  test("cancel-requested freezes an in-flight task even with quiescent evidence", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const assignmentValue = record.assignments.find(
      (entry) => entry.assignmentId === ASSIGNMENT_T2,
    );
    if (!assignmentValue) throw new Error("missing assignment");
    const intent = archiveIntent({ state: "confirmed", confirmedAt: AT_UPDATED });
    const decisionId = "90000000-0000-4000-8000-000000000099";
    record.outbox.push(intent);
    record.decisions.push({
      decisionId,
      category: "D1",
      controlNonceDigest: CONTROL_DIGEST,
      state: "open",
      dedupeKey: "cancel:t2",
      cancelIntents: [{ assignmentId: ASSIGNMENT_T2, intentId: intent.id }],
      subjectId: "t2",
      summary: "cancellation pending",
      createdAt: AT_UPDATED,
      answeredAt: null,
      answer: null,
      resolution: null,
    });
    assignmentValue.turnId = "turn-7";
    assignmentValue.cancellation = QUIESCENT_CANCELLATION;
    assertDispatchBaseline(record);
    const next = reduceOrThrow(record, {
      kind: "cancel-requested",
      taskIds: ["t2"],
      reason: "cancel",
      cancelIntents: [{ assignmentId: ASSIGNMENT_T2, intentId: intent.id }],
      preparedCancelIntents: [],
      controlNonceDigest: CONTROL_DIGEST,
    });
    expect(taskOf(next, "t2")).toMatchObject({ state: "blocked", phase: "frozen" });
    expect(next.resources.find((entry) => entry.taskId === "t2")?.frozen).toBe(true);
    expect(next.decisions[0]).toMatchObject({
      category: "D1",
      state: "open",
      dedupeKey: "cancel:t2",
      cancelIntents: [{ assignmentId: ASSIGNMENT_T2, intentId: intent.id }],
    });
  });

  test("cancel releases only after explicit authorization and the quiescence check", () => {
    const record = structuredClone(CANCELLATION_AUTHORIZED_FROZEN_LEDGER);
    const assignment = record.assignments.find((entry) => entry.assignmentId === ASSIGNMENT_T2);
    const decision = record.decisions[0];
    if (!assignment || !decision) throw new Error("missing cancellation fixture");
    assignment.turnId = "turn-7";
    const released = reduceRun(
      record,
      {
        kind: "cancellation-checked",
        taskId: "t2",
        decisionId: decision.decisionId,
        evidence: QUIESCENT_CANCELLATION,
      },
      facts,
    );
    expect(released.ok, JSON.stringify(released)).toBe(true);
    if (!released.ok) return;
    expect(taskOf(released.next, "t2").state).toBe("cancelled");
    expect(released.next.resources).toEqual([]);
  });

  test("blocked and failed reports retain the claim in a legal form", () => {
    for (const status of ["blocked", "failed"] as const) {
      let record = structuredClone(NORMAL_RUN_LEDGER);
      assertDispatchBaseline(record);
      record = reduceOrThrow(record, {
        kind: "turn-started",
        assignmentId: ASSIGNMENT_T2,
        agentId: "agent-b1",
        turnId: "turn-producer",
      });
      record = reduceOrThrow(record, { kind: "task-report", block: notDoneReport(status) });
      const task = taskOf(record, "t2");
      expect(task.state).toBe(status);
      expect(record.resources).toHaveLength(1);
      if (status === "blocked") expect(task.phase).toBe("frozen");
      expect(
        record.assignments.find((entry) => entry.assignmentId === ASSIGNMENT_T2)?.state,
      ).not.toBe("ended");
    }
  });

  test("a rejected review increments quality failures and enters rework after settlement", () => {
    let record = negativeReviewFlow();
    expect(taskOf(record, "t2")).toMatchObject({
      state: "review",
      phase: "awaiting-rework",
      qualityFailures: 1,
    });
    record = observeAndEndDispatch(record, "assignment-t2-r1");
    expect(taskOf(record, "t2")).toMatchObject({
      state: "rework",
      qualityFailures: 1,
    });
    expect(taskOf(record, "t2").phase).toBeUndefined();
  });

  test("a smoke report must come from the registered target and an independent smoker", () => {
    const valid = smokePhaseFlow();
    let done = reduceOrThrow(valid.record, { kind: "smoke-report", block: smokeBlock() });
    done = observeAndEndDispatch(done, valid.smokerId);
    expect(taskOf(done, "t2").state).toBe("done");

    const defaultHost = smokePhaseFlow();
    const defaultBefore = structuredClone(defaultHost.record);
    expect(
      reduceRun(
        defaultHost.record,
        {
          kind: "smoke-report",
          block: smokeBlock({ devHost: "127.0.0.1:6767" }),
        },
        facts,
      ),
    ).toMatchObject({
      ok: false,
      code: "RUN_EVENT_INVALID",
      path: ["smoke-report"],
      params: { reason: "invalid-smoke" },
    });
    expect(defaultHost.record).toEqual(defaultBefore);

    const extra = smokePhaseFlow();
    const extraBefore = structuredClone(extra.record);
    expect(
      reduceRun(
        extra.record,
        {
          kind: "smoke-report",
          block: smokeBlock({
            checks: [
              { id: "open runs", result: "pass", evidencePath: "evidence/smoke.png" },
              { id: "extra", result: "pass", evidencePath: "evidence/extra.png" },
            ],
          }),
        },
        facts,
      ),
    ).toMatchObject({
      ok: false,
      code: "RUN_EVENT_INVALID",
      path: ["smoke-report"],
      params: { reason: "invalid-smoke" },
    });
    expect(extra.record).toEqual(extraBefore);

    const self = smokePhaseFlow();
    const smoker = self.record.assignments.find((entry) => entry.assignmentId === self.smokerId);
    if (!smoker) throw new Error("smoker");
    smoker.agentId = "agent-b1";
    smoker.seatId = "seat-b1";
    const smokerNonce = self.record.nonceRegistry.find(
      (entry) => entry.assignmentId === self.smokerId,
    );
    if (!smokerNonce) throw new Error("smoke nonce");
    smokerNonce.agentId = "agent-b1";
    smokerNonce.seatId = "seat-b1";
    const smokerIntent = self.record.outbox.find((entry) => entry.assignmentId === self.smokerId);
    if (!smokerIntent) throw new Error("smoke intent");
    smokerIntent.recipient = "agent-b1";
    const selfSeat = self.record.roster.find((entry) => entry.seatId === "seat-b1");
    if (!selfSeat) throw new Error("self seat");
    selfSeat.duties = [...new Set([...selfSeat.duties, "smoke"])];
    const selfBefore = structuredClone(self.record);
    expect(
      reduceRun(self.record, { kind: "smoke-report", block: smokeBlock() }, facts),
    ).toMatchObject({
      ok: false,
      code: "RUN_EVENT_INVALID",
      path: ["smoke-report"],
      params: { reason: "invalid-smoke" },
    });
    expect(self.record).toEqual(selfBefore);
  });

  test("dispatch and turn events move ready to assigned to in_progress", () => {
    const nonce = "11111111-1111-4111-8111-111111111111";
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.resources = [];
    const task = taskOf(record, "t2");
    task.state = "ready";
    task.attempts = 0;
    task.currentAssignmentId = null;
    record.assignments = record.assignments.filter((entry) => entry.taskId !== "t2");
    record.nonceRegistry = record.nonceRegistry.filter((entry) => entry.taskId !== "t2");
    record.outbox = record.outbox.filter((entry) => entry.taskId !== "t2");
    assertDispatchBaseline(record);
    const nextAssignment = assignment({
      assignmentId: "assignment-t2-new",
      nonce,
      messageId: MESSAGE_T2,
    });
    let next = reduceOrThrow(record, {
      kind: "task-dispatched",
      reissueOfAssignmentId: null,
      taskId: "t2",
      assignment: nextAssignment,
      nonce: {
        nonce,
        runId: record.runId,
        taskId: "t2",
        assignmentId: "assignment-t2-new",
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
      intent: dispatchIntent({
        id: "intent-t2-new",
        assignmentId: "assignment-t2-new",
        messageId: MESSAGE_T2,
      }),
      claims: [
        claim({ claimId: "claim-t2-new", taskId: "t2", originAssignmentId: "assignment-t2-new" }),
      ],
    });
    expect(taskOf(next, "t2")).toMatchObject({
      state: "assigned",
      phase: "implementation",
    });
    next = reduceOrThrow(next, {
      kind: "turn-started",
      assignmentId: "assignment-t2-new",
      agentId: "agent-b1",
      turnId: "turn-new",
    });
    expect(taskOf(next, "t2").state).toBe("in_progress");
    next = reduceOrThrow(next, {
      kind: "observation-recorded",
      receipt: {
        eventKey: "agent-b1|turn-new|turn_ended",
        kind: "turn_ended",
        agentId: "agent-b1",
        turnId: "turn-new",
        seq: 0,
        receivedAt: AT_UPDATED,
        dedupeKey: "agent-b1|turn-new|turn_ended",
        disposition: "accepted",
      },
    });
    next = reduceOrThrow(next, {
      kind: "turn-ended",
      assignmentId: "assignment-t2-new",
      endedEventKey: "agent-b1|turn-new|turn_ended",
    });
    expect(
      next.assignments.find((entry) => entry.assignmentId === "assignment-t2-new")?.state,
    ).toBe("ended");
  });

  test("dag-accepted initializes readiness and rejects terminal spec changes", () => {
    const boot = structuredClone(NORMAL_RUN_LEDGER);
    boot.lifecycle = "bootstrapping";
    boot.tasks = [];
    boot.resources = [];
    boot.assignments = [];
    boot.nonceRegistry = [];
    boot.outbox = [];
    boot.decisions = [];
    const accepted = reduceRun(
      boot,
      {
        kind: "dag-accepted",
        block: {
          protocolVersion: 1,
          runId: boot.runId,
          taskId: "_dag",
          attempt: 1,
          nonce: NONCE_T2,
          dagRevision: 1,
          expectedDagRevision: 0,
          tasks: [spec("t1", "Fresh task")],
          cancelTaskIds: [],
          budgetRequests: [],
        },
      },
      facts,
    );
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(taskOf(accepted.next, "t1").state).toBe("ready");
    expect(accepted.next.lifecycle).toBe("active");

    const revised = reduceRun(
      structuredClone(NORMAL_RUN_LEDGER),
      {
        kind: "dag-revised",
        cancelIntents: [],
        preparedCancelIntents: [],
        controlNonceDigest: CONTROL_DIGEST,
        block: {
          protocolVersion: 1,
          runId: NORMAL_RUN_LEDGER.runId,
          taskId: "_dag",
          attempt: 1,
          nonce: NONCE_T2,
          dagRevision: NORMAL_RUN_LEDGER.dagRevision + 1,
          expectedDagRevision: NORMAL_RUN_LEDGER.dagRevision,
          tasks: [spec("t1", "Changed terminal task")],
          cancelTaskIds: [],
          budgetRequests: [],
        },
      },
      facts,
    );
    expect(revised).toMatchObject({
      ok: false,
      code: "RUN_INVALID_TRANSITION",
      params: { reason: "terminal-task-changed" },
    });
  });

  test("pause and resume preserve task state", () => {
    const paused = reduceRun(structuredClone(NORMAL_RUN_LEDGER), { kind: "run-paused" }, facts);
    expect(paused.ok).toBe(true);
    if (!paused.ok) return;
    expect(paused.next.lifecycle).toBe("paused");
    const resumed = reduceRun(paused.next, { kind: "run-resumed" }, facts);
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(resumed.next.lifecycle).toBe("active");
  });

  test("run-finished refuses unfinished tasks and accepts terminal state", () => {
    const refused = reduceRun(structuredClone(NORMAL_RUN_LEDGER), { kind: "run-finished" }, facts);
    expect(refused).toMatchObject({ ok: false, code: "RUN_INVALID_TRANSITION" });
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.tasks = [];
    record.resources = [];
    record.assignments = [];
    record.nonceRegistry = [];
    record.outbox = [];
    record.decisions = [];
    const result = reduceRun(record, { kind: "run-finished" }, facts);
    expect(result).toMatchObject({ ok: true });
  });
  test("I7 rejects a done task with no implementation evidence", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const producer = record.assignments.find(
      (entry) => entry.taskId === "t1" && entry.purpose === "member",
    );
    if (!producer) throw new Error("producer");
    producer.acceptedProof = null;
    const nonce = record.nonceRegistry.find(
      (entry) => entry.assignmentId === producer.assignmentId,
    );
    if (!nonce) throw new Error("producer nonce");
    nonce.acceptedAt = null;
    nonce.acceptedEventKey = null;
    const reportValue = checkLedgerInvariants(record);
    expect(reportValue.ok).toBe(false);
    if (!reportValue.ok) {
      expect(
        reportValue.violations.some(
          (entry) => entry.invariant === "I7" && entry.params.reason === "missing-delivery",
        ),
      ).toBe(true);
    }
  });

  test("an L4 task cannot be completed by a B reviewer", () => {
    let control = l4ReadyFlow();
    control = reduceOrThrow(control, { kind: "review-report", block: review() });
    control = observeAndEndDispatch(control, "assignment-t2-r1");
    expect(taskOf(control, "t2").state).toBe("done");

    const record = l4ReadyFlow();
    const reviewer = record.assignments.find((entry) => entry.assignmentId === "assignment-t2-r1");
    if (!reviewer) throw new Error("missing reviewer");
    reviewer.tier = "B";
    const reviewerSeat = record.roster.find((entry) => entry.seatId === reviewer.seatId);
    if (!reviewerSeat) throw new Error("missing reviewer seat");
    reviewerSeat.tier = "B";
    const before = structuredClone(record);
    const result = reduceRun(record, { kind: "review-report", block: review() }, facts);
    expect(result).toMatchObject({
      ok: false,
      code: "RUN_EVENT_INVALID",
      path: ["review-report", "t2"],
      params: { reason: "no-valid-review" },
    });
    expect(record).toEqual(before);
    expect(taskOf(record, "t2").state).toBe("review");
  });

  test("invalid cancellation evidence never releases a frozen claim", () => {
    const record = structuredClone(CANCELLATION_AUTHORIZED_FROZEN_LEDGER);
    assertDispatchBaseline(record);
    const assignment = record.assignments.find((entry) => entry.assignmentId === ASSIGNMENT_T2);
    const decision = record.decisions[0];
    if (!assignment || !decision) throw new Error("missing cancellation fixture");
    const badEvidence = {
      ...QUIESCENT_CANCELLATION,
      refresh: { ...QUIESCENT_CANCELLATION.refresh, activeTurn: true },
      receipt: { kind: "none" as const, confirmedAt: AT_UPDATED, externalId: null },
    };
    const result = reduceRun(
      record,
      {
        kind: "cancellation-checked",
        taskId: "t2",
        decisionId: decision.decisionId,
        evidence: badEvidence,
      },
      facts,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(taskOf(result.next, "t2").state).toBe("blocked");
      expect(result.next.resources[0]?.frozen).toBe(true);
      const nextAssignment = result.next.assignments.find(
        (entry) => entry.assignmentId === ASSIGNMENT_T2,
      );
      expect(nextAssignment?.cancellation).toBeNull();
      expect(result.next.decisions[0]?.state).toBe("answered");
    }
  });

  test("a frozen in-flight task still occupies the concurrency slot", () => {
    const record = frozenNormal();
    ensureDispatchSeat(record);
    record.policy = { ...record.policy, configuredConcurrency: 1 };
    const t3 = taskOf(record, "t3");
    t3.state = "ready";
    t3.spec = { ...t3.spec, deps: [] };
    const nonce = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const messageId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const t3Assignment = assignment({
      assignmentId: "assignment-t3-a1",
      taskId: "t3",
      seatId: "seat-b7",
      agentId: "agent-b7",
      nonce,
      messageId,
    });
    assertDispatchBaseline(record);
    const event = {
      kind: "task-dispatched" as const,
      reissueOfAssignmentId: null,
      taskId: "t3",
      assignment: t3Assignment,
      nonce: {
        nonce,
        runId: record.runId,
        taskId: "t3",
        assignmentId: t3Assignment.assignmentId,
        attempt: 1,
        phase: "implementation" as const,
        agentId: t3Assignment.agentId,
        seatId: t3Assignment.seatId,
        issuedAt: AT_UPDATED,
        acceptedAt: null,
        acceptedEventKey: null,
        revokedAt: null,
        revokeReason: null,
      },
      intent: dispatchIntent({
        id: "intent-t3-a1",
        taskId: "t3",
        assignmentId: t3Assignment.assignmentId,
        recipient: t3Assignment.agentId,
        messageId,
        idempotencyKey: "dispatch-t3-a1",
      }),
      claims: [
        claim({
          claimId: "claim-t3-slot",
          taskId: "t3",
          originAssignmentId: t3Assignment.assignmentId,
          path: "src/t3.ts",
        }),
      ],
    };
    expect(reduceRun(record, event, facts)).toMatchObject({
      ok: false,
      params: { reason: "capacity" },
    });
    const relaxed = structuredClone(record);
    relaxed.policy = { ...relaxed.policy, configuredConcurrency: 2 };
    assertDispatchBaseline(relaxed);
    const accepted = reduceRun(relaxed, event, facts);
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    if (accepted.ok) {
      expect(taskOf(accepted.next, "t3")).toMatchObject({
        state: "assigned",
        phase: "implementation",
      });
    }
  });

  test("I3 rejects directory coverage, write/read overlap and failed claims", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.resources = [
      claim({
        claimId: "claim-dir",
        taskId: "t2",
        kind: "directory",
        path: "src",
        access: "write",
      }),
      claim({
        claimId: "claim-file",
        taskId: "t3",
        kind: "file",
        path: "src/t3.ts",
        access: "write",
      }),
    ];
    const t3 = taskOf(record, "t3");
    t3.state = "in_progress";
    t3.currentAssignmentId = null;
    const overlap = checkLedgerInvariants(record);
    expect(overlap.ok).toBe(false);
    if (!overlap.ok) {
      expect(overlap.violations.some((entry) => entry.invariant === "I3")).toBe(true);
    }
    const failed = structuredClone(record);
    const failedTask = taskOf(failed, "t2");
    failedTask.state = "failed";
    failedTask.phase = undefined;
    const reportValue = checkLedgerInvariants(failed);
    expect(reportValue.ok).toBe(false);
  });

  test("checkpoint event numbering and new-event validation are enforced", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.events = [{ seq: 1, kind: "run_created", at: AT_UPDATED, payload: {} }];
    record.counters.eventsThroughSeq = 0;
    const reportValue = checkLedgerInvariants(record);
    expect(reportValue.ok).toBe(false);
    const paused = reduceRun(record, { kind: "run-paused" }, facts);
    expect(paused.ok).toBe(false);
  });

  test("active tasks with unfinished dependencies violate I2", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const t3 = taskOf(record, "t3");
    t3.state = "assigned";
    t3.currentAssignmentId = null;
    const reportValue = checkLedgerInvariants(record);
    expect(reportValue.ok).toBe(false);
    if (!reportValue.ok) {
      expect(reportValue.violations.some((entry) => entry.invariant === "I2")).toBe(true);
    }
  });

  test("dag-revised freezes active specs and requires +1 revision", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const changed = reduceRun(
      record,
      {
        kind: "dag-revised",
        cancelIntents: [],
        preparedCancelIntents: [],
        controlNonceDigest: CONTROL_DIGEST,
        block: {
          protocolVersion: 1,
          runId: record.runId,
          taskId: "_dag",
          attempt: 1,
          nonce: NONCE_T2,
          dagRevision: record.dagRevision + 1,
          expectedDagRevision: record.dagRevision,
          tasks: [spec("t2", "Changed in-flight task")],
          cancelTaskIds: [],
          budgetRequests: [],
        },
      },
      facts,
    );
    expect(changed).toMatchObject({
      ok: false,
      params: { reason: "active-task-changed" },
    });
    const jumped = reduceRun(
      record,
      {
        kind: "dag-revised",
        cancelIntents: [],
        preparedCancelIntents: [],
        controlNonceDigest: CONTROL_DIGEST,
        block: {
          protocolVersion: 1,
          runId: record.runId,
          taskId: "_dag",
          attempt: 1,
          nonce: NONCE_T2,
          dagRevision: record.dagRevision + 2,
          expectedDagRevision: record.dagRevision,
          tasks: [spec("t1", "Core API surface")],
          cancelTaskIds: [],
          budgetRequests: [],
        },
      },
      facts,
    );
    expect(jumped).toMatchObject({ ok: false, params: { reason: "stale-dag" } });
  });

  test("I5 rejects a revoked producer nonce and I8 rejects an unrelated intent", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const nonce = record.nonceRegistry.find((entry) => entry.assignmentId === ASSIGNMENT_T2);
    if (!nonce) throw new Error("missing nonce");
    nonce.revokedAt = AT_UPDATED;
    expect(reduceRun(record, { kind: "task-report", block: report() }, facts)).toMatchObject({
      ok: false,
      code: "RUN_INVARIANT_VIOLATION",
      params: { reason: "revoked-nonce-active" },
    });
    const badIntent = structuredClone(NORMAL_RUN_LEDGER);
    const intent = badIntent.outbox.find((entry) => entry.assignmentId === ASSIGNMENT_T2);
    if (intent) intent.recipient = "agent-other";
    const reportValue = checkLedgerInvariants(badIntent);
    expect(reportValue.ok).toBe(false);
    if (!reportValue.ok) {
      expect(reportValue.violations.some((entry) => entry.invariant === "I8")).toBe(true);
    }
  });

  test("paused runs cannot dispatch and malformed reviews do not throw", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    ensureDispatchSeat(record);
    record.lifecycle = "paused";
    const t3 = taskOf(record, "t3");
    t3.state = "ready";
    t3.attempts = 0;
    t3.spec = { ...t3.spec, deps: [] };
    const nonce = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const result = reduceRun(
      record,
      {
        kind: "task-dispatched",
        reissueOfAssignmentId: null,
        taskId: "t3",
        assignment: assignment({
          assignmentId: "assignment-t3-paused",
          seatId: "seat-b7",
          agentId: "agent-b7",
          nonce,
          taskId: "t3",
          messageId: MESSAGE_T2,
        }),
        nonce: {
          nonce,
          runId: record.runId,
          taskId: "t3",
          assignmentId: "assignment-t3-paused",
          attempt: 1,
          phase: "implementation",
          agentId: "agent-b7",
          seatId: "seat-b7",
          issuedAt: AT_UPDATED,
          acceptedAt: null,
          acceptedEventKey: null,
          revokedAt: null,
          revokeReason: null,
        },
        intent: dispatchIntent({
          id: "intent-t3-paused",
          assignmentId: "assignment-t3-paused",
          taskId: "t3",
          recipient: "agent-b7",
          messageId: MESSAGE_T2,
        }),
      },
      facts,
    );
    expect(result).toMatchObject({
      ok: false,
      code: "RUN_INVALID_TRANSITION",
      path: ["tasks", "t3", "state"],
      params: { reason: "illegal-transition" },
    });

    const reviewRecord = reviewReadyFlow();
    const malformed = { ...review(), verdict: "invalid" } as never;
    let malformedResult: ReturnType<typeof reduceRun> | undefined;
    expect(() => {
      malformedResult = reduceRun(reviewRecord, { kind: "review-report", block: malformed }, facts);
    }).not.toThrow();
    expect(malformedResult).toMatchObject({
      ok: false,
      code: "RUN_EVENT_INVALID",
    });
  });
  test("control digests are required and persisted on created decisions", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    assertDispatchBaseline(record);
    const intent = archiveIntent();
    const missing = reduceRun(record, cancelEvent(intent, ["t2"], "not-a-digest"), facts);
    expect(missing).toMatchObject({ ok: false, params: { reason: "invalid-digest" } });
    const valid = reduceOrThrow(record, cancelEvent(intent));
    expect(valid.decisions[0]?.controlNonceDigest).toBe(CONTROL_DIGEST);
    expect(valid.decisions[0]?.cancelIntents).toEqual([
      { assignmentId: ASSIGNMENT_T2, intentId: intent.id },
    ]);
  });

  const decisionCases: Array<[string, (decision: RunRecord["decisions"][number]) => void]> = [
    [
      "wrong subject",
      (decision) => {
        decision.subjectId = "t3";
        decision.dedupeKey = "other";
        decision.cancelIntents = null;
      },
    ],
    [
      "wrong category",
      (decision) => {
        decision.category = "D7";
        decision.cancelIntents = null;
      },
    ],
  ];
  test.each(decisionCases)("cancellation-checked rejects a decision with %s", (_label, mutate) => {
    const record = structuredClone(CANCELLATION_AUTHORIZED_FROZEN_LEDGER);
    assertDispatchBaseline(record);
    const decision = record.decisions[0];
    const assignment = record.assignments.find((entry) => entry.assignmentId === ASSIGNMENT_T2);
    if (!decision || !assignment) throw new Error("missing cancellation fixture");
    mutate(decision);
    assignment.cancellation = null;
    const result = reduceRun(
      record,
      {
        kind: "cancellation-checked",
        taskId: "t2",
        decisionId: decision.decisionId,
        evidence: QUIESCENT_CANCELLATION,
      },
      facts,
    );
    expect(result).toMatchObject({
      ok: false,
      code: "RUN_EVENT_INVALID",
      params: { reason: "pair-binding" },
    });
    expect(taskOf(record, "t2").state).toBe("blocked");
    expect(record.resources[0]?.frozen).toBe(true);
  });

  test("I3 treats hot/tool names exactly and rejects failed unfrozen claims", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.resources = [
      claim({ claimId: "hot-a", taskId: "t2", kind: "hot", path: "repo:hot", access: "write" }),
      claim({ claimId: "hot-b", taskId: "t3", kind: "hot", path: "repo:hot", access: "write" }),
    ];
    const t3 = taskOf(record, "t3");
    t3.state = "assigned";
    const reportValue = checkLedgerInvariants(record);
    expect(reportValue.ok).toBe(false);
    if (!reportValue.ok) {
      expect(
        reportValue.violations.some(
          (entry) => entry.invariant === "I3" && entry.params.reason === "overlapping-claim",
        ),
      ).toBe(true);
    }
    const failed = structuredClone(NORMAL_RUN_LEDGER);
    const task = taskOf(failed, "t2");
    task.state = "failed";
    task.phase = undefined;
    const failures = checkLedgerInvariants(failed);
    expect(failures.ok).toBe(false);
    if (!failures.ok) {
      expect(
        failures.violations.some(
          (entry) => entry.invariant === "I3" && entry.params.reason === "failed-unfrozen-claim",
        ),
      ).toBe(true);
    }
  });
  test("a later observed turn_started keeps cancellation frozen", () => {
    const record = structuredClone(CANCELLATION_AUTHORIZED_FROZEN_LEDGER);
    assertDispatchBaseline(record);
    const decision = record.decisions[0];
    const assignment = record.assignments.find((entry) => entry.assignmentId === ASSIGNMENT_T2);
    if (!decision || !assignment) throw new Error("missing cancellation fixture");
    // Remove the stale proof so the observation itself is a valid transition; the later
    // turn_started must still prevent the cancellation-checked release.
    assignment.cancellation = null;
    assertDispatchBaseline(record);
    const observedResult = reduceRun(
      record,
      {
        kind: "observation-recorded",
        receipt: {
          eventKey: "agent-b1|later-turn|turn_started",
          kind: "turn_started",
          agentId: "agent-b1",
          turnId: "later-turn",
          seq: 1,
          receivedAt: AT_UPDATED,
          dedupeKey: "agent-b1|later-turn|turn_started",
          disposition: "observed",
        },
      },
      facts,
    );
    expect(observedResult.ok, JSON.stringify(observedResult)).toBe(true);
    if (!observedResult.ok) return;
    const observed = observedResult.next;
    expect(observed.eventReceipts.at(-1)?.seq).toBe(record.counters.observationSeq + 1);
    const checked = reduceRun(
      observed,
      {
        kind: "cancellation-checked",
        taskId: "t2",
        decisionId: decision.decisionId,
        evidence: { ...QUIESCENT_CANCELLATION, observationSeq: 8 },
      },
      facts,
    );
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(taskOf(checked.next, "t2").state).toBe("blocked");
      expect(checked.next.resources).toEqual(record.resources);
    }
  });

  test("a never-started assignment stays frozen without a matching ended turn", () => {
    const frozen = frozenNormal();
    const decision = frozen.decisions[0];
    if (!decision) throw new Error("missing decision");
    const evidence = {
      ...QUIESCENT_CANCELLATION,
      lastTurnId: null,
      endedEventKey: null,
    };
    const checked = reduceRun(
      frozen,
      { kind: "cancellation-checked", taskId: "t2", decisionId: decision.decisionId, evidence },
      facts,
    );
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(taskOf(checked.next, "t2").state).toBe("blocked");
      expect(checked.next.resources[0]?.frozen).toBe(true);
    }
  });

  test("a prepared never-sent assignment can be locally withdrawn without fake archive evidence", () => {
    function freshPrepared() {
      const record = structuredClone(NORMAL_RUN_LEDGER);
      record.lifecycle = "active";
      record.tasks = [
        taskRecord(spec("t2", "Prepared task"), {
          state: "assigned",
          phase: "implementation",
          currentAssignmentId: ASSIGNMENT_T2,
          attempts: 1,
        }),
      ];
      record.resources = [
        claim({
          claimId: "claim-t2-reservation",
          taskId: "t2",
          originAssignmentId: ASSIGNMENT_T2,
          path: "src/t2.ts",
        }),
      ];
      record.assignments = [
        assignment({
          assignmentId: ASSIGNMENT_T2,
          taskId: "t2",
          nonce: NONCE_T2,
          messageId: MESSAGE_T2,
          state: "assigned",
          turnId: null,
          startedAt: null,
          endedAt: null,
          acceptedProof: null,
        }),
      ];
      record.nonceRegistry = [
        {
          nonce: NONCE_T2,
          runId: record.runId,
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
      ];
      record.outbox = [
        dispatchIntent({
          id: "intent-t2-prepared",
          taskId: "t2",
          assignmentId: ASSIGNMENT_T2,
          recipient: "agent-b1",
          messageId: MESSAGE_T2,
          idempotencyKey: "dispatch-t2-prepared",
          state: "prepared",
          confirmedAt: null,
          recoverySendCount: 0,
          localCancellation: null,
        }),
      ];
      record.decisions = [];
      record.events = [];
      record.eventReceipts = [];
      record.reopenGrants = [];
      record.checkpoint = undefined;
      record.counters = { ...record.counters, eventsThroughSeq: 0, observationSeq: 0 };
      return record;
    }

    const record = freshPrepared();
    assertDispatchBaseline(record);
    const prepared = record.outbox[0];
    expect(prepared).toMatchObject({
      state: "prepared",
      confirmedAt: null,
      recoverySendCount: 0,
      localCancellation: null,
    });
    expect(record.assignments[0]).toMatchObject({
      turnId: null,
      startedAt: null,
      endedAt: null,
      endedEventKey: null,
      acceptedProof: null,
    });
    expect(record.nonceRegistry[0]).toMatchObject({
      acceptedAt: null,
      acceptedEventKey: null,
      revokedAt: null,
    });
    expect(record.eventReceipts).toEqual([]);

    const next = reduceOrThrow(record, {
      kind: "cancel-requested",
      taskIds: ["t2"],
      reason: "cancel-before-send",
      cancelIntents: [],
      preparedCancelIntents: [],
      controlNonceDigest: CONTROL_DIGEST,
    });
    expect(taskOf(next, "t2").state).toBe("cancelled");
    expect(next.resources).toEqual([]);
    expect(next.outbox[0]).toMatchObject({
      state: "failed",
      localCancellation: {
        reason: "cancel-before-send",
        cause: "cancel-requested",
      },
    });
    expect(next.nonceRegistry[0]).toMatchObject({
      revokedAt: AT_UPDATED,
      revokeReason: "cancel-before-send",
    });
    expect(next.eventReceipts).toEqual([]);
    expect(next.assignments[0]).toMatchObject({
      state: "cancelled",
      endedEventKey: null,
    });

    const confirmed = freshPrepared();
    const sent = confirmed.outbox[0];
    sent.state = "confirmed";
    sent.confirmedAt = AT_UPDATED;
    sent.recoverySendCount = 1;
    assertDispatchBaseline(confirmed);
    const before = structuredClone(confirmed);
    expect(
      reduceRun(
        confirmed,
        {
          kind: "cancel-requested",
          taskIds: ["t2"],
          reason: "cancel-before-send",
          cancelIntents: [],
          preparedCancelIntents: [],
          controlNonceDigest: CONTROL_DIGEST,
        },
        facts,
      ),
    ).toMatchObject({
      ok: false,
      code: "RUN_EVENT_INVALID",
      path: ["cancel", "cancelIntents"],
      params: { reason: "incomplete-coverage" },
    });
    expect(confirmed).toEqual(before);
  });

  test("dag-revised cancels an unstarted pending task without D1", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const result = reduceRun(
      record,
      {
        kind: "dag-revised",
        cancelIntents: [],
        preparedCancelIntents: [],
        controlNonceDigest: CONTROL_DIGEST,
        block: {
          protocolVersion: 1,
          runId: record.runId,
          taskId: "_dag",
          attempt: 1,
          nonce: NONCE_T2,
          dagRevision: record.dagRevision + 1,
          expectedDagRevision: record.dagRevision,
          tasks: [
            spec("t1", "Core API surface"),
            spec("t2", "Core implementation"),
            spec("t3", "Operator docs", { group: "docs", deps: ["t2"] }),
          ],
          cancelTaskIds: ["t3"],
          budgetRequests: [],
        },
      },
      facts,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(taskOf(result.next, "t3").state).toBe("cancelled");
    expect(result.next.decisions).toHaveLength(0);
  });

  test("a smoke-phase blocking review prevents done", () => {
    let record = smokePhaseFlow().record;
    record = dispatchReviewer(record, {
      id: "assignment-t2-r2",
      seatId: "seat-b4",
      agentId: "agent-b4",
      nonce: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    });
    record = reduceOrThrow(record, {
      kind: "turn-started",
      assignmentId: "assignment-t2-r2",
      agentId: "agent-b4",
      turnId: "turn-review-2",
    });
    record = reduceOrThrow(record, {
      kind: "review-report",
      block: review({
        assignmentId: "assignment-t2-r2",
        nonce: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        verdict: "不可合入",
        blockers: [{ id: "B-1", summary: "blocking", path: "src/t2.ts" }],
      }),
    });
    expect(taskOf(record, "t2")).toMatchObject({ qualityFailures: 1 });
    expect(taskOf(record, "t2").state).not.toBe("done");
    record = observeAndEndDispatch(record, "assignment-t2-r2");
    expect(taskOf(record, "t2").state).not.toBe("done");
  });

  test("a multi-task cancel request is rejected instead of half-binding one intent", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    ensureDispatchSeat(record);
    const t3 = taskOf(record, "t3");
    t3.state = "in_progress";
    t3.phase = "implementation";
    t3.currentAssignmentId = "assignment-t3-a1";
    t3.attempts = 1;
    t3.spec = { ...t3.spec, deps: [] };
    const t3Nonce = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const t3Message = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    record.assignments.push(
      assignment({
        assignmentId: "assignment-t3-a1",
        taskId: "t3",
        seatId: "seat-b7",
        agentId: "agent-b7",
        nonce: t3Nonce,
        messageId: t3Message,
      }),
    );
    record.nonceRegistry.push({
      nonce: t3Nonce,
      runId: record.runId,
      taskId: "t3",
      assignmentId: "assignment-t3-a1",
      attempt: 1,
      phase: "implementation",
      agentId: "agent-b7",
      seatId: "seat-b7",
      issuedAt: AT_UPDATED,
      acceptedAt: null,
      acceptedEventKey: null,
      revokedAt: null,
      revokeReason: null,
    });
    record.outbox.push(
      dispatchIntent({
        id: "intent-t3-a1",
        taskId: "t3",
        assignmentId: "assignment-t3-a1",
        recipient: "agent-b7",
        messageId: t3Message,
        idempotencyKey: "dispatch-t3-a1",
      }),
    );
    record.resources.push(
      claim({
        claimId: "claim-t3",
        taskId: "t3",
        originAssignmentId: "assignment-t3-a1",
        path: "src/t3.ts",
      }),
    );
    assertDispatchBaseline(record);
    const t2Intent = archiveIntent();
    const t3Intent = archiveIntent({
      id: "intent-cancel-t3",
      taskId: "t3",
      assignmentId: "assignment-t3-a1",
      recipient: "agent-b7",
      idempotencyKey: "cancel-t3-1",
    });
    const single = reduceRun(record, cancelEvent(t2Intent), facts);
    expect(single).toMatchObject({ ok: true });
    const before = structuredClone(record);
    const multi = reduceRun(
      record,
      {
        kind: "cancel-requested",
        // The internal tuple is single-task; this negative probe deliberately supplies two.
        taskIds: ["t2", "t3"] as unknown as [string],
        reason: "cancel",
        cancelIntents: [
          { assignmentId: t2Intent.assignmentId, intentId: t2Intent.id },
          { assignmentId: t3Intent.assignmentId, intentId: t3Intent.id },
        ],
        preparedCancelIntents: [t2Intent, t3Intent],
        controlNonceDigest: CONTROL_DIGEST,
      },
      facts,
    );
    expect(multi).toMatchObject({
      ok: false,
      code: "RUN_EVENT_INVALID",
      path: ["cancel", "taskIds"],
      params: { reason: "single-task-required" },
    });
    expect(record).toEqual(before);
    expect(taskOf(record, "t3")).toMatchObject({
      state: "in_progress",
      currentAssignmentId: "assignment-t3-a1",
    });
    expect(record.outbox.some((entry) => entry.id === "intent-cancel-t3")).toBe(false);
    expect(record.decisions).toEqual([]);
  });

  test("dispatch accepts hot/tool claims and rejects read-scope and uncovered write scopes", () => {
    const base = structuredClone(NORMAL_RUN_LEDGER);
    ensureDispatchSeat(base);
    const t3 = taskOf(base, "t3");
    t3.state = "ready";
    t3.attempts = 0;
    t3.spec = {
      ...t3.spec,
      deps: [],
      scopes: [
        { repoId: "repo-re-verify", kind: "file", path: "src/t3.ts", access: "write" },
        { repoId: "repo-re-verify", kind: "file", path: "src/t3b.ts", access: "write" },
      ],
    };
    assertDispatchBaseline(base);
    const nonce = "abcdabcd-abcd-4abc-8abc-abcdabcdabcd";
    const dispatch = (claims: ReturnType<typeof claim>[]) =>
      reduceRun(
        base,
        {
          kind: "task-dispatched",
          reissueOfAssignmentId: null,
          taskId: "t3",
          assignment: assignment({
            assignmentId: "assignment-t3-a1",
            taskId: "t3",
            seatId: "seat-b7",
            agentId: "agent-b7",
            nonce,
            messageId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          }),
          nonce: {
            nonce,
            runId: base.runId,
            taskId: "t3",
            assignmentId: "assignment-t3-a1",
            attempt: 1,
            phase: "implementation",
            agentId: "agent-b7",
            seatId: "seat-b7",
            issuedAt: AT_UPDATED,
            acceptedAt: null,
            acceptedEventKey: null,
            revokedAt: null,
            revokeReason: null,
          },
          intent: dispatchIntent({
            id: "intent-t3-a1",
            taskId: "t3",
            assignmentId: "assignment-t3-a1",
            recipient: "agent-b7",
            messageId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          }),
          claims,
        },
        facts,
      );
    const hot = dispatch([
      claim({
        claimId: "t3-file",
        taskId: "t3",
        originAssignmentId: "assignment-t3-a1",
        path: "src/t3.ts",
      }),
      claim({
        claimId: "t3-file-b",
        taskId: "t3",
        originAssignmentId: "assignment-t3-a1",
        path: "src/t3b.ts",
      }),
      claim({
        claimId: "t3-hot",
        taskId: "t3",
        originAssignmentId: "assignment-t3-a1",
        kind: "hot",
        path: "repo:hot",
        access: "write",
      }),
    ]);
    expect(hot.ok).toBe(true);
    if (hot.ok) expect(hot.next.resources.some((entry) => entry.claimId === "t3-hot")).toBe(true);
    expect(
      dispatch([
        claim({
          claimId: "t3-file",
          taskId: "t3",
          originAssignmentId: "assignment-t3-a1",
          path: "src/t3.ts",
        }),
      ]),
    ).toMatchObject({
      ok: false,
      code: "RUN_EVENT_INVALID",
      path: ["claims"],
      params: { reason: "scope-not-covered" },
    });

    const read = structuredClone(base);
    ensureDispatchSeat(read);
    const readTask = taskOf(read, "t3");
    readTask.state = "ready";
    readTask.attempts = 0;
    readTask.spec = {
      ...readTask.spec,
      scopes: [{ repoId: "repo-re-verify", kind: "directory", path: "docs", access: "read" }],
    };
    const readResult = reduceRun(
      read,
      {
        kind: "task-dispatched",
        reissueOfAssignmentId: null,
        taskId: "t3",
        assignment: assignment({
          assignmentId: "assignment-t3-read",
          taskId: "t3",
          seatId: "seat-b7",
          agentId: "agent-b7",
          nonce: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          messageId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        }),
        nonce: {
          nonce: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          runId: read.runId,
          taskId: "t3",
          assignmentId: "assignment-t3-read",
          attempt: 1,
          phase: "implementation",
          agentId: "agent-b7",
          seatId: "seat-b7",
          issuedAt: AT_UPDATED,
          acceptedAt: null,
          acceptedEventKey: null,
          revokedAt: null,
          revokeReason: null,
        },
        intent: dispatchIntent({
          id: "intent-t3-read",
          taskId: "t3",
          assignmentId: "assignment-t3-read",
          recipient: "agent-b7",
          messageId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        }),
        claims: [
          claim({
            claimId: "t3-read",
            taskId: "t3",
            originAssignmentId: "assignment-t3-read",
            path: "docs/x",
            access: "write",
          }),
        ],
      },
      facts,
    );
    expect(readResult).toMatchObject({ ok: false, params: { reason: "claim-not-in-scope" } });
  });

  test("dispatch rejects a write claim on a read-only scope", () => {
    const base = structuredClone(NORMAL_RUN_LEDGER);
    ensureDispatchSeat(base);
    const t3 = taskOf(base, "t3");
    t3.state = "ready";
    t3.attempts = 0;
    t3.spec = {
      ...t3.spec,
      deps: [],
      scopes: [{ repoId: "repo-re-verify", kind: "directory", path: "docs", access: "read" }],
    };
    assertDispatchBaseline(base);
    const nonce = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const result = reduceRun(
      base,
      {
        kind: "task-dispatched",
        reissueOfAssignmentId: null,
        taskId: "t3",
        assignment: assignment({
          assignmentId: "assignment-t3-read",
          taskId: "t3",
          seatId: "seat-b7",
          agentId: "agent-b7",
          nonce,
          messageId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        }),
        nonce: {
          nonce,
          runId: base.runId,
          taskId: "t3",
          assignmentId: "assignment-t3-read",
          attempt: 1,
          phase: "implementation",
          agentId: "agent-b7",
          seatId: "seat-b7",
          issuedAt: AT_UPDATED,
          acceptedAt: null,
          acceptedEventKey: null,
          revokedAt: null,
          revokeReason: null,
        },
        intent: dispatchIntent({
          id: "intent-t3-read",
          taskId: "t3",
          assignmentId: "assignment-t3-read",
          recipient: "agent-b7",
          messageId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        }),
        claims: [
          claim({
            claimId: "t3-read",
            taskId: "t3",
            originAssignmentId: "assignment-t3-read",
            path: "docs/x",
            access: "write",
          }),
        ],
      },
      facts,
    );
    expect(result).toMatchObject({ ok: false, params: { reason: "claim-not-in-scope" } });
  });

  test("live reviewer nonce revoked by archive cancellation rejects at the closed window", () => {
    let record = structuredClone(NORMAL_RUN_LEDGER);
    assertDispatchBaseline(record);
    record = reduceOrThrow(record, {
      kind: "turn-started",
      assignmentId: ASSIGNMENT_T2,
      agentId: "agent-b1",
      turnId: "turn-producer",
    });
    record = reduceOrThrow(record, { kind: "task-report", block: report() });
    record = observeAndEndDispatch(record, ASSIGNMENT_T2);
    record = dispatchReviewerViaEvent(record);
    const intent = archiveIntent({
      id: "intent-cancel-reviewer",
      assignmentId: "assignment-t2-r1",
      recipient: "agent-b2",
      idempotencyKey: "cancel-reviewer-1",
    });
    record = reduceOrThrow(record, cancelEvent(intent));
    const task = taskOf(record, "t2");
    expect(task).toMatchObject({ state: "blocked", phase: "frozen" });
    const reviewerNonce = record.nonceRegistry.find(
      (entry) => entry.assignmentId === "assignment-t2-r1",
    );
    expect(reviewerNonce?.revokedAt).not.toBeNull();
    expect(reviewerNonce?.revokeReason).toBe("cancel-requested");

    const before = structuredClone(record);
    const result = reduceRun(record, { kind: "review-report", block: review() }, facts);
    expect(result).toMatchObject({
      ok: false,
      code: "RUN_INVALID_TRANSITION",
      path: ["tasks", "t2", "state"],
      params: { reason: "illegal-transition" },
    });
    expect(record).toEqual(before);
    const second = reduceRun(
      record,
      {
        kind: "review-report",
        block: review({ reviewedRef: { kind: "git-commit", value: "ref-new" } }),
      },
      facts,
    );
    expect(second).toMatchObject({ ok: false, code: "RUN_INVALID_TRANSITION" });
    expect(record).toEqual(before);
  });

  test("I5 rejects a stored revoked nonce while its assignment is current", () => {
    let record = structuredClone(NORMAL_RUN_LEDGER);
    assertDispatchBaseline(record);
    record = reduceOrThrow(record, { kind: "task-report", block: report() });
    record = dispatchReviewerViaEvent(record);
    const reviewerNonce = record.nonceRegistry.find(
      (entry) => entry.assignmentId === "assignment-t2-r1",
    );
    if (!reviewerNonce) throw new Error("review nonce");
    reviewerNonce.revokedAt = AT_UPDATED;
    const result = reduceRun(record, { kind: "review-report", block: review() }, facts);
    expect(result).toMatchObject({
      ok: false,
      code: "RUN_INVARIANT_VIOLATION",
      params: { reason: "revoked-nonce-active" },
    });
  });

  test("negative review keeps the reviewer awaiting with its claim and slot", () => {
    const record = negativeReviewFlow();
    const task = taskOf(record, "t2");
    expect(task).toMatchObject({
      state: "review",
      phase: "awaiting-rework",
      qualityFailures: 1,
    });
    expect(record.resources.filter((entry) => entry.taskId === "t2")).toHaveLength(1);
    expect(occupiesExecutionSlot(record, task)).toBe(false);
  });

  test("settled rework reuses claims and retained proofs before attempt two", () => {
    let record = negativeReviewFlow();
    record = observeAndEndDispatch(record, "assignment-t2-r1");
    const task = taskOf(record, "t2");
    expect(task).toMatchObject({ state: "rework", qualityFailures: 1 });
    expect(task.phase).toBeUndefined();
    const retainedClaims = record.resources
      .filter((entry) => entry.taskId === "t2")
      .map((entry) => ({
        claimId: entry.claimId,
        originAssignmentId: entry.originAssignmentId,
      }));
    expect(retainedClaims).toHaveLength(1);
    const retainedProofs = structuredClone(
      record.assignments
        .filter((entry) => entry.acceptedProof !== null)
        .map((entry) => ({ assignmentId: entry.assignmentId, proof: entry.acceptedProof })),
    );
    assertDispatchBaseline(record);
    const nonce = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const result = reduceRun(
      record,
      {
        kind: "task-dispatched",
        reissueOfAssignmentId: null,
        taskId: "t2",
        assignment: assignment({
          assignmentId: "assignment-t2-r2",
          taskId: "t2",
          attempt: 2,
          nonce,
          messageId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        }),
        nonce: {
          nonce,
          runId: record.runId,
          taskId: "t2",
          assignmentId: "assignment-t2-r2",
          attempt: 2,
          phase: "implementation",
          agentId: "agent-b1",
          seatId: "seat-b1",
          issuedAt: AT_UPDATED,
          acceptedAt: null,
          acceptedEventKey: null,
          revokedAt: null,
          revokeReason: null,
        },
        intent: dispatchIntent({
          id: "intent-t2-r2",
          taskId: "t2",
          assignmentId: "assignment-t2-r2",
          messageId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        }),
      },
      facts,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    record = result.next;
    record = reduceOrThrow(record, {
      kind: "turn-started",
      assignmentId: "assignment-t2-r2",
      agentId: "agent-b1",
      turnId: "turn-producer-2",
    });
    const second = record.assignments.find((entry) => entry.assignmentId === "assignment-t2-r2");
    if (!second?.workspace) throw new Error("missing second assignment");
    const secondRef = { kind: "git-commit" as const, value: "ref-r2" };
    const secondReport = report({
      assignmentId: second.assignmentId,
      attempt: 2,
      nonce,
      messageId: second.messageId,
      workspace: second.workspace,
      ref: secondRef,
      evidence: [{ ...report().evidence[0], ref: secondRef }],
    });
    const eventsBeforeReport = record.events.length;
    record = reduceOrThrow(record, { kind: "task-report", block: secondReport });
    expect(record.events.length).toBeGreaterThan(eventsBeforeReport);
    const acceptedSecond = record.assignments.find(
      (entry) => entry.assignmentId === second.assignmentId,
    );
    expect(acceptedSecond?.acceptedProof).toMatchObject({
      assignmentId: second.assignmentId,
      attempt: 2,
      nonce,
      messageId: second.messageId,
    });
    const acceptedNonce = record.nonceRegistry.find(
      (entry) => entry.assignmentId === second.assignmentId,
    );
    expect(acceptedNonce?.acceptedAt).not.toBeNull();
    expect(acceptedNonce?.acceptedEventKey).not.toBeNull();
    record = observeAndEndDispatch(record, second.assignmentId);
    expect(
      record.resources
        .filter((entry) => entry.taskId === "t2")
        .map((entry) => ({
          claimId: entry.claimId,
          originAssignmentId: entry.originAssignmentId,
        })),
    ).toEqual(retainedClaims);
    for (const retained of retainedProofs) {
      expect(
        record.assignments.find((entry) => entry.assignmentId === retained.assignmentId)
          ?.acceptedProof,
      ).toEqual(retained.proof);
    }
  });

  test("run-finished rejects a claim and an unrelated open decision", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.decisions.push({
      decisionId: DECISION_D1,
      category: "D7",
      controlNonceDigest: CONTROL_DIGEST,
      state: "open",
      dedupeKey: "other",
      subjectId: null,
      summary: "unresolved",
      createdAt: AT_UPDATED,
      answeredAt: null,
      answer: null,
      cancelIntents: null,
      resolution: null,
    });
    const result = reduceRun(record, { kind: "run-finished" }, facts);
    expect(result).toMatchObject({
      ok: false,
      code: "RUN_INVALID_TRANSITION",
      path: ["lifecycle"],
      params: {
        reason: "run-not-finished",
        tasks: 1,
        decisions: 1,
        claims: 1,
      },
    });
  });
  test("dispatch requires claims and an exact producer tier", () => {
    const ready = structuredClone(NORMAL_RUN_LEDGER);
    ensureDispatchSeat(ready);
    const t3 = taskOf(ready, "t3");
    t3.state = "ready";
    t3.attempts = 0;
    t3.spec = { ...t3.spec, deps: [] };
    assertDispatchBaseline(ready);
    const nonce = "12341234-1234-4123-8123-123412341234";
    const event = (claims: ReturnType<typeof claim>[]) => ({
      kind: "task-dispatched" as const,
      taskId: "t3",
      assignment: assignment({
        assignmentId: "assignment-t3-a1",
        taskId: "t3",
        seatId: "seat-b7",
        agentId: "agent-b7",
        nonce,
        messageId: "23452345-2345-4234-8234-234523452345",
      }),
      nonce: {
        nonce,
        runId: ready.runId,
        taskId: "t3",
        assignmentId: "assignment-t3-a1",
        attempt: 1,
        phase: "implementation" as const,
        agentId: "agent-b7",
        seatId: "seat-b7",
        issuedAt: AT_UPDATED,
        acceptedAt: null,
        acceptedEventKey: null,
        revokedAt: null,
        revokeReason: null,
      },
      intent: dispatchIntent({
        id: "intent-t3-a1",
        taskId: "t3",
        assignmentId: "assignment-t3-a1",
        recipient: "agent-b7",
        messageId: "23452345-2345-4234-8234-234523452345",
      }),
      claims,
      reissueOfAssignmentId: null,
    });
    expect(reduceRun(ready, event([]), facts)).toMatchObject({
      ok: false,
      code: "RUN_EVENT_INVALID",
      path: ["claims"],
      params: { reason: "claim-required" },
    });
    const high = structuredClone(ready);
    taskOf(high, "t3").spec = { ...taskOf(high, "t3").spec, level: "L4", tier: "S" };
    expect(
      reduceRun(
        high,
        event([
          claim({
            claimId: "t3",
            taskId: "t3",
            originAssignmentId: "assignment-t3-a1",
            path: "src/t3.ts",
          }),
        ]),
        facts,
      ),
    ).toMatchObject({
      ok: false,
      code: "RUN_EVENT_INVALID",
      path: ["assignment", "seatId"],
      params: { reason: "structural-seat" },
    });
  });

  test.each([
    ["wrong task", archiveIntent({ taskId: "t3" })],
    ["wrong recipient", archiveIntent({ recipient: "other-agent" })],
  ])("cancel intent with %s is rejected before freezing", (_label, intent) => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    assertDispatchBaseline(record);
    const result = reduceRun(record, cancelEvent(intent), facts);
    expect(result).toMatchObject({
      ok: false,
      code: "RUN_EVENT_INVALID",
      params: { reason: "pair-intent-binding" },
    });
    expect(taskOf(record, "t2").state).toBe("in_progress");
  });

  test("cancel intent must belong to the task and D1 dedupe is bound", () => {
    const record = structuredClone(CANCELLATION_AUTHORIZED_FROZEN_LEDGER);
    assertDispatchBaseline(record);
    const decision = record.decisions[0];
    if (!decision) throw new Error("missing decision");
    expect(decision.dedupeKey).toBe("cancel:t2");
    expect(decision.cancelIntents).toHaveLength(1);
    decision.dedupeKey = "other";
    decision.cancelIntents = null;
    const assignment = record.assignments.find((entry) => entry.assignmentId === ASSIGNMENT_T2);
    if (!assignment) throw new Error("missing assignment");
    assignment.cancellation = null;
    const result = reduceRun(
      record,
      {
        kind: "cancellation-checked",
        taskId: "t2",
        decisionId: decision.decisionId,
        evidence: QUIESCENT_CANCELLATION,
      },
      facts,
    );
    expect(result).toMatchObject({
      ok: false,
      code: "RUN_EVENT_INVALID",
      params: { reason: "pair-binding" },
    });
    expect(taskOf(record, "t2").state).toBe("blocked");
  });
});

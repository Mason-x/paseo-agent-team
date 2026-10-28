// biome-ignore-all lint/style/noNonNullAssertion: fixture builders guarantee these indices.
import { describe, expect, test } from "vitest";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import { reduceRun } from "../../shared/domain/run-engine/reducer";
import type { RunEventReceipt, RunRecord } from "../../shared/schemas/run-engine/ledger";
import type {
  RunReviewReportBlock,
  RunTaskReportBlock,
} from "../../shared/schemas/run-engine/protocol";
import {
  ASSIGNMENT_T2,
  AT_UPDATED,
  assignment,
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

function report(overrides: Partial<RunTaskReportBlock> = {}): RunTaskReportBlock {
  return {
    protocolVersion: 1,
    runId: NORMAL_RUN_LEDGER.runId,
    taskId: "T2",
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

function reviewerAssignment() {
  return assignment({
    assignmentId: "assignment-t2-r1",
    seatId: "seat-b2",
    agentId: "agent-b2",
    purpose: "reviewer",
    tier: "A",
    family: "codex",
    nonce: NONCE_T2_REVIEW,
    messageId: null,
  });
}

function review(overrides: Partial<RunReviewReportBlock> = {}): RunReviewReportBlock {
  return {
    protocolVersion: 1,
    runId: NORMAL_RUN_LEDGER.runId,
    taskId: "T2",
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

function withReviewer(record: RunRecord = structuredClone(NORMAL_RUN_LEDGER)): RunRecord {
  const reviewer = reviewerAssignment();
  record.assignments.push(reviewer);
  record.nonceRegistry.push({
    nonce: reviewer.nonce,
    runId: record.runId,
    taskId: "T2",
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
  });
  return record;
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
    expect(result.next.counters.observationSeq).toBe(8);
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
    const record = withReviewer();
    const reported = reduceRun(record, { kind: "task-report", block: report() }, facts);
    expect(reported.ok).toBe(true);
    if (!reported.ok) return;
    expect(taskOf(reported.next, "T2").state).toBe("review");
    const reviewed = reduceRun(reported.next, { kind: "review-report", block: review() }, facts);
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) return;
    expect(taskOf(reviewed.next, "T2").state).toBe("done");
    expect(taskOf(reviewed.next, "T3").state).toBe("ready");
    expect(reviewed.next.resources).toEqual([]);
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
    const task = taskOf(result.next, "T2");
    expect(task.state).toBe("in_progress");
    expect(task.evidenceReturns).toBe(1);
  });

  test("raw decision replies are rejected until the control nonce exists", () => {
    const actions = [
      { action: "replan", nextDagRevision: 2 },
      { action: "retry", taskId: "T2", reason: "retry" },
      { action: "cancel", taskIds: ["T2"], reason: "cancel" },
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
          subjectId: "T2",
          summary: "decision",
          createdAt: AT_UPDATED,
          answeredAt: null,
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
    record.outbox.push(
      dispatchIntent({
        id: INTENT_CANCEL,
        kind: "wake",
        assignmentId: ASSIGNMENT_T2,
        taskId: "T2",
        messageId: MESSAGE_CANCEL,
        state: "sending",
        confirmedAt: null,
      }),
    );
    const assignmentValue = record.assignments.find(
      (entry) => entry.assignmentId === ASSIGNMENT_T2,
    );
    if (!assignmentValue) throw new Error("missing assignment");
    assignmentValue.cancellation = QUIESCENT_CANCELLATION;
    const result = reduceRun(
      record,
      {
        kind: "cancel-requested",
        taskIds: ["T2"],
        reason: "cancel",
        cancelIntentId: "intent-cancel-t2",
        controlNonceDigest: CONTROL_DIGEST,
      },
      facts,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(taskOf(result.next, "T2")).toMatchObject({
        state: "blocked",
        phase: "frozen",
      });
    }
  });

  test("cancel releases only after the explicit quiescence check", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.outbox.push(
      dispatchIntent({
        id: INTENT_CANCEL,
        kind: "wake",
        assignmentId: ASSIGNMENT_T2,
        taskId: "T2",
        messageId: MESSAGE_CANCEL,
        state: "sending",
        confirmedAt: null,
      }),
    );
    const assignmentValue = record.assignments.find(
      (entry) => entry.assignmentId === ASSIGNMENT_T2,
    );
    if (!assignmentValue) throw new Error("missing assignment");
    assignmentValue.turnId = "turn-7";
    const frozen = reduceRun(
      record,
      {
        kind: "cancel-requested",
        taskIds: ["T2"],
        reason: "cancel",
        cancelIntentId: "intent-cancel-t2",
        controlNonceDigest: CONTROL_DIGEST,
      },
      facts,
    );
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    const decisionId = frozen.next.decisions[0]?.decisionId;
    if (!decisionId) throw new Error("missing decision");
    const released = reduceRun(
      frozen.next,
      {
        kind: "cancellation-checked",
        taskId: "T2",
        decisionId,
        evidence: QUIESCENT_CANCELLATION,
      },
      facts,
    );
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(taskOf(released.next, "T2").state).toBe("cancelled");
    expect(released.next.resources).toEqual([]);
  });

  test("blocked and failed reports retain the claim in a legal form", () => {
    for (const status of ["blocked", "failed"] as const) {
      const result = reduceRun(
        withReviewer(),
        {
          kind: "task-report",
          block: report({
            status,
            reasonCode: "needs-help",
            summary: "stuck",
            evidence: [],
          } as never),
        },
        facts,
      );
      expect(result.ok, status).toBe(true);
      if (!result.ok) continue;
      const task = taskOf(result.next, "T2");
      expect(task.state).toBe(status);
      expect(result.next.resources).toHaveLength(1);
      if (status === "blocked") expect(task.phase).toBe("frozen");
    }
  });

  test("a rejected review increments quality failures and enters rework", () => {
    const reported = reduceRun(withReviewer(), { kind: "task-report", block: report() }, facts);
    expect(reported.ok).toBe(true);
    if (!reported.ok) return;
    const rejected = reduceRun(
      reported.next,
      { kind: "review-report", block: review({ verdict: "不可合入" }) },
      facts,
    );
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(taskOf(rejected.next, "T2")).toMatchObject({
      state: "rework",
      qualityFailures: 1,
    });
  });

  test("a smoke report must come from the registered target and an independent smoker", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const task = taskOf(record, "T2");
    task.spec = { ...task.spec, devSmoke: true, smokeChecklist: ["open runs"] };
    task.state = "review";
    task.phase = "smoke";
    task.ref = { kind: "git-commit", value: "9f3c1a7" };
    task.report = report();
    record.assignments.push(
      assignment({
        assignmentId: "assignment-t2-r1",
        taskId: "T2",
        seatId: "seat-b2",
        agentId: "agent-b2",
        purpose: "reviewer",
        tier: "A",
        family: "codex",
        nonce: NONCE_T2_REVIEW,
        messageId: null,
      }),
    );
    record.nonceRegistry.push({
      nonce: NONCE_T2_REVIEW,
      runId: record.runId,
      taskId: "T2",
      assignmentId: "assignment-t2-r1",
      attempt: 1,
      phase: "review",
      agentId: "agent-b2",
      seatId: "seat-b2",
      issuedAt: AT_UPDATED,
      acceptedAt: null,
      acceptedEventKey: null,
      revokedAt: null,
      revokeReason: null,
    });
    task.reviews = [
      {
        reviewerAgentId: "agent-b2",
        reviewerSeatId: "seat-b2",
        verdict: "可合入",
        reviewedRef: { kind: "git-commit", value: "9f3c1a7" },
        blockers: [],
      },
    ];
    const smokeNonce = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    record.assignments.push(
      assignment({
        assignmentId: "assignment-t2-smoke",
        seatId: "seat-b3",
        agentId: "agent-b3",
        purpose: "smoker",
        nonce: smokeNonce,
        messageId: null,
      }),
    );
    record.nonceRegistry.push({
      nonce: smokeNonce,
      runId: record.runId,
      taskId: "T2",
      assignmentId: "assignment-t2-smoke",
      attempt: 1,
      phase: "smoke",
      agentId: "agent-b3",
      seatId: "seat-b3",
      issuedAt: AT_UPDATED,
      acceptedAt: null,
      acceptedEventKey: null,
      revokedAt: null,
      revokeReason: null,
    });
    const block = {
      protocolVersion: 1,
      runId: record.runId,
      taskId: "T2",
      attempt: 1,
      nonce: smokeNonce,
      assignmentId: "assignment-t2-smoke",
      testedRef: { kind: "git-commit", value: "9f3c1a7" },
      devHost: "127.0.0.1:6799",
      devServerId: "dev-server-1",
      devHome: "/tmp/dev-home",
      checks: [{ id: "open runs", result: "pass", evidencePath: "evidence/smoke.png" }],
    } as never;
    const result = reduceRun(record, { kind: "smoke-report", block }, facts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(taskOf(result.next, "T2").state).toBe("done");
  });

  test("dispatch and turn events move ready to assigned to in_progress", () => {
    const nonce = "11111111-1111-4111-8111-111111111111";
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.resources = [];
    const task = taskOf(record, "T2");
    task.state = "ready";
    task.attempts = 0;
    task.currentAssignmentId = null;
    const nextAssignment = assignment({
      assignmentId: "assignment-t2-new",
      nonce,
      messageId: MESSAGE_T2,
    });
    const result = reduceRun(
      record,
      {
        kind: "task-dispatched",
        taskId: "T2",
        assignment: nextAssignment,
        nonce: {
          nonce,
          runId: record.runId,
          taskId: "T2",
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
        claims: [claim({ claimId: "claim-t2-new", taskId: "T2" })],
      },
      facts,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(taskOf(result.next, "T2")).toMatchObject({
      state: "assigned",
      phase: "implementation",
      currentAssignmentId: "assignment-t2-new",
    });
    const started = reduceRun(
      result.next,
      {
        kind: "turn-started",
        assignmentId: "assignment-t2-new",
        agentId: "agent-b1",
        turnId: "turn-new",
      },
      facts,
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(taskOf(started.next, "T2").state).toBe("in_progress");
    const ended = reduceRun(
      started.next,
      {
        kind: "turn-ended",
        assignmentId: "assignment-t2-new",
        endedEventKey: "agent-b1|turn-new|turn_ended",
      },
      facts,
    );
    expect(ended.ok).toBe(true);
    if (!ended.ok) return;
    expect(
      ended.next.assignments.find((entry) => entry.assignmentId === "assignment-t2-new")?.state,
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
          tasks: [spec("T1", "Fresh task")],
          cancelTaskIds: [],
          budgetRequests: [],
        },
      },
      facts,
    );
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(taskOf(accepted.next, "T1").state).toBe("ready");
    expect(accepted.next.lifecycle).toBe("active");

    const revised = reduceRun(
      structuredClone(NORMAL_RUN_LEDGER),
      {
        kind: "dag-revised",
        controlNonceDigest: CONTROL_DIGEST,
        block: {
          protocolVersion: 1,
          runId: NORMAL_RUN_LEDGER.runId,
          taskId: "_dag",
          attempt: 1,
          nonce: NONCE_T2,
          dagRevision: NORMAL_RUN_LEDGER.dagRevision + 1,
          expectedDagRevision: NORMAL_RUN_LEDGER.dagRevision,
          tasks: [spec("T1", "Changed terminal task")],
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
    const result = reduceRun(record, { kind: "run-finished" }, facts);
    expect(result).toMatchObject({ ok: true });
  });
  test("I7 rejects a done task with no implementation evidence", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    delete (taskOf(record, "T1") as Record<string, unknown>).report;
    const reportValue = checkLedgerInvariants(record);
    expect(reportValue.ok).toBe(false);
    if (!reportValue.ok) {
      expect(
        reportValue.violations.some(
          (entry) => entry.invariant === "I7" && entry.params.reason === "missing-done-report",
        ),
      ).toBe(true);
    }
  });

  test("an L4 task cannot be completed by a B reviewer", () => {
    const record = withReviewer();
    const task = taskOf(record, "T2");
    task.spec = { ...task.spec, level: "L4" };
    task.state = "review";
    task.phase = "review";
    task.ref = { kind: "git-commit", value: "9f3c1a7" };
    task.report = report();
    const reviewer = record.assignments.find((entry) => entry.assignmentId === "assignment-t2-r1");
    if (!reviewer) throw new Error("missing reviewer");
    reviewer.tier = "B";
    const result = reduceRun(record, { kind: "review-report", block: review() }, facts);
    expect(result.ok).toBe(false);
    expect(record.tasks.find((entry) => entry.spec.id === "T2")?.state).toBe("review");
  });

  test("invalid cancellation evidence never releases a frozen claim", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.outbox.push(
      dispatchIntent({
        id: INTENT_CANCEL,
        kind: "wake",
        assignmentId: ASSIGNMENT_T2,
        taskId: "T2",
        messageId: MESSAGE_CANCEL,
        state: "sending",
        confirmedAt: null,
      }),
    );
    const assignmentValue = record.assignments.find(
      (entry) => entry.assignmentId === ASSIGNMENT_T2,
    );
    if (!assignmentValue) throw new Error("missing assignment");
    assignmentValue.turnId = "turn-7";
    const frozen = reduceRun(
      record,
      {
        kind: "cancel-requested",
        taskIds: ["T2"],
        reason: "cancel",
        cancelIntentId: INTENT_CANCEL,
        controlNonceDigest: CONTROL_DIGEST,
      },
      facts,
    );
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    const decisionId = frozen.next.decisions[0]?.decisionId;
    if (!decisionId) throw new Error("missing decision");
    const badEvidence = {
      ...QUIESCENT_CANCELLATION,
      cancelIntentId: INTENT_CANCEL,
      receipt: { kind: "none" as const, confirmedAt: AT_UPDATED, externalId: null },
      observationSeq: 0,
      refreshObservedAt: "2020-01-01T00:00:00.000Z",
    };
    const result = reduceRun(
      frozen.next,
      { kind: "cancellation-checked", taskId: "T2", decisionId, evidence: badEvidence },
      facts,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(taskOf(result.next, "T2").state).toBe("blocked");
      expect(result.next.resources[0]?.frozen).toBe(true);
    }
  });

  test("a frozen in-flight task still occupies the concurrency slot", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.policy = { ...record.policy, configuredConcurrency: 1 };
    const t2 = taskOf(record, "T2");
    t2.state = "blocked";
    t2.phase = "frozen";
    record.resources = record.resources.map((entry) => ({ ...entry, frozen: true }));
    const t3 = taskOf(record, "T3");
    t3.state = "ready";
    t3.spec = { ...t3.spec, deps: [] };
    const result = reduceRun(
      record,
      {
        kind: "task-dispatched",
        taskId: "T3",
        assignment: assignment({
          assignmentId: "assignment-t3-a1",
          taskId: "T3",
          nonce: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }),
        nonce: {
          nonce: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          runId: record.runId,
          taskId: "T3",
          assignmentId: "assignment-t3-a1",
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
          id: "intent-t3-a1",
          taskId: "T3",
          assignmentId: "assignment-t3-a1",
          messageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        }),
      },
      facts,
    );
    expect(result).toMatchObject({ ok: false, params: { reason: "capacity" } });
  });

  test("I3 rejects directory coverage, write/read overlap and failed claims", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.resources = [
      claim({
        claimId: "claim-dir",
        taskId: "T2",
        kind: "directory",
        path: "src",
        access: "write",
      }),
      claim({
        claimId: "claim-file",
        taskId: "T3",
        kind: "file",
        path: "src/t3.ts",
        access: "write",
      }),
    ];
    const t3 = taskOf(record, "T3");
    t3.state = "in_progress";
    t3.currentAssignmentId = null;
    const overlap = checkLedgerInvariants(record);
    expect(overlap.ok).toBe(false);
    if (!overlap.ok) {
      expect(overlap.violations.some((entry) => entry.invariant === "I3")).toBe(true);
    }
    const failed = structuredClone(record);
    const failedTask = taskOf(failed, "T2");
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
    const t3 = taskOf(record, "T3");
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
        controlNonceDigest: CONTROL_DIGEST,
        block: {
          protocolVersion: 1,
          runId: record.runId,
          taskId: "_dag",
          attempt: 1,
          nonce: NONCE_T2,
          dagRevision: record.dagRevision + 1,
          expectedDagRevision: record.dagRevision,
          tasks: [spec("T2", "Changed in-flight task")],
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
        controlNonceDigest: CONTROL_DIGEST,
        block: {
          protocolVersion: 1,
          runId: record.runId,
          taskId: "_dag",
          attempt: 1,
          nonce: NONCE_T2,
          dagRevision: record.dagRevision + 2,
          expectedDagRevision: record.dagRevision,
          tasks: [spec("T1", "Core API surface")],
          cancelTaskIds: [],
          budgetRequests: [],
        },
      },
      facts,
    );
    expect(jumped).toMatchObject({ ok: false, params: { reason: "stale-dag" } });
  });

  test("revoked nonces and unrelated intents are rejected", () => {
    const record = withReviewer();
    const nonce = record.nonceRegistry.find((entry) => entry.assignmentId === ASSIGNMENT_T2);
    if (!nonce) throw new Error("missing nonce");
    nonce.revokedAt = AT_UPDATED;
    const result = reduceRun(record, { kind: "task-report", block: report() }, facts);
    expect(result).toMatchObject({ ok: false, params: { reason: "nonce-invalid" } });
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
    record.lifecycle = "paused";
    const t2 = taskOf(record, "T2");
    t2.state = "ready";
    t2.attempts = 0;
    const nonce = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const result = reduceRun(
      record,
      {
        kind: "task-dispatched",
        taskId: "T2",
        assignment: assignment({
          assignmentId: "assignment-t2-paused",
          nonce,
          taskId: "T2",
          messageId: MESSAGE_T2,
        }),
        nonce: {
          nonce,
          runId: record.runId,
          taskId: "T2",
          assignmentId: "assignment-t2-paused",
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
          id: "intent-t2-paused",
          assignmentId: "assignment-t2-paused",
          taskId: "T2",
          messageId: MESSAGE_T2,
        }),
      },
      facts,
    );
    expect(result).toMatchObject({
      ok: false,
      params: { reason: "task-dispatched" },
    });
    const malformed = structuredClone(NORMAL_RUN_LEDGER);
    (taskOf(malformed, "T1") as Record<string, unknown>).reviews = { invalid: true };
    expect(() => checkLedgerInvariants(malformed)).not.toThrow();
    expect(checkLedgerInvariants(malformed).ok).toBe(false);
  });
  test("control digests are required and persisted on created decisions", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.outbox.push(
      dispatchIntent({
        id: INTENT_CANCEL,
        kind: "wake",
        assignmentId: ASSIGNMENT_T2,
        taskId: "T2",
        messageId: MESSAGE_CANCEL,
        state: "sending",
        confirmedAt: null,
      }),
    );
    const missing = reduceRun(
      record,
      {
        kind: "cancel-requested",
        taskIds: ["T2"],
        reason: "cancel",
        cancelIntentId: INTENT_CANCEL,
        controlNonceDigest: "not-a-digest",
      },
      facts,
    );
    expect(missing).toMatchObject({ ok: false, params: { reason: "invalid-digest" } });
    const valid = reduceRun(
      record,
      {
        kind: "cancel-requested",
        taskIds: ["T2"],
        reason: "cancel",
        cancelIntentId: INTENT_CANCEL,
        controlNonceDigest: CONTROL_DIGEST,
      },
      facts,
    );
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.next.decisions[0]?.controlNonceDigest).toBe(CONTROL_DIGEST);
  });

  test("cancellation-checked rejects a decision for another task or category", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.outbox.push(
      dispatchIntent({
        id: INTENT_CANCEL,
        kind: "wake",
        assignmentId: ASSIGNMENT_T2,
        taskId: "T2",
        messageId: MESSAGE_CANCEL,
        state: "sending",
        confirmedAt: null,
      }),
    );
    const frozen = reduceRun(
      record,
      {
        kind: "cancel-requested",
        taskIds: ["T2"],
        reason: "cancel",
        cancelIntentId: INTENT_CANCEL,
        controlNonceDigest: CONTROL_DIGEST,
      },
      facts,
    );
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    const decisionId = frozen.next.decisions[0]?.decisionId;
    if (!decisionId) throw new Error("missing decision");
    const other = structuredClone(frozen.next);
    other.decisions[0] = {
      ...other.decisions[0],
      category: "D7",
      subjectId: "T3",
    };
    const result = reduceRun(
      other,
      { kind: "cancellation-checked", taskId: "T2", decisionId, evidence: QUIESCENT_CANCELLATION },
      facts,
    );
    expect(result).toMatchObject({ ok: false, params: { reason: "decision-binding" } });
  });

  test("I3 treats hot/tool names exactly and rejects failed unfrozen claims", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.resources = [
      claim({ claimId: "hot-a", taskId: "T2", kind: "hot", path: "repo:hot", access: "write" }),
      claim({ claimId: "hot-b", taskId: "T3", kind: "hot", path: "repo:hot", access: "write" }),
    ];
    const t3 = taskOf(record, "T3");
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
    const task = taskOf(failed, "T2");
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
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.outbox.push(
      dispatchIntent({
        id: INTENT_CANCEL,
        kind: "wake",
        assignmentId: ASSIGNMENT_T2,
        taskId: "T2",
        messageId: MESSAGE_CANCEL,
        state: "sending",
        confirmedAt: null,
      }),
    );
    const assignmentValue = record.assignments.find(
      (entry) => entry.assignmentId === ASSIGNMENT_T2,
    );
    if (!assignmentValue) throw new Error("missing assignment");
    assignmentValue.turnId = "turn-7";
    const frozen = reduceRun(
      record,
      {
        kind: "cancel-requested",
        taskIds: ["T2"],
        reason: "cancel",
        cancelIntentId: INTENT_CANCEL,
        controlNonceDigest: CONTROL_DIGEST,
      },
      facts,
    );
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    const observed = reduceRun(
      frozen.next,
      {
        kind: "observation-recorded",
        receipt: {
          eventKey: "agent-b1|turn-9|turn_started",
          kind: "turn_started",
          agentId: "agent-b1",
          turnId: "turn-9",
          seq: 3,
          receivedAt: AT_UPDATED,
          dedupeKey: "agent-b1|turn-9|turn_started",
          disposition: "observed",
        },
      },
      facts,
    );
    expect(observed.ok).toBe(true);
    if (!observed.ok) return;
    const decisionId = observed.next.decisions[0]?.decisionId;
    if (!decisionId) throw new Error("missing decision");
    const checked = reduceRun(
      observed.next,
      {
        kind: "cancellation-checked",
        taskId: "T2",
        decisionId,
        evidence: { ...QUIESCENT_CANCELLATION, observationSeq: 8 },
      },
      facts,
    );
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(taskOf(checked.next, "T2").state).toBe("blocked");
  });

  test("a never-started assignment can be cancelled after a confirmed receipt", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.outbox.push(
      dispatchIntent({
        id: INTENT_CANCEL,
        kind: "wake",
        assignmentId: ASSIGNMENT_T2,
        taskId: "T2",
        messageId: MESSAGE_CANCEL,
        state: "sending",
        confirmedAt: null,
      }),
    );
    const frozen = reduceRun(
      record,
      {
        kind: "cancel-requested",
        taskIds: ["T2"],
        reason: "cancel",
        cancelIntentId: INTENT_CANCEL,
        controlNonceDigest: CONTROL_DIGEST,
      },
      facts,
    );
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    const decisionId = frozen.next.decisions[0]?.decisionId;
    if (!decisionId) throw new Error("missing decision");
    const evidence = {
      ...QUIESCENT_CANCELLATION,
      lastTurnId: null,
      endedEventKey: null,
      observationSeq: 7,
      refreshObservedAt: AT_UPDATED,
    };
    const checked = reduceRun(
      frozen.next,
      { kind: "cancellation-checked", taskId: "T2", decisionId, evidence },
      facts,
    );
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(taskOf(checked.next, "T2").state).toBe("cancelled");
  });

  test("dag-revised cancels an unstarted pending task without D1", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const result = reduceRun(
      record,
      {
        kind: "dag-revised",
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
            spec("T1", "Core API surface"),
            spec("T2", "Core implementation"),
            spec("T3", "Operator docs", { group: "docs", deps: ["T2"] }),
          ],
          cancelTaskIds: ["T3"],
          budgetRequests: [],
        },
      },
      facts,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(taskOf(result.next, "T3").state).toBe("cancelled");
    expect(result.next.decisions).toHaveLength(0);
  });

  test("a smoke-phase blocking review prevents done", () => {
    const record = withReviewer();
    const task = taskOf(record, "T2");
    task.spec = { ...task.spec, devSmoke: true, smokeChecklist: ["open"] };
    task.state = "review";
    task.phase = "review";
    task.ref = { kind: "git-commit", value: "9f3c1a7" };
    task.report = report();
    const pass = reduceRun(record, { kind: "review-report", block: review() }, facts);
    expect(pass.ok).toBe(true);
    if (!pass.ok) return;
    expect(taskOf(pass.next, "T2").phase).toBe("smoke");
    const second = pass.next;
    const reviewer2 = assignment({
      assignmentId: "assignment-t2-r2",
      seatId: "seat-b2",
      agentId: "agent-b2",
      purpose: "reviewer",
      tier: "A",
      family: "codex",
      nonce: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      messageId: null,
    });
    second.assignments.push(reviewer2);
    second.nonceRegistry.push({
      nonce: reviewer2.nonce,
      runId: second.runId,
      taskId: "T2",
      assignmentId: reviewer2.assignmentId,
      attempt: 1,
      phase: "review",
      agentId: reviewer2.agentId,
      seatId: reviewer2.seatId,
      issuedAt: AT_UPDATED,
      acceptedAt: null,
      acceptedEventKey: null,
      revokedAt: null,
      revokeReason: null,
    });
    const blocked = reduceRun(
      second,
      {
        kind: "review-report",
        block: {
          ...review(),
          assignmentId: reviewer2.assignmentId,
          nonce: reviewer2.nonce,
          verdict: "不可合入",
          blockers: [{ id: "B-1", summary: "blocking", path: "src/t2.ts" }],
        },
      },
      facts,
    );
    expect(blocked.ok).toBe(true);
    if (blocked.ok) expect(taskOf(blocked.next, "T2").state).not.toBe("done");
  });
  test("a multi-task cancel request is rejected instead of half-binding one intent", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.outbox.push(
      dispatchIntent({
        id: INTENT_CANCEL,
        kind: "wake",
        assignmentId: ASSIGNMENT_T2,
        taskId: "T2",
        messageId: MESSAGE_CANCEL,
        state: "sending",
        confirmedAt: null,
      }),
    );
    const result = reduceRun(
      record,
      {
        kind: "cancel-requested",
        taskIds: ["T2", "T3"],
        reason: "cancel",
        cancelIntentId: INTENT_CANCEL,
        controlNonceDigest: CONTROL_DIGEST,
      },
      facts,
    );
    expect(result).toMatchObject({ ok: false, params: { reason: "multi-task-cancel" } });
  });
  test("dispatch accepts hot/tool claims and rejects read-scope and uncovered write scopes", () => {
    const base = structuredClone(NORMAL_RUN_LEDGER);
    const t3 = taskOf(base, "T3");
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
    const nonce = "abcdabcd-abcd-4abc-8abc-abcdabcdabcd";
    const dispatch = (claims: ReturnType<typeof claim>[]) =>
      reduceRun(
        base,
        {
          kind: "task-dispatched",
          taskId: "T3",
          assignment: assignment({
            assignmentId: "assignment-t3-a1",
            taskId: "T3",
            nonce,
            messageId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          }),
          nonce: {
            nonce,
            runId: base.runId,
            taskId: "T3",
            assignmentId: "assignment-t3-a1",
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
            id: "intent-t3-a1",
            taskId: "T3",
            assignmentId: "assignment-t3-a1",
            messageId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          }),
          claims,
        },
        facts,
      );
    const hot = dispatch([
      claim({ claimId: "t3-file", taskId: "T3", path: "src/t3.ts" }),
      claim({ claimId: "t3-file-b", taskId: "T3", path: "src/t3b.ts" }),
      claim({ claimId: "t3-hot", taskId: "T3", kind: "hot", path: "repo:hot", access: "write" }),
    ]);
    expect(hot.ok).toBe(true);
    if (hot.ok) expect(hot.next.resources.some((entry) => entry.claimId === "t3-hot")).toBe(true);
    expect(
      dispatch([claim({ claimId: "t3-file", taskId: "T3", path: "src/t3.ts" })]),
    ).toMatchObject({ ok: false, params: { reason: "claim-coverage" } });

    const read = structuredClone(base);
    const readTask = taskOf(read, "T3");
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
        taskId: "T3",
        assignment: assignment({
          assignmentId: "assignment-t3-read",
          taskId: "T3",
          nonce: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          messageId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        }),
        nonce: {
          nonce: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          runId: read.runId,
          taskId: "T3",
          assignmentId: "assignment-t3-read",
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
          id: "intent-t3-read",
          taskId: "T3",
          assignmentId: "assignment-t3-read",
          messageId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        }),
        claims: [claim({ claimId: "t3-read", taskId: "T3", path: "docs/x", access: "write" })],
      },
      facts,
    );
    expect(readResult).toMatchObject({ ok: false, params: { reason: "claim-not-in-scope" } });
  });

  test("rework reuses existing claims without appending duplicates", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const task = taskOf(record, "T2");
    task.state = "rework";
    task.attempts = 1;
    const nonce = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const result = reduceRun(
      record,
      {
        kind: "task-dispatched",
        taskId: "T2",
        assignment: assignment({
          assignmentId: "assignment-t2-r2",
          taskId: "T2",
          attempt: 2,
          nonce,
          messageId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        }),
        nonce: {
          nonce,
          runId: record.runId,
          taskId: "T2",
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
          taskId: "T2",
          assignmentId: "assignment-t2-r2",
          messageId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        }),
      },
      facts,
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.next.resources.filter((entry) => entry.taskId === "T2")).toHaveLength(1);
  });

  test("run-finished rejects a claim and an unrelated open decision", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.tasks = [];
    record.decisions = [];
    record.outbox = [];
    record.assignments = [];
    record.nonceRegistry = [];
    expect(reduceRun(record, { kind: "run-finished" }, facts).ok).toBe(false);
    record.resources = [];
    record.decisions = [
      {
        decisionId: DECISION_D1,
        category: "D1",
        controlNonceDigest: CONTROL_DIGEST,
        state: "open",
        dedupeKey: "other",
        subjectId: null,
        summary: "unresolved",
        createdAt: AT_UPDATED,
        answeredAt: null,
      },
    ];
    expect(reduceRun(record, { kind: "run-finished" }, facts).ok).toBe(false);
  });
  test("dispatch requires claims, exact tier, and valid review nonce", () => {
    const ready = structuredClone(NORMAL_RUN_LEDGER);
    const t3 = taskOf(ready, "T3");
    t3.state = "ready";
    t3.attempts = 0;
    t3.spec = { ...t3.spec, deps: [] };
    const nonce = "12341234-1234-4123-8123-123412341234";
    const event = (claims: ReturnType<typeof claim>[]) => ({
      kind: "task-dispatched" as const,
      taskId: "T3",
      assignment: assignment({
        assignmentId: "assignment-t3-a1",
        taskId: "T3",
        nonce,
        messageId: "23452345-2345-4234-8234-234523452345",
      }),
      nonce: {
        nonce,
        runId: ready.runId,
        taskId: "T3",
        assignmentId: "assignment-t3-a1",
        attempt: 1,
        phase: "implementation" as const,
        agentId: "agent-b1",
        seatId: "seat-b1",
        issuedAt: AT_UPDATED,
        acceptedAt: null,
        acceptedEventKey: null,
        revokedAt: null,
        revokeReason: null,
      },
      intent: dispatchIntent({
        id: "intent-t3-a1",
        taskId: "T3",
        assignmentId: "assignment-t3-a1",
        messageId: "23452345-2345-4234-8234-234523452345",
      }),
      claims,
    });
    expect(reduceRun(ready, event([]), facts)).toMatchObject({
      ok: false,
      params: { reason: "claim-required" },
    });
    const high = structuredClone(ready);
    taskOf(high, "T3").spec = { ...taskOf(high, "T3").spec, level: "L4", tier: "S" };
    expect(
      reduceRun(high, event([claim({ claimId: "t3", taskId: "T3", path: "src/t3.ts" })]), facts),
    ).toMatchObject({ ok: false, params: { reason: "tier-mismatch" } });

    const reported = reduceRun(withReviewer(), { kind: "task-report", block: report() }, facts);
    expect(reported.ok).toBe(true);
    if (!reported.ok) return;
    const reviewerNonce = reported.next.nonceRegistry.find(
      (entry) => entry.assignmentId === "assignment-t2-r1",
    );
    if (!reviewerNonce) throw new Error("review nonce");
    reviewerNonce.revokedAt = AT_UPDATED;
    expect(
      reduceRun(reported.next, { kind: "review-report", block: review() }, facts),
    ).toMatchObject({ ok: false, params: { reason: "nonce-invalid" } });
  });

  test("cancel intent must belong to the task and D1 dedupe is bound", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.outbox.push(
      dispatchIntent({
        id: INTENT_CANCEL,
        kind: "wake",
        assignmentId: ASSIGNMENT_T2,
        taskId: "T3",
        messageId: MESSAGE_CANCEL,
        state: "sending",
        confirmedAt: null,
      }),
    );
    expect(
      reduceRun(
        record,
        {
          kind: "cancel-requested",
          taskIds: ["T2"],
          reason: "cancel",
          cancelIntentId: INTENT_CANCEL,
          controlNonceDigest: CONTROL_DIGEST,
        },
        facts,
      ),
    ).toMatchObject({ ok: false, params: { reason: "cancel-intent" } });

    const valid = structuredClone(NORMAL_RUN_LEDGER);
    valid.outbox.push(
      dispatchIntent({
        id: INTENT_CANCEL,
        kind: "wake",
        assignmentId: ASSIGNMENT_T2,
        taskId: "T2",
        messageId: MESSAGE_CANCEL,
        state: "sending",
        confirmedAt: null,
      }),
    );
    const frozen = reduceRun(
      valid,
      {
        kind: "cancel-requested",
        taskIds: ["T2"],
        reason: "cancel",
        cancelIntentId: INTENT_CANCEL,
        controlNonceDigest: CONTROL_DIGEST,
      },
      facts,
    );
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    const decisionId = frozen.next.decisions[0]?.decisionId;
    if (!decisionId) throw new Error("decision");
    const unrelated = structuredClone(frozen.next);
    unrelated.decisions[0] = { ...unrelated.decisions[0]!, dedupeKey: "other" };
    expect(
      reduceRun(
        unrelated,
        {
          kind: "cancellation-checked",
          taskId: "T2",
          decisionId,
          evidence: QUIESCENT_CANCELLATION,
        },
        facts,
      ),
    ).toMatchObject({ ok: false, params: { reason: "decision-binding" } });
  });
});

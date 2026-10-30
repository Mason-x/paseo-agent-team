// R03a reducer specification, written from 02 (AC-RE1.8, RE3.1, RE3.5, RE3.8), 05 (state machine,
// I1-I8, two-stage cancellation) and 141 R3a-1..9. Every case starts from the legal baseline and
// changes one thing; assertions are on the returned record or the rejection code/path.
import { describe, expect, test } from "vitest";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import { reduceRun } from "../../shared/domain/run-engine/reducer";
import type {
  CancellationObservation,
  RunReducerEvent,
} from "../../shared/domain/run-engine/transitions";
import type { RunCancellationEvidence, RunRecord } from "../../shared/schemas/run-engine/ledger";
import type {
  RunReviewReportBlock,
  RunSmokeReportBlock,
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
let serial = 0;
const facts = {
  now: AT_UPDATED,
  newId: (_kind: string) => {
    serial += 1;
    return `90000000-0000-4000-8000-${String(serial).padStart(12, "0")}`;
  },
};
const REF = { kind: "git-commit" as const, value: "9f3c1a7" };

function taskOf(record: RunRecord, id: string) {
  const task = record.tasks.find((entry) => entry.spec.id === id);
  if (!task) throw new Error(`missing ${id}`);
  return task as (typeof record.tasks)[number] & Record<string, unknown>;
}

function ensureSeat(
  record: RunRecord,
  seatId: string,
  agentId: string,
  duty: string,
  tier: "A" | "B" | "S",
) {
  if (!record.roster.some((entry) => entry.seatId === seatId)) {
    record.roster.push({
      seatId,
      tier,
      agentId,
      channelId: "claude",
      duties: [duty],
      enabled: true,
    });
  }
}

function report(overrides: Partial<RunTaskReportBlock> = {}): RunTaskReportBlock {
  return {
    protocolVersion: 1,
    runId: NORMAL_RUN_LEDGER.runId,
    taskId: "t2",
    attempt: 1,
    nonce: NONCE_T2,
    assignmentId: ASSIGNMENT_T2,
    messageId: MESSAGE_T2,
    status: "done",
    changedFiles: ["src/t2.ts"],
    ref: REF,
    workspace: { id: "ws-run-rec0re-a1-t2", branch: "re-rec0rea1-t2-a1-1", baseRef: "main" },
    evidence: [
      {
        id: "five-gates",
        command: "npm run check && npm run typecheck && npm test",
        exitCode: 0,
        summary: "all gates passed",
        artifactPath: "evidence/check.log",
        ref: REF,
        isolation: { homePath: "C:/Users/cc/AppData/Local/Temp/home", outsideRealHome: true },
      },
    ],
    ...overrides,
  } as RunTaskReportBlock;
}

function addReviewer(
  record: RunRecord,
  overrides: {
    id: string;
    seatId: string;
    agentId: string;
    tier: string;
    family: string;
    nonce?: string;
  },
) {
  ensureSeat(
    record,
    overrides.seatId,
    overrides.agentId,
    "review",
    overrides.tier as "A" | "B" | "S",
  );
  record.assignments.push(
    assignment({
      assignmentId: overrides.id,
      seatId: overrides.seatId,
      agentId: overrides.agentId,
      purpose: "reviewer",
      tier: overrides.tier as never,
      family: overrides.family,
      nonce:
        overrides.nonce ??
        (overrides.id === "assignment-t2-r1"
          ? NONCE_T2_REVIEW
          : "6f1c2a44-3b7e-4f0a-9a11-000000000007"),
      messageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      delivery: { producerAssignmentId: "assignment-t2-a1" },
    }),
  );
  record.nonceRegistry.push({
    nonce:
      overrides.nonce ??
      (overrides.id === "assignment-t2-r1"
        ? NONCE_T2_REVIEW
        : "6f1c2a44-3b7e-4f0a-9a11-000000000007"),
    runId: record.runId,
    taskId: "t2",
    assignmentId: overrides.id,
    attempt: 1,
    phase: "review",
    agentId: overrides.agentId,
    seatId: overrides.seatId,
    issuedAt: AT_UPDATED,
    acceptedAt: null,
    acceptedEventKey: null,
    revokedAt: null,
    revokeReason: null,
  });
  record.outbox.push(
    dispatchIntent({
      id: `intent-${overrides.id}`,
      taskId: "t2",
      assignmentId: overrides.id,
      recipient: overrides.agentId,
      messageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      idempotencyKey: `dispatch-${overrides.id}`,
      state: "confirmed",
      confirmedAt: AT_UPDATED,
    }),
  );
}

function review(
  assignmentId = "assignment-t2-r1",
  overrides: Partial<RunReviewReportBlock> = {},
): RunReviewReportBlock {
  return {
    protocolVersion: 1,
    runId: NORMAL_RUN_LEDGER.runId,
    taskId: "t2",
    attempt: 1,
    nonce:
      assignmentId === "assignment-t2-r1"
        ? NONCE_T2_REVIEW
        : "6f1c2a44-3b7e-4f0a-9a11-000000000007",
    assignmentId,
    reviewedRef: REF,
    verdict: "可合入",
    blockers: [],
    probes: [],
    ...overrides,
  } as RunReviewReportBlock;
}

function acceptReviewProof(record: RunRecord, assignmentId: string, block: RunReviewReportBlock) {
  const assignment = record.assignments.find((entry) => entry.assignmentId === assignmentId);
  if (!assignment) throw new Error(`missing ${assignmentId}`);
  assignment.acceptedProof = {
    ...block,
    assignmentId,
    messageId: assignment.messageId,
  } as typeof assignment.acceptedProof;
  const nonce = record.nonceRegistry.find((entry) => entry.assignmentId === assignmentId);
  if (nonce) {
    nonce.acceptedAt = AT_UPDATED;
    nonce.acceptedEventKey = `proof:${assignmentId}`;
  }
}

function reduceOrThrow(record: RunRecord, event: RunReducerEvent): RunRecord {
  const result = reduceRun(record, event, facts);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.next;
}

function reviewReady(record = structuredClone(NORMAL_RUN_LEDGER)): RunRecord {
  record = reduceOrThrow(record, { kind: "task-report", block: report() });
  addReviewer(record, {
    id: "assignment-t2-r1",
    seatId: "seat-b2",
    agentId: "agent-b2",
    tier: "A",
    family: "codex",
  });
  return record;
}

function smokeReady(
  record = reviewReady(),
  smokeOverrides: Partial<RunSmokeReportBlock> = {},
  policyHost = "127.0.0.1:6799",
) {
  const task = taskOf(record, "t2");
  task.spec = {
    ...task.spec,
    devSmoke: true,
    smokeChecklist: ["open runs"],
    dispatchDuties: { ...task.spec.dispatchDuties, smoke: "smoke" },
  };
  record.policy = {
    ...record.policy,
    devTargets: [{ serverId: "dev-server-1", host: policyHost, home: "/tmp/dev-home" }],
  };
  record = reduceOrThrow(record, { kind: "review-report", block: review() });
  const smokeNonce = "6f1c2a44-3b7e-4f0a-9a11-000000000008";
  ensureSeat(record, "seat-b3", "agent-b3", "smoke", "A");
  record.assignments.push(
    assignment({
      assignmentId: "assignment-t2-smoke",
      seatId: "seat-b3",
      agentId: "agent-b3",
      purpose: "smoker",
      nonce: smokeNonce,
      messageId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      delivery: { producerAssignmentId: "assignment-t2-a1" },
    }),
  );
  record.nonceRegistry.push({
    nonce: smokeNonce,
    runId: record.runId,
    taskId: "t2",
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
  record.outbox.push(
    dispatchIntent({
      id: "intent-assignment-t2-smoke",
      taskId: "t2",
      assignmentId: "assignment-t2-smoke",
      recipient: "agent-b3",
      messageId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      idempotencyKey: "dispatch-assignment-t2-smoke",
      state: "confirmed",
      confirmedAt: AT_UPDATED,
    }),
  );
  const block = {
    protocolVersion: 1,
    runId: record.runId,
    taskId: "t2",
    attempt: 1,
    nonce: smokeNonce,
    assignmentId: "assignment-t2-smoke",
    testedRef: REF,
    devHost: policyHost,
    devServerId: "dev-server-1",
    devHome: "/tmp/dev-home",
    checks: [{ id: "open runs", result: "pass", evidencePath: "evidence/smoke.png" }],
    ...smokeOverrides,
  } as RunSmokeReportBlock;
  return { record, block };
}

function cancelIntent(record: RunRecord, kind: "wake" | "archive" = "archive") {
  record.outbox.push(
    dispatchIntent({
      id: INTENT_CANCEL,
      kind,
      assignmentId: ASSIGNMENT_T2,
      taskId: "t2",
      messageId: MESSAGE_CANCEL,
      state: "sending",
      confirmedAt: null,
    }),
  );
}

function cancelPayload(record: RunRecord, assignmentId = ASSIGNMENT_T2) {
  const intent = record.outbox.find((entry) => entry.id === INTENT_CANCEL);
  if (!intent || intent.assignmentId === null) throw new Error("cancel intent");
  return {
    cancelIntents: [{ assignmentId, intentId: intent.id }],
    preparedCancelIntents: [],
  };
}

function reason(result: { ok: boolean; params?: Record<string, unknown> }) {
  return result.ok ? null : result.params?.reason;
}

describe("R03a gates: only reducer-owned raw reports can move a task", () => {
  test("forged gate and force events are rejected", () => {
    for (const kind of ["review-passed", "smoke-passed", "force-done", "dependency-satisfied"]) {
      // Intentional unsupported event boundary; normal events below stay statically typed.
      const result = reduceRun(
        structuredClone(NORMAL_RUN_LEDGER),
        { kind } as unknown as RunReducerEvent,
        facts,
      );
      expect(result).toMatchObject({
        ok: false,
        code: "RUN_EVENT_INVALID",
        params: { reason: "unsupported-in-batch-b" },
      });
    }
  });

  test("a B reviewer cannot approve an L2 delivery", () => {
    const record = reviewReady();
    const reviewer = record.assignments.find((entry) => entry.assignmentId === "assignment-t2-r1");
    if (!reviewer) throw new Error("reviewer");
    reviewer.tier = "B";
    const result = reduceRun(record, { kind: "review-report", block: review() }, facts);
    expect(result).toMatchObject({ ok: false, code: "RUN_EVENT_INVALID" });
    expect(taskOf(record, "t2").state).toBe("review");
  });

  test("a non-mergeable review cannot unlock done", () => {
    const result = reduceRun(
      reviewReady(),
      { kind: "review-report", block: review("assignment-t2-r1", { verdict: "不可合入" }) },
      facts,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(taskOf(result.next, "t2").state).not.toBe("done");
    expect(taskOf(result.next, "t2").qualityFailures).toBe(1);
  });

  test("a blocking review in the smoke phase cannot be swallowed", () => {
    const { record, block } = smokeReady();
    addReviewer(record, {
      id: "assignment-t2-r2",
      seatId: "seat-b4",
      agentId: "agent-b4",
      tier: "A",
      family: "codex",
      nonce: "6f1c2a44-3b7e-4f0a-9a11-000000000007",
    });
    const blocked = reduceRun(
      record,
      {
        kind: "review-report",
        block: review("assignment-t2-r2", {
          verdict: "不可合入",
          blockers: [{ id: "b1", summary: "security", path: "src/t2.ts" }],
        }),
      },
      facts,
    );
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) return;
    expect(taskOf(blocked.next, "t2").qualityFailures).toBe(1);
    const smoked = reduceRun(blocked.next, { kind: "smoke-report", block }, facts);
    expect(smoked.ok).toBe(true);
    if (smoked.ok) expect(taskOf(smoked.next, "t2").state).not.toBe("done");
  });
});

describe("R03a cancellation: two stages, quiescence, and terminal paths", () => {
  test("a dispatched assignment without turn end or authorization stays frozen", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const task = taskOf(record, "t2");
    task.state = "assigned";
    task.phase = "implementation";
    const current = record.assignments.find((entry) => entry.assignmentId === ASSIGNMENT_T2);
    if (!current) throw new Error("assignment");
    current.state = "assigned";
    current.turnId = null;
    record.eventReceipts = record.eventReceipts.filter(
      (receipt) => !(receipt.kind === "turn_started" && receipt.agentId === "agent-b1"),
    );
    record.counters.observationSeq = 8;
    cancelIntent(record, "archive");
    const frozen = reduceRun(
      record,
      {
        kind: "cancel-requested",
        taskIds: ["t2"] as const,
        reason: "cancel",
        ...cancelPayload(record),
        controlNonceDigest: CONTROL_DIGEST,
      },
      facts,
    );
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    const decisionId = frozen.next.decisions[0]?.decisionId;
    if (!decisionId) throw new Error("decision");
    const held = reduceRun(
      frozen.next,
      {
        kind: "cancellation-checked",
        taskId: "t2",
        decisionId,
        evidence: {
          ...QUIESCENT_CANCELLATION,
          lastTurnId: null,
          endedEventKey: null,
          cancelIntentId: INTENT_CANCEL,
          receipt: { kind: "archive", confirmedAt: AT_UPDATED, externalId: "archive-1" },
        },
      },
      facts,
    );
    // The dispatch intent exists, but there is no matching turn_ended and the D1 is still open:
    // an archive receipt alone cannot authorize release.
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    expect(taskOf(held.next, "t2")).toMatchObject({
      state: "blocked",
      phase: "frozen",
      waitingReason: "cancel-not-quiescent",
    });
    expect(held.next.resources[0]?.frozen).toBe(true);
    expect(held.next.decisions[0]?.state).toBe("open");
  });

  test("an in-flight task stays frozen when a later turn starts after the end", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const task = taskOf(record, "t2");
    task.state = "in_progress";
    const current = record.assignments.find((entry) => entry.assignmentId === ASSIGNMENT_T2);
    if (!current) throw new Error("assignment");
    current.turnId = "turn-7";
    current.state = "in_progress";
    current.cancellation = QUIESCENT_CANCELLATION;
    record.eventReceipts.push(
      {
        eventKey: "agent-b1|turn-7|turn_ended",
        kind: "turn_ended",
        agentId: "agent-b1",
        turnId: "turn-7",
        seq: 7,
        receivedAt: AT_UPDATED,
        dedupeKey: "ended-7",
        disposition: "accepted",
      },
      {
        eventKey: "agent-b1|turn-9|turn_started",
        kind: "turn_started",
        agentId: "agent-b1",
        turnId: "turn-9",
        seq: 8,
        receivedAt: AT_UPDATED,
        dedupeKey: "started-9",
        disposition: "accepted",
      },
    );
    record.counters.observationSeq = 8;
    cancelIntent(record);
    const frozen = reduceRun(
      record,
      {
        kind: "cancel-requested",
        taskIds: ["t2"] as const,
        reason: "cancel",
        ...cancelPayload(record),
        controlNonceDigest: CONTROL_DIGEST,
      },
      facts,
    );
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    const decisionId = frozen.next.decisions[0]?.decisionId;
    if (!decisionId) throw new Error("decision");
    const checked = reduceRun(
      frozen.next,
      {
        kind: "cancellation-checked",
        taskId: "t2",
        decisionId,
        evidence: { ...QUIESCENT_CANCELLATION, observationSeq: 8 },
      },
      facts,
    );
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(taskOf(checked.next, "t2").state).toBe("blocked");
      expect(taskOf(checked.next, "t2").phase).toBe("frozen");
    }
  });

  test("pending tasks cancelled by dag-revised and run-cancelled become cancelled", () => {
    const pending = taskOf(structuredClone(NORMAL_RUN_LEDGER), "t3");
    pending.state = "pending";
    const dagRecord = structuredClone(NORMAL_RUN_LEDGER);
    const dagResult = reduceRun(
      dagRecord,
      {
        kind: "dag-revised",
        controlNonceDigest: CONTROL_DIGEST,
        cancelIntents: [],
        preparedCancelIntents: [],
        block: {
          protocolVersion: 1,
          runId: dagRecord.runId,
          taskId: "_dag",
          attempt: 1,
          nonce: NONCE_T2,
          dagRevision: dagRecord.dagRevision + 1,
          expectedDagRevision: dagRecord.dagRevision,
          tasks: dagRecord.tasks.map((task) => task.spec),
          cancelTaskIds: ["t3"],
          budgetRequests: [],
        },
      },
      facts,
    );
    expect(dagResult.ok).toBe(true);
    if (dagResult.ok) expect(taskOf(dagResult.next, "t3").state).toBe("cancelled");

    const runRecord = structuredClone(NORMAL_RUN_LEDGER);
    cancelIntent(runRecord, "archive");
    const runResult = reduceRun(
      runRecord,
      {
        kind: "run-cancelled",
        reason: "stop",
        controlNonceDigest: CONTROL_DIGEST,
        ...cancelPayload(runRecord),
      },
      facts,
    );
    expect(runResult.ok).toBe(true);
    if (runResult.ok) expect(taskOf(runResult.next, "t3").state).toBe("cancelled");
  });

  test("freezing an in-flight task revokes its nonce", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const current = record.assignments.find((entry) => entry.assignmentId === ASSIGNMENT_T2);
    if (!current) throw new Error("assignment");
    current.turnId = "turn-7";
    cancelIntent(record);
    const result = reduceRun(
      record,
      {
        kind: "cancel-requested",
        taskIds: ["t2"] as const,
        reason: "cancel",
        ...cancelPayload(record),
        controlNonceDigest: CONTROL_DIGEST,
      },
      facts,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.next.nonceRegistry.find((entry) => entry.taskId === "t2")?.revokedAt,
    ).not.toBeNull();
  });
});

describe("R03a locks and invariants", () => {
  function withClaims(claims: RunRecord["resources"]): RunRecord {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.resources = claims;
    taskOf(record, "t2").state = "in_progress";
    const t3 = taskOf(record, "t3");
    t3.state = "assigned";
    t3.spec = { ...t3.spec, deps: [] };
    return record;
  }

  test("a directory claim covers descendants but hot/tool names are exact", () => {
    const directory = withClaims([
      claim({ claimId: "dir", taskId: "t2", kind: "directory", path: "src" }),
      claim({ claimId: "file", taskId: "t3", kind: "file", path: "src/t3.ts" }),
    ]);
    const result = checkLedgerInvariants(directory);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.violations.some(
          (entry) => entry.invariant === "I3" && entry.params.reason === "overlapping-claim",
        ),
      ).toBe(true);
    }
    const hot = withClaims([
      claim({ claimId: "hot-a", taskId: "t2", kind: "hot", path: "repo:hot" }),
      claim({ claimId: "hot-b", taskId: "t3", kind: "hot", path: "repo:hot:child" }),
    ]);
    const hotResult = checkLedgerInvariants(hot);
    expect(hotResult.ok).toBe(true);
  });

  test("read/write excludes self and a frozen blocked claim is legal", () => {
    const rw = withClaims([
      claim({ claimId: "read", taskId: "t2", access: "read" }),
      claim({ claimId: "write", taskId: "t3", access: "write" }),
    ]);
    expect(checkLedgerInvariants(rw).ok).toBe(false);
    const self = withClaims([
      claim({ claimId: "a", taskId: "t2", kind: "directory", path: "src" }),
      claim({ claimId: "b", taskId: "t2", kind: "file", path: "src/t2.ts" }),
    ]);
    const selfResult = checkLedgerInvariants(self);
    expect(
      selfResult.ok ||
        selfResult.violations.every((entry) => entry.params.reason !== "overlapping-claim"),
    ).toBe(true);
    const frozen = withClaims([claim({ claimId: "frozen", taskId: "t2", frozen: true })]);
    taskOf(frozen, "t2").state = "blocked";
    taskOf(frozen, "t2").phase = "frozen";
    expect(checkLedgerInvariants(frozen).ok).toBe(true);
    const unfrozen = structuredClone(frozen);
    unfrozen.resources[0].frozen = false;
    expect(checkLedgerInvariants(unfrozen).ok).toBe(false);
  });

  test("a revoked nonce cannot remain on an active task", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const nonce = record.nonceRegistry.find((entry) => entry.taskId === "t2");
    if (!nonce) throw new Error("nonce");
    nonce.revokedAt = AT_UPDATED;
    const result = checkLedgerInvariants(record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.violations.some(
          (entry) => entry.invariant === "I5" && entry.params.reason === "revoked-nonce-active",
        ),
      ).toBe(true);
    }
  });
});

describe("R03a DAG, pause, finish, determinism", () => {
  test("dag revisions cannot change an active spec or skip a revision", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const changed = reduceRun(
      record,
      {
        kind: "dag-revised",
        controlNonceDigest: CONTROL_DIGEST,
        cancelIntents: [],
        preparedCancelIntents: [],
        block: {
          protocolVersion: 1,
          runId: record.runId,
          taskId: "_dag",
          attempt: 1,
          nonce: NONCE_T2,
          dagRevision: record.dagRevision + 1,
          expectedDagRevision: record.dagRevision,
          tasks: [spec("t2", "Changed in flight")],
          cancelTaskIds: [],
          budgetRequests: [],
        },
      },
      facts,
    );
    expect(changed).toMatchObject({ ok: false, params: { reason: "active-task-changed" } });
    const jumped = reduceRun(
      record,
      {
        kind: "dag-revised",
        controlNonceDigest: CONTROL_DIGEST,
        cancelIntents: [],
        preparedCancelIntents: [],
        block: {
          protocolVersion: 1,
          runId: record.runId,
          taskId: "_dag",
          attempt: 1,
          nonce: NONCE_T2,
          dagRevision: record.dagRevision + 2,
          expectedDagRevision: record.dagRevision,
          tasks: record.tasks.map((task) => task.spec),
          cancelTaskIds: [],
          budgetRequests: [],
        },
      },
      facts,
    );
    expect(jumped).toMatchObject({ ok: false, params: { reason: "stale-dag" } });
  });

  test("a paused run refuses new dispatch but accepts an already-received report", () => {
    const paused = reduceRun(structuredClone(NORMAL_RUN_LEDGER), { kind: "run-paused" }, facts);
    expect(paused.ok).toBe(true);
    if (!paused.ok) return;
    const record = structuredClone(paused.next);
    const nonce = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const dispatch = reduceRun(
      record,
      {
        kind: "task-dispatched",
        taskId: "t2",
        assignment: assignment({
          assignmentId: "assignment-paused",
          taskId: "t2",
          attempt: 2,
          nonce,
        }),
        nonce: {
          nonce,
          runId: record.runId,
          taskId: "t2",
          assignmentId: "assignment-paused",
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
          id: "intent-paused",
          assignmentId: "assignment-paused",
          messageId: MESSAGE_T2,
        }),
        reissueOfAssignmentId: null,
      },
      facts,
    );
    expect(dispatch).toMatchObject({ ok: false, params: { reason: "illegal-transition" } });
    const reportValue = reduceRun(paused.next, { kind: "task-report", block: report() }, facts);
    expect(reportValue.ok).toBe(true);
    if (reportValue.ok) expect(taskOf(reportValue.next, "t2").state).toBe("review");
  });

  test("run-finished requires terminal tasks, no open intents and no claims", () => {
    expect(
      reduceRun(structuredClone(NORMAL_RUN_LEDGER), { kind: "run-finished" }, facts),
    ).toMatchObject({ ok: false, code: "RUN_INVALID_TRANSITION" });
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.tasks = [];
    record.assignments = [];
    record.nonceRegistry = [];
    record.outbox = [];
    record.resources = [];
    expect(reduceRun(record, { kind: "run-finished" }, facts)).toMatchObject({ ok: true });
  });

  test("the reducer is deterministic and does not mutate its input", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const before = JSON.stringify(record);
    const first = reduceRun(record, { kind: "run-paused" }, facts);
    const second = reduceRun(record, { kind: "run-paused" }, facts);
    expect(first).toEqual(second);
    expect(JSON.stringify(record)).toBe(before);
  });
});

describe("R03a I7 done gate", () => {
  test("a done task without a report is rejected by the invariant checker", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const producer = record.assignments.find((entry) => entry.assignmentId === "assignment-t1-a1");
    if (producer) producer.acceptedProof = null;
    const nonce = record.nonceRegistry.find((entry) => entry.assignmentId === "assignment-t1-a1");
    if (nonce) {
      nonce.acceptedAt = null;
      nonce.acceptedEventKey = null;
    }
    const result = checkLedgerInvariants(record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((entry) => entry.invariant === "I7")).toBe(true);
    }
  });
});

describe("R03a gate details and invariant boundaries", () => {
  test("L1 accepts only a different-family B reviewer", () => {
    const same = reviewReady();
    taskOf(same, "t2").spec = { ...taskOf(same, "t2").spec, level: "L1" };
    const sameReviewer = same.assignments.find(
      (entry) => entry.assignmentId === "assignment-t2-r1",
    );
    if (!sameReviewer) throw new Error("reviewer");
    sameReviewer.tier = "B";
    sameReviewer.family = "haiku";
    expect(reason(reduceRun(same, { kind: "review-report", block: review() }, facts))).toBe(
      "no-valid-review",
    );

    const other = reviewReady();
    taskOf(other, "t2").spec = { ...taskOf(other, "t2").spec, level: "L1" };
    const otherReviewer = other.assignments.find(
      (entry) => entry.assignmentId === "assignment-t2-r1",
    );
    if (!otherReviewer) throw new Error("reviewer");
    otherReviewer.tier = "B";
    otherReviewer.family = "codex";
    const result = reduceRun(other, { kind: "review-report", block: review() }, facts);
    expect(result.ok).toBe(true);
    if (result.ok) expect(taskOf(result.next, "t2").state).toBe("done");
  });

  test("an escalation origin raises the required review tier", () => {
    const record = reviewReady();
    taskOf(record, "t2").spec = { ...taskOf(record, "t2").spec, level: "L1" };
    addReviewer(record, {
      id: "assignment-t2-r0",
      seatId: "seat-b5",
      agentId: "agent-b5",
      tier: "A",
      family: "codex",
      nonce: "6f1c2a44-3b7e-4f0a-9a11-000000000006",
    });
    const failedReviewer = record.assignments.find(
      (entry) => entry.assignmentId === "assignment-t2-r0",
    );
    if (failedReviewer) {
      failedReviewer.state = "ended";
      failedReviewer.turnId = "turn-r0";
      failedReviewer.endedAt = AT_UPDATED;
      failedReviewer.endedEventKey = "agent-b5|turn-r0|turn_ended";
    }
    record.counters.observationSeq += 1;
    record.eventReceipts.push({
      eventKey: "agent-b5|turn-r0|turn_ended",
      kind: "turn_ended",
      agentId: "agent-b5",
      turnId: "turn-r0",
      seq: record.counters.observationSeq,
      receivedAt: AT_UPDATED,
      dedupeKey: "agent-b5|turn-r0|turn_ended",
      disposition: "accepted",
    });
    acceptReviewProof(
      record,
      "assignment-t2-r0",
      review("assignment-t2-r0", {
        nonce: "6f1c2a44-3b7e-4f0a-9a11-000000000006",
        verdict: "不可合入",
        blockers: [{ id: "f0", summary: "failed delivery", path: "src/t2.ts" }],
      }),
    );
    taskOf(record, "t2").qualityFailures = 1;
    taskOf(record, "t2").attempts = 1;
    taskOf(record, "t2").escalations = [
      { fromTier: "B", toTier: "A", atAttempt: 1, qualityFailures: 1, at: AT_UPDATED },
    ];
    const reviewer = record.assignments.find((entry) => entry.assignmentId === "assignment-t2-r1");
    if (!reviewer) throw new Error("reviewer");
    reviewer.tier = "B";
    reviewer.family = "codex";
    expect(reason(reduceRun(record, { kind: "review-report", block: review() }, facts))).toBe(
      "no-valid-review",
    );
  });

  test("evidence outside the write scope, wrong command and real home stay in progress", () => {
    for (const overrides of [
      { changedFiles: ["src/outside.ts"] },
      { evidence: [{ ...report().evidence[0], command: "echo wrong" }] },
      {
        evidence: [
          {
            ...report().evidence[0],
            isolation: {
              homePath: "C:/Users/cc/.paseo",
              outsideRealHome: true,
            },
          },
        ],
      },
    ]) {
      const record = structuredClone(NORMAL_RUN_LEDGER);
      const result = reduceRun(
        record,
        { kind: "task-report", block: report(overrides as never) },
        facts,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(taskOf(result.next, "t2").state).toBe("in_progress");
        expect(taskOf(result.next, "t2").evidenceReturns).toBe(1);
      }
    }
  });

  test("a revoked nonce is rejected at task-report", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const nonce = record.nonceRegistry.find((entry) => entry.taskId === "t2");
    if (!nonce) throw new Error("nonce");
    nonce.revokedAt = AT_UPDATED;
    expect(reason(reduceRun(record, { kind: "task-report", block: report() }, facts))).toBe(
      "revoked-nonce-active",
    );
  });

  test("review-report rechecks the evidence gate", () => {
    const record = reviewReady();
    const producer = record.assignments.find((entry) => entry.assignmentId === ASSIGNMENT_T2);
    if (producer) producer.acceptedProof = null;
    const nonce = record.nonceRegistry.find((entry) => entry.assignmentId === ASSIGNMENT_T2);
    if (nonce) {
      nonce.acceptedAt = null;
      nonce.acceptedEventKey = null;
    }
    expect(reduceRun(record, { kind: "review-report", block: review() }, facts).ok).toBe(false);
  });

  test("default DEV host, extra smoke checks and self-smoke cannot complete", () => {
    const defaultHost = smokeReady(reviewReady(), {}, "127.0.0.1:6767");
    const defaultResult = reduceRun(
      defaultHost.record,
      { kind: "smoke-report", block: { ...defaultHost.block, devHost: "127.0.0.1:6767" } },
      facts,
    );
    expect(defaultResult.ok).toBe(true);
    if (defaultResult.ok) expect(taskOf(defaultResult.next, "t2").state).not.toBe("done");

    const extra = smokeReady();
    extra.block.checks = [
      ...extra.block.checks,
      { id: "extra", result: "pass", evidencePath: "evidence/extra.png" },
    ];
    const extraResult = reduceRun(
      extra.record,
      { kind: "smoke-report", block: extra.block },
      facts,
    );
    expect(extraResult.ok).toBe(true);
    if (extraResult.ok) expect(taskOf(extraResult.next, "t2").state).not.toBe("done");

    const self = smokeReady();
    const smoker = self.record.assignments.find(
      (entry) => entry.assignmentId === "assignment-t2-smoke",
    );
    if (!smoker) throw new Error("smoker");
    smoker.agentId = "agent-b1";
    smoker.seatId = "seat-b1";
    const smokeNonceEntry = self.record.nonceRegistry.find((entry) => entry.nonce === smoker.nonce);
    if (!smokeNonceEntry) throw new Error("smoke nonce");
    smokeNonceEntry.agentId = "agent-b1";
    smokeNonceEntry.seatId = "seat-b1";
    const selfResult = reduceRun(self.record, { kind: "smoke-report", block: self.block }, facts);
    expect(selfResult.ok).toBe(true);
    if (selfResult.ok) expect(taskOf(selfResult.next, "t2").state).not.toBe("done");
  });

  test("directory/directory overlap and blocked phase mismatch are violations", () => {
    const directory = structuredClone(NORMAL_RUN_LEDGER);
    directory.resources = [
      claim({ claimId: "d1", taskId: "t2", kind: "directory", path: "src" }),
      claim({ claimId: "d2", taskId: "t3", kind: "directory", path: "src/sub" }),
    ];
    taskOf(directory, "t3").state = "assigned";
    taskOf(directory, "t3").spec = { ...taskOf(directory, "t3").spec, deps: [] };
    const dirResult = checkLedgerInvariants(directory);
    expect(dirResult.ok).toBe(false);

    const phase = structuredClone(NORMAL_RUN_LEDGER);
    taskOf(phase, "t2").state = "blocked";
    taskOf(phase, "t2").phase = "implementation";
    phase.resources = [claim({ frozen: true })];
    const phaseResult = checkLedgerInvariants(phase);
    expect(phaseResult.ok).toBe(false);
    if (!phaseResult.ok) {
      expect(
        phaseResult.violations.some(
          (entry) => entry.invariant === "I3" && entry.params.reason === "blocked-frozen-phase",
        ),
      ).toBe(true);
    }
  });

  test("quiescence rejects a stale observation and a refresh before the end", () => {
    for (const evidence of [
      { ...QUIESCENT_CANCELLATION, observationSeq: 1 },
      { ...QUIESCENT_CANCELLATION, refreshObservedAt: "2020-01-01T00:00:00.000Z" },
    ]) {
      const record = structuredClone(NORMAL_RUN_LEDGER);
      const task = taskOf(record, "t2");
      task.state = "in_progress";
      const current = record.assignments.find((entry) => entry.assignmentId === ASSIGNMENT_T2);
      if (!current) throw new Error("assignment");
      current.turnId = "turn-7";
      current.cancellation = evidence;
      record.eventReceipts.push({
        eventKey: "agent-b1|turn-7|turn_ended",
        kind: "turn_ended",
        agentId: "agent-b1",
        turnId: "turn-7",
        seq: 7,
        receivedAt: AT_UPDATED,
        dedupeKey: `ended-${evidence.observationSeq}`,
        disposition: "accepted",
      });
      record.counters.observationSeq = 8;
      cancelIntent(record);
      const frozen = reduceRun(
        record,
        {
          kind: "cancel-requested",
          taskIds: ["t2"] as const,
          reason: "cancel",
          ...cancelPayload(record),
          controlNonceDigest: CONTROL_DIGEST,
        },
        facts,
      );
      expect(frozen.ok).toBe(true);
      if (!frozen.ok) continue;
      const decisionId = frozen.next.decisions[0]?.decisionId;
      if (!decisionId) throw new Error("decision");
      const checked = reduceRun(
        frozen.next,
        { kind: "cancellation-checked", taskId: "t2", decisionId, evidence },
        facts,
      );
      expect(checked.ok).toBe(true);
      if (checked.ok) expect(taskOf(checked.next, "t2").state).toBe("blocked");
    }
  });

  test("dispatch at configured capacity is rejected", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.policy = { ...record.policy, configuredConcurrency: 1 };
    const t3 = taskOf(record, "t3");
    t3.state = "ready";
    t3.spec = { ...t3.spec, deps: [] };
    t3.attempts = 0;
    const nonce = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const result = reduceRun(
      record,
      {
        kind: "task-dispatched",
        taskId: "t3",
        assignment: assignment({ assignmentId: "assignment-t3-a1", taskId: "t3", nonce }),
        nonce: {
          nonce,
          runId: record.runId,
          taskId: "t3",
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
          taskId: "t3",
          assignmentId: "assignment-t3-a1",
          messageId: MESSAGE_T2,
        }),
        reissueOfAssignmentId: null,
      },
      facts,
    );
    expect(result).toMatchObject({ ok: false, params: { reason: "capacity" } });
  });
});

describe("R01f cancellation authorization and refresh evidence", () => {
  const refresh = {
    agentId: "agent-b1",
    status: "idle" as const,
    activeTurn: false as const,
    observedAt: AT_UPDATED,
  };

  function cancellationRecord(
    decisionOverrides: Partial<RunRecord["decisions"][number]> = {},
    evidenceOverrides: Partial<RunCancellationEvidence> = {},
    recipient = "agent-b1",
  ) {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const task = taskOf(record, "t2");
    task.state = "blocked";
    task.phase = "frozen";
    task.frozenClaimId = "claim-t2";
    const current = record.assignments.find((entry) => entry.assignmentId === ASSIGNMENT_T2);
    if (!current) throw new Error("assignment");
    current.turnId = "turn-7";
    current.state = "in_progress";
    record.resources = [claim({ frozen: true })];
    record.outbox.push(
      dispatchIntent({
        id: INTENT_CANCEL,
        kind: "archive",
        assignmentId: ASSIGNMENT_T2,
        taskId: "t2",
        recipient,
        messageId: MESSAGE_CANCEL,
        state: "confirmed",
        confirmedAt: AT_UPDATED,
      }),
    );
    record.eventReceipts.push({
      eventKey: "agent-b1|turn-7|turn_ended",
      kind: "turn_ended",
      agentId: "agent-b1",
      turnId: "turn-7",
      seq: 7,
      receivedAt: AT_UPDATED,
      dedupeKey: "r01f-ended-7",
      disposition: "accepted",
    });
    record.counters.observationSeq = 8;
    record.decisions = [
      {
        decisionId: DECISION_D1,
        category: "D1",
        controlNonceDigest: CONTROL_DIGEST,
        state: "answered",
        dedupeKey: "cancel:t2",
        subjectId: "t2",
        summary: "cancel t2",
        createdAt: AT_UPDATED,
        answeredAt: AT_UPDATED,
        answer: { action: "cancel", taskIds: ["t2"], answeredAt: AT_UPDATED },
        cancelIntents: [{ assignmentId: ASSIGNMENT_T2, intentId: INTENT_CANCEL }],
        resolution: null,
        ...decisionOverrides,
      } as RunRecord["decisions"][number],
    ];
    const evidence = {
      ...QUIESCENT_CANCELLATION,
      refresh,
      ...evidenceOverrides,
    } as RunCancellationEvidence;
    return { record, evidence };
  }

  test("an answered cancel decision plus idle refresh releases the frozen claim", () => {
    const { record, evidence } = cancellationRecord();
    const result = reduceRun(
      record,
      { kind: "cancellation-checked", taskId: "t2", decisionId: DECISION_D1, evidence },
      facts,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(taskOf(result.next, "t2").state).toBe("cancelled");
    expect(result.next.resources).toEqual([]);
  });

  const freezeCases: Array<
    [string, () => { record: RunRecord; evidence: CancellationObservation }]
  > = [
    [
      "missing refresh",
      () => {
        const base = cancellationRecord();
        return {
          ...base,
          evidence: { ...base.evidence, refresh: null } as CancellationObservation,
        };
      },
    ],
    [
      "agent busy",
      () =>
        cancellationRecord({}, {
          refresh: { ...refresh, status: "busy" },
        } as unknown as Partial<RunCancellationEvidence>),
    ],
    [
      "active turn",
      () =>
        cancellationRecord({}, {
          refresh: { ...refresh, activeTurn: true },
        } as unknown as Partial<RunCancellationEvidence>),
    ],
    ["wrong intent recipient", () => cancellationRecord({}, {}, "agent-other")],
    ["D1 still open", () => cancellationRecord({ state: "open", answeredAt: null, answer: null })],
    [
      "resume-seat decision",
      () =>
        cancellationRecord({
          answer: { action: "resume-seat", taskIds: ["t2"], answeredAt: AT_UPDATED },
        }),
    ],
    [
      "null turnId",
      () => {
        const base = cancellationRecord({}, { lastTurnId: null, endedEventKey: null });
        const current = base.record.assignments.find(
          (entry) => entry.assignmentId === ASSIGNMENT_T2,
        );
        if (current) current.turnId = null;
        return base;
      },
    ],
  ];

  for (const [label, make] of freezeCases) {
    test(`${label} keeps the task frozen`, () => {
      const { record, evidence } = make();
      const result = reduceRun(
        record,
        { kind: "cancellation-checked", taskId: "t2", decisionId: DECISION_D1, evidence },
        facts,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const task = taskOf(result.next, "t2");
      expect(task.state).toBe("blocked");
      expect(task.phase).toBe("frozen");
      expect(result.next.resources[0]?.frozen).toBe(true);
    });
  }
});

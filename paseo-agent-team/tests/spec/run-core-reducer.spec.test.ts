// R03a reducer specification, written from 02 (AC-RE1.8, RE3.1, RE3.5, RE3.8), 05 (state machine,
// I1-I8, two-stage cancellation) and 141 R3a-1..9. Every case starts from the legal baseline and
// changes one thing; assertions are on the returned record or the rejection code/path.
import { describe, expect, test } from "vitest";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import { reduceRun } from "../../shared/domain/run-engine/reducer";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
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
      messageId: null,
    }),
  );
  record.nonceRegistry.push({
    nonce:
      overrides.nonce ??
      (overrides.id === "assignment-t2-r1"
        ? NONCE_T2_REVIEW
        : "6f1c2a44-3b7e-4f0a-9a11-000000000007"),
    runId: record.runId,
    taskId: "T2",
    assignmentId: overrides.id,
    attempt: 1,
    phase: "review",
    agentId: overrides.agentId,
    seatId: overrides.seatId,
    issuedAt: AT_UPDATED,
    acceptedAt: AT_UPDATED,
    acceptedEventKey: `${overrides.agentId}|turn-8|turn_ended`,
    revokedAt: null,
    revokeReason: null,
  });
}

function review(
  assignmentId = "assignment-t2-r1",
  overrides: Partial<RunReviewReportBlock> = {},
): RunReviewReportBlock {
  return {
    protocolVersion: 1,
    runId: NORMAL_RUN_LEDGER.runId,
    taskId: "T2",
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

function reviewReady(record = structuredClone(NORMAL_RUN_LEDGER)): RunRecord {
  const task = taskOf(record, "T2");
  task.state = "review";
  task.phase = "review";
  task.ref = REF;
  task.report = report();
  addReviewer(record, {
    id: "assignment-t2-r1",
    seatId: "seat-b2",
    agentId: "agent-b2",
    tier: "A",
    family: "codex",
  });
  return record;
}

function cancelIntent(record: RunRecord, kind: "wake" | "archive" = "wake") {
  record.outbox.push(
    dispatchIntent({
      id: INTENT_CANCEL,
      kind,
      assignmentId: ASSIGNMENT_T2,
      taskId: "T2",
      messageId: MESSAGE_CANCEL,
      state: "sending",
      confirmedAt: null,
    }),
  );
}

function reason(result: { ok: boolean; params?: Record<string, unknown> }) {
  return result.ok ? null : result.params?.reason;
}

describe("R03a gates: only reducer-owned raw reports can move a task", () => {
  test("forged gate and force events are rejected", () => {
    for (const kind of ["review-passed", "smoke-passed", "force-done", "dependency-satisfied"]) {
      const result = reduceRun(structuredClone(NORMAL_RUN_LEDGER), { kind } as never, facts);
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
    expect(taskOf(record, "T2").state).toBe("review");
  });

  test("a non-mergeable review cannot unlock done", () => {
    const result = reduceRun(
      reviewReady(),
      { kind: "review-report", block: review("assignment-t2-r1", { verdict: "不可合入" }) },
      facts,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(taskOf(result.next, "T2").state).not.toBe("done");
    expect(taskOf(result.next, "T2").qualityFailures).toBe(1);
  });

  test("a blocking review in the smoke phase cannot be swallowed", () => {
    const record = reviewReady();
    const task = taskOf(record, "T2");
    task.spec = { ...task.spec, devSmoke: true, smokeChecklist: ["open runs"] };
    task.phase = "smoke";
    task.reviews = [
      {
        assignmentId: "assignment-t2-r1",
        reviewerAgentId: "agent-b2",
        reviewerSeatId: "seat-b2",
        verdict: "可合入",
        reviewedRef: REF,
        blockers: [],
      },
    ];
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
    const smokeAssignment = "assignment-t2-smoke";
    const smokeNonce = "6f1c2a44-3b7e-4f0a-9a11-000000000008";
    blocked.next.assignments.push(
      assignment({
        assignmentId: smokeAssignment,
        seatId: "seat-b3",
        agentId: "agent-b3",
        purpose: "smoker",
        nonce: smokeNonce,
        messageId: null,
      }),
    );
    blocked.next.nonceRegistry.push({
      nonce: smokeNonce,
      runId: blocked.next.runId,
      taskId: "T2",
      assignmentId: smokeAssignment,
      attempt: 1,
      phase: "smoke",
      agentId: "agent-b3",
      seatId: "seat-b3",
      issuedAt: AT_UPDATED,
      acceptedAt: AT_UPDATED,
      acceptedEventKey: "agent-b3|turn-9|turn_ended",
      revokedAt: null,
      revokeReason: null,
    });
    const smokeBlock = {
      protocolVersion: 1,
      runId: blocked.next.runId,
      taskId: "T2",
      attempt: 1,
      nonce: smokeNonce,
      assignmentId: smokeAssignment,
      testedRef: REF,
      devHost: "127.0.0.1:6799",
      devServerId: "dev-server-1",
      devHome: "/tmp/dev-home",
      checks: [{ id: "open runs", result: "pass", evidencePath: "evidence/smoke.png" }],
    } as RunSmokeReportBlock;
    const smoked = reduceRun(blocked.next, { kind: "smoke-report", block: smokeBlock }, facts);
    expect(smoked.ok).toBe(true);
    if (!smoked.ok) return;
    expect(taskOf(smoked.next, "T2").state).not.toBe("done");
  });
});

describe("R03a cancellation: two stages, quiescence, and terminal paths", () => {
  test("a never-started assignment can be cancelled with a fresh archive receipt", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const task = taskOf(record, "T2");
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
    const released = reduceRun(
      frozen.next,
      {
        kind: "cancellation-checked",
        taskId: "T2",
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
    expect(released.ok).toBe(true);
    if (released.ok) expect(taskOf(released.next, "T2").state).toBe("cancelled");
  });

  test("an in-flight task stays frozen when a later turn starts after the end", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const task = taskOf(record, "T2");
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
    const checked = reduceRun(
      frozen.next,
      {
        kind: "cancellation-checked",
        taskId: "T2",
        decisionId,
        evidence: { ...QUIESCENT_CANCELLATION, observationSeq: 8 },
      },
      facts,
    );
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(taskOf(checked.next, "T2").state).toBe("blocked");
      expect(taskOf(checked.next, "T2").phase).toBe("frozen");
    }
  });

  test("pending tasks cancelled by dag-revised and run-cancelled become cancelled", () => {
    const pending = taskOf(structuredClone(NORMAL_RUN_LEDGER), "T3");
    pending.state = "pending";
    const dagRecord = structuredClone(NORMAL_RUN_LEDGER);
    const dagResult = reduceRun(
      dagRecord,
      {
        kind: "dag-revised",
        controlNonceDigest: CONTROL_DIGEST,
        block: {
          protocolVersion: 1,
          runId: dagRecord.runId,
          taskId: "_dag",
          attempt: 1,
          nonce: NONCE_T2,
          dagRevision: dagRecord.dagRevision + 1,
          expectedDagRevision: dagRecord.dagRevision,
          tasks: dagRecord.tasks.map((task) => task.spec),
          cancelTaskIds: ["T3"],
          budgetRequests: [],
        },
      },
      facts,
    );
    expect(dagResult.ok).toBe(true);
    if (dagResult.ok) expect(taskOf(dagResult.next, "T3").state).toBe("cancelled");

    const runRecord = structuredClone(NORMAL_RUN_LEDGER);
    const runResult = reduceRun(
      runRecord,
      { kind: "run-cancelled", reason: "stop", controlNonceDigest: CONTROL_DIGEST },
      facts,
    );
    expect(runResult.ok).toBe(true);
    if (runResult.ok) expect(taskOf(runResult.next, "T3").state).toBe("cancelled");
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
        taskIds: ["T2"],
        reason: "cancel",
        cancelIntentId: INTENT_CANCEL,
        controlNonceDigest: CONTROL_DIGEST,
      },
      facts,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.next.nonceRegistry.find((entry) => entry.taskId === "T2")?.revokedAt,
    ).not.toBeNull();
  });
});

describe("R03a locks and invariants", () => {
  function withClaims(claims: RunRecord["resources"]): RunRecord {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.resources = claims;
    taskOf(record, "T2").state = "in_progress";
    const t3 = taskOf(record, "T3");
    t3.state = "assigned";
    t3.spec = { ...t3.spec, deps: [] };
    return record;
  }

  test("a directory claim covers descendants but hot/tool names are exact", () => {
    const directory = withClaims([
      claim({ claimId: "dir", taskId: "T2", kind: "directory", path: "src" }),
      claim({ claimId: "file", taskId: "T3", kind: "file", path: "src/t3.ts" }),
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
      claim({ claimId: "hot-a", taskId: "T2", kind: "hot", path: "repo:hot" }),
      claim({ claimId: "hot-b", taskId: "T3", kind: "hot", path: "repo:hot:child" }),
    ]);
    const hotResult = checkLedgerInvariants(hot);
    expect(hotResult.ok).toBe(true);
  });

  test("read/write excludes self and a frozen blocked claim is legal", () => {
    const rw = withClaims([
      claim({ claimId: "read", taskId: "T2", access: "read" }),
      claim({ claimId: "write", taskId: "T3", access: "write" }),
    ]);
    expect(checkLedgerInvariants(rw).ok).toBe(false);
    const self = withClaims([
      claim({ claimId: "a", taskId: "T2", kind: "directory", path: "src" }),
      claim({ claimId: "b", taskId: "T2", kind: "file", path: "src/t2.ts" }),
    ]);
    const selfResult = checkLedgerInvariants(self);
    expect(
      selfResult.ok ||
        selfResult.violations.every((entry) => entry.params.reason !== "overlapping-claim"),
    ).toBe(true);
    const frozen = withClaims([claim({ claimId: "frozen", taskId: "T2", frozen: true })]);
    taskOf(frozen, "T2").state = "blocked";
    taskOf(frozen, "T2").phase = "frozen";
    expect(checkLedgerInvariants(frozen).ok).toBe(true);
    const unfrozen = structuredClone(frozen);
    unfrozen.resources[0].frozen = false;
    expect(checkLedgerInvariants(unfrozen).ok).toBe(false);
  });

  test("a revoked nonce cannot remain on an active task", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const nonce = record.nonceRegistry.find((entry) => entry.taskId === "T2");
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
        block: {
          protocolVersion: 1,
          runId: record.runId,
          taskId: "_dag",
          attempt: 1,
          nonce: NONCE_T2,
          dagRevision: record.dagRevision + 1,
          expectedDagRevision: record.dagRevision,
          tasks: [spec("T2", "Changed in flight")],
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
    const task = taskOf(record, "T2");
    task.state = "ready";
    task.attempts = 0;
    const nonce = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const dispatch = reduceRun(
      record,
      {
        kind: "task-dispatched",
        taskId: "T2",
        assignment: assignment({ assignmentId: "assignment-paused", taskId: "T2", nonce }),
        nonce: {
          nonce,
          runId: record.runId,
          taskId: "T2",
          assignmentId: "assignment-paused",
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
          id: "intent-paused",
          assignmentId: "assignment-paused",
          messageId: MESSAGE_T2,
        }),
      },
      facts,
    );
    expect(dispatch).toMatchObject({ ok: false, params: { reason: "task-dispatched" } });
    const reportValue = reduceRun(paused.next, { kind: "task-report", block: report() }, facts);
    expect(reportValue.ok).toBe(true);
    if (reportValue.ok) expect(taskOf(reportValue.next, "T2").state).toBe("review");
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
    delete (taskOf(record, "T1") as Record<string, unknown>).report;
    const result = checkLedgerInvariants(record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.violations.some(
          (entry) => entry.invariant === "I7" && entry.params.reason === "missing-done-report",
        ),
      ).toBe(true);
    }
  });
});

describe("R03a gate details and invariant boundaries", () => {
  function smokeReady(
    record = reviewReady(),
    smokeOverrides: Partial<RunSmokeReportBlock> = {},
    policyHost = "127.0.0.1:6799",
  ) {
    const task = taskOf(record, "T2");
    task.spec = { ...task.spec, devSmoke: true, smokeChecklist: ["open runs"] };
    task.phase = "smoke";
    task.reviews = [
      {
        assignmentId: "assignment-t2-r1",
        reviewerAgentId: "agent-b2",
        reviewerSeatId: "seat-b2",
        verdict: "可合入",
        reviewedRef: REF,
        blockers: [],
      },
    ];
    record.policy = {
      ...record.policy,
      devTargets: [{ serverId: "dev-server-1", host: policyHost, home: "/tmp/dev-home" }],
    };
    const smokeNonce = "6f1c2a44-3b7e-4f0a-9a11-000000000008";
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
      acceptedAt: AT_UPDATED,
      acceptedEventKey: "agent-b3|turn-9|turn_ended",
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
      testedRef: REF,
      devHost: policyHost,
      devServerId: "dev-server-1",
      devHome: "/tmp/dev-home",
      checks: [{ id: "open runs", result: "pass", evidencePath: "evidence/smoke.png" }],
      ...smokeOverrides,
    } as RunSmokeReportBlock;
    return { record, block };
  }

  test("L1 accepts only a different-family B reviewer", () => {
    const same = reviewReady();
    taskOf(same, "T2").spec = { ...taskOf(same, "T2").spec, level: "L1" };
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
    taskOf(other, "T2").spec = { ...taskOf(other, "T2").spec, level: "L1" };
    const otherReviewer = other.assignments.find(
      (entry) => entry.assignmentId === "assignment-t2-r1",
    );
    if (!otherReviewer) throw new Error("reviewer");
    otherReviewer.tier = "B";
    otherReviewer.family = "codex";
    const result = reduceRun(other, { kind: "review-report", block: review() }, facts);
    expect(result.ok).toBe(true);
    if (result.ok) expect(taskOf(result.next, "T2").state).toBe("done");
  });

  test("an escalation origin raises the required review tier", () => {
    const record = reviewReady();
    taskOf(record, "T2").spec = { ...taskOf(record, "T2").spec, level: "L1" };
    taskOf(record, "T2").escalations = [
      { fromTier: "B", toTier: "A", atAttempt: 1, qualityFailures: 0, at: AT_UPDATED },
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
        expect(taskOf(result.next, "T2").state).toBe("in_progress");
        expect(taskOf(result.next, "T2").evidenceReturns).toBe(1);
      }
    }
  });

  test("a revoked nonce is rejected at task-report", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const nonce = record.nonceRegistry.find((entry) => entry.taskId === "T2");
    if (!nonce) throw new Error("nonce");
    nonce.revokedAt = AT_UPDATED;
    expect(reason(reduceRun(record, { kind: "task-report", block: report() }, facts))).toBe(
      "nonce-invalid",
    );
  });

  test("review-report rechecks the evidence gate", () => {
    const record = reviewReady();
    delete (taskOf(record, "T2") as Record<string, unknown>).report;
    expect(reason(reduceRun(record, { kind: "review-report", block: review() }, facts))).toBe(
      "missing-done-report",
    );
  });

  test("default DEV host, extra smoke checks and self-smoke cannot complete", () => {
    const defaultHost = smokeReady(reviewReady(), {}, "127.0.0.1:6767");
    const defaultResult = reduceRun(
      defaultHost.record,
      { kind: "smoke-report", block: { ...defaultHost.block, devHost: "127.0.0.1:6767" } },
      facts,
    );
    expect(defaultResult.ok).toBe(true);
    if (defaultResult.ok) expect(taskOf(defaultResult.next, "T2").state).not.toBe("done");

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
    if (extraResult.ok) expect(taskOf(extraResult.next, "T2").state).not.toBe("done");

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
    if (selfResult.ok) expect(taskOf(selfResult.next, "T2").state).not.toBe("done");
  });

  test("directory/directory overlap and blocked phase mismatch are violations", () => {
    const directory = structuredClone(NORMAL_RUN_LEDGER);
    directory.resources = [
      claim({ claimId: "d1", taskId: "T2", kind: "directory", path: "src" }),
      claim({ claimId: "d2", taskId: "T3", kind: "directory", path: "src/sub" }),
    ];
    taskOf(directory, "T3").state = "assigned";
    taskOf(directory, "T3").spec = { ...taskOf(directory, "T3").spec, deps: [] };
    const dirResult = checkLedgerInvariants(directory);
    expect(dirResult.ok).toBe(false);

    const phase = structuredClone(NORMAL_RUN_LEDGER);
    taskOf(phase, "T2").state = "blocked";
    taskOf(phase, "T2").phase = "implementation";
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
      const task = taskOf(record, "T2");
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
          taskIds: ["T2"],
          reason: "cancel",
          cancelIntentId: INTENT_CANCEL,
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
        { kind: "cancellation-checked", taskId: "T2", decisionId, evidence },
        facts,
      );
      expect(checked.ok).toBe(true);
      if (checked.ok) expect(taskOf(checked.next, "T2").state).toBe("blocked");
    }
  });

  test("dispatch at configured capacity is rejected", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.policy = { ...record.policy, configuredConcurrency: 0 };
    const t3 = taskOf(record, "T3");
    t3.state = "ready";
    t3.spec = { ...t3.spec, deps: [] };
    t3.attempts = 0;
    const nonce = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const result = reduceRun(
      record,
      {
        kind: "task-dispatched",
        taskId: "T3",
        assignment: assignment({ assignmentId: "assignment-t3-a1", taskId: "T3", nonce }),
        nonce: {
          nonce,
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
          messageId: MESSAGE_T2,
        }),
      },
      facts,
    );
    expect(result).toMatchObject({ ok: false, params: { reason: "capacity" } });
  });
});

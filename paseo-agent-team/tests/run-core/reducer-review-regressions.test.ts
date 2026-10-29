import { describe, expect, test } from "vitest";
import {
  checkEvidenceGate,
  checkReviewGate,
  checkSmokeGate,
  normalizeContainedPath,
} from "../../shared/domain/run-engine/gates";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import { type ReduceResult, reduceRun } from "../../shared/domain/run-engine/reducer";
import type {
  RunDispatchEvent,
  RunTaskWithEvidence,
} from "../../shared/domain/run-engine/transitions";
import {
  type RunRecord,
  RunRecordSchema,
  type RunTaskEscalation,
  type RunTier,
} from "../../shared/schemas/run-engine/ledger";
import {
  RunReviewReportBlockSchema,
  RunTaskReportBlockSchema,
} from "../../shared/schemas/run-engine/protocol";
import {
  AT_CREATED,
  AT_UPDATED,
  assignment,
  claim,
  DEV_SMOKE_READY_LEDGER,
  dispatchIntent,
  escalation,
  INTENT_CANCEL,
  MESSAGE_CANCEL,
  NORMAL_RUN_LEDGER,
  QUIESCENT_CANCELLATION,
  spec,
  taskRecord,
} from "../fixtures/run-engine";

const CONTROL_DIGEST = "9".repeat(64);
const facts = { now: AT_UPDATED, newId: () => "90000000-0000-4000-8000-000000000001" };
const NONCES = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
];
const MESSAGES = [
  "20000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000002",
  "20000000-0000-4000-8000-000000000003",
];

function task(record: RunRecord, id = "t1"): RunTaskWithEvidence {
  const entry = record.tasks.find((candidate) => candidate.spec.id === id);
  if (!entry) throw new Error(`missing task ${id}`);
  return entry;
}

function next(result: ReduceResult): RunRecord {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.next;
}

function fresh(): RunRecord {
  return {
    ...structuredClone(NORMAL_RUN_LEDGER),
    tasks: [taskRecord(spec("t1", "Implement"), { state: "ready" })],
    assignments: [],
    nonceRegistry: [],
    resources: [],
    outbox: [],
    events: [],
    eventReceipts: [],
    decisions: [],
    counters: { ...NORMAL_RUN_LEDGER.counters, eventsThroughSeq: 0, observationSeq: 0 },
    roster: [
      ...NORMAL_RUN_LEDGER.roster,
      {
        seatId: "seat-a1",
        agentId: "agent-a1",
        tier: "A",
        channelId: "codex",
        duties: ["review"],
        enabled: true,
      },
    ],
  };
}

function dispatch(
  purpose: "member" | "reviewer" = "member",
  attempt = 1,
  index = 0,
): RunDispatchEvent {
  const reviewer = purpose === "reviewer";
  const nonce = NONCES[index];
  const messageId = MESSAGES[index];
  if (!nonce || !messageId) throw new Error("missing fixture identity");
  const actor = assignment({
    assignmentId: `assignment-${purpose}-${index}`,
    taskId: "t1",
    attempt,
    purpose,
    seatId: reviewer ? "seat-a1" : "seat-b1",
    agentId: reviewer ? "agent-a1" : "agent-b1",
    tier: reviewer ? "A" : "B",
    family: reviewer ? "codex" : "haiku",
    nonce,
    messageId,
  });
  return {
    kind: "task-dispatched",
    taskId: "t1",
    assignment: actor,
    nonce: {
      nonce,
      runId: NORMAL_RUN_LEDGER.runId,
      taskId: "t1",
      assignmentId: actor.assignmentId,
      attempt,
      phase: reviewer ? "review" : "implementation",
      agentId: actor.agentId,
      seatId: actor.seatId,
      issuedAt: AT_CREATED,
      acceptedAt: null,
      acceptedEventKey: null,
      revokedAt: null,
      revokeReason: null,
    },
    intent: dispatchIntent({
      id: `intent-${purpose}-${index}`,
      taskId: "t1",
      assignmentId: actor.assignmentId,
      recipient: actor.agentId,
      messageId,
      idempotencyKey: `dispatch-${purpose}-${index}`,
      state: "prepared",
      confirmedAt: null,
    }),
    ...(reviewer ? {} : { claims: [claim({ taskId: "t1", path: "src/t1.ts" })] }),
  };
}

function implementationReport(event = dispatch()) {
  return RunTaskReportBlockSchema.parse({
    protocolVersion: 1,
    runId: NORMAL_RUN_LEDGER.runId,
    taskId: "t1",
    attempt: event.assignment.attempt,
    assignmentId: event.assignment.assignmentId,
    nonce: event.assignment.nonce,
    status: "done",
    changedFiles: ["src/t1.ts"],
    ref: { kind: "git-commit", value: "9f3c1a7" },
    workspace: event.assignment.workspace,
    evidence: [
      {
        id: "five-gates",
        command: "npm run check && npm run typecheck && npm test",
        exitCode: 0,
        summary: "passed",
        artifactPath: "evidence/t1.log",
        ref: { kind: "git-commit", value: "9f3c1a7" },
        isolation: {
          homePath: "C:/Users/runner/AppData/Local/Temp/evidence-home",
          outsideRealHome: true,
        },
      },
    ],
  });
}

function reviewing(): RunRecord {
  const assigned = next(reduceRun(fresh(), dispatch(), facts));
  return next(reduceRun(assigned, { kind: "task-report", block: implementationReport() }, facts));
}

function qualityReview(
  initial: RunTier,
  failures: number,
  epochs: RunTaskEscalation[],
  cap: number,
) {
  const record = fresh();
  const currentTier = epochs.at(-1)?.toTier ?? initial;
  for (const seat of record.roster) {
    if (seat.seatId === "seat-b1") seat.tier = currentTier;
    if (seat.seatId === "seat-a1") seat.tier = currentTier === "S" ? "S" : "A";
  }
  const entry = task(record);
  entry.spec.tier = initial;
  entry.spec.level = initial === "S" ? "L4" : initial === "A" ? "L3" : "L2";
  entry.qualityFailures = failures;
  entry.attempts = failures;
  entry.escalations = epochs;
  record.policy.perTask.implementationAttempts = cap;
  const member = dispatch("member", failures + 1);
  member.assignment.tier = currentTier;
  const assigned = next(reduceRun(record, member, facts));
  const reviewed = next(
    reduceRun(assigned, { kind: "task-report", block: implementationReport(member) }, facts),
  );
  const reviewer = dispatch("reviewer", failures + 1, 1);
  reviewer.assignment.tier = currentTier === "S" ? "S" : "A";
  const ready = next(reduceRun(reviewed, reviewer, facts));
  const block = RunReviewReportBlockSchema.parse({
    protocolVersion: 1,
    runId: ready.runId,
    taskId: "t1",
    attempt: failures + 1,
    assignmentId: reviewer.assignment.assignmentId,
    nonce: reviewer.assignment.nonce,
    reviewedRef: task(ready).ref,
    verdict: "不可合入",
    blockers: [{ id: "B1", summary: "must fix", path: "src/t1.ts" }],
    probes: [],
  });
  return { ready, block };
}

function storedEvidence(record: RunRecord) {
  const report = task(record, "T1").report as unknown as { evidence: Record<string, unknown>[] };
  const item = report.evidence[0];
  if (!item) throw new Error("missing stored evidence");
  return item;
}

function cancel(record: RunRecord): RunRecord {
  record.outbox.push(
    dispatchIntent({
      id: INTENT_CANCEL,
      kind: "archive",
      recipient: "agent-b1",
      taskId: "T2",
      assignmentId: "assignment-t2-a1",
      messageId: MESSAGE_CANCEL,
      idempotencyKey: "cancel-t2",
    }),
  );
  return next(
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
  );
}

describe("150 RB1 implementation attempt accounting", () => {
  test("dispatch cannot repair a corrupted attempt baseline", () => {
    const record = next(reduceRun(fresh(), dispatch(), facts));
    task(record).state = "rework";
    task(record).attempts = 0;
    const event = dispatch("member", 1, 2);
    event.claims = [];
    expect(reduceRun(record, event, facts)).toMatchObject({ ok: false });
  });

  test.each(["observationSeq", "probeAttempts", "reopenAttempts"] as const)(
    "checkpoint %s baseline cannot decrease",
    (counter) => {
      const record = fresh();
      record.counters.eventsThroughSeq = 10;
      record.checkpoint = {
        throughSeq: 10,
        historyDigest: "a".repeat(64),
        acceptedNonceDigests: [],
        terminalAssignmentIds: [],
        counters: { ...record.counters, [counter]: 2 },
      };
      expect(RunRecordSchema.safeParse(record).success).toBe(true);
      expect(checkLedgerInvariants(record).ok).toBe(false);
    },
  );

  test("member → strict done report → reviewer dispatch keeps implementation attempt 1", () => {
    const reviewed = next(reduceRun(reviewing(), dispatch("reviewer", 1, 1), facts));
    expect(task(reviewed).attempts).toBe(1);
    expect(task(reviewed).phase).toBe("review");
    expect(checkLedgerInvariants(reviewed)).toEqual({ ok: true });
  });

  test("an existing implementation assignment proves the attempts counter cannot be zero", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    task(record, "T2").attempts = 0;
    expect(checkLedgerInvariants(record)).toMatchObject({
      ok: false,
      violations: [expect.objectContaining({ invariant: "I6" })],
    });
  });

  test("a real rejected review proves reworkCount cannot roll back", () => {
    const record = reviewing();
    const event = dispatch("reviewer", 1, 1);
    // Start from a stored valid reviewer, independently of the dispatch-count defect above.
    record.assignments.push(event.assignment);
    record.nonceRegistry.push(event.nonce);
    record.outbox.push(event.intent);
    const block = RunReviewReportBlockSchema.parse({
      protocolVersion: 1,
      runId: record.runId,
      taskId: "t1",
      attempt: 1,
      nonce: event.assignment.nonce,
      assignmentId: event.assignment.assignmentId,
      reviewedRef: task(record).ref,
      verdict: "不可合入",
      blockers: [{ id: "B1", summary: "must fix", path: "src/t1.ts" }],
      probes: [],
    });
    const rejected = next(reduceRun(record, { kind: "review-report", block }, facts));
    expect(task(rejected).reworkCount).toBe(1);
    task(rejected).reworkCount = 0;
    expect(checkLedgerInvariants(rejected)).toMatchObject({
      ok: false,
      violations: [expect.objectContaining({ invariant: "I6" })],
    });
  });
});

describe("157 remaining dispatch and receipt guards", () => {
  test.each([false, true])(
    "file/directory overlap is rejected in either insertion order: %s",
    (reverse) => {
      const record = next(reduceRun(fresh(), dispatch(), facts));
      task(record).spec.deps = [];
      record.tasks.push(taskRecord(spec("t2", "Other writer"), { state: "in_progress" }));
      const claims = [
        claim({ taskId: "t1", kind: "file", path: "src/nested/a.ts" }),
        claim({ claimId: "other", taskId: "t2", kind: "directory", path: "src" }),
      ];
      record.resources = reverse ? claims.reverse() : claims;
      expect(checkLedgerInvariants(record)).toMatchObject({
        ok: false,
        violations: expect.arrayContaining([
          expect.objectContaining({
            invariant: "I3",
            params: { reason: "overlapping-claim", taskId: reverse ? "t1" : "t2" },
          }),
        ]),
      });
    },
  );

  test("review-report itself refuses missing implementation evidence", () => {
    const { ready, block } = qualityReview("B", 0, [], 10);
    delete task(ready).report;
    expect(reduceRun(ready, { kind: "review-report", block }, facts)).toMatchObject({
      ok: false,
      code: "RUN_EVENT_INVALID",
      path: ["tasks", "t1", "report"],
      params: { reason: "missing-done-report" },
    });
  });

  test.each(["src/a.ts:stream", "src/COM\u00b9", "src/a.ts."])(
    "dispatch rejects invalid path %s",
    (path) => {
      const record = fresh();
      task(record).spec.scopes = [
        { repoId: "repo-re-verify", kind: "directory", path: "src", access: "write" },
      ];
      const event = dispatch();
      event.claims = [claim({ taskId: "t1", path })];
      expect(reduceRun(record, event, facts)).toMatchObject({
        ok: false,
        params: { reason: "claim-not-in-scope" },
      });
    },
  );

  test("stored NFC/NFD overlap is detected through the shared lock rules", () => {
    const record = next(reduceRun(fresh(), dispatch(), facts));
    record.tasks.push(taskRecord(spec("t2", "Other writer"), { state: "in_progress" }));
    record.resources = [
      claim({ taskId: "t1", path: "src/caf\u00e9.ts" }),
      claim({ claimId: "other", taskId: "t2", path: "src/cafe\u0301.ts" }),
    ];
    expect(checkLedgerInvariants(record)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([
        expect.objectContaining({
          invariant: "I3",
          params: { reason: "overlapping-claim", taskId: "t2" },
        }),
      ]),
    });
  });

  test.each(["absent", "wrong-agent", "wrong-turn", "wrong-kind"])(
    "turn-ended rejects %s receipt",
    (defect) => {
      const record = next(reduceRun(fresh(), dispatch(), facts));
      const current = record.assignments[0];
      if (!current) throw new Error("assignment");
      current.turnId = "turn-current";
      current.state = "in_progress";
      task(record).state = "in_progress";
      if (defect !== "absent") {
        record.eventReceipts.push({
          eventKey: "claimed-end",
          kind: defect === "wrong-kind" ? "turn_started" : "turn_ended",
          agentId: defect === "wrong-agent" ? "other" : current.agentId,
          turnId: defect === "wrong-turn" ? "other" : current.turnId,
          seq: 1,
          receivedAt: AT_UPDATED,
          dedupeKey: "claimed-end",
          disposition: "accepted",
        });
        record.counters.observationSeq = 1;
      }
      const result = reduceRun(
        record,
        { kind: "turn-ended", assignmentId: current.assignmentId, endedEventKey: "claimed-end" },
        facts,
      );
      expect(result).toMatchObject({ ok: false, params: { reason: "ended-receipt-mismatch" } });
      expect(current.state).toBe("in_progress");
    },
  );

  test("a file inside a directory cannot prove the whole directory is locked", () => {
    const record = fresh();
    task(record).spec.scopes = [
      { repoId: "repo", kind: "directory", path: "src", access: "write" },
    ];
    const event = dispatch();
    event.claims = [claim({ taskId: "t1", repoId: "repo", path: "src/one.ts" })];
    expect(reduceRun(record, event, facts)).toMatchObject({
      ok: false,
      params: { reason: "claim-coverage" },
    });
  });

  test("DAG equality ignores JSON object key order", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const tasks = record.tasks.map(
      (entry) => Object.fromEntries(Object.entries(entry.spec).reverse()) as typeof entry.spec,
    );
    expect(
      reduceRun(
        record,
        {
          kind: "dag-revised",
          controlNonceDigest: CONTROL_DIGEST,
          block: {
            protocolVersion: 1,
            runId: record.runId,
            taskId: "_dag",
            nonce: NONCES[0],
            attempt: 1,
            dagRevision: record.dagRevision + 1,
            expectedDagRevision: record.dagRevision,
            tasks,
            cancelTaskIds: [],
            budgetRequests: [],
          },
        },
        facts,
      ),
    ).toMatchObject({ ok: true });
  });
});

describe("150 RB2/RB3 effect ownership", () => {
  test("an archive addressed to another agent cannot authorize releasing the current worker", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const current = record.assignments.find((entry) => entry.assignmentId === "assignment-t2-a1");
    if (!current) throw new Error("missing assignment");
    current.turnId = "turn-7";
    record.eventReceipts.push({
      eventKey: "agent-b1|turn-7|turn_ended",
      kind: "turn_ended",
      agentId: "agent-b1",
      turnId: "turn-7",
      seq: 8,
      receivedAt: AT_UPDATED,
      dedupeKey: "cancel-ended",
      disposition: "accepted",
    });
    record.counters.observationSeq = 8;
    const frozen = cancel(record);
    const intent = frozen.outbox.find((entry) => entry.id === INTENT_CANCEL);
    if (!intent) throw new Error("missing cancel intent");
    intent.recipient = "unrelated-agent";
    expect(checkLedgerInvariants(frozen).ok).toBe(false);
    const decision = frozen.decisions.find((entry) => entry.dedupeKey === "cancel:T2");
    if (!decision) throw new Error("missing cancellation decision");
    const result = reduceRun(
      frozen,
      {
        kind: "cancellation-checked",
        taskId: "T2",
        decisionId: decision.decisionId,
        evidence: { ...QUIESCENT_CANCELLATION, observationSeq: 8 },
      },
      facts,
    );
    if (result.ok) {
      expect(task(result.next, "T2").state).toBe("blocked");
      expect(result.next.resources).toHaveLength(frozen.resources.length);
      expect(
        result.next.decisions.find((entry) => entry.decisionId === decision.decisionId)?.state,
      ).toBe("open");
    }
  });

  test("archive cannot stand in for a stored dispatch intent", () => {
    const record = next(reduceRun(fresh(), dispatch(), facts));
    const intent = record.outbox[0];
    if (!intent) throw new Error("missing intent");
    Object.assign(intent, { kind: "archive" });
    expect(RunRecordSchema.safeParse(record).success).toBe(true);
    expect(checkLedgerInvariants(record)).toMatchObject({
      ok: false,
      violations: [expect.objectContaining({ invariant: "I8" })],
    });
  });
  test("task-dispatched rejects archive before storing an assignment", () => {
    const event = dispatch();
    if (event.intent.kind !== "dispatch") throw new Error("missing dispatch fixture");
    event.intent = { ...event.intent, kind: "archive" };
    expect(reduceRun(fresh(), event, facts)).toMatchObject({ ok: false });
  });
});

describe("150 RI1/RI2 stored identity", () => {
  test.each([
    { reviewerAgentId: "agent-ordinary-b" },
    { reviewerSeatId: "ordinary-seat" },
    { assignmentId: "missing-review-assignment" },
  ])("explicit review assignment cannot borrow a contradictory actor: %j", (patch) => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const reviewed = task(record, "T1");
    const review = reviewed.reviews?.[0];
    if (!review) throw new Error("missing stored review");
    Object.assign(review, patch);
    expect(checkReviewGate(record, reviewed).ok).toBe(false);
    expect(checkLedgerInvariants(record).ok).toBe(false);
  });

  test.each([{ runId: "run-other-1" }, { phase: "smoke" }])(
    "nonce validates run and purpose phase: %j",
    (patch) => {
      const record = structuredClone(NORMAL_RUN_LEDGER);
      const nonce = record.nonceRegistry.find((entry) => entry.taskId === "T2");
      if (!nonce) throw new Error("missing nonce");
      Object.assign(nonce, patch);
      expect(checkLedgerInvariants(record)).toMatchObject({
        ok: false,
        violations: expect.arrayContaining([expect.objectContaining({ invariant: "I5" })]),
      });
    },
  );

  test("a revoked historical attempt does not invalidate a new active attempt", () => {
    const record = next(reduceRun(fresh(), dispatch(), facts));
    const historical = record.assignments[0];
    const nonce = record.nonceRegistry[0];
    if (!historical || !nonce) throw new Error("missing attempt history");
    historical.state = "ended";
    historical.endedAt = AT_UPDATED;
    nonce.revokedAt = AT_UPDATED;
    nonce.revokeReason = "replaced";
    const current = dispatch("member", 2, 2);
    record.assignments.push(current.assignment);
    record.nonceRegistry.push(current.nonce);
    record.outbox.push(current.intent);
    task(record).attempts = 2;
    task(record).currentAssignmentId = current.assignment.assignmentId;
    expect(checkLedgerInvariants(record)).toEqual({ ok: true });
  });
});

describe("150 RI3/RI4/RI5 nested facts and shared boundaries", () => {
  test.each([{ isolation: null }, { coverage: null }, { coverage: {} }])(
    "malformed nested evidence is rejected without throwing: %j",
    (patch) => {
      const record = structuredClone(NORMAL_RUN_LEDGER);
      const entry = task(record, "T1");
      if ("coverage" in patch) {
        const requirement = entry.spec.evidence[0];
        if (!requirement) throw new Error("missing requirement");
        requirement.minLines = 90;
      }
      Object.assign(storedEvidence(record), patch);
      expect(RunRecordSchema.safeParse(record).success).toBe(true);
      expect(() => checkLedgerInvariants(record)).not.toThrow();
      expect(checkLedgerInvariants(record).ok).toBe(false);
      expect(checkEvidenceGate(record, entry).ok).toBe(false);
    },
  );

  test.each(["COM¹", "COM²", "LPT³"])(
    "I3 rejects Windows device path %s through the shared rule",
    (name) => {
      const record = structuredClone(NORMAL_RUN_LEDGER);
      const held = record.resources[0];
      if (!held) throw new Error("missing claim");
      held.path = `src/${name}`;
      expect(normalizeContainedPath(held.path)).toBeNull();
      expect(checkLedgerInvariants(record)).toMatchObject({
        ok: false,
        violations: [expect.objectContaining({ invariant: "I3" })],
      });
    },
  );

  test.each(["http://0177.0.0.1:6767", "http://017700000001:6767"])(
    "smoke rejects default daemon octal alias %s",
    (host) => {
      const record = structuredClone(DEV_SMOKE_READY_LEDGER);
      const target = record.policy.devTargets[0];
      const current = task(record, "T6");
      if (!target || !current.smokeReport) throw new Error("missing smoke facts");
      target.host = host;
      current.smokeReport.devHost = host;
      expect(new URL(host).hostname).toBe("127.0.0.1");
      expect(checkSmokeGate(record, current).ok).toBe(false);
    },
  );
});

describe("146 quality ladder wiring", () => {
  test("a new quality decision requires an engine-provided control nonce digest", () => {
    const { ready, block } = qualityReview("S", 2, [], 3);
    expect(reduceRun(ready, { kind: "review-report", block }, facts)).toMatchObject({ ok: false });
  });

  test("an unqualified negative review cannot spend a quality failure", () => {
    const { ready, block } = qualityReview("B", 0, [], 6);
    const reviewer = ready.assignments.find((entry) => entry.purpose === "reviewer");
    if (!reviewer) throw new Error("missing reviewer");
    reviewer.tier = "B";
    expect(reduceRun(ready, { kind: "review-report", block }, facts)).toMatchObject({ ok: false });
    expect(task(ready).qualityFailures).toBe(0);
  });

  const bToA = escalation();
  const aToS = escalation({ fromTier: "A", toTier: "S", atAttempt: 6, qualityFailures: 6 });
  test.each([
    ["B", 2, [], 10, "A"],
    ["B", 5, [bToA], 10, "S"],
    ["A", 2, [], 10, "S"],
    ["S", 2, [], 3, "D3"],
    ["B", 8, [bToA, aToS], 9, "D3"],
    ["B", 8, [bToA, aToS], 10, "D3"],
    ["B", 5, [bToA], 6, "D4"],
    ["S", 0, [], 6, "rework"],
  ] as const)(
    "%s with %i prior failures, epochs %j, cap %i → %s",
    (initial, failures, epochs, cap, expected) => {
      const { ready, block } = qualityReview(initial, failures, [...epochs], cap);
      const result = next(
        reduceRun(
          ready,
          { kind: "review-report", block },
          {
            ...facts,
            newDecisionNonceDigest: () => CONTROL_DIGEST,
          },
        ),
      );
      const current = task(result);
      expect(current.qualityFailures).toBe(failures + 1);
      if (expected === "D3" || expected === "D4") {
        expect(result.decisions).toHaveLength(1);
        expect(result.decisions[0]).toMatchObject({
          category: expected,
          state: "open",
          subjectId: "t1",
          controlNonceDigest: CONTROL_DIGEST,
        });
        expect(current.escalations).toEqual(epochs);
        expect(current.state).toBe(expected === "D3" ? "failed" : "blocked");
        expect(result.resources.every((held) => held.frozen)).toBe(true);
      } else if (expected === "rework") {
        expect(current.state).toBe("rework");
        expect(result.decisions).toEqual([]);
      } else {
        expect(current.state).toBe("rework");
        expect(current.escalations).toHaveLength(epochs.length + 1);
        expect(current.escalations.at(-1)).toMatchObject({
          fromTier: epochs.at(-1)?.toTier ?? initial,
          toTier: expected,
          atAttempt: failures + 1,
          qualityFailures: failures + 1,
          at: AT_UPDATED,
        });
        expect(result.decisions).toEqual([]);
      }
    },
  );
});

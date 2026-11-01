import { describe, expect, test } from "vitest";
import {
  checkEvidenceGate,
  checkReviewGate,
  checkSmokeGate,
} from "../../shared/domain/run-engine/gates";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import { normalizeLogicalPath } from "../../shared/domain/run-engine/locks";
import { type ReduceResult, reduceRun } from "../../shared/domain/run-engine/reducer";
import type { RunDispatchEvent } from "../../shared/domain/run-engine/transitions";
import {
  type RunRecord,
  RunRecordSchema,
  type RunTaskEscalation,
  type RunTaskRecord,
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
const NONCES = Array.from(
  { length: 32 },
  (_, index) => `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);
const MESSAGES = Array.from(
  { length: 32 },
  (_, index) => `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);

function task(record: RunRecord, id = "t1"): RunTaskRecord {
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
  const base = structuredClone(NORMAL_RUN_LEDGER);
  return {
    ...base,
    tasks: [taskRecord(spec("t1", "Implement"), { state: "ready" })],
    assignments: [],
    nonceRegistry: [],
    resources: [],
    outbox: [],
    events: [],
    eventReceipts: [],
    decisions: [],
    counters: { ...base.counters, eventsThroughSeq: 0, observationSeq: 0 },
    roster: [
      ...base.roster,
      {
        seatId: "seat-a1",
        agentId: "agent-a1",
        tier: "A",
        channelId: "codex",
        duties: ["review"],
        enabled: true,
      },
      {
        seatId: "seat-a2",
        agentId: "agent-a2",
        tier: "A",
        channelId: "claude",
        duties: ["implement"],
        enabled: true,
      },
      {
        seatId: "seat-s2",
        agentId: "agent-s2",
        tier: "S",
        channelId: "claude",
        duties: ["implement"],
        enabled: true,
      },
      {
        seatId: "seat-s3",
        agentId: "agent-s3",
        tier: "S",
        channelId: "codex",
        duties: ["review"],
        enabled: true,
      },
    ],
  };
}

function addProducer(
  record: RunRecord,
  taskId: string,
  assignmentId: string,
  nonce: string,
  messageId: string,
  agentId: string,
  seatId: string,
) {
  if (!record.roster.some((seat) => seat.seatId === seatId)) {
    record.roster.push({
      seatId,
      agentId,
      tier: "B",
      channelId: "claude",
      duties: ["implement"],
      enabled: true,
    });
  }
  const producer = assignment({
    assignmentId,
    taskId,
    nonce,
    messageId,
    agentId,
    seatId,
    tier: "B",
  });
  record.assignments.push(producer);
  record.nonceRegistry.push({
    nonce,
    runId: record.runId,
    taskId,
    assignmentId,
    attempt: 1,
    phase: "implementation",
    agentId: producer.agentId,
    seatId: producer.seatId,
    issuedAt: AT_UPDATED,
    acceptedAt: null,
    acceptedEventKey: null,
    revokedAt: null,
    revokeReason: null,
  });
  record.outbox.push(
    dispatchIntent({
      id: `intent-${assignmentId}`,
      taskId,
      assignmentId,
      recipient: producer.agentId,
      messageId,
      idempotencyKey: `dispatch-${assignmentId}`,
    }),
  );
  const owner = task(record, taskId);
  owner.state = "in_progress";
  owner.currentAssignmentId = assignmentId;
  owner.attempts = 1;
  return producer;
}

function expectProducerClosure(
  record: RunRecord,
  producer: ReturnType<typeof addProducer>,
  claims: readonly RunRecord["resources"][number][],
) {
  const intents = record.outbox.filter(
    (entry) => entry.kind === "dispatch" && entry.assignmentId === producer.assignmentId,
  );
  expect(intents).toHaveLength(1);
  const intent = intents[0];
  const nonce = record.nonceRegistry.find((entry) => entry.assignmentId === producer.assignmentId);
  expect(intent).toMatchObject({
    kind: "dispatch",
    taskId: producer.taskId,
    assignmentId: producer.assignmentId,
    recipient: producer.agentId,
    messageId: producer.messageId,
  });
  expect(nonce).toMatchObject({
    nonce: producer.nonce,
    runId: record.runId,
    taskId: producer.taskId,
    assignmentId: producer.assignmentId,
    attempt: producer.attempt,
    agentId: producer.agentId,
    seatId: producer.seatId,
    phase: "implementation",
  });
  const ownedClaims = claims.filter((entry) => entry.taskId === producer.taskId);
  expect(ownedClaims.length).toBeGreaterThan(0);
  expect(ownedClaims.every((entry) => entry.originAssignmentId === producer.assignmentId)).toBe(
    true,
  );
}

function dispatch(
  purpose: "member" | "reviewer" = "member",
  attempt = 1,
  index = 0,
  producerAssignmentId = "assignment-member-0",
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
    channelId: reviewer ? "codex" : "claude",
    nonce,
    messageId,
    delivery: reviewer ? { producerAssignmentId } : null,
  });
  return {
    kind: "task-dispatched",
    reissueOfAssignmentId: null,
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
      state: "confirmed",
      confirmedAt: AT_UPDATED,
    }),
    ...(reviewer
      ? {}
      : {
          claims: [
            claim({
              taskId: "t1",
              path: "src/t1.ts",
              originAssignmentId: actor.assignmentId,
            }),
          ],
        }),
  };
}

function bindActor(event: RunDispatchEvent, agentId: string, seatId: string, channelId: string) {
  event.assignment.agentId = agentId;
  event.assignment.seatId = seatId;
  event.assignment.channelId = channelId;
  event.nonce.agentId = agentId;
  event.nonce.seatId = seatId;
  event.intent.recipient = agentId;
}

function implementationReport(event = dispatch(), ref = "9f3c1a7") {
  return RunTaskReportBlockSchema.parse({
    protocolVersion: 1,
    runId: NORMAL_RUN_LEDGER.runId,
    taskId: "t1",
    attempt: event.assignment.attempt,
    assignmentId: event.assignment.assignmentId,
    nonce: event.assignment.nonce,
    status: "done",
    changedFiles: ["src/t1.ts"],
    ref: { kind: "git-commit", value: ref },
    workspace: event.assignment.workspace,
    evidence: [
      {
        id: "five-gates",
        command: "npm run check && npm run typecheck && npm test",
        exitCode: 0,
        summary: "passed",
        artifactPath: "evidence/t1.log",
        ref: { kind: "git-commit", value: ref },
        isolation: {
          homePath: "C:/Users/runner/AppData/Local/Temp/evidence-home",
          outsideRealHome: true,
        },
      },
    ],
  });
}

function start(record: RunRecord, assignmentId: string): RunRecord {
  const assignment = record.assignments.find((entry) => entry.assignmentId === assignmentId);
  if (!assignment) throw new Error(`missing assignment ${assignmentId}`);
  return next(
    reduceRun(
      record,
      {
        kind: "turn-started",
        assignmentId,
        agentId: assignment.agentId,
        turnId: `turn-${assignmentId}`,
      },
      facts,
    ),
  );
}

function end(record: RunRecord, assignmentId: string): RunRecord {
  const assignment = record.assignments.find((entry) => entry.assignmentId === assignmentId);
  if (!assignment?.turnId) throw new Error(`unstarted assignment ${assignmentId}`);
  const endedEventKey = `${assignment.agentId}|${assignment.turnId}|turn_ended`;
  const observed = next(
    reduceRun(
      record,
      {
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
      },
      facts,
    ),
  );
  return next(reduceRun(observed, { kind: "turn-ended", assignmentId, endedEventKey }, facts));
}

function reviewing(): RunRecord {
  let record = next(reduceRun(fresh(), dispatch(), facts));
  record = start(record, "assignment-member-0");
  record = next(reduceRun(record, { kind: "task-report", block: implementationReport() }, facts));
  return end(record, "assignment-member-0");
}

function rejectedReview() {
  let record = reviewing();
  const reviewer = dispatch("reviewer", 1, 1);
  record = next(reduceRun(record, reviewer, facts));
  record = start(record, reviewer.assignment.assignmentId);
  record = next(
    reduceRun(record, { kind: "review-report", block: negativeReview(record, reviewer) }, facts),
  );
  record = end(record, reviewer.assignment.assignmentId);
  return { record, reviewer };
}

function bindProducerActor(event: RunDispatchEvent, tier: RunTier) {
  if (tier === "A") bindActor(event, "agent-a2", "seat-a2", "claude");
  if (tier === "S") bindActor(event, "agent-s2", "seat-s2", "claude");
}

function bindReviewerActor(event: RunDispatchEvent, tier: RunTier) {
  if (tier === "S") bindActor(event, "agent-s3", "seat-s3", "codex");
  else bindActor(event, "agent-a1", "seat-a1", "codex");
}

function negativeReview(record: RunRecord, reviewer: RunDispatchEvent) {
  return RunReviewReportBlockSchema.parse({
    protocolVersion: 1,
    runId: record.runId,
    taskId: "t1",
    attempt: reviewer.assignment.attempt,
    assignmentId: reviewer.assignment.assignmentId,
    nonce: reviewer.assignment.nonce,
    reviewedRef: task(record).ref,
    verdict: "不可合入",
    blockers: [{ id: "B1", summary: "must fix", path: "src/t1.ts" }],
    probes: [],
  });
}

function seedQualityFailures(
  initial: RunTier,
  failures: number,
  epochs: RunTaskEscalation[],
  cap: number,
): RunRecord {
  let record = fresh();
  const entry = task(record);
  entry.spec.tier = initial;
  entry.spec.level = initial === "S" ? "L4" : initial === "A" ? "L3" : "L2";
  record.policy.perTask.implementationAttempts = Math.max(cap, failures + 1, 10);
  for (let attempt = 1; attempt <= failures; attempt += 1) {
    const tier = task(record).escalations.at(-1)?.toTier ?? initial;
    const member = dispatch("member", attempt, attempt - 1);
    member.assignment.tier = tier;
    bindProducerActor(member, tier);
    record = next(reduceRun(record, member, facts));
    record = start(record, member.assignment.assignmentId);
    record = next(
      reduceRun(
        record,
        { kind: "task-report", block: implementationReport(member, `quality-ref-${attempt}`) },
        facts,
      ),
    );
    record = end(record, member.assignment.assignmentId);
    const reviewer = dispatch(
      "reviewer",
      attempt,
      10 + attempt - 1,
      member.assignment.assignmentId,
    );
    reviewer.assignment.tier = tier === "S" ? "S" : "A";
    bindReviewerActor(reviewer, tier);
    record = next(reduceRun(record, reviewer, facts));
    record = start(record, reviewer.assignment.assignmentId);
    record = next(
      reduceRun(record, { kind: "review-report", block: negativeReview(record, reviewer) }, facts),
    );
    record = end(record, reviewer.assignment.assignmentId);
    if (task(record).state === "blocked" || task(record).state === "failed") {
      throw new Error(`quality history ended early at attempt ${attempt}`);
    }
    if (task(record).state !== "rework") {
      throw new Error(`quality history did not settle to rework at attempt ${attempt}`);
    }
  }
  if (task(record).qualityFailures !== failures) {
    throw new Error(
      `quality history has ${task(record).qualityFailures} failures, expected ${failures}`,
    );
  }
  expect(task(record).escalations).toEqual(epochs);
  record.policy.perTask.implementationAttempts = cap;
  return record;
}

function qualityReview(
  initial: RunTier,
  failures: number,
  epochs: RunTaskEscalation[],
  cap: number,
) {
  const record = seedQualityFailures(initial, failures, epochs, cap);
  const tier = task(record).escalations.at(-1)?.toTier ?? initial;
  const attempt = failures + 1;
  const member = dispatch("member", attempt, failures);
  member.assignment.tier = tier;
  bindProducerActor(member, tier);
  let assigned = next(reduceRun(record, member, facts));
  assigned = start(assigned, member.assignment.assignmentId);
  assigned = next(
    reduceRun(
      assigned,
      { kind: "task-report", block: implementationReport(member, `quality-ref-${attempt}`) },
      facts,
    ),
  );
  assigned = end(assigned, member.assignment.assignmentId);
  const reviewer = dispatch("reviewer", attempt, 10 + failures, member.assignment.assignmentId);
  reviewer.assignment.tier = tier === "S" ? "S" : "A";
  bindReviewerActor(reviewer, tier);
  const ready = next(reduceRun(assigned, reviewer, facts));
  const started = start(ready, reviewer.assignment.assignmentId);
  return {
    ready: started,
    block: negativeReview(started, reviewer),
    reviewerId: reviewer.assignment.assignmentId,
  };
}

function storedEvidence(record: RunRecord) {
  const producer = record.assignments.find(
    (entry) =>
      entry.taskId === "t1" &&
      ["member", "coordinator", "reopen"].includes(entry.purpose) &&
      entry.acceptedProof !== null &&
      "evidence" in entry.acceptedProof,
  );
  const item =
    producer?.acceptedProof && "evidence" in producer.acceptedProof
      ? (producer.acceptedProof.evidence as Record<string, unknown>[])[0]
      : undefined;
  if (!item) throw new Error("missing stored evidence");
  return item;
}

function cancel(record: RunRecord): RunRecord {
  record.outbox.push(
    dispatchIntent({
      id: INTENT_CANCEL,
      kind: "archive",
      recipient: "agent-b1",
      taskId: "t2",
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
        taskIds: ["t2"],
        reason: "cancel",
        cancelIntents: [{ assignmentId: "assignment-t2-a1", intentId: INTENT_CANCEL }],
        preparedCancelIntents: [],
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
    task(record, "t2").attempts = 0;
    // One mutation trips two independent I6 rules on the same counter: the distinct producer
    // attempts held in assignments, and the dispatch events the counter must not trail.
    expect(checkLedgerInvariants(record)).toEqual({
      ok: false,
      violations: [
        {
          invariant: "I6",
          path: ["tasks", "t2", "attempts"],
          params: { reason: "attempt-count-mismatch", expected: 1, actual: 0 },
        },
        {
          invariant: "I6",
          path: ["tasks", "t2", "attempts"],
          params: { reason: "behind-events", count: 1 },
        },
      ],
    });
  });

  test("a real rejected review proves reworkCount cannot roll back", () => {
    const { record } = rejectedReview();
    // R01g counts a rework when the next work attempt is registered, not at review rejection.
    expect(task(record).reworkCount).toBe(0);
    const nextAttempt = next(reduceRun(record, dispatch("member", 2, 3), facts));
    expect(task(nextAttempt).reworkCount).toBe(1);
    task(nextAttempt).reworkCount = 0;
    expect(checkLedgerInvariants(nextAttempt)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([expect.objectContaining({ invariant: "I6" })]),
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
      const t1Assignment = record.assignments.find((entry) => entry.taskId === "t1");
      if (!t1Assignment) throw new Error("missing t1 producer");
      const t2Producer = addProducer(
        record,
        "t2",
        "assignment-t2-writer",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "agent-b3",
        "seat-b3",
      );
      expect(t2Producer.agentId).not.toBe(t1Assignment.agentId);
      expect(t2Producer.seatId).not.toBe(t1Assignment.seatId);
      expect(NORMAL_RUN_LEDGER.roster.some((seat) => seat.seatId === "seat-b3")).toBe(false);
      expect(record.roster).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            seatId: "seat-b3",
            agentId: "agent-b3",
            tier: "B",
            duties: ["implement"],
            enabled: true,
          }),
        ]),
      );
      const claims = [
        claim({
          taskId: "t1",
          kind: "file",
          path: "src/nested/a.ts",
          originAssignmentId: t1Assignment.assignmentId,
        }),
        claim({
          claimId: "other",
          taskId: "t2",
          kind: "directory",
          path: "src",
          originAssignmentId: t2Producer.assignmentId,
        }),
      ];
      record.resources = reverse ? claims.reverse() : claims;
      expectProducerClosure(record, t2Producer, record.resources);
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

  test("review-report on a ledger that lost its implementation evidence is refused as a corrupt source", () => {
    const { ready, block } = qualityReview("B", 0, [], 10);
    const producer = ready.assignments.find(
      (entry) =>
        entry.taskId === "t1" &&
        ["member", "coordinator", "reopen"].includes(entry.purpose) &&
        entry.acceptedProof !== null,
    );
    if (!producer) throw new Error("missing producer");
    producer.acceptedProof = null;
    const nonce = ready.nonceRegistry.find((entry) => entry.assignmentId === producer.assignmentId);
    if (!nonce) throw new Error("missing producer nonce");
    nonce.acceptedAt = null;
    nonce.acceptedEventKey = null;
    // No valid delivery D resolves any more while the task still caches its ref and changed
    // files, so the source is refused whole (I7) before the report handler can run.
    const before = structuredClone(ready);
    expect(reduceRun(ready, { kind: "review-report", block }, facts)).toMatchObject({
      ok: false,
      code: "RUN_INVARIANT_VIOLATION",
      params: { reason: "delivery-cache" },
      violations: [
        { invariant: "I7", path: ["tasks", "t1", "ref"], params: { reason: "delivery-cache" } },
        {
          invariant: "I7",
          path: ["tasks", "t1", "changedFiles"],
          params: { reason: "delivery-cache" },
        },
      ],
    });
    expect(ready).toEqual(before);
    expect(task(ready).qualityFailures).toBe(0);
  });

  test.each(["src/a.ts:stream", "src/COM\u00b9", "src/a.ts."])(
    "dispatch rejects invalid path %s at the shared scope guard",
    (path) => {
      const record = fresh();
      task(record).spec.scopes = [
        { repoId: "repo-re-verify", kind: "directory", path: "src", access: "write" },
      ];
      const valid = dispatch();
      valid.claims = [
        claim({
          taskId: "t1",
          kind: "directory",
          path: "src",
          originAssignmentId: valid.assignment.assignmentId,
        }),
      ];
      expect(reduceRun(record, valid, facts)).toMatchObject({ ok: true });
      const invalid = dispatch();
      invalid.claims = [
        claim({
          taskId: "t1",
          kind: "directory",
          path,
          originAssignmentId: invalid.assignment.assignmentId,
        }),
      ];
      // 82's full-scope guard rejects the lexical-invalid path before the I3 invariant.
      expect(reduceRun(record, invalid, facts)).toMatchObject({
        ok: false,
        code: "RUN_EVENT_INVALID",
        path: ["claims"],
        params: { reason: "scope-not-covered" },
      });
    },
  );

  test("a custom claim with a missing origin remains a separate claim-binding rejection", () => {
    const event = dispatch();
    event.claims = [claim({ taskId: "t1", path: "src/t1.ts" })];
    expect(reduceRun(fresh(), event, facts)).toMatchObject({
      ok: false,
      code: "RUN_EVENT_INVALID",
      path: ["claims"],
      params: { reason: "claim-not-in-scope" },
    });
  });

  test("stored NFC/NFD overlap is detected through the shared lock rules", () => {
    const record = next(reduceRun(fresh(), dispatch(), facts));
    record.tasks.push(taskRecord(spec("t2", "Other writer"), { state: "in_progress" }));
    const t1Assignment = record.assignments.find((entry) => entry.taskId === "t1");
    if (!t1Assignment) throw new Error("missing t1 producer");
    const t2Producer = addProducer(
      record,
      "t2",
      "assignment-t2-writer",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "agent-b3",
      "seat-b3",
    );
    expect(t2Producer.agentId).not.toBe(t1Assignment.agentId);
    expect(t2Producer.seatId).not.toBe(t1Assignment.seatId);
    expect(record.roster).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          seatId: "seat-b3",
          agentId: "agent-b3",
          tier: "B",
          duties: ["implement"],
          enabled: true,
        }),
      ]),
    );
    record.resources = [
      claim({
        taskId: "t1",
        path: "src/caf\u00e9.ts",
        originAssignmentId: t1Assignment.assignmentId,
      }),
      claim({
        claimId: "other",
        taskId: "t2",
        path: "src/cafe\u0301.ts",
        originAssignmentId: t2Producer.assignmentId,
      }),
    ];
    expectProducerClosure(record, t2Producer, record.resources);
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
    event.claims = [
      claim({
        taskId: "t1",
        repoId: "repo",
        path: "src/one.ts",
        originAssignmentId: event.assignment.assignmentId,
      }),
    ];
    // 82's full-scope guard rejects a file claim for a directory write scope.
    expect(reduceRun(record, event, facts)).toMatchObject({
      ok: false,
      code: "RUN_EVENT_INVALID",
      path: ["claims"],
      params: { reason: "scope-not-covered" },
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
          cancelIntents: [],
          preparedCancelIntents: [],
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
    const decision = frozen.decisions.find((entry) => entry.dedupeKey === "cancel:t2");
    if (!decision) throw new Error("missing cancellation decision");
    const result = reduceRun(
      frozen,
      {
        kind: "cancellation-checked",
        taskId: "t2",
        decisionId: decision.decisionId,
        evidence: { ...QUIESCENT_CANCELLATION, observationSeq: 8 },
      },
      facts,
    );
    if (result.ok) {
      expect(task(result.next, "t2").state).toBe("blocked");
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
  test.each([{ agentId: "agent-b1" }, { seatId: "seat-b1" }])(
    "explicit review assignment cannot borrow the producer actor: %j",
    (patch) => {
      const record = structuredClone(NORMAL_RUN_LEDGER);
      const reviewed = task(record, "t1");
      const review = record.assignments.find(
        (entry) =>
          entry.taskId === "t1" && entry.purpose === "reviewer" && entry.acceptedProof !== null,
      );
      if (!review) throw new Error("missing stored review");
      Object.assign(review, patch);
      const nonce = record.nonceRegistry.find(
        (entry) => entry.assignmentId === review.assignmentId,
      );
      if (!nonce) throw new Error("missing review nonce");
      if (patch.agentId !== undefined) {
        nonce.agentId = patch.agentId;
        const intent = record.outbox.find((entry) => entry.assignmentId === review.assignmentId);
        if (intent) intent.recipient = patch.agentId;
      }
      if (patch.seatId !== undefined) nonce.seatId = patch.seatId;
      // Helper-boundary assertion: this targets reviewEligible independence.
      // It deliberately does not claim a single-defect whole-ledger I7 proof.
      expect(checkReviewGate(record, reviewed).ok).toBe(false);
    },
  );

  test("stored review proof/assignment identity is rejected by I7", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const review = record.assignments.find(
      (entry) =>
        entry.taskId === "t1" && entry.purpose === "reviewer" && entry.acceptedProof !== null,
    );
    if (!review) throw new Error("missing stored review");
    review.assignmentId = "missing-review-assignment";
    expect(checkLedgerInvariants(record)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([
        expect.objectContaining({
          invariant: "I7",
          params: expect.objectContaining({ reason: "proof-binding" }),
        }),
      ]),
    });
  });

  test.each([{ runId: "run-other-1" }, { phase: "smoke" }])(
    "nonce validates run and purpose phase: %j",
    (patch) => {
      const record = structuredClone(NORMAL_RUN_LEDGER);
      const nonce = record.nonceRegistry.find((entry) => entry.taskId === "t2");
      if (!nonce) throw new Error("missing nonce");
      Object.assign(nonce, patch);
      expect(checkLedgerInvariants(record)).toMatchObject({
        ok: false,
        violations: expect.arrayContaining([expect.objectContaining({ invariant: "I5" })]),
      });
    },
  );

  test("a revoked historical attempt does not invalidate a new active attempt", () => {
    const { record: rejected } = rejectedReview();
    const historical = rejected.assignments.find(
      (entry) => entry.assignmentId === "assignment-member-0",
    );
    const nonce = rejected.nonceRegistry.find(
      (entry) => entry.assignmentId === historical?.assignmentId,
    );
    if (!historical || !nonce) throw new Error("missing attempt history");
    nonce.revokedAt = AT_UPDATED;
    nonce.revokeReason = "replaced";
    const current = dispatch("member", 2, 2);
    const nextRecord = next(reduceRun(rejected, current, facts));
    expect(task(nextRecord).attempts).toBe(2);
    expect(task(nextRecord).reworkCount).toBe(1);
    expect(checkLedgerInvariants(nextRecord)).toEqual({ ok: true });
  });
});

describe("150 RI3/RI4/RI5 nested facts and shared boundaries", () => {
  test.each([{ isolation: null }, { coverage: null }, { coverage: {} }])(
    "malformed nested evidence is rejected without throwing: %j",
    (patch) => {
      const record = structuredClone(NORMAL_RUN_LEDGER);
      const entry = task(record, "t1");
      if ("coverage" in patch) {
        const requirement = entry.spec.evidence[0];
        if (!requirement) throw new Error("missing requirement");
        requirement.minLines = 90;
      }
      Object.assign(storedEvidence(record), patch);
      expect(RunRecordSchema.safeParse(record).success).toBe(false);
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
      expect(normalizeLogicalPath(held.path).ok).toBe(false);
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
      const current = task(record, "t6");
      const smoker = record.assignments.find(
        (entry) =>
          entry.taskId === "t6" && entry.purpose === "smoker" && entry.acceptedProof !== null,
      );
      const proof = smoker?.acceptedProof;
      if (!target || !proof || !("devHost" in proof)) throw new Error("missing smoke facts");
      target.host = host;
      (proof as { devHost: string }).devHost = host;
      expect(new URL(host).hostname).toBe("127.0.0.1");
      expect(checkSmokeGate(record, current).ok).toBe(false);
    },
  );
});

describe("146 quality ladder wiring", () => {
  test("fresh roster is isolated from the public fixture and other records", () => {
    const baseline = structuredClone(NORMAL_RUN_LEDGER);
    const first = fresh();
    const second = fresh();
    expect(first.roster[0]).not.toBe(NORMAL_RUN_LEDGER.roster[0]);
    expect(first.roster[0]).not.toBe(second.roster[0]);
    const firstTier = first.roster[0]?.tier;
    qualityReview("S", 0, [], 6);
    qualityReview("B", 2, [], 10);
    expect(NORMAL_RUN_LEDGER).toEqual(baseline);
    expect(first.roster[0]?.tier).toBe(firstTier);
  });

  test("a new quality decision requires an engine-provided control nonce digest", () => {
    const { ready, block } = qualityReview("S", 2, [], 3);
    const before = structuredClone(ready);
    expect(reduceRun(ready, { kind: "review-report", block }, facts)).toMatchObject({
      ok: false,
      code: "RUN_EVENT_INVALID",
      params: { reason: "missing-control-nonce-digest" },
    });
    expect(ready).toEqual(before);
  });

  test("an unqualified negative review cannot spend a quality failure", () => {
    const { ready, block } = qualityReview("B", 0, [], 6);
    const reviewer = ready.assignments.find((entry) => entry.purpose === "reviewer");
    if (!reviewer) throw new Error("missing reviewer");
    reviewer.tier = "B";
    // 31317 product red: the reducer accepts a reviewer below reviewRequirement and spends
    // one quality failure instead of rejecting the report.
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
      const { ready, block, reviewerId } = qualityReview(initial, failures, [...epochs], cap);
      const reviewed = next(
        reduceRun(
          ready,
          { kind: "review-report", block },
          {
            ...facts,
            newDecisionNonceDigest: () => CONTROL_DIGEST,
          },
        ),
      );
      const result = task(reviewed).state === "review" ? end(reviewed, reviewerId) : reviewed;
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

// biome-ignore-all lint/style/noNonNullAssertion: complete records and prior events are asserted.
import { describe, expect, test } from "vitest";
import { producerHead } from "../../shared/domain/run-engine/delivery-binding";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import { type ReduceFacts, reduceRun } from "../../shared/domain/run-engine/reducer";
import {
  type ArchiveIntent,
  isLocalNeverSent,
  type RunReducerEvent,
} from "../../shared/domain/run-engine/transitions";
import {
  type RunAssignment,
  type RunRecord,
  RunRecordSchema,
  RunStoredReviewSchema,
  RunStoredSmokeReportSchema,
  RunStoredTaskReportSchema,
} from "../../shared/schemas/run-engine/ledger";
import {
  RunReviewReportBlockSchema,
  RunSmokeReportBlockSchema,
  RunTaskReportBlockSchema,
} from "../../shared/schemas/run-engine/protocol";
import { DEV_SMOKE_READY_LEDGER, dispatchIntent, NORMAL_RUN_LEDGER } from "../fixtures/run-engine";

const NOW = "2026-10-30T00:00:00.000Z";
const uuid = (number: number) => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const facts: ReduceFacts = {
  now: NOW,
  newId: () => uuid(900),
  newDecisionNonceDigest: () => "d".repeat(64),
};
const actor = (record: RunRecord, id: string) =>
  record.assignments.find((entry) => entry.assignmentId === id)!;
const task = (record: RunRecord) => record.tasks[0]!;

function ready(attemptCap?: number, smoke = false): RunRecord {
  const record = RunRecordSchema.parse(structuredClone(NORMAL_RUN_LEDGER));
  record.tasks = [record.tasks.find((entry) => entry.spec.id === "t1")!];
  Object.assign(task(record), {
    state: "ready",
    ref: null,
    changedFiles: [],
    currentAssignmentId: null,
    attempts: 0,
  });
  delete task(record).phase;
  record.assignments = [];
  record.nonceRegistry = [];
  record.outbox = [];
  record.resources = [];
  record.events = [];
  record.eventReceipts = [];
  delete record.checkpoint;
  record.counters.eventsThroughSeq = 0;
  record.counters.observationSeq = 0;
  if (attemptCap !== undefined) record.policy.perTask.implementationAttempts = attemptCap;
  if (smoke) {
    task(record).spec.devSmoke = true;
    task(record).spec.smokeChecklist = ["launch", "interaction"];
    task(record).spec.dispatchDuties.smoke = "smoke";
  }
  expect(checkLedgerInvariants(record)).toEqual({ ok: true });
  return record;
}

function apply(
  record: RunRecord,
  event: RunReducerEvent,
  suppliedFacts: ReduceFacts = facts,
): RunRecord {
  const before = structuredClone(record);
  const result = reduceRun(record, event, suppliedFacts);
  expect(record).toEqual(before);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(JSON.stringify(result));
  expect(checkLedgerInvariants(result.next)).toEqual({ ok: true });
  return result.next;
}

function prepareDispatch(
  record: RunRecord,
  id: string,
  purpose: "member" | "reviewer" | "smoker",
  sequence: number,
  prepared = false,
) {
  const source = purpose === "smoker" ? DEV_SMOKE_READY_LEDGER : NORMAL_RUN_LEDGER;
  const template = source.assignments.find((entry) => entry.purpose === purpose)!;
  const head = producerHead(record, "t1");
  const assignment: RunAssignment = {
    ...structuredClone(template),
    assignmentId: id,
    taskId: "t1",
    purpose,
    attempt: purpose === "member" ? task(record).attempts + 1 : task(record).attempts,
    nonce: uuid(sequence),
    messageId: uuid(sequence + 100),
    state: "assigned",
    createdAt: NOW,
    startedAt: null,
    endedAt: null,
    turnId: null,
    endedEventKey: null,
    acceptedProof: null,
    delivery:
      purpose !== "member"
        ? { producerAssignmentId: head.kind === "ok" ? head.assignment.assignmentId : "p1" }
        : null,
  };
  if (id === "r2" || purpose === "smoker") {
    if (id === "r2") {
      assignment.agentId = "agent-r2";
      assignment.seatId = "seat-r2";
    }
    record = structuredClone(record);
    record.roster.push({
      ...source.roster.find((seat) => seat.seatId === template.seatId)!,
      agentId: assignment.agentId,
      seatId: assignment.seatId,
    });
  }
  const scope = task(record).spec.scopes.find((entry) => entry.access === "write")!;
  const event: Extract<RunReducerEvent, { kind: "task-dispatched" }> = {
    kind: "task-dispatched",
    taskId: "t1",
    assignment,
    reissueOfAssignmentId: null,
    nonce: {
      nonce: assignment.nonce,
      runId: record.runId,
      taskId: "t1",
      assignmentId: id,
      attempt: assignment.attempt,
      phase: purpose === "reviewer" ? "review" : purpose === "smoker" ? "smoke" : "implementation",
      agentId: assignment.agentId,
      seatId: assignment.seatId,
      issuedAt: NOW,
      acceptedAt: null,
      acceptedEventKey: null,
      revokedAt: null,
      revokeReason: null,
    },
    intent: dispatchIntent({
      id: `dispatch-${id}`,
      taskId: "t1",
      assignmentId: id,
      recipient: assignment.agentId,
      messageId: assignment.messageId,
      idempotencyKey: `dispatch-${id}`,
      state: prepared ? "prepared" : "confirmed",
      confirmedAt: prepared ? null : NOW,
    }),
    claims:
      purpose === "member"
        ? [
            {
              claimId: "claim-t1",
              taskId: "t1",
              originAssignmentId: id,
              ...scope,
              frozen: false,
              createdAt: NOW,
            },
          ]
        : undefined,
  };
  return { record, event };
}

function dispatch(
  record: RunRecord,
  id: string,
  purpose: "member" | "reviewer" | "smoker",
  sequence: number,
  prepared = false,
) {
  const input = prepareDispatch(record, id, purpose, sequence, prepared);
  return apply(input.record, input.event);
}

function start(record: RunRecord, id: string) {
  return apply(record, {
    kind: "turn-started",
    assignmentId: id,
    agentId: actor(record, id).agentId,
    turnId: `turn-${id}`,
  });
}

function observeEnd(record: RunRecord, id: string) {
  const assignment = actor(record, id);
  const key = `${assignment.agentId}|${assignment.turnId}|turn_ended`;
  return apply(record, {
    kind: "observation-recorded",
    receipt: {
      eventKey: key,
      kind: "turn_ended",
      agentId: assignment.agentId,
      turnId: assignment.turnId,
      seq: record.counters.observationSeq + 1,
      receivedAt: NOW,
      dedupeKey: key,
      disposition: "accepted",
    },
  });
}
function end(record: RunRecord, id: string) {
  const observed = observeEnd(record, id);
  return apply(observed, {
    kind: "turn-ended",
    assignmentId: id,
    endedEventKey: `${actor(observed, id).agentId}|${actor(observed, id).turnId}|turn_ended`,
  });
}

function report(record: RunRecord, invalidEvidence = false, producerId = "p1") {
  const template = RunStoredTaskReportSchema.parse(
    NORMAL_RUN_LEDGER.assignments.find((entry) => entry.assignmentId === "assignment-t1-a1")!
      .acceptedProof,
  );
  const assignment = actor(record, producerId);
  if (invalidEvidence && template.status === "done") template.evidence[0]!.exitCode = 1;
  const block = RunTaskReportBlockSchema.parse({
    ...template,
    runId: record.runId,
    assignmentId: producerId,
    attempt: assignment.attempt,
    nonce: assignment.nonce,
    messageId: assignment.messageId,
    workspace: assignment.workspace,
  });
  return apply(record, { kind: "task-report", block });
}
function reviewEvent(
  record: RunRecord,
  id: string,
  verdict: "可合入" | "不可合入" = "可合入",
): Extract<RunReducerEvent, { kind: "review-report" }> {
  const template = RunStoredReviewSchema.parse(
    NORMAL_RUN_LEDGER.assignments.find((entry) => entry.purpose === "reviewer")!.acceptedProof,
  );
  const assignment = actor(record, id);
  const block = RunReviewReportBlockSchema.parse({
    ...template,
    runId: record.runId,
    assignmentId: id,
    attempt: assignment.attempt,
    nonce: assignment.nonce,
    messageId: assignment.messageId,
    reviewedRef: task(record).ref,
    verdict,
    blockers:
      verdict === "可合入"
        ? []
        : [{ id: "blocking", summary: "Must fix", path: task(record).changedFiles[0] ?? null }],
  });
  return { kind: "review-report", block };
}

function review(record: RunRecord, id: string, verdict: "可合入" | "不可合入" = "可合入") {
  return apply(record, reviewEvent(record, id, verdict));
}

function smokeEvent(record: RunRecord, id = "s1", failed = false) {
  const source = RunStoredSmokeReportSchema.parse(
    DEV_SMOKE_READY_LEDGER.assignments.find((entry) => entry.purpose === "smoker")!.acceptedProof,
  );
  const assignment = actor(record, id);
  return {
    kind: "smoke-report" as const,
    block: RunSmokeReportBlockSchema.parse({
      ...source,
      taskId: "t1",
      runId: record.runId,
      assignmentId: id,
      attempt: assignment.attempt,
      nonce: assignment.nonce,
      messageId: assignment.messageId,
      testedRef: task(record).ref,
      checks: task(record).spec.smokeChecklist.map((check, index) => ({
        id: check,
        result: failed && index === 0 ? "fail" : "pass",
        evidencePath: `evidence/${check}.log`,
      })),
    }),
  };
}

function awaitingReviews(two = false, attemptCap?: number, smoke = false) {
  let record = report(start(dispatch(ready(attemptCap, smoke), "p1", "member", 1), "p1"));
  record = end(record, "p1");
  record = dispatch(record, "r1", "reviewer", 2);
  if (two) record = dispatch(record, "r2", "reviewer", 3);
  return record;
}

function reissueEvent(record: RunRecord): Extract<RunReducerEvent, { kind: "task-dispatched" }> {
  const original = actor(record, "p1");
  const assignment: RunAssignment = {
    ...structuredClone(original),
    assignmentId: "p2",
    nonce: uuid(4),
    messageId: uuid(104),
    state: "assigned",
    createdAt: NOW,
    turnId: null,
    startedAt: null,
    endedAt: null,
    endedEventKey: null,
    acceptedProof: null,
  };
  const nonce = {
    ...record.nonceRegistry.find((entry) => entry.assignmentId === "p1")!,
    nonce: assignment.nonce,
    assignmentId: assignment.assignmentId,
    issuedAt: NOW,
    acceptedAt: null,
    acceptedEventKey: null,
    revokedAt: null,
    revokeReason: null,
  };
  return {
    kind: "task-dispatched",
    taskId: "t1",
    assignment,
    nonce,
    intent: dispatchIntent({
      id: "dispatch-p2",
      taskId: "t1",
      assignmentId: "p2",
      recipient: assignment.agentId,
      messageId: assignment.messageId,
      idempotencyKey: "dispatch-p2",
      state: "confirmed",
      confirmedAt: NOW,
    }),
    reissueOfAssignmentId: "p1",
  };
}

function nextAttemptEvent(record: RunRecord) {
  const event = reissueEvent(record);
  event.assignment.attempt = task(record).attempts + 1;
  event.nonce.attempt = event.assignment.attempt;
  event.reissueOfAssignmentId = null;
  return event;
}

function frozenCancellation(record: RunRecord, ids: string[]) {
  const prepared = ids.map((id, index): ArchiveIntent => {
    const value = dispatchIntent({
      id: `archive-${id}`,
      kind: "archive",
      taskId: "t1",
      assignmentId: id,
      recipient: actor(record, id).agentId,
      messageId: uuid(200 + index),
      idempotencyKey: `archive-${id}`,
      state: "prepared",
      confirmedAt: null,
    });
    if (value.kind !== "archive") throw new Error("archive builder");
    return value;
  });
  return apply(record, {
    kind: "cancel-requested",
    taskIds: ["t1"],
    reason: "cancel",
    controlNonceDigest: "c".repeat(64),
    cancelIntents: ids.map((id) => ({ assignmentId: id, intentId: `archive-${id}` })),
    preparedCancelIntents: prepared,
  });
}

function authorized(record: RunRecord) {
  const next = structuredClone(record);
  const decision = next.decisions.find((entry) => entry.dedupeKey === "cancel:t1")!;
  decision.state = "answered";
  decision.answeredAt = NOW;
  decision.answer = { action: "cancel", taskIds: ["t1"], answeredAt: NOW };
  for (const intent of next.outbox.filter((entry) => entry.kind === "archive")) {
    intent.state = "confirmed";
    intent.confirmedAt = NOW;
  }
  expect(checkLedgerInvariants(next)).toEqual({ ok: true });
  return next;
}
function checked(record: RunRecord, id: string, status: "idle" | "running" = "idle") {
  const observed = observeEnd(record, id);
  const assignment = actor(observed, id);
  return apply(observed, {
    kind: "cancellation-checked",
    taskId: "t1",
    decisionId: observed.decisions[0]!.decisionId,
    evidence: {
      assignmentId: id,
      lastTurnId: assignment.turnId,
      endedEventKey: `${assignment.agentId}|${assignment.turnId}|turn_ended`,
      refresh: {
        agentId: assignment.agentId,
        status,
        activeTurn: status === "running",
        observedAt: NOW,
      },
      observationSeq: observed.counters.observationSeq,
      cancelIntentId: `archive-${id}`,
      receipt: { kind: "archive", confirmedAt: NOW, externalId: `receipt-${id}` },
    },
  });
}

function emptyCancel(): Extract<RunReducerEvent, { kind: "cancel-requested" }> {
  return {
    kind: "cancel-requested",
    taskIds: ["t1"],
    reason: "cancel",
    controlNonceDigest: "c".repeat(64),
    cancelIntents: [],
    preparedCancelIntents: [],
  };
}

function storedCheck(record: RunRecord, id = "r1") {
  const evidence = actor(record, id).cancellation;
  if (!evidence) throw new Error("retained cancellation parent");
  return {
    kind: "cancellation-checked" as const,
    taskId: "t1",
    decisionId: record.decisions[0]!.decisionId,
    evidence: structuredClone(evidence),
  };
}

function openEmptyCancellation(record = ready()) {
  record.decisions.push({
    decisionId: uuid(700),
    category: "D1",
    controlNonceDigest: "c".repeat(64),
    state: "open",
    answer: null,
    dedupeKey: "cancel:t1",
    cancelIntents: [],
    subjectId: "t1",
    summary: "An earlier cancellation still needs a no-effects check",
    createdAt: NOW,
    answeredAt: null,
    resolution: null,
  });
  expect(checkLedgerInvariants(record)).toEqual({ ok: true });
  return record;
}

function compact(record: RunRecord): RunRecord {
  const next = structuredClone(record);
  next.checkpoint = {
    throughSeq: next.counters.eventsThroughSeq,
    historyDigest: "a".repeat(64),
    counters: structuredClone(next.counters),
    acceptedNonceDigests: [],
    terminalAssignmentIds: next.assignments
      .filter((entry) => entry.state === "ended" || entry.state === "cancelled")
      .map((entry) => entry.assignmentId),
  };
  next.events = [];
  return next;
}

function registerTier(
  record: RunRecord,
  id: string,
  purpose: "member" | "reviewer",
  tier: "B" | "A" | "S",
  sequence: number,
) {
  const input = prepareDispatch(record, id, purpose, sequence);
  const assignment = input.event.assignment;
  assignment.tier = tier;
  assignment.family = purpose === "member" ? "producer-family" : "review-family";
  assignment.seatId = `seat-${tier}-${purpose}`;
  assignment.agentId = `agent-${tier}-${purpose}`;
  input.event.nonce.seatId = assignment.seatId;
  input.event.nonce.agentId = assignment.agentId;
  input.event.intent.recipient = assignment.agentId;
  if (!input.record.roster.some((seat) => seat.seatId === assignment.seatId)) {
    input.record = structuredClone(input.record);
    input.record.roster.push({
      seatId: assignment.seatId,
      agentId: assignment.agentId,
      tier,
      channelId: assignment.channelId,
      duties: [purpose === "member" ? "implement" : "review"],
      enabled: true,
    });
  }
  return apply(input.record, input.event);
}

function failedHistory(count: number) {
  let record = ready(9);
  task(record).spec.level = "L1";
  const tiers = ["B", "B", "B", "A", "A", "A", "S", "S", "S"] as const;
  for (let index = 0; index < count; index += 1) {
    const tier = tiers[index]!;
    const p = `p${index + 1}`;
    const r = `rq${index + 1}`;
    record = registerTier(record, p, "member", tier, 20 + index * 2);
    record = end(report(start(record, p), false, p), p);
    record = registerTier(record, r, "reviewer", tier, 21 + index * 2);
    record = end(review(start(record, r), r, "不可合入"), r);
    expect(task(record)).toMatchObject({
      attempts: index + 1,
      reworkCount: index,
      qualityFailures: index + 1,
    });
    expect(record.resources[0]!.originAssignmentId).toBe("p1");
  }
  return record;
}

describe("R01g real reducer positive chains", () => {
  test("retained producer work attempts cannot contain a numbering gap", () => {
    const record = failedHistory(2);
    for (const assignment of record.assignments.filter((entry) => entry.attempt === 2)) {
      assignment.attempt = 3;
      if (assignment.acceptedProof) assignment.acceptedProof.attempt = 3;
      record.nonceRegistry.find(
        (entry) => entry.assignmentId === assignment.assignmentId,
      )!.attempt = 3;
    }
    task(record).attempts = 3;
    expect(RunRecordSchema.safeParse(record).success).toBe(true);
    expect(checkLedgerInvariants(record)).toEqual({
      ok: false,
      violations: [
        {
          invariant: "I6",
          path: ["tasks", "t1", "attempts"],
          params: { reason: "attempt-count-mismatch", expected: 2, actual: 3 },
        },
      ],
    });
  });

  test.each(["actor", "legacy-task"] as const)(
    "a prepared label cannot erase retained turn audit facts: %s",
    (kind) => {
      const record = dispatch(ready(), "p1", "member", 1, true);
      record.events.push({
        seq: record.counters.eventsThroughSeq + 1,
        at: NOW,
        kind: kind === "actor" ? "turn-started" : "turn_started",
        payload:
          kind === "actor"
            ? { assignmentId: "p1", agentId: actor(record, "p1").agentId, turnId: "audit-turn" }
            : { taskId: "t1", turnId: "audit-turn" },
      });
      record.counters.eventsThroughSeq += 1;
      expect(checkLedgerInvariants(record)).toEqual({ ok: true });
      const before = structuredClone(record);
      expect(reduceRun(record, emptyCancel(), facts)).toMatchObject({
        ok: false,
        params: { reason: "incomplete-coverage" },
      });
      expect(record).toEqual(before);
      expect(record.resources).toHaveLength(1);
    },
  );

  test("one work attempt cannot retain two evidence-qualified producer deliveries", () => {
    let record = end(report(start(dispatch(ready(), "p1", "member", 1), "p1"), true), "p1");
    record = apply(record, reissueEvent(record));
    record = end(report(start(record, "p2"), false, "p2"), "p2");
    const oldProof = RunStoredTaskReportSchema.parse(actor(record, "p1").acceptedProof);
    if (oldProof.status !== "done") throw new Error("non-D done parent");
    oldProof.evidence[0]!.exitCode = 0;
    actor(record, "p1").acceptedProof = oldProof;
    expect(RunRecordSchema.safeParse(record).success).toBe(true);
    expect(checkLedgerInvariants(record)).toEqual({
      ok: false,
      violations: [
        {
          invariant: "I7",
          path: ["tasks", "t1", "attempts", 1],
          params: { reason: "multiple-deliveries" },
        },
      ],
    });
  });

  test.each(["ref", "changed-files", "no-D"] as const)(
    "task cache is exactly the current valid D: %s",
    (kind) => {
      const record = kind === "no-D" ? ready() : awaitingReviews();
      if (kind === "changed-files") task(record).changedFiles = ["src/unreported.ts"];
      else task(record).ref = { kind: "git-commit", value: "deadbeef" };
      expect(RunRecordSchema.safeParse(record).success).toBe(true);
      expect(checkLedgerInvariants(record)).toEqual({
        ok: false,
        violations: [
          {
            invariant: "I7",
            path: ["tasks", "t1", kind === "changed-files" ? "changedFiles" : "ref"],
            params: { reason: "delivery-cache" },
          },
        ],
      });
    },
  );

  test.each(["dangling", "cycle"] as const)(
    "producer head validates historical supersession, not only the latest attempt: %s",
    (kind) => {
      const record = failedHistory(2);
      actor(record, "p1").supersededByAssignmentId = kind === "cycle" ? "p1" : "missing";
      expect(RunRecordSchema.safeParse(record).success).toBe(true);
      expect(producerHead(record, "t1")).toEqual({
        kind: "invalid",
        reason: kind === "cycle" ? "producer-cycle" : "producer-successor",
      });
      expect(checkLedgerInvariants(record).ok).toBe(false);
    },
  );

  test.each(["baseCommit", "patchPath"] as const)(
    "a diff ref with the same hash still binds its known %s",
    (field) => {
      const record = awaitingReviews();
      const proof = RunStoredTaskReportSchema.parse(actor(record, "p1").acceptedProof);
      if (proof.status !== "done") throw new Error("producer done");
      const ref = {
        kind: "diff-sha256" as const,
        value: "a".repeat(64),
        baseCommit: "base-commit",
        patchPath: "patches/current.diff",
      };
      proof.ref = ref;
      for (const evidence of proof.evidence) evidence.ref = structuredClone(ref);
      actor(record, "p1").acceptedProof = proof;
      task(record).ref = structuredClone(ref);
      expect(checkLedgerInvariants(record)).toEqual({ ok: true });
      const event = reviewEvent(record, "r1");
      if (event.block.reviewedRef.kind !== "diff-sha256") throw new Error("diff parent");
      event.block.reviewedRef[field] =
        field === "baseCommit" ? "another-base" : "patches/other.diff";
      const before = structuredClone(record);
      expect(reduceRun(record, event, facts)).toMatchObject({
        ok: false,
        params: { reason: "no-valid-review" },
      });
      expect(record).toEqual(before);
    },
  );

  test("a cancellation batch cannot register an archive absent from its exact pair set", () => {
    const record = start(dispatch(ready(), "p1", "member", 1), "p1");
    const intent = (id: string): ArchiveIntent => ({
      ...dispatchIntent({
        id,
        kind: "archive",
        taskId: "t1",
        assignmentId: "p1",
        recipient: actor(record, "p1").agentId,
        messageId: uuid(id === "paired" ? 301 : 302),
        state: "prepared",
        confirmedAt: null,
      }),
      kind: "archive",
      taskId: "t1",
      assignmentId: "p1",
    });
    const before = structuredClone(record);
    expect(
      reduceRun(
        record,
        {
          ...emptyCancel(),
          cancelIntents: [{ assignmentId: "p1", intentId: "paired" }],
          preparedCancelIntents: [intent("paired"), intent("orphan")],
        },
        facts,
      ),
    ).toMatchObject({
      ok: false,
      params: { reason: "unreferenced-cancel-intent" },
    });
    expect(record).toEqual(before);
  });

  test("sealed 167 remains valid when the same agent starts a later legitimate task", () => {
    let record = start(dispatch(ready(), "p1", "member", 1), "p1");
    record = checked(authorized(frozenCancellation(record, ["p1"])), "p1");
    const sealed = structuredClone(actor(record, "p1").cancellation);
    const child = structuredClone(task(ready()));
    child.spec.id = "t2";
    record.tasks.push(child);
    const input = prepareDispatch(record, "p-next", "member", 9);
    input.event.taskId = "t2";
    input.event.assignment.taskId = "t2";
    input.event.assignment.attempt = 1;
    input.event.nonce.taskId = "t2";
    input.event.nonce.attempt = 1;
    input.event.intent.taskId = "t2";
    for (const claim of input.event.claims ?? []) claim.taskId = "t2";
    record = start(apply(input.record, input.event), "p-next");
    record = apply(record, {
      kind: "observation-recorded",
      receipt: {
        eventKey: "later-legitimate-start",
        kind: "turn_started",
        agentId: actor(record, "p-next").agentId,
        turnId: "turn-p-next",
        seq: record.counters.observationSeq + 1,
        receivedAt: NOW,
        dedupeKey: "later-legitimate-start",
        disposition: "accepted",
      },
    });
    expect(actor(record, "p1").cancellation).toEqual(sealed);
    expect(task(record).state).toBe("cancelled");
    expect(record.tasks[1]!.state).toBe("in_progress");
  });

  test("a fully authorized cancellation can finish the run despite its retained fixed pairs", () => {
    let record = start(dispatch(ready(), "p1", "member", 1), "p1");
    record = checked(authorized(frozenCancellation(record, ["p1"])), "p1");
    expect(apply(record, { kind: "run-finished" }).lifecycle).toBe("finished");
  });

  test("real turn-ended also settles retained complete 167 after the host answers", () => {
    let record = start(dispatch(ready(), "p1", "member", 1), "p1");
    record = authorized(frozenCancellation(record, ["p1"]));
    record.decisions[0]!.state = "open";
    record.decisions[0]!.answer = null;
    record.decisions[0]!.answeredAt = null;
    record = checked(record, "p1");
    expect(task(record).state).toBe("blocked");
    record = authorized(record);
    record = end(record, "p1");
    expect(task(record)).toMatchObject({
      state: "cancelled",
      releaseDecisionId: record.decisions[0]!.decisionId,
    });
    expect(record.resources).toEqual([]);
  });

  test("a receipt externalId cannot be copied to another actor's pair", () => {
    let record = start(start(awaitingReviews(true), "r1"), "r2");
    record = checked(authorized(frozenCancellation(record, ["r1", "r2"])), "r1");
    record = observeEnd(record, "r2");
    const event = storedCheck(record);
    event.evidence.assignmentId = "r2";
    event.evidence.lastTurnId = actor(record, "r2").turnId;
    event.evidence.endedEventKey = `${actor(record, "r2").agentId}|turn-r2|turn_ended`;
    event.evidence.refresh.agentId = actor(record, "r2").agentId;
    event.evidence.cancelIntentId = "archive-r2";
    event.evidence.observationSeq = record.counters.observationSeq;
    const original = structuredClone(actor(record, "r1").cancellation);
    record = apply(record, event);
    expect(actor(record, "r1").cancellation).toEqual(original);
    expect(actor(record, "r2").cancellation ?? null).toBeNull();
    expect(task(record)).toMatchObject({ state: "blocked", phase: "frozen" });
    expect(record.resources[0]!.frozen).toBe(true);
  });

  test("a refresh from the wrong actor is rejected without clearing a valid own proof", () => {
    let record = start(start(awaitingReviews(true), "r1"), "r2");
    record = checked(authorized(frozenCancellation(record, ["r1", "r2"])), "r1");
    const event = storedCheck(record);
    event.evidence.refresh.agentId = actor(record, "r2").agentId;
    const before = structuredClone(record);
    expect(reduceRun(record, event, facts)).toMatchObject({
      ok: false,
      params: { reason: "refresh-actor" },
    });
    expect(record).toEqual(before);
  });

  test.each(["missing", "bad-time", "bad-status", "bad-boolean"] as const)(
    "malformed observation is rejected at the input boundary: %s",
    (kind) => {
      let record = start(start(awaitingReviews(true), "r1"), "r2");
      record = checked(authorized(frozenCancellation(record, ["r1", "r2"])), "r1");
      const event = storedCheck(record);
      const runtime = event as unknown as { evidence?: Record<string, unknown> };
      if (kind === "missing") delete runtime.evidence;
      else {
        const refresh = runtime.evidence!.refresh as Record<string, unknown>;
        if (kind === "bad-time") refresh.observedAt = "invalid-time";
        if (kind === "bad-status") refresh.status = "__proto__";
        if (kind === "bad-boolean") refresh.activeTurn = "false";
      }
      const before = structuredClone(record);
      expect(reduceRun(record, event, facts)).toMatchObject({
        ok: false,
        code: "RUN_EVENT_INVALID",
        params: { reason: "event-shape" },
      });
      expect(record).toEqual(before);
    },
  );

  test("a new own turn observation clears unsealed cancellation without losing the observation", () => {
    let record = start(start(awaitingReviews(true), "r1"), "r2");
    record = checked(authorized(frozenCancellation(record, ["r1", "r2"])), "r1");
    const event: RunReducerEvent = {
      kind: "observation-recorded",
      receipt: {
        eventKey: "late-start",
        kind: "turn_started",
        agentId: actor(record, "r1").agentId,
        turnId: "new-turn",
        receivedAt: NOW,
        seq: record.counters.observationSeq + 1,
        dedupeKey: "late-start",
        disposition: "observed",
      },
    };
    record = apply(record, event);
    expect(actor(record, "r1").cancellation).toBeNull();
    expect(record.eventReceipts.at(-1)!.eventKey).toBe("late-start");
    expect(task(record).state).toBe("blocked");
    expect(record.resources[0]!.frozen).toBe(true);
  });

  test.each(["assigned", "in_progress"] as const)(
    "an agent cannot receive a second unsettled business assignment: %s",
    (state) => {
      let record = awaitingReviews();
      if (state === "in_progress") record = start(record, "r1");
      const input = prepareDispatch(record, "r3", "reviewer", 8);
      const before = structuredClone(input.record);
      expect(reduceRun(input.record, input.event, facts)).toMatchObject({
        ok: false,
        params: { reason: "agent-in-flight" },
      });
      expect(input.record).toEqual(before);
    },
  );

  test("a truly ended reviewer may receive another registered role while R2 is pending", () => {
    let record = start(start(awaitingReviews(true), "r1"), "r2");
    record = end(review(record, "r1"), "r1");
    record = dispatch(record, "r3", "reviewer", 8);
    expect(actor(record, "r1").agentId).toBe(actor(record, "r3").agentId);
    expect(task(record).state).toBe("review");
  });

  test("I8 rejects two frozen unresolved assignments for one agent before a new event", () => {
    const record = awaitingReviews(true);
    const first = actor(record, "r1");
    const second = actor(record, "r2");
    second.agentId = first.agentId;
    second.seatId = first.seatId;
    const nonce = record.nonceRegistry.find((entry) => entry.assignmentId === "r2")!;
    nonce.agentId = first.agentId;
    nonce.seatId = first.seatId;
    record.outbox.find((entry) => entry.assignmentId === "r2")!.recipient = first.agentId;
    expect(RunRecordSchema.safeParse(record).success).toBe(true);
    expect(checkLedgerInvariants(record)).toEqual({
      ok: false,
      violations: [
        {
          invariant: "I8",
          path: ["assignments", 2, "agentId"],
          params: { reason: "agent-in-flight", otherAssignmentId: "r1" },
        },
      ],
    });
  });

  test.each(["proof-without-end", "end-without-proof"] as const)(
    "one unsettled smoker covers both proof and actor settlement: %s",
    (kind) => {
      let record = end(review(start(awaitingReviews(false, undefined, true), "r1"), "r1"), "r1");
      record = start(dispatch(record, "s1", "smoker", 5), "s1");
      if (kind === "proof-without-end") record = apply(record, smokeEvent(record));
      else record = end(record, "s1");
      const input = prepareDispatch(record, "s2", "smoker", 6);
      input.event.assignment.agentId = "agent-smoke-2";
      input.event.assignment.seatId = "seat-smoke-2";
      input.event.nonce.agentId = "agent-smoke-2";
      input.event.nonce.seatId = "seat-smoke-2";
      input.event.intent.recipient = "agent-smoke-2";
      Object.assign(input.record.roster.at(-1)!, {
        agentId: "agent-smoke-2",
        seatId: "seat-smoke-2",
      });
      expect(checkLedgerInvariants(input.record)).toEqual({ ok: true });
      const before = structuredClone(input.record);
      expect(reduceRun(input.record, input.event, facts)).toMatchObject({
        ok: false,
        params: { reason: "unsettled-smoker" },
      });
      expect(input.record).toEqual(before);
    },
  );

  test("nine actual failed D traverse B/A/S epochs and finish D3 before the attempt cap", () => {
    const record = failedHistory(9);
    expect(task(record)).toMatchObject({
      state: "failed",
      qualityFailures: 9,
      reworkCount: 8,
      escalations: [
        { fromTier: "B", toTier: "A", atAttempt: 3, qualityFailures: 3 },
        { fromTier: "A", toTier: "S", atAttempt: 6, qualityFailures: 6 },
      ],
    });
    expect(record.decisions).toMatchObject([{ category: "D3", dedupeKey: "quality:p9:D3" }]);
    const historical = RunTaskReportBlockSchema.parse(actor(record, "p1").acceptedProof);
    const nonce = record.nonceRegistry.find((entry) => entry.assignmentId === "p1")!;
    nonce.revokedAt = NOW;
    nonce.revokeReason = "historical";
    expect(apply(record, { kind: "task-report", block: historical })).toEqual(record);
  });

  test.each(["baseline", "rework-count"] as const)(
    "derived historical counters cannot be patched independently: %s",
    (kind) => {
      const record = failedHistory(6);
      if (kind === "baseline") task(record).escalations[1]!.qualityFailures = 5;
      else task(record).reworkCount += 1;
      expect(RunRecordSchema.safeParse(record).success).toBe(true);
      expect(checkLedgerInvariants(record)).toEqual({
        ok: false,
        violations: [
          {
            invariant: "I6",
            path:
              kind === "baseline"
                ? ["tasks", "t1", "escalations", 1, "qualityFailures"]
                : ["tasks", "t1", "reworkCount"],
            params: {
              reason: kind === "baseline" ? "escalation-baseline" : "rework-count-mismatch",
              expected: kind === "baseline" ? 6 : 5,
              actual: kind === "baseline" ? 5 : 6,
            },
          },
        ],
      });
    },
  );

  test("I7 revalidates a historical pass independently of the other review's failure", () => {
    let record = start(start(awaitingReviews(true), "r1"), "r2");
    record = end(end(review(review(record, "r1", "不可合入"), "r2"), "r1"), "r2");
    expect(task(record).state).toBe("rework");
    const proof = RunStoredReviewSchema.parse(actor(record, "r2").acceptedProof);
    proof.reviewedRef = { kind: "git-commit", value: "deadbeef" };
    actor(record, "r2").acceptedProof = proof;
    expect(RunRecordSchema.safeParse(record).success).toBe(true);
    expect(checkLedgerInvariants(record)).toEqual({
      ok: false,
      violations: [
        {
          invariant: "I7",
          path: ["assignments", 2, "acceptedProof"],
          params: { reason: "invalid-historical-proof" },
        },
      ],
    });
  });

  test("a never-sent reservation is cancelled with server-computed typed audit only", () => {
    const record = dispatch(ready(), "p1", "member", 1, true);
    const event = {
      ...emptyCancel(),
      audit: { localIntentIds: ["forged"], supersededDecisionIds: [uuid(777)] },
    };
    const next = apply(record, event);
    expect(task(next)).toMatchObject({ state: "cancelled", releaseDecisionId: null });
    expect(next.resources).toEqual([]);
    expect(actor(next, "p1")).toMatchObject({
      acceptedProof: null,
      turnId: null,
      endedAt: null,
    });
    expect(actor(next, "p1").cancellation ?? null).toBeNull();
    expect(next.eventReceipts).toEqual([]);
    expect(next.events.at(-1)!.payload.audit).toEqual({
      localIntentIds: ["dispatch-p1"],
      supersededDecisionIds: [],
    });
    expect(isLocalNeverSent(next, actor(next, "p1"))).toBe(true);
    expect(checkLedgerInvariants(compact(next))).toEqual({ ok: true });
  });

  test.each(["audit", "scope", "nonce", "turn-fact"] as const)(
    "local cancellation retains its own uncompressed audit closure: %s",
    (field) => {
      const record = apply(dispatch(ready(), "p1", "member", 1, true), emptyCancel());
      if (field === "audit") delete record.events.at(-1)!.payload.audit;
      if (field === "scope") record.events.at(-1)!.payload.taskIds = ["t2"];
      if (field === "nonce") record.nonceRegistry[0]!.revokeReason = "unrelated";
      if (field === "turn-fact") {
        record.eventReceipts.push({
          eventKey: "unowned-start",
          kind: "turn_started",
          agentId: actor(record, "p1").agentId,
          turnId: "unknown-turn",
          seq: 1,
          receivedAt: NOW,
          dedupeKey: "unowned-start",
          disposition: "observed",
        });
        record.counters.observationSeq = 1;
      }
      expect(RunRecordSchema.safeParse(record).success).toBe(true);
      expect(isLocalNeverSent(record, actor(record, "p1"))).toBe(false);
      expect(checkLedgerInvariants(record).ok).toBe(false);
    },
  );

  test("a cancelled empty D1 is superseded with a persistent witness, never a human answer", () => {
    const record = openEmptyCancellation(dispatch(ready(), "p1", "member", 1, true));
    const next = apply(record, emptyCancel());
    const decision = next.decisions[0]!;
    expect(decision).toMatchObject({
      state: "superseded",
      answer: null,
      answeredAt: null,
      resolution: {
        reason: "no-in-flight",
        at: NOW,
        cause: "cancel-requested",
        eventSeq: next.counters.eventsThroughSeq,
        witness: {
          kind: "no-effects-cancel",
          taskId: "t1",
          localIntentIds: ["dispatch-p1"],
        },
      },
    });
    expect(task(next).releaseDecisionId).toBeNull();
    expect(next.events.at(-1)!.payload.audit).toEqual({
      localIntentIds: ["dispatch-p1"],
      supersededDecisionIds: [decision.decisionId],
    });
    const compressed = compact(next);
    expect(checkLedgerInvariants(compressed)).toEqual({ ok: true });
    expect(apply(compressed, { kind: "run-finished" }).lifecycle).toBe("finished");
  });

  test.each(["audit", "witness", "time", "release-id"] as const)(
    "superseded cancellation must retain its typed closure: %s",
    (field) => {
      const record = apply(openEmptyCancellation(), emptyCancel());
      const decision = record.decisions[0]!;
      // Explicitly build the expected typed closure so the old implementation cannot pass by
      // omitting resolution generation entirely.
      decision.state = "superseded";
      decision.resolution = {
        reason: "no-in-flight",
        at: NOW,
        eventSeq: record.counters.eventsThroughSeq,
        cause: "cancel-requested",
        witness: { kind: "no-effects-cancel", taskId: "t1", localIntentIds: [] },
      };
      record.events.at(-1)!.payload.audit = {
        localIntentIds: [],
        supersededDecisionIds: [decision.decisionId],
      };
      expect(checkLedgerInvariants(record)).toEqual({ ok: true });
      if (field === "audit") delete record.events.at(-1)!.payload.audit;
      if (field === "witness") decision.resolution.witness.taskId = "other";
      if (field === "time") decision.resolution.at = "2026-10-30T00:01:00.000Z";
      if (field === "release-id") task(record).releaseDecisionId = decision.decisionId;
      expect(RunRecordSchema.safeParse(record).success).toBe(true);
      expect(checkLedgerInvariants(record).ok).toBe(false);
    },
  );

  test("local withdrawal of a retry preserves the claim from its historical sent producer", () => {
    let record = end(review(start(awaitingReviews(), "r1"), "r1", "不可合入"), "r1");
    const event = nextAttemptEvent(record);
    event.intent.state = "prepared";
    event.intent.confirmedAt = null;
    record = apply(record, event);
    record = apply(record, emptyCancel());
    expect(task(record).state).toBe("blocked");
    expect(record.resources).toMatchObject([{ originAssignmentId: "p1", frozen: true }]);
    expect(record.decisions[0]!.cancelIntents).toEqual([]);
    expect(isLocalNeverSent(record, actor(record, "p2"))).toBe(true);
  });

  test("a repeated no-effects cancellation is byte-stable", () => {
    const record = apply(openEmptyCancellation(), emptyCancel());
    expect(apply(record, emptyCancel())).toEqual(record);
  });

  test("a confirmed effect without a completion witness still blocks run-finished", () => {
    const record = apply(ready(), emptyCancel());
    record.outbox.push(
      dispatchIntent({
        id: "orphan-wake",
        kind: "wake",
        taskId: "t1",
        assignmentId: null,
        recipient: "agent-orphan",
        messageId: uuid(999),
        state: "confirmed",
        confirmedAt: NOW,
      }),
    );
    expect(checkLedgerInvariants(record)).toEqual({ ok: true });
    const before = structuredClone(record);
    expect(reduceRun(record, { kind: "run-finished" }, facts)).toMatchObject({
      ok: false,
      params: { reason: "run-not-finished", intents: 1 },
    });
    expect(record).toEqual(before);
  });

  test("a retry cannot replace an actor's fixed archive intent", () => {
    const record = frozenCancellation(start(dispatch(ready(), "p1", "member", 1), "p1"), ["p1"]);
    const old = record.outbox.find((intent) => intent.id === "archive-p1")!;
    const replacement = { ...structuredClone(old), id: "archive-replacement" } as ArchiveIntent;
    const before = structuredClone(record);
    expect(
      reduceRun(
        record,
        {
          ...emptyCancel(),
          cancelIntents: [{ assignmentId: "p1", intentId: replacement.id }],
          preparedCancelIntents: [replacement],
        },
        facts,
      ),
    ).toMatchObject({
      ok: false,
      params: { reason: "fixed-pair-intent" },
    });
    expect(record).toEqual(before);
  });

  test("B smoker is independent of review tier and cannot finish before registered R2", () => {
    let record = start(start(awaitingReviews(true, undefined, true), "r1"), "r2");
    record = end(review(record, "r1"), "r1");
    const input = prepareDispatch(record, "s1", "smoker", 5);
    input.event.assignment.tier = "B";
    input.record.roster.find((entry) => entry.seatId === input.event.assignment.seatId)!.tier = "B";
    record = start(apply(input.record, input.event), "s1");
    record = end(apply(record, smokeEvent(record)), "s1");
    expect(task(record).state).toBe("review");
    expect(record.resources).toHaveLength(1);
    record = end(review(record, "r2"), "r2");
    expect(task(record).state).toBe("done");
    expect(record.resources).toEqual([]);
  });

  test.each(["reissueOfAssignmentId", "assignment.delivery", "nonce.runId"] as const)(
    "missing frozen dispatch field rejects structurally before factories: %s",
    (field) => {
      const { record, event } = prepareDispatch(ready(), "p1", "member", 1);
      const runtime = event as unknown as Record<string, unknown>;
      if (field === "reissueOfAssignmentId") delete runtime.reissueOfAssignmentId;
      if (field === "assignment.delivery") {
        delete (runtime.assignment as Record<string, unknown>).delivery;
      }
      if (field === "nonce.runId") delete (runtime.nonce as Record<string, unknown>).runId;
      const calls: string[] = [];
      const before = structuredClone(record);
      expect(
        reduceRun(record, event, {
          ...facts,
          newId: () => {
            calls.push("id");
            return uuid(950);
          },
          newDecisionNonceDigest: () => {
            calls.push("digest");
            return "a".repeat(64);
          },
        }),
      ).toMatchObject({ ok: false, code: "RUN_EVENT_INVALID", params: { reason: "event-shape" } });
      expect(calls).toEqual([]);
      expect(record).toEqual(before);
    },
  );

  test.each(["cancelIntents", "preparedCancelIntents"] as const)(
    "missing cancellation array rejects structurally before factories: %s",
    (field) => {
      const record = ready();
      const runtime: Record<string, unknown> = {
        kind: "cancel-requested",
        taskIds: ["t1"],
        reason: "cancel",
        controlNonceDigest: "c".repeat(64),
        cancelIntents: [],
        preparedCancelIntents: [],
      };
      delete runtime[field];
      const before = structuredClone(record);
      expect(reduceRun(record, runtime as RunReducerEvent, facts)).toMatchObject({
        ok: false,
        code: "RUN_EVENT_INVALID",
        params: { reason: "event-shape" },
      });
      expect(record).toEqual(before);
    },
  );

  test("registered smoker accepts a late proof after R2 failure without done or a second F", () => {
    let record = start(start(awaitingReviews(true, undefined, true), "r1"), "r2");
    record = end(review(record, "r1"), "r1");
    record = start(dispatch(record, "s1", "smoker", 5), "s1");
    record = review(record, "r2", "不可合入");
    record = end(end(record, "r2"), "s1");
    expect(task(record)).toMatchObject({ state: "rework", qualityFailures: 1 });
    const failures = record.events.filter((event) => event.kind === "quality_failed").length;
    record = apply(record, smokeEvent(record));
    expect(actor(record, "s1").acceptedProof).not.toBeNull();
    expect(task(record)).toMatchObject({ state: "rework", qualityFailures: 1 });
    expect(record.events.filter((event) => event.kind === "quality_failed")).toHaveLength(failures);
  });

  test.each(["directory", "second-scope"] as const)(
    "a partial claim cannot shrink the frozen write authorization: %s",
    (kind) => {
      const record = ready();
      task(record).spec.scopes = [
        { repoId: "repo-re-verify", kind: "directory", path: "src", access: "write" },
      ];
      if (kind === "second-scope")
        task(record).spec.scopes.push({
          repoId: "repo-re-verify",
          kind: "file",
          path: "docs/design.md",
          access: "write",
        });
      const input = prepareDispatch(record, "p1", "member", 1);
      if (kind === "directory") {
        input.event.claims![0]!.kind = "file";
        input.event.claims![0]!.path = "src/one.ts";
      }
      expect(checkLedgerInvariants(input.record)).toEqual({ ok: true });
      const before = structuredClone(input.record);
      expect(reduceRun(input.record, input.event, facts)).toMatchObject({
        ok: false,
        path: ["claims"],
        params: { reason: "scope-not-covered" },
      });
      expect(input.record).toEqual(before);
    },
  );

  test.each(["tier", "duty", "disabled"] as const)(
    "producer registration requires its frozen structural seat: %s",
    (kind) => {
      const record = ready();
      if (kind === "tier") {
        task(record).spec.tier = "S";
        task(record).spec.level = "L4";
      }
      const input = prepareDispatch(record, "p1", "member", 1);
      const seat = input.record.roster.find(
        (entry) => entry.seatId === input.event.assignment.seatId,
      )!;
      if (kind === "duty") seat.duties = ["review"];
      if (kind === "disabled") seat.enabled = false;
      expect(checkLedgerInvariants(input.record)).toEqual({ ok: true });
      const before = structuredClone(input.record);
      expect(reduceRun(input.record, input.event, facts)).toMatchObject({
        ok: false,
        path: ["assignment", "seatId"],
        params: { reason: "structural-seat" },
      });
      expect(input.record).toEqual(before);
    },
  );
  test("duplicate observation is byte-stable rather than another audit event", () => {
    const record = observeEnd(start(dispatch(ready(), "p1", "member", 1), "p1"), "p1");
    const next = apply(record, {
      kind: "observation-recorded",
      receipt: structuredClone(record.eventReceipts[0]!),
    });
    expect(next).toEqual(record);
  });

  test("true completion makes its pending dependency ready", () => {
    let record = review(start(awaitingReviews(), "r1"), "r1");
    const child = structuredClone(task(ready()));
    child.spec.id = "t3";
    child.spec.deps = ["t1"];
    child.state = "pending";
    record.tasks.push(child);
    expect(checkLedgerInvariants(record)).toEqual({ ok: true });
    record = end(record, "r1");
    expect(task(record).state).toBe("done");
    expect(record.tasks.find((entry) => entry.spec.id === "t3")!.state).toBe("ready");
  });

  test("runtime multi-task cancellation rejects shape before touching any task", () => {
    const record = ready();
    const second = structuredClone(task(record));
    second.spec.id = "t2";
    record.tasks.push(second);
    expect(checkLedgerInvariants(record)).toEqual({ ok: true });
    // Deliberately cross the typed single-task tuple at the untrusted runtime boundary.
    const event = {
      kind: "cancel-requested",
      taskIds: ["t1", "t2"],
      reason: "cancel",
      controlNonceDigest: "c".repeat(64),
      cancelIntents: [],
      preparedCancelIntents: [],
    } as unknown as RunReducerEvent;
    const before = structuredClone(record);
    expect(reduceRun(record, event, facts)).toMatchObject({
      ok: false,
      path: ["cancel", "taskIds"],
      params: { reason: "single-task-required" },
    });
    expect(record).toEqual(before);
  });

  test("future observation watermark is rejected at the observation boundary", () => {
    let record = start(dispatch(ready(), "p1", "member", 1), "p1");
    record = observeEnd(authorized(frozenCancellation(record, ["p1"])), "p1");
    const assignment = actor(record, "p1");
    const event: Extract<RunReducerEvent, { kind: "cancellation-checked" }> = {
      kind: "cancellation-checked",
      taskId: "t1",
      decisionId: record.decisions[0]!.decisionId,
      evidence: {
        assignmentId: "p1",
        lastTurnId: assignment.turnId,
        endedEventKey: record.eventReceipts[0]!.eventKey,
        refresh: {
          agentId: assignment.agentId,
          status: "idle",
          activeTurn: false,
          observedAt: NOW,
        },
        observationSeq: 999,
        cancelIntentId: "archive-p1",
        receipt: { kind: "archive", confirmedAt: NOW, externalId: "receipt-p1" },
      },
    };
    const before = structuredClone(record);
    expect(reduceRun(record, event, facts)).toMatchObject({
      ok: false,
      params: { reason: "observation-watermark" },
    });
    expect(record).toEqual(before);
    expect(record.resources[0]!.frozen).toBe(true);
  });

  test("explicit task cancellation revokes only the unused live nonce window", () => {
    const record = start(dispatch(ready(), "p1", "member", 1), "p1");
    const next = frozenCancellation(record, ["p1"]);
    expect(next.nonceRegistry[0]).toMatchObject({
      acceptedAt: null,
      revokedAt: NOW,
      revokeReason: "cancel-requested",
    });
  });

  test("pause blocks new dispatch while an already delivered report remains receivable", () => {
    const record = apply(start(dispatch(ready(), "p1", "member", 1), "p1"), { kind: "run-paused" });
    expect(reduceRun(record, nextAttemptEvent(record), facts)).toMatchObject({ ok: false });
    const next = report(record);
    expect(next.lifecycle).toBe("paused");
    expect(task(next).state).toBe("review");
  });
  test("an authentic report may arrive after its observed turn end", () => {
    const record = end(start(dispatch(ready(), "p1", "member", 1), "p1"), "p1");
    const next = report(record);
    expect(task(next).state).toBe("review");
    expect(actor(next, "p1").acceptedProof).not.toBeNull();
  });

  test("a prepared dispatch cannot authorize a new proof", () => {
    const received = report(start(dispatch(ready(), "p1", "member", 1), "p1"));
    const block = RunTaskReportBlockSchema.parse(actor(received, "p1").acceptedProof);
    const record = dispatch(ready(), "p1", "member", 1, true);
    const before = structuredClone(record);
    expect(reduceRun(record, { kind: "task-report", block }, facts)).toMatchObject({ ok: false });
    expect(record).toEqual(before);
  });

  test.each(["workspace", "ref", "isolation"] as const)(
    "historical nested extension stays stored but is not canonical: %s",
    (field) => {
      const record = awaitingReviews();
      const stored = RunStoredTaskReportSchema.parse(actor(record, "p1").acceptedProof);
      if (stored.status !== "done") throw new Error("done source");
      const block = RunTaskReportBlockSchema.parse(stored);
      if (field === "workspace") stored.workspace.futureMetadata = "retained";
      else if (field === "ref") stored.ref.futureMetadata = "retained";
      else stored.evidence[0]!.isolation!.futureMetadata = "retained";
      actor(record, "p1").acceptedProof = stored;
      const nonce = record.nonceRegistry.find((entry) => entry.assignmentId === "p1")!;
      nonce.revokedAt = NOW;
      nonce.revokeReason = "historical";
      expect(checkLedgerInvariants(record)).toEqual({ ok: true });
      const next = apply(record, { kind: "task-report", block });
      expect(next).toEqual(record);
    },
  );

  test("a supplied wrong messageId cannot be normalized into an accepted replay", () => {
    const record = awaitingReviews();
    const block = RunTaskReportBlockSchema.parse(actor(record, "p1").acceptedProof);
    block.messageId = uuid(999);
    expect(reduceRun(record, { kind: "task-report", block }, facts)).toMatchObject({ ok: false });
  });

  test("a different known field is a nonce replay, without mutation", () => {
    const record = awaitingReviews();
    const block = RunTaskReportBlockSchema.parse(actor(record, "p1").acceptedProof);
    if (block.status !== "done") throw new Error("done source");
    block.evidence[0]!.summary = "changed canonical content";
    const before = structuredClone(record);
    expect(reduceRun(record, { kind: "task-report", block }, facts)).toMatchObject({
      ok: false,
      params: { reason: "nonce-replay" },
    });
    expect(record).toEqual(before);
  });

  test("an under-tier reviewer proof is rejected before acceptance", () => {
    const record = start(awaitingReviews(), "r1");
    const reviewer = actor(record, "r1");
    reviewer.tier = "B";
    record.roster.find((entry) => entry.seatId === reviewer.seatId)!.tier = "B";
    const before = structuredClone(record);
    expect(RunRecordSchema.safeParse(record).success).toBe(true);
    expect(reduceRun(record, reviewEvent(record, "r1", "不可合入"), facts)).toMatchObject({
      ok: false,
    });
    expect(record).toEqual(before);
    expect(task(record).qualityFailures).toBe(0);
  });

  test("two failed reviewers of one D count once and wait for true actor settlement", () => {
    let record = start(start(awaitingReviews(true), "r1"), "r2");
    const claim = structuredClone(record.resources[0]);
    record = review(record, "r1", "不可合入");
    expect(task(record)).toMatchObject({
      state: "review",
      phase: "awaiting-rework",
      qualityFailures: 1,
      reworkCount: 0,
    });
    expect(record.resources).toEqual([claim]);
    expect(reduceRun(record, nextAttemptEvent(record), facts)).toMatchObject({ ok: false });
    record = review(record, "r2", "不可合入");
    expect(task(record).qualityFailures).toBe(1);
    record = end(end(record, "r1"), "r2");
    expect(task(record).state).toBe("rework");
    record = apply(record, nextAttemptEvent(record));
    expect(task(record)).toMatchObject({ attempts: 2, reworkCount: 1, qualityFailures: 1 });
    expect(record.resources[0]!.originAssignmentId).toBe("p1");
  });

  test("missing D4 digest rolls back proof, nonce, failure count and events", () => {
    const record = start(awaitingReviews(false, 1), "r1");
    const before = structuredClone(record);
    expect(
      reduceRun(record, reviewEvent(record, "r1", "不可合入"), {
        ...facts,
        newDecisionNonceDigest: undefined,
      }),
    ).toMatchObject({ ok: false, params: { reason: "missing-control-nonce-digest" } });
    expect(record).toEqual(before);
  });

  test("D4 keeps registered late replies receivable and creates only one decision", () => {
    let record = start(start(awaitingReviews(true, 1), "r1"), "r2");
    const calls: string[] = [];
    const supplied = {
      ...facts,
      newDecisionNonceDigest: (category: "D3" | "D4", id: string) => {
        calls.push(`${category}:${id}`);
        return "d".repeat(64);
      },
    };
    record = apply(record, reviewEvent(record, "r1", "不可合入"), supplied);
    expect(task(record)).toMatchObject({ state: "blocked", phase: "frozen", qualityFailures: 1 });
    record = apply(record, reviewEvent(record, "r2", "不可合入"), supplied);
    expect(calls).toEqual(["D4:t1"]);
    expect(record.decisions).toHaveLength(1);
    expect(task(record).qualityFailures).toBe(1);
    expect(actor(record, "r2").acceptedProof).not.toBeNull();
  });

  test("an old failed D with the same ref cannot contaminate the new D", () => {
    let record = start(awaitingReviews(), "r1");
    record = end(review(record, "r1", "不可合入"), "r1");
    const old = reviewEvent(record, "r1", "不可合入");
    record = apply(record, nextAttemptEvent(record));
    record = report(start(record, "p2"), false, "p2");
    const before = structuredClone(record);
    record = apply(record, old);
    expect(record).toEqual(before);
    expect(task(record)).toMatchObject({ state: "review", qualityFailures: 1, attempts: 2 });
  });
  test("same-attempt evidence reissue follows its real ended non-D producer", () => {
    let record = report(start(dispatch(ready(), "p1", "member", 1), "p1"), true);
    record = end(record, "p1");
    expect(task(record).evidenceReturns).toBe(1);
    const originalProof = structuredClone(actor(record, "p1").acceptedProof);
    const next = apply(record, reissueEvent(record));
    expect(producerHead(next, "t1")).toMatchObject({
      kind: "ok",
      assignment: { assignmentId: "p2" },
    });
    expect(actor(next, "p1").acceptedProof).toEqual(originalProof);
    expect(actor(next, "p1").supersededByAssignmentId).toBe("p2");
    expect(task(next)).toMatchObject({ attempts: 1, reworkCount: 0, ref: null, changedFiles: [] });
    expect(next.resources[0]!.originAssignmentId).toBe("p1");
  });

  test("a valid D cannot use evidence reissue as an attempt bypass", () => {
    const record = end(report(start(dispatch(ready(), "p1", "member", 1), "p1")), "p1");
    const before = structuredClone(record);
    expect(reduceRun(record, reissueEvent(record), facts)).toMatchObject({
      ok: false,
      params: { reason: "reissue" },
    });
    expect(record).toEqual(before);
  });
  test("producer start authorizes its head, not the display pointer", () => {
    const record = dispatch(ready(), "p1", "member", 1);
    task(record).currentAssignmentId = null;
    const next = start(record, "p1");
    expect(task(next).state).toBe("in_progress");
  });
  test("dispatch/start/report/true end/review/true end completes and releases claim", () => {
    let record = awaitingReviews();
    expect(task(record).attempts).toBe(1);
    expect(record.resources).toHaveLength(1);
    record = review(start(record, "r1"), "r1");
    expect(task(record).state).toBe("review");
    record = end(record, "r1");
    expect(task(record).state).toBe("done");
    expect(record.resources).toEqual([]);
  });

  test("noncurrent R1 turn/report/end cannot bypass registered R2", () => {
    let record = awaitingReviews(true);
    const claim = structuredClone(record.resources[0]);
    expect(task(record).currentAssignmentId).toBe("r2");
    record = end(review(start(record, "r1"), "r1"), "r1");
    expect(task(record).state).toBe("review");
    expect(record.resources).toEqual([claim]);
    record = end(review(start(record, "r2"), "r2"), "r2");
    expect(task(record).state).toBe("done");
    expect(record.resources).toEqual([]);
  });

  test("matching receipt/refresh/archive plus explicit authorization completes cancellation", () => {
    let record = start(dispatch(ready(), "p1", "member", 1), "p1");
    record = frozenCancellation(record, ["p1"]);
    expect(task(record).phase).toBe("frozen");
    expect(record.resources[0]!.frozen).toBe(true);
    record = checked(authorized(record), "p1");
    expect(task(record).state).toBe("cancelled");
    expect(record.resources).toEqual([]);
    expect(task(record).releaseDecisionId).toBe(record.decisions[0]!.decisionId);
  });

  test("each reviewer cancellation pair remains an independent obligation", () => {
    let record = start(start(awaitingReviews(true), "r1"), "r2");
    record = authorized(frozenCancellation(record, ["r1", "r2"]));
    record = checked(record, "r1");
    expect(task(record).state).toBe("blocked");
    expect(record.resources[0]!.frozen).toBe(true);
    record = checked(record, "r2");
    expect(task(record).state).toBe("cancelled");
    expect(record.resources).toEqual([]);
  });

  test("running refresh clears only its previous cancellation evidence and freezes", () => {
    let record = start(start(awaitingReviews(true), "r1"), "r2");
    record = checked(authorized(frozenCancellation(record, ["r1", "r2"])), "r1");
    const proof = structuredClone(actor(record, "p1").acceptedProof);
    expect(actor(record, "r1").cancellation).not.toBeNull();
    record = checked(record, "r1", "running");
    expect(actor(record, "r1").cancellation).toBeNull();
    expect(actor(record, "p1").acceptedProof).toEqual(proof);
    expect(task(record).state).toBe("blocked");
    expect(record.resources[0]!.frozen).toBe(true);
  });

  test("complete evidence without explicit answered authorization keeps resources frozen", () => {
    let record = start(dispatch(ready(), "p1", "member", 1), "p1");
    record = authorized(frozenCancellation(record, ["p1"]));
    record.decisions[0]!.state = "open";
    record.decisions[0]!.answer = null;
    record.decisions[0]!.answeredAt = null;
    expect(checkLedgerInvariants(record)).toEqual({ ok: true });
    record = checked(record, "p1");
    expect(actor(record, "p1").cancellation).not.toBeNull();
    expect(task(record).state).toBe("blocked");
    expect(record.resources[0]!.frozen).toBe(true);
  });

  test.each(["refresh-actor", "refresh-time", "turn", "intent", "watermark"] as const)(
    "stored 167 single defect is I7: %s",
    (kind) => {
      let record = start(start(awaitingReviews(true), "r1"), "r2");
      record = checked(authorized(frozenCancellation(record, ["r1", "r2"])), "r1");
      const evidence = actor(record, "r1").cancellation!;
      if (kind === "refresh-actor") evidence.refresh.agentId = "other-agent";
      else if (kind === "refresh-time") evidence.refresh.observedAt = "2026-10-29T00:00:00.000Z";
      else if (kind === "turn") evidence.lastTurnId = "other-turn";
      else if (kind === "intent") evidence.cancelIntentId = "other-intent";
      else evidence.observationSeq = record.counters.observationSeq + 1;
      expect(RunRecordSchema.safeParse(record).success).toBe(true);
      expect(checkLedgerInvariants(record)).toEqual({
        ok: false,
        violations: [
          {
            invariant: "I7",
            path: [
              "assignments",
              record.assignments.findIndex((entry) => entry.assignmentId === "r1"),
              "cancellation",
            ],
            params: { reason: "invalid-cancellation-proof" },
          },
        ],
      });
    },
  );

  test.each(["missing-proof", "open-authorization", "superseded-authorization"] as const)(
    "cancelled task cannot lose its fixed obligation: %s",
    (kind) => {
      let record = start(dispatch(ready(), "p1", "member", 1), "p1");
      record = checked(authorized(frozenCancellation(record, ["p1"])), "p1");
      const decision = record.decisions[0]!;
      if (kind === "missing-proof") actor(record, "p1").cancellation = null;
      else {
        decision.state = kind === "open-authorization" ? "open" : "superseded";
        decision.answer = null;
        decision.answeredAt = null;
        if (decision.state === "superseded")
          decision.resolution = {
            reason: "no-in-flight",
            at: NOW,
            eventSeq: record.events.find((entry) => entry.kind === "cancel-requested")!.seq,
            cause: "cancel-requested",
            witness: { kind: "no-effects-cancel", taskId: "t1", localIntentIds: [] },
          };
      }
      expect(RunRecordSchema.safeParse(record).success).toBe(true);
      expect(checkLedgerInvariants(record)).toEqual({
        ok: false,
        violations: [
          ...(kind === "superseded-authorization"
            ? [
                {
                  invariant: "I8",
                  path: ["decisions", 0, "resolution"],
                  params: { reason: "invalid-resolution" },
                },
              ]
            : []),
          {
            invariant: "I7",
            path:
              kind === "missing-proof"
                ? ["assignments", 0, "cancellation"]
                : ["tasks", "t1", "releaseDecisionId"],
            params: {
              reason:
                kind === "missing-proof"
                  ? "invalid-cancellation-proof"
                  : "cancellation-without-authorization",
            },
          },
        ],
      });
    },
  );
});

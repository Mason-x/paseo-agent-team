// biome-ignore-all lint/style/noNonNullAssertion: complete records and prior events are asserted.
import { describe, expect, test } from "vitest";
import { producerHead } from "../../shared/domain/run-engine/delivery-binding";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import { type ReduceFacts, reduceRun } from "../../shared/domain/run-engine/reducer";
import type { ArchiveIntent, RunReducerEvent } from "../../shared/domain/run-engine/transitions";
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
  const assignment: RunAssignment = {
    ...structuredClone(template),
    assignmentId: id,
    taskId: "t1",
    purpose,
    nonce: uuid(sequence),
    messageId: uuid(sequence + 100),
    state: "assigned",
    createdAt: NOW,
    startedAt: null,
    endedAt: null,
    turnId: null,
    endedEventKey: null,
    acceptedProof: null,
    delivery: purpose !== "member" ? { producerAssignmentId: "p1" } : null,
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
      attempt: 1,
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

describe("R01g real reducer positive chains", () => {
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

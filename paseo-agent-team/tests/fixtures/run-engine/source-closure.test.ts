import { describe, expect, test } from "vitest";
import {
  RunRecordSchema,
  RunStoredTaskReportSchema,
} from "../../../shared/schemas/run-engine/ledger";
import {
  AT_UPDATED,
  CANCELLATION_AUTHORIZED_FROZEN_LEDGER,
  CONTROL_ATTEMPTS_LEDGER,
  DEV_SMOKE_READY_LEDGER,
  dispatchIntent,
  INVARIANT_CASES,
  LOCK_CONFLICT_RUN_B,
  NORMAL_RUN_LEDGER,
  QUIESCENT_CANCELLED_LEDGER,
} from "./index";
import { collectSourceIssues, type SourceIssueKey, type SourceScenario } from "./source-closure";
import type { LedgerFixture } from "./types";

const NORMAL: SourceScenario = { cacheSource: { t1: "assignment-t1-a1" }, cancelObligations: {} };
const DEV: SourceScenario = {
  cacheSource: { t1: "assignment-t1-a1", t6: "assignment-t6-a1" },
  cancelObligations: {},
};
const QUIESCENT: SourceScenario = {
  cacheSource: { t1: "assignment-t1-a1" },
  cancelObligations: { t2: ["assignment-t2-a1"] },
};

function keys(record: LedgerFixture, scenario: SourceScenario): SourceIssueKey[] {
  const parsed = RunRecordSchema.safeParse(record);
  expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
  return collectSourceIssues(record, scenario).map(({ code, path }) => ({ code, path }));
}

function assignment(record: LedgerFixture, id: string) {
  const found = record.assignments.find((entry) => entry.assignmentId === id);
  if (!found) throw new Error(`missing test assignment ${id}`);
  return found;
}

function task(record: LedgerFixture, id: string) {
  const found = record.tasks.find((entry) => entry.spec.id === id);
  if (!found) throw new Error(`missing test task ${id}`);
  return found;
}

function nonce(record: LedgerFixture, assignmentId: string) {
  const found = record.nonceRegistry.find((entry) => entry.assignmentId === assignmentId);
  if (!found) throw new Error(`missing test nonce ${assignmentId}`);
  return found;
}

function crossTaskPair(record: LedgerFixture): void {
  const decision = record.decisions.find((entry) => entry.subjectId === "t2");
  if (!decision?.cancelIntents) throw new Error("missing test cancellation decision");
  record.outbox.push(
    dispatchIntent({
      id: "intent-t1-extra",
      kind: "archive",
      taskId: "t1",
      assignmentId: "assignment-t1-a1",
      recipient: "agent-b1",
      messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9",
      idempotencyKey: "cancel-t1-extra",
      state: "confirmed",
      confirmedAt: AT_UPDATED,
    }),
  );
  decision.cancelIntents.unshift({ assignmentId: "assignment-t1-a1", intentId: "intent-t1-extra" });
}

function freeze(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}

const DISPATCH_STAGES = [
  {
    phase: "unaccepted",
    assignmentId: "assignment-t2-a1",
    intentId: "intent-t2-a1",
    otherTaskId: "t1",
  },
  {
    phase: "accepted",
    assignmentId: "assignment-t1-a1",
    intentId: "intent-t1-a1",
    otherTaskId: "t2",
  },
] as const;

describe.each(DISPATCH_STAGES)("dispatch identity: $phase", (stage) => {
  test("normal source closes without manufacturing acceptance facts", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    expect(assignment(record, stage.assignmentId).acceptedProof === null).toBe(
      stage.phase === "unaccepted",
    );
    expect(keys(record, NORMAL)).toEqual([]);
  });

  test.each([
    { fields: ["taskId"] },
    { fields: ["recipient"] },
    { fields: ["messageId"] },
    { fields: ["recipient", "messageId"] },
  ] as const)("reports the complete identity issue set for $fields", ({ fields }) => {
    expect(keys(NORMAL_RUN_LEDGER, NORMAL)).toEqual([]);
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const intent = record.outbox.find((entry) => entry.id === stage.intentId);
    if (!intent) throw new Error(`missing test dispatch ${stage.intentId}`);
    for (const field of fields) {
      if (field === "taskId") intent.taskId = stage.otherTaskId;
      else if (field === "recipient") intent.recipient = "agent-other";
      else intent.messageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa90";
    }
    const expected = fields
      .map((field) => ({ code: "dispatch-binding", path: `outbox.${stage.intentId}.${field}` }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const actual = keys(record, NORMAL);
    if (stage.phase === "unaccepted" && fields.length === 2) {
      console.log("[230 unaccepted compound]", JSON.stringify(collectSourceIssues(record, NORMAL)));
    }
    expect(actual).toEqual(expected);
  });

  test.each(["missing", "duplicate"] as const)(
    "%s dispatch keeps its cardinality issue",
    (kind) => {
      expect(keys(NORMAL_RUN_LEDGER, NORMAL)).toEqual([]);
      const record = structuredClone(NORMAL_RUN_LEDGER);
      const intent = record.outbox.find((entry) => entry.id === stage.intentId);
      if (!intent) throw new Error(`missing test dispatch ${stage.intentId}`);
      if (kind === "missing") {
        record.outbox = record.outbox.filter((entry) => entry.id !== stage.intentId);
      } else {
        record.outbox.push({
          ...intent,
          id: `${intent.id}-duplicate`,
          idempotencyKey: `${intent.idempotencyKey}-duplicate`,
        });
      }
      expect(keys(record, NORMAL)).toEqual([
        { code: "assignment-dispatch", path: `assignments.${stage.assignmentId}.dispatch` },
      ]);
    },
  );
});

describe.each(DISPATCH_STAGES)("231 nonce identity: $phase", (stage) => {
  test.each(["missing", "duplicate"] as const)("%s registry association", (kind) => {
    expect(keys(NORMAL_RUN_LEDGER, NORMAL)).toEqual([]);
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const own = nonce(record, stage.assignmentId);
    if (kind === "missing")
      record.nonceRegistry = record.nonceRegistry.filter((entry) => entry !== own);
    else record.nonceRegistry.push(structuredClone(own));
    expect(keys(record, NORMAL)).toEqual([
      { code: "assignment-nonce", path: `assignments.${stage.assignmentId}.nonce` },
    ]);
  });

  test.each([
    "nonce",
    "runId",
    "taskId",
    "assignmentId",
    "attempt",
    "agentId",
    "seatId",
    "phase",
  ] as const)("registry %s binds frozen assignment identity", (field) => {
    expect(keys(NORMAL_RUN_LEDGER, NORMAL)).toEqual([]);
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const own = nonce(record, stage.assignmentId);
    if (field === "nonce") own.nonce = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa92";
    else if (field === "runId") own.runId = "run-other-92";
    else if (field === "taskId") own.taskId = stage.otherTaskId;
    else if (field === "assignmentId") own.assignmentId = "assignment-other-92";
    else if (field === "attempt") own.attempt += 1;
    else if (field === "agentId") own.agentId = "agent-other-92";
    else if (field === "seatId") own.seatId = "seat-other-92";
    else own.phase = "review";
    expect(keys(record, NORMAL)).toEqual([
      {
        code: field === "runId" ? "nonce-run" : "nonce-binding",
        path: `nonceRegistry.${own.nonce}.${field}`,
      },
    ]);
  });
});

describe("231 finite source closure", () => {
  test.each([
    { id: "lock-conflict-run-b", ledger: LOCK_CONFLICT_RUN_B },
    { id: "control-attempts", ledger: CONTROL_ATTEMPTS_LEDGER },
    {
      id: "i3-pending-holds-claim",
      ledger: INVARIANT_CASES.find((entry) => entry.id === "i3-pending-holds-claim")
        ?.ledger as LedgerFixture,
    },
  ])("authorized t3 nonce source repair is necessary and exact: $id", ({ ledger }) => {
    expect(keys(ledger, NORMAL)).toEqual([]);
    const record = structuredClone(ledger);
    const before = JSON.stringify(record);
    const own = nonce(record, "assignment-t3-a1");
    expect(own).toMatchObject({
      runId: record.runId,
      taskId: "t3",
      assignmentId: "assignment-t3-a1",
      nonce: assignment(record, "assignment-t3-a1").nonce,
      acceptedAt: null,
      acceptedEventKey: null,
      revokedAt: null,
      revokeReason: null,
    });
    record.nonceRegistry = record.nonceRegistry.filter((entry) => entry !== own);
    expect(keys(record, NORMAL)).toEqual([
      { code: "assignment-nonce", path: "assignments.assignment-t3-a1.nonce" },
    ]);
    expect(JSON.stringify(ledger)).toBe(before);
  });

  test("accepted reviewer nonce actor and independent cache error both survive collection", () => {
    expect(keys(NORMAL_RUN_LEDGER, NORMAL)).toEqual([]);
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const own = nonce(record, "assignment-t1-r1");
    own.agentId = "agent-wrong";
    expect(keys(record, NORMAL)).toEqual([
      { code: "nonce-binding", path: `nonceRegistry.${own.nonce}.agentId` },
    ]);
    task(record, "t2").ref = { kind: "git-commit", value: "deadbeef" };
    expect(keys(record, NORMAL)).toEqual([
      { code: "cache-source", path: "tasks.t2.cacheSource" },
      { code: "nonce-binding", path: `nonceRegistry.${own.nonce}.agentId` },
    ]);
    const scenario = structuredClone(NORMAL);
    const before = JSON.stringify({ record, scenario });
    freeze(record);
    freeze(scenario);
    const actual = collectSourceIssues(record, scenario);
    const reversed = structuredClone(record);
    reversed.assignments.reverse();
    reversed.nonceRegistry.reverse();
    reversed.outbox.reverse();
    expect(collectSourceIssues(reversed, scenario)).toEqual(actual);
    expect(JSON.stringify({ record, scenario })).toBe(before);
    console.log("[231 nonce+cache]", JSON.stringify(actual));
  });

  test("done without a declared producer is not a source-closed completion", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.tasks = record.tasks.filter((entry) => entry.spec.id === "t1");
    record.assignments = [];
    record.nonceRegistry = [];
    record.outbox = [];
    record.resources = [];
    const t1 = task(record, "t1");
    t1.state = "ready";
    delete t1.phase;
    t1.currentAssignmentId = null;
    t1.ref = null;
    t1.changedFiles = [];
    const scenario: SourceScenario = { cacheSource: { t1: null }, cancelObligations: {} };
    expect(keys(record, scenario)).toEqual([]);
    t1.state = "done";
    expect(keys(record, scenario)).toEqual([
      { code: "done-producer-chain", path: "tasks.t1.producer" },
    ]);
  });

  test("DEV done needs its smoker source chain while keeping audit receipts", () => {
    const record = structuredClone(DEV_SMOKE_READY_LEDGER);
    task(record, "t6").state = "done";
    delete task(record, "t6").phase;
    expect(keys(record, DEV)).toEqual([]);
    const receipts = structuredClone(record.eventReceipts);
    record.assignments = record.assignments.filter(
      (entry) => entry.assignmentId !== "assignment-t6-s1",
    );
    record.nonceRegistry = record.nonceRegistry.filter(
      (entry) => entry.assignmentId !== "assignment-t6-s1",
    );
    record.outbox = record.outbox.filter((entry) => entry.assignmentId !== "assignment-t6-s1");
    expect(keys(record, DEV)).toEqual([{ code: "done-smoker-chain", path: "tasks.t6.smoker" }]);
    expect(record.eventReceipts).toEqual(receipts);
  });

  test("DEV done smoker testedRef binds its producer proof", () => {
    const record = structuredClone(DEV_SMOKE_READY_LEDGER);
    task(record, "t6").state = "done";
    delete task(record, "t6").phase;
    expect(keys(record, DEV)).toEqual([]);
    const proof = assignment(record, "assignment-t6-s1").acceptedProof;
    if (!proof || !("testedRef" in proof)) throw new Error("missing test smoke proof");
    proof.testedRef = { kind: "git-commit", value: "deadbeef" };
    expect(keys(record, DEV)).toEqual([
      { code: "done-tested-ref", path: "assignments.assignment-t6-s1.acceptedProof.testedRef" },
    ]);
  });

  test.each(["answered", "open"] as const)(
    "pre-completion %s cancel decision owns every pair",
    (state) => {
      const record = structuredClone(CANCELLATION_AUTHORIZED_FROZEN_LEDGER);
      const decision = record.decisions.find((entry) => entry.subjectId === "t2");
      if (!decision) throw new Error("missing test decision");
      if (state === "open") {
        decision.state = "open";
        decision.answer = null;
        decision.answeredAt = null;
      }
      expect(keys(record, QUIESCENT)).toEqual([]);
      crossTaskPair(record);
      expect(keys(record, QUIESCENT)).toEqual([
        {
          code: "cancellation-pair-task",
          path: "decisions.66666666-6666-4666-8666-666666666666.cancelIntents.assignment-t1-a1.assignmentId",
        },
        {
          code: "cancellation-pairs",
          path: "decisions.66666666-6666-4666-8666-666666666666.cancelIntents",
        },
      ]);
    },
  );

  test("explicit pre-completion obligations detect a missing pair without guessing undeclared sets", () => {
    const record = structuredClone(CANCELLATION_AUTHORIZED_FROZEN_LEDGER);
    expect(keys(record, QUIESCENT)).toEqual([]);
    // With no task key there is no assertion about the complete obligation set.
    expect(keys(record, NORMAL)).toEqual([]);
    const decision = record.decisions.find((entry) => entry.subjectId === "t2");
    if (!decision) throw new Error("missing test decision");
    decision.cancelIntents = [];
    expect(keys(record, QUIESCENT)).toEqual([
      {
        code: "cancellation-pairs",
        path: "decisions.66666666-6666-4666-8666-666666666666.cancelIntents",
      },
    ]);
    expect(keys(record, NORMAL)).toEqual([]);
  });

  test("pre-completion pair and cache defects accumulate with pure stable output", () => {
    expect(keys(CANCELLATION_AUTHORIZED_FROZEN_LEDGER, QUIESCENT)).toEqual([]);
    const record = structuredClone(CANCELLATION_AUTHORIZED_FROZEN_LEDGER);
    const scenario = structuredClone(QUIESCENT);
    crossTaskPair(record);
    task(record, "t1").ref = { kind: "git-commit", value: "deadbeef" };
    expect(keys(record, scenario)).toEqual([
      { code: "cache-ref", path: "tasks.t1.ref" },
      {
        code: "cancellation-pair-task",
        path: "decisions.66666666-6666-4666-8666-666666666666.cancelIntents.assignment-t1-a1.assignmentId",
      },
      {
        code: "cancellation-pairs",
        path: "decisions.66666666-6666-4666-8666-666666666666.cancelIntents",
      },
    ]);
    const before = JSON.stringify({ record, scenario });
    freeze(record);
    freeze(scenario);
    const actual = collectSourceIssues(record, scenario);
    const reversed = structuredClone(record);
    reversed.decisions.reverse();
    reversed.assignments.reverse();
    reversed.nonceRegistry.reverse();
    reversed.outbox.reverse();
    expect(collectSourceIssues(reversed, scenario)).toEqual(actual);
    expect(JSON.stringify({ record, scenario })).toBe(before);
    console.log("[231 pair+cache]", JSON.stringify(actual));
  });

  test.each(["failure-first", "success-first"] as const)(
    "finite evidence migration preserves find order: %s",
    (order) => {
      expect(keys(NORMAL_RUN_LEDGER, NORMAL)).toEqual([]);
      const record = structuredClone(NORMAL_RUN_LEDGER);
      const producer = assignment(record, "assignment-t1-a1");
      const proof = RunStoredTaskReportSchema.parse(producer.acceptedProof);
      expect(proof).toEqual(producer.acceptedProof);
      producer.acceptedProof = proof;
      const [first] = proof.evidence;
      if (!first) throw new Error("missing test evidence");
      const failed = { ...first, exitCode: 1 };
      if (order === "failure-first") proof.evidence.unshift(failed);
      else proof.evidence.push(failed);
      expect(keys(record, NORMAL)).toEqual(
        order === "success-first"
          ? []
          : [
              { code: "cache-source", path: "tasks.t1.cacheSource" },
              { code: "producer-evidence", path: "assignments.assignment-t1-a1.acceptedProof" },
            ],
      );
    },
  );
});

describe("pure finite source issue collection", () => {
  test("228 compound: C2 target cannot hide an unrelated cache mismatch", () => {
    expect(keys(QUIESCENT_CANCELLED_LEDGER, QUIESCENT)).toEqual([]);
    const record = structuredClone(QUIESCENT_CANCELLED_LEDGER);
    const decision = record.decisions.find((entry) => entry.subjectId === "t2");
    if (!decision?.cancelIntents) throw new Error("missing test decision");
    record.outbox.push(
      dispatchIntent({
        id: "intent-t1-extra",
        kind: "archive",
        taskId: "t1",
        assignmentId: "assignment-t1-a1",
        recipient: "agent-b1",
        messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9",
        idempotencyKey: "cancel-t1-extra",
        state: "confirmed",
        confirmedAt: AT_UPDATED,
      }),
    );
    decision.cancelIntents.unshift({
      assignmentId: "assignment-t1-a1",
      intentId: "intent-t1-extra",
    });
    task(record, "t1").ref = { kind: "git-commit", value: "deadbeef" };
    console.log("[B5 228 compound]", JSON.stringify(collectSourceIssues(record, QUIESCENT)));
    expect(keys(record, QUIESCENT)).toEqual([
      { code: "cache-ref", path: "tasks.t1.ref" },
      {
        code: "cancellation-pair-task",
        path: "decisions.66666666-6666-4666-8666-666666666666.cancelIntents.assignment-t1-a1.assignmentId",
      },
      {
        code: "cancellation-pairs",
        path: "decisions.66666666-6666-4666-8666-666666666666.cancelIntents",
      },
    ]);
  });

  test("two missing dispatches remain separate issues, including after a missing proof dependency", () => {
    expect(keys(NORMAL_RUN_LEDGER, NORMAL)).toEqual([]);
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.outbox = record.outbox.filter(
      (entry) => !["intent-t1-a1", "intent-t2-a1"].includes(entry.id),
    );
    expect(keys(record, NORMAL)).toEqual([
      { code: "assignment-dispatch", path: "assignments.assignment-t1-a1.dispatch" },
      { code: "assignment-dispatch", path: "assignments.assignment-t2-a1.dispatch" },
    ]);
  });

  test("i7 self-review has one exact target and retains an added independent issue", () => {
    expect(keys(NORMAL_RUN_LEDGER, NORMAL)).toEqual([]);
    const original = INVARIANT_CASES.find((entry) => entry.id === "i7-self-review");
    if (!original) throw new Error("missing i7 source");
    const record = structuredClone(original.ledger) as LedgerFixture;
    const target = { code: "reviewer-independence", path: "assignments.assignment-t1-r1.agentId" };
    expect(keys(record, NORMAL)).toEqual([target]);
    task(record, "t2").ref = { kind: "git-commit", value: "deadbeef" };
    const actual = keys(record, NORMAL);
    expect(actual).toEqual([{ code: "cache-source", path: "tasks.t2.cacheSource" }, target]);
    expect(actual).not.toEqual([target]);
  });

  test("a second source-closed self-review is an extra issue with its own assignment path", () => {
    expect(keys(NORMAL_RUN_LEDGER, NORMAL)).toEqual([]);
    const original = INVARIANT_CASES.find((entry) => entry.id === "i7-self-review");
    if (!original) throw new Error("missing i7 source");
    const record = structuredClone(original.ledger) as LedgerFixture;
    const first = assignment(record, "assignment-t1-r1");
    const second = structuredClone(first);
    second.assignmentId = "assignment-t1-r2";
    second.nonce = "6f1c2a44-3b7e-4f0a-9a11-000000000071";
    second.messageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa71";
    second.turnId = "turn-8b";
    second.endedEventKey = "agent-b1|turn-8b|turn_ended";
    if (!second.acceptedProof) throw new Error("missing reviewer proof");
    second.acceptedProof = {
      ...second.acceptedProof,
      assignmentId: second.assignmentId,
      nonce: second.nonce,
      messageId: second.messageId,
    };
    record.assignments.push(second);
    const firstNonce = record.nonceRegistry.find(
      (entry) => entry.assignmentId === first.assignmentId,
    );
    const firstDispatch = record.outbox.find(
      (entry) => entry.assignmentId === first.assignmentId && entry.kind === "dispatch",
    );
    const firstReceipt = record.eventReceipts.find(
      (entry) => entry.eventKey === first.endedEventKey,
    );
    if (!firstNonce || !firstDispatch || !firstReceipt)
      throw new Error("missing reviewer source bundle");
    record.nonceRegistry.push({
      ...firstNonce,
      nonce: second.nonce,
      assignmentId: second.assignmentId,
      acceptedEventKey: `proof:${second.assignmentId}`,
    });
    record.outbox.push({
      ...firstDispatch,
      id: "intent-t1-r2",
      assignmentId: second.assignmentId,
      messageId: second.messageId,
      idempotencyKey: "dispatch-t1-r2",
    });
    record.eventReceipts.push({
      ...firstReceipt,
      eventKey: second.endedEventKey,
      turnId: second.turnId,
      dedupeKey: second.endedEventKey,
    });
    const target = { code: "reviewer-independence", path: "assignments.assignment-t1-r1.agentId" };
    const actual = keys(record, NORMAL);
    expect(actual).toEqual([
      target,
      { code: "reviewer-independence", path: "assignments.assignment-t1-r2.agentId" },
    ]);
    expect(actual).not.toEqual([target]);
  });

  test("two missing reviewer chains cannot be accepted as the single i7 target", () => {
    const record = structuredClone(DEV_SMOKE_READY_LEDGER);
    task(record, "t6").state = "done";
    delete task(record, "t6").phase;
    expect(keys(record, DEV)).toEqual([]);
    const removeReviewer = (id: string) => {
      record.assignments = record.assignments.filter((entry) => entry.assignmentId !== id);
      record.nonceRegistry = record.nonceRegistry.filter((entry) => entry.assignmentId !== id);
      record.outbox = record.outbox.filter((entry) => entry.assignmentId !== id);
    };
    const target = { code: "done-reviewer-chain", path: "tasks.t1.reviewer" };
    removeReviewer("assignment-t1-r1");
    expect(keys(record, DEV)).toEqual([target]);
    removeReviewer("assignment-t6-r1");
    const actual = keys(record, DEV);
    expect(actual).toEqual([target, { code: "done-reviewer-chain", path: "tasks.t6.reviewer" }]);
    expect(actual).not.toEqual([target]);
  });

  test("missing producer skips dependent proof checks but not independent source failures", () => {
    expect(keys(NORMAL_RUN_LEDGER, NORMAL)).toEqual([]);
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.assignments = record.assignments.filter(
      (entry) => entry.assignmentId !== "assignment-t1-a1",
    );
    task(record, "t2").ref = { kind: "git-commit", value: "deadbeef" };
    expect(keys(record, NORMAL)).toEqual([
      { code: "cache-source", path: "tasks.t1.cacheSource" },
      { code: "cache-source", path: "tasks.t2.cacheSource" },
      {
        code: "delivery-producer",
        path: "assignments.assignment-t1-r1.delivery.producerAssignmentId",
      },
      { code: "done-producer-chain", path: "tasks.t1.producer" },
    ]);
  });

  test("collection is stable and does not mutate frozen input or scenario metadata", () => {
    expect(keys(NORMAL_RUN_LEDGER, NORMAL)).toEqual([]);
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const scenario = structuredClone(NORMAL);
    record.outbox = record.outbox.filter(
      (entry) => !["intent-t1-a1", "intent-t2-a1"].includes(entry.id),
    );
    task(record, "t2").ref = { kind: "git-commit", value: "deadbeef" };
    expect(RunRecordSchema.safeParse(record).success).toBe(true);
    const before = JSON.stringify({ record, scenario });
    freeze(record);
    freeze(scenario);
    const actual = collectSourceIssues(record, scenario);
    expect(actual).toEqual(collectSourceIssues(record, scenario));
    expect(JSON.stringify({ record, scenario })).toBe(before);
    const reordered = structuredClone(record);
    reordered.tasks.reverse();
    reordered.assignments.reverse();
    reordered.nonceRegistry.reverse();
    reordered.outbox.reverse();
    reordered.roster.reverse();
    reordered.eventReceipts.reverse();
    expect(collectSourceIssues(reordered, scenario)).toEqual(actual);
    expect(actual.every((issue) => issue.message.length > 0 && !issue.path.includes("<id>"))).toBe(
      true,
    );
  });
});

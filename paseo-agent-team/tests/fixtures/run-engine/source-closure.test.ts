import { describe, expect, test } from "vitest";
import { RunRecordSchema } from "../../../shared/schemas/run-engine/ledger";
import {
  AT_UPDATED,
  DEV_SMOKE_READY_LEDGER,
  dispatchIntent,
  INVARIANT_CASES,
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

function freeze(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}

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

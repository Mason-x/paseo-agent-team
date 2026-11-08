import { describe, expect, test } from "vitest";
import { supportedControlsOf } from "../../server/run-engine/projection";
import {
  answerableActions,
  answerDecision,
  classifyDecision,
  decisionKindOf,
  openStuckDecision,
  stoppedTasksWithoutDecision,
} from "../../shared/domain/run-engine/decision-answer";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { assignmentsForRun } from "../fixtures/run-engine/base";
import { bootstrapRun } from "./support/bootstrap-run";

/**
 * Failure modes this file guards (the pure side of `decide`; the loops that really retry a task are in
 * control.test.ts, where the store enforces the ledger invariants on every result):
 *  - a decision of a kind this build cannot answer (cancellation, approval, ...) being answered anyway,
 *    or an action that is not `retry` being taken as one;
 *  - an answer written twice, against a view the caller did not see, or by someone else's request;
 *  - a retry for a task, a Run or a decision that is not what the answer was about;
 *  - the Runs page being told a control exists that does not.
 */

type Decision = RunRecord["decisions"][number];

const NOW = "2026-11-06T10:00:00.000Z";
const ID = "11111111-1111-4111-8111-111111111111";

function decision(over: Partial<Decision> = {}): Decision {
  return {
    decisionId: ID,
    category: "D4",
    controlNonceDigest: "a".repeat(64),
    state: "open",
    dedupeKey: "quality:assignment-t1-a2:D4",
    cancelIntents: null,
    subjectId: "t1",
    summary: "D4: implementation-attempts",
    createdAt: NOW,
    answeredAt: null,
    answer: null,
    resolution: null,
    ...over,
  };
}

function withDecision(over: Partial<Decision> = {}, lifecycle: RunRecord["lifecycle"] = "active") {
  const record = bootstrapRun({ runId: "run-dec001-a1" });
  record.lifecycle = lifecycle;
  record.decisions = [decision(over)];
  return record;
}

const request = (record: RunRecord, over: Record<string, unknown> = {}) => ({
  decisionId: ID,
  requestId: "ans-1",
  expectedRevision: record.revision,
  reason: "again",
  action: "retry" as const,
  now: NOW,
  ...over,
});

describe("classifyDecision", () => {
  test("knows the decisions it can answer by their key, and nothing else", () => {
    expect(classifyDecision(decision())).toEqual({
      kind: "quality",
      level: "D4",
      producerAssignmentId: "assignment-t1-a2",
    });
    expect(
      classifyDecision(decision({ category: "D3", dedupeKey: "quality:assignment-t1-a2:D3" })),
    ).toEqual({ kind: "quality", level: "D3", producerAssignmentId: "assignment-t1-a2" });
    expect(
      classifyDecision(decision({ category: "D1", dedupeKey: "stuck:assignment-t1-a1" })),
    ).toEqual({
      kind: "stuck",
      assignmentId: "assignment-t1-a1",
    });
    const none: Partial<Decision>[] = [
      // a key whose level is not the category's
      { category: "D3", dedupeKey: "quality:assignment-t1-a2:D4" },
      { dedupeKey: "quality::D4" },
      { dedupeKey: "quality:assignment-t1-a2" },
      // the cancellation decision is the quiescence flow, not this
      {
        category: "D1",
        dedupeKey: "cancel:t1",
        cancelIntents: [{ assignmentId: "assignment-t1-a1", intentId: "intent-x" }],
      },
      { category: "D1", dedupeKey: "stuck:" },
      { category: "D2", dedupeKey: "stuck:assignment-t1-a1" },
      { category: "D5", dedupeKey: "approval:1" },
      { category: "D6", dedupeKey: "finished" },
      { category: "D7", dedupeKey: "engine:1" },
      { subjectId: null },
    ];
    for (const over of none) expect(classifyDecision(decision(over))).toBeNull();
  });

  test("offers `retry` only while the decision waits and is one it can answer", () => {
    const active = { lifecycle: "active" } as const;
    expect(answerableActions(active, decision())).toEqual(["retry", "cancel"]);
    expect(answerableActions(active, decision({ state: "waiting-human" }))).toEqual([
      "retry",
      "cancel",
    ]);
    expect(answerableActions(active, decision({ state: "answered" }))).toEqual([]);
    expect(answerableActions(active, decision({ state: "superseded" }))).toEqual([]);
    expect(answerableActions(active, decision({ category: "D2", dedupeKey: "other:1" }))).toEqual(
      [],
    );
    // A decision of the evidence chain has no retry: it would throw the delivery away.
    expect(
      answerableActions(
        active,
        decision({ category: "D1", dedupeKey: "evidence-stuck:assignment-t1-a1" }),
      ),
    ).toEqual(["cancel"]);
    // A Run that is not live answers nothing.
    for (const lifecycle of [
      "paused",
      "bootstrapping",
      "awaiting-dag",
      "finished",
      "cancelled",
    ] as const) {
      expect(answerableActions({ lifecycle }, decision())).toEqual([]);
    }
  });
});

describe("decisionKindOf", () => {
  test("classifies quality, stopped actors, missing reports and cancellations without exposing ledger details", () => {
    const record = withDecision();
    record.assignments = assignmentsForRun(record.runId);
    const producer = record.assignments.find((entry) => entry.assignmentId === "assignment-t1-a1");
    const judge = record.assignments.find((entry) => entry.assignmentId === "assignment-t1-r1");
    if (!producer || !judge) throw new Error("fixture lost its producer or reviewer");
    expect(decisionKindOf(record, decision())).toBe("quality-d4");
    expect(
      decisionKindOf(
        record,
        decision({ category: "D3", dedupeKey: "quality:assignment-t1-a1:D3" }),
      ),
    ).toBe("quality-d3");
    const stoppedProducer = decision({
      category: "D1",
      dedupeKey: `stuck:${producer.assignmentId}`,
    });
    const stoppedJudge = decision({ category: "D1", dedupeKey: `stuck:${judge.assignmentId}` });
    expect(decisionKindOf(record, stoppedProducer)).toBe("stuck-producer");
    expect(decisionKindOf(record, stoppedJudge)).toBe("stuck-judge");
    judge.purpose = "smoker";
    expect(decisionKindOf(record, stoppedJudge)).toBe("stuck-judge");
    producer.acceptedProof = null;
    expect(
      decisionKindOf(record, {
        ...stoppedProducer,
        limbo: { turnId: "turn-1", endedEventKey: "ended-1" },
      }),
    ).toBe("limbo-producer");
    expect(
      decisionKindOf(
        record,
        decision({ category: "D1", dedupeKey: `evidence-stuck:${producer.assignmentId}` }),
      ),
    ).toBe("evidence-stuck");
    expect(
      decisionKindOf(
        record,
        decision({ category: "D1", dedupeKey: "cancel:t1", cancelIntents: [] }),
      ),
    ).toBe("cancel");
    expect(decisionKindOf(record, decision({ category: "D2", dedupeKey: "other:1" }))).toBe(
      "other",
    );
    expect(decisionKindOf(record, decision({ category: "D1", dedupeKey: "stuck:missing" }))).toBe(
      "other",
    );
  });
});

describe("answerDecision refuses what it should, and writes nothing", () => {
  test("an unknown decision, a decision of another kind, an action this build cannot take", () => {
    const record = withDecision();
    const before = structuredClone(record);
    expect(answerDecision(record, request(record, { decisionId: "x" }))).toEqual({
      ok: false,
      code: "decision-missing",
    });
    for (const category of ["D2", "D5", "D6", "D7"] as const) {
      const other = withDecision({ category, dedupeKey: `other:${category}` });
      expect(answerDecision(other, request(other))).toEqual({
        ok: false,
        code: "decision-not-answerable",
        category,
      });
    }
    const gone = withDecision({ state: "superseded" });
    expect(answerDecision(gone, request(gone))).toMatchObject({
      ok: false,
      code: "decision-not-answerable",
    });
    for (const action of ["reject", "assign-seat", "increase-budget"]) {
      expect(answerDecision(record, request(record, { action }))).toEqual({
        ok: false,
        code: "action-unsupported",
        action,
      });
    }
    expect(record).toEqual(before);
  });

  test("a stale revision, a Run that is not live, a task that is not there", () => {
    const record = withDecision();
    expect(
      answerDecision(record, request(record, { expectedRevision: record.revision + 3 })),
    ).toEqual({
      ok: false,
      code: "revision-conflict",
      current: record.revision,
    });
    for (const lifecycle of [
      "bootstrapping",
      "awaiting-dag",
      "paused",
      "finished",
      "cancelled",
    ] as const) {
      const other = withDecision({}, lifecycle);
      expect(answerDecision(other, request(other))).toEqual({
        ok: false,
        code: "run-not-active",
        lifecycle,
      });
    }
    // The task the decision names is not in the Run: there is nothing to release.
    expect(answerDecision(record, request(record))).toEqual({
      ok: false,
      code: "task-not-releasable",
      reason: "task-missing",
    });
  });

  test("an answer given is the answer given: the same request is a replay, anyone else's is refused", () => {
    const answered = withDecision({
      state: "answered",
      answeredAt: NOW,
      answer: {
        action: "retry",
        taskIds: ["t1"],
        answeredAt: NOW,
        requestId: "ans-1",
      },
    });
    // A replay needs neither the revision nor the Run to be live: the answer is already in the ledger.
    expect(
      answerDecision(answered, request(answered, { expectedRevision: 1, requestId: "ans-1" })),
    ).toEqual({ ok: true, replayed: true, taskId: "t1" });
    expect(answerDecision(answered, request(answered, { requestId: "ans-2" }))).toEqual({
      ok: false,
      code: "decision-answered",
    });
  });
});

describe("stoppedTasksWithoutDecision and openStuckDecision", () => {
  test("a Run with no stopped task has nothing to open, and opening for no stop writes nothing", () => {
    const record = bootstrapRun({ runId: "run-dec002-a1" });
    expect(stoppedTasksWithoutDecision(record)).toEqual([]);
    expect(
      openStuckDecision(record, {
        taskId: "t1",
        assignmentId: "assignment-t1-a1",
        decisionId: ID,
        controlNonceDigest: "b".repeat(64),
        now: NOW,
      }),
    ).toEqual({ changed: false });
  });
});

describe("supportedControlsOf", () => {
  const live = (lifecycle: RunRecord["lifecycle"], decisions: Decision[] = []) =>
    supportedControlsOf({ lifecycle, decisions });

  test("a cancellation that was asked for leaves only kick; a Run still starting cannot be cancelled", () => {
    const decisions = [decision()];
    const cancelling = (value: unknown) =>
      supportedControlsOf({ lifecycle: "paused", decisions, cancelRequest: value } as never);
    const request = {
      version: 1,
      requestId: "c",
      reason: "r",
      requestedAt: "2026-11-08T10:00:00.000Z",
      completedAt: null,
    };
    expect(cancelling(request)).toEqual(["kick"]);
    // One that cannot be read counts as wanted as well.
    expect(cancelling({ nonsense: true })).toEqual(["kick"]);
    // Nothing is offered to pause or cancel again once it is done, and the Run is over anyway.
    expect(
      supportedControlsOf({
        lifecycle: "cancelled",
        decisions,
        cancelRequest: { ...request, completedAt: request.requestedAt },
      } as never),
    ).toEqual([]);
    for (const state of ["preparing", "creating"] as const) {
      expect(
        supportedControlsOf({ lifecycle: "bootstrapping", decisions: [], launch: { state } }),
      ).toEqual(["kick", "budget"]);
    }
    expect(
      supportedControlsOf({
        lifecycle: "active",
        decisions: [decision()],
        cancelRequest: request,
      } as never),
    ).toEqual(["kick"]);
  });

  test("names only the controls this Run can use right now, in a fixed order", () => {
    expect(live("bootstrapping")).toEqual(["kick", "cancel", "budget"]);
    expect(live("awaiting-dag")).toEqual(["replan", "kick", "cancel", "budget"]);
    expect(live("active")).toEqual(["kick", "pause", "cancel", "budget"]);
    expect(live("active", [decision()])).toEqual(["decide", "kick", "pause", "cancel", "budget"]);
    // A paused Run answers nothing: the decision waits until it is resumed.
    expect(live("paused", [decision()])).toEqual(["kick", "resume", "cancel", "budget"]);
    expect(live("paused")).toEqual(["kick", "resume", "cancel", "budget"]);
    expect(live("active", [decision({ state: "answered" })])).toEqual([
      "kick",
      "pause",
      "cancel",
      "budget",
    ]);
    expect(live("active", [decision({ category: "D2", dedupeKey: "other:1" })])).toEqual([
      "kick",
      "pause",
      "cancel",
      "budget",
    ]);
    expect(live("finished")).toEqual([]);
    expect(live("cancelled")).toEqual([]);
  });
});

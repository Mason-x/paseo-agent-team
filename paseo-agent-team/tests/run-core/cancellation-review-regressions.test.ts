import { describe, expect, test } from "vitest";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import { type ReduceResult, reduceRun } from "../../shared/domain/run-engine/reducer";
import type {
  CancellationObservation,
  RunReducerEvent,
} from "../../shared/domain/run-engine/transitions";
import { type RunRecord, RunRecordSchema } from "../../shared/schemas/run-engine/ledger";
import {
  AT_UPDATED,
  CANCELLATION_AUTHORIZED_FROZEN_LEDGER,
  INTENT_CANCEL,
  QUIESCENT_CANCELLATION,
} from "../fixtures/run-engine";

const facts = { now: AT_UPDATED, newId: () => "90000000-0000-4000-8000-000000000001" };

function cancellation() {
  const record: RunRecord = structuredClone(CANCELLATION_AUTHORIZED_FROZEN_LEDGER);
  expect(RunRecordSchema.safeParse(record).success).toBe(true);
  expect(checkLedgerInvariants(record)).toEqual({ ok: true });
  const owner = record.tasks.find((entry) => entry.spec.id === "t2");
  if (!owner) throw new Error("task");
  const decision = record.decisions[0];
  const assignment = record.assignments.find((entry) => entry.taskId === "t2");
  const intent = record.outbox.find((entry) => entry.id === INTENT_CANCEL);
  if (!decision || !assignment || !intent) throw new Error("missing cancellation fixture");
  assignment.turnId = "turn-7";
  const evidence: CancellationObservation = structuredClone(QUIESCENT_CANCELLATION);
  const event: Extract<RunReducerEvent, { kind: "cancellation-checked" }> = {
    kind: "cancellation-checked",
    taskId: "t2",
    decisionId: decision.decisionId,
    evidence,
  };
  return { record, decision, assignment, intent, evidence, event };
}

function accepted(result: ReduceResult) {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.next;
}

describe("167 cancellation proof and authorization", () => {
  test.each(["cancel", "assign-seat"] as const)(
    "answered %s releases with all proofs",
    (action) => {
      const c = cancellation();
      if (!c.decision.answer) throw new Error("answer");
      c.decision.answer.action = action;
      const snapshot = structuredClone(c.record);
      const first = reduceRun(c.record, c.event, facts);
      expect(first).toEqual(reduceRun(c.record, c.event, facts));
      expect(c.record).toEqual(snapshot);
      const result = accepted(first);
      expect(result.tasks.find((entry) => entry.spec.id === "t2")).toMatchObject({
        state: "cancelled",
        releaseDecisionId: c.decision.decisionId,
        currentAssignmentId: null,
      });
      expect(result.resources).toEqual([]);
      expect(result.decisions[0]?.answer).toEqual(c.decision.answer);
      expect(
        result.nonceRegistry
          .filter((entry) => entry.taskId === "t2")
          .every((entry) => entry.revokedAt !== null),
      ).toBe(true);
    },
  );

  const cases: Array<[string, (c: ReturnType<typeof cancellation>) => void]> = [
    [
      "open D1 is not authorization",
      (c) => {
        Object.assign(c.decision, { state: "open", answeredAt: null, answer: null });
      },
    ],
    [
      "wrong authorization task",
      (c) => {
        if (c.decision.answer) c.decision.answer.taskIds = ["t3"];
      },
    ],
    [
      "resume action",
      (c) => {
        if (c.decision.answer) c.decision.answer.action = "resume-seat";
      },
    ],
    [
      "wrong recipient",
      (c) => {
        c.intent.recipient = "other-agent";
      },
    ],
    [
      "wrong intent assignment",
      (c) => {
        c.intent.assignmentId = "other-assignment";
      },
    ],
    [
      "wrong intent task",
      (c) => {
        c.intent.taskId = "t3";
      },
    ],
    [
      "unconfirmed intent",
      (c) => {
        c.intent.state = "prepared";
        c.intent.confirmedAt = null;
      },
    ],
    [
      "missing archive receipt",
      (c) => {
        c.evidence.receipt.kind = "none";
      },
    ],
    [
      "missing confirmation",
      (c) => {
        c.evidence.receipt.confirmedAt = null;
      },
    ],
    [
      "missing external receipt",
      (c) => {
        c.evidence.receipt.externalId = null;
      },
    ],
    [
      "wrong evidence assignment",
      (c) => {
        c.evidence.assignmentId = "other-assignment";
      },
    ],
    [
      "wrong refresh actor",
      (c) => {
        if (c.evidence.refresh === null) throw new Error("refresh");
        c.evidence.refresh.agentId = "other-agent";
      },
    ],
    [
      "refresh before end",
      (c) => {
        if (c.evidence.refresh === null) throw new Error("refresh");
        c.evidence.refresh.observedAt = "2020-01-01T00:00:00.000Z";
      },
    ],
    [
      "stale observation",
      (c) => {
        c.evidence.observationSeq = 1;
      },
    ],
    [
      "future observation",
      (c) => {
        c.evidence.observationSeq = 999;
      },
    ],
    [
      "zero observation",
      (c) => {
        c.evidence.observationSeq = 0;
      },
    ],
    [
      "null turn",
      (c) => {
        c.assignment.turnId = null;
        c.evidence.lastTurnId = null;
        c.evidence.endedEventKey = null;
      },
    ],
    [
      "wrong turn",
      (c) => {
        c.evidence.lastTurnId = "other-turn";
      },
    ],
    [
      "wrong ended key",
      (c) => {
        c.evidence.endedEventKey = "not-the-recorded-key";
      },
    ],
    [
      "missing ended receipt",
      (c) => {
        c.record.eventReceipts = c.record.eventReceipts.filter(
          (receipt) => receipt.eventKey !== c.evidence.endedEventKey,
        );
      },
    ],
    [
      "wrong ended actor",
      (c) => {
        const ended = c.record.eventReceipts.find((r) => r.eventKey === c.evidence.endedEventKey);
        if (ended) ended.agentId = "other-agent";
      },
    ],
    [
      "wrong ended turn",
      (c) => {
        const ended = c.record.eventReceipts.find((r) => r.eventKey === c.evidence.endedEventKey);
        if (ended) ended.turnId = "other-turn";
      },
    ],
    [
      "wrong ended kind",
      (c) => {
        const ended = c.record.eventReceipts.find((r) => r.eventKey === c.evidence.endedEventKey);
        if (ended) ended.kind = "turn_started";
      },
    ],
  ];
  const rejectCases = new Map([
    ["wrong recipient", ["RUN_INVARIANT_VIOLATION", "cancel-intent-binding"]],
    ["wrong intent assignment", ["RUN_INVARIANT_VIOLATION", "cancel-intent-binding"]],
    ["wrong intent task", ["RUN_INVARIANT_VIOLATION", "cancel-intent-binding"]],
    ["wrong evidence assignment", ["RUN_EVENT_INVALID", "unknown-binding"]],
  ]);
  test.each(cases)("%s keeps the frozen claims", (_label, mutate) => {
    const c = cancellation();
    mutate(c);
    if (rejectCases.has(_label)) {
      expect(RunRecordSchema.safeParse(c.record).success).toBe(true);
      const result = reduceRun(c.record, c.event, facts);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const [code, reason] = rejectCases.get(_label) ?? [];
        expect(result.code).toBe(code);
        expect(result.params.reason).toBe(reason);
      }
      expect(c.record.tasks.find((entry) => entry.spec.id === "t2")).toMatchObject({
        state: "blocked",
        phase: "frozen",
      });
      return;
    }
    const result = accepted(reduceRun(c.record, c.event, facts));
    expect(result.tasks.find((entry) => entry.spec.id === "t2")).toMatchObject({
      state: "blocked",
      phase: "frozen",
    });
    expect(result.resources).toEqual(c.record.resources);
    expect(result.decisions[0]?.state).toBe(c.decision.state);
  });

  test("late turn gets arrival sequence and blocks even a backdated caller sequence", () => {
    const c = cancellation();
    const observed = accepted(
      reduceRun(
        c.record,
        {
          kind: "observation-recorded",
          receipt: {
            kind: "turn_started",
            agentId: c.assignment.agentId,
            turnId: "later-turn",
            seq: 1,
            eventKey: "later-start",
            receivedAt: AT_UPDATED,
            dedupeKey: "later-start",
            disposition: "observed",
          },
        },
        facts,
      ),
    );
    expect(observed.eventReceipts.at(-1)?.seq).toBe(c.record.counters.observationSeq + 1);
    const result = accepted(reduceRun(observed, c.event, facts));
    expect(result.resources).toEqual(c.record.resources);
    expect(result.tasks.find((entry) => entry.spec.id === "t2")?.state).toBe("blocked");
  });

  test("evidence registered before authorization stays frozen and is usable after an authorized seed", () => {
    const c = cancellation();
    const answer = c.decision.answer;
    Object.assign(c.decision, { state: "open", answeredAt: null, answer: null });
    const pending = accepted(reduceRun(c.record, c.event, facts));
    expect(pending.resources).toEqual(c.record.resources);
    expect(
      pending.assignments.find((entry) => entry.assignmentId === c.assignment.assignmentId)
        ?.cancellation,
    ).toEqual(c.evidence);
    // B rejects raw decision commands; C's verified response is represented here by a seed.
    const decision = pending.decisions[0];
    if (!decision) throw new Error("decision");
    Object.assign(decision, { state: "answered", answeredAt: AT_UPDATED, answer });
    expect(accepted(reduceRun(pending, c.event, facts)).resources).toEqual([]);
  });

  test("invalid refresh input never persists an invalid typed proof", () => {
    const c = cancellation();
    c.event.evidence = {
      ...c.evidence,
      refresh: c.evidence.refresh === null ? null : { ...c.evidence.refresh, activeTurn: true },
    };
    const result = accepted(reduceRun(c.record, c.event, facts));
    expect(result.resources).toEqual(c.record.resources);
    expect(
      result.assignments.find((entry) => entry.assignmentId === c.assignment.assignmentId)
        ?.cancellation,
    ).toBeNull();
  });

  test("a new active refresh invalidates an older idle proof before another cancellation event", () => {
    const c = cancellation();
    c.assignment.cancellation = structuredClone(QUIESCENT_CANCELLATION);
    c.event.evidence = {
      ...c.evidence,
      refresh: c.evidence.refresh === null ? null : { ...c.evidence.refresh, activeTurn: true },
    };
    const pending = accepted(reduceRun(c.record, c.event, facts));
    const result = accepted(
      reduceRun(
        pending,
        {
          kind: "run-cancelled",
          cancelIntents: pending.decisions[0]?.cancelIntents ?? [],
          preparedCancelIntents: [],
          reason: "cancel",
          controlNonceDigest: "9".repeat(64),
        },
        facts,
      ),
    );
    expect(result.resources).toEqual(c.record.resources);
    expect(result.tasks.find((entry) => entry.spec.id === "t2")?.state).toBe("blocked");
  });
});

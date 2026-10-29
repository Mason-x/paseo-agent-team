import { describe, expect, test } from "vitest";
import { type ReduceResult, reduceRun } from "../../shared/domain/run-engine/reducer";
import type { RunCancellationEvidence, RunRecord } from "../../shared/schemas/run-engine/ledger";
import {
  AT_UPDATED,
  CANCELLATION_AUTHORIZED_FROZEN_LEDGER,
  dispatchIntent,
  INTENT_CANCEL,
  MESSAGE_CANCEL,
  NORMAL_RUN_LEDGER,
  QUIESCENT_CANCELLATION,
} from "../fixtures/run-engine";

const facts = { now: AT_UPDATED, newId: () => "90000000-0000-4000-8000-000000000001" };

function cancellation() {
  const record: RunRecord = structuredClone(NORMAL_RUN_LEDGER);
  record.decisions = structuredClone(CANCELLATION_AUTHORIZED_FROZEN_LEDGER.decisions);
  const owner = record.tasks.find((entry) => entry.spec.id === "T2");
  if (!owner) throw new Error("task");
  Object.assign(owner, { state: "blocked", phase: "frozen", frozenClaimId: "claim-t2" });
  for (const claim of record.resources) claim.frozen = true;
  const decision = record.decisions[0];
  const assignment = record.assignments.find((entry) => entry.taskId === "T2");
  if (!decision || !assignment) throw new Error("missing cancellation fixture");
  assignment.turnId = "turn-7";
  decision.cancelIntentId = INTENT_CANCEL;
  const intent = dispatchIntent({
    id: INTENT_CANCEL,
    kind: "archive",
    taskId: "T2",
    assignmentId: assignment.assignmentId,
    recipient: assignment.agentId,
    messageId: MESSAGE_CANCEL,
    state: "confirmed",
    confirmedAt: AT_UPDATED,
  });
  record.outbox.push(intent);
  const evidence = structuredClone(QUIESCENT_CANCELLATION);
  const event = {
    kind: "cancellation-checked" as const,
    taskId: "T2",
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
      expect(result.tasks.find((entry) => entry.spec.id === "T2")).toMatchObject({
        state: "cancelled",
        releaseDecisionId: c.decision.decisionId,
        currentAssignmentId: null,
      });
      expect(result.resources).toEqual([]);
      expect(result.decisions[0]?.answer).toEqual(c.decision.answer);
      expect(
        result.nonceRegistry
          .filter((entry) => entry.taskId === "T2")
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
        if (c.decision.answer) c.decision.answer.taskIds = ["T3"];
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
        c.intent.taskId = "T3";
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
        c.evidence.refresh.agentId = "other-agent";
      },
    ],
    [
      "refresh before end",
      (c) => {
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
        c.record.eventReceipts = [];
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
  test.each(cases)("%s keeps the frozen claims", (_label, mutate) => {
    const c = cancellation();
    mutate(c);
    const result = accepted(reduceRun(c.record, c.event, facts));
    expect(result.tasks.find((entry) => entry.spec.id === "T2")).toMatchObject({
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
    expect(result.tasks.find((entry) => entry.spec.id === "T2")?.state).toBe("blocked");
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
      refresh: { ...c.evidence.refresh, activeTurn: true },
    } as unknown as RunCancellationEvidence;
    const result = accepted(reduceRun(c.record, c.event, facts));
    expect(result.resources).toEqual(c.record.resources);
    expect(
      result.assignments.find((entry) => entry.assignmentId === c.assignment.assignmentId)
        ?.cancellation,
    ).toBeNull();
  });

  test("a new active refresh invalidates an older idle proof before another cancellation event", () => {
    const c = cancellation();
    c.assignment.cancellation = structuredClone(c.evidence);
    c.event.evidence = {
      ...c.evidence,
      refresh: { ...c.evidence.refresh, activeTurn: true },
    } as unknown as RunCancellationEvidence;
    const pending = accepted(reduceRun(c.record, c.event, facts));
    const result = accepted(
      reduceRun(
        pending,
        { kind: "run-cancelled", reason: "cancel", controlNonceDigest: "9".repeat(64) },
        facts,
      ),
    );
    expect(result.resources).toEqual(c.record.resources);
    expect(result.tasks.find((entry) => entry.spec.id === "T2")?.state).toBe("blocked");
  });
});

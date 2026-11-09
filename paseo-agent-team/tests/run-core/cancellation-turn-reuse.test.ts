import { describe, expect, test } from "vitest";
import { reduceRun } from "../../shared/domain/run-engine/reducer";
import { isComplete167 } from "../../shared/domain/run-engine/transitions";
import type { RunEventReceipt, RunRecord } from "../../shared/schemas/run-engine/ledger";
import { AT_UPDATED, CANCELLATION_AUTHORIZED_FROZEN_LEDGER } from "../fixtures/run-engine";

/**
 * T9a: a start that arrives after the end of the very same turn (the hooks came out of order) is not
 * "the member started again", so it neither voids the 167 proof of a cancellation nor clears it. A start
 * of another turn still does.
 */

const facts = { now: AT_UPDATED, newId: () => "90000000-0000-4000-8000-000000000001" };

function fixture() {
  const record: RunRecord = structuredClone(CANCELLATION_AUTHORIZED_FROZEN_LEDGER);
  const assignment = record.assignments.find((entry) => entry.taskId === "t2");
  if (!assignment) throw new Error("missing assignment");
  assignment.turnId = "turn-7";
  return { record, assignment };
}

const started = (turnId: string, seq: number): RunEventReceipt =>
  ({
    eventKey: `turn_started:agent-b1:${turnId}`,
    kind: "turn_started",
    agentId: "agent-b1",
    turnId,
    seq,
    receivedAt: AT_UPDATED,
    dedupeKey: `turn_started:agent-b1:${turnId}`,
    disposition: "observed",
  }) as RunEventReceipt;

describe("isComplete167", () => {
  test("holds with the proof the fixture stores", () => {
    const { record, assignment } = fixture();
    expect(isComplete167(record, assignment)).toBe(true);
  });

  test("a late start of the turn that ended does not break the proof", () => {
    const { record, assignment } = fixture();
    record.eventReceipts.push(started("turn-7", record.counters.observationSeq));
    expect(isComplete167(record, assignment)).toBe(true);
  });

  test("a start of another turn after the end does", () => {
    const { record, assignment } = fixture();
    record.eventReceipts.push(started("turn-8", record.counters.observationSeq));
    expect(isComplete167(record, assignment)).toBe(false);
  });
});

describe("a start recorded while a cancellation proof is stored", () => {
  const record167 = (turnId: string) => {
    const { record } = fixture();
    const result = reduceRun(
      record,
      { kind: "observation-recorded", receipt: started(turnId, 1) },
      facts,
    );
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.next;
  };
  const cancellationOf = (record: RunRecord) =>
    record.assignments.find((entry) => entry.taskId === "t2")?.cancellation;

  test("of the turn that already ended leaves the proof in place", () => {
    const next = record167("turn-7");
    expect(cancellationOf(next)).not.toBeNull();
    expect(next.tasks.find((entry) => entry.spec.id === "t2")?.waitingReason).not.toBe(
      "cancel-new-turn",
    );
  });

  test("of another turn clears it", () => {
    expect(cancellationOf(record167("turn-8"))).toBeNull();
  });
});

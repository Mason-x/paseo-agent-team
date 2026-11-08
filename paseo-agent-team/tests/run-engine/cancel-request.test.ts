import { describe, expect, test } from "vitest";
import {
  agentsToRead,
  cancelPending,
  planCancelFinish,
  readCancelRequest,
  type SeatView,
  withCancelRequest,
} from "../../shared/domain/run-engine/cancel-request";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { ASSIGNMENT_T2, dispatchIntent, NORMAL_RUN_LEDGER } from "../fixtures/run-engine";

/**
 * The pure side of cancelling a Run (the loops that really do it are in control.test.ts). Failure modes
 * this file guards:
 *  - a turn taken for ended on anything but the host's own receipt and its live state: a receipt from
 *    before the assignment, a turn that started after it, another turn than the assignment's own, an
 *    agent that is running or cannot be read;
 *  - a delivery that may still start a turn not being waited for;
 *  - a request block that does not read back being taken for "no request".
 */

const REQUEST = {
  version: 1 as const,
  requestId: "cancel-1",
  reason: "stop",
  requestedAt: "2026-11-08T10:00:00.000Z",
  completedAt: null,
};

const idle: SeatView = { status: "idle", activeTurn: false };
const seats = (view: SeatView | undefined) =>
  new Map<string, SeatView>(view ? [["agent-b1", view]] : []);

function base(): RunRecord {
  return structuredClone(NORMAL_RUN_LEDGER) as RunRecord;
}

describe("the request block", () => {
  test("is absent, valid or invalid, on a v1 and on a v2 record alike", () => {
    for (const schemaVersion of [1, 2] as const) {
      const record = { ...base(), schemaVersion };
      expect(readCancelRequest(record)).toEqual({ kind: "absent" });
      expect(cancelPending(record)).toBe(false);
      const written = withCancelRequest(record, REQUEST);
      expect(readCancelRequest(written)).toEqual({ kind: "valid", value: REQUEST });
      expect(cancelPending(written)).toBe(true);
      // The record it was made from is not touched.
      expect(readCancelRequest(record)).toEqual({ kind: "absent" });
      const done = withCancelRequest(record, { ...REQUEST, completedAt: REQUEST.requestedAt });
      expect(cancelPending(done)).toBe(false);
    }
  });

  test.each([
    { ...REQUEST, version: 2 },
    { ...REQUEST, reason: "" },
    { ...REQUEST, requestId: "" },
    { ...REQUEST, requestedAt: "yesterday" },
    { ...REQUEST, extra: 1 },
    { version: 1 },
    "cancel",
    null,
  ])(
    "a block that does not read back is invalid, and counts as a cancellation that is wanted: %j",
    (raw) => {
      const record = { ...base(), cancelRequest: raw } as unknown as RunRecord;
      expect(readCancelRequest(record)).toEqual({ kind: "invalid" });
      expect(cancelPending(record)).toBe(true);
    },
  );
});

describe("planCancelFinish", () => {
  test("a turn that ended on the host's receipt, with the agent idle, is closed on that receipt", () => {
    const record = base();
    expect(agentsToRead(record)).toContain("agent-b1");
    const plan = planCancelFinish(record, seats(idle));
    expect(plan).toMatchObject({ kind: "finish" });
    if (plan.kind !== "finish") return;
    // The newest receipt of the agent, with its own turn and key.
    expect(plan.close).toContainEqual({
      assignmentId: ASSIGNMENT_T2,
      turnId: "turn-7",
      endedEventKey: "agent-b1|turn-7|turn_ended",
    });
  });

  test("a closed agent counts as stopped, a running one or one with an active turn does not", () => {
    const record = base();
    expect(planCancelFinish(record, seats({ status: "closed", activeTurn: false })).kind).toBe(
      "finish",
    );
    for (const view of [
      { status: "running", activeTurn: true },
      { status: "idle", activeTurn: true },
      { status: "error", activeTurn: false },
    ]) {
      expect(planCancelFinish(record, seats(view))).toMatchObject({ kind: "wait" });
    }
  });

  test("an agent that cannot be read, or was not read, is waited for", () => {
    const record = base();
    expect(planCancelFinish(record, seats("unreadable"))).toMatchObject({ kind: "wait", turns: 1 });
    expect(planCancelFinish(record, seats(undefined))).toMatchObject({ kind: "wait", turns: 1 });
  });

  test("assume-idle is the host-free answer a request gives", () => {
    expect(planCancelFinish(base(), "assume-idle").kind).toBe("finish");
    const record = base();
    record.eventReceipts = [];
    expect(planCancelFinish(record, "assume-idle")).toMatchObject({ kind: "wait", turns: 1 });
  });

  test("a receipt from before the assignment was made, or none at all, proves nothing", () => {
    const early = base();
    const assignment = early.assignments.find((a) => a.assignmentId === ASSIGNMENT_T2);
    if (!assignment) throw new Error("no assignment");
    assignment.createdAt = "2099-01-01T00:00:00.000Z";
    expect(planCancelFinish(early, seats(idle))).toMatchObject({ kind: "wait", turns: 1 });
    const none = base();
    none.eventReceipts = none.eventReceipts.filter((r) => r.agentId !== "agent-b1");
    expect(planCancelFinish(none, seats(idle))).toMatchObject({ kind: "wait", turns: 1 });
  });

  test("a turn that started after the receipt is a turn still running", () => {
    const record = base();
    record.eventReceipts.push({
      eventKey: "agent-b1|turn-9|turn_started",
      kind: "turn_started",
      agentId: "agent-b1",
      turnId: "turn-9",
      seq: 9,
      receivedAt: "2026-11-08T11:00:00.000Z",
      dedupeKey: "agent-b1|turn-9|turn_started",
      disposition: "accepted",
    } as RunRecord["eventReceipts"][number]);
    expect(planCancelFinish(record, seats(idle))).toMatchObject({ kind: "wait", turns: 1 });
  });

  test("an assignment that has its own turn is closed on that turn's receipt, and on no other", () => {
    const own = base();
    const assignment = own.assignments.find((a) => a.assignmentId === ASSIGNMENT_T2);
    if (!assignment) throw new Error("no assignment");
    assignment.turnId = "turn-6";
    const plan = planCancelFinish(own, seats(idle));
    expect(plan).toMatchObject({ kind: "finish" });
    if (plan.kind === "finish") {
      expect(plan.close.find((c) => c.assignmentId === ASSIGNMENT_T2)?.turnId).toBe("turn-6");
    }
    assignment.turnId = "turn-99";
    expect(planCancelFinish(own, seats(idle))).toMatchObject({ kind: "wait", turns: 1 });
  });

  test.each(["sending", "outcome-unknown"] as const)(
    "a message that is %s may still start a turn: it is waited for, whatever the turns say",
    (state) => {
      const record = base();
      record.outbox.push(
        dispatchIntent({
          id: "intent-open",
          taskId: "t2",
          assignmentId: ASSIGNMENT_T2,
          messageId: "99999999-9999-4999-8999-999999999999",
          idempotencyKey: "open",
          state,
          confirmedAt: null,
        }),
      );
      expect(planCancelFinish(record, seats(idle))).toMatchObject({ kind: "wait", deliveries: 1 });
    },
  );

  test("a dispatch that never left is not waited for: the cancellation withdraws it itself", () => {
    const record = base();
    record.eventReceipts = [];
    // Nothing of a turn is recorded for it: it was never delivered.
    record.events = record.events.filter((event) => !event.kind.startsWith("turn"));
    const intent = record.outbox.find(
      (i) => i.assignmentId === ASSIGNMENT_T2 && i.kind === "dispatch",
    );
    if (!intent) throw new Error("no dispatch");
    intent.state = "prepared";
    intent.confirmedAt = null;
    expect(agentsToRead(record)).not.toContain("agent-b1");
    expect(planCancelFinish(record, seats(undefined))).toEqual({ kind: "finish", close: [] });
  });
});

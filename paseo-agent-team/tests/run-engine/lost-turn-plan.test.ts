import { describe, expect, test } from "vitest";
import {
  agentsToCheck,
  closedSince,
  closedTurnCandidates,
  engineSettledEnd,
  findClosedTurns,
  isAgentArchived,
  isEngineSettled,
  type SeatRead,
} from "../../shared/domain/run-engine/lost-turn";
import type {
  RunAssignment,
  RunEventReceipt,
  RunRecord,
} from "../../shared/schemas/run-engine/ledger";

/**
 * T4a: `findClosedTurns` decides from the record and one read of each agent which turns the host cut
 * off by closing the member. Pure: nothing here touches a store or a host.
 */

const AGENT = "agent-b1";
const AT = (second: number) => `2026-11-09T10:00:${String(second).padStart(2, "0")}.000Z`;

function assignment(over: Partial<RunAssignment> = {}): RunAssignment {
  return {
    assignmentId: "a1",
    taskId: "t1",
    attempt: 1,
    purpose: "member",
    agentId: AGENT,
    state: "in_progress",
    acceptedProof: null,
    turnId: null,
    createdAt: AT(0),
    ...over,
  } as RunAssignment;
}

let seq = 0;
function receipt(
  kind: RunEventReceipt["kind"],
  at: number,
  over: Record<string, unknown> = {},
): RunEventReceipt {
  seq += 1;
  const turnId = kind === "turn_started" || kind === "turn_ended" ? "turn-1" : null;
  return {
    eventKey: `${kind}:${AGENT}:${turnId ?? "-"}:${seq}`,
    kind,
    agentId: AGENT,
    turnId,
    dedupeKey: `${kind}:${AGENT}:${turnId ?? "-"}:${seq}`,
    disposition: "observed",
    seq,
    receivedAt: AT(at),
    ...over,
  } as RunEventReceipt;
}

function record(
  receipts: RunEventReceipt[],
  over: { assignments?: RunAssignment[]; confirmed?: boolean } = {},
): RunRecord {
  const assignments = over.assignments ?? [assignment()];
  return {
    assignments,
    eventReceipts: receipts,
    outbox: assignments.map((entry) => ({
      id: `intent-${entry.assignmentId}`,
      kind: "dispatch",
      assignmentId: entry.assignmentId,
      state: over.confirmed === false ? "sending" : "confirmed",
    })),
  } as unknown as RunRecord;
}

const idle = new Map<string, SeatRead>([[AGENT, { status: "idle", activeTurn: false }]]);
const closedSeat = new Map<string, SeatRead>([[AGENT, { status: "closed", activeTurn: false }]]);

describe("findClosedTurns: what proves a turn was cut off", () => {
  test("a closed receipt after the turn began and a host with no turn running: settled, by the receipt", () => {
    seq = 0;
    const found = findClosedTurns(record([receipt("turn_started", 1), receipt("closed", 2)]), idle);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      assignmentId: "a1",
      taskId: "t1",
      agentId: AGENT,
      turnId: "turn-1",
      basis: { closedBy: "receipt" },
    });
  });

  test("no closed receipt but the host reads closed: settled, by the host read", () => {
    seq = 0;
    const found = findClosedTurns(record([receipt("turn_started", 1)]), closedSeat);
    expect(found[0]?.basis).toEqual({ closedBy: "host-read", closedReceiptKey: null });
  });

  test("only an archived receipt is not proof of a closed session", () => {
    seq = 0;
    expect(
      findClosedTurns(record([receipt("turn_started", 1), receipt("archived", 2)]), idle),
    ).toEqual([]);
  });

  test("a host that shows a running turn, or any turn at all, settles nothing", () => {
    seq = 0;
    const base = record([receipt("turn_started", 1), receipt("closed", 2)]);
    for (const seat of [
      { status: "running", activeTurn: true },
      { status: "running", activeTurn: false },
      { status: "initializing", activeTurn: false },
      { status: "idle", activeTurn: true },
    ]) {
      expect(findClosedTurns(base, new Map([[AGENT, seat]]))).toEqual([]);
    }
  });

  test("a read that failed, or none at all, settles nothing; an agent the host does not have counts as no turn", () => {
    seq = 0;
    const base = record([receipt("turn_started", 1), receipt("closed", 2)]);
    expect(findClosedTurns(base, new Map([[AGENT, "unreadable"]]))).toEqual([]);
    expect(findClosedTurns(base, new Map())).toEqual([]);
    expect(findClosedTurns(base, new Map([[AGENT, "absent"]]))).toHaveLength(1);
    // Deleted, but nothing said it was closed first: no proof.
    expect(
      findClosedTurns(record([receipt("turn_started", 1)]), new Map([[AGENT, "absent"]])),
    ).toEqual([]);
  });

  test("a later turn_started (the member was opened again), a turn_ended, or no turn_started: nothing", () => {
    seq = 0;
    expect(
      findClosedTurns(
        record([
          receipt("turn_started", 1),
          receipt("closed", 2),
          receipt("turn_started", 3, { turnId: "turn-2" }),
        ]),
        idle,
      ),
    ).toEqual([]);
    seq = 0;
    expect(
      findClosedTurns(
        record([receipt("turn_started", 1), receipt("turn_ended", 2), receipt("closed", 3)]),
        idle,
      ),
    ).toEqual([]);
    seq = 0;
    expect(findClosedTurns(record([receipt("closed", 2)]), closedSeat)).toEqual([]);
  });

  test("a receipt from before the assignment was made, or for another agent, is not its turn", () => {
    seq = 0;
    expect(
      findClosedTurns(
        record([
          receipt("turn_started", 1, { receivedAt: "2026-11-09T09:59:00.000Z" }),
          receipt("closed", 2),
        ]),
        idle,
      ),
    ).toEqual([]);
    seq = 0;
    expect(
      findClosedTurns(
        record([receipt("turn_started", 1, { agentId: "agent-other" }), receipt("closed", 2)]),
        idle,
      ),
    ).toEqual([]);
  });

  test("an assignment with its own turn needs that turn; one already answered, ended or not delivered is not waited on", () => {
    seq = 0;
    const receipts = [receipt("turn_started", 1), receipt("closed", 2)];
    expect(
      findClosedTurns(record(receipts, { assignments: [assignment({ turnId: "turn-1" })] }), idle),
    ).toHaveLength(1);
    expect(
      findClosedTurns(record(receipts, { assignments: [assignment({ turnId: "turn-9" })] }), idle),
    ).toEqual([]);
    expect(
      findClosedTurns(record(receipts, { assignments: [assignment({ state: "ended" })] }), idle),
    ).toEqual([]);
    expect(
      findClosedTurns(
        record(receipts, { assignments: [assignment({ acceptedProof: {} as never })] }),
        idle,
      ),
    ).toEqual([]);
    expect(findClosedTurns(record(receipts, { confirmed: false }), idle)).toEqual([]);
    expect(
      findClosedTurns(
        record(receipts, { assignments: [assignment({ purpose: "reviewer" })] }),
        idle,
      ),
    ).toHaveLength(1);
    expect(
      findClosedTurns(
        record(receipts, { assignments: [assignment({ purpose: "plan-request" as never })] }),
        idle,
      ),
    ).toEqual([]);
  });
});

describe("the helpers around it", () => {
  test("the agents to read are those whose turn may have been cut, once each, in order", () => {
    seq = 0;
    const second = assignment({ assignmentId: "a2", taskId: "t2", agentId: "agent-a0" });
    const base = record(
      [receipt("turn_started", 1), receipt("turn_started", 1, { agentId: "agent-a0" })],
      {
        assignments: [assignment(), second],
      },
    );
    expect(agentsToCheck(base)).toEqual(["agent-a0", AGENT]);
    expect(closedTurnCandidates(base)).toHaveLength(2);
    expect(
      agentsToCheck(
        record([receipt("turn_started", 1)], { assignments: [assignment({ state: "ended" })] }),
      ),
    ).toEqual([]);
  });

  test("a receipt is the Engine's only when it says so", () => {
    seq = 0;
    expect(
      isEngineSettled(receipt("turn_ended", 1, { settledBy: "engine", outcome: "agent-closed" })),
    ).toBe(true);
    expect(isEngineSettled(receipt("turn_ended", 1))).toBe(false);
    expect(isEngineSettled(receipt("closed", 1, { settledBy: "engine" }))).toBe(false);
  });

  test("engineSettledEnd finds the Engine's end for this assignment's turn, and no other", () => {
    seq = 0;
    const settled = receipt("turn_ended", 2, { settledBy: "engine", outcome: "agent-closed" });
    const base = record([receipt("turn_started", 1), settled]);
    expect(engineSettledEnd(base, assignment())).toBe(settled);
    expect(engineSettledEnd(base, assignment({ turnId: "turn-1" }))).toBe(settled);
    expect(engineSettledEnd(base, assignment({ turnId: "turn-2" }))).toBeUndefined();
    expect(engineSettledEnd(base, assignment({ agentId: "agent-other" }))).toBeUndefined();
    expect(engineSettledEnd(base, assignment({ createdAt: AT(30) }))).toBeUndefined();
    // The host's own turn_ended is not the Engine's.
    expect(engineSettledEnd(record([receipt("turn_ended", 2)]), assignment())).toBeUndefined();
  });

  test("a receipt in the same millisecond the assignment was created is not later than it", () => {
    seq = 0;
    // The turn that began at the very moment of the assignment is not taken as this assignment's turn.
    const sameMs = record([receipt("turn_started", 0), receipt("closed", 1)]);
    expect(closedTurnCandidates(sameMs)).toEqual([]);
    expect(findClosedTurns(sameMs, closedSeat)).toEqual([]);
    // One millisecond later it is.
    const later = record([receipt("turn_started", 0, { receivedAt: "2026-11-09T10:00:00.001Z" })]);
    expect(findClosedTurns(later, closedSeat)).toHaveLength(1);
    // Nor is an Engine end written in that same millisecond this assignment's own (turn not yet known).
    const ended = receipt("turn_ended", 0, { settledBy: "engine", outcome: "agent-closed" });
    expect(engineSettledEnd(record([ended]), assignment())).toBeUndefined();
    expect(
      engineSettledEnd(
        record([{ ...ended, receivedAt: "2026-11-09T10:00:00.001Z" }]),
        assignment(),
      ),
    ).toBeDefined();
  });

  test("an archived receipt marks the seat's agent as archived, and only that agent", () => {
    seq = 0;
    const base = record([receipt("archived", 1)]);
    expect(isAgentArchived(base, AGENT)).toBe(true);
    expect(isAgentArchived(base, "agent-other")).toBe(false);
    expect(isAgentArchived(base, null)).toBe(false);
    expect(isAgentArchived(record([receipt("closed", 1)]), AGENT)).toBe(false);
  });

  test("closedSince: closed or archived after the turn began, and not before it", () => {
    seq = 0;
    expect(
      closedSince(record([receipt("turn_started", 1), receipt("archived", 2)]), AGENT, "turn-1"),
    ).toBe(true);
    seq = 0;
    expect(
      closedSince(record([receipt("turn_started", 1), receipt("closed", 2)]), AGENT, "turn-1"),
    ).toBe(true);
    seq = 0;
    expect(
      closedSince(record([receipt("closed", 1), receipt("turn_started", 2)]), AGENT, "turn-1"),
    ).toBe(false);
    seq = 0;
    expect(
      closedSince(
        record([receipt("turn_started", 1), receipt("closed", 2, { agentId: "agent-other" })]),
        AGENT,
        "turn-1",
      ),
    ).toBe(false);
    // Only the end is on record: it counts from there.
    seq = 0;
    expect(
      closedSince(record([receipt("turn_ended", 1), receipt("closed", 2)]), AGENT, "turn-1"),
    ).toBe(true);
  });
});

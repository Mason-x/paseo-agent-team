import { describe, expect, test } from "vitest";
import {
  agentsToCheck,
  closedSince,
  closedTurnCandidates,
  engineSettledEnd,
  findClosedTurns,
  isAgentArchived,
  isEngineSettled,
  planClosedTurns,
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

describe("planClosedTurns: a producer's or reviewer's turn under a closed member waits before it is called lost (T11e)", () => {
  const plan = (
    rec: RunRecord,
    seats: ReadonlyMap<string, SeatRead>,
    over: Partial<Parameters<typeof planClosedTurns>[2]> = {},
  ) => planClosedTurns(rec, seats, { now: AT(40), cancelling: false, seenAt: () => null, ...over });
  const shape = (found: ReturnType<typeof plan>) => ({
    lost: found.lost.length,
    hostLost: found.hostLost.length,
    waiting: found.waiting.length,
  });
  const cut = () => record([receipt("turn_started", 1), receipt("closed", 2)]);

  test("the wait is 30 seconds from the closed receipt: 29.999 seconds waits, 30 settles", () => {
    seq = 0;
    const rec = cut();
    expect(shape(plan(rec, idle, { now: "2026-11-09T10:00:31.999Z" }))).toEqual({
      lost: 0,
      hostLost: 0,
      waiting: 1,
    });
    expect(shape(plan(rec, idle, { now: AT(32) }))).toEqual({ lost: 0, hostLost: 1, waiting: 0 });
  });

  test("after the wait: idle with no turn is host-lost; closed, or any other reading, is lost", () => {
    seq = 0;
    const rec = cut();
    expect(shape(plan(rec, idle))).toEqual({ lost: 0, hostLost: 1, waiting: 0 });
    expect(shape(plan(rec, closedSeat))).toEqual({ lost: 1, hostLost: 0, waiting: 0 });
    const errored = new Map<string, SeatRead>([[AGENT, { status: "error", activeTurn: false }]]);
    expect(shape(plan(rec, errored))).toEqual({ lost: 1, hostLost: 0, waiting: 0 });
    const found = plan(rec, idle).hostLost[0];
    expect(found).toMatchObject({
      assignmentId: "a1",
      agentId: AGENT,
      turnId: "turn-1",
      basis: { closedBy: "receipt" },
    });
  });

  test("with no closed receipt the wait runs from the first look that saw it closed (or from now)", () => {
    seq = 0;
    const rec = record([receipt("turn_started", 1)]);
    // Never seen: it is first seen now, so it waits.
    expect(shape(plan(rec, closedSeat))).toEqual({ lost: 0, hostLost: 0, waiting: 1 });
    // Seen 31 seconds ago, still closed: lost.
    expect(shape(plan(rec, closedSeat, { seenAt: () => AT(9) }))).toEqual({
      lost: 1,
      hostLost: 0,
      waiting: 0,
    });
    // Seen 31 seconds ago and reopened since: host-lost, and the basis says the host read it.
    const reopened = plan(rec, idle, { seenAt: () => AT(9) });
    expect(shape(reopened)).toEqual({ lost: 0, hostLost: 1, waiting: 0 });
    expect(reopened.hostLost[0]?.basis).toEqual({ closedBy: "host-read", closedReceiptKey: null });
    // Seen 5 seconds ago: still waiting.
    expect(shape(plan(rec, closedSeat, { seenAt: () => AT(35) }))).toEqual({
      lost: 0,
      hostLost: 0,
      waiting: 1,
    });
    // Idle and never seen closed, no receipt: not a closed turn at all.
    expect(shape(plan(rec, idle))).toEqual({ lost: 0, hostLost: 0, waiting: 0 });
  });

  test("the receipt's time wins over a later first look", () => {
    seq = 0;
    expect(shape(plan(cut(), closedSeat, { seenAt: () => AT(39) }))).toEqual({
      lost: 1,
      hostLost: 0,
      waiting: 0,
    });
  });

  test("an archived receipt after the turn began, or a host that has no such Agent: lost at once", () => {
    seq = 0;
    const archived = record([
      receipt("turn_started", 1),
      receipt("closed", 2),
      receipt("archived", 3),
    ]);
    expect(shape(plan(archived, idle, { now: AT(4) }))).toEqual({
      lost: 1,
      hostLost: 0,
      waiting: 0,
    });
    seq = 0;
    expect(
      shape(plan(cut(), new Map<string, SeatRead>([[AGENT, "absent"]]), { now: AT(3) })),
    ).toEqual({ lost: 1, hostLost: 0, waiting: 0 });
  });

  test("the whole Run being cancelled: lost at once", () => {
    seq = 0;
    expect(shape(plan(cut(), idle, { now: AT(3), cancelling: true }))).toEqual({
      lost: 1,
      hostLost: 0,
      waiting: 0,
    });
  });

  test("a smoke tester and a supplement are not waited on; a reviewer and a re-opened producer are", () => {
    for (const purpose of ["smoker"] as const) {
      seq = 0;
      const rec = record([receipt("turn_started", 1), receipt("closed", 2)], {
        assignments: [assignment({ purpose })],
      });
      expect(shape(plan(rec, idle, { now: AT(3) }))).toEqual({ lost: 1, hostLost: 0, waiting: 0 });
    }
    seq = 0;
    const supplement = record([receipt("turn_started", 1), receipt("closed", 2)], {
      assignments: [
        assignment({
          evidenceRepair: {
            version: 1,
            predecessorAssignmentId: "a0",
            rootAssignmentId: "a0",
            ordinal: 1,
          },
        } as Partial<RunAssignment>),
      ],
    });
    (supplement as { schemaVersion: number }).schemaVersion = 2;
    expect(shape(plan(supplement, idle, { now: AT(3) }))).toEqual({
      lost: 1,
      hostLost: 0,
      waiting: 0,
    });
    for (const purpose of ["reviewer", "reopen", "member", "coordinator"] as const) {
      seq = 0;
      const rec = record([receipt("turn_started", 1), receipt("closed", 2)], {
        assignments: [assignment({ purpose })],
      });
      expect(shape(plan(rec, idle, { now: AT(3) }))).toEqual({
        lost: 0,
        hostLost: 0,
        waiting: 1,
      });
    }
  });

  test("a turn running when the wait is over is not settled and keeps waiting; one never seen closed is not in the plan", () => {
    seq = 0;
    const running = new Map<string, SeatRead>([[AGENT, { status: "running", activeTurn: true }]]);
    expect(shape(plan(cut(), running))).toEqual({ lost: 0, hostLost: 0, waiting: 1 });
    seq = 0;
    expect(
      shape(plan(record([receipt("turn_started", 1)]), running, { seenAt: () => AT(2) })),
    ).toEqual({ lost: 0, hostLost: 0, waiting: 1 });
    seq = 0;
    expect(shape(plan(record([receipt("turn_started", 1)]), running))).toEqual({
      lost: 0,
      hostLost: 0,
      waiting: 0,
    });
    // Archived or cancelling: nothing to wait for.
    seq = 0;
    const archivedRunning = record([
      receipt("turn_started", 1),
      receipt("closed", 2),
      receipt("archived", 3),
    ]);
    expect(shape(plan(archivedRunning, running))).toEqual({ lost: 0, hostLost: 0, waiting: 0 });
    seq = 0;
    expect(shape(plan(cut(), running, { cancelling: true }))).toEqual({
      lost: 0,
      hostLost: 0,
      waiting: 0,
    });
    // A read that failed is not in the plan either.
    seq = 0;
    expect(shape(plan(cut(), new Map<string, SeatRead>([[AGENT, "unreadable"]])))).toEqual({
      lost: 0,
      hostLost: 0,
      waiting: 0,
    });
  });

  test("findClosedTurns keeps T4a for every kind of turn: closed means closed at once", () => {
    seq = 0;
    const rec = record([receipt("turn_started", 1), receipt("closed", 2)], {
      assignments: [assignment({ purpose: "reviewer" })],
    });
    expect(findClosedTurns(rec, idle)).toHaveLength(1);
  });
});

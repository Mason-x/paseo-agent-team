import { describe, expect, test } from "vitest";
import {
  answerableActions,
  decisionKindOf,
  openLimboDecision,
} from "../../shared/domain/run-engine/decision-answer";
import {
  findLostTurns,
  HOST_LOST_CODE,
  type LostReplyRead,
  lostTurnCandidates,
  type SeatRead,
} from "../../shared/domain/run-engine/lost-turn";
import {
  emptyReadRetries,
  LOST_TURN_SETTLE_DELAY_MS,
  noteReadFailure,
  type ReadRetryTarget,
} from "../../shared/domain/run-engine/read-retry";
import type {
  RunAssignment,
  RunEventReceipt,
  RunRecord,
} from "../../shared/schemas/run-engine/ledger";

/**
 * T4b: `findLostTurns` decides from the record, one read of the member and one more look at its reply
 * which turns the host lost. Pure: nothing here touches a store, a clock or a host. The look and the
 * read of the member are given, and `now` too, so the 30 seconds are exactly 30 seconds.
 */

const AGENT = "agent-b1";
const T0 = Date.parse("2026-11-09T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
/** The re-checks of the reply were used up here. */
const HELD_AT = 10_000;
const DELAY = LOST_TURN_SETTLE_DELAY_MS;

const TARGET: ReadRetryTarget = {
  type: "reply",
  agentId: AGENT,
  taskId: "t1",
  assignmentId: "a1",
  anchorMessageId: "m1",
};

function assignment(over: Partial<RunAssignment> = {}): RunAssignment {
  return {
    assignmentId: "a1",
    taskId: "t1",
    attempt: 1,
    purpose: "member",
    agentId: AGENT,
    state: "assigned",
    acceptedProof: null,
    turnId: null,
    messageId: "m1",
    createdAt: at(0),
    ...over,
  } as RunAssignment;
}

let seq = 0;
function receipt(
  kind: RunEventReceipt["kind"],
  ms: number,
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
    receivedAt: at(ms),
    ...over,
  } as RunEventReceipt;
}

type Options = {
  receipts?: RunEventReceipt[];
  assignments?: RunAssignment[];
  outbox?: Record<string, unknown>[];
  schemaVersion?: 1 | 2;
  /** Leave the item in this state instead of used up. */
  lastCode?: string;
  failures?: number;
  dropHeldEvent?: boolean;
};

/** A record whose reply re-check of a1 was used up at `HELD_AT`, built by the code that writes it. */
function record(options: Options = {}): RunRecord {
  const assignments = options.assignments ?? [assignment()];
  let base = {
    schemaVersion: options.schemaVersion ?? 2,
    lifecycle: "active",
    launch: { state: "launched" },
    assignments,
    eventReceipts: options.receipts ?? [receipt("turn_started", 1000)],
    outbox: options.outbox ?? [
      ...assignments.map((entry) => ({
        id: `intent-${entry.assignmentId}`,
        kind: "dispatch",
        taskId: entry.taskId,
        recipient: entry.agentId,
        assignmentId: entry.assignmentId,
        state: "confirmed",
      })),
    ],
    roster: [],
    alerts: [],
    events: [],
    counters: { eventsThroughSeq: 0, observationSeq: 100 },
    revision: 1,
    updatedAt: at(0),
  } as unknown as RunRecord;
  if (base.schemaVersion === 2) {
    (base as Record<string, unknown>).readRetries = emptyReadRetries();
    const noted = noteReadFailure(
      base,
      { key: "k1", sourceKey: "source-k1", target: TARGET },
      at(0),
    );
    if (!noted.changed) throw new Error("not noted");
    base = noted.next;
    // The three tries, at the due times, then the item is held with the code of the last.
    const code = options.lastCode ?? "incomplete:dispatch-not-found";
    const items = (base as unknown as { readRetries: { items: Record<string, unknown>[] } })
      .readRetries.items;
    const [item] = items;
    if (item === undefined) throw new Error("no item");
    Object.assign(item, {
      state: "held",
      attemptsStarted: 3,
      nextAt: null,
      lastCode: code,
    });
    if (options.dropHeldEvent !== true) {
      base.events.push({
        seq: base.events.length + 1,
        kind: "read-retry-changed",
        at: at(HELD_AT),
        payload: { key: "k1", generation: 1, state: "held", attemptsStarted: 3, code },
      } as never);
      base.counters.eventsThroughSeq = base.events.length;
    }
  }
  return base;
}

const idle = new Map<string, SeatRead>([[AGENT, { status: "idle", activeTurn: false }]]);
const found = (ms: number): ReadonlyMap<string, LostReplyRead> =>
  new Map([["a1", { dispatchNotFound: true, at: at(ms) }]]);
const AFTER = HELD_AT + DELAY;

describe("findLostTurns: what proves a turn was lost by the host", () => {
  test("the re-checks used up, 30 seconds later, a member that is idle and the dispatch still missing: settled, with what showed it", () => {
    const turns = findLostTurns(record(), idle, found(AFTER), at(AFTER));
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      assignmentId: "a1",
      taskId: "t1",
      agentId: AGENT,
      turnId: "turn-1",
      basis: {
        firstNotFoundAt: at(HELD_AT),
        secondNotFoundAt: at(AFTER),
        seatStatus: "idle",
      },
    });
    expect(LOST_TURN_SETTLE_DELAY_MS).toBe(30_000);
  });

  test("the 30 seconds are counted from the last failure: 29.999 seconds is too early, 30 seconds is enough", () => {
    expect(findLostTurns(record(), idle, found(AFTER - 1), at(AFTER - 1))).toEqual([]);
    expect(findLostTurns(record(), idle, found(AFTER), at(AFTER))).toHaveLength(1);
    expect(findLostTurns(record(), idle, found(AFTER + 1), at(AFTER + 1))).toHaveLength(1);
    // The candidates, judged from the ledger alone, are the same at both moments.
    expect(lostTurnCandidates(record(), at(AFTER - 1))).toEqual([]);
    expect(lostTurnCandidates(record(), at(AFTER))).toHaveLength(1);
  });

  test("the look that found the dispatch missing again counts, not only the clock now: a look made too early is not enough", () => {
    expect(findLostTurns(record(), idle, found(AFTER - 1), at(AFTER + 5000))).toEqual([]);
  });

  test("the reads of the reply are not used up (no item, or one that is waiting, checking, resolved or used up for another reason): not settled", () => {
    expect(findLostTurns(record({ schemaVersion: 1 }), idle, found(AFTER), at(AFTER))).toEqual([]);
    expect(
      findLostTurns(
        record({ lastCode: "incomplete:no-dispatch-echo" }),
        idle,
        found(AFTER),
        at(AFTER),
      ),
    ).toEqual([]);
    expect(
      findLostTurns(record({ lastCode: "read-error" }), idle, found(AFTER), at(AFTER)),
    ).toEqual([]);
    for (const state of ["waiting", "checking", "resolved"] as const) {
      const waiting = record();
      const item = (waiting as unknown as { readRetries: { items: Record<string, unknown>[] } })
        .readRetries.items[0];
      Object.assign(item ?? {}, {
        state,
        nextAt: state === "waiting" ? at(AFTER) : null,
        attemptsStarted: state === "waiting" ? 2 : 3,
      });
      expect(findLostTurns(waiting, idle, found(AFTER), at(AFTER))).toEqual([]);
    }
  });

  test("when the item was used up is not known (the event is gone): not settled", () => {
    expect(findLostTurns(record({ dropHeldEvent: true }), idle, found(AFTER), at(AFTER))).toEqual(
      [],
    );
  });

  test("the look must find the dispatch missing again: a reply that reads, or a failed look, settles nothing", () => {
    const readable = new Map([["a1", { dispatchNotFound: false, at: at(AFTER) }]]);
    expect(findLostTurns(record(), idle, readable, at(AFTER))).toEqual([]);
    expect(findLostTurns(record(), idle, new Map(), at(AFTER))).toEqual([]);
  });

  test("the member must read as idle with no turn running: closed, running, a turn, an unreadable or a missing agent settle nothing", () => {
    const seats: [string, SeatRead][] = [
      ["closed", { status: "closed", activeTurn: false }],
      ["running", { status: "running", activeTurn: true }],
      ["idle but with a turn", { status: "idle", activeTurn: true }],
      ["initializing", { status: "initializing", activeTurn: false }],
      ["error", { status: "error", activeTurn: false }],
      ["unreadable", "unreadable"],
      ["absent", "absent"],
    ];
    for (const [, seat] of seats) {
      expect(findLostTurns(record(), new Map([[AGENT, seat]]), found(AFTER), at(AFTER))).toEqual(
        [],
      );
    }
    expect(findLostTurns(record(), new Map(), found(AFTER), at(AFTER))).toEqual([]);
  });

  test("the dispatch must be confirmed delivered, and nothing for the task or the member may be on its way or of unknown fate", () => {
    const dispatch = (state: string) => ({
      id: "intent-a1",
      kind: "dispatch",
      taskId: "t1",
      recipient: AGENT,
      assignmentId: "a1",
      state,
    });
    for (const state of ["prepared", "sending", "outcome-unknown", "failed"]) {
      expect(
        findLostTurns(record({ outbox: [dispatch(state)] }), idle, found(AFTER), at(AFTER)),
      ).toEqual([]);
    }
    for (const state of ["prepared", "sending", "outcome-unknown"]) {
      const other = {
        id: "intent-w",
        kind: "wake",
        taskId: "t1",
        recipient: AGENT,
        semanticArgs: {},
        state,
      };
      expect(
        findLostTurns(
          record({ outbox: [dispatch("confirmed"), other] }),
          idle,
          found(AFTER),
          at(AFTER),
        ),
      ).toEqual([]);
      // To the member, for another task: the member may still start a turn from it.
      const elsewhere = { ...other, taskId: "t9" };
      expect(
        findLostTurns(
          record({ outbox: [dispatch("confirmed"), elsewhere] }),
          idle,
          found(AFTER),
          at(AFTER),
        ),
      ).toEqual([]);
    }
    // One that is settled, either way, is no reason to wait.
    for (const state of ["confirmed", "failed"]) {
      const other = {
        id: "intent-w",
        kind: "wake",
        taskId: "t1",
        recipient: AGENT,
        semanticArgs: {},
        state,
      };
      expect(
        findLostTurns(
          record({ outbox: [dispatch("confirmed"), other] }),
          idle,
          found(AFTER),
          at(AFTER),
        ),
      ).toHaveLength(1);
    }
  });

  test("the turn must be known: one turn_started of the member after the assignment was made, and none before it counts", () => {
    expect(findLostTurns(record({ receipts: [] }), idle, found(AFTER), at(AFTER))).toEqual([]);
    expect(
      findLostTurns(
        record({ receipts: [receipt("turn_started", -1000)] }),
        idle,
        found(AFTER),
        at(AFTER),
      ),
    ).toEqual([]);
    // At the very moment the assignment was made is not after it.
    expect(
      findLostTurns(
        record({ receipts: [receipt("turn_started", 0)] }),
        idle,
        found(AFTER),
        at(AFTER),
      ),
    ).toEqual([]);
    // Another agent's turn is not the member's.
    expect(
      findLostTurns(
        record({ receipts: [receipt("turn_started", 1000, { agentId: "agent-b2" })] }),
        idle,
        found(AFTER),
        at(AFTER),
      ),
    ).toEqual([]);
  });

  test("an assignment that knows its turn is settled for that turn and no other", () => {
    const own = assignment({ turnId: "turn-1" });
    expect(
      findLostTurns(record({ assignments: [own] }), idle, found(AFTER), at(AFTER)),
    ).toHaveLength(1);
    const other = assignment({ turnId: "turn-9" });
    expect(findLostTurns(record({ assignments: [other] }), idle, found(AFTER), at(AFTER))).toEqual(
      [],
    );
  });

  test("nothing of the member may come after the turn: a later turn_started, or any turn_ended, means it moved on", () => {
    const later = (kind: RunEventReceipt["kind"], over: Record<string, unknown> = {}) => [
      receipt("turn_started", 1000),
      receipt(kind, 2000, { turnId: "turn-2", ...over }),
    ];
    expect(
      findLostTurns(record({ receipts: later("turn_started") }), idle, found(AFTER), at(AFTER)),
    ).toEqual([]);
    expect(
      findLostTurns(record({ receipts: later("turn_ended") }), idle, found(AFTER), at(AFTER)),
    ).toEqual([]);
    // The turn itself ended, by the host's word or the Engine's.
    expect(
      findLostTurns(
        record({
          receipts: [
            receipt("turn_started", 1000),
            receipt("turn_ended", 2000, { settledBy: "engine", outcome: "host-lost" }),
          ],
        }),
        idle,
        found(AFTER),
        at(AFTER),
      ),
    ).toEqual([]);
    // Another agent's turn end is not the member's.
    expect(
      findLostTurns(
        record({
          receipts: [
            receipt("turn_started", 1000),
            receipt("turn_ended", 2000, { agentId: "agent-b2", turnId: "turn-x" }),
          ],
        }),
        idle,
        found(AFTER),
        at(AFTER),
      ),
    ).toHaveLength(1);
  });

  test("a member the host closed or archived after the turn began is a closed turn (T4a), not a lost one", () => {
    for (const kind of ["closed", "archived"] as const) {
      expect(
        findLostTurns(
          record({ receipts: [receipt("turn_started", 1000), receipt(kind, 2000)] }),
          idle,
          found(AFTER),
          at(AFTER),
        ),
      ).toEqual([]);
    }
  });

  test("only a producer's turn is settled, and only one that is open and has no report", () => {
    for (const purpose of ["reviewer", "smoker"] as const) {
      expect(
        findLostTurns(
          record({ assignments: [assignment({ purpose })] }),
          idle,
          found(AFTER),
          at(AFTER),
        ),
      ).toEqual([]);
    }
    for (const purpose of ["member", "coordinator", "reopen"] as const) {
      expect(
        findLostTurns(
          record({ assignments: [assignment({ purpose })] }),
          idle,
          found(AFTER),
          at(AFTER),
        ),
      ).toHaveLength(1);
    }
    expect(
      findLostTurns(
        record({ assignments: [assignment({ state: "ended" })] }),
        idle,
        found(AFTER),
        at(AFTER),
      ),
    ).toEqual([]);
    expect(
      findLostTurns(
        record({ assignments: [assignment({ acceptedProof: { kind: "x" } as never })] }),
        idle,
        found(AFTER),
        at(AFTER),
      ),
    ).toEqual([]);
  });

  test("a supplement (an evidence request to the producer) is not a candidate: the host is not read for a turn whose decision could not be opened", () => {
    const supplement = assignment({
      evidenceRepair: {
        version: 1,
        predecessorAssignmentId: "a0",
        rootAssignmentId: "a0",
        ordinal: 1,
      },
    } as never);
    const supplemented = record({ assignments: [supplement] });
    expect(lostTurnCandidates(supplemented, at(AFTER))).toEqual([]);
    expect(findLostTurns(supplemented, idle, found(AFTER), at(AFTER))).toEqual([]);
    // The same assignment without the request is the ordinary producer turn, found.
    expect(lostTurnCandidates(record(), at(AFTER))).toHaveLength(1);
    // A v1 record reads no such request (an unrelated field of that name is not one), so it stays
    // what it was: with no re-check record there is no candidate either way.
    expect(
      lostTurnCandidates(record({ assignments: [supplement], schemaVersion: 1 }), at(AFTER)),
    ).toEqual([]);
  });

  test("an item for another message than the one the assignment waits on is not its item", () => {
    const moved = record({ assignments: [assignment({ messageId: "m-other" })] });
    expect(findLostTurns(moved, idle, found(AFTER), at(AFTER))).toEqual([]);
  });
});

describe("the decision for a lost turn: retry or cancel, until the member is archived", () => {
  function decisionFor(opened: RunRecord) {
    const decision = opened.decisions.at(-1);
    if (decision === undefined) throw new Error("no decision");
    return decision;
  }

  /** A record with the lost turn settled by hand: the receipt and the decision the settler writes. */
  function settled(): RunRecord {
    const base = record();
    const ended = receipt("turn_ended", AFTER, { settledBy: "engine", outcome: "host-lost" });
    base.eventReceipts.push(ended);
    base.tasks = [
      {
        spec: { id: "t1", deps: [] },
        state: "assigned",
        currentAssignmentId: "a1",
        attempts: 1,
      },
    ] as never;
    base.decisions = [];
    base.lifecycle = "active";
    return base;
  }

  test("opened with the reason, it reads as host-lost and is answered with retry or cancel", () => {
    const base = settled();
    const opened = openLimboDecision(base, {
      taskId: "t1",
      assignmentId: "a1",
      reason: HOST_LOST_CODE,
      turnId: "turn-1",
      decisionId: "d1",
      controlNonceDigest: "0".repeat(64),
      now: at(AFTER),
    });
    if (!opened.changed) throw new Error("the decision was not opened");
    const decision = decisionFor(opened.next);
    expect(decision).toMatchObject({ category: "D1", state: "open", subjectId: "t1" });
    expect(decisionKindOf(opened.next, decision)).toBe("host-lost");
    expect(answerableActions(opened.next, decision)).toEqual(["retry", "cancel"]);
    expect(decision.summary).toContain("宿主");
    expect(decision.summary).toContain("确认它已经停止");
  });

  test("a member archived after the turn began makes it cancel only; a closed receipt alone does not (T9d)", () => {
    for (const kind of ["closed", "archived"] as const) {
      const base = settled();
      const opened = openLimboDecision(base, {
        taskId: "t1",
        assignmentId: "a1",
        reason: HOST_LOST_CODE,
        turnId: "turn-1",
        decisionId: "d1",
        controlNonceDigest: "0".repeat(64),
        now: at(AFTER),
      });
      if (!opened.changed) throw new Error("the decision was not opened");
      opened.next.eventReceipts.push(receipt(kind, AFTER + 5000));
      // A graceful stop of the daemon writes a closed receipt for every agent; it is usable again.
      expect(answerableActions(opened.next, decisionFor(opened.next)), kind).toEqual(
        kind === "archived" ? ["cancel"] : ["retry", "cancel"],
      );
    }
  });

  test("a decision for another reason (an unusable report) is still cut by a closed receipt (T9d changes host-lost only)", () => {
    for (const kind of ["closed", "archived"] as const) {
      const opened = openLimboDecision(settled(), {
        taskId: "t1",
        assignmentId: "a1",
        reason: "report-missing",
        turnId: "turn-1",
        decisionId: "d1",
        controlNonceDigest: "0".repeat(64),
        now: at(AFTER),
      });
      if (!opened.changed) throw new Error("the decision was not opened");
      expect(answerableActions(opened.next, decisionFor(opened.next))).toEqual(["retry", "cancel"]);
      opened.next.eventReceipts.push(receipt(kind, AFTER + 5000));
      expect(answerableActions(opened.next, decisionFor(opened.next)), kind).toEqual(["cancel"]);
    }
  });

  test("an archived receipt of another agent does not cut a host-lost decision", () => {
    const base = settled();
    const opened = openLimboDecision(base, {
      taskId: "t1",
      assignmentId: "a1",
      reason: HOST_LOST_CODE,
      turnId: "turn-1",
      decisionId: "d1",
      controlNonceDigest: "0".repeat(64),
      now: at(AFTER),
    });
    if (!opened.changed) throw new Error("the decision was not opened");
    opened.next.eventReceipts.push(receipt("archived", AFTER + 5000, { agentId: "agent-other" }));
    expect(answerableActions(opened.next, decisionFor(opened.next))).toEqual(["retry", "cancel"]);
  });

  test("a judge's or a supplement's turn is not given a host-lost decision: its decision has no retry", () => {
    const base = settled();
    base.assignments = [assignment({ purpose: "reviewer" })];
    const opened = openLimboDecision(base, {
      taskId: "t1",
      assignmentId: "a1",
      reason: HOST_LOST_CODE,
      turnId: "turn-1",
      decisionId: "d1",
      controlNonceDigest: "0".repeat(64),
      now: at(AFTER),
    });
    expect(opened.changed).toBe(false);
  });
});

describe("a turn id that was used before the assignment", () => {
  test("the end of the earlier turn that shares its id does not hide the turn the member lost", () => {
    const earlierEnd = receipt("turn_ended", 500, {
      eventKey: `turn_ended:${AGENT}:turn-1`,
      dedupeKey: `turn_ended:${AGENT}:turn-1`,
    });
    const newStart = receipt("turn_started", 1000, {
      eventKey: `turn_started:${AGENT}:turn-1#2`,
      dedupeKey: `turn_started:${AGENT}:turn-1#2`,
    });
    const lost = record({ receipts: [earlierEnd, newStart] });
    expect(lostTurnCandidates(lost, at(AFTER))).toHaveLength(1);
    // Its own end, of the same appearance, is a turn that ended: nothing was lost.
    const ownEnd = receipt("turn_ended", 2000, {
      eventKey: `turn_ended:${AGENT}:turn-1#2`,
      dedupeKey: `turn_ended:${AGENT}:turn-1#2`,
    });
    expect(
      lostTurnCandidates(record({ receipts: [earlierEnd, newStart, ownEnd] }), at(AFTER)),
    ).toEqual([]);
  });
});

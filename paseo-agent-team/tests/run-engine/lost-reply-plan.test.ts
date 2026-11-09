import { describe, expect, test } from "vitest";
import { planCancelFinish } from "../../shared/domain/run-engine/cancel-request";
import { openLimboDecision } from "../../shared/domain/run-engine/decision-answer";
import {
  findLostReplies,
  HOST_LOST_CODE,
  type LostReplyRead,
  lostReplyCandidates,
  lostReplyKind,
  MEMBER_LOST_CODE,
  type SeatRead,
} from "../../shared/domain/run-engine/lost-turn";
import {
  emptyReadRetries,
  LOST_TURN_SETTLE_DELAY_MS,
  noteReadFailure,
  type ReadRetryTarget,
} from "../../shared/domain/run-engine/read-retry";
import { latestEndedTurn, provenEndedTurn } from "../../shared/domain/run-engine/turn-proof";
import type {
  RunAssignment,
  RunEventReceipt,
  RunRecord,
} from "../../shared/schemas/run-engine/ledger";

/**
 * T9b: `findLostReplies` decides from the record, one read of the member and one more look at its reply
 * which replies the host lost after it had said the turn ended. Pure: no store, no clock, no host. The
 * 30 seconds are exactly 30 seconds. The proof that the turn ended is `provenEndedTurn`, which the
 * cancellation of a Run takes too: the last group checks that the two agree.
 */

const AGENT = "agent-b1";
const T0 = Date.parse("2026-11-09T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const HELD_AT = 10_000;
const DELAY = LOST_TURN_SETTLE_DELAY_MS;
const AFTER = HELD_AT + DELAY;

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
  const key = `${kind}:${AGENT}:${turnId ?? "-"}:${seq}`;
  return {
    eventKey: key,
    kind,
    agentId: AGENT,
    turnId,
    dedupeKey: key,
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
  lastCode?: string;
  /** Leave the item waiting instead of used up. */
  waiting?: boolean;
};

/** A record whose reply re-check of a1 was used up at `HELD_AT`, built by the code that writes it. */
function record(options: Options = {}): RunRecord {
  const assignments = options.assignments ?? [assignment()];
  let base = {
    schemaVersion: options.schemaVersion ?? 2,
    lifecycle: "active",
    launch: { state: "launched" },
    assignments,
    // The host said the turn began and ended.
    eventReceipts: options.receipts ?? [receipt("turn_started", 1000), receipt("turn_ended", 2000)],
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
    if (options.waiting !== true) {
      const code = options.lastCode ?? "incomplete:dispatch-not-found";
      const items = (base as unknown as { readRetries: { items: Record<string, unknown>[] } })
        .readRetries.items;
      const [item] = items;
      if (item === undefined) throw new Error("no item");
      Object.assign(item, { state: "held", attemptsStarted: 3, nextAt: null, lastCode: code });
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

describe("findLostReplies: what proves a reply the host lost after the turn ended", () => {
  test("the host's end, the re-checks used up with dispatch-not-found, 30 seconds, a look that still finds it missing, a member at rest: host-lost on the host's own end", () => {
    const base = record();
    const [end] = base.eventReceipts.filter((entry) => entry.kind === "turn_ended");
    const lost = findLostReplies(base, idle, found(AFTER), at(AFTER));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({
      assignmentId: "a1",
      taskId: "t1",
      agentId: AGENT,
      turnId: "turn-1",
      endedEventKey: end?.eventKey,
      kind: HOST_LOST_CODE,
    });
  });

  test("29.999 seconds after the last failure is too early; 30 seconds is enough", () => {
    expect(findLostReplies(record(), idle, found(AFTER - 1), at(AFTER - 1))).toEqual([]);
    expect(lostReplyCandidates(record(), at(AFTER - 1))).toEqual([]);
    expect(findLostReplies(record(), idle, found(AFTER), at(AFTER))).toHaveLength(1);
    expect(lostReplyCandidates(record(), at(AFTER))).toHaveLength(1);
  });

  test("the look that found the dispatch missing again counts too: one made too early is not enough", () => {
    expect(findLostReplies(record(), idle, found(AFTER - 1), at(AFTER + 5000))).toEqual([]);
  });

  test("a look that did not find the dispatch missing, or that was not made, settles nothing", () => {
    const readable = new Map([["a1", { dispatchNotFound: false, at: at(AFTER) }]]);
    expect(findLostReplies(record(), idle, readable, at(AFTER))).toEqual([]);
    expect(findLostReplies(record(), idle, new Map(), at(AFTER))).toEqual([]);
  });

  test("only incomplete:dispatch-not-found counts: any other reason of the used-up re-checks is kept as a warning", () => {
    for (const lastCode of [
      "incomplete:too-many-pages",
      "incomplete:timeline-discontinuity",
      "incomplete:epoch-changed",
      "incomplete:turn-unknown",
      "incomplete:too-large",
      "interrupted",
      "read-error",
      "ECONNRESET",
    ]) {
      expect(lostReplyCandidates(record({ lastCode }), at(AFTER)), lastCode).toEqual([]);
      expect(
        findLostReplies(record({ lastCode }), idle, found(AFTER), at(AFTER)),
        lastCode,
      ).toEqual([]);
    }
  });

  test("re-checks that are not used up, or a Run with no re-check record (v1), settle nothing", () => {
    expect(lostReplyCandidates(record({ waiting: true }), at(AFTER))).toEqual([]);
    expect(findLostReplies(record({ schemaVersion: 1 }), idle, found(AFTER), at(AFTER))).toEqual(
      [],
    );
  });

  test("no end of the member's turn on the ledger is T4b's, not this: nothing is found", () => {
    const base = record({ receipts: [receipt("turn_started", 1000)] });
    expect(lostReplyCandidates(base, at(AFTER))).toEqual([]);
  });

  test("an end of another agent, or from before the assignment, is not the member's turn", () => {
    const other = record({
      receipts: [
        receipt("turn_started", 1000),
        receipt("turn_ended", 2000, {
          agentId: "agent-b2",
          eventKey: "turn_ended:agent-b2:turn-1",
        }),
      ],
    });
    expect(lostReplyCandidates(other, at(AFTER))).toEqual([]);
    const before = record({
      receipts: [receipt("turn_started", -5000), receipt("turn_ended", -4000)],
    });
    expect(lostReplyCandidates(before, at(AFTER))).toEqual([]);
  });

  test("a turn the member began after that end means it works again: nothing is found", () => {
    const again = record({
      receipts: [
        receipt("turn_started", 1000),
        receipt("turn_ended", 2000),
        receipt("turn_started", 3000, {
          turnId: "turn-2",
          eventKey: "turn_started:agent-b1:turn-2",
        }),
      ],
    });
    expect(lostReplyCandidates(again, at(AFTER))).toEqual([]);
    expect(findLostReplies(again, idle, found(AFTER), at(AFTER))).toEqual([]);
  });

  test("a late start of the very turn that ended is not the member working again", () => {
    const late = record({
      receipts: [receipt("turn_ended", 2000), receipt("turn_started", 3000)],
    });
    expect(findLostReplies(late, idle, found(AFTER), at(AFTER))).toHaveLength(1);
  });

  test("when the assignment knows its turn, an end of another turn is not its end", () => {
    const known = record({
      assignments: [assignment({ turnId: "turn-9" })],
      receipts: [receipt("turn_started", 1000), receipt("turn_ended", 2000)],
    });
    expect(lostReplyCandidates(known, at(AFTER))).toEqual([]);
    const same = record({
      assignments: [assignment({ turnId: "turn-1" })],
      receipts: [receipt("turn_started", 1000), receipt("turn_ended", 2000)],
    });
    expect(lostReplyCandidates(same, at(AFTER))).toHaveLength(1);
  });

  test("a member that is running or whose state could not be read is not at rest", () => {
    const running = new Map<string, SeatRead>([[AGENT, { status: "running", activeTurn: true }]]);
    const activeIdle = new Map<string, SeatRead>([[AGENT, { status: "idle", activeTurn: true }]]);
    const unreadable = new Map<string, SeatRead>([[AGENT, "unreadable"]]);
    const absent = new Map<string, SeatRead>([[AGENT, "absent"]]);
    for (const seats of [running, activeIdle, unreadable, absent, new Map<string, SeatRead>()]) {
      expect(findLostReplies(record(), seats, found(AFTER), at(AFTER))).toEqual([]);
    }
  });

  test("a message that is on its way or of unknown fate may still start a turn: nothing is found", () => {
    for (const state of ["sending", "outcome-unknown"]) {
      const base = record();
      base.outbox.push({
        id: "intent-x",
        kind: "wake",
        taskId: "t1",
        recipient: AGENT,
        assignmentId: null,
        semanticArgs: {},
        state,
      } as never);
      expect(lostReplyCandidates(base, at(AFTER)), state).toEqual([]);
    }
    // One to another agent for another task does not matter.
    const unrelated = record();
    unrelated.outbox.push({
      id: "intent-y",
      kind: "wake",
      taskId: "t9",
      recipient: "agent-z",
      assignmentId: null,
      semanticArgs: {},
      state: "sending",
    } as never);
    expect(lostReplyCandidates(unrelated, at(AFTER))).toHaveLength(1);
  });

  test("an assignment that is not waiting for a report, or whose dispatch was not confirmed, is not found", () => {
    expect(
      lostReplyCandidates(record({ assignments: [assignment({ state: "ended" })] }), at(AFTER)),
    ).toEqual([]);
    expect(
      lostReplyCandidates(
        record({ assignments: [assignment({ acceptedProof: { x: 1 } as never })] }),
        at(AFTER),
      ),
    ).toEqual([]);
    const unsent = record();
    for (const intent of unsent.outbox) intent.state = "prepared" as never;
    expect(lostReplyCandidates(unsent, at(AFTER))).toEqual([]);
  });

  test("an end the Engine wrote itself already has its decision: nothing more is found for it", () => {
    const settled = record({
      receipts: [
        receipt("turn_started", 1000),
        receipt("turn_ended", 2000, { settledBy: "engine", outcome: "agent-closed" }),
      ],
    });
    expect(lostReplyCandidates(settled, at(AFTER))).toEqual([]);
  });
});

describe("lostReplyKind: which decision", () => {
  test("a member that is idle and was never closed or archived: host-lost", () => {
    expect(lostReplyKind(record(), assignment(), { status: "idle", activeTurn: false })).toBe(
      HOST_LOST_CODE,
    );
  });

  test("an archived receipt after the assignment, or a read of closed now: member-lost, in any order of the receipts", () => {
    const base = record({
      receipts: [
        receipt("turn_started", 1000),
        receipt("turn_ended", 2000),
        receipt("archived", 2500),
        receipt("closed", 2600),
      ],
    });
    expect(lostReplyKind(base, assignment(), { status: "idle", activeTurn: false })).toBe(
      MEMBER_LOST_CODE,
    );
    // Archived, then the end, then closed (the cascade of archiving the coordinator).
    const cascade = record({
      receipts: [
        receipt("turn_started", 1000),
        receipt("archived", 1500),
        receipt("turn_ended", 2000),
        receipt("closed", 2500),
      ],
    });
    expect(lostReplyKind(cascade, assignment(), { status: "idle", activeTurn: false })).toBe(
      MEMBER_LOST_CODE,
    );
    // An archived receipt alone is enough.
    const only = record({
      receipts: [
        receipt("turn_started", 1000),
        receipt("turn_ended", 2000),
        receipt("archived", 2500),
      ],
    });
    expect(lostReplyKind(only, assignment(), { status: "idle", activeTurn: false })).toBe(
      MEMBER_LOST_CODE,
    );
    expect(lostReplyKind(record(), assignment(), { status: "closed", activeTurn: false })).toBe(
      MEMBER_LOST_CODE,
    );
  });

  test("a closed receipt alone is not the member gone (a graceful stop writes one for every agent): a producer's turn stays host-lost (T9d)", () => {
    // R of DEV: the end (canceled), then the closed receipt; after the restart the member reads idle.
    const afterStop = record({
      receipts: [
        receipt("turn_started", 1000),
        receipt("turn_ended", 2000),
        receipt("closed", 2500),
      ],
    });
    for (const purpose of ["member", "coordinator", "reopen"] as const) {
      expect(
        lostReplyKind(afterStop, assignment({ purpose }), { status: "idle", activeTurn: false }),
        purpose,
      ).toBe(HOST_LOST_CODE);
    }
    // Its order does not matter either: the closed receipt before the end.
    const reordered = record({
      receipts: [
        receipt("turn_started", 1000),
        receipt("closed", 1500),
        receipt("turn_ended", 2000),
      ],
    });
    expect(lostReplyKind(reordered, assignment(), { status: "idle", activeTurn: false })).toBe(
      HOST_LOST_CODE,
    );
    // After the restart the member took another turn (the OK of A21) and that ended too.
    const again = record({
      receipts: [
        receipt("turn_started", 1000),
        receipt("turn_ended", 2000),
        receipt("closed", 2500),
        receipt("turn_started", 3000),
        receipt("turn_ended", 4000),
      ],
    });
    expect(lostReplyKind(again, assignment(), { status: "idle", activeTurn: false })).toBe(
      HOST_LOST_CODE,
    );
    // A closed receipt and a read of closed now: it is closed now, so member-lost.
    expect(lostReplyKind(afterStop, assignment(), { status: "closed", activeTurn: false })).toBe(
      MEMBER_LOST_CODE,
    );
  });

  test("a closed or archived receipt from before the assignment is not about this turn", () => {
    for (const kind of ["closed", "archived"] as const) {
      const base = record({
        receipts: [
          receipt(kind, -3000),
          receipt("turn_started", 1000),
          receipt("turn_ended", 2000),
        ],
      });
      expect(lostReplyKind(base, assignment(), { status: "idle", activeTurn: false }), kind).toBe(
        HOST_LOST_CODE,
      );
    }
  });

  test("an archived receipt of another agent is not this one's", () => {
    const base = record({
      receipts: [
        receipt("turn_started", 1000),
        receipt("turn_ended", 2000),
        receipt("archived", 2500, { agentId: "agent-other" }),
      ],
    });
    expect(lostReplyKind(base, assignment(), { status: "idle", activeTurn: false })).toBe(
      HOST_LOST_CODE,
    );
  });

  test("a member that is not at rest, or was not read, gets no decision", () => {
    expect(
      lostReplyKind(record(), assignment(), { status: "running", activeTurn: false }),
    ).toBeNull();
    expect(lostReplyKind(record(), assignment(), { status: "idle", activeTurn: true })).toBeNull();
    expect(lostReplyKind(record(), assignment(), "unreadable")).toBeNull();
    expect(lostReplyKind(record(), assignment(), "absent")).toBeNull();
    expect(lostReplyKind(record(), assignment(), undefined)).toBeNull();
  });

  test("a judge's or a smoke tester's turn only gets member-lost: its decision has no way to try again", () => {
    const afterStop = record({
      receipts: [
        receipt("turn_started", 1000),
        receipt("turn_ended", 2000),
        receipt("closed", 2500),
      ],
    });
    const archived = record({
      receipts: [
        receipt("turn_started", 1000),
        receipt("turn_ended", 2000),
        receipt("archived", 2500),
      ],
    });
    const before = record({
      receipts: [
        receipt("closed", -3000),
        receipt("turn_started", 1000),
        receipt("turn_ended", 2000),
      ],
    });
    for (const purpose of ["reviewer", "smoker"] as const) {
      const judge = assignment({ purpose });
      // Nothing closed it: no decision (its way out is the stuck-judge one).
      expect(
        lostReplyKind(record(), judge, { status: "idle", activeTurn: false }),
        purpose,
      ).toBeNull();
      expect(
        lostReplyKind(before, judge, { status: "idle", activeTurn: false }),
        purpose,
      ).toBeNull();
      expect(lostReplyKind(record(), judge, { status: "closed", activeTurn: false }), purpose).toBe(
        MEMBER_LOST_CODE,
      );
      // The order of R (the end, then closed) is the same as before T9d: member-lost, never host-lost.
      expect(lostReplyKind(afterStop, judge, { status: "idle", activeTurn: false }), purpose).toBe(
        MEMBER_LOST_CODE,
      );
      expect(lostReplyKind(archived, judge, { status: "idle", activeTurn: false }), purpose).toBe(
        MEMBER_LOST_CODE,
      );
    }
  });
});

describe("the decision it opens", () => {
  function openOn(
    base: RunRecord,
    reason: typeof HOST_LOST_CODE | typeof MEMBER_LOST_CODE,
    replyLost = true,
  ) {
    const task = {
      spec: { id: "t1" },
      state: "assigned",
      currentAssignmentId: "a1",
    };
    const withTask = { ...base, tasks: [task], decisions: [] } as unknown as RunRecord;
    const [end] = withTask.eventReceipts.filter((entry) => entry.kind === "turn_ended");
    return openLimboDecision(withTask, {
      taskId: "t1",
      assignmentId: "a1",
      reason,
      turnId: "turn-1",
      endedEventKey: end?.eventKey ?? "",
      replyLost,
      decisionId: "d1",
      controlNonceDigest: "0".repeat(64),
      now: at(AFTER),
    });
  }

  test("the same decision as for the other limbo reasons: the same key, the same reason, only the words say the reply is lost", () => {
    const base = record();
    for (const reason of [HOST_LOST_CODE, MEMBER_LOST_CODE] as const) {
      const lost = openOn(base, reason);
      const plain = openOn(base, reason, false);
      if (!lost.changed || !plain.changed) throw new Error("not opened");
      const [a] = lost.next.decisions;
      const [b] = plain.next.decisions;
      expect(a?.dedupeKey).toBe("stuck:a1");
      expect(a?.dedupeKey).toBe(b?.dedupeKey);
      expect((a as { limbo?: unknown }).limbo).toEqual((b as { limbo?: unknown }).limbo);
      expect(a?.summary).toContain("回复已丢失");
      expect(a?.summary).toContain("成员可能已做完一部分");
      expect(a?.summary).toContain("先看它的分支");
      expect(a?.summary).toContain("确认它的进程已经停了");
      expect(b?.summary).not.toContain("回复已丢失");
    }
  });

  test("member-lost says it can only be cancelled; host-lost says retry or cancel", () => {
    const memberLost = openOn(record(), MEMBER_LOST_CODE);
    const hostLost = openOn(record(), HOST_LOST_CODE);
    if (!memberLost.changed || !hostLost.changed) throw new Error("not opened");
    expect(memberLost.next.decisions[0]?.summary).toContain("只能取消");
    expect(hostLost.next.decisions[0]?.summary).toContain("重试");
  });

  test("a supplement (an evidence request) only gets member-lost: its decision has no retry", () => {
    const supplement = assignment({
      evidenceRepair: {
        version: 1,
        predecessorAssignmentId: "a0",
        rootAssignmentId: "a0",
        ordinal: 1,
      },
    } as never);
    const supplemented = record({ assignments: [supplement] });
    expect(
      lostReplyKind(supplemented, supplement, { status: "idle", activeTurn: false }),
    ).toBeNull();
    expect(lostReplyKind(supplemented, supplement, { status: "closed", activeTurn: false })).toBe(
      MEMBER_LOST_CODE,
    );
    // The order of R (the end, then closed) is the same as before T9d: member-lost, never host-lost.
    for (const kind of ["closed", "archived"] as const) {
      const stopped = record({
        assignments: [supplement],
        receipts: [receipt("turn_started", 1000), receipt("turn_ended", 2000), receipt(kind, 2500)],
      });
      expect(lostReplyKind(stopped, supplement, { status: "idle", activeTurn: false }), kind).toBe(
        MEMBER_LOST_CODE,
      );
    }
    // It is still a candidate (the decision of a closed member is its way out); only the kind differs.
    expect(lostReplyCandidates(supplemented, at(AFTER))).toHaveLength(1);
  });
});

describe("the proof that the turn ended is the one the cancellation takes", () => {
  const seatsOf = [
    ["idle", { status: "idle", activeTurn: false }],
    ["closed", { status: "closed", activeTurn: false }],
    ["running", { status: "running", activeTurn: true }],
    ["idle with a turn", { status: "idle", activeTurn: true }],
    ["initializing", { status: "initializing", activeTurn: false }],
    ["unreadable", "unreadable"],
    ["absent", "absent"],
  ] as const;

  const ledgers: [string, RunEventReceipt[]][] = [
    ["start then end", [receipt("turn_started", 1000), receipt("turn_ended", 2000)]],
    ["no start, an end", [receipt("turn_ended", 2000)]],
    ["only a start", [receipt("turn_started", 1000)]],
    ["nothing", []],
    [
      "an end, then another turn",
      [
        receipt("turn_started", 1000),
        receipt("turn_ended", 2000),
        receipt("turn_started", 3000, {
          turnId: "turn-2",
          eventKey: "turn_started:agent-b1:turn-2",
        }),
      ],
    ],
    [
      "an end before the assignment",
      [receipt("turn_started", -3000), receipt("turn_ended", -2000)],
    ],
    [
      "the end of another agent",
      [
        receipt("turn_ended", 2000, {
          agentId: "agent-b2",
          eventKey: "turn_ended:agent-b2:turn-1",
        }),
      ],
    ],
  ];

  for (const turnId of [null, "turn-1", "turn-9"]) {
    for (const [name, receipts] of ledgers) {
      for (const [seatName, seat] of seatsOf) {
        test(`${name}, assignment turn ${String(turnId)}, member ${seatName}: the same answer for both`, () => {
          const base = record({ receipts, assignments: [assignment({ turnId })], waiting: true });
          const cancelPlan = planCancelFinish(base, new Map([[AGENT, seat]]));
          const proven = provenEndedTurn(base, assignment({ turnId }), seat);
          if (cancelPlan.kind === "finish") {
            expect(proven, "cancel finishes, so the end is proven").toBeDefined();
            expect(cancelPlan.close[0]?.endedEventKey).toBe(proven?.eventKey);
          } else {
            expect(proven, "cancel waits, so nothing is proven").toBeUndefined();
          }
        });
      }
    }
  }

  test("the ledger half alone says what the host's receipts say, without asking the member", () => {
    expect(latestEndedTurn(record(), assignment())?.turnId).toBe("turn-1");
    expect(
      latestEndedTurn(record({ receipts: [receipt("turn_started", 1000)] }), assignment()),
    ).toBe(undefined);
  });
});

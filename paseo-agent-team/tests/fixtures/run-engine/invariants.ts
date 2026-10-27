// One-rule-at-a-time inputs for `checkLedgerInvariants` (RE1.8). Every case is a complete ledger
// copy with exactly one deviation (or a deliberately legal edge) so a violation report can name a
// single invariant. Expected verdicts live in run-engine-matrix.md, not in this data.
import {
  AT_UPDATED,
  assignment,
  claim,
  NONCE_T2,
  NORMAL_RUN_LEDGER,
  POLICY,
  T1,
  T2,
  T3,
  task,
  withLedger,
} from "./base";
import type { InvariantCase } from "./types";

const doneWithoutReview = {
  ...T1,
  reviews: [],
};

const readyWithUnfinishedDep = {
  ...T3,
  state: "ready" as const,
  deps: ["T2"],
};

const pendingHoldsClaim = claim({ claimId: "claim-t3", taskId: "T3", path: "docs/run-engine" });

const inFlight = (id: string) =>
  task(id, `In-flight ${id}`, {
    state: "in_progress",
    phase: "implementation",
    attempts: 1,
    currentAssignmentId: `assignment-${id.toLowerCase()}-a1`,
  });

const FIVE_IN_FLIGHT = [
  inFlight("T4"),
  inFlight("T5"),
  inFlight("T6"),
  inFlight("T7"),
  inFlight("T8"),
];

export const INVARIANT_CASES: readonly InvariantCase[] = [
  {
    id: "i1-half-write-bytes",
    invariant: "I1",
    kind: "violation",
    ledger: {
      ...NORMAL_RUN_LEDGER,
      writeState: "tmp-written-not-renamed",
      rawBytes: '{"schemaVersion":1,"runId":"run-rec0re-i1","revision":9,"tasks":[',
    },
    note: "A tmp file must never be read as a committed record.",
  },
  {
    id: "i2-ready-with-unfinished-dep",
    invariant: "I2",
    kind: "violation",
    ledger: withLedger({ runId: "run-rec0re-i2", tasks: [T1, T2, readyWithUnfinishedDep] }),
    note: "T3 is ready while its dependency T2 is still in_progress.",
  },
  {
    id: "i2-pending-with-unfinished-dep",
    invariant: "I2",
    kind: "legal",
    ledger: withLedger({ runId: "run-rec0re-i2o" }),
    note: "T3 stays pending, which is the correct form while T2 is unfinished.",
  },
  {
    id: "i3-blocked-frozen-claim",
    invariant: "I3",
    kind: "legal",
    ledger: withLedger({
      runId: "run-rec0re-i3o",
      tasks: [T1, { ...T2, state: "blocked", waitingReason: "missing-seat" }, T3],
      resources: [claim({ frozen: true })],
    }),
    note: "blocked+frozen may keep a claim after the 10-27 revision.",
  },
  {
    id: "i3-pending-holds-claim",
    invariant: "I3",
    kind: "violation",
    ledger: withLedger({
      runId: "run-rec0re-i3x",
      resources: [claim(), pendingHoldsClaim],
    }),
    note: "T3 is pending yet holds a write claim.",
  },
  {
    id: "i4-review-awaiting-does-not-count",
    invariant: "I4",
    kind: "legal",
    ledger: withLedger({
      runId: "run-rec0re-i4o",
      policy: { ...POLICY, configuredConcurrency: 3 },
      tasks: [T1, { ...T2, state: "review", phase: "awaiting-rework" }, ...FIVE_IN_FLIGHT],
    }),
    note: "Five in-flight with configuredConcurrency 3: effectiveLimit=max(3,5)=5, so legal.",
  },
  {
    id: "i4-capacity-over-effective",
    invariant: "I4",
    kind: "boundary",
    ledger: withLedger({
      runId: "run-rec0re-i4x",
      policy: { ...POLICY, configuredConcurrency: 2 },
      tasks: [T1, T2, ...FIVE_IN_FLIGHT.slice(0, 4)],
    }),
    note: "Boundary: 5 in-flight with configured 2 is legal under max(); R03 decides occupancy rules.",
  },
  {
    id: "i5-nonce-replayed",
    invariant: "I5",
    kind: "violation",
    ledger: withLedger({
      runId: "run-rec0re-i5x",
      nonceRegistry: [
        ...NORMAL_RUN_LEDGER.nonceRegistry,
        { ...NORMAL_RUN_LEDGER.nonceRegistry[1], acceptedAt: AT_UPDATED },
      ],
    }),
    note: "The same nonce appears twice in the registry.",
  },
  {
    id: "i5-turn-ended-redelivered",
    invariant: "I5",
    kind: "legal",
    ledger: withLedger({
      runId: "run-rec0re-i5o",
      eventReceipts: [
        ...NORMAL_RUN_LEDGER.eventReceipts,
        { ...NORMAL_RUN_LEDGER.eventReceipts[0], receivedAt: AT_UPDATED },
      ],
    }),
    note: "Transport redelivery of one event is legal; dedupe key is unchanged.",
  },
  {
    id: "i6-rework-count-below-events",
    invariant: "I6",
    kind: "violation",
    ledger: withLedger({
      runId: "run-rec0re-i6x",
      tasks: [{ ...T2, reworkCount: 0 }],
      events: [
        ...NORMAL_RUN_LEDGER.events,
        { seq: 8, kind: "rework_started", at: AT_UPDATED, payload: { taskId: "T2" } },
        { seq: 9, kind: "rework_started", at: AT_UPDATED, payload: { taskId: "T2" } },
      ],
    }),
    note: "Two rework events exist while the counter says zero.",
  },
  {
    id: "i7-done-without-review",
    invariant: "I7",
    kind: "violation",
    ledger: withLedger({ runId: "run-rec0re-i7x", tasks: [doneWithoutReview, T2, T3] }),
    note: "T1 is done with no review record.",
  },
  {
    id: "i7-self-review",
    invariant: "I7",
    kind: "violation",
    ledger: withLedger({
      runId: "run-rec0re-i7s",
      tasks: [
        {
          ...T1,
          reviews: [
            {
              reviewerAgentId: "agent-b1",
              reviewerSeatId: "seat-b1",
              verdict: "可合入",
              reviewedRef: { kind: "git-commit", value: "9f3c1a7" },
              blockers: [],
            },
          ],
        },
        T2,
        T3,
      ],
    }),
    note: "The implementer agent/seat signed off on its own delivery.",
  },
  {
    id: "i8-assignment-without-intent",
    invariant: "I8",
    kind: "violation",
    ledger: withLedger({
      runId: "run-rec0re-i8x",
      assignments: [assignment({ nonce: NONCE_T2 })],
      outbox: [],
    }),
    note: "An assignment messageId exists with no preceding send intent.",
  },
];

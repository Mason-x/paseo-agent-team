// Ledger samples for failure, cancellation, blocking, and version edges. Each value is an input
// snapshot for R01/R05 tests; the expected reducer behavior lives in the matrix, not here.
import {
  AT_CREATED,
  AT_UPDATED,
  assignment,
  claim,
  intent,
  NONCE_CANCEL_T2,
  NONCE_T2,
  NORMAL_RUN_LEDGER,
  NOT_QUIESCENT,
  QUIESCENT,
  review,
  T1,
  T2,
  T3,
  withLedger,
} from "./base";
import type { LedgerFixture } from "./types";

/** RE1.11 / Y21: host answered `agent_request_outcome_unknown`; intent is terminal, no retry loop. */
export const OUTCOME_UNKNOWN_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-unk",
  revision: 9,
  lifecycle: "paused",
  tasks: [
    T1,
    {
      ...T2,
      status: "blocked",
      phase: "frozen",
      waitingReason: "outcome-unknown",
    },
    T3,
  ],
  resources: [
    claim({ id: "lock-t2", taskId: "T2", path: "src/t2.ts", state: "held", frozen: true }),
  ],
  assignments: [
    assignment({
      attempt: 1,
      nonce: NONCE_T2,
      messageId: "msg-t2-a1",
      revoked: false,
      quiescence: {
        turnEnded: false,
        refreshState: "missing",
        cancelReceipt: "unconfirmed",
        quiescent: false,
      },
    }),
  ],
  outbox: [
    intent({
      id: "intent-t2-a1",
      messageId: "msg-t2-a1",
      state: "outcome-unknown",
      recoverySendCount: 1,
    }),
  ],
  decisions: [
    {
      id: "dec-outcome-unknown",
      kind: "D1",
      state: "open",
      reason: "outcome-unknown: message may have been delivered",
      createdAt: AT_UPDATED,
      taskId: "T2",
      intentId: "intent-t2-a1",
    },
  ],
  alerts: [
    {
      id: "alert-outcome-unknown",
      severity: "critical",
      code: "outcome-unknown",
      message: "Send outcome unknown after one recovery attempt; frozen for a human decision.",
      taskId: "T2",
      at: AT_UPDATED,
      acked: false,
    },
  ],
});

/** RE1.10 / Y18: cancel requested; turn ended and host idle, but the cancel receipt is unconfirmed. */
export const CANCELLING_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-cnl",
  revision: 11,
  tasks: [
    T1,
    {
      ...T2,
      phase: "cancelling",
      cancellation: {
        requestId: "cancel-t2-1",
        intentId: "intent-cancel-t2",
        conditions: { ...NOT_QUIESCENT },
      },
    },
    T3,
  ],
  resources: [
    claim({ id: "lock-t2", taskId: "T2", path: "src/t2.ts", state: "held", frozen: true }),
  ],
  assignments: [
    assignment({
      attempt: 1,
      nonce: NONCE_T2,
      messageId: "msg-t2-a1",
      quiescence: { ...NOT_QUIESCENT },
    }),
  ],
  outbox: [
    intent({ id: "intent-t2-a1", messageId: "msg-t2-a1" }),
    intent({
      id: "intent-cancel-t2",
      kind: "cancel-task",
      recipient: "agent-b1",
      messageId: "msg-cancel-t2",
      semanticArgs: { taskId: "T2", requestId: "cancel-t2-1" },
      state: "sending",
    }),
  ],
  nonceRegistry: [
    ...NORMAL_RUN_LEDGER.nonceRegistry,
    {
      nonce: NONCE_CANCEL_T2,
      runId: "run-rec0re-cnl",
      taskId: "T2",
      attempt: 1,
      phase: "cancel",
      agentId: "agent-b1",
      seatId: "seat-b1",
      consumedAt: AT_UPDATED,
    },
  ],
  alerts: [
    {
      id: "alert-cancel-pending",
      severity: "warning",
      code: "cancel-unconfirmed",
      message: "Cancel receipt not confirmed; resources stay frozen.",
      taskId: "T2",
      at: AT_UPDATED,
      acked: false,
    },
  ],
});

/** RE1.10 positive form: all three conditions hold, so the release may proceed (claim reclaimed). */
export const QUIESCENT_CANCELLED_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-qsc",
  revision: 12,
  tasks: [
    T1,
    { ...T2, status: "cancelled", phase: "cancelled", waitingReason: "cancelled-by-operator" },
    T3,
  ],
  resources: [],
  assignments: [
    assignment({
      attempt: 1,
      nonce: NONCE_T2,
      messageId: "msg-t2-a1",
      revoked: true,
      quiescence: { ...QUIESCENT },
    }),
  ],
  outbox: [intent({ id: "intent-t2-a1", messageId: "msg-t2-a1", state: "confirmed" })],
});

/** RE1.8 / I3: a blocked task keeps a frozen claim; releasing it would need an explicit decision. */
export const BLOCKED_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-blk",
  revision: 8,
  lifecycle: "paused",
  tasks: [
    T1,
    {
      ...T2,
      status: "blocked",
      phase: "frozen",
      waitingReason: "missing-seat",
    },
    T3,
  ],
  resources: [
    claim({ id: "lock-t2", taskId: "T2", path: "src/t2.ts", state: "frozen", frozen: true }),
  ],
  assignments: [
    assignment({ attempt: 1, nonce: NONCE_T2, messageId: "msg-t2-a1", revoked: false }),
  ],
  decisions: [
    {
      id: "dec-missing-seat",
      kind: "D1",
      state: "open",
      reason: "no qualified A seat for T2",
      createdAt: AT_UPDATED,
      taskId: "T2",
    },
  ],
  alerts: [
    {
      id: "alert-missing-seat",
      severity: "warning",
      code: "missing-seat",
      message: "T2 waits for a qualified seat; its frozen claim is retained.",
      taskId: "T2",
      at: AT_UPDATED,
      acked: false,
    },
  ],
});

/** RE1.3 / Y15: a newer writer's record. Must stay byte-identical, read-only, and undeleted. */
export const UNKNOWN_SCHEMA_VERSION_LEDGER: LedgerFixture = withLedger({
  schemaVersion: 2,
  runId: "run-rec0re-fut",
  revision: 3,
  futureTopLevel: { engineEpoch: 7, note: "written by a newer daemon" },
  tasks: [{ ...T1, futureTaskField: { leaseMode: "async" } }, T2, T3],
});

/** RE1.12 / Y25: over the 8 MiB record cap; callers must stop writing, not truncate. */
export const OVERSIZED_LEDGER_BYTES = 9 * 1024 * 1024;

export function buildOversizedLedger(): LedgerFixture {
  const padding = "x".repeat(OVERSIZED_LEDGER_BYTES);
  return withLedger({
    runId: "run-rec0re-big",
    revision: 41,
    events: [
      ...NORMAL_RUN_LEDGER.events,
      { seq: 8, id: "evt-big", kind: "history_checkpoint", at: AT_CREATED, payload: padding },
    ],
  });
}

/** RE1.7 / RE2.8: overlong but individual fields; inputs for bounded-summary and 32 KiB rules. */
export const OVERLONG_FIELDS_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-lng",
  revision: 4,
  tasks: [
    {
      ...T1,
      title: `T${"i".repeat(120)}`,
      goal: `g${"o".repeat(2000)}`,
      evidence: [
        {
          id: "five-gates",
          command: "npm test",
          artifactKind: "command-output",
          requiresIsolatedHome: true,
        },
      ],
      reviews: [
        review({
          reviewedRef: { kind: "git-commit", value: "9f3c1a7" },
          blockers: [{ id: "b1", summary: "s".repeat(1000), path: `evidence/${"p".repeat(520)}` }],
        }),
      ],
    },
    T2,
    T3,
  ],
});

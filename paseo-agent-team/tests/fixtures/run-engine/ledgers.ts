// Ledger samples for failure, cancellation, blocking, and version edges. Each value is an input
// snapshot for R01/R05 tests; the expected reducer behavior lives in the matrix, not here.
import {
  AT_CREATED,
  AT_UPDATED,
  assignment,
  claim,
  DECISION_D1,
  DIGEST_D,
  dispatchIntent,
  INTENT_CANCEL,
  INTENT_T2,
  MESSAGE_CANCEL,
  MESSAGE_T2,
  NONCE_T2,
  NORMAL_RUN_LEDGER,
  PARTIAL_CANCELLATION,
  QUIESCENT_CANCELLATION,
  spec,
  T1,
  T2,
  T3,
  taskRecord,
  withLedger,
} from "./base";
import type { LedgerFixture, RunEffectIntent, RunTaskRecord } from "./types";

/** RE1.11 / Y21: host answered `agent_request_outcome_unknown`; intent is terminal, no retry loop. */
export const OUTCOME_UNKNOWN_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-unk",
  revision: 9,
  lifecycle: "paused",
  tasks: [T1, { ...T2, state: "blocked", waitingReason: "outcome-unknown" } as RunTaskRecord, T3],
  resources: [claim({ frozen: true, taskId: "T2" })],
  assignments: [
    assignment({
      assignmentId: "assignment-t2-a1",
      attempt: 1,
      nonce: NONCE_T2,
      messageId: MESSAGE_T2,
      state: "assigned",
      turnId: null,
    }),
  ],
  outbox: [
    dispatchIntent({
      id: INTENT_T2,
      messageId: MESSAGE_T2,
      state: "outcome-unknown",
      recoverySendCount: 1,
      confirmedAt: null,
    }),
  ],
  decisions: [
    {
      decisionId: DECISION_D1,
      category: "D1",
      state: "open",
      dedupeKey: "run-rec0re-unk|D1|outcome-unknown|intent-t2-a1",
      subjectId: "T2",
      summary: "Send outcome unknown after one recovery attempt; frozen for a human decision.",
      createdAt: AT_UPDATED,
      answeredAt: null,
    },
  ],
  alerts: [
    {
      alertId: "alert-outcome-unknown",
      state: "open",
      severity: "critical",
      summary: "Outcome unknown: message may have been delivered; do not resend.",
      createdAt: AT_UPDATED,
      acknowledgedAt: null,
      resolvedAt: null,
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
      state: "in_progress",
      phase: "implementation",
      waitingReason: "cancel-pending",
    } as RunTaskRecord,
    T3,
  ],
  resources: [claim({ frozen: true, taskId: "T2" })],
  assignments: [
    assignment({
      assignmentId: "assignment-t2-a1",
      attempt: 1,
      nonce: NONCE_T2,
      messageId: MESSAGE_T2,
      state: "in_progress",
      turnId: "turn-7",
      cancellation: PARTIAL_CANCELLATION,
    }),
  ],
  outbox: [
    dispatchIntent({ id: INTENT_T2, messageId: MESSAGE_T2 }),
    {
      id: INTENT_CANCEL,
      kind: "wake",
      recipient: "agent-b1",
      messageId: MESSAGE_CANCEL,
      idempotencyKey: "cancel-T2-1",
      payloadHash: DIGEST_D,
      templateVersion: 1,
      state: "sending",
      recoverySendCount: 0,
      createdAt: AT_UPDATED,
      confirmedAt: null,
      taskId: "T2",
      assignmentId: "assignment-t2-a1",
      semanticArgs: { reason: "cancel", requestId: "cancel-t2-1" },
    } satisfies RunEffectIntent,
  ],
  alerts: [
    {
      alertId: "alert-cancel-pending",
      state: "open",
      severity: "warning",
      summary: "Cancel receipt not confirmed; resources stay frozen.",
      createdAt: AT_UPDATED,
      acknowledgedAt: null,
      resolvedAt: null,
    },
  ],
});

/** RE1.10 positive form: all three conditions hold, so the release may proceed (claim reclaimed). */
export const QUIESCENT_CANCELLED_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-qsc",
  revision: 12,
  tasks: [
    T1,
    { ...T2, state: "cancelled", waitingReason: "cancelled-by-operator" } as RunTaskRecord,
    T3,
  ],
  resources: [],
  assignments: [
    assignment({
      assignmentId: "assignment-t2-a1",
      attempt: 1,
      nonce: NONCE_T2,
      messageId: MESSAGE_T2,
      state: "cancelled",
      turnId: "turn-7",
      endedAt: AT_UPDATED,
      cancellation: QUIESCENT_CANCELLATION,
    }),
  ],
  outbox: [dispatchIntent({ id: INTENT_T2, messageId: MESSAGE_T2, state: "confirmed" })],
});

/** RE1.8 / I3: a blocked task keeps a frozen claim; releasing it would need an explicit decision. */
export const BLOCKED_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-blk",
  revision: 8,
  lifecycle: "paused",
  tasks: [T1, { ...T2, state: "blocked", waitingReason: "missing-seat" } as RunTaskRecord, T3],
  resources: [claim({ frozen: true, taskId: "T2" })],
  assignments: [
    assignment({
      assignmentId: "assignment-t2-a1",
      attempt: 1,
      nonce: NONCE_T2,
      messageId: MESSAGE_T2,
      state: "assigned",
    }),
  ],
  decisions: [
    {
      decisionId: DECISION_D1,
      category: "D1",
      state: "open",
      dedupeKey: "run-rec0re-blk|D1|missing-seat|T2",
      subjectId: "T2",
      summary: "No qualified A seat for T2; the frozen claim is retained.",
      createdAt: AT_UPDATED,
      answeredAt: null,
    },
  ],
  alerts: [
    {
      alertId: "alert-missing-seat",
      state: "open",
      severity: "warning",
      summary: "T2 waits for a qualified seat; its frozen claim is retained.",
      createdAt: AT_UPDATED,
      acknowledgedAt: null,
      resolvedAt: null,
    },
  ],
});

/** RE1.3 / Y15: a newer writer's record. Must stay byte-identical, read-only, and undeleted. */
export const UNKNOWN_SCHEMA_VERSION_RECORD: unknown = {
  ...NORMAL_RUN_LEDGER,
  schemaVersion: 2,
  futureTopLevel: { engineEpoch: 7, note: "written by a newer daemon" },
  tasks: [
    { ...NORMAL_RUN_LEDGER.tasks[0], futureTaskField: { leaseMode: "async" } },
    ...NORMAL_RUN_LEDGER.tasks.slice(1),
  ],
};

/** RE1.12 / Y25: over the 8 MiB record cap; callers must stop writing, not truncate. */
export const OVERSIZED_LEDGER_BYTES = 9 * 1024 * 1024;

export function buildOversizedLedger(): LedgerFixture {
  const padding = "x".repeat(OVERSIZED_LEDGER_BYTES);
  return withLedger({
    runId: "run-rec0re-big",
    revision: 41,
    events: [
      ...NORMAL_RUN_LEDGER.events,
      { seq: 8, kind: "history_checkpoint", at: AT_CREATED, payload: { pad: padding } },
    ],
  });
}

/** RE1.7 / RE2.8: overlong fields; the schema rejects this record (input for rejection cases). */
export const OVERLONG_FIELDS_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-lng",
  revision: 4,
  tasks: [
    taskRecord(
      spec("T1", `T${"i".repeat(120)}`, {
        goal: `g${"o".repeat(2000)}`,
        acceptance: ["a".repeat(501)],
        scopes: [
          {
            repoId: "repo-re-verify",
            kind: "file",
            path: `src/${"p".repeat(520)}`,
            access: "write",
          },
        ],
      }),
      { state: "done" },
    ),
    T2,
    T3,
  ],
});

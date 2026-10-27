// omp `closed` is a resting state, not an error. These ledgers pin the two classifications and the
// reopen intent whose success is a later `turn_started`, never the send acknowledgement.
import {
  AT_CREATED,
  AT_UPDATED,
  assignment,
  claim,
  DECISION_D1,
  dispatchIntent,
  MESSAGE_REOPEN,
  MESSAGE_T2,
  NONCE_T2,
  PROFILE_HAIKU,
  reopenIntent,
  T1,
  T2,
  T3,
  withLedger,
} from "./base";
import type { LedgerFixture, RunReopenGrant, RunTaskRecord } from "./types";

const GRANT_ISSUED: RunReopenGrant = {
  grantId: "reopen-grant-t2",
  seatId: "seat-b1",
  agentId: "agent-b1",
  intentId: "intent-reopen-t2",
  messageId: MESSAGE_REOPEN,
  status: "issued",
  createdAt: AT_UPDATED,
  expiresAt: "2026-10-27T12:44:56.000Z",
  consumedAt: null,
};

const GRANT_CONSUMED: RunReopenGrant = {
  ...GRANT_ISSUED,
  status: "consumed",
  consumedAt: AT_UPDATED,
};

/** RE4.10 / Y20: report already received, then the agent closes. Review must continue. */
export const CLOSED_AFTER_REPORT_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-clr",
  revision: 13,
  tasks: [
    T1,
    {
      ...T2,
      state: "review",
      phase: "review",
      ref: { kind: "git-commit", value: "4c8d2e1" },
      changedFiles: ["src/t2.ts"],
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
      state: "ended",
      turnId: "turn-7",
      startedAt: AT_CREATED,
      endedAt: AT_UPDATED,
    }),
  ],
  eventReceipts: [
    {
      eventKey: "agent-b1|turn-7|turn_ended",
      kind: "turn_ended",
      agentId: "agent-b1",
      turnId: "turn-7",
      seq: 7,
      receivedAt: AT_UPDATED,
      dedupeKey: "agent-b1|turn-7|turn_ended",
      disposition: "accepted",
    },
  ],
  roster: [
    {
      seatId: "seat-s1",
      tier: "S",
      agentId: "agent-s1",
      channelId: "claude",
      duties: ["coordinate"],
      enabled: true,
    },
    {
      seatId: "seat-b1",
      tier: "B",
      agentId: "agent-b1",
      channelId: PROFILE_HAIKU.channelId,
      duties: ["implement"],
      enabled: true,
      observedState: "closed",
    },
    {
      seatId: "seat-b2",
      tier: "B",
      agentId: "agent-b2",
      channelId: "claude",
      duties: ["review"],
      enabled: true,
    },
  ],
  decisions: [],
});

/** RE4.10 / Y20: assigned but closed before any report. Blocked + D1, attempts unchanged. */
export const CLOSED_WHILE_ASSIGNED_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-cla",
  revision: 17,
  lifecycle: "paused",
  tasks: [
    T1,
    {
      ...T2,
      state: "blocked",
      phase: "implementation",
      waitingReason: "closed-while-assigned-without-report",
      ref: null,
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
      state: "assigned",
      turnId: null,
      reopenGrantId: GRANT_ISSUED.grantId,
    }),
  ],
  reopenGrants: [GRANT_ISSUED],
  outbox: [
    dispatchIntent({ id: "intent-t2-a1", messageId: MESSAGE_T2, state: "confirmed" }),
    reopenIntent({ id: "intent-reopen-t2", state: "prepared" }),
  ],
  counters: { observationSeq: 7, eventsThroughSeq: 7, probeAttempts: 0, reopenAttempts: 1 },
  roster: [
    {
      seatId: "seat-s1",
      tier: "S",
      agentId: "agent-s1",
      channelId: "claude",
      duties: ["coordinate"],
      enabled: true,
    },
    {
      seatId: "seat-b1",
      tier: "B",
      agentId: "agent-b1",
      channelId: PROFILE_HAIKU.channelId,
      duties: ["implement"],
      enabled: true,
      observedState: "closed",
    },
    {
      seatId: "seat-b2",
      tier: "B",
      agentId: "agent-b2",
      channelId: "claude",
      duties: ["review"],
      enabled: true,
    },
  ],
  decisions: [
    {
      decisionId: DECISION_D1,
      category: "D1",
      state: "open",
      dedupeKey: "run-rec0re-cla|D1|closed-while-assigned|T2",
      subjectId: "T2",
      summary: "Agent closed while assigned and no report arrived; work attempt is unchanged.",
      createdAt: AT_UPDATED,
      answeredAt: null,
    },
  ],
  alerts: [
    {
      alertId: "alert-closed-while-assigned",
      state: "open",
      severity: "critical",
      summary: "Reopen failed or not attempted; work attempt is unchanged.",
      createdAt: AT_UPDATED,
      acknowledgedAt: null,
      resolvedAt: null,
    },
  ],
});

/** RE4.10 success shape: the reopen intent is followed by a correlated turn_started. */
export const REOPEN_STARTED_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-rpn",
  revision: 18,
  tasks: [T1, { ...T2, state: "in_progress", phase: "implementation" } as RunTaskRecord, T3],
  assignments: [
    assignment({
      assignmentId: "assignment-t2-a2",
      attempt: 1,
      nonce: NONCE_T2,
      messageId: MESSAGE_T2,
      state: "in_progress",
      turnId: "turn-9",
      startedAt: AT_UPDATED,
      reopenGrantId: GRANT_CONSUMED.grantId,
    }),
  ],
  reopenGrants: [GRANT_CONSUMED],
  outbox: [
    reopenIntent({ id: "intent-reopen-t2", state: "confirmed", confirmedAt: AT_UPDATED }),
    dispatchIntent({ id: "intent-t2-a1", messageId: MESSAGE_T2, state: "confirmed" }),
  ],
  counters: { observationSeq: 9, eventsThroughSeq: 7, probeAttempts: 0, reopenAttempts: 1 },
  eventReceipts: [
    {
      eventKey: "agent-b1|turn-9|turn_started",
      kind: "turn_started",
      agentId: "agent-b1",
      turnId: "turn-9",
      seq: 8,
      receivedAt: AT_UPDATED,
      dedupeKey: "agent-b1|turn-9|turn_started",
      disposition: "accepted",
    },
  ],
  decisions: [],
});

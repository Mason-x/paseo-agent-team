// omp `closed` is a resting state, not an error. These ledgers pin the two classifications and the
// reopen intent whose success is a later `turn_started`, never the send acknowledgement.
import {
  AT_CREATED,
  AT_UPDATED,
  assignment,
  assignmentsForRun,
  claim,
  DECISION_D1,
  dispatchIntent,
  MESSAGE_REOPEN,
  MESSAGE_T2,
  NONCE_T2,
  NORMAL_RUN_LEDGER,
  noncesForRun,
  PROFILE_HAIKU,
  reopenIntent,
  t1,
  t2,
  t3,
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
  nonceRegistry: noncesForRun("run-rec0re-clr").map((entry) =>
    entry.assignmentId === "assignment-t2-a1"
      ? { ...entry, acceptedAt: AT_UPDATED, acceptedEventKey: "proof:assignment-t2-a1" }
      : entry,
  ),
  revision: 13,
  tasks: [
    t1,
    {
      ...t2,
      state: "review",
      phase: "review",
      ref: { kind: "git-commit", value: "4c8d2e1" },
      changedFiles: ["src/t2.ts"],
    } as RunTaskRecord,
    t3,
  ],
  resources: [claim({ frozen: true, taskId: "t2" })],
  assignments: assignmentsForRun("run-rec0re-clr").map((entry) =>
    entry.assignmentId === "assignment-t2-a1"
      ? {
          ...entry,
          state: "ended",
          turnId: "turn-7",
          startedAt: AT_CREATED,
          endedAt: AT_UPDATED,
          endedEventKey: "agent-b1|turn-7|turn_ended",
          acceptedProof: {
            protocolVersion: 1,
            runId: "run-rec0re-clr",
            taskId: "t2",
            attempt: 1,
            nonce: NONCE_T2,
            assignmentId: "assignment-t2-a1",
            messageId: MESSAGE_T2,
            status: "done",
            changedFiles: ["src/t2.ts"],
            ref: { kind: "git-commit", value: "4c8d2e1" },
            workspace: {
              id: "ws-run-rec0re-a1-t2",
              branch: "re-rec0rea1-t2-a1-1",
              baseRef: "main",
            },
            evidence: [
              {
                id: "five-gates",
                command: "npm run check && npm run typecheck && npm test",
                exitCode: 0,
                summary: "all gates passed",
                artifactPath: "evidence/t2.log",
                ref: { kind: "git-commit", value: "4c8d2e1" },
              },
            ],
          },
        }
      : entry,
  ),
  eventReceipts: [...NORMAL_RUN_LEDGER.eventReceipts],
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
      tier: "A",
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
  nonceRegistry: noncesForRun("run-rec0re-cla"),
  revision: 17,
  lifecycle: "paused",
  tasks: [
    t1,
    {
      ...t2,
      state: "blocked",
      phase: "implementation",
      waitingReason: "closed-while-assigned-without-report",
      ref: null,
    } as RunTaskRecord,
    t3,
  ],
  resources: [claim({ frozen: true, taskId: "t2" })],
  assignments: assignmentsForRun("run-rec0re-cla").map((entry) =>
    entry.assignmentId === "assignment-t2-a1"
      ? {
          ...entry,
          state: "assigned",
          turnId: null,
          reopenGrantId: GRANT_ISSUED.grantId,
        }
      : entry,
  ),
  reopenGrants: [GRANT_ISSUED],
  outbox: [
    ...NORMAL_RUN_LEDGER.outbox,
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
      tier: "A",
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
      controlNonceDigest: "e".repeat(64),
      state: "open",
      answer: null,
      dedupeKey: "run-rec0re-cla|D1|closed-while-assigned|t2",
      subjectId: "t2",
      summary: "Agent closed while assigned and no report arrived; work attempt is unchanged.",
      createdAt: AT_UPDATED,
      answeredAt: null,

      cancelIntents: null,
      resolution: null,
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
  nonceRegistry: noncesForRun("run-rec0re-rpn"),
  revision: 18,
  tasks: [t1, { ...t2, state: "in_progress", phase: "implementation" } as RunTaskRecord, t3],
  resources: [claim({ originAssignmentId: "assignment-t2-a2" })],
  assignments: [
    ...assignmentsForRun("run-rec0re-rpn").filter((entry) => entry.taskId !== "t2"),
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
    ...NORMAL_RUN_LEDGER.outbox.filter((entry) => entry.taskId !== "t2"),
    reopenIntent({ id: "intent-reopen-t2", state: "confirmed", confirmedAt: AT_UPDATED }),
    dispatchIntent({
      id: "intent-t2-a2",
      assignmentId: "assignment-t2-a2",
      messageId: MESSAGE_T2,
      idempotencyKey: "dispatch-t2-a2",
      state: "confirmed",
      confirmedAt: AT_UPDATED,
    }),
  ],
  counters: { observationSeq: 9, eventsThroughSeq: 7, probeAttempts: 0, reopenAttempts: 1 },
  eventReceipts: [
    ...NORMAL_RUN_LEDGER.eventReceipts,
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

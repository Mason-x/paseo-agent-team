// omp `closed` is a resting state, not an error. These ledgers pin the two classifications and the
// reopen intent whose success is a later `turn_started`, never the send acknowledgement.
import {
  AT_CREATED,
  AT_UPDATED,
  assignment,
  intent,
  NONCE_T2,
  PROFILE_HAIKU,
  QUIESCENT,
  T1,
  T2,
  T3,
  withLedger,
} from "./base";
import type { LedgerFixture } from "./types";

/** RE4.10 / Y20: report already received, then the agent closes. Review must continue. */
export const CLOSED_AFTER_REPORT_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-clr",
  revision: 13,
  tasks: [
    T1,
    {
      ...T2,
      status: "review",
      phase: "review",
      ref: { kind: "git-commit", value: "4c8d2e1" },
    },
    T3,
  ],
  resources: [
    {
      id: "lock-t2",
      repoId: "repo-re-verify",
      kind: "file",
      path: "src/t2.ts",
      taskId: "T2",
      access: "write",
      state: "held",
      frozen: true,
    },
  ],
  assignments: [
    assignment({
      attempt: 1,
      nonce: NONCE_T2,
      messageId: "msg-t2-a1",
      turnId: "turn-7",
      quiescence: { ...QUIESCENT },
    }),
  ],
  eventReceipts: [
    {
      key: "agent-b1|turn-7|turn_ended",
      agentId: "agent-b1",
      turnId: "turn-7",
      kind: "turn_ended",
      outcome: "completed",
      seenAt: AT_UPDATED,
      digest: `sha256:${"6".repeat(64)}`,
    },
  ],
  roster: [
    {
      seatId: "seat-s1",
      tier: "S",
      roleId: "lead-orchestrator",
      agentId: "agent-s1",
      state: "idle",
    },
    { seatId: "seat-b1", tier: "B", roleId: "eng-fullstack", agentId: "agent-b1", state: "closed" },
    { seatId: "seat-b2", tier: "B", roleId: "qa-review", agentId: "agent-b2", state: "idle" },
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
      status: "blocked",
      phase: "frozen",
      waitingReason: "closed-while-assigned-without-report",
      ref: null,
    },
    T3,
  ],
  resources: [
    {
      id: "lock-t2",
      repoId: "repo-re-verify",
      kind: "file",
      path: "src/t2.ts",
      taskId: "T2",
      access: "write",
      state: "held",
      frozen: true,
    },
  ],
  assignments: [
    assignment({
      attempt: 1,
      nonce: NONCE_T2,
      messageId: "msg-t2-a1",
      turnId: null,
      revoked: false,
      reopenGranted: false,
      quiescence: {
        turnEnded: false,
        refreshState: "closed",
        cancelReceipt: "not-sent",
        quiescent: false,
      },
    }),
  ],
  outbox: [
    intent({
      id: "intent-t2-a1",
      messageId: "msg-t2-a1",
      state: "confirmed",
      confirmedAt: AT_CREATED,
    }),
    intent({
      id: "intent-reopen-t2",
      kind: "reopen-session",
      recipient: "agent-b1",
      messageId: "msg-reopen-t2",
      semanticArgs: { taskId: "T2", reason: "closed-while-assigned" },
      state: "prepared",
    }),
  ],
  roster: [
    {
      seatId: "seat-s1",
      tier: "S",
      roleId: "lead-orchestrator",
      agentId: "agent-s1",
      state: "idle",
    },
    { seatId: "seat-b1", tier: "B", roleId: "eng-fullstack", agentId: "agent-b1", state: "closed" },
    { seatId: "seat-b2", tier: "B", roleId: "qa-review", agentId: "agent-b2", state: "idle" },
  ],
  decisions: [
    {
      id: "dec-closed-while-assigned",
      kind: "D1",
      state: "open",
      reason: "agent closed while assigned and no report arrived",
      createdAt: AT_UPDATED,
      taskId: "T2",
    },
  ],
  alerts: [
    {
      id: "alert-closed-while-assigned",
      severity: "critical",
      code: "closed-while-assigned",
      message: "Reopen failed or not attempted; work attempt is unchanged.",
      taskId: "T2",
      at: AT_UPDATED,
      acked: false,
    },
  ],
});

/** RE4.10 success shape: the reopen intent is followed by a correlated turn_started. */
export const REOPEN_STARTED_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-rpn",
  revision: 18,
  tasks: [T1, { ...T2, status: "in_progress", phase: "implement" }, T3],
  assignments: [
    assignment({
      attempt: 1,
      nonce: NONCE_T2,
      messageId: "msg-t2-a1",
      turnId: "turn-9",
      reopenGranted: true,
      quiescence: { ...QUIESCENT },
    }),
  ],
  outbox: [
    intent({
      id: "intent-reopen-t2",
      kind: "reopen-session",
      recipient: PROFILE_HAIKU.channelId,
      messageId: "msg-reopen-t2",
      semanticArgs: { taskId: "T2", reason: "closed-while-assigned" },
      state: "confirmed",
      confirmedAt: AT_UPDATED,
    }),
    intent({
      id: "intent-t2-a1",
      messageId: "msg-t2-a1",
      state: "confirmed",
      confirmedAt: AT_CREATED,
    }),
  ],
  eventReceipts: [
    {
      key: "agent-b1|turn-9|turn_started",
      agentId: "agent-b1",
      turnId: "turn-9",
      kind: "turn_started",
      seenAt: AT_UPDATED,
      digest: `sha256:${"7".repeat(64)}`,
    },
  ],
  decisions: [],
});

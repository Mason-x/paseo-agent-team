// Counter caps (protocol resend / evidence return / rework / total attempts / budget) and the
// channel-probe lifecycle. These are inputs for cap, escalation, and probe-uniqueness cases.
import {
  AT_UPDATED,
  attempt,
  intent,
  NONCE_PROBE,
  PROFILE_HAIKU,
  T1,
  T2,
  T3,
  withLedger,
} from "./base";
import type { LedgerFixture } from "./types";

const SIX_ATTEMPTS = [1, 2, 3, 4, 5, 6].map((n) =>
  attempt({
    attempt: n,
    nonce: `6f1c2a44-3b7e-4f0a-9a11-00000000010${n}`,
    status: n === 6 ? "in_progress" : "superseded",
  }),
);

/** RE2.3 / RE5.1 / RE5.2 / Y9: every counter already sits at its cap. */
export const CONTROL_ATTEMPTS_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-ctl",
  revision: 21,
  tasks: [
    { ...T1, protocolFailures: 2, status: "blocked", phase: "frozen" },
    { ...T2, evidenceReturns: 3, reworkCount: 2, status: "review", phase: "awaiting-rework" },
    { ...T3, deps: [], attempts: SIX_ATTEMPTS, status: "in_progress", phase: "implement" },
  ],
  resources: [
    {
      id: "lock-t3",
      repoId: "repo-re-verify",
      kind: "file",
      path: "src/docs/run-engine",
      taskId: "T3",
      access: "write",
      state: "held",
      frozen: false,
    },
  ],
  budgets: {
    strategic: { seatId: "seat-s1", limit: 12, reserved: 10, confirmed: 9 },
    seats: [
      {
        seatId: "seat-s1",
        limit: 12,
        reserved: 10,
        confirmed: 9,
        observedTurns: 8,
        partial: false,
      },
      { seatId: "seat-b1", limit: 6, reserved: 6, confirmed: 4, observedTurns: 3, partial: false },
    ],
  },
  decisions: [
    {
      id: "dec-budget-80-100-sts",
      kind: "D4",
      state: "open",
      reason: "seat-b1 reached 80% and 100% in one revision",
      createdAt: AT_UPDATED,
      seatId: "seat-b1",
      threshold: [80, 100],
      merged: true,
    },
  ],
  alerts: [
    {
      id: "alert-budget-sts",
      severity: "warning",
      code: "budget-threshold",
      message: "80% and 100% merged into one D4; no new intent may be submitted.",
      taskId: null,
      at: AT_UPDATED,
      acked: false,
    },
  ],
});

/** RE5.5 / Y19 input: the recovery window has passed and no probe is in flight anywhere. */
export const PROBE_ELIGIBLE_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-pbe",
  revision: 22,
  lifecycle: "paused",
  channels: [
    {
      channelId: "claude",
      provider: "claude",
      state: "paused",
      pausedReason: "quota",
      unavailableUntil: "2026-10-27T12:30:00.000Z",
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
    { seatId: "seat-b1", tier: "B", roleId: "eng-fullstack", agentId: "agent-b1", state: "idle" },
    { seatId: "seat-b2", tier: "B", roleId: "qa-review", agentId: "agent-b2", state: "idle" },
  ],
  tasks: [T1],
  resources: [],
  assignments: [],
  outbox: [],
  eventReceipts: [],
  decisions: [],
});

/** RE5.5 negative form: an in-flight turn on the same channel makes probeEligible false. */
export const PROBE_BLOCKED_INFLIGHT_TURN_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-pbt",
  revision: 22,
  lifecycle: "paused",
  channels: [
    {
      channelId: "claude",
      provider: "claude",
      state: "paused",
      pausedReason: "quota",
      unavailableUntil: "2026-10-27T12:30:00.000Z",
    },
  ],
  outbox: [],
  decisions: [],
});

/** RE5.5: the only probe is already sending; a second Run must not send another. */
export const PROBE_IN_FLIGHT_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-pbf",
  revision: 23,
  lifecycle: "paused",
  channels: [
    {
      channelId: "claude",
      provider: "claude",
      state: "paused",
      pausedReason: "quota",
      unavailableUntil: "2026-10-27T12:30:00.000Z",
    },
  ],
  outbox: [
    intent({
      id: "intent-probe-inflight",
      kind: "probe-channel",
      recipient: PROFILE_HAIKU.channelId,
      messageId: "msg-probe-inflight",
      state: "sending",
      semanticArgs: { channelId: "claude", reason: "unavailableUntil reached" },
    }),
  ],
  nonceRegistry: [
    {
      nonce: NONCE_PROBE,
      runId: "run-rec0re-pbf",
      taskId: "_probe",
      attempt: 1,
      phase: "probe",
      agentId: "agent-s1",
      seatId: "seat-s1",
      consumedAt: AT_UPDATED,
    },
  ],
});

/** RE5.5: success is the correlated turn_ended(completed); send acceptance alone is not enough. */
export const PROBE_COMPLETED_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-pbx",
  revision: 24,
  lifecycle: "paused",
  channels: [
    {
      channelId: "claude",
      provider: "claude",
      state: "paused",
      pausedReason: "quota",
      unavailableUntil: "2026-10-27T12:30:00.000Z",
    },
  ],
  eventReceipts: [
    {
      key: "agent-s1|turn-probe-1|turn_ended",
      agentId: "agent-s1",
      turnId: "turn-probe-1",
      kind: "turn_ended",
      outcome: "completed",
      seenAt: AT_UPDATED,
      digest: `sha256:${"8".repeat(64)}`,
    },
  ],
  outbox: [
    intent({
      id: "intent-probe-done",
      kind: "probe-channel",
      recipient: PROFILE_HAIKU.channelId,
      messageId: "msg-probe-done",
      state: "confirmed",
      confirmedAt: AT_UPDATED,
      semanticArgs: { channelId: "claude", reason: "unavailableUntil reached" },
    }),
  ],
});

/** RE5.5 failure: send accepted, then the turn failed. until is cleared, never auto-renewed. */
export const PROBE_FAILED_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-pby",
  revision: 25,
  lifecycle: "paused",
  channels: [
    {
      channelId: "claude",
      provider: "claude",
      state: "paused",
      pausedReason: "probe-failed",
      unavailableUntil: null,
    },
  ],
  eventReceipts: [
    {
      key: "agent-s1|turn-probe-2|turn_ended",
      agentId: "agent-s1",
      turnId: "turn-probe-2",
      kind: "turn_ended",
      outcome: "failed",
      seenAt: AT_UPDATED,
      digest: `sha256:${"9".repeat(64)}`,
    },
  ],
  outbox: [
    intent({
      id: "intent-probe-failed",
      kind: "probe-channel",
      recipient: PROFILE_HAIKU.channelId,
      messageId: "msg-probe-failed",
      state: "confirmed",
      confirmedAt: AT_UPDATED,
      semanticArgs: { channelId: "claude", reason: "unavailableUntil reached" },
    }),
  ],
  alerts: [
    {
      id: "alert-probe-failed",
      severity: "warning",
      code: "probe-failed",
      message: "Probe ended without completion; channel stays paused and until is empty.",
      taskId: null,
      at: AT_UPDATED,
      acked: false,
    },
  ],
});

/** RE5.5 unknown: no correlated turn_ended; the channel must stay paused (Y19). */
export const PROBE_UNKNOWN_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-pbz",
  revision: 26,
  lifecycle: "paused",
  channels: [
    {
      channelId: "claude",
      provider: "claude",
      state: "paused",
      pausedReason: "probe-unknown",
      unavailableUntil: "2026-10-27T12:30:00.000Z",
    },
  ],
  outbox: [
    intent({
      id: "intent-probe-unknown",
      kind: "probe-channel",
      recipient: PROFILE_HAIKU.channelId,
      messageId: "msg-probe-unknown",
      state: "outcome-unknown",
      recoverySendCount: 1,
      semanticArgs: { channelId: "claude", reason: "unavailableUntil reached" },
    }),
  ],
  alerts: [
    {
      id: "alert-probe-unknown",
      severity: "warning",
      code: "probe-unknown",
      message: "Probe outcome unknown; channel remains paused.",
      taskId: null,
      at: AT_UPDATED,
      acked: false,
    },
  ],
});

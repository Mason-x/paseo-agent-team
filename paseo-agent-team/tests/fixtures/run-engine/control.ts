// Counter caps (protocol resend / evidence return / rework / total attempts / budget) and the
// channel-probe lifecycle. These are inputs for cap, escalation, and probe-uniqueness cases.
import {
  AT_UPDATED,
  claim,
  DECISION_D4,
  PROFILE_HAIKU,
  probeIntent,
  spec,
  T1,
  T2,
  taskRecord,
  withLedger,
} from "./base";
import type { ChannelFixture, LedgerFixture, RunTaskRecord } from "./types";

function pausedChannel(until: string | null, incidentId = "incident-claude-1"): ChannelFixture {
  return {
    channelId: "claude",
    profileIds: [PROFILE_HAIKU.id],
    state: "paused",
    unavailableUntil: until,
    scope: "channel",
    source: "structured-error",
    code: "quota",
    observedAt: AT_UPDATED,
    incidentId,
    revision: 2,
  };
}

/** RE2.3 / RE5.1 / RE5.2 / Y9: every counter already sits at its cap. */
export const CONTROL_ATTEMPTS_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-ctl",
  revision: 21,
  tasks: [
    {
      ...T1,
      state: "blocked",
      waitingReason: "protocol-failures-exhausted",
      protocolFailures: 2,
    } as RunTaskRecord,
    {
      ...T2,
      state: "review",
      phase: "awaiting-rework",
      evidenceReturns: 3,
      reworkCount: 2,
    } as RunTaskRecord,
    {
      ...taskRecord(spec("T3", "Docs"), {
        state: "in_progress",
        phase: "implementation",
        attempts: 6,
      }),
    },
  ],
  resources: [claim({ claimId: "claim-t3", taskId: "T3", path: "docs/run-engine" })],
  budgets: {
    entries: [
      {
        scope: "seat",
        subjectId: "seat-s1",
        limit: 12,
        reserved: 10,
        confirmed: 9,
        observedTurns: 8,
      },
      {
        scope: "seat",
        subjectId: "seat-b1",
        limit: 6,
        reserved: 6,
        confirmed: 4,
        observedTurns: 3,
      },
    ],
  },
  decisions: [
    {
      decisionId: DECISION_D4,
      category: "D4",
      state: "open",
      dedupeKey: "run-rec0re-ctl|D4|seat-b1|budget-100",
      subjectId: "seat-b1",
      summary: "seat-b1 reached 80% and 100% in one revision; one merged decision.",
      createdAt: AT_UPDATED,
      answeredAt: null,
    },
  ],
  alerts: [
    {
      alertId: "alert-budget-sts",
      state: "open",
      severity: "warning",
      summary: "80% and 100% merged into one D4; no new intent may be submitted.",
      createdAt: AT_UPDATED,
      acknowledgedAt: null,
      resolvedAt: null,
    },
  ],
});

/** RE5.5 / Y19 input: the recovery window has passed and no probe is in flight anywhere. */
export const PROBE_ELIGIBLE_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-pbe",
  revision: 22,
  lifecycle: "paused",
  channels: [pausedChannel("2026-10-27T12:30:00.000Z")],
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
      channelId: "claude",
      duties: ["implement"],
      enabled: true,
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
  tasks: [T1],
  resources: [],
  assignments: [],
  outbox: [],
  eventReceipts: [],
  counters: { observationSeq: 0, eventsThroughSeq: 0, probeAttempts: 0, reopenAttempts: 0 },
  decisions: [],
});

/** RE5.5 negative form: an in-flight turn on the same channel makes probeEligible false. */
export const PROBE_BLOCKED_INFLIGHT_TURN_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-pbt",
  revision: 22,
  lifecycle: "paused",
  channels: [pausedChannel("2026-10-27T12:30:00.000Z")],
  outbox: [],
  decisions: [],
});

/** RE5.5: the only probe is already sending; a second Run must not send another. */
export const PROBE_IN_FLIGHT_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-pbf",
  revision: 23,
  lifecycle: "paused",
  channels: [pausedChannel("2026-10-27T12:30:00.000Z")],
  outbox: [
    probeIntent({
      id: "intent-probe-inflight",
      messageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      idempotencyKey: "probe-claude-inflight",
      state: "sending",
    }),
  ],
  counters: { observationSeq: 7, eventsThroughSeq: 7, probeAttempts: 1, reopenAttempts: 0 },
});

/** RE5.5: success is the correlated turn_ended(completed); send acceptance alone is not enough. */
export const PROBE_COMPLETED_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-pbx",
  revision: 24,
  lifecycle: "paused",
  channels: [pausedChannel("2026-10-27T12:30:00.000Z")],
  eventReceipts: [
    {
      eventKey: "agent-s1|turn-probe-1|turn_ended",
      kind: "turn_ended",
      agentId: "agent-s1",
      turnId: "turn-probe-1",
      seq: 8,
      receivedAt: AT_UPDATED,
      dedupeKey: "agent-s1|turn-probe-1|turn_ended",
      disposition: "accepted",
    },
  ],
  outbox: [
    probeIntent({
      id: "intent-probe-done",
      messageId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      idempotencyKey: "probe-claude-done",
      state: "confirmed",
      confirmedAt: AT_UPDATED,
    }),
  ],
  counters: { observationSeq: 8, eventsThroughSeq: 7, probeAttempts: 1, reopenAttempts: 0 },
});

/** RE5.5 failure: send accepted, then the turn failed. until is cleared, never auto-renewed. */
export const PROBE_FAILED_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-pby",
  revision: 25,
  lifecycle: "paused",
  channels: [pausedChannel(null, "incident-claude-2")],
  eventReceipts: [
    {
      eventKey: "agent-s1|turn-probe-2|turn_ended",
      kind: "turn_ended",
      agentId: "agent-s1",
      turnId: "turn-probe-2",
      seq: 8,
      receivedAt: AT_UPDATED,
      dedupeKey: "agent-s1|turn-probe-2|turn_ended",
      disposition: "accepted",
    },
  ],
  outbox: [
    probeIntent({
      id: "intent-probe-failed",
      messageId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      idempotencyKey: "probe-claude-failed",
      state: "confirmed",
      confirmedAt: AT_UPDATED,
    }),
  ],
  counters: { observationSeq: 8, eventsThroughSeq: 7, probeAttempts: 1, reopenAttempts: 0 },
  alerts: [
    {
      alertId: "alert-probe-failed",
      state: "open",
      severity: "warning",
      summary: "Probe ended without completion; channel stays paused and until is empty.",
      createdAt: AT_UPDATED,
      acknowledgedAt: null,
      resolvedAt: null,
    },
  ],
});

/** RE5.5 unknown: no correlated turn_ended; the channel must stay paused (Y19). */
export const PROBE_UNKNOWN_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-pbz",
  revision: 26,
  lifecycle: "paused",
  channels: [pausedChannel("2026-10-27T12:30:00.000Z", "incident-claude-3")],
  outbox: [
    probeIntent({
      id: "intent-probe-unknown",
      messageId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      idempotencyKey: "probe-claude-unknown",
      state: "outcome-unknown",
      recoverySendCount: 1,
      confirmedAt: null,
    }),
  ],
  counters: { observationSeq: 7, eventsThroughSeq: 7, probeAttempts: 1, reopenAttempts: 0 },
  alerts: [
    {
      alertId: "alert-probe-unknown",
      state: "open",
      severity: "warning",
      summary: "Probe outcome unknown; channel remains paused.",
      createdAt: AT_UPDATED,
      acknowledgedAt: null,
      resolvedAt: null,
    },
  ],
});

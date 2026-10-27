// Cross-Run resource inputs: file claims, the root write lock, and one shared channel probe.
// The index must grant at most one of these; a corrupt holder freezes new grants (RE1.14).
import {
  AT_CREATED,
  AT_UPDATED,
  claim,
  PROFILE_HAIKU,
  probeIntent,
  REPO_ID,
  withLedger,
} from "./base";
import type { ChannelFixture, LedgerFixture } from "./types";

export const SHARED_FILE = "src/shared/util.ts";
export const SHARED_CHANNEL = "claude";

function pausedChannel(until: string | null): ChannelFixture {
  return {
    channelId: SHARED_CHANNEL,
    profileIds: [PROFILE_HAIKU.id],
    state: "paused",
    unavailableUntil: until,
    scope: "channel",
    source: "structured-error",
    code: "quota",
    observedAt: AT_UPDATED,
    incidentId: "incident-claude-1",
    revision: 2,
  };
}

/** RE4.3 / Y7: two Runs declare the same canonical write scope. */
export const LOCK_CONFLICT_RUN_A: LedgerFixture = withLedger({
  runId: "run-rec0re-lka",
  revision: 5,
  resources: [claim({ claimId: "claim-shared-a", path: SHARED_FILE, frozen: false })],
});

export const LOCK_CONFLICT_RUN_B: LedgerFixture = withLedger({
  runId: "run-rec0re-lkb",
  revision: 6,
  resources: [claim({ claimId: "claim-shared-b", taskId: "T3", path: SHARED_FILE, frozen: false })],
});

/** Same physical file through a Windows alias; canonicalization must converge on SHARED_FILE. */
export const LOCK_CONFLICT_ALIASED_CLAIM = claim({
  claimId: "claim-shared-alias",
  taskId: "T3",
  path: "SRC\\Shared\\UTIL.ts",
});

/** Only one plugin instance may write, regardless of Run. */
export const ROOT_LOCK = {
  id: "root-lock",
  scope: "agent-team-runs",
  ownerToken: "owner-e7b2c1",
  pid: 48216,
  startTime: "2026-10-27T11:58:00.000Z",
  startedAt: "2026-10-27T11:58:00.000Z",
  processStartedAt: "2026-10-27T11:58:00.120Z",
  state: "held",
  reclaimGuard: { deadPidReclaim: true, requireSameStartTime: true },
} as const;

/** A stale root lock whose pid is gone; must be reclaimed only through the guard. */
export const STALE_ROOT_LOCK = {
  ...ROOT_LOCK,
  ownerToken: "owner-dead-1",
  pid: 99999,
  startTime: "2026-10-27T09:00:00.000Z",
  startedAt: "2026-10-27T09:00:00.000Z",
  processStartedAt: "2026-10-27T09:00:00.240Z",
  state: "stale",
} as const;

/** RE5.5 / Y19: both Runs reach the same recovery window for one channel. */
export const PROBE_CONFLICT_RUN_A: LedgerFixture = withLedger({
  runId: "run-rec0re-prba",
  revision: 14,
  lifecycle: "paused",
  channels: [pausedChannel("2026-10-27T12:30:00.000Z")],
  outbox: [
    probeIntent({
      id: "intent-probe-a",
      messageId: "99999999-9999-4999-8999-999999999999",
      idempotencyKey: "probe-claude-a",
      state: "sending",
    }),
  ],
  counters: { observationSeq: 7, eventsThroughSeq: 7, probeAttempts: 1, reopenAttempts: 0 },
});

export const PROBE_CONFLICT_RUN_B: LedgerFixture = withLedger({
  runId: "run-rec0re-prbb",
  revision: 15,
  lifecycle: "paused",
  channels: [pausedChannel("2026-10-27T12:31:00.000Z")],
  outbox: [
    probeIntent({
      id: "intent-probe-b",
      messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      idempotencyKey: "probe-claude-b",
      state: "prepared",
    }),
  ],
});

/** Same Run, same channel, two seats: one probe, then the whole channel stays paused together. */
export const PROBE_SAME_CHANNEL_SEATS_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-prbs",
  revision: 16,
  lifecycle: "paused",
  channels: [pausedChannel("2026-10-27T12:30:00.000Z")],
  resources: [
    claim({
      claimId: "probe-lock",
      taskId: "T2",
      kind: "file",
      path: "probe/channel-claude",
      access: "read",
      frozen: false,
    }),
  ],
  alerts: [
    {
      alertId: "alert-channel-paused",
      state: "open",
      severity: "warning",
      summary: "claude paused for every seat until the recovery window.",
      createdAt: AT_CREATED,
      acknowledgedAt: null,
      resolvedAt: null,
    },
  ],
});

/** RE1.14: a corrupt Run may still hold unknown resources, so new grants freeze repo-wide. */
export const CORRUPT_RESOURCE_HOLDER = {
  runId: "run-rec0re-bad",
  readable: false,
  digest: "e".repeat(64),
  knownClaims: [claim({ claimId: "claim-bad", path: SHARED_FILE })],
  indexEffect: {
    repoId: REPO_ID,
    freezeNewGrants: true,
    reason: "corrupt-record-may-hold-unknown-resources",
  },
} as const;

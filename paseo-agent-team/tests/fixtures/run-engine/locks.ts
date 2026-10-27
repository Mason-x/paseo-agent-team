// Cross-Run resource inputs: file claims, the root write lock, and one shared channel probe.
// The index must grant at most one of these; a corrupt holder freezes new grants (RE1.14).
import {
  AT_CREATED,
  AT_UPDATED,
  claim,
  intent,
  NONCE_PROBE,
  PROFILE_HAIKU,
  REPO_ID,
  withLedger,
} from "./base";
import type { LedgerFixture } from "./types";

export const SHARED_FILE = "src/shared/util.ts";
export const SHARED_CHANNEL = "claude";

/** RE4.3 / Y7: two Runs declare the same canonical write scope. */
export const LOCK_CONFLICT_RUN_A: LedgerFixture = withLedger({
  runId: "run-rec0re-lka",
  revision: 5,
  resources: [claim({ id: "lock-shared-a", taskId: "T2", path: SHARED_FILE, state: "held" })],
});

export const LOCK_CONFLICT_RUN_B: LedgerFixture = withLedger({
  runId: "run-rec0re-lkb",
  revision: 6,
  resources: [claim({ id: "lock-shared-b", taskId: "T2", path: SHARED_FILE, state: "requested" })],
});

/** Same physical file through a Windows alias; canonicalization must converge on SHARED_FILE. */
export const LOCK_CONFLICT_ALIASED_CLAIM = claim({
  id: "lock-shared-alias",
  taskId: "T2",
  path: "SRC\\Shared\\UTIL.ts",
  state: "requested",
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
  channels: [
    {
      channelId: SHARED_CHANNEL,
      provider: "claude",
      state: "paused",
      pausedReason: "quota",
      unavailableUntil: "2026-10-27T12:30:00.000Z",
    },
  ],
  outbox: [
    intent({
      id: "intent-probe-a",
      kind: "probe-channel",
      recipient: PROFILE_HAIKU.channelId,
      messageId: "msg-probe-a",
      semanticArgs: { channelId: SHARED_CHANNEL, reason: "unavailableUntil reached" },
      state: "sending",
    }),
  ],
  nonceRegistry: [
    {
      nonce: NONCE_PROBE,
      runId: "run-rec0re-prba",
      taskId: "_probe",
      attempt: 1,
      phase: "probe",
      agentId: "agent-s1",
      seatId: "seat-s1",
      consumedAt: AT_UPDATED,
    },
  ],
});

export const PROBE_CONFLICT_RUN_B: LedgerFixture = withLedger({
  runId: "run-rec0re-prbb",
  revision: 15,
  channels: [
    {
      channelId: SHARED_CHANNEL,
      provider: "claude",
      state: "paused",
      pausedReason: "quota",
      unavailableUntil: "2026-10-27T12:31:00.000Z",
    },
  ],
  outbox: [
    intent({
      id: "intent-probe-b",
      kind: "probe-channel",
      recipient: PROFILE_HAIKU.channelId,
      messageId: "msg-probe-b",
      semanticArgs: { channelId: SHARED_CHANNEL, reason: "unavailableUntil reached" },
      state: "prepared",
    }),
  ],
});

/** Same Run, same channel, two seats: one probe, then the whole channel stays paused together. */
export const PROBE_SAME_CHANNEL_SEATS_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-prbs",
  revision: 16,
  channels: [
    {
      channelId: SHARED_CHANNEL,
      provider: "claude",
      state: "paused",
      pausedReason: "quota",
      unavailableUntil: "2026-10-27T12:30:00.000Z",
    },
  ],
  resources: [
    claim({
      id: "probe-lock",
      taskId: null,
      kind: "channel",
      path: SHARED_CHANNEL,
      access: "exclusive",
      state: "held",
    }),
  ],
  alerts: [
    {
      id: "alert-channel-paused",
      severity: "warning",
      code: "channel-paused",
      message: "claude paused for every seat until the recovery window.",
      taskId: null,
      at: AT_CREATED,
      acked: false,
    },
  ],
});

/** RE1.14: a corrupt Run may still hold unknown resources, so new grants freeze repo-wide. */
export const CORRUPT_RESOURCE_HOLDER = {
  runId: "run-rec0re-bad",
  readable: false,
  digest: `sha256:${"e".repeat(64)}`,
  knownClaims: [claim({ id: "lock-bad", taskId: "T2", path: SHARED_FILE, state: "held" })],
  indexEffect: {
    repoId: REPO_ID,
    freezeNewGrants: true,
    reason: "corrupt-record-may-hold-unknown-resources",
  },
} as const;

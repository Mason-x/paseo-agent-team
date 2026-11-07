import type { RunRecord } from "../../schemas/run-engine/ledger";

/**
 * Keeping a long Run inside the ledger's limits (plan point 44).
 *
 * `events` is capped at 8192 and the whole record at 8 MiB. Nothing compacted it, so a long Run would
 * one day make every commit fail. Two things are done about that:
 *
 *  - `planCompaction` / `applyCompaction` fold an old PREFIX of `events` into the record's existing
 *    `checkpoint` (a digest of what was dropped, the counters at that point, the ended assignments).
 *    The ledger already allows this: events only have to be contiguous from `checkpoint.throughSeq + 1`.
 *    No schema version changes, and an older build reads a compacted record as it is.
 *  - `capacityIssue` names a limit the Run is close to, so the service can stop starting new work and
 *    let what is in flight finish, instead of failing every commit once the limit is reached.
 *
 * What is never compacted: `eventReceipts`, `nonceRegistry`, `assignments`, `outbox`, `decisions`,
 * `alerts`. Whether an assignment is settled is decided from its `turn_ended` receipt, ended ones
 * included, so those arrays are the state, not history.
 *
 * Pure: no clock, no host, no Node module. The caller computes the digest of the dropped events.
 */

export const COMPACT_EVENTS_AT = 6144;
export const COMPACT_KEEP_NEWEST = 2048;
export const CAPACITY_REFUSE_AT = 7680;
export const CAPACITY_REFUSE_AT_4096 = 3840;
export const CAPACITY_REFUSE_AT_1024 = 960;
export const CAPACITY_WARN_AT = 6144;
export const TERMINAL_IDS_MAX = 4096;
export const COMPACTION_EVENT = "history-compacted";

export type CompactionLimits = {
  compactAt: number;
  keepNewest: number;
  refuseAt: number;
  refuseAt4096: number;
  refuseAt1024: number;
  warnAt: number;
};

export const DEFAULT_COMPACTION_LIMITS: CompactionLimits = {
  compactAt: COMPACT_EVENTS_AT,
  keepNewest: COMPACT_KEEP_NEWEST,
  refuseAt: CAPACITY_REFUSE_AT,
  refuseAt4096: CAPACITY_REFUSE_AT_4096,
  refuseAt1024: CAPACITY_REFUSE_AT_1024,
  warnAt: CAPACITY_WARN_AT,
};

/** The events that would be dropped, in order, or null when nothing should be compacted now. */
export function planCompaction(
  record: RunRecord,
  input: { bytesHigh: boolean; limits?: Partial<CompactionLimits> },
): { throughSeq: number; dropped: RunRecord["events"] } | null {
  const limits = { ...DEFAULT_COMPACTION_LIMITS, ...input.limits };
  if (record.events.length < limits.compactAt && !input.bytesHigh) return null;

  // Events of an assignment that is still open are not history yet: its settlement and a local
  // withdrawal are judged from them.
  let floor = Number.POSITIVE_INFINITY;
  for (const assignment of record.assignments) {
    if (assignment.state !== "assigned" && assignment.state !== "in_progress") continue;
    const created = Date.parse(assignment.createdAt);
    if (created < floor) floor = created;
  }

  const lastSeq = record.counters.eventsThroughSeq;
  const dropped: RunRecord["events"] = [];
  for (const event of record.events) {
    // Only a continuous prefix: a clock that went back must not leave a hole.
    if (!(Date.parse(event.at) < floor) || event.seq > lastSeq - limits.keepNewest) break;
    dropped.push(event);
  }
  const last = dropped.at(-1);
  if (last === undefined) return null;
  if (last.seq <= (record.checkpoint?.throughSeq ?? 0)) return null;
  return { throughSeq: last.seq, dropped };
}

export function applyCompaction(
  record: RunRecord,
  input: { throughSeq: number; historyDigest: string; now: string },
): RunRecord {
  const next = structuredClone(record);
  const before = next.events.length;
  next.events = next.events.filter((event) => event.seq > input.throughSeq);
  const removed = before - next.events.length;
  next.checkpoint = {
    throughSeq: input.throughSeq,
    historyDigest: input.historyDigest,
    counters: structuredClone(next.counters),
    acceptedNonceDigests: [...(record.checkpoint?.acceptedNonceDigests ?? [])],
    terminalAssignmentIds: next.assignments
      .filter(
        (entry) =>
          entry.state === "ended" || entry.state === "cancelled" || entry.state === "failed",
      )
      .map((entry) => entry.assignmentId)
      .sort()
      .slice(0, TERMINAL_IDS_MAX),
  };
  const seq = next.counters.eventsThroughSeq + 1;
  next.counters.eventsThroughSeq = seq;
  next.events.push({
    seq,
    kind: COMPACTION_EVENT,
    at: input.now,
    payload: { throughSeq: input.throughSeq, removed },
  });
  next.updatedAt = input.now;
  return next;
}

export type CapacityIssue = {
  /** `refuse`: no new work may start. `warn`: say so, keep going. */
  level: "refuse" | "warn";
  field: string;
  count: number;
};

/** The most serious limit the Run is near, or null. `needsCompaction` that compaction could not fix refuses. */
export function capacityIssue(
  record: RunRecord,
  input: { bytesHigh: boolean; limits?: Partial<CompactionLimits> },
): CapacityIssue | null {
  const limits = { ...DEFAULT_COMPACTION_LIMITS, ...input.limits };
  const refuse: [string, number, number][] = [
    ["events", record.events.length, limits.refuseAt],
    ["eventReceipts", record.eventReceipts.length, limits.refuseAt],
    ["nonceRegistry", record.nonceRegistry.length, limits.refuseAt],
    ["assignments", record.assignments.length, limits.refuseAt4096],
    ["outbox", record.outbox.length, limits.refuseAt4096],
    ["alerts", record.alerts.length, limits.refuseAt1024],
    ["decisions", record.decisions.length, limits.refuseAt1024],
  ];
  for (const [field, count, at] of refuse) {
    if (count >= at) return { level: "refuse", field, count };
  }
  if (input.bytesHigh) return { level: "refuse", field: "bytes", count: 0 };
  for (const [field, count] of [
    ["eventReceipts", record.eventReceipts.length],
    ["nonceRegistry", record.nonceRegistry.length],
  ] as const) {
    if (count >= limits.warnAt) return { level: "warn", field, count };
  }
  return null;
}

export const CAPACITY_REFUSE_ALERT = "台账接近容量上限，已停止新的派发；进行中的工作会继续收尾。";
export const CAPACITY_WARN_ALERT = "台账的回执或 nonce 记录已经很多，接近容量上限，请关注。";

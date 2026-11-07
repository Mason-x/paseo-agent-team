import { describe, expect, test } from "vitest";
import { sha256Hex } from "../../server/run-engine/digest";
import {
  applyCompaction,
  CAPACITY_REFUSE_AT,
  COMPACT_EVENTS_AT,
  COMPACT_KEEP_NEWEST,
  capacityIssue,
  planCompaction,
} from "../../shared/domain/run-engine/compaction";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import { cancellationAuditValid } from "../../shared/domain/run-engine/transitions";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { NORMAL_RUN_LEDGER } from "../fixtures/run-engine/base";

/**
 * Failure modes this file guards:
 *  - compaction taking history that an open assignment still needs, or leaving a hole in `events`;
 *  - compaction touching the arrays that ARE the state (receipts, nonces, assignments, outbox);
 *  - the checkpoint not chaining (a digest that ignores the previous one), or an invalid ledger after;
 *  - the capacity guard missing a limit, or firing below it.
 */

const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const small = { compactAt: 10, keepNewest: 3 } as const;

/**
 * The shared normal ledger with its events replaced by `count` plain audit events one second apart
 * from T0. Its open assignment (t2) is created at `openAt`.
 */
function run(count: number, openAt = at(10_000_000)): RunRecord {
  const record = structuredClone(NORMAL_RUN_LEDGER);
  record.events = Array.from({ length: count }, (_, index) => ({
    seq: index + 1,
    kind: "audit-note",
    at: at(index * 1000),
    payload: {},
  }));
  record.counters.eventsThroughSeq = count;
  record.updatedAt = at(99_999_999);
  delete record.checkpoint;
  for (const assignment of record.assignments) {
    if (assignment.state === "assigned" || assignment.state === "in_progress") {
      assignment.createdAt = openAt;
    }
  }
  return record;
}

function compactAll(record: RunRecord, limits = small, previous = "") {
  const plan = planCompaction(record, { bytesHigh: false, limits });
  if (plan === null) throw new Error("nothing to compact");
  const digest = sha256Hex(JSON.stringify({ previous, events: plan.dropped }));
  return {
    plan,
    next: applyCompaction(record, {
      throughSeq: plan.throughSeq,
      historyDigest: digest,
      now: at(99_999_999),
    }),
  };
}

describe("planCompaction", () => {
  test("nothing below the threshold, and the defaults are the documented ones", () => {
    expect(COMPACT_EVENTS_AT).toBe(6144);
    expect(COMPACT_KEEP_NEWEST).toBe(2048);
    expect(planCompaction(run(9), { bytesHigh: false, limits: small })).toBeNull();
    expect(planCompaction(run(10), { bytesHigh: false, limits: small })).not.toBeNull();
  });

  test("always keeps the newest events", () => {
    const plan = planCompaction(run(12), { bytesHigh: false, limits: small });
    expect(plan?.throughSeq).toBe(9);
    expect(plan?.dropped).toHaveLength(9);
  });

  test("a size problem compacts even a short history, but never below keepNewest", () => {
    expect(planCompaction(run(5), { bytesHigh: true, limits: small })?.throughSeq).toBe(2);
    expect(planCompaction(run(3), { bytesHigh: true, limits: small })).toBeNull();
  });

  test("events from the creation of the oldest open assignment on are never taken", () => {
    // The assignment was created at second 5.5: events 1..6 (seconds 0..5) are older.
    const plan = planCompaction(run(20, at(5500)), { bytesHigh: false, limits: small });
    expect(plan?.throughSeq).toBe(6);
  });

  test("a clock that went back leaves no hole: only the continuous prefix is taken", () => {
    const record = run(20);
    // Event 5 claims to be from far in the future; 6.. are old again.
    const odd = record.events[4];
    if (odd) odd.at = at(900_000_000);
    expect(planCompaction(record, { bytesHigh: false, limits: small })?.throughSeq).toBe(4);
  });

  test("already compacted history is not compacted again for nothing", () => {
    const { next } = compactAll(run(12));
    expect(planCompaction(next, { bytesHigh: false, limits: small })).toBeNull();
  });
});

describe("applyCompaction", () => {
  test("is a prefix cut with a checkpoint and one audit event, and the ledger stays valid", () => {
    const record = run(12);
    const { next, plan } = compactAll(record);
    expect(next.checkpoint).toMatchObject({ throughSeq: plan.throughSeq });
    expect(next.checkpoint?.historyDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(next.events.map((event) => event.seq)).toEqual([10, 11, 12, 13]);
    expect(next.events.at(-1)).toMatchObject({
      kind: "history-compacted",
      payload: { throughSeq: 9, removed: 9 },
    });
    expect(next.counters.eventsThroughSeq).toBe(13);
    expect(checkLedgerInvariants(record)).toEqual({ ok: true });
    expect(checkLedgerInvariants(next)).toEqual({ ok: true });
    // The input record is not modified.
    expect(record.events).toHaveLength(12);
  });

  test("never touches the arrays that are the state, nor tasks, claims, budgets or decisions", () => {
    const record = run(12);
    const { next } = compactAll(record);
    for (const key of [
      "eventReceipts",
      "nonceRegistry",
      "assignments",
      "outbox",
      "decisions",
      "alerts",
      "tasks",
      "resources",
      "budgets",
      "roster",
      "lifecycle",
    ] as const) {
      expect(next[key], key).toEqual(record[key]);
    }
  });

  test("the checkpoint remembers the ended assignments and the counters at that point", () => {
    const record = run(12);
    const { next } = compactAll(record);
    const ended = record.assignments
      .filter((entry) => ["ended", "cancelled", "failed"].includes(entry.state))
      .map((entry) => entry.assignmentId)
      .sort();
    expect(next.checkpoint?.terminalAssignmentIds).toEqual(ended);
    expect(next.checkpoint?.counters.observationSeq).toBe(record.counters.observationSeq);
  });

  test("the second digest depends on the first", () => {
    const first = compactAll(run(12));
    const secondInput = structuredClone(first.next);
    // More history arrives after the first compaction.
    for (let index = 0; index < 8; index += 1) {
      const seq = secondInput.counters.eventsThroughSeq + 1;
      secondInput.counters.eventsThroughSeq = seq;
      secondInput.events.push({ seq, kind: "audit-note", at: at(20_000 + index), payload: {} });
    }
    const chained = compactAll(secondInput, small, first.next.checkpoint?.historyDigest);
    const other = compactAll(secondInput, small, "f".repeat(64));
    expect(chained.next.checkpoint?.historyDigest).not.toBe(other.next.checkpoint?.historyDigest);
    expect(chained.next.checkpoint?.throughSeq).toBeGreaterThan(first.plan.throughSeq);
    expect(checkLedgerInvariants(chained.next)).toEqual({ ok: true });
  });

  test("a withdrawal stamp is judged the same before and after: inside the folded prefix it is trusted", () => {
    const record = run(12);
    for (const seq of [4, 11]) {
      record.events[seq - 1] = {
        seq,
        kind: "cancel-requested",
        at: at((seq - 1) * 1000),
        payload: { taskIds: ["t2"] },
      };
    }
    const { next } = compactAll(record);
    const stamp = (seq: number) => ({
      eventSeq: seq,
      at: at((seq - 1) * 1000),
      cause: "cancel-requested" as const,
    });
    // Seq 4 is folded into the checkpoint: the record vouches for it. Seq 11 is still retained.
    expect(cancellationAuditValid(next, "t2", stamp(4))).toBe(true);
    expect(cancellationAuditValid(next, "t2", stamp(11))).toBe(
      cancellationAuditValid(record, "t2", stamp(11)),
    );
    // A stamp past the end of the history is still refused.
    expect(cancellationAuditValid(next, "t2", stamp(500))).toBe(false);
  });
});

describe("capacityIssue", () => {
  const limits = { refuseAt: 5, refuseAt4096: 4, refuseAt1024: 3, warnAt: 2 };
  const quiet = { ...limits, warnAt: 100 };

  test("the documented thresholds", () => {
    expect(CAPACITY_REFUSE_AT).toBe(7680);
    expect(capacityIssue(run(5), { bytesHigh: false })).toBeNull();
  });

  test("each array refuses at its own threshold, not before", () => {
    const base = run(1);
    base.eventReceipts = base.eventReceipts.slice(0, 1);
    expect(capacityIssue(base, { bytesHigh: false, limits: quiet })).toBeNull();

    const events = run(5);
    expect(capacityIssue(events, { bytesHigh: false, limits })).toMatchObject({
      level: "refuse",
      field: "events",
    });
    const fewer = run(4);
    expect(capacityIssue(fewer, { bytesHigh: false, limits: quiet })).toBeNull();

    const outbox = run(1);
    while (outbox.outbox.length < 4) outbox.outbox.push(structuredClone(outbox.outbox[0] as never));
    expect(capacityIssue(outbox, { bytesHigh: false, limits })).toMatchObject({
      level: "refuse",
      field: "outbox",
    });

    const alerts = run(1);
    alerts.alerts = Array.from({ length: 3 }, (_, index) => ({
      alertId: `a${index}`,
      state: "open" as const,
      severity: "info" as const,
      summary: "x",
      createdAt: at(0),
      acknowledgedAt: null,
      resolvedAt: null,
    }));
    expect(capacityIssue(alerts, { bytesHigh: false, limits })).toMatchObject({
      level: "refuse",
      field: "alerts",
    });
  });

  test("receipts and nonces warn before they refuse", () => {
    const record = run(1);
    record.eventReceipts = Array.from({ length: 2 }, (_, index) => ({
      ...(NORMAL_RUN_LEDGER.eventReceipts[0] as RunRecord["eventReceipts"][number]),
      eventKey: `k${index}`,
      dedupeKey: `d${index}`,
    }));
    expect(capacityIssue(record, { bytesHigh: false, limits })).toMatchObject({
      level: "warn",
      field: "eventReceipts",
    });
  });

  test("a record still too large after compaction refuses", () => {
    expect(capacityIssue(run(1), { bytesHigh: true })).toMatchObject({
      level: "refuse",
      field: "bytes",
    });
  });
});

describe("the history page of a compacted Run", () => {
  test("says how far the history was folded, and an older cursor no longer works", async () => {
    const { historyPage } = await import("../../server/run-engine/projection");
    const record = run(12);
    expect(historyPage(record, undefined).page.compactedThroughSeq).toBeUndefined();
    const stale = historyPage(record, undefined, 5).page.nextCursor;
    const { next } = compactAll(record);
    const page = historyPage(next, undefined).page;
    expect(page.compactedThroughSeq).toBe(9);
    expect(page.events.map((event) => event.seq)).toEqual([10, 11, 12, 13]);
    // A cursor from before the compaction is bound to the old checkpoint: paging restarts.
    const again = historyPage(next, stale ?? undefined);
    expect(again.issues.map((issue) => issue.code)).toContain("history-cursor-expired");
  });
});

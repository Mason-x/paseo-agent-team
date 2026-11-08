import { describe, expect, test } from "vitest";
import {
  BUDGET_INCREASED_EVENT,
  BUDGET_LIMIT_MAX,
  budgetExhaustedAlert,
  increaseSeatBudget,
} from "../../shared/domain/run-engine/budget";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import { raiseAlert } from "../../shared/domain/run-engine/run-alert";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { bootstrapRun } from "./support/bootstrap-run";

/**
 * Giving a seat more turns (the pure side; the loop that really dispatches again is in control.test.ts).
 * Failure modes this file guards:
 *  - the frozen policy being touched (it is the Run's start, not its state);
 *  - the same request applied twice, or another one taken for a repeat;
 *  - a limit that grows without bound, or a seat that does not exist getting one;
 *  - an exhaustion alert left open after the way out was taken, or another seat's alert closed.
 */

const NOW = "2026-11-08T10:00:00.000Z";
const input = (over: Record<string, unknown> = {}) => ({
  seatId: "seat-b1",
  by: 4,
  requestId: "bud-1",
  expectedRevision: 1,
  reason: "I looked at it",
  now: NOW,
  ...over,
});

function fresh(version: 1 | 2 = 2): RunRecord {
  const record = bootstrapRun({ runId: "run-bud001-a1" });
  record.schemaVersion = version;
  return record;
}
const limitOf = (record: RunRecord, seatId: string) =>
  record.budgets.entries.find((entry) => entry.subjectId === seatId)?.limit;

describe("increaseSeatBudget", () => {
  test.each([1, 2] as const)(
    "[v%s] a seat that is only in the policy gets its own entry with the new limit; the policy is not touched",
    (version) => {
      const record = fresh(version);
      // Only the frozen policy knows this seat's budget.
      record.budgets.entries = record.budgets.entries.filter((e) => e.subjectId !== "seat-b1");
      const policyBefore = JSON.stringify(record.policy);
      const before = structuredClone(record);
      const result = increaseSeatBudget(
        record,
        input({ expectedRevision: record.revision }),
        false,
      );
      expect(result).toMatchObject({ ok: true, replayed: false });
      if (!result.ok || result.replayed) return;
      expect(result.limit).toBe(10);
      expect(limitOf(result.next, "seat-b1")).toBe(10);
      expect(JSON.stringify(result.next.policy)).toBe(policyBefore);
      expect(result.next.schemaVersion).toBe(version);
      // The entry keeps what was reserved, confirmed and observed.
      expect(result.next.budgets.entries.find((e) => e.subjectId === "seat-b1")).toMatchObject({
        reserved: 1,
        confirmed: 1,
        observedTurns: 1,
      });
      expect(result.next.events.at(-1)).toMatchObject({
        kind: BUDGET_INCREASED_EVENT,
        payload: {
          requestId: "bud-1",
          seatId: "seat-b1",
          by: 4,
          limitBefore: 6,
          limitAfter: 10,
          reason: "I looked at it",
        },
      });
      expect(checkLedgerInvariants(result.next)).toEqual({ ok: true });
      // The record it was made from is not touched.
      expect(record).toEqual(before);
    },
  );

  test("a seat that already has an entry is raised in place, one entry only", () => {
    const record = fresh();
    const result = increaseSeatBudget(
      record,
      input({ seatId: "seat-b2", by: 2, expectedRevision: record.revision }),
      false,
    );
    expect(result.ok && !result.replayed && result.limit).toBe(8);
    if (!result.ok || result.replayed) return;
    expect(result.next.budgets.entries.filter((e) => e.subjectId === "seat-b2")).toHaveLength(1);
  });

  test("its exhaustion alert is resolved and another seat's is left alone", () => {
    let record = fresh();
    const mine = budgetExhaustedAlert("seat-b1", 6, 6);
    const other = budgetExhaustedAlert("seat-b2", 6, 6);
    for (const [alertId, summary] of [
      ["a-mine", mine],
      ["a-other", other],
    ] as const) {
      record = raiseAlert(record, { alertId, severity: "warning", summary }, NOW).next;
    }
    const result = increaseSeatBudget(record, input({ expectedRevision: record.revision }), false);
    if (!result.ok || result.replayed) throw new Error("not applied");
    expect(result.next.alerts.find((a) => a.summary === mine)?.state).toBe("resolved");
    expect(result.next.alerts.find((a) => a.summary === other)?.state).toBe("open");
  });

  test("the same request is the same request: nothing is written; another one under the id is refused", () => {
    const record = fresh();
    const first = increaseSeatBudget(record, input({ expectedRevision: record.revision }), false);
    if (!first.ok || first.replayed) throw new Error("not applied");
    // A repeat is found before the revision is checked.
    const again = increaseSeatBudget(first.next, input({ expectedRevision: 1 }), false);
    expect(again).toEqual({ ok: true, replayed: true, limit: 10 });
    for (const over of [{ by: 5 }, { seatId: "seat-b2" }, { reason: "another reason" }]) {
      expect(
        increaseSeatBudget(first.next, input({ expectedRevision: 1, ...over }), false),
      ).toEqual({
        ok: false,
        code: "request-id-reused",
      });
    }
  });

  test("a stale revision is refused with the current one", () => {
    const record = fresh();
    expect(
      increaseSeatBudget(record, input({ expectedRevision: record.revision + 2 }), false),
    ).toEqual({
      ok: false,
      code: "revision-conflict",
      current: record.revision,
    });
  });

  test.each(["finished", "cancelled"] as const)("a %s Run is refused", (lifecycle) => {
    const record = fresh();
    record.lifecycle = lifecycle;
    expect(increaseSeatBudget(record, input({ expectedRevision: record.revision }), false)).toEqual(
      {
        ok: false,
        code: "lifecycle-not-allowed",
        lifecycle,
      },
    );
  });

  test("a Run whose cancellation was asked for is refused, and every other live lifecycle is allowed", () => {
    const record = fresh();
    expect(
      increaseSeatBudget(record, input({ expectedRevision: record.revision }), true),
    ).toMatchObject({
      ok: false,
      code: "lifecycle-not-allowed",
    });
    for (const lifecycle of ["bootstrapping", "awaiting-dag", "active", "paused"] as const) {
      const live = fresh();
      live.lifecycle = lifecycle;
      expect(increaseSeatBudget(live, input({ expectedRevision: live.revision }), false).ok).toBe(
        true,
      );
    }
  });

  test("a seat that is not in the roster, or has no budget anywhere, is refused", () => {
    const record = fresh();
    expect(
      increaseSeatBudget(
        record,
        input({ seatId: "seat-nope", expectedRevision: record.revision }),
        false,
      ),
    ).toEqual({ ok: false, code: "seat-missing" });
    // A seat that is in the roster and has no turn budget, in the entries or in the frozen policy. The
    // coordinator is no such seat any more: its entry is built on first use (coordinator-budget.test.ts).
    const bare = fresh();
    bare.budgets.entries = bare.budgets.entries.filter((e) => e.subjectId !== "seat-b2");
    bare.policy.seatBudgets = bare.policy.seatBudgets.filter((e) => e.subjectId !== "seat-b2");
    expect(bare.roster.some((seat) => seat.seatId === "seat-b2")).toBe(true);
    expect(
      increaseSeatBudget(
        bare,
        input({ seatId: "seat-b2", expectedRevision: bare.revision }),
        false,
      ),
    ).toEqual({ ok: false, code: "budget-missing" });
  });

  test("the limit has a ceiling: exactly the maximum is allowed, one more is not", () => {
    const record = fresh();
    const entry = record.budgets.entries.find((e) => e.subjectId === "seat-b2");
    if (!entry) throw new Error("no entry");
    entry.limit = BUDGET_LIMIT_MAX - 4;
    const ok = increaseSeatBudget(
      record,
      input({ seatId: "seat-b2", expectedRevision: record.revision }),
      false,
    );
    expect(ok.ok && !ok.replayed && ok.limit).toBe(BUDGET_LIMIT_MAX);
    expect(
      increaseSeatBudget(
        record,
        input({ seatId: "seat-b2", by: 5, expectedRevision: record.revision }),
        false,
      ),
    ).toEqual({ ok: false, code: "budget-cap", max: BUDGET_LIMIT_MAX });
  });
});

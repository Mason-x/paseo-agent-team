import { describe, expect, test } from "vitest";
import type { z } from "zod";
import {
  budgetKey,
  budgetStatus,
  type PredebitRequest,
  predebit,
} from "../../shared/domain/run-engine/budget";
import { RunBudgetEntrySchema, type RunRecord } from "../../shared/schemas/run-engine/ledger";

type RunBudgetEntry = z.infer<typeof RunBudgetEntrySchema>;

import { NORMAL_RUN_LEDGER } from "../fixtures/run-engine";

function entry(overrides: Partial<RunBudgetEntry> = {}): RunBudgetEntry {
  return {
    scope: "seat",
    subjectId: "seat-b1",
    limit: 5,
    reserved: 3,
    confirmed: 1,
    observedTurns: 2,
    ...overrides,
  };
}

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  const budget = entry();
  return {
    ...NORMAL_RUN_LEDGER,
    budgets: { entries: [budget] },
    policy: { ...NORMAL_RUN_LEDGER.policy, seatBudgets: [budget] },
    outbox: [],
    ...overrides,
  };
}

function request(overrides: Partial<PredebitRequest> = {}): PredebitRequest {
  return {
    seatId: "seat-b1",
    intentKey: "intent-1",
    messageId: "11111111-1111-4111-8111-111111111111",
    amount: 1,
    revision: 7,
    ...overrides,
  };
}

describe("budget status and reservation", () => {
  test("status is derived from reserved and reports the current threshold", () => {
    expect(budgetKey(entry())).toBe("seat:seat-b1");
    expect(budgetStatus(record(), "seat-b1")).toMatchObject({
      entry: { reserved: 3 },
      ratio: 0.6,
      threshold: null,
    });
    expect(budgetStatus(record(), "missing")).toBeNull();
    expect(
      budgetStatus(record({ budgets: { entries: [entry({ reserved: 4 })] } }), "seat-b1"),
    ).toMatchObject({ threshold: "80" });
  });

  test("predebit returns a complete schema-valid draft and a once-per-cross warning", () => {
    const result = predebit(record(), request());
    expect(result.status).toBe("reserved");
    if (result.status !== "reserved") throw new Error("expected reservation");
    expect(RunBudgetEntrySchema.parse(result.entry)).toEqual({
      ...entry(),
      reserved: 4,
    });
    expect(result.warning).toEqual({ threshold: "80", revision: 7, merged: false });

    const both = predebit(record(), request({ amount: 2 }));
    if (both.status !== "reserved") throw new Error("expected reservation");
    expect(both.entry.reserved).toBe(5);
    expect(both.warning).toEqual({ threshold: "100", revision: 7, merged: true });

    const exhausted = predebit(
      record({ budgets: { entries: [entry({ reserved: 5 })] } }),
      request(),
    );
    expect(exhausted).toEqual({
      status: "exhausted",
      reason: "limit",
      entry: entry({ reserved: 5 }),
    });
  });

  test("the same intent/message is counted once without a draft", () => {
    const committed = record({
      outbox: [
        {
          id: "intent-1",
          recipient: "agent-b1",
          messageId: request().messageId,
          idempotencyKey: request().intentKey,
          kind: "dispatch",
          taskId: "t1",
          assignmentId: "assignment-1",
          semanticArgs: {},
          payloadHash: "a".repeat(64),
          templateVersion: 1,
          state: "prepared",
          recoverySendCount: 0,
          createdAt: "2026-10-28T00:00:00.000Z",
          confirmedAt: null,
          localCancellation: null,
        } as RunRecord["outbox"][number],
      ],
    });
    expect(predebit(committed, request())).toEqual({ status: "already-counted" });
    expect(predebit(committed, request({ intentKey: "new-intent" }))).toEqual({
      status: "already-counted",
    });
  });

  test("missing budget and invalid amounts are typed rejections; input is immutable", () => {
    expect(
      predebit(
        record({
          budgets: { entries: [] },
          policy: { ...NORMAL_RUN_LEDGER.policy, seatBudgets: [] },
        }),
        request(),
      ),
    ).toEqual({
      status: "exhausted",
      reason: "missing",
    });
    expect(predebit(record(), request({ amount: 0 }))).toEqual({
      status: "exhausted",
      reason: "invalid",
    });
    const input = record();
    const before = JSON.stringify(input);
    predebit(input, request());
    expect(JSON.stringify(input)).toBe(before);
    expect(predebit(input, request())).toEqual(predebit(input, request()));
  });
});

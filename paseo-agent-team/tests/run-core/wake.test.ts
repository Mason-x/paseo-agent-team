import { describe, expect, test } from "vitest";
import {
  buildWakeSummary,
  classifyWake,
  wakeKey,
} from "../../shared/domain/run-engine/wake-summary";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { NORMAL_RUN_LEDGER, spec, taskRecord } from "../fixtures/run-engine";

const POLICY_EPOCH = "policy-1";
const DECISION_ID = "22222222-2222-4222-8222-222222222222";

function decision(category: "D1" | "D2" | "D3" | "D4" | "D5" | "D6" | "D7" = "D1") {
  return {
    decisionId: DECISION_ID,
    category,
    state: "open" as const,
    dedupeKey: "seed",
    subjectId: "subject-1",
    summary: "WORKER TEXT nonce payload must not leak",
    createdAt: "2026-10-28T00:00:00.000Z",
    answeredAt: null,
  };
}

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return { ...NORMAL_RUN_LEDGER, decisions: [], ...overrides };
}

describe("wake classification", () => {
  test("new open decisions wake once with a stable key; ordinary progress does not", () => {
    const prev = record();
    const next = record({ decisions: [decision("D1")] });
    const wakes = classifyWake(prev, next, { policyEpoch: POLICY_EPOCH });
    expect(wakes).toEqual([
      {
        category: "D1",
        subjectId: "subject-1",
        taskId: null,
        dedupeKey: wakeKey(next.runId, "D1", "subject-1", POLICY_EPOCH),
        source: "decision",
      },
    ]);
    expect(classifyWake(next, next, { policyEpoch: POLICY_EPOCH })).toEqual([]);

    const progress = record({
      tasks: [taskRecord(spec("T9", "Done"), { state: "done" })],
      lifecycle: "active",
    });
    expect(classifyWake(record(), progress, { policyEpoch: POLICY_EPOCH })).toEqual([]);
  });

  test("S failure, budget exhaustion and run finish map to D3/D4/D6", () => {
    const failed = record({
      tasks: [taskRecord(spec("T9", "Hard", { tier: "S" }), { state: "failed" })],
    });
    expect(classifyWake(record(), failed, { policyEpoch: POLICY_EPOCH })).toMatchObject([
      { category: "D3", subjectId: "T9", taskId: "T9", source: "task-failed" },
    ]);

    const budgets = record({
      budgets: {
        entries: [
          {
            scope: "seat",
            subjectId: "seat-b1",
            limit: 5,
            reserved: 5,
            confirmed: 5,
            observedTurns: 2,
          },
        ],
      },
    });
    expect(classifyWake(record(), budgets, { policyEpoch: POLICY_EPOCH })).toMatchObject([
      { category: "D4", subjectId: "seat-b1", source: "budget" },
    ]);

    const finished = record({ lifecycle: "finished" });
    expect(classifyWake(record(), finished, { policyEpoch: POLICY_EPOCH })).toMatchObject([
      { category: "D6", source: "run-finished" },
    ]);
  });

  test("all seven decision categories are classified without a per-event table", () => {
    for (const category of ["D1", "D2", "D3", "D4", "D5", "D6", "D7"] as const) {
      const next = record({ decisions: [decision(category)] });
      expect(classifyWake(record(), next, { policyEpoch: POLICY_EPOCH })).toMatchObject([
        { category, source: "decision" },
      ]);
    }
  });

  test("dedupes same subject/category and ignores non-open decisions", () => {
    const next = record({
      decisions: [
        { ...decision("D4"), decisionId: "33333333-3333-4333-8333-333333333333" },
        { ...decision("D4"), decisionId: "44444444-4444-4444-8444-444444444444" },
      ],
    });
    expect(classifyWake(record(), next, { policyEpoch: POLICY_EPOCH })).toHaveLength(1);
    const answered = record({ decisions: [{ ...decision("D1"), state: "answered" as const }] });
    expect(classifyWake(record(), answered, { policyEpoch: POLICY_EPOCH })).toEqual([]);
  });
});

describe("wake summary", () => {
  test("bounded sanitized text excludes worker text and is deterministic", () => {
    const tasks = [taskRecord(spec("T9", "Ship", { tier: "S" }), { state: "failed" })];
    const next = record({ tasks, decisions: [decision("D1")] });
    const requests = classifyWake(record(), next, { policyEpoch: POLICY_EPOCH });
    const request = requests[0];
    if (!request) throw new Error("missing wake request");
    const summary = buildWakeSummary(request, next);
    expect(new TextEncoder().encode(summary).length).toBeLessThanOrEqual(4096);
    expect(summary).not.toContain("WORKER TEXT");
    expect(summary).not.toContain("nonce");
    expect(summary).not.toContain("payload");
    expect(summary).toBe(buildWakeSummary(request, next));
  });
});

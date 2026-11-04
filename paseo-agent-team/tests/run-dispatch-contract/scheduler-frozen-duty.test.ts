import { describe, expect, test } from "vitest";
import { eligibleSeats, planDispatchWithReasons } from "../../shared/domain/run-engine/scheduler";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { NORMAL_RUN_LEDGER, spec, taskRecord } from "../fixtures/run-engine";

const NOW = "2026-10-28T00:00:00.000Z";

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    ...NORMAL_RUN_LEDGER,
    tasks: [taskRecord(spec("T1", "Ship"), { state: "ready" })],
    ...overrides,
  };
}

function seat(overrides: Record<string, unknown> = {}) {
  return {
    seatId: "seat-b1",
    profileId: "profile-haiku",
    agentId: "agent-b1",
    enabled: true,
    idle: true,
    permissionPending: false,
    degraded: false,
    channelState: "available" as const,
    available: true,
    load: 0,
    qualityRework: 0,
    order: 0,
    ...overrides,
  };
}

function ctx(overrides: Record<string, unknown> = {}) {
  return { now: NOW, mode: "sota" as const, seats: [seat()], ...overrides };
}

describe("scheduler frozen produce duties", () => {
  test("ctx.requiredDuty is ignored and cannot override the frozen produce duty", () => {
    const ready = record();
    const baseline = eligibleSeats(ready, "T1", ctx());
    const reviewCtx = eligibleSeats(ready, "T1", ctx({ requiredDuty: "review" }));
    const otherCtx = eligibleSeats(ready, "T1", ctx({ requiredDuty: "coordinate" }));
    expect(baseline.candidates.map((entry) => entry.seatId)).toEqual(["seat-b1"]);
    expect(reviewCtx).toEqual(baseline);
    expect(otherCtx).toEqual(baseline);
    expect(baseline.denials).not.toContainEqual({ seatId: "seat-b1", reason: "duty" });
  });

  test("a review-only roster seat cannot cover produce", () => {
    const ready = record({
      roster: NORMAL_RUN_LEDGER.roster.map((entry) =>
        entry.seatId === "seat-b1" ? { ...entry, duties: ["review"] } : entry,
      ),
    });
    const eligibility = eligibleSeats(ready, "T1", ctx());
    expect(eligibility.candidates).toEqual([]);
    expect(eligibility.blocked).toBe("no-seat");
    expect(eligibility.denials).toContainEqual({ seatId: "seat-b1", reason: "duty" });
  });

  test("an invalid produce requirement is a deterministic no-seat without guessed duties", () => {
    const ready = record({
      tasks: [
        taskRecord(
          spec("T1", "Ship", { dispatchDuties: { produce: "", review: "review", smoke: null } }),
          {
            state: "ready",
          },
        ),
      ],
    });
    const eligibility = eligibleSeats(ready, "T1", ctx({ requiredDuty: "implement" }));
    expect(eligibility).toEqual({ candidates: [], denials: [], blocked: "no-seat" });
    expect(planDispatchWithReasons(ready, ctx()).blocked).toEqual([
      { taskId: "T1", decision: "D1", reasons: [] },
    ]);
  });
});

import { describe, expect, test } from "vitest";
import {
  dispatchLabels,
  eligibleSeats,
  nextQualityFailure,
  planDispatch,
  rankCandidates,
  type SchedulerContext,
  type SeatRuntime,
} from "../../shared/domain/run-engine/scheduler";
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

function seat(overrides: Partial<SeatRuntime> = {}): SeatRuntime {
  return {
    seatId: "seat-b1",
    profileId: "profile-haiku",
    agentId: "agent-b1",
    enabled: true,
    idle: true,
    permissionPending: false,
    degraded: false,
    channelState: "available",
    available: true,
    load: 0,
    qualityRework: 0,
    order: 0,
    ...overrides,
  };
}

function ctx(overrides: Partial<SchedulerContext> = {}): SchedulerContext {
  return { now: NOW, mode: "sota", seats: [seat()], ...overrides };
}

describe("scheduler eligibility and ordering", () => {
  test("only a ready task with no waiting reason is schedulable", () => {
    expect(
      eligibleSeats(record({ tasks: [taskRecord(spec("T1", "Ship"))] }), "T1", ctx()),
    ).toMatchObject({ candidates: [], blocked: "not-ready" });
    expect(
      eligibleSeats(
        record({
          tasks: [taskRecord(spec("T1", "Ship"), { state: "ready", waitingReason: "deps" })],
        }),
        "T1",
        ctx(),
      ).blocked,
    ).toBe("not-ready");
  });

  test("tier, duty, availability, channel, idle, permission and mode filters are explicit", () => {
    const l4 = record({
      tasks: [taskRecord(spec("T1", "Ship", { level: "L4" }), { state: "ready" })],
    });
    expect(eligibleSeats(l4, "T1", ctx()).denials).toContainEqual({
      seatId: "seat-b1",
      reason: "tier",
    });
    const duty = eligibleSeats(record(), "T1", ctx({ requiredDuty: "review" }));
    expect(duty.denials).toContainEqual({ seatId: "seat-b1", reason: "duty" });
    const filters: Array<[Partial<SeatRuntime>, string]> = [
      [{ idle: false }, "busy"],
      [{ permissionPending: true }, "permission"],
      [{ degraded: true }, "degraded"],
      [{ channelState: "paused" }, "channel"],
      [{ available: false }, "profile-unavailable"],
      [{ agentId: null }, "agent-missing"],
      [{ enabled: false }, "disabled"],
    ];
    for (const [patch, reason] of filters) {
      expect(eligibleSeats(record(), "T1", ctx({ seats: [seat(patch)] })).denials).toContainEqual({
        seatId: "seat-b1",
        reason,
      });
    }
    const mode = eligibleSeats(
      record({ policy: { ...record().policy, disabledProfileIds: ["profile-haiku"] } }),
      "T1",
      ctx(),
    );
    expect(mode.denials).toContainEqual({ seatId: "seat-b1", reason: "disabled-profile" });
    const economy = eligibleSeats(
      record(),
      "T1",
      ctx({ mode: "economy-all", profileAllowed: () => false }),
    );
    expect(economy.denials).toContainEqual({ seatId: "seat-b1", reason: "mode" });
    expect(economy.blocked).toBe("no-seat");
  });

  test("ranking is total and stable; a higher tier seat wins only after load/rework", () => {
    const low = { ...seat(), seatId: "seat-b1", load: 1, qualityRework: 0, order: 0 };
    const highRework = { ...seat(), seatId: "seat-a1", load: 0, qualityRework: 2, order: 1 };
    const best = { ...seat(), seatId: "seat-a2", load: 0, qualityRework: 0, order: 2 };
    const ranked = rankCandidates(
      [low, highRework, best].map((entry) => ({
        seatId: entry.seatId,
        profileId: entry.profileId,
        load: entry.load,
        qualityRework: entry.qualityRework,
        order: entry.order,
        qualification: "q",
      })),
    );
    expect(ranked.map((candidate) => candidate.seatId)).toEqual(["seat-a2", "seat-a1", "seat-b1"]);
  });

  test("planDispatch returns proposals only and does not mutate its input", () => {
    const input = record({
      tasks: [
        taskRecord(spec("T1", "One"), { state: "ready" }),
        taskRecord(spec("T2", "Two"), { state: "ready" }),
        taskRecord(spec("T3", "Three"), { state: "pending" }),
      ],
    });
    const before = JSON.stringify(input);
    const proposals = planDispatch(input, ctx({ seats: [seat({ seatId: "seat-b1", order: 1 })] }));
    expect(proposals).toEqual([
      {
        taskId: "T1",
        seatId: "seat-b1",
        profileId: "profile-haiku",
        qualification: "tier=B,load=0,rework=0",
      },
      {
        taskId: "T2",
        seatId: "seat-b1",
        profileId: "profile-haiku",
        qualification: "tier=B,load=0,rework=0",
      },
    ]);
    expect(JSON.stringify(input)).toBe(before);
  });

  test("generated labels are deterministic and bump a collision suffix", () => {
    expect(dispatchLabels("run-abcdef123456", "task-1", 2, 1)).toEqual({
      branchName: "re-runabcdef1-task-1-a2-1",
      worktreeSlug: "re-runabcdef1-task-1-a2-1",
      workspaceName: "re-runabcdef1-task-1-a2-1",
    });
    expect(
      dispatchLabels("run-abcdef123456", "task-1", 2, 1, new Set(["re-runabcdef1-task-1-a2-1"]))
        .branchName,
    ).toBe("re-runabcdef1-task-1-a2-2");
  });

  test("quality failure is the single rework/escalate/D3/D4 rule", () => {
    const policy = record().policy;
    expect(
      nextQualityFailure({ tier: "B", qualityFailures: 1, escalations: 0, attempts: 1 }, policy),
    ).toEqual({ kind: "rework", layerFailures: 1 });
    expect(
      nextQualityFailure({ tier: "B", qualityFailures: 3, escalations: 0, attempts: 3 }, policy),
    ).toEqual({ kind: "escalate", nextTier: "A", layerFailures: 0 });
    expect(
      nextQualityFailure({ tier: "A", qualityFailures: 4, escalations: 1, attempts: 4 }, policy),
    ).toEqual({ kind: "rework", layerFailures: 1 });
    expect(
      nextQualityFailure({ tier: "S", qualityFailures: 3, escalations: 0, attempts: 3 }, policy),
    ).toEqual({ kind: "blocked", decision: "D3", reason: "S-quality-failure" });
    expect(
      nextQualityFailure({ tier: "A", qualityFailures: 3, escalations: 0, attempts: 6 }, policy),
    ).toEqual({ kind: "blocked", decision: "D4", reason: "implementation-attempts" });
  });
});

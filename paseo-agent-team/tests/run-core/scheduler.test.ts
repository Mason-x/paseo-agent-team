import { describe, expect, test } from "vitest";
import {
  dispatchLabels,
  eligibleSeats,
  nextQualityFailure,
  planDispatch,
  planDispatchWithReasons,
  rankCandidates,
  type SchedulerContext,
  type SeatRuntime,
} from "../../shared/domain/run-engine/scheduler";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { escalation, NORMAL_RUN_LEDGER, spec, taskRecord } from "../fixtures/run-engine";

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
  test("only task state determines readiness; waiting reason is display text", () => {
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
    ).toBeNull();
  });

  test("tier, duty, availability, channel, idle, permission and mode filters are explicit", () => {
    const l4 = record({
      tasks: [taskRecord(spec("T1", "Ship", { level: "L4", tier: "S" }), { state: "ready" })],
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

  test("tier matching is exact; an idle S seat never replaces a B seat for L1", () => {
    const b = seat({ seatId: "seat-b1", order: 1 });
    const s = { ...b, seatId: "seat-s1", order: 0 };
    const l1 = record({
      tasks: [taskRecord(spec("T1", "Small", { level: "L1" }), { state: "ready" })],
    });
    expect(eligibleSeats(l1, "T1", ctx({ seats: [s, b] })).candidates.map((c) => c.seatId)).toEqual(
      ["seat-b1"],
    );
    const onlyS = planDispatchWithReasons(l1, ctx({ seats: [s] }));
    expect(onlyS.proposals).toEqual([]);
    expect(onlyS.blocked).toEqual([
      { taskId: "T1", decision: "D1", reasons: [{ seatId: "seat-s1", reason: "tier" }] },
    ]);
  });

  test("ranking is total and stable", () => {
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
    const codeUnits = ["a", "B"].map((seatId) => ({
      seatId,
      profileId: "p",
      load: 0,
      qualityRework: 0,
      order: 0,
      qualification: "q",
    }));
    expect(rankCandidates(codeUnits).map((candidate) => candidate.seatId)).toEqual(["B", "a"]);
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
    const single = planDispatchWithReasons(
      input,
      ctx({ seats: [seat({ seatId: "seat-b1", order: 1 })] }),
    );
    expect(single.proposals).toEqual([
      {
        taskId: "T1",
        seatId: "seat-b1",
        profileId: "profile-haiku",
        qualification: "tier=B,load=0,rework=0",
      },
    ]);
    expect(single.blocked).toMatchObject([{ taskId: "T2", decision: "wait" }]);
    expect(planDispatch(input, ctx({ seats: [seat({ order: 1 })] }))).toHaveLength(1);
    const three = record({
      tasks: ["T1", "T2", "T3"].map((id) => taskRecord(spec(id, id), { state: "ready" })),
    });
    const plan = planDispatchWithReasons(three, ctx({ seats: [seat({ order: 1 })] }));
    expect(plan.proposals.map((entry) => entry.taskId)).toEqual(["T1"]);
    expect(plan.blocked).toMatchObject([
      { taskId: "T2", decision: "wait" },
      { taskId: "T3", decision: "wait" },
    ]);
    expect(JSON.stringify(input)).toBe(before);
  });

  test("generated labels are deterministic and bump a collision suffix", () => {
    expect(dispatchLabels("run-abcdef123456", "task-1", 2, 1)).toEqual({
      branchName: "re-abcdef1234-task-1-a2-1",
      worktreeSlug: "re-abcdef1234-task-1-a2-1",
      workspaceName: "re-abcdef1234-task-1-a2-1",
    });
    expect(
      dispatchLabels("run-abcdef123456", "task-1", 2, 1, new Set(["re-abcdef1234-task-1-a2-1"]))
        .branchName,
    ).toBe("re-abcdef1234-task-1-a2-2");
    const labels = ["T1", "A1", "B1"].map((id) => dispatchLabels("run-abcdef123456", id, 1, 1));
    expect(new Set(labels.map((entry) => entry.branchName)).size).toBe(3);
    expect(labels[0]?.branchName).toContain("-t1-");
    expect(dispatchLabels("run-abcdef123456", "登录", 1, 1).branchName).toContain("task-");
    expect(dispatchLabels("run-abcdef123456", "T1", 1, 1).branchName).not.toBe(
      dispatchLabels("run-abcdef123456", "t1", 1, 1).branchName,
    );
  });

  test("quality failure is the single rework/escalate/D3/D4 rule", () => {
    const policy = record().policy;
    const bToA = escalation();
    const aToS = escalation({ fromTier: "A", toTier: "S", qualityFailures: 6, atAttempt: 6 });
    const b = (
      qualityFailures: number,
      attempts = qualityFailures,
      escalations = [] as (typeof bToA)[],
    ) => taskRecord(spec("T1", "Ship"), { qualityFailures, attempts, escalations });
    const direct = (tier: "A" | "S", qualityFailures: number, attempts = qualityFailures) =>
      taskRecord(spec("T1", "Ship", { tier, level: tier === "S" ? "L4" : "L3" }), {
        qualityFailures,
        attempts,
      });
    expect(nextQualityFailure(b(1), policy)).toEqual({ kind: "rework", layerFailures: 1 });
    expect(nextQualityFailure(b(3), policy)).toEqual({
      kind: "escalate",
      nextTier: "A",
      layerFailures: 0,
    });
    expect(nextQualityFailure(b(4, 4, [bToA]), policy)).toEqual({
      kind: "rework",
      layerFailures: 1,
    });
    expect(nextQualityFailure(direct("S", 3), policy)).toEqual({
      kind: "blocked",
      decision: "D3",
      reason: "S-quality-failure",
    });
    expect(nextQualityFailure(direct("A", 3, 6), policy)).toEqual({
      kind: "blocked",
      decision: "D4",
      reason: "implementation-attempts",
    });
    const capNine = { ...policy, perTask: { ...policy.perTask, implementationAttempts: 9 } };
    const capTen = { ...policy, perTask: { ...policy.perTask, implementationAttempts: 10 } };
    for (const policyWithCap of [capNine, capTen]) {
      expect(nextQualityFailure(b(9, 9, [bToA, aToS]), policyWithCap)).toEqual({
        kind: "blocked",
        decision: "D3",
        reason: "S-quality-failure",
      });
    }
    expect(nextQualityFailure(b(6, 6, [bToA]), policy)).toEqual({
      kind: "blocked",
      decision: "D4",
      reason: "implementation-attempts",
    });
  });
});

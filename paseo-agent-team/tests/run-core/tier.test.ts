import { describe, expect, test } from "vitest";
import {
  executionTier,
  layerFailures,
  reviewRequirement,
} from "../../shared/domain/run-engine/tier";
import { escalation, spec, taskRecord } from "../fixtures/run-engine";

describe("executionTier and reviewRequirement", () => {
  test("no escalation uses the frozen spec tier, never the level", () => {
    const task = taskRecord(spec("t1", "L4 but B", { level: "L4", tier: "B" }));
    expect(executionTier(task)).toBe("B");
    expect(reviewRequirement(task)).toEqual({ level: "L4", tier: "S" });
    expect(reviewRequirement(taskRecord(spec("t2", "L2", { level: "L2", tier: "B" })))).toEqual({
      level: "L2",
      tier: "A",
    });
  });

  test("L2 B→A reviews at the stricter A level; B→A→S reviews at S", () => {
    const l2A = taskRecord(spec("t1", "L2→A", { level: "L2", tier: "B" }), {
      escalations: [escalation()],
    });
    expect(executionTier(l2A)).toBe("A");
    expect(reviewRequirement(l2A)).toEqual({ level: "L3", tier: "A" });
    const toS = taskRecord(spec("t2", "L2→S", { level: "L2", tier: "B" }), {
      escalations: [
        escalation(),
        escalation({ fromTier: "A", toTier: "S", qualityFailures: 6, atAttempt: 6 }),
      ],
    });
    expect(executionTier(toS)).toBe("S");
    expect(reviewRequirement(toS)).toEqual({ level: "L4", tier: "S" });
  });

  test("L1 escalated to A is reviewed by A; escalated to S by S", () => {
    const l1A = taskRecord(spec("t1", "L1→A", { level: "L1", tier: "B" }), {
      escalations: [escalation()],
    });
    expect(reviewRequirement(l1A)).toEqual({ level: "L3", tier: "A" });
    const l1S = taskRecord(spec("t2", "L1→S", { level: "L1", tier: "B" }), {
      escalations: [
        escalation(),
        escalation({ fromTier: "A", toTier: "S", qualityFailures: 6, atAttempt: 6 }),
      ],
    });
    expect(reviewRequirement(l1S)).toEqual({ level: "L4", tier: "S" });
  });

  test("a-with-s-plan stores A execution but requires an S final review", () => {
    const task = taskRecord(
      spec("t1", "Plan", {
        level: "L4",
        tier: "A",
        implementationPolicy: "a-with-s-plan",
        architectureTaskId: "t0",
      }),
    );
    expect(executionTier(task)).toBe("A");
    expect(reviewRequirement(task)).toEqual({ level: "L4", tier: "S" });
    const l3Plan = taskRecord(
      spec("t2", "L3 plan", {
        level: "L3",
        tier: "A",
        implementationPolicy: "a-with-s-plan",
        architectureTaskId: "t0",
      }),
    );
    expect(reviewRequirement(l3Plan)).toEqual({ level: "L4", tier: "S" });
  });
});

describe("layerFailures", () => {
  test("subtracts the last escalation baseline and clamps at zero", () => {
    const base = taskRecord(spec("t1", "Task"), { qualityFailures: 5 });
    expect(layerFailures(base)).toBe(5);
    const afterA = { ...base, escalations: [escalation({ qualityFailures: 3 })] };
    expect(layerFailures(afterA)).toBe(2);
    const afterS = {
      ...base,
      escalations: [
        escalation({ qualityFailures: 3 }),
        escalation({ fromTier: "A", toTier: "S", qualityFailures: 6 }),
      ],
    };
    expect(layerFailures(afterS)).toBe(0);
  });
});

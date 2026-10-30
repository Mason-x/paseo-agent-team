import { describe, expect, test } from "vitest";
import {
  type DispatchRequirement,
  dispatchRequirement,
  structuralSeats,
} from "../../shared/domain/run-engine/dispatch-requirement";
import type { RunSeatSnapshot } from "../../shared/schemas/run-engine/ledger";
import { spec } from "../fixtures/run-engine";

function task(
  overrides: Record<string, unknown> = {},
  specOverrides: Record<string, unknown> = {},
) {
  return {
    spec: spec("t1", "Ship", specOverrides),
    escalations: [],
    ...overrides,
  };
}

function seat(overrides: Partial<RunSeatSnapshot> = {}): RunSeatSnapshot {
  return {
    seatId: "seat-b1",
    tier: "B",
    agentId: "agent-b1",
    channelId: "claude",
    duties: ["implement"],
    enabled: true,
    ...overrides,
  };
}

describe("dispatchRequirement", () => {
  test("a read execution still requires produce, never review", () => {
    const read = task(
      {},
      {
        execution: "read",
        dispatchDuties: { produce: "implement", review: "review", smoke: null },
      },
    );
    expect(dispatchRequirement(read, "produce")).toEqual({
      kind: "required",
      allowedPurposes: ["member", "coordinator", "reopen"],
      requiredDuty: "implement",
      tier: "B",
    } satisfies Extract<DispatchRequirement, { kind: "required" }>);
    expect(dispatchRequirement(read, "review")).toMatchObject({
      kind: "required",
      allowedPurposes: ["reviewer"],
      requiredDuty: "review",
      tier: "A",
    });
  });

  test("architecture produce uses the frozen coordinate duty and execution tier", () => {
    const architecture = task(
      {},
      {
        level: "L4",
        tier: "S",
        dispatchDuties: { produce: "coordinate", review: "review", smoke: null },
      },
    );
    expect(dispatchRequirement(architecture, "produce")).toEqual({
      kind: "required",
      allowedPurposes: ["member", "coordinator", "reopen"],
      requiredDuty: "coordinate",
      tier: "S",
    });
  });

  test("smoke is not-applicable when devSmoke is false, even if a duty is present", () => {
    expect(dispatchRequirement(task(), "smoke")).toEqual({ kind: "not-applicable" });
  });

  test("devSmoke with a null or empty smoke duty is invalid", () => {
    expect(
      dispatchRequirement(
        task(
          {},
          {
            devSmoke: true,
            dispatchDuties: { produce: "implement", review: "review", smoke: null },
          },
        ),
        "smoke",
      ),
    ).toEqual({ kind: "invalid" });
    expect(
      dispatchRequirement(
        task(
          {},
          { devSmoke: true, dispatchDuties: { produce: "implement", review: "review", smoke: "" } },
        ),
        "smoke",
      ),
    ).toEqual({ kind: "invalid" });
  });

  test("devSmoke with a smoke duty is required at tier null", () => {
    expect(
      dispatchRequirement(
        task(
          {},
          {
            devSmoke: true,
            dispatchDuties: { produce: "implement", review: "review", smoke: "smoke" },
          },
        ),
        "smoke",
      ),
    ).toEqual({
      kind: "required",
      allowedPurposes: ["smoker"],
      requiredDuty: "smoke",
      tier: null,
    });
  });

  test("missing produce or review duty is invalid, not a guessed implement", () => {
    const missing = task({}, { dispatchDuties: { produce: "", review: "review", smoke: null } });
    expect(dispatchRequirement(missing, "produce")).toEqual({ kind: "invalid" });
    const noDuties = {
      spec: { ...spec("t1", "Ship"), dispatchDuties: undefined as never },
      escalations: [],
    };
    expect(dispatchRequirement(noDuties, "produce")).toEqual({ kind: "invalid" });
    expect(dispatchRequirement(noDuties, "review")).toEqual({ kind: "invalid" });
  });
});

describe("structuralSeats", () => {
  const produce: Extract<DispatchRequirement, { kind: "required" }> = {
    kind: "required",
    allowedPurposes: ["member", "coordinator", "reopen"],
    requiredDuty: "implement",
    tier: "B",
  };

  test("keeps roster order and drops disabled, wrong-tier, and wrong-duty seats", () => {
    const roster = [
      seat({ seatId: "seat-s1", tier: "S", duties: ["implement"] }),
      seat({ seatId: "seat-off", duties: ["implement"], enabled: false }),
      seat({ seatId: "seat-b-review", duties: ["review"] }),
      seat({ seatId: "seat-b-impl", duties: ["implement"] }),
      seat({ seatId: "seat-b-impl-2", duties: ["implement", "review"] }),
    ];
    expect(structuralSeats(roster, produce).map((entry) => entry.seatId)).toEqual([
      "seat-b-impl",
      "seat-b-impl-2",
    ]);
  });

  test("a review-only seat cannot cover produce; smoke with null tier does not filter tier", () => {
    const review: Extract<DispatchRequirement, { kind: "required" }> = {
      kind: "required",
      allowedPurposes: ["reviewer"],
      requiredDuty: "review",
      tier: "A",
    };
    const smoke: Extract<DispatchRequirement, { kind: "required" }> = {
      kind: "required",
      allowedPurposes: ["smoker"],
      requiredDuty: "smoke",
      tier: null,
    };
    const roster = [
      seat({ seatId: "seat-b-review", tier: "B", duties: ["review"] }),
      seat({ seatId: "seat-a-review", tier: "A", duties: ["review"] }),
      seat({ seatId: "seat-s-smoke", tier: "S", duties: ["smoke"] }),
    ];
    expect(structuralSeats(roster, produce).map((entry) => entry.seatId)).toEqual([]);
    expect(structuralSeats(roster, review).map((entry) => entry.seatId)).toEqual(["seat-a-review"]);
    expect(structuralSeats(roster, smoke).map((entry) => entry.seatId)).toEqual(["seat-s-smoke"]);
  });
});

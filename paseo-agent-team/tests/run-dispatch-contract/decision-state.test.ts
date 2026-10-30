import { describe, expect, test } from "vitest";
import { isDecisionPending } from "../../shared/domain/run-engine/decision-state";

describe("isDecisionPending", () => {
  test("treats only open and waiting-human as pending for ledger or DTO state", () => {
    expect(isDecisionPending({ state: "open" })).toBe(true);
    expect(isDecisionPending({ state: "waiting-human" })).toBe(true);
    expect(isDecisionPending({ state: "answered" })).toBe(false);
    expect(isDecisionPending({ state: "superseded" })).toBe(false);
    expect(isDecisionPending({ state: "limbo" })).toBe(false);
  });
});

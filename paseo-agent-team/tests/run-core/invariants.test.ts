import { describe, expect, test } from "vitest";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import { INVARIANT_CASES, NORMAL_RUN_LEDGER } from "../fixtures/run-engine";

describe("checkLedgerInvariants", () => {
  test("the normal ledger has no violations", () => {
    expect(checkLedgerInvariants(NORMAL_RUN_LEDGER)).toEqual({ ok: true });
  });

  for (const entry of INVARIANT_CASES) {
    if (entry.kind === "violation") {
      test(`${entry.id} reports ${entry.invariant}`, () => {
        const report = checkLedgerInvariants(entry.ledger);
        expect(report.ok).toBe(false);
        if (report.ok) return;
        expect(report.violations.map((item) => item.invariant)).toContain(entry.invariant);
      });
    } else {
      test(`${entry.id} stays legal`, () => {
        expect(checkLedgerInvariants(entry.ledger)).toEqual({ ok: true });
      });
    }
  }
});

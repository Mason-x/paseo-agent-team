// biome-ignore-all lint/style/noNonNullAssertion: fixture builders guarantee these indices.
import { describe, expect, test } from "vitest";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import { AT_UPDATED, INVARIANT_CASES, NORMAL_RUN_LEDGER } from "../fixtures/run-engine";

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

describe("invariant denial matrix", () => {
  test("schema failures, dependency cycles, and unknown dependencies", () => {
    const schema = checkLedgerInvariants({} as never);
    expect(schema.ok).toBe(false);
    if (!schema.ok) expect(schema.violations[0]?.invariant).toBe("I1");
    const cycle = structuredClone(NORMAL_RUN_LEDGER);
    const t1 = cycle.tasks.find((entry) => entry.spec.id === "T1")!;
    t1.spec = { ...t1.spec, deps: ["T3"] };
    const t3 = cycle.tasks.find((entry) => entry.spec.id === "T3")!;
    t3.spec = { ...t3.spec, deps: ["T1"] };
    const cyclic = checkLedgerInvariants(cycle);
    expect(cyclic.ok).toBe(false);
    if (!cyclic.ok) expect(cyclic.violations.some((entry) => entry.invariant === "I2")).toBe(true);
    const unknown = structuredClone(NORMAL_RUN_LEDGER);
    const task = unknown.tasks.find((entry) => entry.spec.id === "T3")!;
    task.spec = { ...task.spec, deps: ["missing"] };
    const dangling = checkLedgerInvariants(unknown);
    expect(dangling.ok).toBe(false);
    if (!dangling.ok) {
      expect(
        dangling.violations.some((entry) => entry.params.reason === "unknown-dependency"),
      ).toBe(true);
    }
  });

  test("I3 directory directions, invalid paths and frozen ids", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const dir = record.resources[0]!;
    const other = record.resources[0]!;
    record.resources = [
      { ...dir, claimId: "dir-a", kind: "directory", path: "src", taskId: "T2" },
      { ...other, claimId: "dir-b", kind: "directory", path: "src/nested", taskId: "T3" },
    ];
    record.tasks.find((entry) => entry.spec.id === "T3")!.state = "in_progress";
    const nested = checkLedgerInvariants(record);
    expect(nested.ok).toBe(false);
    const invalid = structuredClone(NORMAL_RUN_LEDGER);
    invalid.resources = [{ ...dir, claimId: "bad", path: "src/a.ts.", taskId: "T2" }];
    const badPath = checkLedgerInvariants(invalid);
    expect(badPath.ok).toBe(false);
    if (!badPath.ok) {
      expect(badPath.violations.some((entry) => entry.params.reason === "invalid-path")).toBe(true);
    }
    const frozen = structuredClone(NORMAL_RUN_LEDGER);
    const frozenTask = frozen.tasks.find((entry) => entry.spec.id === "T2")!;
    frozenTask.state = "blocked";
    frozenTask.phase = "frozen";
    frozenTask.frozenClaimId = "not-the-claim";
    frozen.resources[0]!.frozen = true;
    const mismatch = checkLedgerInvariants(frozen);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(
        mismatch.violations.some((entry) => entry.params.reason === "frozen-claim-mismatch"),
      ).toBe(true);
    }
  });

  test("I5 binding/revocation and I6 attempts are checked", () => {
    const revoked = structuredClone(NORMAL_RUN_LEDGER);
    const nonce = revoked.nonceRegistry.find((entry) => entry.taskId === "T2");
    if (nonce) nonce.revokedAt = AT_UPDATED;
    const revokedReport = checkLedgerInvariants(revoked);
    expect(revokedReport.ok).toBe(false);
    if (!revokedReport.ok) {
      expect(
        revokedReport.violations.some((entry) => entry.params.reason === "revoked-nonce-active"),
      ).toBe(true);
    }
    const binding = structuredClone(NORMAL_RUN_LEDGER);
    const bound = binding.nonceRegistry.find((entry) => entry.taskId === "T2");
    if (bound) bound.attempt = 2;
    expect(checkLedgerInvariants(binding).ok).toBe(false);
    const attempts = structuredClone(NORMAL_RUN_LEDGER);
    const target = attempts.tasks.find((entry) => entry.spec.id === "T2")!;
    target.attempts = 0;
    attempts.events.push({
      seq: 8,
      kind: "task-dispatched",
      at: AT_UPDATED,
      payload: { taskId: "T2" },
    } as never);
    attempts.counters.eventsThroughSeq = 8;
    const attemptReport = checkLedgerInvariants(attempts);
    expect(attemptReport.ok).toBe(false);
    if (!attemptReport.ok) {
      expect(
        attemptReport.violations.some((entry) => entry.params.reason === "behind-events"),
      ).toBe(true);
    }
  });

  test("invalid stored extensions are violations, not exceptions", () => {
    const reviews = structuredClone(NORMAL_RUN_LEDGER);
    const task = reviews.tasks.find((entry) => entry.spec.id === "T1") as unknown as {
      reviews: unknown;
    };
    task.reviews = { invalid: true };
    expect(() => checkLedgerInvariants(reviews)).not.toThrow();
    expect(checkLedgerInvariants(reviews).ok).toBe(false);
    const report = structuredClone(NORMAL_RUN_LEDGER);
    const reportTask = report.tasks.find((entry) => entry.spec.id === "T1") as unknown as {
      report: unknown;
    };
    reportTask.report = [];
    expect(checkLedgerInvariants(report).ok).toBe(false);
  });
});

describe("I3 opposite file/directory coverage", () => {
  test("file claim and covering directory claim conflict in both directions", () => {
    for (const first of ["file", "directory"] as const) {
      const record = structuredClone(NORMAL_RUN_LEDGER);
      const base = record.resources[0]!;
      record.resources = [
        {
          ...base,
          claimId: "first",
          taskId: "T2",
          kind: first,
          path: first === "file" ? "src/a.ts" : "src",
        },
        {
          ...base,
          claimId: "second",
          taskId: "T3",
          kind: first === "file" ? "directory" : "file",
          path: first === "file" ? "src" : "src/a.ts",
        },
      ];
      record.tasks.find((entry) => entry.spec.id === "T3")!.state = "in_progress";
      const reportValue = checkLedgerInvariants(record);
      expect(reportValue.ok, first).toBe(false);
      if (!reportValue.ok) {
        expect(
          reportValue.violations.some(
            (entry) => entry.invariant === "I3" && entry.params.reason === "overlapping-claim",
          ),
        ).toBe(true);
      }
    }
  });
});

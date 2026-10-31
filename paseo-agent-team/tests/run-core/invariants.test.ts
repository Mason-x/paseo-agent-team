// biome-ignore-all lint/style/noNonNullAssertion: every complete parent is asserted first.
import { describe, expect, test } from "vitest";
import {
  checkLedgerInvariants,
  occupiesExecutionSlot,
} from "../../shared/domain/run-engine/invariants";
import { type RunRecord, RunRecordSchema } from "../../shared/schemas/run-engine/ledger";
import { AT_UPDATED, NORMAL_RUN_LEDGER } from "../fixtures/run-engine";

function base(): RunRecord {
  const record = RunRecordSchema.parse(structuredClone(NORMAL_RUN_LEDGER));
  expect(checkLedgerInvariants(record)).toEqual({ ok: true });
  return record;
}
function task(record: RunRecord, id: string) {
  const found = record.tasks.find((entry) => entry.spec.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}
function issues(record: unknown) {
  const result = checkLedgerInvariants(record);
  return result.ok
    ? []
    : result.violations.map(({ invariant, path, params }) => ({
        invariant,
        path,
        reason: params.reason,
      }));
}

describe("R01g invariant single-defect preconditions", () => {
  test("the acceptedProof source is legal", () => {
    base();
  });
  test.each(["report", "reviews", "smokeReport"])(
    "old task mirror %s is rejected by I1",
    (field) => {
      const record = base();
      task(record, "t1")[field] = [];
      const result = issues(record);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ invariant: "I1", reason: "record-schema" });
    },
  );
  test("partial bytes and malformed arrays are structured I1 denials", () => {
    expect(issues({})).toEqual(
      expect.arrayContaining([expect.objectContaining({ invariant: "I1" })]),
    );
    const record = base();
    record.rawBytes = "{";
    expect(issues(record)).toEqual([
      { invariant: "I1", path: ["rawBytes"], reason: "partial-bytes" },
    ]);
  });
  test("unknown dependency is a single I2 defect", () => {
    const record = base();
    task(record, "t3").spec.deps = ["missing"];
    expect(issues(record)).toEqual([
      { invariant: "I2", path: ["tasks", "t3", "deps"], reason: "unknown-dependency" },
    ]);
  });
  test("cycle is a single I2 defect", () => {
    const record = base();
    task(record, "t1").spec.deps = ["t3"];
    task(record, "t3").spec.deps = ["t1"];
    expect(issues(record)).toEqual([
      { invariant: "I2", path: ["tasks", "t1", "deps"], reason: "cycle" },
    ]);
  });
  test("pending task holding its own claim is a single I3 defect", () => {
    const record = base();
    task(record, "t2").state = "pending";
    delete task(record, "t2").phase;
    expect(issues(record)).toEqual([
      { invariant: "I3", path: ["resources", 0], reason: "inactive-holds-claim" },
    ]);
  });
  test("frozen claim parent is legal; a wrong frozenClaimId is not", () => {
    const record = base();
    const target = task(record, "t2");
    target.state = "blocked";
    target.phase = "frozen";
    record.resources[0]!.frozen = true;
    target.frozenClaimId = record.resources[0]!.claimId;
    expect(checkLedgerInvariants(record)).toEqual({ ok: true });
    target.frozenClaimId = "wrong-claim";
    expect(issues(record)).toEqual([
      { invariant: "I3", path: ["tasks", "t2", "frozenClaimId"], reason: "frozen-claim-mismatch" },
    ]);
  });
  test("review retains a normal claim but does not consume an implementation slot", () => {
    const record = base();
    const target = task(record, "t2");
    target.state = "review";
    target.phase = "awaiting-rework";
    expect(checkLedgerInvariants(record)).toEqual({ ok: true });
    expect(occupiesExecutionSlot(record, target)).toBe(false);
    target.state = "blocked";
    target.phase = "frozen";
    record.resources[0]!.frozen = true;
    target.frozenClaimId = record.resources[0]!.claimId;
    expect(occupiesExecutionSlot(record, target)).toBe(true);
  });
  test("registry frozen identity mismatch is a single I5 defect", () => {
    const record = base();
    record.nonceRegistry.find((entry) => entry.assignmentId === "assignment-t2-a1")!.agentId =
      "other-agent";
    expect(issues(record).map((entry) => entry.reason)).toEqual([
      "nonce-binding",
      "unregistered-nonce",
    ]);
    expect(issues(record).every((entry) => entry.invariant === "I5")).toBe(true);
  });
  test("revoking a live current nonce is not a valid snapshot", () => {
    const record = base();
    const nonce = record.nonceRegistry.find((entry) => entry.assignmentId === "assignment-t2-a1")!;
    nonce.revokedAt = AT_UPDATED;
    nonce.revokeReason = "cancelled";
    expect(issues(record)).toEqual([
      {
        invariant: "I5",
        path: ["nonceRegistry", record.nonceRegistry.indexOf(nonce)],
        reason: "revoked-nonce-active",
      },
    ]);
  });
  test("actual observation watermark must cover retained receipts", () => {
    const record = base();
    const maximum = Math.max(...record.eventReceipts.map((entry) => entry.seq));
    record.counters.observationSeq = maximum - 1;
    // One watermark defect invalidates both the counter and the dependent ended proof.
    expect(issues(record)).toEqual([
      { invariant: "I6", path: ["counters", "observationSeq"], reason: "behind-receipts" },
      { invariant: "I7", path: ["tasks", "t1", "reviews"], reason: "unsettled-reviewer" },
      { invariant: "I7", path: ["assignments", 1, "endedEventKey"], reason: "invalid-ended-proof" },
    ]);
  });
  test("removing only the completed reviewer bundle is I7, not schema corruption", () => {
    const record = base();
    const id = "assignment-t1-r1";
    record.assignments = record.assignments.filter((entry) => entry.assignmentId !== id);
    record.nonceRegistry = record.nonceRegistry.filter((entry) => entry.assignmentId !== id);
    record.outbox = record.outbox.filter((entry) => entry.assignmentId !== id);
    expect(RunRecordSchema.safeParse(record).success).toBe(true);
    expect(issues(record)).toEqual([
      { invariant: "I7", path: ["tasks", "t1", "reviews"], reason: "no-reviewer" },
    ]);
  });
  test("wrong dispatch recipient is a single I8 defect", () => {
    const record = base();
    record.outbox.find((entry) => entry.id === "intent-t2-a1")!.recipient = "other-agent";
    expect(issues(record)).toEqual([
      {
        invariant: "I8",
        path: [
          "assignments",
          record.assignments.findIndex((entry) => entry.assignmentId === "assignment-t2-a1"),
        ],
        reason: "assignment-without-intent",
      },
    ]);
  });
});

// Static self-check for the fixture set. It imports only fixture data: no Run Engine module exists
// in batch A yet, so asserting schema/reducer behavior here would silently depend on unimplemented
// code. These checks catch malformed samples, drifting counts, and accidental secrets/paths.
import { describe, expect, test } from "vitest";
import {
  BLOCKED_LEDGER,
  buildOversizedLedger,
  CANCELLING_LEDGER,
  CLOSED_AFTER_REPORT_LEDGER,
  CLOSED_WHILE_ASSIGNED_LEDGER,
  CONTROL_ATTEMPTS_LEDGER,
  CORRUPT_JSON_TEXTS,
  CORRUPT_MISSING_FIELDS,
  CORRUPT_RECORD_WITH_DIGEST,
  INVARIANT_CASES,
  LOCK_CONFLICT_RUN_A,
  LOCK_CONFLICT_RUN_B,
  NORMAL_RUN_LEDGER,
  OUTCOME_UNKNOWN_LEDGER,
  OVERLONG_FIELDS_LEDGER,
  PROBE_BLOCKED_INFLIGHT_TURN_LEDGER,
  PROBE_COMPLETED_LEDGER,
  PROBE_CONFLICT_RUN_A,
  PROBE_CONFLICT_RUN_B,
  PROBE_ELIGIBLE_LEDGER,
  PROBE_FAILED_LEDGER,
  PROBE_IN_FLIGHT_LEDGER,
  PROBE_SAME_CHANNEL_SEATS_LEDGER,
  PROBE_UNKNOWN_LEDGER,
  QUIESCENT_CANCELLED_LEDGER,
  REOPEN_STARTED_LEDGER,
  RUN_ENGINE_FIXTURE_MANIFEST,
  UNKNOWN_SCHEMA_VERSION_LEDGER,
  UNKNOWN_TASK_STATUS_RECORD,
} from "./index";
import type { LedgerFixture } from "./types";

const LEDGERS: { id: string; ledger: LedgerFixture }[] = [
  { id: "normal-ledger", ledger: NORMAL_RUN_LEDGER },
  { id: "outcome-unknown-ledger", ledger: OUTCOME_UNKNOWN_LEDGER },
  { id: "cancelling-ledger", ledger: CANCELLING_LEDGER },
  { id: "quiescent-cancelled-ledger", ledger: QUIESCENT_CANCELLED_LEDGER },
  { id: "blocked-ledger", ledger: BLOCKED_LEDGER },
  { id: "unknown-schema-version-ledger", ledger: UNKNOWN_SCHEMA_VERSION_LEDGER },
  { id: "overlong-fields-ledger", ledger: OVERLONG_FIELDS_LEDGER },
  { id: "lock-conflict-run-a", ledger: LOCK_CONFLICT_RUN_A },
  { id: "lock-conflict-run-b", ledger: LOCK_CONFLICT_RUN_B },
  { id: "probe-conflict-run-a", ledger: PROBE_CONFLICT_RUN_A },
  { id: "probe-conflict-run-b", ledger: PROBE_CONFLICT_RUN_B },
  { id: "probe-same-channel-seats", ledger: PROBE_SAME_CHANNEL_SEATS_LEDGER },
  { id: "closed-after-report", ledger: CLOSED_AFTER_REPORT_LEDGER },
  { id: "closed-while-assigned", ledger: CLOSED_WHILE_ASSIGNED_LEDGER },
  { id: "reopen-started", ledger: REOPEN_STARTED_LEDGER },
  { id: "control-attempts", ledger: CONTROL_ATTEMPTS_LEDGER },
  { id: "probe-eligible", ledger: PROBE_ELIGIBLE_LEDGER },
  { id: "probe-blocked-inflight-turn", ledger: PROBE_BLOCKED_INFLIGHT_TURN_LEDGER },
  { id: "probe-in-flight", ledger: PROBE_IN_FLIGHT_LEDGER },
  { id: "probe-completed", ledger: PROBE_COMPLETED_LEDGER },
  { id: "probe-failed", ledger: PROBE_FAILED_LEDGER },
  { id: "probe-unknown", ledger: PROBE_UNKNOWN_LEDGER },
];

describe("run engine fixture integrity", () => {
  test("every ledger sample is plain JSON and carries a unique runId", () => {
    const runIds = new Set<string>();
    for (const { id, ledger } of LEDGERS) {
      expect(JSON.parse(JSON.stringify(ledger)), id).toEqual(ledger);
      expect(ledger.schemaVersion, id).toBeTypeOf("number");
      expect(ledger.runId, id).toMatch(/^run-[a-z0-9]+-[a-z0-9]+$/);
      expect(runIds.has(ledger.runId), `${id} reuses ${ledger.runId}`).toBe(false);
      runIds.add(ledger.runId);

      const taskIds = ledger.tasks.map((entry) => entry.id);
      expect(new Set(taskIds).size, `${id} duplicate task id`).toBe(taskIds.length);
      const messageIds = ledger.outbox.map((entry) => entry.messageId);
      expect(new Set(messageIds).size, `${id} duplicate messageId`).toBe(messageIds.length);
    }
  });

  test("the oversized sample is over the record cap and the unknown version keeps its payload", () => {
    const oversized = buildOversizedLedger();
    expect(JSON.stringify(oversized).length).toBeGreaterThan(
      NORMAL_RUN_LEDGER.policy.limits.maxBytes,
    );
    expect(UNKNOWN_SCHEMA_VERSION_LEDGER.schemaVersion).toBe(2);
    expect(UNKNOWN_SCHEMA_VERSION_LEDGER.futureTopLevel).toBeDefined();
    expect(UNKNOWN_SCHEMA_VERSION_LEDGER.tasks[0]?.futureTaskField).toBeDefined();
    expect(UNKNOWN_TASK_STATUS_RECORD).toBeTruthy();
  });

  test("corrupt samples are genuinely unparseable or explicitly missing fields", () => {
    for (const sample of CORRUPT_JSON_TEXTS) {
      expect(() => JSON.parse(sample.text), sample.id).toThrow();
    }
    for (const sample of CORRUPT_MISSING_FIELDS) {
      expect(sample.missing.length, sample.id).toBeGreaterThan(0);
      expect(JSON.stringify(sample.value), sample.id).not.toBeUndefined();
    }
    expect(CORRUPT_RECORD_WITH_DIGEST.diagnosis.autoRepair).toBe(false);
    expect(CORRUPT_RECORD_WITH_DIGEST.diagnosis.preserveOriginalBytes).toBe(true);
  });

  test("invariant cases cover I1–I8 with legal edges and no duplicated id", () => {
    const ids = INVARIANT_CASES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const invariant of ["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8"] as const) {
      const cases = INVARIANT_CASES.filter((entry) => entry.invariant === invariant);
      expect(cases.length, `${invariant} has no case`).toBeGreaterThan(0);
      expect(
        cases.some((entry) => entry.kind === "violation"),
        `${invariant} needs a violation`,
      ).toBe(true);
    }
    for (const invariant of ["I2", "I3", "I4", "I5"] as const) {
      expect(
        INVARIANT_CASES.some((entry) => entry.invariant === invariant && entry.kind === "legal"),
        `${invariant} needs a legal edge`,
      ).toBe(true);
    }
  });

  test("the manifest counts match the exported samples", () => {
    const groups = RUN_ENGINE_FIXTURE_MANIFEST.groups;
    expect(groups.ledgers.count).toBe(8);
    expect(groups.corrupt.count).toBe(
      CORRUPT_JSON_TEXTS.length + CORRUPT_MISSING_FIELDS.length + 2,
    );
    expect(groups.locks.count).toBe(9);
    expect(groups.reopen.count).toBe(3);
    expect(groups.control.count).toBe(7);
    expect(groups.invariantCases.count).toBe(INVARIANT_CASES.length);
    expect(RUN_ENGINE_FIXTURE_MANIFEST.totals.samples).toBe(
      Object.values(groups).reduce((sum, group) => sum + group.count, 0),
    );
    for (const group of Object.values(groups)) {
      expect(group.ids.length, "manifest id list").toBe(group.count);
    }
  });

  test("samples never embed secrets, host paths, or the forbidden receipts directory", () => {
    const serialized = JSON.stringify([
      ...LEDGERS.map((entry) => entry.ledger),
      CORRUPT_MISSING_FIELDS,
      INVARIANT_CASES,
      buildOversizedLedger().tasks,
    ]);
    for (const forbidden of [
      "agent-requests/",
      "API_KEY",
      "Authorization",
      "apiKey",
      "C:\\Users\\cc",
      "%USERPROFILE%",
    ]) {
      expect(serialized.includes(forbidden), `fixture leaks ${forbidden}`).toBe(false);
    }
  });
});

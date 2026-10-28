// Static self-check for the fixture set against the implemented R01 contracts. Valid samples must
// parse; corrupt/over-version/overlong samples must be rejected. No reducer behavior is asserted.
import { describe, expect, test } from "vitest";
import { RunTeamEngineConfigSchema } from "../../../shared/schemas/run-engine/config";
import { RunRecordSchema } from "../../../shared/schemas/run-engine/ledger";
import { RunTaskReportBlockSchema } from "../../../shared/schemas/run-engine/protocol";
import { RunGetInputSchema } from "../../../shared/schemas/run-engine/rpc";
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
  DEV_SMOKE_MISSING_LEDGER,
  DEV_SMOKE_READY_LEDGER,
  EMPTY_EVIDENCE_REPORT,
  EVIDENCE_INCOMPLETE_LEDGER,
  FINISHED_DECISION_LEDGER,
  INVARIANT_CASES,
  IRREVERSIBLE_UNAPPROVED_LEDGER,
  LOCK_CONFLICT_RUN_A,
  LOCK_CONFLICT_RUN_B,
  NON_ASSIGNEE_REPORT,
  NORMAL_RUN_LEDGER,
  OUTCOME_UNKNOWN_LEDGER,
  OVERLONG_FIELDS_LEDGER,
  PERMISSION_PENDING_LEDGER,
  PROBE_BLOCKED_INFLIGHT_TURN_LEDGER,
  PROBE_COMPLETED_LEDGER,
  PROBE_CONFLICT_RUN_A,
  PROBE_CONFLICT_RUN_B,
  PROBE_ELIGIBLE_LEDGER,
  PROBE_FAILED_LEDGER,
  PROBE_IN_FLIGHT_LEDGER,
  PROBE_SAME_CHANNEL_SEATS_LEDGER,
  PROBE_UNKNOWN_LEDGER,
  PROTOCOL_IDENTITY_CASES,
  PROTOCOL_REPLAY_CASE,
  policy,
  QUIESCENT_CANCELLED_LEDGER,
  REOPEN_STARTED_LEDGER,
  RUN_ENGINE_FIXTURE_MANIFEST,
  STALE_REVIEW_LEDGER,
  UNKNOWN_SCHEMA_VERSION_RECORD,
  UNKNOWN_TASK_STATUS_RECORD,
} from "./index";
import type { LedgerFixture } from "./types";

const NAMED_LEDGERS: { id: string; ledger: LedgerFixture }[] = [
  { id: "normal-ledger", ledger: NORMAL_RUN_LEDGER },
  { id: "outcome-unknown-ledger", ledger: OUTCOME_UNKNOWN_LEDGER },
  { id: "cancelling-ledger", ledger: CANCELLING_LEDGER },
  { id: "quiescent-cancelled-ledger", ledger: QUIESCENT_CANCELLED_LEDGER },
  { id: "blocked-ledger", ledger: BLOCKED_LEDGER },
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
  { id: "evidence-incomplete", ledger: EVIDENCE_INCOMPLETE_LEDGER },
  { id: "stale-review", ledger: STALE_REVIEW_LEDGER },
  { id: "dev-smoke-missing", ledger: DEV_SMOKE_MISSING_LEDGER },
  { id: "dev-smoke-ready", ledger: DEV_SMOKE_READY_LEDGER },
  { id: "permission-pending", ledger: PERMISSION_PENDING_LEDGER },
  { id: "irreversible-unapproved", ledger: IRREVERSIBLE_UNAPPROVED_LEDGER },
  { id: "finished-decision", ledger: FINISHED_DECISION_LEDGER },
];

// Invariant cases are complete records too: schema validity is separate from invariant validity.
const INVARIANT_LEDGERS: { id: string; ledger: LedgerFixture }[] = INVARIANT_CASES.map((entry) => ({
  id: entry.id,
  ledger: entry.ledger as LedgerFixture,
}));

const LEGAL_LEDGERS = [...NAMED_LEDGERS, ...INVARIANT_LEDGERS];

const INVALID: { id: string; value: unknown; paths: readonly string[] }[] = [
  {
    id: "unknown-schema-version",
    value: UNKNOWN_SCHEMA_VERSION_RECORD,
    paths: ["schemaVersion"],
  },
  {
    id: "overlong-fields",
    value: OVERLONG_FIELDS_LEDGER,
    paths: [
      "tasks.0.spec.title",
      "tasks.0.spec.goal",
      "tasks.0.spec.scopes.0.path",
      "tasks.0.spec.acceptance.0",
    ],
  },
  {
    id: "unknown-task-status",
    value: UNKNOWN_TASK_STATUS_RECORD,
    paths: ["tasks.0.state"],
  },
  ...CORRUPT_MISSING_FIELDS.map((entry) => ({
    id: entry.id,
    value: entry.value,
    paths: entry.missing,
  })),
];

const VALID_REPORTS: { id: string; report: unknown }[] = [
  { id: "protocol-replay", report: PROTOCOL_REPLAY_CASE.report },
  ...PROTOCOL_IDENTITY_CASES.filter((entry) => entry.id !== "non-assignee").map((entry) => ({
    id: entry.id,
    report: entry.report,
  })),
];

const INVALID_REPORTS: { id: string; report: unknown; paths: readonly string[] }[] = [
  { id: "missing-evidence", report: EMPTY_EVIDENCE_REPORT, paths: ["evidence"] },
];

/**
 * Schema-valid samples rejected by a later layer. `non-assignee` cannot be expressed by R01 (no
 * reporter field), so it must not be forced into the illegal group with extra keys.
 */
const BOUNDARIES: { id: string; rejectedBy: string; accepted: () => boolean }[] = [
  {
    id: "oversized-ledger",
    rejectedBy: "R05 store byte cap (AC-RE1.12)",
    accepted: () => RunRecordSchema.safeParse(buildOversizedLedger()).success,
  },
  {
    id: "non-assignee-report",
    rejectedBy: "R05/R06 assignment+nounce ownership",
    accepted: () => RunTaskReportBlockSchema.safeParse(NON_ASSIGNEE_REPORT).success,
  },
];

type ParseResult =
  | { success: true }
  | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };

function rejectionDetail(result: ParseResult): string {
  if (result.success) return "accepted";
  const [issue] = result.error.issues;
  return issue ? `${issue.path.join(".") || "<root>"}: ${issue.message}` : "rejected";
}

/** Each negative sample declares every zod issue path it must produce, in any order. */
function issuePathMismatch(
  id: string,
  result: ParseResult,
  expected: readonly string[],
): string | null {
  if (result.success) return `${id}: accepted, expected rejection at [${expected.join(", ")}]`;
  const actual = result.error.issues.map((issue) => issue.path.join(".")).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((path, index) => path !== wanted[index])) {
    return `${id}: expected [${wanted.join(", ")}], got [${actual.join(", ")}]`;
  }
  return null;
}

describe("run engine fixtures against R01 schemas", () => {
  test("legal samples parse and negative samples reject for their declared cause", () => {
    expect(NAMED_LEDGERS.length, "named ledger count").toBe(27);
    expect(LEGAL_LEDGERS.length, "legal ledger count").toBe(40);
    expect(INVALID.length, "illegal ledger count").toBe(8);
    expect(VALID_REPORTS.length, "legal report count").toBe(5);
    expect(INVALID_REPORTS.length, "illegal report count").toBe(1);
    expect(BOUNDARIES.length, "later-layer boundary count").toBe(2);

    const rejectedLegalLedgers = LEGAL_LEDGERS.flatMap(({ id, ledger }) => {
      const parsed = RunRecordSchema.safeParse(ledger);
      return parsed.success ? [] : [`${id} (${rejectionDetail(parsed)})`];
    });
    expect(rejectedLegalLedgers, "legal ledgers must parse").toEqual([]);

    const illegalLedgerFailures = INVALID.flatMap(({ id, value, paths }) => {
      const detail = issuePathMismatch(id, RunRecordSchema.safeParse(value), paths);
      return detail ? [detail] : [];
    });
    expect(
      illegalLedgerFailures,
      "each illegal ledger has exactly its declared issue paths",
    ).toEqual([]);

    const rejectedLegalReports = VALID_REPORTS.flatMap(({ id, report }) => {
      const parsed = RunTaskReportBlockSchema.safeParse(report);
      return parsed.success ? [] : [`${id} (${rejectionDetail(parsed)})`];
    });
    expect(rejectedLegalReports, "legal reports must parse").toEqual([]);

    // `missing-evidence` is illegal: AC-RE2.3 rejects a done report with no evidence.
    const illegalReportFailures = INVALID_REPORTS.flatMap(({ id, report, paths }) => {
      const detail = issuePathMismatch(id, RunTaskReportBlockSchema.safeParse(report), paths);
      return detail ? [detail] : [];
    });
    expect(
      illegalReportFailures,
      "each illegal report has exactly its declared issue paths",
    ).toEqual([]);

    const rejectedBoundaries = BOUNDARIES.filter((boundary) => !boundary.accepted()).map(
      (boundary) => boundary.id,
    );
    expect(rejectedBoundaries, "schema must accept the later-layer boundaries").toEqual([]);

    const legalTotal = LEGAL_LEDGERS.length + VALID_REPORTS.length;
    const illegalTotal = INVALID.length + INVALID_REPORTS.length;
    console.log(
      `[run-engine fixtures] legal ${legalTotal}/${legalTotal} accepted ` +
        `(ledgers ${LEGAL_LEDGERS.length}/${LEGAL_LEDGERS.length}, reports ${VALID_REPORTS.length}/${VALID_REPORTS.length})`,
    );
    console.log(
      `[run-engine fixtures] illegal ${illegalTotal}/${illegalTotal} rejected at their declared paths ` +
        `(ledgers ${INVALID.length}/${INVALID.length}, reports ${INVALID_REPORTS.length}/${INVALID_REPORTS.length}; ` +
        "missing-evidence=[] is illegal)",
    );
    console.log(
      `[run-engine fixtures] schema-accepted, later-layer-rejected boundaries ${BOUNDARIES.length}/${BOUNDARIES.length} ` +
        `(${BOUNDARIES.map((boundary) => `${boundary.id} → ${boundary.rejectedBy}`).join("; ")})`,
    );
  });

  test("valid samples are plain JSON and keep unique ids", () => {
    const runIds = new Set<string>();
    for (const { id, ledger } of NAMED_LEDGERS) {
      expect(JSON.parse(JSON.stringify(ledger)), id).toEqual(ledger);
      expect(runIds.has(ledger.runId), `${id} reuses ${ledger.runId}`).toBe(false);
      runIds.add(ledger.runId);
      const taskIds = ledger.tasks.map((entry) => entry.spec.id);
      expect(new Set(taskIds).size, `${id} duplicate task id`).toBe(taskIds.length);
    }
  });

  test("corrupt bytes never parse and diagnosis keeps the original payload", () => {
    for (const sample of CORRUPT_JSON_TEXTS) {
      expect(() => JSON.parse(sample.text), sample.id).toThrow();
    }
    expect(CORRUPT_RECORD_WITH_DIGEST.diagnosis.autoRepair).toBe(false);
    expect(CORRUPT_RECORD_WITH_DIGEST.diagnosis.preserveOriginalBytes).toBe(true);
  });

  test("protocol, rpc, and config contracts reject unknown versions and extra keys", () => {
    // Report validity (including empty evidence) is counted in the first test.
    expect(
      RunTaskReportBlockSchema.safeParse({
        ...PROTOCOL_REPLAY_CASE.report,
        protocolVersion: 2,
      }).success,
    ).toBe(false);

    const config = {
      version: 1,
      enabled: true,
      seats: [
        { seatId: "seat-b1", tier: "B", duties: ["implement"], channelId: "claude", enabled: true },
      ],
      policy: policy(),
    };
    expect(RunTeamEngineConfigSchema.safeParse(config).success).toBe(true);
    expect(RunTeamEngineConfigSchema.safeParse({ ...config, version: 2 }).success).toBe(false);
    expect(
      RunGetInputSchema.safeParse({ runContractVersion: 1, runId: NORMAL_RUN_LEDGER.runId })
        .success,
    ).toBe(true);
    expect(
      RunGetInputSchema.safeParse({
        runContractVersion: 1,
        runId: NORMAL_RUN_LEDGER.runId,
        extra: true,
      }).success,
    ).toBe(false);
  });

  test("invariant cases cover I1–I8 with legal edges and no duplicated id", () => {
    const ids = INVARIANT_CASES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const invariant of ["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8"] as const) {
      const cases = INVARIANT_CASES.filter((entry) => entry.invariant === invariant);
      expect(cases.length, `${invariant} has no case`).toBeGreaterThan(0);
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
      ...LEGAL_LEDGERS.map((entry) => entry.ledger),
      VALID_REPORTS,
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

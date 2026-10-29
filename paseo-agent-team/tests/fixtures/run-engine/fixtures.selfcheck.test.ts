// Static self-check for the fixture set against the implemented R01 contracts. Valid samples must
// parse; corrupt/over-version/overlong samples must be rejected. No reducer behavior is asserted.
import { describe, expect, test } from "vitest";
import { RunTeamEngineConfigSchema } from "../../../shared/schemas/run-engine/config";
import {
  RunRecordSchema,
  RunStoredTaskReportSchema,
} from "../../../shared/schemas/run-engine/ledger";
import { RunTaskReportBlockSchema } from "../../../shared/schemas/run-engine/protocol";
import { RunGetInputSchema } from "../../../shared/schemas/run-engine/rpc";
import {
  AT_UPDATED,
  BLOCKED_LEDGER,
  buildOversizedLedger,
  CANCELLATION_AUTHORIZED_FROZEN_LEDGER,
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
  LOCAL_NEVER_SENT_CANCELLED_LEDGER,
  LOCK_CONFLICT_RUN_A,
  LOCK_CONFLICT_RUN_B,
  MESSAGE_CANCEL,
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
import type { LedgerFixture, RunAssignment } from "./types";

const NAMED_LEDGERS: { id: string; ledger: LedgerFixture }[] = [
  { id: "normal-ledger", ledger: NORMAL_RUN_LEDGER },
  { id: "outcome-unknown-ledger", ledger: OUTCOME_UNKNOWN_LEDGER },
  { id: "cancelling-ledger", ledger: CANCELLING_LEDGER },
  { id: "cancellation-authorized-frozen", ledger: CANCELLATION_AUTHORIZED_FROZEN_LEDGER },
  { id: "quiescent-cancelled-ledger", ledger: QUIESCENT_CANCELLED_LEDGER },
  { id: "local-never-sent-cancelled-ledger", ledger: LOCAL_NEVER_SENT_CANCELLED_LEDGER },
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
const SOURCE_LEDGERS = [
  ...NAMED_LEDGERS,
  ...INVARIANT_CASES.filter((entry) => entry.kind !== "violation").map((entry) => ({
    id: entry.id,
    ledger: entry.ledger as LedgerFixture,
  })),
];

function evidenceSatisfied(
  task: LedgerFixture["tasks"][number],
  proof: NonNullable<RunAssignment["acceptedProof"]>,
): boolean {
  const parsed = RunStoredTaskReportSchema.safeParse(proof);
  if (!parsed.success || parsed.data.status !== "done") return false;
  return task.spec.evidence.every((required) => {
    const evidence = parsed.data.evidence.find((entry) => entry.id === required.id);
    return evidence !== undefined && evidence.exitCode === 0;
  });
}

/** A valid current D requires a producer done report whose required evidence passed. */
function validProducerD(record: LedgerFixture, assignment: RunAssignment): boolean {
  if (!["member", "coordinator", "reopen"].includes(assignment.purpose)) return false;
  const proof = assignment.acceptedProof;
  if (proof === null) return false;
  const task = record.tasks.find((entry) => entry.spec.id === assignment.taskId);
  return task !== undefined && evidenceSatisfied(task, proof);
}

function assertCompleteCancellation(
  id: string,
  record: LedgerFixture,
  assignment: RunAssignment,
): void {
  const cancellation = assignment.cancellation;
  if (!cancellation) throw new Error(`${id} complete cancellation missing evidence`);
  expect(cancellation.assignmentId, `${id} cancellation assignment`).toBe(assignment.assignmentId);
  expect(assignment.turnId, `${id} cancellation turn`).not.toBeNull();
  expect(assignment.endedAt, `${id} cancellation endedAt`).not.toBeNull();
  if (assignment.turnId === null || assignment.endedAt === null) return;
  expect(cancellation.lastTurnId, `${id} cancellation last turn`).toBe(assignment.turnId);
  expect(cancellation.assignmentId, `${id} cancellation own assignment`).toBe(
    assignment.assignmentId,
  );
  expect(cancellation.refresh.activeTurn, `${id} cancellation activeTurn`).toBe(false);
  expect(
    Date.parse(cancellation.refresh.observedAt) >= Date.parse(assignment.endedAt),
    `${id} cancellation refresh time`,
  ).toBe(true);
  expect(cancellation.observationSeq, `${id} cancellation watermark`).toBeLessThanOrEqual(
    record.counters.observationSeq,
  );
  expect(cancellation.endedEventKey, `${id} cancellation ended key`).not.toBeNull();
  const ended = record.eventReceipts.find(
    (entry) =>
      entry.eventKey === cancellation.endedEventKey &&
      entry.kind === "turn_ended" &&
      entry.agentId === assignment.agentId &&
      entry.turnId === assignment.turnId &&
      entry.receivedAt === assignment.endedAt,
  );
  expect(ended, `${id} cancellation ended receipt`).toBeDefined();
  const intent = record.outbox.find((entry) => entry.id === cancellation.cancelIntentId);
  expect(intent, `${id} cancellation intent`).toBeDefined();
  if (intent) {
    expect(intent.kind, `${id} cancellation intent kind`).toBe("archive");
    expect(intent.taskId, `${id} cancellation intent task`).toBe(assignment.taskId);
    expect(intent.assignmentId, `${id} cancellation intent assignment`).toBe(
      assignment.assignmentId,
    );
    expect(intent.recipient, `${id} cancellation intent recipient`).toBe(assignment.agentId);
    expect(intent.state, `${id} cancellation intent state`).toBe("confirmed");
    expect(intent.confirmedAt, `${id} cancellation intent confirmed`).not.toBeNull();
  }
  expect(cancellation.receipt.kind, `${id} cancellation receipt kind`).toBe("archive");
  expect(cancellation.receipt.confirmedAt, `${id} cancellation receipt confirmed`).not.toBeNull();
  expect(cancellation.receipt.externalId, `${id} cancellation receipt external`).not.toBeNull();
  const task = record.tasks.find((entry) => entry.spec.id === assignment.taskId);
  expect(task, `${id} cancellation task`).toBeDefined();
  if (task?.state !== "cancelled") throw new Error(`${id} cancellation task state`);
  const decision = record.decisions.find(
    (entry) => entry.subjectId === task.spec.id && entry.state === "answered",
  );
  expect(decision, `${id} cancellation decision`).toBeDefined();
  if (decision) {
    expect(decision.dedupeKey, `${id} cancellation dedupe`).toBe(`cancel:${task.spec.id}`);
    expect(["cancel", "assign-seat"], `${id} cancellation action`).toContain(
      decision.answer?.action,
    );
    expect(decision.answer?.taskIds, `${id} cancellation task coverage`).toContain(task.spec.id);
    expect(decision.cancelIntents, `${id} cancellation pairs`).not.toBeNull();
    expect(decision.cancelIntents ?? [], `${id} cancellation pair`).toContainEqual({
      assignmentId: assignment.assignmentId,
      intentId: cancellation.cancelIntentId,
    });
  }
}

function isLocalNeverSent(record: LedgerFixture, assignment: RunAssignment): boolean {
  if (
    assignment.cancellation !== null ||
    assignment.endedEventKey !== null ||
    assignment.turnId !== null ||
    assignment.endedAt !== null ||
    assignment.acceptedProof !== null
  ) {
    return false;
  }
  const intent = record.outbox.find(
    (entry) => entry.kind === "dispatch" && entry.assignmentId === assignment.assignmentId,
  );
  if (intent?.state !== "failed" || intent.confirmedAt !== null) return false;
  if (intent.recoverySendCount !== 0 || intent.localCancellation === null) return false;
  if (
    intent.taskId !== assignment.taskId ||
    intent.recipient !== assignment.agentId ||
    intent.messageId !== assignment.messageId
  ) {
    return false;
  }
  if (intent.localCancellation.reason !== "cancel-before-send") return false;
  if (intent.localCancellation.eventSeq > record.counters.eventsThroughSeq) return false;
  return !record.outbox.some(
    (entry) => entry.kind === "archive" && entry.assignmentId === assignment.assignmentId,
  );
}

/** Test-only source association checks. This is not the product I7 implementation. */
function assertAssociations(id: string, record: LedgerFixture): void {
  for (const assignment of record.assignments) {
    const proof = assignment.acceptedProof;
    const nonce = record.nonceRegistry.find(
      (entry) => entry.assignmentId === assignment.assignmentId,
    );
    if (proof !== null) {
      expect(proof.runId, `${id} proof run`).toBe(record.runId);
      expect(proof.taskId, `${id} proof task`).toBe(assignment.taskId);
      expect(proof.attempt, `${id} proof attempt`).toBe(assignment.attempt);
      expect(proof.assignmentId, `${id} proof assignment`).toBe(assignment.assignmentId);
      expect(proof.nonce, `${id} proof nonce`).toBe(assignment.nonce);
      expect(proof.messageId, `${id} proof message`).toBe(assignment.messageId);
      expect(nonce, `${id} accepted nonce`).toBeDefined();
      if (nonce) {
        expect(nonce.acceptedAt, `${id} acceptedAt`).not.toBeNull();
        expect(nonce.acceptedEventKey, `${id} accepted key`).toBe(
          `proof:${assignment.assignmentId}`,
        );
        if (nonce.acceptedAt) {
          expect(
            Date.parse(nonce.acceptedAt) >= Date.parse(nonce.issuedAt),
            `${id} accept time`,
          ).toBe(true);
          if (nonce.revokedAt) {
            expect(Date.parse(nonce.revokedAt) >= Date.parse(nonce.acceptedAt)).toBe(true);
          }
        }
      }
      const dispatches = record.outbox.filter(
        (entry) => entry.kind === "dispatch" && entry.assignmentId === assignment.assignmentId,
      );
      expect(dispatches, `${id} dispatch count`).toHaveLength(1);
      const dispatch = dispatches[0];
      if (dispatch) {
        expect(dispatch.taskId).toBe(assignment.taskId);
        expect(dispatch.recipient).toBe(assignment.agentId);
        expect(dispatch.messageId).toBe(assignment.messageId);
      }
      if (assignment.purpose !== "reviewer" && assignment.purpose !== "smoker") {
        expect(assignment.delivery).toBeNull();
      }
    } else if (nonce) {
      expect(nonce.acceptedAt, `${id} unaccepted At`).toBeNull();
      expect(nonce.acceptedEventKey, `${id} unaccepted key`).toBeNull();
    }
    const task = record.tasks.find((entry) => entry.spec.id === assignment.taskId);
    expect(task, `${id} assignment task`).toBeDefined();
    const seat = record.roster.find((entry) => entry.seatId === assignment.seatId);
    expect(seat, `${id} roster seat`).toBeDefined();
    if (seat) {
      expect(seat.agentId, `${id} seat agent`).toBe(assignment.agentId);
      expect(seat.tier, `${id} seat tier`).toBe(assignment.tier);
      if (task) {
        const duty =
          assignment.purpose === "reviewer"
            ? task.spec.dispatchDuties.review
            : assignment.purpose === "smoker"
              ? task.spec.dispatchDuties.smoke
              : task.spec.dispatchDuties.produce;
        expect(duty, `${id} duty`).not.toBeNull();
        if (duty) expect(seat.duties, `${id} seat duty`).toContain(duty);
      }
    }
    if (assignment.purpose === "reviewer" || assignment.purpose === "smoker") {
      expect(assignment.delivery, `${id} delivery`).not.toBeNull();
      const producerId = assignment.delivery?.producerAssignmentId;
      const producer = record.assignments.find((entry) => entry.assignmentId === producerId);
      expect(producer, `${id} producer`).toBeDefined();
      expect(producer?.taskId).toBe(assignment.taskId);
      expect(producer?.attempt).toBe(assignment.attempt);
      expect(["member", "coordinator", "reopen"], `${id} producer purpose`).toContain(
        producer?.purpose,
      );
      expect(producer?.acceptedProof, `${id} producer proof`).not.toBeNull();
      if (producer?.acceptedProof) {
        expect("status" in producer.acceptedProof, `${id} producer report kind`).toBe(true);
        if ("status" in producer.acceptedProof) {
          expect(producer.acceptedProof.status, `${id} producer done`).toBe("done");
        }
        expect(validProducerD(record, producer), `${id} producer evidence`).toBe(true);
      }
      expect(producer?.agentId, `${id} independent agent`).not.toBe(assignment.agentId);
      expect(producer?.seatId, `${id} independent seat`).not.toBe(assignment.seatId);
    }
    if (assignment.cancellation) {
      const cancelIntent = record.outbox.find(
        (entry) => entry.id === assignment.cancellation?.cancelIntentId,
      );
      expect(cancelIntent, `${id} cancel evidence intent`).toBeDefined();
      if (cancelIntent) {
        expect(cancelIntent.kind).toBe("archive");
        expect(cancelIntent.taskId).toBe(assignment.taskId);
        expect(cancelIntent.assignmentId).toBe(assignment.assignmentId);
        expect(cancelIntent.recipient).toBe(assignment.agentId);
      }
    }
    if (assignment.state === "ended") {
      expect(assignment.turnId, `${id} ended turn required`).not.toBeNull();
      expect(assignment.endedAt, `${id} ended at required`).not.toBeNull();
      expect(assignment.endedEventKey, `${id} ended key required`).not.toBeNull();
    }
    if (assignment.state === "cancelled") {
      if (assignment.cancellation !== null) {
        assertCompleteCancellation(id, record, assignment);
      } else {
        expect(isLocalNeverSent(record, assignment), `${id} local never sent`).toBe(true);
      }
    }
    if (assignment.endedEventKey !== null) {
      expect(assignment.turnId, `${id} ended turn`).not.toBeNull();
      expect(assignment.endedAt, `${id} ended at`).not.toBeNull();
      const receipt = record.eventReceipts.find(
        (entry) =>
          entry.eventKey === assignment.endedEventKey &&
          entry.kind === "turn_ended" &&
          entry.agentId === assignment.agentId &&
          entry.turnId === assignment.turnId &&
          entry.receivedAt === assignment.endedAt,
      );
      expect(receipt, `${id} ended receipt`).toBeDefined();
    }
  }
  for (const task of record.tasks) {
    const producers = record.assignments.filter(
      (entry) => entry.taskId === task.spec.id && validProducerD(record, entry),
    );
    producers.sort((a, b) => b.attempt - a.attempt);
    const proof = producers[0]?.acceptedProof;
    if (proof && "ref" in proof && "changedFiles" in proof) {
      expect(task.ref, `${id} task cache ref`).toEqual(proof.ref);
      expect(task.changedFiles, `${id} task cache files`).toEqual(proof.changedFiles);
    } else {
      expect(task.ref, `${id} task cache ref without D`).toBeNull();
      expect(task.changedFiles, `${id} task cache files without D`).toEqual([]);
    }
    if (task.state === "done") {
      const producers = record.assignments.filter((entry) => validProducerD(record, entry));
      expect(
        producers.some((entry) => entry.taskId === task.spec.id),
        `${id} done task producer`,
      ).toBe(true);
    }
  }
  for (const claim of record.resources) {
    expect(claim.originAssignmentId, `${id} claim origin`).toMatch(/^assignment-/);
    const origin = record.assignments.find(
      (entry) => entry.assignmentId === claim.originAssignmentId,
    );
    expect(origin, `${id} claim origin exists`).toBeDefined();
    if (origin) {
      expect(origin.taskId, `${id} claim origin task`).toBe(claim.taskId);
      expect(["member", "coordinator", "reopen"], `${id} claim origin purpose`).toContain(
        origin.purpose,
      );
    }
  }
  for (const decision of record.decisions) {
    if (decision.cancelIntents === null) continue;
    const ids = decision.cancelIntents.map((entry) => entry.assignmentId);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    for (const binding of decision.cancelIntents) {
      const assignment = record.assignments.find(
        (entry) => entry.assignmentId === binding.assignmentId,
      );
      const intent = record.outbox.find((entry) => entry.id === binding.intentId);
      expect(assignment, `${id} cancel assignment`).toBeDefined();
      expect(intent, `${id} cancel intent`).toBeDefined();
      if (assignment && intent) {
        expect(intent.kind).toBe("archive");
        expect(intent.taskId).toBe(assignment.taskId);
        expect(intent.assignmentId).toBe(assignment.assignmentId);
        expect(intent.recipient).toBe(assignment.agentId);
      }
    }
  }
}

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
  test("legal/boundary fixtures bind every nonce registration to their own Run", () => {
    for (const entry of INVARIANT_CASES.filter((item) => item.kind !== "violation")) {
      const ledger = entry.ledger as {
        runId: string;
        nonceRegistry: ReadonlyArray<{ runId: string }>;
      };
      for (const nonce of ledger.nonceRegistry) {
        expect(nonce.runId, entry.id).toBe(ledger.runId);
      }
    }
  });

  test("legal samples parse and negative samples reject for their declared cause", () => {
    expect(NAMED_LEDGERS.length, "named ledger count").toBe(29);
    expect(LEGAL_LEDGERS.length, "legal ledger count").toBe(42);
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
    expect(groups.ledgers.count).toBe(9);
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

  test("authorized cancellation seed keeps its 14 source/status links", () => {
    const record = RunRecordSchema.parse(CANCELLATION_AUTHORIZED_FROZEN_LEDGER);
    const task = (id: string) => {
      const found = record.tasks.find((entry) => entry.spec.id === id);
      if (!found) throw new Error(`missing ${id}`);
      return found as typeof found & Record<string, unknown>;
    };
    const t1 = task("t1");
    const t2 = task("t2");
    const t1Implementation = record.assignments.find(
      (entry) => entry.assignmentId === "assignment-t1-a1",
    );
    const report = t1Implementation?.acceptedProof as Record<string, unknown>;
    const t1Reviewer = record.assignments.find(
      (entry) => entry.assignmentId === "assignment-t1-r1",
    );
    const t2Assignment = record.assignments.find(
      (entry) => entry.assignmentId === "assignment-t2-a1",
    );
    const t1Intent = record.outbox.find((entry) => entry.id === "intent-t1-a1");
    const reviewerIntent = record.outbox.find((entry) => entry.id === "intent-t1-r1");
    const evidence = t2Assignment?.cancellation;
    const cancelIntent = record.outbox.find((entry) => entry.id === evidence?.cancelIntentId);
    const reviewerNonce = record.nonceRegistry.find(
      (entry) => entry.assignmentId === "assignment-t1-r1",
    );
    const decision = record.decisions.find((entry) => entry.subjectId === "t2");
    // 1-3: t1's done report is the implementation report, not a borrowed/default one.
    expect(t1.state).toBe("done");
    expect(report).toMatchObject({
      taskId: "t1",
      attempt: 1,
      nonce: t1Implementation?.nonce,
      assignmentId: "assignment-t1-a1",
    });
    expect(report.ref).toEqual(t1.ref);
    // 4: t1 implementation assignment is complete.
    expect(t1Implementation).toMatchObject({
      taskId: "t1",
      agentId: "agent-b1",
      seatId: "seat-b1",
      nonce: report.nonce,
    });
    // 5-8: the reviewer has its own assignment, nonce acceptance and dispatch intent.
    expect(t1Reviewer).toMatchObject({
      taskId: "t1",
      agentId: "agent-b2",
      seatId: "seat-b2",
      purpose: "reviewer",
      tier: "A",
      nonce: reviewerNonce?.nonce,
    });
    expect(t1Reviewer?.messageId).not.toBeNull();
    expect(reviewerIntent).toMatchObject({
      kind: "dispatch",
      taskId: "t1",
      assignmentId: "assignment-t1-r1",
      recipient: "agent-b2",
      messageId: t1Reviewer?.messageId,
      idempotencyKey: "dispatch-t1-r1",
      state: "confirmed",
    });
    expect(reviewerNonce).toMatchObject({
      taskId: "t1",
      assignmentId: "assignment-t1-r1",
      phase: "review",
      acceptedAt: AT_UPDATED,
      acceptedEventKey: "proof:assignment-t1-r1",
    });
    expect(record.eventReceipts).toContainEqual(
      expect.objectContaining({
        eventKey: "agent-b2|turn-8|turn_ended",
        turnId: "turn-8",
        agentId: "agent-b2",
      }),
    );
    // 9: t1 implementation dispatch intent.
    expect(t1Intent).toMatchObject({
      kind: "dispatch",
      taskId: "t1",
      assignmentId: "assignment-t1-a1",
      recipient: "agent-b1",
      messageId: t1Implementation?.messageId,
      idempotencyKey: "dispatch-t1-a1",
    });
    // 10-14: t2 frozen with claim; cancel source and authorization are complete.
    expect(t2).toMatchObject({
      state: "blocked",
      phase: "frozen",
      frozenClaimId: "claim-t2",
    });
    expect(t2Assignment?.cancellation).toMatchObject({
      cancelIntentId: "intent-cancel-t2",
      receipt: { kind: "archive", confirmedAt: AT_UPDATED, externalId: "archive-1" },
    });
    expect(cancelIntent).toMatchObject({
      kind: "archive",
      taskId: "t2",
      assignmentId: "assignment-t2-a1",
      recipient: "agent-b1",
      messageId: MESSAGE_CANCEL,
      state: "confirmed",
    });
    expect(decision).toMatchObject({
      state: "answered",
      answer: { action: "cancel", taskIds: ["t2"], answeredAt: AT_UPDATED },
      answeredAt: AT_UPDATED,
    });
    expect(record.resources).toContainEqual(
      expect.objectContaining({ taskId: "t2", frozen: true }),
    );
  });

  test("legal fixtures use lowercase business ids, no task mirrors, and accepted nonces", () => {
    const lower = /^[a-z0-9][a-z0-9-]*$/;
    for (const { id, ledger } of SOURCE_LEDGERS) {
      assertAssociations(id, ledger);
      for (const task of ledger.tasks) {
        expect(task.spec.id, `${id} task id`).toMatch(lower);
        for (const dep of task.spec.deps) expect(dep, `${id} dep`).toMatch(lower);
        for (const mirror of ["report", "reviews", "smokeReport"]) {
          expect(Object.hasOwn(task, mirror), `${id} task.${mirror}`).toBe(false);
        }
      }
      for (const assignment of ledger.assignments) {
        expect(assignment.taskId, `${id} assignment task`).toMatch(lower);
        if (assignment.delivery !== null) {
          expect(assignment.delivery.producerAssignmentId, `${id} delivery`).toMatch(lower);
        }
        if (assignment.acceptedProof !== null) {
          expect(assignment.acceptedProof.taskId, `${id} proof task`).toMatch(lower);
          const nonce = ledger.nonceRegistry.find(
            (entry) => entry.assignmentId === assignment.assignmentId,
          );
          expect(nonce?.acceptedAt, `${id} accepted nonce timestamp`).not.toBeNull();
          expect(nonce?.acceptedEventKey, `${id} accepted nonce key`).toBe(
            `proof:${assignment.assignmentId}`,
          );
          const intent = ledger.outbox.find(
            (entry) => entry.kind === "dispatch" && entry.assignmentId === assignment.assignmentId,
          );
          expect(intent?.messageId, `${id} accepted dispatch`).toBe(assignment.messageId);
        }
        if (assignment.state === "ended") {
          expect(assignment.turnId, `${id} ended turn required`).not.toBeNull();
          expect(assignment.endedAt, `${id} ended at required`).not.toBeNull();
          expect(assignment.endedEventKey, `${id} ended key required`).not.toBeNull();
        }
        if (assignment.state === "cancelled") {
          if (assignment.cancellation !== null) {
            assertCompleteCancellation(id, ledger, assignment);
          } else {
            expect(isLocalNeverSent(ledger, assignment), `${id} local never sent`).toBe(true);
          }
        }
        if (assignment.endedEventKey !== null) {
          expect(
            ledger.eventReceipts.some(
              (receipt) =>
                receipt.eventKey === assignment.endedEventKey &&
                receipt.kind === "turn_ended" &&
                receipt.agentId === assignment.agentId &&
                receipt.turnId === assignment.turnId,
            ),
            `${id} ended receipt ${assignment.endedEventKey}`,
          ).toBe(true);
        }
      }
      for (const claim of ledger.resources) {
        expect(claim.taskId, `${id} claim task`).toMatch(lower);
        expect(claim.originAssignmentId, `${id} claim origin`).toMatch(lower);
      }
      for (const nonce of ledger.nonceRegistry)
        expect(nonce.taskId, `${id} nonce task`).toMatch(lower);
      for (const intent of ledger.outbox) {
        if ("taskId" in intent) expect(intent.taskId, `${id} intent task`).toMatch(lower);
      }
      for (const decision of ledger.decisions) {
        if (decision.subjectId !== null && lower.test(decision.subjectId)) {
          // A seat subject is also lowercase; no uppercase business task may survive.
          expect(decision.subjectId).toBe(decision.subjectId.toLowerCase());
        }
        for (const taskId of decision.answer?.taskIds ?? [])
          expect(taskId, `${id} answer task`).toMatch(lower);
        for (const binding of decision.cancelIntents ?? []) {
          expect(binding.assignmentId, `${id} cancel binding`).toMatch(lower);
        }
      }
    }
  });

  test("T175 cancelled receipt must be a complete 167 proof", () => {
    const none = structuredClone(QUIESCENT_CANCELLED_LEDGER);
    const noneAssignment = none.assignments.find(
      (entry) => entry.assignmentId === "assignment-t2-a1",
    );
    if (!noneAssignment?.cancellation) throw new Error("missing cancellation");
    noneAssignment.cancellation.receipt = {
      kind: "none",
      confirmedAt: null,
      externalId: null,
    };
    expect(RunRecordSchema.safeParse(none).success).toBe(true);
    expect(() => assertAssociations("receipt-none", none)).toThrow();

    const onlyEnded = structuredClone(QUIESCENT_CANCELLED_LEDGER);
    const endedAssignment = onlyEnded.assignments.find(
      (entry) => entry.assignmentId === "assignment-t2-a1",
    );
    if (!endedAssignment) throw new Error("missing assignment");
    endedAssignment.cancellation = null;
    endedAssignment.endedEventKey = "agent-b1|turn-7|turn_ended";
    expect(RunRecordSchema.safeParse(onlyEnded).success).toBe(true);
    expect(() => assertAssociations("only-ended", onlyEnded)).toThrow();

    const wrongActor = structuredClone(QUIESCENT_CANCELLED_LEDGER);
    const wrongActorAssignment = wrongActor.assignments.find(
      (entry) => entry.assignmentId === "assignment-t2-a1",
    );
    if (!wrongActorAssignment?.cancellation) throw new Error("missing cancellation");
    wrongActorAssignment.cancellation.assignmentId = "assignment-other";
    expect(RunRecordSchema.safeParse(wrongActor).success).toBe(true);
    expect(() => assertAssociations("wrong-actor", wrongActor)).toThrow();

    const wrongTime = structuredClone(QUIESCENT_CANCELLED_LEDGER);
    const wrongTimeAssignment = wrongTime.assignments.find(
      (entry) => entry.assignmentId === "assignment-t2-a1",
    );
    if (!wrongTimeAssignment?.cancellation) throw new Error("missing cancellation");
    wrongTimeAssignment.cancellation.refresh.observedAt = "2026-10-27T12:34:55.000Z";
    expect(RunRecordSchema.safeParse(wrongTime).success).toBe(true);
    expect(() => assertAssociations("wrong-time", wrongTime)).toThrow();

    const wrongIntent = structuredClone(QUIESCENT_CANCELLED_LEDGER);
    const wrongIntentAssignment = wrongIntent.assignments.find(
      (entry) => entry.assignmentId === "assignment-t2-a1",
    );
    if (!wrongIntentAssignment?.cancellation) throw new Error("missing cancellation");
    wrongIntentAssignment.cancellation.cancelIntentId = "intent-missing";
    expect(RunRecordSchema.safeParse(wrongIntent).success).toBe(true);
    expect(() => assertAssociations("wrong-intent", wrongIntent)).toThrow();

    const unauthorized = structuredClone(QUIESCENT_CANCELLED_LEDGER);
    const unauthorizedDecision = unauthorized.decisions.find((entry) => entry.subjectId === "t2");
    if (!unauthorizedDecision) throw new Error("missing decision");
    unauthorizedDecision.state = "open";
    unauthorizedDecision.answer = null;
    unauthorizedDecision.answeredAt = null;
    expect(RunRecordSchema.safeParse(unauthorized).success).toBe(true);
    expect(() => assertAssociations("unauthorized", unauthorized)).toThrow();

    const missingTaskCoverage = structuredClone(QUIESCENT_CANCELLED_LEDGER);
    const coverageDecision = missingTaskCoverage.decisions.find(
      (entry) => entry.subjectId === "t2",
    );
    if (!coverageDecision?.answer) throw new Error("missing answer");
    coverageDecision.answer.taskIds = [];
    expect(RunRecordSchema.safeParse(missingTaskCoverage).success).toBe(true);
    expect(() => assertAssociations("missing-task-coverage", missingTaskCoverage)).toThrow();
  });

  test("T175 delivery producer must be a valid producer done proof", () => {
    const reviewAsProducer = structuredClone(DEV_SMOKE_READY_LEDGER);
    const smoker = reviewAsProducer.assignments.find(
      (entry) => entry.assignmentId === "assignment-t6-s1",
    );
    if (!smoker) throw new Error("missing smoker");
    smoker.delivery = { producerAssignmentId: "assignment-t6-r1" };
    expect(RunRecordSchema.safeParse(reviewAsProducer).success).toBe(true);
    expect(() => assertAssociations("review-as-producer", reviewAsProducer)).toThrow();
  });

  test("T175 task cache is null/[] without a valid current D", () => {
    const cachedWithoutD = structuredClone(NORMAL_RUN_LEDGER);
    const t2Task = cachedWithoutD.tasks.find((entry) => entry.spec.id === "t2");
    if (!t2Task) throw new Error("missing t2");
    t2Task.ref = { kind: "git-commit", value: "9f3c1a7" };
    t2Task.changedFiles = ["src/t2.ts"];
    expect(RunRecordSchema.safeParse(cachedWithoutD).success).toBe(true);
    expect(() => assertAssociations("cache-without-d", cachedWithoutD)).toThrow();
  });

  test("done tasks keep their producer and reviewer proof chain", () => {
    const broken = structuredClone(CANCELLING_LEDGER);
    broken.assignments = broken.assignments.filter((entry) => entry.taskId !== "t1");
    expect(RunRecordSchema.safeParse(broken).success).toBe(true);
    expect(() => assertAssociations("done-without-chain", broken)).toThrow();
  });

  test("association validator catches single-field source breakage", () => {
    const base = NORMAL_RUN_LEDGER;
    const cases: Array<(record: LedgerFixture) => void> = [
      (record) => {
        const assignment = record.assignments.find(
          (entry) => entry.assignmentId === "assignment-t1-a1",
        );
        if (assignment?.acceptedProof) {
          (assignment.acceptedProof as Record<string, unknown>).assignmentId = "other";
        }
      },
      (record) => {
        const nonce = record.nonceRegistry.find(
          (entry) => entry.assignmentId === "assignment-t1-a1",
        );
        if (nonce) nonce.acceptedEventKey = null;
      },
      (record) => {
        const dispatch = record.outbox.find((entry) => entry.id === "intent-t1-a1");
        if (dispatch) dispatch.recipient = "other-agent";
      },
      (record) => {
        const claimEntry = record.resources[0];
        if (claimEntry) claimEntry.originAssignmentId = "assignment-t1-a1";
      },
      (record) => {
        record.eventReceipts = record.eventReceipts.filter(
          (entry) => entry.eventKey !== "agent-b1|turn-6|turn_ended",
        );
      },
      (record) => {
        const claimEntry = record.resources[0];
        if (claimEntry) claimEntry.originAssignmentId = "assignment-missing";
      },
      (record) => {
        const assignment = record.assignments.find(
          (entry) => entry.assignmentId === "assignment-t1-a1",
        );
        if (assignment) assignment.endedEventKey = null;
      },
      (record) => {
        const index = record.assignments.findIndex(
          (entry) => entry.assignmentId === "assignment-t1-r1",
        );
        if (index >= 0) {
          const current = record.assignments[index];
          if (!current) throw new Error("missing reviewer assignment");
          record.assignments[index] = {
            ...current,
            acceptedProof: null,
            delivery: { producerAssignmentId: "assignment-missing" },
            state: "assigned",
            turnId: null,
            endedAt: null,
            endedEventKey: null,
          };
        }
        const nonce = record.nonceRegistry.find(
          (entry) => entry.assignmentId === "assignment-t1-r1",
        );
        if (nonce) {
          nonce.acceptedAt = null;
          nonce.acceptedEventKey = null;
        }
      },
      (record) => {
        const producer = record.assignments.find(
          (entry) => entry.assignmentId === "assignment-t1-a1",
        );
        const reviewer = record.assignments.find(
          (entry) => entry.assignmentId === "assignment-t1-r1",
        );
        if (producer && reviewer) reviewer.seatId = producer.seatId;
      },
      (record) => {
        record.roster = record.roster.filter((seat) => seat.seatId !== "seat-a-smoke");
      },
    ];
    for (const [index, mutate] of cases.entries()) {
      const record =
        index === cases.length - 1
          ? structuredClone(DEV_SMOKE_READY_LEDGER)
          : structuredClone(base);
      mutate(record);
      const parsed = RunRecordSchema.safeParse(record);
      expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
      let caught = false;
      try {
        assertAssociations("mutated", record);
      } catch {
        caught = true;
      }
      expect(caught, `validator mutation ${index}`).toBe(true);
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

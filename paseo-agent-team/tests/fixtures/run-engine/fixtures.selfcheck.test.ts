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
  dispatchIntent,
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

type SourceCategory =
  | "source"
  | "gate-negative"
  | "invariant-negative"
  | "recovery-control"
  | "shape-negative"
  | "source-diagnostic"
  | "boundary";

type SourceMetadata = {
  category: SourceCategory;
  consumer: string;
  parent: string;
  candidate: string;
  expected?: { code: string; path: string };
};

const SOURCE_METADATA: Record<string, SourceMetadata> = {
  "normal-ledger": {
    category: "source",
    consumer: "R03/R05",
    parent: "NORMAL",
    candidate: "t1 complete; t2 in-flight",
  },
  "outcome-unknown-ledger": {
    category: "recovery-control",
    consumer: "R03/R05",
    parent: "NORMAL",
    candidate: "outcome-unknown send",
  },
  "cancelling-ledger": {
    category: "source-diagnostic",
    consumer: "R03/R05",
    parent: "NORMAL",
    candidate: "partial cancellation diagnosis",
  },
  "cancellation-authorized-frozen": {
    category: "recovery-control",
    consumer: "R03/R05",
    parent: "NORMAL",
    candidate: "answered D1, frozen claim",
  },
  "quiescent-cancelled-ledger": {
    category: "source",
    consumer: "R03/R05",
    parent: "NORMAL",
    candidate: "complete 167 cancellation",
  },
  "local-never-sent-cancelled-ledger": {
    category: "source",
    consumer: "R03/R05",
    parent: "NORMAL",
    candidate: "LocalNeverSent audit",
  },
  "blocked-ledger": {
    category: "source",
    consumer: "R03/R05",
    parent: "NORMAL",
    candidate: "blocked+frozen claim",
  },
  "lock-conflict-run-a": {
    category: "recovery-control",
    consumer: "R03b",
    parent: "lock pair",
    candidate: "claim conflict",
  },
  "lock-conflict-run-b": {
    category: "recovery-control",
    consumer: "R03b",
    parent: "lock pair",
    candidate: "claim conflict",
  },
  "probe-conflict-run-a": {
    category: "recovery-control",
    consumer: "R03b",
    parent: "probe pair",
    candidate: "probe conflict",
  },
  "probe-conflict-run-b": {
    category: "recovery-control",
    consumer: "R03b",
    parent: "probe pair",
    candidate: "probe conflict",
  },
  "probe-same-channel-seats": {
    category: "recovery-control",
    consumer: "R03b",
    parent: "probe source",
    candidate: "same-channel seats",
  },
  "closed-after-report": {
    category: "recovery-control",
    consumer: "R05",
    parent: "NORMAL",
    candidate: "report then closed",
  },
  "closed-while-assigned": {
    category: "recovery-control",
    consumer: "R05",
    parent: "NORMAL",
    candidate: "closed before report",
  },
  "reopen-started": {
    category: "recovery-control",
    consumer: "R05",
    parent: "NORMAL",
    candidate: "new a2 after reopen",
  },
  "control-attempts": {
    category: "recovery-control",
    consumer: "R03b",
    parent: "NORMAL",
    candidate: "control attempt budget",
  },
  "probe-eligible": {
    category: "recovery-control",
    consumer: "R03b",
    parent: "probe source",
    candidate: "eligible probe",
  },
  "probe-blocked-inflight-turn": {
    category: "recovery-control",
    consumer: "R03b",
    parent: "probe source",
    candidate: "in-flight turn",
  },
  "probe-in-flight": {
    category: "recovery-control",
    consumer: "R03b",
    parent: "probe source",
    candidate: "sending probe",
  },
  "probe-completed": {
    category: "recovery-control",
    consumer: "R03b",
    parent: "probe source",
    candidate: "completed probe",
  },
  "probe-failed": {
    category: "recovery-control",
    consumer: "R03b",
    parent: "probe source",
    candidate: "failed probe",
  },
  "probe-unknown": {
    category: "recovery-control",
    consumer: "R03b",
    parent: "probe source",
    candidate: "outcome-unknown probe",
  },
  "evidence-incomplete": {
    category: "gate-negative",
    consumer: "R03 evidence gate",
    parent: "NORMAL",
    candidate: "done proof exitCode=1",
    expected: { code: "evidence-exit", path: "proof.evidence.five-gates.exitCode" },
  },
  "stale-review": {
    category: "source",
    consumer: "R03/R05",
    parent: "NORMAL",
    candidate: "current a2 awaiting review",
  },
  "dev-smoke-missing": {
    category: "gate-negative",
    consumer: "R03 DEV gate",
    parent: "DEV source",
    candidate: "default DEV target",
    expected: { code: "dev-target", path: "proof.devServerId" },
  },
  "dev-smoke-ready": {
    category: "source",
    consumer: "R03 DEV gate",
    parent: "DEV source",
    candidate: "registered DEV target",
  },
  "permission-pending": {
    category: "recovery-control",
    consumer: "R06",
    parent: "NORMAL",
    candidate: "permission pending",
  },
  "irreversible-unapproved": {
    category: "recovery-control",
    consumer: "R03 approval gate",
    parent: "NORMAL",
    candidate: "irreversible pre-dispatch",
  },
  "finished-decision": {
    category: "source",
    consumer: "R07",
    parent: "NORMAL",
    candidate: "finished D6/D4 read projection",
  },
};

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

class SourceIssue extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "SourceIssue";
  }
}

function failSource(code: string, path: string, message: string): never {
  throw new SourceIssue(code, path, message);
}

function sourceCodeOf(action: () => void): string {
  try {
    action();
  } catch (error) {
    if (error instanceof SourceIssue) return error.code;
    throw error;
  }
  throw new Error("expected a SourceIssue");
}

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
  if (cancellation.refresh.agentId !== assignment.agentId) {
    failSource("refresh-actor", "cancellation.refresh.agentId", `${id} cancellation refresh actor`);
  }
  expect(cancellation.refresh.activeTurn, `${id} cancellation activeTurn`).toBe(false);
  expect(
    Date.parse(cancellation.refresh.observedAt) >= Date.parse(assignment.endedAt),
    `${id} cancellation refresh time`,
  ).toBe(true);
  expect(cancellation.observationSeq, `${id} cancellation watermark`).toBeLessThanOrEqual(
    record.counters.observationSeq,
  );
  expect(cancellation.endedEventKey, `${id} cancellation ended key`).not.toBeNull();
  if (
    assignment.endedEventKey !== null &&
    assignment.endedEventKey !== cancellation.endedEventKey
  ) {
    failSource(
      "ended-key-mismatch",
      "assignments.<id>.endedEventKey",
      `${id} cancellation ending identity`,
    );
  }
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
    assertCancelPairs(
      id,
      record,
      decision,
      task.spec.id,
      CANCEL_OBLIGATIONS[id] ?? [assignment.assignmentId],
    );
  }
}

const INVARIANT_METADATA: Record<string, SourceMetadata & { domainExpected?: string }> = {
  "i1-half-write-bytes": {
    category: "shape-negative",
    consumer: "R05",
    parent: "NORMAL",
    candidate: "tmp bytes",
    domainExpected: "I1",
  },
  "i2-ready-with-unfinished-dep": {
    category: "invariant-negative",
    consumer: "R03",
    parent: "NORMAL",
    candidate: "t3 ready with t2 unfinished",
    domainExpected: "I2",
  },
  "i2-pending-with-unfinished-dep": {
    category: "source",
    consumer: "R03",
    parent: "NORMAL",
    candidate: "t3 correctly pending",
  },
  "i3-blocked-frozen-claim": {
    category: "source",
    consumer: "R03",
    parent: "NORMAL",
    candidate: "blocked frozen claim",
  },
  "i3-pending-holds-claim": {
    category: "invariant-negative",
    consumer: "R03",
    parent: "NORMAL",
    candidate: "pending task holds claim",
    domainExpected: "I3",
  },
  "i4-review-awaiting-does-not-count": {
    category: "source",
    consumer: "R03",
    parent: "NORMAL",
    candidate: "awaiting review not slot",
  },
  "i4-capacity-over-effective": {
    category: "boundary",
    consumer: "R03",
    parent: "NORMAL",
    candidate: "capacity boundary",
    domainExpected: "I4",
  },
  "i5-nonce-replayed": {
    category: "invariant-negative",
    consumer: "R03",
    parent: "NORMAL",
    candidate: "duplicate nonce",
    domainExpected: "I5",
  },
  "i5-turn-ended-redelivered": {
    category: "source",
    consumer: "R05",
    parent: "NORMAL",
    candidate: "duplicate transport receipt",
  },
  "i6-rework-count-below-events": {
    category: "invariant-negative",
    consumer: "R03",
    parent: "NORMAL",
    candidate: "count marker below events",
    domainExpected: "I6",
  },
  "i7-done-without-review": {
    category: "invariant-negative",
    consumer: "R03",
    parent: "NORMAL",
    candidate: "producer chain only",
    domainExpected: "I7",
  },
  "i7-self-review": {
    category: "invariant-negative",
    consumer: "R03",
    parent: "NORMAL",
    candidate: "same actor self review",
    domainExpected: "I7",
  },
  "i8-assignment-without-intent": {
    category: "invariant-negative",
    consumer: "R03/I7",
    parent: "NORMAL",
    candidate: "assignment without dispatch",
    domainExpected: "I8",
    expected: { code: "assignment-dispatch", path: "assignments.<id>.dispatch" },
  },
};

const CACHE_SOURCE: Readonly<Record<string, Readonly<Record<string, string | null>>>> = {
  "normal-ledger": { t1: "assignment-t1-a1" },
  "outcome-unknown-ledger": { t1: "assignment-t1-a1" },
  "cancelling-ledger": { t1: "assignment-t1-a1" },
  "cancellation-authorized-frozen": { t1: "assignment-t1-a1" },
  "quiescent-cancelled-ledger": { t1: "assignment-t1-a1" },
  "local-never-sent-cancelled-ledger": { t1: "assignment-t1-a1" },
  "blocked-ledger": { t1: "assignment-t1-a1" },
  "lock-conflict-run-a": { t1: "assignment-t1-a1" },
  "lock-conflict-run-b": { t1: "assignment-t1-a1" },
  "probe-conflict-run-a": { t1: "assignment-t1-a1" },
  "probe-conflict-run-b": { t1: "assignment-t1-a1" },
  "probe-same-channel-seats": { t1: "assignment-t1-a1" },
  "closed-after-report": { t1: "assignment-t1-a1", t2: "assignment-t2-a1" },
  "closed-while-assigned": { t1: "assignment-t1-a1" },
  "reopen-started": { t1: "assignment-t1-a1" },
  "control-attempts": { t1: "assignment-t1-a1" },
  "probe-eligible": { t1: "assignment-t1-a1" },
  "probe-blocked-inflight-turn": { t1: "assignment-t1-a1" },
  "probe-in-flight": { t1: "assignment-t1-a1" },
  "probe-completed": { t1: "assignment-t1-a1" },
  "probe-failed": { t1: "assignment-t1-a1" },
  "probe-unknown": { t1: "assignment-t1-a1" },
  "evidence-incomplete": { t1: "assignment-t1-a1" },
  "stale-review": { t1: "assignment-t1-a2" },
  "dev-smoke-missing": { t1: "assignment-t1-a1", t6: "assignment-t6-a1" },
  "dev-smoke-ready": { t1: "assignment-t1-a1", t6: "assignment-t6-a1" },
  "permission-pending": { t1: "assignment-t1-a1" },
  "irreversible-unapproved": { t1: "assignment-t1-a1" },
  "finished-decision": { t1: "assignment-t1-a1" },
  "quiescent-two": { t1: "assignment-t1-a1" },
  "matching-ended-key": { t1: "assignment-t1-a1" },
  "superseded-local": { t1: "assignment-t1-a1" },
  "superseded-zero": { t1: "assignment-t1-a1" },
  "superseded-missing-audit": { t1: "assignment-t1-a1" },
  "superseded-fake-pair": { t1: "assignment-t1-a1" },
  "i2-pending-with-unfinished-dep": { t1: "assignment-t1-a1" },
  "i3-blocked-frozen-claim": { t1: "assignment-t1-a1" },
  "i4-review-awaiting-does-not-count": { t1: "assignment-t1-a1" },
  "i4-capacity-over-effective": { t1: "assignment-t1-a1" },
  "i5-turn-ended-redelivered": { t1: "assignment-t1-a1" },
  "i7-self-review": { t1: "assignment-t1-a1" },
  "i1-half-write-bytes": { t1: "assignment-t1-a1" },
  "i2-ready-with-unfinished-dep": { t1: "assignment-t1-a1" },
  "i7-done-without-review": { t1: "assignment-t1-a1" },
  "i8-assignment-without-intent": { t1: "assignment-t1-a1" },
  "i5-nonce-replayed": { t1: "assignment-t1-a1" },
  "i3-pending-holds-claim": { t1: "assignment-t1-a1" },
  i6: { t1: "assignment-t1-a1" },
  "i6-rework-count-below-events": { t1: "assignment-t1-a1" },
  "cache-without-d": { t1: "assignment-t1-a1" },
  "done-without-reviewer": { t1: "assignment-t1-a1" },
  "done-without-chain": { t1: "assignment-t1-a1" },
};

const CANCEL_OBLIGATIONS: Readonly<Record<string, readonly string[]>> = {
  "quiescent-cancelled-ledger": ["assignment-t2-a1"],
  "quiescent-two": ["assignment-t2-a1", "assignment-t2-a2"],
};

function assertCancelPairs(
  id: string,
  record: LedgerFixture,
  decision: LedgerFixture["decisions"][number],
  taskId: string,
  expectedAssignmentIds: readonly string[],
): void {
  const pairs = decision.cancelIntents ?? [];
  const actualIds = pairs.map((entry) => entry.assignmentId);
  if (JSON.stringify(actualIds) !== JSON.stringify([...expectedAssignmentIds].sort())) {
    failSource(
      "cancellation-pairs",
      "decisions.<id>.cancelIntents",
      `${id} cancellation obligation set`,
    );
  }
  expect(decision.answer?.taskIds, `${id} cancellation answer coverage`).toContain(taskId);
  for (const binding of pairs) {
    const assignment = record.assignments.find(
      (entry) => entry.assignmentId === binding.assignmentId,
    );
    const intent = record.outbox.find((entry) => entry.id === binding.intentId);
    expect(assignment?.taskId, `${id} cancellation pair task`).toBe(taskId);
    expect(intent, `${id} cancellation pair intent`).toBeDefined();
    if (assignment && intent) {
      expect(intent.kind, `${id} cancellation pair kind`).toBe("archive");
      expect(intent.taskId, `${id} cancellation pair intent task`).toBe(taskId);
      expect(intent.assignmentId, `${id} cancellation pair intent assignment`).toBe(
        assignment.assignmentId,
      );
      expect(intent.recipient, `${id} cancellation pair recipient`).toBe(assignment.agentId);
    }
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
  const dispatches = record.outbox.filter(
    (entry) => entry.kind === "dispatch" && entry.assignmentId === assignment.assignmentId,
  );
  if (dispatches.length !== 1) return false;
  const intent = dispatches[0];
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
  const nonce = record.nonceRegistry.find(
    (entry) => entry.assignmentId === assignment.assignmentId,
  );
  if (
    !nonce ||
    nonce.runId !== record.runId ||
    nonce.acceptedAt !== null ||
    nonce.revokedAt === null ||
    nonce.revokeReason === null
  ) {
    return false;
  }
  if (intent.localCancellation.eventSeq > record.counters.eventsThroughSeq) return false;
  if (
    record.events.some(
      (event) =>
        event.payload.taskId === assignment.taskId &&
        (event.kind === "turn_started" || event.kind === "turn_ended"),
    )
  ) {
    return false;
  }
  const cancelEvent = record.events.find(
    (event) =>
      event.seq === intent.localCancellation?.eventSeq &&
      event.kind === intent.localCancellation.cause &&
      event.at === intent.localCancellation.at &&
      event.payload.taskId === assignment.taskId,
  );
  if (!cancelEvent) return false;
  const audit = cancelEvent.payload.audit as
    | { localIntentIds?: unknown; supersededDecisionIds?: unknown }
    | undefined;
  if (
    !Array.isArray(audit?.localIntentIds) ||
    !audit.localIntentIds.includes(intent.id) ||
    !Array.isArray(audit.supersededDecisionIds)
  ) {
    return false;
  }
  return !record.outbox.some(
    (entry) => entry.kind === "archive" && entry.assignmentId === assignment.assignmentId,
  );
}

/** Test-only source association checks. This is not the product I7 implementation. */
function assertAssociations(
  id: string,
  record: LedgerFixture,
  options: { allowSelfReview?: boolean; allowMissingReviewer?: boolean } = {},
): void {
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
      if ("workspace" in proof) {
        expect(assignment.workspace, `${id} proof workspace`).toEqual(proof.workspace);
      }
      expect(nonce, `${id} accepted nonce`).toBeDefined();
      if (nonce) {
        if (nonce.runId !== record.runId) {
          failSource("nonce-run", `nonces.${nonce.nonce}.runId`, `${id} nonce run`);
        }
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
      if (nonce.runId !== record.runId) {
        failSource("nonce-run", `nonces.${nonce.nonce}.runId`, `${id} unaccepted nonce run`);
      }
      expect(nonce.acceptedAt, `${id} unaccepted At`).toBeNull();
      expect(nonce.acceptedEventKey, `${id} unaccepted key`).toBeNull();
    }
    const assignmentDispatches = record.outbox.filter(
      (entry) => entry.kind === "dispatch" && entry.assignmentId === assignment.assignmentId,
    );
    if (assignmentDispatches.length !== 1) {
      failSource(
        "assignment-dispatch",
        `assignments.${assignment.assignmentId}.dispatch`,
        `${id} assignment dispatch count`,
      );
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
      if (!["member", "coordinator", "reopen"].includes(producer?.purpose ?? "")) {
        failSource(
          "producer-purpose",
          `assignments.${producerId}.purpose`,
          `${id} producer purpose`,
        );
      }
      expect(producer?.acceptedProof, `${id} producer proof`).not.toBeNull();
      if (producer?.acceptedProof) {
        expect("status" in producer.acceptedProof, `${id} producer report kind`).toBe(true);
        if ("status" in producer.acceptedProof) {
          expect(producer.acceptedProof.status, `${id} producer done`).toBe("done");
        }
        expect(validProducerD(record, producer), `${id} producer evidence`).toBe(true);
      }
      if (!options.allowSelfReview) {
        expect(producer?.agentId, `${id} independent agent`).not.toBe(assignment.agentId);
        expect(producer?.seatId, `${id} independent seat`).not.toBe(assignment.seatId);
      }
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
      } else if (!isLocalNeverSent(record, assignment)) {
        failSource(
          "local-never-sent",
          `assignments.${assignment.assignmentId}`,
          `${id} local never sent`,
        );
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
    const cacheSource = CACHE_SOURCE[id]?.[task.spec.id] ?? null;
    const producer =
      cacheSource === null
        ? null
        : record.assignments.find((entry) => entry.assignmentId === cacheSource);
    if (cacheSource !== null) {
      if (!producer || producer.taskId !== task.spec.id || !validProducerD(record, producer)) {
        failSource("cache-source", `tasks.${task.spec.id}.cacheSource`, `${id} cache producer`);
      }
      const proof = producer?.acceptedProof;
      if (proof && "ref" in proof && "changedFiles" in proof) {
        expect(task.ref, `${id} task cache ref`).toEqual(proof.ref);
        expect(task.changedFiles, `${id} task cache files`).toEqual(proof.changedFiles);
      }
    } else if (task.ref !== null || task.changedFiles.length !== 0) {
      failSource("cache-source", `tasks.${task.spec.id}.cacheSource`, `${id} task cache without D`);
    }
    if (task.state === "done") {
      expect(producer, `${id} done task producer`).toBeDefined();
      if (options.allowMissingReviewer) continue;
      const reviewer = record.assignments.find(
        (entry) =>
          entry.taskId === task.spec.id &&
          entry.purpose === "reviewer" &&
          entry.acceptedProof !== null &&
          "verdict" in entry.acceptedProof &&
          entry.delivery?.producerAssignmentId === producer?.assignmentId,
      );
      if (!reviewer) {
        failSource(
          "done-reviewer-chain",
          `tasks.${task.spec.id}.reviewer`,
          `${id} done task reviewer chain`,
        );
      }
      if (reviewer?.acceptedProof && producer?.acceptedProof) {
        expect("reviewedRef" in reviewer.acceptedProof, `${id} done reviewer report kind`).toBe(
          true,
        );
        if ("reviewedRef" in reviewer.acceptedProof && "ref" in producer.acceptedProof) {
          expect(reviewer.acceptedProof.reviewedRef, `${id} done reviewed ref`).toEqual(
            producer.acceptedProof.ref,
          );
        }
      }
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
    if (decision.state === "superseded") {
      expect(decision.answer, `${id} superseded answer`).toBeNull();
      expect(decision.answeredAt, `${id} superseded answeredAt`).toBeNull();
      expect(decision.resolution, `${id} superseded resolution`).not.toBeNull();
      expect(decision.cancelIntents, `${id} superseded pairs`).toEqual([]);
      const resolution = decision.resolution;
      const task = record.tasks.find((entry) => entry.spec.id === decision.subjectId);
      expect(task?.state, `${id} superseded task`).toBe("cancelled");
      expect(task?.releaseDecisionId, `${id} superseded release`).not.toBe(decision.decisionId);
      if (resolution) {
        expect(resolution.witness.taskId, `${id} superseded witness task`).toBe(decision.subjectId);
        expect(resolution.witness.localIntentIds, `${id} superseded local ids`).toEqual(
          [...resolution.witness.localIntentIds].sort(),
        );
        const localIds = record.outbox
          .filter(
            (entry) =>
              entry.kind === "dispatch" &&
              entry.localCancellation !== null &&
              entry.taskId === decision.subjectId,
          )
          .map((entry) => entry.id)
          .sort();
        expect(resolution.witness.localIntentIds, `${id} superseded local closure`).toEqual(
          localIds,
        );
        const through = record.checkpoint?.throughSeq ?? 0;
        if (resolution.eventSeq > through) {
          const event = record.events.find(
            (entry) =>
              entry.seq === resolution.eventSeq &&
              entry.at === resolution.at &&
              entry.kind === resolution.cause &&
              entry.payload.taskId === decision.subjectId,
          );
          if (!event) {
            failSource(
              "superseded-cancel-event",
              "decisions.<id>.resolution.eventSeq",
              `${id} superseded cancel event`,
            );
          }
          if (event) {
            const audit = event.payload.audit as
              | { localIntentIds?: unknown; supersededDecisionIds?: unknown }
              | undefined;
            expect(audit?.localIntentIds, `${id} superseded audit locals`).toEqual(
              resolution.witness.localIntentIds,
            );
            expect(audit?.supersededDecisionIds, `${id} superseded audit decision`).toContain(
              decision.decisionId,
            );
          }
        }
      }
      continue;
    }
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

  test("every invariant case closes its non-target source and names its target", () => {
    const options: Record<
      string,
      { allowSelfReview?: boolean; allowMissingReviewer?: boolean; expected?: RegExp }
    > = {
      "i7-self-review": { allowSelfReview: true },
      "i7-done-without-review": { allowMissingReviewer: true },
      "i8-assignment-without-intent": { expected: /assignment dispatch count/ },
    };
    for (const entry of INVARIANT_CASES) {
      const record = entry.ledger as LedgerFixture;
      expect(RunRecordSchema.safeParse(record).success, `${entry.id} schema`).toBe(true);
      const expected = options[entry.id]?.expected;
      const doCheck = () =>
        assertAssociations(entry.id, record, {
          allowSelfReview: options[entry.id]?.allowSelfReview,
          allowMissingReviewer: options[entry.id]?.allowMissingReviewer,
        });
      if (expected) {
        expect(doCheck, `${entry.id} source target`).toThrow(expected);
      } else {
        expect(doCheck, `${entry.id} non-target source`).not.toThrow();
      }
    }
    const i8 = INVARIANT_CASES.find((entry) => entry.id === "i8-assignment-without-intent");
    if (!i8) throw new Error("missing i8");
    expect(
      sourceCodeOf(() =>
        assertAssociations("i8-assignment-without-intent", i8.ledger as LedgerFixture),
      ),
    ).toBe("assignment-dispatch");
  });

  test("each named sample has explicit source metadata", () => {
    for (const { id } of NAMED_LEDGERS) {
      expect(SOURCE_METADATA[id], `${id} metadata`).toBeDefined();
    }
    for (const entry of INVARIANT_CASES) {
      expect(INVARIANT_METADATA[entry.id], `${entry.id} invariant metadata`).toBeDefined();
    }
    for (const [id, metadata] of Object.entries(SOURCE_METADATA)) {
      expect(metadata.consumer, `${id} consumer`).not.toBe("");
      expect(metadata.parent, `${id} parent`).not.toBe("");
      expect(metadata.candidate, `${id} candidate`).not.toBe("");
      if (metadata.category === "gate-negative") {
        expect(metadata.expected, `${id} gate issue`).toBeDefined();
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
        for (const dep of task.spec.deps) {
          expect(
            ledger.tasks.some((candidate) => candidate.spec.id === dep),
            `${id} task dep ${dep}`,
          ).toBe(true);
        }
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
    expect(sourceCodeOf(() => assertAssociations("review-as-producer", reviewAsProducer))).toBe(
      "producer-purpose",
    );
  });

  test("T175 task cache is null/[] without a valid current D", () => {
    const cachedWithoutD = structuredClone(NORMAL_RUN_LEDGER);
    const t2Task = cachedWithoutD.tasks.find((entry) => entry.spec.id === "t2");
    if (!t2Task) throw new Error("missing t2");
    t2Task.ref = { kind: "git-commit", value: "9f3c1a7" };
    t2Task.changedFiles = ["src/t2.ts"];
    expect(RunRecordSchema.safeParse(cachedWithoutD).success).toBe(true);
    expect(sourceCodeOf(() => assertAssociations("cache-without-d", cachedWithoutD))).toBe(
      "cache-source",
    );
  });

  test("C1/C8 refresh actor and own ended-key identity", () => {
    const wrongRefresh = structuredClone(QUIESCENT_CANCELLED_LEDGER);
    const wrongRefreshAssignment = wrongRefresh.assignments.find(
      (entry) => entry.assignmentId === "assignment-t2-a1",
    );
    if (!wrongRefreshAssignment?.cancellation) throw new Error("missing cancellation");
    wrongRefreshAssignment.cancellation.refresh.agentId = "agent-wrong";
    expect(RunRecordSchema.safeParse(wrongRefresh).success).toBe(true);
    expect(sourceCodeOf(() => assertAssociations("wrong-refresh-actor", wrongRefresh))).toBe(
      "refresh-actor",
    );

    const matchingKey = structuredClone(QUIESCENT_CANCELLED_LEDGER);
    const matchingAssignment = matchingKey.assignments.find(
      (entry) => entry.assignmentId === "assignment-t2-a1",
    );
    if (!matchingAssignment?.cancellation) throw new Error("missing cancellation");
    matchingAssignment.endedEventKey = matchingAssignment.cancellation.endedEventKey;
    expect(RunRecordSchema.safeParse(matchingKey).success).toBe(true);
    expect(() => assertAssociations("matching-ended-key", matchingKey)).not.toThrow();

    const conflictingKey = structuredClone(QUIESCENT_CANCELLED_LEDGER);
    const conflictingAssignment = conflictingKey.assignments.find(
      (entry) => entry.assignmentId === "assignment-t2-a1",
    );
    if (!conflictingAssignment?.cancellation) throw new Error("missing cancellation");
    conflictingAssignment.endedEventKey = "agent-b1|turn-6|turn_ended";
    expect(RunRecordSchema.safeParse(conflictingKey).success).toBe(true);
    expect(sourceCodeOf(() => assertAssociations("conflicting-ended-key", conflictingKey))).toBe(
      "ended-key-mismatch",
    );
  });

  test("C2 cancel pairs exact closure", () => {
    const missing = structuredClone(QUIESCENT_CANCELLED_LEDGER);
    const missingDecision = missing.decisions.find((entry) => entry.subjectId === "t2");
    if (!missingDecision) throw new Error("missing decision");
    missingDecision.cancelIntents = [];
    expect(RunRecordSchema.safeParse(missing).success).toBe(true);
    expect(sourceCodeOf(() => assertAssociations("missing-pair", missing))).toBe(
      "cancellation-pairs",
    );

    const extra = structuredClone(QUIESCENT_CANCELLED_LEDGER);
    const extraDecision = extra.decisions.find((entry) => entry.subjectId === "t2");
    if (!extraDecision) throw new Error("missing decision");
    extra.outbox.push(
      dispatchIntent({
        id: "intent-t1-extra",
        kind: "archive",
        taskId: "t1",
        assignmentId: "assignment-t1-a1",
        recipient: "agent-b1",
        messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9",
        idempotencyKey: "cancel-t1-extra",
        state: "confirmed",
        confirmedAt: AT_UPDATED,
      }),
    );
    extraDecision.cancelIntents = [
      { assignmentId: "assignment-t1-a1", intentId: "intent-t1-extra" },
      ...(extraDecision.cancelIntents ?? []),
    ];
    expect(RunRecordSchema.safeParse(extra).success).toBe(true);
    expect(sourceCodeOf(() => assertAssociations("extra-cross-task-pair", extra))).toBe(
      "cancellation-pairs",
    );
  });

  test("C2 two-actor exact closure and extra same-task pair", () => {
    const two = structuredClone(QUIESCENT_CANCELLED_LEDGER);
    const first = two.assignments.find((entry) => entry.assignmentId === "assignment-t2-a1");
    const firstIntent = two.outbox.find((entry) => entry.id === "intent-cancel-t2");
    if (!first?.cancellation || !firstIntent) throw new Error("missing first cancellation");
    const second = {
      ...first,
      assignmentId: "assignment-t2-a2",
      nonce: "6f1c2a44-3b7e-4f0a-9a11-000000000031",
      messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
      turnId: "turn-7b",
      endedAt: AT_UPDATED,
      endedEventKey: null,
      cancellation: {
        ...first.cancellation,
        assignmentId: "assignment-t2-a2",
        lastTurnId: "turn-7b",
        endedEventKey: "agent-b1|turn-7b|turn_ended",
        cancelIntentId: "intent-cancel-t2-b",
      },
    };
    two.assignments.push(second);
    two.outbox.push(
      dispatchIntent({
        id: "intent-t2-a2",
        taskId: "t2",
        assignmentId: "assignment-t2-a2",
        recipient: "agent-b1",
        messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
        idempotencyKey: "dispatch-t2-a2",
        state: "confirmed",
        confirmedAt: AT_UPDATED,
      }),
      dispatchIntent({
        id: "intent-cancel-t2-b",
        kind: "archive",
        taskId: "t2",
        assignmentId: "assignment-t2-a2",
        recipient: "agent-b1",
        messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
        idempotencyKey: "cancel-t2-b",
        state: "confirmed",
        confirmedAt: AT_UPDATED,
      }),
    );
    two.eventReceipts.push({
      eventKey: "agent-b1|turn-7b|turn_ended",
      kind: "turn_ended",
      agentId: "agent-b1",
      turnId: "turn-7b",
      seq: 8,
      receivedAt: AT_UPDATED,
      dedupeKey: "agent-b1|turn-7b|turn_ended",
      disposition: "accepted",
    });
    const twoDecision = two.decisions.find((entry) => entry.subjectId === "t2");
    if (!twoDecision) throw new Error("missing decision");
    twoDecision.cancelIntents = [
      { assignmentId: "assignment-t2-a1", intentId: "intent-cancel-t2" },
      { assignmentId: "assignment-t2-a2", intentId: "intent-cancel-t2-b" },
    ];
    if (twoDecision.answer) twoDecision.answer.taskIds = ["t1", "t2"];
    expect(RunRecordSchema.safeParse(two).success).toBe(true);
    expect(() => assertAssociations("quiescent-two", two)).not.toThrow();

    const extra = structuredClone(two);
    const third = {
      ...first,
      assignmentId: "assignment-t2-a3",
      nonce: "6f1c2a44-3b7e-4f0a-9a11-000000000032",
      messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6",
      state: "assigned" as const,
      turnId: null,
      startedAt: null,
      endedAt: null,
      endedEventKey: null,
      cancellation: null,
      acceptedProof: null,
      delivery: null,
    };
    extra.assignments.push(third);
    extra.outbox.push(
      dispatchIntent({
        id: "intent-t2-a3",
        taskId: "t2",
        assignmentId: "assignment-t2-a3",
        recipient: "agent-b1",
        messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6",
        idempotencyKey: "dispatch-t2-a3",
        state: "confirmed",
        confirmedAt: AT_UPDATED,
      }),
      dispatchIntent({
        id: "intent-cancel-t2-extra",
        kind: "archive",
        taskId: "t2",
        assignmentId: "assignment-t2-a3",
        recipient: "agent-b1",
        messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7",
        idempotencyKey: "cancel-t2-extra",
        state: "confirmed",
        confirmedAt: AT_UPDATED,
      }),
    );
    const extraDecision = extra.decisions.find((entry) => entry.subjectId === "t2");
    if (!extraDecision) throw new Error("missing decision");
    extraDecision.cancelIntents = [
      ...(extraDecision.cancelIntents ?? []),
      { assignmentId: "assignment-t2-a3", intentId: "intent-cancel-t2-extra" },
    ];
    expect(RunRecordSchema.safeParse(extra).success).toBe(true);
    expect(() => assertAssociations("quiescent-two", extra)).toThrow();
  });

  test("C4 LocalNeverSent requires exactly one failed dispatch", () => {
    for (const state of ["confirmed", "sending", "outcome-unknown"] as const) {
      const local = structuredClone(LOCAL_NEVER_SENT_CANCELLED_LEDGER);
      local.outbox.push(
        dispatchIntent({
          id: `intent-t2-extra-${state}`,
          taskId: "t2",
          assignmentId: "assignment-t2-a1",
          recipient: "agent-b1",
          messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8",
          idempotencyKey: `dispatch-t2-extra-${state}`,
          state,
          confirmedAt: state === "confirmed" ? AT_UPDATED : null,
        }),
      );
      expect(RunRecordSchema.safeParse(local).success).toBe(true);
      expect(sourceCodeOf(() => assertAssociations(`local-extra-${state}`, local))).toBe(
        "assignment-dispatch",
      );
    }
  });

  test("C7 LocalNeverSent run, turn, and cancel-audit closure", () => {
    const wrongRun = structuredClone(LOCAL_NEVER_SENT_CANCELLED_LEDGER);
    const wrongNonce = wrongRun.nonceRegistry.find(
      (entry) => entry.assignmentId === "assignment-t2-a1",
    );
    if (!wrongNonce) throw new Error("missing nonce");
    wrongNonce.runId = "run-other-z9";
    expect(RunRecordSchema.safeParse(wrongRun).success).toBe(true);
    expect(sourceCodeOf(() => assertAssociations("local-wrong-run", wrongRun))).toBe("nonce-run");

    const turn = structuredClone(LOCAL_NEVER_SENT_CANCELLED_LEDGER);
    turn.events.push({
      seq: 9,
      kind: "turn_started",
      at: AT_UPDATED,
      payload: { taskId: "t2", turnId: "turn-7" },
    });
    expect(RunRecordSchema.safeParse(turn).success).toBe(true);
    expect(sourceCodeOf(() => assertAssociations("local-turn", turn))).toBe("local-never-sent");

    const audit = structuredClone(LOCAL_NEVER_SENT_CANCELLED_LEDGER);
    const cancelEvent = audit.events.find((entry) => entry.seq === 8);
    if (!cancelEvent) throw new Error("missing cancel event");
    cancelEvent.payload.audit = { localIntentIds: [], supersededDecisionIds: [] };
    expect(RunRecordSchema.safeParse(audit).success).toBe(true);
    expect(sourceCodeOf(() => assertAssociations("local-audit", audit))).toBe("local-never-sent");

    const notRevoked = structuredClone(LOCAL_NEVER_SENT_CANCELLED_LEDGER);
    const nonce = notRevoked.nonceRegistry.find(
      (entry) => entry.assignmentId === "assignment-t2-a1",
    );
    if (!nonce) throw new Error("missing nonce");
    nonce.revokedAt = null;
    nonce.revokeReason = null;
    expect(RunRecordSchema.safeParse(notRevoked).success).toBe(true);
    expect(sourceCodeOf(() => assertAssociations("local-not-revoked", notRevoked))).toBe(
      "local-never-sent",
    );
  });

  test("C6 superseded no-effects resolution and empty-pair branch close", () => {
    const decisionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const withAssignment = structuredClone(LOCAL_NEVER_SENT_CANCELLED_LEDGER);
    const task = withAssignment.tasks.find((entry) => entry.spec.id === "t2");
    const localIntent = withAssignment.outbox.find(
      (entry) => entry.kind === "dispatch" && entry.localCancellation !== null,
    );
    if (!task || !localIntent) throw new Error("missing local closure");
    task.releaseDecisionId = null;
    const event = withAssignment.events.find((entry) => entry.seq === 8);
    if (!event) throw new Error("missing cancel event");
    event.payload.audit = { localIntentIds: [localIntent.id], supersededDecisionIds: [decisionId] };
    withAssignment.decisions.push({
      decisionId,
      category: "D1",
      controlNonceDigest: "b".repeat(64),
      state: "superseded",
      dedupeKey: "cancel:t2",
      subjectId: "t2",
      summary: "No effects remained; administrative close.",
      answer: null,
      answeredAt: null,
      cancelIntents: [],
      resolution: {
        reason: "no-in-flight",
        at: AT_UPDATED,
        eventSeq: 8,
        cause: "cancel-requested",
        witness: {
          kind: "no-effects-cancel",
          taskId: "t2",
          localIntentIds: [localIntent.id],
        },
      },
      createdAt: AT_UPDATED,
    });
    expect(RunRecordSchema.safeParse(withAssignment).success).toBe(true);
    expect(() => assertAssociations("superseded-local", withAssignment)).not.toThrow();

    const zero = structuredClone(withAssignment);
    zero.assignments = zero.assignments.filter((entry) => entry.taskId !== "t2");
    zero.outbox = zero.outbox.filter((entry) => entry.taskId !== "t2");
    zero.nonceRegistry = zero.nonceRegistry.filter((entry) => entry.taskId !== "t2");
    const zeroDecision = zero.decisions[zero.decisions.length - 1];
    if (!zeroDecision?.resolution) throw new Error("missing resolution");
    zeroDecision.resolution.witness.localIntentIds = [];
    const zeroEvent = zero.events.find((entry) => entry.seq === 8);
    if (!zeroEvent) throw new Error("missing event");
    zeroEvent.payload.audit = { localIntentIds: [], supersededDecisionIds: [decisionId] };
    expect(RunRecordSchema.safeParse(zero).success).toBe(true);
    expect(() => assertAssociations("superseded-zero", zero)).not.toThrow();

    const fakeAuth = structuredClone(withAssignment);
    const fakeDecision = fakeAuth.decisions[fakeAuth.decisions.length - 1];
    if (!fakeDecision) throw new Error("missing decision");
    fakeDecision.cancelIntents = [{ assignmentId: "assignment-t2-a1", intentId: localIntent.id }];
    expect(RunRecordSchema.safeParse(fakeAuth).success).toBe(true);
    expect(() => assertAssociations("superseded-fake-pair", fakeAuth)).toThrow();

    const missingAudit = structuredClone(zero);
    missingAudit.events = missingAudit.events.filter((entry) => entry.seq !== 8);
    expect(RunRecordSchema.safeParse(missingAudit).success).toBe(true);
    expect(sourceCodeOf(() => assertAssociations("superseded-missing-audit", missingAudit))).toBe(
      "superseded-cancel-event",
    );
  });

  test("done tasks keep their producer and reviewer proof chain", () => {
    const broken = structuredClone(CANCELLING_LEDGER);
    broken.assignments = broken.assignments.filter((entry) => entry.taskId !== "t1");
    expect(RunRecordSchema.safeParse(broken).success).toBe(true);
    expect(() => assertAssociations("done-without-chain", broken)).toThrow();

    const reviewerOnly = structuredClone(CANCELLING_LEDGER);
    reviewerOnly.assignments = reviewerOnly.assignments.filter(
      (entry) => entry.assignmentId !== "assignment-t1-r1",
    );
    reviewerOnly.nonceRegistry = reviewerOnly.nonceRegistry.filter(
      (entry) => entry.assignmentId !== "assignment-t1-r1",
    );
    reviewerOnly.outbox = reviewerOnly.outbox.filter((entry) => entry.id !== "intent-t1-r1");
    expect(RunRecordSchema.safeParse(reviewerOnly).success).toBe(true);
    expect(sourceCodeOf(() => assertAssociations("done-without-reviewer", reviewerOnly))).toBe(
      "done-reviewer-chain",
    );
  });

  test("i7 negatives retain source closure except their declared target", () => {
    const selfReview = INVARIANT_CASES.find((entry) => entry.id === "i7-self-review")?.ledger;
    if (!selfReview) throw new Error("missing self-review");
    expect(RunRecordSchema.safeParse(selfReview).success).toBe(true);
    expect(() =>
      assertAssociations("i7-self-review", selfReview as LedgerFixture, {
        allowSelfReview: true,
      }),
    ).not.toThrow();

    const noReview = INVARIANT_CASES.find((entry) => entry.id === "i7-done-without-review")?.ledger;
    if (!noReview) throw new Error("missing done-without-review");
    expect(RunRecordSchema.safeParse(noReview).success).toBe(true);
    expect(() =>
      assertAssociations("i7-done-without-review", noReview as LedgerFixture, {
        allowMissingReviewer: true,
      }),
    ).not.toThrow();

    const rework = INVARIANT_CASES.find(
      (entry) => entry.id === "i6-rework-count-below-events",
    )?.ledger;
    if (!rework) throw new Error("missing i6");
    expect(RunRecordSchema.safeParse(rework).success).toBe(true);
    expect(() =>
      assertAssociations("i6-rework-count-below-events", rework as LedgerFixture),
    ).not.toThrow();
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

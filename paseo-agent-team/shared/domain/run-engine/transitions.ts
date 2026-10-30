import type {
  RunAssignment,
  RunCancellationEvidence,
  RunDecisionBinding,
  RunEffectIntent,
  RunEventReceipt,
  RunNonceEntry,
  RunRecord,
  RunTaskRecord,
} from "../../schemas/run-engine/ledger";
import type {
  RunDecisionBlock,
  RunReviewReportBlock,
  RunSmokeReportBlock,
  RunTaskDagBlock,
  RunTaskReportBlock,
} from "../../schemas/run-engine/protocol";

export type Binding = RunDecisionBinding;
export type ArchiveIntent = Extract<RunEffectIntent, { kind: "archive" }>;

/** Internal observation may be non-quiescent; only a valid subset is persisted as 167 evidence. */
export type CancellationObservation = {
  assignmentId: string;
  lastTurnId: string | null;
  endedEventKey: string | null;
  refresh: {
    agentId: string;
    status: "initializing" | "idle" | "running" | "closed" | "error" | "missing";
    activeTurn: boolean;
    observedAt: string;
  } | null;
  observationSeq: number;
  cancelIntentId: string;
  receipt: RunCancellationEvidence["receipt"];
};

export type RunDispatchEvent = {
  kind: "task-dispatched";
  taskId: string;
  assignment: RunAssignment;
  nonce: RunNonceEntry;
  intent: RunEffectIntent;
  claims?: readonly RunRecord["resources"][number][];
  reissueOfAssignmentId: string | null;
};

/** Derived ledger facts are not public reducer commands. */
export const RUN_COUNTER_EVENTS = {
  reworkCount: "rework_started",
  qualityFailures: "quality_failed",
  evidenceReturns: "evidence_returned",
} as const;

export function assignmentPhase(
  assignment: Pick<RunAssignment, "purpose">,
): "implementation" | "review" | "smoke" {
  return assignment.purpose === "reviewer"
    ? "review"
    : assignment.purpose === "smoker"
      ? "smoke"
      : "implementation";
}

/** All assignment purposes are delivered by dispatch; archive/wake/reopen are separate effects. */
export function dispatchIntentMatches(assignment: RunAssignment, intent: RunEffectIntent): boolean {
  return (
    intent.kind === "dispatch" &&
    intent.assignmentId === assignment.assignmentId &&
    intent.taskId === assignment.taskId &&
    intent.messageId === assignment.messageId &&
    intent.recipient === assignment.agentId
  );
}

/** JSON object insertion order is not part of a frozen task definition. */
export function sameStoredValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => sameStoredValue(value, b[index]))
    );
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameStoredValue(left[key], right[key]))
  );
}

/**
 * Complete internal reducer vocabulary. Wire schemas remain unchanged; cancellation intents and
 * observations are engine-internal 194 payloads, not public RPC commands.
 */
export type RunReducerEvent =
  | { kind: "dag-accepted"; block: RunTaskDagBlock }
  | {
      kind: "dag-revised";
      block: RunTaskDagBlock;
      controlNonceDigest: string;
      cancelIntents: readonly Binding[];
      preparedCancelIntents: readonly ArchiveIntent[];
    }
  | RunDispatchEvent
  | { kind: "turn-started"; assignmentId: string; agentId: string; turnId: string }
  | { kind: "turn-ended"; assignmentId: string; endedEventKey: string }
  | { kind: "task-report"; block: RunTaskReportBlock }
  | { kind: "review-report"; block: RunReviewReportBlock }
  | { kind: "smoke-report"; block: RunSmokeReportBlock }
  | { kind: "decision"; block: RunDecisionBlock }
  | {
      kind: "cancel-requested";
      taskIds: readonly [string];
      reason: string;
      controlNonceDigest: string;
      cancelIntents: readonly Binding[];
      preparedCancelIntents: readonly ArchiveIntent[];
    }
  | {
      kind: "cancellation-checked";
      taskId: string;
      evidence: CancellationObservation;
      decisionId: string;
    }
  | { kind: "run-paused" }
  | { kind: "run-resumed" }
  | { kind: "run-finished" }
  | {
      kind: "run-cancelled";
      reason: string;
      controlNonceDigest: string;
      cancelIntents: readonly Binding[];
      preparedCancelIntents: readonly ArchiveIntent[];
    }
  | { kind: "observation-recorded"; receipt: RunEventReceipt };

export const RUN_REDUCER_EVENT_KINDS = [
  "dag-accepted",
  "dag-revised",
  "task-dispatched",
  "turn-started",
  "turn-ended",
  "task-report",
  "review-report",
  "smoke-report",
  "decision",
  "cancel-requested",
  "cancellation-checked",
  "run-paused",
  "run-resumed",
  "run-finished",
  "run-cancelled",
  "observation-recorded",
] as const;

/** Event kinds that B deliberately does not implement; reject loudly instead of ignoring. */
export const BATCH_B_UNSUPPORTED = [
  "work-accepted",
  "review-passed",
  "smoke-passed",
  "dependency-satisfied",
  "force-done",
  "force-transition",
  "dispatch-requested",
] as const;

export type RunFactSource = {
  now: string;
  newId: (kind: string) => string;
};

export function taskById(record: RunRecord, taskId: string): RunTaskRecord | undefined {
  return record.tasks.find((task) => task.spec.id === taskId);
}

export function assignmentById(record: RunRecord, assignmentId: string): RunAssignment | undefined {
  return record.assignments.find((entry) => entry.assignmentId === assignmentId);
}

/** The only settlement proof for an assignment is a true turn-ended receipt, never a report. */
export function isNormalEnded(record: RunRecord, assignment: RunAssignment): boolean {
  if (
    assignment.state !== "ended" ||
    assignment.turnId === null ||
    assignment.endedEventKey === null ||
    assignment.endedAt === null
  ) {
    return false;
  }
  return record.eventReceipts.some(
    (receipt) =>
      receipt.eventKey === assignment.endedEventKey &&
      receipt.kind === "turn_ended" &&
      receipt.agentId === assignment.agentId &&
      receipt.turnId === assignment.turnId &&
      receipt.receivedAt === assignment.endedAt,
  );
}

function dispatchIntents(record: RunRecord, assignmentId: string): RunEffectIntent[] {
  return record.outbox.filter(
    (intent) => intent.kind === "dispatch" && intent.assignmentId === assignmentId,
  );
}

export function isLocalNeverSent(record: RunRecord, assignment: RunAssignment): boolean {
  if (assignment.acceptedProof !== null || assignment.turnId !== null) return false;
  const intents = dispatchIntents(record, assignment.assignmentId);
  if (intents.length !== 1) return false;
  const intent = intents[0] as RunEffectIntent;
  return (
    intent.state === "failed" &&
    intent.localCancellation !== null &&
    intent.localCancellation.eventSeq > 0 &&
    intent.recoverySendCount === 0 &&
    intent.confirmedAt === null
  );
}

function isComplete167(record: RunRecord, assignment: RunAssignment): boolean {
  const evidence = assignment.cancellation;
  if (evidence === undefined || evidence === null) return false;
  if (
    evidence.assignmentId !== assignment.assignmentId ||
    evidence.receipt.kind !== "archive" ||
    evidence.receipt.confirmedAt === null ||
    evidence.receipt.externalId === null ||
    evidence.endedEventKey === null ||
    evidence.lastTurnId === null ||
    evidence.observationSeq === 0
  ) {
    return false;
  }
  return (
    evidence.refresh.activeTurn === false &&
    ["idle", "closed", "missing"].includes(evidence.refresh.status) &&
    record.eventReceipts.some(
      (receipt) =>
        receipt.eventKey === evidence.endedEventKey &&
        receipt.kind === "turn_ended" &&
        receipt.agentId === assignment.agentId &&
        receipt.turnId === evidence.lastTurnId,
    )
  );
}

/** Fixed old cancellation pairs never disappear when a later NormalEnded arrives. */
export function cancelPairs(record: RunRecord, taskId: string): Binding[] {
  return record.decisions
    .filter(
      (decision) =>
        decision.category === "D1" &&
        decision.subjectId === taskId &&
        decision.dedupeKey === `cancel:${taskId}` &&
        decision.cancelIntents !== null,
    )
    .flatMap((decision) => decision.cancelIntents ?? []);
}

export function outstandingAssignments(
  record: RunRecord,
  taskId: string,
): readonly RunAssignment[] {
  const paired = new Set(cancelPairs(record, taskId).map((pair) => pair.assignmentId));
  return record.assignments.filter((assignment) => {
    if (assignment.taskId !== taskId) return false;
    if (paired.has(assignment.assignmentId)) return true;
    if (isLocalNeverSent(record, assignment)) return false;
    if (isComplete167(record, assignment)) return false;
    if (isNormalEnded(record, assignment)) return false;
    if (assignment.startedAt === null && assignment.acceptedProof !== null) return false;
    return true;
  });
}

/** Exact pair coverage over old pairs plus current unsettled actors; no silent prefix. */
export function cancelCoverage(
  record: RunRecord,
  taskIds: readonly string[],
  pairs: readonly Binding[],
): { ok: true } | { ok: false; reason: string } {
  const tasks = new Set(taskIds);
  const expected = new Set<string>();
  for (const taskId of tasks) {
    for (const assignment of outstandingAssignments(record, taskId)) {
      expected.add(assignment.assignmentId);
    }
    for (const pair of cancelPairs(record, taskId)) expected.add(pair.assignmentId);
  }
  const seen = new Set<string>();
  for (const pair of pairs) {
    if (seen.has(pair.assignmentId)) return { ok: false, reason: "duplicate-pair" };
    seen.add(pair.assignmentId);
    const assignment = assignmentById(record, pair.assignmentId);
    if (assignment === undefined || !tasks.has(assignment.taskId)) {
      return { ok: false, reason: "cross-task-pair" };
    }
    const intent = record.outbox.find((entry) => entry.id === pair.intentId);
    if (
      intent === undefined ||
      intent.kind !== "archive" ||
      intent.taskId !== assignment.taskId ||
      intent.assignmentId !== assignment.assignmentId ||
      intent.recipient !== assignment.agentId
    ) {
      return { ok: false, reason: "pair-intent-binding" };
    }
  }
  if (seen.size !== expected.size || [...expected].some((id) => !seen.has(id))) {
    return { ok: false, reason: "incomplete-coverage" };
  }
  return { ok: true };
}

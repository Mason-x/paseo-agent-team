import {
  RUN_EVENT_RECEIPT_KINDS,
  type RunAcceptedProof,
  type RunAssignment,
  type RunCancellationEvidence,
  RunEventReceiptSchema,
  type RunRecord,
  RunRecordSchema,
  RunStoredReviewSchema,
  RunStoredSmokeReportSchema,
  RunStoredTaskReportSchema,
  type RunTaskRecord,
} from "../../schemas/run-engine/ledger";
import type {
  RunReviewReportBlock,
  RunSmokeReportBlock,
  RunTaskReportBlock,
} from "../../schemas/run-engine/protocol";
import { isDecisionPending } from "./decision-state";
import { canonicalKnown, producerHead, proofEqual, resolveD } from "./delivery-binding";
import {
  checkEvidenceGate,
  doneGate,
  failedDeliveryIds,
  normalizeContainedPath,
  reviewEligible,
  smokeEligible,
} from "./gates";
import { checkLedgerInvariants, occupiesExecutionSlot } from "./invariants";
import { nextQualityFailure } from "./scheduler";
import { executionTier, reviewRequirement } from "./tier";
import {
  type ArchiveIntent,
  assignmentById,
  type CancellationObservation,
  cancelCoverage,
  cancellationAuthorization as decisionAuthorization,
  dispatchIntentMatches,
  isComplete167,
  isNormalEnded,
  outstandingAssignments,
  RUN_COUNTER_EVENTS,
  type RunReducerEvent,
  sameStoredValue,
  taskById,
} from "./transitions";

export type RunEffect = { kind: string; payload: Record<string, unknown> };

export type ReduceRejection = {
  ok: false;
  code: "RUN_EVENT_INVALID" | "RUN_INVALID_TRANSITION" | "RUN_INVARIANT_VIOLATION";
  eventSeq?: number;
  taskId?: string;
  path: readonly (string | number)[];
  params: Record<string, string | number | boolean>;
  violations?: readonly { invariant: string; path: readonly (string | number)[] }[];
};

export type ReduceResult =
  | { ok: true; next: RunRecord; effects: readonly RunEffect[] }
  | ReduceRejection;

export type ReduceFacts = {
  now: string;
  newId: (kind: string) => string;
  newDecisionNonceDigest?: (category: "D3" | "D4", taskId: string) => string;
};

function reject(
  code: ReduceRejection["code"],
  path: readonly (string | number)[],
  reason: string,
  extra: Record<string, string | number | boolean> = {},
): ReduceRejection {
  return { ok: false, code, path, params: { reason, ...extra } };
}

function invalidTransition(taskId: string, from: string, to: string): ReduceRejection {
  return reject("RUN_INVALID_TRANSITION", ["tasks", taskId, "state"], "illegal-transition", {
    from,
    to,
  });
}

function taskOf(record: RunRecord, taskId: string): RunTaskRecord | undefined {
  return taskById(record, taskId);
}

function assignmentOf(record: RunRecord, assignmentId: string): RunAssignment | undefined {
  return assignmentById(record, assignmentId);
}

function validControlNonceDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function appendEvent(next: RunRecord, event: RunReducerEvent, facts: ReduceFacts): void {
  const seq = next.counters.eventsThroughSeq + 1;
  next.counters.eventsThroughSeq = seq;
  next.events.push({ seq, kind: event.kind, at: facts.now, payload: { ...event } });
  next.updatedAt = facts.now;
}

function appendCounter(
  next: RunRecord,
  task: RunTaskRecord,
  counter: keyof typeof RUN_COUNTER_EVENTS,
  facts: ReduceFacts,
): void {
  const seq = next.counters.eventsThroughSeq + 1;
  next.counters.eventsThroughSeq = seq;
  next.events.push({
    seq,
    kind: RUN_COUNTER_EVENTS[counter],
    at: facts.now,
    payload: { taskId: task.spec.id, count: task[counter] },
  });
  next.updatedAt = facts.now;
}

function releaseClaims(next: RunRecord, taskId: string): void {
  next.resources = next.resources.filter((claim) => claim.taskId !== taskId);
  const task = taskOf(next, taskId);
  if (task) task.frozenClaimId = null;
}

function markCancelled(next: RunRecord, taskId: string, reason: string, facts: ReduceFacts): void {
  const task = taskOf(next, taskId);
  if (!task || task.state === "done") return;
  for (const assignment of next.assignments) {
    if (assignment.taskId !== taskId) continue;
    if (assignment.state !== "ended" && assignment.state !== "failed") {
      assignment.state = "cancelled";
      const ended = next.eventReceipts.find(
        (entry) => entry.eventKey === assignment.cancellation?.endedEventKey,
      );
      assignment.endedAt = ended?.receivedAt ?? assignment.endedAt;
    }
  }
  task.state = "cancelled";
  task.phase = undefined;
  task.waitingReason = reason;
  task.currentAssignmentId = null;
  releaseClaims(next, taskId);
  for (const nonce of next.nonceRegistry) {
    if (nonce.taskId !== taskId || nonce.revokedAt !== null) continue;
    nonce.revokedAt = facts.now;
    nonce.revokeReason = "cancelled";
  }
}

function freezeTask(
  next: RunRecord,
  taskId: string,
  reason: string,
  facts: ReduceFacts,
  controlNonceDigest: string,
  pairs: readonly { assignmentId: string; intentId: string }[],
): void {
  const task = taskOf(next, taskId);
  if (!task || task.state === "done" || task.state === "cancelled") return;
  task.state = "blocked";
  task.phase = "frozen";
  task.waitingReason = reason;
  for (const claim of next.resources) {
    if (claim.taskId !== taskId) continue;
    claim.frozen = true;
    task.frozenClaimId ??= claim.claimId;
  }
  for (const nonce of next.nonceRegistry) {
    if (nonce.taskId === taskId && nonce.acceptedAt === null && nonce.revokedAt === null) {
      nonce.revokedAt = facts.now;
      nonce.revokeReason = "cancel-requested";
    }
  }
  const sorted = [...pairs].sort((a, b) => a.assignmentId.localeCompare(b.assignmentId));
  const dedupeKey = `cancel:${taskId}`;
  const existing = next.decisions.find((entry) => entry.dedupeKey === dedupeKey);
  if (existing) {
    existing.cancelIntents = sorted;
  } else {
    next.decisions.push({
      decisionId: facts.newId("decision"),
      category: "D1",
      controlNonceDigest,
      state: "open",
      dedupeKey,
      cancelIntents: sorted,
      subjectId: taskId,
      summary: `Cancellation of ${taskId} needs explicit quiescence confirmation.`,
      createdAt: facts.now,
      answeredAt: null,
      answer: null,
      resolution: null,
    });
  }
}

function addPrepared(next: RunRecord, intents: readonly ArchiveIntent[]): string | null {
  for (const intent of intents) {
    if (
      intent.kind !== "archive" ||
      intent.state !== "prepared" ||
      intent.recoverySendCount !== 0 ||
      intent.confirmedAt !== null ||
      intent.localCancellation !== null ||
      next.outbox.some((entry) => entry.id === intent.id)
    ) {
      return "prepared-cancel-intent";
    }
    next.outbox.push(structuredClone(intent));
  }
  return null;
}

function markLocalCancellations(
  next: RunRecord,
  taskId: string,
  cause: "cancel-requested" | "dag-revised" | "run-cancelled",
  facts: ReduceFacts,
): void {
  const eventSeq = next.counters.eventsThroughSeq + 1;
  for (const intent of next.outbox) {
    if (intent.kind !== "dispatch" || intent.taskId !== taskId) continue;
    const assignment = assignmentOf(next, intent.assignmentId);
    if (
      assignment === undefined ||
      assignment.acceptedProof !== null ||
      assignment.turnId !== null
    ) {
      continue;
    }
    if (
      intent.state !== "prepared" ||
      intent.recoverySendCount !== 0 ||
      intent.confirmedAt !== null ||
      intent.localCancellation !== null
    ) {
      continue;
    }
    intent.state = "failed";
    intent.localCancellation = {
      reason: "cancel-before-send",
      at: facts.now,
      eventSeq,
      cause,
    };
    const nonce = next.nonceRegistry.find((entry) => entry.nonce === assignment.nonce);
    if (nonce && nonce.acceptedAt === null && nonce.revokedAt === null) {
      nonce.revokedAt = facts.now;
      nonce.revokeReason = "cancel-before-send";
    }
    const claim = next.resources.find(
      (entry) =>
        entry.originAssignmentId === assignment.assignmentId && entry.taskId === assignment.taskId,
    );
    if (claim) {
      next.resources = next.resources.filter((entry) => entry !== claim);
      const task = taskOf(next, taskId);
      if (task?.frozenClaimId === claim.claimId) task.frozenClaimId = null;
    }
  }
}

function unsettledIntents(record: RunRecord, taskId: string): boolean {
  return record.outbox.some(
    (intent) =>
      intent.taskId === taskId &&
      (intent.state === "prepared" ||
        intent.state === "sending" ||
        intent.state === "outcome-unknown" ||
        (intent.state === "failed" && intent.localCancellation === null)),
  );
}

function releaseIfSettled(next: RunRecord, taskId: string, facts: ReduceFacts): void {
  const pairs = next.decisions.find(
    (decision) =>
      decision.category === "D1" &&
      decision.subjectId === taskId &&
      decision.dedupeKey === `cancel:${taskId}`,
  )?.cancelIntents;
  if (!pairs || pairs.length === 0) return;
  const allQuiescent = pairs.every((pair) => {
    const assignment = assignmentOf(next, pair.assignmentId);
    return assignment !== undefined && isComplete167(next, assignment);
  });
  if (!allQuiescent || unsettledIntents(next, taskId)) return;
  const authorization = decisionAuthorization(next, taskId);
  if (!authorization) return;
  for (const pair of pairs) {
    const assignment = assignmentOf(next, pair.assignmentId);
    if (assignment?.cancellation)
      assignment.cancellation.observationSeq = next.counters.observationSeq;
  }
  markCancelled(next, taskId, "cancelled", facts);
  const task = taskOf(next, taskId);
  if (task) task.releaseDecisionId = authorization.decisionId;
}

function applyCancellation(
  next: RunRecord,
  taskId: string,
  reason: string,
  controlNonceDigest: string,
  pairs: readonly { assignmentId: string; intentId: string }[],
  facts: ReduceFacts,
): ReduceRejection | null {
  const task = taskOf(next, taskId);
  if (!task) return reject("RUN_EVENT_INVALID", ["cancel", "taskIds"], "unknown-task");
  if (task.state === "done") {
    return reject("RUN_INVALID_TRANSITION", ["tasks", taskId, "state"], "cancel-done");
  }
  if (task.state === "cancelled") {
    return pairs.length === 0 && next.resources.every((claim) => claim.taskId !== taskId)
      ? null
      : reject("RUN_INVALID_TRANSITION", ["tasks", taskId, "state"], "cancel-terminal");
  }
  const outstanding = outstandingAssignments(next, taskId);
  if (
    outstanding.length === 0 &&
    !unsettledIntents(next, taskId) &&
    !next.resources.some((claim) => claim.taskId === taskId)
  ) {
    markCancelled(next, taskId, reason, facts);
    return null;
  }
  const taskPairs = pairs.filter(
    (pair) => assignmentOf(next, pair.assignmentId)?.taskId === taskId,
  );
  const coverage = cancelCoverage(next, [taskId], taskPairs);
  if (!coverage.ok) {
    return reject("RUN_EVENT_INVALID", ["cancel", "cancelIntents"], coverage.reason);
  }
  freezeTask(next, taskId, reason, facts, controlNonceDigest, taskPairs);
  return null;
}

function claimMatchesTask(task: RunTaskRecord, claim: RunRecord["resources"][number]): boolean {
  if (claim.taskId !== task.spec.id || claim.originAssignmentId.length === 0) return false;
  if (claim.kind === "hot" || claim.kind === "tool") return claim.path.length > 0;
  const claimPath = normalizeContainedPath(claim.path);
  if (claimPath === null) return false;
  return task.spec.scopes.some(
    (scope) =>
      scope.repoId === claim.repoId &&
      scope.access === claim.access &&
      (scope.kind === "file"
        ? claim.kind === "file" && normalizeContainedPath(scope.path) === claimPath
        : (claim.kind === "file" || claim.kind === "directory") &&
          (claimPath === normalizeContainedPath(scope.path) ||
            claimPath.startsWith(`${normalizeContainedPath(scope.path)}/`))),
  );
}

function readyForDone(record: RunRecord, task: RunTaskRecord): boolean {
  return doneGate(record, task).ok;
}

function recomputeDone(next: RunRecord, task: RunTaskRecord): void {
  if (task.state !== "review") return;
  if (task.spec.devSmoke && task.phase !== "smoke") {
    task.phase = "smoke";
  }
  if (readyForDone(next, task)) {
    task.state = "done";
    task.phase = undefined;
    task.waitingReason = null;
    task.currentAssignmentId = null;
    releaseClaims(next, task.spec.id);
  }
}

function afterGateFailure(
  next: RunRecord,
  task: RunTaskRecord,
  reason: string,
  facts: ReduceFacts,
  producer: RunAssignment,
): ReduceRejection | null {
  task.qualityFailures += 1;
  appendCounter(next, task, "qualityFailures", facts);
  const plan = nextQualityFailure(task, next.policy);
  if (plan.kind === "blocked") {
    const digest = facts.newDecisionNonceDigest?.(plan.decision, task.spec.id);
    if (!validControlNonceDigest(digest)) {
      return reject(
        "RUN_EVENT_INVALID",
        ["facts", "newDecisionNonceDigest"],
        "missing-control-nonce-digest",
      );
    }
    task.state = plan.decision === "D3" ? "failed" : "blocked";
    task.phase = plan.decision === "D3" ? undefined : "frozen";
    task.waitingReason = plan.reason;
    for (const claim of next.resources) {
      if (claim.taskId !== task.spec.id) continue;
      claim.frozen = true;
      task.frozenClaimId ??= claim.claimId;
    }
    next.decisions.push({
      decisionId: facts.newId("decision"),
      category: plan.decision,
      controlNonceDigest: digest,
      state: "open",
      dedupeKey: `quality:${producer.assignmentId}:${plan.decision}`,
      cancelIntents: null,
      subjectId: task.spec.id,
      summary: `${plan.decision}: ${plan.reason}`,
      createdAt: facts.now,
      answeredAt: null,
      answer: null,
      resolution: null,
    });
    return null;
  }
  if (plan.kind === "escalate") {
    task.escalations.push({
      fromTier: executionTier(task),
      toTier: plan.nextTier,
      atAttempt: producer.attempt,
      qualityFailures: task.qualityFailures,
      at: facts.now,
    });
  }
  const active = next.tasks.filter((entry) => occupiesExecutionSlot(next, entry)).length;
  const taskSettled = next.assignments
    .filter((entry) => entry.taskId === task.spec.id)
    .every((entry) => isNormalEnded(next, entry));
  if (active < next.policy.configuredConcurrency && taskSettled) {
    task.state = "rework";
    task.phase = undefined;
    task.waitingReason = reason;
  } else {
    task.state = "review";
    task.phase = "awaiting-rework";
    task.waitingReason = reason;
  }
  return null;
}

function advanceRework(next: RunRecord, task: RunTaskRecord): void {
  if (task.state !== "review" || task.phase !== "awaiting-rework") return;
  if (
    next.decisions.some(
      (entry) => entry.dedupeKey === `cancel:${task.spec.id}` && entry.state !== "superseded",
    )
  )
    return;
  if (
    next.assignments.some((entry) => entry.taskId === task.spec.id && !isNormalEnded(next, entry))
  )
    return;
  const activeOthers = next.tasks.filter(
    (entry) => entry.spec.id !== task.spec.id && occupiesExecutionSlot(next, entry),
  ).length;
  if (activeOthers < next.policy.configuredConcurrency) {
    task.state = "rework";
    task.phase = undefined;
  }
}

function qualityReplyWindow(record: RunRecord, task: RunTaskRecord): boolean {
  if (
    record.decisions.some(
      (entry) => entry.dedupeKey === `cancel:${task.spec.id}` && entry.state !== "superseded",
    )
  )
    return false;
  const d = resolveD(record, task.spec.id);
  return (
    d.kind === "ok" &&
    ["review", "rework", "failed", "blocked"].includes(task.state) &&
    failedDeliveryIds(record, task).includes(d.d.producer.assignmentId)
  );
}

function storedTaskProof(
  block: RunTaskReportBlock,
  assignment: RunAssignment,
): RunRecord["assignments"][number]["acceptedProof"] {
  const parsed = RunStoredTaskReportSchema.safeParse({ ...block, messageId: assignment.messageId });
  return parsed.success ? parsed.data : null;
}

function storedReviewProof(
  block: RunReviewReportBlock,
  assignment: RunAssignment,
): RunAcceptedProof | null {
  const parsed = RunStoredReviewSchema.safeParse({ ...block, messageId: assignment.messageId });
  return parsed.success ? parsed.data : null;
}

function storedSmokeProof(
  block: RunSmokeReportBlock,
  assignment: RunAssignment,
): RunRecord["assignments"][number]["acceptedProof"] {
  const parsed = RunStoredSmokeReportSchema.safeParse({
    ...block,
    messageId: assignment.messageId,
  });
  return parsed.success ? parsed.data : null;
}

function acceptNonce(next: RunRecord, assignment: RunAssignment, facts: ReduceFacts): void {
  const nonce = next.nonceRegistry.find(
    (entry) =>
      entry.nonce === assignment.nonce &&
      entry.assignmentId === assignment.assignmentId &&
      entry.taskId === assignment.taskId,
  );
  if (!nonce || nonce.revokedAt !== null || nonce.acceptedAt !== null) return;
  nonce.acceptedAt = facts.now;
  nonce.acceptedEventKey = `proof:${assignment.assignmentId}`;
}

function liveAuthorized(next: RunRecord, assignment: RunAssignment): boolean {
  if (assignment.state === "cancelled" || assignment.state === "failed") return false;
  const intents = next.outbox.filter(
    (entry) => entry.kind === "dispatch" && entry.assignmentId === assignment.assignmentId,
  );
  const intent = intents.length === 1 ? intents[0] : undefined;
  if (
    !intent ||
    !dispatchIntentMatches(assignment, intent) ||
    intent.localCancellation !== null ||
    !["sending", "confirmed", "outcome-unknown"].includes(intent.state)
  )
    return false;
  const nonce = next.nonceRegistry.find((entry) => entry.nonce === assignment.nonce);
  return nonce !== undefined && nonce.revokedAt === null && nonce.acceptedAt === null;
}

function proofFromEvent(
  event: RunReducerEvent,
  assignment: RunAssignment,
): RunAcceptedProof | null {
  if (
    (event.kind === "task-report" ||
      event.kind === "review-report" ||
      event.kind === "smoke-report") &&
    event.block.messageId !== undefined &&
    event.block.messageId !== assignment.messageId
  )
    return null;
  if (event.kind === "task-report") return storedTaskProof(event.block, assignment);
  if (event.kind === "review-report") return storedReviewProof(event.block, assignment);
  if (event.kind === "smoke-report") return storedSmokeProof(event.block, assignment);
  return null;
}

function eventAssignmentId(event: RunReducerEvent): string | null {
  return event.kind === "task-report" ||
    event.kind === "review-report" ||
    event.kind === "smoke-report"
    ? event.block.assignmentId
    : null;
}

function sameAcceptedProof(record: RunRecord, event: RunReducerEvent): boolean {
  const assignmentId = eventAssignmentId(event);
  if (assignmentId === null) return false;
  const assignment = assignmentOf(record, assignmentId);
  if (!assignment || assignment.acceptedProof === null) return false;
  const parsed = proofFromEvent(event, assignment);
  return (
    parsed !== null && proofEqual(canonicalKnown(assignment.acceptedProof), canonicalKnown(parsed))
  );
}

function applyEvent(
  next: RunRecord,
  event: RunReducerEvent,
  facts: ReduceFacts,
): ReduceResult | null {
  switch (event.kind) {
    case "dag-accepted": {
      if (event.block.runId !== next.runId)
        return reject("RUN_EVENT_INVALID", ["dag", "runId"], "run-mismatch");
      if (next.lifecycle !== "bootstrapping" && next.lifecycle !== "awaiting-dag") {
        return invalidTransition(event.block.taskId, next.lifecycle, "active");
      }
      next.tasks = event.block.tasks.map((spec) => ({
        spec,
        state: "pending",
        waitingReason: null,
        ref: null,
        changedFiles: [],
        currentAssignmentId: null,
        attempts: 0,
        protocolFailures: 0,
        evidenceReturns: 0,
        reworkCount: 0,
        qualityFailures: 0,
        escalations: [],
        frozenClaimId: null,
        releaseDecisionId: null,
      }));
      next.dagRevision = event.block.dagRevision;
      next.lifecycle = "active";
      recomputeReady(next);
      return null;
    }
    case "dag-revised": {
      if (!validControlNonceDigest(event.controlNonceDigest)) {
        return reject("RUN_EVENT_INVALID", ["dag", "controlNonceDigest"], "invalid-digest");
      }
      if (event.block.runId !== next.runId)
        return reject("RUN_EVENT_INVALID", ["dag", "runId"], "run-mismatch");
      if (
        event.block.expectedDagRevision !== next.dagRevision ||
        event.block.dagRevision !== next.dagRevision + 1
      ) {
        return reject("RUN_EVENT_INVALID", ["dag", "expectedDagRevision"], "stale-dag");
      }
      for (const taskId of event.block.cancelTaskIds) {
        const task = taskOf(next, taskId);
        if (!task) return reject("RUN_EVENT_INVALID", ["dag", "cancelTaskIds"], "unknown-task");
        if (task.state === "done" || task.state === "cancelled") {
          return reject("RUN_INVALID_TRANSITION", ["dag", "cancelTaskIds"], "terminal-cancel");
        }
      }
      const prepared = addPrepared(next, event.preparedCancelIntents);
      if (prepared)
        return reject("RUN_EVENT_INVALID", ["cancel", "preparedCancelIntents"], prepared);
      for (const taskId of event.block.cancelTaskIds) {
        markLocalCancellations(next, taskId, "dag-revised", facts);
      }
      const coverage = cancelCoverage(next, event.block.cancelTaskIds, event.cancelIntents);
      if (!coverage.ok)
        return reject("RUN_EVENT_INVALID", ["cancel", "cancelIntents"], coverage.reason);
      for (const taskId of event.block.cancelTaskIds) {
        const failure = applyCancellation(
          next,
          taskId,
          "dag-revised",
          event.controlNonceDigest,
          event.cancelIntents,
          facts,
        );
        if (failure) return failure;
      }
      const incoming = new Map(event.block.tasks.map((spec) => [spec.id, spec]));
      const updated: RunRecord["tasks"] = [];
      for (const task of next.tasks) {
        const spec = incoming.get(task.spec.id);
        if (!spec) {
          if (
            task.state === "done" ||
            task.state === "cancelled" ||
            event.block.cancelTaskIds.includes(task.spec.id)
          ) {
            updated.push(task);
          } else
            return reject("RUN_INVALID_TRANSITION", ["tasks", task.spec.id], "active-task-removed");
          continue;
        }
        if (task.state === "done" || task.state === "cancelled") {
          if (!sameStoredValue(spec, task.spec))
            return reject(
              "RUN_INVALID_TRANSITION",
              ["tasks", task.spec.id],
              "terminal-task-changed",
            );
          updated.push(task);
        } else if (
          ["assigned", "in_progress", "review", "rework", "blocked", "failed"].includes(task.state)
        ) {
          if (!sameStoredValue(spec, task.spec))
            return reject("RUN_INVALID_TRANSITION", ["tasks", task.spec.id], "active-task-changed");
          updated.push(task);
        } else {
          updated.push({ ...task, spec });
        }
        incoming.delete(task.spec.id);
      }
      for (const spec of incoming.values()) {
        updated.push({
          spec,
          state: "pending",
          waitingReason: null,
          ref: null,
          changedFiles: [],
          currentAssignmentId: null,
          attempts: 0,
          protocolFailures: 0,
          evidenceReturns: 0,
          reworkCount: 0,
          qualityFailures: 0,
          escalations: [],
          frozenClaimId: null,
          releaseDecisionId: null,
        });
      }
      next.tasks = updated;
      next.dagRevision = event.block.dagRevision;
      next.lifecycle = "active";
      recomputeReady(next);
      return null;
    }
    case "task-dispatched": {
      if (next.lifecycle !== "active")
        return invalidTransition(event.taskId, next.lifecycle, "assigned");
      const task = taskOf(next, event.taskId);
      if (!task) return invalidTransition(event.taskId, "missing", "assigned");
      const { assignment } = event;
      const producer = ["member", "coordinator", "reopen"].includes(assignment.purpose);
      const reviewer = assignment.purpose === "reviewer";
      const smoker = assignment.purpose === "smoker";
      if (
        !dispatchIntentMatches(assignment, event.intent) ||
        next.assignments.some((entry) => entry.assignmentId === assignment.assignmentId) ||
        next.nonceRegistry.some((entry) => entry.nonce === event.nonce.nonce) ||
        next.outbox.some((entry) => entry.id === event.intent.id) ||
        assignment.taskId !== event.taskId ||
        event.intent.taskId !== event.taskId ||
        assignment.nonce !== event.nonce.nonce ||
        assignment.attempt !== event.nonce.attempt ||
        event.nonce.assignmentId !== assignment.assignmentId ||
        event.nonce.taskId !== event.taskId
      ) {
        return reject("RUN_EVENT_INVALID", ["assignment", "taskId"], "assignment-mismatch");
      }
      if (
        assignment.state !== "assigned" ||
        assignment.startedAt !== null ||
        assignment.endedAt !== null ||
        assignment.turnId !== null ||
        assignment.endedEventKey !== null ||
        assignment.acceptedProof !== null ||
        event.nonce.acceptedAt !== null ||
        event.nonce.acceptedEventKey !== null ||
        event.nonce.revokedAt !== null
      ) {
        return reject("RUN_EVENT_INVALID", ["assignment", "state"], "untrusted-assignment");
      }
      if (producer) {
        const awaiting = task.state === "review" && task.phase === "awaiting-rework";
        const reissue = event.reissueOfAssignmentId ?? null;
        if (reissue === null && !["ready", "rework"].includes(task.state) && !awaiting) {
          return invalidTransition(event.taskId, task.state, "assigned");
        }
        if (reissue !== null) {
          const old = assignmentOf(next, reissue);
          const head = producerHead(next, task.spec.id);
          if (
            !old ||
            old.taskId !== task.spec.id ||
            old.attempt !== assignment.attempt ||
            !isNormalEnded(next, old) ||
            head.kind !== "ok" ||
            head.assignment.assignmentId !== old.assignmentId ||
            checkEvidenceGate(next, task).ok ||
            task.state === "blocked" ||
            task.state === "failed" ||
            task.state === "cancelled" ||
            task.state === "done" ||
            (old.supersededByAssignmentId !== undefined && old.supersededByAssignmentId !== null) ||
            !old.acceptedProof ||
            !("status" in old.acceptedProof) ||
            old.acceptedProof.status !== "done"
          ) {
            return reject("RUN_EVENT_INVALID", ["assignment", "reissueOfAssignmentId"], "reissue");
          }
          if (assignment.attempt !== task.attempts)
            return reject("RUN_EVENT_INVALID", ["assignment", "attempt"], "attempt-mismatch");
        } else if (assignment.attempt !== task.attempts + 1) {
          return reject("RUN_EVENT_INVALID", ["assignment", "attempt"], "attempt-mismatch");
        }
        if (
          reissue === null &&
          task.attempts > 0 &&
          next.assignments.some(
            (entry) => entry.taskId === task.spec.id && !isNormalEnded(next, entry),
          )
        ) {
          return reject("RUN_INVALID_TRANSITION", ["tasks", task.spec.id], "actors-unsettled");
        }
        const activeOthers = next.tasks.filter(
          (entry) => entry.spec.id !== task.spec.id && occupiesExecutionSlot(next, entry),
        ).length;
        if (activeOthers >= next.policy.configuredConcurrency) {
          return reject("RUN_INVALID_TRANSITION", ["tasks", task.spec.id, "state"], "capacity");
        }
        const existingClaims = next.resources.filter((entry) => entry.taskId === task.spec.id);
        const requested =
          reissue !== null || awaiting || task.state === "rework" ? [] : (event.claims ?? []);
        const reuseExisting = requested.length === 0 && existingClaims.length > 0;
        const claims = reuseExisting ? existingClaims : requested;
        if (
          task.spec.scopes.some((scope) => scope.access === "write") &&
          claims.length === 0 &&
          existingClaims.length === 0
        ) {
          return reject("RUN_EVENT_INVALID", ["claims"], "claim-required");
        }
        for (const claim of claims) {
          if (
            !claimMatchesTask(task, claim) ||
            (!reuseExisting && claim.originAssignmentId !== assignment.assignmentId)
          ) {
            return reject("RUN_EVENT_INVALID", ["claims"], "claim-not-in-scope");
          }
        }
        const claimIds = new Set(
          next.resources
            .filter((entry) => entry.taskId !== task.spec.id)
            .map((entry) => entry.claimId),
        );
        for (const claim of claims) {
          if (claimIds.has(claim.claimId))
            return reject("RUN_EVENT_INVALID", ["claims"], "claim-duplicate");
          claimIds.add(claim.claimId);
        }
        if (reissue !== null) {
          const old = assignmentOf(next, reissue);
          if (old) old.supersededByAssignmentId = assignment.assignmentId;
        } else {
          next.resources = next.resources.filter((entry) => entry.taskId !== task.spec.id);
          next.resources.push(...claims);
          if (task.attempts > 0) {
            task.reworkCount += 1;
            appendCounter(next, task, "reworkCount", facts);
          }
        }
        task.ref = null;
        task.changedFiles = [];
        for (const nonce of next.nonceRegistry) {
          if (
            nonce.taskId === task.spec.id &&
            nonce.acceptedAt === null &&
            nonce.revokedAt === null
          ) {
            nonce.revokedAt = facts.now;
            nonce.revokeReason = "superseded-delivery";
          }
        }
        task.attempts = assignment.attempt;
        task.state = "assigned";
        task.phase = "implementation";
        task.waitingReason = null;
        task.frozenClaimId = null;
      } else {
        if (task.state !== "review") return invalidTransition(event.taskId, task.state, "review");
        if (reviewer && task.phase !== "review" && task.phase !== "smoke") {
          return invalidTransition(event.taskId, task.phase ?? task.state, "review");
        }
        if (smoker && task.phase !== "smoke")
          return invalidTransition(event.taskId, task.phase ?? task.state, "smoke");
        const d = resolveD(next, task.spec.id);
        if (d.kind !== "ok")
          return reject("RUN_EVENT_INVALID", ["assignment", "delivery"], "missing-delivery");
        if (
          assignment.attempt !== d.d.producer.attempt ||
          assignment.delivery?.producerAssignmentId !== d.d.producer.assignmentId
        ) {
          return reject("RUN_EVENT_INVALID", ["assignment", "delivery"], "delivery-attempt");
        }
        if (reviewer) {
          const requirement = reviewRequirement(task);
          if (assignment.tier !== requirement.tier)
            return reject("RUN_EVENT_INVALID", ["assignment", "tier"], "tier-mismatch");
          if (failedDeliveryIds(next, task).includes(d.d.producer.assignmentId)) {
            return reject("RUN_EVENT_INVALID", ["assignment", "delivery"], "failed-delivery");
          }
        }
        if (
          smoker &&
          next.assignments.some(
            (entry) =>
              entry.taskId === task.spec.id &&
              entry.purpose === "smoker" &&
              entry.delivery?.producerAssignmentId === d.d.producer.assignmentId &&
              !isNormalEnded(next, entry) &&
              entry.acceptedProof === null,
          )
        ) {
          return reject("RUN_EVENT_INVALID", ["assignment", "purpose"], "unsettled-smoker");
        }
        task.currentAssignmentId = assignment.assignmentId;
        task.waitingReason = null;
      }
      task.currentAssignmentId = assignment.assignmentId;
      next.assignments.push(assignment);
      next.nonceRegistry.push(event.nonce);
      next.outbox.push(event.intent);
      return null;
    }
    case "turn-started": {
      const assignment = assignmentOf(next, event.assignmentId);
      const task = assignment ? taskOf(next, assignment.taskId) : undefined;
      if (
        !assignment ||
        !task ||
        assignment.state === "cancelled" ||
        assignment.state === "ended"
      ) {
        return reject(
          "RUN_EVENT_INVALID",
          ["assignments", event.assignmentId],
          "unknown-assignment",
        );
      }
      if (event.agentId !== assignment.agentId)
        return reject("RUN_EVENT_INVALID", ["turn-started", event.assignmentId], "agent-mismatch");
      const reviewer = assignment.purpose === "reviewer" || assignment.purpose === "smoker";
      const head = producerHead(next, task.spec.id);
      if (
        !reviewer &&
        (head.kind !== "ok" || head.assignment.assignmentId !== assignment.assignmentId)
      ) {
        return reject(
          "RUN_EVENT_INVALID",
          ["assignments", event.assignmentId],
          "not-producer-head",
        );
      }
      if (!reviewer && task.state !== "assigned" && task.state !== "in_progress") {
        return invalidTransition(task.spec.id, task.state, "in_progress");
      }
      if (assignment.turnId !== null || assignment.startedAt !== null) {
        return reject("RUN_EVENT_INVALID", ["assignments", event.assignmentId], "already-started");
      }
      assignment.state = "in_progress";
      assignment.startedAt = facts.now;
      assignment.turnId = event.turnId;
      if (!reviewer) {
        task.state = "in_progress";
        task.phase = "implementation";
      }
      return null;
    }
    case "turn-ended": {
      const assignment = assignmentOf(next, event.assignmentId);
      if (!assignment || assignment.state === "cancelled" || event.endedEventKey.trim() === "") {
        return reject(
          "RUN_EVENT_INVALID",
          ["assignments", event.assignmentId],
          "unknown-assignment",
        );
      }
      const ended = next.eventReceipts.find(
        (receipt) =>
          receipt.eventKey === event.endedEventKey &&
          receipt.kind === "turn_ended" &&
          receipt.agentId === assignment.agentId &&
          assignment.turnId !== null &&
          receipt.turnId === assignment.turnId,
      );
      if (!ended)
        return reject(
          "RUN_EVENT_INVALID",
          ["turn-ended", event.endedEventKey],
          "ended-receipt-mismatch",
        );
      if (assignment.endedEventKey !== null && assignment.endedEventKey !== event.endedEventKey) {
        return reject(
          "RUN_EVENT_INVALID",
          ["assignments", event.assignmentId, "endedEventKey"],
          "ended-mismatch",
        );
      }
      assignment.state = "ended";
      assignment.endedAt = ended.receivedAt;
      assignment.endedEventKey = event.endedEventKey;
      const task = taskOf(next, assignment.taskId);
      if (task?.state === "review") recomputeDone(next, task);
      return null;
    }
    case "task-report": {
      const block = event.block;
      const task = taskOf(next, block.taskId);
      const assignment = assignmentOf(next, block.assignmentId);
      if (!task || !assignment || assignment.taskId !== block.taskId) {
        return reject("RUN_EVENT_INVALID", ["task-report", block.taskId], "unknown-assignment");
      }
      if (
        block.runId !== next.runId ||
        block.attempt !== assignment.attempt ||
        block.nonce !== assignment.nonce ||
        !["member", "coordinator", "reopen"].includes(assignment.purpose) ||
        (block.messageId !== undefined && block.messageId !== assignment.messageId)
      ) {
        return reject("RUN_EVENT_INVALID", ["task-report", block.taskId], "identity-mismatch");
      }
      if (task.state !== "assigned" && task.state !== "in_progress") {
        return invalidTransition(block.taskId, task.state, "review");
      }
      if (!liveAuthorized(next, assignment)) {
        return reject("RUN_EVENT_INVALID", ["task-report", "nonce"], "nonce-invalid");
      }
      const proof = storedTaskProof(block, assignment);
      if (proof === null) return reject("RUN_EVENT_INVALID", ["task-report"], "invalid-proof");
      acceptNonce(next, assignment, facts);
      assignment.acceptedProof = proof;
      if (block.status !== "done") {
        task.state = block.status;
        task.phase = block.status === "blocked" ? "frozen" : undefined;
        task.waitingReason = block.reasonCode;
        for (const claim of next.resources) {
          if (claim.taskId !== task.spec.id) continue;
          claim.frozen = true;
          task.frozenClaimId ??= claim.claimId;
        }
        return null;
      }
      const evidence = checkEvidenceGate(next, task);
      if (!evidence.ok) {
        task.evidenceReturns += 1;
        appendCounter(next, task, "evidenceReturns", facts);
        task.waitingReason = String(evidence.issues[0]?.params.reason ?? "evidence");
        return null;
      }
      const doneProof = RunStoredTaskReportSchema.parse(proof) as Extract<
        RunAcceptedProof,
        { status: "done" }
      >;
      task.ref = doneProof.ref;
      task.changedFiles = [...doneProof.changedFiles];
      task.state = "review";
      task.phase = "review";
      task.waitingReason = null;
      return null;
    }
    case "review-report": {
      const block = event.block;
      const task = taskOf(next, block.taskId);
      const assignment = assignmentOf(next, block.assignmentId);
      if (!task || !assignment || assignment.taskId !== block.taskId) {
        return reject("RUN_EVENT_INVALID", ["review-report", block.taskId], "unknown-assignment");
      }
      if (
        (task.state !== "review" || (task.phase !== "review" && task.phase !== "smoke")) &&
        !qualityReplyWindow(next, task)
      ) {
        return invalidTransition(block.taskId, task.state, "review");
      }
      if (
        assignment.purpose !== "reviewer" ||
        block.runId !== next.runId ||
        block.attempt !== assignment.attempt ||
        block.nonce !== assignment.nonce ||
        (block.messageId !== undefined && block.messageId !== assignment.messageId)
      ) {
        return reject("RUN_EVENT_INVALID", ["review-report", block.taskId], "identity-mismatch");
      }
      if (!liveAuthorized(next, assignment))
        return reject("RUN_EVENT_INVALID", ["review-report", "nonce"], "nonce-invalid");
      const proof = storedReviewProof(block, assignment);
      if (proof === null) return reject("RUN_EVENT_INVALID", ["review-report"], "invalid-proof");
      const before = new Set(failedDeliveryIds(next, task));
      acceptNonce(next, assignment, facts);
      assignment.acceptedProof = proof;
      const resolved = resolveD(next, task.spec.id);
      if (resolved.kind !== "ok" || !reviewEligibleProof(next, task, assignment, proof)) {
        return reject("RUN_EVENT_INVALID", ["review-report", block.taskId], "no-valid-review");
      }
      const failed = failedDeliveryIds(next, task);
      const producerId = resolved.d.producer.assignmentId;
      if (failed.includes(producerId) && !before.has(producerId)) {
        return afterGateFailure(next, task, "blocked-review", facts, resolved.d.producer);
      }
      if (!failed.includes(producerId)) {
        if (task.spec.devSmoke) task.phase = "smoke";
        recomputeDone(next, task);
      }
      return null;
    }
    case "smoke-report": {
      const block = event.block;
      const task = taskOf(next, block.taskId);
      const assignment = assignmentOf(next, block.assignmentId);
      if (!task || !assignment || assignment.taskId !== block.taskId) {
        return reject("RUN_EVENT_INVALID", ["smoke-report", block.taskId], "unknown-assignment");
      }
      if ((task.state !== "review" || task.phase !== "smoke") && !qualityReplyWindow(next, task)) {
        return invalidTransition(block.taskId, task.state, "done");
      }
      if (
        assignment.purpose !== "smoker" ||
        block.runId !== next.runId ||
        block.attempt !== assignment.attempt ||
        block.nonce !== assignment.nonce ||
        (block.messageId !== undefined && block.messageId !== assignment.messageId)
      ) {
        return reject("RUN_EVENT_INVALID", ["smoke-report", block.taskId], "identity-mismatch");
      }
      if (!liveAuthorized(next, assignment))
        return reject("RUN_EVENT_INVALID", ["smoke-report", "nonce"], "nonce-invalid");
      const proof = storedSmokeProof(block, assignment);
      if (proof === null) return reject("RUN_EVENT_INVALID", ["smoke-report"], "invalid-proof");
      const before = new Set(failedDeliveryIds(next, task));
      acceptNonce(next, assignment, facts);
      assignment.acceptedProof = proof;
      const resolved = resolveD(next, task.spec.id);
      if (resolved.kind !== "ok")
        return reject("RUN_EVENT_INVALID", ["smoke-report", "delivery"], "missing-delivery");
      const smoke = RunStoredSmokeReportSchema.safeParse(proof);
      if (!smoke.success || !smokeEligible(next, task, assignment, smoke.data)) {
        return reject("RUN_EVENT_INVALID", ["smoke-report"], "invalid-smoke");
      }
      const failed = failedDeliveryIds(next, task);
      const producerId = resolved.d.producer.assignmentId;
      if (failed.includes(producerId) && !before.has(producerId)) {
        return afterGateFailure(next, task, "failed-smoke", facts, resolved.d.producer);
      }
      if (!failed.includes(producerId)) recomputeDone(next, task);
      return null;
    }
    case "cancellation-checked": {
      if (
        !Number.isSafeInteger(event.evidence.observationSeq) ||
        event.evidence.observationSeq < 0 ||
        event.evidence.observationSeq > next.counters.observationSeq
      ) {
        return reject(
          "RUN_EVENT_INVALID",
          ["cancellation", "observationSeq"],
          "observation-watermark",
        );
      }
      const task = taskOf(next, event.taskId);
      const assignment = assignmentOf(next, event.evidence.assignmentId);
      const decision = next.decisions.find((entry) => entry.decisionId === event.decisionId);
      if (!task || !assignment || !decision) {
        return reject("RUN_EVENT_INVALID", ["cancellation", event.taskId], "unknown-binding");
      }
      if (
        assignment.taskId !== event.taskId ||
        decision.category !== "D1" ||
        decision.subjectId !== event.taskId ||
        decision.dedupeKey !== `cancel:${event.taskId}` ||
        !decision.cancelIntents?.some(
          (pair) =>
            pair.assignmentId === assignment.assignmentId &&
            pair.intentId === event.evidence.cancelIntentId,
        )
      ) {
        return reject("RUN_EVENT_INVALID", ["cancellation", event.taskId], "pair-binding");
      }
      const evidence = normalizeObservation(next, assignment, event.evidence);
      if (evidence === null) {
        assignment.cancellation = null;
        freezeTask(
          next,
          event.taskId,
          "cancel-not-quiescent",
          facts,
          decision.controlNonceDigest,
          decision.cancelIntents ?? [],
        );
        return null;
      }
      assignment.cancellation = evidence;
      releaseIfSettled(next, event.taskId, facts);
      return null;
    }
    case "cancel-requested": {
      if (!validControlNonceDigest(event.controlNonceDigest)) {
        return reject("RUN_EVENT_INVALID", ["cancel", "controlNonceDigest"], "invalid-digest");
      }
      const prepared = addPrepared(next, event.preparedCancelIntents);
      if (prepared)
        return reject("RUN_EVENT_INVALID", ["cancel", "preparedCancelIntents"], prepared);
      const taskId = event.taskIds[0];
      markLocalCancellations(next, taskId, "cancel-requested", facts);
      const coverage = cancelCoverage(next, event.taskIds, event.cancelIntents);
      if (!coverage.ok)
        return reject("RUN_EVENT_INVALID", ["cancel", "cancelIntents"], coverage.reason);
      return applyCancellation(
        next,
        taskId,
        event.reason,
        event.controlNonceDigest,
        event.cancelIntents,
        facts,
      );
    }
    case "run-cancelled": {
      if (!validControlNonceDigest(event.controlNonceDigest)) {
        return reject(
          "RUN_EVENT_INVALID",
          ["run-cancelled", "controlNonceDigest"],
          "invalid-digest",
        );
      }
      if (next.lifecycle === "finished" || next.lifecycle === "cancelled") {
        return invalidTransition("run", next.lifecycle, "cancelled");
      }
      const prepared = addPrepared(next, event.preparedCancelIntents);
      if (prepared)
        return reject("RUN_EVENT_INVALID", ["cancel", "preparedCancelIntents"], prepared);
      const taskIds = next.tasks
        .filter((task) => task.state !== "done" && task.state !== "cancelled")
        .map((task) => task.spec.id);
      for (const taskId of taskIds) markLocalCancellations(next, taskId, "run-cancelled", facts);
      const coverage = cancelCoverage(next, taskIds, event.cancelIntents);
      if (!coverage.ok)
        return reject("RUN_EVENT_INVALID", ["cancel", "cancelIntents"], coverage.reason);
      next.lifecycle = "cancelled";
      for (const taskId of taskIds) {
        const failure = applyCancellation(
          next,
          taskId,
          event.reason,
          event.controlNonceDigest,
          event.cancelIntents,
          facts,
        );
        if (failure) return failure;
      }
      return null;
    }
    case "run-paused":
      if (next.lifecycle !== "active") return invalidTransition("run", next.lifecycle, "paused");
      next.lifecycle = "paused";
      return null;
    case "run-resumed":
      if (next.lifecycle !== "paused") return invalidTransition("run", next.lifecycle, "active");
      next.lifecycle = "active";
      return null;
    case "run-finished": {
      if (next.lifecycle !== "active" && next.lifecycle !== "paused") {
        return invalidTransition("run", next.lifecycle, "finished");
      }
      const unsettled = next.tasks.some(
        (task) => task.state !== "done" && task.state !== "cancelled",
      );
      const openIntent = next.outbox.some(
        (intent) =>
          intent.state === "prepared" ||
          intent.state === "sending" ||
          intent.state === "outcome-unknown" ||
          (intent.state === "failed" && intent.localCancellation === null),
      );
      const pendingDecision = next.decisions.some((decision) => isDecisionPending(decision));
      const outstanding = next.tasks.some(
        (task) => outstandingAssignments(next, task.spec.id).length > 0,
      );
      if (unsettled || openIntent || pendingDecision || outstanding || next.resources.length > 0) {
        return reject("RUN_INVALID_TRANSITION", ["lifecycle"], "run-not-finished", {
          tasks: unsettled ? 1 : 0,
          intents: openIntent ? 1 : 0,
          decisions: pendingDecision ? 1 : 0,
          claims: next.resources.length,
        });
      }
      next.lifecycle = "finished";
      return null;
    }
    case "decision":
      return reject("RUN_EVENT_INVALID", ["decision"], "unsupported-in-batch-b");
    case "observation-recorded": {
      if (!(RUN_EVENT_RECEIPT_KINDS as readonly string[]).includes(event.receipt.kind)) {
        return reject("RUN_EVENT_INVALID", ["observation", "eventKind"], "not-whitelisted");
      }
      if (next.eventReceipts.some((entry) => entry.dedupeKey === event.receipt.dedupeKey))
        return null;
      next.eventReceipts.push({ ...event.receipt, seq: next.counters.observationSeq + 1 });
      next.counters.observationSeq += 1;
      return null;
    }
    default:
      return reject("RUN_EVENT_INVALID", ["event", "kind"], "unsupported-in-batch-b");
  }
}

function normalizeObservation(
  record: RunRecord,
  assignment: RunAssignment,
  observation: CancellationObservation,
): RunCancellationEvidence | null {
  const refresh = observation.refresh;
  if (
    refresh === null ||
    !["idle", "closed", "missing"].includes(refresh.status) ||
    refresh.activeTurn !== false ||
    refresh.agentId !== assignment.agentId ||
    observation.assignmentId !== assignment.assignmentId ||
    observation.lastTurnId === null ||
    observation.lastTurnId !== assignment.turnId ||
    observation.endedEventKey === null ||
    observation.receipt.kind !== "archive" ||
    observation.receipt.confirmedAt === null ||
    observation.receipt.externalId === null
  ) {
    return null;
  }
  const intent = record.outbox.find((entry) => entry.id === observation.cancelIntentId);
  if (
    intent === undefined ||
    intent.kind !== "archive" ||
    intent.taskId !== assignment.taskId ||
    intent.assignmentId !== assignment.assignmentId ||
    intent.recipient !== assignment.agentId ||
    !["sending", "confirmed", "outcome-unknown"].includes(intent.state)
  ) {
    return null;
  }
  const ended = record.eventReceipts.find(
    (receipt) =>
      receipt.eventKey === observation.endedEventKey &&
      receipt.kind === "turn_ended" &&
      receipt.agentId === assignment.agentId &&
      receipt.turnId === assignment.turnId,
  );
  if (!ended || observation.observationSeq < ended.seq) return null;
  if (Date.parse(refresh.observedAt) < Date.parse(ended.receivedAt)) return null;
  const later = record.eventReceipts.some(
    (receipt) =>
      receipt.seq > ended.seq &&
      receipt.kind === "turn_started" &&
      receipt.agentId === assignment.agentId,
  );
  if (later) return null;
  return {
    ...observation,
    refresh: refresh as {
      agentId: string;
      status: "idle" | "closed" | "missing";
      activeTurn: false;
      observedAt: string;
    },
  };
}

function reviewEligibleProof(
  record: RunRecord,
  task: RunTaskRecord,
  assignment: RunAssignment,
  proof: RunAcceptedProof,
): boolean {
  const parsed = RunStoredReviewSchema.safeParse(proof);
  if (!parsed.success) return false;
  return reviewEligible(record, task, assignment, parsed.data);
}

function finalize(record: RunRecord, event: RunReducerEvent, facts: ReduceFacts): ReduceResult {
  const existing = validateExisting(record);
  if (existing) return existing;
  if (
    event.kind === "cancel-requested" &&
    (!Array.isArray(event.taskIds) ||
      event.taskIds.length !== 1 ||
      typeof event.taskIds[0] !== "string")
  ) {
    return reject("RUN_EVENT_INVALID", ["cancel", "taskIds"], "single-task-required");
  }
  if (event.kind === "observation-recorded") {
    const incoming = RunEventReceiptSchema.safeParse(event.receipt);
    if (!incoming.success)
      return reject("RUN_EVENT_INVALID", ["observation"], "invalid-observation");
    const prior = record.eventReceipts.find((entry) => entry.dedupeKey === incoming.data.dedupeKey);
    if (prior) {
      const fields = [
        "eventKey",
        "kind",
        "agentId",
        "turnId",
        "receivedAt",
        "dedupeKey",
        "disposition",
      ] as const;
      if (!fields.every((key) => sameStoredValue(prior[key], incoming.data[key]))) {
        return reject("RUN_EVENT_INVALID", ["observation", "dedupeKey"], "observation-replay");
      }
      return { ok: true, next: structuredClone(record), effects: [] };
    }
  }
  if (sameAcceptedProof(record, event)) {
    return { ok: true, next: structuredClone(record), effects: [] };
  }
  const proofAssignmentId = eventAssignmentId(event);
  if (
    proofAssignmentId !== null &&
    assignmentOf(record, proofAssignmentId)?.acceptedProof != null
  ) {
    return reject("RUN_EVENT_INVALID", ["assignments", proofAssignmentId, "nonce"], "nonce-replay");
  }
  const next = structuredClone(record);
  const applied = applyEvent(next, event, facts);
  if (applied) return applied;
  for (const task of next.tasks) advanceRework(next, task);
  recomputeReady(next);
  next.updatedAt = facts.now;
  appendEvent(next, event, facts);
  const parsed = RunRecordSchema.safeParse(next);
  if (!parsed.success) return reject("RUN_EVENT_INVALID", ["record"], "record-schema");
  const invariants = checkLedgerInvariants(parsed.data);
  if (!invariants.ok) {
    return {
      ok: false,
      code: "RUN_INVARIANT_VIOLATION",
      path: invariants.violations[0]?.path ?? [],
      params: invariants.violations[0]?.params ?? {},
      violations: invariants.violations,
    };
  }
  return { ok: true, next: parsed.data, effects: [] };
}

function validateExisting(record: RunRecord): ReduceRejection | null {
  const parsed = RunRecordSchema.safeParse(record);
  if (!parsed.success) return reject("RUN_EVENT_INVALID", ["record"], "record-schema");
  const invariants = checkLedgerInvariants(parsed.data);
  if (invariants.ok) return null;
  return {
    ok: false,
    code: "RUN_INVARIANT_VIOLATION",
    path: invariants.violations[0]?.path ?? [],
    params: invariants.violations[0]?.params ?? {},
    violations: invariants.violations,
  };
}

export function reduceRun(
  record: RunRecord,
  event: RunReducerEvent,
  facts: ReduceFacts,
): ReduceResult {
  return finalize(record, event, facts);
}

function recomputeReady(next: RunRecord): void {
  const tasks = new Map(next.tasks.map((task) => [task.spec.id, task]));
  for (const task of next.tasks) {
    if (task.state !== "pending") continue;
    const deps = task.spec.deps.map((dep) => tasks.get(dep));
    if (deps.every((dep) => dep?.state === "done")) {
      task.state = "ready";
      task.waitingReason = null;
    }
  }
}

import {
  RUN_EVENT_RECEIPT_KINDS,
  type RunRecord,
  RunRecordSchema,
  type RunTaskRecord,
  type RunTaskSpec,
} from "../../schemas/run-engine/ledger";
import type { RunReviewReportBlock } from "../../schemas/run-engine/protocol";
import {
  checkEvidenceGate,
  checkReviewGate,
  checkSmokeGate,
  normalizeContainedPath,
  reviewEligible,
} from "./gates";
import {
  checkLedgerInvariants,
  occupiesExecutionSlot,
  type RunInvariantViolation,
} from "./invariants";
import { nextQualityFailure } from "./scheduler";
import { executionTier, reviewRequirement } from "./tier";
import {
  dispatchIntentMatches,
  RUN_COUNTER_EVENTS,
  type RunReducerEvent,
  type RunStoredReview,
  type RunTaskWithEvidence,
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
  violations?: readonly RunInvariantViolation[];
};

export type ReduceResult =
  | { ok: true; next: RunRecord; effects: readonly RunEffect[] }
  | ReduceRejection;

export type ReduceFacts = {
  now: string;
  newId: (kind: string) => string;
  /** R05 supplies a precomputed digest for each newly opened quality decision; never hash here. */
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

function taskOf(record: RunRecord, taskId: string): RunTaskWithEvidence | undefined {
  return taskById(record, taskId);
}

function assignmentOf(record: RunRecord, assignmentId: string) {
  return record.assignments.find((entry) => entry.assignmentId === assignmentId);
}

function decisionOf(record: RunRecord, decisionId: string) {
  return record.decisions.find((entry) => entry.decisionId === decisionId);
}

function reportNonce(
  record: RunRecord,
  block: { nonce: string; taskId: string; attempt: number; assignmentId: string },
  assignment: { agentId: string; seatId: string },
  phase: "implementation" | "review" | "smoke",
) {
  const entry = record.nonceRegistry.find(
    (candidate) =>
      candidate.nonce === block.nonce &&
      candidate.runId === record.runId &&
      candidate.taskId === block.taskId &&
      candidate.assignmentId === block.assignmentId &&
      candidate.attempt === block.attempt &&
      candidate.phase === phase &&
      candidate.agentId === assignment.agentId &&
      candidate.seatId === assignment.seatId,
  );
  if (entry === undefined || entry.revokedAt !== null) return null;
  return entry;
}

function validControlNonceDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function appendEvent(next: RunRecord, event: RunReducerEvent, facts: ReduceFacts): void {
  const seq = next.counters.eventsThroughSeq + 1;
  next.counters.eventsThroughSeq = seq;
  next.events.push({
    seq,
    kind: event.kind,
    at: facts.now,
    payload: { ...event },
  });
  next.updatedAt = facts.now;
}

function appendCounterEvent(
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
}

function releaseClaims(next: RunRecord, taskId: string): void {
  next.resources = next.resources.filter((claim) => claim.taskId !== taskId);
  const task = taskOf(next, taskId);
  if (task) task.frozenClaimId = null;
}

function markCancelled(next: RunRecord, taskId: string, reason: string, facts: ReduceFacts): void {
  const task = taskOf(next, taskId);
  if (!task) return;
  for (const decision of next.decisions) {
    if (decision.dedupeKey !== `cancel:${taskId}` || decision.state !== "open") continue;
    decision.state = "answered";
    decision.answeredAt = facts.now;
  }
  const assignment = task.currentAssignmentId
    ? assignmentOf(next, task.currentAssignmentId)
    : undefined;
  if (assignment) {
    assignment.state = "cancelled";
    assignment.endedAt = facts.now;
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
  cancelIntentId?: string,
): void {
  const task = taskOf(next, taskId);
  if (!task) return;
  if (task.state === "done" || task.state === "cancelled") return;
  task.state = "blocked";
  task.phase = "frozen";
  task.waitingReason = reason;
  for (const claim of next.resources) {
    if (claim.taskId === taskId) {
      claim.frozen = true;
      task.frozenClaimId ??= claim.claimId;
    }
  }
  for (const nonce of next.nonceRegistry) {
    if (nonce.taskId !== taskId || nonce.revokedAt !== null) continue;
    nonce.revokedAt = facts.now;
    nonce.revokeReason = reason.slice(0, 200);
  }
  const dedupeKey = `cancel:${taskId}`;
  if (!next.decisions.some((entry) => entry.dedupeKey === dedupeKey)) {
    next.decisions.push({
      decisionId: facts.newId("decision"),
      category: "D1",
      controlNonceDigest,
      state: "open",
      dedupeKey,
      subjectId: taskId,
      summary: `Cancellation of ${taskId} needs explicit quiescence confirmation.`,
      createdAt: facts.now,
      answeredAt: null,
      ...(cancelIntentId === undefined ? {} : { cancelIntentId }),
    });
  }
}

function quiescent(record: RunRecord, taskId: string): boolean {
  const task = taskOf(record, taskId);
  const assignment = task?.currentAssignmentId
    ? assignmentOf(record, task.currentAssignmentId)
    : undefined;
  const evidence = assignment?.cancellation;
  if (!assignment || !evidence) return false;
  if (evidence.assignmentId !== assignment.assignmentId) return false;
  if (evidence.receipt.kind === "none" || evidence.receipt.confirmedAt === null) return false;
  if (evidence.observationSeq === 0 || evidence.observationSeq > record.counters.observationSeq) {
    return false;
  }
  const cancelIntent = record.outbox.find((intent) => intent.id === evidence.cancelIntentId);
  if (
    cancelIntent === undefined ||
    (cancelIntent.kind !== "wake" && cancelIntent.kind !== "archive") ||
    cancelIntent.taskId !== taskId ||
    cancelIntent.assignmentId !== assignment.assignmentId ||
    cancelIntent.recipient !== assignment.agentId ||
    (cancelIntent.state !== "sending" &&
      cancelIntent.state !== "confirmed" &&
      cancelIntent.state !== "outcome-unknown")
  ) {
    return false;
  }
  const startedOrEnded =
    assignment.turnId !== null || evidence.lastTurnId !== null || evidence.endedEventKey !== null;
  if (!startedOrEnded) {
    // A never-started assignment has no turn to end. Require a fresh observation and no
    // started-turn receipt for this agent after the assignment was created.
    if (Date.parse(evidence.refreshObservedAt) < Date.parse(assignment.createdAt)) return false;
    const started = record.eventReceipts.some(
      (receipt) =>
        receipt.kind === "turn_started" &&
        receipt.agentId === assignment.agentId &&
        Date.parse(receipt.receivedAt) >= Date.parse(assignment.createdAt),
    );
    return !started;
  }
  if (assignment.turnId === null || evidence.lastTurnId !== assignment.turnId) return false;
  if (evidence.endedEventKey === null) return false;
  const endedIndex = record.eventReceipts.findIndex(
    (receipt) =>
      receipt.eventKey === evidence.endedEventKey &&
      receipt.kind === "turn_ended" &&
      receipt.agentId === assignment.agentId &&
      receipt.turnId === assignment.turnId,
  );
  const ended = endedIndex < 0 ? undefined : record.eventReceipts[endedIndex];
  if (ended === undefined || evidence.observationSeq < ended.seq) return false;
  const endedAt = ended.receivedAt;
  if (Date.parse(evidence.refreshObservedAt) < Date.parse(endedAt)) return false;
  const laterStarted = record.eventReceipts.some(
    (receipt, index) =>
      index > endedIndex &&
      receipt.kind === "turn_started" &&
      receipt.agentId === assignment.agentId,
  );
  return !laterStarted;
}

function recomputeReady(next: RunRecord): void {
  const tasks = new Map(next.tasks.map((task) => [task.spec.id, task]));
  for (const task of next.tasks) {
    if (task.state !== "pending") continue;
    const deps = task.spec.deps.map((dep) => tasks.get(dep));
    if (deps.every((dep) => dep?.state === "done")) {
      task.state = "ready";
      task.waitingReason = null;
    } else {
      const blocked = task.spec.deps.find((dep) => {
        const state = tasks.get(dep)?.state;
        return state === "failed" || state === "blocked" || state === "cancelled";
      });
      if (blocked) task.waitingReason = `dependency-blocked:${blocked}`;
    }
  }
}

function appendReview(
  task: RunTaskWithEvidence,
  block: RunReviewReportBlock,
  record: RunRecord,
): RunStoredReview {
  const assignment = assignmentOf(record, block.assignmentId);
  const review: RunStoredReview = {
    assignmentId: block.assignmentId,
    phase: task.phase === "smoke" ? "smoke" : "review",
    reviewerAgentId: assignment?.agentId ?? "",
    reviewerSeatId: assignment?.seatId ?? "",
    verdict: block.verdict,
    reviewedRef: block.reviewedRef,
    blockers: block.blockers,
    probes: block.probes,
  };
  task.reviews = [...(task.reviews ?? []), review];
  return review;
}

function completeTask(next: RunRecord, task: RunTaskWithEvidence): void {
  task.state = "done";
  task.phase = undefined;
  task.waitingReason = null;
  task.currentAssignmentId = null;
  releaseClaims(next, task.spec.id);
}

function afterGateFailure(
  next: RunRecord,
  task: RunTaskWithEvidence,
  reason: string,
  facts: ReduceFacts,
): ReduceRejection | null {
  task.qualityFailures += 1;
  appendCounterEvent(next, task, "qualityFailures", facts);
  task.waitingReason = reason;
  const tier = executionTier(task);
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
    for (const nonce of next.nonceRegistry) {
      if (nonce.taskId !== task.spec.id || nonce.revokedAt !== null) continue;
      nonce.revokedAt = facts.now;
      nonce.revokeReason = plan.reason;
    }
    next.decisions.push({
      decisionId: facts.newId("decision"),
      category: plan.decision,
      controlNonceDigest: digest,
      state: "open",
      dedupeKey: `quality:${task.spec.id}:${task.qualityFailures}:${plan.decision}`,
      subjectId: task.spec.id,
      summary: `${plan.decision}: ${plan.reason}`,
      createdAt: facts.now,
      answeredAt: null,
    });
    return null;
  }
  if (plan.kind === "escalate") {
    task.escalations.push({
      fromTier: tier,
      toTier: plan.nextTier,
      atAttempt: task.attempts,
      qualityFailures: task.qualityFailures,
      at: facts.now,
    });
  }
  const active = next.tasks.filter((entry) => occupiesExecutionSlot(next, entry)).length;
  if (active < next.policy.configuredConcurrency) {
    task.state = "rework";
    task.reworkCount += 1;
    appendCounterEvent(next, task, "reworkCount", facts);
    task.phase = undefined;
  } else {
    task.state = "review";
    task.phase = "awaiting-rework";
  }
  return null;
}

function newTask(spec: RunTaskSpec, facts: ReduceFacts): RunTaskRecord {
  void facts;
  return {
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
  };
}

function applyEvent(
  next: RunRecord,
  event: RunReducerEvent,
  facts: ReduceFacts,
): ReduceResult | null {
  switch (event.kind) {
    case "dag-accepted": {
      if (event.block.runId !== next.runId) {
        return reject("RUN_EVENT_INVALID", ["dag", "runId"], "run-mismatch");
      }
      if (next.lifecycle !== "bootstrapping" && next.lifecycle !== "awaiting-dag") {
        return reject("RUN_INVALID_TRANSITION", ["lifecycle"], "dag-accepted", {
          lifecycle: next.lifecycle,
        });
      }
      if (
        event.block.dagRevision !== 1 ||
        event.block.expectedDagRevision !== 0 ||
        event.block.budgetRequests.length > 0
      ) {
        return reject("RUN_EVENT_INVALID", ["dag"], "initial-revision");
      }
      const ids = new Set<string>();
      for (const spec of event.block.tasks) {
        if (ids.has(spec.id))
          return reject("RUN_EVENT_INVALID", ["dag", "tasks"], "duplicate-task");
        ids.add(spec.id);
      }
      next.tasks = event.block.tasks.map((spec) => newTask(spec, facts));
      for (const taskId of event.block.cancelTaskIds) {
        const task = taskOf(next, taskId);
        if (!task) {
          return reject("RUN_EVENT_INVALID", ["dag", "cancelTaskIds"], "unknown-task");
        }
        markCancelled(next, taskId, "dag-accepted", facts);
      }
      next.dagRevision = event.block.dagRevision;
      next.lifecycle = "active";
      recomputeReady(next);
      return null;
    }
    case "dag-revised": {
      if (!validControlNonceDigest(event.controlNonceDigest)) {
        return reject("RUN_EVENT_INVALID", ["dag", "controlNonceDigest"], "invalid-digest");
      }
      if (event.block.runId !== next.runId) {
        return reject("RUN_EVENT_INVALID", ["dag", "runId"], "run-mismatch");
      }
      if (next.lifecycle !== "active" && next.lifecycle !== "awaiting-dag") {
        return reject("RUN_INVALID_TRANSITION", ["lifecycle"], "dag-revised", {
          lifecycle: next.lifecycle,
        });
      }
      if (
        event.block.expectedDagRevision !== next.dagRevision ||
        event.block.dagRevision !== next.dagRevision + 1 ||
        event.block.budgetRequests.length > 0
      ) {
        return reject("RUN_EVENT_INVALID", ["dag", "expectedDagRevision"], "stale-dag");
      }
      const incoming = new Map(event.block.tasks.map((spec) => [spec.id, spec]));
      const nextTasks: RunRecord["tasks"] = [];
      for (const task of next.tasks) {
        const spec = incoming.get(task.spec.id);
        if (spec) {
          if (task.state === "done" || task.state === "cancelled") {
            if (JSON.stringify(spec) !== JSON.stringify(task.spec)) {
              return reject(
                "RUN_INVALID_TRANSITION",
                ["tasks", task.spec.id],
                "terminal-task-changed",
              );
            }
            nextTasks.push(task);
          } else if (
            ["assigned", "in_progress", "review", "rework", "blocked", "failed"].includes(
              task.state,
            )
          ) {
            if (JSON.stringify(spec) !== JSON.stringify(task.spec)) {
              return reject(
                "RUN_INVALID_TRANSITION",
                ["tasks", task.spec.id],
                "active-task-changed",
              );
            }
            nextTasks.push(task);
          } else {
            nextTasks.push({ ...task, spec });
          }
          incoming.delete(task.spec.id);
        } else if (
          task.state === "done" ||
          task.state === "cancelled" ||
          event.block.cancelTaskIds.includes(task.spec.id)
        ) {
          nextTasks.push(task);
        } else {
          return reject("RUN_INVALID_TRANSITION", ["tasks", task.spec.id], "active-task-removed");
        }
      }
      for (const spec of incoming.values()) nextTasks.push(newTask(spec, facts));
      next.tasks = nextTasks;
      next.dagRevision = event.block.dagRevision;
      next.lifecycle = "active";
      for (const taskId of event.block.cancelTaskIds) {
        const task = taskOf(next, taskId);
        if (!task) {
          return reject("RUN_EVENT_INVALID", ["dag", "cancelTaskIds"], "unknown-task");
        }
        const active =
          task.currentAssignmentId !== null ||
          next.resources.some((claim) => claim.taskId === taskId);
        if (!active) markCancelled(next, taskId, "dag-revised", facts);
        else if (quiescent(next, taskId)) markCancelled(next, taskId, "dag-revised", facts);
        else freezeTask(next, taskId, "dag-revised", facts, event.controlNonceDigest);
      }
      recomputeReady(next);
      return null;
    }
    case "task-dispatched": {
      if (next.lifecycle !== "active") {
        return reject("RUN_INVALID_TRANSITION", ["lifecycle"], "task-dispatched", {
          lifecycle: next.lifecycle,
        });
      }
      const task = taskOf(next, event.taskId);
      if (!task) return invalidTransition(event.taskId, "missing", "assigned");
      const purpose = event.assignment.purpose;
      const reviewDispatch =
        purpose === "reviewer" && task.state === "review" && task.phase === "review";
      const smokeDispatch =
        purpose === "smoker" && task.state === "review" && task.phase === "smoke";
      const awaitingRework =
        task.state === "review" &&
        task.phase === "awaiting-rework" &&
        (purpose === "member" || purpose === "coordinator" || purpose === "reopen");
      const workerDispatch =
        (task.state === "ready" || task.state === "rework" || awaitingRework) &&
        (purpose === "member" || purpose === "coordinator" || purpose === "reopen");
      if (!reviewDispatch && !smokeDispatch && !workerDispatch) {
        return invalidTransition(event.taskId, task.state, "assigned");
      }
      const activeOthers = next.tasks.filter(
        (entry) => entry.spec.id !== event.taskId && occupiesExecutionSlot(next, entry),
      ).length;
      if (workerDispatch && activeOthers >= next.policy.configuredConcurrency) {
        return reject("RUN_INVALID_TRANSITION", ["tasks", event.taskId, "state"], "capacity");
      }
      if (
        !dispatchIntentMatches(event.assignment, event.intent) ||
        next.assignments.some((entry) => entry.assignmentId === event.assignment.assignmentId) ||
        next.nonceRegistry.some((entry) => entry.nonce === event.nonce.nonce) ||
        next.outbox.some((entry) => entry.id === event.intent.id) ||
        event.assignment.taskId !== event.taskId ||
        event.assignment.assignmentId !== event.intent.assignmentId ||
        event.assignment.nonce !== event.nonce.nonce ||
        event.assignment.attempt !== event.nonce.attempt ||
        event.nonce.assignmentId !== event.assignment.assignmentId ||
        event.nonce.taskId !== event.taskId ||
        event.intent.taskId !== event.taskId
      ) {
        return reject("RUN_EVENT_INVALID", ["assignment", "taskId"], "assignment-mismatch");
      }
      if (
        event.assignment.state !== "assigned" ||
        event.assignment.startedAt !== null ||
        event.assignment.endedAt !== null ||
        event.assignment.turnId !== null ||
        (event.assignment.cancellation !== undefined && event.assignment.cancellation !== null) ||
        event.nonce.acceptedAt !== null ||
        event.nonce.acceptedEventKey !== null ||
        event.nonce.revokedAt !== null
      ) {
        return reject("RUN_EVENT_INVALID", ["assignment", "state"], "untrusted-assignment");
      }
      const requiredTier =
        reviewDispatch || smokeDispatch ? reviewRequirement(task).tier : executionTier(task);
      if (event.assignment.tier !== requiredTier) {
        return reject("RUN_EVENT_INVALID", ["assignment", "tier"], "tier-mismatch");
      }
      if (!reviewDispatch && !smokeDispatch && event.assignment.attempt !== task.attempts + 1) {
        return reject("RUN_EVENT_INVALID", ["assignment", "attempt"], "attempt-mismatch");
      }
      const requestedClaims = reviewDispatch || smokeDispatch ? [] : (event.claims ?? []);
      const existingClaims = next.resources.filter((entry) => entry.taskId === event.taskId);
      const reuseExisting =
        (task.state === "rework" ||
          (task.state === "review" && task.phase === "awaiting-rework")) &&
        requestedClaims.length === 0;
      const claims = reuseExisting ? existingClaims : requestedClaims;
      const hasWorkerWrites =
        workerDispatch && task.spec.scopes.some((scope) => scope.access === "write");
      if (hasWorkerWrites && claims.length === 0 && !reuseExisting) {
        return reject("RUN_EVENT_INVALID", ["claims"], "claim-required");
      }
      const claimIds = new Set(
        next.resources
          .filter((entry) => reuseExisting || entry.taskId !== event.taskId)
          .map((claim) => claim.claimId),
      );
      const writeScopes = task.spec.scopes.filter((scope) => scope.access === "write");
      for (const claim of reuseExisting ? [] : claims) {
        if (claim.taskId !== event.taskId || claim.frozen || claimIds.has(claim.claimId)) {
          return reject("RUN_EVENT_INVALID", ["claims"], "claim-not-in-scope");
        }
        if (claim.kind === "hot" || claim.kind === "tool") {
          if (claim.path.length === 0) {
            return reject("RUN_EVENT_INVALID", ["claims"], "claim-not-in-scope");
          }
          claimIds.add(claim.claimId);
          continue;
        }
        const claimPath = normalizeContainedPath(claim.path);
        const matches = task.spec.scopes.some(
          (scope) =>
            scope.repoId === claim.repoId &&
            scope.access === claim.access &&
            (scope.kind === "file"
              ? claim.kind === "file" && normalizeContainedPath(scope.path) === claimPath
              : (claim.kind === "file" || claim.kind === "directory") &&
                (claimPath === normalizeContainedPath(scope.path) ||
                  (normalizeContainedPath(scope.path) !== null &&
                    claimPath?.startsWith(`${normalizeContainedPath(scope.path)}/`)))),
        );
        if (!matches) {
          return reject("RUN_EVENT_INVALID", ["claims"], "claim-not-in-scope");
        }
        claimIds.add(claim.claimId);
      }
      if (workerDispatch && task.spec.execution === "write") {
        for (const scope of writeScopes) {
          const covered = claims.some(
            (claim) =>
              claim.repoId === scope.repoId &&
              claim.access === scope.access &&
              (claim.kind === "hot" || claim.kind === "tool"
                ? false
                : scope.kind === "file"
                  ? claim.kind === "file" &&
                    normalizeContainedPath(claim.path) === normalizeContainedPath(scope.path)
                  : (claim.kind === "file" || claim.kind === "directory") &&
                    (normalizeContainedPath(claim.path) === normalizeContainedPath(scope.path) ||
                      (normalizeContainedPath(scope.path) !== null &&
                        normalizeContainedPath(claim.path)?.startsWith(
                          `${normalizeContainedPath(scope.path)}/`,
                        )))),
          );
          if (!covered) {
            return reject("RUN_EVENT_INVALID", ["claims"], "claim-coverage");
          }
        }
      }
      if (!reuseExisting) {
        next.resources = next.resources.filter((entry) => entry.taskId !== event.taskId);
      }
      next.assignments.push(event.assignment);
      next.nonceRegistry.push(event.nonce);
      next.outbox.push(event.intent);
      if (!reuseExisting) next.resources.push(...claims);
      if (reviewDispatch || smokeDispatch) {
        task.waitingReason = null;
        task.currentAssignmentId = event.assignment.assignmentId;
      } else {
        if (awaitingRework) {
          task.reworkCount += 1;
          appendCounterEvent(next, task, "reworkCount", facts);
        }
        task.attempts = event.assignment.attempt;
        task.state = "assigned";
        task.phase = "implementation";
        task.waitingReason = null;
        task.currentAssignmentId = event.assignment.assignmentId;
        task.frozenClaimId = null;
      }
      return null;
    }
    case "turn-started": {
      const assignment = assignmentOf(next, event.assignmentId);
      const task = assignment ? taskOf(next, assignment.taskId) : undefined;
      if (
        !assignment ||
        !task ||
        task.currentAssignmentId !== assignment.assignmentId ||
        assignment.state === "cancelled"
      ) {
        return reject(
          "RUN_EVENT_INVALID",
          ["assignments", event.assignmentId],
          "unknown-assignment",
        );
      }
      const reviewTurn =
        task.state === "review" &&
        (assignment.purpose === "reviewer" || assignment.purpose === "smoker");
      if (task.state !== "assigned" && !reviewTurn) {
        return invalidTransition(task.spec.id, task.state, "in_progress");
      }
      if (event.agentId !== assignment.agentId) {
        return reject("RUN_EVENT_INVALID", ["turn-started", event.assignmentId], "agent-mismatch");
      }
      if (!reviewTurn) {
        task.state = "in_progress";
        task.phase = "implementation";
      }
      assignment.state = "in_progress";
      assignment.startedAt = facts.now;
      assignment.turnId = event.turnId;
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
      assignment.state = "ended";
      assignment.endedAt = facts.now;
      return null;
    }
    case "task-report": {
      const block = event.block;
      const task = taskOf(next, block.taskId);
      const assignment = assignmentOf(next, block.assignmentId);
      if (!task || task.currentAssignmentId !== block.assignmentId || !assignment) {
        return reject("RUN_EVENT_INVALID", ["task-report", block.taskId], "unknown-assignment");
      }
      if (
        block.runId !== next.runId ||
        block.attempt !== assignment.attempt ||
        block.nonce !== assignment.nonce ||
        (assignment.purpose !== "member" &&
          assignment.purpose !== "coordinator" &&
          assignment.purpose !== "reopen")
      ) {
        return reject("RUN_EVENT_INVALID", ["task-report", block.taskId], "identity-mismatch");
      }
      const nonce = next.nonceRegistry.find(
        (entry) =>
          entry.nonce === block.nonce &&
          entry.runId === next.runId &&
          entry.taskId === block.taskId &&
          entry.assignmentId === block.assignmentId &&
          entry.attempt === block.attempt &&
          entry.phase === "implementation" &&
          entry.agentId === assignment.agentId &&
          entry.seatId === assignment.seatId,
      );
      if (nonce === undefined || nonce.revokedAt !== null) {
        return reject("RUN_EVENT_INVALID", ["task-report", "nonce"], "nonce-invalid");
      }
      if (task.state !== "in_progress" && task.state !== "assigned") {
        return invalidTransition(block.taskId, task.state, "review");
      }
      nonce.acceptedAt ??= facts.now;
      nonce.acceptedEventKey ??= `${block.taskId}|${block.attempt}|${block.nonce}`;
      task.report = block;
      if (block.status === "done") {
        task.changedFiles = [...block.changedFiles];
        task.ref = block.ref;
      }
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
      const gate = checkEvidenceGate(next, task);
      if (!gate.ok) {
        task.evidenceReturns += 1;
        appendCounterEvent(next, task, "evidenceReturns", facts);
        task.waitingReason = String(gate.issues[0]?.params.reason ?? "evidence");
        return null;
      }
      task.state = "review";
      task.phase = "review";
      task.waitingReason = null;
      return null;
    }
    case "review-report": {
      const block = event.block;
      const task = taskOf(next, block.taskId);
      if (task?.state !== "review" || (task.phase !== "review" && task.phase !== "smoke")) {
        return invalidTransition(block.taskId, task?.state ?? "missing", "review");
      }
      const assignment = assignmentOf(next, block.assignmentId);
      if (
        !assignment ||
        assignment.taskId !== block.taskId ||
        assignment.purpose !== "reviewer" ||
        block.runId !== next.runId ||
        block.attempt !== assignment.attempt ||
        block.nonce !== assignment.nonce
      ) {
        return reject("RUN_EVENT_INVALID", ["review-report", block.taskId], "identity-mismatch");
      }
      const reviewNonce = reportNonce(next, block, assignment, "review");
      if (reviewNonce === null) {
        return reject("RUN_EVENT_INVALID", ["review-report", "nonce"], "nonce-invalid");
      }
      const evidence = checkEvidenceGate(next, task);
      if (!evidence.ok) {
        return reject(
          "RUN_EVENT_INVALID",
          ["tasks", task.spec.id, "report"],
          String(evidence.issues[0]?.params.reason ?? "evidence"),
        );
      }
      reviewNonce.acceptedAt ??= facts.now;
      reviewNonce.acceptedEventKey ??= `${block.taskId}|${block.attempt}|${block.nonce}`;
      const storedReview = appendReview(task, block, next);
      if (!reviewEligible(next, task, storedReview)) {
        return reject("RUN_EVENT_INVALID", ["review-report", block.taskId], "no-valid-review");
      }
      const gate = checkReviewGate(next, task);
      if (!gate.ok) {
        if (block.verdict === "可合入") {
          return reject(
            "RUN_EVENT_INVALID",
            ["tasks", task.spec.id, "reviews"],
            String(gate.issues[0]?.params.reason ?? "review"),
          );
        }
        if (task.phase === "smoke") {
          task.waitingReason = String(gate.issues[0]?.params.reason ?? "blocked-review");
          return null;
        }
        return afterGateFailure(
          next,
          task,
          String(gate.issues[0]?.params.reason ?? "review"),
          facts,
        );
      }
      if (task.spec.devSmoke) {
        task.phase = "smoke";
        return null;
      }
      completeTask(next, task);
      recomputeReady(next);
      return null;
    }
    case "smoke-report": {
      const block = event.block;
      const task = taskOf(next, block.taskId);
      if (task?.state !== "review" || task.phase !== "smoke") {
        return invalidTransition(block.taskId, task?.state ?? "missing", "done");
      }
      const assignment = assignmentOf(next, block.assignmentId);
      if (
        !assignment ||
        assignment.taskId !== block.taskId ||
        assignment.purpose !== "smoker" ||
        block.runId !== next.runId ||
        block.attempt !== assignment.attempt ||
        block.nonce !== assignment.nonce
      ) {
        return reject("RUN_EVENT_INVALID", ["smoke-report", block.taskId], "identity-mismatch");
      }
      const smokeNonce = reportNonce(next, block, assignment, "smoke");
      if (smokeNonce === null) {
        return reject("RUN_EVENT_INVALID", ["smoke-report", "nonce"], "nonce-invalid");
      }
      const evidence = checkEvidenceGate(next, task);
      if (!evidence.ok) {
        return reject(
          "RUN_EVENT_INVALID",
          ["tasks", task.spec.id, "report"],
          String(evidence.issues[0]?.params.reason ?? "evidence"),
        );
      }
      smokeNonce.acceptedAt ??= facts.now;
      smokeNonce.acceptedEventKey ??= `${block.taskId}|${block.attempt}|${block.nonce}`;
      task.smokeReport = block;
      const review = checkReviewGate(next, task);
      const smoke = checkSmokeGate(next, task);
      const failed = !review.ok ? review : !smoke.ok ? smoke : null;
      if (failed) {
        return afterGateFailure(
          next,
          task,
          String(failed.issues[0]?.params.reason ?? "smoke"),
          facts,
        );
      }
      completeTask(next, task);
      recomputeReady(next);
      return null;
    }
    case "decision":
      // R01c now stores controlNonceDigest, but B batch does not wire decision responses yet;
      // C batch must validate against the recorded decision/nonce and consume it exactly once.
      return reject("RUN_EVENT_INVALID", ["decision"], "unsupported-in-batch-b");
    case "cancel-requested": {
      if (!validControlNonceDigest(event.controlNonceDigest)) {
        return reject("RUN_EVENT_INVALID", ["cancel", "controlNonceDigest"], "invalid-digest");
      }
      if (event.taskIds.length !== 1) {
        return reject("RUN_EVENT_INVALID", ["cancel", "taskIds"], "multi-task-cancel");
      }
      const cancelIntent = next.outbox.find((intent) => intent.id === event.cancelIntentId);
      if (
        cancelIntent === undefined ||
        (cancelIntent.kind !== "wake" && cancelIntent.kind !== "archive") ||
        !event.taskIds.includes(cancelIntent.taskId)
      ) {
        return reject("RUN_EVENT_INVALID", ["cancel", "cancelIntentId"], "cancel-intent");
      }
      for (const taskId of event.taskIds) {
        if (!taskOf(next, taskId)) {
          return reject("RUN_EVENT_INVALID", ["cancel", "taskIds"], "unknown-task");
        }
      }
      for (const taskId of event.taskIds) {
        const task = taskOf(next, taskId);
        if (!task || task.state === "done" || task.state === "cancelled") continue;
        const active =
          Boolean(task.currentAssignmentId) ||
          next.resources.some((claim) => claim.taskId === taskId);
        if (active) {
          freezeTask(
            next,
            taskId,
            event.reason,
            facts,
            event.controlNonceDigest,
            event.cancelIntentId,
          );
        } else {
          markCancelled(next, taskId, event.reason, facts);
        }
      }
      return null;
    }
    case "cancellation-checked": {
      const task = taskOf(next, event.taskId);
      const decision = decisionOf(next, event.decisionId);
      if (!task || !decision) {
        return reject("RUN_EVENT_INVALID", ["cancellation", event.taskId], "unknown-decision");
      }
      if (decision.state === "answered" || decision.answeredAt !== null) {
        return reject(
          "RUN_EVENT_INVALID",
          ["decision", event.decisionId],
          "decision-already-consumed",
        );
      }
      if (decision.state !== "open") {
        return reject("RUN_EVENT_INVALID", ["decision", event.decisionId], "decision-not-open");
      }
      if (
        decision.category !== "D1" ||
        decision.subjectId !== event.taskId ||
        decision.dedupeKey !== `cancel:${event.taskId}`
      ) {
        return reject("RUN_EVENT_INVALID", ["decision", event.decisionId], "decision-binding");
      }
      if (
        typeof decision.cancelIntentId === "string" &&
        decision.cancelIntentId !== event.evidence.cancelIntentId
      ) {
        return reject("RUN_EVENT_INVALID", ["decision", event.decisionId], "cancel-intent-binding");
      }
      if (
        task.state !== "blocked" &&
        task.state !== "in_progress" &&
        task.state !== "assigned" &&
        task.state !== "review" &&
        task.state !== "rework"
      ) {
        return reject("RUN_INVALID_TRANSITION", ["tasks", event.taskId, "state"], "cancellation", {
          state: task.state,
        });
      }
      const assignment = task.currentAssignmentId
        ? assignmentOf(next, task.currentAssignmentId)
        : undefined;
      if (assignment) assignment.cancellation = event.evidence;
      if (!quiescent(next, event.taskId)) {
        freezeTask(next, event.taskId, "cancel-not-quiescent", facts, decision.controlNonceDigest);
        return null;
      }
      decision.state = "answered";
      decision.answeredAt = facts.now;
      const cancelledTask = taskOf(next, event.taskId);
      if (cancelledTask) cancelledTask.releaseDecisionId = decision.decisionId;
      markCancelled(next, event.taskId, decision.summary, facts);
      return null;
    }
    case "run-paused": {
      if (next.lifecycle !== "active")
        return reject("RUN_INVALID_TRANSITION", ["lifecycle"], "pause");
      next.lifecycle = "paused";
      return null;
    }
    case "run-resumed": {
      if (next.lifecycle !== "paused")
        return reject("RUN_INVALID_TRANSITION", ["lifecycle"], "resume");
      next.lifecycle = "active";
      return null;
    }
    case "run-finished": {
      if (next.lifecycle !== "active" && next.lifecycle !== "paused") {
        return reject("RUN_INVALID_TRANSITION", ["lifecycle"], "run-finished", {
          lifecycle: next.lifecycle,
        });
      }
      const unsettled = next.tasks.some(
        (task) => task.state !== "done" && task.state !== "cancelled",
      );
      const openIntent = next.outbox.some(
        (intent) =>
          intent.state === "prepared" ||
          intent.state === "sending" ||
          intent.state === "outcome-unknown",
      );
      const openDecision = next.decisions.some((decision) => decision.state !== "answered");
      if (unsettled || openIntent || openDecision || next.resources.length > 0) {
        return reject("RUN_INVALID_TRANSITION", ["lifecycle"], "run-not-finished", {
          tasks: unsettled ? 1 : 0,
          intents: openIntent ? 1 : 0,
          decisions: openDecision ? 1 : 0,
          claims: next.resources.length,
        });
      }
      next.lifecycle = "finished";
      return null;
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
        return reject("RUN_INVALID_TRANSITION", ["lifecycle"], "already-terminal");
      }
      next.lifecycle = "cancelled";
      for (const task of next.tasks) {
        if (task.state === "done" || task.state === "cancelled") continue;
        const active =
          task.currentAssignmentId !== null ||
          next.resources.some((claim) => claim.taskId === task.spec.id);
        if (!active) {
          markCancelled(next, task.spec.id, event.reason, facts);
        } else if (quiescent(next, task.spec.id)) {
          markCancelled(next, task.spec.id, event.reason, facts);
        } else {
          freezeTask(next, task.spec.id, event.reason, facts, event.controlNonceDigest);
        }
      }
      return null;
    }
    case "observation-recorded": {
      if (!(RUN_EVENT_RECEIPT_KINDS as readonly string[]).includes(event.receipt.kind)) {
        return reject("RUN_EVENT_INVALID", ["observation", "eventKind"], "not-whitelisted");
      }
      if (next.eventReceipts.some((entry) => entry.dedupeKey === event.receipt.dedupeKey)) {
        return null;
      }
      next.eventReceipts.push({
        ...event.receipt,
        seq: next.counters.observationSeq + 1,
      });
      next.counters.observationSeq += 1;
      return null;
    }
    default: {
      return reject("RUN_EVENT_INVALID", ["event", "kind"], "unsupported-in-batch-b", {
        kind: String((event as { kind?: unknown }).kind ?? "unknown"),
      });
    }
  }
}

function finalize(record: RunRecord, event: RunReducerEvent, facts: ReduceFacts): ReduceResult {
  const next = structuredClone(record);
  const applied = applyEvent(next, event, facts);
  if (applied) return applied;
  // Keep event-specific refusal diagnostics, but never commit a draft that repairs a corrupt
  // source ledger (notably a rolled-back attempt counter).
  const existing = validateExisting(record);
  if (existing) return existing;
  next.updatedAt = facts.now;
  appendEvent(next, event, facts);
  const parsed = RunRecordSchema.safeParse(next);
  if (!parsed.success) {
    return reject("RUN_EVENT_INVALID", ["record"], "record-schema");
  }
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
  if (
    event.kind === "observation-recorded" &&
    (RUN_EVENT_RECEIPT_KINDS as readonly string[]).includes(event.receipt.kind) &&
    record.eventReceipts.some((entry) => entry.dedupeKey === event.receipt.dedupeKey)
  ) {
    const invalid = validateExisting(record);
    if (invalid) return invalid;
    return { ok: true, next: structuredClone(record), effects: [] };
  }
  return finalize(record, event, facts);
}

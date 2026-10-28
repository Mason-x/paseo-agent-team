import {
  RUN_EVENT_RECEIPT_KINDS,
  type RunRecord,
  RunRecordSchema,
  type RunTaskRecord,
  type RunTaskSpec,
} from "../../schemas/run-engine/ledger";
import type { RunReviewReportBlock } from "../../schemas/run-engine/protocol";
import { checkEvidenceGate, checkReviewGate, checkSmokeGate } from "./gates";
import {
  checkLedgerInvariants,
  occupiesExecutionSlot,
  type RunInvariantViolation,
} from "./invariants";
import {
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

export type ReduceFacts = { now: string; newId: (kind: string) => string };

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

function releaseClaims(next: RunRecord, taskId: string): void {
  next.resources = next.resources.filter((claim) => claim.taskId !== taskId);
  const task = taskOf(next, taskId);
  if (task) task.frozenClaimId = null;
}

function markCancelled(next: RunRecord, taskId: string, reason: string, facts: ReduceFacts): void {
  const task = taskOf(next, taskId);
  if (!task) return;
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
  if (
    evidence.assignmentId !== assignment.assignmentId ||
    assignment.turnId === null ||
    evidence.lastTurnId !== assignment.turnId ||
    evidence.endedEventKey === null
  ) {
    return false;
  }
  if (evidence.receipt.kind === "none" || evidence.receipt.confirmedAt === null) return false;
  if (evidence.observationSeq === 0 || evidence.observationSeq > record.counters.observationSeq) {
    return false;
  }
  const ended = record.eventReceipts.find(
    (receipt) =>
      receipt.eventKey === evidence.endedEventKey &&
      receipt.kind === "turn_ended" &&
      receipt.agentId === assignment.agentId &&
      receipt.turnId === assignment.turnId,
  );
  if (ended === undefined || evidence.observationSeq < ended.seq) return false;
  const endedEvent = record.events.find(
    (event) =>
      event.kind === "turn_ended" &&
      event.payload.taskId === taskId &&
      event.payload.turnId === assignment.turnId,
  );
  const endedAt = endedEvent?.at ?? ended.receivedAt;
  if (Date.parse(evidence.refreshObservedAt) < Date.parse(endedAt)) return false;
  const cancelIntent = record.outbox.find((intent) => intent.id === evidence.cancelIntentId);
  if (
    cancelIntent === undefined ||
    (cancelIntent.kind !== "wake" && cancelIntent.kind !== "archive") ||
    cancelIntent.taskId !== taskId ||
    cancelIntent.assignmentId !== assignment.assignmentId ||
    (cancelIntent.state !== "sending" &&
      cancelIntent.state !== "confirmed" &&
      cancelIntent.state !== "outcome-unknown")
  ) {
    return false;
  }
  for (const event of record.events) {
    if (event.seq <= ended.seq) continue;
    if (event.kind !== "turn_started") continue;
    if (event.payload.taskId === taskId || event.payload.assignmentId === assignment.assignmentId) {
      return false;
    }
  }
  return true;
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

function afterGateFailure(next: RunRecord, task: RunTaskWithEvidence, reason: string): void {
  task.qualityFailures += 1;
  task.waitingReason = reason;
  const active = next.tasks.filter((entry) => occupiesExecutionSlot(next, entry)).length;
  if (active < next.policy.configuredConcurrency) {
    task.state = "rework";
    task.reworkCount += 1;
    task.phase = undefined;
  } else {
    task.state = "review";
    task.phase = "awaiting-rework";
  }
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
      if (event.block.dagRevision !== 1) {
        return reject("RUN_EVENT_INVALID", ["dag", "dagRevision"], "initial-revision");
      }
      const ids = new Set<string>();
      for (const spec of event.block.tasks) {
        if (ids.has(spec.id))
          return reject("RUN_EVENT_INVALID", ["dag", "tasks"], "duplicate-task");
        ids.add(spec.id);
      }
      next.tasks = event.block.tasks.map((spec) => newTask(spec, facts));
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
        event.block.dagRevision !== next.dagRevision + 1
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
        } else if (task.state === "done" || task.state === "cancelled") {
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
        if (!taskOf(next, taskId)) {
          return reject("RUN_EVENT_INVALID", ["dag", "cancelTaskIds"], "unknown-task");
        }
        if (quiescent(next, taskId)) markCancelled(next, taskId, "dag-revised", facts);
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
      if (!task || (task.state !== "ready" && task.state !== "rework")) {
        return invalidTransition(event.taskId, task?.state ?? "missing", "assigned");
      }
      const activeOthers = next.tasks.filter(
        (entry) => entry.spec.id !== event.taskId && occupiesExecutionSlot(next, entry),
      ).length;
      if (task.state === "ready" && activeOthers >= next.policy.configuredConcurrency) {
        return reject("RUN_INVALID_TRANSITION", ["tasks", event.taskId, "state"], "capacity");
      }
      if (
        next.assignments.some((entry) => entry.assignmentId === event.assignment.assignmentId) ||
        next.nonceRegistry.some((entry) => entry.nonce === event.nonce.nonce) ||
        next.outbox.some((entry) => entry.id === event.intent.id) ||
        event.assignment.taskId !== event.taskId ||
        event.assignment.assignmentId !== event.intent.assignmentId ||
        event.assignment.nonce !== event.nonce.nonce ||
        event.assignment.attempt !== event.nonce.attempt ||
        event.nonce.assignmentId !== event.assignment.assignmentId ||
        event.nonce.taskId !== event.taskId ||
        event.intent.taskId !== event.taskId ||
        (event.claims ?? []).some((claim) => claim.taskId !== event.taskId)
      ) {
        return reject("RUN_EVENT_INVALID", ["assignment", "taskId"], "assignment-mismatch");
      }
      if (event.assignment.attempt !== task.attempts + 1) {
        return reject("RUN_EVENT_INVALID", ["assignment", "attempt"], "attempt-mismatch");
      }
      next.assignments.push(event.assignment);
      next.nonceRegistry.push(event.nonce);
      next.outbox.push(event.intent);
      next.resources.push(...(event.claims ?? []));
      task.attempts = event.assignment.attempt;
      task.state = "assigned";
      task.phase = "implementation";
      task.waitingReason = null;
      task.currentAssignmentId = event.assignment.assignmentId;
      task.frozenClaimId = null;
      return null;
    }
    case "turn-started": {
      const assignment = assignmentOf(next, event.assignmentId);
      const task = assignment ? taskOf(next, assignment.taskId) : undefined;
      if (!assignment || !task || task.currentAssignmentId !== assignment.assignmentId) {
        return reject(
          "RUN_EVENT_INVALID",
          ["assignments", event.assignmentId],
          "unknown-assignment",
        );
      }
      if (task.state !== "assigned") {
        return invalidTransition(task.spec.id, task.state, "in_progress");
      }
      if (event.agentId !== assignment.agentId) {
        return reject("RUN_EVENT_INVALID", ["turn-started", event.assignmentId], "agent-mismatch");
      }
      task.state = "in_progress";
      task.phase = "implementation";
      assignment.state = "in_progress";
      assignment.startedAt = facts.now;
      assignment.turnId = event.turnId;
      return null;
    }
    case "turn-ended": {
      const assignment = assignmentOf(next, event.assignmentId);
      if (!assignment) {
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
      if (task?.state !== "review")
        return invalidTransition(block.taskId, task?.state ?? "missing", "review");
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
      const evidence = checkEvidenceGate(next, task);
      if (!evidence.ok) {
        return reject(
          "RUN_EVENT_INVALID",
          ["tasks", task.spec.id, "report"],
          String(evidence.issues[0]?.params.reason ?? "evidence"),
        );
      }
      appendReview(task, block, next);
      const gate = checkReviewGate(next, task);
      if (!gate.ok) {
        if (block.verdict === "可合入") {
          return reject(
            "RUN_EVENT_INVALID",
            ["tasks", task.spec.id, "reviews"],
            String(gate.issues[0]?.params.reason ?? "review"),
          );
        }
        afterGateFailure(next, task, String(gate.issues[0]?.params.reason ?? "review"));
        return null;
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
      const evidence = checkEvidenceGate(next, task);
      if (!evidence.ok) {
        return reject(
          "RUN_EVENT_INVALID",
          ["tasks", task.spec.id, "report"],
          String(evidence.issues[0]?.params.reason ?? "evidence"),
        );
      }
      task.smokeReport = block;
      const review = checkReviewGate(next, task);
      const smoke = checkSmokeGate(next, task);
      const failed = !review.ok ? review : !smoke.ok ? smoke : null;
      if (failed) {
        afterGateFailure(next, task, String(failed.issues[0]?.params.reason ?? "smoke"));
        return null;
      }
      completeTask(next, task);
      recomputeReady(next);
      return null;
    }
    case "decision":
      // Raw decision replies need the control-nonce digest that A-batch RunDecisionPoint lacks.
      // R01c supplies it; until then every reply is rejected explicitly rather than half-validated.
      return reject("RUN_EVENT_INVALID", ["decision"], "unsupported-in-batch-b");
    case "cancel-requested": {
      if (!validControlNonceDigest(event.controlNonceDigest)) {
        return reject("RUN_EVENT_INVALID", ["cancel", "controlNonceDigest"], "invalid-digest");
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
          freezeTask(next, taskId, event.reason, facts, event.controlNonceDigest);
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
      if (decision.category !== "D1" || decision.subjectId !== event.taskId) {
        return reject("RUN_EVENT_INVALID", ["decision", event.decisionId], "decision-binding");
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
      if (unsettled || openIntent || next.resources.length > 0) {
        return reject("RUN_INVALID_TRANSITION", ["lifecycle"], "run-not-finished", {
          tasks: unsettled ? 1 : 0,
          intents: openIntent ? 1 : 0,
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
        if (quiescent(next, task.spec.id)) markCancelled(next, task.spec.id, event.reason, facts);
        else freezeTask(next, task.spec.id, event.reason, facts, event.controlNonceDigest);
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
      next.eventReceipts.push(event.receipt);
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

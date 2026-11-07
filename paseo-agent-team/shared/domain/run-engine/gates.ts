import {
  type RunAcceptedProof,
  type RunArtifactRef,
  type RunAssignment,
  type RunRecord,
  type RunStoredReview,
  RunStoredReviewSchema,
  type RunStoredSmokeReport,
  RunStoredSmokeReportSchema,
  RunStoredTaskReportSchema,
  type RunTaskRecord,
} from "../../schemas/run-engine/ledger";
import {
  artifactRefEqual,
  type DeliveryCandidate,
  judgedNothing,
  resolveD,
  resolveProducerProof,
} from "./delivery-binding";
import { dispatchRequirement, structuralSeats } from "./dispatch-requirement";
import { matchesEvidenceRoot } from "./evidence-repair";
import { executionTier, reviewRequirement } from "./tier";
import {
  assignmentPhase,
  dispatchIntentMatches,
  isComplete167,
  isLocalNeverSent,
  isNormalEnded,
  taskById,
} from "./transitions";

export type GateIssue = {
  gate: "evidence" | "review" | "smoke";
  path: readonly (string | number)[];
  params: Record<string, string | number | boolean>;
};

export type GateResult = { ok: true } | { ok: false; issues: GateIssue[] };

const OK: GateResult = { ok: true };

function fail(
  gate: GateIssue["gate"],
  path: readonly (string | number)[],
  reason: string,
): GateResult {
  return { ok: false, issues: [{ gate, path, params: { reason } }] };
}

function withinRoot(root: string, path: string): boolean {
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/u, "");
  const normalized = path.replaceAll("\\", "/");
  if (normalized.split("/").some((part) => part === "." || part === "..")) return false;
  return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`);
}

export function normalizeContainedPath(value: string): string | null {
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return parts.join("/");
}

function inWriteScope(task: RunTaskRecord, file: string): boolean {
  return task.spec.scopes.some(
    (scope) =>
      scope.access === "write" &&
      (scope.kind === "file"
        ? normalizeContainedPath(scope.path) === normalizeContainedPath(file)
        : normalizeContainedPath(file)?.startsWith(`${normalizeContainedPath(scope.path)}/`) ===
          true),
  );
}

export function storedGateIssues(_task: RunTaskRecord): GateIssue[] {
  // 194: task mirrors are forbidden; proof shape validation lives in the ledger schema.
  return [];
}

/** Evidence gate over the resolved producer proof, not a task mirror or current pointer. */
export function checkEvidenceGate(record: RunRecord, task: RunTaskRecord): GateResult {
  const resolved = resolveD(record, task.spec.id);
  if (resolved.kind !== "ok") {
    return fail("evidence", ["tasks", task.spec.id, "producer"], "missing-done-producer");
  }
  const { d } = resolved;
  const checked = checkEvidenceForProducer(record, task, d.producer);
  if (!checked.ok) return checked;
  if (task.ref !== null && !artifactRefEqual(d.ref, task.ref)) {
    return fail("evidence", ["tasks", task.spec.id, "ref"], "ref-mismatch");
  }
  return OK;
}

function acceptedIdentity(
  record: RunRecord,
  assignment: RunAssignment,
  proof: RunAcceptedProof,
): boolean {
  if (
    proof.runId !== record.runId ||
    proof.taskId !== assignment.taskId ||
    proof.assignmentId !== assignment.assignmentId ||
    proof.attempt !== assignment.attempt ||
    proof.nonce !== assignment.nonce ||
    proof.messageId !== assignment.messageId
  )
    return false;
  const nonces = record.nonceRegistry.filter(
    (entry) => entry.nonce === assignment.nonce && entry.assignmentId === assignment.assignmentId,
  );
  const nonce = nonces.length === 1 ? nonces[0] : undefined;
  if (
    !nonce ||
    nonce.runId !== record.runId ||
    nonce.taskId !== assignment.taskId ||
    nonce.attempt !== assignment.attempt ||
    nonce.agentId !== assignment.agentId ||
    nonce.seatId !== assignment.seatId ||
    nonce.phase !== assignmentPhase(assignment) ||
    nonce.acceptedAt === null ||
    nonce.acceptedEventKey !== `proof:${assignment.assignmentId}` ||
    Date.parse(nonce.acceptedAt) < Date.parse(assignment.createdAt) ||
    (nonce.revokedAt !== null && Date.parse(nonce.revokedAt) < Date.parse(nonce.acceptedAt))
  )
    return false;
  const intents = record.outbox.filter(
    (entry) => entry.kind === "dispatch" && entry.assignmentId === assignment.assignmentId,
  );
  const intent = intents.length === 1 ? intents[0] : undefined;
  return (
    intent !== undefined &&
    dispatchIntentMatches(assignment, intent) &&
    intent.localCancellation === null &&
    ["sending", "confirmed", "outcome-unknown"].includes(intent.state)
  );
}

export function producerEpoch(task: RunTaskRecord, producer: RunAssignment): RunTaskRecord {
  return {
    ...task,
    escalations: task.escalations.filter((entry) => entry.atAttempt < producer.attempt),
  };
}

/** Validates the historical producer directly, never through the current head or cache. */
export function checkEvidenceForProducer(
  record: RunRecord,
  task: RunTaskRecord,
  producer: RunAssignment,
): GateResult {
  const proof = resolveProducerProof(record, producer.assignmentId);
  if (
    !proof ||
    !acceptedIdentity(record, producer, proof) ||
    producer.taskId !== task.spec.id ||
    executionTier(producerEpoch(task, producer)) !== producer.tier
  ) {
    return fail("evidence", ["assignments", producer.assignmentId], "invalid-producer");
  }
  if (!matchesEvidenceRoot(record, producer, proof)) {
    return fail(
      "evidence",
      ["assignments", producer.assignmentId],
      "evidence-repair-delivery-changed",
    );
  }
  return evidenceChecks(record, task, producer, proof);
}

function evidenceChecks(
  record: RunRecord,
  task: RunTaskRecord,
  producer: RunAssignment,
  report: DeliveryCandidate["proof"],
): GateResult {
  for (const file of report.changedFiles) {
    if (!inWriteScope(task, file)) {
      return fail("evidence", ["tasks", task.spec.id, "changedFiles"], "outside-scope");
    }
  }
  if (
    producer.workspace !== null &&
    (producer.workspace.id !== report.workspace.id ||
      producer.workspace.branch !== report.workspace.branch ||
      producer.workspace.baseRef !== report.workspace.baseRef)
  ) {
    return fail("evidence", ["tasks", task.spec.id, "workspace"], "workspace-mismatch");
  }
  const evidenceById = new Map(report.evidence.map((entry) => [entry.id, entry]));
  if (evidenceById.size !== report.evidence.length) {
    return fail("evidence", ["tasks", task.spec.id, "evidence"], "duplicate-id");
  }
  for (const requirement of task.spec.evidence) {
    const evidence = evidenceById.get(requirement.id);
    if (!evidence) {
      return fail("evidence", ["tasks", task.spec.id, "evidence", requirement.id], "missing");
    }
    if (requirement.command !== null && evidence.command !== requirement.command) {
      return fail("evidence", ["tasks", task.spec.id, "evidence", requirement.id], "command");
    }
    if (!artifactRefEqual(evidence.ref, report.ref)) {
      return fail("evidence", ["tasks", task.spec.id, "evidence", requirement.id], "ref-mismatch");
    }
    if (evidence.exitCode !== 0) {
      return fail("evidence", ["tasks", task.spec.id, "evidence", requirement.id], "exit-code");
    }
    if (!withinRoot(record.policy.evidenceRoot, evidence.artifactPath)) {
      return fail("evidence", ["tasks", task.spec.id, "evidence", requirement.id], "artifact-root");
    }
    if (
      requirement.minLines !== undefined &&
      (evidence.coverage?.lines ?? 0) < requirement.minLines
    ) {
      return fail(
        "evidence",
        ["tasks", task.spec.id, "evidence", requirement.id],
        "coverage-lines",
      );
    }
    if (
      requirement.minFunctions !== undefined &&
      (evidence.coverage?.functions ?? 0) < requirement.minFunctions
    ) {
      return fail(
        "evidence",
        ["tasks", task.spec.id, "evidence", requirement.id],
        "coverage-functions",
      );
    }
    if (requirement.requiresIsolatedHome) {
      if (
        evidence.isolation === undefined ||
        !evidence.isolation.outsideRealHome ||
        /(^|\/)\.paseo($|\/)/iu.test(evidence.isolation.homePath.replaceAll("\\", "/"))
      ) {
        return fail("evidence", ["tasks", task.spec.id, "evidence", requirement.id], "isolation");
      }
    }
  }
  return OK;
}

function reviewsForD(
  record: RunRecord,
  producerAssignmentId: string,
): { assignment: RunRecord["assignments"][number]; proof: RunStoredReview }[] {
  return record.assignments.flatMap((assignment) => {
    if (assignment.purpose !== "reviewer") return [];
    const parsed = RunStoredReviewSchema.safeParse(assignment.acceptedProof);
    if (!parsed.success || assignment.delivery?.producerAssignmentId !== producerAssignmentId) {
      return [];
    }
    return [{ assignment, proof: parsed.data }];
  });
}

function smokesForD(
  record: RunRecord,
  producerAssignmentId: string,
): { assignment: RunRecord["assignments"][number]; proof: RunStoredSmokeReport }[] {
  return record.assignments.flatMap((assignment) => {
    const parsed = RunStoredSmokeReportSchema.safeParse(assignment.acceptedProof);
    if (!parsed.success || assignment.delivery?.producerAssignmentId !== producerAssignmentId) {
      return [];
    }
    return [{ assignment, proof: parsed.data }];
  });
}

export function reviewEligible(
  record: RunRecord,
  task: RunTaskRecord,
  assignment: RunRecord["assignments"][number],
  review: RunStoredReview,
): boolean {
  const resolved = resolveD(record, task.spec.id);
  if (resolved.kind !== "ok") return false;
  const d = resolved.d;
  return reviewForProducer(record, task, assignment, review, d.producer, d.ref);
}

function reviewForProducer(
  record: RunRecord,
  task: RunTaskRecord,
  assignment: RunAssignment,
  review: RunStoredReview,
  producer: RunAssignment,
  ref: RunArtifactRef,
): boolean {
  if (
    !acceptedIdentity(record, assignment, review) ||
    !checkEvidenceForProducer(record, task, producer).ok
  )
    return false;
  if (assignment.taskId !== task.spec.id || assignment.purpose !== "reviewer") return false;
  if (assignment.attempt !== producer.attempt) return false;
  if (assignment.delivery?.producerAssignmentId !== producer.assignmentId) return false;
  if (!artifactRefEqual(review.reviewedRef, ref)) return false;
  const requirement = reviewRequirement(producerEpoch(task, producer));
  if (assignment.tier !== requirement.tier) return false;
  if (assignment.agentId === producer.agentId || assignment.seatId === producer.seatId) {
    return false;
  }
  if (requirement.level === "L1") {
    const producerFamily = producer.family;
    if (producerFamily === null || assignment.family === null) return false;
    if (assignment.family === producerFamily) return false;
  }
  return true;
}

export function checkReviewGate(record: RunRecord, task: RunTaskRecord): GateResult {
  const resolved = resolveD(record, task.spec.id);
  if (resolved.kind !== "ok") return fail("review", ["tasks", task.spec.id], "missing-delivery");
  const current = reviewsForD(record, resolved.d.producer.assignmentId).filter((entry) =>
    reviewEligible(record, task, entry.assignment, entry.proof),
  );
  if (current.some(({ proof }) => proof.verdict !== "可合入" || proof.blockers.length > 0)) {
    return fail("review", ["tasks", task.spec.id, "reviews"], "blocked-review");
  }
  return current.some(({ proof }) => proof.verdict === "可合入")
    ? OK
    : fail("review", ["tasks", task.spec.id, "reviews"], "no-valid-review");
}

export function failedDeliveryIds(record: RunRecord, task: RunTaskRecord): string[] {
  const ids = new Set<string>();
  for (const producer of record.assignments) {
    if (producer.taskId !== task.spec.id) continue;
    if (!["member", "coordinator", "reopen"].includes(producer.purpose)) continue;
    const proof = resolveProducerProof(record, producer.assignmentId);
    if (!proof || !checkEvidenceForProducer(record, task, producer).ok) continue;
    const reviews = reviewsForD(record, producer.assignmentId);
    if (
      reviews.some(
        ({ assignment, proof: review }) =>
          reviewForProducer(record, task, assignment, review, producer, proof.ref) &&
          (review.verdict !== "可合入" || review.blockers.length > 0),
      )
    ) {
      ids.add(producer.assignmentId);
      continue;
    }
    const smokes = smokesForD(record, producer.assignmentId);
    if (
      smokes.some(
        ({ assignment, proof: smoke }) =>
          validSmokeSource(record, task, assignment, smoke, producer, proof.ref) &&
          smoke.checks.some((check) => check.result === "fail"),
      )
    ) {
      ids.add(producer.assignmentId);
    }
  }
  return [...ids];
}

function actorSettled(record: RunRecord, assignment: RunRecord["assignments"][number]): boolean {
  return isNormalEnded(record, assignment);
}

/** The host:port a smoke report may name; null for credentials, no port, or the default 6767 daemon. */
export function devEndpoint(host: string): string | null {
  try {
    const url = new URL(host.includes("://") ? host : `http://${host}`);
    if (url.username || url.password || url.port === "" || url.port === "6767") return null;
    return `${url.hostname.replace(/\.$/u, "")}:${url.port}`;
  } catch {
    return null;
  }
}

function validSmokeSource(
  record: RunRecord,
  task: RunTaskRecord,
  assignment: RunRecord["assignments"][number],
  proof: RunStoredSmokeReport,
  producer: RunRecord["assignments"][number],
  ref: RunArtifactRef,
): boolean {
  if (
    !acceptedIdentity(record, assignment, proof) ||
    !checkEvidenceForProducer(record, task, producer).ok
  )
    return false;
  if (
    assignment.purpose !== "smoker" ||
    assignment.taskId !== task.spec.id ||
    assignment.attempt !== producer.attempt ||
    assignment.delivery?.producerAssignmentId !== producer.assignmentId ||
    assignment.agentId === producer.agentId ||
    assignment.seatId === producer.seatId ||
    !artifactRefEqual(proof.testedRef, ref)
  )
    return false;
  const endpoint = devEndpoint(proof.devHost);
  const target = record.policy.devTargets.find((entry) => entry.serverId === proof.devServerId);
  if (
    endpoint === null ||
    !target ||
    devEndpoint(target.host) !== endpoint ||
    proof.devHome.replaceAll("\\", "/") !== target.home.replaceAll("\\", "/") ||
    /(^|\/)\.paseo($|\/)/iu.test(proof.devHome.replaceAll("\\", "/"))
  )
    return false;
  const ids = proof.checks.map((entry) => entry.id);
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== task.spec.smokeChecklist.length ||
    task.spec.smokeChecklist.some((id) => !ids.includes(id))
  )
    return false;
  return proof.checks.every((entry) => withinRoot(record.policy.evidenceRoot, entry.evidencePath));
}

/** I7 validates every stored reply against its producer epoch, including revoked/history replies.
 * A producer's failed/blocked or evidence-rejected done report remains a valid stored fact.
 */
export function historicalProofValid(
  record: RunRecord,
  task: RunTaskRecord,
  assignment: RunAssignment,
): boolean {
  const proof = assignment.acceptedProof;
  if (proof === null || !acceptedIdentity(record, assignment, proof)) return false;
  const action =
    assignment.purpose === "reviewer"
      ? "review"
      : assignment.purpose === "smoker"
        ? "smoke"
        : "produce";
  const producer =
    action === "produce"
      ? assignment
      : record.assignments.find(
          (entry) => entry.assignmentId === assignment.delivery?.producerAssignmentId,
        );
  if (!producer || producer.taskId !== task.spec.id) return false;
  const requirement = dispatchRequirement(producerEpoch(task, producer), action);
  if (
    requirement.kind !== "required" ||
    !requirement.allowedPurposes.includes(assignment.purpose) ||
    !structuralSeats(record.roster, requirement).some(
      (seat) =>
        seat.seatId === assignment.seatId &&
        seat.agentId === assignment.agentId &&
        seat.channelId === assignment.channelId &&
        seat.tier === assignment.tier,
    )
  )
    return false;
  if (action === "produce") return assignment.delivery === null;
  const delivery = resolveProducerProof(record, producer.assignmentId);
  if (!delivery) return false;
  // A judge that could not do its job holds a blocked task-report instead of a verdict or checks.
  if (RunStoredTaskReportSchema.safeParse(proof).data?.status === "blocked") return true;
  if (action === "review") {
    const review = RunStoredReviewSchema.safeParse(proof);
    return (
      review.success &&
      reviewForProducer(record, task, assignment, review.data, producer, delivery.ref)
    );
  }
  const smoke = RunStoredSmokeReportSchema.safeParse(proof);
  return (
    task.spec.devSmoke === true &&
    smoke.success &&
    validSmokeSource(record, task, assignment, smoke.data, producer, delivery.ref)
  );
}

/** All registered replies for the current D, with every actor settled, are required for done. */
export function doneGate(record: RunRecord, task: RunTaskRecord): GateResult {
  const resolved = resolveD(record, task.spec.id);
  if (resolved.kind !== "ok") return fail("evidence", ["tasks", task.spec.id], "missing-delivery");
  const d = resolved.d;
  const evidence = checkEvidenceForProducer(record, task, d.producer);
  if (!evidence.ok) return evidence;
  if (failedDeliveryIds(record, task).includes(d.producer.assignmentId)) {
    return fail("review", ["tasks", task.spec.id, "quality"], "failed-delivery");
  }
  // A judge that said it could not judge (and was settled) neither passes nor fails the delivery: it
  // is how a person has a delivery judged again after the environment was put right (P06).
  const reviewers = record.assignments.filter(
    (entry) =>
      entry.taskId === task.spec.id &&
      entry.purpose === "reviewer" &&
      entry.delivery?.producerAssignmentId === d.producer.assignmentId &&
      !judgedNothing(entry),
  );
  if (reviewers.length === 0)
    return fail("review", ["tasks", task.spec.id, "reviews"], "no-reviewer");
  for (const reviewer of reviewers) {
    const proof = RunStoredReviewSchema.safeParse(reviewer.acceptedProof);
    if (
      !proof.success ||
      proof.data.verdict !== "可合入" ||
      proof.data.blockers.length > 0 ||
      !reviewEligible(record, task, reviewer, proof.data)
    ) {
      return fail("review", ["tasks", task.spec.id, "reviews"], "pending-or-invalid-review");
    }
    if (!actorSettled(record, reviewer)) {
      return fail("review", ["tasks", task.spec.id, "reviews"], "unsettled-reviewer");
    }
  }
  if (task.spec.devSmoke) {
    const smokers = record.assignments.filter(
      (entry) =>
        entry.taskId === task.spec.id &&
        entry.purpose === "smoker" &&
        entry.delivery?.producerAssignmentId === d.producer.assignmentId &&
        !judgedNothing(entry),
    );
    if (smokers.length === 0) return fail("smoke", ["tasks", task.spec.id, "smoke"], "no-smoker");
    for (const smoker of smokers) {
      const proof = RunStoredSmokeReportSchema.safeParse(smoker.acceptedProof);
      if (
        !proof.success ||
        !validSmokeSource(record, task, smoker, proof.data, d.producer, d.ref) ||
        proof.data.checks.some((check) => check.result !== "pass")
      ) {
        return fail("smoke", ["tasks", task.spec.id, "smoke"], "pending-or-failed-smoke");
      }
      if (!actorSettled(record, smoker)) {
        return fail("smoke", ["tasks", task.spec.id, "smoke"], "unsettled-smoker");
      }
    }
    if (!actorSettled(record, d.producer)) {
      return fail("evidence", ["tasks", task.spec.id], "unsettled-producer");
    }
  } else if (!actorSettled(record, d.producer)) {
    return fail("evidence", ["tasks", task.spec.id], "unsettled-producer");
  }
  if (
    record.assignments.some(
      (entry) =>
        entry.taskId === task.spec.id &&
        !isNormalEnded(record, entry) &&
        !isComplete167(record, entry) &&
        !isLocalNeverSent(record, entry),
    )
  ) {
    return fail("review", ["tasks", task.spec.id], "unsettled-task-actor");
  }
  return OK;
}

export function checkSmokeGate(record: RunRecord, task: RunTaskRecord): GateResult {
  if (!task.spec.devSmoke) return OK;
  const resolved = resolveD(record, task.spec.id);
  if (resolved.kind !== "ok") return fail("smoke", ["tasks", task.spec.id], "missing-delivery");
  const proofs = smokesForD(record, resolved.d.producer.assignmentId);
  if (proofs.length === 0) return fail("smoke", ["tasks", task.spec.id, "smoke"], "no-smoke");
  if (
    proofs.some(
      ({ assignment, proof }) =>
        !validSmokeSource(record, task, assignment, proof, resolved.d.producer, resolved.d.ref) ||
        proof.checks.some((check) => check.result !== "pass"),
    )
  ) {
    return fail("smoke", ["tasks", task.spec.id, "smoke"], "failed-smoke");
  }
  return OK;
}

export function smokeEligible(
  record: RunRecord,
  task: RunTaskRecord,
  assignment: RunAssignment,
  proof: RunStoredSmokeReport,
): boolean {
  const d = resolveD(record, task.spec.id);
  return (
    d.kind === "ok" && validSmokeSource(record, task, assignment, proof, d.d.producer, d.d.ref)
  );
}

export function findTask(record: RunRecord, taskId: string): RunTaskRecord | undefined {
  return taskById(record, taskId);
}

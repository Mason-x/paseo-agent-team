import {
  type RunArtifactRef,
  type RunRecord,
  type RunStoredReview,
  RunStoredReviewSchema,
  type RunStoredSmokeReport,
  RunStoredSmokeReportSchema,
  type RunStoredTaskReport,
  type RunTaskRecord,
} from "../../schemas/run-engine/ledger";
import { type DeliveryCandidate, resolveD } from "./delivery-binding";
import { normalizeLogicalPath } from "./locks";
import { reviewRequirement } from "./tier";
import { isNormalEnded, taskById } from "./transitions";

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

function artifactKey(ref: RunArtifactRef): string {
  return ref.kind === "git-commit" ? `git:${ref.value}` : `diff:${ref.value}`;
}

function withinRoot(root: string, path: string): boolean {
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/u, "");
  const normalized = path.replaceAll("\\", "/");
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
  const report = d.proof;
  if (task.ref !== null && artifactKey(report.ref) !== artifactKey(task.ref)) {
    return fail("evidence", ["tasks", task.spec.id, "ref"], "ref-mismatch");
  }
  for (const file of report.changedFiles) {
    if (!inWriteScope(task, file)) {
      return fail("evidence", ["tasks", task.spec.id, "changedFiles"], "outside-scope");
    }
  }
  if (
    d.producer.workspace !== null &&
    (d.producer.workspace.id !== report.workspace.id ||
      d.producer.workspace.branch !== report.workspace.branch ||
      d.producer.workspace.baseRef !== report.workspace.baseRef)
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
    if (artifactKey(evidence.ref) !== artifactKey(report.ref)) {
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
  if (assignment.taskId !== task.spec.id || assignment.purpose !== "reviewer") return false;
  if (assignment.attempt !== d.producer.attempt) return false;
  if (assignment.delivery?.producerAssignmentId !== d.producer.assignmentId) return false;
  if (artifactKey(review.reviewedRef) !== artifactKey(d.ref)) return false;
  const requirement = reviewRequirement(task);
  if (assignment.tier !== requirement.tier) return false;
  if (assignment.agentId === d.producer.agentId || assignment.seatId === d.producer.seatId) {
    return false;
  }
  if (requirement.level === "L1") {
    const producerFamily = d.producer.family;
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
    const proof = producer.acceptedProof;
    if (!proof || !("status" in proof) || proof.status !== "done") continue;
    const reviews = reviewsForD(record, producer.assignmentId);
    if (
      reviews.some(({ proof: review }) => review.verdict !== "可合入" || review.blockers.length > 0)
    ) {
      ids.add(producer.assignmentId);
      continue;
    }
    const smokes = smokesForD(record, producer.assignmentId);
    if (smokes.some(({ proof: smoke }) => smoke.checks.some((check) => check.result === "fail"))) {
      ids.add(producer.assignmentId);
    }
  }
  return [...ids];
}

function actorSettled(record: RunRecord, assignment: RunRecord["assignments"][number]): boolean {
  if (isNormalEnded(record, assignment)) return true;
  return (
    assignment.startedAt === null &&
    assignment.acceptedProof !== null &&
    assignment.state !== "cancelled" &&
    assignment.state !== "failed"
  );
}

/** All registered replies for the current D, with every actor settled, are required for done. */
export function doneGate(record: RunRecord, task: RunTaskRecord): GateResult {
  const resolved = resolveD(record, task.spec.id);
  if (resolved.kind !== "ok") return fail("evidence", ["tasks", task.spec.id], "missing-delivery");
  const d = resolved.d;
  if (failedDeliveryIds(record, task).includes(d.producer.assignmentId)) {
    return fail("review", ["tasks", task.spec.id, "quality"], "failed-delivery");
  }
  const reviewers = record.assignments.filter(
    (entry) =>
      entry.taskId === task.spec.id &&
      entry.purpose === "reviewer" &&
      entry.delivery?.producerAssignmentId === d.producer.assignmentId,
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
        entry.delivery?.producerAssignmentId === d.producer.assignmentId,
    );
    if (smokers.length === 0) return fail("smoke", ["tasks", task.spec.id, "smoke"], "no-smoker");
    for (const smoker of smokers) {
      const proof = RunStoredSmokeReportSchema.safeParse(smoker.acceptedProof);
      if (!proof.success || proof.data.checks.some((check) => check.result !== "pass")) {
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
  return OK;
}

export function checkSmokeGate(record: RunRecord, task: RunTaskRecord): GateResult {
  if (!task.spec.devSmoke) return OK;
  const resolved = resolveD(record, task.spec.id);
  if (resolved.kind !== "ok") return fail("smoke", ["tasks", task.spec.id], "missing-delivery");
  const proofs = smokesForD(record, resolved.d.producer.assignmentId);
  if (proofs.length === 0) return fail("smoke", ["tasks", task.spec.id, "smoke"], "no-smoke");
  if (proofs.some(({ proof }) => proof.checks.some((check) => check.result !== "pass"))) {
    return fail("smoke", ["tasks", task.spec.id, "smoke"], "failed-smoke");
  }
  return OK;
}

export function findTask(record: RunRecord, taskId: string): RunTaskRecord | undefined {
  return taskById(record, taskId);
}

import type { RunRecord, RunTaskRecord } from "../../schemas/run-engine/ledger";
import { type RunStoredReview, type RunTaskWithEvidence, taskById } from "./transitions";

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

function artifactKey(ref: unknown): string {
  return JSON.stringify(ref);
}

/** Logical relative paths only: reject absolute paths, drive letters and any `..` segment. */
export function normalizeContainedPath(value: string): string | null {
  const raw = value.replaceAll("\\", "/").trim();
  if (raw === "" || raw.startsWith("/") || /^[A-Za-z]:/u.test(raw)) return null;
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    segments.push(segment);
  }
  return segments.length === 0 ? null : segments.join("/").toLowerCase();
}

function withinRoot(root: string, path: string): boolean {
  const base = normalizeContainedPath(root);
  const target = normalizeContainedPath(path);
  if (base === null || target === null) return false;
  return target === base || target.startsWith(`${base}/`);
}

/** Everyone who implemented this task, by agent id and seat id. */
function implementationActors(record: RunRecord, taskId: string): Set<string> {
  const actors = new Set<string>();
  for (const entry of record.nonceRegistry) {
    if (entry.taskId !== taskId || entry.phase !== "implementation") continue;
    actors.add(entry.agentId);
    actors.add(entry.seatId);
  }
  for (const assignment of record.assignments) {
    if (assignment.taskId !== taskId) continue;
    if (assignment.purpose === "reviewer" || assignment.purpose === "smoker") continue;
    actors.add(assignment.agentId);
    actors.add(assignment.seatId);
  }
  return actors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIndependent(review: RunStoredReview, actors: ReadonlySet<string>): boolean {
  return !actors.has(review.reviewerAgentId) && !actors.has(review.reviewerSeatId);
}

const LEVEL_REVIEW_TIER: Record<string, "B" | "A" | "S"> = {
  L1: "B",
  L2: "A",
  L3: "A",
  L4: "S",
};
const TIER_RANK: Record<string, number> = { B: 0, A: 1, S: 2 };

/** The stricter of the task's current level and any recorded escalation origin. */
function requiredReviewTier(task: RunTaskRecord): "B" | "A" | "S" {
  let required = LEVEL_REVIEW_TIER[task.spec.level] ?? "S";
  for (const entry of task.escalations) {
    if (!isRecord(entry)) continue;
    for (const key of ["from", "fromLevel", "level"] as const) {
      const value = entry[key];
      if (typeof value !== "string") continue;
      const tier = LEVEL_REVIEW_TIER[value];
      if (tier !== undefined && TIER_RANK[tier] > TIER_RANK[required]) required = tier;
    }
  }
  return required;
}

function reviewAssignment(
  record: RunRecord,
  taskId: string,
  review: RunStoredReview,
): RunRecord["assignments"][number] | undefined {
  const byId =
    review.assignmentId === undefined
      ? undefined
      : record.assignments.find(
          (entry) =>
            entry.assignmentId === review.assignmentId &&
            entry.taskId === taskId &&
            entry.purpose === "reviewer",
        );
  if (byId) return byId;
  return record.assignments.find(
    (entry) =>
      entry.taskId === taskId &&
      entry.purpose === "reviewer" &&
      entry.agentId === review.reviewerAgentId &&
      entry.seatId === review.reviewerSeatId,
  );
}

function reviewerQualified(
  record: RunRecord,
  task: RunTaskRecord,
  review: RunStoredReview,
): boolean {
  const assignment = reviewAssignment(record, task.spec.id, review);
  if (!assignment) return false;
  const required = requiredReviewTier(task);
  if (assignment.tier !== required) return false;
  if (required !== "B") return true;
  const implementerFamilies = new Set(
    record.assignments
      .filter(
        (entry) =>
          entry.taskId === task.spec.id &&
          entry.purpose !== "reviewer" &&
          entry.purpose !== "smoker" &&
          entry.family !== null &&
          entry.family !== undefined,
      )
      .map((entry) => entry.family as string),
  );
  return (
    implementerFamilies.size > 0 &&
    assignment.family !== null &&
    assignment.family !== undefined &&
    !implementerFamilies.has(assignment.family)
  );
}

function inWriteScope(task: RunTaskRecord, file: string): boolean {
  return task.spec.scopes.some(
    (scope) =>
      scope.access === "write" &&
      (scope.kind === "file"
        ? normalizeContainedPath(scope.path) === normalizeContainedPath(file)
        : withinRoot(scope.path, file)),
  );
}

/** RE3.2: a done report is evidence only when every contract requirement has a matching item. */
export function checkEvidenceGate(record: RunRecord, taskValue: RunTaskRecord): GateResult {
  const task = taskValue as RunTaskWithEvidence;
  const report = task.report;
  if (report === undefined) {
    return fail("evidence", ["tasks", task.spec.id, "report"], "missing-done-report");
  }
  if (!isRecord(report)) {
    return fail("evidence", ["tasks", task.spec.id, "report"], "invalid-report");
  }
  if (report.status !== "done") {
    return fail("evidence", ["tasks", task.spec.id, "report"], "missing-done-report");
  }
  if (
    !Array.isArray(report.changedFiles) ||
    !report.changedFiles.every((file) => typeof file === "string") ||
    !Array.isArray(report.evidence) ||
    !report.evidence.every((entry) => isRecord(entry) && typeof entry.id === "string") ||
    !isRecord(report.ref)
  ) {
    return fail("evidence", ["tasks", task.spec.id, "report"], "invalid-report");
  }
  if (task.ref === null || artifactKey(report.ref) !== artifactKey(task.ref)) {
    return fail("evidence", ["tasks", task.spec.id, "ref"], "ref-mismatch");
  }
  for (const file of report.changedFiles) {
    if (!inWriteScope(task, file)) {
      return fail("evidence", ["tasks", task.spec.id, "changedFiles"], "outside-scope");
    }
  }
  const assignment =
    record.assignments.find((entry) => entry.assignmentId === report.assignmentId) ??
    record.assignments.find((entry) => entry.assignmentId === task.currentAssignmentId);
  if (assignment?.workspace && report.workspace) {
    if (
      assignment.workspace.id !== report.workspace.id ||
      assignment.workspace.branch !== report.workspace.branch ||
      assignment.workspace.baseRef !== report.workspace.baseRef
    ) {
      return fail("evidence", ["tasks", task.spec.id, "workspace"], "workspace-mismatch");
    }
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
    if (
      (evidence.command !== null && typeof evidence.command !== "string") ||
      typeof evidence.exitCode !== "number" ||
      typeof evidence.summary !== "string" ||
      typeof evidence.artifactPath !== "string" ||
      !isRecord(evidence.ref)
    ) {
      return fail("evidence", ["tasks", task.spec.id, "evidence", requirement.id], "invalid");
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
    if (evidence.summary.trim() === "") {
      return fail("evidence", ["tasks", task.spec.id, "evidence", requirement.id], "summary");
    }
    if (!withinRoot(record.policy.evidenceRoot, evidence.artifactPath)) {
      return fail("evidence", ["tasks", task.spec.id, "evidence", requirement.id], "artifact-root");
    }
    if (requirement.minLines !== undefined) {
      if (evidence.coverage === undefined || evidence.coverage.lines < requirement.minLines) {
        return fail(
          "evidence",
          ["tasks", task.spec.id, "evidence", requirement.id],
          "coverage-lines",
        );
      }
    }
    if (requirement.minFunctions !== undefined) {
      if (
        evidence.coverage === undefined ||
        evidence.coverage.functions < requirement.minFunctions
      ) {
        return fail(
          "evidence",
          ["tasks", task.spec.id, "evidence", requirement.id],
          "coverage-functions",
        );
      }
    }
    if (requirement.requiresIsolatedHome) {
      if (
        evidence.isolation === undefined ||
        !evidence.isolation.outsideRealHome ||
        realHomeLike(evidence.isolation.homePath)
      ) {
        return fail("evidence", ["tasks", task.spec.id, "evidence", requirement.id], "isolation");
      }
    }
  }
  return OK;
}

/** RE3.3: accept only an independent, non-blocking review of the current artifact. */
export function checkReviewGate(record: RunRecord, taskValue: RunTaskRecord): GateResult {
  const task = taskValue as RunTaskWithEvidence;
  if (task.ref === null) return fail("review", ["tasks", task.spec.id, "ref"], "missing-ref");
  if (task.reviews !== undefined && !Array.isArray(task.reviews)) {
    return fail("review", ["tasks", task.spec.id, "reviews"], "invalid-reviews");
  }
  const actors = implementationActors(record, task.spec.id);
  const reviews = task.reviews ?? [];
  const valid = reviews.some((review) => {
    if (!isRecord(review)) return false;
    if (typeof review.reviewerAgentId !== "string" || review.reviewerAgentId === "") return false;
    if (typeof review.reviewerSeatId !== "string" || review.reviewerSeatId === "") return false;
    if (review.verdict !== "可合入") return false;
    if (!Array.isArray(review.blockers) || review.blockers.length !== 0) return false;
    if (artifactKey(review.reviewedRef) !== artifactKey(task.ref)) return false;
    return isIndependent(review, actors) && reviewerQualified(record, task, review);
  });
  return valid ? OK : fail("review", ["tasks", task.spec.id, "reviews"], "no-valid-review");
}

function normalizedAnyPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+/gu, "/").toLowerCase();
}

function realHomeLike(value: string): boolean {
  const path = value.replaceAll("\\", "/").toLowerCase();
  return path.includes("/.paseo") || path.endsWith("/.paseo");
}

function canonicalDevHost(value: string): string {
  let host = value.trim().toLowerCase();
  host = host.replace(/^https?:\/\//u, "").replace(/\/.*$/u, "");
  if (/^\d+$/u.test(host)) return `loopback:${host}`;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/u.exec(host);
  const plain = /^([^:]+)(?::(\d+))?$/u.exec(host);
  const name = bracketed?.[1] ?? plain?.[1] ?? host;
  const rawPort = bracketed?.[2] ?? plain?.[2] ?? "";
  const port = rawPort === "" ? "" : String(Number(rawPort));
  const loopback =
    name === "localhost" || name === "127.0.0.1" || name === "::1" || name === "0.0.0.0";
  return `${loopback ? "loopback" : name}:${port}`;
}

function defaultDevHost(value: string): boolean {
  return canonicalDevHost(value) === "loopback:6767";
}

/** RE3.4: only the pre-registered dedicated DEV target may pass a smoke report. */
export function checkSmokeGate(record: RunRecord, taskValue: RunTaskRecord): GateResult {
  const task = taskValue as RunTaskWithEvidence;
  if (!task.spec.devSmoke) return OK;
  const report = task.smokeReport;
  if (!isRecord(report)) {
    return fail("smoke", ["tasks", task.spec.id, "smokeReport"], "invalid-report");
  }
  if (
    !Array.isArray(report.checks) ||
    !report.checks.every(
      (check) =>
        isRecord(check) &&
        typeof check.id === "string" &&
        typeof check.evidencePath === "string" &&
        (check.result === "pass" || check.result === "fail"),
    ) ||
    !isRecord(report.testedRef) ||
    typeof report.devServerId !== "string" ||
    typeof report.devHost !== "string" ||
    typeof report.devHome !== "string"
  ) {
    return fail("smoke", ["tasks", task.spec.id, "smokeReport"], "invalid-report");
  }
  if (task.ref !== null && artifactKey(report.testedRef) !== artifactKey(task.ref)) {
    return fail("smoke", ["tasks", task.spec.id, "testedRef"], "ref-mismatch");
  }
  const smoker = record.assignments.find((entry) => entry.assignmentId === report.assignmentId);
  if (smoker) {
    const actors = implementationActors(record, task.spec.id);
    if (actors.has(smoker.agentId) || actors.has(smoker.seatId)) {
      return fail("smoke", ["tasks", task.spec.id, "smokeReport", "assignmentId"], "self-smoke");
    }
  }
  const target = record.policy.devTargets.find((entry) => entry.serverId === report.devServerId);
  if (!target) return fail("smoke", ["tasks", task.spec.id, "devServerId"], "not-registered");
  if (
    defaultDevHost(report.devHost) ||
    canonicalDevHost(report.devHost) !== canonicalDevHost(target.host) ||
    normalizedAnyPath(report.devHome) !== normalizedAnyPath(target.home) ||
    realHomeLike(report.devHome)
  ) {
    return fail("smoke", ["tasks", task.spec.id, "devHost"], "wrong-target");
  }
  const checks = new Map(report.checks.map((check) => [check.id, check]));
  if (checks.size !== report.checks.length) {
    return fail("smoke", ["tasks", task.spec.id, "checks"], "duplicate-check");
  }
  for (const checkId of task.spec.smokeChecklist) {
    const check = checks.get(checkId);
    if (check === undefined) {
      return fail("smoke", ["tasks", task.spec.id, "checks", checkId], "missing-check");
    }
    if (check.result !== "pass") {
      return fail("smoke", ["tasks", task.spec.id, "checks", checkId], "failed-check");
    }
    if (!withinRoot(record.policy.evidenceRoot, check.evidencePath)) {
      return fail("smoke", ["tasks", task.spec.id, "checks", checkId], "evidence-root");
    }
  }
  if (checks.size !== task.spec.smokeChecklist.length) {
    return fail("smoke", ["tasks", task.spec.id, "checks"], "extra-check");
  }
  return OK;
}

export function findTask(record: RunRecord, taskId: string): RunTaskRecord | undefined {
  return taskById(record, taskId);
}

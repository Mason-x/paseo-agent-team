import {
  RunArtifactRefSchema,
  RunEvidenceSchema,
  type RunRecord,
  type RunTaskRecord,
  RunWorkspaceSchema,
} from "../../schemas/run-engine/ledger";
import {
  RunReviewReportBlockSchema,
  RunSmokeReportBlockSchema,
} from "../../schemas/run-engine/protocol";
import { normalizeLogicalPath, scopeCovers } from "./locks";
import { reviewRequirement } from "./tier";
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

function artifactKey(ref: unknown): string | null {
  const parsed = RunArtifactRefSchema.safeParse(ref);
  if (!parsed.success) return null;
  const value = parsed.data;
  return JSON.stringify(
    value.kind === "git-commit"
      ? [value.kind, value.value]
      : [value.kind, value.value, value.baseCommit, value.patchPath],
  );
}

/** Compatibility view of the shared lexical rule; realpath/short-name stays in R05. */
export function normalizeContainedPath(value: string): string | null {
  const normalized = normalizeLogicalPath(value);
  return normalized.ok ? normalized.caseFolded : null;
}

function withinRoot(root: string, path: string): boolean {
  const base = normalizeContainedPath(root);
  const target = normalizeContainedPath(path);
  if (base === null || target === null) return false;
  return scopeCovers({ path: base }, { path: target });
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

// Stored reports predate full protocol envelopes in some ledgers. Validate the facts actually
// consumed by the gates using R01's nested schemas, without inventing protocol identity fields.
const storedReviewSchema = RunReviewReportBlockSchema.pick({
  reviewedRef: true,
  verdict: true,
  blockers: true,
}).passthrough();
const storedSmokeSchema = RunSmokeReportBlockSchema.pick({
  testedRef: true,
  checks: true,
  devHost: true,
  devServerId: true,
  devHome: true,
}).passthrough();

export function storedGateIssues(task: RunTaskRecord): GateIssue[] {
  const issues: GateIssue[] = [];
  const invalid = (gate: GateIssue["gate"], field: string): void => {
    issues.push({
      gate,
      path: ["tasks", task.spec.id, field],
      params: { reason: `invalid-${field}-extension` },
    });
  };
  const report = task.report;
  if (report !== undefined) {
    if (!isRecord(report) || !["done", "blocked", "failed"].includes(String(report.status))) {
      invalid("evidence", "report");
    } else if (
      report.status === "done" &&
      (!Array.isArray(report.changedFiles) ||
        !report.changedFiles.every((file) => typeof file === "string") ||
        !Array.isArray(report.evidence) ||
        !report.evidence.every((entry) => RunEvidenceSchema.safeParse(entry).success) ||
        !RunArtifactRefSchema.safeParse(report.ref).success ||
        (report.workspace !== undefined && !RunWorkspaceSchema.safeParse(report.workspace).success))
    ) {
      invalid("evidence", "report");
    }
  }
  const reviews = task.reviews;
  if (
    reviews !== undefined &&
    (!Array.isArray(reviews) ||
      !reviews.every(
        (review) =>
          isRecord(review) &&
          storedReviewSchema.safeParse(review).success &&
          typeof review.reviewerAgentId === "string" &&
          review.reviewerAgentId.length > 0 &&
          typeof review.reviewerSeatId === "string" &&
          review.reviewerSeatId.length > 0 &&
          (review.assignmentId === undefined ||
            (typeof review.assignmentId === "string" && review.assignmentId.length > 0)) &&
          (review.phase === undefined || review.phase === "review" || review.phase === "smoke") &&
          (review.probes === undefined ||
            RunReviewReportBlockSchema.shape.probes.safeParse(review.probes).success),
      ))
  )
    invalid("review", "reviews");
  if (task.smokeReport !== undefined && !storedSmokeSchema.safeParse(task.smokeReport).success) {
    invalid("smoke", "smokeReport");
  }
  return issues;
}

function isIndependent(review: RunStoredReview, actors: ReadonlySet<string>): boolean {
  return !actors.has(review.reviewerAgentId) && !actors.has(review.reviewerSeatId);
}

/** Review strength is owned by R01d's tier.ts so dispatch and the gate cannot diverge. */
function requiredReviewRequirement(task: RunTaskRecord): ReturnType<typeof reviewRequirement> {
  return reviewRequirement(task);
}

function reviewAssignment(
  record: RunRecord,
  taskId: string,
  review: RunStoredReview,
): RunRecord["assignments"][number] | undefined {
  if (review.assignmentId !== undefined) {
    return record.assignments.find(
      (entry) =>
        entry.assignmentId === review.assignmentId &&
        entry.taskId === taskId &&
        entry.purpose === "reviewer" &&
        entry.agentId === review.reviewerAgentId &&
        entry.seatId === review.reviewerSeatId,
    );
  }
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
  const requirement = requiredReviewRequirement(task);
  if (assignment.tier !== requirement.tier) return false;
  if (requirement.level !== "L1") return true;
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

/** A report must prove one actor, assignment, qualification and current artifact together. */
export function reviewEligible(
  record: RunRecord,
  task: RunTaskRecord,
  review: RunStoredReview,
): boolean {
  return (
    artifactKey(review.reviewedRef) !== null &&
    artifactKey(review.reviewedRef) === artifactKey(task.ref) &&
    isIndependent(review, implementationActors(record, task.spec.id)) &&
    reviewerQualified(record, task, review)
  );
}

/** RE3.2: a done report is evidence only when every contract requirement has a matching item. */
export function checkEvidenceGate(record: RunRecord, taskValue: RunTaskRecord): GateResult {
  const invalid = storedGateIssues(taskValue).filter((issue) => issue.gate === "evidence");
  if (invalid.length > 0) return { ok: false, issues: invalid };
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
  const invalid = storedGateIssues(taskValue).filter((issue) => issue.gate === "review");
  if (invalid.length > 0) return { ok: false, issues: invalid };
  const task = taskValue as RunTaskWithEvidence;
  if (task.ref === null) return fail("review", ["tasks", task.spec.id, "ref"], "missing-ref");
  if (task.reviews !== undefined && !Array.isArray(task.reviews)) {
    return fail("review", ["tasks", task.spec.id, "reviews"], "invalid-reviews");
  }
  const reviews = task.reviews ?? [];
  const current = reviews.filter((review) => {
    if (!isRecord(review)) return false;
    if (typeof review.reviewerAgentId !== "string" || review.reviewerAgentId === "") return false;
    if (typeof review.reviewerSeatId !== "string" || review.reviewerSeatId === "") return false;
    if (artifactKey(review.reviewedRef) !== artifactKey(task.ref)) return false;
    return reviewEligible(record, task, review);
  });
  if (
    current.some(
      (review) =>
        review.verdict !== "可合入" ||
        !Array.isArray(review.blockers) ||
        review.blockers.length !== 0,
    )
  ) {
    return fail("review", ["tasks", task.spec.id, "reviews"], "blocked-review");
  }
  const valid = current.some(
    (review) =>
      review.verdict === "可合入" && Array.isArray(review.blockers) && review.blockers.length === 0,
  );
  return valid ? OK : fail("review", ["tasks", task.spec.id, "reviews"], "no-valid-review");
}

function normalizedAnyPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+/gu, "/").toLowerCase();
}

function realHomeLike(value: string): boolean {
  const path = value.replaceAll("\\", "/").toLowerCase();
  return path.includes("/.paseo") || path.endsWith("/.paseo");
}

function ipv4Number(value: string): number | null {
  const parts = value.split(".");
  if (parts.length === 0 || parts.length > 4) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    if (part === "") return null;
    const parsed = /^0x[0-9a-f]+$/iu.test(part) ? Number.parseInt(part, 16) : Number(part);
    if (!Number.isInteger(parsed) || parsed < 0) return null;
    numbers.push(parsed);
  }
  let result = 0;
  const widths =
    numbers.length === 1
      ? [32]
      : numbers.length === 2
        ? [8, 24]
        : numbers.length === 3
          ? [8, 8, 16]
          : [8, 8, 8, 8];
  for (let index = 0; index < numbers.length; index += 1) {
    const valuePart = numbers[index];
    if (valuePart === undefined) return null;
    const width = widths[index] ?? 8;
    if (valuePart > 2 ** width - 1) return null;
    result = result * 2 ** width + valuePart;
  }
  return result;
}

function ipv4Loopback(value: string): boolean {
  const number = ipv4Number(value);
  if (number === null) return false;
  const first = Math.floor(number / 2 ** 24);
  return first === 127 || number === 0;
}

function ipv6Groups(value: string): number[] | null {
  const zone = value.split("%")[0] ?? value;
  const halves = zone.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const piece of part.split(":")) {
      if (piece === "") return [];
      if (piece.includes(".")) {
        const number = ipv4Number(piece);
        if (number === null) return [];
        groups.push(Math.floor(number / 65536), number % 65536);
      } else {
        if (!/^[0-9a-f]{1,4}$/iu.test(piece)) return [];
        groups.push(Number.parseInt(piece, 16));
      }
    }
    return groups;
  };
  const left = parse(halves[0] ?? "");
  const right = parse(halves[1] ?? "");
  if (left.length === 0 && right.length === 0 && halves.length === 1)
    return [0, 0, 0, 0, 0, 0, 0, 0];
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function ipv6Loopback(value: string): boolean {
  const groups = ipv6Groups(value);
  if (groups === null) return false;
  const isZero = groups.every((group) => group === 0);
  if (isZero) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
  return (
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff &&
    groups[6] !== undefined &&
    groups[7] !== undefined &&
    ipv4Loopback(`${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`)
  );
}

function canonicalDevHost(value: string): string | null {
  let raw = value.trim().toLowerCase();
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//u, "");
  raw = raw.split(/[/?#]/u)[0] ?? raw;
  let parsed: URL;
  try {
    parsed = new URL(`http://${raw}`);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  // URL canonicalizes IPv4 aliases (including octal) and numeric ports. Preserve an explicit
  // port 80, which URL omits as the default for our parsing scheme; absent ports mean Paseo 6767.
  const explicitPort = /:(\d+)$/u.exec(raw)?.[1];
  const port = parsed.port || (explicitPort === undefined ? "6767" : String(Number(explicitPort)));
  const loopback =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "ip6-localhost" ||
    (host.includes(":") ? ipv6Loopback(host) : ipv4Loopback(host));
  return `${loopback ? "loopback" : host}:${port}`;
}

function defaultDevHost(value: string): boolean {
  return canonicalDevHost(value) === "loopback:6767";
}

/** RE3.4: only the pre-registered dedicated DEV target may pass a smoke report. */
export function checkSmokeGate(record: RunRecord, taskValue: RunTaskRecord): GateResult {
  const task = taskValue as RunTaskWithEvidence;
  if (!task.spec.devSmoke) return OK;
  const invalid = storedGateIssues(taskValue).filter((issue) => issue.gate === "smoke");
  if (invalid.length > 0) return { ok: false, issues: invalid };
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
    canonicalDevHost(report.devHost) === null ||
    canonicalDevHost(target.host) === null ||
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

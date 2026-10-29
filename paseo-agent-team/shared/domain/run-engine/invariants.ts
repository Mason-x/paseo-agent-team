import { type RunRecord, RunRecordSchema } from "../../schemas/run-engine/ledger";
import { checkEvidenceGate, checkReviewGate, checkSmokeGate, storedGateIssues } from "./gates";
import { lockConflicts, normalizeLogicalPath } from "./locks";
import { assignmentPhase, dispatchIntentMatches, RUN_COUNTER_EVENTS } from "./transitions";

export type RunInvariantId = "I1" | "I2" | "I3" | "I4" | "I5" | "I6" | "I7" | "I8";

export type RunInvariantViolation = {
  invariant: RunInvariantId;
  path: readonly (string | number)[];
  params: Record<string, string | number | boolean>;
};

export type RunInvariantReport =
  | { ok: true }
  | { ok: false; violations: readonly RunInvariantViolation[] };

function violation(
  invariant: RunInvariantId,
  path: readonly (string | number)[],
  reason: string,
  extra: Record<string, string | number | boolean> = {},
): RunInvariantViolation {
  return { invariant, path, params: { reason, ...extra } };
}

function taskMap(record: RunRecord): Map<string, RunRecord["tasks"][number]> {
  return new Map(record.tasks.map((task) => [task.spec.id, task]));
}

function checkI1(record: unknown): RunInvariantViolation[] {
  const parsed = RunRecordSchema.safeParse(record);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) =>
      violation(
        "I1",
        issue.path.map((part) => (typeof part === "number" ? part : String(part))),
        "record-schema",
      ),
    );
  }
  const value = parsed.data as RunRecord & { writeState?: unknown; rawBytes?: unknown };
  const issues: RunInvariantViolation[] = [];
  if (value.writeState !== undefined && value.writeState !== "committed") {
    issues.push(violation("I1", ["writeState"], "uncommitted-write"));
  }
  if (value.rawBytes !== undefined) {
    issues.push(violation("I1", ["rawBytes"], "partial-bytes"));
  }
  const checkpointSeq = value.checkpoint?.throughSeq ?? 0;
  const seen = new Set<number>();
  let previous = checkpointSeq;
  for (const [index, event] of value.events.entries()) {
    if (seen.has(event.seq) || event.seq <= previous) {
      issues.push(violation("I1", ["events", index, "seq"], "non-monotonic-seq"));
    }
    if (event.seq !== previous + 1) {
      issues.push(
        violation("I1", ["events", index, "seq"], "non-contiguous-seq", {
          expected: previous + 1,
        }),
      );
    }
    seen.add(event.seq);
    previous = Math.max(previous, event.seq);
  }
  if (value.counters.eventsThroughSeq !== previous) {
    issues.push(
      violation("I1", ["counters", "eventsThroughSeq"], "events-through-mismatch", {
        expected: previous,
        actual: value.counters.eventsThroughSeq,
      }),
    );
  }
  return issues;
}

function checkI2(record: RunRecord): RunInvariantViolation[] {
  const tasks = taskMap(record);
  const issues: RunInvariantViolation[] = [];
  const color = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): void => {
    const state = color.get(id) ?? 0;
    if (state === 1) {
      issues.push(violation("I2", ["tasks", id, "deps"], "cycle"));
      return;
    }
    if (state === 2) return;
    color.set(id, 1);
    const task = tasks.get(id);
    if (task) {
      for (const dep of task.spec.deps) {
        if (!tasks.has(dep)) {
          issues.push(violation("I2", ["tasks", id, "deps"], "unknown-dependency", { dep }));
        } else {
          visit(dep);
        }
      }
    }
    color.set(id, 2);
  };
  for (const task of record.tasks) visit(task.spec.id);
  const activeDeps = new Set(["assigned", "in_progress", "review", "rework"]);
  for (const task of record.tasks) {
    if (task.state !== "ready" && !activeDeps.has(task.state)) continue;
    const unfinished = task.spec.deps.filter((dep) => tasks.get(dep)?.state !== "done");
    if (unfinished.length > 0) {
      issues.push(
        violation(
          "I2",
          ["tasks", task.spec.id, "deps"],
          task.state === "ready"
            ? "ready-with-unfinished-dependency"
            : "active-with-unfinished-dependency",
          { dep: unfinished[0] ?? "" },
        ),
      );
    }
  }
  return issues;
}

function claimConflicts(
  a: RunRecord["resources"][number],
  b: RunRecord["resources"][number],
): boolean {
  return a.taskId !== b.taskId && lockConflicts(a, b) !== "none";
}

function checkI3(record: RunRecord): RunInvariantViolation[] {
  const tasks = taskMap(record);
  const issues: RunInvariantViolation[] = [];
  const allowed = new Set(["assigned", "in_progress", "review", "rework", "blocked", "failed"]);
  for (const [index, claim] of record.resources.entries()) {
    const task = tasks.get(claim.taskId);
    if (!task) {
      issues.push(violation("I3", ["resources", index], "unknown-task"));
      continue;
    }
    if (task.state === "done" || task.state === "cancelled") {
      issues.push(
        violation("I3", ["resources", index], "terminal-holds-claim", { taskId: claim.taskId }),
      );
    } else if (!allowed.has(task.state)) {
      issues.push(
        violation("I3", ["resources", index], "inactive-holds-claim", { taskId: claim.taskId }),
      );
    }
    if ((task.state === "blocked" || task.state === "failed") && !claim.frozen) {
      issues.push(violation("I3", ["resources", index], `${task.state}-unfrozen-claim`));
    }
    if (task.state === "blocked" && claim.frozen && task.phase !== "frozen") {
      issues.push(violation("I3", ["tasks", task.spec.id, "phase"], "blocked-frozen-phase"));
    }
    if (claim.kind === "file" || claim.kind === "directory") {
      if (!normalizeLogicalPath(claim.path).ok) {
        issues.push(violation("I3", ["resources", index, "path"], "invalid-path"));
      }
    }
    for (const [otherIndex, other] of record.resources.entries()) {
      if (otherIndex <= index) continue;
      if (claimConflicts(claim, other)) {
        issues.push(
          violation("I3", ["resources", otherIndex], "overlapping-claim", {
            taskId: other.taskId,
          }),
        );
      }
    }
  }
  for (const task of record.tasks) {
    const frozenIds = record.resources
      .filter((claim) => claim.taskId === task.spec.id && claim.frozen)
      .map((claim) => claim.claimId);
    if (task.frozenClaimId !== null && !frozenIds.includes(task.frozenClaimId)) {
      issues.push(
        violation("I3", ["tasks", task.spec.id, "frozenClaimId"], "frozen-claim-mismatch"),
      );
    }
  }
  return issues;
}

const EXECUTION_STATES = new Set(["assigned", "in_progress", "rework"]);

export function occupiesExecutionSlot(
  record: RunRecord,
  task: RunRecord["tasks"][number],
): boolean {
  if (EXECUTION_STATES.has(task.state)) return true;
  if (task.state !== "blocked" && task.state !== "failed") return false;
  return record.resources.some((claim) => claim.taskId === task.spec.id);
}

function checkI4(record: RunRecord): RunInvariantViolation[] {
  const active = record.tasks.filter((task) => occupiesExecutionSlot(record, task)).length;
  const frozen = record.tasks.filter(
    (task) =>
      (task.state === "blocked" || task.state === "failed") &&
      record.resources.some((claim) => claim.taskId === task.spec.id),
  ).length;
  const effective = record.policy.configuredConcurrency + frozen;
  if (active > effective) {
    return [
      violation("I4", ["tasks"], "capacity-over-effective", {
        active,
        effective,
        limit: record.policy.configuredConcurrency,
        frozen,
      }),
    ];
  }
  return [];
}

function checkI5(record: RunRecord): RunInvariantViolation[] {
  const issues: RunInvariantViolation[] = [];
  const nonces = new Set<string>();
  const tasks = taskMap(record);
  for (const [index, entry] of record.nonceRegistry.entries()) {
    if (nonces.has(entry.nonce)) {
      issues.push(violation("I5", ["nonceRegistry", index, "nonce"], "replayed-nonce"));
    }
    nonces.add(entry.nonce);
    if (!tasks.has(entry.taskId) || entry.runId !== record.runId) {
      issues.push(violation("I5", ["nonceRegistry", index], "nonce-binding"));
    }
    const assignment = record.assignments.find(
      (candidate) => candidate.assignmentId === entry.assignmentId,
    );
    if (
      assignment &&
      (assignment.nonce !== entry.nonce ||
        entry.phase !== assignmentPhase(assignment) ||
        assignment.taskId !== entry.taskId ||
        assignment.attempt !== entry.attempt ||
        assignment.agentId !== entry.agentId ||
        assignment.seatId !== entry.seatId)
    ) {
      issues.push(violation("I5", ["nonceRegistry", index], "nonce-binding"));
    }
    const task = tasks.get(entry.taskId);
    if (
      entry.revokedAt !== null &&
      task &&
      task.currentAssignmentId === entry.assignmentId &&
      (task.state === "assigned" || task.state === "in_progress" || task.state === "review")
    ) {
      issues.push(violation("I5", ["nonceRegistry", index], "revoked-nonce-active"));
    }
  }
  for (const [index, assignment] of record.assignments.entries()) {
    if (!nonces.has(assignment.nonce)) {
      issues.push(violation("I5", ["assignments", index, "nonce"], "unregistered-nonce"));
    } else if (
      !record.nonceRegistry.some(
        (entry) =>
          entry.nonce === assignment.nonce &&
          entry.runId === record.runId &&
          entry.taskId === assignment.taskId &&
          entry.assignmentId === assignment.assignmentId &&
          entry.attempt === assignment.attempt &&
          entry.phase === assignmentPhase(assignment) &&
          entry.agentId === assignment.agentId &&
          entry.seatId === assignment.seatId,
      )
    ) {
      issues.push(violation("I5", ["assignments", index, "nonce"], "nonce-binding"));
    }
  }
  return issues;
}

function checkI6(record: RunRecord): RunInvariantViolation[] {
  const issues: RunInvariantViolation[] = [];
  for (const counter of ["observationSeq", "probeAttempts", "reopenAttempts"] as const) {
    const baseline = record.checkpoint?.counters[counter] ?? 0;
    if (record.counters[counter] < baseline) {
      issues.push(violation("I6", ["counters", counter], "behind-checkpoint", { count: baseline }));
    }
  }
  const receiptSeq = record.eventReceipts.reduce(
    (highest, receipt) => Math.max(highest, receipt.seq),
    0,
  );
  if (record.counters.observationSeq < receiptSeq) {
    issues.push(
      violation("I6", ["counters", "observationSeq"], "behind-receipts", { count: receiptSeq }),
    );
  }
  const reworkEvents = new Map<string, number>();
  const dispatches = new Map<string, number>();
  for (const event of record.events) {
    const taskId = typeof event.payload.taskId === "string" ? event.payload.taskId : undefined;
    if (taskId === undefined) continue;
    if (event.kind === "rework_started") {
      const count =
        typeof event.payload.count === "number"
          ? event.payload.count
          : (reworkEvents.get(taskId) ?? 0) + 1;
      reworkEvents.set(taskId, Math.max(reworkEvents.get(taskId) ?? 0, count));
    }
    if (event.kind === "task-dispatched") {
      const actor = event.payload.assignment;
      if (actor !== null && typeof actor === "object" && !Array.isArray(actor)) {
        const entry = actor as Record<string, unknown>;
        if (entry.purpose === "reviewer" || entry.purpose === "smoker") continue;
        if (typeof entry.attempt === "number") {
          dispatches.set(taskId, Math.max(dispatches.get(taskId) ?? 0, entry.attempt));
          continue;
        }
      }
      // Older dispatch facts did not carry an assignment. New facts always do.
      dispatches.set(taskId, (dispatches.get(taskId) ?? 0) + 1);
    }
  }
  for (const assignment of record.assignments) {
    if (assignmentPhase(assignment) !== "implementation") continue;
    dispatches.set(
      assignment.taskId,
      Math.max(dispatches.get(assignment.taskId) ?? 0, assignment.attempt),
    );
  }
  for (const nonce of record.nonceRegistry) {
    if (nonce.phase !== "implementation") continue;
    dispatches.set(nonce.taskId, Math.max(dispatches.get(nonce.taskId) ?? 0, nonce.attempt));
  }
  for (const task of record.tasks) {
    const reworks = reworkEvents.get(task.spec.id) ?? 0;
    if (task.reworkCount < reworks) {
      issues.push(
        violation("I6", ["tasks", task.spec.id, "reworkCount"], "behind-events", {
          count: reworks,
        }),
      );
    }
    const dispatchesForTask = dispatches.get(task.spec.id) ?? 0;
    if (task.attempts < dispatchesForTask) {
      issues.push(
        violation("I6", ["tasks", task.spec.id, "attempts"], "behind-events", {
          count: dispatchesForTask,
        }),
      );
    }
    for (const [counter, kind] of Object.entries(RUN_COUNTER_EVENTS)) {
      if (counter === "reworkCount") continue;
      const expected = record.events.reduce(
        (minimum, event) =>
          event.kind === kind &&
          event.payload.taskId === task.spec.id &&
          typeof event.payload.count === "number"
            ? Math.max(minimum, event.payload.count)
            : minimum,
        0,
      );
      const actual = task[counter as keyof typeof RUN_COUNTER_EVENTS];
      if (actual < expected)
        issues.push(
          violation("I6", ["tasks", task.spec.id, counter], "behind-events", { count: expected }),
        );
    }
  }
  return issues;
}

function checkI7(record: RunRecord): RunInvariantViolation[] {
  const issues: RunInvariantViolation[] = [];
  for (const task of record.tasks) {
    const malformed = storedGateIssues(task);
    if (malformed.length > 0) {
      issues.push(
        ...malformed.map((issue) => violation("I7", issue.path, String(issue.params.reason))),
      );
      continue;
    }
    const extension = task as RunRecord["tasks"][number] & Record<string, unknown>;
    if (
      extension.report !== undefined &&
      (typeof extension.report !== "object" || extension.report === null)
    ) {
      issues.push(violation("I7", ["tasks", task.spec.id, "report"], "invalid-report-extension"));
    }
    if (extension.reviews !== undefined && !Array.isArray(extension.reviews)) {
      issues.push(violation("I7", ["tasks", task.spec.id, "reviews"], "invalid-reviews-extension"));
    }
    if (
      extension.smokeReport !== undefined &&
      (typeof extension.smokeReport !== "object" || extension.smokeReport === null)
    ) {
      issues.push(
        violation("I7", ["tasks", task.spec.id, "smokeReport"], "invalid-smoke-extension"),
      );
    }
    if (task.state !== "done") continue;
    const evidence = checkEvidenceGate(record, task);
    if (!evidence.ok) {
      for (const issue of evidence.issues) {
        issues.push(violation("I7", issue.path, String(issue.params.reason ?? "evidence")));
      }
    }
    const review = checkReviewGate(record, task);
    if (!review.ok) {
      for (const issue of review.issues) {
        issues.push(violation("I7", issue.path, String(issue.params.reason ?? "review")));
      }
    }
    const smoke = checkSmokeGate(record, task);
    if (!smoke.ok) {
      for (const issue of smoke.issues) {
        issues.push(violation("I7", issue.path, String(issue.params.reason ?? "smoke")));
      }
    }
  }
  return issues;
}

function checkI8(record: RunRecord): RunInvariantViolation[] {
  const issues: RunInvariantViolation[] = [];
  for (const [index, assignment] of record.assignments.entries()) {
    if (assignment.messageId === null) continue;
    const matches = record.outbox.filter((intent) => dispatchIntentMatches(assignment, intent));
    if (matches.length !== 1) {
      issues.push(
        violation("I8", ["assignments", index], "assignment-without-intent", {
          taskId: assignment.taskId,
        }),
      );
    }
  }
  for (const [index, decision] of record.decisions.entries()) {
    if (
      decision.state === "answered" ||
      !decision.dedupeKey.startsWith("cancel:") ||
      typeof decision.cancelIntentId !== "string"
    )
      continue;
    const intent = record.outbox.find((entry) => entry.id === decision.cancelIntentId);
    const assignment =
      intent && intent.kind !== "probe"
        ? record.assignments.find((entry) => entry.assignmentId === intent.assignmentId)
        : undefined;
    if (
      !intent ||
      (intent.kind !== "archive" && intent.kind !== "wake") ||
      !assignment ||
      intent.taskId !== decision.subjectId ||
      assignment.taskId !== decision.subjectId ||
      intent.recipient !== assignment.agentId
    ) {
      issues.push(violation("I8", ["decisions", index, "cancelIntentId"], "cancel-intent-binding"));
    }
  }
  return issues;
}

/** All violations in fixed order; the first one is not the only answer. */
export function checkLedgerInvariants(record: unknown): RunInvariantReport {
  const parsed = RunRecordSchema.safeParse(record);
  if (!parsed.success) return { ok: false, violations: checkI1(record) };
  const value = parsed.data;
  const violations = [
    ...checkI1(record),
    ...checkI5(value),
    ...checkI2(value),
    ...checkI3(value),
    ...checkI4(value),
    ...checkI6(value),
    ...checkI8(value),
    ...checkI7(value),
  ];
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

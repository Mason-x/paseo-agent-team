import { type RunRecord, RunRecordSchema } from "../../schemas/run-engine/ledger";
import { checkReviewGate, checkSmokeGate } from "./gates";

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

const ACTIVE_STATES = new Set(["assigned", "in_progress", "rework"]);
const CLAIM_STATES = new Set(["assigned", "in_progress", "review", "rework", "blocked", "failed"]);

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+/gu, "/").toLowerCase();
}

function taskMap(record: RunRecord): Map<string, RunRecord["tasks"][number]> {
  return new Map(record.tasks.map((task) => [task.spec.id, task]));
}

function checkI1(record: unknown): RunInvariantViolation[] {
  const parsed = RunRecordSchema.safeParse(record);
  if (!parsed.success) {
    return parsed.error.issues.slice(0, 20).map((issue) =>
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
  const seen = new Set<number>();
  let previous = -1;
  for (const [index, event] of value.events.entries()) {
    if (seen.has(event.seq) || event.seq <= previous) {
      issues.push(violation("I1", ["events", index, "seq"], "non-monotonic-seq"));
    }
    if (event.seq !== index + 1) {
      issues.push(violation("I1", ["events", index, "seq"], "non-contiguous-seq"));
    }
    seen.add(event.seq);
    previous = Math.max(previous, event.seq);
  }
  if (value.counters.eventsThroughSeq > (value.events.at(-1)?.seq ?? 0)) {
    issues.push(violation("I1", ["counters", "eventsThroughSeq"], "ahead-of-events"));
  }
  return issues;
}

function checkI2(record: RunRecord): RunInvariantViolation[] {
  const tasks = taskMap(record);
  const issues: RunInvariantViolation[] = [];
  const visit = (id: string, stack: Set<string>): void => {
    if (stack.has(id)) {
      issues.push(violation("I2", ["tasks", id, "deps"], "cycle"));
      return;
    }
    const task = tasks.get(id);
    if (!task) return;
    const next = new Set(stack).add(id);
    for (const dep of task.spec.deps) {
      if (!tasks.has(dep)) {
        issues.push(violation("I2", ["tasks", id, "deps"], "unknown-dependency", { dep }));
      } else {
        visit(dep, next);
      }
    }
  };
  for (const task of record.tasks) {
    visit(task.spec.id, new Set());
    if (task.state === "ready") {
      const unfinished = task.spec.deps.filter((dep) => tasks.get(dep)?.state !== "done");
      if (unfinished.length > 0) {
        issues.push(
          violation("I2", ["tasks", task.spec.id, "deps"], "ready-with-unfinished-dependency", {
            dep: unfinished[0] ?? "",
          }),
        );
      }
    }
  }
  return issues;
}

function checkI3(record: RunRecord): RunInvariantViolation[] {
  const tasks = taskMap(record);
  const issues: RunInvariantViolation[] = [];
  const keys = new Map<string, string>();
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
    } else if (!CLAIM_STATES.has(task.state)) {
      issues.push(
        violation("I3", ["resources", index], "inactive-holds-claim", { taskId: claim.taskId }),
      );
    } else if (task.state === "blocked" && !claim.frozen) {
      issues.push(violation("I3", ["resources", index], "blocked-unfrozen-claim"));
    }
    if (
      task.state === "blocked" &&
      claim.frozen &&
      task.frozenClaimId !== null &&
      task.frozenClaimId !== claim.claimId
    ) {
      issues.push(
        violation("I3", ["tasks", task.spec.id, "frozenClaimId"], "frozen-claim-mismatch"),
      );
    }
    const key = [claim.repoId, claim.kind, normalizedPath(claim.path), claim.access].join("|");
    const owner = keys.get(key);
    if (owner !== undefined && owner !== claim.taskId) {
      issues.push(
        violation("I3", ["resources", index], "overlapping-claim", { taskId: claim.taskId }),
      );
    }
    keys.set(key, claim.taskId);
  }
  return issues;
}

function checkI4(record: RunRecord): RunInvariantViolation[] {
  const active = record.tasks.filter((task) => ACTIVE_STATES.has(task.state)).length;
  const effective = Math.max(record.policy.configuredConcurrency, active);
  if (active > effective) {
    return [
      violation("I4", ["tasks"], "capacity-over-effective", {
        active,
        effective,
        limit: record.policy.configuredConcurrency,
      }),
    ];
  }
  return [];
}

function checkI5(record: RunRecord): RunInvariantViolation[] {
  const issues: RunInvariantViolation[] = [];
  const nonces = new Set<string>();
  for (const [index, entry] of record.nonceRegistry.entries()) {
    if (nonces.has(entry.nonce)) {
      issues.push(violation("I5", ["nonceRegistry", index, "nonce"], "replayed-nonce"));
    }
    nonces.add(entry.nonce);
  }
  for (const [index, assignment] of record.assignments.entries()) {
    if (!nonces.has(assignment.nonce)) {
      issues.push(violation("I5", ["assignments", index, "nonce"], "unregistered-nonce"));
    }
  }
  return issues;
}

function checkI6(record: RunRecord): RunInvariantViolation[] {
  const issues: RunInvariantViolation[] = [];
  const reworkEvents = new Map<string, number>();
  for (const event of record.events) {
    if (event.kind !== "rework_started") continue;
    const taskId = typeof event.payload.taskId === "string" ? event.payload.taskId : undefined;
    if (taskId !== undefined) reworkEvents.set(taskId, (reworkEvents.get(taskId) ?? 0) + 1);
  }
  for (const task of record.tasks) {
    if (task.reworkCount < (reworkEvents.get(task.spec.id) ?? 0)) {
      issues.push(
        violation("I6", ["tasks", task.spec.id, "reworkCount"], "behind-events", {
          count: reworkEvents.get(task.spec.id) ?? 0,
        }),
      );
    }
  }
  return issues;
}

function checkI7(record: RunRecord): RunInvariantViolation[] {
  const issues: RunInvariantViolation[] = [];
  for (const task of record.tasks) {
    if (task.state !== "done") continue;
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
    const matched = record.outbox.some(
      (intent) =>
        intent.assignmentId === assignment.assignmentId ||
        (intent.taskId === assignment.taskId && intent.kind === "dispatch"),
    );
    if (!matched) {
      issues.push(
        violation("I8", ["assignments", index], "assignment-without-intent", {
          taskId: assignment.taskId,
        }),
      );
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

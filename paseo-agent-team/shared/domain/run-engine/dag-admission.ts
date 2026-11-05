import type { RunRecord } from "../../schemas/run-engine/ledger";
import type { RunTaskDagBlock } from "../../schemas/run-engine/protocol";
import { budgetStatus } from "./budget";
import { smokeChecklistUsable } from "./dispatch-builder";
import { dispatchRequirement, structuralSeats } from "./dispatch-requirement";
import { devEndpoint } from "./gates";
import { normalizeLogicalPath } from "./locks";
import { reviewRequirement } from "./tier";

/**
 * Initial DAG admission (plan 11.5). The coordinator proposes a task graph in a `task-dag` block;
 * nothing in it is trusted until these checks pass. They are the checks that would otherwise show up
 * later as a task that can never be dispatched, reviewed or smoked, so a plan that cannot be
 * executed is refused here, with reasons, instead of freezing halfway through the Run.
 *
 * Pure: the IO-dependent check (real paths inside the repository) lives in `server/run-engine/dag.ts`.
 */

/** The one repository alias a coordinator may write in a scope; mapped to the canonical id. */
export const REPO_ALIAS = "workspace";

/** The roster seat the Engine adds for the coordinator (plan 11.5, decision 1). */
export const COORDINATOR_SEAT_ID = "coordinator";
export const COORDINATOR_DUTY = "coordinate";

/**
 * Where the nonce that authorizes the first DAG is kept: a passthrough field of `launch`, as a
 * digest. The nonce registry cannot hold it (every entry must name a task), and the digest means the
 * ledger never holds a secret a reader could replay.
 */
export type DagControl = { nonceDigest: string; issuedAt: string; acceptedAt: string | null };

export function readDagControl(record: Pick<RunRecord, "launch">): DagControl | null {
  const raw = (record.launch as Record<string, unknown>).dagControl;
  if (typeof raw !== "object" || raw === null) return null;
  const { nonceDigest, issuedAt, acceptedAt } = raw as Record<string, unknown>;
  if (typeof nonceDigest !== "string" || !/^[0-9a-f]{64}$/u.test(nonceDigest)) return null;
  if (typeof issuedAt !== "string") return null;
  if (acceptedAt !== null && typeof acceptedAt !== "string") return null;
  return { nonceDigest, issuedAt, acceptedAt };
}

export function withDagControl(record: RunRecord, control: DagControl): RunRecord {
  const next = structuredClone(record);
  (next.launch as Record<string, unknown>).dagControl = control;
  return next;
}

export type AdmissionIssue = {
  code: string;
  taskId?: string;
  detail?: string;
};

export type DagCheckInput = {
  /** The agent whose timeline carried the block, as the host reported it. */
  agentId: string;
  /** The repository id the Engine derived from the real repository. */
  canonicalRepoId: string;
  /** SHA-256 hex of the block's control nonce; this module has no crypto of its own. */
  nonceDigest: string;
  /** Model family of each roster seat's Profile; `null` or missing = unknown. */
  seatFamilies: ReadonlyMap<string, string | null>;
};

export type DagCheck =
  | { ok: true; block: RunTaskDagBlock }
  | { ok: false; issues: AdmissionIssue[] };

const MAX_ISSUES = 20;

function isAcyclic(tasks: RunTaskDagBlock["tasks"]): boolean {
  const deps = new Map(tasks.map((task) => [task.id, task.deps]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string): boolean => {
    const seen = state.get(id);
    if (seen === "done") return true;
    if (seen === "visiting") return false;
    state.set(id, "visiting");
    for (const dep of deps.get(id) ?? []) if (!visit(dep)) return false;
    state.set(id, "done");
    return true;
  };
  return tasks.every((task) => visit(task.id));
}

export function checkDag(
  record: RunRecord,
  block: RunTaskDagBlock,
  input: DagCheckInput,
): DagCheck {
  const issues: AdmissionIssue[] = [];
  const add = (code: string, taskId?: string, detail?: string) => {
    if (issues.length < MAX_ISSUES)
      issues.push({ code, ...(taskId ? { taskId } : {}), ...(detail ? { detail } : {}) });
  };

  // --- who may propose, and when -------------------------------------------------------------
  if (record.lifecycle !== "bootstrapping" && record.lifecycle !== "awaiting-dag") {
    add("lifecycle", undefined, record.lifecycle);
  }
  if (block.runId !== record.runId) add("run-mismatch");
  if (block.dagRevision !== 1 || block.expectedDagRevision !== 0) add("revision");
  const coordinator = record.roster.find(
    (seat) => seat.seatId === COORDINATOR_SEAT_ID && seat.duties.includes(COORDINATOR_DUTY),
  );
  if (!coordinator || coordinator.agentId === null || coordinator.agentId !== input.agentId) {
    add("sender-not-coordinator");
  }
  const control = readDagControl(record);
  if (!control || control.acceptedAt !== null || control.nonceDigest !== input.nonceDigest) {
    add("control-nonce");
  }
  if (block.cancelTaskIds.length > 0) add("initial-dag-cancels");
  if (block.budgetRequests.length > 0) add("budget-requests-unsupported");

  // --- structure -----------------------------------------------------------------------------
  const ids = new Set<string>();
  for (const task of block.tasks) {
    if (ids.has(task.id)) add("duplicate-task-id", task.id);
    ids.add(task.id);
  }
  for (const task of block.tasks) {
    for (const dep of task.deps) {
      if (dep === task.id) add("self-dependency", task.id);
      else if (!ids.has(dep)) add("unknown-dependency", task.id, dep);
    }
  }
  if (issues.every((issue) => issue.code !== "duplicate-task-id") && !isAcyclic(block.tasks)) {
    add("dependency-cycle");
  }

  // --- each task must be executable with this roster -----------------------------------------
  const families = input.seatFamilies;
  const candidates = (
    task: RunTaskDagBlock["tasks"][number],
    action: "produce" | "review" | "smoke",
  ) => {
    const requirement = dispatchRequirement({ spec: task, escalations: [] }, action);
    if (requirement.kind !== "required") return [];
    return structuralSeats(record.roster, requirement).filter(
      (seat) => seat.seatId !== COORDINATOR_SEAT_ID && seat.agentId !== null,
    );
  };
  const independent = (
    left: { seatId: string; agentId: string | null },
    right: { seatId: string; agentId: string | null },
  ) => left.seatId !== right.seatId && left.agentId !== right.agentId;

  const devTargetUsable = record.policy.devTargets.some(
    (target) => devEndpoint(target.host) !== null,
  );
  const mapped: RunTaskDagBlock["tasks"] = [];
  for (const task of block.tasks) {
    // Irreversible work needs a person's approval, which the Engine does not handle yet.
    if (task.irreversible !== null) add("irreversible-unsupported", task.id);

    const writes = task.scopes.filter((scope) => scope.access === "write");
    if (task.execution === "write" && writes.length === 0)
      add("write-task-without-write-scope", task.id);
    if (task.execution === "read" && writes.length > 0) add("read-task-with-write-scope", task.id);

    const scopes = task.scopes.map((scope) => {
      if (scope.repoId !== input.canonicalRepoId && scope.repoId !== REPO_ALIAS) {
        add("unknown-repository", task.id, scope.repoId);
      }
      if (!normalizeLogicalPath(scope.path).ok) add("invalid-scope-path", task.id, scope.path);
      return { ...scope, repoId: input.canonicalRepoId };
    });

    const evidenceIds = new Set<string>();
    for (const requirement of task.evidence) {
      if (evidenceIds.has(requirement.id)) add("duplicate-evidence-id", task.id, requirement.id);
      evidenceIds.add(requirement.id);
    }

    const producers = candidates(task, "produce");
    if (producers.length === 0) add("no-producer-seat", task.id);
    const reviewers = candidates(task, "review");
    if (reviewers.length === 0) add("no-reviewer-seat", task.id);
    const needsFamily = reviewRequirement({ spec: task, escalations: [] }).level === "L1";
    const reviewable = producers.some((producer) =>
      reviewers.some((reviewer) => {
        if (!independent(producer, reviewer)) return false;
        if (!needsFamily) return true;
        const left = families.get(producer.seatId) ?? null;
        const right = families.get(reviewer.seatId) ?? null;
        return left !== null && right !== null && left !== right;
      }),
    );
    if (producers.length > 0 && reviewers.length > 0 && !reviewable) {
      add(needsFamily ? "no-independent-family-reviewer" : "no-independent-reviewer", task.id);
    }

    if (task.devSmoke) {
      if (!smokeChecklistUsable(task.smokeChecklist)) add("smoke-checklist-invalid", task.id);
      if (!devTargetUsable) add("dev-target-missing", task.id);
      const smokers = candidates(task, "smoke");
      if (smokers.length === 0) add("no-smoker-seat", task.id);
      else if (
        !producers.some((producer) => smokers.some((smoker) => independent(producer, smoker)))
      ) {
        add("no-independent-smoker", task.id);
      }
    }
    mapped.push({ ...task, scopes });
  }

  // --- the run as a whole --------------------------------------------------------------------
  for (const seat of record.roster) {
    if (!seat.enabled || seat.seatId === COORDINATOR_SEAT_ID) continue;
    if (budgetStatus(record, seat.seatId) === null) add("budget-missing", undefined, seat.seatId);
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, block: { ...block, tasks: mapped } };
}

/** One line a person can read on the Runs page; stored as an alert summary (at most 1000 chars). */
export function describeIssues(issues: readonly AdmissionIssue[]): string {
  const lines = issues.map((issue) =>
    [issue.code, issue.taskId, issue.detail].filter((part) => part !== undefined).join(":"),
  );
  const text = `DAG 被拒：${lines.join("；")}`;
  return text.length <= 1000 ? text : `${text.slice(0, 997)}...`;
}

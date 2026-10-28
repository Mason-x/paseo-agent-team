import type { RunRecord } from "../../schemas/run-engine/ledger";

export type WakeCategory = "D1" | "D2" | "D3" | "D4" | "D5" | "D6" | "D7";

export type WakeRequest = {
  category: WakeCategory;
  subjectId: string | null;
  taskId: string | null;
  dedupeKey: string;
  source: "decision" | "task-failed" | "budget" | "run-finished";
};

export type WakeContext = {
  /** Frozen policy epoch; part of the dedupe identity. */
  policyEpoch: string;
};

/** Stable identity: run + category + reason entity + policy epoch. */
export function wakeKey(
  runId: string,
  category: WakeCategory,
  subjectId: string | null,
  policyEpoch: string,
): string {
  return `${runId}:${category}:${subjectId ?? "-"}:${policyEpoch}`;
}

function addWake(
  requests: Map<string, WakeRequest>,
  runId: string,
  category: WakeCategory,
  subjectId: string | null,
  taskId: string | null,
  source: WakeRequest["source"],
  policyEpoch: string,
): void {
  const dedupeKey = wakeKey(runId, category, subjectId, policyEpoch);
  if (requests.has(dedupeKey)) return;
  requests.set(dedupeKey, { category, subjectId, taskId, dedupeKey, source });
}

/**
 * Wake only on the state delta, never on the event union (R3b-4): new open decisions, an S-tier
 * task becoming failed, a budget becoming exhausted, or the run finishing. Ordinary progress,
 * rework, escalation, evidence returns and lock waits produce nothing.
 */
export function classifyWake(
  prev: Pick<RunRecord, "runId" | "decisions" | "tasks" | "budgets" | "lifecycle">,
  next: Pick<RunRecord, "runId" | "decisions" | "tasks" | "budgets" | "lifecycle">,
  ctx: WakeContext,
): readonly WakeRequest[] {
  const requests = new Map<string, WakeRequest>();
  const knownDecisions = new Set(prev.decisions.map((decision) => decision.decisionId));
  for (const decision of next.decisions) {
    if (knownDecisions.has(decision.decisionId)) continue;
    if (decision.state !== "open" && decision.state !== "waiting-human") continue;
    addWake(
      requests,
      next.runId,
      decision.category,
      decision.subjectId ?? decision.decisionId,
      null,
      "decision",
      ctx.policyEpoch,
    );
  }

  const prevTasks = new Map(prev.tasks.map((task) => [task.spec.id, task]));
  for (const task of next.tasks) {
    const before = prevTasks.get(task.spec.id);
    if (before?.state === "failed" || task.state !== "failed" || task.spec.tier !== "S") continue;
    addWake(requests, next.runId, "D3", task.spec.id, task.spec.id, "task-failed", ctx.policyEpoch);
  }

  const prevBudgets = new Map(
    prev.budgets.entries.map((entry) => [`${entry.scope}:${entry.subjectId}`, entry]),
  );
  for (const entry of next.budgets.entries) {
    const before = prevBudgets.get(`${entry.scope}:${entry.subjectId}`);
    if (before !== undefined && !(before.reserved < entry.limit && entry.reserved >= entry.limit)) {
      continue;
    }
    if (before === undefined && entry.reserved < entry.limit) continue;
    if (entry.reserved >= entry.limit) {
      addWake(requests, next.runId, "D4", entry.subjectId, null, "budget", ctx.policyEpoch);
    }
  }

  if (prev.lifecycle !== "finished" && next.lifecycle === "finished") {
    addWake(requests, next.runId, "D6", null, null, "run-finished", ctx.policyEpoch);
  }

  return [...requests.values()].sort((left, right) =>
    left.dedupeKey.localeCompare(right.dedupeKey),
  );
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= maxBytes) return value;
  let end = value.length;
  while (end > 0 && encoder.encode(value.slice(0, end)).length > maxBytes) end -= 1;
  return value.slice(0, end);
}

/**
 * Bounded, sanitized summary. It uses ledger facts only; it never copies a Worker report, nonce or
 * payload. The caller persists the decision/outbox entry; this function only returns text.
 */
export function buildWakeSummary(
  request: WakeRequest,
  record: Pick<RunRecord, "tasks" | "budgets" | "decisions">,
): string {
  const lines: string[] = [`${request.category} 需要处理`];
  if (request.taskId !== null) {
    const task = record.tasks.find((entry) => entry.spec.id === request.taskId);
    if (task) {
      lines.push(`任务 ${task.spec.id}「${task.spec.title}」状态=${task.state}`);
      lines.push(`尝试=${task.attempts} 返工=${task.reworkCount} 质量失败=${task.qualityFailures}`);
    }
  }
  if (request.source === "budget" && request.subjectId !== null) {
    const entry = record.budgets.entries.find(
      (candidate) => candidate.subjectId === request.subjectId,
    );
    if (entry) lines.push(`预算 ${entry.reserved}/${entry.limit}，已耗尽`);
  }
  if (request.source === "decision") {
    const decision = record.decisions.find(
      (candidate) => candidate.decisionId === request.subjectId,
    );
    if (decision) lines.push(`决策点 ${decision.category}`);
  }
  lines.push("选项：检查后重试；提供决定；取消");
  return truncateUtf8(lines.join("\n"), 4096);
}

import type { RunRecord } from "../../schemas/run-engine/ledger";
import { budgetKey } from "./budget";
import { executionTier } from "./tier";

export type WakeCategory = "D1" | "D2" | "D3" | "D4" | "D5" | "D6" | "D7";

export type WakeRequest = {
  category: WakeCategory;
  subjectId: string | null;
  taskId: string | null;
  /** Source identity is separate from the reason entity used for deduplication. */
  decisionId: string | null;
  budget: Pick<RunRecord["budgets"]["entries"][number], "scope" | "subjectId"> | null;
  dedupeKey: string;
  source: "decision" | "budget" | "run-finished";
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
  // JSON array avoids delimiter ambiguity when subjectId/epoch contain ":".
  return JSON.stringify([runId, category, subjectId, policyEpoch]);
}

function addWake(
  requests: Map<string, WakeRequest>,
  runId: string,
  policyEpoch: string,
  request: Omit<WakeRequest, "dedupeKey">,
): void {
  const dedupeKey = wakeKey(runId, request.category, request.subjectId, policyEpoch);
  if (requests.has(dedupeKey)) return;
  requests.set(dedupeKey, { ...request, dedupeKey });
}

/**
 * Wake only on the state delta, never on the event union (R3b-4): new open decisions, a budget
 * becoming exhausted, or the run finishing. D3 comes only from the reducer's decision, never
 * from a failed task state (which may describe a first rework or an infrastructure failure).
 */
export function classifyWake(
  prev: Pick<RunRecord, "runId" | "decisions" | "tasks" | "budgets" | "lifecycle">,
  next: Pick<RunRecord, "runId" | "decisions" | "tasks" | "budgets" | "lifecycle">,
  ctx: WakeContext,
): readonly WakeRequest[] {
  const requests = new Map<string, WakeRequest>();
  const knownDecisions = new Set(prev.decisions.map((decision) => decision.decisionId));
  const newDecisions = next.decisions.filter(
    (decision) =>
      !knownDecisions.has(decision.decisionId) &&
      (decision.state === "open" || decision.state === "waiting-human"),
  );
  for (const decision of newDecisions) {
    const taskId = next.tasks.find((task) => task.spec.id === decision.subjectId)?.spec.id ?? null;
    const base = {
      category: decision.category,
      subjectId: decision.subjectId ?? decision.decisionId,
      taskId,
      decisionId: decision.decisionId,
      budget: null,
      source: "decision" as const,
    };
    // Canonical D4 subjects use budgetKey. A legacy bare subject can name multiple budgets:
    // keep every matching scope rather than silently selecting the first one.
    const canonical =
      decision.category === "D4"
        ? next.budgets.entries.filter((entry) => budgetKey(entry) === decision.subjectId)
        : [];
    const budgets =
      canonical.length > 0
        ? canonical
        : decision.category === "D4"
          ? next.budgets.entries.filter((entry) => entry.subjectId === decision.subjectId)
          : [];
    if (budgets.length === 0) {
      addWake(requests, next.runId, ctx.policyEpoch, base);
    } else {
      for (const entry of budgets) {
        addWake(requests, next.runId, ctx.policyEpoch, {
          ...base,
          subjectId: budgetKey(entry),
          budget: { scope: entry.scope, subjectId: entry.subjectId },
        });
      }
    }
  }

  const prevBudgets = new Map(prev.budgets.entries.map((entry) => [budgetKey(entry), entry]));
  for (const entry of next.budgets.entries) {
    const before = prevBudgets.get(budgetKey(entry));
    if (before !== undefined && !(before.reserved < entry.limit && entry.reserved >= entry.limit)) {
      continue;
    }
    if (before === undefined && entry.reserved < entry.limit) continue;
    if (entry.reserved >= entry.limit) {
      addWake(requests, next.runId, ctx.policyEpoch, {
        category: "D4",
        subjectId: budgetKey(entry),
        taskId: null,
        decisionId: null,
        budget: { scope: entry.scope, subjectId: entry.subjectId },
        source: "budget",
      });
    }
  }

  if (prev.lifecycle !== "finished" && next.lifecycle === "finished") {
    addWake(requests, next.runId, ctx.policyEpoch, {
      category: "D6",
      subjectId: null,
      taskId: null,
      decisionId: null,
      budget: null,
      source: "run-finished",
    });
  }

  return [...requests.values()].sort((left, right) =>
    left.dedupeKey < right.dedupeKey ? -1 : left.dedupeKey > right.dedupeKey ? 1 : 0,
  );
}

/** Whole-code-point truncation: never leaves an unpaired UTF-16 surrogate. */
export function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= maxBytes) return value;
  let used = 0;
  let result = "";
  for (const char of value) {
    const bytes = encoder.encode(char).length;
    if (used + bytes > maxBytes) break;
    result += char;
    used += bytes;
  }
  return result;
}

function cleanText(value: string): string {
  let folded = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    const bidi = /\p{Bidi_Control}/u.test(char);
    folded += control || bidi ? " " : char;
  }
  return folded.replace(/\s+/gu, " ").trim();
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
  const decision = record.decisions.find((entry) => entry.decisionId === request.decisionId);
  if (decision) lines.push(`决策点 ${decision.category}`);
  let goal: string | null = null;
  if (request.taskId !== null) {
    const task = record.tasks.find((entry) => entry.spec.id === request.taskId);
    if (task) {
      lines.push(
        `任务 ${cleanText(task.spec.id)}「${cleanText(task.spec.title)}」状态=${task.state} 当前层=${executionTier(task)}`,
      );
      lines.push(`尝试=${task.attempts} 返工=${task.reworkCount} 质量失败=${task.qualityFailures}`);
      if (task.ref) lines.push(`证据引用 ${task.ref.kind}:${cleanText(task.ref.value)}`);
      goal = cleanText(task.spec.goal);
    }
  }
  const budget = request.budget;
  if (budget !== null) {
    const entry = record.budgets.entries.find(
      (candidate) => candidate.scope === budget.scope && candidate.subjectId === budget.subjectId,
    );
    if (entry) lines.push(`预算 ${cleanText(budgetKey(entry))} ${entry.reserved}/${entry.limit}`);
  }
  if (goal !== null) lines.push(`目标：${goal}`);
  const options = "\n选项：检查后重试；提供决定；取消";
  return truncateUtf8(lines.join("\n"), 4096 - new TextEncoder().encode(options).length) + options;
}

import type { z } from "zod";
import type { RunBudgetEntrySchema, RunRecord } from "../../schemas/run-engine/ledger";

type RunBudgetEntry = z.infer<typeof RunBudgetEntrySchema>;

export type BudgetStatus = {
  entry: RunBudgetEntry;
  ratio: number;
  /** ceil(80%) threshold already reached; the caller decides whether it has been announced. */
  threshold: "80" | "100" | null;
};

export type BudgetWarning = {
  threshold: "80" | "100";
  revision: number;
  /** 80% and 100% were crossed by this reservation; emit one D4, not two. */
  merged: boolean;
};

export type BudgetPredebit =
  | { status: "reserved"; entry: RunBudgetEntry; warning: BudgetWarning | null }
  | { status: "already-counted" }
  | { status: "exhausted"; reason: "limit" | "missing" | "invalid"; entry?: RunBudgetEntry };

export type PredebitRequest = {
  seatId: string;
  intentKey: string;
  messageId: string;
  /** Number of turn-triggering intents this reservation covers (normally 1). */
  amount: number;
  /** Record revision used for the once-per-revision warning. */
  revision: number;
};

export function budgetKey(entry: Pick<RunBudgetEntry, "scope" | "subjectId">): string {
  return `${entry.scope}:${entry.subjectId}`;
}

function findSeatBudget(
  record: Pick<RunRecord, "policy" | "budgets">,
  seatId: string,
): RunBudgetEntry | undefined {
  return (
    record.budgets.entries.find((entry) => entry.scope === "seat" && entry.subjectId === seatId) ??
    record.policy.seatBudgets.find((entry) => entry.scope === "seat" && entry.subjectId === seatId)
  );
}

function thresholdOf(limit: number, reserved: number): "80" | "100" | null {
  if (limit > 0 && reserved >= limit) return "100";
  if (limit > 0 && reserved >= Math.ceil(limit * 0.8)) return "80";
  return null;
}

export function budgetStatus(
  record: Pick<RunRecord, "policy" | "budgets">,
  seatId: string,
): BudgetStatus | null {
  const entry = findSeatBudget(record, seatId);
  if (!entry) return null;
  const ratio = entry.limit === 0 ? (entry.reserved > 0 ? 1 : 0) : entry.reserved / entry.limit;
  return { entry, ratio, threshold: thresholdOf(entry.limit, entry.reserved) };
}

/** The intent was already committed (same message or idempotency key); never debit twice. */
function alreadyCounted(record: Pick<RunRecord, "outbox">, request: PredebitRequest): boolean {
  return record.outbox.some(
    (intent) =>
      intent.messageId === request.messageId || intent.idempotencyKey === request.intentKey,
  );
}

/**
 * Pure reservation draft (Q1): the returned entry is a complete, schema-valid RunBudgetEntry with
 * reserved already increased. It generates no ID/time/event and does not mutate the record.
 */
export function predebit(
  record: Pick<RunRecord, "budgets" | "policy" | "outbox">,
  request: PredebitRequest,
): BudgetPredebit {
  if (!Number.isInteger(request.amount) || request.amount <= 0) {
    return { status: "exhausted", reason: "invalid" };
  }
  if (alreadyCounted(record, request)) return { status: "already-counted" };
  const entry = findSeatBudget(record, request.seatId);
  if (!entry) return { status: "exhausted", reason: "missing" };
  if (entry.reserved + request.amount > entry.limit) {
    return { status: "exhausted", reason: "limit", entry };
  }
  const reserved = entry.reserved + request.amount;
  const next: RunBudgetEntry = { ...entry, reserved };
  const oldThreshold = thresholdOf(entry.limit, entry.reserved);
  const newThreshold = thresholdOf(entry.limit, reserved);
  const warning =
    newThreshold !== null && newThreshold !== oldThreshold
      ? {
          threshold: newThreshold,
          revision: request.revision,
          merged: newThreshold === "100" && oldThreshold === null,
        }
      : null;
  return { status: "reserved", entry: next, warning };
}

import type { z } from "zod";
import type { RunBudgetEntrySchema, RunRecord } from "../../schemas/run-engine/ledger";
import { resolveAlerts } from "./run-alert";

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

// --- more turns for a seat, by a person's request (A6) --------------------------------------------------

export const BUDGET_LIMIT_MAX = 1024;
export const BUDGET_INCREASED_EVENT = "budget-increased";

/** The alert a seat whose turn budget ran out gets; the numbers make a new limit a new alert. */
export function budgetExhaustedAlertPrefix(seatId: string): string {
  return `席位 ${seatId} 的回合预算已用完`;
}

export function budgetExhaustedAlert(seatId: string, reserved: number, limit: number): string {
  return `${budgetExhaustedAlertPrefix(seatId)}（已预留 ${reserved}/${limit}）。在 Runs 页追加预算后会继续。`;
}

export type BudgetIncrease = {
  seatId: string;
  by: number;
  requestId: string;
  /** The revision the caller read; a different one now is `revision-conflict`. */
  expectedRevision: number;
  reason: string;
  now: string;
};

export type BudgetRefusal =
  | { code: "revision-conflict"; current: number }
  | { code: "request-id-reused" }
  | { code: "lifecycle-not-allowed"; lifecycle: string }
  | { code: "seat-missing" }
  | { code: "budget-missing" }
  | { code: "budget-cap"; max: number };

export type BudgetIncreaseResult =
  | { ok: true; replayed: false; next: RunRecord; limit: number }
  | { ok: true; replayed: true; limit: number | null }
  | ({ ok: false } & BudgetRefusal);

/**
 * Gives a seat more turns. The checks run in the usual order: a request with this id already
 * written (the same one is `replayed`, another one under the same id is `request-id-reused`), the
 * revision, then what the Run allows. The frozen policy is never touched: the new limit is written to
 * `budgets.entries`, which the reservations already read first. The seat's exhaustion alert, if any, is
 * resolved. A pure function that writes an audit event; the reducer's vocabulary is not extended.
 */
export function increaseSeatBudget(
  record: RunRecord,
  input: BudgetIncrease,
  cancelAsked: boolean,
): BudgetIncreaseResult {
  const reason = input.reason.slice(0, 200);
  const prior = record.events.find(
    (event) => event.kind === BUDGET_INCREASED_EVENT && event.payload.requestId === input.requestId,
  );
  if (prior !== undefined) {
    const same =
      prior.payload.seatId === input.seatId &&
      prior.payload.by === input.by &&
      prior.payload.reason === reason;
    if (!same) return { ok: false, code: "request-id-reused" };
    const after = prior.payload.limitAfter;
    return { ok: true, replayed: true, limit: typeof after === "number" ? after : null };
  }
  if (record.revision !== input.expectedRevision) {
    return { ok: false, code: "revision-conflict", current: record.revision };
  }
  if (record.lifecycle === "finished" || record.lifecycle === "cancelled" || cancelAsked) {
    return { ok: false, code: "lifecycle-not-allowed", lifecycle: record.lifecycle };
  }
  if (!record.roster.some((seat) => seat.seatId === input.seatId)) {
    return { ok: false, code: "seat-missing" };
  }
  const entry = findSeatBudget(record, input.seatId);
  if (!entry) return { ok: false, code: "budget-missing" };
  const limit = entry.limit + input.by;
  if (limit > BUDGET_LIMIT_MAX) return { ok: false, code: "budget-cap", max: BUDGET_LIMIT_MAX };

  const next = structuredClone(record);
  const raised: RunBudgetEntry = { ...entry, limit };
  const index = next.budgets.entries.findIndex(
    (candidate) => candidate.scope === "seat" && candidate.subjectId === input.seatId,
  );
  if (index >= 0) next.budgets.entries[index] = raised;
  else next.budgets.entries.push(raised);
  const seq = next.counters.eventsThroughSeq + 1;
  next.counters.eventsThroughSeq = seq;
  next.events.push({
    seq,
    kind: BUDGET_INCREASED_EVENT,
    at: input.now,
    payload: {
      requestId: input.requestId,
      seatId: input.seatId,
      by: input.by,
      limitBefore: entry.limit,
      limitAfter: limit,
      reason,
    },
  });
  next.updatedAt = input.now;
  const prefix = budgetExhaustedAlertPrefix(input.seatId);
  const resolved = resolveAlerts(next, (alert) => alert.summary.startsWith(prefix), input.now);
  return { ok: true, replayed: false, next: resolved.next, limit };
}

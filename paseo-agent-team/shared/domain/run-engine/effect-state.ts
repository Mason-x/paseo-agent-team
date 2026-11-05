import type { RunEffectIntent, RunRecord } from "../../schemas/run-engine/ledger";

/**
 * Outbox intent bookkeeping. The reducer creates an intent as `prepared` and only ever reads its
 * state afterwards, so the progress of the external call lives here, as small pure transitions on
 * the ledger record. Nothing in this file talks to a host.
 *
 *   prepared ──▶ sending ──▶ confirmed
 *      │            └─────▶ outcome-unknown ──▶ confirmed
 *      └─▶ failed
 *
 * Deliberate gaps, because each would let a message go out twice or hide a lost one:
 * - `sending` never goes back to `prepared`: once `sending` is committed the call may have
 *   happened, so it can only be settled by evidence (`confirmed`) or stay `outcome-unknown`.
 * - `sending` never goes straight to `failed`: a thrown error does not prove non-delivery.
 * - `failed` is only reachable before anything was sent (a payload the program refuses to send).
 * - `confirmed` and `failed` are final.
 */
export type IntentTarget = "sending" | "confirmed" | "outcome-unknown" | "failed";

const ALLOWED: Record<RunEffectIntent["state"], readonly IntentTarget[]> = {
  prepared: ["sending", "failed"],
  sending: ["confirmed", "outcome-unknown"],
  "outcome-unknown": ["confirmed"],
  confirmed: [],
  failed: [],
};

export type IntentTransition =
  | { ok: true; changed: boolean; next: RunRecord }
  | {
      ok: false;
      code: "intent-missing" | "illegal-transition";
      from?: RunEffectIntent["state"];
    };

const MAX_REASON = 120;

/**
 * Moves one intent to `to` and appends an audit event. Asking for the state the intent already has
 * is a no-op (`changed: false`) so a repeated call after a crash is harmless. The record is copied;
 * the caller's value is never mutated. Schema and ledger invariants are checked by the store when
 * the result is committed.
 */
export function transitionIntent(
  record: RunRecord,
  intentId: string,
  to: IntentTarget,
  facts: { now: string; reason?: string },
): IntentTransition {
  const index = record.outbox.findIndex((entry) => entry.id === intentId);
  const current = record.outbox[index];
  if (index < 0 || current === undefined) return { ok: false, code: "intent-missing" };
  if (current.state === to) return { ok: true, changed: false, next: record };
  if (!ALLOWED[current.state].includes(to)) {
    return { ok: false, code: "illegal-transition", from: current.state };
  }

  const next = structuredClone(record);
  const intent = next.outbox[index];
  if (intent === undefined) return { ok: false, code: "intent-missing" };
  intent.state = to;
  if (to === "confirmed") intent.confirmedAt = facts.now;

  const seq = next.counters.eventsThroughSeq + 1;
  next.counters.eventsThroughSeq = seq;
  next.events.push({
    seq,
    kind: `intent-${to}`,
    at: facts.now,
    payload: {
      intentId: intent.id,
      intentKind: intent.kind,
      messageId: intent.messageId,
      ...("taskId" in intent ? { taskId: intent.taskId } : {}),
      ...("assignmentId" in intent && intent.assignmentId !== null
        ? { assignmentId: intent.assignmentId }
        : {}),
      ...(facts.reason ? { reason: facts.reason.slice(0, MAX_REASON) } : {}),
    },
  });
  next.updatedAt = facts.now;
  return { ok: true, changed: true, next };
}

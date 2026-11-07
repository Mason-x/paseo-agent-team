import type { RunEffectIntent, RunRecord } from "../../schemas/run-engine/ledger";
import { COORDINATOR_SEAT_ID, readDagControl } from "./dag-admission";
import { type RepairIssue, trimIssues } from "./report-repair";

/**
 * Asking the coordinator to send its plan again (plan 11.5, decision 5; P05).
 *
 * A `task-dag` block the strict parser refuses (a missing key, a wrong type, broken JSON) used to
 * leave the Run waiting for a DAG with nobody to act on it: the plan request is answered once, and a
 * reply can only be read as the answer to a message the Engine itself sent. So the re-send is one more
 * `wake` to the coordinator, through the outbox like every send, and the reply to it is the next plan
 * to read (`latestSentWake`). Only the form is repaired. A plan the checks refuse for what it says (a
 * seat that does not exist, a path outside the repository, a cycle) is not asked for again: that is a
 * decision for a person (re-plan). A reply with no block at all is not asked for again either: the
 * plan request lets the coordinator say in plain words that it cannot plan, and that is not a fault.
 *
 * Nothing about the control nonce changes. It is not issued again and not spent by a re-send; it is
 * spent only when a DAG is admitted. The intent carries no copy of it: the text is rebuilt from the
 * plan request's own arguments, which is why the intent names that request (`planIntentId`).
 *
 * Bounded by `PLAN_REPAIR_MAX` and by the policy's `perTask.protocolResends` (0 turns it off). The
 * count is the number of re-sends of this plan request in the outbox, so it needs no new field, and a
 * later plan request (a re-plan) starts from zero. Like `noteTask` and `requestReportRepair`, a pure
 * function on the record that writes an audit event; the reducer's vocabulary is not extended.
 */

export const PLAN_REPAIR_PURPOSE = "plan-repair";
export const PLAN_REPAIR_MAX = 1;

const SENT_STATES: readonly string[] = ["sending", "confirmed", "outcome-unknown"];

type Wake = Extract<RunEffectIntent, { kind: "wake" }>;

export function isPlanRequest(intent: RunEffectIntent): intent is Wake {
  return intent.kind === "wake" && intent.semanticArgs.purpose === "plan";
}

export function isPlanRepairWake(intent: RunEffectIntent): intent is Wake {
  return intent.kind === "wake" && intent.semanticArgs.purpose === PLAN_REPAIR_PURPOSE;
}

/** The newest plan request to this agent: the one whose nonce is in force (a re-plan adds a later one). */
export function currentPlanRequest(
  record: Pick<RunRecord, "outbox">,
  agentId: string,
): Wake | undefined {
  return record.outbox.findLast(
    (intent): intent is Wake => isPlanRequest(intent) && intent.recipient === agentId,
  );
}

/**
 * The newest message of the CURRENT plan request that went out to this agent, whose reply is the plan
 * to read: that request or its re-send. A re-send that is only prepared has no reply yet, so it is
 * not it. Messages of an earlier plan request (before a re-plan) are never it, and neither is the
 * current request while it is only prepared: the reply to an old message holds a plan made under a
 * control nonce that no longer counts, and reading it again would only raise the same refusal.
 */
export function latestSentWake(
  record: Pick<RunRecord, "outbox">,
  agentId: string,
): Wake | undefined {
  const plan = currentPlanRequest(record, agentId);
  if (plan === undefined) return undefined;
  return record.outbox.findLast(
    (intent): intent is Wake =>
      intent.kind === "wake" &&
      intent.recipient === agentId &&
      SENT_STATES.includes(intent.state) &&
      (intent.id === plan.id ||
        (isPlanRepairWake(intent) && intent.semanticArgs.planIntentId === plan.id)),
  );
}

/**
 * What a re-plan pins in its plan request (`semanticArgs.replan`) so the text can be rebuilt from the
 * record alone. The operator's note and the program's last refusal are data for the coordinator, never
 * instructions; the request id is what makes asking twice the same request.
 */
export type ReplanFacts = {
  /** Which plan request this is: 2 is the first re-plan. */
  epoch: number;
  requestId: string;
  /** The Run alert that said why the last plan was refused (program text), if one was open. */
  previousRefusal: string | null;
  note: string;
};

export function readReplanFacts(raw: unknown): ReplanFacts | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { epoch, requestId, previousRefusal, note } = raw as Record<string, unknown>;
  if (!Number.isInteger(epoch) || (epoch as number) < 2) return null;
  if (typeof requestId !== "string" || requestId === "" || requestId.length > 128) return null;
  if (previousRefusal !== null && typeof previousRefusal !== "string") return null;
  if (typeof previousRefusal === "string" && previousRefusal.length > 1000) return null;
  if (typeof note !== "string" || note === "" || note.length > 600) return null;
  return { epoch: epoch as number, requestId, previousRefusal, note };
}

/** The re-sends of one plan request, oldest first. */
export function planRepairWakes(record: Pick<RunRecord, "outbox">, planIntentId: string): Wake[] {
  return record.outbox.filter(
    (intent): intent is Wake =>
      isPlanRepairWake(intent) && intent.semanticArgs.planIntentId === planIntentId,
  );
}

export function planRepairLimit(record: Pick<RunRecord, "policy">): number {
  return Math.min(PLAN_REPAIR_MAX, record.policy.perTask.protocolResends);
}

export type PlanRepairRequest = {
  /** The coordinator's agent, as the host reported it. */
  agentId: string;
  /** The message whose reply was read (`latestSentWake` at that time). */
  anchor: string;
  /** Why the plan is not usable, e.g. `plan-rejected:schema-invalid`. */
  reason: string;
  issues: readonly RepairIssue[];
  intentId: string;
  messageId: string;
  payloadHash: string;
  templateVersion: number;
  now: string;
};

export type PlanRepairResult =
  | { ok: true; next: RunRecord; ordinal: number; limit: number }
  | {
      ok: false;
      code: /** The Run is not waiting for its first DAG, or the nonce is spent, or this is not the coordinator. */
        | "not-waiting"
        | "no-plan-request"
        /** The problem was read from an older message than the newest one that went out. */
        | "stale-anchor"
        /** A re-send is prepared and not yet sent: wait for it. */
        | "repair-pending"
        | "limit-reached";
    };

export function requestPlanRepair(record: RunRecord, input: PlanRepairRequest): PlanRepairResult {
  const coordinator = record.roster.find((seat) => seat.seatId === COORDINATOR_SEAT_ID);
  const control = readDagControl(record);
  if (
    (record.lifecycle !== "bootstrapping" && record.lifecycle !== "awaiting-dag") ||
    control === null ||
    control.acceptedAt !== null ||
    !coordinator ||
    coordinator.agentId !== input.agentId
  ) {
    return { ok: false, code: "not-waiting" };
  }
  const plan = currentPlanRequest(record, input.agentId);
  if (!plan) return { ok: false, code: "no-plan-request" };

  const repairs = planRepairWakes(record, plan.id);
  if (repairs.some((intent) => intent.state === "prepared")) {
    return { ok: false, code: "repair-pending" };
  }
  if (latestSentWake(record, input.agentId)?.messageId !== input.anchor) {
    return { ok: false, code: "stale-anchor" };
  }
  const limit = planRepairLimit(record);
  if (repairs.length >= limit) return { ok: false, code: "limit-reached" };

  const ordinal = repairs.length + 1;
  const next = structuredClone(record);
  next.outbox.push({
    id: input.intentId,
    kind: "wake",
    recipient: input.agentId,
    messageId: input.messageId,
    idempotencyKey: `${plan.idempotencyKey}:repair:${ordinal}`,
    payloadHash: input.payloadHash,
    templateVersion: input.templateVersion,
    state: "prepared",
    recoverySendCount: 0,
    createdAt: input.now,
    confirmedAt: null,
    localCancellation: null,
    taskId: plan.taskId,
    assignmentId: null,
    semanticArgs: {
      purpose: PLAN_REPAIR_PURPOSE,
      planIntentId: plan.id,
      ordinal,
      limit,
      reason: input.reason.slice(0, 200),
      issues: trimIssues(input.issues),
    },
  });
  const seq = next.counters.eventsThroughSeq + 1;
  next.counters.eventsThroughSeq = seq;
  next.events.push({
    seq,
    kind: "plan-repair-requested",
    at: input.now,
    payload: {
      intentId: input.intentId,
      planIntentId: plan.id,
      reason: input.reason.slice(0, 200),
      ordinal,
    },
  });
  next.updatedAt = input.now;
  return { ok: true, next, ordinal, limit };
}

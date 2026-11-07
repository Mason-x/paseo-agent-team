import type { RunRecord } from "../../schemas/run-engine/ledger";
import { COORDINATOR_SEAT_ID, readDagControl, withDagControl } from "./dag-admission";
import { transitionIntent } from "./effect-state";
import { currentPlanRequest, isPlanRequest, type ReplanFacts } from "./plan-repair";
import { resolveAlerts } from "./run-alert";

/**
 * Asking the coordinator for a new plan, because the last one was refused (plan 11.5, decision 5: the
 * refusals the Engine does not ask about again are a person's to re-plan; P06).
 *
 * Only a Run that is `awaiting-dag` can be re-planned: it has no task, no assignment and no claim, so
 * nothing running needs to stop and no resource needs to be released. A Run that is already `active`
 * has work in flight and a task graph to revise; that is the `dag-revised` path with its cancellations
 * (the later controls), and this function refuses it.
 *
 * One re-plan is one commit, and it makes a new epoch:
 *  - a new control nonce replaces the old one in `launch.dagControl` (digest only; the text is in the
 *    new plan request's arguments, like the first one), so a plan made under the old nonce is refused
 *    by the digest whatever it says;
 *  - every message of the old epoch that is only prepared (a plan re-send) is failed, because the
 *    executor would otherwise still send it, with the old nonce;
 *  - the old epoch's messages stay in the outbox as they are (sent ones are history), but
 *    `latestSentWake` only looks at the newest plan request, so the old reply is never read again;
 *  - the open "DAG ..." alerts are resolved: they described a plan that no longer counts;
 *  - the Run goes back to `bootstrapping` (a plan request is out, nothing read yet), which is also
 *    what refuses a second re-plan while this one is unanswered; a refusal of the new plan moves it
 *    to `awaiting-dag` again, exactly as for the first;
 *  - the re-send limit counts the re-sends of the newest plan request, so it starts from zero.
 *
 * Asking again with the same `requestId` is the same request: it finds its audit event and answers
 * `replayed` without writing. A pure function like `noteTask` and `transitionIntent`: the reducer's
 * vocabulary is not extended.
 */

export const REPLAN_EVENT = "replan-requested";

/** Alerts raised for a refused plan all start with this; a re-plan resolves the open ones. */
export const DAG_ALERT_PREFIX = "DAG ";

export type ReplanRequest = {
  requestId: string;
  /** The revision the caller read; a different one now is `revision-conflict`. */
  expectedRevision: number;
  reason: string;
  /** Fresh from the caller, with its SHA-256 (shared code has no crypto). */
  controlNonce: string;
  controlNonceDigest: string;
  intentId: string;
  messageId: string;
  /** SHA-256 of the compiled request, filled in by the caller once it is compiled. */
  payloadHash: string;
  templateVersion: number;
  now: string;
};

export type ReplanRefusal =
  | { code: "revision-conflict"; current: number }
  | { code: "request-id-reused" }
  | { code: "replan-not-allowed"; lifecycle: string }
  | { code: "plan-request-missing" }
  | { code: "delivery-unresolved" };

export type ReplanResult =
  | { ok: true; replayed: false; next: RunRecord; epoch: number; intentId: string }
  | { ok: true; replayed: true; epoch: number }
  | ({ ok: false } & ReplanRefusal);

function priorRequest(record: RunRecord, requestId: string) {
  return record.events.find(
    (event) => event.kind === REPLAN_EVENT && event.payload.requestId === requestId,
  );
}

/** The newest refusal text the Run still shows: what the coordinator is told went wrong last time. */
function lastRefusal(record: RunRecord): string | null {
  const alert = record.alerts
    .filter((entry) => entry.state === "open" && entry.summary.startsWith(DAG_ALERT_PREFIX))
    .at(-1);
  return alert?.summary ?? null;
}

export function requestReplan(record: RunRecord, input: ReplanRequest): ReplanResult {
  const reason = input.reason.slice(0, 200);
  const prior = priorRequest(record, input.requestId);
  if (prior !== undefined) {
    // The request id names the request: the same id with another reason is a mistake, not a replay.
    if (prior.payload.reason !== reason) return { ok: false, code: "request-id-reused" };
    return { ok: true, replayed: true, epoch: Number(prior.payload.epoch) };
  }
  if (record.revision !== input.expectedRevision) {
    return { ok: false, code: "revision-conflict", current: record.revision };
  }
  if (record.lifecycle !== "awaiting-dag") {
    return { ok: false, code: "replan-not-allowed", lifecycle: record.lifecycle };
  }
  const control = readDagControl(record);
  const coordinator = record.roster.find((seat) => seat.seatId === COORDINATOR_SEAT_ID);
  if (control === null || control.acceptedAt !== null || !coordinator?.agentId) {
    return { ok: false, code: "replan-not-allowed", lifecycle: record.lifecycle };
  }
  const plan = currentPlanRequest(record, coordinator.agentId);
  if (plan === undefined) return { ok: false, code: "plan-request-missing" };
  // A message to the coordinator whose delivery is not settled may or may not have arrived. Sending a
  // different request over it would answer a question nobody can tell was asked; wait for the echo.
  const toCoordinator = record.outbox.filter(
    (intent) => intent.kind === "wake" && intent.recipient === coordinator.agentId,
  );
  if (
    toCoordinator.some((intent) => intent.state === "sending" || intent.state === "outcome-unknown")
  ) {
    return { ok: false, code: "delivery-unresolved" };
  }

  const epoch = record.outbox.filter(isPlanRequest).length + 1;
  const previousRefusal = lastRefusal(record);

  // The old epoch's messages that would still go out: failed, not removed (the audit trail names them).
  let next = record;
  const superseded: string[] = [];
  for (const intent of toCoordinator) {
    if (intent.state !== "prepared") continue;
    const failed = transitionIntent(next, intent.id, "failed", {
      now: input.now,
      reason: "superseded-by-replan",
    });
    if (!failed.ok) return { ok: false, code: "delivery-unresolved" };
    next = failed.next;
    superseded.push(intent.id);
  }
  next = resolveAlerts(next, (alert) => alert.summary.startsWith(DAG_ALERT_PREFIX), input.now).next;
  // A copy, whatever happened above: the caller's record is never touched.
  next = withDagControl(next, {
    nonceDigest: input.controlNonceDigest,
    issuedAt: input.now,
    acceptedAt: null,
  });

  const facts: ReplanFacts = {
    epoch,
    requestId: input.requestId,
    previousRefusal,
    note: input.reason,
  };
  const { template, seatSnapshot, devTargetUsable, task } = plan.semanticArgs;
  next.outbox.push({
    id: input.intentId,
    kind: "wake",
    recipient: coordinator.agentId,
    messageId: input.messageId,
    idempotencyKey: `plan:${record.runId}:${epoch}`,
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
      template,
      seatSnapshot: structuredClone(seatSnapshot),
      devTargetUsable,
      purpose: "plan",
      task,
      controlNonce: input.controlNonce,
      replan: facts,
    },
  });
  next.lifecycle = "bootstrapping";
  const seq = next.counters.eventsThroughSeq + 1;
  next.counters.eventsThroughSeq = seq;
  next.events.push({
    seq,
    kind: REPLAN_EVENT,
    at: input.now,
    // No nonce, no text: the epoch, the request, the reason and which messages it replaced.
    payload: {
      epoch,
      requestId: input.requestId,
      reason,
      intentId: input.intentId,
      supersededIntentIds: superseded,
    },
  });
  next.updatedAt = input.now;
  return { ok: true, replayed: false, next, epoch, intentId: input.intentId };
}

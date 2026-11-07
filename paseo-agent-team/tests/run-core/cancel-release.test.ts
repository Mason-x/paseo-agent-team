import { describe, expect, test } from "vitest";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import { type ReduceFacts, reduceRun } from "../../shared/domain/run-engine/reducer";
import type { RunReducerEvent } from "../../shared/domain/run-engine/transitions";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import {
  ASSIGNMENT_T2,
  AT_UPDATED,
  dispatchIntent,
  NONCE_T2,
  NORMAL_RUN_LEDGER,
} from "../fixtures/run-engine";

/**
 * A task that a member stopped (`blocked` or `failed`) holds the claim of its sent delivery, and
 * cancelling it used to leave it frozen for ever: with nothing in flight there was no pair to wait
 * for, so nothing ever released the claim. A person's answer to the task's cancel decision is the
 * authorization to release it. Failure modes this file guards:
 *  - a plain cancel releasing a claim that a sent delivery left (that is a designed rule);
 *  - any answer other than `cancel` counting as the authorization;
 *  - releasing while something of the task still runs or is unsettled;
 *  - the release not being bound to the decision that allowed it, or not repeating byte for byte.
 */

let counter = 0;
const facts: ReduceFacts = {
  now: AT_UPDATED,
  newId: () => {
    counter += 1;
    return `90000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  },
  newDecisionNonceDigest: () => "d".repeat(64),
};

function step(record: RunRecord, event: RunReducerEvent): RunRecord {
  const result = reduceRun(record, event, facts);
  if (!result.ok) throw new Error(JSON.stringify(result));
  expect(checkLedgerInvariants(result.next)).toEqual({ ok: true });
  return result.next;
}

const cancel: RunReducerEvent = {
  kind: "cancel-requested",
  taskIds: ["t2"],
  reason: "cancel",
  controlNonceDigest: "9".repeat(64),
  cancelIntents: [],
  preparedCancelIntents: [],
};

const t2 = (record: RunRecord) => {
  const task = record.tasks.find((entry) => entry.spec.id === "t2");
  if (!task) throw new Error("fixture lost t2");
  return task;
};
const claims = (record: RunRecord) => record.resources.filter((claim) => claim.taskId === "t2");
const cancelDecision = (record: RunRecord) => {
  const decision = record.decisions.find((entry) => entry.dedupeKey === "cancel:t2");
  if (!decision) throw new Error("no cancel decision");
  return decision;
};

/** The member stopped with `status`; with `ended` its turn has also ended on a recorded receipt. */
function stopped(status: "blocked" | "failed", ended = true): RunRecord {
  let record = structuredClone(NORMAL_RUN_LEDGER) as RunRecord;
  record = step(record, {
    kind: "turn-started",
    assignmentId: ASSIGNMENT_T2,
    agentId: "agent-b1",
    turnId: "turn-producer",
  });
  record = step(record, {
    kind: "task-report",
    block: {
      protocolVersion: 1,
      runId: NORMAL_RUN_LEDGER.runId,
      taskId: "t2",
      attempt: 1,
      nonce: NONCE_T2,
      assignmentId: ASSIGNMENT_T2,
      status,
      reasonCode: "needs-help",
      summary: "stuck",
      evidence: [],
    },
  } as RunReducerEvent);
  if (!ended) return record;
  const key = "agent-b1|turn-producer|turn_ended";
  record = step(record, {
    kind: "observation-recorded",
    receipt: {
      eventKey: key,
      kind: "turn_ended",
      agentId: "agent-b1",
      turnId: "turn-producer",
      seq: record.counters.observationSeq + 1,
      receivedAt: AT_UPDATED,
      dedupeKey: key,
      disposition: "accepted",
    },
  });
  return step(record, { kind: "turn-ended", assignmentId: ASSIGNMENT_T2, endedEventKey: key });
}

/** What the answer of a person does to the task's cancel decision (the `decision` event is not in the reducer). */
function answered(record: RunRecord, action: "cancel" | "resume-seat"): RunRecord {
  const next = structuredClone(record);
  const decision = cancelDecision(next);
  decision.state = "answered";
  decision.answeredAt = AT_UPDATED;
  decision.answer = { action, taskIds: ["t2"], answeredAt: AT_UPDATED };
  expect(checkLedgerInvariants(next)).toEqual({ ok: true });
  return next;
}

describe.each(["blocked", "failed"] as const)("a %s producer whose turn ended", (status) => {
  test("cancelling without an answer only freezes: the decision is open, no pair, the claim stays", () => {
    const frozen = step(stopped(status), cancel);
    expect(["blocked", "failed"]).toContain(t2(frozen).state);
    expect(claims(frozen).length).toBeGreaterThan(0);
    expect(claims(frozen).every((claim) => claim.frozen)).toBe(true);
    expect(cancelDecision(frozen)).toMatchObject({ state: "open", cancelIntents: [] });
    // Asking again changes nothing that matters.
    const again = step(frozen, cancel);
    expect(t2(again).state).toBe(t2(frozen).state);
    expect(claims(again)).toHaveLength(claims(frozen).length);
  });

  test("after the decision is answered `cancel`, cancelling releases the claim and binds the decision", () => {
    const frozen = step(stopped(status), cancel);
    const released = step(answered(frozen, "cancel"), cancel);
    expect(t2(released).state).toBe("cancelled");
    expect(claims(released)).toEqual([]);
    expect(t2(released).releaseDecisionId).toBe(cancelDecision(released).decisionId);
    expect(
      released.nonceRegistry
        .filter((nonce) => nonce.taskId === "t2")
        .every((nonce) => nonce.revokedAt !== null),
    ).toBe(true);
  });

  test("releasing again changes nothing, byte for byte", () => {
    const released = step(answered(step(stopped(status), cancel), "cancel"), cancel);
    expect(step(released, cancel)).toEqual(released);
  });

  test("another answer is not an authorization: the task stays frozen with its claim", () => {
    const frozen = step(stopped(status), cancel);
    const stays = step(answered(frozen, "resume-seat"), cancel);
    expect(t2(stays).state).not.toBe("cancelled");
    expect(claims(stays).length).toBeGreaterThan(0);
  });

  test("an unsettled message of the task keeps it frozen even when authorized", () => {
    const frozen = answered(step(stopped(status), cancel), "cancel");
    frozen.outbox.push({
      ...dispatchIntent({
        id: "wake-unknown",
        taskId: "t2",
        assignmentId: ASSIGNMENT_T2,
        recipient: "agent-b1",
        messageId: "99999999-9999-4999-8999-999999999999",
        idempotencyKey: "wake-unknown",
        state: "outcome-unknown",
      }),
      kind: "wake",
      semanticArgs: { purpose: "repair" },
    } as RunRecord["outbox"][number]);
    expect(checkLedgerInvariants(frozen)).toEqual({ ok: true });
    const stays = step(frozen, cancel);
    expect(t2(stays).state).not.toBe("cancelled");
    expect(claims(stays).length).toBeGreaterThan(0);
  });
});

test("its turn has not ended: cancelling is refused for want of a pair, nothing is released", () => {
  const record = stopped("blocked", false);
  const result = reduceRun(record, cancel, facts);
  expect(result).toMatchObject({ ok: false, code: "RUN_EVENT_INVALID" });
  expect(t2(record).state).not.toBe("cancelled");
  expect(claims(record).length).toBeGreaterThan(0);
});

test("a frozen task of a cancelled Run is released once its decision is answered", () => {
  let record = stopped("blocked");
  record = step(record, {
    kind: "run-cancelled",
    reason: "cancel",
    controlNonceDigest: "8".repeat(64),
    cancelIntents: [],
    preparedCancelIntents: [],
  });
  expect(record.lifecycle).toBe("cancelled");
  expect(t2(record).state).not.toBe("cancelled");
  const released = step(answered(record, "cancel"), cancel);
  expect(t2(released).state).toBe("cancelled");
  expect(claims(released)).toEqual([]);
});

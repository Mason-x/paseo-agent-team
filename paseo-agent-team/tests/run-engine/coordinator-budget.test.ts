import { describe, expect, test } from "vitest";
import {
  budgetExhaustedAlert,
  budgetExhaustedAlertPrefix,
  increaseSeatBudget,
} from "../../shared/domain/run-engine/budget";
import {
  ensureCoordinatorBudget,
  reserveCoordinatorTurn,
} from "../../shared/domain/run-engine/coordinator-budget";
import { COORDINATOR_SEAT_ID } from "../../shared/domain/run-engine/dag-admission";
import { PLAN_REPLAN_VERSION } from "../../shared/domain/run-engine/engine-prompts";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import { requestReplan } from "../../shared/domain/run-engine/replan";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { bootstrapRun } from "./support/bootstrap-run";
import { askAgain, confirm, prepared, sha256 } from "./support/plan-fixtures";

/**
 * The coordinator's turn budget: the plan request and every re-plan are paid for from one entry of
 * `budgets.entries`, built on the first use. Failure modes this file guards:
 *  - a plan request or a re-plan that is not counted, or counted twice;
 *  - a re-plan that goes out with no turns left, or one that is refused and still changes the Run;
 *  - a Run written before this contract losing the frozen policy, or getting a budget of 0;
 *  - a format re-send of the plan being charged to the person's budget;
 *  - the coordinator's row not being raisable like any other seat's.
 */

const LATER = "2026-11-06T09:00:00.000Z";
const NEW_NONCE = "7a2d3b55-4c8f-4b1b-8b22-0000000000a2";

const entryOf = (record: RunRecord) =>
  record.budgets.entries.find(
    (entry) => entry.scope === "seat" && entry.subjectId === COORDINATOR_SEAT_ID,
  );

/** A Run whose plan request went out and whose plan was refused: it waits for a person. */
function waiting(version: 1 | 2) {
  const { record, intent } = prepared({ schemaVersion: version });
  const sent = confirm(record, intent.id);
  sent.lifecycle = "awaiting-dag";
  return { record: sent, intent };
}

function ask(record: RunRecord, over: Partial<Parameters<typeof requestReplan>[1]> = {}) {
  return requestReplan(record, {
    requestId: "req-1",
    expectedRevision: record.revision,
    reason: "use the workspace alias this time",
    controlNonce: NEW_NONCE,
    controlNonceDigest: sha256(NEW_NONCE),
    intentId: "intent-plan-2",
    messageId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
    payloadHash: "0".repeat(64),
    templateVersion: PLAN_REPLAN_VERSION,
    now: LATER,
    ...over,
  });
}

describe.each([1, 2] as const)("[v%i] the coordinator's turn budget", (version) => {
  test("the plan request is the first turn: the entry takes the policy's limit, one reserved, and nothing else changes", () => {
    const { record } = prepared({ schemaVersion: version });
    const unchanged = bootstrapRun({ runId: "run-plan01-a1" });
    expect(entryOf(record)).toEqual({
      scope: "seat",
      subjectId: "coordinator",
      limit: record.policy.run.strategicTurns,
      reserved: 1,
      confirmed: 0,
      observedTurns: 0,
    });
    expect(record.schemaVersion).toBe(version);
    // The frozen policy is read, never written: the limit lives in the entry.
    expect(record.policy).toEqual(unchanged.policy);
    expect(record.policy.seatBudgets.some((entry) => entry.subjectId === "coordinator")).toBe(
      false,
    );
    expect(checkLedgerInvariants(record).ok).toBe(true);
  });

  test("a re-plan is the next turn: one more reserved, the Run still passes its invariants", () => {
    const { record } = waiting(version);
    const before = structuredClone(record);
    const result = ask(record);
    expect(record).toEqual(before);
    if (!result.ok || result.replayed) throw new Error("the re-plan was not applied");
    expect(entryOf(result.next)).toMatchObject({ limit: 12, reserved: 2 });
    expect(result.next.schemaVersion).toBe(version);
    expect(result.next.policy).toEqual(record.policy);
    expect(checkLedgerInvariants(result.next).ok).toBe(true);
  });

  test("asking again with the same request id is the same request: it answers replayed and counts nothing", () => {
    const { record } = waiting(version);
    const first = ask(record);
    if (!first.ok || first.replayed) throw new Error("the re-plan was not applied");
    const again = ask(first.next);
    expect(again).toEqual({ ok: true, replayed: true, epoch: 2 });
    expect("next" in again).toBe(false);
    expect(entryOf(first.next)?.reserved).toBe(2);
  });

  test("with no turns left a re-plan is refused as budget-exhausted, and the Run is not touched", () => {
    const { record } = waiting(version);
    const entry = entryOf(record);
    if (!entry) throw new Error("no coordinator entry");
    entry.limit = entry.reserved;
    const before = structuredClone(record);
    expect(ask(record)).toEqual({ ok: false, code: "budget-exhausted" });
    expect(record).toEqual(before);
  });

  test("a Run with no entry gets one on first use, counting every plan request it holds, failed ones included", () => {
    const { record, intent } = waiting(version);
    record.budgets.entries = record.budgets.entries.filter(
      (entry) => entry.subjectId !== COORDINATOR_SEAT_ID,
    );
    record.outbox.push({
      ...intent,
      id: "intent-plan-old-failed",
      idempotencyKey: "plan:old:failed",
      messageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb9",
      state: "failed",
    });
    const before = structuredClone(record);
    const based = ensureCoordinatorBudget(record);
    expect(record).toEqual(before);
    expect(based).not.toBe(record);
    expect(entryOf(based)).toEqual({
      scope: "seat",
      subjectId: "coordinator",
      limit: record.policy.run.strategicTurns,
      reserved: 2,
      confirmed: 0,
      observedTurns: 0,
    });
    expect(based.schemaVersion).toBe(version);
    expect(based.policy).toEqual(before.policy);
    expect(based.outbox).toEqual(before.outbox);
    // The second look finds it: the same object comes back.
    expect(ensureCoordinatorBudget(based)).toBe(based);
  });

  test("a format re-send of the plan is not a turn of the budget", () => {
    const { record, intent } = prepared({ schemaVersion: version });
    const sent = confirm(record, intent.id);
    const asked = askAgain(sent);
    if (!asked.ok) throw new Error(`cannot ask again: ${asked.code}`);
    expect(entryOf(asked.next)?.reserved).toBe(1);
    expect(asked.next.outbox.filter((entry) => entry.kind === "wake")).toHaveLength(2);
  });

  test("the coordinator's row is raised like a seat's: the new limit is in the entry, the policy and the alert are not touched", () => {
    const { record } = waiting(version);
    const entry = entryOf(record);
    if (!entry) throw new Error("no coordinator entry");
    entry.limit = entry.reserved;
    const raised = increaseSeatBudget(
      ensureCoordinatorBudget(record),
      {
        seatId: COORDINATOR_SEAT_ID,
        by: 2,
        requestId: "bud-1",
        expectedRevision: record.revision,
        reason: "more",
        now: LATER,
      },
      false,
    );
    if (!raised.ok || raised.replayed) throw new Error("the budget was not raised");
    expect(raised.limit).toBe(entry.reserved + 2);
    expect(entryOf(raised.next)).toMatchObject({ limit: entry.reserved + 2 });
    expect(raised.next.policy).toEqual(record.policy);
    expect(ask(raised.next).ok).toBe(true);
  });
});

describe("reserveCoordinatorTurn", () => {
  test("reserves one turn under its own key, once", () => {
    const { record } = prepared();
    const first = reserveCoordinatorTurn(
      record,
      "plan:x:2",
      "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
    );
    if (first.status !== "reserved") throw new Error("not reserved");
    expect(entryOf(first.next)?.reserved).toBe(2);
    expect(entryOf(record)?.reserved).toBe(1);
  });

  test("a message or key already in the outbox is already counted", () => {
    const { record, intent } = prepared();
    expect(reserveCoordinatorTurn(record, intent.idempotencyKey, "dddd").status).toBe(
      "already-counted",
    );
    expect(reserveCoordinatorTurn(record, "plan:x:2", intent.messageId).status).toBe(
      "already-counted",
    );
  });

  test("at the limit it is exhausted", () => {
    const { record } = prepared();
    const entry = entryOf(record);
    if (!entry) throw new Error("no coordinator entry");
    entry.limit = 1;
    expect(reserveCoordinatorTurn(record, "plan:x:2", "dddd").status).toBe("exhausted");
  });
});

describe("the alert of an exhausted coordinator", () => {
  test("names the coordinator, not a seat id; a seat keeps its own wording", () => {
    expect(budgetExhaustedAlertPrefix(COORDINATOR_SEAT_ID)).toBe("协调者的回合预算已用完");
    expect(budgetExhaustedAlert(COORDINATOR_SEAT_ID, 12, 12)).toBe(
      "协调者的回合预算已用完（已预留 12/12）。在 Runs 页追加预算后会继续。",
    );
    expect(budgetExhaustedAlertPrefix("seat-b2")).toBe("席位 seat-b2 的回合预算已用完");
  });
});

import { describe, expect, test } from "vitest";
import { type IntentTarget, transitionIntent } from "../../shared/domain/run-engine/effect-state";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import { type RunRecord, RunRecordSchema } from "../../shared/schemas/run-engine/ledger";
import { INTENT_T2, MESSAGE_T2, preparedRun } from "./support/prepared-run";

const NOW = "2026-11-05T12:00:00.000Z";
const HASH = "a".repeat(64);

function intentOf(record: RunRecord) {
  const intent = record.outbox.find((entry) => entry.id === INTENT_T2);
  if (!intent) throw new Error("no t2 intent");
  return intent;
}

function step(record: RunRecord, to: IntentTarget, reason?: string): RunRecord {
  const result = transitionIntent(record, INTENT_T2, to, { now: NOW, reason });
  if (!result.ok) throw new Error(`unexpected ${result.code} from ${result.from}`);
  return result.next;
}

function expectLegal(record: RunRecord) {
  expect(RunRecordSchema.safeParse(record).success).toBe(true);
  expect(checkLedgerInvariants(record)).toMatchObject({ ok: true });
}

describe("transitionIntent", () => {
  test("prepared -> sending appends one audit event and keeps the ledger legal", () => {
    const before = preparedRun("run-eff001-a1", HASH);
    const frozen = structuredClone(before);
    const after = step(before, "sending");

    expect(before).toEqual(frozen);
    expect(intentOf(after).state).toBe("sending");
    expect(intentOf(after).confirmedAt).toBeNull();
    const event = after.events.at(-1);
    expect(event).toMatchObject({
      kind: "intent-sending",
      payload: { intentId: INTENT_T2, messageId: MESSAGE_T2, taskId: "t2" },
    });
    expect(after.events).toHaveLength(before.events.length + 1);
    expect(after.counters.eventsThroughSeq).toBe(before.counters.eventsThroughSeq + 1);
    expect(after.updatedAt).toBe(NOW);
    expectLegal(after);
  });

  test("the confirmed path stamps confirmedAt; the unknown path does not", () => {
    const sending = step(preparedRun("run-eff002-a1", HASH), "sending");

    const confirmed = step(sending, "confirmed");
    expect(intentOf(confirmed)).toMatchObject({ state: "confirmed", confirmedAt: NOW });
    expectLegal(confirmed);

    const unknown = step(sending, "outcome-unknown", "send:ECONNRESET");
    expect(intentOf(unknown)).toMatchObject({ state: "outcome-unknown", confirmedAt: null });
    expect(unknown.events.at(-1)?.payload.reason).toBe("send:ECONNRESET");
    expectLegal(unknown);

    // Evidence found later is the only way out of outcome-unknown.
    const settled = step(unknown, "confirmed", "echo");
    expect(intentOf(settled)).toMatchObject({ state: "confirmed", confirmedAt: NOW });
    expectLegal(settled);
  });

  test("a refused payload goes prepared -> failed and stays failed", () => {
    const failed = step(preparedRun("run-eff003-a1", HASH), "failed", "payload-hash");
    expect(intentOf(failed).state).toBe("failed");
    expect(intentOf(failed).confirmedAt).toBeNull();
    expectLegal(failed);
    for (const to of ["sending", "confirmed", "outcome-unknown"] as const) {
      expect(transitionIntent(failed, INTENT_T2, to, { now: NOW })).toMatchObject({
        ok: false,
        code: "illegal-transition",
        from: "failed",
      });
    }
  });

  test.each<[string, IntentTarget, IntentTarget[], string]>([
    // [from-path, target, steps to reach the from-state, from-state]
    ["prepared", "confirmed", [], "prepared"],
    ["prepared", "outcome-unknown", [], "prepared"],
    ["sending", "failed", ["sending"], "sending"],
    ["outcome-unknown", "sending", ["sending", "outcome-unknown"], "outcome-unknown"],
    ["outcome-unknown", "failed", ["sending", "outcome-unknown"], "outcome-unknown"],
    ["confirmed", "sending", ["sending", "confirmed"], "confirmed"],
    ["confirmed", "outcome-unknown", ["sending", "confirmed"], "confirmed"],
  ])("%s -> %s is refused (would hide a lost message or send twice)", (_from, to, path, state) => {
    let record = preparedRun("run-eff004-a1", HASH);
    for (const hop of path) record = step(record, hop);
    expect(transitionIntent(record, INTENT_T2, to, { now: NOW })).toEqual({
      ok: false,
      code: "illegal-transition",
      from: state,
    });
  });

  test("asking for the state the intent already has is a harmless no-op", () => {
    const sending = step(preparedRun("run-eff005-a1", HASH), "sending");
    const again = transitionIntent(sending, INTENT_T2, "sending", {
      now: "2030-01-01T00:00:00.000Z",
    });
    expect(again).toMatchObject({ ok: true, changed: false });
    if (again.ok) expect(again.next).toBe(sending);
  });

  test("an unknown intent id is reported, not invented", () => {
    expect(
      transitionIntent(preparedRun("run-eff006-a1", HASH), "intent-nope", "sending", { now: NOW }),
    ).toEqual({ ok: false, code: "intent-missing" });
  });

  test("the audit reason is bounded", () => {
    const sending = step(preparedRun("run-eff007-a1", HASH), "sending");
    const unknown = step(sending, "outcome-unknown", "x".repeat(500));
    expect(String(unknown.events.at(-1)?.payload.reason)).toHaveLength(120);
    expectLegal(unknown);
  });
});

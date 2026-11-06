import { describe, expect, test } from "vitest";
import { readDagControl } from "../../shared/domain/run-engine/dag-admission";
import {
  addPlanRequest,
  bindSeatAgent,
  setLaunchState,
} from "../../shared/domain/run-engine/run-record";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { bootstrapRun } from "./support/bootstrap-run";

/**
 * Failure modes this file guards: a seat quietly changing agents (work then goes to someone the
 * ledger never authorized), a repeated bind growing the ledger, and a launch state skipping a step
 * or leaving a final state.
 */

const NOW = "2026-11-05T12:00:00.000Z";

function withUnboundSeat(): RunRecord {
  const record = bootstrapRun();
  const seat = record.roster.find((entry) => entry.seatId === "seat-b1");
  if (seat) seat.agentId = null;
  return record;
}

describe("bindSeatAgent", () => {
  test("binds an unbound seat and says so in the audit trail", () => {
    const before = withUnboundSeat();
    const result = bindSeatAgent(before, "seat-b1", "agent-new", NOW);
    expect(result.ok && result.changed).toBe(true);
    if (!result.ok) return;
    expect(result.next.roster.find((seat) => seat.seatId === "seat-b1")?.agentId).toBe("agent-new");
    expect(result.next.events.at(-1)).toMatchObject({
      kind: "seat-bound",
      payload: { seatId: "seat-b1", agentId: "agent-new" },
    });
    // The record it was given is untouched.
    expect(before.roster.find((seat) => seat.seatId === "seat-b1")?.agentId).toBeNull();
  });

  test("binding the same agent again changes nothing", () => {
    const bound = bindSeatAgent(withUnboundSeat(), "seat-b1", "agent-new", NOW);
    if (!bound.ok) throw new Error("expected a bind");
    const again = bindSeatAgent(bound.next, "seat-b1", "agent-new", NOW);
    expect(again).toMatchObject({ ok: true, changed: false });
    expect(again.ok && again.next).toBe(bound.next);
  });

  test("a seat is never rebound to another agent, and an unknown seat is refused", () => {
    const bound = bindSeatAgent(withUnboundSeat(), "seat-b1", "agent-new", NOW);
    if (!bound.ok) throw new Error("expected a bind");
    expect(bindSeatAgent(bound.next, "seat-b1", "agent-other", NOW)).toEqual({
      ok: false,
      code: "seat-bound-to-another-agent",
    });
    expect(bindSeatAgent(bound.next, "seat-nope", "agent-x", NOW)).toEqual({
      ok: false,
      code: "seat-missing",
    });
  });
});

describe("addPlanRequest", () => {
  const request = {
    intentId: "intent-plan-1",
    messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    payloadHash: "9".repeat(64),
    templateVersion: 1,
    task: "do it",
    controlNonce: "6f1c2a44-3b7e-4f0a-9a11-0000000000f1",
    controlNonceDigest: "c".repeat(64),
    facts: { template: "plan-request" },
    now: NOW,
  };

  function fresh(): RunRecord {
    const record = bootstrapRun();
    record.outbox = [];
    delete (record.launch as Record<string, unknown>).dagControl;
    return record;
  }

  test("brings the digest, the nonce and the request into the record together", () => {
    const next = addPlanRequest(fresh(), request);
    expect(readDagControl(next)).toEqual({
      nonceDigest: request.controlNonceDigest,
      issuedAt: NOW,
      acceptedAt: null,
    });
    const intent = next.outbox.find((entry) => entry.kind === "wake");
    expect(intent?.semanticArgs).toMatchObject({ controlNonce: request.controlNonce });
  });

  test("a Run gets one plan request and one nonce: asking again is refused", () => {
    const once = addPlanRequest(fresh(), request);
    expect(() => addPlanRequest(once, { ...request, intentId: "intent-plan-2" })).toThrow(
      "already prepared",
    );
  });
});

describe("setLaunchState", () => {
  function at(state: RunRecord["launch"]["state"]): RunRecord {
    const record = bootstrapRun();
    record.launch.state = state;
    return record;
  }

  test("goes preparing, creating, kickoff-pending, running, one step at a time", () => {
    let record = at("preparing");
    for (const next of ["creating", "kickoff-pending", "running"] as const) {
      const moved = setLaunchState(record, next, NOW);
      if (!moved.ok) throw new Error(`refused ${next}`);
      expect(moved.changed).toBe(true);
      expect(moved.next.events.at(-1)).toMatchObject({
        kind: "launch-state",
        payload: { to: next },
      });
      record = moved.next;
    }
    expect(record.launch.state).toBe("running");
  });

  test("any step before running may fail, a step may not be skipped, a final state stays", () => {
    for (const from of ["preparing", "creating", "kickoff-pending"] as const) {
      expect(setLaunchState(at(from), "failed", NOW, "boom")).toMatchObject({
        ok: true,
        changed: true,
      });
    }
    expect(setLaunchState(at("preparing"), "running", NOW)).toMatchObject({
      ok: false,
      code: "illegal-transition",
    });
    expect(setLaunchState(at("preparing"), "kickoff-pending", NOW).ok).toBe(false);
    for (const final of ["running", "failed", "cancelled"] as const) {
      expect(setLaunchState(at(final), "creating", NOW).ok).toBe(false);
      expect(setLaunchState(at(final), final, NOW)).toMatchObject({ ok: true, changed: false });
    }
  });
});

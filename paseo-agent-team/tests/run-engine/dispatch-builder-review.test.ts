import { describe, expect, test } from "vitest";
import {
  applyDispatch,
  buildReviewDispatch,
  type ReviewDispatchInput,
  smokeChecklistUsable,
} from "../../shared/domain/run-engine/dispatch-builder";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { JUDGE_SEAT_REVIEW, JUDGE_SEAT_SMOKE, reviewRun } from "./support/review-run";

/**
 * Failure modes this file guards:
 *  - a delivery judged by its own author (same seat or agent) or, for the weakest review level, by
 *    the same model family;
 *  - a reviewer or smoker bound to nothing, or to a producer that is not the task's current one;
 *  - a smoke that can never validate: a checklist that cannot serve as check ids, or a DEV target
 *    the gate would not accept;
 *  - a judge dispatch that takes new resource claims, or reserves budget when the reducer refuses.
 */

const NOW = "2026-11-05T12:00:00.000Z";
const FACTS = { now: NOW, newId: (kind: string) => `${kind}-new` };

const LUNA = {
  id: "profile-dev-luna",
  name: "DEV Luna",
  provider: "codex",
  model: "gpt-6-luna",
  family: "luna",
};

function input(overrides: Partial<ReviewDispatchInput> = {}): ReviewDispatchInput {
  return {
    taskId: "t1",
    seatId: JUDGE_SEAT_REVIEW,
    purpose: "reviewer",
    profile: LUNA,
    workspace: { id: "ws-start", branch: "main", baseRef: "2".repeat(40) },
    reason: "reviewer",
    ids: {
      assignmentId: "assignment-t1-r1-new",
      nonce: "6f1c2a44-3b7e-4f0a-9a11-0000000000b1",
      messageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
      intentId: "intent-t1-r1-new",
    },
    now: NOW,
    payload: { hash: "9".repeat(64), templateVersion: 1 },
    ...overrides,
  };
}

function smokeInput(overrides: Partial<ReviewDispatchInput> = {}): ReviewDispatchInput {
  return input({
    seatId: JUDGE_SEAT_SMOKE,
    purpose: "smoker",
    devServerId: "dev-server-1",
    ids: {
      assignmentId: "assignment-t1-s1-new",
      nonce: "6f1c2a44-3b7e-4f0a-9a11-0000000000b2",
      messageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
      intentId: "intent-t1-s1-new",
    },
    ...overrides,
  });
}

function seatOf(record: RunRecord, seatId: string) {
  const seat = record.roster.find((entry) => entry.seatId === seatId);
  if (!seat) throw new Error(`fixture lost ${seatId}`);
  return seat;
}

describe("buildReviewDispatch: reviewer", () => {
  test("binds the reviewer to the producer's delivery, takes no claims, and the reducer accepts it", () => {
    const record = reviewRun();
    const built = buildReviewDispatch(record, input());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.event.claims).toEqual([]);
    expect(built.event.assignment).toMatchObject({
      purpose: "reviewer",
      attempt: 1,
      delivery: { producerAssignmentId: "assignment-t1-a1" },
      seatId: JUDGE_SEAT_REVIEW,
    });
    expect(built.event.nonce.phase).toBe("review");

    const applied = applyDispatch(record, built, FACTS);
    if (!applied.ok) throw new Error(`reducer refused: ${JSON.stringify(applied.params)}`);
    const t1 = applied.next.tasks.find((task) => task.spec.id === "t1");
    expect(t1?.currentAssignmentId).toBe("assignment-t1-r1-new");
    expect(t1?.state).toBe("review");
    expect(applied.next.resources).toEqual(record.resources);
    expect(
      applied.next.budgets.entries.find((entry) => entry.subjectId === JUDGE_SEAT_REVIEW)?.reserved,
    ).toBe(1);
  });

  test("a task that is not waiting for review, or has no accepted delivery, is refused", () => {
    const ready = reviewRun();
    const t1 = ready.tasks.find((task) => task.spec.id === "t1");
    if (t1) t1.state = "ready";
    expect(buildReviewDispatch(ready, input())).toEqual({
      ok: false,
      reason: "task-not-dispatchable",
    });

    const noProof = reviewRun();
    const producer = noProof.assignments.find((entry) => entry.assignmentId === "assignment-t1-a1");
    if (producer) producer.acceptedProof = null;
    expect(buildReviewDispatch(noProof, input())).toEqual({
      ok: false,
      reason: "delivery-missing",
    });
    expect(buildReviewDispatch(reviewRun(), input({ taskId: "nope" }))).toEqual({
      ok: false,
      reason: "task-missing",
    });
  });

  test("the producer's own seat and its agent under another seat are both refused", () => {
    const record = reviewRun();
    // seat-b1 produced t1; give it the review duty and the reviewer tier so only independence stops it.
    const own = seatOf(record, "seat-b1");
    own.tier = "A";
    own.duties = ["implement", "review"];
    expect(buildReviewDispatch(record, input({ seatId: "seat-b1" }))).toEqual({
      ok: false,
      reason: "seat-not-independent",
    });

    const sameAgent = reviewRun();
    seatOf(sameAgent, JUDGE_SEAT_REVIEW).agentId = "agent-b1";
    expect(buildReviewDispatch(sameAgent, input())).toEqual({
      ok: false,
      reason: "seat-not-independent",
    });
  });

  test("a seat without the review duty or tier is refused, a disabled seat is unavailable", () => {
    const record = reviewRun();
    expect(buildReviewDispatch(record, input({ seatId: "seat-s1" }))).toEqual({
      ok: false,
      reason: "seat-unqualified",
    });
    seatOf(record, JUDGE_SEAT_REVIEW).enabled = false;
    expect(buildReviewDispatch(record, input())).toEqual({ ok: false, reason: "seat-unavailable" });
  });

  test("the weakest review level needs another model family than the producer's", () => {
    const l1 = () => {
      const record = reviewRun();
      const t1 = record.tasks.find((task) => task.spec.id === "t1");
      if (t1) t1.spec.level = "L1";
      // L1 is reviewed at tier B: let the judge seat serve at that tier.
      seatOf(record, JUDGE_SEAT_REVIEW).tier = "B";
      return record;
    };
    // The producer's family is "haiku".
    expect(buildReviewDispatch(l1(), input({ profile: { ...LUNA, family: "haiku" } }))).toEqual({
      ok: false,
      reason: "family-not-independent",
    });
    expect(buildReviewDispatch(l1(), input({ profile: { ...LUNA, family: null } }))).toEqual({
      ok: false,
      reason: "family-not-independent",
    });
    expect(buildReviewDispatch(l1(), input()).ok).toBe(true);
    // At L2 the family does not matter.
    expect(
      buildReviewDispatch(reviewRun(), input({ profile: { ...LUNA, family: "haiku" } })).ok,
    ).toBe(true);
  });

  test("a missing or used-up budget and reused ids are refused without reserving anything", () => {
    const missing = reviewRun();
    missing.budgets.entries = missing.budgets.entries.filter(
      (entry) => entry.subjectId !== JUDGE_SEAT_REVIEW,
    );
    expect(buildReviewDispatch(missing, input())).toEqual({ ok: false, reason: "budget-missing" });

    const spent = reviewRun();
    const entry = spent.budgets.entries.find((item) => item.subjectId === JUDGE_SEAT_REVIEW);
    if (entry) entry.reserved = entry.limit;
    expect(buildReviewDispatch(spent, input())).toEqual({ ok: false, reason: "budget-exhausted" });

    const record = reviewRun();
    const first = buildReviewDispatch(record, input());
    if (!first.ok) throw new Error("expected a build");
    const applied = applyDispatch(record, first, FACTS);
    if (!applied.ok) throw new Error("expected an apply");
    expect(buildReviewDispatch(applied.next, input())).toEqual({
      ok: false,
      reason: "duplicate-dispatch",
    });
  });

  test("a reducer refusal reserves nothing", () => {
    const record = reviewRun();
    // The builder does not look at the phase; the reducer refuses a review of a task that is
    // waiting for rework, after the builder has already priced the dispatch.
    const t1 = record.tasks.find((task) => task.spec.id === "t1");
    if (t1) t1.phase = "awaiting-rework";
    const built = buildReviewDispatch(record, input());
    if (!built.ok) throw new Error("expected a build");
    expect(applyDispatch(record, built, FACTS).ok).toBe(false);
    expect(
      record.budgets.entries.find((entry) => entry.subjectId === JUDGE_SEAT_REVIEW)?.reserved,
    ).toBe(0);
  });
});

describe("buildReviewDispatch: smoker", () => {
  test("is dispatched for a reviewed task with a smoke, bound to the same delivery", () => {
    const record = reviewRun({ devSmoke: true, reviewed: true });
    const built = buildReviewDispatch(record, smokeInput());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.event.assignment).toMatchObject({
      purpose: "smoker",
      delivery: { producerAssignmentId: "assignment-t1-a1" },
    });
    expect(built.event.nonce.phase).toBe("smoke");
    const applied = applyDispatch(record, built, FACTS);
    if (!applied.ok) throw new Error(`reducer refused: ${JSON.stringify(applied.params)}`);
  });

  test("a smoke without the duty, or a checklist that cannot be check ids, is refused", () => {
    const noSmoke = reviewRun({ reviewed: true });
    expect(buildReviewDispatch(noSmoke, smokeInput())).toMatchObject({ ok: false });

    for (const checklist of [[], ["a", "a"], ["x".repeat(65)], [""]]) {
      const record = reviewRun({ devSmoke: true, reviewed: true });
      const t1 = record.tasks.find((task) => task.spec.id === "t1");
      if (t1) t1.spec.smokeChecklist = checklist;
      expect(buildReviewDispatch(record, smokeInput())).toEqual({
        ok: false,
        reason: "smoke-checklist-invalid",
      });
    }
    expect(smokeChecklistUsable(["health", "login"])).toBe(true);
    expect(smokeChecklistUsable(["x".repeat(64)])).toBe(true);
  });

  test("an unknown DEV target and one the gate would reject are refused", () => {
    const unknown = reviewRun({ devSmoke: true, reviewed: true });
    expect(buildReviewDispatch(unknown, smokeInput({ devServerId: "nope" }))).toEqual({
      ok: false,
      reason: "dev-target-invalid",
    });
    expect(buildReviewDispatch(unknown, smokeInput({ devServerId: undefined }))).toEqual({
      ok: false,
      reason: "dev-target-invalid",
    });
    // The default daemon's port and a host without a port are not DEV targets.
    for (const host of ["127.0.0.1:6767", "127.0.0.1"]) {
      const record = reviewRun({ devSmoke: true, reviewed: true });
      const target = record.policy.devTargets[0];
      if (target) target.host = host;
      expect(buildReviewDispatch(record, smokeInput())).toEqual({
        ok: false,
        reason: "dev-target-invalid",
      });
    }
  });

  test("the smoker may not be the producer's seat either", () => {
    const record = reviewRun({ devSmoke: true, reviewed: true });
    seatOf(record, JUDGE_SEAT_SMOKE).agentId = "agent-b1";
    expect(buildReviewDispatch(record, smokeInput())).toEqual({
      ok: false,
      reason: "seat-not-independent",
    });
  });
});

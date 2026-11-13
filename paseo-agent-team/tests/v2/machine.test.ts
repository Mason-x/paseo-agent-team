import { describe, expect, it } from "vitest";
import { type Event, type Facts, reconcile, transition, waiting } from "../../v2/shared/machine";
import { attempt, BASE, makeRun, NOW, review, reviewing, SHA } from "./fixtures";

const step = (run: ReturnType<typeof makeRun>, ev: Event) => transition(run, ev, NOW);
const verdict = (id: string, v: "approve" | "request-changes", writerOk = true): Event => ({
  kind: "verdict",
  reviewId: id,
  verdict: v,
  blocking: v === "approve" ? 0 : 1,
  writerOk,
});

describe("machine 6.1: writing", () => {
  it("submit with a clean workspace records the candidate and starts the gate", () => {
    const r = step(makeRun(), { kind: "submit", sha: SHA, dirty: [] });
    expect(r.run.state).toBe("gating");
    expect(r.run.attempts).toHaveLength(1);
    expect(r.run.attempts[0]).toMatchObject({ n: 1, sha: SHA });
    expect(r.effects).toEqual([{ t: "run-gate" }]);
  });

  it("submit with uncommitted files is rejected and the state is unchanged (AC1)", () => {
    const run = makeRun();
    const r = step(run, { kind: "submit", sha: SHA, dirty: ["a.ts", "b.ts"] });
    expect(r.run).toBe(run);
    expect(r.effects).toEqual([{ t: "reject-submit", files: ["a.ts", "b.ts"] }]);
  });

  it("first turn end without a tool call nudges, second blocks (AC9)", () => {
    const first = step(makeRun(), { kind: "writer-turn-ended" });
    expect(first.run.state).toBe("writing");
    expect(first.effects).toEqual([{ t: "notify-writer", kind: "nudge" }]);
    const second = step(first.run, { kind: "writer-turn-ended" });
    expect(second.run).toMatchObject({
      state: "blocked",
      blockedReason: "writer-stopped-without-submit",
    });
  });

  it("a failed turn blocks with agent-failed", () => {
    const r = step(makeRun(), { kind: "writer-turn-ended", failed: "boom" });
    expect(r.run).toMatchObject({
      state: "blocked",
      blockedReason: "agent-failed",
      blockedNote: "boom",
    });
  });

  it("team_block moves to blocked(writer-asked-human) and keeps the question", () => {
    const r = step(makeRun(), { kind: "block", question: "which db?" });
    expect(r.run).toMatchObject({
      state: "blocked",
      blockedReason: "writer-asked-human",
      blockedNote: "which db?",
      blockedFrom: "writing",
    });
  });

  it("ignores submit outside writing", () => {
    const run = makeRun({ state: "gating", attempts: [attempt(1)] });
    expect(step(run, { kind: "submit", sha: SHA, dirty: [] }).run).toBe(run);
  });
});

describe("machine 6.1: gating", () => {
  const gating = () => makeRun({ state: "gating", attempts: [attempt(1)] });

  it("pass starts a review round and waits for the reviewers to exist", () => {
    const r = step(gating(), { kind: "gate-finished", attempt: attempt(1, "pass") });
    expect(r.run.state).toBe("gating");
    expect(r.run.round).toBe(1);
    expect(r.effects).toEqual([{ t: "create-reviewers", round: 1, sha: SHA }]);
  });

  it("reviewers ready enters reviewing", () => {
    const run = makeRun({ state: "gating", round: 1, attempts: [attempt(1, "pass")] });
    const r = step(run, { kind: "reviewers-ready", round: 1, reviews: [review("r1")] });
    expect(r.run.state).toBe("reviewing");
    expect(r.run.reviews).toHaveLength(1);
  });

  it("a reviewer worktree that cannot be built blocks and cleans up", () => {
    const run = makeRun({ state: "gating", round: 1, attempts: [attempt(1, "pass")] });
    const r = step(run, { kind: "reviewers-failed", error: "setup failed" });
    expect(r.run).toMatchObject({ state: "blocked", blockedReason: "review-setup-failed" });
    expect(r.effects).toEqual([{ t: "cleanup-reviewers" }]);
  });

  it("failure under the limit returns to writing and sends the output", () => {
    const r = step(gating(), { kind: "gate-finished", attempt: attempt(1, "fail") });
    expect(r.run.state).toBe("writing");
    expect(r.effects).toEqual([{ t: "notify-writer", kind: "gate-failed" }]);
  });

  it("an infrastructure error counts as a failed attempt", () => {
    const r = step(gating(), { kind: "gate-finished", attempt: attempt(1, "error") });
    expect(r.run.state).toBe("writing");
  });

  it("failure at the limit blocks and sends nothing (AC7)", () => {
    const run = makeRun({
      state: "gating",
      limits: { maxGateAttempts: 2, maxReviewRounds: 3, stallMinutes: 15 },
      attempts: [attempt(1, "fail"), attempt(2)],
    });
    const r = step(run, { kind: "gate-finished", attempt: attempt(2, "fail") });
    expect(r.run).toMatchObject({ state: "blocked", blockedReason: "gate-attempts-exhausted" });
    expect(r.effects).toEqual([]);
  });

  it("ignores a stale gate result", () => {
    const run = gating();
    expect(step(run, { kind: "gate-finished", attempt: attempt(7, "pass") }).run).toBe(run);
  });
});

describe("machine 6.1: reviewing", () => {
  it("one of two verdicts keeps reviewing and cleans that reviewer", () => {
    const run = reviewing(["r1", "r2"]);
    const r = step(run, verdict("rv-1-r1-1", "approve"));
    expect(r.run.state).toBe("reviewing");
    expect(r.effects).toEqual([{ t: "cleanup-reviewers" }]);
  });

  it("all approve moves to ready and binds the approval to the SHA", () => {
    const run = reviewing(["r1", "r2"]);
    const a = step(run, verdict("rv-1-r1-1", "approve"));
    const b = step(a.run, verdict("rv-1-r2-1", "approve"));
    expect(b.run.state).toBe("ready");
    expect(b.run.approved).toEqual({ sha: SHA, reviewIds: ["rv-1-r1-1", "rv-1-r2-1"] });
  });

  it("one request-changes waits for the others, then sends all reports once", () => {
    const run = reviewing(["r1", "r2"]);
    const a = step(run, verdict("rv-1-r1-1", "request-changes"));
    expect(a.run.state).toBe("reviewing");
    expect(a.effects).not.toContainEqual({ t: "notify-writer", kind: "reports" });
    const b = step(a.run, verdict("rv-1-r2-1", "approve"));
    expect(b.run.state).toBe("writing");
    expect(b.effects).toContainEqual({ t: "notify-writer", kind: "reports" });
  });

  it("request-changes at the round limit blocks (AC7)", () => {
    const run = reviewing(["r1"], { round: 3, reviews: [review("r1", { round: 3 })] });
    const r = step(run, verdict("rv-1-r1-1", "request-changes"));
    expect(r.run).toMatchObject({ state: "blocked", blockedReason: "review-rounds-exhausted" });
  });

  it("a verdict with a changed writer worktree voids the whole round (AC13)", () => {
    const run = reviewing(["r1", "r2"]);
    const a = step(run, verdict("rv-1-r1-1", "approve"));
    const b = step(a.run, verdict("rv-1-r2-1", "approve", false));
    expect(b.run).toMatchObject({
      state: "blocked",
      blockedReason: "writer-worktree-changed-during-review",
    });
    expect(b.run.reviews.every((x) => x.void === "writer-worktree-changed")).toBe(true);
    expect(b.run.approved).toBeUndefined();
  });

  it("reviewer turn ends without a verdict: remind once, then void and block", () => {
    const run = reviewing(["r1"]);
    const a = step(run, { kind: "reviewer-turn-ended", reviewId: "rv-1-r1-1" });
    expect(a.run.state).toBe("reviewing");
    expect(a.effects).toEqual([{ t: "remind-reviewer", reviewId: "rv-1-r1-1" }]);
    const b = step(a.run, { kind: "reviewer-turn-ended", reviewId: "rv-1-r1-1" });
    expect(b.run).toMatchObject({ state: "blocked", blockedReason: "agent-failed" });
    expect(b.run.reviews[0]?.void).toBe("no-verdict");
    expect(b.effects).toEqual([{ t: "cleanup-reviewers" }]);
  });

  it("ignores a second verdict from the same reviewer", () => {
    const run = reviewing(["r1", "r2"]);
    const a = step(run, verdict("rv-1-r1-1", "approve"));
    expect(step(a.run, verdict("rv-1-r1-1", "request-changes")).run).toBe(a.run);
  });
});

describe("machine 6.1: ready, close, resolve", () => {
  const ready = () =>
    makeRun({
      state: "ready",
      round: 1,
      attempts: [attempt(1, "pass")],
      approved: { sha: SHA, reviewIds: ["x"] },
    });

  it("HEAD change clears the approval and leaves ready (AC5)", () => {
    const r = step(ready(), { kind: "head-changed" });
    expect(r.run.state).toBe("writing");
    expect(r.run.approved).toBeUndefined();
  });

  it("merged is only reachable from ready", () => {
    expect(step(ready(), { kind: "close", outcome: "merged" }).run.state).toBe("merged");
    const writing = makeRun();
    expect(step(writing, { kind: "close", outcome: "merged" }).run).toBe(writing);
  });

  it("abandon works from any active state and archives", () => {
    const r = step(makeRun({ state: "blocked", blockedReason: "stalled" }), {
      kind: "close",
      outcome: "abandoned",
    });
    expect(r.run).toMatchObject({ state: "abandoned", closedAt: NOW });
    expect(r.effects).toContainEqual({ t: "archive" });
    const done = r.run;
    expect(step(done, { kind: "close", outcome: "abandoned" }).run).toBe(done);
  });

  const blocked = (reason: NonNullable<ReturnType<typeof makeRun>["blockedReason"]>, patch = {}) =>
    makeRun({ state: "blocked", blockedReason: reason, blockedFrom: "writing", ...patch });

  it("more attempts raises the limit and resumes the writer", () => {
    const run = blocked("gate-attempts-exhausted", { attempts: [attempt(1, "fail")] });
    const r = step(run, { kind: "resolve", choice: { kind: "more-attempts", n: 2 } });
    expect(r.run.state).toBe("writing");
    expect(r.run.limits.maxGateAttempts).toBe(7);
    expect(r.run.blockedReason).toBeUndefined();
  });

  it("a message after exhausted attempts grants exactly one more", () => {
    const run = blocked("gate-attempts-exhausted", {
      limits: { maxGateAttempts: 2, maxReviewRounds: 3, stallMinutes: 15 },
      attempts: [attempt(1, "fail"), attempt(2, "fail")],
    });
    const r = step(run, { kind: "resolve", choice: { kind: "message", text: "see log" } });
    expect(r.run.limits.maxGateAttempts).toBe(3);
    expect(r.effects).toEqual([{ t: "notify-writer", kind: "text", text: "see log" }]);
  });

  it("one more round, or accepting the current commit as a human override", () => {
    const run = blocked("review-rounds-exhausted", { round: 3 });
    const more = step(run, { kind: "resolve", choice: { kind: "more-round" } });
    expect(more.run.limits.maxReviewRounds).toBe(4);
    const accept = step(run, { kind: "resolve", choice: { kind: "accept-current", sha: SHA } });
    expect(accept.run.state).toBe("ready");
    expect(accept.run.approved).toEqual({ sha: SHA, reviewIds: [], override: "human" });
  });

  it("resubmit goes back to gating from the current commit, refusing a dirty tree", () => {
    const run = blocked("writer-worktree-changed-during-review", {
      attempts: [attempt(1, "pass")],
    });
    const dirty = step(run, {
      kind: "resolve",
      choice: { kind: "resubmit", sha: BASE, dirty: ["x"] },
    });
    expect(dirty.run).toBe(run);
    const ok = step(run, { kind: "resolve", choice: { kind: "resubmit", sha: BASE, dirty: [] } });
    expect(ok.run.state).toBe("gating");
    expect(ok.run.attempts.at(-1)).toMatchObject({ n: 2, sha: BASE });
  });

  it("retry returns to the step that failed", () => {
    const toWriting = step(blocked("stalled"), { kind: "resolve", choice: { kind: "retry" } });
    expect(toWriting.run.state).toBe("writing");
    const setup = blocked("review-setup-failed", {
      blockedFrom: "gating",
      round: 1,
      attempts: [attempt(1, "pass")],
    });
    const again = step(setup, { kind: "resolve", choice: { kind: "retry" } });
    expect(again.run.state).toBe("gating");
    expect(again.effects).toEqual([{ t: "create-reviewers", round: 1, sha: SHA }]);
  });

  it("rejects a choice that is not offered for the reason", () => {
    const run = blocked("writer-asked-human");
    expect(step(run, { kind: "resolve", choice: { kind: "retry" } }).run).toBe(run);
  });
});

describe("machine invariants (6.2)", () => {
  it("1. approval is bound to the commit: any later HEAD invalidates ready", () => {
    const run = makeRun({
      state: "ready",
      approved: { sha: SHA, reviewIds: [] },
      attempts: [attempt(1, "pass")],
    });
    expect(step(run, { kind: "head-changed" }).run.approved).toBeUndefined();
    expect(step(run, { kind: "submit", sha: BASE, dirty: [] }).run.state).toBe("ready");
  });

  it("1. a request-changes among approvals never reaches ready", () => {
    const run = reviewing(["r1", "r2", "r3"]);
    let cur = run;
    for (const [id, v] of [
      ["rv-1-r1-1", "approve"],
      ["rv-1-r2-1", "request-changes"],
      ["rv-1-r3-1", "approve"],
    ] as const) {
      cur = step(cur, verdict(id, v)).run;
    }
    expect(cur.state).toBe("writing");
    expect(cur.approved).toBeUndefined();
  });

  it("2. the frozen gate commands are never touched by any transition", () => {
    const run = makeRun();
    const frozen = JSON.stringify(run.task);
    let cur = step(run, { kind: "submit", sha: SHA, dirty: [] }).run;
    cur = step(cur, { kind: "gate-finished", attempt: attempt(1, "fail") }).run;
    expect(JSON.stringify(cur.task)).toBe(frozen);
  });

  it("3. no transition changes the writer", () => {
    const run = makeRun();
    const cur = step(step(run, { kind: "writer-turn-ended" }).run, {
      kind: "writer-turn-ended",
    }).run;
    expect(cur.writer).toEqual(run.writer);
  });
});

describe("reconcile 6.4", () => {
  const alive = { alive: true, idle: true, error: false };
  const facts = (patch: Partial<Facts> = {}): Facts => ({
    now: NOW,
    head: SHA,
    workspaceAlive: true,
    writer: alive,
    reviewers: { "agent-r1": alive },
    gateRunning: false,
    creatingReviewers: false,
    ...patch,
  });
  const later = (min: number) => new Date(Date.parse(NOW) + min * 60_000).toISOString();

  it("gating without a gate process and without a result reruns the gate (AC8)", () => {
    const run = makeRun({ state: "gating", attempts: [attempt(1)] });
    expect(reconcile(run, facts())).toEqual([{ kind: "resume-gating" }]);
    expect(reconcile(run, facts({ gateRunning: true }))).toEqual([]);
  });

  it("gating with a passed attempt and no reviewer creation in flight resumes", () => {
    const run = makeRun({ state: "gating", round: 1, attempts: [attempt(1, "pass")] });
    expect(reconcile(run, facts())).toEqual([{ kind: "resume-gating" }]);
    expect(reconcile(run, facts({ creatingReviewers: true }))).toEqual([]);
  });

  it("writing and idle past stallMinutes blocks as stalled", () => {
    const run = makeRun();
    expect(reconcile(run, facts({ now: later(14) }))).toEqual([]);
    expect(reconcile(run, facts({ now: later(16) }))[0]).toMatchObject({
      kind: "fail",
      reason: "stalled",
    });
    expect(reconcile(run, facts({ now: later(16), writer: { ...alive, idle: false } }))).toEqual(
      [],
    );
  });

  it("reviewing with a dead reviewer and no verdict blocks as agent-failed", () => {
    const run = reviewing();
    const dead = facts({ reviewers: { "agent-r1": { alive: false, idle: true, error: false } } });
    expect(reconcile(run, dead)[0]).toMatchObject({ kind: "fail", reason: "agent-failed" });
    expect(reconcile(run, facts())).toEqual([]);
  });

  it("reviewing with a moved writer HEAD voids the round (AC13)", () => {
    expect(reconcile(reviewing(), facts({ head: BASE }))[0]).toMatchObject({
      kind: "fail",
      reason: "writer-worktree-changed-during-review",
    });
  });

  it("ready with HEAD != approved SHA drops the approval", () => {
    const run = makeRun({
      state: "ready",
      approved: { sha: SHA, reviewIds: [] },
      attempts: [attempt(1, "pass")],
    });
    expect(reconcile(run, facts({ head: BASE }))).toEqual([{ kind: "head-changed" }]);
    expect(reconcile(run, facts())).toEqual([]);
  });

  it("missing workspace or writer blocks as agent-failed", () => {
    expect(reconcile(makeRun(), facts({ workspaceAlive: false }))[0]).toMatchObject({
      reason: "agent-failed",
    });
    expect(
      reconcile(makeRun(), facts({ writer: { alive: false, idle: true, error: false } }))[0],
    ).toMatchObject({
      reason: "agent-failed",
    });
  });

  it("does nothing for blocked and finished Runs", () => {
    for (const state of ["blocked", "merged", "abandoned"] as const) {
      expect(reconcile(makeRun({ state }), facts({ workspaceAlive: false }))).toEqual([]);
    }
  });
});

describe("waiting (AC10)", () => {
  it("answers who, why and what the human can do in every state", () => {
    for (const state of ["writing", "gating", "reviewing", "ready", "blocked"] as const) {
      const w = waiting(
        makeRun({ state, blockedReason: state === "blocked" ? "stalled" : undefined }),
      );
      expect(w.who).toBeTruthy();
      expect(w.why).toBeTruthy();
      expect(w.options.length).toBeGreaterThan(0);
    }
    expect(waiting(makeRun(), true).why).toContain("权限");
  });
});

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createIntake, type IntakeOptions } from "../../server/run-engine/intake";
import { createRunObserver, type ObserverHost } from "../../server/run-engine/observer";
import type { ReplyWindow } from "../../server/run-engine/protocol";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import {
  applyDispatch,
  buildDispatch,
  buildReviewDispatch,
} from "../../shared/domain/run-engine/dispatch-builder";
import { transitionIntent } from "../../shared/domain/run-engine/effect-state";
import { replyAnchor, requestReportRepair } from "../../shared/domain/run-engine/report-repair";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { PROFILE_HAIKU } from "../fixtures/run-engine/base";
import { readyRun } from "./support/ready-run";
import { HEAD_SHA, JUDGE_SEAT_REVIEW, reviewRun } from "./support/review-run";

/**
 * Failure modes this file guards, with a real store and the real observer:
 *  - a report accepted without the host having shown the turn end, or accepted twice;
 *  - a missing, malformed or someone else's report moving a task, releasing a claim or being retried
 *    by sending anything;
 *  - a half-applied report: the dispatch confirmed or the turn started, but the report refused;
 *  - the same problem growing the ledger every time it is observed again.
 */

const RUN_ID = "run-intk01-a1";
const AGENT = "agent-b1";
const TURN = "turn-42";
const ASSIGNMENT = "assignment-t2-intake";

let home: string;
let store: RunStore;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "run-intake-"));
  await mkdir(path.join(home, "paseo"));
  store = createRunStore({ home: path.join(home, "paseo"), lock: { acquireTimeoutMs: 300 } });
  await store.initialize();
});

afterEach(async () => {
  await store.close().catch(() => undefined);
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** t2 dispatched to agent-b1; `intentState` says how sure the ledger is that the message went out. */
async function seed(intentState: "confirmed" | "sending" | "outcome-unknown" = "confirmed") {
  const record = readyRun({ runId: RUN_ID });
  const t2 = record.tasks.find((task) => task.spec.id === "t2");
  if (!t2) throw new Error("fixture lost t2");
  const built = buildDispatch(record, {
    taskId: "t2",
    seatId: "seat-b1",
    profile: {
      id: PROFILE_HAIKU.id,
      name: PROFILE_HAIKU.name,
      provider: PROFILE_HAIKU.provider,
      model: PROFILE_HAIKU.model,
      family: PROFILE_HAIKU.family,
    },
    workspace: { id: "ws-start", branch: "main", baseRef: "1".repeat(40) },
    scopes: t2.spec.scopes.map((scope) => ({ ...scope, verified: true })),
    reason: "test",
    otherResources: { trusted: true, claims: [] },
    ids: {
      assignmentId: ASSIGNMENT,
      nonce: "6f1c2a44-3b7e-4f0a-9a11-0000000000e1",
      messageId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
      intentId: "intent-t2-intake",
      claimId: (index) => `claim-intake-${index}`,
    },
    now: "2026-11-05T12:00:00.000Z",
    payload: { hash: "9".repeat(64), templateVersion: 1 },
  });
  if (!built.ok) throw new Error(`build refused: ${built.reason}`);
  const applied = applyDispatch(record, built, {
    now: "2026-11-05T12:00:00.000Z",
    newId: (kind) => `${kind}-new`,
  });
  if (!applied.ok) throw new Error(`apply refused: ${JSON.stringify(applied.params)}`);
  const intent = applied.next.outbox.find((entry) => entry.id === "intent-t2-intake");
  if (intent) {
    Object.assign(intent, {
      state: intentState,
      confirmedAt: intentState === "confirmed" ? "2026-11-05T12:00:01.000Z" : null,
    });
  }
  await store.create(applied.next);
  return applied.next;
}

async function stored(): Promise<RunRecord> {
  const read = await store.get(RUN_ID);
  if (read.status !== "ok") throw new Error(`run unreadable: ${read.status}`);
  return read.record;
}

function doneReport(record: RunRecord, overrides: Record<string, unknown> = {}): string {
  const assignment = record.assignments.find((entry) => entry.assignmentId === ASSIGNMENT);
  if (!assignment) throw new Error("fixture lost the assignment");
  const ref = { kind: "git-commit", value: "2".repeat(40) };
  const body = {
    protocolVersion: 1,
    runId: record.runId,
    taskId: "t2",
    attempt: assignment.attempt,
    nonce: assignment.nonce,
    assignmentId: ASSIGNMENT,
    status: "done",
    changedFiles: ["src/t2.ts"],
    ref,
    workspace: assignment.workspace,
    evidence: [
      {
        id: "five-gates",
        command: "npm run check && npm run typecheck && npm test",
        exitCode: 0,
        summary: "all gates passed",
        artifactPath: "evidence/t2.log",
        ref,
        isolation: { homePath: "C:/work/isolated-home", outsideRealHome: true },
      },
    ],
    ...overrides,
  };
  return `Done.\n\`\`\`task-report\n${JSON.stringify(body)}\n\`\`\`\n`;
}

type Harness = ReturnType<typeof harness>;

function harness(
  reply: () => ReplyWindow | Promise<ReplyWindow>,
  extra: Partial<IntakeOptions> = {},
) {
  const host: ObserverHost = { replyWindow: async () => reply() };
  const observer = createRunObserver({ store });
  const onSettled = vi.fn();
  const intake = createIntake({ store, observer, host, onSettled, ...extra });
  return { intake, observer, onSettled };
}

function window(text: string, turnId = TURN): ReplyWindow {
  return { complete: true, turnId, text, bytes: Buffer.byteLength(text, "utf8") };
}

async function turnEnded(h: Harness, turnId = TURN) {
  await h.observer.ingest({ name: "agent.turn_ended", agentId: AGENT, turnId });
}

describe("settleAgent", () => {
  test("a complete report after the turn ended is committed in one step and the task moves on", async () => {
    const record = await seed();
    const h = harness(() => window(doneReport(record)));
    await turnEnded(h);
    const results = await h.intake.settleAgent(AGENT);

    expect(results).toEqual([
      { status: "settled", assignmentId: ASSIGNMENT, kind: "task-report", taskState: "review" },
    ]);
    const after = await stored();
    expect(after.tasks.find((task) => task.spec.id === "t2")).toMatchObject({
      state: "review",
      ref: { kind: "git-commit", value: "2".repeat(40) },
    });
    expect(after.assignments.find((entry) => entry.assignmentId === ASSIGNMENT)).toMatchObject({
      state: "ended",
      turnId: TURN,
    });
    expect(h.onSettled).toHaveBeenCalledWith(RUN_ID);
  });

  test("a report is not accepted before the host's turn_ended is recorded, and is once it is", async () => {
    const record = await seed();
    const h = harness(() => window(doneReport(record)));
    const before = await stored();
    expect(await h.intake.settleAgent(AGENT)).toEqual([{ status: "turn-not-ended" }]);
    expect((await stored()).revision).toBe(before.revision);
    expect(h.onSettled).not.toHaveBeenCalled();

    await turnEnded(h);
    expect((await h.intake.settleAgent(AGENT))[0]?.status).toBe("settled");
  });

  test("the echo of an unconfirmed send is the evidence it was delivered", async () => {
    for (const state of ["sending", "outcome-unknown"] as const) {
      await store.close();
      store = createRunStore({
        home: path.join(home, `paseo-${state}`),
        lock: { acquireTimeoutMs: 300 },
      });
      await mkdir(path.join(home, `paseo-${state}`));
      await store.initialize();
      const record = await seed(state);
      const h = harness(() => window(doneReport(record)));
      await turnEnded(h);
      expect((await h.intake.settleAgent(AGENT))[0]?.status).toBe("settled");
      const intent = (await stored()).outbox.find((entry) => entry.id === "intent-t2-intake");
      expect(intent).toMatchObject({ state: "confirmed" });
    }
  });

  test("settling again changes nothing: the assignment is no longer waiting", async () => {
    const record = await seed();
    const h = harness(() => window(doneReport(record)));
    await turnEnded(h);
    await h.intake.settleAgent(AGENT);
    const settled = await stored();
    expect(await h.intake.settleAgent(AGENT)).toEqual([{ status: "no-assignment" }]);
    expect((await stored()).revision).toBe(settled.revision);
    expect(h.onSettled).toHaveBeenCalledTimes(1);
  });

  test("an agent with no assignment, and an unknown agent, have nothing to settle", async () => {
    await seed();
    const h = harness(() => window("x"));
    expect(await h.intake.settleAgent("agent-nobody")).toEqual([{ status: "no-assignment" }]);
  });

  test("a reply with no report only records why the task is not moving, once", async () => {
    await seed();
    const h = harness(() => window("I finished the work, it all looks fine."));
    await turnEnded(h);
    const before = await stored();
    const first = await h.intake.settleAgent(AGENT);

    expect(first).toEqual([
      { status: "problem", assignmentId: ASSIGNMENT, reason: "report-missing" },
    ]);
    const after = await stored();
    const t2 = after.tasks.find((task) => task.spec.id === "t2");
    // Same state, same claims, same assignment: only the reason and an audit event are new.
    expect(t2).toMatchObject({ state: "assigned", waitingReason: "report-missing" });
    expect(after.resources).toEqual(before.resources);
    expect(after.assignments).toEqual(before.assignments);
    expect(after.events.at(-1)).toMatchObject({ kind: "task-note", payload: { taskId: "t2" } });

    await h.intake.settleAgent(AGENT);
    expect((await stored()).revision).toBe(after.revision);
    expect(h.onSettled).not.toHaveBeenCalled();
  });

  test("a malformed report is rejected with its reason and nothing moves", async () => {
    await seed();
    const h = harness(() => window("```task-report\n{ not json\n```\n"));
    await turnEnded(h);
    expect(await h.intake.settleAgent(AGENT)).toEqual([
      { status: "problem", assignmentId: ASSIGNMENT, reason: "report-rejected:non-json" },
    ]);
    expect((await stored()).tasks.find((task) => task.spec.id === "t2")?.state).toBe("assigned");
  });

  test("a report with someone else's nonce is refused as such", async () => {
    const record = await seed();
    const h = harness(() =>
      window(doneReport(record, { nonce: "6f1c2a44-3b7e-4f0a-9a11-0000000000ff" })),
    );
    await turnEnded(h);
    expect(await h.intake.settleAgent(AGENT)).toEqual([
      { status: "problem", assignmentId: ASSIGNMENT, reason: "report-ownership:nonce-mismatch" },
    ]);
    const after = await stored();
    expect(after.tasks.find((task) => task.spec.id === "t2")).toMatchObject({ state: "assigned" });
    expect(
      after.assignments.find((entry) => entry.assignmentId === ASSIGNMENT)?.acceptedProof,
    ).toBeNull();
  });

  test("an incomplete read is left for later and an unreadable host is reported, writing nothing", async () => {
    await seed();
    const before = await stored();
    const partial = harness(() => ({ complete: false, reason: "too-many-pages" }));
    await turnEnded(partial);
    expect(await partial.intake.settleAgent(AGENT)).toEqual([
      { status: "unverifiable", reason: "too-many-pages" },
    ]);
    const broken = harness(() => {
      throw new Error("host down");
    });
    expect(await broken.intake.settleAgent(AGENT)).toEqual([{ status: "host-error" }]);
    const after = await stored();
    // Only the turn_ended receipt of the earlier hook was added.
    expect(after.tasks).toEqual(before.tasks);
    expect(after.assignments).toEqual(before.assignments);
  });

  test("a report that fails the evidence gate is kept out of review and the reason is shown", async () => {
    const record = await seed();
    const h = harness(() =>
      window(
        doneReport(record, {
          evidence: [
            {
              id: "five-gates",
              command: "npm test",
              exitCode: 0,
              summary: "wrong command",
              artifactPath: "evidence/t2.log",
              ref: { kind: "git-commit", value: "2".repeat(40) },
              isolation: { homePath: "C:/work/isolated-home", outsideRealHome: true },
            },
          ],
        }),
      ),
    );
    await turnEnded(h);
    const results = await h.intake.settleAgent(AGENT);
    expect(results[0]?.status).toBe("settled");
    const t2 = (await stored()).tasks.find((task) => task.spec.id === "t2");
    // Accepted as a report, refused by the gate: the task is not in review.
    expect(t2?.state).not.toBe("review");
    expect(t2?.evidenceReturns).toBe(1);
    expect(t2?.waitingReason).toBe("command");
  });
});

describe("settleAgent: reviewer", () => {
  const LUNA = {
    id: "profile-dev-luna",
    name: "DEV Luna",
    provider: "codex",
    model: "gpt-6-luna",
    family: "luna",
  };
  const REVIEWER = "assignment-t1-intake-r1";

  /** t1 delivered, with a reviewer dispatched to agent-b2 whose message the ledger knows went out. */
  async function reviewerSeeded(mutate: (record: RunRecord) => void = () => undefined) {
    const record = reviewRun({ runId: RUN_ID });
    mutate(record);
    const task = record.tasks.find((entry) => entry.spec.id === "t1");
    if (!task) throw new Error("fixture lost t1");
    const built = buildReviewDispatch(record, {
      taskId: "t1",
      seatId: JUDGE_SEAT_REVIEW,
      purpose: "reviewer",
      profile: LUNA,
      workspace: { id: "ws-start", branch: "main", baseRef: HEAD_SHA },
      reason: "reviewer",
      ids: {
        assignmentId: REVIEWER,
        nonce: "6f1c2a44-3b7e-4f0a-9a11-0000000000e2",
        messageId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2",
        intentId: "intent-t1-intake-r1",
      },
      now: "2026-11-05T12:00:00.000Z",
      payload: { hash: "9".repeat(64), templateVersion: 2 },
    });
    if (!built.ok) throw new Error(`build refused: ${built.reason}`);
    const applied = applyDispatch(record, built, {
      now: "2026-11-05T12:00:00.000Z",
      newId: (kind) => `${kind}-new`,
    });
    if (!applied.ok) throw new Error(`apply refused: ${JSON.stringify(applied.params)}`);
    const intent = applied.next.outbox.find((entry) => entry.id === "intent-t1-intake-r1");
    if (intent)
      Object.assign(intent, { state: "confirmed", confirmedAt: "2026-11-05T12:00:01.000Z" });
    await store.create(applied.next);
    return applied.next;
  }

  function review(record: RunRecord, verdict: string, blockers: unknown[] = []): string {
    const assignment = record.assignments.find((entry) => entry.assignmentId === REVIEWER);
    const delivered = record.assignments.find((entry) => entry.assignmentId === "assignment-t1-a1");
    const proof = delivered?.acceptedProof as { ref: unknown } | null;
    const body = {
      protocolVersion: 1,
      runId: record.runId,
      taskId: "t1",
      attempt: assignment?.attempt,
      nonce: assignment?.nonce,
      assignmentId: REVIEWER,
      reviewedRef: proof?.ref,
      verdict,
      blockers,
      probes: [],
    };
    return `\`\`\`review-report\n${JSON.stringify(body)}\n\`\`\`\n`;
  }

  async function settle(text: string) {
    const host: ObserverHost = { replyWindow: async () => window(text, "turn-r1") };
    const observer = createRunObserver({ store });
    await observer.ingest({ name: "agent.turn_ended", agentId: "agent-b2", turnId: "turn-r1" });
    return createIntake({ store, observer, host }).settleAgent("agent-b2");
  }

  test("a passing review completes the task", async () => {
    const record = await reviewerSeeded();
    const results = await settle(review(record, "可合入"));
    expect(results[0]).toMatchObject({
      status: "settled",
      kind: "review-report",
      taskState: "done",
    });
    expect((await stored()).tasks.find((task) => task.spec.id === "t1")?.state).toBe("done");
  });

  test("a review asking for changes sends the task back for rework", async () => {
    const record = await reviewerSeeded();
    const results = await settle(
      review(record, "修改后合入", [{ id: "b1", summary: "off by one", path: "src/t1.ts" }]),
    );
    expect(results[0]).toMatchObject({ status: "settled", taskState: "rework" });
    const after = await stored();
    expect(after.tasks.find((task) => task.spec.id === "t1")).toMatchObject({
      state: "rework",
      qualityFailures: 1,
    });
  });

  test("a failure that exhausts the attempts opens a decision instead of reworking", async () => {
    // One attempt allowed, and t1 has used it.
    const record = await reviewerSeeded((ready) => {
      ready.policy.perTask.implementationAttempts = 1;
    });
    const results = await settle(
      review(record, "不可合入", [{ id: "b1", summary: "wrong approach", path: null }]),
    );
    expect(results[0], JSON.stringify(results[0])).toMatchObject({ status: "settled" });
    const after = await stored();
    expect(after.tasks.find((task) => task.spec.id === "t1")?.state).toBe("blocked");
    expect(after.decisions.some((decision) => decision.subjectId === "t1")).toBe(true);
    // The claims stay, frozen: nothing is released by a decision waiting for a person.
    expect(after.resources.some((claim) => claim.taskId === "t1" && claim.frozen)).toBe(true);
  });
});

describe("a report is committed only if it was read from the message that is still the one to read (plan point 37)", () => {
  /** A repair that has already gone out (sending) for the assignment: the reply to read moves to it. */
  async function sendRepairNow(messageId: string, intentId = "intent-repair-race") {
    await store.update(RUN_ID, (current) => {
      const assignment = current.assignments.find((entry) => entry.assignmentId === ASSIGNMENT);
      if (!assignment) return null;
      const drafted = requestReportRepair(current, {
        assignmentId: ASSIGNMENT,
        anchor: replyAnchor(current, assignment),
        reason: "report-missing",
        issues: [],
        intentId,
        messageId,
        payloadHash: "0".repeat(64),
        templateVersion: 1,
        now: "2026-11-05T12:01:00.000Z",
      });
      if (!drafted.ok) return null;
      const sending = transitionIntent(drafted.next, intentId, "sending", {
        now: "2026-11-05T12:01:01.000Z",
      });
      return sending.ok ? sending.next : null;
    });
  }

  test("a newer repair that went out while the old reply was being read wins: nothing is written", async () => {
    const record = await seed();
    let raced = false;
    let revisionAfterRace = -1;
    const h = harness(async () => {
      if (!raced) {
        raced = true;
        // The host is read, and in the meantime a newer repair is sent. The reply handed back is the old one.
        await sendRepairNow("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1");
        revisionAfterRace = (await stored()).revision;
      }
      return window(doneReport(record));
    });
    await turnEnded(h);

    const results = await h.intake.settleAgent(AGENT);
    expect(results).toEqual([{ status: "stale" }]);
    const after = await stored();
    expect(after.revision).toBe(revisionAfterRace);
    expect(after.assignments.find((entry) => entry.assignmentId === ASSIGNMENT)).toMatchObject({
      state: "assigned",
      acceptedProof: null,
    });
    expect(after.tasks.find((task) => task.spec.id === "t2")?.state).toBe("assigned");
    expect(after.outbox.find((entry) => entry.id === "intent-repair-race")).toMatchObject({
      state: "sending",
    });
    expect(h.onSettled).not.toHaveBeenCalled();

    // The next pass reads the reply to the newer message and settles it, and the repair goes away.
    const again = await h.intake.settleAgent(AGENT);
    expect(again[0]?.status).toBe("settled");
    expect((await stored()).outbox.some((entry) => entry.id === "intent-repair-race")).toBe(false);
  });

  test("a reply read from the current anchor is committed as before", async () => {
    const record = await seed();
    await sendRepairNow("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2");
    const h = harness(() => window(doneReport(record)));
    await turnEnded(h);
    expect((await h.intake.settleAgent(AGENT))[0]?.status).toBe("settled");
  });
});

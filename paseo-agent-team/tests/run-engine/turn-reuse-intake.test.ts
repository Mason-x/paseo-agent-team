import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createIntake, type IntakeOptions } from "../../server/run-engine/intake";
import { createMemberLostSettler } from "../../server/run-engine/member-lost";
import { createRunObserver, type ObserverHost } from "../../server/run-engine/observer";
import type { ReplyWindow } from "../../server/run-engine/protocol";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import { applyDispatch, buildDispatch } from "../../shared/domain/run-engine/dispatch-builder";
import {
  closedTurnCandidates,
  ENGINE_SETTLER,
  engineSettledEnd,
  findClosedTurns,
} from "../../shared/domain/run-engine/lost-turn";
import { canCancelLocally } from "../../shared/domain/run-engine/transitions";
import type { RunEventReceipt, RunRecord } from "../../shared/schemas/run-engine/ledger";
import { PROFILE_HAIKU } from "../fixtures/run-engine/base";
import { readyRun } from "./support/ready-run";

/**
 * T9a, at the intake: a turn id that comes back after a restart must not make a new reply invisible
 * (it used to be dropped as a repeat), and an old attempt's interrupted turn must not be mistaken for
 * the later turn that shares its id. Each case runs for both ledger versions and both host numberings.
 */

const RUN_ID = "run-trpi01-a1";
const AGENT = "agent-b1";
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
async function seed(schemaVersion: 1 | 2 = 1) {
  const intentState = "confirmed" as const;
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
  (applied.next as { schemaVersion: number }).schemaVersion = schemaVersion;
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

function window(text: string, turnId: string): ReplyWindow {
  return { complete: true, turnId, text, bytes: Buffer.byteLength(text, "utf8") };
}

async function turnEnded(h: Harness, turnId: string) {
  await h.observer.ingest({ name: "agent.turn_ended", agentId: AGENT, turnId });
}

/** A plugin process that began (and saw its hooks) at `at`. */
function processAt(at: string) {
  return createRunObserver({ store, clock: { now: () => at } });
}

describe.each([
  ["v1 ledger, host counts from 1", 1 as const, (n: number) => `foreground-turn-${n}`],
  ["v1 ledger, host counts from 0", 1 as const, (n: number) => `codex-turn-${n - 1}`],
  ["v2 ledger, host counts from 1", 2 as const, (n: number) => `foreground-turn-${n}`],
  ["v2 ledger, host counts from 0", 2 as const, (n: number) => `codex-turn-${n - 1}`],
])("%s", (_label, schemaVersion, tid) => {
  test("a report after a restart, from a member that had an earlier turn, is taken in (case 1)", async () => {
    const record = await seed(schemaVersion);
    // Before the assignment existed the member had already run a turn with this id.
    const old = processAt("2026-11-05T11:00:00.000Z");
    await old.ingest({ name: "agent.turn_started", agentId: AGENT, turnId: tid(1) });
    await old.ingest({ name: "agent.turn_ended", agentId: AGENT, turnId: tid(1) });

    const h = harness(() => window(doneReport(record), tid(1)));
    await turnEnded(h, tid(1));
    const results = await h.intake.settleAgent(AGENT);
    expect(results[0]).toMatchObject({ status: "settled", assignmentId: ASSIGNMENT });
    const after = await stored();
    expect(after.assignments.find((entry) => entry.assignmentId === ASSIGNMENT)).toMatchObject({
      state: "ended",
      turnId: tid(1),
      endedEventKey: `turn_ended:${AGENT}:${tid(1)}#2`,
    });
  });

  test("a report is not taken in on the end of an earlier turn that shares the id", async () => {
    const record = await seed(schemaVersion);
    const old = processAt("2026-11-05T11:00:00.000Z");
    await old.ingest({ name: "agent.turn_started", agentId: AGENT, turnId: tid(1) });
    await old.ingest({ name: "agent.turn_ended", agentId: AGENT, turnId: tid(1) });
    const h = harness(() => window(doneReport(record), tid(1)));
    // The new turn has begun but not ended: the old end is not its end.
    await h.observer.ingest({ name: "agent.turn_started", agentId: AGENT, turnId: tid(1) });
    const before = await stored();
    expect(await h.intake.settleAgent(AGENT)).toEqual([{ status: "turn-not-ended" }]);
    expect((await stored()).revision).toBe(before.revision);
  });

  test("an interrupted old turn and a later turn with the same id read as one window: a decision, no resend (case 8)", async () => {
    await seed(schemaVersion);
    const old = processAt("2026-11-05T12:05:00.000Z");
    await old.ingest({ name: "agent.turn_started", agentId: AGENT, turnId: tid(1) });
    await old.ingest({
      name: "agent.turn_ended",
      agentId: AGENT,
      turnId: tid(1),
      outcome: { kind: "canceled" },
    });
    const send = vi.fn(async () => undefined);
    const h = harness(() => window("OK", tid(1)), { repair: { send } });
    await h.observer.ingest({ name: "agent.turn_started", agentId: AGENT, turnId: tid(1) });
    await h.observer.ingest({
      name: "agent.turn_ended",
      agentId: AGENT,
      turnId: tid(1),
      outcome: { kind: "completed" },
    });

    const results = await h.intake.settleAgent(AGENT);
    expect(results[0]).toMatchObject({ status: "problem", reason: "report-missing" });
    const after = await stored();
    expect(send).not.toHaveBeenCalled();
    expect(after.outbox.some((intent) => intent.kind === "wake")).toBe(false);
    expect(after.decisions.some((decision) => decision.dedupeKey === `stuck:${ASSIGNMENT}`)).toBe(
      true,
    );
  });

  test("a valid report that shows up only after that decision opened is not taken in (case 9)", async () => {
    const record = await seed(schemaVersion);
    const old = processAt("2026-11-05T12:05:00.000Z");
    await old.ingest({ name: "agent.turn_started", agentId: AGENT, turnId: tid(1) });
    await old.ingest({
      name: "agent.turn_ended",
      agentId: AGENT,
      turnId: tid(1),
      outcome: { kind: "canceled" },
    });
    let text = "OK";
    const h = harness(() => window(text, tid(1)), { repair: { send: async () => undefined } });
    await h.observer.ingest({ name: "agent.turn_started", agentId: AGENT, turnId: tid(1) });
    await h.observer.ingest({ name: "agent.turn_ended", agentId: AGENT, turnId: tid(1) });
    await h.intake.settleAgent(AGENT);
    const opened = await stored();

    text = doneReport(record);
    expect(await h.intake.settleAgent(AGENT)).toEqual([{ status: "no-assignment" }]);
    const after = await stored();
    expect(after.revision).toBe(opened.revision);
    expect(after.tasks.find((task) => task.spec.id === "t2")?.state).toBe(
      opened.tasks.find((task) => task.spec.id === "t2")?.state,
    );
    expect(h.onSettled).not.toHaveBeenCalled();
  });
});

describe.each([
  ["v1 ledger", 1 as const],
  ["v2 ledger", 2 as const],
])("a member closed under a turn whose id was used before: %s", (_label, schemaVersion) => {
  const TID = "foreground-turn-1";
  async function oldThenNew() {
    await seed(schemaVersion);
    const old = processAt("2026-11-05T12:05:00.000Z");
    await old.ingest({ name: "agent.turn_started", agentId: AGENT, turnId: TID });
    await old.ingest({ name: "agent.turn_ended", agentId: AGENT, turnId: TID });
    const live = processAt("2026-11-05T13:00:00.000Z");
    await live.ingest({ name: "agent.turn_started", agentId: AGENT, turnId: TID });
    return stored();
  }

  test("the old end does not hide the new turn: it is a candidate on its own appearance", async () => {
    const record = await oldThenNew();
    const candidates = closedTurnCandidates(record);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.started.eventKey).toBe(`turn_started:${AGENT}:${TID}#2`);
    const closed = findClosedTurns(
      record,
      new Map([[AGENT, { status: "closed", activeTurn: false }]]),
    );
    expect(closed[0]).toMatchObject({ turnId: TID, occurrence: 2 });
  });

  test("the Engine's end for it takes the new appearance's key and opens the decision on it", async () => {
    await oldThenNew();
    let now = "2026-11-05T13:05:00.000Z";
    const settler = createMemberLostSettler({
      store,
      readSeat: async () => ({ status: "closed", activeTurn: false }),
      clock: { now: () => now },
    });
    // Closed and nothing more known: the first look waits, the one 30 seconds later settles (T11e).
    expect(await settler.settle(RUN_ID)).toEqual({ settled: 0 });
    now = "2026-11-05T13:05:31.000Z";
    expect(await settler.settle(RUN_ID)).toEqual({ settled: 1 });
    const after = await stored();
    const end = after.eventReceipts.find(
      (receipt) => receipt.eventKey === `turn_ended:${AGENT}:${TID}#2`,
    ) as RunEventReceipt;
    expect(end).toMatchObject({ settledBy: ENGINE_SETTLER, turnId: TID });
    expect(after.eventReceipts.some((r) => r.eventKey === `turn_ended:${AGENT}:${TID}`)).toBe(true);
    const decision = after.decisions.find((entry) => entry.dedupeKey === `stuck:${ASSIGNMENT}`);
    expect(decision).toMatchObject({ limbo: { endedEventKey: end.eventKey } });
    expect(
      engineSettledEnd(
        after,
        after.assignments.find((a) => a.assignmentId === ASSIGNMENT) as never,
      ),
    ).toBe(end);
    // Settled once: nothing more is written.
    const revision = after.revision;
    expect(await settler.settle(RUN_ID)).toEqual({ settled: 0 });
    expect((await stored()).revision).toBe(revision);
  });

  test("an Engine end written for an earlier assignment is not this assignment's", async () => {
    const record = await seed(schemaVersion);
    const assignment = record.assignments.find((entry) => entry.assignmentId === ASSIGNMENT);
    if (!assignment) throw new Error("fixture lost the assignment");
    const earlier = {
      kind: "turn_ended",
      agentId: AGENT,
      turnId: TID,
      eventKey: `turn_ended:${AGENT}:${TID}`,
      receivedAt: "2026-11-05T11:00:00.000Z",
      settledBy: ENGINE_SETTLER,
    } as unknown as RunEventReceipt;
    expect(
      engineSettledEnd(
        { eventReceipts: [earlier] },
        { ...assignment, turnId: TID, createdAt: "2026-11-05T12:00:00.000Z" },
      ),
    ).toBeUndefined();
  });
});

describe("a receipt that is another assignment's only while that assignment was the newest", () => {
  test("a turn of a reused id after a new assignment counts as a fact of the new one", async () => {
    const record = await seed(1);
    const assignment = record.assignments.find((entry) => entry.assignmentId === ASSIGNMENT);
    const intent = record.outbox.find((entry) => entry.id === "intent-t2-intake");
    if (!assignment || !intent) throw new Error("fixture lost the dispatch");
    const prepared = structuredClone(record);
    const a = prepared.assignments.find((entry) => entry.assignmentId === ASSIGNMENT) as never as {
      turnId: string | null;
    };
    a.turnId = null;
    const i = prepared.outbox.find((entry) => entry.id === "intent-t2-intake") as never as {
      state: string;
      confirmedAt: string | null;
    };
    i.state = "prepared";
    i.confirmedAt = null;
    // An older assignment of the same member ran the turn that now has the same id again.
    prepared.assignments.push({
      ...structuredClone(assignment),
      assignmentId: "assignment-old",
      turnId: "foreground-turn-1",
      state: "ended",
      createdAt: "2026-11-05T10:00:00.000Z",
    });
    const started = (at: string) =>
      ({
        eventKey: `turn_started:${AGENT}:foreground-turn-1`,
        dedupeKey: `turn_started:${AGENT}:foreground-turn-1`,
        kind: "turn_started",
        agentId: AGENT,
        turnId: "foreground-turn-1",
        seq: 1,
        receivedAt: at,
        disposition: "observed",
      }) as unknown as RunEventReceipt;
    const target = prepared.assignments.find((entry) => entry.assignmentId === ASSIGNMENT);
    const dispatch = prepared.outbox.find((entry) => entry.id === "intent-t2-intake");
    if (!target || !dispatch) throw new Error("lost");
    expect(canCancelLocally({ ...prepared, eventReceipts: [] }, target, dispatch)).toBe(true);
    expect(
      canCancelLocally(
        { ...prepared, eventReceipts: [started("2026-11-05T12:30:00.000Z")] },
        target,
        dispatch,
      ),
    ).toBe(false);
  });
});

describe("a reconcile reads a reply by the message it answers", () => {
  test("a turn that ended after the restart with its hook lost is recorded as a new appearance", async () => {
    await seed(1);
    const old = processAt("2026-11-05T11:00:00.000Z");
    await old.ingest({ name: "agent.turn_started", agentId: AGENT, turnId: "foreground-turn-1" });
    await old.ingest({ name: "agent.turn_ended", agentId: AGENT, turnId: "foreground-turn-1" });
    // The assignment was dispatched at 12:00, after those receipts: the turn it ran in is not theirs.
    const live = processAt("2026-11-09T09:00:00.000Z");
    const host: ObserverHost = {
      replyWindow: async () => window("done", "foreground-turn-1"),
    };
    const summary = await live.reconcile(host);
    expect(summary.recorded).toBe(1);
    expect((await stored()).eventReceipts.at(-1)?.eventKey).toBe(
      `turn_ended:${AGENT}:foreground-turn-1#2`,
    );
    // And again: the same turn is now a duplicate, nothing more is written.
    const revision = (await stored()).revision;
    expect((await live.reconcile(host)).recorded).toBe(0);
    expect((await stored()).revision).toBe(revision);
  });
});

describe("an earlier appearance that never ended (a known limit)", () => {
  const TID = "foreground-turn-1";
  test("a report in the later turn waits for the earlier appearance to be ended by a reconcile, then is taken in", async () => {
    const record = await seed(1);
    // A turn that began before the restart and never ended, then a later turn with the same id.
    const old = processAt("2026-11-05T12:05:00.000Z");
    await old.ingest({ name: "agent.turn_started", agentId: AGENT, turnId: TID });
    const h = harness(() => window(doneReport(record), TID));
    await h.observer.ingest({ name: "agent.turn_started", agentId: AGENT, turnId: TID });
    await h.observer.ingest({ name: "agent.turn_ended", agentId: AGENT, turnId: TID });

    // The assignment's own turn is the earliest appearance, which has no end yet: nothing is taken in
    // and nothing is written (no note, no repair, no decision).
    const before = await stored();
    expect(await h.intake.settleAgent(AGENT)).toEqual([{ status: "turn-not-ended" }]);
    expect((await stored()).revision).toBe(before.revision);

    // A reconcile reads the reply, records the missing end of that appearance, and the report follows.
    const host: ObserverHost = { replyWindow: async () => window(doneReport(record), TID) };
    expect((await h.observer.reconcile(host)).recorded).toBe(1);
    expect((await h.intake.settleAgent(AGENT))[0]?.status).toBe("settled");
  });
});

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createCancelFinisher } from "../../server/run-engine/cancel";
import { createRunControl } from "../../server/run-engine/control";
import { createDagIntake } from "../../server/run-engine/dag";
import { alertIdFor } from "../../server/run-engine/digest";
import { createEngineDriver, type DriverOptions } from "../../server/run-engine/driver";
import { createEffects } from "../../server/run-engine/effects";
import { createObserverHost } from "../../server/run-engine/host";
import { createIntake } from "../../server/run-engine/intake";
import { createRunObserver } from "../../server/run-engine/observer";
import { createReadRetry, type ReadFailure } from "../../server/run-engine/read-retry";
import { createEngineService } from "../../server/run-engine/service";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import { REPO_ALIAS } from "../../shared/domain/run-engine/dag-admission";
import { compileEngineIntent } from "../../shared/domain/run-engine/engine-prompts";
import { compileDispatch } from "../../shared/domain/run-engine/prompt-template";
import {
  beginTries,
  emptyReadRetries,
  finishTries,
  noteReadFailure,
  type ReadRetryTarget,
  readReadRetries,
  readRetryAlertSummary,
  sweepReadRetries,
} from "../../shared/domain/run-engine/read-retry";
import { reduceRun } from "../../shared/domain/run-engine/reducer";
import type { PaseoEnginePort, PortTimelinePage } from "../../shared/paseo/port";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import {
  ASSIGNMENT_T2,
  MESSAGE_T2,
  NORMAL_RUN_LEDGER,
  PROFILE_HAIKU,
} from "../fixtures/run-engine/base";
import {
  bootstrapRun,
  COORDINATOR_AGENT,
  dagBlock,
  PLAN_MESSAGE_ID,
  planTasks,
} from "./support/bootstrap-run";
import { JUDGE_SEAT_REVIEW, JUDGE_SEAT_SMOKE } from "./support/review-run";

/**
 * A12 finding 2 (A21): the host was restarted in the middle of a member's turn and lost the turn.
 * The dispatch is no longer in the member's history, so the reads of its reply keep failing with
 * `incomplete:dispatch-not-found` until they are used up. The Engine does not settle such a turn
 * itself (that would change what a receipt means, B14) and never sends the member anything again.
 * What there is for a person is a way out that goes through the host's own receipts:
 *  - these tests pin the limitation (the Run does not move, a cancellation of the whole Run waits);
 *  - and the way out: the member, idle in Paseo, is asked for a plain OK, its own `turn_started` and
 *    `turn_ended` come in, and only then does the cancellation finish;
 *  - and every other signal (someone else's receipt, one from before the assignment, a later
 *    `turn_started`, a host that is not idle, a delivery not settled) keeps waiting;
 *  - and the alert says the way out, while an alert written by the earlier wording is still found.
 */

const RUN_ID = "run-lost01-a1";
const MEMBER = "agent-b1";
const LOST_CODE = "incomplete:dispatch-not-found";

let home: string;
let repoDir: string;
let store: RunStore;
let ready = false;
let version: 1 | 2 = 2;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=probe",
      "-c",
      "user.email=probe@example.invalid",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    { cwd, windowsHide: true, encoding: "utf8" },
  ).trim();
}

async function setup(): Promise<void> {
  home = await realpath(await mkdtemp(path.join(tmpdir(), "run-lost-")));
  repoDir = path.join(home, "repo");
  await mkdir(path.join(repoDir, "src"), { recursive: true });
  git(repoDir, "init", "-q", "-b", "main");
  await writeFile(path.join(repoDir, "src", "t1.ts"), "export {};\n");
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "-q", "-m", "base");
  await mkdir(path.join(home, "paseo"));
  store = createRunStore({ home: path.join(home, "paseo"), lock: { acquireTimeoutMs: 300 } });
  await store.initialize();
  const record = bootstrapRun({ runId: RUN_ID, planRequest: true });
  record.policy.evidenceRoot = path.join(home, "evidence").replaceAll("\\", "/");
  record.schemaVersion = version;
  // A v2 Run carries the block that gives it read re-checks; a v1 Run never has one.
  if (version === 2) (record as Record<string, unknown>).readRetries = emptyReadRetries();
  await store.create(record);
  ready = true;
}

afterEach(async () => {
  if (!ready) return;
  ready = false;
  await store.close().catch(() => undefined);
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

// --- a host whose history of an agent the test can lose ------------------------------------------

type PortTimelineEntry = PortTimelinePage["entries"][number];

function fakeHost() {
  const timelines = new Map<string, PortTimelineEntry[]>();
  const turns = new Map<string, string>();
  const sent: { agentId: string; text: string; messageId: string }[] = [];
  const calls = { archives: 0 };
  const lose = { next: false };
  const runningAgents = new Set<string>();
  let seq = 0;
  const entries = (agentId: string) => {
    let list = timelines.get(agentId);
    if (!list) {
      list = [];
      timelines.set(agentId, list);
    }
    return list;
  };
  const add = (agentId: string, turnId: string, item: PortTimelineEntry["item"]) => {
    seq += 1;
    entries(agentId).push({ item, turnId, seqStart: seq, seqEnd: seq });
    turns.set(agentId, turnId);
  };
  const state = (agentId: string) => ({
    status: runningAgents.has(agentId) ? "running" : "idle",
    activeTurn: runningAgents.has(agentId) ? { id: turns.get(agentId) } : null,
    pendingPermissions: [],
  });
  const port: PaseoEnginePort = {
    agents: {
      ref: (agentId) => ({
        send: async (text, options) => {
          const messageId = options?.messageId ?? "";
          sent.push({ agentId, text, messageId });
          if (lose.next) {
            lose.next = false;
            throw new Error("the host did not answer");
          }
          add(agentId, `turn-${agentId}-${sent.length}`, { type: "user_message", messageId });
        },
        archive: async () => {
          calls.archives += 1;
        },
        timeline: {
          refetch: async () => ({
            entries: [...entries(agentId)],
            epoch: "e1",
            startCursor: null,
            hasOlder: false,
            hasNewer: false,
            gap: false,
            staleCursor: false,
            reset: false,
          }),
        },
        current: () => state(agentId),
        refresh: async () => ({ agent: state(agentId) }),
      }),
    },
  };
  return {
    port,
    sent,
    calls,
    runningAgents,
    loseNextSend: () => {
      lose.next = true;
    },
    /** The host restarted and lost the history of an agent, the turn it was in included. */
    dropTimeline: (agentId: string) => {
      timelines.set(agentId, []);
    },
    planRequestSent: () =>
      add(COORDINATOR_AGENT, "turn-plan", { type: "user_message", messageId: PLAN_MESSAGE_ID }),
    addUserMessage: (agentId: string, turnId: string, messageId: string) =>
      add(agentId, turnId, { type: "user_message", messageId }),
    reply: (agentId: string, text: string) =>
      add(agentId, turns.get(agentId) ?? "turn-plan", { type: "assistant_message", text }),
    turnOf: (agentId: string) => turns.get(agentId) ?? "turn-plan",
  };
}

type Host = ReturnType<typeof fakeHost>;

/** The wiring as production makes it: the read re-checks, the cancellation finisher, the driver. */
function build(host: Host) {
  const clock = { at: Date.now() };
  const readHost = createObserverHost(host.port);
  const retry = createReadRetry({
    store,
    clock: { now: () => new Date(clock.at).toISOString() },
    schedule: () => () => undefined,
    readReply: (agentId, messageId) => readHost.replyWindow(agentId, messageId),
    readSeat: async (agentId) => {
      const refreshed = await host.port.agents.ref(agentId).refresh();
      if (!refreshed?.agent) throw new Error("no agent state");
    },
  });
  const onReadFailure = (runId: string, failure: ReadFailure) => retry.note(runId, failure);
  const readSeat = async (agentId: string) => {
    const refreshed = await host.port.agents.ref(agentId).refresh();
    return refreshed?.agent
      ? { status: refreshed.agent.status, activeTurn: refreshed.agent.activeTurn != null }
      : null;
  };
  const observerHost = createObserverHost(host.port);
  const observer = createRunObserver({ store, onReadFailure });
  const effects = createEffects({
    store,
    port: host.port,
    compile: compileEngineIntent,
    resolveWorkspace: () => ({ workspaceId: "ws-start", directory: repoDir }),
    onReadFailure,
  });
  const profile = (family: string, id: string) => ({
    id,
    name: id,
    provider: "x",
    model: null,
    family,
  });
  const resolveWorkspace = () => ({ workspaceId: "ws-start", directory: repoDir });
  const service = createEngineService({
    store,
    port: host.port,
    effects,
    resolveSeat: (_record, seatId) => {
      if (seatId === "seat-b1") {
        return {
          profile: { ...profile("haiku", PROFILE_HAIKU.id), name: PROFILE_HAIKU.name },
          available: true,
          order: 0,
        };
      }
      if (seatId === JUDGE_SEAT_REVIEW || seatId === JUDGE_SEAT_SMOKE) {
        return { profile: profile("luna", "profile-dev-luna"), available: true, order: 1 };
      }
      return null;
    },
    resolveWorkspace,
    compile: compileDispatch,
    onReadFailure,
  });
  const intake = createIntake({
    store,
    observer,
    host: observerHost,
    onReadFailure,
    repair: { send: (runId) => effects.runOutbox(runId) },
  });
  const dagIntake = createDagIntake({
    store,
    host: observerHost,
    seatFamily: () => null,
    resolveWorkspace,
    repair: { send: (runId) => effects.runOutbox(runId) },
  });
  const overrides: Partial<DriverOptions> = {
    onPassed: (runId) => retry.sweep(runId),
    cancelFinisher: createCancelFinisher({ store, readSeat, onReadFailure }),
    reconcileHost: createObserverHost(host.port, { requireIdle: true }),
  };
  const driver = createEngineDriver({
    store,
    observer,
    host: observerHost,
    intake,
    dagIntake,
    service,
    ...overrides,
  });
  const control = createRunControl({ store, ensureReady: async () => undefined, driver });
  return { driver, retry, clock, control };
}

async function stored(): Promise<RunRecord> {
  const read = await store.get(RUN_ID);
  if (read.status !== "ok") throw new Error(`run unreadable: ${read.status}`);
  return read.record;
}

const states = (record: RunRecord) =>
  Object.fromEntries(record.tasks.map((task) => [task.spec.id, task.state]));

const plan = () =>
  `Done.\n\`\`\`task-dag\n${JSON.stringify(dagBlock(RUN_ID, planTasks(REPO_ALIAS)))}\n\`\`\`\n`;

const items = async () => {
  const block = readReadRetries(await stored());
  if (block.kind !== "valid") throw new Error(`block is ${block.kind}`);
  return block.items;
};

/** The plan is admitted and t1 goes out to the member; then the host restarts and forgets the turn. */
async function reachLostTurn(host: Host, built: ReturnType<typeof build>) {
  host.planRequestSent();
  host.reply(COORDINATOR_AGENT, plan());
  await built.driver.onHook({
    name: "agent.turn_ended",
    agentId: COORDINATOR_AGENT,
    turnId: host.turnOf(COORDINATOR_AGENT),
  });
  expect(states(await stored())).toEqual({ t1: "assigned", t2: "pending" });
  expect(host.sent.map((entry) => entry.agentId)).toEqual([MEMBER]);
  host.dropTimeline(MEMBER);
  await built.driver.recover();
  for (const wait of [1500, 2500, 4500, 100_000]) {
    built.clock.at += wait;
    await built.retry.fire();
  }
}

async function askForCancel(built: ReturnType<typeof build>, requestId = "cancel-1") {
  const before = await stored();
  const out = await built.control.cancel({
    runContractVersion: 1 as const,
    runId: RUN_ID,
    requestId,
    expectedRevision: before.revision,
    reason: "from the test",
  });
  await built.control.idle();
  return out;
}

/** What a member does when a person asks it, in Paseo, for a plain OK: its own turn, start and end. */
async function memberAnswersOk(host: Host, built: ReturnType<typeof build>, turnId = "turn-ok") {
  host.addUserMessage(MEMBER, turnId, "typed-by-the-person-ok");
  await built.driver.onHook({ name: "agent.turn_started", agentId: MEMBER, turnId });
  host.reply(MEMBER, "OK");
  await built.driver.onHook({ name: "agent.turn_ended", agentId: MEMBER, turnId });
}

/** Writes a receipt of the host with a time the test chooses, the way the observer records one. */
async function plantReceipt(
  kind: "turn_started" | "turn_ended",
  agentId: string,
  turnId: string,
  receivedAt: string,
) {
  await store.update(RUN_ID, (current) => {
    const key = `${kind}:${agentId}:${turnId}`;
    const reduced = reduceRun(
      current,
      {
        kind: "observation-recorded",
        receipt: {
          eventKey: key,
          kind,
          agentId,
          turnId,
          dedupeKey: key,
          disposition: "observed",
          seq: 0,
          receivedAt,
        },
      },
      { now: receivedAt, newId: () => `planted-${key}` },
    );
    if (!reduced.ok) throw new Error(`could not plant ${key}: ${reduced.code}`);
    return reduced.next;
  });
}

for (const schema of [1, 2] as const) {
  describe(`a turn the host lost [v${schema}]`, () => {
    beforeEach(async () => {
      version = schema;
      await setup();
    });

    test("known limitation: the reads of the lost reply are used up, a kick writes nothing and the host is sent nothing, and a cancellation of the whole Run keeps waiting for a turn end", async () => {
      const host = fakeHost();
      const built = build(host);
      await reachLostTurn(host, built);
      const lost = await stored();
      expect(states(lost)).toEqual({ t1: "assigned", t2: "pending" });
      expect(lost.assignments.find((entry) => entry.taskId === "t1")?.turnId).toBeNull();
      if (schema === 2) {
        expect((await items())[0]).toMatchObject({
          state: "held",
          attemptsStarted: 3,
          lastCode: LOST_CODE,
        });
        expect(lost.alerts.map((alert) => alert.state)).toEqual(["open"]);
        expect(lost.alerts[0]?.summary).toContain("只要求回复 OK");
      } else {
        // A v1 Run is not given re-checks: nothing is written down and no alert is raised.
        expect(readReadRetries(lost)).toEqual({ kind: "absent" });
        expect(lost.alerts).toEqual([]);
      }
      const sentBefore = host.sent.length;

      // A kick finds nothing to do: the ledger is not written and nothing reaches the host.
      const report = await built.driver.kick(RUN_ID);
      expect(JSON.stringify(report)).toContain("idle");
      const kicked = await stored();
      expect(kicked.revision).toBe(lost.revision);
      expect(host.sent).toHaveLength(sentBefore);

      // Cancelling the Run waits for the one turn it has no proof of, for as long as it is asked.
      const out = await askForCancel(built);
      expect(out).toMatchObject({ status: "applied", lifecycle: "paused" });
      expect((out as { waiting: { turns: number } }).waiting.turns).toBe(1);
      await built.driver.kick(RUN_ID);
      await built.driver.recover();
      const waiting = await stored();
      expect(waiting.lifecycle).toBe("paused");
      expect(states(waiting)).toEqual({ t1: "assigned", t2: "pending" });
      expect(waiting.resources).toEqual(lost.resources);
      expect(host.sent).toHaveLength(sentBefore);
      expect(host.calls.archives).toBe(0);
    });

    test("the way out: the member is asked in Paseo for a plain OK, its own turn start and end come in, and the cancellation finishes once; the claims are released and nothing is sent or archived", async () => {
      const host = fakeHost();
      const built = build(host);
      await reachLostTurn(host, built);
      const lost = await stored();
      expect(lost.resources.length).toBeGreaterThan(0);
      const sentBefore = host.sent.length;
      expect(await askForCancel(built)).toMatchObject({ lifecycle: "paused" });

      await memberAnswersOk(host, built);
      await built.driver.kick(RUN_ID);

      const done = await stored();
      expect(done.lifecycle).toBe("cancelled");
      expect(states(done)).toEqual({ t1: "cancelled", t2: "cancelled" });
      expect(done.resources).toEqual([]);
      expect(done.events.filter((event) => event.kind === "run-cancel-completed")).toHaveLength(1);
      expect(host.sent).toHaveLength(sentBefore);
      expect(host.calls.archives).toBe(0);
      // Asking again changes nothing.
      const revision = done.revision;
      await built.driver.kick(RUN_ID);
      await built.driver.recover();
      expect((await stored()).revision).toBe(revision);
    });

    test("the cancellation was asked after the member answered: the same receipts finish it", async () => {
      const host = fakeHost();
      const built = build(host);
      await reachLostTurn(host, built);
      const sentBefore = host.sent.length;
      await memberAnswersOk(host, built);
      expect((await stored()).lifecycle).toBe("active");
      await askForCancel(built);
      await built.driver.kick(RUN_ID);
      const done = await stored();
      expect(done.lifecycle).toBe("cancelled");
      expect(done.resources).toEqual([]);
      expect(host.sent).toHaveLength(sentBefore);
      expect(host.calls.archives).toBe(0);
    });

    describe("signals that are not proof keep the cancellation waiting and the claims held", () => {
      async function stillWaiting(host: Host, built: ReturnType<typeof build>, held: RunRecord) {
        await built.driver.kick(RUN_ID);
        await built.driver.recover();
        const now = await stored();
        expect(now.lifecycle).toBe("paused");
        expect(states(now)).toEqual({ t1: "assigned", t2: "pending" });
        expect(now.resources).toEqual(held.resources);
        // Not even an attempt: a plan that tried to close a turn and failed would raise a critical alert.
        expect(now.alerts.filter((alert) => alert.severity === "critical")).toEqual([]);
        expect(host.calls.archives).toBe(0);
        expect(now.events.some((event) => event.kind === "run-cancel-completed")).toBe(false);
      }

      test("another member's turn end is not the member's", async () => {
        const host = fakeHost();
        const built = build(host);
        await reachLostTurn(host, built);
        const held = await stored();
        const sentBefore = host.sent.length;
        await askForCancel(built);
        // The reviewer seat's own turn start and end: a receipt of the Run, for a different agent.
        await plantReceipt("turn_started", "agent-b2", "turn-other", new Date().toISOString());
        await plantReceipt("turn_ended", "agent-b2", "turn-other", new Date().toISOString());
        await stillWaiting(host, built, held);
        expect(host.sent).toHaveLength(sentBefore);
      });

      test("a turn end from before the assignment was made is not its turn", async () => {
        const host = fakeHost();
        const built = build(host);
        await reachLostTurn(host, built);
        const held = await stored();
        const created = held.assignments.find((entry) => entry.taskId === "t1")?.createdAt ?? "";
        const early = new Date(Date.parse(created) - 5000).toISOString();
        await askForCancel(built);
        await plantReceipt("turn_started", MEMBER, "turn-before", early);
        await plantReceipt("turn_ended", MEMBER, "turn-before", early);
        await stillWaiting(host, built, held);
      });

      test("a turn that started after the turn end means the member is working again", async () => {
        const host = fakeHost();
        const built = build(host);
        await reachLostTurn(host, built);
        const held = await stored();
        await askForCancel(built);
        const now = Date.now();
        await plantReceipt("turn_started", MEMBER, "turn-ok", new Date(now).toISOString());
        await plantReceipt("turn_ended", MEMBER, "turn-ok", new Date(now + 1).toISOString());
        await plantReceipt("turn_started", MEMBER, "turn-again", new Date(now + 2).toISOString());
        await stillWaiting(host, built, held);
      });

      test("a member the host reports as working is not at rest", async () => {
        const host = fakeHost();
        const built = build(host);
        await reachLostTurn(host, built);
        const held = await stored();
        await askForCancel(built);
        host.runningAgents.add(MEMBER);
        await memberAnswersOk(host, built);
        await stillWaiting(host, built, held);
        // Once it is idle the same receipts finish the cancellation.
        host.runningAgents.delete(MEMBER);
        await built.driver.kick(RUN_ID);
        expect((await stored()).lifecycle).toBe("cancelled");
      });

      test("a message whose delivery is not settled may still start a turn", async () => {
        const host = fakeHost();
        const built = build(host);
        host.planRequestSent();
        host.reply(COORDINATOR_AGENT, plan());
        host.loseNextSend();
        await built.driver.onHook({
          name: "agent.turn_ended",
          agentId: COORDINATOR_AGENT,
          turnId: host.turnOf(COORDINATOR_AGENT),
        });
        const unknown = await stored();
        expect(unknown.outbox.some((intent) => intent.state === "outcome-unknown")).toBe(true);
        const sentBefore = host.sent.length;
        await askForCancel(built);
        await memberAnswersOk(host, built);
        await built.driver.kick(RUN_ID);
        const now = await stored();
        expect(now.lifecycle).toBe("paused");
        expect(now.resources).toEqual(unknown.resources);
        expect(host.sent).toHaveLength(sentBefore);
        expect(host.calls.archives).toBe(0);
      });
    });
  });
}

describe("the alert for a lost turn says the way out and still matches the wording of before", () => {
  const T0 = "2026-11-08T10:00:00.000Z";
  const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
  const REPLY: ReadRetryTarget = {
    type: "reply",
    agentId: MEMBER,
    taskId: "t2",
    assignmentId: ASSIGNMENT_T2,
    anchorMessageId: MESSAGE_T2,
  };
  /** The summary as the code before A21 wrote it. */
  const earlier = (code: string) =>
    `读取重试已用尽（${code}）：Agent ${MEMBER} 的回复（${ASSIGNMENT_T2}），请检查宿主后 kick`;

  function run(): RunRecord {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    record.schemaVersion = 2;
    (record as Record<string, unknown>).readRetries = emptyReadRetries();
    return record;
  }

  function noted(record: RunRecord): RunRecord {
    const result = noteReadFailure(
      record,
      { key: "k1", sourceKey: "source-k1", target: REPLY },
      T0,
    );
    if (!result.changed) throw new Error("the failure was not noted");
    return result.next;
  }

  /** Counts a try at its due time and fails it with `code`, as the executor does. */
  function failedTry(record: RunRecord, now: string, code: string): RunRecord {
    const begun = beginTries(record, now, alertIdFor);
    const [one] = begun.started;
    if (!one || !begun.change.changed) throw new Error("no try was due");
    const finished = finishTries(
      begun.change.next,
      [{ key: one.key, generation: one.generation, ok: false, code }],
      now,
      alertIdFor,
    );
    if (!finished.changed) throw new Error("the try was not ended");
    return finished.next;
  }

  const used = (code: string, from: RunRecord = run()) => {
    let record = noted(from);
    record = failedTry(record, at(1000), code);
    record = failedTry(record, at(3000), code);
    return failedTry(record, at(7000), code);
  };

  const heldItem = (record: RunRecord) => {
    const block = readReadRetries(record);
    if (block.kind !== "valid" || block.items[0] === undefined) throw new Error("no item");
    return block.items[0];
  };

  const open = (record: RunRecord) => record.alerts.filter((alert) => alert.state === "open");

  test("a lost dispatch is told the way out: wait for the member to be at rest, ask it for a plain OK, then check and push on; nothing is promised", () => {
    const record = used(LOST_CODE);
    const summary = open(record)[0]?.summary ?? "";
    expect(open(record)).toHaveLength(1);
    // The fixed text of before comes first, unchanged.
    expect(summary.startsWith(earlier(LOST_CODE))).toBe(true);
    expect(summary.length).toBeGreaterThan(earlier(LOST_CODE).length);
    expect(summary).toContain("宿主可能丢失了进行中的回合");
    expect(summary).toContain("Paseo 里空闲");
    expect(summary).toContain("只要求回复 OK");
    expect(summary).toContain("立即检查并推进");
    expect(summary).toContain("不保证");
    expect(summary).toBe(readRetryAlertSummary(heldItem(record)));
    expect(summary.length).toBeLessThanOrEqual(1000);
  });

  test("any other reason, and a read that works again, keep the wording of before without the hint", () => {
    for (const code of ["incomplete:no-dispatch-echo", "timeout", "read-error"]) {
      expect(open(used(code))[0]?.summary).toBe(earlier(code));
    }
    let record = noted(run());
    record = failedTry(record, at(1000), LOST_CODE);
    const begun = beginTries(record, at(10_000), alertIdFor);
    const one = begun.started[0];
    if (!one) throw new Error("no try was due");
    const healed = finishTries(
      begun.change.next,
      [{ key: one.key, generation: one.generation, ok: true, observedAt: at(10_000) }],
      at(10_000),
      alertIdFor,
    );
    expect(open(healed.next)[0]?.summary.startsWith("读取恢复，报告未入账，请 kick")).toBe(true);
    expect(open(healed.next)[0]?.summary).not.toContain("OK");
  });

  test("an alert the earlier wording wrote is taken down by the new code when its item is over", () => {
    const record = used(LOST_CODE);
    const fresh = open(record)[0];
    if (!fresh) throw new Error("no alert");
    // The ledger as the version before wrote it: the old text under the id of the old text.
    const old = structuredClone(record);
    old.alerts = [
      { ...fresh, alertId: alertIdFor(earlier(LOST_CODE)), summary: earlier(LOST_CODE) },
    ];
    expect(alertIdFor(earlier(LOST_CODE))).not.toBe(fresh.alertId);

    // The reply is no longer waited for: the sweep ends the item's alert, whichever wording it has.
    const over = structuredClone(old);
    const assignment = over.assignments.find((entry) => entry.assignmentId === ASSIGNMENT_T2);
    if (!assignment) throw new Error("no assignment");
    assignment.state = "ended";
    const swept = sweepReadRetries(over, new Set(), at(20_000), alertIdFor);
    expect(swept.changed).toBe(true);
    expect(swept.next.alerts.map((alert) => alert.state)).toEqual(["resolved"]);

    // So does the end of the Run.
    const finished = structuredClone(old);
    finished.lifecycle = "cancelled";
    const ended = sweepReadRetries(finished, new Set(), at(20_000), alertIdFor);
    expect(ended.next.alerts.map((alert) => alert.state)).toEqual(["resolved"]);

    // And an alert of the new wording is taken down the same way.
    const modern = structuredClone(record);
    modern.lifecycle = "cancelled";
    expect(
      sweepReadRetries(modern, new Set(), at(20_000), alertIdFor).next.alerts.map((a) => a.state),
    ).toEqual(["resolved"]);
  });

  test("an item that is used up while the earlier wording is still open does not open a second alert", () => {
    let record = noted(run());
    record = failedTry(record, at(1000), LOST_CODE);
    record = failedTry(record, at(3000), LOST_CODE);
    // The earlier version had already written this item's alert.
    record = structuredClone(record);
    record.alerts.push({
      alertId: alertIdFor(earlier(LOST_CODE)),
      state: "open",
      severity: "warning",
      summary: earlier(LOST_CODE),
      createdAt: at(3000),
      acknowledgedAt: null,
      resolvedAt: null,
    });
    const after = failedTry(record, at(7000), LOST_CODE);
    expect(heldItem(after).state).toBe("held");
    expect(after.alerts).toHaveLength(1);
    expect(after.alerts[0]?.summary).toBe(earlier(LOST_CODE));
    expect(open(after)).toHaveLength(1);
  });
});

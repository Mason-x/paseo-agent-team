import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCancelFinisher } from "../../server/run-engine/cancel";
import { createCompactor } from "../../server/run-engine/compact";
import { createRunControl } from "../../server/run-engine/control";
import { createDagIntake } from "../../server/run-engine/dag";
import { createEngineDriver } from "../../server/run-engine/driver";
import { createEffects } from "../../server/run-engine/effects";
import { createObserverHost } from "../../server/run-engine/host";
import { createIntake } from "../../server/run-engine/intake";
import { createMemberLostSettler } from "../../server/run-engine/member-lost";
import { createRunObserver } from "../../server/run-engine/observer";
import { createReadRetry, type ReadFailure } from "../../server/run-engine/read-retry";
import { createEngineService } from "../../server/run-engine/service";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import type { CompactionLimits } from "../../shared/domain/run-engine/compaction";
import { REPO_ALIAS } from "../../shared/domain/run-engine/dag-admission";
import {
  answerableActions,
  answerDecision,
  decisionKindOf,
} from "../../shared/domain/run-engine/decision-answer";
import { compileEngineIntent } from "../../shared/domain/run-engine/engine-prompts";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import { isEngineSettled } from "../../shared/domain/run-engine/lost-turn";
import { compileDispatch } from "../../shared/domain/run-engine/prompt-template";
import { emptyReadRetries, readReadRetries } from "../../shared/domain/run-engine/read-retry";
import { reduceRun } from "../../shared/domain/run-engine/reducer";
import type { PaseoEnginePort, PortTimelinePage } from "../../shared/paseo/port";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { PROFILE_HAIKU, task } from "../fixtures/run-engine/base";
import {
  bootstrapRun,
  COORDINATOR_AGENT,
  dagBlock,
  PLAN_MESSAGE_ID,
  planTasks,
} from "./support/bootstrap-run";
import { JUDGE_SEAT_REVIEW, JUDGE_SEAT_SMOKE } from "./support/review-run";

/**
 * T9b: the host said the turn ended and then lost it: closing or archiving the member (--force, or the
 * cascade of archiving its coordinator), or stopping the daemon, sends `turn_ended` first (DEV, plan point
 * 82). The reply of that turn cannot be found, so the reads of it are used up with
 * `incomplete:dispatch-not-found` and the Engine had only a warning. A look at least 30 seconds after that
 * (a kick, a hook or a recovery; no timer) that proves the turn over (the very proof a cancellation takes),
 * finds the member idle, closed or archived and the dispatch still missing, opens the decision in one
 * commit and takes the warning down: `member-lost` (cancel only) when the member was closed or archived,
 * `host-lost` (retry or cancel) otherwise. A `closed` receipt alone is not the member gone (T9d): a
 * graceful stop of the daemon writes one for every agent, and the member is idle again after the restart.
 * It writes no receipt, releases nothing and sends nothing; a reply that becomes readable later is never
 * taken in.
 *
 * Run through the paths production takes (a person's kick, a recovery, a hook), with the clock the
 * settler and the re-checks share held by the test, so the 30 seconds are never a real wait.
 */

const RUN_ID = "run-lostreply-a1";
const MEMBER = "agent-b1";
const OTHER = "agent-b2";
const LOST_CODE = "incomplete:dispatch-not-found";
const LOST_TURN = "turn-lost-1";

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
  home = await realpath(await mkdtemp(path.join(tmpdir(), "run-lostreply-")));
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
  vi.useRealTimers();
  if (!ready) return;
  ready = false;
  await store.close().catch(() => undefined);
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// --- a host whose history of an agent the test can lose -------------------------------------------

type PortTimelineEntry = PortTimelinePage["entries"][number];
type Sent = { agentId: string; text: string; messageId: string };

function fakeHost() {
  const timelines = new Map<string, PortTimelineEntry[]>();
  const kept = new Map<string, PortTimelineEntry[]>();
  const turns = new Map<string, string>();
  const sent: Sent[] = [];
  const calls = { archives: 0 };
  const runningAgents = new Set<string>();
  const closedAgents = new Set<string>();
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
  const state = (agentId: string) => {
    if (closedAgents.has(agentId)) {
      return { status: "closed", activeTurn: null, pendingPermissions: [] };
    }
    const running = runningAgents.has(agentId);
    return {
      status: running ? "running" : "idle",
      activeTurn: running ? { id: turns.get(agentId) } : null,
      pendingPermissions: [],
    };
  };
  const port: PaseoEnginePort = {
    agents: {
      ref: (agentId) => ({
        send: async (text, options) => {
          const messageId = options?.messageId ?? "";
          sent.push({ agentId, text, messageId });
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
    closedAgents,
    /** The host restarted and lost the history of an agent, the turn it was in included. */
    dropTimeline: (agentId: string) => {
      kept.set(agentId, timelines.get(agentId) ?? []);
      timelines.set(agentId, []);
    },
    /** The history comes back (what a later look finds if the host had it all along). */
    restoreTimeline: (agentId: string) => {
      timelines.set(agentId, kept.get(agentId) ?? []);
    },
    planRequestSent: () =>
      add(COORDINATOR_AGENT, "turn-plan", { type: "user_message", messageId: PLAN_MESSAGE_ID }),
    addUserMessage: (agentId: string, turnId: string, messageId: string) =>
      add(agentId, turnId, { type: "user_message", messageId }),
    reply: (agentId: string, text: string) =>
      add(agentId, turns.get(agentId) ?? "turn-plan", { type: "assistant_message", text }),
    turnOf: (agentId: string) => turns.get(agentId) ?? "turn-plan",
    lastSent: (agentId: string) => [...sent].reverse().find((entry) => entry.agentId === agentId),
    sentTo: (agentId: string) => sent.filter((entry) => entry.agentId === agentId).length,
  };
}

type Host = ReturnType<typeof fakeHost>;

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The wiring as production makes it. Every part reads one clock the test holds: it moves one
 * millisecond with each reading (so what happens later is later) and the test moves it by whole seconds.
 * Nothing here waits for real time.
 */
function build(
  host: Host,
  options: {
    /** What the settler reads the reply through, when it is not the host itself. */
    settleHost?: PaseoEnginePort;
    /** Fold the history into the checkpoint at every pass, as far as the rules allow. */
    compaction?: Partial<CompactionLimits>;
  } = {},
) {
  const clock = { at: Date.now() };
  const clk = {
    now: () => {
      clock.at += 1;
      return iso(clock.at);
    },
  };
  const readHost = createObserverHost(host.port);
  const settleHost =
    options.settleHost === undefined ? readHost : createObserverHost(options.settleHost);
  const retry = createReadRetry({
    store,
    clock: clk,
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
  const observer = createRunObserver({ store, onReadFailure, clock: clk });
  const effects = createEffects({
    store,
    port: host.port,
    compile: compileEngineIntent,
    resolveWorkspace: () => ({ workspaceId: "ws-start", directory: repoDir }),
    onReadFailure,
    clock: clk,
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
    clock: clk,
  });
  const intake = createIntake({
    store,
    observer,
    host: observerHost,
    onReadFailure,
    repair: { send: (runId) => effects.runOutbox(runId) },
    clock: clk,
  });
  const dagIntake = createDagIntake({
    store,
    host: observerHost,
    seatFamily: () => null,
    resolveWorkspace,
    repair: { send: (runId) => effects.runOutbox(runId) },
    clock: clk,
  });
  const settler = createMemberLostSettler({
    store,
    readSeat,
    readReply: (agentId, messageId) => settleHost.replyWindow(agentId, messageId),
    onReadFailure,
    clock: clk,
  });
  const driver = createEngineDriver({
    store,
    observer,
    host: observerHost,
    intake,
    dagIntake,
    service,
    clock: clk,
    onPassed: (runId) => retry.sweep(runId),
    ...(options.compaction === undefined
      ? {}
      : { compactor: createCompactor({ store, clock: clk, limits: options.compaction }) }),
    memberLost: settler,
    cancelFinisher: createCancelFinisher({ store, readSeat, onReadFailure, clock: clk }),
    reconcileHost: createObserverHost(host.port, { requireIdle: true }),
  });
  const control = createRunControl({
    store,
    ensureReady: async () => undefined,
    driver,
    clock: clk,
  });
  return { driver, retry, clock, control, settler };
}

type Built = ReturnType<typeof build>;

async function stored(): Promise<RunRecord> {
  const read = await store.get(RUN_ID);
  if (read.status !== "ok") throw new Error(`run unreadable: ${read.status}`);
  return read.record;
}

const states = (record: RunRecord) =>
  Object.fromEntries(record.tasks.map((task) => [task.spec.id, task.state]));
const engineReceipts = (record: RunRecord) =>
  record.eventReceipts.filter((receipt) => isEngineSettled(receipt));
/** The turn ends on the ledger for one turn of one agent (the fixture has ones of its own). */
const endsOf = (record: RunRecord, turnId = LOST_TURN, agentId = MEMBER) =>
  record.eventReceipts.filter(
    (receipt) =>
      receipt.kind === "turn_ended" && receipt.agentId === agentId && receipt.turnId === turnId,
  );
const openDecisions = (record: RunRecord) =>
  record.decisions.filter((decision) => decision.state === "open");
const items = (record: RunRecord) => {
  const block = readReadRetries(record);
  if (block.kind !== "valid") throw new Error(`block is ${block.kind}`);
  return block.items;
};

// --- what the scripted agents do -------------------------------------------------------------------

function section<T>(text: string, label: string): T {
  const lines = text.split("\n");
  const index = lines.indexOf(label);
  if (index < 0) throw new Error(`no section ${label} in the prompt`);
  return JSON.parse(lines[index + 1] ?? "") as T;
}

type Identity = { taskId: string; attempt: number; messageId?: string; [key: string]: unknown };
type Facts = { repoRoot: string; evidenceDir: string; workspace: unknown };
type TaskData = {
  scopes: { path: string }[];
  evidence: { id: string; command: string | null }[];
};

function fence(kind: string, body: unknown): string {
  return `Done.\n\`\`\`${kind}\n${JSON.stringify(body)}\n\`\`\`\n`;
}

/** The member does the work for real: edits a file, commits it, and reports from its prompt. */
function produce(host: Host, agentId: string): void {
  const prompt = host.lastSent(agentId)?.text ?? "";
  const identity = section<Identity>(prompt, "【身份资料 JSON】");
  const facts = section<Facts>(prompt, "【执行事实 JSON】");
  const task = section<TaskData>(prompt, "【任务资料 JSON】");
  const file = task.scopes[0]?.path ?? "";
  const full = path.join(facts.repoRoot, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, `export const ${identity.taskId} = ${identity.attempt};\n`);
  git(facts.repoRoot, "add", "--", file);
  git(facts.repoRoot, "commit", "-q", "-m", `deliver ${identity.taskId}`);
  const ref = { kind: "git-commit", value: git(facts.repoRoot, "rev-parse", "HEAD") };
  const { messageId: _unused, ...id } = identity;
  host.reply(
    agentId,
    fence("task-report", {
      ...id,
      status: "done",
      changedFiles: [file],
      ref,
      workspace: facts.workspace,
      evidence: task.evidence.map((requirement) => ({
        id: requirement.id,
        command: requirement.command,
        exitCode: 0,
        summary: "passed",
        artifactPath: `${facts.evidenceDir}/${requirement.id}.log`,
        ref,
        isolation: { homePath: path.join(home, "isolated-home"), outsideRealHome: true },
      })),
    }),
  );
}

const planText = () => fence("task-dag", dagBlock(RUN_ID, planTasks(REPO_ALIAS)));

/** Writes a receipt of the host with a time the test chooses, the way the observer records one. */
async function plantReceipt(
  kind: "turn_started" | "turn_ended",
  agentId: string,
  turnId: string,
  receivedAt: string,
  occurrence = 1,
) {
  await store.update(RUN_ID, (current) => {
    const key = `${kind}:${agentId}:${turnId}${occurrence > 1 ? `#${occurrence}` : ""}`;
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

const createdOf = async (taskId = "t1") =>
  (await stored()).assignments.find((entry) => entry.taskId === taskId)?.createdAt ?? "";

/** When the re-check of the lost reply was used up, as the ledger says (milliseconds). */
function heldAtOf(record: RunRecord): number {
  const held = record.events.filter(
    (event) =>
      event.kind === "read-retry-changed" && (event.payload as { state?: string }).state === "held",
  );
  const last = held.at(-1);
  if (last === undefined) return Number.NaN;
  return Date.parse(last.at);
}

const kick = (built: Built) =>
  built.control.kick({ runContractVersion: 1 as const, runId: RUN_ID });

async function decide(built: Built, decisionId: string, action: "retry" | "cancel") {
  const before = await stored();
  const out = await built.control.decide({
    runContractVersion: 1 as const,
    runId: RUN_ID,
    decisionId,
    requestId: `answer-${action}`,
    expectedRevision: before.revision,
    reason: "the host lost the turn",
    answer: { action },
  });
  await built.control.idle();
  return out;
}

async function askForCancel(built: Built, requestId = "cancel-1") {
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

/** The same look, three ways: a person's kick, a recovery, a hook that kicks the Run. */
async function lookAgain(built: Built, via: "kick" | "recover" | "hook") {
  if (via === "kick") await kick(built);
  else if (via === "recover") await built.driver.recover();
  else
    await built.driver.onHook({
      name: "agent.permission_resolved",
      agentId: MEMBER,
      requestId: "p1",
    });
  await built.control.idle();
}

/**
 * The receipts the host gave in the orders DEV saw (dev-report.md L1, L2 and R). The reply of the
 * member's turn is then read from a host that has lost the history, so the reads of it are used up.
 *  - L1: `turn_ended`, `archived`, `closed` (a forced archive of the member).
 *  - L2: `archived`, `turn_ended`, `closed` (the cascade of archiving its coordinator).
 *  - R: `turn_ended` only; after the restart the member is idle (a graceful daemon stop, no closed receipt).
 *  - RC: `turn_ended`, `closed`; after the restart the member is idle (a graceful stop as DEV saw it, T9d).
 *  - RA: RC, and then the member took another turn after the restart (the OK of A21) that ended too.
 * Returns when the reads were used up, in milliseconds on the test clock.
 */
type Order = "L1" | "L2" | "R" | "RC" | "RA";

async function reachReplyLost(host: Host, built: Built, order: Order): Promise<number> {
  host.planRequestSent();
  host.reply(COORDINATOR_AGENT, planText());
  await built.driver.onHook({
    name: "agent.turn_ended",
    agentId: COORDINATOR_AGENT,
    turnId: host.turnOf(COORDINATOR_AGENT),
  });
  expect(states(await stored())).toEqual({ t1: "assigned", t2: "pending" });
  expect(host.sentTo(MEMBER)).toBe(1);
  const turnId = host.turnOf(MEMBER);
  await built.driver.onHook({ name: "agent.turn_started", agentId: MEMBER, turnId });
  // The host lost the history: the dispatch is no longer there.
  host.dropTimeline(MEMBER);
  const ended = () => built.driver.onHook({ name: "agent.turn_ended", agentId: MEMBER, turnId });
  const archived = () => built.driver.onHook({ name: "agent.archived", agentId: MEMBER });
  const closed = () => built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
  if (order === "L1") {
    await ended();
    await archived();
    await closed();
    host.closedAgents.add(MEMBER);
  } else if (order === "L2") {
    await archived();
    await ended();
    await closed();
    host.closedAgents.add(MEMBER);
  } else if (order === "RC") {
    await ended();
    await closed();
  } else if (order === "RA") {
    await ended();
    await closed();
    // After the restart the member took another turn that ended too, and its id came back (the host
    // numbers turns per session): the observer of a restarted daemon records it as the second appearance
    // (`#2`, T9a; turn-reuse.test.ts), planted here because this test's observer lives through the stop.
    await plantReceipt("turn_started", MEMBER, turnId, iso(built.clock.at), 2);
    await plantReceipt("turn_ended", MEMBER, turnId, iso(built.clock.at + 1), 2);
    // The turn id came back (the host numbers turns per session): the second appearance is `#2` (T9a).
    const again = await stored();
    expect(endsOf(again, turnId).map((receipt) => receipt.eventKey)).toEqual([
      `turn_ended:${MEMBER}:${turnId}`,
      `turn_ended:${MEMBER}:${turnId}#2`,
    ]);
  } else {
    await ended();
  }
  for (const wait of [1500, 2500, 4500]) {
    built.clock.at += wait;
    await built.retry.fire();
  }
  const held = heldAtOf(await stored());
  return Number.isNaN(held) ? built.clock.at : held;
}

/** What the decision for each order should be. */
const KIND: Record<Order, "member-lost" | "host-lost"> = {
  L1: "member-lost",
  L2: "member-lost",
  R: "host-lost",
  RC: "host-lost",
  RA: "host-lost",
};

/** Marks the used-up re-check with another reason, the way a different failure would have left it. */
async function setHeldCode(code: string): Promise<void> {
  await store.update(RUN_ID, (current) => {
    const next = structuredClone(current);
    const block = (next as unknown as { readRetries: { items: { lastCode?: string }[] } })
      .readRetries;
    for (const item of block.items) item.lastCode = code;
    return next;
  });
}

const alertStates = (record: RunRecord) => record.alerts.map((alert) => alert.state);

type ReviewOrder = "archived-first" | "closed" | "no-closed" | "killed";

async function reachLostReview(host: Host, built: Built, order: ReviewOrder): Promise<number> {
  host.planRequestSent();
  host.reply(COORDINATOR_AGENT, planText());
  await built.driver.onHook({
    name: "agent.turn_ended",
    agentId: COORDINATOR_AGENT,
    turnId: host.turnOf(COORDINATOR_AGENT),
  });
  const producerTurn = host.turnOf(MEMBER);
  await built.driver.onHook({ name: "agent.turn_started", agentId: MEMBER, turnId: producerTurn });
  produce(host, MEMBER);
  await built.driver.onHook({ name: "agent.turn_ended", agentId: MEMBER, turnId: producerTurn });
  await built.control.idle();
  expect(host.sentTo(OTHER)).toBe(1);
  expect(states(await stored()).t1).toBe("review");

  const reviewTurn = host.turnOf(OTHER);
  await built.driver.onHook({ name: "agent.turn_started", agentId: OTHER, turnId: reviewTurn });
  host.dropTimeline(OTHER);
  if (order === "archived-first") {
    await built.driver.onHook({ name: "agent.archived", agentId: OTHER });
  }
  if (order !== "killed") {
    await built.driver.onHook({ name: "agent.turn_ended", agentId: OTHER, turnId: reviewTurn });
  }
  if (order === "closed") await built.driver.onHook({ name: "agent.closed", agentId: OTHER });
  if (order === "killed") await built.driver.recover();
  for (const wait of [1500, 2500, 4500]) {
    built.clock.at += wait;
    await built.retry.fire();
  }
  const held = heldAtOf(await stored());
  return Number.isNaN(held) ? built.clock.at : held;
}

function acceptReview(host: Host): void {
  const prompt = host.lastSent(OTHER)?.text ?? "";
  const { messageId: _unused, ...identity } = section<Identity>(prompt, "【身份资料 JSON】");
  const facts = section<{ delivery: { deliveryRef: unknown } }>(prompt, "【执行事实 JSON】");
  host.reply(
    OTHER,
    fence("review-report", {
      ...identity,
      reviewedRef: facts.delivery.deliveryRef,
      verdict: "可合入",
      blockers: [],
      probes: [],
    }),
  );
}

for (const schema of [1, 2] as const) {
  describe(`a review lost after a host restart [v${schema}]`, () => {
    beforeEach(async () => {
      version = schema;
      await setup();
    });

    for (const order of ["archived-first", "closed", "no-closed", "killed"] as const) {
      test(`${order}: settle only when the version has read re-checks`, async () => {
        const host = fakeHost();
        const built = build(host);
        const heldAt = await reachLostReview(host, built, order);
        const before = await stored();
        const sent = host.sent.length;
        built.clock.at = heldAt + 31_000;
        await kick(built);
        await built.control.idle();
        const after = await stored();
        expect(host.sent).toHaveLength(sent);
        if (schema === 1) {
          expect(readReadRetries(after)).toEqual({ kind: "absent" });
          expect(after.revision).toBe(before.revision);
          expect(openDecisions(after)).toEqual([]);
          expect(engineReceipts(after)).toEqual([]);
          return;
        }
        const [decision] = openDecisions(after);
        if (!decision) throw new Error("review decision missing");
        const expected = order === "archived-first" ? "member-lost" : "host-lost";
        expect(decisionKindOf(after, decision)).toBe(expected);
        expect(decision.limbo).toMatchObject({ reason: expected });
        expect(answerableActions(after, decision)).toEqual(
          expected === "member-lost" ? ["cancel"] : ["retry", "cancel"],
        );
        expect(engineReceipts(after)).toHaveLength(order === "killed" ? 1 : 0);
        expect(after.resources).toEqual(before.resources);
        expect(checkLedgerInvariants(after).ok).toBe(true);
      });
    }

    if (schema === 2) {
      test("retry preserves the delivery and counts, debits one review, permits a second loss, and eventually accepts a review", async () => {
        const host = fakeHost();
        const built = build(host);
        const heldAt = await reachLostReview(host, built, "closed");
        built.clock.at = heldAt + 31_000;
        await kick(built);
        const before = await stored();
        const [firstDecision] = openDecisions(before);
        const producer = before.assignments.find((entry) => entry.purpose === "member");
        const firstReview = before.assignments.find((entry) => entry.purpose === "reviewer");
        const originalTask = before.tasks.find((entry) => entry.spec.id === "t1");
        const budget = before.budgets.entries.find(
          (entry) => entry.subjectId === JUDGE_SEAT_REVIEW,
        );
        if (!firstDecision || !producer || !firstReview || !originalTask || !budget)
          throw new Error("missing review facts");
        const out = await decide(built, firstDecision.decisionId, "retry");
        expect(out).toMatchObject({ status: "applied", issues: [] });
        const retried = await stored();
        expect(host.sentTo(OTHER)).toBe(2);
        expect(retried.assignments.filter((entry) => entry.purpose === "reviewer")).toHaveLength(2);
        expect(
          retried.assignments.find((entry) => entry.assignmentId === producer.assignmentId),
        ).toEqual(producer);
        expect(
          retried.assignments.find((entry) => entry.assignmentId === firstReview.assignmentId),
        ).toMatchObject({ state: "ended", acceptedProof: null });
        expect(
          retried.nonceRegistry.find((entry) => entry.assignmentId === firstReview.assignmentId),
        ).toMatchObject({ acceptedAt: null, revokeReason: "abandoned-by-retry" });
        expect(retried.resources).toEqual(before.resources);
        expect(retried.tasks.find((entry) => entry.spec.id === "t1")).toMatchObject({
          state: "review",
          attempts: originalTask.attempts,
          reworkCount: originalTask.reworkCount,
          qualityFailures: originalTask.qualityFailures,
        });
        expect(
          retried.budgets.entries.find((entry) => entry.subjectId === JUDGE_SEAT_REVIEW)?.reserved,
        ).toBe(budget.reserved + 1);
        expect(checkLedgerInvariants(retried).ok).toBe(true);
        host.runningAgents.add(OTHER);
        await kick(built);
        expect(host.sentTo(OTHER)).toBe(2);

        const secondTurn = host.turnOf(OTHER);
        await built.driver.onHook({
          name: "agent.turn_started",
          agentId: OTHER,
          turnId: secondTurn,
        });
        host.dropTimeline(OTHER);
        host.runningAgents.delete(OTHER);
        await built.driver.onHook({ name: "agent.turn_ended", agentId: OTHER, turnId: secondTurn });
        for (const wait of [1500, 2500, 4500]) {
          built.clock.at += wait;
          await built.retry.fire();
        }
        const secondHeld = heldAtOf(await stored());
        built.clock.at = secondHeld + 31_000;
        await kick(built);
        const again = await stored();
        const [secondDecision] = openDecisions(again);
        expect(secondDecision?.decisionId).not.toBe(firstDecision.decisionId);
        expect(secondDecision?.limbo).toMatchObject({ reason: "host-lost" });
        if (!secondDecision) throw new Error("second review decision missing");
        expect((await decide(built, secondDecision.decisionId, "retry")).status).toBe("applied");
        expect(host.sentTo(OTHER)).toBe(3);
        acceptReview(host);
        await built.driver.onHook({
          name: "agent.turn_ended",
          agentId: OTHER,
          turnId: host.turnOf(OTHER),
        });
        const finished = await stored();
        expect(states(finished).t1).toBe("done");
        expect(checkLedgerInvariants(finished).ok).toBe(true);
      });

      test("retry refuses a lost review if its delivery is missing or bound to another producer", async () => {
        const host = fakeHost();
        const built = build(host);
        const heldAt = await reachLostReview(host, built, "no-closed");
        built.clock.at = heldAt + 31_000;
        await kick(built);
        const before = await stored();
        const [decision] = openDecisions(before);
        if (!decision) throw new Error("review decision missing");
        const mismatch = structuredClone(before);
        const review = mismatch.assignments.find((entry) => entry.purpose === "reviewer");
        if (!review?.delivery) throw new Error("review delivery missing");
        review.delivery.producerAssignmentId = "another-producer";
        const missing = structuredClone(before);
        const producer = missing.assignments.find((entry) => entry.purpose === "member");
        if (!producer) throw new Error("producer missing");
        producer.acceptedProof = null;
        for (const record of [mismatch, missing]) {
          const snapshot = structuredClone(record);
          const result = answerDecision(record, {
            decisionId: decision.decisionId,
            requestId: "stale-review-retry",
            expectedRevision: record.revision,
            reason: "check stale delivery",
            action: "retry",
            now: iso(built.clock.at),
          });
          expect(result).toEqual({
            ok: false,
            code: "task-not-releasable",
            reason: "delivery-missing",
          });
          expect(record).toEqual(snapshot);
        }
        expect(host.sentTo(OTHER)).toBe(1);
      });

      test("retry dispatches a review even when the failed-task gate is exceeded", async () => {
        const host = fakeHost();
        const built = build(host);
        const heldAt = await reachLostReview(host, built, "no-closed");
        built.clock.at = heldAt + 31_000;
        await kick(built);
        await store.update(RUN_ID, (current) => {
          const next = structuredClone(current);
          next.tasks.unshift(task("ready-1", "Waiting task", { state: "ready" }));
          for (let index = 0; index <= next.policy.run.failedTasks; index += 1) {
            next.tasks.push(task(`failed-${index}`, "Failed task", { state: "failed" }));
          }
          return next;
        });
        const [decision] = openDecisions(await stored());
        if (!decision) throw new Error("review decision missing");
        expect((await decide(built, decision.decisionId, "retry")).status).toBe("applied");
        expect(host.sentTo(OTHER)).toBe(2);
        expect(states(await stored())["ready-1"]).toBe("ready");
      });

      test("cancel still cancels a task with a lost review", async () => {
        const host = fakeHost();
        const built = build(host);
        const heldAt = await reachLostReview(host, built, "no-closed");
        built.clock.at = heldAt + 31_000;
        await kick(built);
        const [decision] = openDecisions(await stored());
        if (!decision) throw new Error("review decision missing");
        expect((await decide(built, decision.decisionId, "cancel")).status).toBe("applied");
        expect(states(await stored())).toEqual({ t1: "cancelled", t2: "cancelled" });
        expect(host.sentTo(OTHER)).toBe(1);
      });
    }
  });
}

for (const schema of [1, 2] as const) {
  describe(`a reply the host lost after it said the turn ended is settled [v${schema}]`, () => {
    beforeEach(async () => {
      version = schema;
      await setup();
    });

    // --- the orders DEV saw -----------------------------------------------------------------------

    for (const order of ["L1", "L2", "R", "RC", "RA"] as const) {
      test(`${order}: used up; at 29 seconds nothing, at 31 exactly one decision (${KIND[order]}) and the alert is down; kicking again writes nothing; no receipt, no message, no archive`, async () => {
        const host = fakeHost();
        const built = build(host);
        const heldAt = await reachReplyLost(host, built, order);
        const lost = await stored();
        expect(states(lost)).toEqual({ t1: "assigned", t2: "pending" });
        expect(endsOf(lost, host.turnOf(MEMBER))).toHaveLength(order === "RA" ? 2 : 1);
        if (schema === 2) {
          expect(items(lost)[0]).toMatchObject({ state: "held", lastCode: LOST_CODE });
          expect(alertStates(lost)).toEqual(["open"]);
          expect(lost.alerts[0]?.summary).toContain("至少等 30 秒");
        } else {
          expect(readReadRetries(lost)).toEqual({ kind: "absent" });
        }
        const sentBefore = host.sent.length;

        // 29 seconds after the last failure: not yet. Nothing is written.
        built.clock.at = heldAt + 29_000;
        await kick(built);
        const quiet = await stored();
        expect(quiet.revision).toBe(lost.revision);
        expect(openDecisions(quiet)).toEqual([]);

        // 31 seconds: one look settles it, once.
        built.clock.at = heldAt + 31_000;
        await kick(built);
        const settled = await stored();
        expect(host.sent).toHaveLength(sentBefore);
        expect(host.calls.archives).toBe(0);
        // No receipt of the Engine's in any case: the host's own end is the evidence.
        expect(engineReceipts(settled)).toEqual([]);
        expect(endsOf(settled, host.turnOf(MEMBER))).toHaveLength(order === "RA" ? 2 : 1);
        if (schema === 1) {
          expect(settled.revision).toBe(lost.revision);
          expect(openDecisions(settled)).toEqual([]);
          return;
        }
        const decisions = openDecisions(settled);
        expect(decisions).toHaveLength(1);
        const [decision] = decisions;
        if (decision === undefined) throw new Error("no decision");
        expect(decision).toMatchObject({
          category: "D1",
          subjectId: "t1",
          dedupeKey: expect.stringMatching(/^stuck:/u),
          limbo: {
            turnId: host.turnOf(MEMBER),
            reason: KIND[order],
            // The proof takes the newest end: for RA the one of the turn after the restart.
            endedEventKey: `turn_ended:${MEMBER}:${host.turnOf(MEMBER)}${order === "RA" ? "#2" : ""}`,
          },
        });
        expect(decision.summary).toContain("回复已丢失");
        expect(decision.summary).toContain("成员可能已做完一部分");
        expect(decision.summary).toContain("先看它的分支");
        expect(decision.summary).toContain("确认它的进程已经停了");
        expect(decisionKindOf(settled, decision)).toBe(KIND[order]);
        expect(answerableActions(settled, decision)).toEqual(
          KIND[order] === "member-lost" ? ["cancel"] : ["retry", "cancel"],
        );
        expect(alertStates(settled)).toEqual(["resolved"]);
        expect(settled.tasks.find((task) => task.spec.id === "t1")?.waitingReason).toBe(
          KIND[order],
        );
        // Nothing is released: the task keeps its state and its claims.
        expect(states(settled)).toEqual({ t1: "assigned", t2: "pending" });
        expect(settled.resources).toEqual(lost.resources);
        expect(checkLedgerInvariants(settled).ok).toBe(true);
        expect(settled.schemaVersion).toBe(2);

        // Looking again, any way there is, writes nothing and sends nothing.
        await lookAgain(built, "hook");
        const hooked = await stored();
        for (const via of ["kick", "recover", "hook", "kick"] as const) {
          built.clock.at += 40_000;
          await lookAgain(built, via);
        }
        const again = await stored();
        expect(again.revision).toBe(hooked.revision);
        expect(openDecisions(again)).toHaveLength(1);
        expect(host.sent).toHaveLength(sentBefore);
        expect(host.calls.archives).toBe(0);
      });
    }

    test("the kind follows the receipts, not only the read: a member that reads idle but was archived after the task was sent gets member-lost", async () => {
      const host = fakeHost();
      const built = build(host);
      const heldAt = await reachReplyLost(host, built, "R");
      // The host archived it (a receipt), and the member reads as idle again.
      await built.driver.onHook({ name: "agent.archived", agentId: MEMBER });
      built.clock.at = heldAt + 31_000;
      await kick(built);
      const settled = await stored();
      if (schema === 1) {
        expect(openDecisions(settled)).toEqual([]);
        return;
      }
      const [decision] = openDecisions(settled);
      expect(decision?.limbo).toMatchObject({ reason: "member-lost" });
    });

    test("a member the host reads as closed, with no closed receipt on the ledger, gets member-lost", async () => {
      const host = fakeHost();
      const built = build(host);
      const heldAt = await reachReplyLost(host, built, "R");
      host.closedAgents.add(MEMBER);
      built.clock.at = heldAt + 31_000;
      await kick(built);
      const settled = await stored();
      if (schema === 1) {
        expect(openDecisions(settled)).toEqual([]);
        return;
      }
      expect(openDecisions(settled)).toHaveLength(1);
      expect(openDecisions(settled)[0]?.limbo).toMatchObject({ reason: "member-lost" });
      // No receipt says it was closed, so only the kind of decision says it can only be cancelled.
      expect(answerableActions(settled, openDecisions(settled)[0] as never)).toEqual(["cancel"]);
      expect(engineReceipts(settled)).toEqual([]);
    });

    test("a recovery of the daemon (no hook, no kick) settles it the same way, once", async () => {
      const host = fakeHost();
      const built = build(host);
      const heldAt = await reachReplyLost(host, built, "R");
      built.clock.at = heldAt + 31_000;
      await built.driver.recover();
      await built.control.idle();
      const settled = await stored();
      expect(openDecisions(settled)).toHaveLength(schema === 2 ? 1 : 0);
      const revision = settled.revision;
      built.clock.at += 60_000;
      await built.driver.recover();
      expect((await stored()).revision).toBe(revision);
    });

    // --- what does not open a decision ------------------------------------------------------------

    describe("what is not evidence that the reply was lost opens nothing", () => {
      async function stays(host: Host, built: Built, heldAt: number, extra = 0) {
        const before = await stored();
        const sent = host.sent.length;
        built.clock.at = heldAt + 31_000 + extra;
        await kick(built);
        await built.driver.recover();
        await built.control.idle();
        const after = await stored();
        expect(openDecisions(after)).toEqual([]);
        expect(engineReceipts(after)).toEqual([]);
        expect(after.revision).toBe(before.revision);
        expect(host.sent).toHaveLength(sent);
        expect(host.calls.archives).toBe(0);
      }

      for (const code of [
        "incomplete:too-large",
        "incomplete:turn-unknown",
        "incomplete:timeline-discontinuity",
        "incomplete:epoch-changed",
        "interrupted",
        "read-error",
        "ECONNRESET",
      ]) {
        test(`the re-checks used up for another reason (${code}) keep only the warning`, async () => {
          const host = fakeHost();
          const built = build(host);
          const heldAt = await reachReplyLost(host, built, "L1");
          if (schema === 2) await setHeldCode(code);
          await stays(host, built, heldAt);
        });
      }

      test("a member the host reports as working is not at rest; once it is idle the same look settles", async () => {
        const host = fakeHost();
        const built = build(host);
        const heldAt = await reachReplyLost(host, built, "R");
        host.runningAgents.add(MEMBER);
        await stays(host, built, heldAt);
        host.runningAgents.delete(MEMBER);
        built.clock.at = heldAt + 33_000;
        await kick(built);
        expect(openDecisions(await stored())).toHaveLength(schema === 2 ? 1 : 0);
      });

      test("a turn that began after the end means the member works again: nothing opens", async () => {
        const host = fakeHost();
        const built = build(host);
        const heldAt = await reachReplyLost(host, built, "R");
        const created = Date.parse(await createdOf());
        await plantReceipt("turn_started", MEMBER, "turn-again", iso(created + 600_000));
        await stays(host, built, heldAt);
      });

      for (const state of ["outcome-unknown", "sending"] as const) {
        test(`a message to the member that is ${state} may still start a turn`, async () => {
          const host = fakeHost();
          const built = build(host);
          const heldAt = await reachReplyLost(host, built, "R");
          await store.update(RUN_ID, (current) => {
            const next = structuredClone(current);
            const dispatch = next.outbox.find((intent) => intent.kind === "dispatch");
            if (dispatch === undefined) throw new Error("no dispatch");
            next.outbox.push({
              ...structuredClone(dispatch),
              id: "intent-unsettled-1",
              kind: "wake",
              messageId: "00000000-0000-4000-8000-0000000000aa",
              idempotencyKey: "wake-unsettled-1",
              state,
              confirmedAt: null,
            } as never);
            return next;
          });
          await stays(host, built, heldAt);
        });
      }
    });

    // --- after the decision --------------------------------------------------------------------------

    test("a reply that becomes readable after the decision opened is never taken in, whatever the way it comes", async () => {
      const host = fakeHost();
      const built = build(host);
      const heldAt = await reachReplyLost(host, built, "R");
      built.clock.at = heldAt + 31_000;
      await kick(built);
      if (schema === 1) return;
      const decided = await stored();
      expect(openDecisions(decided)).toHaveLength(1);
      const sentBefore = host.sent.length;
      // The history is back and holds the member's good report for this very dispatch.
      host.restoreTimeline(MEMBER);
      produce(host, MEMBER);
      await built.driver.onHook({
        name: "agent.turn_ended",
        agentId: MEMBER,
        turnId: host.turnOf(MEMBER),
      });
      for (const via of ["kick", "recover", "hook"] as const) {
        built.clock.at += 40_000;
        await lookAgain(built, via);
      }
      await built.control.idle();
      const after = await stored();
      const first = after.assignments.find((entry) => entry.attempt === 1);
      expect(first?.acceptedProof).toBeNull();
      expect(first?.state).toBe("assigned");
      expect(states(after)).toEqual({ t1: "assigned", t2: "pending" });
      expect(openDecisions(after)).toHaveLength(1);
      expect(openDecisions(after)[0]?.decisionId).toBe(decided.decisions[0]?.decisionId);
      expect(host.sent).toHaveLength(sentBefore);
    });

    test("answered with cancel: the claims are released, the task and what depends on it are cancelled, the Run finishes, nothing is sent or archived", async () => {
      const host = fakeHost();
      const built = build(host);
      const heldAt = await reachReplyLost(host, built, "L1");
      built.clock.at = heldAt + 31_000;
      await kick(built);
      const settled = await stored();
      if (schema === 1) {
        expect(openDecisions(settled)).toEqual([]);
        return;
      }
      expect(settled.resources.length).toBeGreaterThan(0);
      const sentBefore = host.sent.length;
      const [decision] = openDecisions(settled);
      if (decision === undefined) throw new Error("no decision");
      const out = await decide(built, decision.decisionId, "cancel");
      expect({ status: out.status, issues: out.issues }).toEqual({ status: "applied", issues: [] });
      const done = await stored();
      expect(states(done)).toEqual({ t1: "cancelled", t2: "cancelled" });
      expect(done.resources).toEqual([]);
      expect(done.lifecycle).toBe("finished");
      expect(openDecisions(done)).toEqual([]);
      expect(checkLedgerInvariants(done).ok).toBe(true);
      expect(host.sent).toHaveLength(sentBefore);
      expect(host.calls.archives).toBe(0);
      const revision = done.revision;
      await kick(built);
      await built.driver.recover();
      expect((await stored()).revision).toBe(revision);
    });

    test("a member-lost decision cannot be answered with retry", async () => {
      const host = fakeHost();
      const built = build(host);
      const heldAt = await reachReplyLost(host, built, "L2");
      built.clock.at = heldAt + 31_000;
      await kick(built);
      const settled = await stored();
      if (schema === 1) return;
      const [decision] = openDecisions(settled);
      if (decision === undefined) throw new Error("no decision");
      const sentBefore = host.sent.length;
      const out = await decide(built, decision.decisionId, "retry");
      expect(out.status).not.toBe("applied");
      expect(host.sent).toHaveLength(sentBefore);
      expect(openDecisions(await stored())).toHaveLength(1);
    });

    for (const order of ["R", "RC", "RA"] as const) {
      test(`${order}: answered with retry (host-lost): the same member gets exactly one message, not a second one for another look, and its reply is taken in as usual`, async () => {
        const host = fakeHost();
        const built = build(host);
        const heldAt = await reachReplyLost(host, built, order);
        built.clock.at = heldAt + 31_000;
        await kick(built);
        const settled = await stored();
        if (schema === 1) {
          expect(openDecisions(settled)).toEqual([]);
          return;
        }
        const [decision] = openDecisions(settled);
        if (decision === undefined) throw new Error("no decision");
        expect(host.sentTo(MEMBER)).toBe(1);

        const out = await decide(built, decision.decisionId, "retry");
        expect({ status: out.status, issues: out.issues }).toEqual({
          status: "applied",
          issues: [],
        });
        expect(host.sentTo(MEMBER)).toBe(2);
        expect(host.sentTo(OTHER)).toBe(0);
        expect(host.calls.archives).toBe(0);
        const retried = await stored();
        expect(retried.assignments.filter((entry) => entry.taskId === "t1")).toHaveLength(2);
        expect(retried.assignments.find((entry) => entry.attempt === 1)?.state).toBe("ended");
        expect(openDecisions(retried)).toEqual([]);
        expect(checkLedgerInvariants(retried).ok).toBe(true);

        // The member's new turn begins and it is working: looking again does not send it again.
        host.runningAgents.add(MEMBER);
        await built.driver.onHook({
          name: "agent.turn_started",
          agentId: MEMBER,
          turnId: host.turnOf(MEMBER),
        });
        for (const via of ["kick", "recover", "hook"] as const) {
          built.clock.at += 40_000;
          await lookAgain(built, via);
        }
        expect(host.sentTo(MEMBER)).toBe(2);

        // It does the work and reports: the report is taken in as for any attempt.
        produce(host, MEMBER);
        host.runningAgents.delete(MEMBER);
        await built.driver.onHook({
          name: "agent.turn_ended",
          agentId: MEMBER,
          turnId: host.turnOf(MEMBER),
        });
        await built.control.idle();
        const reported = await stored();
        const second = reported.assignments.find((entry) => entry.attempt === 2);
        expect(second?.acceptedProof).not.toBeNull();
        expect(states(reported).t1).not.toBe("assigned");
        expect(checkLedgerInvariants(reported).ok).toBe(true);
        expect(host.sentTo(MEMBER)).toBe(2);
      });
    }

    test("a closed receipt and a read of closed now: member-lost, cancel only", async () => {
      const host = fakeHost();
      const built = build(host);
      const heldAt = await reachReplyLost(host, built, "RC");
      host.closedAgents.add(MEMBER);
      built.clock.at = heldAt + 31_000;
      await kick(built);
      const settled = await stored();
      if (schema === 1) {
        expect(openDecisions(settled)).toEqual([]);
        return;
      }
      const [decision] = openDecisions(settled);
      expect(decision?.limbo).toMatchObject({ reason: "member-lost" });
      if (decision === undefined) throw new Error("no decision");
      expect(answerableActions(settled, decision)).toEqual(["cancel"]);
    });

    test("a host-lost decision is cut to cancel only when the member is archived afterwards, not by a closed receipt", async () => {
      const host = fakeHost();
      const built = build(host);
      const heldAt = await reachReplyLost(host, built, "RC");
      built.clock.at = heldAt + 31_000;
      await kick(built);
      const opened = await stored();
      if (schema === 1) {
        expect(openDecisions(opened)).toEqual([]);
        return;
      }
      const [decision] = openDecisions(opened);
      if (decision === undefined) throw new Error("no decision");
      expect(decision.limbo).toMatchObject({ reason: "host-lost" });
      expect(answerableActions(opened, decision)).toEqual(["retry", "cancel"]);

      // Another graceful stop: one more closed receipt. The member can still be asked again.
      await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
      const closedAgain = await stored();
      expect(openDecisions(closedAgain)[0]?.decisionId).toBe(decision.decisionId);
      expect(answerableActions(closedAgain, decision)).toEqual(["retry", "cancel"]);

      // Archived after it opened: only cancel, and a retry is refused without a message.
      await built.driver.onHook({ name: "agent.archived", agentId: MEMBER });
      const archived = await stored();
      expect(answerableActions(archived, decision)).toEqual(["cancel"]);
      const sentBefore = host.sent.length;
      const out = await decide(built, decision.decisionId, "retry");
      expect(out.status).not.toBe("applied");
      expect(host.sent).toHaveLength(sentBefore);
      expect(openDecisions(await stored())).toHaveLength(1);
      const cancelled = await decide(built, decision.decisionId, "cancel");
      expect({ status: cancelled.status, issues: cancelled.issues }).toEqual({
        status: "applied",
        issues: [],
      });
      expect(host.sent).toHaveLength(sentBefore);
      expect(host.calls.archives).toBe(0);
    });

    // --- cancelling the whole Run -----------------------------------------------------------------

    test("the whole Run is cancelled but still waits for another delivery: no decision is opened for the lost reply meanwhile", async () => {
      const host = fakeHost();
      const built = build(host);
      const heldAt = await reachReplyLost(host, built, "R");
      // A message to someone else whose fate is unknown keeps the cancellation waiting.
      await store.update(RUN_ID, (current) => {
        const next = structuredClone(current);
        const dispatch = next.outbox.find((intent) => intent.kind === "dispatch");
        if (dispatch === undefined) throw new Error("no dispatch");
        next.outbox.push({
          ...structuredClone(dispatch),
          id: "intent-elsewhere-1",
          kind: "wake",
          taskId: "t9",
          recipient: OTHER,
          assignmentId: null,
          messageId: "00000000-0000-4000-8000-0000000000bb",
          idempotencyKey: "wake-elsewhere-1",
          state: "outcome-unknown",
          confirmedAt: null,
        } as never);
        return next;
      });
      built.clock.at = heldAt + 31_000;
      await askForCancel(built);
      await kick(built);
      const waiting = await stored();
      expect(waiting.lifecycle).toBe("paused");
      expect(openDecisions(waiting)).toEqual([]);
      expect(engineReceipts(waiting)).toEqual([]);
      const revision = waiting.revision;
      await kick(built);
      expect((await stored()).revision).toBe(revision);
    });

    test("the whole Run is cancelled while the reply is lost: the host's own end lets it finish, and no decision is opened", async () => {
      const host = fakeHost();
      const built = build(host);
      const heldAt = await reachReplyLost(host, built, "L1");
      const sentBefore = host.sent.length;
      built.clock.at = heldAt + 31_000;
      await askForCancel(built);
      await kick(built);
      const done = await stored();
      expect(openDecisions(done)).toEqual([]);
      expect(engineReceipts(done)).toEqual([]);
      expect(done.lifecycle).toBe("cancelled");
      expect(states(done)).toEqual({ t1: "cancelled", t2: "cancelled" });
      expect(done.resources).toEqual([]);
      expect(host.sent).toHaveLength(sentBefore);
      expect(host.calls.archives).toBe(0);
    });
  });
}

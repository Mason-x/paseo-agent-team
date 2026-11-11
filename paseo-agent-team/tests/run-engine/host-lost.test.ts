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
import { alertIdFor } from "../../server/run-engine/digest";
import { createEngineDriver } from "../../server/run-engine/driver";
import { createEffects } from "../../server/run-engine/effects";
import { createObserverHost } from "../../server/run-engine/host";
import { createIntake } from "../../server/run-engine/intake";
import { createMemberLostSettler } from "../../server/run-engine/member-lost";
import { createRunObserver } from "../../server/run-engine/observer";
import { projectDetail, projectSummary } from "../../server/run-engine/projection";
import { createReadRetry, type ReadFailure } from "../../server/run-engine/read-retry";
import { createEngineService } from "../../server/run-engine/service";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import type { CompactionLimits } from "../../shared/domain/run-engine/compaction";
import { REPO_ALIAS } from "../../shared/domain/run-engine/dag-admission";
import { answerableActions, decisionKindOf } from "../../shared/domain/run-engine/decision-answer";
import { compileEngineIntent } from "../../shared/domain/run-engine/engine-prompts";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import {
  HOST_LOST_CODE,
  HOST_LOST_OUTCOME,
  isEngineSettled,
  LOST_TURN_SETTLE_DELAY_MS,
} from "../../shared/domain/run-engine/lost-turn";
import { compileDispatch } from "../../shared/domain/run-engine/prompt-template";
import {
  emptyReadRetries,
  readReadRetries,
  readRetryAlertSummary,
} from "../../shared/domain/run-engine/read-retry";
import { reduceRun } from "../../shared/domain/run-engine/reducer";
import { replyAnchor } from "../../shared/domain/run-engine/report-repair";
import type { PaseoEnginePort, PortTimelinePage } from "../../shared/paseo/port";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { PROFILE_HAIKU } from "../fixtures/run-engine/base";
import {
  bootstrapRun,
  COORDINATOR_AGENT,
  dagBlock,
  PLAN_MESSAGE_ID,
  planTasks,
} from "./support/bootstrap-run";
import { JUDGE_SEAT_REVIEW, JUDGE_SEAT_SMOKE } from "./support/review-run";

/**
 * T4b: the host was restarted in the middle of a member's turn and lost the turn. The member is alive
 * and idle in Paseo, but the dispatch is no longer in its history, so the reads of its reply keep
 * failing with `incomplete:dispatch-not-found` until they are used up (A21). A look at least 30 seconds
 * after that (a kick, a hook or a recovery; no timer) that finds the member idle and the dispatch still
 * missing lets the Engine record the turn as ended by the host's loss (a receipt it wrote itself,
 * `outcome: "host-lost"`) and open the ordinary decision: retry or cancel. It never sends the member
 * anything by itself.
 *
 * These tests run through the paths production takes: a person's kick (`control.kick`, which is
 * `driver.retryRun`), a recovery, and a hook, with the clock the settler and the re-checks share held
 * by the test, so the 30 seconds are never a real wait.
 */

const RUN_ID = "run-hostlost-a1";
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
  home = await realpath(await mkdtemp(path.join(tmpdir(), "run-hostlost-")));
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
      timelines.set(agentId, []);
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

/**
 * The same host whose timelines read as empty: what a look that is made while the host has lost the
 * history sees. Used for the reads of the settler only, so the rest of the Engine can see what the host
 * still holds.
 */
function emptyTimelines(port: PaseoEnginePort): PaseoEnginePort {
  const empty = {
    entries: [],
    epoch: "e1",
    startCursor: null,
    hasOlder: false,
    hasNewer: false,
    gap: false,
    staleCursor: false,
    reset: false,
  };
  return {
    ...port,
    agents: {
      ...port.agents,
      ref: (agentId) => {
        const handle = port.agents.ref(agentId);
        return { ...handle, timeline: { ...handle.timeline, refetch: async () => empty } };
      },
    },
  };
}

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

const createdOf = async (taskId = "t1") =>
  (await stored()).assignments.find((entry) => entry.taskId === taskId)?.createdAt ?? "";

/**
 * The plan is admitted and t1 goes out to the member, whose turn begins (the host said so). Then the
 * host restarts and forgets the turn; the reads of the reply are used up. Returns the time they were,
 * in milliseconds on the test clock: the 30 seconds count from there.
 */
async function reachExhausted(
  host: Host,
  built: Built,
  options: { turnStarted?: boolean } = {},
): Promise<number> {
  host.planRequestSent();
  host.reply(COORDINATOR_AGENT, planText());
  await built.driver.onHook({
    name: "agent.turn_ended",
    agentId: COORDINATOR_AGENT,
    turnId: host.turnOf(COORDINATOR_AGENT),
  });
  expect(states(await stored())).toEqual({ t1: "assigned", t2: "pending" });
  expect(host.sentTo(MEMBER)).toBe(1);
  if (options.turnStarted !== false) {
    // After the assignment was made, as the host's own hook would be.
    await plantReceipt(
      "turn_started",
      MEMBER,
      LOST_TURN,
      iso(Date.parse(await createdOf()) + 1000),
    );
  }
  host.dropTimeline(MEMBER);
  await built.driver.recover();
  for (const wait of [1500, 2500, 4500]) {
    built.clock.at += wait;
    await built.retry.fire();
  }
  // A v1 Run has no re-check to be used up: its clock runs from the same moment all the same.
  const held = heldAtOf(await stored());
  return Number.isNaN(held) ? built.clock.at : held;
}

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

/** What a member does when a person asks it, in Paseo, for a plain OK: its own turn, start and end. */
async function memberAnswersOk(host: Host, built: Built, turnId = "turn-ok") {
  host.addUserMessage(MEMBER, turnId, "typed-by-the-person-ok");
  await built.driver.onHook({ name: "agent.turn_started", agentId: MEMBER, turnId });
  host.reply(MEMBER, "OK");
  await built.driver.onHook({ name: "agent.turn_ended", agentId: MEMBER, turnId });
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

for (const schema of [1, 2] as const) {
  describe(`a check after 30 seconds settles a turn the host lost [v${schema}]`, () => {
    beforeEach(async () => {
      version = schema;
      await setup();
    });

    // --- group 1 ----------------------------------------------------------------------------------

    test("used up: a kick 29 seconds later writes nothing and sends nothing; one at 31 seconds writes one receipt and one decision and takes the alert down; kicking again writes nothing", async () => {
      const host = fakeHost();
      const built = build(host);
      const heldAt = await reachExhausted(host, built);
      const lost = await stored();
      expect(states(lost)).toEqual({ t1: "assigned", t2: "pending" });
      if (schema === 2) {
        expect(items(lost)[0]).toMatchObject({
          state: "held",
          attemptsStarted: 3,
          lastCode: LOST_CODE,
        });
        expect(lost.alerts.map((alert) => alert.state)).toEqual(["open"]);
        expect(lost.alerts[0]?.summary).toContain("至少等 30 秒");
      } else {
        // A v1 Run is not given re-checks: there is nothing used up, so nothing can be settled.
        expect(readReadRetries(lost)).toEqual({ kind: "absent" });
        expect(lost.alerts).toEqual([]);
      }
      const sentBefore = host.sent.length;

      // 29 seconds after the re-checks were used up: not yet.
      built.clock.at = heldAt + 29_000;
      const early = await kick(built);
      expect(early.status).toBe("ok");
      const quiet = await stored();
      expect(quiet.revision).toBe(lost.revision);
      expect(engineReceipts(quiet)).toEqual([]);
      expect(host.sent).toHaveLength(sentBefore);

      // 31 seconds after: a look settles it, once.
      built.clock.at = heldAt + 31_000;
      await kick(built);
      const settled = await stored();
      expect(host.sent).toHaveLength(sentBefore);
      expect(host.calls.archives).toBe(0);
      if (schema === 1) {
        expect(settled.revision).toBe(lost.revision);
        expect(engineReceipts(settled)).toEqual([]);
        expect(openDecisions(settled)).toEqual([]);
        return;
      }
      const receipts = engineReceipts(settled);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        kind: "turn_ended",
        agentId: MEMBER,
        turnId: LOST_TURN,
        eventKey: `turn_ended:${MEMBER}:${LOST_TURN}`,
        dedupeKey: `turn_ended:${MEMBER}:${LOST_TURN}`,
        disposition: "observed",
        outcome: HOST_LOST_OUTCOME,
        settledBy: "engine",
        basis: { firstNotFoundAt: iso(heldAt), seatStatus: "idle" },
      });
      const second = Date.parse(
        (receipts[0] as { basis?: { secondNotFoundAt?: string } }).basis?.secondNotFoundAt ?? "",
      );
      expect(second - heldAt).toBeGreaterThanOrEqual(31_000);
      expect(second - heldAt).toBeLessThan(32_000);
      expect(endsOf(settled)).toHaveLength(1);
      // The receipt was numbered like the host's: the counters moved with it.
      expect(receipts[0]?.seq).toBe(settled.counters.observationSeq);
      const decisions = openDecisions(settled);
      expect(decisions).toHaveLength(1);
      const [decision] = decisions;
      if (decision === undefined) throw new Error("no decision");
      expect(decision).toMatchObject({
        category: "D1",
        subjectId: "t1",
        limbo: { turnId: LOST_TURN, reason: HOST_LOST_CODE },
      });
      expect(decisionKindOf(settled, decision)).toBe("host-lost");
      // The text still names the lost dispatch (the older cause) and the new one.
      expect(decision.summary).toContain("派发消息已不在历史里");
      expect(answerableActions(settled, decision)).toEqual(["retry", "cancel"]);
      expect(settled.alerts.map((alert) => alert.state)).toEqual(["resolved"]);
      expect(settled.tasks.find((task) => task.spec.id === "t1")?.waitingReason).toBe(
        HOST_LOST_CODE,
      );
      expect(states(settled)).toEqual({ t1: "assigned", t2: "pending" });
      expect(checkLedgerInvariants(settled).ok).toBe(true);
      // The record is v1 or v2 as it was, and what this did not touch is as it was.
      expect(settled.schemaVersion).toBe(schema);
      expect(settled.roster).toEqual(lost.roster);
      expect(settled.policy).toEqual(lost.policy);
      expect(settled.resources).toEqual(lost.resources);

      // Looking again, any way there is, writes nothing and sends nothing. (A hook is recorded once as
      // its own receipt; that first one is taken before the count.)
      await lookAgain(built, "hook");
      const hooked = await stored();
      for (const via of ["kick", "recover", "hook", "kick"] as const) {
        built.clock.at += 40_000;
        await lookAgain(built, via);
      }
      const again = await stored();
      expect(again.revision).toBe(hooked.revision);
      expect(engineReceipts(again)).toHaveLength(1);
      expect(host.sent).toHaveLength(sentBefore);
    });

    // --- group 2 ----------------------------------------------------------------------------------

    test("cancel: the claims are released, the task and what depends on it are cancelled, the Run finishes, and nothing is sent or archived", async () => {
      const host = fakeHost();
      const built = build(host);
      const heldAt = await reachExhausted(host, built);
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
      // Asking again changes nothing.
      const revision = done.revision;
      await kick(built);
      await built.driver.recover();
      expect((await stored()).revision).toBe(revision);
    });

    // --- group 3 ----------------------------------------------------------------------------------

    test("retry: the same member gets exactly one message, not a second one for another look, and its reply is taken in as usual", async () => {
      const host = fakeHost();
      const built = build(host);
      const heldAt = await reachExhausted(host, built);
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
      expect({ status: out.status, issues: out.issues }).toEqual({ status: "applied", issues: [] });
      // One more message to the member, and no other agent was written to.
      expect(host.sentTo(MEMBER)).toBe(2);
      expect(host.sentTo(OTHER)).toBe(0);
      expect(host.calls.archives).toBe(0);
      const retried = await stored();
      expect(retried.assignments.filter((entry) => entry.taskId === "t1")).toHaveLength(2);
      const first = retried.assignments.find((entry) => entry.attempt === 1);
      expect(first?.state).toBe("ended");
      expect(openDecisions(retried)).toEqual([]);
      expect(checkLedgerInvariants(retried).ok).toBe(true);

      // The member's turn begins and it is working: looking again does not send it again.
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

      // The member does the work and reports: the report is taken in as for any attempt.
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

    // --- group 4 ----------------------------------------------------------------------------------

    describe("what is not evidence of a lost turn settles nothing", () => {
      async function stays(host: Host, built: Built, heldAt: number, extra = 0) {
        const before = await stored();
        const sent = host.sent.length;
        built.clock.at = heldAt + 31_000 + extra;
        await kick(built);
        await built.driver.recover();
        await built.control.idle();
        const after = await stored();
        expect(engineReceipts(after)).toEqual([]);
        expect(openDecisions(after)).toEqual([]);
        expect(after.revision).toBe(before.revision);
        expect(host.sent).toHaveLength(sent);
        expect(host.calls.archives).toBe(0);
      }

      test("a turn nobody saw begin: the receipts of another agent are not the member's", async () => {
        const host = fakeHost();
        const built = build(host);
        const heldAt = await reachExhausted(host, built, { turnStarted: false });
        const created = Date.parse(await createdOf());
        await plantReceipt("turn_started", OTHER, "turn-other", iso(created + 1000));
        await plantReceipt("turn_ended", OTHER, "turn-other", iso(created + 2000));
        await stays(host, built, heldAt);
      });

      test("receipts of the member from before the assignment was made are not its turn", async () => {
        const host = fakeHost();
        const built = build(host);
        const heldAt = await reachExhausted(host, built, { turnStarted: false });
        const created = Date.parse(await createdOf());
        await plantReceipt("turn_started", MEMBER, "turn-before", iso(created - 5000));
        await plantReceipt("turn_ended", MEMBER, "turn-before", iso(created - 4000));
        await stays(host, built, heldAt);
      });

      test("another agent's receipts neither block nor stand in for the member's own turn", async () => {
        const host = fakeHost();
        const built = build(host);
        const heldAt = await reachExhausted(host, built);
        const created = Date.parse(await createdOf());
        await plantReceipt("turn_started", OTHER, "turn-other", iso(created + 1000));
        await plantReceipt("turn_ended", OTHER, "turn-other", iso(created + 2000));
        built.clock.at = heldAt + 31_000;
        await kick(built);
        const settled = await stored();
        if (schema === 1) {
          expect(engineReceipts(settled)).toEqual([]);
          return;
        }
        expect(engineReceipts(settled).map((receipt) => receipt.agentId)).toEqual([MEMBER]);
        expect(endsOf(settled, "turn-other", OTHER)).toHaveLength(1);
      });

      test("a turn that began after the lost one means the member is working again", async () => {
        const host = fakeHost();
        const built = build(host);
        const heldAt = await reachExhausted(host, built);
        const created = Date.parse(await createdOf());
        await plantReceipt("turn_started", MEMBER, "turn-again", iso(created + 5000));
        await stays(host, built, heldAt);
      });

      test("a turn end the host reported for the member is not a loss of the turn (T4b writes no receipt); since T9b it is the proof for a decision about the lost reply", async () => {
        const host = fakeHost();
        const built = build(host);
        const heldAt = await reachExhausted(host, built);
        const created = Date.parse(await createdOf());
        await plantReceipt("turn_ended", MEMBER, "turn-else", iso(created + 5000));
        const sent = host.sent.length;
        built.clock.at = heldAt + 31_000;
        await kick(built);
        const after = await stored();
        // No receipt of the Engine's, as before.
        expect(engineReceipts(after)).toEqual([]);
        expect(host.sent).toHaveLength(sent);
        // T9b: the host's own end is on the ledger and the reply is lost, so the decision opens on that end.
        const decisions = openDecisions(after);
        expect(decisions).toHaveLength(schema === 2 ? 1 : 0);
        if (schema === 2) {
          expect(decisions[0]?.limbo).toMatchObject({
            reason: HOST_LOST_CODE,
            turnId: "turn-else",
            endedEventKey: `turn_ended:${MEMBER}:turn-else`,
          });
        }
      });

      test("a member the host reports as working is not at rest; once it is idle the same look settles", async () => {
        const host = fakeHost();
        const built = build(host);
        const heldAt = await reachExhausted(host, built);
        host.runningAgents.add(MEMBER);
        await stays(host, built, heldAt);
        host.runningAgents.delete(MEMBER);
        built.clock.at = heldAt + 33_000;
        await kick(built);
        const settled = await stored();
        expect(engineReceipts(settled)).toHaveLength(schema === 2 ? 1 : 0);
      });

      test("a message whose delivery is not settled may still start a turn", async () => {
        const host = fakeHost();
        const built = build(host);
        const heldAt = await reachExhausted(host, built);
        // A message for the task whose fate is unknown (it may have reached the member).
        await store.update(RUN_ID, (current) => {
          const next = structuredClone(current);
          const dispatch = next.outbox.find((intent) => intent.kind === "dispatch");
          if (dispatch === undefined) throw new Error("no dispatch");
          next.outbox.push({
            ...structuredClone(dispatch),
            id: "intent-unknown-1",
            kind: "wake",
            messageId: "00000000-0000-4000-8000-0000000000aa",
            idempotencyKey: "wake-unknown-1",
            state: "outcome-unknown",
            confirmedAt: null,
          } as never);
          return next;
        });
        await stays(host, built, heldAt);
      });
    });

    // --- group 5 ----------------------------------------------------------------------------------

    test("the person sent OK first and the member's own receipts came first: no receipt of the Engine's, and the cancellation finishes by the host's own", async () => {
      const host = fakeHost();
      const built = build(host);
      const heldAt = await reachExhausted(host, built);
      const sentBefore = host.sent.length;
      await askForCancel(built);
      await memberAnswersOk(host, built);
      built.clock.at = heldAt + 31_000;
      await kick(built);
      const done = await stored();
      expect(engineReceipts(done)).toEqual([]);
      expect(openDecisions(done)).toEqual([]);
      expect(done.lifecycle).toBe("cancelled");
      expect(states(done)).toEqual({ t1: "cancelled", t2: "cancelled" });
      expect(done.resources).toEqual([]);
      expect(host.sent).toHaveLength(sentBefore);
      expect(host.calls.archives).toBe(0);
    });

    // --- group 6 ----------------------------------------------------------------------------------

    test("the host reads the member as closed: it is a closed turn (T4a), a decision that can only be cancelled", async () => {
      const host = fakeHost();
      const built = build(host);
      const heldAt = await reachExhausted(host, built);
      const sentBefore = host.sent.length;
      host.closedAgents.add(MEMBER);
      built.clock.at = heldAt + 31_000;
      await kick(built);
      // Only closed: the first look that sees it waits (T11e) and settles nothing; the turn is the closed
      // member's, not the host's loss, so no look at the dispatch settles it as host-lost either.
      expect(engineReceipts(await stored())).toEqual([]);
      built.clock.at = heldAt + 62_000;
      await kick(built);
      const settled = await stored();
      expect(host.sent).toHaveLength(sentBefore);
      expect(host.calls.archives).toBe(0);
      const receipts = engineReceipts(settled);
      // A v1 Run settles a closed member too: that is T4a, which needs no re-checks.
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        outcome: "agent-closed",
        settledBy: "engine",
        basis: { closedBy: "host-read" },
      });
      const [decision] = openDecisions(settled);
      if (decision === undefined) throw new Error("no decision");
      expect(decisionKindOf(settled, decision)).toBe("member-lost");
      expect(answerableActions(settled, decision)).toEqual(["cancel"]);
      expect(settled.eventReceipts.some((receipt) => receipt.outcome === HOST_LOST_OUTCOME)).toBe(
        false,
      );
    });

    // --- group 7 ----------------------------------------------------------------------------------

    test("no timer is added: the count of timers does not change before, during and after the settlement", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const host = fakeHost();
      const built = build(host);
      const heldAt = await reachExhausted(host, built);
      const timers = vi.getTimerCount();
      built.clock.at = heldAt + 29_000;
      await kick(built);
      expect(vi.getTimerCount()).toBe(timers);
      built.clock.at = heldAt + 31_000;
      await kick(built);
      expect(vi.getTimerCount()).toBe(timers);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(vi.getTimerCount()).toBe(timers);
      expect(engineReceipts(await stored())).toHaveLength(schema === 2 ? 1 : 0);
      // Time passing alone settles nothing and sends nothing.
      expect(host.sentTo(MEMBER)).toBe(1);
    });

    // --- the three ways of looking ------------------------------------------------------------------

    for (const via of ["kick", "recover", "hook"] as const) {
      test(`a look by ${via} settles it once and writes nothing the second time (that it comes before the host is reconciled is shown by the tests of the order further down)`, async () => {
        const host = fakeHost();
        const built = build(host);
        const heldAt = await reachExhausted(host, built);
        built.clock.at = heldAt + 31_000;
        await lookAgain(built, via);
        const settled = await stored();
        const receipts = engineReceipts(settled);
        expect(receipts).toHaveLength(schema === 2 ? 1 : 0);
        // One turn end for the lost turn, the Engine's.
        expect(endsOf(settled)).toHaveLength(schema === 2 ? 1 : 0);
        await lookAgain(built, via);
        expect((await stored()).revision).toBe(settled.revision);
      });
    }

    // --- the whole Run is cancelled while the lost turn waits ----------------------------------------

    test("the settlement alone, with the whole Run being cancelled, writes the receipt and takes the used-up alert down in the same commit, and opens no decision", async () => {
      const host = fakeHost();
      const built = build(host);
      const heldAt = await reachExhausted(host, built);
      await askForCancel(built);
      const asked = await stored();
      expect(asked.lifecycle).toBe("paused");
      built.clock.at = heldAt + 31_000;
      // Only the settler: nothing that sweeps alerts or finishes the cancellation runs after it.
      const out = await built.settler.settle(RUN_ID);
      const after = await stored();
      if (schema === 1) {
        expect(out.settled).toBe(0);
        expect(after.revision).toBe(asked.revision);
        return;
      }
      expect(out.settled).toBe(1);
      expect(after.revision).toBe(asked.revision + 1);
      expect(engineReceipts(after)).toHaveLength(1);
      expect(openDecisions(after)).toEqual([]);
      expect(after.decisions.filter((decision) => decision.dedupeKey.startsWith("stuck:"))).toEqual(
        [],
      );
      // The alert of the used-up re-check went with the receipt (the cancel-pending alert is the other one).
      const used = asked.alerts.filter((alert) =>
        alert.summary.includes("incomplete:dispatch-not-found"),
      );
      expect(used).toHaveLength(1);
      expect(
        after.alerts
          .filter((alert) => alert.summary.includes("incomplete:dispatch-not-found"))
          .map((alert) => alert.state),
      ).toEqual(["resolved"]);
      // The Run is still being cancelled: the finish is the cancellation's own step.
      expect(after.lifecycle).toBe("paused");
    });

    test("the whole Run is being cancelled: a look after 30 seconds records the lost turn so the cancellation finishes, and opens no decision that nobody could answer", async () => {
      const host = fakeHost();
      const built = build(host);
      const heldAt = await reachExhausted(host, built);
      await askForCancel(built);
      const sentBefore = host.sent.length;
      built.clock.at = heldAt + 31_000;
      await kick(built);
      await built.control.idle();
      const done = await stored();
      expect(host.sent).toHaveLength(sentBefore);
      expect(host.calls.archives).toBe(0);
      if (schema === 1) {
        // A v1 Run has no re-check to be used up: nothing is settled and the cancellation keeps waiting.
        expect(engineReceipts(done)).toEqual([]);
        expect(done.lifecycle).toBe("paused");
        return;
      }
      expect(done.lifecycle).toBe("cancelled");
      // The receipt that let the cancellation finish is the Engine's own.
      expect(engineReceipts(done)).toHaveLength(1);
      expect(engineReceipts(done)[0]).toMatchObject({
        outcome: HOST_LOST_OUTCOME,
        settledBy: "engine",
      });
      expect(states(done)).toEqual({ t1: "cancelled", t2: "cancelled" });
      expect(done.resources).toEqual([]);
      // No decision was left on a Run that is cancelled, and the alert of the used-up re-check is down.
      expect(openDecisions(done)).toEqual([]);
      expect(done.decisions.filter((decision) => decision.dedupeKey.startsWith("stuck:"))).toEqual(
        [],
      );
      expect(done.alerts.filter((alert) => alert.state !== "resolved")).toEqual([]);
      const view = projectDetail(done);
      if (!view.ok) throw new Error("projection failed");
      expect(view.view.decisions.filter((entry) => entry.state === "open")).toEqual([]);
      // The list counts what needs a person: nothing here does.
      expect(projectSummary(done)?.needsAttention).toBe(false);
      expect(checkLedgerInvariants(done).ok).toBe(true);
      // Looking again writes nothing.
      const revision = done.revision;
      await kick(built);
      await built.driver.recover();
      expect((await stored()).revision).toBe(revision);
    });
  });
}

// --- the order of a look, the late real receipt and compaction (a v2 Run: a v1 Run settles nothing) ---

/** The host holds the lost turn's history after all: the dispatch is back, with the member's reply. */
async function historyComesBack(host: Host, turnId = "turn-host-visible"): Promise<void> {
  const record = await stored();
  const assignment = record.assignments.find((entry) => entry.taskId === "t1");
  if (assignment === undefined) throw new Error("no assignment");
  host.addUserMessage(MEMBER, turnId, replyAnchor(record, assignment));
  host.reply(MEMBER, "I did the work.");
}

describe("what the look does first, a receipt that comes late, and a compacted history [v2]", () => {
  beforeEach(async () => {
    version = 2;
    await setup();
  });

  // The settler reads the host through a view in which the history is gone (the look that finds the
  // dispatch missing), while the reconcile reads a host that still holds the turn: a reconcile that
  // ran first would record the host's own `turn_ended` and the settlement would never happen.
  for (const via of ["kick", "recover"] as const) {
    test(`a look by ${via} settles the lost turn before the host is reconciled: the Engine's receipt is there and comes first, though a reconcile run first would have recorded the host's`, async () => {
      const host = fakeHost();
      const built = build(host, { settleHost: emptyTimelines(host.port) });
      const heldAt = await reachExhausted(host, built);
      await historyComesBack(host);
      built.clock.at = heldAt + 31_000;
      await lookAgain(built, via);
      const settled = await stored();
      const [engine] = engineReceipts(settled);
      expect(engineReceipts(settled)).toHaveLength(1);
      expect(engine).toMatchObject({
        kind: "turn_ended",
        turnId: LOST_TURN,
        outcome: HOST_LOST_OUTCOME,
        settledBy: "engine",
      });
      // The reconcile did read the history that is back (so the fixture can tell the orders apart),
      // and what it wrote came after the Engine's receipt.
      const hostEnd = settled.eventReceipts.find(
        (receipt) => receipt.kind === "turn_ended" && receipt.turnId === "turn-host-visible",
      );
      expect(hostEnd).toBeDefined();
      expect(engine?.seq).toBeLessThan(hostEnd?.seq ?? 0);
      const [decision] = openDecisions(settled).filter((entry) => entry.subjectId === "t1");
      if (decision === undefined) throw new Error("no decision");
      expect(decisionKindOf(settled, decision)).toBe("host-lost");
    });
  }

  test("a look by a hook settles the lost turn before the cancellation is finished: the one look cancels the Run", async () => {
    const host = fakeHost();
    const built = build(host);
    const heldAt = await reachExhausted(host, built);
    await askForCancel(built);
    expect((await stored()).lifecycle).toBe("paused");
    built.clock.at = heldAt + 31_000;
    await lookAgain(built, "hook");
    const done = await stored();
    expect(engineReceipts(done)).toHaveLength(1);
    expect(done.lifecycle).toBe("cancelled");
    expect(openDecisions(done)).toEqual([]);
  });

  test("after the Engine recorded the loss, the member's own turn end for that turn, with a valid report, is a duplicate: the report is not taken in and the decision does not change", async () => {
    const host = fakeHost();
    const built = build(host);
    const heldAt = await reachExhausted(host, built);
    built.clock.at = heldAt + 31_000;
    await kick(built);
    const settled = await stored();
    expect(engineReceipts(settled)).toHaveLength(1);
    const decisionsBefore = openDecisions(settled).map((decision) => decision.decisionId);
    expect(decisionsBefore).toHaveLength(1);

    // The member was alive after all and ends that very turn with a valid report.
    host.addUserMessage(
      MEMBER,
      LOST_TURN,
      replyAnchor(settled, settled.assignments.find((entry) => entry.taskId === "t1") as never),
    );
    produce(host, MEMBER);
    const ingested = await built.driver.onHook({
      name: "agent.turn_ended",
      agentId: MEMBER,
      turnId: LOST_TURN,
    });
    expect(ingested.status).toBe("duplicate");
    await built.control.idle();
    await kick(built);
    await built.driver.recover();
    const late = await stored();
    expect(endsOf(late)).toHaveLength(1);
    expect(endsOf(late)[0]).toMatchObject({ settledBy: "engine", outcome: HOST_LOST_OUTCOME });
    expect(late.assignments.every((entry) => entry.acceptedProof === null)).toBe(true);
    expect(states(late)).toEqual({ t1: "assigned", t2: "pending" });
    expect(openDecisions(late).map((decision) => decision.decisionId)).toEqual(decisionsBefore);
    expect(late.resources).toEqual(settled.resources);
    expect(host.sentTo(MEMBER)).toBe(1);
    expect(checkLedgerInvariants(late).ok).toBe(true);
  });

  test("a history that is folded into its checkpoint keeps the event that says when the re-checks were used up: the look still settles the lost turn", async () => {
    const host = fakeHost();
    // Every pass folds as much as the rules allow.
    const built = build(host, { compaction: { compactAt: 1, keepNewest: 0 } });
    const heldAt = await reachExhausted(host, built);
    const lost = await stored();
    expect(Number.isNaN(heldAt)).toBe(false);
    built.clock.at = heldAt + 31_000;
    await built.driver.kick(RUN_ID);
    const settled = await stored();
    // Something was folded (the checkpoint moved), and what says when the re-checks were used up is
    // still there, so the turn is settled.
    expect(settled.checkpoint?.throughSeq ?? 0).toBeGreaterThan(0);
    expect(heldAtOf(settled)).toBe(heldAt);
    expect(heldAtOf(lost)).toBe(heldAt);
    expect(engineReceipts(settled)).toHaveLength(1);
    expect(openDecisions(settled)).toHaveLength(1);
    expect(checkLedgerInvariants(settled).ok).toBe(true);
  });
});

describe("the alert of a used-up re-check says what a look after 30 seconds does", () => {
  test("the number in the alert is the one the code uses", () => {
    expect(LOST_TURN_SETTLE_DELAY_MS).toBe(30_000);
    const item = {
      key: "k1",
      generation: 1,
      target: {
        type: "reply" as const,
        agentId: MEMBER,
        taskId: "t1",
        assignmentId: "a1",
        anchorMessageId: "m1",
      },
      sourceKey: "s1",
      attemptsStarted: 3,
      scheduledAt: iso(0),
      nextAt: null,
      state: "held" as const,
      lastCode: LOST_CODE,
    };
    const summary = readRetryAlertSummary(item);
    expect(summary).toContain(`至少等 ${LOST_TURN_SETTLE_DELAY_MS / 1000} 秒后点“立即检查并推进”`);
    expect(alertIdFor(summary)).toBeTruthy();
  });
});

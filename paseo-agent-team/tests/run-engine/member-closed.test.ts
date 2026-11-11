import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createCancelFinisher } from "../../server/run-engine/cancel";
import { createRunControl } from "../../server/run-engine/control";
import { createDagIntake } from "../../server/run-engine/dag";
import { createEngineDriver } from "../../server/run-engine/driver";
import { createEffects } from "../../server/run-engine/effects";
import { createObserverHost } from "../../server/run-engine/host";
import { createIntake } from "../../server/run-engine/intake";
import { createClosingWatch, createMemberLostSettler } from "../../server/run-engine/member-lost";
import { createRunObserver } from "../../server/run-engine/observer";
import { projectDetail, projectSummary } from "../../server/run-engine/projection";
import type { ReadFailure } from "../../server/run-engine/read-retry";
import { reopenByReading } from "../../server/run-engine/reopen-read";
import { createEngineService } from "../../server/run-engine/service";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import { REPO_ALIAS } from "../../shared/domain/run-engine/dag-admission";
import {
  answerableActions,
  decisionKindOf,
  openLimboDecision,
} from "../../shared/domain/run-engine/decision-answer";
import { compileEngineIntent } from "../../shared/domain/run-engine/engine-prompts";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import { isEngineSettled } from "../../shared/domain/run-engine/lost-turn";
import { compileDispatch } from "../../shared/domain/run-engine/prompt-template";
import { emptyReadRetries } from "../../shared/domain/run-engine/read-retry";
import { CLOSING_TURN_ALERT_PREFIX } from "../../shared/domain/run-engine/seat-closed";
import { explainDecision, explainWaiting } from "../../shared/domain/run-engine/waiting";
import type { PaseoEnginePort, PortTimelinePage } from "../../shared/paseo/port";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { PROFILE_HAIKU, spec } from "../fixtures/run-engine/base";
import {
  bootstrapRun,
  COORDINATOR_AGENT,
  dagBlock,
  PLAN_MESSAGE_ID,
  planTasks,
} from "./support/bootstrap-run";
import { JUDGE_SEAT_REVIEW, JUDGE_SEAT_SMOKE } from "./support/review-run";

/**
 * T4a: a member whose Agent Paseo closes or archives in the middle of its turn (archiving the
 * coordinator archives the members it made). The host does not promise a `turn_ended` for such a turn, so
 * the Run would wait for it forever. When the ledger and the host's own live state show the session is
 * closed and no turn is running, the Engine records the turn as ended (an `agent-closed` receipt it wrote
 * itself) and opens a decision a person can only answer with "cancel". Never a message, never an archive.
 */

const RUN_ID = "run-mclosed1-a1";
const MEMBER = "agent-b1";
const JUDGE = "agent-b2";

let home: string;
let repoDir: string;
let store: RunStore;
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
  home = await realpath(await mkdtemp(path.join(tmpdir(), "run-mclosed-")));
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
  if (version === 2) (record as Record<string, unknown>).readRetries = emptyReadRetries();
  await store.create(record);
}

afterEach(async () => {
  await store.close().catch(() => undefined);
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

// --- a host whose agents can be closed, deleted or unreadable ------------------------------------

type Sent = { agentId: string; text: string; messageId: string };
type PortTimelineEntry = PortTimelinePage["entries"][number];

function fakeHost(options: { reopensOnRead?: boolean } = {}) {
  const timelines = new Map<string, PortTimelineEntry[]>();
  const unopenable = new Set<string>();
  const timelineReads = new Map<string, number>();
  const turns = new Map<string, string>();
  const sent: Sent[] = [];
  // A turn id the host will give the next message of an agent (a restarted host numbers turns again).
  const nextTurnId = new Map<string, string>();
  const calls = { archives: 0, seatReads: 0 };
  const runningAgents = new Set<string>();
  const closedAgents = new Set<string>();
  const absentAgents = new Set<string>();
  const unreadableAgents = new Set<string>();
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
      // A closed agent read back from the host's store: no live turn.
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
          const turnId = nextTurnId.get(agentId) ?? `turn-${agentId}-${sent.length}`;
          nextTurnId.delete(agentId);
          add(agentId, turnId, { type: "user_message", messageId });
        },
        archive: async () => {
          calls.archives += 1;
        },
        timeline: {
          refetch: async () => {
            timelineReads.set(agentId, (timelineReads.get(agentId) ?? 0) + 1);
            // The real host loads a closed Agent again when its timeline is read (T11 fact 1); a Codex
            // member that never ran a turn cannot be (fact 3).
            if (options.reopensOnRead && closedAgents.has(agentId)) {
              if (unopenable.has(agentId)) {
                throw new Error(`Failed to resume Codex thread for ${agentId}: no rollout found`);
              }
              closedAgents.delete(agentId);
            }
            return {
              entries: [...entries(agentId)],
              epoch: "e1",
              startCursor: null,
              hasOlder: false,
              hasNewer: false,
              gap: false,
              staleCursor: false,
              reset: false,
            };
          },
        },
        current: () => state(agentId),
        refresh: async () => {
          calls.seatReads += 1;
          if (unreadableAgents.has(agentId)) throw new Error("the agent cannot be read");
          if (absentAgents.has(agentId)) return null;
          return { agent: state(agentId) };
        },
      }),
    },
  };
  return {
    port,
    sent,
    calls,
    runningAgents,
    absentAgents,
    unreadableAgents,
    unopenable,
    /** How often the timeline of an agent was read (any reader). */
    reads: (agentId: string) => timelineReads.get(agentId) ?? 0,
    /** The person closed the Agent: no live turn, and the host reads it back as closed. */
    close: (agentId: string) => {
      runningAgents.delete(agentId);
      closedAgents.add(agentId);
    },
    /** The next message to this agent runs in a turn with this id (the host numbers turns from the start again). */
    reuseTurnId: (agentId: string, turnId: string) => {
      nextTurnId.set(agentId, turnId);
    },
    /** The person opened it again. */
    reopen: (agentId: string) => {
      closedAgents.delete(agentId);
    },
    planRequestSent: () =>
      add(COORDINATOR_AGENT, "turn-plan", { type: "user_message", messageId: PLAN_MESSAGE_ID }),
    addUserMessage: (agentId: string, turnId: string, messageId: string) =>
      add(agentId, turnId, { type: "user_message", messageId }),
    reply: (agentId: string, text: string) =>
      add(agentId, turns.get(agentId) ?? "turn-plan", { type: "assistant_message", text }),
    turnOf: (agentId: string) => turns.get(agentId) ?? "turn-plan",
    lastSent: (agentId: string) => [...sent].reverse().find((entry) => entry.agentId === agentId),
  };
}

type Host = ReturnType<typeof fakeHost>;

/**
 * One clock for every part of the wiring, moving forward a second each time it is read. The Engine only
 * settles a turn whose `turn_started` receipt is strictly later than the assignment it belongs to
 * (`lost-turn.ts`); with the real clock that was true only because the machine took a few milliseconds
 * in between, so a fast one could put both in the same millisecond. Here "later" is a fact of the test.
 */
function steppedClock(
  stepMs = 1000,
  startIso = "2026-11-05T12:00:00.000Z",
): { now(): string; jump(ms: number): void } {
  let at = Date.parse(startIso);
  return {
    now: () => {
      at += stepMs;
      return new Date(at).toISOString();
    },
    jump: (ms) => {
      at += ms;
    },
  };
}

/** The wiring as production makes it: the settler first, the cancellation finisher after it. */
function build(host: Host, options: { tickMs?: number; reopen?: boolean; start?: string } = {}) {
  const clock = steppedClock(options.tickMs, options.start);
  // The agents the settler holds back from the host reads, as the runtime wires it.
  const watch = createClosingWatch();
  const isHeld = (agentId: string) => watch.holds(agentId);
  const reopens = { count: 0 };
  const failures: ReadFailure[] = [];
  const onReadFailure = (_runId: string, failure: ReadFailure) => {
    failures.push(failure);
  };
  // The reads the settler and the cancellation finisher make; the observer's own reads are not counted.
  const seatReads = { count: 0 };
  const readSeat = async (agentId: string) => {
    seatReads.count += 1;
    const refreshed = await host.port.agents.ref(agentId).refresh();
    return refreshed?.agent
      ? { status: refreshed.agent.status, activeTurn: refreshed.agent.activeTurn != null }
      : null;
  };
  const observerHost = createObserverHost(host.port, { isHeld });
  // The observer holds hooks back while its store is not ready (a restart before the ledger is open).
  const gate = { ready: true };
  const observerStore: RunStore = new Proxy(store, {
    get: (target, key) => {
      if (key === "ready") return gate.ready;
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const observer = createRunObserver({ store: observerStore, onReadFailure, clock });
  const effects = createEffects({
    store,
    port: host.port,
    compile: compileEngineIntent,
    resolveWorkspace: () => ({ workspaceId: "ws-start", directory: repoDir }),
    onReadFailure,
    clock,
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
    clock,
  });
  const intake = createIntake({
    store,
    observer,
    host: observerHost,
    onReadFailure,
    clock,
    repair: { send: (runId) => effects.runOutbox(runId) },
  });
  const dagIntake = createDagIntake({
    store,
    host: observerHost,
    seatFamily: () => null,
    resolveWorkspace,
    clock,
    repair: { send: (runId) => effects.runOutbox(runId) },
  });
  const driver = createEngineDriver({
    store,
    observer,
    host: observerHost,
    intake,
    dagIntake,
    service,
    clock,
    memberLost: createMemberLostSettler({
      store,
      readSeat,
      onReadFailure,
      clock,
      watch,
      ...(options.reopen
        ? {
            reopenSeat: (agentId: string) => {
              reopens.count += 1;
              return reopenByReading(host.port, agentId, 30_000);
            },
          }
        : {}),
    }),
    cancelFinisher: createCancelFinisher({ store, readSeat, onReadFailure, clock }),
    reconcileHost: createObserverHost(host.port, { requireIdle: true, isHeld }),
  });
  const control = createRunControl({ store, ensureReady: async () => undefined, driver, clock });
  return { driver, control, failures, seatReads, gate, clock, reopens, watch };
}

type Built = ReturnType<typeof build>;

async function stored(): Promise<RunRecord> {
  const read = await store.get(RUN_ID);
  if (read.status !== "ok") throw new Error(`run unreadable: ${read.status}`);
  return read.record;
}

const states = (record: RunRecord) =>
  Object.fromEntries(record.tasks.map((task) => [task.spec.id, task.state]));

// --- what the scripted agents do -----------------------------------------------------------------

function section<T>(text: string, label: string): T {
  const lines = text.split("\n");
  const index = lines.indexOf(label);
  if (index < 0) throw new Error(`no section ${label} in the prompt`);
  return JSON.parse(lines[index + 1] ?? "") as T;
}

type Identity = { taskId: string; attempt: number; messageId?: string; [key: string]: unknown };
type Facts = {
  repoRoot: string;
  evidenceDir: string;
  workspace: unknown;
  delivery: { deliveryRef: unknown };
  evidenceRepair?: { delivery: { ref: unknown; workspace: unknown; changedFiles: string[] } };
};
type TaskData = {
  scopes: { path: string }[];
  evidence: { id: string; command: string | null }[];
};

function fence(kind: string, body: unknown): string {
  return `Done.\n\`\`\`${kind}\n${JSON.stringify(body)}\n\`\`\`\n`;
}

/** The member does the work for real: edits a file, commits it, and reports from its prompt. */
function produce(host: Host, agentId: string, options: { evidenceId?: string } = {}): void {
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
        id: options.evidenceId ?? requirement.id,
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

/** Two independent tasks, so that two members can work at the same time. */
const independentPlan = () =>
  fence(
    "task-dag",
    dagBlock(RUN_ID, [
      spec("t1", "First", {
        scopes: [{ repoId: REPO_ALIAS, kind: "file", path: "src/t1.ts", access: "write" }],
      }),
      spec("t2", "Second", {
        scopes: [{ repoId: REPO_ALIAS, kind: "file", path: "src/t2.ts", access: "write" }],
      }),
    ] as never),
  );

const turnEnded = (host: Host, built: Built, agentId: string, outcome?: string) =>
  built.driver.onHook({
    name: "agent.turn_ended",
    agentId,
    turnId: host.turnOf(agentId),
    ...(outcome === undefined ? {} : { outcome: { kind: outcome } }),
  });

/** The member got its task and its turn began (the host says so, and it is running). */
async function turnStarts(host: Host, built: Built, agentId: string): Promise<void> {
  host.runningAgents.add(agentId);
  await built.driver.onHook({
    name: "agent.turn_started",
    agentId,
    turnId: host.turnOf(agentId),
  });
}

/** The plan is admitted, t1 goes to the member and its turn begins. */
async function reachWorking(host: Host, built: Built, text: string = planText()): Promise<void> {
  host.planRequestSent();
  host.reply(COORDINATOR_AGENT, text);
  await turnEnded(host, built, COORDINATOR_AGENT);
  await turnStarts(host, built, MEMBER);
}

/** t1 is delivered and under review by the reviewer, whose turn has begun. */
async function reachReview(host: Host, built: Built): Promise<void> {
  await reachWorking(host, built);
  produce(host, MEMBER);
  host.runningAgents.delete(MEMBER);
  await turnEnded(host, built, MEMBER);
  await turnStarts(host, built, JUDGE);
}

const engineReceipts = (record: RunRecord) =>
  record.eventReceipts.filter((receipt) => isEngineSettled(receipt));
const openDecisions = (record: RunRecord) =>
  record.decisions.filter((decision) => decision.state === "open");

async function decideCancel(built: Built, decisionId: string, requestId = "ans-1") {
  const before = await stored();
  const out = await built.control.decide({
    runContractVersion: 1 as const,
    runId: RUN_ID,
    decisionId,
    requestId,
    expectedRevision: before.revision,
    reason: "the member was closed",
    answer: { action: "cancel" as const },
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

/**
 * The two ways a Run is looked at when no hook told the Engine anything: a restart's recovery, and the
 * person's "check now" button (`run.kick`, which is `driver.retryRun`). Both read the host for turns whose
 * hook was lost before they settle what the Run waits on.
 */
async function recoverWithoutHook(built: Built, via: "recover" | "kick"): Promise<void> {
  if (via === "recover") await built.driver.recover();
  else await built.control.kick({ runContractVersion: 1 as const, runId: RUN_ID });
  await built.control.idle();
}

/** Hooks, kicks and a recovery, again and again: after the first round nothing is written. */
async function quiet(built: Built, host: Host, agentId = MEMBER, times = 5): Promise<void> {
  const round = async () => {
    await built.driver.onHook({ name: "agent.closed", agentId });
    await built.driver.onHook({ name: "agent.archived", agentId });
    await built.driver.kick(RUN_ID);
  };
  await round();
  const record = await stored();
  const sent = host.sent.length;
  for (let i = 0; i < times; i += 1) await round();
  await built.driver.recover();
  const after = await stored();
  expect(after.revision).toBe(record.revision);
  expect(host.sent).toHaveLength(sent);
  expect(host.calls.archives).toBe(0);
}

for (const schema of [1, 2] as const) {
  describe(`a member closed or archived in the middle of its turn [v${schema}]`, () => {
    beforeEach(async () => {
      version = schema;
      await setup();
    });

    test("1: archived, then closed, and the host reads it closed: one engine receipt, one decision that can only be cancelled, nothing sent or archived", async () => {
      const host = fakeHost();
      const built = build(host);
      await reachWorking(host, built);
      const before = await stored();
      const turnId = host.turnOf(MEMBER);
      const sentBefore = host.sent.length;

      // The host archives first and the Agent is still reading as running: nothing is settled yet.
      await built.driver.onHook({ name: "agent.archived", agentId: MEMBER });
      expect(engineReceipts(await stored())).toHaveLength(0);

      host.close(MEMBER);
      await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
      const after = await stored();
      expect(after.schemaVersion).toBe(schema);
      const receipts = engineReceipts(after);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        kind: "turn_ended",
        agentId: MEMBER,
        turnId,
        eventKey: `turn_ended:${MEMBER}:${turnId}`,
        dedupeKey: `turn_ended:${MEMBER}:${turnId}`,
        disposition: "observed",
        outcome: "agent-closed",
        settledBy: "engine",
        basis: { closedBy: "receipt" },
      });
      // Numbered like any receipt the host writes.
      expect(after.counters.observationSeq).toBe(
        Math.max(...after.eventReceipts.map((r) => r.seq)),
      );
      const open = openDecisions(after);
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ category: "D1", subjectId: "t1" });
      expect(decisionKindOf(after, open[0] as never)).toBe("member-lost");
      expect(answerableActions(after, open[0] as never)).toEqual(["cancel"]);
      expect(after.tasks.find((task) => task.spec.id === "t1")?.waitingReason).toBe("member-lost");
      // What was not touched is byte for byte what it was.
      for (const key of ["roster", "policy", "budgets", "nonceRegistry", "resources"] as const) {
        expect(JSON.stringify(after[key])).toBe(JSON.stringify(before[key]));
      }
      expect(checkLedgerInvariants(after).ok).toBe(true);
      expect(host.sent).toHaveLength(sentBefore);
      expect(host.calls.archives).toBe(0);
      // Five more rounds of hooks and kicks change nothing.
      await quiet(built, host);
    });

    test("2: only archived and the host still reads a running turn: nothing; then closed while it still runs: nothing; settled once it is closed", async () => {
      const host = fakeHost();
      const built = build(host);
      await reachWorking(host, built);
      await built.driver.onHook({ name: "agent.archived", agentId: MEMBER });
      await built.driver.kick(RUN_ID);
      const archivedOnly = await stored();
      expect(engineReceipts(archivedOnly)).toHaveLength(0);
      expect(openDecisions(archivedOnly)).toHaveLength(0);
      // A pass that finds nothing it may settle writes nothing.
      await built.driver.kick(RUN_ID);
      await built.driver.recover();
      expect((await stored()).revision).toBe(archivedOnly.revision);

      // The close was reported, but the host still reads the agent with a turn running.
      await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
      await built.driver.kick(RUN_ID);
      const stillRunning = await stored();
      expect(engineReceipts(stillRunning)).toHaveLength(0);

      host.close(MEMBER);
      await built.driver.kick(RUN_ID);
      const settled = await stored();
      expect(engineReceipts(settled)).toHaveLength(1);
      expect(openDecisions(settled)).toHaveLength(1);
      await quiet(built, host);
    });

    test("3: no hook at all, the host reads the member closed when a kick looks: settled, and the basis says the host read it", async () => {
      const host = fakeHost();
      const built = build(host);
      await reachWorking(host, built);
      // Archived while it still reads as running: nothing is settled yet, and no closed receipt is on record.
      await built.driver.onHook({ name: "agent.archived", agentId: MEMBER });
      host.close(MEMBER);
      // The button a person presses, as production wires it (`run.kick` reads the host before it settles).
      await recoverWithoutHook(built, "kick");
      const settled = await stored();
      const receipts = engineReceipts(settled);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        outcome: "agent-closed",
        basis: { closedBy: "host-read", closedReceiptKey: null },
      });
      expect(openDecisions(settled)).toHaveLength(1);
      // No closed receipt is in the ledger, so only the kind of decision says it can only be cancelled.
      expect(answerableActions(settled, openDecisions(settled)[0] as never)).toEqual(["cancel"]);
      await quiet(built, host);
    });

    // The recovery paths read the host before they settle what a Run waits on. A closed Agent reads as
    // having no turn, so that read would record the cut-off turn as one the host ended, and from there the
    // report could be taken in, a repair request sent to the closed member, or no decision opened. The
    // Engine therefore settles the closed turns first; its receipt has the key the host's would, so the
    // read finds it already recorded.
    for (const via of ["recover", "kick"] as const) {
      for (const [name, validReport, repairBudget] of [
        ["no reply, repair budget left", false, 2],
        ["no reply, repair budget spent", false, 0],
        ["a valid report in the cut-off turn", true, 2],
      ] as const) {
        test(`R: no hook at all, the first look is ${via} (${name}): one engine receipt, a decision that only offers cancel, nothing sent or archived, nothing taken in`, async () => {
          const host = fakeHost();
          const built = build(host);
          await reachWorking(host, built);
          const turnId = host.turnOf(MEMBER);
          if (validReport) produce(host, MEMBER);
          await store.update(RUN_ID, (current) => {
            const next = structuredClone(current);
            next.policy.perTask.protocolResends = repairBudget;
            return next;
          });
          await built.driver.onHook({ name: "agent.archived", agentId: MEMBER });
          host.close(MEMBER);
          const sentBefore = host.sent.length;

          await recoverWithoutHook(built, via);

          const settled = await stored();
          expect(settled.schemaVersion).toBe(schema);
          const receipts = engineReceipts(settled);
          expect(receipts).toHaveLength(1);
          expect(receipts[0]).toMatchObject({
            kind: "turn_ended",
            agentId: MEMBER,
            turnId,
            outcome: "agent-closed",
            settledBy: "engine",
            basis: { closedBy: "host-read" },
          });
          // The host read finds the key taken: no second receipt for the turn.
          expect(
            settled.eventReceipts.filter((r) => r.kind === "turn_ended" && r.turnId === turnId),
          ).toHaveLength(1);
          const open = openDecisions(settled);
          expect(open).toHaveLength(1);
          expect(decisionKindOf(settled, open[0] as never)).toBe("member-lost");
          expect(answerableActions(settled, open[0] as never)).toEqual(["cancel"]);
          // Nothing of the cut-off turn is taken in, even a report that is valid.
          expect(settled.assignments.every((entry) => entry.acceptedProof === null)).toBe(true);
          expect(states(settled)).toEqual({ t1: "assigned", t2: "pending" });
          expect(settled.outbox.filter((intent) => intent.kind === "wake")).toHaveLength(0);
          expect(checkLedgerInvariants(settled).ok).toBe(true);
          // The closed member is sent nothing and nothing is archived.
          expect(host.sent).toHaveLength(sentBefore);
          expect(host.calls.archives).toBe(0);

          // Looking again, by either way, changes nothing.
          const reads = built.seatReads.count;
          await recoverWithoutHook(built, "recover");
          await recoverWithoutHook(built, "kick");
          await recoverWithoutHook(built, via);
          await built.driver.kick(RUN_ID);
          const again = await stored();
          expect(again.revision).toBe(settled.revision);
          expect(host.sent).toHaveLength(sentBefore);
          // Nothing is left that may have been cut off, so the settler does not read the host either.
          expect(built.seatReads.count).toBe(reads);
          expect(host.calls.archives).toBe(0);
        });
      }
    }

    // Both ways of looking flush what the observer held back before they settle, so the held `agent.closed`
    // is in the ledger and the settler's receipt can name it. Without the flush on the button's path the host
    // read that follows would record the member's idle turn as one the host ended, and the report in it
    // would be taken in.
    for (const via of ["recover", "kick"] as const) {
      test(`R-flush: a closed hook that was held back is recorded by the ${via} before it settles, so the receipt is what shows it`, async () => {
        const host = fakeHost();
        const built = build(host);
        await reachWorking(host, built);
        // The close is reported while the observer's store is not ready: the observer holds the hook.
        built.gate.ready = false;
        const held = await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
        expect(held.status).toBe("buffered");
        expect(
          (await built.driver.onHook({ name: "agent.archived", agentId: MEMBER })).status,
        ).toBe("buffered");
        built.gate.ready = true;
        expect(engineReceipts(await stored())).toHaveLength(0);
        // The host reads the member as having no turn, but not as closed: only the held hook shows the close.
        host.runningAgents.delete(MEMBER);

        await recoverWithoutHook(built, via);

        const settled = await stored();
        const receipts = engineReceipts(settled);
        expect(receipts).toHaveLength(1);
        expect(receipts[0]).toMatchObject({
          outcome: "agent-closed",
          settledBy: "engine",
          basis: { closedBy: "receipt" },
        });
        expect(openDecisions(settled)).toHaveLength(1);
        expect(answerableActions(settled, openDecisions(settled)[0] as never)).toEqual(["cancel"]);
        expect(settled.assignments.every((entry) => entry.acceptedProof === null)).toBe(true);
        // No turn the host ended: the only end the ledger has for this turn is the Engine's own.
        expect(
          settled.eventReceipts.filter(
            (r) => r.kind === "turn_ended" && r.turnId === host.turnOf(MEMBER),
          ),
        ).toHaveLength(1);
        expect(host.calls.archives).toBe(0);
      });
    }

    test("R-idle: a Run whose member is working and whose host reads nothing closed: looking by recovery or by the button writes nothing", async () => {
      const host = fakeHost();
      const built = build(host);
      await reachWorking(host, built);
      await recoverWithoutHook(built, "recover");
      const first = await stored();
      for (const via of ["recover", "kick", "recover", "kick"] as const) {
        await recoverWithoutHook(built, via);
      }
      const after = await stored();
      expect(after.revision).toBe(first.revision);
      expect(engineReceipts(after)).toHaveLength(0);
      expect(openDecisions(after)).toHaveLength(0);
      expect(host.calls.archives).toBe(0);
    });

    test("4: a host read that fails, a turn that still runs, or a member opened again and working: nothing is settled", async () => {
      const host = fakeHost();
      const built = build(host);
      await reachWorking(host, built);
      host.close(MEMBER);
      host.unreadableAgents.add(MEMBER);
      await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
      await built.driver.kick(RUN_ID);
      const unreadable = await stored();
      expect(engineReceipts(unreadable)).toHaveLength(0);
      expect(openDecisions(unreadable)).toHaveLength(0);
      expect(built.failures.some((failure) => failure.type === "seat")).toBe(true);

      // A running turn does not settle: the receipts say closed, the host says it works.
      host.unreadableAgents.delete(MEMBER);
      host.reopen(MEMBER);
      host.runningAgents.add(MEMBER);
      await built.driver.kick(RUN_ID);
      expect(engineReceipts(await stored())).toHaveLength(0);

      // The person opened it again and it works on a new turn: the close is no longer the last word.
      host.addUserMessage(MEMBER, "turn-reopened", "typed-by-the-person");
      await built.driver.onHook({
        name: "agent.turn_started",
        agentId: MEMBER,
        turnId: "turn-reopened",
      });
      host.runningAgents.delete(MEMBER);
      await built.driver.kick(RUN_ID);
      const reopened = await stored();
      expect(engineReceipts(reopened)).toHaveLength(0);
      expect(openDecisions(reopened)).toHaveLength(0);
      expect(states(reopened)).toEqual({ t1: "assigned", t2: "pending" });
    });

    test("4b: a member the host no longer has (deleted) reads as having no turn, and a closed receipt settles it", async () => {
      const host = fakeHost();
      const built = build(host);
      await reachWorking(host, built);
      await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
      host.runningAgents.delete(MEMBER);
      host.absentAgents.add(MEMBER);
      await built.driver.kick(RUN_ID);
      const settled = await stored();
      expect(engineReceipts(settled)).toHaveLength(1);
      expect(engineReceipts(settled)[0]).toMatchObject({ basis: { closedBy: "receipt" } });
      expect(openDecisions(settled)).toHaveLength(1);
    });

    test("4c: a deleted member with no closed receipt is not settled (the host gave no proof it was closed)", async () => {
      const host = fakeHost();
      const built = build(host);
      await reachWorking(host, built);
      host.runningAgents.delete(MEMBER);
      host.absentAgents.add(MEMBER);
      await built.driver.kick(RUN_ID);
      expect(engineReceipts(await stored())).toHaveLength(0);
    });

    test("5: the turn is not known (no turn_started on record): nothing is settled, as before", async () => {
      const host = fakeHost();
      const built = build(host);
      host.planRequestSent();
      host.reply(COORDINATOR_AGENT, planText());
      await turnEnded(host, built, COORDINATOR_AGENT);
      expect(states(await stored())).toEqual({ t1: "assigned", t2: "pending" });
      host.close(MEMBER);
      await built.driver.onHook({ name: "agent.archived", agentId: MEMBER });
      await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
      await built.driver.kick(RUN_ID);
      const after = await stored();
      expect(engineReceipts(after)).toHaveLength(0);
      expect(openDecisions(after)).toHaveLength(0);
      expect(states(after)).toEqual({ t1: "assigned", t2: "pending" });
    });

    test("6: the host's own turn_ended (canceled) comes first, then closed: no engine receipt, and the decision only offers cancel", async () => {
      const host = fakeHost();
      const built = build(host);
      await reachWorking(host, built);
      host.runningAgents.delete(MEMBER);
      await turnEnded(host, built, MEMBER, "canceled");
      const ended = await stored();
      expect(engineReceipts(ended)).toHaveLength(0);
      const first = openDecisions(ended);
      expect(first).toHaveLength(1);
      // Before anyone closed the member, an unusable report can be retried.
      expect(answerableActions(ended, first[0] as never)).toEqual(["retry", "cancel"]);

      host.close(MEMBER);
      await built.driver.onHook({ name: "agent.archived", agentId: MEMBER });
      await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
      await built.driver.kick(RUN_ID);
      const closed = await stored();
      expect(engineReceipts(closed)).toHaveLength(0);
      expect(openDecisions(closed)).toHaveLength(1);
      expect(answerableActions(closed, openDecisions(closed)[0] as never)).toEqual(["cancel"]);
      expect(host.calls.archives).toBe(0);
    });

    test("7: after the Engine settled the turn, the member's late turn_ended with a valid report is a duplicate: the report is not taken in", async () => {
      const host = fakeHost();
      const built = build(host);
      await reachWorking(host, built);
      const turnId = host.turnOf(MEMBER);
      produce(host, MEMBER);
      await built.driver.onHook({ name: "agent.archived", agentId: MEMBER });
      host.close(MEMBER);
      await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
      const settled = await stored();
      expect(engineReceipts(settled)).toHaveLength(1);
      expect(openDecisions(settled)).toHaveLength(1);

      await turnEnded(host, built, MEMBER, "completed");
      await built.driver.kick(RUN_ID);
      const late = await stored();
      expect(
        late.eventReceipts.filter((r) => r.kind === "turn_ended" && r.turnId === turnId),
      ).toHaveLength(1);
      expect(late.assignments.every((entry) => entry.acceptedProof === null)).toBe(true);
      expect(states(late)).toEqual({ t1: "assigned", t2: "pending" });
      expect(openDecisions(late).map((d) => d.decisionId)).toEqual(
        openDecisions(settled).map((d) => d.decisionId),
      );
      expect(late.resources).toEqual(settled.resources);
    });

    test("8: answering cancel releases the claims and cancels what depends on the task; the host is sent nothing and the Run ends", async () => {
      const host = fakeHost();
      const built = build(host);
      await reachWorking(host, built);
      await built.driver.onHook({ name: "agent.archived", agentId: MEMBER });
      host.close(MEMBER);
      await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
      const settled = await stored();
      expect(settled.resources.length).toBeGreaterThan(0);
      const decision = openDecisions(settled)[0];
      const sentBefore = host.sent.length;

      // The view offers cancel and nothing else, in words.
      const view = projectDetail(settled);
      if (!view.ok) throw new Error("projection failed");
      expect(view.view.decisions.map((entry) => entry.actions)).toEqual([["cancel"]]);
      expect(JSON.stringify(view.view)).toContain("被关闭或归档");

      // A retry is refused and writes nothing.
      const refused = await built.control.decide({
        runContractVersion: 1 as const,
        runId: RUN_ID,
        decisionId: decision?.decisionId ?? "",
        requestId: "ans-retry",
        expectedRevision: settled.revision,
        reason: "again",
        answer: { action: "retry" as const },
      });
      expect(refused).toMatchObject({ status: "rejected" });
      expect((await stored()).revision).toBe(settled.revision);

      const out = await decideCancel(built, decision?.decisionId ?? "");
      expect(out).toMatchObject({ status: "applied", taskId: "t1" });
      const done = await stored();
      expect(states(done)).toEqual({ t1: "cancelled", t2: "cancelled" });
      expect(done.resources).toEqual([]);
      expect(
        done.assignments.every((entry) => entry.state === "ended" || entry.state === "cancelled"),
      ).toBe(true);
      expect(checkLedgerInvariants(done).ok).toBe(true);
      expect(host.sent).toHaveLength(sentBefore);
      expect(host.calls.archives).toBe(0);
      await built.driver.kick(RUN_ID);
      expect(["finished", "cancelled"]).toContain((await stored()).lifecycle);
    });

    test("9: cancelling the whole Run after the member was closed: the cancellation finishes, once", async () => {
      const host = fakeHost();
      const built = build(host);
      await reachWorking(host, built);
      host.close(MEMBER);
      const sentBefore = host.sent.length;
      const out = await askForCancel(built);
      expect(out).toMatchObject({ status: "applied" });
      await built.driver.kick(RUN_ID);
      const done = await stored();
      expect(done.lifecycle).toBe("cancelled");
      expect(states(done)).toEqual({ t1: "cancelled", t2: "cancelled" });
      expect(done.resources).toEqual([]);
      expect(done.events.filter((event) => event.kind === "run-cancel-completed")).toHaveLength(1);
      expect(host.sent).toHaveLength(sentBefore);
      expect(host.calls.archives).toBe(0);
      const revision = done.revision;
      await built.driver.kick(RUN_ID);
      await built.driver.recover();
      expect((await stored()).revision).toBe(revision);
    });

    test("9c: cancelling the whole Run while a closed member's turn waits: the turn is recorded as ended (the Engine's own receipt) so the cancellation finishes, but no decision is opened that nobody could answer", async () => {
      const host = fakeHost();
      const built = build(host);
      await reachWorking(host, built);
      host.close(MEMBER);
      await askForCancel(built);
      await built.driver.kick(RUN_ID);
      const done = await stored();
      expect(done.lifecycle).toBe("cancelled");
      // The receipt that let the cancellation finish is there, and it is the Engine's.
      expect(engineReceipts(done)).toHaveLength(1);
      expect(engineReceipts(done)[0]).toMatchObject({
        outcome: "agent-closed",
        settledBy: "engine",
      });
      // No decision was opened for a Run that is cancelled: nothing open, nothing for a person to answer.
      expect(openDecisions(done)).toEqual([]);
      expect(done.decisions.filter((decision) => decision.dedupeKey.startsWith("stuck:"))).toEqual(
        [],
      );
      const view = projectDetail(done);
      if (!view.ok) throw new Error("projection failed");
      expect(view.view.decisions.filter((entry) => entry.state === "open")).toEqual([]);
      // The list counts what needs a person: nothing here does.
      expect(projectSummary(done)?.needsAttention).toBe(false);
      expect(checkLedgerInvariants(done).ok).toBe(true);
      expect(host.calls.archives).toBe(0);
      // Looking again writes nothing.
      const revision = done.revision;
      await built.driver.kick(RUN_ID);
      await built.driver.recover();
      expect((await stored()).revision).toBe(revision);
    });

    test("9b: a deleted member (the host reads nothing) does not keep the cancellation of the Run waiting; a read that throws still does", async () => {
      const host = fakeHost();
      const built = build(host);
      await reachWorking(host, built);
      await built.driver.onHook({ name: "agent.archived", agentId: MEMBER });
      host.close(MEMBER);
      await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
      // The turn is settled; the member is then unreadable: the cancellation has no proof of a quiet seat.
      expect(engineReceipts(await stored())).toHaveLength(1);
      host.unreadableAgents.add(MEMBER);
      await askForCancel(built);
      await built.driver.kick(RUN_ID);
      const waiting = await stored();
      expect(waiting.lifecycle).toBe("paused");
      expect(states(waiting)).toEqual({ t1: "assigned", t2: "pending" });
      expect(built.failures.some((failure) => failure.type === "seat")).toBe(true);

      // The host answers that it has no such Agent (deleted): nothing runs there.
      host.unreadableAgents.delete(MEMBER);
      host.absentAgents.add(MEMBER);
      await built.driver.kick(RUN_ID);
      const done = await stored();
      expect(done.lifecycle).toBe("cancelled");
      expect(done.resources).toEqual([]);
      expect(host.calls.archives).toBe(0);
    });
  });

  describe(`the coordinator is archived and takes its members with it [v${schema}]`, () => {
    beforeEach(async () => {
      version = schema;
      await setup();
    });

    // One Run never has two members working at once (every task claims the whole repository), so the
    // cascade is the coordinator and the member, closed one after the other.
    test("10: archiving the coordinator archives and closes the member in the middle of its turn: the turn is settled once and the cancellation finishes", async () => {
      const host = fakeHost();
      const built = build(host);
      await reachWorking(host, built);
      const sentBefore = host.sent.length;
      for (const agentId of [COORDINATOR_AGENT, MEMBER]) {
        await built.driver.onHook({ name: "agent.archived", agentId });
      }
      expect(engineReceipts(await stored())).toHaveLength(0);
      host.close(COORDINATOR_AGENT);
      host.close(MEMBER);
      for (const agentId of [COORDINATOR_AGENT, MEMBER]) {
        await built.driver.onHook({ name: "agent.closed", agentId });
      }
      const settled = await stored();
      expect(engineReceipts(settled).map((receipt) => receipt.agentId)).toEqual([MEMBER]);
      expect(openDecisions(settled)).toHaveLength(1);
      expect(answerableActions(settled, openDecisions(settled)[0] as never)).toEqual(["cancel"]);
      await quiet(built, host);
      await askForCancel(built);
      await built.driver.kick(RUN_ID);
      const done = await stored();
      expect(done.lifecycle).toBe("cancelled");
      expect(done.events.filter((event) => event.kind === "run-cancel-completed")).toHaveLength(1);
      expect(done.resources).toEqual([]);
      expect(host.sent).toHaveLength(sentBefore);
      expect(host.calls.archives).toBe(0);
    });
  });

  describe(`an archived member's seat takes no more work in this Run [v${schema}]`, () => {
    beforeEach(async () => {
      version = schema;
      await setup();
    });

    test("11: after the turn is settled and the task cancelled, another ready task is refused the archived seat, with the reason in Chinese", async () => {
      const host = fakeHost();
      const built = build(host);
      await reachWorking(host, built, independentPlan());
      const working = await stored();
      expect(states(working)).toEqual({ t1: "assigned", t2: "ready" });
      await built.driver.onHook({ name: "agent.archived", agentId: MEMBER });
      host.close(MEMBER);
      await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
      const settled = await stored();
      const decision = openDecisions(settled)[0];
      expect(decision?.subjectId).toBe("t1");

      await decideCancel(built, decision?.decisionId ?? "");
      await built.driver.kick(RUN_ID);
      const after = await stored();
      expect(states(after)).toEqual({ t1: "cancelled", t2: "ready" });
      const reason = after.tasks.find((task) => task.spec.id === "t2")?.waitingReason ?? "";
      expect(reason).toContain("seat-archived");
      expect(explainWaiting(reason).known).toBe(true);
      expect(JSON.stringify(explainWaiting(reason))).toContain("已被归档");
      // The archived seat got nothing new: the only message the member ever got is the first one.
      expect(host.sent.filter((entry) => entry.agentId === MEMBER)).toHaveLength(1);
      expect(host.calls.archives).toBe(0);
    });

    test("11b: a seat that was only closed (not archived) is not refused for that", async () => {
      const host = fakeHost();
      const built = build(host);
      await reachWorking(host, built, independentPlan());
      host.close(MEMBER);
      await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
      // Only closed: the Engine waits (T11e) and, with no way to reopen it here, calls it lost after 30 seconds.
      expect(openDecisions(await stored())).toHaveLength(0);
      built.clock.jump(31_000);
      await built.driver.kick(RUN_ID);
      const decision = openDecisions(await stored())[0];
      await decideCancel(built, decision?.decisionId ?? "");
      host.reopen(MEMBER);
      await built.driver.kick(RUN_ID);
      const after = await stored();
      expect(states(after).t2).toBe("assigned");
    });
  });

  describe(`a judge or a supplement closed in the middle of its turn [v${schema}]`, () => {
    beforeEach(async () => {
      version = schema;
      await setup();
    });

    test("A1: the reviewer is closed: its turn is settled, the decision offers only cancel, and answering it cancels the task", async () => {
      const host = fakeHost();
      const built = build(host);
      await reachReview(host, built);
      const review = await stored();
      expect(states(review).t1).toBe("review");
      host.close(JUDGE);
      await built.driver.onHook({ name: "agent.archived", agentId: JUDGE });
      await built.driver.onHook({ name: "agent.closed", agentId: JUDGE });
      const settled = await stored();
      expect(engineReceipts(settled).map((receipt) => receipt.agentId)).toEqual([JUDGE]);
      const open = openDecisions(settled);
      expect(open).toHaveLength(1);
      expect(decisionKindOf(settled, open[0] as never)).toBe("member-lost");
      expect(answerableActions(settled, open[0] as never)).toEqual(["cancel"]);
      expect(states(settled).t1).toBe("review");
      const sentBefore = host.sent.length;
      await quiet(built, host);

      const out = await decideCancel(built, open[0]?.decisionId ?? "");
      expect(out).toMatchObject({ status: "applied", taskId: "t1" });
      const done = await stored();
      expect(states(done)).toEqual({ t1: "cancelled", t2: "cancelled" });
      expect(done.resources).toEqual([]);
      expect(checkLedgerInvariants(done).ok).toBe(true);
      expect(host.sent).toHaveLength(sentBefore);
      expect(host.calls.archives).toBe(0);
    });

    test("A2: the reviewer is closed and the whole Run is cancelled: the cancellation finishes", async () => {
      const host = fakeHost();
      const built = build(host);
      await reachReview(host, built);
      host.close(JUDGE);
      await built.driver.onHook({ name: "agent.closed", agentId: JUDGE });
      await askForCancel(built);
      await built.driver.kick(RUN_ID);
      const done = await stored();
      expect(done.lifecycle).toBe("cancelled");
      expect(done.resources).toEqual([]);
    });

    test("A3: a supplement the member was asked for is cut off by the close: the decision offers only cancel", async () => {
      const host = fakeHost();
      const built = build(host);
      await reachWorking(host, built);
      // The delivery lacks the evidence the gate wants: the member is asked for it, in a new turn.
      produce(host, MEMBER, { evidenceId: "not-required" });
      host.runningAgents.delete(MEMBER);
      await turnEnded(host, built, MEMBER);
      const asked = await stored();
      expect(asked.assignments.some((entry) => "evidenceRepair" in entry)).toBe(schema === 2);
      if (schema === 1) return;
      await turnStarts(host, built, MEMBER);
      host.close(MEMBER);
      await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
      const settled = await stored();
      expect(engineReceipts(settled)).toHaveLength(1);
      const open = openDecisions(settled);
      expect(open).toHaveLength(1);
      expect(decisionKindOf(settled, open[0] as never)).toBe("member-lost");
      expect(answerableActions(settled, open[0] as never)).toEqual(["cancel"]);
      const out = await decideCancel(built, open[0]?.decisionId ?? "");
      expect(out).toMatchObject({ status: "applied", taskId: "t1" });
      const done = await stored();
      expect(states(done).t1).toBe("cancelled");
      expect(done.resources).toEqual([]);
      expect(checkLedgerInvariants(done).ok).toBe(true);
    });
  });
}

// --- T11e: a member that is only closed gets a look at reopening before its turn is called lost -----

const closingAlerts = (record: RunRecord) =>
  record.alerts.filter((alert) => alert.summary.startsWith(CLOSING_TURN_ALERT_PREFIX));

async function answer(built: Built, decisionId: string, action: "retry" | "cancel") {
  const before = await stored();
  const out = await built.control.decide({
    runContractVersion: 1 as const,
    runId: RUN_ID,
    decisionId,
    requestId: `answer-${action}`,
    expectedRevision: before.revision,
    reason: "the member was closed by a restart",
    answer: { action },
  });
  await built.control.idle();
  return out;
}

const person = (built: Built) =>
  built.control.kick({ runContractVersion: 1 as const, runId: RUN_ID });

for (const schema of [1, 2] as const) {
  describe(`a member that is only closed is reopened before its turn is called lost [v${schema}]`, () => {
    beforeEach(async () => {
      version = schema;
      await setup();
    });

    /** The cut-off turn of a graceful stop (a closed receipt) or of a kill (none): the member is closed. */
    async function restartedClosed(withReceipt: boolean) {
      const host = fakeHost({ reopensOnRead: true });
      const built = build(host, { tickMs: 1, reopen: true });
      await reachWorking(host, built);
      host.close(MEMBER);
      const reads = host.reads(MEMBER);
      const sent = host.sent.length;
      if (withReceipt) await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
      else await recoverWithoutHook(built, "kick");
      return { host, built, reads, sent };
    }

    for (const withReceipt of [true, false]) {
      const how = withReceipt ? "a graceful stop wrote a closed receipt" : "a kill left no receipt";
      test(`${how}: the first look reads the history once and warns; nothing is written before 30 seconds; then host-lost, retry sends exactly one new task`, async () => {
        const { host, built, reads, sent } = await restartedClosed(withReceipt);
        const first = await stored();
        expect(first.schemaVersion).toBe(schema);
        // The history was read once (that is what reopened it), by the settler and nobody else.
        expect(host.reads(MEMBER)).toBe(reads + 1);
        expect(built.reopens.count).toBe(1);
        expect(engineReceipts(first)).toHaveLength(0);
        expect(openDecisions(first)).toHaveLength(0);
        expect(closingAlerts(first).map((alert) => alert.state)).toEqual(["open"]);
        expect(closingAlerts(first)[0]?.severity).toBe("warning");
        expect(closingAlerts(first)[0]?.summary).toContain("30 秒");
        expect(closingAlerts(first)[0]?.summary).toContain("立即检查并推进");

        // Within 30 seconds every way of looking writes nothing, sends nothing and reads no history.
        built.clock.jump(10_000);
        const looks: [string, () => Promise<unknown>][] = [
          ["kick", () => built.driver.kick(RUN_ID)],
          ["recover", () => recoverWithoutHook(built, "recover")],
          ["button", () => recoverWithoutHook(built, "kick")],
        ];
        for (const [name, look] of looks) {
          await look();
          expect([name, (await stored()).revision]).toEqual([name, first.revision]);
        }
        const quietly = await stored();
        expect(host.reads(MEMBER)).toBe(reads + 1);
        expect(host.sent).toHaveLength(sent);
        expect(quietly.eventReceipts.filter((r) => r.kind === "turn_ended")).toHaveLength(
          first.eventReceipts.filter((r) => r.kind === "turn_ended").length,
        );

        // 30 seconds on: one receipt, one decision, the warning down, in one commit.
        built.clock.jump(21_000);
        await built.driver.kick(RUN_ID);
        const settled = await stored();
        const receipts = engineReceipts(settled);
        expect(receipts).toHaveLength(1);
        expect(receipts[0]).toMatchObject({
          kind: "turn_ended",
          agentId: MEMBER,
          outcome: "host-lost",
          settledBy: "engine",
          basis: { closedBy: withReceipt ? "receipt" : "host-read", seatStatus: "idle" },
        });
        const open = openDecisions(settled);
        expect(open).toHaveLength(1);
        expect(decisionKindOf(settled, open[0] as never)).toBe("host-lost");
        // The text names this cause (closed, then reopened idle) as well as the lost dispatch.
        expect(open[0]?.summary).toContain("重新打开后空闲");
        expect(answerableActions(settled, open[0] as never)).toEqual(["retry", "cancel"]);
        expect(closingAlerts(settled).map((alert) => alert.state)).toEqual(["resolved"]);
        expect(settled.tasks.find((task) => task.spec.id === "t1")?.waitingReason).toBe(
          "host-lost",
        );
        expect(checkLedgerInvariants(settled).ok).toBe(true);
        expect(host.sent).toHaveLength(sent);
        expect(host.calls.archives).toBe(0);
        expect(host.reads(MEMBER)).toBe(reads + 1);

        // The answer retry sends exactly one new task to the reopened member.
        const out = await answer(built, open[0]?.decisionId ?? "", "retry");
        expect(out).toMatchObject({ status: "applied", taskId: "t1" });
        expect(host.sent).toHaveLength(sent + 1);
        expect(host.sent.at(-1)?.agentId).toBe(MEMBER);
        await built.driver.kick(RUN_ID);
        expect(host.sent).toHaveLength(sent + 1);
        // And the new attempt is taken in like any other.
        await turnStarts(host, built, MEMBER);
        produce(host, MEMBER);
        host.runningAgents.delete(MEMBER);
        await turnEnded(host, built, MEMBER);
        expect(states(await stored()).t1).toBe("review");
      });
    }

    test("a restart of the plugin forgets what was seen: the closed receipt still dates the wait, and one look reads and settles", async () => {
      const host = fakeHost({ reopensOnRead: true });
      const first = build(host, { tickMs: 1, reopen: true });
      await reachWorking(host, first);
      host.close(MEMBER);
      await first.driver.onHook({ name: "agent.closed", agentId: MEMBER });
      expect(engineReceipts(await stored())).toHaveLength(0);
      const reads = host.reads(MEMBER);
      // A new process: nothing in memory. The receipt is older than 30 seconds by then.
      first.clock.jump(45_000);
      const second = build(host, { tickMs: 1, reopen: true });
      second.clock.jump(60_000);
      await second.driver.recover();
      await second.control.idle();
      const settled = await stored();
      expect(host.reads(MEMBER)).toBe(reads + 1);
      expect(engineReceipts(settled)).toHaveLength(1);
      expect(engineReceipts(settled)[0]).toMatchObject({ outcome: "host-lost" });
      expect(openDecisions(settled)).toHaveLength(1);
      expect(closingAlerts(settled).every((alert) => alert.state === "resolved")).toBe(true);
    });

    test("a kill with no receipt restarts the clock with the process: the first look after a restart only starts waiting", async () => {
      const host = fakeHost({ reopensOnRead: true });
      const first = build(host, { tickMs: 1, reopen: true });
      await reachWorking(host, first);
      host.close(MEMBER);
      await recoverWithoutHook(first, "kick");
      const second = build(host, { tickMs: 1, reopen: true });
      second.clock.jump(120_000);
      const before = await stored();
      await recoverWithoutHook(second, "recover");
      // The new process has no memory of when the member was first seen closed: the seat now reads idle
      // (it was reopened), nothing shows the turn was cut, and nothing is settled (T4b's own rules apply).
      expect(engineReceipts(await stored())).toHaveLength(0);
      expect((await stored()).revision).toBeGreaterThanOrEqual(before.revision);
    });

    test("the history cannot be read (a Codex member that never ran): one read, then member-lost with the host's words; a person's check reads once more; nothing loops", async () => {
      const host = fakeHost({ reopensOnRead: true });
      host.unopenable.add(MEMBER);
      const built = build(host, { tickMs: 1, reopen: true });
      await reachWorking(host, built);
      host.close(MEMBER);
      const reads = host.reads(MEMBER);
      await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
      const first = await stored();
      expect(host.reads(MEMBER)).toBe(reads + 1);
      expect(closingAlerts(first).map((alert) => alert.state)).toEqual(["open"]);
      expect(engineReceipts(first)).toHaveLength(0);

      // Automatic looks never read again.
      built.clock.jump(5_000);
      await built.driver.kick(RUN_ID);
      await recoverWithoutHook(built, "recover");
      expect(host.reads(MEMBER)).toBe(reads + 1);
      expect((await stored()).revision).toBe(first.revision);

      // A person's "check now" reads exactly once more, and still writes nothing inside 30 seconds.
      await person(built);
      expect(host.reads(MEMBER)).toBe(reads + 2);
      await built.driver.kick(RUN_ID);
      expect(host.reads(MEMBER)).toBe(reads + 2);
      expect(openDecisions(await stored())).toHaveLength(0);

      built.clock.jump(31_000);
      await built.driver.kick(RUN_ID);
      const settled = await stored();
      expect(engineReceipts(settled)).toHaveLength(1);
      expect(engineReceipts(settled)[0]).toMatchObject({ outcome: "agent-closed" });
      const open = openDecisions(settled);
      expect(open).toHaveLength(1);
      expect(decisionKindOf(settled, open[0] as never)).toBe("member-lost");
      expect(answerableActions(settled, open[0] as never)).toEqual(["cancel"]);
      expect(closingAlerts(settled).map((alert) => alert.state)).toEqual(["resolved"]);
      const note = settled.events.filter((event) => event.kind === "task-note").at(-1);
      expect(JSON.stringify(note?.payload)).toContain("Failed to resume Codex thread");
      expect(JSON.stringify(note?.payload)).toContain("no rollout found");

      // Done: nothing is read and nothing is written however long it sits or how often it is looked at.
      const revision = settled.revision;
      const seatReads = built.seatReads.count;
      const settlerReads = built.reopens.count;
      built.clock.jump(24 * 3600 * 1000);
      await built.driver.kick(RUN_ID);
      await recoverWithoutHook(built, "recover");
      await recoverWithoutHook(built, "kick");
      expect((await stored()).revision).toBe(revision);
      expect(built.seatReads.count).toBe(seatReads);
      expect(built.reopens.count).toBe(settlerReads);
    });

    test("the read leaves the member closed (no error): member-lost after 30 seconds, without a host message in the note", async () => {
      const host = fakeHost();
      const built = build(host, { tickMs: 1, reopen: true });
      await reachWorking(host, built);
      host.close(MEMBER);
      await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
      expect(built.reopens.count).toBe(1);
      expect(openDecisions(await stored())).toHaveLength(0);
      built.clock.jump(31_000);
      await built.driver.kick(RUN_ID);
      const settled = await stored();
      expect(openDecisions(settled)).toHaveLength(1);
      expect(decisionKindOf(settled, openDecisions(settled)[0] as never)).toBe("member-lost");
      const note = settled.events.filter((event) => event.kind === "task-note").at(-1);
      expect(JSON.stringify(note?.payload)).not.toContain("hostError");
    });

    test("the host has no such Agent any more, or it was archived: member-lost at once, no history is read", async () => {
      for (const how of ["absent", "archived"] as const) {
        await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        await store.close().catch(() => undefined);
        await setup();
        const host = fakeHost({ reopensOnRead: true });
        const built = build(host, { tickMs: 1, reopen: true });
        await reachWorking(host, built);
        host.runningAgents.delete(MEMBER);
        const reads = host.reads(MEMBER);
        if (how === "absent") {
          host.absentAgents.add(MEMBER);
        } else {
          await built.driver.onHook({ name: "agent.archived", agentId: MEMBER });
          host.close(MEMBER);
        }
        await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
        const settled = await stored();
        expect(engineReceipts(settled)).toHaveLength(1);
        expect(engineReceipts(settled)[0]).toMatchObject({ outcome: "agent-closed" });
        expect(decisionKindOf(settled, openDecisions(settled)[0] as never)).toBe("member-lost");
        expect(closingAlerts(settled)).toEqual([]);
        expect(built.reopens.count).toBe(0);
        expect(host.reads(MEMBER)).toBe(reads);
      }
    });

    test("a reviewer's turn is treated the same: host-lost after the wait, and retry sends exactly one new review", async () => {
      const host = fakeHost({ reopensOnRead: true });
      const built = build(host, { tickMs: 1, reopen: true });
      await reachReview(host, built);
      host.close(JUDGE);
      const sent = host.sent.length;
      await built.driver.onHook({ name: "agent.closed", agentId: JUDGE });
      expect(openDecisions(await stored())).toHaveLength(0);
      expect(closingAlerts(await stored()).map((alert) => alert.state)).toEqual(["open"]);
      built.clock.jump(31_000);
      await built.driver.kick(RUN_ID);
      const settled = await stored();
      expect(engineReceipts(settled).map((receipt) => receipt.agentId)).toEqual([JUDGE]);
      const open = openDecisions(settled);
      expect(open).toHaveLength(1);
      expect(decisionKindOf(settled, open[0] as never)).toBe("host-lost");
      expect(answerableActions(settled, open[0] as never)).toEqual(["retry", "cancel"]);
      expect(host.sent).toHaveLength(sent);
      const out = await answer(built, open[0]?.decisionId ?? "", "retry");
      expect(out).toMatchObject({ status: "applied", taskId: "t1" });
      expect(host.sent).toHaveLength(sent + 1);
      expect(host.sent.at(-1)?.agentId).toBe(JUDGE);
    });

    test("cancelling the whole Run: the turn is recorded as ended at once, no history is read, no decision is opened", async () => {
      const host = fakeHost({ reopensOnRead: true });
      const built = build(host, { tickMs: 1, reopen: true });
      await reachWorking(host, built);
      host.close(MEMBER);
      await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
      expect(closingAlerts(await stored()).map((alert) => alert.state)).toEqual(["open"]);
      const reads = built.reopens.count;
      await askForCancel(built);
      await built.driver.kick(RUN_ID);
      const done = await stored();
      expect(done.lifecycle).toBe("cancelled");
      expect(engineReceipts(done)).toHaveLength(1);
      expect(engineReceipts(done)[0]).toMatchObject({ outcome: "agent-closed" });
      expect(openDecisions(done)).toEqual([]);
      expect(built.reopens.count).toBe(reads);
    });

    test("a turn is running at the 30 seconds (a person wrote to the member): nothing is settled and the warning stays; it comes down once the person's turn is on the ledger", async () => {
      const host = fakeHost({ reopensOnRead: true });
      const built = build(host, { tickMs: 1, reopen: true });
      await reachWorking(host, built);
      host.close(MEMBER);
      await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
      // The reopened member is now working on something a person asked.
      host.runningAgents.add(MEMBER);
      built.clock.jump(31_000);
      await built.driver.kick(RUN_ID);
      const busy = await stored();
      expect(engineReceipts(busy)).toHaveLength(0);
      expect(openDecisions(busy)).toHaveLength(0);
      expect(closingAlerts(busy).map((alert) => alert.state)).toEqual(["open"]);
      // Looking again writes nothing.
      await built.driver.kick(RUN_ID);
      expect((await stored()).revision).toBe(busy.revision);

      // The person's turn begins on the ledger: the member works again, nothing was cut off for good.
      host.addUserMessage(MEMBER, "turn-person", "typed-by-the-person");
      await built.driver.onHook({
        name: "agent.turn_started",
        agentId: MEMBER,
        turnId: "turn-person",
      });
      await built.driver.kick(RUN_ID);
      const after = await stored();
      expect(engineReceipts(after)).toHaveLength(0);
      expect(closingAlerts(after).map((alert) => alert.state)).toEqual(["resolved"]);
    });

    test("cancelling the whole Run before any look has seen the closed member: the history is never read (no read to reopen it for a Run that is going away)", async () => {
      const host = fakeHost({ reopensOnRead: true });
      const built = build(host, { tickMs: 1, reopen: true });
      await reachWorking(host, built);
      host.close(MEMBER);
      await askForCancel(built);
      await built.driver.kick(RUN_ID);
      const done = await stored();
      expect(done.lifecycle).toBe("cancelled");
      // The settler's own reopening read is what is counted (other readers do read timelines).
      expect(built.reopens.count).toBe(0);
      expect(engineReceipts(done)).toHaveLength(1);
      expect(openDecisions(done)).toEqual([]);
    });

    test("the hold on the host reads of a member comes off as soon as the host says it started a turn (before any pass looks again)", async () => {
      const host = fakeHost({ reopensOnRead: true });
      const built = build(host, { tickMs: 1, reopen: true });
      await reachWorking(host, built);
      host.close(MEMBER);
      await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
      // Waiting: the Engine holds the member, so no reader opens its history behind its back.
      expect(built.watch.holds(MEMBER)).toBe(true);
      host.addUserMessage(MEMBER, "turn-person-hold", "typed-hold");
      host.runningAgents.add(MEMBER);
      await built.driver.onHook({
        name: "agent.turn_started",
        agentId: MEMBER,
        turnId: "turn-person-hold",
      });
      // A turn start does not kick a pass: the hook alone released it.
      expect(built.watch.holds(MEMBER)).toBe(false);
    });

    test("the coordinator is not waited on: only closed means member-lost at once, no history is read, no warning", async () => {
      const host = fakeHost({ reopensOnRead: true });
      const built = build(host, { tickMs: 1, reopen: true });
      await reachWorking(host, built);
      await store.update(RUN_ID, (current) => {
        const next = structuredClone(current);
        const assignment = next.assignments.find((entry) => entry.state === "assigned");
        if (assignment) assignment.purpose = "coordinator";
        return next;
      });
      host.close(MEMBER);
      const reads = built.reopens.count;
      await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
      const settled = await stored();
      expect(engineReceipts(settled)).toHaveLength(1);
      expect(engineReceipts(settled)[0]).toMatchObject({ outcome: "agent-closed" });
      expect(closingAlerts(settled)).toEqual([]);
      expect(built.reopens.count).toBe(reads);
      expect(openDecisions(settled)).toHaveLength(1);
      expect(decisionKindOf(settled, openDecisions(settled)[0] as never)).toBe("member-lost");
    });

    /** What a person pause leaves in the record: the Run is paused, the assignments are untouched. */
    async function pause() {
      await store.update(RUN_ID, (current) => {
        const next = structuredClone(current);
        next.lifecycle = "paused";
        return next;
      });
    }

    for (const withReceipt of [true, false]) {
      test(`a paused Run (${withReceipt ? "closed receipt" : "no receipt, the host reads it closed"}) is settled by the earlier rule at once: member-lost, no history read, no warning`, async () => {
        const host = fakeHost({ reopensOnRead: true });
        const built = build(host, { tickMs: 1, reopen: true });
        await reachWorking(host, built);
        await pause();
        host.close(MEMBER);
        const reads = built.reopens.count;
        if (withReceipt) await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
        else await built.driver.kick(RUN_ID);
        const settled = await stored();
        expect(settled.lifecycle).toBe("paused");
        expect(engineReceipts(settled)).toHaveLength(1);
        expect(engineReceipts(settled)[0]).toMatchObject({ outcome: "agent-closed" });
        expect(openDecisions(settled)).toHaveLength(1);
        expect(decisionKindOf(settled, openDecisions(settled)[0] as never)).toBe("member-lost");
        expect(closingAlerts(settled)).toEqual([]);
        expect(built.reopens.count).toBe(reads);
        // Settled once: looking again writes nothing.
        await built.driver.kick(RUN_ID);
        expect((await stored()).revision).toBe(settled.revision);
      });
    }

    test("a Run paused while a closed member turn waits: the next look settles it by the earlier rule and takes the warning down; no further read", async () => {
      const host = fakeHost({ reopensOnRead: true });
      const built = build(host, { tickMs: 1, reopen: true });
      await reachWorking(host, built);
      host.close(MEMBER);
      await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
      expect(closingAlerts(await stored()).map((alert) => alert.state)).toEqual(["open"]);
      const reads = built.reopens.count;
      await pause();
      await built.driver.kick(RUN_ID);
      const settled = await stored();
      expect(engineReceipts(settled)).toHaveLength(1);
      expect(engineReceipts(settled)[0]).toMatchObject({ outcome: "agent-closed" });
      expect(decisionKindOf(settled, openDecisions(settled)[0] as never)).toBe("member-lost");
      expect(closingAlerts(settled).map((alert) => alert.state)).toEqual(["resolved"]);
      expect(built.reopens.count).toBe(reads);
    });

    test("a look that cannot read the member while its turn waits keeps the warning, writes nothing and settles nothing; once it can be read the wait goes on from the first sight", async () => {
      const host = fakeHost({ reopensOnRead: true });
      const built = build(host, { tickMs: 1, reopen: true });
      await reachWorking(host, built);
      host.close(MEMBER);
      await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
      const waiting = await stored();
      expect(closingAlerts(waiting).map((alert) => alert.state)).toEqual(["open"]);
      expect(built.watch.holds(MEMBER)).toBe(true);

      host.unreadableAgents.add(MEMBER);
      built.clock.jump(40_000);
      await built.driver.kick(RUN_ID);
      await recoverWithoutHook(built, "recover");
      const failed = await stored();
      expect(failed.revision).toBe(waiting.revision);
      expect(closingAlerts(failed).map((alert) => alert.state)).toEqual(["open"]);
      expect(engineReceipts(failed)).toHaveLength(0);
      expect(openDecisions(failed)).toHaveLength(0);
      // Still held: nothing reads the member behind the Engine back.
      expect(built.watch.holds(MEMBER)).toBe(true);

      // It can be read again, and more than 30 seconds have gone by since the first sight: settled.
      host.unreadableAgents.delete(MEMBER);
      await built.driver.kick(RUN_ID);
      const settled = await stored();
      expect(engineReceipts(settled)).toHaveLength(1);
      expect(engineReceipts(settled)[0]).toMatchObject({ outcome: "host-lost" });
      expect(closingAlerts(settled).map((alert) => alert.state)).toEqual(["resolved"]);
    });

    test("the host own turn end after the hold was set takes the hold off before the report is read, so the report is taken in", async () => {
      const host = fakeHost({ reopensOnRead: true });
      const built = build(host, { tickMs: 1, reopen: true });
      await reachWorking(host, built);
      produce(host, MEMBER);
      host.close(MEMBER);
      await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
      expect(built.watch.holds(MEMBER)).toBe(true);
      expect(states(await stored()).t1).toBe("assigned");
      // The turn really did end (the host says so): its report must be readable by the hook that says it.
      await turnEnded(host, built, MEMBER, "completed");
      expect(states(await stored()).t1).toBe("review");
    });

    test("a person opens the member again and it works before the 30 seconds: nothing is settled and the warning comes down", async () => {
      const host = fakeHost({ reopensOnRead: true });
      const built = build(host, { tickMs: 1, reopen: true });
      await reachWorking(host, built);
      host.close(MEMBER);
      await built.driver.onHook({ name: "agent.closed", agentId: MEMBER });
      host.runningAgents.add(MEMBER);
      host.addUserMessage(MEMBER, "turn-person", "typed-by-the-person");
      await built.driver.onHook({
        name: "agent.turn_started",
        agentId: MEMBER,
        turnId: "turn-person",
      });
      built.clock.jump(60_000);
      await built.driver.kick(RUN_ID);
      const after = await stored();
      expect(engineReceipts(after)).toHaveLength(0);
      expect(openDecisions(after)).toHaveLength(0);
      expect(closingAlerts(after).map((alert) => alert.state)).toEqual(["resolved"]);
    });
  });
}

// --- E2a: a retried turn that reuses the id of one the Engine ended takes its own end from its hook ---

for (const schema of [1, 2] as const) {
  describe(`a retried turn whose id the host reused after a restart ends by its own hook [v${schema}]`, () => {
    beforeEach(async () => {
      version = schema;
      await setup();
    });

    for (const withReceipt of [true, false]) {
      const how = withReceipt
        ? "a graceful stop (a closed receipt)"
        : "a kill (no receipt, the host read it closed)";
      test(`${how}: host-lost, retry, the retry's turn_ended hook alone takes the report in and sends the review; a repeat of the hook and a late real end are dropped`, async () => {
        const host = fakeHost({ reopensOnRead: true });
        const first = build(host, { tickMs: 1, reopen: true });
        await reachWorking(host, first);
        const reusedId = host.turnOf(MEMBER);
        host.close(MEMBER);
        if (withReceipt) await first.driver.onHook({ name: "agent.closed", agentId: MEMBER });

        // The plugin restarts: a process that began after everything now in the ledger.
        const second = build(host, {
          tickMs: 1,
          reopen: true,
          start: "2026-11-05T13:00:00.000Z",
        });
        if (withReceipt) {
          second.clock.jump(60_000);
          await second.driver.recover();
          await second.control.idle();
        } else {
          await recoverWithoutHook(second, "kick");
          second.clock.jump(31_000);
          await second.driver.kick(RUN_ID);
        }
        const lost = await stored();
        expect(lost.schemaVersion).toBe(schema);
        const engineEnds = engineReceipts(lost);
        expect(engineEnds).toHaveLength(1);
        expect(engineEnds[0]).toMatchObject({
          outcome: "host-lost",
          turnId: reusedId,
          eventKey: `turn_ended:${MEMBER}:${reusedId}`,
        });
        const open = openDecisions(lost);
        expect(open).toHaveLength(1);

        // The retry reaches the member, and the restarted host gives its turn the id the old one had.
        host.reuseTurnId(MEMBER, reusedId);
        const out = await answer(second, open[0]?.decisionId ?? "", "retry");
        expect(out).toMatchObject({ status: "applied", taskId: "t1" });
        expect(host.turnOf(MEMBER)).toBe(reusedId);
        await turnStarts(host, second, MEMBER);
        const started = await stored();
        expect(
          started.eventReceipts.some(
            (r) =>
              r.kind === "turn_started" && r.eventKey === `turn_started:${MEMBER}:${reusedId}#2`,
          ),
        ).toBe(true);

        // The retry's turn ends. Its hook alone does it: no kick, no recovery.
        produce(host, MEMBER);
        host.runningAgents.delete(MEMBER);
        const revisionBefore = started.revision;
        const sentBefore = host.sent.length;
        await turnEnded(host, second, MEMBER);
        const after = await stored();
        const ends = after.eventReceipts.filter(
          (r) => r.kind === "turn_ended" && r.turnId === reusedId,
        );
        expect(ends.map((r) => r.eventKey)).toEqual([
          `turn_ended:${MEMBER}:${reusedId}`,
          `turn_ended:${MEMBER}:${reusedId}#2`,
        ]);
        expect(ends[1] as unknown as { settledBy?: string }).not.toHaveProperty("settledBy");
        expect(after.revision).toBeGreaterThan(revisionBefore);
        // The report is taken in and the review goes out in the same pass.
        expect(states(after).t1).toBe("review");
        expect(host.sent.length).toBe(sentBefore + 1);
        expect(host.sent.at(-1)?.agentId).toBe(JUDGE);
        expect(checkLedgerInvariants(after).ok).toBe(true);

        // The same hook again, and the first appearance's real end arriving late: both are duplicates.
        const settled = after.revision;
        await turnEnded(host, second, MEMBER);
        await second.driver.onHook({
          name: "agent.turn_ended",
          agentId: MEMBER,
          turnId: reusedId,
        });
        const dup = await stored();
        expect(dup.revision).toBe(settled);
        expect(host.sent).toHaveLength(sentBefore + 1);
      });
    }
  });
}

describe("the decision about a lost member says what to do, in Chinese", () => {
  test("the kind, the waiting reason and the seat denial all have words", () => {
    const text = explainWaiting("member-lost");
    expect(text.known).toBe(true);
    expect(JSON.stringify(text)).toContain("取消");
    expect(JSON.stringify(explainWaiting("waiting-for-seat:seat-archived"))).toContain("已被归档");
    expect(typeof explainDecision).toBe("function");
  });

  test("openLimboDecision for a lost member refuses a task that is not waiting on that assignment", () => {
    const record = bootstrapRun({ runId: RUN_ID });
    expect(
      openLimboDecision(record, {
        taskId: "t1",
        assignmentId: "nobody",
        reason: "member-lost",
        turnId: "turn-x",
        decisionId: "d1",
        controlNonceDigest: "0".repeat(64),
        now: "2026-11-09T00:00:00.000Z",
      }),
    ).toEqual({ changed: false });
  });
});

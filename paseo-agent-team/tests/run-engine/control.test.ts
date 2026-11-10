import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createCancelFinisher } from "../../server/run-engine/cancel";
import { createRunControl, type RunControl } from "../../server/run-engine/control";
import { createDagIntake } from "../../server/run-engine/dag";
import { createEngineDriver, type EngineDriver } from "../../server/run-engine/driver";
import { createEffects, payloadHash } from "../../server/run-engine/effects";
import { createObserverHost } from "../../server/run-engine/host";
import { createIntake } from "../../server/run-engine/intake";
import { createRunObserver } from "../../server/run-engine/observer";
import { projectDetail } from "../../server/run-engine/projection";
import { createEngineService } from "../../server/run-engine/service";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import { budgetExhaustedAlertPrefix } from "../../shared/domain/run-engine/budget";
import {
  CANCEL_COMPLETED_EVENT,
  CANCEL_PENDING_ALERT,
  CANCEL_REQUEST_EVENT,
} from "../../shared/domain/run-engine/cancel-request";
import { REPO_ALIAS, readDagControl } from "../../shared/domain/run-engine/dag-admission";
import { answerDecision, openLimboDecision } from "../../shared/domain/run-engine/decision-answer";
import { transitionIntent } from "../../shared/domain/run-engine/effect-state";
import {
  buildPlanSeats,
  compileEngineIntent,
  compilePlanRepair,
  PLAN_REPAIR_VERSION,
  planRequestFacts,
} from "../../shared/domain/run-engine/engine-prompts";
import { requestPlanRepair } from "../../shared/domain/run-engine/plan-repair";
import { compileDispatch } from "../../shared/domain/run-engine/prompt-template";
import { reduceRun } from "../../shared/domain/run-engine/reducer";
import type { PaseoEnginePort, PortTimelinePage } from "../../shared/paseo/port";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { PROFILE_HAIKU } from "../fixtures/run-engine/base";
import {
  bootstrapRun,
  COORDINATOR_AGENT,
  DAG_NONCE,
  dagBlock,
  PLAN_MESSAGE_ID,
  planTasks,
} from "./support/bootstrap-run";
import { ROLE } from "./support/plan-fixtures";
import { JUDGE_SEAT_REVIEW } from "./support/review-run";

/**
 * The three controls a person has over an Engine Run (P06), with a real store, a real git repository,
 * the real observer, intake, DAG intake, outbox and driver, and a host whose timelines the test writes.
 * Failure modes this file guards:
 *  - a re-plan that leaves the old plan's nonce, reply or re-send able to act, or that sends twice;
 *  - a decision answered twice, answered against a stale view, or answered for work that is not stopped;
 *  - a retry that releases a claim or reopens a gate it had no proof for;
 *  - a kick that sends a message a second time, or that moves a Run that is not live;
 *  - anything the controls return that carries a nonce, a prompt or an outbox argument.
 */

const RUN_ID = "run-ctl001-a1";

let home: string;
let repoDir: string;
let evidenceRoot: string;
let store: RunStore;

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

async function openStore(): Promise<RunStore> {
  const opened = createRunStore({
    home: path.join(home, "paseo"),
    lock: { acquireTimeoutMs: 300 },
  });
  await opened.initialize();
  return opened;
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), "run-control-")));
  repoDir = path.join(home, "repo");
  await mkdir(path.join(repoDir, "src"), { recursive: true });
  git(repoDir, "init", "-q", "-b", "main");
  await writeFile(path.join(repoDir, "src", "t1.ts"), "export {};\n");
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "-q", "-m", "base");
  evidenceRoot = path.join(home, "evidence").replaceAll("\\", "/");
  await mkdir(path.join(home, "paseo"));
  store = await openStore();
  const record = bootstrapRun({ runId: RUN_ID, planRequest: true });
  // The plan request as the launch pins it: everything the text is rebuilt from, replans included.
  const members = new Map([
    ["seat-b1", { memberName: "Developer", role: ROLE }],
    ["seat-b2", { memberName: "Reviewer", role: ROLE }],
  ]);
  const planIntent = record.outbox.find((entry) => entry.kind === "wake");
  if (planIntent) {
    planIntent.semanticArgs = {
      ...planRequestFacts({ seats: buildPlanSeats(record, members), devTargetUsable: true }),
      purpose: "plan",
      task: record.launch.modelPlan.task,
      controlNonce: DAG_NONCE,
    };
  }
  record.policy.evidenceRoot = evidenceRoot;
  // The tests whose name says [v2] run on a v2 ledger, the rest on the base fixture (v1).
  if (expect.getState().currentTestName?.includes("[v2]")) record.schemaVersion = 2;
  // Two attempts, then a person decides: the shortest road to a D4.
  record.policy.perTask.implementationAttempts = 2;
  await store.create(record);
});

afterEach(async () => {
  await store.close().catch(() => undefined);
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

// --- a host with agents whose timelines the test writes ----------------------------------------

type Sent = { agentId: string; text: string; messageId: string };
type PortTimelineEntry = PortTimelinePage["entries"][number];

function fakeHost() {
  const timelines = new Map<string, PortTimelineEntry[]>();
  const turns = new Map<string, string>();
  const sent: Sent[] = [];
  const archived: string[] = [];
  const lose = { next: false };
  // What the live state of an agent says, when the test wants it to say something else.
  const live: { override: "running" | "throw" | null } = { override: null };
  let seq = 0;
  let reads = 0;
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
  const page = (agentId: string): PortTimelinePage => ({
    entries: [...entries(agentId)],
    epoch: "e1",
    startCursor: null,
    hasOlder: false,
    hasNewer: false,
    gap: false,
    staleCursor: false,
    reset: false,
  });
  const port: PaseoEnginePort = {
    agents: {
      ref: (agentId) => ({
        send: async (text, options) => {
          const messageId = options?.messageId ?? "";
          sent.push({ agentId, text, messageId });
          // The host took the call and the answer was lost: nothing reaches the timeline.
          if (lose.next) {
            lose.next = false;
            throw new Error("the host did not answer");
          }
          add(agentId, `turn-${agentId}-${sent.length}`, { type: "user_message", messageId });
        },
        archive: async () => {
          archived.push(agentId);
        },
        timeline: {
          refetch: async () => {
            reads += 1;
            return page(agentId);
          },
        },
        current: () => ({ status: "idle", activeTurn: null }),
        // An agent that was spoken to and has not answered is working: a reader that acts without a
        // hook (a retry, a recovery) must not take its half-written turn for a finished one.
        refresh: async () => {
          if (live.override === "throw") throw new Error("the agent cannot be read");
          const last = entries(agentId).at(-1);
          const busy = live.override === "running" || last?.item.type === "user_message";
          return {
            agent: {
              status: busy ? "running" : "idle",
              activeTurn: busy ? { turnId: last?.turnId ?? "turn-live" } : null,
            },
          };
        },
      }),
    },
  };
  return {
    port,
    sent,
    archived,
    /** The next send throws after the host "received" it, and leaves no echo in the timeline. */
    loseNextSend: () => {
      lose.next = true;
    },
    /** The echo of the newest message sent to the agent reaches its timeline: it was delivered after all. */
    deliverLost: (agentId: string) => {
      const last = [...sent].reverse().find((entry) => entry.agentId === agentId);
      if (last) {
        add(agentId, `turn-${agentId}-late`, { type: "user_message", messageId: last.messageId });
      }
    },
    /** What the live state of agents says from now on; null for the ordinary behaviour. */
    liveState: (value: "running" | "throw" | null) => {
      live.override = value;
    },
    /** How many timeline reads the Engine has made. */
    reads: () => reads,
    planRequestSent: () =>
      add(COORDINATOR_AGENT, "turn-plan", { type: "user_message", messageId: PLAN_MESSAGE_ID }),
    reply: (agentId: string, text: string) =>
      add(agentId, turns.get(agentId) ?? "turn-plan", { type: "assistant_message", text }),
    turnOf: (agentId: string) => turns.get(agentId) ?? "turn-plan",
    lastSent: (agentId: string) => [...sent].reverse().find((entry) => entry.agentId === agentId),
    sentTo: (agentId: string) => sent.filter((entry) => entry.agentId === agentId),
  };
}

type Host = ReturnType<typeof fakeHost>;

type Built = {
  driver: EngineDriver;
  control: RunControl;
};

/** Everything the plugin wires, over the test's store and host. `noPush` drops the control's push. */
function build(
  host: Host,
  options: { noPush?: boolean; holdRepairs?: boolean; store?: RunStore } = {},
): Built {
  const useStore = options.store ?? store;
  const observerHost = createObserverHost(host.port);
  const observer = createRunObserver({ store: useStore });
  const effects = createEffects({ store: useStore, port: host.port, compile: compileEngineIntent });
  const profile = (family: string, id: string) => ({
    id,
    name: id,
    provider: "x",
    model: null,
    family,
  });
  const resolveWorkspace = () => ({ workspaceId: "ws-start", directory: repoDir });
  const service = createEngineService({
    store: useStore,
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
      if (seatId === JUDGE_SEAT_REVIEW) {
        return { profile: profile("luna", "profile-dev-luna"), available: true, order: 1 };
      }
      return null;
    },
    resolveWorkspace,
    compile: compileDispatch,
  });
  const intake = createIntake({
    store: useStore,
    observer,
    host: observerHost,
    // `holdRepairs`: the re-send is committed and the process stops before it is sent.
    repair: {
      send: (runId) => (options.holdRepairs ? Promise.resolve() : effects.runOutbox(runId)),
    },
  });
  const dagIntake = createDagIntake({
    store: useStore,
    host: observerHost,
    seatFamily: () => null,
    resolveWorkspace,
    repair: { send: (runId) => effects.runOutbox(runId) },
  });
  const driver = createEngineDriver({
    store: useStore,
    observer,
    host: observerHost,
    intake,
    dagIntake,
    service,
    outbox: { run: (runId) => effects.runOutbox(runId) },
    reconcileHost: createObserverHost(host.port, { requireIdle: true }),
    cancelFinisher: createCancelFinisher({
      store: useStore,
      readSeat: async (agentId) => {
        const refreshed = await host.port.agents.ref(agentId).refresh();
        return refreshed?.agent
          ? { status: refreshed.agent.status, activeTurn: refreshed.agent.activeTurn != null }
          : null;
      },
    }),
  });
  const control = createRunControl({
    store: useStore,
    ensureReady: async () => undefined,
    driver: options.noPush
      ? {
          retryRun: async () => ({
            status: "ok",
            dispatched: 0,
            finished: false,
            last: "idle",
            reason: null,
          }),
        }
      : driver,
  });
  return { driver, control };
}

async function stored(): Promise<RunRecord> {
  const read = await store.get(RUN_ID);
  if (read.status !== "ok") throw new Error(`run unreadable: ${read.status}`);
  return read.record;
}

const states = (record: RunRecord) =>
  Object.fromEntries(record.tasks.map((task) => [task.spec.id, task.state]));

// --- what the scripted agents do ---------------------------------------------------------------

function section<T>(text: string, label: string): T {
  const lines = text.split("\n");
  const index = lines.indexOf(label);
  if (index < 0) throw new Error(`no section ${label} in the prompt`);
  return JSON.parse(lines[index + 1] ?? "") as T;
}

type Identity = { taskId: string; attempt: number; messageId?: string; nonce?: string };
type Facts = {
  repoRoot: string;
  evidenceDir: string;
  workspace: unknown;
  delivery: { deliveryRef: unknown };
};
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
  git(facts.repoRoot, "commit", "-q", "-m", `deliver ${identity.taskId} ${identity.attempt}`);
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

function judge(host: Host, agentId: string, verdict = "可合入"): void {
  const prompt = host.lastSent(agentId)?.text ?? "";
  const { messageId: _unused, ...identity } = section<Identity>(prompt, "【身份资料 JSON】");
  const facts = section<Facts>(prompt, "【执行事实 JSON】");
  host.reply(
    agentId,
    fence("review-report", {
      ...identity,
      reviewedRef: facts.delivery.deliveryRef,
      verdict,
      blockers: verdict === "可合入" ? [] : [{ id: "b1", summary: "needs a change", path: null }],
      probes: [],
    }),
  );
}

/** A member (producer or judge) says it cannot do its job: the honest `blocked` report. */
function stop(host: Host, agentId: string, reasonCode = "ENVIRONMENT_UNAVAILABLE"): void {
  const prompt = host.lastSent(agentId)?.text ?? "";
  const { messageId: _unused, ...identity } = section<Identity>(prompt, "【身份资料 JSON】");
  host.reply(
    agentId,
    fence("task-report", {
      ...identity,
      status: "blocked",
      reasonCode,
      summary: "the check could not be run; stopped",
      evidence: [],
    }),
  );
}

const hook = (host: Host, driver: EngineDriver, agentId: string) =>
  driver.onHook({ name: "agent.turn_ended", agentId, turnId: host.turnOf(agentId) });

const plan = (overrides: Record<string, unknown> = {}) =>
  fence("task-dag", dagBlock(RUN_ID, planTasks(REPO_ALIAS), overrides));

/** A plan the checks refuse for what it says (not for its form): it names another repository. */
const wrongPlan = () => fence("task-dag", dagBlock(RUN_ID, planTasks("repo-elsewhere")));

const newNonce = (text: string): string =>
  section<{ nonce: string }>(text, "【控制身份 JSON】").nonce;

function request(expectedRevision: number, over: Record<string, unknown> = {}) {
  return {
    runContractVersion: 1 as const,
    runId: RUN_ID,
    requestId: "req-1",
    expectedRevision,
    reason: "please use the workspace alias",
    ...over,
  };
}

// === replan ====================================================================================

describe("replan", () => {
  /** A Run whose first plan was refused for what it says: it waits for a person. */
  async function refused(host: Host, b: Built): Promise<RunRecord> {
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, wrongPlan());
    await hook(host, b.driver, COORDINATOR_AGENT);
    const waiting = await stored();
    expect(waiting.lifecycle).toBe("awaiting-dag");
    expect(host.sent).toHaveLength(0);
    return waiting;
  }

  test("asks the coordinator again under a new nonce, once, and the new plan starts the Run", async () => {
    const host = fakeHost();
    const b = build(host);
    const waiting = await refused(host, b);
    expect(waiting.alerts.some((a) => a.state === "open" && a.summary.startsWith("DAG "))).toBe(
      true,
    );

    const out = await b.control.replan(request(waiting.revision));
    expect(out).toMatchObject({ status: "applied", epoch: 2, issues: [] });
    await b.control.idle();

    const after = await stored();
    expect(after.lifecycle).toBe("bootstrapping");
    expect(out.revision).toBeLessThanOrEqual(after.revision);
    // One new message to the coordinator, carrying the re-plan data and a nonce that is not the old one.
    expect(host.sent.map((entry) => entry.agentId)).toEqual([COORDINATOR_AGENT]);
    const text = host.lastSent(COORDINATOR_AGENT)?.text ?? "";
    expect(text).toContain("【重新规划资料 JSON】");
    expect(
      section<{ epoch: number; previousRefusal: string; operatorNote: string }>(
        text,
        "【重新规划资料 JSON】",
      ),
    ).toMatchObject({
      epoch: 2,
      operatorNote: "please use the workspace alias",
    });
    expect(text).toContain("DAG 被拒");
    expect(text).not.toContain(DAG_NONCE);
    expect(newNonce(text)).not.toBe(DAG_NONCE);
    // The control nonce in force is the new one (digest only in the ledger); the refusal is resolved.
    expect(readDagControl(after)?.nonceDigest).not.toBe(readDagControl(waiting)?.nonceDigest);
    expect(readDagControl(after)?.acceptedAt).toBeNull();
    expect(after.alerts.filter((a) => a.state === "open")).toEqual([]);
    expect(after.outbox.filter((i) => i.kind === "wake").map((i) => i.state)).toEqual([
      "confirmed",
      "confirmed",
    ]);
    // Both nonces are not in any event or alert of the ledger (history is not where they are kept).
    expect(JSON.stringify(after.events)).not.toContain(newNonce(text));

    host.reply(COORDINATOR_AGENT, plan({ nonce: newNonce(text) }));
    await hook(host, b.driver, COORDINATOR_AGENT);
    const started = await stored();
    expect(started.lifecycle).toBe("active");
    expect(states(started)).toEqual({ t1: "assigned", t2: "pending" });
    // Everything the plan requests asked leaves the outbox when the plan is in.
    expect(started.outbox.filter((i) => i.kind === "wake")).toEqual([]);
    expect(host.sent.map((entry) => entry.agentId)).toEqual([COORDINATOR_AGENT, "agent-b1"]);
  });

  test("a refusal found in a reply that was being read when the person asked again is not recorded against the new request", async () => {
    const host = fakeHost();
    // The coordinator's timeline read can be held: a settle of the old reply is still reading while
    // the re-plan commits, and then finds the same fault in it.
    let hold: Promise<void> | null = null;
    let reading: () => void = () => undefined;
    const readStarted = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const base = host.port;
    const held: PaseoEnginePort = {
      agents: {
        ref: (agentId) => {
          const handle = base.agents.ref(agentId);
          return {
            ...handle,
            timeline: {
              refetch: async (...args: Parameters<typeof handle.timeline.refetch>) => {
                if (hold !== null && agentId === COORDINATOR_AGENT) {
                  reading();
                  await hold;
                }
                return handle.timeline.refetch(...args);
              },
            },
          };
        },
      },
    };
    const b = build({ ...host, port: held });
    const waiting = await refused(host, b);

    let letGo: () => void = () => undefined;
    hold = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    const settling = b.driver.onHook({
      name: "agent.turn_ended",
      agentId: COORDINATOR_AGENT,
      turnId: "turn-plan",
    });
    await readStarted;
    hold = null;
    expect(await b.control.replan(request(waiting.revision))).toMatchObject({
      status: "applied",
      epoch: 2,
    });
    letGo();
    await settling;
    await b.control.idle();

    // The request is out and unanswered: the Run waits for the answer to it, with no refusal on it.
    const after = await stored();
    expect(after.lifecycle).toBe("bootstrapping");
    expect(after.alerts.filter((a) => a.state === "open")).toEqual([]);
    // So a second ask before the answer is still refused for what it is.
    expect(await b.control.replan(request(after.revision, { requestId: "req-2" }))).toMatchObject({
      status: "rejected",
      issues: [{ code: "replan-not-allowed" }],
    });
  });

  test("a plan made under the old nonce is refused, and the old reply is never read again", async () => {
    const host = fakeHost();
    const b = build(host);
    const waiting = await refused(host, b);
    await b.control.replan(request(waiting.revision));
    await b.control.idle();

    // While the new request is unanswered, a repeat of the old turn's hook reads nothing of the old epoch.
    const quiet = await stored();
    await b.driver.onHook({
      name: "agent.turn_ended",
      agentId: COORDINATOR_AGENT,
      turnId: "turn-plan",
    });
    expect((await stored()).alerts).toEqual(quiet.alerts);
    expect((await stored()).lifecycle).toBe("bootstrapping");

    // The coordinator answers the new request with a plan written under the OLD nonce: refused by it.
    host.reply(COORDINATOR_AGENT, plan({ nonce: DAG_NONCE }));
    await hook(host, b.driver, COORDINATOR_AGENT);
    const refusedAgain = await stored();
    expect(refusedAgain.lifecycle).toBe("awaiting-dag");
    expect(refusedAgain.tasks).toEqual([]);
    expect(
      refusedAgain.alerts.some((a) => a.state === "open" && a.summary.includes("control-nonce")),
    ).toBe(true);
    expect(host.sent).toHaveLength(1);

    // A person can ask again: a third epoch, with a third nonce.
    const third = await b.control.replan(request(refusedAgain.revision, { requestId: "req-2" }));
    expect(third).toMatchObject({ status: "applied", epoch: 3 });
    await b.control.idle();
    const text = host.lastSent(COORDINATOR_AGENT)?.text ?? "";
    expect(section<{ epoch: number }>(text, "【重新规划资料 JSON】").epoch).toBe(3);
    expect(host.sent).toHaveLength(2);
    host.reply(COORDINATOR_AGENT, plan({ nonce: newNonce(text) }));
    await hook(host, b.driver, COORDINATOR_AGENT);
    expect((await stored()).lifecycle).toBe("active");
  });

  test("the re-send of the old plan that was only prepared is failed, so it is never sent with the old nonce", async () => {
    const host = fakeHost();
    const b = build(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, wrongPlan());
    await hook(host, b.driver, COORDINATOR_AGENT);
    // The process stopped after the format re-send was committed and before it was sent.
    await store.update(RUN_ID, (current) => {
      const plan = current.outbox.find((entry) => entry.kind === "wake");
      const asked = requestPlanRepair(current, {
        agentId: COORDINATOR_AGENT,
        anchor: plan?.messageId ?? "",
        reason: "plan-rejected:schema-invalid",
        issues: [{ path: "tasks.0.group", message: "invalid_type" }],
        intentId: "intent-plan-repair-x1",
        messageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
        payloadHash: "0".repeat(64),
        templateVersion: PLAN_REPAIR_VERSION,
        now: "2026-11-07T00:00:00.000Z",
      });
      if (!asked.ok) throw new Error(`cannot ask again: ${asked.code}`);
      const wake = asked.next.outbox.at(-1);
      const text = wake?.kind === "wake" ? compilePlanRepair(wake, asked.next) : null;
      if (!wake || text === null) throw new Error("the re-send cannot be built");
      wake.payloadHash = payloadHash(text);
      return asked.next;
    });
    const waiting = await stored();
    const repair = waiting.outbox.find(
      (entry) => entry.kind === "wake" && entry.semanticArgs.purpose === "plan-repair",
    );
    expect(repair?.state).toBe("prepared");
    expect(waiting.lifecycle).toBe("awaiting-dag");
    expect(host.sent).toHaveLength(0);

    const out = await b.control.replan(request(waiting.revision));
    expect(out.status).toBe("applied");
    await b.control.idle();
    const after = await stored();
    expect(
      after.outbox
        .filter((entry) => entry.kind === "wake")
        .map((entry) => [entry.semanticArgs.purpose, entry.state]),
    ).toEqual([
      ["plan", "confirmed"],
      ["plan-repair", "failed"],
      ["plan", "confirmed"],
    ]);
    expect(host.sent).toHaveLength(1);
    expect(host.sent[0]?.text).not.toContain(DAG_NONCE);
    expect(host.sent[0]?.text).toContain("【重新规划资料 JSON】");
    // The failed re-send is named in the audit trail, and the ledger still holds together.
    expect(after.events.some((event) => event.kind === "replan-requested")).toBe(true);
    // Its count starts again: a refusal of the new plan for its form is asked about once more.
    const reply = host.lastSent(COORDINATOR_AGENT)?.text ?? "";
    host.reply(
      COORDINATOR_AGENT,
      fence("task-dag", {
        ...dagBlock(RUN_ID, planTasks(REPO_ALIAS), { nonce: newNonce(reply) }),
        tasks: planTasks(REPO_ALIAS).map(({ group: _group, ...rest }) => rest),
      }),
    );
    await hook(host, b.driver, COORDINATOR_AGENT);
    expect(host.sent).toHaveLength(2);
    expect(host.lastSent(COORDINATOR_AGENT)?.text).toContain("tasks.0.group");
  });

  test("the same request is the same request: repeated, also after a restart, it sends and writes nothing", async () => {
    const host = fakeHost();
    const b = build(host);
    const waiting = await refused(host, b);
    const input = request(waiting.revision);
    expect((await b.control.replan(input)).status).toBe("applied");
    await b.control.idle();
    const done = await stored();

    const again = await b.control.replan(input);
    expect(again).toMatchObject({ status: "replayed", epoch: 2 });
    expect(again.revision).toBe(done.revision);

    // A restart: a new store over the same files, a new driver, the same request.
    await store.close();
    store = await openStore();
    const restarted = build(host);
    const replay = await restarted.control.replan(input);
    expect(replay).toMatchObject({ status: "replayed", epoch: 2 });
    await restarted.control.idle();
    expect((await stored()).revision).toBe(done.revision);
    expect(host.sent).toHaveLength(1);

    // The same id for another reason is a mistake, not the same request.
    const reused = await restarted.control.replan({ ...input, reason: "something else" });
    expect(reused).toMatchObject({ status: "rejected", issues: [{ code: "request-id-reused" }] });
  });

  test("a stale revision, a Run that is not waiting for a plan and a second ask are refused, and nothing changes", async () => {
    const host = fakeHost();
    const b = build(host);
    const before = await b.control.replan(request(1));
    // Still bootstrapping: the plan request has not been answered, so there is nothing to re-plan.
    expect(before).toMatchObject({
      status: "rejected",
      epoch: null,
      issues: [{ code: "replan-not-allowed", params: { lifecycle: "bootstrapping" } }],
    });

    const waiting = await refused(host, b);
    const stale = await b.control.replan(request(waiting.revision - 1));
    expect(stale).toMatchObject({
      status: "rejected",
      issues: [{ code: "revision-conflict", params: { current: waiting.revision } }],
    });
    expect((await stored()).revision).toBe(waiting.revision);

    expect((await b.control.replan(request(waiting.revision))).status).toBe("applied");
    await b.control.idle();
    // A second ask while the first is unanswered.
    const second = await b.control.replan(
      request((await stored()).revision, { requestId: "req-2" }),
    );
    expect(second).toMatchObject({ status: "rejected", issues: [{ code: "replan-not-allowed" }] });
    expect(host.sent).toHaveLength(1);

    // An active Run has work in flight and a graph to revise: that is not this control.
    const reply = host.lastSent(COORDINATOR_AGENT)?.text ?? "";
    host.reply(COORDINATOR_AGENT, plan({ nonce: newNonce(reply) }));
    await hook(host, b.driver, COORDINATOR_AGENT);
    const active = await b.control.replan(
      request((await stored()).revision, { requestId: "req-3" }),
    );
    expect(active).toMatchObject({
      status: "rejected",
      issues: [{ code: "replan-not-allowed", params: { lifecycle: "active" } }],
    });
  });

  test("a message to the coordinator whose delivery is not settled is waited for, not talked over", async () => {
    const host = fakeHost();
    const b = build(host);
    const waiting = await refused(host, b);
    // The request that was answered is not confirmed after all (the host's echo was never seen).
    await store.update(RUN_ID, (current) => {
      const wake = current.outbox.find((i) => i.kind === "wake");
      if (!wake) return null;
      wake.state = "outcome-unknown";
      wake.confirmedAt = null;
      return current;
    });
    const out = await b.control.replan(request((await stored()).revision));
    expect(out).toMatchObject({ status: "rejected", issues: [{ code: "delivery-unresolved" }] });
    expect(waiting.lifecycle).toBe("awaiting-dag");
    expect((await stored()).lifecycle).toBe("awaiting-dag");
    expect(host.sent).toHaveLength(0);
  });

  test("the request is committed before it is sent: a stop in between is finished by recovery, once", async () => {
    const host = fakeHost();
    const b = build(host, { noPush: true });
    const waiting = await refused(host, b);
    expect((await b.control.replan(request(waiting.revision))).status).toBe("applied");
    // The process stopped here: the request is in the ledger, prepared, and nothing went out.
    expect(host.sent).toHaveLength(0);
    expect((await stored()).outbox.at(-1)?.state).toBe("prepared");

    const next = build(host);
    expect(await next.driver.recover()).toEqual({ runs: 1 });
    expect(host.sent).toHaveLength(1);
    expect((await stored()).outbox.at(-1)?.state).toBe("confirmed");
    // Recovered again, or kicked: the sent message is not sent again.
    await next.driver.recover();
    await next.control.kick({ runContractVersion: 1, runId: RUN_ID });
    expect(host.sent).toHaveLength(1);
  });

  test("a request whose delivery is unknown is not sent again by recovery or by a kick", async () => {
    const host = fakeHost();
    const b = build(host, { noPush: true });
    const waiting = await refused(host, b);
    await b.control.replan(request(waiting.revision));
    // The send was started and its result is not known; the host has no trace of the message.
    await store.update(RUN_ID, (current) => {
      const wake = current.outbox.at(-1);
      if (!wake) return null;
      const sending = transitionIntent(current, wake.id, "sending", {
        now: "2026-11-07T00:00:00.000Z",
      });
      if (!sending.ok) return null;
      const unknown = transitionIntent(sending.next, wake.id, "outcome-unknown", {
        now: "2026-11-07T00:00:01.000Z",
      });
      return unknown.ok ? unknown.next : null;
    });
    const next = build(host);
    await next.driver.recover();
    await next.control.kick({ runContractVersion: 1, runId: RUN_ID });
    expect(host.sent).toHaveLength(0);
    expect((await stored()).outbox.at(-1)?.state).toBe("outcome-unknown");
  });
});

// === decide ====================================================================================

describe("decide", () => {
  /** t1 produced and reviewed "修改后合入" until the attempt cap: it is `blocked`, frozen, with a D4. */
  async function reachD4(host: Host, b: Built): Promise<RunRecord> {
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, b.driver, COORDINATOR_AGENT);
    for (let round = 1; round <= 2; round += 1) {
      produce(host, "agent-b1");
      await hook(host, b.driver, "agent-b1");
      judge(host, "agent-b2", "修改后合入");
      await hook(host, b.driver, "agent-b2");
    }
    const frozen = await stored();
    expect(states(frozen).t1).toBe("blocked");
    return frozen;
  }

  const answer = (
    decisionId: string,
    expectedRevision: number,
    over: Record<string, unknown> = {},
  ) => ({
    runContractVersion: 1 as const,
    runId: RUN_ID,
    decisionId,
    requestId: "ans-1",
    expectedRevision,
    reason: "I looked at it, one more try",
    answer: { action: "retry" as const },
    ...over,
  });

  test("D4: a retry is one more attempt on the same task, taken once, and the next failure asks again", async () => {
    const host = fakeHost();
    const b = build(host);
    const frozen = await reachD4(host, b);
    const decision = frozen.decisions.find((d) => d.category === "D4");
    expect(decision?.state).toBe("open");
    expect(frozen.tasks[0]).toMatchObject({ state: "blocked", phase: "frozen", attempts: 2 });
    expect(frozen.resources.every((claim) => claim.frozen)).toBe(true);
    const sentBefore = host.sent.length;

    // The view says what can be answered and that it can.
    const view = projectDetail(frozen);
    if (!view.ok) throw new Error("projection failed");
    expect(view.view.decisions.map((d) => d.actions)).toEqual([["retry", "cancel"]]);
    expect(view.view.capabilities.supportedControls).toEqual([
      "decide",
      "kick",
      "pause",
      "cancel",
      "budget",
    ]);

    const out = await b.control.decide(answer(decision?.decisionId ?? "", frozen.revision));
    expect(out).toMatchObject({ status: "applied", taskId: "t1", issues: [] });
    await b.control.idle();

    // The same task went on: a rework dispatch, attempt 3, to the same producer seat, claims kept.
    const after = await stored();
    expect(after.tasks[0]).toMatchObject({ state: "assigned", attempts: 3, reworkCount: 2 });
    expect(host.sent).toHaveLength(sentBefore + 1);
    expect(host.lastSent("agent-b1")?.text).toContain("【返工说明】");
    const answered = after.decisions.find((d) => d.decisionId === decision?.decisionId);
    expect(answered).toMatchObject({
      state: "answered",
      answer: { action: "retry", taskIds: ["t1"] },
    });
    expect(after.tasks[0]?.releaseDecisionId).toBe(decision?.decisionId);
    expect(after.resources.map((claim) => claim.claimId)).toEqual(
      frozen.resources.map((claim) => claim.claimId),
    );
    // The same claims, no longer frozen: the task holds the repository because it is working again.
    expect(after.resources.every((claim) => !claim.frozen)).toBe(true);

    // The same answer again is the same answer: nothing is written or sent. Someone else's does not stand.
    const replay = await b.control.decide(answer(decision?.decisionId ?? "", frozen.revision));
    expect(replay).toMatchObject({ status: "replayed", taskId: "t1" });
    const other = await b.control.decide(
      answer(decision?.decisionId ?? "", after.revision, { requestId: "ans-2" }),
    );
    expect(other).toMatchObject({ status: "rejected", issues: [{ code: "decision-answered" }] });
    await b.control.idle();
    expect((await stored()).revision).toBe(after.revision);
    expect(host.sent).toHaveLength(sentBefore + 1);

    // One more attempt, not a licence: attempt 3 fails its review, and a new decision waits.
    produce(host, "agent-b1");
    await hook(host, b.driver, "agent-b1");
    judge(host, "agent-b2", "修改后合入");
    await hook(host, b.driver, "agent-b2");
    const again = await stored();
    expect(states(again).t1).toBe("blocked");
    const open = again.decisions.filter((d) => d.state === "open");
    expect(open).toHaveLength(1);
    expect(open[0]?.decisionId).not.toBe(decision?.decisionId);
  });

  test("the answer survives a restart: asked again afterwards it is the same answer and sends nothing", async () => {
    const host = fakeHost();
    const b = build(host);
    const frozen = await reachD4(host, b);
    const decision = frozen.decisions.find((d) => d.category === "D4");
    const input = answer(decision?.decisionId ?? "", frozen.revision);
    expect((await b.control.decide(input)).status).toBe("applied");
    await b.control.idle();
    const sent = host.sent.length;
    const done = await stored();

    await store.close();
    store = await openStore();
    const restarted = build(host);
    expect(await restarted.control.decide(input)).toMatchObject({
      status: "replayed",
      taskId: "t1",
    });
    await restarted.driver.recover();
    await restarted.control.idle();
    expect(host.sent).toHaveLength(sent);
    expect((await stored()).revision).toBe(done.revision);
  });

  test("an answer committed before a stop is carried out by the recovery that follows, once", async () => {
    const host = fakeHost();
    const b = build(host, { noPush: true });
    const frozen = await reachD4(host, b);
    const decision = frozen.decisions.find((d) => d.category === "D4");
    const sent = host.sent.length;
    expect(
      (await b.control.decide(answer(decision?.decisionId ?? "", frozen.revision))).status,
    ).toBe("applied");
    // The process stopped here: the task is back in `rework` and nothing was sent.
    expect((await stored()).tasks[0]?.state).toBe("rework");
    expect(host.sent).toHaveLength(sent);

    const next = build(host);
    await next.driver.recover();
    expect(host.sent).toHaveLength(sent + 1);
    expect((await stored()).tasks[0]).toMatchObject({ state: "assigned", attempts: 3 });
    await next.driver.recover();
    await next.control.kick({ runContractVersion: 1, runId: RUN_ID });
    expect(host.sent).toHaveLength(sent + 1);
  });

  test("a stale revision, an unknown decision and a decision this build cannot answer are refused, and nothing changes", async () => {
    const host = fakeHost();
    const b = build(host);
    const frozen = await reachD4(host, b);
    const decision = frozen.decisions.find((d) => d.category === "D4");

    const stale = await b.control.decide(answer(decision?.decisionId ?? "", frozen.revision - 1));
    expect(stale).toMatchObject({
      status: "rejected",
      issues: [{ code: "revision-conflict", params: { current: frozen.revision } }],
    });
    const missing = await b.control.decide(
      answer("00000000-0000-4000-8000-000000000000", frozen.revision),
    );
    expect(missing).toMatchObject({ status: "rejected", issues: [{ code: "decision-missing" }] });

    // A decision of a kind with no answer yet (here D2) is shown but not answerable.
    const seeded = "11111111-1111-4111-8111-111111111111";
    await store.update(RUN_ID, (current) => {
      current.decisions.push({
        decisionId: seeded,
        category: "D2",
        controlNonceDigest: "a".repeat(64),
        state: "open",
        dedupeKey: "other:1",
        cancelIntents: null,
        subjectId: "t1",
        summary: "requirements disagree",
        createdAt: current.updatedAt,
        answeredAt: null,
        answer: null,
        resolution: null,
      });
      return current;
    });
    const fresh = await stored();
    const odd = await b.control.decide(answer(seeded, fresh.revision));
    expect(odd).toMatchObject({
      status: "rejected",
      issues: [{ code: "decision-not-answerable", params: { category: "D2" } }],
    });
    const view = projectDetail(fresh);
    if (!view.ok) throw new Error("projection failed");
    expect(view.view.decisions.find((d) => d.decisionId === seeded)?.actions).toEqual([]);
    expect((await stored()).revision).toBe(fresh.revision);
    expect((await stored()).tasks[0]?.state).toBe("blocked");
  });

  test("work that is not proven stopped is not released, and neither is a Run that is not live", async () => {
    const host = fakeHost();
    const b = build(host);
    const frozen = await reachD4(host, b);
    const decision = frozen.decisions.find((d) => d.category === "D4");
    const ask = (record: RunRecord) =>
      answerDecision(record, {
        decisionId: decision?.decisionId ?? "",
        requestId: "ans-1",
        expectedRevision: record.revision,
        reason: "again",
        action: "retry",
        now: "2026-11-08T00:00:00.000Z",
      });

    // The reviewer's turn is not recorded as ended (say the receipt was lost): nobody may be sure it stopped.
    const unsettled = structuredClone(frozen);
    const reviewer = unsettled.assignments.findLast((a) => a.purpose === "reviewer");
    if (!reviewer) throw new Error("no reviewer");
    reviewer.state = "in_progress";
    expect(ask(unsettled)).toEqual({
      ok: false,
      code: "task-not-releasable",
      reason: "actors-unsettled",
    });
    // A message of the task that was sent and never settled (a repair nobody answered) is not settled either.
    const open = structuredClone(frozen);
    open.outbox.push({
      id: "intent-repair-left",
      kind: "wake",
      recipient: reviewer.agentId,
      messageId: "99999999-9999-4999-8999-999999999999",
      idempotencyKey: "repair:left",
      payloadHash: "9".repeat(64),
      templateVersion: 1,
      state: "confirmed",
      recoverySendCount: 0,
      createdAt: frozen.updatedAt,
      confirmedAt: frozen.updatedAt,
      localCancellation: null,
      taskId: "t1",
      assignmentId: reviewer.assignmentId,
      semanticArgs: { purpose: "repair" },
    });
    expect(ask(open)).toEqual({
      ok: false,
      code: "task-not-releasable",
      reason: "effects-unsettled",
    });

    // A paused Run sends nothing, and a retry would be a send waiting to happen.
    await store.update(RUN_ID, (current) => {
      const paused = reduceRun(
        current,
        { kind: "run-paused" },
        { now: new Date().toISOString(), newId: () => "x" },
      );
      return paused.ok ? paused.next : null;
    });
    const paused = await stored();
    const out = await b.control.decide(answer(decision?.decisionId ?? "", paused.revision));
    expect(out).toMatchObject({
      status: "rejected",
      issues: [{ code: "run-not-active", params: { lifecycle: "paused" } }],
    });
    expect((await stored()).revision).toBe(paused.revision);
    expect((await stored()).tasks[0]?.state).toBe("blocked");
    expect((await stored()).resources.every((claim) => claim.frozen)).toBe(true);
  });

  test("a producer that stopped is retried as a fresh attempt: its claims are released and asked for again", async () => {
    const host = fakeHost();
    const b = build(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, b.driver, COORDINATOR_AGENT);
    stop(host, "agent-b1", "EVIDENCE_UNAVAILABLE");
    await hook(host, b.driver, "agent-b1");

    // Stopped, frozen, holding the repository; the Engine opened the decision a person answers.
    const frozen = await stored();
    expect(frozen.tasks[0]).toMatchObject({
      state: "blocked",
      phase: "frozen",
      waitingReason: "EVIDENCE_UNAVAILABLE",
    });
    const decision = frozen.decisions.find((d) => d.state === "open");
    expect(decision).toMatchObject({ category: "D1", subjectId: "t1" });
    expect(decision?.dedupeKey).toMatch(/^stuck:/u);
    const oldClaims = frozen.resources.map((claim) => claim.claimId);
    expect(oldClaims.length).toBeGreaterThan(0);
    // Looking again opens nothing more.
    await b.driver.kick(RUN_ID);
    expect((await stored()).decisions).toHaveLength(1);

    const out = await b.control.decide(
      answer(decision?.decisionId ?? "", (await stored()).revision),
    );
    expect(out.status).toBe("applied");
    await b.control.idle();
    const after = await stored();
    // A new attempt of the same task, the ordinary producer text (no previous delivery to rework).
    expect(after.tasks[0]).toMatchObject({ state: "assigned", attempts: 2, reworkCount: 1 });
    expect(host.lastSent("agent-b1")?.text).not.toContain("【返工说明】");
    expect(after.resources.length).toBeGreaterThan(0);
    expect(after.resources.map((claim) => claim.claimId)).not.toEqual(oldClaims);

    produce(host, "agent-b1");
    await hook(host, b.driver, "agent-b1");
    judge(host, "agent-b2");
    await hook(host, b.driver, "agent-b2");
    expect(states(await stored()).t1).toBe("done");
  });

  test("a reviewer that could not review is sent again on the delivery that stands, keeping the claims", async () => {
    const host = fakeHost();
    const b = build(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, b.driver, COORDINATOR_AGENT);
    produce(host, "agent-b1");
    await hook(host, b.driver, "agent-b1");
    stop(host, "agent-b2");
    await hook(host, b.driver, "agent-b2");

    const frozen = await stored();
    expect(states(frozen).t1).toBe("blocked");
    const decision = frozen.decisions.find((d) => d.state === "open");
    expect(decision?.dedupeKey).toMatch(/^stuck:/u);
    const claims = frozen.resources.map((claim) => claim.claimId);
    const sentBefore = host.sent.length;

    const out = await b.control.decide(answer(decision?.decisionId ?? "", frozen.revision));
    expect(out.status).toBe("applied");
    await b.control.idle();
    const after = await stored();
    expect(after.tasks[0]).toMatchObject({ state: "review", attempts: 1 });
    expect(after.resources.map((claim) => claim.claimId)).toEqual(claims);
    expect(after.resources.every((claim) => !claim.frozen)).toBe(true);
    // Not a rework and not a new delivery: only the judge was asked again.
    expect(host.sent).toHaveLength(sentBefore + 1);
    expect(host.sentTo("agent-b2")).toHaveLength(2);
    expect(host.sentTo("agent-b1")).toHaveLength(1);

    judge(host, "agent-b2");
    await hook(host, b.driver, "agent-b2");
    const done = await stored();
    expect(states(done)).toEqual({ t1: "done", t2: "assigned" });
  });

  test("a stopped task whose decision was never opened (an older ledger) gets one on the next look", async () => {
    const host = fakeHost();
    const b = build(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, b.driver, COORDINATOR_AGENT);
    stop(host, "agent-b1");
    await hook(host, b.driver, "agent-b1");
    await store.update(RUN_ID, (current) => {
      current.decisions = [];
      return current;
    });
    expect((await stored()).decisions).toEqual([]);
    await b.driver.kick(RUN_ID);
    await b.driver.kick(RUN_ID);
    const after = await stored();
    expect(after.decisions).toHaveLength(1);
    expect(after.decisions[0]).toMatchObject({ category: "D1", state: "open", subjectId: "t1" });
  });
  describe("cancel", () => {
    const cancelAnswer = (decisionId: string, expectedRevision: number, over = {}) =>
      answer(decisionId, expectedRevision, { answer: { action: "cancel" as const }, ...over });
    const find = (record: RunRecord, taskId: string) =>
      record.tasks.find((task) => task.spec.id === taskId);

    /** What a cancellation leaves: both tasks cancelled, nothing claimed, nobody told anything. */
    async function expectCancelled(host: Host, b: Built, sentBefore: number): Promise<RunRecord> {
      await b.control.idle();
      const after = await stored();
      expect(states(after)).toEqual({ t1: "cancelled", t2: "cancelled" });
      expect(after.resources).toEqual([]);
      expect(after.lifecycle).toBe("finished");
      expect(host.sent).toHaveLength(sentBefore);
      return after;
    }

    test.each(["v1", "v2"] as const)(
      "[%s] a D4: the task and everything that depends on it are cancelled, the claims go, the Run finishes, and nothing is sent",
      async (version) => {
        const host = fakeHost();
        const b = build(host);
        const frozen = await reachD4(host, b);
        const decision = frozen.decisions.find((d) => d.category === "D4");
        const sentBefore = host.sent.length;
        const out = await b.control.decide(
          cancelAnswer(decision?.decisionId ?? "", frozen.revision),
        );
        expect(out).toMatchObject({
          status: "applied",
          taskId: "t1",
          cancelledTaskIds: ["t1", "t2"],
          issues: [],
        });
        const after = await expectCancelled(host, b, sentBefore);
        expect(after.schemaVersion).toBe(version === "v1" ? 1 : 2);

        // The decision the person answered carries the request; the reducer's own D1 was answered for the
        // release, names that decision, and is what the task's release is bound to.
        const answered = after.decisions.find((d) => d.decisionId === decision?.decisionId);
        expect(answered).toMatchObject({
          state: "answered",
          answer: { action: "cancel", taskIds: ["t1", "t2"], requestId: "ans-1" },
        });
        const release = after.decisions.find((d) => d.dedupeKey === "cancel:t1");
        expect(release).toMatchObject({
          category: "D1",
          state: "answered",
          answer: {
            action: "cancel",
            taskIds: ["t1"],
            requestId: "ans-1",
            via: decision?.decisionId,
          },
        });
        expect(find(after, "t1")?.releaseDecisionId).toBe(release?.decisionId);

        // The same answer again is the same answer; someone else's does not stand.
        const replay = await b.control.decide(
          cancelAnswer(decision?.decisionId ?? "", frozen.revision),
        );
        expect(replay).toMatchObject({ status: "replayed", taskId: "t1" });
        const other = await b.control.decide(
          cancelAnswer(decision?.decisionId ?? "", after.revision, { requestId: "ans-2" }),
        );
        expect(other).toMatchObject({
          status: "rejected",
          issues: [{ code: "decision-answered" }],
        });
        expect((await stored()).revision).toBe(after.revision);
      },
    );

    test("a producer that reported blocked is cancelled, with its frozen claim released", async () => {
      const host = fakeHost();
      const b = build(host);
      host.planRequestSent();
      host.reply(COORDINATOR_AGENT, plan());
      await hook(host, b.driver, COORDINATOR_AGENT);
      stop(host, "agent-b1", "EVIDENCE_UNAVAILABLE");
      await hook(host, b.driver, "agent-b1");
      const frozen = await stored();
      const decision = frozen.decisions.find((d) => d.state === "open");
      expect(decision?.dedupeKey).toMatch(/^stuck:/u);
      const sentBefore = host.sent.length;
      const out = await b.control.decide(cancelAnswer(decision?.decisionId ?? "", frozen.revision));
      expect(out).toMatchObject({ status: "applied", cancelledTaskIds: ["t1", "t2"] });
      await expectCancelled(host, b, sentBefore);
    });

    test("a judge that could not judge: the task is cancelled, the delivery stays on the branch", async () => {
      const host = fakeHost();
      const b = build(host);
      host.planRequestSent();
      host.reply(COORDINATOR_AGENT, plan());
      await hook(host, b.driver, COORDINATOR_AGENT);
      produce(host, "agent-b1");
      await hook(host, b.driver, "agent-b1");
      stop(host, "agent-b2");
      await hook(host, b.driver, "agent-b2");
      const frozen = await stored();
      const decision = frozen.decisions.find((d) => d.state === "open");
      const sentBefore = host.sent.length;
      const out = await b.control.decide(cancelAnswer(decision?.decisionId ?? "", frozen.revision));
      expect(out.status).toBe("applied");
      await expectCancelled(host, b, sentBefore);
    });

    test("work that is not proven stopped, or a dependent that already started, is not cancelled", async () => {
      const host = fakeHost();
      const b = build(host);
      const frozen = await reachD4(host, b);
      const decision = frozen.decisions.find((d) => d.category === "D4");
      const ask = (record: RunRecord) =>
        answerDecision(record, {
          decisionId: decision?.decisionId ?? "",
          requestId: "ans-1",
          expectedRevision: record.revision,
          reason: "stop",
          action: "cancel",
          now: "2026-11-08T00:00:00.000Z",
          newId: (kind) => `${kind}-00000000-0000-4000-8000-000000000001`,
          controlNonceDigest: "c".repeat(64),
        });

      const unsettled = structuredClone(frozen);
      const reviewer = unsettled.assignments.findLast((a) => a.purpose === "reviewer");
      if (!reviewer) throw new Error("no reviewer");
      reviewer.state = "in_progress";
      expect(ask(unsettled)).toEqual({
        ok: false,
        code: "task-not-releasable",
        reason: "actors-unsettled",
      });

      const open = structuredClone(frozen);
      open.outbox.push({
        id: "intent-repair-left",
        kind: "wake",
        recipient: reviewer.agentId,
        messageId: "99999999-9999-4999-8999-999999999999",
        idempotencyKey: "repair:left",
        payloadHash: "9".repeat(64),
        templateVersion: 1,
        state: "confirmed",
        recoverySendCount: 0,
        createdAt: frozen.updatedAt,
        confirmedAt: frozen.updatedAt,
        localCancellation: null,
        taskId: "t1",
        assignmentId: reviewer.assignmentId,
        semanticArgs: { purpose: "repair" },
      });
      expect(ask(open)).toEqual({
        ok: false,
        code: "task-not-releasable",
        reason: "effects-unsettled",
      });

      const started = structuredClone(frozen);
      const dependent = find(started, "t2");
      if (!dependent) throw new Error("no t2");
      dependent.state = "ready";
      expect(ask(started)).toEqual({
        ok: false,
        code: "task-not-releasable",
        reason: "dependent-active",
      });
      // Nothing was written by any of those.
      expect((await stored()).revision).toBe(frozen.revision);
    });

    test("a paused Run answers nothing: the decision offers no action and the answer is refused", async () => {
      const host = fakeHost();
      const b = build(host);
      const frozen = await reachD4(host, b);
      const decision = frozen.decisions.find((d) => d.category === "D4");
      await store.update(RUN_ID, (current) => {
        const paused = reduceRun(
          current,
          { kind: "run-paused" },
          { now: new Date().toISOString(), newId: () => "x" },
        );
        return paused.ok ? paused.next : null;
      });
      const paused = await stored();
      const view = projectDetail(paused);
      if (!view.ok) throw new Error("projection failed");
      expect(view.view.decisions.map((d) => d.actions)).toEqual([[]]);
      expect(view.view.capabilities.supportedControls).not.toContain("decide");
      const out = await b.control.decide(cancelAnswer(decision?.decisionId ?? "", paused.revision));
      expect(out).toMatchObject({
        status: "rejected",
        issues: [{ code: "run-not-active", params: { lifecycle: "paused" } }],
      });
      expect((await stored()).revision).toBe(paused.revision);
    });
  });

  describe("a producer whose turn ended with nothing the Engine can use", () => {
    const garbage = (host: Host, text = "All done, trust me.") => host.reply("agent-b1", text);

    async function started(host: Host, b: Built, protocolResends: number): Promise<void> {
      await store.update(RUN_ID, (current) => {
        current.policy.perTask.protocolResends = protocolResends;
        return current;
      });
      host.planRequestSent();
      host.reply(COORDINATOR_AGENT, plan());
      await hook(host, b.driver, COORDINATOR_AGENT);
      expect(states(await stored()).t1).toBe("assigned");
    }

    test("is asked for the report as often as the budget says, and then a person decides: retry closes the attempt and starts a fresh one", async () => {
      const host = fakeHost();
      const b = build(host);
      await started(host, b, 1);

      // The first unusable reply gets the one re-send; no decision yet, the budget is not spent.
      garbage(host);
      await hook(host, b.driver, "agent-b1");
      const asked = await stored();
      expect(asked.tasks[0]).toMatchObject({ state: "assigned", protocolFailures: 1 });
      expect(asked.decisions).toEqual([]);
      expect(host.sent.map((entry) => entry.agentId)).toEqual(["agent-b1", "agent-b1"]);

      // The reply to the re-send is no better: the budget is spent and the task has nobody to wait for.
      garbage(host, "Still done.");
      await hook(host, b.driver, "agent-b1");
      const stuck = await stored();
      expect(stuck.tasks[0]).toMatchObject({ state: "assigned", waitingReason: "report-missing" });
      expect(stuck.resources.every((claim) => !claim.frozen)).toBe(true);
      const decision = stuck.decisions.find((d) => d.state === "open");
      expect(decision).toMatchObject({ category: "D1", subjectId: "t1" });
      expect(decision?.dedupeKey).toMatch(/^stuck:/u);
      expect(host.sent).toHaveLength(2);
      // Seen again (the same hook delivered twice, a kick): nothing more is written.
      await hook(host, b.driver, "agent-b1");
      await b.driver.kick(RUN_ID);
      expect((await stored()).decisions).toHaveLength(1);
      expect((await stored()).revision).toBe(stuck.revision);
      const view = projectDetail(stuck);
      if (!view.ok) throw new Error("projection failed");
      expect(view.view.tasks[0]?.blockedBy).toEqual({
        kind: "decision",
        ref: decision?.decisionId,
      });
      expect(view.view.decisions.map((d) => d.actions)).toEqual([["retry", "cancel"]]);

      const oldAssignment = stuck.assignments[0];
      const out = await b.control.decide(answer(decision?.decisionId ?? "", stuck.revision));
      expect(out.status).toBe("applied");
      await b.control.idle();

      const after = await stored();
      // The old attempt is closed on the turn the host reported, its nonce revoked, its re-send gone.
      const closed = after.assignments.find((a) => a.assignmentId === oldAssignment?.assignmentId);
      expect(closed).toMatchObject({ state: "ended", acceptedProof: null });
      const nonce = after.nonceRegistry.find((entry) => entry.nonce === oldAssignment?.nonce);
      expect(nonce).toMatchObject({ acceptedAt: null, revokeReason: "abandoned-by-retry" });
      expect(after.outbox.filter((entry) => entry.kind === "wake")).toEqual([]);
      // A new attempt of the same task, the ordinary producer text, to the same seat.
      expect(after.tasks[0]).toMatchObject({ state: "assigned", attempts: 2, reworkCount: 1 });
      expect(host.sent).toHaveLength(3);
      expect(host.lastSent("agent-b1")?.text).not.toContain("【返工说明】");

      // And the replay of the answer does nothing.
      expect(
        (await b.control.decide(answer(decision?.decisionId ?? "", stuck.revision))).status,
      ).toBe("replayed");
      await b.control.idle();
      expect(host.sent).toHaveLength(3);

      produce(host, "agent-b1");
      await hook(host, b.driver, "agent-b1");
      judge(host, "agent-b2");
      await hook(host, b.driver, "agent-b2");
      expect(states(await stored()).t1).toBe("done");
    });

    test("a person who cancels instead: the attempt is closed on the turn that ended, its re-send and nonce go, and the task is cancelled", async () => {
      const host = fakeHost();
      const b = build(host);
      await started(host, b, 1);
      garbage(host);
      await hook(host, b.driver, "agent-b1");
      garbage(host, "Still done.");
      await hook(host, b.driver, "agent-b1");
      const stuck = await stored();
      const decision = stuck.decisions.find((d) => d.state === "open");
      expect(decision?.dedupeKey).toMatch(/^stuck:/u);
      const oldAssignment = stuck.assignments[0];
      const out = await b.control.decide(
        answer(decision?.decisionId ?? "", stuck.revision, { answer: { action: "cancel" } }),
      );
      expect(out).toMatchObject({ status: "applied", cancelledTaskIds: ["t1", "t2"] });
      await b.control.idle();
      const after = await stored();
      expect(states(after)).toEqual({ t1: "cancelled", t2: "cancelled" });
      expect(after.resources).toEqual([]);
      expect(after.outbox.filter((entry) => entry.kind === "wake")).toEqual([]);
      const nonce = after.nonceRegistry.find((entry) => entry.nonce === oldAssignment?.nonce);
      expect(nonce?.acceptedAt).toBeNull();
      expect(nonce?.revokedAt).not.toBeNull();
      expect(host.sent).toHaveLength(2);
    });

    test("a re-send that is committed and not yet sent is waited for: the same hook again opens no decision", async () => {
      const host = fakeHost();
      const b = build(host, { holdRepairs: true });
      await started(host, b, 1);
      garbage(host);
      await hook(host, b.driver, "agent-b1");
      const asked = await stored();
      const repairs = (record: RunRecord) =>
        record.outbox.filter(
          (entry) => entry.kind === "wake" && entry.semanticArgs.purpose === "repair",
        );
      expect(repairs(asked).map((entry) => entry.state)).toEqual(["prepared"]);
      expect(asked.decisions).toEqual([]);

      await hook(host, b.driver, "agent-b1");
      await hook(host, b.driver, "agent-b1");
      const again = await stored();
      expect(again.decisions).toEqual([]);
      expect(repairs(again)).toHaveLength(1);
      expect(host.sent).toHaveLength(1);
    });

    test("with no re-send to ask for, the first unusable reply is already the decision", async () => {
      const host = fakeHost();
      const b = build(host);
      await started(host, b, 0);
      garbage(host);
      await hook(host, b.driver, "agent-b1");
      const stuck = await stored();
      expect(stuck.decisions.filter((d) => d.state === "open")).toHaveLength(1);
      expect(host.sent).toHaveLength(1);
    });

    test("a turn that ended badly is not asked again either: it is the decision", async () => {
      const host = fakeHost();
      const b = build(host);
      await started(host, b, 2);
      garbage(host);
      await b.driver.onHook({
        name: "agent.turn_ended",
        agentId: "agent-b1",
        turnId: host.turnOf("agent-b1"),
        outcome: { kind: "failed" },
      });
      const stuck = await stored();
      expect(stuck.decisions.filter((d) => d.state === "open")).toHaveLength(1);
      expect(host.sent).toHaveLength(1);
      const decision = stuck.decisions[0];
      const out = await b.control.decide(answer(decision?.decisionId ?? "", stuck.revision));
      expect(out.status).toBe("applied");
      await b.control.idle();
      expect((await stored()).tasks[0]).toMatchObject({ state: "assigned", attempts: 2 });
    });

    test("is opened only for a producer's open attempt whose turn the host reported ended", async () => {
      const host = fakeHost();
      const b = build(host);
      await started(host, b, 0);
      garbage(host);
      await hook(host, b.driver, "agent-b1");
      const stuck = await stored();
      const assignment = stuck.assignments[0];
      const turnId = host.turnOf("agent-b1");
      const open = (record: RunRecord, over: Record<string, unknown> = {}) =>
        openLimboDecision(record, {
          taskId: "t1",
          assignmentId: assignment?.assignmentId ?? "",
          reason: "report-missing",
          turnId,
          decisionId: "33333333-3333-4333-8333-333333333333",
          controlNonceDigest: "c".repeat(64),
          now: "2026-11-08T00:00:00.000Z",
          ...over,
        });
      const clear = structuredClone(stuck);
      clear.decisions = [];
      expect(open(clear)).toMatchObject({ changed: true });
      // The same stop already has its decision, or the task has another one waiting.
      expect(open(stuck)).toEqual({ changed: false });
      // A turn the host did not report ended, or one that is not the attempt's agent's.
      expect(open(clear, { turnId: "turn-other" })).toEqual({ changed: false });
      const noReceipt = structuredClone(clear);
      noReceipt.eventReceipts = noReceipt.eventReceipts.filter((r) => r.kind !== "turn_ended");
      expect(open(noReceipt)).toEqual({ changed: false });
      // Not a producer, already answered with a report, or the task is no longer waiting on it.
      const judge = structuredClone(clear);
      (judge.assignments[0] as { purpose: string }).purpose = "reviewer";
      expect(open(judge)).toEqual({ changed: false });
      const reported = structuredClone(clear);
      (reported.assignments[0] as { acceptedProof: unknown }).acceptedProof = { status: "done" };
      expect(open(reported)).toEqual({ changed: false });
      const moved = structuredClone(clear);
      (moved.tasks[0] as { state: string }).state = "review";
      expect(open(moved)).toEqual({ changed: false });
      expect(open(clear, { assignmentId: "assignment-nope" })).toEqual({ changed: false });
    });

    test("is not released while the turn it names is not on record as ended", async () => {
      const host = fakeHost();
      const b = build(host);
      await started(host, b, 0);
      garbage(host);
      await hook(host, b.driver, "agent-b1");
      const stuck = await stored();
      const decision = stuck.decisions.find((d) => d.state === "open");
      // The receipt the decision points at is gone from the ledger (it never reached this copy).
      const broken = structuredClone(stuck);
      broken.eventReceipts = broken.eventReceipts.filter(
        (receipt) => receipt.kind !== "turn_ended" || receipt.agentId !== "agent-b1",
      );
      const result = answerDecision(broken, {
        decisionId: decision?.decisionId ?? "",
        requestId: "ans-1",
        expectedRevision: broken.revision,
        reason: "again",
        action: "retry",
        now: "2026-11-08T00:00:00.000Z",
      });
      expect(result).toEqual({ ok: false, code: "task-not-releasable", reason: "turn-not-ended" });
    });
  });
});

// === kick ======================================================================================

describe("cancel the Run", () => {
  const ask = (revision: number, over: Record<string, unknown> = {}) => ({
    runContractVersion: 1 as const,
    runId: RUN_ID,
    requestId: "cancel-1",
    expectedRevision: revision,
    reason: "stop everything",
    ...over,
  });
  const pending = (record: RunRecord) =>
    (record as unknown as { cancelRequest?: unknown }).cancelRequest;
  const alertOf = (record: RunRecord) =>
    record.alerts.find((alert) => alert.summary === CANCEL_PENDING_ALERT);
  const count = (record: RunRecord, kind: string) =>
    record.events.filter((event) => event.kind === kind).length;

  /** The plan is accepted and t1 is with its producer, whose turn is running. */
  async function underway(host: Host, b: Built): Promise<RunRecord> {
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, b.driver, COORDINATOR_AGENT);
    const record = await stored();
    expect(states(record).t1).toBe("assigned");
    return record;
  }

  test.each(["v1", "v2"] as const)(
    "[%s] a running turn is waited for, its report is taken in, and then the whole Run is cancelled without a single message",
    async (version) => {
      const host = fakeHost();
      const b = build(host);
      const before = await underway(host, b);
      const sentBefore = host.sent.length;

      const out = await b.control.cancel(ask(before.revision));
      expect(out).toMatchObject({
        status: "applied",
        lifecycle: "paused",
        waiting: { turns: 1, deliveries: 0 },
        issues: [],
      });
      await b.control.idle();
      const mid = await stored();
      expect(mid.lifecycle).toBe("paused");
      expect(pending(mid)).toMatchObject({ requestId: "cancel-1", completedAt: null });
      expect(alertOf(mid)?.state).toBe("open");
      expect(count(mid, CANCEL_REQUEST_EVENT)).toBe(1);
      expect(states(mid).t1).toBe("assigned");
      expect(mid.resources.length).toBeGreaterThan(0);
      // Looking again while the turn runs writes nothing.
      await b.driver.kick(RUN_ID);
      expect((await stored()).revision).toBe(mid.revision);

      produce(host, "agent-b1");
      await hook(host, b.driver, "agent-b1");
      const after = await stored();
      expect(after.schemaVersion).toBe(version === "v1" ? 1 : 2);
      expect(after.lifecycle).toBe("cancelled");
      expect(states(after)).toEqual({ t1: "cancelled", t2: "cancelled" });
      expect(after.resources).toEqual([]);
      // The report that arrived was taken in as usual, and no judge was asked.
      expect(
        after.assignments.filter((a) => a.taskId === "t1" && a.acceptedProof !== null),
      ).toHaveLength(1);
      expect(after.assignments.some((a) => a.purpose === "reviewer")).toBe(false);
      expect(pending(after)).toMatchObject({ requestId: "cancel-1" });
      expect((pending(after) as { completedAt: string | null }).completedAt).not.toBeNull();
      expect(alertOf(after)?.state).toBe("resolved");
      expect(count(after, CANCEL_COMPLETED_EVENT)).toBe(1);
      expect(count(after, "run-cancelled")).toBe(1);
      // The claim kept from the delivery that was sent was released on the request's behalf.
      const release = after.decisions.find((d) => d.dedupeKey === "cancel:t1");
      expect(release).toMatchObject({
        state: "answered",
        answer: { action: "cancel", requestId: "cancel-1", via: "run-cancel" },
      });
      expect(after.tasks.find((t) => t.spec.id === "t1")?.releaseDecisionId).toBe(
        release?.decisionId,
      );
      // The key assertion: from the request to the end, nothing was sent, archived or interrupted.
      expect(host.sent).toHaveLength(sentBefore);
      expect(host.archived).toEqual([]);
    },
  );

  test("a producer whose report is refused: the re-send held by the pause never goes out, and the attempt is closed", async () => {
    const host = fakeHost();
    const b = build(host);
    await store.update(RUN_ID, (current) => {
      current.policy.perTask.protocolResends = 1;
      return current;
    });
    const before = await underway(host, b);
    await b.control.cancel(ask(before.revision));
    const sentBefore = host.sent.length;
    host.reply("agent-b1", "All done, trust me.");
    await hook(host, b.driver, "agent-b1");
    const after = await stored();
    expect(after.lifecycle).toBe("cancelled");
    expect(states(after)).toEqual({ t1: "cancelled", t2: "cancelled" });
    expect(after.outbox.filter((i) => i.state === "prepared" || i.state === "sending")).toEqual([]);
    const nonce = after.nonceRegistry.find((n) => n.taskId === "t1");
    expect(nonce?.acceptedAt).toBeNull();
    expect(nonce?.revokedAt).not.toBeNull();
    expect(host.sent).toHaveLength(sentBefore);
    expect(host.archived).toEqual([]);
  });

  test("a delivery whose result is not known keeps the cancellation waiting until its echo settles it", async () => {
    const host = fakeHost();
    const b = build(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    host.loseNextSend();
    await hook(host, b.driver, COORDINATOR_AGENT);
    const lost = await stored();
    expect(lost.outbox.some((i) => i.kind === "dispatch" && i.state === "outcome-unknown")).toBe(
      true,
    );
    const out = await b.control.cancel(ask(lost.revision));
    expect(out).toMatchObject({ status: "applied", waiting: { deliveries: 1 } });
    await b.control.idle();
    await b.driver.kick(RUN_ID);
    expect((await stored()).lifecycle).toBe("paused");
    const sentBefore = host.sent.length;

    // The echo arrives: the message was delivered, and its turn is running.
    host.deliverLost("agent-b1");
    await b.driver.retryRun(RUN_ID);
    expect((await stored()).lifecycle).toBe("paused");

    produce(host, "agent-b1");
    await hook(host, b.driver, "agent-b1");
    const after = await stored();
    expect(after.lifecycle).toBe("cancelled");
    expect(states(after)).toEqual({ t1: "cancelled", t2: "cancelled" });
    expect(host.sent).toHaveLength(sentBefore);
    expect(host.archived).toEqual([]);
  });

  test("a turn the ledger says ended but the host says is running, or cannot be read, is waited for without a write", async () => {
    const host = fakeHost();
    const b = build(host);
    const before = await underway(host, b);
    await b.control.cancel(ask(before.revision));
    // A reply the Engine cannot use: the turn ended, but the attempt is still open.
    host.reply("agent-b1", "All done, trust me.");
    host.liveState("running");
    await hook(host, b.driver, "agent-b1");
    const waiting = await stored();
    expect(waiting.lifecycle).toBe("paused");
    host.liveState("throw");
    await b.driver.kick(RUN_ID);
    expect((await stored()).revision).toBe(waiting.revision);
    expect((await stored()).lifecycle).toBe("paused");
    host.liveState(null);
    await b.driver.kick(RUN_ID);
    expect((await stored()).lifecycle).toBe("cancelled");
  });

  test("a Run with no task yet is cancelled in the request's own commit, and a plan that comes later is not taken", async () => {
    const host = fakeHost();
    const b = build(host);
    const before = await stored();
    expect(before.lifecycle).toBe("bootstrapping");
    const out = await b.control.cancel(ask(before.revision));
    expect(out).toMatchObject({ status: "applied", lifecycle: "cancelled", waiting: null });
    await b.control.idle();
    const done = await stored();
    expect((pending(done) as { completedAt: string | null }).completedAt).not.toBeNull();
    expect(alertOf(done)?.state).toBe("resolved");
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, b.driver, COORDINATOR_AGENT);
    const after = await stored();
    expect(after.lifecycle).toBe("cancelled");
    expect(after.tasks).toEqual([]);
    expect(host.sent).toEqual([]);
  });

  test("the same request is the same request; another one is refused while it waits; stale, finished and starting Runs are refused", async () => {
    const host = fakeHost();
    const b = build(host);
    const stale = await stored();
    const conflict = await b.control.cancel(ask(stale.revision + 5));
    expect(conflict).toMatchObject({
      status: "rejected",
      issues: [{ code: "revision-conflict", params: { current: stale.revision } }],
    });
    await store.update(RUN_ID, (current) => {
      current.launch.state = "creating";
      return current;
    });
    const starting = await stored();
    expect(await b.control.cancel(ask(starting.revision))).toMatchObject({
      status: "rejected",
      issues: [{ code: "launch-in-progress" }],
    });
    await store.update(RUN_ID, (current) => {
      current.launch.state = "running";
      return current;
    });

    const before = await underway(host, b);
    const first = await b.control.cancel(ask(before.revision));
    expect(first.status).toBe("applied");
    await b.control.idle();
    const waiting = await stored();
    // A repeat is found before anything else, even with a revision that is long gone.
    expect(await b.control.cancel(ask(1))).toMatchObject({
      status: "replayed",
      lifecycle: "paused",
    });
    expect(await b.control.cancel(ask(1, { reason: "another reason" }))).toMatchObject({
      status: "rejected",
      issues: [{ code: "request-id-reused" }],
    });
    expect(await b.control.cancel(ask(waiting.revision, { requestId: "cancel-2" }))).toMatchObject({
      status: "rejected",
      issues: [{ code: "cancel-pending" }],
    });
    expect((await stored()).revision).toBe(waiting.revision);

    // Once it is done, another request finds a Run that cannot be cancelled again.
    produce(host, "agent-b1");
    await hook(host, b.driver, "agent-b1");
    const done = await stored();
    expect(done.lifecycle).toBe("cancelled");
    expect(await b.control.cancel(ask(done.revision, { requestId: "cancel-3" }))).toMatchObject({
      status: "rejected",
      issues: [{ code: "lifecycle-not-allowed", params: { lifecycle: "cancelled" } }],
    });
  });

  test("while it waits nobody resumes the Run or answers a decision, and the page is told only kick is left", async () => {
    const host = fakeHost();
    const b = build(host);
    const before = await underway(host, b);
    await b.control.cancel(ask(before.revision));
    await b.control.idle();
    const waiting = await stored();
    const view = projectDetail(waiting);
    if (!view.ok) throw new Error("projection failed");
    expect(view.view.capabilities.supportedControls).toEqual(["kick"]);
    const body = { runContractVersion: 1 as const, runId: RUN_ID, requestId: "p-1", reason: "x" };
    for (const act of [b.control.resume, b.control.pause]) {
      expect(await act({ ...body, expectedRevision: waiting.revision })).toMatchObject({
        status: "rejected",
        issues: [{ code: "cancel-pending" }],
      });
    }
    expect((await stored()).revision).toBe(waiting.revision);
  });

  test("a request that was written and not finished is finished by the recovery of a new process, once", async () => {
    const host = fakeHost();
    const first = build(host);
    const before = await underway(host, first);
    await first.control.cancel(ask(before.revision));
    // A reply the Engine cannot use: the turn ended, but the attempt is still open.
    host.reply("agent-b1", "All done, trust me.");
    host.liveState("running");
    await hook(host, first.driver, "agent-b1");
    expect((await stored()).lifecycle).toBe("paused");
    host.liveState(null);

    // A new process: nothing of the first one is carried over.
    const second = build(host);
    await second.driver.recover();
    const after = await stored();
    expect(after.lifecycle).toBe("cancelled");
    expect(count(after, "run-cancelled")).toBe(1);
    expect(count(after, CANCEL_COMPLETED_EVENT)).toBe(1);
    await second.driver.recover();
    await first.driver.kick(RUN_ID);
    expect(count(await stored(), "run-cancelled")).toBe(1);
  });

  test("two finishers at once commit one cancellation", async () => {
    const host = fakeHost();
    const b = build(host);
    const before = await underway(host, b);
    await b.control.cancel(ask(before.revision));
    // A reply the Engine cannot use: the turn ended, but the attempt is still open.
    host.reply("agent-b1", "All done, trust me.");
    host.liveState("running");
    await hook(host, b.driver, "agent-b1");
    host.liveState(null);
    const readSeat = async (agentId: string) => {
      const refreshed = await host.port.agents.ref(agentId).refresh();
      return refreshed?.agent
        ? { status: refreshed.agent.status, activeTurn: refreshed.agent.activeTurn != null }
        : null;
    };
    const finishers = [1, 2, 3].map(() => createCancelFinisher({ store, readSeat }));
    const reports = await Promise.all(finishers.map((finisher) => finisher.finish(RUN_ID)));
    expect(reports.filter((report) => report.status === "finished")).toHaveLength(1);
    const after = await stored();
    expect(count(after, "run-cancelled")).toBe(1);
    expect(count(after, CANCEL_COMPLETED_EVENT)).toBe(1);
  });

  test("a turn that started after the plan was made stops the commit: the plan is worked out again on the record that is committed", async () => {
    const host = fakeHost();
    const b = build(host);
    const before = await underway(host, b);
    await b.control.cancel(ask(before.revision));
    host.reply("agent-b1", "All done, trust me.");
    host.liveState("running");
    await hook(host, b.driver, "agent-b1");
    host.liveState(null);
    expect((await stored()).lifecycle).toBe("paused");

    // Between the finisher reading the Run and committing, the agent starts a turn (a message of its own).
    let injected = false;
    const watched = new Proxy(store, {
      get(target, prop) {
        if (prop !== "update") return Reflect.get(target, prop);
        return async (runId: string, change: Parameters<RunStore["update"]>[1]) => {
          if (!injected) {
            injected = true;
            await target.update(runId, (current) => {
              const seq = current.counters.observationSeq + 1;
              current.counters.observationSeq = seq;
              current.eventReceipts.push({
                eventKey: "agent-b1|turn-new|turn_started",
                kind: "turn_started",
                agentId: "agent-b1",
                turnId: "turn-new",
                seq,
                receivedAt: new Date().toISOString(),
                dedupeKey: "agent-b1|turn-new|turn_started",
                disposition: "observed",
              });
              return current;
            });
          }
          return target.update(runId, change);
        };
      },
    });
    const finisher = createCancelFinisher({
      store: watched,
      readSeat: async () => ({ status: "idle", activeTurn: false }),
    });
    const report = await finisher.finish(RUN_ID);
    expect(report.status).toBe("waiting");
    expect((await stored()).lifecycle).toBe("paused");
    expect(count(await stored(), "run-cancelled")).toBe(0);
  });

  test("what the request returns carries counts, ids and codes only", async () => {
    const host = fakeHost();
    const b = build(host);
    const before = await underway(host, b);
    const out = await b.control.cancel(ask(before.revision));
    expect(Object.keys(out).sort()).toEqual([
      "issues",
      "lifecycle",
      "revision",
      "runContractVersion",
      "status",
      "waiting",
    ]);
    const text = JSON.stringify(out);
    for (const secret of ["nonce", "prompt", "semanticArgs", "outbox"]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("add turns to a seat", () => {
  const ask = (revision: number, over: Record<string, unknown> = {}) => ({
    runContractVersion: 1 as const,
    runId: RUN_ID,
    requestId: "bud-1",
    expectedRevision: revision,
    reason: "from the page",
    seatId: "seat-b1",
    by: 2,
    ...over,
  });
  const exhaustion = (record: RunRecord) =>
    record.alerts.filter((alert) =>
      alert.summary.startsWith(budgetExhaustedAlertPrefix("seat-b1")),
    );

  /** seat-b1 may take two turns; t1 takes the first and the second, then t2 has none left. */
  async function runOut(host: Host, b: Built): Promise<RunRecord> {
    await store.update(RUN_ID, (current) => {
      const entry = current.budgets.entries.find((e) => e.subjectId === "seat-b1");
      if (entry) entry.limit = 2;
      return current;
    });
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, b.driver, COORDINATOR_AGENT);
    produce(host, "agent-b1");
    await hook(host, b.driver, "agent-b1");
    judge(host, "agent-b2");
    await hook(host, b.driver, "agent-b2");
    return stored();
  }

  test.each(["v1", "v2"] as const)(
    "[%s] a task held back for want of turns is said so once, and goes out once after the seat is given more",
    async (version) => {
      const host = fakeHost();
      const b = build(host);
      const held = await runOut(host, b);
      expect(held.schemaVersion).toBe(version === "v1" ? 1 : 2);
      expect(states(held)).toEqual({ t1: "done", t2: "ready" });
      expect(held.tasks.find((t) => t.spec.id === "t2")?.waitingReason).toBe(
        "dispatch-blocked:budget-exhausted",
      );
      // Said once, with the way out, however often the Run is looked at.
      await b.driver.kick(RUN_ID);
      await b.driver.kick(RUN_ID);
      const said = exhaustion(await stored());
      expect(said).toHaveLength(1);
      expect(said[0]).toMatchObject({ state: "open", severity: "warning" });
      expect(said[0]?.summary).toContain("在 Runs 页追加预算");
      const sentBefore = host.sent.length;
      const policyBefore = JSON.stringify((await stored()).policy);

      const out = await b.control.budget(ask((await stored()).revision));
      expect(out).toMatchObject({ status: "applied", seatId: "seat-b1", limit: 4, issues: [] });
      await b.control.idle();
      const after = await stored();
      // What was held back went out, once; the alert is resolved; the policy is as it was.
      expect(states(after)).toEqual({ t1: "done", t2: "assigned" });
      expect(host.sent).toHaveLength(sentBefore + 1);
      expect(host.lastSent("agent-b1")?.text).toContain("t2");
      expect(exhaustion(after)[0]?.state).toBe("resolved");
      expect(JSON.stringify(after.policy)).toBe(policyBefore);
      expect(after.budgets.entries.find((e) => e.subjectId === "seat-b1")?.limit).toBe(4);

      // The same answer again, or a kick, changes and sends nothing.
      const replay = await b.control.budget(ask(1));
      expect(replay).toMatchObject({ status: "replayed", limit: 4 });
      await b.control.idle();
      await b.driver.kick(RUN_ID);
      expect(host.sent).toHaveLength(sentBefore + 1);
      expect((await stored()).revision).toBe(after.revision);
      expect(await b.control.budget(ask(1, { by: 3 }))).toMatchObject({
        status: "rejected",
        issues: [{ code: "request-id-reused" }],
      });
    },
  );

  test("the refusals: stale revision, unknown seat, no budget, over the ceiling, a Run being cancelled", async () => {
    const host = fakeHost();
    const b = build(host);
    const held = await runOut(host, b);
    expect(await b.control.budget(ask(held.revision + 3))).toMatchObject({
      status: "rejected",
      issues: [{ code: "revision-conflict", params: { current: held.revision } }],
    });
    expect(await b.control.budget(ask(held.revision, { seatId: "seat-zz" }))).toMatchObject({
      issues: [{ code: "seat-missing" }],
    });
    // A seat of the roster with no budget in the entries or the policy. The coordinator is none: its
    // entry is built when a person asks for turns for it (the coordinator's budget group below).
    await store.update(RUN_ID, (current) => {
      current.roster.push({
        seatId: "seat-zz-nobudget",
        tier: "B",
        agentId: null,
        channelId: "claude",
        duties: ["implement"],
        enabled: true,
      });
      return current;
    });
    const bare = await stored();
    expect(
      await b.control.budget(ask(bare.revision, { seatId: "seat-zz-nobudget" })),
    ).toMatchObject({ issues: [{ code: "budget-missing" }] });
    await store.update(RUN_ID, (current) => {
      current.roster = current.roster.filter((seat) => seat.seatId !== "seat-zz-nobudget");
      return current;
    });
    await store.update(RUN_ID, (current) => {
      const entry = current.budgets.entries.find((e) => e.subjectId === "seat-b1");
      if (entry) entry.limit = 1020;
      return current;
    });
    const raised = await stored();
    expect(await b.control.budget(ask(raised.revision, { by: 10 }))).toMatchObject({
      issues: [{ code: "budget-cap", params: { max: 1024 } }],
    });
    expect((await stored()).revision).toBe(raised.revision);

    await b.control.cancel({
      runContractVersion: 1,
      runId: RUN_ID,
      requestId: "c-1",
      expectedRevision: raised.revision,
      reason: "stop",
    });
    const cancelling = await stored();
    expect(await b.control.budget(ask(cancelling.revision, { requestId: "bud-2" }))).toMatchObject({
      issues: [{ code: "lifecycle-not-allowed" }],
    });
  });

  test("what the answer carries is counts, ids and codes", async () => {
    const host = fakeHost();
    const b = build(host);
    const held = await runOut(host, b);
    const out = await b.control.budget(ask(held.revision));
    expect(Object.keys(out).sort()).toEqual([
      "issues",
      "limit",
      "revision",
      "runContractVersion",
      "seatId",
      "status",
    ]);
    const text = JSON.stringify(out);
    for (const secret of ["nonce", "prompt", "semanticArgs", "outbox"]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("the coordinator's turn budget", () => {
  const coordinatorEntry = (record: RunRecord) =>
    record.budgets.entries.find((e) => e.scope === "seat" && e.subjectId === "coordinator");
  const exhaustion = (record: RunRecord) =>
    record.alerts.filter((alert) =>
      alert.summary.startsWith(budgetExhaustedAlertPrefix("coordinator")),
    );

  /** The plan was refused for what it says; the coordinator may take one turn, and the plan request took it. */
  async function oneTurnUsed(host: Host, b: Built): Promise<RunRecord> {
    await store.update(RUN_ID, (current) => {
      current.policy.run.strategicTurns = 1;
      return current;
    });
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, wrongPlan());
    await hook(host, b.driver, COORDINATOR_AGENT);
    const waiting = await stored();
    expect(waiting.lifecycle).toBe("awaiting-dag");
    return waiting;
  }

  test.each(["v1", "v2"] as const)(
    "[%s] a re-plan with no turns left is refused with one warning and nothing sent; turns added from the page take the warning down and the re-plan goes out once",
    async (version) => {
      const host = fakeHost();
      const b = build(host);
      const waiting = await oneTurnUsed(host, b);
      const policyBefore = JSON.stringify(waiting.policy);
      expect(waiting.schemaVersion).toBe(version === "v1" ? 1 : 2);

      const out = await b.control.replan(request(waiting.revision));
      expect(out).toMatchObject({
        status: "rejected",
        epoch: null,
        issues: [{ code: "budget-exhausted" }],
      });
      await b.control.idle();
      const refused = await stored();
      // Nothing moved: no message, no new plan request, the same wait.
      expect(host.sent).toHaveLength(0);
      expect(refused.lifecycle).toBe("awaiting-dag");
      expect(refused.outbox.filter((i) => i.kind === "wake")).toHaveLength(1);
      expect(readDagControl(refused)).toEqual(readDagControl(waiting));
      // The entry was built from the one plan request the Run holds, and the warning is said once.
      expect(coordinatorEntry(refused)).toMatchObject({ limit: 1, reserved: 1 });
      const said = exhaustion(refused);
      expect(said).toHaveLength(1);
      expect(said[0]).toMatchObject({ state: "open", severity: "warning" });
      expect(said[0]?.summary).toContain("在 Runs 页追加预算");

      // Asking again changes nothing and says nothing more.
      const again = await b.control.replan(request(refused.revision, { requestId: "req-2" }));
      expect(again).toMatchObject({ status: "rejected", issues: [{ code: "budget-exhausted" }] });
      expect((await stored()).revision).toBe(refused.revision);

      // The way out: turns for the coordinator, from the page's budget control.
      const added = await b.control.budget({
        runContractVersion: 1 as const,
        runId: RUN_ID,
        requestId: "bud-1",
        expectedRevision: refused.revision,
        reason: "from the page",
        seatId: "coordinator",
        by: 2,
      });
      expect(added).toMatchObject({ status: "applied", seatId: "coordinator", limit: 3 });
      await b.control.idle();
      const raised = await stored();
      expect(coordinatorEntry(raised)).toMatchObject({ limit: 3, reserved: 1 });
      expect(exhaustion(raised).map((a) => a.state)).toEqual(["resolved"]);
      // The frozen policy is the Run's start: the limit lives in the entry.
      expect(JSON.stringify(raised.policy)).toBe(policyBefore);
      expect(host.sent).toHaveLength(0);

      const go = await b.control.replan(request(raised.revision, { requestId: "req-3" }));
      expect(go).toMatchObject({ status: "applied", epoch: 2, issues: [] });
      await b.control.idle();
      const replanned = await stored();
      expect(coordinatorEntry(replanned)).toMatchObject({ limit: 3, reserved: 2 });
      expect(host.sent.map((entry) => entry.agentId)).toEqual([COORDINATOR_AGENT]);

      // The same request again is the same request: nothing more is counted or sent.
      const replay = await b.control.replan(request(replanned.revision, { requestId: "req-3" }));
      expect(replay).toMatchObject({ status: "replayed", epoch: 2 });
      await b.control.idle();
      expect(coordinatorEntry(await stored())?.reserved).toBe(2);
      expect(host.sent).toHaveLength(1);
    },
  );

  test("turns added to a coordinator that never asked for a re-plan build its row first, from the plan request the Run already used", async () => {
    const host = fakeHost();
    const b = build(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, wrongPlan());
    await hook(host, b.driver, COORDINATOR_AGENT);
    const waiting = await stored();
    expect(coordinatorEntry(waiting)).toBeUndefined();

    const added = await b.control.budget({
      runContractVersion: 1 as const,
      runId: RUN_ID,
      requestId: "bud-1",
      expectedRevision: waiting.revision,
      reason: "from the page",
      seatId: "coordinator",
      by: 2,
    });
    // The policy's 12 turns, two more, and the one the plan request took.
    expect(added).toMatchObject({ status: "applied", seatId: "coordinator", limit: 14 });
    await b.control.idle();
    const after = await stored();
    expect(coordinatorEntry(after)).toMatchObject({ limit: 14, reserved: 1 });
    expect(JSON.stringify(after.policy)).toBe(JSON.stringify(waiting.policy));
    expect(host.sent).toHaveLength(0);
  });

  test("the page's budget answer for the coordinator names the coordinator's row, and an unknown seat is still refused", async () => {
    const host = fakeHost();
    const b = build(host);
    const waiting = await oneTurnUsed(host, b);
    expect(
      await b.control.budget({
        runContractVersion: 1 as const,
        runId: RUN_ID,
        requestId: "bud-9",
        expectedRevision: waiting.revision,
        reason: "x",
        seatId: "seat-zz",
        by: 1,
      }),
    ).toMatchObject({ issues: [{ code: "seat-missing" }] });
    // Looking at a refusal wrote nothing, and did not give the coordinator a row it was not asked for.
    expect((await stored()).revision).toBe(waiting.revision);
    expect(coordinatorEntry(await stored())).toBeUndefined();
  });
});

describe("kick", () => {
  const kick = (b: Built) => b.control.kick({ runContractVersion: 1, runId: RUN_ID });

  test("a change no hook announces is found: the cleaned tree is dispatched, once, however many ask", async () => {
    const host = fakeHost();
    const b = build(host);
    await writeFile(path.join(repoDir, "stray.txt"), "left behind");
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, b.driver, COORDINATOR_AGENT);

    const stuck = await kick(b);
    expect(stuck).toMatchObject({
      status: "ok",
      outcome: "blocked",
      dispatched: 0,
      reason: "dispatch-blocked:workspace-dirty",
    });
    expect(host.sent).toHaveLength(0);

    await rm(path.join(repoDir, "stray.txt"));
    // Two people, one tree: the second joins the first, and one message goes out.
    const [first, second] = await Promise.all([kick(b), kick(b)]);
    expect(first.outcome).toBe("dispatched");
    expect(second.outcome).toBe("dispatched");
    expect(host.sent).toHaveLength(1);
    expect(await kick(b)).toMatchObject({ outcome: "idle", dispatched: 0 });
    expect(host.sent).toHaveLength(1);
  });

  test("a Run that is not live is not moved, and a Run that is not there is said so", async () => {
    const host = fakeHost();
    const b = build(host);
    expect(await kick(b)).toMatchObject({ status: "ok", outcome: "not-active", dispatched: 0 });
    const missing = await b.control.kick({ runContractVersion: 1, runId: "run-nope00-a1" });
    expect(missing).toMatchObject({
      status: "rejected",
      outcome: null,
      issues: [{ code: "run-missing" }],
    });
    expect(host.sent).toHaveLength(0);
  });

  test("a report whose hook was lost is picked up by a kick, for this Run only", async () => {
    const host = fakeHost();
    const b = build(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    // No hook: nothing listened. The person presses retry.
    const out = await kick(b);
    expect(out).toMatchObject({ status: "ok", outcome: "dispatched", dispatched: 1 });
    expect(states(await stored())).toEqual({ t1: "assigned", t2: "pending" });
  });

  test("two kicks at once cost one pass: the second joins the first instead of reading the host again", async () => {
    const host = fakeHost();
    const b = build(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, b.driver, COORDINATOR_AGENT);
    // t1 is out and its member is still working: a kick finds nothing to do and costs some reads.
    const start = host.reads();
    expect(await kick(b)).toMatchObject({ outcome: "idle", dispatched: 0 });
    const single = host.reads() - start;
    expect(single).toBeGreaterThan(0);
    const before = host.reads();
    await Promise.all([kick(b), kick(b), kick(b)]);
    expect(host.reads() - before).toBe(single);
    expect(host.sent).toHaveLength(1);
  });

  test("the push after a write asks for a retry of its own; a person's kick only joins the running one", async () => {
    const host = fakeHost();
    const b = build(host, { noPush: true });
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, wrongPlan());
    await hook(host, b.driver, COORDINATOR_AGENT);
    const waiting = await stored();
    const asked: unknown[] = [];
    const control = createRunControl({
      store,
      ensureReady: async () => undefined,
      driver: {
        retryRun: async (_runId, options) => {
          asked.push(options ?? null);
          return { status: "ok", dispatched: 0, finished: false, last: "idle", reason: null };
        },
      },
    });
    expect(await control.replan(request(waiting.revision))).toMatchObject({ status: "applied" });
    await control.idle();
    await control.kick({ runContractVersion: 1, runId: RUN_ID });
    // Only the person's button asks for the one more try at reopening a closed seat.
    expect(asked).toEqual([{ afterWrite: true }, { byPerson: true }]);
  });

  test("the host is read for this Run's agents only", async () => {
    const host = fakeHost();
    const b = build(host);
    const other = bootstrapRun({ runId: "run-ctl002-a1", planRequest: true });
    other.policy.evidenceRoot = evidenceRoot;
    await store.create(other);
    const observer = createRunObserver({ store });
    const reader = createObserverHost(host.port, { requireIdle: true });
    expect((await observer.reconcile(reader)).runsScanned).toBe(2);
    expect((await observer.reconcile(reader, { runId: RUN_ID })).runsScanned).toBe(1);
    expect(await kick(b)).toMatchObject({ status: "ok" });
  });

  test("a Run whose launch failed is sent nothing by a recovery or a kick, whatever was left prepared", async () => {
    const host = fakeHost();
    const b = build(host);
    await store.update(RUN_ID, (current) => {
      current.launch.state = "failed";
      const wake = current.outbox.find((entry) => entry.kind === "wake");
      if (!wake) return null;
      wake.state = "prepared";
      wake.confirmedAt = null;
      // A request the executor would send: its hash is that of the text rebuilt from the ledger.
      const text = wake.kind === "wake" ? compileEngineIntent(wake, current) : null;
      if (text !== null) wake.payloadHash = payloadHash(text);
      return current;
    });
    await b.driver.recover();
    expect(await kick(b)).toMatchObject({ status: "ok" });
    expect(host.sent).toHaveLength(0);
    expect((await stored()).outbox.find((entry) => entry.kind === "wake")?.state).toBe("prepared");
    // The same leftover in a Run whose launch is running is the crash window the recovery closes.
    await store.update(RUN_ID, (current) => {
      current.launch.state = "running";
      return current;
    });
    await b.driver.recover();
    expect(host.sent).toHaveLength(1);
    await b.driver.recover();
    expect(host.sent).toHaveLength(1);
  });

  test("nothing the controls return holds a nonce, a prompt or an outbox argument", async () => {
    const host = fakeHost();
    const b = build(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, wrongPlan());
    await hook(host, b.driver, COORDINATOR_AGENT);
    const waiting = await stored();
    const replan = await b.control.replan(request(waiting.revision));
    await b.control.idle();
    const text = host.lastSent(COORDINATOR_AGENT)?.text ?? "";
    const kicked = await kick(b);
    const decided = await b.control.decide({
      runContractVersion: 1,
      runId: RUN_ID,
      decisionId: "22222222-2222-4222-8222-222222222222",
      requestId: "x",
      expectedRevision: 1,
      reason: "x",
      answer: { action: "retry" },
    });
    const view = projectDetail(await stored());
    if (!view.ok) throw new Error("projection failed");
    const everything = JSON.stringify([replan, kicked, decided, view.view]);
    for (const secret of [
      DAG_NONCE,
      newNonce(text),
      "semanticArgs",
      "controlNonce",
      "payloadHash",
      "【控制身份",
    ]) {
      expect(everything).not.toContain(secret);
    }
  });
});

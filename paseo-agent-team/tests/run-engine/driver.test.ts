import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDagIntake } from "../../server/run-engine/dag";
import { createEngineDriver, type DriverOptions } from "../../server/run-engine/driver";
import { createEffects } from "../../server/run-engine/effects";
import { createObserverHost } from "../../server/run-engine/host";
import { createIntake } from "../../server/run-engine/intake";
import { createRunObserver } from "../../server/run-engine/observer";
import { createEngineService } from "../../server/run-engine/service";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import { REPO_ALIAS } from "../../shared/domain/run-engine/dag-admission";
import { compileEngineIntent } from "../../shared/domain/run-engine/engine-prompts";
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
import { JUDGE_SEAT_REVIEW } from "./support/review-run";

/**
 * The whole Engine loop without a launch: a coordinator's plan, producers that really commit in a
 * real git repository, reviewers, and the hooks that tell the Engine a turn ended. Failure modes:
 *  - a task starting before its dependency passed every gate (the review included);
 *  - a report that arrived while nothing listened never being picked up;
 *  - a Run that cannot dispatch saying nothing about why, or dispatching while paused;
 *  - a burst of hooks costing one pass each, or a failing hook breaking the host's hook handler.
 */

const RUN_ID = "run-drv001-a1";

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

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), "run-driver-")));
  repoDir = path.join(home, "repo");
  await mkdir(path.join(repoDir, "src"), { recursive: true });
  git(repoDir, "init", "-q", "-b", "main");
  await writeFile(path.join(repoDir, "src", "t1.ts"), "export {};\n");
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "-q", "-m", "base");
  evidenceRoot = path.join(home, "evidence").replaceAll("\\", "/");
  await mkdir(path.join(home, "paseo"));
  store = createRunStore({ home: path.join(home, "paseo"), lock: { acquireTimeoutMs: 300 } });
  await store.initialize();
  const record = bootstrapRun({ runId: RUN_ID, planRequest: true });
  record.policy.evidenceRoot = evidenceRoot;
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
          add(agentId, `turn-${agentId}-${sent.length}`, { type: "user_message", messageId });
        },
        archive: async () => undefined,
        timeline: { refetch: async () => page(agentId) },
        current: () => ({ status: "idle", activeTurn: null }),
        refresh: async () => ({ agent: { status: "idle", activeTurn: null } }),
      }),
    },
  };
  return {
    port,
    sent,
    /** The coordinator was sent the plan request earlier: its message is already in the timeline. */
    planRequestSent: () =>
      add(COORDINATOR_AGENT, "turn-plan", { type: "user_message", messageId: PLAN_MESSAGE_ID }),
    reply: (agentId: string, text: string) =>
      add(agentId, turns.get(agentId) ?? "turn-plan", { type: "assistant_message", text }),
    turnOf: (agentId: string) => turns.get(agentId) ?? "turn-plan",
    /** The text of the agent's newest assistant message. */
    lastReply: (agentId: string) =>
      [...entries(agentId)].reverse().find((entry) => entry.item.type === "assistant_message")?.item
        .text ?? "",
    /** Changes the agent's newest assistant message, e.g. to break the report it holds. */
    rewriteLastReply: (agentId: string, change: (text: string) => string) => {
      const entry = [...entries(agentId)]
        .reverse()
        .find((item) => item.item.type === "assistant_message");
      if (entry) entry.item = { ...entry.item, text: change(entry.item.text ?? "") };
    },
    lastSent: (agentId: string) => [...sent].reverse().find((entry) => entry.agentId === agentId),
  };
}

type Host = ReturnType<typeof fakeHost>;

function build(host: Host, overrides: Partial<DriverOptions> = {}) {
  const observerHost = createObserverHost(host.port);
  const observer = createRunObserver({ store });
  const effects = createEffects({ store, port: host.port, compile: compileEngineIntent });
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
      if (seatId === JUDGE_SEAT_REVIEW) {
        return { profile: profile("luna", "profile-dev-luna"), available: true, order: 1 };
      }
      return null;
    },
    resolveWorkspace,
    compile: compileDispatch,
  });
  const intake = createIntake({
    store,
    observer,
    host: observerHost,
    repair: { send: (runId) => effects.runOutbox(runId) },
  });
  const dagIntake = createDagIntake({
    store,
    host: observerHost,
    seatFamily: () => null,
    resolveWorkspace,
    repair: { send: (runId) => effects.runOutbox(runId) },
  });
  const driver = createEngineDriver({
    store,
    observer,
    host: observerHost,
    intake,
    dagIntake,
    service,
    ...overrides,
  });
  return { driver, observer, service };
}

async function stored(): Promise<RunRecord> {
  const read = await store.get(RUN_ID);
  if (read.status !== "ok") throw new Error(`run unreadable: ${read.status}`);
  return read.record;
}

const states = (record: RunRecord) =>
  Object.fromEntries(record.tasks.map((task) => [task.spec.id, task.state]));

// --- what the scripted agents do ---------------------------------------------------------------

/** The JSON line after a section label of a prompt, typed by what the script reads from it. */
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

const hook = (host: Host, driver: ReturnType<typeof build>["driver"], agentId: string) =>
  driver.onHook({ name: "agent.turn_ended", agentId, turnId: host.turnOf(agentId) });

const plan = () => fence("task-dag", dagBlock(RUN_ID, planTasks(REPO_ALIAS)));

describe("the loop, from plan to finished Run", () => {
  test("two tasks, one after the other: nothing starts until what it waits for has passed every gate", async () => {
    const host = fakeHost();
    const { driver } = build(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());

    // The coordinator's turn ended: the plan is admitted and t1 goes out in the same breath.
    await hook(host, driver, COORDINATOR_AGENT);
    expect(states(await stored())).toEqual({ t1: "assigned", t2: "pending" });
    expect(host.sent.map((entry) => entry.agentId)).toEqual(["agent-b1"]);

    // t1 delivered: it is judged, not done, and t2 still waits.
    produce(host, "agent-b1");
    await hook(host, driver, "agent-b1");
    expect(states(await stored())).toEqual({ t1: "review", t2: "pending" });
    expect(host.sent.map((entry) => entry.agentId)).toEqual(["agent-b1", "agent-b2"]);

    // t1 passed review: only now t2 is ready, and it goes out.
    judge(host, "agent-b2");
    await hook(host, driver, "agent-b2");
    expect(states(await stored())).toEqual({ t1: "done", t2: "assigned" });
    expect(host.sent.map((entry) => entry.agentId)).toEqual(["agent-b1", "agent-b2", "agent-b1"]);

    produce(host, "agent-b1");
    await hook(host, driver, "agent-b1");
    expect(states(await stored())).toEqual({ t1: "done", t2: "review" });

    judge(host, "agent-b2");
    await hook(host, driver, "agent-b2");
    const after = await stored();
    expect(states(after)).toEqual({ t1: "done", t2: "done" });
    // Every task done and nothing left to settle: the Run is finished and holds nothing.
    expect(after.lifecycle).toBe("finished");
    expect(after.resources).toEqual([]);
    // Four messages in all, none repeated.
    expect(new Set(host.sent.map((entry) => entry.messageId)).size).toBe(4);
    expect(git(repoDir, "log", "--format=%s")).toBe("deliver t2\ndeliver t1\nbase");
  });

  test("a review that asks for changes sends the task back and the producer is asked again", async () => {
    const host = fakeHost();
    const { driver } = build(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, driver, COORDINATOR_AGENT);
    produce(host, "agent-b1");
    await hook(host, driver, "agent-b1");
    judge(host, "agent-b2", "修改后合入");
    await hook(host, driver, "agent-b2");

    const after = await stored();
    expect(states(after)).toEqual({ t1: "assigned", t2: "pending" });
    expect(after.tasks[0]?.attempts).toBe(2);
    expect(host.lastSent("agent-b1")?.text).toContain("【返工说明】");
    expect(host.sent).toHaveLength(3);
  });

  test("a reviewer that cannot review says so: the task freezes with the reason and nothing is sent", async () => {
    const host = fakeHost();
    const { driver } = build(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, driver, COORDINATOR_AGENT);
    produce(host, "agent-b1");
    await hook(host, driver, "agent-b1");
    expect(states(await stored())).toEqual({ t1: "review", t2: "pending" });

    const prompt = host.lastSent("agent-b2")?.text ?? "";
    const { messageId: _unused, ...identity } = section<Identity>(prompt, "【身份资料 JSON】");
    host.reply(
      "agent-b2",
      fence("task-report", {
        ...identity,
        status: "blocked",
        reasonCode: "ENVIRONMENT_UNAVAILABLE",
        summary: "the verification command returned a non-zero exit code; stopped",
        evidence: [],
      }),
    );
    const sentBefore = host.sent.length;
    await hook(host, driver, "agent-b2");

    const after = await stored();
    expect(states(after)).toEqual({ t1: "blocked", t2: "pending" });
    expect(after.tasks[0]).toMatchObject({
      phase: "frozen",
      waitingReason: "ENVIRONMENT_UNAVAILABLE",
    });
    expect(after.assignments.find((entry) => entry.purpose === "reviewer")?.state).toBe("ended");
    // Not a rework, not a second reviewer, and the dependent task does not start.
    expect(host.sent).toHaveLength(sentBefore);
  });

  test("a hook delivered twice, or for an agent no Run knows, sends nothing more", async () => {
    const host = fakeHost();
    const { driver } = build(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, driver, COORDINATOR_AGENT);
    const before = await stored();
    await hook(host, driver, COORDINATOR_AGENT);
    await driver.onHook({ name: "agent.turn_ended", agentId: "agent-nobody", turnId: "turn-x" });
    expect(host.sent).toHaveLength(1);
    expect((await stored()).revision).toBe(before.revision);
  });
});

describe("why a Run does not move", () => {
  test("a dirty working tree is shown on the task, and a kick after it is clean dispatches", async () => {
    const host = fakeHost();
    const { driver } = build(host);
    await writeFile(path.join(repoDir, "stray.txt"), "left behind");
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, driver, COORDINATOR_AGENT);

    const blocked = await stored();
    expect(blocked.lifecycle).toBe("active");
    expect(blocked.tasks[0]).toMatchObject({
      state: "ready",
      waitingReason: "dispatch-blocked:workspace-dirty",
    });
    expect(host.sent).toHaveLength(0);

    // Nothing announces a cleaned tree: a person's retry is a kick.
    await rm(path.join(repoDir, "stray.txt"));
    const report = await driver.kick(RUN_ID);
    expect(report.dispatched).toBe(1);
    const after = await stored();
    expect(after.tasks[0]).toMatchObject({ state: "assigned", waitingReason: null });
  });

  test("a paused Run sends nothing until it is resumed", async () => {
    const host = fakeHost();
    const { driver } = build(host);
    await writeFile(path.join(repoDir, "stray.txt"), "x");
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, driver, COORDINATOR_AGENT);
    await rm(path.join(repoDir, "stray.txt"));
    await store.update(RUN_ID, (current) => {
      const paused = reduceRun(
        current,
        { kind: "run-paused" },
        { now: new Date().toISOString(), newId: () => "x" },
      );
      return paused.ok ? paused.next : null;
    });

    expect((await driver.kick(RUN_ID)).last).toEqual({ status: "idle" });
    expect(host.sent).toHaveLength(0);

    await store.update(RUN_ID, (current) => {
      const resumed = reduceRun(
        current,
        { kind: "run-resumed" },
        { now: new Date().toISOString(), newId: () => "x" },
      );
      return resumed.ok ? resumed.next : null;
    });
    expect((await driver.kick(RUN_ID)).dispatched).toBe(1);
  });

  test("a Run still waiting for its DAG has nothing to dispatch", async () => {
    const host = fakeHost();
    const { driver } = build(host);
    expect((await driver.kick(RUN_ID)).last).toEqual({ status: "idle" });
    expect(host.sent).toHaveLength(0);
  });
});

describe("recovery and the hook handler", () => {
  test("a report that arrived while nothing listened is settled on recovery", async () => {
    const host = fakeHost();
    const first = build(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, first.driver, COORDINATOR_AGENT);
    // The member finished, but the hook never reached the Engine.
    produce(host, "agent-b1");
    expect(states(await stored()).t1).toBe("assigned");

    const second = build(host);
    expect(await second.driver.recover()).toEqual({ runs: 1 });
    expect(states(await stored()).t1).toBe("review");
    // The restart also moved on: the reviewer was asked.
    expect(host.sent.map((entry) => entry.agentId)).toEqual(["agent-b1", "agent-b2"]);
  });

  test("a plan that arrived while nothing listened is admitted on recovery", async () => {
    const host = fakeHost();
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    const { driver } = build(host);
    expect(await driver.recover()).toEqual({ runs: 1 });
    expect(states(await stored())).toEqual({ t1: "assigned", t2: "pending" });
  });

  test("the repeat of a hook whose settling failed is the retry", async () => {
    const host = fakeHost();
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    let failures = 1;
    const { driver } = build(host, {
      dagIntake: {
        settleCoordinator: async (agentId) => {
          if (failures > 0) {
            failures -= 1;
            throw new Error("host hiccup");
          }
          return createDagIntake({
            store,
            host: createObserverHost(host.port),
            seatFamily: () => null,
            resolveWorkspace: () => ({ workspaceId: "ws-start", directory: repoDir }),
          }).settleCoordinator(agentId);
        },
      },
    });
    await hook(host, driver, COORDINATOR_AGENT);
    expect(states(await stored())).toEqual({});
    // The host delivers the same hook again: recorded already, settled now.
    await hook(host, driver, COORDINATOR_AGENT);
    expect(states(await stored())).toEqual({ t1: "assigned", t2: "pending" });
  });

  test("a hook whose settling fails does not throw and is logged", async () => {
    const host = fakeHost();
    const log = vi.fn();
    const { driver } = build(host, {
      log,
      intake: {
        settleAgent: async () => {
          throw new Error("boom");
        },
      },
    });
    host.planRequestSent();
    await expect(hook(host, driver, COORDINATOR_AGENT)).resolves.toMatchObject({
      status: "recorded",
    });
    expect(log).toHaveBeenCalled();
  });
});

describe("kick", () => {
  test("a burst of kicks costs one pass and one more, not one each", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatchNext = vi.fn(async () => {
      await gate;
      return { status: "idle" as const };
    });
    const host = fakeHost();
    const { driver } = build(host, { service: { dispatchNext } });

    const kicks = [
      driver.kick(RUN_ID),
      driver.kick(RUN_ID),
      driver.kick(RUN_ID),
      driver.kick(RUN_ID),
    ];
    release();
    const reports = await Promise.all(kicks);
    expect(dispatchNext).toHaveBeenCalledTimes(2);
    expect(new Set(reports).size).toBe(1);
    // Once it is over, a new kick starts a pass of its own.
    await driver.kick(RUN_ID);
    expect(dispatchNext).toHaveBeenCalledTimes(3);
  });

  test("a kick never makes more than its bounded number of dispatches", async () => {
    const dispatchNext = vi.fn(async () => ({
      status: "dispatched" as const,
      taskId: "t1",
      purpose: "member" as const,
      assignmentId: "a",
      seatId: "s",
      outbox: { status: "ok" as const, sent: [], reconciled: [], unknown: [], failed: [] },
    }));
    const { driver } = build(fakeHost(), { service: { dispatchNext } });
    const report = await driver.kick(RUN_ID);
    expect(report.dispatched).toBe(32);
    expect(dispatchNext).toHaveBeenCalledTimes(32);
  });
});

describe("a report that cannot be used is asked for again", () => {
  const SCHEMA_BREAK = (text: string) =>
    text.replace('"status":"done"', '"status":"done","summary":"extra key the schema refuses"');

  /** A Run with t1 handed to its producer, which did the work and replied with a broken report. */
  async function brokenReport() {
    const host = fakeHost();
    const { driver } = build(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, driver, COORDINATOR_AGENT);
    produce(host, "agent-b1");
    const good = host.lastReply("agent-b1");
    host.rewriteLastReply("agent-b1", SCHEMA_BREAK);
    return { host, driver, good };
  }

  const t1 = (record: RunRecord) => record.tasks.find((task) => task.spec.id === "t1");
  const repairs = (record: RunRecord) =>
    record.outbox.filter((intent) => intent.kind === "wake" && intent.assignmentId !== null);

  test("a refused report gets one repair request, and the repaired report settles the task", async () => {
    const { host, driver, good } = await brokenReport();
    const before = host.sent.length;
    await hook(host, driver, "agent-b1");

    const asked = await stored();
    expect(host.sent).toHaveLength(before + 1);
    const request = host.lastSent("agent-b1");
    expect(request?.text).toContain("【重发身份 JSON】");
    expect(request?.text).toContain("report-rejected:schema-invalid");
    // The repair does not repeat what the member wrote, and the task did not move.
    expect(request?.text).not.toContain("extra key the schema refuses");
    expect(states(asked)).toEqual({ t1: "assigned", t2: "pending" });
    expect(t1(asked)).toMatchObject({
      protocolFailures: 1,
      waitingReason: "report-repair-requested:report-rejected:schema-invalid",
    });
    expect(repairs(asked)).toHaveLength(1);
    expect(repairs(asked)[0]?.state).toBe("confirmed");

    // The member restates the same report; it is read from the reply to the repair request.
    host.reply("agent-b1", good);
    await hook(host, driver, "agent-b1");
    const settled = await stored();
    expect(states(settled)).toEqual({ t1: "review", t2: "pending" });
    expect(repairs(settled)).toHaveLength(0);
    expect(settled.events.some((event) => event.kind === "report-repair-settled")).toBe(true);
    expect(host.lastSent("agent-b2")?.text).toContain("review");
  });

  test("a reply with no block is asked for again as missing", async () => {
    const { host, driver } = await brokenReport();
    host.rewriteLastReply("agent-b1", () => "All done, the module is committed.");
    await hook(host, driver, "agent-b1");
    expect(host.lastSent("agent-b1")?.text).toContain("report-missing");
    expect(t1(await stored())?.waitingReason).toBe("report-repair-requested:report-missing");
  });

  test("a hook delivered again while the repair is out asks for nothing more", async () => {
    const { host, driver } = await brokenReport();
    const turn = host.turnOf("agent-b1");
    await hook(host, driver, "agent-b1");
    const sent = host.sent.length;
    const asked = await stored();
    await driver.onHook({ name: "agent.turn_ended", agentId: "agent-b1", turnId: turn });
    expect(host.sent).toHaveLength(sent);
    expect(t1(await stored())).toMatchObject({
      protocolFailures: 1,
      waitingReason: t1(asked)?.waitingReason,
    });
    expect(repairs(await stored())).toHaveLength(1);
  });

  test("the budget is the policy's protocolResends, then the task waits as before", async () => {
    const { host, driver } = await brokenReport();
    const limit = (await stored()).policy.perTask.protocolResends;
    expect(limit).toBeGreaterThan(0);
    const base = host.sent.length;
    for (let round = 1; round <= limit; round += 1) {
      await hook(host, driver, "agent-b1");
      expect(host.sent).toHaveLength(base + round);
      host.reply("agent-b1", SCHEMA_BREAK(host.lastReply("agent-b1") || "x"));
      host.rewriteLastReply("agent-b1", () => "still not a report");
    }
    await hook(host, driver, "agent-b1");
    const after = await stored();
    expect(host.sent).toHaveLength(base + limit);
    expect(t1(after)).toMatchObject({
      protocolFailures: limit,
      waitingReason: "report-missing",
      state: "assigned",
    });
  });

  test("a turn that did not end on its own is not asked again", async () => {
    const { host, driver } = await brokenReport();
    const before = host.sent.length;
    await driver.onHook({
      name: "agent.turn_ended",
      agentId: "agent-b1",
      turnId: host.turnOf("agent-b1"),
      outcome: { kind: "failed" },
    });
    expect(host.sent).toHaveLength(before);
    expect(t1(await stored())?.protocolFailures).toBe(0);
  });
});

describe("a plan the parser refuses is asked for again", () => {
  /** The plan as DEV's haiku wrote it: no task has a `group`. */
  const brokenPlan = () =>
    fence(
      "task-dag",
      dagBlock(RUN_ID, planTasks(REPO_ALIAS).map(({ group: _group, ...rest }) => rest) as never),
    );

  const wakes = (record: RunRecord) => record.outbox.filter((intent) => intent.kind === "wake");

  test("the coordinator is sent the plan's fault once, its corrected plan starts the Run, and t1 goes out", async () => {
    const host = fakeHost();
    const { driver } = build(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, brokenPlan());
    await hook(host, driver, COORDINATOR_AGENT);

    // The Run waits for a DAG; the only message that went out is the re-send, to the coordinator.
    const waiting = await stored();
    expect(waiting.lifecycle).toBe("awaiting-dag");
    expect(waiting.tasks).toEqual([]);
    expect(host.sent.map((entry) => entry.agentId)).toEqual([COORDINATOR_AGENT]);
    const request = host.lastSent(COORDINATOR_AGENT)?.text ?? "";
    expect(request).toContain("【控制身份 JSON】");
    expect(request).toContain(DAG_NONCE);
    expect(request).toContain("tasks.0.group");
    expect(request).not.toContain("agent-b1");
    expect(wakes(waiting).map((intent) => intent.state)).toEqual(["confirmed", "confirmed"]);

    // The coordinator answers the re-send with the plan, in its next turn.
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, driver, COORDINATOR_AGENT);
    const after = await stored();
    expect(after.lifecycle).toBe("active");
    expect(states(after)).toEqual({ t1: "assigned", t2: "pending" });
    expect(wakes(after)).toEqual([]);
    expect(host.sent.map((entry) => entry.agentId)).toEqual([COORDINATOR_AGENT, "agent-b1"]);
  });

  test("a hook delivered again while the re-send is out asks for nothing more", async () => {
    const host = fakeHost();
    const { driver } = build(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, brokenPlan());
    await hook(host, driver, COORDINATOR_AGENT);
    const sent = host.sent.length;
    const before = await stored();
    // The first turn's hook arrives again; the reply being read is the re-send's, still being written.
    await driver.onHook({
      name: "agent.turn_ended",
      agentId: COORDINATOR_AGENT,
      turnId: "turn-plan",
    });
    expect(host.sent).toHaveLength(sent);
    expect((await stored()).revision).toBe(before.revision);
  });

  test("a re-send that is refused again is the end of it: the Run waits for a person, and nothing else is sent", async () => {
    const host = fakeHost();
    const { driver } = build(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, brokenPlan());
    await hook(host, driver, COORDINATOR_AGENT);
    host.reply(COORDINATOR_AGENT, brokenPlan());
    await hook(host, driver, COORDINATOR_AGENT);

    const after = await stored();
    expect(after.lifecycle).toBe("awaiting-dag");
    expect(host.sent.map((entry) => entry.agentId)).toEqual([COORDINATOR_AGENT]);
    expect(after.alerts.length).toBeGreaterThan(0);
    expect(wakes(after)).toHaveLength(2);
  });

  test("a plan refused for what it says is not asked about: the coordinator gets no second message", async () => {
    const host = fakeHost();
    const { driver } = build(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, fence("task-dag", dagBlock(RUN_ID, planTasks("repo-elsewhere"))));
    await hook(host, driver, COORDINATOR_AGENT);
    expect(host.sent).toHaveLength(0);
    expect((await stored()).lifecycle).toBe("awaiting-dag");
  });
});

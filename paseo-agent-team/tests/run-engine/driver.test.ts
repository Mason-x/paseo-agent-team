import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createRunControl } from "../../server/run-engine/control";
import { createDagIntake } from "../../server/run-engine/dag";
import { createEngineDriver, type DriverOptions } from "../../server/run-engine/driver";
import { createEffects } from "../../server/run-engine/effects";
import { createObserverHost } from "../../server/run-engine/host";
import { createIntake } from "../../server/run-engine/intake";
import { createLifecycleControl } from "../../server/run-engine/lifecycle";
import { createRunObserver } from "../../server/run-engine/observer";
import { projectDetail } from "../../server/run-engine/projection";
import { createReadRetry, type ReadFailure } from "../../server/run-engine/read-retry";
import { createEngineService } from "../../server/run-engine/service";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import { REPO_ALIAS } from "../../shared/domain/run-engine/dag-admission";
import { transitionIntent } from "../../shared/domain/run-engine/effect-state";
import { compileEngineIntent } from "../../shared/domain/run-engine/engine-prompts";
import { compileDispatch } from "../../shared/domain/run-engine/prompt-template";
import { emptyReadRetries, readReadRetries } from "../../shared/domain/run-engine/read-retry";
import { reduceRun } from "../../shared/domain/run-engine/reducer";
import { replyAnchor, requestReportRepair } from "../../shared/domain/run-engine/report-repair";
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
  // New Runs are v2; this file is also the v2 regression for everything that does not touch evidence.
  record.schemaVersion = expect.getState().currentTestName?.includes("[v1]") ? 1 : 2;
  // A new Run carries the block that gives it read re-checks.
  (record as Record<string, unknown>).readRetries = emptyReadRetries();
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
  const lose = { next: false };
  const flags = { newer: false };
  // Reads of the host that throw: the timeline (a reply) and the live agent state (a seat).
  const unreadable = { timeline: false, agent: false };
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
    hasNewer: flags.newer,
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
        archive: async () => undefined,
        timeline: {
          refetch: async () => {
            if (unreadable.timeline) throw new Error("the timeline cannot be read");
            return page(agentId);
          },
        },
        current: () => ({ status: "idle", activeTurn: null }),
        refresh: async () => {
          if (unreadable.agent) throw new Error("the agent cannot be read");
          return { agent: { status: "idle", activeTurn: null } };
        },
      }),
    },
  };
  return {
    port,
    sent,
    /** Pages say there is more after them: a turn that no later turn proves over is still open. */
    hasNewerPages: (value: boolean) => {
      flags.newer = value;
    },
    /** The host lost the history of an agent. */
    dropTimeline: (agentId: string) => {
      timelines.set(agentId, []);
    },
    /** The next send throws after the host "received" it, and leaves no echo in the timeline. */
    loseNextSend: () => {
      lose.next = true;
    },
    /** While set, reading the timeline or the live state of an agent throws. */
    setUnreadable: (what: "timeline" | "agent", value: boolean) => {
      unreadable[what] = value;
    },
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

function build(
  host: Host,
  overrides: Partial<DriverOptions> = {},
  /** What sends a repair once it is committed; a process that dies before sending passes one that throws. */
  repairSend?: (runId: string) => Promise<unknown>,
  /** What the service sends through. A stand-in that sends nothing leaves a committed request prepared. */
  serviceOutbox?: Pick<ReturnType<typeof createEffects>, "runOutbox">,
  /** Told when a read of the host failed, as the production wiring tells the read re-checks. */
  onReadFailure?: (runId: string, failure: ReadFailure) => void | Promise<void>,
) {
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
    effects: serviceOutbox ?? effects,
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
    onReadFailure,
  });
  const intake = createIntake({
    store,
    observer,
    host: observerHost,
    onReadFailure,
    repair: { send: repairSend ?? ((runId) => effects.runOutbox(runId)) },
  });
  const dagIntake = createDagIntake({
    store,
    host: observerHost,
    seatFamily: () => null,
    resolveWorkspace,
    repair: { send: repairSend ?? ((runId) => effects.runOutbox(runId)) },
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
  return { driver, observer, service, effects };
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
function produce(
  host: Host,
  agentId: string,
  options: { evidenceId?: string; exitCode?: number } = {},
): void {
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
        // A wrong id leaves the required evidence missing: the gate refuses it, the report is real.
        id: options.evidenceId ?? requirement.id,
        command: requirement.command,
        exitCode: options.exitCode ?? 0,
        summary: "passed",
        artifactPath: `${facts.evidenceDir}/${requirement.id}.log`,
        ref,
        isolation: { homePath: path.join(home, "isolated-home"), outsideRealHome: true },
      })),
    }),
  );
}

type EvidenceFacts = Facts & {
  evidenceRepair: { delivery: { ref: unknown; workspace: unknown; changedFiles: string[] } };
};

/** The member answers an evidence request from its own prompt: same delivery, the missing evidence added. */
function supplement(host: Host, agentId: string): void {
  const prompt = host.lastSent(agentId)?.text ?? "";
  const { messageId: _unused, ...identity } = section<Identity>(prompt, "【身份资料 JSON】");
  const facts = section<EvidenceFacts>(prompt, "【执行事实 JSON】");
  const task = section<TaskData>(prompt, "【任务资料 JSON】");
  const { ref, workspace, changedFiles } = facts.evidenceRepair.delivery;
  host.reply(
    agentId,
    fence("task-report", {
      ...identity,
      status: "done",
      changedFiles,
      ref,
      workspace,
      evidence: task.evidence.map((requirement) => ({
        id: requirement.id,
        command: requirement.command,
        exitCode: 0,
        summary: "collected",
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

  test("pause and resume through the lifecycle control: nothing goes out while paused, the held work goes out once on resume", async () => {
    const host = fakeHost();
    const { driver } = build(host);
    const lifecycle = createLifecycleControl({ store, driver });
    await writeFile(path.join(repoDir, "stray.txt"), "x");
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, driver, COORDINATOR_AGENT);
    expect(states(await stored()).t1).toBe("ready");

    expect((await lifecycle.pause(RUN_ID)).status).toBe("applied");
    await rm(path.join(repoDir, "stray.txt"));
    // Everything that could push the Run on is asked, and nothing is sent.
    await driver.kick(RUN_ID);
    await driver.retryRun(RUN_ID);
    await driver.recover();
    expect(host.sent.filter((entry) => entry.agentId !== COORDINATOR_AGENT)).toHaveLength(0);
    expect(states(await stored()).t1).toBe("ready");

    expect((await lifecycle.resume(RUN_ID)).status).toBe("applied");
    expect(states(await stored()).t1).toBe("assigned");
    const toMember = () => host.sent.filter((entry) => entry.agentId === "agent-b1");
    expect(toMember()).toHaveLength(1);
    // Pressing resume again, or kicking, sends nothing more.
    expect((await lifecycle.resume(RUN_ID)).status).toBe("unchanged");
    await driver.kick(RUN_ID);
    expect(toMember()).toHaveLength(1);
  });

  test("pause and resume as RPCs: nothing goes out while paused, the held work goes out once after the resume answer", async () => {
    const host = fakeHost();
    const { driver } = build(host);
    const control = createRunControl({
      store,
      ensureReady: async () => undefined,
      driver,
    });
    const ask = async (requestId: string) => ({
      runContractVersion: 1 as const,
      runId: RUN_ID,
      requestId,
      expectedRevision: (await stored()).revision,
      reason: "from the test",
    });
    await writeFile(path.join(repoDir, "stray.txt"), "x");
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, driver, COORDINATOR_AGENT);
    expect(states(await stored()).t1).toBe("ready");

    expect((await control.pause(await ask("pause-1"))).status).toBe("applied");
    await rm(path.join(repoDir, "stray.txt"));
    await driver.kick(RUN_ID);
    await driver.retryRun(RUN_ID);
    await driver.recover();
    const toMember = () => host.sent.filter((entry) => entry.agentId === "agent-b1");
    expect(toMember()).toHaveLength(0);
    expect(states(await stored()).t1).toBe("ready");

    expect((await control.resume(await ask("resume-1"))).status).toBe("applied");
    await control.idle();
    expect(states(await stored()).t1).toBe("assigned");
    expect(toMember()).toHaveLength(1);
    // The same answer again, or a kick, sends nothing more.
    const again = await control.resume({ ...(await ask("resume-1")), expectedRevision: 1 });
    await control.idle();
    expect(again.status).toBe("replayed");
    await driver.kick(RUN_ID);
    expect(toMember()).toHaveLength(1);
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

  test("a repair that was committed but never sent goes out when the process comes back, once", async () => {
    const host = fakeHost();
    const crashing = build(host, {}, async () => {
      throw new Error("the process died before it sent");
    });
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, crashing.driver, COORDINATOR_AGENT);
    produce(host, "agent-b1");
    host.rewriteLastReply("agent-b1", SCHEMA_BREAK);
    const before = host.sent.length;
    await hook(host, crashing.driver, "agent-b1");

    // The request is on the ledger and nothing was sent.
    const stuck = repairs(await stored());
    expect(stuck.map((intent) => intent.state)).toEqual(["prepared"]);
    expect(host.sent).toHaveLength(before);

    // The next process runs the outbox on recovery; the repair is sent, and not a second time.
    const next = build(host, { outbox: { run: (runId) => next.effects.runOutbox(runId) } });
    await next.driver.recover();
    expect(host.sent).toHaveLength(before + 1);
    expect(host.lastSent("agent-b1")?.text).toContain("【重发身份 JSON】");
    expect(repairs(await stored()).map((intent) => intent.state)).toEqual(["confirmed"]);
    // The scripted host never starts the member's next turn, so a second recovery would read the
    // old turn again; the property here is that a confirmed message is never sent twice.
    await next.effects.runOutbox(RUN_ID);
    expect(host.sent).toHaveLength(before + 1);
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

describe("evidence the gate refused is asked for again, on the same delivery", () => {
  /** t1 handed to its producer; the producer commits and reports evidence the gate refuses. */
  async function refused(options: { evidenceId?: string; exitCode?: number } = {}) {
    const host = fakeHost();
    const { driver } = build(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, driver, COORDINATOR_AGENT);
    const dispatched = await stored();
    produce(host, "agent-b1", { evidenceId: "not-required", ...options });
    const firstTurn = host.turnOf("agent-b1");
    await hook(host, driver, "agent-b1");
    return { host, driver, dispatched, firstTurn };
  }

  const t1 = (record: RunRecord) => record.tasks.find((task) => task.spec.id === "t1");
  const b1Budget = (record: RunRecord) =>
    record.budgets.entries.find((entry) => entry.scope === "seat" && entry.subjectId === "seat-b1")
      ?.reserved ?? 0;

  test("the producer is asked to add the missing evidence, then the delivery is judged as before", async () => {
    const { host, driver, dispatched } = await refused();

    // One more message to the same member, from the evidence template, and nothing else moved.
    const asked = await stored();
    expect(host.sent.map((entry) => entry.agentId)).toEqual(["agent-b1", "agent-b1"]);
    expect(host.lastSent("agent-b1")?.text).toContain("补齐已有交付的证据");
    expect(host.lastSent("agent-b1")?.text).not.toContain("agent-b1");
    expect(t1(asked)).toMatchObject({
      state: "assigned",
      attempts: 1,
      reworkCount: 0,
      qualityFailures: 0,
      evidenceReturns: 1,
    });
    // The original report stays as it was, the supplement is a second assignment of the same attempt.
    const [first, second] = asked.assignments.filter((entry) => entry.taskId === "t1");
    expect(first?.supersededByAssignmentId).toBe(second?.assignmentId);
    expect(second).toMatchObject({
      attempt: 1,
      agentId: first?.agentId,
      evidenceRepair: { version: 1, rootAssignmentId: first?.assignmentId, ordinal: 1 },
    });
    expect(second?.nonce).not.toBe(first?.nonce);
    // The claim that held the repository is the same one; one more model turn is reserved, once.
    expect(asked.resources).toEqual(dispatched.resources);
    expect(b1Budget(asked)).toBe(b1Budget(dispatched) + 1);

    supplement(host, "agent-b1");
    await hook(host, driver, "agent-b1");
    expect(states(await stored())).toEqual({ t1: "review", t2: "pending" });
    expect(host.sent.map((entry) => entry.agentId)).toEqual(["agent-b1", "agent-b1", "agent-b2"]);

    judge(host, "agent-b2");
    await hook(host, driver, "agent-b2");
    const done = await stored();
    expect(states(done)).toEqual({ t1: "done", t2: "assigned" });
    // The supplement changed no file and made no commit.
    expect(git(repoDir, "log", "--format=%s")).toBe("deliver t1\nbase");
    expect(t1(done)).toMatchObject({ attempts: 1, reworkCount: 0, evidenceReturns: 1 });
  });

  // The scripted host reports every agent idle, so a reconcile may find the supplement's turn "ended"
  // with no reply and ask for the report again (a format repair, a different message). What these
  // two tests guard is the evidence request itself: it is asked once, however often the Run is moved.
  const supplements = (record: RunRecord) =>
    record.assignments.filter((entry) => entry.evidenceRepair !== undefined);
  const evidenceRequests = (host: Host) =>
    host.sent.filter((entry) => entry.text.includes("补齐已有交付的证据"));

  test("the same hook again, or a kick, does not ask twice", async () => {
    const { host, driver, firstTurn } = await refused();
    await driver.onHook({ name: "agent.turn_ended", agentId: "agent-b1", turnId: firstTurn });
    await driver.kick(RUN_ID);
    await driver.retryRun(RUN_ID);
    const again = await stored();
    expect(evidenceRequests(host)).toHaveLength(1);
    expect(supplements(again)).toHaveLength(1);
    expect(t1(again)).toMatchObject({ attempts: 1, evidenceReturns: 1 });
  });

  test("a restart finds the request already out and sends no second one", async () => {
    const { host } = await refused();
    const second = build(host, { outbox: { run: (runId) => second.effects.runOutbox(runId) } });
    await second.driver.recover();
    await second.driver.recover();
    const after = await stored();
    expect(evidenceRequests(host)).toHaveLength(1);
    expect(supplements(after)).toHaveLength(1);
    expect(t1(after)).toMatchObject({ attempts: 1, evidenceReturns: 1 });
  });

  test("with no returns allowed nothing is asked: the task waits with the reason and keeps its claim", async () => {
    await store.update(RUN_ID, (record) => {
      record.policy.perTask.evidenceReturns = 0;
      return record;
    });
    const { host } = await refused();
    const waiting = await stored();
    expect(host.sent).toHaveLength(1);
    expect(t1(waiting)).toMatchObject({ state: "in_progress", evidenceReturns: 1 });
    expect(waiting.assignments.filter((entry) => entry.taskId === "t1")).toHaveLength(1);
    expect(waiting.resources.length).toBeGreaterThan(0);
  });

  test("[v1] a Run written before this contract is never asked to supplement: it keeps the old behaviour", async () => {
    const { host } = await refused();
    const waiting = await stored();
    expect(waiting.schemaVersion).toBe(1);
    expect(evidenceRequests(host)).toHaveLength(0);
    expect(host.sent).toHaveLength(1);
    expect(supplements(waiting)).toHaveLength(0);
    expect(t1(waiting)).toMatchObject({ state: "in_progress", evidenceReturns: 1 });
  });

  test("a check that really failed is not asked for again", async () => {
    const { host } = await refused({ evidenceId: undefined, exitCode: 1 });
    expect(host.sent).toHaveLength(1);
    const waiting = await stored();
    expect(t1(waiting)).toMatchObject({ state: "in_progress", evidenceReturns: 1 });
    expect(waiting.assignments.filter((entry) => entry.taskId === "t1")).toHaveLength(1);
  });

  test("a request is rechecked just before it leaves: a dirty tree holds it back, a clean one sends it once", async () => {
    const host = fakeHost();
    // Once armed, the service commits what it prepares but sends nothing, as when a process dies
    // right after the commit.
    let armed = false;
    const switchable = {
      runOutbox: async (runId: string) =>
        armed
          ? { status: "ok" as const, sent: [], reconciled: [], unknown: [], failed: [] }
          : built.effects.runOutbox(runId),
    };
    const built = build(host, {}, undefined, switchable);
    const { driver, effects } = built;
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, driver, COORDINATOR_AGENT);
    produce(host, "agent-b1", { evidenceId: "not-required" });
    armed = true;
    await hook(host, driver, "agent-b1");
    const prepared = (await stored()).outbox.filter(
      (entry) => entry.state === "prepared" && entry.assignmentId !== null,
    );
    expect(prepared).toHaveLength(1);
    expect(evidenceRequests(host)).toHaveLength(0);

    // Someone leaves a file in the working tree: the delivery is no longer what it was.
    const stray = path.join(repoDir, "stray.txt");
    writeFileSync(stray, "left behind\n");
    await effects.runOutbox(RUN_ID);
    expect(evidenceRequests(host)).toHaveLength(0);
    expect((await stored()).outbox.find((entry) => entry.id === prepared[0]?.id)?.state).toBe(
      "prepared",
    );

    rmSync(stray);
    await effects.runOutbox(RUN_ID);
    await effects.runOutbox(RUN_ID);
    expect(evidenceRequests(host)).toHaveLength(1);
    expect((await stored()).outbox.find((entry) => entry.id === prepared[0]?.id)?.state).toBe(
      "confirmed",
    );
  });

  test("a supplement that says it cannot be done freezes the task and offers no retry that redoes the work", async () => {
    const { host, driver } = await refused();
    const prompt = host.lastSent("agent-b1")?.text ?? "";
    const { messageId: _unused, ...identity } = section<Identity>(prompt, "【身份资料 JSON】");
    host.reply(
      "agent-b1",
      fence("task-report", {
        ...identity,
        status: "blocked",
        reasonCode: "EVIDENCE_UNAVAILABLE",
        summary: "the logs are gone",
        evidence: [],
      }),
    );
    await hook(host, driver, "agent-b1");
    await driver.kick(RUN_ID);
    const stopped = await stored();
    expect(t1(stopped)).toMatchObject({ state: "blocked", waitingReason: "EVIDENCE_UNAVAILABLE" });
    expect(stopped.resources.every((claim) => claim.frozen)).toBe(true);
    // A retry would discard the delivery and implement the task again, so the decision it gets has its
    // own key (not `stuck:`) and offers only `cancel`.
    expect(stopped.decisions).toHaveLength(1);
    const opened = stopped.decisions[0];
    expect(opened).toMatchObject({ category: "D1", state: "open", subjectId: "t1" });
    expect(opened?.dedupeKey.startsWith("evidence-stuck:")).toBe(true);
    const view = projectDetail(stopped);
    if (!view.ok) throw new Error("projection failed");
    expect(view.view.decisions.map((d) => d.actions)).toEqual([["cancel"]]);
  });

  test("the decision of a frozen supplement can only be answered with cancel: a retry is refused, a cancel releases the claim and the dependents", async () => {
    const { host, driver } = await refused();
    const prompt = host.lastSent("agent-b1")?.text ?? "";
    const { messageId: _unused, ...identity } = section<Identity>(prompt, "【身份资料 JSON】");
    host.reply(
      "agent-b1",
      fence("task-report", {
        ...identity,
        status: "failed",
        reasonCode: "EVIDENCE_UNAVAILABLE",
        summary: "the logs are gone",
        evidence: [],
      }),
    );
    await hook(host, driver, "agent-b1");
    await driver.kick(RUN_ID);
    const stopped = await stored();
    const decision = stopped.decisions[0];
    expect(decision?.dedupeKey.startsWith("evidence-stuck:")).toBe(true);
    // Looking again opens nothing more.
    await driver.kick(RUN_ID);
    expect((await stored()).decisions).toHaveLength(1);

    const control = createRunControl({ store, ensureReady: async () => undefined, driver });
    const ask = async (action: "retry" | "cancel") => ({
      runContractVersion: 1 as const,
      runId: RUN_ID,
      decisionId: decision?.decisionId ?? "",
      requestId: `ans-${action}`,
      expectedRevision: (await stored()).revision,
      reason: "from the test",
      answer: { action },
    });
    const retry = await control.decide(await ask("retry"));
    expect(retry).toMatchObject({ status: "rejected", issues: [{ code: "action-unsupported" }] });
    expect((await stored()).revision).toBe(stopped.revision);

    const sent = host.sent.length;
    const cancelled = await control.decide(await ask("cancel"));
    expect(cancelled).toMatchObject({ status: "applied", cancelledTaskIds: ["t1", "t2"] });
    await control.idle();
    const after = await stored();
    expect(t1(after)).toMatchObject({ state: "cancelled" });
    expect(after.resources).toEqual([]);
    expect(after.decisions.find((d) => d.decisionId === decision?.decisionId)).toMatchObject({
      state: "answered",
      answer: { action: "cancel" },
    });
    expect(host.sent).toHaveLength(sent);
  });

  test("a supplement read from a message that a newer repair has replaced is not taken in; the next pass reads the new one", async () => {
    // The store the engine uses is watched: once armed, the first read of the ledger after the host's
    // timeline was read (the intake's own sample of the Run) is followed by a newer repair going out.
    const real = store;
    const watch = { armed: false, hostRead: false, injected: false };
    store = new Proxy(real, {
      get(target, prop) {
        if (prop === "get") {
          return async (runId: string) => {
            const read = await target.get(runId);
            if (watch.armed && watch.hostRead && !watch.injected) {
              watch.injected = true;
              await target.update(runId, (current) => {
                const assignment = current.assignments
                  .filter((entry) => entry.evidenceRepair !== undefined)
                  .at(-1);
                if (!assignment) return null;
                const drafted = requestReportRepair(current, {
                  assignmentId: assignment.assignmentId,
                  anchor: replyAnchor(current, assignment),
                  reason: "report-missing",
                  issues: [],
                  intentId: "intent-repair-race",
                  messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
                  payloadHash: "0".repeat(64),
                  templateVersion: 1,
                  now: "2026-11-05T12:01:00.000Z",
                });
                if (!drafted.ok) return null;
                const sending = transitionIntent(drafted.next, "intent-repair-race", "sending", {
                  now: "2026-11-05T12:01:01.000Z",
                });
                return sending.ok ? sending.next : null;
              });
            }
            return read;
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const { host, driver } = await refused();
    const realRef = host.port.agents.ref;
    host.port.agents.ref = (agentId) => {
      const ref = realRef(agentId);
      return {
        ...ref,
        timeline: {
          refetch: async (...args: Parameters<typeof ref.timeline.refetch>) => {
            watch.hostRead = true;
            return ref.timeline.refetch(...args);
          },
        },
      };
    };
    expect(supplements(await stored())).toHaveLength(1);
    supplement(host, "agent-b1");
    watch.hostRead = false;
    watch.armed = true;
    await hook(host, driver, "agent-b1");

    expect(watch.injected).toBe(true);
    const after = await stored();
    const asked = supplements(after)[0];
    expect(asked).toMatchObject({ state: "assigned", acceptedProof: null });
    expect(t1(after)).toMatchObject({ evidenceReturns: 1 });
    expect(after.outbox.find((entry) => entry.id === "intent-repair-race")).toMatchObject({
      state: "sending",
    });
    // Nothing was judged: no reviewer got anything.
    expect(host.sent.some((entry) => entry.agentId === "agent-b2")).toBe(false);
    store = real;
  });

  test("a request whose delivery is unknown stays sent once: claims freeze and nothing is re-sent", async () => {
    const host = fakeHost();
    const { driver } = build(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, driver, COORDINATOR_AGENT);
    produce(host, "agent-b1", { evidenceId: "not-required" });
    host.loseNextSend();
    await hook(host, driver, "agent-b1");

    const lost = await stored();
    const request = lost.outbox.find(
      (entry) =>
        entry.kind === "dispatch" && entry.assignmentId !== null && entry.state !== "confirmed",
    );
    expect(request?.state).toBe("outcome-unknown");
    expect(lost.resources.every((claim) => claim.frozen)).toBe(true);
    const sent = host.sent.length;
    await driver.kick(RUN_ID);
    await driver.retryRun(RUN_ID);
    expect(host.sent).toHaveLength(sent);
    expect(states(await stored()).t1).toBe("assigned");
  });
});

describe("a host that could not be read is read again, and a person is told what came of it", () => {
  /** The wiring as production makes it: the intake and the service tell the re-checks, a pass sweeps. */
  function wired(host: Host, wiring: { auto?: boolean } = {}) {
    const clock = { at: Date.now() };
    // What a read that works again does in production: pushes the Run on, like a kick.
    let continuing: (runId: string) => Promise<unknown> = async () => undefined;
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
      onRecovered: wiring.auto ? (runId) => continuing(runId).then(() => undefined) : undefined,
    });
    const built = build(
      host,
      { onPassed: (runId) => retry.sweep(runId) },
      undefined,
      undefined,
      (runId, failure) => retry.note(runId, failure),
    );
    continuing = (runId) => built.driver.retryRun(runId, { afterWrite: true });
    return { ...built, retry, clock };
  }

  const items = async () => {
    const block = readReadRetries(await stored());
    if (block.kind !== "valid") throw new Error(`block is ${block.kind}`);
    return block.items;
  };

  test("a reply that could not be read: the read works again later, a warning asks for a kick, and only the kick takes the report in", async () => {
    const host = fakeHost();
    const { driver, retry, clock } = wired(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, driver, COORDINATOR_AGENT);
    produce(host, "agent-b1");

    host.setUnreadable("timeline", true);
    await hook(host, driver, "agent-b1");
    const failed = await stored();
    expect(await items()).toEqual([
      expect.objectContaining({
        state: "waiting",
        attemptsStarted: 0,
        target: expect.objectContaining({ type: "reply", agentId: "agent-b1", taskId: "t1" }),
      }),
    ]);
    expect(states(failed).t1).toBe("assigned");
    expect(host.sent.map((entry) => entry.agentId)).toEqual(["agent-b1"]);

    // The host answers again. The re-check finds that out and says so; it does not take the report in.
    host.setUnreadable("timeline", false);
    const sent = host.sent.length;
    clock.at += 1500;
    await retry.fire();
    const told = await stored();
    expect((await items())[0]).toMatchObject({ state: "resolved" });
    expect(told.alerts.map((alert) => alert.state)).toEqual(["open"]);
    expect(told.alerts[0]?.summary).toContain("读取恢复，报告未入账，请 kick");
    expect(states(told).t1).toBe("assigned");
    expect(told.assignments.find((entry) => entry.taskId === "t1")?.acceptedProof).toBeNull();
    expect(host.sent).toHaveLength(sent);

    // A person kicks: the report is read and taken in by the ordinary path, and the warning goes.
    await driver.retryRun(RUN_ID);
    const settled = await stored();
    expect(states(settled).t1).toBe("review");
    expect(settled.alerts.every((alert) => alert.state === "resolved")).toBe(true);
  });

  test("a reply that stays unreadable is tried three times and then left, with the alert saying so", async () => {
    const host = fakeHost();
    const { driver, retry, clock } = wired(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, driver, COORDINATOR_AGENT);
    produce(host, "agent-b1");
    host.setUnreadable("timeline", true);
    await hook(host, driver, "agent-b1");
    for (const wait of [1500, 2500, 4500, 100_000]) {
      clock.at += wait;
      await retry.fire();
    }
    expect((await items())[0]).toMatchObject({ state: "held", attemptsStarted: 3 });
    const after = await stored();
    expect(after.alerts.map((alert) => alert.summary.slice(0, 7))).toEqual(["读取重试已用尽"]);
    expect(states(after).t1).toBe("assigned");
    expect(host.sent).toHaveLength(1);
    expect(retry.armed).toBe(false);
  });

  test("a seat that could not be read before a dispatch: nothing is sent, the read works again, and a kick dispatches and takes the alert down", async () => {
    const host = fakeHost();
    const { driver, retry, clock } = wired(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    host.setUnreadable("agent", true);
    await hook(host, driver, COORDINATOR_AGENT);
    expect(host.sent).toHaveLength(0);
    // Every seat whose state could not be read is its own item: the producer's and the reviewer's.
    expect((await items()).map((item) => [item.state, item.target])).toEqual([
      ["waiting", { type: "seat", agentId: "agent-b1" }],
      ["waiting", { type: "seat", agentId: "agent-b2" }],
    ]);

    host.setUnreadable("agent", false);
    clock.at += 1500;
    await retry.fire();
    // The read works again; that alone dispatches nothing.
    expect(host.sent).toHaveLength(0);
    expect((await stored()).alerts.map((alert) => alert.state)).toEqual(["open", "open"]);

    await driver.kick(RUN_ID);
    expect(host.sent.map((entry) => entry.agentId)).toEqual(["agent-b1"]);
    expect((await stored()).alerts.every((alert) => alert.state === "resolved")).toBe(true);
  });

  test("a reply that could not be read and then can: with the automatic continue the report is taken in without a person's kick, once", async () => {
    const host = fakeHost();
    const { driver, retry, clock } = wired(host, { auto: true });
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, driver, COORDINATOR_AGENT);
    produce(host, "agent-b1");
    host.setUnreadable("timeline", true);
    await hook(host, driver, "agent-b1");
    expect(states(await stored()).t1).toBe("assigned");

    host.setUnreadable("timeline", false);
    const sent = host.sent.length;
    clock.at += 1500;
    await retry.fire();
    const settled = await stored();
    expect(states(settled).t1).toBe("review");
    expect(
      settled.assignments.find((a) => a.taskId === "t1" && a.purpose === "member")?.acceptedProof,
    ).not.toBeNull();
    expect(settled.alerts.every((alert) => alert.state === "resolved")).toBe(true);
    // The judge was asked, once, by the ordinary path; the producer was not asked again.
    expect(host.sent.slice(sent).map((entry) => entry.agentId)).toEqual(["agent-b2"]);
    expect(retry.armed).toBe(false);
  });

  test("a seat that could not be read and then can: with the automatic continue the dispatch happens without a kick", async () => {
    const host = fakeHost();
    const { driver, retry, clock } = wired(host, { auto: true });
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    host.setUnreadable("agent", true);
    await hook(host, driver, COORDINATOR_AGENT);
    expect(host.sent).toHaveLength(0);
    host.setUnreadable("agent", false);
    clock.at += 1500;
    await retry.fire();
    expect(host.sent.map((entry) => entry.agentId)).toEqual(["agent-b1"]);
    expect((await stored()).alerts.every((alert) => alert.state === "resolved")).toBe(true);
    // Nothing is due any more: more time passing sends nothing.
    clock.at += 100_000;
    await retry.fire();
    expect(host.sent).toHaveLength(1);
  });

  test("the seat read just before a supplement is sent: when it fails the request waits and the seat is registered, and once it reads again the request goes out exactly once", async () => {
    const host = fakeHost();
    const asked = (target: Host) =>
      target.sent.filter((entry) => entry.text.includes("补齐已有交付的证据"));
    const clock = { at: Date.now() };
    const readHost = createObserverHost(host.port);
    let armed = false;
    // The service commits the supplement and does not send it; the outbox of the driver is the one that does.
    const switchable = {
      runOutbox: async (runId: string) =>
        armed
          ? { status: "ok" as const, sent: [], reconciled: [], unknown: [], failed: [] }
          : built.effects.runOutbox(runId),
    };
    const retry = createReadRetry({
      store,
      clock: { now: () => new Date(clock.at).toISOString() },
      schedule: () => () => undefined,
      readReply: (agentId, messageId) => readHost.replyWindow(agentId, messageId),
      readSeat: async (agentId) => {
        const refreshed = await host.port.agents.ref(agentId).refresh();
        if (!refreshed?.agent) throw new Error("no agent state");
      },
      onRecovered: (runId) =>
        built.driver.retryRun(runId, { afterWrite: true }).then(() => undefined),
    });
    const built = build(
      host,
      {
        onPassed: (runId) => retry.sweep(runId),
        // As in production, a pass of the driver also sends what is prepared.
        outbox: { run: (runId) => built.effects.runOutbox(runId) },
      },
      undefined,
      switchable,
      (runId, failure) => retry.note(runId, failure),
    );
    const { driver } = built;
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, driver, COORDINATOR_AGENT);
    produce(host, "agent-b1", { evidenceId: "not-required" });
    armed = true;
    await hook(host, driver, "agent-b1");
    armed = false;
    const prepared = await stored();
    expect(prepared.outbox.some((i) => i.kind === "dispatch" && i.state === "prepared")).toBe(true);
    expect(asked(host)).toHaveLength(0);

    // Sending is tried; the seat cannot be read just before. Nothing is sent, and the seat is registered.
    host.setUnreadable("agent", true);
    await built.effects.runOutbox(RUN_ID);
    expect(asked(host)).toHaveLength(0);
    expect(
      (await items()).some(
        (item) => item.target.type === "seat" && item.target.agentId === "agent-b1",
      ),
    ).toBe(true);

    host.setUnreadable("agent", false);
    clock.at += 1500;
    await retry.fire();
    expect(asked(host)).toHaveLength(1);
    await driver.kick(RUN_ID);
    await driver.retryRun(RUN_ID);
    expect(asked(host)).toHaveLength(1);
  });

  test("a reply window the host gave incomplete is read again, three times, and then the alert says so; a turn that is only still open is not", async () => {
    const host = fakeHost();
    const { driver, retry, clock } = wired(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, driver, COORDINATOR_AGENT);
    produce(host, "agent-b1");

    // Still open: no later turn proves it over and the pages say there is more. Not a failed read.
    host.hasNewerPages(true);
    await hook(host, driver, "agent-b1");
    expect(await items()).toEqual([]);
    host.hasNewerPages(false);

    // The host lost the history: the dispatch cannot be found. That is a read that did not work.
    host.dropTimeline("agent-b1");
    await hook(host, driver, "agent-b1");
    expect(await items()).toEqual([
      expect.objectContaining({
        state: "waiting",
        target: expect.objectContaining({ type: "reply", agentId: "agent-b1", taskId: "t1" }),
      }),
    ]);
    for (const wait of [1500, 2500, 4500]) {
      clock.at += wait;
      await retry.fire();
    }
    expect((await items())[0]).toMatchObject({ state: "held", attemptsStarted: 3 });
    expect((await stored()).alerts.map((alert) => alert.summary.slice(0, 7))).toEqual([
      "读取重试已用尽",
    ]);
  });

  test("a reply that cannot be read when the Run is reconciled is registered for the re-checks", async () => {
    const host = fakeHost();
    const { driver } = wired(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, driver, COORDINATOR_AGENT);
    host.setUnreadable("timeline", true);
    await driver.recover();
    const registered = await items();
    expect(registered.filter((item) => item.target.type === "reply")).toEqual([
      expect.objectContaining({
        state: "waiting",
        target: expect.objectContaining({ type: "reply", agentId: "agent-b1", taskId: "t1" }),
      }),
    ]);
    // The coordinator's plan reply has no assignment, and is not given one.
    expect(registered.every((item) => item.target.agentId !== COORDINATOR_AGENT)).toBe(true);
  });

  test("a v1 Run, or one made without the block, is read as before: nothing is written down", async () => {
    await store.update(RUN_ID, (record) => {
      delete (record as Record<string, unknown>).readRetries;
      return record;
    });
    const host = fakeHost();
    const { driver } = wired(host);
    host.planRequestSent();
    host.reply(COORDINATOR_AGENT, plan());
    await hook(host, driver, COORDINATOR_AGENT);
    produce(host, "agent-b1");
    host.setUnreadable("timeline", true);
    await hook(host, driver, "agent-b1");
    const after = await stored();
    expect((after as Record<string, unknown>).readRetries).toBeUndefined();
    expect(after.alerts).toHaveLength(0);
    expect(after.events.some((event) => event.kind === "read-retry-changed")).toBe(false);
  });
});

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDagIntake } from "../../server/run-engine/dag";
import { createEngineDriver } from "../../server/run-engine/driver";
import { createEffects } from "../../server/run-engine/effects";
import { createObserverHost } from "../../server/run-engine/host";
import { createIntake } from "../../server/run-engine/intake";
import { createRunObserver } from "../../server/run-engine/observer";
import { createEngineService } from "../../server/run-engine/service";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import { REPO_ALIAS } from "../../shared/domain/run-engine/dag-admission";
import { compileEngineIntent } from "../../shared/domain/run-engine/engine-prompts";
import { FAILED_LIMIT_ALERT_PREFIX } from "../../shared/domain/run-engine/failure-limit";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import { compileDispatch } from "../../shared/domain/run-engine/prompt-template";
import { emptyReadRetries } from "../../shared/domain/run-engine/read-retry";
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
import { JUDGE_SEAT_REVIEW } from "./support/review-run";

/**
 * The failed-task gate in a whole Run: a real store, a real git repository, and the driver with the
 * hooks that tell it a turn ended. Failure modes:
 *  - a Run with more failed tasks than its policy allows still handing out work, or one at its limit
 *    refusing to;
 *  - the gate also shutting out what is already in flight (a report, a repair request);
 *  - the gate writing the same alert on every pass, or an idle Run being written to at all;
 *  - the way out (a person cancelling failed tasks) not reopening dispatch, or leaving the alert up;
 *  - the gate touching a Run that does not dispatch (paused, still waiting for its plan), the frozen
 *    policy, or the schema version of the record.
 */

const RUN_ID = "run-flm001-a1";
const REASON = "dispatch-blocked:failed-task-limit";

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
  home = await realpath(await mkdtemp(path.join(tmpdir(), "run-flimit-")));
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
  const name = expect.getState().currentTestName ?? "";
  record.schemaVersion = name.includes("[v1]") ? 1 : 2;
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
        current: () => ({ status: "idle", activeTurn: null, pendingPermissions: [] }),
        refresh: async () => ({
          agent: { status: "idle", activeTurn: null, pendingPermissions: [] },
        }),
      }),
    },
  };
  return {
    port,
    sent,
    planRequestSent: () =>
      add(COORDINATOR_AGENT, "turn-plan", { type: "user_message", messageId: PLAN_MESSAGE_ID }),
    reply: (agentId: string, text: string) =>
      add(agentId, turns.get(agentId) ?? "turn-plan", { type: "assistant_message", text }),
    turnOf: (agentId: string) => turns.get(agentId) ?? "turn-plan",
    lastSent: (agentId: string) => [...sent].reverse().find((entry) => entry.agentId === agentId),
    lastReply: (agentId: string) =>
      [...entries(agentId)].reverse().find((entry) => entry.item.type === "assistant_message")?.item
        .text ?? "",
    rewriteLastReply: (agentId: string, change: (text: string) => string) => {
      const entry = [...entries(agentId)]
        .reverse()
        .find((item) => item.item.type === "assistant_message");
      if (entry) entry.item = { ...entry.item, text: change(entry.item.text ?? "") };
    },
  };
}

type Host = ReturnType<typeof fakeHost>;

function build(host: Host) {
  const observerHost = createObserverHost(host.port);
  const observer = createRunObserver({ store });
  const effects = createEffects({
    store,
    port: host.port,
    compile: compileEngineIntent,
    resolveWorkspace: () => ({ workspaceId: "ws-start", directory: repoDir }),
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
  return createEngineDriver({
    store,
    observer,
    host: observerHost,
    intake,
    dagIntake,
    service,
  });
}

type Driver = ReturnType<typeof build>;

async function stored(): Promise<RunRecord> {
  const read = await store.get(RUN_ID);
  if (read.status !== "ok") throw new Error(`run unreadable: ${read.status}`);
  return read.record;
}

const states = (record: RunRecord) =>
  Object.fromEntries(record.tasks.map((entry) => [entry.spec.id, entry.state]));

// --- what the scripted agents do ---------------------------------------------------------------

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
  const data = section<TaskData>(prompt, "【任务资料 JSON】");
  const file = data.scopes[0]?.path ?? "";
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
      evidence: data.evidence.map((requirement) => ({
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

function judge(host: Host, agentId: string): void {
  const prompt = host.lastSent(agentId)?.text ?? "";
  const { messageId: _unused, ...identity } = section<Identity>(prompt, "【身份资料 JSON】");
  const facts = section<Facts>(prompt, "【执行事实 JSON】");
  host.reply(
    agentId,
    fence("review-report", {
      ...identity,
      reviewedRef: facts.delivery.deliveryRef,
      verdict: "可合入",
      blockers: [],
      probes: [],
    }),
  );
}

const hook = (host: Host, driver: Driver, agentId: string) =>
  driver.onHook({ name: "agent.turn_ended", agentId, turnId: host.turnOf(agentId) });

const plan = () => fence("task-dag", dagBlock(RUN_ID, planTasks(REPO_ALIAS)));

/** The plan is admitted and t1 (the only task that can start) goes to its producer. */
async function admitted(): Promise<{ host: Host; driver: Driver }> {
  const host = fakeHost();
  const driver = build(host);
  host.planRequestSent();
  host.reply(COORDINATOR_AGENT, plan());
  await hook(host, driver, COORDINATOR_AGENT);
  expect(states(await stored())).toEqual({ t1: "assigned", t2: "pending" });
  return { host, driver };
}

// --- the failed tasks a Run has accumulated, and the people who clear them ---------------------

/** Adds `count` tasks that failed (a top-tier task out of quality attempts ends this way). */
async function addFailed(count: number): Promise<void> {
  await store.update(RUN_ID, (current) => {
    const next = structuredClone(current);
    const known = next.tasks.filter((entry) => entry.spec.id.startsWith("f")).length;
    for (let index = known + 1; index <= known + count; index += 1) {
      next.tasks.push(
        task(`f${index}`, `Failed task ${index}`, {
          state: "failed",
          waitingReason: "S-quality-failure",
        }),
      );
    }
    return next;
  });
}

/** What a person's `cancel` answer leaves of a failed task. */
async function cancelFailed(taskId: string): Promise<void> {
  await store.update(RUN_ID, (current) => {
    const next = structuredClone(current);
    const found = next.tasks.find((entry) => entry.spec.id === taskId);
    if (found === undefined) throw new Error(`${taskId} is not in the Run`);
    if (found.state !== "failed") throw new Error(`${taskId} is not a failed task`);
    found.state = "cancelled";
    found.waitingReason = null;
    return next;
  });
}

const gateAlerts = (record: RunRecord) =>
  record.alerts.filter((alert) => alert.summary.startsWith(FAILED_LIMIT_ALERT_PREFIX));
const resolvedEvents = (record: RunRecord) =>
  record.events.filter((event) => event.kind === "alert-resolved");
const t1Of = (record: RunRecord) => record.tasks.find((entry) => entry.spec.id === "t1");

describe("the failed-task gate", () => {
  test("a Run at its limit still hands out work, and says nothing about failures", async () => {
    const { host, driver } = await admitted();
    await addFailed(3);
    produce(host, "agent-b1");
    await hook(host, driver, "agent-b1");

    // Three failed with a limit of three: the delivered task goes to its reviewer as usual.
    expect(host.sent.map((entry) => entry.agentId)).toEqual(["agent-b1", "agent-b2"]);
    const after = await stored();
    expect(states(after).t1).toBe("review");
    expect(gateAlerts(after)).toEqual([]);
    expect(t1Of(after)?.waitingReason ?? "").not.toContain("failed-task-limit");

    judge(host, "agent-b2");
    await hook(host, driver, "agent-b2");
    // t1 passed, so t2 (which waited for it) is the next to start.
    expect(states(await stored()).t2).toBe("assigned");
    expect(host.sent.map((entry) => entry.agentId)).toEqual(["agent-b1", "agent-b2", "agent-b1"]);
  });

  test.each(["v1", "v2"] as const)(
    "[%s] one failed task over the limit shuts dispatch: one critical alert, the reason on the task, nothing sent, and every later pass writes nothing",
    async (version) => {
      const { host, driver } = await admitted();
      await addFailed(4);
      produce(host, "agent-b1");
      const policyBefore = JSON.stringify((await stored()).policy);
      await hook(host, driver, "agent-b1");

      const shut = await stored();
      // The report was taken in; the reviewer it would have gone to was not started.
      expect(states(shut).t1).toBe("review");
      expect(host.sent.map((entry) => entry.agentId)).toEqual(["agent-b1"]);
      expect(t1Of(shut)?.waitingReason).toBe(REASON);
      const alerts = gateAlerts(shut);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ severity: "critical", state: "open" });
      expect(alerts[0]?.summary).toContain("3 个");
      expect(alerts[0]?.summary).toContain("现有 4 个");
      expect(shut.alerts).toHaveLength(1);
      // Nothing about the record but the above changed: version, frozen policy, invariants.
      expect(shut.schemaVersion).toBe(version === "v1" ? 1 : 2);
      expect(JSON.stringify(shut.policy)).toBe(policyBefore);
      expect(checkLedgerInvariants(shut)).toEqual({ ok: true });

      // Asked again and again, by a kick or by the same hook delivered again: no write, no send.
      for (let round = 0; round < 5; round += 1) {
        const kicked = await driver.kick(RUN_ID);
        expect(kicked.dispatched).toBe(0);
        expect(kicked.last).toMatchObject({ status: "blocked", reason: "failed-task-limit" });
        await hook(host, driver, "agent-b1");
        expect((await stored()).revision).toBe(shut.revision);
      }
      expect(host.sent.map((entry) => entry.agentId)).toEqual(["agent-b1"]);
    },
  );

  test("what is already in flight is still taken in, and a report that must be repaired is still asked for again", async () => {
    const { host, driver } = await admitted();
    await addFailed(4);
    produce(host, "agent-b1");
    const good = host.lastReply("agent-b1");
    host.rewriteLastReply("agent-b1", (text) =>
      text.replace('"status":"done"', '"status":"done","summary":"extra key the schema refuses"'),
    );
    const before = host.sent.length;
    await hook(host, driver, "agent-b1");

    // The repair request goes out although the gate is shut: it is not new work.
    expect(host.sent).toHaveLength(before + 1);
    expect(host.lastSent("agent-b1")?.text).toContain("【重发身份 JSON】");
    expect(t1Of(await stored())).toMatchObject({ protocolFailures: 1, state: "assigned" });

    // The repaired report is accepted (the task moves on to review) but its reviewer waits for the gate.
    host.reply("agent-b1", good);
    await hook(host, driver, "agent-b1");
    const after = await stored();
    expect(states(after).t1).toBe("review");
    expect(host.sent).toHaveLength(before + 1);
    expect(t1Of(after)?.waitingReason).toBe(REASON);
    expect(gateAlerts(after)).toHaveLength(1);
  });

  test("a Run with failures over the limit and nothing left to start is left alone", async () => {
    const { driver } = await admitted();
    await addFailed(4);
    // t1 is with its producer and t2 waits for t1: there is nothing to dispatch, so nothing to refuse.
    const before = await stored();
    const kicked = await driver.kick(RUN_ID);
    expect(kicked.last.status).toBe("idle");
    const after = await stored();
    expect(after.alerts).toEqual([]);
    expect(after.revision).toBe(before.revision);
  });

  test("cancelling failed tasks until the count is back within the limit reopens dispatch and takes the alert down, once", async () => {
    const { host, driver } = await admitted();
    await addFailed(5);
    produce(host, "agent-b1");
    await hook(host, driver, "agent-b1");
    const shut = await stored();
    expect(gateAlerts(shut)).toHaveLength(1);
    expect(host.sent.map((entry) => entry.agentId)).toEqual(["agent-b1"]);

    // Five failed, one cancelled: four is still over three. The same reason, no second alert, nothing sent.
    await cancelFailed("f5");
    const still = await driver.kick(RUN_ID);
    expect(still.last).toMatchObject({ status: "blocked", reason: "failed-task-limit" });
    const stillShut = await stored();
    expect(gateAlerts(stillShut)).toHaveLength(1);
    expect(gateAlerts(stillShut)[0]?.state).toBe("open");
    expect(resolvedEvents(stillShut)).toHaveLength(0);
    expect(t1Of(stillShut)?.waitingReason).toBe(REASON);
    expect(host.sent.map((entry) => entry.agentId)).toEqual(["agent-b1"]);

    // Another one cancelled: three is within the limit. The reviewer goes out and the alert is resolved.
    await cancelFailed("f4");
    const open = await driver.kick(RUN_ID);
    expect(open.dispatched).toBe(1);
    expect(host.sent.map((entry) => entry.agentId)).toEqual(["agent-b1", "agent-b2"]);
    const reopened = await stored();
    expect(gateAlerts(reopened)).toHaveLength(1);
    expect(gateAlerts(reopened)[0]).toMatchObject({ state: "resolved" });
    expect(gateAlerts(reopened)[0]?.resolvedAt).not.toBeNull();
    expect(resolvedEvents(reopened)).toHaveLength(1);
    expect(t1Of(reopened)?.waitingReason ?? "").not.toContain("failed-task-limit");

    // From here on the Run is as quiet as one that never had the problem.
    judge(host, "agent-b2");
    await hook(host, driver, "agent-b2");
    const quiet = await stored();
    expect(resolvedEvents(quiet)).toHaveLength(1);
    expect(gateAlerts(quiet)[0]?.state).toBe("resolved");
    for (let round = 0; round < 3; round += 1) await driver.kick(RUN_ID);
    expect((await stored()).revision).toBe(quiet.revision);
  });

  test("a gate that opened and shut again raises the alert again", async () => {
    const { host, driver } = await admitted();
    await addFailed(4);
    produce(host, "agent-b1");
    await hook(host, driver, "agent-b1");
    await cancelFailed("f4");
    await driver.kick(RUN_ID);
    expect(gateAlerts(await stored())[0]?.state).toBe("resolved");
    expect(host.sent.map((entry) => entry.agentId)).toEqual(["agent-b1", "agent-b2"]);

    // The review passes; t2 is ready, and by then two more tasks have failed: five over three.
    await addFailed(2);
    judge(host, "agent-b2");
    await hook(host, driver, "agent-b2");
    const shut = await stored();
    expect(states(shut).t2).toBe("ready");
    expect(gateAlerts(shut)).toHaveLength(1);
    expect(gateAlerts(shut)[0]).toMatchObject({ state: "open", severity: "critical" });
    expect(host.sent.map((entry) => entry.agentId)).toEqual(["agent-b1", "agent-b2"]);
    expect(t1Of(shut)?.state).toBe("done");
    expect(shut.tasks.find((entry) => entry.spec.id === "t2")?.waitingReason).toBe(REASON);
  });

  test("a paused Run is not touched by the gate", async () => {
    const { host, driver } = await admitted();
    await addFailed(4);
    produce(host, "agent-b1");
    await store.update(RUN_ID, (current) => ({ ...structuredClone(current), lifecycle: "paused" }));
    await hook(host, driver, "agent-b1");
    const paused = await stored();
    expect(paused.lifecycle).toBe("paused");
    expect(gateAlerts(paused)).toEqual([]);
    expect(host.sent.map((entry) => entry.agentId)).toEqual(["agent-b1"]);
    for (let round = 0; round < 3; round += 1) await driver.kick(RUN_ID);
    expect((await stored()).revision).toBe(paused.revision);
  });

  test("a Run still waiting for its plan is not touched by the gate", async () => {
    const host = fakeHost();
    const driver = build(host);
    // No plan yet: the Run has no tasks, so the failed ones are put there directly.
    await addFailed(4);
    const before = await stored();
    expect(before.lifecycle).not.toBe("active");
    const kicked = await driver.kick(RUN_ID);
    expect(kicked.last.status).toBe("idle");
    const after = await stored();
    expect(gateAlerts(after)).toEqual([]);
    expect(after.revision).toBe(before.revision);
    expect(host.sent).toEqual([]);
  });
});

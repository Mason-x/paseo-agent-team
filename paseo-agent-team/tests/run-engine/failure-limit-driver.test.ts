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
import { PROFILE_HAIKU, spec, task } from "../fixtures/run-engine/base";
import {
  bootstrapRun,
  COORDINATOR_AGENT,
  dagBlock,
  PLAN_MESSAGE_ID,
  planTasks,
} from "./support/bootstrap-run";
import { JUDGE_SEAT_REVIEW, JUDGE_SEAT_SMOKE } from "./support/review-run";

/**
 * The failed-task gate in a whole Run: a real store, a real git repository, and the driver with the
 * hooks that tell it a turn ended. Failure modes:
 *  - a Run with more failed tasks than its policy allows still handing out work, or one at its limit
 *    refusing to;
 *  - the gate also shutting out what is already under way (a report, a repair request, a review, a
 *    smoke, an evidence supplement, a rework), or hiding it behind a task that has not started;
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
      if (seatId === JUDGE_SEAT_REVIEW || seatId === JUDGE_SEAT_SMOKE) {
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
function produce(host: Host, agentId: string, options: { evidenceId?: string } = {}): void {
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
        // A wrong id leaves the required evidence missing: the gate refuses it, the report is real.
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

type EvidenceFacts = Facts & {
  evidenceRepair: { delivery: { ref: unknown; workspace: unknown; changedFiles: string[] } };
};

/** The member answers an evidence request from its prompt: same delivery, the evidence now complete. */
function supplement(host: Host, agentId: string): void {
  const prompt = host.lastSent(agentId)?.text ?? "";
  const { messageId: _unused, ...identity } = section<Identity>(prompt, "【身份资料 JSON】");
  const facts = section<EvidenceFacts>(prompt, "【执行事实 JSON】");
  const data = section<TaskData>(prompt, "【任务资料 JSON】");
  const { ref, workspace, changedFiles } = facts.evidenceRepair.delivery;
  host.reply(
    agentId,
    fence("task-report", {
      ...identity,
      status: "done",
      changedFiles,
      ref,
      workspace,
      evidence: data.evidence.map((requirement) => ({
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

/** The smoker answers from its own prompt: the delivery and the DEV target it was given. */
function smoke(host: Host, agentId: string): void {
  const prompt = host.lastSent(agentId)?.text ?? "";
  const { messageId: _unused, ...identity } = section<Identity>(prompt, "【身份资料 JSON】");
  const facts = section<
    Facts & { devTarget: { devHost: string; devServerId: string; devHome: string } }
  >(prompt, "【执行事实 JSON】");
  host.reply(
    agentId,
    fence("smoke-report", {
      ...identity,
      testedRef: facts.delivery.deliveryRef,
      ...facts.devTarget,
      checks: [{ id: "health", result: "pass", evidencePath: `${facts.evidenceDir}/health.log` }],
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

/** A task that has not started, first in task order (what a failed task a person retried is, too). */
async function addReady(taskId: string): Promise<void> {
  await store.update(RUN_ID, (current) => {
    const next = structuredClone(current);
    next.tasks.unshift(task(taskId, "Not started yet", { state: "ready" }));
    return next;
  });
}

const sentTo = (host: Host) => host.sent.map((entry) => entry.agentId);

const gateAlerts = (record: RunRecord) =>
  record.alerts.filter((alert) => alert.summary.startsWith(FAILED_LIMIT_ALERT_PREFIX));
const resolvedEvents = (record: RunRecord) =>
  record.events.filter((event) => event.kind === "alert-resolved");
const t1Of = (record: RunRecord) => record.tasks.find((entry) => entry.spec.id === "t1");
const t2Of = (record: RunRecord) => record.tasks.find((entry) => entry.spec.id === "t2");

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
    "[%s] over the limit the review of a started task goes out, and the task that waited behind it is then held back: one critical alert, the reason on the task, nothing sent, later passes write nothing",
    async (version) => {
      const { host, driver } = await admitted();
      await addFailed(4);
      produce(host, "agent-b1");
      const policyBefore = JSON.stringify((await stored()).policy);
      await hook(host, driver, "agent-b1");

      // The report was taken in and its reviewer was started: the gate does not touch work under way.
      const reviewing = await stored();
      expect(states(reviewing).t1).toBe("review");
      expect(sentTo(host)).toEqual(["agent-b1", "agent-b2"]);
      expect(t1Of(reviewing)?.waitingReason ?? "").not.toContain("failed-task-limit");
      // Nothing is held back yet (t2 still waits for t1), so there is nothing to say either.
      expect(gateAlerts(reviewing)).toEqual([]);

      // The review passes: t2 is the next to start, and that is what the gate refuses.
      judge(host, "agent-b2");
      await hook(host, driver, "agent-b2");
      const shut = await stored();
      expect(states(shut)).toMatchObject({ t1: "done", t2: "ready" });
      expect(sentTo(host)).toEqual(["agent-b1", "agent-b2"]);
      expect(shut.tasks.find((entry) => entry.spec.id === "t2")?.waitingReason).toBe(REASON);
      const alerts = gateAlerts(shut);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ severity: "critical", state: "open" });
      // The limit is named; the number of failed tasks is not (the alert stays up while it changes).
      expect(alerts[0]?.summary).toContain("3 个");
      expect(alerts[0]?.summary).not.toContain("现有");
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
        await hook(host, driver, "agent-b2");
        expect((await stored()).revision).toBe(shut.revision);
      }
      expect(sentTo(host)).toEqual(["agent-b1", "agent-b2"]);
    },
  );

  test("what is already in flight is still taken in, a report that must be repaired is still asked for again, and the repaired delivery goes to its reviewer", async () => {
    const { host, driver } = await admitted();
    await addFailed(4);
    produce(host, "agent-b1");
    const good = host.lastReply("agent-b1");
    host.rewriteLastReply("agent-b1", (text) =>
      text.replace('"status":"done"', '"status":"done","summary":"extra key the schema refuses"'),
    );
    const before = host.sent.length;
    await hook(host, driver, "agent-b1");

    // The repair request goes out although the limit is exceeded: it is not new work.
    expect(host.sent).toHaveLength(before + 1);
    expect(host.lastSent("agent-b1")?.text).toContain("【重发身份 JSON】");
    expect(t1Of(await stored())).toMatchObject({ protocolFailures: 1, state: "assigned" });

    // The repaired report is accepted and its reviewer is started: the task is under way.
    host.reply("agent-b1", good);
    await hook(host, driver, "agent-b1");
    const after = await stored();
    expect(states(after).t1).toBe("review");
    expect(host.sent).toHaveLength(before + 2);
    expect(host.lastSent("agent-b2")).toBeDefined();
    expect(t1Of(after)?.waitingReason ?? "").not.toContain("failed-task-limit");
    expect(gateAlerts(after)).toEqual([]);
  });

  test("a task that has not started is held back without hiding the review of a started one behind it", async () => {
    const { host, driver } = await admitted();
    await addFailed(4);
    // g1 has not started and comes first in task order: the review of t1 must still be reached.
    await addReady("g1");
    produce(host, "agent-b1");
    await hook(host, driver, "agent-b1");

    const held = await stored();
    expect(states(held)).toMatchObject({ g1: "ready", t1: "review" });
    expect(sentTo(host)).toEqual(["agent-b1", "agent-b2"]);
    const alerts = gateAlerts(held);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: "critical", state: "open" });

    // The review passes; g1 and t2 are both waiting to start now, and neither is started.
    judge(host, "agent-b2");
    await hook(host, driver, "agent-b2");
    const shut = await stored();
    expect(states(shut)).toMatchObject({ g1: "ready", t1: "done", t2: "ready" });
    expect(sentTo(host)).toEqual(["agent-b1", "agent-b2"]);
    expect(gateAlerts(shut)).toHaveLength(1);
    for (let round = 0; round < 3; round += 1) {
      expect((await driver.kick(RUN_ID)).last).toMatchObject({
        status: "blocked",
        reason: "failed-task-limit",
      });
    }
    expect((await stored()).revision).toBe(shut.revision);
  });

  test.each([false, true])(
    "a review that sends a started task back for rework is followed by the producer although the limit is exceeded (not-started task alongside: %s)",
    async (withReady) => {
      const { host, driver } = await admitted();
      await addFailed(4);
      if (withReady) await addReady("g1");
      produce(host, "agent-b1");
      await hook(host, driver, "agent-b1");
      judge(host, "agent-b2", "修改后合入");
      await hook(host, driver, "agent-b2");

      const after = await stored();
      expect(states(after).t1).toBe("assigned");
      expect(t1Of(after)?.attempts).toBe(2);
      expect(host.lastSent("agent-b1")?.text).toContain("【返工说明】");
      expect(sentTo(host)).toEqual(["agent-b1", "agent-b2", "agent-b1"]);
      expect(t1Of(after)?.waitingReason ?? "").not.toContain("failed-task-limit");
      // Only the task that has not started is held back, and only that is reported.
      expect(gateAlerts(after)).toHaveLength(withReady ? 1 : 0);
      if (withReady) expect(states(after).g1).toBe("ready");
    },
  );

  test("[v2] a request to add missing evidence to a delivery is sent although the limit is exceeded, and the supplement goes on to review", async () => {
    const { host, driver } = await admitted();
    await addFailed(4);
    produce(host, "agent-b1", { evidenceId: "not-required" });
    await hook(host, driver, "agent-b1");

    const asked = await stored();
    expect(sentTo(host)).toEqual(["agent-b1", "agent-b1"]);
    expect(host.lastSent("agent-b1")?.text).toContain("补齐已有交付的证据");
    expect(t1Of(asked)).toMatchObject({ state: "assigned", evidenceReturns: 1 });
    expect(gateAlerts(asked)).toEqual([]);

    supplement(host, "agent-b1");
    await hook(host, driver, "agent-b1");
    expect(states(await stored()).t1).toBe("review");
    expect(sentTo(host)).toEqual(["agent-b1", "agent-b1", "agent-b2"]);
  });

  test("a smoke of a started task is sent although the limit is exceeded, and t2 after it is held back", async () => {
    const host = fakeHost();
    const driver = build(host);
    await store.update(RUN_ID, (current) => {
      current.roster.push({
        seatId: JUDGE_SEAT_SMOKE,
        tier: "B",
        agentId: "agent-m1",
        channelId: "claude",
        duties: ["smoke"],
        enabled: true,
      });
      current.budgets.entries.push({
        scope: "seat",
        subjectId: JUDGE_SEAT_SMOKE,
        limit: 6,
        reserved: 0,
        confirmed: 0,
        observedTurns: 0,
      });
      return current;
    });
    const scope = (file: string) => [
      { repoId: REPO_ALIAS, kind: "file", path: file, access: "write" },
    ];
    host.planRequestSent();
    host.reply(
      COORDINATOR_AGENT,
      fence(
        "task-dag",
        dagBlock(RUN_ID, [
          spec("t1", "Core API surface", {
            scopes: scope("src/t1.ts"),
            devSmoke: true,
            smokeChecklist: ["health"],
          }) as never,
          spec("t2", "Core implementation", { deps: ["t1"], scopes: scope("src/t2.ts") }) as never,
        ]),
      ),
    );
    await hook(host, driver, COORDINATOR_AGENT);
    await addFailed(4);
    produce(host, "agent-b1");
    await hook(host, driver, "agent-b1");
    judge(host, "agent-b2");
    await hook(host, driver, "agent-b2");

    // The review passed and the smoker is asked although four tasks failed against a limit of three.
    const smoking = await stored();
    expect(states(smoking)).toMatchObject({ t1: "review", t2: "pending" });
    expect(smoking.tasks[0]?.phase).toBe("smoke");
    expect(sentTo(host)).toEqual(["agent-b1", "agent-b2", "agent-m1"]);
    expect(gateAlerts(smoking)).toEqual([]);

    smoke(host, "agent-m1");
    await hook(host, driver, "agent-m1");
    const shut = await stored();
    expect(states(shut)).toMatchObject({ t1: "done", t2: "ready" });
    expect(sentTo(host)).toEqual(["agent-b1", "agent-b2", "agent-m1"]);
    expect(shut.tasks.find((entry) => entry.spec.id === "t2")?.waitingReason).toBe(REASON);
    expect(gateAlerts(shut)).toHaveLength(1);
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
    judge(host, "agent-b2");
    await hook(host, driver, "agent-b2");
    // t1 is done; t2, which waited for it, is the next to start, and the gate holds it back.
    const shut = await stored();
    expect(states(shut)).toMatchObject({ t1: "done", t2: "ready" });
    expect(gateAlerts(shut)).toHaveLength(1);
    expect(sentTo(host)).toEqual(["agent-b1", "agent-b2"]);

    // Five failed, one cancelled: four is still over three. The same reason, no second alert, nothing sent.
    await cancelFailed("f5");
    const still = await driver.kick(RUN_ID);
    expect(still.last).toMatchObject({ status: "blocked", reason: "failed-task-limit" });
    const stillShut = await stored();
    expect(gateAlerts(stillShut)).toHaveLength(1);
    expect(gateAlerts(stillShut)[0]?.state).toBe("open");
    expect(resolvedEvents(stillShut)).toHaveLength(0);
    expect(t2Of(stillShut)?.waitingReason).toBe(REASON);
    expect(sentTo(host)).toEqual(["agent-b1", "agent-b2"]);

    // Another one cancelled: three is within the limit. t2 goes out and the alert is resolved.
    await cancelFailed("f4");
    const open = await driver.kick(RUN_ID);
    expect(open.dispatched).toBe(1);
    expect(sentTo(host)).toEqual(["agent-b1", "agent-b2", "agent-b1"]);
    const reopened = await stored();
    expect(states(reopened).t2).toBe("assigned");
    expect(gateAlerts(reopened)).toHaveLength(1);
    expect(gateAlerts(reopened)[0]).toMatchObject({ state: "resolved" });
    expect(gateAlerts(reopened)[0]?.resolvedAt).not.toBeNull();
    expect(resolvedEvents(reopened)).toHaveLength(1);
    expect(t2Of(reopened)?.waitingReason ?? "").not.toContain("failed-task-limit");

    // From here on the Run is as quiet as one that never had the problem.
    for (let round = 0; round < 3; round += 1) await driver.kick(RUN_ID);
    const quiet = await stored();
    expect(quiet.revision).toBe(reopened.revision);
    expect(resolvedEvents(quiet)).toHaveLength(1);
    expect(gateAlerts(quiet)[0]?.state).toBe("resolved");
  });

  test("a gate that opened and shut again raises the alert again", async () => {
    const { host, driver } = await admitted();
    await addFailed(4);
    produce(host, "agent-b1");
    await hook(host, driver, "agent-b1");
    judge(host, "agent-b2");
    await hook(host, driver, "agent-b2");
    expect(gateAlerts(await stored())[0]?.state).toBe("open");
    await cancelFailed("f4");
    await driver.kick(RUN_ID);
    expect(gateAlerts(await stored())[0]?.state).toBe("resolved");
    expect(sentTo(host)).toEqual(["agent-b1", "agent-b2", "agent-b1"]);

    // t2 is with its producer; two more tasks have failed (five over three) and a new one is waiting.
    await addFailed(2);
    await addReady("g1");
    await driver.kick(RUN_ID);
    const shut = await stored();
    expect(states(shut)).toMatchObject({ t1: "done", t2: "assigned", g1: "ready" });
    expect(gateAlerts(shut)).toHaveLength(1);
    expect(gateAlerts(shut)[0]).toMatchObject({ state: "open", severity: "critical" });
    expect(sentTo(host)).toEqual(["agent-b1", "agent-b2", "agent-b1"]);
    expect(shut.tasks.find((entry) => entry.spec.id === "g1")?.waitingReason).toBe(REASON);
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

  // --- the alert of a Run that is paused while the failed tasks are cleared (T6a) ---------------

  /** The gate is shut (five failed over three, t2 held back, the alert open); then `cancelled` of them are cancelled. */
  async function gateShutThenCancelled(cancelled: number): Promise<{ host: Host; driver: Driver }> {
    const { host, driver } = await admitted();
    await addFailed(5);
    produce(host, "agent-b1");
    await hook(host, driver, "agent-b1");
    judge(host, "agent-b2");
    await hook(host, driver, "agent-b2");
    const shut = await stored();
    expect(states(shut)).toMatchObject({ t1: "done", t2: "ready" });
    expect(gateAlerts(shut)).toHaveLength(1);
    expect(gateAlerts(shut)[0]).toMatchObject({ state: "open" });
    for (const taskId of ["f5", "f4", "f3"].slice(0, cancelled)) await cancelFailed(taskId);
    return { host, driver };
  }

  const setLifecycle = (lifecycle: RunRecord["lifecycle"]) =>
    store.update(RUN_ID, (current) => ({ ...structuredClone(current), lifecycle }));

  test.each(["v1", "v2"] as const)(
    "[%s] a paused Run whose failed tasks were cancelled back within the limit has the alert taken down once, and neither resumes nor sends",
    async (version) => {
      const { host, driver } = await gateShutThenCancelled(2);
      await setLifecycle("paused");
      const sentBefore = [...sentTo(host)];
      const before = await stored();
      expect(before.alerts.filter((alert) => alert.state !== "resolved")).toHaveLength(1);

      const kicked = await driver.kick(RUN_ID);
      expect(kicked.last.status).toBe("idle");
      const after = await stored();
      const alerts = gateAlerts(after);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ state: "resolved" });
      expect(alerts[0]?.resolvedAt).not.toBeNull();
      expect(resolvedEvents(after)).toHaveLength(1);
      // The Run is as paused as it was: the held task is not started, nothing is sent.
      expect(after.lifecycle).toBe("paused");
      expect(states(after)).toMatchObject({ t1: "done", t2: "ready" });
      expect(sentTo(host)).toEqual(sentBefore);
      expect(after.schemaVersion).toBe(version === "v1" ? 1 : 2);
      expect(checkLedgerInvariants(after)).toEqual({ ok: true });

      // Once is once: asking again (a kick, a hook) writes nothing more.
      for (let round = 0; round < 3; round += 1) await driver.kick(RUN_ID);
      await hook(host, driver, "agent-b2");
      const quiet = await stored();
      expect(quiet.revision).toBe(after.revision);
      expect(resolvedEvents(quiet)).toHaveLength(1);
      expect(quiet.lifecycle).toBe("paused");
      expect(sentTo(host)).toEqual(sentBefore);
    },
  );

  test.each(["v1", "v2"] as const)(
    "[%s] a paused Run still over the failed-task limit keeps its alert open, and later passes write nothing",
    async () => {
      const { host, driver } = await gateShutThenCancelled(1);
      await setLifecycle("paused");
      const before = await stored();
      for (let round = 0; round < 3; round += 1) await driver.kick(RUN_ID);
      const after = await stored();
      expect(gateAlerts(after)).toHaveLength(1);
      expect(gateAlerts(after)[0]).toMatchObject({ state: "open" });
      expect(resolvedEvents(after)).toHaveLength(0);
      expect(after.revision).toBe(before.revision);
      expect(sentTo(host)).toEqual(["agent-b1", "agent-b2"]);
    },
  );

  test.each(["v1", "v2"] as const)(
    "[%s] an idle paused Run, one that never had the alert, is not written to",
    async () => {
      const { driver } = await admitted();
      await setLifecycle("paused");
      const before = await stored();
      expect(before.alerts).toEqual([]);
      for (let round = 0; round < 4; round += 1) await driver.kick(RUN_ID);
      const after = await stored();
      expect(after.revision).toBe(before.revision);
      expect(after.alerts).toEqual([]);
      expect(after.lifecycle).toBe("paused");
    },
  );

  test.each([
    ["v1", "finished"],
    ["v1", "cancelled"],
    ["v2", "finished"],
    ["v2", "cancelled"],
  ] as const)(
    "[%s] a %s Run is not touched: its open failed-task alert stays as it was",
    async (_version, lifecycle) => {
      const { driver } = await gateShutThenCancelled(2);
      await setLifecycle(lifecycle);
      const before = await stored();
      for (let round = 0; round < 3; round += 1) await driver.kick(RUN_ID);
      const after = await stored();
      expect(after.lifecycle).toBe(lifecycle);
      expect(gateAlerts(after)).toHaveLength(1);
      expect(gateAlerts(after)[0]).toMatchObject({ state: "open" });
      expect(resolvedEvents(after)).toHaveLength(0);
      expect(after.revision).toBe(before.revision);
    },
  );

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

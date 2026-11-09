import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createRunControl } from "../../server/run-engine/control";
import { createDagIntake } from "../../server/run-engine/dag";
import { createEngineDriver } from "../../server/run-engine/driver";
import { createEffects } from "../../server/run-engine/effects";
import { createObserverHost } from "../../server/run-engine/host";
import { createIntake } from "../../server/run-engine/intake";
import { createRunObserver } from "../../server/run-engine/observer";
import { createEngineService } from "../../server/run-engine/service";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import { REPO_ALIAS } from "../../shared/domain/run-engine/dag-admission";
import {
  buildPlanSeats,
  compileEngineIntent,
  planRequestFacts,
} from "../../shared/domain/run-engine/engine-prompts";
import { compileDispatch } from "../../shared/domain/run-engine/prompt-template";
import { emptyReadRetries } from "../../shared/domain/run-engine/read-retry";
import type { PaseoEnginePort, PortTimelinePage } from "../../shared/paseo/port";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import {
  bootstrapRun,
  COORDINATOR_AGENT,
  dagBlock,
  PLAN_MESSAGE_ID,
  planTasks,
} from "./support/bootstrap-run";
import { ROLE } from "./support/plan-fixtures";

/**
 * T9e, through the paths production takes: the host stopped while the coordinator planned. It sent the
 * `turn_ended` of the planning turn (the plugin could not read the reply then), and after the restart the
 * plan request is not in the coordinator's history. Recovery reads the reply once, leaves one warning and
 * moves the Run to awaiting-dag; a person's re-plan then asks the coordinator once and its new plan is
 * admitted. Run on a v1 and on a v2 ledger.
 */

const RUN_ID = "run-planlost-a1";
const LOST_ALERT = "DAG 缺失：宿主可能在协调者规划时重启，计划回复已丢失，请点重新规划";

let home: string;
let repoDir: string;
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

type PortTimelineEntry = PortTimelinePage["entries"][number];

function fakeHost() {
  const timelines = new Map<string, PortTimelineEntry[]>();
  const turns = new Map<string, string>();
  const sent: { agentId: string; text: string; messageId: string }[] = [];
  const flags = { failReads: false };
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
  const port: PaseoEnginePort = {
    agents: {
      ref: (agentId) => ({
        send: async (text, options) => {
          const messageId = options?.messageId ?? "";
          sent.push({ agentId, text, messageId });
          add(agentId, `turn-${agentId}-${sent.length}`, { type: "user_message", messageId });
        },
        archive: async () => undefined,
        timeline: {
          refetch: async () => {
            if (flags.failReads) throw new Error("the host is stopping");
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
        current: () => ({ status: "idle", activeTurn: null }),
        refresh: async () => {
          const last = entries(agentId).at(-1);
          const busy = last?.item.type === "user_message";
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
    failReads: (value: boolean) => {
      flags.failReads = value;
    },
    /** The host restarted and lost the history of an agent, the turn it was in included. */
    dropTimeline: (agentId: string) => {
      timelines.set(agentId, []);
    },
    /** The newest message sent to the agent is in its history again, in a turn of its own. */
    echoLastSent: (agentId: string) => {
      const last = [...sent].reverse().find((entry) => entry.agentId === agentId);
      if (last)
        add(agentId, `turn-${agentId}-echo`, { type: "user_message", messageId: last.messageId });
    },
    planRequestSent: () =>
      add(COORDINATOR_AGENT, "turn-plan", { type: "user_message", messageId: PLAN_MESSAGE_ID }),
    reply: (agentId: string, text: string) =>
      add(agentId, turns.get(agentId) ?? "turn-plan", { type: "assistant_message", text }),
    turnOf: (agentId: string) => turns.get(agentId) ?? "turn-plan",
    lastSent: (agentId: string) => [...sent].reverse().find((entry) => entry.agentId === agentId),
  };
}

type Host = ReturnType<typeof fakeHost>;

/** What the plugin wires, over the test's store and host. A second call is a plugin that started again. */
function build(host: Host) {
  const observerHost = createObserverHost(host.port);
  const observer = createRunObserver({ store });
  const effects = createEffects({ store, port: host.port, compile: compileEngineIntent });
  const resolveWorkspace = () => ({ workspaceId: "ws-start", directory: repoDir });
  const service = createEngineService({
    store,
    port: host.port,
    effects,
    resolveSeat: () => null,
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
    outbox: { run: (runId) => effects.runOutbox(runId) },
    reconcileHost: createObserverHost(host.port, { requireIdle: true }),
  });
  const control = createRunControl({ store, ensureReady: async () => undefined, driver });
  return { driver, control };
}

async function stored(): Promise<RunRecord> {
  const read = await store.get(RUN_ID);
  if (read.status !== "ok") throw new Error(`run unreadable: ${read.status}`);
  return read.record;
}

function section<T>(text: string, label: string): T {
  const lines = text.split("\n");
  const index = lines.indexOf(label);
  if (index < 0) throw new Error(`no section ${label} in the prompt`);
  return JSON.parse(lines[index + 1] ?? "") as T;
}

const plan = (nonce?: string) =>
  `Plan.\n\`\`\`task-dag\n${JSON.stringify(
    dagBlock(RUN_ID, planTasks(REPO_ALIAS), nonce === undefined ? {} : { nonce }),
  )}\n\`\`\`\n`;

const request = (expectedRevision: number) => ({
  runContractVersion: 1 as const,
  runId: RUN_ID,
  requestId: "req-1",
  expectedRevision,
  reason: "the host restarted while you planned",
});

describe.each([1, 2] as const)("a plan reply lost to a host restart (ledger v%i)", (version) => {
  beforeEach(async () => {
    home = await realpath(await mkdtemp(path.join(tmpdir(), "run-planlost-")));
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
        controlNonce: planIntent.semanticArgs.controlNonce,
      };
    }
    record.schemaVersion = version;
    if (version === 2) (record as Record<string, unknown>).readRetries = emptyReadRetries();
    await store.create(record);
  });

  afterEach(async () => {
    await store.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  /** The planning turn begins, the host stops (its `turn_ended` is recorded, the reply cannot be read), restarts. */
  async function restartUnderPlanning(host: Host) {
    const before = build(host);
    host.planRequestSent();
    await before.driver.onHook({
      name: "agent.turn_started",
      agentId: COORDINATOR_AGENT,
      turnId: "turn-plan",
    });
    host.failReads(true);
    await before.driver.onHook({
      name: "agent.turn_ended",
      agentId: COORDINATOR_AGENT,
      turnId: "turn-plan",
    });
    // The plugin could not read the reply while the host went down: nothing is written for it.
    const stopping = await stored();
    expect(stopping.lifecycle).toBe("bootstrapping");
    expect(stopping.alerts).toEqual([]);
    host.failReads(false);
    host.dropTimeline(COORDINATOR_AGENT);
    return build(host);
  }

  test("recovery leaves one warning and the Run waits for a re-plan; hooks and recoveries after it write nothing; the re-plan is asked once and its plan is admitted", async () => {
    const host = fakeHost();
    const restarted = await restartUnderPlanning(host);

    expect(await restarted.driver.recover()).toEqual({ runs: 1 });
    const waiting = await stored();
    expect(waiting.lifecycle).toBe("awaiting-dag");
    expect(waiting.alerts).toHaveLength(1);
    expect(waiting.alerts[0]).toMatchObject({
      state: "open",
      severity: "warning",
      summary: LOST_ALERT,
    });
    // Nothing was sent to anyone: no format re-send, no new request.
    expect(host.sent).toHaveLength(0);
    expect(waiting.outbox.filter((intent) => intent.kind === "wake")).toHaveLength(1);

    // The same again, by recovery, by a kick, by a person's retry: no new write.
    await restarted.driver.recover();
    await restarted.driver.kick(RUN_ID);
    await restarted.driver.retryRun(RUN_ID);
    const quiet = await stored();
    expect(quiet.revision).toBe(waiting.revision);
    expect(quiet.alerts).toHaveLength(1);
    expect(host.sent).toHaveLength(0);

    // The person asks for a re-plan: the coordinator gets exactly one request, under a new nonce.
    const out = await restarted.control.replan(request(quiet.revision));
    expect(out).toMatchObject({ status: "applied", epoch: 2 });
    await restarted.control.idle();
    const replanned = await stored();
    expect(replanned.lifecycle).toBe("bootstrapping");
    expect(replanned.alerts.filter((alert) => alert.state === "open")).toEqual([]);
    expect(host.sent.map((entry) => entry.agentId)).toEqual([COORDINATOR_AGENT]);
    const text = host.lastSent(COORDINATOR_AGENT)?.text ?? "";
    // The coordinator is shown why the last plan did not count, in the program's own words.
    expect(text).toContain("计划回复已丢失");
    const nonce = section<{ nonce: string }>(text, "【控制身份 JSON】").nonce;

    // The new request is not answered yet. The end of the old planning turn is older than it, so a read that
    // cannot find the new request (the host lost it too) is no finding: the warning is not raised again.
    host.dropTimeline(COORDINATOR_AGENT);
    await restarted.driver.recover();
    const unanswered = await stored();
    expect(unanswered.lifecycle).toBe("bootstrapping");
    expect(unanswered.alerts.filter((alert) => alert.state === "open")).toEqual([]);
    expect(unanswered.revision).toBe(replanned.revision);
    // The coordinator did get it after all: the request is in its history again, and it answers.
    host.echoLastSent(COORDINATOR_AGENT);

    host.reply(COORDINATOR_AGENT, plan(nonce));
    await restarted.driver.onHook({
      name: "agent.turn_ended",
      agentId: COORDINATOR_AGENT,
      turnId: host.turnOf(COORDINATOR_AGENT),
    });
    const active = await stored();
    expect(active.lifecycle).toBe("active");
    expect(active.tasks.map((task) => task.spec.id)).toEqual(["t1", "t2"]);
    expect(active.alerts.filter((alert) => alert.state === "open")).toEqual([]);
  });

  test("the warning comes at once when the plugin can read the reply as the turn ends", async () => {
    const host = fakeHost();
    const driver = build(host).driver;
    host.planRequestSent();
    await driver.onHook({
      name: "agent.turn_started",
      agentId: COORDINATOR_AGENT,
      turnId: "turn-plan",
    });
    host.dropTimeline(COORDINATOR_AGENT);
    await driver.onHook({
      name: "agent.turn_ended",
      agentId: COORDINATOR_AGENT,
      turnId: "turn-plan",
    });
    const waiting = await stored();
    expect(waiting.lifecycle).toBe("awaiting-dag");
    expect(waiting.alerts).toHaveLength(1);
    expect(waiting.alerts[0]?.summary).toBe(LOST_ALERT);
    expect(host.sent).toHaveLength(0);

    // The host's hook arrives again: it is a duplicate, and settling it writes nothing more.
    await driver.onHook({
      name: "agent.turn_ended",
      agentId: COORDINATOR_AGENT,
      turnId: "turn-plan",
    });
    const again = await stored();
    expect(again.revision).toBe(waiting.revision);
    expect(again.alerts).toHaveLength(1);
  });

  test("a coordinator that began a new turn after the restart is waited for, not reported lost", async () => {
    const host = fakeHost();
    const restarted = await restartUnderPlanning(host);
    // The coordinator is working again (a person spoke to it): its own end of that turn is not here yet.
    await restarted.driver.onHook({
      name: "agent.turn_started",
      agentId: COORDINATOR_AGENT,
      turnId: "turn-after-restart",
    });
    const before = await stored();
    await restarted.driver.recover();
    const after = await stored();
    expect(after.lifecycle).toBe("bootstrapping");
    expect(after.alerts).toEqual([]);
    expect(after.revision).toBe(before.revision);
  });
});

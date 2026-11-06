import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createEngineRuntime, seatSourceOf } from "../../server/run-engine/runtime";
import type { EngineStartInput } from "../../server/run-engine/start";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import { buildLaunchPlan, type LaunchPlan } from "../../shared/domain/launch-plan";
import { COORDINATOR_SEAT_ID, REPO_ALIAS } from "../../shared/domain/run-engine/dag-admission";
import { readLaunchWorkspace } from "../../shared/domain/run-engine/run-record";
import type { CreateMemberInput } from "../../shared/paseo/adapter";
import type { PaseoEnginePort, PaseoPort, PortTimelinePage } from "../../shared/paseo/port";
import type { RunTeamEngineConfig } from "../../shared/schemas/run-engine/config";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import {
  allAvailable,
  architect,
  claudeOpus,
  codexXhigh,
  codingTeam,
  developer,
  techLead,
} from "../fixtures";
import { policy } from "../fixtures/run-engine/base";
import { dagBlock, planTasks } from "./support/bootstrap-run";

/**
 * The production wiring, end to end, on a real store and a real git repository with fake agents:
 * start an Engine Run through the launch host, let the coordinator answer, and watch a hook (or,
 * after a restart, only the first sight of a Paseo handle) admit the plan and dispatch the first
 * task to the seat the Run was frozen with. Failure modes:
 *  - a seat or Workspace the Run froze at start that the dispatch side cannot read back;
 *  - a coordinator's plan that only a live hook can admit, so a restart strands the Run;
 *  - the Engine dispatching to its own coordinator seat.
 */

const RUN_ID = "run-wire01-a1";

let home: string;
let paseoHome: string;
let repoDir: string;
let store: RunStore;
let plan: LaunchPlan;
let engine: RunTeamEngineConfig;

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.name=probe", "-c", "user.email=probe@example.invalid", ...args],
    { cwd, windowsHide: true, stdio: "ignore" },
  );
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), "run-runtime-")));
  repoDir = path.join(home, "repo");
  await mkdir(path.join(repoDir, "src"), { recursive: true });
  git(repoDir, "init", "-q", "-b", "main");
  await writeFile(path.join(repoDir, "src", "t1.ts"), "export {};\n");
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "-q", "-m", "base");
  paseoHome = path.join(home, "paseo");
  await mkdir(paseoHome);
  await writeFile(path.join(paseoHome, "server-id"), "srv-dev-1\n");
  store = createRunStore({ home: paseoHome, lock: { acquireTimeoutMs: 300 } });
  await store.initialize();

  plan = buildLaunchPlan({
    team: codingTeam,
    roles: [techLead, architect, developer],
    profiles: [claudeOpus, codexXhigh],
    availability: allAvailable,
    workspaceId: "ws-start",
    task: "Add a login page.",
    runId: RUN_ID,
    maxMembers: 8,
  });
  const [first, second] = plan.seats;
  if (!first || !second) throw new Error("fixture plan lost its seats");
  engine = {
    version: 1,
    enabled: true,
    seats: [
      {
        seatId: first.logicalSeatId,
        tier: "A",
        duties: ["review"],
        channelId: "claude",
        enabled: true,
      },
      {
        seatId: second.logicalSeatId,
        tier: "B",
        duties: ["implement"],
        channelId: "codex",
        enabled: true,
      },
    ],
    policy: policy({
      seatBudgets: [first.logicalSeatId, second.logicalSeatId].map((subjectId) => ({
        scope: "seat" as const,
        subjectId,
        limit: 6,
        reserved: 0,
        confirmed: 0,
        observedTurns: 0,
      })),
      evidenceRoot: "auto",
    }),
  };
});

afterEach(async () => {
  await store.close().catch(() => undefined);
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

// --- a host whose agents have timelines the test writes ------------------------------------------

type Entry = PortTimelinePage["entries"][number];

function fakeHost() {
  const byKey = new Map<string, string>();
  const timelines = new Map<string, Entry[]>();
  const turns = new Map<string, string>();
  const sent: { agentId: string; text: string; messageId: string }[] = [];
  /** Agents whose turn is still running, as the host's live snapshot reports it. */
  const busy = new Set<string>();
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
  const add = (agentId: string, turnId: string, item: Entry["item"]) => {
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
            reads += 1;
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
        refresh: async () => ({
          agent: busy.has(agentId)
            ? { status: "running", activeTurn: { id: "turn" } }
            : { status: "idle", activeTurn: null },
        }),
      }),
    },
  };
  const adapter = {
    createAgent: async (request: CreateMemberInput) => {
      const key = request.idempotencyKey ?? "";
      const agentId = byKey.get(key) ?? `agent-${byKey.size + 1}`;
      byKey.set(key, agentId);
      return { agentId };
    },
    archiveAgent: async () => undefined,
  };
  return {
    port,
    adapter,
    sent,
    busy,
    /** How many timeline reads the Engine made. */
    reads: () => reads,
    reply: (agentId: string, text: string) =>
      add(agentId, turns.get(agentId) ?? "turn-none", { type: "assistant_message", text }),
    turnOf: (agentId: string) => turns.get(agentId) ?? "turn-none",
  };
}

type Host = ReturnType<typeof fakeHost>;

function runtime(options: { supported?: boolean; identityOk?: boolean } = {}) {
  return createEngineRuntime({
    store,
    ensureReady: async () => undefined,
    // The machine's own git config must not decide these tests.
    commitIdentity: async () =>
      options.identityOk === false ? { ok: false, detail: "no committer" } : { ok: true },
    env: {
      PASEO_HOME: paseoHome.replaceAll("\\", "/"),
      ...(options.supported === false ? {} : { PASEO_AGENT_TEAM_RUN_ENGINE: "1" }),
    },
    log: vi.fn(),
  });
}

function startInput(): Omit<EngineStartInput, "serverId" | "paseoHome"> {
  return {
    plan,
    roles: [techLead, architect, developer],
    engine,
    workspaceDirectory: repoDir,
    requestId: RUN_ID,
    requestHash: "a".repeat(64),
    planHash: "b".repeat(64),
    maxMembers: 8,
    archiveOnLaunchFailure: true,
  };
}

async function stored(): Promise<RunRecord> {
  const read = await store.get(RUN_ID);
  if (read.status !== "ok") throw new Error(`run unreadable: ${read.status}`);
  return read.record;
}

/** The coordinator's answer to the plan request: a valid DAG, signed with the nonce it was given. */
async function coordinatorPlans(host: Host, coordinatorId: string): Promise<void> {
  const record = await stored();
  const request = record.outbox.find((intent) => intent.kind === "wake");
  const nonce = String(request?.semanticArgs.controlNonce);
  const block = dagBlock(RUN_ID, planTasks(REPO_ALIAS), { nonce });
  host.reply(coordinatorId, `Plan.\n\`\`\`task-dag\n${JSON.stringify(block)}\n\`\`\`\n`);
}

const states = (record: RunRecord) =>
  Object.fromEntries(record.tasks.map((task) => [task.spec.id, task.state]));

describe("the launch host", () => {
  test("is supported only when the daemon sets PASEO_AGENT_TEAM_RUN_ENGINE=1", () => {
    expect(runtime().launchHost.supported).toBe(true);
    expect(runtime({ supported: false }).launchHost.supported).toBe(false);
    const other = createEngineRuntime({
      store,
      ensureReady: async () => undefined,
      env: { PASEO_HOME: paseoHome, PASEO_AGENT_TEAM_RUN_ENGINE: "true" },
    });
    expect(other.launchHost.supported).toBe(false);
  });

  test("reads the daemon's server id from PASEO_HOME, and says why when it cannot", async () => {
    expect(await runtime().launchHost.identity()).toEqual({
      ok: true,
      serverId: "srv-dev-1",
      paseoHome: paseoHome.replaceAll("\\", "/"),
    });

    const missing = createEngineRuntime({
      store,
      ensureReady: async () => undefined,
      env: { PASEO_AGENT_TEAM_RUN_ENGINE: "1" },
    });
    expect(await missing.launchHost.identity()).toEqual({ ok: false, reason: "home-unavailable" });
    const relative = createEngineRuntime({
      store,
      ensureReady: async () => undefined,
      env: { PASEO_HOME: "relative/home" },
    });
    expect(await relative.launchHost.identity()).toEqual({
      ok: false,
      reason: "home-unavailable",
    });

    await rm(path.join(paseoHome, "server-id"));
    expect(await runtime().launchHost.identity()).toEqual({
      ok: false,
      reason: "server-id-unavailable",
    });
  });

  test("an unreadable server id stops the start before any agent exists", async () => {
    await rm(path.join(paseoHome, "server-id"));
    const host = fakeHost();
    const created = vi.spyOn(host.adapter, "createAgent");
    const result = await runtime().launchHost.start(
      startInput(),
      host.port as unknown as PaseoPort,
      host.adapter,
    );
    expect(result).toMatchObject({ ok: false, step: "preflight", detail: "server-id-unavailable" });
    expect(created).not.toHaveBeenCalled();
    expect((await store.get(RUN_ID)).status).not.toBe("ok");
  });

  test("a Workspace git cannot commit in stops the start before any agent exists", async () => {
    const host = fakeHost();
    const created = vi.spyOn(host.adapter, "createAgent");
    const wired = runtime({ identityOk: false });
    expect(await wired.launchHost.commitIdentity(repoDir)).toEqual({
      ok: false,
      detail: "no committer",
    });
    const result = await wired.launchHost.start(
      startInput(),
      host.port as unknown as PaseoPort,
      host.adapter,
    );
    expect(result).toMatchObject({ ok: false, step: "preflight", detail: "no committer" });
    expect(created).not.toHaveBeenCalled();
    expect((await store.get(RUN_ID)).status).not.toBe("ok");
  });

  test("an uninitialized ledger is reported, not written around", async () => {
    const closed = createRunStore({ home: path.join(home, "other"), log: vi.fn() });
    const result = await createEngineRuntime({
      store: closed,
      ensureReady: async () => undefined,
      env: { PASEO_HOME: paseoHome.replaceAll("\\", "/") },
    }).launchHost.identity();
    expect(result).toEqual({ ok: false, reason: "ledger-unavailable" });
  });
});

describe("a Run started through the launch host", () => {
  test("freezes its Workspace, and the coordinator's plan is admitted by a hook and dispatched", async () => {
    const host = fakeHost();
    const wired = runtime();
    const started = await wired.launchHost.start(
      startInput(),
      host.port as unknown as PaseoPort,
      host.adapter,
    );
    if (!started.ok) throw new Error(`start failed: ${started.message} ${started.detail}`);
    expect(started.launchState).toBe("running");
    await wired.recover();

    const first = await stored();
    expect(readLaunchWorkspace(first)).toEqual({ id: "ws-start", directory: repoDir });
    expect(first.hostBinding.serverId).toBe("srv-dev-1");
    // Exactly the plan request went out, to the coordinator.
    expect(host.sent.map((entry) => entry.agentId)).toEqual([started.coordinatorId]);

    await coordinatorPlans(host, started.coordinatorId);
    await wired.onHook(
      {
        name: "agent.turn_ended",
        agentId: started.coordinatorId,
        turnId: host.turnOf(started.coordinatorId),
        outcome: { kind: "completed" },
      },
      host.port,
    );

    const after = await stored();
    expect(after.lifecycle).toBe("active");
    expect(states(after)).toEqual({ t1: "assigned", t2: "pending" });
    const [seatB] = after.roster.filter((seat) => seat.duties.includes("implement"));
    // The producer is the implementing seat, never the coordinator, and it got the task prompt.
    expect(host.sent).toHaveLength(2);
    expect(host.sent[1]?.agentId).toBe(seatB?.agentId);
    expect(host.sent[1]?.agentId).not.toBe(started.coordinatorId);
    expect(host.sent[1]?.text).toContain("t1");
    expect(after.assignments.map((assignment) => assignment.seatId)).not.toContain(
      COORDINATOR_SEAT_ID,
    );
  });

  test("a coordinator reply whose hook was lost is picked up on the first sight of a Paseo handle", async () => {
    const host = fakeHost();
    const before = runtime();
    const started = await before.launchHost.start(
      startInput(),
      host.port as unknown as PaseoPort,
      host.adapter,
    );
    if (!started.ok) throw new Error("start failed");
    // The coordinator is writing its plan; the first recovery must not call that turn finished.
    host.busy.add(started.coordinatorId);
    await before.recover();
    const early = await stored();
    expect(early.lifecycle).toBe("bootstrapping");
    expect(early.alerts).toEqual([]);

    // The plugin restarts: the reply lands while nothing listens, and no hook is ever delivered.
    await coordinatorPlans(host, started.coordinatorId);
    const restarted = runtime();
    restarted.bind(host.port);
    await restarted.recover();
    expect((await stored()).lifecycle).toBe("bootstrapping");

    host.busy.delete(started.coordinatorId);
    await restarted.recover();
    const after = await stored();
    expect(after.lifecycle).toBe("active");
    expect(states(after)).toEqual({ t1: "assigned", t2: "pending" });
    expect(host.sent).toHaveLength(2);
  });

  test("a second sight of a handle does not recover again", async () => {
    const host = fakeHost();
    const wired = runtime();
    const recover = vi.spyOn(wired.driver, "recover");
    wired.bind(host.port);
    wired.bind(host.port);
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(recover).toHaveBeenCalledTimes(1);
  });
});

describe("a hook before there is anything to do", () => {
  test("is recorded or ignored without a Paseo call and without throwing", async () => {
    const host = fakeHost();
    const wired = runtime();
    await wired.onHook({ name: "agent.created", agentId: "agent-unknown" }, host.port);
    await wired.recover();
    expect(host.sent).toEqual([]);
    expect(host.reads()).toBe(0);
  });
});

describe("seatSourceOf", () => {
  test("reads the frozen Profile and the roster order, never the host", async () => {
    const host = fakeHost();
    const started = await runtime().launchHost.start(
      startInput(),
      host.port as unknown as PaseoPort,
      host.adapter,
    );
    if (!started.ok) throw new Error("start failed");
    const record = await stored();
    const seat = record.roster.find((entry) => entry.duties.includes("implement"));
    const source = seatSourceOf(record, seat?.seatId ?? "");
    expect(source).toMatchObject({
      available: true,
      profile: { provider: "codex" },
      order: record.roster.findIndex((entry) => entry.seatId === seat?.seatId),
    });
    expect(seatSourceOf(record, "no-such-seat")).toBeNull();
  });
});

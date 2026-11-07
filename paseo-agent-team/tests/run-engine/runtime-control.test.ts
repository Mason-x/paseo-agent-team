import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { payloadHash } from "../../server/run-engine/effects";
import { createEngineRuntime } from "../../server/run-engine/runtime";
import type { EngineStartInput } from "../../server/run-engine/start";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import { buildLaunchPlan, type LaunchPlan } from "../../shared/domain/launch-plan";
import { REPO_ALIAS } from "../../shared/domain/run-engine/dag-admission";
import {
  compilePlanRequest,
  PLAN_REPLAN_VERSION,
} from "../../shared/domain/run-engine/engine-prompts";
import { requestReplan } from "../../shared/domain/run-engine/replan";
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
 * The controls through the production wiring (P06): the runtime's own driver, outbox executor and
 * prompt compiler over a real store and a real git repository, with fake agents. Failure modes:
 *  - a re-plan request the production executor cannot rebuild and so never sends;
 *  - a request left prepared by a stop that the next process never sends (the recovery did not run the
 *    outbox), or sends twice;
 *  - the control being built from a different driver than the one the hooks use.
 */

const RUN_ID = "run-wire02-a1";

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

const states = (record: RunRecord) =>
  Object.fromEntries(record.tasks.map((task) => [task.spec.id, task.state]));

const replanInput = (expectedRevision: number, over: Record<string, unknown> = {}) => ({
  runContractVersion: 1 as const,
  runId: RUN_ID,
  requestId: "req-1",
  expectedRevision,
  reason: "use the workspace alias",
  ...over,
});

/** A plan the checks refuse for what it says: it names a repository that is not this Run's. */
async function coordinatorPlansWrong(host: Host, coordinatorId: string): Promise<void> {
  const record = await stored();
  const request = record.outbox.find((intent) => intent.kind === "wake");
  const nonce = String(request?.semanticArgs.controlNonce);
  const block = dagBlock(RUN_ID, planTasks("repo-elsewhere"), { nonce });
  host.reply(
    coordinatorId,
    `Plan.
\`\`\`task-dag
${JSON.stringify(block)}
\`\`\`
`,
  );
}

async function startAndRefuse(host: Host, wired: ReturnType<typeof runtime>) {
  const started = await wired.launchHost.start(
    startInput(),
    host.port as unknown as PaseoPort,
    host.adapter,
  );
  if (!started.ok) throw new Error(`start failed: ${started.message} ${started.detail}`);
  await wired.recover();
  await coordinatorPlansWrong(host, started.coordinatorId);
  await wired.onHook(
    {
      name: "agent.turn_ended",
      agentId: started.coordinatorId,
      turnId: host.turnOf(started.coordinatorId),
      outcome: { kind: "completed" },
    },
    host.port,
  );
  expect((await stored()).lifecycle).toBe("awaiting-dag");
  return started;
}

describe("replan through the production wiring", () => {
  test("a refused plan is asked for again under a new nonce, and the new plan starts the Run", async () => {
    const host = fakeHost();
    const wired = runtime();
    const started = await startAndRefuse(host, wired);
    expect(host.sent).toHaveLength(1);
    const waiting = await stored();

    const out = await wired.control.replan(replanInput(waiting.revision));
    expect(out).toMatchObject({ status: "applied", epoch: 2 });
    await wired.control.idle();
    expect(host.sent.map((entry) => entry.agentId)).toEqual([
      started.coordinatorId,
      started.coordinatorId,
    ]);
    expect(host.sent[1]?.text).toContain("【重新规划资料 JSON】");

    // The coordinator answers the new request with the nonce in it.
    const nonce = String(
      (await stored()).outbox.findLast((intent) => intent.kind === "wake")?.semanticArgs
        .controlNonce,
    );
    const block = dagBlock(RUN_ID, planTasks(REPO_ALIAS), { nonce });
    host.reply(
      started.coordinatorId,
      `Plan.
\`\`\`task-dag
${JSON.stringify(block)}
\`\`\`
`,
    );
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
    expect(host.sent).toHaveLength(3);
    expect(after.outbox.some((intent) => intent.kind === "wake")).toBe(false);
  });

  test("a request left prepared by a stop is sent by the next process's first recovery, once", async () => {
    const host = fakeHost();
    const before = runtime();
    const started = await startAndRefuse(host, before);
    const waiting = await stored();
    // The request is committed and the process stops before it is sent.
    await store.update(RUN_ID, (current) => {
      const result = requestReplan(current, {
        requestId: "req-1",
        expectedRevision: current.revision,
        reason: "use the workspace alias",
        controlNonce: "7a2d3b55-4c8f-4b1b-8b22-0000000000a2",
        controlNonceDigest: "e".repeat(64),
        intentId: "intent-plan-2",
        messageId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
        payloadHash: "0".repeat(64),
        templateVersion: PLAN_REPLAN_VERSION,
        now: new Date().toISOString(),
      });
      if (!result.ok || result.replayed) throw new Error("not applied");
      const intent = result.next.outbox.at(-1);
      const text = intent?.kind === "wake" ? compilePlanRequest(intent, result.next) : null;
      if (!intent || text === null) throw new Error("not buildable");
      intent.payloadHash = payloadHash(text);
      return result.next;
    });
    expect(waiting.lifecycle).toBe("awaiting-dag");
    expect(host.sent).toHaveLength(1);

    const next = runtime();
    next.bind(host.port);
    await next.recover();
    expect(host.sent.map((entry) => entry.agentId)).toEqual([
      started.coordinatorId,
      started.coordinatorId,
    ]);
    await next.recover();
    await next.control.kick({ runContractVersion: 1, runId: RUN_ID });
    expect(host.sent).toHaveLength(2);
  });
});

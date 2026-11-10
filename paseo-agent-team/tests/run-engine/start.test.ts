import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mcpServersSha256, sha256Hex } from "../../server/run-engine/digest";
import { createEffects, type SendableIntent } from "../../server/run-engine/effects";
import { inspectRepo } from "../../server/run-engine/repo";
import {
  type EngineStartDeps,
  type EngineStartInput,
  startEngineRun,
} from "../../server/run-engine/start";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import { buildLaunchPlan, type LaunchPlan } from "../../shared/domain/launch-plan";
import {
  COORDINATOR_SEAT_ID,
  checkDag,
  REPO_ALIAS,
  readDagControl,
} from "../../shared/domain/run-engine/dag-admission";
import { compileEngineIntent } from "../../shared/domain/run-engine/engine-prompts";
import { readReadRetries } from "../../shared/domain/run-engine/read-retry";
import { reduceRun } from "../../shared/domain/run-engine/reducer";
import { readSeatProfiles } from "../../shared/domain/run-engine/run-record";
import { readAgentSpecs } from "../../shared/domain/run-engine/seat-rebuild";
import type { CreateMemberInput } from "../../shared/paseo/adapter";
import type { PaseoEnginePort, PortTimelinePage } from "../../shared/paseo/port";
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
 * Failure modes this file guards, with a real store, a real git repository and fake agents:
 *  - an agent created before the Run's record exists, so a crash leaves an agent nobody owns;
 *  - an unknown create result creating a second agent for one seat;
 *  - a failed launch leaving no trace on the Run, or leaving agents nobody was told about;
 *  - a plan request sent twice, or a Run called running before the plan request was proven;
 *  - a launch that goes ahead on a repository or evidence directory the Engine cannot use.
 */

const RUN_ID = "run-start1-a1";

let home: string;
let repoDir: string;
let store: RunStore;
let plan: LaunchPlan;
let engine: RunTeamEngineConfig;

function git(cwd: string, ...args: string[]): void {
  execFileSync(
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
    { cwd, windowsHide: true, stdio: "ignore" },
  );
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), "run-start-")));
  repoDir = path.join(home, "repo");
  await mkdir(repoDir, { recursive: true });
  git(repoDir, "init", "-q", "-b", "main");
  await writeFile(path.join(repoDir, "a.txt"), "x");
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "-q", "-m", "base");
  await mkdir(path.join(home, "paseo"));
  store = createRunStore({ home: path.join(home, "paseo"), lock: { acquireTimeoutMs: 300 } });
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

// --- fakes -------------------------------------------------------------------------------------

function fakeAdapter(
  options: {
    /** Keys whose create throws BEFORE anything is made, this many times. */
    failures?: Record<string, number>;
    /** Keys whose create makes the agent, remembers it under the key, then throws (the answer is lost). */
    lostAnswers?: Record<string, number>;
    /** Agents the host already had that belong to nobody in this launch. */
    unrelated?: string[];
    onCreate?: () => Promise<void>;
  } = {},
) {
  const byKey = new Map<string, string>();
  const requests: CreateMemberInput[] = [];
  const archived: string[] = [];
  const failures = { ...options.failures };
  const lostAnswers = { ...options.lostAnswers };
  const unrelated = [...(options.unrelated ?? [])];
  return {
    requests,
    /** Every agent the host holds, the unrelated ones included. */
    hostAgents: () => new Set([...byKey.values(), ...unrelated]),
    unrelated,
    archived,
    agents: () => new Set(byKey.values()),
    adapter: {
      createAgent: async (request: CreateMemberInput) => {
        requests.push(request);
        await options.onCreate?.();
        const key = request.idempotencyKey ?? "";
        const left = failures[key] ?? 0;
        if (left > 0) {
          failures[key] = left - 1;
          throw new Error(`create failed for ${key}`);
        }
        const agentId = byKey.get(key) ?? `agent-${byKey.size + 1}`;
        byKey.set(key, agentId);
        const lost = lostAnswers[key] ?? 0;
        if (lost > 0) {
          lostAnswers[key] = lost - 1;
          throw new Error(`the answer for ${key} was lost`);
        }
        return { agentId };
      },
      archiveAgent: async (agentId: string) => {
        archived.push(agentId);
      },
    },
  };
}

const emptyPage: PortTimelinePage = {
  entries: [],
  epoch: "e1",
  startCursor: null,
  hasOlder: false,
  hasNewer: false,
  gap: false,
  staleCursor: false,
  reset: false,
};

function fakePort(options: { sendFails?: boolean } = {}) {
  const sent: { agentId: string; text: string; messageId?: string }[] = [];
  const port: PaseoEnginePort = {
    agents: {
      ref: (agentId) => ({
        send: async (text, sendOptions) => {
          sent.push({ agentId, text, messageId: sendOptions?.messageId });
          if (options.sendFails) throw new Error("connection reset");
        },
        archive: async () => undefined,
        timeline: { refetch: async () => emptyPage },
        current: () => ({ status: "idle", activeTurn: null }),
        refresh: async () => ({ agent: { status: "idle", activeTurn: null } }),
      }),
    },
  };
  return { port, sent };
}

const compilePlanRequest = (intent: SendableIntent): string =>
  `PLAN ${String(intent.semanticArgs.controlNonce)} ${String(intent.semanticArgs.task)}`;

function setup(
  adapterOptions: Parameters<typeof fakeAdapter>[0] = {},
  portOptions: Parameters<typeof fakePort>[0] = {},
) {
  const agents = fakeAdapter(adapterOptions);
  const host = fakePort(portOptions);
  const effects = createEffects({ store, port: host.port, compile: compilePlanRequest });
  const deps: EngineStartDeps = {
    store,
    adapter: agents.adapter,
    effects,
    compilePlanRequest,
    templateVersion: 1,
    // The machine's own git config must not decide these tests.
    commitIdentity: async () => ({ ok: true }),
    // The original behaviour: one more try with the same key, no waiting.
    createAttempts: 2,
    retryDelayMs: 0,
  };
  return { agents, host, effects, deps };
}

function input(overrides: Partial<EngineStartInput> = {}): EngineStartInput {
  return {
    plan,
    roles: [techLead, architect, developer],
    engine,
    workspaceDirectory: repoDir,
    requestId: "request-1",
    requestHash: "a".repeat(64),
    planHash: "b".repeat(64),
    maxMembers: 8,
    serverId: "srv-dev-1",
    paseoHome: home.replaceAll("\\", "/"),
    archiveOnLaunchFailure: true,
    ...overrides,
  };
}

async function stored(): Promise<RunRecord> {
  const read = await store.get(RUN_ID);
  if (read.status !== "ok") throw new Error(`run unreadable: ${read.status}`);
  return read.record;
}

const seatKey = (seatId: string) => `engine:${RUN_ID}:seat:${seatId}`;

describe("startEngineRun", () => {
  test("creates the Run, then the agents, binds each to its seat, and sends the plan request once", async () => {
    const { agents, host, deps } = setup();
    const result = await startEngineRun(deps, input());

    expect(result).toMatchObject({ ok: true, runId: RUN_ID, launchState: "running" });
    if (!result.ok) return;
    const record = await stored();
    expect(record.schemaVersion).toBe(2);
    // A new Run is given read re-checks; the block starts empty.
    expect(readReadRetries(record)).toEqual({ kind: "valid", items: [] });
    expect(record.launch.state).toBe("running");
    expect(record.lifecycle).toBe("bootstrapping");
    expect(record.tasks).toEqual([]);

    // Every roster seat has its own agent; the coordinator is the Engine's own seat.
    const bound = Object.fromEntries(record.roster.map((seat) => [seat.seatId, seat.agentId]));
    expect(bound[COORDINATOR_SEAT_ID]).toBe(result.coordinatorId);
    expect(result.memberIds).toHaveLength(2);
    expect(new Set(Object.values(bound)).size).toBe(3);
    // Created with idempotency keys, members under the coordinator.
    const requests = agents.requests;
    expect(requests.map((request) => request.idempotencyKey)).toEqual([
      seatKey(COORDINATOR_SEAT_ID),
      ...engine.seats.map((seat) => seatKey(seat.seatId)),
    ]);
    expect(
      requests.slice(1).every((request) => request.parentAgentId === result.coordinatorId),
    ).toBe(true);

    // One plan request, to the coordinator, with the message id the ledger holds.
    expect(host.sent).toHaveLength(1);
    const intent = record.outbox.find((entry) => entry.kind === "wake");
    expect(intent).toMatchObject({ state: "confirmed", recipient: result.coordinatorId });
    expect(host.sent[0]).toMatchObject({
      agentId: result.coordinatorId,
      messageId: intent?.messageId,
    });
    expect(host.sent[0]?.text).toContain("Add a login page.");
  });

  test("the plan request is the coordinator's first turn: its budget entry takes the policy's limit with one reserved, and the policy is not written", async () => {
    const { deps } = setup();
    await startEngineRun(deps, input());
    const record = await stored();
    const entry = record.budgets.entries.find(
      (candidate) => candidate.scope === "seat" && candidate.subjectId === COORDINATOR_SEAT_ID,
    );
    expect(entry).toEqual({
      scope: "seat",
      subjectId: COORDINATOR_SEAT_ID,
      limit: engine.policy.run.strategicTurns,
      reserved: 1,
      confirmed: 0,
      observedTurns: 0,
    });
    expect(record.policy.seatBudgets.map((candidate) => candidate.subjectId)).not.toContain(
      COORDINATOR_SEAT_ID,
    );
  });

  test("the ledger holds the control nonce only as a digest, apart from the request it is rebuilt from", async () => {
    const { deps } = setup();
    await startEngineRun(deps, input());
    const record = await stored();
    const intent = record.outbox.find((entry) => entry.kind === "wake");
    const nonce = String(intent?.semanticArgs.controlNonce);
    expect(nonce).toMatch(/^[0-9a-f-]{36}$/u);
    expect(readDagControl(record)).toEqual({
      nonceDigest: sha256Hex(nonce),
      issuedAt: expect.any(String),
      acceptedAt: null,
    });
    expect(JSON.stringify(record.launch)).not.toContain(nonce);
  });

  test("no control nonce exists while the agents are being created: it comes with the plan request", async () => {
    let seen: RunRecord | null = null;
    const { deps } = setup({
      onCreate: async () => {
        seen ??= await stored();
      },
    });
    await startEngineRun(deps, input());
    const first = seen as unknown as RunRecord;
    expect(readDagControl(first)).toBeNull();
    expect(first.outbox).toEqual([]);
    // Once the request is in the record, digest, text and hash all agree.
    const record = await stored();
    const intent = record.outbox.find((entry) => entry.kind === "wake");
    expect(readDagControl(record)?.nonceDigest).toBe(
      sha256Hex(String(intent?.semanticArgs.controlNonce)),
    );
  });

  test("with the Engine's own texts: agents get the Engine system prompts, pinned by hash, and the real plan request goes out", async () => {
    const agents = fakeAdapter();
    const host = fakePort();
    const effects = createEffects({ store, port: host.port, compile: compileEngineIntent });
    const result = await startEngineRun(
      { store, adapter: agents.adapter, effects, commitIdentity: async () => ({ ok: true }) },
      input(),
    );
    expect(result).toMatchObject({ ok: true, launchState: "running" });
    const record = await stored();

    // Not the old chain's prompts: the tech lead Role's own text ("Delegate with send_agent_prompt.")
    // is not an input, and the coordinator is told not to delegate.
    const prompts = agents.requests.map((request) => request.systemPrompt);
    expect(prompts).toHaveLength(3);
    expect(prompts.some((text) => text.includes("Delegate with send_agent_prompt"))).toBe(false);
    expect(prompts[0]).toContain("你是 Run Engine 的协调者");
    expect(prompts.slice(1).every((text) => text.includes("受 Run Engine 控制的成员"))).toBe(true);

    // Each prompt is pinned by version and hash before any agent exists.
    const pinned = (record.launch as Record<string, unknown>).systemPrompts as Record<
      string,
      { template: string; version: number; hash: string }
    >;
    expect(pinned[COORDINATOR_SEAT_ID]).toEqual({
      template: "coordinator-system",
      version: 1,
      hash: sha256Hex(prompts[0] ?? ""),
    });
    for (const [index, seat] of engine.seats.entries()) {
      expect(pinned[seat.seatId]).toMatchObject({
        template: "member-system",
        hash: sha256Hex(prompts[index + 1] ?? ""),
      });
    }

    // The request that was sent is the one the record rebuilds, with the nonce and the roster in it.
    const intent = record.outbox.find((entry) => entry.kind === "wake");
    expect(intent?.payloadHash).toBe(sha256Hex(host.sent[0]?.text ?? ""));
    expect(host.sent[0]?.text).toContain("【花名册 JSON】");
    expect(host.sent[0]?.text).toContain(String(intent?.semanticArgs.controlNonce));
    expect(host.sent[0]?.text).toContain("Add a login page.");
  });

  test("the seats' Profiles are frozen, with the model family the model id shows", async () => {
    const { deps } = setup();
    await startEngineRun(deps, input());
    const profiles = readSeatProfiles(await stored());
    const [first, second] = engine.seats;
    expect(profiles.get(first?.seatId ?? "")).toMatchObject({
      profileId: claudeOpus.id,
      provider: "claude",
      family: "opus",
    });
    // Not every model id names a family; the Engine does not guess one.
    expect(profiles.get(second?.seatId ?? "")).toMatchObject({
      profileId: codexXhigh.id,
      family: null,
    });
    expect(profiles.get(COORDINATOR_SEAT_ID)).toMatchObject({ profileId: claudeOpus.id });
  });

  test("channels start available, so the first dispatch is not held back by 'unknown'", async () => {
    const { deps } = setup();
    await startEngineRun(deps, input());
    const record = await stored();
    expect(record.channels.map((entry) => `${entry.channelId}:${entry.state}`).sort()).toEqual([
      "claude:available",
      "codex:available",
    ]);
  });

  test("the record exists, with no agent bound, before the first agent is created", async () => {
    let seen: RunRecord | null = null;
    const { deps } = setup({
      onCreate: async () => {
        seen ??= await stored();
      },
    });
    await startEngineRun(deps, input());
    expect(seen).not.toBeNull();
    const first = seen as unknown as RunRecord;
    expect(first.launch.state).toBe("creating");
    expect(first.roster.every((seat) => seat.agentId === null)).toBe(true);
  });

  test("an unknown create result is re-asked with the same key and creates no second agent", async () => {
    const [first] = engine.seats;
    const { agents, deps } = setup({ failures: { [seatKey(first?.seatId ?? "")]: 1 } });
    const result = await startEngineRun(deps, input());
    expect(result).toMatchObject({ ok: true });
    // Four create calls for three agents: one seat was asked twice, with the same key.
    expect(agents.requests).toHaveLength(4);
    expect(agents.agents().size).toBe(3);
    const keys = agents.requests.map((request) => request.idempotencyKey);
    expect(keys.filter((key) => key === seatKey(first?.seatId ?? ""))).toHaveLength(2);
  });

  test("an agent made and remembered under its key whose answer was lost is the one the next ask returns: one agent per seat, none extra", async () => {
    const [first] = engine.seats;
    const lostKey = seatKey(first?.seatId ?? "");
    const { agents, deps } = setup({ lostAnswers: { [lostKey]: 1 } });
    const result = await startEngineRun(deps, input());
    expect(result).toMatchObject({ ok: true, launchState: "running" });
    if (!result.ok) return;
    // The seat was asked twice with its key, and the second ask got the agent the first one made.
    const asks = agents.requests.filter((request) => request.idempotencyKey === lostKey);
    expect(asks).toHaveLength(2);
    expect(agents.requests).toHaveLength(4);
    // The host holds exactly one agent per seat (coordinator plus two members), and the Run binds those.
    expect(agents.agents().size).toBe(3);
    const record = await stored();
    const bound = record.roster.map((seat) => seat.agentId).filter((id) => id !== null);
    expect(new Set(bound)).toEqual(agents.agents());
    expect(new Set(bound).size).toBe(bound.length);
    expect(result.memberIds).toHaveLength(2);
    expect(new Set([result.coordinatorId, ...result.memberIds])).toEqual(agents.agents());
  });

  test("a seat the Team turned off gets no agent and stays unbound", async () => {
    const [first, second] = engine.seats;
    const disabled: RunTeamEngineConfig = {
      ...engine,
      seats: [first, { ...(second as (typeof engine.seats)[number]), enabled: false }].filter(
        (seat): seat is (typeof engine.seats)[number] => seat !== undefined,
      ),
    };
    const { agents, deps } = setup();
    const result = await startEngineRun(deps, input({ engine: disabled }));
    expect(result).toMatchObject({ ok: true });
    expect(agents.agents().size).toBe(2);
    const record = await stored();
    expect(record.roster.find((seat) => seat.seatId === second?.seatId)).toMatchObject({
      enabled: false,
      agentId: null,
    });
  });

  test("the Run it creates is one the coordinator's plan can be admitted into", async () => {
    const { deps } = setup();
    const result = await startEngineRun(deps, input());
    if (!result.ok) throw new Error("expected a launch");
    const record = await stored();
    const nonce = String(
      record.outbox.find((entry) => entry.kind === "wake")?.semanticArgs.controlNonce,
    );
    const inspected = await inspectRepo(repoDir);
    if (!inspected.ok) throw new Error("fixture repository is not readable");
    const families = new Map(
      [...readSeatProfiles(record)].map(([seatId, profile]) => [seatId, profile.family]),
    );

    const checked = checkDag(record, dagBlock(RUN_ID, planTasks(REPO_ALIAS), { nonce }), {
      agentId: result.coordinatorId,
      canonicalRepoId: inspected.repo.repoId,
      nonceDigest: sha256Hex(nonce),
      seatFamilies: families,
    });
    if (!checked.ok) throw new Error(`plan refused: ${JSON.stringify(checked.issues)}`);
    const reduced = reduceRun(
      record,
      { kind: "dag-accepted", block: checked.block },
      { now: new Date().toISOString(), newId: () => randomUUID() },
    );
    if (!reduced.ok) throw new Error(`reducer refused: ${JSON.stringify(reduced.params)}`);
    expect(reduced.next.lifecycle).toBe("active");
  });

  test("the evidence root chosen for the Run is outside the repository and exists", async () => {
    const { deps } = setup();
    await startEngineRun(deps, input());
    const record = await stored();
    expect(record.policy.evidenceRoot).toBe(
      `${home.replaceAll("\\", "/")}/agent-team-evidence/${RUN_ID}`,
    );
    await expect(stat(record.policy.evidenceRoot)).resolves.toBeTruthy();
    expect(path.resolve(record.policy.evidenceRoot).startsWith(path.resolve(repoDir))).toBe(false);
  });
});

describe("startEngineRun: failures", () => {
  test.each([
    [
      "a working tree with a stray file",
      async () => {
        await writeFile(path.join(repoDir, "stray.txt"), "x");
      },
      undefined,
    ],
    [
      "a directory that is not a repository",
      async () => undefined,
      () => input({ workspaceDirectory: path.join(home, "paseo") }),
    ],
    [
      "a task that does not fit the record",
      async () => undefined,
      () => input({ plan: { ...plan, task: "x".repeat(4001) } }),
    ],
    [
      "an evidence root inside the repository",
      async () => undefined,
      () =>
        input({
          engine: {
            ...engine,
            policy: {
              ...engine.policy,
              evidenceRoot: path.join(repoDir, "evidence").replaceAll("\\", "/"),
            },
          },
        }),
    ],
    [
      "a relative evidence root",
      async () => undefined,
      () =>
        input({ engine: { ...engine, policy: { ...engine.policy, evidenceRoot: "evidence" } } }),
    ],
  ])("%s stops the launch before anything exists", async (_name, prepare, makeInput) => {
    await prepare();
    const { agents, host, deps } = setup();
    const result = await startEngineRun(deps, makeInput ? makeInput() : input());
    expect(result).toMatchObject({
      ok: false,
      step: "preflight",
      archived: false,
      agentIdsKept: [],
    });
    expect(await store.get(RUN_ID)).toEqual({ status: "missing" });
    expect(agents.requests).toHaveLength(0);
    expect(host.sent).toHaveLength(0);
  });

  test("a coordinator turn budget of 0 stops the launch before anything exists: there is no turn to send the plan request in", async () => {
    const { agents, host, deps } = setup();
    const result = await startEngineRun(
      deps,
      input({
        engine: {
          ...engine,
          policy: { ...engine.policy, run: { ...engine.policy.run, strategicTurns: 0 } },
        },
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      step: "preflight",
      message: "协调者回合预算为 0，无法发出计划请求；请先增加预算",
      archived: false,
      agentIdsKept: [],
    });
    expect(await store.get(RUN_ID)).toEqual({ status: "missing" });
    expect(agents.requests).toHaveLength(0);
    expect(host.sent).toHaveLength(0);
  });

  test("a Workspace git cannot commit in stops the launch before anything exists", async () => {
    const { agents, host, deps } = setup();
    const result = await startEngineRun(
      {
        ...deps,
        commitIdentity: async () => ({
          ok: false,
          detail: "fatal: unable to auto-detect email address",
        }),
      },
      input(),
    );
    expect(result).toMatchObject({
      ok: false,
      step: "preflight",
      detail: "fatal: unable to auto-detect email address",
      archived: false,
      agentIdsKept: [],
    });
    expect(await store.get(RUN_ID)).toEqual({ status: "missing" });
    expect(agents.requests).toHaveLength(0);
    expect(host.sent).toHaveLength(0);
  });

  test("a create that fails twice with a transient error succeeds on the third try with the same key", async () => {
    const { agents, deps } = setup({ failures: { [seatKey(COORDINATOR_SEAT_ID)]: 2 } });
    const result = await startEngineRun({ ...deps, createAttempts: 3 }, input());
    expect(result).toMatchObject({ ok: true, launchState: "running" });
    const coordinatorCalls = agents.requests.filter(
      (request) => request.idempotencyKey === seatKey(COORDINATOR_SEAT_ID),
    );
    expect(coordinatorCalls).toHaveLength(3);
    // Still one agent per seat: the repeated key never made a second coordinator.
    expect(agents.agents().size).toBe(3);
  });

  test("when the coordinator cannot be created the launch is failed on the Run, with an alert", async () => {
    const { agents, deps } = setup({ failures: { [seatKey(COORDINATOR_SEAT_ID)]: 2 } });
    const result = await startEngineRun(deps, input());
    expect(result).toMatchObject({ ok: false, step: "coordinator", archived: false });
    expect(agents.requests).toHaveLength(2);
    const record = await stored();
    expect(record.launch.state).toBe("failed");
    expect(record.alerts).toHaveLength(1);
    expect(record.alerts[0]).toMatchObject({ severity: "critical", state: "open" });
    expect(record.alerts[0]?.summary).toContain("coordinator");
    expect(record.outbox).toEqual([]);
  });

  test("when a member cannot be created, what was created is archived if the preference says so", async () => {
    const [first] = engine.seats;
    const { agents, host, deps } = setup({ failures: { [seatKey(first?.seatId ?? "")]: 2 } });
    const result = await startEngineRun(deps, input());
    expect(result).toMatchObject({ ok: false, step: "member", archived: true, agentIdsKept: [] });
    expect(agents.archived).toHaveLength(1);
    expect((await stored()).launch.state).toBe("failed");
    expect(host.sent).toHaveLength(0);
  });

  test("a failed launch archives only the agents this launch created, not another agent the host holds", async () => {
    const second = engine.seats[1];
    const { agents, deps } = setup({
      unrelated: ["agent-someone-elses"],
      failures: { [seatKey(second?.seatId ?? "")]: 2 },
    });
    const result = await startEngineRun(deps, input());
    expect(result).toMatchObject({ ok: false, step: "member", archived: true, agentIdsKept: [] });
    // Created before the failure: the coordinator and the first member. Nothing else is touched.
    expect(agents.agents().size).toBe(2);
    expect(new Set(agents.archived)).toEqual(agents.agents());
    expect(agents.archived).toHaveLength(2);
    expect(agents.archived).not.toContain("agent-someone-elses");
    expect(agents.hostAgents().has("agent-someone-elses")).toBe(true);
    expect((await stored()).launch.state).toBe("failed");
  });

  test("or kept, and named, if it does not", async () => {
    const [first] = engine.seats;
    const { agents, deps } = setup({ failures: { [seatKey(first?.seatId ?? "")]: 2 } });
    const result = await startEngineRun(deps, input({ archiveOnLaunchFailure: false }));
    expect(result).toMatchObject({ ok: false, step: "member", archived: false });
    expect(result.ok ? [] : result.agentIdsKept).toHaveLength(1);
    expect(agents.archived).toEqual([]);
  });

  test("a plan request whose delivery is unknown is not a failure and is never sent again", async () => {
    const { host, effects, deps } = setup({}, { sendFails: true });
    const result = await startEngineRun(deps, input());
    expect(result).toMatchObject({ ok: true, launchState: "kickoff-pending" });
    const record = await stored();
    expect(record.launch.state).toBe("kickoff-pending");
    expect(record.outbox.find((entry) => entry.kind === "wake")).toMatchObject({
      state: "outcome-unknown",
    });
    expect(host.sent).toHaveLength(1);

    // The executor settles only by evidence: with none, it stays unknown and sends nothing.
    await effects.runOutbox(RUN_ID);
    expect(host.sent).toHaveLength(1);
    expect((await stored()).launch.state).toBe("kickoff-pending");
  });

  test("a plan request that cannot be built stops the launch before anything is sent", async () => {
    const { host, deps } = setup();
    const result = await startEngineRun({ ...deps, compilePlanRequest: () => null }, input());
    expect(result).toMatchObject({ ok: false, step: "kickoff" });
    expect(host.sent).toHaveLength(0);
    expect((await stored()).launch.state).toBe("failed");
  });
});

describe("startEngineRun: the spec frozen for rebuilding a member (T11b)", () => {
  /** Every seat the launch made, with what it was created with. */
  async function launched(planEdit?: (plan: LaunchPlan) => void) {
    if (planEdit) planEdit(plan);
    const { agents, deps } = setup();
    const seenAtFirstCreate: { agentSpecs: unknown; revision: number }[] = [];
    const creating = {
      ...agents.adapter,
      createAgent: async (request: CreateMemberInput) => {
        const read = await store.get(RUN_ID);
        if (read.status === "ok") {
          seenAtFirstCreate.push({
            agentSpecs: (read.record.launch as Record<string, unknown>).agentSpecs,
            revision: read.record.revision,
          });
        }
        return agents.adapter.createAgent(request);
      },
    };
    const created: RunRecord[] = [];
    const watching = {
      ...store,
      create: async (record: RunRecord) => {
        created.push(structuredClone(record));
        return store.create(record);
      },
    } as unknown as RunStore;
    const result = await startEngineRun({ ...deps, adapter: creating, store: watching }, input());
    return { result, agents, seenAtFirstCreate, created };
  }

  test("the specs are written with the Run's first record, before any Agent exists", async () => {
    const { result, seenAtFirstCreate, created } = await launched();
    expect(result.ok).toBe(true);
    // The very record that was created already holds them: no commit of their own, no Agent without them.
    const first = created[0];
    const block = (first?.launch as Record<string, unknown> | undefined)?.agentSpecs as {
      version: number;
      seats: Record<string, unknown>;
    };
    expect(first?.revision).toBe(1);
    expect(block.version).toBe(1);
    expect(seenAtFirstCreate.length).toBeGreaterThan(0);
    for (const seen of seenAtFirstCreate) expect(seen.agentSpecs).toEqual(block);
    expect(readAgentSpecs(await stored()).kind).toBe("valid");
  });

  test("each enabled seat's spec is what its Agent was created with, the coordinator's included", async () => {
    const { agents } = await launched();
    const record = await stored();
    const specs = readAgentSpecs(record);
    if (specs.kind !== "valid") throw new Error("expected valid specs");
    expect([...specs.seats.keys()].sort()).toEqual(
      [COORDINATOR_SEAT_ID, ...engine.seats.map((seat) => seat.seatId)].sort(),
    );
    for (const request of agents.requests) {
      const seatId = request.idempotencyKey?.split(":seat:")[1] ?? "";
      const spec = specs.seats.get(seatId);
      expect(spec?.title).toBe(request.title);
      expect(spec?.labels).toEqual(request.labels);
      expect(spec?.systemPrompt).toBe(request.systemPrompt);
      expect(spec?.systemPromptSha256).toBe(sha256Hex(request.systemPrompt));
      // The whole Profile, not the subset kept for scheduling.
      expect(spec?.profile).toEqual(request.profile);
      expect(spec?.parentSeatId).toBe(seatId === COORDINATOR_SEAT_ID ? null : COORDINATOR_SEAT_ID);
    }
    const pinned = (record.launch as Record<string, unknown>).systemPrompts as Record<
      string,
      { hash: string }
    >;
    for (const [seatId, spec] of specs.seats) {
      expect(spec.systemPromptSha256).toBe(pinned[seatId]?.hash);
    }
  });

  test("a seat whose prompt is over 64 KiB is not frozen, not cut, and the others are", async () => {
    const { result } = await launched((p) => {
      const member = p.members[0];
      if (member) member.role = { ...member.role, mission: "字".repeat(30_000) };
    });
    expect(result.ok).toBe(true);
    const specs = readAgentSpecs(await stored());
    if (specs.kind !== "valid") throw new Error("expected valid specs");
    const missing = engine.seats.filter((seat) => !specs.seats.has(seat.seatId));
    expect(missing).toHaveLength(1);
    expect(specs.seats.has(COORDINATOR_SEAT_ID)).toBe(true);
    // The Run itself is unharmed.
    expect((await stored()).launch.state).toBe("running");
  });

  test("the Role's MCP configuration is never stored, only its digest", async () => {
    const secret = "sk-very-secret-token";
    const mcpServers = {
      docs: { command: "node", args: ["server.js"], env: { TOKEN: secret } },
      web: {
        type: "http" as const,
        url: "https://example.invalid",
        headers: { Authorization: secret },
      },
    };
    await launched((p) => {
      for (const member of p.members) member.role = { ...member.role, mcpServers };
    });
    const raw = JSON.stringify(await stored());
    expect(raw).not.toContain(secret);
    const specs = readAgentSpecs(await stored());
    if (specs.kind !== "valid") throw new Error("expected valid specs");
    const memberSeat = engine.seats[0]?.seatId ?? "";
    expect(specs.seats.get(memberSeat)?.mcpServersSha256).toBe(mcpServersSha256(mcpServers));
    // A Role with none has the digest of nothing, and so does one that is empty.
    expect(specs.seats.get(COORDINATOR_SEAT_ID)?.mcpServersSha256).toBe(
      mcpServersSha256(undefined),
    );
  });
});

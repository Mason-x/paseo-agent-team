import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createCancelFinisher } from "../../server/run-engine/cancel";
import { mcpServersSha256, sha256Hex } from "../../server/run-engine/digest";
import { createEngineDriver } from "../../server/run-engine/driver";
import { createEffects } from "../../server/run-engine/effects";
import { createRunObserver } from "../../server/run-engine/observer";
import { inspectRepo } from "../../server/run-engine/repo";
import { createEngineService, type EngineServiceOptions } from "../../server/run-engine/service";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import {
  CANCEL_REQUEST_VERSION,
  withCancelRequest,
} from "../../shared/domain/run-engine/cancel-request";
import {
  COORDINATOR_DUTY,
  COORDINATOR_SEAT_ID,
} from "../../shared/domain/run-engine/dag-admission";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import { compileDispatch } from "../../shared/domain/run-engine/prompt-template";
import { emptyReadRetries } from "../../shared/domain/run-engine/read-retry";
import { readSeatProfiles } from "../../shared/domain/run-engine/run-record";
import {
  type AgentSpec,
  canStartRebuild,
  readSeatRebuilds,
  startRebuildRecord,
} from "../../shared/domain/run-engine/seat-rebuild";
import type { CreateMemberInput } from "../../shared/paseo/adapter";
import type { PaseoEnginePort, PortAgentSnapshot, PortTimelinePage } from "../../shared/paseo/port";
import type { McpServers } from "../../shared/schemas/role";
import type { RunEventReceipt, RunRecord } from "../../shared/schemas/run-engine/ledger";
import { PROFILE_HAIKU } from "../fixtures/run-engine/base";
import { readyRun } from "./support/ready-run";
import { JUDGE_SEAT_REVIEW, reviewRun } from "./support/review-run";

/**
 * T11b: a member whose Agent no read will bring back (its first turn was cut off, or it never ran and
 * cannot be opened) gets a new Agent, made from the spec frozen at launch and bound to its seat. Failure
 * modes this file guards:
 *  - a seat rebuilt when reading could have brought it back (a member that finished a turn), or a seat that
 *    cannot be rebuilt being "rebuilt" from nothing (no spec, a different MCP configuration);
 *  - two Agents for one seat after a crash, or an Agent that was made and never bound;
 *  - a failed rebuild tried again by a restart or a hook, or a third generation, or one that uses up a
 *    generation without having tried to create anything;
 *  - work sent to the old Agent after the rebind, or to the new one twice, or anything sent when the Run
 *    was paused or cancelled while the Agent was being made;
 *  - the old Agent's hooks still counted, buffered or taken for lost hooks;
 *  - a supplement, an archived seat, the coordinator or a busy seat being rebuilt.
 */

const RUN_ID = "run-rebuild-a1";
const B1 = "agent-b1";
const B2 = "agent-b2";
const B3 = "agent-b3";
const B4 = "agent-b4";
const B6 = "agent-b6";
const COORD = "agent-coord";
const KEY = (seat: string, generation: number) =>
  `engine:${RUN_ID}:seat:${seat}:rebuild:${generation}`;

let home: string;
let repoDir: string;
let repoId: string;
let evidenceRoot: string;
let store: RunStore;
let schema: 1 | 2 = 2;

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

type ReadsAs = "opens" | "throws" | "stays" | "runs" | "hangs";

/** A host whose agents are idle unless said to be closed (reading a closed one does what the test says). */
function fakeHost() {
  const closed = new Set<string>();
  const running = new Set<string>();
  const readsAs = new Map<string, ReadsAs>();
  const sent: { agentId: string; text: string }[] = [];
  const timelineReads: string[] = [];
  const calls = { refreshes: 0 };
  const snapshot = (agentId: string): PortAgentSnapshot =>
    running.has(agentId)
      ? { status: "running", activeTurn: null }
      : closed.has(agentId)
        ? { status: "closed", activeTurn: null }
        : { status: "idle", activeTurn: null };
  const port: PaseoEnginePort = {
    agents: {
      ref: (agentId) => ({
        send: async (text) => {
          sent.push({ agentId, text });
        },
        archive: async () => undefined,
        timeline: {
          refetch: async () => {
            timelineReads.push(agentId);
            const how = readsAs.get(agentId) ?? "stays";
            if (how === "throws") throw new Error("Failed to resume: no rollout found");
            if (how === "hangs") await new Promise<never>(() => undefined);
            if (how === "opens") closed.delete(agentId);
            if (how === "runs") {
              // Loaded by the read, and a turn started on it meanwhile (a person wrote to it).
              closed.delete(agentId);
              running.add(agentId);
            }
            return emptyPage;
          },
        },
        current: () => snapshot(agentId),
        refresh: async () => {
          calls.refreshes += 1;
          return { agent: snapshot(agentId) };
        },
      }),
    },
  };
  return { port, sent, closed, running, readsAs, timelineReads, calls };
}
type Host = ReturnType<typeof fakeHost>;

type RoleState = { status: "found"; mcpServers: McpServers | undefined } | { status: "missing" };

/** The part of the host that creates Agents and reads Roles; the same key gives the same Agent. */
function fakeRebuild() {
  const created: CreateMemberInput[] = [];
  const byKey = new Map<string, string>();
  const roles = new Map<string, RoleState>([
    ["role-builder", { status: "found", mcpServers: undefined }],
  ]);
  const state = {
    failures: 0,
    failWith: (): Error => new Error("the host would not create it"),
    onCreate: undefined as undefined | (() => Promise<void>),
    /** Runs while the Role is being read: after the pass has judged the seat, before the attempt is written. */
    onReadRole: undefined as undefined | (() => Promise<void>),
    reads: 0,
  };
  const host: NonNullable<EngineServiceOptions["rebuild"]> = {
    createAgent: async (input) => {
      created.push(input);
      await state.onCreate?.();
      if (state.failures > 0) {
        state.failures -= 1;
        throw state.failWith();
      }
      const key = input.idempotencyKey ?? "";
      const agentId = byKey.get(key) ?? `agent-new-${byKey.size + 1}`;
      byKey.set(key, agentId);
      return { agentId };
    },
    readRole: async (roleId) => {
      state.reads += 1;
      await state.onReadRole?.();
      return roles.get(roleId) ?? { status: "missing" };
    },
    retryDelayMs: 0,
  };
  return { host, created, byKey, roles, state };
}
type Rebuild = ReturnType<typeof fakeRebuild>;

const FAMILY = { producer: "haiku", judge: "luna" };
const PRODUCERS: Record<string, number> = {
  "seat-b1": 0,
  "seat-b3": 1,
  "seat-b4": 2,
  "seat-b5": 3,
};

function makeService(
  host: Host,
  rebuild: Rebuild | null,
  extra: Partial<EngineServiceOptions> = {},
) {
  const effects = createEffects({ store, port: host.port, compile: compileDispatch });
  return createEngineService({
    store,
    port: host.port,
    effects,
    resolveSeat: (_record, seatId) => {
      if (seatId in PRODUCERS) {
        return {
          profile: {
            id: PROFILE_HAIKU.id,
            name: PROFILE_HAIKU.name,
            provider: PROFILE_HAIKU.provider,
            model: PROFILE_HAIKU.model,
            family: PROFILE_HAIKU.family,
          },
          available: true,
          order: PRODUCERS[seatId] as number,
        };
      }
      if (seatId === JUDGE_SEAT_REVIEW || seatId === "seat-b6") {
        return {
          profile: {
            id: "profile-dev-luna",
            name: "DEV Luna",
            provider: "codex",
            model: "gpt-6-luna",
            family: FAMILY.judge,
          },
          available: true,
          order: seatId === "seat-b6" ? 8 : 9,
        };
      }
      return null;
    },
    resolveWorkspace: () => ({ workspaceId: "ws-start", directory: repoDir }),
    compile: compileDispatch,
    rebuild: rebuild?.host,
    ...extra,
  });
}

async function stored(): Promise<RunRecord> {
  const read = await store.get(RUN_ID);
  if (read.status !== "ok") throw new Error(`run unreadable: ${read.status}`);
  return read.record;
}

const eventsOf = (record: RunRecord, kind: string) =>
  record.events.filter((event) => event.kind === kind);
const rebuildAlerts = (record: RunRecord) =>
  record.alerts.filter((alert) => alert.alertId.startsWith("rebuild-") && alert.state === "open");
/** Every rebuild alert and where it stands: 'open' while true, 'resolved' once it is not. */
const alertStates = (record: RunRecord) =>
  Object.fromEntries(
    record.alerts
      .filter((alert) => alert.alertId.startsWith("rebuild-"))
      .map((alert) => [alert.alertId, alert.state]),
  );
const items = (record: RunRecord) => {
  const read = readSeatRebuilds(record);
  return read.kind === "valid" ? read.items : [];
};
const roster = (record: RunRecord, seatId: string) =>
  record.roster.find((seat) => seat.seatId === seatId)?.agentId;

function spec(seatId: string, over: Partial<AgentSpec> = {}): AgentSpec {
  const prompt = `System prompt of ${seatId}.`;
  return {
    parentSeatId: COORDINATOR_SEAT_ID,
    title: `Builder ${seatId}`,
    labels: { "agent-team.kind": "member", "agent-team.seat": seatId },
    systemPrompt: prompt,
    systemPromptSha256: sha256Hex(prompt),
    profile: {
      id: PROFILE_HAIKU.id,
      name: PROFILE_HAIKU.name,
      provider: PROFILE_HAIKU.provider,
      model: PROFILE_HAIKU.model,
      modeId: "acceptEdits",
      thinkingOptionId: "high",
    },
    roleId: "role-builder",
    mcpServersSha256: mcpServersSha256(undefined),
    ...over,
  };
}

/** Freezes specs for these seats, as the launch does: the pinned prompt hash is what the reader checks them against. */
function freeze(
  record: RunRecord,
  seatIds: string[],
  over: (seatId: string) => Partial<AgentSpec> = () => ({}),
): void {
  const launch = record.launch as Record<string, unknown>;
  const seats: Record<string, AgentSpec> = {};
  const pinned: Record<string, unknown> = {};
  for (const seatId of seatIds) {
    seats[seatId] = spec(seatId, over(seatId));
    pinned[seatId] = {
      template: "member-system",
      version: 1,
      hash: seats[seatId].systemPromptSha256,
    };
  }
  launch.agentSpecs = { version: 1, seats };
  launch.systemPrompts = pinned;
}

function receipt(
  record: RunRecord,
  kind: RunEventReceipt["kind"],
  agentId: string,
  turnId: string | null,
  extra: Record<string, unknown> = {},
): RunEventReceipt {
  const key = `${kind}:${agentId}:${turnId ?? "-"}`;
  return {
    eventKey: key,
    kind,
    agentId,
    turnId,
    seq: record.counters.observationSeq,
    receivedAt: record.updatedAt,
    dedupeKey: key,
    disposition: "observed",
    ...extra,
  } as RunEventReceipt;
}

/** Seat-b1 is out of the way (archived), so the seats a test adds are what the work waits for. */
function archiveB1(record: RunRecord): void {
  record.eventReceipts.push(receipt(record, "archived", B1, null, { disposition: "accepted" }));
}

/** More producer seats on the same Profile, each holding its own Agent. They have never run (class N). */
function withSeats(...seats: { seatId: string; agentId: string }[]): (record: RunRecord) => void {
  return (record) => {
    const first = record.roster.find((seat) => seat.seatId === "seat-b1");
    if (!first) throw new Error("fixture lost seat-b1");
    for (const seat of seats) {
      record.roster.push({ ...first, seatId: seat.seatId, agentId: seat.agentId });
      record.budgets.entries.push({
        scope: "seat",
        subjectId: seat.seatId,
        limit: 6,
        reserved: 0,
        confirmed: 0,
        observedTurns: 0,
      });
    }
  };
}

/** A judge seat of its own that never ran. */
function withJudge(seatId: string, agentId: string): (record: RunRecord) => void {
  return (record) => {
    const judge = record.roster.find((seat) => seat.seatId === JUDGE_SEAT_REVIEW);
    if (!judge) throw new Error("fixture lost the judge seat");
    record.roster.push({ ...judge, seatId, agentId });
    record.budgets.entries.push({
      scope: "seat",
      subjectId: seatId,
      limit: 6,
      reserved: 0,
      confirmed: 0,
      observedTurns: 0,
    });
  };
}

/** The agent started a turn and none of its turns finished (class C). */
function cutOff(record: RunRecord, agentId: string): void {
  record.eventReceipts.push(receipt(record, "turn_started", agentId, "turn-cut"));
}

const coordinatorSeat = {
  seatId: COORDINATOR_SEAT_ID,
  tier: "S" as const,
  agentId: COORD,
  channelId: "claude",
  duties: [COORDINATOR_DUTY],
  enabled: true,
};

async function seed(
  mutate: (record: RunRecord) => void = () => undefined,
  frozenSeats: string[] | null = ["seat-b1", "seat-b3", "seat-b4", "seat-b6"],
): Promise<void> {
  const record = readyRun({ runId: RUN_ID, repoId, evidenceRoot });
  record.schemaVersion = schema;
  if (schema === 2) (record as Record<string, unknown>).readRetries = emptyReadRetries();
  record.roster.push({ ...coordinatorSeat });
  (record.launch as Record<string, unknown>).workspace = { id: "ws-start", directory: repoDir };
  if (frozenSeats !== null) freeze(record, frozenSeats);
  mutate(record);
  await store.create(record);
}

/** t1 delivered a real commit and waits for its review; reviewers are `seat-b2` (done) and what a test adds. */
async function seedReview(mutate: (record: RunRecord) => void = () => undefined): Promise<void> {
  const baseSha = git(repoDir, "rev-parse", "HEAD");
  await writeFile(path.join(repoDir, "src", "t1.ts"), "export const t1 = 1;\n");
  git(repoDir, "add", "--", "src/t1.ts");
  git(repoDir, "commit", "-q", "-m", "deliver t1");
  const headSha = git(repoDir, "rev-parse", "HEAD");
  const record = reviewRun({ runId: RUN_ID, repoId, evidenceRoot, baseSha, headSha });
  record.schemaVersion = schema;
  if (schema === 2) (record as Record<string, unknown>).readRetries = emptyReadRetries();
  record.roster.push({ ...coordinatorSeat });
  (record.launch as Record<string, unknown>).workspace = { id: "ws-start", directory: repoDir };
  freeze(record, ["seat-b1", "seat-b3", "seat-b4", "seat-b6"]);
  mutate(record);
  await store.create(record);
}

function makeDriver(service: ReturnType<typeof makeService>) {
  const none = {} as never;
  return createEngineDriver({
    store,
    observer: { flush: async () => undefined, reconcile: async () => undefined } as never,
    host: none,
    intake: { settleAgent: async () => undefined } as never,
    dagIntake: { settleCoordinator: async () => undefined } as never,
    service,
  });
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), "run-rebuild-")));
  repoDir = path.join(home, "repo");
  await mkdir(path.join(repoDir, "src"), { recursive: true });
  git(repoDir, "init", "-q", "-b", "main");
  await writeFile(path.join(repoDir, "src", "t1.ts"), "export {};\n");
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "-q", "-m", "base");
  const inspected = await inspectRepo(repoDir);
  if (!inspected.ok) throw new Error("fixture repository is not readable");
  repoId = inspected.repo.repoId;
  evidenceRoot = path.join(home, "evidence").replaceAll("\\", "/");
  await mkdir(path.join(home, "paseo"));
  store = createRunStore({ home: path.join(home, "paseo"), lock: { acquireTimeoutMs: 300 } });
  await store.initialize();
});

afterEach(async () => {
  await store.close().catch(() => undefined);
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** Seat-b3 holds an Agent that never ran and the work waits for it; reading it is told to do `how`. */
async function neverRanSeat(how: ReadsAs, extra: (record: RunRecord) => void = () => undefined) {
  await seed((record) => {
    withSeats({ seatId: "seat-b3", agentId: B3 })(record);
    archiveB1(record);
    extra(record);
  });
  const host = fakeHost();
  host.closed.add(B3);
  host.readsAs.set(B3, how);
  return { host, rebuild: fakeRebuild() };
}

/** Seat-b3 holds an Agent whose first turn was cut off. */
async function cutOffSeat(extra: (record: RunRecord) => void = () => undefined) {
  await seed((record) => {
    withSeats({ seatId: "seat-b3", agentId: B3 })(record);
    archiveB1(record);
    cutOff(record, B3);
    extra(record);
  });
  const host = fakeHost();
  host.closed.add(B3);
  return { host, rebuild: fakeRebuild() };
}

for (const version of [1, 2] as const) {
  describe(`rebuilding a member's Agent [v${version}]`, () => {
    beforeEach(() => {
      schema = version;
    });

    if (version === 1) {
      test("a v1 Run has no spec: nothing is created, no attempt is written, and the Run says it can only be cancelled", async () => {
        const { host, rebuild } = await cutOffSeat();
        const result = await makeService(host, rebuild).dispatchNext(RUN_ID);
        expect(result).toMatchObject({ status: "waiting", taskId: "t2" });
        expect(rebuild.created).toHaveLength(0);
        expect(host.sent).toHaveLength(0);
        const record = await stored();
        expect(readSeatRebuilds(record).kind).toBe("absent");
        expect(roster(record, "seat-b3")).toBe(B3);
        expect(rebuildAlerts(record).map((alert) => alert.summary)).toEqual([
          expect.stringContaining("Engine 无法重建席位 seat-b3"),
        ]);
        expect(rebuildAlerts(record)[0]?.summary).toContain("0.8.0 之前启动");
        expect(rebuildAlerts(record)[0]?.summary).toContain("取消这个 Run 后重新启动");
        expect(eventsOf(record, "seat-rebound")).toHaveLength(0);
      });

      test("E2b: a v1 Run's member that never ran and cannot be opened (the host reads it idle after a kill) is read once, gets nothing, and the Run says it can only be cancelled", async () => {
        await seed((record) => {
          withSeats({ seatId: "seat-b3", agentId: B3 })(record);
          archiveB1(record);
        });
        const host = fakeHost();
        host.readsAs.set(B3, "throws");
        const rebuild = fakeRebuild();
        const service = makeService(host, rebuild);
        expect(await service.dispatchNext(RUN_ID)).toMatchObject({
          status: "waiting",
          taskId: "t2",
        });
        await service.dispatchNext(RUN_ID);
        expect(host.timelineReads).toEqual([B3]);
        expect(host.sent).toHaveLength(0);
        expect(rebuild.created).toHaveLength(0);
        const record = await stored();
        expect(roster(record, "seat-b3")).toBe(B3);
        expect(rebuildAlerts(record)[0]?.summary).toContain("取消这个 Run 后重新启动");
      });
      return;
    }

    test("C: a member whose first turn was cut off is not read; its Agent is made again from the frozen spec and gets the work once", async () => {
      const { host, rebuild } = await cutOffSeat();
      const service = makeService(host, rebuild);
      const result = await service.dispatchNext(RUN_ID);

      expect(result).toMatchObject({ status: "dispatched", seatId: "seat-b3", purpose: "member" });
      expect(host.timelineReads).toEqual([]);
      expect(rebuild.created).toHaveLength(1);
      const request = rebuild.created[0] as CreateMemberInput;
      const frozen = spec("seat-b3");
      expect(request).toMatchObject({
        workspaceId: "ws-start",
        parentAgentId: COORD,
        title: "Builder seat-b3（重建 1）",
        labels: frozen.labels,
        systemPrompt: frozen.systemPrompt,
        profile: frozen.profile,
        idempotencyKey: KEY("seat-b3", 1),
      });
      // Creating the Agent must not start a turn.
      expect(request.prompt).toBeUndefined();
      expect(request.mcpServers).toBeUndefined();

      const record = await stored();
      const fresh = rebuild.byKey.get(KEY("seat-b3", 1)) ?? "";
      expect(roster(record, "seat-b3")).toBe(fresh);
      expect(items(record)).toEqual([
        expect.objectContaining({
          rebuildId: "rebuild-seat-b3-g1",
          seatId: "seat-b3",
          generation: 1,
          fromAgentId: B3,
          toAgentId: fresh,
          state: "bound",
          error: null,
        }),
      ]);
      expect(eventsOf(record, "seat-rebound")).toEqual([
        expect.objectContaining({
          payload: {
            seatId: "seat-b3",
            fromAgentId: B3,
            toAgentId: fresh,
            rebuildId: "rebuild-seat-b3-g1",
            generation: 1,
          },
        }),
      ]);
      // The work went to the new Agent, once; the old one was never written to.
      expect(host.sent.map((entry) => entry.agentId)).toEqual([fresh]);
      const assignment = record.assignments.find((entry) => entry.seatId === "seat-b3");
      expect(assignment?.agentId).toBe(fresh);
      expect(checkLedgerInvariants(record)).toEqual({ ok: true });
      // 'Being rebuilt' and 'rebuilt' were up, and the second came down when the new Agent's dispatch was
      // confirmed (here, in the same pass); the closed-seat warning never was.
      expect(alertStates(record)).toEqual({
        "rebuild-creating-seat-b3-g1": "resolved",
        "rebuild-bound-seat-b3-g1": "resolved",
      });
      expect(
        record.alerts.find((alert) => alert.alertId === "rebuild-bound-seat-b3-g1")?.summary,
      ).toContain("已按启动时冻结的配置为席位 seat-b3 新建 Agent（第 1 次）");
      expect(
        record.alerts.some((alert) => alert.summary.startsWith("有任务在等一个已关闭的席位")),
      ).toBe(false);

      // Further looks create and send nothing more.
      await service.dispatchNext(RUN_ID);
      await service.dispatchNext(RUN_ID);
      expect(rebuild.created).toHaveLength(1);
      expect(host.sent).toHaveLength(1);
      expect(rebuildAlerts(await stored())).toEqual([]);
      expect(items(await stored())).toHaveLength(1);
    });

    test("N: a member that never ran and cannot be opened (the read throws) is rebuilt once, after the read, and gets the work", async () => {
      const { host, rebuild } = await neverRanSeat("throws");
      const result = await makeService(host, rebuild).dispatchNext(RUN_ID);

      expect(result).toMatchObject({ status: "dispatched", seatId: "seat-b3" });
      // It was read exactly once (what T11a does), and only then rebuilt.
      expect(host.timelineReads).toEqual([B3]);
      expect(rebuild.created).toHaveLength(1);
      const fresh = rebuild.byKey.get(KEY("seat-b3", 1)) ?? "";
      expect(host.sent.map((entry) => entry.agentId)).toEqual([fresh]);
      expect(roster(await stored(), "seat-b3")).toBe(fresh);
    });

    test("N: a read that works but leaves the seat closed counts as not opened: it is rebuilt", async () => {
      const { host, rebuild } = await neverRanSeat("stays");
      expect(await makeService(host, rebuild).dispatchNext(RUN_ID)).toMatchObject({
        status: "dispatched",
      });
      expect(rebuild.created).toHaveLength(1);
    });

    test("N: a read that opens it is not rebuilt", async () => {
      const { host, rebuild } = await neverRanSeat("opens");
      const result = await makeService(host, rebuild).dispatchNext(RUN_ID);
      expect(result).toMatchObject({ status: "dispatched", seatId: "seat-b3" });
      expect(host.sent.map((entry) => entry.agentId)).toEqual([B3]);
      expect(rebuild.created).toHaveLength(0);
      expect(readSeatRebuilds(await stored()).kind).toBe("absent");
    });

    test("N: the person's check reads again; a read that now works opens it and nothing is rebuilt on top of it", async () => {
      const { host, rebuild } = await neverRanSeat("throws");
      // Nobody has to rebuild for a seat the rebuild cannot be allowed: no spec for it this time.
      const service = makeService(host, rebuild);
      rebuild.roles.set("role-builder", { status: "missing" });
      await service.dispatchNext(RUN_ID);
      expect(rebuild.created).toHaveLength(0);
      host.readsAs.set(B3, "opens");
      service.grantReopen(RUN_ID);
      const result = await service.dispatchNext(RUN_ID);
      expect(result).toMatchObject({ status: "dispatched", seatId: "seat-b3" });
      expect(host.sent.map((entry) => entry.agentId)).toEqual([B3]);
      expect(rebuild.created).toHaveLength(0);
    });

    test("P: a member that finished a turn is never rebuilt, however its read ends", async () => {
      await seed();
      const host = fakeHost();
      host.closed.add(B1);
      host.readsAs.set(B1, "throws");
      const rebuild = fakeRebuild();
      const service = makeService(host, rebuild);
      const result = await service.dispatchNext(RUN_ID);
      expect(result).toMatchObject({ status: "waiting", taskId: "t2" });
      expect(host.timelineReads).toEqual([B1]);
      expect(rebuild.created).toHaveLength(0);
      const held = await stored();
      expect(readSeatRebuilds(held).kind).toBe("absent");
      expect(roster(held, "seat-b1")).toBe(B1);
      expect(held.alerts.filter((alert) => alert.state === "open")).toHaveLength(1);
      expect(rebuildAlerts(held)).toEqual([]);
    });

    test("P by its receipts alone: a member that finished a turn is not rebuilt even where nothing else in the ledger stops it", async () => {
      await seed((record) => {
        withSeats({ seatId: "seat-b3", agentId: B3 })(record);
        archiveB1(record);
        record.eventReceipts.push(receipt(record, "turn_started", B3, "turn-done"));
        record.eventReceipts.push(receipt(record, "turn_ended", B3, "turn-done"));
      });
      const host = fakeHost();
      host.closed.add(B3);
      host.readsAs.set(B3, "throws");
      const rebuild = fakeRebuild();
      const result = await makeService(host, rebuild).dispatchNext(RUN_ID);
      expect(result).toMatchObject({ status: "waiting", taskId: "t2" });
      expect(host.timelineReads).toEqual([B3]);
      expect(rebuild.created).toHaveLength(0);
      expect(readSeatRebuilds(await stored()).kind).toBe("absent");
      expect(roster(await stored(), "seat-b3")).toBe(B3);
    });

    test("a closed seat the pass did not get to read is not rebuilt before it has been read", async () => {
      await seed(
        (record) => {
          withSeats(
            { seatId: "seat-b3", agentId: B3 },
            { seatId: "seat-b4", agentId: B4 },
            { seatId: "seat-b5", agentId: "agent-b5" },
          )(record);
          archiveB1(record);
          // The first two cannot be rebuilt (their Role is gone), so the third is the one that could be.
          const seats = (
            record.launch as unknown as { agentSpecs: { seats: Record<string, AgentSpec> } }
          ).agentSpecs.seats;
          for (const seatId of ["seat-b3", "seat-b4"]) {
            (seats[seatId] as AgentSpec).roleId = "role-gone";
          }
        },
        ["seat-b1", "seat-b3", "seat-b4", "seat-b5", "seat-b6"],
      );
      const host = fakeHost();
      for (const agent of [B3, B4, "agent-b5"]) {
        host.closed.add(agent);
        host.readsAs.set(agent, "throws");
      }
      const rebuild = fakeRebuild();
      const service = makeService(host, rebuild);
      await service.dispatchNext(RUN_ID);
      // Two reads a pass: the third seat has not been tried by reading, so it is not rebuilt yet.
      expect(host.timelineReads).toEqual([B3, B4]);
      expect(rebuild.created).toHaveLength(0);

      const result = await service.dispatchNext(RUN_ID);
      expect(host.timelineReads).toEqual([B3, B4, "agent-b5"]);
      expect(rebuild.created.map((request) => request.idempotencyKey)).toEqual([KEY("seat-b5", 1)]);
      expect(result).toMatchObject({ status: "dispatched", seatId: "seat-b5" });
    });

    test("the first seat that can be rebuilt is rebuilt: a finished seat ahead of a cut-off one does not hold it up", async () => {
      await seed((record) => {
        withSeats({ seatId: "seat-b3", agentId: B3 })(record);
        cutOff(record, B3);
      });
      const host = fakeHost();
      // seat-b1 (finished a turn, order 0) and seat-b3 (cut off, order 1) are both closed.
      host.closed.add(B1);
      host.closed.add(B3);
      host.readsAs.set(B1, "throws");
      const rebuild = fakeRebuild();
      const result = await makeService(host, rebuild).dispatchNext(RUN_ID);

      expect(result).toMatchObject({ status: "dispatched", seatId: "seat-b3" });
      expect(host.timelineReads).toEqual([B1]);
      expect(rebuild.created.map((request) => request.idempotencyKey)).toEqual([KEY("seat-b3", 1)]);
      const record = await stored();
      expect(roster(record, "seat-b1")).toBe(B1);
      expect(items(record).map((item) => item.seatId)).toEqual(["seat-b3"]);
    });

    test("the review seat: a judge that never ran and cannot be opened is rebuilt, and the review goes to the new Agent exactly once", async () => {
      await seedReview((record) => {
        withJudge("seat-b6", B6)(record);
        record.eventReceipts.push(
          receipt(record, "archived", B2, null, { disposition: "accepted" }),
        );
      });
      const host = fakeHost();
      host.closed.add(B6);
      host.readsAs.set(B6, "throws");
      const rebuild = fakeRebuild();
      const service = makeService(host, rebuild);
      const result = await service.dispatchNext(RUN_ID);

      expect(result).toMatchObject({
        status: "dispatched",
        purpose: "reviewer",
        seatId: "seat-b6",
      });
      const fresh = rebuild.byKey.get(KEY("seat-b6", 1)) ?? "";
      expect(host.sent.map((entry) => entry.agentId)).toEqual([fresh]);
      expect(rebuild.created).toHaveLength(1);
      expect(rebuild.created[0]?.title).toBe("Builder seat-b6（重建 1）");
      // The producer is untouched.
      expect(roster(await stored(), "seat-b1")).toBe(B1);
      await service.dispatchNext(RUN_ID);
      expect(host.sent).toHaveLength(1);
      expect(rebuild.created).toHaveLength(1);
    });

    test("a review that the family gate would refuse for this seat is not rebuilt for", async () => {
      await seedReview((record) => {
        const t1 = record.tasks.find((task) => task.spec.id === "t1");
        if (t1) t1.spec.level = "L1";
        const judge = record.roster.find((seat) => seat.seatId === JUDGE_SEAT_REVIEW);
        if (judge) judge.tier = "B";
        withJudge("seat-b6", B6)(record);
        const six = record.roster.find((seat) => seat.seatId === "seat-b6");
        if (six) six.tier = "B";
        record.eventReceipts.push(
          receipt(record, "archived", B2, null, { disposition: "accepted" }),
        );
      });
      const host = fakeHost();
      host.closed.add(B6);
      host.readsAs.set(B6, "throws");
      const rebuild = fakeRebuild();
      // The judge is of the producer's own family: an L1 review needs another one.
      const service = createEngineService({
        ...({} as EngineServiceOptions),
        store,
        port: host.port,
        effects: createEffects({ store, port: host.port, compile: compileDispatch }),
        resolveSeat: (_record, seatId) =>
          seatId === "seat-b6" || seatId === JUDGE_SEAT_REVIEW
            ? {
                profile: {
                  id: "p",
                  name: "P",
                  provider: "x",
                  model: null,
                  family: FAMILY.producer,
                },
                available: true,
                order: 1,
              }
            : seatId === "seat-b1"
              ? {
                  profile: {
                    id: "p",
                    name: "P",
                    provider: "x",
                    model: null,
                    family: FAMILY.producer,
                  },
                  available: true,
                  order: 0,
                }
              : null,
        resolveWorkspace: () => ({ workspaceId: "ws-start", directory: repoDir }),
        compile: compileDispatch,
        rebuild: rebuild.host,
      });
      const result = await service.dispatchNext(RUN_ID);
      expect(result).toMatchObject({ status: "waiting", taskId: "t1" });
      expect(host.timelineReads).toEqual([]);
      expect(rebuild.created).toHaveLength(0);
      expect(readSeatRebuilds(await stored()).kind).toBe("absent");
    });

    describe("nothing is started", () => {
      const nothing = async (host: Host, rebuild: Rebuild) => {
        const result = await makeService(host, rebuild).dispatchNext(RUN_ID);
        expect(rebuild.created).toHaveLength(0);
        expect(host.sent).toHaveLength(0);
        expect(readSeatRebuilds(await stored()).kind).toBe("absent");
        expect(rebuildAlerts(await stored())).toEqual([]);
        return result;
      };

      test("a seat that has been archived", async () => {
        await seed((record) => {
          withSeats({ seatId: "seat-b3", agentId: B3 })(record);
          archiveB1(record);
          cutOff(record, B3);
          record.eventReceipts.push(
            receipt(record, "archived", B3, null, { disposition: "accepted" }),
          );
        });
        const host = fakeHost();
        host.closed.add(B3);
        await nothing(host, fakeRebuild());
      });

      test("a Run that is paused, awaiting its DAG, finished or cancelled", async () => {
        for (const lifecycle of ["paused", "awaiting-dag", "finished", "cancelled"] as const) {
          await store.close();
          await rm(path.join(home, "paseo"), { recursive: true, force: true });
          await mkdir(path.join(home, "paseo"));
          store = createRunStore({
            home: path.join(home, "paseo"),
            lock: { acquireTimeoutMs: 300 },
          });
          await store.initialize();
          await seed((record) => {
            withSeats({ seatId: "seat-b3", agentId: B3 })(record);
            archiveB1(record);
            cutOff(record, B3);
            record.lifecycle = lifecycle;
          });
          const host = fakeHost();
          host.closed.add(B3);
          await nothing(host, fakeRebuild());
        }
      });

      test("a Run that is being cancelled", async () => {
        const { host, rebuild } = await cutOffSeat((record) => {
          Object.assign(
            record,
            withCancelRequest(record, {
              version: CANCEL_REQUEST_VERSION,
              requestId: "cancel-1",
              reason: "stop",
              requestedAt: record.updatedAt,
              completedAt: null,
            }),
          );
        });
        await nothing(host, rebuild);
      });

      test("a launch that is not running", async () => {
        const { host, rebuild } = await cutOffSeat((record) => {
          record.launch.state = "kickoff-pending";
        });
        await nothing(host, rebuild);
      });

      test("an idle Run reads and creates nothing", async () => {
        await seed((record) => {
          const t2 = record.tasks.find((task) => task.spec.id === "t2");
          if (t2) t2.state = "pending";
          cutOff(record, B1);
        });
        const host = fakeHost();
        host.closed.add(B1);
        const rebuild = fakeRebuild();
        expect(await makeService(host, rebuild).dispatchNext(RUN_ID)).toEqual({ status: "idle" });
        expect(rebuild.created).toHaveLength(0);
        expect(rebuild.state.reads).toBe(0);
      });

      test("a service built without the rebuild host never rebuilds", async () => {
        const { host } = await cutOffSeat();
        const result = await makeService(host, null).dispatchNext(RUN_ID);
        expect(result).toMatchObject({ status: "waiting" });
        expect(readSeatRebuilds(await stored()).kind).toBe("absent");
      });
    });

    describe("the Run changes between the look and the attempt: it is judged again in the commit that writes it", () => {
      const raced = async (change: (record: RunRecord) => void) => {
        const { host, rebuild } = await cutOffSeat();
        rebuild.state.onReadRole = async () => {
          await store.update(RUN_ID, (record) => {
            change(record);
            return record;
          });
        };
        await makeService(host, rebuild).dispatchNext(RUN_ID);
        expect(rebuild.created).toHaveLength(0);
        expect(host.sent).toHaveLength(0);
        const record = await stored();
        expect(readSeatRebuilds(record).kind).toBe("absent");
        expect(roster(record, "seat-b3")).toBe(B3);
      };

      test("paused", async () => {
        await raced((record) => {
          record.lifecycle = "paused";
        });
      });

      test("asked to cancel", async () => {
        await raced((record) => {
          Object.assign(
            record,
            withCancelRequest(record, {
              version: CANCEL_REQUEST_VERSION,
              requestId: "cancel-race",
              reason: "stop",
              requestedAt: record.updatedAt,
              completedAt: null,
            }),
          );
        });
      });

      test("the launch is no longer running", async () => {
        await raced((record) => {
          record.launch.state = "kickoff-pending";
        });
      });

      test("the seat's Agent is archived", async () => {
        await raced((record) => {
          record.eventReceipts.push(
            receipt(record, "archived", B3, null, { disposition: "accepted" }),
          );
        });
      });
    });

    describe("what cannot be rebuilt writes no attempt and uses no generation", () => {
      const expectWarning = async (rebuild: Rebuild, host: Host, text: string) => {
        const record = await stored();
        expect(rebuild.created).toHaveLength(0);
        expect(host.sent).toHaveLength(0);
        expect(readSeatRebuilds(record).kind).toBe("absent");
        expect(roster(record, "seat-b3")).toBe(B3);
        const alerts = rebuildAlerts(record);
        expect(alerts).toHaveLength(1);
        expect(alerts[0]?.summary).toContain("Engine 无法重建席位 seat-b3");
        expect(alerts[0]?.summary).toContain(text);
        expect(alerts[0]?.summary).toContain("取消这个 Run 后重新启动");
      };

      test("the Role's MCP configuration is not the one the Run started with: one warning, nothing created, and it works again once the Role is back", async () => {
        const { host, rebuild } = await cutOffSeat();
        rebuild.roles.set("role-builder", {
          status: "found",
          mcpServers: { docs: { command: "node", args: ["other.js"] } },
        });
        const service = makeService(host, rebuild);
        await service.dispatchNext(RUN_ID);
        await expectWarning(rebuild, host, "MCP 配置和启动时不一样");
        // Asking again writes nothing new.
        const before = await stored();
        await service.dispatchNext(RUN_ID);
        expect((await stored()).revision).toBe(before.revision);

        rebuild.roles.set("role-builder", { status: "found", mcpServers: undefined });
        const result = await service.dispatchNext(RUN_ID);
        expect(result).toMatchObject({ status: "dispatched", seatId: "seat-b3" });
        const record = await stored();
        expect(items(record).map((item) => [item.generation, item.state])).toEqual([[1, "bound"]]);
        // The warning that it could not be rebuilt is gone with the problem.
        expect(alertStates(record)).toEqual({
          "rebuild-unable-mcp-changed-seat-b3": "resolved",
          "rebuild-creating-seat-b3-g1": "resolved",
          "rebuild-bound-seat-b3-g1": "resolved",
        });
      });

      test("the Role is gone or cannot be read", async () => {
        const { host, rebuild } = await cutOffSeat();
        rebuild.roles.delete("role-builder");
        await makeService(host, rebuild).dispatchNext(RUN_ID);
        await expectWarning(rebuild, host, "Role 已找不到或读不出来");
      });

      test("the frozen prompt is not the one whose digest was kept", async () => {
        const { host, rebuild } = await cutOffSeat((record) => {
          const specs = (record.launch as Record<string, { seats: Record<string, AgentSpec> }>)
            .agentSpecs;
          const mine = specs?.seats["seat-b3"];
          if (mine) mine.systemPrompt = "Somebody edited this.";
        });
        await makeService(host, rebuild).dispatchNext(RUN_ID);
        await expectWarning(rebuild, host, "系统提示词和启动时记下的摘要对不上");
      });

      test("a Run started before specs were frozen has none", async () => {
        const { host, rebuild } = await cutOffSeat((record) => {
          delete (record.launch as Record<string, unknown>).agentSpecs;
        });
        await makeService(host, rebuild).dispatchNext(RUN_ID);
        await expectWarning(rebuild, host, "0.8.0 之前启动");
      });

      test("a seat that was left out of the specs (too large) cannot be rebuilt; another that fits still is", async () => {
        await seed((record) => {
          withSeats({ seatId: "seat-b3", agentId: B3 }, { seatId: "seat-b4", agentId: B4 })(record);
          archiveB1(record);
          cutOff(record, B3);
          cutOff(record, B4);
          freeze(record, ["seat-b1", "seat-b4", "seat-b6"]);
        });
        const host = fakeHost();
        host.closed.add(B3);
        host.closed.add(B4);
        const rebuild = fakeRebuild();
        const result = await makeService(host, rebuild).dispatchNext(RUN_ID);

        expect(result).toMatchObject({ status: "dispatched", seatId: "seat-b4" });
        const record = await stored();
        expect(rebuild.created.map((request) => request.idempotencyKey)).toEqual([
          KEY("seat-b4", 1),
        ]);
        expect(items(record).map((item) => item.seatId)).toEqual(["seat-b4"]);
        expect(roster(record, "seat-b3")).toBe(B3);
        // b3 got its warning (the work was held when it was looked at); it went when b4 took the work.
        expect(alertStates(record)).toEqual({
          "rebuild-unable-no-spec-seat-b3": "resolved",
          "rebuild-creating-seat-b4-g1": "resolved",
          "rebuild-bound-seat-b4-g1": "resolved",
        });
      });

      test("records of the Run that cannot be read: nothing is started, and the Run says so", async () => {
        const { host, rebuild } = await cutOffSeat((record) => {
          (record as Record<string, unknown>).seatRebuilds = { version: 9, items: "?" };
        });
        const service = makeService(host, rebuild);
        await service.dispatchNext(RUN_ID);
        await service.dispatchNext(RUN_ID);
        const record = await stored();
        expect(rebuild.created).toHaveLength(0);
        expect(readSeatRebuilds(record).kind).toBe("invalid");
        expect((record as Record<string, unknown>).seatRebuilds).toEqual({
          version: 9,
          items: "?",
        });
        expect(rebuildAlerts(record).map((alert) => alert.summary)).toEqual([
          expect.stringContaining("重建记录读不懂"),
        ]);
      });

      test("the warning goes with the hold: when the seat is open again nothing is left to say", async () => {
        const { host, rebuild } = await cutOffSeat();
        rebuild.roles.delete("role-builder");
        const service = makeService(host, rebuild);
        await service.dispatchNext(RUN_ID);
        expect(rebuildAlerts(await stored())).toHaveLength(1);
        host.closed.delete(B3);
        expect(await service.dispatchNext(RUN_ID)).toMatchObject({ status: "dispatched" });
        expect(rebuildAlerts(await stored())).toEqual([]);
      });
    });

    describe("a rebuild that fails, and the generations", () => {
      test("three creates with the same key fail: one failed attempt that says only a code, one warning, nothing sent", async () => {
        const { host, rebuild } = await cutOffSeat();
        rebuild.state.failures = 99;
        rebuild.state.failWith = () => new Error("secret detail: token sk-123");
        const service = makeService(host, rebuild);
        const result = await service.dispatchNext(RUN_ID);

        expect(result).toMatchObject({ status: "waiting", taskId: "t2" });
        expect(rebuild.created.map((request) => request.idempotencyKey)).toEqual([
          KEY("seat-b3", 1),
          KEY("seat-b3", 1),
          KEY("seat-b3", 1),
        ]);
        const record = await stored();
        expect(items(record)).toEqual([
          expect.objectContaining({
            generation: 1,
            state: "failed",
            toAgentId: null,
            error: "create-failed",
          }),
        ]);
        expect(JSON.stringify(record)).not.toContain("sk-123");
        expect(roster(record, "seat-b3")).toBe(B3);
        expect(host.sent).toHaveLength(0);
        const alerts = rebuildAlerts(record);
        expect(alerts).toHaveLength(1);
        expect(alerts[0]?.summary).toContain(
          "重建席位 seat-b3 的 Agent 失败（第 1 次，原因码 create-failed）",
        );
        expect(alerts[0]?.summary).toContain("立即检查并推进");
      });

      test("a failed attempt is not tried again by the passes that follow, a recovery or a hook; only the person's check opens the second generation", async () => {
        const { host, rebuild } = await cutOffSeat();
        rebuild.state.failures = 3;
        const service = makeService(host, rebuild);
        const driver = makeDriver(service);
        await driver.kick(RUN_ID);
        expect(rebuild.created).toHaveLength(3);

        await driver.kick(RUN_ID);
        await driver.recover();
        await driver.retryRun(RUN_ID, { afterWrite: true });
        await driver.retryRun(RUN_ID);
        expect(rebuild.created).toHaveLength(3);
        expect(items(await stored()).map((item) => item.generation)).toEqual([1]);

        // The person's check: the second generation, with a key of its own.
        const report = await driver.retryRun(RUN_ID, { byPerson: true });
        expect(report.dispatched).toBe(1);
        expect(rebuild.created.map((request) => request.idempotencyKey).at(-1)).toBe(
          KEY("seat-b3", 2),
        );
        expect(rebuild.created.at(-1)?.title).toBe("Builder seat-b3（重建 2）");
        const record = await stored();
        expect(items(record).map((item) => [item.generation, item.state])).toEqual([
          [1, "failed"],
          [2, "bound"],
        ]);
        expect(roster(record, "seat-b3")).toBe(rebuild.byKey.get(KEY("seat-b3", 2)));
        // The first generation's warning is gone, and so is the second's 'rebuilt' (its dispatch is confirmed).
        expect(alertStates(record)).toEqual({
          "rebuild-creating-seat-b3-g1": "resolved",
          "rebuild-failed-seat-b3-g1": "resolved",
          "rebuild-creating-seat-b3-g2": "resolved",
          "rebuild-bound-seat-b3-g2": "resolved",
        });
      });

      test("a restart does not open the second generation either: the process that starts has to be asked by a person", async () => {
        const { host, rebuild } = await cutOffSeat();
        rebuild.state.failures = 3;
        await makeDriver(makeService(host, rebuild)).kick(RUN_ID);
        expect(rebuild.created).toHaveLength(3);

        // A new process: nothing in memory, the failed attempt is on the ledger.
        const second = makeService(host, rebuild);
        const driver = makeDriver(second);
        await driver.recover();
        await driver.kick(RUN_ID);
        await driver.kick(RUN_ID);
        expect(rebuild.created).toHaveLength(3);
        expect(items(await stored()).map((item) => item.state)).toEqual(["failed"]);

        await driver.retryRun(RUN_ID, { byPerson: true });
        expect(items(await stored()).map((item) => [item.generation, item.state])).toEqual([
          [1, "failed"],
          [2, "bound"],
        ]);
      });

      test("a second generation that fails too is the last: there is no third, whoever asks", async () => {
        const { host, rebuild } = await cutOffSeat();
        rebuild.state.failures = 6;
        const driver = makeDriver(makeService(host, rebuild));
        await driver.kick(RUN_ID);
        await driver.retryRun(RUN_ID, { byPerson: true });
        expect(rebuild.created).toHaveLength(6);
        expect(items(await stored()).map((item) => [item.generation, item.state])).toEqual([
          [1, "failed"],
          [2, "failed"],
        ]);

        rebuild.state.failures = 0;
        await driver.retryRun(RUN_ID, { byPerson: true });
        await driver.retryRun(RUN_ID, { byPerson: true });
        await driver.recover();
        expect(rebuild.created).toHaveLength(6);
        const record = await stored();
        expect(items(record)).toHaveLength(2);
        expect(roster(record, "seat-b3")).toBe(B3);
        // The last failure is what the Run says.
        expect(rebuildAlerts(record).map((alert) => alert.alertId)).toEqual([
          "rebuild-failed-seat-b3-g2",
        ]);
      });

      test("the person's click is good for the look it brings and no other", async () => {
        const { host, rebuild } = await cutOffSeat();
        rebuild.state.failures = 3;
        const service = makeService(host, rebuild);
        await service.dispatchNext(RUN_ID);
        service.grantReopen(RUN_ID);
        // The look the click brought found nothing to do (the Run is paused); it still spends the permission.
        await store.update(RUN_ID, (record) => {
          record.lifecycle = "paused";
          return record;
        });
        await service.dispatchNext(RUN_ID);
        await store.update(RUN_ID, (record) => {
          record.lifecycle = "active";
          return record;
        });
        await service.dispatchNext(RUN_ID);
        expect(rebuild.created).toHaveLength(3);
      });

      test("the host saying the key is taken stops at once with its own code", async () => {
        const { host, rebuild } = await cutOffSeat();
        rebuild.state.failures = 9;
        rebuild.state.failWith = () =>
          Object.assign(new Error("conflict"), { code: "agent_request_key_conflict" });
        await makeService(host, rebuild).dispatchNext(RUN_ID);
        expect(rebuild.created).toHaveLength(1);
        expect(items(await stored())[0]).toMatchObject({ state: "failed", error: "key-conflict" });
      });

      test("a parent the host has not loaded is read once and the create is asked again with the same key", async () => {
        const { host, rebuild } = await cutOffSeat();
        rebuild.state.failures = 1;
        rebuild.state.failWith = () => new Error("parent agent is not loaded");
        const result = await makeService(host, rebuild).dispatchNext(RUN_ID);
        expect(result).toMatchObject({ status: "dispatched", seatId: "seat-b3" });
        expect(host.timelineReads).toEqual([COORD]);
        expect(rebuild.created).toHaveLength(2);
        expect(new Set(rebuild.created.map((request) => request.idempotencyKey)).size).toBe(1);
      });
    });

    describe("a crash in the middle", () => {
      /** The attempt is on the ledger, as the process that died after writing it left it. */
      async function afterCreatingRecord(frozenOk = true) {
        const { host, rebuild } = await cutOffSeat();
        await store.update(RUN_ID, (record) => {
          const started = startRebuildRecord(
            record,
            {
              seatId: "seat-b3",
              generation: 1,
              fromAgentId: B3,
              title: "Builder seat-b3（重建 1）",
              reason: "turn-cut-off",
            },
            record.updatedAt,
          );
          return frozenOk ? started.next : record;
        });
        return { host, rebuild };
      }

      test("after the record and before the create: the next look creates with the same key, binds once and sends once", async () => {
        const { host, rebuild } = await afterCreatingRecord();
        const service = makeService(host, rebuild);
        const result = await service.dispatchNext(RUN_ID);
        expect(result).toMatchObject({ status: "dispatched", seatId: "seat-b3" });
        expect(rebuild.created.map((request) => request.idempotencyKey)).toEqual([
          KEY("seat-b3", 1),
        ]);
        const record = await stored();
        expect(items(record).map((item) => item.state)).toEqual(["bound"]);
        expect(eventsOf(record, "seat-rebound")).toHaveLength(1);
        expect(host.sent).toHaveLength(1);
        await service.dispatchNext(RUN_ID);
        expect(rebuild.created).toHaveLength(1);
        expect(eventsOf(await stored(), "seat-rebound")).toHaveLength(1);
      });

      test("after the Agent was made and before it was bound: the same key gives the same Agent, so there is one, and it is bound once", async () => {
        const { host, rebuild } = await afterCreatingRecord();
        // The host made it for the process that died; the answer never reached the ledger.
        rebuild.byKey.set(KEY("seat-b3", 1), "agent-made-before-the-crash");
        const service = makeService(host, rebuild);
        await service.dispatchNext(RUN_ID);
        const record = await stored();
        expect(roster(record, "seat-b3")).toBe("agent-made-before-the-crash");
        expect(new Set(rebuild.byKey.values()).size).toBe(1);
        expect(items(record)).toEqual([
          expect.objectContaining({ state: "bound", toAgentId: "agent-made-before-the-crash" }),
        ]);
        expect(eventsOf(record, "seat-rebound")).toHaveLength(1);
        // A second process doing the same finds it done.
        const again = makeService(host, rebuild);
        await again.dispatchNext(RUN_ID);
        await makeDriver(again).recover();
        expect(eventsOf(await stored(), "seat-rebound")).toHaveLength(1);
        expect(new Set(rebuild.byKey.values()).size).toBe(1);
      });

      test("the commit that binds is lost: the attempt stays creating and the next look binds the same Agent", async () => {
        const { host, rebuild } = await cutOffSeat();
        const real = store.update.bind(store);
        let failBind = true;
        const flaky = new Proxy(store, {
          get(target, prop) {
            if (prop !== "update") return Reflect.get(target, prop);
            return async (runId: string, change: Parameters<RunStore["update"]>[1]) => {
              if (failBind && rebuild.created.length > 0) {
                failBind = false;
                throw new Error("the disk said no");
              }
              return real(runId, change);
            };
          },
        }) as RunStore;
        const effects = createEffects({ store, port: host.port, compile: compileDispatch });
        const build = (s: RunStore) =>
          createEngineService({
            store: s,
            port: host.port,
            effects,
            resolveSeat: (_record, seatId) =>
              seatId in PRODUCERS
                ? {
                    profile: {
                      id: PROFILE_HAIKU.id,
                      name: PROFILE_HAIKU.name,
                      provider: PROFILE_HAIKU.provider,
                      model: PROFILE_HAIKU.model,
                      family: PROFILE_HAIKU.family,
                    },
                    available: true,
                    order: PRODUCERS[seatId] as number,
                  }
                : null,
            resolveWorkspace: () => ({ workspaceId: "ws-start", directory: repoDir }),
            compile: compileDispatch,
            rebuild: rebuild.host,
          });
        await build(flaky).dispatchNext(RUN_ID);
        expect(items(await stored()).map((item) => item.state)).toEqual(["creating"]);
        expect(host.sent).toHaveLength(0);
        await build(store).dispatchNext(RUN_ID);
        const record = await stored();
        expect(items(record).map((item) => item.state)).toEqual(["bound"]);
        expect(new Set(rebuild.byKey.values()).size).toBe(1);
        expect(eventsOf(record, "seat-rebound")).toHaveLength(1);
        expect(host.sent).toHaveLength(1);
      });

      test("a recovery after the restart carries it on the same way, and so does a plain kick", async () => {
        const { host, rebuild } = await afterCreatingRecord();
        const driver = makeDriver(makeService(host, rebuild));
        await driver.recover();
        expect(items(await stored()).map((item) => item.state)).toEqual(["bound"]);
        expect(rebuild.created).toHaveLength(1);
        await driver.kick(RUN_ID);
        await driver.recover();
        expect(rebuild.created).toHaveLength(1);
        expect(eventsOf(await stored(), "seat-rebound")).toHaveLength(1);
        expect(host.sent).toHaveLength(1);
      });

      test("a Run that is over when it is found: the attempt is closed as failed and nothing is created", async () => {
        const { host, rebuild } = await afterCreatingRecord();
        await store.update(RUN_ID, (record) => {
          record.lifecycle = "cancelled";
          return record;
        });
        await makeService(host, rebuild).dispatchNext(RUN_ID);
        expect(rebuild.created).toHaveLength(0);
        expect(items(await stored())[0]).toMatchObject({ state: "failed", error: "run-ended" });
        expect(rebuildAlerts(await stored())).toEqual([]);
      });

      test("the Role's MCP configuration changed while it was down: the attempt is failed with that code and nothing is created", async () => {
        const { host, rebuild } = await afterCreatingRecord();
        rebuild.roles.set("role-builder", {
          status: "found",
          mcpServers: { x: { command: "other" } },
        });
        await makeService(host, rebuild).dispatchNext(RUN_ID);
        expect(rebuild.created).toHaveLength(0);
        expect(items(await stored())[0]).toMatchObject({ state: "failed", error: "mcp-changed" });
      });

      test("a paused Run still gets its attempt finished, and sends nothing until it is resumed", async () => {
        const { host, rebuild } = await afterCreatingRecord();
        await store.update(RUN_ID, (record) => {
          record.lifecycle = "paused";
          return record;
        });
        const service = makeService(host, rebuild);
        await service.dispatchNext(RUN_ID);
        expect(items(await stored()).map((item) => item.state)).toEqual(["bound"]);
        expect(host.sent).toHaveLength(0);
        await store.update(RUN_ID, (record) => {
          record.lifecycle = "active";
          return record;
        });
        const result = await service.dispatchNext(RUN_ID);
        expect(result).toMatchObject({ status: "dispatched", seatId: "seat-b3" });
        expect(host.sent.map((entry) => entry.agentId)).toEqual([
          roster(await stored(), "seat-b3"),
        ]);
      });

      test("an unreadable record of the attempts is not carried on", async () => {
        const { host, rebuild } = await afterCreatingRecord();
        await store.update(RUN_ID, (record) => {
          (record as Record<string, unknown>).seatRebuilds = {
            version: 1,
            items: [{ nope: true }],
          };
          return record;
        });
        await makeService(host, rebuild).dispatchNext(RUN_ID);
        expect(rebuild.created).toHaveLength(0);
        expect(readSeatRebuilds(await stored()).kind).toBe("invalid");
      });
    });

    describe("a Run paused or cancelled while the Agent is being made", () => {
      test("paused: the Agent is made and bound, and nothing is sent", async () => {
        const { host, rebuild } = await cutOffSeat();
        rebuild.state.onCreate = async () => {
          await store.update(RUN_ID, (record) => {
            record.lifecycle = "paused";
            return record;
          });
        };
        const result = await makeService(host, rebuild).dispatchNext(RUN_ID);
        expect(result.status).toBe("waiting");
        const record = await stored();
        expect(items(record).map((item) => item.state)).toEqual(["bound"]);
        expect(roster(record, "seat-b3")).toBe(rebuild.byKey.get(KEY("seat-b3", 1)));
        expect(host.sent).toHaveLength(0);
        expect(record.lifecycle).toBe("paused");
        // Nothing has been sent to the new Agent, so 'rebuilt' is still up for the person to read.
        expect(rebuildAlerts(record).map((alert) => alert.alertId)).toEqual([
          "rebuild-bound-seat-b3-g1",
        ]);
      });

      test("cancelled: the Agent is made and bound, nothing is sent, and the cancellation can finish", async () => {
        const { host, rebuild } = await cutOffSeat();
        rebuild.state.onCreate = async () => {
          await store.update(RUN_ID, (record) => {
            Object.assign(
              record,
              withCancelRequest(record, {
                version: CANCEL_REQUEST_VERSION,
                requestId: "cancel-1",
                reason: "stop",
                requestedAt: record.updatedAt,
                completedAt: null,
              }),
            );
            return record;
          });
        };
        await makeService(host, rebuild).dispatchNext(RUN_ID);
        expect(items(await stored()).map((item) => item.state)).toEqual(["bound"]);
        expect(host.sent).toHaveLength(0);

        const finisher = createCancelFinisher({
          store,
          readSeat: async () => ({ status: "idle", activeTurn: false }),
        });
        const report = await finisher.finish(RUN_ID);
        expect(report.status).toBe("finished");
        const after = await stored();
        expect(after.lifecycle).toBe("cancelled");
        expect(checkLedgerInvariants(after)).toEqual({ ok: true });
        // The rebuilt Agent keeps its seat through the cancellation.
        expect(roster(after, "seat-b3")).toBe(rebuild.byKey.get(KEY("seat-b3", 1)));
      });
    });

    test("a pass delivers the hooks the observer held for want of an owner, once the bind may have given them one", async () => {
      const { host, rebuild } = await cutOffSeat();
      const flushed: number[] = [];
      const driver = createEngineDriver({
        store,
        observer: {
          buffered: 2,
          flush: async () => {
            flushed.push(1);
            return { delivered: 0, held: 0, dropped: 0 };
          },
          reconcile: async () => undefined,
        } as never,
        host: {} as never,
        intake: { settleAgent: async () => undefined } as never,
        dagIntake: { settleCoordinator: async () => undefined } as never,
        service: makeService(host, rebuild),
      });
      await driver.kick(RUN_ID);
      // Once at the start of the pass (the recovery's flush is the driver's own), and once after the dispatch.
      expect(flushed.length).toBeGreaterThan(0);
      const before = flushed.length;
      await driver.kick(RUN_ID);
      expect(flushed.length).toBeGreaterThan(before);
    });

    describe("what the review of the first version found", () => {
      test("an N seat whose read finds a turn running is not unopenable: nothing is rebuilt, and the next look sends to it", async () => {
        const { host, rebuild } = await neverRanSeat("runs");
        const service = makeService(host, rebuild);
        const first = await service.dispatchNext(RUN_ID);
        expect(first).toMatchObject({ status: "waiting" });
        expect(host.timelineReads).toEqual([B3]);
        expect(rebuild.created).toHaveLength(0);
        expect(readSeatRebuilds(await stored()).kind).toBe("absent");
        expect(roster(await stored(), "seat-b3")).toBe(B3);

        // It is not on the list of seats that cannot be opened: even if it read closed again, it is not rebuilt.
        let looked = false;
        rebuild.state.onReadRole = async () => {
          looked = true;
        };
        host.running.delete(B3);
        host.closed.add(B3);
        host.readsAs.set(B3, "stays");
        await service.dispatchNext(RUN_ID);
        expect(looked).toBe(false);
        expect(rebuild.created).toHaveLength(0);
        host.closed.delete(B3);
        host.readsAs.set(B3, "runs");
        // The turn ends; the seat is idle in Paseo again. The Run goes on with the same Agent.
        host.running.delete(B3);
        const second = await service.dispatchNext(RUN_ID);
        expect(second).toMatchObject({ status: "dispatched", seatId: "seat-b3" });
        expect(host.sent.map((entry) => entry.agentId)).toEqual([B3]);
        expect(rebuild.created).toHaveLength(0);
        // The Agent is still the seat's: what it reports is recorded, not dropped.
        expect(
          await createRunObserver({ store }).ingest({
            name: "agent.turn_started",
            agentId: B3,
            turnId: "turn-person",
          }),
        ).toMatchObject({ status: "recorded" });
      });

      test("a read that does not finish in time is not proof that the seat cannot be opened: nothing is rebuilt", async () => {
        const { host, rebuild } = await neverRanSeat("hangs");
        const service = makeService(host, rebuild, { reopenTimeoutMs: 20 });
        const result = await service.dispatchNext(RUN_ID);
        expect(result).toMatchObject({ status: "waiting" });
        expect(host.timelineReads).toEqual([B3]);
        expect(rebuild.created).toHaveLength(0);
        expect(readSeatRebuilds(await stored()).kind).toBe("absent");
        expect(roster(await stored(), "seat-b3")).toBe(B3);
      });

      test("a seat that is found running when the attempt is about to be written is not rebuilt", async () => {
        const { host, rebuild } = await cutOffSeat();
        rebuild.state.onReadRole = async () => {
          host.closed.delete(B3);
          host.running.add(B3);
        };
        await makeService(host, rebuild).dispatchNext(RUN_ID);
        expect(rebuild.created).toHaveLength(0);
        expect(readSeatRebuilds(await stored()).kind).toBe("absent");
        expect(host.sent).toHaveLength(0);
      });

      test("the host made the Agent but the seat cannot be given to it yet: the attempt stays, nothing is asked of the host while it cannot, and the same Agent is bound later", async () => {
        const { host, rebuild } = await cutOffSeat();
        const setEnabled = (enabled: boolean) =>
          store.update(RUN_ID, (record) => {
            const seat = record.roster.find((entry) => entry.seatId === "seat-b3");
            if (seat) seat.enabled = enabled;
            return record;
          });
        let taken = false;
        rebuild.state.onCreate = async () => {
          if (taken) return;
          taken = true;
          // The seat stops being a member's while its new Agent is being made.
          await setEnabled(false);
        };
        const service = makeService(host, rebuild);
        await service.dispatchNext(RUN_ID);
        expect(rebuild.created).toHaveLength(1);
        let held = await stored();
        expect(items(held).map((item) => [item.generation, item.state, item.error])).toEqual([
          [1, "creating", null],
        ]);
        expect(roster(held, "seat-b3")).toBe(B3);
        expect(eventsOf(held, "seat-rebound")).toHaveLength(0);
        expect(host.sent).toHaveLength(0);

        // Still in the way: the host is not asked again.
        await service.dispatchNext(RUN_ID);
        await service.dispatchNext(RUN_ID);
        expect(rebuild.created).toHaveLength(1);

        // Cleared: the same key gives the same Agent, which is bound once.
        await setEnabled(true);
        await service.dispatchNext(RUN_ID);
        expect(rebuild.created).toHaveLength(2);
        expect(new Set(rebuild.created.map((request) => request.idempotencyKey)).size).toBe(1);
        expect(rebuild.byKey.size).toBe(1);
        held = await stored();
        const fresh = rebuild.byKey.get(KEY("seat-b3", 1)) ?? "";
        expect(items(held).map((item) => [item.generation, item.state])).toEqual([[1, "bound"]]);
        expect(roster(held, "seat-b3")).toBe(fresh);
        expect(eventsOf(held, "seat-rebound")).toHaveLength(1);
      });

      test("a seat whose Agent was accepted with a delivery proof is never moved, and the Run says so", async () => {
        await seed();
        await store.update(RUN_ID, (record) => {
          for (const entry of record.eventReceipts) {
            if (entry.agentId === B1 && entry.kind === "turn_ended") {
              (entry as { outcome?: string }).outcome = "failed";
            }
          }
          return record;
        });
        const host = fakeHost();
        host.closed.add(B1);
        const rebuild = fakeRebuild();
        const result = await makeService(host, rebuild).dispatchNext(RUN_ID);
        expect(result).toMatchObject({ status: "waiting" });
        expect(host.timelineReads).toEqual([]);
        expect(rebuild.created).toHaveLength(0);
        const record = await stored();
        expect(readSeatRebuilds(record).kind).toBe("absent");
        const alerts = rebuildAlerts(record);
        expect(alerts).toHaveLength(1);
        expect(alerts[0]?.summary).toContain("Engine 无法重建席位 seat-b1");
        expect(alerts[0]?.summary).toContain("交付证明");
        expect(alerts[0]?.summary).toContain("取消这个 Run 后重新启动");
      });

      test("the block of attempts is not written past its limit: the Run says so and nothing is made", async () => {
        const { host, rebuild } = await cutOffSeat((record) => {
          const fill: Record<string, unknown>[] = [];
          const input = {
            seatId: "seat-b3",
            generation: 1 as const,
            fromAgentId: B3,
            title: "Builder seat-b3（重建 1）",
            reason: "turn-cut-off",
          };
          for (let index = 0; ; index += 1) {
            fill.push({
              rebuildId: `rebuild-seat-fill-${index}-g1`,
              seatId: `seat-fill-${index}`,
              generation: 1,
              fromAgentId: `agent-fill-${index}`,
              toAgentId: `agent-fill-${index}-new`,
              idempotencyKey: `engine:${RUN_ID}:seat:seat-fill-${index}:rebuild:1`,
              title: "t".repeat(300),
              reason: "r".repeat(100),
              state: "bound",
              requestedAt: record.updatedAt,
              settledAt: record.updatedAt,
              error: null,
            });
            (record as Record<string, unknown>).seatRebuilds = { version: 1, items: fill };
            if (!canStartRebuild(record, input)) break;
            if (index > 200) throw new Error("the fill never reached the limit");
          }
        });
        expect(readSeatRebuilds(await stored()).kind).toBe("valid");
        await makeService(host, rebuild).dispatchNext(RUN_ID);
        expect(rebuild.created).toHaveLength(0);
        expect(host.sent).toHaveLength(0);
        const record = await stored();
        expect(readSeatRebuilds(record).kind).toBe("valid");
        expect(items(record).some((item) => item.seatId === "seat-b3")).toBe(false);
        const alerts = rebuildAlerts(record);
        expect(alerts).toHaveLength(1);
        expect(alerts[0]?.summary).toContain("Engine 无法重建席位 seat-b3");
        expect(alerts[0]?.summary).toContain("大小上限");
      });

      test("the second generation that fails says there is no third: no 'try again', only to cancel", async () => {
        const { host, rebuild } = await cutOffSeat();
        rebuild.state.failures = 6;
        const driver = makeDriver(makeService(host, rebuild));
        await driver.kick(RUN_ID);
        expect(rebuildAlerts(await stored())[0]?.summary).toContain("可再试一次");
        await driver.retryRun(RUN_ID, { byPerson: true });
        const alerts = rebuildAlerts(await stored());
        expect(alerts).toHaveLength(1);
        expect(alerts[0]?.summary).toContain("第 2 次");
        expect(alerts[0]?.summary).toContain("都用完了");
        expect(alerts[0]?.summary).not.toContain("可再试一次");
        expect(alerts[0]?.summary).toContain("取消这个 Run 后重新启动");
      });

      test("a click on 'check now' that joins a pass already under way still gets its own pass, and with it the second try", async () => {
        const { host, rebuild } = await cutOffSeat();
        rebuild.state.failures = 3;
        await makeService(host, rebuild).dispatchNext(RUN_ID);
        expect(items(await stored()).map((item) => item.state)).toEqual(["failed"]);

        // A pass is under way for this Run (a recovery, say); it has judged the seats and is writing what it found.
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let reached: () => void = () => undefined;
        const arrived = new Promise<void>((resolve) => {
          reached = resolve;
        });
        let held = false;
        const slowStore = {
          ...store,
          update: async (...args: Parameters<RunStore["update"]>) => {
            if (!held) {
              held = true;
              reached();
              await gate;
            }
            return store.update(...args);
          },
        } as RunStore;
        const driver = makeDriver(makeService(host, rebuild, { store: slowStore }));
        const automatic = driver.retryRun(RUN_ID);
        await arrived;
        // The person presses the button now: the pass under way is past the step that would let a seat be rebuilt again.
        const click = driver.retryRun(RUN_ID, { byPerson: true });
        release();
        await Promise.all([automatic, click]);
        expect(items(await stored()).map((item) => [item.generation, item.state])).toEqual([
          [1, "failed"],
          [2, "bound"],
        ]);
      });

      test("a click that joins a pass under way costs no extra pass when it would change nothing", async () => {
        await seed((record) => {
          const t2 = record.tasks.find((task) => task.spec.id === "t2");
          if (t2) t2.state = "pending";
        });
        const host = fakeHost();
        const real = makeService(host, fakeRebuild());
        let calls = 0;
        let gate: Promise<void> | null = null;
        let reached: () => void = () => undefined;
        const arrived = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const service = {
          ...real,
          dispatchNext: async (runId: string) => {
            calls += 1;
            if (gate) {
              reached();
              await gate;
              gate = null;
            }
            return real.dispatchNext(runId);
          },
        };
        const driver = makeDriver(service as never);

        await driver.retryRun(RUN_ID);
        const alone = calls;
        expect(alone).toBeGreaterThan(0);

        calls = 0;
        let release: () => void = () => undefined;
        gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const automatic = driver.retryRun(RUN_ID);
        await arrived;
        const click = driver.retryRun(RUN_ID, { byPerson: true });
        const second = driver.retryRun(RUN_ID, { byPerson: true });
        release();
        await Promise.all([automatic, click, second]);
        expect(calls).toBe(alone);
      });

      test("a Run that is over while an attempt is still being made: a recovery closes it as failed, creates nothing and takes the warning down", async () => {
        const { host, rebuild } = await cutOffSeat();
        await store.update(RUN_ID, (record) => {
          const started = startRebuildRecord(
            record,
            {
              seatId: "seat-b3",
              generation: 1,
              fromAgentId: B3,
              title: "Builder seat-b3（重建 1）",
              reason: "turn-cut-off",
            },
            record.updatedAt,
          );
          started.next.lifecycle = "cancelled";
          return started.next;
        });
        expect(rebuildAlerts(await stored())).toHaveLength(1);
        await makeDriver(makeService(host, rebuild)).recover();
        const record = await stored();
        expect(items(record).map((item) => [item.state, item.error])).toEqual([
          ["failed", "run-ended"],
        ]);
        expect(rebuildAlerts(record)).toEqual([]);
        expect(rebuild.created).toHaveLength(0);
        expect(roster(record, "seat-b3")).toBe(B3);
      });

      test("the pass that follows a bind delivers the hooks the real observer held for want of an owner", async () => {
        const { host, rebuild } = await cutOffSeat();
        const observer = createRunObserver({ store });
        rebuild.state.onCreate = async () => {
          await observer.ingest({ name: "agent.created", agentId: "agent-new-1" });
        };
        const driver = createEngineDriver({
          store,
          observer,
          host: {} as never,
          intake: { settleAgent: async () => undefined } as never,
          dagIntake: { settleCoordinator: async () => undefined } as never,
          service: makeService(host, rebuild),
        });
        await driver.kick(RUN_ID);
        expect(rebuild.created).toHaveLength(1);
        expect(observer.buffered).toBe(0);
        expect(observer.needsReconcile).toBe(false);
        expect(
          (await stored()).eventReceipts.some((entry) => entry.agentId === "agent-new-1"),
        ).toBe(true);
      });
    });

    // E2b: after a kill the host reads a member that was not in a turn as idle, with no closed receipt. One
    // that never ran a turn in this Run and was made before this process is read once before it gets work.
    describe("a member that never ran and is older than this process is read once before it gets work (E2b)", () => {
      /** The host was killed: the member reads idle. `how` is what reading its history does. */
      async function killed(how: ReadsAs, extra: (record: RunRecord) => void = () => undefined) {
        await seed((record) => {
          withSeats({ seatId: "seat-b3", agentId: B3 })(record);
          archiveB1(record);
          extra(record);
        });
        const host = fakeHost();
        host.readsAs.set(B3, how);
        return { host, rebuild: fakeRebuild() };
      }
      const later = () => new Date(Date.now() + 3_600_000).toISOString();
      async function freshStore(): Promise<void> {
        await store.close();
        await rm(path.join(home, "paseo"), { recursive: true, force: true });
        await mkdir(path.join(home, "paseo"));
        store = createRunStore({ home: path.join(home, "paseo"), lock: { acquireTimeoutMs: 300 } });
        await store.initialize();
      }

      test("a Codex reviewer that cannot be opened: one read that fails, nothing sent to it, its seat rebuilt for never-ran-unopenable, one review to the new Agent", async () => {
        await seedReview((record) => {
          withJudge("seat-b6", B6)(record);
          record.eventReceipts.push(
            receipt(record, "archived", B2, null, { disposition: "accepted" }),
          );
        });
        const host = fakeHost();
        host.readsAs.set(B6, "throws");
        const rebuild = fakeRebuild();
        const service = makeService(host, rebuild);
        const result = await service.dispatchNext(RUN_ID);

        expect(result).toMatchObject({
          status: "dispatched",
          purpose: "reviewer",
          seatId: "seat-b6",
        });
        // Read exactly once, never sent anything; the new Agent was not read either (this process made it).
        expect(host.timelineReads).toEqual([B6]);
        const fresh = rebuild.byKey.get(KEY("seat-b6", 1)) ?? "";
        expect(fresh).not.toBe("");
        expect(host.sent.map((entry) => entry.agentId)).toEqual([fresh]);
        expect(host.sent.some((entry) => entry.agentId === B6)).toBe(false);
        const record = await stored();
        expect(roster(record, "seat-b6")).toBe(fresh);
        expect(items(record)).toMatchObject([
          {
            seatId: "seat-b6",
            fromAgentId: B6,
            toAgentId: fresh,
            state: "bound",
            reason: "never-ran-unopenable",
          },
        ]);
        expect(checkLedgerInvariants(record).ok).toBe(true);
        // Later passes read and send nothing more.
        await service.dispatchNext(RUN_ID);
        expect(host.timelineReads).toEqual([B6]);
        expect(host.sent).toHaveLength(1);
        expect(rebuild.created).toHaveLength(1);
      });

      test("a member that reads fine (a Claude one) is read once, gets exactly one dispatch, is not rebuilt, and later passes do not read it again", async () => {
        const { host, rebuild } = await killed("opens");
        const service = makeService(host, rebuild);
        const result = await service.dispatchNext(RUN_ID);
        expect(result).toMatchObject({ status: "dispatched", seatId: "seat-b3" });
        expect(host.timelineReads).toEqual([B3]);
        expect(host.sent.map((entry) => entry.agentId)).toEqual([B3]);
        expect(rebuild.created).toHaveLength(0);
        expect(readSeatRebuilds(await stored()).kind).toBe("absent");
        await service.dispatchNext(RUN_ID);
        await service.dispatchNext(RUN_ID);
        expect(host.timelineReads).toEqual([B3]);
        expect(host.sent).toHaveLength(1);
      });

      test("a reading that finds a turn running counts as loaded: the seat is not rebuilt and is not read again", async () => {
        const { host, rebuild } = await killed("runs");
        const service = makeService(host, rebuild);
        expect(await service.dispatchNext(RUN_ID)).toMatchObject({ status: "waiting" });
        expect(host.timelineReads).toEqual([B3]);
        host.running.delete(B3);
        expect(await service.dispatchNext(RUN_ID)).toMatchObject({
          status: "dispatched",
          seatId: "seat-b3",
        });
        expect(host.timelineReads).toEqual([B3]);
        expect(host.sent.map((entry) => entry.agentId)).toEqual([B3]);
        expect(rebuild.created).toHaveLength(0);
      });

      test("not read: a seat this process made, and a seat that already finished a turn or started one", async () => {
        const cases: [string, (record: RunRecord) => void][] = [
          [
            "made by this process",
            (record) =>
              record.eventReceipts.push(
                receipt(record, "created", B3, null, { receivedAt: later() }),
              ),
          ],
          [
            "finished a turn (P)",
            (record) => {
              record.eventReceipts.push(receipt(record, "turn_started", B3, "turn-done"));
              record.eventReceipts.push(receipt(record, "turn_ended", B3, "turn-done"));
            },
          ],
          ["started a turn and none finished (C)", (record) => cutOff(record, B3)],
        ];
        for (const [name, extra] of cases) {
          await freshStore();
          const { host, rebuild } = await killed("throws", extra);
          const result = await makeService(host, rebuild).dispatchNext(RUN_ID);
          expect([name, result.status]).toEqual([name, "dispatched"]);
          // Zero reads of the history, zero creates, and the dispatch went to the old Agent as it always did.
          expect([name, host.timelineReads]).toEqual([name, []]);
          expect([name, rebuild.created.length]).toEqual([name, 0]);
          expect([name, host.sent.map((entry) => entry.agentId)]).toEqual([name, [B3]]);
        }
      });

      test("the guard of an earlier review still holds: a P or a C seat that reads idle is never rebuilt, whatever a read would say", async () => {
        for (const extra of [
          (record: RunRecord) => {
            record.eventReceipts.push(receipt(record, "turn_started", B3, "turn-done"));
            record.eventReceipts.push(receipt(record, "turn_ended", B3, "turn-done"));
          },
          (record: RunRecord) => cutOff(record, B3),
        ]) {
          await freshStore();
          const { host, rebuild } = await killed("throws", extra);
          // Busy for now, so the work waits; it still reads nothing and builds nothing.
          host.running.add(B3);
          const service = makeService(host, rebuild);
          await service.dispatchNext(RUN_ID);
          service.grantReopen(RUN_ID);
          await service.dispatchNext(RUN_ID);
          expect(host.timelineReads).toEqual([]);
          expect(rebuild.created).toHaveLength(0);
          expect(readSeatRebuilds(await stored()).kind).toBe("absent");
        }
      });

      test("it is looked at only when work is waiting for it: a paused Run and a Run with nothing to dispatch make no host call at all", async () => {
        for (const mutate of [
          (record: RunRecord) => {
            record.lifecycle = "paused";
          },
          (record: RunRecord) => {
            const t2 = record.tasks.find((task) => task.spec.id === "t2");
            if (t2) t2.state = "pending";
          },
        ]) {
          await freshStore();
          const { host, rebuild } = await killed("throws", mutate);
          const service = makeService(host, rebuild, {
            clock: { now: () => new Date(Date.now() + 24 * 3_600_000).toISOString() },
          });
          for (let pass = 0; pass < 3; pass += 1) await service.dispatchNext(RUN_ID);
          expect(host.timelineReads).toEqual([]);
          expect(host.calls.refreshes).toBe(0);
          expect(host.sent).toHaveLength(0);
          expect(rebuild.created).toHaveLength(0);
        }
      });

      test("a read that fails with no way to rebuild: nothing is sent to the old Agent, no second read by itself, one more read when a person asks", async () => {
        const { host } = await killed("throws");
        const service = makeService(host, null);
        expect(await service.dispatchNext(RUN_ID)).toMatchObject({
          status: "waiting",
          taskId: "t2",
        });
        await service.dispatchNext(RUN_ID);
        await service.dispatchNext(RUN_ID);
        expect(host.timelineReads).toEqual([B3]);
        expect(host.sent).toHaveLength(0);
        service.grantReopen(RUN_ID);
        await service.dispatchNext(RUN_ID);
        await service.dispatchNext(RUN_ID);
        expect(host.timelineReads).toEqual([B3, B3]);
        expect(host.sent).toHaveLength(0);
        // A person's check that finds it readable now lets it have the work, once.
        host.readsAs.set(B3, "opens");
        service.grantReopen(RUN_ID);
        expect(await service.dispatchNext(RUN_ID)).toMatchObject({
          status: "dispatched",
          seatId: "seat-b3",
        });
        expect(host.sent.map((entry) => entry.agentId)).toEqual([B3]);
      });

      test("a read that does not finish in time proves nothing: no rebuild, no dispatch to it, and it is tried again when a person asks", async () => {
        const { host, rebuild } = await killed("hangs");
        const service = makeService(host, rebuild, { reopenTimeoutMs: 20 });
        expect(await service.dispatchNext(RUN_ID)).toMatchObject({ status: "waiting" });
        expect(host.timelineReads).toEqual([B3]);
        expect(host.sent).toHaveLength(0);
        expect(rebuild.created).toHaveLength(0);
        host.readsAs.set(B3, "opens");
        service.grantReopen(RUN_ID);
        expect(await service.dispatchNext(RUN_ID)).toMatchObject({
          status: "dispatched",
          seatId: "seat-b3",
        });
        expect(host.timelineReads).toEqual([B3, B3]);
      });

      test("a pass reads at most two such seats", async () => {
        await seed((record) => {
          withSeats(
            { seatId: "seat-b3", agentId: B3 },
            { seatId: "seat-b4", agentId: B4 },
            { seatId: "seat-b5", agentId: "agent-b5" },
          )(record);
          archiveB1(record);
        });
        const host = fakeHost();
        for (const id of [B3, B4, "agent-b5"]) host.readsAs.set(id, "throws");
        await makeService(host, null).dispatchNext(RUN_ID);
        expect(host.timelineReads).toHaveLength(2);
        expect(host.sent).toHaveLength(0);
      });

      test("another seat that is only busy does not keep it from being read: it takes the work in parallel after one read", async () => {
        await seed((record) => {
          withSeats({ seatId: "seat-b3", agentId: B3 })(record);
        });
        const host = fakeHost();
        host.running.add(B1);
        host.readsAs.set(B3, "opens");
        const result = await makeService(host, fakeRebuild()).dispatchNext(RUN_ID);
        expect(result).toMatchObject({ status: "dispatched", seatId: "seat-b3" });
        expect(host.timelineReads).toEqual([B3]);
        expect(host.sent.map((entry) => entry.agentId)).toEqual([B3]);
      });

      test("the same with a seat that cannot be opened: read once, rebuilt, and the busy seat is left alone", async () => {
        await seed((record) => {
          withSeats({ seatId: "seat-b3", agentId: B3 })(record);
        });
        const host = fakeHost();
        host.running.add(B1);
        host.readsAs.set(B3, "throws");
        const rebuild = fakeRebuild();
        const result = await makeService(host, rebuild).dispatchNext(RUN_ID);
        expect(result).toMatchObject({ status: "dispatched", seatId: "seat-b3" });
        expect(host.timelineReads).toEqual([B3]);
        const fresh = rebuild.byKey.get(KEY("seat-b3", 1)) ?? "";
        expect(host.sent.map((entry) => entry.agentId)).toEqual([fresh]);
        expect(roster(await stored(), "seat-b1")).toBe(B1);
      });

      test("a seat that is found running when the attempt is about to be written is not rebuilt", async () => {
        const { host, rebuild } = await killed("throws");
        rebuild.state.onReadRole = async () => {
          host.running.add(B3);
        };
        const service = makeService(host, rebuild);
        expect(await service.dispatchNext(RUN_ID)).toMatchObject({ status: "waiting" });
        expect(rebuild.created).toHaveLength(0);
        expect(host.sent).toHaveLength(0);
        expect(readSeatRebuilds(await stored()).kind).toBe("absent");
      });

      test("a seat with a turn running is busy, not unread: nothing is read and nothing is sent to it", async () => {
        const { host, rebuild } = await killed("opens");
        host.running.add(B3);
        const service = makeService(host, rebuild);
        expect(await service.dispatchNext(RUN_ID)).toMatchObject({ status: "waiting" });
        expect(host.timelineReads).toEqual([]);
        expect(host.sent).toHaveLength(0);
        expect(rebuild.created).toHaveLength(0);
      });

      test("only the unread seat is read when another is merely busy: a closed seat behind it is left for when everything is closed", async () => {
        await seed((record) => {
          withSeats({ seatId: "seat-b3", agentId: B3 }, { seatId: "seat-b4", agentId: B4 })(record);
          record.eventReceipts.push(receipt(record, "turn_started", B3, "turn-done"));
          record.eventReceipts.push(receipt(record, "turn_ended", B3, "turn-done"));
        });
        const host = fakeHost();
        host.running.add(B1);
        host.closed.add(B3);
        host.readsAs.set(B3, "opens");
        host.readsAs.set(B4, "opens");
        const result = await makeService(host, fakeRebuild()).dispatchNext(RUN_ID);
        expect(result).toMatchObject({ status: "dispatched", seatId: "seat-b4" });
        expect(host.timelineReads).toEqual([B4]);
        expect(host.sent.map((entry) => entry.agentId)).toEqual([B4]);
      });

      test("a closed seat a person has opened since its read failed is not rebuilt for being unread", async () => {
        const { host, rebuild } = await neverRanSeat("throws");
        rebuild.state.onReadRole = async () => {
          host.closed.delete(B3);
        };
        const service = makeService(host, rebuild);
        expect(await service.dispatchNext(RUN_ID)).toMatchObject({ status: "waiting" });
        expect(host.timelineReads).toEqual([B3]);
        expect(rebuild.created).toHaveLength(0);
        expect(host.sent).toHaveLength(0);
        expect(readSeatRebuilds(await stored()).kind).toBe("absent");
      });

      test("a closed seat that was cut off is not rebuilt because an unread seat is: only the unread one is, while another seat is merely busy", async () => {
        await seed((record) => {
          withSeats({ seatId: "seat-b3", agentId: B3 }, { seatId: "seat-b4", agentId: B4 })(record);
          cutOff(record, B3);
        });
        const host = fakeHost();
        host.running.add(B1);
        host.closed.add(B3);
        host.readsAs.set(B4, "throws");
        const rebuild = fakeRebuild();
        const result = await makeService(host, rebuild).dispatchNext(RUN_ID);
        expect(result).toMatchObject({ status: "dispatched", seatId: "seat-b4" });
        const record = await stored();
        expect(items(record).map((item) => item.seatId)).toEqual(["seat-b4"]);
        expect(roster(record, "seat-b3")).toBe(B3);
        expect(host.timelineReads).toEqual([B4]);
      });

      test("each unread Agent is read once: later passes with or without work read nothing and write nothing", async () => {
        await seed((record) => {
          withSeats({ seatId: "seat-b3", agentId: B3 })(record);
          archiveB1(record);
        });
        const host = fakeHost();
        host.readsAs.set(B3, "opens");
        const service = makeService(host, fakeRebuild());
        expect(await service.dispatchNext(RUN_ID)).toMatchObject({ status: "dispatched" });
        expect(host.timelineReads).toEqual([B3]);
        const after = await stored();
        const refreshes = host.calls.refreshes;
        for (let pass = 0; pass < 5; pass += 1) await service.dispatchNext(RUN_ID);
        // Nothing is left to send: the passes look at no seat at all, read no history, write nothing.
        expect(host.timelineReads).toEqual([B3]);
        expect(host.sent).toHaveLength(1);
        expect((await stored()).revision).toBe(after.revision);
        expect(host.calls.refreshes).toBe(refreshes);
      });

      test("a seat that is read once stays read through passes that wait on something else, and a failed one is not read again by them", async () => {
        await seed((record) => {
          withSeats({ seatId: "seat-b3", agentId: B3 }, { seatId: "seat-b4", agentId: B4 })(record);
        });
        const host = fakeHost();
        host.running.add(B1);
        host.readsAs.set(B3, "opens");
        host.readsAs.set(B4, "throws");
        host.running.add(B3);
        const service = makeService(host, null);
        // B1 and B3 are busy, B4 is unread and cannot be read: one failed read, then only waiting.
        for (let pass = 0; pass < 4; pass += 1) {
          expect(await service.dispatchNext(RUN_ID)).toMatchObject({ status: "waiting" });
        }
        expect(host.timelineReads).toEqual([B4]);
        expect(host.sent).toHaveLength(0);
      });

      test("a failed rebuild is the person's to repeat, and the first Agent is never sent to", async () => {
        const { host, rebuild } = await killed("throws");
        rebuild.state.failures = 3;
        const service = makeService(host, rebuild);
        expect(await service.dispatchNext(RUN_ID)).toMatchObject({ status: "waiting" });
        expect(items(await stored())).toMatchObject([{ generation: 1, state: "failed" }]);
        await service.dispatchNext(RUN_ID);
        expect(rebuild.created).toHaveLength(3);
        expect(host.timelineReads).toEqual([B3]);
        service.grantReopen(RUN_ID);
        expect(await service.dispatchNext(RUN_ID)).toMatchObject({
          status: "dispatched",
          seatId: "seat-b3",
        });
        expect(host.sent.some((entry) => entry.agentId === B3)).toBe(false);
      });
    });

    describe("the old Agent after the rebind", () => {
      test("its hooks are dropped, not buffered and not counted as lost; the new Agent's are recorded; before the bind the old one is still heard", async () => {
        const { host, rebuild } = await cutOffSeat();
        const observer = createRunObserver({ store });
        const hook = (
          agentId: string,
          name: "agent.turn_started" | "agent.turn_ended",
          turnId: string,
        ) =>
          name === "agent.turn_started"
            ? observer.ingest({ name, agentId, turnId })
            : observer.ingest({ name, agentId, turnId, outcome: { kind: "completed" } } as never);
        // Before it is rebuilt the old Agent is the seat's: its hook is recorded as always.
        expect(await hook(B3, "agent.turn_started", "turn-before")).toMatchObject({
          status: "recorded",
        });

        await makeService(host, rebuild).dispatchNext(RUN_ID);
        const fresh = rebuild.byKey.get(KEY("seat-b3", 1)) ?? "";
        const before = await stored();
        const receiptsBefore = before.eventReceipts.length;

        expect(await hook(B3, "agent.turn_ended", "turn-cut")).toEqual({
          status: "ignored",
          reason: "seat-rebound",
        });
        expect(await hook(B3, "agent.turn_started", "turn-late")).toEqual({
          status: "ignored",
          reason: "seat-rebound",
        });
        expect(observer.buffered).toBe(0);
        expect(observer.needsReconcile).toBe(false);
        expect((await stored()).eventReceipts).toHaveLength(receiptsBefore);

        expect(await hook(fresh, "agent.turn_started", "turn-new")).toMatchObject({
          status: "recorded",
        });
        expect((await stored()).eventReceipts).toHaveLength(receiptsBefore + 1);
      });

      test("while the new Agent is still being made the old one is the seat's: its hook is recorded, and it is dropped only once the bind is there", async () => {
        const { host, rebuild } = await cutOffSeat();
        const observer = createRunObserver({ store });
        let during: Awaited<ReturnType<typeof observer.ingest>> | undefined;
        let items: number | undefined;
        rebuild.state.onCreate = async () => {
          items = (await stored()).eventReceipts.length;
          during = await observer.ingest({
            name: "agent.turn_ended",
            agentId: B3,
            turnId: "turn-during",
            outcome: { kind: "completed" },
          } as never);
        };
        await makeService(host, rebuild).dispatchNext(RUN_ID);
        expect(during).toMatchObject({ status: "recorded" });
        expect(items).toBeDefined();
        expect(
          (await stored()).eventReceipts.some(
            (entry) => entry.agentId === B3 && entry.turnId === "turn-during",
          ),
        ).toBe(true);
      });

      test("the new Agent's `created` hook that comes before the bind is held, and recorded once the bind is there, without a lost hook", async () => {
        const { host, rebuild } = await cutOffSeat();
        const observer = createRunObserver({ store });
        let early: Awaited<ReturnType<typeof observer.ingest>> | undefined;
        rebuild.state.onCreate = async () => {
          early = await observer.ingest({
            name: "agent.created",
            agentId: "agent-new-1",
          });
        };
        await makeService(host, rebuild).dispatchNext(RUN_ID);
        expect(early).toEqual({ status: "buffered", reason: "no-owner-yet" });
        expect(observer.buffered).toBe(1);
        const flushed = await observer.flush();
        expect(flushed).toEqual({ delivered: 1, held: 0, dropped: 0 });
        expect(observer.needsReconcile).toBe(false);
        expect(
          (await stored()).eventReceipts.some((entry) => entry.agentId === "agent-new-1"),
        ).toBe(true);
      });

      test("old assignments keep their Agent; new work reads the roster", async () => {
        const { host, rebuild } = await cutOffSeat();
        const before = await stored();
        const oldAssignments = before.assignments.map((entry) => [
          entry.assignmentId,
          entry.agentId,
        ]);
        await makeService(host, rebuild).dispatchNext(RUN_ID);
        const after = await stored();
        expect(
          after.assignments
            .filter((entry) => oldAssignments.some(([id]) => id === entry.assignmentId))
            .map((entry) => [entry.assignmentId, entry.agentId]),
        ).toEqual(oldAssignments);
        expect(after.assignments.length).toBe(before.assignments.length + 1);
        // Seat profiles are keyed by seat, so the rebuilt Agent is scheduled on the same Profile.
        expect(readSeatProfiles(after).size).toBe(readSeatProfiles(before).size);
      });
    });
  });
}

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { alertIdFor } from "../../server/run-engine/digest";
import { createEngineDriver } from "../../server/run-engine/driver";
import { createEffects } from "../../server/run-engine/effects";
import { inspectRepo } from "../../server/run-engine/repo";
import { createEngineService } from "../../server/run-engine/service";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import {
  CANCEL_REQUEST_VERSION,
  withCancelRequest,
} from "../../shared/domain/run-engine/cancel-request";
import { compileDispatch } from "../../shared/domain/run-engine/prompt-template";
import { emptyReadRetries } from "../../shared/domain/run-engine/read-retry";
import type { SeatRuntime } from "../../shared/domain/run-engine/scheduler";
import {
  SEAT_CLOSED_ALERT,
  SEAT_CLOSED_ALERT_PREFIX,
} from "../../shared/domain/run-engine/seat-closed";
import {
  agentBuiltAt,
  classifySeatForReopen,
  mayReopen,
  needsFirstRead,
  REOPEN_READS_PER_PASS,
  REOPEN_TIMEOUT_MS,
  reopenKey,
  reopenOrder,
} from "../../shared/domain/run-engine/seat-reopen";
import type { PaseoEnginePort, PortAgentSnapshot, PortTimelinePage } from "../../shared/paseo/port";
import type { RunEventReceipt, RunRecord } from "../../shared/schemas/run-engine/ledger";
import { PROFILE_HAIKU } from "../fixtures/run-engine/base";
import { readyRun } from "./support/ready-run";
import { JUDGE_SEAT_REVIEW, reviewRun } from "./support/review-run";

/**
 * T11a: a restart leaves the members that were not mid-turn closed, and reading a member's timeline is
 * what makes the host load it again. The Engine reads the history of the closed seat that holds work
 * back before it refuses it, sends nothing, and goes on to dispatch once when the seat reads idle.
 * Failure modes this file guards:
 *  - a closed seat that could come back never being read, or being read when reading cannot work (a
 *    member whose first turn was cut off, an archived seat, a seat the family gate refuses, a Run
 *    that is idle, paused, over or being cancelled);
 *  - a read that is repeated by every pass, or that is not repeated when a person asks to check;
 *  - a read that sends a message, or a dispatch that goes out twice, or none;
 *  - a read that fails (throws, times out, or leaves the seat closed) dispatching anyway, or leaving
 *    no warning;
 *  - a pass that reads more than two seats, or goes on to read after one opened.
 */

const RUN_ID = "run-reopen-a1";
const B1 = "agent-b1";
const B2 = "agent-b2";
const B3 = "agent-b3";
const B4 = "agent-b4";
const B5 = "agent-b5";

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

type ReadsAs = "opens" | "throws" | "stays" | "hangs" | "wakes-with-turn" | "flaps";

/**
 * A host whose agents are idle, closed or running. Reading the timeline of a closed one does what the
 * test says: `opens` (the host loads it again: idle), `throws`, `stays` (the read works and it is still
 * closed), `hangs`, `wakes-with-turn` (it reads idle but a turn is running) or `flaps` (the first
 * snapshot after the read says idle, every later one says closed again). Every read of a timeline and every read of a snapshot is counted.
 */
function fakeHost() {
  const closed = new Set<string>();
  const running = new Set<string>();
  const readsAs = new Map<string, ReadsAs>();
  const sent: { agentId: string; text: string }[] = [];
  const timelineReads: string[] = [];
  const snapshotReads: string[] = [];
  const idleWithTurn = new Set<string>();
  const flapFresh = new Set<string>();
  const snapshot = (agentId: string): PortAgentSnapshot => {
    if (idleWithTurn.has(agentId)) return { status: "idle", activeTurn: { id: "turn-x" } };
    if (closed.has(agentId)) return { status: "closed", activeTurn: null };
    if (running.has(agentId)) return { status: "running", activeTurn: { id: "turn" } };
    return { status: "idle", activeTurn: null };
  };
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
            if (how === "wakes-with-turn") {
              closed.delete(agentId);
              idleWithTurn.add(agentId);
            }
            if (how === "flaps") flapFresh.add(agentId);
            return emptyPage;
          },
        },
        current: () => snapshot(agentId),
        refresh: async () => {
          snapshotReads.push(agentId);
          if (flapFresh.delete(agentId)) {
            return { agent: { status: "idle", activeTurn: null } };
          }
          return { agent: snapshot(agentId) };
        },
      }),
    },
  };
  return { port, sent, closed, running, readsAs, timelineReads, snapshotReads };
}

type Host = ReturnType<typeof fakeHost>;

const FAMILY = { producer: "haiku", judge: "luna" };

function makeService(
  host: Host,
  extra: { reopenTimeoutMs?: number; judgeFamily?: string; unavailable?: string[] } = {},
) {
  const effects = createEffects({ store, port: host.port, compile: compileDispatch });
  const haiku = (seatId: string, order: number) => ({
    profile: {
      id: PROFILE_HAIKU.id,
      name: PROFILE_HAIKU.name,
      provider: PROFILE_HAIKU.provider,
      model: PROFILE_HAIKU.model,
      family: PROFILE_HAIKU.family,
    },
    available: !(extra.unavailable ?? []).includes(seatId),
    order,
  });
  const orders: Record<string, number> = { "seat-b1": 0, "seat-b3": 1, "seat-b4": 2, "seat-b5": 3 };
  return createEngineService({
    store,
    port: host.port,
    effects,
    resolveSeat: (_record, seatId) => {
      if (seatId in orders) return haiku(seatId, orders[seatId] as number);
      if (seatId === JUDGE_SEAT_REVIEW) {
        return {
          profile: {
            id: "profile-dev-luna",
            name: "DEV Luna",
            provider: "codex",
            model: "gpt-6-luna",
            family: extra.judgeFamily ?? FAMILY.judge,
          },
          available: true,
          order: 9,
        };
      }
      return null;
    },
    resolveWorkspace: () => ({ workspaceId: "ws-start", directory: repoDir }),
    compile: compileDispatch,
    reopenTimeoutMs: extra.reopenTimeoutMs,
  });
}

async function stored(): Promise<RunRecord> {
  const read = await store.get(RUN_ID);
  if (read.status !== "ok") throw new Error(`run unreadable: ${read.status}`);
  return read.record;
}

const seatAlerts = (record: RunRecord) =>
  record.alerts.filter((alert) => alert.summary.startsWith(SEAT_CLOSED_ALERT_PREFIX));
const eventsOf = (record: RunRecord, kind: string) =>
  record.events.filter((event) => event.kind === kind);

/** More producer seats on the same Profile, each holding its own Agent. */
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

/** The agent has never started a turn in this Run (class N) is the default for an added seat. */
function neverRan(record: RunRecord, agentId: string): void {
  record.eventReceipts = record.eventReceipts.filter((entry) => entry.agentId !== agentId);
}

/** The agent started a turn and none of its turns finished (class C). */
function cutOff(record: RunRecord, agentId: string): void {
  neverRan(record, agentId);
  record.eventReceipts.push(receipt(record, "turn_started", agentId, "turn-cut"));
}

async function seed(mutate: (record: RunRecord) => void = () => undefined): Promise<void> {
  const record = readyRun({ runId: RUN_ID, repoId, evidenceRoot });
  record.schemaVersion = schema;
  if (schema === 2) (record as Record<string, unknown>).readRetries = emptyReadRetries();
  mutate(record);
  await store.create(record);
}

/** t1 delivered a real commit and waits for its review; the judge seat is `agent-b2`. */
async function seedReview(mutate: (record: RunRecord) => void = () => undefined): Promise<void> {
  const baseSha = git(repoDir, "rev-parse", "HEAD");
  await writeFile(path.join(repoDir, "src", "t1.ts"), "export const t1 = 1;\n");
  git(repoDir, "add", "--", "src/t1.ts");
  git(repoDir, "commit", "-q", "-m", "deliver t1");
  const headSha = git(repoDir, "rev-parse", "HEAD");
  const record = reviewRun({ runId: RUN_ID, repoId, evidenceRoot, baseSha, headSha });
  record.schemaVersion = schema;
  if (schema === 2) (record as Record<string, unknown>).readRetries = emptyReadRetries();
  mutate(record);
  await store.create(record);
}

/** What a person's "check now" does for the Run's closed seats, with the rest of the driver stubbed. */
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
  home = await realpath(await mkdtemp(path.join(tmpdir(), "run-reopen-")));
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

// --- the classification on its own -----------------------------------------------------------

describe("what a closed member's receipts say about reopening it (seat-reopen.ts)", () => {
  const base = readyRun();
  const rec = (...entries: RunEventReceipt[]) => ({ eventReceipts: entries });
  const r = (kind: RunEventReceipt["kind"], extra: Record<string, unknown> = {}, agent = "a") =>
    receipt(base, kind, agent, "t", extra);

  test("a finished turn in this Run is P, whatever came after it", () => {
    expect(classifySeatForReopen(rec(r("turn_ended")), "a")).toBe("P");
    expect(classifySeatForReopen(rec(r("turn_ended", { outcome: "completed" })), "a")).toBe("P");
    expect(
      classifySeatForReopen(
        rec(r("turn_started"), r("turn_ended"), receipt(base, "turn_started", "a", "t2")),
        "a",
      ),
    ).toBe("P");
  });

  test("no turn at all is N, and receipts that are not turns (created, closed, archived) do not make one", () => {
    expect(classifySeatForReopen(rec(), "a")).toBe("N");
    expect(classifySeatForReopen(rec(r("created"), r("closed"), r("archived")), "a")).toBe("N");
  });

  test("a turn that started and never finished is C; so is one that only ended badly", () => {
    expect(classifySeatForReopen(rec(r("turn_started")), "a")).toBe("C");
    expect(
      classifySeatForReopen(rec(r("turn_started"), r("turn_ended", { outcome: "failed" })), "a"),
    ).toBe("C");
    expect(
      classifySeatForReopen(
        rec(r("turn_started"), r("turn_ended", { outcome: "interrupted" })),
        "a",
      ),
    ).toBe("C");
    expect(classifySeatForReopen(rec(r("turn_ended", { outcome: "canceled" })), "a")).toBe("C");
  });

  test("an end the Engine wrote itself is not a finished turn", () => {
    const engineEnd = r("turn_ended", { outcome: "agent-closed", settledBy: "engine" });
    expect(classifySeatForReopen(rec(r("turn_started"), engineEnd), "a")).toBe("C");
    // Even one without an outcome: who wrote it decides, not what it says.
    const bare = r("turn_ended", { settledBy: "engine" });
    expect(classifySeatForReopen(rec(r("turn_started"), bare), "a")).toBe("C");
    // A real end next to it still makes the member P.
    expect(classifySeatForReopen(rec(engineEnd, receipt(base, "turn_ended", "a", "t9")), "a")).toBe(
      "P",
    );
  });

  test("only this agent's receipts count", () => {
    const other = r("turn_ended", {}, "b");
    expect(classifySeatForReopen(rec(other), "a")).toBe("N");
    expect(classifySeatForReopen(rec(r("turn_started", {}, "b")), "a")).toBe("N");
    expect(classifySeatForReopen(rec(other, r("turn_started")), "a")).toBe("C");
  });

  test("mayReopen tries P and N and never C; the key and the limits are as ruled", () => {
    expect(mayReopen(rec(r("turn_ended")), "a")).toBe(true);
    expect(mayReopen(rec(), "a")).toBe(true);
    expect(mayReopen(rec(r("turn_started")), "a")).toBe(false);
    expect(reopenKey("run", "seat", "agent")).not.toBe(reopenKey("run", "seat", "other"));
    expect(reopenKey("run", "seat", "agent")).not.toBe(reopenKey("run2", "seat", "agent"));
    expect(reopenKey("run", "se", "atagent")).not.toBe(reopenKey("run", "seat", "agent"));
    expect(REOPEN_READS_PER_PASS).toBe(2);
    expect(REOPEN_TIMEOUT_MS).toBe(30_000);
  });
});

// --- the order in which closed seats are read ---------------------------------------------------

describe("which closed seats are read, and in what order (reopenOrder)", () => {
  const seat = (seatId: string, extra: Partial<SeatRuntime> = {}): SeatRuntime => ({
    seatId,
    profileId: PROFILE_HAIKU.id,
    agentId: `agent-${seatId}`,
    enabled: true,
    idle: false,
    permissionPending: false,
    degraded: true,
    closed: true,
    channelState: "available",
    available: true,
    load: 0,
    qualityRework: 0,
    order: 0,
    ...extra,
  });
  const ids = (seats: SeatRuntime[], options?: Parameters<typeof reopenOrder>[2]) =>
    reopenOrder(
      seats,
      seats.map((entry) => entry.seatId),
      options,
    );

  test("load first, then earlier quality rework, then the frozen order, then the seat id", () => {
    expect(
      ids([
        seat("d", { order: 0, qualityRework: 1 }),
        seat("c", { order: 3 }),
        seat("b", { order: 1 }),
        seat("a", { order: 1 }),
      ]),
    ).toEqual(["a", "b", "c", "d"]);
    expect(ids([seat("z", { order: 0, qualityRework: 2 }), seat("y", { order: 5 })])).toEqual([
      "y",
      "z",
    ]);
  });

  test("a seat that carries other work is not worth reading, except for a supplement", () => {
    const seats = [seat("a", { order: 0, load: 1 }), seat("b", { order: 1 })];
    expect(ids(seats)).toEqual(["b"]);
    expect(ids(seats, { ignoreLoad: true })).toEqual(["b", "a"]);
  });

  test("a seat the scheduler would refuse once it opens is left out", () => {
    expect(ids([seat("a", { available: false }), seat("b")])).toEqual(["b"]);
    expect(ids([seat("a", { channelState: "paused" }), seat("b")])).toEqual(["b"]);
    expect(ids([seat("a", { permissionPending: true }), seat("b")])).toEqual(["b"]);
    expect(ids([seat("a", { agentId: null }), seat("b")])).toEqual(["b"]);
  });

  test("only the closed seats asked for are listed, and the caller's own gate has a say", () => {
    const seats = [seat("a"), seat("b"), seat("c")];
    expect(reopenOrder(seats, ["c", "a"])).toEqual(["a", "c"]);
    expect(
      reopenOrder(seats, ["a", "b", "c"], { allows: (entry) => entry.seatId !== "b" }),
    ).toEqual(["a", "c"]);
    expect(reopenOrder(seats, [])).toEqual([]);
  });
});

// --- the Engine reopens a closed seat before it refuses it ------------------------------------

for (const version of [1, 2] as const) {
  describe(`reopening a closed seat by reading its history [v${version}]`, () => {
    beforeEach(() => {
      schema = version;
    });

    test("P: the producer seat reads idle after its history is read: one dispatch, one read, no warning", async () => {
      await seed();
      const host = fakeHost();
      host.closed.add(B1);
      host.readsAs.set(B1, "opens");
      const result = await makeService(host).dispatchNext(RUN_ID);

      expect(result).toMatchObject({ status: "dispatched", seatId: "seat-b1", purpose: "member" });
      expect(host.timelineReads).toEqual([B1]);
      expect(host.sent.map((entry) => entry.agentId)).toEqual([B1]);
      const after = await stored();
      expect(seatAlerts(after)).toEqual([]);
      expect(eventsOf(after, "alert-raised")).toEqual([]);
      expect(after.tasks.find((task) => task.spec.id === "t2")?.state).toBe("assigned");
    });

    test("P: a warning that was up comes down once when the reopened seat takes the work", async () => {
      await seed();
      const host = fakeHost();
      host.closed.add(B1);
      host.readsAs.set(B1, "throws");
      const service = makeService(host);
      await service.dispatchNext(RUN_ID);
      expect(seatAlerts(await stored())).toHaveLength(1);

      host.readsAs.set(B1, "opens");
      service.grantReopen(RUN_ID);
      expect(await service.dispatchNext(RUN_ID)).toMatchObject({ status: "dispatched" });
      const after = await stored();
      expect(seatAlerts(after).map((alert) => alert.state)).toEqual(["resolved"]);
      expect(eventsOf(after, "alert-raised")).toHaveLength(1);
      expect(eventsOf(after, "alert-resolved")).toHaveLength(1);
      expect(host.sent.map((entry) => entry.agentId)).toEqual([B1]);
      expect(host.timelineReads).toEqual([B1, B1]);
    });

    test("N: a member that never ran a turn is read, opens, and gets the work once", async () => {
      await seed((record) => {
        withSeats({ seatId: "seat-b3", agentId: B3 })(record);
        archiveB1(record);
      });
      const host = fakeHost();
      host.closed.add(B3);
      host.readsAs.set(B3, "opens");
      const result = await makeService(host).dispatchNext(RUN_ID);

      expect(result).toMatchObject({ status: "dispatched", seatId: "seat-b3" });
      expect(host.timelineReads).toEqual([B3]);
      expect(host.sent.map((entry) => entry.agentId)).toEqual([B3]);
      expect(seatAlerts(await stored())).toEqual([]);
    });

    test("N: the read throws: nothing is sent and there is one warning; later passes do not read again, a person's check reads exactly once more", async () => {
      await seed((record) => {
        withSeats({ seatId: "seat-b3", agentId: B3 })(record);
        archiveB1(record);
      });
      const host = fakeHost();
      host.closed.add(B3);
      host.readsAs.set(B3, "throws");
      const service = makeService(host);
      const first = await service.dispatchNext(RUN_ID);

      expect(first).toMatchObject({ status: "waiting", taskId: "t2" });
      expect(host.timelineReads).toEqual([B3]);
      expect(host.sent).toHaveLength(0);
      const held = await stored();
      expect(seatAlerts(held)).toHaveLength(1);
      expect(seatAlerts(held)[0]).toMatchObject({ summary: SEAT_CLOSED_ALERT, state: "open" });

      // The passes that follow by themselves (hooks, recovery) cost no read.
      await service.dispatchNext(RUN_ID);
      await service.dispatchNext(RUN_ID);
      expect(host.timelineReads).toEqual([B3]);
      expect((await stored()).revision).toBe(held.revision);

      // A person pressing 立即检查并推进 allows one more try, and only one.
      service.grantReopen(RUN_ID);
      await service.dispatchNext(RUN_ID);
      await service.dispatchNext(RUN_ID);
      expect(host.timelineReads).toEqual([B3, B3]);
      expect(host.sent).toHaveLength(0);
      const again = await stored();
      expect(seatAlerts(again)).toHaveLength(1);
      expect(again.revision).toBe(held.revision);
      expect(eventsOf(again, "alert-raised")).toHaveLength(1);
    });

    test("a person's check through the driver reads once, and a plain kick after it reads nothing", async () => {
      await seed();
      const host = fakeHost();
      host.closed.add(B1);
      host.readsAs.set(B1, "throws");
      const service = makeService(host);
      const driver = makeDriver(service);

      await driver.kick(RUN_ID);
      expect(host.timelineReads).toEqual([B1]);
      await driver.kick(RUN_ID);
      await driver.kick(RUN_ID);
      expect(host.timelineReads).toEqual([B1]);

      await driver.retryRun(RUN_ID, { byPerson: true });
      expect(host.timelineReads).toEqual([B1, B1]);
      await driver.kick(RUN_ID);
      expect(host.timelineReads).toEqual([B1, B1]);

      // A retry after a write (an answer, a resume, a recovered read) is an automatic pass: it reads nothing.
      await driver.retryRun(RUN_ID, { afterWrite: true });
      await driver.retryRun(RUN_ID);
      expect(host.timelineReads).toEqual([B1, B1]);

      host.readsAs.set(B1, "opens");
      const report = await driver.retryRun(RUN_ID, { byPerson: true });
      expect(report.dispatched).toBe(1);
      expect(host.timelineReads).toEqual([B1, B1, B1]);
      expect(host.sent.map((entry) => entry.agentId)).toEqual([B1]);
      expect(seatAlerts(await stored()).map((alert) => alert.state)).toEqual(["resolved"]);
    });

    test("C: a member whose first turn was cut off is not read; the warning is raised", async () => {
      await seed((record) => {
        withSeats({ seatId: "seat-b3", agentId: B3 })(record);
        archiveB1(record);
        cutOff(record, B3);
      });
      const host = fakeHost();
      host.closed.add(B3);
      host.readsAs.set(B3, "opens");
      const result = await makeService(host).dispatchNext(RUN_ID);

      expect(result).toMatchObject({ status: "waiting", taskId: "t2" });
      expect(host.timelineReads).toEqual([]);
      expect(host.sent).toHaveLength(0);
      expect(seatAlerts(await stored())).toHaveLength(1);
    });

    test("an archived seat is never read", async () => {
      await seed(archiveB1);
      const host = fakeHost();
      host.closed.add(B1);
      host.readsAs.set(B1, "opens");
      const result = await makeService(host).dispatchNext(RUN_ID);

      expect(result).toMatchObject({ status: "waiting" });
      expect(host.timelineReads).toEqual([]);
      expect(host.sent).toHaveLength(0);
    });

    test("a seat only closed is not read when something else is also holding the work (a busy neighbour)", async () => {
      await seed(withSeats({ seatId: "seat-b3", agentId: B3 }));
      const host = fakeHost();
      host.closed.add(B1);
      host.readsAs.set(B1, "opens");
      host.running.add(B3);
      const result = await makeService(host).dispatchNext(RUN_ID);

      expect(result).toMatchObject({ status: "waiting" });
      expect(host.timelineReads).toEqual([]);
      expect(seatAlerts(await stored())).toEqual([]);
    });

    test("a seat that is only busy is not read for history either", async () => {
      await seed();
      const host = fakeHost();
      host.running.add(B1);
      const service = makeService(host);
      expect(await service.dispatchNext(RUN_ID)).toMatchObject({ status: "waiting" });
      expect(host.timelineReads).toEqual([]);
    });

    test("the read works but the seat is still closed: nothing is dispatched, one warning", async () => {
      await seed();
      const host = fakeHost();
      host.closed.add(B1);
      host.readsAs.set(B1, "stays");
      const result = await makeService(host).dispatchNext(RUN_ID);

      expect(result).toMatchObject({ status: "waiting", taskId: "t2" });
      expect(host.timelineReads).toEqual([B1]);
      expect(host.sent).toHaveLength(0);
      expect(seatAlerts(await stored())).toHaveLength(1);
    });

    test("a read that takes too long is given up on: nothing is dispatched, one warning", async () => {
      await seed();
      const host = fakeHost();
      host.closed.add(B1);
      host.readsAs.set(B1, "hangs");
      const result = await makeService(host, { reopenTimeoutMs: 25 }).dispatchNext(RUN_ID);

      expect(result).toMatchObject({ status: "waiting", taskId: "t2" });
      expect(host.timelineReads).toEqual([B1]);
      expect(host.sent).toHaveLength(0);
      expect(seatAlerts(await stored())).toHaveLength(1);
    });

    test("a seat that reads idle with a turn still running is not opened", async () => {
      await seed();
      const host = fakeHost();
      host.closed.add(B1);
      // After the read the host says idle but a turn is running: not a seat to hand work to.
      host.readsAs.set(B1, "wakes-with-turn");
      const result = await makeService(host).dispatchNext(RUN_ID);
      expect(result).toMatchObject({ status: "waiting" });
      expect(host.timelineReads).toEqual([B1]);
      expect(host.sent).toHaveLength(0);
      // The seat was read as closed when the pass began, so the warning stands.
      expect(seatAlerts(await stored())).toHaveLength(1);
    });

    test("a reopened seat that does not take the work: the next candidate is read in the same pass", async () => {
      await seed((record) => {
        withSeats({ seatId: "seat-b3", agentId: B3 }, { seatId: "seat-b4", agentId: B4 })(record);
        archiveB1(record);
      });
      const host = fakeHost();
      host.closed.add(B3);
      host.closed.add(B4);
      // B3 reads idle once and is closed again by the time the dispatch looks; B4 opens.
      host.readsAs.set(B3, "flaps");
      host.readsAs.set(B4, "opens");
      const result = await makeService(host).dispatchNext(RUN_ID);

      expect(result).toMatchObject({ status: "dispatched", seatId: "seat-b4" });
      expect(host.timelineReads).toEqual([B3, B4]);
      expect(host.sent.map((entry) => entry.agentId)).toEqual([B4]);
      expect(seatAlerts(await stored())).toEqual([]);
    });

    test("the look after a reopening reads nothing: a pass never reads more than two seats", async () => {
      await seed((record) => {
        withSeats(
          { seatId: "seat-b3", agentId: B3 },
          { seatId: "seat-b4", agentId: B4 },
          { seatId: "seat-b5", agentId: B5 },
        )(record);
        archiveB1(record);
      });
      const host = fakeHost();
      for (const agent of [B3, B4, B5]) host.closed.add(agent);
      host.readsAs.set(B3, "flaps");
      host.readsAs.set(B4, "flaps");
      host.readsAs.set(B5, "opens");
      const service = makeService(host);
      const result = await service.dispatchNext(RUN_ID);

      expect(result).toMatchObject({ status: "waiting", taskId: "t2" });
      expect(host.timelineReads).toEqual([B3, B4]);
      expect(host.sent).toHaveLength(0);
      expect(seatAlerts(await stored())).toHaveLength(1);
      // The next pass reaches the third.
      expect(await service.dispatchNext(RUN_ID)).toMatchObject({
        status: "dispatched",
        seatId: "seat-b5",
      });
    });

    test("a closed seat the scheduler would refuse again once it opens is not read: the next one is", async () => {
      await seed((record) => {
        withSeats({ seatId: "seat-b3", agentId: B3 }, { seatId: "seat-b4", agentId: B4 })(record);
        archiveB1(record);
      });
      const host = fakeHost();
      host.closed.add(B3);
      host.closed.add(B4);
      host.readsAs.set(B3, "opens");
      host.readsAs.set(B4, "opens");
      // seat-b3 comes first in the roster but its Profile is not available.
      const result = await makeService(host, { unavailable: ["seat-b3"] }).dispatchNext(RUN_ID);

      expect(result).toMatchObject({ status: "dispatched", seatId: "seat-b4" });
      expect(host.timelineReads).toEqual([B4]);
      expect(host.sent.map((entry) => entry.agentId)).toEqual([B4]);
    });

    test("a person's check on one Run allows one more try only for that Run", async () => {
      const OTHER_RUN = "run-reopen-b2";
      await seed();
      const other = readyRun({ runId: OTHER_RUN, repoId, evidenceRoot });
      other.schemaVersion = schema;
      if (schema === 2) (other as Record<string, unknown>).readRetries = emptyReadRetries();
      await store.create(other);
      const host = fakeHost();
      host.closed.add(B1);
      host.readsAs.set(B1, "throws");
      const service = makeService(host);

      await service.dispatchNext(RUN_ID);
      await service.dispatchNext(OTHER_RUN);
      expect(host.timelineReads).toEqual([B1, B1]);
      service.grantReopen(RUN_ID);
      await service.dispatchNext(OTHER_RUN);
      expect(host.timelineReads).toEqual([B1, B1]);
      await service.dispatchNext(RUN_ID);
      expect(host.timelineReads).toEqual([B1, B1, B1]);
    });

    test("at most two seats are read in one pass; the third waits for the next pass", async () => {
      await seed((record) => {
        withSeats(
          { seatId: "seat-b3", agentId: B3 },
          { seatId: "seat-b4", agentId: B4 },
          { seatId: "seat-b5", agentId: B5 },
        )(record);
        archiveB1(record);
      });
      const host = fakeHost();
      for (const agent of [B3, B4, B5]) host.closed.add(agent);
      host.readsAs.set(B3, "stays");
      host.readsAs.set(B4, "stays");
      host.readsAs.set(B5, "opens");
      const service = makeService(host);

      expect(await service.dispatchNext(RUN_ID)).toMatchObject({ status: "waiting" });
      expect(host.timelineReads).toEqual([B3, B4]);
      expect(host.sent).toHaveLength(0);

      // The next automatic pass skips the two it already tried and reaches the third.
      expect(await service.dispatchNext(RUN_ID)).toMatchObject({
        status: "dispatched",
        seatId: "seat-b5",
      });
      expect(host.timelineReads).toEqual([B3, B4, B5]);
      expect(host.sent.map((entry) => entry.agentId)).toEqual([B5]);
    });

    test("the first seat that opens ends the reading: the ones after it are not read", async () => {
      await seed((record) => {
        withSeats({ seatId: "seat-b3", agentId: B3 }, { seatId: "seat-b4", agentId: B4 })(record);
        archiveB1(record);
      });
      const host = fakeHost();
      host.closed.add(B3);
      host.closed.add(B4);
      host.readsAs.set(B3, "opens");
      host.readsAs.set(B4, "opens");
      const result = await makeService(host).dispatchNext(RUN_ID);

      expect(result).toMatchObject({ status: "dispatched", seatId: "seat-b3" });
      expect(host.timelineReads).toEqual([B3]);
      expect(host.sent.map((entry) => entry.agentId)).toEqual([B3]);
    });

    test("a seat that fails to open does not stop the next one from being tried in the same pass", async () => {
      await seed((record) => {
        withSeats({ seatId: "seat-b3", agentId: B3 }, { seatId: "seat-b4", agentId: B4 })(record);
        archiveB1(record);
      });
      const host = fakeHost();
      host.closed.add(B3);
      host.closed.add(B4);
      host.readsAs.set(B3, "throws");
      host.readsAs.set(B4, "opens");
      const result = await makeService(host).dispatchNext(RUN_ID);

      expect(result).toMatchObject({ status: "dispatched", seatId: "seat-b4" });
      expect(host.timelineReads).toEqual([B3, B4]);
      expect(seatAlerts(await stored())).toEqual([]);
    });

    test("the review seat: P class, opens, and the reviewer is sent exactly once", async () => {
      await seedReview();
      const host = fakeHost();
      host.closed.add(B2);
      host.readsAs.set(B2, "opens");
      const result = await makeService(host).dispatchNext(RUN_ID);

      expect(result).toMatchObject({ status: "dispatched", purpose: "reviewer" });
      expect(host.timelineReads).toEqual([B2]);
      expect(host.sent.map((entry) => entry.agentId)).toEqual([B2]);
      expect(seatAlerts(await stored())).toEqual([]);
    });

    test("the review seat: the read works but it is still closed: not sent, one warning", async () => {
      await seedReview();
      const host = fakeHost();
      host.closed.add(B2);
      host.readsAs.set(B2, "stays");
      const result = await makeService(host).dispatchNext(RUN_ID);

      expect(result).toMatchObject({ status: "waiting", taskId: "t1" });
      expect(host.timelineReads).toEqual([B2]);
      expect(host.sent).toHaveLength(0);
      expect(seatAlerts(await stored())).toHaveLength(1);
    });

    test("a review seat the family gate would refuse is not read, and the warning still stands", async () => {
      await seedReview((record) => {
        const t1 = record.tasks.find((task) => task.spec.id === "t1");
        if (t1) t1.spec.level = "L1";
        // L1 is reviewed at tier B: the judge seat has to serve at that tier.
        const judge = record.roster.find((seat) => seat.seatId === JUDGE_SEAT_REVIEW);
        if (judge) judge.tier = "B";
      });
      const host = fakeHost();
      host.closed.add(B2);
      host.readsAs.set(B2, "opens");
      const result = await makeService(host, { judgeFamily: FAMILY.producer }).dispatchNext(RUN_ID);

      expect(result).toMatchObject({ status: "waiting", taskId: "t1" });
      expect(host.timelineReads).toEqual([]);
      expect(host.sent).toHaveLength(0);
      expect(seatAlerts(await stored())).toHaveLength(1);
    });

    test("an idle Run reads nothing at all: not even the seats, however closed they are", async () => {
      await seed((record) => {
        const t2 = record.tasks.find((task) => task.spec.id === "t2");
        if (t2) t2.state = "pending";
      });
      const host = fakeHost();
      host.closed.add(B1);
      host.readsAs.set(B1, "opens");
      const before = await stored();
      expect(await makeService(host).dispatchNext(RUN_ID)).toEqual({ status: "idle" });
      expect(host.timelineReads).toEqual([]);
      expect(host.snapshotReads).toEqual([]);
      expect((await stored()).revision).toBe(before.revision);
    });

    for (const lifecycle of ["paused", "finished", "cancelled"] as const) {
      test(`a ${lifecycle} Run reads nothing`, async () => {
        await seed((record) => {
          record.lifecycle = lifecycle;
        });
        const host = fakeHost();
        host.closed.add(B1);
        host.readsAs.set(B1, "opens");
        expect(await makeService(host).dispatchNext(RUN_ID)).toEqual({ status: "idle" });
        expect(host.timelineReads).toEqual([]);
        expect(host.sent).toHaveLength(0);
      });
    }

    test("a Run being cancelled reads nothing: no dispatch will follow", async () => {
      await seed((record) => {
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
      const host = fakeHost();
      host.closed.add(B1);
      host.readsAs.set(B1, "opens");
      await makeService(host).dispatchNext(RUN_ID);
      expect(host.timelineReads).toEqual([]);
      expect(host.sent).toHaveLength(0);
    });

    test("a Run that already carries the warning and has no work left reads nothing", async () => {
      await seed((record) => {
        const t2 = record.tasks.find((task) => task.spec.id === "t2");
        if (t2) t2.state = "pending";
        record.alerts.push({
          alertId: alertIdFor(SEAT_CLOSED_ALERT_PREFIX),
          state: "open",
          severity: "warning",
          summary: SEAT_CLOSED_ALERT,
          createdAt: record.updatedAt,
          acknowledgedAt: null,
          resolvedAt: null,
        });
      });
      const host = fakeHost();
      host.closed.add(B1);
      host.readsAs.set(B1, "opens");
      await makeService(host).dispatchNext(RUN_ID);
      expect(host.timelineReads).toEqual([]);
    });
  });
}

// --- E2b: which seats are read once before they get work (pure) --------------------------------------

describe("needsFirstRead and agentBuiltAt", () => {
  const START = "2026-11-10T12:00:00.000Z";
  const BEFORE = "2026-11-10T09:00:00.000Z";
  const AFTER = "2026-11-10T12:30:00.000Z";
  const stamp = (
    kind: RunEventReceipt["kind"],
    agentId: string,
    turnId: string | null,
    receivedAt: string,
    extra: Record<string, unknown> = {},
  ) =>
    ({
      eventKey: `${kind}:${agentId}:${turnId ?? "-"}`,
      dedupeKey: `${kind}:${agentId}:${turnId ?? "-"}`,
      kind,
      agentId,
      turnId,
      seq: 1,
      receivedAt,
      disposition: "observed",
      ...extra,
    }) as RunEventReceipt;
  const ledger = (
    receipts: RunEventReceipt[],
    over: Record<string, unknown> = {},
  ): Pick<RunRecord, "eventReceipts" | "createdAt" | "schemaVersion" | "launch"> =>
    ({
      eventReceipts: receipts,
      createdAt: BEFORE,
      schemaVersion: 2,
      launch: {},
      ...over,
    }) as never;
  const ask = (record: ReturnType<typeof ledger>, seatId = "seat-b3", agentId = B3) =>
    needsFirstRead(record, { seatId, agentId, processStart: START });

  test("a member that never ran and was made before this process has to be read once", () => {
    expect(ask(ledger([stamp("created", B3, null, BEFORE)]))).toBe(true);
    // No created receipt: the Run's own start dates the Agent.
    expect(ask(ledger([]))).toBe(true);
  });

  test("not one made by this process: its created receipt or, with none, the Run itself is newer", () => {
    expect(ask(ledger([stamp("created", B3, null, AFTER)]))).toBe(false);
    expect(ask(ledger([], { createdAt: AFTER }))).toBe(false);
    // The earliest created receipt is the one that counts.
    expect(
      ask(ledger([stamp("created", B3, null, AFTER), stamp("created", B3, null, BEFORE)])),
    ).toBe(true);
  });

  test("not one that has turned in this Run (a finished turn or a cut-off one), however old", () => {
    const old = stamp("created", B3, null, BEFORE);
    expect(ask(ledger([old, stamp("turn_started", B3, "t", BEFORE)]))).toBe(false);
    expect(
      ask(
        ledger([old, stamp("turn_started", B3, "t", BEFORE), stamp("turn_ended", B3, "t", BEFORE)]),
      ),
    ).toBe(false);
  });

  test("not the coordinator", () => {
    expect(ask(ledger([]), "coordinator", "agent-coord")).toBe(false);
  });

  test("another agent's receipts say nothing about this one", () => {
    expect(
      ask(ledger([stamp("created", B3, null, AFTER), stamp("turn_started", B1, "t", BEFORE)])),
    ).toBe(false);
    expect(
      ask(ledger([stamp("created", B3, null, BEFORE), stamp("turn_started", B1, "t", BEFORE)])),
    ).toBe(true);
  });

  test("an Agent a rebuild made is dated by the rebuild: made by this process, it is not read", () => {
    const item = (requestedAt: string) => ({
      rebuildId: "rebuild-seat-b3-g1",
      seatId: "seat-b3",
      generation: 1,
      fromAgentId: "agent-old",
      toAgentId: B3,
      idempotencyKey: "key",
      title: "t（重建 1）",
      reason: "never-ran-unopenable",
      state: "bound",
      requestedAt,
      settledAt: requestedAt,
      error: null,
    });
    const withItem = (requestedAt: string) =>
      ledger([], { seatRebuilds: { version: 1, items: [item(requestedAt)] } });
    expect(agentBuiltAt(withItem(AFTER), B3)).toBe(AFTER);
    expect(ask(withItem(AFTER))).toBe(false);
    // One rebuilt by an earlier process is older than this one and has never run: read once.
    expect(ask(withItem(BEFORE))).toBe(true);
    // A created receipt of the Agent wins over the rebuild's record.
    expect(
      agentBuiltAt(
        ledger([stamp("created", B3, null, AFTER)], {
          seatRebuilds: { version: 1, items: [item(BEFORE)] },
        }),
        B3,
      ),
    ).toBe(AFTER);
  });
});

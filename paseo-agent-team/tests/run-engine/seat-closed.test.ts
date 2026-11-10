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
import { compileDispatch } from "../../shared/domain/run-engine/prompt-template";
import { emptyReadRetries } from "../../shared/domain/run-engine/read-retry";
import {
  eligibleSeats,
  heldByClosedSeat,
  planDispatchWithReasons,
  type SeatDenial,
  type SeatRuntime,
} from "../../shared/domain/run-engine/scheduler";
import {
  SEAT_CLOSED_ALERT,
  SEAT_CLOSED_ALERT_PREFIX,
} from "../../shared/domain/run-engine/seat-closed";
import { explainWaiting } from "../../shared/domain/run-engine/waiting";
import type { PaseoEnginePort, PortAgentSnapshot, PortTimelinePage } from "../../shared/paseo/port";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { PROFILE_HAIKU } from "../fixtures/run-engine/base";
import { readyRun } from "./support/ready-run";
import { JUDGE_SEAT_REVIEW, reviewRun } from "./support/review-run";

/**
 * T9f: after a daemon restart every member that was not mid-turn reads as closed. The seat used to be
 * recorded as `busy` (the Runs page said "席位正忙", a person waited for ever); it is now refused as
 * `seat-closed`, which is still a wait (never a decision), and one warning tells the person that the
 * Engine will not reopen it and what to do. Failure modes this file guards:
 *  - a closed seat called busy, on the producer path or on the review path;
 *  - a closed seat opening a decision (D1) instead of waiting;
 *  - the warning missing, written on every pass, raised when an idle eligible seat or a seat that
 *    will free itself exists, or left up once the seat is idle again and the dispatch went out;
 *  - an archived seat changing its reason or raising the warning alone.
 */

const RUN_ID = "run-seatcl-a1";
const PRODUCER_AGENT = "agent-b1";
const OTHER_AGENT = "agent-b3";
const JUDGE_AGENT = "agent-b2";

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

/** A host whose agents are idle, closed (what a restart leaves) or running, by agent id. */
function fakeHost() {
  const closed = new Set<string>();
  const running = new Set<string>();
  const unreadable = new Set<string>();
  const sent: { agentId: string; text: string }[] = [];
  const snapshot = (agentId: string): PortAgentSnapshot => {
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
        timeline: { refetch: async () => emptyPage },
        current: () => snapshot(agentId),
        refresh: async () => {
          if (unreadable.has(agentId)) throw new Error("host read failed");
          return { agent: snapshot(agentId) };
        },
      }),
    },
  };
  return { port, sent, closed, running, unreadable };
}

type Host = ReturnType<typeof fakeHost>;

function makeService(host: Host) {
  const effects = createEffects({ store, port: host.port, compile: compileDispatch });
  return createEngineService({
    store,
    port: host.port,
    effects,
    resolveSeat: (_record, seatId) => {
      if (seatId === "seat-b1" || seatId === "seat-b3") {
        return {
          profile: {
            id: PROFILE_HAIKU.id,
            name: PROFILE_HAIKU.name,
            provider: PROFILE_HAIKU.provider,
            model: PROFILE_HAIKU.model,
            family: PROFILE_HAIKU.family,
          },
          available: true,
          order: seatId === "seat-b1" ? 0 : 1,
        };
      }
      if (seatId === JUDGE_SEAT_REVIEW) {
        return {
          profile: {
            id: "profile-dev-luna",
            name: "DEV Luna",
            provider: "codex",
            model: "gpt-6-luna",
            family: "luna",
          },
          available: true,
          order: 2,
        };
      }
      return null;
    },
    resolveWorkspace: () => ({ workspaceId: "ws-start", directory: repoDir }),
    compile: compileDispatch,
  });
}

/** What a kick runs: only the service and the store are used by it, so the rest are stand-ins. */
function makeDriver(host: Host) {
  const none = {} as never;
  return createEngineDriver({
    store,
    observer: none,
    host: none,
    intake: none,
    dagIntake: none,
    service: makeService(host),
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

/** A second producer seat on the same Profile, so a closed seat can have a neighbour. */
function withSecondSeat(record: RunRecord): void {
  const first = record.roster.find((seat) => seat.seatId === "seat-b1");
  if (!first) throw new Error("fixture lost seat-b1");
  record.roster.push({ ...first, seatId: "seat-b3", agentId: OTHER_AGENT });
  record.budgets.entries.push({
    scope: "seat",
    subjectId: "seat-b3",
    limit: 6,
    reserved: 0,
    confirmed: 0,
    observedTurns: 0,
  });
}

async function seed(mutate: (record: RunRecord) => void = () => undefined): Promise<void> {
  const record = readyRun({ runId: RUN_ID, repoId, evidenceRoot });
  record.schemaVersion = schema;
  if (schema === 2) (record as Record<string, unknown>).readRetries = emptyReadRetries();
  mutate(record);
  await store.create(record);
}

/** t1 delivered a real commit and waits for its review; the judge seat is `agent-b2`. */
async function seedReview(): Promise<void> {
  const baseSha = git(repoDir, "rev-parse", "HEAD");
  await writeFile(path.join(repoDir, "src", "t1.ts"), "export const t1 = 1;\n");
  git(repoDir, "add", "--", "src/t1.ts");
  git(repoDir, "commit", "-q", "-m", "deliver t1");
  const headSha = git(repoDir, "rev-parse", "HEAD");
  const record = reviewRun({ runId: RUN_ID, repoId, evidenceRoot, baseSha, headSha });
  record.schemaVersion = schema;
  if (schema === 2) (record as Record<string, unknown>).readRetries = emptyReadRetries();
  await store.create(record);
}

function archivedReceipt(agentId: string): (record: RunRecord) => void {
  return (record) => {
    record.eventReceipts.push({
      eventKey: `${agentId}|archived`,
      kind: "archived",
      agentId,
      turnId: null,
      seq: record.counters.observationSeq,
      receivedAt: record.updatedAt,
      dedupeKey: `${agentId}|archived`,
      disposition: "accepted",
    });
  };
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), "run-seatclosed-")));
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

for (const version of [1, 2] as const) {
  describe(`a closed seat is not a busy one [v${version}]`, () => {
    beforeEach(() => {
      schema = version;
    });

    test("the producer seat read as closed is refused as seat-closed, waits (no decision) and sends nothing", async () => {
      await seed();
      const host = fakeHost();
      host.closed.add(PRODUCER_AGENT);
      const driver = makeDriver(host);
      const report = await driver.kick(RUN_ID);

      expect(report.dispatched).toBe(0);
      expect(report.last).toMatchObject({ status: "waiting", taskId: "t2", reason: "no-seat" });
      if (report.last.status === "waiting") {
        expect(report.last.denials).toContainEqual({ seatId: "seat-b1", reason: "seat-closed" });
        expect(report.last.denials.map((denial) => denial.reason)).not.toContain("busy");
      }
      const after = await stored();
      const reason = after.tasks.find((task) => task.spec.id === "t2")?.waitingReason ?? "";
      expect(reason).toContain("seat-closed");
      expect(reason).not.toContain("busy");
      expect(explainWaiting(reason).known).toBe(true);
      expect(JSON.stringify(explainWaiting(reason))).toContain("已关闭");
      expect(JSON.stringify(explainWaiting(reason))).not.toContain("正忙");
      expect(after.tasks.find((task) => task.spec.id === "t2")?.state).toBe("ready");
      expect(host.sent).toHaveLength(0);
    });

    test("the review seat read as closed is refused as seat-closed, not busy", async () => {
      await seedReview();
      const host = fakeHost();
      host.closed.add(JUDGE_AGENT);
      const result = await makeService(host).dispatchNext(RUN_ID);

      expect(result).toMatchObject({ status: "waiting", taskId: "t1", reason: "no-seat" });
      if (result.status === "waiting") {
        expect(result.denials).toContainEqual({ seatId: JUDGE_SEAT_REVIEW, reason: "seat-closed" });
        expect(result.denials).toContainEqual({ seatId: "seat-b1", reason: "same-as-producer" });
        expect(result.denials.map((denial) => denial.reason)).not.toContain("busy");
      }
      expect(host.sent).toHaveLength(0);
    });

    test("only closed seats hold the task: exactly one warning, and asking again writes nothing", async () => {
      await seed();
      const host = fakeHost();
      host.closed.add(PRODUCER_AGENT);
      const driver = makeDriver(host);
      await driver.kick(RUN_ID);
      const first = await stored();

      const alerts = seatAlerts(first);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        state: "open",
        severity: "warning",
        summary: SEAT_CLOSED_ALERT,
      });
      expect(eventsOf(first, "alert-raised")).toHaveLength(1);

      await driver.kick(RUN_ID);
      await driver.kick(RUN_ID);
      const again = await stored();
      expect(again.revision).toBe(first.revision);
      expect(seatAlerts(again)).toHaveLength(1);
      expect(eventsOf(again, "alert-raised")).toHaveLength(1);
      expect(host.sent).toHaveLength(0);
    });

    test("the warning tells what to do, in Chinese, without a raw reason code", () => {
      // T11a: the Engine has already tried to reopen it, by reading its history and sending nothing.
      expect(SEAT_CLOSED_ALERT).toContain("已经试过重新打开");
      expect(SEAT_CLOSED_ALERT).toContain("只读它的历史，不发消息");
      expect(SEAT_CLOSED_ALERT).toContain("也不会改派");
      // What cannot be opened, and the way out.
      expect(SEAT_CLOSED_ALERT).toContain("从没开过回合的成员");
      expect(SEAT_CLOSED_ALERT).toContain("第一个回合开头几秒就被打断的成员");
      expect(SEAT_CLOSED_ALERT).toContain("立即检查并推进");
      expect(SEAT_CLOSED_ALERT).toContain("取消这个 Run 后重新启动");
      expect(SEAT_CLOSED_ALERT).toContain("Codex");
      expect(SEAT_CLOSED_ALERT).toContain("不要给它发消息");
      expect(SEAT_CLOSED_ALERT).not.toContain("不会自己重新打开");
      expect(SEAT_CLOSED_ALERT).not.toContain("seat-closed");
    });

    test("the seat is idle again: one dispatch goes out and the warning is taken down once", async () => {
      await seed();
      const host = fakeHost();
      host.closed.add(PRODUCER_AGENT);
      const driver = makeDriver(host);
      await driver.kick(RUN_ID);
      expect(seatAlerts(await stored())).toHaveLength(1);

      host.closed.delete(PRODUCER_AGENT);
      const report = await driver.kick(RUN_ID);
      expect(report.dispatched).toBe(1);
      expect(host.sent.map((entry) => entry.agentId)).toEqual([PRODUCER_AGENT]);
      const after = await stored();
      expect(after.tasks.find((task) => task.spec.id === "t2")?.state).toBe("assigned");
      expect(seatAlerts(after).map((alert) => alert.state)).toEqual(["resolved"]);
      expect(eventsOf(after, "alert-resolved")).toHaveLength(1);
      expect(eventsOf(after, "alert-raised")).toHaveLength(1);

      // Nothing more to do: a further pass neither writes nor sends.
      const quiet = await driver.kick(RUN_ID);
      expect(quiet.dispatched).toBe(0);
      expect((await stored()).revision).toBe(after.revision);
      expect(eventsOf(await stored(), "alert-resolved")).toHaveLength(1);
      expect(host.sent).toHaveLength(1);
    });

    test("the seat is idle again but the dispatch is blocked by something else: the warning no longer applies and is taken down", async () => {
      await seed();
      const host = fakeHost();
      host.closed.add(PRODUCER_AGENT);
      const service = makeService(host);
      await service.dispatchNext(RUN_ID);
      expect(seatAlerts(await stored())).toHaveLength(1);

      host.closed.delete(PRODUCER_AGENT);
      await writeFile(path.join(repoDir, "stray.txt"), "x");
      expect(await service.dispatchNext(RUN_ID)).toMatchObject({
        status: "blocked",
        reason: "workspace-dirty",
      });
      const after = await stored();
      expect(seatAlerts(after).map((alert) => alert.state)).toEqual(["resolved"]);
      expect(host.sent).toHaveLength(0);
    });

    test("the review seat is idle again: the reviewer is sent once and the warning is taken down", async () => {
      await seedReview();
      const host = fakeHost();
      host.closed.add(JUDGE_AGENT);
      const service = makeService(host);
      expect(await service.dispatchNext(RUN_ID)).toMatchObject({ status: "waiting" });
      const held = await stored();
      expect(seatAlerts(held)).toHaveLength(1);
      expect(await service.dispatchNext(RUN_ID)).toMatchObject({ status: "waiting" });
      expect((await stored()).revision).toBe(held.revision);

      host.closed.delete(JUDGE_AGENT);
      const result = await service.dispatchNext(RUN_ID);
      expect(result).toMatchObject({ status: "dispatched", purpose: "reviewer" });
      expect(host.sent.map((entry) => entry.agentId)).toEqual([JUDGE_AGENT]);
      const after = await stored();
      expect(seatAlerts(after).map((alert) => alert.state)).toEqual(["resolved"]);
      expect(eventsOf(after, "alert-resolved")).toHaveLength(1);
    });

    test("an idle eligible seat takes the work as usual and no warning is raised", async () => {
      await seed(withSecondSeat);
      const host = fakeHost();
      host.closed.add(PRODUCER_AGENT);
      const result = await makeService(host).dispatchNext(RUN_ID);

      expect(result).toMatchObject({ status: "dispatched", seatId: "seat-b3" });
      expect(host.sent.map((entry) => entry.agentId)).toEqual([OTHER_AGENT]);
      const after = await stored();
      expect(seatAlerts(after)).toEqual([]);
      expect(eventsOf(after, "alert-raised")).toEqual([]);
    });

    test("a neighbour that is only busy makes it a plain wait: no warning", async () => {
      await seed(withSecondSeat);
      const host = fakeHost();
      host.closed.add(PRODUCER_AGENT);
      host.running.add(OTHER_AGENT);
      const result = await makeService(host).dispatchNext(RUN_ID);

      expect(result).toMatchObject({ status: "waiting", taskId: "t2" });
      if (result.status === "waiting") {
        expect(result.denials).toContainEqual({ seatId: "seat-b1", reason: "seat-closed" });
        expect(result.denials).toContainEqual({ seatId: "seat-b3", reason: "busy" });
      }
      expect(seatAlerts(await stored())).toEqual([]);
    });

    test("an archived seat is still seat-archived, and alone it raises no warning", async () => {
      await seed(archivedReceipt(PRODUCER_AGENT));
      const host = fakeHost();
      host.closed.add(PRODUCER_AGENT);
      const result = await makeService(host).dispatchNext(RUN_ID);

      expect(result).toMatchObject({ status: "waiting", taskId: "t2" });
      if (result.status === "waiting") {
        expect(result.denials).toContainEqual({ seatId: "seat-b1", reason: "seat-archived" });
        expect(result.denials.map((denial) => denial.reason)).not.toContain("seat-closed");
      }
      expect(seatAlerts(await stored())).toEqual([]);
    });

    test("an archived seat next to a closed one still gets the warning", async () => {
      await seed((record) => {
        withSecondSeat(record);
        record.eventReceipts.push({
          eventKey: "agent-b1|archived",
          kind: "archived",
          agentId: PRODUCER_AGENT,
          turnId: null,
          seq: record.counters.observationSeq,
          receivedAt: record.updatedAt,
          dedupeKey: "agent-b1|archived",
          disposition: "accepted",
        });
      });
      const host = fakeHost();
      host.closed.add(OTHER_AGENT);
      const result = await makeService(host).dispatchNext(RUN_ID);

      expect(result).toMatchObject({ status: "waiting" });
      expect(seatAlerts(await stored())).toHaveLength(1);
    });

    test("a seat the host could not be read for is not a closed one: no seat-closed refusal, no warning", async () => {
      await seed();
      const host = fakeHost();
      host.unreadable.add(PRODUCER_AGENT);
      const result = await makeService(host).dispatchNext(RUN_ID);

      expect(result).toMatchObject({ status: "waiting", taskId: "t2" });
      if (result.status === "waiting") {
        expect(result.denials.map((denial) => denial.reason)).not.toContain("seat-closed");
      }
      expect(seatAlerts(await stored())).toEqual([]);
      expect(host.sent).toHaveLength(0);
    });

    test("an acknowledged warning is not written again while the seat is still closed", async () => {
      await seed((record) => {
        record.alerts.push({
          alertId: alertIdFor(SEAT_CLOSED_ALERT_PREFIX),
          state: "acknowledged",
          severity: "warning",
          summary: SEAT_CLOSED_ALERT,
          createdAt: record.updatedAt,
          acknowledgedAt: record.updatedAt,
          resolvedAt: null,
        });
      });
      const host = fakeHost();
      host.closed.add(PRODUCER_AGENT);
      const driver = makeDriver(host);
      await driver.kick(RUN_ID);
      const before = await stored();
      await driver.kick(RUN_ID);

      const after = await stored();
      expect(after.revision).toBe(before.revision);
      expect(seatAlerts(after).map((alert) => alert.state)).toEqual(["acknowledged"]);
      expect(eventsOf(after, "alert-raised")).toEqual([]);
    });

    test("nothing left to dispatch takes an open warning down, once", async () => {
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
      host.closed.add(PRODUCER_AGENT);
      const service = makeService(host);
      expect(await service.dispatchNext(RUN_ID)).toEqual({ status: "idle" });
      const after = await stored();
      expect(seatAlerts(after).map((alert) => alert.state)).toEqual(["resolved"]);
      expect(eventsOf(after, "alert-resolved")).toHaveLength(1);

      expect(await service.dispatchNext(RUN_ID)).toEqual({ status: "idle" });
      expect((await stored()).revision).toBe(after.revision);
    });

    for (const lifecycle of ["finished", "cancelled"] as const) {
      test(`a ${lifecycle} Run takes its open warning down, once, and sends nothing`, async () => {
        await seed((record) => {
          record.lifecycle = lifecycle;
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
        host.closed.add(PRODUCER_AGENT);
        const service = makeService(host);
        expect(await service.dispatchNext(RUN_ID)).toEqual({ status: "idle" });
        const after = await stored();
        expect(seatAlerts(after).map((alert) => alert.state)).toEqual(["resolved"]);
        expect(eventsOf(after, "alert-resolved")).toHaveLength(1);

        expect(await service.dispatchNext(RUN_ID)).toEqual({ status: "idle" });
        expect((await stored()).revision).toBe(after.revision);
        expect(host.sent).toHaveLength(0);
      });
    }

    test("a paused Run keeps its open warning and is not written to", async () => {
      await seed((record) => {
        record.lifecycle = "paused";
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
      host.closed.add(PRODUCER_AGENT);
      const before = await stored();
      expect(await makeService(host).dispatchNext(RUN_ID)).toEqual({ status: "idle" });
      const after = await stored();
      expect(after.revision).toBe(before.revision);
      expect(seatAlerts(after).map((alert) => alert.state)).toEqual(["open"]);
    });

    test("a Run with nothing to dispatch and no warning is not written to", async () => {
      await seed((record) => {
        const t2 = record.tasks.find((task) => task.spec.id === "t2");
        if (t2) t2.state = "pending";
      });
      const host = fakeHost();
      host.closed.add(PRODUCER_AGENT);
      const before = await stored();
      expect(await makeService(host).dispatchNext(RUN_ID)).toEqual({ status: "idle" });
      expect((await stored()).revision).toBe(before.revision);
    });
  });
}

// --- the scheduler on its own ----------------------------------------------------------------

function seat(overrides: Partial<SeatRuntime> = {}): SeatRuntime {
  return {
    seatId: "seat-b1",
    profileId: PROFILE_HAIKU.id,
    agentId: PRODUCER_AGENT,
    enabled: true,
    idle: true,
    permissionPending: false,
    degraded: false,
    channelState: "available",
    available: true,
    load: 0,
    qualityRework: 0,
    order: 0,
    ...overrides,
  };
}

describe("the scheduler refuses a closed seat as seat-closed", () => {
  const ctx = (seats: SeatRuntime[]) => ({
    now: "2026-11-05T12:00:00.000Z",
    mode: "sota" as const,
    seats,
  });

  test("closed wins over busy and degraded (a closed seat reads as neither idle nor healthy)", () => {
    const record = readyRun();
    const eligibility = eligibleSeats(
      record,
      "t2",
      ctx([seat({ closed: true, idle: false, degraded: true })]),
    );
    expect(eligibility.candidates).toEqual([]);
    expect(eligibility.denials).toEqual([{ seatId: "seat-b1", reason: "seat-closed" }]);
  });

  test("archived is checked before closed", () => {
    const record = readyRun();
    const eligibility = eligibleSeats(
      record,
      "t2",
      ctx([seat({ archived: true, closed: true, idle: false })]),
    );
    expect(eligibility.denials).toEqual([{ seatId: "seat-b1", reason: "seat-archived" }]);
  });

  test("a task blocked only by a closed seat waits: it is not a D1 decision", () => {
    const record = readyRun();
    const plan = planDispatchWithReasons(record, ctx([seat({ closed: true, idle: false })]));
    expect(plan.proposals).toEqual([]);
    expect(plan.blocked).toMatchObject([{ taskId: "t2", decision: "wait" }]);
  });

  test("a seat that is not closed is chosen as before", () => {
    const record = readyRun();
    const eligibility = eligibleSeats(record, "t2", ctx([seat({ closed: false })]));
    expect(eligibility.candidates.map((entry) => entry.seatId)).toEqual(["seat-b1"]);
  });

  test("heldByClosedSeat: a closed seat with only closed or archived temporary reasons", () => {
    const d = (reason: SeatDenial["reason"]): SeatDenial => ({ seatId: "s", reason });
    expect(heldByClosedSeat([d("seat-closed")])).toBe(true);
    expect(heldByClosedSeat([d("seat-closed"), d("seat-archived")])).toBe(true);
    expect(heldByClosedSeat([d("seat-closed"), d("same-as-producer"), d("tier"), d("duty")])).toBe(
      true,
    );
    expect(heldByClosedSeat([])).toBe(false);
    expect(heldByClosedSeat([d("seat-archived")])).toBe(false);
    expect(heldByClosedSeat([d("seat-closed"), d("busy")])).toBe(false);
    expect(heldByClosedSeat([d("seat-closed"), d("permission")])).toBe(false);
    expect(heldByClosedSeat([d("seat-closed"), d("degraded")])).toBe(false);
    expect(heldByClosedSeat([d("seat-closed"), d("agent-missing")])).toBe(false);
    expect(heldByClosedSeat([d("seat-closed"), d("channel")])).toBe(false);
    expect(heldByClosedSeat([d("seat-closed"), d("profile-unavailable")])).toBe(false);
    expect(heldByClosedSeat([d("tier"), d("duty")])).toBe(false);
  });
});

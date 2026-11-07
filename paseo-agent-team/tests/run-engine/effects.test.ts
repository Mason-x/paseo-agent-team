import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createEffects, type EffectsOptions, payloadHash } from "../../server/run-engine/effects";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import { transitionIntent } from "../../shared/domain/run-engine/effect-state";
import { reduceRun } from "../../shared/domain/run-engine/reducer";
import type { PaseoEnginePort, PortTimelinePage } from "../../shared/paseo/port";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { bootstrapRun } from "./support/bootstrap-run";
import {
  INTENT_T1,
  INTENT_T2,
  MESSAGE_T1,
  MESSAGE_T2,
  PROMPT_T2,
  preparedRun,
  RECIPIENT,
} from "./support/prepared-run";

const HASH = payloadHash(PROMPT_T2);
const homes: string[] = [];
const stores: RunStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

async function openStore(): Promise<RunStore> {
  const home = await mkdtemp(path.join(tmpdir(), "run-effects-"));
  homes.push(home);
  const store = createRunStore({ home, lock: { acquireTimeoutMs: 300 } });
  stores.push(store);
  await store.initialize();
  return store;
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

function echoPage(messageId: string): PortTimelinePage {
  return {
    ...emptyPage,
    entries: [
      { item: { type: "user_message", messageId }, turnId: "turn-9", seqStart: 1, seqEnd: 1 },
    ],
  };
}

type Sent = { agentId: string; text: string; options: unknown };

/** A host that records every send and serves whatever timeline page the test installs. */
function fakeHost(initial: { send?: () => Promise<void>; page?: PortTimelinePage } = {}) {
  const sent: Sent[] = [];
  const state = { page: initial.page ?? emptyPage, send: initial.send ?? (async () => undefined) };
  const port: PaseoEnginePort = {
    agents: {
      ref: (agentId) => ({
        send: async (text, options) => {
          sent.push({ agentId, text, options });
          await state.send();
        },
        archive: async () => ({}),
        timeline: { refetch: async () => state.page },
        current: () => null,
        refresh: async () => null,
      }),
    },
  };
  return { port, sent, state };
}

function effectsFor(
  store: Pick<RunStore, "get" | "update">,
  port: PaseoEnginePort,
  extra: Partial<EffectsOptions> = {},
) {
  return createEffects({
    store,
    port,
    compile: (intent) => (intent.id === INTENT_T2 ? PROMPT_T2 : null),
    clock: { now: () => "2026-11-05T12:00:00.000Z" },
    ...extra,
  });
}

async function seed(store: RunStore, runId: string, record = preparedRun(runId, HASH)) {
  await store.create(record);
  return record;
}

async function intentState(store: RunStore, runId: string, intentId = INTENT_T2) {
  const read = await store.get(runId);
  if (read.status !== "ok") throw new Error(`run not readable: ${read.status}`);
  return read.record.outbox.find((intent) => intent.id === intentId);
}

async function eventKinds(store: RunStore, runId: string): Promise<string[]> {
  const read = await store.get(runId);
  if (read.status !== "ok") throw new Error("run not readable");
  return read.record.events.map((event) => event.kind);
}

describe("outbox: normal path", () => {
  test("sends a prepared dispatch once, with its messageId and an explicit turn behaviour", async () => {
    const store = await openStore();
    await seed(store, "run-fx0001-a1");
    const host = fakeHost();
    const report = await effectsFor(store, host.port).runOutbox("run-fx0001-a1");

    expect(report).toEqual({
      status: "ok",
      sent: [INTENT_T2],
      reconciled: [],
      unknown: [],
      failed: [],
    });
    expect(host.sent).toEqual([
      {
        agentId: RECIPIENT,
        text: PROMPT_T2,
        options: { messageId: MESSAGE_T2, activeTurnBehavior: "steer" },
      },
    ]);
    expect(await intentState(store, "run-fx0001-a1")).toMatchObject({
      state: "confirmed",
      confirmedAt: "2026-11-05T12:00:00.000Z",
    });
    const kinds = await eventKinds(store, "run-fx0001-a1");
    expect(kinds.slice(-2)).toEqual(["intent-sending", "intent-confirmed"]);
  });

  test("a second call has nothing left to send", async () => {
    const store = await openStore();
    await seed(store, "run-fx0002-a1");
    const host = fakeHost();
    const effects = effectsFor(store, host.port);
    await effects.runOutbox("run-fx0002-a1");
    const again = await effects.runOutbox("run-fx0002-a1");
    expect(again).toMatchObject({ sent: [], reconciled: [], unknown: [], failed: [] });
    expect(host.sent).toHaveLength(1);
  });

  test("the turn behaviour is configurable but fixed for the Run", async () => {
    const store = await openStore();
    await seed(store, "run-fx0003-a1");
    const host = fakeHost();
    await effectsFor(store, host.port, { activeTurnBehavior: "interrupt" }).runOutbox(
      "run-fx0003-a1",
    );
    expect(host.sent[0]?.options).toEqual({
      messageId: MESSAGE_T2,
      activeTurnBehavior: "interrupt",
    });
  });

  test("an unreadable or missing run is reported, nothing is sent", async () => {
    const store = await openStore();
    const host = fakeHost();
    const report = await effectsFor(store, host.port).runOutbox("run-missing-a1");
    expect(report.status).toBe("run-unavailable");
    expect(host.sent).toEqual([]);
  });
});

describe("outbox: the payload the ledger committed to is the only one sent", () => {
  test("a hash that does not match the rebuilt prompt is refused and never sent", async () => {
    const store = await openStore();
    await seed(store, "run-fx0010-a1", preparedRun("run-fx0010-a1", "b".repeat(64)));
    const host = fakeHost();
    const report = await effectsFor(store, host.port).runOutbox("run-fx0010-a1");
    expect(report.failed).toEqual([INTENT_T2]);
    expect(host.sent).toEqual([]);
    expect(await intentState(store, "run-fx0010-a1")).toMatchObject({ state: "failed" });
    expect((await store.get("run-fx0010-a1")) as unknown).toMatchObject({
      record: {
        events: expect.arrayContaining([expect.objectContaining({ kind: "intent-failed" })]),
      },
    });
  });

  test("a prompt that cannot be rebuilt is refused and never sent", async () => {
    const store = await openStore();
    await seed(store, "run-fx0011-a1");
    const host = fakeHost();
    const report = await effectsFor(store, host.port, { compile: () => null }).runOutbox(
      "run-fx0011-a1",
    );
    expect(report.failed).toEqual([INTENT_T2]);
    expect(host.sent).toEqual([]);
  });
});

describe("outbox: lost responses and crash windows never become a second send", () => {
  test("AC05: a send that throws is outcome-unknown, not failed, and is not retried", async () => {
    const store = await openStore();
    await seed(store, "run-fx0020-a1");
    const host = fakeHost({
      send: async () => {
        throw Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
      },
    });
    const effects = effectsFor(store, host.port);
    const first = await effects.runOutbox("run-fx0020-a1");
    expect(first.unknown).toEqual([INTENT_T2]);
    expect(first.sent).toEqual([]);

    // Still no echo on the next pass: the intent stays frozen and nothing is sent again.
    const second = await effects.runOutbox("run-fx0020-a1");
    expect(second.unknown).toEqual([INTENT_T2]);
    expect(host.sent).toHaveLength(1);
    const intent = await intentState(store, "run-fx0020-a1");
    expect(intent).toMatchObject({ state: "outcome-unknown", confirmedAt: null });
    const read = await store.get("run-fx0020-a1");
    if (read.status !== "ok") throw new Error("unreadable");
    const event = read.record.events.find((entry) => entry.kind === "intent-outcome-unknown");
    expect(event?.payload.reason).toBe("send:ECONNRESET");
    expect(JSON.stringify(read.record)).not.toContain("socket closed");
  });

  test("the host did receive it: the timeline echo settles the intent without a resend", async () => {
    const store = await openStore();
    await seed(store, "run-fx0021-a1");
    const host = fakeHost({
      send: async () => {
        throw new Error("reply lost");
      },
    });
    const effects = effectsFor(store, host.port);
    await effects.runOutbox("run-fx0021-a1");

    host.state.page = echoPage(MESSAGE_T2);
    const report = await effects.runOutbox("run-fx0021-a1");
    expect(report.reconciled).toEqual([INTENT_T2]);
    expect(report.unknown).toEqual([]);
    expect(host.sent).toHaveLength(1);
    expect(await intentState(store, "run-fx0021-a1")).toMatchObject({ state: "confirmed" });
  });

  test("AC04: a crash after `sending` was committed does not send again", async () => {
    const store = await openStore();
    await seed(store, "run-fx0022-a1");
    // The previous process committed `sending` and died before (or during) the call.
    await store.update("run-fx0022-a1", (current) => {
      const moved = transitionIntent(current, INTENT_T2, "sending", {
        now: "2026-11-05T11:59:00.000Z",
      });
      return moved.ok ? moved.next : null;
    });

    const host = fakeHost();
    const report = await effectsFor(store, host.port).runOutbox("run-fx0022-a1");
    expect(host.sent).toEqual([]);
    expect(report.unknown).toEqual([INTENT_T2]);
    expect(await intentState(store, "run-fx0022-a1")).toMatchObject({ state: "outcome-unknown" });
  });

  test("AC04: if the call did land before the crash, the echo confirms it", async () => {
    const store = await openStore();
    await seed(store, "run-fx0023-a1");
    await store.update("run-fx0023-a1", (current) => {
      const moved = transitionIntent(current, INTENT_T2, "sending", {
        now: "2026-11-05T11:59:00.000Z",
      });
      return moved.ok ? moved.next : null;
    });

    const host = fakeHost({ page: echoPage(MESSAGE_T2) });
    const report = await effectsFor(store, host.port).runOutbox("run-fx0023-a1");
    expect(host.sent).toEqual([]);
    expect(report.reconciled).toEqual([INTENT_T2]);
    expect(await intentState(store, "run-fx0023-a1")).toMatchObject({ state: "confirmed" });
  });

  test("a failed `sending` commit sends nothing", async () => {
    const store = await openStore();
    await seed(store, "run-fx0024-a1");
    const host = fakeHost();
    const broken = {
      get: store.get.bind(store),
      update: async () => {
        throw new Error("disk full");
      },
    };
    await expect(effectsFor(broken, host.port).runOutbox("run-fx0024-a1")).rejects.toThrow(
      "disk full",
    );
    expect(host.sent).toEqual([]);
    expect(await intentState(store, "run-fx0024-a1")).toMatchObject({ state: "prepared" });
  });

  test("a failed `confirmed` commit leaves `sending`; the next pass settles it by echo", async () => {
    const store = await openStore();
    await seed(store, "run-fx0025-a1");
    const host = fakeHost();
    let calls = 0;
    const flaky = {
      get: store.get.bind(store),
      update: async (runId: string, mutate: Parameters<RunStore["update"]>[1]) => {
        calls += 1;
        if (calls === 2) throw new Error("disk full");
        return store.update(runId, mutate);
      },
    };
    await expect(effectsFor(flaky, host.port).runOutbox("run-fx0025-a1")).rejects.toThrow(
      "disk full",
    );
    expect(host.sent).toHaveLength(1);
    expect(await intentState(store, "run-fx0025-a1")).toMatchObject({ state: "sending" });

    host.state.page = echoPage(MESSAGE_T2);
    const report = await effectsFor(store, host.port).runOutbox("run-fx0025-a1");
    expect(report.reconciled).toEqual([INTENT_T2]);
    expect(host.sent).toHaveLength(1);
    expect(await intentState(store, "run-fx0025-a1")).toMatchObject({ state: "confirmed" });
  });

  test("an incomplete timeline read is not evidence of absence", async () => {
    const store = await openStore();
    await seed(store, "run-fx0026-a1");
    const host = fakeHost({
      send: async () => {
        throw new Error("reply lost");
      },
    });
    const effects = effectsFor(store, host.port);
    await effects.runOutbox("run-fx0026-a1");
    host.state.page = { ...emptyPage, gap: true };
    const report = await effects.runOutbox("run-fx0026-a1");
    expect(report.unknown).toEqual([INTENT_T2]);
    expect(host.sent).toHaveLength(1);
  });

  test("a timeline that cannot be read leaves the intent frozen", async () => {
    const store = await openStore();
    await seed(store, "run-fx0027-a1");
    const host = fakeHost({
      send: async () => {
        throw new Error("reply lost");
      },
    });
    const effects = effectsFor(store, host.port, { log: vi.fn() });
    await effects.runOutbox("run-fx0027-a1");
    host.port.agents.ref = () => {
      throw new Error("host down");
    };
    const report = await effects.runOutbox("run-fx0027-a1");
    expect(report.unknown).toEqual([INTENT_T2]);
    expect(await intentState(store, "run-fx0027-a1")).toMatchObject({ state: "outcome-unknown" });
  });
});

describe("outbox: ordering and concurrency", () => {
  test("an agent with an unresolved delivery receives nothing more", async () => {
    const store = await openStore();
    const record: RunRecord = preparedRun("run-fx0030-a1", HASH);
    const earlier = record.outbox.find((intent) => intent.id === INTENT_T1);
    if (!earlier) throw new Error("fixture lost the t1 intent");
    Object.assign(earlier, { state: "outcome-unknown", confirmedAt: null });
    await seed(store, "run-fx0030-a1", record);

    const host = fakeHost();
    const report = await effectsFor(store, host.port).runOutbox("run-fx0030-a1");
    expect(report.unknown).toEqual([INTENT_T1]);
    expect(host.sent).toEqual([]);
    expect(await intentState(store, "run-fx0030-a1")).toMatchObject({ state: "prepared" });

    // Once the earlier delivery is proven, the next intent for that agent goes out.
    host.state.page = echoPage(MESSAGE_T1);
    const later = await effectsFor(store, host.port).runOutbox("run-fx0030-a1");
    expect(later.reconciled).toEqual([INTENT_T1]);
    expect(later.sent).toEqual([INTENT_T2]);
    expect(host.sent).toHaveLength(1);
  });

  test("overlapping calls for one run send once", async () => {
    const store = await openStore();
    await seed(store, "run-fx0031-a1");
    const host = fakeHost({ send: () => new Promise((resolve) => setTimeout(resolve, 30)) });
    const effects = effectsFor(store, host.port);
    const [a, b] = await Promise.all([
      effects.runOutbox("run-fx0031-a1"),
      effects.runOutbox("run-fx0031-a1"),
    ]);
    expect(host.sent).toHaveLength(1);
    expect(a.sent.length + b.sent.length).toBe(1);
    expect(await intentState(store, "run-fx0031-a1")).toMatchObject({ state: "confirmed" });
  });

  test("two runners on the same ledger cannot both send", async () => {
    const store = await openStore();
    await seed(store, "run-fx0032-a1");
    const host = fakeHost({ send: () => new Promise((resolve) => setTimeout(resolve, 30)) });
    await Promise.all([
      effectsFor(store, host.port).runOutbox("run-fx0032-a1"),
      effectsFor(store, host.port).runOutbox("run-fx0032-a1"),
    ]);
    expect(host.sent).toHaveLength(1);
  });
});

describe("outbox: a Run that is not live sends nothing new (plan point 36)", () => {
  const NOW = { now: "2026-11-05T12:00:00.000Z", newId: () => "x" };

  /** The ledger moves to `lifecycle` by the reducer where it has an event, by hand where it has none. */
  async function setLifecycle(store: RunStore, runId: string, lifecycle: RunRecord["lifecycle"]) {
    await store.update(runId, (current) => {
      if (lifecycle === "paused") {
        const out = reduceRun(current, { kind: "run-paused" }, NOW);
        return out.ok ? out.next : null;
      }
      if (lifecycle === "active" && current.lifecycle === "paused") {
        const out = reduceRun(current, { kind: "run-resumed" }, NOW);
        return out.ok ? out.next : null;
      }
      return { ...current, lifecycle };
    });
  }

  test.each(["paused", "finished", "cancelled"] as const)(
    "a %s Run keeps its prepared message prepared and sends nothing",
    async (lifecycle) => {
      const store = await openStore();
      await seed(store, "run-fx0040-a1");
      await setLifecycle(store, "run-fx0040-a1", lifecycle);
      const host = fakeHost();
      const report = await effectsFor(store, host.port).runOutbox("run-fx0040-a1");
      expect(report).toEqual({
        status: "ok",
        sent: [],
        reconciled: [],
        unknown: [],
        failed: [],
      });
      expect(host.sent).toEqual([]);
      expect(await intentState(store, "run-fx0040-a1")).toMatchObject({ state: "prepared" });
    },
  );

  test.each(["bootstrapping", "awaiting-dag", "active"] as const)(
    "a %s Run still sends (the plan request goes out while bootstrapping)",
    async (lifecycle) => {
      const store = await openStore();
      await seed(store, "run-fx0041-a1");
      await setLifecycle(store, "run-fx0041-a1", lifecycle);
      const host = fakeHost();
      const report = await effectsFor(store, host.port).runOutbox("run-fx0041-a1");
      expect(report.sent).toEqual([INTENT_T2]);
      expect(host.sent).toHaveLength(1);
    },
  );

  test("the pause that lands after the caller read the ledger still stops the send", async () => {
    const store = await openStore();
    await seed(store, "run-fx0042-a1");
    const before = await store.get("run-fx0042-a1");
    if (before.status !== "ok") throw new Error("unreadable");
    await setLifecycle(store, "run-fx0042-a1", "paused");
    // Every read the executor makes returns the active ledger it saw before the pause.
    const stale = { get: async () => before, update: store.update.bind(store) };
    const host = fakeHost();
    const report = await effectsFor(stale, host.port).runOutbox("run-fx0042-a1");
    expect(report.sent).toEqual([]);
    expect(host.sent).toEqual([]);
    expect(await intentState(store, "run-fx0042-a1")).toMatchObject({ state: "prepared" });
  });

  test("a paused Run still reads the host: an unknown delivery is settled by echo, never re-sent", async () => {
    const store = await openStore();
    await seed(store, "run-fx0043-a1");
    await store.update("run-fx0043-a1", (current) => {
      const moved = transitionIntent(current, INTENT_T2, "sending", {
        now: "2026-11-05T11:59:00.000Z",
      });
      return moved.ok ? moved.next : null;
    });
    await setLifecycle(store, "run-fx0043-a1", "paused");

    const host = fakeHost();
    const effects = effectsFor(store, host.port);
    const first = await effects.runOutbox("run-fx0043-a1");
    expect(first.unknown).toEqual([INTENT_T2]);
    expect(await intentState(store, "run-fx0043-a1")).toMatchObject({ state: "outcome-unknown" });

    host.state.page = echoPage(MESSAGE_T2);
    const second = await effects.runOutbox("run-fx0043-a1");
    expect(second.reconciled).toEqual([INTENT_T2]);
    expect(await intentState(store, "run-fx0043-a1")).toMatchObject({ state: "confirmed" });
    expect(host.sent).toEqual([]);
  });

  test("a finished Run still settles an unknown delivery by echo and sends nothing", async () => {
    const store = await openStore();
    await seed(store, "run-fx0044-a1");
    await store.update("run-fx0044-a1", (current) => {
      const sending = transitionIntent(current, INTENT_T2, "sending", {
        now: "2026-11-05T11:58:00.000Z",
      });
      if (!sending.ok) return null;
      const moved = transitionIntent(sending.next, INTENT_T2, "outcome-unknown", {
        now: "2026-11-05T11:59:00.000Z",
        reason: "send:test",
      });
      return moved.ok ? moved.next : null;
    });
    await setLifecycle(store, "run-fx0044-a1", "finished");
    const host = fakeHost({ page: echoPage(MESSAGE_T2) });
    const report = await effectsFor(store, host.port).runOutbox("run-fx0044-a1");
    expect(report.reconciled).toEqual([INTENT_T2]);
    expect(host.sent).toEqual([]);
  });

  test("the plan request (a wake) goes out while bootstrapping and waits when the Run is paused", async () => {
    const PLAN_TEXT = "plan request text";
    const bootstrap = (runId: string): RunRecord => {
      const record = bootstrapRun({ runId, planRequest: true });
      const plan = record.outbox.find((intent) => intent.id === "intent-plan-1");
      if (!plan) throw new Error("fixture lost the plan request");
      Object.assign(plan, {
        state: "prepared",
        confirmedAt: null,
        payloadHash: payloadHash(PLAN_TEXT),
      });
      return record;
    };
    const compile = (intent: { id: string }) => (intent.id === "intent-plan-1" ? PLAN_TEXT : null);

    const live = await openStore();
    await seed(live, "run-fx0046-a1", bootstrap("run-fx0046-a1"));
    const liveHost = fakeHost();
    const liveReport = await effectsFor(live, liveHost.port, { compile }).runOutbox(
      "run-fx0046-a1",
    );
    expect(liveReport.sent).toEqual(["intent-plan-1"]);

    for (const lifecycle of ["paused", "finished", "cancelled"] as const) {
      const runId = `run-fx0047-${lifecycle.slice(0, 2)}`;
      const store = await openStore();
      await seed(store, runId, { ...bootstrap(runId), lifecycle });
      const host = fakeHost();
      const report = await effectsFor(store, host.port, { compile }).runOutbox(runId);
      expect(report.sent).toEqual([]);
      expect(host.sent).toEqual([]);
      expect(await intentState(store, runId, "intent-plan-1")).toMatchObject({ state: "prepared" });
    }
  });

  test("resumed, the prepared message goes out once and only once", async () => {
    const store = await openStore();
    await seed(store, "run-fx0045-a1");
    await setLifecycle(store, "run-fx0045-a1", "paused");
    const host = fakeHost();
    const effects = effectsFor(store, host.port);
    expect((await effects.runOutbox("run-fx0045-a1")).sent).toEqual([]);
    expect((await effects.runOutbox("run-fx0045-a1")).sent).toEqual([]);

    await setLifecycle(store, "run-fx0045-a1", "active");
    expect((await effects.runOutbox("run-fx0045-a1")).sent).toEqual([INTENT_T2]);
    expect((await effects.runOutbox("run-fx0045-a1")).sent).toEqual([]);
    expect(host.sent).toHaveLength(1);
    expect(await intentState(store, "run-fx0045-a1")).toMatchObject({ state: "confirmed" });
  });
});

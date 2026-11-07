import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createEngineDriver } from "../../server/run-engine/driver";
import type { ObserverHost } from "../../server/run-engine/observer";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import { bootstrapRun } from "./support/bootstrap-run";

/**
 * A write (a re-plan, an answer) is followed by a retry of its Run. When a retry of that Run is
 * already running, the write's retry must not be swallowed by it: the running one began before the
 * write and may already be past the outbox and the dispatch that would have acted on it.
 */

const RUN_ID = "run-retry01-a1";
let home: string;
let store: RunStore;

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), "run-retry-")));
  await mkdir(path.join(home, "paseo"));
  store = createRunStore({ home: path.join(home, "paseo"), lock: { acquireTimeoutMs: 300 } });
  await store.initialize();
  await store.create(bootstrapRun({ runId: RUN_ID, planRequest: true }));
});

afterEach(async () => {
  await store.close().catch(() => undefined);
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** A driver whose outbox and dispatch are counted, and whose dispatch waits until the test lets go. */
function countedDriver() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const counts = { outbox: 0, dispatch: 0 };
  let reached: () => void = () => undefined;
  const inDispatch = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const driver = createEngineDriver({
    store,
    observer: {
      ingest: async () => ({ status: "recorded" }) as never,
      flush: async () => ({ delivered: 0 }) as never,
      reconcile: async () => ({}) as never,
    },
    host: {} as ObserverHost,
    intake: { settleAgent: async () => ({ status: "no-assignment" }) as never },
    dagIntake: { settleCoordinator: async () => [{ status: "no-pending-plan" }] as never },
    service: {
      dispatchNext: async () => {
        counts.dispatch += 1;
        reached();
        await gate;
        return { status: "idle" };
      },
    },
    outbox: {
      run: async () => {
        counts.outbox += 1;
      },
    },
  });
  return { driver, counts, release: () => release(), inDispatch };
}

test("a retry asked for by a write while another retry is past its outbox step gets a pass of its own", async () => {
  const { driver, counts, release, inDispatch } = countedDriver();
  const first = driver.retryRun(RUN_ID);
  await inDispatch; // the first retry has run its outbox step and is dispatching
  expect(counts.outbox).toBe(1);
  // A write committed now; its push asks for a retry of the same Run.
  const second = driver.retryRun(RUN_ID, { afterWrite: true });
  release();
  await Promise.all([first, second]);
  expect(counts.outbox).toBe(2);
  expect(counts.dispatch).toBe(2);
});

test("a burst of writes costs one more pass, and a person pressing retry again still joins", async () => {
  const { driver, counts, release, inDispatch } = countedDriver();
  const first = driver.retryRun(RUN_ID);
  await inDispatch;
  const rest = [
    driver.retryRun(RUN_ID),
    driver.retryRun(RUN_ID),
    driver.retryRun(RUN_ID, { afterWrite: true }),
    driver.retryRun(RUN_ID, { afterWrite: true }),
  ];
  release();
  await Promise.all([first, ...rest]);
  expect(counts.outbox).toBe(2);
  // Nothing is left over: the next retry starts clean and is one pass.
  await driver.retryRun(RUN_ID);
  expect(counts.outbox).toBe(3);
});

test("a retry with no write behind it joins the running one and costs nothing more", async () => {
  const { driver, counts, release, inDispatch } = countedDriver();
  const first = driver.retryRun(RUN_ID);
  await inDispatch;
  const others = [driver.retryRun(RUN_ID), driver.retryRun(RUN_ID)];
  release();
  await Promise.all([first, ...others]);
  expect(counts.outbox).toBe(1);
  expect(counts.dispatch).toBe(1);
});

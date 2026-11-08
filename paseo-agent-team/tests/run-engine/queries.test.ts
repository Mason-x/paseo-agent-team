import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { historyPage, projectDetail } from "../../server/run-engine/projection";
import { createRunQueries } from "../../server/run-engine/queries";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import {
  RunDecisionViewSchema,
  RunGetOutputSchema,
  RunListOutputSchema,
} from "../../shared/schemas/run-engine/rpc";
import { assignmentsForRun, noncesForRun, withLedger } from "../fixtures/run-engine/base";

const homes: string[] = [];
const stores: RunStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

async function setup(initialize = true) {
  const home = await mkdtemp(path.join(tmpdir(), "run-queries-"));
  homes.push(home);
  const store = createRunStore({ home, lock: { acquireTimeoutMs: 300 } });
  stores.push(store);
  if (initialize) await store.initialize();
  const queries = createRunQueries({
    store,
    ensureReady: () => store.initialize().catch(() => undefined),
  });
  return { home, store, queries };
}

const recordFile = (home: string, runId: string) =>
  path.join(home, "agent-team-runs", "v1", "runs", `${runId}.json`);

function ledger(runId: string, over: Record<string, unknown> = {}): RunRecord {
  return withLedger({
    runId,
    revision: 1,
    previousDigest: "",
    resources: [],
    assignments: assignmentsForRun(runId),
    nonceRegistry: noncesForRun(runId),
    ...over,
  });
}

describe("run.get", () => {
  test("a ready run parses against the output contract and exposes no secrets", async () => {
    const { store, queries } = await setup();
    const record = ledger("run-qry001-a1");
    await store.create(record);
    const out = await queries.get({ runContractVersion: 1, runId: "run-qry001-a1" });
    expect(RunGetOutputSchema.safeParse(out).success).toBe(true);
    expect(out.status).toBe("ready");
    const text = JSON.stringify(out);
    for (const entry of record.nonceRegistry) expect(text).not.toContain(entry.nonce);
    for (const entry of record.assignments) expect(text).not.toContain(entry.messageId);
    for (const entry of record.decisions) expect(text).not.toContain(entry.controlNonceDigest);
    expect(text).not.toContain("nonce");
    expect(text).not.toContain("outbox");
  });

  test("reading never changes the stored record", async () => {
    const { home, store, queries } = await setup();
    await store.create(ledger("run-qry002-a1"));
    const file = recordFile(home, "run-qry002-a1");
    const before = await readFile(file, "utf8");
    await queries.get({ runContractVersion: 1, runId: "run-qry002-a1" });
    await queries.list({ runContractVersion: 1 });
    await queries.get({ runContractVersion: 1, runId: "run-qry002-a1", knownRevision: 1 });
    expect(await readFile(file, "utf8")).toBe(before);
  });

  test("a matching knownRevision answers unchanged, a stale one answers ready", async () => {
    const { store, queries } = await setup();
    await store.create(ledger("run-qry003-a1"));
    expect(
      await queries.get({ runContractVersion: 1, runId: "run-qry003-a1", knownRevision: 1 }),
    ).toEqual({
      runContractVersion: 1,
      status: "unchanged",
      revision: 1,
    });
    expect(
      (await queries.get({ runContractVersion: 1, runId: "run-qry003-a1", knownRevision: 0 }))
        .status,
    ).toBe("ready");
  });

  test("missing, corrupt and unknown-version are distinct answers with a stable code", async () => {
    const { home, store } = await setup();
    await store.create(ledger("run-qry004-a1"));
    await store.create(ledger("run-qry004-b1"));
    await store.close();
    await writeFile(recordFile(home, "run-qry004-a1"), "{ broken");
    await writeFile(
      recordFile(home, "run-qry004-b1"),
      `${JSON.stringify({ schemaVersion: 3, runId: "run-qry004-b1" })}\n`,
    );
    const again = createRunStore({ home, lock: { acquireTimeoutMs: 300 } });
    stores.push(again);
    await again.initialize();
    const q = createRunQueries({ store: again, ensureReady: async () => undefined });
    const get = (runId: string) => q.get({ runContractVersion: 1, runId });
    expect(await get("run-qry004-a1")).toMatchObject({
      status: "corrupt",
      run: null,
      issues: [{ code: "run-corrupt" }],
    });
    expect(await get("run-qry004-b1")).toMatchObject({
      status: "unknown-version",
      issues: [{ code: "run-unknown-version" }],
    });
    expect(await get("run-qry004-z1")).toMatchObject({
      status: "missing",
      issues: [{ code: "run-missing" }],
    });
    expect(await readFile(recordFile(home, "run-qry004-b1"), "utf8")).toContain(
      '"schemaVersion":3',
    );
  });

  test("a store that cannot start reports missing instead of throwing", async () => {
    const store = createRunStore({ home: undefined });
    stores.push(store);
    const q = createRunQueries({
      store,
      ensureReady: () => store.initialize().catch(() => undefined),
    });
    expect(await q.get({ runContractVersion: 1, runId: "run-qry005-a1" })).toMatchObject({
      status: "missing",
    });
    const listed = await q.list({ runContractVersion: 1 });
    expect(listed.runs).toEqual([]);
    expect(listed.health[0]).toMatchObject({ status: "unavailable" });
    expect(RunListOutputSchema.safeParse(listed).success).toBe(true);
  });
});

describe("projection", () => {
  test("a decision kind survives the new projection and older clients can strip it", () => {
    const record = ledger("run-qry010-a1");
    record.decisions = [
      {
        decisionId: "11111111-1111-4111-8111-111111111111",
        category: "D1",
        controlNonceDigest: "a".repeat(64),
        state: "open",
        dedupeKey: "stuck:assignment-t1-r1",
        cancelIntents: null,
        subjectId: "t1",
        summary: "Reviewer stopped",
        createdAt: "2026-11-06T10:00:00.000Z",
        answeredAt: null,
        answer: null,
        resolution: null,
      },
    ];
    const projected = projectDetail(record);
    if (!projected.ok) throw new Error("projection failed");
    const view = projected.view.decisions[0];
    expect(view?.kind).toBe("stuck-judge");
    const oldSchema = RunDecisionViewSchema.omit({ kind: true });
    const oldView = oldSchema.parse(view);
    expect(Object.hasOwn(oldView, "kind")).toBe(false);
    expect(RunDecisionViewSchema.parse({ ...view, kind: "future-kind" }).kind).toBe("future-kind");
    expect(RunDecisionViewSchema.parse(oldView).kind).toBeUndefined();
  });

  test("a pending task names its first unfinished dependency as the reason it waits", () => {
    const record = ledger("run-qry010-a1");
    const dependent = record.tasks.find((task) => task.spec.deps.length > 0);
    expect(dependent).toBeDefined();
    if (!dependent) return;
    const dep = record.tasks.find((task) => task.spec.id === dependent.spec.deps[0]);
    if (!dep) return;
    dep.state = "in_progress";
    dependent.state = "pending";
    const projected = projectDetail(record);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    const row = projected.view.tasks.find((task) => task.taskId === dependent.spec.id);
    expect(row?.blockedBy).toEqual({ kind: "dependency", ref: dep.spec.id });
  });

  test("a dependency cycle is refused instead of drawn", () => {
    const record = ledger("run-qry011-a1");
    const [first, second] = record.tasks;
    if (!first || !second) throw new Error("fixture needs two tasks");
    first.spec.deps = [second.spec.id];
    second.spec.deps = [first.spec.id];
    expect(projectDetail(record)).toMatchObject({
      ok: false,
      issues: [{ code: "run-projection-invalid" }],
    });
  });
});

describe("history", () => {
  const withEvents = (count: number, checkpoint?: number): RunRecord => {
    const record = ledger("run-qry020-a1");
    record.events = Array.from({ length: count }, (_, index) => ({
      seq: index + 1,
      kind: "task-report",
      at: "2026-11-05T00:00:00.000Z",
      payload: { block: { taskId: "t2", nonce: "SECRET-NONCE" }, prompt: "SECRET-PROMPT" },
    }));
    if (checkpoint !== undefined && record.checkpoint) record.checkpoint.throughSeq = checkpoint;
    return record;
  };

  test("the first page is the newest 50, ascending inside, and the cursor walks to older events", () => {
    const record = withEvents(120);
    const first = historyPage(record, undefined);
    expect(first.page.events.map((e) => e.seq)).toEqual(
      Array.from({ length: 50 }, (_, i) => 71 + i),
    );
    expect(first.page.nextCursor).not.toBeNull();
    const second = historyPage(record, first.page.nextCursor ?? undefined);
    expect(second.page.events[0]?.seq).toBe(21);
    expect(second.page.events.at(-1)?.seq).toBe(70);
    const third = historyPage(record, second.page.nextCursor ?? undefined);
    expect(third.page.events.map((e) => e.seq)).toEqual(
      Array.from({ length: 20 }, (_, i) => 1 + i),
    );
    expect(third.page.nextCursor).toBeNull();
  });

  test("event payloads never reach the page, only the kind and a task id", () => {
    const first = historyPage(withEvents(3), undefined);
    const text = JSON.stringify(first);
    expect(text).not.toContain("SECRET");
    expect(first.page.events[0]).toMatchObject({ kind: "task-report", taskId: "t2" });
  });

  test("a cursor from another run, or from before a checkpoint change, expires and restarts at the newest page", () => {
    const record = withEvents(120);
    const cursor = historyPage(record, undefined).page.nextCursor ?? "";
    const other = { ...record, runId: "run-qry021-a1" } as RunRecord;
    const foreign = historyPage(other, cursor);
    expect(foreign.issues).toEqual([expect.objectContaining({ code: "history-cursor-expired" })]);
    expect(foreign.page.events.at(-1)?.seq).toBe(120);

    const compacted = {
      ...record,
      checkpoint: { ...(record.checkpoint ?? ({} as never)), throughSeq: 10 },
    } as RunRecord;
    expect(historyPage(compacted, cursor).issues[0]?.code).toBe("history-cursor-expired");
    expect(historyPage(record, "not-a-cursor").issues[0]?.code).toBe("history-cursor-expired");
  });
});

describe("run.list", () => {
  test("pages newest first, never repeats a run, and lists damaged runs as health instead of hiding them", async () => {
    const { home, store } = await setup();
    for (const [index, id] of ["run-lst001-a1", "run-lst001-b1", "run-lst001-c1"].entries()) {
      await store.create(ledger(id, { updatedAt: `2026-11-05T00:00:0${index}.000Z` }));
    }
    await store.create(ledger("run-lst001-d1"));
    await store.close();
    await writeFile(recordFile(home, "run-lst001-d1"), "garbage");
    const reopened = createRunStore({ home, lock: { acquireTimeoutMs: 300 } });
    stores.push(reopened);
    await reopened.initialize();
    const q = createRunQueries({ store: reopened, ensureReady: async () => undefined });

    const first = await q.list({ runContractVersion: 1, limit: 2 });
    expect(first.runs.map((r) => r.runId)).toEqual(["run-lst001-c1", "run-lst001-b1"]);
    expect(first.nextCursor).not.toBeNull();
    expect(first.health).toEqual([
      expect.objectContaining({ runId: "run-lst001-d1", status: "corrupt" }),
    ]);
    const second = await q.list({
      runContractVersion: 1,
      limit: 2,
      cursor: first.nextCursor ?? "",
    });
    expect(second.runs.map((r) => r.runId)).toEqual(["run-lst001-a1"]);
    expect(second.nextCursor).toBeNull();
    expect(RunListOutputSchema.safeParse(first).success).toBe(true);
  });

  test("names the writing controls the build has, and nothing the page could mistake for more", async () => {
    const { queries } = await setup();
    const out = await queries.list({ runContractVersion: 1 });
    expect(out.capabilities).toEqual({
      runEngine: 1,
      observationOnly: true,
      enabled: false,
      supportedControls: ["replan", "decide", "kick", "pause", "resume", "cancel", "budget"],
    });
    expect(out.runs).toEqual([]);
  });
});

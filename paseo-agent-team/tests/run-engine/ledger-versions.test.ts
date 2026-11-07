import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createAtomicJson, resolveLedgerRoots } from "../../server/ledger/atomic-json";
import { createEngineDriver } from "../../server/run-engine/driver";
import { createIntake } from "../../server/run-engine/intake";
import { createRunObserver, type ObserverHost } from "../../server/run-engine/observer";
import { projectDetail } from "../../server/run-engine/projection";
import { createRunQueries } from "../../server/run-engine/queries";
import { createRunStore, type RunStore, runRecordCodec } from "../../server/run-engine/store";
import {
  applyDispatch,
  buildDispatch,
  type DispatchBuildInput,
} from "../../shared/domain/run-engine/dispatch-builder";
import { type RunRecord, RunRecordSchema } from "../../shared/schemas/run-engine/ledger";
import { PROFILE_HAIKU } from "../fixtures/run-engine/base";
import { readyRun } from "./support/ready-run";

const NOW = "2026-11-07T02:00:00.000Z";
const homes: string[] = [];
const stores: RunStore[] = [];
const repair = {
  version: 1 as const,
  predecessorAssignmentId: "assignment-source",
  rootAssignmentId: "assignment-root",
  ordinal: 1,
};

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

async function home() {
  const directory = await mkdtemp(path.join(tmpdir(), "run-versions-"));
  homes.push(directory);
  return directory;
}

async function open(directory: string) {
  const store = createRunStore({ home: directory, lock: { acquireTimeoutMs: 300 } });
  stores.push(store);
  await store.initialize();
  return store;
}

function file(directory: string, runId: string) {
  return path.join(directory, "agent-team-runs", "v1", "runs", `${runId}.json`);
}

function ready(runId: string, schemaVersion: 1 | 2): RunRecord {
  return { ...readyRun({ runId }), schemaVersion };
}

function dispatch(record: RunRecord): DispatchBuildInput {
  const task = record.tasks.find((entry) => entry.spec.id === "t2");
  if (!task) throw new Error("fixture lost t2");
  return {
    taskId: "t2",
    seatId: "seat-b1",
    profile: PROFILE_HAIKU,
    workspace: { id: "ws-start", branch: "main", baseRef: "1".repeat(40) },
    scopes: task.spec.scopes.map((scope) => ({ ...scope, verified: true })),
    reason: "version compatibility",
    otherResources: { trusted: true, claims: [] },
    ids: {
      assignmentId: "assignment-t2-versions",
      nonce: "70000000-0000-4000-8000-000000000001",
      messageId: "70000000-0000-4000-8000-000000000002",
      intentId: "intent-t2-versions",
      claimId: (index) => `claim-version-${index}`,
    },
    now: NOW,
    payload: { hash: "9".repeat(64), templateVersion: 1 },
  };
}

async function assigned(store: RunStore, runId: string) {
  return store.update(runId, (record, context) => {
    const built = buildDispatch(record, {
      ...dispatch(record),
      otherResources: context.otherResources,
    });
    if (!built.ok) throw new Error(built.reason);
    const applied = applyDispatch(record, built, { now: NOW, newId: () => "unused" });
    if (!applied.ok) throw new Error(applied.code);
    const intent = applied.next.outbox.find((entry) => entry.id === built.event.intent.id);
    if (!intent) throw new Error("dispatch missing");
    Object.assign(intent, { state: "confirmed", confirmedAt: NOW });
    return applied.next;
  });
}

describe("Run v1/v2 version boundary", () => {
  test("v1 initialize, queries, recovery and reopen do not migrate or reserialize bytes", async () => {
    const directory = await home();
    const runId = "run-ver001-a1";
    const first = await open(directory);
    await first.create(ready(runId, 1));
    await first.close();
    const raw = `${JSON.stringify(ready(runId, 1), null, 2)}\r\n`;
    await writeFile(file(directory, runId), raw);
    const store = await open(directory);
    const observer = createRunObserver({ store });
    const host: ObserverHost = {
      replyWindow: async () => ({ complete: false, reason: "dispatch-not-found" }),
    };
    const intake = createIntake({ store, observer, host });
    const driver = createEngineDriver({
      store,
      observer,
      host,
      intake,
      dagIntake: { settleCoordinator: async () => [{ status: "no-pending-plan" as const }] },
      service: { dispatchNext: async () => ({ status: "idle" as const }) },
    });
    const queries = createRunQueries({ store, ensureReady: async () => undefined });
    expect(await queries.get({ runId, runContractVersion: 1 })).toMatchObject({ status: "ready" });
    expect(await driver.recover()).toEqual({ runs: 1 });
    expect(await store.get(runId)).toMatchObject({ status: "ok", record: { schemaVersion: 1 } });
    await store.reconcile();
    await store.close();
    const reopened = await open(directory);
    expect(await reopened.get(runId)).toMatchObject({ status: "ok", revision: 1 });
    expect(await readFile(file(directory, runId), "utf8")).toBe(raw);
  });

  test.each([1, 2] as const)(
    "new intake accepts a v%i report without upgrading it",
    async (schemaVersion) => {
      const store = await open(await home());
      const observer = createRunObserver({ store, clock: { now: () => NOW } });
      const runId = `run-ver00${schemaVersion + 1}-a1`;
      await store.create(ready(runId, schemaVersion));
      const seeded = await assigned(store, runId);
      const assignment = seeded.record.assignments.find(
        (entry) => entry.assignmentId === "assignment-t2-versions",
      );
      if (!assignment) throw new Error("assignment missing");
      const turnId = `turn-version-${schemaVersion}`;
      const block = {
        protocolVersion: 1,
        runId,
        taskId: "t2",
        assignmentId: assignment.assignmentId,
        nonce: assignment.nonce,
        attempt: assignment.attempt,
        status: "blocked",
        reasonCode: "ENVIRONMENT",
        summary: "offline controlled stop",
        evidence: [],
      };
      const host: ObserverHost = {
        replyWindow: async () => ({
          complete: true,
          turnId,
          text: `\`\`\`task-report\n${JSON.stringify(block)}\n\`\`\``,
          bytes: 512,
        }),
      };
      await observer.ingest({ name: "agent.turn_ended", agentId: assignment.agentId, turnId });
      const intake = createIntake({ store, observer, host });
      const results = await intake.settleAgent(assignment.agentId);
      expect(results).toContainEqual(
        expect.objectContaining({ status: "settled", assignmentId: assignment.assignmentId }),
      );
      const read = await store.get(runId);
      expect(read).toMatchObject({ status: "ok", record: { schemaVersion } });
      if (read.status !== "ok") throw new Error("unreadable result");
      expect(read.record.tasks.find((entry) => entry.spec.id === "t2")?.state).toBe("blocked");
    },
  );

  test.each([
    [1, 2],
    [2, 1],
  ] as const)("v%i holder blocks a v%i claim after restart", async (holderVersion, nextVersion) => {
    const directory = await home();
    const holder = "run-ver010-a1";
    const next = "run-ver010-a2";
    const first = await open(directory);
    await first.create(ready(holder, holderVersion));
    await assigned(first, holder);
    await first.create(ready(next, nextVersion));
    await first.close();
    const store = await open(directory);
    const bytes = await readFile(file(directory, next), "utf8");
    await store.update(next, (record, context) => {
      expect(context.otherResources.trusted).toBe(true);
      expect(
        buildDispatch(record, { ...dispatch(record), otherResources: context.otherResources }),
      ).toMatchObject({ ok: false, reason: "lock-conflict" });
      return null;
    });
    expect(await readFile(file(directory, next), "utf8")).toBe(bytes);
  });

  test.each([
    [3, "unknown-version"],
    ["2", "corrupt"],
    [null, "corrupt"],
  ])("version %j is %s, preserved, and blocks a real resource grant", async (version, status) => {
    const directory = await home();
    const first = await open(directory);
    const brokenId = "run-ver020-a1";
    const nextId = "run-ver020-a2";
    await first.create(ready(brokenId, 1));
    await first.close();
    const raw = `${JSON.stringify({ ...ready(brokenId, 1), schemaVersion: version })}\n`;
    await writeFile(file(directory, brokenId), raw);
    const store = await open(directory);
    expect(await store.get(brokenId)).toMatchObject({ status });
    await expect(store.update(brokenId, (record) => record)).rejects.toMatchObject({
      code: "unrecoverable-run",
    });
    await store.create(ready(nextId, 2));
    await store.update(nextId, (record, context) => {
      expect(context.otherResources.trusted).toBe(false);
      expect(
        buildDispatch(record, { ...dispatch(record), otherResources: context.otherResources }),
      ).toMatchObject({ ok: false, reason: "other-runs-untrusted" });
      return null;
    });
    expect(await readFile(file(directory, brokenId), "utf8")).toBe(raw);
  });

  test("v2 metadata is validated without changing the meaning of v1 unknown fields", () => {
    const v2 = ready("run-ver030-a1", 2);
    const assignment = v2.assignments[0];
    if (!assignment) throw new Error("fixture has no assignment");
    assignment.evidenceRepair = repair;
    expect(RunRecordSchema.parse(v2).assignments[0]?.evidenceRepair).toEqual(repair);
    // This name was an unknown passthrough field in v1. Reading it does not opt into v2 behavior.
    expect(
      RunRecordSchema.parse({ ...v2, schemaVersion: 1 }).assignments[0]?.evidenceRepair,
    ).toEqual(repair);
    for (const invalid of [
      null,
      { ...repair, version: 2 },
      { ...repair, predecessorAssignmentId: "" },
      { ...repair, rootAssignmentId: 1 },
      { ...repair, rootAssignmentId: "x".repeat(129) },
      { ...repair, ordinal: 0 },
      { ...repair, ordinal: 1.5 },
      { ...repair, ordinal: 11 },
    ]) {
      const record = structuredClone(v2);
      Object.assign(record.assignments[0] ?? {}, { evidenceRepair: invalid });
      expect(RunRecordSchema.safeParse(record).success, JSON.stringify(invalid)).toBe(false);
    }
  });

  test("v1 retains an unrelated unknown field with the same name through reads and writes", async () => {
    const directory = await home();
    const runId = "run-ver031-a1";
    const first = await open(directory);
    await first.create(ready(runId, 1));
    await first.close();
    const rawRecord = ready(runId, 1);
    const legacyValue = { unrelated: "legacy-data", version: "not-a-v2-marker" };
    Object.assign(rawRecord.assignments[0] ?? {}, { evidenceRepair: legacyValue });
    const raw = `${JSON.stringify(rawRecord)}\n`;
    await writeFile(file(directory, runId), raw);
    const store = await open(directory);
    const initial = await store.get(runId);
    expect(initial).toMatchObject({ status: "ok", record: { schemaVersion: 1 } });
    expect(await readFile(file(directory, runId), "utf8")).toBe(raw);
    await store.update(runId, (record) => ({ ...record, updatedAt: NOW }));
    const saved = await store.get(runId);
    expect(saved).toMatchObject({ status: "ok", record: { schemaVersion: 1 } });
    if (saved.status !== "ok") throw new Error("v1 record no longer readable");
    expect(saved.record.assignments[0]?.evidenceRepair).toEqual(legacyValue);
    expect((await store.resourcesExcluding("run-any-a1")).trusted).toBe(true);
  });

  test("v2 invalid repair links cannot be stored, and their fields stay out of the projection", async () => {
    const store = await open(await home());
    const record = ready("run-ver032-a1", 2);
    Object.assign(record.assignments[0] ?? {}, { evidenceRepair: repair });
    // The shape alone is valid; the referenced assignments do not exist, so I7 refuses storage.
    expect(RunRecordSchema.safeParse(record).success).toBe(true);
    await expect(store.create(record)).rejects.toMatchObject({ code: "invalid-record" });
    const projection = projectDetail(record);
    expect(projection.ok).toBe(true);
    expect(JSON.stringify(projection)).not.toContain("evidenceRepair");
  });

  test("v2 writes still enforce the hard byte limit before creating a record file", async () => {
    const directory = await home();
    const store = createRunStore({
      home: directory,
      limits: { softBytes: 256, hardBytes: 512 },
    });
    stores.push(store);
    await store.initialize();
    const record = ready("run-ver033-a1", 2);
    await expect(store.create(record)).rejects.toMatchObject({ code: "too-large" });
    await expect(readFile(file(directory, record.runId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("legacy single-version codec rejects v2 reads and writes without touching bytes", async () => {
    const directory = await home();
    const runId = "run-ver040-a1";
    const store = await open(directory);
    const created = await store.create(ready(runId, 2));
    await store.close();
    const raw = await readFile(file(directory, runId), "utf8");
    // The c27fd80 codec's public shape: no multi-version opt-in.
    const { supportedSchemaVersions: _supported, ...codec } = runRecordCodec;
    const roots = await resolveLedgerRoots(directory);
    const legacy = createAtomicJson({
      containmentRoot: roots.root,
      issuesDir: roots.issues,
      file: file(directory, runId),
      codec: { ...codec, schemaVersion: 1 },
    });
    expect(await legacy.read()).toMatchObject({ status: "unknown-version", schemaVersion: 2 });
    await expect(
      legacy.commit(
        { ...ready(runId, 1), revision: 2, previousDigest: created.digest },
        { revision: 1, digest: created.digest },
      ),
    ).rejects.toMatchObject({ code: "unknown-version" });
    expect(await readFile(file(directory, runId), "utf8")).toBe(raw);
  });

  test("dual-version codec preserves headers, rejects implicit migration and still enforces CAS", async () => {
    const directory = await home();
    const runId = "run-ver041-a1";
    const store = await open(directory);
    const created = await store.create(ready(runId, 1));
    await store.close();
    const roots = await resolveLedgerRoots(directory);
    const atomic = createAtomicJson({
      containmentRoot: roots.root,
      issuesDir: roots.issues,
      file: file(directory, runId),
      codec: runRecordCodec,
    });
    const next = { ...ready(runId, 1), revision: 2, previousDigest: created.digest };
    await expect(
      atomic.commit({ ...next, schemaVersion: 2 }, { revision: 1, digest: created.digest }),
    ).rejects.toMatchObject({ code: "header-invalid" });
    const written = await atomic.commit(next, { revision: 1, digest: created.digest });
    expect(JSON.parse(await readFile(file(directory, runId), "utf8")).schemaVersion).toBe(1);
    await expect(
      atomic.commit(next, { revision: 1, digest: created.digest }),
    ).rejects.toMatchObject({ code: "cas-mismatch" });
    const raw = await readFile(file(directory, runId), "utf8");
    const normalizing = createAtomicJson({
      containmentRoot: roots.root,
      issuesDir: roots.issues,
      file: file(directory, runId),
      codec: {
        ...runRecordCodec,
        parse: (value) => ({ ...RunRecordSchema.parse(value), schemaVersion: 2 as const }),
      },
    });
    expect(await normalizing.read()).toMatchObject({ status: "corrupt", reason: "schema" });
    expect(await readFile(file(directory, runId), "utf8")).toBe(raw);
    expect((await atomic.read()).status).toBe("ok");
    expect(written.revision).toBe(2);
  });
});

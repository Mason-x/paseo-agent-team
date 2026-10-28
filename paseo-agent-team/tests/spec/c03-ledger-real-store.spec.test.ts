// C03 real-ledger specification (L4): mkdtemp + the real createDesignJobStore, no mocking of the
// filesystem. Fixtures are the frozen baseline (schemaVersion 1) records from p1-compat; the
// expectations come from .notes/01-spec-p1.md (AC-0c.5, 0c.9–0c.14, 0c.16, 0d.15, 0d.20, X7–X11)
// and .notes/83-c03-rereview.md (D1–D12), not from the implementation's current shape.
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { projectJobForContract, projectResultForContract } from "../../server/designer/compat";
import type { DesignSettingsReaders } from "../../server/designer/context";
import { type DesignDataRoot, resolveDesignDataRoot } from "../../server/designer/data-root";
import { type DesignDiscoveryPort, reconcileDesignJob } from "../../server/designer/recovery";
import {
  createDesignService,
  type DesignService,
  type DesignServiceDeps,
} from "../../server/designer/service";
import {
  createDesignJobStore,
  DESIGN_RECORD_VERSION,
  type DesignJobStore,
  type DesignStoreFs,
  LEGACY_RECORD_RULES,
  type StoredDesignJob,
} from "../../server/designer/store";
import type { DesignTimelinePort } from "../../server/designer/timeline";
import { canonicalDesignContent } from "../../shared/domain/design-content";
import type { DesignPlanningPort } from "../../shared/domain/design-planning";
import type { DesignJob, DesignResult, RoleGapReport } from "../../shared/schemas/design";
import type { TeamMode } from "../../shared/schemas/team-mode";
import {
  DESIGN_V1_RECORD_DESIGNING,
  DESIGN_V1_RECORD_FAILED,
  DESIGN_V1_RECORD_READY,
  DESIGN_V1_RECORDS,
} from "../fixtures/p1-compat/design-ledger-v1";

const NOW = "2026-10-27T00:00:00.000Z";
const C02_IDS = {
  clientId: "00000000-0000-4000-8000-000000000101",
  leaseId: "00000000-0000-4000-8000-000000000102",
  resultId: "a".repeat(64),
};

const homes: string[] = [];
let sequence = 0;

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function uuid(): string {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function hashFile(file: string): Promise<string> {
  return readFile(file, "utf8").then(hash);
}

async function newHome(): Promise<{ home: string; root: DesignDataRoot }> {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-c03-spec-"));
  homes.push(home);
  const root = await resolveDesignDataRoot(home);
  await mkdir(root.jobs, { recursive: true });
  return { home, root };
}

async function openStore(home: string, fs?: DesignStoreFs): Promise<DesignJobStore> {
  const store = createDesignJobStore({
    home,
    ...(fs === undefined ? {} : { fs }),
    clock: { now: () => NOW },
    ids: { next: uuid },
  });
  await store.initialize();
  return store;
}

type RecordLike = { job: { jobId: string } };

function fileOf(root: DesignDataRoot, record: RecordLike): string {
  return path.join(root.jobs, `${record.job.jobId}.json`);
}

async function writeRecordFile(
  root: DesignDataRoot,
  record: RecordLike,
  name?: string,
): Promise<string> {
  const target = path.join(root.jobs, name ?? `${record.job.jobId}.json`);
  await writeFile(target, `${JSON.stringify(record)}\n`, "utf8");
  return target;
}

async function seed(root: DesignDataRoot, ...records: readonly RecordLike[]): Promise<void> {
  for (const record of records) await writeRecordFile(root, record);
}

async function snapshot(files: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const file of files) out[file] = await hashFile(file);
  return out;
}

type StoredOverrides = Partial<Omit<StoredDesignJob, "job">> & {
  job?: Partial<StoredDesignJob["job"]>;
};

function v2Record(fixture: unknown, overrides: StoredOverrides = {}): StoredDesignJob {
  // Fixtures are complete v1 records; this cast is the test boundary, and the v2 fields below are
  // what the reader must synthesize or what the writer must store.
  const base = structuredClone(fixture) as StoredDesignJob;
  return {
    ...base,
    schemaVersion: DESIGN_RECORD_VERSION,
    requestHashVersion: 2,
    outputContractVersion: 2,
    existingRolesOnly: true,
    roleGap: null,
    ...overrides,
    job: { ...base.job, ...(overrides.job ?? {}) },
  };
}

const gapReport: RoleGapReport = {
  responsibility: "数据库迁移评审",
  reason: "现有 Role 不承担迁移评审。",
  use: "member",
  profiles: [],
  profileGapReason: "host 没有合适 Profile。",
  suggestedRole: {
    id: "qa-migration",
    name: "【质量】迁移评审",
    responsibilities: ["评审迁移脚本"],
    executionPolicy: { tier: "decision", taskKind: "general" },
  },
};

type ServiceOverrides = Partial<DesignServiceDeps>;

function serviceFor(store: DesignJobStore, overrides: ServiceOverrides = {}): DesignService {
  return createDesignService({
    store,
    readers: {} as DesignSettingsReaders,
    getAdapter: () => null,
    planner: {} as DesignPlanningPort,
    clock: { now: () => NOW },
    ids: { next: uuid },
    hasher: hash,
    capabilities: { onDemand: false, expansion: false, collaboration: false },
    log: () => {},
    ...overrides,
  });
}

function v1RequestBase(record: { request: string; mode: string }) {
  return {
    request: record.request,
    mode: record.mode,
    workspaceId: null,
    profileId: null,
    useDefaultProfileHints: false,
  };
}

function issueCodes(result: { ok: boolean; issues?: readonly { code: string }[] }): string[] {
  return "issues" in result && result.issues ? result.issues.map((issue) => issue.code) : [];
}

describe("AC-0c.12 / AC-0c.16① / AC-0d.15: v1 records read in memory, files untouched", () => {
  test("all five baseline records load with legacy rules and byte-identical files", async () => {
    const { home, root } = await newHome();
    await seed(root, ...DESIGN_V1_RECORDS);
    const files = DESIGN_V1_RECORDS.map((record) => fileOf(root, record));
    const beforeSha = await snapshot(files);
    const beforeStat = await Promise.all(files.map((file) => stat(file)));

    const store = await openStore(home);
    const listed = await store.list();
    expect(listed).toHaveLength(DESIGN_V1_RECORDS.length);
    for (const fixture of DESIGN_V1_RECORDS) {
      const record = await store.get(fixture.job.jobId);
      expect(record).not.toBeNull();
      expect(record).toMatchObject({
        schemaVersion: 1,
        ...LEGACY_RECORD_RULES,
        requestHash: fixture.requestHash,
        selectionIntent: fixture.selectionIntent,
      });
      // The old ≤3 rule is "absent", never an explicit false on the Job DTO.
      expect(record?.job.existingRolesOnly).toBeUndefined();
      expect(record?.job.outputContractVersion).toBeUndefined();
      expect(record?.job.roleGap).toBeUndefined();
      expect(await store.findRequest(fixture.job.clientRequestId)).toMatchObject({
        requestHashVersion: 1,
        existingRolesOnly: false,
      });
      expect(JSON.parse(await readFile(fileOf(root, fixture), "utf8"))).toEqual(fixture);
    }
    expect(await store.problems()).toEqual([]);

    // A restart is a pure read as well.
    await store.dispose();
    const reopened = await openStore(home);
    await reopened.list();
    await reopened.dispose();

    expect(await snapshot(files)).toEqual(beforeSha);
    const afterStat = await Promise.all(files.map((file) => stat(file)));
    expect(afterStat.map((entry) => entry.mtimeMs)).toEqual(
      beforeStat.map((entry) => entry.mtimeMs),
    );
  });

  test("D10: read-only recovery of terminal and matching in-flight v1 records writes nothing", async () => {
    const { home, root } = await newHome();
    await seed(root, DESIGN_V1_RECORD_FAILED, DESIGN_V1_RECORD_DESIGNING);
    const failedFile = fileOf(root, DESIGN_V1_RECORD_FAILED);
    const designingFile = fileOf(root, DESIGN_V1_RECORD_DESIGNING);
    const before = await snapshot([failedFile, designingFile]);

    const store = await openStore(home);
    const terminal = await reconcileDesignJob(
      { discovery: impossibleDiscovery(), timeline: impossibleTimeline() },
      store,
      DESIGN_V1_RECORD_FAILED.job.jobId,
    );
    expect(terminal.observation).toBe("terminal");

    const labels = DESIGN_V1_RECORD_DESIGNING.creation.request.labels;
    const discovery: DesignDiscoveryPort = {
      list: async () => ({ agents: [], nextCursor: null }),
      refresh: async (agentId) => ({
        agentId,
        labels,
        archived: false,
        status: "running",
        pendingPermissions: [],
        attentionReason: null,
      }),
    };
    const inFlight = await reconcileDesignJob(
      { discovery, timeline: runningTimeline() },
      store,
      DESIGN_V1_RECORD_DESIGNING.job.jobId,
    );
    // Matched agent + pending receipt: a fact, not a state transition.
    expect(inFlight.observation).toBe("receipt-pending");
    await store.dispose();

    expect(await snapshot([failedFile, designingFile])).toEqual(before);
  });
});

describe("AC-0c.12 / AC-0c.16② / D1–D3: one legal CAS writes v2", () => {
  test("v1 → v2 keeps identity and unknown extension keys at every record-owned layer", async () => {
    const { home, root } = await newHome();
    const readyBase = structuredClone(DESIGN_V1_RECORD_READY);
    const ready = {
      ...readyBase,
      futureRoot: { keep: "root" },
      job: { ...readyBase.job, futureJob: { keep: "job" } },
      result: { ...readyBase.result, futureResult: { keep: "result" } },
      attempts: [{ ...readyBase.attempts[0], futureAttempt: { keep: "attempt" } }],
    };
    const designingBase = structuredClone(DESIGN_V1_RECORD_DESIGNING);
    const designing = {
      ...designingBase,
      creation: { ...designingBase.creation, futureCreation: { keep: "creation" } },
    };
    await seed(root, ready, designing);

    const store = await openStore(home);
    for (const [fixture, mutation] of [
      [ready, { agentStatus: "idle" }],
      [designing, { agentStatus: "running" }],
    ] as const) {
      const current = await store.get(fixture.job.jobId);
      if (!current) throw new Error("fixture missing");
      await store.update(current.job.jobId, current.job.stateRevision, {
        ...current,
        job: { ...current.job, ...mutation, stateRevision: uuid() },
      });
    }

    const readyOnDisk = JSON.parse(await readFile(fileOf(root, ready), "utf8"));
    expect(readyOnDisk).toMatchObject({
      schemaVersion: 2,
      requestHashVersion: 1,
      outputContractVersion: 1,
      existingRolesOnly: false,
      roleGap: null,
      requestHash: ready.requestHash,
      selectionIntent: ready.selectionIntent,
    });
    expect(readyOnDisk.job).not.toHaveProperty("existingRolesOnly");
    expect(readyOnDisk.job).not.toHaveProperty("outputContractVersion");
    expect(readyOnDisk.job).not.toHaveProperty("roleGap");
    expect(readyOnDisk.futureRoot).toEqual({ keep: "root" });
    expect(readyOnDisk.job.futureJob).toEqual({ keep: "job" });
    expect(readyOnDisk.result.futureResult).toEqual({ keep: "result" });
    expect(readyOnDisk.attempts[0]).toMatchObject({
      ...ready.attempts[0],
      futureAttempt: { keep: "attempt" },
    });
    expect(readyOnDisk.result.resultId).toBe(ready.result.resultId);
    expect(readyOnDisk.attempts[0].nonce).toBe(ready.attempts[0].nonce);

    const designingOnDisk = JSON.parse(await readFile(fileOf(root, designing), "utf8"));
    expect(designingOnDisk.creation.futureCreation).toEqual({ keep: "creation" });
    expect(designingOnDisk.creation.request.labels).toEqual(designing.creation.request.labels);

    await store.dispose();
    const reopened = await openStore(home);
    expect(await reopened.get(ready.job.jobId)).toMatchObject({
      schemaVersion: 2,
      ...LEGACY_RECORD_RULES,
    });
    await reopened.dispose();
  });

  test("oversized unknown extensions are rejected by the record cap, old bytes kept", async () => {
    const { home, root } = await newHome();
    const record = {
      ...structuredClone(DESIGN_V1_RECORD_READY),
      futureHuge: "x".repeat(600 * 1024),
    };
    const file = await writeRecordFile(root, record);
    const before = await hashFile(file);

    const store = await openStore(home);
    const current = await store.get(record.job.jobId);
    if (!current) throw new Error("fixture missing");
    await expect(
      store.update(current.job.jobId, current.job.stateRevision, {
        ...current,
        job: { ...current.job, stateRevision: uuid() },
      }),
    ).rejects.toMatchObject({ issue: "too-large" });
    await store.dispose();

    expect(await hashFile(file)).toBe(before);
  });

  test("D3: a v2 job copy that disagrees with the root is corrupt, not silently fixed", async () => {
    const { home, root } = await newHome();
    const store = await openStore(home);
    const record = v2Record(DESIGN_V1_RECORD_READY, {
      job: { state: "ready" },
    });
    await store.create(record);
    const file = fileOf(root, record);
    const written = JSON.parse(await readFile(file, "utf8"));

    written.job.existingRolesOnly = false;
    await writeFile(file, `${JSON.stringify(written)}\n`, "utf8");
    expect(await store.problems()).toEqual([{ name: path.basename(file), reason: "corrupt" }]);
    await expect(store.get(record.job.jobId)).rejects.toMatchObject({ issue: "corrupt" });
    await store.dispose();
  });
});

describe("AC-0c.16③/⑤: unknown versions and the baseline reader", () => {
  test("schemaVersion 3 is isolated, blocks only its request id, and never changes bytes", async () => {
    const { home, root } = await newHome();
    const good = await writeRecordFile(root, DESIGN_V1_RECORD_READY);
    const goodBefore = await hashFile(good);
    const future = { ...structuredClone(DESIGN_V1_RECORD_FAILED), schemaVersion: 3 };
    const futureFile = await writeRecordFile(root, future);
    const before = await hashFile(futureFile);

    const store = await openStore(home);
    expect((await store.list()).map((record) => record.job.jobId)).toEqual([
      DESIGN_V1_RECORD_READY.job.jobId,
    ]);
    expect(await store.problems()).toEqual([
      { name: `${DESIGN_V1_RECORD_FAILED.job.jobId}.json`, reason: "unknown-version" },
    ]);
    await expect(store.get(future.job.jobId)).rejects.toMatchObject({ issue: "unknown-version" });
    await expect(
      store.findRequest(DESIGN_V1_RECORD_FAILED.job.clientRequestId),
    ).rejects.toMatchObject({ issue: "unknown-version" });
    expect(await store.findRequest(uuid())).toBeNull();
    await store.dispose();

    expect(await hashFile(futureFile)).toBe(before);
    expect(await hashFile(good)).toBe(goodBefore);
  });

  test("AC-0c.16⑤ / D9: a baseline reader reports unknown-version and leaves v2 bytes alone", async () => {
    const { home, root } = await newHome();
    const store = await openStore(home);
    const record = v2Record(DESIGN_V1_RECORD_READY);
    await store.create(record);
    await store.dispose();
    const file = fileOf(root, record);
    const raw = await readFile(file, "utf8");
    const before = hash(raw);
    // Literal baseline decisions: only schemaVersion 1, name = jobId, identity at job.*.
    const parsed = JSON.parse(raw) as {
      schemaVersion: number;
      job: { jobId: string; clientRequestId: string };
    };
    expect(parsed.schemaVersion).not.toBe(1);
    expect(path.basename(file, ".json")).toBe(parsed.job.jobId);
    expect(parsed.job.clientRequestId).toBe(record.job.clientRequestId);
    expect(hash(await readFile(file, "utf8"))).toBe(before);
  });
});

describe("AC-0c.16④: crash points leave the old or the new valid record", () => {
  test.each(["after-tmp", "before-rename", "after-rename"] as const)("%s", async (point) => {
    const { home, root } = await newHome();
    await seed(root, DESIGN_V1_RECORD_DESIGNING);
    const armed = { value: false };
    const store = await openStore(home, crashFs(point, armed));
    const current = await store.get(DESIGN_V1_RECORD_DESIGNING.job.jobId);
    if (!current) throw new Error("fixture missing");
    armed.value = true;
    await expect(
      store.update(current.job.jobId, current.job.stateRevision, {
        ...current,
        job: { ...current.job, stateRevision: uuid() },
      }),
    ).rejects.toBeTruthy();
    await store.dispose();
    armed.value = false;

    const reopened = await openStore(home);
    const records = await reopened.list();
    expect(records).toHaveLength(1);
    const record = records[0];
    if (!record) throw new Error("record missing");
    expect([1, 2]).toContain(record.schemaVersion);
    expect(record.job.jobId).toBe(DESIGN_V1_RECORD_DESIGNING.job.jobId);
    expect(record.requestHash).toBe(DESIGN_V1_RECORD_DESIGNING.requestHash);
    if (record.schemaVersion === 2) {
      expect(record).toMatchObject(LEGACY_RECORD_RULES);
    }
    await reopened.dispose();
  });
});

describe("AC-0c.12 / 71-R1: service start and the design mode gate", () => {
  test("economy-all with contract 2 lands as schemaVersion 2", async () => {
    const { home, root } = await newHome();
    const store = await openStore(home);
    const service = serviceFor(store);
    const started = await service.start({
      clientRequestId: uuid(),
      request: "经济任务",
      mode: "economy-all",
      contractVersion: 2,
    });
    expect(started.ok).toBe(true);
    const jobId = started.ok ? started.job.jobId : "";
    const onDisk = JSON.parse(await readFile(path.join(root.jobs, `${jobId}.json`), "utf8"));
    expect(onDisk).toMatchObject({
      schemaVersion: 2,
      requestHashVersion: 2,
      outputContractVersion: 2,
      existingRolesOnly: true,
      roleGap: null,
      mode: "economy-all",
    });
    expect(onDisk.job).toMatchObject({
      existingRolesOnly: true,
      outputContractVersion: 2,
      roleGap: null,
    });
    await service.dispose();
  });

  test("legacy contract 2 gate rejects economy-all and an unknown mode with zero writes", async () => {
    const { home, root } = await newHome();
    const store = await openStore(home);
    let adapterCalls = 0;
    const service = serviceFor(store, {
      getAdapter: () => {
        adapterCalls += 1;
        return null;
      },
    });
    for (const mode of ["economy-all", "future-mode"]) {
      const rejected = await service.start({
        clientRequestId: uuid(),
        request: "经济任务",
        mode: mode as TeamMode,
      });
      expect(rejected.ok).toBe(false);
      expect(issueCodes(rejected)).toEqual(["DESIGN_MODE_UNAVAILABLE"]);
      if (!rejected.ok) expect(rejected.issues[0]?.action).toBe("refresh");
    }
    expect(adapterCalls).toBe(0);
    expect((await readdir(root.jobs)).filter((name) => name.endsWith(".json"))).toEqual([]);
    await service.dispose();
  });

  test("AC-0c.10 / X8: a v1 request id uses the narrow v1 hash, explicit true conflicts", async () => {
    const { home, root } = await newHome();
    const fixture = structuredClone(DESIGN_V1_RECORD_DESIGNING);
    const record = {
      ...fixture,
      requestHash: hash(canonicalDesignContent(v1RequestBase(fixture))),
    };
    const file = await writeRecordFile(root, record);
    const before = await hashFile(file);
    const store = await openStore(home);
    const service = serviceFor(store);
    // The fixture stores the known legacy value; narrow once at this boundary.
    const mode = record.mode as TeamMode;
    const input = {
      clientRequestId: record.job.clientRequestId,
      request: record.request,
      mode,
    };

    const omitted = await service.start(input);
    expect(omitted.ok && omitted.job.jobId).toBe(record.job.jobId);
    const explicitFalse = await service.start({ ...input, existingRolesOnly: false });
    expect(explicitFalse.ok && explicitFalse.job.jobId).toBe(record.job.jobId);
    const explicitTrue = await service.start({ ...input, existingRolesOnly: true });
    expect(explicitTrue.ok).toBe(false);
    expect(issueCodes(explicitTrue)).toEqual(["DESIGN_REQUEST_CONFLICT"]);

    await service.dispose();
    expect(await hashFile(file)).toBe(before);
    expect((await readdir(root.jobs)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });
});

describe("AC-0c.5 / 0c.9 / 0c.16 / 0c.17 / D8: gap terminal records", () => {
  test("a v2 gap record reads back and prepareSave/compensate/continue refuse it", async () => {
    const { home, root } = await newHome();
    const store = await openStore(home);
    const base = v2Record(DESIGN_V1_RECORD_READY, {
      result: null,
      proposal: null,
      roleGap: [gapReport],
      job: {
        state: "failed",
        resultId: null,
        roleGap: [gapReport],
        finishedAt: NOW,
      },
    });
    await store.create(base);
    const file = fileOf(root, base);
    const before = await hashFile(file);
    const read = await store.get(base.job.jobId);
    expect(read).toMatchObject({
      roleGap: [gapReport],
      result: null,
      job: { state: "failed", roleGap: [gapReport] },
    });

    const service = serviceFor(store);
    for (const intent of ["save", "compensate"] as const) {
      const reply = await service.prepareSave({
        contractVersion: 2,
        jobId: base.job.jobId,
        resultId: C02_IDS.resultId,
        clientId: C02_IDS.clientId,
        intent,
      });
      expect(reply.ok).toBe(false);
      if (reply.ok) throw new Error("gap record must not be savable");
      expect(reply.issues[0]).toMatchObject({
        code: "DESIGN_STATE_CHANGED",
        action: "refresh",
        params: { reason: "role-gap" },
      });
    }
    const continued = await service.continue({
      contractVersion: 2,
      jobId: base.job.jobId,
      expectedRevision: base.job.stateRevision,
      action: "repair",
    });
    expect(continued.ok).toBe(false);
    if (continued.ok) throw new Error("gap record must not continue");
    expect(continued.issues[0]).toMatchObject({
      code: "DESIGN_STATE_CHANGED",
      params: { reason: "role-gap" },
    });
    await service.dispose();
    expect(await hashFile(file)).toBe(before);
  });

  test("D8: a plain failed v2 job still gets the old stale-result answer", async () => {
    const { home } = await newHome();
    const store = await openStore(home);
    const record = v2Record(DESIGN_V1_RECORD_FAILED, {
      result: null,
      roleGap: null,
      job: { state: "failed", resultId: null, roleGap: null },
    });
    await store.create(record);
    const service = serviceFor(store);
    const reply = await service.prepareSave({
      contractVersion: 2,
      jobId: record.job.jobId,
      resultId: C02_IDS.resultId,
      clientId: C02_IDS.clientId,
      intent: "save",
    });
    expect(reply.ok).toBe(false);
    expect(issueCodes(reply)).toEqual(["DESIGN_RESULT_STALE"]);
    await service.dispose();
  });
});

describe("AC-0c.9 / AC-0d.15: record rule read back across v1, v2 and gap", () => {
  test("the root rule survives a reopen; the v1 default is never written into the job", async () => {
    const { home } = await newHome();
    const store = await openStore(home);
    const record = v2Record(DESIGN_V1_RECORD_READY, {
      existingRolesOnly: false,
      job: { state: "ready" },
    });
    await store.create(record);
    const read = await store.get(record.job.jobId);
    expect(read).toMatchObject({
      existingRolesOnly: false,
      requestHashVersion: 2,
      outputContractVersion: 2,
      job: { existingRolesOnly: false, outputContractVersion: 2 },
    });
    await store.dispose();
    const reopened = await openStore(home);
    expect((await reopened.get(record.job.jobId))?.existingRolesOnly).toBe(false);
    await reopened.dispose();
  });
});

describe("AC-0c.13 / AC-0d.20: legacy projection hides a new-mode job", () => {
  test("contract 1 hides economy-all from the list but contract 2 shows it", async () => {
    const { home } = await newHome();
    const store = await openStore(home);
    const record = v2Record(DESIGN_V1_RECORD_FAILED, {
      mode: "economy-all",
      job: { state: "failed", mode: "economy-all", roleGap: null },
    });
    await store.create(record);
    const service = serviceFor(store);

    const legacy = await service.status({});
    expect(legacy.ok).toBe(true);
    if (legacy.ok) {
      expect(legacy.jobs).toEqual([]);
      expect(legacy.truncated).toBe(true);
      expect(legacy.discoveryIssues[0]).toMatchObject({
        code: "DESIGN_MODE_UNAVAILABLE",
        action: "refresh",
        params: { reason: "hidden-by-contract" },
      });
    }
    const current = await service.status({ contractVersion: 2 });
    expect(current.ok && current.jobs.map((job) => job.jobId)).toEqual([record.job.jobId]);
    const byId = await service.status({ contractVersion: 1, jobId: record.job.jobId });
    expect(byId.ok).toBe(false);
    expect(issueCodes(byId)).toEqual(["DESIGN_MODE_UNAVAILABLE"]);
    if (!byId.ok) expect(byId.job).toBeNull();
    await service.dispose();
  });

  test("D2: projection strips record-owned unknown keys from the DTO", async () => {
    const job = structuredClone(DESIGN_V1_RECORD_READY.job) as DesignJob & {
      futureJob?: unknown;
    };
    job.futureJob = { keep: true };
    const projected = projectJobForContract(job, 2) as DesignJob & { futureJob?: unknown };
    expect(projected.futureJob).toBeUndefined();

    const fixtureResult = structuredClone(DESIGN_V1_RECORD_READY.result) as DesignResult;
    const result = { ...fixtureResult, futureResult: { keep: true } };
    // Named cast at the compat boundary: the projector returns the DTO type, which has no room
    // for a newer writer's key; the assertion proves the strip.
    const projectedResult = projectResultForContract(result) as unknown as Record<string, unknown>;
    expect(projectedResult.futureResult).toBeUndefined();
  });
});

test.todo(
  "AC-0c.5 / AC-0c.17: gap economy eligibility (checkGapEconomyEligibility) and correction rounds — C03 second segment + C02 wiring",
);
test.todo(
  "AC-0c.11 / AC-0c.14: end-to-end restart/compensation replays the record rule (prompt/validation contexts) — C03 second segment",
);
test.todo(
  "AC-0c.13 / AC-0d.20: baseline DTO snapshot matrix and a real stale-page reload — B02/I01 wiring + DEV",
);

function impossibleDiscovery(): DesignDiscoveryPort {
  return {
    list: async () => {
      throw new Error("terminal recovery must not discover");
    },
    refresh: async () => {
      throw new Error("terminal recovery must not refresh");
    },
  };
}

function impossibleTimeline(): DesignTimelinePort {
  return {
    refresh: async () => {
      throw new Error("this recovery path must not read the timeline");
    },
    refetch: async () => {
      throw new Error("this recovery path must not read the timeline");
    },
  };
}

/** The agent is still running, so attempt-text extraction stops before any page refetch. */
function runningTimeline(): DesignTimelinePort {
  return {
    refresh: async () => ({
      status: "running",
      activeTurn: true,
      pendingPermissionCount: 0,
      lastError: null,
    }),
    refetch: async () => {
      throw new Error("a running turn must not be paginated");
    },
  };
}

type CrashPoint = "after-tmp" | "before-rename" | "after-rename";

/** Real fs operations plus one injected crash point; the directory and bytes stay real. */
function crashFs(point: CrashPoint, armed: { value: boolean }): DesignStoreFs {
  const write = async (target: string, content: string): Promise<void> => {
    const handle = await open(target, "w");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  const exclusive = async (target: string, content: string): Promise<void> => {
    const handle = await open(target, "wx");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  const real: DesignStoreFs = {
    mkdir: async (target) => {
      await mkdir(target, { recursive: true });
    },
    readFile: async (target) => readFile(target, "utf8"),
    writeFile: write,
    rename: async (from, to) => {
      await rename(from, to);
    },
    rm: async (target) => {
      await rm(target, { force: true });
    },
    readdir: async (target) => readdir(target),
    openExclusive: exclusive,
  };
  return {
    ...real,
    writeFile: async (target, content) => {
      await real.writeFile(target, content);
      if (armed.value && point === "after-tmp") throw new Error("crash after tmp write");
    },
    rename: async (from, to) => {
      if (armed.value && point === "before-rename") throw new Error("crash before rename");
      await real.rename(from, to);
      if (armed.value && point === "after-rename") throw new Error("crash after rename");
    },
  };
}

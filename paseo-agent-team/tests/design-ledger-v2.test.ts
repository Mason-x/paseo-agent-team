import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveDesignDataRoot } from "../server/designer/data-root";
import {
  createDesignJobStore,
  DESIGN_RECORD_VERSION,
  LEGACY_RECORD_RULES,
  type StoredDesignJob,
} from "../server/designer/store";
import type { RoleGapReport } from "../shared/schemas/design";
import { DESIGN_HASH, designJob, designResult } from "./design-fixtures";
import {
  DESIGN_V1_RECORD_DESIGNING,
  DESIGN_V1_RECORD_FAILED,
  DESIGN_V1_RECORD_READY,
  DESIGN_V1_RECORD_STARTING,
  DESIGN_V1_RECORD_VALIDATING,
  DESIGN_V1_RECORDS,
} from "./fixtures/p1-compat/design-ledger-v1";

const homes: string[] = [];
const NOW = "2026-10-27T00:00:00.000Z";
let sequence = 0;

afterEach(async () => {
  await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function openStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "paseo-design-v2-"));
  homes.push(dir);
  const store = createDesignJobStore({
    home: dir,
    clock: { now: () => NOW },
    ids: { next: () => `id-${++sequence}` },
  });
  await store.initialize();
  const root = await resolveDesignDataRoot(dir);
  return { dir, store, jobs: root.jobs };
}

type JsonRecord = { job: Record<string, unknown>; [key: string]: unknown };
type Fixture = (typeof DESIGN_V1_RECORDS)[number];

function fileOf(jobs: string, record: Fixture) {
  return path.join(jobs, `${record.job.jobId}.json`);
}

async function seed(jobs: string, ...records: Fixture[]) {
  await mkdir(jobs, { recursive: true });
  for (const record of records) {
    await writeFile(fileOf(jobs, record), `${JSON.stringify(record)}\n`, "utf8");
  }
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function snapshot(jobs: string) {
  const out: Record<string, { sha: string; mtimeMs: number }> = {};
  for (const name of (await readdir(jobs)).filter((entry) => entry.endsWith(".json"))) {
    const file = path.join(jobs, name);
    out[name] = { sha: sha(await readFile(file, "utf8")), mtimeMs: (await stat(file)).mtimeMs };
  }
  return out;
}

function v2Record(overrides: Partial<StoredDesignJob> = {}): StoredDesignJob {
  const jobId = "eeeeeeee-0001-4000-8000-000000000001";
  return {
    schemaVersion: DESIGN_RECORD_VERSION,
    job: designJob({ jobId, clientRequestId: "ffffffff-0001-4000-8000-000000000001" }),
    request: "补一个迁移评审",
    requestHash: DESIGN_HASH,
    requestHashVersion: 2,
    outputContractVersion: 2,
    existingRolesOnly: true,
    roleGap: null,
    mode: "economy-all",
    selectionIntent: null,
    creation: null,
    attempts: [],
    proposal: null,
    result: null,
    reuseFingerprints: {},
    leaseOwner: null,
    receipts: {},
    outcomeUnknown: false,
    ...overrides,
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

describe("version 1 records: read in memory, never rewritten by a read", () => {
  test("every baseline record loads with the legacy rules and its file stays byte-identical", async () => {
    const { store, jobs } = await openStore();
    await seed(jobs, ...DESIGN_V1_RECORDS);
    const before = await snapshot(jobs);

    const listed = await store.list();
    expect(listed).toHaveLength(DESIGN_V1_RECORDS.length);
    for (const record of listed) {
      expect(record).toMatchObject({ ...LEGACY_RECORD_RULES, schemaVersion: 1 });
      // Absent on the Job DTO: "the old ≤3 rule" is not the same as an explicit false.
      expect(record.job.existingRolesOnly).toBeUndefined();
      expect(record.job.outputContractVersion).toBeUndefined();
    }
    for (const fixture of DESIGN_V1_RECORDS) {
      expect(await store.get(fixture.job.jobId)).toMatchObject({
        requestHash: fixture.requestHash,
        ...LEGACY_RECORD_RULES,
      });
      expect(await store.findRequest(fixture.job.clientRequestId)).not.toBeNull();
    }
    expect(await store.problems()).toEqual([]);

    // Initialize again on the same home (a restart) is also a pure read.
    await store.dispose();
    const reopened = createDesignJobStore({ home: homes[0], clock: { now: () => NOW } });
    await reopened.initialize();
    await reopened.list();
    await reopened.dispose();
    expect(await snapshot(jobs)).toEqual(before);
  });

  test("a successful CAS update writes version 2 and keeps hash, nonce, promptHash, and ids", async () => {
    const { store, jobs } = await openStore();
    await seed(jobs, DESIGN_V1_RECORD_DESIGNING);
    const current = await store.get(DESIGN_V1_RECORD_DESIGNING.job.jobId);
    if (!current) throw new Error("fixture missing");
    await store.update(current.job.jobId, current.job.stateRevision, {
      ...current,
      job: { ...current.job, stateRevision: "99999999-0000-4000-8000-000000000001" },
    });

    const onDisk = JSON.parse(await readFile(fileOf(jobs, DESIGN_V1_RECORD_DESIGNING), "utf8"));
    expect(onDisk).toMatchObject({
      schemaVersion: 2,
      requestHashVersion: 1,
      outputContractVersion: 1,
      existingRolesOnly: false,
      roleGap: null,
      requestHash: DESIGN_V1_RECORD_DESIGNING.requestHash,
      selectionIntent: DESIGN_V1_RECORD_DESIGNING.selectionIntent,
    });
    expect(onDisk.attempts).toEqual(DESIGN_V1_RECORD_DESIGNING.attempts);
    // The in-memory defaults must not leak into the Job DTO copy of a legacy-contract record.
    expect(onDisk.job).not.toHaveProperty("existingRolesOnly");
    expect(onDisk.job).not.toHaveProperty("outputContractVersion");
    expect(onDisk.job).not.toHaveProperty("roleGap");
    expect(await store.get(current.job.jobId)).toMatchObject({
      schemaVersion: 2,
      ...LEGACY_RECORD_RULES,
    });
  });

  test("a CAS conflict writes nothing to a version 1 file", async () => {
    const { store, jobs } = await openStore();
    await seed(jobs, DESIGN_V1_RECORD_READY);
    const before = await snapshot(jobs);
    const current = await store.get(DESIGN_V1_RECORD_READY.job.jobId);
    if (!current) throw new Error("fixture missing");
    await expect(
      store.update(current.job.jobId, "00000000-0000-4000-8000-0000000000aa", current),
    ).rejects.toMatchObject({ issue: "conflict" });
    expect(await snapshot(jobs)).toEqual(before);
  });

  test("the baseline fixtures cover starting, designing, validating, ready, and failed", () => {
    expect(
      [
        DESIGN_V1_RECORD_STARTING,
        DESIGN_V1_RECORD_DESIGNING,
        DESIGN_V1_RECORD_VALIDATING,
        DESIGN_V1_RECORD_READY,
        DESIGN_V1_RECORD_FAILED,
      ].map((record) => record.job.state),
    ).toEqual(["starting", "designing", "validating", "ready", "failed"]);
  });
});

describe("version 2 records", () => {
  test("a new record round-trips with the root as the authority and a Job DTO copy", async () => {
    const { store, jobs } = await openStore();
    const record = v2Record();
    await store.create(record);
    const onDisk = JSON.parse(await readFile(path.join(jobs, `${record.job.jobId}.json`), "utf8"));
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
    expect(await store.get(record.job.jobId)).toMatchObject({
      existingRolesOnly: true,
      outputContractVersion: 2,
      job: { existingRolesOnly: true, outputContractVersion: 2, roleGap: null },
    });
  });

  test("keys a newer writer added survive a CAS update at every record-owned layer", async () => {
    const { store, jobs } = await openStore();
    const record = v2Record();
    await store.create(record);
    const file = path.join(jobs, `${record.job.jobId}.json`);
    const written = JSON.parse(await readFile(file, "utf8"));
    written.futureRoot = { keep: 1 };
    written.job.futureJob = "j";
    written.attempts = [
      {
        attempt: 1,
        nonce: "b".repeat(32),
        messageId: "55555555-5555-4555-8555-555555555555",
        promptHash: DESIGN_HASH,
        epoch: null,
        endCursor: null,
        summary: null,
        ack: "acked",
        futureAttempt: true,
      },
    ];
    written.creation = { intentHash: DESIGN_HASH, idempotencyKey: "k", futureCreation: 1 };
    await writeFile(file, `${JSON.stringify(written)}\n`, "utf8");

    const current = await store.get(record.job.jobId);
    if (!current) throw new Error("missing");
    await store.update(current.job.jobId, current.job.stateRevision, {
      ...current,
      job: { ...current.job, stateRevision: "99999999-0000-4000-8000-000000000002" },
    });
    const after = JSON.parse(await readFile(file, "utf8"));
    expect(after.futureRoot).toEqual({ keep: 1 });
    expect(after.job.futureJob).toBe("j");
    expect(after.attempts[0].futureAttempt).toBe(true);
    expect(after.creation.futureCreation).toBe(1);
  });

  test("a record whose Job DTO copy disagrees with the root is corrupt, not silently fixed", async () => {
    const { store, jobs } = await openStore();
    const record = v2Record();
    await store.create(record);
    const file = path.join(jobs, `${record.job.jobId}.json`);
    const base = JSON.parse(await readFile(file, "utf8"));

    const cases: [string, (value: JsonRecord) => void][] = [
      ["copy rule differs", (value) => (value.job.existingRolesOnly = false)],
      ["copy contract differs", (value) => (value.job.outputContractVersion = 1)],
      ["copy missing on a contract-2 record", (value) => delete value.job.existingRolesOnly],
      [
        "legacy contract with the true rule",
        (value) => {
          value.outputContractVersion = 1;
          delete value.job.outputContractVersion;
          delete value.job.existingRolesOnly;
          delete value.job.roleGap;
        },
      ],
      [
        "legacy contract carrying a copy",
        (value) => {
          value.outputContractVersion = 1;
          value.existingRolesOnly = false;
        },
      ],
      ["gap on a job that is not failed", (value) => (value.roleGap = [gapReport])],
    ];
    for (const [label, mutate] of cases) {
      const broken = structuredClone(base);
      mutate(broken);
      await writeFile(file, `${JSON.stringify(broken)}\n`, "utf8");
      expect(await store.problems(), label).toEqual([
        { name: `${record.job.jobId}.json`, reason: "corrupt" },
      ]);
    }
    await writeFile(file, `${JSON.stringify(base)}\n`, "utf8");
    expect(await store.problems()).toEqual([]);
  });

  test("the creation-time rules never change, and a gap is set once", async () => {
    const { store } = await openStore();
    const record = v2Record();
    await store.create(record);
    const current = await store.get(record.job.jobId);
    if (!current) throw new Error("missing");
    const revision = current.job.stateRevision;
    const bump = (next: StoredDesignJob): StoredDesignJob => ({
      ...next,
      job: { ...next.job, stateRevision: "99999999-0000-4000-8000-000000000003" },
    });
    for (const changed of [
      { existingRolesOnly: false },
      { outputContractVersion: 1 as const },
      { requestHashVersion: 1 as const },
    ]) {
      await expect(
        store.update(current.job.jobId, revision, bump({ ...current, ...changed })),
      ).rejects.toMatchObject({ issue: "conflict" });
    }
  });

  test("a gap record round-trips: failed, no result, gap on the root and the Job DTO", async () => {
    const { store, jobs } = await openStore();
    const record = v2Record();
    await store.create(record);
    const current = await store.get(record.job.jobId);
    if (!current) throw new Error("missing");
    const failed: StoredDesignJob = {
      ...current,
      roleGap: [gapReport],
      job: {
        ...current.job,
        state: "failed",
        finishedAt: NOW,
        stateRevision: "99999999-0000-4000-8000-000000000004",
        roleGap: [gapReport],
      },
    };
    await store.update(current.job.jobId, current.job.stateRevision, failed);
    const read = await store.get(record.job.jobId);
    expect(read?.roleGap).toEqual([gapReport]);
    expect(read?.job.roleGap).toEqual([gapReport]);
    expect(read?.result).toBeNull();
    const onDisk = JSON.parse(await readFile(path.join(jobs, `${record.job.jobId}.json`), "utf8"));
    expect(onDisk.roleGap).toEqual([gapReport]);

    // Once set, the gap cannot be rewritten or cleared.
    await expect(
      store.update(record.job.jobId, failed.job.stateRevision, {
        ...failed,
        roleGap: null,
        job: {
          ...failed.job,
          stateRevision: "99999999-0000-4000-8000-000000000005",
          roleGap: null,
        },
      }),
    ).rejects.toMatchObject({ issue: "conflict" });
  });

  test("a gap on a record that is not an existing-roles-only failure cannot be written", async () => {
    const { store } = await openStore();
    const record = v2Record({ existingRolesOnly: false });
    record.job = { ...record.job, existingRolesOnly: false };
    await store.create(record);
    const current = await store.get(record.job.jobId);
    if (!current) throw new Error("missing");
    await expect(
      store.update(current.job.jobId, current.job.stateRevision, {
        ...current,
        roleGap: [gapReport],
        job: {
          ...current.job,
          state: "failed",
          finishedAt: NOW,
          stateRevision: "99999999-0000-4000-8000-000000000006",
          roleGap: [gapReport],
        },
      }),
    ).rejects.toMatchObject({ issue: "corrupt" });
  });

  test("a version above 2 stays isolated and still blocks only its own clientRequestId", async () => {
    const { store, jobs } = await openStore();
    await seed(jobs, DESIGN_V1_RECORD_READY);
    const future = { ...structuredClone(DESIGN_V1_RECORD_FAILED), schemaVersion: 3 };
    await writeFile(fileOf(jobs, DESIGN_V1_RECORD_FAILED), `${JSON.stringify(future)}\n`, "utf8");
    expect(await store.problems()).toEqual([
      { name: `${DESIGN_V1_RECORD_FAILED.job.jobId}.json`, reason: "unknown-version" },
    ]);
    await expect(
      store.findRequest(DESIGN_V1_RECORD_FAILED.job.clientRequestId),
    ).rejects.toMatchObject({
      issue: "unknown-version",
    });
    expect(await store.findRequest("00000000-0000-4000-8000-0000000000ff")).toBeNull();
  });
});

describe("rollback to the baseline reader (D9)", () => {
  // A literal copy of the baseline parseRecord/rawClientRequestId decisions: version must be 1,
  // the file name is the jobId, and a same-clientRequestId record must be findable at job.clientRequestId.
  function baselineRead(raw: string, file: string) {
    const parsed = JSON.parse(raw);
    if (parsed.schemaVersion !== 1) return "unknown-version";
    return path.basename(file, ".json") === parsed.job.jobId ? "ok" : "corrupt";
  }
  const baselineClientRequestId = (raw: string): string | null => {
    const parsed = JSON.parse(raw);
    return typeof parsed?.job?.clientRequestId === "string" ? parsed.job.clientRequestId : null;
  };

  test("a version 2 file is unknown-version to the baseline, keeps its identity paths, and is not altered by reading", async () => {
    const { store, jobs } = await openStore();
    const record = v2Record();
    await store.create(record);
    const file = path.join(jobs, `${record.job.jobId}.json`);
    const raw = await readFile(file, "utf8");
    const before = sha(raw);
    expect(baselineRead(raw, file)).toBe("unknown-version");
    // The baseline refuses to create a second job for this request instead of duplicating it.
    expect(baselineClientRequestId(raw)).toBe(record.job.clientRequestId);
    expect(path.basename(file, ".json")).toBe(record.job.jobId);
    expect(sha(await readFile(file, "utf8"))).toBe(before);
  });

  test("an untouched version 1 file is still a plain baseline record", async () => {
    const { jobs } = await openStore();
    await seed(jobs, ...DESIGN_V1_RECORDS);
    for (const fixture of DESIGN_V1_RECORDS) {
      const file = fileOf(jobs, fixture);
      expect(baselineRead(await readFile(file, "utf8"), file)).toBe("ok");
    }
  });
});

describe("result-owned unknown keys", () => {
  test("a key a newer writer put on the stored result survives a CAS update", async () => {
    const { store, jobs } = await openStore();
    const base = v2Record({ existingRolesOnly: false, mode: "sota" });
    base.job = { ...base.job, existingRolesOnly: false };
    const record: StoredDesignJob = {
      ...base,
      result: designResult({ jobId: base.job.jobId }),
      job: { ...base.job, state: "ready", resultId: designResult().resultId },
    };
    await store.create(record);
    const file = path.join(jobs, `${record.job.jobId}.json`);
    const written = JSON.parse(await readFile(file, "utf8"));
    written.result.futureResult = { keep: true };
    await writeFile(
      file,
      `${JSON.stringify(written)}
`,
      "utf8",
    );
    const current = await store.get(record.job.jobId);
    if (!current) throw new Error("missing");
    await store.update(current.job.jobId, current.job.stateRevision, {
      ...current,
      job: { ...current.job, stateRevision: "99999999-0000-4000-8000-000000000009" },
    });
    expect(JSON.parse(await readFile(file, "utf8")).result.futureResult).toEqual({ keep: true });
  });
});

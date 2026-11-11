import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createRunStore, RunStoreError } from "../../server/run-engine/store";
import { findLockConflicts } from "../../shared/domain/run-engine/locks";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import {
  assignmentsForRun,
  claim,
  INTENT_T2,
  noncesForRun,
  REPO_ID,
  withLedger,
} from "../fixtures/run-engine/base";

const homes: string[] = [];
const stores: Array<{ close(): Promise<void> }> = [];

async function tempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "run-store-"));
  homes.push(home);
  return home;
}

async function open(home: string) {
  const store = createRunStore({ home, lock: { acquireTimeoutMs: 300 } });
  stores.push(store);
  await store.initialize();
  return store;
}

function firstRevision(runId: string, overrides: Record<string, unknown> = {}): RunRecord {
  // Proofs and nonce registrations are bound to the run id, so rebind them with the fixture helpers.
  return withLedger({
    runId,
    revision: 1,
    previousDigest: "",
    resources: [],
    assignments: assignmentsForRun(runId),
    nonceRegistry: noncesForRun(runId),
    ...overrides,
  });
}

function recordPath(home: string, runId: string): string {
  return path.join(home, "agent-team-runs", "v1", "runs", `${runId}.json`);
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe("run store lifecycle", () => {
  test("refuses to run without an explicit absolute home", async () => {
    const missing = createRunStore({ home: undefined });
    await expect(missing.initialize()).rejects.toMatchObject({ code: "root-missing" });
    const relative = createRunStore({ home: "relative/home" });
    await expect(relative.initialize()).rejects.toMatchObject({ code: "root-relative" });
    await expect(missing.get("run-aaaa-bbbb")).rejects.toMatchObject({ code: "not-initialized" });
  });

  test("creates, reads back, and rejects a second create of the same run", async () => {
    const store = await open(await tempHome());
    const created = await store.create(firstRevision("run-aaa111-a1"));
    expect(created.status).toBe("committed");
    const read = await store.get("run-aaa111-a1");
    expect(read).toMatchObject({ status: "ok", revision: 1 });
    await expect(store.create(firstRevision("run-aaa111-a1"))).rejects.toMatchObject({
      code: "already-exists",
    });
    await expect(store.get("run-missing-a1")).resolves.toEqual({ status: "missing" });
  });

  test("create requires a first revision", async () => {
    const store = await open(await tempHome());
    await expect(
      store.create(
        firstRevision("run-aaa111-a2", { revision: 2, previousDigest: `sha256:${"a".repeat(64)}` }),
      ),
    ).rejects.toBeInstanceOf(RunStoreError);
  });

  test("update owns the header: revision and digest chain advance, caller values are ignored", async () => {
    const store = await open(await tempHome());
    const first = await store.create(firstRevision("run-aaa111-a3"));
    const second = await store.update("run-aaa111-a3", (record) => ({
      ...record,
      revision: 99,
      previousDigest: "",
      updatedAt: "2026-11-05T00:00:00.000Z",
    }));
    expect(second.status).toBe("committed");
    if (second.status !== "committed") return;
    expect(second.record.revision).toBe(2);
    expect(second.record.previousDigest).toBe(first.status === "committed" ? first.digest : "");
    const unchanged = await store.update("run-aaa111-a3", () => null);
    expect(unchanged).toMatchObject({ status: "unchanged", revision: 2 });
    await expect(store.update("run-none-a1", (r) => r)).rejects.toMatchObject({
      code: "not-found",
    });
  });

  test("a mutation that would produce an invalid record is rejected before anything is written", async () => {
    const home = await tempHome();
    const store = await open(home);
    await store.create(firstRevision("run-aaa111-a4"));
    const before = await readFile(recordPath(home, "run-aaa111-a4"), "utf8");
    await expect(
      store.update(
        "run-aaa111-a4",
        (record) => ({ ...record, lifecycle: "bogus" }) as unknown as RunRecord,
      ),
    ).rejects.toMatchObject({ code: "invalid-record" });
    expect(await readFile(recordPath(home, "run-aaa111-a4"), "utf8")).toBe(before);
    const names = await readdir(path.dirname(recordPath(home, "run-aaa111-a4")));
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("a second store on the same home cannot become a writer while the first is open", async () => {
    const home = await tempHome();
    await open(home);
    const rival = createRunStore({ home, lock: { acquireTimeoutMs: 150 } });
    stores.push(rival);
    await expect(rival.initialize()).rejects.toMatchObject({ code: "lock-contended" });
    expect(rival.ready).toBe(false);
  });

  test("close releases the lock so a restarted store takes over and sees committed data", async () => {
    const home = await tempHome();
    const first = await open(home);
    await first.create(firstRevision("run-aaa111-a5"));
    await first.close();
    const second = await open(home);
    await expect(second.get("run-aaa111-a5")).resolves.toMatchObject({ status: "ok", revision: 1 });
    const listed = await second.list();
    expect(listed.entries.map((entry) => entry.runId)).toEqual(["run-aaa111-a5"]);
  });

  test("concurrent updates on one run serialize and lose nothing", async () => {
    const store = await open(await tempHome());
    const base = firstRevision("run-aaa111-a6");
    await store.create(base);
    await Promise.all(
      Array.from({ length: 12 }, () =>
        store.update("run-aaa111-a6", (record) => ({
          ...record,
          dagRevision: record.dagRevision + 1,
        })),
      ),
    );
    const read = await store.get("run-aaa111-a6");
    expect(read.status === "ok" && read.revision).toBe(13);
    expect(read.status === "ok" && read.record.dagRevision).toBe(base.dagRevision + 12);
  });

  test("startup sweeps dead temp files but never touches records", async () => {
    const home = await tempHome();
    const first = await open(home);
    await first.create(firstRevision("run-aaa111-a7"));
    await first.close();
    const dir = path.dirname(recordPath(home, "run-aaa111-a7"));
    await writeFile(path.join(dir, ".run-aaa111-a7.json.dead-1.tmp"), "partial");
    const second = await open(home);
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    await expect(second.get("run-aaa111-a7")).resolves.toMatchObject({ status: "ok" });
  });
});

describe("cross-run resources", () => {
  const scopes = (path_: string) => [
    {
      repoId: REPO_ID,
      kind: "file" as const,
      path: path_,
      access: "write" as const,
      verified: true,
    },
  ];

  test("a second run sees the first run's claim, including Windows case and separator aliases", async () => {
    const store = await open(await tempHome());
    await store.create(
      firstRevision("run-aaa111-b1", {
        resources: [claim({ claimId: "claim-b1", path: "src/App.ts" })],
      }),
    );
    await store.create(firstRevision("run-aaa111-b2"));
    let conflicts = -1;
    await store.update("run-aaa111-b2", (record, ctx) => {
      expect(ctx.otherResources.trusted).toBe(true);
      const check = findLockConflicts(
        { resources: [...record.resources, ...ctx.otherResources.claims] },
        { taskId: "t9", scopes: scopes("SRC\\app.ts") },
      );
      conflicts = check.ok ? check.conflicts.length : -2;
      return null;
    });
    expect(conflicts).toBe(1);
  });

  test("a run does not see its own claims as another run's", async () => {
    const store = await open(await tempHome());
    await store.create(
      firstRevision("run-aaa111-b3", { resources: [claim({ claimId: "claim-b3" })] }),
    );
    const view = await store.resourcesExcluding("run-aaa111-b3");
    expect(view).toEqual({ trusted: true, claims: [] });
  });

  test("a claim committed by one run is visible to the next update of another run", async () => {
    const store = await open(await tempHome());
    await store.create(firstRevision("run-aaa111-b4"));
    await store.create(firstRevision("run-aaa111-b5"));
    await store.update("run-aaa111-b4", (record) => ({
      ...record,
      resources: [claim({ claimId: "claim-b4", path: "docs/plan.md" })],
    }));
    const view = await store.resourcesExcluding("run-aaa111-b5");
    expect(view.trusted && view.claims.map((c) => c.claimId)).toEqual(["claim-b4"]);
  });

  test("a damaged record makes the view untrusted instead of looking free", async () => {
    const home = await tempHome();
    const first = await open(home);
    await first.create(
      firstRevision("run-aaa111-b6", { resources: [claim({ claimId: "claim-b6" })] }),
    );
    await first.create(firstRevision("run-aaa111-b7"));
    await first.close();
    await writeFile(recordPath(home, "run-aaa111-b6"), "{ not json");
    const second = await open(home);
    const view = await second.resourcesExcluding("run-aaa111-b7");
    expect(view.trusted).toBe(false);
    expect(!view.trusted && view.broken).toEqual([{ runId: "run-aaa111-b6", reason: "corrupt" }]);
    const listed = await second.list();
    expect(listed.broken).toEqual([{ runId: "run-aaa111-b6", reason: "corrupt" }]);
    expect(listed.entries.map((e) => e.runId)).toEqual(["run-aaa111-b7"]);
  });

  test("a file that cannot be attributed to a run also makes the view untrusted", async () => {
    const home = await tempHome();
    const first = await open(home);
    await first.create(firstRevision("run-aaa111-b8"));
    await first.close();
    await writeFile(
      path.join(path.dirname(recordPath(home, "run-aaa111-b8")), "Run-Other.JSON"),
      "{}",
    );
    const second = await open(home);
    const view = await second.resourcesExcluding("run-aaa111-b8");
    expect(view.trusted).toBe(false);
  });
});

describe("damaged and foreign records", () => {
  test("corrupt bytes are preserved, quarantined with a diagnostic, and refuse updates", async () => {
    const home = await tempHome();
    const first = await open(home);
    await first.create(firstRevision("run-aaa111-c1"));
    await first.close();
    await writeFile(recordPath(home, "run-aaa111-c1"), "{ truncated");
    const second = await open(home);
    const read = await second.get("run-aaa111-c1");
    expect(read).toMatchObject({ status: "corrupt", reason: "json" });
    await expect(second.update("run-aaa111-c1", (r) => r)).rejects.toMatchObject({
      code: "unrecoverable-run",
    });
    expect(await readFile(recordPath(home, "run-aaa111-c1"), "utf8")).toBe("{ truncated");
    const issues = await readdir(path.join(home, "agent-team-runs", "v1", "issues"));
    expect(issues.length).toBe(1);
  });

  test("an unknown schema version is left byte-for-byte untouched and reported", async () => {
    const home = await tempHome();
    const first = await open(home);
    await first.create(firstRevision("run-aaa111-c2"));
    await first.close();
    const bytes = `${JSON.stringify({ schemaVersion: 3, runId: "run-aaa111-c2", future: true })}\n`;
    await writeFile(recordPath(home, "run-aaa111-c2"), bytes);
    const second = await open(home);
    expect(await second.get("run-aaa111-c2")).toMatchObject({
      status: "unknown-version",
      schemaVersion: 3,
    });
    await expect(second.update("run-aaa111-c2", (r) => r)).rejects.toMatchObject({
      code: "unrecoverable-run",
    });
    expect(await readFile(recordPath(home, "run-aaa111-c2"), "utf8")).toBe(bytes);
    expect((await second.list()).broken).toEqual([
      { runId: "run-aaa111-c2", reason: "unknown-version" },
    ]);
  });

  test("a record over the hard limit is reported and never overwritten or truncated", async () => {
    const home = await tempHome();
    const first = await open(home);
    await first.create(firstRevision("run-aaa111-c3"));
    await first.close();
    const small = createRunStore({ home, limits: { hardBytes: 512, softBytes: 256 } });
    stores.push(small);
    await small.initialize();
    expect(await small.get("run-aaa111-c3")).toMatchObject({
      status: "corrupt",
      reason: "oversize",
    });
    await expect(small.update("run-aaa111-c3", (r) => r)).rejects.toMatchObject({
      code: "unrecoverable-run",
    });
    expect((await readFile(recordPath(home, "run-aaa111-c3"), "utf8")).length).toBeGreaterThan(512);
  });

  test("an edit made behind the store's back becomes the new base for the next update", async () => {
    const home = await tempHome();
    const store = await open(home);
    await store.create(firstRevision("run-aaa111-c4"));
    let tampered = "";
    await expect(
      store.update("run-aaa111-c4", (record) => {
        tampered = JSON.stringify({ ...record, dagRevision: 7 });
        return { ...record, dagRevision: 1 };
      }),
    ).resolves.toMatchObject({ status: "committed" });
    // The store re-reads under its own lock, so an external write between updates is simply the new
    // base: the next update must build on it rather than clobber it.
    const external = JSON.parse(await readFile(recordPath(home, "run-aaa111-c4"), "utf8"));
    expect(tampered).not.toBe("");
    await writeFile(
      recordPath(home, "run-aaa111-c4"),
      `${JSON.stringify({ ...external, dagRevision: 5 })}\n`,
    );
    const result = await store.update("run-aaa111-c4", (record) => ({
      ...record,
      dagRevision: record.dagRevision + 1,
    }));
    expect(result.status === "committed" && result.record.dagRevision).toBe(6);
  });
});

describe("capacity limits", () => {
  test("a commit over the hard limit is refused and the stored record is unchanged", async () => {
    const home = await tempHome();
    const seed = await open(home);
    await seed.create(firstRevision("run-aaa111-d1"));
    await seed.close();
    const file = recordPath(home, "run-aaa111-d1");
    const before = await readFile(file, "utf8");
    const size = Buffer.byteLength(before, "utf8");

    const tight = createRunStore({
      home,
      limits: { hardBytes: size + 64, softBytes: size },
      lock: { acquireTimeoutMs: 300 },
    });
    stores.push(tight);
    await tight.initialize();
    await expect(
      tight.update("run-aaa111-d1", (record) => ({
        ...record,
        alerts: [],
        metrics: { ...record.metrics, padding: "x".repeat(4096) },
      })),
    ).rejects.toMatchObject({ code: "too-large" });
    expect(await readFile(file, "utf8")).toBe(before);
    expect((await readdir(path.dirname(file))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    // The failed attempt did not poison the slot: the record still reads and a smaller update works.
    await expect(tight.get("run-aaa111-d1")).resolves.toMatchObject({ status: "ok", revision: 1 });
  });

  test("crossing the soft limit is reported so the caller can compact before the next commit", async () => {
    const home = await tempHome();
    const seed = await open(home);
    await seed.create(firstRevision("run-aaa111-d2"));
    await seed.close();
    const size = Buffer.byteLength(
      await readFile(recordPath(home, "run-aaa111-d2"), "utf8"),
      "utf8",
    );

    const store = createRunStore({
      home,
      limits: { hardBytes: size * 4, softBytes: size + 8 },
      lock: { acquireTimeoutMs: 300 },
    });
    stores.push(store);
    await store.initialize();
    const result = await store.update("run-aaa111-d2", (record) => ({
      ...record,
      metrics: { ...record.metrics, padding: "x".repeat(256) },
    }));
    expect(result).toMatchObject({ status: "committed", needsCompaction: true });
    const listed = await store.list();
    expect(listed.entries[0]).toMatchObject({ runId: "run-aaa111-d2", needsCompaction: true });
  });

  test("a task list beyond the schema cap is rejected before any write", async () => {
    const home = await tempHome();
    const store = await open(home);
    await store.create(firstRevision("run-aaa111-d3"));
    const file = recordPath(home, "run-aaa111-d3");
    const before = await readFile(file, "utf8");
    await expect(
      store.update("run-aaa111-d3", (record) => ({
        ...record,
        tasks: Array.from({ length: 65 }, () => record.tasks[0]).filter(
          (task): task is NonNullable<typeof task> => task !== undefined,
        ),
      })),
    ).rejects.toMatchObject({ code: "invalid-record" });
    expect(await readFile(file, "utf8")).toBe(before);
  });
});

describe("the last way out of a frozen Run (E2b): stop the daemon, move its ledger file out, start again", () => {
  const exclusive = (claimId: string, taskId: string) =>
    claim({
      claimId,
      taskId,
      kind: "hot",
      path: "repo-exclusive",
      access: "write",
    });
  const wantsRepo = [
    {
      repoId: REPO_ID,
      kind: "hot" as const,
      path: "repo-exclusive",
      access: "write" as const,
      verified: true,
    },
  ];

  test("a paused Run with an unknown delivery and repo-exclusive claim blocks another Run until its file is moved out", async () => {
    const home = await tempHome();
    const first = await open(home);
    const frozenRecord = firstRevision("run-aaa111-w1", {
      lifecycle: "paused",
      resources: [exclusive("claim-w1", "t2")],
    });
    frozenRecord.outbox = frozenRecord.outbox.map((intent) =>
      intent.id === INTENT_T2 ? { ...intent, state: "outcome-unknown", confirmedAt: null } : intent,
    );
    await first.create(frozenRecord);
    await first.create(firstRevision("run-aaa111-w2"));
    const frozen = await first.get("run-aaa111-w1");
    expect(frozen.status).toBe("ok");
    if (frozen.status !== "ok") throw new Error("frozen Run missing");
    expect(frozen.record).toMatchObject({
      lifecycle: "paused",
      outbox: expect.arrayContaining([
        expect.objectContaining({
          id: INTENT_T2,
          kind: "dispatch",
          state: "outcome-unknown",
          confirmedAt: null,
        }),
      ]),
      resources: [{ path: "repo-exclusive", access: "write" }],
    });
    const otherBefore = await first.get("run-aaa111-w2");
    const frozenBytes = await readFile(recordPath(home, "run-aaa111-w1"));
    // While the file is in the ledger the other Run waits for it, whatever the first one's state.
    await first.update("run-aaa111-w2", (record, ctx) => {
      expect(ctx.otherResources.trusted).toBe(true);
      const check = findLockConflicts(
        { resources: [...record.resources, ...ctx.otherResources.claims] },
        { taskId: "t9", scopes: wantsRepo },
      );
      expect(check.ok && check.conflicts.length).toBe(1);
      return null;
    });
    await first.close();

    // The daemon is stopped; the file goes to a backup directory, not away.
    const backup = path.join(home, "backup");
    await mkdir(backup);
    await rename(recordPath(home, "run-aaa111-w1"), path.join(backup, "run-aaa111-w1.json"));

    const second = await open(home);
    const listed = await second.list();
    expect(listed.entries.map((entry) => entry.runId)).toEqual(["run-aaa111-w2"]);
    // A file that is not there is missing, not damaged: nothing else is made untrusted by it.
    expect(listed.broken).toEqual([]);
    expect(await second.resourcesExcluding("run-aaa111-w2")).toEqual({ trusted: true, claims: [] });
    expect((await second.get("run-aaa111-w1")).status).toBe("missing");
    expect(await second.get("run-aaa111-w2")).toEqual(otherBefore);
    expect(await readFile(path.join(backup, "run-aaa111-w1.json"))).toEqual(frozenBytes);
    await second.update("run-aaa111-w2", (record, ctx) => {
      expect(ctx.otherResources).toEqual({ trusted: true, claims: [] });
      const check = findLockConflicts(
        { resources: [...record.resources, ...ctx.otherResources.claims] },
        { taskId: "t9", scopes: wantsRepo },
      );
      expect(check.ok && check.conflicts.length).toBe(0);
      return { ...record, resources: [exclusive("claim-w2", "t2")] };
    });
    expect((await second.get("run-aaa111-w2")).status).toBe("ok");
    expect(await readdir(backup)).toEqual(["run-aaa111-w1.json"]);
    expect(await readFile(path.join(backup, "run-aaa111-w1.json"))).toEqual(frozenBytes);
    await second.close();

    // Restoring the backup after another Run has acquired the resource revives both claims.
    await rename(path.join(backup, "run-aaa111-w1.json"), recordPath(home, "run-aaa111-w1"));
    const third = await open(home);
    const w1Peers = await third.resourcesExcluding("run-aaa111-w1");
    const w2Peers = await third.resourcesExcluding("run-aaa111-w2");
    expect(w1Peers).toMatchObject({
      trusted: true,
      claims: [{ claimId: "claim-w2", repoId: REPO_ID, kind: "hot", path: "repo-exclusive" }],
    });
    expect(w2Peers).toMatchObject({
      trusted: true,
      claims: [{ claimId: "claim-w1", repoId: REPO_ID, kind: "hot", path: "repo-exclusive" }],
    });
  });
});

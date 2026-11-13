import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunStore } from "../../v2/server/store";
import { makeRun } from "./fixtures";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "v2-store-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("run store", () => {
  it("creates, reads, updates and lists Runs with an increasing revision", async () => {
    const store = createRunStore(tmp());
    expect(await store.get("r-20261112-0001")).toBeNull();
    const created = await store.create(makeRun());
    expect(created.revision).toBe(1);
    const updated = await store.update(created.id, (r) => ({ ...r, state: "gating" }));
    expect(updated).toMatchObject({ revision: 2, state: "gating" });
    expect((await store.get(created.id))?.state).toBe("gating");
    await store.create(makeRun({ id: "r-20261112-0002", createdAt: "2026-11-12T11:00:00.000Z" }));
    expect((await store.list()).map((r) => r.id)).toEqual(["r-20261112-0001", "r-20261112-0002"]);
  });

  it("survives a restart: a new store instance reads what the old one wrote", async () => {
    const root = tmp();
    await createRunStore(root).create(makeRun());
    expect((await createRunStore(root).get("r-20261112-0001"))?.title).toBe("demo");
  });

  it("refuses to create a Run twice", async () => {
    const store = createRunStore(tmp());
    await store.create(makeRun());
    await expect(store.create(makeRun())).rejects.toThrow();
  });

  it("rejects ids that could escape the runs directory", async () => {
    const store = createRunStore(tmp());
    await expect(store.get("../evil")).rejects.toThrow(/invalid run id/);
    await expect(store.update("r-1", (r) => r)).rejects.toThrow(/invalid run id/);
  });

  it("skips a corrupt file in list and reports it, but get throws for that id", async () => {
    const root = tmp();
    const broken: string[] = [];
    const store = createRunStore(root, (id) => broken.push(id));
    await store.create(makeRun());
    writeFileSync(path.join(root, "runs", "r-20261112-0009.json"), "{not json");
    expect((await store.list()).map((r) => r.id)).toEqual(["r-20261112-0001"]);
    expect(broken).toEqual(["r-20261112-0009"]);
    await expect(store.get("r-20261112-0009")).rejects.toThrow(/unreadable/);
  });

  it("detects a second writer instead of overwriting its change", async () => {
    const root = tmp();
    const store = createRunStore(root);
    const run = await store.create(makeRun());
    const file = path.join(root, "runs", `${run.id}.json`);
    await expect(
      store.update(run.id, (r) => {
        writeFileSync(
          file,
          JSON.stringify({ ...r, revision: r.revision + 1, title: "someone else" }),
        );
        return r;
      }),
    ).rejects.toThrow("changed underneath");
    expect((await store.get(run.id))?.title).toBe("someone else");
  });

  it("still reads a stored Run whose provider predates a stricter launch rule", async () => {
    const root = tmp();
    const store = createRunStore(root);
    const run = makeRun();
    await store.create({
      ...run,
      specs: { ...run.specs, reviewers: [{ profile: "r", provider: "codex" }] },
    });
    expect((await store.get(run.id))?.specs.reviewers[0]?.provider).toBe("codex");
  });

  it("update on a missing Run throws", async () => {
    await expect(createRunStore(tmp()).update("r-20261112-0001", (r) => r)).rejects.toThrow(
      /missing/,
    );
  });
});

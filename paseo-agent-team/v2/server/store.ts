import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { type Run, RunSchema } from "../shared/run";

const RUN_ID = /^r-\d{8}-[0-9a-f]{4}$/;

export function assertRunId(id: string): string {
  if (!RUN_ID.test(id)) throw new Error(`invalid run id: ${id}`);
  return id;
}

/**
 * One JSON file per Run under `<root>/runs`. Writes go to a temp file that is synced and renamed over
 * the target, so a crash leaves either the old or the new file. The engine serializes writes per Run;
 * `revision` is re-checked right before the rename to catch a second writer (e.g. an overlapping reload).
 */
export function createRunStore(root: string, onBroken?: (id: string, reason: string) => void) {
  const runsDir = path.join(root, "runs");
  const fileOf = (id: string) => path.join(runsDir, `${assertRunId(id)}.json`);

  async function read(id: string): Promise<Run | null> {
    let text: string;
    try {
      text = await readFile(fileOf(id), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    try {
      return RunSchema.parse(JSON.parse(text));
    } catch (e) {
      throw new Error(
        `run ${id} is unreadable: ${e instanceof Error ? e.message.slice(0, 200) : e}`,
      );
    }
  }

  async function write(run: Run, expected: number): Promise<Run> {
    await mkdir(runsDir, { recursive: true });
    const file = fileOf(run.id);
    const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    const handle = await open(tmp, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(run, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      const current = await read(run.id).catch(() => null);
      if ((current?.revision ?? 0) !== expected)
        throw new Error(`run ${run.id} changed underneath this write`);
      await rename(tmp, file);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    return run;
  }

  return {
    root,
    runsDir,
    archiveDir: (id: string) => path.join(root, "archive", assertRunId(id)),
    get: read,

    async list(): Promise<Run[]> {
      const names = await readdir(runsDir).catch(() => [] as string[]);
      const out: Run[] = [];
      for (const name of names.filter((n) => n.endsWith(".json"))) {
        const id = name.slice(0, -".json".length);
        try {
          const run = await read(id);
          if (run) out.push(run);
        } catch (error) {
          onBroken?.(id, error instanceof Error ? error.message : String(error));
        }
      }
      return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async create(run: Run): Promise<Run> {
      if (await read(run.id)) throw new Error(`run ${run.id} already exists`);
      return write({ ...run, revision: 1 }, 0);
    },

    /** Read, change and rewrite one Run. */
    async update(id: string, change: (run: Run) => Run): Promise<Run> {
      const current = await read(id);
      if (!current) throw new Error(`run ${id} is missing`);
      return write({ ...change(current), revision: current.revision + 1 }, current.revision);
    },

    async remove(id: string): Promise<void> {
      await rm(fileOf(id), { force: true });
    },
  };
}

export type RunStore = ReturnType<typeof createRunStore>;

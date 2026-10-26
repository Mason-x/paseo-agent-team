import { createHash } from "node:crypto";
import path from "node:path";
import { type Job, JobSchema } from "../../shared/version";
import type { FilesPort } from "./process";

export type LockRecord = {
  jobId: string;
  ownerPid: number;
  acquiredAt: string;
};

export type VersionStore = {
  root: string;
  readJob(jobId: string): Promise<Job | null>;
  writeJob(job: Job): Promise<void>;
  rememberRequest(requestId: string, jobId: string): Promise<void>;
  jobForRequest(requestId: string): Promise<string | null>;
  readLatest(): Promise<Job | null>;
  writeLatest(jobId: string): Promise<void>;
  tryLock(record: LockRecord): Promise<boolean>;
  readLock(): Promise<LockRecord | null>;
  unlock(jobId: string): Promise<void>;
  jobDir(jobId: string): string;
};

export function storeRoot(home: string, serverId: string): string {
  const hash = createHash("sha256")
    .update(`${serverId}\0paseo-agent-team`)
    .digest("hex")
    .slice(0, 24);
  return path.join(home, "agent-team-runtime", "v1", hash, "updates");
}

export function createStore(files: FilesPort, root: string): VersionStore {
  const jobPath = (jobId: string) => path.join(root, "jobs", jobId, "status.json");
  return {
    root,
    jobDir(jobId) {
      return path.join(root, "jobs", jobId);
    },
    async readJob(jobId) {
      if (!isId(jobId)) return null;
      return readJson(files, jobPath(jobId), JobSchema);
    },
    async writeJob(job) {
      await files.writeAtomic(jobPath(job.id), `${JSON.stringify(job)}\n`);
    },
    async rememberRequest(requestId, jobId) {
      await files.writeAtomic(
        path.join(root, "requests", `${requestId}.json`),
        `${JSON.stringify({ jobId })}\n`,
      );
    },
    async jobForRequest(requestId) {
      if (!isId(requestId)) return null;
      const parsed = await readJson(files, path.join(root, "requests", `${requestId}.json`), {
        parse: (value: unknown) => value,
      });
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !("jobId" in parsed) ||
        typeof parsed.jobId !== "string"
      )
        return null;
      return isId(parsed.jobId) ? parsed.jobId : null;
    },
    async readLatest() {
      const pointer = await readJson(files, path.join(root, "latest.json"), {
        parse: (value: unknown) => value,
      });
      if (
        !pointer ||
        typeof pointer !== "object" ||
        !("jobId" in pointer) ||
        typeof pointer.jobId !== "string"
      ) {
        return null;
      }
      return isId(pointer.jobId) ? readJson(files, jobPath(pointer.jobId), JobSchema) : null;
    },
    async writeLatest(jobId) {
      await files.writeAtomic(path.join(root, "latest.json"), `${JSON.stringify({ jobId })}\n`);
    },
    async tryLock(record) {
      return files.exclusiveCreate(path.join(root, "active.lock"), `${JSON.stringify(record)}\n`);
    },
    async readLock() {
      const parsed = await readJson(files, path.join(root, "active.lock"), {
        parse: (value: unknown) => value,
      });
      if (!parsed || typeof parsed !== "object") return null;
      if (!("jobId" in parsed) || typeof parsed.jobId !== "string" || !isId(parsed.jobId))
        return null;
      if (!("ownerPid" in parsed) || typeof parsed.ownerPid !== "number") return null;
      if (!("acquiredAt" in parsed) || typeof parsed.acquiredAt !== "string") return null;
      return { jobId: parsed.jobId, ownerPid: parsed.ownerPid, acquiredAt: parsed.acquiredAt };
    },
    async unlock(jobId) {
      const current = await this.readLock();
      if (current && current.jobId !== jobId) return;
      await files.remove(path.join(root, "active.lock"));
    },
  };
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isId(value: string): boolean {
  return ID.test(value);
}

async function readJson<T>(
  files: FilesPort,
  target: string,
  schema: { parse(value: unknown): T },
): Promise<T | null> {
  try {
    const text = await files.readText(target, 1024 * 1024);
    return schema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

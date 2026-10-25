import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
export const STEP_TIMEOUT_MS = 15_000;

export type ExecRequest = {
  file: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export type ExecResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
};

export type ExecPort = {
  run(request: ExecRequest): Promise<ExecResult>;
};

export type FilesPort = {
  readText(path: string, maxBytes: number): Promise<string>;
  writeAtomic(path: string, text: string): Promise<void>;
  exclusiveCreate(path: string, text: string): Promise<boolean>;
  remove(path: string): Promise<void>;
};

export type Clock = {
  now(): number;
  iso(): string;
};

export type Ids = {
  uuid(): string;
};

export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    iso: () => new Date().toISOString(),
  };
}

export function systemIds(): Ids {
  return { uuid: () => randomUUID() };
}

/** argv-only spawn. Never sets shell. Caps captured bytes and kills on timeout. */
export function nodeExec(): ExecPort {
  return {
    run(request) {
      return new Promise((resolve, reject) => {
        const child = spawn(request.file, [...request.args], {
          cwd: request.cwd,
          env: request.env,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const limit = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
        let stdout = "";
        let stderr = "";
        let truncated = false;
        const take = (chunk: Buffer, current: string) => {
          const next = current + chunk.toString("utf8");
          if (next.length > limit) {
            truncated = true;
            return next.slice(0, limit);
          }
          return next;
        };
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout = take(chunk, stdout);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr = take(chunk, stderr);
        });
        let timedOut = false;
        const timer =
          request.timeoutMs && request.timeoutMs > 0
            ? setTimeout(() => {
                timedOut = true;
                child.kill();
              }, request.timeoutMs)
            : undefined;
        child.once("error", (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        });
        child.once("close", (exitCode) => {
          if (timer) clearTimeout(timer);
          resolve({ exitCode, stdout, stderr, timedOut, truncated });
        });
      });
    },
  };
}

export function nodeFiles(): FilesPort {
  return {
    async readText(path, maxBytes) {
      const text = await readFile(path, "utf8");
      if (Buffer.byteLength(text) > maxBytes) throw new Error("file exceeds size limit");
      return text;
    },
    async writeAtomic(file, text) {
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, text, "utf8");
      await rename(temporary, file);
    },
    async exclusiveCreate(file, text) {
      await mkdir(path.dirname(file), { recursive: true });
      try {
        const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
        try {
          await handle.writeFile(text, "utf8");
        } finally {
          await handle.close();
        }
        return true;
      } catch (error) {
        if (isErrno(error, "EEXIST")) return false;
        throw error;
      }
    },
    async remove(path) {
      await rm(path, { force: true });
    },
  };
}

export function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

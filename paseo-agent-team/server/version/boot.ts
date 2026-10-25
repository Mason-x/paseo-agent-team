import { spawn } from "node:child_process";
import path from "node:path";
import { asSha } from "./git";
import { type FilesPort, nodeFiles } from "./process";
import { createStore, storeRoot } from "./store";

const SERVER_ID = "server-id";

/**
 * Called when a reloaded plugin starts. Confirms a waiting update without a client RPC.
 *
 * Directory installs read `request.pluginDir`, which stays put across the fast-forward.
 * A managed install moves to a new checkout and deletes the old one, so this still reads the
 * pre-update path and cannot confirm that update. Managed one-click updates stop at
 * `cli_missing` before a runner exists; opening that path needs the new process to report
 * its own directory.
 */
export async function confirmPendingBoot(input: {
  env?: NodeJS.ProcessEnv;
  files?: FilesPort;
  platform?: NodeJS.Platform;
  bootId: string;
  log?: (message: string) => void;
  gitPath?: string;
  gitTimeoutMs?: number;
}): Promise<void> {
  const env = input.env ?? process.env;
  const files = input.files ?? nodeFiles();
  const log = input.log ?? ((message) => console.error(message));
  try {
    const home = env.PASEO_HOME;
    if (!home || !path.isAbsolute(home)) return;
    const serverId = (await readText(files, path.join(home, SERVER_ID)))?.trim();
    if (!serverId) return;
    const store = createStore(files, storeRoot(home, serverId));
    const lock = await store.readLock();
    if (!lock) return;
    const job = await store.readJob(lock.jobId);
    if (
      job?.state !== "running" ||
      !["reloading", "verifying_runtime", "rolling_back"].includes(job.phase)
    )
      return;
    const requestText = await readText(files, path.join(store.jobDir(lock.jobId), "request.json"));
    if (!requestText) return;
    const request = JSON.parse(requestText) as { pluginDir?: string };
    if (!request.pluginDir) return;
    const packageText = await readText(files, path.join(request.pluginDir, "package.json"));
    const packageVersion = packageText ? readPackageVersion(packageText) : null;
    const commit = await gitHead(request.pluginDir, env, input.gitPath, input.gitTimeoutMs);
    await files.writeAtomic(
      path.join(store.root, "boot.json"),
      `${JSON.stringify({
        bootId: input.bootId,
        packageVersion,
        commit,
        observedAt: new Date().toISOString(),
      })}\n`,
    );
  } catch (error) {
    log(
      `version boot confirmation skipped: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

async function readText(files: FilesPort, file: string): Promise<string | null> {
  try {
    return await files.readText(file, 1024 * 1024);
  } catch {
    return null;
  }
}

function readPackageVersion(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function gitHead(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  gitPath = "git",
  timeoutMs = 5_000,
): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const child = spawn(gitPath, ["rev-parse", "HEAD"], {
    cwd,
    env: gitEnv(env),
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let stdout = "";
  let settled = false;
  const finish = (value: string | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(value);
  };
  const timer = setTimeout(() => {
    child.kill();
    finish(null);
  }, timeoutMs);
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.once("error", () => finish(null));
  child.once("close", (code) => finish(code === 0 ? asSha(stdout.trim()) : null));
  return promise;
}

function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {
    ...env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
  };
  for (const key of Object.keys(next)) {
    if (
      key === "GIT_DIR" ||
      key === "GIT_WORK_TREE" ||
      key === "GIT_INDEX_FILE" ||
      key === "GIT_OBJECT_DIRECTORY" ||
      key === "GIT_ALTERNATE_OBJECT_DIRECTORIES" ||
      key === "GIT_COMMON_DIR" ||
      key === "GIT_NAMESPACE" ||
      key === "GIT_CONFIG" ||
      key === "GIT_CONFIG_COUNT" ||
      key === "GIT_CONFIG_GLOBAL" ||
      key === "GIT_CONFIG_SYSTEM" ||
      key.startsWith("GIT_CONFIG_KEY_") ||
      key.startsWith("GIT_CONFIG_VALUE_")
    ) {
      delete next[key];
    }
  }
  return next;
}

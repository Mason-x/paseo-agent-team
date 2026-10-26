// Detached update runner. Node built-ins only. Copied out of the plugin tree before spawn
// so a plugin reload can stop the parent without stopping this process.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN_ID = "paseo-agent-team";
const VERIFY_TIMEOUT_MS = 90_000;
const STEP_TIMEOUT_MS = 15_000;
const NPM_TIMEOUT_MS = 10 * 60 * 1000;
const APPLY_TIMEOUT_MS = 6 * 60 * 1000;

const strippedGit = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
];

export async function main(argv = process.argv.slice(2), io = process) {
  if (argv.includes("--self-test")) {
    io.stdout.write("ok\n");
    return 0;
  }
  const requestFlag = argv.indexOf("--request");
  const requestPath = requestFlag >= 0 ? argv[requestFlag + 1] : "";
  if (!requestPath) {
    io.stderr.write("missing --request\n");
    return 2;
  }
  try {
    const request = JSON.parse(readFileSync(requestPath, "utf8"));
    await runRequest(request);
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : "runner failed"}\n`);
    return 1;
  }
}

export async function runRequest(request, deps = {}) {
  const root = storeRoot(request.home, request.serverId);

  const jobFile = path.join(root, "jobs", request.jobId, "status.json");
  const state = new JobFile(
    jobFile,
    path.join(root, "latest.json"),
    path.join(root, "active.lock"),
  );
  const job = state.read();
  const ports = { ...defaultPorts(deps), root };
  try {
    if (request.mode === "managed-git") await runManaged(request, job, state, ports);
    else await runDirectory(request, job, state, ports);
  } catch (error) {
    const message = error instanceof Error ? error.message : "runner failed";
    state.write(job, {
      state: "recovery_required",
      phase: "reconciling",
      rollback: "unsafe",
      error: block("command_failed", "inspect_recovery", message),
      finished: true,
      now: ports.now(),
    });
  }
}

async function runDirectory(request, job, state, ports) {
  job = state.write(job, { state: "running", phase: "preflight", now: ports.now() });
  const preflight = await directoryPreflight(request, ports);
  if (preflight) return stop(state, job, "blocked", "preflight", preflight, "not-needed", ports);

  job = state.write(job, { state: "running", phase: "fetching", now: ports.now() });
  const remote = await verifiedRemote(request, ports);
  if (!remote.ok)
    return stop(state, job, "blocked", "fetching", remote.blocker, "not-needed", ports);
  const fetched = await gitWrite(
    ports,
    request.repositoryPath,
    [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--refmap=",
      remote.name,
      `${request.targetRef}:refs/agent-team-updates/${request.jobId}/target`,
    ],
    STEP_TIMEOUT_MS,
  );
  if (!fetched.ok)
    return stop(state, job, "failed", "fetching", fetched.blocker, "not-needed", ports);

  job = state.write(job, { state: "running", phase: "verifying_target", now: ports.now() });
  const sha = await gitText(ports, request.repositoryPath, [
    "rev-parse",
    `refs/agent-team-updates/${request.jobId}/target`,
  ]);
  if (sha !== request.targetSha) {
    return stop(
      state,
      job,
      "failed",
      "verifying_target",
      block("target_changed", "retry_check", "fetched object is not the checked commit"),
      "not-needed",
      ports,
    );
  }
  const relation = await ancestry(
    ports,
    request.repositoryPath,
    request.fromCommit,
    request.targetSha,
  );
  if (relation !== "behind") {
    return stop(
      state,
      job,
      "failed",
      "verifying_target",
      block("unrelated", "reconcile_commits", `fetched commit is ${relation}`),
      "not-needed",
      ports,
    );
  }
  const again = await directoryPreflight(request, ports);
  if (again) return stop(state, job, "blocked", "verifying_target", again, "not-needed", ports);

  job = state.write(job, { state: "running", phase: "fast_forwarding", now: ports.now() });
  const hooks = path.join(path.dirname(state.jobFile), "hooks");
  mkdirSync(hooks, { recursive: true });
  const merged = await gitWrite(
    ports,
    request.repositoryPath,
    ["-c", `core.hooksPath=${hooks}`, "merge", "--ff-only", "--no-autostash", request.targetSha],
    STEP_TIMEOUT_MS,
  );
  if (!merged.ok)
    return stop(state, job, "failed", "fast_forwarding", merged.blocker, "not-needed", ports);

  job = state.write(job, {
    state: "running",
    phase: "installing",
    rollback: "pending",
    now: ports.now(),
  });
  const installed = await npmCi(request, ports);
  if (!installed.ok) return rollback(request, job, state, ports, installed.blocker);

  job = state.write(job, { state: "running", phase: "reloading", now: ports.now() });
  const reloaded = await paseo(
    request,
    ports,
    ["plugin", "reload", PLUGIN_ID, "--json", "--home", request.home],
    60_000,
  );
  if (!reloaded.ok) return rollback(request, job, state, ports, reloaded.blocker);

  job = state.write(job, { state: "running", phase: "verifying_runtime", now: ports.now() });
  const runtime = await waitForRuntime(request, ports, true);
  if (!runtime.ok) return rollback(request, job, state, ports, runtime.blocker);
  await deletePrivateRef(request, ports);
  return stop(state, job, "succeeded", "done", null, "not-needed", ports);
}

async function runManaged(request, job, state, ports) {
  job = state.write(job, { state: "running", phase: "applying_managed", now: ports.now() });
  const applied = await paseo(
    request,
    ports,
    [
      "plugin",
      "update",
      PLUGIN_ID,
      "--ref",
      request.targetSha,
      "--yes",
      "--json",
      "--home",
      request.home,
    ],
    APPLY_TIMEOUT_MS,
  );
  if (!applied.ok) {
    const listed = await listPlugin(request, ports);
    if (listed.running && listed.revision === request.fromCommit) {
      return stop(
        state,
        job,
        "rolled_back",
        "done",
        block("command_failed", "retry_check", applied.blocker.detail),
        "not-needed",
        ports,
      );
    }
    return hold(state, job, "apply_outcome_unknown", applied.blocker.detail, ports);
  }
  job = state.write(job, { state: "running", phase: "verifying_runtime", now: ports.now() });
  const runtime = await waitForRuntime(request, ports, false);
  if (!runtime.ok) return hold(state, job, "runtime_verify_failed", runtime.blocker.detail, ports);
  return stop(state, job, "succeeded", "done", null, "not-needed", ports);
}

async function rollback(request, job, state, ports, cause) {
  job = state.write(job, {
    state: "running",
    phase: "rolling_back",
    rollback: "pending",
    now: ports.now(),
  });
  const head = await gitText(ports, request.repositoryPath, ["rev-parse", "HEAD"]);
  const status = await ports.git(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=no"],
    request.repositoryPath,
    STEP_TIMEOUT_MS,
  );
  const clean =
    status.exitCode === 0 &&
    status.stdout
      .split("\0")
      .every((row) => row.length === 0 || ignoredInstallRow(row, request.pluginSubpath));
  if (head !== request.targetSha || !clean) {
    return hold(state, job, "concurrent_local_change", cause.detail, ports);
  }
  const reset = await gitWrite(
    ports,
    request.repositoryPath,
    ["reset", "--keep", request.fromCommit],
    STEP_TIMEOUT_MS,
  );
  if (!reset.ok) return hold(state, job, "rollback_failed", reset.blocker.detail, ports);
  const reinstalled = await npmCi(request, ports);
  if (!reinstalled.ok)
    return hold(state, job, reinstalled.blocker.code, reinstalled.blocker.detail, ports);
  const reloaded = await paseo(
    request,
    ports,
    ["plugin", "reload", PLUGIN_ID, "--json", "--home", request.home],
    60_000,
  );
  if (!reloaded.ok) return hold(state, job, reloaded.blocker.code, reloaded.blocker.detail, ports);
  const runtime = await waitForRuntime(
    { ...request, targetSha: request.fromCommit, targetVersion: request.fromVersion ?? "" },
    ports,
    true,
  );
  if (!runtime.ok) return hold(state, job, runtime.blocker.code, runtime.blocker.detail, ports);
  return stop(state, job, "rolled_back", "done", cause, "restored", ports);
}

async function directoryPreflight(request, ports) {
  if (
    !request.repositoryPath ||
    !isSha(request.fromCommit) ||
    !isSha(request.targetSha) ||
    !request.remoteUrl ||
    !safeRef(request.targetRef)
  ) {
    return block(
      "unsupported_checkout",
      "manual_update",
      "directory update is missing a repository, remote, or commit",
    );
  }
  const top = await gitText(ports, request.pluginDir, ["rev-parse", "--show-toplevel"]);
  if (!top || path.resolve(top) !== path.resolve(request.repositoryPath)) {
    return block("path_invalid", "inspect_recovery", "plugin directory left its repository");
  }
  const status = await ports.git(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    request.repositoryPath,
    STEP_TIMEOUT_MS,
  );
  if (status.exitCode !== 0) return block("repository_busy", "retry_check", "git status failed");
  if (status.stdout.split("\0").some((row) => row.length > 0)) {
    return block("dirty", "inspect_local_changes", "worktree changed before fast-forward");
  }
  const branch = await gitText(ports, request.repositoryPath, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  if (!branch || branch === "HEAD")
    return block("detached_head", "switch_tracking_branch", "HEAD is detached");
  const upstream = await ports.git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    request.repositoryPath,
    STEP_TIMEOUT_MS,
  );
  if (upstream.exitCode !== 0)
    return block("no_upstream", "switch_tracking_branch", "branch has no upstream");
  const head = await gitText(ports, request.repositoryPath, ["rev-parse", "HEAD"]);
  if (head !== request.fromCommit) return block("target_changed", "retry_check", "HEAD moved");
  const present = await ports.git(
    ["cat-file", "-e", `${request.targetSha}^{commit}`],
    request.repositoryPath,
    STEP_TIMEOUT_MS,
  );
  if (present.exitCode !== 0) return null;
  const relation = await ancestry(
    ports,
    request.repositoryPath,
    request.fromCommit,
    request.targetSha,
  );
  if (relation === "behind") return null;
  const code =
    relation === "ahead" ? "local_ahead" : relation === "diverged" ? "diverged" : "unrelated";
  return block(code, "reconcile_commits", `local commit is ${relation} the target`);
}

async function ancestry(ports, cwd, head, target) {
  if (head === target) return "equal";
  const forward = await ports.git(
    ["merge-base", "--is-ancestor", head, target],
    cwd,
    STEP_TIMEOUT_MS,
  );
  if (forward.exitCode === 0) return "behind";
  const reverse = await ports.git(
    ["merge-base", "--is-ancestor", target, head],
    cwd,
    STEP_TIMEOUT_MS,
  );
  if (reverse.exitCode === 0) return "ahead";
  const counts = await ports.git(
    ["rev-list", "--left-right", "--count", `${head}...${target}`],
    cwd,
    STEP_TIMEOUT_MS,
  );
  if (counts.exitCode !== 0) return "unknown";
  const match = counts.stdout.trim().match(/^(\d+)\s+(\d+)$/);
  if (!match) return "unknown";
  if (match[1] === "0" && match[2] === "0") return "unrelated";
  return "diverged";
}

async function npmCi(request, ports) {
  const npm = request.npmCli;
  if (!npm || !String(npm).trim())
    return {
      ok: false,
      blocker: block("npm_missing", "install_npm", "npm cli was not resolved before the update"),
    };
  const result = await ports.exec(
    request.nodePath,
    [npm, "ci", "--include=dev", "--prefix", request.pluginDir],
    {
      cwd: request.pluginDir,
      env: npmEnvironment(process.env),
      timeoutMs: NPM_TIMEOUT_MS,
    },
  );
  if (result.exitCode !== 0) {
    return {
      ok: false,
      blocker: block(
        "command_failed",
        "inspect_recovery",
        redact(trim(result.stderr)) || "npm ci failed",
      ),
    };
  }
  return { ok: true };
}

async function paseo(request, ports, args, timeoutMs) {
  const result = await ports.exec(request.nodePath, [request.cliEntry, ...args], {
    env: { ...process.env, PASEO_HOME: request.home },
    timeoutMs,
  });
  if (result.exitCode !== 0)
    return {
      ok: false,
      blocker: block(
        "command_failed",
        "inspect_recovery",
        redact(trim(result.stderr)) || redact(trim(result.stdout)) || "paseo command failed",
      ),
    };
  return { ok: true };
}

async function listPlugin(request, ports) {
  const result = await ports.exec(
    request.nodePath,
    [request.cliEntry, "plugin", "ls", PLUGIN_ID, "--json", "--home", request.home],
    {
      env: { ...process.env, PASEO_HOME: request.home },
      timeoutMs: STEP_TIMEOUT_MS,
    },
  );
  if (result.exitCode !== 0) return { running: false, revision: null };
  try {
    const value = JSON.parse(result.stdout);
    const item = Array.isArray(value) ? value[0] : value;
    return {
      running: item?.status === "running" && !item?.error,
      revision: item?.installation?.currentRevision ?? null,
    };
  } catch {
    return { running: false, revision: null };
  }
}

async function waitForRuntime(request, ports, expectHead) {
  const bootFile = path.join(storeRoot(request.home, request.serverId), "boot.json");
  const timeoutMs = ports.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS;
  const intervalMs = ports.intervalMs ?? 750;
  const started = Date.now();
  let polls = 0;
  while (Date.now() - started <= timeoutMs && polls < (ports.attempts ?? 1_000_000)) {
    polls += 1;
    let boot = ports.readBoot ? ports.readBoot() : null;
    if (!boot) {
      try {
        boot = JSON.parse(readFileSync(bootFile, "utf8"));
      } catch {
        boot = null;
      }
    }
    if (
      boot?.bootId &&
      boot.bootId !== request.oldBootId &&
      boot.commit === request.targetSha &&
      boot.packageVersion === request.targetVersion
    ) {
      const listed = await listPlugin(request, ports);
      const head = expectHead
        ? await gitText(ports, request.repositoryPath, ["rev-parse", "HEAD"])
        : request.targetSha;
      if (listed.running && head === request.targetSha) return { ok: true };
    }
    if (polls >= (ports.attempts ?? 1_000_000) || Date.now() - started + intervalMs > timeoutMs)
      break;
    await ports.sleep(intervalMs);
  }
  return {
    ok: false,
    blocker: block(
      "runtime_verify_failed",
      "inspect_recovery",
      "new plugin process did not confirm the target",
    ),
  };
}

async function gitWrite(ports, cwd, args, timeoutMs) {
  if (forbidden(args))
    return {
      ok: false,
      blocker: block("command_failed", "inspect_recovery", "refusing a destructive git argument"),
    };
  const result = await ports.git(args, cwd, timeoutMs);
  if (result.exitCode !== 0)
    return {
      ok: false,
      blocker: block(
        "command_failed",
        "inspect_recovery",
        redact(trim(result.stderr)) || `git ${args[0]} failed`,
      ),
    };
  return { ok: true };
}

async function verifiedRemote(request, ports) {
  const listed = await ports.git(["remote"], request.repositoryPath, STEP_TIMEOUT_MS);
  const names =
    listed.exitCode === 0
      ? listed.stdout
          .split(/\r?\n/)
          .map((name) => name.trim())
          .filter(Boolean)
      : [];
  for (const name of names) {
    const url = await ports.git(
      ["remote", "get-url", name],
      request.repositoryPath,
      STEP_TIMEOUT_MS,
    );
    if (url.exitCode === 0 && redact(url.stdout.trim()) === redact(request.remoteUrl))
      return { ok: true, name };
  }
  return {
    ok: false,
    blocker: block(
      "no_remote",
      "manual_update",
      "checked remote is not configured on this repository",
    ),
  };
}

function ignoredInstallRow(row, pluginSubpath) {
  const pathText = row.slice(3).replaceAll("\\", "/");
  const relative = String(pluginSubpath ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
  return (
    pathText.startsWith(`${relative}/node_modules/`) || pathText === `${relative}/node_modules`
  );
}

function npmEnvironment(env) {
  const next = { ...env };
  for (const key of [
    "NODE_OPTIONS",
    "NODE_ENV",
    "npm_config_omit",
    "npm_config_production",
    "NPM_CONFIG_OMIT",
    "NPM_CONFIG_PRODUCTION",
  ])
    delete next[key];
  return next;
}

function redact(value) {
  return String(value ?? "").replace(/\/\/[^/\s]+@/g, "//");
}

async function deletePrivateRef(request, ports) {
  await ports.git(
    ["update-ref", "-d", `refs/agent-team-updates/${request.jobId}/target`],
    request.repositoryPath,
    STEP_TIMEOUT_MS,
  );
}

async function gitText(ports, cwd, args) {
  const result = await ports.git(args, cwd, STEP_TIMEOUT_MS);
  return result.exitCode === 0 ? result.stdout.replace(/\0/g, "").trim() : null;
}

function stop(state, job, nextState, phase, error, rollback, ports) {
  const written = state.write(job, {
    state: nextState,
    phase,
    error,
    rollback,
    finished: true,
    now: ports.now(),
  });
  if (nextState !== "recovery_required") state.unlock(job.id);
  return written;
}

function hold(state, job, code, detail, ports) {
  state.write(job, {
    state: "recovery_required",
    phase: "reconciling",
    error: block(code, "inspect_recovery", detail),
    rollback: "unsafe",
    finished: true,
    now: ports.now(),
  });
}

class JobFile {
  constructor(jobFile, latestFile, lockFile) {
    this.jobFile = jobFile;
    this.latestFile = latestFile;
    this.lockFile = lockFile;
  }
  read() {
    return JSON.parse(readFileSync(this.jobFile, "utf8"));
  }
  write(job, patch) {
    const next = {
      ...job,
      state: patch.state,
      phase: patch.phase,
      rollback: patch.rollback ?? job.rollback,
      error: patch.error === undefined ? job.error : patch.error,
      seq: job.seq + 1,
      updatedAt: patch.now,
      finishedAt: patch.finished ? patch.now : job.finishedAt,
    };
    const temporary = `${this.jobFile}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next)}\n`);
    renameSync(temporary, this.jobFile);
    const latest = `${this.latestFile}.${process.pid}.tmp`;
    writeFileSync(latest, `${JSON.stringify({ jobId: job.id })}\n`);
    renameSync(latest, this.latestFile);
    return next;
  }
  unlock(jobId) {
    try {
      const current = JSON.parse(readFileSync(this.lockFile, "utf8"));
      if (current.jobId === jobId) rmSync(this.lockFile);
    } catch {
      // A missing lock is already released.
    }
  }
}

function storeRoot(home, serverId) {
  const hash = createHash("sha256")
    .update(`${serverId}\0paseo-agent-team`)
    .digest("hex")
    .slice(0, 24);
  return path.join(home, "agent-team-runtime", "v1", hash, "updates");
}
export function defaultPorts(deps = {}) {
  return {
    git: deps.git ?? ((args, cwd, timeoutMs) => runGit(args, cwd, timeoutMs)),
    exec: deps.exec ?? ((file, args, options) => runProcess(file, args, options)),
    now: deps.now ?? (() => new Date().toISOString()),
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    attempts: deps.attempts ?? Math.ceil(VERIFY_TIMEOUT_MS / 250),
    readBoot: deps.readBoot ?? (() => null),
    verifyTimeoutMs: deps.verifyTimeoutMs,
    intervalMs: deps.intervalMs,
  };
}

function runGit(args, cwd, timeoutMs) {
  const env = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
  };
  for (const key of Object.keys(env)) {
    if (
      strippedGit.includes(key) ||
      key.startsWith("GIT_CONFIG_KEY_") ||
      key.startsWith("GIT_CONFIG_VALUE_")
    )
      delete env[key];
  }
  return runProcess("git", args, { cwd, env, timeoutMs });
}

function runProcess(file, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk.toString("utf8")).slice(0, 1024 * 1024);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(0, 256 * 1024);
    });
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? STEP_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout, stderr: error.message });
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function block(code, remedy, detail) {
  return { code, remedy, detail: detail ? String(detail).slice(0, 2000) : null };
}

function forbidden(args) {
  return args.some(
    (arg) =>
      arg === "--hard" || arg === "--force" || arg === "-f" || arg === "stash" || arg === "clean",
  );
}

function safeRef(value) {
  if (!value || value.startsWith("-") || value.includes("..")) return false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || " ~^:?*[\\".includes(char)) return false;
  }
  return true;
}

function isSha(value) {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function trim(value) {
  return String(value ?? "")
    .trim()
    .slice(0, 500);
}

export function npmCli(nodePath) {
  return path.join(path.dirname(nodePath), "node_modules", "npm", "bin", "npm-cli.js");
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "runner failed"}\n`);
      process.exitCode = 1;
    });
}

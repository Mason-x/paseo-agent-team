import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PaseoPort } from "../../shared/paseo/port";
import {
  type Blocker,
  blocker,
  CHECK_STEP_TIMEOUT_MS,
  CHECK_TOTAL_TIMEOUT_MS,
  CHECK_TTL_MS,
  type Current,
  type InstallSource,
  type Job,
  JobSchema,
  type PendingCommits,
  PLUGIN_ID,
  type Relation,
  type RemoteTarget,
  type StartResult,
  type VersionInfo,
  VersionInfoSchema,
} from "../../shared/version";
import { manualUpdateCommand, type ResolvedCli, resolveCliEntry } from "./cli";
import { decideUpdate } from "./decide";
import { asSha, createGit, type GitPort, gitOk, gitText } from "./git";
import {
  type Checkout,
  classifyManagedPath,
  currentSnapshot,
  inspectCheckout,
  installSourceFor,
  parseInstalledPackage,
  parseSources,
  readConfiguredPlugin,
  readOptional,
  resolveExplicitHome,
  type SourceRecord,
  safeRealpath,
} from "./local-install";
import { resolveNpmCli } from "./npm";
import {
  isPrivateRef,
  PENDING_CLEANUP_BUDGET_MS,
  PENDING_CLEANUP_RESERVE_MS,
  PENDING_COMMITS_BUDGET_MS,
  PENDING_OUTER_MARGIN_MS,
  privateRefFor,
  readPendingCommits,
} from "./pending";
import type { Clock, ExecPort, FilesPort, Ids } from "./process";
import { nodeExec, nodeFiles, systemClock, systemIds } from "./process";
import {
  allowedRemote,
  ancestry,
  branchTarget,
  type FetchLike,
  listTags,
  objectPresent,
  parseLsRemoteTags,
  parsePackage,
  parseSymrefHead,
  pluginPackagePath,
  readDefaultBranch,
  readGithubPackage,
  releaseTarget,
  selectReleaseTag,
  stripCredentials,
} from "./remote";
import { createStore, storeRoot, type VersionStore } from "./store";

export type VersionDeps = {
  env: NodeJS.ProcessEnv;
  files: FilesPort;
  exec: ExecPort;
  git: GitPort;
  clock: Clock;
  ids: Ids;
  fetch: FetchLike;
  bootId: string;
  spawnRunner?: (requestFile: string, home: string) => Promise<void>;
  runnerSource?: string;
  platform?: NodeJS.Platform;
  pathExists?: (candidate: string) => boolean;
  cliExists?: (candidate: string) => Promise<boolean>;
  now?: () => number;
};

export type VersionService = {
  bootId: string;
  get(paseo: Pick<PaseoPort, "config">): Promise<{ info: VersionInfo; job: Job | null }>;
  check(paseo: Pick<PaseoPort, "config">, requestId: string): Promise<StartResult>;
  startUpdate(
    paseo: Pick<PaseoPort, "config">,
    requestId: string,
    checkId: string,
  ): Promise<StartResult>;
  status(jobId?: string): Promise<{ job: Job | null }>;
  runtime(paseo: Pick<PaseoPort, "config">): Promise<{
    protocol: 1;
    pluginId: "paseo-agent-team";
    bootId: string;
    packageVersion: string | null;
    commit: string | null;
  }>;
  confirmBoot(paseo: Pick<PaseoPort, "config">): Promise<void>;
};

type SavedCheck = {
  id: string;
  savedAt: string;
  info: VersionInfo;
  remoteUrl: string | null;
  targetRef: string | null;
  pluginSubpath: string;
  serverId: string;
};

type Memory = Map<string, { job: Job; check: SavedCheck | null }>;

type Discovery = {
  info: VersionInfo;
  current: Current;
  installSource: InstallSource;
  checkout: Checkout | null;
  cli: ResolvedCli;
  record: SourceRecord;
  remoteUrl: string | null;
  pluginSubpath: string;
};

export function createVersionService(overrides: Partial<VersionDeps> = {}): VersionService {
  const env = overrides.env ?? process.env;
  const files = overrides.files ?? nodeFiles();
  const exec = overrides.exec ?? nodeExec();
  const deps: VersionDeps = {
    env,
    files,
    exec,
    git: overrides.git ?? createGit(exec, env),
    clock: overrides.clock ?? systemClock(),
    ids: overrides.ids ?? systemIds(),
    fetch: overrides.fetch ?? ((url, init) => fetch(url, init)),
    bootId: overrides.bootId ?? systemIds().uuid(),
    spawnRunner: overrides.spawnRunner,
    runnerSource: overrides.runnerSource,
    platform: overrides.platform ?? process.platform,
    pathExists: overrides.pathExists,
    cliExists: overrides.cliExists,
    now: overrides.now,
  };
  const memory: Memory = new Map();
  return {
    bootId: deps.bootId,
    async get(paseo) {
      await writeBoot(deps, paseo);
      const local = await discover(deps, paseo);
      const job = (await persistedJob(deps)) ?? latest(memory, "update") ?? latest(memory, "check");
      const info = job?.kind === "check" && job.result ? job.result : local.info;
      return { info, job };
    },
    check: (paseo, requestId) => runCheck(deps, paseo, requestId, memory),
    startUpdate: (paseo, requestId, checkId) =>
      beginUpdate(deps, paseo, requestId, checkId, memory),
    async status(jobId) {
      return {
        job:
          (await persistedJob(deps, jobId)) ??
          (jobId
            ? (memory.get(jobId)?.job ?? null)
            : (latest(memory, "update") ?? latest(memory, "check"))),
      };
    },
    async runtime(paseo) {
      const local = await discover(deps, paseo);
      return {
        protocol: 1 as const,
        pluginId: PLUGIN_ID,
        bootId: deps.bootId,
        packageVersion: local.current.packageVersion,
        commit: local.current.commit,
      };
    },
    confirmBoot: (paseo) => writeBoot(deps, paseo),
  };
}

async function runCheck(
  deps: VersionDeps,
  paseo: Pick<PaseoPort, "config">,
  requestId: string,
  memory: Memory,
): Promise<StartResult> {
  const existing = await findRequest(deps, requestId, memory);
  if (existing) return { ok: true, job: existing };
  const running = [...memory.values()].find(
    (entry) => entry.job.kind === "check" && entry.job.state === "running",
  );
  if (running) return { ok: true, job: running.job };
  const local = await discover(deps, paseo);
  const job = newJob(deps, requestId, "check", "checking", local.current, null);
  memory.set(job.id, { job, check: null });
  try {
    const deadline = (deps.now ?? Date.now)() + CHECK_TOTAL_TIMEOUT_MS;
    const info = await withDeadline(inspectRemote(deps, local, deadline), CHECK_TOTAL_TIMEOUT_MS);
    const finished = finishCheck(deps, job, info);

    const check = info.checkId ? saveCheck(info.checkId, info, local, deps) : null;
    memory.set(job.id, { job: finished, check });
    if (check) await persistCheck(deps, finished, check);
    return { ok: true, job: finished };
  } catch (error) {
    const failed = finishCheck(
      deps,
      job,
      null,
      blocker(
        "command_failed",
        "retry_check",
        error instanceof Error ? error.message : "check failed",
      ),
    );
    memory.set(job.id, { job: failed, check: null });
    return { ok: true, job: failed };
  }
}

function finishCheck(
  deps: VersionDeps,
  job: Job,
  info: VersionInfo | null,
  error: Blocker | null = null,
): Job {
  return JobSchema.parse({
    ...job,
    state:
      info && !(info.remote.state === "error" && !info.remote.repositoryLatest)
        ? "succeeded"
        : "failed",
    phase: "done",
    seq: job.seq + 1,
    updatedAt: deps.clock.iso(),
    finishedAt: deps.clock.iso(),
    result: info,
    error: error ?? info?.remote.error ?? null,
  });
}

function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => reject(new Error("check timed out")), timeoutMs);
  void work.then(resolve, reject).finally(() => clearTimeout(timer));
  return promise;
}

async function beginUpdate(
  deps: VersionDeps,
  paseo: Pick<PaseoPort, "config">,
  requestId: string,
  checkId: string,
  memory: Memory,
): Promise<StartResult> {
  const existing = await findRequest(deps, requestId, memory);
  if (existing) return { ok: true, job: existing };
  const home = resolveExplicitHome(deps.env, deps.platform);
  if (!home.ok) return refused(home.blocker);
  const serverId = await readServerId(deps.files, home.home);
  if (!serverId) return refused(blocker("home_unavailable", "verify_host", "server id is missing"));
  const saved = await loadCheck(deps, home.home, serverId, checkId, memory);
  if (!saved) return refused(blocker("check_expired", "retry_check", "check was not found"));
  if (deps.clock.now() - Date.parse(saved.savedAt) > CHECK_TTL_MS) {
    return refused(blocker("check_expired", "retry_check", "check is older than 5 minutes"));
  }
  const target = saved.info.remote.installTarget;
  if (
    !saved.info.canUpdate ||
    !saved.info.updateAvailable ||
    !target?.commit ||
    !saved.remoteUrl ||
    !saved.targetRef
  ) {
    return refused(saved.info.blockers[0] ?? blocker("check_not_actionable", "retry_check"));
  }
  const local = await discover(deps, paseo);
  if (
    local.current.commit !== saved.info.current.commit ||
    local.current.pluginPath !== saved.info.current.pluginPath
  ) {
    return refused(
      blocker("target_changed", "retry_check", "installation changed since the check"),
    );
  }
  if (!local.current.pluginPath || !local.current.commit)
    return refused(blocker("path_invalid", "inspect_recovery"));
  if ("blocker" in local.cli) {
    const detail =
      local.installSource.kind === "git"
        ? manualUpdateCommand(home.home, target.commit)
        : local.cli.blocker.detail;
    return refused(blocker("cli_missing", "manual_update", detail));
  }
  const npm = await resolveNpmCli({
    exec: deps.exec,
    nodePath: process.execPath,
    env: deps.env,
    platform: deps.platform ?? process.platform,
  });
  if (!npm.ok) return refused(blocker("npm_missing", "install_npm", npm.detail));
  const root = storeRoot(home.home, serverId);
  const store = createStore(deps.files, root);
  const held = await store.readLock();
  if (held && !(await staleLock(store, held)))
    return refused(blocker("concurrent_update", "release_lock", lockDetail(store.root)));

  if (held) await store.unlock(held.jobId);
  const job = newJob(deps, requestId, "update", "preflight", local.current, target);
  await mkdir(store.jobDir(job.id), { recursive: true });
  await mkdir(path.join(root, "requests"), { recursive: true });
  if (
    !(await store.tryLock({ jobId: job.id, ownerPid: process.pid, acquiredAt: deps.clock.iso() }))
  ) {
    return refused(blocker("concurrent_update", "release_lock"));
  }
  try {
    await store.writeJob(job);
    await store.rememberRequest(requestId, job.id);
    await store.writeLatest(job.id);
    const runnerSource =
      deps.runnerSource ?? path.join(local.current.pluginPath, "server", "version", "runner.mjs");
    const runnerCopy = path.join(store.jobDir(job.id), "runner.mjs");
    const runnerText = await readOptional(deps.files, runnerSource, 1024 * 1024);
    if (!runnerText) throw new Error("runner script is missing");
    await deps.files.writeAtomic(runnerCopy, runnerText);
    const requestFile = path.join(store.jobDir(job.id), "request.json");
    await deps.files.writeAtomic(
      requestFile,
      `${JSON.stringify({
        schemaVersion: 1,
        jobId: job.id,
        home: home.home,
        serverId,
        pluginDir: local.current.pluginPath,
        repositoryPath: local.current.repositoryPath,
        remoteUrl: redactUrl(saved.remoteUrl),
        pluginSubpath: saved.pluginSubpath,
        mode: local.installSource.kind === "git" ? "managed-git" : "directory",
        fromCommit: local.current.commit,
        fromVersion: local.current.packageVersion,
        targetSha: target.commit,
        targetRef: saved.targetRef,
        targetVersion: target.version,
        oldBootId: deps.bootId,
        cliEntry: local.cli.entry,
        nodePath: npm.nodePath,
        npmCli: npm.cli,
      })}\n`,
    );
    const self = await deps.exec.run({
      file: process.execPath,
      args: [runnerCopy, "--self-test"],
      env: deps.env,
      timeoutMs: 10_000,
    });
    if (self.exitCode !== 0 || !self.stdout.includes("ok"))
      throw new Error("runner self-test failed");
    if (deps.spawnRunner) await deps.spawnRunner(requestFile, home.home);
    else await spawnDetached(process.execPath, runnerCopy, requestFile, home.home, deps.env);
    return { ok: true, job };
  } catch (error) {
    const reason = blocker(
      "worker_unavailable",
      "inspect_recovery",
      `${error instanceof Error ? error.message : "update failed to start"}\n${lockDetail(store.root)}`,
    );
    await failStart(store, deps, job, reason);
    return { ok: false, blockers: [reason], job: failedJob(deps, job, reason) };
  }
}

async function staleLock(
  store: VersionStore,
  held: { jobId: string; ownerPid: number },
): Promise<boolean> {
  const job = await store.readJob(held.jobId);
  if (job && ["succeeded", "failed", "blocked", "rolled_back"].includes(job.state)) return true;
  if (job?.state === "running" || job?.state === "recovery_required") return false;
  return !pidAlive(held.ownerPid);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lockDetail(root: string): string {
  return `Lock file: ${path.join(root, "active.lock")}. Stop the update process, then delete that file if its job is not running.`;
}

function redactUrl(value: string | null): string | null {
  return value ? value.replace(/\/\/[^/\s]+@/g, "//") : null;
}

async function discover(deps: VersionDeps, paseo: Pick<PaseoPort, "config">): Promise<Discovery> {
  const observedAt = deps.clock.iso();
  const blank = blankInfo(observedAt);
  const home = resolveExplicitHome(deps.env, deps.platform);
  if (!home.ok) return unknownDiscovery(blank, home.blocker);
  let config: unknown;
  try {
    config = (await paseo.config.get()).config;
  } catch {
    return unknownDiscovery(
      blank,
      blocker("installation_identity_unknown", "verify_host", "config read failed"),
    );
  }
  const configured = readConfiguredPlugin(config);
  if ("blocker" in configured) return unknownDiscovery(blank, configured.blocker);
  const pluginPath = safeRealpath(configured.path, deps.pathExists);
  if (!pluginPath)
    return unknownDiscovery(
      blank,
      blocker("path_invalid", "inspect_recovery", "plugin path does not exist"),
    );
  const packageText = await readOptional(
    deps.files,
    path.join(pluginPath, "package.json"),
    64 * 1024,
  );
  const manifestText = await readOptional(
    deps.files,
    path.join(pluginPath, "paseo-plugin.json"),
    64 * 1024,
  );
  if (!packageText || !manifestText)
    return unknownDiscovery(
      blank,
      blocker("path_invalid", "inspect_recovery", "plugin package is incomplete"),
    );
  const installed = parseInstalledPackage(packageText);
  if ("blocker" in installed) return unknownDiscovery(blank, installed.blocker);
  let manifestId = "";
  try {
    const manifest = JSON.parse(manifestText) as { id?: string };
    manifestId = manifest.id ?? "";
  } catch {
    manifestId = "";
  }
  if (manifestId !== PLUGIN_ID)
    return unknownDiscovery(
      blank,
      blocker("installation_identity_unknown", "verify_host", "manifest id does not match"),
    );
  const layout = classifyManagedPath(home.home, pluginPath);
  const record = parseSources(
    await readOptional(deps.files, path.join(home.home, "plugins", "sources.json"), 1024 * 1024),
  );
  const checkout =
    layout.kind === "directory"
      ? await inspectCheckout(deps.git, pluginPath, CHECK_STEP_TIMEOUT_MS)
      : null;
  const managedCommit = layout.kind === "git" ? await revParse(deps.git, pluginPath) : null;
  const installSource = installSourceFor({
    layout,
    record,
    pluginPath,
    isGit: Boolean(checkout?.repositoryPath),
    installedCommit: managedCommit,
    installedVersion: installed.version,
  });
  const blockers = [...(checkout?.blockers ?? [])];
  if (installSource.kind === "unknown") {
    blockers.push(
      blocker(
        "installation_identity_unknown",
        "verify_host",
        record.kind === "unreadable"
          ? "sources.json is unreadable"
          : "managed layout does not match its source record",
      ),
    );
  }
  if (installSource.kind === "npm" || (installSource.kind === "git" && installSource.registry)) {
    blockers.push(
      blocker(
        "unsupported_checkout",
        "manual_update",
        "npm and registry installs can be checked but not applied here",
      ),
    );
  }

  const cli = await resolveCliEntry(pluginPath, deps.cliExists);
  const current = currentSnapshot({
    packageVersion: installed.version,
    commit:
      installSource.kind === "git" ? installSource.installedCommit : (checkout?.commit ?? null),
    branch: checkout?.branch ?? null,
    dirty: checkout?.dirty ?? null,
    pluginPath,
    repositoryPath: checkout?.repositoryPath ?? null,
    observedAt,
  });
  const remoteUrl =
    installSource.kind === "git"
      ? installSource.remote
      : await originUrl(deps.git, checkout?.repositoryPath ?? null);
  return {
    info: VersionInfoSchema.parse({
      ...blank,
      current,
      installSource,
      cliAvailable: !("blocker" in cli),
      blockers,
    }),
    current,
    installSource,
    checkout,
    cli,
    record,
    remoteUrl,
    pluginSubpath: subpath(installSource, checkout, pluginPath),
  };
}

async function inspectRemote(
  deps: VersionDeps,
  local: Discovery,
  deadline: number,
): Promise<VersionInfo> {
  const registry = local.installSource.kind === "git" && Boolean(local.installSource.registry);
  if (
    local.installSource.kind === "unknown" ||
    local.installSource.kind === "npm" ||
    registry ||
    !local.remoteUrl ||
    !local.current.pluginPath
  ) {
    const decision = decideUpdate({
      source: local.installSource.kind,
      registry,
      relation: "unknown",
      sameCommit: false,
      blockers: local.info.blockers,
      cliAvailable: local.info.cliAvailable,
    });
    return VersionInfoSchema.parse({
      ...local.info,
      ...decision,
      remote: {
        ...local.info.remote,
        state: local.installSource.kind === "unknown" ? "unchecked" : "ready",
        checkedAt: local.installSource.kind === "unknown" ? null : deps.clock.iso(),
      },
    });
  }
  const cwd = local.current.repositoryPath ?? local.current.pluginPath;

  if (!allowedRemote(local.remoteUrl)) {
    return remoteError(
      local.info,
      blocker(
        "unsupported_remote",
        "manual_update",
        "origin must be an https, ssh, git, file, or local path; update this checkout manually",
      ),
      deps.clock.iso(),
    );
  }
  const tags = await listTags(deps.git, local.remoteUrl, cwd, CHECK_STEP_TIMEOUT_MS);
  if (tags === null)
    return remoteError(
      local.info,
      blocker("network_error", "retry_check", "git ls-remote failed"),
      deps.clock.iso(),
    );
  const choice = selectReleaseTag(parseLsRemoteTags(tags));
  let target: RemoteTarget;
  if (choice) {
    const version = await packageVersionAt(
      deps,
      local.remoteUrl,
      choice.sha,
      local.pluginSubpath,
      cwd,
    );
    if ("blocker" in version) return remoteError(local.info, version.blocker, deps.clock.iso());
    if (version.version !== choice.version.raw) {
      return remoteError(
        local.info,
        blocker("version_mismatch", "retry_check", `${choice.tag} declares ${version.version}`),
        deps.clock.iso(),
      );
    }
    target = releaseTarget(choice, local.remoteUrl);
  } else {
    const head = await readDefaultBranch(deps.git, local.remoteUrl, cwd, CHECK_STEP_TIMEOUT_MS);
    const branch = head ? parseSymrefHead(head) : null;
    if (!branch)
      return remoteError(
        local.info,
        blocker("no_remote", "retry_check", "default branch symref is missing"),
        deps.clock.iso(),
      );
    const version = await packageVersionAt(
      deps,
      local.remoteUrl,
      branch.sha,
      local.pluginSubpath,
      cwd,
    );
    if ("blocker" in version) return remoteError(local.info, version.blocker, deps.clock.iso());
    target = branchTarget(branch, version.version, local.remoteUrl);
  }
  const tracking = await trackingReview(deps, local, cwd);
  const blockers = tracking.blocker
    ? [...local.info.blockers, tracking.blocker]
    : local.info.blockers;
  const relation = await relate(deps, local, target.commit);
  const decision = decideUpdate({
    source: local.installSource.kind,
    registry: false,
    relation,
    sameCommit: local.current.commit === target.commit,
    blockers,
    cliAvailable: local.info.cliAvailable,
  });
  const checkId = deps.ids.uuid();
  const now = deps.now ?? Date.now;
  const pendingStart = now();
  let pendingCommits: PendingCommits | null = null;
  let pendingStaleRefs: string[] = [];
  if (deadline - PENDING_CLEANUP_RESERVE_MS > pendingStart) {
    const stale = await readStaleRefs(deps);
    const listStart = now();
    const pendingDeadline = Math.min(
      listStart + PENDING_COMMITS_BUDGET_MS,
      deadline - PENDING_CLEANUP_RESERVE_MS,
    );
    if (pendingDeadline > listStart) {
      const privateRef = privateRefFor(checkId);
      await writeStaleRefs(
        deps,
        stale.file,
        [...new Set([...stale.refs, privateRef])].filter((ref) => isPrivateRef(ref)),
      );
      const cleanupDeadline = Math.min(
        deadline - PENDING_OUTER_MARGIN_MS,
        pendingDeadline + PENDING_CLEANUP_BUDGET_MS,
      );
      const hooksPath = await ensureEmptyDir(
        deps,
        stale.hooksDir ?? path.join(tmpdir(), "paseo-agent-team-hooks"),
      );
      const pending = await readPendingCommits({
        git: deps.git,
        cwd,
        checkId,
        target,
        checkout: local.checkout,
        installSource: local.installSource,
        defaultRef: tracking.defaultRef,
        fromCommit: local.current.commit,
        staleRefs: stale.refs,
        hooksPath,
        now,
        deadline: pendingDeadline,
        cleanupDeadline,
      });
      pendingCommits = pending.commits;
      pendingStaleRefs = pending.staleRefs;
      await writeStaleRefs(deps, stale.file, pendingStaleRefs);
    }
  }
  return VersionInfoSchema.parse({
    ...local.info,
    ...decision,
    blockers,
    canUpdate: decision.canUpdate && !tracking.blocker,
    relation,
    pendingCommits,
    ...(pendingStaleRefs.length > 0
      ? { pendingCommitsDiagnostics: { staleRefs: pendingStaleRefs.slice(0, 10) } }
      : {}),
    checkId,
    remote: {
      state: "ready",
      repositoryLatest: target,
      installTarget: target,
      checkedAt: deps.clock.iso(),
      stale: false,
      error: null,
    },
  });
}

async function trackingReview(
  deps: VersionDeps,
  local: Discovery,
  cwd: string,
): Promise<{ blocker: Blocker | null; defaultRef: string | null }> {
  if (local.installSource.kind !== "directory" || !local.checkout?.branch || !local.remoteUrl) {
    return { blocker: null, defaultRef: null };
  }
  const head = await readDefaultBranch(deps.git, local.remoteUrl, cwd, CHECK_STEP_TIMEOUT_MS);
  const branch = head ? parseSymrefHead(head) : null;
  const expected = branch?.ref.replace(/^refs\/heads\//, "") ?? null;
  const remoteName = local.checkout.upstream?.slice(0, local.checkout.upstream.indexOf("/"));
  if (expected && remoteName && local.checkout.upstream === `${remoteName}/${expected}`)
    return { blocker: null, defaultRef: branch?.ref ?? null };
  return {
    blocker: blocker(
      "branch_mismatch",
      "switch_tracking_branch",
      `local branch ${local.checkout.branch} tracks ${local.checkout.upstream ?? "nothing"}; remote default branch is ${expected ?? "unknown"}. Check out the default branch and retry, or update manually.`,
    ),
    defaultRef: branch?.ref ?? null,
  };
}

async function packageVersionAt(
  deps: VersionDeps,
  remote: string,
  sha: string,
  pluginSubpath: string,
  cwd: string,
): Promise<{ version: string } | { blocker: Blocker }> {
  const http = await readGithubPackage({
    remote,
    sha,
    pluginPath: pluginSubpath,
    fetch: deps.fetch,
    timeoutMs: CHECK_STEP_TIMEOUT_MS,
  });
  if (!("error" in http)) return { version: http.version };
  if (http.error === "mismatch")
    return { blocker: blocker("version_mismatch", "retry_check", "package name mismatch") };
  if (http.error === "rate") return { blocker: blocker("rate_limited", "retry_check") };
  const relative = pluginPackagePath(pluginSubpath);
  if (!relative || !asSha(sha))
    return { blocker: blocker("version_invalid", "retry_check", "plugin package path is invalid") };
  if (!(await objectPresent(deps.git, cwd, sha, CHECK_STEP_TIMEOUT_MS))) {
    return {
      blocker: blocker(
        "network_error",
        "retry_check",
        "package.json is unavailable until the update fetches it",
      ),
    };
  }
  const shown = await deps.git.run({
    args: ["show", `${sha}:${relative}`],
    cwd,
    timeoutMs: CHECK_STEP_TIMEOUT_MS,
  });
  if (!gitOk(shown))
    return { blocker: blocker("network_error", "retry_check", "git show package.json failed") };
  const parsed = parsePackage(shown.stdout);
  if ("error" in parsed)
    return {
      blocker: blocker(
        parsed.error === "mismatch" ? "version_mismatch" : "version_invalid",
        "retry_check",
      ),
    };
  return { version: parsed.version };
}

async function relate(
  deps: VersionDeps,
  local: Discovery,
  target: string | null,
): Promise<Relation> {
  if (!target || !asSha(target)) return "unknown";
  if (!local.current.commit) return "unknown";
  if (local.current.commit === target) return "equal";
  if (!local.current.repositoryPath) return "unknown";
  if (!(await objectPresent(deps.git, local.current.repositoryPath, target, CHECK_STEP_TIMEOUT_MS)))
    return "unknown";
  return ancestry(
    deps.git,
    local.current.repositoryPath,
    local.current.commit,
    target,
    CHECK_STEP_TIMEOUT_MS,
  );
}

async function writeBoot(deps: VersionDeps, paseo: Pick<PaseoPort, "config">): Promise<void> {
  const home = resolveExplicitHome(deps.env, deps.platform);
  if (!home.ok) return;
  const serverId = await readServerId(deps.files, home.home);
  if (!serverId) return;
  const local = await discover(deps, paseo);
  const root = storeRoot(home.home, serverId);
  await mkdir(root, { recursive: true });
  await deps.files.writeAtomic(
    path.join(root, "boot.json"),
    `${JSON.stringify({
      bootId: deps.bootId,
      packageVersion: local.current.packageVersion,
      commit: local.current.commit,
      observedAt: deps.clock.iso(),
    })}\n`,
  );
}

function saveCheck(id: string, info: VersionInfo, local: Discovery, deps: VersionDeps): SavedCheck {
  return {
    id,
    savedAt: deps.clock.iso(),
    info,
    remoteUrl: local.remoteUrl,
    targetRef: info.remote.installTarget?.ref ?? null,
    pluginSubpath: local.pluginSubpath,
    serverId: "",
  };
}

async function persistCheck(deps: VersionDeps, job: Job, check: SavedCheck): Promise<void> {
  const located = await locateStore(deps);
  if (!located) return;
  await mkdir(path.join(located.root, "checks"), { recursive: true });
  await mkdir(path.join(located.root, "requests"), { recursive: true });
  await mkdir(located.store.jobDir(job.id), { recursive: true });
  const saved = { ...check, serverId: located.serverId };
  await deps.files.writeAtomic(
    path.join(located.root, "checks", `${check.id}.json`),
    `${JSON.stringify(saved)}\n`,
  );
  await located.store.writeJob(job);
  await located.store.rememberRequest(job.requestId, job.id);
  await located.store.writeLatest(job.id);
}

async function loadCheck(
  deps: VersionDeps,
  home: string,
  serverId: string,
  checkId: string,
  memory: Memory,
): Promise<SavedCheck | null> {
  const cached = [...memory.values()].find((entry) => entry.check?.id === checkId)?.check;
  if (cached) return { ...cached, serverId };
  const text = await readOptional(
    deps.files,
    path.join(storeRoot(home, serverId), "checks", `${checkId}.json`),
    1024 * 1024,
  );
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as SavedCheck;
    if (parsed.id !== checkId) return null;
    return { ...parsed, info: VersionInfoSchema.parse(parsed.info) };
  } catch {
    return null;
  }
}

async function findRequest(
  deps: VersionDeps,
  requestId: string,
  memory: Memory,
): Promise<Job | null> {
  const cached = [...memory.values()].find((entry) => entry.job.requestId === requestId);
  if (cached) return cached.job;
  const located = await locateStore(deps);
  if (!located) return null;
  const jobId = await located.store.jobForRequest(requestId);
  return jobId ? located.store.readJob(jobId) : null;
}

async function persistedJob(deps: VersionDeps, jobId?: string): Promise<Job | null> {
  const located = await locateStore(deps);
  if (!located) return null;
  return jobId ? located.store.readJob(jobId) : located.store.readLatest();
}

async function locateStore(
  deps: VersionDeps,
): Promise<{ root: string; serverId: string; store: VersionStore } | null> {
  const home = resolveExplicitHome(deps.env, deps.platform);
  if (!home.ok) return null;
  const serverId = await readServerId(deps.files, home.home);
  if (!serverId) return null;
  const root = storeRoot(home.home, serverId);
  return { root, serverId, store: createStore(deps.files, root) };
}

const STALE_REFS_FILE = "pending-commits-refs.json";
const STALE_REFS_LIMIT = 50;

type StaleRefsStore = { file: string | null; hooksDir: string | null; refs: string[] };

async function readStaleRefs(deps: VersionDeps): Promise<StaleRefsStore> {
  const located = await locateStore(deps);
  if (!located) return { file: null, hooksDir: null, refs: [] };
  const checks = path.join(located.root, "checks");
  const file = path.join(checks, STALE_REFS_FILE);
  // Plugin reload briefly overlaps the old and new processes. The new process
  // may delete a private ref the old one is still fetching; only that check's
  // pending list becomes null, and the ref itself has no repository side effect.
  const text = await readOptional(deps.files, file, 64 * 1024);
  if (!text) return { file, hooksDir: path.join(checks, "hooks"), refs: [] };
  try {
    const parsed: unknown = JSON.parse(text);
    const values =
      parsed && typeof parsed === "object" && "refs" in parsed && Array.isArray(parsed.refs)
        ? parsed.refs
        : [];
    const refs = values.filter(
      (ref): ref is string => typeof ref === "string" && isPrivateRef(ref),
    );
    return {
      file,
      hooksDir: path.join(checks, "hooks"),
      refs: [...new Set(refs)].slice(0, STALE_REFS_LIMIT),
    };
  } catch {
    return { file, hooksDir: path.join(checks, "hooks"), refs: [] };
  }
}

async function writeStaleRefs(
  deps: VersionDeps,
  file: string | null,
  refs: readonly string[],
): Promise<void> {
  if (!file) return;
  if (refs.length === 0) {
    try {
      await deps.files.remove(file);
    } catch {
      // The stale marker is advisory; a missing file needs no further action.
    }
    return;
  }
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await deps.files.writeAtomic(
      file,
      `${JSON.stringify({ refs: refs.slice(0, STALE_REFS_LIMIT) })}\n`,
    );
  } catch {
    // Keep the current result; the next check retries only when the write succeeded.
  }
}

/** Create an empty directory so `core.hooksPath` points at no hooks. */
async function ensureEmptyDir(deps: VersionDeps, dir: string): Promise<string> {
  const marker = path.join(dir, ".keep");
  try {
    await deps.files.writeAtomic(marker, "");
    await deps.files.remove(marker);
  } catch {
    // A missing hooks directory also has no hooks; the isolation flags still apply.
  }
  return dir;
}

async function readServerId(files: FilesPort, home: string): Promise<string | null> {
  const text = (await readOptional(files, path.join(home, "server-id"), 4096))?.trim() ?? "";
  return text || null;
}

async function revParse(git: GitPort, cwd: string): Promise<string | null> {
  const result = await git
    .run({ args: ["rev-parse", "HEAD"], cwd, timeoutMs: CHECK_STEP_TIMEOUT_MS })
    .catch(() => null);
  return result && gitOk(result) ? asSha(gitText(result)) : null;
}

async function originUrl(git: GitPort, repository: string | null): Promise<string | null> {
  if (!repository) return null;
  const result = await git
    .run({
      args: ["remote", "get-url", "origin"],
      cwd: repository,
      timeoutMs: CHECK_STEP_TIMEOUT_MS,
    })
    .catch(() => null);
  return result && gitOk(result) ? stripCredentials(gitText(result)) : null;
}

function subpath(source: InstallSource, checkout: Checkout | null, pluginPath: string): string {
  if (source.kind === "git" || source.kind === "npm")
    return source.pluginPath === "." ? "paseo-agent-team" : source.pluginPath;
  if (!checkout?.repositoryPath) return "paseo-agent-team";
  const relative = path.relative(checkout.repositoryPath, pluginPath).replace(/\\/g, "/");
  return relative && !relative.startsWith("..") ? relative : "paseo-agent-team";
}

function newJob(
  deps: VersionDeps,
  requestId: string,
  kind: Job["kind"],
  phase: Job["phase"],
  from: Current | null,
  target: RemoteTarget | null,
): Job {
  const now = deps.clock.iso();
  return JobSchema.parse({
    schemaVersion: 1,
    id: deps.ids.uuid(),
    requestId,
    kind,
    state: kind === "check" ? "running" : "queued",
    phase,
    seq: 0,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    from,
    target,
    result: null,
    error: null,
    rollback: "not-needed",
  });
}

function failedJob(deps: VersionDeps, job: Job, reason: Blocker): Job {
  return JobSchema.parse({
    ...job,
    state: "blocked",
    phase: "done",
    seq: job.seq + 1,
    error: reason,
    finishedAt: deps.clock.iso(),
    updatedAt: deps.clock.iso(),
  });
}

async function failStart(
  store: VersionStore,
  deps: VersionDeps,
  job: Job,
  reason: Blocker,
): Promise<void> {
  await store.writeJob(failedJob(deps, job, reason));
  await store.unlock(job.id);
}

function refused(reason: Blocker): StartResult {
  return { ok: false, blockers: [reason], job: null };
}

function blankInfo(observedAt: string): VersionInfo {
  return VersionInfoSchema.parse({
    schemaVersion: 1,
    current: currentSnapshot({
      packageVersion: null,
      commit: null,
      branch: null,
      dirty: null,
      pluginPath: null,
      repositoryPath: null,
      observedAt,
    }),
    installSource: { kind: "unknown" },
    remote: {
      state: "unchecked",
      repositoryLatest: null,
      installTarget: null,
      checkedAt: null,
      stale: false,
      error: null,
    },
    relation: "unknown",
    updateAvailable: null,
    canUpdate: false,
    cliAvailable: false,
    checkId: null,
    pendingCommits: null,
    blockers: [],
  });
}

function unknownDiscovery(info: VersionInfo, reason: Blocker): Discovery {
  return {
    info: VersionInfoSchema.parse({ ...info, blockers: [...info.blockers, reason] }),
    current: info.current,
    installSource: { kind: "unknown" },
    checkout: null,
    cli: { blocker: blocker("cli_missing", "install_cli") },
    record: { kind: "absent" },
    remoteUrl: null,
    pluginSubpath: "paseo-agent-team",
  };
}

function remoteError(info: VersionInfo, reason: Blocker, checkedAt: string): VersionInfo {
  return VersionInfoSchema.parse({
    ...info,
    remote: { ...info.remote, state: "error", checkedAt, error: reason },
    relation: "unknown",
    updateAvailable: null,
    canUpdate: false,
    blockers: [...info.blockers, reason],
  });
}

function latest(memory: Memory, kind: Job["kind"]): Job | null {
  return (
    [...memory.values()]
      .map((entry) => entry.job)
      .reverse()
      .find((job) => job.kind === kind) ?? null
  );
}

async function spawnDetached(
  node: string,
  runnerCopy: string,
  requestFile: string,
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const log = await open(path.join(path.dirname(requestFile), "output.log"), "a");
  const child = spawn(node, [runnerCopy, "--request", requestFile], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log.fd, log.fd],
    env: { ...env, PASEO_HOME: home },
  });
  child.unref();
  await log.close();
}

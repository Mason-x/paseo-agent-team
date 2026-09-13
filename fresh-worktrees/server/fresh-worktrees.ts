import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PluginBeforeRequests } from "@getpaseo/plugin/server";

export type WorkspaceCreateRequest = PluginBeforeRequests["workspace.create"];
type WorktreeSource = Extract<WorkspaceCreateRequest["source"], { kind: "worktree" }>;

export interface ProjectDescriptor {
  projectId: string;
  projectRootPath: string;
  projectKind: "git" | "non_git" | "directory";
}

export type GitRunner = (
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
) => Promise<string>;

export type RepositoryRefreshResult =
  | { kind: "updated"; freshBase: string }
  | { kind: "unchanged" }
  | { kind: "dirty" };

export type RepositoryRefresh = (
  cwd: string,
  remote: string,
  localBranch: string | null,
  upstream: string | null,
  signal: AbortSignal,
) => Promise<RepositoryRefreshResult>;

export interface RefreshDependencies {
  signal: AbortSignal;
  listProjects(): Promise<readonly ProjectDescriptor[]>;
  refreshRepository: RepositoryRefresh;
  runGit?: GitRunner;
  log?(message: string): void;
  warn?(message: string): void;
}

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;


export async function executeGit(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(GIT_TIMEOUT_MS)]);
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 64 * 1024,
      signal: operationSignal,
    });
    return stdout.trim();
  } catch (error) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? String(error.stderr).trim()
        : "";
    const detail = stderr || (error instanceof Error ? error.message : String(error));
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${detail}`, { cause: error });
  }
}

export function createRepositoryRefreshCoordinator(
  runGit: GitRunner = executeGit,
): RepositoryRefresh {
  const inFlight = new Map<string, Promise<RepositoryRefreshResult>>();
  const repositoryTails = new Map<string, Promise<void>>();

  return async (cwd, remote, localBranch, upstream, signal) => {
    const targetKey = `${cwd}\0${remote}\0${localBranch ?? ""}\0${upstream ?? ""}`;
    const existingRefresh = inFlight.get(targetKey);
    if (existingRefresh) return existingRefresh;

    const previousRefresh = repositoryTails.get(cwd) ?? Promise.resolve();
    const refresh = previousRefresh.catch(() => {}).then(async (): Promise<RepositoryRefreshResult> => {
      await runGit(cwd, ["fetch", "--prune", "--quiet", remote], signal);
      if (!localBranch) return { kind: "unchanged" };

      const matchingRemoteBranch = `${remote}/${localBranch}`;
      const freshBase =
        upstream && (await remoteRefExists(runGit, cwd, upstream, signal))
          ? upstream
          : (await remoteRefExists(runGit, cwd, matchingRemoteBranch, signal))
            ? matchingRemoteBranch
            : null;
      if (!freshBase) return { kind: "unchanged" };

      const currentBranch = await optionalGit(
        runGit,
        cwd,
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        signal,
      );
      if (currentBranch !== localBranch) {
        throw new Error(
          `Cannot refresh local branch ${localBranch} in ${cwd}: the source checkout is on ${currentBranch ?? "a detached HEAD"}`,
        );
      }

      const status = await runGit(
        cwd,
        ["status", "--porcelain", "--untracked-files=normal"],
        signal,
      );
      if (status) return { kind: "dirty" };

      await runGit(cwd, ["merge", "--ff-only", "--quiet", freshBase], signal);
      return { kind: "updated", freshBase };
    });
    const tail = refresh.then(
      () => {},
      () => {},
    );
    inFlight.set(targetKey, refresh);
    repositoryTails.set(cwd, tail);

    try {
      return await refresh;
    } finally {
      if (inFlight.get(targetKey) === refresh) inFlight.delete(targetKey);
      if (repositoryTails.get(cwd) === tail) repositoryTails.delete(cwd);
    }
  };
}

function remoteForRef(ref: string | null, remotes: readonly string[]): string | null {
  if (!ref) return null;
  const shortRef = ref.startsWith("refs/remotes/") ? ref.slice("refs/remotes/".length) : ref;
  return (
    [...remotes]
      .sort((left, right) => right.length - left.length)
      .find((remote) => shortRef.startsWith(`${remote}/`)) ?? null
  );
}

async function optionalGit(
  runGit: GitRunner,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<string | null> {
  try {
    return await runGit(cwd, args, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}

async function localBranchDetails(
  runGit: GitRunner,
  cwd: string,
  ref: string,
  signal: AbortSignal,
): Promise<{ branch: string; upstream: string | null } | null> {
  const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
  const exists = await optionalGit(
    runGit,
    cwd,
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    signal,
  );
  if (exists === null) return null;

  const upstream = await optionalGit(
    runGit,
    cwd,
    ["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`],
    signal,
  );
  return { branch, upstream: upstream || null };
}

async function remoteRefExists(
  runGit: GitRunner,
  cwd: string,
  ref: string,
  signal: AbortSignal,
): Promise<boolean> {
  const fullRef = ref.startsWith("refs/remotes/") ? ref : `refs/remotes/${ref}`;
  return (
    (await optionalGit(runGit, cwd, ["show-ref", "--verify", "--quiet", fullRef], signal)) !==
    null
  );
}

async function resolveProjectRoot(
  source: WorktreeSource,
  listProjects: RefreshDependencies["listProjects"],
): Promise<string | null> {
  if (source.cwd) return source.cwd;
  if (!source.projectId) return null;

  const project = (await listProjects()).find(({ projectId }) => projectId === source.projectId);
  return project?.projectKind === "git" ? project.projectRootPath : null;
}

export async function refreshWorkspaceRequest(
  request: WorkspaceCreateRequest,
  dependencies: RefreshDependencies,
): Promise<WorkspaceCreateRequest> {
  const source = request.source;
  if (
    source.kind !== "worktree" ||
    source.action === "checkout" ||
    source.checkoutSource !== undefined ||
    source.githubPrNumber !== undefined
  ) {
    return request;
  }

  const cwd = await resolveProjectRoot(source, dependencies.listProjects);
  if (!cwd) {
    dependencies.log?.("Skipped refresh because the source project path could not be resolved");
    return request;
  }

  const runGit = dependencies.runGit ?? executeGit;
  const remotes = (await runGit(cwd, ["remote"], dependencies.signal))
    .split(/\r?\n/)
    .map((remote) => remote.trim())
    .filter(Boolean);
  if (remotes.length === 0) return request;

  const requestedRef = source.refName?.trim() || null;
  let localBranch = requestedRef
    ? await localBranchDetails(runGit, cwd, requestedRef, dependencies.signal)
    : null;

  if (!requestedRef) {
    const currentBranch = await optionalGit(
      runGit,
      cwd,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      dependencies.signal,
    );
    if (currentBranch) {
      localBranch = await localBranchDetails(
        runGit,
        cwd,
        currentBranch,
        dependencies.signal,
      );
    }
  }

  const remote =
    remoteForRef(requestedRef, remotes) ??
    remoteForRef(localBranch?.upstream ?? null, remotes) ??
    (remotes.includes("origin") ? "origin" : remotes[0]);

  const requestedRemote = remoteForRef(requestedRef, remotes);
  let refreshResult: RepositoryRefreshResult;
  try {
    refreshResult = await dependencies.refreshRepository(
      cwd,
      remote,
      requestedRemote ? null : (localBranch?.branch ?? null),
      localBranch?.upstream ?? null,
      dependencies.signal,
    );
  } catch (error) {
    if (dependencies.signal.aborted) throw error;
    dependencies.warn?.(
      `Skipped refresh because fetching ${remote} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return request;
  }

  if (refreshResult.kind === "dirty") {
    dependencies.warn?.(
      `Skipped refreshing local branch ${localBranch?.branch} in ${cwd} because the source checkout is not clean`,
    );
  } else {
    dependencies.log?.(
      refreshResult.kind === "updated"
        ? `Fetched ${remote} for ${cwd}; fast-forwarded ${localBranch?.branch} to ${refreshResult.freshBase}`
        : `Fetched ${remote} for ${cwd}; no local branch update was needed`,
    );
  }

  return request;
}

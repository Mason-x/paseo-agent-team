import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { normalizeLogicalPath, type VerifiedScope } from "../../shared/domain/run-engine/locks";
import type { RunTaskSpec, RunWorkspace } from "../../shared/schemas/run-engine/ledger";

/**
 * Host-side repository facts for the Run Engine (plan 11.4 items 1 and 4). Nothing here trusts a
 * path the model or the task spec wrote down:
 *
 *  - the repository identity is the real location of the git common directory, so two aliases of
 *    one checkout (case, 8.3 short names, junctions, linked worktrees) share one `repoId`;
 *  - a scope is verified only when its real, canonical location is the path it declares, inside
 *    the repository. An alias is refused rather than rewritten, because the lock table compares
 *    declared paths and an unrecognised alias would silently bypass a lock.
 */

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

type GitRun =
  | { ok: true; stdout: string }
  | { ok: false; code: number | string | null; stderr: string };

function git(cwd: string, args: readonly string[]): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
        encoding: "utf8",
        // Reading state must not take the index lock: a concurrent agent commit would fight it.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true, stdout });
        const code = (error as NodeJS.ErrnoException & { code?: number | string }).code ?? null;
        resolve({ ok: false, code, stderr: String(stderr ?? "").slice(0, 500) });
      },
    );
  });
}

export type RepoFacts = {
  /** Real path of the working tree root. */
  root: string;
  /** Stable identity, shared by every alias and linked worktree of the repository. */
  repoId: string;
  /** Current branch, or `null` for a detached HEAD. */
  branch: string | null;
  /** Current commit, or `null` before the first commit. */
  headSha: string | null;
  /** No tracked change and no untracked file (ignored files do not count). */
  clean: boolean;
};

export type InspectRepo =
  | { ok: true; repo: RepoFacts }
  | { ok: false; reason: "not-git" | "git-error"; detail: string };

/** Hash of the real common-dir location, folded where the filesystem folds case. */
function identityOf(commonDir: string): string {
  const folded = process.platform === "win32" ? commonDir.toLowerCase() : commonDir;
  const normalized = folded.split(path.sep).join("/");
  return `repo-${createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 24)}`;
}

export async function inspectRepo(directory: string): Promise<InspectRepo> {
  const top = await git(directory, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    return /not a git repository/iu.test(top.stderr)
      ? { ok: false, reason: "not-git", detail: top.stderr.trim() }
      : { ok: false, reason: "git-error", detail: top.stderr.trim() || String(top.code) };
  }
  const common = await git(directory, ["rev-parse", "--git-common-dir"]);
  if (!common.ok) return { ok: false, reason: "git-error", detail: common.stderr.trim() };
  let root: string;
  let commonDir: string;
  try {
    root = await realpath(path.resolve(directory, top.stdout.trim()));
    commonDir = await realpath(path.resolve(directory, common.stdout.trim()));
  } catch (error) {
    return { ok: false, reason: "git-error", detail: (error as Error).message };
  }

  const [branch, head, status] = await Promise.all([
    git(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(directory, ["rev-parse", "--verify", "--quiet", "HEAD"]),
    git(directory, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  if (!status.ok) return { ok: false, reason: "git-error", detail: status.stderr.trim() };
  return {
    ok: true,
    repo: {
      root,
      repoId: identityOf(commonDir),
      branch: branch.ok && branch.stdout.trim() !== "" ? branch.stdout.trim() : null,
      headSha: head.ok && head.stdout.trim() !== "" ? head.stdout.trim() : null,
      clean: status.stdout.trim() === "",
    },
  };
}

export type DispatchWorkspace =
  | { ok: true; workspace: RunWorkspace }
  | { ok: false; reason: "detached-head" | "no-commit" | "dirty" };

/**
 * M2: the workspace of an assignment, from real git state. `baseRef` is the commit the work starts
 * from; the delivered commit is later compared against it. A dirty tree is refused, never cleaned.
 */
export function dispatchWorkspace(repo: RepoFacts, workspaceId: string): DispatchWorkspace {
  if (repo.branch === null) return { ok: false, reason: "detached-head" };
  if (repo.headSha === null) return { ok: false, reason: "no-commit" };
  if (!repo.clean) return { ok: false, reason: "dirty" };
  return { ok: true, workspace: { id: workspaceId, branch: repo.branch, baseRef: repo.headSha } };
}

export type ScopeRefusal =
  | "repo-mismatch"
  | "invalid-path"
  | "git-internal"
  | "escapes-repo"
  | "unresolvable"
  | "short-name"
  | "alias";

export type VerifyScopes =
  | { ok: true; scopes: VerifiedScope[] }
  | { ok: false; rejected: { path: string; reason: ScopeRefusal }[] };

type TaskScope = RunTaskSpec["scopes"][number];

function fold(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function verifyOne(repo: RepoFacts, scope: TaskScope): Promise<ScopeRefusal | null> {
  if (scope.repoId !== repo.repoId) return "repo-mismatch";
  const normalized = normalizeLogicalPath(scope.path);
  if (!normalized.ok) return "invalid-path";
  const segments = normalized.path.split("/");
  // Writing inside the git directory would corrupt the repository itself.
  if (segments.some((segment) => fold(segment) === ".git")) return "git-internal";

  // Follow the path as far as it exists. Everything after that is a name that does not exist yet.
  let existing = repo.root;
  let consumed = 0;
  for (const segment of segments) {
    const candidate = path.join(existing, segment);
    try {
      await lstat(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") break;
      return "unresolvable";
    }
    existing = candidate;
    consumed += 1;
  }
  let real: string;
  try {
    real = await realpath(existing);
  } catch {
    return "unresolvable";
  }
  if (!contains(repo.root, real)) return "escapes-repo";

  const known = path
    .relative(repo.root, real)
    .split(path.sep)
    .filter((part) => part !== "");
  const missing = segments.slice(consumed);
  // A name that does not exist yet cannot be expanded, so a short-name spelling would stay hidden.
  if (missing.some((segment) => /~\d/u.test(segment))) return "short-name";
  const canonical = [...known, ...missing].join("/");
  if (fold(canonical) !== normalized.caseFolded) return "alias";
  return null;
}

/**
 * Verifies every scope of a task against the real repository. The result carries the *declared*
 * path with `verified: true`, which is exactly what the dispatch builder compares and what the
 * reducer matches a claim against. Any single refusal rejects the whole set.
 */
export async function verifyScopes(
  repo: RepoFacts,
  scopes: readonly TaskScope[],
): Promise<VerifyScopes> {
  const rejected: { path: string; reason: ScopeRefusal }[] = [];
  const verified: VerifiedScope[] = [];
  for (const scope of scopes) {
    const reason = await verifyOne(repo, scope);
    if (reason) rejected.push({ path: scope.path, reason });
    else
      verified.push({
        repoId: scope.repoId,
        kind: scope.kind,
        path: scope.path,
        access: scope.access,
        verified: true,
      });
  }
  return rejected.length > 0 ? { ok: false, rejected } : { ok: true, scopes: verified };
}

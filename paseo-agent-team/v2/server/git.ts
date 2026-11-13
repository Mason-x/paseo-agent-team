import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { TEAM_DIR } from "../shared/run";

/** Runs git and returns trimmed stdout. Never goes through a shell. */
export function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error)
        reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim() || error.message}`));
      else resolve(stdout.trim());
    });
  });
}

export const head = (cwd: string) => git(cwd, "rev-parse", "HEAD");
export const revParse = (cwd: string, ref: string) =>
  git(cwd, "rev-parse", "--verify", `${ref}^{commit}`);

/** Tip of a local branch, or null when it does not exist. */
export const branchSha = (cwd: string, branch: string) =>
  git(cwd, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).catch(() => null);

/** Files with uncommitted changes (tracked or untracked), ignoring `.team/`. */
export async function dirtyFiles(cwd: string): Promise<string[]> {
  const raw = await git(cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all");
  const parts = raw.split("\0").filter(Boolean);
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] as string;
    files.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") i++; // the original path follows as its own token
  }
  return files.filter((f) => f !== TEAM_DIR && !f.startsWith(`${TEAM_DIR}/`));
}

/** Files changed between the merge base of `base` and `sha`, and `sha`. */
export async function changedFiles(cwd: string, base: string, sha: string): Promise<string[]> {
  const out = await git(cwd, "diff", "--name-only", "-z", `${base}...${sha}`);
  return out.split("\0").filter(Boolean);
}

/** How many commits `baseRef` has that `sha` does not. */
export async function behindBase(cwd: string, baseRef: string, sha: string): Promise<number> {
  return Number(await git(cwd, "rev-list", "--count", `${sha}..${baseRef}`));
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  if ((await branchSha(repo, branch)) === null) return;
  await git(repo, "branch", "-D", branch);
}

/** Lists local branches under a prefix, e.g. `team/<runId>/review-`. */
export async function branchesWithPrefix(repo: string, prefix: string): Promise<string[]> {
  const out = await git(repo, "for-each-ref", "--format=%(refname:short)", `refs/heads/${prefix}*`);
  return out.split("\n").filter(Boolean);
}

/** Ignores `.team/` through the shared `info/exclude`, so every worktree of the repo honours it. */
export async function excludeTeamDir(cwd: string): Promise<void> {
  const common = path.resolve(cwd, await git(cwd, "rev-parse", "--git-common-dir"));
  const file = path.join(common, "info", "exclude");
  const current = await readFile(file, "utf8").catch(() => "");
  if (current.split("\n").includes(`${TEAM_DIR}/`)) return;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${current && !current.endsWith("\n") ? "\n" : ""}${TEAM_DIR}/\n`);
}

/** Spec 7.3 layer 3: the writer's worktree must be exactly where the review started. */
export async function writerUntouched(
  worktree: string,
  branch: string,
  sha: string,
): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  const [h, b, dirty] = await Promise.all([
    head(worktree).catch(() => null),
    branchSha(worktree, branch),
    dirtyFiles(worktree).catch(() => ["(git status failed)"]),
  ]);
  if (h !== sha)
    problems.push(`HEAD is ${h?.slice(0, 8) ?? "unknown"}, expected ${sha.slice(0, 8)}`);
  if (b !== sha)
    problems.push(
      `branch ${branch} is ${b?.slice(0, 8) ?? "missing"}, expected ${sha.slice(0, 8)}`,
    );
  if (dirty.length) problems.push(`uncommitted: ${dirty.slice(0, 10).join(", ")}`);
  return { ok: problems.length === 0, problems };
}

/** Worktrees of `repo` whose checked-out branch starts with `prefix`, from `git worktree list`. */
export async function worktreesWithPrefix(repo: string, prefix: string) {
  const out = await git(repo, "worktree", "list", "--porcelain");
  const found: { path: string; branch: string }[] = [];
  for (const block of out.split("\n\n")) {
    const dir = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (dir && branch?.startsWith(prefix)) found.push({ path: dir, branch });
  }
  return found;
}

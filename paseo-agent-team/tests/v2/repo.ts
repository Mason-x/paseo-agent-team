import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

export function write(dir: string, file: string, content: string) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), content);
}

export function commit(dir: string, file: string, content: string, message = `edit ${file}`) {
  write(dir, file, content);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", message);
  return sh(dir, "rev-parse", "HEAD");
}

/** A real temporary repo on branch `main` with one commit, plus a cleanup function. */
export function tempRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "v2-repo-"));
  const dir = path.join(root, "repo");
  mkdirSync(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@example.invalid");
  sh(dir, "config", "user.name", "t");
  const base = commit(dir, "README.md", "base\n", "base");
  /** Adds a worktree on a new branch at `from` and returns its path. */
  const worktree = (name: string, branch: string, from = "HEAD") => {
    const p = path.join(root, name);
    sh(dir, "worktree", "add", "-q", "-b", branch, p, from);
    return p;
  };
  return {
    root,
    dir,
    base,
    worktree,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  behindBase,
  branchesWithPrefix,
  branchSha,
  changedFiles,
  deleteBranch,
  dirtyFiles,
  excludeTeamDir,
  head,
  writerUntouched,
} from "../../v2/server/git";
import { commit, sh, tempRepo, write } from "./repo";

const cleanups: (() => void)[] = [];
const repo = () => {
  const r = tempRepo();
  cleanups.push(r.cleanup);
  return r;
};
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe("git helpers", () => {
  it("dirtyFiles reports modified, untracked and renamed files but not .team/", async () => {
    const r = repo();
    expect(await dirtyFiles(r.dir)).toEqual([]);
    write(r.dir, "README.md", "changed\n");
    write(r.dir, "new file.txt", "x");
    write(r.dir, ".team/progress.md", "notes");
    sh(r.dir, "mv", "README.md", "RENAMED.md");
    expect((await dirtyFiles(r.dir)).sort()).toEqual(["RENAMED.md", "new file.txt"]);
  });

  it("changedFiles lists the files between base and candidate", async () => {
    const r = repo();
    const wt = r.worktree("w", "feature");
    commit(wt, "src/a.ts", "a");
    const sha = commit(wt, "tests/a.test.ts", "t");
    expect((await changedFiles(wt, r.base, sha)).sort()).toEqual(["src/a.ts", "tests/a.test.ts"]);
  });

  it("behindBase counts commits the base gained since the candidate", async () => {
    const r = repo();
    const wt = r.worktree("w", "feature");
    const sha = commit(wt, "a.txt", "a");
    expect(await behindBase(r.dir, "main", sha)).toBe(0);
    commit(r.dir, "b.txt", "b");
    commit(r.dir, "c.txt", "c");
    expect(await behindBase(r.dir, "main", sha)).toBe(2);
  });

  it("deleteBranch removes a branch and is idempotent; prefix listing finds the rest", async () => {
    const r = repo();
    sh(r.dir, "branch", "team/r1/review-1-r1");
    sh(r.dir, "branch", "team/r1/review-1-r2");
    sh(r.dir, "branch", "team/r2/writer");
    expect((await branchesWithPrefix(r.dir, "team/r1/review-")).sort()).toEqual([
      "team/r1/review-1-r1",
      "team/r1/review-1-r2",
    ]);
    await deleteBranch(r.dir, "team/r1/review-1-r1");
    await deleteBranch(r.dir, "team/r1/review-1-r1");
    expect(await branchSha(r.dir, "team/r1/review-1-r1")).toBeNull();
    expect(await branchSha(r.dir, "team/r1/review-1-r2")).not.toBeNull();
  });

  it("excludeTeamDir hides .team/ in every worktree, once, without touching .gitignore", async () => {
    const r = repo();
    const wt = r.worktree("w", "feature");
    await excludeTeamDir(wt);
    await excludeTeamDir(r.dir);
    write(wt, ".team/task.md", "t");
    expect(sh(wt, "status", "--porcelain")).toBe("");
    const exclude = readFileSync(path.join(r.dir, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l === ".team/")).toHaveLength(1);
    expect(existsSync(path.join(wt, ".gitignore"))).toBe(false);
  });

  it("writerUntouched passes for an unchanged worktree and names every problem otherwise", async () => {
    const r = repo();
    const wt = r.worktree("w", "feature");
    const sha = commit(wt, "a.txt", "a");
    expect(await writerUntouched(wt, "feature", sha)).toEqual({ ok: true, problems: [] });

    write(wt, "scratch.txt", "x");
    const dirty = await writerUntouched(wt, "feature", sha);
    expect(dirty.ok).toBe(false);
    expect(dirty.problems.join()).toContain("scratch.txt");

    sh(wt, "add", "-A");
    commit(wt, "b.txt", "b");
    const moved = await writerUntouched(wt, "feature", sha);
    expect(moved.ok).toBe(false);
    expect(moved.problems).toHaveLength(2); // HEAD and branch both moved
    expect(await head(wt)).not.toBe(sha);
  });
});

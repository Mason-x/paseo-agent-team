import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createGit } from "../server/version/git";
import type { Checkout } from "../server/version/local-install";
import { readPendingCommits } from "../server/version/pending";
import { nodeExec } from "../server/version/process";
import type { RemoteTarget } from "../shared/version";

function git(args: string[], cwd: string): string {
  const result = spawnSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

describe("pending commits against a real origin", () => {
  test("fetching the default branch leaves remotes, HEAD, FETCH_HEAD, and refs untouched", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-pending-git-"));
    try {
      const remote = path.join(root, "remote.git");
      const seed = path.join(root, "seed");
      const work = path.join(root, "work");
      const hooks = path.join(root, "hooks");
      mkdirSync(hooks);
      git(["init", "-q", "--bare", remote], root);
      git(["symbolic-ref", "HEAD", "refs/heads/trunk"], remote);
      git(["clone", "-q", remote, seed], root);
      writeFileSync(path.join(seed, "file.txt"), "one\n");
      git(["add", "file.txt"], seed);
      git(["commit", "-qm", "first"], seed);
      git(["push", "-q", "origin", "trunk"], seed);
      git(["clone", "-q", remote, work], root);
      const beforeHead = git(["rev-parse", "HEAD"], work);
      const beforeRemotes = git(
        ["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes"],
        work,
      );
      const fetchHead = path.join(work, ".git", "FETCH_HEAD");

      writeFileSync(path.join(seed, "file.txt"), "two\n");
      git(["commit", "-qam", "second"], seed);
      git(["push", "-q", "origin", "trunk"], seed);
      const targetSha = git(["rev-parse", "HEAD"], seed);
      expect(targetSha).not.toBe(beforeHead);
      expect(existsSync(fetchHead)).toBe(false);

      const checkout: Checkout = {
        pluginPath: work,
        repositoryPath: work,
        commit: beforeHead,
        branch: "trunk",
        upstream: "origin/trunk",
        dirty: false,
        relationToUpstream: "behind",
        ahead: 0,
        behind: 1,
        blockers: [],
        manifestTracked: true,
      };
      const target: RemoteTarget = {
        kind: "default-branch",
        version: "0.3.0",
        commit: targetSha,
        ref: "refs/heads/trunk",
        sourceUrl: remote,
      };
      const deadline = Date.now() + 20_000;
      const outcome = await readPendingCommits({
        git: createGit(nodeExec(), process.env),
        cwd: work,
        checkId: "77777777-7777-4777-8777-777777777777",
        target,
        checkout,
        installSource: { kind: "directory", path: work, isGit: true },
        defaultRef: "refs/heads/trunk",
        fromCommit: beforeHead,
        staleRefs: [],
        hooksPath: hooks,
        now: Date.now,
        deadline,
        cleanupDeadline: deadline + 2_000,
      });

      expect(outcome).toEqual({
        commits: { count: 1, subjects: ["second"], truncated: false },
        staleRefs: [],
      });
      expect(git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes"], work)).toBe(
        beforeRemotes,
      );
      expect(git(["rev-parse", "HEAD"], work)).toBe(beforeHead);
      expect(existsSync(fetchHead)).toBe(false);
      expect(
        git(["for-each-ref", "--format=%(refname)", "refs/agent-team-updates/check"], work),
      ).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }, 30_000);
});

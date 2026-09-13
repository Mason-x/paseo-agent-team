import { afterEach, describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRepositoryRefreshCoordinator,
  refreshWorkspaceRequest,
  type WorkspaceCreateRequest,
} from "../server/fresh-worktrees";
import { inspectWorkspaceFreshness } from "../server/workspace-freshness";

const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createStaleRepository() {
  const root = await mkdtemp(join(tmpdir(), "fresh-worktrees-"));
  temporaryDirectories.push(root);
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const publisher = join(root, "publisher");

  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(root, "clone", remote, source);
  git(source, "config", "user.name", "Fresh Worktrees Test");
  git(source, "config", "user.email", "fresh-worktrees@example.test");
  await writeFile(join(source, "version.txt"), "one\n");
  git(source, "add", "version.txt");
  git(source, "commit", "-m", "initial");
  git(source, "push", "--set-upstream", "origin", "main");
  const staleLocalHead = git(source, "rev-parse", "main");

  git(root, "clone", remote, publisher);
  git(publisher, "config", "user.name", "Fresh Worktrees Test");
  git(publisher, "config", "user.email", "fresh-worktrees@example.test");
  await writeFile(join(publisher, "version.txt"), "two\n");
  git(publisher, "add", "version.txt");
  git(publisher, "commit", "-m", "advance remote");
  git(publisher, "push", "origin", "main");
  const currentRemoteHead = git(publisher, "rev-parse", "HEAD");
  expect(staleLocalHead).not.toBe(currentRemoteHead);

  return { root, source, staleLocalHead, currentRemoteHead };
}

describe("worktree refresh", () => {
  test("fast-forwards the clean local default branch before creating a worktree", async () => {
    const { root, source, currentRemoteHead } = await createStaleRepository();
    const worktree = join(root, "worktree");

    const request: WorkspaceCreateRequest = {
      source: {
        kind: "worktree",
        projectId: "project-1",
        action: "branch-off",
        branchName: "feature/fresh",
      },
    };
    const refreshed = await refreshWorkspaceRequest(request, {
      signal: new AbortController().signal,
      listProjects: async () => [
        {
          projectId: "project-1",
          projectRootPath: source,
          projectKind: "git",
        },
      ],
      refreshRepository: createRepositoryRefreshCoordinator(),
    });

    expect(refreshed).toBe(request);
    expect(git(source, "rev-parse", "main")).toBe(currentRemoteHead);

    git(source, "worktree", "add", "-b", "feature/fresh", worktree, "main");
    expect(git(worktree, "rev-parse", "HEAD")).toBe(currentRemoteHead);
    expect(
      await inspectWorkspaceFreshness(source, worktree, {
        signal: new AbortController().signal,
        refreshRepository: createRepositoryRefreshCoordinator(),
      }),
    ).toEqual({ kind: "current", remoteRef: "origin/main" });
  });

  test("warns and preserves a dirty local base branch", async () => {
    const { root, source, staleLocalHead, currentRemoteHead } = await createStaleRepository();
    await writeFile(join(source, "local.txt"), "uncommitted\n");
    const warnings: string[] = [];
    const request: WorkspaceCreateRequest = {
      source: {
        kind: "worktree",
        cwd: source,
        action: "branch-off",
        branchName: "feature/dirty",
      },
    };

    const refreshed = await refreshWorkspaceRequest(request, {
      signal: new AbortController().signal,
      listProjects: async () => [],
      refreshRepository: createRepositoryRefreshCoordinator(),
      warn(message) {
        warnings.push(message);
      },
    });

    expect(refreshed).toBe(request);
    expect(git(source, "rev-parse", "main")).toBe(staleLocalHead);
    expect(git(source, "rev-parse", "origin/main")).toBe(currentRemoteHead);
    expect(warnings).toEqual([
      `Skipped refreshing local branch main in ${source} because the source checkout is not clean`,
    ]);

    const worktree = join(root, "dirty-worktree");
    git(source, "worktree", "add", "-b", "feature/dirty", worktree, "main");
    expect(
      await inspectWorkspaceFreshness(source, worktree, {
        signal: new AbortController().signal,
        refreshRepository: createRepositoryRefreshCoordinator(),
      }),
    ).toEqual({ kind: "behind", remoteRef: "origin/main", behindBy: 1 });
  });

  test("leaves explicit checkout requests alone", async () => {
    const request: WorkspaceCreateRequest = {
      source: {
        kind: "worktree",
        cwd: "/unused",
        action: "checkout",
        refName: "feature/existing",
      },
    };

    const refreshed = await refreshWorkspaceRequest(request, {
      signal: new AbortController().signal,
      listProjects: async () => {
        throw new Error("Project lookup must not run");
      },
      refreshRepository: async () => {
        throw new Error("Fetch must not run");
      },
      runGit: async () => {
        throw new Error("Git inspection must not run");
      },
    });

    expect(refreshed).toBe(request);
  });

  test("allows workspace creation when fetching fails", async () => {
    const { source } = await createStaleRepository();
    const warnings: string[] = [];
    const request: WorkspaceCreateRequest = {
      source: {
        kind: "worktree",
        cwd: source,
        action: "branch-off",
        branchName: "feature/offline",
      },
    };

    const refreshed = await refreshWorkspaceRequest(request, {
      signal: new AbortController().signal,
      listProjects: async () => [],
      refreshRepository: async () => {
        throw new Error("network unavailable");
      },
      warn(message) {
        warnings.push(message);
      },
    });

    expect(refreshed).toBe(request);
    expect(warnings).toEqual([
      "Skipped refresh because fetching origin failed: network unavailable",
    ]);
  });

  test("reports freshness as unavailable when fetching fails", async () => {
    const { root, source } = await createStaleRepository();
    const worktree = join(root, "offline-worktree");
    git(source, "worktree", "add", "-b", "feature/offline", worktree, "main");

    await expect(
      inspectWorkspaceFreshness(source, worktree, {
        signal: new AbortController().signal,
        refreshRepository: async () => {
          throw new Error("network unavailable");
        },
      }),
    ).resolves.toEqual({ kind: "unavailable" });
  });
});

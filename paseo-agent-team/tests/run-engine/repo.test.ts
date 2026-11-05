import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  deliveredFiles,
  dispatchWorkspace,
  inspectRepo,
  type RepoFacts,
  verifyScopes,
} from "../../server/run-engine/repo";

/**
 * Failure modes this file guards, all against a real git repository in a temp directory:
 *  - a dirty tree, detached HEAD or unborn branch being dispatched as if it were a clean base;
 *  - two spellings of one checkout (linked worktree, case) getting different repository identities,
 *    which would let two Runs hold "the same" repo lock under different names;
 *  - a scope that leaves the repository through a junction, points into `.git`, or is an alias of
 *    another path (short name, link) being accepted as a lock key it does not really name.
 */

let root: string;

function run(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=probe",
      "-c",
      "user.email=probe@example.invalid",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    { cwd, encoding: "utf8", windowsHide: true },
  );
}

async function makeRepo(name = "repo"): Promise<string> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  run(dir, "init", "-q", "-b", "main");
  await mkdir(path.join(dir, "src"));
  await writeFile(path.join(dir, "src", "a.ts"), "export {};\n");
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", "base");
  return dir;
}

async function facts(dir: string): Promise<RepoFacts> {
  const inspected = await inspectRepo(dir);
  if (!inspected.ok) throw new Error(`inspect failed: ${inspected.detail}`);
  return inspected.repo;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "run-repo-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("inspectRepo and dispatchWorkspace", () => {
  test("a clean repository yields its real branch, commit and a stable identity", async () => {
    const dir = await makeRepo();
    const repo = await facts(dir);
    expect(repo.branch).toBe("main");
    expect(repo.headSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(repo.clean).toBe(true);
    expect(repo.repoId).toMatch(/^repo-[0-9a-f]{24}$/u);
    expect(repo.root).toBe(await realpath(dir));
    expect(dispatchWorkspace(repo, "ws-1")).toEqual({
      ok: true,
      workspace: { id: "ws-1", branch: "main", baseRef: repo.headSha },
    });
  });

  test("a directory that is not a repository is reported, not guessed", async () => {
    const dir = path.join(root, "plain");
    await mkdir(dir);
    const inspected = await inspectRepo(dir);
    expect(inspected).toMatchObject({ ok: false, reason: "not-git" });
  });

  test("untracked and modified files both make the tree dirty, and dispatch refuses it", async () => {
    const dir = await makeRepo();
    await writeFile(path.join(dir, "stray.txt"), "x");
    const untracked = await facts(dir);
    expect(untracked.clean).toBe(false);
    expect(dispatchWorkspace(untracked, "ws-1")).toEqual({ ok: false, reason: "dirty" });

    await rm(path.join(dir, "stray.txt"));
    await writeFile(path.join(dir, "src", "a.ts"), "export const changed = 1;\n");
    expect((await facts(dir)).clean).toBe(false);
  });

  test("a detached HEAD has no branch to deliver on", async () => {
    const dir = await makeRepo();
    run(dir, "checkout", "-q", "--detach");
    const repo = await facts(dir);
    expect(repo.branch).toBeNull();
    expect(dispatchWorkspace(repo, "ws-1")).toEqual({ ok: false, reason: "detached-head" });
  });

  test("a repository without a commit has no base", async () => {
    const dir = path.join(root, "empty");
    await mkdir(dir);
    run(dir, "init", "-q", "-b", "main");
    const repo = await facts(dir);
    expect(repo.headSha).toBeNull();
    expect(dispatchWorkspace(repo, "ws-1")).toEqual({ ok: false, reason: "no-commit" });
  });

  test("a linked worktree and its main checkout are one repository", async () => {
    const dir = await makeRepo();
    const linked = path.join(root, "linked");
    run(dir, "worktree", "add", "-q", linked, "-b", "task-a");
    expect((await facts(linked)).repoId).toBe((await facts(dir)).repoId);
    // Different checkouts, different trees: the working-tree root is not the identity.
    expect((await facts(linked)).root).not.toBe((await facts(dir)).root);
  });

  test.skipIf(process.platform !== "win32")(
    "the identity does not depend on how the path is cased",
    async () => {
      const dir = await makeRepo();
      const recased = dir.replace(/repo$/u, "REPO");
      expect((await facts(recased)).repoId).toBe((await facts(dir)).repoId);
    },
  );
});

describe("deliveredFiles", () => {
  function head(dir: string): string {
    return run(dir, "rev-parse", "HEAD").trim();
  }

  test("lists what the delivered commit changed against the base, renames as delete plus add", async () => {
    const dir = await makeRepo();
    const base = head(dir);
    await writeFile(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(path.join(dir, "src", "b.ts"), "export const b = 1;\n");
    run(dir, "add", "-A");
    run(dir, "commit", "-q", "-m", "work 1");
    run(dir, "mv", "src/b.ts", "src/c.ts");
    run(dir, "commit", "-q", "-m", "work 2");
    const repo = await facts(dir);
    const result = await deliveredFiles(repo, base, head(dir));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect([...result.files].sort()).toEqual(["src/a.ts", "src/c.ts"]);
    }
    // No change at all is an empty list, not an error.
    expect(await deliveredFiles(repo, head(dir), head(dir))).toEqual({ ok: true, files: [] });
  });

  test("a commit that is not on the base's line of history says nothing about the work", async () => {
    const dir = await makeRepo();
    const base = head(dir);
    run(dir, "checkout", "-q", "-b", "side");
    await writeFile(path.join(dir, "side.txt"), "x");
    run(dir, "add", "-A");
    run(dir, "commit", "-q", "-m", "side");
    const sideHead = head(dir);
    run(dir, "checkout", "-q", "main");
    await writeFile(path.join(dir, "main.txt"), "x");
    run(dir, "add", "-A");
    run(dir, "commit", "-q", "-m", "main work");
    const mainHead = head(dir);
    const repo = await facts(dir);
    expect(await deliveredFiles(repo, mainHead, sideHead)).toEqual({
      ok: false,
      reason: "not-descendant",
    });
    expect((await deliveredFiles(repo, base, mainHead)).ok).toBe(true);
  });

  test("an unknown commit and anything that is not a plain hex ref are refused before git sees them", async () => {
    const dir = await makeRepo();
    const base = head(dir);
    const repo = await facts(dir);
    expect(await deliveredFiles(repo, base, "d".repeat(40))).toEqual({
      ok: false,
      reason: "unknown-commit",
    });
    for (const bad of ["--output=evil", "main", "HEAD~1", "abc", "", `${base} --stat`]) {
      expect(await deliveredFiles(repo, base, bad)).toEqual({ ok: false, reason: "bad-ref" });
      expect(await deliveredFiles(repo, bad, base)).toEqual({ ok: false, reason: "bad-ref" });
    }
  });
});

describe("verifyScopes", () => {
  async function scopes(
    repo: RepoFacts,
    entries: { path: string; kind?: "file" | "directory"; repoId?: string }[],
  ) {
    return verifyScopes(
      repo,
      entries.map((entry) => ({
        repoId: entry.repoId ?? repo.repoId,
        kind: entry.kind ?? "file",
        path: entry.path,
        access: "write" as const,
      })),
    );
  }

  test("existing and not-yet-existing paths inside the repository verify with their declared path", async () => {
    const repo = await facts(await makeRepo());
    const result = await scopes(repo, [
      { path: "src/a.ts" },
      { path: "src/new-file.ts" },
      { path: "src", kind: "directory" },
      { path: "docs/deep/new.md" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scopes.map((scope) => scope.path)).toEqual([
        "src/a.ts",
        "src/new-file.ts",
        "src",
        "docs/deep/new.md",
      ]);
      expect(result.scopes.every((scope) => scope.verified)).toBe(true);
    }
  });

  test("a scope naming another repository is refused", async () => {
    const repo = await facts(await makeRepo());
    expect(await scopes(repo, [{ path: "src/a.ts", repoId: "repo-someone-else" }])).toEqual({
      ok: false,
      rejected: [{ path: "src/a.ts", reason: "repo-mismatch" }],
    });
  });

  test("traversal, absolute paths and the git directory are refused", async () => {
    const repo = await facts(await makeRepo());
    const result = await scopes(repo, [
      { path: "../outside.txt" },
      { path: "/etc/passwd" },
      { path: ".git/config" },
      { path: "src/.GIT/hooks/pre-commit" },
    ]);
    expect(result).toEqual({
      ok: false,
      rejected: [
        { path: "../outside.txt", reason: "invalid-path" },
        { path: "/etc/passwd", reason: "invalid-path" },
        { path: ".git/config", reason: "git-internal" },
        { path: "src/.GIT/hooks/pre-commit", reason: "git-internal" },
      ],
    });
  });

  test("a junction that leaves the repository is refused", async () => {
    const dir = await makeRepo();
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(dir, "escape"), "junction");
    const repo = await facts(dir);
    expect(await scopes(repo, [{ path: "escape/payload.ts" }])).toEqual({
      ok: false,
      rejected: [{ path: "escape/payload.ts", reason: "escapes-repo" }],
    });
  });

  test("a link to another place inside the repository is an alias, not a lock key", async () => {
    const dir = await makeRepo();
    await symlink(path.join(dir, "src"), path.join(dir, "shortcut"), "junction");
    const repo = await facts(dir);
    expect(await scopes(repo, [{ path: "shortcut/a.ts" }])).toEqual({
      ok: false,
      rejected: [{ path: "shortcut/a.ts", reason: "alias" }],
    });
  });

  test("a link whose target is gone cannot be resolved", async () => {
    const dir = await makeRepo();
    const gone = path.join(root, "gone");
    await mkdir(gone);
    await symlink(gone, path.join(dir, "dangling"), "junction");
    await rm(gone, { recursive: true });
    const repo = await facts(dir);
    expect(await scopes(repo, [{ path: "dangling/x.ts" }])).toEqual({
      ok: false,
      rejected: [{ path: "dangling/x.ts", reason: "unresolvable" }],
    });
  });

  test("a difference in case alone is the same path", async () => {
    const repo = await facts(await makeRepo());
    expect((await scopes(repo, [{ path: "SRC/A.ts" }])).ok).toBe(true);
  });

  test("a short-name spelling of an existing directory is an alias", async (context) => {
    if (process.platform !== "win32") return context.skip();
    const dir = await makeRepo();
    const long = path.join(dir, "longdirectoryname");
    await mkdir(long);
    await writeFile(path.join(long, "a.ts"), "");
    const short = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${long}').ShortPath`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim();
    if (short.toLowerCase() === long.toLowerCase()) return context.skip();
    const repo = await facts(dir);
    const shortName = path.basename(short);
    expect(await scopes(repo, [{ path: `${shortName}/a.ts` }])).toEqual({
      ok: false,
      rejected: [{ path: `${shortName}/a.ts`, reason: "alias" }],
    });
  });

  test("a short-name spelling of a path that does not exist yet is refused", async () => {
    const repo = await facts(await makeRepo());
    expect(await scopes(repo, [{ path: "NEWDIR~1/file.ts" }])).toEqual({
      ok: false,
      rejected: [{ path: "NEWDIR~1/file.ts", reason: "short-name" }],
    });
  });

  test("one bad scope rejects the whole set", async () => {
    const repo = await facts(await makeRepo());
    const result = await scopes(repo, [{ path: "src/a.ts" }, { path: ".git/HEAD" }]);
    expect(result.ok).toBe(false);
  });
});

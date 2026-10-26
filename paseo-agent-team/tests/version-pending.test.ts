import path from "node:path";
import { describe, expect, test } from "vitest";
import { gitOk } from "../server/version/git";
import type { Checkout } from "../server/version/local-install";
import {
  type PendingInput,
  readPendingCommits,
  sanitizeCommitSubject,
} from "../server/version/pending";
import type { ExecResult, FilesPort } from "../server/version/process";
import { createVersionService } from "../server/version/service";
import { storeRoot } from "../server/version/store";
import type { RemoteTarget, VersionInfo } from "../shared/version";

const HOME = path.join("C:\\", "paseo-dev");
const PLUGIN = path.join("C:\\", "repo", "paseo-agent-team");
const REPOSITORY = path.join("C:\\", "repo");
const REMOTE = "https://github.com/Mason-x/paseo-agent-team.git";
const OLD = "a".repeat(40);
const TARGET = "b".repeat(40);
const TAG_OBJECT = "c".repeat(40);
const JOB = "11111111-1111-4111-8111-111111111111";
const CHECK = "22222222-2222-4222-8222-222222222222";
const JOB_2 = "44444444-4444-4444-8444-444444444444";
const CHECK_2 = "55555555-5555-4555-8555-555555555555";
const REQUEST = "33333333-3333-4333-8333-333333333333";
const REQUEST_2 = "66666666-6666-4666-8666-666666666666";
const PRIVATE = `refs/agent-team-updates/check/${CHECK}`;
const PRIVATE_2 = `refs/agent-team-updates/check/${CHECK_2}`;
const STALE_FILE = path.join(storeRoot(HOME, "server-1"), "checks", "pending-commits-refs.json");
const HOOKS = path.join(storeRoot(HOME, "server-1"), "checks", "hooks");
const GIT_ISOLATION = `-c core.hooksPath=${HOOKS} -c gc.auto=0 -c maintenance.auto=false`;

function ok(stdout = "", exitCode = 0): ExecResult {
  return { exitCode, stdout, stderr: "", timedOut: false, truncated: false };
}

function timedOut(): ExecResult {
  return { exitCode: null, stdout: "", stderr: "", timedOut: true, truncated: false };
}

type MemoryFiles = FilesPort & { data: Map<string, string> };

function memoryFiles(initial: Record<string, string>): MemoryFiles {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async readText(file) {
      const text = data.get(file);
      if (text === undefined) throw new Error(`missing ${file}`);
      return text;
    },
    async writeAtomic(file, text) {
      data.set(file, text);
    },
    async exclusiveCreate(file, text) {
      if (data.has(file)) return false;
      data.set(file, text);
      return true;
    },
    async remove(file) {
      data.delete(file);
    },
  };
}

function seededFiles(): MemoryFiles {
  return memoryFiles({
    [path.join(HOME, "server-id")]: "server-1",
    [path.join(PLUGIN, "package.json")]: JSON.stringify({
      name: "@mason-x/paseo-agent-team",
      version: "0.2.3",
    }),
    [path.join(PLUGIN, "paseo-plugin.json")]: JSON.stringify({ id: "paseo-agent-team" }),
    [path.join(PLUGIN, "node_modules", "@getpaseo", "cli", "dist", "index.js")]: "export {}\n",
  });
}

type GitOptions = {
  targetLocal?: boolean;
  noTags?: boolean;
  dirty?: string;
  aheadBehind?: string;
  upstream?: string | null;
  branch?: string;
  fetch?: "ok" | "fail" | "throw" | "throw-after-add" | "timeout";
  resolveRef?: ExecResult;
  count?: ExecResult;
  log?: ExecResult;
  updateRef?: (attempt: number) => ExecResult;
  updateRefLeavesRef?: boolean;
  initialRefs?: string[];
};

type GitHarness = {
  run: (request: { args: readonly string[] }) => Promise<ExecResult>;
  calls: string[];
  privateRefs: Set<string>;
  options: GitOptions;
  updateRefCalls: () => number;
};

function gitHarness(options: GitOptions = {}): GitHarness {
  const calls: string[] = [];
  const privateRefs = new Set(options.initialRefs ?? []);
  const targetLocal = options.targetLocal ?? false;
  const branch = options.branch ?? "trunk";
  const upstream = options.upstream === undefined ? "origin/trunk" : options.upstream;
  let updateRefCount = 0;
  const run = async (request: { args: readonly string[] }): Promise<ExecResult> => {
    const joined = request.args.join(" ");
    calls.push(joined);
    if (joined.includes("--show-toplevel")) return ok(REPOSITORY);
    if (joined === "rev-parse HEAD") return ok(OLD);
    if (joined.includes("--left-right")) return ok(options.aheadBehind ?? "0\t1");
    if (joined.startsWith("rev-parse --abbrev-ref --symbolic-full-name @{upstream}"))
      return upstream === null ? ok("", 1) : ok(upstream);
    if (joined.includes("--abbrev-ref") && joined.includes("HEAD")) return ok(branch);
    if (joined.includes("porcelain")) return ok(options.dirty ?? "");
    if (
      joined.includes("MERGE_HEAD") ||
      joined.includes("CHERRY_PICK_HEAD") ||
      joined.includes("REVERT_HEAD") ||
      joined.includes("--git-path")
    )
      return ok("", 1);
    if (joined.includes("ls-files")) return ok("paseo-agent-team/paseo-plugin.json");
    if (joined.includes("get-url")) return ok(REMOTE);
    if (joined.includes("ls-remote --symref"))
      return ok(`ref: refs/heads/trunk HEAD\n${TARGET} HEAD\n`);
    if (joined.includes("ls-remote --tags"))
      return options.noTags ? ok("") : ok(`${TARGET} refs/tags/paseo-agent-team-v0.3.0\n`);
    if (joined.includes("cat-file")) return targetLocal ? ok() : ok("", 1);
    if (joined.includes("merge-base --is-ancestor")) return targetLocal ? ok() : ok("", 1);
    if (request.args.includes("fetch")) {
      if (options.fetch === "throw") throw new Error("fetch failed");
      if (options.fetch === "fail") return ok("", 1);
      const destination = request.args[request.args.length - 1]?.split(":").at(-1) ?? "";
      privateRefs.add(destination);
      if (options.fetch === "throw-after-add") throw new Error("fetch failed after ref");
      if (options.fetch === "timeout") return timedOut();
      return ok();
    }
    if (joined === `rev-parse --verify ${PRIVATE}^{commit}`)
      return options.resolveRef ?? ok(TARGET);
    if (joined === `rev-parse --verify ${PRIVATE_2}^{commit}`)
      return options.resolveRef ?? ok(TARGET);
    if (joined === `rev-parse --verify ${PRIVATE}`) return ok(TAG_OBJECT);
    if (joined === `rev-parse --verify ${PRIVATE_2}`) return ok(TAG_OBJECT);
    if (joined === `rev-list --count ${OLD}..${TARGET}`) return options.count ?? ok("2\n");
    if (joined === `log --format=%s -n 10 ${OLD}..${TARGET}`)
      return options.log ?? ok("fix bug\nadd feature\n");
    if (request.args.includes("update-ref")) {
      updateRefCount += 1;
      const ref = request.args[request.args.length - 1] ?? "";
      const result = options.updateRef?.(updateRefCount) ?? ok();
      if (gitOk(result) && !options.updateRefLeavesRef) privateRefs.delete(ref);
      return result;
    }
    if (request.args.includes("show-ref")) {
      const ref = request.args[request.args.length - 1] ?? "";
      return privateRefs.has(ref) ? ok() : ok("", 1);
    }
    return ok("", 1);
  };
  return {
    run,
    calls,
    privateRefs,
    options,
    updateRefCalls: () => updateRefCount,
  };
}

type ServiceOptions = { ids?: string[]; now?: () => number; request?: string };

function serviceDeps(files: MemoryFiles, git: GitHarness, options: ServiceOptions = {}) {
  const ids = [...(options.ids ?? [JOB, CHECK])];
  return {
    env: { PASEO_HOME: HOME },
    files,
    exec: { run: async () => ok("ok\n") },
    git,
    clock: {
      now: () => Date.parse("2026-10-25T00:00:00.000Z"),
      iso: () => "2026-10-25T00:00:00.000Z",
    },
    ids: { uuid: () => ids.shift() ?? "99999999-9999-4999-8999-999999999999" },
    fetch: async () => ({
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ name: "@mason-x/paseo-agent-team", version: "0.3.0" }),
    }),
    bootId: "77777777-7777-4777-8777-777777777777",
    platform: "win32" as const,
    pathExists: () => true,
    cliExists: async (candidate: string) => files.data.has(candidate),
    now: options.now,
  };
}

const paseo = {
  config: {
    get: async () => ({
      config: { plugins: { "paseo-agent-team": { source: "directory", path: PLUGIN } } },
    }),
  },
};

async function checkWith(
  git: GitHarness,
  options: ServiceOptions = {},
  files = seededFiles(),
): Promise<{ info: VersionInfo; state: string }> {
  const versions = createVersionService(serviceDeps(files, git, options));
  const checked = await versions.check(paseo, options.request ?? REQUEST);
  if (!checked.ok || !checked.job.result) throw new Error("check failed");
  return { info: checked.job.result, state: checked.job.state };
}

describe("pending commits", () => {
  test("an already local target is counted from the frozen HEAD without a fetch", async () => {
    const git = gitHarness({ targetLocal: true, count: ok("2\n") });
    const { info } = await checkWith(git);
    expect(info.pendingCommits).toEqual({
      count: 2,
      subjects: ["fix bug", "add feature"],
      truncated: false,
    });
    expect(git.calls).toContain(`rev-list --count ${OLD}..${TARGET}`);
    expect(git.calls.some((call) => call.includes(" fetch "))).toBe(false);
    expect(git.calls.some((call) => call.includes("update-ref"))).toBe(false);
  });

  test("a missing tag target is fetched with an isolated refspec into a private ref", async () => {
    const git = gitHarness({ targetLocal: false });
    const { info } = await checkWith(git);
    expect(info.pendingCommits).toEqual({
      count: 2,
      subjects: ["fix bug", "add feature"],
      truncated: false,
    });
    expect(git.calls).toContain(
      `${GIT_ISOLATION} fetch --no-tags --no-write-fetch-head --refmap= --no-prune --no-prune-tags --no-recurse-submodules origin refs/tags/paseo-agent-team-v0.3.0:${PRIVATE}`,
    );
    expect(git.calls).toContain(`rev-parse --verify ${PRIVATE}^{commit}`);
    expect(git.calls).not.toContain(`rev-parse --verify ${PRIVATE}`);
    expect(git.calls).toContain(`${GIT_ISOLATION} update-ref -d ${PRIVATE}`);
    expect(git.calls).toContain(`show-ref --verify --quiet ${PRIVATE}`);
    expect(git.privateRefs.size).toBe(0);
  });

  test("a missing default-branch target uses the same isolated fetch", async () => {
    const git = gitHarness({ targetLocal: false, noTags: true });
    const { info } = await checkWith(git);
    expect(info.remote.installTarget?.kind).toBe("default-branch");
    expect(git.calls).toContain(
      `${GIT_ISOLATION} fetch --no-tags --no-write-fetch-head --refmap= --no-prune --no-prune-tags --no-recurse-submodules origin refs/heads/trunk:${PRIVATE}`,
    );
    expect(info.pendingCommits?.count).toBe(2);
  });

  test("annotated tags are peeled to the frozen commit before comparison", async () => {
    const git = gitHarness({ targetLocal: false });
    const { info } = await checkWith(git);
    expect(info.pendingCommits?.count).toBe(2);
    expect(git.calls).toContain(`rev-parse --verify ${PRIVATE}^{commit}`);
    expect(git.calls).not.toContain(`rev-parse --verify ${PRIVATE}`);
    expect(git.privateRefs.size).toBe(0);
  });

  test("a fetched tag that no longer matches the frozen commit is discarded and cleaned", async () => {
    const git = gitHarness({ targetLocal: false, resolveRef: ok(TAG_OBJECT) });
    const { info } = await checkWith(git);
    expect(info.pendingCommits).toBeNull();
    expect(info.pendingCommitsDiagnostics).toBeUndefined();
    expect(git.calls).not.toContain(`rev-list --count ${OLD}..${TARGET}`);
    expect(git.calls).toContain(`${GIT_ISOLATION} update-ref -d ${PRIVATE}`);
    expect(git.privateRefs.size).toBe(0);
  });

  test("a fetched ref that does not peel to a commit is discarded and cleaned", async () => {
    const git = gitHarness({ targetLocal: false, resolveRef: ok("", 1) });
    const { info } = await checkWith(git);
    expect(info.pendingCommits).toBeNull();
    expect(git.calls).not.toContain(`rev-list --count ${OLD}..${TARGET}`);
    expect(git.privateRefs.size).toBe(0);
  });

  test("a dirty worktree never fetches and leaves pending commits unknown", async () => {
    const git = gitHarness({ targetLocal: false, dirty: " M file.ts\0" });
    const { info } = await checkWith(git);
    expect(info.pendingCommits).toBeNull();
    expect(info.blockers.map((item) => item.code)).toContain("dirty");
    expect(info.canUpdate).toBe(false);
    expect(git.calls.some((call) => call.includes(" fetch "))).toBe(false);
  });

  test("a local ahead or diverged branch never fetches", async () => {
    for (const aheadBehind of ["1\t0", "1\t1"]) {
      const git = gitHarness({ targetLocal: false, aheadBehind });
      const { info } = await checkWith(git);
      expect(info.pendingCommits).toBeNull();
      expect(git.calls.some((call) => call.includes(" fetch "))).toBe(false);
    }
  });

  test("a branch that is not on the remote default branch never fetches", async () => {
    const git = gitHarness({ targetLocal: false, upstream: "origin/feature" });
    const { info } = await checkWith(git);
    expect(info.pendingCommits).toBeNull();
    expect(info.blockers.map((item) => item.code)).toContain("branch_mismatch");
    expect(git.calls.some((call) => call.includes(" fetch "))).toBe(false);
  });

  test("a branch tracking another remote name never fetches through origin", async () => {
    const git = gitHarness({ targetLocal: false, upstream: "backup/trunk" });
    const { info } = await checkWith(git);
    expect(info.pendingCommits).toBeNull();
    expect(git.calls.some((call) => call.includes(" fetch "))).toBe(false);
  });

  test("more than ten commits are truncated to ten subjects", async () => {
    const subjects = Array.from({ length: 10 }, (_, index) => `change ${index}`);
    const git = gitHarness({
      targetLocal: true,
      count: ok("12\n"),
      log: ok(`${subjects.join("\n")}\n`),
    });
    const { info } = await checkWith(git);
    expect(info.pendingCommits).toEqual({ count: 12, subjects, truncated: true });
  });

  test("control characters are removed and long subjects are capped", async () => {
    const git = gitHarness({
      targetLocal: true,
      count: ok("2\n"),
      log: ok(`${"x".repeat(250)}\nbad\u0000title\u001b[31m\n`),
    });
    const { info } = await checkWith(git);
    expect(info.pendingCommits?.subjects[0]).toHaveLength(200);
    expect(info.pendingCommits?.subjects[1]).toBe("badtitle[31m");
    expect(info.pendingCommits?.subjects.join("")).not.toMatch(/\p{Cc}/u);
    expect(sanitizeCommitSubject("😀".repeat(150))).toHaveLength(200);
  });

  test("a failed fetch leaves the check result intact", async () => {
    const git = gitHarness({ targetLocal: false, fetch: "fail" });
    const { info, state } = await checkWith(git);
    expect(state).toBe("succeeded");
    expect(info.pendingCommits).toBeNull();
    expect(info.remote.installTarget?.commit).toBe(TARGET);
    expect(info.relation).toBe("unknown");
    expect(info.checkId).toBe(CHECK);
    expect(info.updateAvailable).toBe(true);
    expect(git.calls).toContain(`${GIT_ISOLATION} update-ref -d ${PRIVATE}`);
    expect(git.privateRefs.size).toBe(0);
  });

  test("a thrown fetch is a null pending list, not a failed check", async () => {
    const git = gitHarness({ targetLocal: false, fetch: "throw" });
    const { info, state } = await checkWith(git);
    expect(state).toBe("succeeded");
    expect(info.pendingCommits).toBeNull();
    expect(info.remote.installTarget?.commit).toBe(TARGET);
  });

  test("a fetch timeout after the ref lands still removes it", async () => {
    const git = gitHarness({ targetLocal: false, fetch: "timeout" });
    const { info } = await checkWith(git);
    expect(info.pendingCommits).toBeNull();
    expect(git.privateRefs.size).toBe(0);
    expect(git.calls).toContain(`show-ref --verify --quiet ${PRIVATE}`);
  });

  test("a fetch throwing after the ref lands still removes it", async () => {
    const git = gitHarness({ targetLocal: false, fetch: "throw-after-add" });
    const { info } = await checkWith(git);
    expect(info.pendingCommits).toBeNull();
    expect(git.privateRefs.size).toBe(0);
  });

  test("a counting failure still removes the private ref", async () => {
    const git = gitHarness({ targetLocal: false, count: ok("", 1) });
    const { info } = await checkWith(git);
    expect(info.pendingCommits).toBeNull();
    expect(git.calls).toContain(`${GIT_ISOLATION} update-ref -d ${PRIVATE}`);
    expect(git.privateRefs.size).toBe(0);
  });

  test("a timed out count leaves a successful check but no commit list", async () => {
    const git = gitHarness({ targetLocal: false, count: timedOut() });
    const { info, state } = await checkWith(git);
    expect(state).toBe("succeeded");
    expect(info.pendingCommits).toBeNull();
    expect(info.remote.installTarget?.commit).toBe(TARGET);
    expect(git.privateRefs.size).toBe(0);
  });

  test("cleanup retries after one failed delete and verifies the ref is gone", async () => {
    const git = gitHarness({
      targetLocal: false,
      updateRef: (attempt) => (attempt === 1 ? ok("", 1) : ok()),
    });
    const { info } = await checkWith(git);
    expect(info.pendingCommits?.count).toBe(2);
    expect(info.pendingCommitsDiagnostics).toBeUndefined();
    expect(git.updateRefCalls()).toBe(2);
    expect(git.privateRefs.size).toBe(0);
  });

  test("a delete that reports success but leaves the ref is retried and reported", async () => {
    const git = gitHarness({ targetLocal: false, updateRefLeavesRef: true });
    const { info } = await checkWith(git);
    expect(info.pendingCommits).toBeNull();
    expect(info.pendingCommitsDiagnostics).toEqual({ staleRefs: [PRIVATE] });
    expect(git.updateRefCalls()).toBe(3);
    expect(git.privateRefs.has(PRIVATE)).toBe(true);
  });

  test("persistent cleanup failure is visible, keeps the ref, and is recorded", async () => {
    const files = seededFiles();
    const git = gitHarness({ targetLocal: false, updateRef: () => ok("", 1) });
    const { info, state } = await checkWith(git, {}, files);
    expect(state).toBe("succeeded");
    expect(info.pendingCommits).toBeNull();
    expect(info.pendingCommitsDiagnostics).toEqual({ staleRefs: [PRIVATE] });
    expect(git.updateRefCalls()).toBe(3);
    expect(git.privateRefs.has(PRIVATE)).toBe(true);
    expect(files.data.get(STALE_FILE)).toContain(PRIVATE);
  });

  test("the next check cleans a recorded stale ref before doing its own work", async () => {
    const files = seededFiles();
    const options: GitOptions = { targetLocal: false, updateRef: () => ok("", 1) };
    const git = gitHarness(options);
    const first = await checkWith(git, { ids: [JOB, CHECK] }, files);
    expect(first.info.pendingCommitsDiagnostics).toEqual({ staleRefs: [PRIVATE] });

    options.updateRef = () => ok();
    const second = await checkWith(git, { ids: [JOB_2, CHECK_2], request: REQUEST_2 }, files);
    expect(second.info.pendingCommits?.count).toBe(2);
    expect(second.info.pendingCommitsDiagnostics).toBeUndefined();
    expect(git.privateRefs.has(PRIVATE)).toBe(false);
    expect(git.privateRefs.has(PRIVATE_2)).toBe(false);
    expect(files.data.has(STALE_FILE)).toBe(false);
  });

  test("a ref recorded before a crashed check is cleaned on the next start", async () => {
    const files = seededFiles();
    files.data.set(STALE_FILE, JSON.stringify({ refs: [PRIVATE] }));
    const git = gitHarness({ targetLocal: false, initialRefs: [PRIVATE] });
    const { info } = await checkWith(git, {}, files);
    expect(info.pendingCommits?.count).toBe(2);
    expect(info.pendingCommitsDiagnostics).toBeUndefined();
    expect(git.privateRefs.size).toBe(0);
    expect(files.data.has(STALE_FILE)).toBe(false);
  });

  test("the pending stage is skipped when the main check has nearly exhausted its budget", async () => {
    const git = gitHarness({ targetLocal: false });
    let tick = 0;
    const now = () => (tick++ === 0 ? 0 : 23_000);
    const { info, state } = await checkWith(git, { now });
    expect(state).toBe("succeeded");
    expect(info.pendingCommits).toBeNull();
    expect(info.remote.installTarget?.commit).toBe(TARGET);
    expect(git.calls.some((call) => call.includes(" fetch "))).toBe(false);
    expect(git.calls.some((call) => call.startsWith("rev-list --count"))).toBe(false);
    expect(git.calls.some((call) => call.startsWith("log --format"))).toBe(false);
  });

  test("a target without a commit or a safe ref is not fetched", async () => {
    const checkout: Checkout = {
      pluginPath: PLUGIN,
      repositoryPath: REPOSITORY,
      commit: OLD,
      branch: "trunk",
      upstream: "origin/trunk",
      dirty: false,
      relationToUpstream: "behind",
      ahead: 0,
      behind: 1,
      blockers: [],
      manifestTracked: true,
    };
    const calls: string[] = [];
    const git = {
      async run(request: { args: readonly string[] }): Promise<ExecResult> {
        calls.push(request.args.join(" "));
        return ok("", 1);
      },
    };
    const base: PendingInput = {
      git,
      cwd: REPOSITORY,
      checkId: CHECK,
      checkout,
      installSource: { kind: "directory", path: PLUGIN, isGit: true },
      defaultRef: "refs/heads/trunk",
      fromCommit: OLD,
      staleRefs: [],
      hooksPath: HOOKS,
      now: () => 0,
      deadline: 10_000,
      cleanupDeadline: 12_000,
      target: {
        kind: "release-tag",
        version: "0.3.0",
        commit: null,
        ref: "refs/tags/paseo-agent-team-v0.3.0",
        sourceUrl: REMOTE,
      },
    };
    expect(await readPendingCommits(base)).toEqual({ commits: null, staleRefs: [] });
    const noRef: RemoteTarget = { ...base.target, commit: TARGET, ref: null };
    expect(await readPendingCommits({ ...base, target: noRef })).toEqual({
      commits: null,
      staleRefs: [],
    });
    expect(calls.some((call) => call.includes(" fetch "))).toBe(false);
  });
});

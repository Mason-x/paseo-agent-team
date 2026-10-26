import type { InstallSource, PendingCommits, RemoteTarget } from "../../shared/version";
import { asSha, type GitPort, gitOk, gitText, safeRef } from "./git";
import type { Checkout } from "./local-install";
import { objectPresent } from "./remote";

const MAX_SUBJECTS = 10;
const MAX_SUBJECT_LENGTH = 200;
const PRIVATE_PREFIX = "refs/agent-team-updates/check/";
const CLEANUP_ATTEMPTS = 3;

/** Upper bound for the optional commit list, excluding cleanup. */
export const PENDING_COMMITS_BUDGET_MS = 4_000;
/** Cleanup may run after the commit list budget and gets its own slice. */
export const PENDING_CLEANUP_BUDGET_MS = 2_000;
/** Keep this much of the overall check budget for cleanup after the list stage. */
export const PENDING_CLEANUP_RESERVE_MS = 3_000;
/** Stay clear of the outer check deadline so a completed stage is not discarded. */
export const PENDING_OUTER_MARGIN_MS = 1_000;

export type PendingInput = {
  git: GitPort;
  cwd: string;
  checkId: string;
  target: RemoteTarget;
  checkout: Checkout | null;
  installSource: InstallSource;
  defaultRef: string | null;
  /** Frozen HEAD from the check, so the count and the displayed current commit agree. */
  fromCommit: string | null;
  /** Exact refs recorded by an earlier failed cleanup. */
  staleRefs: readonly string[];
  /** Empty directory used to disable repository hooks for the two write commands. */
  hooksPath: string;
  now: () => number;
  /** Absolute deadline for the optional list work. */
  deadline: number;
  /** Absolute deadline for cleanup, including retries. */
  cleanupDeadline: number;
};

export type PendingOutcome = {
  commits: PendingCommits | null;
  staleRefs: string[];
};

export function privateRefFor(checkId: string): string {
  return `${PRIVATE_PREFIX}${checkId}`;
}

export function isPrivateRef(ref: string): boolean {
  return ref.startsWith(PRIVATE_PREFIX) && ref.length > PRIVATE_PREFIX.length && safeRef(ref);
}

function isControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/** Strip control characters and cap the result at the schema's UTF-16 limit. */
export function sanitizeCommitSubject(raw: string): string {
  const clean = [...raw].filter((char) => !isControl(char)).join("");
  let subject = "";
  for (const char of clean) {
    if (subject.length + char.length > MAX_SUBJECT_LENGTH) break;
    subject += char;
  }
  return subject;
}

/**
 * Commits fromCommit..target, newest first. The target is read without fetching
 * when present. A missing target is fetched only for a clean directory checkout
 * that tracks the remote default branch, into a per-check private ref that is
 * removed before this returns. Cleanup is verified and retried; a ref that
 * survives is returned so the caller can persist it for the next check.
 */
export async function readPendingCommits(input: PendingInput): Promise<PendingOutcome> {
  const sha = asSha(input.target.commit ?? "");
  const privateRef = privateRefFor(input.checkId);
  if (!sha || !isPrivateRef(privateRef)) return { commits: null, staleRefs: [] };
  const from = asSha(input.fromCommit ?? "") ?? "HEAD";
  let computed: PendingCommits | null = null;
  let fetchAttempted = false;
  let staleRefs = dedupeRefs(input.staleRefs);
  try {
    staleRefs = await cleanRefs(input, staleRefs, input.deadline);
    const probeMs = remaining(input.deadline, input.now());
    if (probeMs <= 0) return { commits: null, staleRefs };
    const present = await objectPresent(input.git, input.cwd, sha, probeMs);
    if (present) {
      computed = await countCommits(input, from, sha);
    } else if (canFetch(input)) {
      const ref = input.target.ref;
      if (!ref || !safeRef(ref) || !(ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/")))
        return { commits: null, staleRefs };
      const fetchMs = remaining(input.deadline, input.now());
      if (fetchMs <= 0) return { commits: null, staleRefs };
      fetchAttempted = true;
      const result = await input.git.run({
        args: isolatedGitArgs(input.hooksPath, [
          "fetch",
          "--no-tags",
          "--no-write-fetch-head",
          "--refmap=",
          "--no-prune",
          "--no-prune-tags",
          "--no-recurse-submodules",
          "origin",
          `${ref}:${privateRef}`,
        ]),
        cwd: input.cwd,
        timeoutMs: fetchMs,
      });
      if (gitOk(result)) {
        const verifyMs = remaining(input.deadline, input.now());
        if (verifyMs > 0) {
          const resolved = await input.git.run({
            args: ["rev-parse", "--verify", `${privateRef}^{commit}`],
            cwd: input.cwd,
            timeoutMs: verifyMs,
          });
          if (gitOk(resolved) && asSha(gitText(resolved)) === sha) {
            computed = await countCommits(input, from, sha);
          }
        }
      }
    }
  } catch {
    computed = null;
  }
  if (fetchAttempted) {
    const removed = await removePrivateRef(input, privateRef, input.cleanupDeadline);
    if (removed) {
      staleRefs = staleRefs.filter((ref) => ref !== privateRef);
    } else {
      staleRefs = dedupeRefs([...staleRefs, privateRef]);
      computed = null;
    }
  }
  return { commits: computed, staleRefs };
}

function canFetch(input: PendingInput): boolean {
  if (input.installSource.kind !== "directory" || !input.installSource.isGit) return false;
  const checkout = input.checkout;
  if (checkout?.dirty !== false) return false;
  if (!checkout.branch || !checkout.upstream) return false;
  if (checkout.ahead !== null && checkout.ahead > 0) return false;
  if (checkout.relationToUpstream !== "behind" && checkout.relationToUpstream !== "equal")
    return false;
  const defaultRef = input.defaultRef;
  if (!defaultRef?.startsWith("refs/heads/")) return false;
  if (!safeRef(defaultRef)) return false;
  const branch = defaultRef.slice("refs/heads/".length);
  return branch.length > 0 && checkout.upstream === `origin/${branch}`;
}

function remaining(deadline: number, now: number): number {
  return Math.max(0, Math.floor(deadline - now));
}

/** Match the runner's hook isolation for every command that can write the repository. */
function isolatedGitArgs(hooksPath: string, args: readonly string[]): string[] {
  return [
    "-c",
    `core.hooksPath=${hooksPath}`,
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
    ...args,
  ];
}

async function countCommits(
  input: PendingInput,
  from: string,
  sha: string,
): Promise<PendingCommits | null> {
  const countMs = remaining(input.deadline, input.now());
  if (countMs <= 0) return null;
  const countResult = await input.git.run({
    args: ["rev-list", "--count", `${from}..${sha}`],
    cwd: input.cwd,
    timeoutMs: countMs,
  });
  if (!gitOk(countResult)) return null;
  const countText = gitText(countResult);
  if (!/^(?:0|[1-9]\d*)$/.test(countText)) return null;
  const count = Number(countText);
  if (!Number.isSafeInteger(count)) return null;
  const logMs = remaining(input.deadline, input.now());
  if (logMs <= 0) return null;
  const logResult = await input.git.run({
    args: ["log", "--format=%s", "-n", String(MAX_SUBJECTS), `${from}..${sha}`],
    cwd: input.cwd,
    timeoutMs: logMs,
  });
  if (!gitOk(logResult)) return null;
  const lines = logResult.stdout.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const subjects = lines.slice(0, MAX_SUBJECTS).map(sanitizeCommitSubject);
  return { count, subjects, truncated: count > subjects.length };
}

function dedupeRefs(refs: readonly string[]): string[] {
  return [...new Set(refs.filter((ref) => isPrivateRef(ref)))];
}

async function cleanRefs(
  input: PendingInput,
  refs: readonly string[],
  deadline: number,
): Promise<string[]> {
  const remainingRefs: string[] = [];
  for (const ref of refs) {
    if (!(await removePrivateRef(input, ref, deadline))) remainingRefs.push(ref);
  }
  return remainingRefs;
}

/** Delete one exact private ref, verify it is gone, and retry within the deadline. */
async function removePrivateRef(
  input: PendingInput,
  ref: string,
  deadline: number,
): Promise<boolean> {
  if (!isPrivateRef(ref)) return true;
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
    const deleteMs = remaining(deadline, input.now());
    if (deleteMs <= 0) return false;
    try {
      const removed = await input.git.run({
        args: isolatedGitArgs(input.hooksPath, ["update-ref", "-d", ref]),
        cwd: input.cwd,
        timeoutMs: deleteMs,
      });
      if (!gitOk(removed)) continue;
      const verifyMs = remaining(deadline, input.now());
      if (verifyMs <= 0) return false;
      const verify = await input.git.run({
        args: ["show-ref", "--verify", "--quiet", ref],
        cwd: input.cwd,
        timeoutMs: verifyMs,
      });
      if (!verify.timedOut && verify.exitCode === 1) return true;
    } catch {
      // Retry until this ref's cleanup budget is exhausted.
    }
  }
  return false;
}

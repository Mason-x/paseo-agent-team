import {
  PACKAGE_NAME,
  RELEASE_TAG_PREFIX,
  type RemoteTarget,
  type Sha,
} from "../../shared/version";
import { asSha, type GitPort, gitOk, gitText, safeRef } from "./git";

const PACKAGE_JSON_LIMIT = 64 * 1024;
const REDIRECT_LIMIT = 3;

export type RemoteRef = { name: string; sha: Sha; peeled: boolean };

export type SelectedRelease = {
  target: RemoteTarget;
  tag: string | null;
  /** True when the version came from the tag name and still needs package.json confirmation. */
  needsPackage: boolean;
};

/** Lightweight and annotated tags. Annotated tags keep the peeled `^{}` object. */
export function parseLsRemoteTags(stdout: string): RemoteRef[] {
  const peeled = new Set<string>();
  const rows: RemoteRef[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([0-9a-f]{40,64})\s+refs\/tags\/(.+)$/i);
    if (!match?.[1] || !match[2]) continue;
    const sha = asSha(match[1]);
    if (!sha) continue;
    const raw = match[2];
    if (raw.endsWith("^{}")) {
      peeled.add(raw.slice(0, -3));
      rows.push({ name: raw.slice(0, -3), sha, peeled: true });
    } else {
      rows.push({ name: raw, sha, peeled: false });
    }
  }
  const byName = new Map<string, RemoteRef>();
  for (const row of rows) {
    const current = byName.get(row.name);
    if (!current || row.peeled || peeled.has(row.name)) {
      if (row.peeled || !peeled.has(row.name)) byName.set(row.name, row);
    }
  }
  return [...byName.values()];
}

export type Semver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  raw: string;
};

/** Stable semver only. Pre-release and build metadata are rejected by the caller. */
export function parseSemver(raw: string): Semver | null {
  if (raw.includes("+")) return null;
  const match = raw.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,
  );
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
    raw,
  };
}

export function compareSemver(left: Semver, right: Semver): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

export type TagChoice = { tag: string; version: Semver; sha: Sha };

/** Highest stable `paseo-agent-team-v<semver>` tag. Pre-releases never win. */
export function selectReleaseTag(refs: readonly RemoteRef[]): TagChoice | null {
  let best: TagChoice | null = null;
  for (const ref of refs) {
    if (!ref.name.startsWith(RELEASE_TAG_PREFIX)) continue;
    const versionText = ref.name.slice(RELEASE_TAG_PREFIX.length);
    const version = parseSemver(versionText);
    if (!version || version.prerelease.length > 0) continue;
    if (!best || compareSemver(version, best.version) > 0) {
      best = { tag: ref.name, version, sha: ref.sha };
    }
  }
  return best;
}

export type DefaultBranch = { ref: string; sha: Sha };

/** `git ls-remote --symref` HEAD line. Missing symref is unknown, not `main`. */
export function parseSymrefHead(stdout: string): DefaultBranch | null {
  let ref: string | null = null;
  let sha: Sha | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const sym = line.match(/^ref:\s+(refs\/heads\/\S+)\s+HEAD$/);
    if (sym?.[1] && safeRef(sym[1])) ref = sym[1];
    const head = line.match(/^([0-9a-f]{40,64})\s+HEAD$/i);
    if (head?.[1]) sha = asSha(head[1]);
  }
  if (!ref || !sha) return null;
  return { ref, sha };
}

export function releaseTarget(choice: TagChoice, sourceUrl: string | null): RemoteTarget {
  return {
    kind: "release-tag",
    version: choice.version.raw,
    commit: choice.sha,
    ref: `refs/tags/${choice.tag}`,
    sourceUrl,
  };
}

export function branchTarget(
  branch: DefaultBranch,
  version: string | null,
  sourceUrl: string | null,
): RemoteTarget {
  return {
    kind: "default-branch",
    version,
    commit: branch.sha,
    ref: branch.ref,
    sourceUrl,
  };
}

export type FetchLike = (
  url: string,
  init: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export type PackageRead =
  | { name: string; version: string }
  | { error: "network" | "invalid" | "mismatch" | "rate" };

/** Public GitHub raw content at an exact SHA. Redirects stay on the same host. */
export async function readGithubPackage(input: {
  remote: string;
  sha: Sha;
  pluginPath: string;
  fetch: FetchLike;
  timeoutMs: number;
}): Promise<PackageRead> {
  const slug = githubSlug(input.remote);
  if (!slug) return { error: "invalid" };
  const relative = pluginPackagePath(input.pluginPath);
  if (!relative) return { error: "invalid" };
  const url = `https://raw.githubusercontent.com/${slug}/${input.sha}/${relative}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    let current = url;
    for (let hop = 0; hop <= REDIRECT_LIMIT; hop += 1) {
      const response = await input.fetch(current, {
        signal: controller.signal,
        headers: { accept: "application/json, text/plain" },
      });
      if (
        response.status === 301 ||
        response.status === 302 ||
        response.status === 307 ||
        response.status === 308
      ) {
        const location = response.headers.get("location");
        if (!location) return { error: "network" };
        const next = new URL(location, current);
        if (next.protocol !== "https:" || next.host !== "raw.githubusercontent.com")
          return { error: "network" };
        current = next.toString();
        continue;
      }
      if (response.status === 429) return { error: "rate" };
      if (response.status !== 200) return { error: "network" };
      const text = await response.text();
      if (text.length > PACKAGE_JSON_LIMIT) return { error: "invalid" };
      return parsePackage(text);
    }
    return { error: "network" };
  } catch {
    return { error: "network" };
  } finally {
    clearTimeout(timer);
  }
}

export function parsePackage(text: string): PackageRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "invalid" };
  }
  if (!parsed || typeof parsed !== "object") return { error: "invalid" };
  const name = "name" in parsed ? parsed.name : undefined;
  const version = "version" in parsed ? parsed.version : undefined;
  if (typeof name !== "string" || typeof version !== "string") return { error: "invalid" };
  if (name !== PACKAGE_NAME) return { error: "mismatch" };
  if (!parseSemver(version) || parseSemver(version)?.prerelease.length) return { error: "invalid" };
  return { name, version };
}

export function githubSlug(remote: string): string | null {
  const trimmed = stripCredentials(remote);
  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh?.[1] && ssh[2]) return `${ssh[1]}/${ssh[2]}`;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    return `${parts[0]}/${parts[1].replace(/\.git$/, "")}`;
  } catch {
    return null;
  }
}

export function pluginPackagePath(pluginPath: string): string | null {
  const normalized = pluginPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || normalized === "." || normalized.split("/").includes("..")) return null;
  return `${normalized}/package.json`;
}

export function stripCredentials(remote: string): string {
  return remote.replace(/\/\/[^@/]+@/g, "//");
}

export async function listTags(
  git: GitPort,
  remote: string,
  cwd: string,
  timeoutMs: number,
): Promise<string | null> {
  if (!allowedRemote(remote)) return null;
  const result = await git.run({
    args: ["ls-remote", "--tags", "--", remote],
    cwd,
    timeoutMs,
  });
  return gitOk(result) ? result.stdout : null;
}

export async function readDefaultBranch(
  git: GitPort,
  remote: string,
  cwd: string,
  timeoutMs: number,
): Promise<string | null> {
  if (!allowedRemote(remote)) return null;
  const result = await git.run({
    args: ["ls-remote", "--symref", "--", remote, "HEAD"],
    cwd,
    timeoutMs,
  });
  return gitOk(result) ? result.stdout : null;
}

export function allowedRemote(remote: string): boolean {
  const text = stripCredentials(remote);
  if (text.startsWith("git@github.com:")) return true;
  if (/^git@[^:]+:[^ ]+$/.test(text)) return true;
  try {
    const url = new URL(text);
    return (
      url.protocol === "https:" ||
      url.protocol === "ssh:" ||
      url.protocol === "git:" ||
      url.protocol === "file:"
    );
  } catch {
    return false;
  }
}

export function objectPresent(
  git: GitPort,
  cwd: string,
  sha: Sha,
  timeoutMs: number,
): Promise<boolean> {
  return git
    .run({ args: ["cat-file", "-e", `${sha}^{commit}`], cwd, timeoutMs })
    .then((result) => gitOk(result))
    .catch(() => false);
}

export async function ancestry(
  git: GitPort,
  cwd: string,
  head: Sha,
  target: Sha,
  timeoutMs: number,
): Promise<"equal" | "behind" | "ahead" | "diverged" | "unrelated" | "unknown"> {
  if (head === target) return "equal";
  const base = await git.run({
    args: ["merge-base", "--is-ancestor", head, target],
    cwd,
    timeoutMs,
  });
  if (gitOk(base)) return "behind";
  if (base.exitCode === 1) {
    const reverse = await git.run({
      args: ["merge-base", "--is-ancestor", target, head],
      cwd,
      timeoutMs,
    });
    if (gitOk(reverse)) return "ahead";
    if (reverse.exitCode === 1) {
      const counts = await git.run({
        args: ["rev-list", "--left-right", "--count", `${head}...${target}`],
        cwd,
        timeoutMs,
      });
      if (!gitOk(counts)) return "unknown";
      const parsed = gitText(counts).match(/^(\d+)\s+(\d+)$/);
      if (!parsed) return "unknown";
      if (parsed[1] === "0" && parsed[2] === "0") return "unrelated";
      return "diverged";
    }
  }
  return "unknown";
}

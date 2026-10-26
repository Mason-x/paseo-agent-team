import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  type Blocker,
  blocker,
  type Current,
  type InstallSource,
  PACKAGE_NAME,
  PLUGIN_ID,
  type Relation,
} from "../../shared/version";
import {
  asSha,
  type GitPort,
  gitOk,
  gitText,
  parseAheadBehind,
  parseDirty,
  relationFromCounts,
} from "./git";
import type { FilesPort } from "./process";
import { pluginPackagePath, stripCredentials } from "./remote";

export const PLUGIN_CONFIG_KEY = PLUGIN_ID;

export type HomeStatus = { ok: true; home: string } | { ok: false; blocker: Blocker };

/** Absolute `PASEO_HOME` only. Never substitutes `~/.paseo` or an implicit host. */
export function resolveExplicitHome(
  env: NodeJS.ProcessEnv,
  platform = process.platform,
): HomeStatus {
  const raw = env.PASEO_HOME;
  if (typeof raw !== "string" || raw.trim() === "") {
    return {
      ok: false,
      blocker: blocker("home_unavailable", "verify_host", "PASEO_HOME is not set"),
    };
  }
  if (raw.includes("\0")) {
    return {
      ok: false,
      blocker: blocker("home_unavailable", "verify_host", "PASEO_HOME is not a path"),
    };
  }
  if (!path.isAbsolute(raw)) {
    return {
      ok: false,
      blocker: blocker("home_unavailable", "verify_host", "PASEO_HOME is not absolute"),
    };
  }
  if (platform === "win32" && !/^[A-Za-z]:[\\/]/.test(raw) && !raw.startsWith("\\\\")) {
    return {
      ok: false,
      blocker: blocker("home_unavailable", "verify_host", "PASEO_HOME is not absolute"),
    };
  }
  return { ok: true, home: path.resolve(raw) };
}

export type ConfigPlugin = { source?: string; path?: string; enabled?: boolean };

export function readConfiguredPlugin(config: unknown): { path: string } | { blocker: Blocker } {
  if (!config || typeof config !== "object" || !("plugins" in config)) {
    return {
      blocker: blocker("installation_identity_unknown", "verify_host", "plugin config missing"),
    };
  }
  const plugins = config.plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) {
    return {
      blocker: blocker("installation_identity_unknown", "verify_host", "plugin config missing"),
    };
  }
  const entry = (plugins as Record<string, unknown>)[PLUGIN_CONFIG_KEY];
  if (
    !entry ||
    typeof entry !== "object" ||
    !("path" in entry) ||
    typeof entry.path !== "string" ||
    !entry.path
  ) {
    return {
      blocker: blocker("installation_identity_unknown", "verify_host", "plugin path missing"),
    };
  }
  if ("source" in entry && entry.source !== undefined && entry.source !== "directory") {
    return {
      blocker: blocker("installation_identity_unknown", "verify_host", "unexpected plugin source"),
    };
  }
  return { path: entry.path };
}

export type SourceRecord =
  | { kind: "git"; remote: string; registry: { url: string; id: string } | null }
  | { kind: "npm"; registry: { url: string; id: string } | null }
  | { kind: "absent" }
  | { kind: "unreadable" };

export function parseSources(text: string | null): SourceRecord {
  if (text === null) return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unreadable" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "unreadable" };
  const record = (parsed as Record<string, unknown>)[PLUGIN_ID];
  if (!record || typeof record !== "object") return { kind: "absent" };
  const kind = "kind" in record ? record.kind : "git";
  const registry = readRegistry(record);
  if (kind === "npm") return { kind: "npm", registry };
  if (kind === "git" || kind === undefined) {
    const remote =
      "remote" in record && typeof record.remote === "string"
        ? stripCredentials(record.remote)
        : "";
    if (!remote) return { kind: "unreadable" };
    return { kind: "git", remote, registry };
  }
  return { kind: "unreadable" };
}

function readRegistry(record: object): { url: string; id: string } | null {
  if (!("registry" in record) || !record.registry || typeof record.registry !== "object")
    return null;
  const url =
    "url" in record.registry && typeof record.registry.url === "string"
      ? stripCredentials(record.registry.url)
      : "";
  const id =
    "id" in record.registry && typeof record.registry.id === "string" ? record.registry.id : "";
  if (!url || !id) return null;
  return { url, id };
}

export type ManagedLayout =
  | { kind: "directory" }
  | { kind: "git"; pluginPath: string; versionRoot: string }
  | { kind: "npm"; packageName: string; pluginPath: string; versionRoot: string }
  | { kind: "invalid" };

const UUID_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mirrors the host's managed checkout layout. Anything else stays a local directory. */
export function classifyManagedPath(home: string, pluginPath: string): ManagedLayout {
  const root = path.resolve(home, "plugins", PLUGIN_ID);
  const relative = path.relative(root, path.resolve(pluginPath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    return { kind: "directory" };
  const parts = relative.split(path.sep).filter(Boolean);
  const versionId = (parts[0] ?? "").replace(/^[0-9a-f]{12}-/i, "");
  if (!UUID_DIR.test(versionId)) return { kind: "directory" };
  if (parts[1] === "checkout") {
    return {
      kind: "git",
      pluginPath: parts.slice(2).join("/") || ".",
      versionRoot: path.join(root, parts[0] ?? ""),
    };
  }
  if (parts[1] === "node_modules" && parts[2]) {
    const packageParts = parts[2].startsWith("@") ? 2 : 1;
    const packageName = parts.slice(2, 2 + packageParts).join("/");
    return {
      kind: "npm",
      packageName,
      pluginPath: parts.slice(2 + packageParts).join("/") || ".",
      versionRoot: path.join(root, parts[0] ?? ""),
    };
  }
  return { kind: "invalid" };
}

export type PackageFile = { name: string; version: string } | { blocker: Blocker };

export function parseInstalledPackage(text: string): PackageFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { blocker: blocker("path_invalid", "inspect_recovery", "package.json is not json") };
  }
  if (!parsed || typeof parsed !== "object") {
    return { blocker: blocker("path_invalid", "inspect_recovery", "package.json is not json") };
  }
  const name = "name" in parsed && typeof parsed.name === "string" ? parsed.name : "";
  const version = "version" in parsed && typeof parsed.version === "string" ? parsed.version : "";
  if (name !== PACKAGE_NAME || !version) {
    return {
      blocker: blocker("installation_identity_unknown", "verify_host", "package identity mismatch"),
    };
  }
  return { name, version };
}

export type Checkout = {
  pluginPath: string;
  repositoryPath: string | null;
  commit: string | null;
  branch: string | null;
  upstream: string | null;
  dirty: boolean | null;
  relationToUpstream: Relation;
  ahead: number | null;
  behind: number | null;
  blockers: Blocker[];
  manifestTracked: boolean;
};

export async function inspectCheckout(
  git: GitPort,
  pluginDir: string,
  timeoutMs: number,
): Promise<Checkout> {
  const blockers: Blocker[] = [];
  const top = await git
    .run({ args: ["rev-parse", "--show-toplevel"], cwd: pluginDir, timeoutMs })
    .catch(() => null);
  if (!top || !gitOk(top)) {
    return emptyCheckout(pluginDir, [
      blocker("not_git", "manual_update", "plugin directory is not a git checkout"),
    ]);
  }
  const repositoryPath = gitText(top);
  const head = await git.run({ args: ["rev-parse", "HEAD"], cwd: repositoryPath, timeoutMs });
  const commit = gitOk(head) ? asSha(gitText(head)) : null;
  const branchResult = await git.run({
    args: ["rev-parse", "--abbrev-ref", "HEAD"],
    cwd: repositoryPath,
    timeoutMs,
  });
  const branchName = gitOk(branchResult) ? gitText(branchResult) : null;
  const detached = branchName === "HEAD";
  const branch = detached ? null : branchName;
  const status = await git.run({
    args: ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=no"],
    cwd: repositoryPath,
    timeoutMs,
  });
  const dirty = gitOk(status) ? parseDirty(status.stdout) : null;
  if (dirty === null) blockers.push(blocker("repository_busy", "retry_check", "git status failed"));
  if (dirty)
    blockers.push(
      blocker("dirty", "inspect_local_changes", "worktree has tracked or untracked changes"),
    );
  const merge = await git.run({
    args: ["rev-parse", "-q", "--verify", "MERGE_HEAD"],
    cwd: repositoryPath,
    timeoutMs,
  });
  if (gitOk(merge))
    blockers.push(blocker("repository_busy", "inspect_local_changes", "merge in progress"));
  for (const marker of ["CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    const operation = await git.run({
      args: ["rev-parse", "--verify", "--quiet", marker],
      cwd: repositoryPath,
      timeoutMs,
    });
    if (gitOk(operation))
      blockers.push(blocker("repository_busy", "inspect_local_changes", `${marker} in progress`));
  }
  for (const marker of ["rebase-merge", "rebase-apply"]) {
    const located = await git.run({
      args: ["rev-parse", "--git-path", marker],
      cwd: repositoryPath,
      timeoutMs,
    });
    if (gitOk(located) && existsSync(path.resolve(repositoryPath, gitText(located))))
      blockers.push(blocker("repository_busy", "inspect_local_changes", `${marker} in progress`));
  }
  if (detached)
    blockers.push(blocker("detached_head", "switch_tracking_branch", "HEAD is detached"));

  let upstream: string | null = null;
  let relationToUpstream: Relation = "unknown";
  let ahead: number | null = null;
  let behind: number | null = null;
  if (branch) {
    const upstreamResult = await git.run({
      args: ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      cwd: repositoryPath,
      timeoutMs,
    });
    if (gitOk(upstreamResult)) {
      upstream = gitText(upstreamResult);
      const counts = await git.run({
        args: ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
        cwd: repositoryPath,
        timeoutMs,
      });
      const parsed = gitOk(counts) ? parseAheadBehind(counts.stdout) : null;
      if (parsed) {
        ahead = parsed.ahead;
        behind = parsed.behind;
        relationToUpstream = relationFromCounts(parsed, parsed.ahead === 0 && parsed.behind === 0);
      }
      if (parsed && parsed.ahead > 0 && parsed.behind > 0) {
        blockers.push(
          blocker(
            "diverged",
            "reconcile_commits",
            `${parsed.ahead} ahead, ${parsed.behind} behind upstream`,
          ),
        );
      } else if (parsed && parsed.ahead > 0) {
        blockers.push(
          blocker(
            "local_ahead",
            "reconcile_commits",
            `${parsed.ahead} local commit(s) are not on upstream`,
          ),
        );
      }
    } else {
      blockers.push(blocker("no_upstream", "switch_tracking_branch", "branch has no upstream"));
    }
  }

  const relative = path.relative(repositoryPath, pluginDir).replace(/\\/g, "/");
  const trackedPath = pluginPackagePath(relative === "" ? "." : relative);
  let manifestTracked = false;
  if (trackedPath) {
    const tracked = await git.run({
      args: [
        "ls-files",
        "--error-unmatch",
        "--",
        trackedPath.replace(/\/package\.json$/, "/paseo-plugin.json"),
      ],
      cwd: repositoryPath,
      timeoutMs,
    });
    manifestTracked = gitOk(tracked);
    if (!manifestTracked) {
      blockers.push(
        blocker(
          "unsupported_checkout",
          "manual_update",
          "manifest is not tracked by this repository",
        ),
      );
    }
  }

  return {
    pluginPath: pluginDir,
    repositoryPath,
    commit,
    branch,
    upstream,
    dirty,
    relationToUpstream,
    ahead,
    behind,
    blockers,
    manifestTracked,
  };
}

function emptyCheckout(pluginDir: string, blockers: Blocker[]): Checkout {
  return {
    pluginPath: pluginDir,
    repositoryPath: null,
    commit: null,
    branch: null,
    upstream: null,
    dirty: null,
    relationToUpstream: "unknown",
    ahead: null,
    behind: null,
    blockers,
    manifestTracked: false,
  };
}

export function safeRealpath(
  target: string,
  exists?: (candidate: string) => boolean,
): string | null {
  if (exists) return exists(target) ? path.resolve(target) : null;
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

export async function readOptional(
  files: FilesPort,
  target: string,
  maxBytes: number,
): Promise<string | null> {
  try {
    return await files.readText(target, maxBytes);
  } catch {
    return null;
  }
}

export function currentSnapshot(input: {
  packageVersion: string | null;
  commit: string | null;
  branch: string | null;
  dirty: boolean | null;
  pluginPath: string | null;
  repositoryPath: string | null;
  observedAt: string;
}): Current {
  return {
    packageVersion: input.packageVersion,
    commit: input.commit && asSha(input.commit) ? input.commit : null,
    branch: input.branch,
    dirty: input.dirty,
    pluginPath: input.pluginPath,
    repositoryPath: input.repositoryPath,
    observedAt: input.observedAt,
  };
}

export function installSourceFor(input: {
  layout: ManagedLayout;
  record: SourceRecord;
  pluginPath: string;
  isGit: boolean;
  installedCommit: string | null;
  installedVersion: string | null;
}): InstallSource {
  if (input.layout.kind === "git" && input.record.kind === "git") {
    return {
      kind: "git",
      remote: input.record.remote,
      pluginPath: input.layout.pluginPath,
      installedCommit:
        input.installedCommit && asSha(input.installedCommit) ? input.installedCommit : null,
      ref: null,
      registry: input.record.registry,
    };
  }
  if (
    input.layout.kind === "npm" &&
    (input.record.kind === "npm" || input.record.kind === "absent")
  ) {
    return {
      kind: "npm",
      packageName: input.layout.packageName,
      pluginPath: input.layout.pluginPath,
      installedVersion: input.installedVersion,
      registry: input.record.kind === "npm" ? input.record.registry : null,
    };
  }
  if (
    input.layout.kind === "directory" &&
    input.record.kind !== "git" &&
    input.record.kind !== "npm"
  ) {
    return { kind: "directory", path: input.pluginPath, isGit: input.isGit };
  }
  return { kind: "unknown" };
}

import type { z } from "zod";
import type { RunRecord, RunResourceClaimSchema } from "../../schemas/run-engine/ledger";

type RunResourceClaim = z.infer<typeof RunResourceClaimSchema>;

/**
 * A scope after the host adapter has verified realpath/8.3/junction rules. R03b never produces
 * verified:true itself; tests may construct it directly.
 */
export type VerifiedScope = {
  repoId: string;
  kind: "file" | "directory";
  path: string;
  access: "read" | "write";
  verified: boolean;
  /** Optional repo-level hotspot/tool key; a shared hot key is a write/write conflict. */
  hotKey?: string;
  toolKey?: string;
};

export type PathRejection =
  | "empty"
  | "absolute"
  | "unc"
  | "drive"
  | "ads"
  | "trailing-dot-space"
  | "empty-segment"
  | "escape";

export type NormalizedPath =
  | { ok: true; path: string; caseFolded: string }
  | { ok: false; reason: PathRejection };

export type LockConflict = {
  claimId: string;
  taskId: string;
  repoId: string;
  path: string;
  kind: "file" | "directory";
  access: "read" | "write";
  reason: "path" | "frozen";
};

export type LockRequest = {
  taskId: string;
  phase?: "implementation" | "review" | "smoke";
  scopes: readonly VerifiedScope[];
};

export type LockCheck =
  | { ok: true; conflicts: readonly LockConflict[] }
  | { ok: false; reason: "unverified-scope" | "invalid-path"; path: string };

/** ASCII lower-case fold; non-ASCII stays as-is (host adapter owns filesystem alias checks). */
function fold(value: string): string {
  return value.replace(/[A-Z]/gu, (char) => char.toLowerCase());
}

/**
 * Lexical path normalization only. Realpath/short-name/junction verification is the R05 host
 * adapter's job; this rejects the shapes that can never be repo-relative.
 */
export function normalizeLogicalPath(raw: string): NormalizedPath {
  if (raw.length === 0) return { ok: false, reason: "empty" };
  if (raw.startsWith("\\\\") || raw.startsWith("//")) return { ok: false, reason: "unc" };
  if (raw.startsWith("/") || raw.startsWith("\\")) return { ok: false, reason: "absolute" };
  if (/^[A-Za-z]:/u.test(raw)) return { ok: false, reason: "drive" };
  if (raw.includes(":")) return { ok: false, reason: "ads" };
  const segments: string[] = [];
  for (const part of raw.split(/[\\/]+/u)) {
    if (part === "") continue;
    if (part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return { ok: false, reason: "escape" };
      segments.pop();
      continue;
    }
    if (part.endsWith(".") || part.endsWith(" ")) {
      return { ok: false, reason: "trailing-dot-space" };
    }
    segments.push(part);
  }
  if (segments.length === 0) return { ok: false, reason: "empty" };
  const path = segments.join("/");
  return { ok: true, path, caseFolded: fold(path) };
}

function covers(dir: string, file: string): boolean {
  return file === dir || file.startsWith(`${dir}/`);
}

/** Directory locks cover descendants; files only match themselves. */
export function scopeCovers(
  directory: { path: string; caseFold?: boolean },
  file: { path: string; caseFold?: boolean },
): boolean {
  const foldPaths = directory.caseFold === true || file.caseFold === true;
  const dir = foldPaths ? fold(directory.path) : directory.path;
  const target = foldPaths ? fold(file.path) : file.path;
  return covers(dir, target);
}

export function lockConflicts(
  a: Pick<RunResourceClaim, "repoId" | "kind" | "path" | "access" | "frozen"> & {
    hotKey?: string;
    toolKey?: string;
  },
  b: Pick<VerifiedScope, "repoId" | "kind" | "path" | "access" | "hotKey" | "toolKey">,
  caseFold = false,
): "none" | "read" | "write" {
  if (a.repoId !== b.repoId) return "none";
  if (a.toolKey !== undefined && a.toolKey === b.toolKey) return "write";
  if (
    a.hotKey !== undefined &&
    a.hotKey === b.hotKey &&
    (a.access === "write" || b.access === "write")
  ) {
    return "write";
  }
  const aPath = caseFold ? fold(a.path) : a.path;
  const bPath = caseFold ? fold(b.path) : b.path;
  const aCovers = a.kind === "directory" && covers(aPath, bPath);
  const bCovers = b.kind === "directory" && covers(bPath, aPath);
  if (aPath !== bPath && !aCovers && !bCovers) return "none";
  return a.access === "read" && b.access === "read" ? "none" : "write";
}

/**
 * Conflict evidence for a prospective claim. Unverified scopes are rejected outright; a frozen
 * claim conflicts even for its own task. A non-frozen claim may hand over to its own review/smoke
 * phase (the implementation quiescence decision stays with the reducer).
 */
export function findLockConflicts(
  record: Pick<RunRecord, "resources">,
  request: LockRequest,
  options: { caseFold?: boolean } = {},
): LockCheck {
  for (const scope of request.scopes) {
    if (!scope.verified) return { ok: false, reason: "unverified-scope", path: scope.path };
    const normalized = normalizeLogicalPath(scope.path);
    if (!normalized.ok) return { ok: false, reason: "invalid-path", path: scope.path };
  }
  const conflicts: LockConflict[] = [];
  for (const claim of record.resources) {
    for (const scope of request.scopes) {
      const sameTaskHandoff =
        claim.taskId === request.taskId &&
        !claim.frozen &&
        (request.phase === "review" || request.phase === "smoke");
      if (sameTaskHandoff) continue;
      const kind = lockConflicts(
        claim as RunResourceClaim & { hotKey?: string; toolKey?: string },
        scope,
        options.caseFold,
      );
      if (kind === "none") continue;
      conflicts.push({
        claimId: claim.claimId,
        taskId: claim.taskId,
        repoId: claim.repoId,
        path: claim.path,
        kind: claim.kind,
        access: claim.access,
        reason: claim.frozen ? "frozen" : "path",
      });
    }
  }
  return { ok: true, conflicts };
}

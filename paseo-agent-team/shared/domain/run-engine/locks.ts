import type { z } from "zod";
import type { RunRecord, RunResourceClaimSchema } from "../../schemas/run-engine/ledger";

type RunResourceClaim = z.infer<typeof RunResourceClaimSchema>;

/**
 * A scope after the host adapter has verified realpath/8.3/junction rules. R03b never produces
 * verified:true itself; tests may construct it directly.
 */
export type VerifiedScope = {
  repoId: string;
  kind: RunResourceClaim["kind"];
  path: string;
  access: "read" | "write";
  verified: boolean;
};

export type PathRejection =
  | "empty"
  | "absolute"
  | "unc"
  | "drive"
  | "ads"
  | "trailing-dot-space"
  | "empty-segment"
  | "escape"
  | "glob"
  | "illegal-char"
  | "reserved";

export type NormalizedPath =
  | { ok: true; path: string; caseFolded: string }
  | { ok: false; reason: PathRejection };

export type LockConflict = {
  claimId: string;
  taskId: string;
  repoId: string;
  path: string;
  kind: RunResourceClaim["kind"];
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

/**
 * NFC + Unicode lower-case. NFC unifies canonically equivalent spellings without the
 * compatibility folding (NFKC) that would rewrite distinct names; toLowerCase is locale-free,
 * unlike localeCompare/toLocaleLowerCase. Host-specific 8.3/short-name rules stay in R05.
 */
function fold(value: string): string {
  return value.normalize("NFC").toLowerCase().normalize("NFC");
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
  if (raw.includes("*") || raw.includes("?")) return { ok: false, reason: "glob" };
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || '<>"|'.includes(char)) {
      return { ok: false, reason: "illegal-char" };
    }
  }
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
    const base = part.split(".")[0]?.toUpperCase() ?? "";
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(base)) {
      return { ok: false, reason: "reserved" };
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
  const foldPaths = directory.caseFold !== false && file.caseFold !== false;
  const dir = foldPaths ? fold(directory.path) : directory.path;
  const target = foldPaths ? fold(file.path) : file.path;
  return covers(dir, target);
}

export function lockConflicts(
  a: Pick<RunResourceClaim, "repoId" | "kind" | "path" | "access" | "frozen">,
  b: Pick<VerifiedScope, "repoId" | "kind" | "path" | "access">,
  caseFold = true,
): "none" | "read" | "write" {
  if (a.repoId !== b.repoId) return "none";
  // hot/tool are named repo resources: exact kind+name only, no directory/path semantics.
  const aNamed = a.kind === "hot" || a.kind === "tool";
  const bNamed = b.kind === "hot" || b.kind === "tool";
  if (aNamed || bNamed) {
    return a.kind === b.kind && a.path === b.path ? "write" : "none";
  }
  const aNormalized = normalizeLogicalPath(a.path);
  const bNormalized = normalizeLogicalPath(b.path);
  if (!aNormalized.ok || !bNormalized.ok) return "write";
  const aPath = caseFold ? fold(aNormalized.path) : aNormalized.path;
  const bPath = caseFold ? fold(bNormalized.path) : bNormalized.path;
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
  const resolved: VerifiedScope[] = [];
  for (const scope of request.scopes) {
    const named = scope.kind === "hot" || scope.kind === "tool";
    if (named) {
      if (scope.path.length === 0) return { ok: false, reason: "invalid-path", path: scope.path };
      resolved.push(scope);
      continue;
    }
    if (!scope.verified) return { ok: false, reason: "unverified-scope", path: scope.path };
    const normalized = normalizeLogicalPath(scope.path);
    if (!normalized.ok) return { ok: false, reason: "invalid-path", path: scope.path };
    resolved.push({ ...scope, path: normalized.path });
  }
  const caseFold = options.caseFold ?? true;
  const conflicts: LockConflict[] = [];
  for (const claim of record.resources) {
    for (const scope of resolved) {
      // A task re-applying in a later phase keeps its own non-frozen claim; frozen still blocks.
      if (claim.taskId === request.taskId && !claim.frozen) continue;
      const kind = lockConflicts(claim, scope, caseFold);
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

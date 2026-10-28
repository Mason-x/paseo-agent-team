import { describe, expect, test } from "vitest";
import {
  findLockConflicts,
  lockConflicts,
  normalizeLogicalPath,
  scopeCovers,
  type VerifiedScope,
} from "../../shared/domain/run-engine/locks";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";

function scope(overrides: Partial<VerifiedScope> = {}): VerifiedScope {
  return {
    repoId: "repo-1",
    kind: "file",
    path: "src/a.ts",
    access: "write",
    verified: true,
    ...overrides,
  };
}

function record(resources: RunRecord["resources"] = []): Pick<RunRecord, "resources"> {
  return { resources };
}

function claim(overrides: Record<string, unknown> = {}) {
  return {
    claimId: "claim-1",
    taskId: "T1",
    repoId: "repo-1",
    kind: "file" as const,
    path: "src/a.ts",
    access: "write" as const,
    frozen: false,
    createdAt: "2026-10-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("logical path and scope rules", () => {
  test("normalizes separators/dots and rejects non-repo-relative shapes", () => {
    expect(normalizeLogicalPath("src/")).toEqual({
      ok: true,
      path: "src",
      caseFolded: "src",
    });
    expect(normalizeLogicalPath("src\\a/./b.ts")).toEqual({
      ok: true,
      path: "src/a/b.ts",
      caseFolded: "src/a/b.ts",
    });
    const rejects: Array<[string, string]> = [
      ["", "empty"],
      ["/src/a.ts", "absolute"],
      ["\\\\server\\share", "unc"],
      ["//server/share", "unc"],
      ["C:\\src\\a.ts", "drive"],
      ["src/a.ts:stream", "ads"],
      ["src/a. ", "trailing-dot-space"],
      ["../a.ts", "escape"],
      [".", "empty"],
    ];
    for (const [value, reason] of rejects) {
      expect(normalizeLogicalPath(value)).toEqual({ ok: false, reason });
    }
  });

  test("directory coverage and read/read compatibility", () => {
    expect(scopeCovers({ path: "src" }, { path: "src/a.ts" })).toBe(true);
    expect(scopeCovers({ path: "src/a.ts" }, { path: "src/a.ts" })).toBe(true);
    expect(scopeCovers({ path: "src/a.ts" }, { path: "src/ab.ts" })).toBe(false);
    expect(scopeCovers({ path: "SRC", caseFold: true }, { path: "src/a.ts", caseFold: true })).toBe(
      true,
    );
    const dir = claim({ kind: "directory", path: "src" });
    expect(lockConflicts(dir, scope())).toBe("write");
    expect(lockConflicts(claim({ access: "read" }), scope({ access: "read" }))).toBe("none");
    expect(lockConflicts(claim({ access: "read" }), scope({ access: "write" }))).toBe("write");
    expect(lockConflicts(claim({ repoId: "other" }), scope())).toBe("none");
    for (const path of ["src\\a/b.ts", "./src/a/b.ts", "src//a/b.ts", "src/x/../a/b.ts"]) {
      expect(lockConflicts(claim({ path: "src/a/b.ts" }), scope({ path })), path).toBe("write");
    }
    expect(lockConflicts(claim({ path: "Ünï.ts" }), scope({ path: "ünï.ts" }), true)).toBe("write");
    expect(
      lockConflicts(
        claim({ kind: "hot", path: "repo:hotspot" }),
        scope({ kind: "hot", path: "repo:hotspot" }),
      ),
    ).toBe("write");
    expect(
      lockConflicts(
        claim({ kind: "hot", path: "repo:hotspot" }),
        scope({ kind: "hot", path: "repo:other" }),
      ),
    ).toBe("none");
    expect(
      lockConflicts(
        claim({ kind: "hot", path: "repo:hotspot" }),
        scope({ kind: "tool", path: "repo:hotspot" }),
      ),
    ).toBe("none");
    expect(
      lockConflicts(
        claim({ kind: "tool", path: "npm:install" }),
        scope({ kind: "tool", path: "npm:install" }),
      ),
    ).toBe("write");
  });
});

describe("findLockConflicts", () => {
  test("returns path evidence and rejects unverified/invalid scopes", () => {
    expect(
      findLockConflicts(record([claim({ claimId: "claim-2", taskId: "T2" })]), {
        taskId: "T1",
        scopes: [scope()],
      }),
    ).toEqual({
      ok: true,
      conflicts: [
        {
          claimId: "claim-2",
          taskId: "T2",
          repoId: "repo-1",
          path: "src/a.ts",
          kind: "file",
          access: "write",
          reason: "path",
        },
      ],
    });
    expect(
      findLockConflicts(record(), { taskId: "T1", scopes: [scope({ verified: false })] }),
    ).toEqual({ ok: false, reason: "unverified-scope", path: "src/a.ts" });
    expect(
      findLockConflicts(record(), { taskId: "T1", scopes: [scope({ path: "/abs" })] }),
    ).toEqual({ ok: false, reason: "invalid-path", path: "/abs" });
  });

  test("a frozen claim conflicts even for its own task; a review handoff does not", () => {
    const frozen = claim({ frozen: true });
    expect(
      findLockConflicts(record([frozen]), {
        taskId: "T1",
        phase: "review",
        scopes: [scope()],
      }),
    ).toMatchObject({ ok: true, conflicts: [{ reason: "frozen" }] });
    const open = claim({ frozen: false });
    expect(
      findLockConflicts(record([open]), {
        taskId: "T1",
        phase: "review",
        scopes: [scope()],
      }),
    ).toEqual({ ok: true, conflicts: [] });
    expect(
      findLockConflicts(record([open]), {
        taskId: "T1",
        phase: "implementation",
        scopes: [scope()],
      }),
    ).toEqual({ ok: true, conflicts: [] });
  });

  test("does not mutate the record and uses case-fold when asked", () => {
    const input = record([claim({ path: "SRC/A.ts" })]);
    const before = JSON.stringify(input);
    expect(
      findLockConflicts(
        input,
        { taskId: "T2", scopes: [scope({ path: "src/a.ts" })] },
        {
          caseFold: true,
        },
      ),
    ).toMatchObject({ ok: true, conflicts: [{ claimId: "claim-1" }] });
    expect(JSON.stringify(input)).toBe(before);
  });
});

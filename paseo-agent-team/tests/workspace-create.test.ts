import { describe, expect, test } from "vitest";
import { workspaceCreateSource } from "../client/paseo/adapter";

describe("workspaceCreateSource", () => {
  test("cuts a worktree from a git project", () => {
    expect(
      workspaceCreateSource({
        id: "p1",
        name: "DollarPrinter",
        directory: "F:/code/dp",
        kind: "git",
      }),
    ).toEqual({
      kind: "worktree",
      projectId: "p1",
      cwd: "F:/code/dp",
      action: "branch-off",
    });
  });

  test("reuses a directory project path", () => {
    expect(
      workspaceCreateSource({
        id: "p2",
        name: "Notes",
        directory: "F:/notes",
        kind: "directory",
      }),
    ).toEqual({
      kind: "directory",
      path: "F:/notes",
      projectId: "p2",
    });
  });

  test("rejects a project with no directory", () => {
    expect(() => workspaceCreateSource({ id: "p3", name: "Empty", directory: "  " })).toThrow(
      /目录路径/,
    );
  });
});

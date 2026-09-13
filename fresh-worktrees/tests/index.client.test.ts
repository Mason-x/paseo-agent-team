import { describe, expect, test, vi } from "vitest";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import contribute from "../index.client";

interface WorkspaceUpdate {
  kind: "upsert";
  workspace: {
    id: string;
    projectId: string;
    workspaceDirectory: string;
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("freshness scheduling", () => {
  test("coalesces repeated updates for an unchanged workspace", async () => {
    const freshness = deferred<{ kind: "current"; remoteRef: string }>();
    const rpc = vi.fn(() => freshness.promise);
    let onWorkspaceUpdate!: (update: WorkspaceUpdate) => void;

    const client = {
      paseo: {
        projects: {
          list: vi.fn(async () => ({
            projects: [{ projectId: "project-1", projectRootPath: "/repo" }],
          })),
        },
        workspaces: {
          list: vi.fn(async () => ({ entries: [] })),
          subscribe: vi.fn((callback) => {
            onWorkspaceUpdate = callback;
            return () => {};
          }),
        },
      },
      rpc,
      addHeaderButton: vi.fn(),
    } as unknown as PluginClientContext;

    const cleanup = contribute(client);
    const update: WorkspaceUpdate = {
      kind: "upsert",
      workspace: {
        id: "workspace-1",
        projectId: "project-1",
        workspaceDirectory: "/repo/worktree",
      },
    };

    onWorkspaceUpdate(update);
    onWorkspaceUpdate(update);
    onWorkspaceUpdate(update);
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));

    freshness.resolve({ kind: "current", remoteRef: "origin/main" });
    await freshness.promise;
    onWorkspaceUpdate(update);
    await Promise.resolve();
    expect(rpc).toHaveBeenCalledTimes(1);

    cleanup();
  });

  test("rechecks a moved workspace without applying its old result", async () => {
    const firstFreshness = deferred<{
      kind: "behind";
      remoteRef: string;
      behindBy: number;
    }>();
    const rpc = vi
      .fn()
      .mockImplementationOnce(() => firstFreshness.promise)
      .mockResolvedValueOnce({ kind: "current", remoteRef: "origin/main" });
    const addHeaderButton = vi.fn();
    let onWorkspaceUpdate!: (update: WorkspaceUpdate) => void;

    const client = {
      paseo: {
        projects: {
          list: vi.fn(async () => ({
            projects: [{ projectId: "project-1", projectRootPath: "/repo" }],
          })),
        },
        workspaces: {
          list: vi.fn(async () => ({ entries: [] })),
          subscribe: vi.fn((callback) => {
            onWorkspaceUpdate = callback;
            return () => {};
          }),
        },
      },
      rpc,
      addHeaderButton,
    } as unknown as PluginClientContext;

    const cleanup = contribute(client);
    onWorkspaceUpdate({
      kind: "upsert",
      workspace: {
        id: "workspace-1",
        projectId: "project-1",
        workspaceDirectory: "/repo/old-worktree",
      },
    });
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));

    onWorkspaceUpdate({
      kind: "upsert",
      workspace: {
        id: "workspace-1",
        projectId: "project-1",
        workspaceDirectory: "/repo/new-worktree",
      },
    });
    firstFreshness.resolve({ kind: "behind", remoteRef: "origin/main", behindBy: 1 });

    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    expect(rpc.mock.calls[1]?.[1]).toEqual({
      projectRootPath: "/repo",
      workspaceDirectory: "/repo/new-worktree",
    });
    expect(addHeaderButton).not.toHaveBeenCalled();

    cleanup();
  });
});

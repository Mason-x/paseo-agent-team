import type {
  PluginButton,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { workspaceFreshness } from "./shared/workspace-freshness";

const REFRESH_INTERVAL_MS = 5 * 60_000;

interface WorkspaceEntry {
  id: string;
  projectId: string;
  workspaceDirectory: string | null;
}

export default function contribute(client: PluginClientContext) {
  const buttons = new Map<string, PluginButtonRegistration>();
  const checks = new Map<string, Promise<void>>();
  const workspaceLocations = new Map<
    string,
    { projectId: string; workspaceDirectory: string }
  >();
  const projectRoots = new Map<string, string>();
  let stopped = false;

  function removeIndicator(workspaceId: string) {
    buttons.get(workspaceId)?.remove();
    buttons.delete(workspaceId);
  }

  async function checkFreshness(workspaceId: string) {
    const location = workspaceLocations.get(workspaceId);
    if (!location) return;
    let projectRootPath = projectRoots.get(location.projectId);
    if (!projectRootPath) {
      const { projects } = await client.paseo.projects.list();
      for (const project of projects) projectRoots.set(project.projectId, project.projectRootPath);
      projectRootPath = projectRoots.get(location.projectId);
    }
    if (!projectRootPath) return;

    const freshness = await client.rpc(workspaceFreshness, {
      projectRootPath,
      workspaceDirectory: location.workspaceDirectory,
    });
    if (stopped || workspaceLocations.get(workspaceId) !== location) return;
    if (freshness.kind !== "behind") {
      removeIndicator(workspaceId);
      return;
    }

    const commits = freshness.behindBy === 1 ? "commit" : "commits";
    const button: PluginButton = {
      title: `Worktree is ${freshness.behindBy} ${commits} behind ${freshness.remoteRef}. Select to recheck.`,
      icon: "GitPullRequest",
      label: `Behind · ${freshness.behindBy}`,
      behavior: {
        kind: "action",
        onPress() {
          return scheduleFreshnessCheck(workspaceId);
        },
      },
    };
    const existing = buttons.get(workspaceId);
    if (existing) existing.update(button);
    else {
      buttons.set(
        workspaceId,
        client.addHeaderButton({ id: "remote-behind", workspaceId, button }),
      );
    }
  }

  function scheduleFreshnessCheck(workspaceId: string): Promise<void> {
    const existing = checks.get(workspaceId);
    if (existing) return existing;

    const scheduled = checkFreshness(workspaceId);
    checks.set(workspaceId, scheduled);
    void scheduled.then(
      () => {
        if (checks.get(workspaceId) === scheduled) checks.delete(workspaceId);
      },
      () => {
        if (checks.get(workspaceId) === scheduled) checks.delete(workspaceId);
      },
    );
    return scheduled;
  }

  function trackWorkspace(workspace: WorkspaceEntry) {
    if (!workspace.workspaceDirectory) return;
    const previous = workspaceLocations.get(workspace.id);
    if (
      previous?.projectId === workspace.projectId &&
      previous.workspaceDirectory === workspace.workspaceDirectory
    ) {
      return;
    }

    const location = {
      projectId: workspace.projectId,
      workspaceDirectory: workspace.workspaceDirectory,
    };
    workspaceLocations.set(workspace.id, location);

    const existing = checks.get(workspace.id);
    if (existing) {
      const recheck = () => {
        if (stopped || workspaceLocations.get(workspace.id) !== location) return;
        void scheduleFreshnessCheck(workspace.id).catch((error) => {
          console.warn(`[fresh-worktrees] Could not inspect workspace ${workspace.id}`, error);
        });
      };
      void existing.then(recheck, recheck);
      return;
    }

    void scheduleFreshnessCheck(workspace.id).catch((error) => {
      console.warn(`[fresh-worktrees] Could not inspect workspace ${workspace.id}`, error);
    });
  }

  const unsubscribe = client.paseo.workspaces.subscribe((update) => {
    if (update.kind === "upsert") trackWorkspace(update.workspace);
    else {
      workspaceLocations.delete(update.id);
      removeIndicator(update.id);
    }
  });

  void Promise.all([
    client.paseo.projects.list(),
    client.paseo.workspaces.list({ subscribe: { subscriptionId: "fresh-worktrees-status" } }),
  ])
    .then(([{ projects }, { entries }]) => {
      if (stopped) return;
      for (const project of projects) projectRoots.set(project.projectId, project.projectRootPath);
      for (const workspace of entries) trackWorkspace(workspace);
    })
    .catch((error) => {
      console.warn("[fresh-worktrees] Could not list workspaces", error);
    });

  const interval = setInterval(() => {
    for (const workspaceId of workspaceLocations.keys()) {
      void scheduleFreshnessCheck(workspaceId).catch((error) => {
        console.warn(`[fresh-worktrees] Could not inspect workspace ${workspaceId}`, error);
      });
    }
  }, REFRESH_INTERVAL_MS);

  return () => {
    stopped = true;
    clearInterval(interval);
    unsubscribe();
    for (const button of buttons.values()) button.remove();
    buttons.clear();
    workspaceLocations.clear();
    projectRoots.clear();
  };
}

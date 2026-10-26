import { useQuery } from "@tanstack/react-query";
import type { PaseoAdapter, ProjectSummary, WorkspaceSummary } from "../../shared/paseo/adapter";
import { zh } from "../../shared/zh";

export type LaunchContext = {
  projects: readonly ProjectSummary[];
  workspaces: readonly WorkspaceSummary[];
  loading: boolean;
  error: string | null;
};

const EMPTY: readonly never[] = [];

/** Target choices for the dialog; the host preview owns planning and re-checks everything on launch. */
export function useLaunchContext(
  adapter: PaseoAdapter,
  hostId: string,
  options: { open: boolean; withTargets: boolean },
): LaunchContext {
  const query = useQuery({
    queryKey: ["agent-team", "launch-context", hostId, options.withTargets],
    enabled: options.open,
    staleTime: 15_000,
    queryFn: async () => {
      const [projects, workspaces] = await Promise.all([
        options.withTargets ? adapter.listProjects() : [],
        options.withTargets ? adapter.listWorkspaces() : [],
      ]);
      return { projects, workspaces };
    },
  });
  return {
    projects: query.data?.projects ?? EMPTY,
    workspaces: query.data?.workspaces ?? EMPTY,
    loading: query.isPending && options.open,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : zh.launchContextFail
      : null,
  };
}

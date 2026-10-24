import { useQuery } from "@tanstack/react-query";
import type {
  PaseoAdapter,
  ProjectSummary,
  ProviderAvailability,
  WorkspaceSummary,
} from "../../shared/paseo/adapter";
import { zh } from "../../shared/zh";

export type LaunchContext = {
  availability: readonly ProviderAvailability[];
  daemonConfig: unknown;
  projects: readonly ProjectSummary[];
  workspaces: readonly WorkspaceSummary[];
  loading: boolean;
  error: string | null;
};

const EMPTY: readonly never[] = [];

/** Live host facts the launch preview needs. The host re-checks all of them on launch. */
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
      const [availability, daemonConfig, projects, workspaces] = await Promise.all([
        adapter.listProviderAvailability().catch(() => []),
        adapter.readConfig().catch(() => undefined),
        options.withTargets ? adapter.listProjects() : [],
        options.withTargets ? adapter.listWorkspaces() : [],
      ]);
      return { availability, daemonConfig, projects, workspaces };
    },
  });
  return {
    availability: query.data?.availability ?? EMPTY,
    daemonConfig: query.data?.daemonConfig,
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

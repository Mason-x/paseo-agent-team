import { useQuery } from "@tanstack/react-query";
import type { PaseoAdapter, WorkspaceSummary } from "../../shared/paseo/adapter";
import { zh } from "../../shared/zh";

export type DesignerWorkspaces = {
  workspaces: readonly WorkspaceSummary[];
  loading: boolean;
  error: string | null;
  /** False until a successful load, so an unloaded list never reads as "workspace deleted". */
  loaded: boolean;
};

const EMPTY: readonly WorkspaceSummary[] = [];

/**
 * The designer's target picker only needs workspaces. Loading only those keeps a project-list
 * failure from masquerading as a workspace failure, and lets a folded card skip the request.
 */
export function useDesignerWorkspaces(
  adapter: PaseoAdapter,
  hostId: string,
  enabled: boolean,
): DesignerWorkspaces {
  const query = useQuery({
    queryKey: ["agent-team", "designer-workspaces", hostId],
    enabled,
    staleTime: 15_000,
    queryFn: () => adapter.listWorkspaces(),
  });
  return {
    workspaces: query.data ?? EMPTY,
    loading: enabled && query.isPending,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : zh.designerWorkspacesUnknownError
      : null,
    loaded: query.data !== undefined,
  };
}

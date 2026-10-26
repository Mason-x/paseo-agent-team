import { usePaseo } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { groupTeamRuns } from "../../shared/domain/run-progress";
import { createPaseoAdapter } from "../../shared/paseo/adapter";
import { subscribeToAgentUpdates } from "../../shared/paseo/agent-updates";
import { type AgentTeamKind, LABELS } from "../../shared/paseo/labels";
import type { AgentSnapshot, PaseoApi } from "../crew";

const PAGE_LIMIT = 200;
const MAX_PAGES = 5;
const REFRESH_DEBOUNCE_MS = 1_000;
const BACKSTOP_REFRESH_MS = 30_000;

// Only agents this plugin launched matter here, so the host streams just those.
const TEAM_AGENT_FILTERS = [
  { labels: { [LABELS.kind]: "coordinator" } },
  { labels: { [LABELS.kind]: "member" } },
] as const;

async function listByKind(paseo: PaseoApi, kind: AgentTeamKind): Promise<AgentSnapshot[]> {
  const agents: AgentSnapshot[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.agents.list({
      filter: { labels: { [LABELS.kind]: kind } },
      sort: [{ key: "created_at", direction: "desc" }],
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    agents.push(...result.entries.map((entry) => entry.agent));
    cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
    if (!cursor) break;
  }
  return agents;
}

/**
 * Every live run on this host, built from agent labels alone, with workspace names for display.
 * Screens cannot use the `useWorkspace` state hook (workspace panels only), so names come from
 * the workspace list.
 */
export function useTeamRuns(hostId: string) {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["agent-team", "runs", hostId], [hostId]);
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const [coordinators, members, workspaces] = await Promise.all([
        listByKind(paseo, "coordinator"),
        listByKind(paseo, "member"),
        createPaseoAdapter(paseo)
          .listWorkspaces()
          .catch(() => []),
      ]);
      return {
        agents: [...coordinators, ...members],
        workspaceNames: new Map(workspaces.map((workspace) => [workspace.id, workspace.name])),
      };
    },
    refetchInterval: BACKSTOP_REFRESH_MS,
  });

  useEffect(() => {
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeToAgentUpdates(
      paseo,
      () => {
        if (debounce) return;
        debounce = setTimeout(() => {
          debounce = undefined;
          void queryClient.invalidateQueries({ queryKey });
        }, REFRESH_DEBOUNCE_MS);
      },
      TEAM_AGENT_FILTERS,
    );
    return () => {
      clearTimeout(debounce);
      unsubscribe();
    };
  }, [paseo, queryClient, queryKey]);

  const runs = useMemo(() => groupTeamRuns(query.data?.agents ?? []), [query.data]);
  return { ...query, runs, workspaceNames: query.data?.workspaceNames };
}

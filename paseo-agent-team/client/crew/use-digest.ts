import { usePaseo } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import {
  digestCacheKey,
  digestTimeline,
  type RunAgentSnapshot,
} from "../../shared/domain/run-progress";

/** Enough tail to reach the newest prompt in most turns without pulling whole transcripts. */
const DIGEST_TAIL = 30;
const WORKING_REFRESH_MS = 20_000;

/** The agent's newest assignment, reply, and todo list; see `digestCacheKey` for when it refreshes. */
export function useTimelineDigest(agent: RunAgentSnapshot, enabled = true) {
  const paseo = usePaseo();
  return useQuery({
    queryKey: digestCacheKey(agent),
    queryFn: async () => {
      const page = await paseo.agents
        .ref(agent.id)
        .timeline.refetch({ direction: "tail", limit: DIGEST_TAIL });
      return digestTimeline(page.entries);
    },
    enabled,
    staleTime: 10_000,
    refetchInterval: agent.status === "running" ? WORKING_REFRESH_MS : false,
  });
}

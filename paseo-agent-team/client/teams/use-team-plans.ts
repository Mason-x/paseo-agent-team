import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelFamilyHint } from "../../shared/domain/model-summary";
import type { PaseoProfile } from "../../shared/paseo/adapter";
import { teamPlanRpc } from "../../shared/rpc/team-plan";
import type { Team } from "../../shared/schemas/team";
import {
  buildTeamSummary,
  createTeamPlanClient,
  type TeamPlanBatchView,
  type TeamPlanClient,
  type TeamPlanDraftRequest,
  type TeamPlanDraftState,
  type TeamPlanRevisions,
  type TeamPlanSend,
  type TeamSummaryView,
} from "./team-plan-state";

/**
 * React adapter for the pure team-plan client. `useTeamPlans` lives once on the Team screen (I02)
 * and owns the only probe; `useTeamDraftPlan` is called by the Team editor with the same client.
 * Neither hook talks to settings or Paseo directly.
 */

export type UseTeamPlansOptions = {
  hostId: string;
  profiles: readonly PaseoProfile[];
  revisions: TeamPlanRevisions;
  teams: readonly Team[];
  /** A hidden tab must not poll or plan. */
  active: boolean;
  /** Explicit family classifications for summaries; auto/missing models are filtered upstream. */
  familyHints?: readonly ModelFamilyHint[];
  /** Test seam; the screen leaves this undefined and uses the registered RPC. */
  send?: TeamPlanSend;
};

export type UseTeamPlansResult = TeamPlanBatchView & {
  summaries: ReadonlyMap<string, TeamSummaryView>;
  planClient: TeamPlanClient;
  invalidate: () => void;
  retry: () => void;
};

export function useTeamPlans(options: UseTeamPlansOptions): UseTeamPlansResult {
  const rpc = useRpc(teamPlanRpc);
  const sendRef = useRef(options.send ?? rpc);
  sendRef.current = options.send ?? rpc;
  const clientRef = useRef<TeamPlanClient | null>(null);
  if (clientRef.current === null) {
    clientRef.current = createTeamPlanClient({
      send: (input) => sendRef.current(input),
    });
  }
  const client = clientRef.current;
  const [view, setView] = useState<TeamPlanBatchView>(() => client.getBatchView());

  useEffect(() => client.subscribe(() => setView(client.getBatchView())), [client]);

  useEffect(() => {
    client.setScope({
      hostId: options.hostId,
      profiles: options.profiles,
      revisions: options.revisions,
    });
  }, [client, options.hostId, options.profiles, options.revisions]);

  useEffect(() => {
    if (!options.active) return;
    if (options.teams.length === 0) client.probe();
    else client.planTeams(options.teams);
  }, [client, options.active, options.teams]);

  const summaries = useMemo(() => {
    const built = new Map<string, TeamSummaryView>();
    for (const [key, result] of view.results) {
      built.set(
        key,
        buildTeamSummary({
          result,
          hasContext: view.hasContext,
          ...(options.familyHints === undefined ? {} : { hints: options.familyHints }),
        }),
      );
    }
    return built;
  }, [view.results, view.hasContext, options.familyHints]);

  return {
    ...view,
    summaries,
    planClient: client,
    invalidate: () => {
      client.invalidate();
      if (options.teams.length === 0) client.probe();
      else client.planTeams(options.teams);
    },
    retry: () => {
      if (options.teams.length === 0) client.probe();
      else client.planTeams(options.teams);
    },
  };
}

export type UseTeamDraftPlanOptions = {
  client: TeamPlanClient | null;
  sessionId: string;
  active: boolean;
  request: TeamPlanDraftRequest | null;
};

export type UseTeamDraftPlanResult = {
  state: TeamPlanDraftState;
  retry: () => void;
};

export function useTeamDraftPlan(options: UseTeamDraftPlanOptions): UseTeamDraftPlanResult {
  const { client, sessionId } = options;
  const [state, setState] = useState<TeamPlanDraftState>(() =>
    client ? client.getDraftState(sessionId) : { status: "idle" },
  );

  useEffect(() => {
    if (!client) return;
    setState(client.getDraftState(sessionId));
    return client.subscribe(() => setState(client.getDraftState(sessionId)));
  }, [client, sessionId]);

  const latest = useRef(options.request);
  latest.current = options.request;

  useEffect(() => {
    if (!client || !options.active || !options.request) return;
    client.requestDraft(options.request);
  }, [client, options.active, options.request]);

  return {
    state,
    retry: () => {
      if (!client) return;
      const request = latest.current;
      if (!request) return;
      client.invalidate();
      client.requestDraft(request);
    },
  };
}

import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import type { ModelFamilyHint } from "../../shared/domain/model-summary";
import type { PaseoProfile } from "../../shared/paseo/adapter";
import { teamPlanRpc } from "../../shared/rpc/team-plan";
import type { Team } from "../../shared/schemas/team";
import {
  buildTeamSummaries,
  createClientLifecycle,
  createTeamPlanClient,
  scopeSignature,
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
  refresh: () => void;
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

  const [appActive, setAppActive] = useState(() => AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setAppActive(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  const effectiveActive = options.active && appActive;

  useEffect(() => {
    client.setActive(effectiveActive);
    if (effectiveActive) client.refreshIfStale();
  }, [client, effectiveActive]);

  const lifecycleKey = useMemo(
    () =>
      `${scopeSignature({
        hostId: options.hostId,
        profiles: options.profiles,
        revisions: options.revisions,
      })}|${options.teams.map((team) => team.id).join(",")}`,
    [options.hostId, options.profiles, options.revisions, options.teams],
  );
  const lastLifecycle = useRef("");
  useEffect(() => {
    if (!effectiveActive) {
      lastLifecycle.current = "";
      return;
    }
    if (lifecycleKey === lastLifecycle.current) return;
    lastLifecycle.current = lifecycleKey;
    client.setScope({
      hostId: options.hostId,
      profiles: options.profiles,
      revisions: options.revisions,
    });
    if (options.teams.length === 0) client.probe();
    else client.planTeams(options.teams);
  }, [
    client,
    effectiveActive,
    lifecycleKey,
    options.hostId,
    options.profiles,
    options.revisions,
    options.teams,
  ]);

  const lifecycle = useMemo(() => createClientLifecycle(client), [client]);
  useEffect(() => {
    lifecycle.attach();
    return lifecycle.detach;
  }, [lifecycle]);

  const summaries = useMemo(
    () =>
      buildTeamSummaries({
        results: view.results,
        failedKeys: view.failedKeys,
        hasContext: view.hasContext,
        error: view.error,
        ...(options.familyHints === undefined ? {} : { hints: options.familyHints }),
      }),
    [view.results, view.failedKeys, view.hasContext, view.error, options.familyHints],
  );

  return {
    ...view,
    summaries,
    planClient: client,
    invalidate: () => client.invalidate(),
    retry: () => {
      if (client.modeContract() !== "v2") {
        // Re-ask a daemon that may have been upgraded in place.
        client.renegotiate();
      } else if (options.teams.length === 0) {
        client.probe();
      } else {
        client.planTeams(options.teams);
      }
    },
    refresh: () => client.refresh(),
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
    if (!options.active) {
      client.cancelDraft(sessionId);
      setState({ status: "idle" });
      return;
    }
    setState(client.getDraftState(sessionId));
    const unsubscribe = client.subscribe(() => setState(client.getDraftState(sessionId)));
    return () => {
      unsubscribe();
      client.cancelDraft(sessionId);
    };
  }, [client, sessionId, options.active]);

  const latest = useRef(options.request);
  latest.current = options.request;

  useEffect(() => {
    if (!client || !options.active || !options.request) return;
    if (client.modeContract() === "legacy") return;
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

import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import {
  applyOlder,
  applyRefresh,
  EMPTY_SESSION,
  type EngineSession,
} from "../../../shared/domain/run-engine/get-session";
import { runGetRpc, runListRpc } from "../../../shared/rpc/run-engine";
import {
  RUN_CONTRACT_VERSION,
  type RunListOutputSchema,
} from "../../../shared/schemas/run-engine/rpc";
import { usePageVisible } from "../../shared/use-page-visible";
import { createPoller } from "./poller";

/**
 * Backstop only: hooks drive changes, and `unchanged` keeps an idle poll tiny. The poll runs only
 * while the page is in front (`usePageVisible`), never overlaps itself (`createPoller`), and asks
 * once at once when the page comes back.
 */
const POLL_MS = 5_000;
const LIST_POLL_MS = 10_000;

/**
 * One Engine run's detail. The session is keyed by host + run, so switching run starts clean, and
 * an `unchanged` answer keeps the last ready state. Read-only: it only ever calls `run.get`.
 */
export function useEngineRun(hostId: string, runId: string, active: boolean) {
  const getRun = useRpc(runGetRpc);
  const [session, setSession] = useState<EngineSession>(EMPTY_SESSION);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visible = usePageVisible();
  const sessionRef = useRef(session);
  const generation = useRef(0);
  sessionRef.current = session;

  const commit = useCallback((next: EngineSession) => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  const refresh = useCallback(async () => {
    const mine = generation.current;
    const held = sessionRef.current.state;
    const knownRevision = held?.kind === "ready" ? held.run.revision : undefined;
    try {
      let raw = await getRun({
        runContractVersion: RUN_CONTRACT_VERSION,
        runId,
        ...(knownRevision === undefined ? {} : { knownRevision }),
      });
      if (mine !== generation.current) return;
      let step = applyRefresh(sessionRef.current, raw);
      if (step.needFull) {
        raw = await getRun({ runContractVersion: RUN_CONTRACT_VERSION, runId });
        if (mine !== generation.current) return;
        step = applyRefresh(sessionRef.current, raw);
      }
      commit(step.session);
      setError(null);
    } catch (cause) {
      if (mine !== generation.current) return;
      // A transport error is not a verdict on the run: keep what is shown and say it failed.
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [commit, getRun, runId]);

  const loadOlder = useCallback(
    async (cursor: string) => {
      const mine = generation.current;
      setLoadingOlder(true);
      try {
        const raw = await getRun({
          runContractVersion: RUN_CONTRACT_VERSION,
          runId,
          historyCursor: cursor,
        });
        if (mine !== generation.current) return;
        const step = applyOlder(sessionRef.current, raw);
        commit(step.session);
        if (step.needFull) await refresh();
      } catch (cause) {
        if (mine === generation.current) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (mine === generation.current) setLoadingOlder(false);
      }
    },
    [commit, getRun, refresh, runId],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: hostId resets the session on host change
  useEffect(() => {
    generation.current += 1;
    commit(EMPTY_SESSION);
    setError(null);
    setLoadingOlder(false);
  }, [hostId, runId, commit]);

  useEffect(() => {
    if (!active || !visible) return;
    const poller = createPoller({ intervalMs: POLL_MS, tick: refresh });
    poller.start();
    return () => poller.stop();
  }, [active, visible, refresh]);

  return { session, error, loadingOlder, refresh, loadOlder };
}

type ListOutput = z.output<typeof RunListOutputSchema>;

/** The Engine run list. Damaged runs come back as `health`, never hidden. */
export function useEngineRuns(hostId: string) {
  const listRuns = useRpc(runListRpc);
  const visible = usePageVisible();
  const [data, setData] = useState<{ host: string; value: ListOutput } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const value = await listRuns({ runContractVersion: RUN_CONTRACT_VERSION, limit: 50 });
      setData({ host: hostId, value });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [hostId, listRuns]);

  useEffect(() => {
    if (!visible) return;
    const poller = createPoller({ intervalMs: LIST_POLL_MS, tick: refresh });
    poller.start();
    return () => poller.stop();
  }, [visible, refresh]);

  return {
    runs: data?.host === hostId ? data.value.runs : [],
    health: data?.host === hostId ? data.value.health : [],
    capabilities: data?.host === hostId ? data.value.capabilities : null,
    error,
    refresh,
  };
}

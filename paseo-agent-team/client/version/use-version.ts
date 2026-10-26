import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Blocker,
  type Job,
  type VersionInfo,
  versionCheckRpc,
  versionGetRpc,
  versionUpdateStartRpc,
  versionUpdateStatusRpc,
} from "../../shared/version";
import { zh } from "../../shared/zh";
import {
  AUTO_CHECK_INTERVAL_MS,
  adoptJobSnapshot,
  blockerViews,
  isJobActive,
  resolveRecoveryStep,
  resolveUpdatePoll,
  shouldAdoptLatestUpdateJob,
  shouldAutoCheck,
  shouldCheckAfterUpdate,
  versionQueryKey,
} from "./view-model";

export type VersionHook = {
  info: VersionInfo | null;
  job: Job | null;
  loading: boolean;
  checking: boolean;
  starting: boolean;
  reconnecting: boolean;
  recovering: boolean;
  checkError: string | null;
  startBlockers: Blocker[] | null;
  checkNow: () => void;
  startUpdate: () => void;
  refresh: () => void;
};

type PendingStart = { requestId: string; checkId: string; startedAt: string };

const autoCheckTimes = new Map<string, number>();
const postUpdateChecked = new Set<string>();
const pendingStarts = new Map<string, PendingStart>();

export function createRequestId(): string {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === "x" ? value : (value & 0x3) | 0x8).toString(16);
  });
}

async function readLatestUpdateJob(
  status: (input: { jobId?: string }) => Promise<{ job: Job | null }>,
  current: Job | null,
): Promise<Job | null> {
  try {
    const latest = await status({});
    if (latest.job?.kind !== "update") return null;
    return shouldAdoptLatestUpdateJob(latest.job, current) ? latest.job : null;
  } catch {
    return null;
  }
}

/**
 * Version state for one host. Callers must key this component by hostId so a host switch creates a
 * fresh query and job state; the query key carries the same host id as a second line of defence.
 */
export function useVersion(hostId: string): VersionHook {
  const getVersion = useRpc(versionGetRpc);
  const checkVersion = useRpc(versionCheckRpc);
  const startVersionUpdate = useRpc(versionUpdateStartRpc);
  const updateStatus = useRpc(versionUpdateStatusRpc);
  const query = useQuery({
    queryKey: versionQueryKey(hostId),
    queryFn: () => getVersion({}),
    staleTime: 0,
    retry: false,
  });
  const [jobOverride, setJobOverride] = useState<Job | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [startBlockers, setStartBlockers] = useState<Blocker[] | null>(null);
  const [recovering, setRecovering] = useState(false);
  const autoAttempted = useRef(false);
  const checkingRef = useRef(false);
  const previousHost = useRef(hostId);
  const refetch = query.refetch;
  const info = query.data?.info ?? null;
  const job = jobOverride ?? query.data?.job ?? null;
  const jobRef = useRef<Job | null>(null);
  jobRef.current = job;
  const adoptJob = useCallback((next: Job | null) => {
    setJobOverride((current) => adoptJobSnapshot(current ?? jobRef.current ?? null, next));
  }, []);

  useEffect(() => {
    if (previousHost.current === hostId) return;
    previousHost.current = hostId;
    setJobOverride(null);
    setCheckError(null);
    setStartBlockers(null);
    setReconnecting(false);
    autoAttempted.current = false;
  }, [hostId]);

  // A remount after the plugin reload has no job id. Ask for the latest persisted job explicitly.
  useEffect(() => {
    if (!query.data) return;
    let active = true;
    void readLatestUpdateJob(updateStatus, query.data.job).then((latest) => {
      if (active && latest) adoptJob(latest);
    });
    return () => {
      active = false;
    };
  }, [adoptJob, query.data, updateStatus]);

  const runCheck = useCallback(
    async (manual: boolean, preserveJob = false) => {
      if (checkingRef.current) return;
      checkingRef.current = true;
      setChecking(true);
      setStartBlockers(null);
      if (manual) setCheckError(null);
      try {
        const result = await checkVersion({ requestId: createRequestId() });
        if (result.ok) {
          if (!preserveJob) adoptJob(result.job);
          if (manual && result.job.state === "failed") {
            setCheckError(
              blockerViews(result.job.error ? [result.job.error] : [])[0]?.reason ?? null,
            );
          }
          await refetch();
          return;
        }
        if (manual) {
          setCheckError(blockerViews(result.blockers)[0]?.reason ?? zh.versionCheckFailedBody);
        }
        if (result.job) adoptJob(result.job);
      } catch {
        if (manual) setCheckError(zh.versionCheckFailedBody);
      } finally {
        checkingRef.current = false;
        setChecking(false);
      }
    },
    [adoptJob, checkVersion, refetch],
  );

  useEffect(() => {
    if (!query.data || autoAttempted.current) return;
    const now = Date.now();
    const lastAttempt = autoCheckTimes.get(hostId);
    if (lastAttempt !== undefined && now - lastAttempt < AUTO_CHECK_INTERVAL_MS) return;
    if (!shouldAutoCheck(query.data.info, query.data.job, now)) return;
    autoAttempted.current = true;
    autoCheckTimes.set(hostId, now);
    void runCheck(false);
  }, [hostId, query.data, runCheck]);

  useEffect(() => {
    if (checking || !job || !shouldCheckAfterUpdate(job, postUpdateChecked)) return;
    postUpdateChecked.add(job.id);
    void runCheck(false, true);
  }, [checking, job, runCheck]);

  useEffect(() => {
    if (!recovering) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const pending = pendingStarts.get(hostId);
    const parsedStart = pending ? Date.parse(pending.startedAt) : Number.NaN;
    const startedAt = Number.isNaN(parsedStart) ? Date.now() : parsedStart;
    const requestId = pending?.requestId ?? null;
    const tick = async () => {
      try {
        const result = await updateStatus({});
        if (!active) return;
        const step = resolveRecoveryStep({
          job: result.job,
          failed: false,
          startedAtMs: startedAt,
          nowMs: Date.now(),
          requestId,
        });
        if (step === "found") {
          setReconnecting(false);
          if (result.job) adoptJob(result.job);
          pendingStarts.delete(hostId);
          setRecovering(false);
          return;
        }
        if (step === "timed-out") {
          pendingStarts.delete(hostId);
          setRecovering(false);
          setReconnecting(false);
          setStartBlockers([
            { code: "apply_outcome_unknown", remedy: "inspect_recovery", detail: null },
          ]);
        }
      } catch {
        if (
          resolveRecoveryStep({
            job: null,
            failed: true,
            startedAtMs: startedAt,
            nowMs: Date.now(),
            requestId,
          }) === "reconnecting"
        ) {
          setReconnecting(true);
        }
      }
      if (active) timer = setTimeout(tick, 1000);
    };
    timer = setTimeout(tick, 1000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [adoptJob, hostId, recovering, updateStatus]);

  const startUpdate = useCallback(async () => {
    const currentInfo = query.data?.info;
    if (!currentInfo?.checkId) {
      setStartBlockers([{ code: "check_expired", remedy: "retry_check", detail: null }]);
      return;
    }
    setStarting(true);
    setStartBlockers(null);
    setReconnecting(false);
    const requestId = createRequestId();
    pendingStarts.set(hostId, {
      requestId,
      checkId: currentInfo.checkId,
      startedAt: new Date().toISOString(),
    });
    try {
      const result = await startVersionUpdate({
        requestId,
        checkId: currentInfo.checkId,
      });
      pendingStarts.delete(hostId);
      if (result.ok) {
        adoptJob(result.job);
      } else {
        setStartBlockers(result.blockers);
        if (result.job) adoptJob(result.job);
      }
    } catch {
      // The request may have reached the server before the connection dropped. Never re-send it;
      // look for the persisted job instead and keep reconnecting until it appears or times out.
      setReconnecting(true);
      setRecovering(true);
    } finally {
      setStarting(false);
    }
  }, [adoptJob, hostId, query.data?.info, startVersionUpdate]);

  const activeUpdateJobId = job?.kind === "update" && isJobActive(job) ? job.id : null;
  useEffect(() => {
    if (!activeUpdateJobId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const result = await updateStatus({ jobId: activeUpdateJobId });
        if (!active) return;
        const step = resolveUpdatePoll(result.job, false);
        if (step === "reconnecting") {
          setReconnecting(true);
        } else {
          setReconnecting(false);
          if (result.job) adoptJob(result.job);
          if (step === "finished") void refetch();
        }
      } catch {
        if (active && resolveUpdatePoll(null, true) === "reconnecting") {
          setReconnecting(true);
        }
      }
      if (active) timer = setTimeout(tick, 1000);
    };
    timer = setTimeout(tick, 1000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [activeUpdateJobId, adoptJob, refetch, updateStatus]);

  const refresh = useCallback(async () => {
    try {
      await refetch();
      setReconnecting(false);
    } catch {
      setReconnecting(true);
      return;
    }
    const latest = await readLatestUpdateJob(updateStatus, jobOverride);
    if (latest) adoptJob(latest);
  }, [adoptJob, jobOverride, refetch, updateStatus]);

  return {
    info,
    job,
    loading: query.isPending && !query.data,
    checking,
    starting,
    reconnecting: reconnecting || query.isError,
    recovering,
    checkError,
    startBlockers,
    checkNow: () => {
      if (job?.kind === "update" && isJobActive(job)) {
        void refresh();
        return;
      }
      void runCheck(true);
    },
    startUpdate: () => void startUpdate(),
    refresh: () => void refresh(),
  };
}

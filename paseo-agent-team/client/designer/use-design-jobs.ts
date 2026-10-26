import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { formatDesignIssue } from "../../shared/domain/design-output";
import {
  designCancelRpc,
  designContinueRpc,
  designResultRpc,
  designStartRpc,
  designStatusRpc,
} from "../../shared/rpc/design";
import type {
  DesignCancelInput,
  DesignCancelOutput,
  DesignContinueInput,
  DesignContinueOutput,
  DesignIssue,
  DesignJob,
  DesignResultInput,
  DesignResultOutput,
  DesignStartInput,
  DesignStartOutput,
  DesignStatusInput,
  DesignStatusOutput,
} from "../../shared/schemas/design";
import { designZh } from "../../shared/zh/design";
import {
  createDesignClientRequestId,
  fingerprintDesignStartInput,
  resolveDesignJobsRefreshInterval,
} from "./submission-state";

export type DesignJobsRpc = {
  start(input: DesignStartInput): Promise<DesignStartOutput>;
  status(input: DesignStatusInput): Promise<DesignStatusOutput>;
  result(input: DesignResultInput): Promise<DesignResultOutput>;
  cancel(input: DesignCancelInput): Promise<DesignCancelOutput>;
  continueJob(input: DesignContinueInput): Promise<DesignContinueOutput>;
};

export type UseDesignJobsOptions = {
  hostId: string;
  /** True only while the Team tab is visible; a hidden tab must not poll or save. */
  active: boolean;
  /** Test seam; the real screen leaves this undefined and uses the registered RPCs. */
  rpc?: Partial<DesignJobsRpc>;
};

export type DesignStartRequest = Omit<DesignStartInput, "clientRequestId"> & {
  clientRequestId?: string;
};

export type UseDesignJobsResult = {
  scopeId: string | null;
  jobs: readonly DesignJob[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
  discoveryIssues: readonly DesignIssue[];
  start(input: DesignStartRequest): Promise<DesignStartOutput>;
  cancel(jobId: string): Promise<DesignCancelOutput>;
  continueJob(input: {
    jobId: string;
    expectedRevision: string;
    action: "recheck" | "repair";
  }): Promise<DesignContinueOutput>;
  refresh(): Promise<readonly DesignJob[]>;
  result(jobId: string): Promise<DesignResultOutput>;
};

const EMPTY_JOBS: readonly DesignJob[] = [];
const EMPTY_ISSUES: readonly DesignIssue[] = [];

function statusError(issues: readonly DesignIssue[]): string {
  const first = issues[0];
  return first ? formatDesignIssue(first) : designZh.storageUnavailable;
}

/**
 * One status poll for the whole Team page. Jobs stay in the query cache while the card is folded,
 * and the query is disabled while the tab is hidden.
 */
export function useDesignJobs(options: UseDesignJobsOptions): UseDesignJobsResult {
  const { hostId, active } = options;
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["agent-team", "design-jobs", hostId], [hostId]);

  const startRpc = useRpc(designStartRpc);
  const statusRpc = useRpc(designStatusRpc);
  const resultRpc = useRpc(designResultRpc);
  const cancelRpc = useRpc(designCancelRpc);
  const continueRpc = useRpc(designContinueRpc);

  const startCall = options.rpc?.start ?? startRpc;
  const statusCall = options.rpc?.status ?? statusRpc;
  const resultCall = options.rpc?.result ?? resultRpc;
  const cancelCall = options.rpc?.cancel ?? cancelRpc;
  const continueCall = options.rpc?.continueJob ?? continueRpc;

  const query = useQuery({
    queryKey,
    enabled: active,
    queryFn: async () => {
      const output = await statusCall({});
      if (!output.ok) throw new Error(statusError(output.issues));
      return output;
    },
    refetchInterval: (current) =>
      resolveDesignJobsRefreshInterval(active, current.state.data?.jobs ?? EMPTY_JOBS),
  });

  const hostRef = useRef(hostId);
  const inFlight = useRef<{
    fingerprint: string;
    promise: Promise<DesignStartOutput>;
  } | null>(null);
  const unknownRequest = useRef<{ fingerprint: string; clientRequestId: string } | null>(null);

  useEffect(() => {
    if (hostRef.current === hostId) return;
    hostRef.current = hostId;
    inFlight.current = null;
    unknownRequest.current = null;
  }, [hostId]);

  const start = useCallback(
    (input: DesignStartRequest): Promise<DesignStartOutput> => {
      const { clientRequestId: explicitId, ...request } = input;
      const fingerprint = fingerprintDesignStartInput(request);
      const existing = inFlight.current;
      if (existing) {
        if (existing.fingerprint === fingerprint) return existing.promise;
        return Promise.reject(new Error(designZh.submitInFlight));
      }

      const hostAtStart = hostId;
      const remembered = explicitId ? null : unknownRequest.current;
      const id =
        explicitId ??
        (remembered && remembered.fingerprint === fingerprint
          ? remembered.clientRequestId
          : createDesignClientRequestId());
      const payload: DesignStartInput = { ...request, clientRequestId: id };

      const promise = startCall(payload).then(
        (output) => {
          if (hostRef.current === hostAtStart) {
            if (output.ok) {
              unknownRequest.current = null;
              void queryClient.invalidateQueries({ queryKey });
            } else if (unknownRequest.current?.clientRequestId === id) {
              unknownRequest.current = null;
            }
          }
          return output;
        },
        (cause: unknown) => {
          // Transport outcome unknown: the next identical submission replays the same id.
          if (hostRef.current === hostAtStart)
            unknownRequest.current = { fingerprint, clientRequestId: id };
          throw cause;
        },
      );
      const tracked = promise.finally(() => {
        if (inFlight.current?.promise === tracked) inFlight.current = null;
      });
      inFlight.current = { fingerprint, promise: tracked };
      return tracked;
    },
    [hostId, queryClient, queryKey, startCall],
  );

  const cancel = useCallback(
    async (jobId: string): Promise<DesignCancelOutput> => {
      const hostAtStart = hostRef.current;
      const output = await cancelCall({ jobId });
      if (hostRef.current === hostAtStart) void queryClient.invalidateQueries({ queryKey });
      return output;
    },
    [cancelCall, queryClient, queryKey],
  );

  const continueJob = useCallback(
    async (input: {
      jobId: string;
      expectedRevision: string;
      action: "recheck" | "repair";
    }): Promise<DesignContinueOutput> => {
      const hostAtStart = hostRef.current;
      const output = await continueCall(input);
      if (hostRef.current === hostAtStart) void queryClient.invalidateQueries({ queryKey });
      return output;
    },
    [continueCall, queryClient, queryKey],
  );

  const refresh = useCallback(async (): Promise<readonly DesignJob[]> => {
    const result = await query.refetch();
    return result.data?.jobs ?? EMPTY_JOBS;
  }, [query]);

  const readResult = useCallback(
    (jobId: string): Promise<DesignResultOutput> => resultCall({ jobId }),
    [resultCall],
  );

  useEffect(() => {
    if (query.error) console.error("agent-team design status failed", query.error);
  }, [query.error]);

  const data = query.data;
  return {
    scopeId: data?.scopeId ?? null,
    jobs: (data?.jobs ?? EMPTY_JOBS) as readonly DesignJob[],
    loading: active && query.isPending,
    error: query.error === null || query.error === undefined ? null : designZh.storageUnavailable,
    truncated: data?.truncated ?? false,
    discoveryIssues: (data?.discoveryIssues ?? EMPTY_ISSUES) as readonly DesignIssue[],
    start,
    cancel,
    continueJob,
    refresh,
    result: readResult,
  };
}

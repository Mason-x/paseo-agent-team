import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { formatDesignIssue } from "../../shared/domain/design-output";
import type { DesignJob } from "../../shared/schemas/design";
import type { Team } from "../../shared/schemas/team";
import { designZh } from "../../shared/zh/design";
import { designGapZh } from "../../shared/zh/design-gap";
import { DesignJobCard } from "./DesignJobCard";
import { DesignResultCard } from "./DesignResultCard";
import type { DesignGapConfigureEconomy, DesignGapOpenRole } from "./DesignRoleGapCard";
import type { DesignerPrefill, DesignLaunchSeed } from "./design-screen-state";
import {
  designLaunchSeed,
  designSaveAttemptKey,
  shouldAutoSaveDesignJob,
  shouldCleanupDesignJob,
} from "./design-screen-state";
import { planDesignGapRetry } from "./submission-state";
import type { UseDesignJobsResult } from "./use-design-jobs";
import { type UseDesignSaveResult, useDesignSave } from "./use-design-save";

export type DesignJobsPanelProps = {
  theme: PluginScreenProps["theme"];
  hostId: string;
  jobs: UseDesignJobsResult;
  teams: readonly Team[];
  active: boolean;
  clientId: string;
  navigation: PluginScreenProps["navigation"];
  onPreviewLaunch: (seed: DesignLaunchSeed) => void;
  /** The host's mode contract from the `team.plan` probe (I02 passes it; absent = baseline). */
  modeContract?: "v2" | "legacy" | "unknown";
  /**
   * Role-gap exits, passed straight through to the card. The screen wires them (I02); a missing
   * callback hides its button.
   */
  onGapRetry?: (prefill: DesignerPrefill) => void;
  onOpenRole?: (target: DesignGapOpenRole) => void;
  onConfigureEconomy?: (target: DesignGapConfigureEconomy) => void;
  onCreateRole?: () => void;
};

function DesignJobSection({
  theme,
  hostId,
  job,
  active,
  navigation,
  jobs,
  teamExists,
  save,
  attemptedSaves,
  attemptedCleanups,
  saveNotice,
  cleanupNotice,
  onSaveNotice,
  onPreviewLaunch,
  onGapRetry,
  onOpenRole,
  onConfigureEconomy,
  onCreateRole,
}: {
  theme: PluginScreenProps["theme"];
  hostId: string;
  job: DesignJob;
  active: boolean;
  navigation: PluginScreenProps["navigation"];
  jobs: UseDesignJobsResult;
  teamExists: boolean;
  save: UseDesignSaveResult;
  attemptedSaves: Set<string>;
  attemptedCleanups: Set<string>;
  saveNotice: string | undefined;
  cleanupNotice: string | undefined;
  onSaveNotice: (jobId: string, message: string) => void;
  onPreviewLaunch: (seed: DesignLaunchSeed) => void;
  onGapRetry?: (prefill: DesignerPrefill) => void;
  onOpenRole?: (target: DesignGapOpenRole) => void;
  onConfigureEconomy?: (target: DesignGapConfigureEconomy) => void;
  onCreateRole?: () => void;
}) {
  const [actionPending, setActionPending] = useState(false);
  const [gapRetry, setGapRetry] = useState<{ busy: boolean; notice: string | null }>({
    busy: false,
    notice: null,
  });
  const unknownWrite = save.unknownWrites.has(job.jobId);
  const attemptKey = designSaveAttemptKey(job);

  useEffect(() => {
    if (!attemptKey || !shouldAutoSaveDesignJob(active, job)) return;
    if (attemptedSaves.has(attemptKey)) return;
    const resultId = job.resultId;
    if (!resultId) return;
    attemptedSaves.add(attemptKey);
    void save.save(job.jobId, resultId).catch(() => onSaveNotice(job.jobId, designZh.saveRefused));
  }, [active, attemptedSaves, attemptKey, job, onSaveNotice, save]);

  useEffect(() => {
    if (!attemptKey) return;
    if (
      !shouldCleanupDesignJob({
        active,
        job,
        unknownWrite,
        attempted: attemptedCleanups.has(attemptKey),
        savePending: save.pending,
      })
    ) {
      return;
    }
    const resultId = job.resultId;
    if (!resultId) return;
    void save
      .cleanup(job.jobId, resultId)
      .then((outcome) => {
        // A null means the runner refused (stale host / save still in flight): retry later.
        if (outcome !== null) attemptedCleanups.add(attemptKey);
      })
      .catch(() => onSaveNotice(job.jobId, designZh.saveRefused));
  }, [active, attemptedCleanups, attemptKey, job, onSaveNotice, save, unknownWrite]);

  const resultQuery = useQuery({
    queryKey: ["agent-team", "design-result", hostId, job.jobId, job.resultId],
    enabled: job.resultId !== null,
    queryFn: () => jobs.result(job.jobId),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  useEffect(() => {
    if (resultQuery.error) {
      console.error("agent-team design result failed", resultQuery.error);
    }
  }, [resultQuery.error]);
  const result = resultQuery.data?.ok ? resultQuery.data.result : null;
  const resultIssue =
    resultQuery.data && !resultQuery.data.ok
      ? resultQuery.data.issues[0]
        ? formatDesignIssue(resultQuery.data.issues[0])
        : designZh.resultLoadFail
      : resultQuery.error
        ? designZh.resultLoadFail
        : resultQuery.data?.ok && resultQuery.data.result === null
          ? designZh.resultLoadFail
          : null;

  async function retrySave() {
    if (actionPending) return;
    setActionPending(true);
    onSaveNotice(job.jobId, "");
    try {
      const latest = await jobs.refresh();
      const fresh = latest.find((entry) => entry.jobId === job.jobId);
      if (!fresh?.resultId) {
        onSaveNotice(job.jobId, designZh.saveRefused);
        return;
      }
      const outcome = await save.save(job.jobId, fresh.resultId);
      if (outcome === null) onSaveNotice(job.jobId, designZh.saveRefused);
    } catch {
      onSaveNotice(job.jobId, designZh.saveRefused);
    } finally {
      setActionPending(false);
    }
  }

  /**
   * Fills the designer form with the original request, the same mode, target, and Profile intent,
   * and the switch off. Nothing is started and the job keeps its gaps.
   */
  async function retryWithoutRule() {
    if (gapRetry.busy || !onGapRetry) return;
    setGapRetry({ busy: true, notice: null });
    try {
      const source = await jobs.retrySourceFor(job);
      const plan = planDesignGapRetry(job, source);
      if (!plan.ok) {
        setGapRetry({ busy: false, notice: designGapZh.retryUnavailable });
        return;
      }
      onGapRetry(plan.prefill);
      setGapRetry({ busy: false, notice: null });
    } catch {
      setGapRetry({ busy: false, notice: designGapZh.retryUnavailable });
    }
  }

  async function cancelDesign() {
    if (actionPending) return;
    setActionPending(true);
    try {
      save.abort(job.jobId);
      const output = await jobs.cancel(job.jobId);
      if (!output.ok) {
        onSaveNotice(
          job.jobId,
          output.issues[0] ? formatDesignIssue(output.issues[0]) : designZh.cancelFailed,
        );
      }
      void jobs.refresh();
    } catch {
      onSaveNotice(job.jobId, designZh.cancelFailed);
    } finally {
      setActionPending(false);
    }
  }

  async function continueDesign(action: "recheck" | "repair") {
    if (actionPending) return;
    setActionPending(true);
    try {
      const output = await jobs.continueJob({
        jobId: job.jobId,
        expectedRevision: job.stateRevision,
        action,
      });
      if (!output.ok) {
        onSaveNotice(
          job.jobId,
          output.issues[0] ? formatDesignIssue(output.issues[0]) : designZh.stateChanged,
        );
      }
      void jobs.refresh();
    } catch {
      onSaveNotice(job.jobId, designZh.stateChanged);
    } finally {
      setActionPending(false);
    }
  }

  const warning = { color: theme.colors.statusWarning, fontSize: 12 };
  const danger = { color: theme.colors.statusDanger, fontSize: 12 };

  return (
    <View style={{ gap: 8 }}>
      <DesignJobCard
        theme={theme}
        job={job}
        hostId={hostId}
        navigation={navigation}
        busy={actionPending || save.pending}
        forceRetrySave={Boolean(saveNotice) && job.allowed.save && job.resultId !== null}
        onCancel={() => void cancelDesign()}
        onRetrySave={() => void retrySave()}
        onContinue={(_current, action) => void continueDesign(action)}
        onGapRetry={onGapRetry ? () => void retryWithoutRule() : undefined}
        gapRetryBusy={gapRetry.busy}
        gapRetryNotice={gapRetry.notice}
        onOpenRole={onOpenRole}
        onConfigureEconomy={onConfigureEconomy}
        onCreateRole={onCreateRole}
      />
      {saveNotice ? <Text style={warning}>{saveNotice}</Text> : null}
      {cleanupNotice ? <Text style={warning}>{cleanupNotice}</Text> : null}
      {unknownWrite ? <Text style={danger}>{designZh.saveUnknown}</Text> : null}
      {result ? (
        <DesignResultCard
          theme={theme}
          result={result}
          savedTeamId={job.savedTeamId}
          launchDisabledReason={
            job.savedTeamId && !teamExists ? designZh.savedTeamDeleted : undefined
          }
          onPreviewLaunch={(prefill) => onPreviewLaunch(designLaunchSeed(prefill, result.resultId))}
        />
      ) : null}
      {resultIssue ? <Text style={danger}>{resultIssue}</Text> : null}
    </View>
  );
}

export function DesignJobsPanel({
  theme,
  hostId,
  jobs,
  teams,
  active,
  clientId,
  navigation,
  onPreviewLaunch,
  modeContract,
  onGapRetry,
  onOpenRole,
  onConfigureEconomy,
  onCreateRole,
}: DesignJobsPanelProps) {
  const toast = useToast();
  const [saveNotices, setSaveNotices] = useState<Record<string, string>>({});
  const [cleanupNotices, setCleanupNotices] = useState<Record<string, string>>({});
  const attemptedSaves = useRef(new Set<string>());
  const attemptedCleanups = useRef(new Set<string>());
  const save = useDesignSave({
    hostId,
    clientId,
    ...(modeContract === undefined ? {} : { modeContract }),
    onOutcome: (jobId, outcome) => {
      if (outcome.status === "saved") {
        setSaveNotices((current) => ({ ...current, [jobId]: "" }));
        toast.show(designZh.saveSucceeded, { variant: "success" });
      } else if (outcome.status === "waiting") {
        setSaveNotices((current) => ({ ...current, [jobId]: designZh.savePendingReview }));
      } else {
        setSaveNotices((current) => ({ ...current, [jobId]: designZh.saveRefused }));
      }
      void jobs.refresh();
    },
    onCleanupOutcome: (jobId, outcome) => {
      if (outcome.status === "compensated") {
        setCleanupNotices((current) => ({ ...current, [jobId]: "" }));
        toast.show(designZh.cleanupDone, { variant: "success" });
      } else {
        setCleanupNotices((current) => ({ ...current, [jobId]: designZh.cleanupPending }));
      }
      void jobs.refresh();
    },
  });

  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const warning = { color: theme.colors.statusWarning, fontSize: 12 };
  const danger = { color: theme.colors.statusDanger, fontSize: 12 };
  if (jobs.loading) return <Text style={muted}>{designZh.jobsLoading}</Text>;
  if (jobs.jobs.length === 0) {
    return jobs.error ? <Text style={danger}>{designZh.jobsError(jobs.error)}</Text> : null;
  }
  const discoveryIssue = jobs.discoveryIssues[0];
  return (
    <View style={{ gap: 8 }}>
      {jobs.error ? <Text style={warning}>{designZh.jobsError(jobs.error)}</Text> : null}
      {jobs.truncated ? <Text style={warning}>{designZh.jobsTruncated}</Text> : null}
      {discoveryIssue ? <Text style={warning}>{formatDesignIssue(discoveryIssue)}</Text> : null}
      {jobs.jobs.map((job) => (
        <DesignJobSection
          key={job.jobId}
          theme={theme}
          hostId={hostId}
          job={job}
          active={active}
          navigation={navigation}
          jobs={jobs}
          teamExists={teams.some((team) => team.id === job.savedTeamId)}
          save={save}
          attemptedSaves={attemptedSaves.current}
          attemptedCleanups={attemptedCleanups.current}
          saveNotice={saveNotices[job.jobId]}
          cleanupNotice={cleanupNotices[job.jobId]}
          onSaveNotice={(jobId, message) =>
            setSaveNotices((current) => ({ ...current, [jobId]: message }))
          }
          onPreviewLaunch={onPreviewLaunch}
          onGapRetry={onGapRetry}
          onOpenRole={onOpenRole}
          onConfigureEconomy={onConfigureEconomy}
          onCreateRole={onCreateRole}
        />
      ))}
    </View>
  );
}

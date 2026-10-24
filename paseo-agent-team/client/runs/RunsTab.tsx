import { type PluginScreenProps, usePaseo } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { runProgress, type TeamRun } from "../../shared/domain/run-progress";
import { zh } from "../../shared/zh";
import { formatAge } from "../crew";
import { FollowUpDialog, type FollowUpTarget } from "../crew/FollowUpDialog";
import { deliveredRatio, MemberCounts, PhaseBadge, ProgressBar } from "../crew/progress-ui";
import { RunDetail } from "../crew/RunDetail";
import { GhostIconButton } from "../shared/buttons";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { EmptyState } from "../shared/EmptyState";
import { ErrorState } from "../shared/ErrorState";
import type { PluginTheme } from "../shared/theme";
import { useTeamRuns } from "./use-team-runs";

const CLOCK_INTERVAL_MS = 30_000;

type Navigation = PluginScreenProps["navigation"];

function RunCard({
  theme,
  run,
  workspaceName,
  now,
  expanded,
  navigation,
  onToggle,
  onFollowUp,
  onArchive,
}: {
  theme: PluginTheme;
  run: TeamRun;
  workspaceName: string | undefined;
  now: number;
  expanded: boolean;
  navigation: Navigation;
  onToggle: () => void;
  onFollowUp: (target: FollowUpTarget) => void;
  onArchive: (run: TeamRun) => void;
}) {
  const progress = runProgress(run);
  const ratio = deliveredRatio(progress);
  const teamName = run.teamName ?? zh.teamFallback;
  const coordinator = run.coordinator;
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const age = formatAge(Date.parse(run.startedAt), now);
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
        overflow: "hidden",
      }}
    >
      <View style={{ padding: 12, gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <PhaseBadge theme={theme} phase={progress.phase} />
          <Text
            style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600", flex: 1 }}
            numberOfLines={1}
          >
            {teamName}
          </Text>
          {age ? <Text style={muted}>{zh.elapsed(age)}</Text> : null}
        </View>
        {run.task ? (
          <Text style={{ color: theme.colors.foreground, fontSize: 13 }} numberOfLines={2}>
            {run.task}
          </Text>
        ) : null}
        <Text style={muted} numberOfLines={1}>
          {[
            workspaceName,
            coordinator
              ? coordinator.model
                ? `${zh.coordinatorLabel} ${coordinator.provider}/${coordinator.model}`
                : `${zh.coordinatorLabel} ${coordinator.provider}`
              : null,
            zh.membersCount(progress.total),
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
        <MemberCounts theme={theme} progress={progress} />
        {ratio !== null ? <ProgressBar theme={theme} value={ratio} /> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 2 }}>
          <GhostIconButton
            theme={theme}
            icon="ListChecks"
            color={expanded ? theme.colors.accent : undefined}
            accessibilityLabel={zh.progress}
            onPress={onToggle}
          />
          {coordinator ? (
            <GhostIconButton
              theme={theme}
              icon="MessageSquarePlus"
              accessibilityLabel={zh.followUp}
              onPress={() => onFollowUp({ coordinatorId: coordinator.id, teamName })}
            />
          ) : null}
          {navigation && run.workspaceId ? (
            <GhostIconButton
              theme={theme}
              icon="FolderOpen"
              accessibilityLabel={zh.openWorkspace}
              onPress={() => navigation.openWorkspace({ workspaceId: run.workspaceId ?? "" })}
            />
          ) : null}
          {navigation && coordinator ? (
            <GhostIconButton
              theme={theme}
              icon="SquareArrowOutUpRight"
              accessibilityLabel={zh.openCoordinator}
              onPress={() => navigation.openAgent({ agentId: coordinator.id })}
            />
          ) : null}
          <GhostIconButton
            theme={theme}
            icon="Archive"
            danger
            accessibilityLabel={zh.archiveRun}
            onPress={() => onArchive(run)}
          />
        </View>
      </View>
      {expanded ? (
        <RunDetail
          theme={theme}
          run={run}
          onOpenAgent={navigation ? (agentId) => navigation.openAgent({ agentId }) : undefined}
        />
      ) : null}
    </View>
  );
}

/** Live progress of every Team run on this host, across workspaces. */
export function RunsTab({
  theme,
  hostId,
  navigation,
}: {
  theme: PluginTheme;
  hostId: string;
  navigation: Navigation;
}) {
  const paseo = usePaseo();
  const toast = useToast();
  const { runs, workspaceNames, error, isPending, refetch } = useTeamRuns(hostId);
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [followUp, setFollowUp] = useState<FollowUpTarget | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<TeamRun | null>(null);

  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => clearInterval(clock);
  }, []);

  async function archiveRun(run: TeamRun) {
    try {
      if (run.coordinator) await paseo.agents.ref(run.coordinator.id).archive();
      for (const member of run.members) {
        await paseo.agents
          .ref(member.id)
          .archive()
          .catch(() => undefined);
      }
      toast.show(zh.runArchived, { variant: "success" });
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : zh.agentActionFailed);
    } finally {
      void refetch();
    }
  }

  if (error) {
    return (
      <ErrorState
        theme={theme}
        title={zh.loadRunsFail}
        body={error instanceof Error ? error.message : zh.loadRunsFail}
        actionLabel={zh.retry}
        onAction={() => void refetch()}
      />
    );
  }
  if (isPending) {
    return <Text style={{ color: theme.colors.foregroundMuted }}>{zh.loading(zh.runs)}</Text>;
  }
  return (
    <View style={{ gap: 10 }}>
      {runs.length === 0 ? (
        <EmptyState theme={theme} title={zh.noRuns} body={zh.noRunsBody} />
      ) : (
        runs.map((run) => (
          <RunCard
            key={run.runId}
            theme={theme}
            run={run}
            workspaceName={run.workspaceId ? workspaceNames?.get(run.workspaceId) : undefined}
            now={now}
            expanded={expanded.has(run.runId)}
            navigation={navigation}
            onToggle={() =>
              setExpanded((current) => {
                const next = new Set(current);
                if (next.has(run.runId)) next.delete(run.runId);
                else next.add(run.runId);
                return next;
              })
            }
            onFollowUp={setFollowUp}
            onArchive={setArchiveTarget}
          />
        ))
      )}
      <FollowUpDialog theme={theme} target={followUp} onClose={() => setFollowUp(null)} />
      <ConfirmDialog
        theme={theme}
        open={archiveTarget !== null}
        title={zh.archiveRunTitle(archiveTarget?.teamName ?? zh.teamFallback)}
        body={zh.archiveRunBody}
        confirmLabel={zh.archive}
        danger
        onCancel={() => setArchiveTarget(null)}
        onConfirm={() => {
          const target = archiveTarget;
          setArchiveTarget(null);
          if (target) void archiveRun(target);
        }}
      />
    </View>
  );
}

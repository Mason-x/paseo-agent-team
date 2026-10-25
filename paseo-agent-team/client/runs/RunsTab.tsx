import { type PluginScreenProps, usePaseo } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  buildRunRows,
  filterCounts,
  filterRows,
  isLive,
  RUN_FILTERS,
  RUN_PAGE_SIZE,
  type RunFilter,
  type RunRow,
  runTask,
  runTimeLabel,
  showsFollowUp,
} from "../../shared/domain/run-list";
import type { TeamRun } from "../../shared/domain/run-progress";
import type { RunSummary } from "../../shared/schemas/preferences";
import { zh } from "../../shared/zh";
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

const FILTER_LABELS: Record<RunFilter, string> = {
  all: zh.filterAll,
  attention: zh.filterAttention,
  active: zh.filterActive,
  ended: zh.filterEnded,
};

function RunCard({
  theme,
  row,
  task,
  workspaceName,
  now,
  expanded,
  navigation,
  onToggle,
  onFollowUp,
  onArchive,
}: {
  theme: PluginTheme;
  row: RunRow;
  task: string | undefined;
  workspaceName: string | undefined;
  now: number;
  expanded: boolean;
  navigation: Navigation;
  onToggle: () => void;
  onFollowUp: (target: FollowUpTarget) => void;
  onArchive: (run: TeamRun) => void;
}) {
  const { run, progress } = row;
  const live = isLive(progress.phase);
  const ratio = live ? deliveredRatio(progress) : null;
  const teamName = run.teamName ?? zh.teamFallback;
  const coordinator = run.coordinator;
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const coordinatorModel = coordinator
    ? coordinator.model
      ? `${coordinator.provider}/${coordinator.model}`
      : coordinator.provider
    : null;
  const meta = [
    workspaceName,
    coordinatorModel ? `${zh.coordinatorLabel} ${coordinatorModel}` : null,
    zh.membersCount(progress.total),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
        overflow: "hidden",
        opacity: live ? 1 : 0.86,
      }}
    >
      <View style={{ paddingHorizontal: 12, paddingVertical: 10, gap: 4 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${zh.progress} ${teamName}`}
          accessibilityState={{ expanded }}
          onPress={onToggle}
          style={({ pressed }) => [{ gap: 4 }, pressed && { opacity: 0.7 }]}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <PhaseBadge theme={theme} phase={progress.phase} />
            <Text
              style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600", flex: 1 }}
              numberOfLines={1}
            >
              {teamName}
            </Text>
            <Text style={muted}>{runTimeLabel(run, progress.phase, now)}</Text>
          </View>
          <Text
            style={{
              color: task ? theme.colors.foreground : theme.colors.foregroundMuted,
              fontSize: 13,
            }}
            numberOfLines={2}
          >
            {task ?? zh.noTaskRecorded}
          </Text>
          <Text style={muted} numberOfLines={1}>
            {meta}
          </Text>
        </Pressable>
        {ratio !== null ? <ProgressBar theme={theme} value={ratio} /> : null}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 4,
          }}
        >
          <MemberCounts theme={theme} progress={progress} />
          <View style={{ flexDirection: "row", gap: 2 }}>
            <GhostIconButton
              theme={theme}
              icon="ListChecks"
              color={expanded ? theme.colors.accent : undefined}
              accessibilityLabel={zh.progress}
              onPress={onToggle}
            />
            {showsFollowUp(run, progress.phase) ? (
              <GhostIconButton
                theme={theme}
                icon="MessageSquarePlus"
                accessibilityLabel={zh.followUp}
                onPress={() => onFollowUp({ coordinatorId: run.coordinator.id, teamName })}
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

function FilterChips({
  theme,
  counts,
  value,
  onChange,
}: {
  theme: PluginTheme;
  counts: Record<RunFilter, number>;
  value: RunFilter;
  onChange: (filter: RunFilter) => void;
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {RUN_FILTERS.map((filter) => {
        const selected = filter === value;
        const alert = filter === "attention" && counts.attention > 0;
        return (
          <Pressable
            key={filter}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => onChange(filter)}
            style={{
              minHeight: 28,
              justifyContent: "center",
              paddingHorizontal: 11,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: selected ? theme.colors.accent : theme.colors.border,
              backgroundColor: selected ? theme.colors.surface2 : theme.colors.surface1,
            }}
          >
            <Text
              style={{
                fontSize: 12,
                fontWeight: selected || alert ? "600" : "400",
                color: alert
                  ? theme.colors.statusWarning
                  : selected
                    ? theme.colors.foreground
                    : theme.colors.foregroundMuted,
              }}
            >
              {FILTER_LABELS[filter]} {counts[filter]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Live progress of every Team run on this host, across workspaces. */
export function RunsTab({
  theme,
  hostId,
  navigation,
  legacyRuns,
}: {
  theme: PluginTheme;
  hostId: string;
  navigation: Navigation;
  /** Runs recorded in preferences by versions that did not label the task on the agent. */
  legacyRuns: readonly RunSummary[];
}) {
  const paseo = usePaseo();
  const toast = useToast();
  const { runs, workspaceNames, error, isPending, refetch } = useTeamRuns(hostId);
  const [now, setNow] = useState(() => Date.now());
  const [filter, setFilter] = useState<RunFilter>("all");
  const [limit, setLimit] = useState(RUN_PAGE_SIZE);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [followUp, setFollowUp] = useState<FollowUpTarget | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<TeamRun | null>(null);
  const rows = useMemo(() => buildRunRows(runs), [runs]);
  const counts = useMemo(() => filterCounts(rows), [rows]);
  const shown = useMemo(() => filterRows(rows, filter), [rows, filter]);

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
  const visible = shown.slice(0, limit);
  const hidden = shown.length - visible.length;
  return (
    <View style={{ gap: 8 }}>
      {rows.length === 0 ? (
        <EmptyState theme={theme} title={zh.noRuns} body={zh.noRunsBody} />
      ) : (
        <>
          <FilterChips
            theme={theme}
            counts={counts}
            value={filter}
            onChange={(next) => {
              setFilter(next);
              setLimit(RUN_PAGE_SIZE);
            }}
          />
          {visible.length === 0 ? (
            <Text style={{ color: theme.colors.foregroundMuted, padding: 12 }}>
              {zh.noRunsInFilter}
            </Text>
          ) : null}
          {visible.map((row) => (
            <RunCard
              key={row.run.runId}
              theme={theme}
              row={row}
              task={runTask(row.run, legacyRuns)}
              workspaceName={
                row.run.workspaceId ? workspaceNames?.get(row.run.workspaceId) : undefined
              }
              now={now}
              expanded={expanded.has(row.run.runId)}
              navigation={navigation}
              onToggle={() =>
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(row.run.runId)) next.delete(row.run.runId);
                  else next.add(row.run.runId);
                  return next;
                })
              }
              onFollowUp={setFollowUp}
              onArchive={setArchiveTarget}
            />
          ))}
          {hidden > 0 ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setLimit((current) => current + RUN_PAGE_SIZE)}
              style={{ alignSelf: "center", paddingVertical: 8, paddingHorizontal: 12 }}
            >
              <Text style={{ color: theme.colors.accent, fontWeight: "600", fontSize: 13 }}>
                {zh.showEarlierRuns(hidden)}
              </Text>
            </Pressable>
          ) : null}
        </>
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

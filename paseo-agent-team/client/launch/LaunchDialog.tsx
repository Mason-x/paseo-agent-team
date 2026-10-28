import { useRpc } from "@getpaseo/plugin/client";
import { copyText, Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ModeContractSupport } from "../../shared/domain/mode-contract";
import type { PaseoAdapter } from "../../shared/paseo/adapter";
import {
  type LaunchJob,
  type LaunchTarget,
  launchPreviewRpc,
  launchStartRpc,
  launchStatusRpc,
} from "../../shared/rpc";
import type { LaunchPreviewResult } from "../../shared/schemas/launch-preview";
import type { Role } from "../../shared/schemas/role";
import type { Team } from "../../shared/schemas/team";
import { zh } from "../../shared/zh";
import { ModalActions } from "../shared/buttons";
import { CompactPicker } from "../shared/CompactPicker";
import { TextField } from "../shared/Field";
import { RoleGlyph } from "../shared/RoleGlyph";
import type { PluginLayout, PluginTheme } from "../shared/theme";
import { LaunchPreview } from "./LaunchPreview";
import {
  launchModeDisplay,
  launchPreviewRequest,
  launchStartRequest,
  launchStatusRequest,
} from "./launch-args";
import {
  launchGate,
  launchPreviewCacheKey,
  PREVIEW_TASK_DEBOUNCE_MS,
  previewTaskState,
  startFailureAction,
} from "./launch-preview-state";
import { useLaunchContext } from "./use-launch-context";

const POLL_MS = 800;

type TargetKind = LaunchTarget["kind"];

function jobProgressLabel(job: LaunchJob): string {
  if (job.step === "workspace") return zh.creatingWorkspace;
  if (job.step === "coordinator") return zh.creatingCoordinator;
  if (job.step === "member") return zh.creatingMember(job.memberIndex ?? 1, job.memberTotal);
  return zh.sendingKickoff;
}

function jobErrorText(job: LaunchJob): string | null {
  const error = job.error;
  if (!error) return null;
  const outcome = error.archived
    ? zh.archivedCreated
    : error.agentIdsKept.length > 0 && error.step !== "kickoff"
      ? zh.keptCreated
      : "";
  return [`${error.message}${outcome}`, error.detail ? zh.errorDetail(error.detail) : null]
    .filter(Boolean)
    .join("\n");
}

function SegmentedTarget({
  theme,
  value,
  onChange,
}: {
  theme: PluginTheme;
  value: TargetKind;
  onChange: (value: TargetKind) => void;
}) {
  const options: Array<{ id: TargetKind; label: string }> = [
    { id: "workspace", label: zh.existingWorkspace },
    { id: "new-workspace", label: zh.newWorkspaceOption },
  ];
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{zh.target}</Text>
      <View
        style={{
          flexDirection: "row",
          alignSelf: "flex-start",
          padding: 2,
          gap: 2,
          borderRadius: 8,
          backgroundColor: theme.colors.surface1,
        }}
      >
        {options.map((option) => {
          const selected = option.id === value;
          return (
            <Pressable
              key={option.id}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => onChange(option.id)}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 5,
                borderRadius: 6,
                backgroundColor: selected ? theme.colors.surface2 : "transparent",
              }}
            >
              <Text
                style={{
                  color: selected ? theme.colors.foreground : theme.colors.foregroundMuted,
                  fontWeight: "600",
                  fontSize: 13,
                }}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/**
 * Requests a host preview, then starts with its plan hash. The host re-validates and creates the
 * team in the background. Closing the dialog mid-launch is safe: the host keeps going.
 *
 * Mount it per launch request: the initial Team and task seed its state once, so a catalog
 * refresh never overwrites what the user is typing.
 */
export function LaunchDialog({
  theme,
  layout,
  open,
  adapter,
  hostId,
  teams,
  roles,
  initialTeamId,
  lockTeam,
  initialTask,
  initialWorkspaceId,
  workspaceId: fixedWorkspaceId,
  onClose,
  onLaunched,
  onEditTeam,
  modeContract = "legacy",
  probeSettled = true,
}: {
  theme: PluginTheme;
  layout: PluginLayout;
  open: boolean;
  adapter: PaseoAdapter;
  hostId: string;
  teams: readonly Team[];
  roles: readonly Role[];
  initialTeamId?: string;
  /** Hide the Team picker: the caller already chose the Team. */
  lockTeam?: boolean;
  initialTask?: string;
  /** Preselected, still-editable workspace target; unlike `workspaceId`, it never locks the target. */
  initialWorkspaceId?: string;
  /** Launch into this workspace; otherwise the user picks or creates one. */
  workspaceId?: string;
  onClose: () => void;
  onLaunched: (runId: string, workspaceId: string | undefined) => void;
  /** Hosts that can navigate to the Team editor pass this; the saved mode is edited there. */
  onEditTeam?: (team: Team) => void;
  /** The team.plan probe result; only v2 requests declare contractVersion 2. */
  modeContract?: ModeContractSupport;
  /** False until the probe settles: preview/start stay off (W-I2-1). */
  probeSettled?: boolean;
}) {
  const toast = useToast();
  const start = useRpc(launchStartRpc);
  const status = useRpc(launchStatusRpc);
  const context = useLaunchContext(adapter, hostId, {
    open,
    withTargets: !fixedWorkspaceId,
  });
  const defaultTeamId =
    initialTeamId && teams.some((entry) => entry.id === initialTeamId)
      ? initialTeamId
      : (teams[0]?.id ?? "");
  const [teamId, setTeamId] = useState(defaultTeamId);
  const [targetKind, setTargetKind] = useState<TargetKind>("workspace");
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId ?? "");
  const [projectId, setProjectId] = useState("");
  const [newWorkspaceTitle, setNewWorkspaceTitle] = useState("");
  const [task, setTask] = useState(initialTask ?? "");
  const [composing, setComposing] = useState(false);
  const [debouncedTask, setDebouncedTask] = useState(() => (initialTask ?? "").trim());
  const [starting, setStarting] = useState(false);
  const [job, setJob] = useState<LaunchJob | null>(null);
  const [serverBlockers, setServerBlockers] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shownPreview, setShownPreview] = useState<{
    identity: string;
    result: LaunchPreviewResult;
  } | null>(null);
  const startingRef = useRef(false);
  const announcedRunId = useRef<string | null>(null);

  // A single-project host has nothing to choose.
  useEffect(() => {
    const only = context.projects.length === 1 ? context.projects[0] : undefined;
    if (only && !projectId) setProjectId(only.id);
  }, [context.projects, projectId]);

  useEffect(() => {
    if (job?.state !== "running") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      status(launchStatusRequest(job.runId, modeContract))
        .then((next) => {
          if (cancelled) return;
          if (next.job) {
            setJob(next.job);
          } else {
            setJob(null);
            setError(zh.launchStatusLost);
          }
        })
        .catch(() => {
          // Transient transport failure: poll again with a fresh reference.
          if (!cancelled) setJob((current) => (current ? { ...current } : current));
        });
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [job, modeContract, status]);

  useEffect(() => {
    if (job?.state !== "succeeded" || announcedRunId.current === job.runId) return;
    announcedRunId.current = job.runId;
    toast.show(zh.launched, { variant: "success" });
    onLaunched(job.runId, job.workspaceId);
  }, [job, onLaunched, toast]);

  const team = teams.find((entry) => entry.id === teamId);
  const modeDisplay = launchModeDisplay(team);
  const savedMode = team?.mode ?? "";
  const target: LaunchTarget | null = fixedWorkspaceId
    ? { kind: "workspace", workspaceId: fixedWorkspaceId }
    : targetKind === "workspace"
      ? workspaceId
        ? { kind: "workspace", workspaceId }
        : null
      : projectId
        ? {
            kind: "new-workspace",
            projectId,
            ...(newWorkspaceTitle.trim() ? { title: newWorkspaceTitle.trim() } : {}),
          }
        : null;
  const running = job?.state === "running";
  const trimmedTask = task.trim();
  const { task: previewTask, pending: taskPending } = previewTaskState(
    trimmedTask,
    debouncedTask,
    composing,
  );
  useEffect(() => {
    // Web composition is explicit; native IMEs only have this quiet-period merge.
    if (composing) return;
    const timer = setTimeout(() => setDebouncedTask(trimmedTask), PREVIEW_TASK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [composing, trimmedTask]);
  const preview = useRpc(launchPreviewRpc);
  const previewCacheKey = launchPreviewCacheKey(
    { hostId, teamId, task: previewTask, target, savedMode },
    modeContract,
  );
  const currentIdentity = JSON.stringify(previewCacheKey);
  const previewQuery = useQuery({
    queryKey: previewCacheKey,
    enabled:
      open &&
      probeSettled &&
      Boolean(teamId) &&
      previewTask.length > 0 &&
      target !== null &&
      !running,
    queryFn: async () => {
      if (!target) throw new Error(zh.modes.previewNoTarget);
      return preview(launchPreviewRequest({ teamId, task: previewTask, target }, modeContract));
    },
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const previewError = previewQuery.error
    ? previewQuery.error instanceof Error
      ? previewQuery.error.message
      : zh.modes.previewFailed
    : null;
  useEffect(() => {
    if (!previewQuery.data) {
      if (!previewQuery.isFetching) setShownPreview(null);
      return;
    }
    setShownPreview({ identity: currentIdentity, result: previewQuery.data });
  }, [currentIdentity, previewQuery.data, previewQuery.isFetching]);
  const visiblePreview =
    shownPreview && (shownPreview.identity === currentIdentity || previewQuery.isFetching)
      ? shownPreview.result
      : undefined;
  const gate = launchGate({
    starting,
    running,
    contextLoading: context.loading,
    taskReady: trimmedTask.length > 0,
    taskPending,
    targetReady: target !== null,
    preview: shownPreview?.result,
    previewIdentity: shownPreview?.identity ?? "",
    currentIdentity,
    fetching: previewQuery.isFetching,
    error: previewError,
  });
  const blocked = gate.disabled || !probeSettled;

  useEffect(() => {
    if (!currentIdentity) return;
    setServerBlockers([]);
    setNotice(null);
  }, [currentIdentity]);

  function chooseTeam(nextId: string) {
    setTeamId(nextId);
  }

  async function launch() {
    if (
      startingRef.current ||
      blocked ||
      !target ||
      !shownPreview ||
      shownPreview.identity !== currentIdentity ||
      !shownPreview.result.ok
    ) {
      return;
    }
    const shown = shownPreview.result.preview;
    startingRef.current = true;
    setStarting(true);
    setError(null);
    setServerBlockers([]);
    setNotice(null);
    setJob(null);
    try {
      const result = await start(
        launchStartRequest(
          {
            teamId,
            task: previewTask,
            target,
            expectedPlanHash: shown.planHash,
          },
          modeContract,
        ),
      );
      if (result.ok) {
        setJob(result.job);
      } else if (startFailureAction(result.blockers) === "refresh-preview") {
        setNotice(zh.modes.previewRefreshed);
        toast.show(zh.modes.planChanged, { variant: "info" });
        void previewQuery.refetch();
      } else {
        setServerBlockers(result.blockers);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : zh.launchFailed);
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }

  function close() {
    if (running) toast.show(zh.launchInBackground, { variant: "info" });
    onClose();
  }

  const failure = job?.state === "failed" ? jobErrorText(job) : null;
  const kickoffCopy = job?.state === "failed" ? job.error?.kickoffMessage : undefined;
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const editTeam = team && onEditTeam ? () => onEditTeam(team) : null;

  return (
    <Modal
      title={zh.launchTitle}
      icon={<Icon name="Play" size={18} color={theme.colors.foreground} />}
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Modal.Content>
        <View style={{ gap: layout.compact ? 10 : 14 }}>
          {!lockTeam ? (
            <CompactPicker
              theme={theme}
              label={zh.teams}
              items={teams}
              selectedId={teamId}
              placeholder={zh.chooseTeam}
              searchPlaceholder={zh.searchTeams}
              emptyLabel={zh.noMatchingRoles}
              leading={(entry) => {
                const coordinator = roles.find((role) => role.id === entry.coordinatorRoleId);
                return (
                  <RoleGlyph
                    theme={theme}
                    icon={coordinator?.icon ?? "Users"}
                    color={coordinator?.color}
                    size={16}
                  />
                );
              }}
              onChange={chooseTeam}
            />
          ) : null}
          {modeDisplay.kind !== "none" ? (
            <View style={{ gap: 4 }}>
              <Text
                style={
                  modeDisplay.kind === "unknown"
                    ? { color: theme.colors.statusWarning, fontSize: 12 }
                    : muted
                }
              >
                {modeDisplay.kind === "unknown"
                  ? zh.modes.launchTeamModeUnknown(modeDisplay.value)
                  : zh.modes.launchTeamMode(modeDisplay.label)}
              </Text>
              {editTeam ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={zh.editTeam}
                  accessibilityState={{ disabled: starting || running }}
                  disabled={starting || running}
                  onPress={editTeam}
                >
                  <Text
                    style={{
                      color: theme.colors.accent,
                      fontWeight: "600",
                      fontSize: 12,
                      opacity: starting || running ? 0.5 : 1,
                    }}
                  >
                    {zh.editTeam}
                  </Text>
                </Pressable>
              ) : (
                <Text style={muted}>{zh.modes.launchTeamModeEditHint}</Text>
              )}
            </View>
          ) : null}
          {!fixedWorkspaceId ? (
            <View style={{ gap: 8 }}>
              <SegmentedTarget theme={theme} value={targetKind} onChange={setTargetKind} />
              {targetKind === "workspace" ? (
                <CompactPicker
                  theme={theme}
                  label={zh.workspace}
                  items={context.workspaces}
                  selectedId={workspaceId}
                  placeholder={zh.chooseWorkspace}
                  searchPlaceholder={zh.searchWorkspaces}
                  emptyLabel={zh.noMatchingWorkspaces}
                  subtitle={(workspace) => workspace.projectName ?? workspace.directory}
                  leading={() => (
                    <Icon name="FolderOpen" size={16} color={theme.colors.foregroundMuted} />
                  )}
                  onChange={setWorkspaceId}
                />
              ) : (
                <>
                  <CompactPicker
                    theme={theme}
                    label={zh.project}
                    items={context.projects}
                    selectedId={projectId}
                    placeholder={zh.chooseProject}
                    searchPlaceholder={zh.searchProjects}
                    emptyLabel={zh.noMatchingProjects}
                    subtitle={(project) => project.directory}
                    leading={() => (
                      <Icon name="Folder" size={16} color={theme.colors.foregroundMuted} />
                    )}
                    onChange={setProjectId}
                  />
                  <Text style={muted}>{zh.newWorkspaceHint}</Text>
                  <TextField
                    theme={theme}
                    label={zh.newWorkspaceTitle}
                    value={newWorkspaceTitle}
                    revision={0}
                    placeholder={team?.name ?? zh.newWorkspace}
                    onChange={setNewWorkspaceTitle}
                  />
                </>
              )}
            </View>
          ) : null}
          <TextField
            theme={theme}
            label={zh.task}
            value={task}
            revision={0}
            multiline
            onChange={setTask}
            onCompositionChange={setComposing}
          />
          <LaunchPreview
            theme={theme}
            layout={layout}
            loading={previewQuery.isFetching && !visiblePreview}
            updating={(previewQuery.isFetching || taskPending) && Boolean(visiblePreview)}
            error={previewError}
            result={visiblePreview}
          />
          {!probeSettled ? (
            <Text style={muted}>{zh.modes.previewLoadingContext}</Text>
          ) : gate.reason && !visiblePreview ? (
            <Text style={muted}>{gate.reason}</Text>
          ) : null}
          {context.error ? (
            <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>{context.error}</Text>
          ) : null}
          {notice ? (
            <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>{notice}</Text>
          ) : null}
          {serverBlockers.map((blocker) => (
            <Text
              key={blocker}
              style={{ color: theme.colors.statusDanger, fontSize: 12, fontWeight: "600" }}
            >
              {blocker}
            </Text>
          ))}
          {running && job ? <Text style={muted}>{jobProgressLabel(job)}</Text> : null}
          {[...new Set(job?.warnings ?? [])].map((warning) => (
            <Text key={warning} style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
              {warning}
            </Text>
          ))}
          {error || failure ? (
            <Text selectable style={{ color: theme.colors.statusDanger }}>
              {error ?? failure}
            </Text>
          ) : null}
          {kickoffCopy ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={zh.copyKickoff}
              onPress={() => void copyText(kickoffCopy)}
            >
              <Text style={{ color: theme.colors.accent, fontWeight: "600" }}>
                {zh.copyKickoff}
              </Text>
            </Pressable>
          ) : null}
          <ModalActions
            theme={theme}
            confirmLabel={
              running && job?.step === "workspace"
                ? zh.creatingWorkspace
                : starting || running
                  ? zh.launching
                  : zh.launch
            }
            confirmDisabled={blocked}
            onCancel={close}
            onConfirm={() => void launch()}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}

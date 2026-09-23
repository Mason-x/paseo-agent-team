import { copyText, Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Preferences } from "../../shared/schemas/preferences";
import type { Role } from "../../shared/schemas/role";
import type { Team } from "../../shared/schemas/team";
import { zh } from "../../shared/zh";
import { buildLaunchPlan } from "../domain/launch-plan";
import type {
  PaseoAdapter,
  PaseoProfile,
  ProjectSummary,
  ProviderAvailability,
} from "../paseo/adapter";
import { ModalActions } from "../shared/buttons";
import { CompactPicker } from "../shared/CompactPicker";
import { TextField } from "../shared/Field";
import { RoleGlyph } from "../shared/RoleGlyph";
import type { PluginLayout, PluginTheme } from "../shared/theme";
import { LaunchPreview } from "./LaunchPreview";
import {
  isLaunchError,
  type LaunchProgress,
  launchTeam,
  prependRun,
  toRunSummary,
} from "./launch-team";

function progressLabel(progress: LaunchProgress | null): string {
  if (!progress) return "";
  if (progress.step === "coordinator") return zh.creatingCoordinator;
  if (progress.step === "member") return zh.creatingMember(progress.index, progress.total);
  return zh.sendingKickoff;
}

export function LaunchDialog({
  theme,
  layout,
  open,
  adapter,
  teams,
  roles,
  profiles,
  availability,
  projects,
  preferences,
  initialTeamId,
  initialWorkspaceId,
  onClose,
  onLaunched,
  onSavePreferences,
}: {
  theme: PluginTheme;
  layout: PluginLayout;
  open: boolean;
  adapter: PaseoAdapter;
  teams: readonly Team[];
  roles: readonly Role[];
  profiles: readonly PaseoProfile[];
  availability: readonly ProviderAvailability[];
  projects: readonly ProjectSummary[];
  preferences: Preferences;
  initialTeamId?: string;
  initialWorkspaceId?: string;
  onClose: () => void;
  onLaunched: (runId: string, workspaceId: string) => void;
  onSavePreferences: (preferences: Preferences) => Promise<void>;
}) {
  const toast = useToast();
  const defaultTeamId = teams[0]?.id ?? "";
  const defaultProjectId = projects.length === 1 ? (projects[0]?.id ?? "") : "";
  const [teamId, setTeamId] = useState(initialTeamId ?? defaultTeamId);
  const [projectId, setProjectId] = useState(defaultProjectId);
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId ?? "");
  const [newWorkspaceTitle, setNewWorkspaceTitle] = useState("");
  const [creatingBusy, setCreatingBusy] = useState(false);
  const [task, setTask] = useState("");
  const [toolsHint, setToolsHint] = useState<string | null>(null);
  const [progress, setProgress] = useState<LaunchProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kickoffCopy, setKickoffCopy] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formSeed, setFormSeed] = useState(0);

  useEffect(() => {
    if (!open) return;
    setTeamId(initialTeamId ?? defaultTeamId);
    setProjectId(defaultProjectId);
    setWorkspaceId(initialWorkspaceId ?? "");
    setNewWorkspaceTitle("");
    setCreatingBusy(false);
    setTask("");
    setProgress(null);
    setError(null);
    setKickoffCopy(null);
    setBusy(false);
    setFormSeed((seed) => seed + 1);
  }, [open, initialTeamId, initialWorkspaceId, defaultTeamId, defaultProjectId]);

  const selectedProject = projects.find((project) => project.id === projectId);

  const team = teams.find((entry) => entry.id === teamId);
  const coordinatorRole = roles.find((role) => role.id === team?.coordinatorRoleId);
  const coordinatorProvider = coordinatorRole
    ? profiles.find((profile) => profile.id === coordinatorRole.preferredProfiles[0]?.profileId)
        ?.provider
    : undefined;

  useEffect(() => {
    if (!open || !coordinatorProvider) {
      setToolsHint(null);
      return;
    }
    let cancelled = false;
    void adapter.coordinatorToolsHint(coordinatorProvider).then((hint) => {
      if (!cancelled) setToolsHint(hint);
    });
    return () => {
      cancelled = true;
    };
  }, [adapter, coordinatorProvider, open]);

  const plan = useMemo(
    () =>
      buildLaunchPlan({
        team,
        roles,
        profiles,
        availability,
        workspaceId,
        task,
        runId: `run-${Date.now()}`,
        maxMembers: preferences.maxMembers,
        coordinatorToolsHint: toolsHint,
      }),
    [availability, preferences.maxMembers, profiles, roles, task, team, toolsHint, workspaceId],
  );

  const needsNewWorkspace = !initialWorkspaceId;
  const blocked =
    plan.blockers.length > 0 ||
    busy ||
    creatingBusy ||
    (needsNewWorkspace ? !selectedProject : !workspaceId);

  async function launch() {
    if (blocked) return;
    setBusy(true);
    setError(null);
    let targetWorkspaceId = workspaceId;
    try {
      if (needsNewWorkspace) {
        if (!selectedProject) return;
        setCreatingBusy(true);
        const created = await adapter.createWorkspace({
          title: newWorkspaceTitle.trim() || team?.name || zh.newWorkspace,
          project: selectedProject,
        });
        targetWorkspaceId = created.id;
        setWorkspaceId(created.id);
        setCreatingBusy(false);
      }
      const nextPlan = buildLaunchPlan({
        team,
        roles,
        profiles,
        availability,
        workspaceId: targetWorkspaceId,
        task,
        runId: `run-${Date.now()}`,
        maxMembers: preferences.maxMembers,
        coordinatorToolsHint: toolsHint,
      });
      const result = await launchTeam(nextPlan, adapter, {
        archiveOnLaunchFailure: preferences.archiveOnLaunchFailure,
        onProgress: setProgress,
      });
      await onSavePreferences({
        ...preferences,
        recentRuns: prependRun(
          preferences.recentRuns,
          toRunSummary(nextPlan, result, new Date().toISOString()),
        ),
      });
      toast.show(zh.launched, { variant: "success" });
      onLaunched(result.runId, targetWorkspaceId);
      onClose();
    } catch (cause) {
      if (isLaunchError(cause) && cause.step === "kickoff") {
        setKickoffCopy(cause.kickoffMessage ?? plan.kickoffMessage);
        setError(cause.message);
      } else if (isLaunchError(cause)) {
        setError(
          `${cause.message}${cause.archived ? zh.archivedCreated : cause.agentIdsKept.length ? zh.keptCreated : ""}`,
        );
      } else {
        setError(cause instanceof Error ? cause.message : zh.launchFailed);
      }
    } finally {
      setBusy(false);
      setCreatingBusy(false);
      setProgress(null);
    }
  }

  return (
    <Modal
      title={zh.launchTitle}
      icon={<Icon name="Play" size={18} color={theme.colors.foreground} />}
      open={open}
      onOpenChange={(next) => !next && onClose()}
    >
      <Modal.Content>
        <View style={{ gap: layout.compact ? 10 : 14 }}>
          {!initialTeamId ? (
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
              onChange={setTeamId}
            />
          ) : null}
          {needsNewWorkspace ? (
            <View style={{ gap: 8 }}>
              <CompactPicker
                theme={theme}
                label={zh.project}
                items={projects}
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
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                {zh.newWorkspaceHint}
              </Text>
              <TextField
                theme={theme}
                label={zh.newWorkspaceTitle}
                value={newWorkspaceTitle}
                revision={formSeed}
                placeholder={team?.name ?? zh.newWorkspace}
                onChange={setNewWorkspaceTitle}
              />
            </View>
          ) : null}
          <TextField
            theme={theme}
            label={zh.task}
            value={task}
            revision={formSeed}
            multiline
            onChange={setTask}
          />
          <LaunchPreview theme={theme} plan={plan} />
          {progress ? (
            <Text style={{ color: theme.colors.foregroundMuted }}>{progressLabel(progress)}</Text>
          ) : null}
          {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
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
            confirmLabel={creatingBusy ? zh.creatingWorkspace : busy ? zh.launching : zh.launch}
            confirmDisabled={blocked}
            onCancel={onClose}
            onConfirm={() => void launch()}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}

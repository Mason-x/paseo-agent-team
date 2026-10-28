import { settingsRpc } from "@getpaseo/plugin";
import { type PluginScreenProps, usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { JSONType } from "zod";
import { uniqueCopyId } from "../../shared/ids";
import { toJsonValue } from "../../shared/json";
import { createPaseoAdapter } from "../../shared/paseo/adapter";
import { defaultCatalogPreviewRpc } from "../../shared/rpc";
import type { Role } from "../../shared/schemas/role";
import type { Team } from "../../shared/schemas/team";
import {
  preferencesSettings,
  RolesDocumentSchema,
  rolesSettings,
  TeamsDocumentSchema,
  teamsSettings,
} from "../../shared/settings";
import { zh } from "../../shared/zh";
import { designZh } from "../../shared/zh/design";
import { appendDocumentRow, removeDocumentRow } from "../catalog/editor-save";
import { PresetSyncDialog } from "../catalog/PresetSyncDialog";
import { createPresetGateway } from "../catalog/preset-gateway";
import { copyRole as copyRoleRecord, copyTeam as copyTeamRecord } from "../catalog/preset-metadata";
import {
  importDefaultPresets,
  type PresetImportResult,
  type PreviewSuccess,
  previewFailureMessage,
  retryPresetPreferences,
} from "../catalog/preset-service";
import {
  autoImportAttemptKey,
  countBindingReport,
  resolveEmptyCatalogMode,
} from "../catalog/preset-state";
import { DesignJobsPanel } from "../designer/DesignJobsPanel";
import {
  type DesignerPrefill,
  designerPrefillFromEvent,
  economyFocusForConfigure,
  roleEditorTargetForGap,
} from "../designer/design-screen-state";
import { subscribeDesignPrefills } from "../designer/events";
import { createDesignClientRequestId, DESIGN_JOB_MAX_ATTEMPTS } from "../designer/submission-state";
import { useDesignJobs } from "../designer/use-design-jobs";
import { LaunchDialog } from "../launch/LaunchDialog";
import { useHostProfiles } from "../paseo/profiles";
import { RoleEditor } from "../roles/RoleEditor";
import { RoleList } from "../roles/RoleList";
import { RunsTab } from "../runs/RunsTab";
import { type EconomyEditorFocus, EconomyPoolEditor } from "../settings/EconomyPoolEditor";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { EmptyState } from "../shared/EmptyState";
import { ErrorState } from "../shared/ErrorState";
import { ImeTextInput } from "../shared/ImeTextInput";
import { TeamEditor } from "../teams/TeamEditor";
import { TeamsTab } from "../teams/TeamsTab";
import { familyHintsFromEconomy } from "../teams/team-plan-state";
import { useTeamPlans } from "../teams/use-team-plans";
import { VersionEntry } from "../version/VersionEntry";
import { AGENT_TEAM_TABS, type AgentTeamTab, parseTab, resolveInitialTab } from "./tabs";

const rolesReadRpc = settingsRpc(rolesSettings.id).read;
const rolesWriteRpc = settingsRpc(rolesSettings.id).write;
const teamsReadRpc = settingsRpc(teamsSettings.id).read;
const teamsWriteRpc = settingsRpc(teamsSettings.id).write;
const preferencesReadRpc = settingsRpc(preferencesSettings.id).read;
const preferencesWriteRpc = settingsRpc(preferencesSettings.id).write;

type PresetImportPhase =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "needs-confirmation"; message: string }
  | { kind: "failed"; message: string }
  | { kind: "done" };

type PresetNotice =
  | { kind: "imported"; unbound: number; runtime: number }
  | {
      kind: "partial";
      preview: PreviewSuccess;
      roles: Role[];
      unbound: number;
      runtime: number;
      message: string;
    };

const TAB_LABELS: Record<AgentTeamTab, string> = {
  roles: zh.roles,
  teams: zh.teams,
  runs: zh.runs,
};

type LaunchSeed = {
  key: string;
  teamId?: string;
  lockTeam?: boolean;
  initialTask?: string;
  initialWorkspaceId?: string;
};

export function AgentTeamsScreen({ theme, layout, host, navigation, params }: PluginScreenProps) {
  const toast = useToast();
  const paseo = usePaseo();
  const adapter = useMemo(() => createPaseoAdapter(paseo), [paseo]);
  const previewPresets = useRpc(defaultCatalogPreviewRpc);
  const readRolesDoc = useRpc(rolesReadRpc);
  const readTeamsDoc = useRpc(teamsReadRpc);
  const readPreferencesDoc = useRpc(preferencesReadRpc);
  const writeRolesDoc = useRpc(rolesWriteRpc);
  const writeTeamsDoc = useRpc(teamsWriteRpc);
  const writePreferencesDoc = useRpc(preferencesWriteRpc);
  const roles = useSettings(rolesSettings);
  const teams = useSettings(teamsSettings);
  const preferences = useSettings(preferencesSettings);
  const hostProfiles = useHostProfiles(adapter);
  const profileList = hostProfiles.status === "ready" ? hostProfiles.profiles : [];
  const ready =
    roles.status === "ready" && teams.status === "ready" && preferences.status === "ready";
  const requestedTab = parseTab(params.tab);
  const [tab, setTab] = useState<AgentTeamTab>(resolveInitialTab(params.tab));
  const [roleQuery, setRoleQuery] = useState("");
  const [presetImport, setPresetImport] = useState<PresetImportPhase>({ kind: "idle" });
  const [presetNotice, setPresetNotice] = useState<PresetNotice | null>(null);
  const [presetForceOpen, setPresetForceOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [economyOpen, setEconomyOpen] = useState(false);
  const [economyFocus, setEconomyFocus] = useState<EconomyEditorFocus | null>(null);
  const [roleEditor, setRoleEditor] = useState<{
    mode: "create" | "edit";
    role: Role | null;
    focusProfileId?: string | null;
  } | null>(null);
  const [teamEditor, setTeamEditor] = useState<{
    mode: "create" | "edit";
    team: Team | null;
  } | null>(null);
  const [launch, setLaunch] = useState<LaunchSeed | null>(null);
  const planningRolesKey = roles.status === "ready" ? roles.revision : roles.status;
  const planningTeamsKey = teams.status === "ready" ? teams.revision : teams.status;
  const planningPrefsKey =
    preferences.status === "ready" ? preferences.revision : preferences.status;
  const planningRevisions = useMemo(
    () => ({
      roles: planningRolesKey,
      teams: planningTeamsKey,
      preferences: planningPrefsKey,
    }),
    [planningRolesKey, planningTeamsKey, planningPrefsKey],
  );
  const preferenceValues = preferences.status === "ready" ? preferences.values : null;
  const familyHints = useMemo(
    () => (preferenceValues ? familyHintsFromEconomy(preferenceValues.economy, profileList) : []),
    [preferenceValues, profileList],
  );
  const plans = useTeamPlans({
    hostId: host.id,
    profiles: profileList,
    revisions: planningRevisions,
    teams: teams.status === "ready" ? teams.values.teams : [],
    active: tab === "teams" || launch !== null,
    familyHints,
  });
  // Success and failure both settle the probe; before that neither design polling nor a launch
  // preview may go out with a guessed contract (W-I2-1).
  const plansSettled = plans.loaded || plans.error !== null;
  const designJobs = useDesignJobs({
    hostId: host.id,
    active: tab === "teams" && plansSettled,
    modeContract: plans.modeContract,
  });
  const [resetTarget, setResetTarget] = useState<"roles" | "teams" | "preferences" | null>(null);
  const designClientId = useRef(createDesignClientRequestId()).current;
  const [designPrefill, setDesignPrefill] = useState<{
    hostId: string;
    value: DesignerPrefill;
  } | null>(null);
  const attemptedPrefills = useRef(new Set<string>());
  const designHostRef = useRef(host.id);

  useEffect(() => {
    // A design command changes screen params, not the existing tab: always reveal the draft.
    if (params.designToken || params.designNotice) setTab("teams");
    else if (requestedTab) setTab(requestedTab);
  }, [params.designNotice, params.designToken, requestedTab]);

  useEffect(() => {
    const nonce = params.designNoticeNonce;
    if (params.designNotice !== "too-long") return;
    void nonce;
    toast.show(designZh.prefillTooLong, { variant: "warning" });
  }, [params.designNotice, params.designNoticeNonce, toast]);

  useEffect(() => {
    if (designHostRef.current === host.id) return;
    designHostRef.current = host.id;
    attemptedPrefills.current.clear();
    setDesignPrefill(null);
    setLaunch(null);
  }, [host.id]);

  useEffect(() => {
    const token = params.designToken;
    if (!token || !designJobs.scopeId || attemptedPrefills.current.has(token)) return;
    attemptedPrefills.current.add(token);
    let delivered = false;
    const unsubscribe = subscribeDesignPrefills(
      { scopeId: designJobs.scopeId, token, now: Date.now() },
      (event) => {
        delivered = true;
        setDesignPrefill({ hostId: host.id, value: designerPrefillFromEvent(event) });
        return true;
      },
    );
    if (!delivered) toast.show(designZh.prefillExpired, { variant: "info" });
    return unsubscribe;
  }, [designJobs.scopeId, host.id, params.designToken, toast]);

  const economyHostRef = useRef(host.id);
  useEffect(() => {
    if (economyHostRef.current === host.id) return;
    economyHostRef.current = host.id;
    setEconomyOpen(false);
  }, [host.id]);

  const presetGateway = useMemo(
    () =>
      createPresetGateway({
        preview: (values) => previewPresets(values),
        readRoles: (values) => readRolesDoc(values),
        readPreferences: (values) => readPreferencesDoc(values),
        roles: {
          write: async (values, revision) => {
            try {
              const result = await writeRolesDoc({
                revision,
                values: toJsonValue(values) as JSONType,
              });
              return result.status;
            } catch {
              return "failed";
            }
          },
          reload: () => roles.reload(),
        },
        preferences: {
          write: async (values, revision) => {
            try {
              const result = await writePreferencesDoc({
                revision,
                values: toJsonValue(values) as JSONType,
              });
              return result.status;
            } catch {
              return "failed";
            }
          },
          reload: () => preferences.reload(),
        },
      }),
    [
      previewPresets,
      readRolesDoc,
      readPreferencesDoc,
      writeRolesDoc,
      writePreferencesDoc,
      roles.reload,
      preferences.reload,
    ],
  );

  const attemptedAuto = useRef(new Set<string>());
  const autoGeneration = useRef(0);
  const previousHost = useRef(host.id);

  useEffect(() => {
    if (previousHost.current === host.id) return;
    previousHost.current = host.id;
    autoGeneration.current += 1;
    attemptedAuto.current.clear();
    setPresetImport({ kind: "idle" });
    setPresetNotice(null);
    setPresetForceOpen(false);
    setSyncOpen(false);
  }, [host.id]);

  const templatesImportedAt =
    preferences.status === "ready" ? preferences.values.templatesImportedAt : undefined;
  const emptyMode = ready
    ? resolveEmptyCatalogMode({
        rolesCount: roles.values.roles.length,
        teamsCount: teams.values.teams.length,
        templatesImportedAt,
      })
    : "none";
  const roleRevision = roles.status === "ready" ? roles.revision : "";
  const teamRevision = teams.status === "ready" ? teams.revision : "";
  const teamCount = teams.status === "ready" ? teams.values.teams.length : 0;
  const preferencesRevision = preferences.status === "ready" ? preferences.revision : "";

  const applyPresetResult = useCallback(
    (result: PresetImportResult, manual: boolean) => {
      if (result.kind === "imported") {
        const counts = countBindingReport(result.preview.bindingReport);
        setPresetImport({ kind: "done" });
        setPresetNotice({ kind: "imported", ...counts });
        const parts: string[] = [zh.defaultPresetsImported(counts.unbound)];
        if (counts.runtime > 0) parts.push(zh.defaultPresetsRuntimeCount(counts.runtime));
        toast.show(parts.join(" "), { variant: "success" });
        return;
      }
      if (result.kind === "already-present") {
        setPresetImport({ kind: "done" });
        return;
      }
      if (result.kind === "blocked") {
        const message = previewFailureMessage(result.blockers);
        if (result.canForce) {
          setPresetImport({ kind: "needs-confirmation", message });
          if (manual) setPresetForceOpen(true);
        } else {
          setPresetImport({ kind: "failed", message });
        }
        return;
      }
      if (result.kind === "preferences-failed") {
        const counts = countBindingReport(result.preview.bindingReport);
        setPresetImport({ kind: "done" });
        setPresetNotice({
          kind: "partial",
          preview: result.preview,
          roles: result.roles,
          ...counts,
          message: result.message,
        });
        toast.error(result.message);
        return;
      }
      setPresetImport({ kind: "failed", message: result.message });
    },
    [toast],
  );

  useEffect(() => {
    if (emptyMode !== "auto-import" || presetImport.kind !== "idle") return;
    const key = autoImportAttemptKey(host.id, {
      roles: roleRevision,
      teams: teamRevision,
      preferences: preferencesRevision,
    });
    if (attemptedAuto.current.has(key)) return;
    attemptedAuto.current.add(key);
    const generation = autoGeneration.current;
    setPresetImport({ kind: "running" });
    void importDefaultPresets(presetGateway, {
      allowUnbound: false,
      onlyWhenUnimported: true,
      now: new Date().toISOString(),
    })
      .then((result) => {
        if (generation !== autoGeneration.current) return;
        applyPresetResult(result, false);
      })
      .catch(() => {
        if (generation !== autoGeneration.current) return;
        setPresetImport({ kind: "failed", message: zh.defaultPresetsSettingsUnavailable });
      });
  }, [
    emptyMode,
    presetImport.kind,
    host.id,
    roleRevision,
    teamRevision,
    preferencesRevision,
    presetGateway,
    applyPresetResult,
  ]);

  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        backgroundColor: theme.colors.surface0,
        padding: layout.compact ? 12 : 16,
        gap: 10,
      },
      header: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        columnGap: 8,
        rowGap: 6,
      },
      // The right side of the header; the version entry (item 4) joins the "new" button here.
      headerActions: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        flexShrink: 0,
      },
      hidden: { display: "none" as const },
      tabs: {
        flexDirection: "row" as const,
        flexShrink: 0,
        alignSelf: "flex-start" as const,
        padding: 2,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
        gap: 2,
      },
      tab: {
        flexShrink: 0,
        minHeight: 28,
        paddingHorizontal: 12,
        paddingVertical: 5,
        borderRadius: 6,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      tabSelected: { backgroundColor: theme.colors.surface2 },
      tabLabel: {
        color: theme.colors.foregroundMuted,
        fontWeight: "600" as const,
        fontSize: 13,
      },
      tabLabelSelected: { color: theme.colors.foreground },
      searchWrap: {
        flex: 1,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        minHeight: 36,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        backgroundColor: theme.colors.surface2,
      },
      search: {
        flex: 1,
        minHeight: 34,
        color: theme.colors.foreground,
        fontSize: 14,
      },
      toolbar: { flexDirection: "row" as const, gap: 8, alignItems: "center" as const },
      syncButton: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        gap: 4,
        minHeight: 36,
        minWidth: 36,
        paddingHorizontal: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        flexShrink: 0,
      },
      syncButtonIcon: { paddingHorizontal: 0 },
      notice: {
        gap: 6,
        padding: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      noticeClose: {
        alignSelf: "flex-end" as const,
        width: 24,
        height: 24,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      noticeText: { color: theme.colors.foreground, fontSize: 12 },
      noticeDanger: { color: theme.colors.statusDanger, fontSize: 12 },
      link: { color: theme.colors.accent, fontSize: 12, fontWeight: "600" as const },
      teamEmpty: { padding: 18, gap: 6, alignItems: "center" as const },
      teamEmptyText: {
        color: theme.colors.foregroundMuted,
        fontSize: 13,
        textAlign: "center" as const,
      },
      newButton: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        gap: 4,
        minHeight: 28,
        minWidth: 28,
        paddingHorizontal: 8,
        flexShrink: 0,
      },
      // Narrow headers keep the tabs in view: the action is a 36px icon target with its label for a11y only.
      newButtonIcon: { paddingHorizontal: 0, minWidth: 36, minHeight: 36 },
      action: { color: theme.colors.accent, fontWeight: "600" as const, fontSize: 13 },
    }),
    [layout.compact, theme],
  );

  function showCatalogWriteFailure(status: "conflict" | "invalid" | "failed"): void {
    toast.error(
      status === "conflict"
        ? zh.saveConflictRetry
        : status === "invalid"
          ? zh.parseFail
          : zh.saveFail,
    );
  }

  async function readFreshRoles() {
    try {
      const reply = await readRolesDoc({});
      if (reply.status !== "ready") {
        toast.error(reply.error ?? zh.defaultPresetsSettingsUnavailable);
        return null;
      }
      const parsed = RolesDocumentSchema.safeParse(reply.values);
      if (!parsed.success) {
        toast.error(zh.parseFail);
        return null;
      }
      return { raw: reply.values, rows: parsed.data.roles, revision: reply.revision };
    } catch {
      toast.error(zh.defaultPresetsSettingsUnavailable);
      return null;
    }
  }

  async function readFreshTeams() {
    try {
      const reply = await readTeamsDoc({});
      if (reply.status !== "ready") {
        toast.error(reply.error ?? zh.defaultPresetsSettingsUnavailable);
        return null;
      }
      const parsed = TeamsDocumentSchema.safeParse(reply.values);
      if (!parsed.success) {
        toast.error(zh.parseFail);
        return null;
      }
      return { raw: reply.values, rows: parsed.data.teams, revision: reply.revision };
    } catch {
      toast.error(zh.defaultPresetsSettingsUnavailable);
      return null;
    }
  }

  async function saveRawRoles(document: Record<string, unknown>, revision: string) {
    try {
      const result = await writeRolesDoc({
        revision,
        values: toJsonValue(document) as JSONType,
      });
      if (result.status === "saved") {
        await roles.reload();
        return true;
      }
      showCatalogWriteFailure(result.status);
    } catch {
      toast.error(zh.saveFail);
    }
    return false;
  }

  async function saveRawTeams(document: Record<string, unknown>, revision: string) {
    try {
      const result = await writeTeamsDoc({
        revision,
        values: toJsonValue(document) as JSONType,
      });
      if (result.status === "saved") {
        await teams.reload();
        return true;
      }
      showCatalogWriteFailure(result.status);
    } catch {
      toast.error(zh.saveFail);
    }
    return false;
  }

  async function copyRole(role: Role) {
    const fresh = await readFreshRoles();
    if (!fresh) return;
    const source = fresh.rows.find((entry) => entry.id === role.id);
    if (!source) {
      toast.error(zh.saveConflictRetry);
      return;
    }
    const now = new Date().toISOString();
    const copy = copyRoleRecord(
      source,
      uniqueCopyId(source.id, new Set(fresh.rows.map((entry) => entry.id))),
      `${source.name} ${zh.copySuffix}`.slice(0, 40),
      now,
    );
    await saveRawRoles(appendDocumentRow(fresh.raw, "roles", copy), fresh.revision);
  }

  async function deleteRole(role: Role) {
    const fresh = await readFreshRoles();
    if (!fresh) return;
    if (!fresh.rows.some((entry) => entry.id === role.id)) {
      toast.error(zh.saveConflictRetry);
      return;
    }
    await saveRawRoles(removeDocumentRow(fresh.raw, "roles", role.id), fresh.revision);
  }

  async function copyTeam(team: Team) {
    const fresh = await readFreshTeams();
    if (!fresh) return;
    const source = fresh.rows.find((entry) => entry.id === team.id);
    if (!source) {
      toast.error(zh.saveConflictRetry);
      return;
    }
    const now = new Date().toISOString();
    const copy = copyTeamRecord(
      source,
      uniqueCopyId(source.id, new Set(fresh.rows.map((entry) => entry.id))),
      `${source.name} ${zh.copySuffix}`.slice(0, 40),
      now,
    );
    await saveRawTeams(appendDocumentRow(fresh.raw, "teams", copy), fresh.revision);
  }

  async function deleteTeam(team: Team) {
    const fresh = await readFreshTeams();
    if (!fresh) return;
    if (!fresh.rows.some((entry) => entry.id === team.id)) {
      toast.error(zh.saveConflictRetry);
      return;
    }
    await saveRawTeams(removeDocumentRow(fresh.raw, "teams", team.id), fresh.revision);
  }

  async function runManualImport(allowUnbound: boolean) {
    setPresetImport({ kind: "running" });
    try {
      const result = await importDefaultPresets(presetGateway, {
        allowUnbound,
        onlyWhenUnimported: false,
        now: new Date().toISOString(),
      });
      applyPresetResult(result, true);
    } catch {
      setPresetImport({ kind: "failed", message: zh.defaultPresetsSettingsUnavailable });
    }
  }

  function requestManualImport() {
    if (presetImport.kind === "needs-confirmation") {
      setPresetForceOpen(true);
      return;
    }
    void runManualImport(false);
  }

  async function retryImportPreferences() {
    if (presetNotice?.kind !== "partial") return;
    const result = await retryPresetPreferences(
      presetGateway,
      presetNotice.preview,
      presetNotice.roles,
      new Date().toISOString(),
    );
    if (result !== "saved") {
      toast.error(
        result === "invalid"
          ? zh.defaultPresetsPreferencesInvalid
          : zh.defaultPresetsPreferencesFailed,
      );
      return;
    }
    setPresetNotice({
      kind: "imported",
      unbound: presetNotice.unbound,
      runtime: presetNotice.runtime,
    });
    toast.show(zh.defaultPresetsImported(presetNotice.unbound), { variant: "success" });
  }

  function renderSettingsState(
    document: typeof roles | typeof teams | typeof preferences,
    name: "roles" | "teams" | "preferences",
  ) {
    const catalogName =
      name === "roles"
        ? zh.catalogRoles
        : name === "teams"
          ? zh.catalogTeams
          : zh.catalogPreferences;
    if (document.status === "loading") {
      return <Text style={{ color: theme.colors.foregroundMuted }}>{zh.loading(catalogName)}</Text>;
    }
    if (document.status === "error") {
      return (
        <ErrorState
          theme={theme}
          title={zh.loadFail(catalogName)}
          body={document.error}
          actionLabel={zh.retry}
          onAction={() => void document.reload()}
        />
      );
    }
    if (document.status === "invalid") {
      return (
        <ErrorState
          theme={theme}
          title={zh.parseFail}
          body={document.error}
          actionLabel={zh.retry}
          onAction={() => void document.reload()}
          dangerActionLabel={zh.reset}
          onDangerAction={() => setResetTarget(name)}
        />
      );
    }
    return null;
  }

  const blocked =
    renderSettingsState(roles, "roles") ??
    renderSettingsState(teams, "teams") ??
    renderSettingsState(preferences, "preferences");
  const latestDesignJob = designJobs.jobs[0];
  const latestDesignSummary = latestDesignJob
    ? [
        designZh.phases[latestDesignJob.state],
        latestDesignJob.attempt > 0
          ? designZh.jobAttempt(latestDesignJob.attempt, DESIGN_JOB_MAX_ATTEMPTS)
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;
  const latestDesignTone =
    latestDesignJob?.state === "failed" ||
    latestDesignJob?.state === "canceled" ||
    latestDesignJob?.state === "save_conflict"
      ? "danger"
      : latestDesignJob?.state === "needs_continue" || latestDesignJob?.requiresAttention
        ? "attention"
        : "neutral";
  const newLabel = tab === "roles" ? zh.newRole : tab === "teams" ? zh.newTeam : zh.launchTeam;
  const presetBusy =
    presetImport.kind === "running" ||
    (emptyMode === "auto-import" && presetImport.kind === "idle");
  const importMessage =
    presetImport.kind === "failed" || presetImport.kind === "needs-confirmation"
      ? presetImport.message
      : emptyMode === "manual-import" && templatesImportedAt
        ? zh.importDefaultsPreviously
        : zh.emptyBody;
  const importView =
    emptyMode === "auto-import" || emptyMode === "manual-import" ? (
      presetBusy ? (
        <View style={styles.teamEmpty}>
          <Text style={styles.teamEmptyText}>{zh.importDefaultsProgress}</Text>
        </View>
      ) : (
        <EmptyState
          theme={theme}
          title={teamCount > 0 ? zh.importMissingRolesTitle : zh.emptyTitle}
          body={importMessage}
          actionLabel={zh.importDefaults}
          onAction={requestManualImport}
        />
      )
    ) : null;
  const teamEmptyView =
    emptyMode === "team-guidance" ? (
      <View style={styles.teamEmpty}>
        <Text style={styles.teamEmptyText}>{zh.teamListEmpty}</Text>
      </View>
    ) : teamCount === 0 ? (
      importView
    ) : null;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.tabs}>
          {AGENT_TEAM_TABS.map((item) => (
            <Pressable
              key={item}
              accessibilityRole="button"
              accessibilityState={{ selected: tab === item }}
              accessibilityLabel={TAB_LABELS[item]}
              onPress={() => setTab(item)}
              style={[styles.tab, tab === item && styles.tabSelected]}
            >
              <Text style={[styles.tabLabel, tab === item && styles.tabLabelSelected]}>
                {TAB_LABELS[item]}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.headerActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={zh.economyPool}
            onPress={() => setEconomyOpen(true)}
            style={({ pressed }) => [
              styles.newButton,
              layout.compact && styles.newButtonIcon,
              pressed && { opacity: 0.72 },
            ]}
          >
            <Icon name="Boxes" size={14} color={theme.colors.foregroundMuted} />
            {layout.compact ? null : <Text style={styles.action}>{zh.economyPool}</Text>}
          </Pressable>
          <VersionEntry key={host.id} theme={theme} layout={layout} hostId={host.id} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={newLabel}
            onPress={() => {
              if (tab === "roles")
                setRoleEditor({ mode: "create", role: null, focusProfileId: undefined });
              else if (tab === "teams") setTeamEditor({ mode: "create", team: null });
              else setLaunch({ key: "new" });
            }}
            style={({ pressed }) => [
              styles.newButton,
              layout.compact && styles.newButtonIcon,
              pressed && { opacity: 0.72 },
            ]}
          >
            <Icon name={tab === "runs" ? "Play" : "Plus"} size={14} color={theme.colors.accent} />
            {layout.compact ? null : <Text style={styles.action}>{newLabel}</Text>}
          </Pressable>
        </View>
      </View>
      {blocked}
      {presetNotice ? (
        <View style={styles.notice}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={zh.dismissDefaultPresetsNotice}
            onPress={() => setPresetNotice(null)}
            style={styles.noticeClose}
          >
            <Icon name="X" size={14} color={theme.colors.foregroundMuted} />
          </Pressable>
          {presetNotice.kind === "partial" ? (
            <>
              <Text style={styles.noticeDanger}>{presetNotice.message}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={zh.defaultPresetsRetryPreferences}
                onPress={() => void retryImportPreferences()}
              >
                <Text style={styles.link}>{zh.defaultPresetsRetryPreferences}</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.noticeText}>
                {[
                  zh.defaultPresetsImported(presetNotice.unbound),
                  presetNotice.runtime > 0
                    ? zh.defaultPresetsRuntimeCount(presetNotice.runtime)
                    : null,
                ]
                  .filter(Boolean)
                  .join(" ")}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={zh.syncDefaultPresets}
                onPress={() => setSyncOpen(true)}
              >
                <Text style={styles.link}>{zh.syncDefaultPresets}</Text>
              </Pressable>
            </>
          )}
        </View>
      ) : null}
      {ready ? (
        <>
          {tab === "roles" ? (
            <View style={styles.toolbar}>
              <View style={styles.searchWrap}>
                <Icon name="Search" size={15} color={theme.colors.foregroundMuted} />
                <ImeTextInput
                  accessibilityLabel={zh.searchRoles}
                  initialValue={roleQuery}
                  onChangeText={setRoleQuery}
                  placeholder={zh.searchRoles}
                  placeholderTextColor={theme.colors.foregroundMuted}
                  style={styles.search}
                />
              </View>
              {roles.values.roles.length > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={zh.syncDefaultPresets}
                  onPress={() => setSyncOpen(true)}
                  style={[styles.syncButton, layout.compact && styles.syncButtonIcon]}
                >
                  <Icon name="RefreshCw" size={14} color={theme.colors.accent} />
                  {layout.compact ? null : (
                    <Text style={styles.action}>{zh.syncDefaultPresets}</Text>
                  )}
                </Pressable>
              ) : null}
            </View>
          ) : null}
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingBottom: 24 }}
          >
            {/* Kept mounted while another tab shows, so a half-written request survives a tab switch. */}
            <View style={tab === "teams" ? undefined : styles.hidden}>
              <TeamsTab
                key={host.id}
                theme={theme}
                layout={layout}
                teams={teams.values.teams}
                roles={roles.values.roles}
                designer={{
                  adapter,
                  hostId: host.id,
                  profiles: profileList,
                  profilesLoading: hostProfiles.status === "loading",
                  profilesError: hostProfiles.status === "error" ? hostProfiles.error : undefined,
                  onRefreshProfiles: hostProfiles.reload,
                  modeContract: plans.modeContract,
                  disabledReason: plansSettled ? undefined : zh.modes.previewLoadingContext,
                  prefill: designPrefill?.hostId === host.id ? designPrefill.value : undefined,
                  collapsedSummary: latestDesignSummary,
                  collapsedSummaryTone: latestDesignTone,
                  onStart: (input) => designJobs.start(input),
                  onAccepted: () => {
                    toast.show(designZh.startAccepted, { variant: "success" });
                    void designJobs.refresh();
                  },
                }}
                progress={
                  <DesignJobsPanel
                    theme={theme}
                    hostId={host.id}
                    jobs={designJobs}
                    teams={teams.values.teams}
                    active={tab === "teams"}
                    clientId={designClientId}
                    navigation={navigation}
                    modeContract={plans.modeContract}
                    onGapRetry={(prefill) => {
                      setTab("teams");
                      setDesignPrefill({ hostId: host.id, value: prefill });
                    }}
                    onOpenRole={(target) => {
                      const resolved = roleEditorTargetForGap(
                        roles.status === "ready" ? roles.values.roles : [],
                        target,
                      );
                      if (!resolved) {
                        toast.error(zh.missingRoles(target.roleId));
                        return;
                      }
                      setRoleEditor({
                        mode: "edit",
                        role: resolved.role,
                        focusProfileId: resolved.focusProfileId,
                      });
                    }}
                    onConfigureEconomy={(target) => {
                      const focus = economyFocusForConfigure(target);
                      if (!focus) return;
                      setEconomyFocus(focus);
                      setEconomyOpen(true);
                    }}
                    onCreateRole={() =>
                      setRoleEditor({ mode: "create", role: null, focusProfileId: undefined })
                    }
                    onPreviewLaunch={(seed) => {
                      if (!teams.values.teams.some((team) => team.id === seed.teamId)) {
                        toast.error(designZh.savedTeamDeleted);
                        return;
                      }
                      setLaunch(seed);
                    }}
                  />
                }
                empty={teamEmptyView}
                onLaunch={(team) => setLaunch({ key: team.id, teamId: team.id })}
                onEdit={(team) => setTeamEditor({ mode: "edit", team })}
                onCopy={copyTeam}
                onDelete={deleteTeam}
                plans={{
                  summaries: plans.summaries,
                  modeContract: plans.modeContract,
                  pending: plans.pending,
                  error: plans.error,
                  onRetry: plans.retry,
                  onRefreshTeams: () => void teams.reload(),
                }}
              />
            </View>
            {tab === "roles" ? importView : null}
            {tab === "roles" ? (
              <RoleList
                theme={theme}
                roles={roles.values.roles}
                teams={teams.values.teams}
                profiles={profileList}
                query={roleQuery}
                onEdit={(role) => setRoleEditor({ mode: "edit", role, focusProfileId: undefined })}
                onCopy={(role) => void copyRole(role)}
                onDelete={(role) => void deleteRole(role)}
              />
            ) : tab === "runs" ? (
              <RunsTab
                theme={theme}
                hostId={host.id}
                navigation={navigation}
                legacyRuns={preferences.values.recentRuns}
              />
            ) : null}
          </ScrollView>
        </>
      ) : null}
      <EconomyPoolEditor
        key={host.id}
        theme={theme}
        layout={layout}
        open={economyOpen}
        hostId={host.id}
        adapter={adapter}
        profiles={profileList}
        profilesLoading={hostProfiles.status === "loading"}
        profilesError={hostProfiles.status === "error" ? hostProfiles.error : undefined}
        focus={economyFocus ?? undefined}
        onSaved={() => {
          plans.invalidate();
          void preferences.reload();
          toast.show(zh.economyPoolSaved, { variant: "success" });
        }}
        onClose={() => {
          plans.invalidate();
          setEconomyFocus(null);
          setEconomyOpen(false);
        }}
      />
      <PresetSyncDialog
        theme={theme}
        layout={layout}
        open={syncOpen}
        gateway={presetGateway}
        onClose={() => setSyncOpen(false)}
        onSynced={() => toast.show(zh.defaultPresetsSynced, { variant: "success" })}
      />
      <ConfirmDialog
        theme={theme}
        open={presetForceOpen}
        title={zh.importDefaultsForceTitle}
        body={zh.importDefaultsForceBody}
        confirmLabel={zh.importDefaults}
        danger
        onCancel={() => setPresetForceOpen(false)}
        onConfirm={() => {
          setPresetForceOpen(false);
          void runManualImport(true);
        }}
      />
      <RoleEditor
        theme={theme}
        layout={layout}
        open={roleEditor !== null}
        mode={roleEditor?.mode ?? "create"}
        role={roleEditor?.role ?? null}
        existingIds={new Set(ready ? roles.values.roles.map((role) => role.id) : [])}
        profiles={profileList}
        profilesLoading={hostProfiles.status === "loading"}
        profilesError={hostProfiles.status === "error" ? hostProfiles.error : undefined}
        saving={roles.status === "ready" && roles.saving}
        onRefreshProfiles={hostProfiles.reload}
        focusProfileId={roleEditor?.focusProfileId}
        onClose={() => {
          setRoleEditor(null);
          plans.invalidate();
          void hostProfiles.reload();
        }}
      />
      <TeamEditor
        theme={theme}
        layout={layout}
        open={teamEditor !== null}
        mode={teamEditor?.mode ?? "create"}
        team={teamEditor?.team ?? null}
        roles={ready ? roles.values.roles : []}
        existingIds={new Set(ready ? teams.values.teams.map((team) => team.id) : [])}
        saving={teams.status === "ready" && teams.saving}
        onClose={() => setTeamEditor(null)}
        planClient={plans.planClient}
        onOpenRole={(roleId, profileId) => {
          const resolved = roleEditorTargetForGap(
            roles.status === "ready" ? roles.values.roles : [],
            { roleId, ...(profileId === undefined ? {} : { profileId }) },
          );
          if (!resolved) {
            toast.error(zh.missingRoles(roleId));
            return;
          }
          setRoleEditor({
            mode: "edit",
            role: resolved.role,
            focusProfileId: resolved.focusProfileId,
          });
        }}
        onConfigureEconomy={(target) => {
          const focus = economyFocusForConfigure(target);
          if (!focus) return;
          setEconomyFocus(focus);
          setEconomyOpen(true);
        }}
      />
      {ready && launch ? (
        <LaunchDialog
          key={launch.key}
          theme={theme}
          layout={layout}
          open
          adapter={adapter}
          hostId={host.id}
          teams={teams.values.teams}
          roles={roles.values.roles}
          initialTeamId={launch.teamId}
          lockTeam={launch.lockTeam ?? launch.teamId !== undefined}
          initialTask={launch.initialTask}
          initialWorkspaceId={launch.initialWorkspaceId}
          modeContract={plans.modeContract}
          probeSettled={plansSettled}
          onClose={() => setLaunch(null)}
          onEditTeam={(team) => {
            setLaunch(null);
            setTab("teams");
            setTeamEditor({ mode: "edit", team });
          }}
          onLaunched={() => {
            setLaunch(null);
            setTab("runs");
          }}
        />
      ) : null}
      <ConfirmDialog
        theme={theme}
        open={resetTarget !== null}
        title={zh.resetTitle}
        body={zh.resetBody}
        confirmLabel={zh.reset}
        danger
        onCancel={() => setResetTarget(null)}
        onConfirm={() => {
          if (resetTarget === "roles") void roles.reset();
          if (resetTarget === "teams") void teams.reset();
          if (resetTarget === "preferences") void preferences.reset();
          setResetTarget(null);
        }}
      />
    </View>
  );
}

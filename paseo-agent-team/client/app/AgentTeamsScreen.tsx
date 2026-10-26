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
import { preferencesSettings, rolesSettings, teamsSettings } from "../../shared/settings";
import { zh } from "../../shared/zh";
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
import { LaunchDialog } from "../launch/LaunchDialog";
import { useHostProfiles } from "../paseo/profiles";
import { RoleEditor } from "../roles/RoleEditor";
import { RoleList } from "../roles/RoleList";
import { RunsTab } from "../runs/RunsTab";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { EmptyState } from "../shared/EmptyState";
import { ErrorState } from "../shared/ErrorState";
import { ImeTextInput } from "../shared/ImeTextInput";
import { TeamEditor } from "../teams/TeamEditor";
import { TeamsTab } from "../teams/TeamsTab";
import { VersionEntry } from "../version/VersionEntry";
import { AGENT_TEAM_TABS, type AgentTeamTab, parseTab, resolveInitialTab } from "./tabs";

const rolesReadRpc = settingsRpc(rolesSettings.id).read;
const rolesWriteRpc = settingsRpc(rolesSettings.id).write;
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

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((entry) => entry.id === item.id);
  if (index === -1) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function isConflict(message: string | null): boolean {
  return (message ?? "").toLowerCase().includes("conflict");
}

export function AgentTeamsScreen({ theme, layout, host, navigation, params }: PluginScreenProps) {
  const toast = useToast();
  const paseo = usePaseo();
  const adapter = useMemo(() => createPaseoAdapter(paseo), [paseo]);
  const previewPresets = useRpc(defaultCatalogPreviewRpc);
  const readRolesDoc = useRpc(rolesReadRpc);
  const readPreferencesDoc = useRpc(preferencesReadRpc);
  const writeRolesDoc = useRpc(rolesWriteRpc);
  const writePreferencesDoc = useRpc(preferencesWriteRpc);
  const roles = useSettings(rolesSettings);
  const teams = useSettings(teamsSettings);
  const preferences = useSettings(preferencesSettings);
  const hostProfiles = useHostProfiles(adapter);
  const ready =
    roles.status === "ready" && teams.status === "ready" && preferences.status === "ready";
  const requestedTab = parseTab(params.tab);
  const [tab, setTab] = useState<AgentTeamTab>(resolveInitialTab(params.tab));
  const [roleQuery, setRoleQuery] = useState("");
  const [presetImport, setPresetImport] = useState<PresetImportPhase>({ kind: "idle" });
  const [presetNotice, setPresetNotice] = useState<PresetNotice | null>(null);
  const [presetForceOpen, setPresetForceOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [roleEditor, setRoleEditor] = useState<{
    mode: "create" | "edit";
    role: Role | null;
  } | null>(null);
  const [teamEditor, setTeamEditor] = useState<{
    mode: "create" | "edit";
    team: Team | null;
  } | null>(null);
  const [launch, setLaunch] = useState<{ teamId?: string } | null>(null);
  const [resetTarget, setResetTarget] = useState<"roles" | "teams" | "preferences" | null>(null);

  useEffect(() => {
    if (requestedTab) setTab(requestedTab);
  }, [requestedTab]);

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

  const saveRoles = useCallback(
    async (next: Role[], revision: string) => {
      if (roles.status !== "ready") return false;
      return roles.save(toJsonValue({ roles: next }), revision);
    },
    [roles],
  );

  const persistRole = useCallback(
    async (role: Role, overwrite: boolean): Promise<boolean | "conflict"> => {
      if (roles.status !== "ready") return false;
      if (overwrite) await roles.reload();
      if (roles.status !== "ready") return false;
      const ok = await saveRoles(upsert(roles.values.roles, role), roles.revision);
      if (!ok) {
        if (isConflict(roles.saveError)) return "conflict";
        toast.error(roles.saveError ?? zh.saveFail);
        return false;
      }
      return true;
    },
    [roles, saveRoles, toast],
  );

  const persistTeam = useCallback(
    async (team: Team, overwrite: boolean): Promise<boolean | "conflict"> => {
      if (teams.status !== "ready") return false;
      if (overwrite) await teams.reload();
      if (teams.status !== "ready") return false;
      const ok = await teams.save(
        toJsonValue({ teams: upsert(teams.values.teams, team) }),
        teams.revision,
      );
      if (!ok) {
        if (isConflict(teams.saveError)) return "conflict";
        toast.error(teams.saveError ?? zh.saveFail);
        return false;
      }
      return true;
    },
    [teams, toast],
  );

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

  const copyTeam = useCallback(
    (team: Team) => {
      if (teams.status !== "ready") return;
      const now = new Date().toISOString();
      const copy = copyTeamRecord(
        team,
        uniqueCopyId(team.id, new Set(teams.values.teams.map((entry) => entry.id))),
        `${team.name} ${zh.copySuffix}`.slice(0, 40),
        now,
      );
      void persistTeam(copy, false);
    },
    [persistTeam, teams],
  );

  const deleteTeam = useCallback(
    (team: Team) => {
      if (teams.status !== "ready") return;
      void teams
        .save(
          toJsonValue({ teams: teams.values.teams.filter((entry) => entry.id !== team.id) }),
          teams.revision,
        )
        .then((ok) => {
          if (!ok) toast.error(teams.saveError ?? zh.saveFail);
        });
    },
    [teams, toast],
  );

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
  const profileList = hostProfiles.status === "ready" ? hostProfiles.profiles : [];
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
          <VersionEntry key={host.id} theme={theme} layout={layout} hostId={host.id} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={newLabel}
            onPress={() => {
              if (tab === "roles") setRoleEditor({ mode: "create", role: null });
              else if (tab === "teams") setTeamEditor({ mode: "create", team: null });
              else setLaunch({});
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
                }}
                empty={teamEmptyView}
                onLaunch={(team) => setLaunch({ teamId: team.id })}
                onEdit={(team) => setTeamEditor({ mode: "edit", team })}
                onCopy={copyTeam}
                onDelete={deleteTeam}
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
                onEdit={(role) => setRoleEditor({ mode: "edit", role })}
                onCopy={(role) => {
                  const now = new Date().toISOString();
                  const copy = copyRoleRecord(
                    role,
                    uniqueCopyId(role.id, new Set(roles.values.roles.map((entry) => entry.id))),
                    `${role.name} ${zh.copySuffix}`.slice(0, 40),
                    now,
                  );
                  void persistRole(copy, false);
                }}
                onDelete={(role) =>
                  void saveRoles(
                    roles.values.roles.filter((entry) => entry.id !== role.id),
                    roles.revision,
                  ).then((ok) => {
                    if (!ok) toast.error(roles.saveError ?? zh.saveFail);
                  })
                }
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
        onClose={() => setRoleEditor(null)}
        onSave={persistRole}
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
        onSave={persistTeam}
      />
      {ready && launch ? (
        <LaunchDialog
          theme={theme}
          layout={layout}
          open
          adapter={adapter}
          hostId={host.id}
          teams={teams.values.teams}
          roles={roles.values.roles}
          profiles={profileList}
          maxMembers={preferences.values.maxMembers}
          initialTeamId={launch.teamId}
          lockTeam={launch.teamId !== undefined}
          onClose={() => setLaunch(null)}
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

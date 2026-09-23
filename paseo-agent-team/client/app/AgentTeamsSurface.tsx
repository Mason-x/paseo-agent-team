import { type PluginSurfaceProps, usePaseo, useSettings } from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { uniqueCopyId } from "../../shared/ids";
import { toJsonValue } from "../../shared/json";
import type { Preferences } from "../../shared/schemas/preferences";
import type { Role } from "../../shared/schemas/role";
import type { Team } from "../../shared/schemas/team";
import { preferencesSettings, rolesSettings, teamsSettings } from "../../shared/settings";
import { exampleCatalog } from "../../shared/templates";
import { zh } from "../../shared/zh";
import { LaunchDialog } from "../launch/LaunchDialog";
import {
  createPaseoAdapter,
  type ProjectSummary,
  type ProviderAvailability,
} from "../paseo/adapter";
import { useHostProfiles } from "../paseo/profiles";
import { RoleEditor } from "../roles/RoleEditor";
import { RoleList } from "../roles/RoleList";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { EmptyState } from "../shared/EmptyState";
import { ErrorState } from "../shared/ErrorState";
import { ImeTextInput } from "../shared/ImeTextInput";
import { TeamEditor } from "../teams/TeamEditor";
import { TeamList } from "../teams/TeamList";
import type { AgentTeamTab } from "./tabs";

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

export function AgentTeamsSurface({ theme, layout }: PluginSurfaceProps) {
  const toast = useToast();
  const paseo = usePaseo();
  const adapter = useMemo(() => createPaseoAdapter(paseo), [paseo]);
  const roles = useSettings(rolesSettings);
  const teams = useSettings(teamsSettings);
  const preferences = useSettings(preferencesSettings);
  const hostProfiles = useHostProfiles(adapter);
  const [tab, setTab] = useState<AgentTeamTab>("roles");
  const [query, setQuery] = useState("");
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
  const [availability, setAvailability] = useState<ProviderAvailability[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);

  useEffect(() => {
    if (!launch) return;
    let cancelled = false;
    void Promise.all([adapter.listProviderAvailability(), adapter.listProjects()])
      .then(([nextAvailability, nextProjects]) => {
        if (cancelled) return;
        setAvailability(nextAvailability);
        setProjects(nextProjects);
      })
      .catch((error) => {
        if (!cancelled) toast.error(error instanceof Error ? error.message : zh.launchContextFail);
      });
    return () => {
      cancelled = true;
    };
  }, [adapter, launch, toast]);

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
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
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
      newButton: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 4,
        minHeight: 28,
        paddingHorizontal: 8,
        flexShrink: 0,
      },
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

  const importExamples = useCallback(async () => {
    if (roles.status !== "ready" || teams.status !== "ready" || preferences.status !== "ready")
      return;
    const now = new Date().toISOString();
    const profiles = hostProfiles.status === "ready" ? hostProfiles.profiles : [];
    const catalog = exampleCatalog(profiles, now);
    const rolesOk = await roles.save(toJsonValue({ roles: catalog.roles }), roles.revision);
    const teamsOk = await teams.save(toJsonValue({ teams: catalog.teams }), teams.revision);
    await preferences.save(
      toJsonValue({ ...preferences.values, templatesImportedAt: now }),
      preferences.revision,
    );
    if (rolesOk && teamsOk) toast.show(zh.importOk, { variant: "success" });
    else toast.error(zh.importFail);
  }, [hostProfiles, preferences, roles, teams, toast]);

  const catalogEmpty =
    roles.status === "ready" &&
    teams.status === "ready" &&
    roles.values.roles.length === 0 &&
    teams.values.teams.length === 0;

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
  const ready =
    roles.status === "ready" && teams.status === "ready" && preferences.status === "ready";
  const profileList = hostProfiles.status === "ready" ? hostProfiles.profiles : [];

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.tabs}>
          {(["roles", "teams"] as const).map((item) => (
            <Pressable
              key={item}
              accessibilityRole="button"
              accessibilityState={{ selected: tab === item }}
              accessibilityLabel={item === "roles" ? zh.roles : zh.teams}
              onPress={() => setTab(item)}
              style={[styles.tab, tab === item && styles.tabSelected]}
            >
              <Text style={[styles.tabLabel, tab === item && styles.tabLabelSelected]}>
                {item === "roles" ? zh.roles : zh.teams}
              </Text>
            </Pressable>
          ))}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={tab === "roles" ? zh.newRole : zh.newTeam}
          onPress={() =>
            tab === "roles"
              ? setRoleEditor({ mode: "create", role: null })
              : setTeamEditor({ mode: "create", team: null })
          }
          style={({ pressed }) => [styles.newButton, pressed && { opacity: 0.72 }]}
        >
          <Icon name="Plus" size={14} color={theme.colors.accent} />
          <Text style={styles.action}>{tab === "roles" ? zh.newRole : zh.newTeam}</Text>
        </Pressable>
      </View>
      {blocked}
      {ready ? (
        <>
          <View style={styles.toolbar}>
            <View style={styles.searchWrap}>
              <Icon name="Search" size={15} color={theme.colors.foregroundMuted} />
              <ImeTextInput
                initialValue=""
                onChangeText={setQuery}
                placeholder={tab === "roles" ? zh.searchRoles : zh.searchTeams}
                placeholderTextColor={theme.colors.foregroundMuted}
                style={styles.search}
              />
            </View>
          </View>
          <ScrollView>
            {catalogEmpty ? (
              <EmptyState
                theme={theme}
                title={zh.emptyTitle}
                body={zh.emptyBody}
                actionLabel={zh.importRuflo}
                onAction={() => void importExamples()}
              />
            ) : null}
            {tab === "roles" ? (
              <RoleList
                theme={theme}
                roles={roles.values.roles}
                teams={teams.values.teams}
                profiles={profileList}
                query={query}
                onEdit={(role) => setRoleEditor({ mode: "edit", role })}
                onCopy={(role) => {
                  const now = new Date().toISOString();
                  const copy: Role = {
                    ...role,
                    id: uniqueCopyId(role.id, new Set(roles.values.roles.map((entry) => entry.id))),
                    name: `${role.name} ${zh.copySuffix}`.slice(0, 40),
                    createdAt: now,
                    updatedAt: now,
                  };
                  void persistRole(copy, false);
                }}
                onDelete={(role) =>
                  void saveRoles(
                    roles.values.roles.filter((entry) => entry.id !== role.id),
                    roles.revision,
                  )
                }
              />
            ) : (
              <TeamList
                theme={theme}
                teams={teams.values.teams}
                roles={roles.values.roles}
                query={query}
                onLaunch={(team) => setLaunch({ teamId: team.id })}
                onEdit={(team) => setTeamEditor({ mode: "edit", team })}
                onCopy={(team) => {
                  const now = new Date().toISOString();
                  const copy: Team = {
                    ...team,
                    id: uniqueCopyId(team.id, new Set(teams.values.teams.map((entry) => entry.id))),
                    name: `${team.name} ${zh.copySuffix}`.slice(0, 40),
                    createdAt: now,
                    updatedAt: now,
                  };
                  void persistTeam(copy, false);
                }}
                onDelete={(team) =>
                  void teams.save(
                    { teams: teams.values.teams.filter((entry) => entry.id !== team.id) },
                    teams.revision,
                  )
                }
              />
            )}
          </ScrollView>
        </>
      ) : null}
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
          teams={teams.values.teams}
          roles={roles.values.roles}
          profiles={profileList}
          availability={availability}
          projects={projects}
          preferences={preferences.values}
          initialTeamId={launch.teamId}
          onClose={() => setLaunch(null)}
          onLaunched={() => setLaunch(null)}
          onSavePreferences={async (next: Preferences) => {
            await preferences.save(next, preferences.revision);
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

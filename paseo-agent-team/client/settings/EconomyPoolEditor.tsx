import { settingsRpc } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import type { JSONType } from "zod";
import type { EconomyBudget } from "../../shared/domain/mode-resolver";
import { toJsonValue } from "../../shared/json";
import type { PaseoAdapter, PaseoProfile } from "../../shared/paseo/adapter";
import { PreferencesSchema } from "../../shared/schemas/preferences";
import type { TaskKind } from "../../shared/schemas/team-mode";
import { preferencesSettings } from "../../shared/settings";
import { zh } from "../../shared/zh";
import { GhostIconButton, ModalActions } from "../shared/buttons";
import { CompactPicker } from "../shared/CompactPicker";
import { Field, inputStyle } from "../shared/Field";
import { ImeTextInput } from "../shared/ImeTextInput";
import { TASK_KIND_OPTIONS } from "../shared/team-mode-options";
import type { PluginLayout, PluginTheme } from "../shared/theme";
import {
  addPoolEntry,
  applySuggestedPool,
  DEFAULT_MAX_MEMBERS,
  decideEconomySave,
  draftFromStored,
  type EconomyEditorState,
  type EconomyOpenedSnapshot,
  effectiveTaskOrder,
  familyIsInvalid,
  familyNeedsRebind,
  MAX_MAX_MEMBERS,
  mergeEconomyPreferences,
  movePoolEntry,
  moveTaskOrder,
  needsLiveProfilesForSave,
  rebindPoolFamily,
  removePoolEntry,
  removeProfileBudget,
  resetTaskOrder,
  resolveMaxMembersForSave,
  setPoolEnabled,
  setPoolFamily,
  setProfileBudget,
} from "./economy-pool";

const preferencesRead = settingsRpc(preferencesSettings.id).read;
const preferencesWrite = settingsRpc(preferencesSettings.id).write;

const BUDGET_OPTIONS: readonly { id: EconomyBudget; name: string }[] = [
  { id: "economy", name: zh.economyPoolBudgetEconomy },
  { id: "sota", name: zh.economyPoolBudgetSota },
  { id: "unknown", name: zh.economyPoolBudgetUnknown },
];

function emptyState(): EconomyEditorState {
  return {
    pool: [],
    taskOrder: {},
    profileBudget: {},
    removed: [],
    removedBudgets: [],
    maxMembers: DEFAULT_MAX_MEMBERS,
  };
}

export function EconomyPoolEditor({
  theme,
  layout,
  open,
  hostId,
  adapter,
  profiles,
  profilesLoading,
  profilesError,
  onClose,
  onSaved,
}: {
  theme: PluginTheme;
  layout: PluginLayout;
  open: boolean;
  hostId: string;
  adapter: PaseoAdapter;
  profiles: readonly PaseoProfile[];
  profilesLoading: boolean;
  profilesError?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const readPreferences = useRpc(preferencesRead);
  const writePreferences = useRpc(preferencesWrite);
  const [state, setState] = useState<EconomyEditorState>(emptyState);
  const [maxText, setMaxText] = useState(String(DEFAULT_MAX_MEMBERS));
  const [taskKind, setTaskKind] = useState<TaskKind>("coding");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [seed, setSeed] = useState(0);
  const [loadSeed, setLoadSeed] = useState(0);
  const [opened, setOpened] = useState<EconomyOpenedSnapshot>({
    economy: null,
    maxMembers: DEFAULT_MAX_MEMBERS,
  });
  const [conflict, setConflict] = useState(false);
  const availability = useQuery({
    queryKey: ["agent-team", "provider-availability", hostId],
    enabled: open,
    staleTime: 30_000,
    queryFn: () => adapter.listProviderAvailability(),
  });

  useEffect(() => {
    void loadSeed;
    if (!open) return;
    let active = true;
    setLoading(true);
    setLoadError(null);
    setError(null);
    setNotice(null);
    setConflict(false);
    void readPreferences({})
      .then((result) => {
        if (!active) return;
        if (result.status !== "ready") {
          setLoadError(result.error ?? zh.economyPoolLoadFail);
          return;
        }
        const parsed = PreferencesSchema.safeParse(result.values);
        if (!parsed.success) {
          setLoadError(zh.economyPoolLoadFail);
          return;
        }
        const draft = draftFromStored(parsed.data.economy);
        setState({ ...draft, maxMembers: parsed.data.maxMembers });
        setMaxText(String(parsed.data.maxMembers));
        setOpened({ economy: parsed.data.economy ?? null, maxMembers: parsed.data.maxMembers });
        setConflict(false);
        setSeed((value) => value + 1);
      })
      .catch(() => {
        if (active) setLoadError(zh.economyPoolLoadFail);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadSeed, open, readPreferences]);

  const styles = useMemo(
    () => ({
      root: { gap: layout.compact ? 10 : 14 },
      section: { gap: 6 },
      sectionTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: 11 },
      danger: { color: theme.colors.statusDanger, fontSize: 12 },
      warning: { color: theme.colors.statusWarning, fontSize: 11 },
      row: {
        gap: 6,
        padding: 9,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      },
      rowHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      grow: { flex: 1, minWidth: 0 },
      name: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      profileMeta: { color: theme.colors.foregroundMuted, fontSize: 11 },
      orderRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      orderName: { color: theme.colors.foreground, fontSize: 12, flex: 1 },
      link: { color: theme.colors.accent, fontSize: 12, fontWeight: "600" as const },
      actions: { flexDirection: "row" as const, gap: 6, flexWrap: "wrap" as const },
      budgetRow: {
        flexDirection: layout.compact ? ("column" as const) : ("row" as const),
        alignItems: layout.compact ? ("stretch" as const) : ("center" as const),
        gap: 6,
      },
    }),
    [layout.compact, theme],
  );

  function update(transform: (draft: EconomyEditorState) => EconomyEditorState) {
    setState((current) => transform(current));
  }

  function addProfile(profileId: string) {
    if (!profileId) return;
    update((current) => ({
      ...addPoolEntry(removeProfileBudget(current, profileId), profileId),
      maxMembers: current.maxMembers,
    }));
  }

  function removeProfile(profileId: string) {
    update((current) => ({
      ...removePoolEntry(current, profileId),
      maxMembers: current.maxMembers,
    }));
  }

  function moveProfile(index: number, direction: -1 | 1) {
    update((current) => ({
      ...movePoolEntry(current, index, direction),
      maxMembers: current.maxMembers,
    }));
  }

  function changeFamily(profileId: string, family: string) {
    update((current) => ({
      ...setPoolFamily(current, profileId, family),
      maxMembers: current.maxMembers,
    }));
  }

  function rebindFamily(profileId: string) {
    update((current) => ({
      ...rebindPoolFamily(current, profileId),
      maxMembers: current.maxMembers,
    }));
  }

  function toggleProfile(profileId: string, enabled: boolean) {
    update((current) => ({
      ...setPoolEnabled(current, profileId, enabled),
      maxMembers: current.maxMembers,
    }));
  }

  function moveTask(kind: TaskKind, index: number, direction: -1 | 1) {
    update((current) => ({
      ...moveTaskOrder(current, kind, index, direction),
      maxMembers: current.maxMembers,
    }));
  }

  function applyPoolOrder(kind: TaskKind) {
    update((current) => ({ ...resetTaskOrder(current, kind), maxMembers: current.maxMembers }));
  }

  function applySuggestions() {
    const next = applySuggestedPool(state, profiles);
    if (next.pool.length === state.pool.length) {
      setNotice(zh.economyPoolSuggestedNone);
      return;
    }
    setNotice(null);
    setState({ ...next, maxMembers: state.maxMembers });
  }

  function changeBudget(profileId: string, budget: EconomyBudget) {
    update((current) => ({
      ...setProfileBudget(current, profileId, budget),
      maxMembers: current.maxMembers,
    }));
  }

  function addBudgetProfile(profileId: string) {
    if (!profileId) return;
    update((current) => ({
      ...setProfileBudget(current, profileId, "unknown"),
      maxMembers: current.maxMembers,
    }));
  }

  function removeBudget(profileId: string) {
    update((current) => ({
      ...removeProfileBudget(current, profileId),
      maxMembers: current.maxMembers,
    }));
  }

  async function save(forceOverwrite = false) {
    setSaving(true);
    setError(null);
    setConflict(false);
    if (needsLiveProfilesForSave(state, profiles)) {
      setError(zh.economyPoolProfilesRequired);
      setSaving(false);
      return;
    }
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const current = await readPreferences({});
        if (current.status !== "ready") {
          setError(current.error ?? zh.economyPoolLoadFail);
          return;
        }
        const parsed = PreferencesSchema.safeParse(current.values);
        if (!parsed.success) {
          setError(zh.economyPoolLoadFail);
          return;
        }
        const max = resolveMaxMembersForSave(maxText, opened.maxMembers, parsed.data.maxMembers);
        if (!max.ok) {
          setError(zh.economyPoolMaxMembersInvalid);
          return;
        }
        if (decideEconomySave(opened, parsed.data, forceOverwrite) === "conflict") {
          setConflict(true);
          return;
        }
        const next = mergeEconomyPreferences(parsed.data, state, profiles, {
          ...(max.write ? { maxMembers: max.value } : {}),
          ...(forceOverwrite ? { economyBase: opened.economy } : {}),
        });
        const result = await writePreferences({
          revision: current.revision,
          values: toJsonValue(next) as JSONType,
        });
        if (result.status === "saved") {
          onSaved();
          onClose();
          return;
        }
        if (result.status === "invalid") {
          setError(result.error ?? zh.economyPoolSaveFail);
          return;
        }
      }
      setError(zh.economyPoolSaveConflict);
    } catch {
      setError(zh.economyPoolSaveFail);
    } finally {
      setSaving(false);
    }
  }

  const poolIds = new Set(state.pool.map((entry) => entry.profileId));
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  const availableProfiles = profiles.filter((profile) => !poolIds.has(profile.id));
  const budgetIds = Object.keys(state.profileBudget).filter((id) => !poolIds.has(id));
  const availableBudgetProfiles = profiles.filter(
    (profile) => !poolIds.has(profile.id) && state.profileBudget[profile.id] === undefined,
  );
  const order = effectiveTaskOrder(state, taskKind);
  const ompAvailability = availability.data?.find((entry) => entry.provider === "omp");
  const ompWarning = availability.data
    ? ompAvailability
      ? ompAvailability.available
        ? null
        : zh.economyPoolOmpUnavailable(ompAvailability.reason)
      : zh.economyPoolOmpMissing
    : null;
  const legacyMax =
    opened.maxMembers > MAX_MAX_MEMBERS && maxText.trim() === String(opened.maxMembers);

  return (
    <Modal title={zh.economyPoolTitle} open={open} onOpenChange={(next) => !next && onClose()}>
      <Modal.Content>
        <View style={styles.root}>
          <Text style={styles.muted}>{zh.economyPoolIntro}</Text>
          {loading ? <Text style={styles.muted}>{zh.economyPoolLoading}</Text> : null}
          {loadError ? (
            <View style={styles.section}>
              <Text style={styles.danger}>{loadError}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={zh.economyPoolRetry}
                onPress={() => {
                  setLoadError(null);
                  setLoadSeed((value) => value + 1);
                }}
              >
                <Text style={styles.link}>{zh.economyPoolRetry}</Text>
              </Pressable>
            </View>
          ) : null}
          {!loading && !loadError ? (
            <>
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>{zh.economyPool}</Text>
                {state.pool.length === 0 ? (
                  <Text style={styles.muted}>{zh.economyPoolEmpty}</Text>
                ) : null}
                {state.pool.map((entry, index) => {
                  const profile = profilesById.get(entry.profileId);
                  const displayName = profile?.name ?? entry.profileId;
                  const rebind = familyNeedsRebind(entry, profile);
                  return (
                    <View key={entry.profileId} style={styles.row}>
                      <View style={styles.rowHead}>
                        <View style={styles.grow}>
                          <Text style={styles.name} numberOfLines={1}>
                            {profile?.name ?? zh.economyPoolProfileMissing(entry.profileId)}
                          </Text>
                          {profile ? (
                            <Text style={styles.profileMeta}>
                              {profile.provider}
                              {profile.model ? `/${profile.model}` : ""}
                            </Text>
                          ) : null}
                        </View>
                        <GhostIconButton
                          theme={theme}
                          icon="ChevronUp"
                          accessibilityLabel={zh.economyPoolMoveUpFor(displayName)}
                          onPress={() => moveProfile(index, -1)}
                        />
                        <GhostIconButton
                          theme={theme}
                          icon="ChevronDown"
                          accessibilityLabel={zh.economyPoolMoveDownFor(displayName)}
                          onPress={() => moveProfile(index, 1)}
                        />
                        <GhostIconButton
                          theme={theme}
                          icon="Trash2"
                          danger
                          accessibilityLabel={zh.economyPoolRemoveFor(displayName)}
                          onPress={() => removeProfile(entry.profileId)}
                        />
                      </View>
                      <Text style={styles.muted}>{zh.economyPoolFamily}</Text>
                      <ImeTextInput
                        accessibilityLabel={zh.economyPoolFamilyFor(displayName)}
                        initialValue={entry.family}
                        revision={`${seed}:${entry.profileId}`}
                        onChangeText={(value) => changeFamily(entry.profileId, value)}
                        placeholder={zh.economyPoolFamilyPlaceholder}
                        placeholderTextColor={theme.colors.foregroundMuted}
                        style={inputStyle(theme)}
                      />
                      {familyIsInvalid(entry.family) ? (
                        <Text style={styles.warning}>{zh.economyPoolFamilyInvalid}</Text>
                      ) : null}
                      {rebind && profile ? (
                        <>
                          <Text style={styles.warning}>
                            {zh.economyPoolFamilyChanged(profile.name)}
                          </Text>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={zh.economyPoolRebindFamily}
                            onPress={() => rebindFamily(entry.profileId)}
                          >
                            <Text style={styles.link}>{zh.economyPoolRebindFamily}</Text>
                          </Pressable>
                        </>
                      ) : null}
                      <View style={styles.rowHead}>
                        <Text style={[styles.muted, styles.grow]}>{zh.economyPoolFamilyHint}</Text>
                        <Switch
                          accessibilityLabel={zh.economyPoolToggleFor(displayName)}
                          value={entry.enabled}
                          onValueChange={(enabled) => toggleProfile(entry.profileId, enabled)}
                        />
                      </View>
                    </View>
                  );
                })}
                {profilesLoading ? <Text style={styles.muted}>{zh.loadingProfiles}</Text> : null}
                {profilesError ? (
                  <Text style={styles.warning}>{zh.economyPoolProfilesUnavailable}</Text>
                ) : null}
                {ompWarning ? <Text style={styles.warning}>{ompWarning}</Text> : null}
                {profiles.length === 0 && !profilesLoading ? (
                  <Text style={styles.muted}>{zh.economyPoolNoProfiles}</Text>
                ) : (
                  <CompactPicker
                    theme={theme}
                    label={zh.economyPoolAddProfile}
                    items={availableProfiles.map((profile) => ({
                      id: profile.id,
                      name: profile.name,
                    }))}
                    selectedId=""
                    placeholder={zh.economyPoolAddProfile}
                    searchPlaceholder={zh.searchProfiles}
                    emptyLabel={zh.economyPoolNoProfiles}
                    subtitle={(item) => {
                      const profile = profilesById.get(item.id);
                      return profile?.model
                        ? `${profile.provider}/${profile.model}`
                        : profile?.provider;
                    }}
                    onChange={addProfile}
                  />
                )}
                {profiles.length > 0 ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={zh.economyPoolSuggest}
                    onPress={applySuggestions}
                  >
                    <Text style={styles.link}>{zh.economyPoolSuggest}</Text>
                  </Pressable>
                ) : null}
                {notice ? <Text style={styles.warning}>{notice}</Text> : null}
              </View>

              <View style={styles.section}>
                <Text style={styles.sectionTitle}>{zh.economyPoolTaskOrder}</Text>
                <CompactPicker
                  theme={theme}
                  label={zh.economyPoolTaskKind}
                  items={TASK_KIND_OPTIONS.map((option) => ({
                    id: option.value,
                    name: option.label,
                  }))}
                  selectedId={taskKind}
                  placeholder={zh.economyPoolTaskKind}
                  searchPlaceholder={zh.searchTaskKinds}
                  emptyLabel={zh.noMatches}
                  onChange={(id) => setTaskKind(id as TaskKind)}
                />
                {order.length === 0 ? (
                  <Text style={styles.muted}>{zh.economyPoolOrderEmpty}</Text>
                ) : (
                  order.map((profileId, index) => {
                    const name = profilesById.get(profileId)?.name ?? profileId;
                    return (
                      <View key={profileId} style={styles.orderRow}>
                        <Text style={styles.orderName} numberOfLines={1}>
                          {name}
                        </Text>
                        <GhostIconButton
                          theme={theme}
                          icon="ChevronUp"
                          accessibilityLabel={zh.economyPoolMoveUpFor(name)}
                          onPress={() => moveTask(taskKind, index, -1)}
                        />
                        <GhostIconButton
                          theme={theme}
                          icon="ChevronDown"
                          accessibilityLabel={zh.economyPoolMoveDownFor(name)}
                          onPress={() => moveTask(taskKind, index, 1)}
                        />
                      </View>
                    );
                  })
                )}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={zh.economyPoolResetOrder}
                  onPress={() => applyPoolOrder(taskKind)}
                >
                  <Text style={styles.link}>{zh.economyPoolResetOrder}</Text>
                </Pressable>
              </View>

              <View style={styles.section}>
                <Text style={styles.sectionTitle}>{zh.economyPoolBudget}</Text>
                <Text style={styles.muted}>{zh.economyPoolBudgetHint}</Text>
                {budgetIds.map((profileId) => (
                  <View key={profileId} style={styles.budgetRow}>
                    <Text style={[styles.orderName]} numberOfLines={1}>
                      {profilesById.get(profileId)?.name ?? zh.economyPoolProfileMissing(profileId)}
                    </Text>
                    <CompactPicker
                      theme={theme}
                      label={zh.economyPoolBudget}
                      items={BUDGET_OPTIONS}
                      selectedId={state.profileBudget[profileId] ?? "unknown"}
                      placeholder={zh.economyPoolBudgetUnknown}
                      searchPlaceholder={zh.searchOptions}
                      emptyLabel={zh.noMatches}
                      onChange={(id) => changeBudget(profileId, id as EconomyBudget)}
                    />
                    <GhostIconButton
                      theme={theme}
                      icon="X"
                      accessibilityLabel={zh.economyPoolRemoveBudgetFor(
                        profilesById.get(profileId)?.name ?? profileId,
                      )}
                      onPress={() => removeBudget(profileId)}
                    />
                  </View>
                ))}
                {availableBudgetProfiles.length > 0 ? (
                  <CompactPicker
                    theme={theme}
                    label={zh.economyPoolAddBudget}
                    items={availableBudgetProfiles.map((profile) => ({
                      id: profile.id,
                      name: profile.name,
                    }))}
                    selectedId=""
                    placeholder={zh.economyPoolAddBudget}
                    searchPlaceholder={zh.searchProfiles}
                    emptyLabel={zh.economyPoolNoProfiles}
                    onChange={addBudgetProfile}
                  />
                ) : null}
              </View>

              <Field theme={theme} label={zh.economyPoolMaxMembers}>
                <ImeTextInput
                  initialValue={maxText}
                  revision={seed}
                  keyboardType="number-pad"
                  onChangeText={setMaxText}
                  placeholder={String(DEFAULT_MAX_MEMBERS)}
                  placeholderTextColor={theme.colors.foregroundMuted}
                  style={inputStyle(theme)}
                />
                <Text style={styles.muted}>{zh.economyPoolMaxMembersHint}</Text>
                {legacyMax ? (
                  <Text style={styles.warning}>
                    {zh.economyPoolMaxMembersLegacy(opened.maxMembers)}
                  </Text>
                ) : null}
              </Field>

              {error ? <Text style={styles.danger}>{error}</Text> : null}
              {conflict ? (
                <View style={styles.section}>
                  <Text style={styles.danger}>{zh.economyPoolConflictBody}</Text>
                  <View style={styles.actions}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={zh.economyPoolOverwrite}
                      onPress={() => void save(true)}
                    >
                      <Text style={styles.link}>{zh.economyPoolOverwrite}</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={zh.economyPoolReload}
                      onPress={() => {
                        setConflict(false);
                        setLoadSeed((value) => value + 1);
                      }}
                    >
                      <Text style={styles.link}>{zh.economyPoolReload}</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}
              <ModalActions
                theme={theme}
                confirmLabel={saving ? zh.saving : zh.save}
                confirmDisabled={saving}
                onCancel={onClose}
                onConfirm={() => void save()}
              />
            </>
          ) : null}
        </View>
      </Modal.Content>
    </Modal>
  );
}

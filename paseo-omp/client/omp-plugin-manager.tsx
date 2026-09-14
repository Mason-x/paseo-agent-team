import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import type { TextStyle, ViewStyle } from "react-native";
import { Pressable, Switch, Text, View } from "react-native";
import {
  inspectOmpPluginConfig,
  listOmpPlugins,
  mutateOmpPlugin,
  mutateOmpPluginConfig,
  type OmpInstalledPlugin,
  type OmpPluginConfigMutation,
  OmpPluginConfigMutationSchema,
  type OmpPluginConfigSetting,
  type OmpPluginConfigState,
  OmpPluginInstallSourceSchema,
  type OmpPluginMutation,
} from "../shared/omp-plugins";

const PLUGINS_QUERY_KEY = ["paseo-omp", "plugins"] as const;

type PendingConfirmation =
  | {
      kind: "plugin";
      input: OmpPluginMutation;
      title: string;
      warning: string;
    }
  | {
      kind: "config";
      input: OmpPluginConfigMutation;
      title: string;
      warning: string;
    };

type PluginManagerStyles = {
  root: ViewStyle;
  header: ViewStyle;
  title: TextStyle;
  muted: TextStyle;
  error: TextStyle;
  success: TextStyle;
  card: ViewStyle;
  cardHeader: ViewStyle;
  cardTitle: TextStyle;
  metadata: ViewStyle;
  metadataRow: ViewStyle;
  metadataLabel: TextStyle;
  metadataValue: TextStyle;
  pluginGrid: ViewStyle;
  pluginCard: ViewStyle;
  actions: ViewStyle;
  button: ViewStyle;
  buttonPrimary: ViewStyle;
  buttonDanger: ViewStyle;
  buttonDisabled: ViewStyle;
  buttonText: TextStyle;
  buttonTextPrimary: TextStyle;
  input: TextStyle;
  scopeRow: ViewStyle;
  scopeButton: ViewStyle;
  scopeButtonActive: ViewStyle;
  scopeText: TextStyle;
  scopeTextActive: TextStyle;
  confirmation: ViewStyle;
  warning: TextStyle;
  settings: ViewStyle;
  setting: ViewStyle;
  settingName: TextStyle;
  settingDescription: TextStyle;
};

function usePluginManagerStyles(
  theme: PluginSurfaceProps["theme"],
  compact: boolean,
): PluginManagerStyles {
  return useMemo(
    () => ({
      root: { gap: compact ? 10 : 14 },
      header: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: 8,
      },
      title: { color: theme.colors.foreground, fontSize: compact ? 16 : 18, fontWeight: "600" },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 },
      error: { color: theme.colors.statusDanger, fontSize: 13, lineHeight: 18 },
      success: { color: theme.colors.statusSuccess, fontSize: 13, lineHeight: 18 },
      card: {
        gap: 10,
        padding: compact ? 10 : 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
      },
      cardHeader: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: 8,
      },
      cardTitle: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600", flexShrink: 1 },
      metadata: { gap: 5 },
      metadataRow: { flexDirection: compact ? "column" : "row", gap: compact ? 1 : 8 },
      metadataLabel: {
        width: compact ? undefined : 80,
        color: theme.colors.foregroundMuted,
        fontSize: 12,
      },
      metadataValue: { color: theme.colors.foreground, fontSize: 12, flexShrink: 1 },
      pluginGrid: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: 10 },
      pluginCard: {
        width: compact ? "100%" : 320,
        flexGrow: compact ? 0 : 1,
        gap: 8,
        padding: compact ? 10 : 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
      },
      actions: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
      button: {
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 7,
        backgroundColor: theme.colors.surface0,
      },
      buttonPrimary: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accent },
      buttonDanger: { borderColor: theme.colors.statusDanger },
      buttonDisabled: { opacity: 0.5 },
      buttonText: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" },
      buttonTextPrimary: { color: theme.colors.accentForeground },
      input: {
        color: theme.colors.foreground,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface0,
        paddingHorizontal: 10,
        paddingVertical: 8,
        fontSize: 13,
      },
      scopeRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
      scopeButton: {
        paddingHorizontal: 9,
        paddingVertical: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 7,
      },
      scopeButtonActive: { backgroundColor: theme.colors.surface2 },
      scopeText: { color: theme.colors.foregroundMuted, fontSize: 12 },
      scopeTextActive: { color: theme.colors.foreground, fontWeight: "600" },
      confirmation: {
        gap: 9,
        padding: compact ? 10 : 12,
        borderWidth: 1,
        borderColor: theme.colors.statusWarning,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
      },
      warning: { color: theme.colors.statusWarning, fontSize: 13, lineHeight: 18 },
      settings: { gap: 7 },
      setting: { gap: 3, paddingTop: 7, borderTopWidth: 1, borderTopColor: theme.colors.border },
      settingName: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" },
      settingDescription: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
    }),
    [compact, theme],
  );
}

function ActionButton({
  label,
  disabled,
  primary,
  danger,
  styles,
  onPress,
}: {
  label: string;
  disabled: boolean;
  primary?: boolean;
  danger?: boolean;
  styles: PluginManagerStyles;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        primary ? styles.buttonPrimary : null,
        danger ? styles.buttonDanger : null,
        disabled ? styles.buttonDisabled : null,
      ]}
    >
      <Text style={[styles.buttonText, primary ? styles.buttonTextPrimary : null]}>{label}</Text>
    </Pressable>
  );
}

function MetadataRow({
  label,
  value,
  styles,
}: {
  label: string;
  value: string;
  styles: PluginManagerStyles;
}) {
  return (
    <View style={styles.metadataRow}>
      <Text style={styles.metadataLabel}>{label}</Text>
      <Text selectable style={styles.metadataValue}>
        {value}
      </Text>
    </View>
  );
}

function confirmationFor(input: OmpPluginMutation): PendingConfirmation {
  const target = input.action === "install" ? input.source : input.plugin;
  switch (input.action) {
    case "install":
      return {
        kind: "plugin",
        input,
        title: `Install ${target}?`,
        warning:
          "OMP plugins are trusted code. Installing can fetch code and change persistent state; runtime extensions load in a future OMP session.",
      };
    case "enable":
      return {
        kind: "plugin",
        input,
        title: `Enable ${target}?`,
        warning:
          "Enabling changes persistent state and permits this plugin's trusted code to load in future OMP sessions.",
      };
    case "disable":
      return {
        kind: "plugin",
        input,
        title: `Disable ${target}?`,
        warning:
          "Disabling changes persistent state. OMP sessions that are already running are not unloaded.",
      };
    case "uninstall":
      return {
        kind: "plugin",
        input,
        title: `Uninstall ${target}?`,
        warning:
          "Uninstalling removes the selected plugin registration and cached installation. Running OMP sessions are unchanged.",
      };
    case "upgrade":
      return {
        kind: "plugin",
        input,
        title: `Upgrade ${target}?`,
        warning:
          "Upgrading fetches and replaces trusted plugin code. The updated runtime loads in a future OMP session.",
      };
  }
}

function configConfirmationFor(
  input: OmpPluginConfigMutation,
  setting: OmpPluginConfigSetting,
): PendingConfirmation {
  if (input.action === "delete") {
    return {
      kind: "config",
      input,
      title: `Delete ${setting.key}?`,
      warning:
        "This changes persistent OMP plugin configuration. Future sessions will use the setting's default or environment fallback.",
    };
  }
  return {
    kind: "config",
    input,
    title: `Set ${setting.key}?`,
    warning: setting.secret
      ? "This writes a secret value to OMP's persistent plugin configuration. The value will remain write-only in Paseo."
      : "This changes persistent OMP plugin configuration for future sessions.",
  };
}

function ConfigSettingEditor({
  plugin,
  setting,
  busy,
  theme,
  styles,
  onConfirm,
}: {
  plugin: string;
  setting: OmpPluginConfigSetting;
  busy: boolean;
  theme: PluginSurfaceProps["theme"];
  styles: PluginManagerStyles;
  onConfirm(input: OmpPluginConfigMutation, setting: OmpPluginConfigSetting): void;
}) {
  const [draft, setDraft] = useState<string | boolean>(setting.type === "boolean" ? false : "");
  let value: string | number | boolean | undefined;
  let validationMessage: string | null = null;
  if (!setting.secret) {
    if (setting.type === "boolean") {
      value = draft === true;
    } else if (setting.type === "number") {
      const raw = typeof draft === "string" ? draft.trim() : "";
      const parsed = raw ? Number(raw) : Number.NaN;
      if (!Number.isFinite(parsed)) validationMessage = "Enter a finite number.";
      else if (setting.minimum !== undefined && parsed < setting.minimum) {
        validationMessage = `Minimum: ${setting.minimum}`;
      } else if (setting.maximum !== undefined && parsed > setting.maximum) {
        validationMessage = `Maximum: ${setting.maximum}`;
      } else value = parsed;
    } else if (setting.type === "enum") {
      if (typeof draft !== "string" || !setting.enumValues.includes(draft)) {
        validationMessage = "Choose one of the documented values.";
      } else value = draft;
    } else if (typeof draft === "string") {
      value = draft;
    }
  }
  const candidate =
    value === undefined
      ? null
      : OmpPluginConfigMutationSchema.safeParse({
          action: "set",
          plugin,
          key: setting.key,
          value,
        });
  if (candidate && !candidate.success) validationMessage = "Enter a valid bounded value.";

  return (
    <View style={styles.setting}>
      <Text selectable style={styles.settingName}>
        {setting.key} · {setting.type}
      </Text>
      <Text style={setting.secret ? styles.warning : styles.muted}>
        {setting.secret
          ? setting.configured
            ? "Secret · configured"
            : "Secret · not configured"
          : setting.configured
            ? "Configured"
            : "Not configured"}
      </Text>
      {setting.description ? (
        <Text style={styles.settingDescription}>{setting.description}</Text>
      ) : null}
      {setting.secret ? (
        <Text style={styles.warning}>
          Secret writes are unavailable because OMP accepts plugin setting values through process
          arguments. Configure this secret directly with OMP.
        </Text>
      ) : setting.type === "boolean" ? (
        <View style={styles.metadataRow}>
          <Switch
            accessibilityLabel={`New value for ${setting.key}`}
            disabled={busy}
            value={draft === true}
            onValueChange={setDraft}
          />
          <Text style={styles.metadataValue}>{draft === true ? "True" : "False"}</Text>
        </View>
      ) : setting.type === "enum" ? (
        <View accessibilityRole="radiogroup" style={styles.scopeRow}>
          {setting.enumValues.map((option) => {
            const selected = draft === option;
            return (
              <Pressable
                key={option}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, disabled: busy }}
                disabled={busy}
                onPress={() => setDraft(option)}
                style={[styles.scopeButton, selected ? styles.scopeButtonActive : null]}
              >
                <Text style={[styles.scopeText, selected ? styles.scopeTextActive : null]}>
                  {option}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : (
        <TextInput
          accessibilityLabel={`New value for ${setting.key}`}
          editable={!busy}
          value={typeof draft === "string" ? draft : ""}
          onChangeText={setDraft}
          placeholder="Enter a new value"
          placeholderTextColor={theme.colors.foregroundMuted}
          keyboardType={setting.type === "number" ? "numeric" : "default"}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
      )}
      {validationMessage && (setting.type !== "boolean" || value === undefined) ? (
        <Text style={styles.error}>{validationMessage}</Text>
      ) : null}
      <View style={styles.actions}>
        {!setting.secret ? (
          <ActionButton
            label="Review change"
            disabled={busy || !candidate?.success}
            primary
            styles={styles}
            onPress={() => {
              if (candidate?.success) onConfirm(candidate.data, setting);
            }}
          />
        ) : null}
        {setting.configured ? (
          <ActionButton
            label="Delete setting"
            disabled={busy}
            danger
            styles={styles}
            onPress={() => onConfirm({ action: "delete", plugin, key: setting.key }, setting)}
          />
        ) : null}
      </View>
    </View>
  );
}

function PluginCard({
  plugin,
  busy,
  inspecting,
  styles,
  onConfirm,
  onInspect,
}: {
  plugin: OmpInstalledPlugin;
  busy: boolean;
  inspecting: boolean;
  styles: PluginManagerStyles;
  onConfirm(input: OmpPluginMutation): void;
  onInspect(plugin: string): void;
}) {
  const scope = plugin.scope === "user" ? "user" : undefined;
  return (
    <View style={styles.pluginCard}>
      <View style={styles.cardHeader}>
        <Text selectable style={styles.cardTitle}>
          {plugin.id}
        </Text>
        <Text style={plugin.enabled ? styles.success : styles.muted}>
          {plugin.enabled ? "Enabled" : "Disabled"}
        </Text>
      </View>
      <View style={styles.metadata}>
        <MetadataRow
          styles={styles}
          label="Source"
          value={plugin.source === "marketplace" ? `Marketplace · ${plugin.scope}` : "npm / linked"}
        />
        <MetadataRow styles={styles} label="Version" value={plugin.version ?? "Unknown"} />
        {plugin.path ? <MetadataRow styles={styles} label="Path" value={plugin.path} /> : null}
        {plugin.description ? (
          <MetadataRow styles={styles} label="Description" value={plugin.description} />
        ) : null}
        {plugin.enabledFeatures.length > 0 ? (
          <MetadataRow styles={styles} label="Features" value={plugin.enabledFeatures.join(", ")} />
        ) : null}
        {plugin.usesDefaultFeatures ? (
          <MetadataRow styles={styles} label="Features" value="Manifest defaults" />
        ) : null}
        {plugin.shadowed ? (
          <Text style={styles.warning}>Shadowed by an enabled project-scoped installation.</Text>
        ) : null}
        {plugin.scope === "project" ? (
          <Text style={styles.warning}>
            Project-scoped actions require OMP to run from that project and are read-only here.
          </Text>
        ) : null}
        {plugin.ambiguous ? (
          <Text style={styles.warning}>
            Multiple installations share this package identity, so lifecycle actions are read-only.
          </Text>
        ) : null}
      </View>
      <View style={styles.actions}>
        <ActionButton
          label={plugin.enabled ? "Disable" : "Enable"}
          disabled={busy || plugin.scope === "project" || plugin.ambiguous}
          styles={styles}
          onPress={() =>
            onConfirm({
              action: plugin.enabled ? "disable" : "enable",
              plugin: plugin.id,
              ...(scope ? { scope } : {}),
            })
          }
        />
        {plugin.configurable && plugin.packageName ? (
          <ActionButton
            label={inspecting ? "Loading settings…" : "Configure settings"}
            disabled={busy || inspecting || plugin.scope === "project" || plugin.ambiguous}
            styles={styles}
            onPress={() => onInspect(plugin.packageName ?? plugin.id)}
          />
        ) : null}
        {plugin.source === "marketplace" ? (
          <ActionButton
            label="Upgrade"
            disabled={busy || plugin.scope === "project" || plugin.ambiguous}
            styles={styles}
            onPress={() =>
              onConfirm({ action: "upgrade", plugin: plugin.id, ...(scope ? { scope } : {}) })
            }
          />
        ) : null}
        <ActionButton
          label="Uninstall"
          disabled={busy || plugin.scope === "project" || plugin.ambiguous}
          danger
          styles={styles}
          onPress={() =>
            onConfirm({ action: "uninstall", plugin: plugin.id, ...(scope ? { scope } : {}) })
          }
        />
      </View>
    </View>
  );
}

export function OmpPluginManagerSection({
  theme,
  compact,
}: {
  theme: PluginSurfaceProps["theme"];
  compact: boolean;
}) {
  const loadPlugins = useRpc(listOmpPlugins);
  const inspectPluginConfig = useRpc(inspectOmpPluginConfig);
  const mutatePlugin = useRpc(mutateOmpPlugin);
  const mutatePluginConfig = useRpc(mutateOmpPluginConfig);
  const queryClient = useQueryClient();
  const styles = usePluginManagerStyles(theme, compact);
  const [source, setSource] = useState("");
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [inspected, setInspected] = useState<OmpPluginConfigState | null>(null);
  const [configEditGenerations, setConfigEditGenerations] = useState<Record<string, number>>({});
  const inspectionGeneration = useRef(0);
  const plugins = useQuery({
    queryKey: PLUGINS_QUERY_KEY,
    queryFn: () => loadPlugins({}),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const mutation = useMutation({
    mutationFn: (input: OmpPluginMutation) => mutatePlugin(input),
    onSuccess: (result) => {
      queryClient.setQueryData(PLUGINS_QUERY_KEY, result.state);
      setNotice({ tone: result.ok ? "success" : "error", text: result.message });
      if (result.ok && confirmation?.kind === "plugin" && confirmation.input.action === "install") {
        setSource("");
      }
      setConfirmation(null);
    },
    onError: () => {
      setNotice({ tone: "error", text: "The plugin operation could not be completed." });
      setConfirmation(null);
    },
  });
  const configInspection = useMutation({
    mutationFn: ({ plugin }: { plugin: string; generation: number }) =>
      inspectPluginConfig({ plugin }),
    onSuccess: (result, request) => {
      if (inspectionGeneration.current === request.generation) setInspected(result);
    },
    onError: (_error, request) => {
      if (inspectionGeneration.current === request.generation) setInspected(null);
    },
  });
  const configMutation = useMutation({
    mutationFn: (input: OmpPluginConfigMutation) => mutatePluginConfig(input),
    onSuccess: (result, input) => {
      if (result.config.available) setInspected(result.config);
      if (result.ok) {
        const identity = `${input.plugin}:${input.key}`;
        setConfigEditGenerations((current) => ({
          ...current,
          [identity]: (current[identity] ?? 0) + 1,
        }));
      }
      setNotice({ tone: result.ok ? "success" : "error", text: result.message });
      setConfirmation(null);
    },
    onError: () => {
      setNotice({ tone: "error", text: "The plugin setting operation could not be completed." });
      setConfirmation(null);
    },
  });
  const busy = mutation.isPending || configMutation.isPending;

  const requestInstall = () => {
    const parsed = OmpPluginInstallSourceSchema.safeParse(source);
    if (!parsed.success) {
      setNotice({
        tone: "error",
        text: "Enter one valid package, marketplace ID, Git source, or local path without options or control characters.",
      });
      return;
    }
    setNotice(null);
    setConfirmation(confirmationFor({ action: "install", source: parsed.data, scope: "user" }));
  };
  const requestMutation = (input: OmpPluginMutation) => {
    setNotice(null);
    setConfirmation(confirmationFor(input));
  };
  const requestConfigMutation = (
    input: OmpPluginConfigMutation,
    setting: OmpPluginConfigSetting,
  ) => {
    setNotice(null);
    setConfirmation(configConfirmationFor(input, setting));
  };
  const inspect = (plugin: string) => {
    inspectionGeneration.current += 1;
    if (inspected?.plugin === plugin) {
      setInspected(null);
      configInspection.reset();
      setConfirmation(null);
      return;
    }
    const generation = inspectionGeneration.current;
    setInspected(null);
    setConfirmation(null);
    configInspection.mutate({ plugin, generation });
  };
  const applyConfirmation = () => {
    if (!confirmation) return;
    if (confirmation.kind === "plugin") mutation.mutate(confirmation.input);
    else configMutation.mutate(confirmation.input);
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>OMP plugins</Text>
          <Text style={styles.muted}>Manage OMP's native plugins, not Paseo plugins.</Text>
        </View>
        <ActionButton
          label={plugins.isFetching ? "Refreshing…" : "Refresh"}
          disabled={plugins.isFetching || busy}
          styles={styles}
          onPress={() => {
            void plugins.refetch();
          }}
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Install a plugin</Text>
        <Text style={styles.muted}>
          Enter one source accepted by OMP, such as a package, name@marketplace, Git URL, or local
          path.
        </Text>
        <TextInput
          accessibilityLabel="OMP plugin source"
          editable={!busy}
          value={source}
          onChangeText={setSource}
          placeholder="name@marketplace or package source"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
        <View style={styles.actions}>
          <ActionButton
            label="Review install"
            disabled={busy || source.length === 0}
            primary
            styles={styles}
            onPress={requestInstall}
          />
        </View>
      </View>

      {confirmation ? (
        <View accessibilityRole="alert" style={styles.confirmation}>
          <Text style={styles.cardTitle}>{confirmation.title}</Text>
          <Text style={styles.warning}>{confirmation.warning}</Text>
          <View style={styles.actions}>
            <ActionButton
              label="Cancel"
              disabled={busy}
              styles={styles}
              onPress={() => setConfirmation(null)}
            />
            <ActionButton
              label={busy ? "Applying…" : "Confirm"}
              disabled={busy}
              primary
              danger={
                confirmation.kind === "plugin"
                  ? confirmation.input.action === "uninstall"
                  : confirmation.input.action === "delete"
              }
              styles={styles}
              onPress={applyConfirmation}
            />
          </View>
        </View>
      ) : null}

      {notice ? (
        <Text
          accessibilityRole="alert"
          style={notice.tone === "success" ? styles.success : styles.error}
        >
          {notice.text}
        </Text>
      ) : null}
      {plugins.isLoading ? <Text style={styles.muted}>Loading OMP plugins…</Text> : null}
      {plugins.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          Could not load OMP plugin state.
        </Text>
      ) : null}
      {plugins.data?.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {plugins.data.error}
        </Text>
      ) : null}
      {plugins.data?.available && plugins.data.plugins.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>No plugins installed</Text>
          <Text style={styles.muted}>
            OMP reported an empty npm and marketplace plugin catalog.
          </Text>
        </View>
      ) : null}
      {plugins.data?.droppedCount ? (
        <Text style={styles.warning}>
          {plugins.data.droppedCount} invalid or excess plugin records were omitted.
        </Text>
      ) : null}

      {plugins.data?.plugins.length ? (
        <View style={styles.pluginGrid}>
          {plugins.data.plugins.map((plugin) => (
            <PluginCard
              key={`${plugin.source}:${plugin.scope ?? "global"}:${plugin.path ?? plugin.id}:${plugin.version ?? "unknown"}`}
              plugin={plugin}
              busy={busy}
              inspecting={
                configInspection.isPending &&
                configInspection.variables?.plugin === plugin.packageName
              }
              styles={styles}
              onConfirm={requestMutation}
              onInspect={inspect}
            />
          ))}
        </View>
      ) : null}

      {configInspection.error || configMutation.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          Could not update OMP plugin settings.
        </Text>
      ) : null}
      {inspected ? (
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>Settings · {inspected.plugin}</Text>
            <ActionButton
              label="Close"
              disabled={busy}
              styles={styles}
              onPress={() => {
                inspectionGeneration.current += 1;
                setInspected(null);
                setConfirmation(null);
              }}
            />
          </View>
          <Text style={styles.muted}>
            Current values and defaults are withheld. New values are write-only and are never
            returned to the app.
          </Text>
          {inspected.error ? <Text style={styles.error}>{inspected.error}</Text> : null}
          {inspected.droppedCount > 0 ? (
            <Text style={styles.warning}>
              {inspected.droppedCount} invalid or excess setting definitions were omitted.
            </Text>
          ) : null}
          {inspected.available && inspected.settings.length === 0 ? (
            <Text style={styles.muted}>This plugin declares no settings.</Text>
          ) : null}
          <View style={styles.settings}>
            {inspected.settings.map((setting) => (
              <ConfigSettingEditor
                key={`${inspected.plugin}:${setting.key}:${configEditGenerations[`${inspected.plugin}:${setting.key}`] ?? 0}`}
                plugin={inspected.plugin}
                setting={setting}
                busy={busy || confirmation !== null}
                theme={theme}
                styles={styles}
                onConfirm={requestConfigMutation}
              />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

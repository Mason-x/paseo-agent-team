import {
  type PluginSurfaceProps,
  type PluginWorkspacePanelProps,
  usePaseo,
  useRpc,
  useWorkspace,
} from "@getpaseo/plugin/client";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import type { TextStyle, ViewStyle } from "react-native";
import { Linking, Pressable, ScrollView, Switch, Text, View } from "react-native";
import { listOmpConfig, type OmpConfig } from "../shared/omp-config";
import {
  categorizeOmpSetting,
  formatOmpSettingLabel,
  listOmpSettings,
  OMP_SETTING_CATEGORIES,
  type OmpScalarValue,
  type OmpSetting,
  type OmpSettingCategory,
  updateOmpSettings,
} from "../shared/omp-settings";
import { type OmpStore, storeLabel } from "../shared/omp-store";
import { getOmpProviderHealth, type OmpProviderHealth } from "../shared/provider-diagnostics";
import {
  documentationForSettingCategory,
  documentationForSettingPath,
  OMP_SETTINGS_GUIDES,
  OMP_SETTINGS_REFERENCE,
  type OmpDocumentationLink,
} from "./omp-doc-links";
import { OmpPluginManagerSection } from "./omp-plugin-manager";
import { OmpStorePicker } from "./omp-store-picker";
import { ompStoreKey } from "./omp-store-state";
import {
  type BinaryHealthSummary,
  loadReadyProviderSnapshot,
  lspTone,
  mcpTone,
  type PathStateSummary,
  processTone,
  refreshProviderDiagnostics,
  rpcUiTone,
  selectKnownOmpProviders,
  summarizeBinaryHealth,
  summarizeLspSupport,
  summarizeMcpDiagnostics,
  summarizeMemoryBackend,
  summarizePathState,
  summarizeProcessDiagnostics,
  summarizeProviderStatus,
  summarizeRpcUiSupport,
} from "./provider-diagnostics-state";

const SETTINGS_QUERY_KEY = ["paseo-omp", "settings"] as const;
const CONFIG_POLL_MS = 30_000;
const HEALTH_QUERY_KEY = ["paseo-omp", "provider-health"] as const;
const PROVIDERS_QUERY_KEY = ["paseo-omp", "provider-snapshot"] as const;

export interface OmpConfigStyles {
  root: ViewStyle;
  pageTitle: TextStyle;
  topTabs: ViewStyle;
  topTab: ViewStyle;
  topTabActive: ViewStyle;
  topTabLabel: TextStyle;
  topTabLabelActive: TextStyle;
  workspace: ViewStyle;
  categoryRail: ViewStyle;
  categoryList: ViewStyle;
  categoryButton: ViewStyle;
  categoryButtonActive: ViewStyle;
  categoryLabel: TextStyle;
  categoryLabelActive: TextStyle;
  categoryContent: ViewStyle;
  search: TextStyle;
  sectionHeader: ViewStyle;
  sectionHeaderRow: ViewStyle;
  sectionTitle: TextStyle;
  source: TextStyle;
  muted: TextStyle;
  error: TextStyle;
  refresh: ViewStyle;
  docsActions: ViewStyle;
  docLink: ViewStyle;
  docLinkPressed: ViewStyle;
  docLinkText: TextStyle;
  refreshLabel: TextStyle;
  card: ViewStyle;
  cardHeader: ViewStyle;
  cardTitle: TextStyle;
  row: ViewStyle;
  rowLabel: TextStyle;
  rowValue: TextStyle;
  setting: ViewStyle;
  settingHeader: ViewStyle;
  settingPath: TextStyle;
  settingDescription: TextStyle;
  settingValue: TextStyle;
  collectionSummary: TextStyle;
  chipList: ViewStyle;
  chip: ViewStyle;
  chipText: TextStyle;
  recordList: ViewStyle;
  recordRow: ViewStyle;
  recordKey: TextStyle;
  recordValue: TextStyle;
  editorActions: ViewStyle;
  editorAction: ViewStyle;
  editorActionPrimary: ViewStyle;
  editorActionText: TextStyle;
  editorActionTextPrimary: TextStyle;
  scalarInput: TextStyle;
  resetAction: TextStyle;
}

function useConfigStyles(theme: PluginSurfaceProps["theme"], compact: boolean): OmpConfigStyles {
  return useMemo(
    () => ({
      root: {
        flex: 1,
        gap: compact ? 10 : 14,
        padding: compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
      },
      pageTitle: {
        color: theme.colors.foreground,
        fontSize: compact ? 22 : 26,
        fontWeight: "700",
      },
      topTabs: {
        flexWrap: "wrap",
        flexDirection: "row",
        alignSelf: "flex-start",
        gap: 4,
        padding: 4,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
      },
      topTab: {
        paddingHorizontal: compact ? 10 : 14,
        paddingVertical: 8,
        borderRadius: 7,
      },
      topTabActive: { backgroundColor: theme.colors.accent },
      topTabLabel: { color: theme.colors.foregroundMuted, fontSize: 13, fontWeight: "600" },
      topTabLabelActive: { color: theme.colors.accentForeground },
      workspace: {
        flexDirection: compact ? "column" : "row",
        alignItems: compact ? "stretch" : "flex-start",
        gap: compact ? 10 : 18,
      },
      categoryRail: {
        width: compact ? "100%" : 220,
        gap: 10,
        padding: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
      },
      categoryList: { gap: 4 },
      categoryButton: { paddingHorizontal: 10, paddingVertical: 9, borderRadius: 7 },
      categoryButtonActive: { backgroundColor: theme.colors.surface2 },
      categoryLabel: { color: theme.colors.foregroundMuted, fontSize: 13, fontWeight: "500" },
      categoryLabelActive: { color: theme.colors.foreground, fontWeight: "700" },
      categoryContent: { flex: compact ? undefined : 1, minWidth: 0, gap: 10 },
      search: {
        color: theme.colors.foreground,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface0,
        paddingHorizontal: 10,
        paddingVertical: 8,
        fontSize: 13,
      },
      sectionHeader: { gap: 4, marginTop: compact ? 2 : 4 },
      sectionHeaderRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 },
      sectionTitle: {
        color: theme.colors.foreground,
        fontSize: compact ? 16 : 18,
        fontWeight: "600",
      },
      source: { color: theme.colors.foregroundMuted, fontSize: 12 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 13 },
      docsActions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
      docLink: {
        paddingHorizontal: 8,
        paddingVertical: 5,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 7,
        backgroundColor: theme.colors.surface1,
      },
      docLinkPressed: { opacity: 0.72 },
      docLinkText: { color: theme.colors.accent, fontSize: 12, fontWeight: "600" },
      refresh: {
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      },
      refreshLabel: { color: theme.colors.foreground, fontSize: 13 },
      cardHeader: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: 8,
      },
      card: {
        gap: 8,
        padding: compact ? 10 : 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
      },
      cardTitle: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" },
      row: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
      rowLabel: { color: theme.colors.foregroundMuted, fontSize: 13 },
      rowValue: { color: theme.colors.foreground, fontSize: 13, flexShrink: 1 },
      setting: {
        gap: 5,
        paddingVertical: 10,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
      },
      settingHeader: {
        flexDirection: "row",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 12,
      },
      settingPath: { color: theme.colors.foregroundMuted, fontSize: 11, flexShrink: 1 },
      settingDescription: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
      settingValue: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" },
      collectionSummary: { color: theme.colors.foregroundMuted, fontSize: 12 },
      chipList: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
      chip: {
        paddingHorizontal: 8,
        paddingVertical: 5,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 999,
        backgroundColor: theme.colors.surface2,
      },
      chipText: { color: theme.colors.foreground, fontSize: 12 },
      recordList: { gap: 6 },
      recordRow: {
        flexDirection: compact ? "column" : "row",
        alignItems: compact ? "flex-start" : "baseline",
        gap: compact ? 2 : 12,
        paddingVertical: 5,
      },
      recordKey: {
        width: compact ? undefined : 150,
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        fontWeight: "600",
      },
      recordValue: { flex: 1, color: theme.colors.foreground, fontSize: 12 },
      editorActions: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: 8,
        padding: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
      },
      editorAction: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
      },
      editorActionPrimary: {
        backgroundColor: theme.colors.accent,
        borderColor: theme.colors.accent,
      },
      editorActionText: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" },
      editorActionTextPrimary: { color: theme.colors.accentForeground },
      scalarInput: {
        minWidth: 180,
        maxWidth: 420,
        color: theme.colors.foreground,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 7,
        backgroundColor: theme.colors.surface0,
        paddingHorizontal: 9,
        paddingVertical: 6,
        fontSize: 13,
      },
      resetAction: { color: theme.colors.accent, fontSize: 12, fontWeight: "600" },
    }),
    [compact, theme],
  );
}

function KeyValueRow({
  styles,
  label,
  value,
  valueColor,
}: {
  styles: OmpConfigStyles;
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, valueColor ? { color: valueColor } : null]}>{value}</Text>
    </View>
  );
}

function SectionCard({
  styles,
  title,
  action,
  children,
}: {
  styles: OmpConfigStyles;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>{title}</Text>
        {action}
      </View>
      {children}
    </View>
  );
}

function DocumentationLink({
  link,
  styles,
  onOpen,
}: {
  link: OmpDocumentationLink;
  styles: OmpConfigStyles;
  onOpen(link: OmpDocumentationLink): void;
}) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={link.accessibilityLabel}
      accessibilityHint="Opens in your browser"
      onPress={() => onOpen(link)}
      style={({ pressed }) => [styles.docLink, pressed ? styles.docLinkPressed : null]}
    >
      <Text style={styles.docLinkText}>{link.label}</Text>
    </Pressable>
  );
}

function ProviderSetupSection({ styles }: { styles: OmpConfigStyles }) {
  return (
    <SectionCard styles={styles} title="OMP Plugin">
      <Text style={styles.muted}>
        Launch settings currently come from the active Paseo provider profile.
      </Text>
      <KeyValueRow
        styles={styles}
        label="Per agent"
        value="Model, mode, thinking, MCP servers, and persistence"
      />
      <KeyValueRow
        styles={styles}
        label="Provider profile"
        value="Command, environment, session directory, RPC timeout, role models, and denied tools"
      />
    </SectionCard>
  );
}

function PluginConfigurationSection({ styles }: { styles: OmpConfigStyles }) {
  return (
    <>
      <SectionCard styles={styles} title="OMP Plugin launch options">
        <Text style={styles.muted}>
          Paseo does not expose the effective providerOptions for active launches through the plugin
          API. Configure these values in the provider profile; this tab documents the supported
          contract without claiming defaults are active.
        </Text>
        <KeyValueRow styles={styles} label="Command" value="Executable and argument prefix" />
        <KeyValueRow
          styles={styles}
          label="Inherited environment"
          value="Daemon variable names copied at OMP spawn time"
        />
        <KeyValueRow
          styles={styles}
          label="Explicit environment"
          value="Stored non-secret overrides"
        />
        <KeyValueRow styles={styles} label="Output redaction" value="None or configured values" />
        <KeyValueRow
          styles={styles}
          label="Runtime parameters"
          value="Session directory, RPC timeout, small, slow, and plan models"
        />
        <KeyValueRow styles={styles} label="Denied tools" value="Native OMP tool restrictions" />
      </SectionCard>
      <Text style={styles.muted}>
        Inherited environment configuration stores names only. Values stay in the daemon environment
        and are resolved only when OMP starts.
      </Text>
    </>
  );
}
function toneColor(theme: PluginSurfaceProps["theme"], tone: BinaryHealthSummary["tone"]): string {
  if (tone === "ok") return theme.colors.statusSuccess;
  if (tone === "warning") return theme.colors.statusWarning;
  if (tone === "danger") return theme.colors.statusDanger;
  return theme.colors.foregroundMuted;
}

function BinarySection({
  theme,
  styles,
  health,
}: {
  theme: PluginSurfaceProps["theme"];
  styles: OmpConfigStyles;
  health: OmpProviderHealth;
}) {
  const summary = summarizeBinaryHealth(health.binary);
  return (
    <SectionCard styles={styles} title="omp binary">
      <KeyValueRow
        styles={styles}
        label="Status"
        value={summary.label}
        valueColor={toneColor(theme, summary.tone)}
      />
      {health.binary.resolvedPath ? (
        <KeyValueRow styles={styles} label="Resolved path" value={health.binary.resolvedPath} />
      ) : null}
      {health.binary.processCleanupFailed ? (
        <KeyValueRow
          styles={styles}
          label="Process cleanup"
          value="Timed-out probe did not confirm exit"
          valueColor={theme.colors.statusDanger}
        />
      ) : null}
    </SectionCard>
  );
}

function CapabilitiesSection({
  theme,
  styles,
  health,
}: {
  theme: PluginSurfaceProps["theme"];
  styles: OmpConfigStyles;
  health: OmpProviderHealth;
}) {
  return (
    <SectionCard styles={styles} title="Runtime compatibility">
      <KeyValueRow
        styles={styles}
        label="rpc-ui protocol"
        value={summarizeRpcUiSupport(health.rpcUi)}
        valueColor={toneColor(theme, rpcUiTone(health.rpcUi))}
      />
      <KeyValueRow
        styles={styles}
        label="LSP tool"
        value={summarizeLspSupport(health.lsp)}
        valueColor={toneColor(theme, lspTone(health.lsp))}
      />
      <KeyValueRow
        styles={styles}
        label="MCP"
        value={summarizeMcpDiagnostics(health.mcp)}
        valueColor={toneColor(theme, mcpTone(health.mcp))}
      />
    </SectionCard>
  );
}

function pathValue(path: string, state: PathStateSummary): string {
  return `${path} (${state.label})`;
}

function StorageSection({
  theme,
  styles,
  health,
}: {
  theme: PluginSurfaceProps["theme"];
  styles: OmpConfigStyles;
  health: OmpProviderHealth;
}) {
  const agentRoot = summarizePathState(health.roots.agentRootState);
  const configPath = summarizePathState(health.roots.configState);
  const sessionRoot = summarizePathState(health.roots.sessionRootState);
  const agentDb = summarizePathState(health.databases.agentDbState);
  const historyDb = summarizePathState(health.databases.historyDbState);
  return (
    <SectionCard styles={styles} title="Storage">
      <KeyValueRow
        styles={styles}
        label="Agent root"
        value={pathValue(health.roots.agentRoot, agentRoot)}
        valueColor={toneColor(theme, agentRoot.tone)}
      />
      <KeyValueRow
        styles={styles}
        label="Config file"
        value={pathValue(health.roots.configPath, configPath)}
        valueColor={toneColor(theme, configPath.tone)}
      />
      <KeyValueRow
        styles={styles}
        label="Session root"
        value={pathValue(health.roots.sessionRoot, sessionRoot)}
        valueColor={toneColor(theme, sessionRoot.tone)}
      />
      <KeyValueRow
        styles={styles}
        label="agent.db"
        value={agentDb.label}
        valueColor={toneColor(theme, agentDb.tone)}
      />
      <KeyValueRow
        styles={styles}
        label="history.db"
        value={historyDb.label}
        valueColor={toneColor(theme, historyDb.tone)}
      />
      <KeyValueRow styles={styles} label="Memory backend" value={summarizeMemoryBackend(health)} />
    </SectionCard>
  );
}

function ProcessSection({
  theme,
  styles,
  health,
}: {
  theme: PluginSurfaceProps["theme"];
  styles: OmpConfigStyles;
  health: OmpProviderHealth;
}) {
  return (
    <SectionCard styles={styles} title="Hub metadata">
      <KeyValueRow
        styles={styles}
        label="OMP Hub"
        value={summarizeProcessDiagnostics(health.process)}
        valueColor={toneColor(theme, processTone(health.process))}
      />
    </SectionCard>
  );
}

function ProviderHealthSection({
  theme,
  styles,
  cwd,
  store,
}: {
  theme: PluginSurfaceProps["theme"];
  styles: OmpConfigStyles;
  cwd?: string;
  store?: OmpStore;
}) {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const loadHealth = useRpc(getOmpProviderHealth);
  const health = useQuery({
    queryKey: [...HEALTH_QUERY_KEY, ompStoreKey(store), cwd ?? "global"],
    queryFn: () => loadHealth({ store, ...(cwd ? { cwd } : {}) }),
  });
  const providers = useQuery({
    queryKey: PROVIDERS_QUERY_KEY,
    queryFn: () => loadReadyProviderSnapshot(paseo.providers),
  });
  const refresh = useMutation({
    mutationFn: async () => {
      const result = await refreshProviderDiagnostics({
        providers: paseo.providers,
        providerIds: [
          ...selectKnownOmpProviders(providers.data?.entries ?? []).map((provider) => provider.id),
          ...(store?.profile ? [`omp-plugin-${store.profile}`] : []),
        ],
        loadForcedHealth: () => loadHealth({ store, force: true, ...(cwd ? { cwd } : {}) }),
        cacheHealth: (value) =>
          queryClient.setQueryData(
            [...HEALTH_QUERY_KEY, ompStoreKey(store), cwd ?? "global"],
            value,
          ),
        cacheProviders: (value) => queryClient.setQueryData(PROVIDERS_QUERY_KEY, value),
      });
      if (result.failed) throw new Error("Could not fully refresh OMP provider health.");
    },
  });
  const isRefreshing = refresh.isPending || health.isFetching || providers.isFetching;
  const knownProviders = providers.data ? selectKnownOmpProviders(providers.data.entries) : [];

  return (
    <>
      <View style={styles.sectionHeader}>
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>Provider health</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh OMP provider health"
            style={styles.refresh}
            disabled={isRefreshing}
            onPress={() => refresh.mutate()}
          >
            <Icon name="RefreshCw" size={14} color={theme.colors.foreground} />
            <Text style={styles.refreshLabel}>{isRefreshing ? "Refreshing…" : "Refresh"}</Text>
          </Pressable>
        </View>
      </View>
      <Text style={styles.muted}>
        Binary probes run from {cwd ? "this workspace" : "the daemon working directory"}.
        Configuration, storage, MCP, and databases use {storeLabel(store)}. Hub metadata remains
        shared across profiles.
      </Text>

      {health.isLoading ? <Text style={styles.muted}>Checking the omp installation…</Text> : null}
      {health.error ? (
        <Text style={styles.error}>Could not check the omp installation. Try refreshing.</Text>
      ) : null}
      {refresh.error ? (
        <Text style={styles.error}>Could not fully refresh provider health. Try again.</Text>
      ) : null}
      {health.data ? <BinarySection theme={theme} styles={styles} health={health.data} /> : null}
      {health.data ? (
        <CapabilitiesSection theme={theme} styles={styles} health={health.data} />
      ) : null}
      {health.data ? <StorageSection theme={theme} styles={styles} health={health.data} /> : null}
      {health.data ? <ProcessSection theme={theme} styles={styles} health={health.data} /> : null}

      {providers.isLoading ? <Text style={styles.muted}>Loading provider status…</Text> : null}
      {providers.error ? (
        <Text style={styles.error}>Could not load provider status. Try refreshing.</Text>
      ) : null}
      {providers.data && knownProviders.length === 0 ? (
        <Text style={styles.muted}>No OMP provider entries reported yet.</Text>
      ) : null}
      {knownProviders.length > 0 ? (
        <SectionCard styles={styles} title="Registered providers">
          {knownProviders.map((provider) => {
            const status = summarizeProviderStatus(provider);
            return (
              <KeyValueRow
                key={provider.id}
                styles={styles}
                label={provider.label}
                value={status.label}
                valueColor={toneColor(theme, status.tone)}
              />
            );
          })}
        </SectionCard>
      ) : null}
    </>
  );
}

const CATEGORY_LABELS: Record<OmpSettingCategory, string> = {
  appearance: "Appearance",
  model: "Model",
  interaction: "Interaction",
  context: "Context",
  memory: "Memory",
  files: "Files",
  shell: "Shell",
  tools: "Tools",
  tasks: "Tasks",
  providers: "Providers",
  general: "General",
};

const CONFIG_CATEGORIES = OMP_SETTING_CATEGORIES.map((id) => ({ id, label: CATEGORY_LABELS[id] }));

function fallbackSettingsFromConfig(config: OmpConfig | null | undefined): OmpSetting[] {
  if (!config) return [];
  const settings: OmpSetting[] = [];
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      settings.push({ path, type: "array", value, description: "" });
      return;
    }
    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) {
        settings.push({ path, type: "record", value, description: "" });
        return;
      }
      for (const [key, nested] of entries) visit(nested, path ? `${path}.${key}` : key);
      return;
    }
    if (typeof value === "boolean") {
      settings.push({ path, type: "boolean", value, description: "" });
    } else if (typeof value === "number") {
      settings.push({ path, type: "number", value, description: "" });
    } else if (typeof value === "string") {
      settings.push({ path, type: "string", value, description: "" });
    }
  };
  visit(config, "");
  return settings;
}

type SurfaceView = "overview" | "plugin" | "plugins" | "configuration" | "diagnostics";
const SURFACE_VIEWS: readonly { id: SurfaceView; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "plugin", label: "Plugin" },
  { id: "plugins", label: "OMP plugins" },
  { id: "configuration", label: "Configuration" },
  { id: "diagnostics", label: "Diagnostics" },
];

function formatScalarValue(value: unknown): string {
  if (value === undefined || value === null) return "Not set";
  if (typeof value === "boolean") return value ? "Enabled" : "Disabled";
  if (typeof value === "string" || typeof value === "number") return String(value);
  const serialized = JSON.stringify(value);
  if (!serialized) return "Not set";
  return serialized.length > 240 ? `${serialized.slice(0, 237)}…` : serialized;
}

function StructuredSettingValue({
  setting,
  styles,
}: {
  setting: OmpSetting;
  styles: OmpConfigStyles;
}) {
  if (setting.redacted) {
    return (
      <Text style={styles.settingValue}>
        {setting.configured === true
          ? "Configured (hidden)"
          : setting.configured === false
            ? "Not set"
            : "Hidden"}
      </Text>
    );
  }
  const value = setting.value;
  if (!Array.isArray(value) && (value === null || typeof value !== "object")) {
    return <Text style={styles.settingValue}>{formatScalarValue(value)}</Text>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <Text style={styles.muted}>None</Text>;
    const allScalar = value.every(
      (item) => item === null || ["boolean", "number", "string"].includes(typeof item),
    );
    const occurrences = new Map<string, number>();
    const items = value.map((item) => {
      const text = formatScalarValue(item);
      const occurrence = (occurrences.get(text) ?? 0) + 1;
      occurrences.set(text, occurrence);
      return { item, key: `${text}-${occurrence}`, text };
    });
    return (
      <View style={styles.recordList}>
        <Text style={styles.collectionSummary}>{value.length} items</Text>
        {allScalar ? (
          <View style={styles.chipList}>
            {items.map(({ key, text }) => (
              <View key={key} style={styles.chip}>
                <Text style={styles.chipText}>{text}</Text>
              </View>
            ))}
          </View>
        ) : (
          items.map(({ item, key }, position) => (
            <View key={key} style={styles.recordRow}>
              <Text style={styles.recordKey}>{position + 1}</Text>
              <Text selectable style={styles.recordValue}>
                {formatScalarValue(item)}
              </Text>
            </View>
          ))
        )}
      </View>
    );
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return <Text style={styles.muted}>None</Text>;
  return (
    <View style={styles.recordList}>
      <Text style={styles.collectionSummary}>{entries.length} entries</Text>
      {entries.map(([key, item]) => (
        <View key={key} style={styles.recordRow}>
          <Text selectable style={styles.recordKey}>
            {key}
          </Text>
          <Text selectable style={styles.recordValue}>
            {formatScalarValue(item)}
          </Text>
        </View>
      ))}
    </View>
  );
}

type SettingDraft = { operation: "set"; value: string | boolean } | { operation: "reset" };

function EditableScalarValue({
  setting,
  draft,
  disabled,
  resetLabel,
  showReset,
  styles,
  onSet,
  onReset,
}: {
  setting: OmpSetting;
  draft: SettingDraft | undefined;
  disabled: boolean;
  resetLabel: string;
  showReset: boolean;
  styles: OmpConfigStyles;
  onSet(value: string | boolean): void;
  onReset(): void;
}) {
  const value = draft?.operation === "set" ? draft.value : setting.value;
  return (
    <View style={styles.recordList}>
      {draft?.operation === "reset" ? (
        <Text style={styles.muted}>{resetLabel} when changes are applied</Text>
      ) : setting.type === "boolean" ? (
        <Switch
          accessibilityLabel={`Toggle ${formatOmpSettingLabel(setting.path)}`}
          disabled={disabled}
          value={value === true}
          onValueChange={onSet}
        />
      ) : (
        <TextInput
          accessibilityLabel={`Edit ${formatOmpSettingLabel(setting.path)}`}
          editable={!disabled}
          keyboardType={setting.type === "number" ? "numeric" : "default"}
          value={value === undefined ? "" : String(value)}
          onChangeText={onSet}
          style={styles.scalarInput}
        />
      )}
      {showReset ? (
        <Pressable accessibilityRole="button" disabled={disabled} onPress={onReset}>
          <Text style={styles.resetAction}>{resetLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ConfigurationCategory({
  category,
  styles,
  settings,
  drafts,
  disabled,
  workspaceScoped,
  onDraft,
  onOpenDocumentation,
}: {
  category: { id: OmpSettingCategory; label: string };
  styles: OmpConfigStyles;
  settings: readonly OmpSetting[];
  drafts: Readonly<Record<string, SettingDraft>>;
  disabled: boolean;
  workspaceScoped: boolean;
  onDraft(path: string, draft: SettingDraft): void;
  onOpenDocumentation(link: OmpDocumentationLink): void;
}) {
  const categoryDocumentation = documentationForSettingCategory(category.id);
  return (
    <SectionCard
      styles={styles}
      title={`${category.label} · ${settings.length}`}
      action={
        categoryDocumentation ? (
          <DocumentationLink
            link={categoryDocumentation}
            styles={styles}
            onOpen={onOpenDocumentation}
          />
        ) : undefined
      }
    >
      {settings.map((setting) => {
        const complex =
          Array.isArray(setting.value) ||
          (setting.value !== null && typeof setting.value === "object");
        const editable =
          !setting.redacted && ["boolean", "number", "string", "enum"].includes(setting.type);
        const settingDocumentation = documentationForSettingPath(setting.path);
        return (
          <View key={setting.path} style={styles.setting}>
            <View style={styles.settingHeader}>
              <Text style={styles.cardTitle}>{formatOmpSettingLabel(setting.path)}</Text>
              {setting.workspaceOverride ? (
                <Text style={styles.source}>Workspace override</Text>
              ) : null}
              {!complex && !editable ? (
                <StructuredSettingValue setting={setting} styles={styles} />
              ) : null}
            </View>
            <Text selectable style={styles.settingPath}>
              {setting.path} · {setting.type}
            </Text>
            {settingDocumentation ? (
              <View style={styles.docsActions}>
                <DocumentationLink
                  link={settingDocumentation}
                  styles={styles}
                  onOpen={onOpenDocumentation}
                />
              </View>
            ) : null}
            {editable ? (
              <EditableScalarValue
                setting={setting}
                draft={drafts[setting.path]}
                disabled={disabled}
                resetLabel={workspaceScoped ? "Remove workspace override" : "Reset to default"}
                showReset={!workspaceScoped || setting.workspaceOverride === true}
                styles={styles}
                onSet={(value) => onDraft(setting.path, { operation: "set", value })}
                onReset={() => onDraft(setting.path, { operation: "reset" })}
              />
            ) : complex ? (
              <StructuredSettingValue setting={setting} styles={styles} />
            ) : null}
            {setting.description ? (
              <Text style={styles.settingDescription}>{setting.description}</Text>
            ) : null}
          </View>
        );
      })}
    </SectionCard>
  );
}

function SurfaceTabs({
  styles,
  selected,
  onSelect,
}: {
  styles: OmpConfigStyles;
  selected: SurfaceView;
  onSelect: (view: SurfaceView) => void;
}) {
  return (
    <View accessibilityRole="tablist" style={styles.topTabs}>
      {SURFACE_VIEWS.map((view) => {
        const active = selected === view.id;
        return (
          <Pressable
            key={view.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onSelect(view.id)}
            style={[styles.topTab, active ? styles.topTabActive : null]}
          >
            <Text style={[styles.topTabLabel, active ? styles.topTabLabelActive : null]}>
              {view.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
function OmpConfigContent({
  theme,
  layout,
  cwd,
  store,
  onStoreChange,
}: PluginSurfaceProps & {
  cwd?: string;
  store?: OmpStore;
  onStoreChange(store: OmpStore | undefined): void;
}) {
  const loadConfig = useRpc(listOmpConfig);
  const loadSettings = useRpc(listOmpSettings);
  const updateSettings = useRpc(updateOmpSettings);
  const queryClient = useQueryClient();
  const context = { store, ...(cwd ? { cwd } : {}) };
  const pendingMutations = useIsMutating({ mutationKey: ["paseo-omp"] });
  const configQuery = useQuery({
    queryKey: ["paseo-omp", "config", ompStoreKey(store), cwd ?? "global"],
    queryFn: () => loadConfig(context),
    refetchInterval: CONFIG_POLL_MS,
  });
  const settingsQueryKey = [...SETTINGS_QUERY_KEY, ompStoreKey(store), cwd ?? "global"];
  const settingsQuery = useQuery({
    queryKey: settingsQueryKey,
    queryFn: () => loadSettings(context),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [view, setView] = useState<SurfaceView>("overview");
  const [activeCategory, setActiveCategory] = useState<OmpSettingCategory>("appearance");
  const [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState<Record<string, SettingDraft>>({});
  const [documentationError, setDocumentationError] = useState<string | null>(null);
  const styles = useConfigStyles(theme, layout.compact);
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const catalog = useMemo(() => {
    const sourceSettings = settingsQuery.data?.available
      ? settingsQuery.data.settings
      : fallbackSettingsFromConfig(configQuery.data?.config);
    const matching = sourceSettings.filter((setting) => {
      if (!normalizedSearch) return true;
      return `${setting.path}\n${setting.description}`
        .toLocaleLowerCase()
        .includes(normalizedSearch);
    });
    const byCategory = new Map<OmpSettingCategory, OmpSetting[]>();
    for (const setting of matching) {
      const category = categorizeOmpSetting(setting.path);
      const group = byCategory.get(category);
      if (group) group.push(setting);
      else byCategory.set(category, [setting]);
    }
    return { sourceSettings, matching, byCategory };
  }, [configQuery.data?.config, normalizedSearch, settingsQuery.data]);
  const visibleCategories = CONFIG_CATEGORIES.filter(
    (category) => (catalog.byCategory.get(category.id)?.length ?? 0) > 0,
  );
  const selectedCategory =
    visibleCategories.find((category) => category.id === activeCategory) ?? visibleCategories[0];
  const openDocumentation = useCallback(async (link: OmpDocumentationLink) => {
    setDocumentationError(null);
    try {
      await Linking.openURL(link.url);
    } catch {
      setDocumentationError(`Could not open ${link.label.toLocaleLowerCase()}.`);
    }
  }, []);

  const save = useMutation({
    mutationKey: ["paseo-omp", "settings", ompStoreKey(store)],
    mutationFn: async () => {
      const revision = settingsQuery.data?.revision;
      if (!revision) throw new Error("OMP settings cannot be edited without a current revision.");
      const byPath = new Map(catalog.sourceSettings.map((setting) => [setting.path, setting]));
      const changes = Object.entries(drafts).map(([path, draft]) => {
        if (draft.operation === "reset") return { operation: "reset" as const, path };
        const setting = byPath.get(path);
        if (!setting) throw new Error(`Setting ${path} is no longer available.`);
        let value: OmpScalarValue = draft.value;
        if (setting.type === "number") {
          const raw = String(draft.value).trim();
          if (!raw) throw new Error(`${path} requires a number.`);
          const parsed = Number(raw);
          if (!Number.isFinite(parsed)) throw new Error(`${path} requires a finite number.`);
          value = parsed;
        }
        return { operation: "set" as const, path, value };
      });
      return updateSettings({ ...context, revision, changes });
    },
    onSuccess: (result) => {
      queryClient.setQueryData(settingsQueryKey, result.catalog);
      void queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ["paseo-omp", "config"] });
      if (
        !result.conflict &&
        !result.failed &&
        result.appliedPaths.length === Object.keys(drafts).length
      ) {
        setDrafts({});
      } else if (result.appliedPaths.length > 0) {
        setDrafts((current) => {
          const next = { ...current };
          for (const path of result.appliedPaths) delete next[path];
          return next;
        });
      }
    },
  });
  const draftCount = Object.keys(drafts).length;
  const workspaceOverrideCount = catalog.sourceSettings.filter(
    (setting) => setting.workspaceOverride,
  ).length;
  const displayedConfigPath = settingsQuery.data?.available
    ? settingsQuery.data.path
    : configQuery.data?.path;

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <Text style={styles.pageTitle}>{cwd ? "Workspace OMP" : "OMP"}</Text>
      {cwd ? (
        <Text selectable style={styles.muted}>
          Project-scoped view · {cwd}
        </Text>
      ) : null}
      <OmpStorePicker
        theme={theme}
        store={store}
        onChange={onStoreChange}
        disabled={pendingMutations > 0}
      />
      <Text style={styles.muted}>
        Switching stores clears unapplied edits and pending confirmations.
      </Text>
      <SurfaceTabs styles={styles} selected={view} onSelect={setView} />

      {view === "overview" ? (
        <>
          <ProviderSetupSection styles={styles} />
          {configQuery.isLoading ? (
            <Text style={styles.muted}>Loading the native configuration…</Text>
          ) : configQuery.error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              Could not read the native OMP configuration.
            </Text>
          ) : (
            <SectionCard
              styles={styles}
              title={cwd ? "Workspace configuration" : "Native configuration"}
            >
              <KeyValueRow
                styles={styles}
                label="Source"
                value={displayedConfigPath ?? "Source unavailable"}
              />
              {cwd ? (
                <>
                  <KeyValueRow styles={styles} label="Scope" value="Workspace / project" />
                  <KeyValueRow
                    styles={styles}
                    label="Overrides"
                    value={`${workspaceOverrideCount} project-specific settings`}
                  />
                  <Text style={styles.muted}>
                    Settings without a workspace override inherit their effective global or default
                    value.
                  </Text>
                </>
              ) : null}
              <KeyValueRow
                styles={styles}
                label="Status"
                value={configQuery.data?.available ? "Available" : "Unavailable"}
              />
              <KeyValueRow
                styles={styles}
                label="Settings discovered"
                value={String(catalog.sourceSettings.length)}
              />
            </SectionCard>
          )}
        </>
      ) : null}

      {view === "plugin" ? <PluginConfigurationSection styles={styles} /> : null}

      {view === "plugins" ? (
        <OmpPluginManagerSection theme={theme} compact={layout.compact} cwd={cwd} store={store} />
      ) : null}

      {view === "diagnostics" ? (
        <ProviderHealthSection theme={theme} styles={styles} cwd={cwd} store={store} />
      ) : null}

      {view === "configuration" ? (
        <>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionTitle}>Configuration</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Refresh OMP configuration"
                style={styles.refresh}
                disabled={configQuery.isFetching || settingsQuery.isFetching}
                onPress={() => {
                  void Promise.all([configQuery.refetch(), settingsQuery.refetch()]);
                }}
              >
                <Icon name="RefreshCw" size={14} color={theme.colors.foreground} />
                <Text style={styles.refreshLabel}>
                  {configQuery.isFetching || settingsQuery.isFetching ? "Refreshing…" : "Refresh"}
                </Text>
              </Pressable>
            </View>
            <View style={styles.docsActions}>
              <DocumentationLink
                link={OMP_SETTINGS_REFERENCE}
                styles={styles}
                onOpen={openDocumentation}
              />
              {OMP_SETTINGS_GUIDES.map((link) => (
                <DocumentationLink
                  key={link.url}
                  link={link}
                  styles={styles}
                  onOpen={openDocumentation}
                />
              ))}
            </View>
            {displayedConfigPath ? (
              <Text style={styles.source}>{`Source: ${displayedConfigPath}`}</Text>
            ) : (
              <Text style={styles.source}>Source unavailable</Text>
            )}
            {cwd ? (
              <Text style={styles.muted}>
                {workspaceOverrideCount} project-specific overrides. All other effective values
                inherit global configuration or OMP defaults. Applying a change creates or updates
                the override in .omp/config.yml; removing an override restores inheritance.
              </Text>
            ) : null}
          </View>
          {documentationError ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {documentationError}
            </Text>
          ) : null}

          {draftCount > 0 ? (
            <View style={styles.editorActions}>
              <Text style={styles.muted}>{draftCount} unsaved changes</Text>
              <Pressable
                accessibilityRole="button"
                disabled={save.isPending}
                onPress={() => setDrafts({})}
                style={styles.editorAction}
              >
                <Text style={styles.editorActionText}>Discard</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={save.isPending}
                onPress={() => save.mutate()}
                style={[styles.editorAction, styles.editorActionPrimary]}
              >
                <Text style={[styles.editorActionText, styles.editorActionTextPrimary]}>
                  {save.isPending ? "Applying…" : "Apply changes"}
                </Text>
              </Pressable>
            </View>
          ) : null}
          {save.error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {save.error instanceof Error ? save.error.message : "Could not apply OMP settings."}
            </Text>
          ) : null}
          {save.data?.conflict ? (
            <Text accessibilityRole="alert" style={styles.error}>
              OMP configuration changed outside Paseo. Review the refreshed values and apply again.
            </Text>
          ) : null}
          {save.data?.failed ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {save.data.failed.path}: {save.data.failed.message}
            </Text>
          ) : null}

          {settingsQuery.isLoading ? (
            <Text style={styles.muted}>Loading the OMP settings catalog…</Text>
          ) : null}
          {settingsQuery.error || settingsQuery.data?.error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              OMP settings metadata is unavailable. Showing the safe values read from the config
              file when available.
            </Text>
          ) : null}
          {settingsQuery.data?.droppedCount ? (
            <Text style={styles.muted}>
              {settingsQuery.data.droppedCount} settings use unsupported metadata types and are not
              shown.
            </Text>
          ) : null}
          {!settingsQuery.isLoading && catalog.sourceSettings.length === 0 ? (
            <Text style={styles.muted}>OMP reported no readable settings.</Text>
          ) : null}

          {catalog.sourceSettings.length > 0 ? (
            <View style={styles.workspace}>
              <View style={styles.categoryRail}>
                <TextInput
                  accessibilityLabel="Search OMP settings"
                  placeholder="Search settings"
                  placeholderTextColor={theme.colors.foregroundMuted}
                  value={search}
                  onChangeText={setSearch}
                  style={styles.search}
                />
                <Text style={styles.source}>
                  {catalog.matching.length} of {catalog.sourceSettings.length} settings
                </Text>
                <View style={styles.categoryList}>
                  {visibleCategories.map((category) => {
                    const active = selectedCategory?.id === category.id;
                    const count = catalog.byCategory.get(category.id)?.length ?? 0;
                    return (
                      <Pressable
                        key={category.id}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        onPress={() => setActiveCategory(category.id)}
                        style={[styles.categoryButton, active ? styles.categoryButtonActive : null]}
                      >
                        <Text
                          style={[styles.categoryLabel, active ? styles.categoryLabelActive : null]}
                        >
                          {category.label} · {count}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
              <View style={styles.categoryContent}>
                {selectedCategory ? (
                  <ConfigurationCategory
                    category={selectedCategory}
                    styles={styles}
                    settings={catalog.byCategory.get(selectedCategory.id) ?? []}
                    drafts={drafts}
                    disabled={!settingsQuery.data?.revision || save.isPending}
                    workspaceScoped={cwd !== undefined}
                    onDraft={(path, draft) =>
                      setDrafts((current) => ({ ...current, [path]: draft }))
                    }
                    onOpenDocumentation={openDocumentation}
                  />
                ) : (
                  <Text style={styles.muted}>No settings match this search.</Text>
                )}
              </View>
            </View>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

function OmpStoreContent(props: PluginSurfaceProps & { cwd?: string }) {
  const [store, setStore] = useState<OmpStore>();
  // Remount every editor when its target changes: drafts, confirmations, and mutation notices
  // belong to one store/workspace and must never be applied to the next selection.
  return (
    <OmpConfigContent
      key={`${ompStoreKey(store)}:${props.cwd ?? "global"}`}
      {...props}
      store={store}
      onStoreChange={setStore}
    />
  );
}

export function OmpConfigSurface(props: PluginSurfaceProps) {
  return <OmpStoreContent {...props} />;
}

export function OmpWorkspacePanel(props: PluginWorkspacePanelProps) {
  const cwd = useWorkspace(props.workspaceId, (workspace) => workspace.directory);
  if (!cwd) {
    return (
      <View
        style={{
          flex: 1,
          padding: props.layout.compact ? 16 : 24,
          backgroundColor: props.theme.colors.surface0,
        }}
      >
        <Text style={{ color: props.theme.colors.foregroundMuted }}>
          Loading workspace OMP settings…
        </Text>
      </View>
    );
  }
  return <OmpStoreContent {...props} cwd={cwd} />;
}

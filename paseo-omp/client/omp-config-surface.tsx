import { type PluginSurfaceProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import type { TextStyle, ViewStyle } from "react-native";
import { Pressable, ScrollView, Text, View } from "react-native";
import { listOmpConfig, type OmpConfig } from "../shared/omp-config";
import { getOmpProviderHealth, type OmpProviderHealth } from "../shared/provider-diagnostics";
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
  refreshLabel: TextStyle;
  card: ViewStyle;
  cardTitle: TextStyle;
  row: ViewStyle;
  rowLabel: TextStyle;
  rowValue: TextStyle;
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
        alignItems: "flex-start",
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
      categoryContent: { flex: 1, minWidth: 0, gap: 10 },
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
      sectionHeaderRow: { flexDirection: "row", alignItems: "center", gap: 10 },
      sectionTitle: {
        color: theme.colors.foreground,
        fontSize: compact ? 16 : 18,
        fontWeight: "600",
      },
      source: { color: theme.colors.foregroundMuted, fontSize: 12 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 13 },
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
    }),
    [compact, theme],
  );
}

function boolLabel(value: boolean | undefined): string | undefined {
  return value === undefined ? undefined : value ? "Yes" : "No";
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
  children,
}: {
  styles: OmpConfigStyles;
  title: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {children}
    </View>
  );
}

function ModelRolesSection({ styles, config }: { styles: OmpConfigStyles; config: OmpConfig }) {
  const roles = Object.entries(config.modelRoles ?? {});
  if (roles.length === 0) return null;
  return (
    <SectionCard styles={styles} title="Model roles">
      {roles.map(([role, model]) => (
        <KeyValueRow key={role} styles={styles} label={role} value={model} />
      ))}
    </SectionCard>
  );
}

function EnabledModelsSection({ styles, config }: { styles: OmpConfigStyles; config: OmpConfig }) {
  if (!config.enabledModels || config.enabledModels.length === 0) return null;
  return (
    <SectionCard styles={styles} title="Enabled models">
      {config.enabledModels.map((model) => (
        <Text key={model} style={styles.rowValue}>
          {model}
        </Text>
      ))}
    </SectionCard>
  );
}

function ProvidersSection({ styles, config }: { styles: OmpConfigStyles; config: OmpConfig }) {
  const hasOrder = !!config.modelProviderOrder?.length;
  const hasDisabled = !!config.disabledProviders?.length;
  if (!hasOrder && !hasDisabled) return null;
  return (
    <SectionCard styles={styles} title="Providers">
      {hasOrder ? (
        <KeyValueRow
          styles={styles}
          label="Order"
          value={(config.modelProviderOrder ?? []).join(" -> ")}
        />
      ) : null}
      {hasDisabled ? (
        <KeyValueRow
          styles={styles}
          label="Disabled"
          value={(config.disabledProviders ?? []).join(", ")}
        />
      ) : null}
    </SectionCard>
  );
}

function RetrySection({ styles, config }: { styles: OmpConfigStyles; config: OmpConfig }) {
  const retry = config.retry;
  if (!retry) return null;
  const chains = Object.entries(retry.fallbackChains ?? {});
  return (
    <SectionCard styles={styles} title="Retry and fallback">
      {retry.enabled !== undefined ? (
        <KeyValueRow styles={styles} label="Enabled" value={boolLabel(retry.enabled) ?? ""} />
      ) : null}
      {retry.maxRetries !== undefined ? (
        <KeyValueRow styles={styles} label="Max retries" value={String(retry.maxRetries)} />
      ) : null}
      {retry.modelFallback !== undefined ? (
        <KeyValueRow
          styles={styles}
          label="Model fallback"
          value={boolLabel(retry.modelFallback) ?? ""}
        />
      ) : null}
      {retry.usageAwareFallback !== undefined ? (
        <KeyValueRow
          styles={styles}
          label="Usage-aware fallback"
          value={boolLabel(retry.usageAwareFallback) ?? ""}
        />
      ) : null}
      {retry.usageReservePct !== undefined ? (
        <KeyValueRow styles={styles} label="Usage reserve" value={`${retry.usageReservePct}%`} />
      ) : null}
      {retry.usageReservePolicy !== undefined ? (
        <KeyValueRow
          styles={styles}
          label="Usage reserve policy"
          value={retry.usageReservePolicy}
        />
      ) : null}
      {retry.fallbackRevertPolicy !== undefined ? (
        <KeyValueRow
          styles={styles}
          label="Fallback revert policy"
          value={retry.fallbackRevertPolicy}
        />
      ) : null}
      {retry.waitForUsageReset !== undefined ? (
        <KeyValueRow
          styles={styles}
          label="Wait for usage reset"
          value={boolLabel(retry.waitForUsageReset) ?? ""}
        />
      ) : null}
      {retry.baseDelayMs !== undefined ? (
        <KeyValueRow styles={styles} label="Base delay" value={`${retry.baseDelayMs}ms`} />
      ) : null}
      {retry.maxDelayMs !== undefined ? (
        <KeyValueRow styles={styles} label="Max delay" value={`${retry.maxDelayMs}ms`} />
      ) : null}
      {chains.length > 0 ? (
        <View style={{ gap: 4 }}>
          <Text style={styles.rowLabel}>Fallback chains</Text>
          {chains.map(([role, chain]) => (
            <KeyValueRow key={role} styles={styles} label={role} value={chain.join(" -> ")} />
          ))}
        </View>
      ) : null}
    </SectionCard>
  );
}

function MemorySection({ styles, config }: { styles: OmpConfigStyles; config: OmpConfig }) {
  const backend = config.memory?.backend;
  if (!backend) return null;
  return (
    <SectionCard styles={styles} title="Memory">
      <KeyValueRow styles={styles} label="Backend" value={backend} />
    </SectionCard>
  );
}

function GithubSection({ styles, config }: { styles: OmpConfigStyles; config: OmpConfig }) {
  const github = config.github;
  if (!github) return null;
  const cacheEnabled = github.cache?.enabled;
  const cacheSoftTtlSec = github.cache?.softTtlSec;
  const cacheHardTtlSec = github.cache?.hardTtlSec;
  return (
    <SectionCard styles={styles} title="GitHub integration">
      {github.enabled !== undefined ? (
        <KeyValueRow styles={styles} label="Enabled" value={boolLabel(github.enabled) ?? ""} />
      ) : null}
      {cacheEnabled !== undefined ? (
        <KeyValueRow styles={styles} label="Cache enabled" value={boolLabel(cacheEnabled) ?? ""} />
      ) : null}
      {cacheSoftTtlSec !== undefined ? (
        <KeyValueRow styles={styles} label="Cache soft TTL" value={`${cacheSoftTtlSec}s`} />
      ) : null}
      {cacheHardTtlSec !== undefined ? (
        <KeyValueRow styles={styles} label="Cache hard TTL" value={`${cacheHardTtlSec}s`} />
      ) : null}
    </SectionCard>
  );
}

function PreferencesSection({ styles, config }: { styles: OmpConfigStyles; config: OmpConfig }) {
  const themeDark = config.theme?.dark;
  const themeLight = config.theme?.light;
  const { symbolPreset, defaultThinkingLevel } = config;
  const hasAny =
    themeDark !== undefined ||
    themeLight !== undefined ||
    symbolPreset !== undefined ||
    defaultThinkingLevel !== undefined;
  if (!hasAny) return null;
  return (
    <SectionCard styles={styles} title="Theme and preferences">
      {themeDark !== undefined ? (
        <KeyValueRow styles={styles} label="Dark theme" value={themeDark} />
      ) : null}
      {themeLight !== undefined ? (
        <KeyValueRow styles={styles} label="Light theme" value={themeLight} />
      ) : null}
      {symbolPreset !== undefined ? (
        <KeyValueRow styles={styles} label="Symbol preset" value={symbolPreset} />
      ) : null}
      {defaultThinkingLevel !== undefined ? (
        <KeyValueRow styles={styles} label="Default thinking level" value={defaultThinkingLevel} />
      ) : null}
    </SectionCard>
  );
}

function OtherSection({ styles, config }: { styles: OmpConfigStyles; config: OmpConfig }) {
  const { setupVersion } = config;
  const autoqaConsent = config.dev?.autoqaConsent;
  if (setupVersion === undefined && autoqaConsent === undefined) return null;
  return (
    <SectionCard styles={styles} title="Other">
      {setupVersion !== undefined ? (
        <KeyValueRow styles={styles} label="Setup version" value={String(setupVersion)} />
      ) : null}
      {autoqaConsent !== undefined ? (
        <KeyValueRow styles={styles} label="Auto-QA consent" value={autoqaConsent} />
      ) : null}
    </SectionCard>
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

function isEmptyConfig(config: OmpConfig): boolean {
  return Object.keys(config).length === 0;
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
    <SectionCard styles={styles} title="Processes">
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
}: {
  theme: PluginSurfaceProps["theme"];
  styles: OmpConfigStyles;
}) {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const loadHealth = useRpc(getOmpProviderHealth);
  const health = useQuery({
    queryKey: HEALTH_QUERY_KEY,
    queryFn: () => loadHealth({}),
  });
  const providers = useQuery({
    queryKey: PROVIDERS_QUERY_KEY,
    queryFn: () => loadReadyProviderSnapshot(paseo.providers),
  });
  const refresh = useMutation({
    mutationFn: async () => {
      const result = await refreshProviderDiagnostics({
        providers: paseo.providers,
        loadForcedHealth: () => loadHealth({ force: true }),
        cacheHealth: (value) => queryClient.setQueryData(HEALTH_QUERY_KEY, value),
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
        These checks use the daemon&apos;s global OMP command and default storage, not per-agent
        profile overrides.
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

type SurfaceView = "overview" | "configuration" | "diagnostics";
type ConfigCategory =
  | "model-roles"
  | "enabled-models"
  | "providers"
  | "retry"
  | "memory"
  | "github"
  | "appearance"
  | "other";

const SURFACE_VIEWS: readonly { id: SurfaceView; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "configuration", label: "Configuration" },
  { id: "diagnostics", label: "Diagnostics" },
];

const CONFIG_CATEGORIES: readonly { id: ConfigCategory; label: string }[] = [
  { id: "model-roles", label: "Model roles" },
  { id: "enabled-models", label: "Enabled models" },
  { id: "providers", label: "Providers" },
  { id: "retry", label: "Retry and fallback" },
  { id: "memory", label: "Memory" },
  { id: "github", label: "GitHub" },
  { id: "appearance", label: "Appearance" },
  { id: "other", label: "Other" },
];

function ConfigurationCategory({
  category,
  styles,
  config,
}: {
  category: ConfigCategory;
  styles: OmpConfigStyles;
  config: OmpConfig;
}) {
  if (category === "model-roles") return <ModelRolesSection styles={styles} config={config} />;
  if (category === "enabled-models")
    return <EnabledModelsSection styles={styles} config={config} />;
  if (category === "providers") return <ProvidersSection styles={styles} config={config} />;
  if (category === "retry") return <RetrySection styles={styles} config={config} />;
  if (category === "memory") return <MemorySection styles={styles} config={config} />;
  if (category === "github") return <GithubSection styles={styles} config={config} />;
  if (category === "appearance") return <PreferencesSection styles={styles} config={config} />;
  return <OtherSection styles={styles} config={config} />;
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
export function OmpConfigSurface({ theme, layout }: PluginSurfaceProps) {
  const loadConfig = useRpc(listOmpConfig);
  const result = useQuery({
    queryKey: ["paseo-omp", "config"],
    queryFn: () => loadConfig({}),
    refetchInterval: CONFIG_POLL_MS,
  });
  const [view, setView] = useState<SurfaceView>("overview");
  const [activeCategory, setActiveCategory] = useState<ConfigCategory>("model-roles");
  const [search, setSearch] = useState("");
  const styles = useConfigStyles(theme, layout.compact);
  const config = result.data?.config ?? null;
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleCategories = normalizedSearch
    ? CONFIG_CATEGORIES.filter((category) =>
        category.label.toLocaleLowerCase().includes(normalizedSearch),
      )
    : CONFIG_CATEGORIES;
  const selectedCategory =
    visibleCategories.find((category) => category.id === activeCategory) ?? visibleCategories[0];

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <Text style={styles.pageTitle}>OMP</Text>
      <SurfaceTabs styles={styles} selected={view} onSelect={setView} />

      {view === "overview" ? (
        <>
          <ProviderSetupSection styles={styles} />
          <SectionCard styles={styles} title="Native configuration">
            <KeyValueRow
              styles={styles}
              label="Source"
              value={result.data?.path ?? "Loading configuration path…"}
            />
            <KeyValueRow
              styles={styles}
              label="Status"
              value={result.data?.available ? "Available" : "Unavailable"}
            />
          </SectionCard>
        </>
      ) : null}

      {view === "diagnostics" ? <ProviderHealthSection theme={theme} styles={styles} /> : null}

      {view === "configuration" ? (
        <>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionTitle}>Configuration</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Refresh OMP configuration"
                style={styles.refresh}
                disabled={result.isFetching}
                onPress={() => void result.refetch()}
              >
                <Icon name="RefreshCw" size={14} color={theme.colors.foreground} />
                <Text style={styles.refreshLabel}>
                  {result.isFetching ? "Refreshing…" : "Refresh"}
                </Text>
              </Pressable>
            </View>
            {result.data?.path ? (
              <Text style={styles.source}>{`Source: ${result.data.path}`}</Text>
            ) : null}
          </View>

          {result.isLoading ? <Text style={styles.muted}>Loading OMP configuration…</Text> : null}
          {result.error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              Could not read the OMP configuration. Try refreshing.
            </Text>
          ) : null}
          {!result.isLoading && !result.error && result.data && !result.data.available ? (
            <Text style={styles.muted}>
              OMP configuration is unavailable at this path. It may be missing, unreadable,
              malformed, or the wrong type on disk.
            </Text>
          ) : null}
          {!result.isLoading && !result.error && config && isEmptyConfig(config) ? (
            <Text style={styles.muted}>The OMP configuration has no recognized settings.</Text>
          ) : null}

          {config && !isEmptyConfig(config) ? (
            <View style={styles.workspace}>
              <View style={styles.categoryRail}>
                <TextInput
                  accessibilityLabel="Search configuration categories"
                  placeholder="Search categories"
                  placeholderTextColor={theme.colors.foregroundMuted}
                  value={search}
                  onChangeText={setSearch}
                  style={styles.search}
                />
                <View style={styles.categoryList}>
                  {visibleCategories.map((category) => {
                    const active = selectedCategory?.id === category.id;
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
                          {category.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
              <View style={styles.categoryContent}>
                {selectedCategory ? (
                  <ConfigurationCategory
                    category={selectedCategory.id}
                    styles={styles}
                    config={config}
                  />
                ) : (
                  <Text style={styles.muted}>No configuration categories match this search.</Text>
                )}
              </View>
            </View>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

import { type PluginButtonContentProps, useAgent, useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { storeForProvider, storeLabel } from "../shared/omp-store";
import { listOmpQuotas } from "../shared/quota";
import { ompStoreKey } from "./omp-store-state";
import {
  type QuotaProviderGroup,
  quotaProviderFromSession,
  quotaProviderGroups,
  quotaProviderIconName,
  quotaProviderLabel,
  quotaResetLabel,
  quotaSeverityFromFraction,
} from "./quota-state";

const QUOTA_POLL_MS = 30_000;

export function QuotaPopover(props: PluginButtonContentProps) {
  const { theme, layout } = props;
  const agentId = props.context === "agent" ? props.agentId : "";
  const session = useAgent(agentId, (agent) => ({ model: agent.model, provider: agent.provider }));
  const currentProvider = quotaProviderFromSession(session?.provider ?? "", session?.model ?? null);
  const store = storeForProvider(session?.provider);
  const loadQuotas = useRpc(listOmpQuotas);
  const quotas = useQuery({
    queryKey: ["paseo-omp", "quotas", ompStoreKey(store)],
    queryFn: () => loadQuotas({ store }),
    enabled: session !== undefined && session !== null,
    refetchInterval: QUOTA_POLL_MS,
  });

  function severityColor(severity: ReturnType<typeof quotaSeverityFromFraction>): string {
    if (severity === "danger") return theme.colors.statusDanger;
    if (severity === "warning") return theme.colors.statusWarning;
    if (severity === "ok") return theme.colors.statusSuccess;
    return theme.colors.foregroundMuted;
  }

  const styles = useMemo(
    () => ({
      root: { gap: layout.compact ? 8 : 10, minWidth: layout.compact ? undefined : 260 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 13 },
      group: (current: boolean) => ({
        gap: 6,
        padding: layout.compact ? 10 : 12,
        borderRadius: 10,
        borderWidth: current ? 2 : 1,
        borderColor: current ? theme.colors.accent : theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }),
      groupHeader: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      groupLabel: {
        color: theme.colors.foreground,
        fontSize: 14,
        fontWeight: "700" as const,
        flex: 1,
      },
      badge: {
        color: theme.colors.accentForeground,
        backgroundColor: theme.colors.accent,
        fontSize: 10,
        fontWeight: "700" as const,
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 999,
        overflow: "hidden" as const,
      },
      row: { gap: 3 },
      rowHeader: {
        flexDirection: "row" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      rowLabel: { color: theme.colors.foreground, fontSize: 12, flex: 1 },
      rowValue: { fontSize: 12, fontWeight: "600" as const },
      track: {
        height: 5,
        borderRadius: 3,
        backgroundColor: theme.colors.surface2,
        overflow: "hidden" as const,
      },
      detail: { color: theme.colors.foregroundMuted, fontSize: 11 },
    }),
    [layout.compact, theme],
  );

  if (!session || quotas.isLoading) return <Text style={styles.muted}>Loading omp quotas…</Text>;
  if (quotas.error) return <Text style={styles.error}>Could not read omp quota state.</Text>;

  const groups = quotaProviderGroups(quotas.data?.quotas ?? [], currentProvider);
  const hasCurrent = groups.some((group) => group.provider === currentProvider);

  if (groups.length === 0) {
    return <Text style={styles.muted}>No provider quota data available.</Text>;
  }

  return (
    <View style={styles.root}>
      <Text style={styles.muted}>{storeLabel(store)}</Text>
      {currentProvider && !hasCurrent ? (
        <Text style={styles.muted}>
          {`No recorded quota yet for ${quotaProviderLabel(currentProvider)} (this session's provider).`}
        </Text>
      ) : null}
      {groups.map((group: QuotaProviderGroup) => {
        const current = group.provider === currentProvider;
        return (
          <View key={group.provider} style={styles.group(current)}>
            <View style={styles.groupHeader}>
              <Icon
                name={quotaProviderIconName(group.provider)}
                size={16}
                color={severityColor(group.severity)}
              />
              <Text style={styles.groupLabel}>{quotaProviderLabel(group.provider)}</Text>
              {current ? <Text style={styles.badge}>CURRENT</Text> : null}
            </View>
            {group.quotas.map((quota) => {
              const severity = quotaSeverityFromFraction(quota.usedFraction);
              const color = severityColor(severity);
              const pct =
                quota.usedFraction === null
                  ? 0
                  : Math.min(100, Math.round(quota.usedFraction * 100));
              return (
                <View key={`${quota.label}:${quota.windowLabel}`} style={styles.row}>
                  <View style={styles.rowHeader}>
                    <Text numberOfLines={1} style={styles.rowLabel}>
                      {quota.label}
                    </Text>
                    <Text style={[styles.rowValue, { color }]}>
                      {quota.usedFraction === null ? "Unknown" : `${pct}%`}
                    </Text>
                  </View>
                  <View style={styles.track}>
                    <View style={{ height: "100%", width: `${pct}%`, backgroundColor: color }} />
                  </View>
                  <Text style={styles.detail}>
                    {[quota.windowLabel, quotaResetLabel(quota.resetsAt)]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                </View>
              );
            })}
          </View>
        );
      })}
    </View>
  );
}

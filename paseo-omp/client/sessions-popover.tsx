import { type PluginButtonContentProps, useAgent, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { storeForProvider, storeLabel } from "../shared/omp-store";
import { listOmpSessions } from "../shared/sessions";
import { ompStoreKey } from "./omp-store-state";

const SESSIONS_POLL_MS = 20_000;
const PREVIEW_LIMIT = 20;

function age(epochSeconds: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1_000 - epochSeconds));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function SessionsPopover(props: PluginButtonContentProps) {
  const { theme, layout } = props;
  const agentId = props.context === "agent" ? props.agentId : "";
  const agent = useAgent(agentId, ({ cwd, provider }) => ({ cwd, provider }));
  const cwd = agent?.cwd ?? "";
  const store = storeForProvider(agent?.provider);
  const loadSessions = useRpc(listOmpSessions);
  const sessions = useQuery({
    queryKey: ["paseo-omp", "sessions", ompStoreKey(store), cwd],
    queryFn: () => loadSessions({ cwd, store }),
    enabled: cwd.length > 0,
    refetchInterval: SESSIONS_POLL_MS,
  });
  const styles = useMemo(
    () => ({
      root: { gap: 8, padding: 4, maxHeight: 360, width: 320 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 13 },
      row: {
        gap: 2,
        padding: layout.compact ? 8 : 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      },
      title: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      prompt: { color: theme.colors.foreground, fontSize: 13 },
      detail: { color: theme.colors.foregroundMuted, fontSize: 11 },
    }),
    [layout.compact, theme],
  );

  if (sessions.isLoading) return <Text style={styles.muted}>Loading omp history…</Text>;
  if (sessions.error) return <Text style={styles.error}>Could not read omp history.</Text>;
  const items = sessions.data?.sessions ?? [];
  if (items.length === 0)
    return <Text style={styles.muted}>No omp prompts for this directory.</Text>;

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <Text style={styles.muted}>{storeLabel(store)}</Text>
      {items.slice(0, PREVIEW_LIMIT).map((entry) => (
        <View key={entry.id} style={styles.row}>
          {entry.title ? <Text style={styles.title}>{entry.title}</Text> : null}
          <Text style={styles.prompt} numberOfLines={3}>
            {`${entry.prompt}${entry.truncated ? "…" : ""}`}
          </Text>
          <Text style={styles.detail}>{age(entry.createdAt)}</Text>
        </View>
      ))}
      {items.length > PREVIEW_LIMIT ? (
        <Text style={styles.muted}>{`Showing ${PREVIEW_LIMIT} of ${items.length}`}</Text>
      ) : null}
    </ScrollView>
  );
}

import { type PluginButtonContentProps, useAgent, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { listOmpMemory } from "../shared/memory";
import { storeForProvider, storeLabel } from "../shared/omp-store";
import { ompStoreKey } from "./omp-store-state";

const MEMORY_POLL_MS = 15_000;
const PREVIEW_LIMIT = 20;

export function MemoryPopover(props: PluginButtonContentProps) {
  const { theme, layout } = props;
  const agentId = props.context === "agent" ? props.agentId : "";
  const agent = useAgent(agentId, ({ cwd, provider }) => ({ cwd, provider }));
  const cwd = agent?.cwd ?? "";
  const store = storeForProvider(agent?.provider);
  const loadMemory = useRpc(listOmpMemory);
  const memory = useQuery({
    queryKey: ["paseo-omp", "memory", ompStoreKey(store), cwd],
    queryFn: () => loadMemory({ cwd, store }),
    enabled: cwd.length > 0,
    refetchInterval: MEMORY_POLL_MS,
  });
  const styles = useMemo(
    () => ({
      root: { gap: layout.compact ? 8 : 10, minWidth: layout.compact ? undefined : 260 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      error: { color: theme.colors.statusDanger, fontSize: 13 },
      header: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 12 },
      title: { color: theme.colors.foreground, fontSize: 14, fontWeight: "700" as const },
      card: {
        gap: 4,
        padding: layout.compact ? 9 : 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 9,
        backgroundColor: theme.colors.surface1,
      },
      fact: { color: theme.colors.foreground, fontSize: 13 },
      detail: { color: theme.colors.foregroundMuted, fontSize: 11 },
    }),
    [layout.compact, theme],
  );

  if (memory.isLoading) return <Text style={styles.muted}>Loading retained facts…</Text>;
  if (memory.error) return <Text style={styles.error}>Could not read workspace memory.</Text>;

  const facts = memory.data?.facts ?? [];
  if (facts.length === 0) {
    return <Text style={styles.muted}>No retained facts for this workspace.</Text>;
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>OMP Memory · {storeLabel(store)}</Text>
        <Text style={styles.muted}>{facts.length} facts</Text>
      </View>
      <Text style={styles.muted}>{memory.data?.bank ?? "Workspace memory"}</Text>
      {facts.slice(0, PREVIEW_LIMIT).map((fact) => (
        <View key={fact.id} style={styles.card}>
          <Text style={styles.fact}>{`${fact.subject} ${fact.predicate} ${fact.object}`}</Text>
          <Text style={styles.detail}>
            {`${Math.round(fact.confidence * 100)}% confidence${fact.timestamp ? ` · ${fact.timestamp}` : ""}`}
          </Text>
        </View>
      ))}
      {facts.length > PREVIEW_LIMIT ? (
        <Text style={styles.muted}>{`Showing ${PREVIEW_LIMIT} of ${facts.length}`}</Text>
      ) : null}
    </View>
  );
}

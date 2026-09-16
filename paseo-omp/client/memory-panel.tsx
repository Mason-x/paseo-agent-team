import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { listOmpMemory } from "../shared/memory";
import type { OmpStore } from "../shared/omp-store";
import { OmpStorePicker } from "./omp-store-picker";
import { ompStoreKey } from "./omp-store-state";

const MEMORY_POLL_MS = 15_000;

export function OmpMemoryPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory) ?? "";
  const [store, setStore] = useState<OmpStore>();
  const loadMemory = useRpc(listOmpMemory);
  const memory = useQuery({
    queryKey: ["paseo-omp", "memory", ompStoreKey(store), directory],
    queryFn: () => loadMemory({ cwd: directory, store }),
    enabled: directory.length > 0,
    refetchInterval: MEMORY_POLL_MS,
  });
  const styles = useMemo(
    () => ({
      root: {
        flex: 1,
        gap: layout.compact ? 10 : 14,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
      },
      title: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 20 : 24,
        fontWeight: "700" as const,
      },
      subtitle: { color: theme.colors.foregroundMuted, fontSize: 13 },
      card: {
        gap: 6,
        padding: layout.compact ? 10 : 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
      },
      fact: { color: theme.colors.foreground, fontSize: 14 },
      detail: { color: theme.colors.foregroundMuted, fontSize: 12 },
      error: { color: theme.colors.statusDanger, fontSize: 13 },
    }),
    [layout.compact, theme],
  );

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <View style={{ gap: 4 }}>
        <Text style={styles.title}>OMP Memory</Text>
        <Text style={styles.subtitle}>
          {memory.data?.bank ? `Bank: ${memory.data.bank}` : "Retained workspace facts"}
        </Text>
      </View>
      <OmpStorePicker theme={theme} store={store} onChange={setStore} />
      {memory.isLoading ? <Text style={styles.subtitle}>Loading retained facts…</Text> : null}
      {memory.error ? <Text style={styles.error}>Could not read workspace memory.</Text> : null}
      {!memory.isLoading && !memory.error && (memory.data?.facts.length ?? 0) === 0 ? (
        <Text style={styles.subtitle}>No retained facts for this workspace.</Text>
      ) : null}
      {memory.data?.facts.map((fact) => (
        <View key={fact.id} style={styles.card}>
          <Text style={styles.fact}>{`${fact.subject} ${fact.predicate} ${fact.object}`}</Text>
          <Text style={styles.detail}>
            {`${Math.round(fact.confidence * 100)}% confidence${fact.timestamp ? ` · ${fact.timestamp}` : ""}`}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

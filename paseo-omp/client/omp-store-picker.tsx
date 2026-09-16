import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import { listOmpStores, type OmpStore, storeLabel } from "../shared/omp-store";
import { ompStoreKey } from "./omp-store-state";

export function OmpStorePicker({
  theme,
  store,
  onChange,
  disabled = false,
}: {
  theme: PluginSurfaceProps["theme"];
  store?: OmpStore;
  onChange(store: OmpStore | undefined): void;
  disabled?: boolean;
}) {
  const loadStores = useRpc(listOmpStores);
  const stores = useQuery({
    queryKey: ["paseo-omp", "stores"],
    queryFn: () => loadStores({}),
    staleTime: 30_000,
  });
  const profiles = [
    ...new Set([...(stores.data?.profiles ?? []), ...(store?.profile ? [store.profile] : [])]),
  ];
  const choices: Array<OmpStore | undefined> = [
    undefined,
    ...profiles.map((profile) => ({ profile })),
  ];
  if (store?.agentDir) choices.push(store);
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>OMP store</Text>
      <View
        accessibilityRole="radiogroup"
        style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
      >
        {choices.map((choice) => {
          const selected = ompStoreKey(choice) === ompStoreKey(store);
          return (
            <Pressable
              key={ompStoreKey(choice)}
              accessibilityRole="radio"
              accessibilityLabel={storeLabel(choice)}
              accessibilityState={{ checked: selected, disabled }}
              aria-checked={selected}
              aria-disabled={disabled}
              disabled={disabled}
              onPress={() => onChange(choice)}
              style={{
                borderWidth: 1,
                borderRadius: 8,
                paddingHorizontal: 10,
                paddingVertical: 8,
                borderColor: selected ? theme.colors.accent : theme.colors.border,
                backgroundColor: theme.colors.surface1,
                opacity: disabled ? 0.5 : 1,
              }}
            >
              <Text
                style={{ color: theme.colors.foreground, fontWeight: selected ? "600" : "400" }}
              >
                {selected ? "✓ " : ""}
                {storeLabel(choice)}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {stores.isLoading ? (
        <Text style={{ color: theme.colors.foregroundMuted }}>Loading profiles…</Text>
      ) : null}
      {stores.error ? (
        <Text style={{ color: theme.colors.statusDanger }}>
          Could not list OMP profiles.{" "}
          <Text
            onPress={() => {
              void stores.refetch();
            }}
            accessibilityRole="button"
          >
            Retry
          </Text>
        </Text>
      ) : null}
    </View>
  );
}

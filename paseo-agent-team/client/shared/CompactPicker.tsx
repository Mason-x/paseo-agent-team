import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Field, inputStyle } from "./Field";
import { ImeTextInput } from "./ImeTextInput";
import { filterByQuery } from "./search";
import type { PluginTheme } from "./theme";

const MENU_MAX_HEIGHT = 220;

export function CompactPicker<T extends { id: string; name: string }>({
  theme,
  label,
  items,
  selectedId,
  placeholder,
  searchPlaceholder,
  emptyLabel,
  error,
  subtitle,
  leading,
  footer,
  onChange,
}: {
  theme: PluginTheme;
  label: string;
  items: readonly T[];
  selectedId: string;
  placeholder: string;
  searchPlaceholder: string;
  emptyLabel: string;
  error?: string;
  subtitle?: (item: T) => string | undefined;
  leading?: (item: T) => ReactNode;
  footer?: ReactNode;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = items.find((item) => item.id === selectedId);
  const filtered = useMemo(
    () =>
      filterByQuery(items, query, (item) => `${item.name} ${item.id} ${subtitle?.(item) ?? ""}`),
    [items, query, subtitle],
  );
  const showSearch = open && items.length > 6;
  const styles = useMemo(
    () => ({
      trigger: {
        minHeight: 32,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: 10,
        borderWidth: 1,
        borderColor: error ? theme.colors.statusDanger : theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
      },
      triggerLabel: {
        flex: 1,
        color: selected ? theme.colors.foreground : theme.colors.foregroundMuted,
        fontSize: 14,
        fontWeight: selected ? ("600" as const) : ("400" as const),
      },
      meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      menu: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
        overflow: "hidden" as const,
      },
      search: {
        ...inputStyle(theme),
        borderWidth: 0,
        borderBottomWidth: 1,
        borderRadius: 0,
        backgroundColor: theme.colors.surface2,
      },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        minHeight: 36,
        paddingHorizontal: 10,
      },
      rowSelected: { backgroundColor: theme.colors.surface2 },
      name: { flex: 1, color: theme.colors.foreground, fontSize: 14 },
      empty: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        paddingHorizontal: 10,
        paddingVertical: 12,
      },
    }),
    [error, selected, theme],
  );

  function close() {
    setOpen(false);
    setQuery("");
  }

  return (
    <Field theme={theme} label={label} error={error}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${label}：${selected?.name ?? (selectedId || placeholder)}`}
        onPress={() => (open ? close() : setOpen(true))}
        style={styles.trigger}
      >
        {selected && leading ? leading(selected) : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={styles.triggerLabel}>
            {selected?.name ?? (selectedId || placeholder)}
          </Text>
          {selected && subtitle?.(selected) ? (
            <Text numberOfLines={1} style={styles.meta}>
              {subtitle(selected)}
            </Text>
          ) : null}
        </View>
        <Icon
          name={open ? "ChevronUp" : "ChevronDown"}
          size={14}
          color={theme.colors.foregroundMuted}
        />
      </Pressable>
      {open ? (
        <View style={styles.menu}>
          {showSearch ? (
            <ImeTextInput
              initialValue=""
              onChangeText={setQuery}
              placeholder={searchPlaceholder}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.search}
            />
          ) : null}
          <ScrollView style={{ maxHeight: MENU_MAX_HEIGHT }}>
            {filtered.length === 0 ? (
              <Text style={styles.empty}>{emptyLabel}</Text>
            ) : (
              filtered.map((item) => {
                const isSelected = item.id === selectedId;
                const extra = subtitle?.(item);
                return (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                    accessibilityLabel={item.name}
                    onPress={() => {
                      onChange(item.id);
                      close();
                    }}
                    style={[styles.row, isSelected && styles.rowSelected]}
                  >
                    {leading ? leading(item) : null}
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text
                        numberOfLines={1}
                        style={[styles.name, isSelected && { fontWeight: "600" }]}
                      >
                        {item.name}
                      </Text>
                      {extra ? (
                        <Text numberOfLines={1} style={styles.meta}>
                          {extra}
                        </Text>
                      ) : null}
                    </View>
                    {isSelected ? (
                      <Icon name="Check" size={14} color={theme.colors.accent} />
                    ) : null}
                  </Pressable>
                );
              })
            )}
          </ScrollView>
          {footer}
        </View>
      ) : null}
    </Field>
  );
}

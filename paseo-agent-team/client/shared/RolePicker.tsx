import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Role } from "../../shared/schemas/role";
import { zh } from "../../shared/zh";
import { Field, inputStyle } from "./Field";
import { ImeTextInput } from "./ImeTextInput";
import { RoleGlyph } from "./RoleGlyph";
import { filterRoles } from "./role-filter";
import type { PluginTheme } from "./theme";

const MENU_MAX_HEIGHT = 220;

export function RolePicker({
  theme,
  label,
  roles,
  selectedId,
  error,
  onChange,
}: {
  theme: PluginTheme;
  label: string;
  roles: readonly Role[];
  selectedId: string;
  error?: string;
  onChange: (roleId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = roles.find((role) => role.id === selectedId);
  const filtered = useMemo(() => filterRoles(roles, query), [roles, query]);
  const showSearch = open && roles.length > 6;
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
        accessibilityLabel={`${label}：${selected?.name ?? (selectedId || zh.chooseRole)}`}
        onPress={() => {
          if (open) close();
          else setOpen(true);
        }}
        style={styles.trigger}
      >
        {selected ? (
          <RoleGlyph theme={theme} icon={selected.icon} color={selected.color} size={16} />
        ) : (
          <Icon name="User" size={16} color={theme.colors.foregroundMuted} />
        )}
        <Text numberOfLines={1} style={styles.triggerLabel}>
          {selected ? selected.name : selectedId || zh.chooseRole}
        </Text>
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
              placeholder={zh.searchRoles}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.search}
            />
          ) : null}
          <ScrollView style={{ maxHeight: MENU_MAX_HEIGHT }}>
            {filtered.length === 0 ? (
              <Text style={styles.empty}>{zh.noMatchingRoles}</Text>
            ) : (
              filtered.map((role) => {
                const isSelected = role.id === selectedId;
                return (
                  <Pressable
                    key={role.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                    accessibilityLabel={role.name}
                    onPress={() => {
                      onChange(role.id);
                      close();
                    }}
                    style={[styles.row, isSelected && styles.rowSelected]}
                  >
                    <RoleGlyph theme={theme} icon={role.icon} color={role.color} size={14} />
                    <Text style={[styles.name, isSelected && { fontWeight: "600" }]}>
                      {role.name}
                    </Text>
                    {isSelected ? (
                      <Icon name="Check" size={14} color={theme.colors.accent} />
                    ) : null}
                  </Pressable>
                );
              })
            )}
          </ScrollView>
        </View>
      ) : null}
    </Field>
  );
}

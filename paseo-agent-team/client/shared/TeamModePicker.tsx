import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { TeamMode } from "../../shared/schemas/team-mode";
import { zh } from "../../shared/zh";
import { TEAM_MODE_OPTIONS } from "./team-mode-options";
import type { PluginLayout, PluginTheme } from "./theme";

export function TeamModePicker({
  theme,
  layout,
  value,
  onChange,
  disabled = false,
}: {
  theme: PluginTheme;
  layout: PluginLayout;
  value: TeamMode;
  onChange: (mode: TeamMode) => void;
  disabled?: boolean;
}) {
  const styles = useMemo(
    () => ({
      root: { gap: 6 },
      label: { color: theme.colors.foregroundMuted, fontSize: 12 },
      row: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 6,
      },
      option: {
        flexGrow: 1,
        flexBasis: layout.compact ? "100%" : 120,
        minHeight: 36,
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        justifyContent: "center" as const,
      },
      optionSelected: {
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.surface1,
      },
      optionLabel: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      optionLabelSelected: { color: theme.colors.accent },
      hint: { color: theme.colors.foregroundMuted, fontSize: 11 },
      disabled: { opacity: 0.5 },
    }),
    [layout.compact, theme],
  );
  const selected = TEAM_MODE_OPTIONS.find((option) => option.value === value);
  return (
    <View style={[styles.root, disabled && styles.disabled]}>
      <Text style={styles.label}>{zh.teamMode}</Text>
      <View style={styles.row}>
        {TEAM_MODE_OPTIONS.map((option) => {
          const isSelected = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected, disabled }}
              accessibilityLabel={option.label}
              disabled={disabled}
              onPress={() => onChange(option.value)}
              style={[styles.option, isSelected && styles.optionSelected]}
            >
              <Text style={[styles.optionLabel, isSelected && styles.optionLabelSelected]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {selected ? <Text style={styles.hint}>{selected.hint}</Text> : null}
    </View>
  );
}

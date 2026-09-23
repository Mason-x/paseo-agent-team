import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { zh } from "../../shared/zh";
import { GhostIconButton } from "../shared/buttons";
import { inputStyle } from "../shared/Field";
import { ImeTextInput } from "../shared/ImeTextInput";
import type { PluginTheme } from "../shared/theme";

export function ListEditor({
  theme,
  label,
  values,
  onChange,
  error,
  revision,
}: {
  theme: PluginTheme;
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  error?: string;
  revision?: string | number;
}) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
      {values.map((value, index) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are free-text with no stable id
          key={index}
          style={{ flexDirection: "row", gap: 8, alignItems: "center" }}
        >
          <ImeTextInput
            initialValue={value}
            revision={`${revision ?? 0}:${index}`}
            onChangeText={(next) => {
              const copy = [...values];
              copy[index] = next;
              onChange(copy);
            }}
            placeholder={`${label} ${index + 1}`}
            placeholderTextColor={theme.colors.foregroundMuted}
            style={{ ...inputStyle(theme), flex: 1 }}
          />
          <GhostIconButton
            theme={theme}
            icon="Trash2"
            danger
            accessibilityLabel={`Remove ${label} item ${index + 1}`}
            onPress={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}
          />
        </View>
      ))}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Add ${label}`}
        onPress={() => onChange([...values, ""])}
        style={{ flexDirection: "row", alignItems: "center", gap: 4, minHeight: 28 }}
      >
        <Icon name="Plus" size={14} color={theme.colors.accent} />
        <Text style={{ color: theme.colors.accent, fontWeight: "600", fontSize: 13 }}>
          {zh.add}
        </Text>
      </Pressable>
      {error ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text>
      ) : null}
    </View>
  );
}

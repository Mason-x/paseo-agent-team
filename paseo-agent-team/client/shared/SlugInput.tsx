import { Text, View } from "react-native";
import { isSlug } from "../../shared/ids";
import { zh } from "../../shared/zh";
import { inputStyle } from "./Field";
import { ImeTextInput } from "./ImeTextInput";
import type { PluginTheme } from "./theme";

export function SlugInput({
  theme,
  value,
  onChange,
  locked,
  error,
  revision,
}: {
  theme: PluginTheme;
  value: string;
  onChange: (value: string) => void;
  locked: boolean;
  error?: string;
  revision?: string | number;
}) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{zh.id}</Text>
      <ImeTextInput
        accessibilityLabel={zh.id}
        initialValue={value}
        revision={revision}
        editable={!locked}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={onChange}
        placeholder="role-id"
        placeholderTextColor={theme.colors.foregroundMuted}
        style={{
          ...inputStyle(theme, { error: Boolean(error) }),
          backgroundColor: locked ? theme.colors.surface1 : theme.colors.surface2,
        }}
      />
      {locked ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{zh.idLocked}</Text>
      ) : null}
      {error ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text>
      ) : null}
      {!error && value && !isSlug(value) ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{zh.idSlugHint}</Text>
      ) : null}
    </View>
  );
}

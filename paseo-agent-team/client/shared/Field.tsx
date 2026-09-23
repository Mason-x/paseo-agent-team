import type { ReactNode } from "react";
import { Text, type TextInputProps, View } from "react-native";
import { ImeTextInput } from "./ImeTextInput";
import type { PluginTheme } from "./theme";

export function inputStyle(
  theme: PluginTheme,
  options: { error?: boolean; multiline?: boolean; mono?: boolean } = {},
) {
  return {
    minHeight: options.multiline ? 88 : 32,
    borderWidth: 1,
    borderColor: options.error ? theme.colors.statusDanger : theme.colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: options.multiline ? 8 : 0,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
    fontFamily: options.mono ? "monospace" : undefined,
    fontSize: 14,
    textAlignVertical: options.multiline ? ("top" as const) : ("center" as const),
  };
}

export function Field({
  theme,
  label,
  error,
  children,
}: {
  theme: PluginTheme;
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <View style={{ gap: 4, flex: label ? undefined : 1 }}>
      {label ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
      ) : null}
      {children}
      {error ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text>
      ) : null}
    </View>
  );
}

export function TextField({
  theme,
  label,
  value,
  onChange,
  onBlur,
  error,
  multiline,
  mono,
  placeholder,
  revision,
  accessibilityLabel,
}: {
  theme: PluginTheme;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: TextInputProps["onBlur"];
  error?: string;
  multiline?: boolean;
  mono?: boolean;
  placeholder?: string;
  revision?: string | number;
  accessibilityLabel?: string;
}) {
  return (
    <Field theme={theme} label={label} error={error}>
      <ImeTextInput
        accessibilityLabel={accessibilityLabel ?? (label || undefined)}
        initialValue={value}
        revision={revision}
        onChangeText={onChange}
        onBlur={onBlur}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.foregroundMuted}
        multiline={multiline}
        style={inputStyle(theme, { error: Boolean(error), multiline, mono })}
      />
    </Field>
  );
}

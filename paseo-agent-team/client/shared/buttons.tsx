import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "./theme";

export function GhostIconButton({
  theme,
  icon,
  accessibilityLabel,
  onPress,
  danger,
  disabled,
  color,
}: {
  theme: PluginTheme;
  icon: string;
  accessibilityLabel: string;
  onPress: () => void;
  danger?: boolean;
  disabled?: boolean;
  color?: string;
}) {
  const tint = color ?? (danger ? theme.colors.statusDanger : theme.colors.foregroundMuted);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [
        {
          width: 30,
          height: 30,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 7,
        },
        pressed && { opacity: 0.58 },
        disabled && { opacity: 0.38 },
      ]}
    >
      <Icon name={icon} size={15} color={tint} />
    </Pressable>
  );
}

export function ModalActions({
  theme,
  cancelLabel = "取消",
  confirmLabel,
  confirmDisabled,
  danger,
  onCancel,
  onConfirm,
}: {
  theme: PluginTheme;
  cancelLabel?: string;
  confirmLabel: string;
  confirmDisabled?: boolean;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 }}>
      <FilledButton theme={theme} label={cancelLabel} variant="secondary" onPress={onCancel} />
      <FilledButton
        theme={theme}
        label={confirmLabel}
        variant={danger ? "danger" : "primary"}
        disabled={confirmDisabled}
        onPress={onConfirm}
      />
    </View>
  );
}

export function FilledButton({
  theme,
  label,
  variant,
  disabled,
  onPress,
  icon,
}: {
  theme: PluginTheme;
  label: string;
  variant: "primary" | "secondary" | "danger";
  disabled?: boolean;
  onPress: () => void;
  icon?: ReactNode;
}) {
  const backgroundColor =
    variant === "primary"
      ? theme.colors.accent
      : variant === "danger"
        ? theme.colors.statusDanger
        : theme.colors.surface2;
  const color = variant === "secondary" ? theme.colors.foreground : theme.colors.accentForeground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        {
          flex: 1,
          minHeight: 44,
          paddingHorizontal: 16,
          borderRadius: 10,
          backgroundColor,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          gap: 6,
        },
        pressed && { opacity: 0.72 },
        disabled && { opacity: 0.45 },
      ]}
    >
      {icon}
      <Text style={{ color, fontWeight: "600", fontSize: 14 }}>{label}</Text>
    </Pressable>
  );
}

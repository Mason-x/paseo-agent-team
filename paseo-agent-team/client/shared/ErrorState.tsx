import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "./theme";

export function ErrorState({
  theme,
  title,
  body,
  actionLabel,
  onAction,
  dangerActionLabel,
  onDangerAction,
}: {
  theme: PluginTheme;
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
  dangerActionLabel?: string;
  onDangerAction?: () => void;
}) {
  const styles = useMemo(
    () => ({
      root: {
        margin: 16,
        padding: 14,
        gap: 8,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
      },
      title: { color: theme.colors.statusDanger, fontSize: 15, fontWeight: "600" as const },
      body: { color: theme.colors.foreground, fontSize: 13 },
      actions: { flexDirection: "row" as const, gap: 8, marginTop: 4 },
      action: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
      },
      actionLabel: { color: theme.colors.foreground, fontWeight: "600" as const },
      danger: { backgroundColor: theme.colors.statusDanger },
      dangerLabel: { color: theme.colors.accentForeground, fontWeight: "600" as const },
    }),
    [theme],
  );
  return (
    <View style={styles.root}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>{body}</Text>
      <View style={styles.actions}>
        {actionLabel && onAction ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={actionLabel}
            onPress={onAction}
            style={styles.action}
          >
            <Text style={styles.actionLabel}>{actionLabel}</Text>
          </Pressable>
        ) : null}
        {dangerActionLabel && onDangerAction ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={dangerActionLabel}
            onPress={onDangerAction}
            style={[styles.action, styles.danger]}
          >
            <Text style={styles.dangerLabel}>{dangerActionLabel}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

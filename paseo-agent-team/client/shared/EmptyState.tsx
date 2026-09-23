import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "./theme";

export function EmptyState({
  theme,
  title,
  body,
  actionLabel,
  onAction,
}: {
  theme: PluginTheme;
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const styles = useMemo(
    () => ({
      root: { padding: 24, gap: 8, alignItems: "center" as const },
      title: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
      body: { color: theme.colors.foregroundMuted, fontSize: 13, textAlign: "center" as const },
      action: {
        marginTop: 8,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      actionLabel: { color: theme.colors.accentForeground, fontWeight: "600" as const },
    }),
    [theme],
  );
  return (
    <View style={styles.root}>
      <Icon name="Users" size={24} color={theme.colors.foregroundMuted} />
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>{body}</Text>
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
    </View>
  );
}

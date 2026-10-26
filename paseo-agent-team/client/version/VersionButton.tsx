import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { Job, VersionInfo } from "../../shared/version";
import type { PluginLayout, PluginTheme } from "../shared/theme";
import { headerVersionView } from "./view-model";

export function VersionButton({
  theme,
  layout,
  info,
  job,
  onOpen,
}: {
  theme: PluginTheme;
  layout: PluginLayout;
  info: VersionInfo | null;
  job: Job | null;
  onOpen: () => void;
}) {
  const view = headerVersionView(info, job);
  const styles = useMemo(
    () => ({
      button: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        gap: 5,
        minHeight: 28,
        minWidth: 28,
        paddingHorizontal: 8,
        borderRadius: 8,
        flexShrink: 0,
      },
      compact: { paddingHorizontal: 0, minWidth: 36, minHeight: 36 },
      label: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
      status: { color: theme.colors.foregroundMuted, fontSize: 11 },
      update: { color: theme.colors.accent, fontSize: 11, fontWeight: "600" as const },
      dot: {
        position: "absolute" as const,
        top: 3,
        right: 3,
        width: 6,
        height: 6,
        borderRadius: 3,
      },
      dotUpdate: { backgroundColor: theme.colors.accent },
      dotUnknown: { backgroundColor: theme.colors.statusWarning },
    }),
    [theme],
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={view.accessibilityLabel}
      onPress={onOpen}
      style={({ pressed }) => [
        styles.button,
        layout.compact && styles.compact,
        pressed && { opacity: 0.68 },
      ]}
    >
      <Icon name="Package" size={15} color={theme.colors.foregroundMuted} />
      {layout.compact ? null : <Text style={styles.label}>{view.versionLabel}</Text>}
      {layout.compact ? null : view.status === "update" ? (
        <Text style={styles.update}>{view.statusText}</Text>
      ) : view.status === "unknown" ? (
        <Text style={styles.status}>{view.statusText}</Text>
      ) : null}
      {view.status === "update" ? (
        <View style={[styles.dot, styles.dotUpdate]} />
      ) : view.status === "unknown" ? (
        <View style={[styles.dot, styles.dotUnknown]} />
      ) : null}
    </Pressable>
  );
}

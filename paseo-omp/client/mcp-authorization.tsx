import { type PluginTimelineItemProps, useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import {
  type OmpMcpAuthorizationTimeline,
  openOmpMcpAuthorizationInPaseoBrowser,
} from "../shared/mcp";

function browserAuthorizationError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (/No Paseo desktop browser host/iu.test(detail)) {
    return "No Paseo desktop browser host is connected. Open the authorization on this device.";
  }
  if (/browser tools are disabled/iu.test(detail)) {
    return "Paseo browser tools are disabled. Open the authorization on this device.";
  }
  if (/browser tools are unavailable/iu.test(detail)) {
    return "Paseo tools are not available in this OMP session. Open the authorization on this device.";
  }
  if (/session is no longer available|session is closed/iu.test(detail)) {
    return "The OMP authorization session ended. Start authorization again or open the URL on this device.";
  }
  return "Could not open a Paseo Browser tab. Open the authorization on this device.";
}

export function OmpMcpAuthorizationCard({
  item,
  theme,
  layout,
}: PluginTimelineItemProps<OmpMcpAuthorizationTimeline>) {
  const openInPaseoBrowser = useRpc(openOmpMcpAuthorizationInPaseoBrowser);
  const [opening, setOpening] = useState<"paseo" | "device" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const styles = useMemo(
    () => ({
      card: {
        gap: layout.compact ? 10 : 12,
        padding: layout.compact ? 12 : 14,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
      },
      header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      title: { color: theme.colors.foreground, fontSize: 14, fontWeight: "700" as const },
      text: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 },
      url: { color: theme.colors.accent, fontSize: 12, lineHeight: 17 },
      buttonRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
      button: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        alignSelf: "flex-start" as const,
        gap: 7,
        paddingHorizontal: 12,
        paddingVertical: 9,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      buttonSecondary: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      },
      buttonPressed: { opacity: 0.78 },
      buttonDisabled: { opacity: 0.55 },
      buttonText: {
        color: theme.colors.accentForeground,
        fontSize: 13,
        fontWeight: "600" as const,
      },
      buttonTextSecondary: { color: theme.colors.foreground },
      success: { color: theme.colors.statusSuccess, fontSize: 12 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
    }),
    [layout.compact, theme],
  );

  async function openPaseoBrowser(): Promise<void> {
    setOpening("paseo");
    setError(null);
    setMessage(null);
    try {
      const authorizationToken = item.data.browserAuthorizationToken;
      if (!authorizationToken) throw new Error("Browser authorization is unavailable");
      await openInPaseoBrowser({ authorizationToken });
      setMessage("Opened in a Paseo Browser tab for this workspace.");
    } catch (cause) {
      setError(browserAuthorizationError(cause));
    } finally {
      setOpening(null);
    }
  }

  async function openOnDevice(): Promise<void> {
    setOpening("device");
    setError(null);
    setMessage(null);
    try {
      await Linking.openURL(item.data.url);
    } catch {
      setError("Could not open the authorization URL. Copy the URL below into a browser.");
    } finally {
      setOpening(null);
    }
  }

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Icon name="KeyRound" size={16} color={theme.colors.accent} />
        <Text style={styles.title}>OMP MCP authorization</Text>
      </View>
      {item.data.instructions ? <Text style={styles.text}>{item.data.instructions}</Text> : null}
      <View style={styles.buttonRow}>
        {item.data.browserAuthorizationToken ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open MCP authorization in Paseo Browser"
            disabled={opening !== null}
            onPress={() => void openPaseoBrowser()}
            style={({ pressed }) => [
              styles.button,
              pressed ? styles.buttonPressed : null,
              opening !== null ? styles.buttonDisabled : null,
            ]}
          >
            <Icon name="PanelsTopLeft" size={15} color={theme.colors.accentForeground} />
            <Text style={styles.buttonText}>
              {opening === "paseo" ? "Opening…" : "Open in Paseo Browser"}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Open MCP authorization on this device"
          disabled={opening !== null}
          onPress={() => void openOnDevice()}
          style={({ pressed }) => [
            styles.button,
            styles.buttonSecondary,
            pressed ? styles.buttonPressed : null,
            opening !== null ? styles.buttonDisabled : null,
          ]}
        >
          <Icon name="ExternalLink" size={15} color={theme.colors.foreground} />
          <Text style={[styles.buttonText, styles.buttonTextSecondary]}>
            {opening === "device" ? "Opening…" : "Open on this device"}
          </Text>
        </Pressable>
      </View>
      <Text selectable style={styles.url}>
        {item.data.url}
      </Text>
      {item.data.loopbackCallback ? (
        <Text style={styles.text}>
          Paseo Browser keeps authorization in this workspace when a desktop browser host is
          connected. For a localhost callback, that browser host must run on the daemon machine.
          Otherwise, copy the final URL or authorization code and paste it into the OMP prompt in
          this chat.
        </Text>
      ) : null}
      {message ? <Text style={styles.success}>{message}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

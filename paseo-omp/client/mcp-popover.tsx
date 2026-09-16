import { type PluginButtonContentProps, useAgent, usePaseo } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { buildOmpMcpServerCommand, type OmpMcpServerAction } from "../shared/mcp";

import { isOmpPluginProvider } from "./omp-store-state";

const GENERAL_ACTIONS = [
  { label: "List servers", command: "/mcp list" },
  { label: "Add server", command: "/mcp add" },
  { label: "Reload", command: "/mcp reload" },
  { label: "Resources", command: "/mcp resources" },
  { label: "Prompts", command: "/mcp prompts" },
  { label: "Notifications", command: "/mcp notifications" },
] as const;

const SERVER_ACTIONS: ReadonlyArray<{ label: string; action: OmpMcpServerAction }> = [
  { label: "Test", action: "test" },
  { label: "Authorize", action: "reauth" },
  { label: "Enable", action: "enable" },
  { label: "Disable", action: "disable" },
];

export function McpPopover(props: PluginButtonContentProps) {
  const { theme, layout, close } = props;
  const agentId = props.context === "agent" ? props.agentId : "";
  const agent = useAgent(agentId, ({ provider, status }) => ({ provider, status }));
  const paseo = usePaseo();
  const [serverName, setServerName] = useState("");
  const [pendingCommand, setPendingCommand] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const styles = useMemo(
    () => ({
      root: { gap: layout.compact ? 10 : 12, width: layout.compact ? undefined : 340 },
      title: { color: theme.colors.foreground, fontSize: 14, fontWeight: "700" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 7 },
      action: {
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      },
      actionPressed: { opacity: 0.72 },
      actionDisabled: { opacity: 0.45 },
      actionText: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
      input: {
        color: theme.colors.foreground,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface0,
        paddingHorizontal: 10,
        paddingVertical: 8,
        fontSize: 13,
      },
    }),
    [layout.compact, theme],
  );

  const targetCommands = SERVER_ACTIONS.map(({ label, action }) => ({
    label,
    command: buildOmpMcpServerCommand(action, serverName),
  }));
  const unavailable = !isOmpPluginProvider(agent?.provider);

  async function send(command: string): Promise<void> {
    setPendingCommand(command);
    setError(null);
    try {
      await paseo.agents.ref(agentId).send(command);
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send the OMP MCP command.");
    } finally {
      setPendingCommand(null);
    }
  }

  if (unavailable)
    return <Text style={styles.muted}>MCP controls require an OMP Plugin agent.</Text>;

  return (
    <View style={styles.root}>
      <Text style={styles.title}>OMP MCP</Text>
      <Text style={styles.muted}>
        Commands run in this OMP session. Results, setup questions, and authorization stay in the
        chat timeline so they remain usable from remote and mobile clients.
      </Text>
      <View style={styles.actions}>
        {GENERAL_ACTIONS.map((action) => (
          <Pressable
            key={action.command}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            disabled={pendingCommand !== null}
            onPress={() => void send(action.command)}
            style={({ pressed }) => [
              styles.action,
              pressed ? styles.actionPressed : null,
              pendingCommand !== null ? styles.actionDisabled : null,
            ]}
          >
            <Text style={styles.actionText}>
              {pendingCommand === action.command ? "Sending…" : action.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        accessibilityLabel="OMP MCP server name"
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setServerName}
        placeholder="Server name"
        placeholderTextColor={theme.colors.foregroundMuted}
        style={styles.input}
        value={serverName}
      />
      <View style={styles.actions}>
        {targetCommands.map((action) => (
          <Pressable
            key={action.label}
            accessibilityRole="button"
            accessibilityLabel={`${action.label} MCP server`}
            disabled={!action.command || pendingCommand !== null}
            onPress={() => action.command && void send(action.command)}
            style={({ pressed }) => [
              styles.action,
              pressed ? styles.actionPressed : null,
              !action.command || pendingCommand !== null ? styles.actionDisabled : null,
            ]}
          >
            <Text style={styles.actionText}>
              {pendingCommand === action.command ? "Sending…" : action.label}
            </Text>
          </Pressable>
        ))}
      </View>
      {agent?.status === "running" ? (
        <Text style={styles.muted}>The command may wait until the active turn finishes.</Text>
      ) : null}
      {serverName.trim() && targetCommands.every((action) => !action.command) ? (
        <Text style={styles.error}>
          Server names may contain letters, numbers, dash, underscore, dot, and colon.
        </Text>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

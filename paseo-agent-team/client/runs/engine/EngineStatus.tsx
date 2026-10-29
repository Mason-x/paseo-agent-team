import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { EngineFailureKind, EngineState } from "../../../shared/domain/run-engine/view";
import { runEngineZh as zh } from "../../../shared/zh/run-engine";
import type { PluginTheme } from "../../shared/theme";

export type StatusKind = "loading" | EngineFailureKind | "refresh-plugin";

/** Which card an unreadable `run.get` result shows. `ready`/`unchanged` never reach this. */
export function statusKind(state: EngineState | null): StatusKind | null {
  if (state === null) return "loading";
  if (state.kind === "failure") return state.failure;
  if (state.kind === "refresh-plugin") return "refresh-plugin";
  return null;
}

export function statusCopy(
  kind: Exclude<StatusKind, "loading">,
  detail: string | null,
): { title: string; body: string } {
  const copy = zh.failure[kind];
  const base = "body" in copy ? copy : { title: "", body: "" };
  return detail === null
    ? base
    : { title: base.title, body: `${base.body} ${zh.failure.unknownCode(detail)}` };
}

export function EngineStatus({
  theme,
  state,
  onRefresh,
}: {
  theme: PluginTheme;
  state: EngineState | null;
  onRefresh: () => void;
}) {
  const kind = statusKind(state);
  const styles = useMemo(
    () => ({
      root: {
        margin: 12,
        padding: 14,
        gap: 8,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
      },
      title: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
      body: { color: theme.colors.foregroundMuted, fontSize: 13 },
      action: {
        alignSelf: "flex-start" as const,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
      },
      actionLabel: { color: theme.colors.foreground, fontWeight: "600" as const },
    }),
    [theme],
  );
  if (kind === null) return null;
  if (kind === "loading") {
    return (
      <View style={styles.root}>
        <Text style={styles.body}>{zh.loading}</Text>
      </View>
    );
  }
  const detail = state?.kind === "failure" ? state.detail : null;
  const copy = statusCopy(kind, detail);
  return (
    <View style={styles.root}>
      <Text style={styles.title}>{copy.title}</Text>
      <Text style={styles.body}>{copy.body}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={zh.refresh}
        onPress={onRefresh}
        style={styles.action}
      >
        <Text style={styles.actionLabel}>{zh.refresh}</Text>
      </Pressable>
    </View>
  );
}

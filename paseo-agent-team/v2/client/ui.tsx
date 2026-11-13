import type { PluginTheme } from "@getpaseo/plugin";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { BlockedReason, RunState } from "../shared/run";

export type Theme = PluginTheme;

const ThemeContext = createContext<Theme | null>(null);
export const ThemeProvider = ThemeContext.Provider;
export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error("ThemeProvider is missing");
  return theme;
}

export const STATE_LABEL: Record<RunState, string> = {
  writing: "写手工作中",
  gating: "验收中",
  reviewing: "审查中",
  ready: "待合并",
  blocked: "已停下",
  merged: "已合并",
  abandoned: "已放弃",
};

export const BLOCKED_LABEL: Record<BlockedReason, string> = {
  "gate-attempts-exhausted": "验收次数用完",
  "review-rounds-exhausted": "审查轮次用完",
  "writer-stopped-without-submit": "写手没提交就停了",
  "writer-asked-human": "写手在求助",
  "writer-worktree-changed-during-review": "审查期间写手的工作区变了",
  "review-setup-failed": "审查工作区建不起来",
  "agent-failed": "agent 出错",
  stalled: "长时间没有进展",
};

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const UNITS: [number, string][] = [
  [1440, "天"],
  [60, "小时"],
  [1, "分钟"],
];
export function ago(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  const [size, unit] = UNITS.find(([n]) => min >= n) ?? [1, "分钟"];
  return min < 1 ? "刚刚" : `${Math.round(min / size)} ${unit}前`;
}

export function stateColor(theme: Theme, state: RunState): string {
  const c = theme.colors;
  if (state === "blocked") return c.statusDanger;
  if (state === "ready") return c.statusSuccess;
  return state === "merged" || state === "abandoned" ? c.foregroundMuted : c.accent;
}

export function Txt(p: {
  children: ReactNode;
  muted?: boolean;
  bold?: boolean;
  size?: number;
  color?: string;
}) {
  const c = useTheme().colors;
  return (
    <Text
      selectable
      style={{
        color: p.color ?? (p.muted ? c.foregroundMuted : c.foreground),
        fontSize: p.size ?? 14,
        fontWeight: p.bold ? "600" : "400",
      }}
    >
      {p.children}
    </Text>
  );
}

export function Card({ children }: { children: ReactNode }) {
  const c = useTheme().colors;
  return (
    <View
      style={{
        backgroundColor: c.surface1,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 10,
        padding: 12,
        gap: 8,
      }}
    >
      {children}
    </View>
  );
}

export function Badge({ state }: { state: RunState }) {
  const color = stateColor(useTheme(), state);
  return (
    <View
      style={{
        borderColor: color,
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 2,
        alignSelf: "flex-start",
      }}
    >
      <Text style={{ color, fontSize: 12 }}>{STATE_LABEL[state]}</Text>
    </View>
  );
}

export function Btn(p: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "plain" | "danger";
  disabled?: boolean;
}) {
  const c = useTheme().colors;
  const primary = p.kind === "primary";
  const color = p.kind === "danger" ? c.statusDanger : primary ? c.accentForeground : c.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={p.label}
      disabled={p.disabled}
      onPress={p.onPress}
      style={{
        alignSelf: "flex-start",
        backgroundColor: primary ? c.accent : "transparent",
        borderColor: p.kind === "danger" ? c.statusDanger : primary ? c.accent : c.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        opacity: p.disabled ? 0.45 : 1,
      }}
    >
      <Text style={{ color, fontSize: 13 }}>{p.label}</Text>
    </Pressable>
  );
}

/** Loads now and again every `ms` while `keep` says the value can still change. `key` restarts it. */
export function usePoll<T>(
  load: () => Promise<T>,
  ms: number,
  keep: (v: T) => boolean,
  key: string,
) {
  const [state, setState] = useState<{ value?: T; error?: string }>({});
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  const keepRef = useRef(keep);
  loadRef.current = load;
  keepRef.current = keep;
  // biome-ignore lint/correctness/useExhaustiveDependencies: restarts on `key` and `nonce` only; the callbacks are read through refs
  useEffect(() => {
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let next = ms;
      try {
        const value = await loadRef.current();
        if (dead) return;
        setState({ value });
        if (!keepRef.current(value)) return;
      } catch (e) {
        if (dead) return;
        setState((s) => ({ ...s, error: errorText(e) }));
        next = ms * 2;
      }
      timer = setTimeout(tick, next);
    };
    void tick();
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [key, nonce, ms]);
  return { ...state, reload: () => setNonce((n) => n + 1) };
}

export const inputStyle = (theme: Theme) => ({
  color: theme.colors.foreground,
  borderColor: theme.colors.border,
  borderWidth: 1,
  borderRadius: 8,
  padding: 8,
});
export const ROW = { flexDirection: "row", flexWrap: "wrap", gap: 8 } as const;

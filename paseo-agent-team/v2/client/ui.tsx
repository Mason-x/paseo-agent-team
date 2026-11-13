import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginScreenProps, usePaseo } from "@getpaseo/plugin/client";
import { copyText, Icon, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { Pressable, Text, type TextStyle, View, type ViewStyle } from "react-native";
import { type BlockedReason, type RunState, reviewerModeProblem, SEATS } from "../shared/run";
import { type Profile, profileSpec, profilesFromConfig } from "./start-input";

export type Theme = PluginTheme;
export type Nav = PluginScreenProps["navigation"];

const ThemeContext = createContext<Theme | null>(null);
export const ThemeProvider = ThemeContext.Provider;
export const useTheme = (): Theme => {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error("ThemeProvider is missing");
  return theme;
};

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
export const short = (sha: string) => sha.slice(0, 8);
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

export const stateColor = (t: Theme, s: RunState) =>
  s === "blocked"
    ? t.colors.statusDanger
    : s === "ready"
      ? t.colors.statusSuccess
      : s === "merged" || s === "abandoned"
        ? t.colors.foregroundMuted
        : t.colors.accent;
export const runAccent = (s: RunState, c: Theme["colors"]) =>
  s === "blocked" ? c.statusDanger : s === "ready" ? c.statusSuccess : undefined;

const row: ViewStyle = { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" };
const bd = (borderColor: string, bg = "transparent", r = 8): ViewStyle => ({
  borderColor,
  borderWidth: 1,
  borderRadius: r,
  backgroundColor: bg,
});
export const Box = (p: { border?: string; bg?: string; children: ReactNode }) => {
  const c = useTheme().colors;
  return (
    <View style={{ ...bd(p.border ?? c.border, p.bg ?? c.surface0), padding: 10, gap: 8 }}>
      {p.children}
    </View>
  );
};

export function Input(p: {
  value: string;
  onChange: (v: string) => void;
  lines?: number;
  placeholder?: string;
}) {
  const c = useTheme().colors;
  const st = {
    ...bd(c.border, c.surface0),
    color: c.foreground,
    padding: 8,
    ...(p.lines ? { minHeight: p.lines * 20 } : {}),
  };
  return (
    <TextInput
      value={p.value}
      onChangeText={p.onChange}
      multiline={p.lines !== undefined}
      placeholder={p.placeholder}
      placeholderTextColor={c.foregroundMuted}
      autoCapitalize="none"
      autoCorrect={false}
      style={st}
    />
  );
}

export const Col = (p: { gap?: number; children: ReactNode }) => (
  <View style={{ gap: p.gap ?? 8 }}>{p.children}</View>
);
export const Field = (p: { label: string; children: ReactNode }) => (
  <Col gap={6}>
    <Txt muted size={12}>
      {p.label}
    </Txt>
    {p.children}
  </Col>
);
export function Row(p: { between?: boolean; flex?: boolean; children: ReactNode }) {
  const st = {
    ...row,
    ...(p.between && { justifyContent: "space-between" as const }),
    ...(p.flex && { flex: 1 }),
  };
  return <View style={st}>{p.children}</View>;
}

export function Txt(p: {
  children: ReactNode;
  muted?: boolean;
  bold?: boolean;
  mono?: boolean;
  size?: number;
  color?: string;
  lines?: number;
  flex?: boolean;
}) {
  const c = useTheme().colors;
  const style: TextStyle = {
    color: p.color ?? (p.muted ? c.foregroundMuted : c.foreground),
    fontSize: p.size ?? 14,
    fontWeight: p.bold ? "600" : "400",
    ...(p.mono ? { fontFamily: "monospace" } : {}),
    ...(p.flex ? { flex: 1 } : {}),
  };
  return (
    <Text selectable numberOfLines={p.lines} style={style}>
      {p.children}
    </Text>
  );
}

export function Card(p: { children: ReactNode; accent?: string }) {
  const c = useTheme().colors;
  const s: ViewStyle = {
    ...bd(c.border, c.surface1, 10),
    padding: 12,
    gap: 8,
    ...(p.accent ? { borderLeftWidth: 3, borderLeftColor: p.accent } : {}),
  };
  return <View style={s}>{p.children}</View>;
}

export function StatusPill(p: { label: string; color: string; dot?: boolean }) {
  const c = useTheme().colors;
  const st: ViewStyle = {
    ...row,
    ...bd(p.color, c.surface2, 999),
    alignSelf: "flex-start",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 2,
  };
  return (
    <View style={st}>
      {(p.dot ?? true) && (
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: p.color }} />
      )}
      <Text style={{ color: p.color, fontSize: 12, fontWeight: "500" }}>{p.label}</Text>
    </View>
  );
}

export const Badge = ({ state }: { state: RunState }) => (
  <StatusPill label={STATE_LABEL[state]} color={stateColor(useTheme(), state)} />
);

const stop = (fn: () => void) => (e: { stopPropagation?: () => void }) => {
  e?.stopPropagation?.();
  fn();
};

export function Chip(p: {
  label: string;
  sub?: string;
  on?: boolean;
  warn?: boolean;
  pill?: boolean;
  icon?: string;
  onPress: () => void;
  a11y?: string;
}) {
  const c = useTheme().colors;
  const fg = p.on ? c.accent : p.warn ? c.statusWarning : p.pill ? c.foregroundMuted : c.foreground;
  const border = p.on ? c.accent : p.warn ? c.statusWarning : c.border;
  const st: ViewStyle = {
    ...row,
    ...bd(border, p.on ? c.surface2 : "transparent", p.pill ? 999 : 8),
    gap: p.sub ? 1 : 5,
    paddingHorizontal: 10,
    paddingVertical: p.pill ? 4 : 5,
    ...(p.sub ? { flexDirection: "column", alignItems: "flex-start" } : {}),
  };
  const labelSt: TextStyle = {
    color: fg,
    fontSize: p.sub ? 13 : 12,
    fontWeight: p.on || p.warn ? "600" : "400",
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={p.a11y ?? p.label}
      accessibilityState={p.sub ? { selected: !!p.on } : undefined}
      onPress={stop(p.onPress)}
      style={st}
    >
      {p.icon && <Icon name={p.icon} size={13} color={p.on ? c.accent : c.foregroundMuted} />}
      <Text style={labelSt}>{p.label}</Text>
      {p.sub && <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{p.sub}</Text>}
    </Pressable>
  );
}

export function Btn(p: {
  label?: string;
  a11y?: string;
  onPress: () => void;
  kind?: "primary" | "plain" | "danger";
  icon?: string;
  sm?: boolean;
  disabled?: boolean;
}) {
  const c = useTheme().colors;
  const pri = p.kind === "primary";
  const color = p.kind === "danger" ? c.statusDanger : pri ? c.accentForeground : c.foreground;
  const bc = p.kind === "danger" ? c.statusDanger : pri ? c.accent : c.border;
  const style: ViewStyle = {
    ...row,
    ...bd(bc, pri ? c.accent : c.surface2),
    alignSelf: "flex-start",
    gap: 5,
    paddingHorizontal: p.label ? (p.sm ? 9 : 12) : 8,
    paddingVertical: p.sm ? 5 : 7,
    opacity: p.disabled ? 0.45 : 1,
  };
  const ts: TextStyle = { color, fontSize: p.sm ? 12 : 13, fontWeight: pri ? "600" : "500" };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={p.a11y ?? p.label}
      disabled={p.disabled}
      onPress={stop(p.onPress)}
      style={style}
    >
      {p.icon && <Icon name={p.icon} size={p.sm ? 13 : 14} color={color} />}
      {p.label && <Text style={ts}>{p.label}</Text>}
    </Pressable>
  );
}

export function CopyBtn(p: { text: string; label?: string; toastMsg?: string }) {
  const toast = useToast();
  const copy = () =>
    void copyText(p.text)
      .then(() => toast.show(p.toastMsg ?? "已复制到剪贴板", { variant: "success" }))
      .catch((e) => toast.error(errorText(e)));
  return <Btn sm icon="Copy" label={p.label ?? "复制"} onPress={copy} />;
}

export function ProfileChips(p: {
  profiles: Profile[];
  value?: Profile;
  onPick: (p: Profile) => void;
}) {
  if (!p.profiles.length)
    return (
      <Txt muted size={13}>
        没有可选的 Agent Profile：请先在 Paseo 设置里创建
      </Txt>
    );
  return (
    <Row>
      {p.profiles.map((item) => {
        const sub = `${item.provider}${item.model ? `/${item.model}` : ""}${item.modeId ? ` · ${item.modeId}` : ""}`;
        return (
          <Chip
            key={item.id}
            label={item.name}
            sub={sub}
            on={p.value?.id === item.id}
            a11y={`选择 ${item.name}`}
            onPress={() => p.onPick(item)}
          />
        );
      })}
    </Row>
  );
}

export function ReviewerSeats(p: {
  profiles: Profile[];
  reviewers: (Profile | undefined)[];
  onChange: (next: (Profile | undefined)[]) => void;
}) {
  const problems = p.reviewers.flatMap((r, i) =>
    r ? (reviewerModeProblem(`r${i + 1}`, profileSpec(r)) ?? []) : [],
  );
  const c = useTheme().colors;
  const pick = (i: number) => (picked: Profile) =>
    p.onChange(p.reviewers.map((x, j) => (j === i ? picked : x)));
  const rm = (i: number) => () => p.onChange(p.reviewers.filter((_, j) => j !== i));
  return (
    <Col>
      {SEATS.slice(0, p.reviewers.length).map((seat, i) => (
        <Field key={seat} label={`审查者 ${seat}（须是不逐次等人批准的模式）`}>
          <ProfileChips profiles={p.profiles} value={p.reviewers[i]} onPick={pick(i)} />
          {p.reviewers.length > 1 && <Btn sm label="移除" onPress={rm(i)} />}
        </Field>
      ))}
      {p.reviewers.length < 3 && (
        <Btn
          sm
          icon="Plus"
          label="添加审查者"
          onPress={() => p.onChange([...p.reviewers, undefined])}
        />
      )}
      {problems.length > 0 && (
        <Txt size={13} color={c.statusWarning}>
          {problems.join("；")}
        </Txt>
      )}
    </Col>
  );
}

export function useProfiles(active: boolean) {
  const paseo = usePaseo();
  const toast = useToast();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when active toggles
  useEffect(() => {
    if (!active) return;
    paseo.config
      .get()
      .then((r) => setProfiles(profilesFromConfig(r.config)))
      .catch((e) => toast.error(`读取 Agent Profile 失败：${errorText(e)}`));
  }, [active]);
  return profiles;
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
  const refs = useRef({ load, keep });
  refs.current = { load, keep };
  // biome-ignore lint/correctness/useExhaustiveDependencies: restarts on `key` and `nonce` only; callbacks read via refs
  useEffect(() => {
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const value = await refs.current.load();
        if (!dead) setState({ value });
        if (!dead && refs.current.keep(value)) timer = setTimeout(tick, ms);
      } catch (e) {
        if (!dead) {
          setState((s) => ({ ...s, error: errorText(e) }));
          timer = setTimeout(tick, ms * 2);
        }
      }
    };
    void tick();
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [key, nonce, ms]);
  return { ...state, reload: () => setNonce((n) => n + 1) };
}

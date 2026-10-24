import { Text, View } from "react-native";
import {
  type MemberState,
  type RunPhase,
  type RunProgress,
  visibleCountStates,
} from "../../shared/domain/run-progress";
import { zh } from "../../shared/zh";
import type { PluginTheme } from "../shared/theme";

type Colors = PluginTheme["colors"];

export const PHASE_LABELS: Record<RunPhase, string> = {
  starting: zh.phaseStarting,
  running: zh.phaseRunning,
  "needs-you": zh.phaseNeedsYou,
  failed: zh.phaseFailed,
  done: zh.phaseDone,
  idle: zh.phaseIdle,
};

export const MEMBER_STATE_LABELS: Record<MemberState, string> = {
  "needs-input": zh.memberNeedsInput,
  failed: zh.memberFailed,
  working: zh.memberWorking,
  delivered: zh.memberDelivered,
  "not-started": zh.memberNotStarted,
  closed: zh.memberClosed,
};

export function phaseColor(phase: RunPhase, colors: Colors): string {
  if (phase === "needs-you") return colors.statusWarning;
  if (phase === "failed") return colors.statusDanger;
  if (phase === "done") return colors.statusSuccess;
  if (phase === "running" || phase === "starting") return colors.accent;
  return colors.foregroundMuted;
}

export function memberStateColor(state: MemberState, colors: Colors): string {
  if (state === "needs-input") return colors.statusWarning;
  if (state === "failed") return colors.statusDanger;
  if (state === "delivered") return colors.statusSuccess;
  if (state === "working") return colors.accent;
  return colors.foregroundMuted;
}

/** Share of assigned members whose reply is in, or null before anyone has work. */
export function deliveredRatio(progress: RunProgress): number | null {
  return progress.assigned > 0 ? progress.delivered / progress.assigned : null;
}

export function PhaseBadge({ theme, phase }: { theme: PluginTheme; phase: RunPhase }) {
  const color = phaseColor(phase, theme.colors);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: 9,
        borderWidth: 1,
        borderColor: color,
      }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
      <Text style={{ color, fontSize: 11, fontWeight: "600" }}>{PHASE_LABELS[phase]}</Text>
    </View>
  );
}

export function MemberCounts({ theme, progress }: { theme: PluginTheme; progress: RunProgress }) {
  const parts = visibleCountStates(progress);
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
      {parts.map((state) => (
        <View key={state} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: memberStateColor(state, theme.colors),
            }}
          />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            {MEMBER_STATE_LABELS[state]} {progress.counts[state]}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function ProgressBar({ theme, value }: { theme: PluginTheme; value: number }) {
  const clamped = Math.max(0, Math.min(1, value));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
      style={{
        height: 4,
        borderRadius: 2,
        overflow: "hidden",
        backgroundColor: theme.colors.surface2,
      }}
    >
      <View
        style={{
          width: `${clamped * 100}%`,
          height: 4,
          borderRadius: 2,
          backgroundColor: clamped >= 1 ? theme.colors.statusSuccess : theme.colors.accent,
        }}
      />
    </View>
  );
}

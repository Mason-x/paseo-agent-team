import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type {
  ControlsView,
  NoticeTone,
  RetryOffer,
} from "../../../shared/domain/run-engine/controls";
import { runEngineZh as zh } from "../../../shared/zh/run-engine";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { ImeTextInput } from "../../shared/ImeTextInput";
import type { PluginTheme } from "../../shared/theme";
import type { ControlState } from "./control-runner";

export type EngineControlsProps = {
  theme: PluginTheme;
  view: ControlsView;
  state: ControlState;
  onReplan: (reason: string) => void;
  onRetry: (offer: RetryOffer) => void;
  onKick: () => void;
  onDismiss: () => void;
};

function noticeColor(theme: PluginTheme, tone: NoticeTone): string {
  if (tone === "success") return theme.colors.statusSuccess;
  if (tone === "danger") return theme.colors.statusDanger;
  if (tone === "warning") return theme.colors.statusWarning;
  return theme.colors.foregroundMuted;
}

function ActionButton({
  theme,
  label,
  disabled,
  onPress,
}: {
  theme: PluginTheme;
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        alignSelf: "flex-start",
        minHeight: 36,
        justifyContent: "center",
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontWeight: "600", flexShrink: 1 }}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The controls of one Run: ask for a new plan, retry a task that stopped, nudge the Run. Everything
 * offered comes from `view` (what the server named), nothing is guessed here. While one request is in
 * flight every button is disabled; the answer is said in words under the buttons.
 */
export function EngineControls(props: EngineControlsProps) {
  const { theme, view, state, onReplan, onRetry, onKick, onDismiss } = props;
  const [reason, setReason] = useState("");
  const [needReason, setNeedReason] = useState(false);
  const [confirming, setConfirming] = useState<RetryOffer | null>(null);
  const busy = state.pending !== null;

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
        padding: 12,
        gap: 12,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
        {zh.controls.title}
      </Text>
      {view.any ? null : (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{zh.noControls}</Text>
      )}

      {view.replan ? (
        <View style={{ gap: 6 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
            {zh.controls.replan.title}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {zh.controls.replan.help}
          </Text>
          <ImeTextInput
            accessibilityLabel={zh.controls.replan.reasonLabel}
            placeholder={zh.controls.replan.reasonPlaceholder}
            placeholderTextColor={theme.colors.foregroundMuted}
            multiline
            editable={!busy}
            onChangeText={(text: string) => {
              setReason(text);
              if (text.trim() !== "") setNeedReason(false);
            }}
            style={{
              minHeight: 56,
              borderWidth: 1,
              borderColor: theme.colors.border,
              borderRadius: 8,
              padding: 8,
              color: theme.colors.foreground,
            }}
          />
          {needReason ? (
            <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
              {zh.controls.replan.needReason}
            </Text>
          ) : null}
          <ActionButton
            theme={theme}
            label={zh.controls.replan.submit}
            disabled={busy}
            onPress={() => {
              if (reason.trim() === "") {
                setNeedReason(true);
                return;
              }
              onReplan(reason);
            }}
          />
        </View>
      ) : null}

      {view.retries.map((offer) => (
        <View key={offer.decisionId} style={{ gap: 4 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
            {[offer.categoryLabel, offer.subject].filter(Boolean).join(" · ")}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{offer.summary}</Text>
          <ActionButton
            theme={theme}
            label={`${zh.controls.retry.button} ${offer.subject ?? offer.categoryLabel}`}
            disabled={busy}
            onPress={() => setConfirming(offer)}
          />
        </View>
      ))}

      {view.kick ? (
        <View style={{ gap: 4 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
            {zh.controls.kick.title}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {zh.controls.kick.help}
          </Text>
          <ActionButton
            theme={theme}
            label={zh.controls.kick.button}
            disabled={busy}
            onPress={onKick}
          />
        </View>
      ) : null}

      {busy ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          {zh.controls.pending}
        </Text>
      ) : null}
      {state.notice ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={state.notice.text}
          onPress={onDismiss}
        >
          <Text style={{ color: noticeColor(theme, state.notice.tone), fontSize: 12 }}>
            {state.notice.text}
          </Text>
        </Pressable>
      ) : null}

      <ConfirmDialog
        theme={theme}
        open={confirming !== null}
        title={zh.controls.retry.confirmTitle}
        body={
          confirming === null
            ? ""
            : `${[confirming.categoryLabel, confirming.subject].filter(Boolean).join(" · ")}\n${confirming.explain}`
        }
        confirmLabel={zh.controls.retry.confirm}
        cancelLabel={zh.controls.retry.cancel}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const offer = confirming;
          setConfirming(null);
          if (offer !== null) onRetry(offer);
        }}
      />
    </View>
  );
}

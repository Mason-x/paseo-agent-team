import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import type {
  BudgetOffer,
  CancelOffer,
  ControlsView,
  NoticeTone,
  RetryOffer,
} from "../../../shared/domain/run-engine/controls";
import { runEngineZh as zh } from "../../../shared/zh/run-engine";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { ImeTextInput } from "../../shared/ImeTextInput";
import type { PluginTheme } from "../../shared/theme";
import { type ControlState, REASON_MAX_LENGTH } from "./control-runner";
import { type ControlUi, stillOffered } from "./control-ui";
import type { ReasonDrafts } from "./reason-drafts";

export type EngineControlsProps = {
  theme: PluginTheme;
  view: ControlsView;
  state: ControlState;
  /** What the person has typed as a reason, kept above this component (a poll can draw it off the screen). */
  drafts: ReasonDrafts;
  /** The turns typed for a seat and the open confirmation, kept above this component for the same reason. */
  ui: ControlUi;
  onReplan: (reason: string) => void;
  onRetry: (offer: RetryOffer) => void;
  onCancelTask: (offer: CancelOffer) => void;
  onCancelRun: (reason: string) => void;
  onAddBudget: (offer: BudgetOffer, by: number) => void;
  onKick: () => void;
  onPause: () => void;
  onResume: () => void;
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

/** One seat's budget: how many turns to add (1 to 64, 4 to begin with); the caller asks the confirmation. */
function BudgetRow({
  theme,
  offer,
  busy,
  ui,
  onAsk,
}: {
  theme: PluginTheme;
  offer: BudgetOffer;
  busy: boolean;
  ui: ControlUi;
  onAsk: (by: number) => void;
}) {
  const [bad, setBad] = useState(false);
  return (
    <View style={{ gap: 4 }}>
      <Text
        style={{
          color: offer.exhausted ? theme.colors.statusWarning : theme.colors.foreground,
          fontSize: 12,
        }}
      >
        {offer.line}
      </Text>
      <ImeTextInput
        accessibilityLabel={`${zh.controls.budget.byLabel} ${offer.seatId}`}
        initialValue={ui.budgetInitial(offer.seatId)}
        revision={ui.budgetRevision(offer.seatId)}
        keyboardType="number-pad"
        editable={!busy}
        onChangeText={(value: string) => {
          ui.budgetWrite(offer.seatId, value);
          setBad(false);
        }}
        style={{
          minHeight: 36,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 8,
          padding: 8,
          color: theme.colors.foreground,
        }}
      />
      {bad ? (
        <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
          {zh.controls.budget.invalid}
        </Text>
      ) : null}
      <ActionButton
        theme={theme}
        label={`${zh.controls.budget.button} ${offer.seatId}`}
        disabled={busy}
        onPress={() => {
          const by = Number(ui.budgetRead(offer.seatId).trim());
          if (!Number.isInteger(by) || by < 1 || by > 64) {
            setBad(true);
            return;
          }
          onAsk(by);
        }}
      />
    </View>
  );
}

/**
 * The controls of one Run: ask for a new plan, retry a task that stopped, nudge the Run. Everything
 * offered comes from `view` (what the server named), nothing is guessed here. While one request is in
 * flight every button is disabled; the answer is said in words under the buttons.
 */
export function EngineControls(props: EngineControlsProps) {
  const {
    theme,
    view,
    state,
    drafts,
    ui,
    onReplan,
    onRetry,
    onCancelTask,
    onCancelRun,
    onAddBudget,
    onKick,
    onPause,
    onResume,
    onDismiss,
  } = props;
  const [needReason, setNeedReason] = useState(false);
  const [needCancelReason, setNeedCancelReason] = useState(false);
  const open = useSyncExternalStore(ui.subscribe, ui.open);
  // An offer that went away while a confirmation for it was open (answered elsewhere, no longer
  // exhausted) takes the confirmation with it; it must not open again if the offer comes back.
  useEffect(() => {
    if (open !== null && !stillOffered(view, open)) ui.close();
  }, [open, view, ui]);
  const confirming: RetryOffer | null =
    open?.kind === "retry"
      ? (view.retries.find((offer) => offer.decisionId === open.decisionId) ?? null)
      : null;
  const confirmingCancel: CancelOffer | null =
    open?.kind === "cancel-task"
      ? (view.cancels.find((offer) => offer.decisionId === open.decisionId) ?? null)
      : null;
  const confirmingBudget =
    open?.kind === "budget"
      ? { offer: view.budgets.find((offer) => offer.seatId === open.seatId) ?? null, by: open.by }
      : null;
  const confirmingRun = open?.kind === "cancel-run" && view.cancelRun;
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
            maxLength={REASON_MAX_LENGTH}
            editable={!busy}
            initialValue={drafts.initial("replan")}
            revision={drafts.revision("replan")}
            onChangeText={(text: string) => {
              drafts.write("replan", text);
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
              const reason = drafts.read("replan");
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
            onPress={() => ui.ask({ kind: "retry", decisionId: offer.decisionId })}
          />
        </View>
      ))}

      {view.cancels.map((offer) => (
        <View key={`cancel-${offer.decisionId}`} style={{ gap: 4 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
            {[offer.categoryLabel, offer.subject].filter(Boolean).join(" · ")}
          </Text>
          <ActionButton
            theme={theme}
            label={`${zh.controls.cancelTask.button} ${offer.subject ?? offer.categoryLabel}`}
            disabled={busy}
            onPress={() => ui.ask({ kind: "cancel-task", decisionId: offer.decisionId })}
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

      {view.pause ? (
        <View style={{ gap: 4 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
            {zh.controls.pause.title}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {zh.controls.pause.help}
          </Text>
          <ActionButton
            theme={theme}
            label={zh.controls.pause.button}
            disabled={busy}
            onPress={onPause}
          />
        </View>
      ) : null}

      {view.resume ? (
        <View style={{ gap: 4 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
            {zh.controls.resume.title}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {zh.controls.resume.help}
          </Text>
          <ActionButton
            theme={theme}
            label={zh.controls.resume.button}
            disabled={busy}
            onPress={onResume}
          />
        </View>
      ) : null}

      {view.budgets.length > 0 ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
            {zh.controls.budget.title}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {zh.controls.budget.help}
          </Text>
          {view.budgets.map((offer) => (
            <BudgetRow
              key={offer.seatId}
              theme={theme}
              offer={offer}
              busy={busy}
              ui={ui}
              onAsk={(by) => ui.ask({ kind: "budget", seatId: offer.seatId, by })}
            />
          ))}
        </View>
      ) : null}

      {view.cancelRun ? (
        <View style={{ gap: 6 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
            {zh.controls.cancelRun.title}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {zh.controls.cancelRun.help}
          </Text>
          <ImeTextInput
            accessibilityLabel={zh.controls.cancelRun.reasonLabel}
            placeholder={zh.controls.cancelRun.reasonPlaceholder}
            placeholderTextColor={theme.colors.foregroundMuted}
            multiline
            maxLength={REASON_MAX_LENGTH}
            editable={!busy}
            initialValue={drafts.initial("cancel-run")}
            revision={drafts.revision("cancel-run")}
            onChangeText={(text: string) => {
              drafts.write("cancel-run", text);
              if (text.trim() !== "") setNeedCancelReason(false);
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
          {needCancelReason ? (
            <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
              {zh.controls.cancelRun.needReason}
            </Text>
          ) : null}
          <ActionButton
            theme={theme}
            label={zh.controls.cancelRun.submit}
            disabled={busy}
            onPress={() => {
              if (drafts.read("cancel-run").trim() === "") {
                setNeedCancelReason(true);
                return;
              }
              ui.ask({ kind: "cancel-run" });
            }}
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
        onCancel={() => ui.close()}
        onConfirm={() => {
          const offer = confirming;
          ui.close();
          if (offer !== null) onRetry(offer);
        }}
      />
      <ConfirmDialog
        theme={theme}
        open={confirmingRun}
        title={zh.controls.cancelRun.confirmTitle}
        body={zh.controls.cancelRun.help}
        confirmLabel={zh.controls.cancelRun.confirm}
        cancelLabel={zh.controls.cancelRun.cancel}
        onCancel={() => ui.close()}
        onConfirm={() => {
          ui.close();
          onCancelRun(drafts.read("cancel-run"));
        }}
      />
      <ConfirmDialog
        theme={theme}
        open={confirmingCancel !== null}
        title={zh.controls.cancelTask.confirmTitle}
        body={
          confirmingCancel === null
            ? ""
            : `${[confirmingCancel.categoryLabel, confirmingCancel.subject].filter(Boolean).join(" · ")}\n${confirmingCancel.explain}\n${
                confirmingCancel.downstream.length === 0
                  ? zh.controls.cancelTask.noDownstream
                  : zh.controls.cancelTask.downstream(confirmingCancel.downstream.join("、"))
              }`
        }
        confirmLabel={zh.controls.cancelTask.confirm}
        cancelLabel={zh.controls.cancelTask.cancel}
        onCancel={() => ui.close()}
        onConfirm={() => {
          const offer = confirmingCancel;
          ui.close();
          if (offer !== null) onCancelTask(offer);
        }}
      />
      <ConfirmDialog
        theme={theme}
        open={confirmingBudget?.offer != null}
        title={zh.controls.budget.confirmTitle}
        body={
          confirmingBudget?.offer == null
            ? ""
            : zh.controls.budget.willBe(
                confirmingBudget.offer.seatId,
                confirmingBudget.by,
                confirmingBudget.offer.limit + confirmingBudget.by,
              )
        }
        confirmLabel={zh.controls.budget.confirm}
        cancelLabel={zh.controls.budget.cancel}
        onCancel={() => ui.close()}
        onConfirm={() => {
          const held = confirmingBudget;
          ui.close();
          if (held?.offer != null) onAddBudget(held.offer, held.by);
        }}
      />
    </View>
  );
}

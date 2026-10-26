import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PresetAction, PresetSelection } from "../../shared/domain/catalog-content";
import type { PresetRolePreview } from "../../shared/schemas/default-catalog";
import { zh } from "../../shared/zh";
import { ModalActions } from "../shared/buttons";
import type { PluginLayout, PluginTheme } from "../shared/theme";
import {
  type PresetGateway,
  type PresetSyncResult,
  type PreviewSuccess,
  previewFailureMessage,
  syncDefaultPresets,
} from "./preset-service";
import {
  allowedPresetActions,
  countBindingReport,
  countPresetActions,
  defaultPresetSelection,
} from "./preset-state";

type PreviewState =
  | { kind: "loading" }
  | { kind: "ready"; preview: PreviewSuccess }
  | { kind: "error"; message: string };

const GROUPS = [
  { kind: "missing", label: zh.defaultPresetsMissing },
  { kind: "changed", label: zh.defaultPresetsChanged },
  { kind: "deleted", label: zh.defaultPresetsDeleted },
  { kind: "id-collision", label: zh.defaultPresetsCollision },
] as const;

export function PresetSyncDialog({
  theme,
  layout,
  open,
  gateway,
  onClose,
  onSynced,
}: {
  theme: PluginTheme;
  layout: PluginLayout;
  open: boolean;
  gateway: PresetGateway;
  onClose: () => void;
  onSynced: (wroteRoles: boolean) => void;
}) {
  const [state, setState] = useState<PreviewState>({ kind: "loading" });
  const [selection, setSelection] = useState<PresetSelection>({});
  const [sameOpen, setSameOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const gatewayRef = useRef(gateway);
  gatewayRef.current = gateway;

  useEffect(() => {
    if (!open) return;
    let active = true;
    setState({ kind: "loading" });
    setSubmitting(false);
    setSameOpen(false);
    setPromptOpen(null);
    setMessage(null);
    void gatewayRef.current
      .preview(false)
      .then((preview) => {
        if (!active) return;
        if (!preview.ok) {
          setState({ kind: "error", message: previewFailureMessage(preview.blockers) });
          return;
        }
        setState({ kind: "ready", preview });
        setSelection(defaultPresetSelection(preview.roles));
        setSubmitting(false);
      })
      .catch(() => {
        if (active) setState({ kind: "error", message: zh.defaultPresetsLoadFail });
      });
    return () => {
      active = false;
    };
  }, [open]);

  const styles = useMemo(
    () => ({
      root: { gap: layout.compact ? 10 : 14 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      warning: { color: theme.colors.statusWarning, fontSize: 12 },
      summary: {
        gap: 4,
        padding: 10,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      },
      group: { gap: 6 },
      groupHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
        minHeight: 28,
      },
      groupTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      row: {
        gap: 6,
        padding: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      },
      rowMain: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      rowTitle: {
        color: theme.colors.foreground,
        fontSize: 13,
        fontWeight: "600" as const,
        flex: 1,
      },
      fields: { color: theme.colors.foregroundMuted, fontSize: 11 },
      actions: { flexDirection: "row" as const, gap: 6, flexWrap: "wrap" as const },
      chip: {
        minHeight: 28,
        paddingHorizontal: 10,
        borderRadius: 7,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      },
      chipSelected: { borderColor: theme.colors.accent, backgroundColor: theme.colors.surface0 },
      chipLabel: { color: theme.colors.foregroundMuted, fontSize: 12 },
      chipLabelSelected: { color: theme.colors.accent, fontWeight: "600" as const },
      check: {
        width: 22,
        height: 22,
        borderRadius: 5,
        borderWidth: 1,
        borderColor: theme.colors.border,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      checkOn: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accent },
      prompt: {
        padding: 8,
        gap: 6,
        borderRadius: 7,
        backgroundColor: theme.colors.surface0,
      },
      promptLabel: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "600" as const,
      },
      promptText: { color: theme.colors.foreground, fontSize: 12 },
      link: { color: theme.colors.accent, fontSize: 12, fontWeight: "600" as const },
      sameRow: { color: theme.colors.foregroundMuted, fontSize: 12 },
    }),
    [layout.compact, theme],
  );

  function actionOf(row: PresetRolePreview): PresetAction {
    return selection[row.id] ?? row.defaultAction;
  }

  function setAction(row: PresetRolePreview, action: PresetAction) {
    setSelection((current) => ({ ...current, [row.id]: action }));
  }

  async function confirm() {
    if (state.kind !== "ready" || submitting) return;
    setSubmitting(true);
    setMessage(null);
    let result: PresetSyncResult;
    try {
      result = await syncDefaultPresets(gateway, {
        preview: state.preview,
        selection,
        now: new Date().toISOString(),
      });
    } catch {
      setSubmitting(false);
      setMessage(zh.defaultPresetsSettingsUnavailable);
      return;
    }
    setSubmitting(false);
    if (result.kind === "synced") {
      onSynced(result.wroteRoles);
      onClose();
      return;
    }
    if (result.kind === "needs-confirmation") {
      setState({ kind: "ready", preview: result.preview });
      setSelection(result.selection);
    }
    setMessage(result.message);
  }

  const preview = state.kind === "ready" ? state.preview : null;
  const binding = preview ? countBindingReport(preview.bindingReport) : { unbound: 0, runtime: 0 };
  const counts = preview ? countPresetActions(preview.roles, selection) : { add: 0, adopt: 0 };
  const sameRows = preview?.roles.filter((row) => row.kind === "same") ?? [];

  return (
    <Modal title={zh.syncDefaultPresets} open={open} onOpenChange={(next) => !next && onClose()}>
      <Modal.Content>
        <View style={styles.root}>
          {state.kind === "loading" ? (
            <Text style={styles.muted}>{zh.defaultPresetsLoading}</Text>
          ) : null}
          {state.kind === "error" ? (
            <Text style={styles.error}>{state.message || zh.defaultPresetsLoadFail}</Text>
          ) : null}
          {message ? <Text style={styles.error}>{message}</Text> : null}
          {preview ? (
            <>
              <View style={styles.summary}>
                <Text style={styles.muted}>{zh.defaultPresetsUnboundCount(binding.unbound)}</Text>
                {binding.runtime > 0 ? (
                  <Text style={styles.muted}>{zh.defaultPresetsRuntimeCount(binding.runtime)}</Text>
                ) : null}
                {preview.warnings
                  .filter(
                    (warning) =>
                      warning !== zh.defaultPresetsUnboundCount(binding.unbound) &&
                      warning !== zh.defaultPresetsRuntimeCount(binding.runtime),
                  )
                  .map((warning) => (
                    <Text key={warning} style={styles.warning}>
                      {warning}
                    </Text>
                  ))}
              </View>

              {GROUPS.map((group) => {
                const rows = preview.roles.filter((row) => row.kind === group.kind);
                if (rows.length === 0) return null;
                return (
                  <View key={group.kind} style={styles.group}>
                    <Text style={styles.groupTitle}>
                      {group.label} ({rows.length})
                    </Text>
                    {rows.map((row) => {
                      const action = actionOf(row);
                      const allowed = allowedPresetActions(row);
                      const isAdd = !row.before;
                      const checkable = isAdd && allowed.includes("add");
                      const promptOpenHere = promptOpen === row.id;
                      return (
                        <View key={row.id} style={styles.row}>
                          <View style={styles.rowMain}>
                            <Text style={styles.rowTitle} numberOfLines={2}>
                              {row.candidate.name}
                            </Text>
                            {checkable ? (
                              <Pressable
                                accessibilityRole="checkbox"
                                accessibilityLabel={`${group.label} ${row.candidate.name}`}
                                accessibilityState={{ checked: action === "add" }}
                                onPress={() => setAction(row, action === "add" ? "skip" : "add")}
                                style={[styles.check, action === "add" && styles.checkOn]}
                              >
                                {action === "add" ? (
                                  <Icon
                                    name="Check"
                                    size={14}
                                    color={theme.colors.accentForeground}
                                  />
                                ) : null}
                              </Pressable>
                            ) : null}
                          </View>
                          {row.changedFields.length > 0 ? (
                            <Text style={styles.fields}>{row.changedFields.join("、")}</Text>
                          ) : null}
                          {row.kind === "id-collision" ? (
                            <Text style={styles.muted}>{zh.defaultPresetsKeep}</Text>
                          ) : null}
                          {row.before && row.kind === "changed" ? (
                            <View style={styles.actions}>
                              <Pressable
                                accessibilityRole="button"
                                accessibilityState={{ selected: action === "keep" }}
                                onPress={() => setAction(row, "keep")}
                                style={[styles.chip, action === "keep" && styles.chipSelected]}
                              >
                                <Text
                                  style={[
                                    styles.chipLabel,
                                    action === "keep" && styles.chipLabelSelected,
                                  ]}
                                >
                                  {zh.defaultPresetsKeep}
                                </Text>
                              </Pressable>
                              <Pressable
                                accessibilityRole="button"
                                accessibilityState={{ selected: action === "adopt" }}
                                onPress={() => setAction(row, "adopt")}
                                style={[styles.chip, action === "adopt" && styles.chipSelected]}
                              >
                                <Text
                                  style={[
                                    styles.chipLabel,
                                    action === "adopt" && styles.chipLabelSelected,
                                  ]}
                                >
                                  {zh.defaultPresetsAdopt}
                                </Text>
                              </Pressable>
                            </View>
                          ) : null}
                          {row.changedFields.includes("systemPrompt") && row.before ? (
                            <>
                              <Pressable
                                accessibilityRole="button"
                                onPress={() => setPromptOpen(promptOpenHere ? null : row.id)}
                              >
                                <Text style={styles.link}>
                                  {promptOpenHere
                                    ? zh.defaultPresetsHidePrompt
                                    : zh.defaultPresetsShowPrompt}
                                </Text>
                              </Pressable>
                              {promptOpenHere ? (
                                <View style={styles.prompt}>
                                  <Text style={styles.promptLabel}>{zh.defaultPresetsBefore}</Text>
                                  <Text selectable style={styles.promptText}>
                                    {row.before.systemPrompt}
                                  </Text>
                                  <Text style={styles.promptLabel}>{zh.defaultPresetsAfter}</Text>
                                  <Text selectable style={styles.promptText}>
                                    {row.candidate.systemPrompt}
                                  </Text>
                                </View>
                              ) : null}
                            </>
                          ) : null}
                        </View>
                      );
                    })}
                  </View>
                );
              })}

              {sameRows.length > 0 ? (
                <View style={styles.group}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: sameOpen }}
                    onPress={() => setSameOpen((value) => !value)}
                    style={styles.groupHeader}
                  >
                    <Text style={styles.groupTitle}>
                      {zh.defaultPresetsSame} ({sameRows.length})
                    </Text>
                    <Icon
                      name={sameOpen ? "ChevronUp" : "ChevronDown"}
                      size={14}
                      color={theme.colors.foregroundMuted}
                    />
                  </Pressable>
                  {sameOpen
                    ? sameRows.map((row) => (
                        <Text key={row.id} style={styles.sameRow}>
                          {row.candidate.name}
                        </Text>
                      ))
                    : null}
                </View>
              ) : null}

              <Text style={styles.muted}>{zh.defaultPresetsSummary(counts.add, counts.adopt)}</Text>
              <ModalActions
                theme={theme}
                confirmLabel={submitting ? zh.saving : zh.defaultPresetsApply}
                confirmDisabled={submitting}
                onCancel={onClose}
                onConfirm={() => void confirm()}
              />
            </>
          ) : null}
          {state.kind === "error" ? (
            <ModalActions
              theme={theme}
              confirmLabel={zh.retry}
              onCancel={onClose}
              onConfirm={() => {
                setState({ kind: "loading" });
                void gateway
                  .preview(false)
                  .then((next) => {
                    if (!next.ok) {
                      setState({ kind: "error", message: previewFailureMessage(next.blockers) });
                      return;
                    }
                    setState({ kind: "ready", preview: next });
                    setSelection(defaultPresetSelection(next.roles));
                  })
                  .catch(() => setState({ kind: "error", message: zh.defaultPresetsLoadFail }));
              }}
            />
          ) : null}
        </View>
      </Modal.Content>
    </Modal>
  );
}

import { Icon } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  checkDesignRequest,
  DESIGN_REQUEST_MAX_CODE_POINTS,
} from "../../shared/domain/design-request";
import { LAUNCH_RUNTIME_CAPABILITIES } from "../../shared/domain/launch-runtime";
import type { PaseoAdapter, PaseoProfile } from "../../shared/paseo/adapter";
import type { DesignJob, DesignStartInput, DesignStartOutput } from "../../shared/schemas/design";
import type { TeamMode } from "../../shared/schemas/team-mode";
import { zh } from "../../shared/zh";
import { designZh } from "../../shared/zh/design";
import { CompactPicker } from "../shared/CompactPicker";
import { Field, inputStyle } from "../shared/Field";
import { ImeTextInput } from "../shared/ImeTextInput";
import { TeamModePicker } from "../shared/TeamModePicker";
import type { PluginLayout, PluginTheme } from "../shared/theme";
import {
  type FoldChoice,
  resolveCollapsed,
  resolveDesignerProfile,
  resolveFoldOnInput,
  resolveSelection,
  resolveStartBlock,
  type StartBlock,
} from "./card-state";
import {
  type DesignerPrefill,
  designStartFailureMessage,
  shouldWarnOnlyWorkspace,
} from "./design-screen-state";
import {
  createDesignSubmissionController,
  type DesignDraft,
  type DesignSubmissionController,
  type DesignSubmissionState,
} from "./submission-state";
import { useDesignerWorkspaces } from "./use-designer-workspaces";

export type DesignerStartInput = DesignStartInput;

export type DesignerSummaryTone = "neutral" | "attention" | "danger";

export type TeamDesignerCardProps = {
  theme: PluginTheme;
  layout: PluginLayout;
  /** Used to list target workspaces while the card is open; no other host data is fetched. */
  adapter: PaseoAdapter;
  hostId: string;
  /** Host Profiles the design agent may run on. */
  profiles: readonly PaseoProfile[];
  profilesLoading?: boolean;
  profilesError?: string;
  onRefreshProfiles?: () => void;
  /** Preselected until the user picks; ignored while the host no longer lists it. */
  defaultProfileId?: string;
  /** Initial Team mode; the designer keeps the user's later choice. */
  mode?: TeamMode;
  /** Notifies the screen when the user changes the design mode. */
  onModeChange?: (mode: TeamMode) => void;
  /** Seeds the request box, and re-seeds it whenever the value changes. */
  initialRequest?: string;
  /** Seeds the target workspace, and re-seeds it whenever the value changes. */
  initialWorkspaceId?: string;
  /** One-shot `/team-design` prefill; consumed by nonce, never by re-render. */
  prefill?: DesignerPrefill;
  /** A hard reason the designer cannot start right now; disables the button and is shown beside it. */
  disabledReason?: string;
  /** Absent means the designer is not wired up yet: the button stays disabled with a notice. */
  onStart?: (input: DesignerStartInput) => Promise<DesignStartOutput>;
  /** Called after a start is accepted, before the job finishes. */
  onAccepted?: (job: DesignJob) => void;
  /** Fold the card to one line until the user opens it. The user's own choice then sticks. */
  collapseByDefault?: boolean;
  /** One line shown in the folded header, e.g. the latest design stage. */
  collapsedSummary?: string;
  collapsedSummaryTone?: DesignerSummaryTone;
  /** Progress and result cards. Stays mounted while the card is folded. */
  children?: ReactNode;
};

function profileSubtitle(profile: PaseoProfile): string {
  return profile.model ? `${profile.provider}/${profile.model}` : profile.provider;
}

type PickerItem = { id: string; name: string; subtitle?: string };

export function TeamDesignerCard({
  theme,
  layout,
  adapter,
  hostId,
  profiles,
  profilesLoading = false,
  profilesError,
  onRefreshProfiles,
  defaultProfileId,
  mode,
  onModeChange,
  initialRequest,
  initialWorkspaceId,
  prefill,
  disabledReason,
  onStart,
  onAccepted,
  collapseByDefault = false,
  collapsedSummary,
  collapsedSummaryTone = "neutral",
  children,
}: TeamDesignerCardProps) {
  const startRef = useRef(onStart);
  startRef.current = onStart;
  const startCall = useCallback(
    (input: DesignerStartInput): Promise<DesignStartOutput> =>
      startRef.current
        ? startRef.current(input)
        : Promise.reject(new Error(zh.designerUnavailable)),
    [],
  );
  const controllerRef = useRef<DesignSubmissionController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createDesignSubmissionController({
      start: startCall,
      initialDraft: {
        request: initialRequest ?? "",
        mode: mode ?? "sota",
        workspaceId: initialWorkspaceId ?? "",
        profileChoice: null,
      },
    });
  }
  const controller = controllerRef.current;
  const [submission, setSubmission] = useState<DesignSubmissionState>(() => controller.getState());
  const [fold, setFold] = useState<FoldChoice>(initialRequest === undefined ? null : "expanded");
  const [startError, setStartError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const seeded = useRef({ request: initialRequest, workspaceId: initialWorkspaceId });
  const seenPrefill = useRef<string | null>(null);
  const draft = submission.draftState.draft;
  const request = draft.request;
  const profileChoice = draft.profileChoice;
  const submitting = submission.submitting;

  function syncSubmission() {
    setSubmission(controller.getState());
  }

  /** Typing keeps the native input mounted: only the draft identity changes. */
  function editDraft(patch: Partial<DesignDraft>) {
    controller.edit(patch);
    syncSubmission();
    setStartError(null);
  }

  const applyPrefill = useCallback(
    (next: DesignerPrefill) => {
      const current = controller.getState().draftState.draft;
      controller.prefill({
        request: next.text,
        workspaceId: next.workspaceId ?? "",
        mode: next.mode ?? current.mode,
        profileChoice: current.profileChoice,
      });
      setSubmission(controller.getState());
      setFold("expanded");
    },
    [controller],
  );

  // The nonce is the one-shot guard; re-rendering with the same prefill never reseeds the draft.
  useEffect(() => {
    if (!prefill || seenPrefill.current === prefill.nonce) return;
    seenPrefill.current = prefill.nonce;
    applyPrefill(prefill);
  }, [applyPrefill, prefill]);

  useEffect(() => {
    if (prefill !== undefined) return;
    const previous = seeded.current;
    seeded.current = { request: initialRequest, workspaceId: initialWorkspaceId };
    if (initialRequest === undefined && initialWorkspaceId === undefined) return;
    const current = controller.getState().draftState.draft;
    const nextRequest =
      initialRequest !== undefined && initialRequest !== previous.request
        ? initialRequest
        : undefined;
    const nextWorkspace =
      initialWorkspaceId !== undefined && initialWorkspaceId !== previous.workspaceId
        ? initialWorkspaceId
        : undefined;
    if (nextRequest === undefined && nextWorkspace === undefined) return;
    controller.prefill({
      request: nextRequest ?? current.request,
      workspaceId: nextWorkspace ?? current.workspaceId,
      mode: current.mode,
      profileChoice: current.profileChoice,
    });
    setSubmission(controller.getState());
    setFold("expanded");
  }, [controller, initialRequest, initialWorkspaceId, prefill]);

  const collapsed = resolveCollapsed(collapseByDefault, fold);
  const workspaceQuery = useDesignerWorkspaces(adapter, hostId, !collapsed);
  const check = useMemo(() => checkDesignRequest(request), [request]);
  const tooLong = !check.ok && check.reason === "too-long";
  const workspace = resolveSelection(
    draft.workspaceId,
    workspaceQuery.workspaces,
    !workspaceQuery.loaded || workspaceQuery.loading || Boolean(workspaceQuery.error),
  );
  const onlyWorkspaceWarning =
    !workspaceQuery.loading &&
    !workspaceQuery.error &&
    shouldWarnOnlyWorkspace(
      workspaceQuery.workspaces.map((entry) => entry.id),
      workspace.id,
    );
  const profile = resolveDesignerProfile(
    profileChoice,
    defaultProfileId,
    profiles,
    profilesLoading,
  );
  const effectiveDisabledReason =
    draft.mode === "collaborative" && !LAUNCH_RUNTIME_CAPABILITIES.collaboration
      ? designZh.modeUnavailable
      : disabledReason;
  const block = resolveStartBlock({
    hasStartHandler: onStart !== undefined,
    disabledReason: effectiveDisabledReason,
    submitting,
    request: check,
    workspaceMissing: workspace.missing,
    profileMissing: profile.missing,
    profilesLoading,
  });

  const workspaceItems = useMemo<PickerItem[]>(
    () => [
      { id: "", name: zh.designerWorkspaceNone },
      ...workspaceQuery.workspaces.map((entry) => ({
        id: entry.id,
        name: entry.name,
        subtitle: entry.projectName ?? entry.directory,
      })),
    ],
    [workspaceQuery.workspaces],
  );
  const profileItems = useMemo<PickerItem[]>(
    () => [
      { id: "", name: zh.designerProfileAuto },
      ...profiles.map((entry) => ({
        id: entry.id,
        name: entry.name,
        subtitle: profileSubtitle(entry),
      })),
    ],
    [profiles],
  );

  const compact = layout.compact;
  const styles = useMemo(
    () => ({
      card: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
        padding: compact ? 10 : 12,
        gap: 10,
      },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        minHeight: 28,
      },
      headerText: {
        flex: 1,
        minWidth: 0,
        flexDirection: "row" as const,
        alignItems: "baseline" as const,
        gap: 8,
      },
      title: {
        color: theme.colors.foreground,
        fontSize: 15,
        fontWeight: "600" as const,
        flexShrink: 0,
      },
      summary: { flexShrink: 1, fontSize: 12, color: theme.colors.foregroundMuted },
      summaryAttention: { color: theme.colors.statusWarning, fontWeight: "600" as const },
      summaryDanger: { color: theme.colors.statusDanger, fontWeight: "600" as const },
      hidden: { display: "none" as const },
      body: { gap: 10 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      warning: { color: theme.colors.statusWarning, fontSize: 12 },
      danger: { color: theme.colors.statusDanger, fontSize: 12 },
      input: {
        ...inputStyle(theme, { error: tooLong, multiline: true }),
        minHeight: compact ? 80 : 96,
        maxHeight: 240,
      },
      metaRow: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 8 },
      metaHint: { flex: 1, minWidth: 0 },
      pickers: { flexDirection: compact ? ("column" as const) : ("row" as const), gap: 10 },
      picker: compact ? undefined : { flex: 1, minWidth: 0 },
      actions: compact
        ? { gap: 8 }
        : {
            flexDirection: "row" as const,
            alignItems: "center" as const,
            justifyContent: "flex-end" as const,
            gap: 12,
          },
      note: compact ? undefined : { flex: 1, minWidth: 0 },
      button: {
        minHeight: 36,
        paddingHorizontal: 16,
        borderRadius: 8,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        gap: 6,
        backgroundColor: theme.colors.accent,
        flexShrink: 0,
      },
      buttonLabel: {
        color: theme.colors.accentForeground,
        fontWeight: "600" as const,
        fontSize: 14,
      },
      retry: { color: theme.colors.accent, fontWeight: "600" as const, fontSize: 12 },
      children: { gap: 8 },
    }),
    [compact, theme, tooLong],
  );

  function blockText(reason: StartBlock): string | null {
    switch (reason) {
      case "unavailable":
        return zh.designerUnavailable;
      case "disabled":
        return effectiveDisabledReason ?? null;
      case "request-empty":
        return zh.designerRequestEmpty;
      case "request-too-long":
        return !check.ok && check.reason === "too-long"
          ? zh.designerRequestTooLong(check.excess)
          : null;
      case "workspace-missing":
        return zh.designerWorkspaceMissing;
      case "profile-missing":
        return zh.designerProfileMissing;
      case "profiles-loading":
        return zh.loadingProfiles;
      case "submitting":
        return zh.designerStarting;
    }
  }

  function toggle() {
    setFold(collapsed ? "expanded" : "collapsed");
  }

  async function start() {
    if (block !== null || !onStart || !check.ok || submittingRef.current) return;
    submittingRef.current = true;
    setStartError(null);
    // The new Team will land in the list below; do not fold the card the user is working in.
    if (fold === null && !collapsed) setFold("expanded");
    const running = controller.submit();
    syncSubmission();
    try {
      const result = await running;
      syncSubmission();
      if (result.kind === "accepted") {
        onAccepted?.(result.job);
      } else if (result.kind === "rejected") {
        setStartError(designStartFailureMessage(result.issues));
      } else if (result.kind === "unknown") {
        setStartError(designZh.startUnknown);
      }
    } catch {
      setStartError(zh.designerStartFail);
    } finally {
      submittingRef.current = false;
      syncSubmission();
    }
  }

  const requestHint =
    !check.ok && check.reason === "empty"
      ? { text: zh.designerRequestEmpty, style: styles.muted }
      : !check.ok
        ? { text: zh.designerRequestTooLong(check.excess), style: styles.danger }
        : null;
  // Field-level reasons already sit under their own control; the button note carries the rest.
  const note =
    block === "unavailable" || block === "disabled" || block === "profiles-loading"
      ? blockText(block)
      : null;
  const summaryStyle = [
    styles.summary,
    collapsedSummaryTone === "attention" && styles.summaryAttention,
    collapsedSummaryTone === "danger" && styles.summaryDanger,
  ];
  const disabled = block !== null;
  const buttonHint = block ? (blockText(block) ?? undefined) : undefined;

  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={zh.designerTitle}
        accessibilityHint={collapsed ? zh.expand : zh.collapse}
        accessibilityState={{ expanded: !collapsed }}
        onPress={toggle}
        style={styles.header}
      >
        <Icon name="Sparkles" size={16} color={theme.colors.accent} />
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={1}>
            {zh.designerTitle}
          </Text>
          {collapsed ? (
            <Text style={summaryStyle} numberOfLines={1}>
              {collapsedSummary ?? zh.designerCollapsedHint}
            </Text>
          ) : null}
        </View>
        <Icon
          name={collapsed ? "ChevronDown" : "ChevronUp"}
          size={14}
          color={theme.colors.foregroundMuted}
        />
      </Pressable>
      {/* Hidden, not unmounted: the draft and any running job's cards survive a fold. */}
      <View style={[styles.body, collapsed && styles.hidden]}>
        <Text style={styles.muted}>{zh.designerTagline}</Text>
        <Field theme={theme} label={zh.designerRequestLabel}>
          <ImeTextInput
            accessibilityLabel={zh.designerRequestLabel}
            initialValue={request}
            revision={submission.draftState.inputRevision}
            onChangeText={(text) => {
              editDraft({ request: text });
              setFold((choice) => resolveFoldOnInput(choice));
            }}
            placeholder={zh.designerRequestPlaceholder}
            placeholderTextColor={theme.colors.foregroundMuted}
            multiline
            style={styles.input}
          />
          <View style={styles.metaRow}>
            <View style={styles.metaHint}>
              {requestHint ? <Text style={requestHint.style}>{requestHint.text}</Text> : null}
            </View>
            <Text style={check.ok || check.reason === "empty" ? styles.muted : styles.danger}>
              {zh.designerRequestCount(check.length, DESIGN_REQUEST_MAX_CODE_POINTS)}
            </Text>
          </View>
        </Field>
        <View style={styles.pickers}>
          <View style={styles.picker}>
            <CompactPicker
              theme={theme}
              label={zh.designerWorkspaceLabel}
              items={workspaceItems}
              selectedId={workspace.id}
              placeholder={zh.designerWorkspaceNone}
              searchPlaceholder={zh.searchWorkspaces}
              emptyLabel={zh.noMatchingWorkspaces}
              error={workspace.missing ? zh.designerWorkspaceMissing : undefined}
              subtitle={(item) => item.subtitle}
              leading={() => (
                <Icon name="FolderOpen" size={16} color={theme.colors.foregroundMuted} />
              )}
              onChange={(workspaceId) => editDraft({ workspaceId })}
            />
            {workspaceQuery.loading ? (
              <Text style={styles.muted}>{zh.loading(zh.workspace)}</Text>
            ) : null}
            {workspaceQuery.error ? (
              <Text style={styles.warning}>{zh.designerWorkspacesFail(workspaceQuery.error)}</Text>
            ) : null}
            {onlyWorkspaceWarning ? (
              <Text style={styles.warning}>{designZh.targetOnlyWorkspace}</Text>
            ) : null}
          </View>
          <View style={styles.picker}>
            <CompactPicker
              theme={theme}
              label={zh.designerProfileLabel}
              items={profileItems}
              selectedId={profile.id}
              placeholder={zh.designerProfileAuto}
              searchPlaceholder={zh.designerSearchProfiles}
              emptyLabel={zh.designerNoMatchingProfiles}
              error={profile.missing ? zh.designerProfileMissing : undefined}
              subtitle={(item) => item.subtitle}
              onChange={(choice) => editDraft({ profileChoice: choice })}
            />
            {profilesLoading ? <Text style={styles.muted}>{zh.loadingProfiles}</Text> : null}
            {profilesError ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={[styles.warning, { flexShrink: 1 }]}>{profilesError}</Text>
                {onRefreshProfiles ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={zh.refreshProfiles}
                    onPress={onRefreshProfiles}
                  >
                    <Text style={styles.retry}>{zh.retry}</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </View>
        </View>
        <TeamModePicker
          theme={theme}
          layout={layout}
          value={draft.mode}
          label={zh.teamMode}
          disabled={submitting}
          onChange={(next) => {
            editDraft({ mode: next });
            onModeChange?.(next);
          }}
        />
        <View style={styles.actions}>
          {note ? <Text style={[styles.muted, styles.note]}>{note}</Text> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={zh.designerStart}
            accessibilityHint={buttonHint}
            accessibilityState={{ disabled, busy: submitting }}
            disabled={disabled}
            onPress={() => void start()}
            style={({ pressed }) => [
              styles.button,
              pressed && { opacity: 0.72 },
              disabled && { opacity: 0.45 },
            ]}
          >
            <Icon name="Sparkles" size={14} color={theme.colors.accentForeground} />
            <Text style={styles.buttonLabel}>
              {submitting ? zh.designerStarting : zh.designerStart}
            </Text>
          </Pressable>
        </View>
        {startError ? (
          <Text selectable style={styles.danger}>
            {startError}
          </Text>
        ) : null}
        {children ? <View style={styles.children}>{children}</View> : null}
      </View>
    </View>
  );
}

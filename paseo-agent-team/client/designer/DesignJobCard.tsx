import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { formatDesignIssue } from "../../shared/domain/design-output";
import type { DesignJob } from "../../shared/schemas/design";
import { designZh } from "../../shared/zh/design";
import type { PluginTheme } from "../shared/theme";
import {
  type DesignGapConfigureEconomy,
  type DesignGapOpenRole,
  DesignRoleGapCard,
} from "./DesignRoleGapCard";
import {
  openDesignAgent,
  resolveDesignJobCardSections,
  resolveDesignJobView,
} from "./submission-state";

export type DesignJobCardProps = {
  theme: PluginTheme;
  job: DesignJob;
  hostId: string;
  /** Undefined on older hosts; the card then shows the agent id instead of a dead button. */
  navigation?: PluginSurfaceProps["navigation"];
  /** An action request is in flight; all actions are disabled until it settles. */
  busy?: boolean;
  onCancel?: (job: DesignJob) => void;
  onRetrySave?: (job: DesignJob) => void;
  /** A client-side save failure that has not yet moved the server job state. */
  forceRetrySave?: boolean;
  onContinue?: (job: DesignJob, action: "recheck" | "repair") => void;
  /** Role-gap exits. Each one renders only when its callback is given (no dead buttons). */
  onGapRetry?: (job: DesignJob) => void;
  gapRetryBusy?: boolean;
  gapRetryNotice?: string | null;
  onOpenRole?: (target: DesignGapOpenRole) => void;
  onConfigureEconomy?: (target: DesignGapConfigureEconomy) => void;
  onCreateRole?: () => void;
};

function Action({
  theme,
  label,
  onPress,
  disabled,
  primary,
  danger,
}: {
  theme: PluginTheme;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
}) {
  const backgroundColor = danger
    ? theme.colors.statusDanger
    : primary
      ? theme.colors.accent
      : theme.colors.surface2;
  const color = primary || danger ? theme.colors.accentForeground : theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: 34,
          paddingHorizontal: 12,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center" as const,
          backgroundColor,
        },
        pressed && { opacity: 0.72 },
        disabled && { opacity: 0.45 },
      ]}
    >
      <Text style={{ color, fontSize: 13, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

export function DesignJobCard({
  theme,
  job,
  hostId,
  navigation,
  busy = false,
  onCancel,
  onRetrySave,
  forceRetrySave = false,
  onContinue,
  onGapRetry,
  gapRetryBusy = false,
  gapRetryNotice,
  onOpenRole,
  onConfigureEconomy,
  onCreateRole,
}: DesignJobCardProps) {
  const [collapsed, setCollapsed] = useState(false);
  const view = useMemo(() => resolveDesignJobView(job), [job]);
  const sections = useMemo(() => resolveDesignJobCardSections(job, collapsed), [job, collapsed]);
  const styles = useMemo(
    () => ({
      card: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
        padding: 12,
        gap: 10,
      },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        minHeight: 28,
      },
      headerText: { flex: 1, minWidth: 0 },
      title: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
      phase: { color: theme.colors.foregroundMuted, fontSize: 12 },
      phaseAttention: { color: theme.colors.statusWarning, fontWeight: "600" as const },
      phaseDanger: { color: theme.colors.statusDanger, fontWeight: "600" as const },
      hidden: { display: "none" as const },
      body: { gap: 8 },
      meta: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 10 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      value: { color: theme.colors.foreground, fontSize: 12 },
      notice: { color: theme.colors.statusWarning, fontSize: 12 },
      danger: { color: theme.colors.statusDanger, fontSize: 12 },
      section: { gap: 4 },
      sectionTitle: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
      permission: {
        gap: 2,
        padding: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
      },
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
      agentHint: { color: theme.colors.foregroundMuted, fontSize: 11 },
    }),
    [theme],
  );

  function openAgent() {
    openDesignAgent({ navigation, hostId, agentId: job.agentId });
  }

  const toneStyle =
    view.tone === "danger"
      ? styles.phaseDanger
      : view.tone === "attention"
        ? styles.phaseAttention
        : styles.phase;
  const phaseLine = [view.phase, view.attemptLabel].filter(Boolean).join(" · ");

  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${designZh.jobHeading}: ${view.title}`}
        accessibilityHint={collapsed ? designZh.jobExpand : designZh.jobCollapse}
        accessibilityState={{ expanded: !collapsed }}
        onPress={() => setCollapsed((value) => !value)}
        style={styles.header}
      >
        <Icon name="Sparkles" size={15} color={theme.colors.accent} />
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={1}>
            {view.title}
          </Text>
          <Text style={toneStyle} numberOfLines={1}>
            {phaseLine}
          </Text>
        </View>
        <Icon
          name={collapsed ? "ChevronDown" : "ChevronUp"}
          size={14}
          color={theme.colors.foregroundMuted}
        />
      </Pressable>
      <View style={[styles.body, !sections.showBody && styles.hidden]}>
        <View style={styles.meta}>
          <Text style={styles.muted}>{designZh.jobModeValue(view.modeLabel)}</Text>
          <Text style={styles.muted}>{view.rulesLabel}</Text>
          {view.designerProfileLabel ? (
            <Text style={styles.muted}>
              {designZh.jobDesignerProfileValue(view.designerProfileLabel)}
            </Text>
          ) : null}
        </View>
        {view.recovered ? <Text style={styles.notice}>{designZh.jobRecovered}</Text> : null}
        {view.saveNote ? <Text style={styles.muted}>{view.saveNote}</Text> : null}

        {view.showPermissions ? (
          <View style={styles.section}>
            {view.permissions.length > 0 ? (
              <Text style={styles.sectionTitle}>
                {designZh.jobPermissions(view.permissions.length)}
              </Text>
            ) : null}
            {view.permissions.map((permission) => (
              <View key={permission.id} style={styles.permission}>
                <Text style={styles.value}>
                  {designZh.jobPermissionLine(permission.kindLabel, permission.title)}
                </Text>
                {permission.description ? (
                  <Text style={styles.muted}>{permission.description}</Text>
                ) : null}
              </View>
            ))}
            {view.permissionNotice ? (
              <Text style={styles.notice}>{view.permissionNotice}</Text>
            ) : null}
            {view.canOpenAgent ? (
              navigation ? (
                <Action
                  theme={theme}
                  label={designZh.jobPermissionOpen}
                  disabled={busy}
                  onPress={openAgent}
                />
              ) : (
                <Text selectable style={styles.agentHint}>
                  {designZh.jobAgentUnavailable(job.agentId)}
                </Text>
              )
            ) : null}
          </View>
        ) : null}

        {view.issues.length > 0 ? (
          <View style={styles.section}>
            {view.issues.map((issue) => (
              <Text
                key={JSON.stringify(issue)}
                style={issue.severity === "error" ? styles.danger : styles.notice}
              >
                {formatDesignIssue(issue)}
              </Text>
            ))}
            {view.issuesTruncated > 0 ? (
              <Text style={styles.muted}>{designZh.jobIssuesTruncated(view.issuesTruncated)}</Text>
            ) : null}
          </View>
        ) : null}

        {view.gaps.length > 0 ? (
          <DesignRoleGapCard
            theme={theme}
            gaps={view.gaps}
            rulesLabel={view.rulesLabel}
            onOpenRole={onOpenRole}
            onConfigureEconomy={onConfigureEconomy}
            onCreateRole={onCreateRole}
            onRetry={onGapRetry ? () => onGapRetry(job) : undefined}
            retryBusy={gapRetryBusy}
            retryNotice={gapRetryNotice}
          />
        ) : null}

        <View style={styles.actions}>
          {(view.canRetrySave || forceRetrySave) && onRetrySave ? (
            <Action
              theme={theme}
              label={designZh.jobRetrySave}
              disabled={busy}
              primary
              onPress={() => onRetrySave(job)}
            />
          ) : null}
          {view.continueAction && onContinue ? (
            <Action
              theme={theme}
              label={
                view.continueAction === "repair"
                  ? designZh.jobContinueRepair
                  : designZh.jobContinueRecheck
              }
              disabled={busy}
              primary={!view.canRetrySave}
              onPress={() =>
                onContinue(job, view.continueAction === "repair" ? "repair" : "recheck")
              }
            />
          ) : null}
          {view.canOpenAgent && !view.showPermissions ? (
            navigation ? (
              <Action
                theme={theme}
                label={designZh.jobOpenAgent}
                disabled={busy}
                onPress={openAgent}
              />
            ) : (
              <Text selectable style={styles.agentHint}>
                {designZh.jobAgentUnavailable(job.agentId)}
              </Text>
            )
          ) : null}
          {view.canCancel && onCancel ? (
            <Action
              theme={theme}
              label={designZh.jobCancel}
              disabled={busy}
              danger
              onPress={() => onCancel(job)}
            />
          ) : null}
          {busy ? <Text style={styles.muted}>{designZh.jobBusy}</Text> : null}
        </View>
      </View>
    </View>
  );
}

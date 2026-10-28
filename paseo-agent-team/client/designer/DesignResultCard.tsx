import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { DesignResult } from "../../shared/schemas/design";
import { designZh } from "../../shared/zh/design";
import type { PluginTheme } from "../shared/theme";
import { type DesignLaunchPrefill, resolveDesignResultView } from "./submission-state";

export type DesignResultCardProps = {
  theme: PluginTheme;
  result: DesignResult;
  /** The applied Team id from the job; launch preview stays disabled until it is saved. */
  savedTeamId?: string | null;
  /** Opens the existing LaunchDialog with a replaceable target preselect. It never launches. */
  onPreviewLaunch?: (prefill: DesignLaunchPrefill) => void;
  /** An extra host-side reason, e.g. an unsettled save or a missing launch permission. */
  launchDisabledReason?: string;
};

function LabelValue({
  label,
  value,
  theme,
  strong,
}: {
  label: string;
  value: string;
  theme: PluginTheme;
  strong?: boolean;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
      <Text
        selectable
        style={{
          color: strong ? theme.colors.foreground : theme.colors.foregroundMuted,
          fontSize: 12,
          fontWeight: strong ? "600" : "400",
        }}
      >
        {value}
      </Text>
    </View>
  );
}

export function DesignResultCard({
  theme,
  result,
  savedTeamId,
  onPreviewLaunch,
  launchDisabledReason,
}: DesignResultCardProps) {
  const view = useMemo(() => resolveDesignResultView(result, savedTeamId), [result, savedTeamId]);
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
      header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      headerText: { flex: 1, minWidth: 0 },
      title: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
      subtitle: { color: theme.colors.foregroundMuted, fontSize: 12 },
      summary: { color: theme.colors.foreground, fontSize: 13 },
      meta: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 10 },
      section: { gap: 5 },
      sectionTitle: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      value: { color: theme.colors.foreground, fontSize: 12 },
      seat: {
        gap: 4,
        padding: 9,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      },
      seatHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        flexWrap: "wrap" as const,
        gap: 6,
      },
      seatRole: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      badge: {
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 7,
        backgroundColor: theme.colors.surface1,
      },
      badgeText: { color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "600" as const },
      unavailable: { color: theme.colors.statusWarning, fontSize: 11, fontWeight: "600" as const },
      warning: { color: theme.colors.statusWarning, fontSize: 12 },
      actions: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10 },
      button: {
        minHeight: 36,
        paddingHorizontal: 14,
        borderRadius: 8,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: theme.colors.accent,
      },
      buttonDisabled: { opacity: 0.45 },
      buttonLabel: {
        color: theme.colors.accentForeground,
        fontSize: 13,
        fontWeight: "600" as const,
      },
      hint: { color: theme.colors.foregroundMuted, fontSize: 11, flexShrink: 1 },
    }),
    [theme],
  );

  const launch = view.launch;
  const disabled =
    launch === null || onPreviewLaunch === undefined || Boolean(launchDisabledReason);
  const hint = launchDisabledReason ?? view.launchHint;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Icon name="ClipboardList" size={16} color={theme.colors.accent} />
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={1}>
            {designZh.resultHeading}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {designZh.resultTeamLine(view.teamLabel, view.teamId)}
          </Text>
        </View>
        <Text style={styles.muted}>{view.modeLabel}</Text>
      </View>
      <Text style={styles.summary}>{view.summary}</Text>
      <View style={styles.meta}>
        <LabelValue label={designZh.resultMode} value={view.modeLabel} theme={theme} strong />
        <LabelValue
          label={designZh.resultTargetLabel}
          value={view.targetLabel}
          theme={theme}
          strong
        />
        <Text style={styles.muted}>
          {designZh.resultCounts(view.logicalCount, view.physicalCount)}
        </Text>
        {view.countsNote ? <Text style={styles.muted}>{view.countsNote}</Text> : null}
      </View>

      {view.coordinator ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{designZh.resultCoordinator}</Text>
          <View style={styles.seat}>
            <View style={styles.seatHeader}>
              <Text style={styles.seatRole}>{view.coordinator.roleLabel}</Text>
              {view.coordinator.unavailable ? (
                <Text style={styles.unavailable}>{designZh.resultSeatUnavailable}</Text>
              ) : null}
            </View>
            <LabelValue
              label={designZh.resultSeatProfile}
              value={view.coordinator.profileLabel}
              theme={theme}
              strong
            />
            <LabelValue
              label={designZh.resultSeatBudget}
              value={view.coordinator.budgetLabel}
              theme={theme}
              strong
            />
            {view.coordinator.runtimeLabel ? (
              <LabelValue
                label={designZh.resultSeatRuntime}
                value={view.coordinator.runtimeLabel}
                theme={theme}
              />
            ) : null}
            {view.coordinator.sourceLabel ? (
              <LabelValue
                label={designZh.resultSeatSource}
                value={view.coordinator.sourceLabel}
                theme={theme}
              />
            ) : null}
            {view.coordinator.reasonLabel ? (
              <LabelValue
                label={designZh.resultSeatReason}
                value={view.coordinator.reasonLabel}
                theme={theme}
              />
            ) : null}
          </View>
        </View>
      ) : null}

      {view.reuse.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{designZh.resultReuse}</Text>
          {view.reuse.map((entry) => (
            <View key={entry.roleId} style={{ gap: 1 }}>
              <Text selectable style={styles.value}>
                {entry.roleId}
              </Text>
              <Text style={styles.muted}>{entry.reason}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {view.newRoles.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{designZh.resultNewRoles}</Text>
          {view.newRoles.map((role) => (
            <View key={role.id} style={{ gap: 1 }}>
              <Text selectable style={styles.value}>
                {designZh.resultNewRoleLine(role.name, role.id)}
              </Text>
              {role.noveltyReason ? (
                <Text style={styles.muted}>
                  {designZh.resultNoveltyReason}：{role.noveltyReason}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>
          {designZh.resultSeats} ({view.seats.length})
        </Text>
        {view.seats.length === 0 ? (
          <Text style={styles.muted}>{designZh.resultNoSeats}</Text>
        ) : (
          view.seats.map((seat) => (
            <View key={seat.key} style={styles.seat}>
              <View style={styles.seatHeader}>
                <Text style={styles.seatRole}>{seat.roleLabel}</Text>
                {seat.instanceLabel ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{seat.instanceLabel}</Text>
                  </View>
                ) : null}
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{seat.purposeLabel}</Text>
                </View>
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{seat.activationLabel}</Text>
                </View>
                {seat.unavailable ? (
                  <Text style={styles.unavailable}>{designZh.resultSeatUnavailable}</Text>
                ) : null}
              </View>
              {seat.cohortId ? (
                <LabelValue label={designZh.resultSeatCohort} value={seat.cohortId} theme={theme} />
              ) : null}
              <LabelValue
                label={designZh.resultSeatProfile}
                value={seat.profileLabel}
                theme={theme}
                strong
              />
              <LabelValue
                label={designZh.resultSeatBudget}
                value={seat.budgetLabel}
                theme={theme}
                strong
              />
              {seat.runtimeLabel ? (
                <LabelValue
                  label={designZh.resultSeatRuntime}
                  value={seat.runtimeLabel}
                  theme={theme}
                />
              ) : null}
              {seat.sourceLabel ? (
                <LabelValue
                  label={designZh.resultSeatSource}
                  value={seat.sourceLabel}
                  theme={theme}
                />
              ) : null}
              {seat.familyLabel ? (
                <LabelValue
                  label={designZh.resultSeatFamily}
                  value={seat.familyLabel}
                  theme={theme}
                />
              ) : null}
              {seat.reasonLabel ? (
                <LabelValue
                  label={designZh.resultSeatReason}
                  value={seat.reasonLabel}
                  theme={theme}
                />
              ) : null}
            </View>
          ))
        )}
      </View>

      {view.warnings.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{designZh.resultWarnings}</Text>
          {view.warnings.map((warning) => (
            <Text key={warning} style={styles.warning}>
              {warning}
            </Text>
          ))}
        </View>
      ) : null}

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={designZh.resultLaunch}
          accessibilityHint={hint ?? undefined}
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={() => {
            if (launch && onPreviewLaunch) onPreviewLaunch(launch);
          }}
          style={({ pressed }) => [
            styles.button,
            pressed && { opacity: 0.72 },
            disabled && styles.buttonDisabled,
          ]}
        >
          <Text style={styles.buttonLabel}>{designZh.resultLaunch}</Text>
        </Pressable>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
    </View>
  );
}

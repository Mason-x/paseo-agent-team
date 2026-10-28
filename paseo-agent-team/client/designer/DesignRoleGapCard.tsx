import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { AllSeatsRoute } from "../../shared/schemas/team-mode";
import { designGapZh } from "../../shared/zh/design-gap";
import type { PluginTheme } from "../shared/theme";
import type { DesignGapAction, DesignGapView } from "./submission-state";

export type DesignGapOpenRole = { roleId: string; profileId?: string };
export type DesignGapConfigureEconomy = { layer: "allSeats"; route?: AllSeatsRoute };

export type DesignRoleGapCardProps = {
  theme: PluginTheme;
  gaps: readonly DesignGapView[];
  /** The rule line of the job ("规则：只用现有 Role" ...), shown once under the title. */
  rulesLabel: string;
  /** An exit renders only when its callback exists: the card never shows a dead button. */
  onOpenRole?: (target: DesignGapOpenRole) => void;
  onConfigureEconomy?: (target: DesignGapConfigureEconomy) => void;
  onCreateRole?: () => void;
  /** "Close the switch and retry". Prefills only; it never starts anything. */
  onRetry?: () => void;
  retryBusy?: boolean;
  retryNotice?: string | null;
};

function actionLabel(action: DesignGapAction): string {
  switch (action.kind) {
    case "configure-economy":
      return designGapZh.actionConfigureEconomy;
    case "open-role":
      return designGapZh.actionOpenRole;
    case "create-role":
      return designGapZh.actionCreateRole;
  }
}

/**
 * Role-gap report, as plain text. Every name shown (Profiles, the existing Role, the suggested
 * Role) is the server-confirmed one from the report; this card resolves nothing and edits nothing.
 */
export function DesignRoleGapCard({
  theme,
  gaps,
  rulesLabel,
  onOpenRole,
  onConfigureEconomy,
  onCreateRole,
  onRetry,
  retryBusy = false,
  retryNotice,
}: DesignRoleGapCardProps) {
  const styles = useMemo(
    () => ({
      card: {
        borderWidth: 1,
        borderColor: theme.colors.statusWarning,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
        padding: 12,
        gap: 10,
      },
      title: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      value: { color: theme.colors.foreground, fontSize: 12 },
      label: { color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" as const },
      warning: { color: theme.colors.statusWarning, fontSize: 12 },
      gap: {
        gap: 4,
        padding: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
      },
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
      button: {
        minHeight: 32,
        paddingHorizontal: 12,
        borderRadius: 8,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: theme.colors.surface2,
      },
      buttonPrimary: { backgroundColor: theme.colors.accent },
      buttonLabel: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
      buttonLabelPrimary: { color: theme.colors.accentForeground },
    }),
    [theme],
  );

  function run(action: DesignGapAction) {
    if (action.kind === "configure-economy") {
      onConfigureEconomy?.({
        layer: action.layer,
        ...(action.route === undefined ? {} : { route: action.route }),
      });
    } else if (action.kind === "open-role") {
      onOpenRole?.({
        roleId: action.roleId,
        ...(action.profileId === undefined ? {} : { profileId: action.profileId }),
      });
    } else {
      onCreateRole?.();
    }
  }

  function available(action: DesignGapAction | null): action is DesignGapAction {
    if (action === null) return false;
    if (action.kind === "configure-economy") return onConfigureEconomy !== undefined;
    if (action.kind === "open-role") return onOpenRole !== undefined;
    return onCreateRole !== undefined;
  }

  function button(action: DesignGapAction, primary: boolean, key: string) {
    return (
      <Pressable
        key={key}
        accessibilityRole="button"
        accessibilityLabel={actionLabel(action)}
        onPress={() => run(action)}
        style={({ pressed }) => [
          styles.button,
          primary && styles.buttonPrimary,
          pressed && { opacity: 0.72 },
        ]}
      >
        <Text style={[styles.buttonLabel, primary && styles.buttonLabelPrimary]}>
          {actionLabel(action)}
        </Text>
      </Pressable>
    );
  }

  const economy = gaps.some((gap) => gap.primary?.kind === "configure-economy");

  return (
    <View style={styles.card}>
      <Text style={styles.title}>{designGapZh.gapTitle}</Text>
      <Text style={styles.muted}>{rulesLabel}</Text>
      <Text style={styles.muted}>{designGapZh.gapIntro}</Text>
      {economy ? <Text style={styles.warning}>{designGapZh.economyHint}</Text> : null}
      <Text style={styles.muted}>{designGapZh.gapCount(gaps.length)}</Text>
      {gaps.map((gap) => (
        <View key={gap.key} style={styles.gap}>
          <Text style={styles.label}>{designGapZh.gapResponsibility}</Text>
          <Text selectable style={styles.value}>
            {gap.responsibility}
          </Text>
          <Text style={styles.label}>{designGapZh.gapReason}</Text>
          <Text selectable style={styles.value}>
            {gap.reason}
          </Text>
          <Text style={styles.muted}>{gap.useLabel}</Text>
          {gap.suggestedRole ? (
            <View>
              <Text style={styles.label}>{designGapZh.suggestedRoleTitle}</Text>
              <Text selectable style={styles.value}>
                {designGapZh.suggestedRoleLine(gap.suggestedRole.id, gap.suggestedRole.name)}
              </Text>
              <Text style={styles.muted}>{gap.suggestedRole.policyLabel}</Text>
              {gap.suggestedRole.responsibilities.map((line) => (
                <Text key={line} selectable style={styles.muted}>
                  {`· ${line}`}
                </Text>
              ))}
            </View>
          ) : null}
          {gap.unlaunchable ? (
            <View>
              <Text style={styles.label}>{designGapZh.unlaunchableTitle}</Text>
              <Text selectable style={styles.value}>
                {designGapZh.unlaunchableRole(gap.unlaunchable.roleName, gap.unlaunchable.roleId)}
              </Text>
              {gap.unlaunchable.unavailableProfileNames.length > 0 ? (
                <Text selectable style={styles.muted}>
                  {designGapZh.unavailableBindings(gap.unlaunchable.unavailableProfileNames)}
                </Text>
              ) : null}
            </View>
          ) : null}
          {gap.profiles.length > 0 ? (
            <View>
              <Text style={styles.label}>{designGapZh.profilesTitle}</Text>
              {gap.profiles.map((profile) => (
                <Text key={profile.id} selectable style={styles.value}>
                  {designGapZh.profileLine(profile.name, profile.provider, profile.model)}
                </Text>
              ))}
            </View>
          ) : null}
          {gap.noSuitableProfile !== null ? (
            <View>
              <Text style={styles.warning}>{designGapZh.noSuitableProfile}</Text>
              <Text selectable style={styles.muted}>
                {designGapZh.noSuitableProfileReason(gap.noSuitableProfile)}
              </Text>
            </View>
          ) : null}
          {available(gap.primary) || available(gap.secondary) ? (
            <View style={styles.actions}>
              {available(gap.primary) ? button(gap.primary, true, `${gap.key}:primary`) : null}
              {available(gap.secondary)
                ? button(gap.secondary, false, `${gap.key}:secondary`)
                : null}
            </View>
          ) : null}
        </View>
      ))}
      {onRetry ? (
        <View style={{ gap: 4 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={designGapZh.retry}
            accessibilityState={{ disabled: retryBusy }}
            disabled={retryBusy}
            onPress={onRetry}
            style={({ pressed }) => [
              styles.button,
              styles.buttonPrimary,
              pressed && { opacity: 0.72 },
              retryBusy && { opacity: 0.45 },
            ]}
          >
            <Text style={[styles.buttonLabel, styles.buttonLabelPrimary]}>
              {retryBusy ? designGapZh.retryBusy : designGapZh.retry}
            </Text>
          </Pressable>
          <Text style={styles.muted}>{designGapZh.retryHint}</Text>
          {retryNotice ? <Text style={styles.warning}>{retryNotice}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

import { Pressable, Text, View } from "react-native";
import { teamPlanZh } from "../../shared/zh/team-plan";
import type { PluginTheme } from "../shared/theme";
import type { TeamBindingTarget, TeamModelRowView } from "./team-plan-state";

/**
 * One physical planned seat: coordinator and member rows share it. A blocked row never shows a
 * model as if it would run; the configured bindings are diagnostics only.
 */
export function ModelRow({
  theme,
  view,
  onOpenRole,
  onConfigureEconomy,
}: {
  theme: PluginTheme;
  view: TeamModelRowView;
  onOpenRole?: (roleId: string, profileId?: string) => void;
  onConfigureEconomy?: (target: Extract<TeamBindingTarget, { kind: "economy" }>) => void;
}) {
  const styles = {
    row: {
      gap: 3,
      paddingVertical: 8,
      paddingHorizontal: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      backgroundColor: theme.colors.surface2,
    },
    head: {
      flexDirection: "row" as const,
      alignItems: "baseline" as const,
      gap: 6,
      flexWrap: "wrap" as const,
    },
    name: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
    meta: { color: theme.colors.foregroundMuted, fontSize: 11 },
    warning: { color: theme.colors.statusWarning, fontSize: 12 },
    danger: { color: theme.colors.statusDanger, fontSize: 12 },
    badge: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      paddingHorizontal: 6,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 999,
    },
    actions: { flexDirection: "row" as const, gap: 12, flexWrap: "wrap" as const, paddingTop: 2 },
    link: { color: theme.colors.accent, fontSize: 12, fontWeight: "600" as const },
  };

  function action(target: TeamBindingTarget) {
    if (target.kind === "role") {
      if (!onOpenRole) return null;
      return (
        <Pressable
          key={`role:${target.roleId}`}
          accessibilityRole="button"
          accessibilityLabel={teamPlanZh.rebind}
          onPress={() => onOpenRole(target.roleId, target.profileId)}
        >
          <Text style={styles.link}>{teamPlanZh.rebind}</Text>
        </Pressable>
      );
    }
    if (!onConfigureEconomy) return null;
    return (
      <Pressable
        key={`economy:${target.layer}:${target.route ?? ""}`}
        accessibilityRole="button"
        accessibilityLabel={teamPlanZh.configureEconomy}
        onPress={() => onConfigureEconomy(target)}
      >
        <Text style={styles.link}>{teamPlanZh.configureEconomy}</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.row}>
      <View style={styles.head}>
        <Text style={styles.name} numberOfLines={1}>
          {view.roleName}
          {view.instanceLabel ? ` · ${view.instanceLabel}` : ""}
        </Text>
        {view.standby ? <Text style={styles.badge}>{teamPlanZh.standby}</Text> : null}
        {!view.enabled ? <Text style={styles.badge}>{teamPlanZh.disabled}</Text> : null}
        {view.purposeLabel ? <Text style={styles.meta}>{view.purposeLabel}</Text> : null}
        {view.activationLabel ? <Text style={styles.meta}>{view.activationLabel}</Text> : null}
      </View>
      {view.profileName === null ? (
        <Text style={view.enabled ? styles.danger : styles.meta}>{teamPlanZh.noProfile}</Text>
      ) : (
        <>
          <Text style={styles.name} numberOfLines={1}>
            {view.profileName}
          </Text>
          <Text style={styles.meta} numberOfLines={2}>
            {[view.profileMeta, view.source, view.budget, view.availabilityLabel]
              .filter((part): part is string => Boolean(part))
              .join(" · ")}
          </Text>
        </>
      )}
      {view.profileName === null && view.configuredNames.length > 0 ? (
        <Text style={styles.meta} numberOfLines={2}>
          {teamPlanZh.configured(view.configuredNames.join("、"))}
        </Text>
      ) : null}
      {view.reasons.map((reason) => (
        <Text
          key={reason}
          style={view.profileName === null && view.enabled ? styles.danger : styles.warning}
        >
          {reason}
        </Text>
      ))}
      {view.actions.length > 0 ? (
        <View style={styles.actions}>{view.actions.map(action)}</View>
      ) : null}
    </View>
  );
}

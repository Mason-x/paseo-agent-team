import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { ModeContractSupport } from "../../shared/domain/mode-contract";
import type { Role } from "../../shared/schemas/role";
import type { Team } from "../../shared/schemas/team";
import { zh } from "../../shared/zh";
import { teamPlanZh } from "../../shared/zh/team-plan";
import { teamRoleWarnings } from "../domain/validation";
import { GhostIconButton } from "../shared/buttons";
import { RoleGlyph } from "../shared/RoleGlyph";
import type { PluginTheme } from "../shared/theme";
import type { TeamSummaryView } from "./team-plan-state";

export type TeamListPlans = {
  summaries: ReadonlyMap<string, TeamSummaryView>;
  modeContract: ModeContractSupport;
  pending: boolean;
  error: string | null;
  onRetry?: () => void;
  onRefreshTeams?: () => void;
};

function PlanSummaryLines({
  theme,
  summary,
  pending,
  onRetry,
  onRefreshTeams,
}: {
  theme: PluginTheme;
  summary: TeamSummaryView | undefined;
  pending: boolean;
  onRetry?: () => void;
  onRefreshTeams?: () => void;
}) {
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const warning = { color: theme.colors.statusWarning, fontSize: 12, fontWeight: "600" as const };
  const link = { color: theme.colors.accent, fontSize: 12, fontWeight: "600" as const };
  if (!summary) {
    return pending ? <Text style={muted}>{teamPlanZh.pending}</Text> : null;
  }
  switch (summary.kind) {
    case "empty":
      return null;
    case "pending":
      return <Text style={muted}>{teamPlanZh.pending}</Text>;
    case "summary":
      return (
        <>
          <Text style={muted} numberOfLines={2}>
            {summary.groupsText}
          </Text>
          {summary.unresolvedText ? (
            <Text style={summary.tone === "warning" ? warning : muted} numberOfLines={2}>
              {summary.unresolvedText}
            </Text>
          ) : null}
        </>
      );
    case "unknown-mode":
      return <Text style={warning}>{summary.text}</Text>;
    case "missing-team":
      return (
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <Text style={warning}>{summary.text}</Text>
          {onRefreshTeams ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={teamPlanZh.refresh}
              onPress={onRefreshTeams}
            >
              <Text style={link}>{teamPlanZh.refresh}</Text>
            </Pressable>
          ) : null}
        </View>
      );
    case "unavailable":
      return (
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <Text style={warning}>{summary.text}</Text>
          {onRetry ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={teamPlanZh.retry}
              onPress={onRetry}
            >
              <Text style={link}>{teamPlanZh.retry}</Text>
            </Pressable>
          ) : null}
        </View>
      );
  }
}

export function TeamList({
  theme,
  teams,
  roles,
  query,
  onLaunch,
  onEdit,
  onCopy,
  onDelete,
  plans,
}: {
  theme: PluginTheme;
  teams: readonly Team[];
  roles: readonly Role[];
  query: string;
  onLaunch: (team: Team) => void;
  onEdit: (team: Team) => void;
  onCopy: (team: Team) => void;
  onDelete: (team: Team) => void;
  /** Model-plan summaries; absent/legacy hides the new display without changing the list. */
  plans?: TeamListPlans;
}) {
  const warnings = useMemo(() => teamRoleWarnings(teams, roles), [teams, roles]);
  const warningById = new Map(warnings.map((warning) => [warning.teamId, warning]));
  const styles = useMemo(
    () => ({
      list: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
        overflow: "hidden" as const,
      },
      row: {
        minHeight: 56,
        paddingVertical: 12,
        paddingHorizontal: 12,
        gap: 8,
        flexDirection: "row" as const,
        alignItems: "center" as const,
      },
      rowBorder: { borderTopWidth: 1, borderTopColor: theme.colors.border },
      main: { flex: 1, minWidth: 0, gap: 2 },
      titleLine: {
        flexDirection: "row" as const,
        alignItems: "baseline" as const,
        gap: 8,
        minWidth: 0,
      },
      title: {
        color: theme.colors.foreground,
        fontSize: 15,
        fontWeight: "600" as const,
        flexShrink: 1,
      },
      summary: { color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 },
      meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      warning: { color: theme.colors.statusWarning, fontSize: 12, fontWeight: "600" as const },
      danger: { color: theme.colors.statusDanger, fontSize: 12, fontWeight: "600" as const },
      link: { color: theme.colors.accent, fontSize: 12, fontWeight: "600" as const },
      actions: { flexDirection: "row" as const, alignItems: "center" as const, flexShrink: 0 },
    }),
    [theme],
  );

  const filtered = teams.filter((team) => {
    const haystack = `${team.name} ${team.description ?? ""} ${team.id}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });

  if (filtered.length === 0) return null;

  return (
    <View style={styles.list}>
      {plans?.modeContract === "unknown" && plans.error ? (
        <View style={{ padding: 10, gap: 4 }}>
          <Text style={styles.warning}>{plans.error}</Text>
          {plans.onRetry ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={teamPlanZh.retry}
              onPress={plans.onRetry}
            >
              <Text style={styles.link}>{teamPlanZh.retry}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {filtered.map((team, index) => {
        const coordinator = roles.find((role) => role.id === team.coordinatorRoleId);
        const warning = warningById.get(team.id);
        const hasWarning = Boolean(warning && warning.missingRoleIds.length > 0);
        return (
          <View key={team.id} style={[styles.row, index > 0 && styles.rowBorder]}>
            <RoleGlyph
              theme={theme}
              icon={coordinator?.icon ?? "Users"}
              color={coordinator?.color}
              size={16}
            />
            <View style={styles.main}>
              <View style={styles.titleLine}>
                <Text style={styles.title} numberOfLines={1}>
                  {team.name}
                </Text>
                <Text style={styles.summary} numberOfLines={1}>
                  {coordinator?.name ?? team.coordinatorRoleId} ·{" "}
                  {zh.membersCount(team.members.length)}
                </Text>
              </View>
              {team.description ? (
                <Text style={styles.meta} numberOfLines={2}>
                  {team.description}
                </Text>
              ) : null}
              {hasWarning ? (
                <Text style={styles.warning}>
                  {zh.missingRoles(warning?.missingRoleIds.join("、") ?? "")}
                </Text>
              ) : null}
              {plans && plans.modeContract !== "legacy" ? (
                <PlanSummaryLines
                  theme={theme}
                  summary={plans.summaries.get(team.id)}
                  pending={plans.pending}
                  onRetry={plans.onRetry}
                  onRefreshTeams={plans.onRefreshTeams}
                />
              ) : null}
            </View>
            <View style={styles.actions}>
              <GhostIconButton
                theme={theme}
                icon="Play"
                color={theme.colors.accent}
                accessibilityLabel={`Launch ${team.name}`}
                onPress={() => onLaunch(team)}
              />
              <GhostIconButton
                theme={theme}
                icon="Copy"
                accessibilityLabel={`Copy ${team.name}`}
                onPress={() => onCopy(team)}
              />
              <GhostIconButton
                theme={theme}
                icon="Pencil"
                accessibilityLabel={`Edit ${team.name}`}
                onPress={() => onEdit(team)}
              />
              <GhostIconButton
                theme={theme}
                icon="Trash2"
                danger
                accessibilityLabel={`Delete ${team.name}`}
                onPress={() => onDelete(team)}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}

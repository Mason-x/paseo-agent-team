import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PaseoProfile } from "../../shared/paseo/adapter";
import type { Role } from "../../shared/schemas/role";
import type { Team } from "../../shared/schemas/team";
import { zh } from "../../shared/zh";
import { teamPlanZh } from "../../shared/zh/team-plan";
import { type ProfileBinding, profileBindingLabels, teamsUsingRole } from "../domain/validation";
import { GhostIconButton } from "../shared/buttons";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { RoleGlyph } from "../shared/RoleGlyph";
import type { PluginTheme } from "../shared/theme";

function BindingLine({
  theme,
  label,
  items,
  emptyLabel,
}: {
  theme: PluginTheme;
  label: string;
  items: readonly ProfileBinding[];
  emptyLabel: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, 2);
  const overflow = items.length - shown.length;
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const danger = { color: theme.colors.statusDanger, fontSize: 12 };
  const link = { color: theme.colors.accent, fontSize: 12, fontWeight: "600" as const };
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
      <Text style={muted}>{label}：</Text>
      {items.length === 0 ? <Text style={muted}>{emptyLabel}</Text> : null}
      {shown.map((item, index) => (
        <Text key={item.profileId} style={item.missing ? danger : muted}>
          {item.missing
            ? item.label === null
              ? teamPlanZh.bindings.missingUnnamed
              : teamPlanZh.bindings.missing(item.label)
            : item.label}
          {index === shown.length - 1 ? "" : "、"}
        </Text>
      ))}
      {overflow > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={teamPlanZh.bindings.expand(overflow)}
          onPress={() => setExpanded(true)}
        >
          <Text style={link}>{teamPlanZh.bindings.expand(overflow)}</Text>
        </Pressable>
      ) : null}
      {expanded && items.length > 2 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={teamPlanZh.bindings.collapse}
          onPress={() => setExpanded(false)}
        >
          <Text style={link}>{teamPlanZh.bindings.collapse}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function RoleList({
  theme,
  roles,
  teams,
  profiles,
  query,
  onEdit,
  onCopy,
  onDelete,
}: {
  theme: PluginTheme;
  roles: readonly Role[];
  teams: readonly Team[];
  profiles: readonly PaseoProfile[];
  query: string;
  onEdit: (role: Role) => void;
  onCopy: (role: Role) => void;
  onDelete: (role: Role) => void;
}) {
  const [blocked, setBlocked] = useState<{ role: Role; teams: Team[] } | null>(null);
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
      danger: { color: theme.colors.statusDanger, fontSize: 12 },
      actions: { flexDirection: "row" as const, alignItems: "center" as const, flexShrink: 0 },
    }),
    [theme],
  );

  const filtered = roles.filter((role) => {
    const haystack = `${role.name} ${role.description ?? ""} ${role.id}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });

  if (filtered.length === 0) return null;

  return (
    <View style={styles.list}>
      {filtered.map((role, index) => {
        const usedBy = teamsUsingRole(teams, role.id);
        const bindings = profileBindingLabels(role, profiles);
        const usage = usedBy.length === 0 ? zh.unused : zh.usedBy(usedBy.length);
        return (
          <View key={role.id} style={[styles.row, index > 0 && styles.rowBorder]}>
            <RoleGlyph theme={theme} icon={role.icon} color={role.color} size={16} />
            <View style={styles.main}>
              <View style={styles.titleLine}>
                <Text style={styles.title} numberOfLines={1}>
                  {role.name}
                </Text>
              </View>
              <BindingLine
                theme={theme}
                label={teamPlanZh.bindings.preferred}
                items={bindings.preferred}
                emptyLabel={teamPlanZh.noProfile}
              />
              <BindingLine
                theme={theme}
                label={teamPlanZh.bindings.fallback}
                items={bindings.fallback}
                emptyLabel={teamPlanZh.bindings.empty}
              />
              {role.description ? (
                <Text style={styles.meta} numberOfLines={2}>
                  {role.description}
                </Text>
              ) : null}
              <Text style={styles.meta}>{usage}</Text>
            </View>
            <View style={styles.actions}>
              <GhostIconButton
                theme={theme}
                icon="Copy"
                accessibilityLabel={`Copy ${role.name}`}
                onPress={() => onCopy(role)}
              />
              <GhostIconButton
                theme={theme}
                icon="Pencil"
                accessibilityLabel={`Edit ${role.name}`}
                onPress={() => onEdit(role)}
              />
              <GhostIconButton
                theme={theme}
                icon="Trash2"
                danger
                accessibilityLabel={`Delete ${role.name}`}
                onPress={() => {
                  if (usedBy.length > 0) setBlocked({ role, teams: usedBy });
                  else onDelete(role);
                }}
              />
            </View>
          </View>
        );
      })}
      <ConfirmDialog
        theme={theme}
        open={blocked !== null}
        title={zh.roleInUse}
        body={
          blocked
            ? zh.cannotDeleteRole(
                blocked.role.name,
                blocked.teams.map((team) => team.name).join("、"),
              )
            : ""
        }
        confirmLabel={zh.ok}
        onCancel={() => setBlocked(null)}
        onConfirm={() => setBlocked(null)}
      />
    </View>
  );
}

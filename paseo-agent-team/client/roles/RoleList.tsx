import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { Role } from "../../shared/schemas/role";
import type { Team } from "../../shared/schemas/team";
import { zh } from "../../shared/zh";
import { preferredProfileLabel, teamsUsingRole } from "../domain/validation";
import type { PaseoProfile } from "../paseo/adapter";
import { GhostIconButton } from "../shared/buttons";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { RoleGlyph } from "../shared/RoleGlyph";
import type { PluginTheme } from "../shared/theme";

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
        const profile = preferredProfileLabel(role, profiles);
        const usage = usedBy.length === 0 ? zh.unused : zh.usedBy(usedBy.length);
        return (
          <View key={role.id} style={[styles.row, index > 0 && styles.rowBorder]}>
            <RoleGlyph theme={theme} icon={role.icon} color={role.color} size={16} />
            <View style={styles.main}>
              <View style={styles.titleLine}>
                <Text style={styles.title} numberOfLines={1}>
                  {role.name}
                </Text>
                <Text style={profile.missing ? styles.danger : styles.summary} numberOfLines={1}>
                  {profile.name}
                </Text>
              </View>
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

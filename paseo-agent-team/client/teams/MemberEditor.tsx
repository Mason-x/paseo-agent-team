import { Switch, Text, View } from "react-native";
import type { Role } from "../../shared/schemas/role";
import type { TeamMember } from "../../shared/schemas/team";
import { zh } from "../../shared/zh";
import { GhostIconButton } from "../shared/buttons";
import { inputStyle } from "../shared/Field";
import { ImeTextInput } from "../shared/ImeTextInput";
import { RolePicker } from "../shared/RolePicker";
import type { PluginTheme } from "../shared/theme";

export function MemberEditor({
  theme,
  member,
  roles,
  coordinatorRoleId,
  onChange,
  onMove,
  onRemove,
  revision,
}: {
  theme: PluginTheme;
  member: TeamMember;
  roles: readonly Role[];
  coordinatorRoleId: string;
  onChange: (member: TeamMember) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  revision?: string | number;
}) {
  const memberRoles = roles.filter(
    (role) => role.id !== coordinatorRoleId || role.id === member.roleId,
  );
  return (
    <View
      style={{
        gap: 8,
        padding: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 4 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <RolePicker
            theme={theme}
            label={zh.role}
            roles={memberRoles}
            selectedId={member.roleId}
            onChange={(roleId) => onChange({ ...member, roleId })}
          />
        </View>
        <View style={{ flexDirection: "row", gap: 4, marginTop: 22 }}>
          <GhostIconButton
            theme={theme}
            icon="ChevronUp"
            accessibilityLabel={zh.moveMemberUp}
            onPress={() => onMove(-1)}
          />
          <GhostIconButton
            theme={theme}
            icon="ChevronDown"
            accessibilityLabel={zh.moveMemberDown}
            onPress={() => onMove(1)}
          />
          <GhostIconButton
            theme={theme}
            icon="Trash2"
            danger
            accessibilityLabel={zh.removeMember}
            onPress={onRemove}
          />
        </View>
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{zh.instanceLabel}</Text>
      <ImeTextInput
        initialValue={member.instanceLabel ?? ""}
        revision={revision}
        onChangeText={(instanceLabel) =>
          onChange({ ...member, instanceLabel: instanceLabel === "" ? undefined : instanceLabel })
        }
        placeholder={zh.instancePlaceholder}
        placeholderTextColor={theme.colors.foregroundMuted}
        style={inputStyle(theme)}
      />
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: theme.colors.foreground }}>{zh.enabled}</Text>
        <Switch
          value={member.enabled}
          onValueChange={(enabled) => onChange({ ...member, enabled })}
        />
      </View>
    </View>
  );
}

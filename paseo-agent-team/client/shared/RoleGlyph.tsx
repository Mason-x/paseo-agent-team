import { Icon } from "@getpaseo/plugin/client/react-native";
import { View } from "react-native";
import { identityForeground, resolveIdentityColor, resolveRoleIcon } from "./appearance";
import type { PluginTheme } from "./theme";

export function RoleGlyph({
  theme,
  icon,
  color,
  size = 16,
}: {
  theme: PluginTheme;
  icon?: string;
  color?: string;
  size?: number;
}) {
  const identity = resolveIdentityColor(color);
  const tint = identityForeground(identity, theme.colors.surface0) ?? theme.colors.foregroundMuted;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Icon name={resolveRoleIcon(icon)} size={size} color={tint} />
    </View>
  );
}

import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text } from "react-native";
import type { PluginTheme } from "../shared/theme";

export function RunHeader({
  theme,
  title,
  collapsed,
  highlighted,
  onToggle,
}: {
  theme: PluginTheme;
  title: string;
  collapsed: boolean;
  highlighted?: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={collapsed ? `展开 ${title}` : `收起 ${title}`}
      onPress={onToggle}
      style={{
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: highlighted ? theme.colors.surface2 : theme.colors.surface1,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
      }}
    >
      <Icon
        name={collapsed ? "ChevronRight" : "ChevronDown"}
        size={14}
        color={theme.colors.foregroundMuted}
      />
      <Text style={{ color: theme.colors.foreground, fontWeight: "700", flex: 1 }}>{title}</Text>
    </Pressable>
  );
}

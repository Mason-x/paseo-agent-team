import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import type { RunProgress } from "../../shared/domain/run-progress";
import { zh } from "../../shared/zh";
import type { PluginTheme } from "../shared/theme";
import { MemberCounts, PhaseBadge } from "./progress-ui";

function HeaderAction({
  theme,
  icon,
  label,
  active,
  onPress,
}: {
  theme: PluginTheme;
  icon: string;
  label: string;
  active?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active === true }}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: 8,
          minHeight: 26,
          borderRadius: 7,
          backgroundColor: active ? theme.colors.surface2 : "transparent",
        },
        pressed && { opacity: 0.6 },
      ]}
    >
      <Icon
        name={icon}
        size={13}
        color={active ? theme.colors.accent : theme.colors.foregroundMuted}
      />
      <Text
        style={{ color: active ? theme.colors.accent : theme.colors.foregroundMuted, fontSize: 12 }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function RunHeader({
  theme,
  title,
  collapsed,
  highlighted,
  progress,
  detailOpen,
  onToggle,
  onToggleDetail,
  onFollowUp,
}: {
  theme: PluginTheme;
  title: string;
  collapsed: boolean;
  highlighted?: boolean;
  progress?: RunProgress;
  detailOpen?: boolean;
  onToggle: () => void;
  onToggleDetail?: () => void;
  onFollowUp?: () => void;
}) {
  return (
    <View
      style={{
        paddingHorizontal: 16,
        paddingVertical: 8,
        gap: 6,
        backgroundColor: highlighted ? theme.colors.surface2 : theme.colors.surface1,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={collapsed ? `${zh.expand} ${title}` : `${zh.collapse} ${title}`}
        onPress={onToggle}
        style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
      >
        <Icon
          name={collapsed ? "ChevronRight" : "ChevronDown"}
          size={14}
          color={theme.colors.foregroundMuted}
        />
        <Text
          style={{ color: theme.colors.foreground, fontWeight: "700", flex: 1 }}
          numberOfLines={2}
        >
          {title}
        </Text>
        {progress ? <PhaseBadge theme={theme} phase={progress.phase} /> : null}
      </Pressable>
      {progress || onToggleDetail || onFollowUp ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 6,
            paddingLeft: 22,
          }}
        >
          {progress ? <MemberCounts theme={theme} progress={progress} /> : <View />}
          <View style={{ flexDirection: "row", gap: 2 }}>
            {onToggleDetail ? (
              <HeaderAction
                theme={theme}
                icon="ListChecks"
                label={zh.progress}
                active={detailOpen}
                onPress={onToggleDetail}
              />
            ) : null}
            {onFollowUp ? (
              <HeaderAction
                theme={theme}
                icon="MessageSquarePlus"
                label={zh.followUp}
                onPress={onFollowUp}
              />
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

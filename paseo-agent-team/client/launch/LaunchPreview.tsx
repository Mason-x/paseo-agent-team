import { Text, View } from "react-native";
import { zh } from "../../shared/zh";
import type { LaunchPlan } from "../domain/launch-plan";
import { RoleGlyph } from "../shared/RoleGlyph";
import type { PluginTheme } from "../shared/theme";

function sourceLabel(source: string): string {
  if (source === "role-fallback") return zh.fallback;
  return zh.preferred;
}

export function LaunchPreview({ theme, plan }: { theme: PluginTheme; plan: LaunchPlan }) {
  const rows = [plan.coordinator, ...plan.members];
  return (
    <View style={{ gap: 8 }}>
      {rows.map((agent) => (
        <View
          key={`${agent.kind}-${agent.role.id}-${agent.instanceLabel ?? ""}`}
          style={{
            flexDirection: "row",
            alignItems: "flex-start",
            gap: 8,
            paddingVertical: 8,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.border,
          }}
        >
          <RoleGlyph theme={theme} icon={agent.role.icon} color={agent.role.color} size={16} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>
              {agent.kind === "coordinator" ? zh.coordinator : zh.member} · {agent.role.name}
              {agent.instanceLabel ? ` (${agent.instanceLabel})` : ""}
            </Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {agent.profile.name} (
              {agent.profile.model
                ? `${agent.profile.provider}/${agent.profile.model}`
                : agent.profile.provider}
              ) · {sourceLabel(agent.source)}
            </Text>
          </View>
        </View>
      ))}
      {plan.warnings.map((warning) => (
        <Text key={warning} style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
          {warning}
        </Text>
      ))}
      {plan.blockers.map((blocker) => (
        <Text
          key={blocker}
          style={{ color: theme.colors.statusDanger, fontSize: 12, fontWeight: "600" }}
        >
          {blocker}
        </Text>
      ))}
    </View>
  );
}

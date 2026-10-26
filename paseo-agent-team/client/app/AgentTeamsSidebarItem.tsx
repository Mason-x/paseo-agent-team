import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
// SidebarRow lives in client/ui on 0.12 and 0.13; the rest of the UI is still in client/react-native on 0.12.
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { AGENT_TEAMS_SCREEN } from "./tabs";

export function AgentTeamsSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Users"
      active={currentScreen?.screenId === AGENT_TEAMS_SCREEN}
      onPress={() => openScreen({ screenId: AGENT_TEAMS_SCREEN })}
    />
  );
}

import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AgentTeamsSurface } from "./client/app/AgentTeamsSurface";
import { requestLaunch } from "./client/launch/events";
import { AgentCrew } from "./client/main";
import { zh } from "./shared/zh";

export default function contribute(client: PluginClientContext) {
  client.addSurface("agent-teams", AgentTeamsSurface);
  client.addSidebarItem({
    id: "agent-teams",
    title: zh.sidebarAgentTeams,
    icon: "Users",
    surface: "agent-teams",
  });
  client.addWorkspacePanel({
    id: "crew",
    title: zh.sidebarAgentCrew,
    icon: "Network",
    context: "workspace",
    locations: ["explorer"],
    Component: AgentCrew,
  });
  client.addCommandCenterItem({
    id: "open-agent-teams",
    title: zh.openAgentTeams,
    icon: "Users",
    keywords: ["roles", "teams", "crew", "agents", "Role", "Team"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("agent-teams");
    },
  });
  client.addCommandCenterItem({
    id: "open-crew",
    title: zh.openAgentCrew,
    icon: "Network",
    keywords: [
      "agents",
      "subagents",
      "orchestration",
      "delegation",
      "workers",
      "workspace",
      "班组",
    ],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("crew", { location: "explorer" });
    },
  });
  client.addCommandCenterItem({
    id: "launch-team",
    title: zh.launchTeamCommand,
    icon: "Play",
    keywords: ["team", "launch", "crew", "roles", "启动"],
    context: "workspace",
    onSelect({ workspace, openPanel }) {
      openPanel("crew", { location: "explorer" });
      requestLaunch({ workspaceId: workspace.id });
    },
  });
  return () => {};
}

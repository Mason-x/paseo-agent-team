import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AgentTeamsScreen } from "./client/app/AgentTeamsScreen";
import { AgentTeamsSidebarItem } from "./client/app/AgentTeamsSidebarItem";
import { AGENT_TEAMS_SCREEN } from "./client/app/tabs";
import { requestLaunch } from "./client/launch/events";
import { AgentCrew } from "./client/main";
import { zh } from "./shared/zh";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addScreen({
      id: AGENT_TEAMS_SCREEN,
      title: zh.sidebarAgentTeams,
      Component: AgentTeamsScreen,
    }),
    client.addSidebarHeaderItem({
      id: AGENT_TEAMS_SCREEN,
      title: zh.sidebarAgentTeams,
      Component: AgentTeamsSidebarItem,
    }),
    client.addWorkspacePanel({
      id: "crew",
      title: zh.sidebarAgentCrew,
      icon: "Network",
      context: "workspace",
      locations: ["explorer"],
      Component: AgentCrew,
    }),
    client.addCommandCenterItem({
      id: "open-agent-teams",
      title: zh.openAgentTeams,
      icon: "Users",
      keywords: ["roles", "teams", "crew", "agents", "Role", "Team"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: AGENT_TEAMS_SCREEN });
      },
    }),
    client.addCommandCenterItem({
      id: "open-agent-team-runs",
      title: zh.openAgentTeamRuns,
      icon: "ListChecks",
      keywords: ["runs", "progress", "status", "进度", "运行"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: AGENT_TEAMS_SCREEN, params: { tab: "runs" } });
      },
    }),
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
    }),
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
    }),
    client.addSlashCommand({
      name: "team",
      description: zh.teamSlashDescription,
      argumentHint: zh.teamSlashHint,
      context: "workspace",
      onSubmit({ workspace, openPanel, args }) {
        openPanel("crew", { location: "explorer" });
        requestLaunch({ workspaceId: workspace.id, args });
      },
    }),
  ];

  return () => {
    for (const cleanup of cleanups.reverse()) void cleanup();
  };
}

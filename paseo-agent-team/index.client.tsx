import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AgentTeamsScreen } from "./client/app/AgentTeamsScreen";
import { AgentTeamsSidebarItem } from "./client/app/AgentTeamsSidebarItem";
import { AGENT_TEAMS_SCREEN } from "./client/app/tabs";
import { handleDesignSlashCommand } from "./client/designer/events";
import { requestLaunch } from "./client/launch/events";
import { AgentCrew } from "./client/main";
import { designStatusRpc } from "./shared/rpc";
import { zh } from "./shared/zh";
import { designZh } from "./shared/zh/design";

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
    client.addSlashCommand({
      name: "team-design",
      description: designZh.teamDesignSlashDescription,
      argumentHint: designZh.teamDesignSlashHint,
      context: "workspace",
      async onSubmit({ args, workspace, rpc, openScreen }) {
        const result = await handleDesignSlashCommand({
          args,
          workspaceId: workspace.id,
          now: Date.now(),
          readScopeId: async () => {
            try {
              const status = await rpc(designStatusRpc, {});
              return status.ok ? status.scopeId : null;
            } catch {
              return null;
            }
          },
          openScreen,
        });
        if (result.kind === "invalid") {
          openScreen({
            screenId: AGENT_TEAMS_SCREEN,
            params: {
              tab: "teams",
              designNotice: "too-long",
              designNoticeNonce: Date.now().toString(36),
            },
          });
        }
      },
    }),
  ];

  return () => {
    for (const cleanup of cleanups.reverse()) void cleanup();
  };
}

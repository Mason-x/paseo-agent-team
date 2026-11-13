import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { RunPanel, RunsScreen } from "./client/RunsView";
import { TeamSettingsScreen } from "./client/TeamSettings";

const SCREEN = "runs";
const TITLE = "Agent Team";

function SidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Users"
      active={currentScreen?.screenId === SCREEN}
      onPress={() => openScreen({ screenId: SCREEN })}
    />
  );
}

type OpenFn = (opts: { screenId: string; params?: Record<string, string> }) => void;
const openNew = (open: OpenFn, repo?: string, prompt?: string) =>
  open({
    screenId: SCREEN,
    params: {
      new: "1",
      ...(repo ? { repo } : {}),
      ...(prompt?.trim() ? { prompt: prompt.trim() } : {}),
      nonce: String(Date.now()),
    },
  });

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addScreen({ id: SCREEN, title: TITLE, Component: RunsScreen }),
    client.addSidebarHeaderItem({ id: SCREEN, title: TITLE, Component: SidebarItem }),
    client.addWorkspacePanel({
      id: "run",
      title: "Team Run",
      icon: "ListChecks",
      locations: ["explorer"],
      Component: RunPanel,
    }),
    client.addSettingsScreen({
      id: "agent-team-settings",
      title: TITLE,
      icon: "Users",
      Component: TeamSettingsScreen,
    }),
    client.addSlashCommand({
      name: "team",
      context: "workspace",
      description: "新建 Team Run（单写手 + 门禁验收 + 独立审查）",
      argumentHint: "[任务标题或说明]",
      onSubmit: ({ workspace, openScreen, args }) =>
        openNew(openScreen, workspace.projectRootPath || workspace.directory, args),
    }),
    client.addCommandCenterItem({
      id: "open-runs",
      title: "打开 Agent Team 任务台",
      icon: "ListChecks",
      keywords: ["team", "run", "agent", "任务"],
      context: "global",
      onSelect: ({ openScreen }) => openScreen({ screenId: SCREEN }),
    }),
    client.addCommandCenterItem({
      id: "new-run",
      title: "新建 Team Run",
      icon: "Play",
      keywords: ["team", "run", "new", "启动", "新建"],
      context: "global",
      onSelect: ({ openScreen }) => openNew(openScreen),
    }),
    client.addCommandCenterItem({
      id: "new-run-here",
      title: "在当前仓库新建 Team Run",
      icon: "FolderPlus",
      keywords: ["team", "run", "new", "workspace", "当前仓库", "新建"],
      context: "workspace",
      onSelect: ({ workspace, openScreen }) =>
        openNew(openScreen, workspace.projectRootPath || workspace.directory),
    }),
    client.addCommandCenterItem({
      id: "open-run-panel",
      title: "打开当前工作区的 Team Run 面板",
      icon: "ListChecks",
      keywords: ["team", "run", "workspace"],
      context: "workspace",
      onSelect: ({ openPanel }) => openPanel("run", { location: "explorer" }),
    }),
  ];
  return () => {
    for (const c of cleanups) c();
  };
}

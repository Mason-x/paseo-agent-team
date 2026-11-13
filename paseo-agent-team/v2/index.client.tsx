import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { RunPanel, RunsScreen } from "./client/RunsView";

const SCREEN = "runs";
const TITLE = "Agent Team";

function SidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="ListChecks"
      active={currentScreen?.screenId === SCREEN}
      onPress={() => openScreen({ screenId: SCREEN })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addScreen({ id: SCREEN, title: TITLE, Component: RunsScreen }),
    client.addSidebarHeaderItem({ id: SCREEN, title: TITLE, Component: SidebarItem }),
    client.addWorkspacePanel({
      id: "run",
      title: "Team Run",
      icon: "ListChecks",
      context: "workspace",
      locations: ["explorer"],
      Component: RunPanel,
    }),
    client.addCommandCenterItem({
      id: "open-runs",
      title: "打开 Team Run 列表",
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
      onSelect: ({ openScreen }) => openScreen({ screenId: SCREEN, params: { new: "1" } }),
    }),
    client.addCommandCenterItem({
      id: "open-run-panel",
      title: "打开当前工作区的 Team Run",
      icon: "ListChecks",
      keywords: ["team", "run", "workspace"],
      context: "workspace",
      onSelect: ({ openPanel }) => openPanel("run", { location: "explorer" }),
    }),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

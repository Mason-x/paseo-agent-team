import { type ModeAccessDenial, readStoredMode, teamModeDisplay } from "../domain/mode-contract";
import { modesZh } from "./modes";

/**
 * Copy for the mode-contract access gate on launch preview/start and for the legacy status
 * projection. Kept in its own domain file so I01 aggregates it into shared/zh.ts.
 *
 * A refusal must name the mode the way the UI does ("经济", never the stored "economy-all"). A
 * value this build cannot recognize is a damaged Team, not a stale page: point at the Team
 * editor instead of claiming an update is needed.
 */
export const launchContractZh = {
  modeRequired: (subject: ModeAccessDenial["subject"], value: string) => {
    const stored = readStoredMode(value);
    if (stored.status === "unknown") {
      return `组队模式「${stored.raw}」无法识别；请到 Team 编辑器中重新选择模式。`;
    }
    const label = modesZh.modeLabels[teamModeDisplay(stored.mode)];
    return subject === "request"
      ? `本次运行模式「${label}」需要新版 App 支持。`
      : `组队模式「${label}」需要新版 App 支持。`;
  },
  refreshHint: "如果刚更新过插件，请刷新页面后再试。",
};

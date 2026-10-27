import type { ModeAccessDenial } from "../domain/mode-contract";

/**
 * Copy for the mode-contract access gate on launch preview/start. Kept in its own domain file so
 * I01 can aggregate it into shared/zh.ts without touching this module.
 *
 * The refusal is shown to a stale page that cannot carry the Team's saved mode; it is not a
 * configuration error, so the wording points at the plugin refresh instead of the mode value.
 */
export const launchContractZh = {
  modeRequired: (subject: ModeAccessDenial["subject"], value: string) =>
    subject === "request"
      ? `本次运行模式「${value}」需要更新插件后使用。`
      : `组队模式「${value}」需要更新插件后使用。`,
  refreshHint: "插件已更新，请刷新页面后再试。",
};

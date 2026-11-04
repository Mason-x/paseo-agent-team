/**
 * Copy for the retired-mode answer on launch preview/start. Kept in its own domain file so
 * shared/zh.ts aggregates it. The mode is gone, so the text says so and points at a page refresh.
 */
export const launchContractZh = {
  retiredMode: (value: string) =>
    `组队模式已取消，不再支持「${value}」；本次按各 Role 的绑定运行，请刷新页面后重试。`,
  refreshHint: "如果刚更新过插件，请刷新页面后再试。",
};

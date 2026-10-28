/**
 * Chinese copy for the designer's "只用现有 Role" switch, the Role-gap card, and the "close the
 * switch and retry" flow. Kept out of `shared/zh/design.ts` and `shared/zh.ts` (I01 merges both).
 * Every gap text comes from the server-verified report; nothing here names a Profile or a Role.
 */
export const designGapZh = {
  switchLabel: "只用现有 Role",
  switchHintOn: "开启：设计师只能复用现有 Role，不会新增 Role；现有 Role 不够时会列出缺口。",
  switchHintOff: "关闭：设计师可以新增最多 3 个 Role。",
  switchNeedsUpgrade:
    "当前 host 版本不支持此选项，请升级插件后使用；本次按旧规则（最多 3 个新 Role）设计。",
  switchProbePending: "正在确认 host 版本，稍后再试；确认前按旧规则（最多 3 个新 Role）设计。",

  modeNeedsUpgrade: "经济模式需要升级后的 host，请升级插件后再使用。",
  modeProbePending: "正在确认 host 是否支持此模式，请稍后重试。",

  rulesOnly: "规则：只用现有 Role",
  rulesMax3: "规则：最多 3 个新 Role",
  rulesLegacy: "规则：旧规则，最多 3 个新 Role",

  gapTitle: "现有 Role 有缺口",
  gapIntro:
    "设计师认为现有 Role 无法完成这次需求。补齐后再重试，或关闭「只用现有 Role」让设计师新增 Role。",
  gapCount: (count: number) => `共 ${count} 项缺口`,
  gapResponsibility: "职责",
  gapReason: "原因",
  gapUse: (use: "coordinator" | "member") =>
    use === "coordinator" ? "用途：协调者" : "用途：成员",

  suggestedRoleTitle: "建议新增的 Role",
  suggestedRoleLine: (id: string, name: string) => `${name}（${id}）`,
  suggestedRolePolicy: (tier: string, taskKind: string) => `层级 ${tier} · 任务类型 ${taskKind}`,
  unlaunchableTitle: "现有 Role 当前无法启动",
  unlaunchableRole: (name: string, id: string) => `${name}（${id}）`,
  unavailableBindings: (names: readonly string[]) => `不可用的绑定：${names.join("、")}`,
  profilesTitle: "可考虑的 Profile",
  profileLine: (name: string, provider: string, model?: string) =>
    model ? `${name} · ${provider}/${model}` : `${name} · ${provider}`,
  noSuitableProfile: "本 host 没有合适的 Profile",
  noSuitableProfileReason: (reason: string) => `说明：${reason}`,

  actionCreateRole: "去 Role 页补齐",
  actionOpenRole: "去绑定",
  actionConfigureEconomy: "配置「经济：全席位」路由",
  economyHint: "经济模式下，补救方法是调整「经济：全席位」路由，而不是修改 Role 的原绑定。",

  retry: "关闭开关并修改重试",
  retryBusy: "正在准备…",
  retryHint: "只会回填需求并关闭「只用现有 Role」，不会自动开始；原任务和缺口保持不变。",
  retryUnavailable: "无法恢复原需求，请重新输入需求后再试。",
  retryConfirmTitle: "要替换当前草稿吗？",
  retryConfirmBody: "设计框里已有未提交的内容，回填会覆盖它。",
  retryConfirmReplace: "替换当前草稿",
  retryConfirmCancel: "取消",
} as const;

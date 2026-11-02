/**
 * Chinese copy for the Team model plan (list summaries, editor rows, and the two problem exits).
 *
 * I01 also exposes this module as `zh.teamPlan` for API parity; the B03 components import it
 * directly, so edits here reach both. No other task writes this file.
 */
export const teamPlanZh = {
  pending: "正在计算模型…",
  loadFailed: "暂无法读取模型",
  retry: "重试",
  refresh: "刷新",
  teamMissing: "Team 不存在或已删除，请刷新",
  unknownMode: (raw: string) => `组队模式无法识别${raw ? `：${raw}` : ""}`,
  legacyUnavailable: "当前插件版本不支持模型规划",

  group: (label: string, count: number) => `${label} ×${count}`,
  unresolved: (count: number, reasons: string) =>
    reasons ? `未解析 ×${count}：${reasons}` : `未解析 ×${count}`,
  reasonCount: (label: string, count: number) => `${label} ×${count}`,
  reasons: {
    unbound: "未绑定",
    roleMissing: "Role 已删除",
    profileMissing: "Profile 已删除",
    providerUnavailable: "Provider 不可用",
    unverified: "可用性未核实",
    policy: "策略限制",
  },

  availability: {
    available: "可用",
    unavailable: "不可用",
    unverified: "未核实",
  },
  purpose: {
    member: "成员",
  },
  activation: {
    eager: "立即创建",
    onDemand: "按需创建",
  },

  disabled: "已停用",
  otherSeats: "其他席位",
  configured: (names: string) => `候选：${names}`,
  noProfile: "未绑定",
  noSelection: "当前无可运行的选中 Profile",
  rebind: "去绑定",

  reservedRowKey: "成员行不能占用协调者的 rowKey",
  duplicateRowKey: "成员行存在重复 rowKey，请刷新后重试",
  tooManyMembers: (limit: number) => `草稿成员超过 ${limit} 个，请先精简`,

  bindings: {
    preferred: "首选",
    fallback: "备选",
    empty: "无备选",
    missing: (name: string) => `缺失 Profile「${name}」`,
    expand: (count: number) => `+${count}`,
    missingUnnamed: "缺失 Profile（未命名）",
    collapse: "收起",
  },
  roleFocusProfile: (name: string) => `已定位 Profile「${name}」：在首选或备选中调整。`,
  roleFocusUnbound: "该 Role 尚未绑定 Profile：在首选中添加。",
};

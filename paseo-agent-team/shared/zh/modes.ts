import type { TeamModeDisplay } from "../domain/mode-contract";
import type { AllSeatsRoute } from "../schemas/team-mode";

/**
 * Chinese copy for the four team modes and the economy-all ("全席位") policy editor. Labels are
 * keyed by the display identity from shared/domain/mode-contract.ts, never by stored value, so the
 * Team editor, designer, Team plan, launch preview, and summary all read one table.
 *
 * `zh.modes` in shared/zh.ts is wired by I01; until then direct imports of this file are the
 * single source. This file is the only place U01 adds copy.
 */
export const modesZh = {
  modeLabels: {
    flagship: "旗舰（SOTA）",
    standard: "标准",
    economy: "经济",
    collaborative: "协作",
  } satisfies Record<TeamModeDisplay, string>,

  modeHints: {
    flagship: "沿用 Role 原绑定，决策与执行都优先使用原 Profile。",
    standard: "决策层保留原绑定，执行层按经济池选择。",
    economy: "所有席位只用合格廉价模型；任一层缺合格候选即阻断启动。",
    collaborative: "执行层多路候选，测试与审查后择优；需要隔离工作区。",
  } satisfies Record<TeamModeDisplay, string>,

  standardPoolTitle: "标准：执行池",
  economyAllTitle: "经济：全席位",
  economyAllIntro:
    "经济模式下协调者、决策（含审查）、执行、升级（含待命）与保留层都只使用合格廉价 Profile；任一层缺合格候选即阻断启动。",
  economyAllEmpty: "经济名单为空；添加已核实低成本的 Profile 后经济模式才可启动。",
  economyAllAddProfile: "添加廉价 Profile",
  economyAllNoEligible: "没有可添加的已核实低成本 Profile。",
  economyAllLimit: (limit: number) => `名单与每层最多 ${limit} 项。`,
  economyAllEntryReady: "合格",
  economyAllEntryDisabled: "已停用",
  economyAllExcludedProfileMissing: (profileId: string) => `Profile 不存在：${profileId}`,
  economyAllExcludedModel: "live model 无法识别为已支持的低成本系列",
  economyAllExcludedHighCost: "live model 属于高价系列，不能进入经济名单",
  economyAllExcludedRebind: "provider/model 已变化或家族未核实，需重新确认",
  economyAllRebind: "重新确认低成本身份",
  economyAllProviderUnavailable: (provider: string, reason?: string) =>
    `Provider ${provider} 不可用${reason ? `：${reason}` : ""}`,
  economyAllProviderUnverified: (provider: string) => `Provider ${provider} 可用性未核实`,
  economyAllRoutesTitle: "五层路由",
  economyAllRoutesHint: "每层按顺序尝试；未配置的层不会借用其他层、原绑定或预算标注。",
  economyAllRouteLabels: {
    coordinator: "协调者",
    decision: "决策（含审查）",
    execution: "执行",
    escalation: "升级（待命）",
    retain: "保留",
  } satisfies Record<AllSeatsRoute, string>,
  economyAllRouteEmpty: "该层没有候选；经济模式下会阻断。",
  economyAllRouteAdd: "添加候选",
  economyAllRouteRemoveFor: (name: string) => `从该层移除 ${name}`,
  economyAllRouteLimit: (limit: number) => `每层最多 ${limit} 项。`,
  economyAllTaskOrderTitle: "执行任务顺序",
  economyAllTaskOrderHint: "只重排执行层内部顺序；未列出的任务按执行层路由顺序。",
  economyAllTaskOrderReset: "使用路由顺序",
  economyAllSuggest: "采用建议（只改草稿）",
  economyAllSuggestedNone: "没有可用的建议，草稿未改动。",
  economyAllProfilesRequired: "无法核实廉价身份：需要读取当前 host 的 Profile 后才能保存。",
  economyAllVersionUnknown: (version: string) =>
    `经济名单的存储版本未知（${version}）；未编辑时原样保留，编辑后保存会以 v1 重写该块。`,
  economyAllRemoveFor: (name: string) => `移出经济名单 ${name}`,
  economyAllToggleFor: (name: string) => `${name} 是否启用`,
};

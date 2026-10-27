import { TEAM_MODE_ECONOMY_ALL as ECONOMY_ALL_MODE, UNKNOWN_TEAM_MODE } from "./team-modes";

// Standalone Team records for every stored mode value, plus the legacy "mode absent" case and a
// value no version recognizes. Unknown top-level/member keys are intentional: both the baseline
// and the P1 Team schema pass them through, so a round-trip must preserve them.
//
// Treat these objects as read-only; structuredClone before mutating a test copy.

const CREATED_AT = "2026-10-20T08:00:00.000Z";
const UPDATED_AT = "2026-10-21T09:30:00.000Z";

export const TEAM_SOTA = {
  id: "compat-mode-sota",
  name: "兼容：旗舰",
  description: "基线 sota Team，旗舰规划不变。",
  mode: "sota",
  coordinatorRoleId: "tech-lead",
  members: [
    { roleId: "architect", instanceLabel: "架构", seatId: "seat-architect", enabled: true },
    { roleId: "developer", instanceLabel: "实现", seatId: "seat-developer", enabled: true },
  ],
  operatingRules: "实现与审查由不同成员承担。",
  enabled: true,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
};

export const TEAM_ECONOMY = {
  id: "compat-mode-economy",
  name: "兼容：标准（旧经济）",
  description: "基线 economy Team；P1 起显示为“标准”，语义不变。",
  mode: "economy",
  memberCreation: "eager",
  coordinatorRoleId: "tech-lead",
  members: [
    { roleId: "architect", instanceLabel: "架构", seatId: "seat-architect", enabled: true },
    { roleId: "developer", instanceLabel: "实现", seatId: "seat-developer", enabled: true },
  ],
  operatingRules: "执行层走经济池，其余层保留原绑定。",
  enabled: true,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  futureTeamField: { keep: "team-level-economy" },
};

export const TEAM_ECONOMY_ALL = {
  id: "compat-mode-economy-all",
  name: "兼容：经济（全席位）",
  description: "P1 新经济 Team；所有席位含协调者只用廉价 Profile。",
  mode: ECONOMY_ALL_MODE,
  memberCreation: "eager",
  coordinatorRoleId: "tech-lead",
  members: [
    { roleId: "architect", instanceLabel: "架构", seatId: "seat-architect", enabled: true },
    { roleId: "developer", instanceLabel: "实现", seatId: "seat-developer", enabled: true },
  ],
  operatingRules: "任一层缺合格廉价 Profile 即阻断，不回退原绑定。",
  enabled: true,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
};

export const TEAM_COLLABORATIVE = {
  id: "compat-mode-collaborative",
  name: "兼容：协作",
  description: "协作 Team；运行能力仍由 5B capability 决定。",
  mode: "collaborative",
  coordinatorRoleId: "tech-lead",
  members: [
    { roleId: "architect", instanceLabel: "架构 A", seatId: "seat-architect-a", enabled: true },
    { roleId: "architect", instanceLabel: "架构 B", seatId: "seat-architect-b", enabled: true },
    { roleId: "developer", instanceLabel: "实现", seatId: "seat-developer", enabled: true },
  ],
  collaboration: {
    replicas: 2,
    judgeRoleId: "architect",
    escalationRoleId: "developer",
    futureCollaborationField: { keep: "collaboration" },
  },
  operatingRules: "副本方案由评审席归并。",
  enabled: true,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
};

/** Legacy Team saved before `mode` existed: absent, not the string "sota". */
export const TEAM_LEGACY_NO_MODE = {
  id: "compat-mode-absent",
  name: "兼容：无模式",
  description: "旧 Team 未写 mode 字段；按基线默认旗舰规划。",
  coordinatorRoleId: "tech-lead",
  members: [
    { roleId: "developer", instanceLabel: "实现", seatId: "seat-developer", enabled: true },
  ],
  enabled: true,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
};

/** Stored value recognized by no version. Must stay verbatim on read/write. */
export const TEAM_UNKNOWN_MODE = {
  id: "compat-mode-unknown",
  name: "兼容：未知模式",
  description: "未来 writer 写入的模式；不得当成旗舰，也不得被保存动作改写。",
  mode: UNKNOWN_TEAM_MODE,
  coordinatorRoleId: "tech-lead",
  members: [
    {
      roleId: "developer",
      instanceLabel: "实现",
      seatId: "seat-developer",
      enabled: true,
      futureMemberField: { keep: "member-unknown-mode" },
    },
  ],
  enabled: true,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  futureTeamField: { keep: "team-unknown-mode", nested: [1, 2] },
};

export const TEAM_MODE_FIXTURES = {
  sota: TEAM_SOTA,
  economy: TEAM_ECONOMY,
  economyAll: TEAM_ECONOMY_ALL,
  collaborative: TEAM_COLLABORATIVE,
  modeAbsent: TEAM_LEGACY_NO_MODE,
  unknown: TEAM_UNKNOWN_MODE,
};

/** Baseline-shaped Teams document, including one unknown mode and unknown top-level keys. */
export const BASELINE_TEAMS_DOCUMENT = {
  teams: [TEAM_SOTA, TEAM_ECONOMY, TEAM_COLLABORATIVE, TEAM_UNKNOWN_MODE],
  futureDocumentField: { keep: "baseline-teams-document" },
};

/** One Teams document containing every stored mode value; the X5/X12 round-trip probe. */
export const TEAMS_DOCUMENT_ALL_MODES = {
  teams: [
    TEAM_SOTA,
    TEAM_ECONOMY,
    TEAM_ECONOMY_ALL,
    TEAM_COLLABORATIVE,
    TEAM_LEGACY_NO_MODE,
    TEAM_UNKNOWN_MODE,
  ],
  futureDocumentField: { keep: "all-modes-teams-document" },
};

// Fixture → X/AC contract matrix. This file is data for reports and for tests that want to
// iterate the fixture set; it deliberately contains no expectations about P1 planning semantics.
// The X numbers come from .notes/01-spec-p1.md (L4 counterexample list); the AC numbers identify
// the acceptance criterion each fixture feeds.

export type CompatFixtureGroup =
  | "team-mode"
  | "teams-document"
  | "preferences"
  | "design-ledger-v1"
  | "rpc-input";

export type CompatMatrixRow = {
  fixture: string;
  group: CompatFixtureGroup;
  x: readonly string[];
  ac: readonly string[];
  note: string;
};

export const P1_COMPAT_MATRIX: readonly CompatMatrixRow[] = [
  {
    fixture: "BASELINE_TEAM_MODES",
    group: "team-mode",
    x: ["X5"],
    ac: ["AC-0d.10", "AC-0d.11", "AC-0d.13"],
    note: "75ec305 的严格枚举来源；用于旧值映射与往返对照。",
  },
  {
    fixture: "TEAM_MODE_ECONOMY_ALL",
    group: "team-mode",
    x: ["X2", "X5"],
    ac: ["AC-0d.3", "AC-0d.11"],
    note: "04 §3.1 A 的新存储值；仅数据，不断言规划结果。",
  },
  {
    fixture: "UNKNOWN_TEAM_MODE",
    group: "team-mode",
    x: ["X5", "X12"],
    ac: ["AC-0d.11", "AC-0d.12", "AC-0d.18"],
    note: "任何版本都不识别的值；必须原样往返。",
  },
  {
    fixture: "FOUR_TIER_STORED_MODES",
    group: "team-mode",
    x: ["X5"],
    ac: ["AC-0d.11", "AC-0d.17"],
    note: "四档存储值两两不同：sota / economy / economy-all / collaborative。",
  },
  {
    fixture: "TEAM_SOTA",
    group: "teams-document",
    x: ["X5"],
    ac: ["AC-0d.1", "AC-0d.11"],
    note: "旗舰 Team；基线规划不变的输入。",
  },
  {
    fixture: "TEAM_ECONOMY",
    group: "teams-document",
    x: ["X1", "X5", "X12"],
    ac: ["AC-0d.2", "AC-0d.10", "AC-0d.11"],
    note: "旧 economy = 标准；含 memberCreation 与未知顶层字段。",
  },
  {
    fixture: "TEAM_ECONOMY_ALL",
    group: "teams-document",
    x: ["X2", "X5"],
    ac: ["AC-0d.3", "AC-0d.11"],
    note: "新经济 Team；含未知字段，供新规划用例使用。",
  },
  {
    fixture: "TEAM_COLLABORATIVE",
    group: "teams-document",
    x: ["X5"],
    ac: ["AC-0d.1", "AC-0d.11"],
    note: "协作 Team；重复 Role 带实例标签，协作块含未知字段。",
  },
  {
    fixture: "TEAM_LEGACY_NO_MODE",
    group: "teams-document",
    x: ["X1", "X5"],
    ac: ["AC-0d.10", "AC-0d.11"],
    note: 'mode 字段缺失（不是 "sota"）；基线默认旗舰。',
  },
  {
    fixture: "TEAM_UNKNOWN_MODE",
    group: "teams-document",
    x: ["X5", "X12"],
    ac: ["AC-0d.11", "AC-0d.12", "AC-0d.18"],
    note: "未知 mode 的 Team；含 Team/成员未知字段，回滚探针输入。",
  },
  {
    fixture: "TEAM_MODE_FIXTURES",
    group: "teams-document",
    x: ["X5"],
    ac: ["AC-0d.11"],
    note: "上述 Team 的命名索引；单文件一次导入。",
  },
  {
    fixture: "BASELINE_TEAMS_DOCUMENT",
    group: "teams-document",
    x: ["X1", "X4", "X12"],
    ac: ["AC-0d.10", "AC-0d.12"],
    note: "基线形态 Teams 文档（含未知 mode 与未知顶层字段）；零写/回滚探针。",
  },
  {
    fixture: "TEAMS_DOCUMENT_ALL_MODES",
    group: "teams-document",
    x: ["X5", "X12"],
    ac: ["AC-0d.11", "AC-0d.12"],
    note: "全部 mode 值同文档往返；四档互不混淆。",
  },
  {
    fixture: "PREFERENCES_WITHOUT_ALL_SEATS",
    group: "preferences",
    x: ["X4", "X6"],
    ac: ["AC-0d.12", "AC-0d.19"],
    note: "基线 Preferences：pool 顺序、未知顶层/economy 子字段、designerProfile/defaultPresets/recentRuns。",
  },
  {
    fixture: "PREFERENCES_BASELINE_EMPTY_POOL",
    group: "preferences",
    x: ["X3"],
    ac: ["AC-0d.6", "AC-0d.7"],
    note: "空池输入；旧调用无 hash 的 start 也不得创建 agent。",
  },
  {
    fixture: "ALL_SEATS_POLICY_V1",
    group: "preferences",
    x: ["X2", "X6"],
    ac: ["AC-0d.3", "AC-0d.4", "AC-0d.5", "AC-0d.19"],
    note: "§4.1 allSeats：四条 Profile（含禁用项）、五层路由、执行任务顺序、未知字段。",
  },
  {
    fixture: "ALL_SEATS_POLICY_FUTURE_VERSION",
    group: "preferences",
    x: ["X6"],
    ac: ["AC-0d.19"],
    note: "version=99 与未知 route 层；未知 version 不得被重置或清空。",
  },
  {
    fixture: "PREFERENCES_WITH_ALL_SEATS",
    group: "preferences",
    x: ["X2", "X4", "X6"],
    ac: ["AC-0d.3", "AC-0d.19"],
    note: "旧 pool 与 allSeats 并存；读写保留两者顺序与未知字段。",
  },
  {
    fixture: "PREFERENCES_ALL_SEATS_FUTURE_VERSION",
    group: "preferences",
    x: ["X6"],
    ac: ["AC-0d.19"],
    note: "整份文档含未来 allSeats；写入仍保留未知字段。",
  },
  {
    fixture: "DESIGN_V1_RECORD_STARTING",
    group: "design-ledger-v1",
    x: ["X7"],
    ac: ["AC-0c.12", "AC-0d.15"],
    note: "schemaVersion=1，starting，0 attempts；可读/可恢复，不写回新字段。",
  },
  {
    fixture: "DESIGN_V1_RECORD_DESIGNING",
    group: "design-ledger-v1",
    x: ["X7", "X9"],
    ac: ["AC-0c.9", "AC-0c.11", "AC-0c.12"],
    note: "旧 economy 在途任务；含 creation 请求与标签，恢复规则取记录而非 UI 默认。",
  },
  {
    fixture: "DESIGN_V1_RECORD_VALIDATING",
    group: "design-ledger-v1",
    x: ["X7"],
    ac: ["AC-0c.12", "AC-0d.15"],
    note: "完整 v1 proposal；旧 economy 的 profileChoices 按标准语义核对。",
  },
  {
    fixture: "DESIGN_V1_RECORD_READY",
    group: "design-ledger-v1",
    x: ["X7"],
    ac: ["AC-0c.12", "AC-0d.15"],
    note: "含完整 v1 result/preview；mark-saved、重开与旧 DTO 读取。",
  },
  {
    fixture: "DESIGN_V1_RECORD_FAILED",
    group: "design-ledger-v1",
    x: ["X7"],
    ac: ["AC-0c.12"],
    note: "旧终态失败记录；升级后仍可读、保持终态。",
  },
  {
    fixture: "DESIGN_V1_RECORDS",
    group: "design-ledger-v1",
    x: ["X7", "X9"],
    ac: ["AC-0c.12", "AC-0d.15"],
    note: "五条记录的数组；文件名按 <job.jobId>.json 落盘。",
  },
  {
    fixture: "LEGACY_LAUNCH_PREVIEW_INPUT_SAVED_MODE",
    group: "rpc-input",
    x: ["X4", "X12"],
    ac: ["AC-0b.13", "AC-0d.12", "AC-0d.13"],
    note: "旧 App 的 preview：不带 mode，按 Team 保存的模式；只读。",
  },
  {
    fixture: "LEGACY_LAUNCH_PREVIEW_INPUT_ECONOMY_OVERRIDE",
    group: "rpc-input",
    x: ["X1"],
    ac: ["AC-0d.10", "AC-0d.13"],
    note: "旧脚本的高级覆盖 mode:economy，始终等于标准。",
  },
  {
    fixture: "LEGACY_LAUNCH_PREVIEW_INPUT_NEW_WORKSPACE",
    group: "rpc-input",
    x: [],
    ac: ["AC-0b.3", "AC-0d.13"],
    note: "target 为 new-workspace 的旧输入；预览/启动共用。",
  },
  {
    fixture: "LEGACY_LAUNCH_PREVIEW_INPUT_UNKNOWN_MODE",
    group: "rpc-input",
    x: ["X11"],
    ac: ["AC-0d.13", "AC-0d.18"],
    note: "负例：未知 mode 必须被严格枚举拒绝，不得回落保存值。",
  },
  {
    fixture: "LEGACY_LAUNCH_START_INPUT_NO_HASH",
    group: "rpc-input",
    x: ["X3"],
    ac: ["AC-0d.7"],
    note: "旧调用无 expectedPlanHash；经济阻断时零创建。",
  },
  {
    fixture: "LEGACY_LAUNCH_START_INPUT_ECONOMY_OVERRIDE_NO_HASH",
    group: "rpc-input",
    x: ["X1", "X3"],
    ac: ["AC-0d.7", "AC-0d.10", "AC-0d.13"],
    note: "旧 economy 覆盖且无 hash；标准语义与阻断边界。",
  },
  {
    fixture: "LEGACY_LAUNCH_START_INPUT_WITH_HASH",
    group: "rpc-input",
    x: ["X3"],
    ac: ["AC-0d.7", "AC-0d.9"],
    note: "带 planHash 的旧形状；设置变化后 planChanged。",
  },
  {
    fixture: "LEGACY_LAUNCH_START_INPUT_UNKNOWN_MODE",
    group: "rpc-input",
    x: ["X11"],
    ac: ["AC-0d.13", "AC-0d.18"],
    note: "负例：start 同样拒绝未知 mode。",
  },
  {
    fixture: "LEGACY_DESIGN_START_INPUT_ECONOMY",
    group: "rpc-input",
    x: ["X7"],
    ac: ["AC-0c.13", "AC-0d.15"],
    note: "旧 design.start mode:economy；升级后按标准语义恢复/校验。",
  },
  {
    fixture: "LEGACY_DESIGN_START_INPUT_OMITTED_MODE",
    group: "rpc-input",
    x: ["X8"],
    ac: ["AC-0c.10", "AC-0c.13"],
    note: "同 requestId/需求、无 existingRolesOnly；缺省与显式 true 的哈希规范化由实现用例补。",
  },
  {
    fixture: "LEGACY_DESIGN_START_INPUT_SOTA_WORKSPACE",
    group: "rpc-input",
    x: [],
    ac: ["AC-0c.13"],
    note: "旧输入含 workspaceId/profileId；不接受新字段前的兼容基线。",
  },
  {
    fixture: "LEGACY_DESIGN_START_INPUT_DEFAULT_PROFILE_HINTS",
    group: "rpc-input",
    x: [],
    ac: ["AC-0c.13"],
    note: "旧输入 useDefaultProfileHints；与 profileId 互斥的既有约束。",
  },
  {
    fixture: "LEGACY_DESIGN_START_INPUT_UNKNOWN_MODE",
    group: "rpc-input",
    x: ["X11"],
    ac: ["AC-0c.13", "AC-0d.18"],
    note: "负例：设计请求未知 mode 仍被严格拒绝。",
  },
];

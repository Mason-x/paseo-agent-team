# P1 兼容夹具（V01a）

纯数据目录：每个文件只导出 JSON 可序列化对象、字符串或数组，不 import 实现代码，不含断言、
工厂、时钟或 mock。V01b 契约集成、D01–C04 的兼容用例可直接 import。

基线 = `75ec305`（TeamMode 仅 `sota | economy | collaborative`；设计账本 `schemaVersion: 1`；
launch/design RPC 无 `contractVersion`）。本目录同时存放 04-arch-p1.md §3.1 A 冻结后的新存储值
`economy-all` 与一个任何版本都不识别的值 `future-mode-unknown`。

## 边界

- `economy-all` 只是数据，本目录不声明它的规划/阻断语义；未知值必须原样往返（Team.mode、
  Team/成员未知字段、Preferences 顶层与 `economy`/`allSeats` 未知字段）。
- 新契约字段（`contractVersion`、`existingRolesOnly`、`roleGap`、`requestHashVersion`、
  `outputContractVersion`）刻意不出现：它们只有实现后才有合法样本，属于 C01/C03/V01b。
- 所有导出按只读单例使用；测试改动前先 `structuredClone`。
- 账本记录落盘名为 `<job.jobId>.json`，放入 `<PASEO_HOME>/agent-team-designer/v1/jobs/`。

## 文件

| 文件 | 内容 |
| --- | --- |
| `team-modes.ts` | 基线 mode 列表、`economy-all`、未知值、四档常量 |
| `teams.ts` | 六种 mode/缺失模式的 Team、基线 Teams 文档、全模式 Teams 文档 |
| `preferences.ts` | 无 `allSeats`、空池、有 `allSeats`、未来 `allSeats` 的 Preferences |
| `design-ledger-v1.ts` | 五条 `schemaVersion: 1` 记录（starting/designing/validating/ready/failed） |
| `rpc-inputs.ts` | 旧 launch.preview/start 与 design.start 输入，含未知 mode 负例 |
| `matrix.ts` | 每个夹具 → X/AC 的机器可读矩阵 `P1_COMPAT_MATRIX` |
| `index.ts` | barrel re-export |

## X → 夹具

| X | 夹具 | 状态 |
| --- | --- | --- |
| X1 | `TEAM_ECONOMY`、`BASELINE_TEAMS_DOCUMENT`、`LEGACY_LAUNCH_PREVIEW_INPUT_ECONOMY_OVERRIDE`、`LEGACY_LAUNCH_START_INPUT_ECONOMY_OVERRIDE_NO_HASH` | 数据齐备 |
| X2 | `TEAM_ECONOMY_ALL`、`ALL_SEATS_POLICY_V1`、`PREFERENCES_WITH_ALL_SEATS` | 输入齐备；规划断言属 D02/V01b |
| X3 | `PREFERENCES_BASELINE_EMPTY_POOL`、`LEGACY_LAUNCH_START_INPUT_NO_HASH` / `..._ECONOMY_OVERRIDE_NO_HASH` / `..._WITH_HASH` | 数据齐备 |
| X4 | `BASELINE_TEAMS_DOCUMENT`、`PREFERENCES_WITHOUT_ALL_SEATS`、`LEGACY_LAUNCH_PREVIEW_INPUT_SAVED_MODE` | 数据齐备 |
| X5 | `FOUR_TIER_STORED_MODES`、`TEAM_MODE_FIXTURES`、`TEAMS_DOCUMENT_ALL_MODES` | 数据齐备 |
| X6 | `PREFERENCES_WITHOUT_ALL_SEATS`、`PREFERENCES_WITH_ALL_SEATS`、`ALL_SEATS_POLICY_FUTURE_VERSION`、`PREFERENCES_ALL_SEATS_FUTURE_VERSION` | 数据齐备 |
| X7 | `DESIGN_V1_RECORD_STARTING/DESIGNING/VALIDATING/READY/FAILED` | 数据齐备 |
| X8 | `LEGACY_DESIGN_START_INPUT_OMITTED_MODE` | 旧请求齐备；缺省=显式 true 的新输入属 C01/C03 |
| X9 | `DESIGN_V1_RECORD_DESIGNING` | 数据齐备 |
| X10 | 无 | 缺口终态是 v2 新数据，必须由实现创建；不在此伪造 |
| X11 | `LEGACY_LAUNCH_PREVIEW_INPUT_UNKNOWN_MODE`、`LEGACY_LAUNCH_START_INPUT_UNKNOWN_MODE`、`LEGACY_DESIGN_START_INPUT_UNKNOWN_MODE`、旧 RPC 输入 | 旧侧齐备；新 DTO 样本依赖实现，V01b 生成 |
| X12 | `BASELINE_TEAMS_DOCUMENT`、`TEAMS_DOCUMENT_ALL_MODES`、`TEAM_UNKNOWN_MODE`、`LEGACY_LAUNCH_PREVIEW_INPUT_SAVED_MODE` | 数据齐备 |

逐夹具映射（含 AC 与用途说明）见 `matrix.ts` 的 `P1_COMPAT_MATRIX`。

## 使用提示

- `BASELINE_TEAMS_DOCUMENT` / `PREFERENCES_WITHOUT_ALL_SEATS` 用于零写与回滚探针：先快照字节与
  revision，再执行只读路径，最后逐字节比较。
- `TEAMS_DOCUMENT_ALL_MODES` 用于四档与未知值往返；`MODE_UNKNOWN` 的未知 Team/成员字段是
  passthrough 探针。
- `DESIGN_V1_RECORD_*` 用于真实 `createDesignJobStore`：直接写 JSON，重开 store 读取；断言 v1
  记录文件字节未变（新 reader 只在内存补默认值）。
- `LEGACY_DESIGN_START_INPUT_OMITTED_MODE` 与 `..._ECONOMY` 共享同一 `clientRequestId`/需求文本，
  便于构造旧请求哈希与新请求哈希的对照。

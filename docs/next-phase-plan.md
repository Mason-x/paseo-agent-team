# 下一阶段计划：Run Engine 剩余工作的批准裁决与执行计划

编写：2026-11-08，Opus 5.5 max。用户已授权：下列所有待批准事项由本文裁决，先后顺序与做法由本文决定，实施会话不再向用户提问。
基线：`main` 的 `5533722`；分支 `autonomous-p05-p08`，当前 HEAD `f1f1e48`（相对基线 57 个提交：15 feat、6 fix、2 test、34 docs，工作树干净）。
插件根目录 `paseo-agent-team/`，下文路径都相对它（`docs/` 例外）。任务号从 A13 起，沿用 `docs/approved-implementation-plan.md`（A1–A12）的编号；你给的剩余清单项在本文写作"清单 A-1…A-10、B-1…B-3、C、D"。
本文只写裁决和计划，没有改任何源码。通用规则继承 `docs/remaining-work-plan.md` 第 1 节与 `docs/approved-implementation-plan.md` 第 0 节；冲突时以本文为准；本文对既有规则只做一处补充：RPC 总数保持 28，本阶段不新增 RPC。

## 0. 结论摘要

### 0.1 裁决总表

| 清单 | 事项 | 裁决 | 一句话 | 去向 |
| --- | --- | --- | --- | --- |
| A-1 | B13 完整续办（冻结 `launch.agentSpecs`） | 不批准（推迟） | 宿主对"同键不同参数、键保留时长"没验证，崩溃窗口里重建可能多建 Agent；A8 已安全关闭并告警 | 触发条件见 2.1 |
| A-2 | B2/A11 协调者回合预算 | 修改后批准 | 只计"计划请求 + 重新规划"，补报不计、不退还；旧测试按"克隆记录建无预算席位"改；三次失败则只改界面文案 | A14（失败则 A14F） |
| A-3 | B4 剩余 | 在途成员归档式取消：推迟；`run.approve`、`run.reconcile`：不批准；`run.export`：推迟 | 缺 archive 执行器和 resume-seat；kick 已含对账；无使用方 | 触发条件见 2.3 |
| A-4 | B6 剩余 | `reject`：不批准；`assign-seat`：推迟 | 台账没有区别于 `cancelled` 的终止状态；改派需要任务级席位字段 | 触发条件见 2.4 |
| A-5 | B7 派发后自动重试 | 不批准（推迟） | 宿主没有"失败发生在工具执行之前"的信号 | 触发条件见 2.5 |
| A-6 | B8 服务端推送式失效 | 不批准（关闭至 SDK 升级） | 已核实 `@getpaseo/plugin@0.13.0-beta.1` 只有请求-响应式 RPC，没有服务端推送通道 | 触发条件见 2.6 |
| A-7 | B9 默认开启、灰度、版本号、发布 | 修改后批准：发布 R1（开关仍默认关）只备材料；默认开启 R2 本阶段不批准 | 版本由 release-please 决定；合并、推送、发布不由实施会话执行 | A19；准入条件见 2.7 |
| A-8 | B10 剩余 DTO（`nextAttemptAt`、`waitingCode`） | 不批准（关闭） | 唯一的定时器是 1/2/4 秒，比 5 秒轮询还短；`waitingCode` 与原因码表重复 | 触发条件见 2.8 |
| A-9 | R3 `policy.run.failedTasks` | 修改后批准 | 做成派发闸：失败任务数超限后不再开始新派发，不暂停、不取消 | A13（失败则 A14F） |
| A-10 | 完整 B1（重查后引擎自行首次派发） | 关闭，无残余需求 | A7 的 `onRecovered → retryRun` 已满足；不需要 schema v3 | 见 2.10 |
| B-1 | 补报清理加固（`closeEndedAttempt` 清理点、unknown 先按回显确认） | 推迟 | 可达性复核自己写明"不是已复现的独立生产事故"，改动动并发模型 | 触发条件见 2.11 |
| B-2 | T5c 剩余 | 策略字段编辑入口：不批准（改文档）；`TeamEditor` 挂载与 `LaunchDialog` 渲染测试：批准 | 预算可运行时追加；devTargets 是窄众高级字段 | A17、A18 |
| B-3 | 验收表"部分"项补测 | 批准（只加测试） | 把能离线补的缺口补掉；补不了的如实留作残余 | A15、A16 |
| C | A12 DEV 真实验证 | 批准为最后的可选阶段，带硬上限 | 最多 4 个 Run、最便宜的模型、必须清理 | A12 |
| D | 版本号、CHANGELOG、合并、推送 | 实施会话不做，只备材料 | 对外动作由用户执行 | A19 |
| 额外 | 成员 Agent 回合中被关闭/归档（AC10"Agent 失联"） | 本阶段不修；写现状测试和 README 警告；A12 探针取证 | 引擎没有接线，所有出路都依赖宿主的 `turn_ended` | A16、A18、A12 |

### 0.2 任务顺序

`基线复核 → A13 → A15 → A16 → A14（失败则 A14F）→ A17（可选）→ A18 → A19 → 最终门禁与两份独立评审 → A12（可选，必须最后）`

顺序理由：先做小而价值明确的行为变化（A13），再用纯测试任务（A15、A16）把证据补厚，之后才动启动路径和重新规划这类热路径（A14），文档对账和发布材料放在代码之后，真实环境验证放在最后。

### 0.3 完工定义（一句话）

A13、A18、A19 提交，A15、A16 的测试组提交（某组三次不过可单独撤回并记录），A14 提交或已撤回并做了 A14F，最终 HEAD 门禁全绿，变异检查与回滚演练记录齐全，合同不变量未破坏（schema 版本、提示词模板、RPC 数），验收表无"未覆盖"，两份独立评审通过，发布材料已备但没有任何对外动作。A12 DEV 验证、所有被推迟的合同变更可以不做，但必须按 5.2 写明残余风险，且不得勾选计划第 9 节。

## 1. 本文依赖的代码与宿主事实（已逐条核实）

1. 协调者在 roster 里的席位 id 是 `coordinator`（`shared/domain/run-engine/dag-admission.ts:23`；`run-record.ts:188`）。DAG 接纳对它不要求预算条目（`dag-admission.ts:221-222` 跳过它）。
2. 预算只增不减：`shared/` 里唯一写 `reserved` 的地方是 `shared/domain/run-engine/budget.ts:91`，全仓库没有任何退还路径；`invariants.ts` 对 `reserved`、`budgets.entries` 没有约束；`RunBudgetEntrySchema` 是 passthrough（`shared/schemas/run-engine/ledger.ts:680-689`）。
3. A11 上次失败的旧断言恰有两处：`tests/run-engine/budget-control.test.ts:178-185` 与 `tests/run-engine/control.test.ts:2088` 附近，都用 `seatId: "coordinator"` 期望 `budget-missing`。补丁里预扣点有三处（`run-record.ts addPlanRequest`、`replan.ts requestReplan`、`plan-repair.ts requestPlanRepair`），并为避免 `budget.ts ↔ dag-admission.ts` 循环依赖新增了 `seat-ids.ts`。
4. `policy.run.failedTasks`（`ledger.ts:1297`，0–64）和 `policy.run.strategicTurns`（`ledger.ts:1298`，0–256）只出现在 schema、Team 编辑器和中文标签（`shared/zh/run-engine.ts:302-303`）里，没有任何执行代码；`metrics.strategicTurns` 初始化为 0（`run-record.ts:273`）且从不递增，客户端不展示它。
5. 现成的派发闸位置：`server/run-engine/service.ts:761-781` 的 `dispatchNextUnlocked`，容量闸 `ledger-capacity` 就在 `:775-777`；其中文映射在 `shared/zh/run-engine-waiting.ts:64`。任务状态含 `failed`（`ledger.ts:79`）。
6. B13：`start.ts:307-317` 的创建请求需要 `title`、`labels`、`systemPrompt`、`profile`（含 `modeId` 等）、`mcpServers`、幂等键；记录里只有 `launch.systemPrompts`（模板名、版本、哈希，`start.ts:244`）和 `seatProfiles`。P00 探针 V2（`docs/run-engine-iteration-plan.md` 11.2）只证明"同键同配置返回同一 Agent"，**键相同参数不同的行为、键的保留时长都没验证**。
7. B7：宿主 `turn_ended.outcome` 只有 completed / failed / canceled（11.1 矩阵），没有"是否执行过工具"的信号。
8. B8：`@getpaseo/plugin@0.13.0-beta.1` 服务端只有 `handle(contract, handler)`（请求-响应）、生命周期 hook、`settings.subscribe`（`dist/server/contracts.d.ts`）；客户端只有 `useRpc`（`dist/client/rpc-context.d.ts`）。没有服务端向页面推送或订阅的接口。
9. 成员 Agent 在回合中被关闭或归档：observer 只记 `closed`/`archived` 回执（`server/run-engine/observer.ts:102-103`），引擎没有任何反应逻辑；`stuck:` 决策、A4 取消、A5 取消完成都以宿主的 `turn_ended` 回执为前提（`shared/domain/run-engine/decision-answer.ts:297,465,627`；`cancel-request.ts:116-146`）。夹具 `closed-while-assigned` 只是 reducer 级规格，没有引擎接线，`resume-seat` 也没有实现。所以：**若宿主在关闭运行中的 Agent 时不发 `turn_ended`，该任务和 A5 的 Run 取消都会一直等待。**宿主是否发这个事件没有证据。
10. 笔记里的 `decision-answer.abandonAttempt` 已被 A4 重构为 `closeEndedAttempt`（`decision-answer.ts:522`）；`settleRepairs`（`report-repair.ts:208`）不分状态清走该 assignment 的全部补报，包括 `sending`、`outcome-unknown`。
11. 发布：`release-please-config.json`（node 类型，带组件标签），清单版本 `0.5.0`；`CHANGELOG.md` 由发布机制生成；分支无任何破坏性提交标记（`!:`、`BREAKING CHANGE` 均为 0）；A3（`a456eb0`）与 A5（`940fca6`）都是 HEAD 的祖先。开关 `PASEO_AGENT_TEAM_RUN_ENGINE` 定义在 `server/run-engine/runtime.ts:41`，README 已写使用说明。
12. 当前门禁：biome 仅 `tests/run-core/r01g-core.test.ts` 的 2 条既有警告；tsc 通过；`npm test` 194 个文件 3283 通过、3 todo；`npm run verify:package` 通过。计划第 8 节 P04 行的最新记录是第 58 点，**下一条是第 59 点**。

## 2. 裁决

### 2.1 清单 A-1｜B13 完整续办：不批准（推迟）

- **理由**：(1) 续办要用同一个幂等键、同样的参数重新创建缺的成员，这依赖宿主在崩溃/重启之后仍认这个键；V2 只验证了一次会话内的行为，键保留时长和"键同参数异"都没验证——如果键只活在 daemon 内存里，而崩溃恰是 daemon 重启，续办会多建 Agent，比 A8 的"关闭并告警"更糟。(2) 收益小：DEV 上的启动失败都是创建报错，已由 `fail()` 处理；真正的崩溃窗口以秒计；A8 已经关闭 Run、列出已登记的 Agent 并提示可能有一个未登记的。(3) 成本不小：新透传块、每个席位几 KB 的提示词（或重建输入加哈希对账）、启动关键路径上新增恢复分支。
- **风险（不做）**：崩溃窗口里已创建但未登记的那个 Agent 只能靠告警提示人工查找，需要重新启动 Run。README 已如实写明。
- **重新评估的触发条件（需同时满足）**：(a) A12 的探针 V2′ 通过——同键在 DEV daemon 重启后仍返回同一 Agent，且同键不同参数时有明确行为；(b) 出现过一次真实的"启动中断"告警（不是测试里的），或有明确的使用需求。
- **触发后的最小形状（备忘，不属于本阶段）**：`launch.agentSpecs`，带独立读取器的透传块（写法照 `shared/domain/run-engine/read-retry.ts`），形如 `{ version: 1, seats: { [seatId]: { parentSeatId: string | null, title, labels, systemPrompt（≤16 KiB）, systemPromptSha256, profile: { id, provider, model, modeId, thinkingOptionId, featureValues }, mcpServers } } }`，在 `startEngineRun` 的 `store.create(record)` 同一次提交里写入；`server/run-engine/start.ts` 导出 `resumeInterruptedLaunch`，`driver.recover` 在 `launch.state === "creating"` 时调用；哈希对不上就记 `failed` 并告警（fail-closed）。不升 schema 版本。

### 2.2 清单 A-2｜B2/A11 协调者回合预算：修改后批准（任务 A14）

**为什么仍要做**：Team 编辑器里"协调者回合数上限（每个 Run）"可编辑、默认 12，却没有任何代码执行（事实 4），界面在做一个不兑现的承诺；协调者的模型调用里，唯一可被人反复触发而不计数的是 `replan`。做它的价值是"诚实的上限 + 可见的记账"，不是止血（计划请求最多一次加有界补报，今天并不会失控）。

**怎样避开上次三次失败**：

| 上次失败原因 | 本次做法 |
| --- | --- |
| 旧测试 `budget-control.test.ts:178-185`、`control.test.ts:2088` 要求协调者返回 `budget-missing` | 这是合同变化，两处断言**在同一提交里**随之改。需要"没有预算的席位"时，不再借用协调者：纯函数测试里克隆记录，把某个非协调者席位的条目从 `budgets.entries` **和** `policy.seatBudgets` 两处都删掉；集成测试在 DAG 接纳之后、于 `store.update` 里删，断言完再放回（或临时往 roster 加一个没有预算的启用席位 `seat-zz-nobudget`，二选一，取不破坏不变式的那个） |
| 夹具 `seat-s1` 本来就有预算；Run 开始前移除它使原 DAG 夹具无法运行 | **不改共享夹具**，不在 Run 开始前动 `seat-s1` |
| 旧 Run 懒建预算只能计入仍在 outbox 的消息 | 懒建时 `reserved` = outbox 里发给协调者的计划请求（`isPlanRequest`）个数，**不分状态**（outbox 不被压缩，新旧 Run 口径一致）；文档写明这是下界 |
| 已预扣但被 replan 作废的消息是否退还 | **不退还**：全仓库的预算都不退还（事实 2），座位预算同口径；被拒的 replan 不预扣；多扣的出路是 `run.budget` 追加 |

**对上次补丁的缩小**：计划补报（`requestPlanRepair`）**不计入、也不因预算被拒**——它有 `protocolResends` 的次数上限，和成员报告补报同口径。这样不碰 `plan-repair.ts`、`dag.ts`，也避免了"补报被拒后 Run 卡在 `awaiting-dag`"的新问题。计入的只有：启动时的计划请求（1 次）与每次重新规划（1 次）。

**最小形状**（文件、字段、事件、RPC、zod）：

- 新增 `shared/domain/run-engine/coordinator-budget.ts`（纯函数）：`ensureCoordinatorBudget(record): RunRecord`（`budgets.entries` 里没有 `{scope:"seat", subjectId:"coordinator"}` 时克隆并追加 `{scope:"seat", subjectId:"coordinator", limit: policy.run.strategicTurns, reserved: <上面的下界>, confirmed: 0, observedTurns: 0}`，已有则原样返回同一对象）；`reserveCoordinatorTurn(record, intentKey, messageId): {status:"reserved", next} | {status:"already-counted"} | {status:"exhausted"}`（内部用现有 `predebit`）。**放在新模块里**，从 `dag-admission.ts` 导入 `COORDINATOR_SEAT_ID`，`budget.ts` 不依赖它，避免循环；不需要上次的 `seat-ids.ts`。
- 预扣点（与意图同一次提交，键用各自的幂等键）：`run-record.ts addPlanRequest`（键 `plan:<runId>:1`，耗尽则抛错，新 Run 因预检不会走到）；`replan.ts requestReplan`（键 `plan:<runId>:<epoch>`；`already-counted` 按现有重复规则处理；`exhausted` 返回 `{ ok: false, code: "budget-exhausted" }`，记录不变）。
- `shared/schemas/run-engine/rpc-actions.ts`：`RUN_ACTION_CODES` 加 `"budget-exhausted"`，中文进 `shared/zh/run-engine.ts`（"协调者回合预算已用完，请先在预算区域追加回合数，再重新规划"）。**无新 RPC**（`agent-team.run.budget` 的 `seatId` 本来就是任意字符串，在 `server/run-engine/control.ts` 的 `budget()` 里对 `coordinator` 先 `ensureCoordinatorBudget` 再交给 `increaseSeatBudget`）；**无新事件类型**（复用 `budget-increased`）；**无 ledger schema 改动**（只是 `budgets.entries` 数组的新条目）；**无提示词模板改动**。
- `server/run-engine/control.ts` 的 `replan()`：`budget-exhausted` 时在同一次提交里写 A6 同款 warning 告警（文本用 `budgetExhaustedAlert`，席位写"协调者"，前缀函数对 `coordinator` 给出"协调者的回合预算已用完"）；`increaseSeatBudget` 现有的"置 resolved"逻辑负责撤下它。
- `server/run-engine/start.ts` 预检与 `shared/domain/run-engine/team-config.ts` 的 `engineLaunchGate`：`policy.run.strategicTurns < 1` 时阻断，文案"协调者回合预算为 0，无法发出计划请求；请先增加预算"（编辑器和启动预览实时显示；`shared/zh/run-engine.ts` 的 `coordinatorBudgetEmpty`）。
- 客户端：预算列表本来按 `budgets` 行画"追加预算"，协调者行自然出现，不需要新代码；只确认文案和 `controls` 穷举测试通过。

**风险**：`strategicTurns` 为 0 的 Team 以后被启动门阻断（预览显示原因）；热路径（启动、重新规划）有改动，所以排在测试任务之后。回滚到 A14 之前的版本：账本里多出的 `coordinator` 预算条目对旧程序合法（passthrough、无约束），旧程序对它视而不见。
**放弃条件**：三次尝试仍过不了，撤回并做 A14F（只改文案，见任务 A14F）。

### 2.3 清单 A-3｜B4 剩余

- **在途成员的归档式取消：推迟。**取消在途任务在本代码库里就是归档该成员的 Agent（reducer 的静止证明 `isComplete167` 要求 `archive` 意图及确认）；`effects.ts` 没有 archive 执行器，`resume-seat` 没有实现，归档后该席位在这个 Run 里不能再用；宿主没有"停止"（打断=新回合=一次模型调用，V4）。整个 Run 的取消（A5）和冻结任务的取消（A4）已覆盖实际需求。**触发**：用户明确需要"不等回合结束就取消单个在途任务"且接受该成员在 Run 内不可再用，或 `resume-seat` 已实现。
- **`run.approve`：不批准（关闭）。**没有任何流程产生审批，`approvals` 没有写入者。`tests/run-engine/rpc-actions.test.ts` 继续断言它没有注册。
- **`run.reconcile`：不批准（关闭）。**`kick` 已包含对账，没有使用方。
- **`run.export`：推迟。**没有使用方；调试时直接读 `<PASEO_HOME>/agent-team-runs/v1/runs/<runId>.json`。**触发**：出现明确的诊断导出需求；到时必须只读且脱敏（不含 nonce、提示词、outbox 参数）。

### 2.4 清单 A-4｜B6 剩余

- **`reject`：不批准（关闭）。**台账没有区别于 `cancelled` 的终止状态，被拒的任务最后还得取消 Run 才能结束；`cancel` 已能表达。
- **`assign-seat`：推迟。**reducer 把它当作取消授权（"取消后改派"），要加任务级的"指定席位"字段和派发规则，属台账字段变更。**触发**：成员席位失联（2.12）有了可验证的宿主信号，或出现"席位不可用导致任务永久卡住"的真实案例。

### 2.5 清单 A-5｜B7 派发之后的临时失败自动重试：不批准（推迟）

- **理由**：宿主给的失败结果没有"是否执行过工具"的信号（事实 7）。Engine 读的 canonical timeline 条目带 `type`（`shared/paseo/port.ts:78-83`），原则上可以数 `tool_call` 条目，但宿主没有保证"没有该条目 = 没执行过任何工具"（流式、折叠都可能漏），也没有任何失败回合的样本；它是 A12 要取的证据，不是现在可用的信号。自动重跑可能重复提交、重复改文件。现状有人工 `retry`（决策点）。
- **风险（不做）**：瞬时的供应商错误（限流、过载）需要人点重试；README 已写"不会自动重试"。
- **触发**：(a) 宿主在 `turn_ended` 的失败结果里给出失败阶段或"是否执行过工具"的字段；或 (b) A12 在两种 Provider 上取得失败回合的 timeline 样本，证明能可靠区分，并在下一轮批准。

### 2.6 清单 A-6｜B8 服务端推送式失效：不批准（关闭至 SDK 升级）

- **理由**：事实 8。轮询（详情 5 秒、列表 10 秒、页面不可见时停）加 `unchanged` 已让空闲读取很小，没有替代手段。
- **触发**：`@getpaseo/plugin` 升级后，`dist/server/*.d.ts` 或 `dist/client/*.d.ts` 出现服务端向页面推送或订阅的接口。检查方法：在新 SDK 里搜 `subscribe`、`emit`、`publish`、`stream`。

### 2.7 清单 A-7｜B9 默认开启、灰度、版本号与发布：修改后批准

- **R1（批准准备，开关仍默认关）**：整个分支作为一次发布，版本由 release-please 按提交决定（`feat` 提交 → 预期 0.6.0，分支无破坏性标记）。**不手改** `package.json`、`.release-please-manifest.json`、`paseo-plugin.json` 的版本，**不手改** `CHANGELOG.md`。**A3 与 A5 同一版本发布**靠"整分支合并、不 cherry-pick、不分批"满足；合并前用 `git merge-base --is-ancestor a456eb0 HEAD` 与 `git merge-base --is-ancestor 940fca6 HEAD` 核对。合并方式建议 merge commit（非 squash），让 15 条 feat、6 条 fix 进入 CHANGELOG；若选 squash，标题必须以 `feat(run-engine):` 开头。
- **R2（默认开启）本阶段不批准实施。**理由：22 项验收里一半以上仍是"部分"，真实模型、真实浏览器、重启后 kick、S1 重查在真实宿主上都一次没跑过；默认开启会把未经真实验证的界面和提示词暴露给所有人，回滚又有"旧版本读 v2 账本会阻断所有 Run 的新资源授予"的代价。**准入条件（全部满足，由用户或之后的批准会话判断，不由实施会话判断）**：(1) R1 已发布，用户自己的真实使用中至少 3 个 Engine Run 跑到 `finished` 或取消完成，期间无 `ledger-refused`、无不变式失败；(2) A12 已完成，两种 Provider 的 6 项验证有记录；(3) 验收表无"未覆盖"，所有"需 DEV"项都有 DEV 记录；(4) 真实浏览器的宽屏/窄屏/断线重连检查有记录；(5) 发布说明写明三条回滚注意；(6) 用户逐条勾选计划第 9 节。**到时的形状**：`server/run-engine/runtime.ts:97` 的 `const supported = env[RUN_ENGINE_ENV] === "1"` 改为"未设置 = 开启，`0`/`false` = 关闭"（同时改第 40 行"never by default"的注释、`tests/run-engine/runtime.test.ts` 里 "is supported only when the daemon sets …=1" 一例、`index.server.ts:179` 的注释与 README 第一步）；Team 的 `runEngine` 块仍然只在编辑器里点开关才写入；预设里放关闭状态的样例另议。
- **三条回滚注意（写进发布说明）**：(a) 回滚到不认识 v2 的版本，会因看不到 v2 Run 的占用而拒绝所有 Run 的新写占用授予（不限仓库），Engine Run 活动时不要回滚；(b) 回滚到 A3 与 A5 之间的版本，已请求取消的 Run 可被续办；(c) 被压缩的历史不可恢复。v1 活动 Run 不迁移。
- **对外动作**：合并、推送、打标签、发布、改版本号、改 CHANGELOG，**一律不由实施会话执行**，A19 只备材料。

### 2.8 清单 A-8｜B10 剩余 DTO 字段：不批准（关闭）

`nextAttemptAt`：唯一的定时器间隔是 1、2、4 秒（`read-retry`），比 5 秒轮询还短，页面不会看到有意义的值。`waitingCode`：与 `shared/zh/run-engine-waiting.ts` 的原因码表重复，且输出 DTO 加字段要承担旧客户端兼容成本。**触发**：出现 60 秒以上的截止条件（例如将来批准了 B7 的退避）。A10 的 `kind` 已够用。

### 2.9 清单 A-9｜R3 `policy.run.failedTasks`：修改后批准（任务 A13）

- **语义（本文决定）**：失败 = 任务状态当前为 `failed`（不含 `cancelled`、`blocked`，也不含曾失败后被重试的）；超限 = `failed 的个数 > policy.run.failedTasks`（取台账里冻结的值，不读 Team 配置）。超限时做什么 = **不再开始任何新的派发**（含审查、冒烟、补证请求），不暂停 Run、不取消任何东西；在途回合照常结束，报告、补报、按回显确认照常。出路 = 在决策点重试或取消失败的任务，让个数回到上限以内（A4 的决策已有这两个动作）。
- **为什么不用 `run-paused`**：续办会立即再次触发，要靠额外的"已确认"状态才能脱身，那是台账字段变更；派发闸不需要新状态，状态全从任务算出，天然可恢复。
- **形状**：无 schema、无事件、无 RPC 变更；新增一个派发拒绝原因字符串 `failed-task-limit`（和 `ledger-capacity` 同一层，写在 `service.ts`）、一条固定文本的 critical 告警。细节见任务 A13。
- **风险**：只在 `failed` 多于上限时才改变行为（默认上限 3），方向是少派发；一个人手动重试一个失败任务而总数仍超限时，重试出来的派发也会被闸住，页面原因码会说明，需要继续处理其余失败任务。放弃条件：三次失败则撤回并做 A14F。

### 2.10 清单 A-10｜完整 B1：关闭，无残余需求

A7 在"记录读取结果的提交成功之后"调用 `onRecovered → driver.retryRun(runId, { afterWrite: true })`，重启后 `driver.recover` 对每个活 Run 先 `settleWaiting` 再 `kick`（`server/run-engine/driver.ts:378-396`），所以"读取恢复后由引擎自己入账并首次派发"已经成立，走的是已有的入账、outbox、派发路径。不需要 schema v3、新状态或 `sendIntent`。**残余（接受）**：同一来源只自动继续前 3 次，之后靠告警提示人 kick；协调者计划回复的读取失败没有 assignment 可登记，不在重查范围；永久性不完整（宿主丢了历史）用尽 3 次后告警。这三条已写在 README 与计划第 50 点。

### 2.11 清单 B-1｜补报清理加固：推迟

- 可达性复核（`reachability.md` 4.2、4.5）的建议是：`settleRepairs`（`report-repair.ts:208`）不分状态清走补报，应改为"`sending`/`outcome-unknown` 的先按回显确认，证明不了就不接受放锁的转换"，并覆盖 `closeEndedAttempt`（`decision-answer.ts:522`，笔记里旧名 `abandonAttempt`）这个第二个调用点。
- **推迟理由**：复核自己写明"不是已复现的独立生产事故"；正常的单次补报里，被清理的补报恰是结束这次回合的那条，清理是对的；加固要在 `settleRepairs` 之前做宿主读取，动的是入账与决策答复两条热路径的并发模型；证明不了时"整次报告不接受"可能让任务永久等待，反而制造新的卡死。
- **风险（不做）**：多次补报且旧补报送达不明时，可能把仍在途的补报当作已结清。概率低，且 A5 的取消完成、A4 的取消都会等 `outcome-unknown` 结清。
- **触发**：出现一例真实复现（报告被接纳或尝试被关闭时仍有未结清的 `outcome-unknown` 补报，且随后占用被放出）；或 A12 的 DEV 观察到。

### 2.12 额外发现｜成员 Agent 在回合中被关闭或归档（AC10"Agent 失联"）：本阶段不修

- 事实 9：引擎对 `closed`/`archived` 回执没有反应，所有出路都以宿主的 `turn_ended` 为前提。用户在 Paseo 里归档一个正在干活的成员是现实操作。
- **裁决**：不在本阶段修，因为正确的修法要么接上 `reopen`/`resume-seat`（未实现的整块功能），要么在没有宿主证据的情况下把"已关闭"当作静止证明（违反"不确定就冻结"）。本阶段做三件不改合同的事：(1) A16 写一个**现状测试**（名字写明 characterization / known limitation），把"任务保持 assigned、占用保留、该席位不再被选、取消 Run 一直等且 `waiting.turns >= 1`、宿主零 send/archive"固定下来；(2) A18 在 README 加一句警告："Run 进行中不要关闭或归档成员，目前引擎不能恢复这种任务"；(3) A12 加一个探针：归档一个正在回合中的成员，记录宿主发出哪些 hook（尤其有没有 `turn_ended`）。
- **触发**：探针显示宿主在关闭时不发 `turn_ended`，或用户遇到。到时的方向：在 `closed`/`archived` 回执且没有后续 `turn_started` 时打开一个只允许 `cancel` 的 D1 决策（`evidence-stuck:` 同款思路），并让 A5 的完成判断接受"已关闭"为静止证据——这两点都要新批准，不在本阶段。

### 2.13 清单 B-2｜T5c 剩余

- **策略字段（预算、devTargets、evidenceRoot）编辑入口：不批准。**预算可以在 Run 里用 `agent-team.run.budget` 追加；`evidenceRoot` 的 `auto` 对几乎所有人正确；`devTargets`（`{serverId, host, home}`）只对需要 DEV 冒烟的任务有意义，是窄众高级字段，做 UI 的出错成本高于收益。改为在 README 增加"高级字段"一段，说明它们在 Team 的 `runEngine` JSON 里怎么写、编辑器保存时不会丢（已有往返测试）——**目前 README 完全没有提到 devTargets**，这是本项的实际缺口。
- **`TeamEditor` 挂载测试与 `LaunchDialog` 渲染测试：批准（任务 A17，可选）。**`TeamEditor` 引入 `useRpc`、`useSettings` 和 `react-native` 的 `Modal`，直接挂载要 mock 的东西多；做法是把 `RunEngineEditor` 与 `seatProfileFactsFromPlan` 的接线抽成一个可单独挂载的容器组件，`TeamEditor` 只渲染它，行为不变。其他测试已有 `vi.mock("react-native")`、`vi.mock("@getpaseo/plugin/client/react-native")` 加 `react-test-renderer` 的写法可沿用。

### 2.14 清单 B-3｜验收表"部分"项补测：批准（任务 A15、A16）

只加测试，不改合同。哪些能离线补、哪些只能留作残余，见 5.3 的目标状态表。测试暴露缺陷时：修复不改合同就在同一任务里修并加变异检查；要改合同就记进"待批准（第二轮）"，把测试改成断言当前行为并在名字里写 `known limitation`，保持门禁绿。

### 2.15 清单 C｜A12 DEV 真实验证：批准为最后的可选阶段（带硬上限）

用户在 `docs/remaining-work-plan.md` 第 5 节已为 DEV 验证预先划定了边界（最多 4 个 Run、只用 `.paseo-dev`、不复制真实 Profile 或凭据），本文在这个边界内批准，并加上：最便宜的模型（探针用过的 `claude-haiku-5-5` 与 `codex/gpt-6-luna`）、墙钟上限 3 小时、做不下去就跳过。A12 不改源码；发现的缺陷只记录，修复另走任务且最多两轮。详见任务 A12。

### 2.16 清单 D｜发布：实施会话不做对外动作

见 2.7。A19 只产出 `docs/release-handoff.md`。

## 3. 任务与顺序

### 3.0 总览

| 任务 | 内容 | 类型 | 依赖 | 规模 | 默认负责人 | 主要验收项 |
| --- | --- | --- | --- | --- | --- | --- |
| 基线复核 | 在 HEAD 跑四项门禁并记数字 | 检查 | — | 小 | Sonnet | — |
| A13 | 失败任务上限闸（R3） | 行为 | — | 中 | Sonnet | AC13、AC17、AC22 |
| A15 | 验收缺口补测 I（断言升级类） | 纯测试 | — | 中 | Sonnet 或 DeepSeek | AC02、03、06、07、11、19 |
| A16 | 验收缺口补测 II（引擎级场景） | 纯测试 | — | 大 | Sonnet | AC01、09、10、14、16、17、20 |
| A14 | 协调者回合预算（修正版 A11） | 行为 | A6（已完成） | 大 | Sonnet | AC13、17、18 |
| A14F | 文案回退（仅在 A13 或 A14 撤回时） | 文案 | 触发条件 | 小 | Sonnet | AC13 |
| A17 | UI 接线与渲染测试 | 重构加测试 | — | 中 | Sonnet 或 DeepSeek | AC16、AC22 |
| A18 | 文档对账 | 文档 | A13–A17 | 小 | Sonnet 或 DeepSeek | 全部 |
| A19 | 发布材料 | 文档 | A18 | 小 | Sonnet 或 DeepSeek | AC16 |
| A12 | DEV 真实验证（可选） | 验证 | A13–A19 | 大 | Sonnet | AC12、14、15、22 等 |

**会话划分（每个阶段新开会话，协调者不轮询）**：阶段 1 = 基线复核、A13、A15；阶段 2 = A16、A14（或 A14F）；阶段 3 = A17、A18、A19、最终门禁与两份评审；阶段 4（可选）= A12。每个任务都是可独立提交的两个提交（代码+测试一个，文档一个）。

**每个任务共同遵守**：第 4 节的通用规则；不升 schema 版本（`RUN_SCHEMA_VERSION` 保持 2，`RUN_SUPPORTED_SCHEMA_VERSIONS` 保持 `[1, 2]`）；v1 活动 Run 不迁移；每条新的写路径在 v1 与 v2 记录上各跑一遍，断言 `schemaVersion` 不变、本次没碰的字段逐字节不变（照 `tests/run-engine/ledger-versions.test.ts`）；新的原因码和告警文本都有中文，`tests/run-view/waiting.test.ts`、`controls.test.ts` 的穷举不得削弱；不改提示词模板；RPC 总数保持 28（`tests/server-entry.test.ts`）。

### 任务 A13｜失败任务上限闸（清单 A-9）

- **目标**：让"允许失败的任务数"真正生效：失败的任务多于上限后不再开始新的派发。
- **依赖**：无。
- **改动文件**：
  - 新增 `shared/domain/run-engine/failure-limit.ts`（纯函数，不引入 Node 模块）：`failedTaskLimit(record): { failed: number; limit: number; exceeded: boolean }`，`failed` 只数 `task.status === "failed"`，`limit = record.policy.run.failedTasks`，`exceeded = failed > limit`；导出告警前缀 `FAILED_LIMIT_ALERT_PREFIX = "失败的任务已超过策略允许的"` 和 `failedLimitAlert(failed, limit)`（固定文本：`失败的任务已超过策略允许的 ${limit} 个（现有 ${failed} 个），已停止新的派发；进行中的工作会继续收尾。请在决策点重试或取消失败的任务。`）。
  - `server/run-engine/service.ts`：`dispatchNextUnlocked` 在容量闸之后、按 `work.kind` 分派之前，`exceeded` 且 `work` 非空时返回 `{ status: "blocked", taskId: work.task.spec.id, reason: "failed-task-limit" }`，并调用新的 `noteFailedLimit(runId, …)`：一次 `store.update` 里 `raiseAlert`（critical、固定文本、`alertIdFor` 去重，照 `noteCapacity` 写法）。不超限时，**仅当台账里存在以该前缀开头且未解除的告警**才写一次 `resolveAlerts`（空闲 Run 不写，保 AC17）。入账、报告格式补报、补证链里的补报、按回显确认不受影响。
  - `shared/zh/run-engine-waiting.ts`：`"failed-task-limit"` 的 `why`/`who`/`next`（照 `"ledger-capacity"` 写：why"失败的任务数超过了这个 Run 的策略上限，停止了新的派发"，who 为 YOU，next"在决策点重试或取消失败的任务，使失败数回到上限以内；进行中的工作会继续收尾"）。若 `waiting.test.ts` 的穷举不覆盖服务层原因，补一条：服务层产生的所有 `reason:` 字面量都在映射表里。
  - `README.md`：Run Engine 一节一句话写明语义与出路。
- **测试清单**（`tests/run-engine/failure-limit.test.ts` 纯函数；`tests/run-engine/failure-limit-driver.test.ts` 真实 store + driver + 假宿主）：
  1. 纯：`cancelled`、`blocked`、`done` 不计；恰好等于上限不超限，多一个超限；上限 0 时第一个失败即超限；读冻结的 `policy` 而不是别处。
  2. 端到端：上限 3、3 个失败任务 + 1 个独立就绪任务 → 仍派发；第 4 个失败 → `dispatch-blocked:failed-task-limit`，恰好一条 critical 告警，**连续 5 遍 pass 与 kick 修订号不再变化**，宿主零发送。
  3. 超限期间在途报告照常入账、补报照常发出。
  4. 人用 A4 的 `retry` 把一个失败任务拉回、总数不超限 → 下一遍派发，告警 `resolved`（只写一次）；用 `cancel` 取消一个失败任务同样。
  5. 总数仍超限时重试出来的派发也被闸住，原因码正确。
  6. `paused`、`awaiting-dag` 的 Run 不受影响（`dispatchNextUnlocked` 本来就只处理 `active`）。
  7. v1 与 v2 记录各一遍；`policy` 前后逐字节相同。
  8. 中文穷举与 README 事实测试（`readme-facts.test.ts`）通过。
- **变异检查（必做）**：闸整个去掉；`>` 改 `>=`；把 `cancelled` 也计入；把 `failed` 排除出计数；每一遍都写告警；超限时把入账或补报也挡住；读 `strategicTurns` 而不是 `failedTasks`；回落后不撤告警；不超限时每遍都写（空闲写入）。
- **对验收项的影响**：AC13（失败预算的"不继续消耗"）、AC17（超限空闲不写）、AC22（原因可见）；在验收表缺口栏记一句。
- **版本与回滚**：不升 schema；`RUN_SCHEMA_VERSION` 不变；无新字段，回滚到 A13 之前的版本只是闸消失，台账完全兼容。放弃条件：三次尝试不过 → 撤回 → A14F。

### 任务 A15｜验收缺口补测 I（只加测试）

- **目标**：把验收表里"只差一个断言"的缺口补上。
- **依赖**：无。**不改生产代码**（若暴露缺陷，按 2.14 处理）。下面编号 1–6 的测试组彼此独立：某一组三次尝试不过，只撤回该组，其余照常提交，被撤回组对应的验收缺口原样保留并写进残余风险。
- **测试清单**（文件按现有用例所在位置；写之前先 grep 确认没有重复）：
  1. **AC02**：`tests/run-core/gates.test.ts` 里 "stale D and source-bound self reviewer cannot pass"、"registered DEV passes, default target fails" 两例，把只断言 `ok:false` 升级为断言具体原因码（取 `gates.ts` 实际返回的字段与值，码名写进断言）；补"旧 `reviewedRef`"一例。
  2. **AC03**：`tests/run-engine/driver.test.ts` 新例——同一份报告的 `turn_ended` hook 重放 3 次并 kick 2 次后，`assignments.length`、`budgets.entries[*].reserved`、`outbox.length`、`revision` 与第一次入账之后相同，宿主 `sent` 条数不变。
  3. **AC06**：`tests/run-engine/start.test.ts`——(a) 假适配器"先创建、记在幂等键下、再抛错"：第二次同键返回同一 id，创建的 Agent 数等于席位数；(b) 启动失败且偏好为归档时，只归档本次 `created` 的 id，宿主里另一个无关 Agent 不被归档。
  4. **AC07**：`tests/run-engine/driver.test.ts` 或 `report-repair.test.ts`——报告被拒 → 补报 → 再被拒 → 补报用尽，全程 `qualityFailures`、`reworkCount`（以台账实际字段名为准）不变，`protocolFailures` 增加，任务的最近一份回复与提交保留。
  5. **AC11**：`tests/run-engine/observer.test.ts`/`driver.test.ts`——(a) 报告与 `turn_ended` 已由对账入账后，迟到的同一 `agent.turn_ended` hook：`eventReceipts`、`counters`、`assignments` 全不变；(b) hook 先于席位绑定到达，绑定后恰好交付一次。
  6. **AC19**：`tests/run-engine/queries.test.ts`——活 Run（有 `prepared` 的 outbox、假宿主）上依次调用列表、详情、历史查询，`host.sent` 与任何写调用为空，记录字节不变。
- **变异检查**：每个测试组至少 2 项（破坏被测行为，确认对应用例变红，还原后 `cmp`）。例：让 `gates` 的原因码改名；让重复 hook 增加一条回执；让归档覆盖宿主里所有 Agent；让协议失败增加 `qualityFailures`；让查询路径调用 `send`。
- **对验收项的影响**：AC02、03、06、07、11、19 的缺口栏逐句核对，整句被证据关闭才升级状态（见 5.3）。
- **版本与回滚**：纯测试，无版本影响，回滚 = 撤销提交。

### 任务 A16｜验收缺口补测 II（引擎级场景，只加测试）

- **目标**：补需要真实 store 与 driver 的场景用例，并把已知限制固定成现状测试。
- **依赖**：无（建议在 A15 之后，复用其夹具写法）。下面编号 1–7 的测试组彼此独立，撤回规则同 A15（按组撤回）。
- **测试清单**：
  1. **AC01**：`tests/run-engine/driver.test.ts`（真实 git）——T1 声明冒烟（登记的 DEV 目标）、T2 依赖 T1：T1 实现 → 审查通过 → 冒烟者 → 通过之前 T2 一直 `pending`，通过后才派发；冒烟失败时 T2 保持 `pending`、T1 走返工路径。
  2. **AC09**：双 Run 同一 store——Run A 的写占用 `src\Util.ts`，Run B 请求 `SRC/util.ts`（大小写与分隔符别名）→ B 被挡且原因码正确；A 的任务完成放占用后，B 在下一遍派发。
  3. **AC10**：(a) 同 Run 内冻结占用挡住冲突任务的派发；(b) 跨 Run：A 的任务因 `outcome-unknown` 或 `blocked` 冻结占用，B 被挡；A 的冻结任务经 A4 取消后 B 派发（A4 笔记里记着这个用例当时没写）；(c) **"Agent 失联"现状测试**（2.12）：成员回合进行中只收到 `closed` 回执、没有 `turn_ended`——任务保持 `assigned`、占用保留、该席位不再被选、Run 取消一直等（`waiting.turns >= 1`）、宿主零 `send`/`archive`；测试名写明 `known limitation`。
  4. **AC14**：store 级——暂停扣住的从未发出的派发，A5 取消完成后 `localCancellation.cause === "run-cancelled"`、占用移除、宿主零 `send`。**先 grep `cancel.test`/`control.test` 看是否已有**，已有则只补验收表引用。
  5. **AC16**：(a) 开关关闭时，既有 Engine Run 与协调者链路旧 Run 同时出现在 Runs 列表的视图模型里；(b) Run 启动后 Team 的 `runEngine` 块被改坏或删除：既有 Run 仍可读、可 kick、可控制（以台账里冻结的策略为准）。
  6. **AC17**：`vi.useFakeTimers` 长跑——空闲 Run 前进 24 小时，宿主读取与写入调用数为零，无定时器残留。
  7. **AC20**：现状测试——对有 assignment 的席位发用户消息，不被当作交付、不改任务状态、不报警（名字写明 `known limitation`，AC20 的"记录异常"不做，理由：人直接和成员对话是正当用法，没有批准的异常语义）。
- **变异检查**：每个测试组至少 2 项（例：别名归一化去掉大小写；冻结占用不挡同 Run 冲突任务；取消完成时多一次 `send`；冒烟未过也放 T2；空闲 pass 写一次告警）。
- **对验收项的影响**：AC01、AC09、AC16 可升级；AC10、AC14、AC17、AC20 缺口收窄，仍为"部分"。
- **版本与回滚**：纯测试。

### 任务 A14｜协调者回合预算（修正版 A11，清单 A-2）

- **目标**：让"协调者回合数上限"真正计数并在重新规划时生效，协调者行可在预算区追加。
- **依赖**：A6（已完成）；排在 A16 之后。
- **改动文件**（形状见 2.2）：新增 `shared/domain/run-engine/coordinator-budget.ts`；改 `shared/domain/run-engine/run-record.ts`（`addPlanRequest`）、`replan.ts`（`requestReplan`）；`server/run-engine/control.ts`（`replan()` 的耗尽告警；`budget()` 对 `coordinator` 先 `ensureCoordinatorBudget`）；`server/run-engine/start.ts`（预检）；`shared/domain/run-engine/team-config.ts`（`engineLaunchGate` 阻断）；`shared/schemas/run-engine/rpc-actions.ts`（`budget-exhausted` 码）；`shared/zh/run-engine.ts`；`README.md`（写明"计入计划请求与重新规划，不计计划补报，不退还；耗尽后追加预算"）。**不碰** `plan-repair.ts`、`dag.ts`、`dag-admission.ts`、`budget.ts`（除非循环依赖迫使最小改动）、共享夹具 `tests/fixtures/run-engine/base.ts`。
- **测试清单**：
  1. 纯（`tests/run-engine/coordinator-budget.test.ts`，v1 与 v2 各一遍）：新 Run 经 `addPlanRequest` 后有 `{scope:"seat", subjectId:"coordinator", limit: policy.run.strategicTurns, reserved: 1, confirmed: 0, observedTurns: 0}`；`policy` 逐字节不变、`schemaVersion` 不变；`requestReplan` 预扣 1，同 `requestId` 重放 `replayed` 且 `reserved` 不再增；耗尽返回 `budget-exhausted` 且记录深相等不变；无条目的旧记录懒建时 `reserved` = 计划请求个数（含 `failed` 状态的），再调一次返回同一对象；`requestPlanRepair` 不改 `reserved`。
  2. 集成（`control.test.ts` replan 组，参考 `C:\Users\cc\AppData\Local\Temp\aw\a11-attempt.patch` 里的集成测试与 `a11-coordinator-budget.test.ts`，只参考不拷贝补丁）：额度 1 → replan 被拒、恰好一条 open 告警、宿主零发送；`run.budget` 对 `coordinator` 追加 → 告警 `resolved`；再 replan 成功，协调者恰好收到一条。
  3. `start.test.ts`：启动后协调者条目 `reserved: 1`；`strategicTurns: 0` 在预检被拒，零 Agent、零发送、零 Run 记录。
  4. `team-config.test.ts`/`team-config-edit.test.ts`：`strategicTurns < 1` 时阻断，编辑器实时显示。
  5. 两处旧断言**随合同变化修改**（见 2.2 的表）；其余测试不得因本任务被削弱或删除。
  6. `waiting.test.ts`/`controls.test.ts` 穷举、`server-entry*.test.ts` 仍 28 个 RPC。
  7. **回滚演练（手工，结果写进记录）**：用 `git show f1f1e48:paseo-agent-team/shared/schemas/run-engine/ledger.ts` 与 `.../invariants.ts`（及它们的导入）取到仓库外临时目录，读一份带协调者条目的记录：解析通过、不变式通过；临时目录用完删除（有 junction 先摘）。
- **变异检查（必做）**：启动不预扣；replan 不预扣；重放重复扣；懒建 `reserved` 记 0；耗尽不拒绝；`run.budget` 不允许 `coordinator`；去掉启动门；计划补报被计入（应被"补报不改 `reserved`"抓到）；耗尽时每次都写告警；追加预算改了 `policy`。
- **对验收项的影响**：AC13（协调者也有上限和出路）、AC17/AC18（协调者调用有记账）。
- **版本与回滚**：不升 schema；`budgets.entries` 数组的新条目对旧程序合法；回滚后协调者行消失。**放弃条件**：三次尝试不过 → 撤回（按 4.4）→ 做 A14F。

### 任务 A14F｜文案回退（仅在 A13 或 A14 被撤回时做）

- **目标**：未兑现的策略字段不再向用户做承诺。
- **改动**：`shared/zh/run-engine.ts:302-303` 对应被撤回的字段标签后加"（目前只记录，尚未执行）"；同步引用标签的测试；README 一句话；验收表 AC13 缺口栏写明。只改文案。
- **测试/变异**：标签穷举测试通过；变异 1 项（还原旧标签应使对应断言变红）。**版本与回滚**：无。

### 任务 A17｜UI 接线与渲染测试（可选，清单 B-2）

- **目标**：把"只有源码扫描保护"的接线变成真正挂载的测试。
- **依赖**：无（建议在 A14 之后，以便覆盖启动门文案）。
- **改动**：把 `client/teams/TeamEditor.tsx` 里 `RunEngineEditor` 加 `seatProfileFactsFromPlan` 的接线抽成容器组件（如 `client/teams/RunEngineSection.tsx`，props：`team`、规划出的成员行、行键映射、`onChange`），`TeamEditor` 只渲染它，**行为不变**；保留原有的源码扫描测试。新增测试沿用 `tests/run-view/run-engine-editor.test.ts` 的 `vi.mock("react-native")` 与 `react-test-renderer` 写法：(a) 有 Codex 非 full-access 的已选 Profile 行时显示警告；(b) 席位号对不上、候选行、多行时不显示；(c) 编辑策略数字后 `onChange` 的块保留未知字段。`LaunchDialog`：mock 插件 hook，渲染 `kickoff-pending`（"计划请求已提交、几分钟、不要重复启动"）、`failed` 和 Engine 阻断/警告文案出现。
- **变异检查**：容器不传 `seatProfiles`；`TeamEditor` 不渲染容器；`LaunchDialog` 丢掉 `kickoff-pending` 分支——都应变红。
- **对验收项的影响**：AC16（对话框）、AC22（编辑器与对话框接线证据）。
- **版本与回滚**：无合同影响；撤销提交即可。三次尝试不过则撤回并记录，不影响完工。

### 任务 A18｜文档对账

- **目标**：文档与代码、验收证据一致。
- **依赖**：A13–A17 的结果已定。只改文档与（必要时）`readme-facts` 相关测试的期望。
- **改动**：
  - `docs/run-engine-acceptance.md`：每个证据变了的行更新证据、缺口、状态，新增的测试逐条按"`- 测试文件 :: 用例名`"写入（用例名与标题逐字一致，`acceptance-doc.test.ts` 会核对）；状态**只在缺口栏整句被证据关闭时才升级**。AC21 可升级为"已覆盖（范围声明：现有唯一的截止条件是宿主读取重查，B7 已推迟）"。AC19 的"M1 对账查询"一句改写为"不提供（kick 代替，见裁决）"。AC20 缺口栏写明"不做异常记录，理由见 `docs/next-phase-plan.md` 2.12/A16"。
  - `paseo-agent-team/README.md`：A13/A14 的语义；"高级字段"一段（`policy.devTargets`、`evidenceRoot` 在 Team 的 `runEngine` JSON 里的位置与形状，编辑器保存时不会丢）；"Run 进行中不要关闭或归档成员，引擎目前不能恢复这种任务"；刷新"未做"列表（无 approve、无在途任务取消、无 assign-seat、无派发后自动重试）。`readme-facts.test.ts` 须通过。
  - `docs/autonomous-notes.md`：进度表给 A13–A19 各加一行；"待批准"节开头加一句"B1–B13 与剩余清单已由 `docs/next-phase-plan.md` 裁决"；"没做或没做完"与"每项的检查结果"更新；新发现的合同需求另立"待批准（第二轮）"一节。
  - `docs/run-engine-iteration-plan.md` 第 8 节 P04 行：从**第 59 点**起，每个已完成的任务一条（用 `C:\Users\cc\AppData\Local\Temp\p05-mutation\append-point.mjs` 或 `append-point-34.mjs` 改编；文本单行、无竖线、反引号与粗体配对；一次一条，`git diff` 只改一行）。**不勾选第 9 节**。
- **测试**：`acceptance-doc.test.ts`、`readme-facts.test.ts`、全量门禁。
- **版本与回滚**：无。

### 任务 A19｜发布材料（只备材料，不做对外动作）

- **目标**：用户拿到就能决定合并与发布。
- **依赖**：A18。
- **产出**：`docs/release-handoff.md`，包含：(1) 范围摘要（`git log --format=%s 5533722..HEAD` 按 feat/fix 分组，写用户可见变化；Engine 仍默认关）；(2) 预期版本说明（release-please 按 `feat` 给 minor，预期 0.6.0；无破坏性标记；**不改任何版本文件和 CHANGELOG**）；(3) PR 标题与正文草稿（标题以 `feat(run-engine):` 开头）；(4) 发布说明草稿，含 2.7 的三条回滚注意；(5) 合并前检查清单（四项门禁命令、`git merge-base --is-ancestor a456eb0 HEAD`、`git merge-base --is-ancestor 940fca6 HEAD`、工作树干净、无临时产物）；(6) 合并方式建议（merge commit，非 squash）；(7) R2 默认开启的准入条件与一行改动的形状（2.7）；(8) 残余风险清单（5.2）。
- **不做**：改 `package.json`/清单/`paseo-plugin.json`/`CHANGELOG.md`；打标签；合并；推送；创建 PR。
- **版本与回滚**：无。

### 任务 A12｜DEV 真实验证（可选，必须最后，清单 C）

- **前置条件（全部满足才开始）**：A13–A19 已提交且最终门禁全绿；工作树干净；owner 判断本会话剩余额度足够（无法判断时只做 Run 1）；DEV 目录 `paseo-agent-team/.paseo-dev`（已忽略）；DEV 里**新建** Profile 引用本机已有的 Provider 登录，**绝不复制** `~/.paseo` 的 Profile 或凭据。DEV 环境细节读 `C:\Users\cc\AppData\Local\Temp\agent-team-handoff\briefing-p06.md` 的"DEV 环境"一节。
- **硬规则**：只用 worktree 里的 `.paseo-dev`；每条命令显式 `--home`/`--host` 并设置 `PASEO_HOME`，清掉代理环境变量；发命令前复读一遍；DEV daemon 的 Windows `EPERM rename` 启动失败最多重试 3 次，仍不行就跳过；最多 4 个 Run；最便宜的模型（`claude-haiku-5-5`、`codex/gpt-6-luna`）；墙钟总上限 3 小时；任何 Run 20 分钟无进展就取消；额度或供应商报错就停；结束必须清理（归档 DEV 里建的 Agent、删探针仓库与临时目录、`daemon stop --home`）。
- **六项必验目标**（清单 C 的原话）：(1) 补证模板是否被真实模型遵守；(2) `replan` 的 v4 提示词；(3) 判官重派；(4) 重启后 `kick`；(5) S1 在真实宿主上的重查；(6) 新界面的真实浏览器、窄屏、断线重连检查。2.7 的"6 项验证"指这六项。下面的 Run 分配是建议，A12 会话可调整，但总数不超过 4 个 Run。
- **建议的 Run 分配**：
  - Run 1（claude 生产者 + codex 审查者，两个有依赖的任务）：(1) 补证模板与报告格式是否被真实模型遵守；(4) 重启 DEV daemon 后 `kick` 恢复；(6) 真实浏览器检查 Runs 页的宽屏、窄屏（≤390px）、停起 daemon 的断线重连不闪空。
  - Run 2：(2) 在 Run 还等任务图时按"重新规划"，看真实协调者是否按新 nonce 交出 `task-dag`；任务图接纳后，(3) 让审查者第一次不交报告块（在 Team 的审查者角色说明里写明"第一次只回复 OK"），观察补报、`stuck:` 决策和点"重试"后的判官重派；若出现权限请求，只观察、不用引擎答。
  - Run 3：席位预算设为 1 → 第二个任务被挡并出告警 → 追加预算后继续；再取消这个 Run（有成员在途）：期间宿主零发送、零归档，在途回合结束后才释放。可选探针（2.12）：另一个成员在回合中被归档，记录宿主发出的 hook（有没有 `turn_ended`）。
  - Run 4：让成员对补证请求回复 `blocked` 造出冻结任务 → 取消任务 → 另一个 Run 拿到同一仓库的占用。(5) S1 重查在真实宿主上的表现：短暂停 DEV daemon 制造读取失败，恢复后观察自动继续。
  - 可选探针 V2′：同一幂等键在 DEV daemon 重启后是否仍返回同一 Agent，同键不同参数时的行为（为 A-1 的触发条件取证）。
  - 可选探针 F：若有廉价办法制造"回合失败但 Agent 创建成功"（例如一个会让回合失败的坏模型名），取一份失败回合的 canonical timeline 样本（有没有 `tool_call` 条目、`turn_ended.outcome` 的内容），为 A-5 的触发条件取证；没有廉价办法就不做，不要为此多开 Run。
- **记录**：每项结果各写一条计划记录（第 59 点之后顺延），如实写样本数（"N=1"就写 N=1）、模型、成败与原因；DEV 验证结果同步到验收表的"DEV 记录"栏；失败的项不隐瞒。A12 不改源码：发现缺陷只记录；修复另走任务，最多两轮，每轮走完整门禁；超出合同的写进"待批准（第二轮）"。
- **版本与回滚**：无。

## 4. 执行规则

### 4.1 通用门禁（每次提交前，在 `paseo-agent-team/` 下）

1. `npx biome check .`——只允许 `tests/run-core/r01g-core.test.ts` 的 2 条既有警告。
2. `npx tsc --noEmit -p .`
3. `npm test`（基线 194 个文件 3283 通过、3 todo；新增后以最新数字为准，不得有失败）。
4. `npm run verify:package`
5. `version-flow`、`ledger-real-fs` 并行时的 Windows `EBUSY` 单独重跑通过即可，不算失败。
6. 长命令（全量 `npm test`、变异检查）用 `run_in_background`，命令里套 `timeout`，输出写系统临时目录的文件，只读末尾；工具说"已转到后台"后**先核对文件是否真的落盘**（有过后台调用丢失、文件没写的先例）。

### 4.2 变异检查协议

- 凡有行为变化的任务必做；纯测试任务每个测试组至少 2 项。清单写成"文件、被替换的原文、替换成什么、跑哪些测试"（模板都在 `C:\Users\cc\AppData\Local\Temp\p05-mutation\`：通用运行器 `mutate.mjs`，各任务的变异清单样例 `a1.json … a10.json`，早期例子 `run-s1.mjs`）。
- 跑前把被改文件备份到仓库外的临时目录；每项：破坏 → 跑对应测试 → 必须变红 → 还原。一道防线有多层时同时破坏几层，存活项必须在记录里写明"有意冗余"及理由，否则补测试直到被抓。
- 跑完逐个 `cmp` 确认字节还原，并确认输出里有"ALL RESTORED"字样；脚本被截断（少了最后一项或没有该字样）就从备份还原、`cmp`、单独重跑缺的项。
- **变异检查的还原只用备份加 `cmp`，不用 `git checkout`、`git restore`、`git stash`**（曾因误用 `git checkout` 丢掉过未提交的接线）。任务撤回（4.4）是另一回事，那里按 4.4 的做法。

### 4.3 提交协议

- 每个任务两个提交：代码+测试一个；文档一个（计划第 59 点起一条、`docs/autonomous-notes.md` 进度表一行与检查结果、验收表）。
- 提交信息英文，说清做了什么、没做什么，末尾 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`（实施会话是别的模型时，用该会话被要求的署名行）；用 `git commit -F <系统临时目录里的文件>`。
- 只在本 worktree 提交；绝不 push、merge、rebase、打标签；不改版本号与 `CHANGELOG.md`；改文件保持原有换行（源码目前都是 LF）；改源文件用 Edit/Write，不用 shell 拼。

### 4.4 三次尝试与撤回

- 一次尝试 = 一轮"改动 + 该任务的完整定向测试集或四项门禁"未通过；定向测试内的迭代不算。
- 第二次失败后可请 GPT 做只读排障（见 4.6），第三次仍失败则撤回：先 `git status` 核对未提交改动只含本任务；对本任务改过的文件逐个 `git restore --source=HEAD -- <文件>`，删除本任务新增的文件，不用 `git stash`；在 `docs/autonomous-notes.md` 的"没做或没做完"记原因，依赖它的任务一并跳过，做下一项。
- 撤回时 A13/A14 触发 A14F；A15、A16 按测试组撤回（只撤失败的那一组）；A17 整体撤回。这三者的撤回不影响完工，但对应的验收缺口原样保留，并写进 5.2 的残余风险。

### 4.5 遇到必须改合同的需求

写进 `docs/autonomous-notes.md` 的"待批准（第二轮）"（编号 B14 起，格式照原"待批准"节），**不实施、不提问、继续下一项**。这些项不阻塞完工，除非它们让门禁失败。合同变更的范围：schema（`ledger.ts`、`protocol.ts`、`config.ts`、`rpc.ts` 里已有的形状）、reducer 事件词汇、台账字段（含新透传块）、新增或注册 RPC、新的 schema 版本、提示词模板（含新版本）、默认开启、版本号与发布。拿不准时按"需要批准"处理。

### 4.6 模型分工与额度（共享的 Claude 5 小时额度）

- **负责人**：默认 Sonnet 5.5，每个阶段一个新会话（阶段划分见 3.0），协调者不轮询、不插话；同一时刻同一 worktree 只有**一个写者**。A15、A16、A17、A18、A19 是叶子任务，Sonnet 额度紧张时可交给 DeepSeek 做负责人，规则与门禁相同。
- **门禁与变异检查**：负责人提交前自己跑四项门禁和变异检查（输出写文件、只读末尾，token 开销很小）；提交之后由 DeepSeek 独立重跑一遍四项门禁并复核变异记录（只读源码，输出写临时目录，不改文件）。两边结果不一致以失败为准，DeepSeek 把输出路径交回负责人。
- **排障**：同一任务第二次失败后，把失败输出和当前 diff（不带负责人的结论）交给 GPT 做只读诊断，给出修复建议，由负责人改；避免第三次盲试。
- **独立评审**：阶段 3 结束时，对 `git diff f1f1e48..HEAD`（代码与测试为主，文档抽查）做两份独立评审——DeepSeek 一份（正确性与回归）、Grok-4.6-High-Fast 一份（合同与回滚：schema 版本、提示词模板、RPC 数、旧记录兼容）。**不用 Grok-4.7**。评审只给 diff 和检查单，不给负责人的结论；确认的缺陷必须修复或登记为已知限制，评审最多两轮。
- **不用 Opus（尤其是 max）做实施或复核**。遇到本文没覆盖的合同变更按 4.5 登记，等用户。
- 省额度：不通读仓库；大文件（例如计划第 8 节 P04 行约 84 KB）只用 node 取片段；输出写文件读末尾；不启动无关子代理。

### 4.7 安全与环境

- 绝不对默认 Paseo host 或 `~/.paseo` 做插件 install/reload/enable/disable/update/remove；绝不运行裸 `paseo reload|restart|daemon stop|daemon restart`；运行时验证只在 A12，且显式 `--home`/`--host` 与 `PASEO_HOME`。
- 绝不运行 `python`/`python3`（Windows 占位程序会卡死工具）；脚本用 node，放系统临时目录；Bash 里先 `export PATH="/e/Program Files/nvm/v24.18.0:$PATH"`；读文件用 Read/Grep/Glob。
- `paseo-agent-team/node_modules` 是指向主工作区 `node_modules` 的 junction：**绝不对含它的目录做递归删除**，删除目录前先摘 junction（`cmd /c rmdir <junction>`）。
- 绝不碰主工作区 `F:\tools\paseo-agent-team` 与 `main`。永不代答权限、不发打断消息、不归档成员（A12 的 DEV 清理除外，且只限 DEV 里自己建的 Agent）。

## 5. 完工定义

### 5.1 必须满足

1. A13、A18、A19 已提交且门禁全绿；A15、A16 的测试组已提交，或个别组三次不过而撤回并记录；A14 已提交，或已撤回且 A14F 已提交；A17 已提交或已撤回并记录。A13 若撤回，同样由 A14F 兜底。
2. 最终 HEAD 上四项门禁全过（biome 仅 2 条既有警告），并由另一个模型的会话独立重跑一遍，输出路径写进笔记。
3. 每个有行为变化的任务（A13、A14）的变异检查全部被抓到，存活项有"有意冗余"说明，源码经 `cmp` 逐字节还原；纯测试任务每组至少 2 项变异。
4. 合同不变量未破坏：`RUN_SCHEMA_VERSION` 仍为 2、`RUN_SUPPORTED_SCHEMA_VERSIONS` 仍为 `[1, 2]`（`git diff f1f1e48..HEAD -- paseo-agent-team/shared/schemas/run-engine/ledger.ts` 不应出现版本常量的变化）；提示词模板文件零改动；RPC 总数仍为 28；`tests/run-engine/ledger-versions.test.ts` 通过；A14 的回滚演练有记录。
5. 文档一致：验收表每行的状态与证据相符、没有"未覆盖"、`acceptance-doc.test.ts` 与 `readme-facts.test.ts` 通过；计划第 59 点起每个任务一条；笔记进度表覆盖 A13–A19；README 与代码行为一致；计划第 9 节**未勾选**。
6. 两份独立评审完成，确认的缺陷已修复或登记为已知限制。
7. 发布材料 `docs/release-handoff.md` 已备，A3（`a456eb0`）与 A5（`940fca6`）都在待合并范围内（命令核对）。
8. 工作树干净，仓库里没有临时产物（探针脚本、日志、`.playwright-mcp/`），没有任何对外动作（无 push、merge、tag、版本号或 CHANGELOG 改动）。

### 5.2 可以不做也宣布完工，以及残余风险

| 不做的事 | 残余风险 |
| --- | --- |
| A12 DEV 验证（整体） | 补证模板、`replan` v4 提示词、判官重派在真实模型上是否被遵守没有证据；重启后 `kick`、S1 重查在真实宿主上没有证据；新界面的真实浏览器、窄屏、断线重连没有证据；AC12、AC22 保持"部分/需 DEV"。缓解：README 标明 Engine 是实验性 opt-in；R2 默认开启在 A12 完成前不得进行 |
| A-1 B13 完整续办 | 启动崩溃窗口里已创建未登记的 Agent 只能靠告警人工找，需重新启动 Run |
| A-3 在途成员归档式取消 | 不能在不等回合结束的情况下取消单个在途任务；整个 Run 的取消要等在途回合结束 |
| A-4 `assign-seat` | 席位不可用导致任务卡住时，只能取消任务，不能改派 |
| A-5 B7 自动重试 | 瞬时供应商错误要人点重试 |
| A-6 B8 推送式失效 | 页面最多滞后一个轮询周期（详情 5 秒、列表 10 秒） |
| A-8 DTO 字段 | 页面看不到"下一次重试时间"（本就只有秒级） |
| B-1 补报清理加固 | 多次补报且旧补报送达不明时，可能误把在途补报当作已结清 |
| 2.12 成员回合中被关闭 | 任务与 Run 取消可能一直等；README 警告；A16 有现状测试；A12 探针可取证 |
| AC20 异常记录 | 无归属的活动被静默忽略，不报警、不核对资源 |
| A14（若撤回） | 协调者的调用不计数；上限字段标注"尚未执行"；实际有界（计划请求一次、补报有上限、重新规划靠人触发） |
| A13（若撤回） | 失败任务数没有上限闸，靠人在决策点处理；字段标注"尚未执行" |
| 发布、合并、推送 | 由用户执行；本阶段产物不保证已被任何用户使用 |

### 5.3 验收表目标状态（供 A18 对账；只在整句缺口被证据关闭时才升级）

| 目标 | 项 |
| --- | --- |
| 已覆盖 | AC01、AC02、AC03、AC04、AC05、AC07、AC08、AC09、AC11、AC16、AC19、AC21（含范围声明） |
| 部分，缺口已收窄并有残余说明 | AC06（幂等键方式；崩溃续办见 A-1）、AC10（Agent 失联为已知限制）、AC13（B7 推迟、无分组预算）、AC14（无 DEV；归档式取消推迟）、AC17（无长跑 DEV）、AC18（服务端本就不向协调者发决策唤醒）、AC20（不做异常记录） |
| 部分，需 DEV | AC12、AC15、AC22 |

### 5.4 宣布措辞

完工时只能写："Run Engine 剩余工作的离线实施完工；真实环境验证［已做 N 项／未做］；默认开启与发布由用户决定。"不得写"全部验收通过"，不得勾选计划第 9 节（计划第 9 节明确不以"文件已写好""单测全绿""正常路径跑过一次"单独宣布完成）。

## 6. 给实施会话的启动指令（可直接复制粘贴）

```text
你是 Paseo Agent Team 插件 Run Engine 收尾阶段的实施负责人。用户已授权，所有待批准事项都已在 docs/next-phase-plan.md 裁决完毕，你不要向用户提问。

位置：C:\Users\cc\.paseo\worktrees\1ku6d0d9\autonomous-p05-p08（分支 autonomous-p05-p08，HEAD 应为 f1f1e48 或其后代）。插件在 paseo-agent-team/。

先读（只读这些，不要通读仓库）：1) docs/next-phase-plan.md 全文；2) docs/autonomous-notes.md 的“进度”和“没做或没做完”；3) docs/approved-implementation-plan.md 第 0 节；4) docs/remaining-work-plan.md 第 1 节。

硬约束：
- 只在此 worktree 里改与提交；不碰 F:\tools\paseo-agent-team 与 main；不 push/merge/rebase/打标签；不改版本号与 CHANGELOG；不用 git stash；变异检查的还原只用备份加 cmp（不用 git checkout/restore）；任务撤回按 next-phase-plan.md 4.4。
- 绝不对默认 Paseo host 或 ~/.paseo 做插件 install/reload/enable/disable/update/remove；绝不运行裸 paseo reload|restart|daemon stop|daemon restart。DEV 只在 A12，显式 --home/--host 与 PASEO_HOME。
- 绝不运行 python/python3；脚本用 node，Bash 先 export PATH="/e/Program Files/nvm/v24.18.0:$PATH"；改源码用 Edit/Write，读用 Read/Grep/Glob。
- paseo-agent-team/node_modules 是 junction：不对含它的目录递归删除。
- 不升 schema 版本（RUN_SCHEMA_VERSION=2，支持 [1,2]）、不改提示词模板、不改 reducer 词汇、不新增 RPC（保持 28）。必须改合同的需求写进 notes“待批准（第二轮）”，继续下一项。
- 永不代答权限、不发打断消息、不归档成员。同一时刻同一 worktree 只有一个写者。

顺序：基线复核（四项门禁，记数字）→ A13 → A15 → A16 → A14（三次失败则撤回并做 A14F）→ A17（可选）→ A18 → A19 → 最终门禁与两份独立评审 →（A12 可选，满足其前置条件才做）。每个任务的范围、测试、变异点、回滚都在 next-phase-plan.md 第 3 节。

每个任务：实施 → 定向测试 → 四项门禁（biome 仅 2 条既有警告、tsc、npm test、npm run verify:package）→ 变异检查（先备份、临时破坏、确认用例变红、还原并逐个 cmp）→ 代码加测试一个提交；文档（计划第 8 节 P04 行第 59 点起一条、笔记进度表与检查结果、验收表）另一个提交。提交信息英文，用 git commit -F 指向系统临时目录的文件，末尾带 Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>。一个任务三次尝试仍过不了：撤回未提交改动、记入 notes、做下一项。

分工：你（Sonnet）做负责人，提交前自己跑门禁与变异检查；提交后请 DeepSeek 只读地独立重跑门禁；同一任务第二次失败后请 GPT 做只读排障；阶段 3 结束请 DeepSeek 与 Grok-4.6-High-Fast（不用 4.7）各做一份对 f1f1e48..HEAD 的独立评审。不用 Opus。省额度：输出写文件读末尾，大文件用 node 取片段；看到“已转到后台”先核对文件是否落盘。

不做：发布、合并、推送、改版本号、改 CHANGELOG（A19 只备 docs/release-handoff.md）；不勾选计划第 9 节。

最后回复：提交列表、每项测试数、撤回项、待批准（第二轮）、残余风险（对照 next-phase-plan.md 5.2）。
```

## 附录：重新评估触发条件汇总

| 事项 | 触发条件 | 检查方法 |
| --- | --- | --- |
| B13 完整续办 | A12 探针 V2′ 通过，且出现真实的启动中断告警或明确需求 | A12 记录；告警出现在 Runs 页 |
| 在途成员归档式取消 | 明确需求，或 `resume-seat` 已实现 | 用户提出；`grep resume-seat` |
| `run.export` | 出现诊断导出的使用方 | 用户提出 |
| `assign-seat` | 成员失联有可验证的宿主信号，或真实案例 | A12 探针；用户反馈 |
| B7 自动重试 | 宿主给出失败阶段字段，或 A12 样本证明可区分 | 新 SDK 的 `turn_ended` 类型；A12 记录 |
| B8 推送 | 新 SDK 出现服务端推送接口 | 在新 SDK 的 `dist/server`、`dist/client` 搜 `subscribe`/`emit`/`publish`/`stream` |
| `nextAttemptAt`、`waitingCode` | 出现 60 秒以上的截止条件 | 新增定时器时 |
| 补报清理加固 | 一例真实复现，或 A12 观察到 | 台账事件 `report-repair-settled` 里带 `outcome-unknown` 状态 |
| 成员回合中被关闭 | A12 探针显示宿主不发 `turn_ended`，或用户遇到 | A12 记录 |
| 默认开启 R2 | 2.7 的六条准入条件 | 用户判断 |

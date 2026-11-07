# 无人值守会话笔记

计划：`docs/remaining-work-plan.md`。分支：`autonomous-p05-p08`。基线：`main` 的 `5533722`。
这个文件由无人值守会话维护；用户回来后先看"待批准"。

## 进度

| 任务 | 状态 | 提交 | 测试数 | 说明 |
| --- | --- | --- | --- | --- |
| T0 准备 | 已做 | — | 2844 | junction 接好；基线 biome 2 警告、tsc、2844 通过（3 todo）、verify:package 通过 |
| T1 计划第 35 点（S1 记录） | 已做 | a42f51c | — | 文档提交，diff 只改计划 P04 行一行 |
| T2 暂停/结束的 Run 不发送 | 已做 | e815db1（代码）+ 计划第 36 点 | 2855 | `effects.ts` 的 `lifecycleMaySend`，快照与提交各检查一次 |
| T3 来源仍是最新的复核 | 已做 | b2eb368（代码）+ 计划第 37 点 | 2862 | 入账提交内比较 anchor（`stale`）；补报 prepared→sending 提交内核对 assignment 仍在等报告 |
| T4 `creating` 崩溃续办 | 未完成（需批准） | — | — | 判断：重建 `CreateMemberInput` 的信息没有冻结在记录里，见待批准 B13；没有写代码 |
| T5a Runs 页控制 | 已做 | 6b96dcc（代码）+ 计划第 38 点 | 2929 | 重新规划、重试（带确认和按类别的说明）、催办；按服务端声明门控；去掉"只读观察"文案 |
| T5b 为什么在等 / 因果时间线 | 已做 | 1f70aaa（代码）+ 计划第 39 点 | 2963 | 表驱动的 why/who/next 与事件原因；扫描服务端源码穷举原因码和事件 kind |
| T5c Team 编辑器 runEngine | 已做 | 4bd0941（代码）+ 计划第 40 点 | 3005 | 启用开关、席位卡、7 个策略数字、实时阻断与警告；往返不丢未知字段 |
| T5d 启动对话框 | 已做 | 6a50c38（代码）+ 计划第 41 点 | 3016 | kickoff-pending 文案（计划请求已提交、几分钟、不要重复启动）；预览的 Engine 阻断/警告补回归用例 |
| T5e 刷新 | 已做 | d195071（代码）+ 计划第 42 点 | 3036 | 页面不可见时停轮询、不重叠、同版本不重绘 |
| T5f 响应式与断线 | 已做（真实浏览器检查未做） | d195071（同上）+ 计划第 42 点 | 3036 | 布局的静态保护测试；断线重连的会话规则补 7 例 |
| T6a 验收表 | 未开始 | — | — | |
| T6b 使用说明 | 已做 | a97c2c7 | 3046 | README 新增"Run Engine (opt-in)"一节；`readme-facts.test.ts` 对照代码核对其中的名字和数字 |
| T6c 关闭开关后的已有 Run | 已做 | c47d477 | 3046 | `runtime.test.ts` 新增 3 例：开关关闭后 hook、恢复、kick、列表、控制仍然工作 |
| T6d 计划状态与收尾 | 未开始 | — | — | |
| T7a 取消的内部能力 | 未开始 | — | — | |
| T7b 暂停的内部能力 | 未开始 | — | — | |
| 第 5 节 DEV 验证 | 未开始 | — | — | |

## 待批准

（每条：编号｜标题｜为什么需要批准｜没批准时现状｜最小形状｜影响的验收项｜建议。第 3 节的 B1–B12 在这里展开；我在做的过程中新发现的从 B13 起编号。）

### B13｜`creating` 阶段崩溃后的续办：要冻结启动规格

- **为什么需要批准**：续办必须能原样重建每个成员的创建请求，而这些信息现在没有冻结在记录里。冻结就是在 `launch` 里新增透传字段，属于"台账字段（包括新增透传字段的约定）"。
- **没批准时现状**：`startEngineRun` 用 `engine:<runId>:seat:<seatId>` 作幂等键创建，进程在创建过程中死掉后，重启的 `driver.recover` 看到 `launch.state === "creating"` 的 Run 什么也不做：`settleWaiting` 只会在 `launch` 不是 `failed`/`cancelled` 时跑 outbox，而 outbox 里还没有计划请求（它在 `kickoff-pending` 才写入）。Run 停在 `bootstrapping`，已创建的 Agent 留着，没有任何告警。
- **核对结果（记录里有什么、缺什么）**：`createAgent` 的请求包含 `workspaceId`、`parentAgentId`、`title`、`labels`、`systemPrompt`、`profile`（含 `modeId`、`thinkingOptionId`、`featureValues`）、`mcpServers`、`idempotencyKey`。记录里已有：`launch.workspace`、`launch.seatProfiles`（只有 profileId/name/provider/model/family）、`launch.systemPrompts`（只有模板名、版本和哈希，没有文本）、`launch.modelPlan.task`、各角色 id。**缺**：成员 `title`、`labels`、角色全文（系统提示词的输入：角色说明、`operatingRules`）、`mcpServers`、Profile 的 `modeId`/`thinkingOptionId`/`featureValues`。从当前团队配置重建不可靠：配置可能在崩溃后被改，且 `title`/`labels` 是启动规划器生成的，不是配置里的固定值。
- **最小形状**：`launch.agentSpecs`（透传字段，和 `launch.workspace` 一样带独立读取器）：`{ version: 1, seats: { [seatId]: { parentSeatId: string | null, title: string, labels: Record<string,string>, systemPromptSha256: string, systemPrompt: string, profile: { id, provider, model, modeId, thinkingOptionId, featureValues }, mcpServers: [...] } } }`，在 `store.create(record)` 同一次提交里写入（`startEngineRun` 的 "preparing" 步骤，创建任何 Agent 之前）。系统提示词存全文的话要给大小上限（成员提示词 + 角色全文，约几 KB 每席位）；不想存全文就存重建它所需的输入并在续办时用 `systemPromptSha256` 对账，对不上就记 `failed` 并按偏好归档。`resume` 放在 `server/run-engine/start.ts` 导出，`driver.recover` 在 `launch.state === "creating"` 时调用：给还没有 `agentId` 的启用席位用同一个幂等键再创建、绑定，然后走和 `startEngineRun` 相同的 kickoff 步骤（同一个 `kickoff` 子函数，需要从 `startEngineRun` 里拆出来）。
- **影响的验收项**：AC14（续办），AC04/AC05（不重复创建）。
- **建议**：中优先级。批准后实现约一天：拆 `startEngineRun` 的 kickoff、写 `agentSpecs` 读写器、在第 k 个成员创建前后崩溃的假适配器测试、变异检查。在这之前可以先做一件不需要批准的小事（我没做，因为它改变行为）：`recover` 看到 `creating` 且没有任何 Agent 在飞的 Run 时，写一条告警"启动在创建成员时中断"，让人知道要重新启动。

### 第 3 节的提案（B1–B12）

下面每条的"最小形状"是我读过代码后的草案，不是已经设计好的方案；批准后各自还要出设计和变异检查。"建议顺序"见这一节末尾。

### B1｜P05 S2：重查成功后由引擎自己首次派发

- **为什么需要批准**：要新增 schema 版本（v3）。计划第 35 点已记：旧 v2 程序读 v3 会得 `unknown-version`，它的跨 Run 资源视图 `trusted:false`，`buildDispatch` 返回 `other-runs-untrusted`，也就是回滚时所有 Run 的新资源授予都被阻断（不限同一个仓库）。还要给 `effects` 增加一个"只发一条指定意图"的入口。
- **没批准时现状**：S1 的重查只读，读恢复后只留一条提示告警，**人要点"立即检查并推进"（kick）**才会继续；没有自动派发。
- **最小形状**：`shared/schemas/run-engine/ledger.ts` 的 `RUN_SCHEMA_VERSION` 变 3，双读 v1/v2/v3，沿用"普通提交不改版本"规则（`ledger-versions.test.ts` 的模式）；`readRetries.items[]` 的状态机加一个"已恢复待首次派发"并记录它对应的意图 id；`server/run-engine/effects.ts` 增加 `sendIntent(runId, intentId)`，只发这一条 `prepared` 的 `dispatch`、不跑其他意图，并沿用现有的"先落 `sending` 再调用"顺序；`read-retry.ts` 在重查成功的提交里不再只写提示，而是登记这条意图。
- **影响的验收项**：AC13（临时失败的恢复）、AC05。
- **建议**：中。做之前先做 B12（让读失败的覆盖面完整），否则 S2 只覆盖半个入口。需要一次回滚演练（用 `ledger-versions` 的旧 store 夹具）。

### B2｜P05 S3：统一模型预算

- **为什么需要批准**：改预算语义和 `budgets.entries` 的使用方式，属于台账字段与 reducer 行为。
- **没批准时现状**：只有成员派发和补证请求、报告重发（补证链里）预扣席位预算；**计划请求、`replan`、协调者的重发不扣预算，协调者席位没有预算条目**，所以协调者的模型调用量不被计数，AC17 的"零模型调用/不重复记账"也没有逐项证明。
- **最小形状**：`policy.seatBudgets` 里为协调者席位（`seatId: "coordinator"`）增加条目（`team-config-edit.ts` 的默认值与 `start.ts` 的冻结都要写）；`addPlanRequest`、`requestReplan`、`requestPlanRepair` 在同一次提交里 `predebit(...)`（意图键用各自的幂等键），耗尽时返回现有的 `budget-exhausted` 并开 D4；`start.ts` 的首次计划请求在创建 Run 时预扣。
- **影响的验收项**：AC13、AC17、AC18。
- **建议**：高（不做就无法证明 AC17）。依赖 B3（预算耗尽后要有出路）。

### B3｜`increase-budget`：预算耗尽开 D4、`decide` 的答案多一个变体

- **为什么需要批准**：改 RPC 输入形状（`RunDecideAnswerSchema` 联合加变体）、reducer 词汇（`decision` 事件目前是 "unsupported-in-batch-b"，决策答复是受控函数）。
- **没批准时现状**：预算耗尽时 `dispatch` 返回 `blocked`/`budget-exhausted`，任务被备注原因但**不开决策点**，页面上也没有"追加预算"；人只能改 Team 配置后新开 Run。
- **最小形状**：`rpc-actions.ts` 的 `RunDecideAnswerSchema` 加 `{ action: "increase-budget", seatId, by }`（`by` 1–`N` 有上限）；`decision-answer.ts` 增加 `planIncreaseBudget`：D4 预算类决策被答复时把对应 `budgets.entries[].limit` 加 `by`，写 `decision-answered` 审计，其余沿用 `answerDecision` 的一次性与版本检查；`dispatch` 在预算耗尽的提交里开一个 `dedupeKey: "budget:<seatId>"` 的 D4。客户端 `controls.ts` 的 `retryExplanation` 旁加一段说明。
- **影响的验收项**：AC13。
- **建议**：高，和 B2 一起批。

### B4｜取消、暂停、续办的 RPC，以及 `run.approve`、`run.reconcile`、`run.export`

- **为什么需要批准**：新增并注册 RPC（`index.server.ts`、`shared/rpc/run-engine.ts`、`rpc-actions.ts`），是用户可见的新写入口。`rpc.ts` 里已有只定形状的 `RunControlInput`、`RunApproveInput`、`RunReconcileInput`。
- **没批准时现状**：引擎内部没有取消和暂停的入口（reducer 有 `cancel-requested`、`cancellation-checked`、`run-cancelled`、`run-paused`、`run-resumed` 事件，T2 已让暂停不发送，但没有任何调用者）。页面上"取消/暂停/批准"不存在，README 已说明。
- **最小形状**：先做 T7a/T7b 的引擎内部能力（`server/run-engine/cancel.ts`、`pause.ts`），再注册窄 RPC：`agent-team.run.pause`、`run.resume`、`run.cancel`（取消带原因，取消前展示将被释放的占用与在途 assignment 数）；`supportedControls` 增加对应名字，`controlsOf` 与 `EngineControls` 只在服务端声明时画按钮；取消的 `cancel_intents` 需要对每个在途 assignment 先取静止证据，未证明静止的不释放占用。`run.export` 另议。
- **影响的验收项**：AC14、AC10。
- **建议**：高。顺序在 B6 之前（冻结任务的出路依赖取消）。

### B5｜权限等待（AC12）

- **为什么需要批准**：可能要新增台账字段（记录"任务在等哪条权限"）和事件，且涉及永不代答的策略。
- **没批准时现状**：投影已能从 `eventReceipts` 的 `permission_requested/resolved` 推出 `blockedBy: permission` 并显示"等待权限回应"；引擎不会代答（`respond_to_permission` 没有任何调用）。**但没有测试证明"等待期间重启后只继续剩余阶段"，也没有任务进入权限等待状态时的调度规则**（目前派发前只是查席位 `pendingPermissions` 作为拒绝原因 `permission`）。
- **最小形状**：先不加字段：用现有 `eventReceipts` 的权限回执判定，补三个测试（重启后仍在等、决定重复提交只生效一次、等待期间不派发新任务给该席位）。如果测试发现需要持久化"等待了多久/由谁回应"，再提 `assignment.permissionWait` 透传字段（需批准）。
- **影响的验收项**：AC12。
- **建议**：中。先做不需要批准的测试部分（我没做，因为本轮目标是已批准项）。

### B6｜冻结任务的出路：`reject`/`cancel`/`assign-seat` 决策动作

- **为什么需要批准**：reducer 词汇（决策答案动作）、RPC 形状。
- **没批准时现状**：补证被 blocked 后、判官"回合结束没有可用报告"等情形，任务冻结且占用保留，页面只有"重试"（对补证 assignment 刻意不开 `stuck:` 决策），README 已说明出路是人工。
- **最小形状**：`decision-answer.ts` 增加 `cancel`（走 B4 的取消）、`reject`（把任务标失败并释放，要求所有 assignment 已证明结束）、`assign-seat`（改派到另一个席位，要求新席位合格）；`RunDecideAnswerSchema` 加三个变体；补证 assignment 的冻结要有专门的决策类别，避免落入普通 `retry`（计划第 34 点的约束）。
- **影响的验收项**：AC10、AC14。
- **建议**：中。依赖 B4。

### B7｜派发之后的临时失败自动重试

- **为什么需要批准**：新增 reducer 事件（`execution-retry-admitted`），并依赖宿主能证明"失败发生在任何工具执行之前"。
- **没批准时现状**：派发后成员回合因临时错误失败（`turn_ended` 的 outcome 为 failed），引擎视为"回合没有可用报告"，经补报用尽后开 D1；**不会自动重试**，AC13 里"到期按预算执行"只覆盖了发送前的退避，不覆盖执行后的。
- **最小形状**：`RUN_REDUCER_EVENT_KINDS` 加 `execution-retry-admitted`；`observer` 记录失败回执时带上宿主给的"未执行任何工具"证据（P00 宿主能力矩阵里要确认有没有这个信号，没有就不能做）；`policy.perTask` 增加 `executionRetries` 上限；退避到期时间用现有的持久定时器模式（`read-retry.ts` 的"先落账再读"）。
- **影响的验收项**：AC13、AC21。
- **建议**：低。先确认宿主信号存在，否则放弃这项。

### B8｜客户端的服务端推送式失效（替代轮询）

- **为什么需要批准**：新增 RPC/事件通道，改插件与宿主的合同。
- **没批准时现状**：详情 5 秒、列表 10 秒轮询，页面不可见时停（T5e）；`unchanged` 保证空闲时每次读取很小。
- **最小形状**：宿主侧发 `agent-team.run.changed {runId, revision}` 事件（如果插件 SDK 支持从 hook 向客户端推送，需要 P00 确认），客户端收到后调用 `refresh`，轮询退为 60 秒保底。
- **影响的验收项**：AC22。
- **建议**：低。

### B9｜默认开启 Engine 的策略、灰度、版本号与发布

- **为什么需要批准**：默认值、发布、`CHANGELOG`、版本号，规则明确要求用户决定。
- **没批准时现状**：默认关闭，需要 `PASEO_AGENT_TEAM_RUN_ENGINE=1` 加 Team 的 `runEngine`；README 已写使用说明；版本号与 `CHANGELOG` 没动。
- **最小形状**：不涉及代码，先定准入条件：第 9 节的完成条件全部满足、B2/B3/B4/B11 已批准并完成、DEV 验收（第 5 节）已跑过。再定灰度方式（只对新建的 Team 默认关、预设里加一个关闭状态的样例）。
- **影响的验收项**：AC16。
- **建议**：最后。

### B10｜界面想要的新 DTO 字段

- **为什么需要批准**：`rpc.ts` 的输出形状变化。
- **没批准时现状**：重试说明只能按决策类别区分（D1/D3/D4），D1 里"成员 stuck、判官 stuck、补报用尽"分不开；"为什么在等"只能由 `waitingReason` 码和 `blockedBy` 推；没有"下一次重试时间"。
- **最小形状**：`RunDecisionViewSchema` 加可选 `kind: "quality" | "stuck-producer" | "stuck-judge" | "report-unusable"`（由服务端 `classifyDecision` 填，客户端只显示）；`RunTaskViewSchema` 加可选 `nextAttemptAt`（时间）与 `waitingCode`（结构化原因，替代客户端解析字符串）；`controls.ts` 与 `waiting.ts` 改为优先用这些字段。向后兼容：全部可选，旧客户端忽略。
- **影响的验收项**：AC22。
- **建议**：中，和 B1/B7 一起（它们产生"下一次时间"）。

### B11｜事件压缩（检查点）

- **为什么需要批准**：改台账语义（压缩掉的事件不可恢复）、可能新增 `checkpoint` 字段的使用与历史游标行为；风险较高。
- **没批准时现状**：`events` 上限 8192、`eventReceipts` 8192、`nonceRegistry` 8192（`ledger.ts`），Engine 没有压缩；每个任务、回合、重发、告警都写事件，长 Run 会写满，写满后提交会因 `invalid-record` 失败。`RunHistoryCheckpointSchema` 和 `historyPage` 的游标已经按 `checkpoint.throughSeq` 绑定，但**没有任何代码写检查点**。
- **最小形状**：`server/run-engine/compact.ts`：当 `events.length` 超过软阈值（比如 6000）时，在一次提交里把最早的、早于所有未了结项的事件折叠成 `checkpoint { throughSeq, counters, digest }`；不压缩 `eventReceipts` 中仍被未了结 assignment 引用的回执；历史页对 `seq <= throughSeq` 返回"已压缩"提示；`encodeHistoryCursor` 已绑定检查点，旧游标自然失效（AC22 已有用例）。
- **影响的验收项**：AC15、AC22。
- **建议**：**高优先级**。在默认开启（B9）之前必须做；也最好早于任何长时间的真实运行。

### B12｜S1 的扩展：对账路径、不完整窗口、补证发送前复核的读取失败也登记重查；读取恢复后自动入账

- **为什么需要批准**：扩大登记范围会写更多 `readRetries` 项（容量与语义），自动入账需要把"无发送能力的入账"从 `intake` 里拆出来，改变入账的并发模型。
- **没批准时现状**：这三类读取失败只在日志里，不登记重查；读取恢复后只提示、不入账（计划第 35 点）。
- **最小形状**：`read-retry.ts` 的 `ReadFailure` 联合加 `{ type: "reconcile" }` 和 `{ type: "window", reason }`；`observer.reconcile` 与 `evidencePreflight` 的 catch 里调用 `onReadFailure`；`intake.ts` 拆出 `settleOnly(runId, assignmentId)`（不带 `repair.send`），`read-retry` 重查成功后调用它而不是只留提示。
- **影响的验收项**：AC11、AC13。
- **建议**：先于 B1。

### 建议的批准顺序

1. **B11**（事件压缩，高风险，越早做越安全）。
2. **B4**（取消/暂停/续办），然后 **B6**。
3. **B2 + B3**（预算统一与追加），才能证明 AC17 并给预算耗尽以出路。
4. **B12**，再 **B1**（重查恢复后自动继续；要 schema v3，注意回滚警告）。
5. **B10**（DTO 字段），**B5** 的测试部分。
6. **B7**（需要先确认宿主信号）、**B8**。
7. **B9** 最后。

## 我自己做的判断

- **T5c 新建 Run 引擎配置的默认值**（`shared/domain/run-engine/team-config-edit.ts` 的 `DEFAULT_ENGINE_LIMITS` 与 `defaultEngineBlock`）：并发 2；每任务 报告重发 2、证据退回 3、每层返工 2、实现尝试 6；每 Run 允许失败 3 个任务、协调者 12 回合；每个席位 12 个回合的预算（没有预算条目的席位会被判"预算缺失"而永远派发不出去，所以必须有）；证据目录 `auto`；DEV 目标留空；渠道留空让人填，不从 Profile 猜。这些数字是我按夹具和合同范围定的，只在人点开关新建配置时才会写进去，默认关闭。想改默认值：改 `DEFAULT_ENGINE_LIMITS`，测试里只有 `seatTurnBudget` 被断言。
- **T5a 重试用的"原因"文字**：服务端要求 `reason` 必填（1–600 字），确认框里不再让人输入，由类别生成"从 Runs 页确认重试（D3）"。想让人手写原因：在 `EngineControls.tsx` 的确认框加输入，`control-runner.ts` 的 `retry` 已经把 `offer.reason` 原样发送。
- **T5a/T5b 不按子类说明停下的原因**：决策 DTO 不带 `dedupeKey`，所以 D1 只能给"成员/判官停了或补报用尽"的合并说明。想分开要新字段，见 B10。
- **T2 暂停时 prepared 的意图保持 prepared**，结束或取消的 Run 里的 prepared 意图也不转 failed，只是永不发送（不写新事件）。想转 failed：在 `effects.ts` 的 `lifecycleMaySend` 为假时对 prepared 意图调用 `transitionIntent(..., "failed", "run-not-live")`，要同步改计划第 36 点。

## 遇到的问题与绕法

## 没做或没做完

## 每项的检查结果

- **T0**：biome 2 条既有警告，tsc 通过，vitest 174 个文件 2844 通过（3 todo），verify:package 通过。
- **T1**：只改文档，`git diff --check` 通过。
- **T2**：biome 仅 2 条既有警告；tsc 通过；vitest 174 个文件 2855 通过（3 todo，基线 2844 + 11）；verify:package 通过。变异检查 8 项（`mut-t2.mjs`）：两道防线同时去掉被抓（6 例失败）；只去快照防线存活（有意冗余，提交里的检查覆盖）；只去提交防线被抓；paused/finished/cancelled 各漏一个、`bootstrapping` 也停发、对账也停都被抓；还原后逐字节一致。
- **T3**：biome 仅 2 条既有警告；tsc 通过；vitest 174 个文件 2862 通过（3 todo，T2 后 2855 加 7）；verify:package 通过。变异检查 10 项（`mut-t3.mjs`）：R01、R02（普通报告去掉 anchor 复核、比较错的 anchor）、R03（补证链同时去掉两层）、R06 到 R10（effects 的复核与 continue 行为）都被抓；R04、R05 存活，原因是补证链里"补报集合与回执"的复核与 anchor 复核互为后备，只去 anchor 一层行为不变（R03 同时去掉两层就被抓），属有意冗余；还原后逐字节一致。
- **T5a**：biome 仅 2 条既有警告；tsc 通过；vitest 176 个文件 2929 通过（3 todo，T3 后 2862 加 67）；verify:package 通过。变异检查 21 项（`mut-t5a.mjs`）全部被抓到；还原后逐字节一致。没有在真实浏览器看布局（放在 DEV 阶段）。
- **T5b**：biome 仅 2 条既有警告；tsc 通过；vitest 177 个文件 2963 通过（3 todo，T5a 后 2929 加 34）；verify:package 通过。变异检查 14 项（`mut-t5b.mjs`）全部被抓到（座位拒绝原因那一项第一次存活，改测试后被抓）；还原后逐字节一致。
- **T5c**：biome 仅 2 条既有警告；tsc 通过；vitest 179 个文件 3005 通过（3 todo，T5b 后 2963 加 42）；verify:package 通过。变异检查 15 项（`mut-t5c.mjs`、`mut-t5c2.mjs`）全部被抓到；中途发现并修掉"刚启用的默认块被当作无法读取"的缺陷。
- **T5d**：biome 仅 2 条既有警告；tsc 通过；vitest 3016（T5c 后 3005 加 11）；verify:package 通过。变异检查 7 项（`mut-t5d.mjs`）全部被抓到。
- **T5e/T5f**：全量 vitest 182 个文件 3036 通过（3 todo，加 20）；biome 仅 2 条既有警告；tsc、verify:package 通过。变异检查 12 项加 1 项复查（`mut-t5ef.mjs`、`mut-t5ef2.mjs`）全部被抓到（`P05` 以未处理的拒绝使运行失败的方式被抓，脚本报 ERROR 但实际是失败）；中途 `P04` 存活，补测试后被抓。
- **T6b/T6c**：biome 仅 2 条既有警告；tsc 通过；vitest 183 个文件 3046 通过（3 todo，T5e/f 后 3036 加 10）；verify:package 通过。T6c 变异检查 3 项（`mut-t6c.mjs`：开关关闭时忽略 hook、跳过恢复、移除控制）全部被抓到。T6b 只写文档，没有行为变化；`readme-facts.test.ts` 防止 README 里的名字和数字与代码脱节。

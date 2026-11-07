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
| T5c Team 编辑器 runEngine | 未开始 | — | — | |
| T5d 启动对话框 | 未开始 | — | — | |
| T5e 刷新 | 未开始 | — | — | |
| T5f 响应式与断线 | 未开始 | — | — | |
| T6a 验收表 | 未开始 | — | — | |
| T6b 使用说明 | 未开始 | — | — | |
| T6c 关闭开关后的已有 Run | 未开始 | — | — | |
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

## 我自己做的判断

## 遇到的问题与绕法

## 没做或没做完

## 每项的检查结果

- **T0**：biome 2 条既有警告，tsc 通过，vitest 174 个文件 2844 通过（3 todo），verify:package 通过。
- **T1**：只改文档，`git diff --check` 通过。
- **T2**：biome 仅 2 条既有警告；tsc 通过；vitest 174 个文件 2855 通过（3 todo，基线 2844 + 11）；verify:package 通过。变异检查 8 项（`mut-t2.mjs`）：两道防线同时去掉被抓（6 例失败）；只去快照防线存活（有意冗余，提交里的检查覆盖）；只去提交防线被抓；paused/finished/cancelled 各漏一个、`bootstrapping` 也停发、对账也停都被抓；还原后逐字节一致。
- **T3**：biome 仅 2 条既有警告；tsc 通过；vitest 174 个文件 2862 通过（3 todo，T2 后 2855 加 7）；verify:package 通过。变异检查 10 项（`mut-t3.mjs`）：R01、R02（普通报告去掉 anchor 复核、比较错的 anchor）、R03（补证链同时去掉两层）、R06 到 R10（effects 的复核与 continue 行为）都被抓；R04、R05 存活，原因是补证链里"补报集合与回执"的复核与 anchor 复核互为后备，只去 anchor 一层行为不变（R03 同时去掉两层就被抓），属有意冗余；还原后逐字节一致。
- **T5a**：biome 仅 2 条既有警告；tsc 通过；vitest 176 个文件 2929 通过（3 todo，T3 后 2862 加 67）；verify:package 通过。变异检查 21 项（`mut-t5a.mjs`）全部被抓到；还原后逐字节一致。没有在真实浏览器看布局（放在 DEV 阶段）。
- **T5b**：biome 仅 2 条既有警告；tsc 通过；vitest 177 个文件 2963 通过（3 todo，T5a 后 2929 加 34）；verify:package 通过。变异检查 14 项（`mut-t5b.mjs`）全部被抓到（座位拒绝原因那一项第一次存活，改测试后被抓）；还原后逐字节一致。

# Run Engine 剩余工作计划（无人值守版）

编写：2026-11-08。基线：`main` 的 `5533722`，分支 `autonomous-p05-p08`（本 worktree）。
插件根目录：`paseo-agent-team/`。主计划与实施记录：`docs/run-engine-iteration-plan.md`（第 8 节 P04 行是一个超长表格单元，记录编号已到第 34 点，**下一条是 35**）。

## 0. 已经做完的（不要重做）

| 项 | 提交 | 说明 |
| --- | --- | --- |
| P06 最小可用集 | `a69c64e` | `agent-team.run.replan` / `run.decide`（仅 `retry`）/ `run.kick` 三个 RPC，`recover` 运行 outbox |
| P05 小项 | `c27fd80` | 接纳 DAG 时解决告警、协调者补报文本 v2（带期望类型） |
| 补证 + 台账 schema v2 | `957e759` | 新 Run 写 v2，双读 v1/v2；证据被退回后同一次尝试内补证（`assignment.evidenceRepair`） |
| P05 S1 | `5533722` | 宿主读取抛错后有限重查（1/2/4 秒），只读，只提示 |
| 文档第 33、34 点 | `00e710c`、`7f2c8c3` | |

基线检查：`biome` 只有 2 条既有警告（`tests/run-core/r01g-core.test.ts`），`tsc` 通过，`npm test` 174 个文件 2844 通过（3 todo），`npm run verify:package` 通过。

## 1. 规则（先读完再动手）

### 1.1 你在哪里工作
- 只在本 worktree 里改文件：`C:\Users\cc\.paseo\worktrees\1ku6d0d9\autonomous-p05-p08`（分支 `autonomous-p05-p08`）。
- **绝不**修改、切换分支或提交主工作区 `F:\tools\paseo-agent-team`，**绝不**动 `main`。**不推送**，不合并，不 rebase 到别的分支，不删除别的分支或 worktree。
- 开始时给 worktree 接上依赖：`New-Item -ItemType Junction -Path <worktree>\paseo-agent-team\node_modules -Target F:\tools\paseo-agent-team\paseo-agent-team\node_modules`（PowerShell）。**删除目录前必须先摘掉这个 junction**（`cmd /c rmdir <junction>`），不要对含 junction 的目录做递归删除，否则会删掉主工作区的 `node_modules`。

### 1.2 安全约束（`paseo-agent-team/AGENTS.md`，违反即停）
- **绝不**对默认 host 或 `~/.paseo` 做插件 install/reload/enable/disable/update/remove；**绝不**运行裸 `paseo reload|restart|daemon stop|daemon restart`。
- 运行时验证只能用 DEV：`<worktree>\paseo-agent-team\.paseo-dev`，每条命令显式带 `--home`/`--host`，并设置 `PASEO_HOME`。不复制真实账号的 Profile 或凭据。DEV 验证是**可选的最后阶段**（见第 5 节），做不下去就跳过。

### 1.3 提交
- 在分支上提交，**不需要问用户**，但每个任务的代码和测试合成一个提交，文档（计划记录、笔记）另一个提交。提交信息写英文，说清楚做了什么、没做什么，末尾加：`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。用 `git commit -F <文件>`，文件放系统临时目录。
- 每次提交前必须全部通过：`npx biome check .`（只允许那 2 条既有警告）、`npx tsc --noEmit -p .`、`npm test`、`npm run verify:package`。`version-flow`、`ledger-real-fs` 在并行时偶发 Windows `EBUSY`，单独重跑通过即可，不算失败。
- 改文件保留原有 CRLF/LF（目前源码都是 LF）。
- 每个有行为变化的任务要做**变异检查**：临时破坏实现，确认对应用例失败，再还原。模板脚本在 `C:\Users\cc\AppData\Local\Temp\p05-mutation\`（`run-s1.mjs` 是 18 项的例子，写成"文件、被替换的原文、替换成什么、跑哪些测试"的列表，跑前先备份被改文件，跑完逐个 `cmp` 确认已还原）。一道防线有多层时，只破坏一层不会被抓到，要同时破坏几层，并在记录里写明。
- 计划第 8 节 P04 行追加记录用 `C:\Users\cc\AppData\Local\Temp\p05-mutation\append-point-34.mjs` 改编（把里面的 33/34 换成上一条/下一条的编号，文本放单独的 `plan-point-NN.md`，单行、无竖线、反引号与粗体配对）。一次只追加一条，`git diff` 必须只改一行。

### 1.3.1 需要批准的东西：不要做，记下来，继续往下做
下面这些改动**必须用户批准**，遇到就**不要实现在主线分支上**，也**不要停下来问**。照第 4 节的格式写进 `docs/autonomous-notes.md` 的"待批准"，然后做下一项：
- 改 schema（`ledger.ts`、`protocol.ts`、`config.ts`、`rpc.ts` 里已有的形状）、reducer 事件词汇、台账字段（包括新增透传字段的约定）、新增或注册 RPC、新的 schema 版本；
- 新增或修改提示词模板（已有版本的字节永远不能变；新版本也算需要批准，除非本计划明确写了要做）；
- 默认开启 `PASEO_AGENT_TEAM_RUN_ENGINE`、版本号与发布、`CHANGELOG`；
- 任何会让 DEV 之外的真实环境、模型额度被大量消耗的事。
拿不准某一项算不算时，按"需要批准"处理。

### 1.4 Windows 环境的坑（都踩过）
- shell 默认没有 node：Bash 里先 `export PATH="/e/Program Files/nvm/v24.18.0:$PATH"`。
- **绝不运行 `python` / `python3`**：Windows 应用商店的占位程序会一直等输入，把工具卡死。需要脚本就用 node，脚本文件放系统临时目录，用 Write 工具写。
- Bash 里 heredoc 含 `\n` 的内容会被转成真换行；改源文件用 Edit/Write 工具，不要用 shell 拼。
- 前台命令超过约 2 分钟会被转到后台：长命令（全量 `npm test`、变异检查）用 `run_in_background`，等通知；命令里套 `timeout`，输出写文件再读。单个工具调用卡住超过几十分钟时放弃它，换个做法。
- `vitest` 全量约 80–110 秒。`biome` 格式问题用 `npx --no-install biome check --write <文件>` 自动修。

### 1.5 工作方式
- 用中文写笔记和最终汇报；代码注释和提交信息用英文，沿用仓库风格。
- **不要用 AskUserQuestion**，用户在休息。不要启动 Opus max 的子会话（额度紧）；需要时自己读代码、自己设计。可以另开只读的小子会话做复核，但不是必须。
- 一个任务三次尝试仍过不了检查：撤销该任务在工作区的未提交改动（只在本 worktree 里），记进笔记"未完成与原因"，做下一项。
- 环境彻底坏了（工具反复卡死、额度耗尽等）：把进度写进笔记并提交，然后结束并汇报，不要空转。
- 每完成一个任务就更新 `docs/autonomous-notes.md` 的进度表并提交，这样中断时用户也能看到做到哪了。

## 2. 任务清单（按这个顺序做）

状态用 ☐ 未做 / ☑ 已做。每项写明验收；"不做"的写在第 3 节。

### T0 准备
☐ 接上 `node_modules` junction；跑一遍基线检查，把数字写进笔记；创建 `docs/autonomous-notes.md`（用本分支里已有的模板文件，不要改它的结构）。

### T1 计划第 35 点：S1 的实施记录
☐ 在计划第 8 节 P04 行追加第 35 点，写：S1 做了什么（`readRetries` 块、1/2/4 秒、先落账再读、单个最近到期定时器、只读、只写一条提示告警、`read-retry-changed` 审计事件、`server/run-engine/read-retry.ts` 与 `shared/domain/run-engine/read-retry.ts`）；测试（`read-retry.test.ts` 17 例、`read-retry-server.test.ts` 15 例、`driver.test.ts` 4 例端到端、`start.test.ts` 一条断言，全量 2844 通过）；18 项变异检查全部被抓到（S08 第一次存活，补了"Run 在等待期间结束"的用例）；**限制**：只提示不恢复、仍需人 kick；对账路径与不完整窗口、补证发送前复核的读取失败不登记；每个读不到的席位各登记一项；没有在 DEV 验证；**对后续的约束**：S2 需要 schema v3，旧 v2 程序读 v3 同样会阻断所有 Run 的资源授予。
验收：`git diff` 只改一行；提交为文档提交。

### T2 暂停、结束的 Run 不再发送（AC14 的一部分，不改合同）
现状：`driver.ts` 在 `settleWaiting` 里只跳过 `launch.state` 为 `failed`/`cancelled` 的 Run，`effects.sendPrepared` 不看生命周期，所以 `paused` 的 Run 里已经 `prepared` 的消息仍会被发出。
做法：`effects.runOutbox` 在 Run 的 `lifecycle` 是 `paused`、`finished`、`cancelled` 时**不发送** `prepared` 的意图（`bootstrapping`、`awaiting-dag`、`active` 照常，因为计划请求就是在 `bootstrapping` 里发的）。**只读的核对仍然做**：把 `sending` 转 `outcome-unknown`、按回显确认未知投递，不重发。恢复到 `active` 后原来 `prepared` 的消息只发一次。
测试：暂停时 prepared 的派发/补报/计划请求都不发；暂停时未知投递仍能按回显确认；恢复后只发一次；结束的 Run 不发。变异检查。
验收：全部检查通过；记录为计划第 36 点（若与后续任务合并成一次提交，用一条记录）。

### T3 入账与发送前的"来源仍是最新"复核（加固，不改合同）
来源：独立可达性复核（`C:\Users\cc\AppData\Local\Temp\p05-evidence-gpt61\reachability.md`，可读）。已确认的薄弱点：`observer.inspectReport` 成功分支已返回读取用的 `anchor`，但普通成员报告的入账提交里没有比较它是否仍是最新的回复锚点；`effects` 在 `prepared` 变 `sending` 时不再核对补报是否还有资格。补证链内已经做了，**普通路径没有**。
做法：
1. `intake.settleAssignment` 的提交里，对所有报告要求 `replyAnchor(current, assignment) === inspected.anchor`，否则丢弃这次读取，什么都不写（结果当作 `stale`，不要报错）。
2. `effects.sendPrepared`：`purpose: repair` 的 wake 在 `prepared` 变 `sending` 的同一次提交里核对"这个 assignment 仍在等报告（开放且没有已接受的证明）"，否则把意图转 `failed`（原因 `superseded-before-send`），不发送。
测试要用真实 store，并构造竞态：读取窗口的假宿主在被读时先往账本里写一条更新的已发补报，再返回旧回复，断言入账不写任何东西；`prepared` 补报在 assignment 先收到证明后不被发出。补一条覆盖"补证链内 anchor 复核"的用例（上次变异检查 M10 没覆盖）。变异检查。
验收：全部检查通过；记录为计划第 37 点（或合并）。

### T4 `creating` 阶段崩溃后的续办
现状：`startEngineRun` 创建成员用 `engine:<runId>:seat:<seatId>` 作幂等键，崩溃后重启看到 `launch.state === "creating"` 的 Run 没有任何续办，只有失败记录。
先读 `server/run-engine/start.ts`、`shared/domain/run-engine/run-record.ts`（`bindSeatAgent`、`setLaunchState`、`launch.seatProfiles`、`launch.systemPrompts`、`launch.workspace`）。**判断：重建 `CreateMemberInput` 所需的信息是否都已经冻结在记录里。**
- 都在：实现 `resume`（放在 `driver.recover` 能调用的位置）：对 `creating` 的 Run，给还没有 `agentId` 的启用席位用同一个幂等键再创建，绑定后继续到 `kickoff-pending`，由现有 outbox 发计划请求。创建结果不明就用同键再问一次（沿用 `startEngineRun` 的重试），耗尽记 `failed` 并按偏好归档。测试：在第 k 个成员创建前后崩溃（假适配器），重启后不多出第二个 Agent，计划请求只发一次；`failed`/`cancelled` 的 Run 不续办。变异检查。
- 缺：不要硬凑。写进"待批准"（要冻结哪些新字段、最小形状），本项记为未完成。
验收同上；记录为计划第 38 点。

### T5 P07 界面（客户端，沿用现有 RPC 与 DTO，不新增字段）
先读 `client/runs/engine/*`、`client/teams/TeamEditor.tsx`、`client/launch/*`、`shared/zh/run-engine.ts`、已有的客户端测试。**不能用到的东西**（新字段、新 RPC、服务端推送）一律走第 3 节，不要做。分成可独立提交的几块，每块一个提交：
- **T5a Runs 页的控制**：在 Engine 的 Run 详情里加三个控制：
  - 重新规划（`supportedControls` 含 `replan` 时可用）：必填原因输入，`requestId` 用 UUID，`expectedRevision` 取当前版本；
  - 对有 `actions` 含 `retry` 的决策加"重试"按钮，按决策种类（质量失败 D3/D4、`stuck:` 成员或判官阻塞、补报用尽）显示一段说明"重试会做什么"，并要求确认；
  - 手动 kick（`supportedControls` 含 `kick`）。
  所有返回的 issue 码（见 `shared/schemas/run-engine/rpc-actions.ts` 的 `RUN_ACTION_CODES`）都要有中文文案；`revision-conflict` 要自动重新读取并提示再试；`replayed` 提示"已经提交过"；按钮在请求期间禁用，避免重复点击。控制按钮必须由 `supportedControls`/`actions` 门控，不能自己猜。
  把页面上"只读观察"的文案按实际能力改掉（`capabilities.observationOnly` 是 DTO 里的固定值，**不改服务端**，客户端不要再据此显示"只读"）。
- **T5b "为什么在等、谁来解除、下一步由什么触发"**：写一个纯函数（放 `shared/` 或 `client/runs/engine/` 里，沿用现有分层）把任务/决策/告警映射成 `{ why, who, next }`。**必须表驱动并用测试穷举**：从服务端源码里收集所有会写进 `waitingReason` 的原因码（`dispatch-blocked:*`、`waiting-for-seat:*`、`report-repair-requested:*`、`report-missing`、`report-rejected:*`、`report-refused:*`、`report-ownership:*`、`report-repair-budget-exhausted`、`evidence-send-waiting`、`evidence-send-outcome-unknown`、`evidence-not-repairable`、`evidence-return-limit`、`retry-approved` 等，用 grep 找全），新增一个原因码而没写映射时测试要失败。再加一条按事件 kind 排的"因果时间线"（只用历史 DTO 里已有的 kind，新 kind 缺映射时回落到通用说明，不要报错）。
- **T5c Team 编辑器的 `runEngine` 配置界面**：启用开关、席位（层级、职责、渠道，来自 Team 成员）、策略字段，校验用现成的 `RunTeamEngineConfigSchema`，并实时显示 `engineLaunchGate` 的阻断和警告（B 层与 A 层独立审查席位、Codex 非 full-access 等）。保存走现有 Teams 设置写入路径，**不得丢失 `runEngine` 里不认识的字段**（有往返测试）。
- **T5d 启动对话框**：`kickoff-pending` 的文案（计划请求已提交、正在发送、可能需要几分钟）；预览里显示 Engine 阻断与警告。
- **T5e 刷新**：保持轮询，但页面不可见时暂停轮询；`unchanged` 时不重绘。服务端推送式失效属于第 3 节，不做。
- **T5f 响应式与断线**：检查小屏布局代码（窄屏时详情不溢出、按钮可点），断线重连后不闪成空进度（已有 `get-session` 纯函数测试，补用例）。真实浏览器检查放到第 5 节。
每块都要有测试（纯函数、状态合并、文案映射），并通过全部检查。记录为计划第 39 点起（每块一条或合并一条）。

### T6 P08 文档与验收表（只写文档，不改行为）
- **T6a** `docs/run-engine-acceptance.md`：把计划第 7 节 AC01–AC22 逐项落成表：编号、必须观察到的结果、证据（测试文件与用例名，或计划第 8 节的第几点 DEV 记录）、状态（已覆盖/部分/未覆盖/需 DEV）、缺口。**如实写，不要凑**：AC12（权限等待）、AC13/AC21（退避与到期）、AC14（取消/暂停/续办）、AC17/AC18（零模型调用、不唤醒战略协调者）、AC20（用户绕过 Engine 发消息）、AC22 已知覆盖不全，写明缺什么、对应第 3 节哪一项。每个"已覆盖"的引用都要用 grep 验证测试确实存在。
- **T6b** 使用说明写进 `paseo-agent-team/README.md`（先看它现在的语言和结构，沿用）：怎么启用（`PASEO_AGENT_TEAM_RUN_ENGINE=1` 加 Team 的 `runEngine`）、它做什么与不做什么、Runs 页的三个控制、恢复与限制（schema v2：回滚到旧版本会让所有 Run 的新资源授予被阻断；补证被 blocked 后的出路；v1 活动 Run 不迁移）、数据位置、"关闭启用入口后已有 Run 仍可观察和收敛"。**不要改版本号和 `CHANGELOG`**（走发布机制）。
- **T6c** 一条测试：环境开关关闭（不能新建 Engine Run）时，台账里已有的 Engine Run 仍能被 `recover`/`kick` 推进，只读查询照常。
- **T6d** 计划第 8 节 P05–P08 行的状态列从"未开始"改成"实施中"，并指向 P04 行里相应的点；第 9 节完成条件的勾选**不动**（交给用户）。核对仓库里没有临时产物（`.playwright-mcp/`、探针脚本、日志）。
验收：`git diff --check`、相对链接与引用路径核对；提交为文档提交。

### T7 机动项（时间够再做，每项独立）
- **T7a 取消的引擎内部能力**（不注册 RPC）：reducer 已有 `cancel-requested`、`cancellation-checked`、`run-cancelled` 事件和 D1 `cancel:<任务>` 决策。在 `server/run-engine/` 里写一个 `cancel.ts`：构造取消请求（含 outbox 的 `archive` 意图）、对在途 assignment 取静止证据（`refresh` 加匹配的 `turn_ended` 回执）并喂给 `cancellation-checked`、只有证明静止后才释放占用。**不暴露给用户**：RPC 注册走第 3 节 B4。完整的状态机与并发测试，变异检查。若发现必须改 reducer 词汇或台账字段才能做，停下，写进待批准。
- **T7b 暂停的引擎内部能力**：同上，`run-paused`/`run-resumed` 的引擎侧入口（函数 + 测试），RPC 不注册。T2 已经让暂停不发送。

## 3. 本轮不做、只写提案的（"待批准"清单的种子）
每一项在 `docs/autonomous-notes.md` 里写：为什么需要批准、不做的话现状是什么、建议的最小形状（具体到文件、字段、事件）、对哪些验收项有影响、建议的批准顺序。**可以另开一个只读的小会话帮忙写提案，但不要把提案实现在主线分支上。**

- **B1** P05 S2：重查成功后首次派发，需要 schema v3（旧 v2 程序读 v3 会阻断所有 Run 的新资源授予）和限定意图的发送入口。
- **B2** P05 S3：统一模型预算（计划请求、replan、补报都预扣，协调者席位预算条目），涉及 `budgets.reservations`。
- **B3** `increase-budget`：预算耗尽开 D4 决策、`decide` 的 answer 联合加变体。
- **B4** 取消、暂停、续办的 RPC：注册 `run.control` 子集或新的窄 RPC；`run.approve`、`run.reconcile`、`run.export`。
- **B5** 权限等待（AC12）：引擎永不代答权限；怎么检测（`pendingPermissions`、`permission_requested/resolved` 钩子）、任务进入什么状态、谁来解除。可能需要台账字段。
- **B6** 冻结任务的出路：`reject`/`cancel`/`assign-seat` 决策动作（reducer 词汇），包括补证被 blocked 后、判官"回合结束没有可用报告"。
- **B7** 派发之后的临时失败自动重试：需要宿主"失败发生在任何工具执行之前"的证据，加 `execution-retry-admitted` 事件。
- **B8** 客户端的服务端推送式失效（替代轮询）。
- **B9** 默认开启 Engine 的策略、灰度、版本号与发布。
- **B10** 界面想要的新 DTO 字段（下次重试时间、结构化的"为什么在等"）。
- **B11** 事件压缩：账本 `events` 上限 8192、Engine 还没实现压缩（检查点），长 Run 会写满。风险较高，建议高优先级批准。
- **B12** S1 的扩展：对账路径、不完整窗口、补证发送前复核的读取失败也登记重查；读取恢复后自动入账（需要把"无发送能力的入账"拆出来）。

## 4. 笔记格式（`docs/autonomous-notes.md`）
- **进度表**：任务编号、状态、提交 SHA、测试数、一句话。
- **待批准**：`编号｜标题｜为什么需要批准｜没批准时现状｜最小形状（文件/字段/事件）｜影响的验收项｜建议`。
- **我自己做的判断**：用户回来后可能想改的决定，写明理由和怎么改回去。
- **遇到的问题与绕法**。
- **没做或没做完**，写明原因。
- **每项的检查结果**：biome/tsc/测试数/verify:package/变异检查列表。
每次更新后提交（文档提交）。

## 5. 最后阶段：DEV 真实验证（可选，最后做）
只在 T1–T6 都完成、且时间和额度还够时做。**不做也没关系**，写进笔记即可。规则：只用 worktree 里的 `.paseo-dev`，显式 `--home`/`--host`，设置 `PASEO_HOME`，清掉代理环境变量（见 `C:\Users\cc\AppData\Local\Temp\agent-team-handoff\briefing-p06.md` 的"DEV 环境"一节，里面有 Profile、Team、探针仓库的做法）；DEV daemon 的 Windows `EPERM rename` 是 daemon 缺陷，约三分之一启动作废，遇到就重试，最多 3 次，仍不行就跳过。模型调用总量控制在：最多 4 个 Run。结束必须清理（归档 DEV 里建的 Agent、删探针仓库与临时目录、`daemon stop --home`）。
可验证的内容：补证模板是否被真实模型遵守；`replan` 的 v4 提示词；判官重派；重启后 `kick`；S1 在真实宿主上的重查。结果各写一条计划记录（如实写样本数）。

## 6. 完成时
更新笔记的进度表和"待批准"，提交；最终回复里给出：分支名、提交列表、每项的测试数、待批准清单的标题、没做完的项。

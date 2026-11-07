# 已批准项的实施清单（A1–A12）

编写：2026-11-08，Opus 5.5 裁决会话（只裁决、不实施）。裁决与理由：`docs/autonomous-notes.md` 的"裁决"一节。
分支：`autonomous-p05-p08`（本 worktree）。插件根目录：`paseo-agent-team/`，下文路径都相对它，`docs/` 除外。
任务 A1–A11 按实施顺序排列，每个都能单独提交；A12（DEV）可选。B9 不在这里：它只有建议，留给用户。

## 0. 所有任务共同的规则

### 0.1 工作方式
- 沿用 `docs/remaining-work-plan.md` 第 1 节：只在本 worktree 里改和提交；不碰主工作区与 `main`；不推送；不对默认 host 或 `~/.paseo` 做任何插件操作；不运行 `python`；Bash 里先 `export PATH="/e/Program Files/nvm/v24.18.0:$PATH"`；改源文件用 Edit/Write；长命令放后台并套 `timeout`。
- 每个任务两个提交：**代码 + 测试**一个，**文档**一个（计划第 8 节 P04 行追加一条记录，从**第 44 点**起每个任务一条，用 `C:\Users\cc\AppData\Local\Temp\p05-mutation\append-point-34.mjs` 改编，`git diff` 只改一行；`docs/autonomous-notes.md` 进度表加一行；验收表 `docs/run-engine-acceptance.md` 里证据变了的行一起改，`acceptance-doc.test.ts` 会核对引用）。
- 每次提交前全部通过：`npx biome check .`（只允许 `tests/run-core/r01g-core.test.ts` 的 2 条既有警告）、`npx tsc --noEmit -p .`、`npm test`、`npm run verify:package`。`version-flow`、`ledger-real-fs` 并行时的 Windows `EBUSY` 单独重跑通过即可。
- 有行为变化的任务做**变异检查**：每个任务下面列了必做点；跑前备份、跑完逐个 `cmp` 确认还原；一道防线有多层时同时破坏几层，并在记录里写明哪些存活是有意冗余。
- 一个任务三次尝试仍过不了检查：撤销它在本 worktree 的未提交改动，记进笔记"没做或没做完"，做下一项（依赖它的任务一并跳过）。
- 提交信息英文，末尾带当时规则要求的 `Co-Authored-By` 行。

### 0.2 合同规则（本批全部任务都适用）
1. **不升 schema 版本**：`RUN_SCHEMA_VERSION` 保持 2，`RUN_SUPPORTED_SCHEMA_VERSIONS` 保持 `[1, 2]`。新存的东西只允许三类：已有的可选字段（`checkpoint`）；已有数组里的新条目（`events`、`alerts`、`decisions`、`budgets.entries`）；带独立版本化读取器的透传块（只有 A5 的 `cancelRequest`，写法照 `shared/domain/run-engine/read-retry.ts` 的 `readReadRetries`）。旧程序对透传块原样保留（存储容忍未知字段）。
2. **双读与旧字节**：每条新的写路径都要在 v1 与 v2 两种记录上各跑一次，断言 `schemaVersion` 不变、本次没碰的字段逐字节不变，照 `tests/run-engine/ledger-versions.test.ts` 的写法。
3. **不改提示词模板**：本批没有任何任务需要改模板。实施中觉得要改，就停下写进笔记"待批准"，不要做。
4. **写操作的形状**（照第 33 点）：一次 `store.update`；提交前 `checkLedgerInvariants`；拒绝是 `status: "rejected"` 加一条带稳定编码的 issue，不抛错；检查顺序固定为**先找重复（replay）→ 再查 `expectedRevision`（严格相等）→ 再查前置条件**；提交之后用 `driver.retryRun(runId, { afterWrite: true })` 在后台推进，推进失败只记日志。
5. **文案穷举**：新的拒绝码进 `shared/schemas/run-engine/rpc-actions.ts` 的 `RUN_ACTION_CODES`；新的审计事件 kind、`waitingReason` 原因码都要有中文（`shared/zh/run-engine.ts`、`shared/zh/run-engine-waiting.ts`）。`tests/run-view/controls.test.ts`、`tests/run-view/waiting.test.ts` 的穷举会在漏写时失败，不要削弱这两个扫描。
6. **控制由服务端声明**：`server/run-engine/projection.ts` 的 `supportedControlsOf` 按 Run 当前状态给出名字；客户端 `shared/domain/run-engine/controls.ts` 的 `controlsOf` 只按它画按钮。每加一个控制，`RUN_ACTION_CONTROLS` 加一个名字（列表的 `capabilities` 用它，见 `server/run-engine/queries.ts`）。
7. **永不代答权限、不发打断消息、不归档成员**：本批没有任何任务需要这三件事。
8. **结果不确定就冻结并核对，不重发**；决定只生效一次。
9. **RPC 计数**：`tests/server-entry.test.ts` 现在是 24 个；A3 后 26，A5 后 27，A6 后 28。`tests/server-entry-engine.test.ts` 为每个新 RPC 断言接到了自己的方法；`tests/run-engine/rpc-actions.test.ts` 继续断言仅有形状的 `run.control` / `run.approve` / `run.reconcile` 没有注册。

### 0.3 顺序与依赖

| 任务 | 来自 | 依赖 | 影响的验收项 | 发布约束 |
| --- | --- | --- | --- | --- |
| A1 事件压缩与容量保护 | B11 | — | AC15、AC22 | — |
| A2 reducer：已授权的取消释放占用 | 新发现 R1 | — | AC10、AC14 | 必须早于或同时于 A4、A5 |
| A3 暂停与续办 RPC | B4a | — | AC14 | 与 A5 同一版本发布 |
| A4 决策答复 `cancel` | B6 | A2 | AC03、AC10、AC14 | — |
| A5 延迟取消整个 Run | B4b | A2、A3、A4 | AC10、AC14、AC17 | 与 A3 同一版本发布 |
| A6 追加预算 RPC | B3 | — | AC13 | — |
| A7 读取重查扩面与自动继续 | B12 + B1 | — | AC11、AC13、AC21 | — |
| A8 启动中断后关闭并告警 | B13a | — | AC06、AC14 | — |
| A9 测试补强：权限等待与空闲零调用 | B5 + AC17 | 最好在 A3、A5 之后 | AC12、AC17 | — |
| A10 决策的 `kind` 字段 | B10（缩小） | A4 | AC22 | — |
| A11 协调者回合预算（可选） | B2（缩小） | A6 | AC13 | — |
| A12 DEV 验证（可选） | — | 前面做完的任务 | 多项 | — |

---

## A1 事件压缩与容量保护（B11）

**目标**：长 Run 不会因为 `events` 写满 8192 条或记录超过 8 MiB 而所有提交失败；压不下来时停止新派发，让在途工作能收尾。

**为什么不需要升版本**（已核对）：`RunRecordSchema` 早有可选的 `checkpoint`（`RunHistoryCheckpointSchema`）；不变式 I1 允许事件从 `checkpoint.throughSeq + 1` 开始连续；I6 只做下限检查；`transitions.cancellationAuditValid` 对压缩前缀里的戳直接信任；`projection.encodeHistoryCursor` 已经把游标绑在 `checkpoint.throughSeq` 上；`tests/run-core/r01g-behavior.test.ts` 的 `compact()` 帮助函数清空全部事件后不变式仍通过。旧程序能读压缩后的记录。

**改动**
- 新增 `shared/domain/run-engine/compaction.ts`（纯函数，不引入 Node 模块）：
  - 常量：`COMPACT_EVENTS_AT = 6144`、`COMPACT_KEEP_NEWEST = 2048`、`CAPACITY_REFUSE_AT = 7680`（`events`、`eventReceipts`、`nonceRegistry` 共用）、`CAPACITY_REFUSE_AT_4096 = 3840`（`assignments`、`outbox`）、`CAPACITY_WARN_AT = 6144`（`eventReceipts`、`nonceRegistry` 只告警）。都要能经选项注入，测试用小数字。
  - `planCompaction(record, { bytesHigh, compactAt?, keepNewest? }): { throughSeq: number } | null`。规则：`events.length < compactAt` 且 `!bytesHigh` 时为 null；`floor` = 状态为 `assigned` 或 `in_progress` 的 assignment 里最早的 `Date.parse(createdAt)`，没有则为正无穷；从最老的事件往新走，只要 `Date.parse(event.at) < floor` 且 `seq <= lastSeq - keepNewest` 就纳入，遇到第一条不满足的就停（时钟回拨时也只取连续前缀）；得到的 `throughSeq` 必须大于现有 `checkpoint?.throughSeq ?? 0`，否则 null。
  - `applyCompaction(record, { throughSeq, historyDigest, now }): RunRecord`：复制记录；`events` 只留 `seq > throughSeq` 的；`checkpoint = { throughSeq, historyDigest, counters: structuredClone(record.counters), acceptedNonceDigests: 旧 checkpoint 的原样保留（本轮为 []）, terminalAssignmentIds: 状态为 ended/cancelled/failed 的 assignment id 排序后取前 4096 }`；在末尾追加一条审计事件 `history-compacted`（`payload: { throughSeq, removed }`，`seq = eventsThroughSeq + 1`，同时更新 `counters.eventsThroughSeq`）；`updatedAt = now`。
  - **绝不改** `eventReceipts`、`nonceRegistry`、`assignments`、`outbox`、`decisions`、`alerts`（`isNormalEnded`、`isComplete167`、`actorSettledBy` 对每个 assignment 都要找到它的 `turn_ended` 回执，包括已结束的）。
- 新增 `server/run-engine/compact.ts`：`createCompactor({ store, clock, log, limits? })`，`compactIfNeeded(runId, { bytesHigh })`：在一次 `store.update` 里调 `planCompaction`，计算 `historyDigest = sha256Hex(JSON.stringify({ previous: record.checkpoint?.historyDigest ?? null, events: 被压掉的事件 }))`（`server/run-engine/digest.ts`），`applyCompaction`，提交前 `checkLedgerInvariants`，不通过就不写并记日志。压缩是**单独的一次提交**，不和别的写操作合并。
- `server/run-engine/driver.ts`：`pass(runId)` 一开始调 `compactIfNeeded`（失败只记日志，不挡这一遍）；`bytesHigh` 取最近一次 `store.get`/`update` 结果里的 `needsCompaction`。`recover()` 里每个 Run 也先调一次。
- 容量保护：`server/run-engine/service.ts` 的新派发（新任务、返工、判官、补证请求）在 `events`、`eventReceipts`、`nonceRegistry` 任一 ≥ 7680，或 `assignments`、`outbox` 任一 ≥ 3840，或 `alerts`、`decisions` 任一 ≥ 960（上限 1024），或读到的 `needsCompaction` 在压缩之后仍为真时，返回 `blocked`，原因 `ledger-capacity`（driver 记成 `dispatch-blocked:ledger-capacity`）；报告格式补报、补证链里的补报、入账、按回显确认照常（它们是收尾）。同时写一条 critical 告警（固定文本，用 `alertIdFor` 去重）："台账接近容量上限，已停止新的派发；进行中的工作会继续收尾。"；`eventReceipts` 或 `nonceRegistry` ≥ 6144 时写一条 warning 告警。
- `shared/schemas/run-engine/rpc.ts`：`RunHistoryPageSchema` 加 `compactedThroughSeq: z.number().int().nonnegative().optional()`（输出是非严格对象，旧客户端会剥掉）。`projection.historyPage` 在有 `checkpoint` 时填上。客户端历史区在最后一页（`nextCursor === null`）且有这个值时显示"更早的 N 条历史已压缩"。
- 中文：`history-compacted` 事件、`dispatch-blocked:ledger-capacity` 原因。

**行为规则**
- 压掉的 replan `requestId` 再提交时，`replan.priorRequest` 找不到它，会继续查版本并得到 `revision-conflict`（`expectedRevision` 严格相等，不会二次生效）。这是可接受的退化，要有用例；A3、A6 靠审计事件去重，同样如此（A5 把 `requestId` 存在 `cancelRequest` 里，不受压缩影响）。
- 压缩不改变任何任务、占用、预算、决策的状态。

**测试**
- `tests/run-engine/compaction.test.ts`（纯函数）：阈值以下不压；到阈值压；至少留最新 `keepNewest` 条；最早未结束 assignment 的 `createdAt` 及之后的事件一条不压；时钟回拨时只取连续前缀；`eventReceipts`、`nonceRegistry`、`assignments`、`outbox` 前后深相等；`checkpoint` 各字段；第二次压缩的 `historyDigest` 依赖第一次（换掉前一个摘要结果就变）；压缩后 `checkLedgerInvariants` 通过；压缩前后对一个在途 assignment 的 `canCancelLocally` 结果相同；压缩前缀里的本地撤回戳 `cancellationAuditValid` 仍为真；被压掉的 replan `requestId` 重提得到 `revision-conflict` 且不写；`history-compacted` 审计事件。
- `tests/run-engine/compaction-store.test.ts`（真实 store）：事件超过阈值的 Run 在下一遍 `pass` 里被压缩（修订号 +1，只多这一次提交）；CAS 冲突时不写；字节阈值（注入小的 `softBytes`）触发；容量保护：把回执数注入到阈值，派发得到 `ledger-capacity`、告警只写一次、在途报告仍能入账；v1 与 v2 记录压缩后 `schemaVersion` 不变、其余字段逐字节不变。
- `tests/run-engine/queries.test.ts` 补：历史页带 `compactedThroughSeq`；压缩前拿到的游标失效并从最新页重来（已有行为的回归）。
- **回滚演练（手工，结果写进记录）**：用 `git show 1811b0f:paseo-agent-team/<路径>` 把旧版 `shared/schemas/run-engine/ledger.ts`、`shared/domain/run-engine/invariants.ts`、`server/run-engine/projection.ts` 取到仓库外的临时目录，读一份压缩后的记录：解析通过、不变式通过、历史页正常。临时目录用完删掉（有 junction 先摘）。

**变异检查（必做）**：去掉 `floor` 规则；去掉 `keepNewest`；把 `eventReceipts` 也一起压；摘要不串前一个；阈值 `>=` 改 `>`；去掉容量保护；容量保护把补报也挡住（应被"在途报告仍能入账"抓到）；历史页丢掉 `compactedThroughSeq`。

**验收**：全部检查通过；压缩只发生在单独的提交里；任何时候 `eventReceipts` 不减少；第 44 点记录写明阈值、边界规则、回滚演练结果。

**风险与回滚**：压掉的历史只剩摘要链，不可恢复；边界算错会让本地撤回误判（由用例与变异检查守住）。回滚到旧版本：能读，历史页更短，旧 replan 重提得到 `revision-conflict`。

---

## A2 reducer：已授权的取消释放占用（新发现 R1）

**问题**（只读探针已证实，探针在 `%TEMP%\b-rulings\probe\cancel-probe.test.ts`，仓库外）：生产者报告 `blocked` 或 `failed`、回合已正常结束、任务仍持有占用时，`cancel-requested` 只会把任务冻结并开一个 `cancelIntents: []` 的 D1 `cancel:<任务>`；`releaseIfSettled` 遇到空配对直接返回，`cancellation-checked` 也要求配对，所以这个占用永远放不掉，再取消一次也不变。不能改成"显式取消就立即释放"：`tests/run-core/r01g-behavior.test.ts` 的 "local withdrawal of a retry preserves the claim from its historical sent producer" 把"已发出的交付留下的占用不得被隐式释放"定成了设计。

**改动**（只有这一处）：`shared/domain/run-engine/reducer.ts` 的 `applyCancellation`，立即取消分支的条件从
`outstanding.length === 0 && !unsettledIntents(next, taskId) && 没有该任务的占用`
改成
`outstanding.length === 0 && !unsettledIntents(next, taskId) && (没有该任务的占用 || decisionAuthorization(next, taskId) !== undefined)`，
并且经授权释放时设 `task.releaseDecisionId = authorization.decisionId`。`decisionAuthorization` 就是文件里已导入的 `cancellationAuthorization`（D1 `cancel:<任务>` 已答复且动作为 `cancel` 或 `assign-seat`、`taskIds` 含该任务）。`dag-revised` 不会产生授权，所以不受影响。

已在仓库外的临时副本里试过这一处改动：`tests/run-core`、`tests/spec`、`tests/run-engine`、`tests/run-view` 与 `tests/run-engine-contracts.test.ts` 全部通过（598 + 925 例；两条读 `docs`/`README` 的测试因副本里没有这些文件而略过）。

**测试**：新增 `tests/run-core/cancel-release.test.ts`（照探针改写）：
1. blocked 与 failed 两种：未授权时冻结，D1 `cancel:<任务>` 为 open 且配对为空，占用冻结（把现状写成断言）；再取消一次仍冻结。
2. 把 D1 答复为 `cancel` 后再 `cancel-requested`：任务 `cancelled`、占用释放、`releaseDecisionId` 指向 D1、未接受的 nonce 被撤销、不变式通过。
3. 答复为 `resume-seat` 不算授权，仍冻结。
4. 已授权但有在途 assignment：仍走配对路径（`incomplete-coverage` 或冻结）。
5. 已授权但有未结效果（`outcome-unknown` 的派发且执行者未结算）：仍冻结。
6. `run-cancelled` 之后冻结的有占用任务，在 `cancelled` 生命周期里经授权的 `cancel-requested` 被释放。
7. 释放之后再发一次 `cancel-requested`：逐字节不变。
8. 原有的 "local withdrawal of a retry …" 用例不改，继续通过。

**变异检查**：去掉授权条件（"local withdrawal" 与用例 1 失败）；把 `resume-seat` 也当授权；去掉未结效果检查；不写 `releaseDecisionId`。

**验收**：全部检查通过；`git diff` 的生产代码只动 `applyCancellation`。

**风险与回滚**：只影响已授权的取消。不新增字段；新程序写出的"已取消、无占用、无配对"记录对旧不变式合法。

---

## A3 暂停与续办 RPC（B4a）

**改动**
- `shared/schemas/run-engine/rpc-actions.ts`：
  - `RUN_ACTION_CONTROLS` 加 `"pause"`、`"resume"`。
  - `RUN_ACTION_CODES` 加 `"lifecycle-not-allowed"`（参数 `lifecycle`）。
  - 输入与输出：
    ```ts
    export const RunLifecycleInputSchema = z.strictObject(WriteShape);
    export type RunLifecycleInput = z.input<typeof RunLifecycleInputSchema>;
    export const RunLifecycleOutputSchema = z.object({
      ...ContractShape,
      status: RunActionStatusSchema,
      /** The Run's revision after the call (the current one when rejected). */
      revision: z.number().int().nonnegative(),
      /** The lifecycle after the call; null when the Run cannot be read. */
      lifecycle: Text(32).nullable(),
      issues: z.array(RunIssueViewSchema).max(100),
    });
    ```
- `shared/rpc/run-engine.ts`：`runPauseRpc`（`agent-team.run.pause`）、`runResumeRpc`（`agent-team.run.resume`），输入输出都用上面两个 schema。
- `server/run-engine/lifecycle.ts`：把"一次提交里做 reducer 事件"的部分拆成纯的规划函数，供 RPC 与现有 `createLifecycleControl` 共用（现有 17 例保持通过）。
- `server/run-engine/control.ts`：`pause(input)`、`resume(input)`。一次 `store.update`：
  1. replay：找 `kind === "run-control-requested"` 且 `payload.requestId === input.requestId` 的事件；动作与原因都相同 → `replayed`，否则 → `request-id-reused`；
  2. `expectedRevision` 不等 → `revision-conflict`；
  3. 生命周期：暂停只允许 `active`，续办只允许 `paused`，其余（包括已经在目标状态）→ `lifecycle-not-allowed`；
  4. reducer 事件 `run-paused` / `run-resumed`，同一次提交追加审计事件 `run-control-requested`（`payload: { requestId, action: "pause" | "resume", reason }`）；
  5. `checkLedgerInvariants`，提交。续办提交后 `driver.retryRun(runId, { afterWrite: true })`；暂停不推进。
- `index.server.ts`：注册两个 RPC，接到 `engine.control.pause` / `resume`。
- `server/run-engine/projection.ts` 的 `supportedControlsOf`：`pause` 当且仅当 `lifecycle === "active"`；`resume` 当且仅当 `lifecycle === "paused"`（A5 会再加"且没有取消请求"）。
- 客户端：`controls.ts` 的 `controlsOf` 加两个控制；`client/runs/engine/control-runner.ts`、`use-engine-controls.ts`、`EngineControls.tsx` 加"暂停派发"与"继续"按钮。暂停不弹确认，但按钮旁写明"暂停后不再派发新任务，进行中的回合会继续到结束，到达的报告照常入账"；原因由页面生成（同 T5a 的做法）。新拒绝码与事件的中文。
- `README.md` 的 Run Engine 一节补上这两个控制（`readme-facts.test.ts` 会核对名字）。

**测试**
- `tests/run-engine/control-lifecycle.test.ts`（真实 store、真实 driver 与假宿主，照 `control.test.ts`）：暂停 `active` → `applied`、修订号 +1、新增事件恰好是 `run-paused` 与 `run-control-requested`；同 id 重提 → `replayed` 不写；同 id 换原因 → `request-id-reused`；旧修订号 → `revision-conflict` 不写；对 `bootstrapping`、`awaiting-dag`、`paused`、`finished`、`cancelled` 暂停 → `lifecycle-not-allowed`；续办 → `applied` 且 `retryRun` 被以 `afterWrite` 调一次；续办 `active` → `lifecycle-not-allowed`；暂停期间什么都不发、续办后扣住的消息恰好发一次（经 RPC 走一遍 `driver.test.ts` 里已有的场景）；v1 与 v2 记录各一遍（0.2 第 2 条）；返回值不含 nonce、提示词、outbox 参数（AC19）。
- `rpc-actions.test.ts`：输入严格（多字段、缺 `reason` 被拒）。`queries.test.ts`：各生命周期下的 `supportedControls`。`server-entry*.test.ts`：26 个 RPC，各接到自己的方法。
- 客户端：`tests/run-view/controls.test.ts`（门控、拒绝码文案穷举）、`control-runner.test.ts`、`engine-view.test.ts`（按钮只在服务端声明时出现）。

**变异检查**：任何生命周期都允许暂停；replay 放到版本检查之后（同 id 重提变成 `revision-conflict`）；续办后不推进；推进不带 `afterWrite`；`supportedControls` 在 `active` 时也给 `resume`；漏一个拒绝码的文案。

**验收**：全部检查通过；暂停与续办都只经 reducer 自己的事件；第 45 点记录。

**风险与回滚**：回滚到没有续办入口的版本，暂停中的 Run 会一直停着（不派发）。必须与 A5 同一版本发布（见 A5）。

---

## A4 决策答复 `cancel`（B6，依赖 A2）

**范围**：只做 `cancel`。`reject` 不做（不批准）；`assign-seat` 推迟；判官"回合结束没有可用报告"仍不开决策（推迟）。

**改动**
- `shared/schemas/run-engine/rpc-actions.ts`：
  ```ts
  export const RUN_DECIDE_ACTIONS = ["retry", "cancel"] as const;
  export const RunDecideAnswerSchema = z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("retry") }),
    z.strictObject({ action: z.literal("cancel") }),
  ]);
  ```
  `RunDecideOutputSchema` 加 `cancelledTaskIds: z.array(Text(64)).max(64).optional()`。
- `shared/domain/run-engine/decision-answer.ts`：
  - 新键前缀 `EVIDENCE_STUCK_KEY_PREFIX = "evidence-stuck:"`。`classifyDecision` 增加 `{ kind: "evidence-stuck"; assignmentId }`（D1，键为 `evidence-stuck:<assignmentId>`）。**不要**复用 `stuck:`：第 34 点要求补证链的冻结永远不落入普通 `retry`。
  - `stoppedTasksWithoutDecision` 也返回补证 assignment 停下的任务（带标记）；`openStuckDecision` 对它们用 `evidence-stuck:` 键，摘要写"补证没有完成，任务已冻结；只能取消这个任务"。`planResume` 对 `evidence-stuck` 一律拒绝（retry 不可用）。
  - `answerableActions(record, decision)`（签名加上 `record`，`projection.ts` 两处调用点跟着改）：决策不是待处理、不可分类、`record.lifecycle !== "active"` 或（A5 之后）有取消请求 → `[]`；`evidence-stuck` → `["cancel"]`；`quality`、`stuck` → `["retry", "cancel"]`。这同时修掉"暂停中的 Run 也画重试按钮"（新发现 R2）。
  - `AnswerRequest` 的 `action` 改为 `"retry" | "cancel"`，并加 `controlNonceDigest: string`（服务端传入 `sha256Hex(randomUUID())`，共享代码不引入 Node 模块）。
  - 把 `abandonAttempt` 里"按宿主回执关闭一次已结束的尝试"的部分抽成导出的 `closeEndedAttempt(record, { assignmentId, turnId, endedEventKey, now })`，A5 也用它；`retry` 的行为不变。
  - `cancel` 的处理（全部在一次提交里，任何一步失败整次不写）：
    1. 前置：Run 为 `active`；任务存在且不是 `done`/`cancelled`；limbo 的 `stuck:` 决策先 `closeEndedAttempt`；之后该任务每个 assignment 都满足 `isNormalEnded` 或 `isLocalNeverSent`；`!hasUnsettledEffects(next, taskId)`。不满足 → `task-not-releasable`（`reason`：`actors-unsettled`、`effects-unsettled`、`state-changed`）。
    2. reducer `cancel-requested`：`{ taskIds: [taskId], reason: "decision-cancel", controlNonceDigest, cancelIntents: [], preparedCancelIntents: [] }`。没有占用的任务到这里已经 `cancelled`。
    3. 仍是冻结（有已发交付留下的占用）时：同一次提交里把 reducer 刚开的 D1 `cancel:<任务>` 答复为 `{ action: "cancel", taskIds: [taskId], answeredAt, requestId, reason, via: <原决策 id> }`，再发一次 `cancel-requested`，此时 A2 让它释放。仍未取消 → `task-not-releasable`（`cancel-not-released`）。
    4. 级联：沿 `spec.deps` 求依赖它的全部下游任务（传递闭包）；它们都必须是 `pending` 且没有 assignment，各发一次 `cancel-requested`（立即取消）。有不满足的 → `task-not-releasable`（`dependent-active`）。
    5. 原决策答复为 `{ action: "cancel", taskIds: [taskId, ...下游], answeredAt, requestId, reason }`，`task.releaseDecisionId = 原决策 id`（注意：步骤 3 的 D1 授权已经把 `releaseDecisionId` 设为 D1 的 id，这里保持 D1 的 id，不要覆盖，否则 I7 的 `cancellation-release-binding` 会报错；只有没有 D1 的情形才设原决策 id）。
    6. 审计 `decision-answered`：`{ decisionId, taskId, action: "cancel", cancelled: [...], requestId }`。
  - 重复提交沿用现有逻辑：已答复且 `answer.requestId`、`action` 相同 → `replayed`；别人的答复 → `decision-answered`。
- `server/run-engine/control.ts` 的 `decide`：透传 `cancel`，输出带 `cancelledTaskIds`。提交后照常 `afterWrite` 推进；`driver.pass` 的 `finishIfDone` 会在任务全部 `done`/`cancelled` 时结束 Run。
- 客户端：每个 `actions` 含 `cancel` 的决策加"取消任务"按钮，确认框列出该任务与将被一起取消的下游（客户端用 `run.dag.tasks[].deps` 求，与服务端同规则），并写明"取消不回滚代码：已提交的改动留在分支上，需要的话自己 revert"。`controls.ts` 的说明、`waiting.ts` 的 `explainDecision` 增加 `evidence-stuck`。
- `README.md` 补"取消任务"与补证冻结任务的出路。

**测试**（`tests/run-engine/decision-answer.test.ts`、`control.test.ts` 增补，真实 store）
- D3（质量阶梯用尽、任务 `failed`、交付存在）：取消 → 任务 `cancelled`、占用释放、D1 授权与原决策都已答复且带同一个 `requestId`、下游被取消；其余任务都完成时 Run 变 `finished`。
- D4（尝试数上限、冻结）、生产者 `blocked`/`failed`、判官 `blocked`：各一例。
- limbo 生产者（回合结束、报告不可用、补报用尽）：先关闭尝试，补报意图离开 outbox，nonce 被撤销，然后取消。
- 补证冻结：开出 `evidence-stuck:` 决策，`actions` 只有 `cancel`；`retry` 被拒（`decision-not-answerable` 或 `action-unsupported`，取实现给出的那个并在用例里固定）。
- 有未结算的 assignment 或 `outcome-unknown` 的效果 → `task-not-releasable`，台账一字节不动。
- 同 id 重提 → `replayed`；另一个 id → `decision-answered`；旧修订号 → `revision-conflict`；暂停中的 Run → `run-not-active`，且投影里 `actions` 为空。
- 跨 Run：另一个 Run 因同一仓库的占用在等，取消后它的任务能派发（driver 级用例）。
- v1 与 v2 记录各一遍；返回值不泄漏（AC19）。
- 文案穷举：新的事件与原因都有中文。

**变异检查**：去掉步骤 3（占用不释放）；去掉级联（Run 结束不了）；`evidence-stuck` 也给 `retry`；limbo 不先关闭尝试；去掉未结效果检查；`answerableActions` 不看生命周期；补证冻结用 `stuck:` 键；步骤 5 覆盖 D1 的 `releaseDecisionId`。

**验收**：全部检查通过；DEV 上"冻结占着仓库锁"的任务有了页面出路；第 46 点记录。

**风险与回滚**：取消不回滚代码。回滚到旧版本：已答复的 `cancel` 决策与已取消的任务对旧程序合法；`evidence-stuck:` 决策旧程序不认识，只显示、不能答复。

---

## A5 延迟取消整个 Run（B4b，依赖 A2、A3、A4）

**语义**：取消 = 先停止新派发并记下取消请求；等每个在途回合都被证明已经结束（报告照常入账，补报不发）；然后在一次提交里用 reducer 自己的 `run-cancelled` 取消全部未完成任务并释放占用。**全程不发送任何消息、不归档、不打断**，所以不产生模型调用。在途任务的归档式取消（reducer 的 167 静止证明）不在本任务里（推迟，见裁决）。

**改动**
- 新增 `shared/domain/run-engine/cancel-request.ts`（纯函数）：
  - 透传块 `cancelRequest`：`z.strictObject({ version: z.literal(1), requestId: z.string().min(1).max(128), reason: z.string().min(1).max(600), requestedAt: RunTimeSchema, completedAt: RunTimeSchema.nullable() })`。
  - `readCancelRequest(record): { kind: "absent" } | { kind: "invalid" } | { kind: "valid"; value }`，v1 与 v2 记录都读（v1 存储同样容忍未知字段）。`invalid` 按"有取消请求但读不懂"处理：拒绝续办与暂停、不自动完成、写一条 critical 告警。
  - `planCancelFinish(record, refreshes: Map<agentId, { status: string; activeTurn: boolean } | "unreadable">)`：返回 `{ kind: "wait"; turns: number; deliveries: number }` 或 `{ kind: "finish"; close: { assignmentId, turnId, endedEventKey }[] }`。规则：对每个状态为 `assigned`/`in_progress` 的 assignment：若它只有一条从未发出的 `prepared` 派发（`canCancelLocally` 为真）→ 不用等，`run-cancelled` 会本地撤回；否则必须存在该 Agent 的 `turn_ended` 回执，`receivedAt >= assignment.createdAt`，且之后（按 `seq`）没有该 Agent 的 `turn_started` 回执，并且刷新结果为 `idle` 或 `closed` 且没有活动回合，才进 `close`（若已有 `turnId`，回执的 `turnId` 必须相同）；否则算一个在等的回合。本 Run 任何意图处于 `sending` 或 `outcome-unknown` → 算一个在等的送达。
- `shared/schemas/run-engine/rpc-actions.ts`：
  - `RUN_ACTION_CONTROLS` 加 `"cancel"`；`RUN_ACTION_CODES` 加 `"cancel-pending"`、`"launch-in-progress"`。
  - ```ts
    export const RunCancelInputSchema = z.strictObject(WriteShape);
    export type RunCancelInput = z.input<typeof RunCancelInputSchema>;
    export const RunCancelOutputSchema = z.object({
      ...ContractShape,
      status: RunActionStatusSchema,
      revision: z.number().int().nonnegative(),
      lifecycle: Text(32).nullable(),
      /** What the cancellation still waits for when it was not completed at once. */
      waiting: z
        .object({
          turns: z.number().int().nonnegative(),
          deliveries: z.number().int().nonnegative(),
        })
        .nullable(),
      issues: z.array(RunIssueViewSchema).max(100),
    });
    ```
- `shared/rpc/run-engine.ts`：`runCancelRpc`（`agent-team.run.cancel`）。`index.server.ts` 注册。
- `server/run-engine/control.ts` 的 `cancel(input)`，一次提交：
  1. replay：已有 `cancelRequest` 且 `requestId` 相同 → 原因相同 `replayed`，否则 `request-id-reused`；已有取消请求但 id 不同 → `cancel-pending`；
  2. `expectedRevision`；
  3. 生命周期为 `finished`/`cancelled` → `lifecycle-not-allowed`；`launch.state` 为 `preparing`/`creating` → `launch-in-progress`；
  4. 写 `cancelRequest`（`completedAt: null`）与审计 `run-cancel-requested`（`{ requestId, reason }`）；`active` 时同一次提交里 reducer `run-paused`；写 warning 告警（固定文本）："已请求取消这个 Run：不再派发新任务，等进行中的回合结束后取消全部未完成的任务并释放占用。"；
  5. `bootstrapping`/`awaiting-dag`（还没有任务）：同一次提交里直接 reducer `run-cancelled`（`reason: "run-cancel"`，空配对），`completedAt` 填上，告警置 `resolved`；
  6. 提交后 `afterWrite` 推进；输出的 `waiting` 按 `planCancelFinish` 在请求时的结果给出（直接完成时为 null）。
- 新增 `server/run-engine/cancel.ts`：`createCancelFinisher({ store, port, clock, log, onReadFailure })`，`finish(runId)`：
  1. 读记录；没有待完成的取消请求，或生命周期已是 `cancelled`，就返回；
  2. 对需要刷新的 Agent 调 `port.agents.ref(id).refresh()`（只读）；抛错 → `onReadFailure(runId, { type: "seat", agentId })`，记为 `unreadable`；
  3. `planCancelFinish` 为 `wait` → 什么都不写，返回计数；
  4. 为 `finish` → 一次提交：在当前记录上重新算 `planCancelFinish`（用同一批刷新结果），结果不同就不写；对 `close` 里每项 `closeEndedAttempt`（A4 抽出的）；reducer `run-cancelled`（`reason` 用固定原因码 `run-cancel`：它会成为每个任务的 `waitingReason`，人写的原因只存在 `cancelRequest` 和审计里；`controlNonceDigest` 为 `sha256Hex(randomUUID())`；空配对）；对仍冻结且有 D1 `cancel:<任务>` 的任务，把 D1 答复为 `{ action: "cancel", taskIds: [taskId], answeredAt, requestId: 请求的 id, reason, via: "run-cancel" }` 再发一次 `cancel-requested`（A2 让它释放）；任何任务仍不是 `cancelled`/`done` → 不提交，写 critical 告警"取消没有完成：<原因码>"；否则 `completedAt` 填上、warning 告警置 `resolved`、审计 `run-cancel-completed`（`{ requestId, tasks }`），`checkLedgerInvariants`，提交。
- `server/run-engine/driver.ts`：`pass(runId)` 开头（A1 的压缩之后）在有待完成的取消请求时调 `finish`（失败只记日志）。暂停的 Run 本来就会被 `recover`、`retryRun`、hook 走到，`cancelled` 的 Run 本来就被跳过，不用改。
- A3 的 `pause`/`resume`：有取消请求（`valid` 或 `invalid`）时 → `cancel-pending`。A4 的 `answerableActions`：有取消请求时为 `[]`。`supportedControlsOf`：`cancel` 当且仅当生命周期不是 `finished`/`cancelled`、没有取消请求、`launch.state` 不是 `preparing`/`creating`；有取消请求时不给 `pause`、`resume`、`decide`；`kick` 照给（它会推一遍 `finish`）。
- 客户端："取消 Run"按钮，确认框要求填写原因（同重新规划），并写明"不会回滚代码；会等进行中的回合结束，期间不再派发，结束后释放全部占用"；取消请求之后页面靠上面的告警说明状态。中文：新码、`run-cancel-requested`、`run-cancel-completed`。
- `README.md`：取消的语义与限制（不归档、要等在途回合、送达不明时会一直等并说明原因）。

**测试**（新增 `tests/run-engine/cancel.test.ts`，真实 store、真实观察器/入账/outbox/driver，宿主按脚本写时间线，照 `control.test.ts`）
1. `active` Run，成员回合进行中：取消 → 生命周期 `paused`、`cancelRequest` 已写、告警 open、宿主 `sent` 不变、占用保留；成员 `turn_ended` 带完成报告到达 → 报告入账（任务进 `review`）但不派审查者；`finish` → `run-cancelled`、全部未完成任务 `cancelled`、占用释放、告警 `resolved`、`completedAt` 有值。
2. limbo：成员报告被拒、补报 `prepared`（被暂停扣住）→ `finish` 关闭尝试、补报转 `failed` 永不发出、nonce 被撤销。
3. `outcome-unknown` 的派发：`finish` 一直等（不写）；回显确认后回合结束 → 完成。
4. 回执说已结束但刷新说 `running`（新回合的 hook 晚到）→ 等；刷新抛错 → 登记读取失败并等。
5. `bootstrapping`/`awaiting-dag`：请求的同一次提交里完成；协调者之后交来的 DAG 不被接纳。
6. 暂停扣住的、从未发出的派发：`run-cancelled` 给它打本地撤回标记（`localCancellation.cause === "run-cancelled"`），占用移除。
7. 已发交付留下占用的冻结任务：D1 以请求的 id 答复并释放，不变式通过。
8. 同 id 重提 → `replayed`；另一个 id → `cancel-pending`；旧修订号 → `revision-conflict`；`finished`/`cancelled` → `lifecycle-not-allowed`；启动中 → `launch-in-progress`。
9. 取消待完成时：暂停、续办 → `cancel-pending`；决策 `actions` 为空；`kick` 推一遍 `finish`。
10. 请求之后、完成之前重启：新 runtime 的 `recover` 完成它且只产生一个 `run-cancelled`；两个并发的 `finish` 只有一个提交生效（CAS）。
11. **从请求到完成，宿主上没有任何 `send`、`archive` 调用**（关键断言，AC17 方向）。
12. 跨 Run：另一个 Run 等同一仓库占用，取消完成后它能派发。
13. v1 与 v2 记录各一遍；返回值不泄漏（AC19）。
- `server-entry*.test.ts`：27 个 RPC。`rpc-actions.test.ts`、`queries.test.ts`（各状态下的 `supportedControls`）、客户端门控与文案测试。

**变异检查**：去掉回执检查（回合还在跑就完成）；去掉宿主刷新；忽略 `outcome-unknown`；去掉 D1 授权释放那一步（占用留着）；取消待完成时允许续办；完成时多一次 `port.send`；`finish` 不重算就提交；`bootstrapping` 里也去等待。

**验收**：全部检查通过；用例 11 成立；第 47 点记录。

**风险与回滚**：在途回合很长时取消要等它结束；送达不明会让取消一直等（安全方向，页面有说明，人可以 kick 推动核对）。旧程序会原样保留 `cancelRequest` 但不认识：回滚到 A3 之前，取消中的 Run 停在 `paused`（没有续办入口，不派发）；回滚到 A3 与 A5 之间，能续办一个已请求取消的 Run，所以 **A3 与 A5 必须同一版本发布**。

---

## A6 追加预算 RPC（B3）

**范围**：不开 D4 决策（会挡住 `run-finished`，见裁决），改为窄 RPC。

**改动**
- `shared/schemas/run-engine/rpc-actions.ts`：
  - `RUN_ACTION_CONTROLS` 加 `"budget"`；`RUN_ACTION_CODES` 加 `"seat-missing"`、`"budget-missing"`、`"budget-cap"`（参数 `max`）。
  - ```ts
    export const RunBudgetInputSchema = z.strictObject({
      ...WriteShape,
      /** A seat of the Run's roster (A11 adds the coordinator's). */
      seatId: Text(128),
      by: z.number().int().min(1).max(64),
    });
    export type RunBudgetInput = z.input<typeof RunBudgetInputSchema>;
    export const RunBudgetOutputSchema = z.object({
      ...ContractShape,
      status: RunActionStatusSchema,
      revision: z.number().int().nonnegative(),
      seatId: Text(128),
      /** The seat's limit after the call; null when rejected. */
      limit: z.number().int().nonnegative().nullable(),
      issues: z.array(RunIssueViewSchema).max(100),
    });
    ```
- `shared/domain/run-engine/budget.ts`：`BUDGET_LIMIT_MAX = 1024`；`increaseSeatBudget(record, { seatId, by, requestId, reason, now })`：条目取 `budgets.entries` 里 `scope: "seat"` 的，没有就复制 `policy.seatBudgets` 里的（**冻结的 `policy` 一个字节都不改**），两处都没有 → `budget-missing`；`limit + by > 1024` → `budget-cap`；写回 `budgets.entries`；审计 `budget-increased`（`{ requestId, seatId, by, limitBefore, limitAfter, reason }`）；把该席位的耗尽告警置 `resolved`（用 `run-alert.ts` 的 `resolveAlerts`）。
  - replay：找 `kind === "budget-increased"` 且 `payload.requestId` 相同的事件；`seatId`、`by`、`reason` 都相同 → `replayed`，否则 `request-id-reused`（被 A1 压掉后退化为 `revision-conflict`）。
  - 前置：`seatId` 在 `roster` 里，否则 `seat-missing`；生命周期是 `finished`/`cancelled` 或有取消请求 → `lifecycle-not-allowed`。`bootstrapping`、`awaiting-dag`、`active`、`paused` 都允许。
- `server/run-engine/service.ts`：`DispatchNextResult` 的 `blocked` 变体加可选 `seatId`（内部类型，不是 wire），预算类原因（`budget-exhausted`、`budget-missing`）时填上。
- `server/run-engine/driver.ts` 的 `show()`：`blocked` 且原因为 `budget-exhausted` 并带 `seatId` 时，写 warning 告警："席位 <seatId> 的回合预算已用完（已预留 <reserved>/<limit>）。在 Runs 页追加预算后会继续。"（`alertIdFor` 按文本去重，同一额度只写一次）。
- `server/run-engine/control.ts` 的 `budget(input)`；`shared/rpc/run-engine.ts` 的 `runBudgetRpc`（`agent-team.run.budget`）；`index.server.ts` 注册。
- `supportedControlsOf`：`budget` 当且仅当生命周期不是 `finished`/`cancelled` 且没有取消请求。
- 客户端：预算列表里每个席位一行"追加预算"（数字 1–64，默认 4，确认后发送，原因由页面生成）；中文。
- `README.md`：预算耗尽时的出路。

**测试**（新增 `tests/run-engine/budget-control.test.ts`，真实 store 加 driver）：席位预算 1、两个任务 → 第二个 `dispatch-blocked:budget-exhausted`、告警只写一次（多次 kick 不重复）；追加 2 → 额度 3、推进后第二个任务恰好派发一次、告警 `resolved`；同 id 重提 → `replayed` 且额度不变；同 id 换 `by` → `request-id-reused`；旧修订号；未知席位 → `seat-missing`；策略与运行时都没有条目 → `budget-missing`；超过 1024 → `budget-cap`；`finished` → `lifecycle-not-allowed`；`policy` 前后逐字节相同；v1 与 v2 各一遍；AC19；`by` 为 0 或 65 被输入 schema 拒绝。

**变异检查**：写进 `policy.seatBudgets`；不推进；replay 放到版本检查之后；每一遍都写告警；上限差一；`blocked` 结果不带 `seatId`（告警不出现）。

**验收**：全部检查通过；第 48 点记录。

**风险与回滚**：单次 1–64、累计 1024 的上限限制失控消耗。旧程序读到更高的 `budgets.entries[].limit` 照常使用。

---

## A7 读取重查扩面与自动继续（B12 + B1）

**范围**：不升版本、不加 `readRetries` 的状态或目标类型、不加 `sendIntent`、不拆入账。

**改动**
- 扩面（B12），全部映射到**已有**目标类型（新增目标类型会让旧的 S1 程序把整个块判为不可读、停掉该 Run 的全部重查）：
  - `server/run-engine/intake.ts`：`observer.inspectReport` 因回复窗口不完整（`window.complete === false`）返回 `unverifiable` 时，和读取抛错一样 `onReadFailure(runId, { type: "reply", agentId, taskId, assignmentId, anchorMessageId })`。只对"窗口不完整"，"没有报告块"等其他原因不登记。
  - `server/run-engine/observer.ts` 的 `reconcile`：`host.replyWindow` 抛错时，对来自 assignment 的条目调可选的 `onReadFailure`（`createRunObserver` 新选项），目标是 `reply`（字段取该 assignment 与 `replyAnchor`）。协调者计划回复那一条没有 assignment，**不登记**（写进限制）。
  - `server/run-engine/effects.ts` 的 `evidencePreflight`：`port.agents.ref(id).refresh()` 单独 try/catch，抛错时 `onReadFailure(runId, { type: "seat", agentId })`（`createEffects` 新选项）；仓库检查的失败不登记。
  - `server/run-engine/runtime.ts`：把同一个 `onReadFailure` 也接给 observer 与 effects。
- 自动继续（B1）：
  - `shared/domain/run-engine/read-retry.ts`：新常量 `READ_RETRY_AUTO_CONTINUE_GENERATIONS = 3`；`finishTries` 的返回值多给出本轮变成 `resolved` 的项（`key`、`generation`）。
  - `server/run-engine/read-retry.ts`：`ReadRetryOptions` 加 `onRecovered?: (runId: string) => void | Promise<void>`；第 3 步（记录读取结果）的提交成功后，若本轮有 `generation <= 3` 的项变成 `resolved`，调一次 `onRecovered(runId)`（异常只记日志）。
  - `server/run-engine/runtime.ts`：`onRecovered: (runId) => driver.retryRun(runId, { afterWrite: true })`。`driver` 在 `readRetry` 之后才创建，用延迟绑定的引用。
  - 告警文本 `readRetryAlertSummary` 不改（告警 id 由文本算出）；自动继续那一遍结束时现有的 `sweep` 会把已入账的告警撤下。

**测试**
- `tests/run-engine/read-retry-server.test.ts` 增补：回复读取恢复 → `onRecovered` 恰好一次；席位读取恢复 → 一次；失败的尝试 → 不调；第 4 代恢复 → 不调；等待期间 Run 结束 → 不调；`onRecovered` 抛错不影响计时器；`TargetSchema` 与块的版本没变（旧块照常解析）。
- `tests/run-engine/driver.test.ts` 端到端：回复读取抛错一次后恢复 → 不用人 kick，报告入账；席位读取抛错一次后恢复 → 派发发生；宿主时好时坏 → 每个来源最多自动继续 3 次，之后只留告警；回复窗口不完整 → 登记重查，连续 3 次不完整 → "已用尽"告警；对账读取抛错 → 登记；补证发送前的刷新抛错 → 登记席位重查，恢复后补证请求恰好发一次（用已有的补证端到端夹具）。

**变异检查**：去掉代数上限；失败时也调 `onRecovered`；在提交之前调；不登记不完整窗口；给协调者计划回复编造 assignment 字段登记；推进不带 `afterWrite`。

**验收**：全部检查通过；第 49 点记录写明限制（协调者计划回复不在重查范围；永久性不完整会用尽后告警）。

**风险与回滚**：自动继续做的就是人按 kick 做的事（只读宿主、按台账推进、永不重发 `sending`/`outcome-unknown`）；不改台账形状，回滚无影响。

---

## A8 启动中断后关闭并告警（B13a）

**范围**：不续办（完整续办需要冻结 agentSpecs，推迟）。不调用宿主、不归档（`archiveOnLaunchFailure` 是启动时的偏好，没有冻结在记录里）。

**改动**
- `server/run-engine/start.ts` 导出 `failInterruptedLaunches({ store, isStarting, clock, log })`：对列表里 `launch.state` 为 `preparing` 或 `creating`、且 `!isStarting(runId)` 的 Run，一次提交：`setLaunchState(current, "failed", now, "interrupted-while-<state>")` 加一条 critical 告警："启动在<创建记录|创建成员>时中断（插件或 daemon 重启）。已登记的 Agent：<席位>=<agentId>，…；可能还有一个已创建但未登记的 Agent（席位 <第一个还没有 agentId 的启用席位>）。这个 Run 不会继续，请重新启动，并在 Agent 列表里归档不再需要的成员。"（不超过 1000 字，列表截断）。
- `server/run-engine/runtime.ts`：`const starting = new Set<string>()`，调用 `startEngineRun` 前加入、`finally` 里删除；`recover()` 在 `driver.recover()` 之前调 `failInterruptedLaunches`。
- 不新增字段；`launch.state = "failed"` 的 Run 已有的展示与跳过路径照旧（`settleWaiting` 不跑 outbox，读取重查视为已结束）。

**测试**（新增 `tests/run-engine/start-recovery.test.ts`）：`store.create` 之后崩溃（`preparing`）→ 恢复记为失败并告警，宿主零调用；协调者已登记后崩溃（`creating`）→ 告警列出协调者与下一个席位；本 runtime 正在启动的 Run 不被碰，启动正常完成后照常推进；已 `failed`、`cancelled`、`kickoff-pending`、`running` 的不被碰；第二次恢复不写（修订号不变）；投影显示失败的启动；读取重查不为它保留计时器。

**变异检查**：忽略 `isStarting`；把 `kickoff-pending` 也当中断；恢复时归档 Agent；每次恢复都写告警。

**验收**：全部检查通过；第 50 点记录写明"已创建未登记的 Agent 只能靠告警提示"。

**风险与回滚**：误判正在启动的 Run 由进程内登记守住（台账有进程锁，只有一个写进程）。不改台账形状。

---

## A9 测试补强：权限等待与空闲零调用（B5 + AC17）

**范围**：只加测试；测试暴露的缺陷若修复不改合同，就在本任务里修并加变异检查；要改合同就写进笔记"待批准"，不修。

**测试**
- `tests/run-engine/permission-wait.test.ts`：
  - 结构性：扫描 `server/run-engine/**/*.ts` 与 `shared/paseo/port.ts` 的 Engine 端口，没有 `respondToPermission`；`PortEngineAgentHandle` 没有这个键（`expectTypeOf`）。
  - 有 `pendingPermissions` 的席位不被派发（已有用例的扩展：其他席位照常拿到工作）。
  - 成员在等权限（有 `permission_requested` 回执、没有 `turn_ended`）时重启：`recover` 什么都不发，不给该席位派新任务。
  - `permission_resolved` 的 hook → kick，不重发；之后 `turn_ended` 到达，报告只入账一次；重复的权限 hook 只留一条回执。
- `tests/run-engine/idle.test.ts`（AC17）：一个没有到期工作的 Run，喂入 N 条重复的 `turn_started`、无归属 Agent 的权限事件，再 kick K 次：宿主 `sent` 为空、重复事件不改修订号、没有发给协调者的消息、`readRetry.armed` 为假。
- 验收表 `docs/run-engine-acceptance.md` 的 AC12、AC17 两行按新证据更新。

**变异检查**（若有修复）：按修复点列；只加测试时至少做 2 项：让 `service` 忽略 `pendingPermissions`；让 driver 在 `permission_requested` 上也 kick 并派发。

**验收**：全部检查通过；第 51 点记录。

---

## A10 决策的 `kind` 字段（B10 缩小，依赖 A4）

**改动**
- `shared/schemas/run-engine/rpc.ts`：`RunDecisionViewSchema` 加 `kind: Text(32).optional()`。**用字符串，不用 `z.enum`**：较新的服务端加一个值时，旧客户端若用枚举解析会整份详情失败。
- `shared/domain/run-engine/decision-answer.ts`：`decisionKindOf(record, decision)` 返回 `"quality-d3" | "quality-d4" | "stuck-producer" | "stuck-judge" | "limbo-producer" | "evidence-stuck" | "cancel" | "other"`；`projection.ts` 填上。
- 客户端 `controls.ts` 的 `retryExplanation` 与 `waiting.ts` 的 `explainDecision`：有 `kind` 时按 `kind` 说明；没有或不认识时回落到现在按类别的说明。

**测试**：投影里每种决策的 `kind`；用旧的 `RunDecisionViewSchema`（无 `kind`）解析新的 DTO 成功（被剥掉）；新客户端遇到没有 `kind` 的旧 DTO 回落；遇到未知 `kind` 回落且不报错；`kind` 的中文穷举。

**变异检查**：`stuck-judge` 与 `stuck-producer` 弄反；客户端忽略 `kind`；未知 `kind` 抛错。

**验收**：全部检查通过；第 52 点记录。`nextAttemptAt`、`waitingCode` 不做（推迟）。

---

## A11 协调者回合预算（B2 缩小，可选，依赖 A6）

**改动**
- `shared/domain/run-engine/budget.ts`：`ensureCoordinatorBudget(record)`：`budgets.entries` 里没有 `{ scope: "seat", subjectId: "coordinator" }`（`COORDINATOR_SEAT_ID`）时懒建一条：`limit = policy.run.strategicTurns`，`reserved` = outbox 里发给协调者、状态不是 `failed` 的 `wake` 意图个数，`confirmed: 0`，`observedTurns: 0`。不改 `policy.seatBudgets`，不改 Team 配置的默认值。
- 预扣（同一次提交，键用各自意图的 `idempotencyKey`/`messageId`，重复提交由 `predebit` 的 `already-counted` 挡住）：`shared/domain/run-engine/run-record.ts` 的 `addPlanRequest`（启动时的计划请求）、`replan.ts` 的 `requestReplan`、计划补报意图的构造处（`plan-repair.ts`/`dag.ts`）。
- 耗尽：`replan` 拒绝为 `budget-exhausted`（加进 `RUN_ACTION_CODES`）并写 A6 同款告警（席位写"协调者"）；计划补报不发并写告警（DAG 被拒的告警照旧）；`shared/domain/run-engine/team-config.ts` 的 `engineLaunchGate` 在 `policy.run.strategicTurns < 1` 时给出阻断"协调者回合预算为 0，无法发出计划请求"（编辑器与启动预览会实时显示）。
- A6 的 `run.budget` 允许 `seatId: "coordinator"`。

**测试**：启动预扣 1；replan 预扣 1、重复提交不重复扣；计划补报预扣 1；耗尽后 replan 被拒、写告警、不新增意图、协调者不再收到消息（AC13）；追加后 replan 可用；旧 Run 没有条目时懒建且 `reserved` 等于已有协调者唤醒数；`strategicTurns` 为 0 时启动预览阻断。

**变异检查**：重复提交扣两次；懒建时 `reserved` 记 0；计划补报不预扣；去掉启动门。

**验收**：全部检查通过；第 53 点记录。

---

## A12 DEV 真实验证（可选，最后做）

照 `docs/remaining-work-plan.md` 第 5 节：只用 worktree 里的 `.paseo-dev`，每条命令显式 `--home`/`--host` 并设置 `PASEO_HOME`；最多 4 个 Run；做不下去就跳过；结束必须清理（归档 DEV 里建的 Agent、删探针仓库与临时目录、`daemon stop --home`）。优先验证：取消一个有成员在途的 Run（期间宿主上没有任何发送，在途回合结束后才释放）；追加预算后继续；把冻结的任务取消并让另一个 Run 拿到仓库占用；replan v4（第 33 点要求的必做项）。压缩不在 DEV 上验证（要上千条事件）。结果各写一条计划记录，如实写样本数。

## 附：本批明确不做的（裁决里写了理由）

- 在途任务的归档式取消（reducer 167 路径）、`assign-seat`、`reject`、`run.approve`、`run.reconcile`、`run.export`。
- B7 派发之后临时失败的自动重试（等宿主给出"失败发生在任何工具执行之前"的证据）。
- B8 服务端推送式失效（等确认插件 SDK 有推送通道）。
- B13 的完整续办（冻结 agentSpecs）。
- `nextAttemptAt`、`waitingCode` 两个 DTO 字段。
- `policy.run.failedTasks` 的执行（没有任何代码使用它，新发现 R3）。
- B9 默认开启、灰度、版本号与发布：只给建议，留给用户。

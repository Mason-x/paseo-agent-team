# 发布材料：Run Engine 收尾分支（只备材料）

## 发布结果（2026-11-09 补记）

本节记录两次实际发布。以下第 0–8 节是合并前的材料（统计基准 `5209eea`），保留作记录，数字不再更新。

| 版本 | 日期 | 发布方式 | 结果 |
| --- | --- | --- | --- |
| 0.6.0 | 2026-11-08 | 提交 `1de0a2c` 手工直推 `main` 后发版（提交时间 2026-11-09 00:03 +0800） | 标签 `paseo-agent-team-v0.6.0` 指向 `1de0a2c`；没有经过 PR，也没有 CI |
| 0.6.1 | 2026-11-08 | 发布 PR #14 | PR 的 CI 没有运行；用管理员绕过合并，合并提交 `0787c6c`（标签 `paseo-agent-team-v0.6.1` 指向它）；合并后 `main` 的 CI 成功 |

`paseo-agent-team-v0.5.0..paseo-agent-team-v0.6.0` 的实际统计（2026-11-09 重算）：

```text
$ git rev-list --count paseo-agent-team-v0.5.0..paseo-agent-team-v0.6.0
141
$ git log --format=%s paseo-agent-team-v0.5.0..paseo-agent-team-v0.6.0 | grep -c '^feat'
51
$ git log --format=%s paseo-agent-team-v0.5.0..paseo-agent-team-v0.6.0 | grep -c '^fix'
12
```

即 141 个提交，其中 51 个 `feat`、12 个 `fix`。两次发布都绕过了正常门禁，属于个例；以后的流程见 `docs/release-process.md`，不再重复。

编写：2026-11-08（阶段 3，A19）。依据：`docs/next-phase-plan.md` 2.7 与任务 A19。
这份文档只备材料。合并、推送、打标签、发布、改版本号、改 `CHANGELOG.md`、创建 PR **都没有做**，也不由实施会话做；这些由用户决定并执行。下文的数字都用命令实际统计，统计基准是 `5209eea`（处理独立评审发现的最后一个代码提交，本文的文档提交之前；`git rev-parse --short` 可核对）；之后每多一个提交数字都会再变，合并前请按第 5 节在最终 HEAD 上重新跑一遍。

## 0. 先读这一条：这次发布装的不止这个分支

`main` 当前就是 `5533722`（`git merge-base main HEAD` 等于它），而最近一次发布 `paseo-agent-team-v0.5.0`（提交 `9a04413`）与 `5533722` 之间还隔着 60 个提交（33 feat、4 fix、23 docs），那是 P01–P05 期间已经合入 `main` 但没有发布的部分：Engine 的启动、派发、补报、台账 schema v2 都在其中。v0.5.0 时台账 schema 是 v1，服务端 RPC 是 19 个；现在是 schema v2、28 个。

所以 release-please 生成的下一个版本会一次性包含 `v0.5.0..HEAD` 的 133 个提交（50 feat、11 fix、5 test、67 docs，没有破坏性标记），而不是只含本分支的 73 个。下面第 1 节两个口径都给出。这也是第 4 节“回滚注意”比计划原文更重的原因：相对 v0.5.0，回滚会回到一个既没有 Engine 启动路径、也不认识 schema v2 的版本。

## 1. 范围摘要

统计命令与结果（HEAD `5209eea`）：

| 口径 | 命令 | 提交数 | feat | fix | test | docs |
| --- | --- | --- | --- | --- | --- | --- |
| 本分支 | `git rev-list --count 5533722..HEAD`；`git log --format=%s 5533722..HEAD` 按类型分类 | 73 | 17 | 7 | 5 | 44 |
| 自上次发布 | `git rev-list --count paseo-agent-team-v0.5.0..HEAD`；`git log --format=%s paseo-agent-team-v0.5.0..HEAD` 按类型分类 | 133 | 50 | 11 | 5 | 67 |

破坏性标记（提交标题里的 `!:` 或正文里的 `BREAKING CHANGE`）：两个口径都是 0。本分支改动的文件（`git diff --shortstat 5533722..HEAD`）：109 个，新增 18677 行、删除 187 行，其中测试（`paseo-agent-team/tests`）48 个文件、新增 10860 行、删除 59 行；生产代码（`shared/`、`server/`、`client/`）52 个文件，新增 5684 行、删除 123 行。

**Engine 仍默认关闭。** 开关是守护进程环境变量 `PASEO_AGENT_TEAM_RUN_ENGINE=1`（`server/run-engine/runtime.ts`），没设置时，启用了 Engine 的 Team 在启动时被明确拒绝，不会悄悄改走协调者链路；Team 的 `runEngine` 块也只有在编辑器里点开关才会写入。不设开关、不点开关的用户看不到行为变化，只多出若干页面入口（Runs 页的 Engine 运行列表和 Team 编辑器的“Run 引擎”区）。

本分支的用户可见变化（按 feat/fix 分组，括号里是任务号）：

**feat**
- Runs 页的 Engine 运行：重新规划、重试、立即检查并推进（T5a）；为什么在等、谁来处理、下一步，以及每个事件的原因（T5b）；只在页面可见时轮询、不重叠、同版本不重绘（T5e/T5f）。
- Team 编辑器：编辑 Team 的 Run 引擎块（席位、层级、职责、渠道、策略数字，不丢未知字段）（T5c）；按规划出的 Profile 在 Codex 席位非 full-access 时给出警告。
- 启动对话框：说明 Engine 启动在做什么，计划请求已提交、要几分钟、不要重复启动（T5d）。
- 暂停与继续：引擎侧（T7b），再加两个 RPC 和页面按钮（A3）。
- 取消：对冻结任务的决策答复 `cancel`，连同下游任务级联取消（A4）；延迟取消整个 Run，等每个在途回合证实结束后才释放占用，不发消息、不归档、不打断（A5）。
- 追加预算：给席位追加 1–64 个回合，策略不变，台账里记新限额（A6）。
- 宿主读取失败后的重查扩面，读取恢复后引擎自动继续，前 3 次（A7）。
- 决策带 `kind` 字段，区分质量、成员、判官、无报告与补证（A10）。
- 事件压缩进检查点，台账接近上限时不再开始新工作（A1）。
- 失败的任务多于策略上限时不再开始尚未开始的任务（已在进行的评审、冒烟、补证请求与返工照常），一条 critical 告警，回落后自动撤下（A13；评审后修正了闸的范围）。
- 协调者的回合预算：计划请求与重新规划各扣一回合，耗尽时重新规划被拒并告警，可在预算区追加；`strategicTurns` 小于 1 时启动被阻断（A14）。

**fix**
- 取消后释放被冻结任务的占用（A2）；启动中断后关闭并告警，不触碰 Agent（A8）；文件锁并发读取加固；页面请求编号保持 UUID 并如实提示未知结果；预算类等待与告警的文案不夸大。

**测试与文档**：验收表（`docs/run-engine-acceptance.md`）、README 的 Run Engine 一节、使用说明和 A15–A17 的补测；这些不进用户可见的变更日志。

## 2. 预期版本

release-please（`release-please-config.json`，node 类型，带组件标签，`separate-pull-requests`）按提交类型决定版本：有 `feat` 无破坏性标记，所以预期是 **0.6.0**（当前清单版本 `.release-please-manifest.json` 与 `paseo-agent-team/package.json` 都是 `0.5.0`，`paseo-plugin.json` 没有版本字段）。

**没有手改** `package.json`、`.release-please-manifest.json`、`paseo-plugin.json` 的版本，**没有手改** `CHANGELOG.md`（里面只有空的 `## Unreleased` 和 0.5.0 及更早的条目）。`git diff 5533722..HEAD -- paseo-agent-team/package.json paseo-agent-team/paseo-plugin.json paseo-agent-team/CHANGELOG.md .release-please-manifest.json` 输出为空。版本与变更日志由 release-please 的发布 PR 生成，合并那个 PR 才会打标签。

## 3. PR 标题与正文草稿

**标题**（以 `feat(run-engine):` 开头，squash 时就是提交标题）：

```text
feat(run-engine): finish the opt-in Run Engine - controls, cancellation, budgets, limits and the Runs page
```

**正文**：

```text
Finishes the opt-in Run Engine. It stays off unless the daemon sets PASEO_AGENT_TEAM_RUN_ENGINE=1
and a Team's Run engine block is switched on in the Team editor.

What is in it
- Runs page: replan, retry, cancel a task, kick, pause, resume, add turns, cancel the Run; why a
  task waits, who clears it and what happens next; a history with the cause of each event.
- Team editor: the Run engine block (seats, tiers, duties, channels, policy numbers) without losing
  fields it does not know; a Codex seat that is not full-access is warned about.
- Launch dialog: says a plan request was submitted, that it takes minutes, and not to start again.
- Engine: deferred cancel of a whole Run (nothing sent, archived or interrupted), cancel of a
  stopped task with its dependents, host reads that failed are read again and the Run goes on by
  itself, old events are compacted into the checkpoint, new work stops near a ledger limit.
- Limits made real: policy.run.failedTasks stops new dispatches when too many tasks failed;
  policy.run.strategicTurns counts the coordinator's plan request and each re-plan.

What it does not do (documented in the README and decided in docs/next-phase-plan.md)
- No approval from the Runs page, no cancelling one task while a member works on it, no re-assigning
  a task, no automatic retry after a message was dispatched, no resuming an interrupted launch.
- It does not react to a member's Agent being closed or archived mid-turn: do not do that while a
  Run is live.

Contract
- Ledger schema stays v2 (reads v1 and v2); no prompt template changed since f1f1e48; 28 RPCs.

Verification
- biome (2 existing warnings), tsc, vitest 201 files / 3370 passed (3 todo), verify:package and
  test:coverage pass. Acceptance status per scenario: docs/run-engine-acceptance.md.
- Not done: a run against a real DEV daemon with real models and a real browser. Merge with a merge
  commit (not squash) so the feat and fix commits reach the changelog.
```

## 4. 发布说明草稿

```text
Run Engine (experimental, off by default)

New: Runs page controls for an Engine Run (replan, retry, cancel a task, kick, pause, resume, add
turns, cancel the Run), reasons for every wait, a Team editor section for the Engine block, and a
launch dialog that says what an Engine launch is doing. The failed-task limit and the coordinator's
turn budget in the Team's Run engine policy are now enforced.

To use it: start the daemon with PASEO_AGENT_TEAM_RUN_ENGINE=1 and switch the Engine on for a Team.
Teams without it run as before. See the README, "Run Engine (opt-in)".

Known limits: no approval from the Runs page; no cancelling one task while a member is working on
it; no re-assigning; no automatic retry after a dispatch; an interrupted launch is closed with an
alert, not resumed. Do not close or archive a member's Agent while a Run is live.

Rollback notes
1. Do not roll back while an Engine Run is live. A version that does not know ledger schema v2
   (v0.5.0 and earlier write v1 only) leaves a v2 Run's file untouched, but cannot see which files
   that Run holds, so it refuses to grant new write claims to any Run, in any repository.
2. Rolling back to a version between "cancel a stopped task" (A3) and "cancel the Run" (A5) lets a
   Run whose cancel was requested be resumed: the older code does not know the cancel request.
   Always roll back to a version before both, or to this one.
3. Compacted history is not recoverable. v1 Runs that are live are not migrated.
```

第 2 条的依据：A3 `a456eb0`（暂停与续办 RPC）与 A5 `940fca6`（延迟取消）必须同一版本发布，否则 A3 的续办会续上已请求取消的 Run。整分支合并就满足这一点（第 5 节命令核对）。

## 5. 合并前检查清单

下面每条命令都已在统计时运行，结果是当时的真实输出；合并前请在最终 HEAD 上重跑。

| 检查 | 命令（在 `paseo-agent-team/` 下，除非另注） | 结果（HEAD `5209eea`） |
| --- | --- | --- |
| 格式与 lint | `npx biome check .` | 通过，仅 `tests/run-core/r01g-core.test.ts` 的 2 条既有警告 |
| 类型 | `npx tsc --noEmit -p .` | 通过 |
| 测试 | `npm test` | 201 个文件，3370 通过，3 todo |
| 包内容 | `npm run verify:package` | 通过 |
| 覆盖率（CI 也跑） | `npm run test:coverage` | 通过，行 91.85%（门槛 90）、函数 90.52%（门槛 85） |
| A3 在待合并范围内 | `git merge-base --is-ancestor a456eb0 HEAD`（仓库根） | 退出码 0（是祖先） |
| A5 在待合并范围内 | `git merge-base --is-ancestor 940fca6 HEAD`（仓库根） | 退出码 0（是祖先） |
| 工作树干净 | `git status --short`（仓库根） | 无输出 |
| 无临时产物 | `git status --short --ignored`（排除 `node_modules`） | 无输出。`test:coverage` 会留下被 `.gitignore` 忽略的 `paseo-agent-team/coverage/`，跑完已删除；没有探针脚本、日志、`.playwright-mcp/` |
| 没改版本与变更日志 | `git diff 5533722..HEAD -- paseo-agent-team/package.json paseo-agent-team/paseo-plugin.json paseo-agent-team/CHANGELOG.md .release-please-manifest.json` | 无输出 |
| 合同不变量 | 见下 | 见下 |

合同不变量的命令与结果：`grep -n "RUN_SCHEMA_VERSION =\|RUN_SUPPORTED_SCHEMA_VERSIONS" paseo-agent-team/shared/schemas/run-engine/ledger.ts` 得 `2` 与 `[1, 2]`；`git diff f1f1e48..HEAD --stat -- paseo-agent-team/shared/domain/run-engine/prompt-template.ts paseo-agent-team/shared/domain/run-engine/engine-prompts.ts paseo-agent-team/shared/domain/prompt-compiler.ts paseo-agent-team/server/designer/prompt.ts paseo-agent-team/server/templates` 为空（退出码 0，无输出）；`paseo-agent-team/tests/server-entry.test.ts` 断言 28 个 RPC，通过。

CI 在 `.github/workflows/ci.yml`，对本插件跑 `npm run check`、`typecheck`、`test`、`test:coverage`、`verify:package`，并且有名为 `CI sentinel` 的汇总作业（分支规则要求它）。当时本机尚未在 CI 环境运行过；这两次发布是否经过 CI，见开头的“发布结果”（v0.6.1 合并后 `main` 的 CI 成功）。Windows 上 `version-flow` 与 `ledger-real-fs` 并行时偶发 `EBUSY`，单独重跑通过，Linux CI 上不应出现。

## 6. 合并方式建议

用 **merge commit，不用 squash，不 cherry-pick，不分批**：整分支一次合并，A3 与 A5 自然同版本；本分支的 17 条 feat 和 7 条 fix（连同 `main` 上已有的）才能分别进入变更日志。若一定要 squash，标题必须以 `feat(run-engine):` 开头（第 3 节标题即是），否则 release-please 不会算出 minor 版本，并且所有 feat/fix 细节都会从变更日志里消失。合并后由 release-please 开发布 PR，用户检查它生成的版本（预期 0.6.0）和 `CHANGELOG.md` 后自行合并。

## 7. R2（默认开启）的准入条件与一行改动

本阶段**不批准**实施 R2。准入条件（全部满足，由用户或之后的批准会话判断）：

1. R1 已发布，用户自己的真实使用中至少 3 个 Engine Run 跑到 `finished` 或取消完成，期间无 `ledger-refused`、无不变式失败。
2. A12 已完成，两种 Provider 的 6 项验证有记录（补证模板是否被真实模型遵守、`replan` 的提示词、判官重派、重启后 `kick`、S1 在真实宿主上的重查、新界面的真实浏览器、窄屏和断线重连检查）。
3. 验收表无“未覆盖”，所有“需 DEV”项都有 DEV 记录。
4. 真实浏览器的宽屏、窄屏、断线重连检查有记录。
5. 发布说明写明第 4 节的三条回滚注意。
6. 用户逐条勾选 `docs/run-engine-iteration-plan.md` 第 9 节。

到时的形状：`paseo-agent-team/server/run-engine/runtime.ts` 里 `const supported = env[RUN_ENGINE_ENV] === "1";` 改为“未设置 = 开启，`0` 或 `false` = 关闭”，同时改同文件“never by default”的注释、`tests/run-engine/runtime.test.ts` 里 “is supported only when the daemon sets …=1” 那一例、`index.server.ts` 里相应的注释与 README 的第一步；Team 的 `runEngine` 块仍然只在编辑器里点开关才写入。当前工作树里该行位于 `runtime.ts:97`，改之前以 grep 为准。

## 8. 残余风险清单（来自 `docs/next-phase-plan.md` 5.2，随本分支实际结果更新）

| 没做的事 | 残余风险 |
| --- | --- |
| A12 DEV 真实验证（整体） | 补证模板、`replan` 的 v4 提示词、判官重派在真实模型上是否被遵守没有证据；重启后 `kick`、S1 重查在真实宿主上没有证据；新界面的真实浏览器、窄屏、断线重连没有证据；AC12、AC22 保持“部分”，AC15 也因没有 DEV 保持“部分”。缓解：README 标明 Engine 是实验性 opt-in；R2 默认开启在 A12 完成前不得进行 |
| B13 完整续办 | 启动崩溃窗口里已创建未登记的 Agent 只能靠告警人工找，需重新启动 Run |
| 在途成员的归档式取消 | 不能在不等回合结束的情况下取消单个在途任务；整个 Run 的取消要等在途回合结束 |
| `assign-seat` | 席位不可用导致任务卡住时，只能取消任务，不能改派 |
| B7 派发后自动重试 | 瞬时供应商错误要人点重试 |
| B8 推送式失效 | 页面最多滞后一个轮询周期（详情 5 秒、列表 10 秒） |
| `nextAttemptAt`、`waitingCode` | 页面看不到“下一次重试时间”（本就只有秒级） |
| 补报清理加固 | 多次补报且旧补报送达不明时，可能误把在途补报当作已结清 |
| 成员回合中被关闭或归档 | 任务与 Run 取消可能一直等；README 有警告，`driver.test.ts` 有 known limitation 现状测试，A12 探针可取证 |
| AC20 异常记录 | 无归属的活动被静默忽略，不报警、不核对资源 |
| 发布、合并、推送 | 由用户执行；本阶段产物不保证已被任何用户使用 |

A13、A14、A15、A16、A17 都已完成，没有撤回，所以计划 5.2 里“A13/A14 若撤回”的两行不适用。`TeamEditor` 本身仍未挂载测试（它依赖整个宿主），接线靠 `RunEngineSection` 的挂载测试加源码扫描。

两份独立评审（DeepSeek：正确性与回归；Grok-4.6-High-Fast：合同与回滚）和另一模型会话的独立重跑门禁由协调者另行安排，结果不在本文，合并前应先有。

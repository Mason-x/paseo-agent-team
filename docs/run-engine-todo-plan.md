# Run Engine 剩余待办与待修：裁决与执行计划（2026-11-09）

编写：2026-11-09，Opus 5.5 max（会话模型 `claude-opus-5-5`）。本会话只读核实，没有改仓库里任何文件，没有运行 daemon、paseo 命令或 python。
基线：`main` = `0787c6c`（v0.6.1 已发布；v0.6.0 由 `1de0a2c` 手工发布）。插件根目录 `paseo-agent-team/`；下文路径除 `docs/`、`.github/` 外都相对它。
授权：用户已授权本文裁决所有待批准事项、先后顺序和做法；协调者照本文执行，拿不准的事按第 7 节发 SendMessage 回问我，不问用户。
与旧文的关系：本文取代 `docs/next-phase-plan.md` 里与之冲突的裁决和规则。那份文档第 4 节（门禁、变异检查、三次尝试、安全）和第 6 节的硬约束继续适用，本文第 4 节写明修订和补充。上一轮标为"Opus"的裁决实际出自 Sonnet，本文逐项重审，改动和理由列在 2.2。
任务号：本文写作 T1–T10。写进 `docs/autonomous-notes.md` 和计划 P04 行时加"三轮"前缀（如"三轮 T4a"），以免和笔记里上一轮的 T0–T7 混淆。

## 执行结果（2026-11-10，协调者整理；不改下文裁决）

- **合并的 PR**（均走 PR + CI，merge commit；代码 PR 无管理员绕过）：#15 T2 `6caa304`；#16 T3 `61f788a`；#17 T4a `0fef059`；#19 T4b `16bd298`；#20 T5 `c1f3345`；#21 T6-A `c935724`；#22 T6-B `cd40b44`；#23 T6 docs `4287854`；#18 发布 0.7.0 `4032b84`；#24 T9a `3f11b6d`；#26 T9c `a9d679a`；#27 T9b `67db906`；#28 T8 DEV 记录 `c8f87c5`；#29 T9e `7fd82de`；#30 T9d `c95762b`；#31 T9f `7602134`；#25 发布 0.7.1 `bf89b83`。
- **发布**：v0.7.0（2 feat + 9 fix，`4032b84`，标签与 Release 都在，zip 1024823 B）；v0.7.1（8 fix 0 feat：T9a、T9b×2（含收尾）、T9c×2、T9d、T9e×2、T9f；`bf89b83`，zip 1042116 B，Release 正文追加回滚注意）。两次发布都是 Release Please PR 无检查 → 以 Mason-x 关闭再打开 → CI 绿 → 合并，**没有管理员绕过**；0.6.1 的绕过仍只在 `docs/release-process.md` 记录。
- **测试数**（分支 HEAD 门禁；文件/通过/todo）：T1 基线 202/3407/3；T4a 204/3475；T4b 206/3543；T5 207/3559；T6-A 207/3583；T6-B 207/3595；T9a 211/3701；T9c 213/3712；T9b 213/3920；T9e 216/3969；T9d 合并后 3985；T9f 217/4015/3。最终 `main`（`bf89b83`，v0.7.1）由 Grok 独立重跑：biome、tsc、`test:coverage`、`verify:package`、`package:release` 退出码均为 0；217 个文件 / 4015 通过 / 3 todo；行覆盖 92.54%、函数覆盖 91.75%；schema 仍为 2（支持 [1,2]）、RPC 仍为 28、提示词模板相对 `0787c6c` 无 diff；自 v0.7.0 起 8 fix / 0 feat / 无破坏性标记。
- **撤回**：无。T4a、T4b、T5、T6、T9a–T9f 都已合并；T6 三项都做了。
- **DEV 结果**：共 13 个 Engine Run（T8 6、T9v 4、R″ 3），模型只用 claude-haiku-5-5 与 gpt-6-luna；浏览器是 Playwright Chromium（宽 1440/窄 390，不是真实 Chrome）；每项 N=1。T8：E、P、I、B、V2′ 有记录，L/R 与 T4a/T4b 假设不符（宿主先发 `turn_ended`），F 跳过。T9v：T9a/T9b/T9c 通过，`host-lost` 未出现，规划被打断的 Run 永久 `bootstrapping`，R-kill 未做。R″：T9d/T9e 通过，L1′ 回归通过；R″-B 没走到 Run finished，T9f 未再上 DEV。细节见计划第 85、89 点与 `docs/run-engine-acceptance.md` 的 DEV 记录栏。
- **违规记录**：3 个会话误跑 python/python3（T4a 修复轮 `python3 --version`；T4b 修复轮 `python --version` 与 `python -`；T9c `python3 --version` 与 `python -`），均未执行脚本，进程已杀、无残留；其余会话无。
- **已接受的残余**（压缩；完整清单见第 6.3 节与 `docs/run-engine-acceptance.md`）：回合未知时被关闭不结算；关闭失败不结算；Windows 孤儿进程；被结算回合的报告不入账；已归档成员的席位本 Run 不能再用；协调者计划回复不在重查范围；B13、B7、B8、`run.export`、`assign-seat`、策略字段编辑入口按 2.1 推迟；AC20 不做异常记录；发布 PR 的 CI 靠关闭再打开触发；回滚到 0.6.x 的 `member-lost` 决策显示“重试”（误导）。另外：重启后从未跑过回合的成员永久 closed，只能取消重来；`SeatRead` 没有 archived 标志；引擎恢复是惰性的；T5 草稿不跨 daemon 重启；浏览器不是真实 Chrome；R″-B 的取消停在 paused（原因未查）。
- **下一批第一项**：(a) 拒绝 closed 席位前先设法重新打开（先查清重启后哪个宿主调用把生产者变回 idle，对从没开过回合的 Claude 成员是否有效，要上 DEV 验证）；(b) 打不开的成员只能给席位重建 Agent（需冻结启动规格并换绑席位，是合同变化；B13 触发条件视为已满足，下一批重新裁决）。V2′ 已证明：同一个幂等键在 daemon 重启后仍返回同一个 Agent，同键不同参数会报 `agent_request_key_conflict`，所以给席位重建 Agent 必须换一个新键。
- **R2（默认开启）**：Opus 裁决不开（`PASEO_AGENT_TEAM_RUN_ENGINE=1` 仍然需要设置，再在 Team 里打开）。下面这张合并后的准入表取代第 2.3 节（2.3 正文不改）；下次评估只看这张表，全部满足后再回问 Opus。2026-11-10 交付时按 T11g 第 3 条重写了第 4 行、第 7 行，并更新其余行到当时可说的范围；默认仍关闭，默认开启的草稿 PR 见 `docs/run-engine-delivery.md` 第 8 节。

| # | 条件 | 现状 |
| --- | --- | --- |
| 1 | L、R 在真实宿主上各 N≥1 | 满足：L1′ 两次，R″ 一次；T11d（优雅重启与 R-kill）、T11e（Run A/B）、T11e2（A′/B′）在真实宿主上又补了样本。T9d 的“有 closed 回执”分支已由 T11e Run A 与 T11e2 的 A′ 在 DEV 上走到（B′ 是无回执的 `host-read` 分支）。缺口：“读取用尽后 20 秒内 kick 零写入”仍只有离线证据 |
| 2 | 补证在两种 Provider 的生产者上各 N≥1 | 满足（T8-E）；交付时未变 |
| 3 | 用户自己的真实使用中，至少 3 个 Engine Run 跑到 finished 或取消完成，期间没有 ledger-refused，也没有不变式失败 | 未统计。只能来自用户自己开 Engine 使用，团队不代跑；由用户在 Runs 页看，或直接告知。交付时没有统计，不写成已满足 |
| 4 | 在符合条件的版本上，从用户在真实实例启动的第一个 Engine Run 起至少 7 天，没有新的“Run 卡死”类缺陷（D10-A） | 观察期，交付时没有统计到已起算的观察期（团队不代跑，也不读真实实例）。7 天从用户在真实实例上、于符合条件的版本启动的第一个 Engine Run 起算；符合条件的版本是 0.8.0 及以后，现有残余都不属“Run 卡死”类；观察期内出现这类缺陷，就从修复它的版本上第一个真实 Run 重新起算。第 3 行不满足前，7 天没有意义 |
| 5 | 验收表里没有“未覆盖”；AC12、AC15、AC22 都有 DEV 记录 | 满足（只就状态列而言）：表里没有“未覆盖”；AC12、AC22 有 DEV 记录；AC15 由 T11d V4 补了 DEV 记录（离线构造的损坏、未知版本、接近上限三份台账放进 DEV：前两份字节不变并被报告，第三份只写 1 条告警、零派发）。缺口：AC15 不是完整 Run 的样本，其余各项多数仍是“部分” |
| 6 | T9a 在 DEV 上验证过 | 满足（T9v） |
| 7 | 一个跨越 daemon 优雅重启的 Run 跑到 finished，且重启时至少有一个还没开过回合的 Codex 成员（例如评审） | 拿不准，不写成已满足：T11d V1 跑到 finished，重启时有一个从没开过回合的 Codex 评审并被重建；但 V1-3 的“由 Engine 重新打开生产者”未证明（浏览器先点开旧式成员卡把它打开了），V1 成功的前提是协调者已加载（推断，未验证）。R2 合并前需要 0.8.1 的 DEV 样本（优雅重启、协调者不重新规划、带一个从没开过回合的 Codex 评审），否则回问架构师 |

- **预批准合同变化**：只有 T4a/T4b（B14 修改后批准：引擎自行写结束回执并开决策，T4b 的 outcome 为 `host-lost`）与 T9a 的 `#n` 后缀键（同回合 id 的第 n 次出现）；T9b–T9f 合同变化为零（schema、RPC、提示词模板、台账字段均未改）。

## T11 执行结果（2026-11-10，协调者整理；不改下文裁决）

- **合并的 PR**（均走 PR + CI，merge commit，无管理员绕过）：#33 T11c `d66216d`；#35 T11a `79240db`；#36 T11b `dff9451`；#37 T11e `37b41bd`；#38 T11e2 `d6af29f`；#34 发布 0.8.0 `73a9178`。撤回：无。
- **发布**：v0.8.0（1 feat + 13 fix；其中一条标题重复，来由是 #37/#38 用默认合并正文合并，按裁决不手改）；发布提交 `73a91784e8931da11d1aa26a403e3cf9419d3204`，标签、Release 与 zip 都在；发布后 main 的 CI 绿。
- **测试数**：发布提交上由 Grok-4.6 独立重跑门禁：220 个文件 / 4297 通过 / 3 todo，行覆盖 92.73%；schema 仍为 2（支持 [1,2]）、RPC 仍为 28、提示词模板相对 `0787c6c` 零改动。
- **DEV 结果**（每项 N=1/Run；模型只用 `claude-haiku-5-5` 与 `gpt-6-luna`；浏览器是 Playwright Chromium，不是真 Chrome；omp 无样本）：
  - T11d 5 个 Run（5/5 用满）：V1 大部分通过，但有两处限制——V1-3 的“由 Engine 重新打开生产者”未证明（浏览器先点开旧式成员卡把它打开了），V1-7 只看到已解决的重建告警，seat-closed 告警没有构造出来；V2 部分——Codex 生产者优雅重启后开出的是 `member-lost` 而不是 `host-lost`，Claude 评审的 `host-lost` 与重试通过，“用尽后 20 秒内 kick 零写入”没测到，V2-6 未达成（重试后的评审回合被拿去做了 V3）；V3 做了但与预期不符——强杀后开出 `member-lost`，对象是评审回合，不是 Claude 生产者；V4（AC15）通过——损坏与未知版本的台账字节不变并被报告，接近上限只写 1 条告警、零派发。
  - T11e 2 个 Run：Run A 通过（`host-lost`、重试、finished）；Run B 未 finished（强杀后，一个从没跑过回合的 Codex 评审被宿主列为 idle，派发停在 `outcome-unknown`，取消停在 paused、占用保留）。
  - T11e2 2 个 Run（2/2 用满）：E2a 接受——答复重试后没有 kick，台账自行入账并继续，A′ finished；`≤10 秒` 没有独立宿主时钟，未证实也未证伪；两段 220.356 秒与 186.149 秒的静默期间生产者回合在跑，判为不是 60 秒规则所称的“停顿”，原始数值保留。E2b 部分通过——读历史失败、旧 Agent 零派发（部分佐证）、有告警、取消走到 `cancelled`（rev 38）并释放占用；未达到新评审完成与 finished。B′ 的重建因宿主 `Caller agent … not found` 记为 `create-failed`，只能取消重开。
- **已接受的残余**：完整清单见 `docs/run-engine-delivery.md` 第 3 节。交付后要单独跟进的是 0.8.1 的 T11b 分类窄修复（M1 之后、M2 之前，带 1 个 DEV Run），尚未开始。
- **过程记录**（不改结论）：T11e2 的 B′ 有一次 kick 与派发措辞冲突（发生在答复前）、一次 5.121 秒采样间隔、00:16 之后到取消之间没有采样、取消晚于 20 分钟约 58 分钟、一次 `pdev --version` 未显式带 `--home`、总墙钟超过 1.5 小时；两个探针空目录被占用；6767 的 PID 从 26508 变成 12100，原因未知，记为未解释事件。T11d 的 Run 5 由执行者人工 `git revert` 后答复重试，该 Run 的 `attempts=2`、`reworkCount=1` 与 T11c 无关；T11d 开始时主检出的 `node_modules` 已损坏，之后修复。
- **下一批第一项**：0.8.1 的 T11b 分类窄修复。M1 同任务对照尚未开始，没有对照数据。

## 0. 摘要

### 0.1 裁决要点
- **本批修复两个会让 Run 永远卡住的缺陷**：成员在回合中被关闭或归档（A1），以及宿主重启后丢失在途回合（A2/B14）。两者用同一个机制解决：由引擎结算宿主已经无法结束的回合（T4a、T4b）；B14 按修改后的形状批准。依据是本次核实的宿主源码（事实 5）：
  - 关闭或归档 Agent 时，宿主不保证给插件发这一回合的 `turn_ended`；
  - `agent.closed` 只在会话成功关闭后才发出；
  - Engine 建成员时带了 `parentAgentId`，归档协调者会级联归档这些成员。在侧栏点一次归档就能冻结整个 Run，连取消都完成不了。
- **小缺陷**：原因草稿在轮询中丢失（T5，先写现状测试，确认后再修）、version-flow 的 EBUSY（T3）、三个小修（T6）。
- **关闭**：补报清理加固（B-1）、告警被确认后重开（不可达）、`run.approve`、`run.reconcile`、`reject`、B8、B10 余项。
- **推迟**（各带触发条件）：B13 完整续办、`run.export`、`assign-seat`、B7、策略字段的编辑入口。在途成员的"归档式取消"不再单独做，T4a 提供手动路径。
- **流程**：Release Please 不加令牌或 App。合并发布 PR 前，以 Mason-x 身份关闭再打开这个 PR，让 CI 在它上面运行。管理员绕过只作为发布 PR 的兜底；ruleset 的绕过方式改为"仅限 PR"。以后合并一律走 PR 加 CI，统一用 merge commit，正文改写成非约定式文字。下一个版本预期 0.7.0。
- **验证**：DEV 第二轮（T8）用故障注入构建稳定地诱发补证，并在真实宿主上验证 T4a、T4b、权限对话和空闲。默认开启（B9/R2）本批不开。

### 0.2 任务顺序
T1 基线与工作区 → T2 计划落库、发布事实、流程文档与 ruleset（文档 PR）→ T3 version-flow EBUSY（测试 PR）→ T4a 成员被关闭或归档 → T4b 宿主丢失回合 → T5 原因草稿 → T6 小修合集 → T7 发版 0.7.0 → T8 DEV 第二轮 → T9 DEV 发现的修复与修订版（按需）→ T10 收尾对账、R2 评估与清理。

### 0.3 完工定义（一句话）
T2–T6 已合并，或按规则撤回、关闭并有记录（T4a 撤回须经我裁决）；0.7.0 经由发布 PR 发布，且该 PR 上的 CI 是绿的；main 上 CI 和本地门禁都绿，合同不变量没有被破坏；T8 至少尝试了 L、R、E 三个探针，结果如实记录；文档对账完成；主工作区没被动过；worktree 与 DEV 已清理干净。可以不做的事见 6.2。

## 1. 本文依赖的事实（已逐条核实）

1. **仓库与发布**
   - HEAD 是 `0787c6c`，工作树干净；标签 `paseo-agent-team-v0.6.0` 与 `-v0.6.1` 都在，GitHub release 也各有一个。
   - v0.6.0 由 `1de0a2c` 直推 main，提交说明写着"Actions do not run for this repository, so the release is cut by hand"。之后 PR #12 在 Linux 上 CI 失败，由 PR #13 修好。
   - v0.6.1 来自 Release Please 的 PR #14：作者 `app/github-actions`，`statusCheckRollup` 为空（CI 没有运行），由 Mason-x 用管理员绕过合并。PR 改了 4 个文件：`.release-please-manifest.json`、`paseo-agent-team/CHANGELOG.md`、`paseo-agent-team/package-lock.json`、`paseo-agent-team/package.json`。合并后标签变为 `autorelease: tagged`；main 上 `0787c6c` 的 CI 和 Release Please 都成功。
   - 当前没有打开的 PR。
2. **分支规则**：只有一个 ruleset "Protect main"（id `25953889`，active，作用于默认分支）。
   - 规则内容：禁止删除分支；禁止非快进推送；必须通过 `CI sentinel`（integration `15368`，即 GitHub Actions）；`strict_required_status_checks_policy: true`，即合并前分支必须跟上 main。
   - **没有"必须走 PR"这条规则**。绕过者是仓库 admin 角色（RepositoryRole `5`），`bypass_mode: "always"`，也就是可以直推绕过。
   - 仓库允许 merge、squash、rebase 三种合并方式，没开自动合并，`delete_branch_on_merge` 为 false。
3. **CI**
   - `.github/workflows/ci.yml` 在 `pull_request` 和 push main 时运行。`.github/scripts/detect-affected.mjs` 对定义了 `test:coverage` 的插件**只跑 `test:coverage`**，不跑 `npm test`；覆盖率阈值为行 90、函数 85。
   - 只改 `docs/` 的 PR 会跳过插件作业，`CI sentinel` 仍然成功。
   - `.github/workflows/release-please.yml` 使用默认的 `GITHUB_TOKEN`（没有 `token:` 输入）。GitHub 规定，用 `GITHUB_TOKEN` 触发的事件不会再启动新的工作流（`workflow_dispatch` 和 `repository_dispatch` 除外），所以发布 PR 不跑 CI。由用户身份触发的 `reopened` 事件会正常启动 `pull_request` 工作流。
4. **Release Please 的版本规则**
   - 配置为 node 类型、标签带组件名、`separate-pull-requests`；没有设置 `bump-minor-pre-major` 和 `bump-patch-for-minor-pre-major`。所以在 0.x 阶段：`feat` 升次版本（0.6.1 → 0.7.0），`fix` 升修订号，**带破坏性标记（`!:` 或 `BREAKING CHANGE`）会直接升到 1.0.0**。
   - 合并提交的正文也会被当作提交解析。0.6.1 的变更日志里同一个修复出现了两次：一条来自分支提交 `1c6fbff`，一条来自 PR #13 的合并提交 `154254d`，后者的正文就是 PR 标题 `fix(version): …`。
   - `CHANGELOG.md` 顶部留着一个空的 `## Unreleased`，新条目插在它下面。这只是外观问题，不手改。
5. **宿主如何关闭和归档 Agent**（`node_modules/@getpaseo/server/dist/server/server/`，版本 0.13.0-beta.1）
   - 插件收到的 `agent.turn_ended` 只有一个来源：`agent/agent-manager.js` 的 `dispatchStream`（约 3635–3659 行），而且要求这个 Agent 还在 `this.agents` 里。`plugins/lifecycle/index.js:54-92` 把 `turn_completed`、`turn_failed`、`turn_canceled` 映射成 `turn_ended`。
   - `closeAgentRuntime`（1051–1084 行）的顺序：
     1. 先把已入队的事件处理完，再 `await agent.session.close()`。源码注释写着 "A failed close may still own a native writer"，关闭失败时这里直接抛出。
     2. 然后 `prepareAgentForClosure`（2664–2694 行）：把 Agent 从 `this.agents` 删除并退订会话，只对**内部等待者**回调 `turn_canceled`（`runs.cancelWaiters`）。这条路不经过 `dispatchStream`，插件收不到。
     3. 最后 `emitClosedAgent` 发出 `agent.closed`（2702–2709 行）。

     结论：关闭期间宿主**不保证**发这一回合的 `turn_ended`。只有当 provider 在 `close()` 过程中自己发出事件、而且这个事件恰好在 Agent 被删除之前处理掉，插件才会收到。`agent.closed` 只在会话成功关闭之后才发。
   - `archiveAgentUnlocked`（1101–1134 行）先调用 `markRecordArchived` → `persistArchivedRecord`，后者发出 `agent.archived`（1209 行），**然后**才 `closeAgentRuntime`。所以 `archived` 回执本身不能证明会话已停，`closed` 才能。
   - `cascadeArchiveChildren`（1139–1190 行）：归档一个 Agent 时，会级联归档 `paseo.parent-agent-id` 标签指向它的子 Agent，条件是同一工作区、且子 Agent 没开着标签页（`shouldDetachFromArchivedParent`，268 行）。Engine 建成员时传了 `parentAgentId`（`server/run-engine/start.ts:315`）。
6. **引擎侧现状**
   - `server/run-engine/observer.ts` 把 `agent.closed` 和 `agent.archived` 记成回执（`RECEIPT_KIND`），引擎对它们没有任何反应。`server/run-engine/service.ts:284` 把宿主读到 `closed` 的席位当作 degraded，不再派新活。
   - `shared/domain/run-engine/cancel-request.ts` 的 `planCancelFinish` 对每个在途 assignment 要求：有它之后的 `turn_ended` 回执；那条回执之后没有 `turn_started`；席位读到 idle 或 closed，且没有活动回合。
   - `shared/domain/run-engine/transitions.ts` 的 `isNormalEnded` 只核对回执的 `eventKey`、`kind`、`agentId`、`turnId`、`receivedAt`，以及 `seq <= counters.observationSeq`，**不看 `outcome`**。
   - `server/run-engine/intake.ts:249` 只在 `outcome` 为空或 `completed` 时请求格式重发，其他情况直接 `openLimboDecision`（`decision-answer.ts:278`）。
   - `RunEventReceiptSchema`（`shared/schemas/run-engine/ledger.ts:576-597`）是 passthrough，`kind` 已经包含 `turn_ended`、`closed`、`archived`；`outcome` 本来就是 observer 写入的透传字段。
   - 只允许一个动作的决策已有先例：`EVIDENCE_STUCK_KEY_PREFIX`（`decision-answer.ts:69`）和 `answerableActions`（146 行）。
7. **丢失回合**：回复窗口里找不到派发消息时，`server/run-engine/protocol.ts:229` 给出 `dispatch-not-found`；`shared/domain/run-engine/read-retry.ts:183` 定义了 `LOST_TURN_CODE = "incomplete:dispatch-not-found"`。A21 的现状、人工出路，以及"哪些信号不算证据"，都在 `tests/run-engine/lost-turn.test.ts`。
8. **补报**：格式重发请求明确写着"不要重新做业务工作，不要修改文件、不要提交、不要重跑检查"（`shared/domain/run-engine/engine-prompts.ts:424`）。assignment 结清时，`report-repair.ts` 的 `settleRepairs` 把它所有的格式重发意图从 outbox 里移除（不分状态），审计事件里保留状态。补证请求是另外的 assignment，不经过这里。
9. **补证门**：只有 `missing`、`duplicate-id`、`command`、`ref-mismatch`、`artifact-root`、`isolation` 这六类会自动请求补证（`evidence-repair.ts:31-38`）。证据要求来自任务的 `spec.evidence`：DAG 里每项有 `id`、`command`，可选 `minLines`、`minFunctions`、`requiresIsolatedHome`（`gates.ts:191-239`）。A12 想靠角色说明诱导模型犯错，没有成功，模型优先遵守派发事实。
10. **原因输入框**：`client/runs/engine/EngineView.tsx:451-468` 在状态不是 `ready` 时不渲染 `EngineControls`（`unchanged` 返回 null，其他状态显示状态卡），控件随之卸载。`EngineControls.tsx:177` 起的草稿是组件内部 state。`client/shared/ImeTextInput.tsx` **刻意做成非受控**，以保护中日韩输入法的组字，并支持 `initialValue` 填初值、`revision` 重挂载。所以任何一次非 `ready` 的轮询结果（读取失败、断线）都会清掉草稿。改成受控输入会破坏输入法，不能这样修。
11. **EBUSY**：`tests/version-flow.test.ts:31-33` 的 `afterEach` 用 `rm(root, { recursive: true, force: true })`，没有设 `maxRetries`；`tests/spec/ledger-real-fs.spec.test.ts:457` 已经用了 `maxRetries: 5, retryDelay: 50`。
12. **列表首屏**：Engine 成员和协调者链路用同一套标签（`shared/paseo/labels.ts` 的 `teamLabels`）。在 Engine 列表第一次返回之前，客户端无法从标签区分这两类 Run。
13. **文档**：`docs/run-engine-iteration-plan.md` 第 270 行是 P04 实施记录（单行，约 101 KB），最后一点是第 74 点（A21），**下一条是第 75 点**。第 9 节在第 278 行，没有勾选。
14. **主工作区与旧 worktree**：`F:\tools\paseo-agent-team` 是真实实例（127.0.0.1:6767）加载插件的目录，插件有自己的版本切换功能（`server/version/*`，会在安装目录里执行 git 操作）。`C:\Users\cc\.paseo\worktrees\1ku6d0d9\` 下约有 70 个旧 worktree，它们的 `paseo-agent-team/node_modules` 都是指向主工作区 `node_modules` 的 junction。
15. **门禁基线**（用户提供，T1 复核）：202 个文件，3407 通过，3 todo；biome 只有 `tests/run-core/r01g-core.test.ts` 的 2 条既有警告；tsc 和 `verify:package` 通过；Windows 上并行运行时，version-flow 偶尔报 EBUSY。

## 2. 裁决

### 2.1 裁决表

| 编号 | 事项 | 裁决 | 理由 | 去向 / 重新评估的触发条件 |
| --- | --- | --- | --- | --- |
| A1 | 成员在回合中被关闭或归档，引擎没有反应 | **批准修复**（推翻上一轮的"本阶段不修"） | 事实 5、6：宿主不保证发 `turn_ended`；`closed` 意味着会话已关；归档协调者会级联冻结整个 Run | T4a |
| A2 | 宿主重启丢失在途回合，只有人工出路 | **批准修复** | DEV 已真实复现（Run 4）；A21 的出路要人去给成员发消息，多一次模型调用，而且只有离线验证 | T4b |
| B14 | 引擎自己结算丢失的回合 | **修改后批准** | 与 A1 共用"引擎结算回合"机制；释放占用仍须人答复 `cancel` | T4a（机制）、T4b（宿主丢失） |
| A3 / B-1 | 补报清理加固（送达不明的先按回显确认；`closeEndedAttempt` 调用点） | **不批准，关闭**（推翻上一轮的"推迟"） | 被清掉的只有格式重发，而格式重发的提示词禁止改文件、提交和跑检查（事实 8）。迟到的补报最多产生一段文字，不会造成写冲突；加固反而要在两条热路径上加宿主读取 | 触发：`settleRepairs` 扩展到补证请求，或出现补报回合写文件的真实案例 |
| A4a | 告警被确认后又被重新打开 | 不修，关闭 | 没有任何地方会写 `acknowledged`，目前不可达 | 触发：一旦加"确认告警"入口，同一个改动必须让 `raiseAlert` 不再重开 `acknowledged` 的告警 |
| A4b | 暂停期间，失败任务闸的旧告警要等恢复后才清 | 批准小修 | 暂停时取消了失败任务，页面仍显示超限，容易误导；修法只多一次写入 | T6a |
| A4c | `addPlanRequest` 在 already-counted 时报错文案不准 | 批准小修 | 只改抛出的文字 | T6b |
| A4d | Engine 列表首次返回前，Run 按旧方式显示 | 批准小修 | 首屏可能把 Engine Run 显示成"已完成" | T6c |
| A5 | version-flow 在 Windows 上的 EBUSY | 批准（只改测试） | 给清理加重试，消除门禁噪音 | T3 |
| A6 | 原因输入框被轮询清空 | 批准：先写现状测试，确认后再修 | 事实 10 表明这是真实缺陷（状态不是 ready 时控件被卸载） | T5 |
| A7 | 文档数字过期、描述过时 | 批准 | 发布已经完成，交接文档和笔记需要对账 | T2（发布事实）、各任务的文档提交、T10 |
| A8 | Release Please 的 PR 不跑 CI | **修改后批准：不加令牌或 App** | 合并前用 Mason-x 身份 `gh pr close` 再 `gh pr reopen` 触发 CI；绕过只作兜底（见 4.9） | 改用 GitHub App 的触发条件：连续两次关闭再打开都没触发 CI；或每周发版超过 2 次；或用户要求全自动 |
| B13 | 完整续办（冻结 `launch.agentSpecs`） | 推迟（维持） | 收益小，崩溃窗口只有几秒；A8 已经 fail-closed | 触发：T8 的 V2′ 证明同一个键在重启前后返回同一个 Agent，并且出现过真实的启动中断告警 |
| — | 在途成员的归档式取消（新 RPC） | **关闭**（推翻上一轮的"推迟"） | T4a 之后，人在 Paseo 里归档这个成员，引擎就会结算回合并开出只能取消的决策，取消后释放占用，不需要新 RPC | README 写明代价：已归档成员的席位在本 Run 里不能再用 |
| — | `run.approve` | 不批准（维持关闭） | 没有任何流程会产生审批 | — |
| — | `run.reconcile` | 不批准（维持关闭） | kick 已经包含对账 | — |
| — | `run.export` | 推迟（维持） | 没有使用方 | 触发：出现诊断导出需求，届时必须只读且脱敏 |
| — | 决策答复 `reject` | 不批准（维持关闭） | 台账里没有区别于 `cancelled` 的终止状态 | — |
| — | 决策答复 `assign-seat` | 推迟（维持，触发条件修订） | 需要任务级的席位字段 | 触发：T4a 上线后，出现"席位的 Agent 已归档，人想改派而不是取消"的真实案例 |
| B7 | 派发后的临时失败自动重试 | 推迟（维持） | `turn_failed` 只带 `error.code` 和 `message`（事实 5），没有"有没有执行过工具"的信号 | 触发：宿主提供失败阶段字段，或 T8 的探针 F 在两种 Provider 上取得能区分的样本 |
| B8 | 服务端推送式失效 | 不批准（维持，等 SDK 升级） | SDK 仍是 0.13.0-beta.1 | 触发：新版 SDK 出现服务端推送或订阅接口 |
| B10 | `nextAttemptAt`、`waitingCode` | 不批准（维持关闭） | 唯一的定时器间隔是 1、2、4 秒；T4b 的 30 秒门槛靠人点 kick，不产生需要展示的截止时间 | 触发：出现 60 秒以上的自动截止 |
| — | 预算、DEV 目标、evidenceRoot 的界面编辑入口 | 推迟（推翻上一轮的"不批准"） | README 已写明 JSON 形状；DEV 冒烟是本插件自身开发的真实需求，但还没有真实 Run 被它挡住 | 触发：真实 Run 因 `dev-target-missing` 无法接纳，或用户提出 |
| C1 | 补证模板从未在真实模型上触发 | 批准：用故障注入构建做确定性探针 | 事实 9：靠模型犯错不稳定；只在仓库外的临时构建里注入，永不合并 | T8-E |
| C2 | 真实权限对话与人的重复操作 | 批准（N≥1） | AC12 只有一次被动样本 | T8-P |
| C3 | 长时间空闲 | 批准（≥60 分钟，被动观察） | AC17 目前只有假时钟证据 | T8-I |
| C4 | 更大样本 | 批准，有上限 | 每项 N≥2；对适用的项，两种 Provider 各至少一次 | T8，总量上限见 T8 |
| C5 | A21 出路的 DEV 验证 | **改为验证 T4b**，A21 的人工出路顺带验一次 | T4b 取代 A21 成为主要出路 | T8-R |
| C6 | 默认开启 Engine（B9/R2） | 本批不开 | 准入条件没满足：补证 N=0、真实用户 Run 没有统计、T4 没经过 DEV | 准入条件见 2.3；满足后协调者回问我 |
| D1 | 发版节奏 | 批准规则 | 见 4.9 和 T7 | T7、T9 |
| D2 | 合并一律走 PR 加 CI | 批准 | 见 4.3 | 所有任务 |
| D3 | 管理员绕过 | 修改后批准：只给发布 PR 兜底；ruleset 的绕过方式改为 `pull_request` | 防止再出现 `1de0a2c` 那样的直推 | T2 修改 ruleset；规则见 4.9 |

### 2.2 对上一轮裁决的修订（逐条）

1. **成员在回合中被关闭**（next-phase-plan 2.12，原为"本阶段不修"）→ 批准修复（T4a）。
   - 原因：当时以"宿主会不会发 `turn_ended` 没有证据"为由不修。现在已从宿主源码核实（事实 5），并且发现级联归档让这种情况一次点击就能发生。
   - 原定的"归档成员看宿主发哪些 hook"探针，改由 T8-L 做端到端验证。
2. **B14**（autonomous-notes 第二轮待批准，原为"推迟，等触发"）→ 修改后批准（T4b）。
   - 原因：DEV 已真实复现；A21 的人工出路要人去和成员对话、多花一次模型调用，而且只有离线证据。B14 和 T4a 共用同一个机制，增量很小。
   - 修改一：原文的"两次间隔不少于 30 秒的 `dispatch-not-found`"改为"读取重查用尽之后，至少隔 30 秒的又一次 `dispatch-not-found`"。引擎不新增定时器，等下一次 kick、hook 或恢复触发。
   - 修改二：允许"重试"，因为成员还活着。
3. **补报清理加固**（next-phase-plan 2.11，原为"推迟"）→ 关闭。原因见裁决表 A3 行。
4. **在途成员的归档式取消**（next-phase-plan 2.3，原为"推迟"）→ 关闭，由 T4a 提供手动路径。
5. **策略字段的编辑入口**（next-phase-plan 2.13，原为"不批准"）→ 推迟，带触发条件。
6. **对外动作**（next-phase-plan 2.7、2.16、4.3 与 A19：实施会话不做；合并和发布由用户执行）→ 实施会话仍然不做对外动作；改由**协调者**按 4.3、4.9 推送分支、开 PR、合并和发版（用户已授权）。禁止像 `1de0a2c` 那样手工发版，禁止直推 main。
7. **模型分工**（next-phase-plan 4.6）→ 按用户这次的指定更新（见 5.1）：Grok 用 Grok-4.6-Xhigh（omp），排障用 GPT-6.1 Terra Max（omp）；所有会话一律用 Paseo `create_agent` 按配置创建，并核对实际模型（见 4.7）。
8. **合并方式**（A19 建议 merge commit）→ 保留 merge commit，但合并提交的正文必须改写成非约定式文字，避免事实 4 里的重复条目。
9. **门禁**（next-phase-plan 4.1）→ 增加一条：开 PR 前跑一次 `npm run test:coverage`，因为 CI 跑的就是它，而且带阈值。
10. **主工作区**（next-phase-plan 4.7"绝不碰主工作区与 main"）→ 保留并加强：main 只通过 GitHub 上的 PR 合并来改变；主工作区是真实实例的安装目录，不 pull、不切分支、不写文件、不放笔记。
11. **R2 准入条件** → 修订，见 2.3。
12. **合同变更的处理**（next-phase-plan 4.5"登记，不实施，不提问"）→ 改为"不实施，回问我"（见 4.5）。用户已授权由我裁决，我会作为同一会话被唤醒，所以不必让需求在笔记里一直等。

### 2.3 R2（默认开启）的准入条件（修订版）
以下条件全部满足后，协调者回问我，由我裁决开不开、怎么开。
1. T4a、T4b 已经发布，并且 T8-L、T8-R 在真实宿主上各至少通过一次。
2. 补证（T8-E）在两种 Provider 的生产者上各通过一次。
3. 用户自己的真实使用中，至少 3 个 Engine Run 跑到 `finished` 或取消完成，期间没有 `ledger-refused`，也没有不变式失败。统计方式：只读调用真实实例的 `agent-team.run.list`（或看 Runs 页），不读写台账文件；Engine 没开启就记为 0。
4. 0.7.x 发布后至少 7 天，没有发现新的"Run 卡死"类缺陷。
5. 验收表里没有"未覆盖"，AC12、AC15、AC22 都有 DEV 记录。

到时的改法：
- `server/run-engine/runtime.ts` 的 `supported` 改为"没设置就开启，设为 `0` 或 `false` 才关闭"，同步修改同文件注释、`tests/run-engine/runtime.test.ts` 的对应用例、`index.server.ts` 的注释和 README 的第一步。
- Team 的 `runEngine` 块仍然只在编辑器里点开关才写入。也就是说，"默认开启"只让 daemon 默认支持 Engine，没有启用的 Team 行为不变。灰度就天然发生在 Team 这一层。
- 单独开一个 `feat(run-engine): …` 的 PR，发次版本；发布说明写明回滚办法（设置 `PASEO_AGENT_TEAM_RUN_ENGINE=0`）。

## 3. TODO

**每个任务共同遵守**：
- **合同不变量**：
  - `RUN_SCHEMA_VERSION` 仍是 2，`RUN_SUPPORTED_SCHEMA_VERSIONS` 仍是 `[1, 2]`；
  - 不新增回执种类、reducer 事件种类或 RPC（RPC 仍是 28 个，`tests/server-entry.test.ts`）；
  - 不改提示词模板：`shared/domain/run-engine/prompt-template.ts`、`engine-prompts.ts` 里的模板正文、`shared/domain/prompt-compiler.ts`、`server/designer/prompt.ts`、`server/templates`；
  - v1 的活动 Run 不迁移。

  T4a、T4b 获批的合同变化只限于它们各自列出的那些。
- **新写路径**：每条新写路径在 v1 和 v2 记录上各跑一遍，`schemaVersion` 不变，本次没碰的字段逐字节不变（照 `tests/run-engine/ledger-versions.test.ts` 的写法）。新的原因码、告警和决策 kind 都要有中文，`tests/run-view/waiting.test.ts`、`controls.test.ts` 的穷举测试不得削弱。
- **提交要能单独通过门禁**：被 `readme-facts.test.ts` 断言的 README 句子，改动和测试放在同一个代码提交里；被验收表引用的用例如果改名或反转，验收表的引用也在同一个提交里更新。这样每个提交单独跑门禁都是绿的。
- **分支与提交**：每个任务一个分支、一个 PR，至少两个提交：代码加测试一个；文档一个（计划 P04 行从第 75 点起加一条，笔记加一行进度和检查结果，更新验收表）。
- **门禁 G**：在 `paseo-agent-team/` 下运行 `npx biome check .`（只允许那 2 条既有警告）、`npx tsc --noEmit -p .`、`npm run test:coverage`（包含全量测试）、`npm run verify:package`。迭代中可以先用 `npm test`，开 PR 前必须跑过 G。

### T1｜基线与工作区（不提交）
- **目标**：建立本批唯一的实施 worktree，复核门禁和 CI 的数字，建立状态文件。
- **依赖**：无。
- **做法**：
  1. 协调者用 Paseo `create_workspace` 给本仓库建一个 worktree 工作区；如果该工具不能指定基点，就用 `git -C F:\tools\paseo-agent-team worktree add C:\Users\cc\.paseo\worktrees\1ku6d0d9\run-engine-todo -b todo/base origin/main`。之前先 `git fetch origin`，确认 `origin/main` 是 `0787c6c`；如果用户这期间合并过东西，就以新值为基线并记下来。
  2. 协调者接 junction：`cmd /c mklink /J <wt>\paseo-agent-team\node_modules F:\tools\paseo-agent-team\paseo-agent-team\node_modules`。用 `cmp` 确认 `<wt>\paseo-agent-team\package-lock.json` 和主工作区的逐字节相同；不同就停下回问我。
  3. 一个 DeepSeek 会话（只读）跑门禁 G，输出写到 `C:\Users\cc\AppData\Local\Temp\next-todo\logs\t1-*.log`，只读末尾；记录文件数、通过数、todo 数和覆盖率。
  4. 协调者运行 `gh run list --branch main --limit 3`，确认 main 最新提交的 CI 是 success。
  5. 协调者按第 8 节模板建状态文件。
- **验证**：数字与事实 15 一致；不一致时以实测为准并记录。
- **DEV**：否。**预算**：一个 DeepSeek 会话。**提交/合并/发版**：无。
- **回滚**：按 4.6 的顺序删除 worktree。

### T2｜计划落库、发布事实对账、流程文档与 ruleset
- **目标**：把本文放进仓库；让发布交接文档和笔记反映 v0.6.0、v0.6.1 的真实发布情况；写下以后的 PR 和发布流程；把绕过方式收紧为只能经由 PR。
- **依赖**：T1。
- **改动文件**（只改文档）：
  - 新增 `docs/run-engine-todo-plan.md`：逐字复制 `C:\Users\cc\AppData\Local\Temp\next-todo\plan.md`。
  - `docs/next-phase-plan.md` 第 1 行之后加一行：`> 2026-11-09：本文的裁决与规则已由 docs/run-engine-todo-plan.md 重审，冲突处以后者为准（修订清单见其 2.2 节）。`
  - `docs/release-handoff.md` 开头加一节"发布结果"：
    - 写明 v0.6.0：2026-11-08 由 `1de0a2c` 手工直推发布；v0.6.1：PR #14，CI 没有运行，用管理员绕过合并于 `0787c6c`，合并后 main 的 CI 成功。
    - 用命令重算 `paseo-agent-team-v0.5.0..paseo-agent-team-v0.6.0` 的提交数和 feat、fix 数，命令和结果都写上。
    - 注明"以下第 0–8 节是合并前的材料（统计基准 `5209eea`），保留作记录，数字不再更新"。
    - 第 5 节里"本机尚未在 CI 环境运行过"一句，改为指向发布结果。
  - 新增 `docs/release-process.md`：写入 4.3、4.9 的流程（分支、PR、合并命令、发布 PR 的 CI 触发办法、绕过条件、版本规则、回滚），以及一节"绕过记录"，追认 `1de0a2c` 与 PR #14 两次，并写明以后不再重复。
  - `paseo-agent-team/AGENTS.md` 末尾加一行：`Merges and releases: follow ../docs/release-process.md (PR + CI only, no direct push to main).`
  - `docs/autonomous-notes.md`：开头说明加一句，指向新计划；进度表加两行（发布 v0.6.0、v0.6.1）；"待批准（第二轮）"的 B14 条目末尾加一句"2026-11-09 已由 `docs/run-engine-todo-plan.md` 修改后批准，见 T4a、T4b"。
- **不改**：任何源码和测试、`CHANGELOG.md`、版本文件。
- **ruleset**（对外动作，由协调者在 PR 合并后执行）：
  1. `gh api repos/Mason-x/paseo-agent-team/rulesets/25953889 > <状态目录>\ruleset-before.json`。
  2. 用 node 从 before 里只取 `name`、`target`、`enforcement`、`bypass_actors`、`conditions`、`rules`，把 `bypass_actors[0].bypass_mode` 从 `always` 改成 `pull_request`，其余原样，写到文件里。
  3. `gh api -X PUT repos/Mason-x/paseo-agent-team/rulesets/25953889 --input <文件>`。
  4. 再 GET 一次，保存为 `ruleset-after.json`；用 node 比较两份文件里的这六个字段，只允许那一处不同。
  5. 如果 PUT 失败，或差异不止一处：用 before 的内容 PUT 回去，回问我。
- **测试**：`git diff --check`；`acceptance-doc.test.ts`、`readme-facts.test.ts` 不受影响。
- **验证**：PR 上 `CI sentinel` 成功。因为改了 `paseo-agent-team/AGENTS.md`，`detect-affected` 会把插件判为受影响，插件作业会在 Linux 上跑全量 coverage；只改 `docs/` 的 PR 才会跳过。**DEV**：否。
- **预算**：一个 DeepSeek 会话写文档；协调者负责开 PR、合并和修改 ruleset。
- **提交/合并/发版**：分支 `todo/t2-plan-docs`，一个 `docs:` 提交，开 PR，CI 绿后按 4.3 合并。不发版（docs 不进变更日志）。
- **回滚**：开 revert PR；ruleset 用 before 的内容 PUT 回去。

### T3｜version-flow 在 Windows 上的 EBUSY（只改测试）
- **目标**：消除 `tests/version-flow.test.ts` 在 Windows 并行运行时清理阶段的 EBUSY。
- **依赖**：T1。可以和 T2 错开时间并行（不同分支，同一时刻只有一个写者）。
- **改动**：
  - 把第 31–33 行的 `rm(root, { recursive: true, force: true })` 加上 `maxRetries: 10, retryDelay: 100`。Node 对 EBUSY、EPERM、ENOTEMPTY 会重试。
  - 改之前，先 grep 确认这些临时目录里不建 junction 或符号链接（已知 version-flow 不建）。
  - 不顺手改其他文件；`ledger-real-fs` 已经有重试。
- **验证方式**（这是测试基础设施改动，不做变异检查，改为稳定性验证）：
  - 用 node 循环脚本（放在 `Temp\next-todo\scripts\`）连跑 `npx vitest run tests/version-flow.test.ts` 20 次；再在后台连跑全量 `npm test` 3 次，输出写日志。全部都不能出现 EBUSY。
  - 如果仍然出现：第一次失败时记下堆栈指向的具体步骤（可能是被测代码 spawn 的子进程还没退出）；第二次尝试改为在清理前等子进程退出；第三次还失败就撤回，记为残余（门禁沿用"单独重跑通过即可"）。
  - 最后 CI（Linux）要绿。
- **DEV**：否。
- **预算**：一个 DeepSeek 会话实施；Grok-4.6-Xhigh 只读复核 diff（实施者不能评审自己的改动）。
- **提交/合并/发版**：分支 `todo/t3-version-ebusy`，提交 `test(version): retry the temp-dir cleanup that Windows can hold busy`，开 PR，按 4.3 合并。不单独发版（`test:` 不进变更日志）。
- **回滚**：开 revert PR。

### T4a｜成员在回合中被关闭或归档：引擎结算这一回合，开只能取消的决策（A1）
- **目标**：成员 Agent 在回合中被关闭或归档后（包括归档协调者引起的级联），只要宿主能证明会话已经关闭，引擎就把这一回合记为结束，并开出一个只能"取消"的决策。人答复取消后，释放占用、级联取消下游任务；整个 Run 的取消（A5）也能完成。全程零发送、零归档。
- **依赖**：T1；建议在 T2、T3 合并之后开工，先用它们预热流程。
- **获批的合同变化**（只限这些）：
  1. **引擎写的回执**：在 `eventReceipts` 里加一项 `{ kind: "turn_ended", agentId, turnId, eventKey: "turn_ended:<agentId>:<turnId>", dedupeKey: <同 eventKey>, disposition: "observed", outcome: "agent-closed", settledBy: "engine", basis: { closedBy: "receipt" 或 "host-read", closedReceiptKey } }`。
     - `outcome`、`settledBy`、`basis` 都是透传字段：不改 `ledger.ts`，不升版本，不加回执种类。
     - **必须经过 observer 现有的回执追加路径写入**，使用同一套 `seq`、`counters.observationSeq` 记账和去重，不许手工拼数组（否则 `isNormalEnded` 会失败）。
     - `eventKey` 和宿主本来会写的那条相同，所以迟到的真实 `turn_ended` 会被当作重复丢弃。
  2. **决策**：沿用 D1 的 limbo 决策（`openLimboDecision`），加一个新的 `kind` 字符串 `member-lost`（A10 的 `kind` 本来就是开放字符串）。`answerableActions` 对它只给 `cancel`。原因码 `member-lost`，中文的为什么、谁来处理、下一步写进 `shared/zh/` 里对应的表。不新增决策类别，不新增 RPC。
  3. **席位**：有 `archived` 回执的 Agent 所在的席位，本 Run 里不再派活，拒绝原因 `seat-archived`（要有中文）。只关闭、没有归档的，沿用现状：宿主读到 closed 时 degraded，读到 idle 时可用。
- **结算条件**（全部满足才写）：用纯函数 `shared/domain/run-engine/lost-turn.ts` 的 `findClosedTurns(record, seats)` 判定；服务端在一次 `store.update` 里同时写回执和开决策。
  - a. 这个 assignment 在等报告，它的派发意图是 `confirmed`。
  - b. 回合已知：该 Agent 有晚于 `assignment.createdAt` 的 `turn_started` 回执；如果 assignment 有 `turnId`，必须是同一个回合。回合未知的不结算（列为残余，见 6.3）。
  - c. 这一回合没有 `turn_ended` 回执。
  - d. 有会话已关闭的证据：在这次 `turn_started` 之后，该 Agent 有 `closed` 回执；**或者**本次宿主读取明确给出 lifecycle `closed`。只有 `archived` 回执不算（事实 5：归档发生在关闭之前）。
  - e. 在那之后没有该 Agent 的 `turn_started`。
  - f. 本次宿主读取可读（不是 `unreadable`），并且没有活动回合。读到"不存在"算作没有活动回合；读取失败不算。
- **开工第一步**：读 `server/run-engine/host.ts` 和宿主 `@getpaseo/server` 里读取 Agent 的路径，确认已关闭、已归档的 Agent 读出来是什么（status 的值、会不会抛错、有没有 `archivedAt`），写进笔记。如果和上面 d、f 的假设不符，停下回问我。
- **触发时机**：driver 收到 `agent.closed`、`agent.archived` hook 时，像收到 `turn_ended` 一样给对应的 Run 跑一遍；kick 和恢复时跑的那一遍也要检查。空闲的那一遍不写任何东西。
- **报告**：被引擎结算的回合，其回复**永不入账**，即使回复里有合法的报告块。入账路径遇到 `settledBy: "engine"` 的结束回执就直接跳过。理由：这个回合是被切断的，成员之后可能还有没做完的动作。
- **与已有路径的配合**：如果真实的 `turn_ended`（例如 provider 在关闭时发出的 `canceled`）先到，就不写引擎回执，但决策同样只给 `cancel`。`answerableActions` 的判定依据是"这次回合开始之后，该 Agent 有 `closed` 或 `archived` 回执"，而不只看 kind。
- **改动文件**（预期）：
  - 新增 `shared/domain/run-engine/lost-turn.ts`；
  - `server/run-engine/observer.ts`：把回执追加函数暴露给引擎，或新增 `appendEngineReceipt`；
  - `server/run-engine/driver.ts`：收到 closed、archived 时跑一遍；
  - `server/run-engine/intake.ts`：跳过引擎结算的回合；
  - `shared/domain/run-engine/decision-answer.ts`：按回执限制可选动作；
  - `server/run-engine/service.ts`：加 `seat-archived`；
  - `cancel-request.ts`、`server/run-engine/cancel.ts`：只在核实发现"读到不存在"需要算作静止时才改；
  - `shared/zh/*`；
  - `README.md`：替换第 198 行起"Do not close or archive …"那一段，写明新行为、已归档的席位不能再用，以及**Run 进行中不要归档协调者，它会连带归档成员**；
  - `tests/readme-facts.test.ts`；验收表的引用。

  不碰：`ledger.ts`、`reducer.ts`、`transitions.ts` 里的证明谓词、提示词模板、`plan-repair.ts`、`dag.ts`。
- **测试**：v1、v2 各一遍；用真实 store、driver 和假宿主。新文件 `tests/run-engine/member-closed.test.ts`；纯函数测试放在 `tests/run-engine/lost-turn-plan.test.ts`（`lost-turn.test.ts` 这个名字已被 A21 占用）。
  1. 成员回合中先收到 `archived` 再收到 `closed`，宿主读到 closed：恰好写一条引擎回执（`outcome: agent-closed`、`settledBy: engine`），开一个 `member-lost` 决策（只给取消），宿主零 send、零 archive；之后再来 5 遍 hook 和 kick，修订号不变。
  2. 只有 `archived`、没有 `closed`，宿主读到仍在运行：不结算；之后收到 `closed`：结算一次。
  3. 没有任何 hook，但 kick 时宿主读到 closed：结算，`basis.closedBy` 为 `host-read`。
  4. 宿主读取 `unreadable` 时不结算；读到活动回合时不结算；`closed` 之后又有新的 `turn_started`（人把它重新打开并让它干活）时不结算。
  5. 回合未知（没有 `turn_started`）：不结算，行为与今天相同，作为残余固定下来。
  6. 真实的 `turn_ended(canceled)` 先到，再收到 `closed`：不写引擎回执，决策只给取消。
  7. 结算之后，迟到的真实 `turn_ended(completed)` 带着合法报告：被当作重复，报告不入账，决策不变。
  8. 答复取消：占用释放，下游任务级联取消，宿主零发送，Run 能结束。
  9. 整个 Run 的取消（A5）：成员被关闭后，取消完成一次。这条用例取代 A16 的 known-limitation 用例 "known limitation: a member closed in the middle of its turn is not noticed…"。这是合同变化，在同一个提交里修改，验收表的引用同步更新。
  10. 归档协调者引起级联：两个成员都在回合中，`archived` 和 `closed` 依次到达，两个回合各结算一次，A5 的取消能完成。
  11. 结算后，被归档成员的席位不再被选：另一个就绪任务需要同类席位时，拒绝原因是 `seat-archived`，有中文。
  12. 中文穷举、README 事实测试、验收表测试和 `ledger-versions.test.ts` 都通过。
- **变异检查**（必做，至少 14 项）：没有 `closed` 证据也结算；只有 `archived` 就结算；宿主读到运行中也结算；把 `unreadable` 当作已关闭；`closed` 之后有 `turn_started` 仍结算；回合未知也结算；引擎回执换用别的 `eventKey`（迟到的真实回执会造成第二条）；不经 observer 追加（`observationSeq` 不前进）；决策给了重试；真实 canceled 先到时决策给了重试；被结算回合的报告入账；同一回合结算两次或开两个决策；空闲的那一遍写入；不经人答复就释放占用；被归档成员的席位仍然被选。
- **回滚演练**（手工，结果写进记录）：
  - 用 `git archive` 把 T4a 之前 main 上的 `paseo-agent-team/shared/` 取到仓库外的临时目录（junction 按 4.6 处理）。用旧版 `RunRecordSchema` 解析带引擎回执和 `member-lost` 决策的 v1、v2 记录，确认解析通过，`checkLedgerInvariants` 也通过。
  - 旧版 `answerableActions` 会对这种决策给出"重试"：用旧代码跑一次派发构建器，确认不会真的发送。
  - README 写上回滚注意："回滚到 0.6.x 后，未答复的成员失联决策会显示'重试'；不要选，它只会被席位拒绝，不会发送。"
- **验证**：离线测试；DEV 验证放在 T8-L。
- **预算**：Sonnet 至多 2 个会话、3 次尝试；DeepSeek 做一次重跑和正确性评审；Grok-4.6-Xhigh 做一次合同与回滚评审；修复至多一轮，外加一次有限复查。
- **提交/合并/发版**：分支 `todo/t4a-member-closed`。代码提交 `feat(run-engine): settle a member's turn when Paseo closes or archives it mid-turn`，提交正文写明合同变化和回滚注意；另加一个 docs 提交。开 PR，两份评审通过后按 4.3 合并，随 T7 的 0.7.0 发布。
- **撤回**：三次尝试都不过时，撤回未合并的改动（见 4.4），保留 README 里的警告，并**回问我**。这是本批最重要的缺陷，不能悄悄放弃。

### T4b｜宿主丢失在途回合：30 秒后的又一次检查由引擎结算（A2/B14）
- **目标**：宿主重启丢掉在途回合、读取重查用尽之后，人点"立即检查并推进"时，如果条件满足，引擎把这一回合记为"宿主丢失"，并开出普通的 D1 决策（可以重试，也可以取消），不需要再给成员发消息。A21 的人工出路仍然有效：如果成员自己的回执先到，就按现有路径结算。
- **依赖**：T4a（复用回执追加和结算框架）。
- **获批的合同变化**：
  - 引擎回执与 T4a 相同，`outcome: "host-lost"`，`basis` 为 `{ firstNotFoundAt, secondNotFoundAt, seatStatus }`。
  - 决策 `kind: host-lost`，原因码 `host-lost`，动作沿用 D1 limbo 决策现有的动作（重试、取消等）。
  - 新常量 `LOST_TURN_SETTLE_DELAY_MS = 30_000`。README 写出这个数，由 `readme-facts` 核对。
- **结算条件**（全部满足）：
  - a. 这个 assignment 的回复读取重查条目已经用尽，原因是 `incomplete:dispatch-not-found`（即 A21 的状态）。
  - b. 用尽之后又读了一次（由 kick、hook 或恢复触发，不新增定时器），仍然是 `dispatch-not-found`，而且距这个条目最后一次失败至少 30 秒。
  - c. 派发意图是 `confirmed`。
  - d. 有这一回合晚于 `createdAt` 的 `turn_started`，之后该 Agent 没有 `turn_started` 或 `turn_ended`。
  - e. 宿主读到该 Agent `idle`，没有活动回合。如果读到 closed，就走 T4a，开 `member-lost` 决策。
  - f. 没有未结清的送达（`sending` 或 `outcome-unknown`）。

  满足时，在同一个提交里写回执、开决策，并把 A21 的用尽告警置为 resolved。
- **A21 告警文案**：用尽且原因是丢失派发时，提示改为："至少等 30 秒后点'立即检查并推进'：如果该成员在 Paseo 里空闲，引擎会把这一回合记为宿主丢失并开出决策（重试或取消）。"旧的两种摘要写法仍要能被识别并解除，沿用 A21 的兼容写法。这是告警文字，不是提示词模板。
- **改动文件**（预期）：
  - `shared/domain/run-engine/lost-turn.ts`：加 `findLostTurns`；
  - `server/run-engine/observer.ts`、`read-retry.ts`：拿到已用尽的条目和再次读取的结果；
  - `server/run-engine/driver.ts`；
  - `shared/domain/run-engine/read-retry.ts`：改提示文字；
  - `shared/zh/*`；
  - `README.md` 的恢复一节；
  - `tests/run-engine/lost-turn.test.ts`：把 "known limitation: the reads of the lost reply are used up, a kick writes nothing…" 改为"30 秒内 kick 不写，30 秒后 kick 结算一次"。这是合同变化，在同一个提交里改，验收表的引用同步更新。
- **测试**（v1、v2 各一遍）：
  1. 用尽后第 29 秒 kick：零写入、零发送；第 31 秒 kick：恰好一条 `host-lost` 回执、一个决策，告警 resolved；再 kick 不写。
  2. 答复取消：占用释放，Run 能结束。
  3. 答复重试：按现有 D1 重试的语义，同一个 Agent 恰好收到一条消息，不重复；成员回复后正常入账。
  4. A21 里五种"不算证据"的情形都不结算：别人的回执、早于创建时间的回执、之后又有 `turn_started`、宿主读到不是 idle、送达没结清。
  5. 人先按 A21 发了 OK，成员自己的回执先到：不写引擎回执，取消按现有路径完成。
  6. 宿主读到 closed：走 T4a。
  7. 假时钟下没有新增定时器，`vi.getTimerCount()` 不变。
- **变异检查**（至少 10 项）：不等 30 秒；不要求重查用尽；不要求再次 `dispatch-not-found`；宿主不是 idle 也结算；送达没结清也结算；没有 `turn_started` 也结算；之后有 `turn_started` 仍结算；告警不撤；重试发了两条；新增了计时器；读到 closed 却开了可重试的决策。
- **回滚演练**：做法同 T4a。旧代码把 `host-lost` 回执当作普通的回合结束，决策也是普通的 D1，旧代码的行为与新代码一致。
- **验证**：离线测试；DEV 验证放在 T8-R。**预算**：Sonnet 1–2 个会话；评审安排同 T4a。
- **提交/合并/发版**：提交 `feat(run-engine): let a check after 30 seconds settle a turn the host lost`，开 PR，评审后按 4.3 合并，随 0.7.0 发布。
- **撤回**：三次不过就撤回，A21 的人工出路仍是唯一出路，记为残余。不必回问我。

### T5｜原因草稿在轮询中不丢（A6）
- **目标**：重新规划、取消任务和取消 Run 这三处的原因草稿，在轮询返回非 ready（读取失败、断线、`unchanged` 交接）再恢复之后仍然保留。
- **依赖**：T1。可以在 T4a 评审期间做，但同一时刻只能有一个 Sonnet 写者。
- **第一步：现状测试**（`tests/run-view/engine-controls-draft.test.ts`，沿用 `react-test-renderer` 和 `vi.mock("react-native")` 的写法）：挂载持有轮询状态的父组件（Runs 详情容器）或 `EngineView`。输入原因（触发 `onChangeText`），让状态变成非 ready，再回到 ready（新对象、同一个 Run），断言输入框里仍是草稿，提交时发出的也是这个原因。三种原因各写一例。
- **若现状测试是红的**（预期如此）：
  - 把三个草稿从 `EngineControls` 提到轮询状态变化时不会卸载的父组件里，按 `runId` 分键保存（取消任务的草稿再加上 `decisionId`）。
  - 草稿作为 `initialValue` 传给 `ImeTextInput`，用 `onChangeText` 回写；提交成功后清掉对应的键；切换到别的 Run 时草稿不串。
  - **不得**把 `ImeTextInput` 改成受控输入。
- **若现状测试是绿的**：说明这不是产品缺陷（自动化填写时没有触发 `onChangeText`）。只提交现状测试，关闭 A6 并记录。
- **变异检查**：草稿不上提（还原成现状）；提交后不清草稿；键里不含 `runId`（会串到别的 Run）；把输入改成受控（应当被一个新断言抓住，例如"组字期间不回写 value"）。
- **验证**：离线测试；T8 用真实浏览器停起一次 DEV daemon，看草稿是否还在。**预算**：Sonnet 1 个会话；DeepSeek 重跑和评审。
- **提交/合并/发版**：提交 `fix(runs-page): keep a typed reason when a poll briefly loses the Run`，开 PR，合并，随 0.7.0 发布。
- **回滚**：开 revert PR。

### T6｜小修合集（A4b、A4c、A4d；三项可以各自撤回）
- **T6a 暂停期间撤下已经回落的失败任务闸告警**：在 `server/run-engine/service.ts` 的派发入口处，对 `paused` 的 Run，只有当存在未解除的失败闸告警、而且 `failedTaskLimit(record).exceeded` 为假时，才写一次 `resolveAlerts`；其他情况一概不写（保证 AC17）。
  - 测试：暂停中取消失败任务，告警变为 resolved，Run 不恢复、不发送；暂停的空闲那一遍不写；`finished`、`cancelled` 的 Run 不处理。
  - 变异：超限时也撤告警；每一遍都写；对已结束的 Run 也写。
- **T6b**：`shared/domain/run-engine/run-record.ts` 的 `addPlanRequest` 对 `already-counted` 和 `exhausted` 抛出不同的文字（"the plan request was already counted…" 与 "the coordinator has no turn left…"）。两种情况各写一个测试；变异：把两句对调。
- **T6c 列表首屏**：`client/runs/*` 里的 `buildRunRows` 在 Engine 列表查询还没返回时（pending、没有数据、没有错误），凡是按标签推断会显示"已完成"的行，改为显示中性的"读取中"。查询返回后照现在的逻辑；查询出错时也照现在，回落到按标签推断。
  - 测试：三种状态各一例。
  - 变异：pending 时仍显示已完成；出错后一直显示读取中。
- **依赖**：T4a 合并之后再做（T6a 和 T4a 都改 `service.ts`，避免冲突）。
- **预算**：Sonnet 1 个会话；DeepSeek 重跑和评审。
- **提交/合并/发版**：每项一个 `fix(...)` 提交，外加一个 docs 提交，放在一个 PR 里。某项三次不过，只撤那一项并记录。随 0.7.0 发布。
- **回滚**：开 revert PR。

### T7｜发版 0.7.0
- **依赖**：T2–T6 都已合并，或按规则撤回；main 最新提交的 CI 是绿的。
- **步骤**（协调者执行）：
  1. 用 `gh pr list --label "autorelease: pending"` 找到 Release Please 的 PR。`gh pr diff <n> --name-only` 应当只列出事实 1 里那 4 个文件。读 CHANGELOG 的片段：版本是 0.7.0（因为有 feat），条目和已合并的 PR 一一对应，没有重复。如果有重复，说明当初合并时没有按 4.3 改写正文；记下来，但不手改。
  2. 以 Mason-x 身份 `gh pr close <n>`，再 `gh pr reopen <n>`；然后 `gh pr checks <n> --watch`，等 `CI sentinel` 成功（插件作业会在 Linux 上跑全量 coverage）。10 分钟内检查没有出现，就再关闭、打开一次；仍然没有，按 4.9 的绕过条件判断。
  3. 合并：`gh pr merge <n> --merge --subject "Merge pull request #<n> from Mason-x/release-please--branches--main--components--paseo-agent-team" --body "Release PR; changelog generated by Release Please."`。
  4. 等 main 上的 Release Please 工作流完成，确认 `gh release view paseo-agent-team-v0.7.0` 存在、标签存在，main 的 CI 是绿的。
  5. 可选：在 GitHub release 正文末尾追加"Rollback notes"（T4a 的回滚注意）。先用 `gh release view --json body` 取出原文，追加后再 `gh release edit --notes-file`；不改 `CHANGELOG.md`。
  6. 在实施 worktree 里 `git fetch --tags`。**不动主工作区，不对真实实例做 reload 或 update**；用户用插件自带的版本流程去更新。
- **如果 T4a、T4b 都撤回了**：版本会是 0.6.2，步骤相同。
- **回滚**：发布本身不撤。发现严重缺陷时，开 revert PR，再发下一个修订版。README 和发布说明写明怎么回到 0.6.1（在插件的版本流程里选旧版本），以及回滚注意。

### T8｜DEV 真实验证第二轮（C1–C5）
- **前置条件**：T7 已发布，或至少 T4a、T4b 已合并；工作树干净。DEV 环境的细节读 `paseo-agent-team/AGENTS.md`，以及 `C:\Users\cc\AppData\Local\Temp\agent-team-handoff\briefing-p06.md` 的"DEV 环境"一节（这个文件不存在就只读 AGENTS.md）。
- **硬规则**：沿用 next-phase-plan A12 的硬规则：
  - 只用 worktree 下的 `.paseo-dev`；每条命令都显式带 `--home` 或 `--host`，并设置 `PASEO_HOME`；清掉代理环境变量；发命令前复读一遍。
  - Windows 上 `EPERM rename` 导致 daemon 起不来时，最多重试 3 次。
  - 任何 Run 20 分钟没有进展就取消；遇到额度或供应商报错就停。
  - 新建 Profile 时引用本机已有的 Provider 登录，**绝不**复制 `~/.paseo` 里的 Profile 或凭据。
- **上限**：
  - Engine Run 不超过 6 个；墙钟总计不超过 4 小时。
  - 成员和协调者只用 `remote-magpie/auto/claude-haiku-5-5`（除权限探针外用 bypassPermissions）和 `remote-magpie/auto/gpt-6-luna`。
  - Sonnet 的 DEV 会话不超过 2 个（T8a、T8b）。每到一个检查点，就把结果追加到 `C:\Users\cc\AppData\Local\Temp\next-todo\dev-report.md`。
- **探针仓库**：放在仓库外的临时目录，包含一个小 bug、`npm run check`、`npm run lint`，以及 `npm run slow-check`。`slow-check` 打印进度，每 2 秒往 `heartbeat.txt` 追加一个时间戳，持续约 120 秒，用来让成员停在回合中间。
- **探针**（按顺序执行；每项记录 N、模型、成败和证据路径）：
  - **E 补证（C1，确定性）**：共 2 个 Run。
    1. 用 `git worktree add --detach` 在 `Temp\next-todo\probe-e` 取出 T7 的发布提交，按 4.6 接好 junction。
    2. 打一个不提交的补丁：派发消息的编译函数在**第一次尝试**的派发正文里，不列出 id 以 `-probe` 结尾的证据要求。DAG、证据门和补证请求都不改。
    3. 开跑前先离线核对：用同一个夹具编译，派发正文里没有 `lint-probe`，补证请求的正文里有。
    4. 在 DEV 上安装这份构建；用户任务里写明："每个任务需要两项证据：id `check`（命令 `npm run check`）和 id `lint-probe`（命令 `npm run lint`）"。
    5. 期望：生产者第一份报告缺 `lint-probe` → 证据门给出 `missing` → 发出真实的补证模板 → 生产者跑 `npm run lint`，把产物放在证据根下并重新报告 → 通过并进入审查，`evidenceReturns` 为 1。
    6. 跑两次：一次用 claude 生产者，一次用 codex 生产者。如果协调者没把 `lint-probe` 写进 DAG，记为失败并停止这个探针。
    7. 用完后，在 DEV 上 `plugin remove`，换装回实施 worktree 的构建，再按 4.6 删除 probe-e。
  - **L 成员被关闭或归档（验证 T4a）**：共 2 个 Run。
    - L1：生产者跑 `slow-check` 时，用 DEV 的 CLI 归档它。记录宿主发了哪些 hook（看台账里回执的顺序）、有没有出现 `member-lost` 决策和引擎回执，以及关闭之后 `heartbeat.txt` 是否停止增长（这是"会话关闭即停止写入"的直接证据）。答复取消后，确认占用释放、Run 能结束。
    - L2：在另一个 Run 里，两个成员都在回合中时归档协调者。观察是否发生级联、两个回合是否都被结算、A5 的取消能否完成。
  - **R 宿主丢失回合（验证 T4b）**：1 个 Run。
    1. 生产者跑 `slow-check` 时，`daemon stop --home` 再 `start`，然后等读取重查用尽。
    2. 20 秒内 kick，期望零写入；30 秒后再 kick，期望出现 `host-lost` 决策。
    3. 答复重试，确认同一个成员收到新的派发并完成。记录重启后席位读到的状态（idle 还是 closed）。
    4. 时间允许的话，在同一个 Run 里再验证一次 A21 的人工出路。
  - **P 权限（C2）**：1 个 Run。用 codex 的 `auto-review`（或 claude 的非 bypass 模式）生产者触发真实的权限请求。人通过 DEV 的页面或 CLI 批准一次，再对同一个请求批准一次（第二次应当没有效果）。可选：等待期间重启 DEV daemon，恢复后再批准，确认报告只入账一次。
  - **I 空闲（C3）**：最后一个 Run 留一个未答复的决策，静置至少 60 分钟，期间不重启 daemon。确认台账文件的修订号和修改时间不变，成员的时间线里没有新回合。
  - **B 浏览器**：用真实 Chrome 检查 T5（停起一次 DEV daemon 后原因草稿仍在）、T6c（首屏不显示已完成），以及 `member-lost`、`host-lost` 决策的中文和按钮，在宽屏和 390 像素窄屏下各看一次。
  - **V2′（可选，不超过 15 分钟）**：如果能直接用 `@getpaseo/client` 在 DEV 上用同一个幂等键建 Agent，就验证两件事：同键同参数在重启前后是否返回同一个 Agent；同键不同参数时宿主怎么处理。没有直接办法就跳过。
  - **F（可选）**：只有存在廉价办法制造"回合失败但 Agent 已经建好"时才做，否则跳过。
- **清理**（必须做）：
  - 归档 DEV 里建的所有 Agent（只限 DEV）；DEV 上的插件 `plugin remove` 或还原；
  - 按 4.6 删除探针仓库和 probe-e；删除 DEV 的台账和证据目录；`daemon stop --home`；
  - 确认主工作区 `node_modules` 完好：关键文件 `Test-Path` 为真，`npx tsc --version` 能运行。
- **记录**：计划 P04 行接着第 75 点之后往下写，每个探针一条；同步到验收表的"DEV 记录"栏；如实写 N。
- **发现缺陷**：只记录，不在 T8 里改源码，交给 T9。
- **预算**：按上面的上限；Sonnet 2 个会话；不安排评审。
- **提交**：只有一个记录 DEV 结果的文档提交，走 PR。

### T9｜DEV 发现的修复与修订版（按需）
每个缺陷一个分支、一个 PR，规则同 T4–T6：不改合同的直接修；要改合同的回问我。最多两轮。合并后按 T7 的步骤发修订版 0.7.1。没有缺陷就跳过。

### T10｜收尾：文档终对账、R2 评估与清理
- **文档**（走 docs PR）：
  - 验收表逐行按证据对账：改写 AC10、AC14 的缺口；把 T8 的结果写进 AC12、AC17、AC22。状态只在缺口整句被证据关闭时才升级。
  - README 与代码一致。
  - `docs/autonomous-notes.md` 的进度表覆盖 T2–T9，"没做或没做完"同步更新。
  - `docs/run-engine-todo-plan.md` 顶部加一段"执行结果"，不改裁决正文。
  - 计划第 9 节不勾选。
- **R2**：按 2.3 逐条写现状（满足、不满足、证据），用第 7 节的格式通过 SendMessage 发给我。我裁决之前不改默认值。
- **清理**：确认 DEV 已经清理。实施 worktree 保留到用户回来（不删，避开 junction 风险），只确认它是干净的。`Temp\next-todo\` 保留状态文件和日志。
- **给用户的最终回复**（经协调者转达）：合并了哪些 PR、发布了哪些版本，每项的测试数，撤回了什么，DEV 结果（含 N），残余风险（见 6.3），R2 的结论。

## 4. 执行规则

### 4.1 门禁（沿用 next-phase-plan 4.1，补充以下几条）
沿用原来的第 1–6 条，另外补充：
7. 开 PR 之前，在分支的最终 HEAD 上跑一次门禁 G。其中 `npm run test:coverage` 已包含全量测试，可以代替这一轮的 `npm test`；跑完删除被忽略的 `coverage/`。
8. Linux 上的 CI 是合并前的最后一道门禁。本机通过而 CI 失败时，以 CI 为准（见 4.8）。
9. 每个 PR 合并之前，由另一个模型的新会话独立重跑一次门禁 G（一般是 DeepSeek；T3 由 Grok），输出路径写进状态文件。两边结果不一致时，以失败为准。

### 4.2 变异检查协议
沿用 next-phase-plan 4.2：先备份到仓库外；破坏一处 → 确认用例变红 → 还原；逐个文件 `cmp`，并确认输出里有 "ALL RESTORED"。还原只用备份加 `cmp`，不用 `git checkout`、`git restore` 或 `git stash`。
变异清单放在 `C:\Users\cc\AppData\Local\Temp\next-todo\mutations\t<n>.json`。运行器沿用 `C:\Users\cc\AppData\Local\Temp\p05-mutation\mutate.mjs`；如果它不在了，就按原格式重写一份放到新目录。

### 4.3 分支、提交、PR 与合并（修订 next-phase-plan 4.3）
- **分支**：每个任务一个分支，从当时最新的 `origin/main` 切出，命名为 `todo/t<n>-<slug>`。同一个 worktree 同一时刻只有一个写者。
- **提交**：
  - 提交信息用英文，类型遵循约定式提交（`feat`、`fix`、`test`、`docs`、`chore`，可以带作用域）。
  - **禁止破坏性标记**（`!:` 或 `BREAKING CHANGE`）：在 0.x 阶段它会让版本直接升到 1.0.0。
  - 用 `git commit -F <临时目录里的文件>` 提交；末尾署名用该会话被要求的署名行（Sonnet 是 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`）。
  - 改过的文件保持 LF 换行；源文件用 Edit 或 Write 修改。
- **实施会话**只在本地提交：不 push，不开 PR，不合并，不打标签，不改版本文件和 `CHANGELOG.md`。
- **协调者**负责 push 和开 PR：
  - `git push -u origin <分支>`；
  - `gh pr create --base main --title "<约定式标题>" --body-file <文件>`。正文写清做了什么、没做什么、合同变化、测试数、变异与评审记录的路径、回滚办法，末尾加 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`。
- **合并的前置条件**（全部满足）：
  - PR 上 `CI sentinel` 成功；
  - 独立重跑的门禁通过；
  - 任务要求的评审已通过，确认的问题要么已修复，要么已登记为已知限制；
  - 分支跟上了 main。没跟上就用 `gh pr update-branch <n>` 更新，**用合并方式更新，不要 rebase**（文档里引用了分支提交的 SHA），然后等 CI 重新变绿。
- **合并命令**：统一用 merge commit，并把正文改写成非约定式文字，避免变更日志出现重复条目：
  `gh pr merge <n> --merge --subject "Merge pull request #<n> from Mason-x/<branch>" --body "Changelog entries come from the branch commits."`
  不用 squash，不用 rebase，不 cherry-pick。
- **合并之后**：用 `gh run list --branch main --limit 2` 确认 main 的 CI 是绿的。分支保留，不手动删除。
- **直推 main**：禁止。T2 之后 ruleset 也会拦住。

### 4.4 三次尝试与撤回（沿用 next-phase-plan 4.4，补充以下几条）
- **还没合并时**：照原规则撤回（逐个文件 `git restore --source=HEAD`，删除新增的文件，不用 stash）；也可以直接放弃这个分支，切回 base 分支，分支本身保留不删。
- **合并之后才发现问题**：开 revert PR（`git revert -m 1 <合并提交>`），走同样的 CI 和合并规则。
- 撤回 T4a 必须先回问我；其他任务按各自写的规则处理。

### 4.5 合同变更（修订 next-phase-plan 4.5）
预先批准的合同变化只有 T4a、T4b 里列出的那些。其他任何合同变化一律**不实施，回问我**（用第 7 节的格式），等裁决期间先做下一项。合同变化包括：schema、回执种类、reducer 事件种类、台账里新的透传块、RPC、schema 版本、提示词模板、默认开启。

### 4.6 node_modules junction 与目录删除（新增，强制）
- 实施 worktree 和临时 worktree 里的 `paseo-agent-team/node_modules`，是指向 `F:\tools\paseo-agent-team\paseo-agent-team\node_modules`（真实实例的依赖）的 junction。
- **绝不**对含 junction 的目录做递归删除。**绝不**用 `git worktree remove --force`：上一轮正是它顺着 junction 删坏了主工作区的依赖。**绝不**在接了 junction 的 worktree 里运行 `npm ci`、`npm install`、`npm uninstall`、`npm update` 或 `npm run typecheck:beta`（后者会执行 `npm i --no-save`）。
- 删除 worktree 只能按这个顺序：
  1. `cmd /c rmdir "<wt>\paseo-agent-team\node_modules"`，只删 junction；
  2. 确认 `Test-Path F:\tools\paseo-agent-team\paseo-agent-team\node_modules\vitest\package.json` 为真；
  3. 确认 `Get-ChildItem <wt> -Recurse -Force -Attributes ReparsePoint` 输出为空；
  4. `git -C F:\tools\paseo-agent-team worktree remove "<wt>"`，不带 `--force`。如果因为有未跟踪文件被拒绝，先逐个看清楚，再删这些文件；
  5. `git worktree prune`；
  6. 再检查一次第 2 步。
- 仓库外的临时目录（回滚演练、探针用的）同样处理：里面有 junction 就先摘掉。
- 本批不清理那约 70 个旧 worktree。
- 如果发现主工作区的依赖被损坏：立即停止所有会话，回问我。不要自己在主工作区运行 `npm ci`，那是真实实例。

### 4.7 会话创建与模型核对（新增）
- 所有实施、重跑、评审和排障会话，都用 Paseo `create_agent` 在实施工作区里创建，并指定配置（Profile）名。**不用**子代理工具及其模型别名：上一轮标为"Opus"的裁决实际出自 Sonnet，就是别名映射错了。
- 创建后立刻核对实际模型：读 `get_agent_status` 或 `list_agents` 给出的 provider 和 model，并要求会话第一句回复报告自己的模型 id。和配置不符就关掉重建；连续两次不符，回问我。agent id、配置名和实际模型都写进状态文件。
- 不归档还在干活的会话。归档一个父会话会级联归档它建的子会话（事实 5），所以不要归档协调者，也不要归档任何还有子会话在干活的会话。

### 4.8 本机 Windows 与 CI Linux 的差异（新增）
- **不假设平台**：
  - 新测试的路径用 `path.join` 和 `tmpdir()` 构造，不写死 `C:\`。
  - 要测平台相关的路径规则时，显式使用 `path.win32` 或 `path.posix`，并把平台作为参数注入，不靠 `process.platform` 决定期望值。version 测试在 Linux 上失败，正是这个原因。
  - 不依赖大小写不敏感的文件系统，不依赖文件权限位和 `chmod`，不依赖 junction 或符号链接的行为；比较文本时先规范化换行。
- **测试写法**：
  - 临时目录的清理一律写成 `rm(..., { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })`。
  - 与时间有关的测试用假时钟，不用 sleep。
  - Windows 特有的偶发问题（如 EBUSY）只在清理代码里处理，不改被测代码的行为。
- **CI 失败、本机通过时**：用 `gh run view <id> --log-failed` 把 CI 日志写到文件，交给 GPT-6.1 Terra Max 做只读诊断，修复放在同一个 PR 里。不跳过，也不把用例标成 `skip` 或 `todo` 来让 CI 通过。

### 4.9 对外动作的前置条件与核对清单（新增）

| 动作 | 谁做 | 前置条件 | 核对 |
| --- | --- | --- | --- |
| push 分支 | 协调者 | 本地门禁绿、工作树干净、分支名正确 | `git status --short` 为空；`git log origin/main..HEAD --oneline` 只含本任务的提交 |
| 开 PR | 协调者 | 已 push | 标题是约定式，没有破坏性标记；正文写了回滚办法 |
| 合并 PR | 协调者 | 满足 4.3 的合并前置条件 | 合并后 main 的 CI 是绿的 |
| 发版（合并发布 PR） | 协调者 | 完成 T7 的步骤 1、2 | 标签和 GitHub release 都存在 |
| 管理员绕过 | 协调者 | 只限发布 PR，并且以下条件同时成立：关闭再打开了两次，每次等 10 分钟都没出现检查（或者 GitHub Actions 本身故障）；diff 只含那 4 个发布文件；main 最新提交的 CI 是绿的；版本号符合预期 | 合并后 main 的 CI 必须是绿的，不绿就立刻开 revert PR；在状态文件和 `docs/release-process.md` 的"绕过记录"里各记一条 |
| 修改 ruleset | 协调者 | 只在 T2 里改那一处 | before 和 after 两份 JSON 只差那一处 |
| 追加 GitHub release 正文 | 协调者 | 可选 | 先取原文，再追加 |

- **禁止**：删除分支或标签；force push；修改仓库设置（T2 那一处除外）；建令牌、Secret 或 App；对真实实例做任何插件生命周期操作；修改主工作区。
- 代码 PR **绝不**绕过：CI 不绿就修复，或者撤回。
- **发版节奏**：
  - 每批任务合并后发一次（本批就是 T7）；
  - DEV 发现的问题修好后发修订版；
  - 一天之内最多发一次；
  - 每次发版前，自上次发布以来必须有 `feat` 或 `fix` 提交；
  - 不再手工发版。

### 4.10 安全与环境（沿用 next-phase-plan 4.7，补充以下几条）
- **主工作区**：`F:\tools\paseo-agent-team` 是真实实例的安装目录，插件有自己的版本切换。不在那里 pull，不切分支，不写文件，不放笔记；main 只通过 GitHub 上的 PR 合并来改变。在 worktree 里 `git fetch` 会更新共享的引用，但不碰主工作区的文件，可以做。
- **其余沿用原规则**：
  - 不对默认 host 或 `~/.paseo` 做插件生命周期操作；不运行裸的 `paseo reload|restart|daemon stop|daemon restart`。
  - 不运行 python；脚本用 node 写，放在 `Temp\next-todo\scripts\`；在 Bash 里先 `export PATH="/e/Program Files/nvm/v24.18.0:$PATH"`。
  - 不代答权限，不发打断消息，不归档 Engine Run 的成员（T8 的 DEV 探针除外，而且只限 DEV）。
  - 工具提示"已转到后台"时，先核对输出文件是否真的写到了磁盘。

## 5. 模型分工、额度与交接

### 5.1 分工

| 角色 | 配置（Paseo Profile） | 做什么 | 不做什么 |
| --- | --- | --- | --- |
| 裁决 | Opus 5.5 max（本会话） | 只回答通过 SendMessage 发来的裁决请求 | 实施、复核、读大段输出 |
| 协调者 | 现在这个会话（"Run Engine 无人值守：P05–P08"） | 建 worktree；创建并核对会话；派发启动卡；push、开 PR、合并、发版、修改 ruleset；维护状态文件 | 写产品代码或测试；跑全量门禁；读完整的评审或日志（只读结论和路径） |
| 实施负责人 | Claude-Sonnet 5.5 high | T4a、T4b、T5、T6、T8，每个任务一个新会话 | push、开 PR、合并 |
| 叶子实施 | DeepSeek-V4.1-Flash-Max（omp） | T1 的门禁、T2 的文档、T3 的测试 | 评审自己实施的任务 |
| 重跑与正确性评审 | DeepSeek-V4.1-Flash-Max（omp，每次新会话） | 每个 Sonnet 任务合并之前：独立重跑门禁 G，复核变异记录，做正确性与回归评审 | 改文件 |
| 合同与回滚评审 | Grok-4.6-Xhigh（omp）；这个配置不存在时用 Grok-4.6-High-Fast | T4a、T4b；复核 T3 | 不用 Grok-4.7 |
| 排障 | GPT-6.1 Terra Max（omp） | 第二次失败后，或 CI 只在 Linux 上失败时，做只读诊断 | 改文件 |

- 评审只拿到 diff（把 `git diff origin/main...<分支>` 写到文件）和检查单，不给负责人的结论。
- 评审一轮，修复至多一轮，之后至多一次有限复查。
- 任何一个评审人都不能评审自己实施过的任务。

### 5.2 额度
Claude 的 5 小时额度由协调者（如果它是 Claude）、Sonnet 和我共用。
- 同一时刻最多一个 Sonnet 会话；DeepSeek、Grok、GPT 可以和它并行（在不同 worktree，或只读）。
- **协调者**：派发之后等完成通知，或做一次 `wait`，不轮询；每次进入长时间等待之前先更新状态文件。
- **Sonnet 会话**：
  - 改到大约 20 个文件，或上下文用到一半左右，就写交接卡并停下；
  - 每完成一组改动、门禁变绿，就提交，并在状态文件里写一行；
  - 门禁还没绿时不提交，把 diff 存到 `Temp\next-todo\wip\t<n>-<时间>.patch`。
- **碰到 5 小时上限**：协调者记下重置时间，建一个一次性的 heartbeat，在重置后 5 分钟唤醒自己；不重复派发。
- **我**只在第 7 节的触发条件下被唤醒；请求要写得短。
- `Temp` 目录有可能被系统清理。所以每个任务完成后，它的 docs 提交（笔记进度表）里要带上状态文件的任务摘要，让仓库里有一份持久的副本。

### 5.3 交接格式
- **实施会话的交接卡**：写到 `C:\Users\cc\AppData\Local\Temp\next-todo\handoff-t<n>-<序号>.md`，不超过 60 行。包括：
  - 任务和分支；基点 SHA 和当前 HEAD；
  - 已提交的内容（SHA 加一句话）；未提交的改动（文件列表和 patch 路径）；
  - 定向测试和门禁的状态（命令、日志路径、结果）；
  - 变异进度（清单路径，已跑、被抓、存活各多少）；尝试次数；
  - 下一步（不超过 5 条）；已知的坑。
- **协调者**：维护第 8 节的状态文件。上下文被压缩或新开会话后，只需读状态文件、本文里当前任务那一节和最新的交接卡，就能无损地接着做。

### 5.4 实施会话启动卡（协调者复制后填空）
```text
你是 Paseo Agent Team 插件的实施负责人，负责任务 T<n>（见 docs/run-engine-todo-plan.md 第 3 节的 T<n>；仓库里还没有这个文件时，读 C:\Users\cc\AppData\Local\Temp\next-todo\plan.md）。第一句回复请报告你的模型 id。
位置：<worktree>（分支 todo/t<n>-<slug>，基点 <SHA>）。插件在 paseo-agent-team/ 下。
先读：本计划第 3 节的 T<n> 和第 4 节；docs/next-phase-plan.md 第 4 节；<交接卡路径（如果有）>。不要通读仓库。
硬约束：遵守本计划第 4 节的全部规则，尤其是 4.6（junction）、4.3（只在本地提交，不 push、不开 PR、不合并）、4.5（计划外的合同变化不做，写进交接卡，由协调者回问）。
完成标准：T<n> 的测试和变异检查全部完成，门禁 G 全绿，代码提交和文档提交都已完成。然后在 C:\Users\cc\AppData\Local\Temp\next-todo\result-t<n>.md 写下：提交列表、测试数、变异结果（清单路径，被抓和存活各多少）、与计划文字的差异、未决问题。写完就停止。
```

## 6. 完工定义

### 6.1 必须满足
1. T2、T3 已合并；T4a 已合并（撤回须经我裁决）；T4b、T5、T6 的每一项要么已合并，要么已按规则撤回或关闭，并有记录。
2. **发布**：
   - 0.7.0 经 Release Please PR 发布（T4a、T4b 都撤回时为 0.6.2）。
   - 发布 PR 的 head 上 `CI sentinel` 成功，没有绕过；如果绕过了，必须满足 4.9，并有记录。
   - 标签和 GitHub release 都在，之后 main 的 CI 是绿的。
   - T9 如果有修复，同样发修订版。
3. 最终的 main HEAD 上本地门禁 G 全绿，并由另一个模型的会话独立重跑过一次，输出路径记在状态文件里。
4. **合同不变量**：
   - `RUN_SCHEMA_VERSION` 仍是 2，支持 `[1, 2]`；
   - `git diff 0787c6c..origin/main --stat` 对提示词模板文件输出为空；
   - RPC 仍是 28 个，`ledger-versions.test.ts` 通过；
   - T4a、T4b 的回滚演练有记录，没有任何破坏性标记。
5. **变异检查**：T4a、T4b、T5、T6 的变异项要么全部被抓到，要么有"有意冗余"的说明；源码都经 `cmp` 确认已还原。
6. **T8**：至少尝试了 L、R、E 三个探针。DEV daemon 连续 3 次起不来，或者额度耗尽时，可以跳过，但必须如实记录原因。结果写进计划第 75 点之后的记录和验收表的 DEV 栏；DEV 已清理。
7. **文档**：已按 T10 对账一致；计划第 9 节没有勾选；`docs/release-process.md` 里有绕过记录。
8. **环境**：
   - 我们没有在主工作区做过任何写操作：状态文件里没有这类记录，`git -C F:\tools\paseo-agent-team status --short` 为空；
   - 主工作区的 `node_modules` 完好，实施 worktree 干净，仓库里没有临时产物。
9. R2 评估已经发给我，并得到了裁决（预期结论是：不开）。

### 6.2 可以不做也能宣布完工的事

| 不做的事 | 条件 | 残余风险 |
| --- | --- | --- |
| T4b | 三次尝试都不过，撤回 | 丢失回合仍然只有 A21 的人工出路：要给成员发 OK、多花一次模型调用，而且只有离线验证 |
| T5 的修复 | 现状测试证明这不是缺陷 | 无 |
| T6 的任一项 | 三次尝试都不过 | 对应的小问题保留：暂停时的旧告警、不准的报错文案、首屏一个轮询周期内的错误标签 |
| T8 的 P、I、B、V2′、F | 时间或额度不够 | AC12 里人的重复操作、AC17 的真实长时间空闲、真实浏览器里的新文案，以及 B13、B7 的触发条件，都仍然没有证据 |
| T8 的 C4 样本量 | 同上 | 各项可能仍然只有 N=1 |
| T9 | 没有发现缺陷 | — |
| R2 | 准入条件没满足（预期如此） | Engine 仍然要设环境变量才能用 |

### 6.3 已接受的残余风险（本批之后仍然存在）
- **回合未知时被关闭**：成员被关闭时，如果台账里没有这一回合的 `turn_started` 回执，引擎不结算，取消会一直等。出路只有 A21 式的人工办法：给已关闭、但能重新打开的 Agent 发消息。已经归档的没有出路。
- **关闭失败**：宿主关闭会话失败时，原生进程可能还在写文件（事实 5 里的"failed close"）。这时不会有 `closed` 回执，也不会读到 closed，引擎不结算（这是安全的方向）。
- **Windows 上的孤儿进程**：宿主重启后，provider 的孤儿进程可能还在运行。T4b 的结算只能证明宿主这一侧是空闲的。决策文案会提醒人先确认进程已经停止再取消；释放占用仍须人答复。
- **被结算回合里的报告**：即使是合法报告也不入账，人只能取消后重做。
- **已归档成员的席位**：本 Run 里不能再用（没有 resume-seat，也没有 assign-seat）。
- **协调者的计划回复丢失**：仍然不在重查范围内（A7 的残余）。
- **推迟或不做的事项**：B13、B7、B8、`run.export`、`assign-seat`、策略字段的编辑入口按 2.1 推迟；AC20 不做异常记录。
- **发布 PR 的 CI**：要靠人工身份触发（关闭再打开）。GitHub Actions 故障时，按 4.9 绕过，只限发布 PR。
- **回滚到 0.6.x**：未答复的 `member-lost` 决策会显示"重试"。选了也不会发送，但会误导人。

## 7. 遇事不决的裁决规则

### 7.1 协调者可以自己决定的事（事后在状态文件里记一行）
- 任务内的实现细节、测试写法和文件拆分，只要不越过 4.5 的合同边界。
- 在依赖关系允许的范围内微调先后顺序，例如把 T5 提前到 T4a 评审期间做；任务按规则撤回；跳过可选项。
- 评审人不可用时，在 5.1 允许的模型里替换：Grok 不可用，就另开一个 DeepSeek 新会话做合同评审，反过来也一样。不用 Grok-4.7，也不用 Opus。
- 评审意见的取舍：确认的缺陷必须修复或登记为已知限制；纯风格的意见可以不改。
- 满足 4.3 条件的合并；满足 T7 条件的发版；满足 4.9 条件的发布 PR 绕过。
- T8 里 Run 的分配和顺序（不超过上限），以及跳过可选的探针。
- CI 只在 Linux 上失败、而且修复不改变产品行为的情况（例如测试写法、路径处理）。
- 文档措辞和记录格式。

### 7.2 必须回问我的情况
发 SendMessage，这个任务停下，先做下一个不依赖它的任务。
1. 任何不在 T4a、T4b 预批准范围内的合同变化。
2. 宿主行为与本文的假设不符。包括：T4a 开工时核实的结果（宿主读取已关闭、已归档 Agent 时给出什么）与事实 5 或 T4a 结算条件 d、f 的假设不符；或者 T8-L、T8-R 在真实宿主上观察到的行为不符。例如：关闭后 `heartbeat.txt` 还在增长；`closed` 早于会话关闭；引擎在回合仍在运行时把它结算了。
3. T4a 三次失败需要撤回；或者评审指出 T4 的安全语义有问题（不是代码缺陷，而是"该不该结算"本身有问题）。
4. CI 必须改变产品行为才能通过；或者本机和 CI 的结果互相矛盾，GPT 排障后仍然无法解释。
5. 需要管理员绕过但不满足 4.9；任何删除、force push、修改仓库设置（T2 那一处以外）、建令牌、App 或 Secret、动真实实例或主工作区的操作。
6. 主工作区的依赖或真实实例出现异常。
7. 额度明显不够完成本计划，需要重新排期。例如连续两个 5 小时窗口里，Sonnet 都没能做完一个任务。
8. 文档之间、或本文与代码事实之间有冲突，而且影响裁决。
9. R2 准入评估的结果（T10），或者任何默认开启的提议。
10. 用户本人给出与本文冲突的新指示：以用户为准，同时用一句话告诉我，以便我更新裁决。

### 7.3 请求格式
```text
【裁决请求】T<n>｜<一句话说明问题>
事实：1) … 2) …（不超过 5 条，附 文件:行 或日志路径）
选项：A …（后果）；B …（后果）
协调者倾向：A 或 B，一句话理由
阻塞：<哪个任务停着>；这期间在做：<哪个任务>
```
我的回复以"【裁决】"开头。协调者照做，并把裁决原文追加到状态文件的"裁决记录"里。

## 8. 协调者状态文件模板
文件位置：`C:\Users\cc\AppData\Local\Temp\next-todo\status.md`，篇幅控制在一页以内。

```markdown
# Run Engine TODO 状态（最后更新：<ISO 时间>，by <会话 id>）
计划：docs/run-engine-todo-plan.md（= Temp\next-todo\plan.md）｜基线 0787c6c｜worktree：<路径>｜junction：<时间> 已验
当前：T<n> <步骤>｜下一步：<一句话>｜阻塞：<无 / 裁决请求编号>

## 任务
| T | 状态 | 分支 | PR | 代码/文档提交 | PR CI | 独立重跑 | 评审 | 合并提交 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1 | 完成 | — | — | — | main 绿 | — | — | — | <文件数>/<通过数>/<todo 数>；覆盖率 行 <x>% 函数 <y>% |
| T2 | | todo/t2-plan-docs | | | | | — | | ruleset before/after：<路径> |
| T3 | | todo/t3-version-ebusy | | | | | Grok | | |
| T4a | | todo/t4a-member-closed | | | | | DeepSeek+Grok | | 回滚演练：<路径> |
| T4b | | todo/t4b-host-lost | | | | | DeepSeek+Grok | | |
| T5 | | todo/t5-reason-drafts | | | | | DeepSeek | | 现状测试红/绿 |
| T6 | | todo/t6-small-fixes | | | | | DeepSeek | | a/b/c 各自状态 |
| T7 | | — | #<n> | — | 关闭再打开后 绿 / 绕过 | — | — | <sha> | v0.7.0 |
| T8 | | todo/t8-dev-record | | | | — | — | | Run <k>/6，墙钟 <h>/4 |
| T9 | | | | | | | | | |
| T10 | | todo/t10-final-docs | | | | — | — | | R2 请求已发：<时间> |

## 会话
| agent id | 角色 | 配置 | 实际模型（已核对） | 任务 | 状态 | 交接卡/结果 |
| --- | --- | --- | --- | --- | --- | --- |

## 最近一次门禁与变异
- <分支>@<sha>：biome 2 条既有警告｜tsc 通过｜<文件数>/<通过数>/<todo 数>｜覆盖率 行 <x> 函数 <y>｜verify 通过｜日志：<路径>
- 变异 t<n>.json：被抓 <a>/<b>，存活：<列表 + 理由>

## 发布
- 最新版本 v<x>｜发布 PR #<n>｜CI 触发：<时间> 关闭再打开｜绕过：无 / 有（理由，记录在哪里）

## DEV（T8）
- daemon：未运行 / 运行中（--home <路径>，listen <host>）｜Run <k>/6｜墙钟 <h>/4｜报告：Temp\next-todo\dev-report.md
- 待清理：DEV 里的 Agent <数量>、probe-e、探针仓库、DEV 台账

## 额度
- 最近一次触到 5 小时上限：<时间>｜重置时间：<时间>｜heartbeat：<id / 无>

## 裁决记录（追加）
- <时间> 请求 #<k>：<问题> → 【裁决】<原文摘要>

## 日志（追加，一行一件事）
- <时间> <事件>
```

## 附录：推迟项的重新评估触发条件

| 事项 | 触发条件 | 怎么检查 |
| --- | --- | --- |
| B13 完整续办 | T8 的 V2′ 证明同一个键在重启前后返回同一个 Agent，并且出现了真实的启动中断告警 | T8 记录；Runs 页上的告警 |
| `run.export` | 出现诊断导出的使用方 | 用户提出 |
| `assign-seat` | T4a 之后出现"席位的 Agent 已归档，人想改派"的真实案例 | 用户反馈；`seat-archived` 拒绝原因出现在真实 Run 里 |
| B7 自动重试 | 宿主提供失败阶段或"未执行工具"的字段；或探针 F 取得两种 Provider 上能区分的样本 | 新版 SDK 里 `turn_ended` 的类型；T8 记录 |
| B8 推送 | 新版 SDK 出现服务端推送或订阅接口 | 在新 SDK 的 `dist/server`、`dist/client` 里搜 `subscribe`、`emit`、`publish`、`stream` |
| `nextAttemptAt`、`waitingCode` | 出现 60 秒以上的自动截止 | 新增定时器时检查 |
| 补报清理加固 | `settleRepairs` 扩展到补证请求，或出现补报回合写文件的真实案例 | 审查涉及 `report-repair.ts` 的 diff；台账事件 `report-repair-settled` |
| 策略字段的编辑入口 | 真实 Run 因 `dev-target-missing` 无法接纳，或用户提出 | Runs 页或 DAG 接纳的拒绝原因 |
| 告警确认后重开 | 新增写 `acknowledged` 的入口 | 评审时 grep `acknowledged` |
| GitHub App 令牌 | 连续两次关闭再打开都没有触发 CI；每周发版超过 2 次；或用户要求全自动 | 状态文件的发布记录 |
| R2 默认开启 | 2.3 的五条全部满足 | T10 的评估 |

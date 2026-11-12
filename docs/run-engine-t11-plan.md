# 【裁决】T11（Opus 5.5 Max，2026-11-10，协调者原文转录）

T11 是这条线的最后一批：三项代码、一轮 DEV、发 0.8.0、留一个默认开启的草稿 PR、写交付文档。R2 条件 3、4 改为交付后的观察期，不挡交付。本条原文随 T11a 的文档提交放进仓库，路径 `docs/run-engine-t11-plan.md`。

## 一、本次核实的事实（宿主 @getpaseo/server 0.13.0-beta.1 与 main 8788788，只读）
1. 重启后把成员重新打开的，是读时间线这个动作。调用链：`timeline.refetch` → `fetch_agent_timeline_request` → `ensureAgentLoaded`（server/session.js:5894-5910、agent/agent-loading.js:24-83）。Agent 不在内存里时：有 persistence handle 就按 handle 恢复；没有 handle 就按存储的配置开第一个会话，存储的配置会带回 systemPrompt、mcpServers、模型和模式（persistence-hooks.js 的 buildConfigOverrides）。读席位用的 `refresh()` 走 `fetch_agent_request`，只取快照，不会把 Agent 打开。所以 R″ 里只有生产者变回 idle：只有它的回复窗口被引擎读过。
2. 从没开过回合的 Claude 成员能打开。Claude 的会话 id 要到第一个回合的消息流里才拿到，在那之前 describePersistence() 返回 null（providers/claude/agent.js:1776-1787、3912-3936）。没有 handle，读一次时间线就会按原配置新开会话。
3. 从没开过回合的 Codex 成员打不开。Codex 会话建好就 thread/start（codex-app-server-agent.js:3466-3473、4099-4116），第一个回合之前 handle 里已有 thread id，rollout 却要到第一个回合才写。所以 thread/resume 会失败，报 `Failed to resume Codex thread …`（3055-3076），与 R″ 的 `no rollout found` 一致。只能重建。
4. 假空闲：第一个回合开头几秒就被打断的 Claude 成员，会话 id 已拿到，对话还没落盘。恢复时不报错，下一个回合才报 `No conversation found`（R″ Run 1 的协调者就是这样）。所以"读到 idle"不能证明它能用。
5. 惰性恢复是 SDK 的限制：插件启动时拿不到 paseo 句柄，只有 RPC 和 hook 的上下文里才有（plugin/dist/server/contracts.d.ts:8-30）。本批不改，只写进文档。
6. 台账允许换绑。不变式里没有"assignment 的 agentId 必须等于席位当前的 agentId"，invariants.ts 只核对 nonce 条目与 assignment 的一致性，以及 I8（同一个 Agent 不能同时有两个在途 assignment）。现在挡住换绑的只有 bindSeatAgent 本身（run-record.ts:296-321）。launch 是 passthrough，事件的 kind 是自由字符串（ledger.ts:601-608）。所以换绑以后旧 assignment 仍然合法，0.7.x 也能读。
7. MCP 配置可能带密钥：PortMcpServer 有 env 和 headers（port.ts:139-147），冻结规格时不能存明文。
8. 评审被重启打断时，现在只能取消整个任务。openLimboDecision 只在 member-lost 时接受评审或冒烟的 assignment（`!(lost && judge)` 那一行）。按 T9d 的规则，评审有 closed 回执就判 member-lost（只能取消），否则不开决策。结果是生产者已交付的工作也跟着丢掉，比生产者那条路差，本批补上。
9. "R″-B 的取消停在 paused"不是缺陷。t9r2-final-runs/v1/runs/run-mw9wtc1d-n70l.json 是 rev 68、cancelled，completedAt 只比请求晚 60 毫秒；当时看到的 paused 是取消 RPC 的第一个答复。这一条从残余清单划掉。

## 二、范围与完工定义
本批要做：T11a 重新打开已关闭的席位+小修；T11b 重建打不开的成员 Agent；T11c 评审的回合被重启打断时也能重试；T11d DEV 验证；T11e DEV 发现问题的修复；T11f 发 0.8.0；T11g 交付。

本批不做，交付时冻结为已接受的残余：协调者的重建（协调者的第一个规划回合几秒内被打断时只能取消重开）；假空闲（事实 4）；冒烟、补证的丢失回合仍只能取消；惰性恢复（事实 5）；SeatRead 没有 archived 标志；优雅停机有时不写 closed 回执，停机后成员子进程可能还在跑；T5 原因草稿不跨 daemon 重启；浏览器检查不是真实 Chrome；一条派发正在发出时宿主崩溃或重启，而接收方从此再也读不出来（例如从没开过回合的 Codex 成员）：结果未知而冻结，取消这个 Run 也停在 paused，仓库占用一直保留，同一仓库后面的 Engine Run 会一直等；窗口：只有崩溃那一刻正在发出的派发会这样（B′，N=1；窗口未测）；没有 E2b 时，崩溃后向这类成员派发也可能使 Run 冻结；协调者未加载时，重建因宿主错误 `Caller agent … not found` 记为 `create-failed`（`seat-rebuild.ts` 的 `errorCode` 只把消息含 `parent` 的错误归为 `parent-unavailable`，宿主原文不含，故跳过协调者重开），只能取消重开，取消可完成（B′，N=1）；T11b 的优雅重启路径同样可能受影响（推断，未验证）；该分类缺陷在 main 上自 T11b 起就有；最后的出路是停 daemon、确认旧成员及子进程等仓库写者已停止、把这个 Run 的台账文件移出 `agent-team-runs` 另存、再启动（用真实 store 代码离线验证，验证用的夹具包含 `outcome-unknown` 的派发意图、paused 的 Run 和 `repo-exclusive` 占用；没有在活的 daemon 上试过）；停 daemon 和移出台账不能证明旧成员或子进程已停止写入，确认所有旧写者已停止前，不要让其他 Run 写同一仓库；重试回合的结束入账（E2a）留两条残余：同一个回合 id 在同一个插件进程里出现第 3 次、且更早一次出现的结束是宿主在本进程里投递的，重试回合的 `turn_ended` 钩子仍会被当成更早那次的重复而丢掉（`turn-occurrence.ts:195-196`，`seen` 先于 `open`）；要在同一进程里让宿主重新编号两次（会话在运行中的 daemon 里被重建，如重载、换模型），再加一次打断和重试，实际很罕见，且不比 0.7.x 差；出路：人点一次“立即检查并推进”即可入账，这期间没有告警；被 Engine 结算过的回合，其迟到的真实结束若在重试回合开始之后才到，现在会归给重试那一次（钩子不带 messageId，分辨不了）；后果（评审推断，未单独复现）：重试回合被提前判为结束，Engine 去读它自己的回复窗口，回复还没出来就可能判缺报告或开修复，真正的结束随后被当重复丢掉；裁决明确要求“有已开始、尚未结束的出现就归它”，接受为残余；B13 完整续办（T11b 会把协调者的启动规格也冻结下来，下次只差恢复逻辑）；B7、B8、run.export、assign-seat、策略字段编辑入口、AC20 按原裁决推迟。

最终交付的完工定义（全部满足才能宣布）：
1. T11a、T11c 已合并，或按规则撤回并有记录；T11b 已合并，要撤回须先回问 Opus；T11e 的修复已合并。
2. 0.8.0 经 Release Please PR 发布，PR 上 CI 绿，没有管理员绕过；标签、Release、zip 都在；发布后 main 的 CI 绿。
3. 发布提交上门禁全绿，并由另一个模型独立重跑过一次。schema 仍为 2（支持 [1,2]），RPC 仍为 28，提示词模板相对 0787c6c 零改动；合同变化只限 T11b 列出的那些。
4. DEV 的 V1、V2 通过；V3 做过，或按 PID 规则做不了并写明原因；V4 至少有损坏台账和未知版本台账两种。结果写进计划 P04、验收表的 DEV 栏和 dev-report.md。
5. R2 准入表更新：第 1、2、5、6、7 行满足，没满足的如实写；第 3、4 行改写为"观察期"，第 4 行从 0.8.0 的发布日起算。
6. 默认开启的草稿 PR 已开、CI 绿、没有合并。
7. 交付说明、README、验收表、笔记、计划的"执行结果"都已对账。迭代计划第 9 节不勾选，在交付说明里逐条写现状。
8. DEV 已清理，worktree 干净，主工作区没被动过。
9. 按 T11g 的格式写好给用户的最终回复。

观察期："Run 卡死"类缺陷的定义，满足任一条即算：Run 无法经由文档写明的出路走到 finished 或 cancelled；Run 静默等待，既没有告警也没有决策；人没有选择取消，已交付的任务却丢了。观察期里出现这类缺陷，从修复它的版本起重新计 7 天。R2 表第 3 行只能来自用户自己在真实实例上的使用，团队不碰真实实例。**预先批准**：第 3、4 行满足，第 1、2、5、6、7 行仍然成立，草稿 PR 不需要再改合同时，用户或任何会话都可以照 PR 正文更新分支，等 CI 绿后合并并发 0.9.0，不必再问 Opus。有任何一行拿不准，回问 Opus。**2026-11-12 撤销**（M1 结论「Engine 不如」，草稿 PR #39 已关闭）：本段的预先批准作废，不再合并草稿 PR、不发 0.9.0；见 [M1 结果](m1-results.md)。

## 三、任务
通用规则沿用 docs/run-engine-todo-plan.md 第 3 节开头和第 4 节。计划记录接着 P04 行往下写，前缀"三轮 T11x"。

### T11a｜重新打开已关闭的席位，外加小修（fix）
- 目标：任务只被已关闭、没归档的席位挡住时，先读一次这个 Agent 的时间线把它打开，再照常派发。不发消息，不调用模型。
- 在哪里做：挂在 service.ts 里 noteSeatClosed 用的那个条件上（heldByClosedSeat）。生产者和评审都走调度器的 seat-closed 拒绝。补证路径（dispatchEvidence，约 534–546 行）：生产者自己的 Agent 读到 closed 时同样处理，并补上 T9f 那条告警。只对结构上合格、拒绝原因恰好是 seat-closed 的席位做；同家族闸这类在它之前判定的拒绝不算。按调度顺序，每遍最多 2 个，打开一个就停。
- 分类（新纯函数 shared/domain/run-engine/seat-reopen.ts，只看回执）：P 类：本 Run 里有完成的回合（turn_ended 的 outcome 为空或 completed，Engine 自己写的不算），重新打开。N 类：没有任何 turn_started，重新打开。C 类：有 turn_started 但没有完成的回合，不重新打开（事实 4），交给 T11b。
- 怎么打开：调用 `agents.ref(id).timeline.refetch({ direction: "tail", limit: 1, projection: "canonical" })`，超时 30 秒；然后 refresh()。读到 idle 且没有活动回合才算成功；成功后同一次调用里再跑一遍派发，只跑一次。
- 次数：每个插件进程里，每个 (runId, seatId, agentId) 自动最多试一次；人每点一次"立即检查并推进"，再试一次。失败只记日志，保留告警。空闲的 Run、没有被挡住的工作、已归档的席位一律不读（AC17）。paused、awaiting-dag、已结束的 Run 不做。
- 告警文案（seat-closed.ts）：写明 Engine 已经试过重新打开（只读历史，不发消息）；写明哪些情况打不开：从没开过回合的 Codex 成员；第一个回合开头几秒就被打断的成员；给出出路：它变回空闲后点"立即检查并推进"，否则取消这个 Run 后重新启动；保留"不要发消息去唤醒它"。T11b 合并时再改一次。
- 小修（同一个 PR，各自一个提交）：
  1. finished 或 cancelled 的 Run 里还开着的 seat-closed 告警，撤下一次；paused 的保留，因为仍然属实。
  2. T9f 评审低项：改 README 404–405 行措辞；给三处判断补独立变异：`readable &&`、acknowledged 的告警不重写、没有工作时撤告警；升级后 T9e 新旧两条告警可能并存，只写进 README。
  3. member-lost 决策的"为什么在等"改成和摘要一致的说法。
  4. 生产者的重试说明加一句："先看这个任务的分支：上一次尝试可能已经提交了改动，重试会在现有分支上接着做。"
  5. README 恢复一节写明：重启 daemon 后要打开 Runs 页，Engine 才会恢复。残余清单划掉事实 9 那一条。
- 必测（v1、v2 各一遍；假宿主要能模拟三种结果：读后变 idle、读时抛错、读成功但仍是 closed）：P、N 类读后变 idle：恰好派发一次，告警撤下一次；N 类读时抛错：不派发，只有一条告警；之后的自动遍不再读，点一次 kick 恰好再读一次；不读的情况：C 类、已归档的席位、同家族闸本来就会拒绝的席位；读成功但仍是 closed：不派发；补证路径和评审路径各一例；24 小时空闲的用例仍然零调用；finished、cancelled 的 Run 撤下告警一次，paused 的 Run 不写。
- 变异检查至少 12 项。评审：DeepSeek 重跑门禁并做一份评审。
- 提交：`fix(run-engine): reopen a closed seat by reading its history before refusing it`

### T11b｜重建打不开的成员 Agent（feat）
- 预批准的合同变化只有这些：
  1. `launch.agentSpecs`：passthrough 字段，带独立的读取器（照 readLaunchWorkspace 的写法）。
  2. `seatRebuilds`：顶层 passthrough 块，带独立的读取器。读不懂就当作没有，也不再开始新的重建。
  3. 席位换绑：只能经由新函数 `rebindSeatAgent`；bindSeatAgent 照旧拒绝换绑。
  4. 审计事件 `seat-rebound`，要有中文。
  5. 新的告警文案。
- 不批准：升 schema 版本、新增回执种类、新增 reducer 事件、新增 RPC、改提示词模板、重建协调者、自动重建 P 类 Agent、归档任何东西。需要其中任何一项，回问 Opus。
- 冻结启动规格：和 store.create(record) 在同一次提交里写入（就在 `systemPrompts = pinned` 那里）。内容：`{ version: 1, seats: { [seatId]: { parentSeatId, title, labels, systemPrompt, systemPromptSha256, profile, roleId, mcpServersSha256 } } }`。每个启用的席位都写，包括协调者，但本批只重建成员。profile 就是 start.ts 当时实际发出的那一份。某个席位的 systemPrompt 超过 64 KiB 时，这个席位整条不写，它也就不能重建。MCP 只存规范化后 JSON 的 sha256。
- 重建条件（全部成立才做）：
  1. Run 是 active，没有取消请求，launch.state 是 running。
  2. 有工作只被已关闭的席位挡住。重建的是结构上合格、排在最前的那个 seat-closed 成员席位。补证路径永远不重建，因为补证必须由原来的生产者完成。
  3. 这个席位读到 closed，没有 archived 回执，也没有未结的 assignment。
  4. 它是 C 类；或者是 N 类，而且本进程里那次重新打开失败了。
  5. 冻结的规格合法，当前 Role 的 MCP 摘要和冻结时一致。
  6. 这个席位在本 Run 里重建过的次数少于 2；整个 Run 同一时刻最多一个重建在进行。
- 步骤：
  1. 先提交一条记录：`{ rebuildId, seatId, generation, fromAgentId, toAgentId: null, idempotencyKey: "engine:<runId>:seat:<seatId>:rebuild:<generation>", title: "<冻结的标题>（重建 <generation>）", reason, state: "creating", requestedAt, settledAt: null, error: null }`。
  2. 用这个键和冻结的参数创建 Agent。parentAgentId 取当前协调者席位的 agentId，MCP 取当前 Role 的配置。照 start.ts，同一个键最多试 3 次。
  3. 在一次提交里调用 rebindSeatAgent（要求 roster 里的 agentId 等于 fromAgentId，且没有未结的 assignment），把记录改为 bound，写 seat-rebound 事件。再写一条告警："已按启动时冻结的配置为席位 X 新建 Agent（第 n 次）；旧 Agent 留在 Paseo 里，归档它不影响这个 Run"。新 Agent 第一次派发被确认后，撤下这条告警。
- 出错时：创建失败：记录改为 failed，error 只写错误码；写一条 warning；本进程不再自动重试；点一次 kick 可以开下一代。MCP 摘要对不上：不创建，写 warning，说明只能取消重开。恢复时发现还在 creating 的记录：用同一个键、同一份参数再试一次；宿主报 agent_request_key_conflict 就记为 failed。宿主因为父 Agent 没加载而拒绝创建：先按 T11a 的办法重新打开协调者，再试；还不行就回问 Opus。创建进行中 Run 被暂停或取消：这一次照样做完并绑定，之后不派发。
- 观察器：已绑定的那些 fromAgentId 的 hook 直接丢掉，不缓冲，也不打"只靠 hook 不够"的标记。
- 页面：Engine Run 的成员按台账的 roster 显示；如果改起来不简单，允许按标签推断的那张卡多显示一个旧 Agent，并写进 README。DTO 里不得出现 agentSpecs、systemPrompt 或 MCP 配置，在 AC19 的用例里加上这一条。
- 必测（以 v2 为主；v1 和 0.8.0 以前启动的 Run 没有规格，测它们不重建，告警提示取消重开）：启动时规格与记录在同一次提交里写入；超过上限的席位跳过；DTO 脱敏；N 类读时抛错：重建一次、绑定一次，评审恰好派给新 Agent 一次；之后旧 Agent 的 hook 被忽略；C 类：不读，直接重建；P 类重新打开失败：不重建；有未结 assignment、已归档、paused、有取消请求时：都不开始重建；写下 creating 之后、创建之前崩溃，以及创建之后、绑定之前崩溃：最后只有一个新 Agent，只绑定一次；连续 3 次创建失败：记为 failed，只有一条告警；kick 后开第 2 代；不会有第 3 代；MCP 摘要对不上：不创建；换绑后不变式通过，旧 assignment 仍是旧 agentId；换绑后整个 Run 的取消能完成。
- 回滚演练：用 git archive 取出 paseo-agent-team-v0.7.1 的 shared/，读一份带规格、带重建记录、已换绑、有 seat-rebound 事件的台账：解析和不变式都通过；hook 被归到新 Agent；历史页遇到不认识的事件种类能正常显示。
- 变异检查至少 16 项。
- 流程：先写不超过 40 行的设计说明，交给 GPT-6.1 Terra Max 只读审一轮，限 45 分钟。之后由 DeepSeek 重跑门禁并做正确性评审，Grok-4.6-Xhigh 做合同与回滚评审；修复最多一轮。
- 提交：`feat(run-engine): rebuild a member's Agent from the frozen launch spec when a restart leaves it unopenable`
- 撤回：须先回问 Opus。

### T11c｜评审的回合被重启打断也能重试（fix，不改合同）
- 改动：lostReplyKind（T9b/T9d 的路径）和 lostTurnCandidates（T4b 的路径）里，评审按生产者的规则分类：有 archived 回执或本次读到 closed 就是 member-lost，否则是 host-lost。冒烟和补证不变。openLimboDecision 在 host-lost 时也接受评审的 assignment。答复"重试"：关闭这次评审尝试并撤销它的凭据，做法与取消路径关闭判官尝试相同（decision-answer.ts 约 747 行）。任务保持 review；生产者的交付、证明和占用都不动；不计质量失败，不计返工，不增加生产者的尝试次数。下一遍重新派发评审，照常预扣预算。答复"取消"：不变。
- 必测（v1、v2 各一遍）：四种回执顺序：archived 在前 → member-lost；优雅停机有 closed 回执 → host-lost；优雅停机没有 closed 回执 → host-lost；R-kill 没有 turn_ended → 走 T4b 路径，host-lost。重试后恰好有一条新的评审派发，上面那些计数都不变。评审回合再丢一次，会再开一个决策。失败任务闸不挡它。冒烟和补证的行为与现在相同。
- 回滚演练：用 0.7.1 的代码对这种决策答"重试"，记下实际行为；如果有害，在发布说明里写"回滚前先答复这类决策"。
- 变异检查至少 10 项。评审：DeepSeek 重跑门禁，并做一份评审。
- 提交：`fix(run-engine): let a review cut off by a restart be tried again`
- 撤回：三次不过就撤回，记为残余，不必回问 Opus。

### T11d｜DEV 验证（T11a 到 T11c 都合并后，从 main 的构建安装）
- 上限：Engine Run 不超过 5 个，墙钟不超过 3.5 小时；模型同 T8（claude-haiku-5-5、gpt-6-luna）；1 个 Sonnet 会话，交接时最多再开 1 个；浏览器用 Playwright Chromium，宽度 1440 和 390。停止规则、清理和 PID 规则都按 T8 和 T9de 裁决执行，绝不碰 6767。
- V1｜条件 7、T11a、T11b、T9e（团队：claude 协调者、claude 生产者、codex 评审）：1) 协调者规划到第 10 秒以后优雅重启，然后打开 Runs 页。2) 应出现 T9e 告警，Run 处于 awaiting-dag；点"请求重新规划"，计划应被接纳。3) 从没开过回合的 Claude 生产者应被重新打开，恰好派发一次。只读核对：它存储的 config.systemPrompt 的 sha256 等于台账 launch.agentSpecs 里这个席位的 systemPromptSha256。4) Codex 评审应重新打开失败（记下错误原文），然后被重建；核对新 Agent 的 systemPrompt 哈希。5) 新评审完成评审，Run 跑到 finished。6) 用 DEV CLI 归档旧的评审 Agent，Run 不受影响。7) 在浏览器里检查重建告警和 seat-closed 告警。
- V2｜T11c、Claude 评审的 T11a、T9d 的 closed 回执分支（团队：codex 生产者、claude 评审）：1) 生产者的回合跑过 15 秒后优雅重启，记下有没有 closed 回执。2) 读取用尽后 20 秒内 kick，应零写入；30 秒以后 kick，应开出 host-lost。答复重试。3) 从没开过回合的 Claude 评审应被重新打开。4) 评审回合跑过 15 秒后再优雅重启一次。5) 应开出评审的 host-lost；答复重试后恰好有一条新的评审派发。6) Run 跑到 finished，并在浏览器里检查评审的 host-lost 卡片。7) 可以拆成两个 Run 来做。
- V3｜R-kill（claude 生产者）：1) 生产者回合进行中，按 PID 规则强杀 worker。2) 记下有哪些回执、有没有留下孤儿进程。3) 30 秒以后 kick，应开出 host-lost；答复重试，尽量跑到 finished。中途的 Codex 评审重建算第 2 个样本。4) PID 规则不满足就不做，并写明是哪一条不满足。PID 规则：目标进程须同时满足：①父 PID = `daemon status --home <DEV> --json` 的 supervisor PID；②是 52791 的 LISTEN 进程；③6767 的 LISTEN 进程 PID 与它不同且其父进程不是 DEV supervisor；只 `Stop-Process -Id <PID> -Force`，不杀进程树。
- V4｜AC15，不调用模型：1) 在仓库外用仓库自己的构造函数和校验（RunRecordSchema、checkLedgerInvariants）生成三份台账：字节损坏的、版本未知的、回执接近上限的（≥7680；造不出来就用 ≥6144 那一档）。2) 放进 DEV，然后打开 Runs 页，调用 run.list、run.get 和 kick。3) 预期：损坏的台账显示为健康问题，文件不被覆盖；未知版本的文件逐字节不变，并且被报告出来；接近上限的不派发，只写一条告警，宿主零发送。4) 用完删除这三份台账。
- 与事实或预期不符时回问 Opus，例如：重新打开的 Claude 成员丢了系统提示词；重建超过上限或陷入循环；从没开过回合的 Codex 成员能打开，但之后第一个回合失败。

### T11e｜DEV 发现问题的修复
不改合同的直接修（fix）；要改合同的回问 Opus。最多两轮。修完只重验受影响的项，不超过 2 个 Run、1.5 小时。

执行记录（第一轮，裁决 ruling-t11d 第 1 条）：生产者的任务回合和评审回合，成员只有 closed 回执或宿主读到 closed 时，先读一次时间线试着重开并告警，首次看到 closed 满 30 秒后再结算：重开后 idle 且无在跑回合开 `host-lost`，否则 `member-lost`（task-note 写宿主原话）；archived 回执或宿主没有该 Agent 照旧立即结算。合同不变。细节见计划 P04 第 93 点。DEV 复验已做：Run A 达到 host-lost、重试并 finished；Run B 观察到等待告警与 host-lost，评审未重建、Run 未 finished，取消停在 paused 且仓库占用保留。优雅重启的等待窗口和读取用尽后 20 秒内 kick 路径仍只有离线证据。

执行记录（第二轮，裁决 ruling-t11e-dev，三轮 T11e2）：E2a 重试回合的结束由它自己的 `turn_ended` 钩子入账（Engine 自己写的结束不算本进程已见过的钩子），不再靠 kick；E2b 从没开过回合、早于本进程的成员，第一次派发前先读一次历史，读成功才派，读失败走 T11b 重建（`never-ran-unopenable`），旧 Agent 不收消息，#36 的守卫只为这一种情况放行；已冻结的 outcome-unknown 仍是残余，最后的出路见上。合同不变。细节见计划 P04 第 94 点。DEV 复验（N=1/Run）：E2a 接受（A′、B′ 答复重试后无 kick，台账自行记下 `turn_ended` 并继续，A′ finished；≤10 秒未证实也未证伪，旁证一致；220.356 秒与 186.149 秒的静默期间生产者回合在跑，判为不是 60 秒规则所称的“停顿”，原始数值保留）。E2b 部分通过（用户批准在 DEV 未全部通过的情况下合并）：读到历史失败、旧 Agent 零派发（部分佐证）、重建失败有告警、取消走到 `cancelled`（rev 38）并释放占用（N=1）；新评审完成和 finished 未达到；第一轮 Run B 没有 E2b，取消停在 paused、占用保留。新残余：协调者未加载时重建记为 `create-failed`，只能取消重开（见上）。第二轮不再补 Run。

### T11f｜发 0.8.0
照 T7 的步骤；Grok 在发布提交上独立重跑一次门禁；照 0.7.1 的做法构建并上传 zip。Release 正文追加回滚注意：回滚到 0.7.x 后，重试回合结束后要点“立即检查并推进”才会入账，崩溃之后从没开过回合的 Codex 成员仍会被派发并把 Run 冻结（有未做过评审的 Codex 评审席时，在派发前取消，取消完成后再重开；若已出现未知派发，取消可能停在 paused、占用仍保留）；这类 host-lost 决策（成员只是被关闭，重启打断了它的回合，重新打开后给出的）答“重试”会停在已关闭的席位上（0.7.x 不会重开），应改答取消；冻结规格和重建记录被忽略，已换绑的席位照常用新 Agent；还在 creating 的重建会被丢下，可能留下一个没登记的 Agent；T11c 回滚演练的结论。本批原则上只发 0.8.0；万一需要另发（例如 T11b 撤回后发 0.7.2），不受一天一版的限制。

### T11g｜交付
1. 草稿 PR：在 0.8.0 之后的 main 上开分支 `todo/r2-default-on`。改动：runtime.ts 改为没设置就开启，设为 `0` 或 `false` 才关闭；同步修改注释、runtime.test.ts、index.server.ts 的注释、README 第一步和 readme-facts.test.ts。提交：`feat(run-engine): run the Engine by default; PASEO_AGENT_TEAM_RUN_ENGINE=0 turns it off`。以 draft 打开，等 CI 绿。正文写清：R2 准入表；观察期的起算日；合并步骤（更新分支、等 CI 绿、独立重跑门禁、合并、发 0.9.0）；回滚办法。
2. 新增 docs/run-engine-delivery.md，不超过 150 行：怎么打开（在启动真实 daemon 的环境里设 =1 并重启 daemon，再在 Team 里打开 Engine）；重启后怎么办（打开 Runs 页，Engine 会重新打开或重建成员；回复丢了就等 30 秒再点检查，先看分支、确认进程已停，再决定重试或取消）；冻结的残余清单；回滚办法；观察期里用户要做的事；第 9 节的逐条现状；草稿 PR 的链接。
3. 终对账：README、验收表、笔记、计划 P04，以及 run-engine-todo-plan.md 里的"T11 执行结果"和 R2 准入表。
4. 清理：照 T10 的做法。
5. 给用户的最终回复：合并的 PR、发布的版本和测试数；撤回了什么；DEV 结果（写明 N）；已接受的残余；观察期要用户做的两件事（在真实实例上开 Engine 用满 3 个 Run；0.8.0 发布满 7 天没有新的 Run 卡死后合并草稿 PR）；团队没有碰过真实实例。宣布措辞只能用："Run Engine 工程交付完成（v0.8.0）；默认仍关闭，进入观察期；满足条件后合并草稿 PR #N 即默认开启（0.9.0）。"不得写"全部验收通过"。

### T11e2 处置与后续（执行记录，裁决 ruling-t11e2-disposition）

- **E2b 处置**：保留，按“部分通过”合并（用户批准在 DEV 未全部通过的情况下合并），不开第三轮；回滚到 0.7.x 的指引照旧保留。
- **T11b 分类窄修复**：另立项，作为 0.8.1，在 M1 之后、M2 之前。只把宿主原文 `Caller agent … not found` 归入 `parent-unavailable`（`server/run-engine/seat-rebuild.ts` 的 `errorCode`），合同零变化；离线测试用宿主原文并做变异检查，评审一道，另做 1 个 DEV Run（优雅重启、协调者不重新规划、带一个从没开过回合的 Codex 评审），它同时补 R2 第 7 行的样本。该 Run 期间不展开 Runs 页的成员卡，免得像 V1 那样把协调者加载起来。**未开始的后续项**：尚未实现、尚未验证。
- **R2 准入表**（交付时照 T11g 第 3 条更新 `run-engine-todo-plan.md` 的同名表）：
  - 第 4 行：7 天从用户在真实实例上于符合条件的版本启动的第一个 Engine Run 起算；0.8.0 及以后符合（现有残余都不属卡死类）；观察期内出现卡死类缺陷，则从修复版本上第一个真实 Run 重新起算。
  - 第 7 行：V1 成功的前提是协调者已加载（推断）；R2 合并前需要 0.8.1 的 DEV 样本，否则回问架构师。不得写成已满足。

## 四、顺序、分工与额度
- 顺序：T11a → T11b 设计说明 → GPT 审设计期间，Sonnet 做 T11c（另开一个 worktree，同一时刻仍只有一个 Sonnet 在写）→ T11b 写代码 → T11d → T11e（按需）→ T11f → T11g。
- 并行的例外：如果 Claude 额度是瓶颈，T11c 可以交给 GPT-6.1 Terra Max 在独立的 worktree 里和 T11b 并行，规则不变；由协调者决定。
- 分工沿用 5.1：Sonnet 负责实施和 DEV；DeepSeek 负责重跑、评审和文档；Grok-4.6-Xhigh 负责 T11b 的合同评审和发布前的独立重跑；GPT 负责设计评审和排障。不用 Grok-4.7，Opus 不做实施。
- 额度：每个任务一个新会话；改到约 20 个文件或上下文用到一半时交接；碰到 5 小时上限就设 heartbeat 等重置，不跳过任务。
- 版本：T11a、T11c 是 fix，T11b 是 feat，合起来发 0.8.0。

## 五、T11 期间回问 Opus 的情况（在原 7.2 之外）
1. 宿主的行为与第一节的事实不符。
2. T11b 清单以外的合同变化，或者要撤回 T11b。
3. 重建超过上限，或陷入循环。
4. DEV 连续 3 次起不来，或者连续两个 5 小时窗口都推不动。
5. R2 第 3、4 行拿不准，或者用户提出与本裁决冲突的新要求：以用户为准，同时告诉 Opus。
其余情况照 7.1 自行决定，事后在状态文件里记一行。

## 六、T11 执行结果（2026-11-10，协调者整理；不改上文裁决）

- **合并的 PR**（均走 PR + CI，merge commit，无管理员绕过）：#33 T11c `d66216d`；#35 T11a `79240db`；#36 T11b `dff9451`；#37 T11e `37b41bd`；#38 T11e2 `d6af29f`；#34 发布 0.8.0 `73a9178`。撤回：无。
- **发布**：v0.8.0（1 feat + 13 fix；其中一条标题重复，来由是 #37 用默认合并正文合并，Release Please 同时收下了合并提交与分支提交，按裁决不手改）。发布提交 `73a91784e8931da11d1aa26a403e3cf9419d3204`，标签、Release 与 zip 都在；发布后 main 的 CI 绿。
- **完工定义**：第 1、2、3 条满足（Grok-4.6 在发布提交上独立重跑门禁：220 个文件 / 4297 通过 / 3 todo，行覆盖 92.73%；schema 仍为 2、RPC 仍为 28、提示词模板相对 `0787c6c` 零改动）；第 4 条按 DEV 实情记录（V1、V2 部分，V3 做了但与预期不符，V4 通过）；第 5 条按 D10-A 写第 4 行；第 6 条是 `todo/r2-default-on` 的草稿 PR（#39）；第 7 条见 `docs/run-engine-delivery.md` 第 7 节。
- **与裁决不同的地方**：完工定义第 5 条里“第 4 行从 0.8.0 的发布日起算”已被 D10-A 改为“从用户在真实实例上、于符合条件的版本启动的第一个 Engine Run 起算”；R2 表按 D10-A 写。第 7 行按处置裁决写成“拿不准”，不写成已满足。
- **DEV**（每项 N=1/Run；模型只用 `claude-haiku-5-5` 与 `gpt-6-luna`；浏览器 Playwright Chromium；omp 无样本）：T11d 5 个 Run、T11e 2 个、T11e2 2 个，结论见 `docs/run-engine-todo-plan.md` 的“T11 执行结果”。
- **残余与后续**：完整清单见 `docs/run-engine-delivery.md` 第 3 节。0.8.1 的 T11b 分类窄修复（M1 之后、M2 之前，带 1 个 DEV Run）尚未开始；M1 同任务对照尚未开始，没有对照数据。

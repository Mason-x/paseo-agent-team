# Run Engine 验收表（AC01–AC22）

编写：2026-11-08（无人值守会话）。矩阵来源：`docs/run-engine-iteration-plan.md` 第 7 节。实施记录：同文件第 8 节 P04 行。

这份表如实记录每一项验收**现在**有什么证据、缺什么。它不是"全部通过"的声明：

- **已覆盖**：有离线测试（纯核、真实 store、假宿主）直接观察到"必须观察到的结果"，缺口栏只剩细节。
- **部分**：有测试覆盖一部分，缺口栏写明缺什么。
- **未覆盖**：没有测试。
- **需 DEV**：离线测试之外，还需要在专用 DEV daemon 上用真实模型和真实 Paseo 观察。A12（2026-11-08）只覆盖了一部分：六个目标里五个取得证据，补证模板未触发；其余项目的这一步仍未做完，见"DEV 记录"栏。

证据一律写成 `- 测试文件 :: 用例名`，用例名与测试文件里的标题逐字一致；`paseo-agent-team/tests/run-engine/acceptance-doc.test.ts` 会读这份文档，检查每一条引用的文件存在、用例名确实出现在该文件里，所以引用不会随重命名悄悄失效。标题由 `test.each` 模板生成的，在说明里写"模板"，不参与逐字检查。"待批准"一栏的编号 B1–B13 指 `docs/autonomous-notes.md` 的待批准清单（本轮无人值守会话的笔记）；其中每一项的裁决（批准、推迟、关闭）见 `docs/next-phase-plan.md` 第 2 节，推迟的项在那里写明了重新评估的触发条件。

## 总表

| ID | 必须观察到的结果 | 状态 | 缺口（一句话） | 待批准 | DEV 记录 |
| --- | --- | --- | --- | --- | --- |
| AC01 | T2 不派发；T1 仍需满足其声明的审查和冒烟 | 已覆盖 | —（A16 已补引擎级用例：带冒烟的 T1 与依赖它的 T2，审查通过后 T2 仍是 `pending`，冒烟通过才派发，冒烟失败 T2 保持 `pending`、T1 回到生产者） | — | 第 20、21 点（正常路径，非注入） |
| AC02 | 不能过完成门；显示具体拒绝原因 | 部分 | 旧 `reviewedRef`、自审、错 DEV 目标现已断言具体原因码（A15）；没有页面端到端 | — | 无 |
| AC03 | 一次生效；assignment、预算、下一阶段不重复增加 | 已覆盖 | —（A15 已把重放 hook 与 assignment、预算、outbox、修订号的计数放进同一用例） | — | 无 |
| AC04 | 恢复后执行该意图或按合同终止，不漏记也不额外派一份 | 已覆盖 | "意图提交后、调用前"的中断用抛错和新实例模拟，不是真实进程被杀 | — | 无 |
| AC05 | 先核对实际消息和 turn；无法证明时冻结，不盲目重发 | 已覆盖 | 证明只靠用户消息回显（messageId）；没有宿主证明"消息确实没到"的用例 | — | 无 |
| AC06 | 按运行关联查证；不重复创建、不误删无关 Agent | 部分 | "已创建但响应丢失"与"不误归档无关 Agent"现已有用例（A15）；去重靠同一个幂等键，没有按运行关联列举查证；创建中崩溃后安全关闭并告警，未登记的 Agent 仍需人工查找，不能完整续办 | B13 | 第 21、30 点（只记录了 Windows `EPERM` 重试，没有重复创建的证据） |
| AC07 | 只尝试有界补报；保留产物；协议失败与质量返工分开 | 已覆盖 | —（协议失败不改变 `qualityFailures`、`reworkCount`、尝试次数，已有用例，A15；DEV 没跑过成员报告补报，见 DEV 记录栏） | — | 第 25、26、32 点 |
| AC08 | 严格拒收；不推进任务、不放宽身份校验 | 已覆盖 | 经入账路径只演练了 nonce 不符；错任务、错 attempt、未知版本、发送者只在解析与归属层 | — | 第 25、28 点 |
| AC09 | 仅一方获写占用；另一方等待并给出原因 | 已覆盖 | —（A16：两个 Run 的引擎级用例，别名拼写的文件路径被挡并在冲突里点名该文件，第一方完成放占用后另一方下一遍派发） | — | 无 |
| AC10 | 保留相关冻结占用；冲突任务不能趁机开始 | 部分 | 冻结占用在同 Run 内和跨 Run 都已有引擎级用例（A16）；"Agent 失联"只有现状测试（已知限制）：宿主若在成员回合中关闭它而不发 `turn_ended`，任务与 Run 取消会一直等，引擎不会处理 | — | Run 4（N=1）：daemon 在 reviewer 回合中重启，回复丢失，恢复重查 3 次用尽后任务停在 review；取消停在 paused、`waiting.turns=1`，与已知限制一致 |
| AC11 | 按证据补对账并去重；不丢结果，不重复统计 | 部分 | "整份报告之后才来的 hook"现已在记录层断言不变（A15，只涉及 `turn_ended`）；"早于关键记录"只验证了 store 未就绪和无归属（绑定席位后恰好交付一次已补）；宿主读不全的回复现在会被重查并在恢复后自动继续 | — | 无 |
| AC12 | 不自行答权限；决定只作用一次；恢复后只继续剩余阶段 | 部分 | 假宿主已覆盖权限等待重启、解除回执去重与报告一次入账；真实宿主权限对话只观察到一次（引擎不代答），人的重复操作仍未测 | — | Run 2（N=1）：审查者回 blocked `PERMISSION_REQUIRED`，引擎只开 `stuck-judge` 的重试/取消，未代答、未归档；重试是决策重试，不是权限回应 |
| AC13 | 截止前不重派；到期按预算执行；耗尽不继续消耗模型 | 部分 | 退避只存在于宿主读取失败的重查（现含不完整窗口、对账读取、补证前的席位刷新，恢复后自动继续前 3 次）；派发之后的临时失败没有自动重试；预算耗尽有告警和追加预算的 RPC（不开决策）；失败的任务多于策略上限后不再开始尚未开始的任务，已在进行的评审、冒烟、补证请求与返工照常（A13，评审后修正，有端到端用例）；没有分组预算的入口；协调者的回合预算已有（计划请求与重新规划各扣一回合，计划格式重发不计，不退还，耗尽时重新规划被拒并告警，追加预算后继续，A14） | A7 | 无 |
| AC14 | 暂停停新派发；续办重新核对；取消证实静止后才释放 | 部分 | 暂停、续办、单任务取消和整个 Run 的延迟取消都有入口；"从未发出的派发被本地撤回"已有引擎级用例（A16）；启动中断已安全关闭但不能续办；真实宿主上取消能完成，但重启丢失在途回复后会一直等 | B13 | Run 1（N=1）阻塞取消完成、占用释放、告警 resolved；Run 4（N=1）重启丢失 reviewer 回合后取消停在 paused、`waiting.turns=1`，不释放 |
| AC15 | 保留原始数据；诊断可见；不覆盖、不截断、不越限派发 | 部分 | 存储层与容量门（接近上限不再派发新工作）、事件压缩已覆盖；回执与 nonce 没有压缩办法，真到上限的 Run 只能收尾后重启；没有 DEV | — | 未做（A12 没有构造损坏台账、未知版本或容量上限） |
| AC16 | 旧 Run 可看；不支持时清晰阻断，不静默采用另一条执行链 | 已覆盖 | —（A16：Runs 页同时显示 Engine Run 与协调者链路的 Run；Run 启动后 Team 的 `runEngine` 块被改坏或删除，既有 Run 仍可读、可 kick、可控制。页面与 `run.list` 都不以开关为输入，开关关闭时列表与控制仍可用见 runtime.test.ts） | — | 无 |
| AC17 | 模型调用数为零；不为无变化输入重复记账或唤醒战略协调者 | 部分 | 假宿主已覆盖 5 次重复事件与 kick 无新发送、修订号不变且无重查计时器，假时钟 24 小时空闲 Run 零宿主读写零计时器（A16）；没有真实时间长跑或 DEV 验证；决策唤醒协调者的逻辑只在纯分类器里 | — | 无 |
| AC18 | 没有新增决策时不逐事件唤醒；相同决定去重 | 部分 | 只有"协调者没收到消息"的间接观察；去重只在纯分类器 | B3、B6 | 无 |
| AC19 | 不触发派发；DTO 不泄漏 nonce、完整提示、Outbox 参数 | 已覆盖 | —（列表、详情、历史、刷新已断言不写入、文件字节不变，A15；查询函数不持有宿主，"不派发"是结构性的；M1 对账查询不提供，由 kick 代替，见 `docs/next-phase-plan.md` 2.3） | — | 第 33 点（未在 DEV 验证） |
| AC20 | 不冒认成有效交付；记录异常并核对受影响资源 | 部分 | 无归属的活动被静默忽略，不写异常、不核对资源（不做，理由见 `docs/next-phase-plan.md` 2.12/A16：人直接和成员对话是正当用法，没有批准的异常语义）；对有 assignment 的成员发用户消息已有现状测试（A16）；夹具 `EXTERNAL_ACTIVITY_CASE` 没有测试使用 | B4、B12 | 无 |
| AC21 | 截止条件最终被处理；重复到期不重复副作用；不出现忙循环 | 已覆盖（范围声明：现有唯一的截止条件是宿主读取重查，B7 的派发后退避已推迟，所以没有别的可测对象） | —（范围声明见左） | B7（已推迟） | 第 35 点（没有 DEV） |
| AC22 | 不闪成空进度；原因与台账一致；旧历史游标失效可恢复 | 部分，需 DEV | 决策子类已由服务端投影并兼容旧客户端；真实浏览器、窄屏与重连已看过一次；列表状态与台账不符的缺陷已在客户端修复并有离线测试（v1/v2 记录各一遍，计划第 73 点），尚未在真实 DEV 重验；其余原因码仍靠源码扫描 | B8、B10（剩余字段） | Run 1–3（N=1）：1280x900 与 390x844 无横向溢出、按钮可点；停 daemon 显示不可用而非空进度，同端口重启自动重连；列表把 active 阻塞与 cancelled 的 Run 显示为已完成并计入已结束（缺陷，已修：`tests/run-view/runs-tab.test.ts`「a Run in both lists is described by the ledger…」、`tests/run-list.test.ts`「Engine lifecycle over agent state」） |

没有 DEV 记录的项目仍需要在专用 DEV daemon 上再看一遍；A12 只覆盖了 AC12、AC14、AC22 的少数真实场景，AC15 是零样本（见各自的 DEV 记录）。

## 各项证据

### AC01 T2 依赖 T1，T1 仅提交实现报告
- tests/run-engine/driver.test.ts :: two tasks, one after the other: nothing starts until what it waits for has passed every gate — 断言 T1 在审查中 T2 仍是 `pending`，审查通过后 T2 才发出；这个计划没有冒烟要求
- tests/run-engine/service.test.ts :: a smoke is not started before the review has passed
- tests/run-engine/service.test.ts :: a reviewed task with a smoke goes to the smoker, on the registered DEV target
- tests/run-core/r01g-behavior.test.ts :: true completion makes its pending dependency ready
- tests/run-core/reducer.test.ts :: a done report and independent review move T2 to done and ready T3
- tests/run-engine/driver.test.ts :: t2 stays pending through the review and the smoke, and is dispatched only once the smoke has passed — 真实 git 与 driver：T1 声明冒烟，审查通过后 T1 仍在 `smoke` 阶段、冒烟者被请求、T2 一直 `pending`，冒烟在登记的 DEV 目标上通过后才派发 T2（A16）
- tests/run-engine/driver.test.ts :: a smoke that fails keeps t2 pending and sends t1 back to its producer — 冒烟的检查项失败：T2 从未被派发，T1 回到生产者并带返工说明（A16）

缺口：无（DEV 真实冒烟仍无记录，见“DEV 记录”栏）。

### AC02 普通文字称完成、自审、旧 `reviewedRef`、错 DEV 目标
- tests/run-core/gates.test.ts :: stale D and source-bound self reviewer cannot pass — 断言原因码 `no-valid-review`（A15）
- tests/run-core/gates.test.ts :: a review of an older reviewedRef does not count for the current delivery — 旧 `reviewedRef` 的原因码 `no-valid-review`（A15）
- tests/run-core/gates.test.ts :: registered DEV passes, default target fails — 断言原因码 `failed-smoke`（A15）
- tests/run-core/gates.test.ts :: evidence single defect: $reason — 模板；断言每个证据缺陷各给出对应原因
- tests/run-core/reducer.test.ts :: a smoke report must come from the registered target and an independent smoker — 断言原因是 `invalid-smoke`
- tests/run-engine/intake.test.ts :: a reply with no report only records why the task is not moving, once — 普通文字称完成：原因 `report-missing`
- tests/run-engine/intake.test.ts :: a report that fails the evidence gate is kept out of review and the reason is shown
- tests/run-view/waiting.test.ts :: every reason a refused evidence gate can leave — 每个证据门原因都有中文说明

缺口：没有端到端的页面显示（旧 `reviewedRef`、自审、网关层错 DEV 目标的具体原因码已断言，A15）。

### AC03 同一 hook、报告或人的决定重复到达
- tests/run-engine/observer.test.ts :: records one receipt for an owned agent and treats redelivery as a duplicate
- tests/run-engine/observer.test.ts :: an event storm of repeats and reorderings leaves one receipt per distinct fact
- tests/run-engine/intake.test.ts :: settling again changes nothing: the assignment is no longer waiting
- tests/run-engine/driver.test.ts :: a hook delivered twice, or for an agent no Run knows, sends nothing more
- tests/run-engine/driver.test.ts :: the same hook again, or a kick, does not ask twice
- tests/run-engine/control.test.ts :: the answer survives a restart: asked again afterwards it is the same answer and sends nothing
- tests/run-core/budget.test.ts :: the same intent/message is counted once without a draft
- tests/run-engine/driver.test.ts :: a report's turn_ended hook replayed three times and two kicks after it count nothing twice: assignments, budgets, outbox, revision and sends stay as the first ingestion left them

缺口：无（A15 已把重放报告 hook 与 assignment、预算、outbox、回执、修订号的计数放进同一个用例）。变异记录：回执去重在观察器与 reducer 的三处同时去掉才变红，单层去掉仍不变（有意冗余，见计划第 60 点）。

### AC04 写入意图后、外部调用前中断
- tests/run-engine/effects.test.ts :: AC04: a crash after `sending` was committed does not send again
- tests/run-engine/effects.test.ts :: AC04: if the call did land before the crash, the echo confirms it
- tests/run-engine/effects.test.ts :: a failed `sending` commit sends nothing
- tests/run-engine/effects.test.ts :: a failed `confirmed` commit leaves `sending`; the next pass settles it by echo
- tests/run-engine/control.test.ts :: the request is committed before it is sent: a stop in between is finished by recovery, once
- tests/run-engine/runtime-control.test.ts :: a request left prepared by a stop is sent by the next process's first recovery, once
- tests/run-engine/driver.test.ts :: a repair that was committed but never sent goes out when the process comes back, once
- tests/run-engine/store-process.test.ts :: a crash before rename leaves the committed bytes identical on disk — 真实子进程被杀，只覆盖 store 提交

缺口："意图提交后、宿主调用前"的中断是用抛错的发送和新实例模拟的，不是真实进程被杀。

### AC05 Paseo 已接收消息但响应丢失
- tests/run-engine/effects.test.ts :: AC05: a send that throws is outcome-unknown, not failed, and is not retried
- tests/run-engine/effects.test.ts :: the host did receive it: the timeline echo settles the intent without a resend
- tests/run-engine/effects.test.ts :: an incomplete timeline read is not evidence of absence
- tests/run-engine/effects.test.ts :: a timeline that cannot be read leaves the intent frozen
- tests/run-engine/effects.test.ts :: an agent with an unresolved delivery receives nothing more
- tests/run-engine/driver.test.ts :: a request whose delivery is unknown stays sent once: claims freeze and nothing is re-sent
- tests/run-engine/start.test.ts :: a plan request whose delivery is unknown is not a failure and is never sent again

缺口：证明只靠用户消息回显（`messageId`）；没有宿主能证明"消息确实没到"的情形，所以"无法证明则冻结"是唯一出路。

### AC06 成员创建成功但调用响应丢失
- tests/run-engine/start.test.ts :: an unknown create result is re-asked with the same key and creates no second agent
- tests/run-engine/start.test.ts :: an agent made and remembered under its key whose answer was lost is the one the next ask returns: one agent per seat, none extra
- tests/run-engine/start.test.ts :: a failed launch archives only the agents this launch created, not another agent the host holds
- tests/run-engine/start.test.ts :: a create that fails twice with a transient error succeeds on the third try with the same key
- tests/run-engine/start.test.ts :: when a member cannot be created, what was created is archived if the preference says so
- tests/run-engine/start-recovery.test.ts :: names the coordinator as the possible unregistered agent when its creation was interrupted
- tests/run-engine/start-recovery.test.ts :: names the agents on the record and the next seat that has none
- tests/run-engine/runtime.test.ts :: a duplicate start finishing does not expose another start still creating agents to recovery

缺口：去重靠同一个幂等键，没有按运行关联列举查证（设计选择）；启动中断会安全关闭并告警，不能完整续办，未登记的 Agent 只能靠提示人工查找（B13）。"已创建但响应丢失"与"不误归档无关 Agent"已有用例（A15）。

### AC07 实现已完成但报告 JSON 错误；修复再次失败
- tests/run-engine/driver.test.ts :: a refused report gets one repair request, and the repaired report settles the task
- tests/run-engine/driver.test.ts :: the budget is the policy's protocolResends, then the task waits as before
- tests/run-engine/driver.test.ts :: a reply with no block is asked for again as missing
- tests/run-engine/driver.test.ts :: a turn that did not end on its own is not asked again
- tests/run-engine/driver.test.ts :: every refused report is a protocol failure and never a quality failure or a rework, and what the member delivered is left as it is
- tests/run-engine/report-repair.test.ts :: stops at the policy's protocolResends
- tests/run-engine/control.test.ts :: with no re-send to ask for, the first unusable reply is already the decision
- tests/run-core/reducer.test.ts :: incomplete evidence stays in progress and increments evidenceReturns

缺口：无（DEV 没跑过成员报告补报，见“DEV 记录”栏）。协议失败不改变 `qualityFailures`、`reworkCount`、尝试次数，成员的提交与最近回复保持原样，已有用例（A15）。

### AC08 超长、多块、未知版本、错任务/attempt/nonce/发送者
- tests/run-engine/protocol.test.ts :: fixture cases: each defect is rejected for its own named reason, none is accepted
- tests/run-engine/protocol.test.ts :: a block at the byte limit is parsed, one byte over is rejected before parsing
- tests/run-engine/protocol.test.ts :: a reply over the whole-reply budget is unverifiable, never reported as silence
- tests/run-engine/protocol.test.ts :: identity is checked against the ledger, one mismatch at a time
- tests/run-engine/protocol.test.ts :: the sender comes from the host: another agent holding the right nonce is refused
- tests/run-engine/protocol.test.ts :: registry disagreement, revocation and replay are refused or flagged as duplicate
- tests/run-engine/intake.test.ts :: a malformed report is rejected with its reason and nothing moves
- tests/run-engine/intake.test.ts :: a report with someone else's nonce is refused as such

缺口：经入账路径演练的只有 nonce 不符；错任务、错 attempt、未知版本、发送者只在解析与归属校验层测过。

### AC09 两 Run 请求同一文件，含 Windows 大小写和分隔符别名
- tests/run-engine/store.test.ts :: a second run sees the first run's claim, including Windows case and separator aliases
- tests/run-core/locks.test.ts :: default case-fold and claim-side normalization are applied
- tests/run-engine/dispatch-builder.test.ts :: a second Run's claim on the repository blocks the grant even when its task id is also t2
- tests/run-engine/service.test.ts :: another Run holding the repository blocks the dispatch even when it also has a t2
- tests/run-engine/dispatch-builder.test.ts :: an unreadable view of other Runs refuses the grant instead of guessing
- tests/run-engine/store.test.ts :: a damaged record makes the view untrusted instead of looking free
- tests/run-engine/driver.test.ts :: a second Run asking for the same file under another case and separator is held back, with the file named as the conflict; once the first Run's task is done, the next pass sends it — 同一个 store 里的两个 Run、同一仓库：Run A 占用 `src/Util.ts`，Run B 请求 `SRC\util.ts`；派发被 `lock-conflict` 挡住，冲突明细里有 `kind: file`、`path: src/Util.ts` 的那一条（不只是整仓 `hot`）；A 的任务审查通过后占用清空，B 下一遍恰好派发一次（A16）

缺口：无。

### AC10 派发结果不明、Agent 失联或取消未确认
- tests/run-engine/driver.test.ts :: a request whose delivery is unknown stays sent once: claims freeze and nothing is re-sent
- tests/spec/run-core-reducer.spec.test.ts :: a dispatched assignment without turn end or authorization stays frozen
- tests/spec/run-core-reducer.spec.test.ts :: an in-flight task stays frozen when a later turn starts after the end
- tests/run-core/r01g-behavior.test.ts :: an in-flight producer starting after cancellation cannot unfreeze the task
- tests/run-core/locks.test.ts :: a frozen claim conflicts even for its own task; a review handoff does not
- tests/run-core/cancel-release.test.ts :: after the decision is answered `cancel`, cancelling releases the claim and binds the decision
- tests/run-core/cancel-release.test.ts :: another answer is not an authorization: the task stays frozen with its claim
- tests/run-core/cancellation-review-regressions.test.ts :: %s keeps the frozen claims — 模板
- tests/run-engine/control.test.ts :: [%s] a D4: the task and everything that depends on it are cancelled, the claims go, the Run finishes, and nothing is sent
- tests/run-engine/control.test.ts :: work that is not proven stopped, or a dependent that already started, is not cancelled
- tests/run-engine/driver.test.ts :: the decision of a frozen supplement can only be answered with cancel: a retry is refused, a cancel releases the claim and the dependents
- tests/run-engine/driver.test.ts :: a task of the same Run is held back by the frozen claims of a task that reported blocked, and the refusal names them as frozen — 同 Run：任务 t1 报告 `blocked` 后占用全部冻结，独立的 t2 的派发被 `lock-conflict` 挡住，明细里有 `reason: frozen`，宿主零发送（A16）
- tests/run-engine/driver.test.ts :: another Run's frozen task keeps this Run waiting until that task is cancelled; then the next pass sends — 跨 Run：A 的 `blocked` 任务冻结占用，B 一直等；A 的人答复 `cancel` 后占用清空，B 下一遍派发（A4 笔记里记着当时没写的用例，A16 补上）
- tests/run-engine/driver.test.ts :: another Run's task whose delivery is not known keeps its claims, and this Run waits — 跨 Run：A 的补证请求送达不明（`outcome-unknown`）使占用冻结，B 被挡且宿主零发送
- tests/run-engine/driver.test.ts :: known limitation: a member closed in the middle of its turn is not noticed; the task stays assigned with its claims, and a cancellation of the Run keeps waiting for a turn end; the host is sent nothing — 现状测试（known limitation）：成员回合中只收到 `agent.closed`，任务仍 `assigned`、占用保留、不选别的成员、宿主零 send/archive；Run 取消返回 `waiting.turns >= 1` 并继续等，Run 停在 `paused`

缺口："Agent 失联"仍是已知限制，引擎对 `closed`/`archived` 没有反应，现状测试只是把它固定下来；宿主是否发 `turn_ended` 仍没有直接证据，但 A12 在真实宿主上重启 daemon 后看到：在途回复丢失、重查用尽、没有决策、取消一直等（Run 4），与限制一致（见 `docs/next-phase-plan.md` 2.12）。派发结果不明的"保留占用"已有用例，其余缺口已由 A16 关闭。

### AC11 收到报告后 hook 才到，或 hook 早于初始化/关键记录
- tests/run-engine/observer.test.ts :: a turn end the hooks missed is recovered from the host, and a late hook is then a duplicate
- tests/run-engine/observer.test.ts :: a hook that arrives before the store is ready or before any run names the agent is kept, then delivered
- tests/run-engine/observer.test.ts :: overflow and age both drop hooks and flag that hooks alone are no longer enough
- tests/run-engine/intake.test.ts :: a report is not accepted before the host's turn_ended is recorded, and is once it is
- tests/run-engine/driver.test.ts :: a report that arrived while nothing listened is settled on recovery
- tests/run-engine/driver.test.ts :: a turn_ended hook that comes after recovery already took the report in changes nothing in the record
- tests/run-engine/observer.test.ts :: a hook that came before its seat was bound is delivered exactly once after the binding, however often the buffer is flushed
- tests/run-engine/driver.test.ts :: the repeat of a hook whose settling failed is the retry
- tests/run-engine/runtime.test.ts :: a coordinator reply whose hook was lost is picked up on the first sight of a Paseo handle

缺口："早于关键记录"只验证了 store 未就绪和无归属两种（绑定席位后恰好交付一次已补，A15）；晚到的 hook 在记录层不变，只验证了 `turn_ended` 一种。

### AC12 权限等待、人的决定重复提交、等待期间重启
- tests/run-engine/service.test.ts :: a seat waiting on a permission or reporting an error is not used
- tests/run-engine/observer.test.ts :: an event storm of repeats and reorderings leaves one receipt per distinct fact — 重复的 `permission_requested` 只记一次
- tests/run-view/waiting.test.ts :: a permission wait names the owner and says the Engine never answers — 文案
- tests/run-engine/permission-wait.test.ts :: the Engine port and server have no permission-answering method
- tests/run-engine/service.test.ts :: an idle eligible seat is used while another eligible seat waits for permission
- tests/run-engine/driver.test.ts :: a permission request records the wait without running the dispatcher
- tests/run-engine/driver.test.ts :: a permission wait survives recovery; resolution and the eventual report are each handled once

缺口：测试用假宿主脚本模拟人的权限回应；真实宿主权限对话只观察到一次（Run 2，审查者 blocked `PERMISSION_REQUIRED`，引擎不代答，只给重试/取消），人的重复操作仍未测（重试是决策重试，不是权限回应）。Engine 不提供权限决定 RPC。

### AC13 临时失败、退避未到期/已到期、预算耗尽
- tests/run-engine/read-retry-server.test.ts :: it is written down, a timer is set for the first try, and nothing is read before it is due
- tests/run-engine/read-retry-server.test.ts :: three failures 1, 2 and 4 seconds apart use the item up; it is never read again and no timer is left
- tests/run-engine/read-retry.test.ts :: nothing is tried before it is due, and a try is counted before the read
- tests/run-engine/driver.test.ts :: the budget is the policy's protocolResends, then the task waits as before
- tests/run-core/r01g-behavior.test.ts :: a supplement's own format repair is another model turn: reserved once, refused when the budget is spent
- tests/run-engine/control.test.ts :: [%s] a task held back for want of turns is said so once, and goes out once after the seat is given more
- tests/run-engine/control.test.ts :: the refusals: stale revision, unknown seat, no budget, over the ceiling, a Run being cancelled
- tests/run-engine/budget-control.test.ts :: the limit has a ceiling: exactly the maximum is allowed, one more is not
- tests/run-engine/failure-limit.test.ts :: counts only tasks that are failed now
- tests/run-engine/failure-limit.test.ts :: exactly at the limit is not over it; one more is
- tests/run-engine/failure-limit-driver.test.ts :: a Run at its limit still hands out work, and says nothing about failures
- tests/run-engine/failure-limit-driver.test.ts :: [%s] over the limit the review of a started task goes out, and the task that waited behind it is then held back: one critical alert, the reason on the task, nothing sent, later passes write nothing
- tests/run-engine/failure-limit-driver.test.ts :: cancelling failed tasks until the count is back within the limit reopens dispatch and takes the alert down, once
- tests/run-engine/failure-limit-driver.test.ts :: what is already in flight is still taken in, a report that must be repaired is still asked for again, and the repaired delivery goes to its reviewer
- tests/run-engine/failure-limit-driver.test.ts :: a task that has not started is held back without hiding the review of a started one behind it
- tests/run-engine/failure-limit-driver.test.ts :: a review that sends a started task back for rework is followed by the producer although the limit is exceeded (not-started task alongside: %s)
- tests/run-engine/failure-limit-driver.test.ts :: [v2] a request to add missing evidence to a delivery is sent although the limit is exceeded, and the supplement goes on to review
- tests/run-engine/failure-limit-driver.test.ts :: a smoke of a started task is sent although the limit is exceeded, and t2 after it is held back
- tests/run-engine/coordinator-budget.test.ts :: the plan request is the first turn: the entry takes the policy's limit, one reserved, and nothing else changes — 模板（v1、v2 各一遍）：新 Run 的计划请求扣第一回合，冻结的策略不被写（A14）
- tests/run-engine/coordinator-budget.test.ts :: a re-plan is the next turn: one more reserved, the Run still passes its invariants — 模板（v1、v2）（A14）
- tests/run-engine/coordinator-budget.test.ts :: with no turns left a re-plan is refused as budget-exhausted, and the Run is not touched — 模板（v1、v2）（A14）
- tests/run-engine/coordinator-budget.test.ts :: a Run with no entry gets one on first use, counting every plan request it holds, failed ones included — 模板（v1、v2）：旧 Run 懒建条目，`reserved` 是 outbox 里计划请求的个数（下界），再看一次得到同一对象（A14）
- tests/run-engine/coordinator-budget.test.ts :: a format re-send of the plan is not a turn of the budget — 模板（v1、v2）（A14）
- tests/run-engine/coordinator-budget.test.ts :: the coordinator's row is raised like a seat's: the new limit is in the entry, the policy and the alert are not touched — 模板（v1、v2）（A14）
- tests/run-engine/control.test.ts :: [%s] a re-plan with no turns left is refused with one warning and nothing sent; turns added from the page take the warning down and the re-plan goes out once — 真实 store 与 driver：额度 1 时重新规划被拒、恰好一条 open 警告、宿主零发送，再问一次不写；对 `coordinator` 追加预算后警告 `resolved`，再重新规划成功，协调者恰好收到一条，同一请求再来 `replayed` 且不再扣（A14）
- tests/run-engine/control.test.ts :: turns added to a coordinator that never asked for a re-plan build its row first, from the plan request the Run already used — 旧 Run 没有条目时 `run.budget` 先建条目再追加（A14）
- tests/run-engine/start.test.ts :: the plan request is the coordinator's first turn: its budget entry takes the policy's limit with one reserved, and the policy is not written — A14 新增
- tests/run-engine/start.test.ts :: a coordinator turn budget of 0 stops the launch before anything exists: there is no turn to send the plan request in — A14 新增
- tests/run-engine/team-config.test.ts :: a coordinator turn budget under 1 blocks the launch: the plan request would have no turn to be sent in — A14 新增
- tests/run-engine/team-config-edit.test.ts :: a coordinator turn budget of 0 is a blocker the moment it is typed, and 1 clears it — A14 新增

缺口：退避只存在于宿主读取失败的重查（1、2、4 秒、三次）；派发之后的临时失败没有自动重试（B7）；报告重发只有次数没有截止时间；协调者的回合预算只计计划请求与重新规划（A14）：计划格式重发不计、不退还，`reserved` 对旧 Run 只是下界；预算耗尽不开决策，由告警和追加预算的 RPC 代替（A6）；没有分组预算的入口（只有席位）。失败的任务数超过 `policy.run.failedTasks` 后不再开始尚未开始的任务，已在进行的评审、冒烟、补证请求与返工照常（A13）：用例用直接加入 `failed` 任务造出失败数，A4 的 `cancel` 答复以任务变为 `cancelled` 代替，没有对 D3 的 `retry` 做端到端。

### AC14 暂停、续办、取消时 Agent 仍有在途执行
- tests/run-engine/effects.test.ts :: the pause that lands after the caller read the ledger still stops the send
- tests/run-engine/effects.test.ts :: a paused Run still reads the host: an unknown delivery is settled by echo, never re-sent
- tests/run-engine/effects.test.ts :: resumed, the prepared message goes out once and only once
- tests/run-engine/driver.test.ts :: a paused Run sends nothing until it is resumed
- tests/run-engine/driver.test.ts :: pause and resume through the lifecycle control: nothing goes out while paused, the held work goes out once on resume
- tests/run-engine/lifecycle.test.ts :: an active Run is paused by the reducer's own event, once
- tests/run-engine/lifecycle.test.ts :: a paused Run becomes active and the driver is asked to push it, as after a write
- tests/run-engine/control-lifecycle.test.ts :: the same request again is the same request: replayed, nothing written
- tests/run-engine/control.test.ts :: a paused Run answers nothing: the decision offers no action and the answer is refused
- tests/run-engine/control.test.ts :: [%s] a running turn is waited for, its report is taken in, and then the whole Run is cancelled without a single message
- tests/run-engine/control.test.ts :: a delivery whose result is not known keeps the cancellation waiting until its echo settles it
- tests/run-engine/control.test.ts :: a request that was written and not finished is finished by the recovery of a new process, once
- tests/run-engine/control.test.ts :: two finishers at once commit one cancellation
- tests/run-engine/cancel-request.test.ts :: a turn that started after the receipt is a turn still running
- tests/run-engine/control-lifecycle.test.ts :: a repeat is found before the revision is checked, so a Run that moved on still answers replayed
- tests/run-engine/control-lifecycle.test.ts :: a paused Run becomes active and the driver is asked to push it on, as after a write
- tests/run-engine/driver.test.ts :: pause and resume as RPCs: nothing goes out while paused, the held work goes out once after the resume answer
- tests/run-core/reducer.test.ts :: cancel releases only after explicit authorization and the quiescence check
- tests/spec/run-core-reducer.spec.test.ts :: quiescence rejects a stale observation and a refresh before the end
- tests/spec/run-core-reducer.spec.test.ts :: an answered cancel decision plus idle refresh releases the frozen claim
- tests/run-engine/start-recovery.test.ts :: a second look finds nothing and writes nothing
- tests/run-engine/start-recovery.test.ts :: a failed interrupted launch no longer keeps a read retry timer
- tests/run-engine/driver.test.ts :: a dispatch that was committed and never sent is withdrawn locally when the Run is cancelled: the Run is the cause, its claims go, and the host is sent nothing — 真实 store：派发已提交（`prepared`）但进程停在发送之前，Run 取消后该意图 `failed`、`localCancellation` 为 `{ reason: cancel-before-send, cause: run-cancelled }`，占用清空、nonce 以 `cancel-before-send` 作废，宿主零发送（A16）

缺口：暂停、续办与取消都已是 RPC 并有页面入口。真实宿主上 Run 1 的阻塞取消完成并释放；Run 4 在重启丢失在途回复后取消停在 paused、`waiting.turns=1`，释放不了（2.12 的已知限制）。启动中断后已安全关闭并告警，完整续办仍推迟（B13）。归档式取消（不等回合结束）推迟，见 `docs/next-phase-plan.md` 2.3。取消的 RPC 与决策答复见 A4、A5。

### AC15 台账损坏、未知版本、CAS 冲突、超过硬上限
- tests/run-engine/store.test.ts :: corrupt bytes are preserved, quarantined with a diagnostic, and refuse updates
- tests/run-engine/store.test.ts :: an unknown schema version is left byte-for-byte untouched and reported
- tests/run-engine/store.test.ts :: a record over the hard limit is reported and never overwritten or truncated
- tests/run-engine/store.test.ts :: a commit over the hard limit is refused and the stored record is unchanged
- tests/run-engine/store.test.ts :: concurrent updates on one run serialize and lose nothing
- tests/spec/ledger-real-fs.spec.test.ts :: rejects the loser when two processes commit from the same read
- tests/run-engine/queries.test.ts :: missing, corrupt and unknown-version are distinct answers with a stable code
- tests/run-engine/queries.test.ts :: pages newest first, never repeats a run, and lists damaged runs as health instead of hiding them
- tests/run-engine/compaction.test.ts :: events from the creation of the oldest open assignment on are never taken
- tests/run-engine/compaction.test.ts :: never touches the arrays that are the state, nor tasks, claims, budgets or decisions
- tests/run-engine/compaction-store.test.ts :: at a limit nothing new starts, with a critical alert written once
- tests/run-engine/compaction-store.test.ts :: a pass compacts first, once, and a Run with little history is left alone
- tests/ledger-primitives.test.ts :: a %s being written is re-read without stealing it or reporting corruption — 模板；覆盖主锁与回收 guard
- tests/ledger-primitives.test.ts :: a permanently malformed lock is still refused after bounded re-reads

缺口：回执（`eventReceipts`）与 nonce（`nonceRegistry`）是状态而不是历史，不能压缩，达到 6144 只告警、达到 7680 停止新的派发；A12 没有在 DEV 验证（压缩要上千条事件；本轮也没有构造损坏台账、未知版本或容量上限）。

### AC16 旧 Run、新配置旧客户端、引擎关闭或配置损坏
- tests/run-engine/ledger-versions.test.ts :: v1 initialize, queries, recovery and reopen do not migrate or reserialize bytes
- tests/run-engine/get-session.test.ts :: an answer this build cannot parse asks the user to refresh the plugin, never a fake view
- tests/run-engine/team-config.test.ts :: an enabled invalid block blocks and never falls back to the coordinator chain
- tests/launch-service-engine.test.ts :: is blocked the same way when the switch is off, and the Engine is never asked
- tests/launch-engine-dialog.test.ts :: a host that cannot run the Engine refuses an enabled Team instead of quietly using the old chain
- tests/launch-engine-dialog.test.ts :: a damaged block is a blocker that says the old chain is not used
- tests/run-engine/runtime.test.ts :: it cannot start a new Run, but a hook still admits the plan and dispatches
- tests/run-engine/runtime.test.ts :: it can still be listed and read, and its controls still answer
- tests/run-view/runs-tab.test.ts :: both are listed together; neither list hides, replaces or invents the other — 渲染 `RunsTab`：真实 `run.list` 查询（真实 store 里的 Engine Run）与标签派生的协调者链路 Run 同时出现，Engine 段在上（A16）
- tests/run-view/runs-tab.test.ts :: with no Engine Run the page is what it was: the Engine section is not drawn and the chain's Run is — 没有 Engine Run 时不画 Engine 段，链路的 Run 照旧（A16）
- tests/run-engine/runtime.test.ts :: the Run is still read, kicked and controlled on the policy and roster it froze; only a new launch sees the damaged block — Run 启动后 Team 的块被原地掏空、整块删除、另存一份坏块：新的启动被阻断或走旧链路，既有 Run 仍被列出、读取、入账派发、kick、暂停与继续，台账里冻结的策略与席位逐字节不变（A16）
- tests/run-view/launch-dialog.test.ts :: a host that cannot run the Engine: the blocker is shown, the old chain is not offered, and launch stays off — 挂载 `LaunchDialog`：不支持 Engine 的宿主给出阻断文案，启动按钮关闭，不调用启动（A17）
- tests/run-view/launch-dialog.test.ts :: a roster that does not match the Team names the missing seat — 挂载 `LaunchDialog`：席位对不上时点名缺的席位，启动按钮关闭（A17）

缺口：无（页面本身不读取开关，开关关闭时 `run.list` 与控制仍可用由 runtime.test.ts 既有两例证明；没有把两者放进同一个渲染用例）。

### AC17 长时间无 hook 且无到期工作；重复普通状态事件
- tests/run-engine/driver.test.ts :: a hook delivered twice, or for an agent no Run knows, sends nothing more
- tests/run-engine/driver.test.ts :: a burst of kicks costs one pass and one more, not one each
- tests/run-engine/control.test.ts :: two kicks at once cost one pass: the second joins the first instead of reading the host again
- tests/run-engine/observer.test.ts :: an event storm of repeats and reorderings leaves one receipt per distinct fact
- tests/run-engine/queries.test.ts :: reading never changes the stored record
- tests/run-engine/driver.test.ts :: idle kicks and repeated or unowned events write nothing and never wake the coordinator
- tests/run-engine/failure-limit-driver.test.ts :: a Run with failures over the limit and nothing left to start is left alone
- tests/run-engine/coordinator-budget.test.ts :: asking again with the same request id is the same request: it answers replayed and counts nothing — 模板（v1、v2）：同一个重新规划请求重放不再扣协调者的回合（A14）
- tests/run-engine/driver.test.ts :: an idle Run, 24 hours later, has made no call to the host, written nothing and left no timer behind — 假计时器前进 24 小时：宿主的读（时间线与席位状态）与归档调用数不变、发送数不变、账本修订号/告警/回执不变，`vi.getTimerCount()` 前后均为 0（A16）

缺口：新用例喂入 5 轮重复事件并 kick，断言修订号不变、没有发送和重查计时器；假时钟 24 小时已证明零宿主读写与零计时器（A16）；没有真实时间长跑，也没有 DEV 验证。唯一的定时器是宿主读取重查；战略协调者的决策唤醒规则（`classifyWake`）只被测试使用，服务端不发送。

### AC18 战略协调者规划后，N 个成员事件正常流转
- tests/run-engine/driver.test.ts :: two tasks, one after the other: nothing starts until what it waits for has passed every gate — 之后只有给成员的消息，四条，没有重复，没有发给协调者
- tests/run-core/wake.test.ts :: new open decisions wake once with a stable key; ordinary progress does not
- tests/run-engine/control.test.ts :: [%s] a re-plan with no turns left is refused with one warning and nothing sent; turns added from the page take the warning down and the re-plan goes out once — 协调者的调用（计划请求与重新规划）现在有记账，一个请求恰好扣一回合（A14）

缺口：对协调者"不发消息"只是间接观察；相同决定的去重只在纯分类器里演示；服务端本就不向协调者发决策唤醒。协调者的调用有记账（A14），耗尽时重新规划被拒。

### AC19 列表、详情、历史、刷新、M1 对账查询
- tests/run-engine/queries.test.ts :: reading never changes the stored record
- tests/run-engine/queries.test.ts :: event payloads never reach the page, only the kind and a task id
- tests/run-engine/queries.test.ts :: the list, the detail and every history page leave a Run with a message waiting to go out byte for byte as it was, and write nothing
- tests/run-engine/control.test.ts :: nothing the controls return holds a nonce, a prompt or an outbox argument
- tests/run-engine-contracts.test.ts :: run.get returns unchanged or a redacted view with no nonce/prompt fields

缺口：无（查询函数不持有宿主，"不派发"是结构性的，没有 `host.sent` 可断言，A15 改为断言 `create`/`update` 零调用、文件字节和目录不变、待发消息仍为 prepared；M1 对账查询不提供，由 kick 代替，见 `docs/next-phase-plan.md` 2.3，`run.reconcile` 不批准）。

### AC20 用户绕过 Engine 发消息，或观察到无 assignment 的活动
- tests/run-engine/observer.test.ts :: with no live run nothing could claim an agent, so its events are ignored, not buffered
- tests/run-engine/observer.test.ts :: an agent named by two runs is not attributed to either
- tests/run-engine/observer.test.ts :: another agent's timeline never contains the dispatch, so its text cannot stand in
- tests/run-engine/intake.test.ts :: an agent with no assignment, and an unknown agent, have nothing to settle
- tests/run-engine/driver.test.ts :: known limitation: a message the person typed is not a delivery and changes no task, assignment, decision or alert; no abnormal-activity record is made — 现状测试（known limitation）：用户在成员聊天里发消息、成员用文字回答、该回合结束：任务/assignment/outbox/占用逐项不变，无决策、无告警，宿主零发送（A16）

缺口：不做异常记录，理由见 `docs/next-phase-plan.md` 2.12/A16（人直接和成员对话是正当用法，没有批准的异常语义）：无归属的活动与用户消息都被静默忽略，不写告警、不写审计事件、不核对受影响资源；现状测试只固定"不被当成交付、不改任务状态、不报警"。

### AC21 定时到期、重启补算、时钟前进或回退
- tests/run-engine/read-retry-server.test.ts :: a clock that went back never makes a try early, and the wait is cut to 30 seconds
- tests/run-engine/read-retry-server.test.ts :: a clock that jumped forward gives each due item one try, not several
- tests/run-engine/read-retry-server.test.ts :: works the due time out again from the ledger instead of starting over
- tests/run-engine/read-retry-server.test.ts :: a Run that ends while an item waits is not read, and does not keep the timer spinning
- tests/run-engine/read-retry-server.test.ts :: only the first three times a source recovers are told; the fourth is left with the warning
- tests/run-engine/read-retry-server.test.ts :: the reply an open assignment waits for is handed to the re-checks, with the assignment's own fields
- tests/run-engine/read-retry.test.ts :: a clock that jumped forward gives every due item one try, not several
- tests/run-engine/read-retry.test.ts :: a try cut off by a restart is used: it waits for the next one, or is used up on the third

缺口：无（范围声明：现有唯一的截止条件是宿主读取重查，上面的用例覆盖了它；派发后的退避、预算窗口等别的截止条件不存在，B7 已推迟，所以没有别的可测对象。DEV 没有做）。

### AC22 Runs 详情、历史翻页、`unchanged`、断线重连、小屏布局
- tests/run-engine/get-session.test.ts :: unchanged for the held revision keeps the same session object, so nothing flashes empty
- tests/run-engine/get-session.test.ts :: unchanged with nothing held, or for another revision, asks for the full view
- tests/run-engine/get-session.test.ts :: an unreadable run replaces the last good view instead of presenting it as current
- tests/run-engine/get-session.test.ts :: an expired cursor restarts at the newest page and discards the loaded older pages
- tests/run-engine/get-session.test.ts :: a full answer for the revision already shown changes nothing, so nothing repaints
- tests/run-engine/queries.test.ts :: a cursor from another run, or from before a checkpoint change, expires and restarts at the newest page
- tests/run-view/engine-view.test.ts :: compact layout uses the layered list while wide mode keeps the columns
- tests/run-view/engine-view.test.ts :: unchanged is a W01 handoff and renders neither a fake ready nor a failure card
- tests/run-view/layout-guard.test.ts :: every pressable control has a touch-sized minimum height
- tests/run-view/waiting.test.ts :: every event kind the reducer and the counters write has words
- tests/run-engine/decision-answer.test.ts :: classifies quality, stopped actors, missing reports and cancellations without exposing ledger details
- tests/run-engine/queries.test.ts :: a decision kind survives the new projection and older clients can strip it
- tests/run-view/controls.test.ts :: the server's decision kind distinguishes the retry and unknown kinds fall back
- tests/run-view/waiting.test.ts :: explains a known decision kind and falls back for old or future servers
- tests/run-view/control-runner.test.ts :: uses random bytes for a version 4 UUID when randomUUID is unavailable
- tests/run-view/control-runner.test.ts :: uses a version 4 UUID even when the platform has no crypto
- tests/run-view/controls.test.ts :: a request that never got an answer does not ask for a refresh
- tests/run-view/waiting.test.ts :: dispatch-blocked: every builder refusal has words, including dynamically chosen budget codes
- tests/run-engine/failure-limit-driver.test.ts :: [%s] over the limit the review of a started task goes out, and the task that waited behind it is then held back: one critical alert, the reason on the task, nothing sent, later passes write nothing
- tests/run-view/waiting.test.ts :: replan and cancellation events do not claim unproved sends or released claims
- tests/run-view/engine-view.test.ts :: shows an alert's summary and states when the responsible party is unknown
- tests/run-view/run-engine-editor.test.ts :: the planned Profiles of the seats let the editor warn about a Codex seat that is not full-access
- tests/run-view/run-engine-section.test.ts :: a Codex seat whose Profile is not full-access gets the warning, once the plan has answered — 挂载 Team 编辑器的 Run Engine 区（A17）：规划回答之后警告出现，之前没有
- tests/run-view/run-engine-section.test.ts :: editing a policy number writes the block back with every field it did not know — 编辑策略数字后保留未知字段（A17）
- tests/run-view/seat-profile-facts.test.ts :: TeamEditor hands the plan's rows to the section and does not build the facts itself — 源码扫描：`TeamEditor` 把规划行交给该区（A17）
- tests/run-view/launch-dialog.test.ts :: kickoff-pending: the plan request is submitted, it takes minutes, do not start again — 挂载 `LaunchDialog`：运行中文案（A17）
- tests/run-view/launch-dialog.test.ts :: a failed launch shows the error, its detail and the kickoff message to copy — 挂载 `LaunchDialog`：失败的启动显示错误与详情，可复制启动消息（A17）

缺口：真实浏览器、窄屏与断线重连已由 A12 在 DEV 看过一次（1280x900 与 390x844 无横向溢出、按钮可点、停 daemon 显示不可用而非空进度、同端口重启自动重连）；但 Runs 列表把 active 阻塞与 cancelled 的 Run 显示为"已完成"并计入"已结束"，与台账 lifecycle 和同页顶部摘要不一致（缺陷）。"原因与台账一致"仍缺端到端逐项比对；服务端推送式失效没有做（B8）。Team 编辑器的 Run Engine 区与启动对话框的 Engine 文案已用 `react-test-renderer` 挂载渲染（A17），但那不是真实浏览器。

## 这份表之外还没做的

- 第 5 节的 DEV 真实验证做了第一轮（A12，2026-11-08，4 个 Run，haiku 5.5 + luna，N=1）：`replan` 的 v4 提示词、判官重派、重启后 `kick`、S1 在真实宿主上的重查、真实浏览器与窄屏、断线重连各有一次记录；补证模板没有触发（生产者的首份报告都被直接接受），V2′ 幂等键探针与 F 失败回合样本没有做。DEV 还暴露了两条缺陷/已知限制，见 `docs/autonomous-notes.md`。
- 已裁决推迟或不做的事项（完整续办、在途成员的归档式取消、`assign-seat`、派发后的自动重试、推送式失效、补报清理加固、成员回合中被关闭的恢复、默认开启）及其残余风险见 `docs/next-phase-plan.md` 第 2 节与 5.2；它们是已接受的残余风险；与某一项直接相关的，已在那一项的缺口栏里写明。
- 缺口栏沿用 B1–B13 编号；其中部分已裁决或实施，具体范围与仍推迟的内容见 `docs/autonomous-notes.md` 的裁决与进度。

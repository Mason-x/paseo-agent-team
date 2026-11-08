# Run Engine 验收表（AC01–AC22）

编写：2026-11-08（无人值守会话）。矩阵来源：`docs/run-engine-iteration-plan.md` 第 7 节。实施记录：同文件第 8 节 P04 行。

这份表如实记录每一项验收**现在**有什么证据、缺什么。它不是"全部通过"的声明：

- **已覆盖**：有离线测试（纯核、真实 store、假宿主）直接观察到"必须观察到的结果"，缺口栏只剩细节。
- **部分**：有测试覆盖一部分，缺口栏写明缺什么。
- **未覆盖**：没有测试。
- **需 DEV**：离线测试之外，还需要在专用 DEV daemon 上用真实模型和真实 Paseo 观察。所有项目的这一步目前都没有做完，见"DEV 记录"栏。

证据一律写成 `- 测试文件 :: 用例名`，用例名与测试文件里的标题逐字一致；`paseo-agent-team/tests/run-engine/acceptance-doc.test.ts` 会读这份文档，检查每一条引用的文件存在、用例名确实出现在该文件里，所以引用不会随重命名悄悄失效。标题由 `test.each` 模板生成的，在说明里写"模板"，不参与逐字检查。"待批准"一栏的编号 B1–B13 指 `docs/autonomous-notes.md` 的待批准清单（本轮无人值守会话的笔记）。

## 总表

| ID | 必须观察到的结果 | 状态 | 缺口（一句话） | 待批准 | DEV 记录 |
| --- | --- | --- | --- | --- | --- |
| AC01 | T2 不派发；T1 仍需满足其声明的审查和冒烟 | 部分 | 没有"带冒烟的 T1 + 依赖它的 T2"的引擎级用例 | — | 第 20、21 点（正常路径，非注入） |
| AC02 | 不能过完成门；显示具体拒绝原因 | 部分 | 旧 `reviewedRef`、自审、错 DEV 目标只断言被拒，没断言原因；没有页面端到端 | — | 无 |
| AC03 | 一次生效；assignment、预算、下一阶段不重复增加 | 已覆盖 | 没有把"重放报告 hook"与预算、assignment 计数放在同一用例里断言 | — | 无 |
| AC04 | 恢复后执行该意图或按合同终止，不漏记也不额外派一份 | 已覆盖 | "意图提交后、调用前"的中断用抛错和新实例模拟，不是真实进程被杀 | — | 无 |
| AC05 | 先核对实际消息和 turn；无法证明时冻结，不盲目重发 | 已覆盖 | 证明只靠用户消息回显（messageId）；没有宿主证明"消息确实没到"的用例 | — | 无 |
| AC06 | 按运行关联查证；不重复创建、不误删无关 Agent | 部分 | 假适配器在创建前就抛错，没有模拟"已创建但响应丢失"；创建中崩溃后安全关闭并告警，未登记的 Agent 仍需人工查找，不能完整续办 | B13 | 第 21、30 点（只记录了 Windows `EPERM` 重试，没有重复创建的证据） |
| AC07 | 只尝试有界补报；保留产物；协议失败与质量返工分开 | 部分 | 没有断言协议失败不改变 `qualityFailures`、`reworkCount`；DEV 没跑过成员报告补报 | — | 第 25、26、32 点 |
| AC08 | 严格拒收；不推进任务、不放宽身份校验 | 已覆盖 | 经入账路径只演练了 nonce 不符；错任务、错 attempt、未知版本、发送者只在解析与归属层 | — | 第 25、28 点 |
| AC09 | 仅一方获写占用；另一方等待并给出原因 | 部分 | 别名只在锁函数层测过；双 Run 派发用例用整仓 `hot` 占用，不是带别名的文件路径；没有"先放开后另一方继续" | — | 无 |
| AC10 | 保留相关冻结占用；冲突任务不能趁机开始 | 部分 | 冻结占用有页面出路（取消任务或取消 Run，经授权才释放）；"Agent 失联"没有用例；没有"冲突任务在派发处被冻结占用挡住"的引擎级用例，也没有跨 Run 的释放用例 | — | 无 |
| AC11 | 按证据补对账并去重；不丢结果，不重复统计 | 部分 | "整份报告之后才来的 hook"只验证了 `turn_ended`；"早于关键记录"只验证了 store 未就绪和无归属；宿主读不全的回复现在会被重查并在恢复后自动继续 | — | 无 |
| AC12 | 不自行答权限；决定只作用一次；恢复后只继续剩余阶段 | 部分 | 假宿主已覆盖权限等待重启、解除回执去重与报告一次入账；真实宿主权限对话和人的重复操作未在 DEV 验证 | — | 无 |
| AC13 | 截止前不重派；到期按预算执行；耗尽不继续消耗模型 | 部分 | 退避只存在于宿主读取失败的重查（现含不完整窗口、对账读取、补证前的席位刷新，恢复后自动继续前 3 次）；派发之后的临时失败没有自动重试；预算耗尽有告警和追加预算的 RPC（不开决策）；没有分组预算的入口、协调者没有回合预算 | A7、A11 | 无 |
| AC14 | 暂停停新派发；续办重新核对；取消证实静止后才释放 | 部分 | 暂停、续办、单任务取消和整个 Run 的延迟取消都有入口；启动中断已安全关闭但不能续办；"暂停扣住的从未发出的派发"没有 store 级用例；没有 DEV | B13 | 无 |
| AC15 | 保留原始数据；诊断可见；不覆盖、不截断、不越限派发 | 部分 | 存储层与容量门（接近上限不再派发新工作）、事件压缩已覆盖；回执与 nonce 没有压缩办法，真到上限的 Run 只能收尾后重启；没有 DEV | — | 无 |
| AC16 | 旧 Run 可看；不支持时清晰阻断，不静默采用另一条执行链 | 部分 | 没有"引擎关闭时 Runs 页同时显示旧链路 Run 与 Engine Run"的用例，也没有已有 Run 的配置损坏的用例 | — | 无 |
| AC17 | 模型调用数为零；不为无变化输入重复记账或唤醒战略协调者 | 部分 | 假宿主已覆盖 5 次重复事件与 kick 无新发送、修订号不变且无重查计时器；没有真实时间长跑或 DEV 验证；决策唤醒协调者的逻辑只在纯分类器里 | — | 无 |
| AC18 | 没有新增决策时不逐事件唤醒；相同决定去重 | 部分 | 只有"协调者没收到消息"的间接观察；去重只在纯分类器 | B3、B6 | 无 |
| AC19 | 不触发派发；DTO 不泄漏 nonce、完整提示、Outbox 参数 | 部分 | 列表、详情、历史、刷新已覆盖；M1 对账查询没有处理器可测；"不派发"是结构性的，没有用 `host.sent` 断言 | B4 | 第 33 点（未在 DEV 验证） |
| AC20 | 不冒认成有效交付；记录异常并核对受影响资源 | 部分 | 无归属的活动被静默忽略，不写异常、不核对资源；夹具 `EXTERNAL_ACTIVITY_CASE` 没有测试使用 | B4、B12 | 无 |
| AC21 | 截止条件最终被处理；重复到期不重复副作用；不出现忙循环 | 部分 | 只有宿主读取重查这一个定时器；没有别的截止条件可测 | B7 | 第 35 点（没有 DEV） |
| AC22 | 不闪成空进度；原因与台账一致；旧历史游标失效可恢复 | 部分，需 DEV | 决策子类已由服务端投影并兼容旧客户端；没有真实浏览器与小屏检查，重连只测了纯会话规则；其余原因码靠源码扫描而非端到端比对 | B8、B10（剩余字段） | 无 |

没有 DEV 记录的项目都需要在专用 DEV daemon 上再看一遍（本轮的第 5 节 DEV 验证没有做）。

## 各项证据

### AC01 T2 依赖 T1，T1 仅提交实现报告
- tests/run-engine/driver.test.ts :: two tasks, one after the other: nothing starts until what it waits for has passed every gate — 断言 T1 在审查中 T2 仍是 `pending`，审查通过后 T2 才发出；这个计划没有冒烟要求
- tests/run-engine/service.test.ts :: a smoke is not started before the review has passed
- tests/run-engine/service.test.ts :: a reviewed task with a smoke goes to the smoker, on the registered DEV target
- tests/run-core/r01g-behavior.test.ts :: true completion makes its pending dependency ready
- tests/run-core/reducer.test.ts :: a done report and independent review move T2 to done and ready T3

缺口：冒烟未结束的情形只在 reducer 与服务层演示；没有引擎级的"T1 带冒烟、T2 依赖它"用例。

### AC02 普通文字称完成、自审、旧 `reviewedRef`、错 DEV 目标
- tests/run-core/gates.test.ts :: stale D and source-bound self reviewer cannot pass — 只断言 `ok:false`
- tests/run-core/gates.test.ts :: registered DEV passes, default target fails — 只断言 `ok:false`
- tests/run-core/gates.test.ts :: evidence single defect: $reason — 模板；断言每个证据缺陷各给出对应原因
- tests/run-core/reducer.test.ts :: a smoke report must come from the registered target and an independent smoker — 断言原因是 `invalid-smoke`
- tests/run-engine/intake.test.ts :: a reply with no report only records why the task is not moving, once — 普通文字称完成：原因 `report-missing`
- tests/run-engine/intake.test.ts :: a report that fails the evidence gate is kept out of review and the reason is shown
- tests/run-view/waiting.test.ts :: every reason a refused evidence gate can leave — 每个证据门原因都有中文说明

缺口：旧 `reviewedRef`、自审、网关层错 DEV 目标只断言被拒绝，没断言原因；没有端到端的页面显示。

### AC03 同一 hook、报告或人的决定重复到达
- tests/run-engine/observer.test.ts :: records one receipt for an owned agent and treats redelivery as a duplicate
- tests/run-engine/observer.test.ts :: an event storm of repeats and reorderings leaves one receipt per distinct fact
- tests/run-engine/intake.test.ts :: settling again changes nothing: the assignment is no longer waiting
- tests/run-engine/driver.test.ts :: a hook delivered twice, or for an agent no Run knows, sends nothing more
- tests/run-engine/driver.test.ts :: the same hook again, or a kick, does not ask twice
- tests/run-engine/control.test.ts :: the answer survives a restart: asked again afterwards it is the same answer and sends nothing
- tests/run-core/budget.test.ts :: the same intent/message is counted once without a draft

缺口：没有把"重放报告 hook"与预算、assignment 的计数放在同一个用例里一起断言。

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
- tests/run-engine/start.test.ts :: a create that fails twice with a transient error succeeds on the third try with the same key
- tests/run-engine/start.test.ts :: when a member cannot be created, what was created is archived if the preference says so
- tests/run-engine/start-recovery.test.ts :: names the coordinator as the possible unregistered agent when its creation was interrupted
- tests/run-engine/start-recovery.test.ts :: names the agents on the record and the next seat that has none
- tests/run-engine/runtime.test.ts :: a duplicate start finishing does not expose another start still creating agents to recovery

缺口：假适配器在创建前就抛错，没有模拟"已创建但响应丢失"；去重靠同一个幂等键，没有按运行关联列举查证；没有"不误删无关 Agent"的用例；启动中断会安全关闭并告警，不能完整续办，未登记的 Agent 只能靠提示人工查找（B13）。

### AC07 实现已完成但报告 JSON 错误；修复再次失败
- tests/run-engine/driver.test.ts :: a refused report gets one repair request, and the repaired report settles the task
- tests/run-engine/driver.test.ts :: the budget is the policy's protocolResends, then the task waits as before
- tests/run-engine/driver.test.ts :: a reply with no block is asked for again as missing
- tests/run-engine/driver.test.ts :: a turn that did not end on its own is not asked again
- tests/run-engine/report-repair.test.ts :: stops at the policy's protocolResends
- tests/run-engine/control.test.ts :: with no re-send to ask for, the first unusable reply is already the decision
- tests/run-core/reducer.test.ts :: incomplete evidence stays in progress and increments evidenceReturns

缺口：没有断言协议失败不改变 `qualityFailures`、`reworkCount`；"保留产物"没有直接断言；DEV 没跑过成员报告补报。

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

缺口：别名只在锁函数层演示；两个 Run 的派发用例用的是整仓 `hot` 占用，不是带别名拼写的文件路径；"先放开后另一方继续"没有演示。

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

缺口："Agent 失联"没有用例（夹具 `closed-while-assigned` 没有测试使用）；没有"冲突任务在派发处被冻结占用挡住"的引擎级用例，只有锁函数层；没有"取消后另一个 Run 拿到占用"的跨 Run 用例。

### AC11 收到报告后 hook 才到，或 hook 早于初始化/关键记录
- tests/run-engine/observer.test.ts :: a turn end the hooks missed is recovered from the host, and a late hook is then a duplicate
- tests/run-engine/observer.test.ts :: a hook that arrives before the store is ready or before any run names the agent is kept, then delivered
- tests/run-engine/observer.test.ts :: overflow and age both drop hooks and flag that hooks alone are no longer enough
- tests/run-engine/intake.test.ts :: a report is not accepted before the host's turn_ended is recorded, and is once it is
- tests/run-engine/driver.test.ts :: a report that arrived while nothing listened is settled on recovery
- tests/run-engine/driver.test.ts :: the repeat of a hook whose settling failed is the retry
- tests/run-engine/runtime.test.ts :: a coordinator reply whose hook was lost is picked up on the first sight of a Paseo handle

缺口："整份报告之后才来的 hook 且计数不变"没有单独用例；"早于关键记录"只验证了 store 未就绪和无归属两种。

### AC12 权限等待、人的决定重复提交、等待期间重启
- tests/run-engine/service.test.ts :: a seat waiting on a permission or reporting an error is not used
- tests/run-engine/observer.test.ts :: an event storm of repeats and reorderings leaves one receipt per distinct fact — 重复的 `permission_requested` 只记一次
- tests/run-view/waiting.test.ts :: a permission wait names the owner and says the Engine never answers — 文案
- tests/run-engine/permission-wait.test.ts :: the Engine port and server have no permission-answering method
- tests/run-engine/service.test.ts :: an idle eligible seat is used while another eligible seat waits for permission
- tests/run-engine/driver.test.ts :: a permission request records the wait without running the dispatcher
- tests/run-engine/driver.test.ts :: a permission wait survives recovery; resolution and the eventual report are each handled once

缺口：测试用假宿主脚本模拟人的权限回应；没有真实宿主权限对话或人重复操作的 DEV 验证。Engine 不提供权限决定 RPC。

### AC13 临时失败、退避未到期/已到期、预算耗尽
- tests/run-engine/read-retry-server.test.ts :: it is written down, a timer is set for the first try, and nothing is read before it is due
- tests/run-engine/read-retry-server.test.ts :: three failures 1, 2 and 4 seconds apart use the item up; it is never read again and no timer is left
- tests/run-engine/read-retry.test.ts :: nothing is tried before it is due, and a try is counted before the read
- tests/run-engine/driver.test.ts :: the budget is the policy's protocolResends, then the task waits as before
- tests/run-core/r01g-behavior.test.ts :: a supplement's own format repair is another model turn: reserved once, refused when the budget is spent
- tests/run-engine/control.test.ts :: [%s] a task held back for want of turns is said so once, and goes out once after the seat is given more
- tests/run-engine/control.test.ts :: the refusals: stale revision, unknown seat, no budget, over the ceiling, a Run being cancelled
- tests/run-engine/budget-control.test.ts :: the limit has a ceiling: exactly the maximum is allowed, one more is not

缺口：退避只存在于宿主读取失败的重查（1、2、4 秒、三次）；派发之后的临时失败没有自动重试（B7）；报告重发只有次数没有截止时间；计划请求、重新规划、重发不预扣预算（B2）；预算耗尽不开决策，由告警和追加预算的 RPC 代替（A6）；没有分组预算的入口（只有席位）。

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

缺口：暂停、续办与取消都已是 RPC 并有页面入口，但没有在 DEV 验证；"暂停扣住的从未发出的派发被本地撤回"没有 store 级用例。启动中断后已安全关闭并告警，完整续办仍推迟（B13）。取消的 RPC 与决策答复见 A4、A5。

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

缺口：回执（`eventReceipts`）与 nonce（`nonceRegistry`）是状态而不是历史，不能压缩，达到 6144 只告警、达到 7680 停止新的派发；没有在 DEV 验证（压缩要上千条事件）。

### AC16 旧 Run、新配置旧客户端、引擎关闭或配置损坏
- tests/run-engine/ledger-versions.test.ts :: v1 initialize, queries, recovery and reopen do not migrate or reserialize bytes
- tests/run-engine/get-session.test.ts :: an answer this build cannot parse asks the user to refresh the plugin, never a fake view
- tests/run-engine/team-config.test.ts :: an enabled invalid block blocks and never falls back to the coordinator chain
- tests/launch-service-engine.test.ts :: is blocked the same way when the switch is off, and the Engine is never asked
- tests/launch-engine-dialog.test.ts :: a host that cannot run the Engine refuses an enabled Team instead of quietly using the old chain
- tests/launch-engine-dialog.test.ts :: a damaged block is a blocker that says the old chain is not used
- tests/run-engine/runtime.test.ts :: it cannot start a new Run, but a hook still admits the plan and dispatches
- tests/run-engine/runtime.test.ts :: it can still be listed and read, and its controls still answer

缺口：没有"引擎关闭时 Runs 页同时显示协调者链路的旧 Run 与 Engine Run"的用例；没有"台账里已有 Run 的配置损坏"的用例。

### AC17 长时间无 hook 且无到期工作；重复普通状态事件
- tests/run-engine/driver.test.ts :: a hook delivered twice, or for an agent no Run knows, sends nothing more
- tests/run-engine/driver.test.ts :: a burst of kicks costs one pass and one more, not one each
- tests/run-engine/control.test.ts :: two kicks at once cost one pass: the second joins the first instead of reading the host again
- tests/run-engine/observer.test.ts :: an event storm of repeats and reorderings leaves one receipt per distinct fact
- tests/run-engine/queries.test.ts :: reading never changes the stored record
- tests/run-engine/driver.test.ts :: idle kicks and repeated or unowned events write nothing and never wake the coordinator

缺口：新用例喂入 5 轮重复事件并 kick，断言修订号不变、没有发送和重查计时器；没有让真实时间长时间过去，也没有断言所有只读宿主调用为零。唯一的定时器是宿主读取重查；战略协调者的决策唤醒规则（`classifyWake`）只被测试使用，服务端不发送。

### AC18 战略协调者规划后，N 个成员事件正常流转
- tests/run-engine/driver.test.ts :: two tasks, one after the other: nothing starts until what it waits for has passed every gate — 之后只有给成员的消息，四条，没有重复，没有发给协调者
- tests/run-core/wake.test.ts :: new open decisions wake once with a stable key; ordinary progress does not

缺口：对协调者"不发消息"只是间接观察；相同决定的去重只在纯分类器里演示。

### AC19 列表、详情、历史、刷新、M1 对账查询
- tests/run-engine/queries.test.ts :: reading never changes the stored record
- tests/run-engine/queries.test.ts :: event payloads never reach the page, only the kind and a task id
- tests/run-engine/control.test.ts :: nothing the controls return holds a nonce, a prompt or an outbox argument
- tests/run-engine-contracts.test.ts :: run.get returns unchanged or a redacted view with no nonce/prompt fields

缺口：查询不接触宿主，"不派发"是结构性的，没有用 `host.sent` 断言；M1 对账查询只有 schema 形状，没有处理器（B4）。

### AC20 用户绕过 Engine 发消息，或观察到无 assignment 的活动
- tests/run-engine/observer.test.ts :: with no live run nothing could claim an agent, so its events are ignored, not buffered
- tests/run-engine/observer.test.ts :: an agent named by two runs is not attributed to either
- tests/run-engine/observer.test.ts :: another agent's timeline never contains the dispatch, so its text cannot stand in
- tests/run-engine/intake.test.ts :: an agent with no assignment, and an unknown agent, have nothing to settle

缺口：无 assignment 的活动不会被当成交付，但被静默忽略：不写异常告警、不写审计事件、不核对受影响资源；对有 assignment 的成员发用户消息没有被当作异常测试。

### AC21 定时到期、重启补算、时钟前进或回退
- tests/run-engine/read-retry-server.test.ts :: a clock that went back never makes a try early, and the wait is cut to 30 seconds
- tests/run-engine/read-retry-server.test.ts :: a clock that jumped forward gives each due item one try, not several
- tests/run-engine/read-retry-server.test.ts :: works the due time out again from the ledger instead of starting over
- tests/run-engine/read-retry-server.test.ts :: a Run that ends while an item waits is not read, and does not keep the timer spinning
- tests/run-engine/read-retry-server.test.ts :: only the first three times a source recovers are told; the fourth is left with the warning
- tests/run-engine/read-retry-server.test.ts :: the reply an open assignment waits for is handed to the re-checks, with the assignment's own fields
- tests/run-engine/read-retry.test.ts :: a clock that jumped forward gives every due item one try, not several
- tests/run-engine/read-retry.test.ts :: a try cut off by a restart is used: it waits for the next one, or is used up on the third

缺口：这只覆盖了唯一的定时器（宿主读取重查）；派发退避、预算窗口等别的截止条件不存在，所以没有可测的对象（B7）。

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

缺口：没有真实浏览器与窄屏检查，只有对源码的静态保护（无固定宽度、按钮最小高度、可换行、单个滚动条）；断线重连只测了纯会话规则；"原因与台账一致"靠源码扫描，没有端到端比对；服务端推送式失效没有做（B8）。需 DEV。

## 这份表之外还没做的

- 第 5 节的 DEV 真实验证没有做：补证模板是否被真实模型遵守、`replan` 的提示词、判官重派、重启后 `kick`、S1 在真实宿主上的重查、新界面的真实浏览器检查。
- 缺口栏沿用 B1–B13 编号；其中部分已裁决或实施，具体范围与仍推迟的内容见 `docs/autonomous-notes.md` 的裁决与进度。

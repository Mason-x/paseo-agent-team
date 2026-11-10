# 无人值守会话笔记

计划：`docs/remaining-work-plan.md`。分支：`autonomous-p05-p08`。基线：`main` 的 `5533722`。2026-11-09：下一阶段的计划见 `docs/run-engine-todo-plan.md`，本文件保留为上一轮的实施记录。
这个文件由无人值守会话维护；用户回来后先看"待批准"和其后的"裁决"（B1–B13 已由 Opus 5.5 代为裁决，实施清单在 `docs/approved-implementation-plan.md`）。

## 进度

| 任务 | 状态 | 提交 | 测试数 | 说明 |
| --- | --- | --- | --- | --- |
| T0 准备 | 已做 | — | 2844 | junction 接好；基线 biome 2 警告、tsc、2844 通过（3 todo）、verify:package 通过 |
| T1 计划第 35 点（S1 记录） | 已做 | a42f51c | — | 文档提交，diff 只改计划 P04 行一行 |
| T2 暂停/结束的 Run 不发送 | 已做 | e815db1（代码）+ 计划第 36 点 | 2855 | `effects.ts` 的 `lifecycleMaySend`，快照与提交各检查一次 |
| T3 来源仍是最新的复核 | 已做 | b2eb368（代码）+ 计划第 37 点 | 2862 | 入账提交内比较 anchor（`stale`）；补报 prepared→sending 提交内核对 assignment 仍在等报告 |
| T4 `creating` 崩溃续办 | 部分（完整续办推迟） | 3639f30（A8） | 3256 | A8 在恢复时将中断的启动标为失败并告警；重建请求所需信息未冻结，不能完整续办 |
| T5a Runs 页控制 | 已做（真实浏览器未验证） | 6b96dcc、60044ca（代码）+ 计划第 38、55 点 | 2929 / 3271 | 重新规划、重试、催办按服务端声明门控；无原生 UUID 时生成 v4 格式，未知结果提示可能已执行 |
| T5b 为什么在等 / 因果时间线 | 已做（真实浏览器未验证） | 1f70aaa、c4276db（代码）+ 计划第 39、56 点 | 2963 / 3278 | 任务、决策、告警都有 why/who/next（告警不猜责任人）；预算类动态原因码穷举；重新规划、取消事件文案不夸大 |
| T5c Team 编辑器 runEngine | 部分（预算等策略字段无编辑入口） | 4bd0941、4580f54（代码）+ 计划第 40、57 点 | 3005 / 3283 | 席位和 7 个策略数字可编辑、不丢未知字段；编辑器现在传入规划出的 Profile，实时显示 Codex 非 full-access 警告 |
| T5d 启动对话框 | 已做 | 6a50c38（代码）+ 计划第 41 点 | 3016 | kickoff-pending 文案（计划请求已提交、几分钟、不要重复启动）；预览的 Engine 阻断/警告补回归用例 |
| T5e 刷新 | 已做 | d195071（代码）+ 计划第 42 点 | 3036 | 页面不可见时停轮询、不重叠、同版本不重绘 |
| T5f 响应式与断线 | 已做（真实浏览器检查未做） | d195071（同上）+ 计划第 42 点 | 3036 | 布局的静态保护测试；断线重连的会话规则补 7 例 |
| T6a 验收表 | 已做 | 1a20b45 | 3069 | `docs/run-engine-acceptance.md`：22 项如实写状态，只有 AC03/04/05/08 记为已覆盖；`acceptance-doc.test.ts` 核对 136 条引用 |
| T6b 使用说明 | 已做 | a97c2c7 | 3046 | README 新增"Run Engine (opt-in)"一节；`readme-facts.test.ts` 对照代码核对其中的名字和数字 |
| T6c 关闭开关后的已有 Run | 已做 | c47d477 | 3046 | `runtime.test.ts` 新增 3 例：开关关闭后 hook、恢复、kick、列表、控制仍然工作 |
| T6d 计划状态与收尾 | 已做 | 1881354 | 3069 | 第 8 节 P05–P08 行改为实施中并指向相应的点；第 9 节没动；仓库里没有临时产物 |
| T7a 取消的内部能力 | 范围调整（延迟取消已做） | 940fca6（A5） | 3196 | A5 不归档、不打断，等待在途回合结束后取消；原计划的归档式取消仍推迟 |
| T7b 暂停的内部能力 | 已做 | 22d98a2（代码）+ 计划第 43 点 | 3064 | `lifecycle.ts` 的 pause/resume，不注册 RPC |
| 第 5 节 DEV 验证 | 已做（A12 第一轮，部分目标） | 本节之后的文档提交 + 计划第 67–72 点 | — | 见 A12 一行与"没做或没做完" |
| A1 事件压缩与容量保护（Sonnet 实施 Opus 裁决项） | 已做 | caf8a26（代码）+ 计划第 44 点 | 3095 | 压缩进现有 checkpoint，不升版本；容量门 `ledger-capacity`；历史页 `compactedThroughSeq`；变异 10 项全抓到 |
| A2 取消后释放被冻结任务的占用 | 已做 | 786caba（代码）+ 计划第 45 点 | 3107 | 只改 `applyCancellation`；答复 `cancel` 才释放，绑定 `releaseDecisionId`；变异 4 项全抓到 |
| A3 暂停与续办 RPC | 已做 | a456eb0（代码）+ 计划第 46 点 | 3140 | RPC 24 到 26；先重复、再修订号、再生命周期；变异 9 项全抓到；必须与 A5 同一版本发布 |
| A4 决策答复 `cancel` | 已做 | 36d82e9（代码）+ 计划第 47 点 | 3155 | 级联下游；补证冻结用 `evidence-stuck:` 只给 `cancel`；暂停中不给任何答复；变异 11 项全抓到；D3 与跨 Run 用例没写（见第 47 点） |
| A5 延迟取消整个 Run | 已做 | 940fca6（代码）+ 计划第 48 点 | 3196 | RPC 26 到 27；`cancelRequest` 透传块；从请求到完成宿主无 send/archive；变异 15 项全抓到；必须与 A3 同一版本发布 |
| A6 追加预算 RPC | 已做 | e55deff（代码）+ 计划第 49 点 | 3224 | RPC 27 到 28；写 `budgets.entries`、不改 `policy`；耗尽告警一次、追加后关闭；变异 10 项全抓到 |
| A7 读取重查扩面与自动继续 | 已做 | 5f07608（代码）+ 计划第 50 点 | 3236 | 只用已有目标类型，不升版本；恢复后自动继续前 3 次；变异 8 项全抓到（1 项补测后） |
| A8 启动中断后关闭并告警 | 已做 | 3639f30（代码）+ 计划第 51 点 | 3256 | 恢复时关闭 `preparing`/`creating`，列出已登记 Agent；不续办、不归档；并发启动受保护；变异 9 项全抓到 |
| A9 权限等待与空闲零调用 | 已做 | a328b19（测试）+ 计划第 52 点 | 3261 | 等权限重启、解除与重复回执；空闲重复事件无发送；端口和源码无代答方法；变异 3 项全抓到 |
| A10 决策的 `kind` 字段 | 已做 | 5983700（代码）+ 计划第 53 点 | 3265 | 投影输出可选开放字符串，区分质量、成员、判官、无报告与补证；旧客户端和未知类型回退；变异 7 项全抓到 |
| A11 协调者回合预算 | 未完成，已撤回（可选）；已由 A14 以修正后的形状完成 | — | — | 三次检查仍未通过，按规则撤回未提交改动；见“没做或没做完”和 A14 |
| A12 DEV 真实验证 | 已做（第一轮，部分目标） | 本节之后的文档提交 + 计划第 67–72 点 | 3370 | 4 个 Run（haiku 5.5 生产、luna/codex 审查）；replan v4、判官重派、重启后 kick、S1 重查、真实浏览器/窄屏/重连各有 N=1 证据；补证模板未触发；发现 Runs 列表状态与台账不符、重启丢在途回复后取消一直等 |
| A12 发现 1 修复（Runs 列表状态） | 已做（DEV 未重验） | 78ff83f（代码）+ 计划第 73 点 | 3386 | 客户端按台账 lifecycle 覆盖 Engine Run 的列表阶段；新增“已取消”；未知 lifecycle 不声称完成；变异 13 项全抓到 |
| A12 发现 2 出路（A21） | 已做（DEV 未验） | 36b9fb1（代码+测试+README）+ 计划第 74 点 | 3407 | 重查用尽且原因为 `incomplete:dispatch-not-found` 的告警追加固定出路提示（成员空闲后发只要求回复 OK 的消息，等回复，点“立即检查并推进”），旧摘要告警仍被识别、不重复开；README 补恢复说明；`lost-turn.test.ts`（v1/v2）固定现状、出路与各类“继续等”情形；变异 11 项全抓到；不放宽静止证明，引擎自结算登记为 B14 |
| T4a 成员在回合中被关闭或归档（A1/B14 获批部分） | 已做（DEV 未验，留给 T8-L） | 0e15317（代码+测试+README+验收表）+ 计划第 75 点 | 3458 | 引擎在 hook、kick、恢复时核对台账与宿主读取，证明会话已关闭且没有活动回合后，经 observer 的追加路径写一条 `agent-closed` 引擎回执并开只能取消的 `member-lost` 决策（生产者、审查者、冒烟者、补证都开）；被结算回合的回复不入账；已归档席位本 Run 不再派活（`seat-archived`）；整个 Run 的取消把被删除的成员（读到不存在）算作没有活动回合，读取抛错仍然等。门禁 G 全绿（204 个文件 3458 通过，biome 仅 2 条既有警告）；变异 18 项全部被抓到（2 项补断言后被抓，清单 `Temp/next-todo/mutations/t4a.json`）；回滚演练：旧 `RunRecordSchema` 与 `checkLedgerInvariants` 读新记录通过，旧 `answerableActions` 给重试，旧调度对已关闭席位不提议；没有改 schema、`ledger.ts`、reducer、RPC、模板 |
| T4a 评审修复（DeepSeek F1–F7） | 已做（待协调者重跑与合并） | 496e517（代码+测试+README）+ 计划第 76 点 | 3475 | 丢 hook 的恢复（`recover`、“立即检查并推进”按钮）里 `reconcile` 先于结算导致 T4a 被绕过；改为 flush → settle → reconcile，新增“无 hook 恢复”用例，变异 6 项全部被抓；残余：`seat-archived` 算临时拒绝，需要该席位的任务只能等或取消整个 Run；同毫秒比较改为严格大于 |
| T4b 宿主丢失在途回合（A2/B14 获批形状，三轮） | 已做（DEV 未验，留给 T8-R；待协调者重跑与评审） | 8d4fd18（代码+测试+README+验收表）+ 计划第 77 点 | 3531 | 重查用尽（`incomplete:dispatch-not-found`）后至少 30 秒（`LOST_TURN_SETTLE_DELAY_MS`），人点“立即检查并推进”（或 hook、恢复）时，成员空闲、派发仍找不到、回合已知、送达没结清，则由引擎经 observer 追加路径写 `host-lost` 回执并开可重试可取消的 `host-lost` 决策、撤下用尽告警；不新增定时器；A21 告警改写，两种旧写法仍可解除；v1 Run 没有重查记录不走这条。门禁 G 全绿（206 个文件 3531 通过，biome 仅 2 条既有警告）；变异 27 项：26 项被抓 + 1 项存活（t14，由 t27 组合变异覆盖，有意冗余）；回滚演练：旧 schema、不变量、`answerableActions`、重试与取消都通过；没有改 schema、`ledger.ts`、reducer、RPC、模板 |
| T4b 评审修复（DeepSeek F1–F7） | 已做（待协调者重跑与合并） | 6fb9222（代码+测试+README+验收表）+ 计划第 78 点 | 3543 | 重查用尽告警不再对判官、冒烟、补证、补报回合承诺结算（改为只说成员的实现回合会被结算，其他回合向成员发只要求回复 OK 的消息再点按钮），两种旧写法仍可解除；补证不再是候选；整个 Run 取消时 T4b 与 T4a 的结算仍写回执但不开决策，Run 取消后不残留 open 决策；新增“结算先于 reconcile”判别性用例、迟到真实回执是重复、压缩保留 held 事件用例；变异 13 项全部被抓；残余：T4b 只结算生产者的回合，补报、判官、冒烟、补证与 v1 仍走 A21 人工出路（README 与计划记录已写，裁决原文 `docs/run-engine-todo-plan.md` 留到 T10 对账） |
| T5 原因草稿在轮询中不丢（A6） | 已做（DEV 未验，留给 T8；待协调者重跑与评审） | 87db5f7（代码+测试）+ 计划第 79 点 | 3559 | 先写现状测试：16 条红（读取失败、断线、`unchanged` 后原因框都是空的，提交后草稿还在；全部是断言失败，其中 14 条由 t01 变异独立复现，另 2 条“拒绝后保留”在 t01 变异下不红、修复前仍红），是产品缺陷；草稿提到 `RunDetailPane` 的 `useReasonDrafts(runId)`（新文件 `reason-drafts.ts`），按 runId 分键，ImeTextInput 仍是非受控，服务端接受后才清；变异 10 项全部被抓；与计划的差异：只有重新规划和取消 Run 两处是人输入的原因，取消任务的原因是页面生成的，没有第三个草稿；追加预算的数字框同样会复位，T6-B 已与确认对话框一起提到 `RunDetailPane`；门禁 G 全绿，没有改 schema、RPC、服务端 |
| T6-A 小修合集（T6a/b/c、T4a 评审 N1/N2、D4 偶发超时） | 已做（DEV 未验，留给 T8；待协调者重跑与评审） | 5 个代码/测试提交 + 计划第 80 点 | 3583 | 暂停期间已回落的失败任务闸告警现在会撤（一次，其余不写）；addPlanRequest 两种拒绝各说各的；Runs 首屏在 Engine 列表返回前把“看似已完成”的行显示为“读取中”（出错回落）；retryNow 先 flush，与 recover 一致；member-closed 用步进时钟，冻结真实 Date 下旧文件 41/56 失败、新文件 58/58 全过，连跑 20 次 20/20；D4 判为并行负载，未改；变异 16 项全部被抓；门禁 G 全绿，没有改 schema、RPC、回执、reducer、提示词模板 |
| T6-B 轮询中保留数字框与确认对话框（T5 评审后续） | 已做（DEV 未验，留给 T8；待协调者重跑与合并） | 68f3376（代码+测试+验收表一行）+ 计划第 81 点 | 3595 | 追加预算数字框与四个确认对话框提到 `RunDetailPane` 的 `useControlUi(runId)`（新文件 `control-ui.ts`，数字框按 runId 与 seatId 分键、确认按 runId 一个并存 decisionId 或 seatId，数字框仍非受控，ready 轮询不重挂载）；offer 消失时丢弃陈旧确认；两个原因框 `maxLength` 600；`control-runner` 的 `accepted` 用例 8 条；IME 用例在重挂载后重新组字；一次评审 9 条、最高低、无阻塞；变异 8 项全部被抓；门禁 G 全绿，没有改 schema、RPC、回执、reducer、提示词模板 |
| T9a 重启后回合 id 重复（Opus 裁决 P0，三轮） | 已做（DEV 复验留给合并后的 main；待协调者重跑与合并） | 见分支 todo/t9a-turn-id-reuse（代码+测试一个提交，文档一个）+ 计划第 82 点 | 3690 | 新增 `turn-occurrence.ts`：同 (kind, agent, turnId) 的第 n 次出现键加 `#n`，第一次不变；按台账加本进程起点在 store.update 内判定，无进程内 Map；按锚点取最早、判静止取最新；入账闸（未答复 limbo 决策时回复不入账，取消决策除外）；不改 buildReplyWindow；变异 26 项全部被抓（评审修复后）；0.7.0 回滚演练读 `#2` 台账不抛不改字节；没有改 schema、回执种类、台账字段、RPC、提示词模板 |
| T9b 回复已丢时结算（Opus 裁决选项 B） | 已做（DEV 复验留给合并后的 main；待协调者重跑与评审） | 见分支 todo/t9b-lost-reply-settle（代码+测试一个提交，文档一个）+ 计划第 84 点 | 3920 | 宿主先发 `turn_ended` 再丢回复时，重查用尽（恰为 `incomplete:dispatch-not-found`）至少 30 秒后再读仍找不到、回合按取消同款证据已结束、成员席位读为 idle 或 closed（已归档的成员按读到的状态或归档回执算；宿主答没有这个 Agent 或读不到时不触发，取消仍照常，DEV 复验 L1′ 时要看宿主实际返回），则开 `member-lost`（只能取消）或 `host-lost` 决策并撤下告警（类别规则已被 T9d 修订：`closed` 回执不再算 `member-lost` 的证据，见下一行）；不写回执、不释放、不发送；取消与 T9b 共用纯函数 `provenEndedTurn`；告警提示扩展为空闲、已关闭、已归档；变异 26 项全部被抓；合同变化为零 |
| T9d host-lost 类别判定（T9v 异常，Opus 裁决） | 已做（DEV 复验 R″ 留给合并后的 main；待协调者重跑与评审） | 见分支 todo/t9d-lost-kind（代码+测试一个提交，文档一个）+ 计划第 87 点 | 3947 | 优雅停机给所有 Agent 写 `closed` 回执，重启后成员又空闲可用，T9b 却据此判 `member-lost`（只能取消），`host-lost` 在 DEV 构造不出来；改两处：`lostReplyKind` 按“本次读到 closed 或 createdAt 之后有 archived 回执 → member-lost；生产者自己的任务回合 → host-lost；判官、冒烟、补证遇 closed 或 archived 回执才 member-lost”，`turnWasCut` 对 host-lost 决策只认 archived 回执；旧用例同提交改写；变异 13 项；合同变化为零；残余（评审 M1）：archived 的 hook 若丢，加上优雅停机的 closed 回执，已归档成员读成 idle，T9b 判 member-lost、T9d 判 host-lost，重试会派给已归档的 Agent（席位读取没有 archived 标志）；Opus 裁决仍按此改，记入 T10 |
| T9f 重启后 closed 席位（T9r2 不符 A，Opus 裁决） | 已做（DEV 复验留给合并后的 main；待协调者重跑与评审） | 见分支 todo/t9f-seat-closed（代码+测试一个提交，文档一个）+ 计划第 88 点 | 4015 | 重启后成员都读成 closed，调度器先判 `!idle` 把它记成 `busy`，页面一直写“席位正忙”；改为拒绝原因 `seat-closed`（临时拒绝，不开决策，派发行为不变）加一条 warning 告警（固定前缀，写一次，情况消失撤下，状态没变的一遍零写入）；T9e 告警文案对上真实按钮；变异 14 项全部被抓；合同变化为零；残余：Engine 不重新打开也不改派 closed 席位，先重开、再给席位重建 Agent 记入 T10 |
| T8 DEV 真实验证（第二轮） | 已做（6 个 Run，N=1） | 本节之后的文档提交 + 计划第 85 点 | — | 补证（E：claude/codex 各 N=1 通过，codex `attempts`=3 因抄错 `assignmentId` 与人工复位污染 attempt 2）、权限（P：批准一次入账一条 `permission_resolved`，同一请求再批准无效果，引擎不代答）、真实 62 分钟空闲（I：台账修订号、mtime、sha256 不变、无新回合）、浏览器（B：Playwright Chromium 宽 1440/窄 390；草稿不跨 daemon 重启、`maxLength` 只做合成 IME）、V2′（同键同参数跨重启返回同一 Agent）各有记录；L/R 与 T4a/T4b 假设不符（宿主先发 `turn_ended`），已由 T9b/T9a 修，复验在后续 T9v/T10；F 跳过（无廉价办法）；清理完成 |
| 文件锁并发读取加固 | 已做 | aed012c（代码）+ 计划第 54 点 | 3268 | 竞争时对未写完的锁或 guard 有界复读；永久损坏仍拒绝，真实双进程复测 10 次通过 |
| B1–B13 裁决 | 已做（只裁决，不实施） | 本节之后的文档提交 | — | 见"裁决"；实施清单 `docs/approved-implementation-plan.md`（A1–A12），没有改任何源码 |
| 下一阶段计划 | 已做（只裁决，不实施） | effb948 | 3283 | `docs/next-phase-plan.md`：剩余清单的裁决与任务 A13–A19、A12；阶段 1 基线复核 194 文件 3283 通过（3 todo），biome 两条既有警告、tsc 与 verify:package 通过 |
| A13 失败任务上限闸 | 已做 | bdd7d90（代码）+ 计划第 59 点 | 3298 | `policy.run.failedTasks` 做成派发闸：失败的任务多于上限后不再开始新派发，一条 critical 告警，回落后撤告警；在途工作照常；变异 12 项全抓到 |
| A15 验收缺口补测 I | 已做（六组全部提交） | 86d8c97（测试）+ 计划第 60 点 | 3306 | AC02、03、06、07、11、19 的缺口补测，只加测试；验收表无状态升级（各自仍有别的缺口）；变异 25 次运行，15 被抓，10 存活均为多层去重的有意冗余 |
| A16 验收缺口补测 II | 已做（七组全部提交） | c271e12（测试）+ 计划第 61 点 | 3319 | AC01、09、10、14、16、17、20 的引擎级补测，只加测试；AC01、AC09、AC16 升为已覆盖，AC10、AC20 为已知限制现状测试；变异 27 次运行，21 被抓，6 存活（5 项首次选错或只破坏单层，改后被抓；1 项有意冗余） |
| A14 协调者回合预算（修正版 A11） | 已做 | a23ae38（代码）+ 计划第 62 点 | 3346 | `policy.run.strategicTurns` 做成协调者的回合预算：计划请求与重新规划各扣一回合（`budgets.entries` 里 `coordinator` 条目），计划格式重发不计、不退还，耗尽时重新规划被拒并告警，`run.budget` 可追加；`strategicTurns < 1` 时启动被阻断；无 schema/RPC/模板变化；变异 15 个点全部被抓；回滚演练通过 |
| A17 UI 接线与渲染测试 | 已做 | 9508aed（代码+测试）+ 计划第 63 点 | 3358 | 把 `TeamEditor` 给 `RunEngineEditor` 的 Profile 接线抽成 `RunEngineSection`（行为不变），挂载测试覆盖 Codex 警告与不猜的行；`LaunchDialog` 渲染测试覆盖 Engine 阻断/警告、kickoff-pending、失败；变异 12 项全抓到 |
| A18 文档对账 | 已做 | 583a55d（README 与事实测试）+ 计划第 64 点 | 3361 | 验收表按证据对账（AC07、AC19、AC21 升为已覆盖，AC21 带范围声明），README 补 A13/A14 语义、高级字段、不要关闭或归档成员的警告并刷新“未做”列表，`readme-facts.test.ts` 新增 3 例；变异 6 项全抓到 |
| A19 发布材料 | 已做（只备材料） | 619c5c7 + 计划第 65 点 | 3361 | `docs/release-handoff.md`：范围摘要、预期版本、PR 与发布说明草稿、合并前检查清单（命令已运行）、合并方式、R2 准入条件、残余风险；没有改版本文件、CHANGELOG，没有合并、推送、打标签、建 PR |
| 评审发现处理（阶段 4） | 已做 | 5209eea（代码+测试）+ 计划第 66 点 | 3370 | 失败任务闸只拦尚未开始（`ready`）的任务，在途的评审、冒烟、补证请求、返工照常；告警摘要不再写失败数；`replan.ts` 注释更正；Runs 页与启动对话框测试改为轮询等待；发布材料统计重算；3 条发现登记为已知限制；变异 24 项全抓到 |
| 发布 v0.6.0 | 已发布 | 1de0a2c（手工直推） | — | 2026-11-08；标签 `paseo-agent-team-v0.6.0`；没有经过 PR 和 CI |
| 发布 v0.6.1 | 已发布 | 0787c6c（合并 PR #14） | — | Release PR 的 CI 没有运行，管理员绕过合并；合并后 `main` 的 CI 成功 |

### 三轮（T1–T10）的进度（2026-11-10 补）

上一张表是上一轮（T0–T7、A1–A19）的记录；本轮（三轮 T1–T10）按下表对账，一行一个任务或发布。

| 任务 | 状态 | 提交 | 测试数（文件/通过/todo） | 说明 |
| --- | --- | --- | --- | --- |
| T1 基线与工作区 | 已做 | — | 202/3407/3 | 基线门禁 G 全绿；junction 与主工作区未动 |
| T2 计划落库、发布事实、流程文档与 ruleset | 已合并 | PR #15，`6caa304` | — | 计划落库、`docs/release-process.md`、ruleset 收紧为仅 PR 可绕过；文档 PR |
| T3 version-flow 的 EBUSY（只改测试） | 已合并 | PR #16，`61f788a` | — | 只改测试；Windows 并行 EBUSY |
| T4a 成员被关闭/归档的结算 | 已合并 | PR #17，`0fef059` | 204/3475 | 计划第 75 点；B14 修改后批准（引擎自行结算回合） |
| T4a 评审修复 | 已合并 | 同 PR | — | 计划第 76 点 |
| T4b 宿主丢失在途回合 | 已合并 | PR #19，`16bd298` | 206/3543 | 计划第 77 点 |
| T4b 评审修复 | 已合并 | 同 PR | — | 计划第 78 点 |
| T5 原因草稿 | 已合并 | PR #20，`c1f3345` | 207/3559 | 计划第 79 点 |
| T6 小修合集（A/B/docs） | 已合并 | PR #21/#22/#23，`c935724`/`cd40b44`/`4287854` | 207/3583、207/3595 | 计划第 80、81 点与文档 |
| T7 发布 0.7.0 | 已发布 | PR #18，`4032b84` | — | 2 feat + 9 fix；发布 PR 的 CI 绿，无管理员绕过 |
| T8 DEV 第二轮 | 已做（6 个 Run，N=1） | 文档 PR #28，`c8f87c5` | — | 计划第 85 点；E/P/I/B/V2′ 有记录；L/R 与假设不符 → T9a/T9b；F 跳过 |
| T9a 重启后回合 id 重复 | 已合并 | PR #24，`3f11b6d` | 211/3701 | 计划第 82 点；合同变化：同回合 id 的第 n 次出现加 `#n` 键 |
| T9b 回复已丢时结算 | 已合并 | PR #27，`67db906` | 213/3920 | 计划第 84 点；零合同变化 |
| T9c 界面小缺陷 | 已合并 | PR #26，`a9d679a` | 213/3712 | 计划第 83 点；零合同变化 |
| T9d host-lost 类别判定 | 已合并 | PR #30，`c95762b` | 3947（分支）/3985（合并后） | 计划第 87 点；零合同变化 |
| T9e 计划回复丢失告警 | 已合并 | PR #29，`7fd82de` | 216/3969 | 计划第 86 点；零合同变化 |
| T9f closed 席位原因与告警 | 已合并 | PR #31，`7602134` | 217/4015/3 | 计划第 88 点；零合同变化；DEV 复验未做 |
| 发布 0.7.1 | 已发布 | PR #25，`bf89b83` | — | 8 fix 0 feat；zip 1042116 B；发布 PR 的 CI 绿，无管理员绕过 |
| T9v/R″ DEV 复验 | 已做（7 个 Run，N=1） | —（只读复验，未提交） | — | T9a/T9b/T9c 与 T9d/T9e 的通过项、未验证项见计划第 89 点 |
| T10 文档终对账 | 已做（本提交） | — | — | 验收表 DEV 栏、README 恢复说明、本笔记与计划“执行结果” |
| 三轮 T11a 重新打开已关闭的席位 | 已实现，待合并 | 分支 `todo/t11a-reopen-seat`（本地提交） | 218/4092/3 | 计划第 90 点；零合同变化；DEV 复验在 T11d |

## 待批准

B1–B13 与之后的剩余清单已由 `docs/next-phase-plan.md` 裁决（批准、推迟或关闭，推迟项写明了重新评估的触发条件）；下面是当初的提案原文，保留作记录。本阶段新发现、必须改合同的需求见本文件的“待批准（第二轮）”。

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

## 裁决

2026-11-08，Opus 5.5。用户授权由我代为裁决 B1–B13，之后改为"只裁决、不实施"，实施交给另一个会话。本节写裁决、理由、依据、风险，以及对上面提案的更正。可以直接照着做的形状（文件、字段、事件、RPC 与 zod 形状、测试清单、变异检查点、顺序、验收、回滚）在 `docs/approved-implementation-plan.md`，下文用任务号 A1–A12 指它。本会话没有改任何源码。

### 怎么核实的

- 读过的代码：`shared/schemas/run-engine/{ledger,rpc,rpc-actions,proof-shapes}.ts`；`shared/domain/run-engine/{reducer,transitions,invariants,decision-answer,budget,read-retry,wake-summary,task-note,replan}.ts`；`server/run-engine/{driver,control,lifecycle,start,read-retry,observer,effects,service,runtime,projection,digest}.ts`；`shared/paseo/port.ts`；`shared/rpc/run-engine.ts`；`index.server.ts`；相关测试（`tests/run-core/{reducer,r01g-behavior,cancellation-review-regressions}.test.ts`、`tests/spec/run-core-reducer.spec.test.ts`）；计划第 7、8、11 节与第 29–43 点。
- 只读探针：`%TEMP%\b-rulings\probe\cancel-probe.test.ts`（仓库外）用现有夹具重放 reducer，证实了下面 R1 的缺口。
- A2 的改动在仓库外的临时副本里试过：`tests/run-core`、`tests/spec`、`tests/run-engine`、`tests/run-view` 与合同测试全部通过（598 + 925 例；两条读 `docs`/`README` 的测试因副本里没有这些文件而略过）。副本已删除，删除前先摘掉了 `node_modules` junction，主工作区的 `node_modules` 完好。

### 总表

| 编号 | 裁决 | 一句话 | 实施 |
| --- | --- | --- | --- |
| B1 | 修改后批准 | 不要 schema v3、不要新状态和 `sendIntent`：重查成功后自动走一次 `retryRun(afterWrite)`，每个来源最多 3 次 | A7 |
| B2 | 修改后批准（低优先级，可选） | 协调者上限用已有的 `policy.run.strategicTurns`，不改配置合同；它证明不了 AC17 | A11 |
| B3 | 修改后批准 | 不开 D4 决策，改为窄 RPC `agent-team.run.budget` | A6 |
| B4 | 拆分 | 暂停/续办 RPC 批准；整个 Run 的取消改为"延迟取消"（不归档、不打断）后批准；在途任务的归档式取消推迟；`run.approve` 不批准；`run.reconcile`、`run.export` 推迟 | A3、A5 |
| B5 | 批准（只补测试） | 永不代答权限是结构性的，补上证明与重启用例 | A9 |
| B6 | 修改后批准 | 只做 `cancel` 答复，级联取消下游，补证冻结任务另开 `evidence-stuck:` 决策；`reject` 不批准；`assign-seat` 推迟 | A2、A4 |
| B7 | 不批准（推迟） | 宿主没有"失败发生在任何工具执行之前"的信号，自动重跑会重复副作用 | — |
| B8 | 推迟 | 先确认插件 SDK 有服务端推送通道 | — |
| B9 | 只给建议 | 见本节末尾，留给用户 | — |
| B10 | 修改后批准（缩小） | 只加决策的 `kind`（可选字符串）；历史页的 `compactedThroughSeq` 并入 A1 | A10 |
| B11 | 修改后批准（第一优先） | 只压缩 `events` 前缀，用已有的 `checkpoint`，不升版本；压不下来时停止新派发 | A1 |
| B12 | 修改后批准（并入 A7） | 三类读取失败映射到已有的 `reply`/`seat` 目标；不拆入账 | A7 |
| B13 | 修改后批准 | 启动中断的 Run 关闭并告警（fail-closed）；完整续办推迟 | A8 |
| R1（新） | 批准修复 | reducer：有已发交付留下占用、没有在途工作的任务，取消后永远释放不了；改为"经授权即可释放" | A2 |
| R2（新） | 批准修复 | `answerableActions` 不看生命周期，暂停中的 Run 也画"重试" | A4 |
| R3（新） | 推迟 | `policy.run.failedTasks` 没有任何代码执行 | — |

### B11 事件压缩

- **裁决**：修改后批准，第一优先（A1）。
- **依据**：`RunRecordSchema` 早有可选的 `checkpoint`（`throughSeq`、`historyDigest`、`counters`、`acceptedNonceDigests`、`terminalAssignmentIds`）；不变式 I1 允许事件从 `checkpoint.throughSeq + 1` 开始连续，I6 只做下限检查；`transitions.cancellationAuditValid` 对压缩前缀里的戳直接信任；`projection.encodeHistoryCursor` 已把游标绑在 `checkpoint.throughSeq` 上；`r01g-behavior.test.ts` 的 `compact()` 清空全部事件后不变式仍通过。所以不需要升 schema 版本，旧程序能读压缩后的记录。
- **更正 1**：`eventReceipts` 一条也不能压，不只是"仍被未了结 assignment 引用的"：`isNormalEnded`、`isComplete167`、`actorSettledBy` 对每个 assignment（包括已结束的，`run-finished` 要逐个核对）都要找到它的 `turn_ended` 回执。`nonceRegistry`、`assignments`、`outbox` 本轮也不压。
- **更正 2**：读事件的生产代码只有三处：`transitions.hasTurnFacts`（能否本地撤回未发出的派发，按 `event.at >= assignment.createdAt` 过滤）、`replan.priorRequest`（`requestId` 去重）、历史页。边界因此是：最早一个未结束 assignment 的 `createdAt` 及之后的事件全部保留，另外至少保留最新 2048 条。被压掉的 replan `requestId` 再提交会得到 `revision-conflict`（`expectedRevision` 严格相等，不会二次生效），可以接受，要有用例。
- **更正 3**：多半先撞上的是 8 MiB 字节上限而不是 8192 条：reducer 把整个事件对象（含完整报告块）放进 `payload`，同一份报告又存在 assignment 的 `acceptedProof` 里。触发条件要同时看条数和 store 的 `needsCompaction`。
- **补充**：压不下来时停止新派发（`dispatch-blocked:ledger-capacity`），这是 AC15 的"不越限派发"；在途工作照常收尾。
- **风险**：压掉的历史只剩摘要链；边界算错会让本地撤回误判。回滚到旧版本：能读，历史页更短。

### R1 reducer 的取消缺口（新发现）

- **发现**：生产者报告 `blocked` 或 `failed`、回合已正常结束、任务仍持有占用时，`cancel-requested` 只会把它冻结并开一个配对为空的 D1 `cancel:<任务>`；`releaseIfSettled` 遇到空配对直接返回，`cancellation-checked` 也要求配对，所以占用永远放不掉，再取消一次也不变（探针证实，blocked 与 failed 都如此，`failed` 的任务还会被改成 `blocked`）。DEV 上"冻结后占着仓库锁"的任务正是这一类。
- **不能**简单改成"显式取消就立即释放"：`r01g-behavior.test.ts` 的 "local withdrawal of a retry preserves the claim from its historical sent producer" 把"已发出的交付留下的占用不得被隐式释放"定成了设计，临时副本里这样改那条用例就失败。
- **裁决**：批准一个窄的修复（A2）：`applyCancellation` 的立即取消分支在"没有在途 assignment、没有未结效果"时，如果该任务的 D1 `cancel:<任务>` 已被答复为 `cancel`（`cancellationAuthorization`），就照常取消并释放，`releaseDecisionId` 指向那个 D1。未授权时行为不变；`dag-revised` 不会产生授权，不受影响。

### B4 取消、暂停、续办

- **裁决**：拆成三块。(a) `pause`/`resume` 窄 RPC：批准（A3）。(b) 整个 Run 的取消：改为"延迟取消"后批准（A5）。(c) 在途任务的归档式取消：推迟。`run.approve` 不批准（没有任何流程会产生审批，`approvals` 没有写入者）；`run.reconcile`、`run.export` 推迟（kick 已经包含对账，没有使用方）。
- **依据**：`server/run-engine/lifecycle.ts` 已有暂停与续办的引擎入口。`rpc.ts` 里只定形状的 `RunControlAction` 有 `pause`、按任务的 `cancel` 和 `budget`，却没有"从暂停续办"（`resume-request` 属于对账，要 `diagnosisId`），所以照第 33 点新开窄 RPC。reducer 的静止证明 `isComplete167` 要求每个在途 assignment 有 `archive` 意图且回执已确认、刷新为 idle/closed/missing 且没有活动回合、最后一个回合有 `turn_ended`，并且 D1 已被人答复：**取消在途任务就是归档该成员的 Agent**。P00 能力矩阵：插件 API 没有"停止"，`archive` 不是停止证据，打断要发一条新消息（一次模型调用）；`policy.archiveResume.seatRevival` 是 `explicit-resume-seat`，而 resume-seat 没有实现，归档后该席位在这个 Run 里不能再用。`effects.ts` 只执行 `dispatch` 与 `wake`，没有 archive 执行器；`lifecycleMaySend` 在 `cancelled` 里不发送、`driver.recover` 跳过 `cancelled` 的 Run，所以 reducer 的 `run-cancelled` 一提交，它准备的 archive 意图永远不会被执行。
- **更正**：提案"对每个在途 assignment 先取静止证据"在这个代码库里意味着归档成员，提案没有写这个代价。改为延迟取消：先暂停并记下取消请求（透传块 `cancelRequest`），等每个在途回合被回执和宿主刷新证明已经结束（报告照常入账，补报不发），再在一次提交里用 reducer 自己的 `run-cancelled` 取消全部未完成任务，有已发交付留下占用的任务用同一个请求答复它的 D1 后释放（依赖 R1 的修复）。全程不发送、不归档、不打断，零模型调用。
- **风险**：在途回合长时取消要等；送达不明会一直等（安全方向，页面有说明）。A3 与 A5 必须同一版本发布，否则在两者之间的版本里能续办一个已请求取消的 Run。

### B6 冻结任务的出路

- **裁决**：修改后批准，只做 `cancel`（A4，依赖 A2）。
- **依据**：台账的 `RUN_DECISION_ANSWER_ACTIONS` 早已含 `cancel`、`reject`、`assign-seat`、`increase-budget`，所以台账词汇不用改，只改 RPC 的答复联合；`answerDecision` 的放行条件可以复用；`abandonAttempt` 已能按宿主回执关闭"回合结束但报告不可用"的尝试。
- **更正 1**：`reject` 不批准：台账没有区别于 `cancelled` 的终止状态，被拒的任务最后还得取消，Run 才能结束。
- **更正 2**：`assign-seat` 推迟：reducer 把它当作取消授权（`cancellationAuthorization`），意思是"取消后改派"，需要任务级的"指定席位"字段和派发规则。
- **更正 3**：取消一个任务必须级联取消依赖它的下游任务（它们只能是 `pending`），否则 `run-finished` 永远过不了；探针里取消 t2 后 `run-finished` 报 `tasks: 1`。
- **更正 4**：补证 assignment 冻结的任务要开决策，但用单独的键前缀 `evidence-stuck:<assignmentId>`，只允许 `cancel`，保持第 34 点"补证冻结不落入普通 retry"的约束。判官"回合结束没有可用报告"仍推迟（第 33 点：重派冒烟者会撞 `unsettled-smoker`）。
- **R2**：`answerableActions` 不看生命周期，暂停中的 Run 也画"重试"、按下得到 `run-not-active`；A4 一并改成只在 `active`（且没有取消请求）时给动作。
- **风险**：取消不回滚代码，已提交的改动留在分支上；确认框必须写明。

### B3 追加预算

- **裁决**：修改后批准（A6）：窄 RPC `agent-team.run.budget`（`seatId`，`by` 1–64，累计上限 1024），不开 D4 决策。
- **依据**：`budget.findSeatBudget` 先看 `budgets.entries` 再回落到冻结的 `policy.seatBudgets`，所以追加只写 `budgets.entries`，冻结的策略一个字节都不动。`wake-summary.ts` 的 D4 预算约定（`subjectId = budgetKey`）只在纯函数里，`classifyWake` 没有接线。
- **更正**：D4 决策会挡住 `run-finished`（`isDecisionPending`）：预算不再需要时（任务被别的席位做了，或被取消）它仍然 open，而 schema 只允许 D1 取消决策进入 `superseded`，没有人去答就结束不了 Run。加预算也不是对某个任务问题的回答。耗尽时由派发结果带出 `seatId`，写一条告警，追加后撤下。
- **风险**：上限防止失控消耗。

### B2 统一模型预算

- **裁决**：修改后批准，低优先级、可选（A11，排在 A6 之后）。
- **更正 1**：`policy.run.strategicTurns`（0–256，Team 编辑器默认 12）与 `metrics.strategicTurns` 早就存在但没有任何代码执行。用它作协调者的上限，在 `budgets.entries` 里懒建 `coordinator` 条目；不往 `seatBudgets` 加条目，不改 Team 配置默认值。
- **更正 2**：B2 证明不了 AC17。AC17 要的是"空闲与重复普通事件时零调用"的用例，已放进 A9。今天协调者的调用要么由人触发（replan），要么有上限（每个计划请求最多补报 1 次），所以 B2 主要是记账和可见性，不是止血。
- **风险**：`strategicTurns` 为 0 的 Team 以后会被启动门阻断（预览会显示原因）。

### B12 + B1 读取重查

- **裁决**：两项都修改后批准，合并为 A7。
- **依据**：`readRetries` 是带独立读取器的透传块，`TargetSchema` 是严格的 `seat`/`reply` 两种；`noteReadFailure` 在 `resolved` 之后会开新一代，`generation` 最大到 10,000；`driver.retryRun` 已经做"重读宿主、入账、outbox、派发"，且永不重发 `sending`/`outcome-unknown`（第 33 点）。
- **更正 1（B1）**：不需要 schema v3、新状态或 `sendIntent`。重查成功的那次提交之后自动调一次 `driver.retryRun(runId, { afterWrite: true })`，就是人按 kick 做的事，从台账重新推算。必须按来源限次（第 1–3 代才自动继续），否则宿主时好时坏会一直循环并写满台账。
- **更正 2（B12）**：新增目标类型会让旧的 S1 程序把整个块判为不可读、停掉该 Run 的全部重查。三类失败都映射到已有目标：不完整的回复窗口与对账读取抛错用 `reply`，补证发送前的宿主刷新抛错用 `seat`。"拆出无发送能力的入账"也不需要：自动继续走的就是正常入账。
- **限制**：协调者的计划回复没有 assignment，不能登记；`too-large` 这类永久性不完整会用尽 3 次后告警。

### B13 `creating` 崩溃续办

- **裁决**：修改后批准为"关闭并告警"（A8）；完整续办推迟。
- **依据**：`startEngineRun` 的创建请求用了 `agent.title`、`agent.labels`、按角色全文编译的 `systemPrompt`、`agent.profile`（含 `modeId` 等）、`agent.role.mcpServers`。记录里只有 `launch.systemPrompts`（模板名、版本和哈希）、`launch.seatProfiles`（profileId/name/provider/model/family），`modelPlan` 里的角色只有 id 和名称，重建不出同一个请求。`archiveOnLaunchFailure` 是启动时的偏好，没有冻结在记录里。
- **更正**：先做 fail-closed：恢复时看到 `launch.state` 为 `preparing`/`creating`、且不是本进程正在启动的 Run，就在一次提交里把启动记为失败，写一条列出已登记 Agent 的告警；不调用宿主、不归档。DEV 上的启动失败都是创建报错，已由 `fail()` 处理；真正的崩溃窗口很小，完整续办的收益抵不过新增透传字段和每个席位几 KB 的提示词存储。
- **风险**：已创建但还没登记的那个 Agent 只能靠告警提示人去找。

### B5 权限等待

- **裁决**：批准，只补测试（A9），同时补 AC17 的空闲零调用用例。
- **依据**：`PortEngineAgentHandle` 只有 `send`、`archive`、`timeline`、`current`、`refresh`，没有答权限的方法；`server/run-engine` 里没有任何 `respondToPermission`；`service.ts` 对有 `pendingPermissions` 的席位拒绝派发。缺的是证明和重启用例。测试若暴露缺陷且修复不改合同，就在同一任务里修；要改合同就写进"待批准"。

### B7 派发之后的临时失败自动重试

- **裁决**：不批准，推迟到宿主能证明"失败发生在任何工具执行之前"。
- **依据**：P00 矩阵里 `turn_ended.outcome` 只有 completed/failed/canceled，没有工具是否执行过的信号；没有这个证据，自动重跑可能重复改文件、重复提交。现状里"回合结束没有可用报告"已经有人工的 `retry`。

### B8 服务端推送式失效

- **裁决**：推迟。P00 矩阵没有服务端向客户端推送的能力；T5e 的可见性轮询加 `unchanged` 已经让空闲读取很小。先在 `@getpaseo/plugin` 的类型里确认有推送通道再议。

### B10 界面要的新 DTO 字段

- **裁决**：修改后批准，缩小为决策的 `kind`（A10）。
- **依据与更正**：输出 DTO 都是非严格的 `z.object`，旧客户端会剥掉不认识的字段，所以加可选字段向后兼容；但值域如果用 `z.enum`，较新的服务端加一个值就会让旧客户端整份详情解析失败，所以 `kind` 用字符串。`nextAttemptAt` 和 `waitingCode` 推迟：除了读取重查没有别的定时器，`waitingCode` 与现有的原因码表重复。

### R3 `policy.run.failedTasks` 没有执行（新发现）

- `policy.run.failedTasks` 只出现在 schema、Team 编辑器和投影里，没有任何代码按它停止 Run。A4 之后被取消的任务算不算"失败"是产品问题。推迟，留给用户。

### B9 的建议（不实施，留给用户）

- **默认开启 `PASEO_AGENT_TEAM_RUN_ENGINE` 之前**：A1、A2、A4、A5、A6 完成；第 5 节 DEV 验收在两种 Provider 上跑过（至少：replan v4、取消有在途成员的 Run、追加预算、取消冻结任务后另一个 Run 拿到占用）；第 9 节完成条件由你逐条勾选。
- **灰度**：先发一个版本，开关仍默认关闭，README 写明怎么开；下一个版本开关默认开，但 Team 的 `runEngine` 仍默认不建（只有在编辑器里点开关才写入），已有 Team 不受影响；之后再考虑在预设里放一个关闭状态的样例。
- **版本与发布**：走 release-please（`release-please-config.json`），按新功能给 minor，`CHANGELOG` 由发布机制生成，不手改。发布说明写明回滚注意：回滚到不认识 v2 的版本会阻断所有 Run 的新资源授予（第 34 点）；回滚到 A3 与 A5 之间的版本会让已请求取消的 Run 被续办；压缩掉的历史不可恢复。
- **要你决定的事**：B9 本身；要不要"取消在途任务"（会归档该成员的 Agent，这个 Run 里该席位不能再用，除非另做 resume-seat）；`assign-seat`；B7 何时重议；B8 值不值得做；`failedTasks` 的语义（R3）；DEV 验收用多少模型额度。

## 待批准（第二轮）

（编号从 B14 起，格式同上。）

### B14｜引擎自己结算丢失的回合（推迟，登记）

- **为什么需要批准**：由引擎写带 `outcome: "host-lost"` 的 `turn_ended` 回执，改变了回执的含义（它不再只是宿主的报告），属于 reducer/台账事件词汇与合同的变化；放占用仍须人授权。
- **没批准时现状**：宿主重启丢掉在途回合后，读取重查用尽（`incomplete:dispatch-not-found`），Run 不前进，整个 Run 的取消一直等；出路是 A21 的告警提示与 README：成员空闲后发只要求回复 OK 的消息，等回复，点“立即检查并推进”。“继续”没有出路，只能取消重开。
- **最小形状**：`observer.reconcile` 在同时满足“间隔不少于 30 秒的两次 `dispatch-not-found`、`requireIdle` 为真且宿主读到 idle、派发已 confirmed、曾记 `turn_started` 且其后没有新回合”时，写一条带 `outcome: "host-lost"` 的 `turn_ended` 回执，之后走现有的 limbo/stuck 决策；放占用仍须人授权（决策答复 `cancel`），引擎不向成员补发请求。
- **触发条件**：A21 的出路在 DEV 上失败，或在真实环境里再现该限制，或宿主给出重启/孤儿回合的信号。
- **影响的验收项**：AC10、AC14。
- **建议**：低优先级，等触发条件。须新批准。2026-11-09 已由 `docs/run-engine-todo-plan.md` 修改后批准，见 T4a、T4b。T4b 已实现（三轮，计划第 77 点）：条件改为“重查用尽后至少 30 秒的又一次检查”，由 kick、hook 或恢复触发，不新增定时器。评审修复见计划第 78 点：只结算生产者的回合（补报、判官、冒烟、补证与 v1 仍走 A21 人工出路），整个 Run 取消时不再开决策。

（以下是 A13–A19 阶段写下的说明。）A13–A19 的实施中**没有发现新的、必须改合同的需求**：没有改 schema、reducer 词汇、台账字段、RPC、提示词模板、默认开启或版本号，所以这里暂无条目。已推迟或关闭的事项不是新发现，它们的触发条件见 `docs/next-phase-plan.md` 附录。阶段 4（处理独立评审的发现）同样没有新的合同需求。A12 DEV 验证也没有发现新的合同类需求：两条发现分别是页面投影的状态判定（缺陷，不改合同）和 2.12 已登记的“重启丢在途回复、没有 turn_ended”限制（不修）；补证模板未触发不是需求变化。实施中发现的两条观察，不改合同、仅作记录：(1) `LaunchDialog` 的预览在 `useQuery` 之后才显示，挂载测试要等几轮微任务（`settle`），这是测试写法而非缺陷（阶段 4 已把 `settle` 与 Runs 页的固定等待改成轮询等待，见“每项的检查结果”）；(2) `version-flow` 与 `ledger-real-fs` 并行时的 Windows `EBUSY` 仍偶发，单独重跑通过，沿用计划 4.1 第 5 条。

## 我自己做的判断

- **T5c 新建 Run 引擎配置的默认值**（`shared/domain/run-engine/team-config-edit.ts` 的 `DEFAULT_ENGINE_LIMITS` 与 `defaultEngineBlock`）：并发 2；每任务 报告重发 2、证据退回 3、每层返工 2、实现尝试 6；每 Run 允许失败 3 个任务、协调者 12 回合；每个席位 12 个回合的预算（没有预算条目的席位会被判"预算缺失"而永远派发不出去，所以必须有）；证据目录 `auto`；DEV 目标留空；渠道留空让人填，不从 Profile 猜。这些数字是我按夹具和合同范围定的，只在人点开关新建配置时才会写进去，默认关闭。想改默认值：改 `DEFAULT_ENGINE_LIMITS`，测试里只有 `seatTurnBudget` 被断言。
- **T5a 重试用的"原因"文字**：服务端要求 `reason` 必填（1–600 字），确认框里不再让人输入，由类别生成"从 Runs 页确认重试（D3）"。想让人手写原因：在 `EngineControls.tsx` 的确认框加输入，`control-runner.ts` 的 `retry` 已经把 `offer.reason` 原样发送。
- **T5a 请求编号回退**：优先用 `randomUUID`，其次用 `getRandomValues` 生成 v4 UUID；两者均不可用时保留原先的 `Math.random` 非加密随机来源并生成 v4 格式，不能把它当秘密或保证永不碰撞。同一次相同请求的编号只由当前控制实例在未收到答复期间保留；重新创建页面或修改请求内容/版本不能假定仍用原编号。kick 没有请求编号。
- **T5a/T5b 决策子类说明**：A10 已由服务端投影可选 `kind`，区分成员、判官、无报告、补证冻结等；旧服务端、未知类型仍按类别回退。没有增加 `waitingCode` 或 `nextAttemptAt`。
- **T2 暂停时 prepared 的意图保持 prepared**，结束或取消的 Run 里的 prepared 意图也不转 failed，只是永不发送（不写新事件）。想转 failed：在 `effects.ts` 的 `lifecycleMaySend` 为假时对 prepared 意图调用 `transitionIntent(..., "failed", "run-not-live")`，要同步改计划第 36 点。

## 遇到的问题与绕法

- **真实文件锁并发复核失败两次，已加固**：A8 文档门禁与 A11 笔记门禁的 `ledger-real-fs` 中，死锁并发回收只有一个进程取得锁，另一个返回 `lock-corrupt` 而非测试期望的 `lock-contended`。代码以 `open(wx)` 创建文件后再写入，受控测试模拟读到尚未写完的锁或 guard，均可重现同类误报；原两次失败的中间字节未保存，不能确认它们恰好读到空文件。`aed012c` 只在竞争读取遇到不完整内容时复读最多 5 次、合计等待 300 毫秒；一直损坏仍拒绝且不删除。真实双进程测试修复后连续 10 次通过。
- **后台工具调用丢失**：有几次 Write 或 Bash 被转到后台后没有落盘（一次是计划第 37 点的文本文件，一次是 `poller.test.ts` 与 `layout-guard.test.ts` 的 heredoc 拼接失败，一次是验收表）。每次都靠`git status`与`ls`发现，然后用 Write 重写。以后看到"已转到后台"就先核对文件是否存在。
- **变异检查被截断**：T7b 的一次后台变异运行少输出了最后一项和"ALL RESTORED"，文件停在被破坏的状态。我用 `%TEMP%/aw-mutation-backup` 里的备份还原并 `cmp`，再单独重跑那一项。变异脚本 `mutate.mjs` 的备份就是为这种情况留的。
- **Windows 上的 heredoc**：带 `$`、反引号、`
` 的内容用 shell 拼不可靠，改用 Write 写 `.mjs` 脚本再用 node 执行。
- **`biome` 的 `noUnsafeOptionalChaining`**：测试里 `x?.props.fn as T)()` 会被拒，改成先取节点、缺失就抛错的 `byLabel` 帮助函数（反而让缺控件变成测试失败而不是静默）。
- **测试里发现的我自己的缺陷**：T5c 第一版把刚启用的默认块（渠道还空着）当作"无法读取"，隐藏了席位编辑；改成"有待补全"后才能填渠道。T5b 的穷举测试第一次运行就抓出我漏掉的 4 个证据门原因。

- **误操作一次（无后果）**：阶段 1 的一条命令里误带了 `python -`（本应是空操作），Windows 的 python 占位程序卡住约 2 分钟；用 PowerShell 找到并结束了该进程，仓库没有任何改动。之后没有再运行 python。

## 没做或没做完

### 三轮（T1–T10）之后仍未做或没做完（2026-11-10）

- **下一批第一项**：(a) 拒绝 closed 席位前先设法重新打开（先查清重启后哪个宿主调用把生产者变回 idle，对从没开过回合的 Claude 成员是否有效，要上 DEV 验证）；(b) 打不开的成员只能给席位重建 Agent（需冻结启动规格并换绑席位，是合同变化；B13 触发条件视为已满足，下一批重新裁决）。
- **事实表的残余**：计划事实 5 更正（宿主实测三次都先发 `turn_ended`；T4a/T4b 的“没有 `turn_ended`”路径保留，覆盖竞态和强杀；优雅停机发 `turn_ended` 之后成员子进程又写了约 20 秒，`turn_ended` 不能证明进程已停；优雅停机有时不写 `closed` 回执）。重启后从未有过回合的成员（尤其 Codex，或第一个回合几秒内被打断的成员）永久 closed、打不开：Run 现在告警（`seat-closed`）但只能取消重来。宿主席位读取没有 archived 标志：archived 的 hook 若丢，已归档成员读成 idle，被判 host-lost，重试会派给已归档 Agent（T9d 起更容易触发）。T9f 评审低项：README 恢复一节的失败上限句过宽（本提交已改准）；评审路径同家族闸边缘（同家族席位 closed 而另一同家族席位 idle 被闸拒绝时，“重开 closed 席位”建议无效；result-t9f 第 5 条方向写反）；补证路径（`service.ts:534-546`）仍显示“席位恢复后会自己继续”且无 T9f 告警；T9e 文案改动使 `alertIdFor` 变化，升级后新旧告警可能并存（都由 `DAG ` 前缀撤下）；暂停/已结束/已取消 Run 的 seat-closed 告警不撤下。T9e：重启打断规划太早（会话没落盘）只能取消重来（README 已写）。T5 草稿不跨 daemon 重启/整页重载；`maxLength=600` 只做过 CDP 合成输入法事件。其他观察：引擎恢复要等第一次 RPC 或 hook 才开始；`member-lost` 决策“为什么在等”措辞与摘要不一致；E2 limbo 重试没有“HEAD 已变化”提示；`plugin remove` 会删插件设置；L2 在 repo-exclusive 下构造不出两个成员同时在回合中；`paseo send` 在 PATH 含空格时出错；独立 Designer 服务对更早 attempt 的裸 turnId 直接丢结束 hook（不在 Run Engine 范围，另立）；旧链路 Run 首屏显示“读取中”（T6-A F1）；切宿主后沿用上一宿主列表错误（T6-A F2）；暂停清告警读-写间隙（T6-A F3）；`flush` 抛错丢剩余缓冲（T6-A F4）。回滚到 0.7.0：读带 `#2` 键的台账不抛、不改字节（离线演练），但取最旧回执可能提前结算；README 保留“Run 进行中不得回滚”。
- **R″-B 的新观察**：重启后从没跑过回合的审查者永久 closed，任务进入 review 后派不出去（T11a 起先只读它的历史试着重新打开，仍打不开的由 T11b 重建）。“取消停在 paused”不是缺陷，已更正：台账 rev 68、cancelled，完成时刻只比请求晚 60 毫秒，当时看到的 paused 是取消 RPC 的第一个答复（T11 裁决事实 9）；这一条从残余清单划掉。已记入验收表 AC10/AC14 的 DEV 栏与计划第 89 点。

- **A11 协调者预算**（后来已由 A14 以修正后的形状完成，下面是当时的记录）：三次检查均未通过，已按计划撤回 A11 在本 worktree 的未提交改动。首次 149 项中有 1 项旧测试仍要求协调者没有预算；第一次更换为 `seat-s1` 后发现该席位原本也有预算；再次在夹具中提前移除它的预算，又使原有 DAG 派发夹具无法运行。独立只读复核还发现 `budget-control.test.ts` 的另一条旧断言也需更新。尚未跑 A11 的完整门禁或变异检查，不能视为完成；代码试验的补丁与两个新增文件副本留在系统临时目录 `aw/a11-attempt.patch`、`aw/a11-seat-ids.ts`、`aw/a11-coordinator-budget.test.ts`，不属于分支提交。旧 Run 补建预算只能计入仍在 outbox 的消息，已清理历史无法精确回算；对已预扣但未发送便作废的意图是否退还额度也需明确。
- **T4 `creating` 阶段崩溃后的完整续办**：重建 `CreateMemberInput` 需要的信息仍未冻结，完整续办推迟。A8 已实现重启后安全关闭并告警，不创建、不发送、不归档；创建成功但还没登记的 Agent 只能靠席位提示人工查找。
- **T7a 归档式取消**：A5 已实现不打断、不归档的延迟取消与 RPC，等在途回合确实结束后才释放占用。原计划的在途成员归档式取消仍推迟，见 B4 裁决。
- **第 5 节 DEV 真实验证**：已由 A12 做第一轮、T8 做第二轮（见下一条与计划第 67–72、85 点），不再记为“没做”。T8 覆盖补证模板、V2′、P、I、B 与清理；F 跳过（无廉价办法），AC15 的损坏/容量场景仍未做。
- **T8 的残余与限制**：T5 原因草稿（以及追加预算数字、确认对话框）只在面板保持挂载时保留，daemon 停止会卸载整个插件面板、整页重载也会清空，不跨 daemon 重启（宿主限制，已接受的限制）；`maxLength` 只用 CDP 合成输入法事件验证，不代表真实 IME；浏览器用 Playwright Chromium，不是真实 Chrome；P 的“等待期间重启 daemon 再批准”未做；F（回合失败但 Agent 已建好）没有廉价办法，跳过；AC15 的损坏台账、未知版本与容量上限仍未在 DEV 验证。
- **T5c 待补缺口**：Profile 警告只在 Team 规划返回后、且每个席位恰有一行已选 Profile 时才出现，候选、未解析或与编辑器席位号对不上的行被跳过而不是猜；`TeamEditor` 本身无法挂载测试（A17 已把接线抽成 `RunEngineSection` 并挂载测试，`TeamEditor` 只剩源码扫描保护）。策略中预算、DEV 目标、evidenceRoot 等保持原值，当前界面没有编辑入口。
- **成员回合中被关闭或归档（AC10 的“Agent 失联”）和用户直接发给成员的消息（AC20）**：A16 只写了现状测试（名字带 known limitation）。T4a 之前引擎对 `agent.closed`/`agent.archived` 没有反应，若宿主在关闭运行中的 Agent 时不发 `turn_ended`，任务和 Run 的取消会一直等；用户发给成员的消息被静默忽略，不报警。按 `docs/next-phase-plan.md` 2.12 不修；README 警告已由 A18 补（“Do not close or archive a member's Agent while a Run is live”，`readme-facts.test.ts` 核对），A12 探针取证；T4a 起引擎在证明会话已关闭且没有活动回合后结算，T8 实测宿主在强制归档、级联归档和优雅停 daemon 时都先发 `turn_ended`，T9b 已放宽触发（DEV 复验待后续）。
- **新界面的真实浏览器检查**：A12 已在真实 Chrome 上看过 Runs 页的宽屏与 390 像素窄屏、断线重连（计划第 72 点），并因此发现列表状态与台账不符的缺陷；`TeamEditor` 本身仍未挂载，其余页面组合没有逐一走查。
- **A13–A19 之后仍然推迟或关闭的事项**（裁决与重新评估的触发条件见 `docs/next-phase-plan.md` 第 2 节和附录，残余风险见 5.2）：B13 完整续办、在途成员的归档式取消、`run.approve`、`run.reconcile`、`run.export`、`reject`、`assign-seat`、派发后自动重试（B7）、推送式失效（B8）、`nextAttemptAt`/`waitingCode`、补报清理加固、成员回合中被关闭或归档的恢复、AC20 的异常记录、默认开启 Engine 与发布（`docs/release-handoff.md` 只备材料）。
- **A12 DEV 真实验证（第一轮已做，仍有残余）**：2026-11-08 在 worktree 自建的 `.paseo-dev` 上做了 4 个 Run，生产用 claude haiku 5.5（bypassPermissions），审查/冒烟用 codex gpt-6-luna（full-access），所有 Run 串行在同一个探针仓库。结果：`replan` v4、判官重派、重启后 `kick`、S1 真实宿主重查、真实浏览器/窄屏/重连各有 N=1 证据（计划第 68–72 点）；补证模板没有触发（计划第 67 点），所以“真实模型是否遵守补证模板”仍无证据；可选探针 V2′（同键跨 daemon 重启）、F（失败回合样本）以及 2.12 的“回合中归档成员看宿主发哪些 hook”探针都没有做（没有额外 Run 额度，也没有廉价办法制造失败回合）。DEV 还发现两条缺陷/已知限制，见“每项的检查结果”末尾。清理：20 个 DEV Agent 全部归档、探针仓库与临时目录删除、evidence 与 run 文件删除、端口还原、daemon 停止。
- **`LaunchDialog` 的渲染测试**（已由 A17 补上，`tests/run-view/launch-dialog.test.ts`）：此前它调用 `launch-job-copy.ts` 的接线只靠类型检查。
- **`decision-answer.abandonAttempt` 的清理与"unknown 的补报先按回显确认再放锁"**（可达性复核 4.2、4.5）：计划第 37 点已写，没做；它需要在 `settleRepairs` 之前做宿主读取，是另一项加固。

- **评审发现 3：告警被 acknowledged 后下次派发会被重新打开**（阶段 4 登记，不修）：`raiseAlert` 只把 `open` 的同编号告警当作已存在，`acknowledged` 的会被重新打开；查过 `server`、`client`、`shared/domain`，目前没有任何入口把告警置为 `acknowledged`（只有 schema 枚举和 `run-alert.ts` 的注释），所以现在不可达。将来加“确认告警”的入口时，失败任务闸与容量告警都要一并考虑。
- **评审发现 4：闸的告警清除只在 `lifecycle` 为 `active` 时运行**（阶段 4 登记，不修）：`dispatchNextUnlocked` 对非 `active` 的 Run 在清除之前就返回 idle，所以 Run 暂停期间即使失败数已回到上限以内（例如人在暂停时取消了失败任务），旧的 critical 告警会留到恢复后第一次派发才撤下。恢复后会自己撤，不影响正确性，只是暂停期间页面还显示旧告警。
- **评审发现 6：`addPlanRequest` 的错误文案不准**（阶段 4 登记，不修）：`run-record.ts` 的 `addPlanRequest` 在预留协调者回合得到 `already-counted` 时也抛“the coordinator has no turn left for the plan request”，文案说的是没有回合；正常路径够不到这一分支（前面已用 `wake` 与 `dagControl` 挡住重复准备），所以不改。

- **T6-A 评审的 4 条低（无阻塞，留到 T10 对账）**：F1 旧链路 Run 的首屏也显示“读取中”（`run-list.ts` 的 `status === "pending" && progress.phase === "done"` 对按标签推断为 done 的所有行生效，不区分 Engine Run；计划 T6c 接受这一点，但与“旧链路 Run 首屏显示已完成”的预期不符）；F2 切换宿主后沿用上一宿主的列表错误（`use-engine-run.ts` 的 `error` 不随 `hostId` 变化清空，新宿主首查慢时按标签推断，done 行显示“已完成”）；F3 暂停期间撤失败闸告警有读-写间隙（`failedTaskLimit(read.record)` 与 `clearFailedLimit` 的 update 之间若有 intake 写入把任务标成 failed，会撤掉重新成立的告警，直到恢复；active 路径同构）；F4 `flush` 抛错会丢掉剩余缓冲（`observer.ts` 先清 `buffer` 再逐条 `ingestNow`，某条抛错后其余条目既没投递也没放回，T6d 让 `retryNow` 也调用 flush，使这条既有路径可达）。
- **T6-B 评审的残余（9 条，最高低，无阻塞）**：F1 `stillOffered` 的“offer 消失即丢弃”只测了重试，取消任务、追加预算、取消 Run 三个分支没有用例（`control-ui.ts` 分支覆盖 83.33%）；F2 数字框的 `budgetRevision` 不含轮询版本这一不变量没有用例钉住（若以后改成含 `view.revision`，每次 ready 轮询都会重挂载输入框，文本断言仍会通过，但 web 上正在组字的内容会丢）；F3 确认后服务端拒绝或传输失败的用户提示只在 runner 层有用例，对话框流程没有端到端用例；F4 真实宿主 Modal 在卸载时是否回调 `onClose` 未验证（若回调会清掉 store，真实页面仍会丢对话框），留给 T8 的 DEV 验证（确认框打开时停起 daemon）；F5 数字框在服务端接受追加后不清空，会保留上次输入（与“默认 4”的语义不完全一致，影响低）；F6 验收表“见上两例”指向不对（本提交已修）；F7 红日志 25 条里 2 条是测试自身 `deps` 未定义，不是源码缺陷（计划第 79、81 点已据实写）；F8 新用例没有进验收表（本提交已补 AC22）；F9 `maxLength` 600 与 web/native IME 组字在接近上限时的行为未在真机验证（T8）。另外两条来自结果文档：确认对话框“按下确认即发送并关闭”沿用原行为（没有等服务端接受再关）；“数字不合法”“需要原因”校验提示仍是组件内 state，非 ready 轮询后仍会消失。

## 每项的检查结果

- **T9b**：完整门禁 biome 仅 2 条既有警告、tsc 通过、vitest 213 个文件 3920 通过（3 todo，比 T9a 后多 219）、`npm run test:coverage` 行 92.48%、函数 91.61%、verify:package 通过。变异 26 项（`mutations/t9b.json`）全部被抓，ALL RESTORED；m17（取消期间不开决策）最初存活：预读守卫只省宿主读取，update 内的守卫还覆盖读与提交之间才请求取消的竞态，单独去掉其中一处结果相同；两处都去掉后被抓（补跑记录在 `logs/mut-t9b.log` 末尾）。T4b 的一条老用例（宿主自己报告的结束不是丢失）按 T9b 更新：仍不写回执，但现在是决策的证据。日志在 `logs/gate-t9b-*.log`、`logs/mut-t9b.log`。
- **T9a**：完整门禁 biome 仅 2 条既有警告、tsc 通过、vitest 211 个文件 3701 通过（3 todo，比 T6 后多 82，含评审修复后的 11 条）、`npm run test:coverage` 行 92.46%、函数 91.58%、verify:package 通过。变异 26 项（`mutations/t9a.json`）全部被抓（补用例后才被抓：reconcile 不用锚点窗口、lostTurnCandidates 的 later 按裸 id、reducer 迟到 start 不清取消证据、isComplete167 同一次出现；dag 两项新增），ALL RESTORED。评审（DeepSeek、Grok）无阻塞，修复一轮见 result-t9a.md。回滚演练：0.7.0 源码（git archive 标签）读 v1、v2 带 `#2` 的台账，不抛、目录哈希不变。残余见计划第 82 点与 README。
- **T6-B**：完整门禁 biome 仅 2 条既有警告（`tests/run-core/r01g-core.test.ts:26,79`）、tsc 通过、vitest 207 个文件 3595 通过（3 todo，3598）、verify:package 通过；`npm run test:coverage` 行 92.4%、函数 91.48%（阈值 90 与 85），`control-ui.ts` 行 100%、分支 83.33%；变异 8 项（`mutations/t6b.json`）全部被抓到；一次评审 9 条、最高严重度低、无阻塞（残余见“没做或没做完”）。失败测试先行：F1/F6 的用例在未改源码时红（`logs/t6b-red.log` 25 条，其中 2 条是测试自身 `deps` 未定义，已修）。
- **T6-A**：完整门禁 biome 仅 2 条既有警告、tsc 通过、vitest 207 个文件 3583 通过（3 todo，3586）、verify:package 通过；变异 16 项（`mutations/t6a.json`）全部被抓到；一次评审 4 条低/信息级、无阻塞（残余见“没做或没做完”）。

- **A19**：只写文档 `docs/release-handoff.md`。用命令统计（HEAD `5f08529`）：`5533722..HEAD` 70 个提交（17 feat、6 fix、5 test、42 docs），`paseo-agent-team-v0.5.0..HEAD` 130 个（50 feat、10 fix、5 test、65 docs），破坏性标记 0；`git merge-base --is-ancestor a456eb0 HEAD` 与 `git merge-base --is-ancestor 940fca6 HEAD` 退出码均为 0；`git diff 5533722..HEAD` 对 `package.json`、`paseo-plugin.json`、`CHANGELOG.md`、`.release-please-manifest.json` 为空；`npm run test:coverage` 通过（行 91.84%、函数 90.5%），`coverage/` 用后删除。计划没预料到的发现：`main` 就是基线，而 v0.5.0 之后已有 60 个未发布提交（含 Engine 启动路径与 schema v2），所以发布会一次装 130 个提交，已在文档第 0 节与回滚注意里说明。没有改版本文件和变更日志，没有合并、推送、打标签、建 PR。
- **A18**：只改文档与 `readme-facts.test.ts`（新增 3 例）。验收表：AC07、AC19、AC21 升为已覆盖（AC07 的缺口只剩 DEV，已放在“DEV 记录”栏；AC19 的“M1 对账查询”改写为“不提供，由 kick 代替”；AC21 带范围声明），其余各行证据已是阶段 1、2 的结果，状态不变——AC02（没有页面端到端）、AC11（早于关键记录只验证两种）、AC06、AC10、AC13、AC14、AC17、AC18、AC20 的缺口句未被整句关闭，保持“部分”；AC12、AC15、AC22 保持需 DEV。与计划 5.3 的目标不同之处：AC02、AC11 没有升为已覆盖，因为各自仍有未被证据关闭的缺口。README：A13/A14 语义（失败任务上限闸、协调者回合预算）此前已在 A13/A14 写入，本次补“未做”列表（无审批、无在途任务取消、无改派、无派发后自动重试、不能续办中断的启动）、“Do not close or archive a member's Agent while a Run is live”警告、“Advanced fields”一段。`devTargets`（`serverId`、`host`、`home` 三个字段，至多 16 项，`host` 要显式端口且不是 6767、不带凭据）和 `evidenceRoot`（`auto` 或绝对路径、在仓库之外）的形状逐条对照了 `RunDevTargetSchema`、`RunPolicySnapshotSchema`、`gates.ts` 的 `devEndpoint`、`dag-admission.ts` 的 `dev-target-missing`、`repo.ts` 的 `ensureEvidenceRoot`，`readme-facts.test.ts` 把示例 JSON 用 `RunDevTargetSchema` 解析，并核对字段名、`auto` 常量、16 项上限和默认值 3、12。变异 6 项（`a18.json`）全部被抓到：失败任务默认值写错、示例里 devTargets 键名写错、删掉关闭警告、devTargets 上限写错、evidenceRoot 示例不是 auto、验收表引用的用例名改掉；README 与验收表经 `cmp` 逐字节还原。完整门禁（A18 提交前）：biome 仅 2 条既有警告、tsc 通过、vitest 200 个文件 3361 通过（3 todo，A17 后 3358 加 3）、verify:package 通过。
- **A17**：完整门禁 biome 仅 2 条既有警告、tsc 通过、vitest 200 个文件 3358 通过（3 todo，A14 后 3346 加 12：`run-engine-section.test.ts` 4 项、`launch-dialog.test.ts` 7 项、`seat-profile-facts.test.ts` 1 项；文件数 198 加 2）、verify:package 通过；`version-flow` 并行时一次 Windows `EBUSY`，单独重跑 23 项通过。第一次尝试就通过全部定向用例。变异（`a17.json`，12 项）全部被抓到：容器不把 `seatProfiles` 交给编辑器、容器不算 Profile、多塞一个不在规划行里的席位、`TeamEditor` 不渲染容器、`TeamEditor` 不交规划行、启动对话框丢掉 kickoff-pending 文案、丢掉未确认完成的提示、不显示失败、丢掉复制启动消息按钮、阻断时启动按钮仍开着、预览不显示阻断、预览不显示警告；5 个源码文件经 `cmp` 逐字节还原。与计划文字的差异：(1) 原有源码扫描用例不能原样保留（它扫的字符串随接线搬进了新文件），改成扫 `RunEngineSection.tsx` 并另加一例确认 `TeamEditor` 把规划行交给该组件、自己不再直接渲染 `RunEngineEditor`、不再算 Profile 事实；(2) 对话框测试不 mock `@tanstack/react-query`，用真实的 `QueryClientProvider` 和 `useQuery`，只 mock 插件的 `useRpc`、`Modal`、`useToast`、`copyText` 和目标上下文 hook，Engine 阻断与警告文案来自真实的启动计划器（`buildLaunchPlan`）。`TeamEditor` 本身仍没有挂载（它引入整个宿主）。没有真实浏览器检查。

- **A14**：完整门禁 biome 仅 2 条既有警告、tsc 通过、vitest 198 个文件 3346 通过（3 todo，A16 后 3319 加 27）、verify:package 通过。第一次实现就通过全部定向用例，没有走到第二次尝试。先写失败测试再实现：新增的 `coordinator-budget.test.ts`、`control.test.ts`、`start.test.ts`、`team-config.test.ts`、`team-config-edit.test.ts` 用例在实现前分别因缺模块或断言不成立而变红。变异（`a14.json`，15 个点）：启动不扣、重新规划不扣、已付的回合不识别、旧 Run 条目从 0 起、耗尽不拒绝、`run.budget` 不先建协调者条目、启动门不看（Team 编辑器与预检各一项）、计划格式重发也扣、耗尽时每次问都写告警、追加预算改了冻结策略、协调者告警写成席位口吻、条目限额为 0、懒建时不数已 `failed` 的计划请求、拒绝码没有中文，全部被抓到。首轮 3 项存活，原因都在我的测试编排而不是缺用例：对 `coordinator` 追加预算的集成用例里条目已被前一次被拒的重新规划建好（补了“旧 Run 没有条目”一例）；前缀特判那项和 `control.test.ts` 一起跑时 `-t turn.budget` 把纯函数用例过滤掉了（单跑 `coordinator-budget.test.ts` 即被抓）；缺中文那项跑错了测试文件（穷举在 `tests/run-view/controls.test.ts`）。源码经 `cmp` 逐字节还原（每轮脚本输出 ALL RESTORED）。回滚演练：`git show`/`git archive` 取 `f1f1e48` 的整个 `shared/` 到仓库外临时目录，旧版 `RunRecordSchema` 读一份带 `coordinator` 条目（`reserved: 2`）的 v2 记录解析通过且条目保留，旧版 `checkLedgerInvariants` 通过；临时目录里的 `node_modules` 是指向主工作区的 junction，用后先 `rmdir` 摘掉再删目录，主工作区的 `node_modules` 完好。与计划文字的差异：(1) `budget.ts` 的前缀函数对字面量 `coordinator` 做了特判（计划要求前缀对协调者给出“协调者的回合预算已用完”，而 `budget.ts` 不能导入 `dag-admission`），这是计划“不碰 `budget.ts`”一句里“循环依赖迫使最小改动”的那种例外，`coordinator-budget.test.ts` 把两处写法绑在一起；(2) 重新规划遇到 `already-counted`（同键或同消息号已在 outbox）按重放处理，返回 `replayed`，正常路径到不了；(3) `support/plan-fixtures.ts`（测试辅助，不是共享夹具 `base.ts`）的 `prepared()` 多一个 `schemaVersion` 选项，让纯函数用例能跑 v1 与 v2。DEV 未验证。

- **A16**：完整门禁 biome 仅 2 条既有警告、tsc 通过、vitest 197 个文件 3319 通过（3 todo，A15 后 3306 加 13：`driver.test.ts` 10 项、`runtime.test.ts` 1 项、新文件 `tests/run-view/runs-tab.test.ts` 2 项）、verify:package 通过。七组各自定向通过，没有撤回；A16-4 先 grep 过，`localCancellation` 在引擎测试里无人断言，所以新增而不是只补引用。变异（`a16.json`，22 个变异点，前后共 27 次运行）：第 1 组 3 项全被抓（任务不等冒烟就完成、`failedDeliveryIds` 不数失败的检查项、两层一起不数）；第 2 组 3 项全被抓（路径比较区分大小写、反斜杠不当分隔符、完成的任务不放占用）；第 3 组 4 项中 3 项被抓（冻结原因变普通原因、不看其他 Run 的占用、取消时不等没有回合结束的尝试），1 项存活（观察器把 `agent.closed` 记成 `turn_ended` 并且驱动当回合结束处理）；第 4 组 3 项全被抓（取消原因写错、两处放占用一起去掉、nonce 作废原因写错）；第 5 组 5 项全被抓（Runs 页不画 Engine 段、不画链路的 Run、Engine 段把 Run 藏起来、坏块不再阻断新启动、块被删后走 Engine）；第 6 组 2 项全被抓（hook 后留下定时器、回合结束一秒后再看一遍）；第 7 组 2 项全被抓（无报告路径不比对回合 id、回复窗口取最新回合）。第一轮 20 次运行有 5 次存活，原因都是我选的破坏点不对：终局门单层（`failedDeliveryIds` 才是第一层）、只在驱动里把关闭当回合结束、只去掉 `markLocalCancellations` 一处放占用（`markCancelled` 还会再放一次）、策略对象共享（`store.create` 序列化后内存里的共享不可观察，等价变异，已从清单去掉）、报告路径里的回合匹配（锚点选错，用例走的是无报告路径）；改后全被抓。仍存活的一项是有意冗余：`agent.closed` 即使被记成回合结束并触发入账，入账仍要求回执的回合 id 等于派发的回合 id，单靠关闭事件不会使任务动起来，所以该现状测试只由取消等待那一项变异（`cancel-request.ts`）抓住。源码文件经 `cmp` 逐字节还原（每轮脚本输出 ALL RESTORED）。DEV 未验证。

- **A15**：完整门禁 biome 仅 2 条既有警告、tsc 通过、vitest 196 个文件 3306 通过（3 todo，A13 后 3298 加 8）、verify:package 通过。六组各自定向通过，没有撤回。变异（`a15.json`，25 次运行）：第 1 组 3 项全被抓（原因码改名、评审不比较 `reviewedRef`、冒烟原因码改名）；第 3 组 3 项全被抓（幂等键每次不同、归档多一个无关 Agent、只归档第一个）；第 4 组 3 项全被抓（协议失败计入质量失败、返工、尝试次数）；第 6 组 2 项全被抓（详情读取写入、列表读取写入）；第 5 组 5 项中 3 项被抓（已投递的暂存 hook 仍留在缓冲、观察器与 reducer 回执去重三处同时去掉的两种用例）；第 2 组 9 项中只有回执去重三处同时去掉的一项被抓。存活的 10 项都在第 2、5 组，原因是重放被多层各自独立地挡住：回执去重（观察器、reducer 的 switch 分支、reducer 的重放守卫三层，去掉观察器一层或加 switch 一层仍不变）、入账的守卫（“等报告”守卫外层、内层、归属重复判断，加上 reducer 的相同证明短路和 nonce 重放守卫全去掉仍不变）、重复评审派发（`nextWork` 的已绑定判断、构建器的重复派发和预算已计数判断、调度的席位负载判断全去掉仍不变，可能还有未逐一定位的更外层守卫）。这些都是有意冗余，不为它们再加用例；用例的价值在于固定可观察结果。源码文件经 `cmp` 逐字节还原。AC19 的“host.sent 为空”无法断言：查询函数不持有宿主，改为断言 `create`/`update` 零调用与文件字节不变，如实写入缺口。

- **A13**：定向 54 项（两个新文件加 `waiting.test.ts`）；完整门禁 biome 仅 2 条既有警告、tsc 通过、vitest 196 个文件 3298 通过（3 todo，基线 3283 加 15）、verify:package 通过。变异 12 项（`a13.json`）全部被抓到：去掉闸、`>` 改 `>=`、把 `cancelled` 也计入、不数 `failed`、每遍换告警编号、闸同时挡住入账与补报、读 `strategicTurns`、回落后不撤告警、不超限时每遍写入、告警降为 warning、中文表缺该原因码、没有活要派时也写告警（A13-09 首次因格式化后锚点变化未应用，改锚点后单独重跑被抓）；4 个源码文件经 `cmp` 逐字节还原。与计划文字的差异：任务的状态字段在代码里是 `state`（计划写 `status`）；告警编号取自固定前缀，所以失败数从 4 变 5 不会再写第二条，代价是摘要里的“现有 N 个”只反映第一次写入时的数；失败数用直接往台账加 `failed` 任务造出，A4 `cancel` 以任务变 `cancelled` 代替，没有对 D3 的 `retry` 做端到端（真实 D3 需要顶层席位用完质量次数，夹具太重）。DEV 未验证。
- **评审发现处理（阶段 4）**：定向 `failure-limit` 两个文件 21 项、`tests/run-view` 13 个文件 269 项通过。完整门禁（代码提交 5209eea 前）：biome 仅 2 条既有警告、tsc 通过、vitest 201 个文件 3370 通过（3 todo，A19 后 3361 加 9）、verify:package 通过；`npm run test:coverage` 也跑过，行 91.85%、函数 90.52%，跑完删掉了被忽略的 `coverage/`。变异 24 项（`p4-mut.json`、`p4-mut-f7.json`）全部被抓到：F1 12 项、F2 3 项、F7 9 项，其中 F7-01 到 F7-06 证明条件永不成立时是在 2 秒后失败而不是挂住；`service.ts`、`failure-limit.ts`、`runs-tab.test.ts`、`launch-dialog.test.ts`、`wait-until.ts` 经 `cmp` 逐字节还原。闸现在的精确语义：超限（失败数大于 `policy.run.failedTasks`）时，状态为 `ready` 的任务不开始，其余在途工作（报告入账与补报、`assigned`/`in_progress` 的补证请求、`review` 的评审与冒烟、`rework` 的返工）照常；只剩 `ready` 任务可做时返回 `failed-task-limit` 并把原因写在被拦任务上；告警只在确有 `ready` 任务被拦时写一条，回落后撤下。与计划 2.9 的差异：计划写“不再开始任何新的派发（含审查、冒烟、补证请求）”，评审指出这与告警和中文文案的“进行中的工作继续收尾”矛盾，按后者改，计划原文保持不动。需要知道的一点：人在决策点选“重新开始”（`fresh`、`abandon`）送回起点的失败任务状态也是 `ready`，所以失败数仍超限时它的重新派发仍会被拦，这与计划 2.9 的风险说明一致。

- **README 恢复说明更正**：只改文档。读取恢复后「自动继续前 3 次（`READ_RETRY_AUTO_CONTINUE_GENERATIONS`）、之后留下请 kick 的提示」与「启动中断的 Run 被关闭并告警、需要人去找已创建的 Agent 并重新启动」两处，按代码和 A7、A8 的实际行为改写；`readme-facts.test.ts` 不断言这两句，所以改动不依赖该测试。没有 DEV 验证。

- **T5c 补正（Profile 警告接线）**：完整门禁 biome 仅 2 条既有警告、tsc 通过、vitest 194 个文件 3283 通过（3 todo）、verify:package 通过。变异 7 项（席位号不符不排除、候选不排除、多行不排除、编辑器忽略 seatProfiles、未选 Profile 也算、TeamEditor 不传 prop、TeamEditor 不计算）均被抓到；源码经 `cmp` 逐字节还原。注意：变异过程中曾误用 `git checkout` 还原 TeamEditor，一度丢掉未提交接线，已从备份恢复并重跑验证。

- **T5b 补正（告警、预算原因、事件文案）**：完整门禁 biome 仅 2 条既有警告、tsc 通过、vitest 193 个文件 3278 通过（3 todo）、verify:package 通过。变异：预算缺失映射改名、重新规划文案改回「发了」、告警责任人改写死、告警下一步行删除，均被抓到；源码经 `cmp` 逐字节还原。告警 DTO 没有结构化类型，故只显示摘要并明确「需根据告警内容判断」，没有为告警文字做解析。

- **T5a 请求编号与未知结果提示补正**：定向 2 个文件 88 项通过；完整门禁 biome 仅 2 条既有警告、tsc 通过、vitest 193 个文件 3271 通过（3 todo）、verify:package 通过。4 项变异分别破坏 UUID 版本位、安全随机数字节分支、无加密随机源的回退和传输提示，均被对应断言抓到；源码经 `cmp` 逐字节还原。没有真实浏览器验证。

- **文件锁并发读取加固**：定向测试 55 项通过，真实双进程回收同一死锁连续 10 次通过；完整门禁 biome 仅 2 条既有警告、tsc 通过、vitest 193 个文件 3268 通过（3 todo）、verify:package 通过。4 项变异全部被抓：主锁不复读、guard 不复读、复读次数不足、把永久损坏当作不存在；源码经 `cmp` 逐字节还原。超过 300 毫秒仍读不完整时会按损坏拒绝，不会冒险接管。

- **A10**：定向测试 109 项通过；完整门禁 biome 仅 2 条既有警告、tsc 通过、vitest 193 个文件 3265 通过（3 todo）、verify:package 通过。变异 7 项全被抓：判官误归生产者、重试忽略类型、未知类型抛错、投影丢字段、等待文案忽略类型、旧服务端缺字段被拒、无报告误分类；5 个源码文件经 `cmp` 逐字节还原。旧输出 schema 去掉新字段可解析；新客户端可读旧输出并对未知类型回退。

- **A9**：新增 5 项测试，全量 biome 仅 2 条既有警告、tsc 通过、vitest 193 个文件 3261 通过（3 todo）、verify:package 通过；权限等待重启、解除回执去重、替代席位、重复事件和空闲 kick 均有真实 store 与假宿主覆盖。变异 3 项全部被抓：忽略待处理权限、权限请求触发派发器、端口增加代答方法；3 个源码文件经 `cmp` 逐字节确认还原。没有真实时间长跑或 DEV 权限对话验证。

- **A8**：定向测试 34 项通过；完整门禁 biome 仅 2 条既有警告、tsc 通过、vitest 192 个文件 3256 通过（3 todo）、verify:package 通过。9 项变异全部被抓：移除正在启动保护、误关 kickoff-pending、恢复时归档、重复失败、误认协调者、截断警告、并发启动保护失效、提交时不查生命周期、记错失败原因；源码备份经 `cmp` 逐字节确认还原。告警列表按长度截断且保留清理提示；已创建但未登记的 Agent 需人工查找。DEV 未验证。

- **A7**：biome 仅 2 条既有警告；tsc 通过；vitest 191 个文件 3236 通过（3 todo，A6 后 3224 加 12）；verify:package 通过。变异检查 8 项（`a7.json`）全部被抓到，A7-06 首次存活后补了直接测 reconcile 的用例。

- **A12 DEV（第一轮，2026-11-08）**：在 worktree 自建的 `.paseo-dev` 上新建了 3 个 Profile（claude 的 `a12-claude-haiku` = `remote-magpie/auto/claude-haiku-5-5`、bypassPermissions；codex 的 `a12-codex-luna` 与 `a12-codex-luna-full` = `remote-magpie/auto/gpt-6-luna`，auto-review / full-access）、7 个 Role、3 个 Team，用仓库外的探针仓库（一个 add() 减法 bug 和 `npm run check`）跑了 4 个 Run。六项结果：补证模板未触发（N=0，生产者的首份报告都被证据门直接接受，`evidenceReturns` 为 0；角色资料里的相对路径要求被模型主动忽略，Run 2 生产者在回复开头复述了这条要求却仍按派发事实用绝对路径）；`replan` v4 通过（N=1，Run 4 首份计划无块 → awaiting-dag → 重规划 epoch 2，新 nonce 的 DAG 被接纳，协调者预算 1→2，旧告警 resolved）；判官重派通过（N=1，Run 2 静默审查者首回 OK → OUTCOME_UNKNOWN → stuck-judge → 页面确认重试 → 同一 Agent 补交 review-report，任务 done）；重启后 kick 通过（N=1，Run 1 修订 32→37、idle、零发送、冻结与决策保留；Run 4 修订 35→36、idle）；S1 重查通过（N=1，Run 4 在 reviewer 回合中停起 daemon，1/2/4 秒重查 3 次用尽，warning 点名 Agent 与 assignment 并提示 kick，任务不误推进、零发送）；真实浏览器/窄屏/重连通过（N=1，Chrome 1280x900 与 390x844 无横向溢出、按钮可点；停 daemon 显示插件不可用而非空进度，同端口重启自动重连）。Run 1 的审查者在 auto-review 模式下触发真实权限请求并回 blocked `PERMISSION_REQUIRED`，引擎只开 stuck-judge 的重试/取消，没有代答、没有归档（AC12 的唯一真实样本）。命令与投影输出只在本会话里，探针与 DEV run 文件已按规则清理；补证模板、V2′、F 与 AC15 的损坏/容量场景没有证据。

- **A12 发现 1：Runs 列表状态与台账不一致**。复现：让一个 Run 处于 `active` 且任务 `blocked`、有 open 决策（Run 1 在 reviewer 权限等待时就是这样），打开 `http://DEV_HOST/` 的 Agent Team → 运行页；列表卡片显示“已完成”、筛选“已结束”把它计入，而同页顶部摘要显示“运行中 需关注 / 阻塞 1”。直接读台账 `lifecycle` 为 `active`、任务为 `blocked`、`endedAt` 不存在。对一个已 `cancelled` 的 Run（Run 2 之后的 Run 1）列表也显示“已完成”。原因未查（A12 不改源码）；验收表 AC22 的缺口已记这一条。
  - **已修（78ff83f，计划第 73 点）**：根因在客户端。Engine Run 的 Agent 也带 agent-team 标签，按标签推断的列表也收录了它，只按空闲协调者判成“已完成”；Engine 列表本身按 lifecycle 是对的。`buildRunRows` 现在对 Engine 列表点名的 Run 以台账 lifecycle 为准（`finished` 才是已完成；`cancelled` 显示“已取消”并归入已结束；`active` 且 `needsAttention`、`paused` 为“等你处理”；未知 lifecycle 不显示“已完成”）。没有改服务端 DTO，没有登记待批准项。检查结果：完整门禁 biome 仅 2 条既有警告、tsc 通过、vitest 201 个文件 3386 通过（3 todo，3370 加 16）、verify:package 通过；变异 13 项（`a12f1.json`）全部被抓到：active 忽略 needsAttention、cancelled 读成 done、未知 lifecycle 声称 done、未知 lifecycle 保留 Agent 的 done、paused 读成 running、cancelled 计入进行中、已取消的时间标签写成“结束”、已取消的成员计数列出未开始、列表不读 Engine 列表、展开卡片沿用 Agent 阶段、卡片不传阶段、已取消文案写成“已完成”、徽章表把已取消显示为已结束；6 个源码文件经 `cmp` 逐字节还原。没有在真实 DEV 上重验；Engine 列表第一次返回之前（最多一个轮询周期）列表仍可能按 Agent 状态显示。

- **A12 发现 2：重启丢失在途回复后，取消一直等**。复现：Run 4 的 reviewer 回合进行中 `daemon stop --home <DEV>` 再 `daemon start`，恢复读取重查 3 次后写 `读取重试已用尽（incomplete:dispatch-not-found）` 告警，任务保持 `review`；`run.kick` 返回 idle、零发送；`run.cancel` 返回 `applied` 但 `lifecycle` 变 `paused`、`waiting.turns` 为 1，之后再 kick 返回 `not-active`，Run 既不完成也不取消，只能删 DEV 台账文件（探针环境）收场。这与 `docs/next-phase-plan.md` 2.12 的已知限制一致，但现在有真实宿主复现；A12 按规则不修。
  - **出路（A21，计划第 74 点）**：不批准把“宿主读到 idle”当静止证据，`planCancelFinish`、reducer、`isNormalEnded` 不动，引擎也不向丢了上下文的成员补发请求。只改了告警文字与文档：用尽告警（原因 `incomplete:dispatch-not-found`）追加固定提示——待该成员在 Paseo 里空闲后，向它发一条只要求回复 OK 的消息，等它回复后点“立即检查并推进”；README 恢复部分同样说明，并写明“继续”没有出路，成员不回只能取消重开。机制是成员这条新消息会开自己的回合，宿主为它发 `turn_started`/`turn_ended` 回执，回执晚于 assignment 创建、其后无新回合、宿主读到 idle，取消的现有结算条件就满足；离线用例 `tests/run-engine/lost-turn.test.ts` 覆盖这一过程和各类继续等的情形。旧台账里旧摘要的告警仍能被新代码解除，不会同一条目开两条。检查结果：完整门禁 biome 仅 2 条既有警告、tsc 通过、vitest 202 个文件 3407 通过（3 todo，3386 加 21）、verify:package 通过；变异 11 项（`a21.json`）全部被抓到，细节见计划第 74 点。没有在真实 DEV 上验证出路；DEV 上若失败、真实再现或宿主给出重启/孤儿回合信号，转 B14。

- **A12 意外行为（正面）**：协调者在 4 个 Run 里 3 次收到“故意提交非法 DAG”的角色资料或用户任务文字（缺依赖、不存在的 t-prep、不可逆的远端删标签），都没有照做：前两次直接给出合法 DAG，第三次用纯文字说明不可逆障碍而不编造计划。这说明规划提示词对资料里的“测试要求”有抵抗力，也解释了补证模板的偏差要求为什么没有生效。


- **A6**：biome 仅 2 条既有警告；tsc 通过；vitest 191 个文件 3224 通过（3 todo，A5 后 3196 加 28；`ledger-real-fs` 一次 EBUSY，单独重跑通过）；verify:package 通过。变异检查 10 项（`a6.json`）全部被抓到。

- **A5**：biome 仅 2 条既有警告；tsc 通过；vitest 190 个文件 3196 通过（3 todo，A4 后 3155 加 41）；verify:package 通过。变异检查 15 项（`a5.json`）全部被抓到。

- **A4**：biome 仅 2 条既有警告；tsc 通过；vitest 189 个文件 3155 通过（3 todo，A3 后 3140 加 15）；verify:package 通过。变异检查 11 项（`a4.json`）全部被抓到。

- **A3**：biome 仅 2 条既有警告；tsc 通过；vitest 189 个文件 3140 通过（3 todo，A2 后 3107 加 33）；verify:package 通过。变异检查 9 项（`a3.json`）全部被抓到。

- **A2**：biome 仅 2 条既有警告；tsc 通过；vitest 188 个文件 3107 通过（3 todo，A1 后 3095 加 12）；verify:package 通过。变异检查 4 项（`a2.json`）全部被抓到。

- **A1**：biome 仅 2 条既有警告；tsc 通过；vitest 187 个文件 3095 通过（3 todo，基线 3069 加 26）；verify:package 通过。变异检查 10 项（`a1.json`）全部被抓到。回滚演练：`ledger.ts`、`invariants.ts`、`transitions.ts`、`gates.ts` 相对 1811b0f 逐字节不变，上一版读压缩后的记录是构造上成立的。

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
- **T7b**：biome 仅 2 条既有警告；tsc 通过；vitest 184 个文件 3064 通过（3 todo，T6b/c 后 3046 加 18）；verify:package 通过。变异检查 8 项（`mut-t7b.mjs`）全部被抓到；中途一次后台运行被截断（输出少了最后一项，文件停在被破坏状态），我用备份还原并逐字节确认后，把最后一项单独重跑，被抓到。
- **T6a/T6d**：biome 仅 2 条既有警告；tsc 通过；vitest 185 个文件 3069 通过（3 todo，T7b 后 3064 加 5）；verify:package 通过。T6a 的证据由两个只读子会话按 AC 编号查测试，我用 `acceptance-doc.test.ts` 逐条核对文件与标题（手动改坏一条标题确认会失败，已还原）。

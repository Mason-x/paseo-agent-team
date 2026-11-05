# Agent Team 下一轮迭代计划：Run Engine 最小执行闭环

- 日期：2026-11-05。
- 状态：迭代方向已确认；本文为待实施计划，不代表功能已交付。
- 代码基线：`9a04413`，`paseo-agent-team` 版本 `0.5.0`。
- 目标：在现有角色、团队和运行界面上，交付一个能持续推进、解释原因、在重启后恢复的任务执行闭环。
- 范围：补齐 Run Engine 的服务端与运行接线，复用已有合同、纯内核、存储底座和视图。
- 与历史文档的关系：本文细化并更新 [长期路线图](orchestration-roadmap.md) 的阶段 1，保留 B 批只读、C 批产生副作用的边界。本轮范围、顺序和验收以本文为准；现有合同若需修改，必须先交付合同变更和兼容用例。

## 1. 本轮交付结果

用户启动一个已启用 Run Engine 的 Team 后：

1. 协调者根据目标输出合法任务 DAG；程序校验并保存任务、依赖、职责、范围、预算与验收要求。
2. 程序选择就绪任务、取得资源占用并派发；成员按职责提交实现、审查或冒烟报告。
3. 证据、独立审查和必要的 DEV 冒烟全部通过后，程序才完成任务并放行依赖任务。
4. 临时失败、报告格式错误、等待人处理和执行结果不明分别处理，避免把所有异常都变成重新做业务。
5. 关闭客户端不影响执行；插件或 DEV daemon 重启后，程序先核对在途动作，再恢复允许继续的工作。
6. Runs 页说明当前进度、等待原因、最近一次转换和下一步触发条件。

首个真实验收使用两个有依赖的业务任务。实现、审查、冒烟是一个任务的执行阶段，沿用既有合同，不再重复建成同名业务节点。并发与冲突场景使用额外的离线夹具和独立 DEV 用例验证。

## 2. 当前基线与复用清单

代码路径均相对仓库根目录。下表的“存在”仅表示已核对文件和入口，不代替本轮行为验收。

| 能力 | 当前事实 | 本轮处理 |
| --- | --- | --- |
| 团队启动 | `paseo-agent-team/server/launch-service.ts`、`shared/domain/launch-team.ts` 创建成员并向协调者发送 kickoff | 保留旧链路；为启用 Engine 的运行建立独立执行入口 |
| 输出合同 | `paseo-agent-team/shared/schemas/run-engine/{protocol,ledger,config,rpc}.ts` 已存在 | 作为字段、身份、状态、上限和兼容规则的起点 |
| 状态机与纯规则 | `paseo-agent-team/shared/domain/run-engine/` 已有 reducer、scheduler、locks、budget、gates、wake-summary 等 | 先验证再复用，不另写一套调度规则 |
| 原子存储与进程锁 | `paseo-agent-team/server/ledger/{atomic-json,process-lock}.ts` 已存在 | 组装运行台账与单写者服务 |
| 运行观察与执行服务 | 尚无 `paseo-agent-team/server/run-engine/` 服务目录，`index.server.ts` 尚未注册 Engine 运行入口 | 本轮主要新增区域 |
| 运行详情视图 | `paseo-agent-team/client/runs/engine/` 与 `shared/domain/run-engine/view.ts` 已存在 | 补查询、状态缓存、导航与历史接线 |
| 测试与夹具 | `tests/run-core/`、`tests/run-view/`、`tests/fixtures/run-engine/`、`tests/spec/run-engine-matrix.md` 已存在 | 复用输入与不变式，补真实服务、恢复和副作用断言 |
| 启用配置 | 合同已有 `Team.runEngine`；缺省为关闭 | 接通能力声明、配置校验与预览，不新增一套团队模式 |
| 历史模式 | README 已明确四种旧模式和经济池退役；实际按 Role 首选及备选 Profile 解析 | 不恢复旧模式，不按历史模式字符串重新路由模型 |
| 未来运行能力 | `launch-runtime.ts` 中按需创建、扩容、协作运行仍关闭 | 本轮保持关闭，使用预先创建的有限席位 |

历史文档中“B 批全部待实施”的描述已落后于文件现状。开工时区分“代码存在”“测试通过”“已接运行入口”“DEV 验收通过”，不得以其中一项代替其余项。

## 3. 采用的借鉴与范围边界

参考 Agent Autoloop 的固定提交 `8f8e2eef3cfaa8f7a418818adc442450fe6bd884`，借鉴以下机制：

| 借鉴点 | 在本项目中的落点 |
| --- | --- |
| 纯决策内核与运行外壳分开 | 现有纯内核决定转换与意图；服务端执行外部调用 |
| 持久化后再确认 | 台账、事件收据、assignment、预算预扣、资源占用和 Outbox 意图按一致性要求提交 |
| 回执错误单独修复 | 增加有界的报告修复流程，不重新执行已完成的实现动作 |
| 等待事件化、定时集中管理 | 持久化等待条件和截止时间，只调度最近一次到期，不让模型轮询 |
| 解释运行原因 | 从台账事件生成原因时间线，不再用 LLM 猜测过程 |
| 可复现故障模拟 | 固定种子、独立不变式检查、真实文件系统崩溃窗口测试 |

本轮不做：独立 Agent 中台、独立 CLI Worker、SQLite 迁移、外部 Issue/Webhook 自动接活、飞书等新通知通道、按需扩容、多模型仲裁、模型自动路由、插件市场、自动发布流水线。

Paseo 继续负责 Agent、Profile、会话、工作区、进程与基础通信。现有原子 JSON 底座继续使用；本轮不把全量事件溯源或更换数据库作为执行闭环的前置条件。

## 4. 执行边界与必须保持的语义

### 4.1 单一派发者

一个 Run 在创建时固定由旧协调者链路或 Engine 管理，运行中不切换派发者。

- 旧 Run 不自动接管、不补造台账、不重放历史 kickoff。
- Engine Run 的日常派活、报告修复、重试和决策唤醒统一经过持久化执行服务。
- 协调者负责 DAG、重新规划和已定义的决策；不继续发送旧模板中的日常委派消息。
- `Team.runEngine` 缺失或关闭时沿用旧链路；明确启用但配置无效时阻断启动，不能静默降级。
- 使用现有 Team 成员作为有限席位，席位的 tier、duties、channel 和预算来自经过校验的 Engine 配置并冻结到 Run；不根据模型名称猜层级。

Paseo 原生工具能否在单个 Agent 上限制委派，必须在 M0 查证。提示词不等于强制权限隔离：能力不足时只声明“Engine 保证自己派发的任务”，外部派活和未绑定活动进入异常核对，冻结可能受影响的资源。不得宣称已阻止所有手工消息或其他工具写入。

### 4.2 持久化与副作用

```text
Paseo hook / 启动请求 / 人的决定 / 到期事件
                    |
                    v
       归属、版本、身份校验与事件去重
                    |
                    v
     纯内核计算 + 运行台账的一致性提交
                    |
                    v
        Outbox 执行器调用 Paseo
                    |
                    v
         结果与观察证据写回台账
```

- 外部调用前先提交意图；不得在持有台账写锁时等待网络或模型。
- 同一 Run 的变化串行提交；跨 Run 的资源授予由同一权威登记和锁规则裁决，不能各自读取后分别认为空闲。
- P01 明确单 Run 记录与跨 Run 资源视图的恢复顺序：资源视图若为派生索引，必须在根锁保护下从可验证记录恢复后才能授予新占用；持有者记录损坏或恢复不完整时，保守冻结相关资源，不把索引缺项当作空闲。
- 资源键和冲突范围沿用既有 `locks.ts` 合同。资源锁约束 Engine 的派发，不宣称可以在操作系统层阻止手工编辑或未受管理的 Agent。
- 所有业务报告绑定既有 `runId`、`taskId`、`assignmentId`、`attempt`、`nonce`，实际发送者从 Paseo 上下文核对。
- `messageId` 由程序关联派发记录，不要求模型编造；重复报告不重复推进、不重复扣预算。
- Outbox 只提供持久化意图，不自动获得宿主的 exactly-once 保证。发送成功但响应丢失时，先查消息、turn 与 Agent 证据；不能因超时就直接再发。
- 无法证明发送或停止结果时使用既有 `outcome-unknown` 与冻结语义，保留占用，进入明确决策路径。不得沿用通用队列“租约超时立即释放并重派”的处理。
- 历史事件用于解释与一致性核对；重启恢复不重新执行已确认的历史副作用。

### 4.3 结果分流

| 情形 | 行为 | 计数与边界 |
| --- | --- | --- |
| 合法报告且证据满足要求 | 进入既有阶段转换与质量门 | 本轮结束不直接等于任务完成 |
| 报告缺失、JSON 或协议格式错误 | 同会话请求只修复报告；身份失效或越权报告直接拒收并诊断 | 计 `protocolFailures`，受 `protocolResends` 和回合预算约束 |
| 证据不足 | 按合同请求补证，不直接重做实现 | 计 `evidenceReturns` |
| 独立审查发现质量问题 | 明确返工范围，按既有层级规则重派 | 计 `reworkCount`、`qualityFailures`，不与协议失败混用 |
| 临时执行失败 | 核对旧执行结束及副作用后，按可持久化的退避策略重试 | 消耗相应执行预算；次数有限 |
| 等待人解除阻塞或已有权限请求 | 保存决定、阻塞原因和恢复条件，结束当前可结束的轮次 | 不定时催模型，不自行代答权限，不重复创建同一问题 |
| RPC 结果不明、Agent 可能仍运行 | 核对实际状态，冻结相关写资源 | 不自动解锁，不盲目重派 |
| 取消或暂停 | 停止新派发；在途执行按明确语义收敛 | 暂停不等于停止；请求取消不等于已停止 |

修复提示明确要求不重做业务，但是否能禁用工具必须由宿主能力验证。若只能依赖提示，产品和验收报告必须写明边界；无法在该 Provider 上安全补报时，保留产物并转为可见阻塞，不能退回自动重做业务。

### 4.4 验收与等待

- `doneGate` 是任务完成的唯一程序门；普通自然语言“完成了”和 Provider 的 `turn_ended` 都不能代替验收。
- 实现与审查不得由同一执行者自审。审查和冒烟必须绑定当前交付的 `ref`；交付变化后旧结论失效。
- 只有声明需要 DEV 冒烟的任务强制该阶段，目标必须匹配已登记 DEV 身份。
- 因权限、决策、依赖、资源冲突而等待时保留具体原因与触发条件；没有事件和到期工作时不安排模型调用。
- 使用既有预算、返工与层级上限；控制链的唤醒、报告修复和延迟恢复不能绕过预算。若需补充因果链计数，先变更合同，不把外部项目的“8 跳”直接作为业务 DAG 深度上限。
- 上限使用当前 schema 常量。超限、损坏、未知版本保留原始数据并提供诊断，不能截断历史或用空记录覆盖。

## 5. 工作包与依赖

每个工作包完成都要给出改动路径、验证结果、未支持能力和剩余问题。以下模块名是实施建议；新增公共字段、RPC、错误码先落实到合同与用例。

| ID | 难度 | 交付物与主要路径 | 前置 | 完成判据 |
| --- | --- | --- | --- | --- |
| P00 | L4 | 基线与宿主能力矩阵；更新本文实施记录 | 无 | 明确收发消息、hook 归属、timeline 分页、停止确认、成员创建恢复与工具限制的可用性；列出可验证降级 |
| P01 | L4 | 运行台账与单写者服务，拟新增 `server/run-engine/store.ts`，复用 `server/ledger/` | P00 | 原子提交、CAS、跨 Run 占用、重启恢复、超限与损坏用例通过 |
| P02 | L4 | strict-block 提取、身份核对、观察服务，拟新增 `server/run-engine/{protocol,observer}.ts` | P00、P01 | 重复/乱序/早到 hook 可恢复；错误身份拒收；读取与对账不派活 |
| P03 | L3 | 只读 RPC 与 Runs 接线，复用 `schemas/run-engine/rpc.ts`、`client/runs/engine/` | P01、P02 | capabilities/get/list/history 等按合同接线；无副作用；历史 Run 正常显示 |
| P04 | L4 | Engine 启动、DAG 接纳与 Outbox 执行，拟新增 `server/run-engine/{service,effects}.ts`，调整启动和提示编译 | P00、P01、P02，且 M1 通过 | 单一派发者；派发前落盘；完成、审查、冒烟与依赖放行跑通 |
| P05 | L4 | 报告修复、结果核对、重试与最近到期调度，拟新增 `server/run-engine/{recovery,deadlines}.ts` | P04 | 故障分类不混用；未知结果不重复执行；修复失败保留业务产物 |
| P06 | L4 | 决策、权限等待、暂停、续办与取消的运行接线 | P04、P05 | 决定只生效一次；未证明停止不释放写资源；预算耗尽停新派发 |
| P07 | L3 | 原因时间线、当前阻塞与下一步、面向当前 schema 的 Team 配置接线 | P03；执行状态展示依赖 P04-P06 | 界面解释与台账一致；等待、失败、已完成不会混淆；仅暴露已支持控制 |
| P08 | L4 | 故障模拟、真实 store/adapter 集成、专用 DEV 验收与交付记录 | 逐包介入；最终依赖 P00-P07 | 第 7 节必测矩阵及第 9 节完成条件全部满足 |

关键路径：

```text
P00 -> P01 -> P02 -> P03 -> M1
                         |
                         v
                   P04 -> P05 -> P06 -> P07 -> P08 -> M4
```

P08 的故障用例随对应工作包交付，不等到最后才测试。共享合同、核心状态机与运行入口按依赖顺序修改；不把同一批共享状态交给多个实现流同时改写。

## 6. 里程碑与启用顺序

### M0：基线确认与合同差异收敛

- 核对已有测试、schema、纯内核和视图；对缺失能力建立最小差异清单。
- 在独立 DEV 上验证公共 SDK 的真实能力，记录 Provider 差异，不依靠历史描述猜接口。
- 检查启动链路的 Profile/model 投影，复核 backlog 4b；若仍阻断所选 Provider，在 P04 前修复并验证。
- 明确 Engine Team 配置、冻结 roster、数据根目录来源、事件身份和启用能力门。
- 接口无法证明停止、幂等或消息归属时，采用冻结并核对的路径，不以重发或归档猜测补偿。

退出条件：实现者能从当前代码、能力矩阵和合同得出同一套行为；本轮最小场景不依赖尚未提供的接口。

### M1：补齐 B 批，只读观察可用

- 完成 P01-P03：运行台账、协议提取、观察、只读投影与 UI 接线。
- 启动恢复和事件初始化协调处理；hook 早到不静默丢失，有限缓存不足时通过宿主记录补对账。
- 按既有合同验证单块、32KiB 块、256KiB 回复和分页扫描边界；分页不完整时不能当作报告不存在。
- 对账只修正可证明的观察事实，不创建 Agent、不发消息、不取消、不自动推进执行。
- 旧 Run 没有 Engine 台账时保留旧展示，不从 labels 推导出一份可执行任务图。

退出条件：真实 store + RPC + UI 测试证明观察链路无副作用；通过后才能接入 C 批执行。

### M2：最小任务闭环能真实执行

- 完成 P04：受控启用 Engine Team，启动前验证配置、能力和资源可用性。
- 创建成员、提交运行记录与发出首条计划请求都有可恢复的记录；创建结果不明先按已知关联信息查证，禁止重复建一套成员。
- 协调者提交初始 DAG 后退出日常派活；Engine 根据当前依赖与职责分配 produce/review/smoke 阶段。
- 取得资源、预扣预算、assignment 与发送意图一致提交，随后由 Outbox 调用 Paseo。
- 验收两个有依赖的业务任务，证明后续任务只会在前置任务满足全部门禁后开始。

退出条件：客户端退出后仍能完成正常路径；自审、旧 ref、缺证据和缺冒烟不能完成任务。

### M3：异常、等待与恢复闭环

- 完成 P05-P06：报告修复、可持久化退避、到期恢复、权限等待、暂停、续办和取消。
- 在“提交意图后未调用”“调用后未确认”“报告收取后未回执”等窗口强制中断，再恢复核对。
- 最近到期时间可由持久记录重新计算；重启、时间跳变和延迟到期不能丢任务或形成补偿风暴。
- 非决策性事件不唤醒战略协调者；决策使用既有分类、去重与摘要，合法用户决定沿原任务继续。
- 提交取消后持续核对静止证据，未满足合同前保持相关资源冻结。

退出条件：无响应不等于失败、报告错误不等于业务失败、关闭会话不等于取消；上述区别都有运行用例证明。

### M4：原因可见、验收与交付

- 完成 P07-P08；Runs 页给出因果时间线、当前占用、预算、等待对象和下一触发条件。
- 关闭新增 Engine Run 的启用入口后，已有 Engine Run 仍可观察和安全收敛；不得把在途运行切回旧派发者。
- 完成两种可用 Provider 的跨阶段 DEV 场景，以及小屏/桌面展示和错误路径检查。
- 补使用说明、能力边界、恢复说明和真实验收记录；版本号走现有发布机制。

退出条件：第 9 节完成条件全部满足，才把本轮标成已交付。

## 7. 验收矩阵

已有 `paseo-agent-team/tests/spec/run-engine-matrix.md` 是夹具索引，不是全部行为已验证的证据。本轮为每一项补上对应测试或 DEV 记录。

| ID | 注入条件或输入 | 必须观察到的结果 |
| --- | --- | --- |
| AC01 | T2 依赖 T1，T1 仅提交实现报告 | T2 不派发；T1 仍需满足其声明的审查和冒烟 |
| AC02 | 普通文字称完成、自审、旧 `reviewedRef`、错 DEV 目标 | 不能过完成门；显示具体拒绝原因 |
| AC03 | 同一 hook、报告或人的决定重复到达 | 一次生效；assignment、预算和下一阶段不重复增加 |
| AC04 | 写入意图后、外部调用前中断 | 恢复后执行该意图或按合同终止，不漏记也不额外派一份 |
| AC05 | Paseo 已接收消息但响应丢失 | 先核对实际消息和 turn；无法证明时冻结，不盲目重发 |
| AC06 | 成员创建成功但调用响应丢失 | 按运行关联查证；不重复创建、不误删无关 Agent |
| AC07 | 实现已完成，但报告 JSON 错误；修复再次失败 | 只尝试有界补报；保留产物，协议失败与质量返工分开 |
| AC08 | 超长/多块/未知版本、错任务/attempt/nonce/发送者 | 严格拒收；不推进任务、不放宽身份校验 |
| AC09 | 两 Run 请求同一文件，包含 Windows 大小写和分隔符别名 | 仅一方获写占用；另一方等待并给出原因 |
| AC10 | 派发结果不明、Agent 失联或取消未确认 | 保留相关冻结占用；冲突任务不能趁机开始 |
| AC11 | 收到报告后 hook 才到，或 hook 早于初始化/关键记录 | 按证据补对账并去重；不丢结果，不重复统计 |
| AC12 | 权限等待、人的决定重复提交、等待期间重启 | 不自行答权限；决定只作用一次，恢复后只继续剩余阶段 |
| AC13 | 临时失败、退避未到期/已到期、预算耗尽 | 截止前不重派；到期按预算执行；耗尽不继续消耗模型 |
| AC14 | 暂停、续办、取消时 Agent 仍有在途执行 | 暂停停新派发；续办重新核对；取消证实静止后才释放 |
| AC15 | 台账损坏、未知版本、CAS 冲突、超过硬上限 | 保留原始数据；诊断可见；不覆盖、不截断、不越限派发 |
| AC16 | 旧 Run、新配置旧客户端、Engine 关闭或配置损坏 | 旧 Run 可看；不支持时清晰阻断，不静默采用另一条执行链 |
| AC17 | 长时间无 hook 且无到期工作；重复普通状态事件 | 模型调用数为零；不为无变化输入重复记账或唤醒战略协调者 |
| AC18 | 战略协调者规划后，N 个成员事件完成正常流转 | 没有新增决策时不逐事件唤醒；相同决定去重 |
| AC19 | 查询列表、详情、历史、刷新和 M1 对账 | 不触发派发；返回 DTO 不泄漏 nonce、完整提示或 Outbox 参数 |
| AC20 | 用户绕过 Engine 发消息，或观察到无 assignment 的活动 | 不冒认成有效交付；记录异常并核对受影响资源 |
| AC21 | 定时到期、重启补算、时钟前进或回退 | 截止条件最终被处理，重复到期不重复副作用，不出现忙循环 |
| AC22 | Runs 详情、历史翻页、`unchanged`、断线重连、小屏布局 | 不闪成空进度；原因与台账一致；旧历史游标失效可恢复 |

验证分层：

1. 纯核测试：复用既有用例，加固定种子的事件序列；注入时钟与 ID，验证转换、预算、锁和不变式。
2. 真实 store 测试：使用现有原子 JSON、进程锁与真实文件系统，覆盖崩溃、并发写、损坏与容量边界。
3. 服务与 adapter 集成：可控地制造宿主成功但响应丢失、重复/乱序 hook、分页不完整和停止结果不明。
4. 专用 DEV：真实 Paseo、至少两种可用 Provider、真实角色/团队/运行界面，覆盖正常流及关键错误路径。

模拟器需有独立断言，不只重复调用 reducer 得出同样结果。每次失败输出种子、输入序列、初始快照和复现方法；已确认外部动作与仍待核对动作分开检查。测试步数和压力规模按本项目确定，不把上游性能数字作为本项目验收证据。

## 8. 环境、检查与实施记录

所有运行和 UI 验证遵守 [项目 AGENTS.md](../paseo-agent-team/AGENTS.md)：

- 使用独立 `.paseo-dev`；每条生命周期命令显式指定 DEV `--home` 或 `--host`，同时核对 `PASEO_HOME`。
- 不对默认 host 或真实用户 home 安装、重载、停止插件，不复制真实账号凭据。
- 离线测试把 home 指向独立 TEMP 目录；临时探针和夹具另建目录，结束后清理本轮临时文件。
- 同一工作树不并行执行安装或覆盖率；DEV 真实场景使用仓库外的临时项目。

检查按变更范围执行，并记录结果：

```text
文档：git diff --check、相对链接与引用路径核对
合同/纯核：对应 Vitest 用例、npm run check、npm run typecheck
运行服务/adapter：对应真实 store 和恢复集成用例
发布候选：npm test、npm run check、npm run typecheck、npm run verify:package
运行或 UI 接线：独立 DEV 重载后的正常与错误路径验收
```

只有发现新改动、失败或未解决疑点才扩大或重复验证；不为文案或其他低影响改动增加复述实现的测试。

实施者在本文末尾维护记录，初始状态如下：

| 工作包 | 状态 | 提交/改动 | 验证证据 | 剩余问题 |
| --- | --- | --- | --- | --- |
| P00 | 实施中 | 仅文档（第 11 节） | 基线：`typecheck` 通过；`check` 仅 2 条既有 lint 警告；`npm test` 2193 通过，`version-flow` 1 例并行时 Windows `EBUSY`，单跑 23/23 通过。宿主能力为 SDK 类型级静态查证 | V1-V5 已部分验证（见第 11.2 节）；hook 重复投递与插件重启期间丢失、V6（旧版本）未执行，codex 的 `steer` 未确认；M0 其余差异（11.3）未处理，不得放行 P04 |
| P01 | 实施中 | 新增 `server/run-engine/store.ts`、`tests/run-engine/{store,store-process}.test.ts`、`tests/run-engine/support/store-child.ts`（未提交） | `tests/run-engine` 70 例通过（含 6 例真实子进程）：创建/读回/重复创建、Header 由 store 接管、并发更新串行、跨 Run 占用视图（含大小写与分隔符别名）、损坏/未知版本/超限不覆盖且视图转为不可信；子进程在 after-tmp / before-rename / after-rename 三个点硬退出（退出码 41）后，新 store 回收死锁，读到旧版本或完整新版本并清掉临时文件；另一个活进程持锁时第二个 store 抢锁失败且拒绝写入，持锁进程被杀后可接管；硬上限超出时拒写且原字节不变，软上限给出 `needsCompaction`，任务数超 64 在写前被拒；`typecheck`、`biome` 通过 | 缺：store 尚无调用方（P04 才用跨 Run 授予）；mutator 只支持同步；“占用持有者记录损坏则冻结资源”只有视图上的 `trusted:false` 标记，授予侧的拒绝逻辑与 reducer 衔接未做；未跑全量 `npm test`；`update` 失败后的重读结果未单独断言 |
| P02 | 实施中 | 新增 `server/run-engine/{protocol,observer}.ts`；`store.ts` 增加 `runsForAgent`；测试 `tests/run-engine/{protocol,observer}.test.ts`（未提交） | `tests/run-engine` 107 例通过，`typecheck`、`biome` 通过。protocol：单块/多块/混种/非 JSON/未知版本/未闭合/类型不符各自独立拒收；32KiB 边界（恰好 32KiB 进入解析，多 1 字节在解析前拒收）；整回复超 256KiB、页数超限、gap/stale/reset/epoch 变化、最新页未结束、找不到派发消息都判为 `unverifiable` 而不是“没有报告”；```围栏内的转义与被引用的围栏只当数据；schema 问题只给路径不回显内容；归属核对对 run/assignment/task/attempt/用途/nonce/登记表/发送者/派发消息/回合逐项拒收，已接收为 `duplicate`。observer：hook 重复、乱序、5 类事件风暴只留一条回执；无 turnId 的回合事件不合并；store 未就绪或 run 尚未登记该 Agent 的 hook 先缓存，登记后 `flush` 送达；缓存超限/超龄丢弃并标记 `needsReconcile`；对账只调用只读的 `replyWindow`，部分读取、读取失败只计数不写入，补记的 turn_ended 之后到达的真 hook 为 duplicate；`inspectReport` 只判定不写入 | 已补：`server/run-engine/host.ts` 的 `createObserverHost`（只用 `timeline.refetch` 从尾部向前分页找派发消息，页数超限为 unverifiable，宿主报错向上抛），`host.test.ts` 5 例，`tests/run-engine` 共 112 例通过。缺：1) `createObserverHost` 尚未用真实 `PaseoApi` 在 DEV 上验证（只用结构化假端口）；2) （已处理）`index.server.ts` 现已初始化台账并注册 7 个 `agent.*` hook 送入 observer；DEV 重载后插件 running、台账目录已创建，但尚未在 DEV 上用真实 Engine Run 验证 hook 归属；observer 追加规则：没有任何活动或不可读的 Run 时，无归属 Agent 的事件直接忽略（`no-active-run`），不再塞满缓冲；3) 控制块（task-dag / decision）的身份核对未做，留给 P04；4) AC11“报告先到、hook 后到”只在单元层覆盖；5) 插件重启期间 hook 丢失（V3 未验证）；6) 对账只补 turn_ended，未补 turn_started/权限回执；7) 同一 Agent 属于多个 Run 时只忽略并无诊断出口 |
| P03 | 实施中 | 新增 `shared/rpc/run-engine.ts`（`agent-team.run.list` / `agent-team.run.get`）、`server/run-engine/{projection,queries}.ts`、`shared/domain/run-engine/get-session.ts`、`client/runs/engine/{use-engine-run.ts,EngineRunsSection.tsx}`；`EngineView` 增加 `embedded`；`RunsTab` 在旧 Run 列表上方挂 Engine 区；`index.server.ts` 接入台账、观察器、两个只读 RPC、7 个 hook 与清理；`tests/run-engine/{queries,get-session}.test.ts`，更新 `tests/server-entry.test.ts`（未提交） | 服务端：投影按字段名挑选，测试断言响应不含 nonce、messageId、控制 nonce 摘要、outbox、事件 payload；读取不改记录字节；unchanged/ready/missing/corrupt/unknown-version 各有独立答案；依赖成环的记录被拒绝；历史游标绑定 run 与 checkpoint，失效后回到最新页；列表分页，损坏 run 进 health。客户端会话合并为纯函数：`unchanged` 只在持有同一 revision 时保留原状态，否则要求全量；新 revision 丢弃旧历史页；不可读的 Run 替换而不是保留旧数据；旧游标失效重置。`tests/run-engine` 135 例；全量 `npm test` 2285 通过（`version-flow` 并行时 EBUSY 偶发，单跑 23/23）；`verify:package`、`typecheck` 通过。DEV 真实宿主验证（夹具 Run 写入 DEV 台账后重载）：Runs 页出现 Engine 区；展开后 DAG 分两层、t3 显示「等待依赖 t2」、锁与并发、预算正常；加入截断文件和 schemaVersion 2 文件后，页面显示「台账损坏，已保留原文件」「由更新版本写入，已保留原文件」，两个文件字节不变，旧 Run 列表照常；验证后种子文件、隔离记录与临时脚本已清理，`.paseo-dev` 台账目录为空 | 缺：1) 只用夹具 Run 验证过，没有真实 Engine Run（P04）；2) 小屏布局、断线重连、`unchanged` 的真实 UI 行为只在纯函数层测过，未在 DEV 上做；3) 未提供 `run.reconcile`、`run.export`（对账目前仅在 hook 路径内部触发）；4) 历史摘要只有事件 kind；5) `blockedBy` 的 capacity/channel/seat 来源未投影；6) 旧 Run 无台账时保留旧展示，但没有专门的 AC16 用例（新配置旧客户端、Engine 关闭、配置损坏）；7) 刷新频率为 5 秒轮询，未做 hook 驱动失效；8) 浏览器截图目录 `.playwright-mcp/` 已删除（后续 DEV 验证会再产生，收尾需再清） |
| P04 | 实施中（仅前置） | 新增 `shared/domain/run-engine/team-config.ts`（`resolveTeamRunEngine`、`engineLaunchGate`）；`TeamSchema` 增加 `runEngine: z.unknown().optional()`；`buildLaunchPlan` 接 `runEngineSupported` 并并入启动阻断；`shared/paseo/port.ts` 增加 `PortSendOptions`、`idempotencyKey`、`PortEngineAgentHandle`、`PaseoEnginePort`；`adapter.sendMessage` 透传选项、`createAgent` 透传 `idempotencyKey`；`host.ts` 复用共享端口类型；测试 `tests/run-engine/team-config.test.ts`，`tests/paseo-adapter.test.ts` 补 3 例（未提交） | `typecheck`、`biome` 通过；全量 `npm test` 2310 通过；`verify:package` 通过。`team-config`：缺省/关闭/启用/无效四种读法；无效块只给路径不回显取值；未知 `version`/`policyVersion` 不当默认值；只有存储里明写 `enabled:false` 的损坏块才按旧流程并给警告；启用且有效但 `runEngineSupported` 为假时仍阻断；座位与规划解析出的逻辑座位逐一核对（多余/缺失/重复/全部停用）；旧成员无 `seatId` 时按位置派生的 id 也能匹配；`runEngine` 经 `TeamSchema` 与 `keepTeamMetadata` 往返不变。**Outbox 执行器（2026-11-05 追加）**：新增 `shared/domain/run-engine/effect-state.ts`（意图状态转换）、`server/run-engine/effects.ts`（`createEffects().runOutbox`）、`host.ts` 的 `findDispatchEcho`；`tests/run-engine` 197 例通过，全量 2357 通过，`verify:package`、`typecheck`、`biome`（仅 2 条既有警告）通过。覆盖：先落盘 `sending` 再调用、成功落 `confirmed`；调用抛错一律 `outcome-unknown` 且不重试（AC05）；`sending` 遗留（崩溃窗口）转 `outcome-unknown`，靠 timeline 回显确认，回显缺失或读取不完整（gap/stale/reset/epoch/页数）保持冻结（AC04/AC10）；`confirmed` 落盘失败后下一轮靠回显收敛；载荷哈希不符或无法重建则 `failed` 且不发送；同一接收者有未决投递时不再发给它；同进程重叠调用串行，两个独立执行器共用台账时只有一个能发（变异检查已确认该用例在去掉保护后会失败）| 缺：1) `runEngineSupported` 目前没有调用方传入，启用 Engine 的 Team 一律被阻断，这是有意的，P04 主体完成前不放开；2) Team 编辑器无 `runEngine` 编辑界面，只保证不丢失，界面属 P07；3) `PaseoEnginePort` 只是类型，尚无服务使用，也未在 DEV 用真实 `PaseoApi` 验证 `messageId`/`idempotencyKey` 透传；4) backlog 4b 已复核，不阻断（见 11.3）；5) Engine 启动与 DAG 接纳未开始；6) 派发侧未开始，见 11.4 的待决设计点（第 1 条工作区策略已定为分阶段 C，第 3 条提示词模板仍待定）；7) V7 探针已部分完成（11.2），omp 与并行争用未测；8) **派发事件构造器（2026-11-05 追加，未提交）**：新增 `shared/domain/run-engine/dispatch-builder.ts`（`buildDispatch`、`applyDispatch`、`REPO_EXCLUSIVE_RESOURCE`）与 `tests/run-engine/dispatch-builder.test.ts`（10 例）。纯函数，ID 与时钟由调用方传入；生成 assignment、nonce、intent、claims（声明范围的 claim 加一个仓库级 `hot` 独占资源 `repo-exclusive`）；在同一次提交里做自身与其他 Run 的锁判断（其他 Run 的 claim 以 `other-run:` 前缀改写 taskId，避免与本 Run 的同名 `t2` 豁免规则混淆；视图不可信则拒绝）和预算预扣（`applyDispatch` 把预扣写入 `budgets`，reducer 拒绝时不预扣）。`tests/run-engine` 207 例通过，`typecheck`、`biome`、`verify:package` 通过；变异检查：去掉 `other-run:` 前缀后对应用例失败。**未做**：reviewer/smoker 派发（需绑定交付）、rework/重发路径只验证了不带新 claim 的分支未单独覆盖、预算 80%/100% 告警未接 D4、`service.ts` 与 Engine 启动、提示词模板（第 3 条，`payload.hash` 由调用方提供）、M2 “交付 commit SHA 范围核对” 尚无实现；9) **仓库与路径核验（2026-11-05 追加，未提交）**：新增 `server/run-engine/repo.ts`（`inspectRepo`、`dispatchWorkspace`、`verifyScopes`）与 `tests/run-engine/repo.test.ts`（17 例，真实 git 临时仓库）。覆盖：真实分支/提交/干净状态；脏树、游离 HEAD、无提交的仓库拒绝派发；链接工作树与大小写别名共用 `repoId`；范围校验拒绝越界 junction、仓库内链接别名、悬空链接、`.git`、短名（已存在与不存在两种）、仓库不符。`tests/run-engine` 224 例通过，`typecheck`、`verify:package` 通过，`biome` 仅 2 条既有警告；变异检查：放行越界检查、去掉别名比对后对应用例失败。限制：该测试文件在 Windows 上约 12 秒（逐个起 git 进程）；校验只在派发时做一次，不能阻止之后的写入；已记录 DAG 接纳需让任务范围的 `repoId` 等于规范 `repoId`（11.4 第 4 条）；10) **Engine 服务，单任务单席位路径（2026-11-05 追加，未提交）**：新增 `server/run-engine/service.ts`（`createEngineService().dispatchNext(runId)`）、`tests/run-engine/service.test.ts`（11 例，真实 store 加真实 git 仓库加假 Paseo 端口）、`tests/run-engine/support/ready-run.ts`（构造器与服务测试共用）。流程：读账本，取第一个 `ready` 任务；用 Paseo `refresh()` 取席位实时事实（空闲、待授权、错误）与账本渠道状态，交 `planDispatchWithReasons` 选席位；核验真实 git 状态与范围；然后在**同一个同步 store 更新**里构造派发、套用 reducer、编译提示词并回填真实 `payloadHash`（先用占位哈希走完 reducer，再用结果账本编译，`compile` 因此必须忽略 `payloadHash`）；提交后才调用 `runOutbox`。所有需要等待的 IO 都在持有 store 锁之前；事实在间隙里过期是安全的，因为提交时 builder 与 reducer 会按实际账本重新核对。覆盖：提交后发送且账本哈希等于所发提示词的哈希；脏树、忙碌席位、待授权或报错席位、提示词无法构造、范围越界、另一个 Run 持有仓库（含同名 `t2`）都不发送也不提交；并发两次只产生一个 assignment 和一条消息；发送失败留 `outcome-unknown`，之后不重发。`tests/run-engine` 235 例通过，`typecheck`、`verify:package` 通过，`biome` 仅 2 条既有警告；变异检查：去掉哈希回填后对应用例失败。**限制与未做**：`compile` 用的是占位实现，不是最终模板（11.4 第 3 条，已另起独立设计）；`resolveSeat`（席位到 Profile 的对应）与 `resolveWorkspace`（启动 Workspace）由调用方注入，尚无生产实现，账本里没有保存这两项映射，需在 Engine 启动时落定；还没有任何地方创建账本记录、接纳 DAG、注册 `service` 到 `index.server.ts`，所以启用 Engine 的 Team 仍被阻断；只派发生产者，没有 reviewer/smoker/rework；`dispatchNext` 只被手动调用，没有触发时机（hook 或定时对账）；一次只处理第一个 `ready` 任务，M2 本就串行；11) **producer 提示词模板（2026-11-05 追加，未提交）**：新增 `shared/domain/run-engine/prompt-template.ts`（`compileDispatch`、`producerSemanticArgs`、`canonicalJson`、`PRODUCER_TEMPLATE_VERSION = 1`）与 `tests/run-engine/prompt-template.test.ts`（12 例）；`server/run-engine/repo.ts` 增加 `prepareEvidenceDir`；`service.ts` 在派发前创建仓库外的证据目录并把 `repoRoot`、`evidenceDir`、`taskSnapshot` 固定进 `semanticArgs`，证据根为相对路径或在仓库内时以 `evidence-root-*` 阻断；`tests/run-engine/support/ready-run.ts` 支持 `evidenceRoot`。设计见 11.4 第 3 条。`tests/run-engine` 250 例通过，`typecheck`、`verify:package` 通过，`biome` 仅 2 条既有警告。覆盖：多次编译与从重载账本重建字节一致；`payloadHash`、无关任务、时间戳变化不影响输出；身份、workspace、固定事实逐项出现在提示词里；提示词无行首围栏、不含协议块、小于 16 KiB；任务文字里伪造的协议块与区段标记留在数据行内；未知版本、`messageId`/接收者/assignment 不符、`semanticArgs` 缺失或不可序列化、reviewer 用途、无 workspace 一律返回 `null`；用提示词自带字段拼出的 `done`/`blocked`/`failed` 报告通过严格解析器，带 `ref` 的 `blocked` 被拒。变异检查：未知版本回退到当前版本、任务资料改为多行输出，对应用例失败；去掉反引号转义只有转义的单元用例失败（任务资料是单行 JSON，换行已被转义，转义本身是第二道防线）。**限制与未做**：只有 producer；reviewer/smoker、补报、取消打断没有实现（见 11.4 第 3 条的合同缺口）；`service` 默认的 `compile` 仍须由调用方传入，生产接线尚未做；没有在 DEV 上用 claude haiku 与 codex luna 验证成员是否真的按模板产出被解析器接受的报告，也没有做越权诱导用例，所以“模板有效”目前只证明到“它描述的格式与解析器一致”；模板里的 git 规则靠成员遵守，实际 git 差异核验仍未做；Engine 启动时必须把 `policy.evidenceRoot` 设为仓库外的绝对目录，目前没有任何地方设置它；12) **reviewer 与 smoker 的派发和模板（2026-11-05 追加，未提交）**：`dispatch-builder.ts` 增加 `buildReviewDispatch`（绑定任务当前交付、不取新 claim、不做锁判断；拒绝同席位或同 agent、L1 同模型族、清单不能当检查 ID、DEV 目标不被门禁接受、预算缺失或耗尽、重复 ID）与 `smokeChecklistUsable`；`scheduler.ts` 增加 `eligibleReviewSeats` 与 `same-as-producer` 拒绝原因；`gates.ts` 导出 `devEndpoint`；`prompt-template.ts` 拆为 producer/reviewer/smoker 三个模板（各自 `templateVersion` 从 1 起，`templateVersionFor`），reviewer 与 smoker 的交付信息（生产者的 `baseRef`、分支、交付 ref、`changedFiles`）取自生产者已接受的证明，不取“当前”指针；DEV 目标取自冻结的 `policy.devTargets`；交付 ref 不是 `git-commit` 时编译为 `null`；`repo.ts` 增加 `deliveredFiles`（交付提交必须是 `baseRef` 的后代，`git diff --name-only` 取真实改动文件，重命名算删加两条，ref 只接受纯十六进制）；`service.ts` 的 `dispatchNext` 按任务顺序选下一份工作（生产者、reviewer、smoker），`templateVersion` 选项改为按用途取版本。reviewer/smoker 只在 HEAD 等于交付提交、分支仍是生产者的分支、工作树干净、真实 diff 与报告声称的 `changedFiles` 一致时才派发，否则以 `delivery-*` 或 `workspace-*` 阻断并留给人，不清理、不重置。新增 `tests/run-engine/{dispatch-builder-review,prompt-template-judges}.test.ts`、`support/review-run.ts`，扩充 `repo.test.ts`、`service.test.ts`、`prompt-template.test.ts`。`tests/run-engine` 加 `run-core` 共 654 例通过，全量 `npm test` 2448 通过（3 todo），`typecheck`、`verify:package` 通过，`biome` 仅 2 条既有警告。关键用例：按提示词自带字段写出的 `review-report`、`smoke-report` 经严格解析器、reducer（含 `turn-started`、`turn_ended` 回执、`turn-ended`）与门禁后任务完成；评审意见不是“可合入”时不会完成；审了别的提交、跳过清单的报告被拒；三个模板的 v1 字节各自用 SHA-256 钉住（改字节必须新增版本）。变异检查：去掉独立性检查、去掉真实 diff 核对、把审查的基准换成审查者自己的 `baseRef`，对应用例均失败。**发现**：① 去掉 `service.ts` 里“实际改动都在 write 范围内”的检查，因为质量门已拒绝范围外的 `changedFiles`（不会存成评审状态），而真实 diff 等于声称时必然在范围内，那是死代码；② 报告通过后任务要等 judge 的 `turn_ended` 才完成（`actorSettled`），所以 judge 的静止证据是完成的必要条件；③ 单个 `ready` 且无未完成依赖的 `pending` 任务会在任何 reducer 事件后被改为 `ready`，测试里要用依赖保持它 `pending`。**限制与未做**：reviewer/smoker 的补报、无法执行时的专用状态、取消打断仍属合同缺口（11.4 第 3 条）；smoker 只取第一个可用的 DEV 目标，没有选择策略；没有在 DEV 上用 claude haiku、codex luna 验证成员是否按这两个模板产出合格报告；Codex 席位仍需 `full-access` 才能可靠提交，reviewer 只读是否可在受限模式下运行未测；rework 路径与 DAG 接纳、`service` 与 Engine 启动、`policy.evidenceRoot` 的设置仍未做；`dispatchNext` 仍只能手动调用，没有触发时机；13) **rework 路径（2026-11-05 追加，未提交）**：质量门失败后任务回到 `rework`（或 `review` 加 `awaiting-rework`，等 judge 全部结束后由 reducer 推进），`dispatchNext` 对 `rework` 任务再派发生产者：`scheduler.ts` 的候选与计划把 `rework` 和 `ready` 一并视为可派发；`buildDispatch` 本就支持 `rework`（不取新 claim、沿用已有占用、`attempt` 加一）；`prompt-template.ts` 新增 `rework` 模板（v1：producer 正文加“返工说明”，上一次交付的提交与改动文件、审查者的阻断项、冒烟中失败的检查放在执行事实的 `rework.previous` 里，明确是资料不是指令，来源是账本里上一次尝试的证明与绑定到它的 judge 证明）；reviewer 模板升到 v2：返工之后的交付多一个 `taskBaseRef`（第一次尝试的起点），要求同时审“这次新增”和“整个任务累计”，v1 保持注册且字节不变；`templateVersionFor(purpose, { rework })`。服务在返工前要求分支仍是上一次交付的分支、HEAD 仍是上一次交付的提交、工作树干净，否则以 `delivery-branch-changed`、`delivery-not-at-head`、`workspace-dirty` 阻断并留给人；上一次尝试仍在评审中（`awaiting-rework`）时不派发。新增 `tests/run-engine/rework.test.ts`（8 例）、`support/judge-flow.ts`（把派发过的 assignment 按观察器的方式推进 reducer：回显、回合开始、报告、回合结束），扩充 `service.test.ts`、`prompt-template-judges.test.ts`；全量 `npm test` 2460 通过（3 todo），`typecheck`、`verify:package` 通过，`biome` 仅 2 条既有警告。关键用例：评审要求修改后任务回到 `rework`，返工派发不取新 claim、`attempts` 为 2、`reworkCount` 为 1、占用不变、预算多预扣一次；用返工提示词自带字段写出的 `task-report` 经 reducer 与门禁后任务回到 `review`，其 reviewer 的提示词带 `producerBaseRef`（这次新增的起点）与 `taskBaseRef`（整个任务的起点）；评审者的文字里伪造的围栏与区段标记留在数据行内；第一次尝试、没有上一次尝试、reviewer 用途都不能用返工模板（编译为 `null`）。变异检查：返工前不核对 HEAD 与分支、调度器不把 `rework` 当可派发、返工资料丢掉阻断项，对应用例均失败。**发现**：① 同一个 `judge-flow` 夹具里，reducer 校验 `nonce.acceptedAt` 不早于 assignment 的 `createdAt`，纯函数测试用固定的较晚时间，服务测试用真实时钟；② 返工那次的 `changedFiles`、`ref` 只描述新增提交，所以真实 diff 核验的基准是返工自己的 `baseRef`，与报告一致。**限制与未做**：返工次数到顶后的升级、D3、D4（`blocked`/`failed`）只靠 reducer 的状态，服务不做任何处理，由人决定；`reopen` 与带 `reissue` 的重发不在此路径；冒烟失败触发的返工只在单元层用 `smokes` 字段覆盖，没有真实 git 的服务用例；仍没有在 DEV 上验证成员对返工提示词的实际行为；DAG 接纳、`service` 与 Engine 启动、`policy.evidenceRoot` 的设置、`dispatchNext` 的触发时机仍未做；14) **报告入账 S1（2026-11-05 追加，未提交）**：新增 `server/run-engine/intake.ts`（`createIntake().settleAgent(agentId)`）、`shared/domain/run-engine/task-note.ts`（`noteTask`：只写 `waitingReason` 与一条 `task-note` 审计事件，不改状态、计数和占用，原因不变时是空操作）、`tests/run-engine/intake.test.ts`（13 例，真实 store 加真实观察器）。流程：找出这个 Agent 上“已发出消息、尚无已接受证明”的 assignment；用观察器读回复窗口并判定；复核归属；在同一个同步 store 更新里依次做（时间线回显证明送达则把 `sending`/`outcome-unknown` 意图转为 `confirmed`）、`turn-started`、报告、`turn-ended`，任何一步被拒就整体不提交；要求账本里已有宿主的 `turn_ended` 回执，没有则返回 `turn-not-ended` 等钩子或对账补上；报告不完整读取返回 `unverifiable` 且不写；没有块、块被拒、归属不符、reducer 拒绝只写“为什么不动”，任务状态、占用和 assignment 都不变，也不发任何消息；同一问题再次观察不增长账本；已入账的 assignment 再调用是 `no-assignment`；入账后调 `onSettled(runId)` 供派发推进接入。**发现（真实缺陷，已修）**：`service.ts` 与新代码给 reducer 的 `newId` 返回 `decision-<uuid>`，而台账要求决策 ID 是 UUID，一旦质量失败走到 D3、D4 就会整体被拒；改为直接返回 UUID，由“尝试次数耗尽开决策”的用例暴露。`tests/run-engine` 与全量 `npm test` 2473 通过（3 todo），`typecheck`、`verify:package` 通过，`biome` 仅 2 条既有警告。关键用例：报告在 `turn_ended` 之前不被接受、之后被接受；回显让未确认的发送变为已确认；评审通过则任务完成、要求修改则回到返工、尝试次数耗尽则任务冻结为 `blocked`、开决策且占用冻结；证据门不通过时任务不进评审并显示原因（`command`）。变异检查：去掉回显确认、去掉原因去重，对应用例失败。**限制与未做**：决策的控制 nonce 只留摘要、原文丢弃（决策由人按决策 ID 答复，P06 才接）；报告缺失与被拒不触发补报，任务停在当前状态等人处理（补报归 P05）；还没有任何地方在 `turn_ended` 钩子之后调用 `settleAgent`，观察器与 intake 的接线属于 S4/S5；证据退回（`evidenceReturns`）只计数，没有补证消息；15) **DAG 接纳 S2（2026-11-05 追加，未提交）**：新增 `shared/domain/run-engine/dag-admission.ts`（纯函数 `checkDag`、`describeIssues`、`DagControl` 读写、`REPO_ALIAS`、`COORDINATOR_SEAT_ID`）、`shared/domain/run-engine/run-alert.ts`（`raiseAlert`：按调用方给的 ID 去重，已开的不重复，已解决或已确认的重新打开，并写 `alert-raised` 审计事件）、`server/run-engine/dag.ts`（`createDagIntake().settleCoordinator(agentId)`）、`server/run-engine/digest.ts`（`sha256Hex`、`alertIdFor`；`shared/` 不得引入 Node，所以哈希只在 server）、`tests/run-engine/{dag-admission,dag}.test.ts` 与 `support/bootstrap-run.ts`。**规则**（与 11.5 一致）：来源（生命周期、`runId`、首版 `dagRevision` 1 且 `expectedDagRevision` 0、发送者是花名册里的 `coordinator` 席位的 Agent、控制 nonce 的摘要与账本一致且未用、首版 DAG 不带取消和预算申请）；结构（重复 ID、未知或自依赖、环）；任务（带 `irreversible` 的拒绝，因为人工批准还没接；write 任务必须有 write 范围、read 任务不能有；范围的 `repoId` 只能是规范 ID 或别名 `workspace` 并映射成规范 ID；范围路径必须能规范化；证据 ID 唯一）；花名册（produce、review 都有结构上合格的席位，且存在 seat 与 agent 都不同的组合，L1 任务要求不同模型族；`devSmoke` 要求可用清单、可用 DEV 目标、有 smoke 席位且与生产者独立）；整体（每个启用席位有预算，协调者除外）。服务端在此之外用 `verifyScopes` 做真实路径校验。**流程**：协调者的 `turn_ended` 之后，读它对最近一条已发出的计划请求（`wake` 意图）的回复窗口；没有块、块被拒或检查不过，在 Run 上写一条告警（原因是 `describeIssues` 的一行字，同一原因只记一次），生命周期从 `bootstrapping` 转为 `awaiting-dag`，控制 nonce 不作废，所以修正后的计划可以被接纳；接纳时在同一次提交里先把控制摘要标成已用，再交 reducer 的 `dag-accepted`，所以一份 DAG 只能被接纳一次；提交里按当时账本重判一遍。**合同取舍**：首个 DAG 的控制 nonce 摘要存在 `launch.dagControl`（`launch` 本来就是 passthrough，没有改 schema），因为 `nonceRegistry` 的每一项必须对应一个任务（不变式 I5），放不下它；计划请求是 `wake` 意图，而 schema 要求 `wake` 带 `taskId`，此时还没有任务，启动（S3）要用一个占位 ID（测试里用 `plan`），`semanticArgs.purpose` 写 `plan`。全量 `npm test` 2507 通过（3 todo），`typecheck`、`verify:package` 通过，`biome` 仅 2 条既有警告。关键用例：合法计划被接纳后 Run 为 `active`、t1 为 `ready`、t2 为 `pending`、范围的 `repoId` 是真实仓库 ID 而不是别名、控制已用、同一回复再处理无变化；`turn_ended` 之前不接纳；非协调者的回复不是计划；没有计划、块格式错误、路径越出仓库（`.git/config`）、点名别的仓库都被拒并写告警，同一原因不重复；被拒之后修正的计划可被接纳；读取不完整或宿主不可用不写；没有已发出的计划请求就没有东西可读。变异检查：去掉控制 nonce 检查、去掉真实路径校验，对应用例失败。**限制与未做**：被拒后不会自动要求协调者重写，需要用户触发重新规划（决定 5），而重新规划要重新签发控制 nonce，这一步属于 S3 的计划请求与 P06 的决策接线，还没有；`launch.dagControl` 的签发（S3）、`coordinator` 席位加入花名册（S3）、协调者提示词的 Engine 变体与计划请求（S5）都没做；没有任何地方在协调者 `turn_ended` 之后调用 `settleCoordinator`，也没有在接纳后调用派发；`DAG` 的修订（`dag-revised`）不在本步；Engine 不检查任务难度、层级与实际模型的匹配，只检查结构上有席位 |
| P05 | 未开始 | — | — | — |
| P06 | 未开始 | — | — | — |
| P07 | 未开始 | — | — | — |
| P08 | 未开始 | — | — | — |

记录使用待实施、实施中、已验证、受阻等明确状态。引用的历史规格若不在仓库，先把本轮需要的合同差异和验收条件落到仓库，不依赖个人 `.notes` 才能实施。

## 9. 完成条件

- [ ] M0-M4 的退出条件满足，P00-P08 均有可检查的交付与验证记录。
- [ ] 已启用 Engine 的 Team 能完成两个有依赖的真实业务任务，且质量门实际拦截无效交付。
- [ ] 程序是 Engine Run 的唯一合法派发入口，旧协调者模板不会同时派活。
- [ ] 对重复事件、响应丢失和恢复中断不虚报 exactly-once；不确定结果保持冻结并可解释。
- [ ] 协议失败、补证、质量返工、执行失败和等待人处理具有独立计数与恢复行为。
- [ ] 取消前后都有证据；没有因超时或请求已发出而提前释放冲突资源。
- [ ] 没有事件或到期工作时无模型轮询；战略唤醒只来自明确决策点和结束条件。
- [ ] 第 7 节 AC01-AC22 全部有测试或 DEV 证据，失败和未支持分支无隐瞒。
- [ ] Runs 页能回答“为什么等待、谁来解除、下一步何时或由什么触发”。
- [ ] 旧 Run、Role/Profile 解析及已退役模式的兼容行为通过回归验证。
- [ ] 使用说明、恢复限制、启用/停新运行策略更新；本轮临时产物已清理。

不以“文件已写好”“单测全部绿色”或“正常路径跑过一次”单独宣布完成。Token、耗时和返工改善先记录同任务、同 Profile 条件下的可比数据；没有对照证据时不宣称收益百分比。

## 10. 参考材料

- [长期路线图](orchestration-roadmap.md)、[历史待办](backlog.md)。
- [现有验收夹具矩阵](../paseo-agent-team/tests/spec/run-engine-matrix.md)。
- [当前产品行为与旧模式兼容说明](../paseo-agent-team/README.md)。
- Agent Autoloop 固定提交：`8f8e2eef3cfaa8f7a418818adc442450fe6bd884`。
- [上游协议](https://github.com/KKKKhazix/agent-autoloop/blob/8f8e2eef3cfaa8f7a418818adc442450fe6bd884/docs/protocol.md)。
- [上游决策内核](https://github.com/KKKKhazix/agent-autoloop/blob/8f8e2eef3cfaa8f7a418818adc442450fe6bd884/kernel/decide.ts)、[事务存储](https://github.com/KKKKhazix/agent-autoloop/blob/8f8e2eef3cfaa8f7a418818adc442450fe6bd884/kernel/store.ts)。
- [上游 Worker 恢复与报告修复](https://github.com/KKKKhazix/agent-autoloop/blob/8f8e2eef3cfaa8f7a418818adc442450fe6bd884/worker/worker.ts)、[报告合同](https://github.com/KKKKhazix/agent-autoloop/blob/8f8e2eef3cfaa8f7a418818adc442450fe6bd884/worker/contract.ts)。
- [上游故障模拟](https://github.com/KKKKhazix/agent-autoloop/blob/8f8e2eef3cfaa8f7a418818adc442450fe6bd884/sim/random.ts)、[独立重放与不变式检查](https://github.com/KKKKhazix/agent-autoloop/blob/8f8e2eef3cfaa8f7a418818adc442450fe6bd884/sim/invariants.ts)。

## 11. 实施记录

### 11.1 P00 宿主能力矩阵（2026-11-05，静态查证）

依据：`@getpaseo/plugin`、`@getpaseo/client`、`@getpaseo/protocol` 均为 `0.13.0-beta.1` 的类型声明；插件清单要求 `paseo >=0.12.0`，两者存在版本差，需在 DEV 上确认。下表“静态”只表示类型里存在，不代表运行行为已验证。

| 能力 | 静态结论 | 依据 | 对本轮的约束 |
| --- | --- | --- | --- |
| 发送消息 | 可用。`agents.ref(id).send(text, options)`，`options.messageId` 可由调用方指定，返回 `void` | `client/dist/index.d.ts`、`SendMessageOptions` | 派发时由程序生成 `messageId` 并写入 Outbox 意图；响应丢失后用该 id 查 timeline。本项目 `PaseoPort.send(text)` 目前不透传选项，需要扩展 |
| 在途回合时的行为 | `activeTurnBehavior` 为 `interrupt` 或 `steer`，缺省由守护进程打断当前回合 | `protocol/dist/messages.d.ts` | 派发和补报必须显式指定，不能依赖缺省，否则会打断成员正在做的工作 |
| 创建成员与幂等 | `agents.create` / `workspaces.ref().agents.create` 支持 `idempotencyKey`、`agentId`、`labels`、`clientMessageId` | `PaseoAgentCreateOptions` | 可用 runId+seatId 派生 key 与 label 做创建查证；本项目 `PortAgentCreateOptions` 未透传 `idempotencyKey`，需扩展。幂等语义待 V2 |
| 结束事件 | `agent.turn_ended` 带 `turnId` 与 `outcome`（completed / failed / canceled）；事件里 `timeline` 已废弃且恒为空；事件不带 labels | `plugin/dist/server/lifecycle.d.ts` | 归属必须查台账（与 designer 的做法一致）；报告必须从 timeline 取回，不能读事件体 |
| 其他 hook | `agent.created`、`agent.closed`、`agent.archived`、`agent.permission_requested`、`agent.permission_resolved`、`agent.turn_started` | 同上 | 权限请求和 Agent 关闭可事件化；hook 投递是否有序、是否至少一次待 V3 |
| timeline 分页 | `agents.ref(id).timeline.refetch({direction: tail|before|after, cursor, limit, projection})`；响应含 `window`、`startCursor/endCursor`、`hasOlder/hasNewer`、`gap`、`staleCursor`、`reset`、`epoch` | `FetchAgentTimelinePayload` | 观察器必须处理 `gap`、`staleCursor`、`reset` 与 epoch 变化；分页未走完不能当作“没有报告” |
| timeline 条目 | `user_message` 与 `assistant_message` 带可选 `messageId`；条目带 `turnId`、`timestamp`、`seqStart/seqEnd` | `AgentTimelineItem` | 派发对账依赖 `user_message.messageId` 回显，待 V1；`messageId` 可选，缺失时降级为冻结 |
| 停止在途执行 | **插件 API 不提供。** `PaseoApi` 的 agent handle 只有 `send`、`run`、`waitForFinish`、`respondToPermission`、`archive`、`detach`；`cancelAgent` 只在底层 `DaemonClient` 上，`PaseoApi` 未暴露 | `client/dist/index.d.ts`、`daemon-client.d.ts:947` | 取消只能以 `send(..., {activeTurnBehavior: "interrupt"})` 发出打断请求，再用 `turn_ended.outcome=canceled` 与 `status/activeTurn` 核对静止；`archive` 不当作停止证据。拿不到证据就保持冻结 |
| 限制单个 Agent 的工具 | **不能。** `toolPolicy` 仅有 `preapproved: McpToolRef[]`（预批准某些 MCP 工具），没有 deny 或 allow-list | `protocol/dist/agent-types.d.ts:448` | 无法在宿主层禁止协调者继续委派；按 4.1 节只声明“Engine 保证自己派发的任务”，外部派活进入异常核对（AC20） |
| 权限 | `respondToPermission` 与 `pendingPermissions` 存在 | `PaseoAgentHandle` | 本轮不自行答权限（4.3 节）；只读取与展示 |
| 成员状态 | `status`: initializing / idle / running / error / closed；`activeTurn`、`lastError`、`pendingPermissions` | `PaseoAgent` | 对账用的最小事实集合 |
| 启用配置 | `RunTeamEngineConfigSchema` 存在，但仅被测试引用；`TeamSchema` 是 `passthrough`，`runEngine` 字段不会被校验或类型化，Team 编辑器与启动链路均不读取 | `shared/schemas/run-engine/config.ts`、`shared/schemas/team.ts` | P04/P07 需要先把 `Team.runEngine` 接入 Team 合同并补兼容用例；“启用但配置无效则阻断”目前没有任何代码执行 |
| 服务端接线 | `index.server.ts` 没有 `run.*` RPC、无台账初始化、无 `agent.*` Engine hook；`LAUNCH_RUNTIME_CAPABILITIES` 未声明 Engine | `index.server.ts` | 全部属于 P01-P04 新增 |

### 11.2 待在独立 DEV 上执行的运行时探针

在这些探针出结果前，上表对应行不得当作已验证。探针项目放仓库外，结束后清理。

| 编号 | 问题 | 通过后的结论 | 失败后的降级 |
| --- | --- | --- | --- |
| V1 | `send` 带 `messageId` 后，timeline 的 `user_message.messageId` 是否回显；重复 `messageId` 是否去重 | 发送对账可证明“已送达/未送达” | 只能靠文本 nonce 匹配；对账弱，超时一律 `outcome-unknown` 并冻结 |
| V2 | 同一 `idempotencyKey` 重复 `create` 是否返回同一 Agent | 创建结果不明可安全重试 | 只按 label 查证；不重试创建，找不到则冻结并报告 |
| V3 | `turn_ended` 与 timeline 可读性的先后；hook 是否会重复、乱序、在插件重启期间丢失 | 观察器按设计去重并补对账 | 增加启动与定时全量对账，不依赖 hook 单独推进 |
| V4 | `interrupt` 后 `turn_ended` 是否为 `canceled`，`status` 多久回到 idle | 取消有静止证据 | 取消保持“已请求未证实”，资源不释放 |
| V5 | 两种 Provider 下 `steer` 与 `interrupt` 的实际行为（含 Windows 路径） | 可选择补报用的 `activeTurnBehavior` | 补报只在成员 idle 时发送 |
| V6 | `0.12.x` 与 `0.13.0-beta.1` 对上述 API 的差异；插件重启期间 hook 缓冲 | 能力声明可按版本分档 | 声明最低支持版本并阻断更低版本启用 Engine |

#### 探针结果（2026-11-05，DEV daemon `0.13.0-beta.1`，claude/claude-haiku-5-5 与 codex/gpt-6-luna）

探针脚本在仓库外，通过 `createPaseoClient` 直连 DEV host，而不是在插件 hook 上下文里运行；探针 Agent 已删除，临时目录已清理。结论只覆盖下列条件。

| 编号 | 状态 | 观察到的事实 | 对设计的影响 |
| --- | --- | --- | --- |
| V1 | 部分通过 | `send` 带 `messageId` 后，timeline 的 `user_message` 同时回显 `messageId` 与 `clientMessageId`，并带 `turnId`。Agent 空闲时用同一 `messageId` 再发一次，未报错，timeline 仍只有一条 `user_message`，窗口未增长，没有新回合 | 发送对账可用 `messageId` 证明“已送达”。V3 补充：回合进行中以同一 `messageId` 但选项不同重发，返回 `agent_request_key_conflict`，所以重发必须用与原请求完全相同的参数，且错误要按“已存在”而非“失败”处理。未验证：回合进行中参数完全相同的重发、跨插件重启 |
| V2 | 部分通过 | 相同 `idempotencyKey`、相同配置的第二次 `create` 返回同一个 Agent id | 创建结果不明时可用同 key 查证。未验证：key 相同但参数不同时的行为，以及 key 的保留时长 |
| V3 | 部分通过 | 在 DEV 上装了仓库外的临时探针插件，注册 7 个 `agent.*` hook。两个 Provider 各跑正常回合与被 `interrupt` 打断的回合：hook 按 created → turn_started → turn_ended 的顺序到达，每个事件各 1 次，没有重复或乱序；`turn_ended` 事件的内嵌 `timeline` 恒为空（与类型注释一致），但在 hook 内用 `timeline.refetch` 已能读到该回合最终的 `assistant_message`，`gap=false`；事件不带 labels。被打断的旧回合收到 `turn_ended` 的 `outcome={kind:"canceled"}`（reason：claude 为 `Interrupted`，codex 为 `interrupted`）。被打断回合已产生的部分输出保留在 timeline 中。回合进行中以同一 `messageId` 但不同选项（加了 `activeTurnBehavior`）重发，返回 `agent_request_key_conflict` | 观察器可以在 `turn_ended` 里直接对账读取报告。**`turn_ended` 不等于静止**：claude 的 `canceled` 事件到达时新回合已开始（`status=running`、`activeTurn` 为新回合）；codex 到达时 `status` 仍为 `running`、`activeTurn` 暂为空，约 50ms 后新回合开始。所以静止证据必须是“最新回合的 `turn_ended` 已到达且 `status=idle`、`activeTurn=null`”，不能看旧回合的 `canceled`。未验证：同一 hook 重复投递、插件重启期间的 hook 丢失与补投、hook 处理变慢时的背压 |
| V4 | 部分通过，且改变了设计前提 | 两个 Provider 上，`interrupt` 都是“打断并用新的 prompt 开一个新回合”（旧回合 `foreground-turn-1`，新消息落在 `foreground-turn-2`）；新回合结束后 `status=idle`、`activeTurn=null`。8-12 秒内回到静止。没有不带 prompt 的纯取消。（V3 在 hook 内补充：旧回合确有 `turn_ended` 的 `canceled` 事件，上一版“未观察到”的说法已更正，原因是直连客户端探针看不到 hook 事件） | 取消 = 发一条打断消息，会产生一次模型调用；静止证据取“新回合的 `turn_ended` 已到达且 `status=idle`、`activeTurn=null`”。旧回合的 `canceled` 只证明“旧回合已被打断”，不能作为静止依据 |
| V5 | 部分通过 | `interrupt`：两个 Provider 行为一致。`steer`：claude 上第二条消息并入同一回合（`m3`、`m4` 同属 `foreground-turn-3`）；codex 上 `steer` 后 Agent 仍在运行，但本次输出被截断，未确认消息归入哪个回合。cwd 使用 Windows 临时路径，均正常 | 补报和派发需显式指定 `activeTurnBehavior`；codex 的 `steer` 语义未确认前，两种 Provider 的补报都只在成员 `idle` 时发送 |
| V6 | 未执行 | 只有 `0.13.0-beta.1` 可用，未取得 `0.12.x` | 需另装旧版 daemon；未执行前，能力声明只承诺 `0.13.0-beta.1` |
| V7 | 部分通过（2026-11-05，DEV daemon `0.13.0-beta.1`，仓库外的临时 git 仓库带两个 worktree，每项单次样本，席位 cwd 为主目录，提示词写明 worktree 绝对路径） | **Claude**（`claude-haiku-5-5`，`auto`）：在 `wt-a` 建文件并提交，主目录未被改动；同一席位用 `send` 改派到 `wt-b`，不带 `-C` 的 `git add -A`/`git commit` 落在 `task-b`。`default` 模式停在权限请求，对照组在自己 cwd 写文件同样停，权限来自模式而非 worktree。**Codex**（`gpt-6-luna`）：`auto` 停在权限请求（对照组同样）；`auto-review` 下文件写进了 `wt-a`，但 `git add/commit` 失败，对照组在自己 cwd 里也失败（shell 默认目录是 `C:\`，并报目录所有权错误），是 Windows 沙箱问题不是 worktree 问题；`full-access` 下在 `wt-b` 提交到 `task-b` 成功，同一席位改派到 `wt-a` 也成功。旁证：`auto-review` 那次失败在 `wt-a` 留下无主未跟踪文件，之后一次 `git add -A` 把它卷进了无关提交。`~/.codex/config.toml` 的 `node_repl` 条目（magpie 改写为 `url` 后仍带 `env_vars`）曾使 Codex 席位启动失败，已删除该行（备份在同目录），属环境问题 | 席位能被派到别的 worktree 工作，但席位默认 cwd 仍是主目录，是否进入正确目录只靠提示词，不是强制。Codex 在 worktree 里可靠提交只在 `full-access` 下观察到，见 11.4 第 1 条。共享目录的“提交卷入别人文件”已有实例。未验证：omp、并行 Git 争用、席位会话续接是否受 cwd 影响、不写目录或只写相对路径时是否误落主目录、Codex 其他模式、每任务新建 worktree 工作区加 agent（`paseo run --new-workspace worktree`，与有限席位冲突，未测）。DEV 里遗留若干名为 `main`、指向已删除临时目录的工作区，CLI 无删除命令，需在 DEV 网页界面清理 |

### 11.3 M0 差异清单（最小）

1. ~~`PaseoPort` / `PortAgentCreateOptions` 缺 `messageId`、`activeTurnBehavior`、`idempotencyKey`、`timeline.refetch`、`current()/refresh()` 的窄接口~~ 已补（见 P04 记录）。启动路径的 `PortAgentHandle` 仍只有 `send`/`archive`，读取能力放在单独的 `PortEngineAgentHandle`，所以启动代码依然观察不到 timeline。
2. ~~`Team.runEngine` 未接入 Team 合同与启动校验~~ 合同与启动阻断已接（见 P04 记录）；编辑器界面仍缺，归 P07。
3. `server/run-engine/` 与 Engine RPC/hook 注册全部缺失；`launch-runtime.ts` 未声明 Engine 能力。
4. backlog 4b（Profile/model 投影）**已复核（2026-11-05）**：不是适配器缺陷，指向 Profile 数据（宿主按第一个 `/` 拆 `provider/model`；Profile 的 `model` 自带 `codex/` 前缀才会得到带前缀的 model）。当前代码经启动 RPC 在 DEV 启动 `e2e-team`，成员 `config.model` 无前缀；三种 provider 串的拆分结果见 `docs/backlog.md` 4b。**P04 不再被它阻断**；遗留：`0.15.0` 未验证，预览警告未做。下面是复核前的初步记录，保留作过程：
   - 适配器把 Profile 投影为宿主文档约定的 `provider/model` 字符串（`shared/paseo/adapter.ts` 的 `profileProvider`），经 `workspaces.ref().agents.create` 传入。
   - DEV 上的探针用同样的字符串经 `agents.create` 创建 `codex/gpt-6-luna`，会话正常运行；10 月 23 日由团队启动创建的 Codex 成员，宿主记录的 `Model` 为 `gpt-6-luna`，没有 provider 前缀。
   - 所以在 `0.13.0-beta.1` + `gpt-6-luna` 下没有复现。backlog 里的失败样本是 `gpt-6.1-sol`，宿主版本也可能不同，当前 DEV 没有这个 Profile。
   - 未复核：用当前代码重新发起一次团队启动并检查每个成员的 `model`；`gpt-6.1-sol` 一类 Profile。这一项在 P04 前仍必须完成，不得据此判定缺陷不存在。
5. `tests/spec/run-engine-matrix.md` 仅是夹具索引；AC01-AC22 暂无一项有服务级证据。

### 11.4 P04 派发侧的待决设计点（2026-11-05）

Outbox 执行器只消费已 `prepared` 的意图。生成这些意图的“派发事件构造器”不存在：`task-dispatched` 要求调用方事先拼好完整的 `assignment`、`nonce`、`intent` 与 `claims`，reducer 只校验、不生成。动手前需要定下以下几点；其中带 ★ 的会改变用户可见行为或合同，按“合同变更先落实”处理。

1. ★ **每个 assignment 的工作区策略：已决定，分阶段方案 C（2026-11-05，用户采纳；先暂记方案 B，后经调研、V7 探针与独立裁决修正）。**
   - **M2：** 整个 Run 使用启动 Workspace，不创建每任务 worktree，也不新增 `create-workspace` 意图；`dispatchLabels` 的分支名生成在 M2 不使用。同一 Git 仓库内，所有 Engine 受控的实现、审查和冒烟**按任务全过程串行**：跨 Run 通过同一权威资源登记原子授予仓库排他锁，直到任务完成且相关执行者静止。仓库身份须经真实路径和别名校验（见第 4 条）。派发前要求真实分支、基准和干净工作树。写任务以完整 Git commit SHA 交付，程序按基准与提交的实际差异核对范围；审查和冒烟绑定该 ref，开始前后核验工作树与 HEAD。脏文件、未受理提交或未知结果一律冻结并核对，不自动清理、重置或重派。**锁只约束 Engine 自身，不能阻止外部写入；提示词不是强制隔离。** 非 git Workspace 阻断启动（`branch` 与 `baseRef` 必须来自真实 git 状态）。
   - **M2 的用户可见行为（用户已接受默认）：** Engine 直接在启动 Workspace 的**当前分支**产生提交，待审或未通过门禁的提交也可能留在那里；是否改用专用启动分支或 Workspace 留给启动时选择，不在 M2 新增分支管理。
   - **M3 起的并行升级（有准入条件，条件不满足就保持 M2 串行）：** 运行级集成分支加每任务一个 worktree；粒度是任务而不是尝试，返工沿用任务分支；依赖任务从已通过集成验证的最新集成头开始（Claude Code 的 worktree 默认从远端默认分支创建，必须显式指定起点）。生产者审查和必要冒烟通过后，在串行合并槽里由程序生成并测试合并候选，发布成功且**最终** `doneGate` 通过后才标记完成并放行依赖；冲突转为决策点；产物变化后对新 ref 重走相关门禁。创建、合并和发布须有持久化意图与恢复核对，结果不明时冻结。集成分支如何交回启动分支，启用该路径前再定。
   - **并行升级的准入条件：** 先完成相关合同、状态机和兼容性变更（见下方实现约束），并补探针：任务 Workspace 中席位的实际 shell cwd、相对路径与 Git 操作、会话续接、omp、并行 Git 争用、Codex 各模式。现有 roster 的固定 `agentId` 还参与历史证明校验，若改为任务级 Agent，不能只替换该 ID。
   - **`RunAssignment.workspace`** 保持每个 assignment 一个值的形状，需要工作区的业务 assignment 填写真实值（M2 中多个 assignment 的值可以相同），以便并行阶段直接替换。
   - **席位限制（V7，见 11.2）：** Codex 席位在 Windows 沙箱模式（`auto`、`auto-review`）下无法可靠提交，只有 `full-access` 通过。M2 默认不自动提权、不代答权限：Codex 可在权限和职责允许时承担审查；需要它提交时，仅使用用户事先明确配置的 `full-access`，否则等待或选择合格席位。不得把单次样本推广为“所有 Codex 环境都只能 `full-access`”。
   - **实现约束（已对照代码核实）：**
     - `normalizeLogicalPath` 拒绝 `.`（返回 `empty`），仓库根不能用 `.` 表示；仓库级独占需要专用的命名资源（`hot` 或 `tool` 类，只与同 `kind` 同名资源冲突）。所有受控参与者必须使用同一个仓库资源名。
     - `findLockConflicts` 对“同 `taskId` 且未冻结”的占用直接跳过；跨 Run 的同名 `taskId` 不能因此被豁免，构造器必须用 `otherResources` 单独判断。
     - 只靠 `configuredConcurrency = 1` 不够：执行槽目前不覆盖普通审查阶段，必须靠上面的仓库锁串行。
     - `recomputeDone` 在 `doneGate` 通过时立即置 `done` 并释放占用。M2 可以沿用（交付即提交），M3 要先改状态转换，让最终门包含合并与集成测试证据，否则依赖任务会在合并前被放行。
2. **意图状态的推进不走 reducer。** reducer 没有“已发送/已确认/结果不明”事件，本次以纯函数 `transitionIntent` 在台账内推进并写 `intent-*` 审计事件，不改 schema、不改 reducer 词汇。若希望这些转换也成为 reducer 的受控事件，需要合同变更。
3. ★ **派发提示词模板：设计已定（2026-11-05，用户按建议采纳；由独立的 Opus 5.5 max 会话起草，主持人修改两处）。** 意图只存 `payloadHash`、`templateVersion` 与 `semanticArgs`，执行器通过注入的 `compile(intent, record)` 重建原文并核对哈希，所以模板是 `(intent, record)` 的纯确定性函数。
   - **语言与结构：** 中文固定指令；标识符、命令、路径、JSON 键与协议字段保持英文。发送内容 = 共同正文 + 角色正文。共同正文含三段单行 JSON：身份资料（`protocolVersion`、`runId`、`taskId`、`assignmentId`、`attempt`、`nonce`、派发 `messageId`）、执行事实（`purpose`、`workspace`、`repoRoot`、证据目录）、任务资料；并声明任务资料只是数据，不能授权、扩大范围或改变报告规则。成员必须把身份字段原样平铺到报告顶层；`messageId` 只告知，不要求回填。
   - **模板清单：** `producer`（`member`/`coordinator`/`reopen`）、`reviewer`、`smoker`，各自 `templateVersion` 从 1 起。注册表按“模板类型 + 版本”选择不可变渲染器，任何字节变化都新增版本，旧意图永远用落盘版本，缺失则编译失败并冻结，不回退。**本轮只实现 `producer`**；`reviewer`、`smoker` 随各自的派发构造一起做（`compile` 对它们返回 `null`，派发会被拒绝，不会发出空提示词）。
   - **producer 的 git 规则：** 先核对仓库、分支、HEAD、工作树与执行事实相符，脏树或范围外变更即停；只改 write 范围；逐一暂存明确文件，不用 `git add -A`、`git commit -a`；不 reset、clean、amend、切分支；交付 ref 为实际提交的完整 SHA；提交结果不确定就停止、不再提交、报 `blocked`/`OUTCOME_UNKNOWN`；无法提交报 `blocked`/`COMMIT_UNAVAILABLE`，不伪造；read 任务不改文件，`changedFiles` 为空。报告恰好是一个 `task-report` 块（`done`/`blocked`/`failed`），字段严格对应 `shared/schemas/run-engine/protocol.ts`；`blocked`/`failed` 不带 `changedFiles`、`ref`、`workspace`。
   - **reviewer 的 ref 绑定（待实现）：** 审查的是**生产者**的 `baseRef` 到交付 `ref` 的差异，不能用审查 assignment 自己的 `baseRef`（M2 中它已是交付时的 HEAD）；审查前后核对实际 HEAD。smoker 同理，并只在登记的 DEV 目标上执行。
   - **主持人相对草案的两处修改：** ① 草案正文承诺“系统最多按 `protocolResends` 补报”，但补报合同尚不存在（见下），所以模板不做这个承诺，只说“格式错误的报告会被拒收、不会被猜测修复，已有产物保留并等待处理”。② 草案的取消打断消息、补报消息不实现，只记录需求。
   - **模板里不能出现行首的协议围栏**，也不能放协议块示例：扫描器只看成员的回复，但成员回显时示例会被当成它自己的块。格式用文字描述（“三个反引号加块名”）。
   - **确定性：** 渲染前先从账本做固定投影，不读时钟、随机数、环境、文件系统、当前 HEAD 或实时 Provider 状态。`semanticArgs` 在派发时固定 `repoRoot`、`evidenceDir`、`taskSnapshot`（任务资料的实际显示字段）。序列化：只允许 JSON 值，对象键按 UTF-16 码元排序，数组保序，`<`、`>`、反引号、U+2028/U+2029 转义，不做 Unicode 归一化；UTF-8、LF、固定末尾换行；任务资料整体单行，避免资料里的换行制造伪围栏。`compile` 不得依赖 `payloadHash`。
   - **证据目录（用户已同意）：** 质量门要求 `artifactPath`/`evidencePath` 以 `policy.evidenceRoot` 为前缀（纯字符串比较）。若根目录是仓库里的相对路径，成员写的日志会让工作树变脏。所以 Engine 启动时必须把 `policy.evidenceRoot` 设为**仓库之外的绝对目录**；派发前服务创建 `<evidenceRoot>/<assignmentId>` 并核对其真实路径不在仓库内，否则以 `evidence-root-invalid` 阻断。成员的所有产物写在这个目录下，报告用该目录下的路径。这是仓库源码范围之外的有限写入位置。
   - **冒烟清单准入（DAG 接纳时实现）：** 清单字符串直接当检查 ID，而任务 schema 允许空、重复和超过 64 字符，报告却要求至少一项、唯一、≤64。M2 在接纳时拒绝这类任务。
   - **不在本轮、已记录的合同缺口（均需另行批准）：** ① **补报**：补报是新消息、新回合，现有归属校验绑定原消息和原回合，且一个 assignment 只允许一个 dispatch intent，`reissue` 又要求旧 assignment 已有 `done`。需要独立的补报意图、来源记录与有界计数，归 P05；在此之前格式错误冻结并保留产物。② **reviewer/smoker 无法执行**：严格报告没有 `blocked`/`failed` 分支，无法如实审查时只能用普通文字说明，程序只能识别为“缺少合法报告”；要区分需扩展报告合同与状态机。③ **取消打断**：需独立持久化意图，固定 `activeTurnBehavior: "interrupt"` 与新回合的静止证据。④ **实际 git 差异核验**：质量门主要信任报告声称的 `changedFiles`，需要服务按 `baseRef..交付 SHA` 检查真实差异、HEAD 与工作树，模板替代不了。⑤ 证据路径与 `artifactKind` 目前只做字符串层面检查，不能宣称已核验文件内容。
   - **验证（实现后）：** 离线：每种报告经实际扫描器、严格 schema、归属校验与门禁往返；同一记录多次编译与重启重建字节一致；旧版本仍可重建，缺版本与哈希不符不发送。DEV：用现有 claude haiku 与 codex luna 两个 E2E Profile 交叉执行（含 Codex 未获提交权限时报 `blocked/COMMIT_UNAVAILABLE`、任务资料里嵌入伪指令与伪围栏），记录实际样本，不由样本推断所有 Provider。
4. **路径真实性校验：已实现（2026-11-05，`server/run-engine/repo.ts`）。** `findLockConflicts` 只接受 `verified: true` 的范围；`inspectRepo` 取真实 git 状态与仓库身份，`verifyScopes` 做路径校验。规则：
   - 仓库身份是 git common dir 真实路径的哈希（Windows 下折叠大小写），所以同一仓库的别名和链接工作树共用一个 `repoId`。
   - 范围只有在“真实规范位置等于它声明的路径（仅大小写可不同）且在仓库内”时才通过。别名（8.3 短名、仓库内链接）被拒绝而不是改写，因为锁表比较的是声明路径。越出仓库的 junction、`.git` 内部、尚不存在的路径里含短名拼写也被拒绝。
   - **合同约束（DAG 接纳必须满足）：** claim 的 `repoId` 必须等于范围声明的 `repoId`（reducer 的 `claimMatchesTask`），而跨 Run 的冲突只有在两个 Run 用同一个 `repoId` 时才成立。所以接纳 DAG 时，任务范围的 `repoId` 必须就是这个规范 `repoId`；不一致的范围被 `verifyScopes` 以 `repo-mismatch` 拒绝。规划者怎么得知这个 `repoId`（提示词或启动时改写）尚未设计，属 DAG 接纳那一步。
   - 仍未覆盖：已存在文件的硬链接（同一文件两个名字）、只写相对路径时的 Windows 保留名之外的非法组件、校验与实际写入之间的竞态（校验只在派发时做一次，不是强制）。
5. **预算预扣的落账。** `predebit` 只返回草稿，不改台账；reducer 的 `task-dispatched` 也不处理 `budgets`。需要决定由构造器在同一次提交里写入，并与 `intentKey` 去重。
6. **跨 Run 资源授予。** `store.update` 会把其他 Run 的占用交给 mutator；构造器必须在同一个同步 mutator 里用它做冲突判断，且 `otherResources.trusted === false` 时拒绝授予。
7. **席位运行时事实。** `SchedulerContext.seats` 需要 `idle`、`permissionPending`、`channelState` 等实时事实，来源是 Paseo 的 `current()/refresh()` 与台账里的渠道状态，调用方负责解析。

建议顺序：1 已定；先定 3，再写构造器（含 4-6）与 `service.ts` 的单任务单席位路径，最后接 DAG 接纳。

### 11.5 Engine 启动、报告入账与 DAG 接纳的设计（2026-11-05，用户按建议采纳）

**前置缺口：报告入账。** 观察器只记 `observation-recorded` 回执，`inspectReport` 只判定不写入；把观察到的回合和协议块变成 reducer 事件（`turn-started`、报告、`turn-ended`）的一步原先不存在，没有它派出去的任务永远不会完成。排在启动和 DAG 之前。

**分步（每步独立可测）：**

| 步 | 内容 | 状态 |
| --- | --- | --- |
| S1 | 报告入账：`turn_ended` 之后读回复窗口、提取块、核对归属，一次提交 `turn-started`、报告、`turn-ended`；块缺失、被拒、归属不符、证据退回都不推进，原因写到任务的 `waitingReason` 并留审计事件，补报归 P05 | 已做，见第 8 节 |
| S2 | DAG 接纳（规则见下） | 已做，见第 8 节 |
| S4 | 派发推进：事件驱动的 `kick(runId)`，同一 Run 串行、合并重复触发，循环到空闲、等待或阻断；触发点是 DAG 接纳后、每次入账后、启动恢复时，没有定时轮询；`blocked` 的原因写入任务的 `waitingReason` | 待做 |
| S3 | Run 创建与启动：启动前提交记录（`launch.state` 依次 `preparing`、`creating`、`kickoff-pending`、`running`）；成员创建带 `idempotencyKey`（V2：同 key 同配置返回同一 Agent），结果不明先查证不重建；计划请求走 Outbox 的 `wake` 意图，执行器要从只支持 `dispatch` 扩到 `wake` | 待做 |
| S5 | 接线：`index.server.ts` 建服务，`runEngineSupported` 改为真；协调者系统提示词的 Engine 变体（只规划、不派活）与“计划请求”提示词，需用户评审 | 待做 |
| S6 | DEV 真实场景：claude haiku 加 codex luna，两个有依赖的任务 | 待做 |

**决定：**

1. 协调者由 Engine 自动加入花名册，固定席位 `coordinator`（层级 S、职责 `coordinate`）；Team 配置的 `seats` 只列成员，不改“席位与成员一一对应”的启动校验。
2. 规范 `repoId` 是 24 位哈希，不让模型抄写：计划请求约定别名 `workspace`，接纳时把这个唯一合法的别名映射成规范 ID，其他值一律拒绝；映射规则明文写进提示词与接纳诊断。
3. `policy.evidenceRoot` 在 Team 配置留空时，Engine 按 Run 生成 `<PASEO_HOME>/agent-team-evidence/<runId>`；配置了就用配置的，但同样必须在仓库之外。
4. 席位到 Profile 的映射不新增字段：用 `launch.modelPlan` 里冻结的基础数据重建，模型族用现有 `model-family` 推断。
5. DAG 被拒时：生命周期留在 `awaiting-dag`，原因写成可见告警，不自动要求协调者重写；用户用已有的 `replan` 决定重新触发。自动补报属于补报合同，归 P05。

**DAG 接纳规则（程序检查，不靠提示词）：**

- 来源：发送者必须是协调者席位的 Agent；控制 nonce 有效且未用（启动时往 `nonceRegistry` 登记 `taskId` 为 `_dag`、`assignmentId` 为空的条目）；生命周期是 `bootstrapping` 或 `awaiting-dag`，`dagRevision` 为 1。
- 结构：依赖都存在且无环，任务数与字节容量不超限。
- 范围：每个 scope 的 `repoId` 是规范 ID 或别名 `workspace`；用 `verifyScopes` 做真实路径校验，不可校验的在接纳时拒绝。
- 可执行性：每个任务的 produce、review 在花名册里都有结构上合格的席位，且存在与生产者不同的 reviewer 席位，L1 任务另需不同模型族的 reviewer；`devSmoke` 任务的清单必须可用（非空、唯一、≤64 字符），并有带 smoke 职责的席位和合格的 DEV 目标；每个启用席位都有预算。

**启动前阻断（预览里就显示）：** 目标 Workspace 必须是 git 仓库、分支未游离、工作树干净；`evidenceRoot` 必须在仓库外且为绝对路径；带 produce 职责的席位若是 Codex 且不是 `full-access`，给警告（V7）；每个启用席位都能解析到 Profile。

**合同取舍：** 席位 `agentId` 回填、`waitingReason` 与任务备注写入、意图推进都不经过 reducer，做成受控的纯函数并写审计事件，不改 schema、不改 reducer 词汇。Team 编辑器没有 `runEngine` 界面（P07），在此之前只能手工改 Team 的 JSON 启用，M2 的 DEV 验收也这样做。

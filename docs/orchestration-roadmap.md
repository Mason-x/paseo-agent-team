# Paseo Agent Team：分层编排与确定性治理路线图

2026-10-27 起草，供下一轮 Agent Team 迭代使用。已与 `docs/next-iteration-role-tiering.md`（难度与层级）、`docs/backlog.md`（待修与未完成项）合并考虑；三者冲突时以本文件为准。

## 1. 目标与原则

目标：构建一套**可靠、自主、高效、可治理**的多 Coding Agent 协作系统。在拥有自主协作能力的同时，具备明确的控制边界。

四个基本原则（人的要求）：
1. **Paseo 作为基础设施**：继续负责 Agent Harness 接入、生命周期管理、通信、工作区和运行状态。
2. **LLM 负责智能决策**：由高能力模型完成需求分析、任务拆分、全局规划、架构决策、冲突分析和重新规划。
3. **确定性程序负责系统治理**：任务状态、权限、资源锁、并发、预算和质量门禁，由程序强制执行。
4. **SOTA 模型按需调用**：复杂决策优先使用强模型；常规调度避免不必要的 LLM 调用。

系统质量取决于三者的乘积：**Orchestrator 的模型能力 × 协作协议的质量 × 治理机制的可靠性**。

### 编排职责一分为二
- **Strategic Orchestrator（战略编排）**：理解用户目标、分析代码库、拆分任务 DAG、决定执行顺序、解决架构分歧、失败后重新规划。这部分非常值得使用 SOTA，Claude-Opus-5.5-Max 在这一层优势明显。
- **Operational Orchestrator（运行调度）**：分配已就绪的任务、检测 Worker 状态、续租、执行重试策略、管理并发和任务锁。GPT-6.1-Sol Max 在这一层的成本优势突出。不过 2026-10-27 起，Cursor 渠道 Grok 的额度充足、其他模型即将耗尽，过渡期改由 Grok-4.6（Cursor）担任，Sol Max 作为备选。
- 这样分工后，SOTA 的 token 消耗不会随 Worker 的每一次心跳或状态更新而增加。

## 2. 外部依据

Anthropic，2026-08《Patterns and problems in emerging multiagent systems》：

| 发现 | 对本项目的含义 |
| --- | --- |
| 可拆成独立子问题时，多 agent 有收益；依赖紧密的任务随规模增大，合并率下降，表现最好的模型靠隔离各自的工作来避免冲突 | DAG 必须写明依赖和文件边界；热点文件串行；并行只用于真正独立的任务 |
| 协调不会因为个体更强或对齐更好而自然出现；角色提示、"CEO"提示几乎不改变结果 | 结构要靠程序强制，不能只靠提示词 |
| 共享的有限资源会被轮询拖垮（一次运行 240 万次请求，只受理 117 个） | 事件驱动（hooks），禁止轮询，加限流 |
| 共享上下文与脚手架让 agent 行为趋同（30 个里有 18 个起了同一个分支名） | 名称由程序生成；审查尽量使用与实现者不同的模型家族 |
| 部分 agent 无限升级，部分直接放弃 | 设预算、轮次上限、升级阶梯和停止条件 |
| 仲裁者加同侪审查有效；模型"品味"不足，需要人来定方向 | 关键决策点交给人；最终结论由独立仲裁做出 |

## 3. 现有实现盘点（round-ape 合入后，main@7589dae）

**已经具备：**
- Paseo 基础设施：agent 创建与归档、消息、工作区、运行标签。插件能收到的 hook 有 `agent.created`、`agent.turn_started`、`agent.turn_ended`、`agent.permission_requested`、`agent.permission_resolved`、`agent.closed`、`agent.archived`、`agent.session_open`。SDK 还提供用量来源注册接口（`UsageSourceRegistration`）。
- 团队启动：`launch-service` 中的共享 prepare、模式（SOTA / 经济 / 协作）、Role 分层、经济池、席位规划，以及启动预览与计划哈希冻结。
- 运行追踪：Runs 页与 run-progress（含"需处理"状态）、协调者提示编译与成员名册。
- **设计师子系统**：这是一个完整的单任务治理样板，可推广为通用的任务治理：
  - 账本：原子写入、进程锁、守卫回收；
  - 租约、幂等创建、取消与补偿；
  - 12 行恢复矩阵，由 hook 驱动的只读对账；
  - 结构化输出：strict schema 加 nonce 身份校验；
  - 轮次与输入预算。
- 版本管理：检查更新、确认后一键更新、失败回滚。

**主要差距：**
- 没有任务级状态。DAG、谁在做什么、尝试次数全靠协调者 LLM 记忆，协调者还要处理所有 Worker 事件，SOTA token 随事件数量增长。
- Worker 租约、文件锁、并发上限、预算、质量门都只写在提示里，没有程序强制。
- 插件不能向 agent 提供工具。agent 给插件下指令的唯一通道，是回合结束时由插件解析结构化块；5B 的 D5 结论"结构化申请块"走的就是这条路。
- `runtimeCapabilities`（按需创建、扩容、协作运行）尚未实现。

## 4. 目标架构

```
人 ──(目标 / 选择 / 不可逆操作的批准)──▶ 战略编排（Opus-5.5-Max；架构裁决协同 Astra-Max）
                                              │ task-dag（结构化）     ▲ 精简摘要（仅决策点）
                                              ▼                        │
                         运行调度：插件 Run Engine（确定性）＋ 过渡期的 Grok-4.6（Cursor）
                     台账 · 就绪分配 · 租约 · 重试与升级 · 锁 · 并发 · 预算 · 质量门 · 集成队列
                                              │ 任务提示（模板化）     ▲ task-report（结构化）
                                              ▼                        │
                         Worker：S / A / B 分层（按 L1–L4 分配；实现、审查、验收、集成分开）
```

- **协议**：
  - 战略编排输出 `task-dag`：任务、依赖、难度、层级、文件范围、验收标准与证据要求；
  - Worker 输出 `task-report`：状态、改动文件、证据（命令及输出）、阻塞；
  - 两者都用 strict schema，并带身份校验（jobId / taskId / nonce），沿用设计师的做法；
  - 插件在 `agent.turn_ended` 时解析，更新台账。
- **唤醒策略**：Run Engine 只在决策点唤醒战略编排，并附上精简摘要。决策点包括：
  - DAG 需要改；
  - 需求或架构有分歧；
  - 任务升到 S 层后仍失败；
  - 预算即将超限；
  - 需要人拍板；
  - 阶段结束。
- **治理**：以下规则由程序强制执行：
  - 状态机：没有证据不得进入审查；没有独立审查给出"可合入"不得完成；UI/RPC 变更没有 DEV 冒烟不得完成；
  - 文件与 worktree 锁、唯一命名；
  - 并发上限；
  - 预算：S 层调用次数、轮次、回合数；
  - 不可逆操作必须由人批准。

## 5. 难度与层级

- **难度**：
  - L1 机械；
  - L2 常规；
  - L3 复杂：跨文件或跨层、新 RPC/DTO、UI 接线、需要取舍；
  - L4 关键：状态机、并发与恢复、持久化与数据安全、git 与版本、安全边界、跨模块合同。
- **层级（按模型能力）**：
  - S：Opus-5.5-Max、Astra-Max，只做决策、架构与 L4；
  - A：Opus-5.5-High 负责 L4 终审与需求，Sol Max 负责 L3 后端与运行调度，Sonnet-5.5 Xhigh 负责 L3 前端，Cursor-Claude-Sonnet-5.5 负责常规审查与代码库分析；
  - B：DeepSeek-V4.1-Flash-Max 负责 L1–L2 实现与测试，Grok-4.6-High-Fast 负责验收、集成与脚本；
  - 禁用 Grok-4.7。
- **按额度调整（2026-10-27 生效）**：Cursor 渠道的 Grok 额度充足，其他模型即将耗尽。
  - SOTA（Opus-5.5-Max、Astra-Max）和 Opus-5.5-High 只保留在决策席位与 L4 席位：战略编排、架构师、需求分析师、攻坚专家、L4 终审。
  - 运行调度、L1–L3 实现、常规审查、代码库分析、验收与集成，默认都用 Grok-4.6（Cursor）。Sol Max、Sonnet、DeepSeek 只作备选。
  - **风险**：同一模型家族互审容易一起看漏。缓解措施：
    - 常规审查的关键结论必须用仓库外探针复现，并逐条对照验收清单；
    - L4 一律由 Opus-High 终审；
    - 质量门由程序强制。
  - **建议**：新建一个 Cursor 渠道的 Grok-4.6 xhigh Profile（`cursor/cursor-grok-4.6`，思考档位 xhigh），给 L3 实现和审查使用，以加深推理。现有的 Grok-4.6-High-Fast 用的是 high 档。
- **升级**：同一任务返工 2 轮仍有阻断，升一层。依据见 `docs/next-iteration-role-tiering.md` 中上一轮各模型的实测表现。

## 6. 分阶段路线图

- **阶段 0（已完成，2026-10-27）**：按本设计建好 Team「Agent Team 研发 · 分层编排」（`agent-team-orchestration`），未运行。在 Run Engine 落地之前，用"运行调度成员 + 规则"的过渡形态执行。
- **阶段 1（下一轮目标）：Run Engine 最小闭环**
  1. 任务台账的 schema 与存储：复用设计师账本模式（原子写、锁、恢复），旧数据兼容。
  2. 结构化协议：`task-dag` / `task-report` 的 strict schema 与身份校验，在 `turn_ended` 时解析；解析失败时要求重发，不得静默接受。
  3. 确定性状态机与质量门：证据、独立审查、DEV 冒烟三道门由程序强制执行。
  4. 调度：就绪任务按"难度 → 层级 → 可用 Profile"选择成员；文件锁与 worktree 分配，名称唯一；设并发上限。
  5. 重试、升级与预算：返工 2 轮后升层；统计 S 层调用；设轮次和回合上限；撞额度或输出退化时改派。
  6. 唤醒策略：战略编排只在决策点收到摘要。
  7. Runs 页展示 DAG、任务状态、锁、预算与升级记录。
  - **验收**：在 DEV 上用一个小 DAG 跑通全流程，覆盖失败升级、锁冲突、质量门拦截、崩溃恢复；与 round-ape 相比，战略编排回合数和 SOTA token 应显著下降。
- **阶段 2**：
  - Profile 能力层级设置（S / A / B / 禁用，按 hint 预填，可修改），以及按难度自动选人；
  - 统一 5A 的模式与 Role 分层，避免出现两套规则；
  - 5B 的按需创建由 Run Engine 触发：任务就绪时才创建对应层级的 Worker；
  - 扩容申请走结构化块。
- **阶段 3**：
  - 协作模式（多家族并行 + 仲裁）建立在 Run Engine 之上；
  - 额度感知（用量接口）；
  - 可观测与调优：记录任务级的模型、返工、耗时与 token，按历史数据调整层级。
- **并入 backlog P1**：覆盖率统计盲区、`appliedHash` 重算、协调者 Profile 引导、README。

## 7. Team 设计（已建，未运行）

协调者：**【统筹】战略编排**，Opus-5.5-Max，备选 Astra-Max、Opus-5.5-High。

| 席位 | Role | 首选 Profile | 层级 | 承担 |
| --- | --- | --- | --- | --- |
| seat-operations | 【统筹】运行调度（新） | Grok-4.6（备选 Sol Max、DeepSeek） | 调度 | DAG 执行、台账、锁、重试、升级、集成安排 |
| seat-architect | 【规划】架构师 | GPT-6-Astra-Max | S | 方案、接口、跨模块合同 |
| seat-requirements | 【规划】需求分析师 | Claude-Opus-5.5-High | A | 验收标准 |
| seat-codebase | 【研究】代码库分析（新） | Grok-4.6（备选 Cursor-Sonnet） | 执行 | 现状与 SDK 能力梳理 |
| seat-expert | 【工程】攻坚专家 · L4 | Claude-Opus-5.5-Max | S | 仅 L4 实现或方案评审 |
| seat-core-server | 【工程】核心开发（新）· L3 server/shared | Grok-4.6（备选 Sol Max、Sonnet Xhigh） | 执行 | L3 后端 |
| seat-core-client | 【工程】核心开发（新）· L3 client | Grok-4.6（备选 Sol Max、Sonnet Xhigh） | 执行 | L3 前端 |
| seat-economy-a / b | 【工程】经济开发（新）× 2 | Grok-4.6（备选 DeepSeek） | 执行 | L1–L2 实现、测试、返工 |
| seat-review-l4 | 【质量】代码审查 · L4 终审 | Claude-Opus-5.5-High | A | L4 终审 |
| seat-review | 【质量】常规审查（新） | Grok-4.6（备选 Cursor-Sonnet、Sol Max） | 执行 | L2–L3 审查，须用探针复现关键结论 |
| seat-acceptance | 【质量】DEV 验收（新） | Grok-4.6（备选 DeepSeek） | 执行 | DEV 实测 |
| seat-integrator | 【工程】集成与仓库（新） | Grok-4.6（备选 DeepSeek） | 执行 | 提交、cherry-pick、质量门 |

表中的 Grok-4.6 指 Cursor 渠道的 Grok-4.6-High-Fast。

- 新 Role 都不含 Grok-4.7。原有的 23 个 Role 和旧 Team「Agent Team 插件研发」都未改动。
- 其中 `lead-orchestrator`、`lead-tech`、`eng-batch`、`eng-ops` 仍引用 Grok-4.7，是否清理由人决定。
- 模式为 SOTA，含义是"每个 Role 使用自己的绑定"。层级已经直接写在各 Role 的绑定里。

## 8. 成功指标

- 战略编排的回合数与 token 不随 Worker 事件数增长，只随决策点数增长。
- 首次审查即"可合入"的比例上升，平均返工轮次下降，尤其是 L4 交给 S/A 层之后。
- 并行导致的合并冲突与重名为 0：由锁、DAG 和唯一命名保证。
- 质量门被绕过的次数为 0：由程序强制。
- 从启动到合入的总时长低于 round-ape。

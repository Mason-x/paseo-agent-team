# paseo-agent-team 产品需求文档（PRD）

| 项目 | 内容 |
| --- | --- |
| 产品名 | `paseo-agent-team` |
| 文档版本 | v1.0（2026-09-19） |
| 文档状态 | 待实施 |
| 目标平台 | Paseo **0.8.0**（详见配套开发 Spec 的版本基线） |
| 配套文档 | `docs/paseo-agent-team-dev-spec.md` |
| 代码基础 | 本仓库 `paseo-agent-team/`（MIT，导入自 omercnet/paseo-plugins 的 `agent-crew/`） |

---

## 1. 一句话定义

**paseo-agent-team 让用户在 Paseo 界面里定义可复用的 Role（角色），把 Role 组成 Team（团队），然后在任意工作区一键启动一支由不同 Harness（Claude Code / Codex / OMP / ACP…）组成的 Agent 团队。**

参照物是 [ruvnet/ruflo](https://github.com/ruvnet/ruflo) 的 agent 定义（`name / type / description / capabilities / prompt`）与 coordinator–worker 层级 swarm。区别在于：本产品跨 Harness、在 UI 中配置、数据在同一 Paseo 主机的所有客户端间同步，不需要手工维护文件。

## 2. 背景与问题

Paseo 0.8 已经提供：

- Agent Profile：命名的执行配置（provider / model / mode / thinking / features / notes）。Profile **刻意不包含 system prompt**（源码注释原文："There is deliberately no system prompt here"）。
- 原生子代理编排：`create_agent`、`send_agent_prompt`、完成通知、父子关系、权限转发。
- 官方编排 Skill（`paseo-committee`、`paseo-advisor`、`paseo-handoff`）：用手写 SKILL.md 描述流程，让 Coordinator 读 Profile notes 自己挑人。
- 社区插件 `agent-crew`：工作区内的 Crew Tree 面板与 Nudge / Redirect / Detach / Archive / 权限操作。

缺口：

1. **没有"角色"这一层。** 用户无法在 Paseo 内定义"Reviewer 是谁、做什么、不做什么、返回什么"，并把它绑定到一个 Profile 上复用。
2. **团队只能靠手写 Skill 文件。** 每个 Harness 的 agents 目录（如 `.claude/agents/`）只对自身生效，且要改文件；跨 Harness 的团队没有任何配置入口。
3. **Coordinator 现场用 `create_agent` 拉的 Worker 拿不到真正的 system prompt。** 该工具没有 `systemPrompt` 参数，角色指令只能塞进用户消息，稳定性差。
4. Crew Tree 只显示 provider/model，看不出"谁是什么角色、属于哪支团队"。

## 3. 目标与非目标

### 3.1 目标（V1）

- G1 用户可以在 Paseo 界面中创建、编辑、复制、禁用、删除 Role，不需要改任何文件。
- G2 Role 可以绑定一个或多个现有 Paseo Profile（首选 + 备选），Profile 被删除时明确提示而不是静默失败。
- G3 用户可以把 Role 组成 Team，指定 Coordinator，并为成员单独覆盖 Profile。
- G4 用户可以在某个工作区里选择 Team、输入任务、预览成员与 Profile、一键启动；启动后每个成员都是带真实 system prompt、正确父子关系、可识别标签的 Paseo Agent。
- G5 Crew Tree 面板能显示每个 Agent 的 Role / Team 标签，并保留 `agent-crew` 的全部既有能力。
- G6 数据存放在 Paseo 主机侧 Settings，同一主机的所有客户端同步；具备 schema 版本与迁移能力。
- G7 只依赖 Paseo 公开插件 SDK；不修改 Paseo Core；不依赖任何其他社区插件；为后续 Paseo 版本升级预留隔离层。

### 3.2 非目标（V1 明确不做）

- 不做 Workflow / DAG / Gate 引擎，不做 Run 状态机、Evidence 收集、重试策略。
- 不做任务→团队的自动 Router；由用户手选 Team。
- 不做长期 Memory、RAG、共识算法、性能评分、自动调参（对应 ruflo 的 hive-mind / neural / memory 能力）。
- 不做工具级权限限制（Paseo 0.8.0 的 `toolPolicy` 只能预批准 MCP 工具，不能禁用）。
- 不做 YAML 导入导出（留 V2）。
- 不做 Video / 多媒体团队模板。
- 不实现自定义 Provider，不复制 Paseo 凭据，不读写 `~/.paseo` 内部文件。

## 4. 目标用户与场景

**用户**：使用 Paseo 同时接入多个 Harness 的个人开发者 / 小团队技术负责人。

**场景 A — 编码团队**
用户在一个 Next.js 项目工作区里选择 "Coding Team"，输入"给项目增加 Stripe subscription"。系统预览：Tech Lead（Claude Opus，Coordinator）、Architect（Claude Opus）、Backend Developer（Codex）、Frontend Developer（Codex）、Reviewer（Claude Opus）。确认后五个 Agent 出现在 Crew Tree 中，Tech Lead 开始拆分任务并派活；用户可以随时打开任何一个成员对话、批准权限、Nudge 或 Archive。

**场景 B — 研究团队**
用户选择 "Research Team"，输入"比较三种 WebSocket 库在 Bun 上的成熟度"。Research Lead 派 Source Researcher（Gemini via ACP）、Fact Checker（Codex）、Critic（Claude）分别工作，最后汇总。全程只有文本工作，不改代码。

**场景 C — 自定义角色**
用户新建一个 "Security Reviewer" Role：填写使命、职责、限制、system prompt、返回格式；首选 Profile 选 `claude-opus-high`，备选 `codex-xhigh`；把它加进 Coding Team。下次启动 Coding Team 时自动多一名成员。用户在手机端打开 Paseo，也能看到同样的 Role 与 Team。

## 5. 术语

| 术语 | 定义 |
| --- | --- |
| Profile | Paseo 原生的 Agent Profile：provider / model / modeId / thinkingOptionId / featureValues / notes。由 Paseo 管理，本产品只引用。 |
| Role | 本产品定义的可复用角色：身份、使命、职责、限制、system prompt、返回契约、Profile 绑定、可选 MCP servers。 |
| Team | 一组 Role 的组织结构：一个 Coordinator Role + 若干成员 Role（可按成员覆盖 Profile）。 |
| Coordinator | Team 中负责拆解任务、派活、汇总的角色对应的 Agent。它是所有成员 Agent 的父节点。 |
| Member / Worker | Team 中非 Coordinator 的成员 Agent。 |
| Launch / Run | 用户在某个工作区选择 Team 并输入任务后，一次性创建 Coordinator 与全部成员并下发任务的过程；同一次 Launch 的 Agent 共享一个 `runId` 标签。 |
| Crew Tree | 来自 `agent-crew` 的工作区 Agent 树面板。 |

## 6. 功能需求

每条需求附验收标准（AC）。"必须"为 V1 范围，"应当"为 V1 尽量完成、可降级。

### FR-1 Role 目录

- 必须：提供 "Agent Teams" 侧边栏入口，进入后有 Roles / Teams 两个标签页。
- 必须：Roles 页列出全部 Role，显示名称、一句话描述、首选 Profile 名、启用状态、被哪些 Team 使用。
- 必须：支持新建、编辑、复制、启用/禁用、删除 Role。删除被 Team 引用的 Role 时必须阻止并列出引用它的 Team。
- 应当：列表支持按名称/描述搜索。

AC：
1. 新建 Architect 后，在另一台连到同一 Paseo 主机的客户端刷新页面能看到它。
2. 删除被 Coding Team 引用的 Architect 时，弹出阻止提示并列出 "Coding Team"。
3. 禁用的 Role 在 Team 编辑器中不可被新增为成员，已存在的成员显示"已禁用"并在启动时被跳过（带提示）。

### FR-2 Role 字段

必须包含：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | slug | 是 | 小写字母开头，`[a-z0-9-]`，唯一，创建后不可改 |
| `name` | 文本 | 是 | 显示名，≤ 40 字符 |
| `description` | 文本 | 否 | 一句话描述，≤ 160 字符 |
| `mission` | 多行文本 | 是 | 这个角色为什么存在 |
| `responsibilities` | 列表 | 是 | 至少 1 条 |
| `restrictions` | 列表 | 否 | 不做什么 |
| `systemPrompt` | 多行文本 | 是 | 角色核心指令正文 |
| `outputContract` | 列表 | 否 | 完成时必须返回的内容 |
| `preferredProfiles` | ProfileRef[] | 是 | 至少 1 个 |
| `fallbackProfiles` | ProfileRef[] | 否 | 首选不可用时依次尝试 |
| `mcpServers` | JSON 对象 | 否 | 追加给该角色 Agent 的 MCP servers（Paseo `McpServerConfig` 形状），高级选项 |
| `color` / `icon` | 文本 | 否 | 展示用，对应 ruflo 的 `color`；icon 使用 Paseo 图标名 |
| `enabled` | 布尔 | 是 | 默认 true |

AC：
1. `id` 重复或不合法时表单无法保存并显示具体原因。
2. `mcpServers` 填入非法 JSON 时无法保存。
3. 所有必填项为空时对应字段高亮。

### FR-3 Profile 绑定

- 必须：Profile 选择器从 Paseo 主机读取当前配置的 Agent Profiles，显示 name、provider/model、notes 摘要。
- 必须：存储的是 Paseo Profile 的稳定 `id`，并附带 name 快照用于显示。
- 必须：Profile 已被 Paseo 删除时，Role 列表与编辑器显示 "Missing profile: <name 快照>"，允许重新绑定；Role 本身仍可读取，不阻塞其他数据。
- 必须：启动 Team 时按 "成员覆盖 → 首选（按顺序）→ 备选（按顺序）" 解析，首个存在且 provider 可用的 Profile 胜出；全部不可用时启动被阻止并提示具体原因。
- 禁止：静默改用无关 Profile，静默跨 provider 继承 mode / thinking。

AC：
1. 在 Paseo 中删除 `claude-opus-xhigh` 后打开 Roles 页，Architect 显示 Missing 标记。
2. Architect 首选 Missing、备选 `codex-xhigh` 存在时，启动预览显示 Architect → codex-xhigh（来源：备选）。
3. 全部 Profile 均 Missing 时，启动按钮禁用并显示原因。

### FR-4 Team 目录

- 必须：Teams 页列出全部 Team，显示名称、描述、成员数、Coordinator 名、启用状态。
- 必须：支持新建、编辑、复制、启用/禁用、删除 Team。

### FR-5 Team 字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | slug | 是 | 同 Role 规则 |
| `name` | 文本 | 是 | ≤ 40 字符 |
| `description` | 文本 | 否 | ≤ 160 字符 |
| `coordinatorRoleId` | Role id | 是 | 必须是启用的 Role |
| `members` | TeamMember[] | 是 | 至少 1 个，不含 Coordinator |
| `members[].roleId` | Role id | 是 | 同一 Role 可出现多次（如两个 Developer），此时需 `instanceLabel` 区分 |
| `members[].instanceLabel` | 文本 | 否 | 例如 "Backend" / "Frontend" |
| `members[].profileOverride` | ProfileRef | 否 | 覆盖该成员的 Role 默认 Profile |
| `members[].enabled` | 布尔 | 是 | 默认 true |
| `operatingRules` | 多行文本 | 否 | 团队级规则，编译进 Coordinator 指令，例如"实现者与审查者必须是不同成员" |
| `enabled` | 布尔 | 是 | 默认 true |

AC：
1. 同一 Role 出现两次且未填 `instanceLabel` 时不能保存。
2. Coordinator 被同时加入 members 时不能保存。
3. 成员 Role 被禁用后，Team 列表显示警告角标。

### FR-6 启动 Team（Launch）

入口（必须）：
- 工作区内 Crew 面板顶部 "Launch team" 按钮；
- Command Center（workspace 上下文）"Launch agent team"；
- Agent Teams 页面中某个 Team 的 "Launch" 按钮（需选择目标工作区）。

流程（必须）：
1. 选择 Team（仅启用的）。
2. 输入任务描述（多行，必填）。
3. 预览：Coordinator 与每位成员的 Role 名、解析出的 Profile（name + provider/model + 来源）、任何警告（Missing、provider 不可用、成员被跳过）。
4. 确认后创建 Coordinator Agent，再逐个创建成员 Agent（父节点 = Coordinator），最后向 Coordinator 发送包含任务、成员名册（agentId ↔ Role）与协作规则的启动消息。
5. 成功后自动打开 Crew 面板并高亮本次 Run；失败时给出明确错误，并把已创建的 Agent 归档（可选保留）。

约束（必须）：
- 每位 Agent 的 system prompt 由 Role 定义生成；Profile 决定 provider/model/mode/thinking/features。
- 所有 Agent 携带 `agent-team.run` / `agent-team.team` / `agent-team.role` / `agent-team.kind` 标签。
- Coordinator 使用的 provider 必须启用 Paseo 工具（否则无法派活），预览阶段需提示。
- 成员数上限默认 8（可在偏好中调整，硬上限 16）。

AC：
1. 用 Coding Team 启动后，Crew Tree 显示 Tech Lead 为根、其余成员为子节点，标题为 "<Role 名> · <Team 名>"。
2. 打开任一成员对话，其首条系统指令即为该 Role 的 system prompt（可通过成员的行为或 Paseo 显示的配置验证）。
3. Coordinator 收到启动消息后，能用 `send_agent_prompt` 向名册中的 agentId 派活并收到完成通知。
4. 目标工作区 provider 不可用时（如 Codex 未登录），预览阶段即显示错误并禁用启动。
5. 普通（非本插件创建的）Paseo Agent 完全不受影响。

### FR-7 Crew Tree 增强

- 必须：保留 `agent-crew` 现有全部功能与交互（树、状态筛选、搜索、Nudge / Redirect / Detach / Archive / 权限 Allow-Deny、跨工作区 descendants、确认对话框、Toast）。
- 必须：带 `agent-team.*` 标签的节点显示 Role 名与 Team 名（读标签，找不到 Role 定义时仍显示标签原值）。
- 应当：按 Run 分组的折叠标题（"Coding Team · Stripe subscription · 5 agents"）。
- 应当：面板顶部 "Launch team" 按钮。

AC：`agent-crew` 现有单元测试全部通过；手工回归清单（见开发 Spec §13）全部通过。

### FR-8 内置模板

- 必须：首次打开 Agent Teams 且目录为空时，提供"导入示例"按钮，一键写入两套模板：
  - Coding Team：tech-lead（Coordinator）、planner、architect、backend-developer、frontend-developer、tester、reviewer
  - Research Team：research-lead（Coordinator）、source-researcher、fact-checker、analyst、critic
- 必须：模板中的 Profile 绑定为空或指向当前主机存在的 Profile；导入后提示用户为每个 Role 绑定 Profile。
- 必须：模板导入后与手工创建的数据无区别，可任意修改删除。

### FR-9 校验与错误处理

必须覆盖并给出明确文案：Role 不存在、Team 成员引用不存在的 Role、Coordinator 未设置或被禁用、Profile Missing、provider 不可用、Coordinator provider 未启用 Paseo 工具、Agent 创建失败（含部分成功）、Settings 写入冲突（他端已修改）、Settings 数据 invalid（保留原数据、提供 reset）。

原则：错误必须可见；禁止静默降级；已完成的创建不回滚为静默状态。

### FR-10 多端同步与持久化

- 必须：Role / Team / 偏好存放在 Paseo 主机侧插件 Settings（host 作用域），所有客户端共享。
- 必须：编辑器持有读取时的 revision；他端已修改导致保存冲突时提示"内容已被更新"，允许重新加载或覆盖。
- 必须：Settings 文档带 `version`，后续版本变更通过 `migrate` 迁移；不丢用户数据。
- 应当：最近 20 次 Launch 的摘要（runId、team、workspace、coordinatorAgentId、task 摘要、时间）保存在偏好文档，用于 Crew 分组与"最近启动"列表。

### FR-11 平台与兼容

- 必须：桌面（Electron）与 Web 客户端可用；紧凑布局（手机宽度）下可浏览与启动，编辑器可降级为纵向单列。
- 必须：不使用 DOM-only 依赖；只使用 Paseo 提供的 React Native 组件与 `@getpaseo/plugin/client/*` 公开 API。
- 必须：manifest `requirements.paseo` 精确表达已验证范围（初始 `^0.8.0`）。
- 必须：Paseo SDK 的访问集中在单一适配层；升级 Paseo 时只需修改该层（详见开发 Spec §12）。

## 7. 非功能需求

| 类别 | 要求 |
| --- | --- |
| 性能 | 不新增高频轮询；复用 `agent-crew` 的订阅 + 500ms 去抖 + 30s 兜底刷新；Profile 列表按需读取并缓存到页面级。 |
| 安全 | 插件 Server 入口只注册 Settings，不做网络请求、不读取无关目录、不存任何凭据；不代替用户批准权限（Coordinator 指令中明确禁止调用 `respond_to_permission`）。 |
| 可观测 | 客户端对启动流程每一步（创建 Coordinator、创建成员 N、发送启动消息）输出可见进度与失败原因。 |
| 可维护 | TypeScript strict；Zod 校验所有持久化数据；单元测试覆盖 schema、Profile 解析、Prompt 编译、Launch 计划生成；沿用 `agent-crew` 的 biome / vitest / coverage 门禁。 |
| 许可 | 保留 `agent-crew` 的 MIT LICENSE 与署名，新增 `UPSTREAM.md` 记录导入的 commit。 |

## 8. 发布标准（Definition of Done，V1）

1. 只有一个插件 `paseo-agent-team`，`paseo plugin ls` 显示 running、无 load error。
2. 未修改 Paseo Core；未依赖任何其他社区插件；未调用非公开 API。
3. `agent-crew` 的既有功能与测试全部保留并通过。
4. FR-1 ~ FR-10 的全部"必须"项与 AC 通过。
5. 在隔离的开发 daemon 上，用 Coding Team 完成一次真实任务：Coordinator（Claude Code）+ 至少一个 Codex 成员 + 一个 Claude 成员，形成同一棵 Crew Tree，成员携带正确标签与 system prompt。
6. Research Team 模板完成一次纯文本任务。
7. Profile Missing、provider 不可用、保存冲突三类错误路径有截图或录屏验证。
8. `npm run check`、`npm run typecheck`、`npm test` 通过；对 Paseo 0.8.0 与最新 0.9 beta 的类型检查均通过（后者允许存在已记录的差异）。
9. README 覆盖安装、配置、启动、限制；`UPSTREAM.md`、`CHANGELOG.md`、`AGENTS.md` 齐备。

以下情况视为未完成：必须手改文件才能定义 Role；Role 与某个 provider 硬绑定；Worker 的角色指令只存在于用户消息中而非 system prompt；普通 Paseo Agent 被本插件影响；Missing Profile 静默替换。

## 9. 决策记录

| 编号 | 决策 | 理由 |
| --- | --- | --- |
| D-1 | 启动时由插件**预先创建全部成员**（父节点 = Coordinator），而不是让 Coordinator 现场 `create_agent` | 原生 `create_agent` 工具没有 `systemPrompt` / `profile` 参数；插件走 SDK `agents.create` 可以给每个成员真实 system prompt、正确 Profile、正确父子关系与标签。代价是空闲成员占用进程，故限制成员数。 |
| D-2 | 数据为 host 作用域，按需用可选的工作区过滤 | Paseo 0.8 Settings 只有 host 作用域；ruflo 的按项目角色可通过 V2 的 workspace 标签实现。 |
| D-3 | V1 不做 Workflow / Router / Run 状态机 | 这些是体验增益而非能力空白；Coordinator LLM 已能完成任务拆解；UI 成本最高、独有价值最低。 |
| D-4 | 架构为 client 主体 + 仅注册 Settings 的极小 server 入口 | 0.8.0 中 Settings RPC 必须由 server 入口注册；其余逻辑放 client 可避开 server 端 API 的高频变化。 |
| D-5 | 不使用 `agent.create` 生命周期 hook | 0.8.0 中该 hook 只能看到 `config` 与 `env`，无法识别本插件的 Agent；插件自建 Agent 时可直接传完整 config，无需 hook。 |
| D-6 | 不提供工具级限制 | 0.8.0 `toolPolicy` 仅为 MCP 工具预批准；限制只能写入 Role 的 restrictions 文本。 |

## 10. 开放问题

| 编号 | 问题 | 当前倾向 |
| --- | --- | --- |
| Q-1 | 成员是否在启动时就创建（占进程）还是按 Coordinator 需要惰性创建 | V1 预创建；V2 评估"惰性 + 插件监听 Coordinator 请求"方案。 |
| Q-2 | 按项目/工作区隔离 Role 与 Team | V2 增加可选 `workspaceIds` 过滤字段。 |
| Q-3 | Launch 失败时是归档已创建的 Agent 还是保留 | V1 默认归档并提示；偏好中可选"保留"。 |
| Q-4 | Paseo 0.9 stable 后是否利用 server 端 settings 句柄做 Run 状态跟踪 | 待 0.9 stable 后评估。 |

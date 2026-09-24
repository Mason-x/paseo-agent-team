# paseo-agent-team 开发规格（Dev Spec）

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v1.0（2026-09-19） |
| 需求来源 | `docs/paseo-agent-team-prd.md` |
| 实施方式 | 交给编码 Agent 按 §14 的 Phase 逐个实施，每个 Phase 独立 PR |
| 目标 Paseo | **0.8.0**（本机 CLI 版本；npm 上唯一的 0.8 stable） |
| 代码基础 | 本仓库 `paseo-agent-team/`（自 omercnet/paseo-plugins `agent-crew/` v0.2.3 导入，MIT） |

> 实施 Agent 开始前必须先读：本文 §0、§1、§15；根目录 `AGENTS.md`；新插件目录下的 `AGENTS.md`（Phase 0 创建）。

---

## 0. 实施 Agent 工作规则

1. **一个 Phase 一个 PR**，不要把多个 Phase 合在一个 PR 里。每个 PR 必须附带该 Phase 的测试与 §14 里的验收清单勾选结果。
2. **不猜 API。** 所有 Paseo SDK 用法以 `node_modules/@getpaseo/plugin@0.8.0`、`@getpaseo/client@0.8.0` 的 `.d.ts` 为准；本文 §1 已列出核实过的事实，与之冲突时以 `.d.ts` 为准并在 PR 中记录差异。
3. **不要以 `F:\tools\paseo` 的工作区 HEAD 为依据**——它是 0.9.0-beta.1。需要看源码时先 `git -C F:\tools\paseo show v0.8.0:<path>`。
4. **禁止**：修改 Paseo 源码；调用非公开 daemon API；深引 `@getpaseo/protocol/*`、`@getpaseo/server`、`@getpaseo/client/internal/*`；读写 `~/.paseo` 下的文件；引入其他社区插件作为运行时依赖；在 manifest 中使用 `build` 字段（Paseo 自行打包 TS，0.8.0 在 Windows 上 `build` 有已知缺陷）。
5. **保护生产 Paseo 实例**：任何 daemon / plugin 生命周期命令必须带显式 `--home` 或 `--host` 指向隔离目录（见 §15）。
6. 保留 `agent-crew` 的全部既有测试；新增代码遵循其 biome 配置、vitest、coverage 阈值（lines ≥ 90%，functions ≥ 85%）。
7. 所有新增持久化数据必须有 Zod schema，并有对应的 schema 单元测试。
8. UI 只使用 `react-native` 基础组件与 `@getpaseo/plugin/client/react-native`、`@getpaseo/plugin/client/ui`。不引入 DOM-only 库。

## 1. 版本基线与已核实的 SDK 事实

### 1.1 版本

- Paseo 仓库 tag：`v0.8.0-beta.1`、`v0.8.0`、`v0.9.0-beta.1`。**0.8 系列只有 0.8.0 一个 stable。**
- `paseo-agent-team/package.json` 已把 `@getpaseo/cli|client|plugin|protocol` pin 在 `0.8.0`，React 19.1.0，React Native 0.81.5，TypeScript 7，zod 4，vitest 5。
- manifest 初始值：`{"id":"paseo-agent-team","requirements":{"paseo":"^0.8.0"}}`。manifest schema 是 `.strict()`，仅允许 `id / description / requirements / build`。

### 1.2 客户端 SDK（`@getpaseo/plugin/client`，v0.8.0）

`PluginClientContext` 可用方法：`addSettingsScreen`、`addSurface`、`addSidebarItem`、`addWorkspacePanel`、`addCommandCenterItem`、`addSlashCommand`、`addHeaderButton`、`addComposerPill`、`addAttachmentSource`、`addTheme`、`addTimelineTransformer`、`addTimelineRenderer`、`openPanel`。

Hooks：`usePaseo()`（返回 `PaseoApi`）、`useSettings(definition)`、`useWorkspace(id, selector)`、`useAgent`、`useRpc`。

组件 props：`PluginSurfaceProps` / `PluginWorkspacePanelProps` 含 `theme.colors.*`、`layout.compact`、`layout.platform`、`host.id`、`navigation?.openAgent / openWorkspace`（可为 undefined，缺失时隐藏相关功能）。

`useSettings` 返回状态：`loading | error | invalid | ready`，`ready` 含 `values` 与 `revision`；动作 `save(values, revision): Promise<boolean>`（不抛错，失败写 `saveError`）、`reset()`、`reload()`。

### 1.3 `PaseoApi`（`@getpaseo/client`，v0.8.0，通过 `usePaseo()` 获取）

```ts
paseo.agents.list({ sort, page })           // 分页，entries[].agent 为 snapshot
paseo.agents.ref(id).send / archive / detach / respondToPermission / subscribe
paseo.agents.subscribe(handler)             // agent_update 流
paseo.workspaces.list / ref(id) / subscribe
paseo.workspaces.ref(workspaceId).agents.create(options)   // 在指定工作区内创建
paseo.providers.listAvailable()             // provider 可用性
paseo.config.get()                          // { config: MutableDaemonConfig }，含 agentProfiles?: AgentProfile[]
```

`PaseoAgentCreateOptions`（省略 `cwd` 时用 `workspaces.ref(id).agents.create`）：

```ts
{
  config: {
    provider: string;            // "provider/model" 形式；无 model 时仅 "provider"
    modeId?: string;
    thinkingOptionId?: string;
    featureValues?: Record<string, unknown>;
    systemPrompt?: string;       // 真实 system prompt，创建时生效
    mcpServers?: Record<string, McpServerConfig>;
    toolPolicy?: { preapproved: McpToolRef[] };   // 仅预批准，V1 不用
    options?: ProviderOptions;   // provider 私有设置，V1 不用
  };
  parent?: string | PaseoAgentHandle;   // 设为 Coordinator id → daemon 写入父子关系
  title?: string | null;
  labels?: Record<string, string>;
  prompt?: string;                       // 可选初始任务；省略则 Agent 空闲等待
  worktree?: ...; git?: ...; autoArchive?: ...; env?: ...
}
```

`AgentProfile`（`config.agentProfiles[]`）：`{ id, name, icon?, color?, provider, model?, modeId?, thinkingOptionId?, featureValues?, notes? }`，`id` 稳定。

Agent snapshot 中与本插件相关的字段：`id, title, provider, model, status, workspaceId, cwd, labels, parentAgentId?（首字段）, pendingPermissions, requiresAttention, attentionReason ("finished"|"error"|"permission"), lastError, archivedAt, createdAt, updatedAt`。父子关系底层是 label `paseo.parent-agent-id`；`paseo-agent-team/client/crew.ts` 的 `parentAgentId()` 已兼容两种来源，沿用。

### 1.4 服务端 SDK（`@getpaseo/plugin/server`，v0.8.0）

`PluginServerContext`：`registerSettings(definition): void`（**0.8.0 返回 void，server 端读不到 settings**；0.9 起返回 `{ read, subscribe }`）、`handle(rpcContract, handler)`、`registerProvider`、`on(event)`、`before(request)`。

Settings 的读写 RPC 由 server 进程在 `registerSettings` 时注册（Paseo `plugin-process.ts`），因此 **`index.server.ts` 必须存在并注册全部 Settings 文档**，否则客户端 `useSettings` 无法工作。V1 的 server 入口只做这件事。

### 1.5 原生编排工具（Coordinator 在其 Harness 内可调用）

`create_agent`、`send_agent_prompt`、`get_agent_status`、`list_agents`、`get_agent_activity`、`cancel_agent`、`archive_agent`、`kill_agent`、`update_agent`、`set_agent_mode`、`create_workspace`、`list_workspaces`、`list_providers`、`list_models`、`list_profiles`、`inspect_provider`、`list_pending_permissions`、`respond_to_permission`。

关键事实：
- `create_agent` 工具入参只有 `title / provider / labels / settings{modeId,thinkingOptionId,features} / initialPrompt / workspaceId / notifyOnFinish`，**没有 `systemPrompt`、没有 `profile`**。这是 D-1（插件预建成员）的依据。
- `send_agent_prompt` 不限制目标必须是调用者创建的 Agent；Agent 作用域下默认 `background=true, notifyOnFinish=true`，完成后 Coordinator 会收到通知。
- Paseo 0.8.0 支持按 provider 禁用 Paseo 工具（daemon 设置）。Coordinator 的 provider 若被禁用工具则无法派活；预览阶段用 `paseo.config.get()` 中的 provider 设置检查（字段名以 0.8.0 `MutableDaemonConfig` 类型为准；若无法可靠判断，则在预览中显示"请确认该 provider 已启用 Paseo 工具"的提示而不是阻止）。

### 1.6 生命周期 hook（V1 不使用，仅记录原因）

`before("agent.create")` 只收到 `{ config: AgentSessionConfig, env }`，无 labels / parentAgentId / agentId，无法识别本插件的 Agent。V1 不注册任何 hook。

## 2. 仓库策略与目录结构

### 2.1 仓库

本仓库只包含 `paseo-agent-team`。它从 omercnet/paseo-plugins 的 `agent-crew/` 导入后改名，远端是 `Mason-x/paseo-agent-team`。其他插件目录已删除；Release Please、CI 和安全策略只覆盖这个插件。来源与导入 commit 见 `paseo-agent-team/UPSTREAM.md`。

安装命令：`paseo plugin add Mason-x/paseo-agent-team:paseo-agent-team`（Git 源）或在 `paseo-agent-team/` 内本地 `paseo plugin install "$PWD" --host <DEV_HOST>`。

### 2.2 目录结构（目标态）

```text
paseo-agent-team/
├── paseo-plugin.json            # {"id":"paseo-agent-team","requirements":{"paseo":"^0.8.0"}}
├── package.json                 # name: @<scope>/paseo-agent-team
├── tsconfig.json  biome.json  .gitignore  LICENSE  UPSTREAM.md  CHANGELOG.md  README.md  AGENTS.md
├── index.client.tsx             # 注册 surface / sidebar / panel / command center
├── index.server.ts              # 仅 registerSettings(rolesSettings, teamsSettings, preferencesSettings)
├── shared/
│   ├── ids.ts                   # slug 校验、label 常量
│   ├── schemas/
│   │   ├── profile-ref.ts
│   │   ├── role.ts
│   │   ├── team.ts
│   │   └── preferences.ts
│   ├── settings.ts              # defineSettings × 3
│   └── templates/
│       ├── coding-team.ts
│       └── research-team.ts
├── client/
│   ├── paseo/
│   │   ├── adapter.ts           # 唯一允许 import @getpaseo/client 类型的文件（除 crew.ts 既有推导）
│   │   └── labels.ts
│   ├── domain/
│   │   ├── profile-resolver.ts  # 纯函数
│   │   ├── prompt-compiler.ts   # 纯函数
│   │   ├── launch-plan.ts       # 纯函数：Team + Roles + Profiles → LaunchPlan | 错误
│   │   └── validation.ts        # 跨文档引用校验（Team→Role、Role→Profile）
│   ├── launch/
│   │   └── launch-team.ts       # 执行 LaunchPlan：调用 adapter 创建 Agent
│   ├── app/
│   │   ├── AgentTeamsSurface.tsx  # 侧边栏页面：Roles | Teams
│   │   └── tabs.ts
│   ├── roles/  RoleList.tsx  RoleEditor.tsx  ProfilePicker.tsx  ListEditor.tsx
│   ├── teams/  TeamList.tsx  TeamEditor.tsx  MemberEditor.tsx
│   ├── launch/ LaunchDialog.tsx  LaunchPreview.tsx
│   ├── crew/   crew.ts (原 agent-crew)  main.tsx (原 agent-crew，改造)  RunHeader.tsx
│   └── shared/ EmptyState.tsx  ErrorState.tsx  ConfirmDialog.tsx  SlugInput.tsx
├── scripts/package-release.ts   # 沿用
└── tests/
    ├── crew.shared.test.ts      # 原 agent-crew，保留
    ├── package-release.test.ts  # 原 agent-crew，保留
    ├── schemas.test.ts
    ├── profile-resolver.test.ts
    ├── prompt-compiler.test.ts
    ├── launch-plan.test.ts
    ├── validation.test.ts
    ├── templates.test.ts
    └── launch-team.test.ts      # 用 mock adapter
```

## 3. 架构

```text
┌──────────────────────── Paseo Client (React Native) ────────────────────────┐
│ index.client.tsx                                                            │
│  ├─ addSidebarItem("agent-teams") → addSurface(AgentTeamsSurface)           │
│  ├─ addWorkspacePanel("crew", explorer)  ← 原 agent-crew，加 Role 标签/Run 头 │
│  └─ addCommandCenterItem × 3 (Open Agent Teams / Open Crew / Launch team)   │
│                                                                             │
│  useSettings(roles|teams|preferences)  ──settings RPC──▶ Paseo host 存储      │
│  domain/* 纯函数  ──LaunchPlan──▶ launch/launch-team.ts ──▶ client/paseo/adapter │
│                                                        └──▶ usePaseo(): agents.create / config.get / providers.listAvailable │
└─────────────────────────────────────────────────────────────────────────────┘
┌──────────────── Plugin server 进程 (index.server.ts) ───────────────┐
│ registerSettings(rolesSettings); registerSettings(teamsSettings);   │
│ registerSettings(preferencesSettings);  return () => {}             │
└─────────────────────────────────────────────────────────────────────┘
```

原则：业务逻辑全部是可单测的纯函数（`domain/`），副作用集中在 `launch/launch-team.ts` 与 `paseo/adapter.ts`。

## 4. 领域模型（`shared/schemas`）

### 4.1 通用

```ts
export const SlugSchema = z.string().regex(/^[a-z][a-z0-9-]{1,47}$/);
export const ShortTextSchema = z.string().trim().min(1).max(40);
export const DescriptionSchema = z.string().trim().max(160);
export const StringListSchema = z.array(z.string().trim().min(1).max(500)).max(30);
```

### 4.2 ProfileRef

```ts
export const ProfileRefSchema = z.object({
  profileId: z.string().min(1),          // Paseo AgentProfile.id
  nameSnapshot: z.string().optional(),   // 仅显示用
});
```

### 4.3 Role

```ts
export const RoleSchema = z.object({
  id: SlugSchema,
  name: ShortTextSchema,
  description: DescriptionSchema.optional(),
  mission: z.string().trim().min(1).max(2000),
  responsibilities: StringListSchema.min(1),
  restrictions: StringListSchema.default([]),
  systemPrompt: z.string().trim().min(1).max(20000),
  outputContract: StringListSchema.default([]),
  preferredProfiles: z.array(ProfileRefSchema).min(1).max(5),
  fallbackProfiles: z.array(ProfileRefSchema).max(5).default([]),
  mcpServers: z.record(z.string(), z.unknown()).optional(),   // 形状由 Paseo 校验；此处只保证是对象
  color: z.string().max(32).optional(),
  icon: z.string().max(64).optional(),
  enabled: z.boolean().default(true),
  createdAt: z.string(),   // ISO
  updatedAt: z.string(),
}).passthrough();          // 未来字段不致 invalid
```

### 4.4 Team

```ts
export const TeamMemberSchema = z.object({
  roleId: SlugSchema,
  instanceLabel: ShortTextSchema.optional(),
  profileOverride: ProfileRefSchema.optional(),
  enabled: z.boolean().default(true),
});

export const TeamSchema = z.object({
  id: SlugSchema,
  name: ShortTextSchema,
  description: DescriptionSchema.optional(),
  coordinatorRoleId: SlugSchema,
  members: z.array(TeamMemberSchema).min(1).max(16),
  operatingRules: z.string().trim().max(4000).optional(),
  enabled: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string(),
}).passthrough()
  .refine(t => !t.members.some(m => m.roleId === t.coordinatorRoleId), "Coordinator cannot also be a member")
  .refine(t => {
    const seen = new Map<string, number>();
    for (const m of t.members) seen.set(m.roleId, (seen.get(m.roleId) ?? 0) + 1);
    return t.members.every(m => (seen.get(m.roleId) ?? 0) === 1 || m.instanceLabel);
  }, "Duplicate roles need an instanceLabel");
```

### 4.5 Settings 文档（`shared/settings.ts`）

```ts
export const rolesSettings = defineSettings({
  id: "agent-team-roles", scope: "host", version: 1,
  schema: z.object({ roles: z.array(RoleSchema).default([]) })
           .refine(uniqueIds("roles"), "Duplicate role id"),
});
export const teamsSettings = defineSettings({
  id: "agent-team-teams", scope: "host", version: 1,
  schema: z.object({ teams: z.array(TeamSchema).default([]) })
           .refine(uniqueIds("teams"), "Duplicate team id"),
});
export const preferencesSettings = defineSettings({
  id: "agent-team-preferences", scope: "host", version: 1,
  schema: z.object({
    maxMembers: z.number().int().min(1).max(16).default(8),
    archiveOnLaunchFailure: z.boolean().default(true),
    recentRuns: z.array(RunSummarySchema).max(20).default([]),
    templatesImportedAt: z.string().optional(),
  }),
});

export const RunSummarySchema = z.object({
  runId: z.string(), teamId: z.string(), teamName: z.string(),
  workspaceId: z.string(), coordinatorAgentId: z.string(),
  memberAgentIds: z.array(z.string()), taskExcerpt: z.string().max(120),
  createdAt: z.string(),
});
```

跨文档引用（Team→Role、Role→Profile）**不在 schema 内校验**，由 `domain/validation.ts` 在 UI 层计算并展示警告，保证任一文档缺失或过期时另一文档仍可读。

三份文档分开存的原因：写入是整文档替换 + revision 乐观锁，分开可减少 Role 编辑与 Team 编辑互相冲突。

## 5. Paseo 适配层（`client/paseo/adapter.ts`）

这是**唯一**允许 `import type ... from "@getpaseo/client"` 的新文件（`crew.ts` 沿用 `ReturnType<typeof usePaseo>` 推导）。对外只暴露插件自己的类型：

```ts
export type PaseoProfile = { id: string; name: string; provider: string; model?: string;
  modeId?: string; thinkingOptionId?: string; featureValues?: Record<string, unknown>; notes?: string; icon?: string; color?: string };
export type ProviderAvailability = { provider: string; available: boolean; reason?: string };
export type CreateMemberInput = {
  workspaceId: string; parentAgentId?: string; title: string;
  labels: Record<string, string>; systemPrompt: string;
  profile: PaseoProfile; mcpServers?: Record<string, unknown>; prompt?: string;
};

export interface PaseoAdapter {
  listProfiles(): Promise<PaseoProfile[]>;                 // config.get().config.agentProfiles ?? []
  listProviderAvailability(): Promise<ProviderAvailability[]>;
  createAgent(input: CreateMemberInput): Promise<{ agentId: string }>;
  sendMessage(agentId: string, text: string): Promise<void>;
  archiveAgent(agentId: string): Promise<void>;
}
export function createPaseoAdapter(paseo: ReturnType<typeof usePaseo>): PaseoAdapter;
```

`createAgent` 内部映射：

```ts
paseo.workspaces.ref(input.workspaceId).agents.create({
  parent: input.parentAgentId,
  title: input.title.slice(0, 60),
  labels: input.labels,
  prompt: input.prompt,
  config: {
    provider: input.profile.model ? `${input.profile.provider}/${input.profile.model}` : input.profile.provider,
    modeId: input.profile.modeId,
    thinkingOptionId: input.profile.thinkingOptionId,
    featureValues: input.profile.featureValues,
    systemPrompt: input.systemPrompt,
    mcpServers: input.mcpServers as any,   // 由 Paseo 校验
  },
});
```

`listProfiles` 失败（无权限 / 老版本）时抛出带 `code: "profiles-unavailable"` 的错误，UI 显示"无法读取 Paseo Profiles"，不崩溃。

### 5.1 标签协议（`client/paseo/labels.ts`）

```ts
export const LABELS = {
  run: "agent-team.run",       // runId
  team: "agent-team.team",     // team.id
  teamName: "agent-team.team-name",
  role: "agent-team.role",     // role.id
  roleName: "agent-team.role-name",
  instance: "agent-team.instance",   // instanceLabel，可无
  kind: "agent-team.kind",     // "coordinator" | "member"
} as const;
```

Crew Tree 只读标签，不依赖 Settings 里 Role 仍存在。

## 6. Profile 解析（`domain/profile-resolver.ts`，纯函数）

```ts
type Resolution =
  | { ok: true; profile: PaseoProfile; source: "member-override" | "role-preferred" | "role-fallback"; warnings: string[] }
  | { ok: false; reason: "no-candidates" | "all-missing" | "provider-unavailable"; tried: Array<{ ref: ProfileRef; status: "missing" | "provider-unavailable" }> };

resolveProfile(role: Role, member: TeamMember | null, profiles: PaseoProfile[], availability: ProviderAvailability[]): Resolution
```

顺序：`member.profileOverride` → `role.preferredProfiles`（按序）→ `role.fallbackProfiles`（按序）。每个候选：在 `profiles` 中按 `profileId` 查找，找不到记 `missing`；找到但 provider 不可用记 `provider-unavailable`；首个通过者胜出。任何阶段被跳过的候选都进入 `warnings`（"Preferred profile X is missing, using fallback Y"）。禁止任何其它兜底。

## 7. 启动流程（`domain/launch-plan.ts` + `launch/launch-team.ts`）

### 7.1 LaunchPlan（纯函数产物）

```ts
type PlannedAgent = {
  kind: "coordinator" | "member";
  role: Role; instanceLabel?: string;
  profile: PaseoProfile; source: string;
  title: string; labels: Record<string, string>; systemPrompt: string;
};
type LaunchPlan = {
  runId: string; team: Team; workspaceId: string; task: string;
  coordinator: PlannedAgent; members: PlannedAgent[];
  kickoffMessage: string;
  warnings: string[];          // 可继续
  blockers: string[];          // 非空则不能启动
};
buildLaunchPlan(input: { team; roles; profiles; availability; workspaceId; task; runId; maxMembers }): LaunchPlan
```

阻断条件（blockers）：Team 或 Coordinator Role 不存在/禁用；Coordinator Profile 无法解析；启用成员数为 0；启用成员数 > `maxMembers`；任一启用成员 Profile 无法解析（成员级解析失败是 blocker，不是静默跳过）。
警告条件（warnings）：成员 Role 被禁用被跳过；使用了 fallback；Coordinator provider 工具启用状态无法确认。

标题：Coordinator `"[Team] {team.name}: {task 前 30 字}"`；成员 `"{role.name}{instanceLabel ? " (" + instanceLabel + ")" : ""} · {team.name}"`；全部截断到 60 字符。

### 7.2 执行（`launchTeam(plan, adapter, onProgress)`）

```text
1. coordinatorId = adapter.createAgent({ ...coordinator, prompt: undefined })
2. for member of plan.members (顺序执行，不并发):
       id = adapter.createAgent({ ...member, parentAgentId: coordinatorId, prompt: undefined })
       created.push(id); onProgress(...)
3. adapter.sendMessage(coordinatorId, plan.kickoffMessage)   // 成员名册在此时才完整
4. 返回 { runId, coordinatorId, memberIds }，调用方写入 preferences.recentRuns（超过 20 条丢最旧）
失败处理：任一步抛错 → 若 preferences.archiveOnLaunchFailure，则对 created ∪ {coordinatorId} 逐个 adapter.archiveAgent（忽略单个失败），
          然后抛出 LaunchError { step, agentIdsKept: [] | ids, cause }；UI 显示步骤与原因。
```

不并发创建的原因：0.8.0 存在重复提交导致重复创建的缺陷（0.9 修复），顺序创建更稳；成员 ≤ 8 时耗时可接受。

## 8. Prompt 编译（`domain/prompt-compiler.ts`，纯函数）

### 8.1 成员 system prompt

```text
You are the {role.name}{instance} of the "{team.name}" team in Paseo.
Your coordinator is the agent "{coordinator.title}". Work only on tasks it sends you.

## Mission
{role.mission}

## Responsibilities
- {responsibilities...}

## Restrictions
- {restrictions...}
- Do not create, archive, or kill other agents unless the coordinator explicitly asks you to.
- Never call respond_to_permission; permission decisions belong to the human.

## Role instructions
{role.systemPrompt}

## When you finish a task, reply with
1. Summary
2. Evidence (files, commands, sources)
3. Decisions and open issues
4. Risks
5. Recommended next step
{outputContract 追加为 6..N}
```

### 8.2 Coordinator system prompt

```text
You are the {role.name}, coordinator of the "{team.name}" team in Paseo.
{8.1 中的 Mission / Responsibilities / Restrictions / Role instructions 段}

## How this team works
- Your team members are already running as your subagents. Their IDs and roles arrive in the first user message.
- Delegate with send_agent_prompt(agentId, prompt). Leave background/notifyOnFinish at their defaults and wait for finish notifications; do not poll.
- Prefer existing members. Only use create_agent for a role the roster lacks, and then call list_profiles first and copy the profile fields exactly.
- Never call respond_to_permission or kill_agent. Use cancel_agent only to stop a member you have redirected.
- Implementation and independent review must be done by different members when both roles exist.
- When two members would edit the same files at the same time, sequence them or ask one to work in a separate worktree via create_workspace.
- Finish by writing a synthesis for the human: what was done, evidence, open issues, and next steps.
{team.operatingRules 原文追加}
```

### 8.3 Kickoff 用户消息（启动后发送给 Coordinator）

```text
# Task
{task}

# Your team (run {runId})
| agentId | role | profile |
| {id} | {role.name}{instance} — {role.description ?? mission 首句} | {profile.name} ({provider/model}) |
...

# Rules
- Send each member only work that matches its role. Include the concrete files, constraints, and expected output in every prompt.
- Members are idle until you prompt them.
- Report back to the human when the task is complete or blocked.
```

编译器必须是确定性的（同输入同输出），以便快照测试。

## 9. UI 规格

### 9.1 注册（`index.client.tsx`）

```ts
client.addSurface("agent-teams", AgentTeamsSurface);
client.addSidebarItem({ id: "agent-teams", title: "Agent Teams", icon: "Users", surface: "agent-teams" });
client.addWorkspacePanel({ id: "crew", title: "Agent Crew", icon: "Network", context: "workspace", locations: ["explorer"], Component: AgentCrew });
client.addCommandCenterItem({ id: "open-agent-teams", context: "global", title: "Open Agent Teams", onSelect: ({ openSurface }) => openSurface("agent-teams") });
client.addCommandCenterItem({ id: "open-crew", context: "workspace", ... openPanel("crew", { location: "explorer" }) });   // 原有
client.addCommandCenterItem({ id: "launch-team", context: "workspace", title: "Launch agent team", onSelect: ({ workspace, openPanel }) => { /* 打开 crew 面板并触发 Launch 对话框（通过模块级事件总线传 workspaceId） */ } });
```

面板 id `crew` 与原插件一致，便于用户从 agent-crew 迁移时习惯不变。

### 9.2 AgentTeamsSurface

- 顶部标签：Roles | Teams。紧凑布局下为水平滚动 chips。
- Roles 列表行：颜色点、名称、描述、首选 Profile 名（Missing 时红色标记）、启用开关、"used by N teams"、操作（编辑、复制、删除）。
- Teams 列表行：名称、描述、Coordinator 名、成员数、警告角标（成员 Role 禁用/缺失、Profile Missing）、操作（Launch、编辑、复制、删除）。
- 空状态：说明文字 + "Import example teams" 按钮（写入 §10 模板，写入后设置 `templatesImportedAt`）。
- 所有 Settings 状态：`loading` 显示骨架；`error` 显示错误与重试；`invalid` 显示"存储的数据无法解析"+ 错误 + Reset 按钮（二次确认）。

### 9.3 RoleEditor（Modal 或全屏，紧凑布局下全屏）

字段顺序：Name → ID（新建时由 Name 自动生成 slug，可改；编辑时只读）→ Description → Color/Icon → Mission → Responsibilities（ListEditor：每行一个输入 + 删除 + 添加）→ Restrictions → System Prompt（多行，等宽字体）→ Output Contract → Preferred Profiles（ProfilePicker，多选有序）→ Fallback Profiles → Advanced: MCP servers（JSON 文本框，失焦时 JSON.parse 校验）→ Enabled。

保存：`RoleSchema.safeParse` 失败 → 字段级错误；通过 → 写整份 `roles` 文档（替换同 id 项或追加），`save(values, revision)`；返回 false 时读取 `saveError`，若含 "conflict" 则弹"内容已被其他客户端更新"并提供 Reload / Overwrite（Overwrite = reload 后再合并自己的这一项写回）。

### 9.4 ProfilePicker

- 打开时调用 `adapter.listProfiles()`（页面级缓存 60s，可手动刷新）。
- 每行：name、provider/model、modeId/thinking 简写、notes 前 80 字。
- 已选项显示为可拖动/上下移动的有序 chips；Missing 的已选项显示红色并可移除。

### 9.5 TeamEditor

Name / ID / Description → Coordinator（下拉，仅启用 Role）→ Members（MemberEditor 列表：Role 下拉、instanceLabel、Profile override 选择器、enabled、上下移动、删除；"Add member"）→ Operating rules（多行）→ Enabled。保存逻辑同 Role。

### 9.6 LaunchDialog

步骤 1 选择 Team（若从 Team 行进入则跳过）；步骤 2 任务文本；步骤 3 预览表（每行：Kind、Role、Profile、Source、状态图标），下方列出 warnings（黄）与 blockers（红）；按钮 "Launch" 在有 blockers 或加载中时禁用。启动中显示逐步进度（Creating coordinator… / Creating member 2 of 5… / Sending kickoff…）。成功后：Toast + 打开 crew 面板 + 高亮 runId 分组。失败：显示 LaunchError 的 step 与 cause，以及是否已归档。

### 9.7 Crew 面板改造（`client/crew/main.tsx`）

- 行内元数据第二行增加：`{roleName}{instance} · {teamName}`（读 labels），有 `color` 则复用颜色点。
- 顶部工具栏增加 "Launch team" 按钮（打开 LaunchDialog，workspaceId = 当前面板）。
- 应当：按 `agent-team.run` 标签分组的 RunHeader 行（Team 名 · task 摘要 · N agents），可折叠；无标签的 Agent 保持原有展示。
- 其余交互零改动。

## 10. 内置模板（`shared/templates`）

两套模板以 TypeScript 常量给出，`preferredProfiles` 为空数组（导入后由 UI 提示绑定；为通过 schema `min(1)`，导入时若主机存在 Profile，则按 provider 名匹配填入第一个 `provider === "claude"`/`"codex"` 的 Profile，否则填入任意第一个 Profile 并在 UI 标记"请确认"）。

Coding Team：`tech-lead`（Coordinator）、`planner`、`architect`、`backend-developer`、`frontend-developer`、`tester`、`reviewer`；operatingRules 含"实现者与审查者必须不同""并行改代码用独立 worktree"。
Research Team：`research-lead`（Coordinator）、`source-researcher`、`fact-checker`、`analyst`、`critic`；所有成员 restrictions 含 "Do not edit, create, or delete files."。

每个 Role 的 mission / responsibilities / restrictions / systemPrompt / outputContract 必须完整写出（每段 3–8 条），`templates.test.ts` 用 `RoleSchema`/`TeamSchema` 逐项校验。

## 11. 错误处理矩阵

| 情形 | 发生位置 | 处理 |
| --- | --- | --- |
| Settings loading | 任何页面 | 骨架屏，不渲染默认值 |
| Settings invalid | 任何页面 | 显示错误 + Reset（二次确认），其他文档不受影响 |
| 保存冲突 | 编辑器 | Reload / Overwrite 选择 |
| Role 被 Team 引用时删除 | Roles 列表 | 阻止，列出 Team |
| Team 引用的 Role 不存在 | Teams 列表 / 预览 | 列表警告角标；预览 blocker |
| Profile Missing | Roles 列表 / 编辑器 / 预览 | 红色标记；预览按 §6 解析，全部缺失为 blocker |
| Provider 不可用 | 预览 | blocker，注明 provider 与原因 |
| Profiles 读取失败 | ProfilePicker / 预览 | 错误提示 + 重试，不阻塞其他编辑 |
| 创建 Coordinator 失败 | 启动 | LaunchError(step="coordinator")，无需归档 |
| 创建第 k 个成员失败 | 启动 | 按偏好归档已建 Agent；报告 k 与 cause |
| 发送 kickoff 失败 | 启动 | 保留 Agent，提示用户可手动在 Coordinator 对话中重发（提供"复制启动消息"按钮） |
| navigation 缺失 | Crew | 隐藏"打开 Agent"跳转（沿用 agent-crew 行为） |

## 12. 兼容性规则（对未来 Paseo 版本）

1. **导入白名单**：仅 `@getpaseo/plugin`、`@getpaseo/plugin/client`、`@getpaseo/plugin/client/react-native`、`@getpaseo/plugin/client/ui`、`@getpaseo/plugin/server`。在 biome 配置中加 `noRestrictedImports` 禁止 `@getpaseo/protocol*`、`@getpaseo/server*`、`@getpaseo/client/internal*`；`@getpaseo/client` 仅允许 `client/paseo/adapter.ts` 与 `client/crew/crew.ts` 以 `import type` 使用。
2. **特性探测**：对 `navigation`、`settings` 句柄、`useHosts` 等一律 `typeof x === "function"` / 可选链判断，不做版本号判断。
3. **数据前向兼容**：所有 schema `passthrough()`；只存 Paseo 侧的稳定 id；显示用快照字段允许过期。
4. **manifest**：当前 `^0.8.0`。0.9 stable 发布后：在隔离环境跑完 §13 全部验收 → 改为 `>=0.8.0 <0.10.0` → 记录 CHANGELOG。禁止开放上界。
5. **双版本 typecheck**：`package.json` 增加 `typecheck:next` 脚本：`npm i --no-save @getpaseo/plugin@next @getpaseo/client@next @getpaseo/protocol@next && tsc --noEmit`（或以具体 beta 版本号替代 `next`）；CI 中作为允许失败的 job，失败时在 PR 中记录差异。
6. **已知 0.9 差异清单**（写入 README "Compatibility" 节并持续维护）：`registerSettings` 返回句柄；`navigation.openAgent/openWorkspace` 增加 `serverId`；新增 `useHosts / getPaseoClient / openExternalUrl / ExternalLink / navigation.openBrowser`；provider 事件增加 `toolCallId`；嵌套 provider 子代理父子关系修正。
7. **Profile 读取路径**：`config.get().agentProfiles` 被官方标注为过渡形态。若未来出现 profiles RPC，只改 `adapter.listProfiles()`。
8. **上游同步**：`UPSTREAM.md` 记录 agent-crew 导入 commit；`crew.ts` / `main.tsx` 的改动保持最小且集中，便于 cherry-pick 上游修复。

## 13. 测试策略

### 13.1 单元测试（vitest，无 daemon）

- `schemas.test.ts`：每个字段的边界、slug 规则、重复 id、Coordinator 不在 members、重复 Role 需 instanceLabel、passthrough 未知字段。
- `profile-resolver.test.ts`：覆盖 override / preferred / fallback / missing / provider-unavailable / 全失败，以及 warnings 文案。
- `prompt-compiler.test.ts`：快照测试三种 prompt；确定性；无 outputContract / restrictions 时的段落省略。
- `launch-plan.test.ts`：blockers 与 warnings 的每一条触发条件；标题截断；labels 完整性。
- `launch-team.test.ts`：mock `PaseoAdapter`，验证调用顺序、parentAgentId 传递、第 k 个失败时的归档行为、`archiveOnLaunchFailure=false` 时保留、kickoff 失败时不归档。
- `validation.test.ts`：Team→Role、Role→Profile 的交叉校验输出。
- `templates.test.ts`：模板通过 schema，Coordinator 不在 members，Research 成员均含不改文件的 restriction。
- 保留并通过 `crew.shared.test.ts`、`package-release.test.ts`。

### 13.2 手工验收（隔离 daemon，见 §15）

Crew 回归（来自 agent-crew README）：树正确、跨工作区 descendants、权限 Allow/Deny、Nudge、Redirect、Detach、Archive、实时更新、确认对话框存在。

新功能：PRD FR-1 ~ FR-10 的每条 AC；DoD 第 5、6、7 条的真实任务与错误路径录屏。

Harness 覆盖：Coordinator 用 Claude Code；成员至少含 Codex 与 Claude 各一；有 ACP 环境时加一个 Gemini/Grok 成员。

## 14. 实施阶段与 Issue 拆分

每个 Phase 一个 PR；PR 描述必须包含"验收清单"并逐项勾选。

### Phase 0 — Fork 基础（Issue #1）

工作：§2.1 的 1–5；`AGENTS.md`（§15 模板）；README 标题与安装命令；CI 配置更新；`npm ci && npm run check && npm run typecheck && npm test` 通过。
验收：隔离 daemon 上 `paseo plugin ls paseo-agent-team --host $DEV_HOST --json` 为 running；原 Crew 面板功能不变。

### Phase 1 — 数据层与 Server 入口（Issue #2）

工作：`shared/schemas/*`、`shared/settings.ts`、`index.server.ts`（仅 registerSettings）、`schemas.test.ts`。
验收：单测通过；在隔离 daemon 上用临时调试按钮或 devtools 确认三份文档可读写（读到默认值、写入后另一客户端可见）。

### Phase 2 — Agent Teams 页面 + Role CRUD（Issue #3、#4）

工作：`AgentTeamsSurface`、`RoleList`、`RoleEditor`、`ListEditor`、`SlugInput`、`ProfilePicker`、`adapter.listProfiles`、`validation.ts`（Role→Profile 部分）。
验收：FR-1、FR-2、FR-3（除启动部分）的 AC；紧凑布局可用；Missing Profile 显示正确。

### Phase 3 — Team CRUD（Issue #5）

工作：`TeamList`、`TeamEditor`、`MemberEditor`、`validation.ts`（Team→Role 部分）、删除保护。
验收：FR-4、FR-5 的 AC。

### Phase 4 — Profile 解析、Prompt 编译、Launch 计划（Issue #6）

工作：`profile-resolver.ts`、`prompt-compiler.ts`、`launch-plan.ts` 及三份测试；`adapter.listProviderAvailability`。
验收：单测覆盖 §13.1 所列条目；用固定输入生成的 prompt 快照经人工审阅。

### Phase 5 — 启动执行与对话框（Issue #7）

工作：`launch-team.ts` + 测试、`adapter.createAgent/sendMessage/archiveAgent`、`LaunchDialog`、`LaunchPreview`、Command Center 项、`recentRuns` 写入。
验收：FR-6 全部 AC；DoD 第 5 条（Coding Team 真实任务）在隔离 daemon 上完成并录屏。

### Phase 6 — Crew 面板增强（Issue #8）

工作：Role/Team 标签显示、Launch 按钮、Run 分组头。
验收：FR-7 AC；Crew 回归清单全过。

### Phase 7 — 模板与文档（Issue #9）

工作：两套模板 + 测试、空状态导入、README（安装 / 配置 / 启动 / 限制 / Compatibility）、CHANGELOG、`typecheck:next` 脚本与 CI job。
验收：FR-8；DoD 第 6、8、9 条。

## 15. 新插件目录 `AGENTS.md`（Phase 0 创建，内容如下）

```markdown
# paseo-agent-team development

## Protect the user's Paseo instance
- NEVER run plugin install/reload/enable/disable/update/remove against the CLI default host.
- NEVER use the default `~/.paseo` home. NEVER run bare `paseo reload|restart|daemon stop|daemon restart`.
- Unit tests and static checks need no daemon: `npm ci --ignore-scripts && npm run check && npm run typecheck && npm test`.
- Any runtime or UI check MUST use the dedicated daemon below with explicit `--home` / `--host` on every command.

## Dedicated development daemon (run from this directory)
1. Create `.paseo-dev/config.json` (ignored) with:
   {"version":1,"pluginsEnabled":true,"features":{"webUi":{"enabled":true}},"daemon":{"listen":"127.0.0.1:0","relay":{"enabled":false}}}
2. `npx --no-install paseo daemon start --home "$PWD/.paseo-dev"`
   `npx --no-install paseo daemon status --home "$PWD/.paseo-dev" --json`  → read `listen` as DEV_HOST
3. `npx --no-install paseo plugin ls paseo-agent-team --host "$DEV_HOST" --json`
   - absent → `npx --no-install paseo plugin install "$PWD" --host "$DEV_HOST"`
   - present with source `directory` and path == `$PWD` → `npx --no-install paseo plugin reload paseo-agent-team --host "$DEV_HOST"`
   - anything else → remove it on DEV_HOST, install `$PWD`, inspect again. Require `status: "running"` and no error.
4. Configure at least two Agent Profiles (different providers) on DEV_HOST before exercising Launch. Never copy profiles or credentials from `~/.paseo`.
5. Verify at `http://$DEV_HOST/`: sidebar "Agent Teams", explorer panel "Agent Crew", Command Center items. Create test agents only on DEV_HOST. Check error paths (missing profile, unavailable provider, save conflict) as well as the happy path.
6. `npx --no-install paseo daemon stop --home "$PWD/.paseo-dev"` when finished.

Before every daemon or plugin lifecycle command, re-read it and confirm `--home`/`--host` still points at `.paseo-dev`.
```

## 16. 与需求文档 v2（`paseo-agent-team-development-spec-v2.md`）的关系

本 Spec 取代 v2 中的 Workflow / Router / Run 状态机 / Evidence / Managed Workflow / Video 模板 / YAML 导入导出（全部移出 V1）。保留并细化了 v2 的 Role、Team、Profile Resolver、Crew 增强、单插件与不 fork Core 的原则。v2 中与 0.8.0 SDK 事实冲突的部分（`agent.create` hook 注入、toolPolicy 预设、Server 端读 Settings、Coordinator 现场 `create_agent` 注入 systemPrompt）已按 §1 修正。

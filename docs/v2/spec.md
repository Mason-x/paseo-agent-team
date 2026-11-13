# Agent Team v2 技术规格（Spec）

- 状态：方向已由用户确认（2026-11-12，见 PRD 第 10 节），M1a 探针已于 2026-11-12 在 0.15.4 上跑完，结果见 [M1a 结果](m1a-results.md)，本文已据此修订。开发直接从 M1a 开始，没有前置的对照实验。编写：2026-11-12。
- 配套文档：[PRD](prd.md)、[调研记录](research.md)。v1 的结论见 [M1 结果](../m1-results.md)。
- 本文回答"怎么做"。"为什么做、做到什么算成"在 PRD 里。两者冲突时以 PRD 为准。

## 1 一句话设计

**一个任务 = 一个 Run = 一个写手 + 一个 worktree + 一条分支 + 一个 PR。** 其他 agent 的改动都不进入这条分支：审查者各有一个用完即删的独立 worktree，产出只有报告文件。验收命令由插件自己跑，审查结论绑定到具体提交。状态机只有 7 个状态，卡住时交给人，不做自动恢复。

## 2 术语

| 术语 | 含义 |
| --- | --- |
| Run | 一次任务的完整过程，从任务说明确认到合并或放弃 |
| 写手（writer） | Run 里唯一允许改代码的 agent |
| 审查者（reviewer） | 干净上下文、在自己的一次性 worktree 里工作、只交报告和结论的 agent |
| 席位（seat） | 一个 Run 里 agent 的编号：`writer`、`r1`、`r2`、`r3` |
| 侦察兵（scout） | 开工前试做一遍、代码不合并、只留报告的 agent |
| 调研员（researcher） | 并行回答独立问题的只读 agent |
| 门禁（gate） | 插件在写手的 worktree 里执行的验收命令 |
| 候选提交 | 写手提交送审时的 `HEAD` 提交 |

## 3 已核实的 Paseo 能力与限制

依据：<https://paseo.sh/docs/plugins/hooks.md>、`plugins/reference.md`、`worktrees.md`、`mcp.md`、`orchestration.md`（2026-11-12 抓取），本机 `@getpaseo/plugin` 0.16.0-beta.2 的类型声明，以及 Paseo 源码 `/home/mcc/Projects/paseo`（提交 `9e607a3aa`，版本 0.16.0-beta.2）。本机安装的 Paseo 为 0.15.4，比读到的源码旧一个版本；3.1 与 3.3 中标注"0.15.4 实测"的内容来自 M1a 探针，以实测为准。

### 3.1 可以依赖的能力

| 能力 | 接口 | v2 用它做什么 |
| --- | --- | --- |
| 给指定 agent 挂工具 | `defineAgentTool` + `agent.open.before` | 写手的 `team_submit`、审查者的 `team_verdict` |
| 工具在插件进程里执行 | `execute(input, { agent, paseo, signal })` | 工具里直接读 git、写状态、创建 agent |
| 回合结束通知 | `agent.turn.after`，带 `outcome` | 发现"写手没提交就停了" |
| 给 agent 发后续消息 | `paseo.agents.ref(id).send()` | 把门禁输出、审查意见发回写手 |
| agent 标签 | `labels`：创建 agent 时设置，`agent.open.before` 里可读（0.15.4 实测）。注意：`metadata` 和 `setMetadata` 是 0.16 的能力，**0.15.4 没有**，agent 和工作区都没有 | 标记 agent 属于哪个 Run、什么角色。工作区靠分支名 `team/<runId>/…` 识别（工作区 `name` 即分支名） |
| 创建 worktree 工作区 | `paseo.workspaces.create({ source: { kind: "worktree" } })` | 写手一个 worktree 和分支；每个审查者每轮一个一次性 worktree |
| worktree 创建后写文件 | `worktree.create.after`（等待型） | 写入 `.team/` 目录 |
| 启动时注入环境变量 | `agent.open.before` 的 `env` | 每个 Run 独立的 `DATABASE_URL` 等 |
| 自动回答权限请求 | `agent.permission.before` + `respondToPermission`（0.15.4 实测可用） | **P0 要用**：非自动批准模式下，agent 调用插件工具会停在权限请求上。插件只放行自己的 `team_*` 工具，其余不碰（匹配规则见 3.3） |
| 每个 worktree 独立端口 | `paseo.json` 的 service 与 `$PASEO_PORT` | 端口隔离直接用宿主能力，不自己做 |
| 后台工作区 | `workspaces.create({ background: true })`（0.15.4 实测可用；默认列表不显示，`includeBackground: true` 才显示） | 审查工作区不占侧栏 |
| 后台 agent | `background: true`（0.16 起，0.15.4 的钩子类型里没有） | 调研员不占标签页，按特性探测启用 |
| Agent Profile 与备注 | 宿主设置、`list_profiles` | 取代 v1 的 Role 目录 |

### 3.2 必须绕开的限制

| 限制 | 对设计的约束 |
| --- | --- |
| 钩子事件"尽力而为"，不重放、不持久、不重试 | 状态不能靠事件累积。每个状态都要能从 git、状态文件和 agent 快照重新算出来 |
| 等待型钩子 30 秒超时 | 钩子里不跑门禁，只做登记 |
| 工具调用 10 分钟上限 | 门禁不在工具调用里同步跑。工具只负责登记并立即返回 |
| 插件追加的时间线行在 daemon 重启后丢失 | 时间线行只做展示，不当记录用 |
| 插件加载或重载会让已开的会话在下次空闲时重开 | 开发时不在有活跃 Run 的宿主上重载 |
| `paseoTools` 策略不是安全边界 | 不靠工具屏蔽。审查者用独立 worktree 隔离，再对写手的 worktree 做事后检查（7.3） |
| 工具名冲突会让会话打不开 | 所有工具统一前缀 `team_` |

### 3.3 尚未实测、动手前要先验证的点

读源码后的结论（只读了代码，没有运行）：

| 问题 | 源码显示 | 位置 |
| --- | --- | --- |
| 插件工具是否依赖"启用 Paseo 工具" | **依赖。** 插件工具是并入 Paseo 工具目录下发的；宿主关闭 `injectIntoAgents`，或该 provider 的 `paseoTools.enabled` 为 `false` 时，内置 MCP 服务不会注入，插件工具到不了 agent | `agent-manager.ts` 的 `prepareSessionConfig`、`buildLaunchContext`；`agent/tools/plugin-tools.ts` |
| `agent.turn.after` 何时触发 | 只在流里出现 `turn_completed`、`turn_failed`、`turn_canceled` 三种事件时触发。provider 进程直接消失而没有发出这些事件时不会触发 | `plugins/lifecycle/index.ts` 的 `publishAgentStream` |
| 插件工具与 `addHook` 从哪个版本开始 | CHANGELOG 把"给指定 agent 挂工具"记在 0.14.0，把 `server.addHook` 记在 0.15.0（文档写的是 0.14） | `CHANGELOG.md` |

由此得到两条设计约束：

- **v2 要求宿主打开"启用 Paseo 工具"。** 启动对话框检查这个开关和所选 Profile 的 provider 策略，不满足时阻止启动并说明原因。副作用是写手同时拿到 `create_agent` 等宿主工具，可以自己再派 agent。提示里禁止它派出会写文件的 agent；7.3 的事后检查和 AC11 负责发现违规。
- **回合结束通知会漏。** 6.4 的对账是推进状态的主路径，通知只是让它更快。

M1a 探针（162 行，`probe/m1a/`）已在隔离的 DEV daemon（0.15.4）上实测，原始记录在 `probe/m1a/evidence/out.jsonl`，完整结论见 [M1a 结果](m1a-results.md)：

| # | 点 | 0.15.4 实测结果 | 对设计的影响 |
| --- | --- | --- | --- |
| 1 | `defineAgentTool` 与 0.16 类型是否一致 | 工具可用，`execute` 在插件进程里运行，`agent` 上下文有值。三处差异：钩子参数是 `{ request }`、直接返回改过的 request；没有 `metadata`；没有 `background` | 3.1 已改；写钩子按 0.15.4 的签名 |
| 2 | 工具怎么下发、名字带不带前缀 | Claude 和 Codex 都经内置 MCP 服务 `paseo` 下发，agent 侧名字是 `mcp__paseo__team_*`。Codex 的权限请求里写作 `tool "team_*"` | 提示里只写基本名（`team_submit`），不写前缀 |
| 3 | `baseRef` 能否传提交哈希 | **可以。** `source: { kind: "worktree", action: "branch-off", baseBranch: <sha>, branchName }`，worktree 的 `HEAD` 等于该提交，约 0.9 秒 | 7.2.1 不需要先建临时分支 |
| 4 | 审查 worktree 的准备耗时 | `create` 返回时 `setup` 还没跑完，它在后台异步运行；工作区描述符的 `setupStatus` 依次为 `running`，然后 `completed` 或 `failed`。耗时约等于 `setup` 本身加 1 秒。热缓存 `npm ci`（v1 包）12 秒，`node_modules` 863 MB | 7.2.1 要轮询 `setupStatus`；磁盘按 863 MB 乘 worktree 数估算 |
| 5 | 能否建后台工作区 | **可以。** 默认列表看不到，`includeBackground: true` 看得到 | 审查工作区建成后台工作区，不占侧栏 |

探针额外确认的三件事：

- 条件挂载：`agent.open.before` 里按 `labels["agent-team.role"]` 判断，带标签的 agent 看得到工具，不带的看不到。
- 自动放行：`agent.permission.before` 里调 `paseo.agents.ref(id).respondToPermission({ requestId, response: { behavior: "allow" } })`，Claude（default 模式）和 Codex 都验证通过。匹配规则有两种：Claude 的请求 `name` 是 `mcp__paseo__team_*`；Codex 的 `name` 是 `CodexMcpElicitation`，要看 `metadata.serverName === "paseo"` 且 `description` 含 `tool "team_*"`。
  - 产品里的匹配要比探针严：只对带 `agent-team.run` 标签的 agent 放行；工具名必须**完整等于**该角色实际挂载的某个工具（Claude 侧是 `mcp__paseo__` 加工具名，不接受其他 MCP 服务下同名的 `team_*`；Codex 侧从 `description` 里取出引号内的名字再比对）。探针用的是宽松的正则 `(^|__)team_[a-z_]+$`，不要照搬。
  - 匹配不上就不放行，请求留给人，面板显示"有一个权限请求在等"。
  - 样本量：Claude、Codex 的自动放行各只成功过 1 次（N=1）。
- `agent.turn.after` 在 Claude 和 Codex 上都以 `completed` 触发。"provider 进程直接消失时不触发"仍然只是读源码的结论，没有实测，对账照旧兜底。

没有实测的：Claude、Codex 以外的 provider（Copilot、OpenCode、Pi 等）的工具下发与权限请求形态；agent 在 `setup` 完成前创建会怎样（探针总是等到 `completed` 才继续，v2 也这样做）。

任何一条与本文不符，回到本文修订对应章节。

## 4 架构

```
人 ──(任务说明 / 合并决定 / 卡住时的处置)──┐
                                           ▼
┌─────────────── 插件（daemon 子进程）───────────────┐
│ Run 存储      一个 Run 一个 JSON 文件，原子写入      │
│ 状态机        纯函数：(run, 事实) → 下一步动作       │
│ 门禁执行器    在 worktree 里跑冻结的命令，存输出     │
│ 工具          team_submit / team_block / team_verdict │
│ 钩子          turn.after、open.before、permission    │
│ RPC           给界面用：列表、详情、人的操作         │
└───────────────────────────────────────────────────┘
        │ send()            ▲ 工具调用
        ▼                   │
   写手（worktree W）          审查者 r1（worktree R1，检出候选提交，用完即删）
        │                      审查者 r2（worktree R2，可选）…
        │                           │ 报告由插件复制回 W
        └── .team/ 目录：task.md、progress.md、reviews/、gate/
```

模块与体量预算（源码，不含测试）：

| 模块 | 职责 | 预算 |
| --- | --- | --- |
| `shared/run.ts` | Run 的 Zod 模式、状态枚举 | 200 行 |
| `shared/machine.ts` | 状态迁移纯函数 | 300 行 |
| `server/store.ts` | 读写 Run 文件（临时文件加重命名的原子写入。**没有复用 v1 的 `atomic-json`**：宿主的插件构建器不允许 import 插件目录之外的模块，拷贝它有 600 多行） | 150 行 |
| `server/gate.ts` | 跑命令、超时、截断并保存输出 | 250 行 |
| `server/git.ts` | `HEAD`、是否干净、改动文件、是否落后于基线、删除临时分支 | 200 行 |
| `server/roles.ts` | 创建写手；创建和清理审查者及其 worktree；拼提示 | 350 行 |
| `server/tools.ts` | 三个工具 | 200 行 |
| `server/hooks.ts` | 四个钩子 | 150 行 |
| `server/rpc.ts` | 界面用的 RPC | 250 行 |
| `client/` | 一个工作区面板、一个列表页、一个新建对话框 | 900 行 |
| 合计（原预算，已被下面的修订取代） | | 不超过 3000 行 |

M1b 的实际行数（2026-11-12，含空行和注释，不含测试）：`shared/run.ts` 190、`shared/machine.ts` 379、`shared/rpc.ts` 105、`server/store.ts` 101、`server/gate.ts` 235、`server/git.ts` 102、`server/roles.ts` 328、`server/tools.ts` 125、`server/hooks.ts` 156、`server/rpc.ts` 98，另有预算外的 `server/engine.ts` 434（按 Run 串行的锁、事件分发与副作用、对账、启动流程）、`server/host.ts` 209（Paseo 的结构化端口和适配层，biome 禁止直接 import `@getpaseo/client`）、`index.server.ts` 72。合计 **2534 行**，`client/` 只剩约 466 行，低于原计划的 900。`machine.ts` 超预算 79 行，`hooks.ts` 超 6 行。

**预算修订（用户决定，2026-11-12）：总上限从 3000 行提到 3500 行。**

| 部分 | 上限 | 说明 |
| --- | --- | --- |
| 服务端与共享代码（`shared/`、`server/`、`index.server.ts`） | 2550 行 | 按 M1b 的现状（2534 行）冻结。不为凑数去压缩 `machine.ts` 和 `engine.ts` |
| `client/` 与 `index.client.tsx` | 900 行 | 保持原计划 |
| 合计 | **不超过 3500 行** | 留约 50 行余量 |

修订原因：原预算漏了两个必要的模块，编排层 `engine.ts`（434 行）和宿主适配 `host.ts`（209 行），不是功能增加。

规则：

- 这是唯一一次放宽。之后服务端每净增一行，都要在对应的结果文档里写明理由；要再次提高上限，必须先回到 PRD 由用户决定。
- 界面写不进 900 行时，先削减界面范围（例如列表页只留最少字段），不挪用服务端的额度，也不提高总上限。
- 3500 行仍是硬约束，v1 的教训在这里。

## 5 数据

### 5.1 Run 文件

位置：`<PASEO_HOME>/agent-team-v2/runs/<runId>.json`。这是状态的唯一来源，只有插件写。

```ts
interface Run {
  schemaVersion: 1;
  id: string;                 // 例：r-20261112-a3f9，由插件生成
  title: string;
  state: "writing" | "gating" | "reviewing" | "ready"
       | "blocked" | "merged" | "abandoned";
  blockedReason?: BlockedReason;

  repo: { sourceCheckout: string; baseRef: string; baseSha: string };
  workspace: { id: string; path: string; branch: string };

  task: {
    file: ".team/task.md";
    gateCommands: GateCommand[];     // 启动时冻结，之后不再读文件
    protectedPaths: string[];        // 写手不许改的路径（glob）
    allowedPaths?: string[];         // 可选：写手只许改这些路径
  };

  writer: { agentId: string; profile: string; family: string };
  limits: { maxGateAttempts: number; maxReviewRounds: number; stallMinutes: number };

  attempts: GateAttempt[];           // 每次门禁一条
  reviews: Review[];                 // 每次审查一条
  approved?: { sha: string; reviewIds: string[] };   // 本轮每个席位各一条
  lastProgressAt: string;            // ISO 时间
  createdAt: string;
  closedAt?: string;
}

interface GateCommand { name: string; command: string; timeoutSec: number }

interface GateAttempt {
  n: number;
  sha: string;
  startedAt: string;
  finishedAt?: string;
  result?: "pass" | "fail" | "error";
  checks: { name: string; exitCode: number | null; durationMs: number; logFile: string }[];
  policyViolations: string[];        // 例：改了受保护路径
}

interface Review {
  id: string;
  round: number;
  sha: string;                       // 审查针对的提交
  seat: "r1" | "r2" | "r3";
  reviewer: { agentId: string; profile: string; family: string };
  workspace: { id: string; path: string; branch: string; removedAt?: string };  // 审查者自己的一次性 worktree
  verdict?: "approve" | "request-changes";
  blocking: number;
  reportFile: string;                // .team/reviews/<round>-<seat>.md
  void?: "writer-worktree-changed" | "no-verdict";
}

type BlockedReason =
  | "gate-attempts-exhausted" | "review-rounds-exhausted"
  | "writer-stopped-without-submit" | "writer-asked-human"
  | "writer-worktree-changed-during-review" | "review-setup-failed"
  | "agent-failed" | "stalled";
```

没有事件日志，没有 reducer 回放，没有租约。一个 Run 一个文件，改一次整体原子重写一次。

### 5.2 worktree 里的 `.team/` 目录

给 agent 读写的内容放这里，路径固定，提示里只给路径不贴正文。下表是写手 worktree 里的完整内容；审查 worktree 里只有其中一部分，见 5.2.1。

| 文件 | 谁写 | 内容 |
| --- | --- | --- |
| `.team/task.md` | 人（启动时），之后只读 | 任务说明，模板见 5.3 |
| `.team/progress.md` | 写手 | 做了什么、试过但失败的路、下一步 |
| `.team/scout.md` | 侦察兵（可选） | 动了哪些文件、从哪下手、坑在哪 |
| `.team/research/<n>.md` | 调研员（可选） | 每个问题一份 |
| `.team/reviews/<round>-<seat>.md` | 审查者在自己的 worktree 里写，插件复制过来 | 审查报告 |
| `.team/reviews/<round>-response.md` | 写手 | 对上一轮各条阻断意见的回应：已改，或不改及理由 |
| `.team/gate/<n>/<check>.log` | 插件 | 门禁的完整输出 |

`.team/` 通过仓库公共目录的 `info/exclude` 忽略，不改项目的 `.gitignore`，也不进 PR。Run 结束时插件把整个目录复制到 `<PASEO_HOME>/agent-team-v2/archive/<runId>/`，worktree 删掉后记录还在。`info/exclude` 在公共目录里，所以对写手和审查者的 worktree 都生效。

#### 5.2.1 审查 worktree 里的 `.team/`

审查 worktree 建好后、审查者创建之前，由插件写入。审查者能看到的写手侧信息只有这些：

| 文件 | 来源 | 说明 |
| --- | --- | --- |
| `.team/task.md` | 从写手 worktree 复制 | 任务说明 |
| `.team/review-brief.md` | 插件生成 | 基线提交、候选提交、查看改动的命令、分级标准、报告要写到的路径 |
| `.team/reviews/<上一轮>-*.md` | 从写手 worktree 复制 | 第二轮起才有：上一轮所有审查者的报告和写手的回应 |
| `.team/reviews/<round>-<seat>.md` | 审查者写 | 本轮本席位的报告 |

不复制 `progress.md`、`scout.md`、`research/`、`gate/`，也不复制本轮其他审查者的任何东西。审查者想知道测试结果就自己跑。

### 5.3 任务说明模板

```markdown
# <标题>

## 要什么结果
## 相关代码在哪
## 约束
## 不做什么
## 不能碰的文件
## 怎么验证
```

"怎么验证"一节里的命令和"不能碰的文件"由启动对话框解析成 `gateCommands` 与 `protectedPaths`，人确认后冻结进 Run 文件。之后写手即使改了 `task.md`，门禁跑的仍是冻结的那一份。

### 5.4 项目配置

仓库根目录可选的 `paseo-team.json`，提供默认值，启动对话框里可以改：

```json
{
  "gate": [
    { "name": "typecheck", "command": "npm run typecheck", "timeoutSec": 300 },
    { "name": "test", "command": "npm test", "timeoutSec": 900 }
  ],
  "protectedPaths": ["tests/**", ".github/**", "paseo-team.json"],
  "env": { "DATABASE_URL": "postgres://localhost/app_{runId}" },
  "limits": { "maxGateAttempts": 5, "maxReviewRounds": 3, "stallMinutes": 15 }
}
```

宿主级设置（用插件的持久化设置存）：写手、审查者、侦察兵各用哪个 Agent Profile；同时活跃的 Run 上限（默认 3）。

## 6 状态机

```
            ┌──────────── request-changes ────────────┐
            ▼                                         │
 启动 → writing ──team_submit──▶ gating ──通过──▶ reviewing ──approve──▶ ready ──▶ merged
            ▲                      │                                       │
            └───── 失败（附输出）──┘                                       └──▶ abandoned
   任一活动状态 ──超限 / 出错 / 写手求助──▶ blocked ──人处置──▶ writing / gating / reviewing / abandoned
```

### 6.1 迁移表

| 当前 | 触发 | 条件 | 动作 | 下一状态 |
| --- | --- | --- | --- | --- |
| — | 人启动 Run | 任务说明已确认，活跃 Run 未超上限 | 建 worktree、写 `.team/`、建写手并发任务提示 | `writing` |
| `writing` | 写手调 `team_submit` | 工作区干净 | 记录候选提交，工具立即返回"已登记，结束本回合" | `gating` |
| `writing` | 写手调 `team_submit` | 工作区有未提交改动 | 工具返回错误和未提交文件列表 | `writing` |
| `writing` | 写手回合结束，没调任何工具 | 第一次 | 发一条提醒 | `writing` |
| `writing` | 同上 | 第二次 | — | `blocked` |
| `writing` | 写手调 `team_block` | — | 记录原因 | `blocked` |
| `gating` | 门禁全部通过，无策略违规 | 所有审查席位的 worktree 和 agent 都建好（7.2.1） | — | `reviewing` |
| `gating` | 门禁通过，但某个审查 worktree 建不起来或 `setup` 失败 | — | 清理本轮已建的审查 worktree | `blocked` |
| `gating` | 门禁失败或有策略违规 | 次数未超限 | 把失败检查的输出文件路径和末尾 80 行发给写手 | `writing` |
| `gating` | 同上 | 次数超限 | — | `blocked` |
| `reviewing` | 某个审查者调 `team_verdict` | 本轮还有审查者没给结论 | 收报告，清理该审查者（7.2.2） | `reviewing` |
| `reviewing` | 本轮最后一个结论到达，全部是 `approve` | 写手 worktree 检查通过（7.3） | 收报告，清理，记录批准 | `ready` |
| `reviewing` | 本轮最后一个结论到达，至少一个 `request-changes` | 写手 worktree 检查通过，轮次未超限 | 收报告，清理，把本轮全部报告的路径一次发给写手 | `writing` |
| `reviewing` | 同上 | 轮次超限 | 收报告，清理 | `blocked` |
| `reviewing` | 任一结论到达时，写手 worktree 检查不通过 | — | 本轮全部审查作废，清理所有审查者 | `blocked` |
| `reviewing` | 审查者回合结束，没给结论 | — | 提醒一次，再没有则该次审查作废并清理 | `blocked` |
| `ready` | `HEAD` 变了 | — | 清除批准 | `writing` |
| `ready` | 基线分支前进 | — | 只标记"基线已变"，不改状态 | `ready` |
| `ready` | 人确认已合并 | — | 归档 agent 与工作区，存档 `.team/` | `merged` |
| 任意 | 人放弃 | — | 同上 | `abandoned` |
| `blocked` | 人选择处置 | — | 见 6.3 | 视选择而定 |

### 6.2 三条不变式

1. **批准绑定提交。** `ready` 成立当且仅当：存在一次通过的门禁，并且同一轮里每个审查席位各有一次有效的批准，它们的 `sha` 都等于写手 worktree 当前的 `HEAD`。写手在批准后再提交任何东西，批准自动失效。这条针对 v1 链路里"最终候选没有复审"的问题。
2. **门禁命令不可变。** 门禁只执行 Run 文件里冻结的命令，执行前不读 worktree 里的任何配置。
3. **写手唯一。** 一个 Run 的生命周期里只有一个写手 agent。写手换人等于放弃旧 Run、开新 Run（可以沿用分支）。

### 6.3 `blocked` 时人能做的事

| 原因 | 可选处置 |
| --- | --- |
| 门禁次数用完 | 再给 N 次；自己看日志后给写手留言；放弃 |
| 审查轮次用完 | 再给一轮；直接接受当前提交（记录为"人工越过审查"）；放弃 |
| 写手没提交就停了 | 留言后继续；放弃 |
| 写手求助 | 回答后继续 |
| 审查期间写手的 worktree 变了 | 查看改动；从当前提交重新送审（回到门禁）；放弃 |
| 审查 worktree 建不起来 | 查看 `setup` 输出；重试；放弃 |
| agent 出错或 15 分钟无进展 | 重试当前步骤；放弃 |

每一种都由人点一次按钮，插件不自动选择。

### 6.4 对账

事件可能丢，所以不靠事件推进。`reconcile(run)` 是一个纯读函数，由三处调用：插件启动时、界面打开 Run 时、每 60 秒一次的定时器（只对活动状态的 Run）。它只看五样事实：Run 文件、写手 worktree 的 `HEAD` 与是否干净、相关 agent 的状态快照、是否有门禁进程在跑、属于这个 Run 的工作区列表（按工作区 `name` 找：它等于分支名，以 `team/<runId>/` 开头）。

| 发现 | 处理 |
| --- | --- |
| `gating`，但没有在跑的门禁，最后一次尝试没有结果 | 重新跑门禁（门禁是幂等的） |
| `writing`，写手空闲，超过 `stallMinutes` 没有进展 | → `blocked(stalled)` |
| `reviewing`，审查者已归档或出错，没有结论 | → `blocked(agent-failed)` |
| `reviewing`，写手 worktree 的 `HEAD` 不等于送审提交 | 本轮作废，清理审查者，→ `blocked(writer-worktree-changed-during-review)` |
| 存在属于这个 Run、但不对应当前轮次未完成审查的审查工作区或 `team/<runId>/review-*` 分支 | 归档工作区，删除分支。Run 已结束时同样清理 |
| `ready`，`HEAD` 不等于批准的提交 | 清除批准，→ `writing` |
| 工作区或写手已不存在 | → `blocked(agent-failed)` |

定时器不调用任何模型，只读本地状态。

## 7 角色

### 7.1 写手

- 在 Run 的 worktree 工作区里创建，标签 `agent-team.run=<runId>`、`agent-team.role=writer`。
- 工具：`team_submit`、`team_block`。
- 首条提示是模板加路径：读 `.team/task.md`；有 `.team/scout.md` 就先读；把过程记进 `.team/progress.md`；做完先提交再调 `team_submit`；不许为了通过测试而删改测试；改不动的地方调 `team_block` 说明。
- 提示里不贴任务正文，只给路径。

### 7.2 审查者

- 默认 1 个，启动对话框里可以添加，最多 3 个，每个选自己的 Profile。同一轮的审查者同时开始，各写各的报告，互相看不到对方的报告。
- 有多个审查者时：全部批准才进入 `ready`；任何一个打回，等本轮其余审查者都给出结论后，把所有报告路径一次发给写手。
- 每轮新建，结论提交后立即清理。不复用上一轮的审查者，也不复用上一轮的 worktree。
- **新会话是硬要求，跨家族是默认偏好。** 调研显示稳定有效的是干净上下文；跨家族带来互补覆盖，但轻量的跨模型审查者没有增益（见[调研记录](research.md)第 6 节）。启动对话框检查两个 Profile 的家族，相同时给出警告，不阻止。审查者 Profile 应当选强模型。
- 审查说明固定为：对照 `task.md` 查正确性和遗漏的测试，不评风格，每条意见标"阻断"或"建议"。只有阻断项触发返工。
- 写手收到打回后，可以对照任务说明逐条写明"已改"或"不改及理由"，写在 `.team/reviews/<round>-response.md`。下一轮审查者会读到上一轮报告和这份回应。这是为了避免审查者每轮都找出新问题、写手照单全收而打转。
- **每个审查者一个独立的 worktree**（用户决定，2026-11-12），检出的是候选提交。细节见 7.2.1 和 7.2.2。
- 提示只给两个路径：`.team/task.md` 和 `.team/review-brief.md`。
- 不给它看写手的对话，也不给 `progress.md`。它能看到的写手侧信息以 5.2.1 的表为限。
- 工具：`team_verdict`。
- **审查者的 Profile 必须是允许写文件、允许执行命令而不逐次等人批准的模式**（用户决定，2026-11-12）。审查者要写报告、跑测试，M1b 冒烟里 Codex 默认模式的审查者停在文件写入的权限请求（`CodexFileChange`）上，Run 走不下去。规则见 7.2.3。

#### 7.2.1 审查 worktree 的建立

门禁通过后，插件对每个审查席位做：

1. 确认写手 worktree 的 `HEAD` 仍等于送审提交。
2. 用 `paseo.workspaces.create` 建 worktree 工作区：起点是送审提交，分支名 `team/<runId>/review-<round>-<seat>`，由插件生成，`baseBranch` 直接传提交哈希（M1a 实测可行）。0.15.4 的工作区没有 metadata，靠分支名识别，工作区 id 同时记进 Run 文件。建成后台工作区（`background: true`，M1a 实测可用），不占侧栏。
3. 宿主照常执行 `.worktreeinclude` 的复制和 `paseo.json` 的 `setup`，审查者需要能跑测试，所以不跳过。`setup` 在 `create` 返回后异步运行，插件轮询工作区描述符的 `setupStatus`：`completed` 才继续；`failed`、`blocked` 或超时都按建不起来处理。
4. 写入 5.2.1 的文件。
5. 在这个工作区里创建审查者，标签 `agent-team.run`、`agent-team.role=reviewer`、`agent-team.round`、`agent-team.seat`，`env` 按席位展开（第 11 节）。

所有席位都建好后 Run 才进入 `reviewing`。任何一步失败：清理本轮已经建好的，Run 进入 `blocked(review-setup-failed)`。

为什么不让审查者直接检出写手的分支：git 不允许同一条分支同时被两个 worktree 检出。用临时分支而不是游离的 `HEAD`，是因为宿主的 worktree 创建接口以分支为单位：`branch-off` 必须给 `branchName`，起点可以直接是提交哈希（M1a 已实测）。

#### 7.2.2 结论提交后的清理

`team_verdict` 被调用时，插件按顺序做：

1. 检查审查 worktree 里的报告文件存在且非空，否则工具返回错误，让审查者补写。
2. 把报告复制到写手 worktree 的同一路径，并复制到 Run 的存档目录。从这一步起，Run 文件里的 `reportFile` 指向写手 worktree 里的那一份。
3. 做 7.3 第 3 层的检查，结果写入 Run 文件。
4. 归档审查者和它的工作区（宿主在最后一个引用归档后删除 worktree，并执行 `teardown`），删除临时分支，在 `Review.workspace.removedAt` 记时间。

审查 worktree 里的其他东西一律丢弃，包括审查者为了复现问题写的探针测试、改过的源码、构建产物。审查者想让写手看到的内容必须写进报告。

第 4 步失败不影响结论的记录，对账会补做清理（6.4）。

#### 7.2.3 审查者的权限模式

- **启动时检查，不满足就阻止启动。** `run.start` 检查每个审查席位的 Profile：`modeId` 必须在下表的允许列表里。没有设 `modeId`，或设的是需要逐次批准的模式，都拒绝启动，并说明是哪个席位、应当改成什么。只给警告不够，因为这种 Run 一定会卡住。
- **插件不扩大自动放行的范围。** `agent.permission.before` 仍然只放行自己的 `team_*` 工具（3.3）。不自动放行文件写入和命令执行：那等于由插件替用户做了权限决定，而且要解析各 provider 不同形态的请求。
- 允许列表按 provider 维护，只收实测过的：

  | Provider | 允许的 `modeId` | 状态 |
  | --- | --- | --- |
  | Claude Code | `auto` | 工具调用不需要批准已在 M1a 实测；审查全流程待 M1b 补充冒烟 |
  | Codex | `full-access` | 已实测（N=1）：`gpt-6-luna` 审查者在 DEV 上写报告、调 `team_verdict`、走到 `ready`，全程没有权限请求，见 [M1b 结果](m1b-results.md) 第 8 节。用户已批准这次实测。**`full-access` 下不会弹 MCP 权限请求，所以 Codex 形态的自动放行在这条路上没有被用到**，该能力只有 M1a 在默认模式下的 N=1 记录 |
  | 其他 | 无 | 没有实测前不能当审查者 |

- 写手不受这条限制：写手停在权限请求上时，面板会显示"有权限请求在等"，人可以处理。写手 Profile 没设 `modeId` 时保留启动警告。
- 代价要对用户说明白：审查者在自己的 worktree 里不受权限提示约束，而 worktree 不是安全边界（第 11 节）。兜底是 7.3 第 3 层对写手 worktree 的事后检查，它管不到仓库之外的写入。

### 7.3 怎么保证审查者不影响写手的分支

"只读"在 v2 里的含义是：审查者的任何改动都不进入写手的分支和 worktree。它在自己的 worktree 里可以随意读写和跑测试。

分三层：

1. **独立 worktree（结构保证）。** 审查者的工作目录不是写手的 worktree，正常的编辑、测试、构建都落在它自己的目录里，结束后整个删除。临时分支不合并、不推送，随后删除。
2. **提示。** 写明：只在当前目录里工作；不推送；不操作其他分支和其他 worktree；要交付的内容只有报告文件。
3. **对写手 worktree 的事后检查。** worktree 之间共享 `.git` 公共目录，审查者通过 shell 仍然可以写到自己的目录之外，所以保留这一层。每次 `team_verdict` 被调用时，插件检查写手的 worktree：
   - `HEAD` 等于送审提交；
   - 写手的分支引用等于送审提交；
   - `git status --porcelain` 除 `.team/` 外为空。

   任何一条不满足，本轮全部审查作废，Run 进入 `blocked(writer-worktree-changed-during-review)`，由人查看改动。插件不自动回滚，也不判断是谁改的：可能是审查者越界，也可能是人或写手自己在审查期间动了。

不给审查者设 provider 的只读沙箱。只读沙箱下多数测试跑不起来（要写缓存和构建产物），各 provider 的设法也不一致，而第 1 层不依赖它。

#### 7.3.1 独立 worktree 的代价

| 代价 | 说明与处理 |
| --- | --- |
| 准备时间 | 每个审查者每轮都要跑一次 `setup`。3 个审查者、3 轮上限时最多 9 次。M1a 实测：热缓存 `npm ci` 12 秒、`node_modules` 863 MB，磁盘按它估算 |
| 磁盘 | 一个 Run 在审查期间最多同时有 4 个 worktree（写手加 3 个审查者）。审查 worktree 在结论提交后立即删除 |
| CPU | 多个审查者可能同时跑测试，同时还可能有别的 Run 在跑门禁。门禁队列（第 9 节）不管审查者自己发起的测试。审查者的测试超时由它自己重试，不影响门禁结果 |
| 审查者看到的是提交，不是写手的工作目录 | 这是有意的。未跟踪的文件、本地缓存、写手留下的临时状态都不在审查范围内，和别人检出这条分支时看到的一致 |

### 7.4 侦察兵与调研员（P1）

- **侦察兵**：启动 Run 前可选。在一次性的 worktree 里试做任务，限时（默认 20 分钟），产出 `scout.md`。结束后归档 agent 与工作区，分支删除，代码不保留。
- **调研员**：最多 3 个，各回答一个独立问题，只读，各写一份报告。写手开工前由人发起，或写手通过工具 `team_research` 发起（每个 Run 限 2 次）。

### 7.5 不设 lead

拆任务和定验收标准由人完成，写在 `task.md`。一个 Run 只有一个写手，没有需要协调的并行写入，所以没有 lead 可做的事。多个互不相关的任务就开多个 Run，由人各自启动。

## 8 工具

统一前缀 `team_`，只挂给带 `agent-team.role` 标签且角色匹配的 agent，并由 `agent.permission.before` 自动放行（3.3）。

```ts
team_submit({ summary: string })
// 写手用。检查工作区干净 → 登记候选提交 → 状态变 gating → 立即返回。
// 返回："已登记提交 <sha>。门禁结果稍后发给你，现在结束本回合。"
// 工作区不干净时返回 isError 和未提交文件列表。

team_block({ reason: string, question?: string })
// 写手用。状态变 blocked(writer-asked-human)。

team_verdict({
  verdict: "approve" | "request-changes",
  blocking: number,          // 阻断项数量，approve 时必须为 0
  reportFile: string         // 必须是分配给它的那个路径，且文件存在
})
// 审查者用。reportFile 是它自己 worktree 里的路径。处理顺序见 7.2.2。

team_research({ questions: string[] })   // P1，写手用，最多 3 个问题
```

工具只做登记和快速检查，全部在 1 秒量级内返回。耗时的事（门禁、创建 agent）在返回后由插件异步做。

## 9 门禁执行器

1. 触发时确认写手 worktree 的 `HEAD` 等于登记的候选提交，且工作区干净。门禁只在写手的 worktree 里跑，不在审查 worktree 里跑。
2. 先做策略检查，用 `git diff --name-only <baseSha>...<sha>`：
   - 改动命中 `protectedPaths` → 违规；
   - 设了 `allowedPaths` 且有改动落在外面 → 违规。
3. 按顺序执行 `gateCommands`，工作目录是 worktree，环境变量带上项目配置里的 `env`（替换 `{runId}`，`{seat}` 取 `writer`）。每条命令单独超时，前一条失败后面的仍然执行，这样写手一次能看到全部问题。
4. 标准输出与标准错误完整写入 `.team/gate/<n>/<name>.log`。
5. 全部退出码为 0 且无违规才算通过。
6. 结果写入 Run 文件后再发消息。发给写手的消息只含：哪几项失败、日志路径、每个失败项末尾 80 行。

门禁进程由插件用 `child_process.spawn` 启动，不经过任何 agent。插件停止时终止子进程；重启后由对账重新跑。

同一时间全宿主只跑一个门禁（简单队列），避免几个测试套件互相抢 CPU 导致超时。v1 的 backlog 第 15 条记录过这个问题。

## 10 多个 Run 并行

- 每个 Run 完全独立，没有 Run 之间的依赖关系，也没有 DAG。有依赖的任务由人按顺序启动：先合并前一个，再从新的主干开下一个。
- 同时活跃的 Run 上限默认 3，可在设置里改。这个数字按"人审得过来多少"来定。
- **重叠警告**：启动时，把新任务声明的路径与其他活跃 Run 已经改动的文件做比对，有交集就提示，不阻止。
- **合并后复验**：一个 Run 标记为 `merged` 后，其他处于 `ready` 的 Run 显示"基线已变"。人点"复验"时，插件给写手发消息要求 rebase 到新基线后重新 `team_submit`，批准随 `HEAD` 变化自动失效，重新走门禁和审查。
- 合并本身由人在 Paseo 或 GitHub 里做。插件不执行合并、不推送、不开 PR（P2 再考虑"一键开 PR 并填说明"）。

## 11 资源隔离

| 资源 | 做法 |
| --- | --- |
| 文件 | 写手一个 worktree；每个审查者每轮一个独立的一次性 worktree |
| 端口 | 用宿主的 `paseo.json` service 与 `$PASEO_PORT`，文档里说明，不重复实现。审查 worktree 也是独立的工作区，同样拿到自己的端口 |
| 数据库等 | 项目配置的 `env` 模板支持 `{runId}` 和 `{seat}` 两个占位符，经 `agent.open.before` 注入。写手和门禁用 `seat=writer`，审查者用各自的席位（`r1` 等）。需要每个审查者一个库时写成 `app_{runId}_{seat}`，库的创建和删除由项目自己的 `setup` / `teardown` 负责 |
| 凭证 | 不处理。文档写明这是共用的 |
| `.git` 公共目录、权限批准 | worktree 之间共享，无法隔离。文档写明 |

worktree 只隔离被跟踪文件的编辑，agent 通过 shell 仍然可以写到 worktree 之外。v2 不把 worktree 当作安全边界，只当作避免互相覆盖的手段。

## 12 界面

| 界面 | 内容 |
| --- | --- |
| 新建 Run 对话框 | 选仓库与基线；编辑任务说明；确认门禁命令与受保护路径；选写手与审查者 Profile；可选"先派侦察兵" |
| 工作区面板 "Team Run" | 当前状态和原因；门禁历史（每次的各项结果，可展开日志）；审查历史（结论、阻断数、打开报告）；`blocked` 时的处置按钮；"已合并"与"放弃" |
| 列表页 | 所有 Run，按状态分组，显示耗时与轮次；入口在侧栏 |
| 命令中心 | "新建 Team Run"、"打开当前工作区的 Run" |

界面只通过 RPC 读 Run 文件，打开面板时触发一次对账。不做服务端推送，活动状态下 5 秒轮询一次本地 RPC（不涉及模型调用）。

v1 的 Crew Tree 面板、Role 与 Team 编辑器、设计师、版本面板都不迁入 v2。Crew Tree 的功能由宿主自带的 Subagents 轨道覆盖。

## 13 RPC

| 名称 | 作用 |
| --- | --- |
| `run.list` / `run.get` | 读取，`get` 会先对账 |
| `run.start` | 先检查审查者 Profile 的权限模式（7.2.3），不满足则拒绝；然后建工作区、写文件、建写手 |
| `run.resolve` | `blocked` 时人的处置，参数是 6.3 里的选项 |
| `run.revalidate` | 基线变了之后要求 rebase 并重新送审 |
| `run.close` | 标记 `merged` 或 `abandoned`，做归档 |
| `scout.start` | P1 |
| `settings.get` / `settings.set` | 宿主级设置 |
| `project.config` | 读仓库里的 `paseo-team.json` |

## 14 兼容与版本

- 插件 id 沿用 `paseo-agent-team`（用户已确认），版本从 1.0.0 开始。v1 的最后一个版本停在 0.8.x，打标签保留。
- `requirements.paseo`：`>=0.15.4`（M1a 在该版本上实测）。后台工作区 0.15.4 已可用；后台 agent 按 `features.backgroundAgents` 探测，没有就用普通 agent。
- 使用新的 `server.addHook` 接口，不用将在 2027-04-30 后移除的 `server.on` / `server.before`。
- v1 的数据（Role、Team、Run 台账）不迁移，也不读取。v2 的数据目录是新的 `agent-team-v2/`，两者互不影响。
- 目录：M1b 先把 v2 放在 `paseo-agent-team/v2/`（独立的 `paseo-plugin.json` 和入口），v1 原地不动，现有测试、CI 和发布流程不受影响。v1 移到 `legacy/` 并从发布包排除的那一步还没做，等 v2 的 M2 通过后再定。

## 15 测试

| 层 | 内容 | 要求 |
| --- | --- | --- |
| 状态机 | 6.1 每一行一条用例；三条不变式各有反例用例 | 纯函数，不需要 daemon |
| 门禁执行器 | 通过、失败、超时、受保护路径违规、输出截断 | 用真实的临时 git 仓库 |
| 对账 | 6.4 每一行一条用例 | 真实文件，假的 agent 快照 |
| 审查隔离 | 审查者在自己的 worktree 里改文件并提交，写手的分支和 worktree 不变；清理后 worktree 和临时分支都不存在；报告已复制到写手 worktree 和存档；审查期间写手 worktree 的 `HEAD` 被移动或出现未提交改动时本轮作废；审查 worktree 的 `setup` 失败；清理中途失败后由对账补做 | 真实 git 仓库，用 `git worktree` 直接建，不需要 daemon |
| 端到端 | 一个小任务从启动走到 `ready`；一次门禁失败后修复；一次审查打回后修复；一次 `blocked` 后人工处置 | 隔离的 DEV daemon，规则沿用 `AGENTS.md` |

测试行数不设下限。v1 有 11.6 万行测试而产品结论是"不如"，说明测试量不是目标。目标是上表每一行都有用例。

## 16 验收标准

| 编号 | 标准 |
| --- | --- |
| AC1 | 写手工作区有未提交改动时，`team_submit` 返回错误并列出文件，状态不变 |
| AC2 | 门禁失败时，写手收到的消息里有真实的命令输出，且与日志文件一致 |
| AC3 | 写手修改了受保护路径时，门禁判失败并指出是哪些文件 |
| AC4 | 写手在启动后修改 `task.md` 里的验证命令，门禁仍执行启动时冻结的命令 |
| AC5 | 审查批准后写手再提交，Run 离开 `ready`，批准记录被清除 |
| AC6 | 审查者在自己的 worktree 里修改并提交任何文件，写手的分支和 worktree 不受影响；结论提交后，该 worktree 和临时分支都被删除，报告保留在写手 worktree 和存档里 |
| AC13 | 审查期间写手 worktree 的 `HEAD` 变了或出现未提交改动，本轮全部审查作废，Run 进入 `blocked` |
| AC14 | 同一轮的审查者互相看不到对方的报告和 worktree |
| AC15 | Run 结束（合并或放弃）后，不留下任何属于它的审查工作区和 `team/<runId>/review-*` 分支 |
| AC7 | 门禁尝试或审查轮次达到上限后，Run 进入 `blocked`，不再自动继续 |
| AC8 | 门禁运行中重启 daemon，重启后打开面板，门禁被重新执行并得出结果 |
| AC9 | 写手两次不调工具就结束回合，Run 进入 `blocked`，面板显示原因 |
| AC10 | 任何状态下，面板都能回答三个问题：现在在等谁、为什么、人能做什么 |
| AC11 | 一个 Run 的生命周期内，被跟踪文件的所有提交都来自写手 |
| AC12 | 源码（不含测试）不超过 3500 行，其中服务端与共享代码不超过 2550 行、界面不超过 900 行 |
| AC16 | 审查者 Profile 的 `modeId` 不在允许列表里（含未设置）时，`run.start` 拒绝启动并指出席位；不创建任何工作区和 agent |

## 17 明确不做

| 不做 | 原因 |
| --- | --- |
| 任务 DAG 与调度 | v1 的 M1 没有显示收益；有依赖的任务本来就该串行 |
| 事件台账、重放、租约、exactly-once | v1 两个月的主要成本，换来的是更多卡死路径 |
| 自动恢复、自动重建成员 | 改成对账加人工处置 |
| 多个写手改同一分支 | 与核心原则相反 |
| lead 或协调者 agent | 没有需要协调的并行写入 |
| Role 与 Team 目录、设计师、模式与层级 | 用宿主的 Agent Profile 取代 |
| 解析 agent 回复里的结构化块 | 改用工具调用 |
| agent 之间自由对话 | 所有交接走文件和插件发的消息 |
| 自动合并、自动推送 | 合并由人决定 |
| 版本管理面板 | 与编排无关，用宿主的 `plugin update` |

## 18 待决问题

已由用户确认（2026-11-12）：Crew Tree 不带入，用宿主的 Subagents 轨道；审查者默认 1 个、可添加；每个审查者一个独立 worktree；v1 数据不迁移；插件 id 沿用。

仍待决定：

1. 审查 worktree 的 `setup` 如果实测很慢，是否允许项目在 `paseo-team.json` 里给审查者配一条更轻的准备命令。M1a 的数据是热缓存 `npm ci` 12 秒，可以接受，本文不提供。真实项目里 `setup` 明显更慢时再回来决定。
2. `blocked` 时是否需要推送通知到手机？Paseo 的权限请求会进"需要注意"，插件能否复用这条通道还没查。

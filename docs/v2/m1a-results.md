# M1a 探针结果

- 日期：2026-11-12。配套文档：[Spec](spec.md) 3.3、[PRD](prd.md) 第 7 节 M1a。
- 目的：在 Paseo 0.15.4 上实测 Spec 3.3 列出的未验证点，必要时修订 Spec。
- 结论：**P0 的核心机制在 0.15.4 上成立，可以进入 M1b。** 实测推翻了 Spec 的两处假设（metadata、权限），已改 Spec。

## 1 做了什么

- 探针插件 `probe/m1a/index.server.ts`，162 行（预算 200）。只观测、不含产品逻辑，结果写入 JSONL。原始记录：`probe/m1a/evidence/out.jsonl`（去掉了权限请求全文，关键字段摘在下面）。
- 环境：隔离的 DEV daemon，`--home` 为 `paseo-agent-team/.paseo-dev`，监听 127.0.0.1 随机端口，版本 0.15.4。每条命令都显式带 `--home` 或 `--host`，没有碰 `~/.paseo` 和真实实例。测试仓库在 scratchpad，仓库外。DEV 配置里 `daemon.mcp.injectIntoAgents` 为 true。
- 测试 agent：9 个，每个只有一句话的提示，Claude haiku 5 个、Codex 4 个，用的是本机 CLI 自己的登录态，没有拷贝任何凭证。
- 做完已 `daemon stop`。

## 2 Spec 3.3 五个点

| # | 点 | 结果 |
| --- | --- | --- |
| 1 | `defineAgentTool` 行为是否与 0.16 类型一致 | 基本一致。工具到达 agent，`execute` 在插件进程里运行，`agent` 有值。差异：`agent.open.before` 参数为 `{ request }`、直接返回改过的 request；无 `metadata`；无 `background` |
| 2 | 下发方式与工具名 | Claude 与 Codex 都经 MCP 服务 `paseo` 下发，名字 `mcp__paseo__team_*` |
| 3 | `baseRef` 传提交哈希 | 可行。`baseBranch: <sha>`，worktree `HEAD` 等于该提交，约 0.9 秒 |
| 4 | 审查 worktree 准备耗时 | `create` 立即返回，`setup` 异步运行，`setupStatus` 经 `running` 到 `completed` 或 `failed`（成功和失败两种都实测）。`setup` 为 3 秒时约 3.3 到 4 秒；热缓存 `npm ci` 12 秒、`node_modules` 863 MB |
| 5 | 后台工作区 | 可行。默认列表看不到，`includeBackground: true` 看得到 |

## 3 额外发现

1. **0.15.4 没有 `metadata`**（agent 和工作区都没有，`setMetadata` 也没有）。改用 agent `labels`，工作区靠分支名。
2. **插件工具默认要人工批准。** Claude `default` 模式和 Codex 默认模式下，agent 调用 `team_*` 会停在权限请求，Claude `auto` 模式不需要。已验证：`agent.permission.before` 里调 `respondToPermission({ behavior: "allow" })` 可以自动放行，Claude 和 Codex 都通过。
   - Claude 的请求：`name` = `mcp__paseo__team_probe_ping`。
   - Codex 的请求：`name` = `CodexMcpElicitation`，`description` = `Allow the paseo MCP server to run tool "team_probe_ping"?`，`metadata.serverName` = `paseo`。
3. 按标签条件挂载有效：带 `agent-team.role` 标签的 agent 看得到工具，不带的 `SEEN=none`。
4. `agent.turn.after` 在 Claude、Codex 上都以 `completed` 触发。

## 4 给 M1b 的要求

- 钩子按 0.15.4 签名写。
- 自动放行的匹配逻辑依赖 Codex 的 `description` 文案，这是脆弱点：匹配不上时不要放行，让请求留给人，并在面板里能看到"有一个权限请求在等"（AC10）。
- 等待 `setupStatus` 要有超时，`failed`、`blocked`、超时都走 `blocked(review-setup-failed)`。
- 磁盘按 863 MB 乘 worktree 数估算：写手加 3 个审查者约 3.4 GB。
- Run 文件里要记工作区 id，对账时再用分支名前缀兜底孤儿工作区。

## 5 没有验证的

- Claude、Codex 以外的 provider（Copilot、OpenCode、Pi 等）的工具下发和权限请求形态。
- `daemon.mcp.injectIntoAgents` 为 false 时插件工具到不了 agent，这条来自读源码，没有在 0.15.4 上反向验证。
- provider 进程直接消失时 `agent.turn.after` 不触发，同样只是读源码的结论。
- 在 `setup` 未完成时创建 agent 的行为（探针总是等 `completed`）。
- 重载插件对已开会话的影响（只在 DEV 上重载过，没有观察已开会话）。

## 6 与 AGENTS.md 的出入

`paseo-agent-team/AGENTS.md` 写的是 `npx --no-install paseo ...`，那个 CLI 固定在 0.13.0-beta.1，起的 daemon 不是 0.15.4。这次改用系统的 `/usr/bin/paseo`（0.15.4）加显式 `--home`，其余规则照旧。M1b 起 v2 的 `AGENTS.md` 要把这点写进去。

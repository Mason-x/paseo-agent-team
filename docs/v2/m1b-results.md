# M1b 结果：P0 服务端

- 日期：2026-11-12。配套文档：[Spec](spec.md)、[M1a 结果](m1a-results.md)。
- 状态：**服务端已实现，单元与集成测试全过；Claude 全流程已在真实宿主（DEV 0.15.4）上走到 `ready` 并完成归档，见第 7 节；Codex `full-access` 审查者已走到 `ready`（N=1），见第 8 节。多审查者并行与打回后的第二轮尚未在真实宿主上验证。**

## 1 做了什么

代码在 `paseo-agent-team/v2/`，测试在 `paseo-agent-team/tests/v2/`（135 条，biome 与 tsc 无报错）。

| 层 | 覆盖 |
| --- | --- |
| 状态机 `shared/machine.ts` | 6.1 每一行一条用例；三条不变式各有反例；6.4 对账每一行一条用例；`waiting()` 在每个状态都回答"等谁、为什么、人能做什么" |
| 门禁 `server/gate.ts` | 通过、失败后继续跑后面的命令、超时、受保护路径、`allowedPaths`、冻结命令（改 `task.md` 无效）、输出截断、全局串行队列、停止时不上报 |
| git `server/git.ts` | 真实临时仓库：脏文件、改动文件、落后基线、`.team/` 通过 `info/exclude` 忽略、写手 worktree 事后检查 |
| 引擎 `server/engine.ts` | 假 Host + 真 git worktree：S1 全流程、AC1 到 AC10、AC13 到 AC15、重启后重跑门禁（AC8）、清理中途失败由对账补做、孤儿审查工作区回收 |
| 钩子、RPC、存储 | 权限放行只认自己的工具（Claude 与 Codex 两种形态）、0.15.4 与 0.16 两种钩子载荷、并发提交只登记一次 |

## 2 真实宿主（DEV，0.15.4）上验证了什么

- 插件能被宿主构建并加载，`PASEO_HOME` 在插件进程里可用。
- `run.start` 到 `gating`：真实 Claude haiku 写手拿到 `team_submit`，提交后登记，门禁通过（两轮都复现）。
- 审查工作区、审查者 agent 能建起来，审查者读到了 `task.md` 和 `review-brief.md`，写手侧的 `progress.md` 和门禁日志不在里面。

## 3 冒烟里发现并修掉的问题

1. **agent 落在重复的工作区里。** `agents.create({ cwd })` 会另建一个指向同目录的工作区记录，归档原工作区后 worktree 删不掉。改为 `workspaces.ref(id).agents.create(...)`。
2. **宿主会改工作区的显示名**（改成 `Complete team task from .team/task.md`）。按名称前缀找孤儿工作区会漏，改为通过 `git worktree list` 的分支前缀识别，再按路径对应到宿主的工作区记录。
3. **宿主构建器不允许 import 插件目录之外的模块。** v1 的 `atomic-json` 用不了，store 自己实现原子写入。
4. **`closed` 被当成"已死亡"。** 机器挂起一小时后，宿主把空闲写手的会话置为 `closed`，对账判 `agent-failed`，并把还在审查的审查者归档。`closed` 是宿主回收空闲会话，下次发消息会恢复，现在算空闲。
5. **`host.agent()` 把任何错误当成"不存在"。** 现在只有 "Unknown agent" 才算，其他错误抛出，对账跳过这一轮。
6. **在存储模式上加格式校验会让旧 Run 读不出来。** 严格的 `provider` 格式只放在启动入口（`LaunchSpecSchema`）。

## 4 没有验证的（Claude 审查者那一段已被第 7 节取代，以第 7 节为准）

- **审查者一路走到 `ready`。** 第二、三轮冒烟都停在审查者这一步：Codex 在默认模式下写报告会停在文件写入权限请求（`CodexFileChange`）上。Spec 假设审查者可以自由读写，所以审查者的 Profile 必须选允许写文件的模式。面板能显示"有权限请求在等"（AC10 的这一部分已验证），但还没有用允许写文件的模式把审查走完，因此 `team_verdict` 在真实宿主上的调用、Codex 形态的权限自动放行、审查 worktree 的清理、`ready` 都没有在真实宿主上跑过。原因是第四轮冒烟被自动模式的分类器拦下，见 §5。
- 重载插件对已开会话的影响、除 Claude 和 Codex 之外的 provider。
- 机器挂起这类长时间间隔下的行为，只有一次偶然观察，没有专门测试。

## 5 需要用户决定（审查者模式与行数预算已由用户在 Spec 7.2.3 和第 4 节决定，见第 6 节）

- 把审查者的 `modeId` 设成 `full-access`（或 Claude 的 `auto`）才能让审查走完，这在 DEV 的临时仓库里创建一个不受权限提示约束的 Codex agent。自动模式把它拦下了，需要明确许可。
**用户已决定（2026-11-12）：**

- 冒烟先用 Claude `auto` 模式的审查者再跑一轮，验证 `team_verdict`、审查工作区清理和 `ready`。不创建 `full-access` 的 Codex 审查者；Codex 形态的自动放行和 Codex 审查者因此仍然是未验证项，要补需要用户另行明确批准。
- 产品规则：审查者 Profile 的权限模式不在允许列表里就阻止启动（Spec 7.2.3、AC16）。现有的"启动警告"对审查者要改成拒绝，对写手保留。
- 行数：总上限提到 3500，服务端冻结在 2550，界面 900（Spec 第 4 节、AC12）。

原问题：

- 行数预算：见 Spec 第 4 节末尾。服务端 2534 行，`client/` 只剩约 466 行。

## 6 7.2.3 审查者权限模式（已实现）

- `run.start` 在建任何工作区之前检查每个审查席位：`provider` 必须在允许列表里，`modeId` 必须是该 provider 允许的值（Claude `auto`，Codex `full-access`），否则拒绝并指明是哪个席位。允许列表在 `shared/run.ts` 的 `ALLOWED_MODES`。
- 写手没设 `modeId` 仍只给警告。插件的自动放行范围没有扩大，仍只放行自己的 `team_*` 工具。
- 测试 136 条，biome 和 tsc 无报错。新增一条覆盖：缺 `modeId`、不允许的 `modeId`、未实测的 provider、多席位里第二个不合格，且失败时不留工作区和 agent。

**行数（Spec 第 4 节要求写明理由）：** 服务端从 2534 行增到 2549 行，净增 15 行，上限 2550。增加的内容只有 `ALLOWED_MODES` 和 `reviewerModeProblem`（`run.ts`，约 13 行）以及 `engine.start` 里的检查（约 3 行）。原来"审查者缺 `modeId` 只警告"的那段被改成只针对写手，抵掉一部分。余量 1 行。

## 7 Claude 全流程冒烟（DEV，0.15.4，2026-11-13）

写手 `claude-sonnet-5-5`（`auto`）加审查者 `claude-sonnet-5-5`（`auto`），任务是写一行文件。结果：`run.start` → `writing` → `gating`（通过）→ `reviewing` → `ready`，一次走通，没有人工介入。

已在真实宿主上验证：

- `team_submit`、`team_verdict` 的真实调用；`team_*` 工具的权限在 `auto` 模式下不需要批准。
- 批准绑定提交：`approved.sha` 等于写手 `HEAD`。
- 审查者的 worktree、agent、临时分支在结论提交后被清理，`removedAt` 已记录；报告复制到了写手 worktree 的 `.team/reviews/1-r1.md`，写手 worktree 保持干净。
- 标记 `merged` 后，`.team/`（`task.md`、`gate/`、`reviews/`、`progress.md`）归档到 `agent-team-v2/archive/<runId>/`，写手工作区和 worktree 被删除，没有残留的 `team/<runId>/review-*` 分支（AC15）。写手分支保留，这是交付物。
- AC9 与"留言后继续"处置：模型不可用导致写手两次没有调用工具时，Run 阻塞为 `writer-stopped-without-submit`，面板有原因和出路。

冒烟中还遇到：`claude-haiku-5-5` 在这台机器上暂时不可用（不带插件的 agent 也报错），与 v2 无关，换 Sonnet 后正常。

**仍未验证：** Codex `full-access` 的审查者（需要用户本人批准在 DEV 创建）、Codex 形态的权限自动放行、多审查者在真实宿主上的并行、第二轮（打回后修复）在真实宿主上的表现、Claude 和 Codex 以外的 provider。

**已知小问题：** 对账清扫已结束的 Run 时，若其源仓库目录已被删除，日志只显示 `spawn git ENOENT`，没有说明是目录不存在。

## 8 用户批准：Codex `full-access` 审查者的冒烟（2026-11-12）

用户原话："Codex full-access 批准"。这是对第 5 节和第 7 节里那条待批准事项的答复。

批准的范围：

- 只在隔离的 DEV daemon 上（`paseo-agent-team/.paseo-dev`，每条命令带显式 `--home` 或 `--host`），不碰真实实例。
- 只用于审查席位，`modeId: full-access` 的 Codex agent；测试仓库是仓库外的临时仓库，任务保持一行文件这种量级。
- 目的是验证三件事：Codex 审查者走到 `ready`；Codex 形态的 `team_*` 权限自动放行；审查 worktree 的清理。
- 测完归档这些 agent 并停掉 DEV daemon。

不在批准范围内：在真实实例上创建这类 agent；把 `full-access` 用于写手；其他 provider 的同类模式。这些要另行询问。

结果补在本节下面。通过后更新 Spec 7.2.3 的表；不通过就把 Codex 从 `ALLOWED_MODES` 和该表里拿掉。

### 8.1 结果（DEV，0.15.4，2026-11-13 04:41 起，UTC）

配置：写手 `claude/claude-sonnet-5-5`（`auto`），审查者 `codex/gpt-6-luna`（`full-access`，一个席位）。任务和上一轮相同：写一行文件。仓库是仓库外的临时仓库。Run `r-20261113-55b3`，没有人工介入，`run.start` 没有警告（写手和审查者不同家族）。

| 步骤 | 结果 |
| --- | --- |
| `writing` → `gating` | 约 57 秒，门禁 1 项通过 |
| `gating` → `reviewing` → `ready` | 审查约 45 秒。审查者读 `task.md`、`review-brief.md`，看了 diff，写了 `.team/reviews/1-r1.md`，调 `team_verdict(approve, blocking=0)`，成功 |
| 批准绑定提交 | `approved.sha` = 写手 `HEAD` = `5e34c106…`，审查记录的 `sha` 同一个 |
| 审查 worktree 清理 | 结论提交后，审查 worktree 和 `team/<runId>/review-1-r1` 分支都不在了（`git worktree list` 与 `git branch -a` 核对），`removedAt` 已记录 |
| 报告复制 | 写手 worktree 的 `.team/reviews/1-r1.md` 存在，写手 worktree 没有未提交改动 |
| 关闭 | `run.close(abandoned)` 后写手 worktree 被删除，`.team/`（含审查报告）归档到 `agent-team-v2/archive/<runId>/`，只留下写手分支 |

验证了的三件事里：

1. **Codex 审查者走到 `ready`：通过（N=1）。**
2. **Codex 形态的 `team_*` 权限自动放行：这次没有被触发，不能算验证。** 审查者的时间线用 `--filter permissions` 查是空的，`PendingPermissions` 为空。`full-access` 模式下 Codex 调用 MCP 工具不弹请求。这个能力只有 M1a 在 Codex 默认模式下的一次成功记录，和 `hooks` 的单元测试。对审查者来说它没有实际作用（要用 `full-access` 才能写报告）；它只会影响将来的 Codex 写手，而写手用 `full-access` 不在批准范围内。
3. **审查 worktree 的清理：通过（N=1）。** 审查者 agent 在 `paseo ls -a` 里显示为 `closed`；清理的判断依据是工作区、worktree、分支都已不在，没有单独核对 agent 的归档标记。

### 8.2 仍未验证

- 多个审查者同时在真实宿主上并行；打回后的第二轮。
- Claude、Codex 以外的 provider。
- Codex `full-access` 只测了一个模型（`gpt-6-luna`）和一行文件的任务；复杂任务下审查者的越界行为没有观察到，也没有被专门测试。7.3 第 3 层的事后检查在这次里没有触发。

### 8.3 顺带看到的

- 插件日志里有三条 `sweep failed: git worktree list --porcelain failed: spawn git ENOENT`：是几个更早的 Run，源仓库目录已被删除，对账清扫时失败。和第 7 节记的小问题是同一个，没有影响这次 Run，还没修。
- 收尾：Run 已关闭，DEV daemon 已停（显式 `--home`），测试仓库留在会话的临时目录，不在项目里。Spec 7.2.3 的表已改成"已实测（N=1）"，没有改任何代码。


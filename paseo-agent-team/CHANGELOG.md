# Changelog

## Unreleased

## [0.8.0](https://github.com/Mason-x/paseo-agent-team/compare/paseo-agent-team-v0.7.1...paseo-agent-team-v0.8.0) (2026-11-11)


### Features

* **run-engine:** rebuild a member's Agent from the frozen launch spec when a restart leaves it unopenable ([3dbbca8](https://github.com/Mason-x/paseo-agent-team/commit/3dbbca87e7a5620ef5e8a6dcdf5c7c0f40bed9eb))


### Bug Fixes

* **run-engine:** correct and verify lost-review recovery guidance ([eaaa14b](https://github.com/Mason-x/paseo-agent-team/commit/eaaa14b57eb4e7a2937a534472b298884738e27c))
* **run-engine:** keep a rebuilt Agent from being lost or made for a seat that is not closed ([6c6b5c6](https://github.com/Mason-x/paseo-agent-team/commit/6c6b5c67d9ed22fb0410faaaa759ba0dd3b32587))
* **run-engine:** keep the coordinator and a paused Run out of the reopen wait and keep the warning when a look fails ([ce389ee](https://github.com/Mason-x/paseo-agent-team/commit/ce389eec1b7cf23e086059baeeff9fd45b753c71))
* **run-engine:** let a review cut off by a restart be tried again ([b9e5486](https://github.com/Mason-x/paseo-agent-team/commit/b9e54869e2bb979a42e733c258aba30f3dcb2a67))
* **run-engine:** read a member that never ran a turn before its first dispatch after a restart, and rebuild it if it cannot be opened ([e58e723](https://github.com/Mason-x/paseo-agent-team/commit/e58e72396bd01c63c728832cf949c73cc0360af6))
* **run-engine:** read closed seats in the scheduler's order, and let only the button grant another read ([9943d85](https://github.com/Mason-x/paseo-agent-team/commit/9943d850b115479606decf68500f61b8028a4a66))
* **run-engine:** record a retried turn's end from its own hook after a restart reused the turn id ([c2c879e](https://github.com/Mason-x/paseo-agent-team/commit/c2c879eb2efcf6d8712212962d46df03b17d762c))
* **run-engine:** reopen a closed seat by reading its history before refusing it ([ef5555b](https://github.com/Mason-x/paseo-agent-team/commit/ef5555b4bee76dd0de7100f80328ecf252561a32))
* **run-engine:** say the same thing about a lost reply in the reason and in the summary ([57c3bdc](https://github.com/Mason-x/paseo-agent-team/commit/57c3bdc2e2c6e9f7a316a39e9603a2795e383b68))
* **run-engine:** take the closed-seat warning down once a Run is finished or cancelled ([8f2f6d4](https://github.com/Mason-x/paseo-agent-team/commit/8f2f6d420dc132bed0e6da30ac1c435108c66d46))
* **run-engine:** tell a person to look at the task's branch before retrying a producer ([c4ae86b](https://github.com/Mason-x/paseo-agent-team/commit/c4ae86b7988a9826acdc68f067b30ac285db2a76))
* **run-engine:** try to reopen a member that only has a closed receipt before calling it lost ([37b41bd](https://github.com/Mason-x/paseo-agent-team/commit/37b41bd91acb9a7b8d24cf05082a8848cbbe2841))
* **run-engine:** try to reopen a member that only has a closed receipt before calling it lost ([fad391c](https://github.com/Mason-x/paseo-agent-team/commit/fad391cf401ba9ba22c95c354c21f3cfc9bc4100))

## [0.7.1](https://github.com/Mason-x/paseo-agent-team/compare/paseo-agent-team-v0.7.0...paseo-agent-team-v0.7.1) (2026-11-10)


### Bug Fixes

* **run-engine:** a closed receipt no longer makes a lost reply member-lost ([7038923](https://github.com/Mason-x/paseo-agent-team/commit/70389238d63bc99f042231481ab4638a6e15d2ab))
* **run-engine:** hold back the lost plan reply warning while a coordinator message is unsettled ([8cc4d9b](https://github.com/Mason-x/paseo-agent-team/commit/8cc4d9b59af5bffc62ce3e5e62d04d5242700e7c))
* **run-engine:** keep a turn id that comes back after a restart from hiding new turns ([632ca14](https://github.com/Mason-x/paseo-agent-team/commit/632ca14e7bbbbbebbe642616d721217e76fe67f1))
* **run-engine:** open a decision when the host ended a turn and then lost its reply ([b9cef18](https://github.com/Mason-x/paseo-agent-team/commit/b9cef18862a9c219f588121e71e762a28ec864e8))
* **run-engine:** report a plan reply the host lost when it restarted during planning ([cee3dfa](https://github.com/Mason-x/paseo-agent-team/commit/cee3dfa591943c44d715b6f6ff02bd736888babe))
* **run-engine:** show a closed seat as closed, not busy, and warn once ([bfcdc07](https://github.com/Mason-x/paseo-agent-team/commit/bfcdc0734b8e842291090af4a171a2ea2b3a3efa))
* **ui:** keep the kick answer on screen when the kick group goes away ([a8b0d12](https://github.com/Mason-x/paseo-agent-team/commit/a8b0d125e0b2b31cc6e9cfae483f335b412fa006))
* **ui:** show the kick answer next to its button and show alert text whole ([bc2c6cd](https://github.com/Mason-x/paseo-agent-team/commit/bc2c6cd524fac46e6527d63120425825b0b57672))

## [0.7.0](https://github.com/Mason-x/paseo-agent-team/compare/paseo-agent-team-v0.6.1...paseo-agent-team-v0.7.0) (2026-11-09)


### Features

* **run-engine:** let a check after 30 seconds settle a turn the host lost ([8d4fd18](https://github.com/Mason-x/paseo-agent-team/commit/8d4fd1888c2dbfeb60f3f16166713beb1d7d322f))
* **run-engine:** settle a member's turn when Paseo closes or archives it mid-turn ([0e15317](https://github.com/Mason-x/paseo-agent-team/commit/0e1531745150c532b6ca88daf75616dabeabc7ca))


### Bug Fixes

* **run-engine:** flush held hooks before the button's check settles a lost turn ([b65d4eb](https://github.com/Mason-x/paseo-agent-team/commit/b65d4eb2dcb055a1cacc172053f4909c09d8f4f8))
* **run-engine:** say a plan request was already counted instead of reporting no turns left ([6445203](https://github.com/Mason-x/paseo-agent-team/commit/6445203d94bf13c2e1e3548a76348f7c05cccc02))
* **run-engine:** say accurately which lost turns the engine settles and keep a cancelled Run clean ([6fb9222](https://github.com/Mason-x/paseo-agent-team/commit/6fb9222356b79ed53d6127d0f58baa04cc8092f9))
* **run-engine:** settle a closed member's turn before the recovery read can record it ([496e517](https://github.com/Mason-x/paseo-agent-team/commit/496e517909dbf4721abfa5d4e403bb76c2e795ee))
* **run-engine:** state exactly which lost turns the engine settles and what a v1 Run shows ([f0279da](https://github.com/Mason-x/paseo-agent-team/commit/f0279dadfc545a3df76072d6b0e68f2987b10450))
* **run-engine:** take down a failed-task alert that went stale while the Run was paused ([d616d06](https://github.com/Mason-x/paseo-agent-team/commit/d616d06159650b268761f3bc304b3dc4f0abe82e))
* **runs-page:** do not call a Run completed before the Engine list has answered ([82de62a](https://github.com/Mason-x/paseo-agent-team/commit/82de62aa0a929db8a169214e5873acf5b49da29c))
* **runs-page:** keep a typed reason when a poll briefly loses the Run ([87db5f7](https://github.com/Mason-x/paseo-agent-team/commit/87db5f7bbd9272594d755dd7992aa83013392a1c))
* **runs-page:** keep the turns box and the open confirmations when a poll briefly loses the Run ([68f3376](https://github.com/Mason-x/paseo-agent-team/commit/68f33763c6da9d520d99ca3b89c01c6eabb9940f))

## [0.6.1](https://github.com/Mason-x/paseo-agent-team/compare/paseo-agent-team-v0.6.0...paseo-agent-team-v0.6.1) (2026-11-08)


### Bug Fixes

* **version:** resolve PASEO_HOME with the path rules of the platform asked about ([1c6fbff](https://github.com/Mason-x/paseo-agent-team/commit/1c6fbff72c30423748e0d1d019ffa7ad287e9377))
* **version:** resolve PASEO_HOME with the platform's own path rules ([154254d](https://github.com/Mason-x/paseo-agent-team/commit/154254df6860f5af18906f2dc2937a7a4a644523))

## [0.6.0](https://github.com/Mason-x/paseo-agent-team/releases/tag/paseo-agent-team-v0.6.0) (2026-11-08)

### Features

- Run Engine, opt-in and off by default (start the daemon with `PASEO_AGENT_TEAM_RUN_ENGINE=1` and
  switch it on in a Team's **Run 引擎** block). One Run is one ledger file; every message to a member
  goes through an outbox (written first, sent once, an unknown result is checked against the member's
  timeline and never sent twice). Reports are taken in with bounded format repair, evidence the gate
  refuses is asked for again on the same delivery, review and smoke gates need an independent seat, and
  file claims are serialized across Runs. A host read that failed is read again and, once it works, the
  Run goes on by itself. Ledger schema v2 (this version reads v1 and v2).
- Runs page controls, shown only when the Run offers them: re-plan, retry, cancel a task, kick, pause,
  resume, add turns to a seat and cancel the whole Run (waits for running turns to end; sends nothing,
  archives nothing). Every waiting task, decision and alert says why, who clears it and what happens
  next, and the history says why each event happened.
- Turn budgets: per seat (add turns from the page) and for the coordinator (plan requests and
  re-plans). A failed-task limit stops new tasks from starting once too many have failed; work already
  in progress finishes.
- Team editor: edit the Run Engine block (seats, tiers, duties, channels, policy numbers) with the
  launch gate's blockers and warnings shown live, including a Codex Profile that is not full-access.
  Unknown fields in the block are kept.
- Long Runs: old events are folded into a summary and the Run stops starting new work near a ledger
  limit instead of overfilling.

### Bug Fixes

- A Run whose launch was interrupted while members were being created is closed with a critical alert
  listing the Agents already recorded; nothing is archived for you.
- The Runs list no longer shows an active blocked Run or a cancelled Run as finished.
- Control requests use a real UUID as request id, and "no answer" is shown as "the server may have
  acted" rather than "not delivered".
- Two processes contending for a ledger lock no longer report a lock that is still being written as
  corrupt.

### Notes

- Needs Paseo 0.12.0 or newer. The Engine stays off unless you turn it on.
- Do not roll back to 0.5.0 while an Engine Run is live: 0.5.0 has no Engine launch path and does not
  read schema v2.
- Known limits: closing or archiving a member mid-turn leaves its task waiting; if the host loses a
  running turn on restart, read re-checks run out and cancelling the Run keeps waiting until the member
  answers once more (README explains the way out). Not verified on a real host: the evidence
  supplement template with a real model.

## [0.5.0](https://github.com/Mason-x/paseo-agent-team/releases/tag/paseo-agent-team-v0.5.0) (2026-11-05)

### Features

- The Role list and editor show each Profile binding's model and thinking level. A bound
  reference shows the live Profile's values; an unbound one falls back to the preset's saved
  values. Display only, never used for binding.

### Bug Fixes

- Default Role presets bind to Profiles by normalized name only. A Profile whose model, mode or
  thinking setting differs from the preset snapshot now binds instead of being reported as
  `config-changed`, so editing a Profile in Paseo no longer requires catalog changes. Roles
  already imported with unbound references need “同步默认预设” or a manual bind to recover.

## [0.4.0](https://github.com/Mason-x/paseo-agent-team/releases/tag/paseo-agent-team-v0.4.0) (2026-11-05)

### Features

- New default Role 【工程】主力开发 bound to the `GPT-6.1 Terra Max` Profile (all-round feature work,
  cross-file debugging, refactors and tests), with Claude-Sonnet 5.5 high as fallback. Default
  catalog revision `defaults-2026-11-04.1`.

## [0.3.0](https://github.com/Mason-x/paseo-agent-team/releases/tag/paseo-agent-team-v0.3.0) (2026-11-04)

### Changes

- Team modes, the economy pool, and Role execution tiers have been retired. Each seat now follows
  its Role's preferred and fallback Profile bindings. Existing retired settings remain readable and
  are removed from an object only when it is next saved to a host that confirms support. A downgrade
  cannot restore deleted mode, pool, collaboration, or execution-policy settings; recreate them if
  returning to an older host. The CLI accepts omitted `--mode` or `--mode sota` only.
- The default development lineup uses a hands-on owner, DeepSeek implementation and test Roles,
  and Grok independent review. Optional planning and troubleshooting Roles are not enabled by default.

### Features

- Team 页新增设计师——描述需求后生成可启动的 Team，结果可预览并一键保存、启动。
- Agent Teams opens on the Team page, with tabs ordered Team / Role / 运行; Role and Team
  searches keep independent queries
- Team page: the Team designer card (request, target workspace, design Profile) above the
  search box and list; it starts a design job, shows every physical seat, and saves the result;
  compact layouts fold the designer and show an icon-only “新建”
- run progress: Agent Teams **运行** tab and per-run phase, member state, plan, assignment, and
  latest report in the Crew panel
- **追加任务** sends follow-up work to a run's coordinator
- launch runs on the daemon host as a background job (`agent-team.launch.*` RPCs), survives a
  closed dialog, and is available from the `/team` slash command and `npm run launch:team`
- launch into an existing workspace or a new worktree from the Agent Teams screen
- 启动对话框按物理席位预览成员与 Profile。
- Crew panel: allow a permission for the rest of the session
- the launch task is stored on the coordinator as a label, so runs describe themselves
- default Role presets: import 14 built-in Roles that bind to local Profiles by normalized name and
  identical provider/model/mode/thinking settings, with strict unbound, ambiguous, and
  config-changed reporting
- `agent-team.templates.defaults.preview` previews missing, updated, deleted, and colliding preset
  Roles with the exact settings revisions a merge must be saved against
- the first empty catalog imports the default Roles automatically; “同步默认预设” groups and
  previews every change before writing; editing or copying keeps or strips preset origin metadata
- version entry in the Agent Teams header and an update panel: source, current/remote revisions,
  check throttling, blockers and remedies, update confirmation, and reconnect/recovery after reload
- new member seats get stable ids and duplication labels; the member cap has a host preference editor
- version management (`agent-team.version.*` RPCs): report the installed version, source and latest
  stable release (or the default branch head); fast-forward a clean directory checkout on its default
  branch, run `npm ci` and reload through a detached runner that survives the reload, and roll a
  failed update back with `git reset --keep`; managed git installs update with `paseo plugin update`,
  npm and registry installs are only reported
- the reloaded plugin confirms its own commit and version, npm is resolved from a real `npm-cli.js`
  before any git write, and remote credentials never reach RPC results or job files
- 版本管理：检查更新时列出待更新的提交数和标题
- the default seat cap is 24 with no storage upper bound; a launch never creates more than 64
  members, and stored documents keep unknown values and fields instead of invalidating
- 启动前预览席位并冻结 `planHash`；配置或可用性变化后旧预览会被拒绝
### Bug Fixes

- 修复成员上限窗口在页面更新时重复出现，导致无法关闭、取消或保存的问题。

- 写入 Roles / Teams 时保留 Profile 引用、hint、文档顶层以及 Team 成员与协作对象的未知字段；
  “采用预设”保留原行的扩展字段与 designer 元数据

- Team / Role 编辑器保存时检测目录冲突，提示覆盖保存或重新加载，不再静默覆盖其他客户端刚保存的修改

- default preset sync ignores retired Role execution policy when comparing preset content

- an idle coordinator with a member error shows as 需处理 and keeps 追加任务; the Crew panel
  and the runs page agree on the failed state

- Runs tab: filter by 需处理 / 进行中 / 已结束, sort runs needing attention first, show earlier
  runs on demand, compact cards, "finished N days ago" instead of "ran for N days", and the task
  of runs launched by older versions

- read Agent Profiles from `daemon.agentProfiles` of Paseo 0.13 config, not the old top-level key
- block a launch when the coordinator's provider cannot call Paseo tools, instead of hanging on
  its first delegation
- live Crew refresh: agent updates need an explicit host subscription, which the panel never
  opened, so the list only changed on its 30s poll
- example catalog is served by an RPC instead of bundled into the client (1.1 MB to 0.26 MB)

### Migration

- require Paseo `>=0.12.0`; use `addScreen` and `addSidebarHeaderItem`
- pin `@getpaseo/*` to `0.13.0-beta.1`; add `verify:package` and `typecheck:beta`
- move launch logic and the Paseo adapter to `shared/` behind `PaseoPort`
- the bundled Ruflo catalog is removed; previously imported Roles and Teams remain in host settings
- downgrading can discard Profile binding hints, preset origins, or preset sync history on the
  next save; damaged hints, origins, or history are ignored, never fatal to the catalog
- `scripts/launch-team.mjs` now calls `agent-team.launch.preview` before start; use the same
  plugin version on the host

### Bug Fixes

- remove Role and Team enable switches; both are always available to launch
- keep per-member enable switches on Team seats only
- accept Paseo 0.9 (`>=0.8.0` instead of `^0.8.0`) so the plugin loads on `0.9.0-beta.2`
- keep CJK IME composition in plugin text fields (do not replay `value` on every keystroke)
- delay auto-generated role/team IDs until name blur/save so pinyin input is not interrupted

### Features

- rename the plugin to `paseo-agent-team` and keep the Agent Crew Explorer panel
- add host-scoped Role and Team catalogs, Launch, and Crew Tree role/team labels

### Migration

- migrate the plugin to the Paseo 0.8 runtime-entry layout
- move client modules under `client/` and shared code under `shared/`
- switch to first-class `parentAgentId` handling with bounded cycles
- add an explicit pending-permission modal with Allow and Deny actions
- pin Paseo plugin packages to `0.8.0-beta.1`

## [0.2.3](https://github.com/omercnet/paseo-plugins/compare/agent-crew-v0.2.2...agent-crew-v0.2.3) (2026-09-10)


### Bug Fixes

* upgrade plugins to Paseo 0.8.0 ([c6b4e40](https://github.com/omercnet/paseo-plugins/commit/c6b4e4081fc9527de0ca6183a3903ff5ec4f93c4))
* upgrade plugins to Paseo 0.8.0 ([d7ad454](https://github.com/omercnet/paseo-plugins/commit/d7ad4540d2e1875bdf4a4d21f76ded25cac2f3dc))

## [0.2.2](https://github.com/omercnet/paseo-agent-crew/compare/v0.2.1...v0.2.2) (2026-09-08)


### Bug Fixes

* derive client API types from host SDK ([#7](https://github.com/omercnet/paseo-agent-crew/issues/7)) ([ffdfacf](https://github.com/omercnet/paseo-agent-crew/commit/ffdfacf9e4f0bd43f84e973176b2b2ffd7fe6350))

## [0.2.1](https://github.com/omercnet/paseo-agent-crew/compare/v0.2.0...v0.2.1) (2026-09-08)


### Bug Fixes

* clean up Paseo 0.8 migration ([#5](https://github.com/omercnet/paseo-agent-crew/issues/5)) ([02912fb](https://github.com/omercnet/paseo-agent-crew/commit/02912fbb73956420ae8315bceea7025e71dd7a71))

## [0.2.0](https://github.com/omercnet/paseo-agent-crew/compare/v0.1.0...v0.2.0) (2026-09-08)


### Features

* migrate agent crew to paseo 0.8 ([#3](https://github.com/omercnet/paseo-agent-crew/issues/3)) ([3014f1c](https://github.com/omercnet/paseo-agent-crew/commit/3014f1c2f1afb8187cb2ac0e86f2b442bb805911))

## 0.1.0 (2026-09-02)

### Features

- add the workspace-wide Agent Crew Explorer panel
- organize managed agents into collapsible cross-workspace delegation trees
- add status filters, search, navigation, and guarded agent controls

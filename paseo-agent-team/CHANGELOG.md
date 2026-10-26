# Changelog

## Unreleased

### Features

- Agent Teams opens on the Team page, with tabs ordered Team / Role / 运行; Role and Team
  searches keep independent queries
- Team page: the Team designer card (request, target workspace, design Profile; “开始设计”
  stays disabled until the design backend lands) above the search box and list; compact
  layouts fold the designer and show an icon-only “新建”
- run progress: Agent Teams **运行** tab and per-run phase, member state, plan, assignment, and
  latest report in the Crew panel
- **追加任务** sends follow-up work to a run's coordinator
- launch runs on the daemon host as a background job (`agent-team.launch.*` RPCs), survives a
  closed dialog, and is available from the `/team` slash command and `npm run launch:team`
- launch into an existing workspace or a new worktree from the Agent Teams screen
- 启动对话框可临时切换本次运行的模式，并按物理席位预览成员、Profile 与预算。
- Crew panel: allow a permission for the rest of the session
- the launch task is stored on the coordinator as a label, so runs describe themselves
- default Role presets: import 22 built-in Roles that bind to local Profiles by normalized name and
  identical provider/model/mode/thinking settings, with strict unbound, ambiguous, and
  config-changed reporting
- `agent-team.templates.defaults.preview` previews missing, updated, deleted, and colliding preset
  Roles with the exact settings revisions a merge must be saved against
- the first empty catalog imports the default Roles automatically; “同步默认预设” groups and
  previews every change before writing; editing or copying keeps or strips preset origin metadata
- version entry in the Agent Teams header and an update panel: source, current/remote revisions,
  check throttling, blockers and remedies, update confirmation, and reconnect/recovery after reload
- edit Team modes, Role execution tiers, and the host economy pool; new member seats get stable
  ids and duplication labels, and preference writes merge the latest host settings
- version management (`agent-team.version.*` RPCs): report the installed version, source and latest
  stable release (or the default branch head); fast-forward a clean directory checkout on its default
  branch, run `npm ci` and reload through a detached runner that survives the reload, and roll a
  failed update back with `git reset --keep`; managed git installs update with `paseo plugin update`,
  npm and registry installs are only reported
- the reloaded plugin confirms its own commit and version, npm is resolved from a real `npm-cli.js`
  before any git write, and remote credentials never reach RPC results or job files
- 版本管理：检查更新时列出待更新的提交数和标题
- Team mode data model: Teams store `mode`, `memberCreation`, and `collaboration`; Roles store an
  explicit `executionPolicy` tier/task kind (defaults written for the 22 presets); host Preferences
  store the economy pool and quota recovery policy; the default seat cap is now 24 with no storage
  upper bound, a launch never creates more than 64 members, and stored documents keep unknown
  values and fields instead of invalidating
- 启动前按 Team 模式规划席位：SOTA 模式与未设模式的旧 Team 保持原有的成员与 Profile；经济模式
  的执行席位在当前版本启动时全部创建并给出提示，升级席位待命、不创建；协作模式暂不可启动，
  需要后续版本
- 启动前先预览席位与预算并冻结 `planHash`；配置或可用性变化后旧预览会被拒绝，避免按旧额度启动
### Bug Fixes

- default preset sync compares the effective Role tier, so an existing pre-tier Role with the
  preset's content is not reported as a user ID collision on the first sync

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

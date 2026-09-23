# Changelog

## Unreleased

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

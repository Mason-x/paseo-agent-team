# Upstream

This plugin started as a rename of the community `agent-crew` plugin so Role / Team
configuration and launch can live in the same package as the Crew Tree panel.

| Field | Value |
| --- | --- |
| Upstream project | Agent Crew |
| Upstream repository | https://github.com/omercnet/paseo-plugins (`agent-crew/`) |
| License | MIT (Copyright (c) 2026 Omer Cohen) — see `LICENSE` |
| Imported commit | `3bd0cfe7163fb66fcc32771ad987c1873d3f3467` |
| Imported date | 2026-09-19 |
| Original package | `@omercnet/paseo-agent-crew` v0.2.3 |

## Changes relative to the import

- Plugin id, package name, and install path are `paseo-agent-team`.
- Host-scoped Role / Team / preferences settings, Agent Teams surface, and Launch.
- Crew Tree keeps the original tree, filters, search, Nudge / Redirect / Detach /
  Archive, and permission Allow / Deny controls. Role and Team labels are read from
  `agent-team.*` agent labels only.

Keep edits to `client/crew.ts` and `client/main.tsx` small and localized so upstream
Crew Tree fixes remain easy to cherry-pick.

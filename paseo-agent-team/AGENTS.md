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

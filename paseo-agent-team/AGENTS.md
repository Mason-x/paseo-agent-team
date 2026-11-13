# paseo-agent-team development

## Protect the user's Paseo instance
- NEVER run plugin install/reload/enable/disable/update/remove against the CLI default host.
- NEVER use the default `~/.paseo` home. NEVER run bare `paseo reload|restart|daemon stop|daemon restart`.
- Unit tests and static checks need no daemon: `npm ci --ignore-scripts && npm run check && npm run typecheck && npm test`.
- Any runtime or UI check MUST use the dedicated daemon below with explicit `--home` / `--host` on every command.

## Dedicated development daemon (run from this directory)
Use the system CLI, not the one in `node_modules`: `PASEO=/usr/bin/paseo`. `npx --no-install paseo` resolves to
`@getpaseo/cli` 0.13.0-beta.1 and starts a 0.13 daemon; v2 needs >=0.15.4 (see ../docs/v2/spec.md section 14).
Run `"$PASEO" --version` first and stop if it is below 0.15.4. Shell state does not persist between tool calls,
so set `PASEO` on the same command line every time. The system CLI defaults to the real instance, which makes
the explicit `--home` / `--host` rule below mandatory on every single command.
1. Create `.paseo-dev/config.json` (ignored) with:
   {"version":1,"pluginsEnabled":true,"features":{"webUi":{"enabled":true}},"daemon":{"listen":"127.0.0.1:0","relay":{"enabled":false}}}
2. `"$PASEO" daemon start --home "$PWD/.paseo-dev"`
   `"$PASEO" daemon status --home "$PWD/.paseo-dev" --json`  → read `listen` as DEV_HOST
3. `"$PASEO" plugin ls paseo-agent-team --host "$DEV_HOST" --json`
   - absent → `"$PASEO" plugin install "$PWD" --host "$DEV_HOST"`
   - present with source `directory` and path == `$PWD` → `"$PASEO" plugin reload paseo-agent-team --host "$DEV_HOST"`
   - anything else → remove it on DEV_HOST, install `$PWD`, inspect again. Require `status: "running"` and no error.
4. Configure at least two Agent Profiles (different providers) on DEV_HOST before exercising Launch. Never copy profiles or credentials from `~/.paseo`.
5. Set `daemon.mcp.injectIntoAgents` to true in `.paseo-dev/config.json`: plugin tools (`team_*`) only reach
   agents when Paseo tools are enabled. After UI or RPC changes, reload the plugin on DEV_HOST.
   Scratch repositories and workspaces go outside this repo.
6. Verify at `http://$DEV_HOST/` against ../docs/v2/spec.md sections 12 and 16: the new-Run dialog, the
   "Team Run" workspace panel, the Run list, Command Center items. Create test agents only on DEV_HOST and keep
   their prompts short. Check the `blocked` paths as well as the happy path.
7. `"$PASEO" daemon stop --home "$PWD/.paseo-dev"` when finished.

Before every daemon or plugin lifecycle command, re-read it and confirm `--home`/`--host` still points at `.paseo-dev`.

Use `PASEO_HOME` as well as `--home`: a shell may already export it for the real daemon.

Test agents use the provider CLIs' own logins on this machine. Never copy credentials into `.paseo-dev`.
Stop the DEV daemon when finished; do not reload the plugin on a host with an active Run.

v2 is specified in ../docs/v2/ (prd.md, spec.md, m1a-results.md). v1 code is frozen at 0.8.x.

Merges and releases: follow ../docs/release-process.md (PR + CI only, no direct push to main).

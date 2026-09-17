# Repository development instructions

Before working in a plugin directory, read that directory's `AGENTS.md` and follow it before running commands.

## Protect live Paseo instances

Treat the default Paseo daemon and `~/.paseo` as production user state.

- Never run daemon or plugin lifecycle commands against the default host during development.
- Runtime, integration, and UI verification must use an isolated daemon, an isolated home, and explicit `--home` and `--host` arguments.
- Follow each plugin's local `AGENTS.md` for its exact test workflow.

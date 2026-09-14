# Configuration

Normal use requires no plugin-specific configuration. Open the **OMP** sidebar in Paseo to inspect the binary, RPC compatibility, storage paths, process health, registered providers, and the safe non-secret subset of the active native OMP configuration.

Choose **OMP Plugin** when creating an agent. Model, mode, thinking level, system prompt, persistence, MCP servers, workspace, and agent environment use Paseo's standard provider controls.

## Optional provider profile overrides

Advanced launch overrides belong in an `omp-plugin` provider profile. The provider options schema is strict; unknown fields fail validation.

```json
{
  "provider": "omp-plugin",
  "providerOptions": {
    "command": ["/opt/omp/bin/omp"],
    "params": {
      "sessionDir": "/var/lib/omp/sessions",
      "rpcTimeoutMs": 60000,
      "smolModel": "openai/gpt-5-mini",
      "slowModel": "anthropic/claude-opus-5",
      "planModel": "openai/gpt-5.4"
    }
  }
}
```

| Option | Purpose |
| --- | --- |
| `command` | Complete OMP executable and argument prefix. |
| `env` | Non-secret process overrides applied below the session launch environment. |
| `outputRedaction` | `none` (default) preserves native output. `configured-values` performs best-effort literal replacement only for explicitly supplied configured credential values from profile/session credential environment fields and configured MCP headers or environment. |
| `params.sessionDir` | Native OMP session directory supplied through `--session-dir`. Used consistently by discovery, import, resume, and launch. |
| `params.rpcTimeoutMs` | Startup, request, catalog, and availability timeout, from 1 ms through 10 minutes. |
| `params.smolModel` | Native selector supplied through `--smol`. |
| `params.slowModel` | Native selector supplied through `--slow`. |
| `params.planModel` | Native selector supplied through `--plan`. |

Paseo's generic provider profile fields remain available:

| Profile field | Behavior |
| --- | --- |
| `models` | Replaces the discovered model list. |
| `additionalModels` | Extends the discovered model list. |
| `disallowedTools` | Restricts only the known native OMP built-ins accepted by this plugin. It becomes an explicit OMP allow-list; unknown names fail closed rather than being ignored. It does not filter MCP host tools. |
| `paseoTools` | Enables or restricts which caller-scoped Paseo orchestration tools the daemon includes before they reach OMP as MCP host tools. |

These options cover every plugin-specific launch value. Values that belong to an individual agent, including model, mode, thinking level, title, system prompt, MCP servers, persistence, and cwd, remain standard Paseo session fields rather than duplicate plugin options.

## MCP tools and policy boundary

Configured MCP servers and Paseo's caller-scoped MCP tools are supported. The plugin discovers their schemas, assigns collision-safe OMP names, binds them before `session.ready`, forwards progress and terminal results, propagates cancellation, and renders calls with friendly labels.

Paseo's exact session `toolPolicy` preapproval grants are not equivalent to OMP's `set_host_tools` contract. The plugin cannot preserve that policy exactly, so any non-empty `toolPolicy` rejects session startup. It never converts exact grants into broader access. `disallowedTools` is separate: it controls only recognized native OMP built-ins and rejects unknown names.

## Credentials and environment

The plugin is deny-by-default. It inherits only its fixed built-in allowlist of core provider authentication variables plus exact names that an operator selects with `providerOptions.inheritEnv`; it does not discover or inherit arbitrary credential-shaped names. Prefer OMP's native credential store or auth broker whenever possible.

For example:

```json
{
  "provider": "omp-plugin",
  "providerOptions": {
    "inheritEnv": ["ACME_OMP_API_KEY"],
    "outputRedaction": "configured-values",
    "env": {
      "ACME_OMP_REGION": "us-east-1"
    }
  }
}
```

`inheritEnv` accepts an array of at most 256 names matching `[A-Za-z_][A-Za-z0-9_]{0,127}`. Selecting a name is an operator trust decision: its daemon-owned value becomes available to the OMP child and anything OMP launches. The plugin resolves selected values from the Paseo daemon environment immediately before each catalog or session launch. Unselected variables remain absent. Explicit `providerOptions.env` and per-session `env` overlays win over inherited values with the same name.

Profiles, persistence, errors, and catalog cache identity contain only the configured `inheritEnv` names, never resolved values or secret-derived hashes. A selected variable that is present and not shadowed by explicit `env` must contain at least 4 UTF-8 bytes. The existing 64 KiB per-value and 1 MiB total environment bounds still apply; shadowed daemon values are neither validated nor counted.

Process-control variables are always rejected case-insensitively, even when explicitly selected. The blocked prefix families are `BUN_INSTALL*`, `DYLD_*`, `GIT_CONFIG*`, `LD_*`, and `NPM_CONFIG_*`. The blocked exact names are:

```text
BASH_ENV, BUN_OPTIONS, CLASSPATH, CLAUDE_BASH_NO_CI, CLAUDE_BASH_NO_LOGIN,
CLAUDE_CODE_SHELL_PREFIX, EDITOR, ELECTRON_RUN_AS_NODE, ENV, GEM_HOME, GEM_PATH,
GIT_SSH_COMMAND, HOME, JAVA_TOOL_OPTIONS, NODE_OPTIONS, NODE_PATH,
OMP_AUTORESEARCH_DB_DIR, OMP_COMMAND, OMP_GITHUB_CACHE_DB, OMP_PROFILE,
OMP_WORKTREE_DIR, PATH, PATHEXT, PERL5LIB, PERL5OPT, PI_BASH_NO_CI,
PI_BASH_NO_LOGIN, PI_CODING_AGENT_DIR, PI_CODING_AGENT_SESSION_DIR,
PI_CONFIG_DIR, PI_CONFIG_FILES, PI_GIT_COMMON_DIR, PI_PACKAGE_DIR, PI_PROFILE,
PI_PROJECT_DIR, PI_SESSION_ID, PI_SHELL_PREFIX, PI_SUBPROCESS_CMD,
PI_WORKTREE_DIR, PWD, PYTHONHOME, PYTHONINSPECT, PYTHONPATH, PYTHONSTARTUP,
RUBYLIB, RUBYOPT, SHELL, SYSTEMROOT, USERPROFILE, VISUAL, XDG_CACHE_HOME,
XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_RUNTIME_DIR, XDG_STATE_HOME, _JAVA_OPTIONS
```

Unlike `inheritEnv`, `providerOptions.env` stores its literal values in the provider profile/configuration. Use it only for deliberate non-secret overrides. If configuration contains sensitive values anyway, restrict `<paseo-home>/config.json` to the daemon account (`chmod 600` on POSIX), protect backups, and never attach it to an issue.

The plugin validates and bounds native protocol data, but it does not heuristically detect, redact, or rewrite credentials in OMP, model, or tool content. Never put credentials in prompts or tool output. With `outputRedaction: "configured-values"`, every non-empty value selected through `inheritEnv` is treated as sensitive regardless of its name, alongside the existing explicitly configured credential values. Exact configured literals are replaced on a best-effort basis; generated secrets and encoded, transformed, or independently streamed fragments are not detected. With the default `none`, inherited values are not rewritten in output. Centralized Paseo policy is required for redaction guarantees. Unexpected or internal launch failures use fixed fallback messages rather than serializing the launch configuration, while explicit public validation errors may include caller-supplied configuration names or values.

## Modes and permissions

- `full` is always available.
- `write` and `ask` appear when Paseo negotiates provider permission support.
- Typed OMP approval frames become Paseo tool permissions when both sides negotiate `typedToolApprovals: 1`.
- OMP 18.1.15 uses the bounded generic interaction fallback.
- Changing approval mode requires a new session. Live model and thinking changes are supported.

## Persistence and images

Non-persisted sessions use `--no-session`. Persistent sessions keep a versioned native handle, replay before becoming ready, and recover with the effective launch configuration.

For text-only models, image inputs are written to a private bounded temporary directory shared with the local OMP child and removed after the turn, session, or failed launch.

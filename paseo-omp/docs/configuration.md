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

Supported provider authentication variables are inherited from the Paseo daemon environment. Put API keys in the daemon's service environment or secret manager, not in `providerOptions.env` or committed configuration.

`providerOptions.env` is only for deliberate non-secret overrides. If configuration contains sensitive values, restrict `<paseo-home>/config.json` to the daemon account (`chmod 600` on POSIX), protect backups, and never attach it to an issue.

The plugin validates and bounds native protocol data, but it does not heuristically detect, redact, or rewrite credentials in OMP, model, or tool content. Never put credentials in prompts or tool output. With `outputRedaction: "configured-values"`, exact configured literals are replaced on a best-effort basis; generated secrets and encoded, transformed, or independently streamed fragments are not detected. Centralized Paseo policy is required for redaction guarantees. Unexpected or internal launch failures use fixed fallback messages rather than serializing the launch configuration, while explicit public validation errors may include caller-supplied configuration names or values.

## Modes and permissions

- `full` is always available.
- `write` and `ask` appear when Paseo negotiates provider permission support.
- Typed OMP approval frames become Paseo tool permissions when both sides negotiate `typedToolApprovals: 1`.
- OMP 18.1.15 uses the bounded generic interaction fallback.
- Changing approval mode requires a new session. Live model and thinking changes are supported.

## Persistence and images

Non-persisted sessions use `--no-session`. Persistent sessions keep a versioned native handle, replay before becoming ready, and recover with the effective launch configuration.

For text-only models, image inputs are written to a private bounded temporary directory shared with the local OMP child and removed after the turn, session, or failed launch.

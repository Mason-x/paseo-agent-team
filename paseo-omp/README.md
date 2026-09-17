# Paseo OMP plugin

Community OMP integration for Paseo. The plugin registers the distinct `omp-plugin` provider plus named profile providers and coexists with Paseo's bundled `omp` provider.

> **Alpha preview:** persistence and protocol contracts are tested, but upgrades may still require re-importing sessions created by an earlier preview.

## Quick start

Requirements: Paseo `^0.8.0`, OMP `18.1.15` or newer, and OMP RPC protocol v2.

```bash
paseo plugin add omercnet/paseo-plugins:paseo-omp --ref paseo-omp-v<version>
paseo plugin ls paseo-omp
```

Open the **OMP** sidebar to review the provider-profile contract, choose which composer pills appear, browse and edit native scalar settings, manage OMP-native plugins, verify runtime health, and inspect storage and process diagnostics. Then create an agent and select **OMP Plugin**. Its optional **MCP** composer control runs OMP-native management commands in the current session; setup questions and authorization stay in that chat timeline, where OAuth can open in a workspace-scoped Paseo Browser or on the current device. Composer pill preferences are shared by clients connected to the same host; normal use requires no other plugin-specific settings.

- [Install, update, rollback, and local development](docs/installation.md)
- [Configuration and every provider option](docs/configuration.md)
- [Compatibility, limitations, and support](SUPPORT.md)
- [Test matrix and release verification](TESTING.md)
- [Core-provider issue and parity audit](docs/core-provider-issue-audit.md)
- [Alpha release checklist](docs/alpha-release-checklist.md)

The plugin uses only public Paseo 0.8 provider contracts and registers distinct `omp-plugin` and `omp-plugin-<profile>` identities; it does not modify the bundled `omp` provider.

## Named OMP profiles

At startup the plugin discovers directory names under `~/.omp/profiles/` (or `PI_CONFIG_DIR`) and registers **OMP · <profile>** for each valid lowercase name. Select that provider when creating a profile-backed agent. Discovery, launch, recovery and persisted session listing share its fixed profile and session root. Matching command wrappers, including Doppler, remain supported; conflicting profile or session-directory overrides fail before launch. Plain `env NAME=value omp` wrappers are supported, but environment-control flags such as `env -i` and `env -u` are rejected because they can discard the selected store. Profile-specific XDG roots cannot be overridden by per-launch environment values. Reload the plugin after adding a profile.

Paseo 0.8 does not pass agent launch options to its model picker. Separate provider identities let the picker request the correct profile catalog before an agent exists. Existing `omp-plugin` and bundled `omp` agents retain their provider; they are not migrated automatically. Profile names use OMP's lowercase grammar, including dotted names such as `team.prod`.

The OMP sidebar and memory panel expose an explicit store selector. Settings, plugins, quota, history, memory and diagnostics use that selection, and profile-agent popovers derive it from the provider ID. OMP-compatible XDG data and state roots are honored when a migrated profile uses them. Default-provider views are labelled **Daemon default store**; changing `providerOptions.command` on the default provider does not make those views profile-aware. Workspace configuration remains project-scoped, with the selected profile supplying inherited settings. Hub records are daemon-wide. The RPCs also accept an explicit absolute `store.agentDir` for custom stores; it is mutually exclusive with `store.profile`.

Profile selection is request-local: concurrent clients cannot change each other's process environment or cached results. Settings edits affect the selected store immediately.

## Paseo provider SDK coverage

This matrix inventories the complete capability set exported by the pinned `@getpaseo/plugin` 0.8.0 provider SDK. It measures strict SDK surface coverage, not general product quality.

**Current capability completeness: 61.8%.** The provider advertises 11 of 17 capabilities (64.7%); ten are complete and `session.configure` is partial.

Scoring is deliberately mechanical so releases remain comparable:

- **100%**: advertised, implemented end to end, and covered by automated provider tests.
- **50%**: advertised with a meaningful subset, but at least one material SDK operation is rejected.
- **0%**: not advertised; requests are rejected rather than silently approximated.
- Overall completeness is the unweighted arithmetic mean of all 17 SDK capability rows.

| SDK capability | Completeness | Support and gap |
| --- | ---: | --- |
| `prompt.message` | **100%** | Text, structured attachments, optimistic correlation, streaming, and terminal outcomes map to native OMP prompts. |
| `prompt.command` | **100%** | Native command discovery plus structured `compact`, `autocompact`, `handoff`, `steer`, and `follow-up` dispatch. Individual commands can still fail when their documented OMP prerequisites are absent. |
| `prompt.image` | **100%** | Native image blocks for capable models; private bounded temporary files with cleanup for text-only models. |
| `prompt.output_schema` | **0%** | Not advertised. OMP has no equivalent structured-output contract; `outputSchema` fails visibly. |
| `prompt.steer` | **100%** | Native steering with turn ownership, user-message correlation, stale-target rejection, and terminal race handling. |
| `session.archive` | **0%** | Not advertised. Paseo may archive its agent record, but OMP has no native transcript archive operation. |
| `session.configure` | **50%** | Live model and thinking changes commit and republish native state. Live approval-mode changes require a new session, and non-empty SDK `settings` are rejected. |
| `session.list` | **100%** | Bounded host-wide and cwd-scoped discovery, search, previews, profile-specific session roots, and cleanup-reservation guards. |
| `session.persistence` | **100%** | Versioned opaque handles, exact resume, import, replay-before-ready, runtime recovery, and cleanup quarantine. |
| `session.revert.both` | **0%** | Not advertised because OMP cannot atomically rewind conversation and workspace files. |
| `session.revert.conversation` | **100%** | Native branch-based conversation rewind, replay deduplication, ownership transfer, and failure quarantine. |
| `session.revert.files` | **0%** | Not advertised because OMP does not expose a native file-only rewind contract. |
| `session.subsession` | **100%** | Direct and nested OMP subagents become Paseo child sessions with lifecycle, ancestry, progress, and replay. |
| `session.unarchive` | **0%** | Not advertised; there is no native OMP archive state to reverse. |
| `permission` | **100%** | Typed tool permissions when negotiated, with a bounded generic interaction fallback for OMP 18.1.15. Allow, deny, cancel, timeout, and interruption are covered. |
| `permission.tool_policy` | **0%** | Not advertised. Exact MCP preapproval policy cannot be preserved through OMP `set_host_tools`, so the plugin fails closed instead of broadening access. |
| `timeline.plugin` | **100%** | Negotiated OMP MCP authorization requests render as interactive, schema-validated cards that can open a workspace-scoped Paseo Browser tab, with an on-device and built-in-notification fallback. |

Provider functionality outside the capability flags is tracked separately:

| Provider SDK surface | Completeness | Implementation |
| --- | ---: | --- |
| Registration metadata and sanitized SVG icon | **100%** | Stable `omp-plugin` identity, label, description, and bundled icon. |
| Strict `providerOptionsSchema` | **100%** | Command, literal and names-only inherited environment, output-redaction mode, session directory, RPC timeout, and role-model options are validated and normalized. |
| Availability diagnostics | **100%** | Bounded checks distinguish missing, unrunnable, incompatible, and available OMP runtimes. |
| Catalog cache identity | **100%** | Hash includes effective options, configured inherited-environment names, settings, scope, cwd, and default command, but never resolves or fingerprints inherited values. |
| Models, modes, and thinking catalog | **100%** | Native catalog is mapped to opaque public model IDs with committed defaults and permission-gated modes. |
| Connection `send` / `onEvent` / `close` lifecycle | **100%** | Request correlation, multi-session ownership, process recovery, teardown, and provider reload/removal are covered. |
| Session launch: cwd, env, system prompt, title, and persistence | **100%** | Complete launch configuration is bounded, validated, forwarded, and re-read on recovery; selected daemon environment values are resolved only when catalog and session children spawn. |
| MCP server forwarding and host tools | **100%** | Configured MCP tools are discovered, namespaced, labeled, executed, canceled, and bounded. Caller-scoped Paseo orchestration tools retain their native names, such as `create_agent` and `list_profiles`, so OMP skills can invoke them directly. The MCP composer control delegates native server management to OMP instead of duplicating its profile and workspace precedence. Exact `toolPolicy` remains the separate 0% capability above. |
| Denied native tools | **100%** | `disallowedTools` becomes an explicit OMP allow-list; unknown names fail closed. |
| Commands and committed session state events | **100%** | Publishes `session.commands`, `session.opened`, `session.config`, `session.ready`, and request completion in protocol order. |
| Built-in timeline snapshots | **100%** | Assistant, reasoning, tools, todos, notifications, errors, compaction, and friendly MCP labels use stable IDs and complete snapshots. OMP emits client-safe PNG/JPEG when possible; validated legacy WebP images render on capable clients with an explicit per-image fallback elsewhere. |
| Usage reporting | **100%** | Periodic, post-compaction, fallback, terminal, timeout, and recovered-runtime samples publish `session.usage`. |

Tracking rules:

1. On every `@getpaseo/plugin` upgrade, diff the SDK's exported `PROVIDER_CAPABILITIES` list and add every new capability here at **0%** before claiming support.
2. Raise a row only when the provider advertises the capability and an observable contract test covers its success and failure boundaries.
3. Keep native-agent limitations at less than 100% even when the adapter itself is complete; do not count undocumented fallbacks as support.
4. Keep the detailed evidence and regression locations in [TESTING.md](TESTING.md); this README is the public progress ledger.

## Compatibility and coexistence

The plugin always remains a separate provider. It registers `omp-plugin` and `omp-plugin-<profile>` identities; it never registers, overrides, removes, or migrates Paseo's bundled `omp` provider. Both identities may be enabled on the same daemon and selected independently per agent.

Existing agents whose provider is `omp` remain owned by the bundled provider. New plugin agents persist under their selected `omp-plugin` or `omp-plugin-<profile>` identity with the plugin's versioned opaque handle. The plugin can list and import OMP-native sessions through its own provider flow, but it performs no implicit conversion of bundled-provider records.

OMP `18.1.15` is the oldest version tested end to end. The direct provider's hard compatibility gate is `rpc-ui` protocol v2: metadata-free legacy ready frames and v1-only runtimes are rejected before a provider session opens because they cannot support the advertised persistence and conversation-rewind capabilities. Typed tool approvals remain capability-gated and fall back as described above.

Install, update, disable, or remove `paseo-omp` independently of the bundled provider. Verify the provider snapshot contains `omp-plugin` after installation; a bundled `omp` entry may remain present and is not modified by this plugin.

## Output and credential boundary

The plugin validates OMP protocol data and bounds public strings and structured values. It does not heuristically redact or rewrite content produced by native OMP, models, or tools. Do not put credentials in prompts or tool output, because that content may be published unchanged after validation and bounding.

`providerOptions.outputRedaction` defaults to `none`, preserving native content subject to those bounds. `configured-values` provides best-effort literal replacement for explicitly supplied credential values and every non-empty daemon value selected through `inheritEnv`, regardless of its name. It does not detect generated secrets or encoded, transformed, or independently streamed fragments of configured values. Centralized Paseo policy is required when a deployment needs redaction guarantees.

Unexpected or internal launch failures use fixed fallback messages rather than serializing the launch configuration. Explicit public validation errors may include caller-supplied configuration names or values. Deployments that require host-wide content redaction should implement it in a dedicated host or plugin layer rather than this protocol adapter.

## Testing and development

The repeatable Docker canary and every validation command are documented in [TESTING.md](TESTING.md). It covers discovery, modes, text, images, tools, MCP, permissions, steering, interruption, persistence, host-wide and scoped session listing, import, resume, subagents, Hub, usage, plugin RPCs, and conversation rewind.

Use `canary-mock/Deterministic Canary` for assertions. The optional local Ollama model is exploratory and nondeterministic.

## Support

See [SUPPORT.md](SUPPORT.md) for ownership, escalation boundaries, supported versions, security reporting, and the repeatable OMP RPC compatibility intake process.

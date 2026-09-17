# OMP provider parity audit

Validated against the Paseo plugin SDK versions pinned in `package.json`, official Paseo Docker image `0.8.0@sha256:5518da7cdd35f132e8a944c35e509c677a90a8f3ec8a78df98f7fb5fd5e2c6c3`, and the real OMP compatibility matrix: high-use historical releases 17.2.15, 17.3.4, 18.0.11, and 18.1.10; minimum supported release 18.1.15; latest published 18.1 patch 18.1.22; and current release 18.2.0.

Classifications:

- **Equivalent**: same consumer-observable behavior is implemented by the `omp-plugin` provider.
- **Unsupported**: OMP has no meaningful native operation for this behavior.
- **Protocol**: Paseo core owns the behavior for every public provider.
- **Blocked**: parity needs the linked narrow public API or core change; the plugin fails visibly or provides the documented partial behavior.

## Evidence matrix

| Inventory behavior | Classification | Evidence |
| --- | --- | --- |
| Binary availability and version diagnostics | **Equivalent** | Provider refresh calls the bounded `checkAvailability` hook with normalized profile options and the host deadline. `server/provider-diagnostics.ts` distinguishes missing, unrunnable, incompatible, and available runtimes without exposing probe output. |
| Catalog discovery | **Equivalent** | `server/provider/catalog.ts::discoverOmpCatalog` launches with the normalized profile command, environment policy, parameters, workspace, and timeout settings; selected daemon values are resolved only when the catalog child spawns. |
| Catalog cache identity | **Equivalent** | `getCatalogCacheKey` hashes normalized `providerOptions`, including configured `inheritEnv` names but never their values or secret-derived fingerprints, plus profile `settings`, scope, working directory, and the effective default command. Core applies configured `models` and `additionalModels` per profile. |
| Default mode | **Equivalent** | Catalog reports `defaultMode: full`; `full` is always available, while bundled `write`/`ask` modes are advertised only after `permission` negotiation. Covered by `tests/provider.test.ts` and `tests/provider-options.test.ts`. |
| Create session | **Equivalent** | `OmpProviderSession.open`; ordered `session.opened`, committed `session.config`, and `session.ready` regression. |
| Resume session | **Equivalent** | Versioned plugin persistence validates the native session ID, authorizes cwd against the configured `providerOptions.params.sessionDir`, resumes exactly, and replays before ready. Covered by `tests/provider.test.ts` and `tests/provider-conformance.test.ts`. |
| List sessions | **Equivalent** | `session.list` consumes profile-scoped `providerOptions` and `settings`, scans the configured session root, and returns separate bounded first- and last-user-prompt previews. |
| Import session | **Protocol** and **Equivalent** | `session.list` plus persistence replay feeds the generic plugin-provider import path and creates an `omp-plugin` agent without changing bundled-provider records. |
| Archive/unarchive | **Unsupported** | OMP has no native archive operation. Neither adapter mutates OMP transcripts; Paseo still archives its own agent record. |
| Working directory | **Equivalent** | Absolute cwd validation, launch forwarding, resume ownership checks, session-list scoping, and host-tool cwd tests. |
| Environment propagation | **Equivalent** | `config-normalization.ts` overlays session env on profile env; `omp-rpc.ts::buildOmpEnvironment` allowlists inherited runtime/provider variables and rejects loader/path injection. |
| System prompts | **Protocol** and **Equivalent** | Core combines agent and daemon prompts before `session.open`; plugin forwards one bounded `--append-system-prompt`. Profile/recovery tests preserve it. |
| Persisted sessions | **Equivalent** | Versioned opaque plugin persistence, transcript reservation, replay, process recovery, and cleanup quarantine regressions are covered in `tests/provider.test.ts` and `tests/provider-conformance.test.ts`. |
| Ephemeral sessions | **Equivalent** | `persist: false` maps to `--no-session`; runtime loss fails visibly instead of inventing a resume handle. |
| Internal sessions | **Protocol** and **Equivalent** | Metadata generation requests `persistSession: false`; the generic plugin host maps that to `config.persist: false`, then OMP receives `--no-session`. |
| Text prompts | **Equivalent** | Bounded multipart text joins and native prompt lifecycle coverage in `tests/provider.test.ts`. |
| Image prompts | **Equivalent** | Valid native image models receive image blocks; text-only models receive private content-addressed local files with an aggregate cap and turn/session/failure cleanup. The file path is valid because the direct provider and OMP child share the daemon host. |
| Structured attachments | **Equivalent** | Forge change requests/issues, legacy GitHub forms, text, reviews, and uploaded files render to bounded OMP prompt text; regression in `tests/provider.test.ts`. |
| Optimistic message correlation | **Equivalent** | Native entry lookup, repeated-text occurrence correlation, steering correlation, replay-boundary dedupe, and exactly-one `session.prompt_result` regressions. Bounded branch snapshots rebuild incomplete or evicted replay watermarks; duplicate IDs, surplus matching entries, unavailable snapshots, and count/byte overflow retain local user-message fallback instead of claiming an old entry. |
| Terminal ownership on later turns | **Version-gated** | A new exact-text branch entry proves user-message persistence, not ownership of an unkeyed `agent_end`. The plugin accepts a later-turn terminal only when it carries the originating prompt's RPC `requestId`. Older OMP releases remain fail-closed after the ownership deadline. `tests/provider.test.ts` covers matching and mismatched request IDs, stale ends before and after new entries, repeated prompts, evidence arriving during an older terminal check, and unavailable or hung history. |
| Streaming assistant text | **Equivalent** | `OmpTimelineProjector` publishes stable complete snapshots with frame coalescing and bounded retained bytes. |
| Streaming reasoning | **Equivalent** | Indexed thinking blocks map to stable `reasoning` items and share stream bounds. |
| `contentIndex` ordering | **Equivalent** | Stable 0→1→0 updates, sparse-index rejection, and 64-block bounds are tested in `tests/provider.test.ts`. |
| Tool lifecycle | **Equivalent** | Running/update/terminal snapshots, mapped shell/read/edit/write/search/fetch/subagent details, ID reuse defense, and terminal cleanup are covered. |
| Todo lifecycle | **Equivalent** | Todo tool results and reminder/auto-clear events reduce to one stable `omp:todos` item; malformed inputs degrade safely. |
| Compaction events | **Equivalent** | Manual and automatic operations retain IDs, distinguish retry/skipped/canceled/failed states, flush streams, and refresh usage. |
| Custom messages | **Equivalent** | Displayable custom and bash-execution messages map to typed or fallback items; `display: false` remains hidden. |
| Advisor messages | **Equivalent** | Advisor notes preserve severity/attribution in stable tool-call blocks; `advisor_yielded` emits completion notice. |
| System notices | **Equivalent** | Native notices and safe passive UI notifications map to bounded notification items; hidden custom notices remain hidden. Negotiated MCP authorization URLs use a schema-validated plugin item, can route through the caller-scoped Paseo `browser_new_tab` tool, and retain a notification fallback. |
| Ask interactions | **Equivalent** | Select/confirm/input/editor questions, including remote OAuth redirect/code completion, option descriptions, fixed-only rejection, bounded freeform input, native sentinel/follow-up submission, cancellation, timeout, and turn ownership are covered by permission regressions. Allow, deny, cancel, timeout, and interruption remain in the agent timeline. |
| Typed tool permission presentation | **Equivalent** | OMP `typedToolApprovals: 1` is negotiated reciprocally; strict native request/cancel/response frames are correlated exactly once and mapped from trusted shell/edit/write identity to bounded, content-preserving `kind: "tool"` permissions. Older OMP builds retain generic extension questions. |
| Slash command catalog | **Equivalent** | Native commands and aliases refresh authoritatively; the bundled `compact`, `autocompact`, `handoff`, `steer`, and `follow-up` commands are always published. |
| Manual `/compact` | **Equivalent** | Uses native `compact`, exposes one loading/completed operation, keeps long requests alive, refreshes usage, and supports interruption. |
| `/autocompact` | **Equivalent** | `on`, `off`, and state-backed `toggle` use native `set_auto_compaction`; invalid or unavailable state fails visibly. |
| `/handoff` | **Equivalent** | Structured command calls native `handoff` with optional instructions and owns a provider turn until native assistant/tool/permission/terminal events settle. |
| `/follow-up` | **Equivalent** | Structured command sends native `follow_up` and owns a provider turn rather than publishing an immediate synthetic completion. |
| Native steering | **Equivalent** | `delivery: steer` and `/steer` use native steering, correlate one user row, preserve active-turn ownership, and reject stale/terminal targets. |
| Interrupt | **Equivalent** | Native abort, exactly-one terminal event, in-flight tool/child retirement, permission cleanup, and concurrent-close serialization are covered. |
| Model selection | **Equivalent** | Catalog-backed opaque public IDs map to native provider/model IDs; committed state is re-read after open/configure/recovery. |
| Thinking selection | **Equivalent** | Model-specific effort lists, defaults, runtime changes, invalid selections, and recovery are covered. |
| Mode selection | **Equivalent** | `full`/`write`/`ask` map to `yolo`/`write`/`always-ask`; catalogs and opens expose interactive modes only when `permission` was negotiated, and live changes retain the bundled “new session” constraint. |
| Retry fallback events | **Equivalent** | Fallback telemetry renders bounded status items and triggers committed model/thinking refresh without trusting event strings as state. |
| Context and token usage | **Equivalent** | Periodic, post-compaction, fallback, terminal, timeout, and stale-generation samples publish `session.usage`. |
| Native host tools | **Equivalent** | Paseo's caller-scoped MCP endpoint is converted to OMP host tools with workspace identity, progress, cancellation, bounded results, and ownership cleanup. |
| Configured MCP servers | **Equivalent** | stdio/http/SSE transports are opened by the plugin host process, namespaced, paginated, bounded, and passed through OMP's native host-tool API. The agent-scoped MCP composer control invokes OMP's native management commands without copying its discovery or credential state. |
| Subagents | **Equivalent** | Live lifecycle/progress/events create provider-owned child sessions; subscription failure removes the negotiated capability. |
| Nested child timelines | **Equivalent** | Child/grandchild ancestry, stable IDs, live restart, cold transcript replay, terminal states, and cumulative replay bounds are covered. |
| Conversation rewind | **Equivalent** | Only conversation scope is advertised; active-turn/stale-token rejection and branch replay are tested. |
| Native branch transition | **Equivalent** | New native IDs atomically replace persistence/reservation ownership; indeterminate post-branch failures close and quarantine the session. |
| Custom executable command | **Equivalent** | Strict `providerOptions.command` replaces the executable prefix and survives recovery. |
| Custom environment | **Equivalent** | Strict `providerOptions.env` is merged below launch env and survives recovery. Strict `providerOptions.inheritEnv` stores bounded names only and resolves unshadowed daemon values at catalog/session spawn. Unexpected or internal launch failures use fixed fallbacks rather than serializing launch configuration, while explicit public validation errors may include caller-supplied configuration names or values. |
| Configured output redaction | **Equivalent** | `providerOptions.outputRedaction` defaults to `none`. `configured-values` performs bounded best-effort literal replacement for explicitly supplied credential values and every non-empty value selected through `inheritEnv`, regardless of its name, across root and nested timelines; generated, encoded, transformed, and independently streamed fragments remain outside its scope. |
| Provider parameters | **Equivalent** | `sessionDir`, `rpcTimeoutMs`, and `smol`/`slow`/`plan` model roles map to native arguments and survive recovery; cold resume authorization scans the normalized configured `sessionDir`. |
| Configured model replacement/additions | **Protocol** and **Equivalent** | Paseo applies profile `models` replacement and `additionalModels` overlays to the profile-specific plugin catalog. |
| Generic denied tools | **Equivalent** | Core forwards a bounded, deduplicated `deniedTools` list; the plugin turns recognized OMP built-ins into an explicit launch allow-list before the process starts and rejects unknown names rather than silently under-enforcing. |
| Strict provider option validation before launch | **Equivalent** | The provider registers `OmpProviderOptionsSchema`, including bounded `inheritEnv` names; core normalizes once and forwards the same names-only value through availability, cache identity, discovery, listing, and launch. |
| Profile settings in provider discovery | **Equivalent** | Core forwards profile settings to catalog, cache-key, and session-list operations; the provider includes them in cache identity without claiming unsupported live OMP settings. |
| Terminal-started OMP session hooks | **Unsupported** | The bundled terminal hook registry contains Claude, Codex, and OpenCode only; OMP exposes no registered terminal activity hook to preserve. |
| Metadata-generation flows | **Protocol** and **Equivalent** | Generic structured generation selects plugin models from catalog metadata and creates non-persisted sessions; provider responses use the existing parse/validation retry loop. |

The output boundary validates protocol shapes and bounds strings, structured values, depth, item counts, nodes, cumulative serialized bytes, and cycles. With the default `outputRedaction: "none"`, it does not heuristically redact or rewrite native OMP, model, tool, or permission content. The optional `configured-values` mode replaces exact configured credential literals on a best-effort basis, but it cannot detect generated secrets or encoded, transformed, or independently streamed fragments. Credentials therefore must not appear in prompts or tool output, and centralized Paseo policy is required for redaction guarantees. Unexpected or internal launch failures use fixed public fallbacks rather than serializing launch configuration, while explicit public validation errors may include caller-supplied configuration names or values.

## Integration boundary tests

The provider identity boundary is permanent: `server/provider/registration.ts` registers only `omp-plugin`, while diagnostics recognize both the bundled `omp` provider and this plugin. `tests/server-bundle.test.ts` verifies the packaged server contribution keeps that identity. No test removes, replaces, aliases, migrates, or assumes ownership of the bundled provider.

Run the real Docker host/container ownership boundary test with:

```sh
npm run test:integration:docker
```

The script starts the MCP server as a host process, calls it from a Node container, executes a host tool, and verifies the returned host PID, host working directory, caller agent ID, and workspace ID. Set `PASEO_OMP_DOCKER_IMAGE` to override the default `node:22.22.1-bookworm-slim` image.

Run the equivalent Windows-host/WSL boundary with:

```sh
npm run test:integration:wsl
```

The WSL script skips when `wsl.exe` or WSL Node is unavailable. Set `PASEO_OMP_REQUIRE_WSL=1` to make either condition fatal, as CI does. `PASEO_OMP_WSL_NODE` may override the default `node` executable inside WSL.

Run the full local provider integration canary with:

```sh
npm run test:integration:canary
```

Set `PASEO_CANARY_OMP_VERSION` to exercise another pinned release. The local runner knows the SHA-256 values for every version in the compatibility matrix; an unlisted version requires explicit `PASEO_CANARY_OMP_SHA256_AMD64` and `PASEO_CANARY_OMP_SHA256_ARM64` values. It allocates isolated loopback ports, builds a version-specific image, waits for both services to become healthy, runs the deterministic provider scenarios, prints container logs on failure, and always removes its containers, volumes, and image namespace.

The Linux real-OMP CI matrix downloads checksummed `omp-linux-x64` assets for OMP 17.2.15, 17.3.4, 18.0.11, 18.1.10, 18.1.15, 18.1.22, and 18.2.0, verifies each binary's pinned GitHub release SHA-256, and runs `PASEO_OMP_REAL_E2E=1 PASEO_OMP_VERSION=<version> npm test -- tests/provider.real.e2e.test.ts`. The historical entries are the four pre-floor releases with more than 4,000 downloads shown by npm for the seven days ending 2026-09-15; they are compatibility regression probes, not a support commitment. The remaining entries cover the supported floor, newest patch in that minor line, and current release. The test uses the real OMP binary and a local deterministic OpenAI-compatible model endpoint, so catalog, text-plus-Bash, and oversized-image execution are mandatory without repository secrets.

The controlled canary in `canary/compose.yml` builds this plugin into that official Paseo image and installs checksummed OMP binaries for `amd64` and `arm64`. `canary/smoke.ts` passed catalog/mode discovery, text and image prompts, Bash, a configured stdio MCP tool, permission allow/deny/cancel, steering, interruption, session listing/import/resume, subagents, conversation rewind followed by another turn, Hub process visibility, usage, and every plugin RPC. Browser verification loaded the global OMP health/configuration surface and the agent-scoped Hub, Memory, and Sessions controls. The default mock returned `CANARY_MOCK_OK`, `CANARY_TOOL_OK`, and `CANARY_MCP_OK`; the optional Ollama profile pulled `qwen2.5:0.5b` and completed turns without paid credentials. The harness records the canary-only `/compact` and `/handoff` failures instead of masking them.

## OMP RPC compatibility intake

Treat every upstream `rpc-ui` change as explicit compatibility work. Do not widen a Zod schema with `passthrough`, `unknown`, or an optional field merely to accept a new frame.

1. Open an issue with the [OMP RPC compatibility template](https://github.com/omercnet/paseo-plugins/issues/new?template=omp-rpc-compatibility.yml). Record exact OMP, plugin, Paseo daemon, and Paseo app versions; the negotiated protocol and capabilities; the smallest reproduction; and sanitized frame shapes. Never attach credentials, private paths, prompts, or transcripts.
2. Reproduce against both the reported OMP revision and the pinned minimum-tested `omp/18.1.15` binary. Classify the change as additive optional, additive required, removed or renamed, type or semantic change, or negotiation change.
3. Compare the affected ready, request, response, or event shape with the strict schemas in `server/provider/omp-rpc.ts`. Decide whether the plugin can support both contracts without ambiguity. A breaking contract requires an explicit compatibility decision and changelog entry, not silent coercion.

Required drift is release-blocking. If OMP adds a mandatory frame, removes or renames a required method or field, or changes an existing field's meaning, keep the strict parser and make session startup or the active request fail visibly. Do not silently discard the frame, make the requirement optional, or route around negotiation. Resume release work only after both sides have an explicit compatible contract, fixtures, focused regressions, and a real-binary result.
4. Add the changed frame to `tests/fixtures/fake-omp.ts`, then add a focused regression for acceptance, rejection, negotiation, cancellation, and bounds as applicable. Capability changes must cover both reciprocal negotiation and the absent-capability fallback. Typed approval drift must retain the generic extension-question path when `typedToolApprovals: 1` is not negotiated.
5. Run `npm test -- tests/omp-rpc.test.ts tests/provider.test.ts`, `npm run test:coverage`, and `PASEO_OMP_REAL_E2E=1 npm test -- tests/provider.real.e2e.test.ts` with the candidate OMP binary.
6. Update the minimum-tested version only after the real-binary job is pinned to that release and its SHA-256, the compatibility issue links the evidence, and the README, support matrix, CI job name, fixture version, and changelog agree.

The plugin maintainer owns triage and adaptation. Escalate an isolated OMP implementation defect upstream and an isolated Paseo SDK or provider-protocol defect to Paseo, while keeping the cross-project regression in this repository.

## Release publication

`release-please.yml` only creates release metadata and forwards the created `paseo-omp` tag and commit SHA to `publish-paseo-omp.yml`. The metadata job never checks out or executes repository code. The publisher has no pull-request permission, resolves the tag independently, and waits for a successful `CI` push run whose `head_sha` is exactly the tagged commit before checkout or execution.

The publisher builds the self-contained ZIP, writes its corruption-detection checksum, creates a signed GitHub build-provenance attestation for both files, rechecks that the tag still resolves to the gated SHA, and uploads with `--clobber`. To recover an interrupted upload, dispatch **Publish Paseo OMP** with the existing `paseo-omp-v<version>` tag; the same identity and CI gates apply, so reruns are idempotent.

The SHA-256 file is not a signature. Consumers authenticate the archive with `gh attestation verify` and may use the checksum only to detect accidental transfer or storage corruption.

### Alpha release channel

`release-please-config.json` sets only `paseo-omp` to `prerelease: true` with `prerelease-type: alpha`. With the existing `initial-version: 0.1.0` and manifest version `0.0.0`, the first release PR is expected to prepare `0.1.0-alpha.1`, tag it as `paseo-omp-v0.1.0-alpha.1`, and mark the GitHub release as a prerelease. Other monorepo components keep their existing stable release behavior.

Do not manually edit `paseo-omp/package.json` or `.release-please-manifest.json` before that release PR; Release Please must update both atomically. After alpha validation, remove `prerelease` and `prerelease-type` from the `paseo-omp` package config and let Release Please prepare stable `0.1.0`. Never retag an alpha commit as stable.

The go/no-go criteria, manual acceptance boundary, and alpha limitation list are maintained in [docs/alpha-release-checklist.md](docs/alpha-release-checklist.md). Preparation does not authorize a push, tag, GitHub release, or publication; explicit maintainer approval after testing is required.

## Audit verification

- `npm run check`: clean across 84 files.
- `npm run typecheck`: clean.
- `npm test`: full Vitest suite passed, with environment-gated scenarios skipped when their runtimes were unavailable.
- `npm test -- tests/provider-conformance.test.ts`: host-boundary conformance coverage includes `prompt.command`, `session.configure`, typed and fallback permission allow/deny/cancel paths, registry-driven reload/removal, verified stubborn-descendant cleanup, and sequential turns plus interrupt races with post-turn barriers.
- `PASEO_OMP_REAL_E2E=1 PASEO_OMP_VERSION=<version> npm test -- tests/provider.real.e2e.test.ts`: the installed matrix version's catalog and hermetic real-binary text/Bash and oversized-image scenarios run against a local deterministic model.
- `npm run test:coverage`: Vitest enforces aggregate 85% function and 89% line coverage over loaded source modules. Generated `dist/**` trees are excluded.
- `npm run package:release`: `dist/paseo-omp-v0.0.0.zip` builds from tracked allowlisted source plus its closed production/compiler dependency set.
- `npm run test:integration:install`: the self-contained archive imports dependencies and compiles with an unreachable proxy; a fresh Git-style checkout installs with lifecycle scripts disabled, retains required runtime packages, typechecks, bundles both entries, and loads the server contribution.
- `npm run test:integration:docker`: verifies the host/container ownership boundary.
- `npm run test:integration:wsl`: locally skips when `wsl.exe` is unavailable; Windows CI sets `PASEO_OMP_REQUIRE_WSL=1`, so this boundary remains required there.
- `docker compose -f canary/compose.yml`: official Paseo 0.8.0, deterministic mock, Tailscale-bound web UI, and optional Ollama `qwen2.5:0.5b` passed end-to-end.
- `mise x actionlint@1.7.12 -- actionlint .github/workflows/*.yml`: passed.
- `zizmor .github/workflows`: no findings (offline audit; six repository-wide suppressions remain).
- Release Please 17.1.2 `config.json` and `manifest.json` schema validation: passed for `release-please-config.json` and `.release-please-manifest.json`.

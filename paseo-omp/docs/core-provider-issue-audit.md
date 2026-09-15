# Core OMP provider issue audit

This audit compares reports in `getpaseo/paseo` with the community `omp-plugin` provider. It was refreshed on 2026-09-12 from GitHub issue titles and bodies containing `OMP`, `oh-my-pi`, or `rpc-ui`, OMP-related pull requests, and materially equivalent Pi/RPC reports. GitHub Discussions were also inspected; the repository had no OMP-related discussion.

Issue and pull-request pairs are consolidated by root cause. A closed upstream issue does not prove the plugin implements the behavior, and an open upstream issue does not imply the plugin is affected.

Status meanings:

- **Verified**: the plugin has implementation and focused automated evidence for the consumer-visible behavior.
- **Mitigated**: the plugin bounds or rejects the failure, but an upstream or host condition remains.
- **Gap**: behavior is missing or only partially supported by the plugin.
- **Host-owned**: the report concerns Paseo behavior outside the provider boundary.

## Lifecycle, turns, and recovery

| Reports | Status | Plugin comparison |
| --- | --- | --- |
| [#3838](https://github.com/getpaseo/paseo/issues/3838), [PR #3839](https://github.com/getpaseo/paseo/pull/3839) | **Verified** | A dead OMP subprocess invalidates its generation. A later write lazily resumes the same native session. Process-tree cleanup, recovery, and registry replacement are covered. |
| [#3252](https://github.com/getpaseo/paseo/issues/3252), equivalent Pi [#3496](https://github.com/getpaseo/paseo/issues/3496), [PR #3258](https://github.com/getpaseo/paseo/pull/3258) | **Verified** | Hidden and custom notices do not terminalize a turn before the native user echo and terminal evidence. |
| [#2260](https://github.com/getpaseo/paseo/issues/2260), [PR #2261](https://github.com/getpaseo/paseo/pull/2261) | **Verified** | Incomplete or compacted `agent_end` frames use complete streamed `message_end` evidence or bounded history correlated by entry ID, with idle state confirmed before and after retrieval. Success, failure, native cancellation, and concurrent interrupts are preserved; missing, unavailable, non-correlatable, or conflicting terminal evidence fails closed with content-free count diagnostics. |
| [#2281](https://github.com/getpaseo/paseo/issues/2281), [PR #2282](https://github.com/getpaseo/paseo/pull/2282) | **Verified** | Local-only prompt results and structured commands have explicit terminal ownership. |
| [#3654](https://github.com/getpaseo/paseo/issues/3654), [#3998](https://github.com/getpaseo/paseo/issues/3998), [PR #3667](https://github.com/getpaseo/paseo/pull/3667) | **Verified** | Post-`agent_end` state reconciliation is bounded. Stale or unavailable `get_state` cannot leave a turn running forever. |
| [#3999](https://github.com/getpaseo/paseo/issues/3999), [#4000](https://github.com/getpaseo/paseo/issues/4000), [#4039](https://github.com/getpaseo/paseo/issues/4039), [PR #3772](https://github.com/getpaseo/paseo/pull/3772), [PR #4217](https://github.com/getpaseo/paseo/pull/4217) | **Verified** | `prompt.steer` is negotiated and implemented with expected-turn checks, acknowledgement ordering, duplicate correlation, and interrupt/terminal race coverage. |
| Shared RPC cancellation [#3540](https://github.com/getpaseo/paseo/issues/3540), Pi [#3749](https://github.com/getpaseo/paseo/issues/3749) | **Verified in provider** | Native abort, exactly-one terminal event, permission cleanup, descendant cleanup, and uncertain-cleanup quarantine are tested. UI keyboard delivery remains host-owned. |
| [#3218](https://github.com/getpaseo/paseo/issues/3218) | **Verified at provider boundary** | Session close owns and awaits OMP process cleanup. Whether every archive UI route invokes provider close is a host concern. |

## Persistence, import, and subagents

| Reports | Status | Plugin comparison |
| --- | --- | --- |
| [#2006](https://github.com/getpaseo/paseo/issues/2006), [PR #2004](https://github.com/getpaseo/paseo/pull/2004), [PR #2131](https://github.com/getpaseo/paseo/pull/2131) | **Verified** | Descriptor parsing accepts bounded leading title/session metadata. |
| [#2727](https://github.com/getpaseo/paseo/issues/2727), [PR #4416](https://github.com/getpaseo/paseo/pull/4416) | **Verified** | Import resolves opaque native identity and preserves model and thinking selection. |
| [#2796](https://github.com/getpaseo/paseo/issues/2796), [PR #2065](https://github.com/getpaseo/paseo/pull/2065), [PR #2265](https://github.com/getpaseo/paseo/pull/2265) | **Verified** | Host-wide discovery is supported when `cwd` is omitted; scoped listing still enforces absolute workspace ownership. This also prevents the previously observed import-sheet crash path. |
| [#2232](https://github.com/getpaseo/paseo/issues/2232), equivalent Pi [#3160](https://github.com/getpaseo/paseo/issues/3160), [PR #2052](https://github.com/getpaseo/paseo/pull/2052), [PR #2245](https://github.com/getpaseo/paseo/pull/2245), [PR #3371](https://github.com/getpaseo/paseo/pull/3371) | **Verified** | Native child lifecycle, progress, nested timelines, replay, active-child gating, and parent-terminal deferral use `session.subsession`. |
| Pi lifecycle variants [#3845](https://github.com/getpaseo/paseo/issues/3845), [#3847](https://github.com/getpaseo/paseo/issues/3847), [#4309](https://github.com/getpaseo/paseo/issues/4309) | **Verified by the same model** | Child activity and terminal ownership are explicit rather than inferred from one provider event. |
| [#2728](https://github.com/getpaseo/paseo/issues/2728) | **Gap** | Listing and import work, but the plugin does not install an OMP terminal hook that automatically creates a Paseo agent for terminal-started sessions. |
| [#2574](https://github.com/getpaseo/paseo/issues/2574) | **Mitigated** | Recursive bounded transcript discovery covers OMP files. Generic archived-agent and registry visibility remain host-owned. |
| [#4707](https://github.com/getpaseo/paseo/issues/4707) | **Host-owned** | Plugin reservations reject conflicting live ownership; archived-agent workspace re-homing policy belongs to Paseo. |

## Transport and startup

| Reports | Status | Plugin comparison |
| --- | --- | --- |
| [#2548](https://github.com/getpaseo/paseo/issues/2548), [#2966](https://github.com/getpaseo/paseo/issues/2966), [PR #3038](https://github.com/getpaseo/paseo/pull/3038), [PR #3184](https://github.com/getpaseo/paseo/pull/3184) | **Verified** | RPC protocol v2 is required. Chunk assembly, frame byte counts, deadlines, malformed frames, and oversized frames are tested. |
| [#2473](https://github.com/getpaseo/paseo/issues/2473) | **Mitigated** | Strict frame schemas, request correlation, session identity, and bounds prevent ordinary stdout JSON from becoming a valid response. OMP should still keep non-protocol output off RPC stdout. |
| [#4047](https://github.com/getpaseo/paseo/issues/4047), [PR #4048](https://github.com/getpaseo/paseo/pull/4048) | **Verified** | Stdin EPIPE and stream closure fail pending calls and enter bounded cleanup/recovery rather than crashing the daemon. |
| [#1657](https://github.com/getpaseo/paseo/issues/1657), [#1730](https://github.com/getpaseo/paseo/issues/1730), [#2226](https://github.com/getpaseo/paseo/issues/2226), [#4142](https://github.com/getpaseo/paseo/issues/4142), [PR #4008](https://github.com/getpaseo/paseo/pull/4008), [PR #4143](https://github.com/getpaseo/paseo/pull/4143) | **Verified** | Availability and ready probes use bounded configurable timeouts and distinguish missing, unrunnable, incompatible, and available binaries. |
| [#1446](https://github.com/getpaseo/paseo/issues/1446), [#2456](https://github.com/getpaseo/paseo/issues/2456) | **Mitigated / host-owned** | Plugin discovery and cache identity are bounded. Provider snapshot scheduling and stale host snapshots remain Paseo behavior. |
| [#2610](https://github.com/getpaseo/paseo/issues/2610) | **Mitigated / host-owned** | OMP input frames, replay, and retained state are bounded; final daemon-to-client WebSocket buffering is owned by Paseo. |

## Models, modes, commands, and usage

| Reports | Status | Plugin comparison |
| --- | --- | --- |
| [#1692](https://github.com/getpaseo/paseo/issues/1692), [PR #1698](https://github.com/getpaseo/paseo/pull/1698), [PR #2539](https://github.com/getpaseo/paseo/pull/2539) | **Verified** | The plugin uses `get_available_commands`, publishes aliases, and fails slash dispatch closed when discovery is unavailable. |
| [#2080](https://github.com/getpaseo/paseo/issues/2080), Pi [#2117](https://github.com/getpaseo/paseo/issues/2117), [PR #2171](https://github.com/getpaseo/paseo/pull/2171), [PR #2191](https://github.com/getpaseo/paseo/pull/2191) | **Verified** | Thinking options and defaults are model-specific; unsupported levels fail closed. |
| Pi [#2663](https://github.com/getpaseo/paseo/issues/2663), [#4382](https://github.com/getpaseo/paseo/issues/4382) | **Verified** | Model and thinking changes are committed only after re-reading native state. |
| [#2405](https://github.com/getpaseo/paseo/issues/2405), [PR #2406](https://github.com/getpaseo/paseo/pull/2406) | **Verified** | Nullable context windows remain valid catalog entries. |
| [#2544](https://github.com/getpaseo/paseo/issues/2544), [PR #2865](https://github.com/getpaseo/paseo/pull/2865) | **Verified** | Strict provider options expose command prefix, environment, session directory, timeout, role models, model overlays, and denied tools. |
| [#2857](https://github.com/getpaseo/paseo/issues/2857), [PR #2859](https://github.com/getpaseo/paseo/pull/2859) | **Verified** | Native compact requests use no ordinary RPC request timeout; provider-level compaction state owns completion, cancellation, and usage refresh. |
| [#4073](https://github.com/getpaseo/paseo/issues/4073), [PR #4074](https://github.com/getpaseo/paseo/pull/4074) | **Verified** | Fallback and model/thinking events trigger committed runtime-state refresh rather than trusting event labels as final state. |
| [#1888](https://github.com/getpaseo/paseo/issues/1888), [PR #1882](https://github.com/getpaseo/paseo/pull/1882), [PR #2503](https://github.com/getpaseo/paseo/pull/2503) | **Verified** | Active, terminal, post-compaction, fallback, and recovery sampling publish `session.usage`. |
| [#4437](https://github.com/getpaseo/paseo/issues/4437), [PR #4449](https://github.com/getpaseo/paseo/pull/4449) | **Gap** | The plugin advertises `full`, `write`, and `ask`; it does not expose a distinct native Fast mode. |
| [#3627](https://github.com/getpaseo/paseo/issues/3627), [PR #4205](https://github.com/getpaseo/paseo/pull/4205) | **Partial** | Plan role-model configuration and `/handoff` exist. There is no first-class `plan` mode, and the controlled canary does not satisfy the native handoff workflow prerequisites. |

## Timeline, media, and questions

| Reports | Status | Plugin comparison |
| --- | --- | --- |
| [#4509](https://github.com/getpaseo/paseo/issues/4509), equivalent Pi [#2803](https://github.com/getpaseo/paseo/issues/2803), [PR #4510](https://github.com/getpaseo/paseo/pull/4510) | **Verified** | `contentIndex` participates in stable reasoning identity, preserving interleaved live blocks and replay shape. |
| [#3244](https://github.com/getpaseo/paseo/issues/3244), [PR #3245](https://github.com/getpaseo/paseo/pull/3245) | **Verified** | Tool-result and assistant images are validated, bounded, retained, packaged, and rendered through the plugin transformer. |
| [#3527](https://github.com/getpaseo/paseo/issues/3527), [PR #3628](https://github.com/getpaseo/paseo/pull/3628) | **Verified** | Positional `optionDetails.description` metadata is preserved in Paseo permission questions. |
| [#1726](https://github.com/getpaseo/paseo/issues/1726), [PR #1879](https://github.com/getpaseo/paseo/pull/1879) | **Partial** | Structured user questions are supported. Dedicated collapsing/presentation for very large skill bodies is not demonstrated. |
| [#2264](https://github.com/getpaseo/paseo/issues/2264), equivalent Pi [#2674](https://github.com/getpaseo/paseo/issues/2674), [PR #2280](https://github.com/getpaseo/paseo/pull/2280) | **Verified** | `display:false` custom messages remain hidden. |
| [#2266](https://github.com/getpaseo/paseo/issues/2266), [PR #2284](https://github.com/getpaseo/paseo/pull/2284) | **Verified** | Manual and automatic compaction lifecycle and recap data map to stable timeline operations. |
| Pi [#3121](https://github.com/getpaseo/paseo/issues/3121), [PR #4497](https://github.com/getpaseo/paseo/pull/4497) | **Verified** | Todo events map to Paseo's native todo item; the plugin does not add a second timeline-card renderer. |
| [#3850](https://github.com/getpaseo/paseo/issues/3850) | **Verified by avoidance** | The inherited environment allowlist does not pass `TERM_PROGRAM`; the plugin never advertises Kitty graphics support. |

## MCP, tools, and host behavior

| Reports | Status | Plugin comparison |
| --- | --- | --- |
| [#2060](https://github.com/getpaseo/paseo/issues/2060), [PR #2418](https://github.com/getpaseo/paseo/pull/2418), [PR #3820](https://github.com/getpaseo/paseo/pull/3820), [PR #3449](https://github.com/getpaseo/paseo/pull/3449) | **Verified** | Configured and caller-scoped MCP tools are discovered, policy-filtered, bound before readiness, canceled, and bounded. Docker exercises a configured stdio MCP tool. |
| Pi [#3004](https://github.com/getpaseo/paseo/issues/3004) | **Verified structurally** | Host-tool setup completes before `session.ready`; capability-registration races cannot expose a partially bound catalog. |
| Pi [#3666](https://github.com/getpaseo/paseo/issues/3666) | **Verified** | Exact preapproval is validated. If policy cannot be represented, startup fails closed instead of broadening access. |
| [#1892](https://github.com/getpaseo/paseo/issues/1892) | **Host-owned gap** | Paseo decides global voice-mode eligibility. The plugin does not synthesize a missing speak tool. |
| [#3762](https://github.com/getpaseo/paseo/issues/3762), Pi [#2815](https://github.com/getpaseo/paseo/issues/2815) | **Host-owned** | The plugin preserves and validates the received tool catalog but does not redefine Paseo's own MCP schemas. |
| [#3178](https://github.com/getpaseo/paseo/issues/3178) | **Avoided** | The plugin permanently registers `omp-plugin`, never the built-in `omp` identity. |
| [#3217](https://github.com/getpaseo/paseo/issues/3217) | **Host-owned** | Draft submission and agent creation multiplicity occur before provider-session behavior. |

## Origin records, not regressions

[#1176](https://github.com/getpaseo/paseo/issues/1176), [#1189](https://github.com/getpaseo/paseo/issues/1189), [PR #1177](https://github.com/getpaseo/paseo/pull/1177), [PR #1388](https://github.com/getpaseo/paseo/pull/1388), and [PR #2067](https://github.com/getpaseo/paseo/pull/2067) requested or introduced first-class OMP support. The plugin satisfies that product goal independently under `omp-plugin`; it does not replace or migrate bundled `omp` agents.

## Release blockers and tracked gaps

Before moving from alpha toward stable, track these separately:

1. Decide whether native Fast mode can be represented honestly through the public provider SDK.
2. Decide whether a first-class plan mode is possible; separately make `/handoff` reproducible in the controlled canary.
3. Decide whether terminal-started automatic registration belongs in this plugin or requires a generic Paseo hook.
4. Add an explicit large-skill presentation regression or document it as host-owned.
5. Keep stdout contamination defenses, and pursue upstream OMP protocol-channel purity.
6. Keep host-owned issues visibly separated: provider snapshot refresh, voice eligibility, MCP schemas, WebSocket buffering, archive routing, and draft/agent creation.

## Maintenance rule

Refresh this audit before each release candidate. New OMP or materially shared Pi/RPC reports must be added, deduplicated by root cause, and classified with a concrete test, an explicit limitation, or a linked host/upstream issue. Never infer that a plugin is fixed merely because the corresponding core issue is closed.
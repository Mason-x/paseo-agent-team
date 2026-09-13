# Changelog

## 0.1.0 (2026-09-13)


### Features

* **paseo-omp:** add first OMP provider plugin ([#19](https://github.com/omercnet/paseo-plugins/issues/19)) ([f6f3e5e](https://github.com/omercnet/paseo-plugins/commit/f6f3e5e224bf8537f85305d79ea5d1bcf5849549))

## Changelog

## Unreleased

### Features

* Add the permanent `omp-plugin` direct provider, OMP workspace tools, diagnostics, versioned persistence, and nested-subagent support.
* Add Release Please packaging, Git installation, compatibility policy, and release rollback guidance.
* Add a digest-pinned official Paseo Docker canary with deterministic mock, configured MCP, and optional local Ollama inference.
* Document the deduplicated Paseo core OMP issue audit, verified plugin fixes, host-owned concerns, and remaining alpha gaps.

### Bug Fixes

* Cancel pending generic permissions before interrupting OMP so the host receives a terminal cancellation.
* Rebuild the native branch watermark during replay so a post-rewind prompt retains terminal ownership.
* Label `xd://` and MCP timeline calls with their registered human-readable title instead of the generic `write` transport or technical route name.
* Support host-wide session discovery when Paseo opens the unscoped import sheet, preventing its provider failure path from crashing affected 0.8 daemons.
* Recover degraded or compacted `agent_end` outcomes from complete streamed assistant evidence while continuing to fail closed on partial evidence.
* Preserve `PLEXUS_API_KEY` when launching OMP so Plexus extension providers can attach their configured bearer header.

### Security

* Split release metadata from least-privilege artifact publishing, gate publication on exact-commit CI, and attest release artifacts.
* Make release archives self-contained, restrict source inputs to tracked allowlisted files, and verify offline installation plus contained extraction.
* Disable dependency lifecycle scripts during Git installation and verify both plugin entries from a fresh checkout.

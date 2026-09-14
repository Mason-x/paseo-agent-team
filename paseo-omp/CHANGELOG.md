# Changelog

## [0.1.2](https://github.com/omercnet/paseo-plugins/compare/paseo-omp-v0.1.1...paseo-omp-v0.1.2) (2026-09-13)


### Bug Fixes

* **paseo-omp:** serialize persistent session registration ([#35](https://github.com/omercnet/paseo-plugins/issues/35)) ([03d38bc](https://github.com/omercnet/paseo-plugins/commit/03d38bc7e4a3d00ec54190e2b234a459bbdc55ae))
* **paseo-omp:** settle late child dispatches ([#34](https://github.com/omercnet/paseo-plugins/issues/34)) ([0746f11](https://github.com/omercnet/paseo-plugins/commit/0746f11fd94f15028fd624ac7a99ac8ebd88b63d))

## [0.1.1](https://github.com/omercnet/paseo-plugins/compare/paseo-omp-v0.1.0...paseo-omp-v0.1.1) (2026-09-13)


### Bug Fixes

* **paseo-omp:** preserve Plexus plugin credentials ([#27](https://github.com/omercnet/paseo-plugins/issues/27)) ([0674ef1](https://github.com/omercnet/paseo-plugins/commit/0674ef1d3d66efa37ec9d2da9a19dd57472c2cdd))
* **paseo-omp:** wait for session registration ([#30](https://github.com/omercnet/paseo-plugins/issues/30)) ([82e901e](https://github.com/omercnet/paseo-plugins/commit/82e901e4bb0e66cafeb572c4bd92e0461b57a647))

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
* Add the OMP sidebar configuration editor with revision-checked scalar writes, structured collection display, and documentation of provider-profile options including names-only inherited environment settings.
* Add official OMP documentation links and an OMP-native plugin manager with status, user-scoped lifecycle actions, upgrades, write-only non-secret scalar configuration, and presence-only secret handling.

### Bug Fixes

* Cancel pending generic permissions before interrupting OMP so the host receives a terminal cancellation.
* Rebuild the native branch watermark during replay so a post-rewind prompt retains terminal ownership.
* Label `xd://` and MCP timeline calls with their registered human-readable title instead of the generic `write` transport or technical route name.
* Support host-wide session discovery when Paseo opens the unscoped import sheet, preventing its provider failure path from crashing affected 0.8 daemons.
* Recover degraded or compacted `agent_end` outcomes from complete streamed assistant evidence while continuing to fail closed on partial evidence.
* Preserve `PLEXUS_API_KEY` when launching OMP so Plexus extension providers can attach their configured bearer header.
* Serialize concurrent persistent-session registration so startup restoration waits instead of returning transient provider failures.
* Expose caller-scoped Paseo orchestration tools under their native names so OMP skills can invoke `list_profiles`, `create_agent`, and related tools without CLI fallback.
* Render validated WebP timeline images on capable clients, show a local fallback when decoding fails, hide machine-facing coordinate annotations, and request PNG/JPEG output from OMP for cross-client compatibility.

### Security

* Split release metadata from least-privilege artifact publishing, gate publication on exact-commit CI, and attest release artifacts.
* Make release archives self-contained, restrict source inputs to tracked allowlisted files, and verify offline installation plus contained extraction.
* Disable dependency lifecycle scripts during Git installation and verify both plugin entries from a fresh checkout.
* Document native-output fidelity, optional best-effort configured-value replacement, its limits, and the host-owned redaction boundary.

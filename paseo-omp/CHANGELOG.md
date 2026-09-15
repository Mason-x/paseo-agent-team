# Changelog

## [0.2.1](https://github.com/omercnet/paseo-plugins/compare/paseo-omp-v0.2.0...paseo-omp-v0.2.1) (2026-09-15)


### Bug Fixes

* **paseo-omp:** handle oversized pasted images ([#55](https://github.com/omercnet/paseo-plugins/issues/55)) ([4b6ed7d](https://github.com/omercnet/paseo-plugins/commit/4b6ed7d3015f1f85dcc13a9dd29061efef5f22c7))
* **paseo-omp:** preserve buffered terminal ownership evidence ([#54](https://github.com/omercnet/paseo-plugins/issues/54)) ([b49400e](https://github.com/omercnet/paseo-plugins/commit/b49400e09d73cd67a23986f52c17bfc1f23cd297))
* **paseo-omp:** steer auto messages during active turns ([#61](https://github.com/omercnet/paseo-plugins/issues/61)) ([b36002b](https://github.com/omercnet/paseo-plugins/commit/b36002bbc5b108cd525dd9c356fbdb89d6a9f3e6))

## [0.2.0](https://github.com/omercnet/paseo-plugins/compare/paseo-omp-v0.1.2...paseo-omp-v0.2.0) (2026-09-14)


### Features

* **paseo-omp:** add config workspace shell ([#48](https://github.com/omercnet/paseo-plugins/issues/48)) ([1c0126b](https://github.com/omercnet/paseo-plugins/commit/1c0126b51bd3c8ceccacf7758fc14270cd67440e))
* **paseo-omp:** add opt-in output redaction ([#44](https://github.com/omercnet/paseo-plugins/issues/44)) ([0b0cea1](https://github.com/omercnet/paseo-plugins/commit/0b0cea1501230437fe4d6390b67ca25ee2079c93))
* **paseo-omp:** browse complete runtime settings catalog ([#49](https://github.com/omercnet/paseo-plugins/issues/49)) ([ef68cd7](https://github.com/omercnet/paseo-plugins/commit/ef68cd754fa3aad4a15bcdc8649f8c7dcdcde79e))
* **paseo-omp:** edit scalar settings in sidebar ([#50](https://github.com/omercnet/paseo-plugins/issues/50)) ([78da43f](https://github.com/omercnet/paseo-plugins/commit/78da43fd155ed06e29faef507156399b55cf3439))
* **paseo-omp:** support explicit env passthrough ([#39](https://github.com/omercnet/paseo-plugins/issues/39)) ([e22b3b4](https://github.com/omercnet/paseo-plugins/commit/e22b3b448f218bdecfcb3a168c14fa32051a6392))


### Bug Fixes

* **omp:** preserve safe published URLs ([#42](https://github.com/omercnet/paseo-plugins/issues/42)) ([4530430](https://github.com/omercnet/paseo-plugins/commit/4530430a02bee076f8940c376401d3266ce17499))
* **paseo-omp:** align prompt attachment rendering ([#41](https://github.com/omercnet/paseo-plugins/issues/41)) ([4b708c8](https://github.com/omercnet/paseo-plugins/commit/4b708c897b4af4cd6673e7581f736e95843b545b))
* **paseo-omp:** expose native Paseo tools ([#52](https://github.com/omercnet/paseo-plugins/issues/52)) ([3b52adf](https://github.com/omercnet/paseo-plugins/commit/3b52adff1de6329fa9f0bc4a1dcea339166e3974))
* **paseo-omp:** label direct MCP tool calls ([#53](https://github.com/omercnet/paseo-plugins/issues/53)) ([e09b1fd](https://github.com/omercnet/paseo-plugins/commit/e09b1fd2c05cb45422e7d0633e8b638d0841b931))
* **paseo-omp:** preserve structured tool results ([#46](https://github.com/omercnet/paseo-plugins/issues/46)) ([9e5fe98](https://github.com/omercnet/paseo-plugins/commit/9e5fe989e57e100f67285257cada3242218eee58))
* **paseo-omp:** render WebP images across clients ([#51](https://github.com/omercnet/paseo-plugins/issues/51)) ([397cb2d](https://github.com/omercnet/paseo-plugins/commit/397cb2d1e660e43e22312ecf9f054d77afcddc6e))
* **paseo-omp:** stop speculative stream redaction ([#40](https://github.com/omercnet/paseo-plugins/issues/40)) ([539cb61](https://github.com/omercnet/paseo-plugins/commit/539cb61db0b904b8130319c7887852f991c50aba))

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

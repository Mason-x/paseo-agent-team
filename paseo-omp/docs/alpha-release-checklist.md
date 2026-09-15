# Alpha release checklist

This checklist prepares `paseo-omp-v0.1.0-alpha.1`. It does not authorize publication. A maintainer must explicitly approve the tested artifact before any push, tag, GitHub release, or package publication.

## Release identity

- [ ] Release Please proposes `0.1.0-alpha.1` from manifest version `0.0.0`.
- [ ] Package, tag, and archive names are `@omercnet/paseo-omp`, `paseo-omp-v0.1.0-alpha.1`, and `paseo-omp-v0.1.0-alpha.1.zip`.
- [ ] Provider identity remains `omp-plugin`; bundled `omp` remains independent and enabled or disabled by the user.
- [ ] Paseo requirement remains an official released range, currently `^0.8.0`.
- [ ] Minimum tested OMP version, checksum, CI job, README, SUPPORT, and TESTING agree.

## Required gates

- [ ] `npm run check`
- [ ] `npm run typecheck`
- [ ] `npm run test:coverage`; aggregate loaded-source coverage meets the configured threshold.
- [ ] Real installed OMP regression against the documented minimum version.
- [ ] `npm run package:release`
- [ ] `npm run test:integration:install`
- [ ] `npm run test:integration:docker`
- [ ] Windows/WSL host ownership job passes in CI.
- [ ] Docker canary matrix passes on the exact release candidate.
- [ ] GitHub Actions syntax and release-configuration schemas pass.
- [ ] Release ZIP contents contain documentation, production dependencies, and both plugin entries without development-only files.

## Required manual acceptance

- [ ] Maintainer installs the exact candidate archive into the controlled official-Paseo Docker canary.
- [ ] Maintainer verifies catalog, prompt, tools, configured MCP, permissions, steer, interrupt, import/resume, subagents, rewind, usage, Hub, and plugin surfaces.
- [ ] Maintainer confirms the known limitations are acceptable for alpha.
- [ ] Maintainer explicitly authorizes publication after testing. Silence or prior approval for development is not release authorization.

## Alpha blocker

- [x] `omp-audit.1`: incomplete or compacted `agent_end` frames recover success, failure, or native cancellation from complete streamed `message_end` evidence, or from bounded history whose entry IDs correlate with the streamed turn. Idle state is confirmed before and after retrieval, and concurrent interrupts remain authoritative. Missing, unavailable, non-correlatable, or conflicting terminal evidence fails closed with content-free count diagnostics.

## Accepted alpha limitations

These may remain only when called out in `SUPPORT.md`, `CHANGELOG.md`, and the GitHub prerelease notes:

- Native Fast mode is not exposed.
- No first-class plan mode; `/handoff` depends on native OMP prerequisites not reproduced by the deterministic canary.
- Terminal-started OMP sessions are importable but are not registered automatically.
- Large skill-body presentation has no dedicated provider regression.
- OMP RPC stdout contamination is structurally mitigated but requires upstream channel purity.
- `omp` and `omp-plugin` do not share ownership, configuration, or persisted handles.
- The deterministic model does not implement OMP compaction summarization; protocol fixtures cover compaction behavior.
- The tiny Ollama model is exploratory and is not a deterministic oracle.

## Non-blocking post-alpha cleanup

- [ ] `omp-maintenance.1`: remove `ProviderRegistrationCompat`, both `ProviderCatalogOptionsCompat` declarations, and `parseProviderInputCompat` after the published `@getpaseo/plugin` types natively expose the registration hooks and request fields they bridge. The required upstream surface is `providerOptionsSchema`, `getCatalogCacheKey`, `checkAvailability`, catalog/session-list `providerOptions` plus `settings`, and session-open `deniedTools`. This is type/compatibility cleanup only; it must not change provider behavior and does not block alpha.

## Release notes

The prerelease notes must include:

1. Alpha support statement and compatibility range.
2. Permanent side-by-side `omp-plugin` identity.
3. Provider SDK capability percentage and link to the README matrix.
4. Link to the deduplicated [core-provider issue audit](core-provider-issue-audit.md).
5. Verification totals from the exact release commit.
6. Known limitations above, including the distinction between supported MCP host tools, unsupported exact `toolPolicy`, and native-only `disallowedTools`.
7. Install, upgrade, rollback, support, and security-reporting links.
8. Artifact provenance verification command.

## Publication boundary

Release Please may prepare metadata. The publisher must resolve the immutable tag, require successful CI for the exact tagged commit, build from tracked allowlisted files, attest the archive and checksum, and remain idempotent for recovery. Never retag an alpha commit as stable.
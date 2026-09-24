# Security policy

## Supported versions

Security fixes are made on the default branch and included in the next `paseo-agent-team` release. Only the latest published version is supported. Compatibility remains bounded by `paseo-plugin.json`.

## Private reporting

Report suspected vulnerabilities through the [private GitHub Security Advisory form](https://github.com/Mason-x/paseo-agent-team/security/advisories/new). Do not open a public issue for a vulnerability.

Include the plugin version or commit, impact, minimal reproduction, and any proposed mitigation. Remove credentials, private paths, repository names, prompts, and transcript contents.

`paseo-agent-team` is trusted, unsandboxed code. Its client and server entries run with the daemon user's filesystem, process, credential, and network access. A dependency or release-pipeline compromise is therefore in scope.

The maintainer will acknowledge and triage reports on a best-effort basis, coordinate fixes with Paseo maintainers when the defect crosses repositories, and request public disclosure only after a fix or documented mitigation is available.

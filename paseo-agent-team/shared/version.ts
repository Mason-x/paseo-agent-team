import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Stable plugin identity. Aliases are not guessed. */
export const PLUGIN_ID = "paseo-agent-team";
export const PACKAGE_NAME = "@mason-x/paseo-agent-team";
export const RELEASE_TAG_PREFIX = "paseo-agent-team-v";
/** A persisted check may start an update only inside this window. */
export const CHECK_TTL_MS = 5 * 60 * 1000;
export const CHECK_TOTAL_TIMEOUT_MS = 25_000;
export const CHECK_STEP_TIMEOUT_MS = 15_000;
export const RUNTIME_VERIFY_TIMEOUT_MS = 90_000;

export const ShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const IdSchema = z.uuid();
export const TimeSchema = z.iso.datetime();

export const CurrentSchema = z
  .object({
    packageVersion: z.string().nullable(),
    commit: ShaSchema.nullable(),
    branch: z.string().nullable(),
    dirty: z.boolean().nullable(),
    pluginPath: z.string().nullable(),
    repositoryPath: z.string().nullable(),
    observedAt: TimeSchema,
  })
  .strict();

export const RegistrySchema = z
  .object({
    url: z.string(),
    id: z.string(),
  })
  .strict();

export const InstallSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("directory"), path: z.string(), isGit: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal("git"),
      remote: z.string(),
      pluginPath: z.string(),
      installedCommit: ShaSchema.nullable(),
      ref: z.string().nullable(),
      registry: RegistrySchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("npm"),
      packageName: z.string(),
      pluginPath: z.string(),
      installedVersion: z.string().nullable(),
      registry: RegistrySchema.nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
]);

export const RemoteKindSchema = z.enum([
  "release-tag",
  "default-branch",
  "npm-latest",
  "registry-pin",
]);

export const RemoteTargetSchema = z
  .object({
    kind: RemoteKindSchema,
    version: z.string().nullable(),
    commit: ShaSchema.nullable(),
    ref: z.string().nullable(),
    sourceUrl: z.string().nullable(),
  })
  .strict();

export const BlockerCodeSchema = z.enum([
  "home_unavailable",
  "host_identity_mismatch",
  "host_auth_unavailable",
  "unsupported_daemon",
  "installation_identity_unknown",
  "path_invalid",
  "git_missing",
  "npm_missing",
  "cli_missing",
  "not_git",
  "no_remote",
  "unsupported_remote",
  "no_upstream",
  "dirty",
  "local_ahead",
  "diverged",
  "unrelated",
  "detached_head",
  "branch_mismatch",
  "repository_busy",
  "shallow_history",
  "unsupported_checkout",
  "target_changed",
  "check_expired",
  "check_not_actionable",
  "version_invalid",
  "version_mismatch",
  "network_error",
  "rate_limited",
  "worker_unavailable",
  "dependency_backup_failed",
  "concurrent_update",
  "apply_outcome_unknown",
  "rollback_failed",
  "concurrent_local_change",
  "command_failed",
  "runtime_verify_failed",
]);

export const RemedyCodeSchema = z.enum([
  "retry_check",
  "verify_host",
  "install_git",
  "install_npm",
  "install_cli",
  "inspect_local_changes",
  "reconcile_commits",
  "switch_tracking_branch",
  "release_lock",
  "manual_update",
  "inspect_recovery",
]);

export const BlockerSchema = z
  .object({
    code: BlockerCodeSchema,
    detail: z.string().max(2000).nullable(),
    remedy: RemedyCodeSchema,
  })
  .strict();

export const RelationSchema = z.enum([
  "equal",
  "behind",
  "ahead",
  "diverged",
  "unrelated",
  "unknown",
]);

export const PendingCommitsSchema = z
  .object({
    count: z.number().int().nonnegative(),
    subjects: z.array(z.string().max(200)).max(10),
    truncated: z.boolean(),
  })
  .strict();

export const PendingCommitsDiagnosticsSchema = z
  .object({
    staleRefs: z.array(z.string().max(200)).max(10),
  })
  .strict();

export const VersionInfoSchema = z
  .object({
    schemaVersion: z.literal(1),
    current: CurrentSchema,
    installSource: InstallSourceSchema,
    remote: z
      .object({
        state: z.enum(["unchecked", "checking", "ready", "error"]),
        repositoryLatest: RemoteTargetSchema.nullable(),
        installTarget: RemoteTargetSchema.nullable(),
        checkedAt: TimeSchema.nullable(),
        stale: z.boolean(),
        error: BlockerSchema.nullable(),
      })
      .strict(),
    relation: RelationSchema,
    // Older peers may omit this optional display DTO during a plugin update. Normalize to null.
    pendingCommits: PendingCommitsSchema.nullable().default(null),
    pendingCommitsDiagnostics: PendingCommitsDiagnosticsSchema.optional(),
    updateAvailable: z.boolean().nullable(),
    canUpdate: z.boolean(),
    /** False when this install has no usable `@getpaseo/cli` entry. Display and check still work. */
    cliAvailable: z.boolean(),
    checkId: IdSchema.nullable(),
    blockers: z.array(BlockerSchema),
  })
  .strict();

export const PhaseSchema = z.enum([
  "queued",
  "verifying_host",
  "discovering",
  "checking",
  "preflight",
  "fetching",
  "verifying_target",
  "fast_forwarding",
  "installing",
  "applying_managed",
  "reloading",
  "verifying_runtime",
  "rolling_back",
  "reconciling",
  "done",
]);

export const JobStateSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "blocked",
  "failed",
  "rolled_back",
  "recovery_required",
]);

export const JobSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdSchema,
    requestId: IdSchema,
    kind: z.enum(["check", "update"]),
    state: JobStateSchema,
    phase: PhaseSchema,
    seq: z.number().int().nonnegative(),
    startedAt: TimeSchema,
    updatedAt: TimeSchema,
    finishedAt: TimeSchema.nullable(),
    from: CurrentSchema.nullable(),
    target: RemoteTargetSchema.nullable(),
    result: VersionInfoSchema.nullable(),
    error: BlockerSchema.nullable(),
    rollback: z.enum(["not-needed", "pending", "restored", "failed", "unsafe"]),
  })
  .strict();

export const StartResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), job: JobSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      blockers: z.array(BlockerSchema),
      job: JobSchema.nullable(),
    })
    .strict(),
]);

export const VersionGetOutputSchema = z
  .object({
    info: VersionInfoSchema,
    job: JobSchema.nullable(),
  })
  .strict();

export const VersionCheckInputSchema = z.object({ requestId: IdSchema }).strict();

export const VersionUpdateStartInputSchema = z
  .object({
    requestId: IdSchema,
    checkId: IdSchema,
  })
  .strict();

export const VersionUpdateStatusInputSchema = z
  .object({
    jobId: IdSchema.optional(),
  })
  .strict();

export const VersionRuntimeOutputSchema = z
  .object({
    protocol: z.literal(1),
    pluginId: z.literal(PLUGIN_ID),
    bootId: IdSchema,
    packageVersion: z.string().nullable(),
    commit: ShaSchema.nullable(),
  })
  .strict();

export const versionGetRpc = defineRpc({
  name: "agent-team.version.get",
  input: z.object({}).strict(),
  output: VersionGetOutputSchema,
});

export const versionCheckRpc = defineRpc({
  name: "agent-team.version.check",
  input: VersionCheckInputSchema,
  output: StartResultSchema,
});

export const versionUpdateStartRpc = defineRpc({
  name: "agent-team.version.update.start",
  input: VersionUpdateStartInputSchema,
  output: StartResultSchema,
});

export const versionUpdateStatusRpc = defineRpc({
  name: "agent-team.version.update.status",
  input: VersionUpdateStatusInputSchema,
  output: z.object({ job: JobSchema.nullable() }).strict(),
});

export const versionRuntimeRpc = defineRpc({
  name: "agent-team.version.runtime",
  input: z.object({}).strict(),
  output: VersionRuntimeOutputSchema,
});

export type Sha = z.infer<typeof ShaSchema>;
export type Current = z.infer<typeof CurrentSchema>;
export type InstallSource = z.infer<typeof InstallSourceSchema>;
export type RemoteTarget = z.infer<typeof RemoteTargetSchema>;
export type BlockerCode = z.infer<typeof BlockerCodeSchema>;
export type RemedyCode = z.infer<typeof RemedyCodeSchema>;
export type Blocker = z.infer<typeof BlockerSchema>;
export type Relation = z.infer<typeof RelationSchema>;
export type PendingCommits = z.infer<typeof PendingCommitsSchema>;
export type PendingCommitsDiagnostics = z.infer<typeof PendingCommitsDiagnosticsSchema>;
export type VersionInfo = z.infer<typeof VersionInfoSchema>;
export type Phase = z.infer<typeof PhaseSchema>;
export type JobState = z.infer<typeof JobStateSchema>;
export type Job = z.infer<typeof JobSchema>;
export type StartResult = z.infer<typeof StartResultSchema>;

export function blocker(
  code: BlockerCode,
  remedy: RemedyCode,
  detail: string | null = null,
): Blocker {
  return { code, remedy, detail };
}

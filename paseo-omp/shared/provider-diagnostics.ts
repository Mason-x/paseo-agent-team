import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { OmpWorkspaceCwdSchema } from "./hub";

// Health/compatibility facts about the omp CLI itself, surfaced on the global OMP page. This is
// an explicit allowlist, not a passthrough: filesystem locations are sanitized display labels
// (`~/...` or the constant `<custom path>`), never raw absolute override values; every remaining
// field is a classification enum, bounded/normalized number, or boolean derived from a positive
// documented grammar match. Raw stdout/stderr, environment variables, config file text, and
// arbitrary provider diagnostics never cross this boundary.

/** Outcome of the bounded `omp --version` probe. */
export const OmpVersionStatusSchema = z.enum([
  "ok",
  "not-found",
  "unrunnable",
  "timeout",
  "probe-failed",
  "malformed",
]);
export type OmpVersionStatus = z.infer<typeof OmpVersionStatusSchema>;

// Normalized, bounded fields parsed out of one canonical anchored version line
// (`omp/<major>.<minor>.<patch>[-<prerelease>]`) — never the raw stdout string, so no unbounded
// build metadata or unrelated text can ride along.
export const OmpVersionSchema = z.object({
  major: z.number().int().nonnegative(),
  minor: z.number().int().nonnegative(),
  patch: z.number().int().nonnegative(),
  prerelease: z.string().min(1).max(32).nullable(),
});
export type OmpVersion = z.infer<typeof OmpVersionSchema>;

/** Filesystem classification for a diagnostic root/file: distinguishes every failure mode. */
export const PathStateSchema = z.enum([
  "available",
  "missing",
  "unreadable",
  "invalid",
  "wrong-type",
]);
export type PathState = z.infer<typeof PathStateSchema>;

// Mirrors OmpMemorySectionSchema.backend in shared/omp-config.ts. Duplicated as a literal rather
// than imported so this module's wire contract does not shift silently if that schema changes.
const MemoryBackendSchema = z.enum(["off", "local", "hindsight", "mnemopi", "sharpshooter"]);

export const OmpProcessDiagnosticsSchema = z.object({
  /** "partial" means a project daemon directory or candidate metadata file could not be
   * inspected; the count reflects only entries whose metadata was confirmed. */
  status: z.enum(["ok", "partial", "unavailable", "unknown"]),
  /** Count of daemon-supervised process entries tracked under the hub run root; null
   * unless "ok" or "partial". */
  trackedCount: z.number().int().nonnegative().nullable(),
});
export type OmpProcessDiagnostics = z.infer<typeof OmpProcessDiagnosticsSchema>;

// Reports safe facts from omp's own mcp.json manifest: bounded server count and parse/access
// status only. Server names, credentials, headers, env, URLs, and commands never cross the RPC.
export const OmpMcpDiagnosticsSchema = z.object({
  status: z.enum(["configured", "unavailable", "unreadable", "invalid", "wrong-type"]),
  serverCount: z.number().int().nonnegative().nullable(),
  /** Null only when "configured"; otherwise a specific, path-backed explanation. */
  reason: z.string().nullable(),
});
export type OmpMcpDiagnostics = z.infer<typeof OmpMcpDiagnosticsSchema>;

export const OmpLspDiagnosticsSchema = z.object({
  status: z.enum(["supported", "not-advertised", "unknown"]),
});
export type OmpLspDiagnostics = z.infer<typeof OmpLspDiagnosticsSchema>;

export const OmpProviderHealthSchema = z.object({
  binary: z.object({
    /** Whether an executable file was found (env override or PATH), independent of a working
     * `--version`. */
    installed: z.boolean(),
    /** Sanitized display label (`~/...` or `<custom path>`), never a raw absolute path. */
    resolvedPath: z.string().nullable(),
    version: OmpVersionSchema.nullable(),
    versionStatus: OmpVersionStatusSchema,
    /** True when process-tree termination/verification failed or the leader did not close by the
     * bounded final deadline. */
    processCleanupFailed: z.boolean(),
  }),
  rpcUi: z.object({
    /** False when the binary was unavailable, so the probe was never attempted. */
    checked: z.boolean(),
    /** Null when the help probe failed, was empty, or was truncated — never a guessed false. */
    supported: z.boolean().nullable(),
  }),
  lsp: OmpLspDiagnosticsSchema,
  mcp: OmpMcpDiagnosticsSchema,
  process: OmpProcessDiagnosticsSchema,
  roots: z.object({
    agentRoot: z.string(),
    agentRootState: PathStateSchema,
    configPath: z.string(),
    configState: PathStateSchema,
    sessionRoot: z.string(),
    sessionRootState: PathStateSchema,
  }),
  databases: z.object({
    agentDbState: PathStateSchema,
    historyDbState: PathStateSchema,
  }),
  /** Null both when the config is unavailable and when it is available but unset — callers must
   * check `roots.configState` to tell those apart. */
  memoryBackend: MemoryBackendSchema.nullable(),
  checkedAt: z.string(),
});
export type OmpProviderHealth = z.infer<typeof OmpProviderHealthSchema>;

export const getOmpProviderHealth = defineRpc({
  name: "paseo-omp.get-provider-health",
  input: z.object({ force: z.boolean().optional(), cwd: OmpWorkspaceCwdSchema.optional() }),
  output: OmpProviderHealthSchema,
});

import { z } from "zod";
import { StoredEconomyPolicySchema, StoredQuotaRecoverySchema } from "./team-mode";

export const MAX_SEEN_PRESET_ROLE_IDS = 1000;

// Persisted. Never strict and never rejects an over-long history: the settings store parses the
// whole preferences document, so one bad field would disable maxMembers and recentRuns too.
// Non-string entries are dropped individually, deduplication keeps the first occurrence, and the
// cap keeps the most recent ids.
export const DefaultPresetsPreferencesSchema = z.object({
  catalogRevision: z.string(),
  seenRoleIds: z
    .array(z.unknown())
    .transform((ids) =>
      [...new Set(ids.filter((id): id is string => typeof id === "string"))].slice(
        -MAX_SEEN_PRESET_ROLE_IDS,
      ),
    ),
  lastSyncedAt: z.string().optional(),
});

export const RunSummarySchema = z.object({
  runId: z.string(),
  teamId: z.string(),
  teamName: z.string(),
  workspaceId: z.string(),
  coordinatorAgentId: z.string(),
  memberAgentIds: z.array(z.string()),
  taskExcerpt: z.string().max(120),
  createdAt: z.string(),
});

export const PreferencesSchema = z
  .object({
    // Storage has no upper bound: existing Teams may exceed what this version runs, and the
    // settings screen must still open them. The host economy policy owns the runtime cap.
    maxMembers: z.number().int().min(1).default(24),
    archiveOnLaunchFailure: z.boolean().default(true),
    recentRuns: z.array(RunSummarySchema).max(20).default([]),
    templatesImportedAt: z.string().optional(),
    // Host-level economy pool. User data: the block stays exactly as written, including entries
    // this version cannot interpret, so no later preferences write deletes it. normalizeEconomyPolicy
    // reports per-entry problems before a launch.
    economy: StoredEconomyPolicySchema.optional(),
    quotaRecovery: StoredQuotaRecoverySchema.optional(),
    // A damaged block drops only preset history; launch preferences remain usable.
    defaultPresets: DefaultPresetsPreferencesSchema.optional().catch(undefined),
  })
  .passthrough();

export type RunSummary = z.infer<typeof RunSummarySchema>;
export type Preferences = z.infer<typeof PreferencesSchema>;

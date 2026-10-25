import { z } from "zod";

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

export const PreferencesSchema = z.object({
  maxMembers: z.number().int().min(1).max(16).default(8),
  archiveOnLaunchFailure: z.boolean().default(true),
  recentRuns: z.array(RunSummarySchema).max(20).default([]),
  templatesImportedAt: z.string().optional(),
  // A damaged block drops only preset history; launch preferences remain usable.
  defaultPresets: DefaultPresetsPreferencesSchema.optional().catch(undefined),
});

export type RunSummary = z.infer<typeof RunSummarySchema>;
export type Preferences = z.infer<typeof PreferencesSchema>;

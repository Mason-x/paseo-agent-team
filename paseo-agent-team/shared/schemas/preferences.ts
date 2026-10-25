import { z } from "zod";
import { SlugSchema } from "./common";

export const MAX_SEEN_PRESET_ROLE_IDS = 1000;

export const DefaultPresetsPreferencesSchema = z.strictObject({
  catalogRevision: z.string().min(1).max(100),
  seenRoleIds: z
    .array(SlugSchema)
    .max(10000)
    .transform((ids) => [...new Set(ids)])
    .pipe(z.array(SlugSchema).max(MAX_SEEN_PRESET_ROLE_IDS)),
  lastSyncedAt: z.string().max(100).optional(),
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
  defaultPresets: DefaultPresetsPreferencesSchema.optional(),
});

export type RunSummary = z.infer<typeof RunSummarySchema>;
export type Preferences = z.infer<typeof PreferencesSchema>;

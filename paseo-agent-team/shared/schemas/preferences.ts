import { z } from "zod";

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
});

export type RunSummary = z.infer<typeof RunSummarySchema>;
export type Preferences = z.infer<typeof PreferencesSchema>;

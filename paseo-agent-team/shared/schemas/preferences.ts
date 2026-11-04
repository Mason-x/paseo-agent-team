import { z } from "zod";
import { ProfileRefSchema } from "./profile-ref";
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

// A stored reference may carry newer metadata. Keep it through a settings round-trip without
// tightening the public ProfileRefSchema used by Role bindings.
const StoredDesignerProfileSchema = ProfileRefSchema.passthrough();

export const PreferencesSchema = z
  .object({
    // Storage has no upper bound: existing Teams may exceed what this version runs, and the
    // settings screen must still open them. Seat planning owns the runtime cap.
    maxMembers: z.number().int().min(1).default(24),
    archiveOnLaunchFailure: z.boolean().default(true),
    recentRuns: z.array(RunSummarySchema).max(20).default([]),
    templatesImportedAt: z.string().optional(),
    // RETIRED host-level economy pool. It still decodes, exactly as written, and planning never
    // reads it. It is deleted when the preferences are next saved by a version that retires it
    // (shared/domain/retired-fields.ts); an earlier version keeps reading it.
    economy: StoredEconomyPolicySchema.optional(),
    // NOT retired: how a quota-exhausted seat is recovered; no tie to the retired modes.
    quotaRecovery: StoredQuotaRecoverySchema.optional(),
    // The designer's remembered Profile. Explicit start options override it; a malformed block
    // only clears the preference instead of invalidating the whole settings document.
    designerProfile: StoredDesignerProfileSchema.optional().catch(undefined),
    // A damaged block drops only preset history; launch preferences remain usable.
    defaultPresets: DefaultPresetsPreferencesSchema.optional().catch(undefined),
  })
  .passthrough();

export type RunSummary = z.infer<typeof RunSummarySchema>;
export type Preferences = z.infer<typeof PreferencesSchema>;

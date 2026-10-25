import { z } from "zod";
import { SlugSchema } from "./common";
import { ProfileHintSchema } from "./profile-ref";
import { RoleSchema } from "./role";

export { type ProfileHint, ProfileHintSchema } from "./profile-ref";

export const DEFAULT_CATALOG_ID = "agent-team-default";

export const DefaultRoleTemplateSchema = RoleSchema.omit({
  preferredProfiles: true,
  fallbackProfiles: true,
  createdAt: true,
  updatedAt: true,
  source: true,
  preset: true,
})
  .extend({
    preferredHints: z.array(ProfileHintSchema).min(1).max(5),
    fallbackHints: z.array(ProfileHintSchema).max(5).default([]),
  })
  .strict();

export const BindingReportEntrySchema = z.strictObject({
  roleId: SlugSchema,
  list: z.enum(["preferred", "fallback"]),
  index: z.number().int().min(0).max(4),
  hint: ProfileHintSchema,
  method: z.enum(["exact", "normalized-name", "runtime", "unbound"]),
  reason: z.enum(["missing", "ambiguous", "config-changed"]).nullable(),
  profileId: z.string().optional(),
  candidateNames: z.array(z.string().max(200)).max(100),
  deduplicated: z.boolean(),
});

export const PresetRolePreviewSchema = z.strictObject({
  id: SlugSchema,
  kind: z.enum(["missing", "changed", "deleted", "same", "id-collision"]),
  candidate: RoleSchema,
  before: RoleSchema.optional(),
  changedFields: z.array(z.string().max(200)).max(1000),
  templateChanged: z.boolean(),
  locallyChanged: z.boolean(),
  defaultAction: z.enum(["add", "keep", "skip"]),
});

export const CatalogBlockerSchema = z.strictObject({
  code: z.enum(["profiles-unavailable", "settings-invalid", "settings-unavailable"]),
  document: z.enum(["roles", "preferences"]).optional(),
  message: z.string().max(2000),
});

export const DefaultCatalogPreviewInputSchema = z.strictObject({
  allowUnboundOnProfileError: z.boolean().default(false),
});

export const DefaultCatalogPreviewResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    catalogRevision: z.string().min(1).max(100),
    generatedAt: z.string().max(100),
    revisions: z.strictObject({ roles: z.string(), preferences: z.string() }),
    roles: z.array(PresetRolePreviewSchema).max(1000),
    bindingReport: z.array(BindingReportEntrySchema).max(10000),
    warnings: z.array(z.string().max(2000)).max(100),
  }),
  z.strictObject({
    ok: z.literal(false),
    blockers: z.array(CatalogBlockerSchema).min(1).max(10),
  }),
]);

export type DefaultRoleTemplate = z.infer<typeof DefaultRoleTemplateSchema>;
export type BindingReportEntry = z.infer<typeof BindingReportEntrySchema>;
export type BindingReport = BindingReportEntry[];
export type PresetRolePreview = z.infer<typeof PresetRolePreviewSchema>;
export type CatalogBlocker = z.infer<typeof CatalogBlockerSchema>;
export type DefaultCatalogPreviewInput = z.infer<typeof DefaultCatalogPreviewInputSchema>;
export type DefaultCatalogPreviewResult = z.infer<typeof DefaultCatalogPreviewResultSchema>;

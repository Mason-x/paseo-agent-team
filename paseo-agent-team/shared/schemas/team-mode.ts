import { z } from "zod";

// Strict enums for commands, RPC input, and runtime normalization. A stored document never uses
// these directly: settings parses whole documents, so one unrecognized value would invalidate the
// entire Roles, Teams, or Preferences catalog. The Stored* shapes below accept future values and
// preserve unknown keys; planning reports the specific unsupported field instead.
export const TeamModeSchema = z.enum(["sota", "economy", "collaborative"]);
export const RoleTierSchema = z.enum(["decision", "execution", "escalation", "retain"]);
export const TaskKindSchema = z.enum([
  "coding",
  "testing",
  "acceptance",
  "codebase",
  "ops",
  "general",
]);

// Stored inside Roles. Fields are z.unknown() rather than enums: a newer tier/task kind, or a
// value a newer writer stored with the wrong type, must survive parsing so resolveRoleExecution
// can report the exact field. A block-level `.catch` would silently downgrade it to the id table.
export const StoredRoleExecutionPolicySchema = z
  .object({
    tier: z.unknown().optional(),
    taskKind: z.unknown().optional(),
  })
  .passthrough();

// Stored inside Teams. The whole block is preserved for the same reason; collaboration planning
// validates replicas/judge/escalation and reports invalid values instead of dropping them.
export const StoredCollaborationSchema = z
  .object({
    replicas: z.unknown().optional(),
    judgeRoleId: z.unknown().optional(),
    escalationRoleId: z.unknown().optional(),
  })
  .passthrough();

// Writer/form shape for one economy pool entry. Storage accepts raw entries per item instead:
// normalizeEconomyPolicy validates each entry and reports its index, so one bad record can never
// make the whole pool disappear on the next preferences write.
export const StoredEconomyEntrySchema = z
  .object({
    profileId: z.string(),
    nameSnapshot: z.string().optional(),
    family: z.string().optional(),
    enabled: z.boolean().optional(),
    boundModel: z
      .object({ provider: z.string(), model: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

// Stored in host Preferences. Containers keep their JSON shape but their entries stay unknown;
// normalizeEconomyPolicy owns per-entry validation and reporting.
export const StoredEconomyPolicySchema = z
  .object({
    pool: z.array(z.unknown()).optional(),
    taskOrder: z.record(z.string(), z.unknown()).optional(),
    profileBudget: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

// Stored in host Preferences. The first release only writes notify/manual; the open mode value
// leaves room for an automatic recovery without a settings migration.
export const StoredQuotaRecoverySchema = z
  .object({
    mode: z.unknown().optional(),
  })
  .passthrough();

export type TeamMode = z.infer<typeof TeamModeSchema>;
export type RoleTier = z.infer<typeof RoleTierSchema>;
export type TaskKind = z.infer<typeof TaskKindSchema>;
export type StoredRoleExecutionPolicy = z.infer<typeof StoredRoleExecutionPolicySchema>;
export type StoredCollaboration = z.infer<typeof StoredCollaborationSchema>;
export type StoredEconomyEntry = z.infer<typeof StoredEconomyEntrySchema>;
export type StoredEconomyPolicy = z.infer<typeof StoredEconomyPolicySchema>;
export type StoredQuotaRecovery = z.infer<typeof StoredQuotaRecoverySchema>;

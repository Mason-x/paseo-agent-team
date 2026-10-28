import { z } from "zod";

// Strict enums for commands, RPC input, and runtime normalization. A stored document never uses
// these directly: settings parses whole documents, so one unrecognized value would invalidate the
// entire Roles, Teams, or Preferences catalog. The Stored* shapes below accept future values and
// preserve unknown keys; planning reports the specific unsupported field instead.
// Mode values are stable (shared/domain/mode-contract.ts): `economy` keeps its original meaning,
// shown as 标准; `economy-all` is the all-seats cheap mode, shown as 经济. No value is ever renamed.
export const TeamModeSchema = z.enum(["sota", "economy", "economy-all", "collaborative"]);
// Where a seat's budget label came from. `route` is an economy-all seat chosen from a verified
// cheap route: it is neither the Role's host label nor the standard economy pool.
export const BudgetBasisSchema = z.enum(["host", "pool", "route", "conservative-default"]);
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

// Routes of the economy-all policy. The coordinator has its own route even though it plans as a
// decision seat; qa-review/qa-security stay in decision (no separate review route).
export const AllSeatsRouteSchema = z.enum([
  "coordinator",
  "decision",
  "execution",
  "escalation",
  "retain",
]);

export const ALL_SEATS_POLICY_VERSION = 1;
// Writer/form limits for the allowlist and for each route or task order. Reading a larger saved
// policy reports it; storage never truncates it.
export const ALL_SEATS_WRITER_LIMIT = 32;

// Writer/form shape for one allowlisted Profile. costClass is always "low", and family/boundModel
// record the live provider/model tuple the family was verified against; planning re-verifies the
// tuple and the family on every run, so a renamed or re-pointed Profile drops out.
export const StoredAllSeatsEntrySchema = z
  .object({
    profileId: z.string().min(1),
    nameSnapshot: z.string().optional(),
    enabled: z.boolean(),
    costClass: z.literal("low"),
    family: z.string().min(1),
    boundModel: z.object({ provider: z.string().min(1), model: z.string().min(1) }).passthrough(),
  })
  .passthrough();

// Reader shape for preferences.economy.allSeats (safeParse it; the stored block itself is unknown).
// Every field stays unknown so a newer writer or a future version is read, reported, and kept as
// written: an unknown version is never reset or emptied.
export const StoredAllSeatsPolicySchema = z
  .object({
    version: z.unknown().optional(),
    profiles: z.unknown().optional(),
    routes: z.unknown().optional(),
    executionTaskOrder: z.unknown().optional(),
  })
  .passthrough();

// Stored in host Preferences. Containers keep their JSON shape but their entries stay unknown;
// normalizeEconomyPolicy owns per-entry validation and reporting. allSeats is read only by the
// economy-all mode, so even its container stays unknown: a wrong shape blocks that mode alone and
// can neither invalidate the Preferences document (maxMembers, recentRuns) nor be dropped by a write.
export const StoredEconomyPolicySchema = z
  .object({
    pool: z.array(z.unknown()).optional(),
    taskOrder: z.record(z.string(), z.unknown()).optional(),
    profileBudget: z.record(z.string(), z.unknown()).optional(),
    allSeats: z.unknown().optional(),
  })
  .passthrough();

// Stored in host Preferences. The first release only writes notify/manual; the open mode value
// leaves room for an automatic recovery without a settings migration.
export const StoredQuotaRecoverySchema = z
  .object({
    mode: z.unknown().optional(),
  })
  .passthrough();

export type BudgetBasis = z.infer<typeof BudgetBasisSchema>;
export type TeamMode = z.infer<typeof TeamModeSchema>;
export type RoleTier = z.infer<typeof RoleTierSchema>;
export type TaskKind = z.infer<typeof TaskKindSchema>;
export type StoredRoleExecutionPolicy = z.infer<typeof StoredRoleExecutionPolicySchema>;
export type StoredCollaboration = z.infer<typeof StoredCollaborationSchema>;
export type StoredEconomyEntry = z.infer<typeof StoredEconomyEntrySchema>;
export type AllSeatsRoute = z.infer<typeof AllSeatsRouteSchema>;
export type StoredAllSeatsEntry = z.infer<typeof StoredAllSeatsEntrySchema>;
export type StoredAllSeatsPolicy = z.infer<typeof StoredAllSeatsPolicySchema>;
export type StoredEconomyPolicy = z.infer<typeof StoredEconomyPolicySchema>;
export type StoredQuotaRecovery = z.infer<typeof StoredQuotaRecoverySchema>;

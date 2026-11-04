import { z } from "zod";

// RETIRED (.notes/274): the team mode, collaboration block, economy pool, all-seats policy and Role
// tier/task kind no longer take part in planning. Every Stored* shape below exists only to DECODE
// what an earlier version wrote: settings parses whole documents, so a field that stopped decoding
// would invalidate the entire Roles, Teams, or Preferences catalog. This version never writes them;
// shared/domain/retired-fields.ts removes the retired keys when the owning object is next saved.
//
// `RoleTierSchema` and `TaskKindSchema` stay because the Run Engine ledger imports them.
export const TeamModeSchema = z.enum(["sota", "economy", "economy-all", "collaborative"]);

// Display names of the retired stored values, only for the one-line "this Team used to be X" hint
// shown while the old value is still stored. Planning ignores the value entirely.
export const RETIRED_MODE_LABEL = {
  sota: "旗舰",
  economy: "标准",
  "economy-all": "经济",
  collaborative: "协作",
} as const satisfies Record<z.infer<typeof TeamModeSchema>, string>;

// Budget label of a seat in the preview / team.plan DTO. The DTO keeps its shape; this version
// always reports "host" (see shared/domain/mode-resolver.ts).
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

// Stored inside Roles. Fields stay z.unknown() so an old or damaged value still decodes.
export const StoredRoleExecutionPolicySchema = z
  .object({
    tier: z.unknown().optional(),
    taskKind: z.unknown().optional(),
  })
  .passthrough();

// Stored inside Teams. The whole block is preserved as written until the Team is next saved.
export const StoredCollaborationSchema = z
  .object({
    replicas: z.unknown().optional(),
    judgeRoleId: z.unknown().optional(),
    escalationRoleId: z.unknown().optional(),
  })
  .passthrough();

// Stored in host Preferences. Containers keep their JSON shape but their entries stay unknown, so
// a wrong shape can neither invalidate the Preferences document (maxMembers, recentRuns) nor be
// rewritten by a read. allSeats is a block of its own and stays unknown for the same reason.
export const StoredEconomyPolicySchema = z
  .object({
    pool: z.array(z.unknown()).optional(),
    taskOrder: z.record(z.string(), z.unknown()).optional(),
    profileBudget: z.record(z.string(), z.unknown()).optional(),
    allSeats: z.unknown().optional(),
  })
  .passthrough();

// Stored in host Preferences. NOT retired: it records how a quota-exhausted seat is recovered
// (notify/manual today, an open value for an automatic recovery later) and has no tie to the
// retired modes. The first release only writes notify/manual.
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
export type StoredEconomyPolicy = z.infer<typeof StoredEconomyPolicySchema>;
export type StoredQuotaRecovery = z.infer<typeof StoredQuotaRecoverySchema>;

import { z } from "zod";
import { BudgetBasisSchema, TeamModeSchema } from "./team-mode";

export const ModeIssueSchema = z.strictObject({
  code: z.string().min(1).max(64),
  severity: z.enum(["warning", "blocker"]),
  roleId: z.string().optional(),
  seatId: z.string().optional(),
  profileId: z.string().optional(),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

export const SeatProfileSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  provider: z.string().min(1),
  model: z.string().optional(),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
});

export const SeatPreviewSchema = z.strictObject({
  seatId: z.string().min(1),
  logicalSeatId: z.string().min(1),
  roleId: z.string().min(1),
  roleName: z.string(),
  instanceLabel: z.string().optional(),
  purpose: z.enum(["member", "candidate", "judge", "escalation"]),
  activation: z.enum(["eager", "on-demand", "escalation-only"]),
  cohortId: z.string().optional(),
  profile: SeatProfileSchema.nullable(),
  source: z.enum(["role-preferred", "role-fallback", "economy-pool", "unavailable"]),
  route: z.string().min(1).max(32).optional(),
  family: z.string().optional(),
  alternates: z.array(z.string()),
  budget: z.enum(["economy", "sota", "unknown"]),
  budgetBasis: BudgetBasisSchema,
  standby: z.boolean(),
  unavailable: z.boolean(),
  issues: z.array(ModeIssueSchema),
});

export const CoordinatorPreviewSchema = z.strictObject({
  roleId: z.string().min(1),
  roleName: z.string(),
  profile: SeatProfileSchema.nullable(),
  source: z.enum(["role-preferred", "role-fallback", "economy-pool", "unavailable"]),
  route: z.string().min(1).max(32).optional(),
  budget: z.enum(["economy", "sota", "unknown"]).optional(),
  budgetBasis: BudgetBasisSchema.optional(),
  issues: z.array(ModeIssueSchema),
});

export const SeatCountsSchema = z.strictObject({
  logical: z.number().int().min(0),
  physical: z.number().int().min(0),
  eager: z.number().int().min(0),
  deferred: z.number().int().min(0),
  escalation: z.number().int().min(0),
  sotaPotential: z.number().int().min(0),
});

export const SeatBudgetSchema = z.strictObject({
  economy: z.number().int().min(0),
  sota: z.number().int().min(0),
  unknown: z.number().int().min(0),
  deferredSota: z.number().int().min(0),
});

export const ModeLaunchPreviewSchema = z.strictObject({
  /** Absent when the stored Team.mode is unreadable; `rawMode` then carries the original value. */
  requestedMode: TeamModeSchema.optional(),
  rawMode: z.string().optional(),
  coordinator: CoordinatorPreviewSchema,
  seats: z.array(SeatPreviewSchema),
  counts: SeatCountsSchema,
  budget: SeatBudgetSchema,
  issues: z.array(ModeIssueSchema),
  warnings: z.array(z.string()),
  planHash: z.string().min(1).max(128),
});

export const LaunchPreviewResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), preview: ModeLaunchPreviewSchema }),
  z.strictObject({
    ok: z.literal(false),
    blockers: z.array(z.string().min(1)).min(1),
    warnings: z.array(z.string()),
    issues: z.array(ModeIssueSchema),
  }),
]);

export type ModeIssueDto = z.infer<typeof ModeIssueSchema>;
export type SeatProfileDto = z.infer<typeof SeatProfileSchema>;
export type SeatPreview = z.infer<typeof SeatPreviewSchema>;
export type CoordinatorPreview = z.infer<typeof CoordinatorPreviewSchema>;
export type SeatCounts = z.infer<typeof SeatCountsSchema>;
export type SeatBudget = z.infer<typeof SeatBudgetSchema>;
export type ModeLaunchPreview = z.infer<typeof ModeLaunchPreviewSchema>;
export type LaunchPreviewResult = z.infer<typeof LaunchPreviewResultSchema>;

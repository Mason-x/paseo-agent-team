import { z } from "zod";
import {
  RUN_HARD_BYTES,
  RUN_MAX_TASKS,
  RUN_SOFT_BYTES,
  RunBudgetEntrySchema,
  RunIdRefSchema,
  RunPolicySnapshotSchema,
  RunSeatSnapshotSchema,
  RunTierSchema,
} from "./ledger";

/**
 * Team-level Run Engine configuration (H-R1=A): `Team.runEngine`, absent = disabled.
 *
 * Stored inside the Team document, so it is tolerant like every stored block: unknown fields are
 * preserved and a malformed `runEngine` block only disables that Team (never the whole Teams
 * settings, never a silent fallback to a looser default). `policyVersion` is mandatory: an
 * unrecognized policy is refused, not interpreted as "defaults".
 *
 * Capacity: hard limits are ledger constants (AC-RE1.12). Configuration may only lower the soft
 * reporting threshold; it can never raise a hard limit above the constant.
 */

export const RUN_ENGINE_CONFIG_VERSION = 1;

export const RunSeatConfigSchema = z
  .object({
    seatId: RunIdRefSchema,
    agentId: RunIdRefSchema.optional(),
    tier: RunTierSchema,
    duties: z.array(z.string().min(1).max(64)).max(16),
    channelId: z.string().min(1).max(128),
    enabled: z.boolean(),
  })
  .passthrough();
export type RunSeatConfig = z.infer<typeof RunSeatConfigSchema>;

/** Writer shape for the policy block; the ledger stores the same fields tolerantly. */
export const RunPolicyConfigSchema = RunPolicySnapshotSchema;

export const RunTeamEngineConfigSchema = z
  .object({
    version: z.literal(RUN_ENGINE_CONFIG_VERSION),
    enabled: z.boolean(),
    seats: z.array(RunSeatConfigSchema).min(1).max(RUN_MAX_TASKS),
    policy: RunPolicyConfigSchema,
  })
  .passthrough();
export type RunTeamEngineConfig = z.infer<typeof RunTeamEngineConfigSchema>;

/** Normalized roster frozen into the Run (same fields as the ledger snapshot). */
export const RunRosterConfigSchema = z.array(RunSeatSnapshotSchema).max(64);

/** Budget entry shape reused by policy budgets; exported for team-editor validation. */
export const RunPolicyBudgetSchema = RunBudgetEntrySchema;

/**
 * Capacity contract: the soft threshold is configurable but clamped to the hard ledger constant.
 * Exported so a Team editor can validate before writing rather than after.
 */
export const RUN_CAPACITY = {
  maxTasks: RUN_MAX_TASKS,
  softBytes: RUN_SOFT_BYTES,
  hardBytes: RUN_HARD_BYTES,
} as const;

export const RunCapacityPolicySchema = z
  .object({
    softBytes: z.number().int().min(1).max(RUN_SOFT_BYTES).optional(),
  })
  .passthrough();

/**
 * `reference` deliberately uses a plain string: a team may reference an existing DEV target by
 * its normalized identity. Recognizing/normalizing loopback aliases is a runtime gate (R08),
 * not something this schema can prove.
 */
export const RunDevTargetReferenceSchema = z
  .object({
    serverId: z.string().min(1).max(128),
    host: z.string().min(1).max(256),
    home: z.string().min(1).max(512),
  })
  .passthrough();

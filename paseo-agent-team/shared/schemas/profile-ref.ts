import { z } from "zod";

// Defined beside ProfileRef to avoid a Role -> template -> Role schema import cycle.
// default-catalog.ts re-exports the public hint contract.
// Persisted inside Roles: unknown keys are preserved so a newer writer's metadata survives a
// round-trip through this version. Generator inputs use a strict variant instead.
export const ProfileHintSchema = z
  .object({
    name: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().optional(),
    modeId: z.string().optional(),
    thinkingOptionId: z.string().optional(),
  })
  .passthrough();

export type ProfileHint = z.infer<typeof ProfileHintSchema>;

export const ProfileRefSchema = z
  .object({
    profileId: z.string().min(1),
    nameSnapshot: z.string().optional(),
    // A damaged hint drops only the hint; the reference and its Role stay usable.
    hint: ProfileHintSchema.optional().catch(undefined),
  })
  .passthrough();

export type ProfileRef = z.infer<typeof ProfileRefSchema>;

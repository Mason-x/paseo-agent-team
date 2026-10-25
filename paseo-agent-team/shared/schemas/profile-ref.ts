import { z } from "zod";

// Defined beside ProfileRef to avoid a Role -> template -> Role schema import cycle.
// default-catalog.ts re-exports the public hint contract.
// Persisted inside Roles, so unknown keys are stripped instead of rejected: a newer writer must
// never invalidate the whole Roles document, and no length limit can reject a stored hint.
export const ProfileHintSchema = z.object({
  name: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().optional(),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
});

export type ProfileHint = z.infer<typeof ProfileHintSchema>;

export const ProfileRefSchema = z.object({
  profileId: z.string().min(1),
  nameSnapshot: z.string().optional(),
  // A damaged hint drops only the hint; the reference and its Role stay usable.
  hint: ProfileHintSchema.optional().catch(undefined),
});

export type ProfileRef = z.infer<typeof ProfileRefSchema>;

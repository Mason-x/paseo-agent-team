import { z } from "zod";

// Defined beside ProfileRef to avoid a Role -> template -> Role schema import cycle.
// default-catalog.ts re-exports the public hint contract.
export const ProfileHintSchema = z.strictObject({
  name: z.string().min(1).max(200),
  provider: z.string().min(1).max(100),
  model: z.string().max(200).optional(),
  modeId: z.string().max(100).optional(),
  thinkingOptionId: z.string().max(100).optional(),
});

export type ProfileHint = z.infer<typeof ProfileHintSchema>;

export const ProfileRefSchema = z.object({
  profileId: z.string().min(1),
  nameSnapshot: z.string().optional(),
  hint: ProfileHintSchema.optional(),
});

export type ProfileRef = z.infer<typeof ProfileRefSchema>;

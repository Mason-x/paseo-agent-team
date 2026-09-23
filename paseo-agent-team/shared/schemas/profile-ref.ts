import { z } from "zod";

export const ProfileRefSchema = z.object({
  profileId: z.string().min(1),
  nameSnapshot: z.string().optional(),
});

export type ProfileRef = z.infer<typeof ProfileRefSchema>;

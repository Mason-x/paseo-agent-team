import { z } from "zod";
import { DescriptionSchema, ShortTextSchema, SlugSchema } from "./common";

export const TeamMemberSchema = z.object({
  roleId: SlugSchema,
  instanceLabel: ShortTextSchema.optional(),
  enabled: z.boolean().default(true),
});

export const TeamSchema = z
  .object({
    id: SlugSchema,
    name: ShortTextSchema,
    description: DescriptionSchema.optional(),
    coordinatorRoleId: SlugSchema,
    members: z.array(TeamMemberSchema).min(1).max(16),
    operatingRules: z.string().trim().max(4000).optional(),
    enabled: z.boolean().default(true),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough()
  .refine((team) => !team.members.some((member) => member.roleId === team.coordinatorRoleId), {
    message: "协调者不能同时作为成员",
  })
  .refine(
    (team) => {
      const seen = new Map<string, number>();
      for (const member of team.members) {
        seen.set(member.roleId, (seen.get(member.roleId) ?? 0) + 1);
      }
      return team.members.every(
        (member) => (seen.get(member.roleId) ?? 0) === 1 || member.instanceLabel,
      );
    },
    { message: "重复的 Role 需要实例标签" },
  );

export type TeamMember = z.infer<typeof TeamMemberSchema>;
export type Team = z.infer<typeof TeamSchema>;

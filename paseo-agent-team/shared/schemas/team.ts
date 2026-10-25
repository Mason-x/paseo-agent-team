import { z } from "zod";
import { DescriptionSchema, ShortTextSchema, SlugSchema } from "./common";
import { StoredCollaborationSchema } from "./team-mode";

// Persisted inside Teams. passthrough keeps fields a newer writer added (mode/seat metadata,
// designer annotations) alive through a round-trip in this version.
export const TeamMemberSchema = z
  .object({
    roleId: SlugSchema,
    instanceLabel: ShortTextSchema.optional(),
    // Generated for new and duplicated seats. Legacy members may omit it; planning derives a
    // run-local stable key instead of rewriting the Team.
    seatId: z.string().optional(),
    enabled: z.boolean().default(true),
  })
  .passthrough();

export const TeamSchema = z
  .object({
    id: SlugSchema,
    name: ShortTextSchema,
    description: DescriptionSchema.optional(),
    // Mode selection stays a plain string on storage; normalizeMode rejects what this version
    // cannot run. SEAT LIMIT: physical seats are bounded by preferences at launch, not by the
    // stored array, so large historical Teams stay readable and editable.
    memberCreation: z.string().optional(),
    mode: z.string().optional(),
    collaboration: StoredCollaborationSchema.optional(),
    coordinatorRoleId: SlugSchema,
    members: z.array(TeamMemberSchema).min(1),
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

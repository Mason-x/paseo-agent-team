import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { uniqueIds } from "./schemas/common";
import { PreferencesSchema } from "./schemas/preferences";
import { RoleSchema } from "./schemas/role";
import { TeamSchema } from "./schemas/team";

export const RolesDocumentSchema = z
  .object({
    roles: z.array(RoleSchema).default([]),
  })
  .refine(uniqueIds("roles"), { message: "Duplicate role id" });

export const TeamsDocumentSchema = z
  .object({
    teams: z.array(TeamSchema).default([]),
  })
  .refine(uniqueIds("teams"), { message: "Duplicate team id" });

export const rolesSettings = defineSettings({
  id: "agent-team-roles",
  scope: "host",
  version: 1,
  schema: RolesDocumentSchema,
});

export const teamsSettings = defineSettings({
  id: "agent-team-teams",
  scope: "host",
  version: 1,
  schema: TeamsDocumentSchema,
});

export const preferencesSettings = defineSettings({
  id: "agent-team-preferences",
  scope: "host",
  version: 1,
  schema: PreferencesSchema,
});

export type RolesDocument = z.infer<typeof RolesDocumentSchema>;
export type TeamsDocument = z.infer<typeof TeamsDocumentSchema>;

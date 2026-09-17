import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_COMPOSER_PILL_SETTINGS = {
  mcp: true,
  hub: true,
  memory: true,
  sessions: true,
  quota: true,
} as const;

export const composerPillSettingsSchema = z.object({
  mcp: z.boolean().default(DEFAULT_COMPOSER_PILL_SETTINGS.mcp),
  hub: z.boolean().default(DEFAULT_COMPOSER_PILL_SETTINGS.hub),
  memory: z.boolean().default(DEFAULT_COMPOSER_PILL_SETTINGS.memory),
  sessions: z.boolean().default(DEFAULT_COMPOSER_PILL_SETTINGS.sessions),
  quota: z.boolean().default(DEFAULT_COMPOSER_PILL_SETTINGS.quota),
});

export type ComposerPillSettings = z.infer<typeof composerPillSettingsSchema>;
export type ComposerPillKey = keyof ComposerPillSettings;

export const composerPillSettings = defineSettings({
  id: "composer-pills",
  scope: "host",
  version: 1,
  schema: composerPillSettingsSchema,
});

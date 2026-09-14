import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const OMP_SETTINGS_CATALOG_VERSION = 1;

export const OmpSettingTypeSchema = z.enum([
  "boolean",
  "string",
  "number",
  "enum",
  "array",
  "record",
]);
export type OmpSettingType = z.infer<typeof OmpSettingTypeSchema>;

export const OmpSettingSchema = z
  .object({
    path: z.string(),
    type: OmpSettingTypeSchema,
    description: z.string(),
    value: z.unknown().optional(),
    redacted: z.boolean().optional(),
    configured: z.boolean().optional(),
  })
  .strict();
export type OmpSetting = z.infer<typeof OmpSettingSchema>;

export const OMP_SETTING_CATEGORIES = [
  "appearance",
  "model",
  "interaction",
  "context",
  "memory",
  "files",
  "shell",
  "tools",
  "tasks",
  "providers",
  "general",
] as const;
export type OmpSettingCategory = (typeof OMP_SETTING_CATEGORIES)[number];

const CATEGORY_PREFIXES: Readonly<Record<OmpSettingCategory, readonly string[]>> = {
  appearance: [
    "theme.",
    "symbolPreset",
    "colorBlindMode",
    "composer.",
    "statusLine.",
    "terminal.",
    "tui.",
    "display.",
    "showHardwareCursor",
    "images.",
  ],
  model: [
    "modelRoles",
    "modelTags",
    "modelRoleStorage",
    "cycleOrder",
    "enabledModels",
    "defaultThinkingLevel",
    "thinkingBudgets.",
    "hideThinkingBlock",
    "proseOnlyThinking",
    "omitThinking",
    "externalThinking",
    "model.",
    "inlineToolDescriptors",
    "includeModelInPrompt",
    "includeWorkspaceTree",
    "personality",
    "temperature",
    "topP",
    "topK",
    "minP",
    "presencePenalty",
    "repetitionPenalty",
    "textVerbosity",
    "retry.",
    "advisor.",
    "prewalk.",
    "tier.",
  ],
  interaction: [
    "autoResume",
    "power.",
    "steeringMode",
    "ask.",
    "stt.",
    "speech.",
    "live.",
    "collab.",
    "magicKeywords",
    "git.",
  ],
  context: ["compaction.", "context.", "contextPromotion.", "ttsr.", "recap.", "branchSummary."],
  memory: ["memory.", "memories.", "mnemopi.", "hindsight.", "sharpshooter."],
  files: ["edit.", "read.", "files.", "file.", "lsp.", "tree"],
  shell: ["bash.", "eval.", "shell", "shellMinimizer."],
  tools: [
    "tools.",
    "todo.",
    "glob.",
    "grep.",
    "astGrep.",
    "astEdit.",
    "debug.",
    "launch.",
    "fetch.",
    "vault.",
    "github.",
    "web_search.",
    "browser.",
    "computer.",
    "checkpoint.",
    "async.",
    "irc.",
    "mcp.",
    "secrets.",
    "extensionHandlers.",
    "dev.",
  ],
  tasks: [
    "plan.",
    "goal.",
    "task.",
    "tasks.",
    "worktree.",
    "skills.",
    "commands.",
    "extensions",
    "disabledExtensions",
  ],
  providers: [
    "providers.",
    "provider.",
    "enabledProviders",
    "disabledProviders",
    "modelProviderOrder",
    "exa.",
    "searxng.",
    "codexResets.",
  ],
  general: [],
};

export function categorizeOmpSetting(path: string): OmpSettingCategory {
  for (const category of OMP_SETTING_CATEGORIES) {
    if (CATEGORY_PREFIXES[category].some((prefix) => path === prefix || path.startsWith(prefix))) {
      return category;
    }
  }
  return "general";
}

export function formatOmpSettingLabel(path: string): string {
  const leaf = path.split(".").at(-1) ?? path;
  const words = leaf
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return words ? `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}` : path;
}

export const listOmpSettings = defineRpc({
  name: "paseo-omp.list-settings",
  input: z.object({}),
  output: z.object({
    catalogVersion: z.literal(OMP_SETTINGS_CATALOG_VERSION),
    available: z.boolean(),
    droppedCount: z.number().int().nonnegative(),
    settings: z.array(OmpSettingSchema),
    error: z.string().optional(),
  }),
});

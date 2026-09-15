import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { OmpWorkspaceCwdSchema } from "./hub";

export const OMP_PLUGIN_LIMIT = 256;
export const OMP_PLUGIN_ARGUMENT_LIMIT = 512;

const SAFE_NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const SAFE_MARKETPLACE_ID =
  /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/u;

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function hasUnsafeArgumentCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export const OmpPluginNameSchema = z
  .string()
  .min(1)
  .max(214)
  .regex(SAFE_NPM_PACKAGE, "Expected an installed OMP package name");

export const OmpMarketplacePluginIdSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(SAFE_MARKETPLACE_ID, "Expected name@marketplace");

export const OmpPluginTargetSchema = z.union([OmpPluginNameSchema, OmpMarketplacePluginIdSchema]);

export const OmpPluginInstallSourceSchema = z
  .string()
  .min(1)
  .max(OMP_PLUGIN_ARGUMENT_LIMIT)
  .refine(
    (value) => utf8ByteLength(value) <= OMP_PLUGIN_ARGUMENT_LIMIT,
    "Plugin source is too large",
  )
  .refine((value) => value.trim() === value, "Plugin source must not have surrounding whitespace")
  .refine(
    (value) => !hasUnsafeArgumentCharacter(value),
    "Plugin source contains an unsafe character",
  )
  .refine((value) => !value.startsWith("-"), "Plugin source must not be an option");

export const OmpPluginScopeSchema = z.enum(["user", "project"]);
export type OmpPluginScope = z.infer<typeof OmpPluginScopeSchema>;

export const OmpInstalledPluginSchema = z
  .object({
    id: z.string().min(1).max(214),
    packageName: OmpPluginNameSchema.optional(),
    version: z.string().min(1).max(128).nullable(),
    source: z.enum(["npm", "marketplace"]),
    scope: OmpPluginScopeSchema.nullable(),
    enabled: z.boolean(),
    shadowed: z.boolean(),
    path: z.string().min(1).max(4_096).nullable(),
    description: z.string().max(1_024).nullable(),
    enabledFeatures: z.array(z.string().min(1).max(128)).max(128),
    availableFeatures: z.array(z.string().min(1).max(128)).max(128),
    configurable: z.boolean(),
    ambiguous: z.boolean(),
    configAmbiguous: z.boolean(),
    usesDefaultFeatures: z.boolean(),
  })
  .strict();
export type OmpInstalledPlugin = z.infer<typeof OmpInstalledPluginSchema>;

export const OmpPluginStateSchema = z
  .object({
    available: z.boolean(),
    plugins: z.array(OmpInstalledPluginSchema).max(OMP_PLUGIN_LIMIT),
    droppedCount: z.number().int().nonnegative(),
    error: z.string().max(256).optional(),
  })
  .strict();
export type OmpPluginState = z.infer<typeof OmpPluginStateSchema>;

export const listOmpPlugins = defineRpc({
  name: "paseo-omp.list-plugins",
  input: z.object({ cwd: OmpWorkspaceCwdSchema.optional() }).strict(),
  output: OmpPluginStateSchema,
});

export const OmpPluginConfigSettingSchema = z
  .object({
    key: z.string().min(1).max(128),
    type: z.enum(["string", "number", "boolean", "enum"]),
    description: z.string().max(512),
    configured: z.boolean(),
    secret: z.boolean(),
    enumValues: z.array(z.string().min(1).max(256)).max(128),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
    step: z.number().finite().positive().optional(),
  })
  .strict();
export type OmpPluginConfigSetting = z.infer<typeof OmpPluginConfigSettingSchema>;

export const OmpPluginConfigStateSchema = z
  .object({
    available: z.boolean(),
    plugin: OmpPluginNameSchema,
    settings: z.array(OmpPluginConfigSettingSchema).max(OMP_PLUGIN_LIMIT),
    droppedCount: z.number().int().nonnegative(),
    error: z.string().max(256).optional(),
  })
  .strict();
export type OmpPluginConfigState = z.infer<typeof OmpPluginConfigStateSchema>;

export const inspectOmpPluginConfig = defineRpc({
  name: "paseo-omp.inspect-plugin-config",
  input: z.object({ plugin: OmpPluginNameSchema, cwd: OmpWorkspaceCwdSchema.optional() }).strict(),
  output: OmpPluginConfigStateSchema,
});

export const OmpPluginConfigKeySchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim() === value, "Setting key must not have surrounding whitespace")
  .refine((value) => !hasUnsafeArgumentCharacter(value), "Setting key contains an unsafe character")
  .refine((value) => !value.startsWith("-"), "Setting key must not be an option");

export const OmpPluginConfigStringValueSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => utf8ByteLength(value) <= 4_096, "Setting value is too large")
  .refine(
    (value) => !hasUnsafeArgumentCharacter(value),
    "Setting value contains an unsafe character",
  )
  .refine((value) => !value.startsWith("-"), "Setting value must not be an option");

export const OmpPluginConfigMutationSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("set"),
      plugin: OmpPluginNameSchema,
      key: OmpPluginConfigKeySchema,
      value: z.union([OmpPluginConfigStringValueSchema, z.number().finite(), z.boolean()]),
      cwd: OmpWorkspaceCwdSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("delete"),
      plugin: OmpPluginNameSchema,
      key: OmpPluginConfigKeySchema,
      cwd: OmpWorkspaceCwdSchema.optional(),
    })
    .strict(),
]);
export type OmpPluginConfigMutation = z.infer<typeof OmpPluginConfigMutationSchema>;

export const mutateOmpPluginConfig = defineRpc({
  name: "paseo-omp.mutate-plugin-config",
  input: OmpPluginConfigMutationSchema,
  output: z
    .object({
      ok: z.boolean(),
      message: z.string().min(1).max(256),
      config: OmpPluginConfigStateSchema,
    })
    .strict(),
});

const ScopedMutationShape = {
  scope: OmpPluginScopeSchema.optional(),
  cwd: OmpWorkspaceCwdSchema.optional(),
};
export const OmpPluginMutationSchema = z
  .discriminatedUnion("action", [
    z
      .object({
        action: z.literal("install"),
        source: OmpPluginInstallSourceSchema,
        ...ScopedMutationShape,
      })
      .strict(),
    z
      .object({
        action: z.literal("enable"),
        plugin: OmpPluginTargetSchema,
        ...ScopedMutationShape,
      })
      .strict(),
    z
      .object({
        action: z.literal("disable"),
        plugin: OmpPluginTargetSchema,
        ...ScopedMutationShape,
      })
      .strict(),
    z
      .object({
        action: z.literal("uninstall"),
        plugin: OmpPluginTargetSchema,
        ...ScopedMutationShape,
      })
      .strict(),
    z
      .object({
        action: z.literal("upgrade"),
        plugin: OmpMarketplacePluginIdSchema,
        ...ScopedMutationShape,
      })
      .strict(),
  ])
  .superRefine((input, context) => {
    if (input.scope === "project" && input.cwd === undefined) {
      context.addIssue({
        code: "custom",
        message: "Project-scoped plugin actions require a workspace",
        path: ["cwd"],
      });
    }
    if (input.action === "install" && input.scope === "project") {
      context.addIssue({
        code: "custom",
        message: "Project-scoped installation is not supported through this API",
        path: ["scope"],
      });
    }
  });
export type OmpPluginMutation = z.infer<typeof OmpPluginMutationSchema>;

export const mutateOmpPlugin = defineRpc({
  name: "paseo-omp.mutate-plugin",
  input: OmpPluginMutationSchema,
  output: z
    .object({
      ok: z.boolean(),
      message: z.string().min(1).max(256),
      state: OmpPluginStateSchema,
    })
    .strict(),
});

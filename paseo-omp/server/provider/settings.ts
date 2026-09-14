import { z } from "zod";

const MAX_COMMAND_PARTS = 64;
const MAX_ENV_ENTRIES = 256;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_MODEL_SELECTOR_BYTES = 513;
const MAX_PATH_BYTES = 4_096;
const MAX_RPC_TIMEOUT_MS = 10 * 60 * 1_000;

function boundedString(maxBytes: number) {
  return z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value, "utf8") <= maxBytes);
}

const CommandPartSchema = boundedString(MAX_PATH_BYTES).refine(
  (value) => !value.includes("\0") && !/[\r\n]/u.test(value),
  "command arguments cannot contain NUL or line breaks",
);
const EnvironmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u);
const EnvironmentValueSchema = z
  .string()
  .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_TEXT_BYTES && !value.includes("\0"));
const ModelSelectorSchema = boundedString(MAX_MODEL_SELECTOR_BYTES).refine(
  (value) => !value.includes("\0"),
);

/** Native approval modes are available because provider permissions are bridged to Paseo. */
export const OmpModeSchema = z.enum(["full", "write", "ask"]);
export const OmpOutputRedactionSchema = z.enum(["none", "configured-values"]).default("none");

export const OmpProviderParamsSchema = z
  .object({
    sessionDir: boundedString(MAX_PATH_BYTES)
      .describe("OMP session directory passed through --session-dir")
      .optional(),
    rpcTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_RPC_TIMEOUT_MS)
      .describe("Shared OMP startup and RPC timeout in milliseconds")
      .optional(),
    smolModel: ModelSelectorSchema.describe("OMP smol role model selector").optional(),
    slowModel: ModelSelectorSchema.describe("OMP slow role model selector").optional(),
    planModel: ModelSelectorSchema.describe("OMP plan role model selector").optional(),
  })
  .strict();

/** Strict provider-scoped OMP launch options. */
export const OmpProviderOptionsSchema = z
  .object({
    command: z
      .array(CommandPartSchema)
      .min(1)
      .max(MAX_COMMAND_PARTS)
      .describe("Complete OMP executable and argument prefix")
      .optional(),
    env: z
      .record(EnvironmentNameSchema, EnvironmentValueSchema)
      .describe("Profile environment applied before session launch environment")
      .optional(),
    inheritEnv: z
      .array(EnvironmentNameSchema)
      .max(MAX_ENV_ENTRIES)
      .describe("Daemon environment variable names copied at OMP spawn time")
      .optional(),
    outputRedaction: OmpOutputRedactionSchema.describe(
      "Best-effort exact replacement of explicitly configured credential values in public output",
    ),
    params: OmpProviderParamsSchema.optional(),
  })
  .strict();

export type OmpMode = z.infer<typeof OmpModeSchema>;
export type OmpOutputRedaction = z.infer<typeof OmpOutputRedactionSchema>;
export type OmpProviderOptions = z.infer<typeof OmpProviderOptionsSchema>;

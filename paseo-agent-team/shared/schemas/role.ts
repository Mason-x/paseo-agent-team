import { z } from "zod";
import { DescriptionSchema, ShortTextSchema, SlugSchema, StringListSchema } from "./common";
import { StoredDesignerOriginSchema } from "./design-origin";
import { ProfileRefSchema } from "./profile-ref";
import { StoredRoleExecutionPolicySchema } from "./team-mode";

const controlFree = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !/[\0\r\n]/.test(value), {
      message: "control characters are not allowed",
    });

const McpEnvSchema = z
  .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), controlFree(4000))
  .refine((env) => Object.keys(env).length <= 32, { message: "too many env vars" });

const McpHeaderSchema = z
  .record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), controlFree(4000))
  .refine((headers) => Object.keys(headers).length <= 32, { message: "too many headers" });

const StdioMcpServerSchema = z
  .object({
    type: z.literal("stdio").optional(),
    command: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .refine((value) => !/[\0\r\n]/.test(value), {
        message: "control characters are not allowed",
      }),
    args: z.array(controlFree(1000)).max(32).optional(),
    env: McpEnvSchema.optional(),
    alwaysLoad: z.boolean().optional(),
  })
  .strict();

const RemoteMcpServerSchema = z
  .object({
    type: z.enum(["http", "sse"]),
    url: z.string().trim().url().max(2000),
    headers: McpHeaderSchema.optional(),
    alwaysLoad: z.boolean().optional(),
  })
  .strict();

export const McpServersSchema = z
  .record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/),
    z.union([StdioMcpServerSchema, RemoteMcpServerSchema]),
  )
  .refine((servers) => Object.keys(servers).length <= 8, { message: "at most 8 MCP servers" });

export type McpServers = z.infer<typeof McpServersSchema>;

// Persisted inside Roles. Deliberately tolerant: a newer or damaged origin must never invalidate
// the whole Roles document (the settings screen would only offer a full reset). Unknown keys are
// preserved so a newer writer's metadata survives a round-trip through this version.
export const PresetOriginSchema = z
  .object({
    catalogId: z.string().min(1),
    templateId: z.string().min(1),
    catalogRevision: z.string(),
    templateHash: z.string(),
    appliedHash: z.string(),
    importedAt: z.string(),
  })
  .passthrough();

export const RoleSchema = z
  .object({
    id: SlugSchema,
    name: ShortTextSchema,
    description: DescriptionSchema.optional(),
    mission: z.string().trim().min(1).max(2000),
    responsibilities: StringListSchema.min(1),
    restrictions: StringListSchema.default([]),
    systemPrompt: z.string().trim().min(1).max(20000),
    outputContract: StringListSchema.default([]),
    preferredProfiles: z.array(ProfileRefSchema).min(1).max(5),
    fallbackProfiles: z.array(ProfileRefSchema).max(5).default([]),
    mcpServers: McpServersSchema.optional(),
    color: z.string().max(32).optional(),
    icon: z.string().max(64).optional(),
    enabled: z.boolean().default(true),
    createdAt: z.string(),
    updatedAt: z.string(),
    // Tier and task kind for mode planning. Values are preserved as stored, even when a newer
    // writer used an unknown value or the wrong type; resolveRoleExecution reports them.
    executionPolicy: StoredRoleExecutionPolicySchema.optional(),
    // Other origins (including team-designer) remain valid extension values.
    source: z.string().optional(),
    // Team-designer provenance. A damaged block drops only the origin; the Role stays editable.
    designer: StoredDesignerOriginSchema.optional().catch(undefined),
    /** Required on a designer-created Role; ordinary Roles omit it. */
    noveltyReason: z.string().trim().min(1).max(600).optional(),
    // A damaged preset origin drops only that block for the same reason.
    preset: PresetOriginSchema.optional().catch(undefined),
  })
  .passthrough();

export type Role = z.infer<typeof RoleSchema>;

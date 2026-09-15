import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { OmpWorkspaceCwdSchema } from "./hub";

// Mirrors the safe, non-secret subset of omp's on-disk ~/.omp/agent/config.yml. That file is an
// internal, unversioned config format owned by the omp harness (source: omp's
// settings-schema.ts), not a published API, so this is an explicit allowlist rather than a
// passthrough: every section below has been checked against that schema's `credential: true`
// markers and carries none. Sections the schema marks as credential-bearing (auth broker
// tokens, mnemopi/hindsight embedding and LLM API keys, searxng basic-auth, blob-destination
// headers) are deliberately absent and must stay that way. A field not listed here is never
// read, rendered, or forwarded across the RPC boundary — server/omp-config.ts parses each
// section independently and omits it entirely if it fails to match, rather than guessing or
// widening the schema.

export const OmpModelRolesSchema = z.record(z.string(), z.string());

export const OmpFallbackChainsSchema = z.record(z.string(), z.array(z.string()));

export const OmpThemeSectionSchema = z.object({
  dark: z.string().optional(),
  light: z.string().optional(),
});

export const OmpMemorySectionSchema = z.object({
  backend: z.enum(["off", "local", "hindsight", "mnemopi", "sharpshooter"]).optional(),
});

export const OmpGithubCacheSectionSchema = z.object({
  enabled: z.boolean().optional(),
  softTtlSec: z.number().optional(),
  hardTtlSec: z.number().optional(),
});

export const OmpGithubSectionSchema = z.object({
  enabled: z.boolean().optional(),
  cache: OmpGithubCacheSectionSchema.optional(),
});

export const OmpRetrySectionSchema = z.object({
  enabled: z.boolean().optional(),
  maxRetries: z.number().optional(),
  baseDelayMs: z.number().optional(),
  maxDelayMs: z.number().optional(),
  waitForUsageReset: z.boolean().optional(),
  modelFallback: z.boolean().optional(),
  usageAwareFallback: z.boolean().optional(),
  usageReservePct: z.number().optional(),
  usageReservePolicy: z.enum(["confirm", "auto", "fail-closed"]).optional(),
  fallbackRevertPolicy: z.enum(["cooldown-expiry", "never"]).optional(),
  fallbackChains: OmpFallbackChainsSchema.optional(),
});

export const OmpDevSectionSchema = z.object({
  autoqaConsent: z.enum(["unset", "granted", "denied"]).optional(),
});

export const OmpConfigSchema = z.object({
  setupVersion: z.number().optional(),
  symbolPreset: z.enum(["unicode", "nerd", "ascii"]).optional(),
  defaultThinkingLevel: z.string().optional(),
  theme: OmpThemeSectionSchema.optional(),
  memory: OmpMemorySectionSchema.optional(),
  github: OmpGithubSectionSchema.optional(),
  disabledProviders: z.array(z.string()).optional(),
  modelProviderOrder: z.array(z.string()).optional(),
  modelRoles: OmpModelRolesSchema.optional(),
  enabledModels: z.array(z.string()).optional(),
  retry: OmpRetrySectionSchema.optional(),
  dev: OmpDevSectionSchema.optional(),
});
export type OmpConfig = z.infer<typeof OmpConfigSchema>;

export const listOmpConfig = defineRpc({
  name: "paseo-omp.list-config",
  input: z.object({ cwd: OmpWorkspaceCwdSchema.optional() }).strict(),
  output: z.object({
    path: z.string(),
    available: z.boolean(),
    config: OmpConfigSchema.nullable(),
  }),
});

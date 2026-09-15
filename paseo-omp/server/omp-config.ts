import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import { parse as parseYaml } from "yaml";
import type { ZodType } from "zod";
import {
  type listOmpConfig,
  type OmpConfig,
  OmpConfigSchema,
  OmpDevSectionSchema,
  OmpGithubSectionSchema,
  OmpMemorySectionSchema,
  OmpModelRolesSchema,
  OmpRetrySectionSchema,
  OmpThemeSectionSchema,
} from "../shared/omp-config";
import { ompAgentDir } from "./paths";

/**
 * omp writes its global settings to `~/.omp/agent/config.yml`, falling back to legacy
 * `config.yaml` (mirrors omp's `MAIN_CONFIG_FILENAMES`, canonical filename first). This is an
 * internal, unversioned file: reading it here is best-effort and degrades to "unavailable"
 * instead of throwing when the file is missing, unreadable, or not a YAML mapping.
 */
const CONFIG_FILENAMES = ["config.yml", "config.yaml"] as const;

type OmpConfigResult = { path: string; available: boolean; config: OmpConfig | null };

async function readFirstExisting(
  dir: string,
  filenames: readonly string[] = CONFIG_FILENAMES,
): Promise<{ path: string; text: string } | undefined> {
  for (const filename of filenames) {
    const path = join(dir, filename);
    try {
      return { path, text: await readFile(path, "utf8") };
    } catch {
      // Try the next candidate filename.
    }
  }
  return undefined;
}

/** Validates one top-level section independently so an unrelated malformed field never hides the rest. */
function section<Schema extends ZodType>(
  schema: Schema,
  value: unknown,
): Schema["_output"] | undefined {
  if (value === undefined) return undefined;
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}

/**
 * Maps a parsed YAML document onto the safe allowlist in `shared/omp-config.ts`. Every field is
 * read explicitly by name; nothing on the source object is spread, stringified, or forwarded
 * unchecked, so an unrecognized or credential-shaped key never reaches the caller.
 */
export function parseOmpConfig(raw: unknown): OmpConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const config: OmpConfig = {};

  const setupVersion = section(OmpConfigSchema.shape.setupVersion, record.setupVersion);
  if (setupVersion !== undefined) config.setupVersion = setupVersion;

  const symbolPreset = section(OmpConfigSchema.shape.symbolPreset, record.symbolPreset);
  if (symbolPreset !== undefined) config.symbolPreset = symbolPreset;

  const defaultThinkingLevel = section(
    OmpConfigSchema.shape.defaultThinkingLevel,
    record.defaultThinkingLevel,
  );
  if (defaultThinkingLevel !== undefined) config.defaultThinkingLevel = defaultThinkingLevel;

  const theme = section(OmpThemeSectionSchema, record.theme);
  if (theme !== undefined) config.theme = theme;

  const memory = section(OmpMemorySectionSchema, record.memory);
  if (memory !== undefined) config.memory = memory;

  const github = section(OmpGithubSectionSchema, record.github);
  if (github !== undefined) config.github = github;

  const disabledProviders = section(
    OmpConfigSchema.shape.disabledProviders,
    record.disabledProviders,
  );
  if (disabledProviders !== undefined) config.disabledProviders = disabledProviders;

  const modelProviderOrder = section(
    OmpConfigSchema.shape.modelProviderOrder,
    record.modelProviderOrder,
  );
  if (modelProviderOrder !== undefined) config.modelProviderOrder = modelProviderOrder;

  const modelRoles = section(OmpModelRolesSchema, record.modelRoles);
  if (modelRoles !== undefined) config.modelRoles = modelRoles;

  const enabledModels = section(OmpConfigSchema.shape.enabledModels, record.enabledModels);
  if (enabledModels !== undefined) config.enabledModels = enabledModels;

  const retry = section(OmpRetrySectionSchema, record.retry);
  if (retry !== undefined) config.retry = retry;

  const dev = section(OmpDevSectionSchema, record.dev);
  if (dev !== undefined) config.dev = dev;

  return config;
}

export async function readOmpConfigFrom(
  dir: string,
  filenames: readonly string[] = CONFIG_FILENAMES,
): Promise<OmpConfigResult> {
  const defaultPath = join(dir, filenames[0] ?? CONFIG_FILENAMES[0]);
  const found = await readFirstExisting(dir, filenames);
  if (!found) return { path: defaultPath, available: false, config: null };
  try {
    const raw: unknown = parseYaml(found.text);
    return { path: found.path, available: true, config: parseOmpConfig(raw) };
  } catch {
    // Malformed YAML: never log the raw text, degrade to a clear unavailable result.
    return { path: found.path, available: false, config: null };
  }
}

export async function resolveListOmpConfig(
  input: RpcInput<typeof listOmpConfig>,
): Promise<OmpConfigResult> {
  if (input.cwd && isAbsolute(input.cwd) && !input.cwd.includes("\0")) {
    return readOmpConfigFrom(join(input.cwd, ".omp"), [CONFIG_FILENAMES[0]]);
  }
  return readOmpConfigFrom(ompAgentDir());
}

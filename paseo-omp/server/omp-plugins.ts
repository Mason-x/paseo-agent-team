import { readFile, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import { z } from "zod";
import {
  type inspectOmpPluginConfig,
  type listOmpPlugins,
  type mutateOmpPlugin,
  type mutateOmpPluginConfig,
  OMP_PLUGIN_LIMIT,
  type OmpInstalledPlugin,
  OmpInstalledPluginSchema,
  OmpMarketplacePluginIdSchema,
  type OmpPluginConfigMutation,
  type OmpPluginConfigSetting,
  type OmpPluginConfigState,
  type OmpPluginMutation,
  OmpPluginNameSchema,
  type OmpPluginState,
} from "../shared/omp-plugins";
import { SerialMutationQueue } from "./mutation-queue";
import {
  type BoundedRun,
  buildStatefulCommandEnv,
  defaultSpawn,
  resolveExecutablePath,
  runBounded,
} from "./provider-diagnostics";

const LIST_OUTPUT_LIMIT = 512 * 1024;
const MUTATION_OUTPUT_LIMIT = 256 * 1024;
const CONFIG_OUTPUT_LIMIT = 256 * 1024;
const READ_TIMEOUT_MS = 15_000;
const MUTATION_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 1_000;
const WINDOWS_DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const DESCRIPTION_LIMIT = 1_024;
const CONFIG_DESCRIPTION_LIMIT = 512;
const FEATURE_LIMIT = 128;
const CREDENTIAL_KEY =
  /(?:^|_)(?:API_KEY|ACCESS_KEY|ACCESS_TOKEN|AUTHORIZATION|COOKIE|CREDENTIAL|CREDENTIALS|OAUTH|PASSWORD|PRIVATE_KEY|REFRESH_TOKEN|SECRET|SESSION_TOKEN|TOKEN)(?:$|_)/u;
const PACKAGE_METADATA_LIMIT = 64 * 1024;

const RawNpmPluginSchema = z.object({
  name: z.unknown(),
  version: z.unknown(),
  path: z.unknown(),
  manifest: z.unknown().optional(),
  enabledFeatures: z.unknown().optional(),
  enabled: z.unknown(),
});
const RawMarketplaceEntrySchema = z.object({
  installPath: z.unknown(),
  version: z.unknown(),
  enabled: z.unknown().optional(),
});
const RawMarketplacePluginSchema = z.object({
  id: z.unknown(),
  scope: z.unknown(),
  entries: z.unknown(),
  shadowedBy: z.unknown().optional(),
});
const RawPluginSettingSchema = z.object({
  type: z.unknown(),
  description: z.unknown().optional(),
  secret: z.unknown().optional(),
  default: z.unknown().optional(),
  values: z.unknown().optional(),
  min: z.unknown().optional(),
  max: z.unknown().optional(),
  step: z.unknown().optional(),
});

export interface OmpPluginDependencies {
  resolveExecutable(): Promise<string | null>;
  runPlugin(
    executable: string,
    args: readonly string[],
    outputLimit: number,
    timeoutMs: number,
    cwd?: string,
  ): Promise<BoundedRun>;
}

function validWorkspaceCwd(cwd: string | undefined): boolean {
  return cwd === undefined || (isAbsolute(cwd) && !cwd.includes("\0"));
}

function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) return null;
  if (/[\0\r\n]/u.test(value)) return null;
  return value;
}

function featureNames(value: unknown): string[] {
  const candidates = Array.isArray(value)
    ? value
    : value !== null && typeof value === "object"
      ? Object.keys(value)
      : [];
  const result: string[] = [];
  for (const candidate of candidates) {
    const feature = boundedText(candidate, FEATURE_LIMIT);
    if (!feature || result.includes(feature)) continue;
    result.push(feature);
    if (result.length === FEATURE_LIMIT) break;
  }
  return result;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseNpmPlugin(raw: unknown): OmpInstalledPlugin | null {
  const candidate = RawNpmPluginSchema.safeParse(raw);
  if (!candidate.success) return null;
  const name = boundedText(candidate.data.name, 214);
  const version = boundedText(candidate.data.version, 128);
  const path = boundedText(candidate.data.path, 4_096);
  if (!name || !version || !path || typeof candidate.data.enabled !== "boolean") return null;

  const manifest = objectRecord(candidate.data.manifest);
  const description = boundedText(manifest.description, DESCRIPTION_LIMIT);
  const availableFeatures = featureNames(manifest.features);
  const enabledFeatures = featureNames(candidate.data.enabledFeatures);
  const plugin = {
    id: name,
    packageName: name,
    version,
    source: "npm" as const,
    scope: null,
    enabled: candidate.data.enabled,
    shadowed: false,
    path,
    configAmbiguous: false,
    description,
    enabledFeatures,
    availableFeatures,
    configurable: Object.keys(objectRecord(manifest.settings)).length > 0,
    ambiguous: false,
    usesDefaultFeatures: candidate.data.enabledFeatures == null,
  };
  return OmpInstalledPluginSchema.safeParse(plugin).success ? plugin : null;
}

function parseMarketplacePlugin(raw: unknown): OmpInstalledPlugin | null {
  const candidate = RawMarketplacePluginSchema.safeParse(raw);
  if (!candidate.success || !Array.isArray(candidate.data.entries)) return null;
  const id = boundedText(candidate.data.id, 128);
  const scope: "user" | "project" | null =
    candidate.data.scope === "user"
      ? "user"
      : candidate.data.scope === "project"
        ? "project"
        : null;
  const first = RawMarketplaceEntrySchema.safeParse(candidate.data.entries[0]);
  if (!id || !OmpMarketplacePluginIdSchema.safeParse(id).success || !scope || !first.success) {
    return null;
  }
  const path = boundedText(first.data.installPath, 4_096);
  const version = boundedText(first.data.version, 128);
  if (!path || !version) return null;

  const plugin = {
    id,
    version,
    source: "marketplace" as const,
    scope,
    enabled: first.data.enabled !== false,
    shadowed: candidate.data.shadowedBy === "project",
    path,
    description: null,
    configAmbiguous: false,
    enabledFeatures: [],
    availableFeatures: [],
    configurable: false,
    ambiguous: false,
    usesDefaultFeatures: true,
  };
  return OmpInstalledPluginSchema.safeParse(plugin).success ? plugin : null;
}

function pluginAliases(plugin: OmpInstalledPlugin): string[] {
  const aliases = new Set<string>();
  if (plugin.packageName) aliases.add(plugin.packageName);
  aliases.add(plugin.id);
  if (plugin.source === "marketplace") aliases.add(plugin.id.split("@")[0] ?? plugin.id);
  return [...aliases];
}

function markAmbiguousPlugins(plugins: OmpInstalledPlugin[]): OmpInstalledPlugin[] {
  const lifecycleCounts = new Map<string, number>();
  const configCounts = new Map<string, number>();
  const lifecycleKey = (plugin: OmpInstalledPlugin) =>
    plugin.source === "marketplace"
      ? `marketplace:${plugin.scope}:${plugin.id}`
      : `npm:${plugin.id}`;
  for (const plugin of plugins) {
    const key = lifecycleKey(plugin);
    lifecycleCounts.set(key, (lifecycleCounts.get(key) ?? 0) + 1);
    if (plugin.packageName) {
      configCounts.set(plugin.packageName, (configCounts.get(plugin.packageName) ?? 0) + 1);
    }
  }
  return plugins.map((plugin) => ({
    ...plugin,
    ambiguous: (lifecycleCounts.get(lifecycleKey(plugin)) ?? 0) > 1,
    configAmbiguous:
      plugin.packageName !== undefined && (configCounts.get(plugin.packageName) ?? 0) > 1,
  }));
}

export function parseOmpPluginList(raw: unknown): Pick<OmpPluginState, "plugins" | "droppedCount"> {
  const root = objectRecord(raw);
  if (!Array.isArray(root.npm) || !Array.isArray(root.marketplace)) {
    throw new Error("OMP returned an invalid plugin list");
  }

  const plugins: OmpInstalledPlugin[] = [];
  let droppedCount = 0;
  const append = (plugin: OmpInstalledPlugin | null) => {
    if (!plugin || plugins.length >= OMP_PLUGIN_LIMIT) {
      droppedCount += 1;
      return;
    }
    plugins.push(plugin);
  };
  for (const plugin of root.npm) append(parseNpmPlugin(plugin));
  for (const plugin of root.marketplace) append(parseMarketplacePlugin(plugin));
  return { plugins: markAmbiguousPlugins(plugins), droppedCount };
}

function runSucceeded(result: BoundedRun): boolean {
  return (
    result.outcome === "exited" &&
    result.exitCode === 0 &&
    result.signal === null &&
    !result.truncated &&
    !result.cleanupFailed
  );
}

function unavailableState(error: string): OmpPluginState {
  return { available: false, plugins: [], droppedCount: 0, error };
}

function readFailure(result: BoundedRun): string {
  if (result.cleanupFailed) return "OMP plugin process cleanup could not be confirmed.";
  if (result.outcome === "timeout") return "OMP plugin discovery timed out.";
  return "OMP plugin discovery failed.";
}

async function resolveOmpExecutable(): Promise<string | null> {
  return resolveExecutablePath(
    process.env.OMP_COMMAND ?? "omp",
    (process.env.PATH ?? "").split(delimiter),
    {
      cwd: process.cwd(),
      platform: process.platform,
      pathExt: process.env.PATHEXT ?? WINDOWS_DEFAULT_PATHEXT,
    },
  );
}

async function runOmpPlugin(
  executable: string,
  args: readonly string[],
  outputLimit: number,
  timeoutMs: number,
  cwd = process.cwd(),
): Promise<BoundedRun> {
  return runBounded(
    defaultSpawn,
    executable,
    args,
    buildStatefulCommandEnv(process.env),
    timeoutMs,
    KILL_GRACE_MS,
    outputLimit,
    cwd,
  );
}

async function enrichMarketplaceConfiguration(
  plugins: OmpInstalledPlugin[],
): Promise<OmpInstalledPlugin[]> {
  const enriched = await Promise.all(
    plugins.map(async (plugin) => {
      if (plugin.source !== "marketplace" || !plugin.path) return plugin;
      try {
        const metadataPath = join(plugin.path, "package.json");
        const metadata = await stat(metadataPath);
        if (!metadata.isFile() || metadata.size > PACKAGE_METADATA_LIMIT) return plugin;
        const raw: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
        const metadataName = OmpPluginNameSchema.safeParse(objectRecord(raw).name);
        const fallbackName = OmpPluginNameSchema.safeParse(plugin.id.split("@")[0]);
        const packageName = metadataName.success
          ? metadataName.data
          : fallbackName.success
            ? fallbackName.data
            : null;
        if (!packageName) return plugin;
        return { ...plugin, packageName, configurable: true };
      } catch {
        return plugin;
      }
    }),
  );
  return markAmbiguousPlugins(enriched);
}

const DEFAULT_DEPENDENCIES: OmpPluginDependencies = {
  resolveExecutable: resolveOmpExecutable,
  runPlugin: runOmpPlugin,
};

async function loadPluginState(
  executable: string | null | undefined,
  dependencies: OmpPluginDependencies,
  cwd?: string,
): Promise<OmpPluginState> {
  const resolved = executable === undefined ? await dependencies.resolveExecutable() : executable;
  if (!resolved) return unavailableState("The OMP executable could not be resolved.");
  const result = await dependencies.runPlugin(
    resolved,
    ["plugin", "list", "--json"],
    LIST_OUTPUT_LIMIT,
    READ_TIMEOUT_MS,
    cwd,
  );
  if (!runSucceeded(result)) return unavailableState(readFailure(result));
  try {
    const parsed = parseOmpPluginList(JSON.parse(result.stdout) as unknown);
    return {
      available: true,
      plugins: await enrichMarketplaceConfiguration(parsed.plugins),
      droppedCount: parsed.droppedCount,
    };
  } catch {
    return unavailableState("OMP returned invalid plugin metadata.");
  }
}

export async function listOmpPluginsWithDependencies(
  input: RpcInput<typeof listOmpPlugins>,
  dependencies: OmpPluginDependencies,
): Promise<OmpPluginState> {
  if (!validWorkspaceCwd(input.cwd)) return unavailableState("The workspace path is invalid.");
  return loadPluginState(undefined, dependencies, input.cwd);
}

export async function resolveListOmpPlugins(
  input: RpcInput<typeof listOmpPlugins>,
): Promise<OmpPluginState> {
  return listOmpPluginsWithDependencies(input, DEFAULT_DEPENDENCIES);
}

function isCredentialSetting(key: string, secret: unknown): boolean {
  if (secret === true) return true;
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .toUpperCase();
  return CREDENTIAL_KEY.test(normalized);
}

export function parseOmpPluginConfig(raw: unknown): {
  settings: OmpPluginConfigSetting[];
  droppedCount: number;
} {
  const root = objectRecord(raw);
  const values = objectRecord(root.settings);
  const schema = objectRecord(root.schema);
  const settings: OmpPluginConfigSetting[] = [];
  let droppedCount = 0;
  for (const [key, rawDefinition] of Object.entries(schema)) {
    if (settings.length >= OMP_PLUGIN_LIMIT || !boundedText(key, 128)) {
      droppedCount += 1;
      continue;
    }
    const definition = RawPluginSettingSchema.safeParse(rawDefinition);
    if (!definition.success) {
      droppedCount += 1;
      continue;
    }
    const type = definition.data.type;
    if (type !== "string" && type !== "number" && type !== "boolean" && type !== "enum") {
      droppedCount += 1;
      continue;
    }
    const description =
      typeof definition.data.description === "string"
        ? definition.data.description.slice(0, CONFIG_DESCRIPTION_LIMIT)
        : "";
    const enumValues =
      type === "enum" && Array.isArray(definition.data.values)
        ? definition.data.values
            .map((value) => boundedText(value, 256))
            .filter((value): value is string => value !== null)
            .slice(0, FEATURE_LIMIT)
        : [];
    const minimum =
      typeof definition.data.min === "number" && Number.isFinite(definition.data.min)
        ? definition.data.min
        : undefined;
    const maximum =
      typeof definition.data.max === "number" && Number.isFinite(definition.data.max)
        ? definition.data.max
        : undefined;
    const step =
      typeof definition.data.step === "number" &&
      Number.isFinite(definition.data.step) &&
      definition.data.step > 0
        ? definition.data.step
        : undefined;
    settings.push({
      key,
      type,
      description,
      configured: Object.hasOwn(values, key),
      secret: isCredentialSetting(key, definition.data.secret),
      enumValues,
      ...(minimum === undefined ? {} : { minimum }),
      ...(maximum === undefined ? {} : { maximum }),
      ...(step === undefined ? {} : { step }),
    });
  }
  return { settings, droppedCount };
}

function unavailableConfig(plugin: string, error: string): OmpPluginConfigState {
  return { available: false, plugin, settings: [], droppedCount: 0, error };
}

async function loadPluginConfig(
  executable: string,
  plugin: string,
  dependencies: OmpPluginDependencies,
  cwd?: string,
): Promise<OmpPluginConfigState> {
  const result = await dependencies.runPlugin(
    executable,
    ["plugin", "config", "list", plugin, "--json"],
    CONFIG_OUTPUT_LIMIT,
    READ_TIMEOUT_MS,
    cwd,
  );
  if (!runSucceeded(result)) {
    return unavailableConfig(
      plugin,
      result.outcome === "timeout"
        ? "OMP plugin configuration inspection timed out."
        : "OMP plugin configuration inspection failed.",
    );
  }
  try {
    return { available: true, plugin, ...parseOmpPluginConfig(JSON.parse(result.stdout)) };
  } catch {
    return unavailableConfig(plugin, "OMP returned invalid plugin configuration metadata.");
  }
}

export async function inspectOmpPluginConfigWithDependencies(
  input: RpcInput<typeof inspectOmpPluginConfig>,
  dependencies: OmpPluginDependencies,
): Promise<OmpPluginConfigState> {
  if (!validWorkspaceCwd(input.cwd)) {
    return unavailableConfig(input.plugin, "The workspace path is invalid.");
  }
  const executable = await dependencies.resolveExecutable();
  return executable
    ? loadPluginConfig(executable, input.plugin, dependencies, input.cwd)
    : unavailableConfig(input.plugin, "The OMP executable could not be resolved.");
}

export async function resolveInspectOmpPluginConfig(
  input: RpcInput<typeof inspectOmpPluginConfig>,
) {
  return inspectOmpPluginConfigWithDependencies(input, DEFAULT_DEPENDENCIES);
}

export function buildOmpPluginConfigMutationArgs(input: OmpPluginConfigMutation): string[] {
  return input.action === "set"
    ? ["plugin", "config", "set", input.plugin, input.key, "--json", "--", String(input.value)]
    : ["plugin", "config", "delete", input.plugin, input.key, "--json"];
}

function configValueError(
  setting: OmpPluginConfigSetting,
  value: string | number | boolean,
): string | null {
  if (setting.type === "string") {
    return typeof value === "string" ? null : "This setting requires a string value.";
  }
  if (setting.type === "boolean") {
    return typeof value === "boolean" ? null : "This setting requires a boolean value.";
  }
  if (setting.type === "enum") {
    return typeof value === "string" && setting.enumValues.includes(value)
      ? null
      : "This setting requires one of its documented choices.";
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "This setting requires a finite number.";
  }
  if (setting.minimum !== undefined && value < setting.minimum) {
    return "This setting is below its documented minimum.";
  }
  if (setting.maximum !== undefined && value > setting.maximum) {
    return "This setting is above its documented maximum.";
  }
  return null;
}

export async function mutateOmpPluginConfigWithDependencies(
  input: RpcInput<typeof mutateOmpPluginConfig>,
  dependencies: OmpPluginDependencies,
): Promise<{ ok: boolean; message: string; config: OmpPluginConfigState }> {
  if (!validWorkspaceCwd(input.cwd)) {
    const config = unavailableConfig(input.plugin, "The workspace path is invalid.");
    return { ok: false, message: "The workspace path is invalid.", config };
  }
  const executable = await dependencies.resolveExecutable();
  if (!executable) {
    const config = unavailableConfig(input.plugin, "The OMP executable could not be resolved.");
    return { ok: false, message: "The OMP executable could not be resolved.", config };
  }

  const current = await loadPluginConfig(executable, input.plugin, dependencies, input.cwd);
  const setting = current.settings.find((candidate) => candidate.key === input.key);
  if (!current.available || !setting) {
    return {
      ok: false,
      message: current.available
        ? "OMP does not advertise this plugin setting."
        : "OMP plugin configuration is unavailable.",
      config: current,
    };
  }
  if (input.action === "set" && setting.secret) {
    return {
      ok: false,
      message: "Secret plugin settings cannot be written through process arguments.",
      config: current,
    };
  }
  if (input.action === "set") {
    const invalid = configValueError(setting, input.value);
    if (invalid) return { ok: false, message: invalid, config: current };
  }

  const mutation = await dependencies.runPlugin(
    executable,
    buildOmpPluginConfigMutationArgs(input),
    MUTATION_OUTPUT_LIMIT,
    READ_TIMEOUT_MS,
    input.cwd,
  );
  const config = await loadPluginConfig(executable, input.plugin, dependencies, input.cwd);
  const mutationSucceeded = runSucceeded(mutation);
  const ok = mutationSucceeded && config.available;
  return {
    ok,
    message: !mutationSucceeded
      ? mutationFailure(mutation)
      : !config.available
        ? "Plugin setting changed, but refreshed metadata is unavailable."
        : input.action === "set"
          ? "Plugin setting saved. New OMP sessions use the updated value."
          : "Plugin setting deleted. New OMP sessions use its default or environment fallback.",
    config,
  };
}

export function resolveMutateOmpPluginConfig(
  input: RpcInput<typeof mutateOmpPluginConfig>,
): Promise<{ ok: boolean; message: string; config: OmpPluginConfigState }> {
  return pluginMutationQueue.run(() =>
    mutateOmpPluginConfigWithDependencies(input, DEFAULT_DEPENDENCIES),
  );
}

export function buildOmpPluginMutationArgs(input: OmpPluginMutation): string[] {
  const target = input.action === "install" ? input.source : input.plugin;
  return ["plugin", input.action, target, "--scope", input.scope ?? "user", "--json"];
}

function mutationFailure(result: BoundedRun): string {
  if (result.cleanupFailed) return "OMP plugin process cleanup could not be confirmed.";
  if (result.outcome === "timeout") return "OMP plugin operation timed out.";
  return "OMP rejected the plugin operation.";
}

function mutationSuccess(action: OmpPluginMutation["action"]): string {
  switch (action) {
    case "install":
      return "Plugin installed. New runtime extensions load in the next OMP session.";
    case "enable":
      return "Plugin enabled. New runtime extensions load in the next OMP session.";
    case "disable":
      return "Plugin disabled. Active OMP sessions are unchanged.";
    case "uninstall":
      return "Plugin uninstalled. Active OMP sessions are unchanged.";
    case "upgrade":
      return "Plugin upgraded. New runtime extensions load in the next OMP session.";
  }
}

const pluginMutationQueue = new SerialMutationQueue();

export async function mutateOmpPluginWithDependencies(
  input: RpcInput<typeof mutateOmpPlugin>,
  dependencies: OmpPluginDependencies,
): Promise<{ ok: boolean; message: string; state: OmpPluginState }> {
  if (!validWorkspaceCwd(input.cwd)) {
    const state = unavailableState("The workspace path is invalid.");
    return { ok: false, message: "The workspace path is invalid.", state };
  }
  const executable = await dependencies.resolveExecutable();
  if (!executable) {
    const state = unavailableState("The OMP executable could not be resolved.");
    return { ok: false, message: "The OMP executable could not be resolved.", state };
  }

  if (input.action !== "install") {
    const before = await loadPluginState(executable, dependencies, input.cwd);
    if (!before.available) {
      return { ok: false, message: "OMP plugin state is unavailable.", state: before };
    }
    const matches = before.plugins.filter(
      (plugin) =>
        pluginAliases(plugin).includes(input.plugin) &&
        (input.scope === undefined || plugin.scope === input.scope),
    );
    if (matches.length !== 1 || matches[0]?.ambiguous) {
      return {
        ok: false,
        message: "The plugin target is ambiguous in this scope.",
        state: before,
      };
    }
    if (matches[0]?.scope === "project" && !input.cwd) {
      return {
        ok: false,
        message: "Project-scoped plugin actions require a workspace.",
        state: before,
      };
    }
  }

  const mutation = await dependencies.runPlugin(
    executable,
    buildOmpPluginMutationArgs(input),
    MUTATION_OUTPUT_LIMIT,
    MUTATION_TIMEOUT_MS,
    input.cwd,
  );
  const state = await loadPluginState(executable, dependencies, input.cwd);
  return {
    ok: runSucceeded(mutation),
    message: runSucceeded(mutation) ? mutationSuccess(input.action) : mutationFailure(mutation),
    state,
  };
}

export function resolveMutateOmpPlugin(
  input: RpcInput<typeof mutateOmpPlugin>,
): Promise<{ ok: boolean; message: string; state: OmpPluginState }> {
  return pluginMutationQueue.run(() =>
    mutateOmpPluginWithDependencies(input, DEFAULT_DEPENDENCIES),
  );
}

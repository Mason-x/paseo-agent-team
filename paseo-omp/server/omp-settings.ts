import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import { parseDocument, parse as parseYaml } from "yaml";
import {
  type listOmpSettings,
  OMP_SETTINGS_CATALOG_VERSION,
  type OmpScalarValue,
  type OmpSetting,
  type OmpSettingType,
  OmpSettingTypeSchema,
  type updateOmpSettings,
} from "../shared/omp-settings";
import { SerialMutationQueue } from "./mutation-queue";
import { readOmpConfigFrom } from "./omp-config";
import { currentOmpEnvironment } from "./paths";
import {
  type BoundedRun,
  buildStatefulCommandEnv,
  defaultSpawn,
  resolveExecutablePath,
  runBounded,
} from "./provider-diagnostics";

const MAX_CONFIG_OUTPUT_BYTES = 2 * 1024 * 1024;
const CONFIG_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 1_000;
const WINDOWS_DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const CREDENTIAL_KEY =
  /(?:^|_)(?:API_KEY|ACCESS_KEY|ACCESS_TOKEN|AUTHORIZATION|COOKIE|CREDENTIAL|CREDENTIALS|OAUTH|PASSWORD|PRIVATE_KEY|REFRESH_TOKEN|SECRET|SESSION_TOKEN|TOKEN)(?:$|_)/u;

type OmpSettingRecord = {
  value?: unknown;
  redacted?: unknown;
  type?: unknown;
  description?: unknown;
};

export type ParsedOmpSettings = { settings: OmpSetting[]; droppedCount: number };
type CatalogResult = {
  catalogVersion: typeof OMP_SETTINGS_CATALOG_VERSION;
  available: boolean;
  revision?: string;
  droppedCount: number;
  settings: OmpSetting[];
  path?: string;
  error?: string;
};

export type OmpSettingsUpdateResult = {
  conflict: boolean;
  appliedPaths: string[];
  failed?: { path: string; message: string };
  catalog: CatalogResult;
};

export interface OmpSettingsDependencies {
  resolveExecutable(): Promise<string | null>;
  runConfig(executable: string, args: readonly string[], cwd?: string): Promise<BoundedRun>;
  validateProjectConfig(executable: string, path: string): Promise<BoundedRun>;
}

async function readProjectConfigText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "{}\n";
    throw error;
  }
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

async function writeProjectChanges(
  cwd: string,
  expectedText: string,
  changes: RpcInput<typeof updateOmpSettings>["changes"],
  executable: string,
  dependencies: OmpSettingsDependencies,
): Promise<"applied" | "conflict"> {
  const path = join(cwd, ".omp", "config.yml");
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error("Symlinked workspace OMP configuration cannot be edited through Paseo.");
    }
    if (!metadata.isFile()) throw new Error("Workspace OMP configuration is not a regular file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const snapshot = await readProjectConfigText(path);
  if (snapshot !== expectedText) return "conflict";
  const document = parseDocument(snapshot);
  if (document.errors.length > 0) throw new Error("Workspace OMP configuration is invalid YAML.");
  for (const change of changes) {
    const segments = change.path.split(".");
    if (change.operation === "reset") document.deleteIn(segments);
    else document.setIn(segments, change.value);
  }

  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, document.toString(), { encoding: "utf8", mode: 0o600 });
    const validation = await dependencies.validateProjectConfig(executable, temporaryPath);
    if (!runSucceeded(validation)) {
      throw new Error("OMP rejected the workspace configuration change.");
    }
    if ((await readProjectConfigText(path)) !== snapshot) return "conflict";
    await rename(temporaryPath, path);
    return "applied";
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

function hasConfiguredPath(value: unknown, path: string): boolean {
  let current = value;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return false;
    const record = current as Record<string, unknown>;
    if (!Object.hasOwn(record, segment)) return false;
    current = record[segment];
  }
  return true;
}

async function markWorkspaceOverrides(cwd: string, settings: OmpSetting[]): Promise<OmpSetting[]> {
  const directory = join(cwd, ".omp");
  const sources: unknown[] = [];
  try {
    sources.push(JSON.parse(await readFile(join(directory, "settings.json"), "utf8")) as unknown);
  } catch {
    // Legacy project settings are optional.
  }
  try {
    sources.push(parseYaml(await readFile(join(directory, "config.yml"), "utf8")) as unknown);
  } catch {
    // Canonical project settings are optional.
  }
  if (sources.length === 0) return settings;
  return settings.map((setting) =>
    sources.some((source) => hasConfiguredPath(source, setting.path))
      ? { ...setting, workspaceOverride: true }
      : setting,
  );
}

function isCredentialSetting(path: string, type: OmpSettingType): boolean {
  if (type !== "string" && type !== "record") return false;
  const normalized = path
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .toUpperCase();
  return CREDENTIAL_KEY.test(normalized);
}

export function parseOmpSettingsList(raw: unknown): ParsedOmpSettings {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("OMP returned an invalid settings document");
  }

  const settings: OmpSetting[] = [];
  let droppedCount = 0;
  for (const [path, candidate] of Object.entries(raw)) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      droppedCount += 1;
      continue;
    }
    const entry = candidate as OmpSettingRecord;
    const parsedType = OmpSettingTypeSchema.safeParse(entry.type);
    if (!parsedType.success) {
      droppedCount += 1;
      continue;
    }

    const redacted = entry.redacted === true || isCredentialSetting(path, parsedType.data);
    const configured = redacted && entry.redacted !== true ? entry.value !== undefined : undefined;
    settings.push({
      path,
      type: parsedType.data,
      description: typeof entry.description === "string" ? entry.description : "",
      ...(redacted
        ? { redacted: true, ...(configured === undefined ? {} : { configured }) }
        : { value: entry.value }),
    });
  }
  return { settings, droppedCount };
}

async function resolveOmpExecutable(): Promise<string | null> {
  return resolveExecutablePath(
    currentOmpEnvironment().OMP_COMMAND ?? "omp",
    (currentOmpEnvironment().PATH ?? "").split(delimiter),
    {
      cwd: process.cwd(),
      platform: process.platform,
      pathExt: currentOmpEnvironment().PATHEXT ?? WINDOWS_DEFAULT_PATHEXT,
    },
  );
}

async function runOmpConfig(executable: string, args: readonly string[], cwd = process.cwd()) {
  return runBounded(
    defaultSpawn,
    executable,
    ["config", ...args],
    buildStatefulCommandEnv(currentOmpEnvironment()),
    CONFIG_TIMEOUT_MS,
    KILL_GRACE_MS,
    MAX_CONFIG_OUTPUT_BYTES,
    cwd,
  );
}

async function validateOmpProjectConfig(executable: string, path: string): Promise<BoundedRun> {
  return runBounded(
    defaultSpawn,
    executable,
    ["--config", path, "config", "list", "--json"],
    buildStatefulCommandEnv(currentOmpEnvironment()),
    CONFIG_TIMEOUT_MS,
    KILL_GRACE_MS,
    MAX_CONFIG_OUTPUT_BYTES,
    tmpdir(),
  );
}

const DEFAULT_DEPENDENCIES: OmpSettingsDependencies = {
  resolveExecutable: resolveOmpExecutable,
  runConfig: runOmpConfig,
  validateProjectConfig: validateOmpProjectConfig,
};

async function loadCatalog(
  executable: string | null | undefined,
  dependencies: OmpSettingsDependencies,
  cwd?: string,
): Promise<CatalogResult> {
  const resolved = executable === undefined ? await dependencies.resolveExecutable() : executable;
  if (!resolved) {
    return {
      catalogVersion: OMP_SETTINGS_CATALOG_VERSION,
      available: false,
      droppedCount: 0,
      settings: [],
      error: "The OMP executable could not be resolved.",
    };
  }

  const result = await dependencies.runConfig(resolved, ["list", "--json"], cwd);
  if (result.outcome !== "exited" || result.exitCode !== 0 || result.truncated) {
    return {
      catalogVersion: OMP_SETTINGS_CATALOG_VERSION,
      available: false,
      droppedCount: 0,
      settings: [],
      error:
        result.outcome === "timeout"
          ? "OMP settings discovery timed out."
          : "OMP settings discovery failed.",
    };
  }

  let path: string | undefined;
  const pathResult = await dependencies.runConfig(resolved, ["path"], cwd);
  const agentDir =
    pathResult.outcome === "exited" && pathResult.exitCode === 0 ? pathResult.stdout.trim() : "";
  if (agentDir && isAbsolute(agentDir) && !agentDir.includes("\0")) {
    path = (await readOmpConfigFrom(agentDir)).path;
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    const catalog = parseOmpSettingsList(parsed);
    const projectPath = cwd ? join(cwd, ".omp", "config.yml") : null;
    const projectText = projectPath ? await readProjectConfigText(projectPath) : "";
    const revision = createHash("sha256").update(result.stdout).update(projectText).digest("hex");
    return {
      catalogVersion: OMP_SETTINGS_CATALOG_VERSION,
      available: true,
      revision,
      droppedCount: catalog.droppedCount,
      ...(projectPath ? { path: projectPath } : path ? { path } : {}),
      settings: cwd ? await markWorkspaceOverrides(cwd, catalog.settings) : catalog.settings,
    };
  } catch {
    return {
      catalogVersion: OMP_SETTINGS_CATALOG_VERSION,
      available: false,
      droppedCount: 0,
      settings: [],
      error: "OMP returned invalid settings metadata.",
    };
  }
}

function serializeScalar(type: OmpSettingType, value: OmpScalarValue): string | null {
  if (type === "boolean") return typeof value === "boolean" ? String(value) : null;
  if (type === "number")
    return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
  if (type === "string" || type === "enum") return typeof value === "string" ? value : null;
  return null;
}

export async function listOmpSettingsWithDependencies(
  input: RpcInput<typeof listOmpSettings>,
  dependencies: OmpSettingsDependencies,
): Promise<CatalogResult> {
  if (input.cwd && (!isAbsolute(input.cwd) || input.cwd.includes("\0"))) {
    return {
      catalogVersion: OMP_SETTINGS_CATALOG_VERSION,
      available: false,
      droppedCount: 0,
      settings: [],
      error: "The workspace path is invalid.",
    };
  }
  return loadCatalog(undefined, dependencies, input.cwd);
}

export async function resolveListOmpSettings(
  input: RpcInput<typeof listOmpSettings>,
): Promise<CatalogResult> {
  return listOmpSettingsWithDependencies(input, DEFAULT_DEPENDENCIES);
}

export async function updateOmpSettingsWithDependencies(
  input: RpcInput<typeof updateOmpSettings>,
  dependencies: OmpSettingsDependencies,
): Promise<OmpSettingsUpdateResult> {
  if (input.cwd && (!isAbsolute(input.cwd) || input.cwd.includes("\0"))) {
    return {
      conflict: false,
      appliedPaths: [],
      failed: { path: "configuration", message: "The workspace path is invalid." },
      catalog: {
        catalogVersion: OMP_SETTINGS_CATALOG_VERSION,
        available: false,
        droppedCount: 0,
        settings: [],
        error: "The workspace path is invalid.",
      },
    };
  }
  const executable = await dependencies.resolveExecutable();
  const current = await loadCatalog(executable, dependencies, input.cwd);
  if (!executable || !current.available || !current.revision) {
    return {
      conflict: false,
      appliedPaths: [],
      failed: {
        path: input.changes[0]?.path ?? "configuration",
        message: current.error ?? "OMP settings are unavailable.",
      },
      catalog: current,
    };
  }
  if (current.revision !== input.revision) {
    return { conflict: true, appliedPaths: [], catalog: current };
  }
  const byPath = new Map(current.settings.map((setting) => [setting.path, setting]));
  if (input.cwd) {
    for (const change of input.changes) {
      const setting = byPath.get(change.path);
      if (
        !setting ||
        setting.redacted ||
        !["boolean", "number", "string", "enum"].includes(setting.type)
      ) {
        return {
          conflict: false,
          appliedPaths: [],
          failed: {
            path: change.path,
            message: "This setting cannot be edited as a workspace scalar value.",
          },
          catalog: current,
        };
      }
      if (change.operation === "set" && serializeScalar(setting.type, change.value) === null) {
        return {
          conflict: false,
          appliedPaths: [],
          failed: { path: change.path, message: `Expected a ${setting.type} value.` },
          catalog: current,
        };
      }
    }

    const projectPath = join(input.cwd, ".omp", "config.yml");
    const beforeValidation = await readProjectConfigText(projectPath);
    const verified = await loadCatalog(executable, dependencies, input.cwd);
    const afterValidation = await readProjectConfigText(projectPath);
    if (verified.revision !== input.revision || beforeValidation !== afterValidation) {
      return { conflict: true, appliedPaths: [], catalog: verified };
    }
    try {
      const outcome = await writeProjectChanges(
        input.cwd,
        afterValidation,
        input.changes,
        executable,
        dependencies,
      );
      if (outcome === "conflict") {
        return {
          conflict: true,
          appliedPaths: [],
          catalog: await loadCatalog(executable, dependencies, input.cwd),
        };
      }
    } catch (error) {
      return {
        conflict: false,
        appliedPaths: [],
        failed: {
          path: input.changes[0]?.path ?? "configuration",
          message: error instanceof Error ? error.message : "Could not update workspace settings.",
        },
        catalog: await loadCatalog(executable, dependencies, input.cwd),
      };
    }
    return {
      conflict: false,
      appliedPaths: input.changes.map((change) => change.path),
      catalog: await loadCatalog(executable, dependencies, input.cwd),
    };
  }
  const appliedPaths: string[] = [];
  for (const change of input.changes) {
    const setting = byPath.get(change.path);
    if (
      !setting ||
      setting.redacted ||
      !["boolean", "number", "string", "enum"].includes(setting.type)
    ) {
      return {
        conflict: false,
        appliedPaths,
        failed: { path: change.path, message: "This setting cannot be edited as a scalar value." },
        catalog: await loadCatalog(executable, dependencies, input.cwd),
      };
    }
    let args: string[] | null;
    if (change.operation === "reset") {
      args = ["reset", change.path];
    } else {
      const value = serializeScalar(setting.type, change.value);
      args = value === null ? null : ["set", change.path, "--json", "--", value];
    }
    if (!args) {
      return {
        conflict: false,
        appliedPaths,
        failed: { path: change.path, message: `Expected a ${setting.type} value.` },
        catalog: appliedPaths.length
          ? await loadCatalog(executable, dependencies, input.cwd)
          : current,
      };
    }
    const result = await dependencies.runConfig(executable, args, input.cwd);
    if (result.outcome !== "exited" || result.exitCode !== 0) {
      return {
        conflict: false,
        appliedPaths,
        failed: { path: change.path, message: "OMP rejected this setting change." },
        catalog: await loadCatalog(executable, dependencies, input.cwd),
      };
    }
    appliedPaths.push(change.path);
  }

  return {
    conflict: false,
    appliedPaths,
    catalog: await loadCatalog(executable, dependencies, input.cwd),
  };
}

const settingsMutationQueue = new SerialMutationQueue();

export function resolveUpdateOmpSettings(
  input: RpcInput<typeof updateOmpSettings>,
): Promise<OmpSettingsUpdateResult> {
  return settingsMutationQueue.run(() =>
    updateOmpSettingsWithDependencies(input, DEFAULT_DEPENDENCIES),
  );
}

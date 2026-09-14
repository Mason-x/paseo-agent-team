import { createHash } from "node:crypto";
import { delimiter, isAbsolute } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
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
  runConfig(executable: string, args: readonly string[]): Promise<BoundedRun>;
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
    process.env.OMP_COMMAND ?? "omp",
    (process.env.PATH ?? "").split(delimiter),
    {
      cwd: process.cwd(),
      platform: process.platform,
      pathExt: process.env.PATHEXT ?? WINDOWS_DEFAULT_PATHEXT,
    },
  );
}

async function runOmpConfig(executable: string, args: readonly string[]) {
  return runBounded(
    defaultSpawn,
    executable,
    ["config", ...args],
    buildStatefulCommandEnv(process.env),
    CONFIG_TIMEOUT_MS,
    KILL_GRACE_MS,
    MAX_CONFIG_OUTPUT_BYTES,
    process.cwd(),
  );
}

const DEFAULT_DEPENDENCIES: OmpSettingsDependencies = {
  resolveExecutable: resolveOmpExecutable,
  runConfig: runOmpConfig,
};

async function loadCatalog(
  executable: string | null | undefined,
  dependencies: OmpSettingsDependencies,
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

  const result = await dependencies.runConfig(resolved, ["list", "--json"]);
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
  const pathResult = await dependencies.runConfig(resolved, ["path"]);
  const agentDir =
    pathResult.outcome === "exited" && pathResult.exitCode === 0 ? pathResult.stdout.trim() : "";
  if (agentDir && isAbsolute(agentDir) && !agentDir.includes("\0")) {
    path = (await readOmpConfigFrom(agentDir)).path;
  }

  try {
    const parsed: unknown = JSON.parse(result.stdout);
    const catalog = parseOmpSettingsList(parsed);
    return {
      catalogVersion: OMP_SETTINGS_CATALOG_VERSION,
      available: true,
      revision: createHash("sha256").update(result.stdout).digest("hex"),
      droppedCount: catalog.droppedCount,
      ...(path ? { path } : {}),
      settings: catalog.settings,
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
  _input: RpcInput<typeof listOmpSettings>,
  dependencies: OmpSettingsDependencies,
): Promise<CatalogResult> {
  return loadCatalog(undefined, dependencies);
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
  const executable = await dependencies.resolveExecutable();
  const current = await loadCatalog(executable, dependencies);
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
        catalog: await loadCatalog(executable, dependencies),
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
        catalog: appliedPaths.length ? await loadCatalog(executable, dependencies) : current,
      };
    }
    const result = await dependencies.runConfig(executable, args);
    if (result.outcome !== "exited" || result.exitCode !== 0) {
      return {
        conflict: false,
        appliedPaths,
        failed: { path: change.path, message: "OMP rejected this setting change." },
        catalog: await loadCatalog(executable, dependencies),
      };
    }
    appliedPaths.push(change.path);
  }

  return {
    conflict: false,
    appliedPaths,
    catalog: await loadCatalog(executable, dependencies),
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

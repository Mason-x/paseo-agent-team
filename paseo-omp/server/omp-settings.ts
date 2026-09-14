import { delimiter } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import {
  type listOmpSettings,
  OMP_SETTINGS_CATALOG_VERSION,
  type OmpSetting,
  type OmpSettingType,
  OmpSettingTypeSchema,
} from "../shared/omp-settings";
import {
  buildProbeEnv,
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

export async function resolveListOmpSettings(_input: RpcInput<typeof listOmpSettings>): Promise<{
  catalogVersion: typeof OMP_SETTINGS_CATALOG_VERSION;
  available: boolean;
  droppedCount: number;
  settings: OmpSetting[];
  error?: string;
}> {
  const command = process.env.OMP_COMMAND ?? "omp";
  const cwd = process.cwd();
  const executable = await resolveExecutablePath(
    command,
    (process.env.PATH ?? "").split(delimiter),
    {
      cwd,
      platform: process.platform,
      pathExt: process.env.PATHEXT ?? WINDOWS_DEFAULT_PATHEXT,
    },
  );
  if (!executable) {
    return {
      catalogVersion: OMP_SETTINGS_CATALOG_VERSION,
      available: false,
      droppedCount: 0,
      settings: [],
      error: "The OMP executable could not be resolved.",
    };
  }

  const result = await runBounded(
    defaultSpawn,
    executable,
    ["config", "list", "--json"],
    buildProbeEnv(process.env),
    CONFIG_TIMEOUT_MS,
    KILL_GRACE_MS,
    MAX_CONFIG_OUTPUT_BYTES,
    cwd,
  );
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

  try {
    const parsed: unknown = JSON.parse(result.stdout);
    const catalog = parseOmpSettingsList(parsed);
    return {
      catalogVersion: OMP_SETTINGS_CATALOG_VERSION,
      available: true,
      droppedCount: catalog.droppedCount,
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

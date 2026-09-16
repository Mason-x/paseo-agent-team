import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isOmpProfileName, type OmpStore, OmpStoreSchema } from "../shared/omp-store";

const MAX_SETTINGS_BYTES = 64 * 1024;
const storeContext = new AsyncLocalStorage<OmpStore>();
const ServerOmpStoreSchema = OmpStoreSchema.refine(
  (store) => !store.agentDir || isAbsolute(store.agentDir),
  "OMP agent directory must be absolute on the server platform",
);

export function withOmpStore<T>(store: OmpStore | undefined, operation: () => T): T {
  return storeContext.run(ServerOmpStoreSchema.parse(store ?? {}), operation);
}

/** Per-request selection, never process.env mutation: concurrent profiles stay isolated. */
export function currentOmpEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const store = storeContext.getStore();
  if (!store?.profile && !store?.agentDir) return source;
  const environment = { ...source };
  for (const name of [
    "PASEO_OMP_AGENT_DIR",
    "OMP_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "OMP_SESSION_DIR",
    "PI_CODING_AGENT_SESSION_DIR",
    "OMP_PROFILE",
    "PI_PROFILE",
    "PI_CONFIG_FILES",
  ])
    delete environment[name];
  if (store.profile) environment.OMP_PROFILE = store.profile;
  else if (store.agentDir) {
    environment.PI_CODING_AGENT_DIR = store.agentDir;
  }
  return environment;
}

type OmpStorageKind = "data" | "state" | "cache";

const XDG_HOME_BY_KIND: Record<OmpStorageKind, string> = {
  data: "XDG_DATA_HOME",
  state: "XDG_STATE_HOME",
  cache: "XDG_CACHE_HOME",
};

function ompProfile(environment: NodeJS.ProcessEnv): string | undefined {
  const raw =
    environment.OMP_PROFILE !== undefined ? environment.OMP_PROFILE : environment.PI_PROFILE;
  const profile = raw?.trim();
  if (!profile || profile === "default") return;
  if (!isOmpProfileName(profile)) throw new Error("Invalid OMP profile name");
  return profile;
}

function defaultOmpAgentDir(environment: NodeJS.ProcessEnv, profile?: string): string {
  const home = environment.HOME ?? environment.USERPROFILE ?? homedir();
  return profile
    ? join(home, environment.PI_CONFIG_DIR || ".omp", "profiles", profile, "agent")
    : join(home, environment.PI_CONFIG_DIR || ".omp", "agent");
}

function explicitOmpAgentDir(
  environment: NodeJS.ProcessEnv,
  profile: string | undefined,
): string | undefined {
  const pluginOverride = environment.PASEO_OMP_AGENT_DIR ?? environment.OMP_AGENT_DIR;
  if (pluginOverride) return pluginOverride;
  // OMP deliberately ignores PI_CODING_AGENT_DIR while a named profile is active.
  if (profile) return;
  const override = environment.PI_CODING_AGENT_DIR;
  const inheritedProfile = environment.PI_PROFILE?.trim();
  // OMP_PROFILE=""/"default" overrides PI_PROFILE, including an agent path
  // propagated by the parent profile. Such a path is not a custom default store.
  if (
    inheritedProfile &&
    isOmpProfileName(inheritedProfile) &&
    override === defaultOmpAgentDir(environment, inheritedProfile)
  )
    return;
  return override ? resolve(override) : undefined;
}

/** OMP's configuration agent directory. Data/state/cache may use XDG-specific roots. */
export function ompAgentDir(environment: NodeJS.ProcessEnv = currentOmpEnvironment()): string {
  const profile = ompProfile(environment);
  return explicitOmpAgentDir(environment, profile) ?? defaultOmpAgentDir(environment, profile);
}

function ompStorageDir(
  kind: OmpStorageKind,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const profile = ompProfile(environment);
  const agentDir = ompAgentDir(environment);
  if (
    agentDir !== defaultOmpAgentDir(environment, profile) ||
    (platform !== "linux" && platform !== "darwin")
  ) {
    return agentDir;
  }
  const xdgHome = environment[XDG_HOME_BY_KIND[kind]];
  if (!xdgHome) return agentDir;
  const root = profile ? join(xdgHome, "omp", "profiles", profile) : join(xdgHome, "omp");
  return existsSync(root) ? root : agentDir;
}

export function ompDataDir(
  environment: NodeJS.ProcessEnv = currentOmpEnvironment(),
  platform: NodeJS.Platform = process.platform,
): string {
  return ompStorageDir("data", environment, platform);
}

export function ompCacheDir(
  environment: NodeJS.ProcessEnv = currentOmpEnvironment(),
  platform: NodeJS.Platform = process.platform,
): string {
  return ompStorageDir("cache", environment, platform);
}

export function ompStateDir(
  environment: NodeJS.ProcessEnv = currentOmpEnvironment(),
  platform: NodeJS.Platform = process.platform,
): string {
  return ompStorageDir("state", environment, platform);
}

function configuredSessionDir(agentDir: string): string | undefined {
  for (const settingsPath of [
    join(agentDir, "settings.json"),
    join(agentDir, "..", "settings.json"),
  ]) {
    let descriptor: number;
    try {
      descriptor = openSync(
        settingsPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
    } catch {
      continue;
    }
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) continue;
      const buffer = Buffer.allocUnsafe(stat.size);
      const length = readSync(descriptor, buffer, 0, buffer.length, 0);
      const parsed: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)),
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const value = (parsed as Record<string, unknown>).sessionDir;
      if (
        typeof value !== "string" ||
        !value ||
        value.includes("\0") ||
        Buffer.byteLength(value) > 4_096
      )
        continue;
      return isAbsolute(value) ? value : resolve(dirname(settingsPath), value);
    } catch {
    } finally {
      closeSync(descriptor);
    }
  }
  return;
}

/** OMP's effective session root, honoring its documented environment and settings precedence. */
export function ompSessionDir(
  environment: NodeJS.ProcessEnv = currentOmpEnvironment(),
  platform: NodeJS.Platform = process.platform,
): string {
  const explicit = environment.OMP_SESSION_DIR ?? environment.PI_CODING_AGENT_SESSION_DIR;
  if (explicit) return resolve(explicit);
  const agentDir = ompAgentDir(environment);
  return configuredSessionDir(agentDir) ?? join(ompDataDir(environment, platform), "sessions");
}

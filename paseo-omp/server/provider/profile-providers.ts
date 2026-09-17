import { type Dir, opendirSync } from "node:fs";
import { opendir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { isOmpProfileName } from "../../shared/omp-store";
import { ompAgentDir, ompCacheDir, ompDataDir, ompSessionDir, ompStateDir } from "../paths";
import { OmpRpcRuntime, type OmpRuntime, type OmpStartOptions } from "./omp-rpc";
import { parseOmpProviderOptions } from "./provider-options";
import { createOmpProvider, type OmpProviderOptions } from "./registration";
import { OmpPublicError } from "./security";

const MAX_PROFILES = 128;
const MAX_DIRECTORY_ENTRIES = 4_096;
const STORE_ENV_NAMES: Readonly<Record<string, true>> = {
  OMP_PROFILE: true,
  PI_PROFILE: true,
  PASEO_OMP_AGENT_DIR: true,
  OMP_AGENT_DIR: true,
  PI_CODING_AGENT_DIR: true,
  OMP_SESSION_DIR: true,
  PI_CODING_AGENT_SESSION_DIR: true,
  PI_CONFIG_FILES: true,
};
const PROFILE_OVERRIDE_ENV_NAMES: Readonly<Record<string, true>> = {
  ...STORE_ENV_NAMES,
  PI_CONFIG_DIR: true,
  HOME: true,
  USERPROFILE: true,
  XDG_DATA_HOME: true,
  XDG_STATE_HOME: true,
  XDG_CACHE_HOME: true,
};

function validateProfile(profile: string): void {
  if (!isOmpProfileName(profile)) throw new OmpPublicError("Invalid named OMP profile");
}

function profileDirectory(environment: NodeJS.ProcessEnv): string {
  return join(
    environment.HOME ?? environment.USERPROFILE ?? homedir(),
    environment.PI_CONFIG_DIR || ".omp",
    "profiles",
  );
}

/** Paseo 0.8 contribution registration is synchronous; inspect directory names only. */
export function discoverOmpProfilesSync(environment: NodeJS.ProcessEnv = process.env): string[] {
  let directory: Dir;
  try {
    directory = opendirSync(profileDirectory(environment));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new OmpPublicError("OMP profile directory could not be read");
  }
  const profiles: string[] = [];
  let count = 0;
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (++count > MAX_DIRECTORY_ENTRIES)
        throw new OmpPublicError("OMP profile directory is too large");
      if (entry.isDirectory() && isOmpProfileName(entry.name)) profiles.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return profiles.sort().slice(0, MAX_PROFILES);
}

/** Enumerate names only; never open profile configuration, databases, or credential files. */
export async function discoverOmpProfiles(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  let directory: Dir;
  try {
    directory = await opendir(profileDirectory(environment));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new OmpPublicError("OMP profile directory could not be read");
  }
  const profiles: string[] = [];
  let count = 0;
  for await (const entry of directory) {
    if (++count > MAX_DIRECTORY_ENTRIES) {
      throw new OmpPublicError("OMP profile directory is too large");
    }
    if (entry.isDirectory() && isOmpProfileName(entry.name)) profiles.push(entry.name);
  }
  return profiles.sort().slice(0, MAX_PROFILES);
}

export function profileProviderId(profile: string): string {
  validateProfile(profile);
  return `omp-plugin-${profile}`;
}

function fixedEnvironment(profile: string, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const name of Object.keys(environment)) {
    if (STORE_ENV_NAMES[name.toUpperCase()]) delete environment[name];
  }
  environment.OMP_PROFILE = profile;
  environment.PI_CODING_AGENT_DIR = join(profileDirectory(source), profile, "agent");
  return environment;
}

function profileCommand(
  command: readonly string[],
  profile: string,
  sessionDir: string,
): readonly string[] {
  // Environment-control flags can erase or replace the fixed profile/config/XDG
  // roots before OMP sees --profile. Allow plain assignment wrappers, not env's
  // -i, -u, -S, -C (or their long forms), including wrappers nested after `--`.
  for (let index = 0; index < command.length; index += 1) {
    const executable = basename(command[index]).toLowerCase();
    if (executable !== "env" && executable !== "env.exe") continue;
    for (const argument of command.slice(index + 1)) {
      if (argument === "--") break;
      if (argument.startsWith("-"))
        throw new OmpPublicError("OMP profile command cannot alter its environment with env flags");
      if (!/^[A-Za-z_][A-Za-z0-9_]*=/u.test(argument)) break;
    }
  }
  let hasProfile = false;
  for (let index = 1; index < command.length; index += 1) {
    const argument = command[index];
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(argument);
    if (assignment && PROFILE_OVERRIDE_ENV_NAMES[assignment[1].toUpperCase()]) {
      throw new OmpPublicError("OMP profile command cannot override its selected store");
    }
    if (argument === "--profile" || argument.startsWith("--profile=")) {
      const selected = argument === "--profile" ? command[++index] : argument.slice(10);
      if (selected !== profile) {
        throw new OmpPublicError("OMP command profile conflicts with the selected provider");
      }
      hasProfile = true;
    } else if (argument === "--session-dir" || argument.startsWith("--session-dir=")) {
      const selected = argument === "--session-dir" ? command[++index] : argument.slice(14);
      if (!selected || resolve(selected) !== sessionDir) {
        throw new OmpPublicError(
          "OMP command session directory conflicts with the selected profile",
        );
      }
    }
  }
  return hasProfile ? command : [...command, "--profile", profile];
}

/** Each provider owns one profile before the host requests a catalog or creates an agent. */
export function createProfileOmpProvider(profile: string, options: OmpProviderOptions = {}) {
  const id = profileProviderId(profile);
  const environment = fixedEnvironment(profile, options.environment ?? process.env);
  const sessionDir = resolve(ompSessionDir(environment));
  const runtime = options.runtime ?? new OmpRpcRuntime({ environment });
  const readPersistedSessionTranscript = runtime.readPersistedSessionTranscript?.bind(runtime);
  const assertSessionDir = (requested?: string) => {
    if (requested !== undefined && resolve(requested) !== sessionDir) {
      throw new OmpPublicError("OMP session directory conflicts with the selected profile");
    }
  };
  const assertEnvironment = (sessionEnv?: Readonly<Record<string, string>>) => {
    for (const name of Object.keys(sessionEnv ?? {})) {
      if (PROFILE_OVERRIDE_ENV_NAMES[name.toUpperCase()]) {
        throw new OmpPublicError("OMP session environment cannot override its selected profile");
      }
    }
  };
  const scopedRuntime: OmpRuntime = {
    get supportsPersistence() {
      return runtime.supportsPersistence;
    },
    async startSession(start: OmpStartOptions) {
      assertSessionDir(start.sessionDir);
      assertEnvironment(start.env);
      return runtime.startSession({
        ...start,
        command: profileCommand(
          start.command ?? [environment.OMP_COMMAND ?? "omp"],
          profile,
          sessionDir,
        ),
        environment,
        sessionDir,
      });
    },
    async listSessions(listOptions) {
      assertSessionDir(listOptions.sessionDir);
      return runtime.listSessions({ ...listOptions, sessionDir });
    },
    ...(readPersistedSessionTranscript
      ? {
          readPersistedSessionTranscript(input) {
            return readPersistedSessionTranscript(input);
          },
        }
      : {}),
    readPersistedSubagentTranscript(input) {
      return runtime.readPersistedSubagentTranscript(input);
    },
  };
  const provider = createOmpProvider({
    ...options,
    runtime: scopedRuntime,
    environment,
    catalogIdentity: {
      profile,
      agentRoot: ompAgentDir(environment),
      dataRoot: ompDataDir(environment),
      cacheRoot: ompCacheDir(environment),
      stateRoot: ompStateDir(environment),
      sessionRoot: sessionDir,
    },
  });
  const validateCatalog = (
    input: Parameters<NonNullable<typeof provider.getCatalogCacheKey>>[0],
  ) => {
    const parsed = parseOmpProviderOptions(input.providerOptions);
    assertEnvironment(parsed.env);
    assertSessionDir(parsed.params?.sessionDir);
    return profileCommand(
      parsed.command ?? [environment.OMP_COMMAND ?? "omp"],
      profile,
      sessionDir,
    );
  };
  return {
    ...provider,
    async getCatalogCacheKey(
      input: Parameters<NonNullable<typeof provider.getCatalogCacheKey>>[0],
    ) {
      validateCatalog(input);
      return provider.getCatalogCacheKey?.(input);
    },
    async checkAvailability(
      input: Parameters<NonNullable<typeof provider.checkAvailability>>[0],
      context?: Parameters<NonNullable<typeof provider.checkAvailability>>[1],
    ) {
      const command = validateCatalog(input);
      if (!provider.checkAvailability)
        throw new OmpPublicError("OMP availability probe is unavailable");
      return provider.checkAvailability(
        { ...input, providerOptions: { ...input.providerOptions, command } },
        context,
      );
    },
    id,
    label: `OMP · ${profile}`,
  };
}

import type { ZodType } from "zod";
import {
  MODE_CONTRACT_VERSION,
  type ModeContractSupport,
  modeMinContract,
} from "../../shared/domain/mode-contract";
import type {
  DesignMarkSavedInput,
  DesignMarkSavedOutput,
  DesignPrepareSaveInput,
  DesignPrepareSaveOutput,
  DesignSaveFailedInput,
  DesignSaveFailedOutput,
  DesignStartInput,
} from "../../shared/schemas/design";
import type { Preferences } from "../../shared/schemas/preferences";
import { PreferencesSchema } from "../../shared/schemas/preferences";
import type { TeamMode } from "../../shared/schemas/team-mode";
import {
  type RolesDocument,
  RolesDocumentSchema,
  type TeamsDocument,
  TeamsDocumentSchema,
} from "../../shared/settings";
import { designZh } from "../../shared/zh/design";

/**
 * What the capability probe (`team.plan` with no items) said about the host. Only an explicit
 * `"v2"` lets the designer speak contract 2; anything else is the baseline contract, so a new App
 * never sends a daemon fields its strict input schemas would reject.
 */
export type DesignModeContract = ModeContractSupport;

/** `contractVersion: 2` for a confirmed v2 host; nothing at all otherwise. */
export function designContractFields(support: DesignModeContract): { contractVersion?: 2 } {
  return support === "v2" ? { contractVersion: MODE_CONTRACT_VERSION } : {};
}

/**
 * One place that puts the contract on any of the eight design RPC inputs. A confirmed v2 host
 * gets `contractVersion: 2` (replacing whatever the caller put there). Anything else gets the
 * baseline shape: a `contractVersion` or `existingRolesOnly` already on the input is removed, so a
 * caller that built a v2-shaped input can never reach a baseline daemon's strict schema with it.
 */
export function withDesignContract<T extends object>(
  input: T,
  support: DesignModeContract,
): Omit<T, "contractVersion" | "existingRolesOnly"> & { contractVersion?: 2 } {
  const {
    contractVersion: _contract,
    existingRolesOnly: _rule,
    ...rest
  } = input as T & {
    contractVersion?: unknown;
    existingRolesOnly?: unknown;
  };
  if (support === "v2") {
    // v2 keeps an explicit rule when the caller supplied one (start); other inputs have none.
    const keepRule = "existingRolesOnly" in input ? { existingRolesOnly: _rule } : {};
    return { ...rest, ...keepRule, ...designContractFields(support) } as never;
  }
  return rest as never;
}

/**
 * Start input for the host's contract. A v2 host gets the contract and the explicit rule (the
 * default is true, never omitted); a baseline host gets neither new field, because its strict
 * input schema would refuse them and the rule does not exist there.
 */
export function prepareDesignStartInput(
  input: DesignStartInput,
  support: DesignModeContract,
): DesignStartInput {
  if (support === "v2") {
    return {
      ...input,
      existingRolesOnly: input.existingRolesOnly !== false,
      ...designContractFields(support),
    };
  }
  const { existingRolesOnly: _rule, contractVersion: _contract, ...baseline } = input;
  return baseline;
}

/** True when the draft's mode cannot be requested from a host that is not confirmed as v2. */
export function designModeNeedsV2(mode: TeamMode, support: DesignModeContract): boolean {
  return support !== "v2" && modeMinContract(mode) > 1;
}

/** The host's settings write answer, before transport failures are folded in. */
export type DesignWriteResult = "saved" | "conflict" | "invalid" | "failed";

/**
 * `values` is the parsed document used for merge decisions; `raw` is the exact JSON read from the
 * host. Saves must start from `raw` so unrelated rows, schema defaults, and unknown extension keys
 * are written back untouched.
 */
export type DesignSettingsSnapshot<Values> =
  | { status: "ready"; values: Values; raw: unknown; revision: string }
  | { status: "invalid"; error: string };

export type SettingsReadReply =
  | { status: "ready"; revision: string; values: unknown }
  | { status: "invalid"; revision: string; error: string };

export type SettingsWriteReply =
  | { status: "saved"; revision: string; values: unknown }
  | { status: "conflict"; error: string }
  | { status: "invalid"; error: string };

type SettingsReader = () => Promise<SettingsReadReply>;

export type SettingsWriter = {
  // Raw JSON document, not a schema-parsed value: unknown keys and absent defaults must survive.
  write(values: unknown, revision: string): Promise<SettingsWriteReply>;
  reload(): Promise<void>;
};

/**
 * The save-specific settings/RPC seam. Values and their revision always come from the same read;
 * a hook's rendered state never substitutes for a fresh read here.
 */
export type DesignSaveGateway = {
  readRoles(): Promise<DesignSettingsSnapshot<RolesDocument>>;
  readTeams(): Promise<DesignSettingsSnapshot<TeamsDocument>>;
  readPreferences(): Promise<DesignSettingsSnapshot<Preferences>>;
  saveRoles(values: unknown, revision: string): Promise<DesignWriteResult>;
  saveTeams(values: unknown, revision: string): Promise<DesignWriteResult>;
  prepareSave(input: DesignPrepareSaveInput): Promise<DesignPrepareSaveOutput>;
  markSaved(input: DesignMarkSavedInput): Promise<DesignMarkSavedOutput>;
  saveFailed(input: DesignSaveFailedInput): Promise<DesignSaveFailedOutput>;
  reloadRoles(): Promise<void>;
  reloadTeams(): Promise<void>;
};

function parseError(error: { issues: readonly { message: string }[] }): string {
  return error.issues.map((entry) => entry.message).join("\n") || designZh.settingsInvalid;
}

async function snapshot<Values>(
  read: SettingsReader,
  schema: ZodType<Values>,
): Promise<DesignSettingsSnapshot<Values>> {
  try {
    const reply = await read();
    if (reply.status !== "ready") {
      return { status: "invalid", error: reply.error || designZh.settingsInvalid };
    }
    const parsed = schema.safeParse(reply.values);
    if (!parsed.success) return { status: "invalid", error: parseError(parsed.error) };
    return {
      status: "ready",
      values: parsed.data,
      raw: reply.values,
      revision: reply.revision,
    };
  } catch {
    return { status: "invalid", error: designZh.settingsInvalid };
  }
}

async function write(
  writer: SettingsWriter,
  values: unknown,
  revision: string,
): Promise<DesignWriteResult> {
  try {
    const reply = await writer.write(values, revision);
    return reply.status;
  } catch {
    // The host may still have committed; the service reads back instead of retrying blindly.
    return "failed";
  }
}

/**
 * Build the gateway from the current host's settings RPCs and design RPCs. Callers create one
 * instance per save run; nothing here consults a global or a later-rendered host.
 */
export function createDesignSaveGateway(input: {
  readRoles: SettingsReader;
  readTeams: SettingsReader;
  readPreferences: SettingsReader;
  roles: SettingsWriter;
  teams: SettingsWriter;
  prepareSave(input: DesignPrepareSaveInput): Promise<DesignPrepareSaveOutput>;
  markSaved(input: DesignMarkSavedInput): Promise<DesignMarkSavedOutput>;
  saveFailed(input: DesignSaveFailedInput): Promise<DesignSaveFailedOutput>;
}): DesignSaveGateway {
  return {
    readRoles: () => snapshot(input.readRoles, RolesDocumentSchema),
    readTeams: () => snapshot(input.readTeams, TeamsDocumentSchema),
    readPreferences: () => snapshot(input.readPreferences, PreferencesSchema),
    saveRoles: (values, revision) => write(input.roles, values, revision),
    saveTeams: (values, revision) => write(input.teams, values, revision),
    prepareSave: input.prepareSave,
    markSaved: input.markSaved,
    saveFailed: input.saveFailed,
    reloadRoles: input.roles.reload,
    reloadTeams: input.teams.reload,
  };
}

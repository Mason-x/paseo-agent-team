import type { ZodType } from "zod";
import type {
  DesignMarkSavedInput,
  DesignMarkSavedOutput,
  DesignPrepareSaveInput,
  DesignPrepareSaveOutput,
  DesignSaveFailedInput,
  DesignSaveFailedOutput,
} from "../../shared/schemas/design";
import type { Preferences } from "../../shared/schemas/preferences";
import { PreferencesSchema } from "../../shared/schemas/preferences";
import {
  type RolesDocument,
  RolesDocumentSchema,
  type TeamsDocument,
  TeamsDocumentSchema,
} from "../../shared/settings";
import { designZh } from "../../shared/zh/design";

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

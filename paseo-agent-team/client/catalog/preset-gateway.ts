import { toJsonValue } from "../../shared/json";
import type {
  DefaultCatalogPreviewInput,
  DefaultCatalogPreviewResult,
} from "../../shared/schemas/default-catalog";
import type { Preferences } from "../../shared/schemas/preferences";
import { PreferencesSchema } from "../../shared/schemas/preferences";
import type { RolesDocument } from "../../shared/settings";
import { RolesDocumentSchema } from "../../shared/settings";
import { zh } from "../../shared/zh";
import type { PresetGateway, SettingsSnapshot, WriteResult } from "./preset-service";

type ReadResult = {
  status: "ready" | "invalid";
  revision: string;
  values?: unknown;
  error?: string;
};

type Reader = (input: Record<string, never>) => Promise<ReadResult>;

type Writer<Values> = {
  write(values: Values, revision: string): Promise<WriteResult>;
  reload(): Promise<void>;
};

/** Wraps the RPC and settings hooks into the small gateway the import/sync flows test against. */
export function createPresetGateway(input: {
  preview: (values: DefaultCatalogPreviewInput) => Promise<DefaultCatalogPreviewResult>;
  readRoles: Reader;
  readPreferences: Reader;
  roles: Writer<RolesDocument>;
  preferences: Writer<Preferences>;
}): PresetGateway {
  async function read<Values>(
    reader: Reader,
    parse: (value: unknown) => { success: true; data: Values } | { success: false; error: string },
  ): Promise<SettingsSnapshot<Values>> {
    const result = await reader({});
    if (result.status !== "ready") {
      return { status: "invalid", error: result.error ?? zh.defaultPresetsSettingsUnavailable };
    }
    const parsed = parse(result.values);
    if (!parsed.success) return { status: "invalid", error: parsed.error };
    return { status: "ready", values: parsed.data, revision: result.revision };
  }

  return {
    preview: (allowUnboundOnProfileError) => input.preview({ allowUnboundOnProfileError }),
    readRoles: () =>
      read(input.readRoles, (value) => {
        const parsed = RolesDocumentSchema.safeParse(value);
        return parsed.success
          ? { success: true, data: parsed.data }
          : { success: false, error: parsed.error.issues.map((issue) => issue.message).join("\n") };
      }),
    readPreferences: () =>
      read(input.readPreferences, (value) => {
        const parsed = PreferencesSchema.safeParse(value);
        return parsed.success
          ? { success: true, data: parsed.data }
          : { success: false, error: parsed.error.issues.map((issue) => issue.message).join("\n") };
      }),
    saveRoles: (values, revision) => input.roles.write(toJsonValue(values), revision),
    savePreferences: (values, revision) => input.preferences.write(toJsonValue(values), revision),
    reloadRoles: input.roles.reload,
    reloadPreferences: input.preferences.reload,
  };
}

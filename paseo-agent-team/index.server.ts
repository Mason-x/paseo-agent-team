import { randomUUID } from "node:crypto";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createLaunchService } from "./server/launch-service";
import { exampleCatalog, previewDefaultCatalog } from "./server/templates";
import { confirmPendingBoot } from "./server/version/boot";
import { createVersionService } from "./server/version/service";
import { createPaseoAdapter } from "./shared/paseo/adapter";
import {
  defaultCatalogPreviewRpc,
  exampleCatalogRpc,
  launchStartRpc,
  launchStatusRpc,
} from "./shared/rpc";
import { preferencesSettings, rolesSettings, teamsSettings } from "./shared/settings";
import {
  versionCheckRpc,
  versionGetRpc,
  versionRuntimeRpc,
  versionUpdateStartRpc,
  versionUpdateStatusRpc,
} from "./shared/version";

export default function contribute(server: PluginServerContext) {
  const settings = {
    roles: server.registerSettings(rolesSettings),
    teams: server.registerSettings(teamsSettings),
    preferences: server.registerSettings(preferencesSettings),
  };
  const launches = createLaunchService(settings);
  const bootId = randomUUID();
  const versions = createVersionService({ bootId });

  server.handle(launchStartRpc, (input, { paseo }) => launches.start(input, paseo));
  server.handle(launchStatusRpc, ({ runId }) => ({ job: launches.status(runId) }));
  server.handle(exampleCatalogRpc, async (_input, { paseo }) => {
    const profiles = await createPaseoAdapter(paseo).listProfiles();
    return exampleCatalog(profiles, new Date().toISOString());
  });
  server.handle(defaultCatalogPreviewRpc, (input, { paseo }) =>
    previewDefaultCatalog(input, {
      ...settings,
      listProfiles: () => createPaseoAdapter(paseo).listProfiles(),
    }),
  );
  server.handle(versionGetRpc, (_input, { paseo }) => versions.get(paseo));
  server.handle(versionCheckRpc, ({ requestId }, { paseo }) => versions.check(paseo, requestId));
  server.handle(versionUpdateStartRpc, ({ requestId, checkId }, { paseo }) =>
    versions.startUpdate(paseo, requestId, checkId),
  );
  server.handle(versionUpdateStatusRpc, ({ jobId }) => versions.status(jobId));
  server.handle(versionRuntimeRpc, (_input, { paseo }) => versions.runtime(paseo));

  void confirmPendingBoot({ bootId }).catch((error: unknown) => {
    console.error(
      `version boot confirmation skipped: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  });

  return () => {};
}

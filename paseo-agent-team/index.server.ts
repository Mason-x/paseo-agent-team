import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createLaunchService } from "./server/launch-service";
import { exampleCatalog, previewDefaultCatalog } from "./server/templates";
import { createPaseoAdapter } from "./shared/paseo/adapter";
import {
  defaultCatalogPreviewRpc,
  exampleCatalogRpc,
  launchStartRpc,
  launchStatusRpc,
} from "./shared/rpc";
import { preferencesSettings, rolesSettings, teamsSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  const settings = {
    roles: server.registerSettings(rolesSettings),
    teams: server.registerSettings(teamsSettings),
    preferences: server.registerSettings(preferencesSettings),
  };
  const launches = createLaunchService(settings);

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

  return () => {};
}

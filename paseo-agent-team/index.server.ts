import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createLaunchService } from "./server/launch-service";
import { exampleCatalog } from "./server/templates";
import { createPaseoAdapter } from "./shared/paseo/adapter";
import { exampleCatalogRpc, launchStartRpc, launchStatusRpc } from "./shared/rpc";
import { preferencesSettings, rolesSettings, teamsSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  const launches = createLaunchService({
    roles: server.registerSettings(rolesSettings),
    teams: server.registerSettings(teamsSettings),
    preferences: server.registerSettings(preferencesSettings),
  });

  server.handle(launchStartRpc, (input, { paseo }) => launches.start(input, paseo));
  server.handle(launchStatusRpc, ({ runId }) => ({ job: launches.status(runId) }));
  server.handle(exampleCatalogRpc, async (_input, { paseo }) => {
    const profiles = await createPaseoAdapter(paseo)
      .listProfiles()
      .catch(() => []);
    return exampleCatalog(profiles, new Date().toISOString());
  });

  return () => {};
}

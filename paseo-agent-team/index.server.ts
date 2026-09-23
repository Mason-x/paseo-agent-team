import type { PluginServerContext } from "@getpaseo/plugin/server";
import { preferencesSettings, rolesSettings, teamsSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(rolesSettings);
  server.registerSettings(teamsSettings);
  server.registerSettings(preferencesSettings);
  return () => {};
}

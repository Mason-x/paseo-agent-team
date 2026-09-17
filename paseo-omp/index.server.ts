import type { PluginServerContext } from "@getpaseo/plugin/server";
import { resolveListHubProcesses, resolveTailHubLog } from "./server/hub";
import {
  OmpBrowserAuthorizationRegistry,
  resolveOpenOmpMcpAuthorizationInPaseoBrowser,
} from "./server/mcp-browser";
import { resolveListOmpMemory } from "./server/memory";
import { resolveListOmpConfig } from "./server/omp-config";
import {
  resolveInspectOmpPluginConfig,
  resolveListOmpPlugins,
  resolveMutateOmpPlugin,
  resolveMutateOmpPluginConfig,
} from "./server/omp-plugins";
import { resolveListOmpSettings, resolveUpdateOmpSettings } from "./server/omp-settings";
import { withOmpStore } from "./server/paths";
import { withOmpWorkspaceIdentity } from "./server/provider/host-tools";
import {
  createProfileOmpProvider,
  discoverOmpProfiles,
  discoverOmpProfilesSync,
} from "./server/provider/profile-providers";
import { createOmpProvider } from "./server/provider/registration";
import { resolveGetOmpProviderHealth } from "./server/provider-diagnostics";
import { resolveListOmpQuotas } from "./server/quota";
import { resolveListOmpSessions } from "./server/sessions";
import { composerPillSettings } from "./shared/composer-pill-settings";
import { listHubProcesses, tailHubLog } from "./shared/hub";
import { openOmpMcpAuthorizationInPaseoBrowser } from "./shared/mcp";
import { listOmpMemory } from "./shared/memory";
import { listOmpConfig } from "./shared/omp-config";
import {
  inspectOmpPluginConfig,
  listOmpPlugins,
  mutateOmpPlugin,
  mutateOmpPluginConfig,
} from "./shared/omp-plugins";
import { listOmpSettings, updateOmpSettings } from "./shared/omp-settings";
import { listOmpStores, type OmpStore } from "./shared/omp-store";
import { getOmpProviderHealth } from "./shared/provider-diagnostics";
import { listOmpQuotas } from "./shared/quota";
import { listOmpSessions } from "./shared/sessions";

function scoped<T extends { store?: OmpStore }, R>(handler: (input: T) => R) {
  return (input: T): R => withOmpStore(input.store, () => handler(input));
}

export default function contribute(server: PluginServerContext) {
  server.registerSettings(composerPillSettings);
  const browserAuthorizationRegistry = new OmpBrowserAuthorizationRegistry();
  const profiles = discoverOmpProfilesSync();
  server.handle(listOmpStores, async () => ({ profiles: await discoverOmpProfiles() }));
  for (const profile of profiles) {
    server.registerProvider(createProfileOmpProvider(profile, { browserAuthorizationRegistry }));
  }
  server.handle(listHubProcesses, resolveListHubProcesses);
  server.handle(tailHubLog, resolveTailHubLog);
  server.handle(listOmpQuotas, scoped(resolveListOmpQuotas));
  server.handle(listOmpMemory, scoped(resolveListOmpMemory));
  server.handle(listOmpSessions, scoped(resolveListOmpSessions));
  server.handle(listOmpConfig, scoped(resolveListOmpConfig));
  server.handle(listOmpPlugins, scoped(resolveListOmpPlugins));
  server.handle(inspectOmpPluginConfig, scoped(resolveInspectOmpPluginConfig));
  server.handle(mutateOmpPlugin, scoped(resolveMutateOmpPlugin));
  server.handle(mutateOmpPluginConfig, scoped(resolveMutateOmpPluginConfig));
  server.handle(listOmpSettings, scoped(resolveListOmpSettings));
  server.handle(updateOmpSettings, scoped(resolveUpdateOmpSettings));
  server.handle(getOmpProviderHealth, scoped(resolveGetOmpProviderHealth));
  server.handle(openOmpMcpAuthorizationInPaseoBrowser, (input) =>
    resolveOpenOmpMcpAuthorizationInPaseoBrowser(input, browserAuthorizationRegistry),
  );
  const removeIdentityHook = server.before("agent.session_open", ({ request }) => {
    if (request.provider !== "omp-plugin" && !request.provider.startsWith("omp-plugin-")) return;
    return withOmpWorkspaceIdentity(request);
  });
  server.registerProvider(createOmpProvider({ browserAuthorizationRegistry }));
  return () => {
    browserAuthorizationRegistry.clear();
    removeIdentityHook();
  };
}

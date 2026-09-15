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
import { withOmpWorkspaceIdentity } from "./server/provider/host-tools";
import { createOmpProvider } from "./server/provider/registration";
import { resolveGetOmpProviderHealth } from "./server/provider-diagnostics";
import { resolveListOmpQuotas } from "./server/quota";
import { resolveListOmpSessions } from "./server/sessions";
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
import { getOmpProviderHealth } from "./shared/provider-diagnostics";
import { listOmpQuotas } from "./shared/quota";
import { listOmpSessions } from "./shared/sessions";

export default function contribute(server: PluginServerContext) {
  const browserAuthorizationRegistry = new OmpBrowserAuthorizationRegistry();
  server.handle(listHubProcesses, resolveListHubProcesses);
  server.handle(tailHubLog, resolveTailHubLog);
  server.handle(listOmpQuotas, resolveListOmpQuotas);
  server.handle(listOmpMemory, resolveListOmpMemory);
  server.handle(listOmpSessions, resolveListOmpSessions);
  server.handle(listOmpConfig, resolveListOmpConfig);
  server.handle(listOmpPlugins, resolveListOmpPlugins);
  server.handle(inspectOmpPluginConfig, resolveInspectOmpPluginConfig);
  server.handle(mutateOmpPlugin, resolveMutateOmpPlugin);
  server.handle(mutateOmpPluginConfig, resolveMutateOmpPluginConfig);
  server.handle(listOmpSettings, resolveListOmpSettings);
  server.handle(updateOmpSettings, resolveUpdateOmpSettings);
  server.handle(getOmpProviderHealth, resolveGetOmpProviderHealth);
  server.handle(openOmpMcpAuthorizationInPaseoBrowser, (input) =>
    resolveOpenOmpMcpAuthorizationInPaseoBrowser(input, browserAuthorizationRegistry),
  );
  const removeIdentityHook = server.before("agent.session_open", ({ request }) => {
    if (request.provider !== "omp-plugin") return;
    return withOmpWorkspaceIdentity(request);
  });
  server.registerProvider(createOmpProvider({ browserAuthorizationRegistry }));
  return () => {
    browserAuthorizationRegistry.clear();
    removeIdentityHook();
  };
}

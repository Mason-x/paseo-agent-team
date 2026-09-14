import type { PluginServerContext } from "@getpaseo/plugin/server";
import { resolveListHubProcesses, resolveTailHubLog } from "./server/hub";
import { resolveListOmpMemory } from "./server/memory";
import { resolveListOmpConfig } from "./server/omp-config";
import { resolveListOmpSettings } from "./server/omp-settings";
import { withOmpWorkspaceIdentity } from "./server/provider/host-tools";
import { createOmpProvider } from "./server/provider/registration";
import { resolveGetOmpProviderHealth } from "./server/provider-diagnostics";
import { resolveListOmpQuotas } from "./server/quota";
import { resolveListOmpSessions } from "./server/sessions";
import { listHubProcesses, tailHubLog } from "./shared/hub";
import { listOmpMemory } from "./shared/memory";
import { listOmpConfig } from "./shared/omp-config";
import { listOmpSettings } from "./shared/omp-settings";
import { getOmpProviderHealth } from "./shared/provider-diagnostics";
import { listOmpQuotas } from "./shared/quota";
import { listOmpSessions } from "./shared/sessions";

export default function contribute(server: PluginServerContext) {
  server.handle(listHubProcesses, resolveListHubProcesses);
  server.handle(tailHubLog, resolveTailHubLog);
  server.handle(listOmpQuotas, resolveListOmpQuotas);
  server.handle(listOmpMemory, resolveListOmpMemory);
  server.handle(listOmpSessions, resolveListOmpSessions);
  server.handle(listOmpConfig, resolveListOmpConfig);
  server.handle(listOmpSettings, resolveListOmpSettings);
  server.handle(getOmpProviderHealth, resolveGetOmpProviderHealth);
  const removeIdentityHook = server.before("agent.session_open", ({ request }) => {
    if (request.provider !== "omp-plugin") return;
    return withOmpWorkspaceIdentity(request);
  });
  server.registerProvider(createOmpProvider());
  return () => removeIdentityHook();
}

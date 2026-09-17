import type { PaseoAgentListResult, PaseoApi } from "@getpaseo/client";
import { settingsRpc } from "@getpaseo/plugin";
import type {
  PluginButtonRegistration,
  PluginClientContext,
  PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { OmpIcon } from "./client/hub-icon";
import { HubPopover } from "./client/hub-popover";
import { summarizeHubProcesses } from "./client/hub-status";
import { OmpMcpAuthorizationCard } from "./client/mcp-authorization";
import { McpPopover } from "./client/mcp-popover";
import { OmpMemoryPanel } from "./client/memory-panel";
import { MemoryPopover } from "./client/memory-popover";
import { OmpConfigSurface, OmpWorkspacePanel } from "./client/omp-config-surface";
import {
  createStoreQuotaLoader,
  isOmpPluginProvider,
  isOmpProvider,
  ompStoreKey,
} from "./client/omp-store-state";
import { quotaProviderIcon } from "./client/provider-icon";
import { OmpImageTimeline } from "./client/provider-image";
import { QuotaPopover } from "./client/quota-popover";
import {
  type QuotaSeverity,
  quotaProviderFromSession,
  quotaSeverityForProvider,
  quotaSummaryForProvider,
} from "./client/quota-state";
import { SessionsPopover } from "./client/sessions-popover";
import {
  type ComposerPillSettings,
  composerPillSettings,
  composerPillSettingsSchema,
} from "./shared/composer-pill-settings";
import { listHubProcesses } from "./shared/hub";
import { OMP_MCP_AUTH_TIMELINE_KIND, ompMcpAuthorizationTimelineSchema } from "./shared/mcp";
import { type OmpStore, storeForProvider } from "./shared/omp-store";
import { ompImageTimelineSchema, transformOmpImageToolItem } from "./shared/provider-image";
import { listOmpQuotas } from "./shared/quota";

const PAGE_LIMIT = 200;
const MAX_PAGES = 10;
const STATUS_POLL_MS = 4_000;
const QUOTA_POLL_MS = 30_000;
const RECONCILE_DEBOUNCE_MS = 250;
const SETTINGS_POLL_MS = 15_000;
const composerPillSettingsRpc = settingsRpc(composerPillSettings.id);

type AgentEntry = PaseoAgentListResult["entries"][number];

type PillEntry = {
  store?: OmpStore;
  cwd: string;
  provider: string;
  workspaceId: string;
  quotaProvider: string | null;
  quotaSeverity: QuotaSeverity;
  hub?: PluginButtonRegistration;
  memory?: PluginButtonRegistration;
  sessions?: PluginButtonRegistration;
  quota?: PluginButtonRegistration;
  mcp?: PluginButtonRegistration;
};

function samePillSettings(
  left: ComposerPillSettings | undefined,
  right: ComposerPillSettings,
): boolean {
  return (
    left?.mcp === right.mcp &&
    left.hub === right.hub &&
    left.memory === right.memory &&
    left.sessions === right.sessions &&
    left.quota === right.quota
  );
}

function removePills(entry: PillEntry): void {
  entry.hub?.remove();
  entry.memory?.remove();
  entry.sessions?.remove();
  entry.quota?.remove();
  entry.mcp?.remove();
}

async function loadAgents(paseo: PaseoApi): Promise<AgentEntry[]> {
  const entries: AgentEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.agents.list({
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    entries.push(...result.entries);
    cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
    if (!cursor) break;
  }
  return entries;
}

export default function contribute(client: PluginClientContext) {
  const pills = new Map<string, PillEntry>();
  let preferences: ComposerPillSettings | undefined;
  let disposed = false;
  let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  let reconcileRunning = false;
  let reconcileQueued = false;
  let hubRefreshRunning = false;
  let quotaRefreshRunning = false;
  let settingsReadRunning = false;
  let settingsGeneration = 0;

  function applyComposerPillSettings(next: ComposerPillSettings): void {
    if (samePillSettings(preferences, next)) return;
    preferences = next;
    settingsGeneration += 1;
    scheduleReconcile();
  }

  function ConfigSurface(props: PluginSurfaceProps) {
    return <OmpConfigSurface {...props} onComposerPillSettingsChange={applyComposerPillSettings} />;
  }

  const removeMemoryPanel = client.addWorkspacePanel({
    id: "memory",
    title: "OMP Memory",
    icon: "Brain",
    context: "workspace",
    locations: ["explorer"],
    Component: OmpMemoryPanel,
  });
  const removeOpenMemory = client.addCommandCenterItem({
    id: "open-memory",
    title: "Open OMP Memory",
    icon: "Brain",
    keywords: ["omp", "memory", "facts", "recall"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("memory", { location: "explorer" });
    },
  });
  const removeWorkspacePanel = client.addWorkspacePanel({
    id: "workspace",
    title: "OMP",
    icon: "Settings",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: OmpWorkspacePanel,
  });
  const removeOpenWorkspace = client.addCommandCenterItem({
    id: "open-workspace",
    title: "Open Workspace OMP",
    icon: "Settings",
    keywords: ["omp", "workspace", "config", "plugins", "diagnostics"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("workspace", { location: "workspace" });
    },
  });
  const removeConfigSurface = client.addSurface("config", ConfigSurface);
  const removeConfigSidebarItem = client.addSidebarItem({
    id: "config",
    title: "OMP",
    icon: "Settings",
    surface: "config",
  });
  const removeOpenConfig = client.addCommandCenterItem({
    id: "open-config",
    title: "Open OMP",
    icon: "Settings",
    keywords: ["omp", "config", "settings", "models", "providers", "composer", "pills"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("config");
    },
  });
  const removeImageRenderer = client.addTimelineRenderer({
    kind: "omp-images",
    version: 1,
    schema: ompImageTimelineSchema,
    Component: OmpImageTimeline,
  });
  const removeMcpAuthorizationRenderer = client.addTimelineRenderer({
    kind: OMP_MCP_AUTH_TIMELINE_KIND,
    version: 1,
    schema: ompMcpAuthorizationTimelineSchema,
    Component: OmpMcpAuthorizationCard,
  });
  const removeImageTransformer = client.addTimelineTransformer({
    id: "omp-images",
    query: { itemType: "tool_call" },
    transform({ item }) {
      return transformOmpImageToolItem(item);
    },
  });
  const loadStoreQuotas = createStoreQuotaLoader(
    (input) => client.rpc(listOmpQuotas, input),
    QUOTA_POLL_MS,
  );

  function syncAgentPills(entry: PillEntry, agent: AgentEntry["agent"]): void {
    const settings = preferences;
    if (!settings) return;

    if (settings.mcp && isOmpPluginProvider(agent.provider)) {
      entry.mcp ??= client.addComposerPill({
        id: "mcp",
        workspaceId: entry.workspaceId,
        agentId: agent.id,
        button: {
          title: "Manage OMP MCP servers",
          icon: "Plug",
          label: "MCP",
          behavior: { kind: "popover", Content: McpPopover },
        },
      });
    } else {
      entry.mcp?.remove();
      entry.mcp = undefined;
    }

    if (settings.hub) {
      entry.hub ??= client.addComposerPill({
        id: "hub",
        workspaceId: entry.workspaceId,
        agentId: agent.id,
        button: {
          title: "Hub processes",
          icon: OmpIcon,
          label: "Hub",
          visible: false,
          behavior: { kind: "popover", Content: HubPopover },
        },
      });
    } else {
      entry.hub?.remove();
      entry.hub = undefined;
    }

    if (settings.memory) {
      entry.memory ??= client.addComposerPill({
        id: "memory",
        workspaceId: entry.workspaceId,
        agentId: agent.id,
        button: {
          title: "OMP workspace memory",
          icon: "Brain",
          label: "Memory",
          behavior: { kind: "popover", Content: MemoryPopover },
        },
      });
    } else {
      entry.memory?.remove();
      entry.memory = undefined;
    }

    if (settings.sessions) {
      entry.sessions ??= client.addComposerPill({
        id: "sessions",
        workspaceId: entry.workspaceId,
        agentId: agent.id,
        button: {
          title: "OMP session history",
          icon: "History",
          label: "Sessions",
          behavior: { kind: "popover", Content: SessionsPopover },
        },
      });
    } else {
      entry.sessions?.remove();
      entry.sessions = undefined;
    }

    if (settings.quota) {
      entry.quota ??= client.addComposerPill({
        id: "quota",
        workspaceId: entry.workspaceId,
        agentId: agent.id,
        button: {
          title: "OMP provider quotas",
          icon: quotaProviderIcon(entry.quotaProvider, "unknown"),
          label: "Quota",
          visible: false,
          behavior: { kind: "popover", Content: QuotaPopover },
        },
      });
    } else {
      entry.quota?.remove();
      entry.quota = undefined;
      entry.quotaSeverity = "unknown";
    }
  }

  async function reconcileOnce(): Promise<void> {
    if (!preferences) return;
    const agents = await loadAgents(client.paseo);
    if (disposed || !preferences) return;
    const activeIds = new Set<string>();
    for (const { agent } of agents) {
      if (agent.archivedAt || !agent.workspaceId || !agent.cwd) continue;
      activeIds.add(agent.id);
      const quotaProvider = quotaProviderFromSession(agent.provider, agent.model);
      const store = storeForProvider(agent.provider);
      let entry = pills.get(agent.id);
      if (
        !entry ||
        entry.cwd !== agent.cwd ||
        entry.provider !== agent.provider ||
        entry.workspaceId !== agent.workspaceId ||
        entry.quotaProvider !== quotaProvider ||
        ompStoreKey(entry.store) !== ompStoreKey(store)
      ) {
        if (entry) removePills(entry);
        entry = {
          store,
          cwd: agent.cwd,
          provider: agent.provider,
          workspaceId: agent.workspaceId,
          quotaProvider,
          quotaSeverity: "unknown",
        };
        pills.set(agent.id, entry);
      }
      syncAgentPills(entry, agent);
    }
    for (const [agentId, entry] of pills) {
      if (activeIds.has(agentId)) continue;
      removePills(entry);
      pills.delete(agentId);
    }
    await Promise.all([refreshHubStatus(), refreshQuotaStatus()]);
  }

  async function reconcile(): Promise<void> {
    if (reconcileRunning) {
      reconcileQueued = true;
      return;
    }
    reconcileRunning = true;
    try {
      do {
        reconcileQueued = false;
        await reconcileOnce();
      } while (reconcileQueued && !disposed);
    } finally {
      reconcileRunning = false;
    }
  }

  async function refreshHubStatus(): Promise<void> {
    if (hubRefreshRunning || !preferences?.hub) return;
    const pillsByCwd = new Map<
      string,
      Array<{ agentId: string; entry: PillEntry; handle: PluginButtonRegistration }>
    >();
    for (const [agentId, entry] of pills) {
      if (!entry.hub) continue;
      const target = { agentId, entry, handle: entry.hub };
      const group = pillsByCwd.get(entry.cwd);
      if (group) group.push(target);
      else pillsByCwd.set(entry.cwd, [target]);
    }
    if (pillsByCwd.size === 0) return;
    hubRefreshRunning = true;
    try {
      await Promise.all(
        [...pillsByCwd].map(async ([cwd, targets]) => {
          try {
            const result = await client.rpc(listHubProcesses, { cwd });
            if (disposed || !preferences?.hub) return;
            const summary = summarizeHubProcesses(result.processes);
            for (const { agentId, entry, handle } of targets) {
              const current = pills.get(agentId);
              if (current === entry && current.hub === handle) handle.update(summary);
            }
          } catch {
            // Preserve the last known state through temporary host and workspace failures.
          }
        }),
      );
    } finally {
      hubRefreshRunning = false;
    }
  }

  async function refreshQuotaStatus(): Promise<void> {
    if (quotaRefreshRunning || !preferences?.quota) return;
    const groups = new Map<
      string,
      Array<{ agentId: string; entry: PillEntry; handle: PluginButtonRegistration }>
    >();
    for (const [agentId, entry] of pills) {
      if (!entry.quota || !isOmpProvider(entry.provider)) continue;
      const target = { agentId, entry, handle: entry.quota };
      const key = ompStoreKey(entry.store);
      const group = groups.get(key);
      if (group) group.push(target);
      else groups.set(key, [target]);
    }
    if (groups.size === 0) return;
    quotaRefreshRunning = true;
    try {
      await Promise.all(
        [...groups.values()].map(async (targets) => {
          try {
            const result = await loadStoreQuotas(targets[0].entry.store);
            if (disposed || !preferences?.quota) return;
            for (const { agentId, entry, handle } of targets) {
              const current = pills.get(agentId);
              if (current !== entry || current.quota !== handle) continue;
              const severity = quotaSeverityForProvider(result.quotas, entry.quotaProvider, true);
              handle.update({
                ...quotaSummaryForProvider(result.quotas, entry.quotaProvider, true),
                ...(severity === entry.quotaSeverity
                  ? {}
                  : { icon: quotaProviderIcon(entry.quotaProvider, severity) }),
              });
              entry.quotaSeverity = severity;
            }
          } catch {
            // Retain only this store's last result. Failure never falls back to another profile.
          }
        }),
      );
    } finally {
      quotaRefreshRunning = false;
    }
  }

  async function refreshComposerPillSettings(): Promise<void> {
    if (settingsReadRunning || disposed) return;
    settingsReadRunning = true;
    const generation = settingsGeneration;
    try {
      const result = await client.rpc(composerPillSettingsRpc.read, {});
      if (disposed || generation !== settingsGeneration || result.status !== "ready") return;
      const parsed = composerPillSettingsSchema.safeParse(result.values);
      if (parsed.success) applyComposerPillSettings(parsed.data);
    } catch {
      // Keep the last known preferences. The sidebar exposes read and validation failures.
    } finally {
      settingsReadRunning = false;
    }
  }

  function scheduleReconcile(): void {
    clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => {
      void reconcile().catch(() => {});
    }, RECONCILE_DEBOUNCE_MS);
  }

  const unsubscribeAgents = client.paseo.agents.subscribe(scheduleReconcile);
  const hubPoll = setInterval(() => {
    void refreshHubStatus();
  }, STATUS_POLL_MS);
  const quotaPoll = setInterval(() => {
    void refreshQuotaStatus();
  }, QUOTA_POLL_MS);
  const settingsPoll = setInterval(() => {
    void refreshComposerPillSettings();
  }, SETTINGS_POLL_MS);
  void refreshComposerPillSettings();

  return () => {
    disposed = true;
    settingsGeneration += 1;
    unsubscribeAgents();
    clearTimeout(reconcileTimer);
    clearInterval(hubPoll);
    clearInterval(quotaPoll);
    clearInterval(settingsPoll);
    for (const entry of pills.values()) removePills(entry);
    pills.clear();
    removeImageRenderer();
    removeMcpAuthorizationRenderer();
    removeImageTransformer();
    removeOpenConfig();
    removeConfigSidebarItem();
    removeConfigSurface();
    removeOpenWorkspace();
    removeWorkspacePanel();
    removeOpenMemory();
    removeMemoryPanel();
  };
}

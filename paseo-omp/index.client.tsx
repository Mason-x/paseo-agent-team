import type { PaseoAgentListResult, PaseoApi } from "@getpaseo/client";
import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { OmpIcon } from "./client/hub-icon";
import { HubPopover } from "./client/hub-popover";
import { summarizeHubProcesses } from "./client/hub-status";
import { OmpMcpAuthorizationCard } from "./client/mcp-authorization";
import { McpPopover } from "./client/mcp-popover";
import { OmpMemoryPanel } from "./client/memory-panel";
import { MemoryPopover } from "./client/memory-popover";
import { OmpConfigSurface, OmpWorkspacePanel } from "./client/omp-config-surface";
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
import { listHubProcesses } from "./shared/hub";
import { OMP_MCP_AUTH_TIMELINE_KIND, ompMcpAuthorizationTimelineSchema } from "./shared/mcp";
import { ompImageTimelineSchema, transformOmpImageToolItem } from "./shared/provider-image";
import { listOmpQuotas } from "./shared/quota";

const PAGE_LIMIT = 200;
const MAX_PAGES = 10;
const STATUS_POLL_MS = 4_000;
const QUOTA_POLL_MS = 30_000;
const RECONCILE_DEBOUNCE_MS = 250;

type AgentEntry = PaseoAgentListResult["entries"][number];

type PillEntry = {
  cwd: string;
  provider: string;
  workspaceId: string;
  quotaProvider: string | null;
  quotaSeverity: QuotaSeverity;
  hub: PluginButtonRegistration;
  memory: PluginButtonRegistration;
  sessions: PluginButtonRegistration;
  quota: PluginButtonRegistration;
  mcp?: PluginButtonRegistration;
};

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
  const removeConfigSurface = client.addSurface("config", OmpConfigSurface);
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
    keywords: ["omp", "config", "settings", "models", "providers"],
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
  const pills = new Map<string, PillEntry>();
  let disposed = false;
  let reconcileTimer: ReturnType<typeof setTimeout> | undefined;

  async function reconcile() {
    const agents = await loadAgents(client.paseo);
    if (disposed) return;
    const activeIds = new Set<string>();
    for (const { agent } of agents) {
      if (agent.archivedAt || !agent.workspaceId || !agent.cwd) continue;
      activeIds.add(agent.id);
      const quotaProvider = quotaProviderFromSession(agent.provider, agent.model);
      const current = pills.get(agent.id);
      if (
        current?.cwd === agent.cwd &&
        current.provider === agent.provider &&
        current.workspaceId === agent.workspaceId &&
        current.quotaProvider === quotaProvider
      ) {
        continue;
      }
      current?.hub.remove();
      current?.memory.remove();
      current?.sessions.remove();
      current?.quota.remove();
      current?.mcp?.remove();
      pills.set(agent.id, {
        cwd: agent.cwd,
        provider: agent.provider,
        mcp:
          agent.provider === "omp-plugin"
            ? client.addComposerPill({
                id: "mcp",
                workspaceId: agent.workspaceId,
                agentId: agent.id,
                button: {
                  title: "Manage OMP MCP servers",
                  icon: "Plug",
                  label: "MCP",
                  behavior: { kind: "popover", Content: McpPopover },
                },
              })
            : undefined,
        workspaceId: agent.workspaceId,
        quotaProvider,
        quotaSeverity: "unknown",
        hub: client.addComposerPill({
          id: "hub",
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          button: {
            title: "Hub processes",
            icon: OmpIcon,
            label: "Hub",
            visible: false,
            behavior: { kind: "popover", Content: HubPopover },
          },
        }),
        memory: client.addComposerPill({
          id: "memory",
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          button: {
            title: "OMP workspace memory",
            icon: "Brain",
            label: "Memory",
            behavior: { kind: "popover", Content: MemoryPopover },
          },
        }),
        sessions: client.addComposerPill({
          id: "sessions",
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          button: {
            title: "omp session history",
            icon: "History",
            label: "Sessions",
            behavior: { kind: "popover", Content: SessionsPopover },
          },
        }),
        quota: client.addComposerPill({
          id: "quota",
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          button: {
            title: "OMP provider quotas",
            icon: quotaProviderIcon(quotaProvider, "unknown"),
            label: "Quota",
            visible: false,
            behavior: { kind: "popover", Content: QuotaPopover },
          },
        }),
      });
    }
    for (const [agentId, pill] of pills) {
      if (activeIds.has(agentId)) continue;
      pill.hub.remove();
      pill.memory.remove();
      pill.sessions.remove();
      pill.quota.remove();
      pill.mcp?.remove();
      pills.delete(agentId);
    }
    await Promise.all([refreshHubStatus(), refreshQuotaStatus()]);
  }

  async function refreshHubStatus() {
    const pillsByCwd = new Map<string, PillEntry[]>();
    for (const pill of pills.values()) {
      const group = pillsByCwd.get(pill.cwd);
      if (group) group.push(pill);
      else pillsByCwd.set(pill.cwd, [pill]);
    }
    await Promise.all(
      [...pillsByCwd].map(async ([cwd, cwdPills]) => {
        try {
          const result = await client.rpc(listHubProcesses, { cwd });
          if (disposed) return;
          const summary = summarizeHubProcesses(result.processes);
          for (const pill of cwdPills) pill.hub.update(summary);
        } catch {
          // Keep the last known state. A disconnected host or missing omp directory should not
          // remove a status the user was already inspecting.
        }
      }),
    );
  }

  async function refreshQuotaStatus() {
    try {
      const result = await client.rpc(listOmpQuotas, {});
      if (disposed) return;
      for (const pill of pills.values()) {
        const severity = quotaSeverityForProvider(result.quotas, pill.quotaProvider);
        pill.quota.update({
          ...quotaSummaryForProvider(result.quotas, pill.quotaProvider),
          ...(severity === pill.quotaSeverity
            ? {}
            : { icon: quotaProviderIcon(pill.quotaProvider, severity) }),
        });
        pill.quotaSeverity = severity;
      }
    } catch {
      // The quota database is optional and may not exist on a new omp installation.
    }
  }

  function scheduleReconcile() {
    clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => {
      void reconcile().catch(() => {});
    }, RECONCILE_DEBOUNCE_MS);
  }

  const unsubscribeAgents = client.paseo.agents.subscribe(scheduleReconcile);
  const hubPoll = setInterval(() => {
    void refreshHubStatus().catch(() => {});
  }, STATUS_POLL_MS);
  const quotaPoll = setInterval(() => {
    void refreshQuotaStatus().catch(() => {});
  }, QUOTA_POLL_MS);
  void reconcile().catch(() => {});

  return () => {
    disposed = true;
    unsubscribeAgents();
    clearTimeout(reconcileTimer);
    clearInterval(hubPoll);
    clearInterval(quotaPoll);
    for (const pill of pills.values()) {
      pill.hub.remove();
      pill.memory.remove();
      pill.sessions.remove();
      pill.quota.remove();
      pill.mcp?.remove();
    }
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

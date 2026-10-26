import { profileProvider } from "./adapter";
import type {
  CreateDesignAgentInput,
  DesignAdapter,
  DesignAgentPage,
  DesignAgentSummary,
  DesignPaseoAgent,
  DesignPaseoItem,
  DesignPaseoPort,
  DesignPaseoTimelinePayload,
  DesignPaseoWorkspace,
  DesignPermissionKind,
  DesignTimelineItem,
  DesignTimelinePage,
  DesignTimelineRequest,
  DesignWorkspacePage,
  DesignWorkspaceSummary,
  SendDesignMessageInput,
} from "./design-port";
import { DESIGN_LABEL_KEYS } from "./design-port";

const DESIGN_LABELS = { [DESIGN_LABEL_KEYS.version]: "1" } as const;

function workspaceSummary(workspace: DesignPaseoWorkspace): DesignWorkspaceSummary {
  return {
    id: workspace.id,
    name: workspace.title?.trim() || workspace.name,
    title: workspace.title ?? null,
    projectId: workspace.projectId,
    projectName: workspace.projectDisplayName,
    directory: workspace.workspaceDirectory ?? workspace.projectRootPath,
    internal: workspace.internal === true,
    archivingAt: workspace.archivingAt ?? null,
    activityAt: workspace.activityAt,
    background: workspace.background === true,
    status: workspace.status,
  };
}

function permissionKind(value: string): DesignPermissionKind {
  if (value === "tool" || value === "plan" || value === "question" || value === "mode")
    return value;
  return "other";
}

function agentSummary(agent: DesignPaseoAgent): DesignAgentSummary {
  return {
    id: agent.id,
    labels: { ...agent.labels },
    status: agent.status,
    activeTurn: agent.activeTurn !== null && agent.activeTurn !== undefined,
    archivedAt: agent.archivedAt ?? null,
    requiresAttention: agent.requiresAttention === true,
    attentionReason: agent.attentionReason ?? null,
    pendingPermissions: agent.pendingPermissions.map((permission) => ({
      id: permission.id,
      kind: permissionKind(permission.kind),
      title: permission.title?.slice(0, 200) ?? "",
      description: permission.description?.slice(0, 500),
    })),
    lastError: agent.lastError?.slice(0, 500) ?? null,
    providerUnavailable: agent.providerUnavailable === true,
  };
}

function timelineItem(entry: DesignPaseoTimelinePayload["entries"][number]): DesignTimelineItem {
  const base = {
    seqStart: entry.seqStart,
    seqEnd: entry.seqEnd,
    turnId: entry.turnId ?? null,
  };
  const item: DesignPaseoItem = entry.item;
  switch (item.type) {
    case "user_message":
      return {
        ...base,
        type: "user_message",
        text: item.text,
        messageId: item.messageId,
        clientMessageId: item.clientMessageId,
      };
    case "assistant_message":
      return {
        ...base,
        type: "assistant_message",
        text: item.text,
        messageId: item.messageId,
      };
    case "error":
      return { ...base, type: "error", text: item.message, level: "error" };
    case "notification":
      return { ...base, type: "notification", text: item.message, level: item.level };
    case "reasoning":
      return { ...base, type: "reasoning" };
    case "tool_call":
      return { ...base, type: "tool_call" };
    case "plugin":
      return { ...base, type: "plugin" };
    default:
      return { ...base, type: "other" };
  }
}

function timelinePage(payload: DesignPaseoTimelinePayload): DesignTimelinePage {
  return {
    epoch: payload.epoch,
    direction: payload.direction,
    projection: "projected",
    entries: payload.entries.map(timelineItem),
    startCursor: payload.startCursor,
    endCursor: payload.endCursor,
    hasOlder: payload.hasOlder,
    hasNewer: payload.hasNewer,
    reset: payload.reset,
    gap: payload.gap,
    staleCursor: payload.staleCursor,
  };
}

export function createDesignAdapter(paseo: DesignPaseoPort): DesignAdapter {
  return {
    async readConfig() {
      return (await paseo.config.get()).config;
    },

    async listProviderAvailability() {
      const result = await paseo.providers.listAvailable();
      return result.providers.map((entry) => ({
        provider: entry.provider,
        available: entry.available,
        ...(entry.error ? { reason: entry.error } : {}),
      }));
    },

    async listRecentWorkspaces(input): Promise<DesignWorkspacePage> {
      const page: { limit: number; cursor?: string } = { limit: input.limit };
      if (input.cursor) page.cursor = input.cursor;
      const result = await paseo.workspaces.list({
        page,
        sort: [{ key: "activity_at", direction: "desc" }],
      });
      return {
        workspaces: result.entries.map(workspaceSummary),
        nextCursor: result.pageInfo.nextCursor ?? null,
        hasMore: result.pageInfo.hasMore,
      };
    },

    async getDesignWorkspace(workspaceId) {
      const workspace = await paseo.workspaces.ref(workspaceId).refresh();
      return workspace ? workspaceSummary(workspace) : null;
    },

    async createDesignAgent(input: CreateDesignAgentInput) {
      const created = await paseo.workspaces.ref(input.workspaceId).agents.create({
        agentId: input.agentId,
        idempotencyKey: input.idempotencyKey,
        clientMessageId: input.clientMessageId,
        title: input.title,
        labels: input.labels,
        prompt: input.prompt,
        config: {
          provider: profileProvider(input.profile),
          modeId: input.profile.modeId,
          thinkingOptionId: input.profile.thinkingOptionId,
          featureValues: input.profile.featureValues,
          systemPrompt: input.systemPrompt,
        },
      });
      return { agentId: created.id };
    },

    async getDesignAgent(agentId) {
      const result = await paseo.agents.ref(agentId).refresh();
      return result ? agentSummary(result.agent) : null;
    },

    async listDesignAgents(input): Promise<DesignAgentPage> {
      const page: { limit: number; cursor?: string } = { limit: input.limit };
      if (input.cursor) page.cursor = input.cursor;
      const result = await paseo.agents.list({
        filter: {
          labels: { ...DESIGN_LABELS },
          includeArchived: true,
          includeBackground: true,
        },
        sort: [{ key: "created_at", direction: "desc" }],
        page,
      });
      return {
        agents: result.entries.map((entry) => agentSummary(entry.agent)),
        nextCursor: result.pageInfo.nextCursor ?? null,
        hasMore: result.pageInfo.hasMore,
      };
    },

    async readDesignTimeline(input: DesignTimelineRequest) {
      const options: {
        direction: "tail" | "before";
        cursor?: { epoch: string; seq: number };
        limit: number;
        projection: "projected";
      } = {
        direction: input.direction,
        limit: input.limit,
        projection: "projected",
      };
      if (input.cursor) options.cursor = input.cursor;
      const payload = await paseo.agents.ref(input.agentId).timeline.refetch(options);
      return timelinePage(payload);
    },

    async sendDesignMessage(input: SendDesignMessageInput) {
      await paseo.agents.ref(input.agentId).send(input.text, {
        messageId: input.messageId,
        activeTurnBehavior: "steer",
      });
    },

    async archiveDesignAgent(agentId) {
      await paseo.agents.ref(agentId).archive();
    },
  };
}

/**
 * Pure, Node-free port for the Team Designer. The server adapter maps a Paseo client to this
 * surface; shared/domain and server/designer code depend only on these shapes.
 */

export const DESIGN_LABEL_KEYS = {
  job: "agent-team.design",
  version: "agent-team.design.version",
  requestId: "agent-team.design.request-id",
  requestHash: "agent-team.design.request-hash",
  mode: "agent-team.design.mode",
} as const;

export type DesignWorkspaceSummary = {
  id: string;
  name: string;
  title: string | null;
  projectId: string;
  projectName: string;
  directory: string;
  internal: boolean;
  archivingAt: string | null;
  activityAt: string | null;
  background: boolean;
  status: string;
};

export type DesignWorkspacePage = {
  workspaces: DesignWorkspaceSummary[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type DesignPermissionKind = "tool" | "plan" | "question" | "mode" | "other";

export type DesignPermissionSummary = {
  id: string;
  kind: DesignPermissionKind;
  title: string;
  description?: string;
};

export type DesignAgentStatus = "initializing" | "idle" | "running" | "closed" | "error";

export type DesignAgentSummary = {
  id: string;
  labels: Record<string, string>;
  status: DesignAgentStatus;
  activeTurn: boolean;
  archivedAt: string | null;
  requiresAttention: boolean;
  attentionReason: "finished" | "error" | "permission" | null;
  pendingPermissions: DesignPermissionSummary[];
  lastError: string | null;
  providerUnavailable: boolean;
};

export type DesignAgentPage = {
  agents: DesignAgentSummary[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type DesignTimelineCursor = { epoch: string; seq: number };

export type DesignTimelineItem = {
  seqStart: number;
  seqEnd: number;
  type:
    | "user_message"
    | "assistant_message"
    | "tool_call"
    | "reasoning"
    | "plugin"
    | "error"
    | "notification"
    | "other";
  text?: string;
  messageId?: string;
  clientMessageId?: string;
  turnId?: string | null;
  level?: "info" | "warning" | "error";
};

export type DesignTimelinePage = {
  epoch: string;
  direction: "tail" | "before" | "after";
  projection: "projected";
  entries: DesignTimelineItem[];
  startCursor: DesignTimelineCursor | null;
  endCursor: DesignTimelineCursor | null;
  hasOlder: boolean;
  hasNewer: boolean;
  reset: boolean;
  gap: boolean;
  staleCursor: boolean;
};

export type DesignTimelineRequest = {
  agentId: string;
  direction: "tail" | "before";
  cursor?: DesignTimelineCursor | null;
  limit: number;
};

export type CreateDesignAgentInput = {
  agentId: string;
  idempotencyKey: string;
  workspaceId: string;
  title: string;
  labels: Record<string, string>;
  profile: {
    provider: string;
    model?: string;
    modeId?: string;
    thinkingOptionId?: string;
    featureValues?: Record<string, unknown>;
  };
  systemPrompt: string;
  prompt: string;
  clientMessageId: string;
};

export type SendDesignMessageInput = {
  agentId: string;
  text: string;
  messageId: string;
};

/** The exact Paseo surface the design adapter uses. PaseoApi satisfies this structurally. */
export interface DesignPaseoPort {
  readonly config: {
    get(): Promise<{ config: unknown }>;
  };
  readonly providers: {
    listAvailable(): Promise<{
      providers: ReadonlyArray<{
        provider: string;
        available: boolean;
        error?: string | null;
      }>;
    }>;
  };
  readonly workspaces: {
    list(options: {
      page: { limit: number; cursor?: string };
      sort: Array<{ key: "activity_at"; direction: "desc" }>;
    }): Promise<{
      entries: ReadonlyArray<DesignPaseoWorkspace>;
      pageInfo: { hasMore: boolean; nextCursor?: string | null };
    }>;
    ref(workspaceId: string): {
      refresh(): Promise<DesignPaseoWorkspace | null>;
      agents: {
        create(options: DesignPaseoAgentCreateOptions): Promise<{ id: string }>;
      };
    };
  };
  readonly agents: {
    list(options: {
      filter: {
        labels: Record<string, string>;
        includeArchived: boolean;
        includeBackground: boolean;
      };
      sort: Array<{ key: "created_at"; direction: "desc" }>;
      page: { limit: number; cursor?: string };
    }): Promise<{
      entries: ReadonlyArray<{ agent: DesignPaseoAgent }>;
      pageInfo: { hasMore: boolean; nextCursor?: string | null };
    }>;
    ref(agentId: string): {
      refresh(): Promise<{ agent: DesignPaseoAgent } | null>;
      send(
        text: string,
        options: { messageId: string; activeTurnBehavior: "steer" },
      ): Promise<void>;
      archive(): Promise<unknown>;
      timeline: {
        refetch(options: {
          direction: "tail" | "before";
          cursor?: DesignTimelineCursor;
          limit: number;
          projection: "projected";
        }): Promise<DesignPaseoTimelinePayload>;
      };
    };
  };
}

export type DesignPaseoPermission = {
  id: string;
  kind: string;
  title?: string;
  description?: string;
};

export type DesignPaseoAgent = {
  id: string;
  status: DesignAgentStatus;
  labels: Record<string, string>;
  activeTurn?: { turnId: string } | null;
  archivedAt?: string | null;
  requiresAttention?: boolean;
  attentionReason?: "finished" | "error" | "permission" | null;
  pendingPermissions: ReadonlyArray<DesignPaseoPermission>;
  lastError?: string;
  providerUnavailable?: boolean;
};

export type DesignPaseoWorkspace = {
  id: string;
  name: string;
  title?: string | null;
  projectId: string;
  projectDisplayName: string;
  projectRootPath: string;
  workspaceDirectory?: string;
  internal?: boolean;
  archivingAt?: string | null;
  activityAt: string | null;
  background?: boolean;
  status: string;
};

export type DesignPaseoAgentCreateOptions = {
  agentId: string;
  idempotencyKey: string;
  clientMessageId: string;
  title: string;
  labels: Record<string, string>;
  prompt: string;
  config: {
    provider: string;
    modeId?: string;
    thinkingOptionId?: string;
    featureValues?: Record<string, unknown>;
    systemPrompt: string;
  };
};

export type DesignPaseoItem =
  | { type: "user_message"; text: string; messageId?: string; clientMessageId?: string }
  | { type: "assistant_message"; text: string; messageId?: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call" }
  | { type: "todo" }
  | { type: "error"; message: string }
  | { type: "notification"; level: "info" | "warning" | "error"; message: string }
  | { type: "compaction" }
  | { type: "plugin" };

export type DesignPaseoTimelineEntry = {
  seqStart: number;
  seqEnd: number;
  turnId?: string;
  item: DesignPaseoItem;
};

export type DesignPaseoTimelinePayload = {
  epoch: string;
  direction: "tail" | "before" | "after";
  projection: "projected" | "canonical";
  entries: ReadonlyArray<DesignPaseoTimelineEntry>;
  startCursor: DesignTimelineCursor | null;
  endCursor: DesignTimelineCursor | null;
  hasOlder: boolean;
  hasNewer: boolean;
  reset: boolean;
  gap: boolean;
  staleCursor: boolean;
};

export interface DesignAdapter {
  readConfig(): Promise<unknown>;
  listProviderAvailability(): Promise<
    ReadonlyArray<{ provider: string; available: boolean; reason?: string }>
  >;
  listRecentWorkspaces(input: { limit: number; cursor?: string }): Promise<DesignWorkspacePage>;
  getDesignWorkspace(workspaceId: string): Promise<DesignWorkspaceSummary | null>;
  createDesignAgent(input: CreateDesignAgentInput): Promise<{ agentId: string }>;
  getDesignAgent(agentId: string): Promise<DesignAgentSummary | null>;
  listDesignAgents(input: { cursor?: string; limit: number }): Promise<DesignAgentPage>;
  readDesignTimeline(input: DesignTimelineRequest): Promise<DesignTimelinePage>;
  sendDesignMessage(input: SendDesignMessageInput): Promise<void>;
  archiveDesignAgent(agentId: string): Promise<void>;
}

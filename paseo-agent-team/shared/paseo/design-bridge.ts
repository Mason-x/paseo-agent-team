import type { TeamMode } from "../schemas/team-mode";
import { asRecord } from "./adapter";
import {
  DESIGN_LABEL_KEYS,
  type DesignAdapter,
  type DesignAgentStatus,
  type DesignAgentSummary,
  type DesignTimelineCursor,
  type DesignTimelineItem as PortTimelineItem,
} from "./design-port";

export const BRIDGE_TIMELINE_PAGE_LIMIT = 100;
export const BRIDGE_DISCOVERY_PAGE_LIMIT = 100;

export type BridgedTimelineItem = {
  seqStart: number;
  seqEnd: number;
  type:
    | "user_message"
    | "assistant_message"
    | "tool_call"
    | "reasoning"
    | "plugin"
    | "error"
    | "notification";
  text?: string;
  messageId?: string;
  clientMessageId?: string;
  turnId?: string | null;
  level?: "error" | "info";
};

export type BridgedTimelinePage = {
  epoch: string;
  entries: BridgedTimelineItem[];
  hasOlder: boolean;
  hasNewer: boolean;
  gap: boolean;
  reset: boolean;
  staleCursor: boolean;
  beforeCursor: string | null;
};

export type BridgedAgentRefresh = {
  status: DesignAgentStatus | null;
  activeTurn: boolean;
  pendingPermissionCount: number;
  lastError: string | null;
};

export type BridgedTimelinePort = {
  refresh(agentId: string): Promise<BridgedAgentRefresh>;
  refetch(input: {
    agentId: string;
    cursor: string | null;
    direction: "before";
  }): Promise<BridgedTimelinePage>;
};

export type BridgedDiscoveredAgent = {
  agentId: string;
  labels: Record<string, string>;
  archived: boolean;
  status: DesignAgentStatus;
  pendingPermissions: Array<{ id: string; kind: string }>;
  attentionReason: "finished" | "error" | "permission" | null;
};

export type BridgedDiscoveryPort = {
  list(input: { cursor: string | null }): Promise<{
    agents: BridgedDiscoveredAgent[];
    nextCursor: string | null;
  }>;
  refresh(agentId: string): Promise<BridgedDiscoveredAgent | null>;
};

/** Machine-only labels for discovery and lookup; request text never enters a label. */
export function buildDesignLabels(input: {
  jobId: string;
  clientRequestId: string;
  requestHash: string;
  mode: TeamMode;
  /** Accepted for call-site compatibility; deliberately not emitted. */
  request?: string;
}): Record<string, string> {
  return {
    [DESIGN_LABEL_KEYS.job]: input.jobId,
    [DESIGN_LABEL_KEYS.version]: "1",
    [DESIGN_LABEL_KEYS.requestId]: input.clientRequestId,
    [DESIGN_LABEL_KEYS.requestHash]: input.requestHash,
    [DESIGN_LABEL_KEYS.mode]: input.mode,
  };
}

function encodeCursor(cursor: DesignTimelineCursor): string {
  return JSON.stringify({ epoch: cursor.epoch, seq: cursor.seq });
}

function decodeCursor(value: string): DesignTimelineCursor | null {
  try {
    const record = asRecord(JSON.parse(value));
    if (!record) return null;
    const epoch = record.epoch;
    const seq = record.seq;
    if (typeof epoch !== "string" || typeof seq !== "number") return null;
    if (!Number.isSafeInteger(seq) || seq < 0) return null;
    return { epoch, seq };
  } catch {
    return null;
  }
}

function bridgedItem(item: PortTimelineItem): BridgedTimelineItem {
  const result: BridgedTimelineItem = {
    seqStart: item.seqStart,
    seqEnd: item.seqEnd,
    type: item.type === "other" ? "plugin" : item.type,
  };
  if (item.text !== undefined) result.text = item.text;
  if (item.messageId !== undefined) result.messageId = item.messageId;
  if (item.clientMessageId !== undefined) result.clientMessageId = item.clientMessageId;
  if (item.turnId !== undefined) result.turnId = item.turnId;
  if (item.level !== undefined) result.level = item.level === "warning" ? "info" : item.level;
  return result;
}

function invalidTimelinePage(): BridgedTimelinePage {
  return {
    epoch: "",
    entries: [],
    hasOlder: false,
    hasNewer: false,
    gap: true,
    reset: false,
    staleCursor: true,
    beforeCursor: null,
  };
}

/** Adapts the design timeline port to G5's opaque-string cursor port. */
export function toTimelinePort(adapter: DesignAdapter): BridgedTimelinePort {
  return {
    async refresh(agentId) {
      const agent = await adapter.getDesignAgent(agentId);
      return agent
        ? {
            status: agent.status,
            activeTurn: agent.activeTurn,
            pendingPermissionCount: agent.pendingPermissions.length,
            lastError: agent.lastError,
          }
        : { status: null, activeTurn: false, pendingPermissionCount: 0, lastError: null };
    },

    async refetch(input) {
      const cursor = input.cursor === null ? null : decodeCursor(input.cursor);
      if (input.cursor !== null && cursor === null) return invalidTimelinePage();
      const page = await adapter.readDesignTimeline({
        agentId: input.agentId,
        direction: cursor ? "before" : "tail",
        ...(cursor ? { cursor } : {}),
        limit: BRIDGE_TIMELINE_PAGE_LIMIT,
      });
      const beforeCursor =
        page.hasOlder && page.startCursor ? encodeCursor(page.startCursor) : null;
      return {
        epoch: page.epoch,
        entries: page.entries.map(bridgedItem),
        hasOlder: page.hasOlder,
        hasNewer: page.hasNewer,
        gap: page.gap || (page.hasOlder && page.startCursor === null),
        reset: page.reset,
        staleCursor: page.staleCursor,
        beforeCursor,
      };
    },
  };
}

function bridgedAgent(agent: DesignAgentSummary): BridgedDiscoveredAgent {
  return {
    agentId: agent.id,
    labels: { ...agent.labels },
    archived: agent.archivedAt !== null,
    status: agent.status,
    pendingPermissions: agent.pendingPermissions.map(({ id, kind }) => ({ id, kind })),
    attentionReason: agent.attentionReason,
  };
}

/** Adapts the design agent list/refresh to G5's discovery port. */
export function toDiscoveryPort(adapter: DesignAdapter): BridgedDiscoveryPort {
  return {
    async list(input) {
      const page = await adapter.listDesignAgents({
        limit: BRIDGE_DISCOVERY_PAGE_LIMIT,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
      if (page.hasMore && page.nextCursor === null)
        throw new Error("design agent page is incomplete");
      return {
        agents: page.agents.map(bridgedAgent),
        nextCursor: page.hasMore ? page.nextCursor : null,
      };
    },

    async refresh(agentId) {
      const agent = await adapter.getDesignAgent(agentId);
      return agent ? bridgedAgent(agent) : null;
    },
  };
}

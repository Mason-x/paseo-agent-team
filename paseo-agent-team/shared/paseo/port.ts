/**
 * The slice of the Paseo client API this plugin depends on.
 *
 * Client code passes `usePaseo()` and server code passes `context.paseo`; both are the same
 * `PaseoApi` and satisfy this interface structurally. Keeping the dependency this narrow means
 * a Paseo upgrade only needs attention when one of these calls changes, and the typecheck
 * points at exactly that call. Shared modules cannot import `@getpaseo/client` types: the host
 * compiler walks type imports and the package is a dev-only dependency.
 */
export interface PaseoPort {
  readonly config: {
    get(): Promise<{ config: unknown }>;
  };
  readonly providers: {
    listAvailable(): Promise<{
      providers: ReadonlyArray<{ provider: string; available: boolean; error?: string | null }>;
    }>;
  };
  readonly projects: {
    list(): Promise<{
      projects: ReadonlyArray<{
        projectId: string;
        projectDisplayName: string;
        projectRootPath: string;
        projectKind: "git" | "non_git" | "directory";
      }>;
    }>;
  };
  readonly workspaces: {
    list(options: { page: { limit: number; cursor?: string } }): Promise<{
      entries: ReadonlyArray<PortWorkspace>;
      pageInfo: { hasMore: boolean; nextCursor?: string | null };
    }>;
    ref(workspaceId: string): {
      readonly agents: {
        create(options: PortAgentCreateOptions): Promise<{ readonly id: string }>;
      };
      refresh(): Promise<PortWorkspace | null>;
    };
    create(options: { title: string; source: PortWorkspaceSource }): Promise<{
      readonly id: string;
      readonly name: string | null;
      readonly projectId: string | null;
      readonly directory: string | null;
      current(): PortWorkspace | null;
      refresh(): Promise<PortWorkspace | null>;
    }>;
  };
  readonly agents: {
    ref(agentId: string): PortAgentHandle;
  };
}

/** What happens to a message that arrives while the agent is mid-turn. Never rely on the default. */
export type PortActiveTurnBehavior = "interrupt" | "steer";

export type PortSendOptions = {
  /**
   * Caller-chosen id the timeline echoes on the `user_message`. Re-sending the same id with the
   * same options is deduplicated by the host; the same id with different options is rejected
   * (`agent_request_key_conflict`), so a retry must repeat the original options exactly.
   */
  messageId?: string;
  activeTurnBehavior?: PortActiveTurnBehavior;
};

export type PortTimelineCursor = { epoch: string; seq: number };

export type PortTimelineRefetchOptions = {
  direction?: "tail" | "before" | "after";
  cursor?: PortTimelineCursor;
  limit?: number;
  projection?: "canonical" | "projected";
};

/** One canonical timeline page, reduced to the fields the observer reads. */
export type PortTimelinePage = {
  entries: ReadonlyArray<{
    item: { type: string; text?: string; messageId?: string; clientMessageId?: string };
    turnId?: string;
    seqStart: number;
    seqEnd: number;
  }>;
  epoch: string;
  startCursor: PortTimelineCursor | null;
  hasOlder: boolean;
  hasNewer: boolean;
  gap: boolean;
  staleCursor: boolean;
  reset: boolean;
};

/** Last snapshot the host reported for an agent; the facts used to prove quiescence. */
export type PortAgentSnapshot = {
  status: string;
  activeTurn?: unknown;
  lastError?: unknown;
  pendingPermissions?: unknown;
};

/** What the launch path may do to an agent. It cannot read timelines or status. */
export interface PortAgentHandle {
  send(text: string, options?: PortSendOptions): Promise<void>;
  archive(): Promise<unknown>;
}

/**
 * What the Run Engine reads and sends through. A superset of `PortAgentHandle`, kept separate so
 * the launch code and its fakes stay unable to observe agents. The real `PaseoApi` satisfies both.
 */
export interface PortEngineAgentHandle extends PortAgentHandle {
  readonly timeline: {
    refetch(options?: PortTimelineRefetchOptions): Promise<PortTimelinePage>;
  };
  /** Cached snapshot; `null` until the handle has observed one. */
  current(): PortAgentSnapshot | null;
  refresh(): Promise<{ agent: PortAgentSnapshot } | null>;
}

/** Engine-side port: the same `context.paseo`, seen through the wider agent handle. */
export interface PaseoEnginePort {
  readonly agents: { ref(agentId: string): PortEngineAgentHandle };
}

export type PortWorkspace = {
  id: string;
  name: string;
  title?: string | null;
  projectId: string;
  projectDisplayName: string;
  projectRootPath: string;
  workspaceDirectory?: string;
};

export type PortWorkspaceSource =
  | { kind: "worktree"; projectId: string; cwd: string; action: "branch-off" }
  | { kind: "directory"; path: string; projectId: string };

export type PortMcpServer =
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      alwaysLoad?: boolean;
    }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string>; alwaysLoad?: boolean };

export type PortAgentCreateOptions = {
  /**
   * Repeating a create with the same key and configuration returns the same agent, which is how
   * an unknown create result is checked. Same key with different configuration is unverified.
   */
  idempotencyKey?: string;
  parent?: string;
  title?: string;
  labels?: Record<string, string>;
  prompt?: string;
  config: {
    /** `provider` or `provider/model`. */
    provider: string;
    modeId?: string;
    thinkingOptionId?: string;
    featureValues?: Record<string, unknown>;
    systemPrompt?: string;
    mcpServers?: Record<string, PortMcpServer>;
  };
};

/** Team-designer client port and its pure Paseo projection. */
export { createDesignAdapter } from "./design-adapter";
export type * from "./design-port";

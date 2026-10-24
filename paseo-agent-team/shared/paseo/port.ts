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
    ref(agentId: string): {
      send(text: string): Promise<void>;
      archive(): Promise<unknown>;
    };
  };
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

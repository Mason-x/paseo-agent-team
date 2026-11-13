import type { AgentSpec } from "../shared/run";

export type SetupStatus = "running" | "completed" | "failed" | "blocked" | null;
export type AgentInfo = {
  exists: boolean;
  archived: boolean;
  status: "initializing" | "idle" | "running" | "error" | "closed" | null;
  pendingPermissions: number;
};

/**
 * Everything the engine needs from Paseo. The real implementation wraps the plugin SDK
 * (0.15.4 behaviour, see docs/v2/m1a-results.md); tests use an in-memory fake.
 */
export interface Host {
  createWorkspace(o: {
    sourceCheckout: string;
    baseBranch: string;
    branchName: string;
    background: boolean;
  }): Promise<{ id: string; path: string }>;
  /** `null` right after creation or when the repo has no setup. */
  setupStatus(workspaceId: string): Promise<SetupStatus>;
  archiveWorkspace(workspaceId: string): Promise<void>;
  /** Includes background workspaces. `name` equals the branch name for worktrees. */
  listWorkspaces(): Promise<{ id: string; name: string; path: string | null }[]>;
  /** The agent is created inside this workspace, so archiving the workspace releases its worktree. */
  createAgent(o: {
    agentId: string;
    workspaceId: string;
    spec: AgentSpec;
    title: string;
    prompt: string;
    labels: Record<string, string>;
  }): Promise<void>;
  send(agentId: string, text: string): Promise<void>;
  archiveAgent(agentId: string): Promise<void>;
  agent(agentId: string): Promise<AgentInfo>;
  respondToPermission(agentId: string, requestId: string): Promise<void>;
  /** The daemon configuration as the SDK returns it; the shape differs between versions. */
  config(): Promise<unknown>;
}

/**
 * The slice of the plugin SDK client this module calls. `context.paseo` satisfies it structurally;
 * importing `@getpaseo/client` types is not allowed here (the host compiler cannot resolve them).
 */
export interface PaseoPort {
  readonly config: { get(): Promise<{ config: unknown }> };
  readonly workspaces: {
    create(options: {
      background: boolean;
      source: {
        kind: "worktree";
        cwd: string;
        action: "branch-off";
        baseBranch: string;
        branchName: string;
      };
    }): Promise<{ readonly id: string; readonly directory: string | null }>;
    list(options: { includeBackground: boolean }): Promise<{
      entries: ReadonlyArray<{
        id: string;
        name: string;
        workspaceDirectory?: string;
        setupStatus?: SetupStatus;
      }>;
    }>;
    archive(id: string): Promise<{ error: string | null }>;
    ref(id: string): {
      readonly agents: {
        create(options: {
          agentId: string;
          title: string;
          prompt: string;
          labels: Record<string, string>;
          config: {
            provider: string;
            modeId?: string;
            thinkingOptionId?: string;
            featureValues?: never;
          };
        }): Promise<unknown>;
      };
    };
  };
  readonly agents: {
    ref(id: string): {
      send(text: string, options?: { activeTurnBehavior?: "interrupt" | "steer" }): Promise<void>;
      archive(): Promise<unknown>;
      refresh(): Promise<{
        agent: {
          status: NonNullable<AgentInfo["status"]>;
          archivedAt?: string | null;
          pendingPermissions?: ReadonlyArray<unknown>;
        };
      } | null>;
      respondToPermission(options: {
        requestId: string;
        response: { behavior: "allow" };
      }): Promise<void>;
    };
  };
}

export function fromPaseo(paseo: PaseoPort): Host {
  const listAll = async () => (await paseo.workspaces.list({ includeBackground: true })).entries;
  return {
    async createWorkspace(o) {
      const ws = await paseo.workspaces.create({
        background: o.background,
        source: {
          kind: "worktree",
          cwd: o.sourceCheckout,
          action: "branch-off",
          baseBranch: o.baseBranch,
          branchName: o.branchName,
        },
      });
      if (!ws.directory) throw new Error(`workspace ${ws.id} has no directory`);
      return { id: ws.id, path: ws.directory };
    },
    async setupStatus(id) {
      return (await listAll()).find((w) => w.id === id)?.setupStatus ?? null;
    },
    async archiveWorkspace(id) {
      const r = await paseo.workspaces.archive(id);
      if (r.error) throw new Error(r.error);
    },
    async listWorkspaces() {
      return (await listAll()).map((w) => ({
        id: w.id,
        name: w.name,
        path: w.workspaceDirectory ?? null,
      }));
    },
    async createAgent(o) {
      await paseo.workspaces.ref(o.workspaceId).agents.create({
        agentId: o.agentId,
        title: o.title,
        prompt: o.prompt,
        labels: o.labels,
        config: {
          provider: o.spec.provider,
          modeId: o.spec.modeId,
          thinkingOptionId: o.spec.thinkingOptionId,
          featureValues: o.spec.featureValues as never,
        },
      });
    },
    async send(agentId, text) {
      await paseo.agents.ref(agentId).send(text, { activeTurnBehavior: "steer" });
    },
    async archiveAgent(agentId) {
      await paseo.agents.ref(agentId).archive();
    },
    async agent(agentId) {
      // Only "unknown agent" means it is gone. Any other failure must not read as a death.
      const r = await paseo.agents
        .ref(agentId)
        .refresh()
        .catch((e: unknown) => {
          if (/unknown agent|not found/i.test(e instanceof Error ? e.message : String(e)))
            return null;
          throw e;
        });
      if (!r) return { exists: false, archived: false, status: null, pendingPermissions: 0 };
      const a = r.agent;
      return {
        exists: true,
        archived: Boolean(a.archivedAt),
        status: a.status,
        pendingPermissions: a.pendingPermissions?.length ?? 0,
      };
    },
    async config() {
      return (await paseo.config.get()).config;
    },
    async respondToPermission(agentId, requestId) {
      await paseo.agents
        .ref(agentId)
        .respondToPermission({ requestId, response: { behavior: "allow" } });
    },
  };
}

const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;

/**
 * Why the plugin's `team_*` tools would not reach the agents of these providers, or null.
 * Only an explicit `false` blocks: an unfamiliar config shape must not stop a launch (Spec 3.3).
 */
export function toolsBlocker(config: unknown, providers: string[]): string | null {
  const root = record(config);
  const mcp = record(root?.mcp);
  if (mcp?.enabled === false)
    return "Paseo 的 MCP 服务已关闭，插件工具到不了 agent。请先打开 MCP。";
  if (mcp?.injectIntoAgents === false) {
    return "Paseo 设置里关闭了“向 agent 注入 Paseo 工具”，写手和审查者拿不到 team_* 工具。请打开后再启动。";
  }
  for (const spec of providers) {
    const key = spec.split("/")[0] ?? spec;
    const tools = record(record(record(root?.providers)?.[key])?.paseoTools);
    if (tools?.enabled === false)
      return `${key} 的“启用 Paseo 工具”被关闭了，该 provider 的 agent 拿不到 team_* 工具。`;
  }
  return null;
}

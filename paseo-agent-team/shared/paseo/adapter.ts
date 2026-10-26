import type { McpServers } from "../schemas/role";
import type { PaseoPort, PortMcpServer, PortWorkspace, PortWorkspaceSource } from "./port";

export type PaseoProfile = {
  id: string;
  name: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  notes?: string;
  icon?: string;
  color?: string;
};

export type ProviderAvailability = {
  provider: string;
  available: boolean;
  reason?: string;
};

export type WorkspaceSummary = {
  id: string;
  name: string;
  projectId?: string;
  projectName?: string;
  directory?: string;
};

export type ProjectSummary = {
  id: string;
  name: string;
  directory: string;
  kind?: "git" | "non_git" | "directory";
};

export type CreateWorkspaceInput = {
  title: string;
  project: ProjectSummary;
};

export function workspaceCreateSource(project: ProjectSummary): PortWorkspaceSource {
  if (!project.directory.trim()) {
    throw new Error("无法新建 Workspace：项目没有目录路径");
  }
  if (project.kind === "git") {
    return {
      kind: "worktree",
      projectId: project.id,
      cwd: project.directory,
      action: "branch-off",
    };
  }
  return {
    kind: "directory",
    path: project.directory,
    projectId: project.id,
  };
}

/** Roles accept Claude-style stdio entries without `type`; Paseo's create schema requires it. */
export function toPaseoMcpServers(
  servers: McpServers | undefined,
): Record<string, PortMcpServer> | undefined {
  if (!servers || Object.keys(servers).length === 0) return undefined;
  const normalized: Record<string, PortMcpServer> = {};
  for (const [name, server] of Object.entries(servers)) {
    normalized[name] = "command" in server ? { ...server, type: "stdio" } : server;
  }
  return normalized;
}

export type CreateMemberInput = {
  workspaceId: string;
  parentAgentId?: string;
  title: string;
  labels: Record<string, string>;
  systemPrompt: string;
  profile: PaseoProfile;
  mcpServers?: McpServers;
  prompt?: string;
};

export type ProfilesUnavailableError = Error & { code: "profiles-unavailable" };

export function profilesUnavailable(message: string): ProfilesUnavailableError {
  const error = new Error(message) as ProfilesUnavailableError;
  error.code = "profiles-unavailable";
  return error;
}

export interface PaseoAdapter {
  /** Raw daemon config. Callers read it defensively: its shape is daemon-owned. */
  readConfig(): Promise<unknown>;
  listProfiles(): Promise<PaseoProfile[]>;
  listProviderAvailability(): Promise<ProviderAvailability[]>;
  listWorkspaces(): Promise<WorkspaceSummary[]>;
  getWorkspace(workspaceId: string): Promise<WorkspaceSummary | null>;
  listProjects(): Promise<ProjectSummary[]>;
  createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceSummary>;
  createAgent(input: CreateMemberInput): Promise<{ agentId: string }>;
  sendMessage(agentId: string, text: string): Promise<void>;
  archiveAgent(agentId: string): Promise<void>;
}

const WORKSPACE_PAGE_LIMIT = 200;
const WORKSPACE_MAX_PAGES = 10;

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function mapProfile(value: unknown): PaseoProfile | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = optionalString(record.id) ?? "";
  const name = optionalString(record.name) ?? "";
  const provider = optionalString(record.provider) ?? "";
  if (!id || !name || !provider) return null;
  return {
    id,
    name,
    provider,
    model: optionalString(record.model),
    modeId: optionalString(record.modeId),
    thinkingOptionId: optionalString(record.thinkingOptionId),
    featureValues: asRecord(record.featureValues) ?? undefined,
    notes: optionalString(record.notes),
    icon: optionalString(record.icon),
    color: optionalString(record.color),
  };
}

/** Agent Profiles from the daemon config, skipping malformed entries. */
export function profilesFromConfig(config: unknown): PaseoProfile[] {
  const raw = asRecord(config)?.agentProfiles;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const profile = mapProfile(entry);
    return profile ? [profile] : [];
  });
}

export function profileProvider(profile: Pick<PaseoProfile, "provider" | "model">): string {
  return profile.model ? `${profile.provider}/${profile.model}` : profile.provider;
}

function workspaceSummary(workspace: PortWorkspace): WorkspaceSummary {
  return {
    id: workspace.id,
    name: workspace.title?.trim() || workspace.name,
    projectId: workspace.projectId,
    projectName: workspace.projectDisplayName,
    directory: workspace.workspaceDirectory ?? workspace.projectRootPath,
  };
}

export function createPaseoAdapter(paseo: PaseoPort): PaseoAdapter {
  async function readConfig() {
    const result = await paseo.config.get();
    return result.config;
  }

  async function listWorkspaces() {
    const workspaces: WorkspaceSummary[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < WORKSPACE_MAX_PAGES; page += 1) {
      const result = await paseo.workspaces.list({
        page: { limit: WORKSPACE_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
      });
      workspaces.push(...result.entries.map(workspaceSummary));
      cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
      if (!cursor) break;
    }
    return workspaces;
  }

  return {
    readConfig,

    async listProfiles() {
      try {
        return profilesFromConfig(await readConfig());
      } catch (error) {
        throw profilesUnavailable(
          error instanceof Error ? error.message : "无法读取 Paseo Profile",
        );
      }
    },

    async listProviderAvailability() {
      const result = await paseo.providers.listAvailable();
      return result.providers.map((entry) => ({
        provider: entry.provider,
        available: entry.available,
        reason: entry.error ?? undefined,
      }));
    },

    listWorkspaces,

    async getWorkspace(workspaceId: string) {
      try {
        const workspace = await paseo.workspaces.ref(workspaceId).refresh();
        return workspace ? workspaceSummary(workspace) : null;
      } catch {
        return null;
      }
    },

    async listProjects() {
      try {
        const result = await paseo.projects.list();
        if (result.projects.length > 0) {
          return result.projects.map((project) => ({
            id: project.projectId,
            name: project.projectDisplayName,
            directory: project.projectRootPath,
            kind: project.projectKind,
          }));
        }
      } catch {
        // Fall back to unique projects from the workspace list.
      }
      const unique = new Map<string, ProjectSummary>();
      for (const workspace of await listWorkspaces()) {
        if (!workspace.projectId || unique.has(workspace.projectId)) continue;
        unique.set(workspace.projectId, {
          id: workspace.projectId,
          name: workspace.projectName ?? workspace.name,
          directory: workspace.directory ?? "",
        });
      }
      return [...unique.values()];
    },

    async createWorkspace(input: CreateWorkspaceInput) {
      const project = input.project;
      const handle = await paseo.workspaces.create({
        title: input.title,
        source: workspaceCreateSource(project),
      });
      const snapshot = handle.current() ?? (await handle.refresh());
      if (snapshot) return workspaceSummary(snapshot);
      return {
        id: handle.id,
        name: handle.name ?? input.title,
        projectId: handle.projectId ?? project.id,
        projectName: project.name,
        directory: handle.directory ?? project.directory,
      };
    },

    async createAgent(input: CreateMemberInput) {
      const created = await paseo.workspaces.ref(input.workspaceId).agents.create({
        parent: input.parentAgentId,
        title: input.title.slice(0, 60),
        labels: input.labels,
        prompt: input.prompt,
        config: {
          provider: profileProvider(input.profile),
          modeId: input.profile.modeId,
          thinkingOptionId: input.profile.thinkingOptionId,
          featureValues: input.profile.featureValues,
          systemPrompt: input.systemPrompt,
          mcpServers: toPaseoMcpServers(input.mcpServers),
        },
      });
      return { agentId: created.id };
    },

    async sendMessage(agentId: string, text: string) {
      await paseo.agents.ref(agentId).send(text);
    },

    async archiveAgent(agentId: string) {
      await paseo.agents.ref(agentId).archive();
    },
  };
}

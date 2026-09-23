import type { usePaseo } from "@getpaseo/plugin/client";
import type { McpServers } from "../../shared/schemas/role";

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

export function workspaceCreateSource(project: ProjectSummary) {
  if (!project.directory.trim()) {
    throw new Error("无法新建 Workspace：项目没有目录路径");
  }
  if (project.kind === "git") {
    return {
      kind: "worktree" as const,
      projectId: project.id,
      cwd: project.directory,
      action: "branch-off" as const,
    };
  }
  return {
    kind: "directory" as const,
    path: project.directory,
    projectId: project.id,
  };
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
  listProfiles(): Promise<PaseoProfile[]>;
  listProviderAvailability(): Promise<ProviderAvailability[]>;
  listWorkspaces(): Promise<WorkspaceSummary[]>;
  listProjects(): Promise<ProjectSummary[]>;
  createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceSummary>;
  coordinatorToolsHint(provider: string): Promise<string | null>;
  createAgent(input: CreateMemberInput): Promise<{ agentId: string }>;
  sendMessage(agentId: string, text: string): Promise<void>;
  archiveAgent(agentId: string): Promise<void>;
}

type PaseoClient = ReturnType<typeof usePaseo>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function mapProfile(value: unknown): PaseoProfile | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = typeof record.id === "string" ? record.id : "";
  const name = typeof record.name === "string" ? record.name : "";
  const provider = typeof record.provider === "string" ? record.provider : "";
  if (!id || !name || !provider) return null;
  return {
    id,
    name,
    provider,
    model: typeof record.model === "string" ? record.model : undefined,
    modeId: typeof record.modeId === "string" ? record.modeId : undefined,
    thinkingOptionId:
      typeof record.thinkingOptionId === "string" ? record.thinkingOptionId : undefined,
    featureValues: asRecord(record.featureValues) ?? undefined,
    notes: typeof record.notes === "string" ? record.notes : undefined,
    icon: typeof record.icon === "string" ? record.icon : undefined,
    color: typeof record.color === "string" ? record.color : undefined,
  };
}

export function createPaseoAdapter(paseo: PaseoClient): PaseoAdapter {
  async function listWorkspaces() {
    const workspaces: WorkspaceSummary[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await paseo.workspaces.list({
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      for (const workspace of result.entries) {
        workspaces.push({
          id: workspace.id,
          name: workspace.name,
          projectId: workspace.projectId,
          projectName: workspace.projectDisplayName,
          directory: workspace.workspaceDirectory ?? workspace.projectRootPath,
        });
      }
      cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
      if (!cursor) break;
    }
    return workspaces;
  }

  return {
    async listProfiles() {
      try {
        const result = await paseo.config.get();
        const config = asRecord(result.config) ?? asRecord(result) ?? {};
        const raw = config.agentProfiles;
        if (!Array.isArray(raw)) return [];
        return raw.flatMap((entry) => {
          const profile = mapProfile(entry);
          return profile ? [profile] : [];
        });
      } catch (error) {
        throw profilesUnavailable(
          error instanceof Error ? error.message : "无法读取 Paseo Profile",
        );
      }
    },

    async listProviderAvailability() {
      const result = await paseo.providers.listAvailable();
      const providers = Array.isArray(result.providers) ? result.providers : [];
      return providers.map((entry) => ({
        provider: entry.provider,
        available: entry.available,
        reason: entry.error ?? undefined,
      }));
    },

    listWorkspaces,

    async listProjects() {
      try {
        const result = await paseo.projects.list();
        const projects = Array.isArray(result.projects) ? result.projects : [];
        if (projects.length > 0) {
          return projects.map((project) => ({
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
      return {
        id: handle.id,
        name: snapshot?.name ?? handle.name ?? input.title,
        projectId: snapshot?.projectId ?? handle.projectId ?? project.id,
        projectName: snapshot?.projectDisplayName ?? project.name,
        directory: snapshot?.workspaceDirectory ?? handle.directory ?? project.directory,
      };
    },

    async coordinatorToolsHint(provider: string) {
      try {
        const result = await paseo.config.get();
        const config = asRecord(result.config) ?? asRecord(result) ?? {};
        const providers = asRecord(config.providers);
        const entry = providers ? asRecord(providers[provider]) : null;
        const tools = entry ? asRecord(entry.paseoTools) : null;
        if (tools && tools.enabled === false) {
          return `Provider ${provider} has Paseo tools disabled; the coordinator cannot delegate.`;
        }
        if (!tools || typeof tools.enabled !== "boolean") {
          return `Confirm that provider ${provider} has Paseo tools enabled so the coordinator can delegate.`;
        }
        return null;
      } catch {
        return `Confirm that provider ${provider} has Paseo tools enabled so the coordinator can delegate.`;
      }
    },

    async createAgent(input: CreateMemberInput) {
      const created = await paseo.workspaces.ref(input.workspaceId).agents.create({
        parent: input.parentAgentId,
        title: input.title.slice(0, 60),
        labels: input.labels,
        prompt: input.prompt,
        config: {
          provider: input.profile.model
            ? `${input.profile.provider}/${input.profile.model}`
            : input.profile.provider,
          modeId: input.profile.modeId,
          thinkingOptionId: input.profile.thinkingOptionId,
          featureValues: input.profile.featureValues,
          systemPrompt: input.systemPrompt,
          mcpServers: input.mcpServers as never,
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

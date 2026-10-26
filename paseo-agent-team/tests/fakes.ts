import { vi } from "vitest";
import type { PaseoPort, PortAgentCreateOptions, PortWorkspace } from "../shared/paseo/port";
import type { Preferences } from "../shared/schemas/preferences";
import { claudeOpus, codexXhigh } from "./fixtures";

export const workspace: PortWorkspace = {
  id: "ws-1",
  name: "main",
  title: null,
  projectId: "p1",
  projectDisplayName: "Project",
  projectRootPath: "/repo",
  workspaceDirectory: "/repo",
};

/** A daemon config where both fixture providers can delegate. */
export const healthyConfig = {
  agentProfiles: [claudeOpus, codexXhigh],
  mcp: { enabled: true, injectIntoAgents: true },
};

export const preferences: Preferences = {
  maxMembers: 8,
  archiveOnLaunchFailure: true,
  recentRuns: [],
};

export type CreatedAgent = { workspaceId: string; options: PortAgentCreateOptions; id: string };

/** Records what the plugin asks Paseo to do; override any `vi.fn` per test. */
export function fakePort(config: unknown = healthyConfig) {
  const created: CreatedAgent[] = [];
  const sent: Array<{ agentId: string; text: string }> = [];
  const archived: string[] = [];
  let nextAgent = 0;

  const refresh = vi.fn<() => Promise<PortWorkspace | null>>(async () => workspace);
  const create = vi.fn(async (workspaceId: string, options: PortAgentCreateOptions) => {
    nextAgent += 1;
    const id = options.parent ? `member-${nextAgent}` : `coord-${nextAgent}`;
    created.push({ workspaceId, options, id });
    return { id };
  });

  const port = {
    config: {
      get: vi.fn<PaseoPort["config"]["get"]>(async () => ({ config })),
    },
    providers: {
      listAvailable: vi.fn<PaseoPort["providers"]["listAvailable"]>(async () => ({
        providers: [
          { provider: "claude", available: true },
          { provider: "codex", available: true },
        ],
      })),
    },
    projects: {
      list: vi.fn<PaseoPort["projects"]["list"]>(async () => ({
        projects: [
          {
            projectId: "p1",
            projectDisplayName: "Project",
            projectRootPath: "/repo",
            projectKind: "git",
          },
        ],
      })),
    },
    workspaces: {
      list: vi.fn<PaseoPort["workspaces"]["list"]>(async () => ({
        entries: [workspace],
        pageInfo: { hasMore: false },
      })),
      ref: vi.fn<PaseoPort["workspaces"]["ref"]>((workspaceId) => ({
        agents: { create: (options) => create(workspaceId, options) },
        refresh,
      })),
      create: vi.fn<PaseoPort["workspaces"]["create"]>(async () => ({
        id: "ws-new",
        name: "New",
        projectId: "p1",
        directory: "/repo/new",
        current: () => ({ ...workspace, id: "ws-new", name: "New" }),
        refresh: async () => null,
      })),
    },
    agents: {
      ref: vi.fn<PaseoPort["agents"]["ref"]>((agentId) => ({
        send: async (text) => {
          sent.push({ agentId, text });
        },
        archive: async () => {
          archived.push(agentId);
          return {};
        },
      })),
    },
  } satisfies PaseoPort;

  return { port, created, sent, archived, refresh, create };
}

export function ready<Values>(values: Values) {
  return { read: async () => ({ status: "ready" as const, values }) };
}

export function invalid(error = "unreadable") {
  return { read: async () => ({ status: "invalid" as const, error }) };
}

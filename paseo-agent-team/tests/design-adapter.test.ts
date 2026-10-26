// biome-ignore lint/style/noRestrictedImports: compile-time proof that the host SDK satisfies the structural design port.
import type { PaseoApi } from "@getpaseo/client";
import { describe, expect, test, vi } from "vitest";
import { createDesignAdapter } from "../shared/paseo/design-adapter";
import type {
  DesignPaseoAgent,
  DesignPaseoAgentCreateOptions,
  DesignPaseoPort,
  DesignPaseoTimelinePayload,
  DesignPaseoWorkspace,
} from "../shared/paseo/design-port";

const WORKSPACE: DesignPaseoWorkspace = {
  id: "workspace-1",
  name: "工作区",
  title: "目标工作区",
  projectId: "project-1",
  projectDisplayName: "项目",
  projectRootPath: "/repo",
  workspaceDirectory: "/repo/work",
  internal: false,
  archivingAt: null,
  activityAt: "2026-10-25T00:00:00.000Z",
  background: false,
  status: "running",
};

const RAW_PERMISSION = {
  id: "permission-1",
  kind: "tool",
  title: "Approve",
  description: "Run a tool",
  input: { secret: "PERMISSION_RAW" },
  detail: { secret: "PERMISSION_DETAIL" },
};

const AGENT: DesignPaseoAgent = {
  id: "agent-1",
  status: "idle",
  labels: { "agent-team.design": "job-1", "agent-team.design.version": "1" },
  activeTurn: { turnId: "turn-1" },
  archivedAt: null,
  requiresAttention: true,
  attentionReason: "finished",
  pendingPermissions: [RAW_PERMISSION],
  lastError: "safe summary",
  providerUnavailable: false,
};

const EMPTY_TIMELINE: DesignPaseoTimelinePayload = {
  epoch: "epoch-1",
  direction: "tail",
  projection: "projected",
  entries: [],
  startCursor: null,
  endCursor: null,
  hasOlder: false,
  hasNewer: false,
  reset: false,
  gap: false,
  staleCursor: false,
};

type PortOverrides = {
  configGet?: DesignPaseoPort["config"]["get"];
  listAvailable?: DesignPaseoPort["providers"]["listAvailable"];
  workspaceList?: DesignPaseoPort["workspaces"]["list"];
  workspaceRef?: DesignPaseoPort["workspaces"]["ref"];
  agentList?: DesignPaseoPort["agents"]["list"];
  agentRef?: DesignPaseoPort["agents"]["ref"];
};

function basePort(overrides: PortOverrides = {}): DesignPaseoPort {
  return {
    config: {
      get: overrides.configGet ?? (async () => ({ config: {} })),
    },
    providers: {
      listAvailable: overrides.listAvailable ?? (async () => ({ providers: [] })),
    },
    workspaces: {
      list:
        overrides.workspaceList ??
        (async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } })),
      ref:
        overrides.workspaceRef ??
        (() => ({
          refresh: async () => null,
          agents: { create: async () => ({ id: "created" }) },
        })),
    },
    agents: {
      list:
        overrides.agentList ??
        (async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } })),
      ref:
        overrides.agentRef ??
        (() => ({
          refresh: async () => null,
          send: async () => {},
          archive: async () => ({}),
          timeline: { refetch: async () => EMPTY_TIMELINE },
        })),
    },
  };
}

describe("design adapter", () => {
  test("reads config once and maps provider availability without leaking the error field", async () => {
    const get = vi.fn(async () => ({
      config: { agentProfiles: [{ id: "profile-1" }] },
    }));
    const listAvailable = vi.fn(async () => ({
      providers: [
        { provider: "claude", available: true, error: null },
        { provider: "codex", available: false, error: "down" },
      ],
    }));
    const adapter = createDesignAdapter(basePort({ configGet: get, listAvailable }));

    expect(await adapter.readConfig()).toEqual({ agentProfiles: [{ id: "profile-1" }] });
    expect(get).toHaveBeenCalledTimes(1);
    expect(await adapter.listProviderAvailability()).toEqual([
      { provider: "claude", available: true },
      { provider: "codex", available: false, reason: "down" },
    ]);
  });

  test("maps workspace pages and refreshes one workspace without creating one", async () => {
    const list = vi.fn(async (_options: Parameters<DesignPaseoPort["workspaces"]["list"]>[0]) => ({
      entries: [WORKSPACE],
      pageInfo: { hasMore: true, nextCursor: "next-page" },
    }));
    const refresh = vi.fn(async () => WORKSPACE);
    const adapter = createDesignAdapter(
      basePort({
        workspaceList: list,
        workspaceRef: (id) => ({ refresh, agents: { create: async () => ({ id: id }) } }),
      }),
    );

    expect(await adapter.listRecentWorkspaces({ limit: 50, cursor: "page-1" })).toEqual({
      workspaces: [
        {
          id: "workspace-1",
          name: "目标工作区",
          title: "目标工作区",
          projectId: "project-1",
          projectName: "项目",
          directory: "/repo/work",
          internal: false,
          archivingAt: null,
          activityAt: "2026-10-25T00:00:00.000Z",
          background: false,
          status: "running",
        },
      ],
      nextCursor: "next-page",
      hasMore: true,
    });
    expect(list).toHaveBeenCalledWith({
      page: { limit: 50, cursor: "page-1" },
      sort: [{ key: "activity_at", direction: "desc" }],
    });

    expect(await adapter.getDesignWorkspace("workspace-1")).toMatchObject({
      id: "workspace-1",
      directory: "/repo/work",
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("returns null only when refresh finds no workspace and propagates read failures", async () => {
    const missing = createDesignAdapter(
      basePort({
        workspaceRef: () => ({
          refresh: async () => null,
          agents: { create: async () => ({ id: "x" }) },
        }),
      }),
    );
    expect(await missing.getDesignWorkspace("gone")).toBeNull();

    const broken = createDesignAdapter(
      basePort({
        workspaceRef: () => ({
          refresh: async () => {
            throw new Error("workspace read failed");
          },
          agents: { create: async () => ({ id: "x" }) },
        }),
      }),
    );
    await expect(broken.getDesignWorkspace("broken")).rejects.toThrow("workspace read failed");
  });

  test("passes fixed create identity and every profile field through", async () => {
    const create = vi.fn(async (_options: DesignPaseoAgentCreateOptions) => ({
      id: "created-agent",
    }));
    let seenWorkspace = "";
    const adapter = createDesignAdapter(
      basePort({
        workspaceRef: (id) => {
          seenWorkspace = id;
          return { refresh: async () => WORKSPACE, agents: { create } };
        },
      }),
    );

    const result = await adapter.createDesignAgent({
      agentId: "agent-fixed",
      idempotencyKey: "agent-team-design:job-1",
      workspaceId: "workspace-1",
      title: "设计团队",
      labels: {
        "agent-team.design": "job-1",
        "agent-team.design.version": "1",
      },
      profile: {
        provider: "claude",
        model: "opus",
        modeId: "auto",
        thinkingOptionId: "max",
        featureValues: { fast: true },
      },
      systemPrompt: "system",
      prompt: "kickoff",
      clientMessageId: "message-1",
    });

    expect(result).toEqual({ agentId: "created-agent" });
    expect(seenWorkspace).toBe("workspace-1");
    expect(create).toHaveBeenCalledWith({
      agentId: "agent-fixed",
      idempotencyKey: "agent-team-design:job-1",
      clientMessageId: "message-1",
      title: "设计团队",
      labels: {
        "agent-team.design": "job-1",
        "agent-team.design.version": "1",
      },
      prompt: "kickoff",
      config: {
        provider: "claude/opus",
        modeId: "auto",
        thinkingOptionId: "max",
        featureValues: { fast: true },
        systemPrompt: "system",
      },
    });
  });

  test("maps refreshed agents to safe summaries and never exposes raw permission payloads", async () => {
    const adapter = createDesignAdapter(
      basePort({
        agentRef: () => ({
          refresh: async () => ({ agent: AGENT }),
          send: async () => {},
          archive: async () => ({}),
          timeline: { refetch: async () => EMPTY_TIMELINE },
        }),
      }),
    );

    const summary = await adapter.getDesignAgent("agent-1");
    expect(summary).toMatchObject({
      id: "agent-1",
      status: "idle",
      activeTurn: true,
      requiresAttention: true,
      attentionReason: "finished",
      lastError: "safe summary",
      providerUnavailable: false,
      labels: { "agent-team.design": "job-1" },
    });
    expect(summary?.pendingPermissions).toEqual([
      { id: "permission-1", kind: "tool", title: "Approve", description: "Run a tool" },
    ]);
    expect(JSON.stringify(summary)).not.toContain("PERMISSION_RAW");
    expect(JSON.stringify(summary)).not.toContain("PERMISSION_DETAIL");

    const missing = createDesignAdapter(
      basePort({
        agentRef: () => ({
          refresh: async () => null,
          send: async () => {},
          archive: async () => ({}),
          timeline: { refetch: async () => EMPTY_TIMELINE },
        }),
      }),
    );
    expect(await missing.getDesignAgent("gone")).toBeNull();

    const failing = createDesignAdapter(
      basePort({
        agentRef: () => ({
          refresh: async () => {
            throw new Error("agent read failed");
          },
          send: async () => {},
          archive: async () => ({}),
          timeline: { refetch: async () => EMPTY_TIMELINE },
        }),
      }),
    );
    await expect(failing.getDesignAgent("broken")).rejects.toThrow("agent read failed");
  });

  test("rejects unknown permission kinds, truncates summaries, and lists with the design filter", async () => {
    const list = vi.fn(async (_options: Parameters<DesignPaseoPort["agents"]["list"]>[0]) => ({
      entries: [
        {
          agent: {
            ...AGENT,
            lastError: "e".repeat(600),
            pendingPermissions: [
              {
                id: "permission-2",
                kind: "provider-future-kind",
                title: "t".repeat(250),
                description: "d".repeat(600),
              },
            ],
          },
        },
      ],
      pageInfo: { hasMore: true, nextCursor: "agent-next" },
    }));
    const adapter = createDesignAdapter(basePort({ agentList: list }));

    const page = await adapter.listDesignAgents({ limit: 100, cursor: "agent-cursor" });
    expect(list).toHaveBeenCalledWith({
      filter: {
        labels: { "agent-team.design.version": "1" },
        includeArchived: true,
        includeBackground: true,
      },
      sort: [{ key: "created_at", direction: "desc" }],
      page: { limit: 100, cursor: "agent-cursor" },
    });
    expect(page.nextCursor).toBe("agent-next");
    expect(page.hasMore).toBe(true);
    expect(page.agents[0]?.pendingPermissions[0]).toMatchObject({
      id: "permission-2",
      kind: "other",
      title: "t".repeat(200),
      description: "d".repeat(500),
    });
    expect(page.agents[0]?.lastError).toHaveLength(500);
  });

  test("requests projected timeline pages and keeps only safe item fields", async () => {
    const refetch = vi.fn(
      async (_options: {
        direction: "tail" | "before";
        cursor?: { epoch: string; seq: number };
        limit: number;
        projection: "projected";
      }) => ({
        ...EMPTY_TIMELINE,
        direction: "before" as const,
        entries: [
          {
            seqStart: 1,
            seqEnd: 1,
            turnId: "turn-1",
            item: {
              type: "user_message" as const,
              text: "question",
              messageId: "message-1",
              clientMessageId: "client-1",
            },
          },
          {
            seqStart: 2,
            seqEnd: 2,
            item: { type: "assistant_message" as const, text: "answer", messageId: "answer-1" },
          },
          { seqStart: 3, seqEnd: 3, item: { type: "error" as const, message: "failed" } },
          {
            seqStart: 4,
            seqEnd: 4,
            item: { type: "notification" as const, level: "warning" as const, message: "warn" },
          },
          { seqStart: 5, seqEnd: 5, item: { type: "reasoning" as const, text: "private" } },
          { seqStart: 6, seqEnd: 6, item: { type: "tool_call" as const } },
          { seqStart: 7, seqEnd: 7, item: { type: "plugin" as const } },
          { seqStart: 8, seqEnd: 8, item: { type: "todo" as const } },
          { seqStart: 9, seqEnd: 9, item: { type: "compaction" as const } },
        ],
        startCursor: { epoch: "epoch-1", seq: 1 },
        endCursor: { epoch: "epoch-1", seq: 9 },
        hasOlder: true,
        hasNewer: false,
      }),
    );
    const adapter = createDesignAdapter(
      basePort({
        agentRef: () => ({
          refresh: async () => ({ agent: AGENT }),
          send: async () => {},
          archive: async () => ({}),
          timeline: { refetch },
        }),
      }),
    );

    const page = await adapter.readDesignTimeline({
      agentId: "agent-1",
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 10 },
      limit: 100,
    });
    expect(refetch).toHaveBeenCalledWith({
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 10 },
      limit: 100,
      projection: "projected",
    });
    expect(page.entries.map((entry) => entry.type)).toEqual([
      "user_message",
      "assistant_message",
      "error",
      "notification",
      "reasoning",
      "tool_call",
      "plugin",
      "other",
      "other",
    ]);
    expect(page.entries[0]).toMatchObject({
      messageId: "message-1",
      clientMessageId: "client-1",
      turnId: "turn-1",
    });
    expect(page.entries[4]?.text).toBeUndefined();
    expect(page.entries[5]?.text).toBeUndefined();
    expect(page.entries[6]?.text).toBeUndefined();
    expect(page.entries[7]?.text).toBeUndefined();
    expect(page.entries[8]?.text).toBeUndefined();
    expect(page.startCursor).toEqual({ epoch: "epoch-1", seq: 1 });
    expect(page.hasOlder).toBe(true);
  });

  test("sends with an explicit steer id and archives by exact agent id", async () => {
    const send = vi.fn(async () => {});
    const archive = vi.fn(async () => ({ archivedAt: "now" }));
    const seenAgents: string[] = [];
    const adapter = createDesignAdapter(
      basePort({
        agentRef: (id) => {
          seenAgents.push(id);
          return {
            refresh: async () => null,
            send,
            archive,
            timeline: { refetch: async () => EMPTY_TIMELINE },
          };
        },
      }),
    );

    await adapter.sendDesignMessage({ agentId: "agent-1", text: "repair", messageId: "message-2" });
    await adapter.archiveDesignAgent("agent-1");
    expect(seenAgents).toEqual(["agent-1", "agent-1"]);
    expect(send).toHaveBeenCalledWith("repair", {
      messageId: "message-2",
      activeTurnBehavior: "steer",
    });
    expect(archive).toHaveBeenCalledTimes(1);
  });
});

// Compile-time proof; the negative direction is covered by the structural type itself.
const acceptsPaseoApi = (api: PaseoApi) => createDesignAdapter(api);
void acceptsPaseoApi;

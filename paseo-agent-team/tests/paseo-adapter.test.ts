import { describe, expect, test } from "vitest";
import {
  asRecord,
  createPaseoAdapter,
  profileProvider,
  profilesFromConfig,
  toPaseoMcpServers,
} from "../shared/paseo/adapter";
import { fakePort, workspace } from "./fakes";
import { claudeOpus, codexXhigh } from "./fixtures";

describe("profilesFromConfig", () => {
  test("reads Agent Profiles and keeps their optional settings", () => {
    const profiles = profilesFromConfig({
      agentProfiles: [
        {
          id: "p1",
          name: "Fast",
          provider: "claude",
          model: "opus",
          modeId: "auto",
          thinkingOptionId: "high",
          featureValues: { fast: true },
          notes: "note",
          icon: "Zap",
          color: "#fff",
          somethingNew: 1,
        },
      ],
    });
    expect(profiles).toEqual([
      {
        id: "p1",
        name: "Fast",
        provider: "claude",
        model: "opus",
        modeId: "auto",
        thinkingOptionId: "high",
        featureValues: { fast: true },
        notes: "note",
        icon: "Zap",
        color: "#fff",
      },
    ]);
  });

  test("skips malformed entries and tolerates other config shapes", () => {
    expect(
      profilesFromConfig({
        agentProfiles: [
          null,
          "text",
          { id: "", name: "x", provider: "claude" },
          { id: "a", provider: "claude" },
          { id: "b", name: "b" },
          { id: "ok", name: "ok", provider: "codex", model: 4 },
        ],
      }),
    ).toEqual([{ id: "ok", name: "ok", provider: "codex" }]);
    for (const config of [undefined, null, 3, [], {}, { agentProfiles: {} }]) {
      expect(profilesFromConfig(config)).toEqual([]);
    }
  });

  test("helpers", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([])).toBeNull();
    expect(asRecord(null)).toBeNull();
    expect(profileProvider({ provider: "claude", model: "opus" })).toBe("claude/opus");
    expect(profileProvider({ provider: "claude" })).toBe("claude");
  });
});

describe("toPaseoMcpServers", () => {
  test("adds the type Paseo requires to Claude-style stdio entries", () => {
    expect(
      toPaseoMcpServers({
        local: { command: "node", args: ["server.js"] },
        remote: { type: "http", url: "https://example.com/mcp" },
        typed: { type: "stdio", command: "npx" },
      }),
    ).toEqual({
      local: { type: "stdio", command: "node", args: ["server.js"] },
      remote: { type: "http", url: "https://example.com/mcp" },
      typed: { type: "stdio", command: "npx" },
    });
  });

  test("omits an empty or missing set", () => {
    expect(toPaseoMcpServers(undefined)).toBeUndefined();
    expect(toPaseoMcpServers({})).toBeUndefined();
  });
});

describe("createPaseoAdapter", () => {
  test("reads profiles from the daemon config", async () => {
    const { port } = fakePort();
    const adapter = createPaseoAdapter(port);
    expect((await adapter.listProfiles()).map((profile) => profile.id)).toEqual([
      claudeOpus.id,
      codexXhigh.id,
    ]);
    expect(await adapter.readConfig()).toMatchObject({ mcp: { injectIntoAgents: true } });
  });

  test("an unreadable config is reported as profiles-unavailable", async () => {
    const { port } = fakePort();
    port.config.get.mockRejectedValueOnce(new Error("daemon offline"));
    await expect(createPaseoAdapter(port).listProfiles()).rejects.toMatchObject({
      code: "profiles-unavailable",
      message: "daemon offline",
    });
    port.config.get.mockRejectedValueOnce("boom");
    await expect(createPaseoAdapter(port).listProfiles()).rejects.toMatchObject({
      code: "profiles-unavailable",
      message: "无法读取 Paseo Profile",
    });
  });

  test("maps provider availability and its reason", async () => {
    const { port } = fakePort();
    port.providers.listAvailable.mockResolvedValueOnce({
      providers: [
        { provider: "claude", available: true },
        { provider: "codex", available: false, error: "not logged in" },
        { provider: "grok", available: false, error: null },
      ],
    });
    expect(await createPaseoAdapter(port).listProviderAvailability()).toEqual([
      { provider: "claude", available: true, reason: undefined },
      { provider: "codex", available: false, reason: "not logged in" },
      { provider: "grok", available: false, reason: undefined },
    ]);
  });

  test("lists workspaces across pages and prefers the user's title", async () => {
    const { port } = fakePort();
    port.workspaces.list.mockImplementation(async ({ page }) =>
      page.cursor === "next"
        ? {
            entries: [{ ...workspace, id: "ws-2", title: "  Billing  " }],
            pageInfo: { hasMore: false },
          }
        : { entries: [workspace], pageInfo: { hasMore: true, nextCursor: "next" } },
    );
    expect(await createPaseoAdapter(port).listWorkspaces()).toEqual([
      {
        id: "ws-1",
        name: "main",
        projectId: "p1",
        projectName: "Project",
        directory: "/repo",
      },
      { id: "ws-2", name: "Billing", projectId: "p1", projectName: "Project", directory: "/repo" },
    ]);
  });

  test("stops paging after ten pages", async () => {
    const { port } = fakePort();
    port.workspaces.list.mockResolvedValue({
      entries: [workspace],
      pageInfo: { hasMore: true, nextCursor: "again" },
    });
    expect(await createPaseoAdapter(port).listWorkspaces()).toHaveLength(10);
    expect(port.workspaces.list).toHaveBeenCalledTimes(10);
  });

  test("getWorkspace is null when the workspace cannot be read", async () => {
    const { port, refresh } = fakePort();
    const adapter = createPaseoAdapter(port);
    expect(await adapter.getWorkspace("ws-1")).toMatchObject({ id: "ws-1", name: "main" });
    refresh.mockResolvedValueOnce(null);
    expect(await adapter.getWorkspace("gone")).toBeNull();
    refresh.mockRejectedValueOnce(new Error("unknown workspace"));
    expect(await adapter.getWorkspace("gone")).toBeNull();
  });

  test("lists projects, falling back to workspaces when the project list is unavailable", async () => {
    const { port } = fakePort();
    const adapter = createPaseoAdapter(port);
    expect(await adapter.listProjects()).toEqual([
      { id: "p1", name: "Project", directory: "/repo", kind: "git" },
    ]);

    port.projects.list.mockRejectedValueOnce(new Error("old daemon"));
    expect(await adapter.listProjects()).toEqual([
      { id: "p1", name: "Project", directory: "/repo" },
    ]);

    port.projects.list.mockResolvedValueOnce({ projects: [] });
    port.workspaces.list.mockResolvedValueOnce({
      entries: [
        workspace,
        { ...workspace, id: "ws-2" },
        { ...workspace, id: "ws-3", projectId: "", workspaceDirectory: undefined },
      ],
      pageInfo: { hasMore: false },
    });
    expect(await adapter.listProjects()).toHaveLength(1);
  });

  test("creates a worktree workspace for git projects and a directory workspace otherwise", async () => {
    const { port } = fakePort();
    const adapter = createPaseoAdapter(port);
    const git = await adapter.createWorkspace({
      title: "Billing",
      project: { id: "p1", name: "Project", directory: "/repo", kind: "git" },
    });
    expect(git).toMatchObject({ id: "ws-new", name: "New" });
    expect(port.workspaces.create).toHaveBeenLastCalledWith({
      title: "Billing",
      source: { kind: "worktree", projectId: "p1", cwd: "/repo", action: "branch-off" },
    });

    await adapter.createWorkspace({
      title: "Notes",
      project: { id: "p2", name: "Notes", directory: "/notes", kind: "directory" },
    });
    expect(port.workspaces.create).toHaveBeenLastCalledWith({
      title: "Notes",
      source: { kind: "directory", path: "/notes", projectId: "p2" },
    });
  });

  test("createWorkspace falls back to the handle when no snapshot is available", async () => {
    const { port } = fakePort();
    port.workspaces.create.mockResolvedValueOnce({
      id: "ws-x",
      name: null,
      projectId: null,
      directory: null,
      current: () => null,
      refresh: async () => null,
    });
    const created = await createPaseoAdapter(port).createWorkspace({
      title: "Fallback",
      project: { id: "p1", name: "Project", directory: "/repo", kind: "git" },
    });
    expect(created).toEqual({
      id: "ws-x",
      name: "Fallback",
      projectId: "p1",
      projectName: "Project",
      directory: "/repo",
    });
  });

  test("createAgent sends the profile as provider/model with the role's prompt and labels", async () => {
    const { port, created } = fakePort();
    const adapter = createPaseoAdapter(port);
    const result = await adapter.createAgent({
      workspaceId: "ws-1",
      parentAgentId: "coord-0",
      title: "x".repeat(80),
      labels: { "agent-team.run": "run-1" },
      systemPrompt: "You are the architect.",
      profile: {
        id: "p",
        name: "Opus",
        provider: "claude",
        model: "opus",
        modeId: "auto",
        thinkingOptionId: "high",
        featureValues: { fast: true },
      },
      mcpServers: { local: { command: "node" } },
    });
    expect(result.agentId).toBe("member-1");
    expect(created[0]?.workspaceId).toBe("ws-1");
    expect(created[0]?.options).toMatchObject({
      parent: "coord-0",
      labels: { "agent-team.run": "run-1" },
      config: {
        provider: "claude/opus",
        modeId: "auto",
        thinkingOptionId: "high",
        featureValues: { fast: true },
        systemPrompt: "You are the architect.",
        mcpServers: { local: { type: "stdio", command: "node" } },
      },
    });
    expect(created[0]?.options.title).toHaveLength(60);
  });

  test("createAgent sends only the provider when the profile pins no model", async () => {
    const { port, created } = fakePort();
    await createPaseoAdapter(port).createAgent({
      workspaceId: "ws-1",
      title: "Lead",
      labels: {},
      systemPrompt: "Lead.",
      profile: { id: "p", name: "Any", provider: "codex" },
    });
    expect(created[0]?.options.config.provider).toBe("codex");
    expect(created[0]?.options.config.mcpServers).toBeUndefined();
    expect(created[0]?.options.parent).toBeUndefined();
  });

  test("sends messages and archives agents through the agent handle", async () => {
    const { port, sent, archived } = fakePort();
    const adapter = createPaseoAdapter(port);
    await adapter.sendMessage("coord-1", "go");
    await adapter.archiveAgent("coord-1");
    expect(sent).toEqual([{ agentId: "coord-1", text: "go" }]);
    expect(archived).toEqual(["coord-1"]);
  });
});

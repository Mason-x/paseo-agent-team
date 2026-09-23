import { describe, expect, test } from "vitest";
import type { AgentEntry } from "../client/crew";
import {
  agentAgeTimestamp,
  buildCrewForest,
  collapseCrewNodes,
  crewCounts,
  crewState,
  formatAge,
} from "../client/crew";

function entry(
  id: string,
  parentId: string | null,
  overrides: Record<string, unknown> = {},
): AgentEntry {
  return {
    agent: {
      id,
      provider: "codex",
      cwd: "/repo",
      workspaceId: `workspace-${id}`,
      model: "gpt-5.6",
      createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T12:05:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {},
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      parentAgentId: parentId,
      title: id,
      ...overrides,
    },
    project: {
      projectId: "project",
      projectDisplayName: "Project",
      projectRootPath: "/repo",
      projectKind: "git",
    },
  } as unknown as AgentEntry;
}

describe("crewState", () => {
  test("uses actionable states before general lifecycle states", () => {
    expect(crewState(entry("permission", "root", { pendingPermissions: [{}] }).agent)).toBe(
      "needs-input",
    );
    expect(crewState(entry("failed", "root", { status: "error" }).agent)).toBe("failed");
    expect(crewState(entry("running", "root", { status: "running" }).agent)).toBe("working");
    expect(
      crewState(
        entry("ready", "root", {
          requiresAttention: true,
          attentionReason: "finished",
        }).agent,
      ),
    ).toBe("ready");
    expect(crewState(entry("closed", "root", { status: "closed" }).agent)).toBe("closed");
  });
});

describe("buildCrewForest", () => {
  test("prefers the first-class parentAgentId field over legacy labels", () => {
    const nodes = buildCrewForest(
      [
        entry("root", null, { workspaceId: "workspace-main" }),
        entry("field-child", null, {
          workspaceId: "workspace-main",
          parentAgentId: "root",
          labels: { "paseo.parent-agent-id": "other" },
        }),
      ],
      "workspace-main",
    );

    expect(nodes.map(({ entry: item, depth }) => [item.agent.id, depth])).toEqual([
      ["root", 0],
      ["field-child", 1],
    ]);
  });

  test("shows every workspace agent and descendants across workspaces", () => {
    const nodes = buildCrewForest(
      [
        entry("lead", null, { workspaceId: "workspace-main", status: "running" }),
        entry("remote", "lead", { workspaceId: "workspace-other", status: "error" }),
        entry("remote-child", "remote", { workspaceId: "workspace-other" }),
        entry("local-child", "lead", { workspaceId: "workspace-main" }),
        entry("solo", null, { workspaceId: "workspace-main" }),
        entry("unrelated", null, { workspaceId: "workspace-other" }),
        entry("archived", null, {
          workspaceId: "workspace-main",
          archivedAt: "2026-09-01T13:00:00.000Z",
        }),
      ],
      "workspace-main",
    );

    expect(nodes.map(({ entry: item, depth }) => [item.agent.id, depth])).toEqual([
      ["lead", 0],
      ["remote", 1],
      ["remote-child", 2],
      ["local-child", 1],
      ["solo", 0],
    ]);
    expect(nodes.every(({ member, contextOnly }) => member && !contextOnly)).toBe(true);
    expect(nodes[0]?.descendantCount).toBe(3);
    expect(crewCounts(nodes)).toMatchObject({ failed: 1, working: 1, idle: 3 });
  });

  test("keeps foreign ancestors as context and prunes unrelated branches", () => {
    const nodes = buildCrewForest(
      [
        entry("external-lead", null, { workspaceId: "workspace-platform" }),
        entry("local-worker", "external-lead", { workspaceId: "workspace-main" }),
        entry("remote-child", "local-worker", { workspaceId: "workspace-review" }),
        entry("foreign-sibling", "external-lead", { workspaceId: "workspace-platform" }),
      ],
      "workspace-main",
    );

    expect(
      nodes.map(({ entry: item, depth, member, contextOnly }) => [
        item.agent.id,
        depth,
        member,
        contextOnly,
      ]),
    ).toEqual([
      ["external-lead", 0, false, true],
      ["local-worker", 1, true, false],
      ["remote-child", 2, true, false],
    ]);
  });

  test("keeps ancestors as context when only a descendant matches", () => {
    const nodes = buildCrewForest(
      [
        entry("planner", null, { workspaceId: "workspace-main" }),
        entry("database-review", "planner", {
          title: "Review database migration",
          workspaceId: "workspace-main",
        }),
        entry("frontend", null, { workspaceId: "workspace-main" }),
      ],
      "workspace-main",
      { state: null, query: "database" },
    );

    expect(nodes.map(({ entry: item, contextOnly }) => [item.agent.id, contextOnly])).toEqual([
      ["planner", true],
      ["database-review", false],
    ]);
  });

  test("filters by state while preserving the matching branch", () => {
    const nodes = buildCrewForest(
      [
        entry("lead", null, { workspaceId: "workspace-main", status: "running" }),
        entry("blocked", "lead", {
          workspaceId: "workspace-main",
          attentionReason: "permission",
        }),
        entry("idle", null, { workspaceId: "workspace-main" }),
      ],
      "workspace-main",
      { state: "needs-input", query: "" },
    );

    expect(nodes.map(({ entry: item, contextOnly }) => [item.agent.id, contextOnly])).toEqual([
      ["lead", true],
      ["blocked", false],
    ]);
  });

  test("does not recurse forever through malformed parent cycles", () => {
    const nodes = buildCrewForest(
      [
        entry("agent-a", "agent-b", { workspaceId: "workspace-main" }),
        entry("agent-b", "agent-a", { workspaceId: "workspace-other" }),
      ],
      "workspace-main",
    );
    expect(nodes.map(({ entry: item }) => item.agent.id)).toEqual(["agent-a", "agent-b"]);
  });

  test("hides descendants of collapsed rows", () => {
    const nodes = buildCrewForest(
      [
        entry("lead", null, { workspaceId: "workspace-main" }),
        entry("worker", "lead", { workspaceId: "workspace-main" }),
        entry("grandchild", "worker", { workspaceId: "workspace-main" }),
        entry("solo", null, { workspaceId: "workspace-main" }),
      ],
      "workspace-main",
    );

    expect(
      collapseCrewNodes(nodes, new Set(["lead"])).map(({ entry: item }) => item.agent.id),
    ).toEqual(["lead", "solo"]);
  });
});

describe("age", () => {
  test("prefers attention and active-turn timestamps", () => {
    const agent = entry("worker", "root", {
      attentionTimestamp: "2026-09-01T12:04:00.000Z",
      activeTurn: { turnId: "turn", startedAt: "2026-09-01T12:03:00.000Z" },
    }).agent;
    expect(agentAgeTimestamp(agent)).toBe(Date.parse("2026-09-01T12:04:00.000Z"));
    expect(formatAge(agentAgeTimestamp(agent), Date.parse("2026-09-01T12:09:00.000Z"))).toBe("5分");
  });
});

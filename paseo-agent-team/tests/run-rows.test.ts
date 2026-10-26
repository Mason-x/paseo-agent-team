import { describe, expect, test } from "vitest";
import type { CrewNode } from "../client/crew";
import { crewListItems, roleLine, runTitle } from "../client/crew/run-rows";
import type { RunAgentSnapshot, TeamRun } from "../shared/domain/run-progress";
import { LABELS } from "../shared/paseo/labels";
import { NOW } from "./fixtures";

function node(id: string, labels: Record<string, string> = {}): CrewNode {
  return {
    depth: 0,
    descendantCount: 0,
    contextOnly: false,
    member: true,
    entry: {
      agent: {
        id,
        labels,
        provider: "claude",
        cwd: "/repo",
        workspaceId: "ws",
        status: "idle",
      },
    },
  } as unknown as CrewNode;
}

function agent(id: string, overrides: Partial<RunAgentSnapshot> = {}): RunAgentSnapshot {
  return {
    id,
    title: id,
    provider: "claude",
    model: null,
    status: "idle",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const nodes = [
  node("a", {
    [LABELS.run]: "run-1",
    [LABELS.teamName]: "Coding Team",
    [LABELS.roleName]: "Tech Lead",
  }),
  node("b", {
    [LABELS.run]: "run-1",
    [LABELS.teamName]: "Coding Team",
    [LABELS.roleName]: "Architect",
  }),
  node("c"),
];

describe("crew list grouping", () => {
  test("inserts a run header and can collapse its agents", () => {
    const expanded = crewListItems(nodes, new Set());
    expect(expanded.map((item) => item.kind)).toEqual(["run", "agent", "agent", "agent"]);
    expect(expanded[0]).toMatchObject({
      kind: "run",
      runId: "run-1",
      title: "Coding Team",
      count: 2,
    });

    const collapsed = crewListItems(nodes, new Set(["run-1"]));
    expect(collapsed.map((item) => item.kind)).toEqual(["run", "agent"]);
  });

  test("a run header carries the task and progress from the run's labels", () => {
    const run: TeamRun = {
      runId: "run-1",
      teamName: "Coding Team",
      task: "Add Stripe",
      coordinator: agent("a", {
        status: "running",
        lastUserMessageAt: NOW,
        labels: { [LABELS.kind]: "coordinator" },
      }),
      members: [agent("b", { lastUserMessageAt: NOW })],
      startedAt: NOW,
      lastActivityAt: NOW,
    };
    const [header] = crewListItems(nodes, new Set(), { runs: new Map([["run-1", run]]) });
    expect(header).toMatchObject({
      kind: "run",
      title: "Coding Team · Add Stripe",
      progress: { phase: "running", assigned: 1, delivered: 1 },
    });
  });

  test("runs launched by older versions keep their task from saved preferences", () => {
    const legacy = [
      {
        runId: "run-1",
        teamId: "coding-team",
        teamName: "Coding Team",
        workspaceId: "ws",
        coordinatorAgentId: "a",
        memberAgentIds: ["b"],
        taskExcerpt: "Add Stripe",
        createdAt: NOW,
      },
    ];
    expect(crewListItems(nodes, new Set(), { legacyRuns: legacy })[0]).toMatchObject({
      title: "Coding Team · Add Stripe",
    });
    expect(runTitle("run-1", undefined, legacy)).toBe("Coding Team · Add Stripe");
    expect(runTitle("run-2", undefined, legacy, "Other")).toBe("Other");
    expect(runTitle("run-2", undefined, [])).toBe("Team");
  });

  test("roleLine reads labels even when the role catalog is gone", () => {
    expect(
      roleLine(
        node("a", {
          [LABELS.roleName]: "Architect",
          [LABELS.instance]: "API",
          [LABELS.teamName]: "Coding Team",
        }),
      ),
    ).toBe("Architect (API) · Coding Team");
  });
});

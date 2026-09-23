import { describe, expect, test } from "vitest";
import type { CrewNode } from "../client/crew";
import { crewListItems, roleLine } from "../client/crew/run-rows";
import { LABELS } from "../client/paseo/labels";
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

describe("crew list grouping", () => {
  test("inserts a run header and can collapse its agents", () => {
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
    const expanded = crewListItems(nodes, new Set(), [
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
    ]);
    expect(expanded.map((item) => item.kind)).toEqual(["run", "agent", "agent", "agent"]);
    expect(expanded[0]).toMatchObject({
      kind: "run",
      title: "Coding Team · Add Stripe · 2 个智能体",
    });

    const collapsed = crewListItems(nodes, new Set(["run-1"]), []);
    expect(collapsed.map((item) => item.kind)).toEqual(["run", "agent"]);
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

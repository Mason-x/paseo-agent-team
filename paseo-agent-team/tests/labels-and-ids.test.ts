import { describe, expect, test } from "vitest";
import { createRunId } from "../shared/ids";
import { LABELS, PARENT_AGENT_ID_LABEL, taskExcerpt, teamLabels } from "../shared/paseo/labels";

describe("taskExcerpt", () => {
  test("collapses whitespace into one line", () => {
    expect(taskExcerpt("  Add\n  Stripe\tbilling ")).toBe("Add Stripe billing");
  });

  test("bounds the length with an ellipsis", () => {
    const excerpt = taskExcerpt("word ".repeat(100));
    expect(excerpt.length).toBeLessThanOrEqual(160);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(taskExcerpt("short")).toBe("short");
    expect(taskExcerpt("x".repeat(40), 10)).toHaveLength(10);
  });
});

describe("teamLabels", () => {
  const base = {
    runId: "run-1",
    teamId: "coding-team",
    teamName: "Coding Team",
    roleId: "architect",
    roleName: "Architect",
    kind: "member" as const,
  };

  test("always carries the run, team, and role", () => {
    expect(teamLabels(base)).toEqual({
      [LABELS.run]: "run-1",
      [LABELS.team]: "coding-team",
      [LABELS.teamName]: "Coding Team",
      [LABELS.role]: "architect",
      [LABELS.roleName]: "Architect",
      [LABELS.kind]: "member",
    });
  });

  test("adds the instance and the task only when there is one", () => {
    const labels = teamLabels({ ...base, instanceLabel: "API", task: "Add\nStripe" });
    expect(labels[LABELS.instance]).toBe("API");
    expect(labels[LABELS.task]).toBe("Add Stripe");
    expect(LABELS.task in teamLabels({ ...base, task: "  " })).toBe(false);
  });

  test("agent labels stay under the plugin's namespace, apart from Paseo's parent link", () => {
    for (const label of Object.values(LABELS)) expect(label.startsWith("agent-team.")).toBe(true);
    expect(PARENT_AGENT_ID_LABEL).toBe("paseo.parent-agent-id");
  });
});

describe("createRunId", () => {
  test("has a stable shape", () => {
    expect(createRunId(1_790_000_000_000, 0)).toMatch(/^run-[0-9a-z]+-0000$/);
    expect(createRunId()).toMatch(/^run-[0-9a-z]+-[0-9a-z]{4}$/);
  });

  test("two launches in the same millisecond get different ids", () => {
    const now = 1_790_000_000_000;
    expect(createRunId(now, 0.1)).not.toBe(createRunId(now, 0.2));
  });

  test("later launches sort after earlier ones", () => {
    expect(createRunId(1_790_000_000_001, 0) > createRunId(1_790_000_000_000, 0.99)).toBe(true);
  });
});

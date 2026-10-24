import { describe, expect, test } from "vitest";
import { buildLaunchPlan } from "../shared/domain/launch-plan";
import { LABELS } from "../shared/paseo/labels";
import {
  allAvailable,
  architect,
  claudeOpus,
  codexXhigh,
  codingTeam,
  developer,
  techLead,
} from "./fixtures";

const base = {
  team: codingTeam,
  roles: [techLead, architect, developer],
  profiles: [claudeOpus, codexXhigh],
  availability: allAvailable,
  workspaceId: "ws-1",
  task: "Add Stripe subscriptions to the billing page.",
  runId: "run-1",
  maxMembers: 8,
};

describe("buildLaunchPlan", () => {
  test("builds titles, labels, and a kickoff for a healthy team", () => {
    const plan = buildLaunchPlan(base);
    expect(plan.blockers).toEqual([]);
    expect(plan.coordinator.title.startsWith("[Team] Coding Team:")).toBe(true);
    expect(plan.coordinator.title.length).toBeLessThanOrEqual(60);
    expect(plan.members[0]?.title).toBe("Architect · Coding Team");
    expect(plan.members[1]?.title).toBe("Developer (Backend) · Coding Team");
    expect(plan.coordinator.labels[LABELS.kind]).toBe("coordinator");
    expect(plan.members[0]?.labels[LABELS.role]).toBe("architect");
    expect(plan.members[1]?.labels[LABELS.instance]).toBe("Backend");
    expect(plan.coordinator.systemPrompt).toContain("send_agent_prompt");
  });

  test("truncates long titles to 60 characters", () => {
    const plan = buildLaunchPlan({
      ...base,
      team: { ...codingTeam, name: "Very Long Coding Team Name For Title" },
      task: "x".repeat(80),
    });
    expect(plan.coordinator.title.length).toBeLessThanOrEqual(60);
  });

  test("blocks a missing team or coordinator", () => {
    expect(buildLaunchPlan({ ...base, team: undefined }).blockers).toContain("Team 不存在。");
    expect(
      buildLaunchPlan({ ...base, roles: [architect, developer] }).blockers.some((item) =>
        item.includes("不存在"),
      ),
    ).toBe(true);
  });

  test("blocks when enabled members are zero or over max", () => {
    expect(
      buildLaunchPlan({
        ...base,
        team: {
          ...codingTeam,
          members: [
            { roleId: "architect", enabled: false },
            { roleId: "developer", enabled: false },
          ],
        },
      }).blockers.some((item) => item.includes("没有可启动")),
    ).toBe(true);
    expect(
      buildLaunchPlan({ ...base, maxMembers: 1 }).blockers.some((item) =>
        item.includes("超过上限"),
      ),
    ).toBe(true);
  });

  test("member profile failure is a blocker, disabled members are warnings", () => {
    const blocked = buildLaunchPlan({
      ...base,
      profiles: [claudeOpus],
    });
    expect(blocked.blockers.some((item) => item.includes("Developer"))).toBe(true);

    const skipped = buildLaunchPlan({
      ...base,
      team: {
        ...codingTeam,
        members: [
          { roleId: "architect", enabled: true },
          { roleId: "developer", instanceLabel: "Backend", enabled: false },
        ],
      },
    });
    expect(skipped.warnings.some((item) => item.includes("跳过已禁用"))).toBe(true);
    expect(skipped.members).toHaveLength(1);
  });

  test("empty task is a blocker", () => {
    expect(buildLaunchPlan({ ...base, task: "   " }).blockers).toContain("必须填写任务描述。");
  });

  test("only the coordinator carries the task, as a bounded single line", () => {
    const plan = buildLaunchPlan({ ...base, task: `Ship\n  billing ${"x".repeat(400)}` });
    const task = plan.coordinator.labels[LABELS.task] ?? "";
    expect(task.startsWith("Ship billing xxx")).toBe(true);
    expect(task.length).toBeLessThanOrEqual(160);
    expect(task).not.toContain("\n");
    expect(plan.members.every((member) => member.labels[LABELS.task] === undefined)).toBe(true);
  });

  test("blocks when the daemon will not give the coordinator Paseo tools", () => {
    const plan = buildLaunchPlan({
      ...base,
      daemonConfig: { mcp: { enabled: true, injectIntoAgents: false } },
    });
    expect(plan.blockers.some((item) => item.includes("注入 Paseo tools"))).toBe(true);
  });

  test("checks the provider the coordinator actually resolves to", () => {
    // The tech lead prefers Claude. Disabling Codex tools must not block it...
    const codexOff = { providers: { codex: { paseoTools: { enabled: false } } } };
    expect(buildLaunchPlan({ ...base, daemonConfig: codexOff }).blockers).toEqual([]);
    // ...and disabling Claude's must, naming the provider.
    const claudeOff = { providers: { claude: { paseoTools: { enabled: false } } } };
    const blocked = buildLaunchPlan({ ...base, daemonConfig: claudeOff });
    expect(blocked.blockers.some((item) => item.includes("claude"))).toBe(true);
  });

  test("falls back to the next Profile's provider for the tools check", () => {
    const plan = buildLaunchPlan({
      ...base,
      roles: [
        { ...techLead, fallbackProfiles: [{ profileId: codexXhigh.id }] },
        architect,
        developer,
      ],
      availability: [
        { provider: "claude", available: false, reason: "not logged in" },
        { provider: "codex", available: true },
      ],
      daemonConfig: { providers: { codex: { paseoTools: { enabled: false } } } },
    });
    expect(plan.coordinator.profile.id).toBe(codexXhigh.id);
    expect(plan.blockers.some((item) => item.includes("codex"))).toBe(true);
  });

  test("an unreadable or unfamiliar daemon config never blocks a launch", () => {
    for (const daemonConfig of [undefined, null, "oops", [], { mcp: "later-format" }]) {
      expect(buildLaunchPlan({ ...base, daemonConfig }).blockers).toEqual([]);
    }
  });
});

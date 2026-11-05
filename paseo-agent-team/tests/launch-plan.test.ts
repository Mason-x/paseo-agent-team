import { describe, expect, test } from "vitest";
import { buildLaunchPlan, modelRepeatsProvider } from "../shared/domain/launch-plan";
import { LABELS } from "../shared/paseo/labels";
import {
  allAvailable,
  architect,
  claudeOpus,
  codexXhigh,
  codingTeam,
  developer,
  role,
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

describe("modelRepeatsProvider", () => {
  test("is true only when the model starts with its own provider and a slash", () => {
    expect(modelRepeatsProvider({ provider: "codex", model: "codex/gpt-6.1-sol" })).toBe(true);
    expect(modelRepeatsProvider({ provider: "Codex", model: " CODEX/gpt-6.1-sol" })).toBe(true);
    expect(modelRepeatsProvider({ provider: "codex", model: "gpt-6.1-sol" })).toBe(false);
    expect(modelRepeatsProvider({ provider: "codex", model: "codex" })).toBe(false);
    expect(modelRepeatsProvider({ provider: "codex", model: "codexx/gpt" })).toBe(false);
    expect(modelRepeatsProvider({ provider: "codex" })).toBe(false);
    expect(modelRepeatsProvider({ provider: "", model: "/gpt" })).toBe(false);
  });

  test("gateway model ids with slashes are not flagged", () => {
    expect(
      modelRepeatsProvider({ provider: "codex", model: "remote-magpie/auto/gpt-6.1-sol" }),
    ).toBe(false);
    expect(
      modelRepeatsProvider({ provider: "omp", model: "magpie/remote-magpie/auto/grok-4.6" }),
    ).toBe(false);
    expect(
      modelRepeatsProvider({ provider: "claude", model: "remote-magpie/codex/gpt-6.1-terra" }),
    ).toBe(false);
  });
});

describe("profile model prefix warning", () => {
  const prefixed = { ...codexXhigh, model: "codex/gpt-6.1-sol" };

  test("warns without blocking, naming the Profile and the model the host would store", () => {
    const plan = buildLaunchPlan({ ...base, profiles: [claudeOpus, prefixed] });
    expect(plan.blockers).toEqual([]);
    const warning = plan.warnings.filter((line) => line.includes("codex/gpt-6.1-sol"));
    expect(warning).toHaveLength(1);
    expect(warning[0]).toContain(prefixed.name);
    expect(warning[0]).toContain("codex/codex/gpt-6.1-sol");
  });

  test("a healthy plan has no such warning", () => {
    const plan = buildLaunchPlan(base);
    expect(plan.warnings.some((line) => line.includes("以自己的 provider"))).toBe(false);
  });

  test("two seats sharing the flagged Profile produce one warning", () => {
    const plan = buildLaunchPlan({
      ...base,
      profiles: [claudeOpus, prefixed],
      team: {
        ...codingTeam,
        members: [
          { roleId: "developer", instanceLabel: "Backend", enabled: true },
          { roleId: "developer", instanceLabel: "Frontend", enabled: true },
        ],
      },
    });
    expect(plan.seats).toHaveLength(2);
    expect(plan.warnings.filter((line) => line.includes("以自己的 provider"))).toHaveLength(1);
  });

  test("a flagged Profile that no seat uses is not reported", () => {
    const unused = { ...claudeOpus, id: "unused", name: "Unused", model: "claude/opus" };
    const plan = buildLaunchPlan({ ...base, profiles: [claudeOpus, codexXhigh, unused] });
    expect(plan.warnings.some((line) => line.includes("Unused"))).toBe(false);
  });
});

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

  test("includes bounded seat counts for the unchanged SOTA path", () => {
    const plan = buildLaunchPlan(base);
    expect(plan.seats).toHaveLength(2);
    expect(plan.seatCounts).toEqual({
      logical: 2,
      physical: 2,
      eager: 2,
      deferred: 0,
      escalation: 0,
      sotaPotential: 2,
    });
    expect(plan.seatBudget).toEqual({ economy: 0, sota: 0, unknown: 2, deferredSota: 0 });
    expect(plan.seatIssues).toEqual([]);
    expect(plan.seats.map((seat) => seat.roleId)).toEqual(["architect", "developer"]);
  });

  test("blocks duplicate seatIds and preserves label compatibility", () => {
    const duplicateSeat = buildLaunchPlan({
      ...base,
      team: {
        ...codingTeam,
        members: [
          { roleId: "architect", seatId: "seat-same", enabled: true },
          {
            roleId: "developer",
            instanceLabel: "Backend",
            seatId: "seat-same",
            enabled: true,
          },
        ],
      },
    });
    expect(duplicateSeat.blockers).toContain("成员 id「seat-same」已被使用。");

    // Labels only need to be distinct inside one Role.
    const crossRoleLabel = buildLaunchPlan({
      ...base,
      team: {
        ...codingTeam,
        members: [
          { roleId: "architect", instanceLabel: "Shared", enabled: true },
          { roleId: "developer", instanceLabel: "shared", enabled: true },
        ],
      },
    });
    expect(crossRoleLabel.blockers).toEqual([]);

    const duplicateLabel = buildLaunchPlan({
      ...base,
      team: {
        ...codingTeam,
        members: [
          { roleId: "architect", instanceLabel: "Shared", enabled: true },
          { roleId: "architect", instanceLabel: "shared", enabled: true },
        ],
      },
    });
    expect(duplicateLabel.blockers).toEqual([]);
    expect(duplicateLabel.warnings.some((item) => item.includes("重复，已继续启动"))).toBe(true);

    const exactLabel = buildLaunchPlan({
      ...base,
      team: {
        ...codingTeam,
        members: [
          { roleId: "architect", instanceLabel: "Shared", enabled: true },
          { roleId: "architect", instanceLabel: "Shared", enabled: true },
        ],
      },
    });
    expect(exactLabel.blockers).toEqual([]);
    expect(exactLabel.members).toHaveLength(2);
    expect(exactLabel.warnings.some((item) => item.includes("重复，已继续启动"))).toBe(true);

    const missingLabels = buildLaunchPlan({
      ...base,
      team: {
        ...codingTeam,
        members: [
          { roleId: "architect", enabled: true },
          { roleId: "architect", enabled: true },
        ],
      },
    });
    expect(missingLabels.blockers).toContain("重复的 Role 需要实例标签");
  });

  test("materializes eager members from the seat plan and keeps kickoff consistent", () => {
    const fullstack = role({
      id: "eng-fullstack",
      name: "Fullstack",
      preferredProfiles: [{ profileId: claudeOpus.id, nameSnapshot: claudeOpus.name }],
    });
    const team = {
      ...codingTeam,
      mode: "economy",
      memberCreation: "eager",
      members: [
        { roleId: "eng-fullstack", instanceLabel: "Build", seatId: "seat-build", enabled: true },
      ],
    };
    const plan = buildLaunchPlan({
      ...base,
      team,
      roles: [techLead, fullstack],
      maxMembers: 24,
      runtimeCapabilities: { onDemand: true, expansion: true, collaboration: false },
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.seats[0].selected).toMatchObject({
      source: "role-preferred",
      profile: { id: claudeOpus.id },
    });
    expect(plan.members).toHaveLength(1);
    expect(plan.members[0]).toMatchObject({
      seatId: "seat-build",
      profile: { id: claudeOpus.id },
      source: "role-preferred",
      instanceLabel: "Build",
    });
    expect(plan.kickoffMessage).toContain(claudeOpus.name);
    expect(plan.kickoffMessage).toContain("Fullstack (Build)");
    expect(plan.coordinator.systemPrompt).toContain("Your team members are already running");
  });

  test("on-demand seats stay out of members and need the runtime capability", () => {
    const fullstack = role({
      id: "eng-fullstack",
      name: "Fullstack",
      preferredProfiles: [{ profileId: claudeOpus.id, nameSnapshot: claudeOpus.name }],
    });
    const team = {
      ...codingTeam,
      memberCreation: "on-demand",
      members: [
        { roleId: "eng-fullstack", instanceLabel: "Build", seatId: "seat-build", enabled: true },
      ],
    };
    const ready = buildLaunchPlan({
      ...base,
      team,
      roles: [techLead, fullstack],
      maxMembers: 24,
      runtimeCapabilities: { onDemand: true, expansion: true, collaboration: false },
    });
    expect(ready.blockers).toEqual([]);
    expect(ready.seats[0].selected).toMatchObject({ profile: { id: claudeOpus.id } });
    expect(ready.members).toEqual([]);
    expect(ready.coordinator.systemPrompt).toContain("on first task");

    const fallback = buildLaunchPlan({
      ...base,
      team: { ...team, memberCreation: undefined },
      roles: [techLead, fullstack],
      maxMembers: 24,
    });
    expect(fallback.blockers).toEqual([]);
    expect(fallback.seats[0].activation).toBe("eager");
    expect(fallback.members).toHaveLength(1);

    const explicitOnDemand = buildLaunchPlan({
      ...base,
      team: { ...team, memberCreation: "on-demand" },
      roles: [techLead, fullstack],
      maxMembers: 24,
    });
    expect(explicitOnDemand.blockers.some((item) => item.includes("按需创建成员当前不可用"))).toBe(
      true,
    );
    expect(explicitOnDemand.members).toEqual([]);
  });

  test("a previously expert-labeled Role is an ordinary eager member", () => {
    const fullstack = role({
      id: "eng-fullstack",
      name: "Fullstack",
      preferredProfiles: [{ profileId: claudeOpus.id, nameSnapshot: claudeOpus.name }],
    });
    const expert = role({
      id: "eng-expert",
      name: "Expert",
      preferredProfiles: [{ profileId: claudeOpus.id, nameSnapshot: claudeOpus.name }],
    });
    const plan = buildLaunchPlan({
      ...base,
      team: {
        ...codingTeam,
        mode: "economy",
        members: [
          { roleId: "eng-fullstack", instanceLabel: "Build", seatId: "seat-build", enabled: true },
          { roleId: "eng-expert", instanceLabel: "Expert", seatId: "seat-expert", enabled: true },
        ],
      },
      roles: [techLead, fullstack, expert],
      maxMembers: 24,
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.members.map((member) => member.seatId)).toEqual(["seat-build", "seat-expert"]);
    expect(plan.seats.find((seat) => seat.roleId === "eng-expert")?.activation).toBe("eager");
  });

  test("old mode and policy are ignored while invalid creation and missing host block", () => {
    const manyMembers = {
      ...codingTeam,
      mode: "future-mode",
      members: Array.from({ length: 65 }, (_, index) => ({
        roleId: "developer",
        instanceLabel: `Seat ${index + 1}`,
        seatId: `seat-${index + 1}`,
        enabled: true,
      })),
    };
    const unknownMode = buildLaunchPlan({ ...base, team: manyMembers, maxMembers: 64 });
    expect(unknownMode.seatCounts.logical).toBe(65);
    expect(unknownMode.seats).toHaveLength(65);
    expect(unknownMode.members).toHaveLength(65);
    expect(unknownMode.blockers).toContain("已启用成员（65）超过上限 64。");

    const brokenRole = role({
      id: "eng-fullstack",
      name: "Fullstack",
      preferredProfiles: [{ profileId: claudeOpus.id, nameSnapshot: claudeOpus.name }],
      executionPolicy: { tier: 5 },
    });
    const brokenPolicy = buildLaunchPlan({
      ...base,
      team: {
        ...codingTeam,
        mode: "economy",
        members: [
          { roleId: "eng-fullstack", instanceLabel: "Build", seatId: "seat-build", enabled: true },
        ],
      },
      roles: [techLead, brokenRole],
      maxMembers: 24,
      runtimeCapabilities: { onDemand: true, expansion: false, collaboration: false },
    });
    expect(brokenPolicy.members).toHaveLength(1);
    expect(brokenPolicy.blockers).toEqual([]);

    const invalidCreation = buildLaunchPlan({
      ...base,
      team: {
        ...codingTeam,
        mode: "economy",
        memberCreation: "future",
        members: [
          { roleId: "developer", instanceLabel: "Build", seatId: "seat-build", enabled: true },
        ],
      },
      maxMembers: 24,
    });
    expect(invalidCreation.members).toHaveLength(1);
    expect(invalidCreation.blockers.some((item) => item.includes("memberCreation=future"))).toBe(
      true,
    );

    const hostDown = buildLaunchPlan({
      ...base,
      host: { status: "unavailable", reason: "offline" },
    });
    expect(hostDown.members).toEqual([]);
    expect(hostDown.blockers.some((item) => item.includes("无法读取当前 host"))).toBe(true);
  });

  test("maps a missing coordinator binding to readable text", () => {
    const coordinatorDown = buildLaunchPlan({
      ...base,
      profiles: [codexXhigh],
      team: { ...codingTeam, members: [{ roleId: "developer", enabled: true }] },
      roles: [techLead, developer],
    });
    expect(coordinatorDown.blockers.some((item) => item.includes("无法解析协调者 Profile"))).toBe(
      true,
    );
  });

  test("SOTA repeated labels keep the legacy members and kickoff", () => {
    const plan = buildLaunchPlan({
      ...base,
      team: {
        ...codingTeam,
        members: [
          { roleId: "architect", instanceLabel: "A", enabled: true },
          { roleId: "architect", instanceLabel: "A", enabled: true },
        ],
      },
      roles: [techLead, architect],
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.members).toHaveLength(2);
    expect(new Set(plan.seats.map((seat) => seat.seatId)).size).toBe(2);
    expect(plan.members.map((member) => member.title)).toEqual([
      "Architect (A) · Coding Team",
      "Architect (A) · Coding Team",
    ]);
    expect(plan.members.map((member) => member.profile.id)).toEqual([claudeOpus.id, claudeOpus.id]);
    expect(plan.kickoffMessage.match(/Architect \(A\)/g)).toHaveLength(2);
    expect(plan.warnings.some((item) => item.includes("重复，已继续启动"))).toBe(true);
  });

  test("blocked previews still expose eagerly materialized members", () => {
    const emptyTask = buildLaunchPlan({ ...base, task: "" });
    expect(emptyTask.blockers).toContain("必须填写任务描述。");
    expect(emptyTask.members).toHaveLength(2);

    const toolsBlocked = buildLaunchPlan({
      ...base,
      daemonConfig: { mcp: { enabled: false } },
    });
    expect(toolsBlocked.members).toHaveLength(2);
    expect(toolsBlocked.blockers.length).toBeGreaterThan(0);
  });

  test("disabled Roles warn and invalid retired tiers do not block", () => {
    const disabled = role({
      id: "qa-review",
      name: "Review",
      enabled: false,
      preferredProfiles: [{ profileId: claudeOpus.id, nameSnapshot: claudeOpus.name }],
    });
    const disabledPlan = buildLaunchPlan({
      ...base,
      team: {
        ...codingTeam,
        members: [
          { roleId: "qa-review", instanceLabel: "Review", seatId: "seat-review", enabled: true },
        ],
      },
      roles: [techLead, disabled],
      maxMembers: 24,
    });
    expect(disabledPlan.blockers).toEqual([]);
    expect(disabledPlan.members).toHaveLength(1);
    expect(disabledPlan.warnings.some((item) => item.includes("已禁用，仍按原绑定启动"))).toBe(
      true,
    );

    const broken = role({
      id: "qa-review",
      name: "Review",
      preferredProfiles: [{ profileId: claudeOpus.id, nameSnapshot: claudeOpus.name }],
      executionPolicy: { tier: 5 },
    });
    const brokenPlan = buildLaunchPlan({
      ...base,
      team: {
        ...codingTeam,
        members: [
          { roleId: "qa-review", instanceLabel: "Review", seatId: "seat-review", enabled: true },
        ],
      },
      roles: [techLead, broken],
      maxMembers: 24,
    });
    expect(brokenPlan.blockers).toEqual([]);
    expect(brokenPlan.members).toHaveLength(1);
    expect(brokenPlan.members[0]?.profile.id).toBe(claudeOpus.id);
  });

  test("freezes the legacy SOTA launch plan", () => {
    const plan = buildLaunchPlan(base);
    expect({
      coordinator: {
        title: plan.coordinator.title,
        labels: plan.coordinator.labels,
        profile: plan.coordinator.profile,
        source: plan.coordinator.source,
        systemPrompt: plan.coordinator.systemPrompt,
      },
      members: plan.members.map((member) => ({
        seatId: member.seatId,
        roleId: member.role.id,
        instanceLabel: member.instanceLabel,
        profile: member.profile,
        source: member.source,
        title: member.title,
        labels: member.labels,
        systemPrompt: member.systemPrompt,
      })),
      kickoffMessage: plan.kickoffMessage,
      warnings: plan.warnings,
      blockers: plan.blockers,
    }).toMatchSnapshot();
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
    const tooMany = buildLaunchPlan({ ...base, maxMembers: 1 });
    expect(tooMany.blockers.some((item) => item.includes("超过上限"))).toBe(true);
    expect(tooMany.members).toHaveLength(2);
  });

  test("clamps the runtime member limit to 64 regardless of the saved preference", () => {
    const teamWith = (count: number) => ({
      ...codingTeam,
      members: Array.from({ length: count }, (_, index) => ({
        roleId: "developer",
        instanceLabel: `Seat ${index + 1}`,
        enabled: true,
      })),
    });
    const atLimit = buildLaunchPlan({
      ...base,
      team: teamWith(64),
      maxMembers: 200,
    });
    expect(atLimit.blockers).toEqual([]);
    expect(atLimit.members).toHaveLength(64);

    const over = buildLaunchPlan({
      ...base,
      team: teamWith(65),
      maxMembers: 200,
    });
    expect(over.blockers).toContain("已启用成员（65）超过上限 64。");
    expect(over.members).toHaveLength(65);

    // A saved lower limit is still enforced unchanged.
    const lower = buildLaunchPlan({ ...base, team: teamWith(9), maxMembers: 8 });
    expect(lower.blockers).toContain("已启用成员（9）超过上限 8。");
    expect(lower.members).toHaveLength(9);
  });

  test("member profile failure is a blocker, disabled members are warnings", () => {
    const blocked = buildLaunchPlan({
      ...base,
      profiles: [claudeOpus],
    });
    expect(blocked.blockers.some((item) => item.includes("Developer (Backend)"))).toBe(true);
    expect(blocked.members.map((member) => member.role.id)).toEqual(["architect"]);

    const fallback = buildLaunchPlan({
      ...base,
      team: {
        ...codingTeam,
        members: [
          { roleId: "architect", instanceLabel: "Backend", seatId: "seat-arch", enabled: true },
        ],
      },
      roles: [
        techLead,
        {
          ...architect,
          preferredProfiles: [{ profileId: "missing-profile", nameSnapshot: "Missing" }],
          fallbackProfiles: [{ profileId: codexXhigh.id, nameSnapshot: codexXhigh.name }],
        },
      ],
    });
    expect(fallback.warnings.some((item) => item.includes("缺失"))).toBe(true);
    expect(fallback.warnings.some((item) => item.includes("改用备选"))).toBe(true);

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

import { describe, expect, test } from "vitest";
import { hashLaunchPlan } from "../server/launch-hash";
import { buildLaunchPlan, type LaunchPlan } from "../shared/domain/launch-plan";
import {
  type EconomyPolicy,
  type HostSnapshot,
  normalizeEconomyPolicy,
} from "../shared/domain/mode-resolver";
import { identifyModelFamily } from "../shared/domain/model-family";
import type { ModeIssue } from "../shared/domain/role-execution";
import { buildTeamModelPlan } from "../shared/domain/team-model-plan";
import type { PaseoProfile, ProviderAvailability } from "../shared/paseo/adapter";
import type { Role } from "../shared/schemas/role";
import type { Team } from "../shared/schemas/team";
import { zh } from "../shared/zh";
import { cheapIssueText } from "../shared/zh/mode-plan";
import { NOW, role, techLead } from "./fixtures";

const sonnet = { id: "p-sonnet", name: "Sonnet", provider: "claude", model: "claude-sonnet-5" };
const haiku = { id: "p-haiku", name: "Haiku", provider: "claude", model: "claude-haiku-4-5" };
const deepseek = { id: "p-deepseek", name: "DeepSeek", provider: "omp", model: "deepseek-v4" };
const profiles: PaseoProfile[] = [sonnet, haiku, deepseek];
const availability: ProviderAvailability[] = [
  { provider: "claude", available: true },
  { provider: "omp", available: true },
];
const host: HostSnapshot = { status: "ready", profiles, availability };

function entry(profile: PaseoProfile, overrides: Record<string, unknown> = {}) {
  const match = identifyModelFamily(profile);
  return {
    profileId: profile.id,
    nameSnapshot: profile.name,
    enabled: true,
    costClass: "low",
    family: match.status === "identified" ? match.family : "unknown",
    boundModel: { provider: profile.provider, model: profile.model ?? "" },
    ...overrides,
  };
}

function rawPolicy(
  overrides: {
    routes?: Record<string, string[]>;
    profiles?: unknown[];
    executionTaskOrder?: Record<string, unknown>;
    profileBudget?: Record<string, string>;
  } = {},
) {
  return {
    pool: [],
    taskOrder: {},
    profileBudget: overrides.profileBudget ?? {},
    allSeats: {
      version: 1,
      profiles: overrides.profiles ?? [entry(sonnet), entry(haiku), entry(deepseek)],
      routes: overrides.routes ?? {
        coordinator: [sonnet.id],
        decision: [haiku.id],
        execution: [deepseek.id],
        escalation: [haiku.id],
        retain: [haiku.id],
      },
      ...(overrides.executionTaskOrder === undefined
        ? {}
        : { executionTaskOrder: overrides.executionTaskOrder }),
    },
  };
}

function policyOf(raw: unknown): EconomyPolicy {
  const result = normalizeEconomyPolicy(raw, profiles);
  if (!result.ok) throw new Error("policy failed");
  return result.value;
}

function readyAllSeats(policy: EconomyPolicy) {
  if (policy.allSeats?.status !== "ready") throw new Error("allSeats not ready");
  return policy.allSeats;
}

const roles: Role[] = [
  role({ id: "lead", name: "Lead", preferredProfiles: [{ profileId: sonnet.id }] }),
  role({
    id: "eng-fullstack",
    name: "Engineer",
    preferredProfiles: [{ profileId: deepseek.id }],
  }),
];
const team: Team = {
  id: "t1",
  name: "Team",
  coordinatorRoleId: "lead",
  members: [{ roleId: "eng-fullstack", enabled: true }],
  mode: "economy-all",
  memberCreation: "eager",
  enabled: true,
  createdAt: NOW,
  updatedAt: NOW,
};

function planWith(policy: EconomyPolicy, config: unknown = {}) {
  return buildLaunchPlan({
    team,
    roles,
    profiles,
    availability,
    workspaceId: "ws-1",
    task: "t",
    runId: "r",
    maxMembers: 8,
    mode: "economy-all",
    host,
    economy: policy,
    runtimeCapabilities: { onDemand: true, expansion: true, collaboration: false },
    daemonConfig: config,
  });
}

function _issuesOf(issues: readonly ModeIssue[], code: string) {
  return issues.filter((issue) => issue.code === code);
}

describe("cheap issue copy and ordering", () => {
  test("T12: every cheap code has a real sentence and carries its location params", () => {
    const codes: ModeIssue[] = [
      {
        code: "MODE_CHEAP_POLICY_REQUIRED",
        severity: "blocker",
        params: { route: "execution", reason: "absent" },
      },
      {
        code: "MODE_CHEAP_PROFILE_INVALID",
        severity: "blocker",
        params: { route: "execution", profileId: "p", reason: "budget-conflict" },
      },
      {
        code: "MODE_CHEAP_ROUTE_UNAVAILABLE",
        severity: "blocker",
        params: { route: "execution", candidates: 1, unverified: 1 },
      },
    ];
    for (const issue of codes) {
      const text = cheapIssueText(issue);
      expect(text).not.toBe("");
      expect(text).not.toBe(zh.modes.unknownFallback(issue.code));
      expect(text).toContain("execution");
    }
  });

  test("T13: read-side duplicates/outside ids/order limits are reported in a fixed order", () => {
    const raw = rawPolicy({
      profiles: [entry(sonnet), entry(sonnet), entry(haiku)],
      routes: { execution: [sonnet.id, sonnet.id, "outside"], escalation: [haiku.id] },
      executionTaskOrder: { coding: ["outside"] },
      profileBudget: { [sonnet.id]: "sota" },
    });
    const before = structuredClone(raw);
    const policy = policyOf(raw);
    expect(raw).toEqual(before);
    const allSeats = readyAllSeats(policy);
    const reasons = allSeats.issues
      .filter((issue) => issue.code === "MODE_CHEAP_PROFILE_INVALID")
      .map((issue) => issue.params.reason);
    expect(reasons).toContain("duplicate");
    expect(reasons).toContain("outside-list");

    const plan = planWith(policy);
    const invalid = plan.seatIssues
      .map((issue, index) => ({ issue, index }))
      .filter(
        (item) =>
          item.issue.code === "MODE_CHEAP_PROFILE_INVALID" && item.issue.severity === "blocker",
      );
    const route = plan.seatIssues
      .map((issue, index) => ({ issue, index }))
      .filter(
        (item) =>
          item.issue.code === "MODE_CHEAP_ROUTE_UNAVAILABLE" &&
          item.issue.severity === "blocker" &&
          item.issue.params.route === "execution",
      );
    expect(route).toHaveLength(1);
    expect(invalid.every((item) => item.index < (route[0]?.index ?? -1))).toBe(true);
    expect(route[0]?.issue.params.unverified).toBe(0);
  });

  test("T13: >32 entries are reported, not truncated", () => {
    const many = Array.from({ length: 33 }, (_, index) =>
      entry(sonnet, { profileId: `p-${index}` }),
    );
    const policy = policyOf(rawPolicy({ profiles: many }));
    const allSeats = readyAllSeats(policy);
    expect(allSeats.profiles).toHaveLength(33);
    expect(
      allSeats.issues.some(
        (issue) => issue.code === "MODE_CHEAP_POLICY_REQUIRED" && issue.params.reason === "limit",
      ),
    ).toBe(true);
  });

  test("T10: deeply frozen storage is not rewritten by normalize", () => {
    const raw = rawPolicy();
    const deepFreeze = (value: unknown): void => {
      if (value !== null && typeof value === "object") {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
      }
    };
    deepFreeze(raw);
    const clone = structuredClone(raw);
    const policy = policyOf(raw);
    expect(policy.allSeats?.status).toBe("ready");
    expect(raw).toEqual(clone);
  });
});

describe("kernel boundaries", () => {
  test("unknown stored mode keeps effectiveMode null and blocks", () => {
    const result = buildTeamModelPlan({
      team: { ...team, mode: "turbo" },
      roles,
      host,
      economy: policyOf(rawPolicy()),
      maxMembers: 8,
      runtimeCapabilities: { onDemand: true, expansion: true, collaboration: false },
    });
    expect(result.effectiveMode).toBeNull();
    expect(result.rawMode).toBe("turbo");
    expect(result.blockers.some((issue) => issue.code === "MODE_UNKNOWN")).toBe(true);
    expect(result.coordinator.selection).toBeNull();
  });

  test("hash changes with allSeats routes/order/availability, not with nameSnapshot", () => {
    const policy = policyOf(rawPolicy());
    const first = planWith(policy);
    const hashOf = (p: LaunchPlan, economy: EconomyPolicy) =>
      hashLaunchPlan({
        team: p.team,
        roles,
        plan: p,
        host,
        economy,
        target: { kind: "workspace", workspaceId: "ws-1" },
        task: "t",
        maxMembers: 8,
        runtimeCapabilities: { onDemand: true, expansion: true, collaboration: false },
      });
    const base = hashOf(first, policy);

    const renamed = policyOf(
      rawPolicy({
        profiles: [entry(sonnet, { nameSnapshot: "Renamed" }), entry(haiku), entry(deepseek)],
      }),
    );
    expect(hashOf(planWith(renamed), renamed)).toBe(base);

    const reordered = policyOf(
      rawPolicy({
        routes: { coordinator: [sonnet.id], execution: [deepseek.id], escalation: [haiku.id] },
      }),
    );
    expect(hashOf(planWith(reordered), reordered)).not.toBe(base);

    const unavailable = policyOf(
      rawPolicy({
        routes: { coordinator: [sonnet.id], execution: [haiku.id], escalation: [haiku.id] },
      }),
    );
    const unavailableHost: HostSnapshot = {
      status: "ready",
      profiles,
      availability: [
        { provider: "claude", available: false },
        { provider: "omp", available: true },
      ],
    };
    const unavailablePlan = buildLaunchPlan({
      team,
      roles,
      profiles,
      availability: unavailableHost.status === "ready" ? unavailableHost.availability : [],
      workspaceId: "ws-1",
      task: "t",
      runId: "r",
      maxMembers: 8,
      mode: "economy-all",
      host: unavailableHost,
      economy: unavailable,
      runtimeCapabilities: { onDemand: true, expansion: true, collaboration: false },
      daemonConfig: {},
    });
    expect(
      hashLaunchPlan({
        team: unavailablePlan.team,
        roles,
        plan: unavailablePlan,
        host: unavailableHost,
        economy: unavailable,
        target: { kind: "workspace", workspaceId: "ws-1" },
        task: "t",
        maxMembers: 8,
        runtimeCapabilities: { onDemand: true, expansion: true, collaboration: false },
      }),
    ).not.toBe(base);
  });

  test("coordinator tool gate uses the final cheap provider", () => {
    const plan = planWith(policyOf(rawPolicy()), {
      providers: { claude: { paseoTools: { enabled: false } } },
    });
    expect(plan.blockers).toContain(zh.providerToolsDisabled("claude"));
  });

  test("coordinator economy-all failure comes from the coordinator route", () => {
    const policy = policyOf(rawPolicy({ routes: { coordinator: [], execution: [deepseek.id] } }));
    const result = buildTeamModelPlan({
      team,
      roles,
      host,
      economy: policy,
      maxMembers: 8,
      runtimeCapabilities: { onDemand: true, expansion: true, collaboration: false },
    });
    expect(
      result.coordinator.issues.some(
        (issue) =>
          issue.code === "MODE_CHEAP_ROUTE_UNAVAILABLE" && issue.params.route === "coordinator",
      ),
    ).toBe(true);
  });

  test("legacy coordinator keeps fallback source and warnings order", () => {
    const fallbackRole = {
      ...techLead,
      preferredProfiles: [{ profileId: "missing-preferred" }],
      fallbackProfiles: [{ profileId: sonnet.id }],
    };
    const result = buildTeamModelPlan({
      team: { ...team, mode: "sota", coordinatorRoleId: fallbackRole.id },
      roles: [fallbackRole, ...roles.slice(1)],
      host,
      economy: policyOf(rawPolicy()),
      maxMembers: 8,
      runtimeCapabilities: { onDemand: false, expansion: false, collaboration: false },
    });
    expect(result.coordinator.selection?.source).toBe("role-fallback");
    expect(result.coordinator.warnings[0]).toContain("缺失");
  });
});

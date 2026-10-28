import { describe, expect, test } from "vitest";
import { formatLaunchBudget } from "../client/shared/budget-format";
import { buildLaunchPlan } from "../shared/domain/launch-plan";
import { toModeLaunchPreview } from "../shared/domain/launch-preview";
import {
  type EconomyPolicy,
  type HostSnapshot,
  normalizeEconomyPolicy,
} from "../shared/domain/mode-resolver";
import { identifyModelFamily } from "../shared/domain/model-family";
import { buildTeamModelPlan } from "../shared/domain/team-model-plan";
import type { PaseoProfile, ProviderAvailability } from "../shared/paseo/adapter";
import { ModeLaunchPreviewSchema } from "../shared/schemas/launch-preview";
import type { Role } from "../shared/schemas/role";
import type { Team } from "../shared/schemas/team";
import { modesZh } from "../shared/zh/modes";
import { NOW, role } from "./fixtures";

const sonnet: PaseoProfile = {
  id: "p-sonnet",
  name: "Sonnet",
  provider: "claude",
  model: "claude-sonnet-5",
};
const deepseek: PaseoProfile = {
  id: "p-ds",
  name: "DS",
  provider: "omp",
  model: "deepseek-v4",
};
const opus: PaseoProfile = {
  id: "p-opus",
  name: "Opus",
  provider: "claude",
  model: "claude-opus-5-5",
};
const profiles = [sonnet, deepseek, opus];
const up: ProviderAvailability[] = [
  { provider: "claude", available: true },
  { provider: "omp", available: true },
];
const host = (
  availability: ProviderAvailability[] = up,
  list: PaseoProfile[] = profiles,
): HostSnapshot => ({ status: "ready", profiles: list, availability });

function entry(profile: PaseoProfile, extra: Record<string, unknown> = {}) {
  const match = identifyModelFamily(profile);
  return {
    profileId: profile.id,
    enabled: true,
    costClass: "low",
    family: match.status === "identified" ? match.family : "unknown",
    boundModel: { provider: profile.provider, model: profile.model },
    ...extra,
  };
}

function policy(
  allSeats: {
    profiles?: unknown[];
    routes?: Record<string, string[]>;
  } = {},
  list: PaseoProfile[] = profiles,
): EconomyPolicy {
  const result = normalizeEconomyPolicy(
    {
      pool: [],
      taskOrder: {},
      profileBudget: {},
      allSeats: {
        version: 1,
        profiles: allSeats.profiles ?? [entry(sonnet), entry(deepseek)],
        routes: allSeats.routes ?? {
          coordinator: [sonnet.id],
          decision: [sonnet.id],
          execution: [deepseek.id],
          escalation: [sonnet.id],
          retain: [sonnet.id],
        },
      },
    },
    list,
  );
  if (!result.ok) throw new Error("policy failed");
  return result.value;
}

const roles: Role[] = [
  role({ id: "lead", name: "Lead", preferredProfiles: [{ profileId: opus.id }] }),
  role({ id: "eng-fullstack", name: "Eng", preferredProfiles: [{ profileId: opus.id }] }),
];
const team = (mode?: string): Team => ({
  id: "t1",
  name: "T",
  coordinatorRoleId: "lead",
  members: [{ roleId: "eng-fullstack", enabled: true }],
  ...(mode === undefined ? {} : { mode }),
  memberCreation: "eager",
  enabled: true,
  createdAt: NOW,
  updatedAt: NOW,
});
const caps = { onDemand: true, expansion: true, collaboration: false };

function launch(
  mode: string | undefined,
  economy: EconomyPolicy,
  h: HostSnapshot = host(),
  roleList: Role[] = roles,
) {
  return buildLaunchPlan({
    team: team(mode),
    roles: roleList,
    profiles: h.status === "ready" ? h.profiles : [],
    availability: h.status === "ready" ? h.availability : [],
    workspaceId: "ws",
    task: "t",
    runId: "r",
    maxMembers: 8,
    host: h,
    economy,
    runtimeCapabilities: caps,
    daemonConfig: {},
  });
}

function executionReason(economy: EconomyPolicy, h: HostSnapshot = host()): unknown {
  const plan = buildTeamModelPlan({
    team: team("economy-all"),
    roles,
    host: h,
    economy,
    maxMembers: 8,
    runtimeCapabilities: caps,
  });
  const issue = plan.issues.find(
    (item) =>
      item.code === "MODE_CHEAP_ROUTE_UNAVAILABLE" &&
      item.severity === "blocker" &&
      item.params.route === "execution",
  );
  expect(issue).toBeDefined();
  return issue?.params.reason;
}

describe("P1-FIX1 item 2: MODE_CHEAP_ROUTE_UNAVAILABLE carries a stable reason", () => {
  const exec = (ids: string[]) => ({
    coordinator: [sonnet.id],
    decision: [sonnet.id],
    execution: ids,
    escalation: [sonnet.id],
    retain: [sonnet.id],
  });

  test("route empty / list empty", () => {
    expect(executionReason(policy({ routes: exec([]) }))).toBe("route-empty");
    expect(executionReason(policy({ profiles: [], routes: exec([]) }))).toBe("list-empty");
  });

  test("every candidate fails for the same cause", () => {
    expect(
      executionReason(policy({ profiles: [entry(sonnet), entry(deepseek, { enabled: false })] })),
    ).toBe("all-disabled");
    expect(
      executionReason(
        policy(),
        host([
          { provider: "claude", available: true },
          { provider: "omp", available: false },
        ]),
      ),
    ).toBe("provider-unavailable");
    expect(executionReason(policy(), host([{ provider: "claude", available: true }]))).toBe(
      "availability-unverified",
    );
    expect(executionReason(policy(), host(up, [sonnet, opus]))).toBe("profile-missing");
    expect(
      executionReason(
        policy({
          profiles: [entry(sonnet), entry(opus, { family: "sonnet" })],
          routes: exec([opus.id]),
        }),
      ),
    ).toBe("model-unverified");
  });

  test("mixed causes are no-eligible", () => {
    expect(
      executionReason(
        policy({
          profiles: [entry(sonnet), entry(deepseek, { enabled: false }), entry(opus)],
          routes: exec([deepseek.id, opus.id]),
        }),
      ),
    ).toBe("no-eligible");
  });
});

describe("P1-FIX1 item 7: unknown stored mode in the launch preview", () => {
  test("no placeholder requestedMode, rawMode kept, coordinator shown as the baseline did", () => {
    const economy = policy();
    const plan = launch("Economy", economy);
    expect(plan.blockers.length).toBeGreaterThan(0);
    expect(plan.rawMode).toBe("Economy");
    expect(plan.coordinator.profile.id).toBe(opus.id);
    const preview = toModeLaunchPreview(plan, "h", [], economy);
    expect(preview.requestedMode).toBeUndefined();
    expect(preview.rawMode).toBe("Economy");
    expect(preview.coordinator.roleId).toBe("lead");
    expect(preview.coordinator.profile?.id).toBe(opus.id);
    expect(preview.issues.map((item) => item.code)).toContain("MODE_UNKNOWN");
    expect(ModeLaunchPreviewSchema.safeParse(preview).success).toBe(true);
  });

  test("a known mode still reports requestedMode and no rawMode", () => {
    const economy = policy();
    const preview = toModeLaunchPreview(launch("economy-all", economy), "h", [], economy);
    expect(preview.requestedMode).toBe("economy-all");
    expect(preview.rawMode).toBeUndefined();
  });
});

describe("P1-FIX1 item 8: policy and configuration issues reach the DTO", () => {
  test("allSeats read-side issues become issues and warnings in economy-all only", () => {
    const economy = policy({
      routes: {
        coordinator: [sonnet.id],
        decision: [sonnet.id],
        execution: [deepseek.id, "ghost"],
        escalation: [sonnet.id],
        retain: [sonnet.id],
      },
    });
    const all = launch("economy-all", economy);
    expect(all.blockers).toEqual([]);
    expect(
      all.seatIssues.some(
        (item) =>
          item.code === "MODE_CHEAP_PROFILE_INVALID" &&
          item.severity === "warning" &&
          item.params.profileId === "ghost" &&
          item.params.reason === "outside-list",
      ),
    ).toBe(true);
    expect(all.warnings.some((text) => text.includes("ghost"))).toBe(true);
    const preview = toModeLaunchPreview(all, "h", [], economy);
    expect(preview.issues.some((item) => item.params.profileId === "ghost")).toBe(true);

    const standard = launch("economy", economy);
    expect(standard.seatIssues.some((item) => item.code.startsWith("MODE_CHEAP"))).toBe(false);
  });

  test("an unreadable coordinator tier keeps its warning in economy-all", () => {
    const odd = role({
      id: "lead",
      name: "Lead",
      preferredProfiles: [{ profileId: opus.id }],
      executionPolicy: { tier: "future-tier" },
    });
    const plan = launch("economy-all", policy(), host(), [odd, roles[1] as Role]);
    expect(plan.blockers).toEqual([]);
    expect(
      plan.seatIssues.some(
        (item) => item.code === "MODE_ROLE_POLICY_UNKNOWN" && item.severity === "warning",
      ),
    ).toBe(true);
  });
});

describe("P1-FIX1 item 10: economy-all budget basis is not the economy pool", () => {
  test("seats and coordinator carry basis route and read as such", () => {
    const economy = policy();
    const plan = launch("economy-all", economy);
    const preview = toModeLaunchPreview(plan, "h", [], economy);
    expect(preview.coordinator.budgetBasis).toBe("route");
    expect(preview.seats.map((seat) => seat.budgetBasis)).toEqual(["route"]);
    expect(formatLaunchBudget("economy", "route")).toContain(modesZh.budgetBasisRoute);
    expect(formatLaunchBudget("economy", "route")).not.toContain("经济池");
    expect(ModeLaunchPreviewSchema.safeParse(preview).success).toBe(true);
  });

  test("standard mode keeps basis pool", () => {
    const result = normalizeEconomyPolicy(
      {
        pool: [
          {
            profileId: deepseek.id,
            family: "deepseek",
            enabled: true,
            boundModel: { provider: "omp", model: deepseek.model },
          },
        ],
        taskOrder: {},
        profileBudget: {},
      },
      profiles,
    );
    if (!result.ok) throw new Error("x");
    const plan = launch("economy", result.value);
    expect(plan.seats[0]?.selected.budgetBasis).toBe("pool");
  });
});

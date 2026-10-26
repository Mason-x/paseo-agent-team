import { describe, expect, test } from "vitest";
import {
  type EconomyPolicy,
  type HostSnapshot,
  normalizeEconomyPolicy,
} from "../shared/domain/mode-resolver";
import {
  buildSeatPlan,
  MAX_RUNTIME_MEMBERS,
  type RuntimeCapabilities,
  type SeatPlan,
} from "../shared/domain/seat-plan";
import type { PaseoProfile, ProviderAvailability } from "../shared/paseo/adapter";
import { PreferencesSchema } from "../shared/schemas/preferences";
import type { Role } from "../shared/schemas/role";
import type { Team, TeamMember } from "../shared/schemas/team";
import type { TeamMode } from "../shared/schemas/team-mode";
import { NOW, role } from "./fixtures";

const deepseek: PaseoProfile = {
  id: "profile-deepseek",
  name: "DeepSeek-V4.1-Flash-Max",
  provider: "omp",
  model: "opencode-go/deepseek-v4.1-flash",
  modeId: "full",
  thinkingOptionId: "max",
};
const grokXhigh: PaseoProfile = {
  id: "profile-grok-xhigh",
  name: "Grok-4.7-Xhigh",
  provider: "omp",
  model: "CPA/grok-4.7",
  modeId: "full",
  thinkingOptionId: "xhigh",
};
const grokXhighFast: PaseoProfile = {
  id: "profile-grok-xhigh-fast",
  name: "Grok-4.7-Xhigh-Fast",
  provider: "omp",
  model: "cursor/grok-4.7-500k-fast",
  modeId: "full",
  thinkingOptionId: "xhigh",
};
const claude: PaseoProfile = {
  id: "profile-claude-opus",
  name: "Claude-Opus-5.5-Max",
  provider: "claude",
  model: "claude-opus-5-5",
  modeId: "auto",
  thinkingOptionId: "max",
};

const allProfiles = [deepseek, grokXhigh, grokXhighFast, claude];
const available: ProviderAvailability[] = [
  { provider: "claude", available: true },
  { provider: "omp", available: true },
];
const host: HostSnapshot = { status: "ready", profiles: allProfiles, availability: available };

const policy = (() => {
  const entries = [deepseek, grokXhigh, grokXhighFast].map((profile) => ({
    profileId: profile.id,
    family: profile.id === deepseek.id ? "deepseek" : "grok",
    enabled: true,
    boundModel: { provider: profile.provider, model: profile.model },
  }));
  const ids = entries.map((entry) => entry.profileId);
  const taskOrder = {
    coding: ids,
    testing: ids,
    acceptance: ids,
    codebase: ids,
    ops: [grokXhigh.id, grokXhighFast.id, deepseek.id],
    general: ids,
  };
  const result = normalizeEconomyPolicy({ pool: entries, taskOrder }, allProfiles);
  if (!result.ok) throw new Error("unexpected economy policy failure");
  return result.value;
})();

function roleOf(id: string, overrides: Partial<Role> = {}): Role {
  return role({
    id,
    name: `Role ${id}`,
    preferredProfiles: [{ profileId: claude.id, nameSnapshot: claude.name }],
    ...overrides,
  });
}

const roles: Role[] = [
  roleOf("lead-tech"),
  roleOf("qa-review"),
  roleOf("qa-test"),
  roleOf("research-web"),
  roleOf("eng-fullstack"),
  roleOf("eng-expert"),
];

function member(roleId: string, instanceLabel?: string, seatId?: string): TeamMember {
  return {
    roleId,
    ...(instanceLabel === undefined ? {} : { instanceLabel }),
    ...(seatId === undefined ? {} : { seatId }),
    enabled: true,
  };
}

function teamOf(
  members: TeamMember[],
  overrides: Partial<Pick<Team, "mode" | "memberCreation" | "collaboration">> = {},
): Team {
  return {
    id: "seat-team",
    name: "Seat Team",
    coordinatorRoleId: "lead-tech",
    members,
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function executionMembers(count: number): TeamMember[] {
  return Array.from({ length: count }, (_, index) =>
    member("eng-fullstack", `Seat ${index + 1}`, `seat-${index + 1}`),
  );
}

function planFor(
  members: TeamMember[],
  options: {
    mode?: TeamMode;
    maxMembers?: number;
    economy?: EconomyPolicy;
    overrides?: Partial<Pick<Team, "mode" | "memberCreation" | "collaboration">>;
    host?: HostSnapshot;
    runtimeCapabilities?: RuntimeCapabilities;
  } = {},
) {
  return buildSeatPlan({
    team: teamOf(members, options.overrides),
    roles,
    host: options.host ?? host,
    economy: options.economy ?? policy,
    maxMembers: options.maxMembers ?? 24,
    mode: options.mode,
    runtimeCapabilities: options.runtimeCapabilities,
  });
}

const seatByRole = (plan: SeatPlan, roleId: string) =>
  plan.seats.find((seat) => seat.roleId === roleId);

describe("bounded seat planning", () => {
  test("plans 12 members on the new default limit and never counts the coordinator", () => {
    const plan = planFor(executionMembers(12), { mode: "sota" });
    expect(plan.blockers).toEqual([]);
    expect(plan.counts).toEqual({
      logical: 12,
      physical: 12,
      eager: 12,
      deferred: 0,
      escalation: 0,
      sotaPotential: 12,
    });
    expect(plan.seats.map((seat) => seat.seatId)).toEqual(
      Array.from({ length: 12 }, (_, index) => `seat-${index + 1}`),
    );
    expect(plan.seats.every((seat) => seat.roleId === "eng-fullstack")).toBe(true);
    expect(plan.seats.some((seat) => seat.roleId === "lead-tech")).toBe(false);
    expect(plan.seats.every((seat) => seat.selected.unavailable === false)).toBe(true);
  });

  test("keeps an already-saved limit of 8 instead of silently raising it", () => {
    expect(PreferencesSchema.parse({ maxMembers: 8 }).maxMembers).toBe(8);
    const plan = planFor(executionMembers(12), { mode: "sota", maxMembers: 8 });
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_MEMBER_LIMIT",
        severity: "blocker",
        params: { members: 12, limit: 8 },
      }),
    );
  });

  test("enforces the 24 and 64 boundaries on physical seats", () => {
    expect(MAX_RUNTIME_MEMBERS).toBe(64);
    expect(planFor(executionMembers(24), { mode: "sota", maxMembers: 24 }).blockers).toEqual([]);
    expect(planFor(executionMembers(25), { mode: "sota", maxMembers: 24 }).blockers).toContainEqual(
      expect.objectContaining({ code: "MODE_MEMBER_LIMIT", params: { members: 25, limit: 24 } }),
    );
    expect(planFor(executionMembers(64), { mode: "sota", maxMembers: 200 }).blockers).toEqual([]);
    expect(
      planFor(executionMembers(65), { mode: "sota", maxMembers: 200 }).blockers,
    ).toContainEqual(
      expect.objectContaining({ code: "MODE_MEMBER_LIMIT", params: { members: 65, limit: 64 } }),
    );
  });

  test("33 two-way execution seats exceed 64 after judge and reserve seats", () => {
    const plan = planFor(
      [
        ...executionMembers(33),
        member("qa-test", "Judge", "seat-judge"),
        member("eng-expert", "Expert", "seat-expert"),
      ],
      { mode: "collaborative", maxMembers: 200 },
    );
    expect(plan.counts.logical).toBe(35);
    expect(plan.counts.physical).toBe(68);
    expect(plan.counts.deferred).toBe(67);
    expect(plan.counts.escalation).toBe(1);
    expect(plan.seats.filter((seat) => seat.purpose === "candidate")).toHaveLength(66);
    expect(seatByRole(plan, "qa-test")?.purpose).toBe("judge");
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_MEMBER_LIMIT",
        params: { members: 68, limit: 64 },
      }),
    );
  });

  test("standby seats count toward the physical limit", () => {
    const atLimit = planFor(
      [...executionMembers(63), member("eng-expert", "Escalation", "seat-expert")],
      { mode: "economy", maxMembers: 64 },
    );
    expect(atLimit.counts.physical).toBe(64);
    expect(atLimit.blockers).not.toContainEqual(
      expect.objectContaining({ code: "MODE_MEMBER_LIMIT" }),
    );

    const over = planFor(
      [...executionMembers(64), member("eng-expert", "Escalation", "seat-expert")],
      { mode: "economy", maxMembers: 64 },
    );
    expect(over.counts.physical).toBe(65);
    expect(over.blockers).toContainEqual(
      expect.objectContaining({ code: "MODE_MEMBER_LIMIT", params: { members: 65, limit: 64 } }),
    );
  });

  test("legal repeat Role instances run, while duplicate labels and seatIds are rejected", () => {
    const repeated = planFor(
      [
        member("eng-fullstack", "Backend", "seat-backend"),
        member("eng-fullstack", "Frontend", "seat-frontend"),
      ],
      { mode: "sota" },
    );
    expect(repeated.blockers).toEqual([]);
    expect(repeated.counts.physical).toBe(2);
    expect(repeated.seats.map((seat) => seat.instanceLabel)).toEqual(["Backend", "Frontend"]);

    const duplicateLabel = planFor(
      [member("eng-fullstack", "Backend", "seat-1"), member("eng-fullstack", "backend", "seat-2")],
      { mode: "sota" },
    );
    expect(duplicateLabel.blockers).toEqual([]);
    expect(duplicateLabel.issues).toContainEqual(
      expect.objectContaining({
        code: "MODE_SEAT_DUPLICATE",
        severity: "warning",
        params: expect.objectContaining({ instanceLabel: "backend" }),
      }),
    );

    const exactLabel = planFor(
      [member("eng-fullstack", "Backend", "seat-1"), member("eng-fullstack", "Backend", "seat-2")],
      { mode: "sota" },
    );
    expect(exactLabel.blockers).toEqual([]);
    expect(exactLabel.issues).toContainEqual(
      expect.objectContaining({
        code: "MODE_SEAT_DUPLICATE",
        severity: "warning",
        params: expect.objectContaining({ instanceLabel: "Backend" }),
      }),
    );

    for (const mode of ["economy", "collaborative"] as const) {
      const blocked = planFor(
        [member("qa-review", "A", "seat-1"), member("qa-review", "A", "seat-2")],
        { mode },
      );
      expect(blocked.blockers, mode).toContainEqual(
        expect.objectContaining({
          code: "MODE_SEAT_DUPLICATE",
          params: expect.objectContaining({ instanceLabel: "A" }),
        }),
      );
    }

    const duplicateSeat = planFor(
      [
        member("eng-fullstack", "Backend", "seat-same"),
        member("eng-fullstack", "Frontend", "seat-same"),
      ],
      { mode: "sota" },
    );
    expect(duplicateSeat.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_SEAT_DUPLICATE",
        params: { seatId: "seat-same" },
      }),
    );

    const missingLabel = planFor(
      [member("eng-fullstack", undefined, "seat-a"), member("eng-fullstack", undefined, "seat-b")],
      { mode: "sota" },
    );
    expect(missingLabel.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_SEAT_DUPLICATE",
        params: expect.objectContaining({ reason: "instance-label-required" }),
      }),
    );
  });

  test("legacy members without seatId get the same run-local keys every call", () => {
    const legacy = [member("eng-fullstack", "Backend"), member("eng-fullstack", "Frontend")];
    const first = planFor(legacy, { mode: "sota" });
    const second = planFor(legacy, { mode: "sota" });
    expect(first.seats.map((seat) => seat.seatId)).toEqual(["seat-1", "seat-2"]);
    expect(second.seats.map((seat) => seat.seatId)).toEqual(["seat-1", "seat-2"]);
  });

  test("SOTA keeps every seat active and eager on its original binding", () => {
    const plan = planFor(
      [
        member("qa-review", "Review", "seat-review"),
        member("research-web", "Research", "seat-research"),
        member("eng-fullstack", "Build", "seat-build"),
        member("eng-expert", "Expert", "seat-expert"),
      ],
      { mode: "sota" },
    );
    expect(plan.blockers).toEqual([]);
    expect(plan.counts).toMatchObject({
      logical: 4,
      physical: 4,
      eager: 4,
      deferred: 0,
      escalation: 0,
    });
    for (const seat of plan.seats) {
      expect(seat.purpose).toBe("member");
      expect(seat.activation).toBe("eager");
      expect(seat.selected.unavailable).toBe(false);
      expect(seat.selected.profile?.id).toBe(claude.id);
      expect(seat.selected.standby).toBe(false);
    }
  });

  test("economy keeps decision/retain on their binding and moves only execution seats", () => {
    const plan = planFor(
      [
        member("qa-review", "Review", "seat-review"),
        member("research-web", "Research", "seat-research"),
        member("eng-fullstack", "Build", "seat-build"),
        member("eng-expert", "Expert", "seat-expert"),
      ],
      { mode: "economy" },
    );
    expect(plan.blockers).toEqual([]);
    expect(plan.counts).toEqual({
      logical: 4,
      physical: 4,
      eager: 0,
      deferred: 3,
      escalation: 1,
      sotaPotential: 3,
    });
    expect(plan.budget).toEqual({ economy: 1, sota: 0, unknown: 3, deferredSota: 1 });

    const decision = seatByRole(plan, "qa-review");
    expect(decision).toMatchObject({ purpose: "member", activation: "on-demand" });
    expect(decision?.selected.profile).toMatchObject({ id: claude.id });
    expect(decision?.selected.standby).toBe(false);

    const execution = seatByRole(plan, "eng-fullstack");
    expect(execution).toMatchObject({ purpose: "member", activation: "on-demand" });
    expect(execution?.selected.profile).toMatchObject({ id: deepseek.id });
    expect(execution?.selected).toMatchObject({ budget: "economy", budgetBasis: "pool" });

    const escalation = seatByRole(plan, "eng-expert");
    expect(escalation).toMatchObject({
      purpose: "escalation",
      activation: "escalation-only",
    });
    expect(escalation?.selected).toMatchObject({ standby: true, unavailable: false });
    expect(escalation?.selected.profile).toMatchObject({ id: claude.id });
  });

  test("collaborative expands only execution seats into one candidate per family", () => {
    const plan = planFor(
      [
        member("qa-review", "Review", "seat-review"),
        member("research-web", "Research", "seat-research"),
        member("eng-fullstack", "Build", "seat-build"),
        member("eng-expert", "Expert", "seat-expert"),
        member("qa-test", "Judge", "seat-judge"),
      ],
      { mode: "collaborative" },
    );
    expect(plan.blockers).toEqual([]);
    expect(plan.counts).toEqual({
      logical: 5,
      physical: 6,
      eager: 0,
      deferred: 5,
      escalation: 1,
      sotaPotential: 4,
    });
    expect(plan.budget).toEqual({ economy: 2, sota: 0, unknown: 4, deferredSota: 1 });

    const candidates = plan.seats.filter((seat) => seat.logicalSeatId === "seat-build");
    expect(candidates).toHaveLength(2);
    expect(candidates.map((seat) => seat.seatId)).toEqual(["seat-build-c1", "seat-build-c2"]);
    expect(candidates.map((seat) => seat.purpose)).toEqual(["candidate", "candidate"]);
    expect(candidates.map((seat) => seat.cohortId)).toEqual([
      "seat-build-cohort",
      "seat-build-cohort",
    ]);
    expect(candidates.map((seat) => seat.selected.family)).toEqual(["deepseek", "grok"]);
    expect(candidates.every((seat) => seat.activation === "on-demand")).toBe(true);
    expect(seatByRole(plan, "qa-review")?.purpose).toBe("member");
    expect(seatByRole(plan, "eng-expert")?.activation).toBe("escalation-only");
    expect(seatByRole(plan, "qa-test")).toMatchObject({
      purpose: "judge",
      activation: "on-demand",
    });
    expect(
      plan.seats.some(
        (seat) => seat.logicalSeatId === "seat-judge" && seat.purpose === "candidate",
      ),
    ).toBe(false);
  });

  test("mode override wins over the stored Team mode, and memberCreation can be overridden", () => {
    const members = [
      member("qa-review", "Review", "seat-review"),
      member("eng-fullstack", "Build", "seat-build"),
    ];
    const overridden = planFor(members, {
      mode: "sota",
      overrides: { mode: "economy" },
    });
    expect(overridden.counts.eager).toBe(2);
    expect(overridden.counts.deferred).toBe(0);
    expect(seatByRole(overridden, "eng-fullstack")?.selected.profile).toMatchObject({
      id: claude.id,
    });

    // An explicit memberCreation wins over the mode default, even for SOTA.
    const deferredSota = planFor(members, {
      mode: "sota",
      overrides: { memberCreation: "on-demand" },
    });
    expect(deferredSota.counts.eager).toBe(0);
    expect(deferredSota.counts.deferred).toBe(2);
    expect(seatByRole(deferredSota, "eng-fullstack")?.selected.profile).toMatchObject({
      id: claude.id,
    });

    const eagerEconomy = planFor(members, {
      mode: "economy",
      overrides: { memberCreation: "eager" },
    });
    expect(eagerEconomy.counts.eager).toBe(2);
    expect(eagerEconomy.counts.deferred).toBe(0);
    expect(seatByRole(eagerEconomy, "eng-fullstack")?.selected.profile).toMatchObject({
      id: deepseek.id,
    });

    const invalidCreation = planFor(members, {
      mode: "economy",
      overrides: { memberCreation: "sometimes" },
    });
    expect(invalidCreation.issues).toContainEqual(
      expect.objectContaining({
        code: "MODE_UNKNOWN",
        severity: "blocker",
        params: { field: "memberCreation", value: "sometimes" },
      }),
    );
    expect(invalidCreation.blockers).toContainEqual(
      expect.objectContaining({ code: "MODE_UNKNOWN" }),
    );
    expect(invalidCreation.counts.deferred).toBe(2);
  });

  test("economy defaults to eager with a warning when on-demand is not available", () => {
    const plan = planFor(
      [
        member("eng-fullstack", "Build", "seat-build"),
        member("eng-expert", "Expert", "seat-expert"),
      ],
      {
        mode: "economy",
        runtimeCapabilities: { onDemand: false, expansion: false, collaboration: false },
      },
    );
    expect(plan.blockers).toEqual([]);
    expect(seatByRole(plan, "eng-fullstack")).toMatchObject({
      purpose: "member",
      activation: "eager",
    });
    expect(seatByRole(plan, "eng-expert")).toMatchObject({
      purpose: "escalation",
      activation: "escalation-only",
    });
    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        code: "MODE_ONDEMAND_FALLBACK_EAGER",
        severity: "warning",
        params: { mode: "economy" },
      }),
    );
    expect(plan.counts).toMatchObject({ eager: 1, deferred: 0, escalation: 1 });
  });

  test("explicit on-demand blocks when the runtime does not support it", () => {
    const economy = planFor([member("eng-fullstack", "Build", "seat-build")], {
      mode: "economy",
      overrides: { memberCreation: "on-demand" },
      runtimeCapabilities: { onDemand: false, expansion: false, collaboration: false },
    });
    expect(economy.seats[0].activation).toBe("on-demand");
    expect(economy.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_ONDEMAND_UNAVAILABLE",
        params: { mode: "economy", reason: "explicit-on-demand" },
      }),
    );

    const sota = planFor([member("qa-review", "Review", "seat-review")], {
      mode: "sota",
      overrides: { memberCreation: "on-demand" },
      runtimeCapabilities: { onDemand: false, expansion: false, collaboration: false },
    });
    expect(sota.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_ONDEMAND_UNAVAILABLE",
        params: { mode: "sota", reason: "explicit-on-demand" },
      }),
    );
  });

  test("available on-demand keeps the designed economy default", () => {
    const plan = planFor([member("eng-fullstack", "Build", "seat-build")], {
      mode: "economy",
      runtimeCapabilities: { onDemand: true, expansion: false, collaboration: false },
    });
    expect(plan.seats[0].activation).toBe("on-demand");
    expect(plan.issues.some((entry) => entry.code === "MODE_ONDEMAND_FALLBACK_EAGER")).toBe(false);
  });

  test("collaborative defaults block when on-demand is missing but collaboration is available", () => {
    const plan = planFor(
      [member("eng-fullstack", "Build", "seat-build"), member("qa-test", "Judge", "seat-judge")],
      {
        mode: "collaborative",
        runtimeCapabilities: { onDemand: false, expansion: false, collaboration: true },
      },
    );
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_ONDEMAND_UNAVAILABLE",
        params: { mode: "collaborative", reason: "collaboration" },
      }),
    );
    expect(plan.issues.some((entry) => entry.code === "MODE_ONDEMAND_FALLBACK_EAGER")).toBe(false);
  });

  test("a two-family pool reduces a three-way request without inventing a path", () => {
    const plan = planFor(
      [member("eng-fullstack", "Build", "seat-build"), member("qa-test", "Judge", "seat-judge")],
      {
        mode: "collaborative",
        overrides: { collaboration: { replicas: 3 } },
      },
    );
    expect(plan.seats).toHaveLength(4);
    expect(plan.blockers).toEqual([]);
    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        code: "MODE_FAMILIES_REDUCED",
        params: expect.objectContaining({ requested: 3, families: 2 }),
      }),
    );
  });

  test("an unavailable required escalation channel blocks, while an optional one only warns", () => {
    const claudeDown = available.map((entry) =>
      entry.provider === "claude" ? { ...entry, available: false } : entry,
    );
    const optional = planFor([member("eng-expert", "Expert", "seat-expert")], {
      mode: "economy",
      host: {
        status: "ready",
        profiles: allProfiles,
        availability: claudeDown,
      },
    });
    expect(optional.blockers).not.toContainEqual(
      expect.objectContaining({ code: "MODE_ESCALATION_UNAVAILABLE" }),
    );
    expect(seatByRole(optional, "eng-expert")?.selected.unavailable).toBe(true);

    const required = planFor([member("eng-expert", "Expert", "seat-expert")], {
      mode: "economy",
      host: { status: "ready", profiles: allProfiles, availability: claudeDown },
      overrides: { collaboration: { escalationRoleId: "eng-expert" } },
    });
    expect(required.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_ESCALATION_UNAVAILABLE",
        severity: "blocker",
        params: { reason: "provider-unavailable" },
        roleId: "eng-expert",
      }),
    );

    const missing = planFor([member("eng-fullstack", "Build", "seat-build")], {
      mode: "economy",
      overrides: { collaboration: { escalationRoleId: "eng-expert" } },
    });
    expect(missing.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_ESCALATION_INVALID",
        severity: "blocker",
        params: { reason: "escalation-missing" },
        roleId: "eng-expert",
      }),
    );
  });

  test("a pool Profile reached through the original binding is billed as pool budget", () => {
    const pooledRole = roles.map((entry) =>
      entry.id === "research-web"
        ? { ...entry, preferredProfiles: [{ profileId: deepseek.id, nameSnapshot: deepseek.name }] }
        : entry,
    );
    const plan = buildSeatPlan({
      team: teamOf([member("research-web", "Research", "seat-research")]),
      roles: pooledRole,
      host,
      economy: policy,
      maxMembers: 24,
      mode: "economy",
    });
    const seat = seatByRole(plan, "research-web");
    expect(seat?.selected).toMatchObject({
      budget: "economy",
      budgetBasis: "pool",
      standby: false,
    });
    expect(plan.counts.sotaPotential).toBe(0);
  });

  test("a single-family pool degrades to one original-binding seat", () => {
    const single = normalizeEconomyPolicy(
      {
        pool: [
          {
            profileId: deepseek.id,
            family: "deepseek",
            boundModel: { provider: "omp", model: deepseek.model },
          },
        ],
      },
      allProfiles,
    );
    if (!single.ok) throw new Error("unexpected economy policy failure");
    const plan = planFor([member("eng-fullstack", "Build", "seat-build")], {
      mode: "collaborative",
      economy: single.value,
    });
    expect(plan.seats).toHaveLength(1);
    expect(plan.seats[0]).toMatchObject({
      seatId: "seat-build",
      purpose: "member",
      activation: "on-demand",
    });
    expect(plan.seats[0].selected).toMatchObject({
      source: "role-preferred",
      standby: false,
      profile: { id: claude.id },
    });
    expect(plan.issues).toContainEqual(
      expect.objectContaining({ code: "MODE_COLLAB_UNAVAILABLE" }),
    );
  });

  test("an unsupported replica count blocks and keeps the two-way default", () => {
    const plan = planFor(
      [member("eng-fullstack", "Build", "seat-build"), member("qa-test", "Judge", "seat-judge")],
      {
        mode: "collaborative",
        overrides: { collaboration: { replicas: 4 } },
      },
    );
    expect(plan.seats).toHaveLength(4);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_UNKNOWN",
        severity: "blocker",
        params: { field: "replicas", value: 4 },
      }),
    );
  });

  test("missing Roles block, while SOTA invalid tiers are only warnings", () => {
    const missingRole = planFor([member("ghost", "Ghost", "seat-ghost")], { mode: "sota" });
    expect(missingRole.seats).toEqual([]);
    expect(missingRole.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_PROFILE_UNRESOLVED",
        params: { reason: "role-missing" },
        roleId: "ghost",
      }),
    );

    const brokenRole = roleOf("eng-fullstack", { executionPolicy: { tier: 5 } });
    const invalidPolicy = buildSeatPlan({
      team: teamOf([member("eng-fullstack", "Build", "seat-build")]),
      roles: [...roles.filter((entry) => entry.id !== "eng-fullstack"), brokenRole],
      host,
      economy: policy,
      maxMembers: 24,
      mode: "sota",
    });
    expect(invalidPolicy.blockers).toEqual([]);
    expect(invalidPolicy.seats).toHaveLength(1);
    expect(invalidPolicy.issues).toContainEqual(
      expect.objectContaining({
        code: "MODE_ROLE_POLICY_UNKNOWN",
        severity: "warning",
        params: expect.objectContaining({ field: "tier", value: 5 }),
      }),
    );
  });

  test("a disabled execution Role cannot form a cohort", () => {
    const disabled = roleOf("eng-fullstack", { enabled: false });
    const disabledRoles = [...roles.filter((entry) => entry.id !== "eng-fullstack"), disabled];
    const plan = buildSeatPlan({
      team: teamOf([member("eng-fullstack", "Build", "seat-build")]),
      roles: disabledRoles,
      host,
      economy: policy,
      maxMembers: 24,
      mode: "collaborative",
    });
    expect(plan.seats).toEqual([]);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "MODE_ROLE_DISABLED", roleId: "eng-fullstack" }),
    );

    const singleSeat = buildSeatPlan({
      team: teamOf([member("eng-fullstack", "Build", "seat-build")]),
      roles: disabledRoles,
      host,
      economy: policy,
      maxMembers: 24,
      mode: "sota",
    });
    expect(singleSeat.blockers).toEqual([]);
    expect(singleSeat.seats).toHaveLength(1);
    expect(singleSeat.issues).toContainEqual(
      expect.objectContaining({
        code: "MODE_ROLE_DISABLED",
        severity: "warning",
        roleId: "eng-fullstack",
      }),
    );
  });

  test("different Roles may share an instance label; duplicates within one Role are rejected", () => {
    const crossRole = planFor(
      [
        member("qa-review", "Shared", "seat-review"),
        member("research-web", "shared", "seat-research"),
      ],
      { mode: "sota" },
    );
    expect(crossRole.blockers).toEqual([]);
    expect(crossRole.seats.map((seat) => seat.instanceLabel)).toEqual(["Shared", "shared"]);

    const sameRole = planFor(
      [member("eng-fullstack", "Shared", "seat-1"), member("eng-fullstack", "shared", "seat-2")],
      { mode: "sota" },
    );
    expect(sameRole.blockers).toEqual([]);
    expect(sameRole.issues).toContainEqual(
      expect.objectContaining({
        code: "MODE_SEAT_DUPLICATE",
        severity: "warning",
        params: expect.objectContaining({ roleId: "eng-fullstack" }),
      }),
    );
  });

  test("mixed explicit and legacy ids avoid each other deterministically", () => {
    const plan = planFor(
      [member("qa-review", "Explicit", "seat-2"), member("qa-review", "Legacy", undefined)],
      { mode: "sota" },
    );
    expect(plan.blockers).toEqual([]);
    expect(plan.seats.map((seat) => seat.seatId)).toEqual(["seat-2", "seat-2-2"]);
    const again = planFor(
      [member("qa-review", "Explicit", "seat-2"), member("qa-review", "Legacy", undefined)],
      { mode: "sota" },
    );
    expect(again.seats.map((seat) => seat.seatId)).toEqual(["seat-2", "seat-2-2"]);
  });

  test("logical count includes enabled members that could not be planned", () => {
    const plan = planFor(
      [member("eng-fullstack", "Build", "seat-build"), member("ghost", "Ghost", "seat-ghost")],
      { mode: "sota" },
    );
    expect(plan.counts.logical).toBe(2);
    expect(plan.counts.physical).toBe(1);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "MODE_PROFILE_UNRESOLVED" }),
    );
  });

  test("a missing judge blocks a real cohort, and the chosen judge is never a candidate", () => {
    const missingJudge = planFor([member("eng-fullstack", "Build", "seat-build")], {
      mode: "collaborative",
    });
    expect(missingJudge.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_JUDGE_REQUIRED",
        severity: "blocker",
        params: { reason: "judge-missing" },
      }),
    );

    const withJudge = planFor(
      [member("eng-fullstack", "Build", "seat-build"), member("qa-test", "Judge", "seat-judge")],
      { mode: "collaborative" },
    );
    expect(seatByRole(withJudge, "qa-test")?.purpose).toBe("judge");
    expect(
      withJudge.seats.some(
        (seat) => seat.logicalSeatId === "seat-judge" && seat.purpose === "candidate",
      ),
    ).toBe(false);
    expect(withJudge.seats.filter((seat) => seat.purpose === "candidate")).toHaveLength(2);
  });

  test("explicit judge errors block instead of silently falling back", () => {
    const missing = planFor([member("eng-fullstack", "Build", "seat-build")], {
      mode: "collaborative",
      overrides: { collaboration: { judgeRoleId: "qa-review" } },
    });
    expect(missing.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_JUDGE_REQUIRED",
        params: { reason: "judge-missing" },
        roleId: "qa-review",
      }),
    );

    const invalidType = planFor([member("eng-fullstack", "Build", "seat-build")], {
      mode: "collaborative",
      overrides: { collaboration: { judgeRoleId: 7 } },
    });
    expect(invalidType.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_JUDGE_REQUIRED",
        params: expect.objectContaining({ reason: "judge-invalid" }),
      }),
    );

    const disabledRole = roleOf("qa-test", { enabled: false });
    const disabled = buildSeatPlan({
      team: teamOf(
        [member("eng-fullstack", "Build", "seat-build"), member("qa-test", "Judge", "seat-judge")],
        { collaboration: { judgeRoleId: "qa-test" } },
      ),
      roles: [...roles.filter((entry) => entry.id !== "qa-test"), disabledRole],
      host,
      economy: policy,
      maxMembers: 24,
      mode: "collaborative",
    });
    expect(disabled.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_JUDGE_REQUIRED",
        params: { reason: "judge-disabled" },
        roleId: "qa-test",
      }),
    );
  });

  test("invalid collaboration config blocks only when that mode is active", () => {
    const economy = planFor([member("eng-expert", "Expert", "seat-expert")], {
      mode: "economy",
      overrides: { collaboration: { escalationRoleId: 7 } },
    });
    expect(economy.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_ESCALATION_INVALID",
        params: expect.objectContaining({ reason: "escalation-invalid" }),
      }),
    );

    const sota = planFor([member("eng-fullstack", "Build", "seat-build")], {
      mode: "sota",
      overrides: { collaboration: { replicas: 4, escalationRoleId: 7 } },
    });
    expect(sota.blockers).toEqual([]);
    expect(sota.seats).toHaveLength(1);
  });

  test("two cohorts reserve two escalation seats, while a shared expert occupies one", () => {
    const twoCohorts = planFor(
      [
        member("eng-fullstack", "A", "seat-a"),
        member("eng-fullstack", "B", "seat-b"),
        member("qa-test", "Judge", "seat-judge"),
      ],
      { mode: "collaborative" },
    );
    const reserves = twoCohorts.seats.filter((seat) => seat.purpose === "escalation");
    expect(reserves).toHaveLength(2);
    expect(reserves.map((seat) => seat.activation)).toEqual(["escalation-only", "escalation-only"]);
    expect(new Set(reserves.map((seat) => seat.cohortId)).size).toBe(2);
    expect(twoCohorts.counts.physical).toBe(7);
    expect(twoCohorts.counts.escalation).toBe(2);
    expect(twoCohorts.counts.deferred).toBe(5);
    expect(twoCohorts.budget.deferredSota).toBe(2);

    const shared = planFor(
      [
        member("eng-fullstack", "A", "seat-a"),
        member("eng-fullstack", "B", "seat-b"),
        member("qa-test", "Judge", "seat-judge"),
        member("eng-expert", "Expert", "seat-expert"),
      ],
      { mode: "collaborative" },
    );
    expect(shared.seats.filter((seat) => seat.purpose === "escalation")).toHaveLength(1);
    expect(shared.counts.physical).toBe(6);
    expect(shared.counts.escalation).toBe(1);
  });

  test("a judge that is the only candidate blocks instead of judging itself", () => {
    const plan = planFor([member("qa-test", "Judge", "seat-judge")], {
      mode: "collaborative",
    });
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_JUDGE_REQUIRED",
        params: { reason: "judge-is-candidate" },
      }),
    );
    expect(plan.seats.filter((seat) => seat.purpose === "candidate")).toHaveLength(2);
  });

  test("an unavailable judge binding blocks and leaves the cohort candidates", () => {
    const plan = planFor(
      [member("eng-fullstack", "Build", "seat-build"), member("qa-test", "Judge", "seat-judge")],
      {
        mode: "collaborative",
        host: {
          status: "ready",
          profiles: allProfiles,
          availability: available.map((entry) =>
            entry.provider === "claude" ? { ...entry, available: false } : entry,
          ),
        },
      },
    );
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "MODE_PROFILE_UNRESOLVED", roleId: "qa-test" }),
    );
    expect(plan.seats.some((seat) => seat.purpose === "judge")).toBe(false);
    expect(plan.seats.filter((seat) => seat.purpose === "candidate")).toHaveLength(2);
  });

  test("a missing original binding for an implicit reserve only warns", () => {
    const judgeRole = roleOf("qa-test", {
      preferredProfiles: [{ profileId: deepseek.id, nameSnapshot: deepseek.name }],
    });
    const plan = buildSeatPlan({
      team: teamOf(
        [member("eng-fullstack", "Build", "seat-build"), member("qa-test", "Judge", "seat-judge")],
        { mode: "collaborative" },
      ),
      roles: [...roles.filter((entry) => entry.id !== "qa-test"), judgeRole],
      host: {
        status: "ready",
        profiles: allProfiles,
        availability: available.map((entry) =>
          entry.provider === "claude" ? { ...entry, available: false } : entry,
        ),
      },
      economy: policy,
      maxMembers: 24,
      mode: "collaborative",
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.seats.filter((seat) => seat.purpose === "escalation")).toHaveLength(0);
    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        code: "MODE_ESCALATION_UNAVAILABLE",
        severity: "warning",
      }),
    );
  });

  test("an explicitly required escalation Role must exist and be enabled at the escalation tier", () => {
    const disabledExpert = roleOf("eng-expert", { enabled: false });
    const disabled = buildSeatPlan({
      team: teamOf(
        [
          member("eng-fullstack", "Build", "seat-build"),
          member("eng-expert", "Expert", "seat-expert"),
        ],
        { mode: "economy", collaboration: { escalationRoleId: "eng-expert" } },
      ),
      roles: [...roles.filter((entry) => entry.id !== "eng-expert"), disabledExpert],
      host,
      economy: policy,
      maxMembers: 24,
      mode: "economy",
    });
    expect(disabled.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_ESCALATION_INVALID",
        params: { reason: "escalation-disabled" },
      }),
    );

    const wrongTier = buildSeatPlan({
      team: teamOf([member("eng-fullstack", "Build", "seat-build")], {
        mode: "economy",
        collaboration: { escalationRoleId: "eng-fullstack" },
      }),
      roles,
      host,
      economy: policy,
      maxMembers: 24,
      mode: "economy",
    });
    expect(wrongTier.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_ESCALATION_INVALID",
        params: { reason: "escalation-not-escalation-tier" },
      }),
    );

    const judgeTookChannel = buildSeatPlan({
      team: teamOf(
        [
          member("eng-fullstack", "Build", "seat-build"),
          member("eng-expert", "Expert", "seat-expert"),
        ],
        {
          mode: "collaborative",
          collaboration: { judgeRoleId: "eng-expert", escalationRoleId: "eng-expert" },
        },
      ),
      roles,
      host,
      economy: policy,
      maxMembers: 24,
      mode: "collaborative",
    });
    expect(judgeTookChannel.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_ESCALATION_INVALID",
        params: { reason: "escalation-is-judge" },
        roleId: "eng-expert",
      }),
    );
  });

  test("collaboration blocks on-demand even with an empty pool or a single family", () => {
    const capabilities: RuntimeCapabilities = {
      onDemand: false,
      expansion: false,
      collaboration: true,
    };
    const members = [
      member("eng-fullstack", "Build", "seat-build"),
      member("qa-test", "Judge", "seat-judge"),
    ];
    const emptyPool = planFor(members, {
      mode: "collaborative",
      economy: { pool: [], taskOrder: {}, profileBudget: {} },
      runtimeCapabilities: capabilities,
    });
    expect(emptyPool.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_ONDEMAND_UNAVAILABLE",
        params: { mode: "collaborative", reason: "collaboration" },
      }),
    );
    expect(emptyPool.seats.every((seat) => seat.activation === "on-demand")).toBe(true);

    const eagerEmptyPool = planFor(members, {
      mode: "collaborative",
      overrides: { memberCreation: "eager" },
      economy: { pool: [], taskOrder: {}, profileBudget: {} },
      runtimeCapabilities: capabilities,
    });
    expect(eagerEmptyPool.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_ONDEMAND_UNAVAILABLE",
        params: { mode: "collaborative", reason: "collaboration" },
      }),
    );

    const singleFamily = normalizeEconomyPolicy(
      {
        pool: [
          {
            profileId: deepseek.id,
            family: "deepseek",
            boundModel: { provider: "omp", model: deepseek.model },
          },
        ],
      },
      allProfiles,
    );
    if (!singleFamily.ok) throw new Error("unexpected economy policy failure");
    const degraded = planFor(members, {
      mode: "collaborative",
      economy: singleFamily.value,
      runtimeCapabilities: capabilities,
    });
    expect(degraded.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_ONDEMAND_UNAVAILABLE",
        params: { mode: "collaborative", reason: "collaboration" },
      }),
    );
  });

  test("legacy SOTA Teams keep disabled Roles, invalid tiers, and case-only labels as warnings", () => {
    const disabledRole = roleOf("qa-review", { enabled: false });
    const brokenRole = roleOf("qa-review", { executionPolicy: { tier: 5 } });
    const roleSets = {
      disabled: [...roles.filter((entry) => entry.id !== "qa-review"), disabledRole],
      broken: [...roles.filter((entry) => entry.id !== "qa-review"), brokenRole],
    };
    const labelMembers = [
      member("qa-review", "Case", "seat-1"),
      member("qa-review", "case", "seat-2"),
    ];

    for (const mode of ["sota", "economy", "collaborative"] as const) {
      const disabled = buildSeatPlan({
        team: teamOf([member("qa-review", "Review", "seat-review")]),
        roles: roleSets.disabled,
        host,
        economy: policy,
        maxMembers: 24,
        mode,
      });
      const broken = buildSeatPlan({
        team: teamOf([member("qa-review", "Review", "seat-review")]),
        roles: roleSets.broken,
        host,
        economy: policy,
        maxMembers: 24,
        mode,
      });
      const labels = buildSeatPlan({
        team: teamOf(labelMembers),
        roles,
        host,
        economy: policy,
        maxMembers: 24,
        mode,
      });

      if (mode === "sota") {
        expect(disabled.blockers, "disabled sota").toEqual([]);
        expect(disabled.issues).toContainEqual(
          expect.objectContaining({ code: "MODE_ROLE_DISABLED", severity: "warning" }),
        );
        expect(broken.blockers, "broken sota").toEqual([]);
        expect(broken.issues).toContainEqual(
          expect.objectContaining({ code: "MODE_ROLE_POLICY_UNKNOWN", severity: "warning" }),
        );
        expect(labels.blockers, "labels sota").toEqual([]);
        expect(labels.issues).toContainEqual(
          expect.objectContaining({ code: "MODE_SEAT_DUPLICATE", severity: "warning" }),
        );
      } else {
        expect(disabled.blockers, `disabled ${mode}`).toContainEqual(
          expect.objectContaining({ code: "MODE_ROLE_DISABLED" }),
        );
        expect(broken.blockers, `broken ${mode}`).toContainEqual(
          expect.objectContaining({ code: "MODE_ROLE_POLICY_UNKNOWN" }),
        );
        expect(labels.blockers, `labels ${mode}`).toContainEqual(
          expect.objectContaining({ code: "MODE_SEAT_DUPLICATE" }),
        );
      }
    }
  });

  test("an unknown stored mode blocks without inventing seats", () => {
    const plan = planFor(executionMembers(3), { overrides: { mode: "quantum" } });
    expect(plan.seats).toEqual([]);
    expect(plan.counts.physical).toBe(0);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "MODE_UNKNOWN", params: { value: "quantum" } }),
    );
  });
});

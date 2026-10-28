import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { describeModeRouting } from "../server/designer/context";
import { checkGapEconomyEligibility, createDesignPlanner } from "../server/designer/planning";
import { createLaunchService } from "../server/launch-service";
import type { DesignPlanningInput } from "../shared/domain/design-planning";
import { validateDesign } from "../shared/domain/design-validation";
import type * as LaunchPlanModule from "../shared/domain/launch-plan";
import { LAUNCH_RUNTIME_CAPABILITIES } from "../shared/domain/launch-runtime";
import { normalizeEconomyPolicy } from "../shared/domain/mode-resolver";
import type { ModeIssue } from "../shared/domain/role-execution";
import type { PaseoProfile, ProviderAvailability } from "../shared/paseo/adapter";
import type { DesignProposal } from "../shared/schemas/design";
import { DesignRoleGapSchema } from "../shared/schemas/design";
import { ModeLaunchPreviewSchema } from "../shared/schemas/launch-preview";
import type { Preferences } from "../shared/schemas/preferences";
import { PreferencesSchema } from "../shared/schemas/preferences";
import type { Role } from "../shared/schemas/role";
import type { Team } from "../shared/schemas/team";
import { fakePort, healthyConfig, ready } from "./fakes";
import { allAvailable, claudeOpus, codexXhigh, NOW } from "./fixtures";

// Count-only passthrough: proves the design planner has exactly one planner call site.
const launchPlanCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("../shared/domain/launch-plan", async (importOriginal) => {
  const actual = await importOriginal<typeof LaunchPlanModule>();
  return {
    ...actual,
    buildLaunchPlan: (input: Parameters<typeof actual.buildLaunchPlan>[0]) => {
      launchPlanCalls.count += 1;
      return actual.buildLaunchPlan(input);
    },
  };
});

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const MAX_MEMBERS = 8;
const ALL_CAPABILITIES = { onDemand: true, expansion: true, collaboration: true } as const;

const profiles: PaseoProfile[] = [
  { id: "claude-opus-high", name: "Claude Opus", provider: "claude", model: "opus" },
  { id: "codex-xhigh", name: "Codex", provider: "codex", model: "gpt-5.5" },
  { id: "deepseek-coding", name: "DeepSeek", provider: "deepseek", model: "deepseek-coder" },
  { id: "grok-ops", name: "Grok", provider: "xai", model: "grok" },
];

const availability: ProviderAvailability[] = [
  { provider: "claude", available: true },
  { provider: "codex", available: true },
  { provider: "deepseek", available: true },
  { provider: "xai", available: true },
];

function role(
  id: string,
  name: string,
  tier: "decision" | "execution",
  taskKind: "general" | "coding" | "ops",
  preferred: string,
  fallback?: string,
): Role {
  return {
    id,
    name,
    mission: `${name} mission`,
    responsibilities: ["Do the work"],
    restrictions: [],
    systemPrompt: "Follow the coordinator.",
    outputContract: [],
    preferredProfiles: [{ profileId: preferred }],
    fallbackProfiles: fallback ? [{ profileId: fallback }] : [],
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    executionPolicy: { tier, taskKind },
  };
}

const coordinator = role("tech-lead", "Tech Lead", "decision", "general", "claude-opus-high");
const architect = role(
  "architect",
  "Architect",
  "execution",
  "coding",
  "claude-opus-high",
  "codex-xhigh",
);
const developer = role("developer", "Developer", "execution", "ops", "codex-xhigh");
const judge = role("qa-review", "QA Review", "decision", "general", "claude-opus-high");
const roles = [coordinator, architect, developer, judge];

function team(
  mode: "sota" | "economy" | "collaborative",
  members: Team["members"],
  collaboration?: Team["collaboration"],
): Team {
  return {
    id: `team-${mode}`,
    name: `Team ${mode}`,
    mode,
    coordinatorRoleId: coordinator.id,
    members,
    ...(collaboration ? { collaboration } : {}),
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function preferences(): Preferences {
  return PreferencesSchema.parse({
    maxMembers: MAX_MEMBERS,
    economy: {
      pool: [
        {
          profileId: "deepseek-coding",
          family: "deepseek",
          enabled: true,
          boundModel: { provider: "deepseek", model: "deepseek-coder" },
        },
        {
          profileId: "grok-ops",
          family: "grok",
          enabled: true,
          boundModel: { provider: "xai", model: "grok" },
        },
      ],
      taskOrder: { coding: ["deepseek-coding", "grok-ops"], ops: ["grok-ops"] },
      profileBudget: {
        "claude-opus-high": "sota",
        "codex-xhigh": "sota",
      },
    },
  });
}

function input(mode: "sota" | "economy" | "collaborative"): DesignPlanningInput {
  const members =
    mode === "collaborative"
      ? [
          { roleId: architect.id, seatId: "seat-m1", enabled: true },
          { roleId: judge.id, seatId: "seat-m2", enabled: true },
        ]
      : [
          { roleId: architect.id, seatId: "seat-m1", enabled: true },
          { roleId: developer.id, seatId: "seat-m2", enabled: true },
        ];
  return {
    jobId: JOB_ID,
    team: team(
      mode,
      members,
      mode === "collaborative" ? { replicas: 2, judgeRoleId: judge.id } : undefined,
    ),
    roles,
    host: { status: "ready", profiles, availability },
    preferences: preferences(),
    daemonConfig: {},
    mode,
    workspaceId: "workspace-1",
    request: "把现有后台改造成可观测的分层服务",
  };
}

function okPreview(mode: "sota" | "economy" | "collaborative") {
  const result = createDesignPlanner(ALL_CAPABILITIES).plan(input(mode));
  if (!result.ok) {
    throw new Error(
      `plan failed: ${result.launchBlockers.join(",")} ${JSON.stringify(result.issues)}`,
    );
  }
  return ModeLaunchPreviewSchema.parse(result.preview);
}

function codes(issues: readonly ModeIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

describe("design planning", () => {
  test("SOTA reuses the original bindings and keeps a stable plan hash", () => {
    const preview = okPreview("sota");
    expect(preview.requestedMode).toBe("sota");
    expect(preview.coordinator.roleId).toBe(coordinator.id);
    expect(preview.coordinator.profile?.id).toBe("claude-opus-high");
    expect(preview.seats.map((seat) => seat.roleId)).toEqual([architect.id, developer.id]);
    expect(preview.seats.map((seat) => seat.profile?.id)).toEqual([
      "claude-opus-high",
      "codex-xhigh",
    ]);
    expect(preview.counts.logical).toBe(2);
    expect(preview.counts.physical).toBe(preview.seats.length);
    expect(preview.counts.physical).toBe(2);
    expect(preview.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(okPreview("sota").planHash).toBe(preview.planHash);
  });

  test("economy sends coding to DeepSeek and ops to Grok", () => {
    const preview = okPreview("economy");
    expect(preview.requestedMode).toBe("economy");
    expect(preview.coordinator.profile?.id).toBe("claude-opus-high");
    const byRole = new Map(preview.seats.map((seat) => [seat.roleId, seat]));
    expect(byRole.get(architect.id)).toMatchObject({
      profile: { id: "deepseek-coding" },
      source: "economy-pool",
      budget: "economy",
    });
    expect(byRole.get(developer.id)).toMatchObject({
      profile: { id: "grok-ops" },
      source: "economy-pool",
      budget: "economy",
    });
    expect(preview.counts.physical).toBe(2);
    expect(preview.planHash).toBe(okPreview("economy").planHash);
  });

  test("collaboration expands one execution role into independent families and counts every seat", () => {
    const preview = okPreview("collaborative");
    expect(preview.requestedMode).toBe("collaborative");
    const candidates = preview.seats.filter(
      (seat) => seat.roleId === architect.id && seat.purpose === "candidate",
    );
    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((seat) => seat.family)).size).toBe(2);
    expect(candidates.map((seat) => seat.profile?.id).sort()).toEqual([
      "deepseek-coding",
      "grok-ops",
    ]);
    const judgeSeat = preview.seats.find((seat) => seat.purpose === "judge");
    expect(judgeSeat?.roleId).toBe(judge.id);
    const escalation = preview.seats.filter((seat) => seat.activation === "escalation-only");
    expect(escalation).toHaveLength(1);
    expect(preview.counts.logical).toBe(2);
    expect(preview.counts.physical).toBe(preview.seats.length);
    expect(preview.counts.physical).toBe(4);
    expect(preview.counts.escalation).toBe(1);
    expect(preview.planHash).toBe(okPreview("collaborative").planHash);
  });

  test("economy falls back to original bindings when the pool is empty", () => {
    const noPool = input("economy");
    noPool.preferences = PreferencesSchema.parse({
      maxMembers: MAX_MEMBERS,
      economy: { pool: [], taskOrder: {}, profileBudget: {} },
    });
    const result = createDesignPlanner(ALL_CAPABILITIES).plan(noPool);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const preview = ModeLaunchPreviewSchema.parse(result.preview);
    const byRole = new Map(preview.seats.map((seat) => [seat.roleId, seat]));
    expect(byRole.get(architect.id)?.profile?.id).toBe("claude-opus-high");
    expect(byRole.get(developer.id)?.profile?.id).toBe("codex-xhigh");
    expect(codes(result.issues)).toContain("MODE_POOL_EMPTY");
  });

  test("collaboration reduces three requested paths to two families with a warning", () => {
    const reduced = input("collaborative");
    reduced.team.collaboration = { replicas: 3, judgeRoleId: judge.id };
    const result = createDesignPlanner(ALL_CAPABILITIES).plan(reduced);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const preview = ModeLaunchPreviewSchema.parse(result.preview);
    expect(
      preview.seats.filter((seat) => seat.roleId === architect.id && seat.purpose === "candidate"),
    ).toHaveLength(2);
    expect(codes(result.issues)).toContain("MODE_FAMILIES_REDUCED");
    expect(preview.planHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("designer and launch-service share the planHash and warnings", async () => {
    const hashPreferences = PreferencesSchema.parse({
      maxMembers: MAX_MEMBERS,
      economy: {
        pool: [
          {
            profileId: "claude-opus-high",
            family: "claude",
            enabled: true,
            boundModel: { provider: "claude", model: "opus" },
          },
        ],
        taskOrder: { coding: ["claude-opus-high"], ops: ["claude-opus-high"] },
        profileBudget: { "claude-opus-high": "sota" },
      },
    });
    const hashInput: DesignPlanningInput = {
      jobId: JOB_ID,
      team: team("economy", [
        { roleId: architect.id, seatId: "seat-m1", enabled: true },
        { roleId: developer.id, seatId: "seat-m2", enabled: true },
      ]),
      roles,
      host: {
        status: "ready",
        profiles: [claudeOpus, codexXhigh],
        availability: allAvailable,
      },
      preferences: hashPreferences,
      daemonConfig: healthyConfig,
      mode: "economy",
      workspaceId: "ws-1",
      request: "Add Stripe",
    };
    const design = createDesignPlanner().plan(hashInput);
    if (!design.ok) throw new Error(design.launchBlockers.join(","));
    const fake = fakePort(healthyConfig);
    const service = createLaunchService({
      roles: ready({ roles }),
      teams: ready({ teams: [hashInput.team] }),
      preferences: ready(hashInput.preferences),
      now: () => new Date(NOW),
      runId: () => "run-design-hash",
    });
    const launch = await service.preview(
      {
        teamId: hashInput.team.id,
        task: hashInput.request,
        target: { kind: "workspace", workspaceId: "ws-1" },
        mode: "economy",
      },
      fake.port,
    );
    if (!launch.ok) throw new Error(launch.blockers.join(","));
    const designPreview = ModeLaunchPreviewSchema.parse(design.preview);
    expect(designPreview.planHash).toBe(launch.preview.planHash);
    expect(design.launchWarnings).toEqual(launch.preview.warnings);
    expect(design.launchWarnings.length).toBeGreaterThan(0);
    expect(designPreview.warnings).toEqual(launch.preview.warnings);
    expect(LAUNCH_RUNTIME_CAPABILITIES).toEqual({
      onDemand: false,
      expansion: false,
      collaboration: false,
    });
  });

  test("enforces physical seat limits and keeps legacy maxMembers values", () => {
    const cases = [
      { members: 8, max: 8, ok: true },
      { members: 9, max: 8, ok: false },
      { members: 24, max: 24, ok: true },
      { members: 25, max: 24, ok: false },
      { members: 64, max: 64, ok: true },
      { members: 65, max: 100, ok: false },
    ] as const;
    for (const item of cases) {
      const bounded = input("sota");
      bounded.team = team(
        "sota",
        Array.from({ length: item.members }, (_, index) => ({
          roleId: architect.id,
          instanceLabel: `seat-${index + 1}`,
          seatId: `seat-${index + 1}`,
          enabled: true,
        })),
      );
      bounded.preferences = PreferencesSchema.parse({ maxMembers: item.max });
      const result = createDesignPlanner(ALL_CAPABILITIES).plan(bounded);
      expect(result.ok, `${item.members}/${item.max}`).toBe(item.ok);
      if (!result.ok) {
        expect(codes(result.issues)).toContain("MODE_MEMBER_LIMIT");
        continue;
      }
      const preview = ModeLaunchPreviewSchema.parse(result.preview);
      expect(preview.counts.physical).toBe(item.members);
      expect(preview.seats).toHaveLength(item.members);
    }
  });

  test("capability-off blocks collaboration but makes economy eager", () => {
    const off = { onDemand: false, expansion: false, collaboration: false };
    const collaboration = createDesignPlanner(off).plan(input("collaborative"));
    expect(collaboration.ok).toBe(false);
    if (collaboration.ok) return;
    expect(codes(collaboration.issues)).toContain("MODE_ONDEMAND_UNAVAILABLE");
    expect(collaboration.launchBlockers.length).toBeGreaterThan(0);

    const economy = createDesignPlanner(off).plan(input("economy"));
    expect(economy.ok).toBe(true);
    if (!economy.ok) return;
    const preview = ModeLaunchPreviewSchema.parse(economy.preview);
    expect(preview.seats.every((seat) => seat.activation === "eager")).toBe(true);
    expect(codes(economy.issues)).toContain("MODE_ONDEMAND_FALLBACK_EAGER");
  });

  test("an unavailable host returns a blocked plan with a context issue", () => {
    const down = input("sota");
    down.host = { status: "unavailable", reason: "provider snapshot failed" };
    const result = createDesignPlanner(ALL_CAPABILITIES).plan(down);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.issues)).toContain("MODE_CONTEXT_UNAVAILABLE");
    expect(result.launchBlockers.length).toBeGreaterThan(0);
  });

  test("the same Role in two logical seats expands separately", () => {
    const sameRole = input("collaborative");
    sameRole.team = team(
      "collaborative",
      [
        { roleId: architect.id, instanceLabel: "A", seatId: "seat-a", enabled: true },
        { roleId: architect.id, instanceLabel: "B", seatId: "seat-b", enabled: true },
        { roleId: judge.id, seatId: "seat-j", enabled: true },
      ],
      { replicas: 2, judgeRoleId: judge.id },
    );
    const result = createDesignPlanner(ALL_CAPABILITIES).plan(sameRole);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const preview = ModeLaunchPreviewSchema.parse(result.preview);
    for (const logicalSeatId of ["seat-a", "seat-b"]) {
      const candidates = preview.seats.filter(
        (seat) =>
          seat.logicalSeatId === logicalSeatId &&
          seat.roleId === architect.id &&
          seat.purpose === "candidate",
      );
      expect(candidates).toHaveLength(2);
    }
    expect(
      preview.seats.filter((seat) => seat.roleId === architect.id && seat.purpose === "candidate"),
    ).toHaveLength(4);
    expect(preview.seats.filter((seat) => seat.purpose === "judge")).toHaveLength(1);
    expect(preview.seats.filter((seat) => seat.activation === "escalation-only")).toHaveLength(2);
    expect(preview.counts.physical).toBe(preview.seats.length);
    expect(preview.counts.logical).toBe(3);
  });

  test("three Grok profiles stay one family and cannot form a cohort", () => {
    const groks = ["grok-a", "grok-b", "grok-c"].map((id) => ({
      id,
      name: id,
      provider: "xai",
      model: "grok",
    }));
    const grok = input("collaborative");
    grok.host = {
      status: "ready",
      profiles: [...profiles, ...groks],
      availability: [...availability],
    };
    grok.preferences = PreferencesSchema.parse({
      maxMembers: MAX_MEMBERS,
      economy: {
        pool: groks.map((profile) => ({
          profileId: profile.id,
          family: "grok",
          enabled: true,
          boundModel: { provider: "xai", model: "grok" },
        })),
        taskOrder: { coding: groks.map((profile) => profile.id) },
        profileBudget: Object.fromEntries(groks.map((profile) => [profile.id, "economy"])),
      },
    });
    const result = createDesignPlanner(ALL_CAPABILITIES).plan(grok);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const preview = ModeLaunchPreviewSchema.parse(result.preview);
    expect(preview.seats.filter((seat) => seat.purpose === "candidate")).toHaveLength(0);
    expect(codes(result.issues)).toContain("MODE_COLLAB_UNAVAILABLE");
    expect(preview.seats.some((seat) => seat.profile?.id.startsWith("grok-"))).toBe(false);
  });

  test("a judge member matches its own judge seat in collaborative validation", () => {
    const base = input("collaborative");
    const proposal: DesignProposal = {
      version: 1,
      jobId: JOB_ID,
      attempt: 1,
      nonce: "b".repeat(32),
      summary: "协作团队由 judge 成员独立审查",
      team: {
        id: "collab-team",
        name: "Collab Team",
        mode: "collaborative",
        coordinatorRoleId: coordinator.id,
        members: [
          { key: "m1", roleId: architect.id },
          { key: "m2", roleId: judge.id },
        ],
        collaboration: { replicas: 2, judgeRoleId: judge.id },
      },
      reuse: [
        { roleId: coordinator.id, reason: "负责统筹" },
        { roleId: architect.id, reason: "负责结构" },
        { roleId: judge.id, reason: "负责独立审查" },
      ],
      newRoles: [],
      profileChoices: [
        { target: "coordinator", profileIds: ["claude-opus-high"], reason: "决策" },
        {
          target: "m1",
          profileIds: ["deepseek-coding", "grok-ops"],
          reason: "两种独立实现路径",
        },
        { target: "m2", profileIds: ["claude-opus-high"], reason: "独立审查" },
      ],
    };
    const result = validateDesign(
      proposal,
      {
        request: base.request,
        mode: "collaborative",
        jobId: JOB_ID,
        attempt: 1,
        nonce: "b".repeat(32),
        roles,
        teams: [],
        preferences: base.preferences,
        host: base.host,
        daemonConfig: {},
        carrierWorkspaceId: "ws-carrier",
        targetWorkspaceId: "workspace-1",
        capabilities: ALL_CAPABILITIES,
        hasher: (content) => createHash("sha256").update(content).digest("hex"),
      },
      createDesignPlanner(ALL_CAPABILITIES),
      {
        teamId: "collab-team",
        createdAt: NOW,
        logicalSeatIds: { m1: "seat-m1", m2: "seat-m2" },
      },
    );
    expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    if (!result.ok) return;
    expect(result.value.memberReasons.find((reason) => reason.target === "m2")).toMatchObject({
      logicalSeatId: "seat-m2",
      expectedProfileIds: ["claude-opus-high"],
    });
    expect(result.value.plan.preview.seats.find((seat) => seat.roleId === judge.id)).toMatchObject({
      purpose: "judge",
      profile: { id: "claude-opus-high" },
    });
  });

  test("surfaces T2/T3 blockers instead of fabricating a preview", () => {
    const bad = input("collaborative");
    bad.team.collaboration = { replicas: 2, judgeRoleId: "missing-judge" };
    const result = createDesignPlanner(ALL_CAPABILITIES).plan(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.launchBlockers.length).toBeGreaterThan(0);
    expect(codes(result.issues)).toContain("MODE_JUDGE_REQUIRED");
  });

  test("planDesign consumes the shared planner exactly once", () => {
    launchPlanCalls.count = 0;
    const result = createDesignPlanner(ALL_CAPABILITIES).plan(input("sota"));
    expect(result.ok).toBe(true);
    expect(launchPlanCalls.count).toBe(1);
  });
});

const GAP_PROFILES: PaseoProfile[] = [
  { id: "haiku", name: "Haiku", provider: "claude", model: "claude-haiku-4-5" },
  { id: "deepseek", name: "DeepSeek", provider: "omp", model: "opencode-go/deepseek-v4.1-flash" },
  { id: "sonnet", name: "Sonnet", provider: "claude", model: "claude-sonnet-5" },
];
const GAP_AVAILABILITY: ProviderAvailability[] = [
  { provider: "claude", available: true },
  { provider: "omp", available: true },
];
const GAP_ENTRIES = [
  {
    profileId: "haiku",
    enabled: true,
    costClass: "low",
    family: "haiku",
    boundModel: { provider: "claude", model: "claude-haiku-4-5" },
  },
  {
    profileId: "deepseek",
    enabled: true,
    costClass: "low",
    family: "deepseek",
    boundModel: { provider: "omp", model: "opencode-go/deepseek-v4.1-flash" },
  },
];
const GAP_ROUTES = {
  coordinator: ["haiku"],
  decision: ["haiku"],
  execution: ["deepseek"],
  escalation: ["haiku"],
  retain: ["haiku"],
};

function gapRouting(
  availability: ProviderAvailability[] = GAP_AVAILABILITY,
  routes: Record<string, string[]> = GAP_ROUTES,
) {
  const policy = normalizeEconomyPolicy(
    {
      pool: [],
      taskOrder: {},
      profileBudget: {},
      allSeats: { version: 1, profiles: GAP_ENTRIES, routes },
    },
    GAP_PROFILES,
  );
  if (!policy.ok) throw new Error("unexpected policy failure");
  return describeModeRouting({
    profiles: GAP_PROFILES,
    availability,
    economy: policy.value,
  });
}

function gapFixture(overrides: Record<string, unknown> = {}) {
  return DesignRoleGapSchema.parse({
    kind: "missing-role",
    responsibility: "负责数据库迁移与回滚",
    reason: "目录没有承担迁移的 Role",
    use: "member",
    profiles: { kind: "existing", profileIds: ["deepseek"] },
    suggestedRole: {
      id: "eng-data",
      name: "【工程】数据迁移",
      responsibilities: ["编写可回滚的迁移脚本"],
      executionPolicy: { tier: "execution", taskKind: "coding" },
    },
    ...overrides,
  });
}

describe("gap economy eligibility", () => {
  test("accepts a suggested Profile that sits in the gap's own route", () => {
    expect(
      checkGapEconomyEligibility({
        mode: "economy-all",
        gap: gapFixture(),
        routing: gapRouting(),
      }),
    ).toEqual([]);
  });

  test("rejects a Profile outside the route with a repair issue", () => {
    const issues = checkGapEconomyEligibility({
      mode: "economy-all",
      gap: gapFixture({ profiles: { kind: "existing", profileIds: ["sonnet"] } }),
      routing: gapRouting(),
      path: ["gaps", 0],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "DESIGN_MODE_PLAN_INVALID",
      severity: "error",
      path: ["gaps", 0, "profiles", "profileIds", 0],
      action: "repair",
      params: {
        modeCode: "MODE_CHEAP_PROFILE_INVALID",
        route: "execution",
        profileId: "sonnet",
        reason: "outside-list",
      },
    });
  });

  test("rejects a candidate the planner finds unavailable", () => {
    const issues = checkGapEconomyEligibility({
      mode: "economy-all",
      gap: gapFixture(),
      routing: gapRouting([
        { provider: "claude", available: true },
        { provider: "omp", available: false },
      ]),
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.params).toMatchObject({
      modeCode: "MODE_CHEAP_PROFILE_INVALID",
      reason: "unavailable",
    });
  });

  test("uses the coordinator route for a coordinator gap", () => {
    const coordinator = gapFixture({ use: "coordinator" });
    expect(
      checkGapEconomyEligibility({
        mode: "economy-all",
        gap: gapFixture({
          use: "coordinator",
          profiles: { kind: "existing", profileIds: ["haiku"] },
        }),
        routing: gapRouting(),
      }),
    ).toEqual([]);
    const issues = checkGapEconomyEligibility({
      mode: "economy-all",
      gap: coordinator,
      routing: gapRouting(),
    });
    expect(issues[0]?.params).toMatchObject({ route: "coordinator", profileId: "deepseek" });
  });

  test("a structured none gap is the legal exit for every broken route state", () => {
    const none = gapFixture({ profiles: { kind: "none", reason: "host 无合格 Profile" } });
    expect(
      checkGapEconomyEligibility({ mode: "economy-all", gap: none, routing: gapRouting() }),
    ).toEqual([]);
    expect(
      checkGapEconomyEligibility({ mode: "economy-all", gap: none, routing: { status: "absent" } }),
    ).toEqual([]);
    expect(
      checkGapEconomyEligibility({
        mode: "economy-all",
        gap: none,
        routing: { status: "invalid", reason: "unknown-version" },
      }),
    ).toEqual([]);
    expect(
      checkGapEconomyEligibility({
        mode: "economy-all",
        gap: none,
        routing: gapRouting(GAP_AVAILABILITY, { retain: ["deepseek"] }),
      }),
    ).toEqual([]);
    // Undefined routing means the caller forgot to pass the snapshot: an internal error, not a
    // model-fixable one, so it stays a distinct reason.
    const unwired = checkGapEconomyEligibility({
      mode: "economy-all",
      gap: none,
      routing: undefined,
    });
    expect(unwired[0]?.params).toMatchObject({
      modeCode: "MODE_CHEAP_POLICY_REQUIRED",
      reason: "routing-missing",
    });
  });

  test("a missing policy blocks an existing Profile suggestion as a policy problem", () => {
    const issues = checkGapEconomyEligibility({
      mode: "economy-all",
      gap: gapFixture(),
      routing: { status: "absent" },
    });
    expect(issues[0]?.params).toMatchObject({
      modeCode: "MODE_CHEAP_POLICY_REQUIRED",
      reason: "absent",
    });
  });

  test("legacy modes and unlaunchable gaps skip the check", () => {
    expect(
      checkGapEconomyEligibility({ mode: "economy", gap: gapFixture(), routing: gapRouting() }),
    ).toEqual([]);
    expect(
      checkGapEconomyEligibility({
        mode: "economy-all",
        gap: DesignRoleGapSchema.parse({
          kind: "unlaunchable-role",
          roleId: "eng-data",
          responsibility: "负责数据库迁移与回滚",
          reason: "该 Role 的绑定不可用",
          use: "member",
          profiles: { kind: "existing", profileIds: ["deepseek"] },
        }),
        routing: gapRouting(),
      }),
    ).toEqual([]);
  });
});

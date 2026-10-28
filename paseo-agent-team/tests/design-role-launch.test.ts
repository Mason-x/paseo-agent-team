import { describe, expect, test } from "vitest";
import { computeRoleLaunchability } from "../server/designer/context";
import { type DesignRoleLaunchTables, validateRoleGap } from "../shared/domain/design-validation";
import { type EconomyPolicy, normalizeEconomyPolicy } from "../shared/domain/mode-resolver";
import type { PaseoProfile, ProviderAvailability } from "../shared/paseo/adapter";
import { DesignRoleGapProposalSchema } from "../shared/schemas/design";
import { PreferencesSchema } from "../shared/schemas/preferences";
import { type Role, RoleSchema } from "../shared/schemas/role";

function role(id: string, overrides: Partial<Role> = {}): Role {
  return RoleSchema.parse({
    id,
    name: id,
    mission: "使命",
    responsibilities: ["职责"],
    systemPrompt: "系统提示",
    preferredProfiles: [{ profileId: "missing-profile" }],
    fallbackProfiles: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

const POOL_PROFILE: PaseoProfile = {
  id: "pool-profile",
  name: "经济 Profile",
  provider: "claude",
};

const AVAILABILITY = [{ provider: "claude", available: true }];
const ECONOMY = {
  pool: [{ profileId: POOL_PROFILE.id, family: "claude", enabled: true }],
  taskOrder: {},
  profileBudget: { "pool-profile": "economy" as const },
};

const DEEPSEEK: PaseoProfile = {
  id: "deepseek-coding",
  name: "DeepSeek",
  provider: "omp",
  model: "opencode-go/deepseek-v4.1-flash",
};
const CHEAP_ENTRY = {
  profileId: DEEPSEEK.id,
  enabled: true,
  costClass: "low" as const,
  family: "deepseek",
  boundModel: { provider: "omp", model: "opencode-go/deepseek-v4.1-flash" },
};

function cheapPolicy(
  routes: Record<string, string[]>,
  entries: unknown[] = [CHEAP_ENTRY],
): EconomyPolicy {
  const normalized = normalizeEconomyPolicy(
    {
      pool: [],
      taskOrder: {},
      profileBudget: {},
      allSeats: { version: 1, profiles: entries, routes },
    },
    [DEEPSEEK],
  );
  if (!normalized.ok) throw new Error("unexpected economy policy failure");
  return normalized.value;
}

function table(result: ReturnType<typeof computeRoleLaunchability>, id: string) {
  const member = result.member[id];
  const coordinator = result.coordinator[id];
  if (!member || !coordinator) throw new Error(`missing verdict for ${id}`);
  return { member, coordinator };
}

describe("role launchability", () => {
  test("an economy execution role launches from the pool while its coordinator use does not", () => {
    const blocked = role("eng", {
      executionPolicy: { tier: "execution", taskKind: "coding" },
    });
    const verdict = table(
      computeRoleLaunchability({
        mode: "economy",
        roles: [blocked],
        profiles: [POOL_PROFILE],
        availability: AVAILABILITY,
        economy: ECONOMY,
      }),
      "eng",
    );
    expect(verdict.member).toEqual({
      launchable: true,
      unavailableProfileIds: ["missing-profile"],
      verified: true,
    });
    // The coordinator keeps the original binding, so this direction must not be inferred.
    expect(verdict.coordinator).toEqual({
      launchable: false,
      unavailableProfileIds: ["missing-profile"],
      verified: true,
    });
  });

  test("a decision role keeps its original binding instead of using the pool", () => {
    const decision = role("lead", {
      executionPolicy: { tier: "decision", taskKind: "general" },
    });
    const verdict = table(
      computeRoleLaunchability({
        mode: "economy",
        roles: [decision],
        profiles: [POOL_PROFILE],
        availability: AVAILABILITY,
        economy: ECONOMY,
      }),
      "lead",
    );
    expect(verdict.member).toEqual({
      launchable: false,
      unavailableProfileIds: ["missing-profile"],
      verified: true,
    });
    expect(verdict.coordinator.launchable).toBe(false);
  });

  test("bounds the unavailable binding ids kept in the required index", () => {
    const ids = Array.from({ length: 7 }, (_, index) => ({ profileId: `missing-${index}` }));
    const many = role("many", {
      preferredProfiles: ids.slice(0, 5),
      fallbackProfiles: ids.slice(5),
    });
    const verdict = table(
      computeRoleLaunchability({
        mode: "sota",
        roles: [many],
        profiles: [],
        availability: [],
        economy: { pool: [], taskOrder: {}, profileBudget: {} },
      }),
      "many",
    );
    expect(verdict.member.launchable).toBe(false);
    expect(verdict.member.unavailableProfileIds).toEqual([
      "missing-0",
      "missing-1",
      "missing-2",
      "missing-3",
      "missing-4",
    ]);
    // Every bound Profile is gone: that is a definite fact, not an unverified one.
    expect(verdict.member.verified).toBe(true);
  });

  test("a missing availability row makes the verdict unverified", () => {
    const bound = role("bound", {
      preferredProfiles: [{ profileId: POOL_PROFILE.id }],
      executionPolicy: { tier: "decision", taskKind: "general" },
    });
    const verdict = table(
      computeRoleLaunchability({
        mode: "economy",
        roles: [bound],
        profiles: [POOL_PROFILE],
        availability: [],
        economy: { pool: [], taskOrder: {}, profileBudget: {} },
      }),
      "bound",
    );
    // The legacy resolver treats a missing row as usable; the verdict still says it is unproven.
    expect(verdict.member.launchable).toBe(true);
    expect(verdict.member.verified).toBe(false);
    expect(verdict.coordinator.verified).toBe(false);
  });

  test("an availability row that says unavailable keeps the verdict verified", () => {
    const bound = role("bound", {
      preferredProfiles: [{ profileId: POOL_PROFILE.id }],
      executionPolicy: { tier: "decision", taskKind: "general" },
    });
    const verdict = table(
      computeRoleLaunchability({
        mode: "economy",
        roles: [bound],
        profiles: [POOL_PROFILE],
        availability: [{ provider: "claude", available: false }],
        economy: { pool: [], taskOrder: {}, profileBudget: {} },
      }),
      "bound",
    );
    expect(verdict.member).toMatchObject({ launchable: false, verified: true });
    expect(verdict.member.unavailableProfileIds).toEqual([POOL_PROFILE.id]);
  });

  test("economy-all reads each use from its own route", () => {
    const eng = role("eng", {
      executionPolicy: { tier: "execution", taskKind: "coding" },
    });
    const verdict = table(
      computeRoleLaunchability({
        mode: "economy-all",
        roles: [eng],
        profiles: [DEEPSEEK],
        availability: [{ provider: "omp", available: true }],
        economy: cheapPolicy({ execution: [DEEPSEEK.id] }),
      }),
      "eng",
    );
    expect(verdict.member).toEqual({
      launchable: true,
      unavailableProfileIds: [],
      verified: true,
    });
    // The coordinator route has no candidates at all, so that use is unproven, not inferred.
    expect(verdict.coordinator).toEqual({
      launchable: false,
      unavailableProfileIds: [],
      verified: false,
    });
  });

  test("economy-all reports the route candidates the planner rejected", () => {
    const eng = role("eng", {
      executionPolicy: { tier: "execution", taskKind: "coding" },
    });
    const verdict = table(
      computeRoleLaunchability({
        mode: "economy-all",
        roles: [eng],
        profiles: [DEEPSEEK],
        availability: [],
        economy: cheapPolicy({ execution: [DEEPSEEK.id] }),
      }),
      "eng",
    );
    expect(verdict.member.launchable).toBe(false);
    expect(verdict.member.unavailableProfileIds).toEqual([DEEPSEEK.id]);
    expect(verdict.member.verified).toBe(false);
  });

  test("economy-all without a policy proves nothing about either use", () => {
    const eng = role("eng", {
      executionPolicy: { tier: "execution", taskKind: "coding" },
    });
    const verdict = table(
      computeRoleLaunchability({
        mode: "economy-all",
        roles: [eng],
        profiles: [DEEPSEEK],
        availability: [{ provider: "omp", available: true }],
        economy: { pool: [], taskOrder: {}, profileBudget: {} },
      }),
      "eng",
    );
    expect(verdict.member).toEqual({
      launchable: false,
      unavailableProfileIds: [],
      verified: false,
    });
    expect(verdict.coordinator).toEqual({
      launchable: false,
      unavailableProfileIds: [],
      verified: false,
    });
  });

  test("economy-all names reported rejections and keeps empty routes unproven", () => {
    const eng = role("eng", {
      executionPolicy: { tier: "execution", taskKind: "coding" },
    });
    const deleted = table(
      computeRoleLaunchability({
        mode: "economy-all",
        roles: [eng],
        profiles: [],
        availability: [],
        economy: cheapPolicy({ execution: [DEEPSEEK.id] }),
      }),
      "eng",
    );
    // A stored id whose Profile is gone is reported, so the verdict may name it; it is definite.
    expect(deleted.member.unavailableProfileIds).toEqual([DEEPSEEK.id]);
    expect(deleted.member.verified).toBe(true);

    const emptyRoute = table(
      computeRoleLaunchability({
        mode: "economy-all",
        roles: [eng],
        profiles: [DEEPSEEK],
        availability: [{ provider: "omp", available: true }],
        economy: cheapPolicy({ retain: [DEEPSEEK.id] }),
      }),
      "eng",
    );
    // No execution candidates at all: the failure belongs to the policy, not to this Role.
    expect(emptyRoute.member.unavailableProfileIds).toEqual([]);
    expect(emptyRoute.member.verified).toBe(false);
  });

  test("a standby escalation seat keeps the planner's failure evidence", () => {
    const esc = role("esc", {
      executionPolicy: { tier: "escalation", taskKind: "coding" },
    });
    const policy = cheapPolicy({
      coordinator: [DEEPSEEK.id],
      execution: [DEEPSEEK.id],
      escalation: [DEEPSEEK.id],
    });
    const unverified = table(
      computeRoleLaunchability({
        mode: "economy-all",
        roles: [esc],
        profiles: [DEEPSEEK],
        availability: [],
        economy: policy,
      }),
      "esc",
    );
    // D02 returns ok=true + unavailable=true for standby; its issues still prove nothing.
    expect(unverified.member).toEqual({
      launchable: false,
      unavailableProfileIds: [DEEPSEEK.id],
      verified: false,
    });

    const unavailable = table(
      computeRoleLaunchability({
        mode: "economy-all",
        roles: [esc],
        profiles: [DEEPSEEK],
        availability: [{ provider: "omp", available: false }],
        economy: policy,
      }),
      "esc",
    );
    expect(unavailable.member).toEqual({
      launchable: false,
      unavailableProfileIds: [DEEPSEEK.id],
      verified: true,
    });

    const emptyRoute = table(
      computeRoleLaunchability({
        mode: "economy-all",
        roles: [esc],
        profiles: [DEEPSEEK],
        availability: [{ provider: "omp", available: true }],
        economy: cheapPolicy({ execution: [DEEPSEEK.id] }),
      }),
      "esc",
    );
    expect(emptyRoute.member).toEqual({
      launchable: false,
      unavailableProfileIds: [],
      verified: false,
    });
  });

  test("the verifier gate rejects an unverified standby claim and accepts a proven one", () => {
    const esc = role("esc", {
      executionPolicy: { tier: "escalation", taskKind: "coding" },
    });
    const policy = cheapPolicy({
      coordinator: [DEEPSEEK.id],
      execution: [DEEPSEEK.id],
      escalation: [DEEPSEEK.id],
    });
    const proposal = DesignRoleGapProposalSchema.parse({
      version: 2,
      kind: "role-gap",
      jobId: "11111111-1111-4111-8111-111111111111",
      attempt: 1,
      nonce: "0123456789abcdef0123456789abcdef",
      summary: "现有 Role 不可启动",
      gaps: [
        {
          kind: "unlaunchable-role",
          roleId: esc.id,
          responsibility: "负责上线判断",
          reason: "该 Role 在待命位不可启动",
          use: "member",
          profiles: { kind: "none", reason: "无合适 Profile" },
        },
      ],
    });
    const gate = (availability: ProviderAvailability[]) => {
      const tables: DesignRoleLaunchTables = computeRoleLaunchability({
        mode: "economy-all",
        roles: [esc],
        profiles: [DEEPSEEK],
        availability,
        economy: policy,
      });
      return validateRoleGap(
        proposal,
        {
          request: "上线",
          mode: "economy-all",
          jobId: "11111111-1111-4111-8111-111111111111",
          attempt: 1,
          nonce: "0123456789abcdef0123456789abcdef",
          roles: [esc],
          teams: [],
          preferences: PreferencesSchema.parse({}),
          host: { status: "ready", profiles: [DEEPSEEK], availability },
          daemonConfig: {},
          carrierWorkspaceId: "carrier",
          targetWorkspaceId: null,
          capabilities: { onDemand: true, expansion: false, collaboration: false },
          roleLaunch: tables,
        },
        { existingRolesOnly: true },
      );
    };
    const unverified = gate([]);
    expect(unverified.ok).toBe(false);
    if (unverified.ok) return;
    expect(unverified.issues).toEqual([
      expect.objectContaining({
        code: "DESIGN_OUTPUT_SCHEMA",
        params: expect.objectContaining({ reason: "role-launch-unverified" }),
      }),
    ]);
    expect(gate([{ provider: "omp", available: false }]).ok).toBe(true);
  });
});

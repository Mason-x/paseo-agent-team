import { describe, expect, test } from "vitest";
import { computeRoleLaunchability } from "../server/designer/context";
import type { PaseoProfile } from "../shared/paseo/adapter";
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

describe("role launchability", () => {
  test("an economy execution role launches from the pool even when its binding is unusable", () => {
    const blocked = role("eng", {
      executionPolicy: { tier: "execution", taskKind: "coding" },
    });
    const result = computeRoleLaunchability({
      mode: "economy",
      roles: [blocked],
      profiles: [POOL_PROFILE],
      availability: AVAILABILITY,
      economy: ECONOMY,
    });
    expect(result.eng).toEqual({
      launchable: true,
      unavailableProfileIds: ["missing-profile"],
    });
  });

  test("a decision role keeps its original binding instead of using the pool", () => {
    const decision = role("lead", {
      executionPolicy: { tier: "decision", taskKind: "general" },
    });
    const result = computeRoleLaunchability({
      mode: "economy",
      roles: [decision],
      profiles: [POOL_PROFILE],
      availability: AVAILABILITY,
      economy: ECONOMY,
    });
    expect(result.lead).toEqual({
      launchable: false,
      unavailableProfileIds: ["missing-profile"],
    });
  });

  test("bounds the unavailable binding ids kept in the required index", () => {
    const ids = Array.from({ length: 7 }, (_, index) => ({ profileId: `missing-${index}` }));
    const many = role("many", {
      preferredProfiles: ids.slice(0, 5),
      fallbackProfiles: ids.slice(5),
    });
    const result = computeRoleLaunchability({
      mode: "sota",
      roles: [many],
      profiles: [],
      availability: [],
      economy: { pool: [], taskOrder: {}, profileBudget: {} },
    });
    expect(result.many?.launchable).toBe(false);
    expect(result.many?.unavailableProfileIds).toEqual([
      "missing-0",
      "missing-1",
      "missing-2",
      "missing-3",
      "missing-4",
    ]);
  });
});

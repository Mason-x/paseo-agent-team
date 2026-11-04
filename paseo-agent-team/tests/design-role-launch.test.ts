import { describe, expect, test } from "vitest";
import { computeRoleLaunchability } from "../server/designer/context";
import { validateRoleGap } from "../shared/domain/design-validation";
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
const profile: PaseoProfile = { id: "profile", name: "Profile", provider: "claude" };
function table(result: ReturnType<typeof computeRoleLaunchability>, id: string) {
  const member = result.member[id];
  const coordinator = result.coordinator[id];
  if (!member || !coordinator) throw new Error(`missing verdict for ${id}`);
  return { member, coordinator };
}

describe("role launchability", () => {
  test("a missing Role binding is unavailable for both uses even with an unrelated Profile", () => {
    const verdict = table(
      computeRoleLaunchability({
        roles: [role("eng")],
        profiles: [profile],
        availability: [{ provider: "claude", available: true }],
      }),
      "eng",
    );
    for (const use of [verdict.member, verdict.coordinator]) {
      expect(use).toEqual({
        launchable: false,
        unavailableProfileIds: ["missing-profile"],
        verified: true,
      });
    }
  });

  test("bounds unavailable binding ids to five", () => {
    const ids = Array.from({ length: 7 }, (_, index) => ({ profileId: `missing-${index}` }));
    const many = role("many", {
      preferredProfiles: ids.slice(0, 5),
      fallbackProfiles: ids.slice(5),
    });
    const verdict = table(
      computeRoleLaunchability({ roles: [many], profiles: [], availability: [] }),
      "many",
    );
    expect(verdict.member).toEqual({
      launchable: false,
      unavailableProfileIds: ["missing-0", "missing-1", "missing-2", "missing-3", "missing-4"],
      verified: true,
    });
    expect(verdict.coordinator).toEqual(verdict.member);
  });

  test("a missing availability row makes a live binding unverified", () => {
    const bound = role("bound", { preferredProfiles: [{ profileId: profile.id }] });
    const verdict = table(
      computeRoleLaunchability({ roles: [bound], profiles: [profile], availability: [] }),
      "bound",
    );
    expect(verdict.member).toMatchObject({ launchable: true, verified: false });
    expect(verdict.coordinator).toMatchObject({ launchable: true, verified: false });
  });

  test("an explicitly unavailable provider is a verified failure", () => {
    const bound = role("bound", { preferredProfiles: [{ profileId: profile.id }] });
    const verdict = table(
      computeRoleLaunchability({
        roles: [bound],
        profiles: [profile],
        availability: [{ provider: "claude", available: false }],
      }),
      "bound",
    );
    expect(verdict.member).toEqual({
      launchable: false,
      unavailableProfileIds: [profile.id],
      verified: true,
    });
    expect(verdict.coordinator).toEqual(verdict.member);
  });

  test("the gap verifier rejects an unverified claim and accepts a proven failure", () => {
    const bound = role("bound", { preferredProfiles: [{ profileId: profile.id }] });
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
          roleId: bound.id,
          responsibility: "负责上线判断",
          reason: "该 Role 不可启动",
          use: "member",
          profiles: { kind: "none", reason: "无合适 Profile" },
        },
      ],
    });
    const gate = (availability: ProviderAvailability[]) => {
      const roleLaunch = computeRoleLaunchability({
        roles: [bound],
        profiles: [profile],
        availability,
      });
      return validateRoleGap(
        proposal,
        {
          request: "上线",
          jobId: "11111111-1111-4111-8111-111111111111",
          attempt: 1,
          nonce: "0123456789abcdef0123456789abcdef",
          roles: [bound],
          teams: [],
          preferences: PreferencesSchema.parse({}),
          host: { status: "ready", profiles: [profile], availability },
          daemonConfig: {},
          carrierWorkspaceId: "carrier",
          targetWorkspaceId: null,
          capabilities: { onDemand: true, expansion: false, collaboration: false },
          roleLaunch,
        },
        { existingRolesOnly: true },
      );
    };
    const unverified = gate([]);
    expect(unverified.ok).toBe(false);
    if (unverified.ok) throw new Error("unverified claim accepted");
    expect(unverified.issues).toContainEqual(
      expect.objectContaining({
        code: "DESIGN_OUTPUT_SCHEMA",
        params: expect.objectContaining({ reason: "role-launch-unverified" }),
      }),
    );
    expect(gate([{ provider: "claude", available: false }]).ok).toBe(true);
  });
});

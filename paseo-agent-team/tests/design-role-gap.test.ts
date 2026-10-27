import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { extractDesignOutput } from "../shared/domain/design-output";
import type {
  DesignRoleLaunchTables,
  DesignValidationContext,
} from "../shared/domain/design-validation";
import { roleGapFinalIssue, validateRoleGap } from "../shared/domain/design-validation";
import type { DesignIssue, DesignRoleGapProposal, RoleGapReport } from "../shared/schemas/design";
import { PreferencesSchema } from "../shared/schemas/preferences";
import { DESIGN_JOB_ID, DESIGN_NONCE } from "./design-fixtures";
import {
  allAvailable,
  architect,
  claudeOpus,
  codexXhigh,
  codingTeam,
  developer,
  techLead,
} from "./fixtures";

const sonnet = {
  id: "claude-sonnet",
  name: "Claude Sonnet",
  provider: "claude",
  model: "claude-sonnet-4-6",
};

const haiku = {
  id: "claude-haiku",
  name: "Claude Haiku",
  provider: "claude",
  model: "claude-haiku-4-5",
};

function context(overrides: Partial<DesignValidationContext> = {}): DesignValidationContext {
  return {
    request: "补一个数据库迁移评审",
    mode: "economy-all",
    jobId: DESIGN_JOB_ID,
    attempt: 1,
    nonce: DESIGN_NONCE,
    roles: [techLead, architect, developer],
    teams: [codingTeam],
    preferences: PreferencesSchema.parse({ maxMembers: 24 }),
    host: {
      status: "ready",
      profiles: [sonnet, haiku, claudeOpus, codexXhigh],
      availability: allAvailable,
    },
    daemonConfig: {},
    carrierWorkspaceId: "ws-carrier",
    targetWorkspaceId: null,
    capabilities: { onDemand: true, expansion: true, collaboration: false },
    hasher: (content) => createHash("sha256").update(content).digest("hex"),
    ...overrides,
  };
}

function gapProposal(gaps: DesignRoleGapProposal["gaps"]): DesignRoleGapProposal {
  return {
    version: 2,
    kind: "role-gap",
    jobId: DESIGN_JOB_ID,
    attempt: 1,
    nonce: DESIGN_NONCE,
    summary: "现有 Role 覆盖不了迁移评审。",
    gaps,
  };
}

function missingRoleGap(
  overrides: Partial<Extract<DesignRoleGapProposal["gaps"][number], { kind: "missing-role" }>> = {},
): DesignRoleGapProposal["gaps"][number] {
  return {
    kind: "missing-role",
    responsibility: "数据库迁移评审",
    reason: "现有 Role 不承担迁移评审。",
    use: "member",
    profiles: { kind: "existing", profileIds: [sonnet.id] },
    suggestedRole: {
      id: "eng-migration-reviewer",
      name: "【工程】迁移评审",
      responsibilities: ["评审迁移脚本"],
      executionPolicy: { tier: "execution", taskKind: "codebase" },
    },
    ...overrides,
  };
}

function unlaunchableGap(
  use: "member" | "coordinator",
  roleId = "architect",
): DesignRoleGapProposal["gaps"][number] {
  return {
    kind: "unlaunchable-role",
    roleId,
    responsibility: "架构决定需要人拍板",
    reason: "架构 Role 在该用途无可启动绑定。",
    use,
    profiles: { kind: "none", reason: "host 无合适 Profile" },
  };
}

function tables(
  entries: Partial<Record<"member" | "coordinator", Record<string, unknown>>>,
): DesignRoleLaunchTables {
  return {
    member: (entries.member ?? {}) as DesignRoleLaunchTables["member"],
    coordinator: (entries.coordinator ?? {}) as DesignRoleLaunchTables["coordinator"],
  };
}

const ACCEPT = { existingRolesOnly: true };

function codes(result: { ok: boolean; issues?: readonly DesignIssue[] }): string[] {
  return result.ok ? [] : (result.issues ?? []).map((issue) => issue.code);
}

describe("role-gap acceptance", () => {
  test("a missing-role gap resolves Profile names from the host, not the model", () => {
    const result = validateRoleGap(
      gapProposal([
        missingRoleGap({ profiles: { kind: "existing", profileIds: [sonnet.id, haiku.id] } }),
      ]),
      context(),
      ACCEPT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.gaps).toHaveLength(1);
    expect(result.value.gaps[0]?.profiles.map((profile) => profile.name)).toEqual([
      "Claude Sonnet",
      "Claude Haiku",
    ]);
    expect(result.value.gaps[0]?.suggestedRole).toMatchObject({
      id: "eng-migration-reviewer",
      name: "【工程】迁移评审",
      executionPolicy: { tier: "execution", taskKind: "codebase" },
    });
  });

  test("kind:none keeps the model's reason and yields no Profiles", () => {
    const result = validateRoleGap(
      gapProposal([missingRoleGap({ profiles: { kind: "none", reason: "host 无合适 Profile" } })]),
      context(),
      ACCEPT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.gaps[0]).toMatchObject({
      profiles: [],
      profileGapReason: "host 无合适 Profile",
    });
  });

  test("a gap is rejected when the record is not existing-roles-only", () => {
    const result = validateRoleGap(gapProposal([missingRoleGap()]), context(), {
      existingRolesOnly: false,
    });
    expect(codes(result)).toEqual(["DESIGN_OUTPUT_SCHEMA"]);
    if (!result.ok) expect(result.issues[0]?.params.reason).toBe("role-gap-not-requested");
  });

  test("a failed configuration read is never turned into a responsibility gap", () => {
    const result = validateRoleGap(
      gapProposal([unlaunchableGap("member")]),
      context({ host: { status: "unavailable", reason: "settings-invalid" } }),
      ACCEPT,
    );
    expect(codes(result)).toEqual(["DESIGN_CONFIG_UNAVAILABLE"]);
    if (!result.ok) expect(result.issues[0]?.action).toBe("refresh");
  });

  test("suggested Roles must pass the naming rules and not collide", () => {
    const existingId = validateRoleGap(
      gapProposal([missingRoleGap({ suggestedRole: { ...missingGapRole(), id: "architect" } })]),
      context(),
      ACCEPT,
    );
    expect(codes(existingId)).toContain("DESIGN_ROLE_ID_CONFLICT");

    const existingName = validateRoleGap(
      gapProposal([
        missingRoleGap({
          suggestedRole: { ...missingGapRole(), id: "eng-arch", name: "architect" },
        }),
      ]),
      context(),
      ACCEPT,
    );
    expect(codes(existingName)).toContain("DESIGN_ROLE_NAME_CONFLICT");

    const badPrefix = validateRoleGap(
      gapProposal([
        missingRoleGap({
          suggestedRole: { ...missingGapRole(), id: "eng-arch", name: "架构补齐专员" },
        }),
      ]),
      context(),
      ACCEPT,
    );
    expect(codes(badPrefix)).toContain("DESIGN_ROLE_NAMING");

    // Two suggestions in one batch may not share an id or a normalized name.
    const batch = validateRoleGap(
      gapProposal([
        missingRoleGap({
          suggestedRole: { ...missingGapRole(), id: "eng-migration", name: "【工程】迁移评审" },
        }),
        missingRoleGap({
          responsibility: "另一职责",
          suggestedRole: { ...missingGapRole(), id: "eng-migration", name: "【工程】迁移评审" },
        }),
      ]),
      context(),
      ACCEPT,
    );
    expect(codes(batch)).toContain("DESIGN_ROLE_ID_CONFLICT");
    expect(codes(batch)).toContain("DESIGN_ROLE_NAME_CONFLICT");
  });

  test("suggested Profiles must exist, resolve, and not be high-cost", () => {
    const missing = validateRoleGap(
      gapProposal([missingRoleGap({ profiles: { kind: "existing", profileIds: ["p-gone"] } })]),
      context(),
      ACCEPT,
    );
    expect(codes(missing)).toEqual(["DESIGN_PROFILE_MISSING"]);

    const highCost = validateRoleGap(
      gapProposal([
        missingRoleGap({ profiles: { kind: "existing", profileIds: [claudeOpus.id] } }),
      ]),
      context(),
      ACCEPT,
    );
    expect(codes(highCost)).toEqual(["DESIGN_OUTPUT_SCHEMA"]);
    if (!highCost.ok) expect(highCost.issues[0]?.params.reason).toBe("high-cost-family");

    // `gpt-5.5` names no supported family, so it cannot pass as a cheap suggestion.
    const unresolved = validateRoleGap(
      gapProposal([
        missingRoleGap({ profiles: { kind: "existing", profileIds: ["codex-xhigh"] } }),
      ]),
      context(),
      ACCEPT,
    );
    expect(codes(unresolved)).toEqual(["DESIGN_OUTPUT_SCHEMA"]);
    if (!unresolved.ok) expect(unresolved.issues[0]?.params.reason).toBe("family-unverified");
  });

  test.each(["sota", "economy", "collaborative"] as const)(
    "P1-FIX1 item 1: %s does not apply the all-seats low-cost floor to suggestions",
    (mode) => {
      const result = validateRoleGap(
        gapProposal([
          missingRoleGap({
            profiles: { kind: "existing", profileIds: [claudeOpus.id, codexXhigh.id] },
          }),
        ]),
        context({ mode }),
        ACCEPT,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.gaps[0]?.profiles.map((profile) => profile.id)).toEqual([
          claudeOpus.id,
          codexXhigh.id,
        ]);
      }
      // A Profile that does not exist is still rejected in every mode.
      const missing = validateRoleGap(
        gapProposal([missingRoleGap({ profiles: { kind: "existing", profileIds: ["p-gone"] } })]),
        context({ mode }),
        ACCEPT,
      );
      expect(codes(missing)).toEqual(["DESIGN_PROFILE_MISSING"]);
    },
  );
});

describe("unlaunchable-role uses the verified per-use verdict", () => {
  const verifiedUnavailable = {
    launchable: false,
    unavailableProfileIds: [sonnet.id],
    verified: true,
  };

  test("accepts a Role the planner verified as unlaunchable in that use", () => {
    const result = validateRoleGap(
      gapProposal([unlaunchableGap("member")]),
      context({ roleLaunch: tables({ member: { architect: verifiedUnavailable } }) }),
      ACCEPT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.gaps[0]).toMatchObject({
      use: "member",
      unlaunchableRole: {
        roleId: "architect",
        roleName: "Architect",
        unavailableProfileIds: [sonnet.id],
        profileNames: ["Claude Sonnet"],
      },
    });
  });

  test("member and coordinator verdicts are judged separately", () => {
    const launchContext = context({
      roleLaunch: tables({
        member: { architect: { launchable: true, unavailableProfileIds: [], verified: true } },
        coordinator: { architect: verifiedUnavailable },
      }),
    });
    const memberClaim = validateRoleGap(
      gapProposal([unlaunchableGap("member")]),
      launchContext,
      ACCEPT,
    );
    expect(codes(memberClaim)).toEqual(["DESIGN_OUTPUT_SCHEMA"]);
    if (!memberClaim.ok) expect(memberClaim.issues[0]?.params.reason).toBe("role-launchable");

    const coordinatorClaim = validateRoleGap(
      gapProposal([unlaunchableGap("coordinator")]),
      launchContext,
      ACCEPT,
    );
    expect(coordinatorClaim.ok).toBe(true);
  });

  test("an unverified or missing verdict rejects the claim instead of inventing a gap", () => {
    const unverified = validateRoleGap(
      gapProposal([unlaunchableGap("member")]),
      context({
        roleLaunch: tables({
          member: {
            architect: { launchable: false, unavailableProfileIds: [], verified: false },
          },
        }),
      }),
      ACCEPT,
    );
    expect(codes(unverified)).toEqual(["DESIGN_OUTPUT_SCHEMA"]);
    if (!unverified.ok) expect(unverified.issues[0]?.params.reason).toBe("role-launch-unverified");

    const notInjected = validateRoleGap(
      gapProposal([unlaunchableGap("member")]),
      context(),
      ACCEPT,
    );
    expect(codes(notInjected)).toEqual(["DESIGN_OUTPUT_SCHEMA"]);

    const unknownRole = validateRoleGap(
      gapProposal([unlaunchableGap("member", "eng-ghost")]),
      context({ roleLaunch: tables({ member: { architect: verifiedUnavailable } }) }),
      ACCEPT,
    );
    expect(codes(unknownRole)).toEqual(["DESIGN_OUTPUT_SCHEMA"]);
    if (!unknownRole.ok) expect(unknownRole.issues[0]?.params.reason).toBe("unknown-role");
  });
});

describe("gap output and terminal issue", () => {
  test("contract 2 extraction feeds validateRoleGap end to end", () => {
    const proposal = gapProposal([missingRoleGap()]);
    const extracted = extractDesignOutput({
      text: `\`\`\`agent-team-design\n${JSON.stringify(proposal)}\n\`\`\``,
      jobId: DESIGN_JOB_ID,
      attempt: 1,
      nonce: DESIGN_NONCE,
      outputContractVersion: 2,
    });
    expect(extracted.ok).toBe(true);
    if (!extracted.ok || extracted.contract !== 2 || extracted.kind !== "role-gap") return;
    const result = validateRoleGap(extracted.gap, context(), ACCEPT);
    expect(result.ok).toBe(true);
  });

  test("the terminal issue reuses DESIGN_REUSE_INVALID with a bounded roleId", () => {
    const gap = validateRoleGap(
      gapProposal([unlaunchableGap("member")]),
      context({
        roleLaunch: tables({
          member: {
            architect: { launchable: false, unavailableProfileIds: [], verified: true },
          },
        }),
      }),
      ACCEPT,
    );
    if (!gap.ok) throw new Error("expected a valid gap");
    const issue = roleGapFinalIssue(gap.value.gaps);
    expect(issue).toMatchObject({
      code: "DESIGN_REUSE_INVALID",
      params: { reason: "roles-gap", roleId: "architect" },
      action: "choose-profile",
    });

    const report: RoleGapReport = {
      responsibility: "迁移评审",
      reason: "现有 Role 不覆盖",
      use: "member",
      profiles: [],
    };
    expect(roleGapFinalIssue([report])).toMatchObject({
      params: { reason: "roles-gap", roleId: "" },
    });
  });
});

function missingGapRole() {
  return {
    id: "eng-migration-reviewer",
    name: "【工程】迁移评审",
    responsibilities: ["评审迁移脚本"],
    executionPolicy: { tier: "execution" as const, taskKind: "codebase" as const },
  };
}

describe("gap shape is re-checked inside validation", () => {
  test("a gap object that smuggles a Team is rejected by the strict schema", () => {
    const smuggled = {
      ...gapProposal([missingRoleGap()]),
      team: {
        id: "sneaky-team",
        name: "Sneaky",
        mode: "sota",
        coordinatorRoleId: "tech-lead",
        members: [{ key: "m1", roleId: "architect" }],
      },
    };
    const result = validateRoleGap(smuggled as unknown as DesignRoleGapProposal, context(), ACCEPT);
    expect(codes(result)).toEqual(["DESIGN_OUTPUT_SCHEMA"]);
  });
});

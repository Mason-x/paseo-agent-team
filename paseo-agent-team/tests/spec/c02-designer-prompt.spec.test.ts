// C02 spec: the designer prompt must follow the record's output contract (v1 legacy vs v2 by
// switch), stay inside the 30KiB input budget, carry per-use launch verdicts without inferring
// one from the other, and gate economy-all gap suggestions through D02's route evidence.
import { describe, expect, test } from "vitest";
import { type DesignModeRouting, describeModeRouting } from "../../server/designer/context";
import { checkGapEconomyEligibility } from "../../server/designer/planning";
import {
  buildDesignCorrection,
  buildDesignKickoff,
  DESIGN_CORRECTION_MAX_BYTES,
  DESIGN_KICKOFF_MAX_BYTES,
  DESIGN_KICKOFF_TARGET_BYTES,
  type DesignPromptContext,
  type DesignPromptRoleSummary,
} from "../../server/designer/prompt";
import { utf8ByteLength } from "../../shared/domain/design-output";
import { normalizeEconomyPolicy } from "../../shared/domain/mode-resolver";
import type { PaseoProfile } from "../../shared/paseo/adapter";
import { DesignRoleGapSchema } from "../../shared/schemas/design";
import { expectedRoleContent, sourceProfiles } from "../default-presets.fixtures";

const JOB = "11111111-1111-4111-8111-111111111111";
const NONCE = "0123456789abcdef0123456789abcdef";

function role(
  id: string,
  overrides: Partial<DesignPromptRoleSummary> = {},
): DesignPromptRoleSummary {
  return {
    id,
    name: `Role ${id}`,
    enabled: true,
    mission: "完成指定职责",
    responsibilities: ["实现"],
    preferredProfileIds: ["profile-1"],
    fallbackProfileIds: [],
    launchable: true,
    unavailableProfileIds: [],
    tier: "execution",
    taskKind: "coding",
    ...overrides,
  };
}

function context(overrides: Partial<DesignPromptContext> = {}): DesignPromptContext {
  return {
    request: "设计一个改版团队",
    requestedMode: "economy",
    runtimeCapabilities: { onDemand: true, expansion: false, collaboration: false },
    maxMembers: 8,
    target: null,
    carrierWorkspaceId: "carrier",
    roles: [role("eng")],
    profiles: [
      {
        id: "profile-1",
        name: "Profile 1",
        provider: "claude",
        model: "claude-haiku-4-5",
        available: true,
      },
    ],
    economy: { pool: [], taskOrder: {} },
    occupiedRoleIds: ["eng"],
    occupiedRoleNames: ["Role eng"],
    occupiedTeams: [],
    expectedChoices: [],
    ...overrides,
  };
}

function text(result: ReturnType<typeof buildDesignKickoff>): string {
  if (!result.ok) throw new Error(result.issues.map((issue) => issue.code).join(","));
  return result.text;
}

function indexOfBlock(source: string, title: string): unknown {
  const marker = `## ${title}\n`;
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`missing ${title}`);
  const rest = source.slice(at + marker.length);
  const end = rest.indexOf("\n");
  return JSON.parse(end < 0 ? rest : rest.slice(0, end));
}

describe("C02 designer prompt contract", () => {
  test("v1 renders the legacy contract only", () => {
    const rendered = text(
      buildDesignKickoff({ jobId: JOB, attempt: 1, nonce: NONCE, context: context() }),
    );
    expect(rendered).toContain('"固定 1"');
    expect(rendered).not.toContain('"kind":"team"');
    expect(rendered).not.toContain("role-gap");
    expect(rendered).toContain('"newRole":{');
  });

  test("v2 with the switch off renders the team contract and 3 new Roles", () => {
    const rendered = text(
      buildDesignKickoff({
        jobId: JOB,
        attempt: 1,
        nonce: NONCE,
        context: context({ outputContractVersion: 2, existingRolesOnly: false }),
      }),
    );
    expect(rendered).toContain('"固定 2"');
    expect(rendered).toContain('"kind":"team"');
    expect(rendered).toContain('"newRole":{');
    expect(rendered).toContain('"newRoles":3');
    expect(rendered).not.toContain("role-gap");
  });

  test("v2 with the switch on leads with a gap and never teaches new Roles", () => {
    const rendered = text(
      buildDesignKickoff({
        jobId: JOB,
        attempt: 1,
        nonce: NONCE,
        context: context({ outputContractVersion: 2, existingRolesOnly: true }),
      }),
    );
    expect(rendered).toContain('"kind":"role-gap"');
    expect(rendered).toContain('"gaps":[');
    expect(rendered).toContain('"newRoles":0');
    expect(rendered).toContain('"newRoleLimit":0');
    expect(rendered).not.toContain('"newRole":{');
    expect(rendered).toContain('"newRoles":[]');
    expect(rendered.indexOf('"kind":"role-gap"')).toBeLessThan(
      rendered.indexOf("复用-only 团队示例"),
    );
    expect(rendered).toContain("覆盖不了就报 role-gap");
  });

  test("correction selects the same templates as the kickoff", () => {
    const correction = (ctx: DesignPromptContext, previous?: "team" | "role-gap") =>
      text(
        buildDesignCorrection({
          jobId: JOB,
          attempt: 2,
          nonce: NONCE,
          issues: [],
          context: ctx,
          expectedChoices: [],
          ...(previous === undefined ? {} : { previousOutputKind: previous }),
        }),
      );
    expect(correction(context())).not.toContain('"kind":"team"');
    expect(correction(context(), "role-gap")).toBe(correction(context()));
    expect(correction(context({ outputContractVersion: 2, existingRolesOnly: false }))).toContain(
      '"kind":"team"',
    );
    const on = context({ outputContractVersion: 2, existingRolesOnly: true });
    expect(correction(on)).toContain('"kind":"role-gap"');
    const gapOnly = correction(on, "role-gap");
    expect(gapOnly).toContain('"kind":"role-gap"');
    expect(gapOnly).not.toContain("复用-only 团队示例");
    expect(gapOnly).toContain("上一轮是角色缺口");
  });

  test("v1 ignores every v2 field that a wired service will pass", () => {
    const plain = text(
      buildDesignKickoff({ jobId: JOB, attempt: 1, nonce: NONCE, context: context() }),
    );
    const enriched = text(
      buildDesignKickoff({
        jobId: JOB,
        attempt: 1,
        nonce: NONCE,
        context: context({
          outputContractVersion: 1,
          existingRolesOnly: true,
          modeRouting: {
            status: "ready",
            routes: [
              {
                route: "execution",
                taskKind: "coding",
                candidates: [
                  { profileId: "profile-1", family: "haiku", eligible: true, reported: false },
                ],
              },
            ],
          },
          roles: [
            role("eng", {
              coordinatorLaunchable: false,
              launchVerified: false,
              coordinatorLaunchVerified: true,
            }),
          ],
        }),
      }),
    );
    expect(enriched).toBe(plain);
  });

  test("v2 exposes member and coordinator verdicts without inferring either", () => {
    const roles = [
      role("eng", {
        launchable: true,
        coordinatorLaunchable: false,
        launchVerified: true,
        coordinatorLaunchVerified: true,
      }),
      role("lead", {
        launchable: false,
        coordinatorLaunchable: true,
        launchVerified: true,
        coordinatorLaunchVerified: false,
      }),
    ];
    const rendered = text(
      buildDesignKickoff({
        jobId: JOB,
        attempt: 1,
        nonce: NONCE,
        context: context({ outputContractVersion: 2, existingRolesOnly: false, roles }),
      }),
    );
    const index = indexOfBlock(rendered, "Role 索引") as Array<Record<string, unknown>>;
    expect(index[0]).toMatchObject({ launchable: true, memberLaunch: "ok" });
    expect(index[0]).toMatchObject({ coordinatorLaunch: "blocked" });
    expect(index[1]).toMatchObject({ launchable: false, memberLaunch: "blocked" });
    expect(index[1]).toMatchObject({ coordinatorLaunch: "ok" });
  });

  test("both switches stay inside the 30KiB target at catalog size", () => {
    const roles = expectedRoleContent.map((item, index) =>
      role(item.id, {
        name: item.name,
        mission: item.mission,
        responsibilities: item.responsibilities,
        launchable: index % 4 !== 0,
        coordinatorLaunchable: index % 3 !== 0,
        launchVerified: true,
        coordinatorLaunchVerified: index % 5 !== 0,
      }),
    );
    const base = context({
      roles,
      profiles: sourceProfiles.map((entry) => ({
        id: entry.id,
        name: entry.name,
        provider: entry.provider,
        model: entry.model,
        available: true,
        notes: entry.notes,
      })),
      occupiedRoleIds: roles.map((item) => item.id),
      occupiedRoleNames: roles.map((item) => item.name),
    });
    for (const existingRolesOnly of [false, true]) {
      const ctx = { ...base, outputContractVersion: 2 as const, existingRolesOnly };
      const kickoff = buildDesignKickoff({ jobId: JOB, attempt: 1, nonce: NONCE, context: ctx });
      expect(kickoff.ok).toBe(true);
      if (!kickoff.ok) continue;
      expect(kickoff.utf8Bytes).toBe(utf8ByteLength(kickoff.text));
      expect(kickoff.utf8Bytes).toBeLessThanOrEqual(DESIGN_KICKOFF_TARGET_BYTES);
      expect(kickoff.utf8Bytes).toBeLessThanOrEqual(DESIGN_KICKOFF_MAX_BYTES);
      expect(kickoff.text).toContain(NONCE);
      expect(kickoff.text.match(/identity 必须逐字复制/gu)).toHaveLength(2);
      expect(kickoff.text).toContain("## 字段合同");
      const correction = buildDesignCorrection({
        jobId: JOB,
        attempt: 2,
        nonce: NONCE,
        issues: [],
        context: ctx,
        expectedChoices: [],
      });
      expect(correction.ok).toBe(true);
      if (!correction.ok) continue;
      expect(correction.utf8Bytes).toBeLessThanOrEqual(DESIGN_CORRECTION_MAX_BYTES);
    }
  });

  test("economy-all gap suggestions must be route candidates", () => {
    const profiles: PaseoProfile[] = [
      { id: "haiku", name: "Haiku", provider: "claude", model: "claude-haiku-4-5" },
      {
        id: "deepseek",
        name: "DeepSeek",
        provider: "omp",
        model: "opencode-go/deepseek-v4.1-flash",
      },
    ];
    const policy = normalizeEconomyPolicy(
      {
        pool: [],
        taskOrder: {},
        profileBudget: {},
        allSeats: {
          version: 1,
          profiles: [
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
          ],
          routes: { coordinator: ["haiku"], execution: ["deepseek"] },
        },
      },
      profiles,
    );
    expect(policy.ok).toBe(true);
    if (!policy.ok) return;
    const routing: DesignModeRouting = describeModeRouting({
      profiles,
      availability: [
        { provider: "claude", available: true },
        { provider: "omp", available: true },
      ],
      economy: policy.value,
    });
    const gap = (profileIds: string[]) =>
      DesignRoleGapSchema.parse({
        kind: "missing-role",
        responsibility: "负责数据库迁移",
        reason: "目录没有承担迁移的 Role",
        use: "member",
        profiles: { kind: "existing", profileIds },
        suggestedRole: {
          id: "eng-data",
          name: "【工程】数据迁移",
          responsibilities: ["迁移"],
          executionPolicy: { tier: "execution", taskKind: "coding" },
        },
      });
    expect(
      checkGapEconomyEligibility({ mode: "economy-all", gap: gap(["deepseek"]), routing }),
    ).toEqual([]);
    const rejected = checkGapEconomyEligibility({
      mode: "economy-all",
      gap: gap(["haiku"]),
      routing,
    });
    expect(rejected[0]?.params).toMatchObject({
      modeCode: "MODE_CHEAP_PROFILE_INVALID",
      route: "execution",
      profileId: "haiku",
    });
    expect(
      checkGapEconomyEligibility({
        mode: "economy-all",
        gap: DesignRoleGapSchema.parse({
          kind: "missing-role",
          responsibility: "负责数据库迁移",
          reason: "目录没有承担迁移的 Role",
          use: "member",
          profiles: { kind: "none", reason: "host 无合格 Profile" },
          suggestedRole: {
            id: "eng-data",
            name: "【工程】数据迁移",
            responsibilities: ["迁移"],
            executionPolicy: { tier: "execution", taskKind: "coding" },
          },
        }),
        routing,
      }),
    ).toEqual([]);
    expect(
      checkGapEconomyEligibility({
        mode: "economy-all",
        gap: DesignRoleGapSchema.parse({
          kind: "missing-role",
          responsibility: "负责数据库迁移",
          reason: "目录没有承担迁移的 Role",
          use: "member",
          profiles: { kind: "none", reason: "host 无合格 Profile" },
          suggestedRole: {
            id: "eng-data",
            name: "【工程】数据迁移",
            responsibilities: ["迁移"],
            executionPolicy: { tier: "execution", taskKind: "coding" },
          },
        }),
        routing: { status: "absent" },
      }),
    ).toEqual([]);
    expect(
      checkGapEconomyEligibility({
        mode: "economy-all",
        gap: gap(["deepseek"]),
        routing: { status: "absent" },
      })[0]?.params,
    ).toMatchObject({ modeCode: "MODE_CHEAP_POLICY_REQUIRED" });
  });
});

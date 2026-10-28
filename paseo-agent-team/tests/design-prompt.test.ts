import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { DesignModeRouting } from "../server/designer/context";
import {
  bindDesignerProfile,
  DESIGNER_PROFILE_HINTS,
  DESIGNER_SYSTEM_PROMPT,
} from "../server/designer/definition";
import {
  buildDesignCorrection,
  buildDesignKickoff,
  DESIGN_CORRECTION_MAX_BYTES,
  DESIGN_KICKOFF_MAX_BYTES,
  DESIGN_KICKOFF_TARGET_BYTES,
  DESIGN_SYSTEM_PROMPT_MAX_BYTES,
  type DesignPromptContext,
  type DesignPromptInput,
  type DesignPromptProfileSummary,
  type DesignPromptRoleSummary,
  summarizeProfiles,
} from "../server/designer/prompt";
import { TEAM_DESIGN_RECIPES } from "../server/templates/recipes";
import { utf8ByteLength } from "../shared/domain/design-output";
import { type DesignIssue, DesignProposalSchema } from "../shared/schemas/design";
import { expectedRoleContent, sourceProfiles } from "./default-presets.fixtures";

const SOURCE_RECIPES = [
  {
    id: "feature",
    name: "功能开发",
    coordinatorRoleId: "lead-tech",
    members: ["plan-architect", "eng-fullstack", "eng-frontend", "qa-test", "qa-review"],
  },
  {
    id: "debugging",
    name: "疑难排障",
    coordinatorRoleId: "lead-tech",
    members: ["research-codebase", "eng-expert", "qa-test", "qa-review"],
  },
  {
    id: "batch",
    name: "批量改造",
    coordinatorRoleId: "lead-tech",
    members: ["plan-architect", "eng-batch", "qa-test", "qa-review"],
    ranged: { roleId: "eng-batch", minInstances: 2, maxInstances: 3 },
  },
  {
    id: "release-check",
    name: "上线前检查",
    coordinatorRoleId: "lead-tech",
    members: ["qa-review", "qa-test", "eng-batch"],
  },
  {
    id: "technical-research",
    name: "技术调研",
    coordinatorRoleId: "lead-orchestrator",
    members: ["research-web", "research-codebase", "research-docs"],
  },
  {
    id: "materials",
    name: "资料与截图研读",
    coordinatorRoleId: "lead-orchestrator",
    members: ["research-docs", "content-writer"],
  },
  {
    id: "creative-content",
    name: "文案、脚本、视频文案",
    coordinatorRoleId: "lead-orchestrator",
    members: ["research-web", "content-writer"],
  },
  {
    id: "technical-writing",
    name: "技术文档",
    coordinatorRoleId: "lead-orchestrator",
    members: ["research-codebase", "content-writer"],
  },
  {
    id: "cross-domain",
    name: "跨领域",
    coordinatorRoleId: "lead-orchestrator",
    members: ["research-web", "plan-architect", "eng-fullstack", "qa-review", "content-writer"],
  },
] as const;

const HINTS = [
  {
    name: "Claude-Opus-5.5-Max",
    provider: "claude",
    model: "claude-opus-5-5",
    modeId: "auto",
    thinkingOptionId: "max",
  },
  {
    name: "Claude-Opus-5.5-Medium",
    provider: "claude",
    model: "claude-opus-5-5",
    modeId: "auto",
    thinkingOptionId: "medium",
  },
  {
    name: "GPT-6.1-Sol Xhigh",
    provider: "codex",
    model: "codex/gpt-6.1-sol",
    modeId: "full-access",
    thinkingOptionId: "xhigh",
  },
  {
    name: "DeepSeek-V4.1-Flash-Max",
    provider: "omp",
    model: "opencode-go/deepseek-v4.1-flash",
    modeId: "full",
    thinkingOptionId: "max",
  },
] as const;

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const NONCE = "0123456789abcdef0123456789abcdef";

function role(
  index: number,
  overrides: Partial<DesignPromptRoleSummary> = {},
): DesignPromptRoleSummary {
  return {
    id: `role-${index}`,
    name: `角色${index}`,
    enabled: true,
    mission: `使命${index}`,
    responsibilities: [`职责${index}`],
    preferredProfileIds: ["profile-1"],
    fallbackProfileIds: [],
    launchable: true,
    unavailableProfileIds: [],
    tier: "execution",
    taskKind: "coding",
    ...overrides,
  };
}

function profile(index: number, notes?: string): DesignPromptProfileSummary {
  return {
    id: `profile-${index}`,
    name: `Profile ${index}`,
    provider: "claude",
    model: "claude-opus-5-5",
    modeId: "auto",
    thinkingOptionId: "high",
    available: true,
    notes,
    family: "claude",
    budget: "sota",
    budgetBasis: "host",
  };
}

function context(overrides: Partial<DesignPromptContext> = {}): DesignPromptContext {
  return {
    request: "设计一个功能开发团队",
    requestedMode: "economy",
    runtimeCapabilities: { onDemand: true, expansion: false, collaboration: false },
    maxMembers: 8,
    target: { id: "workspace-target", name: "目标", path: "/work/target" },
    carrierWorkspaceId: "workspace-carrier",
    roles: [role(1)],
    profiles: [profile(1, "普通说明")],
    economy: { pool: [{ profileId: "profile-1", family: "claude", enabled: true }], taskOrder: {} },
    occupiedRoleIds: ["role-1"],
    occupiedRoleNames: ["角色1"],
    occupiedTeams: [{ id: "team-1", name: "已有团队" }],
    expectedChoices: [
      { target: "coordinator", roleId: "role-1", expectedProfileIds: ["profile-1"] },
    ],
    ...overrides,
  };
}

function kickoff(overrides: Partial<DesignPromptContext> = {}, attempt: 1 | 2 | 3 = 1) {
  const input: DesignPromptInput = {
    jobId: JOB_ID,
    attempt,
    nonce: NONCE,
    context: context(overrides),
  };
  return buildDesignKickoff(input);
}

function textOf(result: ReturnType<typeof buildDesignKickoff>): string {
  if (!result.ok) throw new Error(result.issues.map((issue) => issue.code).join(","));
  return result.text;
}

/** Byte-exact baseline for the legacy contract (record outputContractVersion = 1). */
function goldenSha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function realScaleRoles(): DesignPromptRoleSummary[] {
  const catalog = [
    ...expectedRoleContent,
    ...expectedRoleContent.slice(0, 8).map((item) => ({ ...item, id: `${item.id}-custom` })),
  ];
  return catalog.map((item, index) =>
    role(index, {
      id: item.id,
      name: item.name,
      mission: item.mission,
      responsibilities: item.responsibilities,
      launchable: index !== 0,
      unavailableProfileIds: index === 0 ? ["profile-missing"] : [],
    }),
  );
}

function devCatalog(): {
  roles: DesignPromptRoleSummary[];
  teams: Array<{ id: string; name: string }>;
} {
  type Backup = {
    roles: {
      roles: Array<{
        id: string;
        name: string;
        enabled?: boolean;
        mission: string;
        responsibilities: string[];
        preferredProfiles?: Array<{ profileId: string }>;
        fallbackProfiles?: Array<{ profileId: string }>;
        executionPolicy?: { tier?: string; taskKind?: string };
      }>;
    };
    teams: { teams: Array<{ id: string; name: string }> };
  };
  // Fixture captured from the DEV host; only the prompt-facing fields are read.
  const backup = JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", "v01b-dev-settings-backup.json"), "utf8"),
  ) as Backup;
  return {
    roles: backup.roles.roles.map((entry, index) =>
      role(index, {
        id: entry.id,
        name: entry.name,
        enabled: entry.enabled !== false,
        mission: entry.mission,
        responsibilities: entry.responsibilities,
        preferredProfileIds: entry.preferredProfiles?.map((ref) => ref.profileId) ?? ["profile-1"],
        fallbackProfileIds: entry.fallbackProfiles?.map((ref) => ref.profileId) ?? [],
        launchable: true,
        tier: entry.executionPolicy?.tier ?? "execution",
        taskKind: entry.executionPolicy?.taskKind ?? "general",
      }),
    ),
    teams: backup.teams.teams.map((entry) => ({ id: entry.id, name: entry.name })),
  };
}

function roleEntries(text: string): Array<Record<string, unknown>> {
  const marker = "## Role 索引\n";
  const at = text.indexOf(marker);
  if (at < 0) throw new Error("missing Role 索引");
  const rest = text.slice(at + marker.length);
  const end = rest.indexOf("\n");
  return JSON.parse(end < 0 ? rest : rest.slice(0, end)) as Array<Record<string, unknown>>;
}

describe("v1 prompt golden snapshot", () => {
  test("freezes the small kickoff byte for byte", () => {
    const result = kickoff();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.utf8Bytes).toBe(9140);
    expect(goldenSha(result.text)).toBe(
      "e9dd9ab133435a8496e33b08af967f6b9917e4acce67240051153eb2449ca7ba",
    );
  });

  test("freezes the real-sized compressed kickoff byte for byte", () => {
    const roles = realScaleRoles();
    const result = kickoff({
      request: "设计一个功能开发团队",
      roles,
      profiles: [profile(1, "说明".repeat(3000))],
      occupiedRoleIds: roles.map((item) => item.id),
      occupiedRoleNames: roles.map((item) => item.name),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.utf8Bytes).toBe(29384);
    expect(goldenSha(result.text)).toBe(
      "f05f00a4c499a780dd55411da07fe2268628d52dfd53bcb1857f353839dc1cf6",
    );
  });

  test("freezes the realistic correction byte for byte", () => {
    const result = realisticCorrection(realisticCorrectionContext());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.utf8Bytes).toBe(4202);
    expect(goldenSha(result.text)).toBe(
      "37530d2956388b29fe063b9c6158769ad866bcc66a410ea1dca2f6114d819081",
    );
  });

  test("v1 correction ignores previousOutputKind and every v2 field", () => {
    const result = realisticCorrection(
      realisticCorrectionContext({
        outputContractVersion: 1,
        existingRolesOnly: true,
        modeRouting: {
          status: "ready",
          routes: [
            {
              route: "execution",
              taskKind: "coding",
              candidates: [
                { profileId: "profile-1", family: "claude", eligible: true, reported: false },
              ],
            },
          ],
        },
        roles: [
          role(0, {
            launchVerified: false,
            coordinatorLaunchable: false,
            coordinatorLaunchVerified: true,
          }),
        ],
      }),
      "role-gap",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).not.toContain("上一轮是角色缺口");
    expect(result.utf8Bytes).toBe(4202);
    expect(goldenSha(result.text)).toBe(
      "37530d2956388b29fe063b9c6158769ad866bcc66a410ea1dca2f6114d819081",
    );
  });
});

function realisticCorrectionContext(
  overrides: Partial<DesignPromptContext> = {},
): DesignPromptContext {
  const roles = expectedRoleContent.map((item, index) =>
    role(index, {
      id: item.id,
      name: item.name,
      mission: item.mission,
      responsibilities: item.responsibilities,
    }),
  );
  return context({
    roles,
    profiles: [profile(1)],
    occupiedRoleIds: roles.map((item) => item.id),
    occupiedRoleNames: roles.map((item) => item.name),
    expectedChoices: [],
    ...overrides,
  });
}

function realisticCorrection(
  promptContext: DesignPromptContext,
  previousOutputKind?: "team" | "role-gap",
) {
  return buildDesignCorrection({
    jobId: JOB_ID,
    attempt: 2,
    nonce: NONCE,
    issues: [
      {
        code: "DESIGN_OUTPUT_IDENTITY",
        severity: "error",
        path: ["nonce"],
        params: { field: "nonce" },
        action: "repair",
      },
    ],
    context: promptContext,
    expectedChoices: [],
    ...(previousOutputKind === undefined ? {} : { previousOutputKind }),
  });
}

describe("team design recipes", () => {
  test("copies all nine source lineups without inventing counts", () => {
    expect(TEAM_DESIGN_RECIPES).toHaveLength(9);
    expect(TEAM_DESIGN_RECIPES.map((recipe) => recipe.id)).toEqual(
      SOURCE_RECIPES.map((recipe) => recipe.id),
    );
    for (const [index, expected] of SOURCE_RECIPES.entries()) {
      const recipe = TEAM_DESIGN_RECIPES[index];
      expect(recipe).toMatchObject({
        id: expected.id,
        name: expected.name,
        coordinatorRoleId: expected.coordinatorRoleId,
      });
      expect(recipe?.members.map((member) => member.roleId)).toEqual([...expected.members]);
      for (const member of recipe?.members ?? []) {
        const ranged = "ranged" in expected ? expected.ranged : undefined;
        const count =
          ranged?.roleId === member.roleId ? ranged : { minInstances: 1, maxInstances: 1 };
        expect(member.minInstances).toBe(count.minInstances);
        expect(member.maxInstances).toBe(count.maxInstances);
      }
    }
    expect(TEAM_DESIGN_RECIPES[2]?.notes).toBe("批量开发 ×2–3，用实例标签区分，如 A / B");
    expect(TEAM_DESIGN_RECIPES[8]?.notes).toBe("调研→开发→发布文案");
  });
});

describe("design output contract", () => {
  function correction(
    overrides: Partial<DesignPromptContext> = {},
    previousOutputKind?: "team" | "role-gap",
  ) {
    return buildDesignCorrection({
      jobId: JOB_ID,
      attempt: 2,
      nonce: NONCE,
      issues: [],
      context: context(overrides),
      expectedChoices: [],
      ...(previousOutputKind === undefined ? {} : { previousOutputKind }),
    });
  }

  function jsonBlockAt(text: string, title: string): unknown {
    const marker = `## ${title}\n`;
    const at = text.indexOf(marker);
    if (at < 0) throw new Error(`missing ${title}`);
    const rest = text.slice(at + marker.length);
    const end = rest.indexOf("\n");
    return JSON.parse(end < 0 ? rest : rest.slice(0, end));
  }

  const ROUTING: DesignModeRouting = {
    status: "ready",
    routes: [
      {
        route: "coordinator",
        taskKind: null,
        candidates: [{ profileId: "profile-1", family: "claude", eligible: true, reported: false }],
      },
      {
        route: "execution",
        taskKind: "coding",
        candidates: [
          { profileId: "profile-1", family: "claude", eligible: true, reported: false },
          {
            profileId: "profile-2",
            family: "deepseek",
            eligible: false,
            reason: "unverified",
            reported: true,
          },
          {
            profileId: "profile-3",
            family: "grok",
            eligible: false,
            reason: "high-cost-family",
            reported: true,
          },
        ],
      },
    ],
  };

  test("v1 text ignores every v2 field and stays byte-identical", () => {
    const enriched = kickoff({
      outputContractVersion: 1,
      existingRolesOnly: true,
      modeRouting: ROUTING,
      roles: [
        role(1, {
          coordinatorLaunchable: false,
          launchVerified: false,
          coordinatorLaunchVerified: true,
        }),
      ],
    });
    const text = textOf(enriched);
    expect(goldenSha(text)).toBe(
      "e9dd9ab133435a8496e33b08af967f6b9917e4acce67240051153eb2449ca7ba",
    );
  });

  test("v2 with the switch off keeps the team contract and the 3-Role limit", () => {
    const text = textOf(kickoff({ outputContractVersion: 2, existingRolesOnly: false }));
    expect(text).toContain('"固定 2"');
    expect(text).toContain('"kind":"team"');
    expect(text).toContain('"newRole":{');
    expect(text).toContain('"newRoles":3');
    expect(text).toContain('"newRoleLimit":3');
    expect(text).not.toContain("role-gap");
  });

  test("v2 with the switch on leads with a gap sample and never teaches new Roles", () => {
    const text = textOf(kickoff({ outputContractVersion: 2, existingRolesOnly: true }));
    expect(text).toContain('"kind":"role-gap"');
    expect(text).toContain('"newRoles":[]');
    expect(text).toContain("复用-only 团队示例");
    expect(text).toContain('"newRoles":0');
    expect(text).toContain('"newRoleLimit":0');
    expect(text).toContain("覆盖不了就报 role-gap");
    expect(text).toContain("reason 必须说明该 Role 承担的职责");
    expect(text).not.toContain('"newRole":{');
  });

  test("correction follows the record contract", () => {
    const v1 = textOf(correction());
    expect(v1).toContain('"固定 1"');
    expect(v1).not.toContain('"kind":"team"');
    const off = textOf(correction({ outputContractVersion: 2, existingRolesOnly: false }));
    expect(off).toContain('"kind":"team"');
    expect(off).not.toContain("role-gap");
    const on = textOf(correction({ outputContractVersion: 2, existingRolesOnly: true }));
    expect(on).toContain('"kind":"role-gap"');
    expect(on).toContain("复用-only 团队示例");
  });

  test("a failed gap correction carries only the gap template", () => {
    const gapOnly = textOf(
      correction({ outputContractVersion: 2, existingRolesOnly: true }, "role-gap"),
    );
    expect(gapOnly).toContain("上一轮是角色缺口");
    expect(gapOnly).toContain('"kind":"role-gap"');
    expect(gapOnly).not.toContain("复用-only 团队示例");
    const afterTeam = textOf(
      correction({ outputContractVersion: 2, existingRolesOnly: true }, "team"),
    );
    expect(afterTeam).toContain("复用-only 团队示例");
    expect(afterTeam).not.toContain("上一轮是角色缺口");
  });

  test("switching the flag never leaves the other template behind", () => {
    const shared = context({ outputContractVersion: 2, existingRolesOnly: true });
    const on = buildDesignKickoff({
      jobId: JOB_ID,
      attempt: 1,
      nonce: NONCE,
      context: shared,
    });
    const off = buildDesignKickoff({
      jobId: JOB_ID,
      attempt: 1,
      nonce: NONCE,
      context: { ...shared, existingRolesOnly: false },
    });
    const onText = textOf(on);
    const offText = textOf(off);
    expect(onText).toContain('"kind":"role-gap"');
    expect(onText).not.toContain('"newRole":{');
    expect(offText).toContain('"newRole":{');
    expect(offText).not.toContain("role-gap");
  });

  test("v2 carries both launch uses separately and v1 hides them", () => {
    const roles = [
      role(1, {
        launchable: true,
        coordinatorLaunchable: false,
        launchVerified: true,
        coordinatorLaunchVerified: true,
      }),
      role(2, {
        launchable: false,
        coordinatorLaunchable: true,
        launchVerified: true,
        coordinatorLaunchVerified: false,
      }),
    ];
    const v2 = textOf(kickoff({ outputContractVersion: 2, existingRolesOnly: false, roles }));
    const index = jsonBlockAt(v2, "Role 索引") as Array<Record<string, unknown>>;
    // A role usable as member but provably blocked as coordinator, and the reverse: one
    // tri-state per use, never inferred across uses.
    expect(index[0]).toMatchObject({
      launchable: true,
      memberLaunch: "ok",
      coordinatorLaunch: "blocked",
    });
    expect(index[1]).toMatchObject({
      launchable: false,
      memberLaunch: "blocked",
      coordinatorLaunch: "ok",
    });
    const v1Index = jsonBlockAt(
      textOf(kickoff({ outputContractVersion: 1, roles })),
      "Role 索引",
    ) as Array<Record<string, unknown>>;
    expect(v1Index[0]).not.toHaveProperty("memberLaunch");
    expect(v1Index[0]).not.toHaveProperty("coordinatorLaunch");
  });

  test("an unknown launch verdict keeps the Role instead of reclassifying the gap", () => {
    // AC-0c.6: missing-role means no Role carries the responsibility; unverified availability
    // is neither that nor a proven unlaunchable Role (AC-0c.14), so the prompt must reuse it.
    const rendered = textOf(
      kickoff({
        outputContractVersion: 2,
        existingRolesOnly: true,
        roles: [
          role(1, {
            launchable: false,
            launchVerified: false,
            coordinatorLaunchable: false,
            coordinatorLaunchVerified: false,
          }),
        ],
      }),
    );
    const index = jsonBlockAt(rendered, "Role 索引") as Array<Record<string, unknown>>;
    expect(index[0]).toMatchObject({
      memberLaunch: "unknown",
      coordinatorLaunch: "unknown",
    });
    expect(rendered).toContain("照常使用该 Role");
    expect(rendered).toContain("只有确实无 Role 承担时才报 missing-role");
    expect(rendered).not.toContain("改报 missing-role");
  });

  test("economy-all v2 renders the route summary and explains the remedy", () => {
    const text = textOf(
      kickoff({
        outputContractVersion: 2,
        existingRolesOnly: true,
        requestedMode: "economy-all",
        modeRouting: ROUTING,
      }),
    );
    expect(text).toContain("## 经济：全席位路由");
    expect(text).toContain("非 Role 绑定");
    expect(text).toContain('"route":"execution"');
    expect(text).toContain('"failedReasons":["unverified","high-cost-family"]');
    expect(text).toContain('"failedIds":["profile-2","profile-3"]');
    const v1 = textOf(kickoff({ outputContractVersion: 1, modeRouting: ROUTING }));
    expect(v1).not.toContain("## 经济：全席位路由");
  });

  test("a missing or invalid cheap policy tells the model not to suggest Profiles", () => {
    for (const modeRouting of [
      { status: "absent" as const },
      { status: "invalid" as const, reason: "unknown-version" },
    ]) {
      const text = textOf(
        kickoff({
          outputContractVersion: 2,
          existingRolesOnly: true,
          requestedMode: "economy-all",
          modeRouting,
        }),
      );
      expect(text).toContain("策略缺失或非法");
      expect(text).toContain("只能 kind:none");
      expect(text).toContain(`"status":"${modeRouting.status}"`);
    }
  });

  test("route summary caps eligible and failed ids", () => {
    const many: DesignModeRouting = {
      status: "ready",
      routes: [
        {
          route: "retain",
          taskKind: null,
          candidates: [
            ...Array.from({ length: 10 }, (_, index) => ({
              profileId: `ok-${index}`,
              family: "deepseek",
              eligible: true,
              reported: false,
            })),
            ...Array.from({ length: 6 }, (_, index) => ({
              profileId: `bad-${index}`,
              family: "grok",
              eligible: false,
              reason: "unverified" as const,
              reported: true,
            })),
          ],
        },
      ],
    };
    const text = textOf(
      kickoff({
        outputContractVersion: 2,
        existingRolesOnly: true,
        requestedMode: "economy-all",
        modeRouting: many,
      }),
    );
    const payload = jsonBlockAt(text, "route 摘要") as {
      routes: Array<Record<string, unknown>>;
    };
    expect(payload.routes[0]).toMatchObject({ failedCount: 6, omittedEligible: 2 });
    expect(payload.routes[0]?.eligible).toHaveLength(8);
    expect(payload.routes[0]?.failedIds).toHaveLength(5);
  });

  function realScaleContext(overrides: Partial<DesignPromptContext> = {}): DesignPromptContext {
    const roles = expectedRoleContent.map((item, index) =>
      role(index, {
        id: item.id,
        name: item.name,
        mission: item.mission,
        responsibilities: item.responsibilities,
      }),
    );
    return context({
      request: "设计一个功能开发团队",
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
      ...overrides,
    });
  }

  test("both switches stay within the 30KiB target, including the 21-Role stress", () => {
    // catalog / economy-all / 21-Role + 6000-char-notes stress; measured 24471/24667,
    // 24941/25137 and 30575/30663 bytes (off/on, all <= 30720; stress-on compressed recipe notes).
    const cases = [
      {},
      { requestedMode: "economy-all" as const, modeRouting: ROUTING },
      { roles: realScaleRoles(), profiles: [profile(1, "说明".repeat(3000))] },
    ] as const;
    for (const overrides of cases) {
      for (const on of [false, true]) {
        const ctx: DesignPromptContext = {
          ...realScaleContext(overrides),
          outputContractVersion: 2,
          existingRolesOnly: on,
        };
        const result = buildDesignKickoff({
          jobId: JOB_ID,
          attempt: 1,
          nonce: NONCE,
          context: ctx,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        expect(result.utf8Bytes).toBe(utf8ByteLength(result.text));
        expect(result.utf8Bytes).toBeLessThanOrEqual(DESIGN_KICKOFF_TARGET_BYTES);
        expect(result.text).toContain(NONCE);
        expect(result.text.match(/identity 必须逐字复制/gu)).toHaveLength(2);
        expect(result.text).toContain("## 字段合同");
        const repaired = buildDesignCorrection({
          jobId: JOB_ID,
          attempt: 2,
          nonce: NONCE,
          issues: [],
          context: ctx,
          expectedChoices: [],
        });
        expect(repaired.ok).toBe(true);
        if (!repaired.ok) continue;
        expect(repaired.utf8Bytes).toBeLessThanOrEqual(DESIGN_CORRECTION_MAX_BYTES);
      }
    }
  });

  test("the 40-Role / 30-Team / 12-Profile economy-all stress fits both switches", () => {
    const roles = [
      ...realScaleRoles(),
      ...Array.from({ length: 19 }, (_, index) =>
        role(100 + index, {
          id: `stress-${index}`,
          name: `【质量】压测审查 ${index}`,
          mission: `负责第 ${index} 类后台模块的迁移评审、风险核对与回归确认，覆盖多实例并行时的共享依赖。`,
          responsibilities: [
            "核对迁移脚本的可回滚性与数据一致性",
            "覆盖并发写入、失败补偿与重试路径",
            "验证多实例席位之间的职责边界",
            "输出可复现的回归证据与残余风险",
            "对高风险改动提出阻断或降级建议",
            "维护本领域的验收清单",
          ],
        }),
      ),
    ];
    expect(roles).toHaveLength(40);
    const teams = Array.from({ length: 30 }, (_, index) => ({
      id: `team-${index}`,
      name: `已有 Team ${index}`,
    }));
    const profiles = Array.from({ length: 12 }, (_, index) => profile(index, "说明".repeat(80)));
    for (const on of [false, true]) {
      const ctx: DesignPromptContext = {
        ...realScaleContext({
          requestedMode: "economy-all",
          modeRouting: ROUTING,
          roles,
          profiles,
          occupiedTeams: teams,
          occupiedRoleIds: roles.map((item) => item.id),
          occupiedRoleNames: roles.map((item) => item.name),
        }),
        outputContractVersion: 2,
        existingRolesOnly: on,
      };
      const result = buildDesignKickoff({
        jobId: JOB_ID,
        attempt: 1,
        nonce: NONCE,
        context: ctx,
      });
      expect(result.ok, `on=${on}`).toBe(true);
      if (!result.ok) continue;
      expect(result.utf8Bytes, `on=${on} bytes=${result.utf8Bytes}`).toBeLessThanOrEqual(
        DESIGN_KICKOFF_TARGET_BYTES,
      );
      expect(result.text).toContain(NONCE);
      expect(result.text.match(/identity 必须逐字复制/gu)).toHaveLength(2);
      expect(result.text).toContain("## 字段合同");
      if (!on) expect(result.text).toContain("noveltyReason 1–600");
      expect(result.text).toContain('"profileChoices"');
      expect(result.text).toContain(`"id":"stress-18"`);
      const index = jsonBlockAt(result.text, "Role 索引") as unknown[];
      expect(index).toHaveLength(40);
      expect(result.text).not.toContain("## Role 摘要");
    }
  });

  test("the DEV catalog snapshot (27 Roles / 22 Teams) fits both switches", () => {
    const { roles, teams } = devCatalog();
    expect(roles).toHaveLength(27);
    expect(teams).toHaveLength(22);
    for (const on of [false, true]) {
      const result = buildDesignKickoff({
        jobId: JOB_ID,
        attempt: 1,
        nonce: NONCE,
        context: context({
          outputContractVersion: 2,
          existingRolesOnly: on,
          requestedMode: "economy-all",
          modeRouting: ROUTING,
          roles,
          occupiedTeams: teams,
          occupiedRoleIds: roles.map((item) => item.id),
          occupiedRoleNames: roles.map((item) => item.name),
          profiles: [profile(1, "DEV Haiku"), profile(2, "DEV Luna"), profile(3)],
        }),
      });
      expect(result.ok, `on=${on}`).toBe(true);
      if (!result.ok) continue;
      expect(result.utf8Bytes, `on=${on} bytes=${result.utf8Bytes}`).toBeLessThanOrEqual(
        DESIGN_KICKOFF_TARGET_BYTES,
      );
      expect(result.text).toContain(NONCE);
      expect(jsonBlockAt(result.text, "Role 索引")).toHaveLength(27);
    }
  });

  test("the DEV catalog with five disabled Roles still fits at full detail", () => {
    const { roles, teams } = devCatalog();
    const disabled = new Set([
      "eng-frontend",
      "eng-batch",
      "content-technical",
      "research-web",
      "qa-acceptance",
    ]);
    const mutated = roles.map((entry) =>
      disabled.has(entry.id) ? { ...entry, enabled: false } : entry,
    );
    const result = buildDesignKickoff({
      jobId: JOB_ID,
      attempt: 1,
      nonce: NONCE,
      context: context({
        outputContractVersion: 2,
        existingRolesOnly: false,
        requestedMode: "economy-all",
        modeRouting: ROUTING,
        roles: mutated,
        occupiedTeams: teams,
        occupiedRoleIds: mutated.map((entry) => entry.id),
        occupiedRoleNames: mutated.map((entry) => entry.name),
        profiles: [profile(1, "DEV Haiku"), profile(2, "DEV Luna"), profile(3)],
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compression).toBe("full");
    expect(result.utf8Bytes, `bytes=${result.utf8Bytes}`).toBeLessThanOrEqual(
      DESIGN_KICKOFF_TARGET_BYTES,
    );
    const index = roleEntries(result.text);
    for (const id of disabled) {
      const entry = index.find((item) => item.id === id);
      expect(entry).toEqual({ id, name: entry?.name, enabled: false });
    }
  });

  test("v2 entries keep taskKind and expose disabled/blocked states", () => {
    const roles = [
      role(0, { id: "ops-role", taskKind: "ops" }),
      role(1, { id: "off-role", enabled: false }),
      role(2, {
        id: "blocked-role",
        launchable: false,
        launchVerified: true,
        coordinatorLaunchable: false,
        coordinatorLaunchVerified: true,
        unavailableProfileIds: ["missing-profile"],
      }),
    ];
    const text = textOf(kickoff({ outputContractVersion: 2, existingRolesOnly: false, roles }));
    const index = roleEntries(text);
    expect(index[0]).toMatchObject({ taskKind: "ops" });
    expect(index[0]).toHaveProperty("mission");
    expect(index[1]).toMatchObject({ id: "off-role", enabled: false });
    expect(index[1]).not.toHaveProperty("memberLaunch");
    expect(index[1]).not.toHaveProperty("coordinatorLaunch");
    expect(index[1]).not.toHaveProperty("mission");
    expect(index[2]).toMatchObject({
      id: "blocked-role",
      memberLaunch: "blocked",
      coordinatorLaunch: "blocked",
      unavailableProfileIds: ["missing-profile"],
    });
    expect(index[2]).not.toHaveProperty("mission");
    expect(text).toContain("条目形态");
    expect(text).toContain("enabled:false 表示停用");
    expect(text).toContain("unlaunchable-role");
  });

  test("a request-matched custom Role wins a summary slot over recipes", () => {
    const custom = [
      ["custom-front", "前端组件", "实现前端界面与交互"],
      ["custom-test", "测试自动化", "编写并执行测试用例"],
      ["custom-data", "数据迁移", "设计迁移脚本"],
      ["custom-security", "安全审计", "检查安全风险"],
      ["custom-docs", "技术写作", "撰写技术文档"],
      ["custom-ops", "发布运维", "执行发布与回滚"],
      ["custom-research", "技术调研", "调研技术选型"],
      ["custom-content", "内容策划", "策划内容素材"],
      ["custom-design", "视觉设计", "制作视觉稿"],
      ["custom-api", "API 设计", "维护接口合同"],
      ["custom-perf", "性能优化", "分析性能瓶颈"],
      ["custom-infra", "基础设施", "维护部署环境"],
      ["custom-review", "代码审查", "审查代码改动"],
      ["custom-qa", "验收", "组织验收"],
      ["custom-i18n", "国际化", "维护多语言"],
    ] as const;
    const roles = [
      ...custom.map(([id, name, mission], index) => role(index, { id, name, mission })),
      ...Array.from({ length: 30 }, (_, index) =>
        role(100 + index, {
          id: `filler-${index}`,
          name: `填充角色 ${index}`,
          mission: "负责功能开发团队需要的实现工作与内容输出，覆盖相关任务。".repeat(8),
          responsibilities: Array.from({ length: 6 }, () =>
            "实现功能开发内容，完成团队任务并输出相关材料。".repeat(3),
          ),
        }),
      ),
    ];
    const text = textOf(
      kickoff({
        outputContractVersion: 2,
        existingRolesOnly: false,
        request: "设计一个功能开发团队，需要前端和测试",
        roles,
        profiles: Array.from({ length: 12 }, (_, index) => profile(index, "说明".repeat(80))),
        occupiedTeams: Array.from({ length: 30 }, (_, index) => ({
          id: `team-${index}`,
          name: `Team ${index}`,
        })),
      }),
    );
    const index = roleEntries(text);
    const byId = new Map(index.map((entry) => [String(entry.id), entry]));
    expect(byId.get("custom-front")).toHaveProperty("mission");
    expect(byId.get("custom-test")).toHaveProperty("mission");
    expect(byId.get("filler-0")).not.toHaveProperty("mission");
    expect(utf8ByteLength(text)).toBeLessThanOrEqual(DESIGN_KICKOFF_TARGET_BYTES);
  });

  test("four requests against the DEV catalog select different Role summaries", () => {
    const { roles, teams } = devCatalog();
    const requests = [
      ["安全加固与迁移审计", "qa-security"],
      ["前端界面改版", "eng-frontend"],
      ["测试用例与回归", "qa-test"],
      ["技术白皮书写作", "content-technical"],
    ] as const;
    const selected = new Set<string>();
    for (const [request, expected] of requests) {
      const result = buildDesignKickoff({
        jobId: JOB_ID,
        attempt: 1,
        nonce: NONCE,
        context: context({
          outputContractVersion: 2,
          existingRolesOnly: false,
          request,
          requestedMode: "economy-all",
          modeRouting: ROUTING,
          roles,
          occupiedTeams: teams,
          profiles: [profile(1), profile(2), profile(3)],
        }),
      });
      expect(result.ok, request).toBe(true);
      if (!result.ok) continue;
      expect(result.utf8Bytes, request).toBeLessThanOrEqual(DESIGN_KICKOFF_TARGET_BYTES);
      const index = roleEntries(result.text);
      const target = index.find((entry) => entry.id === expected);
      expect(target, request).toHaveProperty("mission");
      expect(target, request).toHaveProperty("responsibilities");
      selected.add(
        index
          .filter((entry) => "mission" in entry)
          .map((entry) => String(entry.id))
          .join(","),
      );
    }
    expect(selected.size).toBeGreaterThan(1);
  });

  test("ASCII template words do not steal summary slots from qa-security", () => {
    const { roles, teams } = devCatalog();
    const result = buildDesignKickoff({
      jobId: JOB_ID,
      attempt: 1,
      nonce: NONCE,
      context: context({
        outputContractVersion: 2,
        existingRolesOnly: false,
        request: "新增一个 Role 负责安全审计",
        roles,
        occupiedTeams: teams,
        profiles: [profile(1), profile(2), profile(3)],
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const index = roleEntries(result.text);
    expect(index.find((entry) => entry.id === "qa-security")).toHaveProperty("mission");
    for (const id of ["t02-coord", "v01b-unbound", "v01b-provider-down"]) {
      expect(
        index.find((entry) => entry.id === id),
        id,
      ).not.toHaveProperty("mission");
    }
  });

  test("the index-only 6 and minimal tiers are reachable and used", () => {
    const base = Array.from({ length: 15 }, (_, index) =>
      role(index, {
        id: `custom-${index}`,
        name: `自定义领域 Role ${index}`,
        mission: `负责第 ${index} 类领域工作，覆盖安全、迁移、前端、测试与文档。`,
        responsibilities: ["输出领域方案", "完成实现与验证"],
      }),
    );
    const seen = new Set<string>();
    for (const fillers of [100, 110, 120, 130, 140, 150, 160]) {
      const roles = [
        ...base,
        ...Array.from({ length: fillers }, (_, index) =>
          role(1000 + index, {
            id: `filler-${index}`,
            name: `填充 Role ${index}`,
            mission: "负责功能开发团队需要的实现工作与内容输出，覆盖相关任务。".repeat(8),
            responsibilities: Array.from({ length: 6 }, () =>
              "实现功能开发内容，完成团队任务并输出相关材料。".repeat(3),
            ),
          }),
        ),
      ];
      const result = buildDesignKickoff({
        jobId: JOB_ID,
        attempt: 1,
        nonce: NONCE,
        context: context({
          outputContractVersion: 2,
          existingRolesOnly: false,
          request: "设计一个功能开发团队，需要安全审计与迁移",
          roles,
          occupiedTeams: Array.from({ length: 30 }, (_, index) => ({
            id: `team-${index}`,
            name: `Team ${index}`,
          })),
          profiles: Array.from({ length: 12 }, (_, index) => profile(index, "说明".repeat(80))),
        }),
      });
      if (!result.ok) continue;
      expect(result.utf8Bytes).toBeLessThanOrEqual(DESIGN_KICKOFF_TARGET_BYTES);
      if (
        result.compression === "recipes-compact" ||
        result.compression === "index-only-6" ||
        result.compression === "index-only-minimal"
      ) {
        expect(result.text).toContain('"minInstances":2,"maxInstances":3');
      }
      seen.add(result.compression);
    }
    expect(seen).toContain("index-only-6");
    expect(seen).toContain("index-only-minimal");
  });

  test("the 45-Role synthetic directory stays under budget for four requests", () => {
    const roles = [
      ...Array.from({ length: 15 }, (_, index) =>
        role(index, {
          id: `custom-${index}`,
          name: `自定义领域 Role ${index}`,
          mission: `负责第 ${index} 类领域工作，覆盖前端、测试、迁移、安全或文档等职责。`,
          responsibilities: ["输出领域方案", "完成实现与验证"],
        }),
      ),
      ...Array.from({ length: 30 }, (_, index) =>
        role(100 + index, {
          id: `filler-${index}`,
          name: `填充 Role ${index}`,
          mission: "负责功能开发团队需要的实现工作与内容输出，覆盖相关任务。",
          responsibilities: ["实现功能开发内容", "完成团队任务"],
        }),
      ),
    ];
    const requests = ["前端", "只做前端改版", "需要测试", "设计一个功能开发团队，需要前端和测试"];
    for (const request of requests) {
      const result = buildDesignKickoff({
        jobId: JOB_ID,
        attempt: 1,
        nonce: NONCE,
        context: context({
          outputContractVersion: 2,
          existingRolesOnly: false,
          request,
          requestedMode: "economy-all",
          modeRouting: ROUTING,
          roles,
          occupiedTeams: Array.from({ length: 30 }, (_, index) => ({
            id: `team-${index}`,
            name: `Team ${index}`,
          })),
          profiles: Array.from({ length: 12 }, (_, index) => profile(index, "说明".repeat(80))),
        }),
      });
      expect(result.ok, request).toBe(true);
      if (!result.ok) continue;
      expect(result.utf8Bytes, request).toBeLessThanOrEqual(DESIGN_KICKOFF_TARGET_BYTES);
    }
  });

  test("a v2 kickoff that cannot reach 30KiB fails instead of being sent", () => {
    const roles = Array.from({ length: 700 }, (_, index) =>
      role(index, {
        id: `role-${index}`,
        name: `角色${index}`,
        mission: "任".repeat(2000),
        responsibilities: ["责".repeat(300)],
      }),
    );
    const base = context({
      outputContractVersion: 2,
      existingRolesOnly: false,
      roles,
      profiles: [profile(1, "说明".repeat(3000))],
    });
    const result = buildDesignKickoff({ jobId: JOB_ID, attempt: 1, nonce: NONCE, context: base });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]).toMatchObject({
      code: "DESIGN_INPUT_TOO_LARGE",
      params: { limit: DESIGN_KICKOFF_TARGET_BYTES },
    });
    // The same input under the legacy contract keeps its historical 60KiB escape.
    const legacy = buildDesignKickoff({
      jobId: JOB_ID,
      attempt: 1,
      nonce: NONCE,
      context: {
        ...base,
        outputContractVersion: 1,
        roles: roles.slice(0, 40),
      },
    });
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;
    expect(legacy.utf8Bytes).toBeLessThanOrEqual(DESIGN_KICKOFF_MAX_BYTES);
  });
});

describe("designer prompt budgets", () => {
  test("keeps the system prompt and default hints inside their contracts", () => {
    expect(utf8ByteLength(DESIGNER_SYSTEM_PROMPT)).toBeLessThanOrEqual(
      DESIGN_SYSTEM_PROMPT_MAX_BYTES,
    );
    expect(DESIGNER_PROFILE_HINTS.map((hint) => hint.name)).toEqual(HINTS.map((hint) => hint.name));
    expect(DESIGNER_PROFILE_HINTS).toEqual(HINTS);
    const fixture = sourceProfiles;
    for (const hint of DESIGNER_PROFILE_HINTS) {
      const source = fixture.find((item) => item.name === hint.name);
      expect(source).toMatchObject(hint);
    }
    expect(JSON.stringify(DESIGNER_PROFILE_HINTS)).not.toContain("agent_profile_");
    const bound = bindDesignerProfile(sourceProfiles);
    expect(bound.preferredProfiles.map((profile) => profile.nameSnapshot)).toEqual(
      HINTS.map((hint) => hint.name),
    );
    expect(bound.bindingReport.every((entry) => entry.method === "exact")).toBe(true);
    const summarized = summarizeProfiles(
      [
        {
          id: "profile-1",
          name: "Profile",
          provider: "claude",
          model: "m",
          notes: "说明",
          featureValues: { secret: true },
        },
      ],
      [{ provider: "claude", available: true }],
      {
        pool: [{ profileId: "profile-1", family: "claude", enabled: true }],
        taskOrder: {},
        profileBudget: { "profile-1": "sota" },
      },
    );
    expect(summarized).toEqual([
      {
        id: "profile-1",
        name: "Profile",
        provider: "claude",
        model: "m",
        modeId: undefined,
        thinkingOptionId: undefined,
        available: true,
        notes: "说明",
        family: "claude",
        budget: "sota",
        budgetBasis: "host",
      },
    ]);
    expect(summarized[0]).not.toHaveProperty("featureValues");
  });

  test("puts mode, nonce, target limits, and recipe notes into the kickoff", () => {
    const result = kickoff();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.utf8Bytes).toBe(utf8ByteLength(result.text));
    expect(result.utf8Bytes).toBeLessThanOrEqual(DESIGN_KICKOFF_TARGET_BYTES);
    expect(result.omissions).toEqual([]);
    expect(result.text).toContain(`"requestedMode":"economy"`);
    expect(result.text).toContain(`"mode":"economy"`);
    expect(result.text).toContain(NONCE);
    expect(result.text).toContain("workspace-target");
    expect(result.text).toContain("不得修改文件");
    expect(result.text).not.toContain("workspace-carrier-secret");
    expect(result.text).toContain("批量开发 ×2–3，用实例标签区分，如 A / B");
    expect(result.text).toContain("agent-team-design");
  });

  test("forbids the carrier when no target was selected", () => {
    const text = textOf(kickoff({ target: null }));
    expect(text).toContain("没有目标");
    expect(text).toContain("workspace-carrier");
    expect(text).toContain('"carrierAccess":"forbidden"');
  });

  test("marks Roles that cannot launch and explains the required index", () => {
    const blocked = role(2, {
      launchable: false,
      unavailableProfileIds: ["profile-9", "profile-10"],
    });
    const text = textOf(
      kickoff({
        roles: [role(1), blocked],
        occupiedRoleIds: ["role-1", "role-2"],
        occupiedRoleNames: ["角色1", "角色2"],
      }),
    );
    expect(text).toContain('"launchable":true');
    expect(text).toContain('"launchable":false');
    expect(text).toContain('"unavailableProfileIds":["profile-9","profile-10"]');
    expect(text).toContain("优先复用 launchable=true 的 Role");
    expect(text).toContain("只使用 Profile 白名单中 available=true 的 Profile");
  });

  test("keeps launchability in a real-sized kickoff after compression", () => {
    // The presets plus eight custom Roles: the slim catalog alone
    // fits without compression.
    const catalog = [
      ...expectedRoleContent,
      ...expectedRoleContent.slice(0, 8).map((item) => ({ ...item, id: `${item.id}-custom` })),
    ];
    const roles = catalog.map((item, index) =>
      role(index, {
        id: item.id,
        name: item.name,
        mission: item.mission,
        responsibilities: item.responsibilities,
        launchable: index !== 0,
        unavailableProfileIds: index === 0 ? ["profile-missing"] : [],
      }),
    );
    const result = kickoff({
      request: "设计一个功能开发团队",
      roles,
      profiles: [profile(1, "说明".repeat(3000))],
      occupiedRoleIds: roles.map((item) => item.id),
      occupiedRoleNames: roles.map((item) => item.name),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.utf8Bytes).toBeLessThanOrEqual(DESIGN_KICKOFF_TARGET_BYTES);
    expect(result.omissions.length).toBeGreaterThan(0);
    expect(result.text).toContain('"launchable":false');
    expect(result.text).toContain('"unavailableProfileIds":["profile-missing"]');
    expect(result.text).toContain('"id":"lead-orchestrator"');
  });

  test("compresses notes, role text, recipe notes, then unrelated role prose", () => {
    const notes = "说明".repeat(3000);
    const notesOnly = kickoff({
      request: "填充".repeat(3000),
      roles: [
        role(0, {
          mission: "使命".repeat(300),
          responsibilities: Array.from({ length: 12 }, () => "职责".repeat(80)),
        }),
      ],
      profiles: [profile(1, notes)],
    });
    expect(notesOnly.ok).toBe(true);
    if (!notesOnly.ok) return;
    expect(notesOnly.omissions).toEqual(["profile-notes", "role-mission", "role-responsibilities"]);
    expect(notesOnly.utf8Bytes).toBeLessThanOrEqual(DESIGN_KICKOFF_TARGET_BYTES);

    const clamped = kickoff({
      request: "填充".repeat(2500),
      roles: [
        role(0, {
          mission: "使命".repeat(300),
          responsibilities: Array.from({ length: 12 }, () => "职责".repeat(80)),
        }),
      ],
      profiles: [profile(1, notes)],
    });
    expect(clamped.ok).toBe(true);
    if (!clamped.ok) return;
    expect(clamped.omissions).toEqual(["profile-notes", "role-mission", "role-responsibilities"]);
    expect(clamped.text).toContain("批量开发 ×2–3");
    expect(clamped.text).not.toContain("使命".repeat(300));

    const roles = [
      role(0, { mission: "相关使命", responsibilities: ["相关职责"] }),
      ...Array.from({ length: 8 }, (_, index) =>
        role(index + 1, {
          mission: "无关使命".repeat(20),
          responsibilities: Array.from({ length: 4 }, () => "无关职责".repeat(20)),
        }),
      ),
    ];
    const focused = kickoff({
      request: "填充".repeat(8000),
      roles,
      profiles: [profile(1, notes)],
      occupiedRoleIds: roles.map((item) => item.id),
      occupiedRoleNames: roles.map((item) => item.name),
      relevantRoleIds: ["role-0"],
    });
    expect(focused.ok).toBe(true);
    if (!focused.ok) return;
    expect(focused.omissions).toEqual([
      "profile-notes",
      "recipe-notes",
      "unrelated-role-details:8",
    ]);
    expect(focused.text).not.toContain("批量开发 ×2–3");
    expect(focused.text).toContain("相关使命");
    expect(focused.text).not.toContain("无关使命无关");
    for (const item of roles) expect(focused.text).toContain(`"id":"${item.id}"`);
  });

  test("fails closed when the required index itself exceeds 60KiB", () => {
    const roles = Array.from({ length: 700 }, (_, index) =>
      role(index, {
        id: `occupied-role-${"x".repeat(40)}-${index}`,
        name: "名称".repeat(20),
        mission: "短",
        responsibilities: ["短"],
      }),
    );
    const result = kickoff({
      roles,
      profiles: [profile(1)],
      occupiedRoleIds: roles.map((item) => item.id),
      occupiedRoleNames: roles.map((item) => item.name),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      {
        code: "DESIGN_INPUT_TOO_LARGE",
        severity: "error",
        path: [],
        params: {
          bytes: expect.any(Number),
          limit: DESIGN_KICKOFF_MAX_BYTES,
          roles: 700,
          teams: 1,
        },
        action: "none",
      },
    ]);
    const bytes = result.issues[0]?.params.bytes;
    expect(typeof bytes).toBe("number");
    expect(bytes).toBeGreaterThan(DESIGN_KICKOFF_MAX_BYTES);
  });

  test("correction carries the first twenty issues and exact expected profiles", () => {
    const issues: DesignIssue[] = Array.from({ length: 23 }, (_, index) => ({
      code: "DESIGN_PROFILE_CHOICE",
      severity: "error",
      path: ["profileChoices", index],
      params: { target: index === 0 ? "coordinator" : `m${index}` },
      action: "repair",
    }));
    const result = buildDesignCorrection({
      jobId: JOB_ID,
      attempt: 2,
      nonce: NONCE,
      issues,
      context: context(),
      expectedChoices: [
        {
          target: "m1",
          roleId: "eng-fullstack",
          expectedProfileIds: ["profile-2", "profile-3"],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.utf8Bytes).toBeLessThanOrEqual(DESIGN_CORRECTION_MAX_BYTES);
    expect(result.text).toContain('"omittedIssueCount":3');
    expect(result.text).toContain('"target":"m1"');
    expect(result.text).toContain('"expectedProfileIds":["profile-2","profile-3"]');
    expect(result.text).toContain(`"attempt":2`);
    expect(result.text.match(/DESIGN_PROFILE_CHOICE/gu)?.length).toBe(20);
  });

  test("correction ignores a huge context index instead of failing on it", () => {
    const roles = Array.from({ length: 500 }, (_, index) =>
      role(index, { id: `role-${"y".repeat(40)}-${index}`, name: "名称".repeat(20) }),
    );
    const result = buildDesignCorrection({
      jobId: JOB_ID,
      attempt: 3,
      nonce: NONCE,
      issues: [
        {
          code: "DESIGN_PROFILE_CHOICE",
          severity: "error",
          path: ["profileChoices", 0],
          params: { target: "coordinator" },
          action: "repair",
        },
      ],
      context: context({
        roles,
        profiles: [profile(1)],
        occupiedRoleIds: roles.map((item) => item.id),
      }),
      expectedChoices: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.utf8Bytes).toBeLessThanOrEqual(DESIGN_CORRECTION_MAX_BYTES);
    expect(result.text).not.toContain("## Role 索引");
    expect(result.text).not.toContain(roles[0]?.mission ?? "missing");
  });

  test("realistic correction stays inside 24KiB without repeating context", () => {
    const roles = expectedRoleContent.map((item, index) =>
      role(index, {
        id: item.id,
        name: item.name,
        mission: item.mission,
        responsibilities: item.responsibilities,
      }),
    );
    const realistic = context({
      roles,
      profiles: [profile(1)],
      occupiedRoleIds: roles.map((item) => item.id),
      occupiedRoleNames: roles.map((item) => item.name),
      expectedChoices: [],
    });
    const result = buildDesignCorrection({
      jobId: JOB_ID,
      attempt: 2,
      nonce: NONCE,
      issues: [
        {
          code: "DESIGN_OUTPUT_IDENTITY",
          severity: "error",
          path: ["nonce"],
          params: { field: "nonce" },
          action: "repair",
        },
      ],
      context: realistic,
      expectedChoices: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.utf8Bytes).toBeLessThanOrEqual(DESIGN_CORRECTION_MAX_BYTES);
    expect(result.text).toContain(NONCE);
    expect(result.text.match(/identity 必须逐字复制/gu)?.length).toBe(2);
    for (const heading of ["## Role 索引", "## Role 摘要", "## Profile 白名单", "## 九配方"]) {
      expect(result.text).not.toContain(heading);
    }
    expect(result.text).not.toContain(realistic.roles[0]?.mission ?? "missing");
    expect(result.text).not.toContain(realistic.profiles[0]?.name ?? "missing");
    expect(result.text).toContain("## 输出合同");
    for (const field of [
      "required",
      "optional",
      "newRole",
      "profileChoice",
      "limits",
      "forbidden",
      "preferredProfiles",
      "executionPolicy",
      "collaboration",
      "32768",
    ]) {
      expect(result.text).toContain(field);
    }
  });

  test("kickoff repeats the exact identity requirement at both ends", () => {
    const text = textOf(kickoff());
    expect(text.startsWith("## 身份\n")).toBe(true);
    expect(text).toContain("## 身份复核");
    expect(text.match(/identity 必须逐字复制/gu)?.length).toBe(2);
    expect(text).toContain(`nonce=${NONCE}`);
  });

  test("never copies machine profile ids, env, or credentials into prompt material", () => {
    const built = textOf(
      kickoff({
        request: "设计一个只读调研团队",
        profiles: [profile(1, "公开说明")],
      }),
    );
    const recipeSource = readFileSync(
      join(import.meta.dirname, "../server/templates/recipes.ts"),
      "utf8",
    );
    const definitionSource = readFileSync(
      join(import.meta.dirname, "../server/designer/definition.ts"),
      "utf8",
    );
    const promptSource = readFileSync(
      join(import.meta.dirname, "../server/designer/prompt.ts"),
      "utf8",
    );
    expect(recipeSource).not.toContain("agent_profile_");
    expect(definitionSource).not.toContain("agent_profile_");
    expect(promptSource).not.toContain("agent_profile_");
    expect(`${recipeSource}\n${definitionSource}\n${promptSource}`).not.toMatch(
      /PASEO_HOME|process\.env|TOKEN=/u,
    );
    expect(built).not.toContain("agent_profile_");
    expect(JSON.stringify(TEAM_DESIGN_RECIPES)).not.toContain("agent_profile_");
  });

  test("filters non-string array elements and non-scalar issue params", () => {
    const marker = "OBJECT_ELEMENT_SENTINEL";
    const markedRole = role(1, {
      responsibilities: ["职责", { leak: marker }] as never,
      preferredProfileIds: ["profile-1", { leak: marker }] as never,
      fallbackProfileIds: [{ leak: marker }] as never,
    });
    const text = textOf(
      kickoff({
        roles: [markedRole],
        occupiedRoleIds: ["role-1", { leak: marker }] as never,
        occupiedRoleNames: ["角色1", { leak: marker }] as never,
        expectedChoices: [
          {
            target: "coordinator",
            roleId: "role-1",
            expectedProfileIds: ["profile-1", { leak: marker }] as never,
          },
        ],
      }),
    );
    expect(text).not.toContain(marker);
    expect(text).toContain('"occupiedRoleIds":["role-1"]');
    expect(text).toContain('"occupiedRoleNames":["角色1"]');
    expect(text).toContain('"preferredProfileIds":["profile-1"]');
    expect(text).toContain('"expectedProfileIds":["profile-1"]');

    const correction = buildDesignCorrection({
      jobId: JOB_ID,
      attempt: 2,
      nonce: NONCE,
      issues: [
        {
          code: "DESIGN_PROFILE_CHOICE",
          severity: "error",
          path: ["profileChoices", 0],
          params: { target: "coordinator", received: { secret: marker } } as never,
          action: "repair",
        },
      ],
      context: context(),
      expectedChoices: [
        { target: "coordinator", roleId: "role-1", expectedProfileIds: ["profile-1"] },
      ],
    });
    const repaired = textOf(correction);
    expect(repaired).not.toContain(marker);
    expect(repaired).toContain('"target":"coordinator"');
  });

  test("keeps a schema-valid new-role contract in full and compressed kickoffs", () => {
    const fence = /```agent-team-design\n([\s\S]*?)\n```/u;
    const prompts = [
      textOf(kickoff()),
      textOf(
        kickoff({ profiles: [profile(1, "说明".repeat(3000))], request: "填充".repeat(7700) }),
      ),
    ];
    for (const text of prompts) {
      expect(text).toContain(JOB_ID);
      expect(text).toContain(NONCE);
      expect(text).toContain("32768");
      expect(text).toContain("preferredProfiles");
      expect(text).toContain("executionPolicy");
      expect(text).toContain("collaboration");
      const sample = JSON.parse(fence.exec(text)?.[1] ?? "{}") as {
        team: {
          mode: string;
          members: { roleId: string }[];
          collaboration?: { judgeRoleId?: string };
        };
        reuse: { roleId: string }[];
        profileChoices: { target: string }[];
      };
      expect(DesignProposalSchema.safeParse(sample).success).toBe(true);
      expect(sample.team.mode).toBe("economy");
      const sampledRoles = new Set([
        ...sample.team.members.map((member) => member.roleId),
        ...sample.reuse.map((entry) => entry.roleId),
      ]);
      expect(sampledRoles.has(sample.team.collaboration?.judgeRoleId ?? "")).toBe(true);
      expect(sample.profileChoices.map((choice) => choice.target)).toEqual([
        "coordinator",
        "m1",
        "m2",
      ]);
      const broken = structuredClone(sample) as unknown as {
        newRoles: Record<string, unknown>[];
      };
      delete broken.newRoles[0]?.mission;
      expect(DesignProposalSchema.safeParse(broken).success).toBe(false);
    }
  });

  test("projects nested objects and keeps injected notes as data", () => {
    const marked = kickoff({
      request: "需求提到 TOKEN=NOTE_DATA",
      profiles: [profile(1, "notes TOKEN=NOTE_DATA")],
      runtimeCapabilities: {
        onDemand: true,
        expansion: false,
        collaboration: false,
        env: { TOKEN: "ENV_SENTINEL" },
      } as never,
      economy: {
        pool: [
          {
            profileId: "profile-1",
            family: "claude",
            enabled: true,
            env: { TOKEN: "POOL_SENTINEL" },
          } as never,
        ],
        taskOrder: { coding: ["profile-1"], secret: ["TOKEN_SENTINEL"] } as never,
      },
      occupiedTeams: [
        { id: "team-1", name: "已有团队", config: { apiKey: "CONFIG_SENTINEL" } } as never,
      ],
      expectedChoices: [
        {
          target: "coordinator",
          roleId: "role-1",
          expectedProfileIds: ["profile-1"],
          featureValues: { private: "CHOICE_SECRET_SENTINEL" },
        } as never,
      ],
    });
    const text = textOf(marked);
    expect(text).toContain("profile-1");
    expect(text).toContain("已有团队");
    expect(text).toContain(JSON.stringify("需求提到 TOKEN=NOTE_DATA"));
    expect(text).toContain(JSON.stringify("notes TOKEN=NOTE_DATA"));
    for (const marker of [
      "ENV_SENTINEL",
      "POOL_SENTINEL",
      "TOKEN_SENTINEL",
      "CONFIG_SENTINEL",
      "CHOICE_SECRET_SENTINEL",
    ]) {
      expect(text).not.toContain(marker);
    }
    const correction = buildDesignCorrection({
      jobId: JOB_ID,
      attempt: 2,
      nonce: NONCE,
      issues: [],
      context: context(),
      expectedChoices: [
        {
          target: "m1",
          roleId: "role-1",
          expectedProfileIds: ["profile-1"],
          token: "CORRECTION_SENTINEL",
        } as never,
      ],
    });
    const repaired = textOf(correction);
    expect(repaired).not.toContain("CORRECTION_SENTINEL");
    expect(repaired.match(/"expectedProfileIds":\["profile-1"\]/gu)?.length).toBe(1);
  });

  test("accepts a fully compressed 30–60KiB kickoff after every step", () => {
    const roles = Array.from({ length: 50 }, (_, index) =>
      role(index, {
        name: `角色${index}${"名".repeat(20)}`,
        mission: index < 2 ? "任".repeat(2000) : `岗位${index}`,
        responsibilities: [
          ...Array.from({ length: 6 }, () => "责".repeat(22)),
          ...(index === 0 ? ["长".repeat(81)] : []),
        ],
      }),
    );
    const result = kickoff({
      roles,
      profiles: [profile(1, "说明".repeat(3000))],
      occupiedRoleIds: roles.map((item) => item.id),
      occupiedRoleNames: roles.map((item) => item.name),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.utf8Bytes).toBeGreaterThan(DESIGN_KICKOFF_TARGET_BYTES);
    expect(result.utf8Bytes).toBeLessThanOrEqual(DESIGN_KICKOFF_MAX_BYTES);
    expect(result.omissions).toEqual([
      "profile-notes",
      "role-mission",
      "role-responsibilities",
      "recipe-notes",
    ]);
    expect(result.text).not.toContain("任".repeat(2000));
    expect(result.text).toContain("任".repeat(200));
    expect(result.text).not.toContain("批量开发 ×2–3");
  });

  test("compresses a valid request toward 30KiB and still accepts the hard cap", () => {
    const aimed = kickoff({
      roles: Array.from({ length: 5 }, (_, index) =>
        role(index, { mission: "使命".repeat(1000), responsibilities: ["职责"] }),
      ),
      profiles: Array.from({ length: 5 }, (_, index) => profile(index, "说明".repeat(300))),
    });
    expect(aimed.ok).toBe(true);
    if (!aimed.ok) return;
    expect(aimed.utf8Bytes).toBeLessThanOrEqual(DESIGN_KICKOFF_TARGET_BYTES);
    expect(aimed.omissions).toEqual(["profile-notes", "role-mission"]);
    const oversized = kickoff({
      roles: Array.from({ length: 700 }, (_, index) =>
        role(index, {
          id: `occupied-role-${"z".repeat(40)}-${index}`,
          name: "名称".repeat(20),
          mission: "短",
          responsibilities: ["短"],
        }),
      ),
      occupiedRoleIds: Array.from(
        { length: 700 },
        (_, index) => `occupied-role-${"z".repeat(40)}-${index}`,
      ),
    });
    expect(oversized.ok).toBe(false);
  });
});

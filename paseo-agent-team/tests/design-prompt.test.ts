import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
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
import { sourceProfiles } from "./default-presets.fixtures";

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
    members: ["qa-security", "qa-acceptance", "eng-ops"],
  },
  {
    id: "technical-research",
    name: "技术调研",
    coordinatorRoleId: "lead-research",
    members: ["research-web", "research-codebase", "research-docs"],
  },
  {
    id: "materials",
    name: "资料与截图研读",
    coordinatorRoleId: "lead-research",
    members: ["research-docs", "research-vision"],
  },
  {
    id: "creative-content",
    name: "文案、脚本、视频文案",
    coordinatorRoleId: "lead-content",
    members: ["research-web", "content-creative", "content-editor"],
  },
  {
    id: "technical-writing",
    name: "技术文档",
    coordinatorRoleId: "lead-content",
    members: ["research-codebase", "content-technical", "content-editor"],
  },
  {
    id: "cross-domain",
    name: "跨领域",
    coordinatorRoleId: "lead-orchestrator",
    members: ["research-web", "plan-architect", "eng-fullstack", "qa-review", "content-creative"],
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
    name: "GPT-6-Astra-Max",
    provider: "codex",
    model: "gpt-6-astra",
    modeId: "auto-review",
    thinkingOptionId: "max",
  },
  {
    name: "Claude-Opus-5.5-High",
    provider: "claude",
    model: "claude-opus-5-5",
    modeId: "auto",
    thinkingOptionId: "high",
  },
  {
    name: "Gemini-4-Argon-High｜通用对话",
    provider: "omp",
    model: "cursor/gemini-4-argon",
    modeId: "full",
    thinkingOptionId: "high",
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
      request: "填充".repeat(8000),
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
      request: "填充".repeat(8500),
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
        params: { bytes: expect.any(Number), limit: DESIGN_KICKOFF_MAX_BYTES },
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

  test("correction fails closed instead of dropping the required index", () => {
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
      expectedChoices: [
        { target: "coordinator", roleId: roles[0]?.id ?? "", expectedProfileIds: [] },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe("DESIGN_INPUT_TOO_LARGE");
    expect(result.issues[0]?.params.limit).toBe(DESIGN_CORRECTION_MAX_BYTES);
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

  test("keeps a schema-valid new-role contract at every compression level", () => {
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
      const sample = JSON.parse(fence.exec(text)?.[1] ?? "{}") as Record<string, unknown>;
      expect(DesignProposalSchema.safeParse(sample).success).toBe(true);
      const broken = structuredClone(sample) as { newRoles: Record<string, unknown>[] };
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
    expect(repaired.match(/"expectedProfileIds":\["profile-1"\]/gu)?.length).toBe(2);
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

import { utf8ByteLength } from "../../shared/domain/design-output";
import { designNewRoleLimit } from "../../shared/domain/design-planning";
import type { EconomyBudget, EconomyPolicy } from "../../shared/domain/mode-resolver";
import type {
  PaseoProfile,
  ProviderAvailability,
  WorkspaceSummary,
} from "../../shared/paseo/adapter";
import type {
  DesignChoiceTarget,
  DesignIssue,
  DesignOutputContractVersion,
} from "../../shared/schemas/design";
import type { TeamMode } from "../../shared/schemas/team-mode";
import { TEAM_DESIGN_RECIPES, type TeamDesignRecipe } from "../templates/recipes";
import type { DesignModeRouting } from "./context";

/** Kickoff aims for this and may grow through the hard cap before failing. */
export const DESIGN_KICKOFF_TARGET_BYTES = 30 * 1024;
/** A kickoff past this is DESIGN_INPUT_TOO_LARGE and is never sent. */
export const DESIGN_KICKOFF_MAX_BYTES = 60 * 1024;
/** A correction past this is DESIGN_INPUT_TOO_LARGE (needs_continue); it does not spend a turn. */
export const DESIGN_CORRECTION_MAX_BYTES = 24 * 1024;
export const DESIGN_SYSTEM_PROMPT_MAX_BYTES = 8 * 1024;

const MISSION_CODE_POINTS = 200;
const NOTES_CODE_POINTS = 600;
const RESPONSIBILITY_ITEMS = 6;
const RESPONSIBILITY_CODE_POINTS = 80;
const MAX_CORRECTION_ISSUES = 20;
const NAME_PREFIXES = [
  ["lead-", "【统筹】"],
  ["plan-", "【规划】"],
  ["eng-", "【工程】"],
  ["qa-", "【质量】"],
  ["research-", "【研究】"],
  ["content-", "【内容】"],
] as const;

export type DesignPromptRoleSummary = {
  id: string;
  name: string;
  enabled: boolean;
  mission: string;
  /** Responsibility text only. Never the Role system prompt or its MCP env. */
  responsibilities: readonly string[];
  /** Strict binding order already resolved against live Profiles. */
  preferredProfileIds: readonly string[];
  fallbackProfileIds: readonly string[];
  /** At least one usable Profile in the current mode (execution seats may use the economy pool). */
  launchable: boolean;
  /** Bound Profile ids that are missing or provider-unavailable; bounded for the required index. */
  unavailableProfileIds: readonly string[];
  /**
   * v2 only. The coordinator verdict is a separate planner call: a Role can launch as a member
   * and fail as coordinator. Absent means the server did not supply one; never infer it.
   */
  coordinatorLaunchable?: boolean;
  /** v2 only. False when availability could not be verified, so no gap may be claimed. */
  launchVerified?: boolean;
  coordinatorLaunchVerified?: boolean;
  tier?: string;
  taskKind?: string;
};

export type DesignPromptProfileSummary = {
  id: string;
  name: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  available: boolean;
  /** Catalog notes. featureValues, config, and credentials never belong here. */
  notes?: string;
  family?: string;
  budget?: EconomyBudget;
  budgetBasis?: "host" | "pool" | "conservative-default";
};

export type DesignPromptTeamName = {
  id: string;
  name: string;
};

/**
 * One planner result the model must echo. Existing seats carry the resolved profile ids; a new
 * Role's ids stay empty until validation names the exact expectation on the next round.
 */
export type ExpectedDesignChoice = {
  target: DesignChoiceTarget | string;
  roleId: string;
  expectedProfileIds: readonly string[];
};

export type DesignPromptContext = {
  request: string;
  requestedMode: TeamMode;
  runtimeCapabilities: {
    onDemand: boolean;
    expansion: boolean;
    collaboration: boolean;
  };
  /** Effective physical-member cap, coordinator excluded. */
  maxMembers: number;
  /** The workspace the user chose, or null when there is no business target. */
  target: (Pick<WorkspaceSummary, "id" | "name"> & { path?: string }) | null;
  /** Carrier id only. Its path is never included, and the prompt forbids reading it. */
  carrierWorkspaceId: string | null;
  roles: readonly DesignPromptRoleSummary[];
  profiles: readonly DesignPromptProfileSummary[];
  economy: Pick<EconomyPolicy, "pool" | "taskOrder">;
  occupiedRoleIds: readonly string[];
  occupiedRoleNames: readonly string[];
  occupiedTeams: readonly DesignPromptTeamName[];
  /** Roles whose mission and responsibilities are relevant. Omitted means every Role is relevant. */
  relevantRoleIds?: readonly string[];
  expectedChoices: readonly ExpectedDesignChoice[];
  /**
   * The record's output contract, normalized exactly once by `promptRules`. Omitted means the
   * legacy contract (1); a v2 record without the switch is treated as existing-roles-only.
   */
  outputContractVersion?: DesignOutputContractVersion;
  existingRolesOnly?: boolean;
  /** economy-all route evidence; copied from the context snapshot, never recomputed here. */
  modeRouting?: DesignModeRouting;
};

export type DesignPromptInput = {
  jobId: string;
  attempt: 1 | 2 | 3;
  nonce: string;
  context: DesignPromptContext;
};

export type PromptCompression =
  | "full"
  | "notes-off"
  | "role-text-clamped"
  | "recipe-notes-off"
  | "relevant-only"
  | "index-only"
  | "recipes-compact"
  | "index-only-6"
  | "index-only-minimal";

export type PromptBuildResult =
  | {
      ok: true;
      text: string;
      utf8Bytes: number;
      omissions: string[];
      /** The last compression step applied; `full` means the text was never shrunk. */
      compression: PromptCompression;
    }
  | { ok: false; issues: DesignIssue[] };

function codePointLength(value: string): number {
  return [...value].length;
}

function clampCodePoints(value: string, max: number): string {
  const points = [...value];
  return points.length <= max ? value : points.slice(0, max).join("");
}

function inputTooLarge(bytes: number, limit: number, context: DesignPromptContext): DesignIssue {
  return {
    code: "DESIGN_INPUT_TOO_LARGE",
    severity: "error",
    path: [],
    params: { bytes, limit, roles: context.roles.length, teams: context.occupiedTeams.length },
    action: "none",
  };
}

function jsonBlock(title: string, value: unknown): string {
  return `## ${title}\n${JSON.stringify(value)}`;
}

const CONTRACT_TEAM = {
  required: ["id≤48 slug", "name 1–40", "mode=请求模式", "coordinatorRoleId", "members 1–64"],
  optional: ["description≤160", "collaboration", "operatingRules≤4000"],
  members: "key 必须按数组顺序为连续的 m1..mN；roleId 必填；重复 Role 的 instanceLabel(1–40) 必填",
  collaboration: "可选。replicas 只能是 2 或 3；judgeRoleId、escalationRoleId 可选 slug",
} as const;

const CONTRACT_NEW_ROLE = {
  required: [
    "id≤48 slug",
    "name 1–40",
    "mission 1–2000",
    "responsibilities 1–30 项、每项 1–500",
    "restrictions 0–30 项、每项 1–500",
    "systemPrompt 1–20000",
    "outputContract 0–30 项、每项 1–500",
    "preferredProfiles 1–5",
    "fallbackProfiles 0–5",
    "executionPolicy",
    "noveltyReason 1–600",
  ],
  optional: ["description≤160", "color≤32", "icon≤64"],
  profileRef: "{ profileId }，profileId 取白名单真实 id，1–256",
  executionPolicy: {
    tier: ["decision", "execution", "escalation", "retain"],
    taskKind: ["coding", "testing", "acceptance", "codebase", "ops", "general"],
  },
} as const;

const CONTRACT_PROFILE_CHOICE = {
  target: "coordinator 或 m1..m64",
  profileIds: "0–3 个有序真实 id；空数组只允许规划器判定不可用的待命升级位",
  reason: "1–600，只解释职责",
} as const;

const CONTRACT_FORBIDDEN = [
  "mcpServers",
  "env",
  "commands",
  "timestamps",
  "source",
  "designer",
  "enabled",
  "seatId",
  "memberCreation",
] as const;

/** The compact gap shape; it replaces the new-Role block so the budget does not grow. */
const CONTRACT_GAP = {
  required: [
    "kind",
    "responsibility 1–600",
    "reason 1–600",
    "use",
    "profiles",
    "roleId 或 suggestedRole",
  ],
  kind: ["missing-role", "unlaunchable-role"],
  use: ["coordinator", "member"],
  profiles: "existing：profileIds 1–3，须为该用途 route 内合格 id；none：reason 1–600",
  suggestedRole: {
    id: "≤48 slug",
    name: "1–40，前缀按目录",
    responsibilities: "1–8 项",
    executionPolicy: {
      tier: ["decision", "execution", "escalation", "retain"],
      taskKind: ["coding", "testing", "acceptance", "codebase", "ops", "general"],
    },
  },
  bounds: "gaps 1–8",
  forbidden: ["team", "newRoles", "profileChoices"],
} as const;

type PromptRules = {
  version: DesignOutputContractVersion;
  /** A v1 record is always legacy (3 new Roles); only a v2 record can be reuse-only. */
  rolesOnly: boolean;
  limit: 0 | 3;
};

/** The one normalization: every template, limit, and sentence reads this result. */
function promptRules(context: DesignPromptContext): PromptRules {
  const version = context.outputContractVersion ?? 1;
  const rolesOnly = version === 2 ? (context.existingRolesOnly ?? true) : false;
  return { version, rolesOnly, limit: designNewRoleLimit({ existingRolesOnly: rolesOnly }) };
}

type TemplateKind = "v1" | "team" | "gap";
type PreviousOutputKind = "team" | "role-gap";

function templateKind(rules: PromptRules): TemplateKind {
  if (rules.version === 1) return "v1";
  return rules.rolesOnly ? "gap" : "team";
}

function outputContract(rules: PromptRules): Record<string, unknown> {
  if (rules.version === 1) {
    return {
      required: {
        version: "固定 1",
        jobId: "本次 UUID，原样",
        attempt: "本次 1|2|3，原样",
        nonce: "本次 32 hex，原样",
        summary: "1–1000",
        team: "见 team",
        reuse: "0–65；每项 roleId + reason(1–600)",
        newRoles: `0–${rules.limit}；见 newRole`,
        profileChoices: "2–65；coordinator 与每个逻辑成员各恰好一项",
      },
      team: CONTRACT_TEAM,
      newRole: CONTRACT_NEW_ROLE,
      profileChoice: CONTRACT_PROFILE_CHOICE,
      limits: { jsonBlockBytes: 32 * 1024, newRoles: rules.limit, members: 64 },
      forbidden: CONTRACT_FORBIDDEN,
    };
  }
  if (rules.rolesOnly) {
    return {
      required: {
        version: "固定 2",
        kind: '"role-gap"，或复用-only 的 "team"（newRoles 必须为 []）',
        jobId: "本次 UUID，原样",
        attempt: "本次 1|2|3，原样",
        nonce: "本次 32 hex，原样",
        summary: "1–1000",
        team: "见 team；newRoles 必须为 []",
        reuse: "0–65；每项 roleId + reason(1–600)，reason 必须说明该 Role 承担的职责",
        newRoles: "必须为 []",
        profileChoices: "2–65；coordinator 与每个逻辑成员各恰好一项",
      },
      team: CONTRACT_TEAM,
      gap: CONTRACT_GAP,
      profileChoice: CONTRACT_PROFILE_CHOICE,
      limits: { jsonBlockBytes: 32 * 1024, newRoles: 0, members: 64 },
      forbidden: CONTRACT_FORBIDDEN,
    };
  }
  return {
    required: {
      version: "固定 2",
      kind: '"team"',
      jobId: "本次 UUID，原样",
      attempt: "本次 1|2|3，原样",
      nonce: "本次 32 hex，原样",
      summary: "1–1000",
      team: "见 team",
      reuse: "0–65；每项 roleId + reason(1–600)，reason 必须说明该 Role 承担的职责",
      newRoles: `0–${rules.limit}；见 newRole`,
      profileChoices: "2–65；coordinator 与每个逻辑成员各恰好一项",
    },
    team: CONTRACT_TEAM,
    newRole: CONTRACT_NEW_ROLE,
    profileChoice: CONTRACT_PROFILE_CHOICE,
    limits: { jsonBlockBytes: 32 * 1024, newRoles: rules.limit, members: 64 },
    forbidden: CONTRACT_FORBIDDEN,
  };
}

function sampleIdentity(input: DesignPromptInput, version: DesignOutputContractVersion) {
  return {
    version,
    ...(version === 2 ? { kind: "team" } : {}),
    jobId: input.jobId,
    attempt: input.attempt,
    nonce: input.nonce,
  };
}

function teamSample(
  input: DesignPromptInput,
  rules: PromptRules,
  withNewRole: boolean,
): Record<string, unknown> {
  const newRole = {
    id: "eng-rework",
    name: "【工程】改版专员",
    mission: "完成指定改版",
    responsibilities: ["实现指定模块"],
    restrictions: ["不修改无关模块"],
    systemPrompt: "按协调者范围实现并报告验证",
    outputContract: ["改动清单"],
    preferredProfiles: [{ profileId: "profile-1" }],
    fallbackProfiles: [],
    executionPolicy: { tier: "execution", taskKind: "coding" },
    noveltyReason: "现有 Role 不覆盖这次专职改版",
  };
  return {
    ...sampleIdentity(input, rules.version),
    summary: withNewRole ? "复用统筹并新增一个专职 Role" : "只复用现有 Role 完成改版",
    team: {
      id: "rework-team",
      name: "改版团队",
      mode: input.context.requestedMode,
      coordinatorRoleId: "lead-tech",
      members: withNewRole
        ? [
            { key: "m1", roleId: "eng-rework" },
            { key: "m2", roleId: "qa-review" },
          ]
        : [
            { key: "m1", roleId: "eng-fullstack" },
            { key: "m2", roleId: "qa-review" },
          ],
      ...(withNewRole ? { collaboration: { replicas: 2, judgeRoleId: "qa-review" } } : {}),
    },
    reuse: withNewRole
      ? [
          { roleId: "lead-tech", reason: "负责统筹与验收" },
          { roleId: "qa-review", reason: "负责独立审查" },
        ]
      : [
          { roleId: "lead-tech", reason: "负责统筹与验收" },
          { roleId: "eng-fullstack", reason: "负责实现改版" },
          { roleId: "qa-review", reason: "负责独立审查" },
        ],
    newRoles: withNewRole ? [newRole] : [],
    profileChoices: withNewRole
      ? [
          { target: "coordinator", profileIds: ["profile-1"], reason: "负责决策" },
          { target: "m1", profileIds: ["profile-1"], reason: "覆盖执行职责" },
          { target: "m2", profileIds: ["profile-1"], reason: "覆盖独立审查" },
        ]
      : [
          { target: "coordinator", profileIds: ["profile-1"], reason: "负责决策" },
          { target: "m1", profileIds: ["profile-1"], reason: "负责实现改版" },
          { target: "m2", profileIds: ["profile-1"], reason: "负责独立审查" },
        ],
  };
}

function gapSample(input: DesignPromptInput): Record<string, unknown> {
  return {
    version: 2,
    kind: "role-gap",
    jobId: input.jobId,
    attempt: input.attempt,
    nonce: input.nonce,
    summary: "现有 Role 覆盖不了数据迁移",
    gaps: [
      {
        kind: "missing-role",
        responsibility: "负责数据库迁移",
        reason: "目录没有承担迁移的 Role",
        use: "member",
        profiles: { kind: "existing", profileIds: ["profile-1"] },
        suggestedRole: {
          id: "eng-data",
          name: "【工程】数据迁移",
          responsibilities: ["编写可回滚的迁移脚本"],
          executionPolicy: { tier: "execution", taskKind: "coding" },
        },
      },
    ],
  };
}

function outputTemplate(
  input: DesignPromptInput,
  rules: PromptRules,
  previous?: PreviousOutputKind,
): string {
  const kind = templateKind(rules);
  const parts = [
    "## 输出合同",
    "只输出一个 agent-team-design fenced JSON 块。示例展示必填形状，不是可提交的空方案；身份字段换成本次原样值，Profile id 换成白名单真实 id。",
    jsonBlock("字段合同", outputContract(rules)),
  ];
  if (kind === "gap") {
    parts.push(`\`\`\`agent-team-design\n${JSON.stringify(gapSample(input))}\n\`\`\``);
    if (previous !== "role-gap") {
      parts.push("复用-only 团队示例（newRoles=[]）：");
      parts.push(
        `\`\`\`agent-team-design\n${JSON.stringify(teamSample(input, rules, false))}\n\`\`\``,
      );
    }
  } else {
    parts.push(
      `\`\`\`agent-team-design\n${JSON.stringify(teamSample(input, rules, true))}\n\`\`\``,
    );
  }
  parts.push(
    "完整 JSON 块不超过 32KiB UTF-8。不要输出 mcpServers、env、命令、时间戳、source、designer、enabled、seatId 或 memberCreation。",
  );
  return parts.join("\n");
}

const SUPPORTED_TASK_KINDS = [
  "coding",
  "testing",
  "acceptance",
  "codebase",
  "ops",
  "general",
] as const;

function stringIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function projectedCapabilities(value: DesignPromptContext["runtimeCapabilities"]): {
  onDemand: boolean;
  expansion: boolean;
  collaboration: boolean;
} {
  return {
    onDemand: value.onDemand,
    expansion: value.expansion,
    collaboration: value.collaboration,
  };
}

function projectedPool(
  pool: DesignPromptContext["economy"]["pool"],
): { profileId: string; family: string | null; enabled: boolean }[] {
  return pool.map((entry) => ({
    profileId: entry.profileId,
    family: entry.family ?? null,
    enabled: entry.enabled,
  }));
}

function projectedTaskOrder(
  taskOrder: DesignPromptContext["economy"]["taskOrder"],
): Record<string, string[]> {
  const projected: Record<string, string[]> = {};
  for (const kind of SUPPORTED_TASK_KINDS) projected[kind] = stringIds(taskOrder[kind]);
  return projected;
}

function projectedTeams(teams: readonly DesignPromptTeamName[]): { id: string; name: string }[] {
  return teams.map((team) => ({ id: team.id, name: team.name }));
}

function projectedChoices(
  choices: readonly ExpectedDesignChoice[],
): { target: string; roleId: string; expectedProfileIds: string[] }[] {
  return choices.map((choice) => ({
    target: choice.target,
    roleId: choice.roleId,
    expectedProfileIds: stringIds(choice.expectedProfileIds),
  }));
}

type PromptDetail = {
  notes: "full" | "none";
  roleText: "full" | "clamped";
  recipeNotes: boolean;
  relevantOnly: boolean;
  /** v2 only: keep a bounded summary for relevant Roles, names/states for the rest. */
  roleDetail: "full" | "index-only";
  /** v2 only: number of relevant Role summaries while roleDetail is index-only. */
  indexOnlyLimit: number;
  /** v2 only: recipes keep id/name/member role ids instead of full payloads. */
  recipes: "full" | "compact";
};

const FULL_DETAIL: PromptDetail = {
  notes: "full",
  roleText: "full",
  recipeNotes: true,
  relevantOnly: false,
  roleDetail: "full",
  indexOnlyLimit: 12,
  recipes: "full",
};

function rolePayload(role: DesignPromptRoleSummary, detail: PromptDetail): Record<string, unknown> {
  const clamped = detail.roleText === "clamped";
  const responsibilities = stringIds(role.responsibilities);
  return {
    id: role.id,
    name: role.name,
    enabled: role.enabled,
    tier: role.tier ?? null,
    taskKind: role.taskKind ?? null,
    mission: clamped ? clampCodePoints(role.mission, MISSION_CODE_POINTS) : role.mission,
    responsibilities: clamped
      ? responsibilities
          .slice(0, RESPONSIBILITY_ITEMS)
          .map((item) => clampCodePoints(item, RESPONSIBILITY_CODE_POINTS))
      : responsibilities,
    preferredProfileIds: stringIds(role.preferredProfileIds),
    fallbackProfileIds: stringIds(role.fallbackProfileIds),
  };
}

function profilePayload(
  profile: DesignPromptProfileSummary,
  detail: PromptDetail,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    model: profile.model ?? null,
    modeId: profile.modeId ?? null,
    thinkingOptionId: profile.thinkingOptionId ?? null,
    available: profile.available,
    family: profile.family ?? null,
    budget: profile.budget ?? null,
    budgetBasis: profile.budgetBasis ?? null,
  };
  if (detail.notes === "none" || profile.notes === undefined) return payload;
  return { ...payload, notes: clampCodePoints(profile.notes, NOTES_CODE_POINTS) };
}

function recipeNote(recipe: TeamDesignRecipe): string | undefined {
  return "notes" in recipe ? recipe.notes : undefined;
}

function recipePayload(recipe: TeamDesignRecipe, detail: PromptDetail): Record<string, unknown> {
  if (detail.recipes === "compact") {
    return {
      id: recipe.id,
      name: recipe.name,
      members: recipe.members.map((member) => ({
        roleId: member.roleId,
        minInstances: member.minInstances,
        maxInstances: member.maxInstances,
      })),
    };
  }
  const notes = recipeNote(recipe);
  return {
    id: recipe.id,
    name: recipe.name,
    coordinatorRoleId: recipe.coordinatorRoleId,
    members: recipe.members.map((member) => ({ ...member })),
    ...(detail.recipeNotes && notes !== undefined ? { notes } : {}),
  };
}

function detailedRoles(
  context: DesignPromptContext,
  detail: PromptDetail,
): readonly DesignPromptRoleSummary[] {
  if (!detail.relevantOnly || context.relevantRoleIds === undefined) return context.roles;
  const selected = new Set(context.relevantRoleIds);
  return context.roles.filter((role) => selected.has(role.id));
}

function roleTextOmitted(roles: readonly DesignPromptRoleSummary[]): string[] {
  const omitted: string[] = [];
  if (roles.some((role) => codePointLength(role.mission) > MISSION_CODE_POINTS))
    omitted.push("role-mission");
  if (
    roles.some((role) => {
      const responsibilities = stringIds(role.responsibilities);
      return (
        responsibilities.length > RESPONSIBILITY_ITEMS ||
        responsibilities.some((item) => codePointLength(item) > RESPONSIBILITY_CODE_POINTS)
      );
    })
  ) {
    omitted.push("role-responsibilities");
  }
  return omitted;
}

function omissionsFor(
  context: DesignPromptContext,
  detail: PromptDetail,
  rules: PromptRules,
): string[] {
  const notesOmitted = context.profiles.some((profile) => profile.notes);
  const clamped = roleTextOmitted(
    rules.version === 2 ? context.roles : detailedRoles(context, detail),
  );
  if (rules.version === 1) {
    const hidden = context.roles.length - detailedRoles(context, detail).length;
    return [
      ...(detail.notes === "none" && notesOmitted ? ["profile-notes"] : []),
      ...(detail.roleText === "clamped" ? clamped : []),
      ...(detail.recipeNotes ||
      !TEAM_DESIGN_RECIPES.some((recipe) => recipeNote(recipe) !== undefined)
        ? []
        : ["recipe-notes"]),
      ...(hidden > 0 ? [`unrelated-role-details:${hidden}`] : []),
    ];
  }
  const relevant = relevantRoleIds(context, rules, detail.indexOnlyLimit);
  const hidden = context.roles.filter(
    (role) =>
      !roleSelectable(role, rules) ||
      (detail.roleDetail === "index-only" && !relevant.has(role.id)),
  ).length;
  return [
    ...(detail.notes === "none" && notesOmitted ? ["profile-notes"] : []),
    ...(detail.roleText === "clamped" ? clamped : []),
    ...(detail.recipeNotes ||
    !TEAM_DESIGN_RECIPES.some((recipe) => recipeNote(recipe) !== undefined)
      ? []
      : ["recipe-notes"]),
    ...(hidden > 0 ? [`unrelated-role-details:${hidden}`] : []),
    ...(detail.roleDetail === "index-only" ? ["role-summaries-index-only"] : []),
    ...(detail.recipes === "compact" ? ["recipes-compact"] : []),
    ...(detail.roleDetail === "index-only" && detail.indexOnlyLimit === 6 ? ["index-only-6"] : []),
    ...(detail.roleDetail === "index-only" && detail.indexOnlyLimit === 0
      ? ["role-summaries-none"]
      : []),
  ];
}

/** Repeated at both ends of kickoff and correction; the nonce is never inferred. */
function identityRequirement(
  input: Pick<DesignPromptInput, "jobId" | "attempt" | "nonce">,
): string {
  return `jobId=${input.jobId} attempt=${input.attempt} nonce=${input.nonce}。identity 必须逐字复制：jobId、attempt、nonce 与本节完全一致，不得自行生成或改写。`;
}

const ROUTE_ELIGIBLE_LIMIT = 8;
const ROUTE_FAILED_IDS_LIMIT = 5;

function routingPayload(routing: DesignModeRouting): Record<string, unknown> {
  if (routing.status !== "ready") {
    return {
      status: routing.status,
      ...(routing.status === "invalid" ? { reason: routing.reason } : {}),
    };
  }
  return {
    routes: routing.routes.map((row) => {
      const eligible = row.candidates.filter((entry) => entry.eligible);
      const failed = row.candidates.filter((entry) => !entry.eligible);
      const reasons = [
        ...new Set(failed.flatMap((entry) => (entry.reason === undefined ? [] : [entry.reason]))),
      ].slice(0, ROUTE_FAILED_IDS_LIMIT);
      return {
        route: row.route,
        ...(row.taskKind === null ? {} : { taskKind: row.taskKind }),
        eligible: eligible.slice(0, ROUTE_ELIGIBLE_LIMIT).map((entry) => entry.profileId),
        ...(eligible.length > ROUTE_ELIGIBLE_LIMIT
          ? { omittedEligible: eligible.length - ROUTE_ELIGIBLE_LIMIT }
          : {}),
        failedCount: failed.length,
        ...(failed.length === 0
          ? {}
          : {
              failedIds: failed.slice(0, ROUTE_FAILED_IDS_LIMIT).map((entry) => entry.profileId),
            }),
        ...(reasons.length === 0 ? {} : { failedReasons: reasons }),
      };
    }),
  };
}

/** What the model may claim for one use: usable now, provably blocked, or unproven. */
type PromptLaunchState = "ok" | "blocked" | "unknown";

function launchState(
  launchable: boolean | undefined,
  verified: boolean | undefined,
): PromptLaunchState {
  if (launchable === true) return "ok";
  if (launchable === false && verified === true) return "blocked";
  return "unknown";
}

function roleIndexEntry(
  role: DesignPromptRoleSummary,
  rules: PromptRules,
): Record<string, unknown> {
  return {
    id: role.id,
    name: role.name,
    enabled: role.enabled,
    tier: role.tier ?? null,
    preferredProfileIds: stringIds(role.preferredProfileIds),
    fallbackProfileIds: stringIds(role.fallbackProfileIds),
    launchable: role.launchable,
    unavailableProfileIds: stringIds(role.unavailableProfileIds),
    ...(rules.version === 2
      ? {
          memberLaunch: launchState(role.launchable, role.launchVerified),
          coordinatorLaunch: launchState(
            role.coordinatorLaunchable,
            role.coordinatorLaunchVerified,
          ),
        }
      : {}),
  };
}

const REQUEST_STOP_TERMS: Record<string, true> = {
  设计: true,
  团队: true,
  一个: true,
  需要: true,
  功能: true,
  开发: true,
  实现: true,
  负责: true,
  任务: true,
  成员: true,
  角色: true,
  使用: true,
  可以: true,
  以及: true,
  并且: true,
  支持: true,
  管理: true,
  系统: true,
  提供: true,
  进行: true,
  相关: true,
  工作: true,
  内容: true,
  现有: true,
  后台: true,
  改版: true,
  完成: true,
  确保: true,
  覆盖: true,
  输出: true,
  建议: true,
  新增: true,
  role: true,
  roles: true,
  dev: true,
  team: true,
  teams: true,
  ai: true,
  profile: true,
  agent: true,
  mode: true,
};

/** Recipe roles plus Roles whose name/mission/responsibilities share a request term. */
function relevantRoleIds(
  context: DesignPromptContext,
  rules: PromptRules,
  limit: number,
): ReadonlySet<string> {
  if (limit <= 0) return new Set<string>();
  const recipeIds = new Set<string>(
    TEAM_DESIGN_RECIPES.flatMap((recipe) => [
      recipe.coordinatorRoleId,
      ...recipe.members.map((member) => member.roleId),
    ]),
  );
  const terms = new Set<string>();
  const request = context.request.toLowerCase();
  for (const word of request.match(/[a-z0-9]{2,}/gu) ?? []) {
    if (!REQUEST_STOP_TERMS[word]) terms.add(word);
  }
  let domainText = request;
  for (const stop of Object.keys(REQUEST_STOP_TERMS)) {
    domainText = domainText.split(stop).join(" ");
  }
  for (const run of domainText.match(/[\u3400-\u9fff]+/gu) ?? []) {
    for (let index = 0; index + 1 < run.length; index += 1) {
      const term = run.slice(index, index + 2);
      if (!REQUEST_STOP_TERMS[term]) terms.add(term);
    }
  }
  const ranked = context.roles
    .map((role, index) => {
      const text =
        `${role.name}\n${role.mission}\n${role.responsibilities.join("\n")}`.toLowerCase();
      const score = [...terms].filter((term) => text.includes(term)).length;
      return {
        id: role.id,
        index,
        recipe: recipeIds.has(role.id),
        score,
        selectable: roleSelectable(role, rules),
      };
    })
    .filter((entry) => entry.selectable);
  // Request matches must never be crowded out by the static recipes. Matches sort first by
  // overlap; recipe-only Roles fill the remaining slots in stable catalog order.
  const matched = ranked
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const recipes = ranked.filter((entry) => entry.score === 0 && entry.recipe);
  recipes.sort((a, b) => a.index - b.index);
  return new Set([...matched, ...recipes].slice(0, limit).map((entry) => entry.id));
}

function roleSelectable(role: DesignPromptRoleSummary, rules: PromptRules): boolean {
  if (!role.enabled) return false;
  if (rules.version === 1) return true;
  const member = launchState(role.launchable, role.launchVerified);
  const coordinator = launchState(role.coordinatorLaunchable, role.coordinatorLaunchVerified);
  return member !== "blocked" || coordinator !== "blocked";
}

function roleDirectoryEntry(
  role: DesignPromptRoleSummary,
  rules: PromptRules,
  detail: PromptDetail,
  relevant: ReadonlySet<string>,
): Record<string, unknown> {
  if (rules.version === 2 && !role.enabled) {
    return { id: role.id, name: role.name, enabled: false };
  }
  if (rules.version === 2 && !roleSelectable(role, rules)) {
    return {
      id: role.id,
      name: role.name,
      memberLaunch: launchState(role.launchable, role.launchVerified),
      coordinatorLaunch: launchState(role.coordinatorLaunchable, role.coordinatorLaunchVerified),
      unavailableProfileIds: stringIds(role.unavailableProfileIds),
    };
  }
  if (rules.version === 2 && detail.roleDetail === "index-only" && !relevant.has(role.id)) {
    return {
      id: role.id,
      name: role.name,
      tier: role.tier ?? null,
      memberLaunch: launchState(role.launchable, role.launchVerified),
      coordinatorLaunch: launchState(role.coordinatorLaunchable, role.coordinatorLaunchVerified),
    };
  }
  const index = roleIndexEntry(role, rules);
  const summary = rolePayload(role, detail);
  return {
    ...index,
    mission: summary.mission,
    responsibilities: summary.responsibilities,
    taskKind: summary.taskKind,
  };
}

function indexRequirement(rules: PromptRules, routing: DesignModeRouting | undefined): string {
  if (rules.version === 1) {
    return "Role 索引的 launchable 表示当前模式下该 Role 至少有一个可用 Profile；优先复用 launchable=true 的 Role。新建 Role 只使用 Profile 白名单中 available=true 的 Profile；unavailableProfileIds 最多列出 5 个不可用绑定。";
  }
  // AC-0c.6 defines missing-role as "no Role carries the responsibility"; an unverified
  // availability row proves nothing about the Role, so it must not be reclassified. AC-0c.14
  // forbids reporting an available route as unlaunchable, so `unknown` reuses the Role and only
  // notes the unverified availability.
  const launchRule =
    "memberLaunch/coordinatorLaunch 是该用途判定：ok=可启动；blocked=已核实不可启动（只可报 unlaunchable-role，use 须选对）；unknown=可用性未核实（照常使用该 Role 并在 reuse.reason 注明；不得声称 Role 缺失或不可启动，只有确实无 Role 承担时才报 missing-role，profiles.none 只表示不提供 Profile）。用途不可互推。";
  const directoryLegend =
    "条目形态：完整条目含 mission/responsibilities/taskKind；无 mission 的条目是索引摘要（仍可按名称复用）；enabled:false 表示停用，停用 Role 不可选，也不属于 unlaunchable-role（缺职责时报 missing-role）；memberLaunch/coordinatorLaunch=blocked 表示该用途已核实不可启动；无 enabled 的可选条目默认启用。";
  if (routing !== undefined) {
    return `Role 索引的 unavailableProfileIds 是该用途 route 内不合格的候选（非 Role 绑定），补救是调整「经济：全席位」路由。${directoryLegend}${launchRule}`;
  }
  return `Role 索引的 unavailableProfileIds 是不可用绑定，最多 5 个。${directoryLegend}${launchRule}优先复用两种用途都可启动的 Role；新建 Role 只使用 Profile 白名单中 available=true 的 Profile。`;
}

function recipeInstruction(rules: PromptRules): string {
  if (rules.version === 1) {
    return `配方是参考，不是必须照抄。目录里没有的 Role 要标明缺失，不能当成已有；缺通用 Role 时可提示先同步预设。不要为凑配方新建超过 ${rules.limit} 个 Role。`;
  }
  if (rules.rolesOnly) {
    return "配方是参考，不是必须照抄。目录里没有的 Role 要标明缺失，不能当成已有；覆盖不了就报 role-gap，不要用职责不符的 Role 凑数。复用 Role 时 reason 必须说明它承担的职责；不要新建 Role。";
  }
  return `配方是参考，不是必须照抄。目录里没有的 Role 要标明缺失，不能当成已有；缺通用 Role 时可提示先同步预设。覆盖不了就报缺口，不要用职责不符的 Role 凑数；复用 Role 时 reason 必须说明它承担的职责。不要为凑配方新建超过 ${rules.limit} 个 Role。`;
}

function compose(input: DesignPromptInput, detail: PromptDetail): string {
  const { context } = input;
  const rules = promptRules(context);
  const routing = rules.version === 2 ? context.modeRouting : undefined;
  const v2 = rules.version === 2;
  const relevant = v2 ? relevantRoleIds(context, rules, detail.indexOnlyLimit) : new Set<string>();
  const target = context.target
    ? { id: context.target.id, name: context.target.name, path: context.target.path ?? null }
    : null;
  return [
    "## 身份",
    identityRequirement(input),
    "nonce 只用于本轮输出身份核对，不是执行许可。",
    "",
    "## 用户需求",
    JSON.stringify(context.request),
    "",
    "## 目标限制",
    context.target
      ? "用户已选择目标工作区，只可按需只读理解项目，不得修改文件。"
      : "没有目标。只使用本提示中的需求、目录与 Profile 摘要；不读取、不列举、不修改承载目录。",
    jsonBlock("工作区", {
      target,
      carrierWorkspaceId: context.carrierWorkspaceId,
      carrierAccess: "forbidden",
    }),
    "",
    "## 模式、预算与席位",
    jsonBlock("模式", {
      requestedMode: context.requestedMode,
      runtimeCapabilities: projectedCapabilities(context.runtimeCapabilities),
      maxMembers: context.maxMembers,
      maxMembersCounts:
        "physical members excluding the coordinator; collaboration and standby seats count",
      economyPool: projectedPool(context.economy.pool),
      taskOrder: projectedTaskOrder(context.economy.taskOrder),
    }),
    "",
    ...(routing === undefined
      ? []
      : [
          "## 经济：全席位路由",
          routing.status === "ready"
            ? "不使用 Role 原绑定；每个席位按用途走 route，route 内没有合格候选即阻断且不回退，profileChoices 必须与规划一致。补救是调整设置中的「经济：全席位」路由。"
            : "「经济：全席位」策略缺失或非法，无法给出合格候选；不要建议 existing Profile，只能 kind:none 并说明原因。",
          jsonBlock("route 摘要", routingPayload(routing)),
          "",
        ]),
    "## 目录与 Profile 白名单",
    jsonBlock(
      "目录约束",
      v2
        ? {
            occupiedTeams: projectedTeams(context.occupiedTeams),
            newRoleLimit: rules.limit,
            namePrefixes: NAME_PREFIXES.map(([prefix, label]) => ({ prefix, label })),
            coordinatorCannotBeMember: true,
            duplicateRoleNeedsInstanceLabel: true,
            preferReuse: true,
          }
        : {
            occupiedRoleIds: stringIds(context.occupiedRoleIds),
            occupiedRoleNames: stringIds(context.occupiedRoleNames),
            occupiedTeams: projectedTeams(context.occupiedTeams),
            newRoleLimit: rules.limit,
            namePrefixes: NAME_PREFIXES.map(([prefix, label]) => ({ prefix, label })),
            coordinatorCannotBeMember: true,
            duplicateRoleNeedsInstanceLabel: true,
            preferReuse: true,
          },
    ),
    jsonBlock(
      "Role 索引",
      context.roles.map((role) =>
        v2 ? roleDirectoryEntry(role, rules, detail, relevant) : roleIndexEntry(role, rules),
      ),
    ),
    indexRequirement(rules, routing),
    ...(v2
      ? []
      : [
          jsonBlock(
            "Role 摘要",
            detailedRoles(context, detail).map((role) => rolePayload(role, detail)),
          ),
        ]),
    jsonBlock(
      "Profile 白名单",
      context.profiles.map((profile) => profilePayload(profile, detail)),
    ),
    jsonBlock("期望选择", projectedChoices(context.expectedChoices)),
    "",
    "## 九配方",
    recipeInstruction(rules),
    jsonBlock(
      "配方",
      TEAM_DESIGN_RECIPES.map((recipe) => recipePayload(recipe, detail)),
    ),
    "",
    outputTemplate(input, rules),
    "",
    "## 身份复核",
    `${identityRequirement(input)} nonce 只用于本轮身份核对，不是执行许可。`,
  ].join("\n");
}

type CompressionStep = { detail: PromptDetail; compression: PromptCompression };

function compressed(
  input: DesignPromptInput,
  detail: PromptDetail,
  rules: PromptRules,
): CompressionStep | null {
  const { context } = input;
  if (detail.notes === "full" && context.profiles.some((profile) => profile.notes)) {
    return { detail: { ...detail, notes: "none" }, compression: "notes-off" };
  }
  if (detail.roleText === "full" && roleTextOmitted(detailedRoles(context, detail)).length > 0) {
    return { detail: { ...detail, roleText: "clamped" }, compression: "role-text-clamped" };
  }
  if (
    detail.recipeNotes &&
    TEAM_DESIGN_RECIPES.some((recipe) => recipeNote(recipe) !== undefined)
  ) {
    return { detail: { ...detail, recipeNotes: false }, compression: "recipe-notes-off" };
  }
  // The legacy relevant-only tier depended on a field production never supplied. Keep its
  // historical v1 behavior, but compress v2 deterministically inside the prompt.
  if (rules.version === 1 && !detail.relevantOnly && context.relevantRoleIds !== undefined) {
    return {
      detail: { ...detail, relevantOnly: true, roleText: "full" },
      compression: "relevant-only",
    };
  }
  if (rules.version === 2 && detail.roleDetail === "full") {
    return { detail: { ...detail, roleDetail: "index-only" }, compression: "index-only" };
  }
  if (rules.version === 2 && detail.recipes === "full") {
    return { detail: { ...detail, recipes: "compact" }, compression: "recipes-compact" };
  }
  if (rules.version === 2 && detail.indexOnlyLimit > 6) {
    return { detail: { ...detail, indexOnlyLimit: 6 }, compression: "index-only-6" };
  }
  if (rules.version === 2 && detail.indexOnlyLimit > 0) {
    return { detail: { ...detail, indexOnlyLimit: 0 }, compression: "index-only-minimal" };
  }
  return null;
}

type BudgetFit = {
  ok: boolean;
  text: string;
  bytes: number;
  omissions: string[];
  compression: PromptCompression;
};

function withinBudget(input: DesignPromptInput, limit: number): BudgetFit {
  const rules = promptRules(input.context);
  let detail = FULL_DETAIL;
  let compression: PromptCompression = "full";
  for (;;) {
    const text = compose(input, detail);
    const bytes = utf8ByteLength(text);
    const omissions = omissionsFor(input.context, detail, rules);
    if (bytes <= limit) return { ok: true, text, bytes, omissions, compression };
    const next = compressed(input, detail, rules);
    if (!next) return { ok: false, text, bytes, omissions, compression };
    detail = next.detail;
    compression = next.compression;
  }
}

/**
 * Compresses toward 30KiB. The v2 contract may never exceed it (AC-0c.15): once every
 * compression step is spent, an oversized prompt fails with INPUT_TOO_LARGE instead of being
 * sent. The legacy 60KiB escape remains for v1 records only, whose contract predates the budget.
 */
export function buildDesignKickoff(input: DesignPromptInput): PromptBuildResult {
  const rules = promptRules(input.context);
  const fitted = withinBudget(input, DESIGN_KICKOFF_TARGET_BYTES);
  if (fitted.ok) {
    return {
      ok: true,
      text: fitted.text,
      utf8Bytes: fitted.bytes,
      omissions: fitted.omissions,
      compression: fitted.compression,
    };
  }
  if (rules.version === 1 && fitted.bytes <= DESIGN_KICKOFF_MAX_BYTES) {
    return {
      ok: true,
      text: fitted.text,
      utf8Bytes: fitted.bytes,
      omissions: fitted.omissions,
      compression: fitted.compression,
    };
  }
  return {
    ok: false,
    issues: [
      inputTooLarge(
        fitted.bytes,
        rules.version === 1 ? DESIGN_KICKOFF_MAX_BYTES : DESIGN_KICKOFF_TARGET_BYTES,
        input.context,
      ),
    ],
  };
}

function issuePayload(issue: DesignIssue): Record<string, unknown> {
  return {
    code: issue.code,
    severity: issue.severity,
    path: issue.path,
    params: Object.fromEntries(Object.entries(issue.params).filter(([, value]) => isScalar(value))),
  };
}

/**
 * Repair prompt for attempts 2 and 3. The kickoff already carried the Role/Profile indexes and
 * recipes, so a correction repeats only the exact identity, the first 20 aggregated issues,
 * mismatch-only expected choices, and the full output contract. This keeps the real 22-Role case
 * well below 24KiB without raising the hard cap.
 */
export function buildDesignCorrection(input: {
  jobId: string;
  attempt: 1 | 2 | 3;
  nonce: string;
  issues: readonly DesignIssue[];
  context: DesignPromptContext;
  expectedChoices: readonly ExpectedDesignChoice[];
  /** The kind the previous attempt produced; a failed gap is rewritten as a gap. */
  previousOutputKind?: PreviousOutputKind;
}): PromptBuildResult {
  const rules = promptRules(input.context);
  const shown = input.issues.slice(0, MAX_CORRECTION_ISSUES);
  const hidden = input.issues.length - shown.length;
  const text = [
    "## 修正",
    identityRequirement(input),
    "上一轮输出未通过校验。按下列聚合错误重写完整方案，只输出一个 agent-team-design fenced JSON 块，身份字段原样。不要复述上一轮全文，也不要重新列举 Role/Profile 上下文。",
    ...(rules.version === 2 && rules.rolesOnly && input.previousOutputKind === "role-gap"
      ? [
          "上一轮是角色缺口（role-gap）：只重写 role-gap，或改为复用-only 的 team（newRoles 为空）；不要新增 Role。",
        ]
      : []),
    jsonBlock("聚合错误", {
      issues: shown.map(issuePayload),
      omittedIssueCount: hidden,
    }),
    jsonBlock("准确期望", projectedChoices(input.expectedChoices)),
    "",
    outputTemplate(
      {
        jobId: input.jobId,
        attempt: input.attempt,
        nonce: input.nonce,
        context: input.context,
      },
      rules,
      input.previousOutputKind,
    ),
    "",
    "## 身份复核",
    `${identityRequirement(input)} nonce 只用于本轮身份核对，不是执行许可。`,
  ].join("\n");
  const bytes = utf8ByteLength(text);
  if (bytes > DESIGN_CORRECTION_MAX_BYTES) {
    return {
      ok: false,
      issues: [inputTooLarge(bytes, DESIGN_CORRECTION_MAX_BYTES, input.context)],
    };
  }
  return { ok: true, text, utf8Bytes: bytes, omissions: [], compression: "full" };
}

/** Live availability is a host fact. Notes stay on the summary; feature values do not. */
export function summarizeProfiles(
  profiles: readonly PaseoProfile[],
  availability: readonly ProviderAvailability[],
  economy: EconomyPolicy,
): DesignPromptProfileSummary[] {
  const available = new Map(availability.map((item) => [item.provider, item.available]));
  const families = new Map(
    economy.pool.flatMap((entry) =>
      entry.family ? [[entry.profileId, entry.family] as const] : [],
    ),
  );
  return profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    model: profile.model,
    modeId: profile.modeId,
    thinkingOptionId: profile.thinkingOptionId,
    available: available.get(profile.provider) ?? false,
    notes: profile.notes,
    family: families.get(profile.id),
    budget: economy.profileBudget[profile.id],
    budgetBasis: economy.profileBudget[profile.id] === undefined ? undefined : "host",
  }));
}

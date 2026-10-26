import { utf8ByteLength } from "../../shared/domain/design-output";
import type { EconomyBudget, EconomyPolicy } from "../../shared/domain/mode-resolver";
import type {
  PaseoProfile,
  ProviderAvailability,
  WorkspaceSummary,
} from "../../shared/paseo/adapter";
import type { DesignChoiceTarget, DesignIssue } from "../../shared/schemas/design";
import type { TeamMode } from "../../shared/schemas/team-mode";
import { TEAM_DESIGN_RECIPES, type TeamDesignRecipe } from "../templates/recipes";

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
};

export type DesignPromptInput = {
  jobId: string;
  attempt: 1 | 2 | 3;
  nonce: string;
  context: DesignPromptContext;
};

export type PromptBuildResult =
  | { ok: true; text: string; utf8Bytes: number; omissions: string[] }
  | { ok: false; issues: DesignIssue[] };

function codePointLength(value: string): number {
  return [...value].length;
}

function clampCodePoints(value: string, max: number): string {
  const points = [...value];
  return points.length <= max ? value : points.slice(0, max).join("");
}

function inputTooLarge(bytes: number, limit: number): DesignIssue {
  return {
    code: "DESIGN_INPUT_TOO_LARGE",
    severity: "error",
    path: [],
    params: { bytes, limit },
    action: "none",
  };
}

function jsonBlock(title: string, value: unknown): string {
  return `## ${title}\n${JSON.stringify(value)}`;
}

const OUTPUT_CONTRACT = {
  required: {
    version: "固定 1",
    jobId: "本次 UUID，原样",
    attempt: "本次 1|2|3，原样",
    nonce: "本次 32 hex，原样",
    summary: "1–1000",
    team: "见 team",
    reuse: "0–65；每项 roleId + reason(1–600)",
    newRoles: "0–3；见 newRole",
    profileChoices: "2–65；coordinator 与每个逻辑成员各恰好一项",
  },
  team: {
    required: ["id≤48 slug", "name 1–40", "mode=请求模式", "coordinatorRoleId", "members 1–64"],
    optional: ["description≤160", "collaboration", "operatingRules≤4000"],
    members:
      "key 必须按数组顺序为连续的 m1..mN；roleId 必填；重复 Role 的 instanceLabel(1–40) 必填",
    collaboration: "可选。replicas 只能是 2 或 3；judgeRoleId、escalationRoleId 可选 slug",
  },
  newRole: {
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
  },
  profileChoice: {
    target: "coordinator 或 m1..m64",
    profileIds: "0–3 个有序真实 id；空数组只允许规划器判定不可用的待命升级位",
    reason: "1–600，只解释职责",
  },
  limits: { jsonBlockBytes: 32 * 1024, newRoles: 3, members: 64 },
  forbidden: [
    "mcpServers",
    "env",
    "commands",
    "timestamps",
    "source",
    "designer",
    "enabled",
    "seatId",
    "memberCreation",
  ],
} as const;

function outputTemplate(input: DesignPromptInput): string {
  const sample = {
    version: 1,
    jobId: input.jobId,
    attempt: input.attempt,
    nonce: input.nonce,
    summary: "复用统筹并新增一个专职 Role",
    team: {
      id: "rework-team",
      name: "改版团队",
      mode: input.context.requestedMode,
      coordinatorRoleId: "lead-tech",
      members: [
        { key: "m1", roleId: "eng-rework" },
        { key: "m2", roleId: "qa-review" },
      ],
      collaboration: { replicas: 2, judgeRoleId: "qa-review" },
    },
    reuse: [
      { roleId: "lead-tech", reason: "负责统筹与验收" },
      { roleId: "qa-review", reason: "负责独立审查" },
    ],
    newRoles: [
      {
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
      },
    ],
    profileChoices: [
      { target: "coordinator", profileIds: ["profile-1"], reason: "负责决策" },
      { target: "m1", profileIds: ["profile-1"], reason: "覆盖执行职责" },
      { target: "m2", profileIds: ["profile-1"], reason: "覆盖独立审查" },
    ],
  };
  return [
    "## 输出合同",
    "只输出一个 agent-team-design fenced JSON 块。示例展示必填形状，不是可提交的空方案；身份字段换成本次原样值，Profile id 换成白名单真实 id。",
    jsonBlock("字段合同", OUTPUT_CONTRACT),
    `\`\`\`agent-team-design\n${JSON.stringify(sample)}\n\`\`\``,
    "完整 JSON 块不超过 32KiB UTF-8。不要输出 mcpServers、env、命令、时间戳、source、designer、enabled、seatId 或 memberCreation。",
  ].join("\n");
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
};

const FULL_DETAIL: PromptDetail = {
  notes: "full",
  roleText: "full",
  recipeNotes: true,
  relevantOnly: false,
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

function omissionsFor(context: DesignPromptContext, detail: PromptDetail): string[] {
  const hidden = context.roles.length - detailedRoles(context, detail).length;
  return [
    ...(detail.notes === "none" && context.profiles.some((profile) => profile.notes)
      ? ["profile-notes"]
      : []),
    ...(detail.roleText === "clamped" ? roleTextOmitted(detailedRoles(context, detail)) : []),
    ...(detail.recipeNotes ||
    !TEAM_DESIGN_RECIPES.some((recipe) => recipeNote(recipe) !== undefined)
      ? []
      : ["recipe-notes"]),
    ...(hidden > 0 ? [`unrelated-role-details:${hidden}`] : []),
  ];
}

function compose(input: DesignPromptInput, detail: PromptDetail): string {
  const { context } = input;
  const target = context.target
    ? { id: context.target.id, name: context.target.name, path: context.target.path ?? null }
    : null;
  return [
    "## 身份",
    `jobId=${input.jobId} attempt=${input.attempt} version=1。nonce 只用于本轮输出身份核对，不是执行许可。`,
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
    "## 目录与 Profile 白名单",
    jsonBlock("目录约束", {
      occupiedRoleIds: stringIds(context.occupiedRoleIds),
      occupiedRoleNames: stringIds(context.occupiedRoleNames),
      occupiedTeams: projectedTeams(context.occupiedTeams),
      newRoleLimit: 3,
      namePrefixes: NAME_PREFIXES.map(([prefix, label]) => ({ prefix, label })),
      coordinatorCannotBeMember: true,
      duplicateRoleNeedsInstanceLabel: true,
      preferReuse: true,
    }),
    jsonBlock(
      "Role 索引",
      context.roles.map((role) => ({
        id: role.id,
        name: role.name,
        enabled: role.enabled,
        tier: role.tier ?? null,
        preferredProfileIds: stringIds(role.preferredProfileIds),
        fallbackProfileIds: stringIds(role.fallbackProfileIds),
      })),
    ),
    jsonBlock(
      "Role 摘要",
      detailedRoles(context, detail).map((role) => rolePayload(role, detail)),
    ),
    jsonBlock(
      "Profile 白名单",
      context.profiles.map((profile) => profilePayload(profile, detail)),
    ),
    jsonBlock("期望选择", projectedChoices(context.expectedChoices)),
    "",
    "## 九配方",
    "配方是参考，不是必须照抄。目录里没有的 Role 要标明缺失，不能当成已有；缺通用 Role 时可提示先同步预设。不要为凑配方新建超过 3 个 Role。",
    jsonBlock(
      "配方",
      TEAM_DESIGN_RECIPES.map((recipe) => recipePayload(recipe, detail)),
    ),
    "",
    outputTemplate(input),
  ].join("\n");
}

function compressed(input: DesignPromptInput, detail: PromptDetail): PromptDetail | null {
  const { context } = input;
  if (detail.notes === "full" && context.profiles.some((profile) => profile.notes)) {
    return { ...detail, notes: "none" };
  }
  if (detail.roleText === "full" && roleTextOmitted(detailedRoles(context, detail)).length > 0) {
    return { ...detail, roleText: "clamped" };
  }
  if (
    detail.recipeNotes &&
    TEAM_DESIGN_RECIPES.some((recipe) => recipeNote(recipe) !== undefined)
  ) {
    return { ...detail, recipeNotes: false };
  }
  if (!detail.relevantOnly && context.relevantRoleIds !== undefined) {
    return { ...detail, relevantOnly: true, roleText: "full" };
  }
  return null;
}

type BudgetFit = {
  ok: boolean;
  text: string;
  bytes: number;
  omissions: string[];
};

function withinBudget(input: DesignPromptInput, limit: number): BudgetFit {
  let detail = FULL_DETAIL;
  let text = "";
  let bytes = 0;
  for (;;) {
    text = compose(input, detail);
    bytes = utf8ByteLength(text);
    const omissions = omissionsFor(input.context, detail);
    if (bytes <= limit) return { ok: true, text, bytes, omissions };
    const next = compressed(input, detail);
    if (!next) return { ok: false, text, bytes, omissions };
    detail = next;
  }
}

/**
 * Compresses toward 30KiB. When that target is unreachable, keeps the fully
 * compressed result if it is still within the 60KiB hard cap.
 */
export function buildDesignKickoff(input: DesignPromptInput): PromptBuildResult {
  const fitted = withinBudget(input, DESIGN_KICKOFF_TARGET_BYTES);
  if (fitted.ok || fitted.bytes <= DESIGN_KICKOFF_MAX_BYTES) {
    return {
      ok: true,
      text: fitted.text,
      utf8Bytes: fitted.bytes,
      omissions: fitted.omissions,
    };
  }
  return { ok: false, issues: [inputTooLarge(fitted.bytes, DESIGN_KICKOFF_MAX_BYTES)] };
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
 * Repair prompt for attempts 2 and 3. Only the first 20 aggregated issues travel back; the job
 * keeps the rest. The previous model output is not echoed.
 */
export function buildDesignCorrection(input: {
  jobId: string;
  attempt: 1 | 2 | 3;
  nonce: string;
  issues: readonly DesignIssue[];
  context: DesignPromptContext;
  expectedChoices: readonly ExpectedDesignChoice[];
}): PromptBuildResult {
  const shown = input.issues.slice(0, MAX_CORRECTION_ISSUES);
  const hidden = input.issues.length - shown.length;
  const header = [
    "## 修正",
    `jobId=${input.jobId} attempt=${input.attempt}。nonce 只用于本轮输出身份核对，不是执行许可。`,
    "上一轮输出未通过校验。按下列聚合错误重写完整方案，只输出一个 agent-team-design fenced JSON 块，身份字段原样。不要复述上一轮全文。",
    jsonBlock("聚合错误", {
      issues: shown.map(issuePayload),
      omittedIssueCount: hidden,
    }),
    jsonBlock("准确期望", projectedChoices(input.expectedChoices)),
    "",
  ].join("\n");
  const bodyLimit = DESIGN_CORRECTION_MAX_BYTES - utf8ByteLength(header);
  const fitted = withinBudget(
    {
      jobId: input.jobId,
      attempt: input.attempt,
      nonce: input.nonce,
      context: { ...input.context, expectedChoices: input.expectedChoices },
    },
    bodyLimit,
  );
  if (!fitted.ok) {
    return {
      ok: false,
      issues: [inputTooLarge(utf8ByteLength(header) + fitted.bytes, DESIGN_CORRECTION_MAX_BYTES)],
    };
  }
  const text = `${header}${fitted.text}`;
  return {
    ok: true,
    text,
    utf8Bytes: utf8ByteLength(text),
    omissions: fitted.omissions,
  };
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

/**
 * Reference lineups copied from the 2026-10-25 recipe table. They are prompt material only:
 * importing them never creates Roles or Teams, and a missing catalog Role stays missing.
 */
export type TeamDesignRecipeMember = {
  roleId: string;
  minInstances: number;
  maxInstances: number;
};

export type TeamDesignRecipe = {
  id: string;
  name: string;
  coordinatorRoleId: string;
  members: readonly TeamDesignRecipeMember[];
  notes?: string;
};

export const TEAM_DESIGN_RECIPES = [
  {
    id: "feature",
    name: "功能开发",
    coordinatorRoleId: "lead-tech",
    members: [
      { roleId: "plan-architect", minInstances: 1, maxInstances: 1 },
      { roleId: "eng-fullstack", minInstances: 1, maxInstances: 1 },
      { roleId: "eng-frontend", minInstances: 1, maxInstances: 1 },
      { roleId: "qa-test", minInstances: 1, maxInstances: 1 },
      { roleId: "qa-review", minInstances: 1, maxInstances: 1 },
    ],
  },
  {
    id: "debugging",
    name: "疑难排障",
    coordinatorRoleId: "lead-tech",
    members: [
      { roleId: "research-codebase", minInstances: 1, maxInstances: 1 },
      { roleId: "eng-expert", minInstances: 1, maxInstances: 1 },
      { roleId: "qa-test", minInstances: 1, maxInstances: 1 },
      { roleId: "qa-review", minInstances: 1, maxInstances: 1 },
    ],
  },
  {
    id: "batch",
    name: "批量改造",
    coordinatorRoleId: "lead-tech",
    members: [
      { roleId: "plan-architect", minInstances: 1, maxInstances: 1 },
      { roleId: "eng-batch", minInstances: 2, maxInstances: 3 },
      { roleId: "qa-test", minInstances: 1, maxInstances: 1 },
      { roleId: "qa-review", minInstances: 1, maxInstances: 1 },
    ],
    notes: "批量开发 ×2–3，用实例标签区分，如 A / B",
  },
  {
    id: "release-check",
    name: "上线前检查",
    coordinatorRoleId: "lead-tech",
    members: [
      { roleId: "qa-security", minInstances: 1, maxInstances: 1 },
      { roleId: "qa-acceptance", minInstances: 1, maxInstances: 1 },
      { roleId: "eng-ops", minInstances: 1, maxInstances: 1 },
    ],
  },
  {
    id: "technical-research",
    name: "技术调研",
    coordinatorRoleId: "lead-research",
    members: [
      { roleId: "research-web", minInstances: 1, maxInstances: 1 },
      { roleId: "research-codebase", minInstances: 1, maxInstances: 1 },
      { roleId: "research-docs", minInstances: 1, maxInstances: 1 },
    ],
  },
  {
    id: "materials",
    name: "资料与截图研读",
    coordinatorRoleId: "lead-research",
    members: [
      { roleId: "research-docs", minInstances: 1, maxInstances: 1 },
      { roleId: "research-vision", minInstances: 1, maxInstances: 1 },
    ],
  },
  {
    id: "creative-content",
    name: "文案、脚本、视频文案",
    coordinatorRoleId: "lead-content",
    members: [
      { roleId: "research-web", minInstances: 1, maxInstances: 1 },
      { roleId: "content-creative", minInstances: 1, maxInstances: 1 },
      { roleId: "content-editor", minInstances: 1, maxInstances: 1 },
    ],
  },
  {
    id: "technical-writing",
    name: "技术文档",
    coordinatorRoleId: "lead-content",
    members: [
      { roleId: "research-codebase", minInstances: 1, maxInstances: 1 },
      { roleId: "content-technical", minInstances: 1, maxInstances: 1 },
      { roleId: "content-editor", minInstances: 1, maxInstances: 1 },
    ],
  },
  {
    id: "cross-domain",
    name: "跨领域",
    coordinatorRoleId: "lead-orchestrator",
    members: [
      { roleId: "research-web", minInstances: 1, maxInstances: 1 },
      { roleId: "plan-architect", minInstances: 1, maxInstances: 1 },
      { roleId: "eng-fullstack", minInstances: 1, maxInstances: 1 },
      { roleId: "qa-review", minInstances: 1, maxInstances: 1 },
      { roleId: "content-creative", minInstances: 1, maxInstances: 1 },
    ],
    notes: "调研→开发→发布文案",
  },
] as const satisfies readonly TeamDesignRecipe[];

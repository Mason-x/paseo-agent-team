import type { Role } from "../schemas/role";
import type { RoleTier, TaskKind } from "../schemas/team-mode";

// Pure role-tier resolution. No IO, React, Node, or SDK imports: callers pass Roles and receive a
// result plus typed issues. The catalog generator imports this module directly through Node's
// type stripping, so every import here must stay type-only (no zod or other runtime imports).
// The runtime lists are declared locally for the same reason.
const TIER_FLAGS: Readonly<Record<RoleTier, true>> = {
  decision: true,
  execution: true,
  escalation: true,
  retain: true,
};

const TASK_KIND_FLAGS: Readonly<Record<TaskKind, true>> = {
  coding: true,
  testing: true,
  acceptance: true,
  codebase: true,
  ops: true,
  general: true,
};

export function isRoleTier(value: string): value is RoleTier {
  return Object.hasOwn(TIER_FLAGS, value);
}

export function isTaskKind(value: string): value is TaskKind {
  return Object.hasOwn(TASK_KIND_FLAGS, value);
}

// Stable identifiers for mode planning, following the design's error table. Rendered text belongs
// in shared/zh.ts; callers assert on code/params and localize at the boundary.
export const MODE_ISSUE_CODES = [
  "MODE_UNKNOWN",
  "MODE_ROLE_POLICY_UNKNOWN",
  "MODE_CONTEXT_UNAVAILABLE",
  "MODE_POOL_EMPTY",
  "MODE_POOL_UNAVAILABLE",
  "MODE_POOL_CONFIG_INVALID",
  "MODE_POOL_ENTRY_MISSING",
  "MODE_POOL_DUPLICATE",
  "MODE_POOL_ORDER_IGNORED",
  "MODE_FAMILY_MISSING",
  "MODE_FAMILIES_REDUCED",
  "MODE_COLLAB_UNAVAILABLE",
  "MODE_NO_EXECUTION_COHORT",
  "MODE_PROFILE_UNRESOLVED",
  "MODE_ROLE_DISABLED",
  "MODE_JUDGE_REQUIRED",
  "MODE_ESCALATION_INVALID",
  "MODE_ESCALATION_UNAVAILABLE",
  "MODE_SEAT_DUPLICATE",
  "MODE_MEMBER_LIMIT",
  "MODE_LIMIT_CLAMPED",
  "MODE_ONDEMAND_FALLBACK_EAGER",
  "MODE_ONDEMAND_UNAVAILABLE",
  "MODE_PLAN_CHANGED",
] as const;

export type ModeIssueCode = (typeof MODE_ISSUE_CODES)[number];

export type ModeIssue = {
  code: ModeIssueCode;
  severity: "warning" | "blocker";
  roleId?: string;
  seatId?: string;
  profileId?: string;
  params: Readonly<Record<string, string | number | boolean>>;
};

// Success carries only warnings; a failure lists every blocker that prevented resolution.
export type Result<T, E> = { ok: true; value: T; issues?: E } | { ok: false; issues: E };

export type RoleExecutionPolicy = { tier: RoleTier; taskKind: TaskKind };

// Defaults for the 22 built-in presets. Explicitly stored fields on a Role always win, and an
// unknown custom Role keeps its original binding (retain/general).
export const DEFAULT_ROLE_EXECUTION: Readonly<Record<string, RoleExecutionPolicy | undefined>> = {
  "lead-orchestrator": { tier: "decision", taskKind: "general" },
  "lead-tech": { tier: "decision", taskKind: "general" },
  "lead-research": { tier: "decision", taskKind: "general" },
  "lead-content": { tier: "decision", taskKind: "general" },
  "plan-requirements": { tier: "decision", taskKind: "general" },
  "plan-architect": { tier: "decision", taskKind: "general" },
  "qa-review": { tier: "decision", taskKind: "general" },
  "qa-security": { tier: "decision", taskKind: "general" },
  "eng-expert": { tier: "escalation", taskKind: "coding" },
  "eng-fullstack": { tier: "execution", taskKind: "coding" },
  "eng-frontend": { tier: "execution", taskKind: "coding" },
  "eng-batch": { tier: "execution", taskKind: "coding" },
  "eng-ops": { tier: "execution", taskKind: "ops" },
  "qa-test": { tier: "execution", taskKind: "testing" },
  "qa-acceptance": { tier: "execution", taskKind: "acceptance" },
  // The only research Role that runs work rather than producing a briefing.
  "research-codebase": { tier: "execution", taskKind: "codebase" },
  "research-web": { tier: "retain", taskKind: "general" },
  "research-docs": { tier: "retain", taskKind: "general" },
  "research-vision": { tier: "retain", taskKind: "general" },
  "content-creative": { tier: "retain", taskKind: "general" },
  "content-technical": { tier: "retain", taskKind: "general" },
  "content-editor": { tier: "retain", taskKind: "general" },
};

export function issueValue(value: unknown): string | number | boolean {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function unknownPolicyIssue(
  role: Role,
  field: "tier" | "taskKind",
  value: unknown,
  severity: "warning" | "blocker",
): ModeIssue {
  return {
    code: "MODE_ROLE_POLICY_UNKNOWN",
    severity,
    roleId: role.id,
    params: { field, value: issueValue(value) },
  };
}

/**
 * Resolution order: a valid explicit field, then the known-id default for that same field, then
 * retain (tier) / general (task kind). An explicit value this version cannot interpret is a
 * blocker for member seats rather than a silent fallback to the compatibility table. Coordinator
 * seats ignore their tier and use the decision tier, so their invalid value is only a warning.
 */
export function resolveRoleExecution(
  role: Role,
  kind: "coordinator" | "member",
): Result<RoleExecutionPolicy, ModeIssue[]> {
  const explicit = role.executionPolicy;
  const known = DEFAULT_ROLE_EXECUTION[role.id];
  const issues: ModeIssue[] = [];
  const severity = kind === "coordinator" ? "warning" : "blocker";

  let tier: RoleTier | undefined;
  if (explicit?.tier !== undefined) {
    if (typeof explicit.tier === "string" && isRoleTier(explicit.tier)) tier = explicit.tier;
    else issues.push(unknownPolicyIssue(role, "tier", explicit.tier, severity));
  }

  let taskKind: TaskKind | undefined;
  if (explicit?.taskKind !== undefined) {
    if (typeof explicit.taskKind === "string" && isTaskKind(explicit.taskKind)) {
      taskKind = explicit.taskKind;
    } else {
      issues.push(unknownPolicyIssue(role, "taskKind", explicit.taskKind, severity));
    }
  }

  if (issues.some((issue) => issue.severity === "blocker")) return { ok: false, issues };

  return {
    ok: true,
    value: {
      tier: kind === "coordinator" ? "decision" : (tier ?? known?.tier ?? "retain"),
      taskKind: taskKind ?? known?.taskKind ?? "general",
    },
    ...(issues.length === 0 ? {} : { issues }),
  };
}

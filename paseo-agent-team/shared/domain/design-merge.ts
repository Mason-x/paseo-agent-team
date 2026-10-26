import type { DesignBaseRevisions, DesignIssue, DesignResult } from "../schemas/design";
import type { Preferences } from "../schemas/preferences";
import type { Role } from "../schemas/role";
import { RoleSchema } from "../schemas/role";
import type { Team } from "../schemas/team";
import { TeamSchema } from "../schemas/team";
import type { RolesDocument, TeamsDocument } from "../settings";
import { canonicalDesignContent } from "./design-content";
import { finalizeDesignIssues } from "./design-validation";

export type DesignSnapshot<T> = { values: T; revision: string };

export type DesignMergeInput = {
  roles: DesignSnapshot<RolesDocument>;
  teams: DesignSnapshot<TeamsDocument>;
  preferences: DesignSnapshot<Preferences>;
  result: DesignResult;
  base: DesignBaseRevisions;
};

export type DesignMergeResult =
  | {
      kind: "write";
      roles: RolesDocument;
      teams: TeamsDocument;
      rolesChanged: boolean;
      teamsChanged: boolean;
      addedRoleIds: string[];
      teamId: string;
    }
  | { kind: "already-saved"; teamId: string; modified: boolean }
  | { kind: "blocked"; issues: DesignIssue[] };

export type SavedDesignCheck =
  | { kind: "none" }
  | { kind: "roles-only"; roleIds: string[] }
  | { kind: "committed"; teamId: string; modified: boolean }
  | { kind: "conflict"; issues: DesignIssue[] };

export type DesignCompensationPlan = {
  roles: RolesDocument;
  removeRoleIds: string[];
  retainedRoleIds: string[];
  issues: DesignIssue[];
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function issue(
  code: DesignIssue["code"],
  path: DesignIssue["path"],
  params: DesignIssue["params"] = {},
  action: DesignIssue["action"] = "retry-save",
): DesignIssue {
  return { code, severity: "error", path, params, action };
}

function blocked(issues: readonly DesignIssue[]): DesignMergeResult {
  return { kind: "blocked", issues: finalizeDesignIssues(issues).issues };
}

function conflictResult(issues: readonly DesignIssue[]): SavedDesignCheck {
  return { kind: "conflict", issues: finalizeDesignIssues(issues).issues };
}

function schemaIssues(
  errors: readonly { path: readonly PropertyKey[]; message: string }[],
  prefix: DesignIssue["path"],
): DesignIssue[] {
  return errors.map((entry) => {
    const path = [
      ...prefix,
      ...entry.path.map((part) => (typeof part === "number" ? part : String(part))),
    ];
    return issue("DESIGN_OUTPUT_SCHEMA", path, {
      path: path.length === 0 ? "(root)" : path.join("."),
    });
  });
}

function normalizeRoleName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function designerJobId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("jobId" in value)) return undefined;
  return typeof value.jobId === "string" ? value.jobId : undefined;
}

function sameJob(value: unknown, jobId: string): boolean {
  if (!value || typeof value !== "object") return false;
  const source = "source" in value ? value.source : undefined;
  const designer = "designer" in value ? value.designer : undefined;
  return source === "team-designer" && designerJobId(designer) === jobId;
}

function sameContent(left: unknown, right: unknown): boolean {
  return canonicalDesignContent(left) === canonicalDesignContent(right);
}

function teamRoleIds(team: Team): string[] {
  const ids = [team.coordinatorRoleId, ...team.members.map((member) => member.roleId)];
  const collaboration = team.collaboration;
  if (collaboration) {
    if (typeof collaboration.judgeRoleId === "string") ids.push(collaboration.judgeRoleId);
    if (typeof collaboration.escalationRoleId === "string") {
      ids.push(collaboration.escalationRoleId);
    }
  }
  return [...new Set(ids)];
}

function revisionIssue(field: "roles" | "teams" | "preferences"): DesignIssue {
  return issue("DESIGN_SAVE_CONFLICT", ["base", field], { field });
}

export function mergeDesign(input: DesignMergeInput): DesignMergeResult {
  const revisions: DesignIssue[] = [];
  if (input.roles.revision !== input.base.roles) revisions.push(revisionIssue("roles"));
  if (input.teams.revision !== input.base.teams) revisions.push(revisionIssue("teams"));
  if (input.preferences.revision !== input.base.preferences) {
    revisions.push(revisionIssue("preferences"));
  }
  if (revisions.length > 0) return blocked(revisions);

  const result = input.result;
  const teamParsed = TeamSchema.safeParse(result.team);
  if (!teamParsed.success) {
    return blocked(schemaIssues(teamParsed.error.issues, ["team"]));
  }
  const team = teamParsed.data;
  const resultRoleIds = new Set<string>();
  const resultRoles: Role[] = [];
  const resultIssues: DesignIssue[] = [];
  result.newRoles.forEach((candidate, index) => {
    const parsed = RoleSchema.safeParse(candidate);
    if (!parsed.success) {
      resultIssues.push(...schemaIssues(parsed.error.issues, ["newRoles", index]));
      return;
    }
    if (resultRoleIds.has(parsed.data.id)) {
      resultIssues.push(
        issue("DESIGN_ROLE_ID_CONFLICT", ["newRoles", index, "id"], {
          roleId: parsed.data.id,
        }),
      );
      return;
    }
    resultRoleIds.add(parsed.data.id);
    resultRoles.push(parsed.data);
  });
  if (resultIssues.length > 0) return blocked(resultIssues);

  const currentRoles = input.roles.values.roles;
  const roles = [...currentRoles];
  const names = new Set(currentRoles.map((candidate) => normalizeRoleName(candidate.name)));
  const addedRoleIds: string[] = [];
  const issues: DesignIssue[] = [];
  for (const [index, candidate] of resultRoles.entries()) {
    const existingIndex = roles.findIndex((role) => role.id === candidate.id);
    if (existingIndex >= 0) {
      const existing = roles[existingIndex];
      if (!existing) continue;
      if (sameJob(existing, result.jobId) && sameContent(existing, candidate)) continue;
      issues.push(
        issue("DESIGN_ROLE_ID_CONFLICT", ["newRoles", index, "id"], {
          roleId: candidate.id,
        }),
      );
      continue;
    }
    const normalizedName = normalizeRoleName(candidate.name);
    if (names.has(normalizedName)) {
      issues.push(
        issue("DESIGN_ROLE_NAME_CONFLICT", ["newRoles", index, "name"], {
          name: candidate.name,
        }),
      );
      continue;
    }
    names.add(normalizedName);
    roles.push(candidate);
    addedRoleIds.push(candidate.id);
  }
  if (issues.length > 0) return blocked(issues);

  const roleIds = new Map(roles.map((role) => [role.id, role]));
  for (const roleId of teamRoleIds(team)) {
    const role = roleIds.get(roleId);
    if (!role?.enabled) {
      issues.push(
        issue("DESIGN_TEAM_INVALID", ["team"], {
          roleId,
        }),
      );
    }
  }
  for (const reuse of result.reuse) {
    if (resultRoleIds.has(reuse.roleId)) {
      issues.push(issue("DESIGN_REUSE_INVALID", ["reuse"], { roleId: reuse.roleId }));
      continue;
    }
    const role = roles.find((candidate) => candidate.id === reuse.roleId);
    if (!role?.enabled) {
      issues.push(issue("DESIGN_REUSE_INVALID", ["reuse"], { roleId: reuse.roleId }));
    }
  }
  if (issues.length > 0) return blocked(issues);

  // Idempotency is by jobId, not by the Team id alone: another id for this job, or two Teams
  // claiming this job, is an ambiguous save and must never append a third Team.
  const jobTeams = input.teams.values.teams.filter((candidate) => sameJob(candidate, result.jobId));
  if (jobTeams.length > 1) {
    return blocked([
      issue("DESIGN_TEAM_ID_CONFLICT", ["team", "id"], { teamId: team.id }, "inspect"),
    ]);
  }
  const sameIdTeams = input.teams.values.teams.filter((candidate) => candidate.id === team.id);
  if (sameIdTeams.length > 1) {
    return blocked([
      issue("DESIGN_TEAM_ID_CONFLICT", ["team", "id"], { teamId: team.id }, "inspect"),
    ]);
  }

  const existingTeam = jobTeams[0];
  if (existingTeam && existingTeam.id !== team.id) {
    return blocked([
      issue("DESIGN_TEAM_ID_CONFLICT", ["team", "id"], { teamId: team.id }, "inspect"),
    ]);
  }
  if (!existingTeam) {
    if (sameIdTeams.length > 0) {
      return blocked([
        issue("DESIGN_TEAM_ID_CONFLICT", ["team", "id"], { teamId: team.id }, "inspect"),
      ]);
    }
    return {
      kind: "write",
      roles: { ...input.roles.values, roles },
      teams: { ...input.teams.values, teams: [...input.teams.values.teams, team] },
      rolesChanged: addedRoleIds.length > 0,
      teamsChanged: true,
      addedRoleIds,
      teamId: team.id,
    };
  }

  const modified =
    !sameContent(existingTeam, team) ||
    resultRoles.some((candidate) => {
      const existing = currentRoles.find((role) => role.id === candidate.id);
      return existing !== undefined && !sameContent(existing, candidate);
    });

  if (addedRoleIds.length > 0) {
    return {
      kind: "write",
      roles: { ...input.roles.values, roles },
      teams: { ...input.teams.values },
      rolesChanged: true,
      teamsChanged: false,
      addedRoleIds,
      teamId: team.id,
    };
  }
  return { kind: "already-saved", teamId: team.id, modified };
}

export function verifySavedDesign(input: {
  roles: RolesDocument;
  teams: TeamsDocument;
  result: DesignResult;
}): SavedDesignCheck {
  const result = input.result;
  const jobTeams = input.teams.teams.filter((team) => sameJob(team, result.jobId));
  if (jobTeams.length > 1) {
    return conflictResult([
      issue("DESIGN_TEAM_ID_CONFLICT", ["team", "id"], { teamId: result.team.id }, "inspect"),
    ]);
  }
  if (jobTeams[0] && jobTeams[0].id !== result.team.id) {
    return conflictResult([
      issue("DESIGN_TEAM_ID_CONFLICT", ["team", "id"], { teamId: result.team.id }, "inspect"),
    ]);
  }
  const sameIdTeams = input.teams.teams.filter((team) => team.id === result.team.id);
  if (sameIdTeams.length > 1) {
    return conflictResult([
      issue("DESIGN_TEAM_ID_CONFLICT", ["team", "id"], { teamId: result.team.id }, "inspect"),
    ]);
  }
  if (jobTeams.length === 0 && sameIdTeams.length > 0) {
    return conflictResult([
      issue("DESIGN_TEAM_ID_CONFLICT", ["team", "id"], { teamId: result.team.id }, "inspect"),
    ]);
  }

  const roleById = new Map(input.roles.roles.map((role) => [role.id, role]));
  const roleIssues: DesignIssue[] = [];
  const presentRoleIds: string[] = [];
  for (const candidate of result.newRoles) {
    const existing = roleById.get(candidate.id);
    if (!existing) continue;
    if (!sameJob(existing, result.jobId)) {
      roleIssues.push(
        issue("DESIGN_COMPENSATION_UNSAFE", ["newRoles"], { roleId: candidate.id }, "inspect"),
      );
      continue;
    }
    presentRoleIds.push(candidate.id);
  }
  if (roleIssues.length > 0) return conflictResult(roleIssues);

  if (jobTeams.length === 0) {
    if (presentRoleIds.length === 0) return { kind: "none" };
    return { kind: "roles-only", roleIds: [...presentRoleIds].sort() };
  }

  const team = jobTeams[0];
  if (!team) return { kind: "none" };
  const conflicts: DesignIssue[] = [];
  for (const roleId of teamRoleIds(team)) {
    const role = roleById.get(roleId);
    if (!role?.enabled) {
      conflicts.push(issue("DESIGN_REUSE_INVALID", ["team"], { roleId }));
    }
  }
  for (const candidate of result.newRoles) {
    const existing = roleById.get(candidate.id);
    if (!existing) {
      conflicts.push(issue("DESIGN_REUSE_INVALID", ["newRoles"], { roleId: candidate.id }));
    } else if (!sameJob(existing, result.jobId)) {
      conflicts.push(
        issue("DESIGN_COMPENSATION_UNSAFE", ["newRoles"], { roleId: candidate.id }, "inspect"),
      );
    }
  }
  if (conflicts.length > 0) return conflictResult(conflicts);

  const modified =
    !sameContent(team, result.team) ||
    result.newRoles.some((candidate) => {
      const existing = roleById.get(candidate.id);
      return existing !== undefined && !sameContent(existing, candidate);
    });
  return { kind: "committed", teamId: team.id, modified };
}

export function planDesignCompensation(input: {
  roles: DesignSnapshot<RolesDocument>;
  teams: DesignSnapshot<TeamsDocument>;
  result: DesignResult;
  authorizedRoleIds: readonly string[];
}): DesignCompensationPlan {
  const resultRoles = new Map(input.result.newRoles.map((role) => [role.id, role]));
  const authorized = new Set(input.authorizedRoleIds);
  const referenced = new Set(input.teams.values.teams.flatMap((team) => teamRoleIds(team)));
  const removeRoleIds = new Set<string>();
  const retainedRoleIds = new Set<string>();
  const issues: DesignIssue[] = [];

  for (const [index, existing] of input.roles.values.roles.entries()) {
    const expected = resultRoles.get(existing.id);
    if (!expected) continue;
    if (!authorized.has(existing.id)) {
      retainedRoleIds.add(existing.id);
      continue;
    }
    const safe =
      sameJob(existing, input.result.jobId) &&
      sameContent(existing, expected) &&
      !referenced.has(existing.id);
    if (safe) {
      removeRoleIds.add(existing.id);
    } else {
      retainedRoleIds.add(existing.id);
      issues.push(
        issue(
          "DESIGN_COMPENSATION_UNSAFE",
          ["roles", index],
          {
            roleId: existing.id,
          },
          "inspect",
        ),
      );
    }
  }

  return {
    roles: {
      ...input.roles.values,
      roles: input.roles.values.roles.filter((role) => !removeRoleIds.has(role.id)),
    },
    removeRoleIds: [...removeRoleIds].sort(compareText),
    retainedRoleIds: [...retainedRoleIds].sort(compareText),
    issues: finalizeDesignIssues(issues).issues,
  };
}

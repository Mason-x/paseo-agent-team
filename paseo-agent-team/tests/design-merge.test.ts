import { describe, expect, test } from "vitest";
import type { DesignSnapshot } from "../shared/domain/design-merge";
import {
  mergeDesign,
  planDesignCompensation,
  verifySavedDesign,
} from "../shared/domain/design-merge";
import type { DesignResult } from "../shared/schemas/design";
import { PreferencesSchema } from "../shared/schemas/preferences";
import type { Role } from "../shared/schemas/role";
import { RoleSchema } from "../shared/schemas/role";
import type { Team } from "../shared/schemas/team";
import type { RolesDocument, TeamsDocument } from "../shared/settings";
import { DESIGN_HASH, DESIGN_JOB_ID, designResult } from "./design-fixtures";
import { architect, developer, NOW, techLead } from "./fixtures";

const ORIGIN = { jobId: DESIGN_JOB_ID, createdAt: NOW, requestExcerpt: "给后台做一次改版" };
const OTHER_JOB = "99999999-9999-4999-8999-999999999999";

const newRole = RoleSchema.parse({
  ...architect,
  id: "eng-rework",
  name: "【工程】改版专员",
  source: "team-designer",
  designer: ORIGIN,
  createdAt: NOW,
  updatedAt: NOW,
});

const reusedRoles = [techLead, architect, developer];

function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    ...designResult().team,
    id: "rework-team",
    name: "改版 Team",
    mode: "sota",
    memberCreation: "eager",
    source: "team-designer",
    designer: ORIGIN,
    coordinatorRoleId: "tech-lead",
    members: [
      { roleId: "architect", instanceLabel: "架构", seatId: "seat-m1", enabled: true },
      { roleId: "developer", instanceLabel: "实现", seatId: "seat-m2", enabled: true },
      { roleId: "eng-rework", instanceLabel: "新增", seatId: "seat-m3", enabled: true },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeReuse(): DesignResult["reuse"] {
  return reusedRoles.map((role) => ({
    roleId: role.id,
    behaviorHash: DESIGN_HASH,
    reason: `复用 ${role.name}`,
  }));
}

function makeResult(overrides: Partial<DesignResult> = {}): DesignResult {
  return designResult({
    team: makeTeam(),
    newRoles: [newRole],
    reuse: makeReuse(),
    ...overrides,
  });
}

function rolesDocument(roles: Role[] = reusedRoles): RolesDocument {
  return { roles };
}

function teamsDocument(teams: Team[] = []): TeamsDocument {
  return { teams };
}

function baseInput(result: DesignResult = makeResult()) {
  return {
    roles: { values: rolesDocument(), revision: "r1" },
    teams: { values: teamsDocument(), revision: "t1" },
    preferences: { values: PreferencesSchema.parse({ maxMembers: 24 }), revision: "p1" },
    result,
    base: { roles: "r1", teams: "t1", preferences: "p1" },
  };
}

function errorCodes(issues: readonly { code: string; severity: string }[]): string[] {
  return issues.filter((issue) => issue.severity === "error").map((issue) => issue.code);
}

class CasStore<T> {
  private value: T;
  private revision = 1;

  constructor(initial: T) {
    this.value = structuredClone(initial);
  }

  read(): DesignSnapshot<T> {
    return { values: structuredClone(this.value), revision: `r${this.revision}` };
  }

  write(next: T, expected: string): boolean {
    if (expected !== `r${this.revision}`) return false;
    this.value = structuredClone(next);
    this.revision += 1;
    return true;
  }
}

describe("mergeDesign", () => {
  test("blocks stale revisions for any of the three documents", () => {
    const result = mergeDesign({
      ...baseInput(),
      roles: { values: rolesDocument(), revision: "r2" },
      teams: { values: teamsDocument(), revision: "t2" },
      preferences: { values: PreferencesSchema.parse({ maxMembers: 24 }), revision: "p2" },
    });
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(errorCodes(result.issues)).toContain("DESIGN_SAVE_CONFLICT");
      expect(result.issues).toHaveLength(3);
    }
  });

  test("writes a Team with no new Roles", () => {
    const result = makeResult({ newRoles: [] });
    const team = makeTeam({
      members: makeTeam().members.filter((member) => member.roleId !== "eng-rework"),
    });
    const merged = mergeDesign(baseInput({ ...result, team }));
    expect(merged.kind).toBe("write");
    if (merged.kind === "write") {
      expect(merged.rolesChanged).toBe(false);
      expect(merged.teamsChanged).toBe(true);
      expect(merged.addedRoleIds).toEqual([]);
      expect(merged.teams.teams).toHaveLength(1);
    }
  });

  test("appends three new Roles and preserves unrelated rows and extensions", () => {
    const extraRole = RoleSchema.parse({
      ...architect,
      id: "legacy-role",
      name: "Legacy",
      future: "kept",
    });
    const extraTeam = {
      ...makeTeam(),
      id: "other-team",
      name: "Other",
      source: "preset",
      designer: undefined,
      futureTeamField: "kept",
    };
    const roles = ["a", "b", "c"].map((suffix) =>
      RoleSchema.parse({
        ...newRole,
        id: `eng-${suffix}`,
        name: `【工程】${suffix.toUpperCase()}`,
      }),
    );
    const team = makeTeam({
      members: [
        ...makeTeam().members.filter((member) => member.roleId !== "eng-rework"),
        ...roles.map((role, index) => ({
          roleId: role.id,
          instanceLabel: `New ${index + 1}`,
          seatId: `seat-${index + 3}`,
          enabled: true,
        })),
      ],
    });
    const result = makeResult({ team, newRoles: roles });
    const merged = mergeDesign({
      ...baseInput(result),
      roles: { values: rolesDocument([...reusedRoles, extraRole]), revision: "r1" },
      teams: { values: teamsDocument([extraTeam]), revision: "t1" },
    });
    expect(merged.kind).toBe("write");
    if (merged.kind === "write") {
      expect(merged.addedRoleIds.sort()).toEqual(["eng-a", "eng-b", "eng-c"]);
      expect(merged.roles.roles.map((role) => role.id)).toEqual([
        "tech-lead",
        "architect",
        "developer",
        "legacy-role",
        "eng-a",
        "eng-b",
        "eng-c",
      ]);
      expect(merged.roles.roles.find((role) => role.id === "legacy-role")).toMatchObject({
        future: "kept",
      });
      expect(merged.teams.teams.find((candidate) => candidate.id === "other-team")).toMatchObject({
        futureTeamField: "kept",
      });
    }
  });

  test("skips a partially written same-job Role and appends only the missing one", () => {
    const second = RoleSchema.parse({
      ...newRole,
      id: "eng-second",
      name: "【工程】第二专员",
    });
    const team = makeTeam({
      members: [
        ...makeTeam().members,
        { roleId: second.id, instanceLabel: "第二", seatId: "seat-m4", enabled: true },
      ],
    });
    const result = makeResult({ team, newRoles: [newRole, second] });
    const merged = mergeDesign({
      ...baseInput(result),
      roles: { values: rolesDocument([...reusedRoles, newRole]), revision: "r1" },
    });
    expect(merged.kind).toBe("write");
    if (merged.kind === "write") {
      expect(merged.addedRoleIds).toEqual(["eng-second"]);
      expect(merged.rolesChanged).toBe(true);
    }
  });

  test("writes missing Roles even when the same-job Team already exists", () => {
    const merged = mergeDesign({
      ...baseInput(),
      roles: { values: rolesDocument(), revision: "r1" },
      teams: { values: teamsDocument([makeTeam()]), revision: "t1" },
    });
    expect(merged.kind).toBe("write");
    if (merged.kind === "write") {
      expect(merged.rolesChanged).toBe(true);
      expect(merged.teamsChanged).toBe(false);
      expect(merged.addedRoleIds).toEqual(["eng-rework"]);
      expect(merged.roles.roles.map((role) => role.id)).toContain("eng-rework");
      expect(merged.teams.teams).toHaveLength(1);
    }
  });

  test("reports an already-saved Team and a user-modified copy without overwriting", () => {
    const team = makeTeam();
    const saved = mergeDesign({
      ...baseInput(),
      roles: { values: rolesDocument([...reusedRoles, newRole]), revision: "r1" },
      teams: { values: teamsDocument([team]), revision: "t1" },
    });
    expect(saved).toEqual({ kind: "already-saved", teamId: "rework-team", modified: false });

    const modified = mergeDesign({
      ...baseInput(),
      roles: { values: rolesDocument([...reusedRoles, newRole]), revision: "r1" },
      teams: { values: teamsDocument([{ ...team, name: "用户改名" }]), revision: "t1" },
    });
    expect(modified).toEqual({ kind: "already-saved", teamId: "rework-team", modified: true });
  });

  test("blocks Team id conflicts, multiple same-id Teams, and edited same-job Roles", () => {
    const otherJobTeam = makeTeam({ designer: { jobId: OTHER_JOB, createdAt: NOW } });
    const foreign = mergeDesign({
      ...baseInput(),
      teams: { values: teamsDocument([otherJobTeam]), revision: "t1" },
    });
    expect(foreign.kind).toBe("blocked");
    if (foreign.kind === "blocked") {
      expect(errorCodes(foreign.issues)).toContain("DESIGN_TEAM_ID_CONFLICT");
    }

    const duplicate = mergeDesign({
      ...baseInput(),
      teams: { values: teamsDocument([makeTeam(), makeTeam({ name: "second" })]), revision: "t1" },
    });
    expect(duplicate.kind).toBe("blocked");
    if (duplicate.kind === "blocked") {
      expect(errorCodes(duplicate.issues)).toContain("DESIGN_TEAM_ID_CONFLICT");
    }

    const disabledRef = { ...developer, enabled: false };
    const disabled = mergeDesign({
      ...baseInput(),
      roles: { values: rolesDocument([techLead, architect, disabledRef]), revision: "r1" },
    });
    expect(disabled.kind).toBe("blocked");
    if (disabled.kind === "blocked") {
      expect(errorCodes(disabled.issues)).toContain("DESIGN_TEAM_INVALID");
    }

    const invalidTeam = makeResult({ team: { ...makeTeam(), id: "Bad Team" } });
    const invalid = mergeDesign(baseInput(invalidTeam));
    expect(invalid.kind).toBe("blocked");
    if (invalid.kind === "blocked") {
      expect(errorCodes(invalid.issues)).toContain("DESIGN_OUTPUT_SCHEMA");
    }

    const editedRole = RoleSchema.parse({ ...newRole, systemPrompt: "different" });
    const edited = mergeDesign({
      ...baseInput(),
      roles: { values: rolesDocument([...reusedRoles, editedRole]), revision: "r1" },
    });
    expect(edited.kind).toBe("blocked");
    if (edited.kind === "blocked") {
      expect(errorCodes(edited.issues)).toContain("DESIGN_ROLE_ID_CONFLICT");
    }
  });

  test("deduplicates Teams by jobId even when the frozen Team id differs", () => {
    const sameJobOther = { ...makeTeam(), id: "same-job-other-team" };
    const roles = rolesDocument([...reusedRoles, newRole]);
    const oneOther = mergeDesign({
      ...baseInput(),
      roles: { values: roles, revision: "r1" },
      teams: { values: teamsDocument([sameJobOther]), revision: "t1" },
    });
    expect(oneOther.kind).toBe("blocked");
    if (oneOther.kind === "blocked") {
      expect(errorCodes(oneOther.issues)).toContain("DESIGN_TEAM_ID_CONFLICT");
    }
    expect(
      verifySavedDesign({ roles, teams: teamsDocument([sameJobOther]), result: makeResult() }),
    ).toMatchObject({ kind: "conflict" });

    const twoOther = mergeDesign({
      ...baseInput(),
      roles: { values: roles, revision: "r1" },
      teams: {
        values: teamsDocument([sameJobOther, { ...sameJobOther, id: "same-job-third" }]),
        revision: "t1",
      },
    });
    expect(twoOther.kind).toBe("blocked");
    if (twoOther.kind === "blocked") {
      expect(errorCodes(twoOther.issues)).toContain("DESIGN_TEAM_ID_CONFLICT");
    }
    expect(
      verifySavedDesign({
        roles,
        teams: teamsDocument([sameJobOther, { ...sameJobOther, id: "same-job-third" }]),
        result: makeResult(),
      }),
    ).toMatchObject({ kind: "conflict" });

    const sameIdOtherJob = { ...makeTeam(), designer: { jobId: OTHER_JOB } };
    const foreign = mergeDesign({
      ...baseInput(),
      roles: { values: roles, revision: "r1" },
      teams: { values: teamsDocument([sameIdOtherJob]), revision: "t1" },
    });
    expect(foreign.kind).toBe("blocked");
    if (foreign.kind === "blocked") {
      expect(errorCodes(foreign.issues)).toContain("DESIGN_TEAM_ID_CONFLICT");
    }
    expect(
      verifySavedDesign({ roles, teams: teamsDocument([sameIdOtherJob]), result: makeResult() }),
    ).toMatchObject({ kind: "conflict" });

    const copied = {
      ...makeTeam(),
      id: "copied-team",
      source: "preset",
      designer: undefined,
    };
    const copiedMerge = mergeDesign({
      ...baseInput(),
      roles: { values: roles, revision: "r1" },
      teams: { values: teamsDocument([copied]), revision: "t1" },
    });
    expect(copiedMerge.kind).toBe("write");
    if (copiedMerge.kind === "write") {
      expect(copiedMerge.teamsChanged).toBe(true);
      expect(copiedMerge.teams.teams.map((team) => team.id)).toEqual([
        "copied-team",
        "rework-team",
      ]);
    }
    expect(
      verifySavedDesign({ roles, teams: teamsDocument([copied]), result: makeResult() }),
    ).toEqual({ kind: "roles-only", roleIds: ["eng-rework"] });
  });

  test("blocks missing reuse Roles and normalized name collisions", () => {
    const missingReuse = mergeDesign({
      ...baseInput(),
      roles: { values: rolesDocument([techLead, architect]), revision: "r1" },
    });
    expect(missingReuse.kind).toBe("blocked");
    if (missingReuse.kind === "blocked") {
      expect(errorCodes(missingReuse.issues)).toContain("DESIGN_REUSE_INVALID");
    }

    const colliding = RoleSchema.parse({
      ...architect,
      id: "legacy-eng",
      name: "【工程】改版专员",
    });
    const collision = mergeDesign({
      ...baseInput(),
      roles: { values: rolesDocument([...reusedRoles, colliding]), revision: "r1" },
    });
    expect(collision.kind).toBe("blocked");
    if (collision.kind === "blocked") {
      expect(errorCodes(collision.issues)).toContain("DESIGN_ROLE_NAME_CONFLICT");
    }
  });

  test("allows duplicate Team names but not duplicate ids", () => {
    const sameName = {
      ...makeTeam(),
      id: "another-team",
      name: "改版 Team",
      source: "preset",
      designer: undefined,
    };
    const merged = mergeDesign({
      ...baseInput(),
      teams: { values: teamsDocument([sameName]), revision: "t1" },
    });
    expect(merged.kind).toBe("write");
  });

  test("detects a concurrent revision through the CAS fake", () => {
    const store = new CasStore(rolesDocument());
    const clientA = store.read();
    const clientB = store.read();
    const mergedA = mergeDesign({
      ...baseInput(),
      roles: clientA,
    });
    expect(mergedA.kind).toBe("write");
    if (mergedA.kind !== "write") return;
    expect(store.write(mergedA.roles, clientA.revision)).toBe(true);
    expect(store.write(mergedA.roles, clientB.revision)).toBe(false);

    const fresh = store.read();
    const stale = mergeDesign({
      ...baseInput(),
      roles: fresh,
      base: { roles: clientB.revision, teams: "t1", preferences: "p1" },
    });
    expect(stale.kind).toBe("blocked");
    if (stale.kind === "blocked") {
      expect(errorCodes(stale.issues)).toContain("DESIGN_SAVE_CONFLICT");
    }
  });
});

describe("verifySavedDesign", () => {
  test("distinguishes none, roles-only, committed, and modified", () => {
    const result = makeResult();
    expect(
      verifySavedDesign({
        roles: rolesDocument(),
        teams: teamsDocument(),
        result,
      }),
    ).toEqual({ kind: "none" });

    expect(
      verifySavedDesign({
        roles: rolesDocument([...reusedRoles, newRole]),
        teams: teamsDocument(),
        result,
      }),
    ).toEqual({ kind: "roles-only", roleIds: ["eng-rework"] });

    expect(
      verifySavedDesign({
        roles: rolesDocument([...reusedRoles, newRole]),
        teams: teamsDocument([makeTeam()]),
        result,
      }),
    ).toEqual({ kind: "committed", teamId: "rework-team", modified: false });

    expect(
      verifySavedDesign({
        roles: rolesDocument([...reusedRoles, newRole]),
        teams: teamsDocument([makeTeam({ name: "人工修改" })]),
        result,
      }),
    ).toEqual({ kind: "committed", teamId: "rework-team", modified: true });
  });

  test("reports conflicts for another job, duplicate Teams, missing refs, and edited new-Role origin", () => {
    const result = makeResult();
    const otherJob = verifySavedDesign({
      roles: rolesDocument([...reusedRoles, newRole]),
      teams: teamsDocument([makeTeam({ designer: { jobId: OTHER_JOB } })]),
      result,
    });
    expect(otherJob.kind).toBe("conflict");

    const duplicate = verifySavedDesign({
      roles: rolesDocument([...reusedRoles, newRole]),
      teams: teamsDocument([makeTeam(), makeTeam({ name: "dup" })]),
      result,
    });
    expect(duplicate.kind).toBe("conflict");

    const missingRef = verifySavedDesign({
      roles: rolesDocument([techLead, architect, newRole]),
      teams: teamsDocument([makeTeam()]),
      result,
    });
    expect(missingRef.kind).toBe("conflict");
    if (missingRef.kind === "conflict") {
      expect(errorCodes(missingRef.issues)).toContain("DESIGN_REUSE_INVALID");
    }

    const missingNewRole = verifySavedDesign({
      roles: rolesDocument(reusedRoles),
      teams: teamsDocument([makeTeam()]),
      result,
    });
    expect(missingNewRole.kind).toBe("conflict");

    const editedOrigin = RoleSchema.parse({ ...newRole, designer: { jobId: OTHER_JOB } });
    const edited = verifySavedDesign({
      roles: rolesDocument([...reusedRoles, editedOrigin]),
      teams: teamsDocument([makeTeam()]),
      result,
    });
    expect(edited.kind).toBe("conflict");
  });
});

describe("planDesignCompensation", () => {
  const snapshot = (roles: Role[]): DesignSnapshot<RolesDocument> => ({
    values: rolesDocument(roles),
    revision: "r1",
  });

  test("removes an unmodified, unreferenced, authorized new Role only", () => {
    const plan = planDesignCompensation({
      roles: snapshot([...reusedRoles, newRole]),
      teams: { values: teamsDocument(), revision: "t1" },
      result: makeResult(),
      authorizedRoleIds: ["eng-rework"],
    });
    expect(plan.removeRoleIds).toEqual(["eng-rework"]);
    expect(plan.retainedRoleIds).toEqual([]);
    expect(plan.roles.roles.map((role) => role.id)).toEqual([
      "tech-lead",
      "architect",
      "developer",
    ]);
    expect(plan.issues).toEqual([]);
  });

  test("retains modified, referenced, untrusted, and unauthorized Rows; reuse Roles are untouched", () => {
    const modified = RoleSchema.parse({ ...newRole, systemPrompt: "changed" });
    const plan = planDesignCompensation({
      roles: snapshot([...reusedRoles, modified]),
      teams: { values: teamsDocument(), revision: "t1" },
      result: makeResult(),
      authorizedRoleIds: ["eng-rework"],
    });
    expect(plan.removeRoleIds).toEqual([]);
    expect(plan.retainedRoleIds).toEqual(["eng-rework"]);
    expect(errorCodes(plan.issues)).toContain("DESIGN_COMPENSATION_UNSAFE");

    const referenced = planDesignCompensation({
      roles: snapshot([...reusedRoles, newRole]),
      teams: { values: teamsDocument([makeTeam()]), revision: "t1" },
      result: makeResult(),
      authorizedRoleIds: ["eng-rework"],
    });
    expect(referenced.removeRoleIds).toEqual([]);
    expect(errorCodes(referenced.issues)).toContain("DESIGN_COMPENSATION_UNSAFE");

    const untrusted = planDesignCompensation({
      roles: snapshot([...reusedRoles, RoleSchema.parse({ ...newRole, source: undefined })]),
      teams: { values: teamsDocument(), revision: "t1" },
      result: makeResult(),
      authorizedRoleIds: ["eng-rework"],
    });
    expect(untrusted.removeRoleIds).toEqual([]);
    expect(errorCodes(untrusted.issues)).toContain("DESIGN_COMPENSATION_UNSAFE");

    const unauthorized = planDesignCompensation({
      roles: snapshot([...reusedRoles, newRole]),
      teams: { values: teamsDocument(), revision: "t1" },
      result: makeResult(),
      authorizedRoleIds: [],
    });
    expect(unauthorized.removeRoleIds).toEqual([]);
    expect(unauthorized.retainedRoleIds).toEqual(["eng-rework"]);
    expect(unauthorized.issues).toEqual([]);

    const withReuse = planDesignCompensation({
      roles: snapshot([...reusedRoles, newRole]),
      teams: { values: teamsDocument(), revision: "t1" },
      result: makeResult(),
      authorizedRoleIds: ["tech-lead", "eng-rework"],
    });
    expect(withReuse.removeRoleIds).toEqual(["eng-rework"]);
    expect(withReuse.roles.roles.map((role) => role.id)).toContain("tech-lead");
  });

  test("leaves the write decision to CAS: a stale compensation write must fail", () => {
    const store = new CasStore(rolesDocument([...reusedRoles, newRole]));
    const before = store.read();
    const plan = planDesignCompensation({
      roles: before,
      teams: { values: teamsDocument(), revision: "t1" },
      result: makeResult(),
      authorizedRoleIds: ["eng-rework"],
    });
    const concurrent = {
      ...store.read().values,
      roles: [...reusedRoles, newRole, { ...newRole, id: "eng-other" }],
    };
    expect(store.write(concurrent, store.read().revision)).toBe(true);
    expect(store.write(plan.roles, before.revision)).toBe(false);
  });
});

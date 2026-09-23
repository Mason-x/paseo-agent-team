import { describe, expect, test } from "vitest";
import { RoleSchema } from "../shared/schemas/role";
import { TeamSchema } from "../shared/schemas/team";
import { exampleCatalog } from "../shared/templates";
import { ROLE_ZH_NAMES, TEAM_ZH_NAMES } from "../shared/zh";
import { claudeOpus, codexXhigh, NOW } from "./fixtures";

describe("example templates", () => {
  const catalog = exampleCatalog([claudeOpus, codexXhigh], NOW);

  test("every role and team passes schema", () => {
    for (const role of catalog.roles) {
      expect(RoleSchema.parse(role).id).toBe(role.id);
    }
    for (const team of catalog.teams) {
      expect(TeamSchema.parse(team).id).toBe(team.id);
    }
  });

  test("coordinators are not members", () => {
    for (const team of catalog.teams) {
      expect(team.members.some((member) => member.roleId === team.coordinatorRoleId)).toBe(false);
    }
  });

  test("imports the Ruflo role catalog", () => {
    expect(catalog.roles.length).toBeGreaterThanOrEqual(80);
    expect(new Set(catalog.roles.map((role) => role.id)).size).toBe(catalog.roles.length);
    expect(catalog.roles.some((role) => role.id === "coder")).toBe(true);
    expect(catalog.roles.find((role) => role.id === "coder")?.name).toBe("程序员");
    expect(catalog.roles.find((role) => role.id === "hierarchical-coordinator")?.name).toBe(
      "层级协调者",
    );
    expect(catalog.teams.find((team) => team.id === "coding-team")?.name).toBe("编码团队");
    expect(catalog.roles.some((role) => role.id === "hierarchical-coordinator")).toBe(true);
    expect(catalog.teams.some((team) => team.id === "coding-team")).toBe(true);
    expect(catalog.teams.some((team) => team.id === "research-team")).toBe(true);
    for (const role of catalog.roles) {
      expect(ROLE_ZH_NAMES[role.id], role.id).toBe(role.name);
    }
    for (const team of catalog.teams) {
      expect(TEAM_ZH_NAMES[team.id], team.id).toBe(team.name);
    }
  });

  test("does not ship roles that spawn host CLIs", () => {
    const blob = JSON.stringify(catalog);
    expect(blob).not.toContain("codex exec");
    expect(blob).not.toContain("claude -p");
    expect(blob).not.toContain("skip-git-repo-check");
    expect(catalog.roles.some((role) => role.id === "codex-coordinator")).toBe(false);
    expect(catalog.teams.some((team) => team.id === "dual-mode-team")).toBe(false);
  });

  test("research members all forbid file edits", () => {
    const research = catalog.teams.find((team) => team.id === "research-team");
    expect(research).toBeDefined();
    const researchIds = new Set(research?.members.map((member) => member.roleId) ?? []);
    researchIds.add(research?.coordinatorRoleId ?? "");
    const researchRoles = catalog.roles.filter((role) => researchIds.has(role.id));
    expect(researchRoles.length).toBeGreaterThan(3);
    for (const role of researchRoles) {
      if (!/researcher|analyst|analyzer|reviewer/.test(role.id)) continue;
      expect(
        role.restrictions.some((item) => /do not edit, create, or delete files/i.test(item)),
      ).toBe(true);
    }
  });

  test("coding team binds claude and codex when those profiles exist", () => {
    const coordinator = catalog.roles.find((role) => role.id === "hierarchical-coordinator");
    const coder = catalog.roles.find((role) => role.id === "coder");
    expect(coordinator?.preferredProfiles[0]?.profileId).toBe(claudeOpus.id);
    expect(coder?.preferredProfiles[0]?.profileId).toBe(codexXhigh.id);
  });
});

import { describe, expect, test } from "vitest";
import {
  missingProfileRefs,
  preferredProfileLabel,
  teamRoleWarnings,
  teamsUsingRole,
} from "../client/domain/validation";
import { architect, claudeOpus, codingTeam, developer, techLead } from "./fixtures";

describe("validation", () => {
  test("finds missing profile refs without failing the role document", () => {
    const warnings = missingProfileRefs([architect], []);
    expect(warnings.map((warning) => warning.profileId).sort()).toEqual([
      "claude-opus-high",
      "codex-xhigh",
    ]);
  });

  test("lists teams that reference a role", () => {
    expect(teamsUsingRole([codingTeam], "architect").map((team) => team.id)).toEqual([
      "coding-team",
    ]);
    expect(teamsUsingRole([codingTeam], "tech-lead").map((team) => team.id)).toEqual([
      "coding-team",
    ]);
    expect(teamsUsingRole([codingTeam], "reviewer")).toEqual([]);
  });

  test("flags missing member roles", () => {
    const warnings = teamRoleWarnings([codingTeam], [techLead, architect]);
    expect(warnings[0]?.missingRoleIds).toContain("developer");
  });

  test("preferred profile label uses the live name or a missing snapshot", () => {
    expect(preferredProfileLabel(architect, [claudeOpus])).toEqual({
      name: "Claude Opus High",
      missing: false,
    });
    expect(preferredProfileLabel(architect, []).name).toContain("缺失 Profile");
    expect(preferredProfileLabel(developer, []).missing).toBe(true);
  });
});

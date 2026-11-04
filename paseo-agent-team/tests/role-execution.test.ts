import { describe, expect, test } from "vitest";
import { resolveCoordinatorProfile, resolveSeatProfile } from "../shared/domain/mode-resolver";
import { issueValue, MODE_ISSUE_CODES } from "../shared/domain/role-execution";
import { RoleSchema } from "../shared/schemas/role";
import { RoleTierSchema, TaskKindSchema } from "../shared/schemas/team-mode";
import { allAvailable, claudeOpus, codexXhigh, role } from "./fixtures";

const host = {
  status: "ready" as const,
  profiles: [claudeOpus, codexXhigh],
  availability: allAvailable,
};
const custom = role({
  id: "my-custom-role",
  name: "Custom",
  preferredProfiles: [{ profileId: claudeOpus.id }],
  fallbackProfiles: [{ profileId: codexXhigh.id }],
});

describe("retired Role execution policy", () => {
  test("legacy and malformed policy values decode without changing either binding", () => {
    for (const executionPolicy of [
      { tier: "retain", taskKind: "coding" },
      { tier: "economy-plus", taskKind: "delivery", future: true },
      { tier: 5, taskKind: { future: true } },
    ]) {
      const stored = RoleSchema.parse({ ...custom, executionPolicy });
      expect(stored.executionPolicy).toEqual(executionPolicy);
      const member = resolveSeatProfile({ role: stored, host });
      expect(member.ok).toBe(true);
      if (!member.ok) throw new Error("member binding failed");
      expect(member.value.profile.id).toBe(claudeOpus.id);
      expect(member.value.source).toBe("role-preferred");
      const coordinator = resolveCoordinatorProfile({ role: stored, host });
      expect(coordinator.ok).toBe(true);
      if (!coordinator.ok) throw new Error("coordinator binding failed");
      expect(coordinator.selection.profile.id).toBe(claudeOpus.id);
      expect(coordinator.warnings).toEqual([]);
    }
  });

  test("custom Roles retain their own ordered fallback regardless of an old tier", () => {
    const unavailablePreferred = {
      ...host,
      availability: [
        { provider: "claude", available: false },
        { provider: "codex", available: true },
      ],
    };
    const stored = { ...custom, executionPolicy: { tier: "escalation", taskKind: "ops" } };
    const result = resolveSeatProfile({ role: stored, host: unavailablePreferred });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("fallback failed");
    expect(result.value.profile.id).toBe(codexXhigh.id);
    expect(result.value.source).toBe("role-fallback");
  });

  test("ledger tier and task-kind schemas retain their strict enums", () => {
    expect(RoleTierSchema.options).toEqual(["decision", "execution", "escalation", "retain"]);
    expect(TaskKindSchema.options).toEqual([
      "coding",
      "testing",
      "acceptance",
      "codebase",
      "ops",
      "general",
    ]);
    expect(RoleTierSchema.safeParse("economy").success).toBe(false);
    expect(TaskKindSchema.safeParse("delivery").success).toBe(false);
  });

  test("planning issues keep scalar values without exposing nested objects", () => {
    expect([issueValue("x"), issueValue(3), issueValue(true)]).toEqual(["x", 3, true]);
    expect([issueValue(null), issueValue([]), issueValue({ token: "secret" })]).toEqual([
      "null",
      "array",
      "object",
    ]);
    expect(MODE_ISSUE_CODES).toContain("MODE_PROFILE_UNRESOLVED");
  });
});

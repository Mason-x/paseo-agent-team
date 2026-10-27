import { describe, expect, test } from "vitest";
import {
  DEFAULT_ROLE_EXECUTION,
  isRoleTier,
  isTaskKind,
  resolveRoleExecution,
} from "../shared/domain/role-execution";
import { RoleTierSchema, TaskKindSchema } from "../shared/schemas/team-mode";
import { role } from "./fixtures";

// Deliberately independent of DEFAULT_ROLE_EXECUTION so a typo in the table cannot pass through
// this test. Order and content follow the built-in preset table.
const EXPECTED_TIERS = [
  ["lead-orchestrator", "decision", "general"],
  ["lead-tech", "decision", "general"],
  ["lead-research", "decision", "general"],
  ["lead-content", "decision", "general"],
  ["plan-requirements", "decision", "general"],
  ["plan-architect", "decision", "general"],
  ["qa-review", "decision", "general"],
  ["qa-security", "decision", "general"],
  ["eng-expert", "escalation", "coding"],
  ["eng-fullstack", "execution", "coding"],
  ["eng-frontend", "execution", "coding"],
  ["eng-batch", "execution", "coding"],
  ["eng-rapid", "execution", "coding"],
  ["eng-ops", "execution", "ops"],
  ["qa-test", "execution", "testing"],
  ["qa-acceptance", "execution", "acceptance"],
  ["research-codebase", "execution", "codebase"],
  ["research-web", "retain", "general"],
  ["research-docs", "retain", "general"],
  ["research-vision", "retain", "general"],
  ["content-creative", "retain", "general"],
  ["content-technical", "retain", "general"],
  ["content-editor", "retain", "general"],
] as const;

function member(id: string, executionPolicy?: Record<string, unknown>) {
  return role({ id, name: id, ...(executionPolicy ? { executionPolicy } : {}) });
}

describe("role execution defaults", () => {
  test("covers exactly the 23 presets with the designed tier and task kind", () => {
    expect(Object.keys(DEFAULT_ROLE_EXECUTION).sort()).toEqual(
      EXPECTED_TIERS.map(([id]) => id).sort(),
    );
    for (const [id, tier, taskKind] of EXPECTED_TIERS) {
      expect(DEFAULT_ROLE_EXECUTION[id], id).toEqual({ tier, taskKind });
    }
  });

  test("known ids resolve from the compatibility table for member seats", () => {
    for (const [id, tier, taskKind] of EXPECTED_TIERS) {
      expect(resolveRoleExecution(member(id), "member"), id).toEqual({
        ok: true,
        value: { tier, taskKind },
      });
    }
  });

  test("research-codebase is an execution Role while every other research Role is retained", () => {
    expect(resolveRoleExecution(member("research-codebase"), "member")).toEqual({
      ok: true,
      value: { tier: "execution", taskKind: "codebase" },
    });
    for (const id of ["research-web", "research-docs", "research-vision"]) {
      expect(resolveRoleExecution(member(id), "member"), id).toEqual({
        ok: true,
        value: { tier: "retain", taskKind: "general" },
      });
    }
  });

  test("an unknown custom id keeps its original binding", () => {
    expect(resolveRoleExecution(member("my-custom-engineer"), "member")).toEqual({
      ok: true,
      value: { tier: "retain", taskKind: "general" },
    });
  });

  test("explicit valid fields override the compatibility table field by field", () => {
    expect(resolveRoleExecution(member("eng-fullstack", { tier: "retain" }), "member")).toEqual({
      ok: true,
      value: { tier: "retain", taskKind: "coding" },
    });
    expect(resolveRoleExecution(member("eng-ops", { taskKind: "general" }), "member")).toEqual({
      ok: true,
      value: { tier: "execution", taskKind: "general" },
    });
    expect(
      resolveRoleExecution(
        member("eng-expert", { tier: "execution", taskKind: "testing" }),
        "member",
      ),
    ).toEqual({ ok: true, value: { tier: "execution", taskKind: "testing" } });
    expect(
      resolveRoleExecution(
        member("my-custom-role", { tier: "escalation", taskKind: "ops" }),
        "member",
      ),
    ).toEqual({ ok: true, value: { tier: "escalation", taskKind: "ops" } });
  });

  test("explicit unknown tiers and task kinds are blockers, never a silent fallback", () => {
    expect(resolveRoleExecution(member("eng-fullstack", { tier: "economy" }), "member")).toEqual({
      ok: false,
      issues: [
        {
          code: "MODE_ROLE_POLICY_UNKNOWN",
          severity: "blocker",
          roleId: "eng-fullstack",
          params: { field: "tier", value: "economy" },
        },
      ],
    });
    expect(resolveRoleExecution(member("eng-ops", { taskKind: "delivery" }), "member")).toEqual({
      ok: false,
      issues: [
        {
          code: "MODE_ROLE_POLICY_UNKNOWN",
          severity: "blocker",
          roleId: "eng-ops",
          params: { field: "taskKind", value: "delivery" },
        },
      ],
    });
    expect(
      resolveRoleExecution(member("my-custom-role", { tier: "fast", taskKind: "fast" }), "member"),
    ).toMatchObject({
      ok: false,
      issues: [
        { params: { field: "tier", value: "fast" } },
        { params: { field: "taskKind", value: "fast" } },
      ],
    });
  });

  test("coordinator seats always use the decision tier, keeping their original binding", () => {
    expect(resolveRoleExecution(member("eng-fullstack"), "coordinator")).toEqual({
      ok: true,
      value: { tier: "decision", taskKind: "coding" },
    });
    expect(
      resolveRoleExecution(
        member("eng-fullstack", { tier: "retain", taskKind: "ops" }),
        "coordinator",
      ),
    ).toEqual({ ok: true, value: { tier: "decision", taskKind: "ops" } });
    expect(resolveRoleExecution(member("my-custom-role"), "coordinator")).toEqual({
      ok: true,
      value: { tier: "decision", taskKind: "general" },
    });
    // A coordinator ignores its tier, so an unrecognized value is only a warning and the seat
    // still uses the decision tier with the known task kind.
    expect(
      resolveRoleExecution(member("eng-fullstack", { tier: "economy" }), "coordinator"),
    ).toEqual({
      ok: true,
      value: { tier: "decision", taskKind: "coding" },
      issues: [
        {
          code: "MODE_ROLE_POLICY_UNKNOWN",
          severity: "warning",
          roleId: "eng-fullstack",
          params: { field: "tier", value: "economy" },
        },
      ],
    });
    expect(
      resolveRoleExecution(member("my-custom-role", { tier: "fast", taskKind: 5 }), "coordinator"),
    ).toEqual({
      ok: true,
      value: { tier: "decision", taskKind: "general" },
      issues: [
        {
          code: "MODE_ROLE_POLICY_UNKNOWN",
          severity: "warning",
          roleId: "my-custom-role",
          params: { field: "tier", value: "fast" },
        },
        {
          code: "MODE_ROLE_POLICY_UNKNOWN",
          severity: "warning",
          roleId: "my-custom-role",
          params: { field: "taskKind", value: 5 },
        },
      ],
    });
  });

  test("a non-string explicit value is reported, not silently treated as absent", () => {
    expect(resolveRoleExecution(member("eng-fullstack", { tier: 5 }), "member")).toEqual({
      ok: false,
      issues: [
        {
          code: "MODE_ROLE_POLICY_UNKNOWN",
          severity: "blocker",
          roleId: "eng-fullstack",
          params: { field: "tier", value: 5 },
        },
      ],
    });
  });

  test("runtime tier and task-kind guards match the stored enums", () => {
    for (const tier of ["decision", "execution", "escalation", "retain"]) {
      expect(isRoleTier(tier)).toBe(true);
    }
    for (const kind of ["coding", "testing", "acceptance", "codebase", "ops", "general"]) {
      expect(isTaskKind(kind)).toBe(true);
    }
    expect(isRoleTier("economy")).toBe(false);
    expect(isTaskKind("delivery")).toBe(false);
    // The zod-free runtime lists must accept exactly what the stored command enums list.
    expect(RoleTierSchema.options.filter(isRoleTier)).toHaveLength(RoleTierSchema.options.length);
    expect(TaskKindSchema.options.filter(isTaskKind)).toHaveLength(TaskKindSchema.options.length);
  });
});

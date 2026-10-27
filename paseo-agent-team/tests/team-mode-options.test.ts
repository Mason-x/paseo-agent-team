import { describe, expect, test } from "vitest";
import { mergeRoleExecutionPolicy } from "../client/catalog/preset-metadata";
import {
  applyRolePolicyChoice,
  MEMBER_CREATION_OPTIONS,
  ROLE_TIER_OPTIONS,
  TASK_KIND_OPTIONS,
  TEAM_MODE_OPTIONS,
} from "../client/shared/team-mode-options";
import { LEGACY_TEAM_MODES } from "../shared/domain/mode-contract";
import { RoleTierSchema, TaskKindSchema } from "../shared/schemas/team-mode";

describe("mode and policy options", () => {
  test("team mode options match the strict command enum", () => {
    // TODO(U01): 补第四档后恢复为与 TeamModeSchema 全量相等
    expect(TEAM_MODE_OPTIONS.map((option) => option.value)).toEqual(LEGACY_TEAM_MODES);
    expect(TEAM_MODE_OPTIONS.every((option) => option.label && option.hint)).toBe(true);
  });

  test("Role tier and task kind options match their strict enums", () => {
    expect(ROLE_TIER_OPTIONS.map((option) => option.value)).toEqual(RoleTierSchema.options);
    expect(TASK_KIND_OPTIONS.map((option) => option.value)).toEqual(TaskKindSchema.options);
    expect(ROLE_TIER_OPTIONS.every((option) => option.label.length > 0)).toBe(true);
    expect(TASK_KIND_OPTIONS.every((option) => option.label.length > 0)).toBe(true);
  });

  test("member creation defaults to an empty stored value", () => {
    expect(MEMBER_CREATION_OPTIONS.map((option) => option.value)).toEqual([
      "",
      "eager",
      "on-demand",
    ]);
  });
});

describe("role policy picker wiring", () => {
  const empty = {
    executionTier: "",
    executionTaskKind: "",
    executionTierTouched: false,
    executionTaskKindTouched: false,
  };

  test("selecting a tier marks only tier as touched and survives the save merge", () => {
    const draft = applyRolePolicyChoice(empty, "tier", "decision");
    expect(draft).toMatchObject({ executionTier: "decision", executionTierTouched: true });
    expect(draft.executionTaskKindTouched).toBe(false);
    expect(
      mergeRoleExecutionPolicy(
        { tier: "retain", taskKind: "coding" },
        {
          tier: draft.executionTier,
          taskKind: draft.executionTaskKind,
          tierTouched: draft.executionTierTouched,
          taskKindTouched: draft.executionTaskKindTouched,
        },
      ),
    ).toEqual({ tier: "decision", taskKind: "coding" });
  });

  test("selecting a task kind marks only taskKind as touched", () => {
    const draft = applyRolePolicyChoice(empty, "taskKind", "ops");
    expect(draft).toMatchObject({ executionTaskKind: "ops", executionTaskKindTouched: true });
    expect(draft.executionTierTouched).toBe(false);
    expect(
      mergeRoleExecutionPolicy(
        { tier: 5, taskKind: "coding" },
        {
          tier: draft.executionTier,
          taskKind: draft.executionTaskKind,
          tierTouched: draft.executionTierTouched,
          taskKindTouched: draft.executionTaskKindTouched,
        },
      ),
    ).toEqual({ tier: 5, taskKind: "ops" });
  });

  test("the keep option clears only the touched field", () => {
    const draft = applyRolePolicyChoice(
      { ...empty, executionTier: "retain", executionTierTouched: true },
      "tier",
      "",
    );
    expect(
      mergeRoleExecutionPolicy(
        { tier: "retain", taskKind: "general" },
        {
          tier: draft.executionTier,
          taskKind: draft.executionTaskKind,
          tierTouched: draft.executionTierTouched,
          taskKindTouched: draft.executionTaskKindTouched,
        },
      ),
    ).toEqual({ taskKind: "general" });
  });
});

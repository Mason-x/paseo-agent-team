import { describe, expect, test } from "vitest";
import { mergeRoleExecutionPolicy } from "../client/catalog/preset-metadata";
import {
  applyRolePolicyChoice,
  MEMBER_CREATION_OPTIONS,
  ROLE_TIER_OPTIONS,
  TASK_KIND_OPTIONS,
  TEAM_MODE_OPTIONS,
} from "../client/shared/team-mode-options";
import {
  TEAM_MODE_DISPLAY,
  TEAM_MODES,
  type TeamModeDisplay,
} from "../shared/domain/mode-contract";
import { RoleTierSchema, TaskKindSchema, TeamModeSchema } from "../shared/schemas/team-mode";
import { modesZh } from "../shared/zh/modes";

describe("mode and policy options", () => {
  test("team mode options match the strict command enum", () => {
    expect(TEAM_MODE_OPTIONS.map((option) => option.value)).toEqual(TeamModeSchema.options);
    expect(TEAM_MODE_OPTIONS.every((option) => option.label && option.hint)).toBe(true);
  });

  test("the picker table is the contract table: four modes, one display identity each", () => {
    expect(TEAM_MODE_OPTIONS.map((option) => option.value)).toEqual([...TEAM_MODES]);
    expect(TEAM_MODE_OPTIONS.map((option) => option.display)).toEqual(
      TEAM_MODES.map((mode) => TEAM_MODE_DISPLAY[mode]),
    );
    expect(new Set(TEAM_MODE_OPTIONS.map((option) => option.display)).size).toBe(TEAM_MODES.length);
    expect(TEAM_MODE_OPTIONS.map((option) => option.label)).toEqual(
      TEAM_MODES.map((mode) => modesZh.modeLabels[TEAM_MODE_DISPLAY[mode]]),
    );
  });

  test("labels and hints are unique, and standard never shares the economy name", () => {
    const labels = TEAM_MODE_OPTIONS.map((option) => option.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual(["旗舰（SOTA）", "标准", "经济", "协作"]);

    const displayOf = new Map(TEAM_MODE_OPTIONS.map((option) => [option.display, option] as const));
    const standard = displayOf.get("standard" satisfies TeamModeDisplay);
    const economy = displayOf.get("economy" satisfies TeamModeDisplay);
    expect(standard?.hint).toContain("决策层保留原绑定");
    expect(economy?.hint).toContain("所有席位");
    expect(standard?.value).toBe("economy");
    expect(economy?.value).toBe("economy-all");

    const hints = TEAM_MODE_OPTIONS.map((option) => option.hint);
    expect(new Set(hints).size).toBe(hints.length);
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

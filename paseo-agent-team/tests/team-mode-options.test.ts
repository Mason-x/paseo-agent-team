import { describe, expect, test } from "vitest";
import { MEMBER_CREATION_OPTIONS } from "../client/shared/team-mode-options";
import { RoleTierSchema, TaskKindSchema, TeamModeSchema } from "../shared/schemas/team-mode";

describe("retained member creation options and legacy schemas", () => {
  test("member creation defaults to an empty stored value", () => {
    expect(MEMBER_CREATION_OPTIONS.map((option) => option.value)).toEqual([
      "",
      "eager",
      "on-demand",
    ]);
    expect(MEMBER_CREATION_OPTIONS.every((option) => option.label.length > 0)).toBe(true);
  });

  test("legacy mode, tier and task-kind values still decode for old records", () => {
    expect(TeamModeSchema.options).toEqual(["sota", "economy", "economy-all", "collaborative"]);
    expect(RoleTierSchema.safeParse("execution").success).toBe(true);
    expect(TaskKindSchema.safeParse("testing").success).toBe(true);
  });
});

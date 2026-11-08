import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { seatProfileFactsFromPlan } from "../../client/teams/seat-profile-facts";
import type { TeamPlanRow } from "../../shared/schemas/team-plan";

function row(rowKey: string, overrides: Partial<TeamPlanRow> = {}): TeamPlanRow {
  return {
    rowKey,
    kind: "member",
    roleId: "developer",
    roleName: "Developer",
    tier: null,
    enabled: true,
    purpose: "member",
    profile: { id: "p1", name: "Codex", provider: "codex", modeId: "auto" },
    source: "role-preferred",
    budget: "sota",
    budgetBasis: "conservative-default",
    availability: "available",
    configuredProfiles: [],
    issues: [],
    ...overrides,
  } as TeamPlanRow;
}

const members = [{ seatId: "dev", enabled: true }, { enabled: false }, { enabled: true }];

describe("seatProfileFactsFromPlan", () => {
  test("maps rows to the seat ids the editor computes, by the row key it sent", () => {
    const facts = seatProfileFactsFromPlan(members, [
      row("seat:dev", { logicalSeatId: "dev" }),
      row("member:2", {
        profile: { id: "p2", name: "Claude", provider: "claude" },
      }),
    ]);
    expect(facts).toEqual([
      { seatId: "dev", provider: "codex", modeId: "auto" },
      { seatId: "seat-3", provider: "claude" },
    ]);
  });

  test("leaves out what it cannot be sure of", () => {
    const facts = seatProfileFactsFromPlan(members, [
      // a Profile that was not selected
      row("seat:dev", { profile: null }),
      // a candidate, not the seat's own Profile
      row("member:2", { purpose: "candidate" }),
      // a key the editor did not send
      row("member:9"),
      // the coordinator
      row("coordinator", { kind: "coordinator" }),
      // a disabled member
      row("member:1", { enabled: false }),
    ]);
    expect(facts).toEqual([]);
  });

  test("two rows for one key, or a server seat id that differs, are not guessed", () => {
    expect(seatProfileFactsFromPlan(members, [row("seat:dev"), row("seat:dev")])).toEqual([]);
    expect(
      seatProfileFactsFromPlan(members, [row("seat:dev", { logicalSeatId: "other" })]),
    ).toEqual([]);
  });
});

describe("the Team editor hands the planned Profiles to the Run Engine editor", () => {
  // TeamEditor is not mounted in tests (it needs the whole host). The wiring it delegates to,
  // `RunEngineSection`, is mounted in run-engine-section.test.ts; this guards the source on both sides.
  const source = (file: string) =>
    readFileSync(path.resolve(__dirname, "../../client/teams", file), "utf8");

  test("the plan rows become seatProfiles and reach RunEngineEditor", () => {
    const section = source("RunEngineSection.tsx");
    expect(section).toContain("seatProfileFactsFromPlan(members, planRows)");
    expect(section).toMatch(/<RunEngineEditor[^>]*seatProfiles=\{seatProfiles\}/su);
  });

  test("TeamEditor hands the plan's rows to the section and does not build the facts itself", () => {
    const editor = source("TeamEditor.tsx");
    expect(editor).toMatch(/<RunEngineSection[^>]*planRows=\{planResult\?\.rows\}/su);
    expect(editor).not.toContain("<RunEngineEditor");
    expect(editor).not.toContain("seatProfileFactsFromPlan");
  });
});

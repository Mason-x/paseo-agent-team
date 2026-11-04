import { describe, expect, test } from "vitest";
import {
  buildMemberCreationField,
  createSeatId,
  duplicateMemberPair,
  newTeamMember,
  readMemberCreation,
  uniqueInstanceLabel,
} from "../client/teams/team-mode-edit";
import { type TeamMember, TeamSchema } from "../shared/schemas/team";
import { codingTeam, role } from "./fixtures";

const roles = [role({ id: "lead", name: "Lead" }), role({ id: "dev", name: "Developer" })];

describe("seat ids", () => {
  test("generates unique stable ids without using the array index", () => {
    const random = () => 0.5;
    const first = createSeatId(new Set(), 1000, random);
    const second = createSeatId(new Set([first]), 1000, random);
    expect(first).toBe("seat-rs-i000");
    expect(second).toBe(`${first}-2`);
    expect(first).not.toBe(second);
  });

  test("new members skip the coordinator and carry a seat id", () => {
    const member = newTeamMember(roles, "lead", new Set(["seat-existing"]), 1000, () => 0.25);
    expect(member.roleId).toBe("dev");
    expect(member.seatId).toBeDefined();
    expect(member.seatId).not.toBe("seat-existing");
    expect(member.enabled).toBe(true);
  });

  test("duplicating an unlabelled member names both sides A/B, then C", () => {
    const original: TeamMember = { roleId: "dev", enabled: true };
    const first = duplicateMemberPair(original, "Developer", [original], 1000, () => 0.1);
    expect(first.original).toMatchObject({
      seatId: expect.any(String),
      instanceLabel: "Developer A",
    });
    expect(first.copy).toMatchObject({ instanceLabel: "Developer B" });
    expect(first.copy.seatId).not.toBe(first.original.seatId);
    const members = [first.original, first.copy];
    const second = duplicateMemberPair(
      members[0] as TeamMember,
      "Developer",
      members,
      1000,
      () => 0.2,
    );
    expect(second.original.instanceLabel).toBe("Developer A");
    expect(second.copy.instanceLabel).toBe("Developer C");
    expect(
      TeamSchema.safeParse({
        ...codingTeam,
        coordinatorRoleId: "lead",
        members: [second.original, second.copy, ...members.slice(1)],
      }).success,
    ).toBe(true);
  });

  test("duplicating a labelled member keeps the original label and appends 副本", () => {
    const original: TeamMember = {
      roleId: "dev",
      seatId: "seat-old",
      instanceLabel: "Backend",
      enabled: true,
    };
    const pair = duplicateMemberPair(original, "Developer", [original], 1000, () => 0.1);
    expect(pair.original.instanceLabel).toBe("Backend");
    expect(pair.copy.instanceLabel).toBe("Backend 副本");
    expect(pair.copy.seatId).not.toBe("seat-old");
  });

  test("labels use the Role name and respect the 40-char limit", () => {
    expect(uniqueInstanceLabel("", new Set())).toBe("成员 副本");
    expect(uniqueInstanceLabel("x".repeat(80), new Set()).length).toBeLessThanOrEqual(40);
  });
});

describe("member creation", () => {
  test("accepts only the two explicit values", () => {
    expect(readMemberCreation("eager")).toBe("eager");
    expect(readMemberCreation("on-demand")).toBe("on-demand");
    expect(readMemberCreation("future")).toBe("");
    expect(readMemberCreation(undefined)).toBe("");
  });

  test("untouched values survive and only an explicit edit changes the field", () => {
    const unchanged = {
      original: { ...codingTeam, memberCreation: "future" },
      memberCreation: "" as const,
      memberCreationTouched: false,
    };
    expect(buildMemberCreationField(unchanged)).toEqual({ memberCreation: "future" });
    expect(buildMemberCreationField({ ...unchanged, original: codingTeam })).toEqual({});
    expect(
      buildMemberCreationField({
        ...unchanged,
        memberCreation: "eager",
        memberCreationTouched: true,
      }),
    ).toEqual({ memberCreation: "eager" });
    expect(buildMemberCreationField({ ...unchanged, memberCreationTouched: true })).toEqual({});
  });
});

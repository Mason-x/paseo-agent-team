import { describe, expect, test } from "vitest";
import {
  buildCollaboration,
  buildTeamModeFields,
  type CollaborationTouched,
  createSeatId,
  duplicateMemberPair,
  newTeamMember,
  readCollaboration,
  readMemberCreation,
  readStoredTeamMode,
  uniqueInstanceLabel,
} from "../client/teams/team-mode-edit";
import { type TeamMember, TeamSchema } from "../shared/schemas/team";
import { codingTeam, role } from "./fixtures";

const roles = [role({ id: "lead", name: "Lead" }), role({ id: "dev", name: "Developer" })];
const untouched: CollaborationTouched = {
  replicas: false,
  judgeRoleId: false,
  escalationRoleId: false,
};

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
    const all = [second.original, second.copy, ...members.slice(1)];
    const parsed = TeamSchema.safeParse({
      ...codingTeam,
      coordinatorRoleId: "lead",
      members: all,
    });
    expect(parsed.success).toBe(true);
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

  test("labels use the Role name when no instance label exists and respect the 40-char limit", () => {
    expect(uniqueInstanceLabel("", new Set())).toBe("成员 副本");
    expect(uniqueInstanceLabel("x".repeat(80), new Set()).length).toBeLessThanOrEqual(40);
  });
});

describe("stored mode and collaboration", () => {
  test("unknown mode falls back to SOTA but is reported", () => {
    expect(readStoredTeamMode(undefined)).toEqual({ mode: "sota", unknown: null });
    expect(readStoredTeamMode("economy")).toEqual({ mode: "economy", unknown: null });
    expect(readStoredTeamMode("future-mode")).toEqual({
      mode: "sota",
      unknown: "future-mode",
    });
  });

  test("member creation accepts only the two explicit values", () => {
    expect(readMemberCreation("eager")).toBe("eager");
    expect(readMemberCreation("on-demand")).toBe("on-demand");
    expect(readMemberCreation("future")).toBe("");
    expect(readMemberCreation(undefined)).toBe("");
  });

  test("untouched collaboration keeps unknown values and extensions", () => {
    const original = { replicas: 7, judgeRoleId: 42, futureField: true };
    const draft = readCollaboration(original as never);
    expect(draft).toEqual({ replicas: 2, judgeRoleId: "", escalationRoleId: "" });
    expect(buildCollaboration(original as never, draft, "sota", untouched)).toEqual(original);
  });

  test("editing one collaboration field preserves the untouched unknown fields", () => {
    const original = { replicas: 7, judgeRoleId: 42, futureField: true };
    const draft = { replicas: 2 as const, judgeRoleId: "dev", escalationRoleId: "" };
    const block = buildCollaboration(original as never, draft, "collaborative", {
      replicas: false,
      judgeRoleId: true,
      escalationRoleId: false,
    });
    expect(block).toMatchObject({
      replicas: 7,
      judgeRoleId: "dev",
      futureField: true,
    });
    expect(buildCollaboration(undefined, draft, "collaborative")).toMatchObject({ replicas: 2 });
  });

  test("only edited Team mode fields are written", () => {
    const base = {
      original: codingTeam,
      mode: "sota" as const,
      modeTouched: false,
      memberCreation: "" as const,
      memberCreationTouched: false,
      collaboration: { replicas: 2 as const, judgeRoleId: "", escalationRoleId: "" },
      collaborationTouched: untouched,
    };
    expect(buildTeamModeFields(base)).toEqual({});
    expect(buildTeamModeFields({ ...base, original: { ...codingTeam, mode: "future" } })).toEqual({
      mode: "future",
    });
    expect(
      buildTeamModeFields({
        ...base,
        original: { ...codingTeam, memberCreation: "future", collaboration: { custom: 1 } },
      }),
    ).toEqual({
      memberCreation: "future",
      collaboration: { custom: 1 },
    });
    expect(
      buildTeamModeFields({
        ...base,
        mode: "collaborative",
        modeTouched: true,
        collaborationTouched: { ...untouched, replicas: true },
      }),
    ).toMatchObject({
      mode: "collaborative",
      collaboration: { replicas: 2 },
    });
  });
});

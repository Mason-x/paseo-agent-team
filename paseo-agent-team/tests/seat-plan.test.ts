import { describe, expect, test } from "vitest";
import type { HostSnapshot } from "../shared/domain/mode-resolver";
import { buildSeatPlan, MAX_RUNTIME_MEMBERS } from "../shared/domain/seat-plan";
import { PreferencesSchema } from "../shared/schemas/preferences";
import type { Role } from "../shared/schemas/role";
import type { Team, TeamMember } from "../shared/schemas/team";
import { allAvailable, architect, claudeOpus, codexXhigh, codingTeam, developer } from "./fixtures";

const roles = [architect, developer];
const host: HostSnapshot = {
  status: "ready",
  profiles: [claudeOpus, codexXhigh],
  availability: allAvailable,
};
const unsupported = { onDemand: false, expansion: false, collaboration: false };
function member(roleId: string, instanceLabel?: string, seatId?: string): TeamMember {
  return {
    roleId,
    enabled: true,
    ...(instanceLabel === undefined ? {} : { instanceLabel }),
    ...(seatId === undefined ? {} : { seatId }),
  };
}
function members(count: number) {
  return Array.from({ length: count }, (_, index) =>
    member(developer.id, `Seat ${index + 1}`, `seat-${index + 1}`),
  );
}
function planFor(
  input: TeamMember[],
  options: {
    maxMembers?: number;
    team?: Partial<Team>;
    roles?: Role[];
    host?: HostSnapshot;
    onDemand?: boolean;
  } = {},
) {
  return buildSeatPlan({
    team: { ...codingTeam, ...options.team, members: input },
    roles: options.roles ?? roles,
    host: options.host ?? host,
    maxMembers: options.maxMembers ?? 24,
    runtimeCapabilities: { ...unsupported, onDemand: options.onDemand ?? false },
  });
}

describe("bounded seat planning", () => {
  test("plans 12 members without counting the coordinator", () => {
    const plan = planFor(members(12));
    expect(plan.blockers).toEqual([]);
    expect(plan.counts).toEqual({
      logical: 12,
      physical: 12,
      eager: 12,
      deferred: 0,
      escalation: 0,
      sotaPotential: 12,
    });
    expect(plan.seats.map((seat) => seat.seatId)).toEqual(members(12).map((entry) => entry.seatId));
    expect(
      plan.seats.every(
        (seat) => seat.roleId === developer.id && seat.selected.profile.id === codexXhigh.id,
      ),
    ).toBe(true);
  });

  test("keeps an already-saved limit of 8 instead of silently raising it", () => {
    expect(PreferencesSchema.parse({ maxMembers: 8 }).maxMembers).toBe(8);
    expect(planFor(members(12), { maxMembers: 8 }).blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_MEMBER_LIMIT",
        severity: "blocker",
        params: { members: 12, limit: 8 },
      }),
    );
  });

  test("enforces the 24 and 64 boundaries on physical seats", () => {
    expect(MAX_RUNTIME_MEMBERS).toBe(64);
    expect(planFor(members(24), { maxMembers: 24 }).blockers).toEqual([]);
    expect(planFor(members(25), { maxMembers: 24 }).blockers).toContainEqual(
      expect.objectContaining({ code: "MODE_MEMBER_LIMIT", params: { members: 25, limit: 24 } }),
    );
    expect(planFor(members(64), { maxMembers: 200 }).blockers).toEqual([]);
    expect(planFor(members(65), { maxMembers: 200 }).blockers).toContainEqual(
      expect.objectContaining({ code: "MODE_MEMBER_LIMIT", params: { members: 65, limit: 64 } }),
    );
  });

  test("repeat Roles preserve labels, warn on duplicates and block duplicate ids or missing labels", () => {
    const repeated = planFor([
      member(developer.id, "Backend", "seat-a"),
      member(developer.id, "Frontend", "seat-b"),
    ]);
    expect(repeated.blockers).toEqual([]);
    expect(repeated.seats.map((seat) => seat.instanceLabel)).toEqual(["Backend", "Frontend"]);
    for (const label of ["Backend", "backend"]) {
      const duplicate = planFor([
        member(developer.id, "Backend", "seat-a"),
        member(developer.id, label, "seat-b"),
      ]);
      expect(duplicate.blockers).toEqual([]);
      expect(duplicate.issues).toContainEqual(
        expect.objectContaining({
          code: "MODE_SEAT_DUPLICATE",
          severity: "warning",
          params: expect.objectContaining({ instanceLabel: label }),
        }),
      );
    }
    const sameId = planFor([
      member(developer.id, "Backend", "same"),
      member(developer.id, "Frontend", "same"),
    ]);
    expect(sameId.blockers).toContainEqual(
      expect.objectContaining({ code: "MODE_SEAT_DUPLICATE", params: { seatId: "same" } }),
    );
    const noLabel = planFor([
      member(developer.id, undefined, "a"),
      member(developer.id, undefined, "b"),
    ]);
    expect(noLabel.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_SEAT_DUPLICATE",
        params: expect.objectContaining({ reason: "instance-label-required" }),
      }),
    );
  });

  test("legacy and explicit seat ids remain stable and avoid collisions", () => {
    const input = [member(developer.id, "Explicit", "seat-2"), member(developer.id, "Legacy")];
    expect(planFor(input).seats.map((seat) => seat.seatId)).toEqual(["seat-2", "seat-2-2"]);
    expect(planFor(input).seats.map((seat) => seat.seatId)).toEqual(["seat-2", "seat-2-2"]);
    const legacy = [member(developer.id, "One"), member(developer.id, "Two")];
    expect(planFor(legacy).seats.map((seat) => seat.seatId)).toEqual(["seat-1", "seat-2"]);
  });

  test("every seat defaults to an eager member using its Role binding", () => {
    const plan = planFor([member(architect.id, "Review"), member(developer.id, "Build")]);
    expect(plan.blockers).toEqual([]);
    expect(
      plan.seats.map((seat) => ({
        purpose: seat.purpose,
        activation: seat.activation,
        profile: seat.selected.profile.id,
      })),
    ).toEqual([
      { purpose: "member", activation: "eager", profile: claudeOpus.id },
      { purpose: "member", activation: "eager", profile: codexXhigh.id },
    ]);
  });

  test("explicit on-demand blocks when unavailable and remains deferred when supported", () => {
    const input = [member(developer.id, "Build", "build")];
    const blocked = planFor(input, { team: { memberCreation: "on-demand" } });
    expect(blocked.seats[0]?.activation).toBe("on-demand");
    expect(blocked.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_ONDEMAND_UNAVAILABLE",
        params: { reason: "explicit-on-demand" },
      }),
    );
    const supported = planFor(input, { team: { memberCreation: "on-demand" }, onDemand: true });
    expect(supported.blockers).toEqual([]);
    expect(supported.counts).toMatchObject({ eager: 0, deferred: 1 });
    expect(supported.seats[0]?.activation).toBe("on-demand");
  });

  test("unknown member creation blocks rather than silently changing it", () => {
    const plan = planFor([member(developer.id)], { team: { memberCreation: "future" } });
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_UNKNOWN",
        params: { field: "memberCreation", value: "future" },
      }),
    );
  });

  test("missing Roles block and logical count includes members that cannot be planned", () => {
    const plan = planFor([member(developer.id, "Build"), member("ghost", "Ghost", "seat-ghost")]);
    expect(plan.counts).toMatchObject({ logical: 2, physical: 1 });
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({
        code: "MODE_PROFILE_UNRESOLVED",
        roleId: "ghost",
        seatId: "seat-ghost",
        params: { reason: "role-missing" },
      }),
    );
  });

  test("a disabled stored Role remains usable with a warning; malformed retired policy is ignored", () => {
    const disabled = { ...developer, enabled: false };
    const broken = { ...architect, executionPolicy: { tier: 5 } };
    const plan = planFor([member(developer.id, "Build"), member(architect.id, "Review")], {
      roles: [disabled, broken],
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.seats).toHaveLength(2);
    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        code: "MODE_ROLE_DISABLED",
        severity: "warning",
        roleId: developer.id,
      }),
    );
    expect(plan.issues.some((issue) => issue.code === "MODE_UNKNOWN")).toBe(false);
  });

  test("different Roles may share labels without a duplicate warning", () => {
    const plan = planFor([member(architect.id, "Shared"), member(developer.id, "shared")]);
    expect(plan.blockers).toEqual([]);
    expect(plan.issues.some((issue) => issue.code === "MODE_SEAT_DUPLICATE")).toBe(false);
  });

  test("stored unknown mode and collaboration do not add or remove seats", () => {
    const plan = planFor(members(3), { team: { mode: "quantum", collaboration: { replicas: 3 } } });
    expect(plan.blockers).toEqual([]);
    expect(plan.counts).toMatchObject({ logical: 3, physical: 3, eager: 3 });
  });
});

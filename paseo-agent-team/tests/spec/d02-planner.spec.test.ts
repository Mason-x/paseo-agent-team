// D02 planning specifications for the retained Role-bound path and historical settings.
import { expect, test } from "vitest";
import { buildLaunchPlan } from "../../shared/domain/launch-plan";
import type { HostSnapshot } from "../../shared/domain/mode-resolver";
import { resolveSeatProfile } from "../../shared/domain/mode-resolver";
import { buildSeatPlan } from "../../shared/domain/seat-plan";
import { PreferencesSchema } from "../../shared/schemas/preferences";
import type { Team } from "../../shared/schemas/team";
import { NOW, role } from "../fixtures";

const opus = { id: "opus", name: "Opus", provider: "claude", model: "claude-opus-5-5" };
const sonnet = { id: "sonnet", name: "Sonnet", provider: "claude", model: "claude-sonnet-5" };
const deepseek = { id: "deepseek", name: "DeepSeek", provider: "omp", model: "deepseek-v4" };
const profiles = [opus, sonnet, deepseek];
const availability = [
  { provider: "claude", available: true },
  { provider: "omp", available: true },
];
const roles = [
  role({ id: "lead", name: "Lead", preferredProfiles: [{ profileId: sonnet.id }] }),
  role({
    id: "eng-fullstack",
    name: "Engineer",
    preferredProfiles: [{ profileId: deepseek.id }],
    fallbackProfiles: [{ profileId: opus.id }],
  }),
  role({ id: "qa-review", name: "Reviewer", preferredProfiles: [{ profileId: opus.id }] }),
  role({ id: "eng-expert", name: "Expert", preferredProfiles: [{ profileId: sonnet.id }] }),
];
const runtimeCapabilities = { onDemand: true, expansion: true, collaboration: false };
const host: HostSnapshot = { status: "ready", profiles, availability };

function team(mode: string, ids = ["eng-fullstack", "qa-review"]): Team {
  return {
    id: "team-planner",
    name: "Planner Team",
    coordinatorRoleId: "lead",
    members: ids.map((roleId) => ({ roleId, enabled: true })),
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    mode,
  };
}

function launch(value: Team) {
  return buildLaunchPlan({
    team: value,
    roles,
    profiles,
    availability,
    host,
    maxMembers: 8,
    runtimeCapabilities,
    workspaceId: "ws-1",
    task: "plan the change",
    runId: "run-1",
    daemonConfig: {},
  });
}

function seats(value: Team, snapshot: HostSnapshot = host) {
  return buildSeatPlan({ team: value, roles, host: snapshot, maxMembers: 8, runtimeCapabilities });
}

test("every seat uses its own Role binding for all historical stored modes", () => {
  for (const mode of ["sota", "economy", "economy-all", "collaborative", "turbo"]) {
    const plan = launch(team(mode));
    expect(plan.blockers, mode).toEqual([]);
    expect(plan.coordinator.profile.id, mode).toBe(sonnet.id);
    expect(
      plan.seats.map((seat) => [seat.roleId, seat.selected.profile.id]),
      mode,
    ).toEqual([
      ["eng-fullstack", deepseek.id],
      ["qa-review", opus.id],
    ]);
  }
});

test("a down preferred provider uses the Role fallback, and exhausted bindings block", () => {
  const member = roles[1];
  if (!member) throw new Error("missing member");
  const oneDown: HostSnapshot = {
    status: "ready",
    profiles,
    availability: [
      { provider: "claude", available: true },
      { provider: "omp", available: false },
    ],
  };
  const fallback = resolveSeatProfile({ role: member, host: oneDown });
  expect(fallback).toMatchObject({
    ok: true,
    value: { profile: { id: opus.id }, source: "role-fallback" },
  });
  const exhausted = seats(team("economy-all", ["eng-fullstack"]), {
    status: "ready",
    profiles,
    availability: [
      { provider: "claude", available: false },
      { provider: "omp", available: false },
    ],
  });
  expect(exhausted.blockers).toContainEqual(
    expect.objectContaining({ code: "MODE_PROFILE_UNRESOLVED", roleId: "eng-fullstack" }),
  );
  expect(exhausted.seats).toEqual([]);
});

test("the formerly escalation-labeled Role is an ordinary eager member", () => {
  const plan = seats(team("economy-all", ["eng-expert"]));
  expect(plan.blockers).toEqual([]);
  expect(plan.seats[0]).toMatchObject({
    roleId: "eng-expert",
    purpose: "member",
    activation: "eager",
    selected: { profile: { id: sonnet.id } },
  });
});

test("an unverified availability row preserves the flagship binding with a warning", () => {
  const result = seats(team("sota", ["eng-fullstack"]), {
    status: "ready",
    profiles,
    availability: [],
    availabilityUnverified: true,
  });
  expect(result.blockers).toEqual([]);
  expect(result.seats[0]?.selected.profile.id).toBe(deepseek.id);
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: "MODE_CONTEXT_UNAVAILABLE", severity: "warning" }),
  );
});

test("missing and future old policies decode without modifying stored data", () => {
  for (const economy of [
    {},
    { allSeats: { version: 2, routes: { execution: ["x"] }, future: true } },
  ]) {
    const before = structuredClone(economy);
    const parsed = PreferencesSchema.parse({ maxMembers: 8, economy });
    expect(parsed.economy).toEqual(before);
    expect(economy).toEqual(before);
    expect(launch(team("economy-all")).blockers).toEqual([]);
  }
});

test("duplicate labels are still reported and disabled members remain excluded", () => {
  const value = team("sota", []);
  value.members = [
    { roleId: "eng-fullstack", instanceLabel: "A", enabled: true },
    { roleId: "eng-fullstack", instanceLabel: "A", enabled: true },
    { roleId: "qa-review", enabled: false },
  ];
  const result = seats(value);
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: "MODE_SEAT_DUPLICATE", severity: "warning" }),
  );
  expect(result.seats.some((seat) => seat.roleId === "qa-review")).toBe(false);
});

test("an unknown stored mode keeps the Role bindings and does not add a blocker", () => {
  const plan = launch(team("turbo", ["eng-fullstack"]));
  expect(plan.seatIssues.some((issue) => issue.code === "MODE_UNKNOWN")).toBe(false);
  expect(plan.members).toHaveLength(1);
  expect(plan.members[0]?.profile.id).toBe(deepseek.id);
});

test("member-creation policy remains an independent capability gate", () => {
  const value = { ...team("economy-all", ["eng-fullstack"]), memberCreation: "on-demand" };
  const result = buildSeatPlan({
    team: value,
    roles,
    host,
    maxMembers: 8,
    runtimeCapabilities: { onDemand: false, expansion: false, collaboration: false },
  });
  expect(result.blockers).toContainEqual(
    expect.objectContaining({ code: "MODE_ONDEMAND_UNAVAILABLE" }),
  );
});

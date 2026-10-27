// D02 spec: economy-all seat planning on the real planner (buildSeatPlan / resolveModeProfile /
// buildLaunchPlan). Expected RED until D02 lands; the file itself must always typecheck.
import { expect, test } from "vitest";
import { buildLaunchPlan } from "../../shared/domain/launch-plan";
import { readStoredMode } from "../../shared/domain/mode-contract";
import {
  type EconomyPolicy,
  type HostSnapshot,
  normalizeEconomyPolicy,
  normalizeMode,
  resolveModeProfile,
} from "../../shared/domain/mode-resolver";
import { identifyModelFamily } from "../../shared/domain/model-family";
import type { ModeIssue } from "../../shared/domain/role-execution";
import { buildSeatPlan, type PlannedSeat, type SeatPlan } from "../../shared/domain/seat-plan";
import type { PaseoProfile, ProviderAvailability } from "../../shared/paseo/adapter";
import type { Role } from "../../shared/schemas/role";
import type { Team } from "../../shared/schemas/team";
import type { TeamMode } from "../../shared/schemas/team-mode";
import { NOW, role } from "../fixtures";

const POLICY_REQUIRED = "MODE_CHEAP_POLICY_REQUIRED";
const PROFILE_INVALID = "MODE_CHEAP_PROFILE_INVALID";
const ROUTE_UNAVAILABLE = "MODE_CHEAP_ROUTE_UNAVAILABLE";

function profile(id: string, provider: string, model: string): PaseoProfile {
  return { id: `profile-${id}`, name: id, provider, model };
}

const sonnet = profile("sonnet", "claude", "claude-sonnet-5");
const haiku = profile("haiku", "claude", "claude-haiku-4-5");
const opus = profile("opus", "claude", "claude-opus-5-5");
const deepseek = profile("deepseek", "omp", "opencode-go/deepseek-v4.1-flash");
const grok = profile("grok", "omp", "cursor/cursor-grok-4.6-fast");
// A name is not evidence: "Opus-Lite" runs the Haiku model on the provider that also serves Opus.
const opusLite: PaseoProfile = { ...haiku, id: "profile-opus-lite", name: "Opus-Lite" };

const profiles = [sonnet, haiku, opus, deepseek, grok, opusLite];
const availability: ProviderAvailability[] = [
  { provider: "claude", available: true },
  { provider: "omp", available: true },
];

// Every seat keeps its original binding on Opus, so any silent fallback is visible in the result.
const roleIds = ["lead-orchestrator", "eng-fullstack", "eng-ops", "qa-review", "eng-expert"];
const roles: Role[] = roleIds.map((id) =>
  role({ id, name: id, preferredProfiles: [{ profileId: opus.id }] }),
);
type RouteMap = Partial<
  Record<"coordinator" | "decision" | "execution" | "escalation" | "retain", string[]>
>;
type SeatEntry = { profile: PaseoProfile; family?: string; enabled?: boolean };

const baseRoutes: RouteMap = {
  coordinator: [sonnet.id],
  decision: [haiku.id],
  execution: [deepseek.id],
  escalation: [haiku.id],
  retain: [haiku.id],
};

function storedEntry(entry: SeatEntry) {
  const match = identifyModelFamily(entry.profile);
  return {
    profileId: entry.profile.id,
    nameSnapshot: entry.profile.name,
    enabled: entry.enabled ?? true,
    costClass: "low",
    family: entry.family ?? (match.status === "identified" ? match.family : "unknown"),
    boundModel: { provider: entry.profile.provider, model: entry.profile.model },
  };
}

function allSeats(input: {
  routes: RouteMap;
  entries?: SeatEntry[];
  executionTaskOrder?: Record<string, string[]>;
  version?: unknown;
}) {
  return {
    version: input.version ?? 1,
    profiles: (input.entries ?? [sonnet, haiku, deepseek, grok].map((p) => ({ profile: p }))).map(
      storedEntry,
    ),
    routes: input.routes,
    ...(input.executionTaskOrder ? { executionTaskOrder: input.executionTaskOrder } : {}),
  };
}

function rawPolicy(
  allSeatsValue?: unknown,
  extra: { pool?: unknown[]; profileBudget?: Record<string, string> } = {},
) {
  const base = {
    pool: extra.pool ?? [],
    taskOrder: {},
    profileBudget: extra.profileBudget ?? {},
  };
  return allSeatsValue === undefined ? base : { ...base, allSeats: allSeatsValue };
}

function policyOf(raw: unknown): EconomyPolicy {
  const result = normalizeEconomyPolicy(raw, profiles);
  if (!result.ok) throw new Error("unexpected economy policy failure");
  return result.value;
}

function cheap(
  input: {
    execution?: string[];
    escalation?: string[];
    entries?: SeatEntry[];
    /** executionTaskOrder; only the execution route may consume it. */
    order?: Record<string, string[]>;
    profileBudget?: Record<string, string>;
    pool?: unknown[];
  } = {},
): EconomyPolicy {
  const { execution, escalation, order, profileBudget, pool, ...rest } = input;
  const routes = {
    ...baseRoutes,
    ...(execution ? { execution } : {}),
    ...(escalation ? { escalation } : {}),
  };
  const seatInputs = { ...rest, routes, ...(order ? { executionTaskOrder: order } : {}) };
  return policyOf(rawPolicy(allSeats(seatInputs), { profileBudget, pool }));
}

function host(rows: ProviderAvailability[] = availability): HostSnapshot {
  return { status: "ready", profiles, availability: rows };
}

function teamOf(mode: string, memberRoleIds: string[]): Team {
  return {
    id: "team-planner",
    name: "Planner Team",
    coordinatorRoleId: "lead-orchestrator",
    members: memberRoleIds.map((roleId) => ({ roleId, enabled: true })),
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    mode,
  };
}

const runtimeCapabilities = { onDemand: true, expansion: true, collaboration: false };
const plannerBase = { roles, profiles, availability, maxMembers: 8, runtimeCapabilities };

function seatPlan(
  mode: TeamMode,
  memberRoleIds: string[],
  economy: EconomyPolicy,
  hostSnapshot: HostSnapshot = host(),
): SeatPlan {
  return buildSeatPlan({
    ...plannerBase,
    team: teamOf(mode, memberRoleIds),
    host: hostSnapshot,
    economy,
    mode,
  });
}

function launchPlan(team: Team, economy: EconomyPolicy, mode?: TeamMode) {
  return buildLaunchPlan({
    ...plannerBase,
    team,
    workspaceId: "ws-1",
    task: "plan the change",
    runId: "run-1",
    ...(mode === undefined ? {} : { mode }),
    economy,
  });
}

function blockersOf(economy: EconomyPolicy, hostSnapshot: HostSnapshot = host()): ModeIssue[] {
  return seatPlan("economy-all", ["eng-fullstack"], economy, hostSnapshot).blockers;
}

function seatFor(seats: readonly PlannedSeat[], roleId: string): PlannedSeat {
  const seat = seats.find((item) => item.roleId === roleId);
  if (!seat) throw new Error(`missing seat ${roleId}`);
  return seat;
}

function seatOf(
  economy: EconomyPolicy,
  roleId: string,
  hostSnapshot: HostSnapshot = host(),
): PlannedSeat {
  return seatFor(seatPlan("economy-all", [roleId], economy, hostSnapshot).seats, roleId);
}

function selectedId(seat: PlannedSeat): string {
  if (seat.selected.unavailable) throw new Error(`seat ${seat.seatId} has no Profile`);
  return seat.selected.profile.id;
}

function issuesWith(issues: readonly ModeIssue[], code: string): ModeIssue[] {
  return issues.filter((issue) => String(issue.code) === code);
}

function hasBlocker(issues: readonly ModeIssue[], code: string): boolean {
  return issuesWith(issues, code).some((issue) => issue.severity === "blocker");
}

// AC-0d.1 / AC-0d.3: coordinator, decision, and execution each read their own route.
test("economy-all plans every layer from its own list", () => {
  const plan = launchPlan(teamOf("economy-all", ["eng-fullstack", "qa-review"]), cheap());
  expect(plan.coordinator.profile.id).toBe(sonnet.id);
  expect(selectedId(seatFor(plan.seats, "eng-fullstack"))).toBe(deepseek.id);
  expect(selectedId(seatFor(plan.seats, "qa-review"))).toBe(haiku.id);
});

// AC-0d.2 / AC-0d.4 / AC-0d.5: no candidate in the route means blocker, never a fallback.
test("an exhausted route blocks and never falls back to the original binding", () => {
  const empty = cheap({ execution: [] });
  const executionRole = roles.find((item) => item.id === "eng-fullstack");
  if (!executionRole) throw new Error("fixture role missing");
  const resolved = resolveModeProfile({
    mode: "economy-all",
    role: executionRole,
    kind: "member",
    host: host(),
    economy: empty,
  });
  if (resolved.ok) throw new Error("expected a blocked seat, got a fallback selection");
  expect(hasBlocker(resolved.issues, ROUTE_UNAVAILABLE)).toBe(true);

  const plan = seatPlan("economy-all", ["eng-fullstack"], empty);
  expect(hasBlocker(plan.blockers, ROUTE_UNAVAILABLE)).toBe(true);
  expect(plan.seats.some((seat) => seat.selected.source === "role-preferred")).toBe(false);

  const unverified = blockersOf(
    cheap({ execution: [sonnet.id] }),
    host([{ provider: "omp", available: true }]),
  );
  expect(issuesWith(unverified, ROUTE_UNAVAILABLE)[0]?.params.unverified).toBe(1);

  const pooled = cheap({ execution: [deepseek.id], pool: [storedEntry({ profile: sonnet })] });
  expect(selectedId(seatOf(pooled, "eng-fullstack"))).toBe(deepseek.id);
});

// AC-0d.8 (H6=A): the standby escalation seat needs a candidate too; empty means blocker.
test("a standby escalation seat blocks when its route is empty", () => {
  const plan = seatPlan("economy-all", ["eng-expert"], cheap({ escalation: [] }));
  expect(seatFor(plan.seats, "eng-expert").activation).toBe("escalation-only");
  const issue = issuesWith(plan.issues, ROUTE_UNAVAILABLE)[0];
  expect(issue?.severity).toBe("blocker");
  expect(issue?.params.route).toBe("escalation");

  const standby = seatOf(cheap(), "eng-expert");
  expect(standby.activation).toBe("escalation-only");
  expect(selectedId(standby)).toBe(haiku.id);
});

// AC-0d.4: live model and explicit budget decide; name, provider, and stored family do not.
test("high-cost model and sota budget are invalid while names prove nothing", () => {
  const liarEntry = { profile: opus, family: "sonnet" };
  const liar = blockersOf(cheap({ execution: [opus.id], entries: [liarEntry] }));
  expect(issuesWith(liar, PROFILE_INVALID).map((issue) => issue.profileId)).toContain(opus.id);
  expect(hasBlocker(liar, ROUTE_UNAVAILABLE)).toBe(true);

  const budget = blockersOf(
    cheap({ execution: [sonnet.id], profileBudget: { [sonnet.id]: "sota" } }),
  );
  expect(hasBlocker(budget, PROFILE_INVALID)).toBe(true);

  const named = cheap({ execution: [opusLite.id], entries: [{ profile: opusLite }] });
  expect(selectedId(seatOf(named, "eng-fullstack"))).toBe(opusLite.id);
});

// AC-0d.6: absent policy and unknown version both need the policy, and storage stays equal.
test("missing or future-version policy is required and storage is not rewritten", () => {
  const missingRaw = rawPolicy();
  const missingBefore = structuredClone(missingRaw);
  const missing = policyOf(missingRaw);
  expect(missingRaw).toEqual(missingBefore);
  expect(hasBlocker(blockersOf(missing), POLICY_REQUIRED)).toBe(true);

  const futureRaw = rawPolicy(allSeats({ routes: baseRoutes, version: 2 }));
  const futureBefore = structuredClone(futureRaw);
  const future = policyOf(futureRaw);
  expect(futureRaw).toEqual(futureBefore);
  const issue = issuesWith(blockersOf(future), POLICY_REQUIRED)[0];
  expect(issue?.params.route).toBe("execution");
  expect(String(issue?.params.reason)).toContain("version");
});

// AC-0d.7: executionTaskOrder reorders inside the execution route only, per task kind.
test("executionTaskOrder reorders only inside the execution route", () => {
  const economy = cheap({ execution: [deepseek.id, grok.id], order: { coding: [grok.id] } });
  const plan = seatPlan("economy-all", ["eng-fullstack", "eng-ops", "qa-review"], economy);
  expect(selectedId(seatFor(plan.seats, "eng-fullstack"))).toBe(grok.id);
  expect(selectedId(seatFor(plan.seats, "eng-ops"))).toBe(deepseek.id);
  expect(selectedId(seatFor(plan.seats, "qa-review"))).toBe(haiku.id);
});

// AC-0d.9 / AC-0d.18: an unknown stored mode blocks and creates nothing.
test("an unknown stored mode blocks instead of resolving to SOTA", () => {
  expect(readStoredMode("turbo").status).toBe("unknown");
  expect(normalizeMode("turbo").ok).toBe(false);

  const plan = launchPlan(teamOf("turbo", ["eng-fullstack"]), cheap());
  expect(hasBlocker(plan.seatIssues, "MODE_UNKNOWN")).toBe(true);
  expect(plan.members).toHaveLength(0);
});

// AC-0d.1 / AC-0d.21: legacy economy ignores allSeats entirely.
test("legacy economy plans are equal with and without allSeats", () => {
  const legacy = {
    pool: [storedEntry({ profile: deepseek }), storedEntry({ profile: grok })],
    taskOrder: { coding: [grok.id] },
    profileBudget: { [sonnet.id]: "economy" },
  };
  const without = policyOf(legacy);
  const withAll = policyOf({ ...legacy, allSeats: allSeats({ routes: baseRoutes }) });
  const team = teamOf("economy", ["eng-fullstack", "qa-review", "eng-expert"]);
  expect(launchPlan(team, withAll)).toEqual(launchPlan(team, without));
});

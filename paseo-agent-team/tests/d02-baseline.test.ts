import { describe, expect, test } from "vitest";
import { hashLaunchPlan } from "../server/launch-hash";
import { buildLaunchPlan } from "../shared/domain/launch-plan";
import { toModeLaunchPreview } from "../shared/domain/launch-preview";
import type { EconomyPolicy, HostSnapshot } from "../shared/domain/mode-resolver";
import type { PaseoProfile, ProviderAvailability } from "../shared/paseo/adapter";
import type { Role } from "../shared/schemas/role";
import type { Team } from "../shared/schemas/team";
import type { TeamMode } from "../shared/schemas/team-mode";
import {
  allAvailable,
  architect,
  claudeOpus,
  codexXhigh,
  codingTeam,
  developer,
  techLead,
} from "./fixtures";
import { D02_BASELINE_COORD, D02_BASELINE_LEGACY } from "./fixtures/d02-baseline";

const profiles: PaseoProfile[] = [claudeOpus, codexXhigh];
const EMPTY: EconomyPolicy = { pool: [], taskOrder: {}, profileBudget: {} };
const CAP_LEGACY = { onDemand: false, expansion: false, collaboration: false };
const CAP_COLLAB = { onDemand: true, expansion: true, collaboration: true };
const BASE = {
  workspaceId: "ws-baseline",
  task: "Baseline launch task",
  runId: "baseline-run",
  maxMembers: 8,
};

type Case = {
  mode: TeamMode;
  variant: string;
  roles: readonly Role[];
  team: Team;
  host: HostSnapshot;
  economy: EconomyPolicy;
  capabilities: typeof CAP_LEGACY;
};

function teamWith(members: Team["members"]): Team {
  return { ...codingTeam, members };
}

const baseMembers: Team["members"] = [
  { roleId: "architect", enabled: true },
  { roleId: "developer", instanceLabel: "Backend", enabled: true },
];

function legacyCases(): Case[] {
  const variants: Record<string, Omit<Case, "mode" | "capabilities" | "variant">> = {
    normal: {
      roles: [techLead, architect, developer],
      team: teamWith(baseMembers),
      host: { status: "ready", profiles, availability: allAvailable },
      economy: EMPTY,
    },
    poolUnavailable: {
      roles: [techLead, architect, developer],
      team: teamWith(baseMembers),
      host: {
        status: "ready",
        profiles,
        availability: [
          { provider: "claude", available: true },
          { provider: "codex", available: false },
        ],
      },
      economy: {
        pool: [{ profileId: "codex-xhigh", enabled: true, family: "deepseek" }],
        taskOrder: {},
        profileBudget: {},
      },
    },
    availabilityUnverified: {
      roles: [techLead, architect, developer],
      team: teamWith(baseMembers),
      host: { status: "ready", profiles, availability: [], availabilityUnverified: true },
      economy: EMPTY,
    },
    disabledRole: {
      roles: [techLead, architect, { ...developer, enabled: false }],
      team: teamWith(baseMembers),
      host: { status: "ready", profiles, availability: allAvailable },
      economy: EMPTY,
    },
    duplicateLabels: {
      roles: [techLead, architect, developer],
      team: teamWith([
        { roleId: "developer", instanceLabel: "Backend", enabled: true },
        { roleId: "developer", instanceLabel: "backend", enabled: true },
      ]),
      host: { status: "ready", profiles, availability: allAvailable },
      economy: EMPTY,
    },
    duplicateLabelsUnverified: {
      roles: [techLead, architect, developer],
      team: teamWith([
        { roleId: "developer", instanceLabel: "Backend", enabled: true },
        { roleId: "developer", instanceLabel: "backend", enabled: true },
      ]),
      host: { status: "ready", profiles, availability: [], availabilityUnverified: true },
      economy: EMPTY,
    },
  };
  return (["sota", "economy", "collaborative"] as const).flatMap((mode) =>
    Object.entries(variants).map(([variant, input]) => ({
      ...input,
      mode,
      variant,
      capabilities: mode === "collaborative" ? CAP_COLLAB : CAP_LEGACY,
    })),
  );
}

const opusOnly = (role: Role): Role => ({
  ...role,
  preferredProfiles: [{ profileId: claudeOpus.id, nameSnapshot: claudeOpus.name }],
  fallbackProfiles: [],
});
const coordinatorFallback: Role = {
  ...techLead,
  fallbackProfiles: [{ profileId: codexXhigh.id, nameSnapshot: codexXhigh.name }],
};
const coordinatorMissing: Role = {
  ...techLead,
  fallbackProfiles: [{ profileId: "missing-coordinator-profile" }],
};
const CLAUDE_DOWN: readonly ProviderAvailability[] = [
  { provider: "claude", available: false },
  { provider: "codex", available: true },
];
const COORD_MEMBER: Team["members"] = [
  { roleId: "developer", instanceLabel: "Backend", enabled: true },
];

function coordCases(): Case[] {
  const cases: Case[] = [];
  for (const mode of ["sota", "economy", "collaborative"] as const) {
    cases.push({
      mode,
      variant: "coordinatorFallback",
      roles: [coordinatorFallback, developer],
      team: teamWith(COORD_MEMBER),
      host: { status: "ready", profiles, availability: CLAUDE_DOWN },
      economy: EMPTY,
      capabilities: CAP_LEGACY,
    });
    cases.push({
      mode,
      variant: "coordinatorUnavailable",
      roles: [coordinatorMissing, developer],
      team: teamWith(COORD_MEMBER),
      host: { status: "ready", profiles, availability: CLAUDE_DOWN },
      economy: EMPTY,
      capabilities: CAP_LEGACY,
    });
  }
  cases.push({
    mode: "economy-all",
    variant: "oldPlannerEconomyAll",
    roles: [opusOnly(techLead), opusOnly(architect), opusOnly(developer)],
    team: {
      ...codingTeam,
      memberCreation: "eager",
      members: [
        { roleId: "architect", enabled: true },
        { roleId: "developer", instanceLabel: "Backend", enabled: true },
      ],
    },
    host: { status: "ready", profiles, availability: allAvailable },
    economy: EMPTY,
    capabilities: CAP_LEGACY,
  });
  return cases;
}

function economyAllCase(): Case {
  const cases = coordCases();
  const found = cases.find((entry) => entry.variant === "oldPlannerEconomyAll");
  if (!found) throw new Error("missing economy-all case");
  return found;
}

function issueView(issue: {
  code: string;
  severity: string;
  params: Record<string, string | number | boolean>;
  roleId?: string;
  seatId?: string;
}) {
  return {
    code: issue.code,
    severity: issue.severity,
    params: issue.params,
    ...(issue.roleId === undefined ? {} : { roleId: issue.roleId }),
    ...(issue.seatId === undefined ? {} : { seatId: issue.seatId }),
  };
}

function runCase(c: Case) {
  const plan = buildLaunchPlan({
    ...BASE,
    team: c.team,
    roles: c.roles,
    profiles: c.host.status === "ready" ? c.host.profiles : [],
    availability: c.host.status === "ready" ? c.host.availability : [],
    mode: c.mode,
    host: c.host,
    economy: c.economy,
    runtimeCapabilities: c.capabilities,
    daemonConfig: {},
  });
  const fingerprint = hashLaunchPlan({
    team: plan.team,
    roles: c.roles,
    plan,
    host: c.host,
    economy: c.economy,
    target: { kind: "workspace", workspaceId: BASE.workspaceId },
    task: BASE.task,
    maxMembers: BASE.maxMembers,
    runtimeCapabilities: c.capabilities,
  });
  const preview = toModeLaunchPreview(plan, fingerprint, [], c.economy);
  return { plan, fingerprint, preview };
}

function legacyActual(c: Case) {
  const { plan, fingerprint, preview } = runCase(c);
  return {
    mode: c.mode,
    variant: c.variant,
    capabilities: c.capabilities,
    seats: plan.seats.map((seat) => ({
      seatId: seat.seatId,
      logicalSeatId: seat.logicalSeatId,
      roleId: seat.roleId,
      purpose: seat.purpose,
      activation: seat.activation,
      profile: seat.selected.profile?.id ?? null,
      source: seat.selected.source,
      budget: seat.selected.budget,
      budgetBasis: seat.selected.budgetBasis,
      standby: seat.selected.standby,
      unavailable: seat.selected.unavailable,
      issues: seat.selected.issues.map(issueView),
    })),
    coordinator: {
      roleId: plan.coordinator.role.id,
      profile: plan.coordinator.profile.id,
      source: plan.coordinator.source,
    },
    counts: plan.seatCounts,
    budget: plan.seatBudget,
    issues: plan.seatIssues.map(issueView),
    warnings: plan.warnings,
    blockers: plan.blockers,
    preview,
    fingerprint,
  };
}

function coordActual(c: Case) {
  const { plan, fingerprint, preview } = runCase(c);
  return {
    mode: c.mode,
    variant: c.variant,
    caps: c.capabilities,
    coordinator: {
      roleId: plan.coordinator.role.id,
      profile: plan.coordinator.profile.id,
      source: plan.coordinator.source,
    },
    seats: plan.seats.map((seat) => ({
      seatId: seat.seatId,
      roleId: seat.roleId,
      profile: seat.selected.profile?.id ?? null,
      source: seat.selected.source,
      budget: seat.selected.budget,
      budgetBasis: seat.selected.budgetBasis,
    })),
    counts: plan.seatCounts,
    budget: plan.seatBudget,
    issues: plan.seatIssues.map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      params: issue.params,
    })),
    warnings: plan.warnings,
    blockers: plan.blockers,
    preview,
    fingerprint,
  };
}

describe("D02 golden baseline", () => {
  test("18 legacy-mode groups match the fa58137 literals", () => {
    const cases = legacyCases();
    expect(cases).toHaveLength(D02_BASELINE_LEGACY.length);
    cases.forEach((entry, index) => {
      expect(legacyActual(entry)).toEqual(D02_BASELINE_LEGACY[index]);
    });
  });

  test("coordinator warnings/failure match the fa58137 literals", () => {
    const cases = coordCases().filter((entry) => entry.variant !== "oldPlannerEconomyAll");
    expect(cases).toHaveLength(D02_BASELINE_COORD.length - 1);
    cases.forEach((entry, index) => {
      expect(coordActual(entry)).toEqual(D02_BASELINE_COORD[index]);
    });
  });

  test("T11: economy-all used to launch on original bindings and now routes or blocks", () => {
    const before = D02_BASELINE_COORD[D02_BASELINE_COORD.length - 1];
    expect(before).toMatchObject({
      variant: "oldPlannerEconomyAll",
      blockers: [],
      coordinator: { profile: claudeOpus.id, source: "role-preferred" },
    });
    const { plan } = runCase(economyAllCase());
    expect(plan.blockers.length).toBeGreaterThan(0);
    expect(
      plan.seats.every(
        (seat) => seat.selected.source === "economy-pool" || seat.selected.source === "unavailable",
      ),
    ).toBe(true);
  });
});

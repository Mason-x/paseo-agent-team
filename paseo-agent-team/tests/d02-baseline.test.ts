import { describe, expect, test } from "vitest";
import { hashLaunchPlan } from "../server/launch-hash";
import { buildLaunchPlan } from "../shared/domain/launch-plan";
import { toModeLaunchPreview } from "../shared/domain/launch-preview";
import type { HostSnapshot } from "../shared/domain/mode-resolver";
import type { Role } from "../shared/schemas/role";
import type { Team } from "../shared/schemas/team";
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

const profiles = [claudeOpus, codexXhigh];
const capabilities = { onDemand: false, expansion: false, collaboration: false };
const members: Team["members"] = [
  { roleId: "architect", enabled: true },
  { roleId: "developer", instanceLabel: "Backend", enabled: true },
];
const duplicateMembers: Team["members"] = [
  { roleId: "developer", instanceLabel: "Backend", enabled: true },
  { roleId: "developer", instanceLabel: "backend", enabled: true },
];
const available: HostSnapshot = { status: "ready", profiles, availability: allAvailable };
const unverified: HostSnapshot = {
  status: "ready",
  profiles,
  availability: [],
  availabilityUnverified: true,
};
const codexDown: HostSnapshot = {
  status: "ready",
  profiles,
  availability: [
    { provider: "claude", available: true },
    { provider: "codex", available: false },
  ],
};
const claudeDown: HostSnapshot = {
  status: "ready",
  profiles,
  availability: [
    { provider: "claude", available: false },
    { provider: "codex", available: true },
  ],
};

type Case = { variant: string; roles: readonly Role[]; team: Team; host: HostSnapshot };
const baseRoles = [techLead, architect, developer];
const teamWith = (next: Team["members"]): Team => ({ ...codingTeam, members: next });
const cases: Case[] = [
  { variant: "normal", roles: baseRoles, team: teamWith(members), host: available },
  { variant: "poolUnavailable", roles: baseRoles, team: teamWith(members), host: codexDown },
  {
    variant: "availabilityUnverified",
    roles: baseRoles,
    team: teamWith(members),
    host: unverified,
  },
  {
    variant: "disabledRole",
    roles: [techLead, architect, { ...developer, enabled: false }],
    team: teamWith(members),
    host: available,
  },
  {
    variant: "duplicateLabels",
    roles: baseRoles,
    team: teamWith(duplicateMembers),
    host: available,
  },
  {
    variant: "duplicateLabelsUnverified",
    roles: baseRoles,
    team: teamWith(duplicateMembers),
    host: unverified,
  },
];

function runCase(input: Case) {
  const plan = buildLaunchPlan({
    team: input.team,
    roles: input.roles,
    profiles,
    availability: input.host.status === "ready" ? input.host.availability : [],
    host: input.host,
    workspaceId: "ws-baseline",
    task: "Baseline launch task",
    runId: "baseline-run",
    maxMembers: 8,
    runtimeCapabilities: capabilities,
    daemonConfig: {},
  });
  const fingerprint = hashLaunchPlan({
    team: plan.team,
    roles: input.roles,
    plan,
    host: input.host,
    target: { kind: "workspace", workspaceId: "ws-baseline" },
    task: "Baseline launch task",
    maxMembers: 8,
    runtimeCapabilities: capabilities,
  });
  return { plan, fingerprint, preview: toModeLaunchPreview(plan, fingerprint) };
}

type Golden = {
  mode: string;
  variant: string;
  seats: Array<{
    seatId: string;
    logicalSeatId: string;
    roleId: string;
    purpose: string;
    activation: string;
    profile: string | null;
    source: string;
  }>;
  coordinator: { roleId: string; profile: string; source: string };
  counts: {
    logical: number;
    physical: number;
    eager: number;
    deferred: number;
    escalation: number;
  };
  issues: Array<{
    code: string;
    severity: string;
    params: Record<string, string | number | boolean>;
    roleId?: string;
    seatId?: string;
  }>;
  warnings: string[];
  blockers: string[];
};

function golden(rows: readonly Record<string, unknown>[], variant: string): Golden {
  const entry = rows.find((row) => row.mode === "sota" && row.variant === variant);
  if (!entry) throw new Error(`missing SOTA baseline ${variant}`);
  return entry as Golden;
}

function issueView(issue: Golden["issues"][number]) {
  const { mode: _retiredMode, ...params } = issue.params;
  return {
    code: issue.code,
    severity: issue.severity,
    params,
    ...(issue.roleId === undefined ? {} : { roleId: issue.roleId }),
    ...(issue.seatId === undefined ? {} : { seatId: issue.seatId }),
  };
}

function currentSeats(plan: ReturnType<typeof buildLaunchPlan>) {
  return plan.seats.map((seat) => ({
    seatId: seat.seatId,
    logicalSeatId: seat.logicalSeatId,
    roleId: seat.roleId,
    purpose: seat.purpose,
    activation: seat.activation,
    profile: seat.selected.profile.id,
    source: seat.selected.source,
  }));
}

function oldSeats(expected: Golden) {
  return expected.seats.map((seat) => ({
    seatId: seat.seatId,
    logicalSeatId: seat.logicalSeatId,
    roleId: seat.roleId,
    purpose: seat.purpose,
    activation: seat.activation,
    profile: seat.profile,
    source: seat.source,
  }));
}

describe("D02 flagship baseline", () => {
  test("preserves flagship seats, coordinator, counts and safety outcomes from the literals", () => {
    expect(cases).toHaveLength(6);
    for (const entry of cases) {
      const expected = golden(D02_BASELINE_LEGACY, entry.variant);
      const { plan, preview } = runCase(entry);
      expect(currentSeats(plan), entry.variant).toEqual(oldSeats(expected));
      expect(
        {
          roleId: plan.coordinator.role.id,
          profile: plan.coordinator.profile.id,
          source: plan.coordinator.source,
        },
        entry.variant,
      ).toEqual(expected.coordinator);
      expect(plan.seatCounts, entry.variant).toMatchObject({
        logical: expected.counts.logical,
        physical: expected.counts.physical,
        eager: expected.counts.eager,
        deferred: expected.counts.deferred,
        escalation: expected.counts.escalation,
      });
      expect(plan.seatIssues.map(issueView), entry.variant).toEqual(expected.issues.map(issueView));
      expect(plan.blockers, entry.variant).toEqual(expected.blockers);
      expect(plan.warnings, entry.variant).toEqual(expected.warnings);
      expect(
        preview.seats.map((seat) => seat.seatId),
        entry.variant,
      ).toEqual(expected.seats.map((seat) => seat.seatId));
    }
  });

  test("preserves the old coordinator fallback and failure outcomes", () => {
    for (const [variant, fallbackId] of [
      ["coordinatorFallback", codexXhigh.id],
      ["coordinatorUnavailable", "missing-coordinator-profile"],
    ] as const) {
      const expected = golden(D02_BASELINE_COORD, variant);
      const lead = { ...techLead, fallbackProfiles: [{ profileId: fallbackId }] };
      const { plan, preview } = runCase({
        variant,
        roles: [lead, developer],
        team: teamWith([{ roleId: "developer", instanceLabel: "Backend", enabled: true }]),
        host: claudeDown,
      });
      expect(
        {
          roleId: plan.coordinator.role.id,
          profile: plan.coordinator.profile.id,
          source: plan.coordinator.source,
        },
        variant,
      ).toEqual(expected.coordinator);
      expect(plan.warnings, variant).toEqual(expected.warnings);
      expect(plan.blockers, variant).toEqual(expected.blockers);
      expect(preview.coordinator.profile?.id ?? "missing", variant).toBe(
        expected.coordinator.profile,
      );
    }
  });

  test("old stored mode and collaboration do not change the flagship plan or hash", () => {
    const base = cases[0];
    if (!base) throw new Error("missing baseline case");
    const expected = runCase(base);
    for (const mode of ["economy", "economy-all", "collaborative", "future-mode"]) {
      const actual = runCase({
        ...base,
        team: { ...base.team, mode, collaboration: { replicas: 3, judgeRoleId: "architect" } },
      });
      expect(currentSeats(actual.plan), mode).toEqual(currentSeats(expected.plan));
      expect(actual.plan.blockers, mode).toEqual(expected.plan.blockers);
      expect(actual.plan.warnings, mode).toEqual(expected.plan.warnings);
      expect(actual.fingerprint, mode).toBe(expected.fingerprint);
      expect(actual.preview.requestedMode, mode).toBe("sota");
    }
  });
});

import { describe, expect, test } from "vitest";
import { hashLaunchPlan } from "../server/launch-hash";
import type { LaunchPlanHashInput } from "../shared/domain/launch-hash";
import { buildLaunchPlan } from "../shared/domain/launch-plan";
import type { EconomyPolicy, HostSnapshot } from "../shared/domain/mode-resolver";
import {
  allAvailable,
  architect,
  claudeOpus,
  codexXhigh,
  codingTeam,
  developer,
  techLead,
} from "./fixtures";

const emptyEconomy: EconomyPolicy = { pool: [], taskOrder: {}, profileBudget: {} };
const host: HostSnapshot = {
  status: "ready",
  profiles: [claudeOpus, codexXhigh],
  availability: allAvailable,
};
const roles = [techLead, architect, developer];

function input(overrides: Partial<LaunchPlanHashInput> = {}): LaunchPlanHashInput {
  const plan =
    overrides.plan ??
    buildLaunchPlan({
      team: codingTeam,
      roles,
      profiles: [claudeOpus, codexXhigh],
      availability: allAvailable,
      workspaceId: "ws-1",
      task: "Add Stripe",
      runId: "preview",
      maxMembers: 24,
      host,
      economy: emptyEconomy,
      runtimeCapabilities: { onDemand: false, expansion: false, collaboration: false },
    });
  return {
    team: codingTeam,
    roles,
    plan,
    host,
    economy: emptyEconomy,
    target: { kind: "workspace", workspaceId: "ws-1" },
    task: "Add Stripe",
    maxMembers: 24,
    runtimeCapabilities: { onDemand: false, expansion: false, collaboration: false },
    ...overrides,
  };
}

describe("launch plan hash", () => {
  test("is stable, and ignores Profile notes and unrelated Roles", () => {
    const base = input();
    expect(hashLaunchPlan(base)).toBe(hashLaunchPlan(input()));
    const withNotes = {
      ...host,
      profiles:
        host.status === "ready"
          ? host.profiles.map((profile) => ({ ...profile, notes: "host only" }))
          : [],
    };
    const unrelatedRole = { ...architect, id: "unrelated-role", name: "Unrelated" };
    expect(
      hashLaunchPlan({
        ...base,
        host: withNotes,
        roles: [...roles, unrelatedRole],
      }),
    ).toBe(hashLaunchPlan(base));
    // The service trims the task; hash the same text so surrounding spaces do not invalidate.
    expect(hashLaunchPlan({ ...base, task: "  Add Stripe  " })).toBe(hashLaunchPlan(base));
  });

  test("changes when launch-relevant input changes", () => {
    const base = hashLaunchPlan(input());
    const changedProfiles = {
      ...host,
      profiles:
        host.status === "ready"
          ? host.profiles.map((profile) =>
              profile.id === claudeOpus.id ? { ...profile, modeId: "manual" } : profile,
            )
          : [],
    };
    const changedAvailability = {
      ...host,
      availability: allAvailable.map((entry) =>
        entry.provider === "codex" ? { ...entry, available: false } : entry,
      ),
    };
    const changedRoles = roles.map((role) =>
      role.id === "architect" ? { ...role, systemPrompt: "A different prompt" } : role,
    );
    const cases = [
      input({ task: "Another task" }),
      input({ maxMembers: 9 }),
      input({ target: { kind: "new-workspace", projectId: "p1", title: "Billing" } }),
      input({ host: changedProfiles }),
      input({ host: changedAvailability }),
      input({ roles: changedRoles }),
      input({ team: { ...codingTeam, name: "Renamed Team" } }),
      input({ economy: { ...emptyEconomy, pool: [{ profileId: claudeOpus.id, enabled: true }] } }),
      input({
        runtimeCapabilities: { onDemand: true, expansion: false, collaboration: false },
      }),
    ];
    for (const candidate of cases) expect(hashLaunchPlan(candidate)).not.toBe(base);
  });

  test("covers mode and member creation decisions", () => {
    const sota = input();
    const economyPlan = buildLaunchPlan({
      team: { ...codingTeam, mode: "economy" },
      roles,
      profiles: [claudeOpus, codexXhigh],
      availability: allAvailable,
      workspaceId: "ws-1",
      task: "Add Stripe",
      runId: "preview",
      maxMembers: 24,
      host,
      economy: emptyEconomy,
      runtimeCapabilities: { onDemand: false, expansion: false, collaboration: false },
    });
    expect(hashLaunchPlan({ ...sota, plan: economyPlan })).not.toBe(hashLaunchPlan(sota));
  });
});

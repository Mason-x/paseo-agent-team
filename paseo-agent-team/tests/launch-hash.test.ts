import { describe, expect, test } from "vitest";
import { hashLaunchPlan } from "../server/launch-hash";
import { LAUNCH_PLANNER_VERSION, type LaunchPlanHashInput } from "../shared/domain/launch-hash";
import { buildLaunchPlan } from "../shared/domain/launch-plan";
import type { HostSnapshot } from "../shared/domain/mode-resolver";
import {
  allAvailable,
  architect,
  claudeOpus,
  codexXhigh,
  codingTeam,
  developer,
  techLead,
} from "./fixtures";

const host: HostSnapshot = {
  status: "ready",
  profiles: [claudeOpus, codexXhigh],
  availability: allAvailable,
};
const roles = [techLead, architect, developer];
const runtimeCapabilities = { onDemand: false, expansion: false, collaboration: false };
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
      runtimeCapabilities,
    });
  return {
    team: codingTeam,
    roles,
    plan,
    host,
    target: { kind: "workspace", workspaceId: "ws-1" },
    task: "Add Stripe",
    maxMembers: 24,
    runtimeCapabilities,
    ...overrides,
  };
}

describe("launch plan hash", () => {
  test("is stable and ignores Profile notes, unrelated Roles, and task whitespace", () => {
    const base = input();
    expect(LAUNCH_PLANNER_VERSION).toBe(3);
    expect(hashLaunchPlan(base)).toBe(hashLaunchPlan(input()));
    const withNotes: HostSnapshot = {
      ...host,
      profiles: host.profiles.map((profile) => ({ ...profile, notes: "host only" })),
    };
    expect(
      hashLaunchPlan({
        ...base,
        host: withNotes,
        roles: [...roles, { ...architect, id: "unrelated-role" }],
      }),
    ).toBe(hashLaunchPlan(base));
    expect(hashLaunchPlan({ ...base, task: "  Add Stripe  " })).toBe(hashLaunchPlan(base));
  });

  test("changes when launch-relevant input changes", () => {
    const base = hashLaunchPlan(input());
    const changedProfiles: HostSnapshot = {
      ...host,
      profiles: host.profiles.map((profile) =>
        profile.id === claudeOpus.id ? { ...profile, modeId: "manual" } : profile,
      ),
    };
    const changedAvailability: HostSnapshot = {
      ...host,
      availability: allAvailable.map((entry) =>
        entry.provider === "codex" ? { ...entry, available: false } : entry,
      ),
    };
    const changedRoles = roles.map((entry) =>
      entry.id === "architect" ? { ...entry, systemPrompt: "A different prompt" } : entry,
    );
    const cases = [
      input({ task: "Another task" }),
      input({ maxMembers: 9 }),
      input({ target: { kind: "new-workspace", projectId: "p1", title: "Billing" } }),
      input({ host: changedProfiles }),
      input({ host: changedAvailability }),
      input({ roles: changedRoles }),
      input({ team: { ...codingTeam, name: "Renamed Team" } }),
      input({ runtimeCapabilities: { ...runtimeCapabilities, onDemand: true } }),
    ];
    for (const candidate of cases) expect(hashLaunchPlan(candidate)).not.toBe(base);
  });

  test("ignores retired Team and Role fields but includes member creation", () => {
    const base = input();
    const legacyTeam = { ...codingTeam, mode: "economy-all", collaboration: { replicas: 3 } };
    const legacyRoles = roles.map((entry) => ({
      ...entry,
      executionPolicy: { tier: "execution", taskKind: "coding" },
    }));
    expect(hashLaunchPlan({ ...base, team: legacyTeam, roles: legacyRoles })).toBe(
      hashLaunchPlan(base),
    );
    expect(
      hashLaunchPlan({ ...base, team: { ...codingTeam, memberCreation: "on-demand" } }),
    ).not.toBe(hashLaunchPlan(base));
  });
});

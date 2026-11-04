import { describe, expect, test } from "vitest";
import { buildLaunchPlan } from "../shared/domain/launch-plan";
import type { HostSnapshot } from "../shared/domain/mode-resolver";
import { buildTeamModelPlan } from "../shared/domain/team-model-plan";
import { zh } from "../shared/zh";
import {
  allAvailable,
  architect,
  claudeOpus,
  codexXhigh,
  codingTeam,
  developer,
  techLead,
} from "./fixtures";

const roles = [techLead, architect, developer];
const host: HostSnapshot = {
  status: "ready",
  profiles: [claudeOpus, codexXhigh],
  availability: allAvailable,
};
const runtimeCapabilities = { onDemand: false, expansion: false, collaboration: false };

describe("single-path planning kernel boundaries", () => {
  test("unknown stored mode and collaboration do not change the resolved members", () => {
    const team = { ...codingTeam, mode: "turbo", collaboration: { replicas: 3 } };
    const result = buildTeamModelPlan({ team, roles, host, maxMembers: 8, runtimeCapabilities });
    expect(result.effectiveMode).toBe("sota");
    expect(result.blockers).toEqual([]);
    expect(result.coordinator.selection?.profile.id).toBe(claudeOpus.id);
    expect(result.seatPlan.seats.map((seat) => seat.selected.profile.id)).toEqual([
      claudeOpus.id,
      codexXhigh.id,
    ]);
  });

  test("coordinator tool gate uses the provider actually resolved", () => {
    const fallback = {
      ...techLead,
      preferredProfiles: [{ profileId: "missing" }],
      fallbackProfiles: [{ profileId: codexXhigh.id }],
    };
    const plan = buildLaunchPlan({
      team: codingTeam,
      roles: [fallback, architect, developer],
      profiles: [claudeOpus, codexXhigh],
      availability: allAvailable,
      workspaceId: "ws-1",
      task: "test",
      runId: "r",
      maxMembers: 8,
      host,
      daemonConfig: { providers: { codex: { paseoTools: { enabled: false } } } },
    });
    expect(plan.coordinator.source).toBe("role-fallback");
    expect(plan.coordinator.profile.id).toBe(codexXhigh.id);
    expect(plan.blockers).toContain(zh.providerToolsDisabled("codex"));
  });

  test("coordinator keeps fallback source and warning order", () => {
    const fallback = {
      ...techLead,
      preferredProfiles: [{ profileId: "missing-preferred" }],
      fallbackProfiles: [{ profileId: codexXhigh.id }],
    };
    const result = buildTeamModelPlan({
      team: codingTeam,
      roles: [fallback, architect, developer],
      host,
      maxMembers: 8,
      runtimeCapabilities,
    });
    expect(result.coordinator.selection?.source).toBe("role-fallback");
    expect(result.coordinator.warnings).toHaveLength(2);
    expect(result.coordinator.warnings[0]).toContain("缺失");
    expect(result.coordinator.warnings[1]).toContain(codexXhigh.name);
  });

  test("an unresolved coordinator keeps the failure reason and never picks another Role", () => {
    const missing = {
      ...techLead,
      preferredProfiles: [{ profileId: "missing" }],
      fallbackProfiles: [],
    };
    const result = buildTeamModelPlan({
      team: codingTeam,
      roles: [missing, architect, developer],
      host,
      maxMembers: 8,
      runtimeCapabilities,
    });
    expect(result.coordinator.selection).toBeNull();
    expect(result.coordinator.legacyFailureReason).toBe("all-missing");
    expect(result.seatPlan.seats).toHaveLength(2);
  });
});

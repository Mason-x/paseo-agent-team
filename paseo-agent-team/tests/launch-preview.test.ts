import { describe, expect, test } from "vitest";
import { hashLaunchPlan } from "../server/launch-hash";
import { buildLaunchPlan } from "../shared/domain/launch-plan";
import { toModeLaunchPreview } from "../shared/domain/launch-preview";
import type { EconomyPolicy, HostSnapshot } from "../shared/domain/mode-resolver";
import { ModeLaunchPreviewSchema } from "../shared/schemas/launch-preview";
import type { Team } from "../shared/schemas/team";
import {
  allAvailable,
  architect,
  claudeOpus,
  codexXhigh,
  codingTeam,
  developer,
  role,
  techLead,
} from "./fixtures";

const emptyEconomy: EconomyPolicy = { pool: [], taskOrder: {}, profileBudget: {} };
const host: HostSnapshot = {
  status: "ready",
  profiles: [claudeOpus, codexXhigh],
  availability: allAvailable,
};

function makePlan(
  team: Team,
  roles = [techLead, architect, developer],
  options: {
    host?: HostSnapshot;
    mode?: "sota" | "economy" | "collaborative";
  } = {},
) {
  return buildLaunchPlan({
    team,
    roles,
    profiles: [claudeOpus, codexXhigh],
    availability: allAvailable,
    workspaceId: "ws-1",
    task: "Add Stripe",
    runId: "preview",
    maxMembers: 24,
    mode: options.mode,
    host: options.host ?? host,
    economy: emptyEconomy,
    runtimeCapabilities: { onDemand: false, expansion: false, collaboration: false },
  });
}

function previewOf(plan: ReturnType<typeof makePlan>, hash = "a".repeat(64)) {
  return toModeLaunchPreview(plan, hash);
}

describe("launch preview DTO", () => {
  test("maps seats and coordinator without prompts, MCP, or Profile notes", () => {
    const plan = makePlan(codingTeam);
    const preview = previewOf(plan);
    expect(ModeLaunchPreviewSchema.parse(preview)).toEqual(preview);
    expect(preview.requestedMode).toBe("sota");
    expect(preview.seats).toHaveLength(2);
    expect(preview.counts).toEqual(plan.seatCounts);
    expect(preview.budget).toEqual(plan.seatBudget);
    expect(preview.coordinator.profile).toEqual({
      id: claudeOpus.id,
      name: claudeOpus.name,
      provider: "claude",
      model: "opus",
    });
    expect(preview.seats[0]?.profile).toEqual({
      id: claudeOpus.id,
      name: claudeOpus.name,
      provider: "claude",
      model: "opus",
    });
    const json = JSON.stringify(preview);
    expect(json).not.toContain('"notes"');
    expect(json).not.toContain("systemPrompt");
    expect(json).not.toContain("mcpServers");
  });

  test("keeps an unavailable escalation seat explicit instead of dropping it", () => {
    const expert = role({
      id: "eng-expert",
      name: "Expert",
      preferredProfiles: [{ profileId: claudeOpus.id, nameSnapshot: claudeOpus.name }],
    });
    const plan = makePlan(
      {
        ...codingTeam,
        mode: "economy",
        members: [
          { roleId: "eng-expert", instanceLabel: "Expert", seatId: "seat-expert", enabled: true },
        ],
      },
      [techLead, expert],
      {
        mode: "economy",
        host: {
          status: "ready",
          profiles: [claudeOpus, codexXhigh],
          availability: allAvailable.map((entry) =>
            entry.provider === "claude" ? { ...entry, available: false } : entry,
          ),
        },
      },
    );
    const preview = previewOf(plan);
    const seat = preview.seats[0];
    expect(seat).toMatchObject({
      seatId: "seat-expert",
      purpose: "escalation",
      activation: "escalation-only",
      source: "unavailable",
      unavailable: true,
      profile: null,
    });
    expect(ModeLaunchPreviewSchema.parse(preview)).toEqual(preview);
  });

  test("hashes the same launch the same way regardless of preview run id", () => {
    const plan = makePlan(codingTeam);
    const input = {
      team: codingTeam,
      roles: [techLead, architect, developer],
      plan,
      host,
      economy: emptyEconomy,
      target: { kind: "workspace" as const, workspaceId: "ws-1" },
      task: "Add Stripe",
      maxMembers: 24,
      runtimeCapabilities: { onDemand: false, expansion: false, collaboration: false },
    };
    const other = { ...plan, runId: "another", mode: plan.mode };
    expect(hashLaunchPlan(input)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashLaunchPlan({ ...input, plan: other })).toBe(hashLaunchPlan(input));
  });
});

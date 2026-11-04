import { describe, expect, test, vi } from "vitest";
import { createDesignPlanner } from "../server/designer/planning";
import { createLaunchService } from "../server/launch-service";
import type { DesignPlanningInput } from "../shared/domain/design-planning";
import type * as LaunchPlanModule from "../shared/domain/launch-plan";
import { LAUNCH_RUNTIME_CAPABILITIES } from "../shared/domain/launch-runtime";
import { ModeLaunchPreviewSchema } from "../shared/schemas/launch-preview";
import { PreferencesSchema } from "../shared/schemas/preferences";
import { fakePort, healthyConfig, ready } from "./fakes";
import {
  allAvailable,
  architect,
  claudeOpus,
  codexXhigh,
  codingTeam,
  developer,
  techLead,
} from "./fixtures";

const calls = vi.hoisted(() => ({ count: 0 }));
vi.mock("../shared/domain/launch-plan", async (importOriginal) => {
  const actual = await importOriginal<typeof LaunchPlanModule>();
  return {
    ...actual,
    buildLaunchPlan: (input: Parameters<typeof actual.buildLaunchPlan>[0]) => {
      calls.count += 1;
      return actual.buildLaunchPlan(input);
    },
  };
});

const roles = [techLead, architect, developer];
function input(): DesignPlanningInput {
  return {
    jobId: "11111111-1111-4111-8111-111111111111",
    team: {
      ...codingTeam,
      members: [
        { roleId: architect.id, seatId: "seat-m1", enabled: true },
        { roleId: developer.id, seatId: "seat-m2", enabled: true },
      ],
    },
    roles,
    host: { status: "ready", profiles: [claudeOpus, codexXhigh], availability: allAvailable },
    preferences: PreferencesSchema.parse({ maxMembers: 8 }),
    daemonConfig: healthyConfig,
    workspaceId: "ws-1",
    request: "Add Stripe",
  };
}

describe("design planning", () => {
  test("reuses the original bindings and keeps a stable plan hash", () => {
    const planner = createDesignPlanner();
    const first = planner.plan(input());
    const second = planner.plan(input());
    if (!first.ok || !second.ok) throw new Error("unexpected blockers");
    const preview = ModeLaunchPreviewSchema.parse(first.preview);
    expect(preview.requestedMode).toBe("sota");
    expect(preview.coordinator.profile?.id).toBe(claudeOpus.id);
    expect(preview.seats.map((seat) => seat.profile?.id)).toEqual([claudeOpus.id, codexXhigh.id]);
    expect(preview.counts).toMatchObject({ logical: 2, physical: 2 });
    expect(preview.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.preview.planHash).toBe(preview.planHash);
  });

  test("designer and launch-service share the planHash and warnings", async () => {
    const designInput = input();
    const design = createDesignPlanner().plan(designInput);
    if (!design.ok) throw new Error(design.launchBlockers.join(","));
    const fake = fakePort(healthyConfig);
    const service = createLaunchService({
      roles: ready({ roles }),
      teams: ready({ teams: [designInput.team] }),
      preferences: ready(designInput.preferences),
    });
    const launch = await service.preview(
      {
        teamId: designInput.team.id,
        task: designInput.request,
        target: { kind: "workspace", workspaceId: designInput.workspaceId },
      },
      fake.port,
    );
    if (!launch.ok) throw new Error(launch.blockers.join(","));
    expect(design.preview.planHash).toBe(launch.preview.planHash);
    expect(design.launchWarnings).toEqual(launch.preview.warnings);
    expect(design.preview.warnings).toEqual(launch.preview.warnings);
    expect(fake.created).toHaveLength(0);
    expect(LAUNCH_RUNTIME_CAPABILITIES).toEqual({
      onDemand: false,
      expansion: false,
      collaboration: false,
    });
  });

  test("enforces physical seat limits and keeps legacy maxMembers values", () => {
    for (const sample of [
      { members: 8, max: 8, ok: true },
      { members: 9, max: 8, ok: false },
      { members: 24, max: 24, ok: true },
      { members: 25, max: 24, ok: false },
      { members: 64, max: 64, ok: true },
      { members: 65, max: 100, ok: false },
    ]) {
      const current = input();
      current.team = {
        ...current.team,
        members: Array.from({ length: sample.members }, (_, index) => ({
          roleId: architect.id,
          instanceLabel: `seat-${index + 1}`,
          seatId: `seat-${index + 1}`,
          enabled: true,
        })),
      };
      current.preferences = PreferencesSchema.parse({ maxMembers: sample.max });
      const result = createDesignPlanner().plan(current);
      expect(result.ok, `${sample.members}/${sample.max}`).toBe(sample.ok);
      if (!result.ok) {
        expect(result.issues.map((issue) => issue.code)).toContain("MODE_MEMBER_LIMIT");
      } else {
        expect(result.preview.counts.physical).toBe(sample.members);
        expect(result.preview.seats).toHaveLength(sample.members);
      }
    }
  });

  test("an unavailable host returns a blocked plan with a context issue", () => {
    const current = input();
    current.host = { status: "unavailable", reason: "provider snapshot failed" };
    const result = createDesignPlanner().plan(current);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected plan");
    expect(result.issues.map((issue) => issue.code)).toContain("MODE_CONTEXT_UNAVAILABLE");
    expect(result.launchBlockers.length).toBeGreaterThan(0);
  });

  test("two logical seats of the same Role keep separate identities", () => {
    const current = input();
    current.team = {
      ...current.team,
      members: [
        { roleId: architect.id, seatId: "a", instanceLabel: "First", enabled: true },
        { roleId: architect.id, seatId: "b", instanceLabel: "Second", enabled: true },
      ],
    };
    const result = createDesignPlanner().plan(current);
    if (!result.ok) throw new Error(result.launchBlockers.join(","));
    expect(
      result.preview.seats.map((seat) => ({
        id: seat.seatId,
        logical: seat.logicalSeatId,
        role: seat.roleId,
      })),
    ).toEqual([
      { id: "a", logical: "a", role: architect.id },
      { id: "b", logical: "b", role: architect.id },
    ]);
  });

  test("invalid member creation surfaces a blocker instead of a preview", () => {
    const current = input();
    current.team = { ...current.team, memberCreation: "future" };
    const result = createDesignPlanner().plan(current);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected plan");
    expect(result.launchBlockers.length).toBeGreaterThan(0);
    expect(result.issues.map((issue) => issue.code)).toContain("MODE_UNKNOWN");
  });

  test("planDesign consumes the shared planner exactly once", () => {
    calls.count = 0;
    expect(createDesignPlanner().plan(input()).ok).toBe(true);
    expect(calls.count).toBe(1);
  });
});

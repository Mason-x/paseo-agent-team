import { describe, expect, test } from "vitest";
import { buildLaunchPlan } from "../shared/domain/launch-plan";
import { toModeLaunchPreview } from "../shared/domain/launch-preview";
import type { HostSnapshot } from "../shared/domain/mode-resolver";
import { ModeLaunchPreviewSchema } from "../shared/schemas/launch-preview";
import type { Role } from "../shared/schemas/role";
import type { Team } from "../shared/schemas/team";
import { NOW, role } from "./fixtures";

const preferred = { id: "primary", name: "Primary", provider: "claude", model: "sonnet" };
const fallback = { id: "fallback", name: "Fallback", provider: "codex", model: "gpt-5" };
const profiles = [preferred, fallback];
const available: HostSnapshot = {
  status: "ready",
  profiles,
  availability: [
    { provider: "claude", available: true },
    { provider: "codex", available: true },
  ],
};
const lead = role({ id: "lead", name: "Lead", preferredProfiles: [{ profileId: preferred.id }] });
const member = role({
  id: "eng-fullstack",
  name: "Engineer",
  preferredProfiles: [{ profileId: preferred.id }],
  fallbackProfiles: [{ profileId: fallback.id }],
});
const team: Team = {
  id: "t1",
  name: "Team",
  coordinatorRoleId: lead.id,
  members: [{ roleId: member.id, enabled: true }],
  memberCreation: "eager",
  enabled: true,
  createdAt: NOW,
  updatedAt: NOW,
};

function launch(nextTeam: Team = team, roles: Role[] = [lead, member], host = available) {
  return buildLaunchPlan({
    team: nextTeam,
    roles,
    profiles: host.status === "ready" ? host.profiles : [],
    availability: host.status === "ready" ? host.availability : [],
    host,
    workspaceId: "ws",
    task: "task",
    runId: "run",
    maxMembers: 8,
    runtimeCapabilities: { onDemand: true, expansion: true, collaboration: false },
    daemonConfig: {},
  });
}

describe("single-path launch preview compatibility", () => {
  test("unknown and historical stored modes keep the coordinator and the same valid DTO", () => {
    for (const mode of ["Economy", "economy-all", "collaborative"]) {
      const plan = launch({ ...team, mode });
      const preview = toModeLaunchPreview(plan, "h");
      expect(plan.blockers, mode).toEqual([]);
      expect(plan.coordinator.profile.id, mode).toBe(preferred.id);
      expect(preview.requestedMode, mode).toBe("sota");
      expect(preview.rawMode, mode).toBeUndefined();
      expect(preview.coordinator.roleId, mode).toBe(lead.id);
      expect(preview.coordinator.profile?.id, mode).toBe(preferred.id);
      expect(
        preview.issues.map((item) => item.code),
        mode,
      ).not.toContain("MODE_UNKNOWN");
      expect(ModeLaunchPreviewSchema.safeParse(preview).success, mode).toBe(true);
    }
  });

  test("a missing member binding remains a blocker and reaches the DTO", () => {
    const unbound = { ...member, preferredProfiles: [], fallbackProfiles: [] };
    const plan = launch(team, [lead, unbound]);
    expect(plan.blockers.length).toBeGreaterThan(0);
    expect(plan.seatIssues).toContainEqual(
      expect.objectContaining({
        code: "MODE_PROFILE_UNRESOLVED",
        severity: "blocker",
        roleId: member.id,
      }),
    );
    const preview = toModeLaunchPreview(plan, "h");
    expect(preview.issues).toContainEqual(
      expect.objectContaining({ code: "MODE_PROFILE_UNRESOLVED", roleId: member.id }),
    );
    expect(ModeLaunchPreviewSchema.safeParse(preview).success).toBe(true);
  });

  test("an unreadable retired coordinator tier leaves the real binding unchanged", () => {
    const oldLead = { ...lead, executionPolicy: { tier: "future-tier" } };
    const plan = launch({ ...team, mode: "economy-all" }, [oldLead, member]);
    expect(plan.blockers).toEqual([]);
    expect(plan.coordinator.profile.id).toBe(preferred.id);
    expect(plan.warnings).toEqual([]);
  });

  test("coordinator and seat DTOs keep their fixed compatibility budget", () => {
    const preview = toModeLaunchPreview(launch(), "h");
    expect(preview.coordinator).toMatchObject({ budget: "unknown", budgetBasis: "host" });
    expect(preview.seats).toHaveLength(1);
    expect(preview.seats[0]).toMatchObject({ budget: "unknown", budgetBasis: "host" });
    expect(ModeLaunchPreviewSchema.safeParse(preview).success).toBe(true);
  });
});

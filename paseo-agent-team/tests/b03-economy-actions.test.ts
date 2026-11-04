// Exercise the real Team plan and view-model repair path without connecting to a daemon.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildTeamModelRows, buildTeamSummary } from "../client/teams/team-plan-state";
import { createTeamPlanService } from "../server/team-plan-service";
import type { Preferences } from "../shared/schemas/preferences";
import type { RolesDocument, TeamsDocument } from "../shared/settings";
import { fakePort, preferences } from "./fakes";
import { claudeOpus, codingTeam, role, techLead } from "./fixtures";
import { DesignSettingsStore } from "./helpers/design-settings-store";

const unboundRole = role({
  id: "unbound",
  name: "Unbound",
  preferredProfiles: [],
  fallbackProfiles: [],
});

async function planTeam(enabled = true) {
  const settings = new DesignSettingsStore({
    roles: { roles: [techLead, unboundRole] },
    teams: {
      teams: [
        {
          ...codingTeam,
          mode: "economy-all",
          members: [{ roleId: unboundRole.id, enabled }],
        },
      ],
    },
    preferences: {
      ...preferences,
      economy: { allSeats: { version: 1, routes: { execution: [] } } },
    },
  });
  const read = <T>(key: "roles" | "teams" | "preferences") => {
    const value = settings.read(key);
    return { status: "ready" as const, revision: value.revision, values: value.values as T };
  };
  const service = createTeamPlanService({
    readers: {
      roles: { read: async () => read<RolesDocument>("roles") },
      teams: { read: async () => read<TeamsDocument>("teams") },
      preferences: { read: async () => read<Preferences>("preferences") },
    },
  });
  const port = fakePort({
    agentProfiles: [claudeOpus],
    mcp: { enabled: true, injectIntoAgents: true },
  }).port;
  port.providers.listAvailable.mockResolvedValue({
    providers: [{ provider: "claude", available: true }],
  });
  const output = await service.plan(
    { items: [{ key: codingTeam.id, kind: "saved", teamId: codingTeam.id }] },
    port,
  );
  const result = output.results[0];
  if (!result) throw new Error("missing result");
  return result;
}

describe("Team binding repair", () => {
  test("a real unbound Role produces a warning summary and a Role repair action", async () => {
    const result = await planTeam();
    expect(result.effectiveMode).toBe("sota");
    const summary = buildTeamSummary({ result, hasContext: true });
    expect(summary).toMatchObject({ kind: "summary", tone: "warning" });
    if (summary.kind !== "summary") throw new Error(`unexpected summary ${summary.kind}`);
    expect(summary.unresolvedText).not.toBeNull();
    const rows = buildTeamModelRows({ result });
    const unbound = rows.find((row) => row.roleId === unboundRole.id);
    expect(unbound).toMatchObject({ enabled: true, profileName: null });
    expect(unbound?.actions).toEqual([{ kind: "role", roleId: unboundRole.id }]);
    expect(rows.flatMap((row) => row.actions).every((action) => action.kind === "role")).toBe(true);
  });

  test("a disabled member never offers a repair action", async () => {
    const result = await planTeam(false);
    const member = buildTeamModelRows({ result }).find((row) => row.roleId === unboundRole.id);
    expect(member).toMatchObject({ enabled: false, actions: [] });
  });

  test("the Team editor forwards the Role repair action to the app", () => {
    const root = path.join(import.meta.dirname, "..");
    const row = readFileSync(path.join(root, "client", "teams", "ModelRow.tsx"), "utf8");
    expect(row).toContain("onOpenRole(target.roleId, target.profileId)");
    const editor = readFileSync(path.join(root, "client", "teams", "TeamEditor.tsx"), "utf8");
    expect(editor).toContain("onOpenRole={onOpenRole}");
    const screen = readFileSync(path.join(root, "client", "app", "AgentTeamsScreen.tsx"), "utf8");
    expect(screen).toContain("onOpenRole={(roleId, profileId) =>");
    expect(screen).toContain("roleEditorTargetForGap(");
  });
});

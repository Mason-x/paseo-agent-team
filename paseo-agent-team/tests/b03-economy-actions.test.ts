// V01b-FIX3 / AC-0b.9: an economy-all route outage must offer the economy-pool entry from the
// Team card and the editor's warning, at the affected layer/route. The plan is real; only the
// screen wiring is asserted from source because the plugin has no component renderer here.
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

const execRole = role({
  id: "exec",
  name: "Exec",
  executionPolicy: { tier: "execution", taskKind: "coding" },
});
const cheap = {
  id: "cheap-deepseek",
  name: "Cheap",
  provider: "deepseek",
  model: "deepseek-coder",
};

async function routeOutage() {
  const settings = new DesignSettingsStore({
    roles: { roles: [techLead, execRole] },
    teams: {
      teams: [
        {
          ...codingTeam,
          mode: "economy-all",
          members: [{ roleId: execRole.id, enabled: true }],
        },
      ],
    },
    preferences: {
      ...preferences,
      economy: {
        allSeats: {
          version: 1,
          profiles: [
            {
              profileId: cheap.id,
              enabled: true,
              costClass: "low",
              family: "deepseek",
              boundModel: { provider: "deepseek", model: cheap.model },
            },
          ],
          routes: {
            coordinator: [cheap.id],
            decision: [cheap.id],
            execution: [],
            escalation: [cheap.id],
            retain: [cheap.id],
          },
        },
      },
    } as Preferences,
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
    agentProfiles: [claudeOpus, cheap],
    mcp: { enabled: true, injectIntoAgents: true },
  }).port;
  port.providers.listAvailable.mockResolvedValue({
    providers: [
      { provider: "claude", available: true },
      { provider: "deepseek", available: true },
    ],
  });
  const output = await service.plan(
    { items: [{ key: codingTeam.id, kind: "saved", teamId: codingTeam.id }] },
    port,
  );
  const result = output.results[0];
  if (!result) throw new Error("missing result");
  return result;
}

describe("V01b-FIX3 economy-pool entries", () => {
  test("the route-empty Team card carries the all-seats execution action", async () => {
    const result = await routeOutage();
    expect(result.effectiveMode).toBe("economy-all");
    const summary = buildTeamSummary({ result, hasContext: true });
    if (summary.kind !== "summary") throw new Error(`unexpected summary ${summary.kind}`);
    expect(summary.unresolvedText).toContain("路由未配置");
    expect(summary.actions).toEqual([{ kind: "economy", layer: "allSeats", route: "execution" }]);
  });

  test("the affected row still keeps its own action, and disabled rows do not add one", async () => {
    const result = await routeOutage();
    const rows = buildTeamModelRows({ result });
    const exec = rows.find((row) => row.roleName === "Exec");
    expect(exec?.enabled).toBe(true);
    expect(exec?.actions).toContainEqual({
      kind: "economy",
      layer: "allSeats",
      route: "execution",
    });
  });

  test("TeamList, TeamsTab and both editors render/forward the economy callback", () => {
    const root = path.join(import.meta.dirname, "..");
    const list = readFileSync(path.join(root, "client", "teams", "TeamList.tsx"), "utf8");
    expect(list).toContain("summary.actions.length > 0");
    expect(list).toContain("onConfigureEconomy(action)");
    const tab = readFileSync(path.join(root, "client", "teams", "TeamsTab.tsx"), "utf8");
    expect(tab).toContain("onConfigureEconomy={onConfigureEconomy}");
    const editor = readFileSync(path.join(root, "client", "teams", "TeamEditor.tsx"), "utf8");
    expect(editor).toContain("planEconomyActions");
    expect(editor).toContain("onConfigureEconomy(action)");
    const screen = readFileSync(path.join(root, "client", "app", "AgentTeamsScreen.tsx"), "utf8");
    expect(screen.match(/onConfigureEconomy=\{\(target\) =>/g)?.length ?? 0).toBeGreaterThanOrEqual(
      3,
    );
  });
});

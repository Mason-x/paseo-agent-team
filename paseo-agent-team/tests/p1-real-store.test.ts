// P1 V01b real-store integration: a real temp directory, the repository's own settings schemas,
// and the real team.plan / launch.preview services. READ-ONLY proof only: every settings file's
// bytes and mtime are compared before and after both RPC paths. The host's PluginSettingsStore is
// not exported by @getpaseo/plugin, so this harness uses the same file-backed shape the host
// persists and the repository reader path (schema parse -> SettingsReader -> service). A settings
// write would show up as changed bytes/mtime; no writer exists in either service.
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { z } from "zod";
import { createLaunchService } from "../server/launch-service";
import type { SettingsReader } from "../server/planning-context";
import { createTeamPlanService } from "../server/team-plan-service";
import type { PaseoProfile } from "../shared/paseo/adapter";
import type { Preferences } from "../shared/schemas/preferences";
import { PreferencesSchema } from "../shared/schemas/preferences";
import type { Role } from "../shared/schemas/role";
import type { Team } from "../shared/schemas/team";
import {
  type RolesDocument,
  RolesDocumentSchema,
  type TeamsDocument,
  TeamsDocumentSchema,
} from "../shared/settings";
import { fakePort, preferences } from "./fakes";
import {
  architect,
  claudeOpus,
  codexXhigh,
  codingTeam,
  developer,
  role,
  techLead,
} from "./fixtures";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const sonnet: PaseoProfile = {
  id: "p-sonnet",
  name: "Sonnet",
  provider: "claude",
  model: "claude-sonnet-4-6",
};
const deepseek: PaseoProfile = {
  id: "p-deepseek",
  name: "DeepSeek",
  provider: "codex",
  model: "deepseek-coder",
};
const profiles: PaseoProfile[] = [claudeOpus, codexXhigh, sonnet, deepseek];

const allSeats = {
  version: 1,
  profiles: [
    {
      profileId: sonnet.id,
      enabled: true,
      costClass: "low",
      family: "sonnet",
      boundModel: { provider: sonnet.provider, model: sonnet.model },
    },
    {
      profileId: deepseek.id,
      enabled: true,
      costClass: "low",
      family: "deepseek",
      boundModel: { provider: deepseek.provider, model: deepseek.model },
    },
  ],
  routes: {
    coordinator: [sonnet.id],
    decision: [sonnet.id],
    execution: [deepseek.id],
    escalation: [sonnet.id],
    retain: [sonnet.id],
  },
};

const executionRole = role({
  id: "execution-role",
  name: "Execution",
  executionPolicy: { tier: "execution", taskKind: "coding" },
});
const allRoles: Role[] = [techLead, architect, developer, executionRole];
const economyTeam: Team = {
  ...codingTeam,
  id: "economy-all-team",
  mode: "economy-all",
  members: [{ roleId: executionRole.id, enabled: true }],
};
const standardTeam: Team = { ...codingTeam, id: "standard-team", mode: "economy" };

const preferencesDocument: Preferences = {
  ...preferences,
  economy: { allSeats },
};

function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function snapshot(files: readonly string[]) {
  const shots: Record<string, { sha256: string; mtimeMs: number }> = {};
  for (const file of files) {
    shots[file] = {
      sha256: sha(await readFile(file, "utf8")),
      mtimeMs: (await stat(file)).mtimeMs,
    };
  }
  return shots;
}

function fileReader<T>(file: string, schema: z.ZodType<T>): SettingsReader<T> {
  return {
    async read() {
      const raw = await readFile(file, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { status: "invalid" as const, error: "json" };
      }
      const result = schema.safeParse(parsed);
      if (!result.success) return { status: "invalid" as const, error: "schema" };
      return { status: "ready" as const, values: result.data, revision: `sha256:${sha(raw)}` };
    },
  };
}

async function writeDocuments() {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-v01b-store-"));
  homes.push(home);
  const rolesFile = path.join(home, "agent-team-roles.json");
  const teamsFile = path.join(home, "agent-team-teams.json");
  const preferencesFile = path.join(home, "agent-team-preferences.json");
  await writeFile(rolesFile, `${JSON.stringify({ roles: allRoles })}\n`, "utf8");
  await writeFile(teamsFile, `${JSON.stringify({ teams: [standardTeam, economyTeam] })}\n`, "utf8");
  await writeFile(preferencesFile, `${JSON.stringify(preferencesDocument)}\n`, "utf8");
  return { home, rolesFile, teamsFile, preferencesFile };
}

describe("P1 real settings store: zero writes on team.plan and launch.preview", () => {
  test("both read paths leave every settings file byte- and mtime-identical", async () => {
    const files = await writeDocuments();
    const before = await snapshot([files.rolesFile, files.teamsFile, files.preferencesFile]);
    const readers = {
      roles: fileReader<RolesDocument>(files.rolesFile, RolesDocumentSchema),
      teams: fileReader<TeamsDocument>(files.teamsFile, TeamsDocumentSchema),
      preferences: fileReader<Preferences>(files.preferencesFile, PreferencesSchema),
    };
    const fixture = fakePort({
      agentProfiles: profiles,
      mcp: { enabled: true, injectIntoAgents: true },
    });
    const planService = createTeamPlanService({ readers });
    const launchService = createLaunchService(readers);

    const output = await planService.plan(
      {
        items: [
          { key: "standard", kind: "saved", teamId: standardTeam.id },
          { key: "economy-all", kind: "saved", teamId: economyTeam.id },
        ],
      },
      fixture.port,
    );
    expect(output.results.map((result) => result.status)).toEqual(["ready", "ready"]);
    expect(output.results.map((result) => result.effectiveMode)).toEqual([
      "economy",
      "economy-all",
    ]);
    for (const teamId of [standardTeam.id, economyTeam.id]) {
      const preview = await launchService.preview(
        {
          teamId,
          task: "Add Stripe",
          target: { kind: "workspace", workspaceId: "ws-1" },
          contractVersion: 2,
        },
        fixture.port,
      );
      expect(preview.ok, teamId).toBe(true);
    }
    expect(fixture.create).not.toHaveBeenCalled();

    expect(await snapshot([files.rolesFile, files.teamsFile, files.preferencesFile])).toEqual(
      before,
    );
    expect((await readdir(files.home)).sort()).toEqual([
      "agent-team-preferences.json",
      "agent-team-roles.json",
      "agent-team-teams.json",
    ]);
  });
});

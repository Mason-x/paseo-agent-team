// B02 spec: one team.plan batch is a pure read, and the launch access gate refuses a stale caller
// before any write. The settings evidence is the in-memory CAS fake's serialized documents and
// revisions (the repo has no settings-file store); on-disk settings evidence belongs to V01b/DEV.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createLaunchService } from "../../server/launch-service";
import type { SettingsReader } from "../../server/planning-context";
import { createTeamPlanService } from "../../server/team-plan-service";
import type { Preferences } from "../../shared/schemas/preferences";
import type { Team } from "../../shared/schemas/team";
import type { RolesDocument, TeamsDocument } from "../../shared/settings";
import { fakePort, healthyConfig, preferences } from "../fakes";
import { architect, codingTeam, developer, techLead } from "../fixtures";
import { DesignSettingsStore } from "../helpers/design-settings-store";

const economyTeam: Team = { ...codingTeam, id: "economy-team", mode: "economy-all" };
const standardTeam: Team = { ...codingTeam, id: "standard-team", mode: "economy" };

const store = () =>
  new DesignSettingsStore({
    roles: { roles: [techLead, architect, developer] },
    teams: { teams: [codingTeam, economyTeam, standardTeam] },
    preferences: preferences as Preferences,
  });

type ReadCounts = { roles: number; teams: number; preferences: number };

function reader<T>(
  settings: DesignSettingsStore,
  key: "roles" | "teams" | "preferences",
  counts: ReadCounts,
): SettingsReader<T> {
  return {
    read: async () => {
      counts[key] += 1;
      const state = settings.read(key);
      return { status: "ready" as const, revision: state.revision, values: state.values as T };
    },
  };
}

function readers(settings: DesignSettingsStore, counts: ReadCounts) {
  return {
    roles: reader<RolesDocument>(settings, "roles", counts),
    teams: reader<TeamsDocument>(settings, "teams", counts),
    preferences: reader<Preferences>(settings, "preferences", counts),
  };
}

const zeroReads = (): ReadCounts => ({ roles: 0, teams: 0, preferences: 0 });

function bytes(settings: DesignSettingsStore) {
  return {
    roles: JSON.stringify(settings.values("roles")),
    teams: JSON.stringify(settings.values("teams")),
    preferences: JSON.stringify(settings.values("preferences")),
    revisions: settings.revisions(),
  };
}

type Counts = { workspace: number; agent: number; send: number; archive: number };

function recordingPort(counts: Counts) {
  const fake = fakePort(healthyConfig);
  fake.port.workspaces.create.mockImplementation(async () => {
    counts.workspace += 1;
    throw new Error("spec: workspace write attempted");
  });
  fake.create.mockImplementation(async () => {
    counts.agent += 1;
    throw new Error("spec: agent write attempted");
  });
  fake.port.agents.ref.mockImplementation(() => ({
    send: async () => {
      counts.send += 1;
      throw new Error("spec: send attempted");
    },
    archive: async () => {
      counts.archive += 1;
      throw new Error("spec: archive attempted");
    },
  }));
  return fake;
}

const zeroCounts = (): Counts => ({ workspace: 0, agent: 0, send: 0, archive: 0 });

const batchItems = [
  { key: "s1", kind: "saved" as const, teamId: codingTeam.id },
  { key: "s2", kind: "saved" as const, teamId: economyTeam.id },
  { key: "s3", kind: "saved" as const, teamId: standardTeam.id },
  { key: "s4", kind: "saved" as const, teamId: "missing" },
  { key: "s5", kind: "saved" as const, teamId: codingTeam.id },
  ...Array.from({ length: 5 }, (_, index) => ({
    key: `d${index}`,
    kind: "draft" as const,
    draft: {
      mode: "sota",
      coordinatorRoleId: techLead.id,
      members: [
        { rowKey: `r${index}-a`, roleId: architect.id, enabled: true },
        { rowKey: `r${index}-b`, roleId: developer.id, enabled: false },
      ],
    },
  })),
];

const temporaryHomes: string[] = [];

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "b02-spec-home-"));
  temporaryHomes.push(home);
  return home;
}

afterEach(async () => {
  for (const home of temporaryHomes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
});

describe("team.plan is read-only", () => {
  test("a ten item batch pays the snapshot once and changes no document", async () => {
    const settings = store();
    const counts = zeroCounts();
    const reads = zeroReads();
    const fake = recordingPort(counts);
    const before = bytes(settings);
    const service = createTeamPlanService({ readers: readers(settings, reads) });
    const output = await service.plan({ items: batchItems }, fake.port);

    expect(output.results).toHaveLength(10);
    expect(reads).toEqual({ roles: 1, teams: 1, preferences: 1 });
    expect(fake.port.config.get).toHaveBeenCalledTimes(1);
    expect(fake.port.providers.listAvailable).toHaveBeenCalledTimes(1);
    expect(fake.port.workspaces.ref).not.toHaveBeenCalled();
    expect(fake.refresh).not.toHaveBeenCalled();
    expect(fake.port.projects.list).not.toHaveBeenCalled();
    expect(fake.port.workspaces.list).not.toHaveBeenCalled();
    expect(counts).toEqual(zeroCounts());
    expect(bytes(settings)).toEqual(before);
  });

  test("the empty probe reads nothing at all", async () => {
    const settings = store();
    const counts = zeroCounts();
    const reads = zeroReads();
    const fake = recordingPort(counts);
    const before = bytes(settings);
    const service = createTeamPlanService({ readers: readers(settings, reads) });
    const output = await service.plan({ items: [] }, fake.port);

    expect(output.results).toEqual([]);
    expect(reads).toEqual(zeroReads());
    expect(output.context).toBeNull();
    expect(fake.port.config.get).not.toHaveBeenCalled();
    expect(fake.port.providers.listAvailable).not.toHaveBeenCalled();
    expect(fake.port.workspaces.ref).not.toHaveBeenCalled();
    expect(counts).toEqual(zeroCounts());
    expect(bytes(settings)).toEqual(before);
  });

  test("the batch never writes PASEO_HOME", async () => {
    const home = await temporaryHome();
    const previous = process.env.PASEO_HOME;
    process.env.PASEO_HOME = home;
    try {
      const settings = store();
      const fake = recordingPort(zeroCounts());
      const service = createTeamPlanService({ readers: readers(settings, zeroReads()) });
      await service.plan({ items: batchItems }, fake.port);
      expect(await readdir(home)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = previous;
    }
  });
});

describe("launch access gate is read-only", () => {
  test("a stale preview and start are refused before host/target reads and writes", async () => {
    const settings = store();
    const counts = zeroCounts();
    const reads = zeroReads();
    const fake = recordingPort(counts);
    const before = bytes(settings);
    const service = createLaunchService(readers(settings, reads));

    const preview = await service.preview(
      {
        teamId: economyTeam.id,
        task: "Add Stripe",
        mode: "sota",
        target: { kind: "workspace", workspaceId: "ws-1" },
      },
      fake.port,
    );
    expect(preview.ok).toBe(false);

    const started = await service.start(
      {
        teamId: economyTeam.id,
        task: "Add Stripe",
        mode: "sota",
        expectedPlanHash: "stale",
        target: { kind: "workspace", workspaceId: "ws-1" },
      },
      fake.port,
    );
    expect(started.ok).toBe(false);

    expect(fake.port.config.get).not.toHaveBeenCalled();
    expect(fake.port.providers.listAvailable).not.toHaveBeenCalled();
    expect(fake.port.workspaces.ref).not.toHaveBeenCalled();
    expect(fake.refresh).not.toHaveBeenCalled();
    expect(fake.port.projects.list).not.toHaveBeenCalled();
    expect(fake.port.workspaces.list).not.toHaveBeenCalled();
    expect(counts).toEqual(zeroCounts());
    // One settings read per request (preview + start); neither reads host or target facts.
    expect(reads).toEqual({ roles: 2, teams: 2, preferences: 2 });
    expect(bytes(settings)).toEqual(before);
  });

  test("a v2 request may preview a legacy Team without touching a write port", async () => {
    const settings = store();
    const counts = zeroCounts();
    const reads = zeroReads();
    const fake = recordingPort(counts);
    const service = createLaunchService(readers(settings, reads));
    const preview = await service.preview(
      {
        teamId: codingTeam.id,
        task: "Add Stripe",
        contractVersion: 2,
        target: { kind: "workspace", workspaceId: "ws-1" },
      },
      fake.port,
    );
    expect(preview.ok).toBe(true);
    expect(counts).toEqual(zeroCounts());
  });
});

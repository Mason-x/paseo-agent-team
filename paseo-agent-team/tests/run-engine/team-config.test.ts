import { describe, expect, test } from "vitest";
import { keepTeamMetadata } from "../../client/catalog/preset-metadata";
import { buildLaunchPlan } from "../../shared/domain/launch-plan";
import { engineLaunchGate, resolveTeamRunEngine } from "../../shared/domain/run-engine/team-config";
import { TeamSchema } from "../../shared/schemas/team";
import { runEngineZh } from "../../shared/zh/run-engine";
import {
  allAvailable,
  architect,
  claudeOpus,
  codexXhigh,
  codingTeam,
  developer,
  techLead,
} from "../fixtures";
import { policy } from "../fixtures/run-engine/base";

const zh = runEngineZh.launch;

const team = {
  ...codingTeam,
  members: [
    { roleId: "architect", seatId: "seat-a", enabled: true },
    { roleId: "developer", instanceLabel: "Backend", seatId: "seat-d", enabled: true },
  ],
};

function seat(seatId: string, enabled = true) {
  return { seatId, tier: "B", duties: ["implement"], channelId: "claude", enabled };
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    enabled: true,
    seats: [seat("seat-a"), seat("seat-d")],
    policy: policy(),
    ...overrides,
  };
}

function plan(runEngine: unknown, extra: { runEngineSupported?: boolean } = {}) {
  return buildLaunchPlan({
    team: { ...team, runEngine },
    roles: [techLead, architect, developer],
    profiles: [claudeOpus, codexXhigh],
    availability: allAvailable,
    workspaceId: "ws-1",
    task: "Add Stripe subscriptions to the billing page.",
    runId: "run-1",
    maxMembers: 8,
    ...extra,
  });
}

describe("resolveTeamRunEngine", () => {
  test("a missing block is absent, never an error", () => {
    expect(resolveTeamRunEngine({})).toEqual({ status: "absent" });
    expect(resolveTeamRunEngine({ runEngine: undefined })).toEqual({ status: "absent" });
    expect(resolveTeamRunEngine({ runEngine: null })).toEqual({ status: "absent" });
  });

  test("a valid block reads as enabled or disabled by its own flag", () => {
    expect(resolveTeamRunEngine({ runEngine: config() }).status).toBe("enabled");
    expect(resolveTeamRunEngine({ runEngine: config({ enabled: false }) }).status).toBe("disabled");
  });

  test("a malformed block is invalid with path-only issues that do not echo stored values", () => {
    const result = resolveTeamRunEngine({
      runEngine: config({ seats: [{ ...seat("seat-a"), tier: "SECRET-TIER" }] }),
    });
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.explicitlyDisabled).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]).toContain("seats.0.tier");
    expect(JSON.stringify(result.issues)).not.toContain("SECRET-TIER");
  });

  test("an unknown version or policyVersion is invalid, never read as defaults", () => {
    expect(resolveTeamRunEngine({ runEngine: config({ version: 2 }) }).status).toBe("invalid");
    expect(
      resolveTeamRunEngine({ runEngine: config({ policy: { ...policy(), policyVersion: 9 } }) })
        .status,
    ).toBe("invalid");
  });

  test.each([[true], ["on"], [42], [[]], [{}]])("non-block value %j is invalid", (value) => {
    const result = resolveTeamRunEngine({ runEngine: value });
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") expect(result.explicitlyDisabled).toBe(false);
  });

  test("only a stored `enabled: false` marks a damaged block as explicitly disabled", () => {
    const off = resolveTeamRunEngine({ runEngine: { enabled: false, seats: "broken" } });
    expect(off.status === "invalid" && off.explicitlyDisabled).toBe(true);
    const unknown = resolveTeamRunEngine({ runEngine: { seats: "broken" } });
    expect(unknown.status === "invalid" && unknown.explicitlyDisabled).toBe(false);
    const truthy = resolveTeamRunEngine({ runEngine: { enabled: "false", seats: "broken" } });
    expect(truthy.status === "invalid" && truthy.explicitlyDisabled).toBe(false);
  });
});

describe("launch gate for Team.runEngine", () => {
  test("no block or a disabled block leaves the original chain untouched", () => {
    const original = plan(undefined);
    expect(original.blockers).toEqual([]);
    expect(plan(config({ enabled: false })).blockers).toEqual([]);
    expect(plan(config({ enabled: false })).warnings).toEqual(original.warnings);
  });

  test("an enabled valid block is refused while the build cannot run the Engine", () => {
    const blocked = plan(config());
    expect(blocked.blockers).toEqual([zh.unsupported]);
    // The flag is the only thing that lets it through; the config itself is fine.
    expect(plan(config(), { runEngineSupported: true }).blockers).toEqual([]);
  });

  test("an enabled invalid block blocks and never falls back to the coordinator chain", () => {
    const result = plan(config({ seats: [] }));
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]).toContain("无效");
    expect(result.blockers[0]).toContain("seats");
    // Same with the support flag on: invalid is not rescued by capability.
    expect(plan(config({ seats: [] }), { runEngineSupported: true }).blockers).toHaveLength(1);
  });

  test("a damaged block that says it is off launches the old chain with a warning", () => {
    const result = plan({ enabled: false, seats: "broken" });
    expect(result.blockers).toEqual([]);
    expect(result.warnings.some((line) => line.includes("按旧流程启动"))).toBe(true);
  });

  test("seat ids must match the seats planning resolved for the enabled members", () => {
    const supported = { runEngineSupported: true };
    expect(
      plan(config({ seats: [seat("seat-a"), seat("seat-d"), seat("ghost")] }), supported).blockers,
    ).toEqual([zh.seatUnknown("ghost")]);
    expect(plan(config({ seats: [seat("seat-a")] }), supported).blockers).toEqual([
      zh.seatMissing("seat-d"),
    ]);
    expect(
      plan(config({ seats: [seat("seat-a"), seat("seat-a"), seat("seat-d")] }), supported).blockers,
    ).toEqual([zh.seatDuplicate("seat-a")]);
  });

  test("a configured-but-disabled seat is still a roster entry; all-disabled is refused", () => {
    const supported = { runEngineSupported: true };
    expect(
      plan(config({ seats: [seat("seat-a"), seat("seat-d", false)] }), supported).blockers,
    ).toEqual([]);
    expect(
      plan(config({ seats: [seat("seat-a", false), seat("seat-d", false)] }), supported).blockers,
    ).toEqual([zh.noEnabledSeat]);
  });

  test("a coordinator turn budget under 1 blocks the launch: the plan request would have no turn to be sent in", () => {
    const supported = { runEngineSupported: true };
    const withTurns = (strategicTurns: number) =>
      config({ policy: policy({ run: { failedTasks: 3, strategicTurns } }) });
    expect(plan(withTurns(0), supported).blockers).toEqual([zh.coordinatorBudgetEmpty]);
    expect(plan(withTurns(1), supported).blockers).toEqual([]);
    // A block that is off is not judged: it never takes the Engine path.
    expect(plan({ ...withTurns(0), enabled: false }, supported).blockers).toEqual([]);
  });

  test("derived positional seat ids (legacy members without seatId) are matched too", () => {
    const legacy = buildLaunchPlan({
      team: {
        ...codingTeam,
        members: [
          { roleId: "architect", enabled: true },
          { roleId: "developer", instanceLabel: "Backend", enabled: true },
        ],
        runEngine: config({ seats: [seat("seat-1"), seat("seat-2")] }),
      },
      roles: [techLead, architect, developer],
      profiles: [claudeOpus, codexXhigh],
      availability: allAvailable,
      workspaceId: "ws-1",
      task: "task",
      runId: "run-1",
      maxMembers: 8,
      runEngineSupported: true,
    });
    expect(legacy.blockers).toEqual([]);
  });
});

describe("Team.runEngine round trip", () => {
  const stored = {
    ...team,
    enabled: true,
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
  };

  test("a malformed block survives the schema untouched and does not invalidate the Team", () => {
    const damaged = { version: 99, nested: { keep: ["me"] } };
    const parsed = TeamSchema.parse({ ...stored, runEngine: damaged });
    expect(parsed.runEngine).toEqual(damaged);
  });

  test("a valid block is preserved byte-for-byte, including unknown fields", () => {
    const withExtra = { ...config(), futureField: { a: 1 } };
    const parsed = TeamSchema.parse({ ...stored, runEngine: withExtra });
    expect(parsed.runEngine).toEqual(withExtra);
  });

  test("editing a Team through the form path keeps the stored block", () => {
    const original = TeamSchema.parse({ ...stored, runEngine: config() });
    const edited = TeamSchema.parse({
      id: original.id,
      name: "Renamed",
      coordinatorRoleId: original.coordinatorRoleId,
      members: original.members,
      enabled: true,
      createdAt: original.createdAt,
      updatedAt: "2026-11-06T00:00:00.000Z",
    });
    expect(edited.runEngine).toBeUndefined();
    const merged = keepTeamMetadata(original, edited);
    expect(merged.name).toBe("Renamed");
    expect(merged.runEngine).toEqual(config());
  });

  test("a Team without the block stays without it", () => {
    expect("runEngine" in TeamSchema.parse(stored)).toBe(false);
  });
});

describe("the launch plan feeds the gate the Profiles its seats resolved to", () => {
  test("a Codex seat that implements, without full access, is warned about in the plan", () => {
    const result = plan(config(), { runEngineSupported: true });
    const codexSeats = result.seats.filter((entry) => entry.selected.profile.provider === "codex");
    // The fixture must really have a Codex seat, or this test would prove nothing.
    expect(codexSeats.length).toBeGreaterThan(0);
    for (const entry of codexSeats) {
      expect(result.warnings).toContain(zh.codexNeedsFullAccess(entry.logicalSeatId, "implement"));
    }
    // One warning per Codex seat and none for the others.
    expect(result.warnings.filter((text) => text.includes("Codex"))).toHaveLength(
      codexSeats.length,
    );
  });
});

describe("engineLaunchGate warnings", () => {
  const seatOf = (seatId: string, tier: string, duties: string[], enabled = true) => ({
    seatId,
    tier,
    duties,
    channelId: "claude",
    enabled,
  });
  const gate = (
    seats: ReturnType<typeof seatOf>[],
    profiles: { seatId: string; provider: string; modeId?: string }[] = [],
  ) =>
    engineLaunchGate({
      resolution: resolveTeamRunEngine({ runEngine: config({ seats }) }),
      logicalSeatIds: seats.map((entry) => entry.seatId),
      engineSupported: true,
      seatProfiles: profiles,
    });

  test("a tier B producer with one tier A reviewer has no reviewer for level 1 work", () => {
    const result = gate([seatOf("p", "B", ["implement"]), seatOf("r", "A", ["review"])]);
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([zh.reviewerTierMissing("p", "L1", "B")]);
  });

  test("a tier B producer needs a tier B and a tier A reviewer, neither of them itself", () => {
    const only = gate([seatOf("p", "B", ["implement", "review"]), seatOf("r", "A", ["review"])]);
    expect(only.warnings).toEqual([zh.reviewerTierMissing("p", "L1", "B")]);
    const both = gate([
      seatOf("p", "B", ["implement"]),
      seatOf("rb", "B", ["review"]),
      seatOf("ra", "A", ["review"]),
    ]);
    expect(both.warnings).toEqual([]);
  });

  test("each producer tier names the reviewer tiers its levels need", () => {
    const warnings = gate([
      seatOf("pa", "A", ["implement"]),
      seatOf("ps", "S", ["implement"]),
      seatOf("rb", "B", ["review"]),
    ]).warnings;
    expect(warnings).toEqual([
      zh.reviewerTierMissing("pa", "L3", "A"),
      zh.reviewerTierMissing("ps", "L4", "S"),
    ]);
  });

  test("a disabled reviewer does not count, and a roster without the duty names is not judged", () => {
    const disabled = gate([
      seatOf("p", "B", ["implement"]),
      seatOf("rb", "B", ["review"], false),
      seatOf("ra", "A", ["review"]),
    ]);
    expect(disabled.warnings).toEqual([zh.reviewerTierMissing("p", "L1", "B")]);
    expect(gate([seatOf("p", "B", ["build"]), seatOf("r", "A", ["audit"])]).warnings).toEqual([]);
  });

  test("a Codex seat that produces or smokes without full access is warned about, reviewers are not", () => {
    const seats = [
      seatOf("p", "B", ["implement"]),
      seatOf("s", "A", ["review", "smoke"]),
      seatOf("r", "B", ["review"]),
    ];
    const codex = (modeId?: string) =>
      ["p", "s", "r"].map((seatId) => ({ seatId, provider: "codex", modeId }));
    const mentionsCodex = (warnings: string[]) => warnings.filter((text) => text.includes("Codex"));
    expect(mentionsCodex(gate(seats, codex("auto")).warnings)).toEqual([
      zh.codexNeedsFullAccess("p", "implement"),
      zh.codexNeedsFullAccess("s", "smoke"),
    ]);
    expect(mentionsCodex(gate(seats, codex("full-access")).warnings)).toEqual([]);
    const claude = ["p", "s", "r"].map((seatId) => ({ seatId, provider: "claude" }));
    expect(mentionsCodex(gate(seats, claude).warnings)).toEqual([]);
  });

  test("a Team without the block gets none of them", () => {
    expect(
      engineLaunchGate({
        resolution: resolveTeamRunEngine({}),
        logicalSeatIds: [],
        engineSupported: true,
        seatProfiles: [{ seatId: "p", provider: "codex" }],
      }),
    ).toEqual({ blockers: [], warnings: [], engine: false });
  });
});

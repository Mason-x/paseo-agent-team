import { describe, expect, test } from "vitest";
import { keepTeamMetadata } from "../../client/catalog/preset-metadata";
import type { HostSnapshot } from "../../shared/domain/mode-resolver";
import {
  addMissingSeats,
  DEFAULT_ENGINE_LIMITS,
  defaultEngineBlock,
  ENGINE_NUMBER_FIELDS,
  evaluateEngineBlock,
  logicalSeatIdsOf,
  readEngineEdit,
  removeOrphanSeats,
  setEngineEnabled,
  setEngineNumber,
  setEngineSeat,
  startFreshEngineBlock,
} from "../../shared/domain/run-engine/team-config-edit";
import { buildSeatPlan } from "../../shared/domain/seat-plan";
import { RunTeamEngineConfigSchema } from "../../shared/schemas/run-engine/config";
import { TeamSchema } from "../../shared/schemas/team";
import { TeamsDocumentSchema } from "../../shared/settings";
import { runEngineZh } from "../../shared/zh/run-engine";
import {
  allAvailable,
  architect,
  claudeOpus,
  codexXhigh,
  codingTeam,
  developer,
} from "../fixtures";

// biome-ignore lint/suspicious/noExplicitAny: a test reads fields the block type does not know
type Loose = Record<string, any>;

const SEATS = ["seat-a", "seat-d"];

/** A block that parses: every seat has a channel. */
function filled(seatIds: readonly string[] = SEATS) {
  let block: unknown = setEngineEnabled(undefined, true, seatIds);
  for (const seatId of seatIds) block = setEngineSeat(block, seatId, { channelId: "claude" });
  return block as Record<string, unknown>;
}

describe("logicalSeatIdsOf agrees with seat planning", () => {
  const host: HostSnapshot = {
    status: "ready",
    profiles: [claudeOpus, codexXhigh],
    availability: allAvailable,
  };
  const plan = (
    members: { roleId: string; enabled: boolean; seatId?: string; instanceLabel?: string }[],
  ) =>
    buildSeatPlan({
      team: { ...codingTeam, members },
      roles: [architect, developer],
      host,
      maxMembers: 24,
      runtimeCapabilities: { onDemand: false, expansion: false, collaboration: false },
    }).seats.map((seat) => seat.logicalSeatId);

  test.each([
    [
      "explicit ids",
      [
        { roleId: "developer", enabled: true, seatId: "seat-x" },
        { roleId: "architect", enabled: true, seatId: "seat-y" },
      ],
    ],
    [
      "positional ids",
      [
        { roleId: "architect", enabled: true },
        { roleId: "developer", enabled: true },
      ],
    ],
    [
      "a disabled member is skipped and still takes its position",
      [
        { roleId: "architect", enabled: false },
        { roleId: "developer", enabled: true, instanceLabel: "A" },
        { roleId: "developer", enabled: true, instanceLabel: "B" },
      ],
    ],
    [
      "a disabled member's explicit id reserves nothing",
      [
        { roleId: "architect", enabled: false, seatId: "seat-2" },
        { roleId: "developer", enabled: true },
      ],
    ],
    [
      "a positional id that an explicit id already holds takes the next free suffix",
      [
        { roleId: "developer", enabled: true, instanceLabel: "A", seatId: "seat-2" },
        { roleId: "developer", enabled: true, instanceLabel: "B" },
      ],
    ],
  ])("%s", (_name, members) => {
    expect(logicalSeatIdsOf(members)).toEqual(plan(members));
  });
});

describe("a block for a Team that has none", () => {
  test("starts disabled, with one seat and one budget per Team seat, and no channel guessed", () => {
    const block = defaultEngineBlock(SEATS) as {
      enabled: boolean;
      seats: { seatId: string; channelId: string }[];
      policy: { seatBudgets: { subjectId: string; limit: number }[]; evidenceRoot: string };
    };
    expect(block.enabled).toBe(false);
    expect(block.seats.map((seat) => seat.seatId)).toEqual(SEATS);
    expect(block.seats.every((seat) => seat.channelId === "")).toBe(true);
    expect(block.policy.seatBudgets.map((entry) => entry.subjectId)).toEqual(SEATS);
    expect(
      block.policy.seatBudgets.every(
        (entry) => entry.limit === DEFAULT_ENGINE_LIMITS.seatTurnBudget,
      ),
    ).toBe(true);
    expect(block.policy.evidenceRoot).toBe("auto");
  });

  test("it does not read as valid until every channel is written, and then it does", () => {
    const bare = defaultEngineBlock(SEATS);
    expect(RunTeamEngineConfigSchema.safeParse(bare).success).toBe(false);
    expect(RunTeamEngineConfigSchema.safeParse(filled()).success).toBe(true);
  });
});

describe("turning it on and off", () => {
  test("on with no block starts from the defaults and is on", () => {
    const next = setEngineEnabled(undefined, true, SEATS) as { enabled: boolean; seats: unknown[] };
    expect(next.enabled).toBe(true);
    expect(next.seats).toHaveLength(2);
  });

  test("off keeps everything else, on again is the same block", () => {
    const on = filled();
    const off = setEngineEnabled(on, false, SEATS);
    expect(off).toEqual({ ...on, enabled: false });
    expect(setEngineEnabled(off, true, SEATS)).toEqual(on);
  });

  test("a block that does not read is never touched by the switch", () => {
    const damaged = { version: 1, enabled: true, seats: "no", extra: { keep: true } };
    expect(setEngineEnabled(damaged, false, SEATS)).toEqual(damaged);
    expect(setEngineEnabled(damaged, true, SEATS)).toEqual(damaged);
    // …and it is not the same object: the caller's value is never mutated.
    expect(setEngineEnabled(damaged, true, SEATS)).not.toBe(damaged);
  });

  test("only starting fresh replaces a damaged block", () => {
    expect(startFreshEngineBlock(SEATS)).toEqual(defaultEngineBlock(SEATS));
  });
});

describe("seats", () => {
  test("tier, channel and enabled are changed on the named seat only", () => {
    const block = filled();
    const next = setEngineSeat(block, "seat-d", { tier: "A", channelId: "codex", enabled: false });
    const seats = (
      next as { seats: { seatId: string; tier: string; channelId: string; enabled: boolean }[] }
    ).seats;
    expect(seats[0]).toMatchObject({
      seatId: "seat-a",
      tier: "B",
      channelId: "claude",
      enabled: true,
    });
    expect(seats[1]).toMatchObject({
      seatId: "seat-d",
      tier: "A",
      channelId: "codex",
      enabled: false,
    });
  });

  test("a duty is switched on and off without duplicates and without touching the others", () => {
    let block: unknown = filled();
    block = setEngineSeat(block, "seat-a", { duty: { name: "review", on: true } });
    block = setEngineSeat(block, "seat-a", { duty: { name: "review", on: true } });
    expect(readEngineEdit(block, SEATS).seats[0]?.duties).toEqual(["implement", "review"]);
    block = setEngineSeat(block, "seat-a", { duty: { name: "implement", on: false } });
    expect(readEngineEdit(block, SEATS).seats[0]?.duties).toEqual(["review"]);
    expect(readEngineEdit(block, SEATS).seats[1]?.duties).toEqual(["implement"]);
  });

  test("a seat the Team has no member for, and a member with no seat, are told apart and fixed one way each", () => {
    const block = filled(["seat-a", "seat-old"]);
    const state = readEngineEdit(block, ["seat-a", "seat-new"]);
    expect(state.orphanSeats).toEqual(["seat-old"]);
    expect(state.missingSeats).toEqual(["seat-new"]);

    const added = addMissingSeats(block, ["seat-a", "seat-new"]);
    const after = readEngineEdit(added, ["seat-a", "seat-new"]);
    expect(after.missingSeats).toEqual([]);
    // The new seat has a budget, or it could never be dispatched to.
    expect(
      (added as { policy: { seatBudgets: { subjectId: string }[] } }).policy.seatBudgets.map(
        (entry) => entry.subjectId,
      ),
    ).toContain("seat-new");
    // Nothing was removed by adding.
    expect(after.orphanSeats).toEqual(["seat-old"]);

    const trimmed = removeOrphanSeats(added, ["seat-a", "seat-new"]);
    expect(readEngineEdit(trimmed, ["seat-a", "seat-new"]).orphanSeats).toEqual([]);
    expect(
      readEngineEdit(trimmed, ["seat-a", "seat-new"]).seats.map((seat) => seat.seatId),
    ).toEqual(["seat-a", "seat-new"]);
  });

  test("adding a missing seat twice adds it once", () => {
    const once = addMissingSeats(filled(), ["seat-a", "seat-d", "seat-n"]);
    const twice = addMissingSeats(once, ["seat-a", "seat-d", "seat-n"]);
    expect(twice).toEqual(once);
  });
});

describe("policy numbers", () => {
  test("each field lands on its own path", () => {
    let block: unknown = filled();
    const values: Record<string, number> = {
      configuredConcurrency: 3,
      protocolResends: 1,
      evidenceReturns: 4,
      reworkPerLayer: 1,
      implementationAttempts: 8,
      failedTasks: 5,
      strategicTurns: 20,
    };
    for (const field of ENGINE_NUMBER_FIELDS)
      block = setEngineNumber(block, field, String(values[field]));
    expect(readEngineEdit(block, SEATS).numbers).toEqual(values);
  });

  test("text that is not a whole number changes nothing", () => {
    const block = filled();
    for (const text of ["", "x", "1.5", "1e3", "--1", " "]) {
      expect(setEngineNumber(block, "configuredConcurrency", text), text).toEqual(block);
    }
    expect(
      readEngineEdit(setEngineNumber(block, "configuredConcurrency", " 7 "), SEATS).numbers
        .configuredConcurrency,
    ).toBe(7);
  });

  test("a value outside the schema's range is stored as typed and judged as an issue", () => {
    const block = setEngineNumber(filled(), "configuredConcurrency", "0");
    const evaluation = evaluateEngineBlock(block, { seatIds: SEATS });
    expect(evaluation.ready).toBe(false);
    expect(evaluation.issues.join("\n")).toContain("policy.configuredConcurrency");
  });
});

describe("what launch would say, shown while editing", () => {
  test("a good block with a reviewer for each producer is ready", () => {
    let block: unknown = filled();
    block = setEngineSeat(block, "seat-d", { duty: { name: "review", on: true } });
    block = setEngineSeat(block, "seat-d", { duty: { name: "implement", on: false } });
    const evaluation = evaluateEngineBlock(block, { seatIds: SEATS });
    expect(evaluation).toMatchObject({ issues: [], blockers: [], ready: true });
  });

  test("seats that do not match the Team are blockers, exactly as launch refuses them", () => {
    const evaluation = evaluateEngineBlock(filled(["seat-a", "seat-old"]), {
      seatIds: ["seat-a", "seat-new"],
    });
    expect(evaluation.ready).toBe(false);
    expect(evaluation.blockers.join("\n")).toContain("seat-old");
    expect(evaluation.blockers.join("\n")).toContain("seat-new");
  });

  test("no enabled seat is a blocker", () => {
    let block: unknown = filled();
    for (const seatId of SEATS) block = setEngineSeat(block, seatId, { enabled: false });
    expect(evaluateEngineBlock(block, { seatIds: SEATS }).blockers.length).toBeGreaterThan(0);
  });

  test("a coordinator turn budget of 0 is a blocker the moment it is typed, and 1 clears it", () => {
    const zero = setEngineNumber(filled(), "strategicTurns", "0");
    const blocked = evaluateEngineBlock(zero, { seatIds: SEATS });
    expect(blocked.issues).toEqual([]);
    expect(blocked.blockers).toEqual([runEngineZh.launch.coordinatorBudgetEmpty]);
    expect(blocked.ready).toBe(false);
    const one = evaluateEngineBlock(setEngineNumber(zero, "strategicTurns", "1"), {
      seatIds: SEATS,
    });
    expect(one.blockers).toEqual([]);
    expect(one.ready).toBe(true);
  });

  test("a producer with no independent reviewer gets the reviewer warning", () => {
    let block: unknown = filled();
    block = setEngineSeat(block, "seat-d", { duty: { name: "review", on: true } });
    block = setEngineSeat(block, "seat-d", { tier: "S" });
    const evaluation = evaluateEngineBlock(block, { seatIds: SEATS });
    expect(evaluation.warnings.length).toBeGreaterThan(0);
  });

  test("Codex without full access gets its warning when the Profile facts are given", () => {
    const evaluation = evaluateEngineBlock(filled(), {
      seatIds: SEATS,
      seatProfiles: [{ seatId: "seat-a", provider: "codex", modeId: "read-only" }],
    });
    expect(evaluation.warnings.join("\n")).toContain("full-access");
  });

  test("a disabled block is still checked for shape, but blocks nothing", () => {
    const evaluation = evaluateEngineBlock(defaultEngineBlock(SEATS), { seatIds: SEATS });
    expect(evaluation.blockers).toEqual([]);
    expect(evaluation.ready).toBe(false);
    expect(evaluation.issues.join("\n")).toContain("channelId");
  });

  test("no block is quiet", () => {
    expect(evaluateEngineBlock(undefined, { seatIds: SEATS })).toEqual({
      issues: [],
      blockers: [],
      warnings: [],
      ready: false,
    });
  });

  test("a damaged block is reported by path and never echoes what is stored", () => {
    const evaluation = evaluateEngineBlock(
      { version: 1, enabled: true, seats: [], policy: {}, secret: "tok-123" },
      { seatIds: SEATS },
    );
    expect(evaluation.ready).toBe(false);
    expect(evaluation.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(evaluation)).not.toContain("tok-123");
  });

  test("the edit state of a damaged block says so and keeps the lines short", () => {
    const state = readEngineEdit({ version: 2 }, SEATS);
    expect(state.status).toBe("invalid");
    expect(state.issues.length).toBeGreaterThan(0);
    expect(state.issues.length).toBeLessThanOrEqual(5);
    expect(state.enabled).toBe(false);
  });
});

describe("saving never loses what this editor does not know", () => {
  const extras = () => {
    const block = filled() as Loose;
    block.futureBlockField = { nested: [1, 2, { deep: true }] };
    block.seats[0].futureSeatField = "keep-me";
    block.seats[1].futureSeatField = 7;
    block.policy.futurePolicyField = ["a"];
    block.policy.perTask.futurePerTaskField = 1;
    block.policy.run.futureRunField = 2;
    block.policy.devTargets = [{ serverId: "dev-1", host: "127.0.0.1:6799", home: "/tmp/dev" }];
    block.policy.disabledChannels = ["old-channel"];
    return block;
  };

  const everyEdit = (block: unknown) => {
    let next = block;
    next = setEngineSeat(next, "seat-a", {
      tier: "A",
      channelId: "codex",
      enabled: true,
      duty: { name: "review", on: true },
    });
    next = setEngineSeat(next, "seat-d", { enabled: false });
    for (const field of ENGINE_NUMBER_FIELDS) next = setEngineNumber(next, field, "3");
    next = setEngineEnabled(next, false, SEATS);
    next = setEngineEnabled(next, true, SEATS);
    next = addMissingSeats(next, [...SEATS, "seat-extra"]);
    next = removeOrphanSeats(next, SEATS);
    return next as Loose;
  };

  test("every unknown field survives every edit, at every level", () => {
    const after = everyEdit(extras());
    expect(after.futureBlockField).toEqual({ nested: [1, 2, { deep: true }] });
    expect(after.seats[0].futureSeatField).toBe("keep-me");
    expect(after.seats[1].futureSeatField).toBe(7);
    expect(after.policy.futurePolicyField).toEqual(["a"]);
    expect(after.policy.perTask.futurePerTaskField).toBe(1);
    expect(after.policy.run.futureRunField).toBe(2);
    expect(after.policy.devTargets).toEqual([
      { serverId: "dev-1", host: "127.0.0.1:6799", home: "/tmp/dev" },
    ]);
    expect(after.policy.disabledChannels).toEqual(["old-channel"]);
    // and the fields that were edited did change
    expect(after.seats[0]).toMatchObject({ tier: "A", channelId: "codex" });
    expect(after.policy.configuredConcurrency).toBe(3);
  });

  test("an edit never mutates the value it was given", () => {
    const original = extras();
    const snapshot = structuredClone(original);
    everyEdit(original);
    expect(original).toEqual(snapshot);
  });

  test("through the Team schema, the settings document and a save, the unknown fields are still there", () => {
    const stored = TeamSchema.parse({
      ...codingTeam,
      runEngine: extras(),
    });
    const edited = everyEdit(stored.runEngine);
    const row = TeamSchema.parse({
      ...stored,
      runEngine: edited,
      updatedAt: "2026-11-08T00:00:00.000Z",
    });
    const saved = keepTeamMetadata(stored, row);
    const document = TeamsDocumentSchema.parse(JSON.parse(JSON.stringify({ teams: [saved] })));
    const back = document.teams[0]?.runEngine as Loose;
    expect(back.futureBlockField).toEqual({ nested: [1, 2, { deep: true }] });
    expect(back.seats[0].futureSeatField).toBe("keep-me");
    expect(back.policy.futurePolicyField).toEqual(["a"]);
    expect(back.policy.perTask.futurePerTaskField).toBe(1);
    expect(RunTeamEngineConfigSchema.safeParse(back).success).toBe(true);
  });

  test("a block nobody touched is carried through a save as it is, even when it does not read", () => {
    for (const block of [extras(), { version: 99, nonsense: true }, "text", 7]) {
      const stored = TeamSchema.parse({ ...codingTeam, runEngine: block });
      // The editor leaves `runEngine` out of the form until it is changed.
      const row = TeamSchema.parse({
        ...codingTeam,
        name: "renamed",
        updatedAt: "2026-11-08T00:00:00.000Z",
      });
      expect(keepTeamMetadata(stored, row).runEngine).toEqual(block);
    }
  });
});

describe("a block that is not finished is not a block that is broken", () => {
  test("a fresh default is incomplete (no channel yet), and the switch still works on it", () => {
    const fresh = defaultEngineBlock(SEATS);
    const state = readEngineEdit(fresh, SEATS);
    expect(state.status).toBe("incomplete");
    expect(state.seats).toHaveLength(2);
    expect(setEngineEnabled(fresh, true, SEATS)).toEqual({ ...fresh, enabled: true });
  });

  test("only a value that is not the shape of a block is invalid", () => {
    for (const value of [
      { version: 7 },
      { version: 1, seats: "no", policy: {} },
      { version: 1, seats: [], policy: "no" },
      "text",
      7,
      [],
    ]) {
      expect(readEngineEdit(value, SEATS).status, JSON.stringify(value)).toBe("invalid");
    }
  });

  test("a complete block is enabled or disabled as stored", () => {
    expect(readEngineEdit(filled(), SEATS).status).toBe("enabled");
    expect(readEngineEdit(setEngineEnabled(filled(), false, SEATS), SEATS).status).toBe("disabled");
    expect(readEngineEdit(undefined, SEATS).status).toBe("absent");
  });
});

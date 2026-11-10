import { describe, expect, test } from "vitest";
import { mcpServersSha256, sha256Hex, stableStringify } from "../../server/run-engine/digest";
import {
  COORDINATOR_DUTY,
  COORDINATOR_SEAT_ID,
} from "../../shared/domain/run-engine/dag-admission";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import {
  bindSeatAgent,
  completeSeatRebuild,
  rebindBlocker,
  rebindSeatAgent,
} from "../../shared/domain/run-engine/run-record";
import {
  AGENT_SPEC_PROMPT_MAX_BYTES,
  AGENT_SPECS_MAX_BYTES,
  type AgentSpec,
  canStartRebuild,
  failRebuildRecord,
  freezeAgentSpecs,
  readAgentSpecs,
  readSeatRebuilds,
  reboundFromAgents,
  rebuildKeyFor,
  rebuildTitle,
  settleRebuildAlerts,
  startRebuildRecord,
  utf8Bytes,
} from "../../shared/domain/run-engine/seat-rebuild";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { readyRun } from "./support/ready-run";

/**
 * T11b, the pure part. Failure modes this file guards:
 *  - a frozen spec that is cut, that is too big for the ledger, or that is believed although it does not
 *    match what the Run pinned at launch;
 *  - a block that cannot be read being taken for an empty one, so that an attempt in progress is forgotten
 *    or a seat is given a third try;
 *  - a seat that changes Agent while work for the old one is unsettled, or to an Agent another seat has,
 *    or twice;
 *  - an attempt whose records and alerts do not move together.
 */

const NOW = "2026-11-10T08:00:00.000Z";
const LATER = "2026-11-10T08:05:00.000Z";
// A seat of its own, with no assignment and so no proof: the kind of seat that is rebuilt.
const SEAT = "seat-b9";
const OLD = "agent-b9";
const NEW = "agent-new-1";

function spec(prompt: string, over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    parentSeatId: COORDINATOR_SEAT_ID,
    title: "Builder",
    labels: { "agent-team.kind": "member" },
    systemPrompt: prompt,
    systemPromptSha256: sha256Hex(prompt),
    profile: { id: "p1", name: "P", provider: "claude", model: "m" },
    roleId: "role-builder",
    mcpServersSha256: mcpServersSha256(undefined),
    ...over,
  };
}

/** A v2 Run whose launch froze these seats (the pinned prompt hash is what the reader holds the spec to). */
function frozen(seats: Record<string, AgentSpec>, schemaVersion: 1 | 2 = 2): RunRecord {
  const record = readyRun();
  record.schemaVersion = schemaVersion;
  const launch = record.launch as Record<string, unknown>;
  launch.agentSpecs = { version: 1, seats };
  launch.systemPrompts = Object.fromEntries(
    Object.entries(seats).map(([seatId, one]) => [
      seatId,
      { template: "member-system", version: 1, hash: one.systemPromptSha256 },
    ]),
  );
  record.roster.push({
    seatId: SEAT,
    tier: "B",
    agentId: OLD,
    channelId: "claude",
    duties: ["implement"],
    enabled: true,
  });
  record.roster.push({
    seatId: COORDINATOR_SEAT_ID,
    tier: "S",
    agentId: "agent-coord",
    channelId: "claude",
    duties: [COORDINATOR_DUTY],
    enabled: true,
  });
  return record;
}

/** The shared fixture is a v1 ledger; `frozen(…, 2)` makes it a v2 one, which the invariants of a v1 fixture reject. */
const started = (record: RunRecord, generation: 1 | 2 = 1) => {
  const result = startRebuildRecord(
    record,
    {
      seatId: SEAT,
      generation,
      fromAgentId: record.roster.find((s) => s.seatId === SEAT)?.agentId ?? OLD,
      title: rebuildTitle("Builder", generation),
      reason: "turn-cut-off",
    },
    NOW,
  );
  return result.next;
};

describe("the frozen spec (readAgentSpecs, freezeAgentSpecs)", () => {
  test("a v1 Run, or a Run without the block, has no spec; a block that is not an object is damaged", () => {
    const withSpec = frozen({ [SEAT]: spec("hello") });
    expect(readAgentSpecs(withSpec).kind).toBe("valid");
    expect(readAgentSpecs({ ...withSpec, schemaVersion: 1 }).kind).toBe("absent");
    expect(readAgentSpecs(readyRun()).kind).toBe("absent");
    for (const bad of ["x", null, [], { version: 2, seats: {} }, { version: 1, seats: "x" }]) {
      const record = frozen({});
      (record.launch as Record<string, unknown>).agentSpecs = bad;
      expect(readAgentSpecs(record).kind, JSON.stringify(bad)).toBe("invalid");
    }
  });

  test("a seat whose spec does not read back, or does not match the prompt the Run pinned, is left out alone", () => {
    const record = frozen({
      [SEAT]: spec("hello"),
      "seat-b2": spec("other"),
      "seat-b3": spec("third"),
    });
    const launch = record.launch as Record<string, Record<string, unknown>>;
    // b2's spec is not the pinned prompt; b3's profile is not an object.
    launch.systemPrompts.seat_b2 = undefined as never;
    (launch.systemPrompts["seat-b2"] as Record<string, unknown>).hash = "f".repeat(64);
    ((launch.agentSpecs as Record<string, unknown>).seats as Record<string, unknown>)["seat-b3"] = {
      ...spec("third"),
      profile: "nope",
    };
    const read = readAgentSpecs(record);
    expect(read.kind === "valid" && [...read.seats.keys()]).toEqual([SEAT]);
  });

  test("a spec with no pinned prompt behind it is not believed", () => {
    const record = frozen({ [SEAT]: spec("hello") });
    (record.launch as Record<string, unknown>).systemPrompts = {};
    const read = readAgentSpecs(record);
    expect(read.kind === "valid" && read.seats.size).toBe(0);
  });

  test("the limit of one prompt is in UTF-8 bytes, not characters, and nothing is cut", () => {
    const fits = "a".repeat(AGENT_SPEC_PROMPT_MAX_BYTES);
    // 22000 three-byte characters: 22000 characters, 66000 bytes.
    const tooBig = "字".repeat(22_000);
    expect(tooBig.length).toBeLessThan(AGENT_SPEC_PROMPT_MAX_BYTES);
    expect(utf8Bytes(tooBig)).toBeGreaterThan(AGENT_SPEC_PROMPT_MAX_BYTES);
    const out = freezeAgentSpecs([
      { seatId: "fits", spec: spec(fits) },
      { seatId: "big", spec: spec(tooBig) },
    ]);
    expect(Object.keys(out.seats)).toEqual(["fits"]);
    expect(out.seats.fits?.systemPrompt).toBe(fits);
    // The reader holds a hand-edited spec to the same limit.
    const record = frozen({ big: spec(tooBig) });
    const read = readAgentSpecs(record);
    expect(read.kind === "valid" && read.seats.size).toBe(0);
  });

  test("all specs together stay under 256 KiB: in order, a seat that would pass it is left out whole, a later smaller one still fits", () => {
    const big = "x".repeat(63 * 1024);
    const entries = ["a", "b", "c", "d", "e"].map((seatId) => ({ seatId, spec: spec(big) }));
    const out = freezeAgentSpecs([...entries, { seatId: "f", spec: spec("small") }]);
    // Four of 63 KiB fit under 256 KiB; the fifth would not, and is left out whole, not cut.
    expect(Object.keys(out.seats)).toEqual(["a", "b", "c", "d", "f"]);
    expect(utf8Bytes(JSON.stringify(out.seats))).toBeLessThanOrEqual(AGENT_SPECS_MAX_BYTES);
    expect(out.seats.d?.systemPrompt).toBe(big);
  });
});

describe("the digest of the MCP configuration", () => {
  test("the same configuration has the same digest whatever the order of its keys, and nothing is `{}`", () => {
    const a = { x: { command: "node", args: ["a"], env: { K: "1", L: "2" } } };
    const b = { x: { env: { L: "2", K: "1" }, args: ["a"], command: "node" } };
    expect(mcpServersSha256(a)).toBe(mcpServersSha256(b));
    expect(mcpServersSha256(undefined)).toBe(sha256Hex("{}"));
    expect(mcpServersSha256({})).toBe(sha256Hex("{}"));
    expect(stableStringify({ b: [2, { d: 1, c: undefined }], a: null })).toBe(
      '{"a":null,"b":[2,{"d":1}]}',
    );
  });

  test("a stdio entry without a type is the one with the type the host is given; arrays keep their order", () => {
    expect(mcpServersSha256({ s: { command: "node" } })).toBe(
      mcpServersSha256({ s: { command: "node", type: "stdio" } } as never),
    );
    expect(mcpServersSha256({ s: { command: "node", args: ["a", "b"] } })).not.toBe(
      mcpServersSha256({ s: { command: "node", args: ["b", "a"] } }),
    );
    // A changed secret is a changed digest: that is what stops a rebuild with a different configuration.
    expect(mcpServersSha256({ s: { command: "node", env: { T: "one" } } })).not.toBe(
      mcpServersSha256({ s: { command: "node", env: { T: "two" } } }),
    );
  });
});

describe("the attempts (readSeatRebuilds)", () => {
  test("no block is none; a v1 Run's block is ignored; a block that is not whole is invalid, never empty", () => {
    expect(readSeatRebuilds(readyRun()).kind).toBe("absent");
    const record = started(frozen({ [SEAT]: spec("hello") }));
    const read = readSeatRebuilds(record);
    expect(read.kind === "valid" && read.items.map((i) => [i.rebuildId, i.state])).toEqual([
      ["rebuild-seat-b9-g1", "creating"],
    ]);
    expect(readSeatRebuilds({ ...record, schemaVersion: 1 }).kind).toBe("absent");
    const damaged = (change: (block: Record<string, unknown>) => void): RunRecord => {
      const copy = structuredClone(record);
      change((copy as Record<string, unknown>).seatRebuilds as Record<string, unknown>);
      return copy;
    };
    expect(readSeatRebuilds(damaged((b) => (b.version = 2))).kind).toBe("invalid");
    expect(readSeatRebuilds(damaged((b) => (b.items = "x"))).kind).toBe("invalid");
    expect(
      readSeatRebuilds(
        damaged((b) => {
          const items = b.items as Record<string, unknown>[];
          items[0] = { ...(items[0] as Record<string, unknown>), extra: 1 };
        }),
      ).kind,
    ).toBe("invalid");
    expect(
      readSeatRebuilds(
        damaged((b) => {
          const items = b.items as Record<string, unknown>[];
          items.push({ ...items[0] });
        }),
      ).kind,
    ).toBe("invalid");
    expect(
      readSeatRebuilds(
        damaged((b) => {
          const items = b.items as Record<string, unknown>[];
          items[0] = { ...(items[0] as Record<string, unknown>), state: "bound" };
        }),
      ).kind,
    ).toBe("invalid");
  });

  test("a third generation, a made-up generation and an oversized block are not valid", () => {
    const record = started(frozen({ [SEAT]: spec("hello") }));
    const item = (readSeatRebuilds(record) as { items: unknown[] }).items[0] as Record<
      string,
      unknown
    >;
    const withItem = (change: Record<string, unknown>) => {
      const copy = structuredClone(record);
      (copy as Record<string, unknown>).seatRebuilds = {
        version: 1,
        items: [{ ...item, ...change }],
      };
      return copy;
    };
    expect(
      readSeatRebuilds(withItem({ generation: 3, rebuildId: "rebuild-seat-b9-g3" })).kind,
    ).toBe("invalid");
    expect(readSeatRebuilds(withItem({ rebuildId: "somebody-elses" })).kind).toBe("invalid");
    expect(readSeatRebuilds(withItem({ title: "t".repeat(501) })).kind).toBe("invalid");
  });

  test("a title is cut in UTF-16 units like the host's, keeps its suffix and never splits a pair", () => {
    // In unicode mode a class only matches a surrogate that is not half of a pair.
    const lone = /[\ud800-\udfff]/u;
    for (const base of ["😀".repeat(40), `a${"😀".repeat(40)}`, "界".repeat(80), "x"]) {
      const title = rebuildTitle(base, 2);
      expect(title.length).toBeLessThanOrEqual(60);
      expect(title.endsWith("（重建 2）")).toBe(true);
      expect(title.slice(0, 60)).toBe(title);
      expect(lone.test(title)).toBe(false);
    }
  });

  test("the key and the title: the key names the attempt, and the suffix survives the host's 60-character cut", () => {
    expect(rebuildKeyFor("run-1", "seat-b1", 2)).toBe("engine:run-1:seat:seat-b1:rebuild:2");
    expect(rebuildTitle("Builder", 1)).toBe("Builder（重建 1）");
    const long = rebuildTitle("长".repeat(100), 2);
    expect([...long].length).toBeLessThanOrEqual(60);
    expect(long.endsWith("（重建 2）")).toBe(true);
    expect(long.slice(0, 60)).toBe(long);
  });
});

describe("rebindSeatAgent", () => {
  const input = {
    seatId: SEAT,
    fromAgentId: OLD,
    toAgentId: NEW,
    rebuildId: "rebuild-seat-b9-g1",
    generation: 1,
  };

  test("gives the seat the new Agent, says so, and the ledger still holds; old assignments keep the Agent they were made for", () => {
    const before = started(frozen({ [SEAT]: spec("hello") }));
    const oldAssignments = before.assignments.map((a) => a.agentId);
    const result = rebindSeatAgent(before, input, LATER);
    expect(result.ok && result.changed).toBe(true);
    if (!result.ok) return;
    expect(result.next.roster.find((s) => s.seatId === SEAT)?.agentId).toBe(NEW);
    expect(result.next.events.at(-1)).toMatchObject({
      kind: "seat-rebound",
      payload: {
        seatId: SEAT,
        fromAgentId: OLD,
        toAgentId: NEW,
        rebuildId: input.rebuildId,
        generation: 1,
      },
    });
    expect(result.next.assignments.map((a) => a.agentId)).toEqual(oldAssignments);
    // (The shared fixture is a v1 ledger, and the invariants know nothing of the new fields.)
    expect(checkLedgerInvariants({ ...result.next, schemaVersion: 1 })).toEqual({ ok: true });
    expect(before.roster.find((s) => s.seatId === SEAT)?.agentId).toBe(OLD);
  });

  test("seven refusals, each for its own reason", () => {
    const base = started(frozen({ [SEAT]: spec("hello") }));
    expect(rebindSeatAgent(base, { ...input, seatId: "nope" }, NOW)).toEqual({
      ok: false,
      code: "seat-missing",
    });
    expect(rebindSeatAgent(base, { ...input, seatId: COORDINATOR_SEAT_ID }, NOW)).toEqual({
      ok: false,
      code: "seat-not-member",
    });
    const off = structuredClone(base);
    const seat = off.roster.find((s) => s.seatId === SEAT);
    if (seat) seat.enabled = false;
    expect(rebindSeatAgent(off, input, NOW)).toEqual({ ok: false, code: "seat-not-member" });
    expect(rebindSeatAgent(base, { ...input, fromAgentId: "agent-else" }, NOW)).toEqual({
      ok: false,
      code: "agent-mismatch",
    });
    expect(rebindSeatAgent(base, { ...input, toAgentId: OLD }, NOW)).toEqual({
      ok: false,
      code: "agent-mismatch",
    });
    // The new Agent is another seat's, an assignment's, or a nonce's.
    expect(rebindSeatAgent(base, { ...input, toAgentId: "agent-b2" }, NOW)).toEqual({
      ok: false,
      code: "agent-in-use",
    });
    const taken = structuredClone(base);
    const nonce = taken.nonceRegistry[0];
    if (!nonce) throw new Error("fixture has no nonce");
    taken.nonceRegistry.push({ ...nonce, agentId: NEW });
    expect(rebindSeatAgent(taken, input, NOW)).toEqual({ ok: false, code: "agent-in-use" });
  });

  test("an unsettled assignment, a proof the Agent was accepted with, or something still on its way to it, blocks it", () => {
    const base = started(frozen({ [SEAT]: spec("hello") }));
    const open = structuredClone(base);
    const model = open.assignments.find((a) => a.agentId === "agent-b1");
    if (!model) throw new Error("fixture lost the producer assignment");
    open.assignments.push({
      ...structuredClone(model),
      assignmentId: "assignment-b9-open",
      seatId: SEAT,
      agentId: OLD,
      state: "in_progress",
      acceptedProof: null,
      endedAt: null,
      endedEventKey: null,
    });
    expect(rebindSeatAgent(open, input, NOW)).toEqual({ ok: false, code: "assignment-open" });
    expect(rebindBlocker(open, SEAT, OLD)).toBe("assignment-open");

    // An accepted proof is only valid while the roster names the Agent that made it.
    const proven = structuredClone(base);
    const done = proven.assignments.find((a) => a.agentId === "agent-b1");
    if (!done) throw new Error("fixture lost the producer assignment");
    done.seatId = SEAT;
    expect(rebindSeatAgent(proven, input, NOW)).toEqual({ ok: false, code: "proof-bound" });

    const sending = structuredClone(base);
    const intent = sending.outbox[0];
    if (!intent) throw new Error("fixture has no outbox");
    Object.assign(intent, { recipient: OLD, state: "sending" });
    // The assignment of that intent is settled in this fixture, so only the outbox is in the way.
    expect(rebindSeatAgent(sending, input, NOW)).toEqual({ ok: false, code: "outbox-open" });
    expect(rebindBlocker(base, SEAT, OLD)).toBeNull();
  });

  test("doing it again is a no-op decided by the rebuild record, not by an audit event that may be compacted away", () => {
    const record = started(frozen({ [SEAT]: spec("hello") }));
    const done = completeSeatRebuild(record, { rebuildId: input.rebuildId, toAgentId: NEW }, LATER);
    expect(done.ok && done.changed).toBe(true);
    if (!done.ok) return;
    const compacted = structuredClone(done.next);
    compacted.events = compacted.events.filter((e) => e.kind !== "seat-rebound");
    const again = rebindSeatAgent(compacted, input, LATER);
    expect(again).toMatchObject({ ok: true, changed: false });
    expect(
      completeSeatRebuild(compacted, { rebuildId: input.rebuildId, toAgentId: NEW }, LATER),
    ).toMatchObject({ ok: true, changed: false });
    // Without a bound record the same roster is a mismatch, not a success.
    const unrecorded = structuredClone(compacted);
    (unrecorded as Record<string, unknown>).seatRebuilds = undefined;
    expect(rebindSeatAgent(unrecorded, input, LATER)).toEqual({
      ok: false,
      code: "agent-mismatch",
    });
  });

  test("bindSeatAgent still refuses to move a bound seat", () => {
    const record = frozen({ [SEAT]: spec("hello") });
    expect(bindSeatAgent(record, SEAT, NEW, NOW)).toEqual({
      ok: false,
      code: "seat-bound-to-another-agent",
    });
  });
});

describe("the block of attempts stays readable", () => {
  const fillItem = (index: number, titleLength: number, reasonLength = 100) => ({
    rebuildId: `rebuild-seat-fill-${index}-g1`,
    seatId: `seat-fill-${index}`,
    generation: 1,
    fromAgentId: `agent-fill-${index}`,
    toAgentId: `agent-fill-${index}-new`,
    idempotencyKey: `engine:run:seat:seat-fill-${index}:rebuild:1`,
    title: "t".repeat(titleLength),
    reason: "r".repeat(reasonLength),
    state: "bound",
    requestedAt: NOW,
    settledAt: NOW,
    error: null,
  });
  const input = {
    seatId: SEAT,
    generation: 1 as const,
    fromAgentId: OLD,
    title: rebuildTitle("Builder", 1),
    reason: "turn-cut-off",
  };
  const withItems = (items: unknown[]) => {
    const record = frozen({ [SEAT]: spec("hello") });
    (record as Record<string, unknown>).seatRebuilds = { version: 1, items };
    return record;
  };

  test("an attempt that would take the block past its limit is not written; one that fits is, and binding it leaves the block readable", () => {
    // Fill the block until one more attempt no longer fits.
    const items: unknown[] = [];
    while (canStartRebuild(withItems(items), input)) items.push(fillItem(items.length, 300));
    expect(readSeatRebuilds(withItems(items)).kind).toBe("valid");
    const refused = startRebuildRecord(withItems(items), input, NOW);
    expect(refused.changed).toBe(false);
    expect(readSeatRebuilds(refused.next).kind).toBe("valid");

    // One filler is cut down, a byte at a time, until the new attempt just fits: as tight as the check allows.
    items.pop();
    items.pop();
    let total = 700;
    const filler = (size: number) => {
      const title = Math.min(500, size - 1);
      return fillItem(items.length, title, size - title);
    };
    while (total > 2 && !canStartRebuild(withItems([...items, filler(total)]), input)) total -= 1;
    const tight = withItems([...items, filler(total)]);
    const started = startRebuildRecord(tight, input, NOW);
    expect(started.changed).toBe(true);
    expect(readSeatRebuilds(started.next).kind).toBe("valid");
    const done = completeSeatRebuild(
      started.next,
      { rebuildId: "rebuild-seat-b9-g1", toAgentId: NEW },
      LATER,
    );
    expect(done.ok && done.changed).toBe(true);
    if (done.ok) expect(readSeatRebuilds(done.next).kind).toBe("valid");
    const failed = failRebuildRecord(started.next, "rebuild-seat-b9-g1", "create-failed", LATER);
    expect(failed.changed).toBe(true);
    expect(readSeatRebuilds(failed.next).kind).toBe("valid");
  });
});

describe("the attempt's records and alerts move together", () => {
  test("starting writes one creating record and one alert; starting again writes nothing", () => {
    const record = started(frozen({ [SEAT]: spec("hello") }));
    expect(record.alerts.filter((a) => a.state === "open")).toHaveLength(1);
    expect(record.alerts[0]?.summary).toContain("正在重建席位 seat-b9");
    const again = startRebuildRecord(
      record,
      { seatId: SEAT, generation: 1, fromAgentId: OLD, title: "t", reason: "r" },
      LATER,
    );
    expect(again.changed).toBe(false);
    expect(again.next).toBe(record);
  });

  test("an unreadable block is never added to", () => {
    const record = started(frozen({ [SEAT]: spec("hello") }));
    (record as Record<string, unknown>).seatRebuilds = { version: 7 };
    const result = startRebuildRecord(
      record,
      { seatId: SEAT, generation: 2, fromAgentId: OLD, title: "t", reason: "r" },
      LATER,
    );
    expect(result.changed).toBe(false);
  });

  test("binding marks it bound, takes down 'being rebuilt', says 'rebuilt' and lists the Agent the observer stops hearing", () => {
    const record = started(frozen({ [SEAT]: spec("hello") }));
    const done = completeSeatRebuild(
      record,
      { rebuildId: "rebuild-seat-b9-g1", toAgentId: NEW },
      LATER,
    );
    if (!done.ok) throw new Error(done.code);
    const read = readSeatRebuilds(done.next);
    expect(read.kind === "valid" && read.items[0]).toMatchObject({
      state: "bound",
      toAgentId: NEW,
      settledAt: LATER,
    });
    const open = done.next.alerts.filter((a) => a.state === "open").map((a) => a.summary);
    expect(open).toHaveLength(1);
    expect(open[0]).toContain("已按启动时冻结的配置为席位 seat-b9 新建 Agent（第 1 次）");
    expect(open[0]).toContain("归档它不影响这个 Run");
    expect([...reboundFromAgents(done.next)]).toEqual([OLD]);
    // Before it is bound the observer still listens to the old Agent.
    expect([...reboundFromAgents(record)]).toEqual([]);
    expect(checkLedgerInvariants({ ...done.next, schemaVersion: 1 })).toEqual({ ok: true });
  });

  test("binding something that was not started, or already failed, is refused and changes nothing", () => {
    const record = frozen({ [SEAT]: spec("hello") });
    expect(
      completeSeatRebuild(record, { rebuildId: "rebuild-seat-b9-g1", toAgentId: NEW }, NOW),
    ).toEqual({
      ok: false,
      code: "rebuild-missing",
    });
    const failed = failRebuildRecord(started(record), "rebuild-seat-b9-g1", "create-failed", LATER);
    expect(
      completeSeatRebuild(failed.next, { rebuildId: "rebuild-seat-b9-g1", toAgentId: NEW }, LATER),
    ).toEqual({ ok: false, code: "rebuild-settled" });
  });

  test("failing records the code (only the code), takes down 'being rebuilt' and says what to do", () => {
    const failed = failRebuildRecord(
      started(frozen({ [SEAT]: spec("hello") })),
      "rebuild-seat-b9-g1",
      "boom: secret detail!",
      LATER,
    );
    expect(failed.changed).toBe(true);
    const read = readSeatRebuilds(failed.next);
    const item = read.kind === "valid" ? read.items[0] : undefined;
    expect(item).toMatchObject({ state: "failed", toAgentId: null, settledAt: LATER });
    expect(item?.error).toBe("boom:-secret-detail-");
    const open = failed.next.alerts.filter((a) => a.state === "open");
    expect(open).toHaveLength(1);
    expect(open[0]?.summary).toContain("重建席位 seat-b9 的 Agent 失败（第 1 次，原因码");
    expect(open[0]?.summary).toContain("立即检查并推进");
    // Failing twice changes nothing the second time.
    expect(failRebuildRecord(failed.next, "rebuild-seat-b9-g1", "x", LATER).changed).toBe(false);
    expect([...reboundFromAgents(failed.next)]).toEqual([]);
  });

  test("alerts are taken down when they stop being true, and only then", () => {
    const record = started(frozen({ [SEAT]: spec("hello") }));
    const stay = (r: RunRecord, held: boolean, over = false) =>
      settleRebuildAlerts(r, { held, over }, LATER).alerts.filter((a) => a.state !== "resolved");
    // Being rebuilt stays while it is being rebuilt.
    expect(stay(record, true)).toHaveLength(1);
    expect(stay(record, false)).toHaveLength(1);

    const bound = completeSeatRebuild(
      record,
      { rebuildId: "rebuild-seat-b9-g1", toAgentId: NEW },
      LATER,
    );
    if (!bound.ok) throw new Error(bound.code);
    // 'Rebuilt' stays until the new Agent has taken a dispatch (or the Run is over).
    expect(stay(bound.next, false)).toHaveLength(1);
    expect(stay(bound.next, false, true)).toHaveLength(0);
    const sent = structuredClone(bound.next);
    const intent = sent.outbox[0];
    if (!intent) throw new Error("no outbox");
    Object.assign(intent, { kind: "dispatch", recipient: NEW, state: "prepared" });
    expect(stay(sent, false)).toHaveLength(1);
    intent.state = "confirmed";
    expect(stay(sent, false)).toHaveLength(0);

    // Failed stays while something still waits for a closed seat, and goes when nothing does.
    const failed = failRebuildRecord(record, "rebuild-seat-b9-g1", "create-failed", LATER);
    expect(stay(failed.next, true)).toHaveLength(1);
    expect(stay(failed.next, false)).toHaveLength(0);
    expect(stay(failed.next, true, true)).toHaveLength(0);
    // A Run that never rebuilt is returned as it came.
    const plain = readyRun();
    expect(settleRebuildAlerts(plain, { held: false, over: true }, LATER)).toBe(plain);
  });
});

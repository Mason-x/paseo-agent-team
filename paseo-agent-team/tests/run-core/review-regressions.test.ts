import { describe, expect, test } from "vitest";
import { budgetKey } from "../../shared/domain/run-engine/budget";
import {
  findLockConflicts,
  lockConflicts,
  normalizeLogicalPath,
  type VerifiedScope,
} from "../../shared/domain/run-engine/locks";
import {
  eligibleSeats,
  nextQualityFailure,
  planDispatchWithReasons,
  type SchedulerContext,
  type SeatRuntime,
} from "../../shared/domain/run-engine/scheduler";
import {
  buildWakeSummary,
  classifyWake,
  type WakeCategory,
} from "../../shared/domain/run-engine/wake-summary";
import type { RunRecord, RunTaskRecord } from "../../shared/schemas/run-engine/ledger";
import { escalation, NORMAL_RUN_LEDGER, spec, taskRecord } from "../fixtures/run-engine";

const NOW = "2026-10-29T00:00:00.000Z";
const EPOCH = { policyEpoch: "review-156" };
const DECISION_ID = "22222222-2222-4222-8222-222222222222";
const B_TO_A = escalation();
const A_TO_S = escalation({ fromTier: "A", toTier: "S", atAttempt: 6, qualityFailures: 6 });

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    ...NORMAL_RUN_LEDGER,
    tasks: [taskRecord(spec("T1", "Ship"), { state: "ready" })],
    roster: (["B", "A", "S"] as const).map((tier) => ({
      seatId: `seat-${tier}`,
      tier,
      agentId: `agent-${tier}`,
      channelId: `channel-${tier}`,
      enabled: true,
      duties: ["implement"],
    })),
    decisions: [],
    budgets: { entries: [] },
    ...overrides,
  };
}

function live(tier: "B" | "A" | "S", patch: Partial<SeatRuntime> = {}): SeatRuntime {
  return {
    seatId: `seat-${tier}`,
    profileId: `profile-${tier}`,
    agentId: `agent-${tier}`,
    enabled: true,
    idle: true,
    permissionPending: false,
    degraded: false,
    channelState: "available",
    available: true,
    load: 0,
    qualityRework: 0,
    order: 0,
    ...patch,
  };
}

function context(seats = [live("B"), live("A"), live("S")]): SchedulerContext {
  return { now: NOW, mode: "sota", seats };
}

function decision(category: WakeCategory, subjectId: string | null) {
  return {
    decisionId: DECISION_ID,
    category,
    subjectId,
    state: "open" as const,
    dedupeKey: "review-decision",
    controlNonceDigest: "a".repeat(64),
    summary: "SECRET_WORKER_TEXT nonce payload",
    createdAt: NOW,
    answeredAt: null,
  };
}

function budget(scope: "seat" | "group", subjectId: string, reserved = 5) {
  return { scope, subjectId, reserved, limit: 5, confirmed: 0, observedTurns: 0 };
}

describe("156 scheduler regressions", () => {
  test.each([
    ["B→A", [B_TO_A], "A"],
    ["B→A→S", [B_TO_A, A_TO_S], "S"],
  ] as const)("B1 dispatches %s at the applied execution tier", (_label, escalations, tier) => {
    const next = record({
      tasks: [
        taskRecord(spec("T1", "Ship"), {
          state: "ready",
          escalations: [...escalations],
          qualityFailures: escalations.at(-1)?.qualityFailures ?? 0,
          attempts: escalations.at(-1)?.atAttempt ?? 0,
        }),
      ],
    });
    expect(eligibleSeats(next, "T1", context()).candidates.map((seat) => seat.seatId)).toEqual([
      `seat-${tier}`,
    ]);
  });

  test("B1 L4 a-with-s-plan implementation stays at A after the plan is done", () => {
    const next = record({
      tasks: [
        taskRecord(spec("plan", "Plan", { level: "L4", tier: "S" }), { state: "done" }),
        taskRecord(
          spec("T1", "Implement", {
            level: "L4",
            tier: "A",
            implementationPolicy: "a-with-s-plan",
            architectureTaskId: "plan",
          }),
          { state: "ready" },
        ),
      ],
    });
    expect(planDispatchWithReasons(next, context()).proposals).toMatchObject([
      { taskId: "T1", seatId: "seat-A" },
    ]);
  });

  test("B1 quality classification uses the last epoch baseline, not escalation count", () => {
    const task = taskRecord(spec("T1", "Ship"), {
      qualityFailures: 9,
      attempts: 9,
      escalations: [B_TO_A, { ...A_TO_S, qualityFailures: 8, atAttempt: 8 }],
    });
    const policy = record().policy;
    expect(
      nextQualityFailure(task, {
        ...policy,
        perTask: { ...policy.perTask, implementationAttempts: 10 },
      }),
    ).toEqual({ kind: "rework", layerFailures: 1 });
  });

  test.each([
    ["B", [], "B", 0],
    ["A", [], "A", 0],
    ["S", [], "S", 0],
    ["B", [B_TO_A], "A", 3],
    ["B", [B_TO_A, A_TO_S], "S", 6],
    ["A", [{ ...A_TO_S, qualityFailures: 3, atAttempt: 3 }], "S", 3],
  ] as const)(
    "B1 quality ladder starts at %s with epochs %j",
    (initial, epochs, current, baseline) => {
      const policy = record().policy;
      for (const failures of [1, 2, 3]) {
        const task = taskRecord(
          spec("T1", "Ship", {
            tier: initial,
            level: initial === "S" ? "L4" : initial === "A" ? "L3" : "L2",
          }),
          {
            escalations: [...epochs],
            qualityFailures: baseline + failures,
            attempts: baseline + failures,
          },
        );
        const result = nextQualityFailure(task, {
          ...policy,
          perTask: { ...policy.perTask, implementationAttempts: 10 },
        });
        expect(result).toEqual(
          failures < 3
            ? { kind: "rework", layerFailures: failures }
            : current === "S"
              ? { kind: "blocked", decision: "D3", reason: "S-quality-failure" }
              : { kind: "escalate", nextTier: current === "B" ? "A" : "S", layerFailures: 0 },
        );
      }
    },
  );

  test("I1 ready with an old seat-busy explanation dispatches once the seat recovers", () => {
    const next = record({
      tasks: [taskRecord(spec("T1", "Ship"), { state: "ready", waitingReason: "seat-busy" })],
    });
    expect(eligibleSeats(next, "T1", context()).blocked).toBeNull();
    expect(planDispatchWithReasons(next, context())).toMatchObject({
      proposals: [{ taskId: "T1", seatId: "seat-B" }],
      blocked: [],
    });
  });

  const temporary: Array<[string, Partial<SeatRuntime>]> = [
    ["busy", { idle: false }],
    ["permission", { permissionPending: true }],
    ["channel", { channelState: "paused" }],
    ["profile-unavailable", { available: false }],
  ];
  test.each(temporary)(
    "I2 unrelated S %s cannot turn missing B capability into wait",
    (_name, patch) => {
      const plan = planDispatchWithReasons(record(), context([live("S", patch)]));
      expect(plan.blocked).toMatchObject([{ decision: "D1", reasons: [{ reason: "tier" }] }]);
    },
  );
  test.each(temporary)("I2 structural duty/mode/profile filters precede %s", (_name, patch) => {
    const next = record();
    const ctx = context([live("B", patch)]);
    const scenarios: Array<[RunRecord, SchedulerContext, string]> = [
      [next, { ...ctx, requiredDuty: "review" }, "duty"],
      [next, { ...ctx, mode: "economy-all", profileAllowed: () => false }, "mode"],
      [
        { ...next, policy: { ...next.policy, disabledProfileIds: ["profile-B"] } },
        ctx,
        "disabled-profile",
      ],
    ];
    for (const [input, config, reason] of scenarios) {
      expect(planDispatchWithReasons(input, config).blocked).toMatchObject([
        { decision: "D1", reasons: [{ reason }] },
      ]);
    }
  });
  test.each(temporary)("I2 a structurally eligible B %s remains wait", (_name, patch) => {
    expect(planDispatchWithReasons(record(), context([live("B", patch)])).blocked).toMatchObject([
      { decision: "wait" },
    ]);
  });
  test.each([{ degraded: true }, { agentId: null }])(
    "I2 temporarily unhealthy same-tier capability remains wait: %j",
    (patch) => {
      expect(planDispatchWithReasons(record(), context([live("B", patch)])).blocked).toMatchObject([
        { decision: "wait" },
      ]);
      expect(planDispatchWithReasons(record(), context([live("S", patch)])).blocked).toMatchObject([
        { decision: "D1", reasons: [{ reason: "tier" }] },
      ]);
    },
  );

  test.each([{}, { idle: false }])("I3 policy-disabled channel is a hard veto: %j", (patch) => {
    const next = record();
    next.policy = { ...next.policy, disabledChannels: ["channel-B"] };
    expect(planDispatchWithReasons(next, context([live("B", patch)]))).toMatchObject({
      proposals: [],
      blocked: [{ decision: "D1", reasons: [{ reason: "disabled-channel" }] }],
    });
  });
});

describe("156 lock regressions", () => {
  test.each(["T1", "T2"])("I4 frozen read prevents new read grants to %s", (taskId) => {
    const claim = {
      claimId: "frozen-read",
      taskId: "T1",
      repoId: "repo",
      kind: "file" as const,
      path: "src/a.ts",
      access: "read" as const,
      frozen: true,
      createdAt: NOW,
    };
    const scope: VerifiedScope = { ...claim, verified: true };
    // Stored read/read compatibility is separate from permission to grant a new frozen range.
    expect(lockConflicts(claim, scope)).toBe("none");
    expect(findLockConflicts({ resources: [claim] }, { taskId, scopes: [scope] })).toMatchObject({
      ok: true,
      conflicts: [{ claimId: "frozen-read", reason: "frozen" }],
    });
    expect(
      findLockConflicts(
        { resources: [{ ...claim, kind: "directory", path: "src" }] },
        {
          taskId,
          scopes: [scope],
        },
      ),
    ).toMatchObject({ ok: true, conflicts: [{ reason: "frozen" }] });
    expect(
      findLockConflicts(
        { resources: [claim] },
        {
          taskId,
          scopes: [{ ...scope, path: "other/a.ts" }],
        },
      ),
    ).toEqual({ ok: true, conflicts: [] });
  });

  test.each(["COM¹", "com².txt", "LPT³", "lpt¹.log", "COM³/x", "LPT².txt/x"])(
    "I5 rejects Windows superscript device segment %s",
    (path) =>
      expect(normalizeLogicalPath(`src/${path}`)).toEqual({ ok: false, reason: "reserved" }),
  );
  test("I5 retains NFC without compatibility folding ordinary superscripts", () => {
    expect(normalizeLogicalPath("src/name¹")).toMatchObject({ ok: true, path: "src/name¹" });
    expect(normalizeLogicalPath("src/COM⁴")).toMatchObject({ ok: true, path: "src/COM⁴" });
  });
});

describe("156 wake regressions", () => {
  test("I6 first S quality failure alone does not fabricate D3", () => {
    const task = taskRecord(spec("T1", "Ship", { level: "L4", tier: "S" }), {
      state: "failed",
      qualityFailures: 1,
      attempts: 1,
    });
    const next = record({ tasks: [task] });
    expect(classifyWake(record(), next, EPOCH)).toEqual([]);
  });
  test("I6 S infrastructure failure with D1 never emits a second D3", () => {
    const next = record({
      tasks: [taskRecord(spec("T1", "Ship", { level: "L4", tier: "S" }), { state: "failed" })],
      decisions: [decision("D1", "T1")],
    });
    expect(classifyWake(record(), next, EPOCH).map((wake) => wake.category)).toEqual(["D1"]);
  });
  test("I6 an escalated B task's explicit D3 is the only wake", () => {
    const next = record({
      tasks: [
        taskRecord(spec("T1", "Ship"), {
          state: "failed",
          escalations: [B_TO_A, A_TO_S],
          qualityFailures: 9,
          attempts: 9,
        }),
      ],
      decisions: [decision("D3", "T1")],
    });
    expect(classifyWake(record(), next, EPOCH)).toMatchObject([
      { category: "D3", taskId: "T1", source: "decision" },
    ]);
  });

  test("I7 seat/shared and group/shared are independent D4 entities", () => {
    const prev = record({
      budgets: { entries: [budget("seat", "shared", 4), budget("group", "shared", 4)] },
    });
    const next = record({
      budgets: { entries: [budget("seat", "shared"), budget("group", "shared")] },
    });
    const wakes = classifyWake(prev, next, EPOCH);
    expect(wakes.map((wake) => wake.subjectId).sort()).toEqual(["group:shared", "seat:shared"]);
    expect(new Set(wakes.map((wake) => wake.dedupeKey)).size).toBe(2);
    for (const wake of wakes) {
      expect(buildWakeSummary(wake, next)).toContain(`预算 ${wake.subjectId} 5/5`);
    }
  });
  test.each(["seat:b", "b"])(
    "I7/I8 D4 decision %s and matching exhaustion dedupe with facts",
    (subjectId) => {
      const next = record({
        decisions: [decision("D4", subjectId)],
        budgets: { entries: [budget("seat", "b")] },
      });
      const wakes = classifyWake(record(), next, EPOCH);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toMatchObject({
        subjectId: budgetKey({ scope: "seat", subjectId: "b" }),
        source: "decision",
        decisionId: DECISION_ID,
        budget: { scope: "seat", subjectId: "b" },
      });
      const wake = wakes[0];
      if (!wake) throw new Error("missing D4 wake");
      expect(buildWakeSummary(wake, next)).toContain("预算 seat:b 5/5");
    },
  );
  test("I7 ambiguous legacy D4 subject retains both budget scopes", () => {
    const next = record({
      decisions: [decision("D4", "shared")],
      budgets: { entries: [budget("seat", "shared"), budget("group", "shared")] },
    });
    const wakes = classifyWake(record(), next, EPOCH);
    expect(wakes).toHaveLength(2);
    expect(wakes.every((wake) => wake.source === "decision")).toBe(true);
    expect(wakes.map((wake) => buildWakeSummary(wake, next)).join("\n")).toContain(
      "预算 group:shared 5/5",
    );
  });

  test("I8 task decision keeps decision id and safe current-tier task context", () => {
    const task: RunTaskRecord = taskRecord(spec("T1", "Ship"), {
      state: "ready",
      escalations: [B_TO_A],
      attempts: 4,
      reworkCount: 2,
      qualityFailures: 4,
      waitingReason: "SECRET_WAITING_REASON",
      workerReport: "SECRET_WORKER_REPORT",
    });
    const next = record({ tasks: [task], decisions: [decision("D1", "T1")] });
    const wakes = classifyWake(record(), next, EPOCH);
    expect(wakes[0]).toMatchObject({ taskId: "T1", decisionId: DECISION_ID });
    const wake = wakes[0];
    if (!wake) throw new Error("missing task wake");
    const summary = buildWakeSummary(wake, next);
    for (const text of [
      "任务 T1",
      "状态=ready",
      "当前层=A",
      "尝试=4",
      "返工=2",
      "质量失败=4",
      "决策点 D1",
    ]) {
      expect(summary).toContain(text);
    }
    expect(summary).not.toMatch(/SECRET_|nonce|payload/u);
  });

  test("I8 an unscoped waiting-human decision retains its own identity", () => {
    const next = record({ decisions: [{ ...decision("D2", null), state: "waiting-human" }] });
    const wake = classifyWake(record(), next, EPOCH)[0];
    if (!wake) throw new Error("missing unscoped decision wake");
    expect(wake).toMatchObject({ decisionId: DECISION_ID, taskId: null, budget: null });
    expect(buildWakeSummary(wake, next)).toContain("决策点 D2");
  });

  test.each([
    0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
  ])("I9 strips Bidi_Control U+%i from summary facts", (code) => {
    const control = String.fromCodePoint(code);
    const next = record({
      tasks: [
        taskRecord(spec("T1", `Ship${control}title`, { goal: `Safe${control}goal` }), {
          state: "ready",
        }),
      ],
      decisions: [decision("D1", "T1")],
    });
    // Set the resolved task explicitly so this matrix tests I9 independently of I8.
    const summary = buildWakeSummary(
      {
        category: "D1",
        subjectId: "T1",
        taskId: "T1",
        source: "decision",
        dedupeKey: "bidi-probe",
        decisionId: DECISION_ID,
        budget: null,
      },
      next,
    );
    expect(summary).toContain("Ship title");
    expect(summary).toContain("Safe goal");
    expect(summary).not.toContain(control);
  });
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test("156 fixes stay pure and deterministic with deeply frozen input and long safe facts", () => {
  const prev = deepFreeze(record());
  const next = deepFreeze(
    record({
      tasks: [
        taskRecord(spec("T1", "Safe title", { goal: "😀".repeat(2000) }), {
          state: "ready",
          waitingReason: "SECRET_WAITING_REASON",
          ref: { kind: "git-commit", value: "abc123" },
        }),
      ],
      budgets: { entries: [budget("seat", "b")] },
      decisions: [
        decision("D1", "T1"),
        { ...decision("D4", "b"), decisionId: "33333333-3333-4333-8333-333333333333" },
      ],
    }),
  );
  const ctx = deepFreeze(context());
  const before = JSON.stringify({ prev, next, ctx });
  expect(planDispatchWithReasons(next, ctx)).toEqual(planDispatchWithReasons(next, ctx));
  const wakes = classifyWake(prev, next, EPOCH);
  expect(wakes).toEqual(classifyWake(prev, next, EPOCH));
  for (const wake of wakes) {
    const summary = buildWakeSummary(wake, next);
    expect(summary).toBe(buildWakeSummary(wake, next));
    expect(new TextEncoder().encode(summary).length).toBeLessThanOrEqual(4096);
    expect(summary.endsWith("选项：检查后重试；提供决定；取消")).toBe(true);
    expect(summary.isWellFormed()).toBe(true);
    expect(summary).not.toMatch(/SECRET_|nonce|payload/u);
    if (wake.taskId !== null) expect(summary).toContain("证据引用 git-commit:abc123");
  }
  expect(JSON.stringify({ prev, next, ctx })).toBe(before);
});

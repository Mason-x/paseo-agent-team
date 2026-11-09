import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { eventCause } from "../../shared/domain/run-engine/timeline";
import {
  RUN_COUNTER_EVENTS,
  RUN_REDUCER_EVENT_KINDS,
} from "../../shared/domain/run-engine/transitions";
import { historyRows } from "../../shared/domain/run-engine/view";
import {
  explainAlert,
  explainDecision,
  explainTask,
  explainWaiting,
} from "../../shared/domain/run-engine/waiting";
import type { RunDetailView, RunTaskView } from "../../shared/schemas/run-engine/rpc";
import { EVENT_CAUSE_ZH } from "../../shared/zh/run-engine-waiting";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tpl = (text: string) => text.replaceAll("§{", "${");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

/** Every match of `pattern` (first capture group) in `file`, and a floor so a refactor is noticed. */
function scan(file: string, pattern: RegExp, atLeast: number): string[] {
  const found = [...read(file).matchAll(pattern)].map((match) => match[1] as string);
  expect(found.length, `${file} no longer matches ${pattern}`).toBeGreaterThanOrEqual(atLeast);
  return found;
}

/**
 * The Engine writes a task's `waitingReason` from a handful of places. Each is scanned from the
 * source, so a new code written there without an entry in `shared/zh/run-engine-waiting.ts` fails
 * this file. When a site is moved or reshaped the floor below tells the author to update the scan.
 */
describe("every reason the server writes has words", () => {
  const unknownOf = (reason: string) => explainWaiting(reason).known === false;

  test("dispatch-blocked: the literal reasons of the service and the dispatch builders", () => {
    const codes = [
      ...scan("server/run-engine/service.ts", /reason: "([a-z][a-z-]*)"/gu, 20),
      ...scan("shared/domain/run-engine/dispatch-builder.ts", /reason: "([a-z][a-z-]*)"/gu, 10),
    ].filter((code) => code !== "no-seat");
    const missing = [...new Set(codes)].filter((code) => unknownOf(`dispatch-blocked:${code}`));
    expect(missing).toEqual([]);
  });

  test("dispatch-blocked: every builder refusal has words, including dynamically chosen budget codes", () => {
    const text = read("shared/domain/run-engine/dispatch-builder.ts");
    const union = /export type DispatchRefusal =([\s\S]*?);/u.exec(text);
    expect(union).not.toBeNull();
    const codes = [...(union?.[1] ?? "").matchAll(/"([a-z][a-z-]+)"/gu)].map(
      (match) => match[1] as string,
    );
    expect(codes).toEqual(expect.arrayContaining(["budget-missing", "budget-exhausted"]));
    expect(codes.length).toBeGreaterThanOrEqual(15);
    expect(codes.filter((code) => unknownOf(`dispatch-blocked:${code}`))).toEqual([]);
  });

  test("budget exhaustion offers an increase but a missing record cannot be increased", () => {
    const exhausted = explainWaiting("dispatch-blocked:budget-exhausted");
    const missing = explainWaiting("dispatch-blocked:budget-missing");
    expect(exhausted.next).toContain("追加预算");
    expect(missing.why).toContain("没有回合预算记录");
    expect(missing.next).toContain("无法");
  });

  test("dispatch-blocked: the families whose detail is a git or filesystem code", () => {
    const prefixes = scan("server/run-engine/service.ts", /reason: `([a-z]+-)\$\{/gu, 4);
    expect(prefixes.length).toBeGreaterThan(0);
    for (const prefix of new Set(prefixes)) {
      expect(unknownOf(`dispatch-blocked:${prefix}anything`), prefix).toBe(false);
    }
  });

  test("the driver writes exactly dispatch-blocked and waiting-for-seat", () => {
    const text = read("server/run-engine/driver.ts");
    expect(text).toContain(tpl("`dispatch-blocked:§{result.reason}`"));
    expect(text).toContain("`waiting-for-seat${why ?");
    expect(unknownOf("waiting-for-seat")).toBe(false);
    expect(unknownOf("waiting-for-seat:busy,permission")).toBe(false);
  });

  test("every seat denial has words", () => {
    const union = /reason:\s*((?:\s*\|\s*"[a-z-]+")+);/u.exec(
      read("shared/domain/run-engine/scheduler.ts"),
    );
    const denials = [...(union?.[1] ?? "").matchAll(/"([a-z-]+)"/gu)].map((match) => match[1]);
    expect(denials.length).toBeGreaterThanOrEqual(10);
    for (const denial of denials) {
      // The raw code must have been translated, not echoed.
      expect(explainWaiting(`waiting-for-seat:${denial}`).why, denial).not.toContain(
        denial as string,
      );
      expect(explainWaiting(`waiting-for-seat:${denial}`).why, denial).toMatch(/：/u);
    }
  });

  test("the intake's reasons: report problems and repairs", () => {
    const text = read("server/run-engine/intake.ts");
    const literals = [
      ...scan(
        "server/run-engine/intake.ts",
        /recordProblem\(\s*runId,\s*assignmentId,\s*"([a-z-]+)"/gu,
        1,
      ),
      ...scan("server/run-engine/intake.ts", /resultReason = "([a-z-]+)"/gu, 1),
    ];
    expect(literals).toEqual(
      expect.arrayContaining(["report-missing", "report-repair-budget-exhausted"]),
    );
    for (const reason of literals) expect(unknownOf(reason), reason).toBe(false);
    for (const template of [
      tpl("`report-rejected:§{inspected.reason}`"),
      tpl("`report-ownership:§{inspected.ownership.code}`"),
      tpl("`report-refused:§{String(reduced.params.reason ?? reduced.code)}`"),
      tpl("`report-ownership:§{owned.code}`"),
    ]) {
      expect(text, template).toContain(template);
    }
    for (const family of ["report-rejected:x", "report-ownership:x", "report-refused:x"]) {
      expect(unknownOf(family), family).toBe(false);
    }
    expect(read("shared/domain/run-engine/report-repair.ts")).toContain(
      tpl("`report-repair-requested:§{input.reason}`"),
    );
    expect(unknownOf("report-repair-requested:report-missing")).toBe(false);
  });

  test("the effects' and the answer's reasons", () => {
    const noted = scan("server/run-engine/effects.ts", /noteTask\([^"]*"([a-z-]+)"/gu, 2);
    for (const reason of noted) expect(unknownOf(reason), reason).toBe(false);
    const answered = scan(
      "shared/domain/run-engine/decision-answer.ts",
      /waitingReason = "([a-z-]+)"/gu,
      1,
    );
    for (const reason of answered) expect(unknownOf(reason), reason).toBe(false);
  });

  test("the quality ladder and the review/smoke failures the reducer leaves", () => {
    const planned = scan(
      "shared/domain/run-engine/scheduler.ts",
      /decision: "D[34]", reason: "([A-Za-z-]+)"/gu,
      2,
    );
    const failures = scan(
      "shared/domain/run-engine/reducer.ts",
      /afterGateFailure\(next, task, "([a-z-]+)"/gu,
      2,
    );
    for (const reason of [...planned, ...failures]) expect(unknownOf(reason), reason).toBe(false);
  });

  test("every reason a refused evidence gate can leave", () => {
    const reasons = scan(
      "shared/domain/run-engine/gates.ts",
      /fail\(\s*"evidence",\s*\[[^\]]*\],\s*"([a-z-]+)"/gu,
      8,
    );
    for (const reason of new Set(reasons)) expect(unknownOf(reason), reason).toBe(false);
  });

  test("a code nobody wrote words for says so with its code, and never throws", () => {
    for (const reason of [
      "brand-new-reason",
      "constructor",
      "__proto__",
      "toString",
      "dispatch-blocked:",
      "dispatch-blocked:never-seen",
      "",
    ]) {
      const said = explainWaiting(reason);
      expect(said.known, reason).toBe(false);
      expect(said.why.length).toBeGreaterThan(0);
      expect(said.who.length).toBeGreaterThan(0);
      expect(said.next.length).toBeGreaterThan(0);
    }
    expect(explainWaiting("brand-new-reason").why).toContain("brand-new-reason");
  });

  test("every explanation has all three parts", () => {
    for (const reason of [
      "report-missing",
      "dispatch-blocked:workspace-dirty",
      "dispatch-blocked:workspace-detached-head",
      "waiting-for-seat:busy",
      "report-rejected:schema-invalid",
      "missing",
      "retry-approved",
    ]) {
      const said = explainWaiting(reason);
      expect(said.known, reason).toBe(true);
      expect(said.why.length, reason).toBeGreaterThan(3);
      expect(said.who.length, reason).toBeGreaterThan(0);
      expect(said.next.length, reason).toBeGreaterThan(3);
    }
  });
});

function task(overrides: Partial<RunTaskView> = {}): RunTaskView {
  return {
    taskId: "T1",
    title: "Core",
    state: "ready",
    phase: null,
    level: "L1",
    tier: "B",
    execution: "write",
    assignee: null,
    attempts: 0,
    protocolFailures: 0,
    evidenceReturns: 0,
    reworkCount: 0,
    qualityFailures: 0,
    currentTier: "B",
    escalations: [],
    blockedBy: null,
    waitingReason: null,
    frozen: false,
    ...overrides,
  };
}

const decision = (
  overrides: Partial<RunDetailView["decisions"][number]> = {},
): RunDetailView["decisions"][number] => ({
  decisionId: "6f1c2a44-3b7e-4f0a-9a11-000000000001",
  category: "D3",
  state: "open",
  subjectId: "T1",
  summary: "x",
  createdAt: "2026-10-29T01:02:03.000Z",
  answeredAction: null,
  actions: ["retry"],
  ...overrides,
});

describe("explainTask", () => {
  const whole = (value: { why: string; who: string; next: string }) => {
    expect(value.why.length).toBeGreaterThan(2);
    expect(value.who.length).toBeGreaterThan(0);
    expect(value.next.length).toBeGreaterThan(2);
  };

  test("every state has an explanation, with and without a reason", () => {
    for (const state of [
      "pending",
      "ready",
      "assigned",
      "in_progress",
      "review",
      "rework",
      "done",
      "failed",
      "blocked",
      "cancelled",
    ] as const) {
      whole(explainTask(task({ state }), []));
      whole(explainTask(task({ state, waitingReason: "report-missing" }), []));
    }
  });

  test.each([
    ["dependency", "T0"],
    ["lock", "claim-1"],
    ["permission", "agent-b1"],
    ["capacity", null],
    ["channel", "claude"],
    ["seat", null],
    ["other", null],
  ] as const)("blocked by %s", (kind, ref) => {
    whole(explainTask(task({ state: "ready", blockedBy: { kind, ref } }), []));
  });

  test("a permission wait names the owner and says the Engine never answers", () => {
    const said = explainTask(
      task({ state: "in_progress", blockedBy: { kind: "permission", ref: "agent-b1" } }),
      [],
    );
    expect(said.why).toContain("agent-b1");
    expect(said.next).toContain("不代答");
  });

  test("a decision wait is explained by the decision it names", () => {
    const open = decision();
    const said = explainTask(
      task({ state: "failed", blockedBy: { kind: "decision", ref: open.decisionId } }),
      [open],
    );
    expect(said).toEqual(explainDecision(open));
    expect(said.who).toBe("你");
    const missing = explainTask(
      task({ state: "failed", blockedBy: { kind: "decision", ref: "nope" } }),
      [],
    );
    whole(missing);
  });

  test("a turn the host lost (T4b) says whose it is, who answers and what each answer does", () => {
    const said = explainTask(task({ state: "assigned", waitingReason: "host-lost" }), []);
    expect(said.why).toContain("宿主重启");
    expect(said.who).toContain("你");
    expect(said.next).toContain("重试");
    expect(said.next).toContain("取消");
    expect(said.next).toContain("确认它已经停止");
  });

  test("a member's own reason code on a blocked task is shown as theirs", () => {
    const said = explainTask(task({ state: "blocked", waitingReason: "EVIDENCE_UNAVAILABLE" }), []);
    expect(said.why).toContain("EVIDENCE_UNAVAILABLE");
    expect(said.who).toBe("你");
  });

  test("an unknown reason on a running task is not blamed on the member", () => {
    const said = explainTask(task({ state: "in_progress", waitingReason: "something-new" }), []);
    expect(said.why).toContain("something-new");
  });

  test("the structured block wins over the reason text", () => {
    const said = explainTask(
      task({
        state: "ready",
        waitingReason: "report-missing",
        blockedBy: { kind: "dependency", ref: "T0" },
      }),
      [],
    );
    expect(said.why).toContain("T0");
  });
});

describe("explainDecision", () => {
  test("explains a known decision kind and falls back for old or future servers", () => {
    const base = decision({ category: "D1" });
    expect(explainDecision({ ...base, kind: "stuck-producer" }).why).toContain("生产者");
    expect(explainDecision({ ...base, kind: "quality-d3" }).why).toContain("质量");
    expect(explainDecision({ ...base, kind: "quality-d4" }).why).toContain("尝试");
    expect(explainDecision({ ...base, kind: "cancel" }).why).toContain("取消");
    expect(explainDecision({ ...base, kind: "other" })).toEqual(explainDecision(base));
    expect(explainDecision({ ...base, kind: "stuck-judge" }).why).toContain("判官");
    expect(explainDecision({ ...base, kind: "limbo-producer" }).why).toContain("报告");
    expect(explainDecision({ ...base, kind: "member-lost" }).why).toContain("关闭或归档");
    expect(explainDecision({ ...base, kind: "host-lost" }).why).toContain("宿主重启");
    expect(explainDecision({ ...base, kind: "evidence-stuck", actions: ["cancel"] }).why).toContain(
      "补证",
    );
    expect(explainDecision({ ...base, kind: "future-kind" })).toEqual(explainDecision(base));
    expect(explainDecision({ ...base, kind: "constructor" })).toEqual(explainDecision(base));
    expect(explainDecision({ ...base, actions: ["retry"] }).next).not.toContain("取消");
    expect(explainDecision({ ...base, actions: ["cancel"] }).next).not.toContain("丢掉");
    expect(
      explainDecision({ ...base, kind: "evidence-stuck", actions: ["cancel"] }).next,
    ).toContain("丢掉");
  });

  test("a pending decision with a retry says you can retry it here", () => {
    for (const category of ["D1", "D3", "D4"]) {
      const said = explainDecision(decision({ category }));
      expect(said.who).toBe("你");
      expect(said.next).toContain("重试");
    }
  });

  test("a pending decision that can only be cancelled says so, and why a retry is not offered", () => {
    const said = explainDecision(decision({ category: "D1", actions: ["cancel"] }));
    expect(said.who).toBe("你");
    expect(said.next).toContain("只能取消");
    expect(said.next).not.toContain("没有页面入口");
  });

  test("a pending decision without a retry says there is no entry for it here", () => {
    const said = explainDecision(decision({ category: "D5", actions: [] }));
    expect(said.who).toContain("没有页面入口");
    expect(said.why).toContain("D5");
  });

  test("an answered decision needs nothing more", () => {
    expect(explainDecision(decision({ state: "answered" })).who).toBe("已有结果");
  });
});

describe("alert explanations", () => {
  test.each(["open", "acknowledged"] as const)(
    "%s alerts retain the summary without guessing who can resolve them",
    (state) => {
      const said = explainAlert({ state, summary: "宿主‮读取失败" });
      expect(said.why).toBe("宿主读取失败");
      expect(said.who).toContain("判断");
      expect(said.next).toContain("告警内容");
    },
  );

  test("a resolved alert does not suggest that it still needs a response", () => {
    const said = explainAlert({ state: "resolved", summary: "问题已解除" });
    expect(said.why).toBe("问题已解除");
    expect(said.who).toBe("—");
    expect(said.next).toContain("已解除");
  });
});

describe("the causal timeline", () => {
  const intentStates = ["sending", "confirmed", "outcome-unknown", "failed"];

  test("every event kind the reducer and the counters write has words", () => {
    const kinds = [
      ...RUN_REDUCER_EVENT_KINDS,
      ...Object.values(RUN_COUNTER_EVENTS),
      ...intentStates.map((state) => `intent-${state}`),
    ];
    const missing = kinds.filter((kind) => !eventCause(kind).known);
    expect(missing).toEqual([]);
  });

  test("every audit kind written outside the reducer has words", () => {
    const files = [
      "shared/domain/run-engine/run-record.ts",
      "shared/domain/run-engine/decision-answer.ts",
      "shared/domain/run-engine/plan-repair.ts",
      "shared/domain/run-engine/replan.ts",
      "shared/domain/run-engine/report-repair.ts",
      "shared/domain/run-engine/run-alert.ts",
      "shared/domain/run-engine/task-note.ts",
      "shared/domain/run-engine/read-retry.ts",
      "server/run-engine/dag.ts",
    ];
    const kinds = new Set<string>();
    for (const file of files) {
      const text = read(file);
      for (const match of text.matchAll(/audit\(\w+,\s*"([a-z-]+)"/gu))
        kinds.add(match[1] as string);
      for (const match of text.matchAll(/seq,\s*kind: "([a-z-]+)"/gu))
        kinds.add(match[1] as string);
      for (const match of text.matchAll(/(?:EVENT|_EVENT) = "([a-z-]+)"/gu))
        kinds.add(match[1] as string);
    }
    expect(kinds.size).toBeGreaterThanOrEqual(10);
    expect([...kinds].filter((kind) => !eventCause(kind).known)).toEqual([]);
  });

  test("replan and cancellation events do not claim unproved sends or released claims", () => {
    const replan = eventCause("replan-requested").cause;
    const cancelled = eventCause("run-cancelled").cause;
    expect(replan).toContain("待发送");
    expect(replan).not.toContain("发了");
    expect(cancelled).toContain("可能");
    expect(cancelled).not.toContain("占用已释放");
  });

  test("a kind with no words falls back to the general sentence and keeps its own name", () => {
    const said = eventCause("brand-new-kind");
    expect(said.known).toBe(false);
    expect(said.label).toContain("brand-new-kind");
    expect(said.cause.length).toBeGreaterThan(5);
    for (const name of ["constructor", "__proto__", "toString"]) {
      expect(eventCause(name).known, name).toBe(false);
    }
  });

  test("the table has no inherited names and every entry has both parts", () => {
    for (const [kind, said] of Object.entries(EVENT_CAUSE_ZH)) {
      expect(said.label.length, kind).toBeGreaterThan(1);
      expect(said.cause.length, kind).toBeGreaterThan(5);
    }
  });

  test("history rows carry the cause, newest first, including for a kind nobody has words for", () => {
    const rows = historyRows([
      {
        events: [
          {
            seq: 1,
            kind: "task-dispatched",
            at: "2026-10-29T01:02:03.000Z",
            taskId: "T1",
            summary: "task-dispatched",
          },
          {
            seq: 2,
            kind: "from-the-future",
            at: "2026-10-29T01:02:04.000Z",
            taskId: null,
            summary: "from-the-future",
          },
        ],
        nextCursor: null,
      },
    ]);
    expect(rows.map((row) => row.seq)).toEqual([2, 1]);
    expect(rows[1]?.cause).toBe(EVENT_CAUSE_ZH["task-dispatched"]?.cause);
    expect(rows[0]?.cause).toContain("没有这类事件的说明");
  });
});

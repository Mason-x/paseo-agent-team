import { describe, expect, test } from "vitest";
import {
  cancelRunNotice,
  controlsOf,
  decideNotice,
  issueText,
  kickNotice,
  replanNotice,
  retryExplanation,
  transportNotice,
} from "../../shared/domain/run-engine/controls";
import { RUN_CONTRACT_VERSION, type RunDetailView } from "../../shared/schemas/run-engine/rpc";
import {
  RUN_ACTION_CODES,
  RUN_KICK_OUTCOMES,
  type RunKickOutput,
} from "../../shared/schemas/run-engine/rpc-actions";
import { runEngineZh as zh } from "../../shared/zh/run-engine";

const AT = "2026-10-29T01:02:03.000Z";
const DECISION = "6f1c2a44-3b7e-4f0a-9a11-000000000001";

type Decision = RunDetailView["decisions"][number];

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    decisionId: DECISION,
    category: "D3",
    state: "open",
    subjectId: "T1",
    summary: "质量阶梯已用完",
    createdAt: AT,
    answeredAction: null,
    actions: ["retry"],
    ...overrides,
  };
}

function run(
  overrides: { supportedControls?: string[]; decisions?: Decision[]; revision?: number } = {},
): Pick<RunDetailView, "revision" | "capabilities" | "decisions" | "tasks"> {
  return {
    revision: overrides.revision ?? 7,
    capabilities: {
      runEngine: 1,
      observationOnly: true,
      enabled: false,
      supportedControls: overrides.supportedControls ?? ["kick", "decide"],
    },
    decisions: overrides.decisions ?? [decision()],
    tasks: [
      {
        taskId: "T1",
        title: "Build the core",
        state: "failed",
        phase: null,
        level: "L2",
        tier: "B",
        execution: "write",
        assignee: null,
        attempts: 1,
        protocolFailures: 0,
        evidenceReturns: 0,
        reworkCount: 0,
        qualityFailures: 1,
        currentTier: "B",
        escalations: [],
        blockedBy: null,
        waitingReason: null,
        frozen: false,
      },
    ],
  };
}

describe("controlsOf: only what the server named is offered", () => {
  test("kick and a retry are offered when the server names kick and decide", () => {
    const view = controlsOf(run());
    expect(view).toMatchObject({ revision: 7, replan: false, kick: true, any: true });
    expect(view.retries).toHaveLength(1);
    expect(view.retries[0]).toMatchObject({
      decisionId: DECISION,
      category: "D3",
      subject: "Build the core",
    });
  });

  test("pause and resume are offered only when the server names them, and count as something to offer", () => {
    const none = controlsOf(run({ supportedControls: ["kick"] }));
    expect([none.pause, none.resume]).toEqual([false, false]);
    const active = controlsOf(run({ supportedControls: ["pause"] }));
    expect([active.pause, active.resume, active.any]).toEqual([true, false, true]);
    const paused = controlsOf(run({ supportedControls: ["resume"] }));
    expect([paused.pause, paused.resume, paused.any]).toEqual([false, true, true]);
  });

  test("a cancel is offered for a decision whose actions include it, and lists what goes with the task", () => {
    const withDag = {
      ...run({ decisions: [decision({ actions: ["retry", "cancel"] })] }),
      dag: {
        revision: 1,
        tasks: [
          { taskId: "T1", title: "Build the core", layer: 0, deps: [], state: "failed" },
          { taskId: "T2", title: "Use the core", layer: 1, deps: ["T1"], state: "pending" },
          { taskId: "T3", title: "Use the use", layer: 2, deps: ["T2"], state: "pending" },
          { taskId: "T4", title: "Elsewhere", layer: 0, deps: [], state: "pending" },
          { taskId: "T5", title: "Already gone", layer: 1, deps: ["T1"], state: "cancelled" },
        ],
      },
    };
    const view = controlsOf(withDag);
    expect(view.cancels).toHaveLength(1);
    expect(view.cancels[0]).toMatchObject({
      decisionId: DECISION,
      subject: "Build the core",
      downstream: ["Use the core", "Use the use"],
      explain: zh.controls.cancelTask.explain,
    });
    expect(view.any).toBe(true);
    // Without the server naming `decide`, or without `cancel` among the decision's actions, nothing.
    expect(
      controlsOf({
        ...withDag,
        capabilities: { ...withDag.capabilities, supportedControls: ["kick"] },
      }).cancels,
    ).toEqual([]);
    expect(controlsOf(run({ decisions: [decision({ actions: ["retry"] })] })).cancels).toEqual([]);
    // A decision that can only be cancelled offers no retry.
    const only = controlsOf(run({ decisions: [decision({ actions: ["cancel"] })] }));
    expect([only.retries.length, only.cancels.length]).toEqual([0, 1]);
    expect(only.cancels[0]?.downstream).toEqual([]);
  });

  test("cancelling the Run is offered only when the server names it, and counts as something to offer", () => {
    const none = controlsOf(run({ supportedControls: ["kick"] }));
    expect(none.cancelRun).toBe(false);
    const named = controlsOf(run({ supportedControls: ["cancel"], decisions: [] }));
    expect([named.cancelRun, named.any]).toEqual([true, true]);
  });

  test("a budget is offered per seat, only when the server names it, and says what is reserved", () => {
    const withBudgets = {
      ...run({ supportedControls: ["budget"], decisions: [] }),
      budgets: [
        {
          scope: "seat" as const,
          subjectId: "seat-b1",
          limit: 2,
          reserved: 2,
          confirmed: 1,
          observedTurns: 1,
        },
        {
          scope: "seat" as const,
          subjectId: "seat-b2",
          limit: 6,
          reserved: 1,
          confirmed: 0,
          observedTurns: 0,
        },
        {
          scope: "group" as const,
          subjectId: "grp",
          limit: 9,
          reserved: 9,
          confirmed: 0,
          observedTurns: 0,
        },
      ],
    };
    const view = controlsOf(withBudgets);
    expect(view.budgets.map((offer) => offer.seatId)).toEqual(["seat-b1", "seat-b2"]);
    expect(view.budgets[0]).toMatchObject({
      exhausted: true,
      limit: 2,
      line: zh.controls.budget.line("seat-b1", 2, 2),
      reason: zh.controls.budget.reason("seat-b1"),
    });
    expect(view.budgets[1]?.exhausted).toBe(false);
    expect(view.any).toBe(true);
    expect(
      controlsOf({
        ...withBudgets,
        capabilities: { ...withBudgets.capabilities, supportedControls: ["kick"] },
      }).budgets,
    ).toEqual([]);
  });

  test("replan is offered only when the server names it", () => {
    expect(controlsOf(run({ supportedControls: ["kick"] })).replan).toBe(false);
    expect(controlsOf(run({ supportedControls: ["replan", "kick"] })).replan).toBe(true);
  });

  test("nothing is offered for a Run that names no control, and the view says so", () => {
    const view = controlsOf(run({ supportedControls: [] }));
    expect(view).toEqual({
      revision: 7,
      replan: false,
      kick: false,
      pause: false,
      resume: false,
      cancelRun: false,
      budgets: [],
      retries: [],
      cancels: [],
      any: false,
    });
  });

  test("a retry needs both `decide` in the Run's controls and `retry` in the decision's own actions", () => {
    expect(controlsOf(run({ supportedControls: ["kick"] })).retries).toEqual([]);
    expect(controlsOf(run({ decisions: [decision({ actions: [] })] })).retries).toEqual([]);
    // An older server sends no `actions` at all.
    const { actions: _drop, ...bare } = decision();
    expect(controlsOf(run({ decisions: [bare as Decision] })).retries).toEqual([]);
  });

  test("an answered or superseded decision is never offered", () => {
    for (const state of ["answered", "superseded"] as const) {
      expect(controlsOf(run({ decisions: [decision({ state })] })).retries).toEqual([]);
    }
    expect(
      controlsOf(run({ decisions: [decision({ state: "waiting-human" })] })).retries,
    ).toHaveLength(1);
  });

  test("the subject falls back to the task id, and to nothing for a decision without one", () => {
    const view = controlsOf(
      run({
        decisions: [
          decision({ subjectId: "T9" }),
          decision({ decisionId: `${DECISION.slice(0, -1)}2`, subjectId: null }),
        ],
      }),
    );
    expect(view.retries.map((entry) => entry.subject)).toEqual(["T9", null]);
  });

  test("server text is cleaned before it is shown", () => {
    const view = controlsOf(
      run({ decisions: [decision({ summary: "**x**\n‮<b>", subjectId: "T1" })] }),
    );
    expect(view.retries[0]?.summary).toBe("**x** <b>");
  });
});

describe("what a retry will do is said per kind of decision", () => {
  test("D1, D3 and D4 each have their own sentence, and anything else a general one", () => {
    const sentences = ["D1", "D3", "D4"].map((category) => retryExplanation(category));
    expect(new Set(sentences).size).toBe(3);
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(30);
    expect(retryExplanation("D9")).toBe(zh.controls.retry.explainOther);
    expect(retryExplanation("constructor")).toBe(zh.controls.retry.explainOther);
  });

  test("the server's decision kind distinguishes the retry and unknown kinds fall back", () => {
    const producer = retryExplanation("D1", "stuck-producer");
    const judge = retryExplanation("D1", "stuck-judge");
    const missing = retryExplanation("D1", "limbo-producer");
    expect(producer).toContain("生产者");
    expect(retryExplanation("D3", "quality-d3")).toContain("返工");
    expect(retryExplanation("D4", "quality-d4")).toContain("返工");
    expect(judge).toContain("判官");
    expect(missing).toContain("报告");
    expect(new Set([producer, judge, missing]).size).toBe(3);
    expect(retryExplanation("D1", "future-kind")).toBe(retryExplanation("D1"));
    expect(retryExplanation("D1", "constructor")).toBe(retryExplanation("D1"));
    const view = controlsOf(
      run({ decisions: [decision({ category: "D1", kind: "stuck-judge" })] }),
    );
    expect(view.retries[0]?.explain).toBe(judge);
  });

  test("the explanation is attached to the offer, and so is the reason sent with the request", () => {
    for (const category of ["D1", "D3", "D4"]) {
      const [offer] = controlsOf(run({ decisions: [decision({ category })] })).retries;
      expect(offer?.explain).toBe(retryExplanation(category));
      expect(offer?.reason).toContain(category);
    }
  });
});

describe("what is said about a cancellation", () => {
  const base = {
    runContractVersion: 1 as const,
    revision: 5,
    lifecycle: "paused",
    issues: [],
  };

  test("done at once, still waiting, repeated and refused each have their own words", () => {
    expect(cancelRunNotice({ ...base, status: "applied", waiting: null })).toEqual({
      tone: "success",
      text: zh.controls.cancelRun.done,
      refresh: true,
    });
    const waiting = cancelRunNotice({
      ...base,
      status: "applied",
      waiting: { turns: 2, deliveries: 1 },
    });
    expect(waiting).toMatchObject({ tone: "warning", refresh: true });
    expect(waiting.text).toBe(zh.controls.cancelRun.waiting(2, 1));
    expect(waiting.text).toContain("2");
    expect(cancelRunNotice({ ...base, status: "replayed", waiting: null }).text).toBe(
      zh.controls.result.replayed,
    );
    const refused = cancelRunNotice({
      ...base,
      status: "rejected",
      waiting: null,
      issues: [{ code: "cancel-pending", severity: "error", path: [], params: {}, action: "none" }],
    });
    expect(refused.tone).toBe("danger");
    expect(refused.text).toContain("请求取消");
  });
});

describe("every refusal code of the controls has words", () => {
  test.each(RUN_ACTION_CODES)("%s", (code) => {
    const text = issueText({ code, params: {} });
    expect(text.length).toBeGreaterThan(4);
    expect(text).not.toContain("原因代码");
    expect(text).not.toContain("undefined");
  });

  test("the codes use their parameters when they have them", () => {
    expect(issueText({ code: "revision-conflict", params: { current: 12 } })).toContain("12");
    expect(issueText({ code: "run-not-active", params: { lifecycle: "paused" } })).toContain(
      zh.lifecycle.paused as string,
    );
    expect(
      issueText({ code: "lifecycle-not-allowed", params: { lifecycle: "finished" } }),
    ).toContain(zh.lifecycle.finished as string);
    expect(issueText({ code: "replan-not-allowed", params: { lifecycle: "active" } })).toContain(
      zh.lifecycle.active as string,
    );
    expect(
      issueText({ code: "task-not-releasable", params: { reason: "effects-unsettled" } }),
    ).toContain("送达");
    expect(issueText({ code: "decision-not-answerable", params: { category: "D5" } })).toContain(
      "D5",
    );
  });

  test("a code this client does not know is still said, by its code", () => {
    expect(issueText({ code: "something-new", params: {} })).toBe(
      zh.controls.result.unknownCode("something-new"),
    );
    // Names that live on every object are not codes.
    expect(issueText({ code: "constructor", params: {} })).toBe(
      zh.controls.result.unknownCode("constructor"),
    );
  });

  test("a parameter of an unexpected type does not break the sentence", () => {
    expect(issueText({ code: "revision-conflict", params: { current: "x" } })).not.toContain("x版");
    expect(issueText({ code: "task-not-releasable", params: { reason: "brand-new" } })).toContain(
      "brand-new",
    );
  });
});

describe("what is said about an answer", () => {
  const BASE = { runContractVersion: RUN_CONTRACT_VERSION } as const;
  const issue = (code: string, params: Record<string, string | number | boolean> = {}) => ({
    code,
    severity: "error" as const,
    path: [],
    params,
    action: "none" as const,
  });

  test("applied, replayed and rejected replan", () => {
    expect(replanNotice({ ...BASE, status: "applied", revision: 8, epoch: 2, issues: [] })).toEqual(
      { tone: "success", text: zh.controls.result.applied, refresh: true },
    );
    expect(
      replanNotice({ ...BASE, status: "replayed", revision: 8, epoch: 2, issues: [] }),
    ).toEqual({ tone: "neutral", text: zh.controls.result.replayed, refresh: true });
    const refused = replanNotice({
      ...BASE,
      status: "rejected",
      revision: 0,
      epoch: null,
      issues: [issue("plan-request-missing")],
    });
    expect(refused).toMatchObject({ tone: "danger", refresh: true });
    expect(refused.text).toBe(issueText({ code: "plan-request-missing", params: {} }));
  });

  test("a revision conflict is a warning that asks for another look, and the Run is read again", () => {
    const notice = replanNotice({
      ...BASE,
      status: "rejected",
      revision: 0,
      epoch: null,
      issues: [issue("revision-conflict", { current: 9 })],
    });
    expect(notice).toMatchObject({ tone: "warning", refresh: true });
    expect(notice.text).toContain("9");
    expect(notice.text).toContain("再试");
  });

  test("a decision answer says the same things", () => {
    const base = { ...BASE, revision: 4, decisionId: DECISION, taskId: "T1" };
    expect(decideNotice({ ...base, status: "applied", issues: [] }).tone).toBe("success");
    expect(decideNotice({ ...base, status: "replayed", issues: [] }).text).toBe(
      zh.controls.result.replayed,
    );
    expect(
      decideNotice({
        ...base,
        status: "rejected",
        issues: [issue("task-not-releasable", { reason: "actors-unsettled" })],
      }).text,
    ).toContain("回合");
  });

  test("when several issues come back the first error is the one said", () => {
    const notice = decideNotice({
      ...BASE,
      status: "rejected",
      revision: 0,
      decisionId: DECISION,
      taskId: null,
      issues: [{ ...issue("run-not-active"), severity: "warning" }, issue("decision-answered")],
    });
    expect(notice.text).toBe(issueText({ code: "decision-answered", params: {} }));
  });

  test("a rejected answer with no issue still says something", () => {
    const notice = decideNotice({
      ...BASE,
      status: "rejected",
      revision: 0,
      decisionId: DECISION,
      taskId: null,
      issues: [],
    });
    expect(notice.text.length).toBeGreaterThan(0);
  });

  test.each(RUN_KICK_OUTCOMES)("kick outcome %s", (outcome) => {
    const output: RunKickOutput = {
      ...BASE,
      status: "ok",
      outcome,
      dispatched: outcome === "dispatched" ? 2 : 0,
      revision: 3,
      reason: outcome === "blocked" ? "dispatch-blocked:workspace-dirty" : null,
      issues: [],
    };
    const notice = kickNotice(output);
    expect(notice.text.length).toBeGreaterThan(0);
    expect(notice.refresh).toBe(true);
    if (outcome === "dispatched") expect(notice.text).toContain("2");
    if (outcome === "blocked") expect(notice.text).toContain("workspace-dirty");
  });

  test("a kick with no outcome is treated as nothing due, and a rejected kick says why", () => {
    expect(
      kickNotice({
        ...BASE,
        status: "ok",
        outcome: null,
        dispatched: 0,
        revision: 1,
        reason: null,
        issues: [],
      }).text,
    ).toBe(zh.controls.result.kick.idle);
    expect(
      kickNotice({
        ...BASE,
        status: "rejected",
        outcome: null,
        dispatched: 0,
        revision: 0,
        reason: null,
        issues: [issue("run-missing")],
      }).text,
    ).toBe(issueText({ code: "run-missing", params: {} }));
  });

  test("a request that never got an answer does not ask for a refresh", () => {
    expect(transportNotice()).toEqual({
      tone: "warning",
      text: zh.controls.result.transport,
      refresh: false,
    });
  });
});

describe("the page no longer claims to be read-only", () => {
  test("the copy table has no read-only banner left, and the list hint names what can be done", () => {
    expect(Object.hasOwn(zh, "readOnly")).toBe(false);
    expect(zh.list.controlsHint).toContain("重试");
    expect(zh.list.controlsHint).toContain("取消");
  });
});

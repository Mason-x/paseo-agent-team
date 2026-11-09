import { describe, expect, test, vi } from "vitest";
import {
  type ControlDeps,
  type ControlState,
  createControlRunner,
  newRequestId,
} from "../../client/runs/engine/control-runner";
import { controlsOf, type RetryOffer } from "../../shared/domain/run-engine/controls";
import { RUN_CONTRACT_VERSION } from "../../shared/schemas/run-engine/rpc";
import type {
  RunBudgetOutput,
  RunCancelOutput,
  RunDecideOutput,
  RunKickOutput,
  RunLifecycleOutput,
  RunReplanOutput,
} from "../../shared/schemas/run-engine/rpc-actions";
import { runEngineZh as zh } from "../../shared/zh/run-engine";

const BASE = { runContractVersion: RUN_CONTRACT_VERSION } as const;
const DECISION = "6f1c2a44-3b7e-4f0a-9a11-000000000001";

const offer: RetryOffer = {
  decisionId: DECISION,
  category: "D3",
  categoryLabel: "D3 S 层仍失败",
  subject: "Build the core",
  summary: "x",
  explain: "y",
  reason: zh.controls.retry.reason("D3"),
};

const lifecycle = (state: string): RunLifecycleOutput => ({
  ...BASE,
  status: "applied",
  revision: 6,
  lifecycle: state,
  issues: [],
});

const cancelled = (waiting: RunCancelOutput["waiting"] = null): RunCancelOutput => ({
  ...BASE,
  status: "applied",
  revision: 6,
  lifecycle: "cancelled",
  waiting,
  issues: [],
});

const raised = (limit = 7): RunBudgetOutput => ({
  ...BASE,
  status: "applied",
  revision: 6,
  seatId: "seat-b1",
  limit,
  issues: [],
});

const applied = (): RunReplanOutput => ({
  ...BASE,
  status: "applied",
  revision: 5,
  epoch: 2,
  issues: [],
});

function setup(overrides: Partial<ControlDeps> = {}) {
  let counter = 0;
  const states: ControlState[] = [];
  const deps: ControlDeps = {
    runId: "run-ctl-a1",
    replan: vi.fn(async () => applied()),
    decide: vi.fn(
      async (): Promise<RunDecideOutput> => ({
        ...BASE,
        status: "applied",
        revision: 5,
        decisionId: DECISION,
        taskId: "T1",
        issues: [],
      }),
    ),
    kick: vi.fn(
      async (): Promise<RunKickOutput> => ({
        ...BASE,
        status: "ok",
        outcome: "idle",
        dispatched: 0,
        revision: 5,
        reason: null,
        issues: [],
      }),
    ),
    pause: vi.fn(async () => lifecycle("paused")),
    resume: vi.fn(async () => lifecycle("active")),
    cancel: vi.fn(async () => cancelled()),
    budget: vi.fn(async () => raised()),
    refresh: vi.fn(async () => undefined),
    newId: () => {
      counter += 1;
      return `req-${counter}`;
    },
    ...overrides,
  };
  const runner = createControlRunner(deps, (state) => states.push(state));
  return { runner, deps, states };
}

const conflict = {
  ...BASE,
  status: "rejected" as const,
  revision: 0,
  epoch: null,
  issues: [
    {
      code: "revision-conflict",
      severity: "error" as const,
      path: [],
      params: { current: 9 },
      action: "refresh" as const,
    },
  ],
};

describe("request ids", () => {
  test("uses the platform UUID when available", () => {
    const randomUUID = vi.fn(() => "6f1c2a44-3b7e-4f0a-9a11-000000000001");
    vi.stubGlobal("crypto", { randomUUID });
    try {
      expect(newRequestId()).toBe("6f1c2a44-3b7e-4f0a-9a11-000000000001");
      expect(randomUUID).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("uses random bytes for a version 4 UUID when randomUUID is unavailable", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.forEach((_, index) => {
        bytes[index] = index;
      });
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues });
    try {
      expect(newRequestId()).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
      expect(getRandomValues).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("uses a version 4 UUID even when the platform has no crypto", () => {
    vi.stubGlobal("crypto", undefined);
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      expect(newRequestId()).toBe("00000000-0000-4000-8000-000000000000");
      random.mockReturnValue(0.5);
      expect(newRequestId()).toBe("80808080-8080-4080-8080-808080808080");
    } finally {
      random.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe("replan", () => {
  test("sends the reason, the revision that was read and a request id, then reads the Run again", async () => {
    const { runner, deps } = setup();
    expect(await runner.replan("  the plan missed the API  ", 7)).toBe(true);
    expect(deps.replan).toHaveBeenCalledWith({
      runContractVersion: RUN_CONTRACT_VERSION,
      runId: "run-ctl-a1",
      requestId: "req-1",
      expectedRevision: 7,
      reason: "the plan missed the API",
    });
    expect(deps.refresh).toHaveBeenCalledTimes(1);
    expect(runner.state).toEqual({
      pending: null,
      notice: { tone: "success", text: zh.controls.result.applied, refresh: true },
    });
  });

  test("a blank reason sends nothing and changes nothing", async () => {
    const { runner, deps, states } = setup();
    expect(await runner.replan("   ", 7)).toBe(false);
    expect(deps.replan).not.toHaveBeenCalled();
    expect(states).toEqual([]);
  });

  test("a reason longer than the contract allows is cut, not refused", async () => {
    const { runner, deps } = setup();
    await runner.replan("长".repeat(900), 1);
    const sent = vi.mocked(deps.replan).mock.calls[0]?.[0];
    expect(sent?.reason).toHaveLength(600);
  });

  test("a revision conflict reads the Run again and asks for another look", async () => {
    const { runner, deps } = setup({ replan: vi.fn(async () => conflict) });
    await runner.replan("again", 7);
    expect(deps.refresh).toHaveBeenCalledTimes(1);
    expect(runner.state.notice).toMatchObject({ tone: "warning", refresh: true });
    expect(runner.state.notice?.text).toContain("9");
  });

  test("replayed says it was already submitted", async () => {
    const { runner } = setup({
      replan: vi.fn(async () => ({ ...applied(), status: "replayed" as const })),
    });
    await runner.replan("again", 7);
    expect(runner.state.notice?.text).toBe(zh.controls.result.replayed);
  });
});

describe("retry", () => {
  test("answers the decision with retry, the reason for its kind, and the revision read", async () => {
    const { runner, deps } = setup();
    await runner.retry(offer, 7);
    expect(deps.decide).toHaveBeenCalledWith({
      runContractVersion: RUN_CONTRACT_VERSION,
      runId: "run-ctl-a1",
      requestId: "req-1",
      expectedRevision: 7,
      reason: offer.reason,
      decisionId: DECISION,
      answer: { action: "retry" },
    });
    expect(deps.refresh).toHaveBeenCalledTimes(1);
  });

  test("the offer comes from the Run's own controls", () => {
    const view = controlsOf({
      revision: 7,
      capabilities: {
        runEngine: 1,
        observationOnly: true,
        enabled: false,
        supportedControls: ["decide"],
      },
      decisions: [
        {
          decisionId: DECISION,
          category: "D1",
          state: "open",
          subjectId: null,
          summary: "stuck",
          createdAt: "2026-10-29T01:02:03.000Z",
          answeredAction: null,
          actions: ["retry"],
        },
      ],
      tasks: [],
    });
    expect(view.retries[0]?.decisionId).toBe(DECISION);
  });
});

describe("kick", () => {
  test("sends only the run id and says what happened", async () => {
    const { runner, deps } = setup({
      kick: vi.fn(async () => ({
        ...BASE,
        status: "ok" as const,
        outcome: "dispatched" as const,
        dispatched: 1,
        revision: 6,
        reason: null,
        issues: [],
      })),
    });
    await runner.kick();
    expect(deps.kick).toHaveBeenCalledWith({
      runContractVersion: RUN_CONTRACT_VERSION,
      runId: "run-ctl-a1",
    });
    expect(runner.state.notice?.text).toBe(zh.controls.result.kick.dispatched(1));
  });
});

describe("adding turns to a seat", () => {
  const offer = {
    seatId: "seat-b1",
    line: "x",
    reserved: 2,
    limit: 2,
    exhausted: true,
    reason: zh.controls.budget.reason("seat-b1"),
  };

  test("sends the seat, the number of turns and the revision the page read, and says the new limit", async () => {
    const { runner, deps } = setup();
    expect(await runner.addBudget(offer, 4, 9)).toBe(true);
    expect(deps.budget).toHaveBeenCalledWith({
      runContractVersion: RUN_CONTRACT_VERSION,
      runId: "run-ctl-a1",
      requestId: "req-1",
      expectedRevision: 9,
      reason: offer.reason,
      seatId: "seat-b1",
      by: 4,
    });
    expect(runner.state.notice?.text).toBe(zh.controls.budget.applied("seat-b1", 7));
    expect(deps.refresh).toHaveBeenCalledTimes(1);
  });

  test.each([0, 65, 1.5, Number.NaN])("%s turns are not sent", async (by) => {
    const { runner, deps } = setup();
    expect(await runner.addBudget(offer, by, 9)).toBe(false);
    expect(deps.budget).not.toHaveBeenCalled();
  });

  test("a request that got no answer is asked again under the same id; another number is another request", async () => {
    const budget = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(raised());
    const { runner } = setup({ budget });
    await runner.addBudget(offer, 4, 9);
    expect(runner.state.notice?.text).toBe(zh.controls.result.transport);
    await runner.addBudget(offer, 4, 9);
    await runner.addBudget(offer, 8, 9);
    expect(budget.mock.calls.map((call) => call[0].requestId)).toEqual(["req-1", "req-1", "req-2"]);
  });
});

describe("cancelling the Run", () => {
  test("a reason is needed; the written one is sent under the revision the page read", async () => {
    const { runner, deps } = setup();
    expect(await runner.cancelRun("   ", 9)).toBe(false);
    expect(deps.cancel).not.toHaveBeenCalled();
    expect(await runner.cancelRun("  the plan is wrong ", 9)).toBe(true);
    expect(deps.cancel).toHaveBeenCalledWith({
      runContractVersion: RUN_CONTRACT_VERSION,
      runId: "run-ctl-a1",
      requestId: "req-1",
      expectedRevision: 9,
      reason: "the plan is wrong",
    });
    expect(runner.state.notice?.text).toBe(zh.controls.cancelRun.done);
    expect(deps.refresh).toHaveBeenCalledTimes(1);
  });

  test("says what it waits for, and asks again under the same id after a request that got no answer", async () => {
    const cancel = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(cancelled({ turns: 1, deliveries: 0 }));
    const { runner } = setup({ cancel });
    await runner.cancelRun("stop", 9);
    expect(runner.state.notice?.text).toBe(zh.controls.result.transport);
    await runner.cancelRun("stop", 9);
    expect(runner.state.notice?.text).toBe(zh.controls.cancelRun.waiting(1, 0));
    expect(cancel.mock.calls.map((call) => call[0].requestId)).toEqual(["req-1", "req-1"]);
    await runner.cancelRun("another reason", 9);
    expect(cancel.mock.calls.at(-1)?.[0].requestId).toBe("req-2");
  });
});

describe("cancelling a task", () => {
  const cancelOffer = {
    decisionId: DECISION,
    category: "D4",
    categoryLabel: "D4",
    subject: "Build the core",
    summary: "x",
    downstream: ["Use the core"],
    explain: "y",
    reason: zh.controls.cancelTask.reason("D4"),
  };

  test("answers the decision with cancel, under the revision the page read, and says it was done", async () => {
    const { runner, deps } = setup();
    expect(await runner.cancelTask(cancelOffer, 9)).toBe(true);
    expect(deps.decide).toHaveBeenCalledWith({
      runContractVersion: RUN_CONTRACT_VERSION,
      runId: "run-ctl-a1",
      requestId: "req-1",
      expectedRevision: 9,
      reason: cancelOffer.reason,
      decisionId: DECISION,
      answer: { action: "cancel" },
    });
    expect(runner.state.notice?.tone).toBe("success");
    expect(deps.refresh).toHaveBeenCalledTimes(1);
  });

  test("a retry and a cancel of the same decision at the same revision are different requests", async () => {
    const { runner, deps } = setup();
    await runner.retry(offer, 9);
    await runner.cancelTask(cancelOffer, 9);
    const ids = vi.mocked(deps.decide).mock.calls.map((call) => call[0].requestId);
    expect(new Set(ids).size).toBe(2);
  });

  test("a request that got no answer is asked again under the same id", async () => {
    const decide = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({
        ...BASE,
        status: "applied",
        revision: 6,
        decisionId: DECISION,
        taskId: "T1",
        issues: [],
      });
    const { runner } = setup({ decide });
    await runner.cancelTask(cancelOffer, 9);
    expect(runner.state.notice?.text).toBe(zh.controls.result.transport);
    await runner.cancelTask(cancelOffer, 9);
    expect(decide.mock.calls.map((call) => call[0].requestId)).toEqual(["req-1", "req-1"]);
  });
});

describe("pause and resume", () => {
  test.each(["pause", "resume"] as const)(
    "%s sends the revision the page read and a reason the page wrote",
    async (name) => {
      const { runner, deps, states } = setup();
      expect(await runner[name](9)).toBe(true);
      expect(deps[name]).toHaveBeenCalledWith({
        runContractVersion: RUN_CONTRACT_VERSION,
        runId: "run-ctl-a1",
        requestId: "req-1",
        expectedRevision: 9,
        reason: zh.controls[name].reason,
      });
      expect(runner.state.notice).toEqual({
        tone: "success",
        text: zh.controls[name].applied,
        refresh: true,
      });
      expect(deps.refresh).toHaveBeenCalledTimes(1);
      expect(states.some((entry) => entry.pending === name)).toBe(true);
    },
  );

  test("a request that got no answer is asked again under the same id; a new revision is a new request", async () => {
    const pause = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(lifecycle("paused"));
    const { runner } = setup({ pause });
    await runner.pause(9);
    expect(runner.state.notice?.text).toBe(zh.controls.result.transport);
    await runner.pause(9);
    await runner.pause(10);
    expect(pause.mock.calls.map((call) => call[0].requestId)).toEqual(["req-1", "req-1", "req-2"]);
  });

  test("a refusal is said in words and the Run is read again", async () => {
    const { runner, deps } = setup({
      pause: vi.fn(async () => ({
        ...lifecycle("paused"),
        status: "rejected" as const,
        issues: [
          {
            code: "lifecycle-not-allowed",
            severity: "error" as const,
            path: [],
            params: { lifecycle: "paused" },
            action: "none" as const,
          },
        ],
      })),
    });
    await runner.pause(9);
    expect(runner.state.notice?.tone).toBe("danger");
    expect(runner.state.notice?.text).toContain(zh.lifecycle.paused as string);
    expect(deps.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("one control at a time", () => {
  test("a second press while one is in flight does nothing", async () => {
    let release!: (output: RunReplanOutput) => void;
    const { runner, deps } = setup({
      replan: vi.fn(
        () =>
          new Promise<RunReplanOutput>((resolve) => {
            release = resolve;
          }),
      ),
    });
    const first = runner.replan("reason", 7);
    expect(runner.state.pending).toBe("replan");
    // Another control, the same control, in the same frame: all refused.
    expect(await runner.kick()).toBe(false);
    expect(await runner.replan("reason", 7)).toBe(false);
    expect(await runner.retry(offer, 7)).toBe(false);
    expect(deps.kick).not.toHaveBeenCalled();
    expect(deps.replan).toHaveBeenCalledTimes(1);
    release(applied());
    expect(await first).toBe(true);
    expect(runner.state.pending).toBeNull();
  });

  test("the pending key names the control, so only that button reads as busy", async () => {
    let release!: (output: RunDecideOutput) => void;
    const { runner } = setup({
      decide: vi.fn(
        () =>
          new Promise<RunDecideOutput>((resolve) => {
            release = resolve;
          }),
      ),
    });
    const running = runner.retry(offer, 7);
    expect(runner.state.pending).toBe(`decide:${DECISION}`);
    release({
      ...BASE,
      status: "applied",
      revision: 8,
      decisionId: DECISION,
      taskId: "T1",
      issues: [],
    });
    await running;
  });

  test("a new press clears the last notice", async () => {
    const { runner } = setup();
    await runner.kick();
    expect(runner.state.notice).not.toBeNull();
    const running = runner.kick();
    expect(runner.state.notice).toBeNull();
    await running;
  });
});

describe("a request that never got an answer", () => {
  test("says so, does not read the Run again, and asking again is the same request", async () => {
    const replan = vi
      .fn<ControlDeps["replan"]>()
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValueOnce({ ...applied(), status: "replayed" });
    const { runner, deps } = setup({ replan });
    await runner.replan("reason", 7);
    expect(runner.state).toEqual({
      pending: null,
      notice: { tone: "warning", text: zh.controls.result.transport, refresh: false },
    });
    expect(deps.refresh).not.toHaveBeenCalled();

    await runner.replan("reason", 7);
    const ids = replan.mock.calls.map((call) => call[0].requestId);
    expect(ids).toEqual(["req-1", "req-1"]);
    expect(runner.state.notice?.text).toBe(zh.controls.result.replayed);
  });

  test("another reason, or another revision, is another request", async () => {
    const replan = vi.fn<ControlDeps["replan"]>().mockRejectedValue(new Error("down"));
    const { runner } = setup({ replan });
    await runner.replan("one", 7);
    await runner.replan("two", 7);
    await runner.replan("one", 8);
    expect(replan.mock.calls.map((call) => call[0].requestId)).toEqual(["req-1", "req-2", "req-3"]);
  });

  test("once the server answered, the same press is a new request", async () => {
    const { runner, deps } = setup();
    await runner.replan("reason", 7);
    await runner.replan("reason", 7);
    expect(vi.mocked(deps.replan).mock.calls.map((call) => call[0].requestId)).toEqual([
      "req-1",
      "req-2",
    ]);
  });

  test("a failed refresh does not undo the answer", async () => {
    const { runner } = setup({
      refresh: vi.fn(async () => Promise.reject(new Error("read failed"))),
    });
    await runner.replan("reason", 7);
    expect(runner.state.notice?.text).toBe(zh.controls.result.applied);
    expect(runner.state.pending).toBeNull();
  });
});

describe("dismiss", () => {
  test("clears the notice and nothing else", async () => {
    const { runner } = setup();
    await runner.kick();
    runner.dismiss();
    expect(runner.state).toEqual({ pending: null, notice: null });
  });
});

/** The two controls that carry a reason the person wrote, with what each asks of its RPC. */
const REASON_CONTROLS = [
  {
    name: "replan",
    field: "replan" as const,
    deps: (answer: () => Promise<never>): Partial<ControlDeps> => ({ replan: vi.fn(answer) }),
    send: (runner: ReturnType<typeof createControlRunner>) => runner.replan("缺少 API", 7),
    rpc: (deps: ControlDeps) => deps.replan,
    answered: (status: "applied" | "replayed" | "rejected") =>
      (status === "rejected" ? conflict : { ...applied(), status }) as never,
  },
  {
    name: "cancel",
    field: "cancel-run" as const,
    deps: (answer: () => Promise<never>): Partial<ControlDeps> => ({ cancel: vi.fn(answer) }),
    send: (runner: ReturnType<typeof createControlRunner>) => runner.cancelRun("缺少 API", 7),
    rpc: (deps: ControlDeps) => deps.cancel,
    answered: (status: "applied" | "replayed" | "rejected") =>
      (status === "rejected" ? conflict : { ...cancelled(), status }) as never,
  },
];

describe.each(REASON_CONTROLS)(
  "telling the page the server took the reason of $name",
  (control) => {
    test.each(["applied", "replayed"] as const)(
      "a %s answer tells the page once, with the field",
      async (status) => {
        const accepted = vi.fn();
        const { runner } = setup({
          ...control.deps(async () => control.answered(status)),
          accepted,
        });
        await control.send(runner);
        expect(accepted).toHaveBeenCalledExactlyOnceWith(control.field);
      },
    );

    test("a refusal does not: the words are kept for another try", async () => {
      const accepted = vi.fn();
      const { runner } = setup({
        ...control.deps(async () => control.answered("rejected")),
        accepted,
      });
      await control.send(runner);
      expect(accepted).not.toHaveBeenCalled();
    });

    test("a request that got no answer does not, and asking again under the same id does once it is answered", async () => {
      const accepted = vi.fn();
      let reachable = false;
      const { runner, deps } = setup({
        ...control.deps(async () => {
          if (!reachable) throw new Error("network down");
          return control.answered("applied");
        }),
        accepted,
      });
      await control.send(runner);
      expect(runner.state.notice).toMatchObject({ refresh: false });
      expect(accepted).not.toHaveBeenCalled();

      reachable = true;
      await control.send(runner);
      expect(accepted).toHaveBeenCalledExactlyOnceWith(control.field);
      const ids = vi
        .mocked(control.rpc(deps))
        .mock.calls.map((call) => (call[0] as { requestId: string }).requestId);
      expect(ids).toHaveLength(2);
      expect(ids[0]).toBe(ids[1]);
    });
  },
);

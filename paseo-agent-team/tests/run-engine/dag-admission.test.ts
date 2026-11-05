import { describe, expect, test } from "vitest";
import { sha256Hex } from "../../server/run-engine/digest";
import {
  COORDINATOR_SEAT_ID,
  checkDag,
  type DagCheckInput,
  describeIssues,
  REPO_ALIAS,
  readDagControl,
  withDagControl,
} from "../../shared/domain/run-engine/dag-admission";
import { reduceRun } from "../../shared/domain/run-engine/reducer";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import type { RunTaskDagBlock } from "../../shared/schemas/run-engine/protocol";
import { REPO_ID } from "../fixtures/run-engine/base";
import {
  bootstrapRun,
  COORDINATOR_AGENT,
  DAG_NONCE,
  dagBlock,
  planTasks,
} from "./support/bootstrap-run";

/**
 * Failure modes this file guards: a plan the Run could never execute being accepted (and freezing
 * halfway), a plan from anyone but the coordinator, with a used or wrong nonce, or for another Run,
 * being accepted, and a plan that names a repository or path it should not.
 */

type Task = RunTaskDagBlock["tasks"][number];

function input(overrides: Partial<DagCheckInput> = {}): DagCheckInput {
  return {
    agentId: COORDINATOR_AGENT,
    canonicalRepoId: REPO_ID,
    nonceDigest: sha256Hex(DAG_NONCE),
    seatFamilies: new Map([
      ["seat-b1", "haiku"],
      ["seat-b2", "luna"],
    ]),
    ...overrides,
  };
}

function codes(
  mutateRecord: (record: RunRecord) => void = () => undefined,
  mutateTasks: (tasks: Task[]) => void = () => undefined,
  overrides: Record<string, unknown> = {},
  checkInput: DagCheckInput = input(),
): string[] {
  const record = bootstrapRun({ runId: "run-dag001-a1" });
  mutateRecord(record);
  const tasks = planTasks();
  mutateTasks(tasks);
  const block = dagBlock("run-dag001-a1", tasks, overrides);
  // The caller digests the nonce the block really carries.
  const result = checkDag(record, block, { ...checkInput, nonceDigest: sha256Hex(block.nonce) });
  return result.ok ? [] : [...new Set(result.issues.map((issue) => issue.code))];
}

const t1 = (tasks: Task[]) => tasks[0] as Task;

describe("checkDag: a plan that can run", () => {
  test("is accepted, and the repository alias is mapped to the real repository id", () => {
    const record = bootstrapRun({ runId: "run-dag001-a1" });
    const tasks = planTasks(REPO_ALIAS);
    const result = checkDag(record, dagBlock("run-dag001-a1", tasks), input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.block.tasks.flatMap((task) => task.scopes.map((scope) => scope.repoId))).toEqual([
      REPO_ID,
      REPO_ID,
    ]);
    // Nothing else about the tasks is touched.
    expect(result.block.tasks.map((task) => task.id)).toEqual(["t1", "t2"]);
    expect(result.block.tasks[1]?.deps).toEqual(["t1"]);
  });

  test("the canonical id is accepted as it is", () => {
    expect(codes()).toEqual([]);
  });

  test("an accepted plan goes through the reducer and makes the first task ready", () => {
    const record = bootstrapRun({ runId: "run-dag001-a1" });
    const result = checkDag(record, dagBlock("run-dag001-a1"), input());
    if (!result.ok) throw new Error("expected acceptance");
    const reduced = reduceRun(
      record,
      { kind: "dag-accepted", block: result.block },
      { now: "2026-11-05T12:00:00.000Z", newId: () => "x" },
    );
    if (!reduced.ok) throw new Error(`reducer refused: ${JSON.stringify(reduced.params)}`);
    expect(reduced.next.lifecycle).toBe("active");
    expect(reduced.next.tasks.map((task) => `${task.spec.id}:${task.state}`)).toEqual([
      "t1:ready",
      "t2:pending",
    ]);
  });
});

describe("checkDag: who may propose, and when", () => {
  test.each<[string, () => string[], string]>([
    [
      "the Run is already active",
      () =>
        codes((r) => {
          r.lifecycle = "active";
        }),
      "lifecycle",
    ],
    [
      "another Run's block",
      () => codes(undefined, undefined, { runId: "run-other0-a1" }),
      "run-mismatch",
    ],
    [
      "a revision that is not the first",
      () => codes(undefined, undefined, { dagRevision: 2, expectedDagRevision: 1 }),
      "revision",
    ],
    [
      "a sender that is not the coordinator",
      () => codes(undefined, undefined, {}, input({ agentId: "agent-b1" })),
      "sender-not-coordinator",
    ],
    [
      "a nonce that is not the issued one",
      () => codes(undefined, undefined, { nonce: "6f1c2a44-3b7e-4f0a-9a11-0000000000aa" }),
      "control-nonce",
    ],
    [
      "a nonce that was already used",
      () =>
        codes((r) => {
          r.launch = withDagControl(r, {
            nonceDigest: sha256Hex(DAG_NONCE),
            issuedAt: "2026-11-05T12:00:00.000Z",
            acceptedAt: "2026-11-05T12:01:00.000Z",
          }).launch;
        }),
      "control-nonce",
    ],
    [
      "no nonce issued at all",
      () =>
        codes((r) => {
          delete (r.launch as Record<string, unknown>).dagControl;
        }),
      "control-nonce",
    ],
    [
      "cancellations in the first DAG",
      () => codes(undefined, undefined, { cancelTaskIds: ["t1"] }),
      "initial-dag-cancels",
    ],
    [
      "budget requests",
      () =>
        codes(undefined, undefined, {
          budgetRequests: [
            { scope: "seat", subjectId: "seat-b1", requestedLimit: 9, reason: "more" },
          ],
        }),
      "budget-requests-unsupported",
    ],
  ])("%s is refused", (_name, refusal, code) => {
    expect(refusal()).toContain(code);
  });

  test("the coordinator seat must be the one the Engine added, with its agent", () => {
    expect(
      codes((r) => {
        const seat = r.roster.find((entry) => entry.seatId === COORDINATOR_SEAT_ID);
        if (seat) seat.agentId = null;
      }),
    ).toContain("sender-not-coordinator");
  });
});

describe("checkDag: structure", () => {
  test("duplicate ids, unknown or self dependencies and cycles are refused", () => {
    const second = (tasks: Task[]) => tasks[1] as Task;
    expect(
      codes(undefined, (tasks) => {
        second(tasks).id = "t1";
      }),
    ).toContain("duplicate-task-id");
    expect(
      codes(undefined, (tasks) => {
        second(tasks).deps = ["ghost"];
      }),
    ).toContain("unknown-dependency");
    expect(
      codes(undefined, (tasks) => {
        second(tasks).deps = ["t2"];
      }),
    ).toContain("self-dependency");
    expect(
      codes(undefined, (tasks) => {
        t1(tasks).deps = ["t2"];
      }),
    ).toContain("dependency-cycle");
  });

  test("irreversible work needs an approval the Engine does not handle yet", () => {
    expect(
      codes(undefined, (tasks) => {
        t1(tasks).irreversible = {
          kind: "push",
          target: "origin/main",
          description: "publish",
          artifactRef: null,
        };
      }),
    ).toContain("irreversible-unsupported");
  });

  test("write and read tasks must agree with their scopes", () => {
    expect(
      codes(undefined, (tasks) => {
        for (const scope of t1(tasks).scopes) scope.access = "read";
      }),
    ).toContain("write-task-without-write-scope");
    expect(
      codes(undefined, (tasks) => {
        t1(tasks).execution = "read";
      }),
    ).toContain("read-task-with-write-scope");
  });

  test("a scope in another repository or with a path that cannot be one is refused", () => {
    expect(
      codes(undefined, (tasks) => {
        const scope = t1(tasks).scopes[0];
        if (scope) scope.repoId = "repo-someone-else";
      }),
    ).toContain("unknown-repository");
    for (const bad of ["../outside.txt", "/etc/passwd", "C:/x"]) {
      expect(
        codes(undefined, (tasks) => {
          const scope = t1(tasks).scopes[0];
          if (scope) scope.path = bad;
        }),
      ).toContain("invalid-scope-path");
    }
  });

  test("two evidence requirements with one id are refused", () => {
    expect(
      codes(undefined, (tasks) => {
        const first = t1(tasks).evidence[0];
        if (first) t1(tasks).evidence.push({ ...first });
      }),
    ).toContain("duplicate-evidence-id");
  });
});

describe("checkDag: the roster can execute it", () => {
  test("a duty nobody has is refused, for producing and for reviewing", () => {
    expect(
      codes(undefined, (tasks) => {
        t1(tasks).dispatchDuties = { produce: "nobody-does-this", review: "review", smoke: null };
      }),
    ).toContain("no-producer-seat");
    expect(
      codes(undefined, (tasks) => {
        t1(tasks).dispatchDuties = {
          produce: "implement",
          review: "nobody-does-this",
          smoke: null,
        };
      }),
    ).toContain("no-reviewer-seat");
  });

  test("a reviewer that is the producer's own agent is not independent", () => {
    expect(
      codes((r) => {
        const reviewer = r.roster.find((seat) => seat.seatId === "seat-b2");
        if (reviewer) reviewer.agentId = "agent-b1";
      }),
    ).toContain("no-independent-reviewer");
  });

  test("the weakest review level needs a reviewer of another model family", () => {
    const l1 = (tasks: Task[]) => {
      for (const task of tasks) task.level = "L1";
    };
    // L1 is reviewed at tier B: the reviewer seat has to serve at that tier.
    const tierB = (r: RunRecord) => {
      const reviewer = r.roster.find((seat) => seat.seatId === "seat-b2");
      if (reviewer) reviewer.tier = "B";
    };
    expect(
      codes(
        tierB,
        l1,
        {},
        input({
          seatFamilies: new Map([
            ["seat-b1", "haiku"],
            ["seat-b2", "haiku"],
          ]),
        }),
      ),
    ).toContain("no-independent-family-reviewer");
    expect(codes(tierB, l1, {}, input({ seatFamilies: new Map() }))).toContain(
      "no-independent-family-reviewer",
    );
    expect(codes(tierB, l1)).toEqual([]);
  });

  test("a DEV smoke needs a usable checklist, a DEV target and an independent seat that can run it", () => {
    const smoke = (tasks: Task[]) => {
      t1(tasks).devSmoke = true;
      t1(tasks).smokeChecklist = ["health"];
      t1(tasks).dispatchDuties = { produce: "implement", review: "review", smoke: "smoke" };
    };
    const smoker = (r: RunRecord) => {
      r.roster.push({
        seatId: "seat-m1",
        tier: "B",
        agentId: "agent-m1",
        channelId: "claude",
        duties: ["smoke"],
        enabled: true,
      });
      r.budgets.entries.push({
        scope: "seat",
        subjectId: "seat-m1",
        limit: 6,
        reserved: 0,
        confirmed: 0,
        observedTurns: 0,
      });
    };
    expect(codes(smoker, smoke)).toEqual([]);
    expect(codes(undefined, smoke)).toContain("no-smoker-seat");
    expect(
      codes(smoker, (tasks) => {
        smoke(tasks);
        t1(tasks).smokeChecklist = ["a", "a"];
      }),
    ).toContain("smoke-checklist-invalid");
    expect(
      codes((r) => {
        smoker(r);
        r.policy.devTargets = [];
      }, smoke),
    ).toContain("dev-target-missing");
    expect(
      codes((r) => {
        smoker(r);
        const seat = r.roster.find((entry) => entry.seatId === "seat-m1");
        if (seat) seat.agentId = "agent-b1";
      }, smoke),
    ).toContain("no-independent-smoker");
  });

  test("every enabled seat needs a budget; the coordinator needs none", () => {
    expect(
      codes((r) => {
        r.budgets.entries = r.budgets.entries.filter((entry) => entry.subjectId !== "seat-b2");
      }),
    ).toContain("budget-missing");
    expect(
      codes((r) => {
        const seat = r.roster.find((entry) => entry.seatId === "seat-b2");
        if (seat) seat.enabled = false;
        r.budgets.entries = r.budgets.entries.filter((entry) => entry.subjectId !== "seat-b2");
      }),
    ).not.toContain("budget-missing");
  });
});

describe("control state and wording", () => {
  test("the control nonce is kept as a digest, and garbage is not a control", () => {
    const record = bootstrapRun();
    const control = readDagControl(record);
    expect(control).toEqual({
      nonceDigest: sha256Hex(DAG_NONCE),
      issuedAt: expect.any(String),
      acceptedAt: null,
    });
    expect(JSON.stringify(record)).not.toContain(DAG_NONCE);
    for (const bad of [
      null,
      "x",
      { nonceDigest: "nope", issuedAt: "t", acceptedAt: null },
      { nonceDigest: "a".repeat(64) },
    ]) {
      const copy = structuredClone(record);
      (copy.launch as Record<string, unknown>).dagControl = bad;
      expect(readDagControl(copy)).toBeNull();
    }
  });

  test("the reasons fit one alert, however many there are", () => {
    const text = describeIssues(
      Array.from({ length: 20 }, (_, index) => ({ code: "x".repeat(60), taskId: `t${index}` })),
    );
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text.startsWith("DAG 被拒：")).toBe(true);
  });
});

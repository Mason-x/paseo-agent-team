// biome-ignore-all lint/style/noNonNullAssertion: fixture builders guarantee these indices.
import { describe, expect, test } from "vitest";
import {
  checkEvidenceGate,
  checkReviewGate,
  checkSmokeGate,
  findTask,
} from "../../shared/domain/run-engine/gates";
import {
  DEV_SMOKE_MISSING_LEDGER,
  DEV_SMOKE_READY_LEDGER,
  EVIDENCE_INCOMPLETE_LEDGER,
  NORMAL_RUN_LEDGER,
  STALE_REVIEW_LEDGER,
  task,
} from "../fixtures/run-engine";

function taskOf(record: typeof NORMAL_RUN_LEDGER, id: string) {
  const found = record.tasks.find((entry) => entry.spec.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

describe("three gates", () => {
  test("evidence rejects an incomplete report", () => {
    expect(
      checkEvidenceGate(EVIDENCE_INCOMPLETE_LEDGER, taskOf(EVIDENCE_INCOMPLETE_LEDGER, "T2")),
    ).toMatchObject({
      ok: false,
    });
  });

  test("review rejects a stale or self review and accepts an independent one", () => {
    expect(checkReviewGate(NORMAL_RUN_LEDGER, taskOf(NORMAL_RUN_LEDGER, "T1"))).toEqual({
      ok: true,
    });
    expect(checkReviewGate(STALE_REVIEW_LEDGER, taskOf(STALE_REVIEW_LEDGER, "T1"))).toMatchObject({
      ok: false,
    });
    const self = {
      ...NORMAL_RUN_LEDGER,
      tasks: NORMAL_RUN_LEDGER.tasks.map((entry) =>
        entry.spec.id === "T1"
          ? ({
              ...entry,
              reviews: [
                {
                  reviewerAgentId: "agent-b1",
                  reviewerSeatId: "seat-b1",
                  verdict: "可合入" as const,
                  reviewedRef: entry.ref,
                  blockers: [],
                },
              ],
            } as typeof entry)
          : entry,
      ),
    };
    expect(checkReviewGate(self, taskOf(self, "T1"))).toMatchObject({ ok: false });
  });

  test("smoke requires the pre-registered DEV target and the full checklist", () => {
    expect(checkSmokeGate(DEV_SMOKE_READY_LEDGER, taskOf(DEV_SMOKE_READY_LEDGER, "T6"))).toEqual({
      ok: true,
    });
    expect(
      checkSmokeGate(DEV_SMOKE_MISSING_LEDGER, taskOf(DEV_SMOKE_MISSING_LEDGER, "T6")),
    ).toMatchObject({ ok: false });
  });

  test("a non-smoke task passes the smoke gate without evidence", () => {
    const record = {
      ...NORMAL_RUN_LEDGER,
      tasks: [...NORMAL_RUN_LEDGER.tasks, task("T9", "No smoke")],
    };
    expect(checkSmokeGate(record, taskOf(record, "T9"))).toEqual({ ok: true });
  });
});

describe("gate branch matrix", () => {
  test("evidence rejects path escape, command/ref/summary/coverage/isolation variants", () => {
    const base = structuredClone(NORMAL_RUN_LEDGER);
    const taskValue = taskOf(base, "T1");
    const report = (taskValue as unknown as { report: Record<string, unknown> }).report;
    const cases = [
      { changedFiles: ["src/../outside.ts"] },
      { changedFiles: ["docs/other.md"] },
      {
        evidence: [
          {
            ...(report.evidence as Record<string, unknown>[])[0],
            command: "echo wrong",
          },
        ],
      },
      {
        evidence: [
          {
            ...(report.evidence as Record<string, unknown>[])[0],
            summary: "",
          },
        ],
      },
      {
        evidence: [
          {
            ...(report.evidence as Record<string, unknown>[])[0],
            artifactPath: "artifacts/x.log",
          },
        ],
      },
      {
        evidence: [
          {
            ...(report.evidence as Record<string, unknown>[])[0],
            isolation: { homePath: "C:/Users/runner/.paseo", outsideRealHome: true },
          },
        ],
      },
      {
        evidence: [
          {
            ...(report.evidence as Record<string, unknown>[])[0],
            coverage: { lines: 0, functions: 0 },
          },
          { ...(report.evidence as Record<string, unknown>[])[0] },
        ],
      },
    ];
    for (const patch of cases) {
      const record = structuredClone(base);
      const target = taskOf(record, "T1") as unknown as { report: Record<string, unknown> };
      target.report = { ...target.report, ...patch };
      expect(checkEvidenceGate(record, taskOf(record, "T1")).ok, JSON.stringify(patch)).toBe(false);
    }
  });

  test("review enforces level tier and cross-family rules", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const t1 = taskOf(record, "T1");
    t1.spec = { ...t1.spec, level: "L1" };
    const reviewer = record.assignments.find((entry) => entry.assignmentId === "assignment-t1-r1");
    if (!reviewer) throw new Error("missing reviewer");
    reviewer.tier = "B";
    reviewer.family = "codex";
    record.assignments.push({
      ...reviewer,
      assignmentId: "assignment-t1-impl",
      purpose: "member",
      agentId: "agent-b1",
      seatId: "seat-b1",
      family: "claude",
      messageId: null,
    });
    expect(checkReviewGate(record, t1).ok).toBe(true);
    const sameFamily = structuredClone(record);
    const sameReviewer = sameFamily.assignments.find(
      (entry) => entry.assignmentId === "assignment-t1-r1",
    );
    if (sameReviewer) sameReviewer.family = "claude";
    expect(checkReviewGate(sameFamily, taskOf(sameFamily, "T1")).ok).toBe(false);

    const l4 = structuredClone(NORMAL_RUN_LEDGER);
    const taskL4 = taskOf(l4, "T1");
    taskL4.spec = { ...taskL4.spec, level: "L4" };
    const l4Reviewer = l4.assignments.find((entry) => entry.assignmentId === "assignment-t1-r1");
    if (l4Reviewer) l4Reviewer.tier = "S";
    expect(checkReviewGate(l4, taskL4).ok).toBe(true);
    if (l4Reviewer) l4Reviewer.tier = "A";
    expect(checkReviewGate(l4, taskL4).ok).toBe(false);
  });

  test("a qualified blocking review fails the review gate", () => {
    const record = structuredClone(NORMAL_RUN_LEDGER);
    const t1 = taskOf(record, "T1") as unknown as {
      reviews: Array<{ verdict: string; blockers: unknown[] }>;
    };
    const current = t1.reviews[0];
    if (!current) throw new Error("missing review");
    current.verdict = "不可合入";
    current.blockers = [{ id: "B1", summary: "blocking", path: "src/t1.ts" }];
    expect(checkReviewGate(record, t1 as never)).toMatchObject({ ok: false });
  });

  test("smoke rejects self-smoke, target aliases and checklist variants", () => {
    const baseline = structuredClone(DEV_SMOKE_READY_LEDGER);
    const baselineTask = taskOf(baseline, "T6");
    if (baselineTask.smokeReport === undefined) throw new Error("missing smoke report");
    const report = baselineTask.smokeReport as Record<string, unknown>;
    const target = baseline.policy.devTargets[0];
    if (!target) throw new Error("missing target");
    const withHosts = (host: string, registered = host) => {
      const record = structuredClone(baseline);
      record.policy.devTargets = [{ ...target, host: registered }];
      const taskValue = taskOf(record, "T6");
      if (taskValue.smokeReport === undefined) throw new Error("missing smoke report");
      (taskValue.smokeReport as Record<string, unknown>).devHost = host;
      return record;
    };
    for (const host of [
      "[0:0:0:0:0:0:0:1]:6767",
      "127.0.0.2:6767",
      "127.1:6767",
      "localhost.:6767",
      "2130706433:6767",
      "0x7f000001:6767",
      "[::ffff:127.0.0.1]:6767",
      "[::]:6767",
      "ws://127.0.0.1:6767",
      "user@127.0.0.1:6767",
      "127.0.0.1",
    ]) {
      expect(checkSmokeGate(withHosts(host), taskOf(withHosts(host), "T6")).ok, host).toBe(false);
    }
    for (const host of ["127.0.0.2:6799", "127.1:6799", "localhost.:6799", "ws://127.0.0.1:6799"]) {
      const record = withHosts(host);
      expect(checkSmokeGate(record, taskOf(record, "T6")).ok, host).toBe(true);
    }
    const self = structuredClone(baseline);
    self.assignments.push({
      ...self.assignments[0]!,
      assignmentId: "impl-self",
      taskId: "T6",
      agentId: "agent-b1",
      seatId: "seat-b1",
      purpose: "member",
      messageId: null,
    });
    self.assignments.push({
      ...self.assignments[0]!,
      assignmentId: "smoke-self",
      taskId: "T6",
      agentId: "agent-b1",
      seatId: "seat-b1",
      purpose: "smoker",
      messageId: null,
    });
    const selfTask = taskOf(self, "T6");
    if (selfTask.smokeReport) {
      (selfTask.smokeReport as Record<string, unknown>).assignmentId = "smoke-self";
    }
    expect(checkSmokeGate(self, selfTask).ok).toBe(false);
    for (const patch of [
      { checks: (report.checks as unknown[]).slice(0, 1) },
      {
        checks: [
          ...(report.checks as unknown[]),
          { id: "extra", result: "pass", evidencePath: "evidence/x" },
        ],
      },
      {
        checks: (report.checks as unknown[]).map((check) => ({
          ...(check as object),
          result: "fail",
        })),
      },
      {
        checks: (report.checks as unknown[]).map((check) => ({
          ...(check as object),
          evidencePath: "outside/x",
        })),
      },
    ]) {
      const record = structuredClone(baseline);
      const taskValue = taskOf(record, "T6");
      if (taskValue.smokeReport) {
        Object.assign(taskValue.smokeReport, patch);
      }
      expect(checkSmokeGate(record, taskValue).ok, JSON.stringify(patch)).toBe(false);
    }
  });
});

describe("gate denial branches", () => {
  test("evidence distinguishes missing/invalid/status/workspace/ref/evidence failures", () => {
    const base = structuredClone(NORMAL_RUN_LEDGER);
    const make = () => {
      const record = structuredClone(base);
      const task = taskOf(record, "T1") as unknown as { report: Record<string, unknown> };
      return { record, task };
    };
    {
      const { record, task } = make();
      task.report = [] as unknown as Record<string, unknown>;
      expect(checkEvidenceGate(record, taskOf(record, "T1")).ok).toBe(false);
    }
    {
      const { record, task } = make();
      task.report.status = "blocked";
      expect(checkEvidenceGate(record, taskOf(record, "T1")).ok).toBe(false);
    }
    {
      const { record, task } = make();
      task.report.changedFiles = "src/t1.ts";
      expect(checkEvidenceGate(record, taskOf(record, "T1")).ok).toBe(false);
    }
    {
      const { record, task } = make();
      task.report.assignmentId = "assignment-t1-r1";
      task.report.workspace = { id: "other", branch: "x", baseRef: "main" };
      expect(checkEvidenceGate(record, taskOf(record, "T1"))).toMatchObject({
        ok: false,
        issues: [{ params: { reason: "workspace-mismatch" } }],
      });
    }
    {
      const { record, task } = make();
      task.report.evidence = [];
      expect(checkEvidenceGate(record, taskOf(record, "T1"))).toMatchObject({
        ok: false,
        issues: [{ params: { reason: "missing" } }],
      });
    }
    {
      const { record, task } = make();
      task.report.evidence = [
        { ...(task.report.evidence as Record<string, unknown>[])[0] },
        { ...(task.report.evidence as Record<string, unknown>[])[0] },
      ];
      expect(checkEvidenceGate(record, taskOf(record, "T1")).ok).toBe(false);
    }
    {
      const { record, task } = make();
      task.report.evidence = [
        { ...(task.report.evidence as Record<string, unknown>[])[0], summary: 1 },
      ];
      expect(checkEvidenceGate(record, taskOf(record, "T1")).ok).toBe(false);
    }
    {
      const { record, task } = make();
      task.report.evidence = [
        { ...(task.report.evidence as Record<string, unknown>[])[0], ref: { value: "x" } },
      ];
      expect(checkEvidenceGate(record, taskOf(record, "T1")).ok).toBe(false);
    }
    {
      const { record, task } = make();
      const taskWithSpec = task as unknown as {
        spec: { evidence: Array<Record<string, unknown>> };
      };
      taskWithSpec.spec.evidence = [
        { ...taskWithSpec.spec.evidence[0], minLines: 90, minFunctions: 85 },
      ];
      task.report.evidence = [
        {
          ...(task.report.evidence as Record<string, unknown>[])[0],
          coverage: { lines: 0, functions: 0 },
        },
      ];
      expect(checkEvidenceGate(record, taskOf(record, "T1")).ok).toBe(false);
    }
    {
      const { record, task } = make();
      task.report.evidence = [
        {
          ...(task.report.evidence as Record<string, unknown>[])[0],
          isolation: { homePath: "C:/Users/runner/.paseo", outsideRealHome: true },
        },
      ];
      expect(checkEvidenceGate(record, taskOf(record, "T1")).ok).toBe(false);
    }
  });

  test("smoke denial branches and findTask", () => {
    const base = structuredClone(DEV_SMOKE_READY_LEDGER);
    const target = base.policy.devTargets[0]!;
    const make = () => {
      const record = structuredClone(base);
      const task = taskOf(record, "T6");
      return { record, task };
    };
    expect(findTask(base, "T6")).toBeDefined();
    expect(findTask(base, "missing")).toBeUndefined();
    {
      const { record, task } = make();
      (task as unknown as { smokeReport: unknown }).smokeReport = [];
      expect(checkSmokeGate(record, task).ok).toBe(false);
    }
    {
      const { record, task } = make();
      (task.smokeReport as Record<string, unknown>).checks = "bad";
      expect(checkSmokeGate(record, task).ok).toBe(false);
    }
    {
      const { record, task } = make();
      (task as unknown as { ref: unknown }).ref = { kind: "git-commit", value: "current" };
      (task.smokeReport as Record<string, unknown>).testedRef = {
        kind: "git-commit",
        value: "other",
      };
      expect(checkSmokeGate(record, task).ok).toBe(false);
    }
    {
      const { record, task } = make();
      (task.smokeReport as Record<string, unknown>).checks = [
        ...((task.smokeReport as Record<string, unknown>).checks as unknown[]),
        { id: "open runs tab", result: "pass", evidencePath: "evidence/dup" },
      ];
      expect(checkSmokeGate(record, task).ok).toBe(false);
    }
    {
      const { record, task } = make();
      (task.smokeReport as Record<string, unknown>).devHost = "127.0.0.1";
      (task.smokeReport as Record<string, unknown>).devServerId = target.serverId;
      expect(checkSmokeGate(record, task).ok).toBe(false);
    }
  });
});

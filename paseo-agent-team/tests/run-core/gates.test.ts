// biome-ignore-all lint/style/noNonNullAssertion: complete parent fixtures assert these entries.
import { describe, expect, test } from "vitest";
import {
  checkEvidenceGate,
  checkReviewGate,
  checkSmokeGate,
  doneGate,
  findTask,
} from "../../shared/domain/run-engine/gates";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import {
  type RunRecord,
  RunRecordSchema,
  RunStoredSmokeReportSchema,
  type RunStoredTaskReport,
  RunStoredTaskReportSchema,
} from "../../shared/schemas/run-engine/ledger";
import {
  DEV_SMOKE_READY_LEDGER,
  INVARIANT_CASES,
  NORMAL_RUN_LEDGER,
  STALE_REVIEW_LEDGER,
} from "../fixtures/run-engine";

function task(record: RunRecord, id: string) {
  const found = findTask(record, id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}
function normal(): RunRecord {
  const record = RunRecordSchema.parse(structuredClone(NORMAL_RUN_LEDGER));
  expect(checkLedgerInvariants(record)).toEqual({ ok: true });
  return record;
}
function dev(): RunRecord {
  const record = RunRecordSchema.parse(structuredClone(DEV_SMOKE_READY_LEDGER));
  // The source fixture supplies attempt-1 actors and retained observations, not task counters.
  task(record, "t6").attempts = 1;
  const producer = record.assignments.find((entry) => entry.assignmentId === "assignment-t6-a1")!;
  const proof = RunStoredTaskReportSchema.parse(producer.acceptedProof);
  if (proof.status !== "done") throw new Error("DEV producer");
  // This private core scenario declares the full evidence facts, beyond the public source skeleton.
  proof.evidence[0]!.isolation = { homePath: "C:/Temp/gates-home", outsideRealHome: true };
  producer.acceptedProof = proof;
  record.counters.observationSeq = Math.max(
    record.counters.observationSeq,
    ...record.eventReceipts.map((entry) => entry.seq),
  );
  expect(checkLedgerInvariants(record)).toEqual({ ok: true });
  return record;
}
function doneProof(record: RunRecord) {
  const producer = record.assignments.find((entry) => entry.assignmentId === "assignment-t1-a1")!;
  const proof = RunStoredTaskReportSchema.parse(producer.acceptedProof);
  if (proof.status !== "done") throw new Error("missing done proof");
  producer.acceptedProof = proof;
  return proof;
}
function smokeProof(record: RunRecord) {
  const smoker = record.assignments.find((entry) => entry.assignmentId === "assignment-t6-s1")!;
  const proof = RunStoredSmokeReportSchema.parse(smoker.acceptedProof);
  smoker.acceptedProof = proof;
  return proof;
}

describe("R01g three gates use assignment acceptedProof", () => {
  test("normal evidence/review and actual ended actors close done", () => {
    const record = normal();
    expect(checkEvidenceGate(record, task(record, "t1"))).toEqual({ ok: true });
    expect(checkReviewGate(record, task(record, "t1"))).toEqual({ ok: true });
    expect(checkSmokeGate(record, task(record, "t1"))).toEqual({ ok: true });
    expect(doneGate(record, task(record, "t1"))).toEqual({ ok: true });
    expect(findTask(record, "missing")).toBeUndefined();
  });
  const evidenceCases: {
    reason: string;
    mutate: (proof: Extract<RunStoredTaskReport, { status: "done" }>) => void;
  }[] = [
    {
      reason: "outside-scope",
      mutate: (p) => {
        p.changedFiles = ["src/../outside.ts"];
      },
    },
    {
      reason: "outside-scope",
      mutate: (p) => {
        p.changedFiles = ["docs/outside.md"];
      },
    },
    {
      reason: "workspace-mismatch",
      mutate: (p) => {
        p.workspace.branch = "different";
      },
    },
    {
      reason: "duplicate-id",
      mutate: (p) => {
        p.evidence.push(structuredClone(p.evidence[0]!));
      },
    },
    {
      reason: "missing",
      mutate: (p) => {
        p.evidence[0]!.id = "unrequested";
      },
    },
    {
      reason: "command",
      mutate: (p) => {
        p.evidence[0]!.command = "echo wrong";
      },
    },
    {
      reason: "ref-mismatch",
      mutate: (p) => {
        p.evidence[0]!.ref = { kind: "git-commit", value: "different" };
      },
    },
    {
      reason: "exit-code",
      mutate: (p) => {
        p.evidence[0]!.exitCode = 1;
      },
    },
    {
      reason: "artifact-root",
      mutate: (p) => {
        p.evidence[0]!.artifactPath = "outside/report.log";
      },
    },
    {
      reason: "isolation",
      mutate: (p) => {
        p.evidence[0]!.isolation = { homePath: "C:/Users/runner/.paseo", outsideRealHome: true };
      },
    },
  ];
  test.each(evidenceCases)("evidence single defect: $reason", ({ reason, mutate }) => {
    const record = normal();
    const proof = doneProof(record);
    mutate(proof);
    task(record, "t1").changedFiles = [...proof.changedFiles];
    expect(RunRecordSchema.safeParse(record).success).toBe(true);
    expect(checkEvidenceGate(record, task(record, "t1"))).toMatchObject({
      ok: false,
      issues: [{ gate: "evidence", params: { reason } }],
    });
  });
  test.each(["lines", "functions"] as const)("evidence coverage %s", (field) => {
    const record = normal();
    const requirement = task(record, "t1").spec.evidence[0]!;
    requirement.minLines = 90;
    requirement.minFunctions = 85;
    doneProof(record).evidence[0]!.coverage = { lines: 100, functions: 100, [field]: 0 };
    expect(checkEvidenceGate(record, task(record, "t1"))).toMatchObject({
      ok: false,
      issues: [{ params: { reason: `coverage-${field}` } }],
    });
  });
  test("shape-negative summary is distinct from evidence policy", () => {
    const record = normal();
    doneProof(record).evidence[0]!.summary = "";
    expect(RunRecordSchema.safeParse(record).success).toBe(false);
  });
  test("stale D and source-bound self reviewer cannot pass", () => {
    // The reason is the one for "no review counts for the current delivery", not a judge's "no".
    const noValidReview = {
      ok: false,
      issues: [
        {
          gate: "review",
          path: ["tasks", "t1", "reviews"],
          params: { reason: "no-valid-review" },
        },
      ],
    };
    const stale = RunRecordSchema.parse(STALE_REVIEW_LEDGER);
    expect(checkReviewGate(stale, task(stale, "t1"))).toEqual(noValidReview);
    const self = RunRecordSchema.parse(
      INVARIANT_CASES.find((entry) => entry.id === "i7-self-review")?.ledger,
    );
    expect(checkReviewGate(self, task(self, "t1"))).toEqual(noValidReview);
  });
  test("a review of an older reviewedRef does not count for the current delivery", () => {
    const record = normal();
    expect(checkReviewGate(record, task(record, "t1"))).toEqual({ ok: true });
    const reviewer = record.assignments.find((entry) => entry.purpose === "reviewer")!;
    const proof = reviewer.acceptedProof as { verdict: string; reviewedRef: unknown };
    // Still a clean verdict from an independent reviewer, but of another commit than the delivered one.
    expect(proof.verdict).toBe("可合入");
    proof.reviewedRef = { kind: "git-commit", value: "an-older-commit" };
    expect(RunRecordSchema.safeParse(record).success).toBe(true);
    expect(checkReviewGate(record, task(record, "t1"))).toEqual({
      ok: false,
      issues: [
        {
          gate: "review",
          path: ["tasks", "t1", "reviews"],
          params: { reason: "no-valid-review" },
        },
      ],
    });
    expect(doneGate(record, task(record, "t1"))).toMatchObject({ ok: false });
  });
  test("L1 frozen family independence", () => {
    const record = normal();
    task(record, "t1").spec.level = "L1";
    const reviewer = record.assignments.find((entry) => entry.purpose === "reviewer")!;
    record.assignments.find((entry) => entry.assignmentId === "assignment-t1-a1")!.family =
      "claude";
    reviewer.family = "codex";
    reviewer.tier = "B";
    record.roster.find((entry) => entry.seatId === reviewer.seatId)!.tier = "B";
    expect(checkReviewGate(record, task(record, "t1"))).toEqual({ ok: true });
    reviewer.family = record.assignments.find(
      (entry) => entry.assignmentId === "assignment-t1-a1",
    )!.family;
    expect(checkReviewGate(record, task(record, "t1"))).toMatchObject({ ok: false });
  });
  test("reports cannot replace a true ended receipt", () => {
    const record = normal();
    const reviewer = record.assignments.find((entry) => entry.purpose === "reviewer")!;
    reviewer.state = "assigned";
    reviewer.startedAt = null;
    reviewer.turnId = null;
    reviewer.endedAt = null;
    reviewer.endedEventKey = null;
    expect(RunRecordSchema.safeParse(record).success).toBe(true);
    expect(doneGate(record, task(record, "t1"))).toMatchObject({
      ok: false,
      issues: [{ params: { reason: "unsettled-reviewer" } }],
    });
  });
  test("registered DEV passes, default target fails", () => {
    const ready = dev();
    expect(checkSmokeGate(ready, task(ready, "t6"))).toEqual({ ok: true });
    const missing = dev();
    smokeProof(missing).devHost = "127.0.0.1:6767";
    missing.policy.devTargets[0]!.host = "127.0.0.1:6767";
    expect(RunRecordSchema.safeParse(missing).success).toBe(true);
    // A smoke on the default daemon's port is a failed smoke, not a missing one.
    expect(checkSmokeGate(missing, task(missing, "t6"))).toEqual({
      ok: false,
      issues: [
        {
          gate: "smoke",
          path: ["tasks", "t6", "smoke"],
          params: { reason: "failed-smoke" },
        },
      ],
    });
    expect(checkLedgerInvariants(missing)).toMatchObject({
      ok: false,
      violations: [{ invariant: "I7", params: { reason: "invalid-historical-proof" } }],
    });
  });
  test.each([
    "target",
    "home",
    "ref",
    "missing-check",
    "extra-check",
    "duplicate-check",
    "evidence-path",
    "failed",
  ] as const)("smoke single defect: %s", (kind) => {
    const record = dev();
    expect(checkSmokeGate(record, task(record, "t6"))).toEqual({ ok: true });
    const proof = smokeProof(record);
    if (kind === "target") proof.devServerId = "not-registered";
    else if (kind === "home") proof.devHome = "C:/Users/runner/.paseo";
    else if (kind === "ref") proof.testedRef = { kind: "git-commit", value: "different" };
    else if (kind === "missing-check") proof.checks.pop();
    else if (kind === "extra-check")
      proof.checks.push({ id: "unrequested", result: "pass", evidencePath: "evidence/extra.log" });
    else if (kind === "duplicate-check") proof.checks.push(structuredClone(proof.checks[0]!));
    else if (kind === "evidence-path") proof.checks[0]!.evidencePath = "outside/check.log";
    else proof.checks[0]!.result = "fail";
    expect(RunRecordSchema.safeParse(record).success).toBe(true);
    expect(checkSmokeGate(record, task(record, "t6"))).toMatchObject({ ok: false });
  });
});

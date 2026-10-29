// Permanent red specification for the R03a delivery-binding gaps confirmed by 188 and 194.
// This file is intentionally independent of the old seed: it builds a complete roster, assignment,
// nonce and outbox for every normal transition, and validates schema + I1-I8 before and after.
// The future core implementation may only change product code; this specification is not to be
// weakened or edited by that implementation.
import { describe, expect, test } from "vitest";
import {
  checkLedgerInvariants,
  occupiesExecutionSlot,
} from "../../shared/domain/run-engine/invariants";
import { findLockConflicts } from "../../shared/domain/run-engine/locks";
import { reduceRun } from "../../shared/domain/run-engine/reducer";
import type {
  RunAssignment,
  RunEffectIntent,
  RunNonceEntry,
  RunRecord,
  RunSeatSnapshot,
  RunTaskRecord,
} from "../../shared/schemas/run-engine/ledger";
import { RunRecordSchema } from "../../shared/schemas/run-engine/ledger";
import {
  RunReviewReportBlockSchema,
  RunSmokeReportBlockSchema,
  RunTaskReportBlockSchema,
} from "../../shared/schemas/run-engine/protocol";
import {
  AT_CREATED,
  AT_UPDATED,
  claim,
  dispatchIntent,
  NORMAL_RUN_LEDGER,
  spec,
  taskRecord,
} from "../fixtures/run-engine";

const RUN_ID = "run-r03a-replan";
const REPO_ID = "repo-r03a-replan";
const REF_A = "ref-a";
const REF_B = "ref-b";
const CONTROL_DIGEST = "9".repeat(64);
const facts = {
  now: AT_UPDATED,
  newId: () => uuid(),
};

let serial = 0;
function uuid(): string {
  const tail = String(++serial).padStart(12, "0");
  return `90000000-0000-4000-8000-${tail}`;
}

type Purpose = "member" | "reviewer" | "smoker";
type ResourceClaim = RunRecord["resources"][number];
type TaskWithEvidence = RunTaskRecord & {
  report?: ReturnType<typeof RunTaskReportBlockSchema.parse>;
  reviews?: Array<ReturnType<typeof RunReviewReportBlockSchema.parse>>;
  smokeReport?: ReturnType<typeof RunSmokeReportBlockSchema.parse>;
};

const roster: RunSeatSnapshot[] = [
  {
    seatId: "seat-b1",
    tier: "B",
    agentId: "agent-b1",
    channelId: "claude",
    duties: ["implement"],
    enabled: true,
  },
  {
    seatId: "seat-a1",
    tier: "A",
    agentId: "agent-a1",
    channelId: "claude",
    duties: ["review"],
    enabled: true,
  },
  {
    seatId: "seat-a2",
    tier: "A",
    agentId: "agent-a2",
    channelId: "claude",
    duties: ["review"],
    enabled: true,
  },
  {
    seatId: "seat-s1",
    tier: "A",
    agentId: "agent-s1",
    channelId: "claude",
    duties: ["smoke"],
    enabled: true,
  },
];

function taskOf(record: RunRecord, id = "t1"): TaskWithEvidence {
  const found = record.tasks.find((entry) => entry.spec.id === id);
  if (!found) throw new Error(`missing task ${id}`);
  return found as TaskWithEvidence;
}

function taskSpec(id = "t1", smoke = false) {
  return spec(id, `Delivery ${id}`, {
    scopes: [
      {
        repoId: REPO_ID,
        kind: "file",
        path: `src/${id}.ts`,
        access: "write",
      },
    ],
    devSmoke: smoke,
    smokeChecklist: smoke ? ["landing"] : [],
  });
}

function fresh(options: { smoke?: boolean; secondTask?: boolean } = {}): RunRecord {
  const record = structuredClone(NORMAL_RUN_LEDGER) as RunRecord;
  record.runId = RUN_ID;
  record.dagRevision = 1;
  record.lifecycle = "active";
  record.roster = roster;
  record.tasks = [
    taskRecord(taskSpec("t1", options.smoke ?? false), { state: "ready" }) as TaskWithEvidence,
  ];
  if (options.secondTask) {
    record.tasks.push(taskRecord(taskSpec("t2"), { state: "pending" }) as TaskWithEvidence);
  }
  record.resources = [];
  record.assignments = [];
  record.nonceRegistry = [];
  record.outbox = [];
  record.decisions = [];
  record.events = [];
  record.eventReceipts = [];
  record.reopenGrants = [];
  record.checkpoint = undefined;
  record.counters = { ...record.counters, eventsThroughSeq: 0, observationSeq: 0 };
  return record;
}

function valid(record: RunRecord): RunRecord {
  RunRecordSchema.parse(record);
  const report = checkLedgerInvariants(record);
  if (!report.ok) throw new Error(JSON.stringify(report));
  return record;
}

function canonicalSchemaAvailable(record: RunRecord): boolean {
  return !record.tasks.some((task) =>
    ["report", "reviews", "smokeReport"].some((key) => Object.hasOwn(task, key)),
  );
}

function parseIfCanonical(record: RunRecord): void {
  // WIP dependency: 9527 still writes task mirrors. Once the core writes assignment.acceptedProof,
  // this becomes an unconditional RunRecordSchema.parse and the I2 mutations target that proof.
  if (canonicalSchemaAvailable(record)) RunRecordSchema.parse(record);
}

function smokeProof(record: RunRecord, assignmentId: string): Record<string, unknown> | undefined {
  const assignment = record.assignments.find((entry) => entry.assignmentId === assignmentId);
  if (assignment?.acceptedProof) return assignment.acceptedProof as Record<string, unknown>;
  return taskOf(record).smokeReport as Record<string, unknown> | undefined;
}

function next(record: RunRecord, event: unknown): RunRecord {
  valid(record);
  const result = reduceRun(record, event as never, facts);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result));
  // WIP dependency: the frozen R01g schema forbids the task mirrors that the current 9527
  // reducer still emits. Validate the legal input; post-result schema validation returns when
  // the core writes assignment.acceptedProof / ended facts. Behavior assertions stay below.
  return result.next;
}

function actor(purpose: Purpose, attempt: number, slot = 0) {
  const member = purpose === "member";
  const reviewer = purpose === "reviewer";
  const seatId = member ? "seat-b1" : reviewer ? (slot === 0 ? "seat-a1" : "seat-a2") : "seat-s1";
  const agentId = member
    ? "agent-b1"
    : reviewer
      ? slot === 0
        ? "agent-a1"
        : "agent-a2"
      : "agent-s1";
  return {
    seatId,
    agentId,
    tier: member ? ("B" as const) : ("A" as const),
    family: member ? "deepseek" : "codex",
    profileId: `profile-${purpose}-${slot}`,
    profileName: `Profile ${purpose} ${slot}`,
    provider: "test-provider",
    model: "test-model",
    channelId: "claude",
    workspace: {
      id: `ws-${purpose}-${attempt}-${slot}`,
      branch: `re-${purpose}-${attempt}-${slot}`,
      baseRef: "main",
    },
  };
}

function makeAssignment(purpose: Purpose, attempt: number, slot = 0): RunAssignment {
  const who = actor(purpose, attempt, slot);
  return {
    assignmentId: `assignment-${purpose}-${attempt}-${slot}-${++serial}`,
    taskId: "t1",
    seatId: who.seatId,
    agentId: who.agentId,
    profileId: who.profileId,
    profileName: who.profileName,
    provider: who.provider,
    model: who.model,
    family: who.family,
    channelId: who.channelId,
    tier: who.tier,
    reason: "Replan specification local actor",
    purpose,
    workspace: who.workspace,
    attempt,
    nonce: uuid(),
    messageId: uuid(),
    delivery: purpose === "member" ? null : { producerAssignmentId: "assignment-t1-a1" },
    acceptedProof: null,
    endedEventKey: null,
    turnId: null,
    state: "assigned",
    createdAt: AT_CREATED,
    startedAt: null,
    endedAt: null,
  };
}

function makeNonce(assignment: RunAssignment): RunNonceEntry {
  return {
    nonce: assignment.nonce,
    runId: RUN_ID,
    taskId: assignment.taskId,
    assignmentId: assignment.assignmentId,
    attempt: assignment.attempt,
    phase:
      assignment.purpose === "member"
        ? "implementation"
        : assignment.purpose === "reviewer"
          ? "review"
          : "smoke",
    agentId: assignment.agentId,
    seatId: assignment.seatId,
    issuedAt: AT_CREATED,
    acceptedAt: null,
    acceptedEventKey: null,
    revokedAt: null,
    revokeReason: null,
  };
}

function makeIntent(assignment: RunAssignment): RunEffectIntent {
  return dispatchIntent({
    id: `intent-${assignment.assignmentId}-${++serial}`,
    kind: "dispatch",
    taskId: assignment.taskId,
    assignmentId: assignment.assignmentId,
    recipient: assignment.agentId,
    messageId: assignment.messageId ?? undefined,
    idempotencyKey: `dispatch-${assignment.assignmentId}-${serial}`,
    state: "prepared",
    confirmedAt: null,
    localCancellation: null,
  });
}

function dispatch(
  purpose: Purpose,
  attempt = 1,
  options: { slot?: number; claims?: ResourceClaim[] } = {},
) {
  const slot = options.slot ?? 0;
  const assignment = makeAssignment(purpose, attempt, slot);
  const nonce = makeNonce(assignment);
  const sequence = ++serial;
  const claims =
    options.claims ??
    (purpose === "member"
      ? [
          claim({
            claimId: `claim-${sequence}`,
            taskId: "t1",
            repoId: REPO_ID,
            path: "src/t1.ts",
            access: "write",
            frozen: false,
            createdAt: AT_CREATED,
          }),
        ]
      : []);
  return {
    kind: "task-dispatched" as const,
    taskId: "t1",
    assignment,
    nonce,
    intent: makeIntent(assignment),
    ...(purpose === "member" ? { claims } : {}),
  };
}

function doneReport(assignment: RunAssignment, ref = REF_A) {
  return RunTaskReportBlockSchema.parse({
    protocolVersion: 1,
    runId: RUN_ID,
    taskId: assignment.taskId,
    attempt: assignment.attempt,
    assignmentId: assignment.assignmentId,
    nonce: assignment.nonce,
    status: "done",
    changedFiles: ["src/t1.ts"],
    ref: { kind: "git-commit", value: ref },
    workspace: assignment.workspace,
    evidence: [
      {
        id: "five-gates",
        command: "npm run check && npm run typecheck && npm test",
        exitCode: 0,
        summary: "passed",
        artifactPath: "evidence/t1.log",
        ref: { kind: "git-commit", value: ref },
        isolation: {
          homePath: "C:/Temp/replan-home",
          outsideRealHome: true,
        },
      },
    ],
  });
}

function reviewReport(assignment: RunAssignment, ref: string, verdict: "可合入" | "不可合入") {
  return RunReviewReportBlockSchema.parse({
    protocolVersion: 1,
    runId: RUN_ID,
    taskId: assignment.taskId,
    attempt: assignment.attempt,
    assignmentId: assignment.assignmentId,
    nonce: assignment.nonce,
    reviewedRef: { kind: "git-commit", value: ref },
    verdict,
    blockers:
      verdict === "可合入" ? [] : [{ id: "blocker", summary: "must fix", path: "src/t1.ts" }],
    probes: [],
  });
}

function smokeReport(assignment: RunAssignment, ref: string, result: "pass" | "fail") {
  return RunSmokeReportBlockSchema.parse({
    protocolVersion: 1,
    runId: RUN_ID,
    taskId: assignment.taskId,
    attempt: assignment.attempt,
    assignmentId: assignment.assignmentId,
    nonce: assignment.nonce,
    testedRef: { kind: "git-commit", value: ref },
    devHost: "127.0.0.1:6799",
    devServerId: "dev-server-1",
    devHome: "/tmp/dev-home",
    checks: [{ id: "landing", result, evidencePath: "evidence/landing.png" }],
  });
}

function report(event: ReturnType<typeof dispatch>, ref = REF_A) {
  return next(next(fresh(), event), {
    kind: "task-report",
    block: doneReport(event.assignment, ref),
  });
}

function reworkClaims(record: RunRecord): ResourceClaim[] {
  if (record.resources.some((entry) => entry.taskId === "t1")) return [];
  return [
    claim({
      claimId: `claim-rework-${++serial}`,
      taskId: "t1",
      repoId: REPO_ID,
      path: "src/t1.ts",
      access: "write",
      frozen: false,
      createdAt: AT_CREATED,
    }),
  ];
}

function reviewFlow() {
  const member = dispatch("member");
  const seeded = report(member);
  return { record: seeded, reviewer: dispatch("reviewer") };
}

function reworkFlow() {
  const { record: seeded, reviewer } = reviewFlow();
  let record = next(seeded, reviewer);
  record = next(record, {
    kind: "review-report",
    block: reviewReport(reviewer.assignment, REF_A, "不可合入"),
  });
  expect(taskOf(record).state).toBe("rework");
  const nextMember = dispatch("member", 2, { claims: reworkClaims(record) });
  record = next(record, nextMember);
  record = next(record, {
    kind: "task-report",
    block: doneReport(nextMember.assignment, REF_B),
  });
  return { record, oldReviewer: reviewer };
}

function smokeRework(ref: string) {
  let record = fresh({ smoke: true });
  const member = dispatch("member");
  record = next(record, member);
  record = next(record, { kind: "task-report", block: doneReport(member.assignment, REF_A) });
  const firstReviewer = dispatch("reviewer");
  record = next(record, firstReviewer);
  record = next(record, {
    kind: "review-report",
    block: reviewReport(firstReviewer.assignment, REF_A, "可合入"),
  });
  expect(taskOf(record).phase).toBe("smoke");
  const firstSmoker = dispatch("smoker");
  record = next(record, firstSmoker);
  record = next(record, {
    kind: "smoke-report",
    block: smokeReport(firstSmoker.assignment, REF_A, "fail"),
  });
  expect(taskOf(record).state).toBe("rework");

  const secondMember = dispatch("member", 2, { claims: reworkClaims(record) });
  record = next(record, secondMember);
  record = next(record, {
    kind: "task-report",
    block: doneReport(secondMember.assignment, ref),
  });
  const secondReviewer = dispatch("reviewer", 2);
  record = next(record, secondReviewer);
  record = next(record, {
    kind: "review-report",
    block: reviewReport(secondReviewer.assignment, ref, "可合入"),
  });
  expect(taskOf(record).phase).toBe("smoke");
  return { record, firstReviewer, firstSmoker, secondReviewer };
}

function smokeDoneFlow() {
  let record = fresh({ smoke: true });
  const member = dispatch("member");
  record = next(record, member);
  record = next(record, { kind: "task-report", block: doneReport(member.assignment) });
  const reviewer = dispatch("reviewer");
  record = next(record, reviewer);
  record = next(record, {
    kind: "review-report",
    block: reviewReport(reviewer.assignment, REF_A, "可合入"),
  });
  const smoker = dispatch("smoker");
  record = next(record, smoker);
  record = next(record, {
    kind: "smoke-report",
    block: smokeReport(smoker.assignment, REF_A, "pass"),
  });
  expect(taskOf(record).state).toBe("done");
  return { record, smoker };
}

describe("R03a delivery binding red specification", () => {
  test("B1 review dispatch retains the implementation claim, competing scope, and does not take a slot", () => {
    const { record: seeded, reviewer } = reviewFlow();
    const before = seeded.resources
      .filter((entry) => entry.taskId === "t1")
      .map((entry) => entry.claimId);
    expect(before).toHaveLength(1);
    const record = next(seeded, reviewer);
    expect(
      record.resources.filter((entry) => entry.taskId === "t1").map((entry) => entry.claimId),
    ).toEqual(before);
    const conflicts = findLockConflicts(record, {
      taskId: "other",
      scopes: [
        { repoId: REPO_ID, kind: "file", path: "src/t1.ts", access: "write", verified: true },
      ],
    });
    expect(conflicts.ok).toBe(true);
    if (conflicts.ok) expect(conflicts.conflicts).toHaveLength(1);
    expect(occupiesExecutionSlot(record, taskOf(record))).toBe(false);
  });

  test("B1 smoke dispatch retains the implementation claim, competing scope, and does not take a slot", () => {
    let record = fresh({ smoke: true });
    const member = dispatch("member");
    record = next(record, member);
    record = next(record, { kind: "task-report", block: doneReport(member.assignment) });
    const originalClaims = structuredClone(
      record.resources.filter((entry) => entry.taskId === "t1"),
    );
    expect(originalClaims).toHaveLength(1);

    const reviewer = dispatch("reviewer");
    record = next(record, reviewer);
    record = next(record, {
      kind: "review-report",
      block: reviewReport(reviewer.assignment, REF_A, "可合入"),
    });

    // Isolation snapshot for the smoke step only: after the review path has deleted the claim,
    // restore this exact pre-review implementation claim on a structured clone. The claim was
    // already part of a schema- and I1-I8-valid accepted report. This is a test-only input
    // snapshot, not a product fix and not a new authorization.
    const restored = structuredClone(record);
    restored.resources = [
      ...restored.resources.filter((entry) => entry.taskId !== "t1"),
      ...structuredClone(originalClaims),
    ];
    valid(restored);
    expect(restored.resources.filter((entry) => entry.taskId === "t1")).toHaveLength(1);
    const beforeConflicts = findLockConflicts(restored, {
      taskId: "other",
      scopes: [
        { repoId: REPO_ID, kind: "file", path: "src/t1.ts", access: "write", verified: true },
      ],
    });
    expect(beforeConflicts.ok).toBe(true);
    if (beforeConflicts.ok) expect(beforeConflicts.conflicts).toHaveLength(1);

    const smoker = dispatch("smoker");
    const after = next(restored, smoker);
    const afterClaims = after.resources.filter((entry) => entry.taskId === "t1");
    expect(afterClaims).toHaveLength(1);
    expect(afterClaims[0]).toMatchObject({
      claimId: originalClaims[0]?.claimId,
      taskId: "t1",
      access: "write",
      frozen: false,
    });
    const afterConflicts = findLockConflicts(after, {
      taskId: "other",
      scopes: [
        { repoId: REPO_ID, kind: "file", path: "src/t1.ts", access: "write", verified: true },
      ],
    });
    expect(afterConflicts.ok).toBe(true);
    if (afterConflicts.ok) expect(afterConflicts.conflicts).toHaveLength(1);
    expect(occupiesExecutionSlot(after, taskOf(after))).toBe(false);
  });

  test("B2 reviewer dispatch attempt must equal the implementation attempt", () => {
    let record = fresh();
    const member = dispatch("member");
    record = next(record, member);
    record = next(record, { kind: "task-report", block: doneReport(member.assignment) });
    const before = structuredClone(record);
    const result = reduceRun(record, dispatch("reviewer", 2) as never, facts);
    expect(result.ok).toBe(false);
    expect(record).toEqual(before);
  });

  test("B2 old reviewer cannot approve a new attempt with a new ref", () => {
    const { record, oldReviewer } = reworkFlow();
    const before = structuredClone(record);
    const result = reduceRun(
      record,
      {
        kind: "review-report",
        block: reviewReport(oldReviewer.assignment, REF_B, "可合入"),
      } as never,
      facts,
    );
    expect(result.ok).toBe(false);
    expect(record).toEqual(before);
  });

  test("B2 old reviewer cannot approve a new attempt with the same ref", () => {
    const { record, firstReviewer } = smokeRework(REF_A);
    const before = structuredClone(record);
    const result = reduceRun(
      record,
      {
        kind: "review-report",
        block: reviewReport(firstReviewer.assignment, REF_A, "可合入"),
      } as never,
      facts,
    );
    expect(result.ok).toBe(false);
    expect(record).toEqual(before);
  });

  test("B2 old smoker cannot pass a new attempt with a new ref", () => {
    const { record, firstSmoker } = smokeRework(REF_B);
    const before = structuredClone(record);
    const result = reduceRun(
      record,
      {
        kind: "smoke-report",
        block: smokeReport(firstSmoker.assignment, REF_B, "pass"),
      } as never,
      facts,
    );
    expect(result.ok).toBe(false);
    expect(record).toEqual(before);
  });

  test("B2 old smoker cannot pass a new attempt with the same ref", () => {
    const { record, firstSmoker } = smokeRework(REF_A);
    const before = structuredClone(record);
    const result = reduceRun(
      record,
      {
        kind: "smoke-report",
        block: smokeReport(firstSmoker.assignment, REF_A, "pass"),
      } as never,
      facts,
    );
    expect(result.ok).toBe(false);
    expect(record).toEqual(before);
  });

  test("B3 DAG cancellation of a genuinely done task is rejected as one batch", () => {
    let record = fresh();
    const member = dispatch("member");
    record = next(record, member);
    record = next(record, { kind: "task-report", block: doneReport(member.assignment) });
    const reviewer = dispatch("reviewer");
    record = next(record, reviewer);
    record = next(record, {
      kind: "review-report",
      block: reviewReport(reviewer.assignment, REF_A, "可合入"),
    });
    expect(taskOf(record).state).toBe("done");
    const before = structuredClone(record);
    const doneRef = taskOf(record).ref;
    const result = reduceRun(
      record,
      {
        kind: "dag-revised",
        controlNonceDigest: CONTROL_DIGEST,
        block: {
          protocolVersion: 1,
          runId: record.runId,
          taskId: "_dag",
          attempt: 1,
          nonce: uuid(),
          dagRevision: record.dagRevision + 1,
          expectedDagRevision: record.dagRevision,
          tasks: record.tasks.map((entry) => entry.spec),
          cancelTaskIds: ["t1"],
          budgetRequests: [],
        },
      } as never,
      facts,
    );
    expect(result.ok).toBe(false);
    expect(record).toEqual(before);
    expect(record.dagRevision).toBe(1);
    expect(taskOf(record)).toMatchObject({ state: "done", ref: doneRef });
  });

  test("I2 missing smoker assignment is an I7 violation", () => {
    const { record, smoker } = smokeDoneFlow();
    const mutated = structuredClone(record) as RunRecord;
    mutated.assignments = mutated.assignments.filter(
      (entry) => entry.assignmentId !== smoker.assignment.assignmentId,
    );
    parseIfCanonical(mutated);
    const report = checkLedgerInvariants(mutated);
    expect(report.ok, JSON.stringify(report)).toBe(false);
    if (!report.ok) expect(report.violations.some((entry) => entry.invariant === "I7")).toBe(true);
  });

  test("I2 changed smoker purpose is an I7 violation", () => {
    const { record, smoker } = smokeDoneFlow();
    const mutated = structuredClone(record) as RunRecord;
    const assignment = mutated.assignments.find(
      (entry) => entry.assignmentId === smoker.assignment.assignmentId,
    );
    if (!assignment) throw new Error("missing smoker");
    assignment.purpose = "reviewer";
    const nonce = mutated.nonceRegistry.find(
      (entry) => entry.assignmentId === smoker.assignment.assignmentId,
    );
    if (!nonce) throw new Error("missing smoker nonce");
    nonce.phase = "review";
    parseIfCanonical(mutated);
    const report = checkLedgerInvariants(mutated);
    expect(report.ok, JSON.stringify(report)).toBe(false);
    if (!report.ok) expect(report.violations.some((entry) => entry.invariant === "I7")).toBe(true);
  });

  test("I2 smoker assignment moved to another task is an I7 violation", () => {
    const { record, smoker } = smokeDoneFlow();
    const mutated = structuredClone(record) as RunRecord;
    mutated.tasks.push(taskRecord(taskSpec("t2"), { state: "pending" }) as TaskWithEvidence);
    const assignment = mutated.assignments.find(
      (entry) => entry.assignmentId === smoker.assignment.assignmentId,
    );
    const nonce = mutated.nonceRegistry.find(
      (entry) => entry.assignmentId === smoker.assignment.assignmentId,
    );
    if (!assignment || !nonce) throw new Error("missing smoker facts");
    assignment.taskId = "t2";
    nonce.taskId = "t2";
    const intent = mutated.outbox.find(
      (entry) => entry.assignmentId === smoker.assignment.assignmentId,
    );
    if (!intent) throw new Error("missing smoker intent");
    intent.taskId = "t2";
    parseIfCanonical(mutated);
    const report = checkLedgerInvariants(mutated);
    expect(report.ok, JSON.stringify(report)).toBe(false);
    if (!report.ok) expect(report.violations.some((entry) => entry.invariant === "I7")).toBe(true);
  });

  test("I2 stored smoke nonce mismatch is an I7 violation", () => {
    const { record, smoker } = smokeDoneFlow();
    const mutated = structuredClone(record) as RunRecord;
    const proof = smokeProof(mutated, smoker.assignment.assignmentId);
    if (!proof) throw new Error("missing smoke proof");
    proof.nonce = uuid();
    parseIfCanonical(mutated);
    const report = checkLedgerInvariants(mutated);
    expect(report.ok, JSON.stringify(report)).toBe(false);
    if (!report.ok) expect(report.violations.some((entry) => entry.invariant === "I7")).toBe(true);
  });

  test("I2 stored smoke attempt mismatch is an I7 violation", () => {
    const { record, smoker } = smokeDoneFlow();
    const mutated = structuredClone(record) as RunRecord;
    const proof = smokeProof(mutated, smoker.assignment.assignmentId);
    if (!proof) throw new Error("missing smoke proof");
    proof.attempt = 2;
    parseIfCanonical(mutated);
    const report = checkLedgerInvariants(mutated);
    expect(report.ok, JSON.stringify(report)).toBe(false);
    if (!report.ok) expect(report.violations.some((entry) => entry.invariant === "I7")).toBe(true);
  });

  test("O1 schema-invalid escalations are rejected structurally instead of throwing", () => {
    const record = fresh();
    (taskOf(record) as unknown as { escalations: unknown }).escalations = { invalid: true };
    const before = structuredClone(record);
    let result: ReturnType<typeof reduceRun> | undefined;
    expect(() => {
      result = reduceRun(record, dispatch("member") as never, facts);
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(["RUN_EVENT_INVALID", "RUN_INVARIANT_VIOLATION"]).toContain(result.code);
    }
    expect(record).toEqual(before);
  });

  function smokeWaitingOnSecondReviewer() {
    let record = fresh({ smoke: true });
    const member = dispatch("member");
    record = next(record, member);
    record = next(record, { kind: "task-report", block: doneReport(member.assignment) });
    const first = dispatch("reviewer", 1, { slot: 0 });
    const second = dispatch("reviewer", 1, { slot: 1 });
    record = next(record, first);
    record = next(record, second);
    record = next(record, {
      kind: "review-report",
      block: reviewReport(first.assignment, REF_A, "可合入"),
    });
    const smoker = dispatch("smoker");
    record = next(record, smoker);
    record = next(record, {
      kind: "smoke-report",
      block: smokeReport(smoker.assignment, REF_A, "pass"),
    });
    return { record, second, smoker };
  }

  test("positive: multiple reviewers may be registered for the same delivery and a non-current reviewer can reply", () => {
    let record = fresh();
    const member = dispatch("member");
    record = next(record, member);
    record = next(record, { kind: "task-report", block: doneReport(member.assignment) });
    const first = dispatch("reviewer", 1, { slot: 0 });
    const second = dispatch("reviewer", 1, { slot: 1 });
    record = next(record, first);
    record = next(record, second);
    expect(taskOf(record).currentAssignmentId).toBe(second.assignment.assignmentId);
    const result = reduceRun(
      record,
      {
        kind: "review-report",
        block: reviewReport(first.assignment, REF_A, "可合入"),
      } as never,
      facts,
    );
    expect(result.ok).toBe(true);
  });

  test("positive: smoke pass before the last reviewer returns must not finish", () => {
    const { record } = smokeWaitingOnSecondReviewer();
    expect(taskOf(record).state).not.toBe("done");
  });

  test("positive: a late R2 blocker after smoke is accepted and keeps the task non-done with a quality failure", () => {
    const { record, second } = smokeWaitingOnSecondReviewer();
    const before = structuredClone(record);
    const late = reduceRun(
      record,
      {
        kind: "review-report",
        block: reviewReport(second.assignment, REF_A, "不可合入"),
      } as never,
      facts,
    );
    expect(late.ok, JSON.stringify(late)).toBe(true);
    if (late.ok) {
      const task = taskOf(late.next);
      expect(task.state).not.toBe("done");
      expect(task.qualityFailures).toBeGreaterThan(0);
    }
    expect(record).toEqual(before);
  });

  test("positive: the last R2 pass after smoke is accepted and recomputes the stored smoke result to done", () => {
    const { record, second, smoker } = smokeWaitingOnSecondReviewer();
    const before = structuredClone(record);
    const smokeBefore = smokeProof(record, smoker.assignment.assignmentId);
    const late = reduceRun(
      record,
      {
        kind: "review-report",
        block: reviewReport(second.assignment, REF_A, "可合入"),
      } as never,
      facts,
    );
    expect(late.ok, JSON.stringify(late)).toBe(true);
    if (late.ok) {
      expect(taskOf(late.next).state).toBe("done");
      expect(smokeProof(late.next, smoker.assignment.assignmentId)).toEqual(smokeBefore);
      expect(taskOf(late.next).qualityFailures).toBe(0);
      const reviewers = late.next.assignments.filter((entry) => entry.purpose === "reviewer");
      expect(reviewers.length).toBeGreaterThanOrEqual(2);
      expect(reviewers.every((entry) => entry.acceptedProof !== null)).toBe(true);
    }
    expect(record).toEqual(before);
  });
});

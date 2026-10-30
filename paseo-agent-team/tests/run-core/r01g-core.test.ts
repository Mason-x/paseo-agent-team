import { describe, expect, test } from "vitest";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import { reduceRun } from "../../shared/domain/run-engine/reducer";
import {
  type RunRecord,
  RunRecordSchema,
  RunStoredTaskReportSchema,
} from "../../shared/schemas/run-engine/ledger";
import {
  RunTaskDagBlockSchema,
  RunTaskReportBlockSchema,
} from "../../shared/schemas/run-engine/protocol";
import { NORMAL_RUN_LEDGER } from "../fixtures/run-engine";

const facts = { now: "2026-10-29T00:00:00.000Z", newId: () => crypto.randomUUID() };

function base(): RunRecord {
  return RunRecordSchema.parse(structuredClone(NORMAL_RUN_LEDGER));
}

describe("R01g core invariants", () => {
  test("acceptedProof is the only task evidence source; mirrors are schema-reserved", () => {
    const record = base();
    expect(checkLedgerInvariants(record)).toEqual({ ok: true });
    const mirrored = structuredClone(record) as RunRecord & { report?: unknown };
    mirrored.tasks[0]!.report = { status: "done" };
    const parsed = RunRecordSchema.safeParse(mirrored);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.includes("report"))).toBe(true);
    }
  });

  test("a historical accepted proof is idempotent before live authorization", () => {
    const record = base();
    const assignment = record.assignments.find(
      (entry) => entry.acceptedProof !== null && entry.purpose === "member",
    );
    if (!assignment) throw new Error("fixture producer");
    const proof = RunStoredTaskReportSchema.parse(assignment.acceptedProof);
    const { messageId: _messageId, ...wire } = proof;
    const block = RunTaskReportBlockSchema.parse(wire);
    const before = structuredClone(record);
    const result = reduceRun(record, { kind: "task-report", block }, facts);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next).toEqual(before);
  });

  test("DAG cannot cancel a done task as one batch", () => {
    const record = base();
    const done = record.tasks.find((task) => task.state === "done");
    if (!done) throw new Error("fixture done task");
    const before = structuredClone(record);
    const event = {
      kind: "dag-revised" as const,
      controlNonceDigest: "a".repeat(64),
      cancelIntents: [],
      preparedCancelIntents: [],
      block: RunTaskDagBlockSchema.parse({
        protocolVersion: 1,
        runId: record.runId,
        taskId: "_dag",
        attempt: 1,
        nonce: crypto.randomUUID(),
        dagRevision: record.dagRevision + 1,
        expectedDagRevision: record.dagRevision,
        tasks: record.tasks.map((task) => task.spec),
        cancelTaskIds: [done.spec.id],
        budgetRequests: [],
      }),
    };
    const result = reduceRun(record, event, facts);
    expect(result.ok).toBe(false);
    expect(record).toEqual(before);
  });

  test("malformed core fields are rejected structurally, never thrown", () => {
    const record = base() as unknown as { tasks: Array<{ escalations: unknown }> };
    record.tasks[0]!.escalations = { invalid: true };
    let outcome: ReturnType<typeof reduceRun> | undefined;
    expect(() => {
      outcome = reduceRun(record as never, { kind: "run-paused" }, facts);
    }).not.toThrow();
    expect(outcome?.ok).toBe(false);
  });
});

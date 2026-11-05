import { sha256Hex } from "../../../server/run-engine/digest";
import {
  COORDINATOR_DUTY,
  COORDINATOR_SEAT_ID,
  withDagControl,
} from "../../../shared/domain/run-engine/dag-admission";
import type { RunRecord } from "../../../shared/schemas/run-engine/ledger";
import type { RunTaskDagBlock } from "../../../shared/schemas/run-engine/protocol";
import {
  AT_CREATED,
  assignmentsForRun,
  noncesForRun,
  REPO_ID,
  RUN_ID,
  spec,
  withLedger,
} from "../../fixtures/run-engine/base";

export const DAG_NONCE = "6f1c2a44-3b7e-4f0a-9a11-0000000000f1";
export const COORDINATOR_AGENT = "agent-coord";
export const PLAN_MESSAGE_ID = "ffffffff-ffff-4fff-8fff-fffffffffff1";

export type BootstrapOptions = {
  runId?: string;
  /** Put a plan request that has gone out to the coordinator in the outbox. */
  planRequest?: boolean;
};

/**
 * A Run that has just been created: bootstrapping, no tasks, no assignments, a coordinator seat
 * with its agent, the control nonce for the first DAG issued (as a digest) and, if asked, the plan
 * request that went out to the coordinator. The worker seats are the shared normal ledger's:
 * seat-b1 implements (tier B), seat-b2 reviews (tier A); both with a budget.
 */
export function bootstrapRun(options: BootstrapOptions = {}): RunRecord {
  const runId = options.runId ?? RUN_ID;
  const fresh = options.runId !== undefined;
  const record = withLedger(
    fresh
      ? {
          runId,
          revision: 1,
          previousDigest: "",
          assignments: assignmentsForRun(runId),
          nonceRegistry: noncesForRun(runId),
        }
      : {},
  );
  record.lifecycle = "bootstrapping";
  record.dagRevision = 0;
  record.tasks = [];
  record.assignments = [];
  record.outbox = [];
  record.nonceRegistry = [];
  record.resources = [];
  record.decisions = [];
  record.alerts = [];
  record.roster.push({
    seatId: COORDINATOR_SEAT_ID,
    tier: "S",
    agentId: COORDINATOR_AGENT,
    channelId: "claude",
    duties: [COORDINATOR_DUTY],
    enabled: true,
  });
  record.budgets.entries.push({
    scope: "seat",
    subjectId: "seat-b2",
    limit: 6,
    reserved: 0,
    confirmed: 0,
    observedTurns: 0,
  });
  if (options.planRequest) {
    // A plan request is a `wake`; the schema wants a task id, and there is no task yet.
    record.outbox.push({
      id: "intent-plan-1",
      kind: "wake",
      recipient: COORDINATOR_AGENT,
      messageId: PLAN_MESSAGE_ID,
      idempotencyKey: `plan:${runId}:1`,
      payloadHash: "8".repeat(64),
      templateVersion: 1,
      state: "confirmed",
      recoverySendCount: 0,
      createdAt: AT_CREATED,
      confirmedAt: AT_CREATED,
      localCancellation: null,
      taskId: "plan",
      assignmentId: null,
      semanticArgs: { purpose: "plan" },
    } as RunRecord["outbox"][number]);
  }
  return withDagControl(record, {
    nonceDigest: sha256Hex(DAG_NONCE),
    issuedAt: AT_CREATED,
    acceptedAt: null,
  });
}

type TaskSpec = RunTaskDagBlock["tasks"][number];

/** Two tasks, t2 after t1, each writing its own file; the repository id is the caller's choice. */
export function planTasks(repoId: string = REPO_ID): TaskSpec[] {
  const scope = (file: string) => [{ repoId, kind: "file", path: file, access: "write" }];
  return [
    spec("t1", "Core API surface", { scopes: scope("src/t1.ts") }) as unknown as TaskSpec,
    spec("t2", "Core implementation", {
      deps: ["t1"],
      scopes: scope("src/t2.ts"),
    }) as unknown as TaskSpec,
  ];
}

export function dagBlock(
  runId: string = RUN_ID,
  tasks: TaskSpec[] = planTasks(),
  overrides: Record<string, unknown> = {},
): RunTaskDagBlock {
  return {
    protocolVersion: 1,
    runId,
    taskId: "_dag",
    attempt: 1,
    nonce: DAG_NONCE,
    dagRevision: 1,
    expectedDagRevision: 0,
    tasks,
    cancelTaskIds: [],
    budgetRequests: [],
    ...overrides,
  } as RunTaskDagBlock;
}

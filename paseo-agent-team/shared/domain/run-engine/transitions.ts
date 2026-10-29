import type {
  RunAssignment,
  RunCancellationEvidence,
  RunEffectIntent,
  RunEventReceipt,
  RunNonceEntry,
  RunRecord,
  RunTaskRecord,
} from "../../schemas/run-engine/ledger";
import type {
  RunDecisionBlock,
  RunReviewReportBlock,
  RunSmokeReportBlock,
  RunTaskDagBlock,
  RunTaskReportBlock,
} from "../../schemas/run-engine/protocol";

/** Report/review/smoke data kept in the task's passthrough extension fields. */
export type RunStoredTaskReport = RunTaskReportBlock;
export type RunStoredReview = Pick<RunReviewReportBlock, "reviewedRef" | "verdict" | "blockers"> & {
  reviewerAgentId: string;
  reviewerSeatId: string;
  /** The reviewer assignment; omitted only for legacy fixtures/records created before R03a. */
  assignmentId?: string;
  /** Which gate phase produced this review; a smoke-phase block still blocks done. */
  phase?: "review" | "smoke";
  probes?: RunReviewReportBlock["probes"];
};
export type RunStoredSmokeReport = RunSmokeReportBlock;
export type RunTaskWithEvidence = RunTaskRecord & {
  report?: RunStoredTaskReport;
  reviews?: RunStoredReview[];
  smokeReport?: RunStoredSmokeReport;
};

export type RunDispatchEvent = {
  kind: "task-dispatched";
  taskId: string;
  assignment: RunAssignment;
  nonce: RunNonceEntry;
  intent: RunEffectIntent;
  claims?: readonly RunRecord["resources"][number][];
};

/** Derived ledger facts are not public reducer commands. */
export const RUN_COUNTER_EVENTS = {
  reworkCount: "rework_started",
  qualityFailures: "quality_failed",
  evidenceReturns: "evidence_returned",
} as const;

export function assignmentPhase(
  assignment: Pick<RunAssignment, "purpose">,
): "implementation" | "review" | "smoke" {
  return assignment.purpose === "reviewer"
    ? "review"
    : assignment.purpose === "smoker"
      ? "smoke"
      : "implementation";
}

/** All assignment purposes are delivered by dispatch; archive/wake/reopen are separate effects. */
export function dispatchIntentMatches(assignment: RunAssignment, intent: RunEffectIntent): boolean {
  return (
    intent.kind === "dispatch" &&
    intent.assignmentId === assignment.assignmentId &&
    intent.taskId === assignment.taskId &&
    intent.messageId === assignment.messageId &&
    intent.recipient === assignment.agentId
  );
}

/**
 * The complete reducer event vocabulary. Forged gate results (`review-passed`, `force-done`) are
 * deliberately absent: the reducer consumes raw protocol blocks and runs the gates itself.
 */
export type RunReducerEvent =
  | { kind: "dag-accepted"; block: RunTaskDagBlock }
  | { kind: "dag-revised"; block: RunTaskDagBlock; controlNonceDigest: string }
  | RunDispatchEvent
  | { kind: "turn-started"; assignmentId: string; agentId: string; turnId: string }
  | { kind: "turn-ended"; assignmentId: string; endedEventKey: string }
  | { kind: "task-report"; block: RunTaskReportBlock }
  | { kind: "review-report"; block: RunReviewReportBlock }
  | { kind: "smoke-report"; block: RunSmokeReportBlock }
  | { kind: "decision"; block: RunDecisionBlock }
  | {
      kind: "cancel-requested";
      taskIds: readonly string[];
      reason: string;
      cancelIntentId: string;
      controlNonceDigest: string;
    }
  | {
      kind: "cancellation-checked";
      taskId: string;
      evidence: RunCancellationEvidence;
      decisionId: string;
    }
  | { kind: "run-paused" }
  | { kind: "run-resumed" }
  | { kind: "run-finished" }
  | { kind: "run-cancelled"; reason: string; controlNonceDigest: string }
  | { kind: "observation-recorded"; receipt: RunEventReceipt };

export const RUN_REDUCER_EVENT_KINDS = [
  "dag-accepted",
  "dag-revised",
  "task-dispatched",
  "turn-started",
  "turn-ended",
  "task-report",
  "review-report",
  "smoke-report",
  "decision",
  "cancel-requested",
  "cancellation-checked",
  "run-paused",
  "run-resumed",
  "run-finished",
  "run-cancelled",
  "observation-recorded",
] as const;

/** Event kinds that B deliberately does not implement; reject loudly instead of ignoring. */
export const BATCH_B_UNSUPPORTED = [
  "work-accepted",
  "review-passed",
  "smoke-passed",
  "dependency-satisfied",
  "force-done",
  "force-transition",
  "dispatch-requested",
] as const;

export type RunFactSource = {
  now: string;
  newId: (kind: string) => string;
};

export function taskById(record: RunRecord, taskId: string): RunTaskWithEvidence | undefined {
  return record.tasks.find((task) => task.spec.id === taskId) as RunTaskWithEvidence | undefined;
}

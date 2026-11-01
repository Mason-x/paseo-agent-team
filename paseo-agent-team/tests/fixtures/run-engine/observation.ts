// Observation/wake inputs: event storms, permission and irreversible approvals, out-of-ledger
// activity, a legacy Run without a ledger, and a finished Run with an open end-of-phase decision.
import {
  AT_CREATED,
  AT_UPDATED,
  assignmentsForRun,
  DECISION_D4,
  DECISION_D6,
  NORMAL_RUN_LEDGER,
  noncesForRun,
  spec,
  t1,
  t2,
  t3,
  taskRecord,
  withLedger,
} from "./base";
import type { LedgerFixture, RunTaskRecord } from "./types";

/** RE6.5 / Y12: 50 redeliveries across 4 turns plus unknown-turn events; request counts must not scale. */
export const EVENT_STORM_50: readonly {
  seq: number;
  id: string;
  kind: "turn_ended";
  agentId: string;
  turnId: string | null;
  at: string;
}[] = Array.from({ length: 50 }, (_, index) => ({
  seq: index + 1,
  id: `evt-storm-${String(index + 1).padStart(2, "0")}`,
  kind: "turn_ended",
  agentId: "agent-b1",
  turnId: index < 40 ? `turn-storm-${index % 4}` : null,
  at: AT_UPDATED,
}));

/** RE6.6 / Y14: a permission prompt arrived while an intent was in flight; freeze, never answer. */
export const PERMISSION_PENDING_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-per",
  nonceRegistry: noncesForRun("run-rec0re-per"),
  assignments: assignmentsForRun("run-rec0re-per"),
  revision: 27,
  tasks: [
    t1,
    { ...t2, phase: "implementation", waitingReason: "permission-pending" } as RunTaskRecord,
    t3,
  ],
  events: [
    ...NORMAL_RUN_LEDGER.events,
    {
      seq: 8,
      kind: "permission_requested",
      at: AT_UPDATED,
      payload: { taskId: "t2", agentId: "agent-b1", requestId: "perm-1" },
    },
  ],
  decisions: [],
  alerts: [
    {
      alertId: "alert-permission",
      state: "open",
      severity: "warning",
      summary: "Permission request needs a human; the engine never responds to it.",
      createdAt: AT_UPDATED,
      acknowledgedAt: null,
      resolvedAt: null,
    },
  ],
});

/** RE6.6 / Y14: irreversible work waiting for an approval record; it must not be dispatched. */
export const IRREVERSIBLE_UNAPPROVED_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-irr",
  nonceRegistry: noncesForRun("run-rec0re-irr").filter((entry) => entry.taskId === "t1"),
  revision: 28,
  tasks: [
    t1,
    taskRecord(
      spec("t2", "Publish release", {
        irreversible: {
          kind: "push",
          target: "refs/heads/main",
          description: "publish the release branch",
          artifactRef: null,
        },
      }),
      { state: "ready", waitingReason: "awaiting-approval", attempts: 0 },
    ),
    t3,
  ],
  resources: [],
  assignments: assignmentsForRun("run-rec0re-irr").filter((entry) => entry.taskId === "t1"),
  outbox: NORMAL_RUN_LEDGER.outbox.filter((entry) => entry.taskId === "t1"),
  eventReceipts: NORMAL_RUN_LEDGER.eventReceipts,
  approvals: [],
});

/** RE4.8 / Y17: a message that does not correspond to any recorded assignment. */
export const EXTERNAL_ACTIVITY_CASE = {
  kind: "out-of-ledger-activity",
  agentId: "agent-b1",
  turnId: "turn-external-1",
  messageId: "msg-external-1",
  at: AT_UPDATED,
  assignmentExists: false,
  engineAction: "detect-and-warn",
  countsAsProgress: false,
} as const;

/** RE1.9 / Y17: a Run started before the engine was enabled has labels but no ledger. */
export const LEGACY_RUN_WITHOUT_LEDGER = {
  runId: "run-legacy-0001",
  nonceRegistry: noncesForRun("run-legacy-0001"),
  assignments: assignmentsForRun("run-legacy-0001"),
  hasLedger: false,
  displaySource: "labels",
  engineAdoption: "none",
  labels: { "agent-team.engine": "0", "agent-team.teamId": "team-legacy" },
} as const;

/** RE6.1 / Y13: the DAG finished; the only open decision is the end-of-phase D6. */
export const FINISHED_DECISION_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-fin",
  revision: 30,
  lifecycle: "finished",
  tasks: [t1],
  resources: [],
  assignments: assignmentsForRun("run-rec0re-fin").filter((entry) => entry.taskId === "t1"),
  outbox: NORMAL_RUN_LEDGER.outbox.filter((entry) => entry.taskId === "t1"),
  nonceRegistry: noncesForRun("run-rec0re-fin").filter((entry) => entry.taskId === "t1"),
  eventReceipts: NORMAL_RUN_LEDGER.eventReceipts,
  decisions: [
    {
      decisionId: DECISION_D6,
      category: "D6",
      controlNonceDigest: "d".repeat(64),
      state: "open",
      answer: null,
      dedupeKey: "run-rec0re-fin|D6|phase-end",
      subjectId: null,
      summary: "Phase complete; awaiting strategic close-out.",
      createdAt: AT_UPDATED,
      answeredAt: null,

      cancelIntents: null,
      resolution: null,
    },
    {
      decisionId: DECISION_D4,
      category: "D4",
      controlNonceDigest: "d".repeat(64),
      state: "answered",
      answer: { action: "increase-budget", taskIds: [], answeredAt: AT_UPDATED },
      dedupeKey: "run-rec0re-fin|D4|budget-final",
      subjectId: "seat-s1",
      summary: "Budget increase approved before the last task.",
      createdAt: AT_CREATED,
      answeredAt: AT_UPDATED,

      cancelIntents: null,
      resolution: null,
    },
  ],
});

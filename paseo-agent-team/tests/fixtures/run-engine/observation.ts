// Observation/wake inputs: event storms, permission and irreversible approvals, out-of-ledger
// activity, a legacy Run without a ledger, and a finished Run with an open end-of-phase decision.
import { AT_CREATED, AT_UPDATED, NORMAL_RUN_LEDGER, review, T1, T2, T3, withLedger } from "./base";
import type { LedgerFixture } from "./types";

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
  revision: 27,
  tasks: [T1, { ...T2, phase: "permission-pending" }, T3],
  events: [
    ...NORMAL_RUN_LEDGER.events,
    {
      seq: 8,
      id: "evt-perm-1",
      kind: "permission_requested",
      at: AT_UPDATED,
      taskId: "T2",
      agentId: "agent-b1",
      requestId: "perm-1",
    },
  ],
  decisions: [],
  alerts: [
    {
      id: "alert-permission",
      severity: "warning",
      code: "permission-pending",
      message: "Permission request needs a human; the engine never responds to it.",
      taskId: "T2",
      at: AT_UPDATED,
      acked: false,
    },
  ],
});

/** RE6.6 / Y14: irreversible work waiting for an approval record; it must not be dispatched. */
export const IRREVERSIBLE_UNAPPROVED_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-irr",
  revision: 28,
  tasks: [
    T1,
    {
      ...T2,
      status: "ready",
      phase: "awaiting-approval",
      attempts: [],
      workspace: null,
      irreversible: { reason: "publish release branch", approvalId: null },
    },
    T3,
  ],
  resources: [],
  assignments: [],
  outbox: [],
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
  tasks: [
    T1,
    {
      ...T2,
      status: "done",
      phase: "done",
      ref: { kind: "git-commit", value: "b7e4d10" },
      reviews: [review()],
    },
    {
      ...T3,
      status: "done",
      deps: ["T2"],
      phase: "done",
      ref: { kind: "git-commit", value: "e1a9c33" },
      reviews: [review({ reviewedRef: { kind: "git-commit", value: "e1a9c33" } })],
    },
  ],
  resources: [],
  assignments: [],
  decisions: [
    {
      id: "dec-phase-end",
      kind: "D6",
      state: "open",
      reason: "phase complete; awaiting strategic close-out",
      createdAt: AT_UPDATED,
    },
    {
      id: "dec-budget-final",
      kind: "D4",
      state: "answered",
      reason: "budget increase approved before the last task",
      createdAt: AT_CREATED,
      answeredAt: AT_UPDATED,
    },
  ],
  outbox: [],
});

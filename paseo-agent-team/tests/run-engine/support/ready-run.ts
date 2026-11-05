import type { RunRecord } from "../../../shared/schemas/run-engine/ledger";
import {
  ASSIGNMENT_T2,
  assignmentsForRun,
  INTENT_T2,
  NONCE_T2,
  noncesForRun,
  RUN_ID,
  withLedger,
} from "../../fixtures/run-engine/base";

/**
 * The shared normal ledger with t2 put back to `ready`: nothing assigned, nothing claimed, seat-b1
 * (agent-b1) free. Pass `runId` and `repoId` for a record a real store can hold and a real
 * repository can verify: the scopes of every task then name that repository.
 */
export function readyRun(
  options: { runId?: string; repoId?: string; evidenceRoot?: string } = {},
): RunRecord {
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
  const t2 = record.tasks.find((task) => task.spec.id === "t2");
  if (!t2) throw new Error("fixture lost t2");
  Object.assign(t2, {
    state: "ready",
    phase: undefined,
    currentAssignmentId: null,
    attempts: 0,
  });
  record.assignments = record.assignments.filter((entry) => entry.assignmentId !== ASSIGNMENT_T2);
  record.nonceRegistry = record.nonceRegistry.filter((entry) => entry.nonce !== NONCE_T2);
  record.outbox = record.outbox.filter((entry) => entry.id !== INTENT_T2);
  record.resources = [];
  if (options.evidenceRoot !== undefined) {
    // The finished task's stored proof must stay under the new root or the ledger invariants refuse it.
    const from = record.policy.evidenceRoot;
    record.policy.evidenceRoot = options.evidenceRoot;
    const rebase = (value: string) =>
      value.startsWith(`${from}/`) ? `${options.evidenceRoot}${value.slice(from.length)}` : value;
    for (const entry of record.assignments) {
      const proof = entry.acceptedProof as {
        evidence?: { artifactPath: string }[];
        checks?: { evidencePath: string }[];
      } | null;
      for (const item of proof?.evidence ?? []) item.artifactPath = rebase(item.artifactPath);
      for (const item of proof?.checks ?? []) item.evidencePath = rebase(item.evidencePath);
    }
  }
  if (options.repoId !== undefined) {
    for (const task of record.tasks) {
      for (const scope of task.spec.scopes) scope.repoId = options.repoId;
    }
  }
  return record;
}

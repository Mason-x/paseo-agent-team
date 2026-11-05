import type { RunRecord } from "../../../shared/schemas/run-engine/ledger";
import {
  assignmentsForRun,
  INTENT_T1,
  INTENT_T2,
  MESSAGE_T1,
  MESSAGE_T2,
  noncesForRun,
  withLedger,
} from "../../fixtures/run-engine/base";

export const RECIPIENT = "agent-b1";
export const PROMPT_T2 = "T2 prompt: implement src/t2.ts and report with the strict block.";

/**
 * A first-revision record whose t2 dispatch intent is still `prepared` (nothing sent yet), with the
 * payload hash bound to `PROMPT_T2`. Everything else is the shared normal ledger, so the schema and
 * ledger invariants keep applying to the result.
 */
export function preparedRun(
  runId: string,
  hash: string,
  overrides: { t2?: Partial<RunRecord["outbox"][number]> } = {},
): RunRecord {
  const record = withLedger({
    runId,
    revision: 1,
    previousDigest: "",
    resources: [],
    assignments: assignmentsForRun(runId),
    nonceRegistry: noncesForRun(runId),
  });
  const t2 = record.outbox.find((intent) => intent.id === INTENT_T2);
  if (!t2) throw new Error("fixture lost the t2 intent");
  Object.assign(t2, { state: "prepared", confirmedAt: null, payloadHash: hash, ...overrides.t2 });
  return record;
}

export { INTENT_T1, INTENT_T2, MESSAGE_T1, MESSAGE_T2 };

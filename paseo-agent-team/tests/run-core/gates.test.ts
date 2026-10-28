import { describe, expect, test } from "vitest";
import {
  checkEvidenceGate,
  checkReviewGate,
  checkSmokeGate,
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

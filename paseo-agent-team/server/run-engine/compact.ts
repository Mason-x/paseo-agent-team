import {
  applyCompaction,
  type CompactionLimits,
  planCompaction,
} from "../../shared/domain/run-engine/compaction";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import { sha256Hex } from "./digest";
import type { RunStore } from "./store";

/**
 * Compacts the old prefix of a Run's `events` into its checkpoint (`shared/domain/run-engine/compaction.ts`).
 * It is its own commit, never merged with another write, and it commits only a record that passes the
 * ledger invariants, so a mistake in the boundary rule leaves the Run as it was.
 */

export type CompactorOptions = {
  store: Pick<RunStore, "update">;
  clock?: { now(): string };
  limits?: Partial<CompactionLimits>;
  log?: (message: string, detail?: unknown) => void;
};

export function createCompactor(options: CompactorOptions) {
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const log = options.log ?? (() => undefined);

  return {
    /** True when a compaction was committed. Never throws. */
    async compactIfNeeded(runId: string, input: { bytesHigh: boolean }): Promise<boolean> {
      try {
        let committed = false;
        await options.store.update(runId, (current) => {
          const plan = planCompaction(current, {
            bytesHigh: input.bytesHigh,
            limits: options.limits,
          });
          if (plan === null) return null;
          const historyDigest = sha256Hex(
            JSON.stringify({
              previous: current.checkpoint?.historyDigest ?? null,
              events: plan.dropped,
            }),
          );
          const next = applyCompaction(current, {
            throughSeq: plan.throughSeq,
            historyDigest,
            now: clock.now(),
          });
          const report = checkLedgerInvariants(next);
          if (!report.ok) {
            log(`compaction of ${runId} would break the ledger; not written`, report.violations[0]);
            return null;
          }
          committed = true;
          return next;
        });
        return committed;
      } catch (error) {
        log(`could not compact ${runId}`, error);
        return false;
      }
    },
  };
}

export type Compactor = ReturnType<typeof createCompactor>;

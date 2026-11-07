import { reduceRun } from "../../shared/domain/run-engine/reducer";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import type { EngineDriver } from "./driver";
import type { RunStore } from "./store";

/**
 * Pause and resume of one Run, as engine code. Nothing registers this as an RPC (that is a separate
 * decision, B4 in the notes): it is the function a later control would call, and the tests exercise
 * it directly.
 *
 * Both are the reducer's own events (`run-paused`, `run-resumed`), committed in one store update, so
 * the ledger decides what is allowed: only an `active` Run pauses, only a `paused` Run resumes. Asking
 * for the state a Run is already in is not an error and changes nothing, so a repeated press or a
 * restart in the middle cannot pause or resume twice.
 *
 * What a pause does is already in the executor: while the lifecycle is `paused` nothing new is
 * dispatched and no `prepared` message is sent (`effects.ts`), but reads of the host, the taking in of
 * a report that arrives and the settling of a delivery whose result was unknown all go on. What a
 * resume does is ask the driver to push the Run on, which re-reads the host first, settles what
 * arrived meanwhile, sends what was held back once, and dispatches.
 */

export type LifecycleOutcome =
  | { status: "applied"; lifecycle: RunRecord["lifecycle"]; revision: number }
  /** The Run was already in the state asked for; nothing was written. */
  | { status: "unchanged"; lifecycle: RunRecord["lifecycle"] }
  /** The ledger does not allow it from the Run's current lifecycle. */
  | { status: "refused"; lifecycle: RunRecord["lifecycle"]; reason: string }
  | { status: "run-unavailable" };

export type LifecycleOptions = {
  store: Pick<RunStore, "get" | "update">;
  /** Used after a resume only. Absent, a resume writes and pushes nothing. */
  driver?: Pick<EngineDriver, "retryRun">;
  clock?: { now(): string };
  log?: (message: string, detail?: unknown) => void;
};

export function createLifecycleControl(options: LifecycleOptions) {
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const log = options.log ?? (() => undefined);

  async function move(
    runId: string,
    event: "run-paused" | "run-resumed",
  ): Promise<LifecycleOutcome> {
    const target: RunRecord["lifecycle"] = event === "run-paused" ? "paused" : "active";
    const holder: { outcome: LifecycleOutcome } = { outcome: { status: "run-unavailable" } };
    let written: Awaited<ReturnType<RunStore["update"]>>;
    try {
      written = await options.store.update(runId, (current) => {
        if (current.lifecycle === target) {
          holder.outcome = { status: "unchanged", lifecycle: current.lifecycle };
          return null;
        }
        const reduced = reduceRun(
          current,
          { kind: event },
          { now: clock.now(), newId: () => "unused" },
        );
        if (!reduced.ok) {
          holder.outcome = {
            status: "refused",
            lifecycle: current.lifecycle,
            reason: String(reduced.params.reason ?? reduced.code),
          };
          return null;
        }
        holder.outcome = { status: "applied", lifecycle: target, revision: 0 };
        return reduced.next;
      });
    } catch (error) {
      log(`could not ${event === "run-paused" ? "pause" : "resume"} ${runId}`, error);
      return { status: "run-unavailable" };
    }
    if (holder.outcome.status === "applied" && written.status === "committed") {
      holder.outcome = { ...holder.outcome, revision: written.record.revision };
    }
    return holder.outcome;
  }

  return {
    pause: (runId: string): Promise<LifecycleOutcome> => move(runId, "run-paused"),

    async resume(runId: string): Promise<LifecycleOutcome> {
      const outcome = await move(runId, "run-resumed");
      if (outcome.status === "applied" && options.driver) {
        try {
          await options.driver.retryRun(runId, { afterWrite: true });
        } catch (error) {
          // The resume is committed; a lost push is picked up by the next recovery or kick.
          log(`engine could not push ${runId} after a resume`, error);
        }
      }
      return outcome;
    },
  };
}

export type LifecycleControl = ReturnType<typeof createLifecycleControl>;

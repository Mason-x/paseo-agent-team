import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  runBudgetRpc,
  runCancelRpc,
  runDecideRpc,
  runKickRpc,
  runPauseRpc,
  runReplanRpc,
  runResumeRpc,
} from "../../../shared/rpc/run-engine";
import { type ControlState, createControlRunner, newRequestId } from "./control-runner";
import type { ReasonField } from "./reason-drafts";

/**
 * The controls of one Run: `run.replan`, `run.decide` (retry), `run.kick`, `run.pause` and `run.resume`. The state machine is
 * `control-runner.ts`; this only gives it the RPCs and mirrors its state for the component.
 * Switching to another run starts a fresh runner, so a notice never follows you to another Run.
 * `accepted` is told when the server took a reason the person wrote, so the page can drop that draft.
 */
export function useEngineControls(
  runId: string,
  refresh: () => Promise<void>,
  accepted?: (field: ReasonField) => void,
) {
  const replan = useRpc(runReplanRpc);
  const decide = useRpc(runDecideRpc);
  const kick = useRpc(runKickRpc);
  const pause = useRpc(runPauseRpc);
  const cancel = useRpc(runCancelRpc);
  const budget = useRpc(runBudgetRpc);
  const resume = useRpc(runResumeRpc);
  const [state, setState] = useState<ControlState>({ pending: null, notice: null });
  // The RPC functions and `refresh` may be new on every render; the runner reads the latest ones.
  const latest = useRef({ replan, decide, kick, pause, resume, cancel, budget, refresh, accepted });
  latest.current = { replan, decide, kick, pause, resume, cancel, budget, refresh, accepted };

  const runner = useMemo(
    () =>
      createControlRunner(
        {
          runId,
          replan: (input) => latest.current.replan(input),
          decide: (input) => latest.current.decide(input),
          kick: (input) => latest.current.kick(input),
          pause: (input) => latest.current.pause(input),
          cancel: (input) => latest.current.cancel(input),
          budget: (input) => latest.current.budget(input),
          resume: (input) => latest.current.resume(input),
          refresh: () => latest.current.refresh(),
          accepted: (field) => latest.current.accepted?.(field),
          newId: newRequestId,
        },
        setState,
      ),
    [runId],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new runId clears the old Run's notice
  useEffect(() => {
    setState({ pending: null, notice: null });
  }, [runId]);

  return { state, runner };
}

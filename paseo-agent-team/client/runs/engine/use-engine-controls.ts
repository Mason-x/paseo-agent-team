import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { runDecideRpc, runKickRpc, runReplanRpc } from "../../../shared/rpc/run-engine";
import { type ControlState, createControlRunner, newRequestId } from "./control-runner";

/**
 * The controls of one Run: `run.replan`, `run.decide` (retry) and `run.kick`. The state machine is
 * `control-runner.ts`; this only gives it the RPCs and mirrors its state for the component.
 * Switching to another run starts a fresh runner, so a notice never follows you to another Run.
 */
export function useEngineControls(runId: string, refresh: () => Promise<void>) {
  const replan = useRpc(runReplanRpc);
  const decide = useRpc(runDecideRpc);
  const kick = useRpc(runKickRpc);
  const [state, setState] = useState<ControlState>({ pending: null, notice: null });
  // The RPC functions and `refresh` may be new on every render; the runner reads the latest ones.
  const latest = useRef({ replan, decide, kick, refresh });
  latest.current = { replan, decide, kick, refresh };

  const runner = useMemo(
    () =>
      createControlRunner(
        {
          runId,
          replan: (input) => latest.current.replan(input),
          decide: (input) => latest.current.decide(input),
          kick: (input) => latest.current.kick(input),
          refresh: () => latest.current.refresh(),
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

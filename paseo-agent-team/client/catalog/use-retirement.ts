import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { teamPlanRpc } from "../../shared/rpc/team-plan";
import { createRetirementProbe, type RetirementProbe } from "./retirement";

/**
 * The capability probe for the host this plugin is talking to, with a stable identity so effects
 * and save handlers can depend on it. Every call asks the host again (.notes/274 E2): the answer is
 * about THIS host NOW, never a value remembered from an earlier screen.
 */
export function useRetirementProbe(): RetirementProbe {
  const send = useRpc(teamPlanRpc);
  const sendRef = useRef(send);
  sendRef.current = send;
  return useMemo(() => createRetirementProbe((input) => sendRef.current(input)), []);
}

/**
 * Whether the target host retires the legacy keys, for the one-line notices (.notes/274 E1) only.
 * It starts false and settles after the probe, so a notice never promises a deletion the host will
 * not perform. Writers do not read this: they await the probe themselves right before saving.
 */
export function useRetirement(probe: RetirementProbe, active: boolean): boolean {
  const [retires, setRetires] = useState(false);
  useEffect(() => {
    setRetires(false);
    if (!active) return;
    let live = true;
    void probe().then((value) => {
      if (live) setRetires(value);
    });
    return () => {
      live = false;
    };
  }, [probe, active]);
  return retires;
}

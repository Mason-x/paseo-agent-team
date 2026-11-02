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
 * It is null until the probe settles (a notice shows nothing yet, so it never promises a deletion
 * the host will not perform), then true/false. A failed or slow probe settles false. Writers do not
 * read this: they await the probe themselves right before saving.
 */
export function useRetirement(probe: RetirementProbe, active: boolean): boolean | null {
  const [retires, setRetires] = useState<boolean | null>(null);
  useEffect(() => {
    setRetires(null);
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

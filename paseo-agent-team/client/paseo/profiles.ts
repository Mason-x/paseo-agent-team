import { useCallback, useEffect, useState } from "react";
import type { PaseoAdapter, PaseoProfile } from "./adapter";

const CACHE_MS = 60_000;

type State =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; profiles: PaseoProfile[] };

export function useHostProfiles(adapter: PaseoAdapter | null): State & { reload: () => void } {
  const [state, setState] = useState<State>({ status: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!adapter) return;
    void nonce;
    let cancelled = false;
    void adapter
      .listProfiles()
      .then((profiles) => {
        if (!cancelled) setState({ status: "ready", profiles });
      })
      .catch((error) => {
        if (!cancelled) {
          setState({
            status: "error",
            error: error instanceof Error ? error.message : "无法读取 Paseo Profile",
          });
        }
      });
    const timer = setTimeout(() => setNonce((value) => value + 1), CACHE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [adapter, nonce]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setNonce((value) => value + 1);
  }, []);

  return { ...state, reload };
}

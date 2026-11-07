import { useEffect, useState } from "react";
import { AppState } from "react-native";

/** False while the app is in the background or inactive (on the web: the tab is hidden). */
export function isVisibleAppState(state: string | null | undefined): boolean {
  return state !== "background" && state !== "inactive";
}

/**
 * Whether the page is in front. A poll that only serves the screen stops while it is not, and asks
 * again at once when it is back, so a hidden tab costs the host nothing.
 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => isVisibleAppState(AppState.currentState));
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setVisible(isVisibleAppState(state)),
    );
    return () => subscription.remove();
  }, []);
  return visible;
}

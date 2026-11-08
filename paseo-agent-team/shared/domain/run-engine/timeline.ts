import { EVENT_CAUSE_UNKNOWN, EVENT_CAUSE_ZH, type EventCause } from "../../zh/run-engine-waiting";
import { displayText } from "./display-text";

/**
 * The cause line under each history event. Keyed by the event kind the server sent; a kind this page
 * has no words for (a newer server) gets the general sentence and keeps its own kind visible, so
 * nothing is hidden and nothing throws.
 */
export function eventCause(kind: string): EventCause & { known: boolean } {
  if (Object.hasOwn(EVENT_CAUSE_ZH, kind)) {
    return { ...(EVENT_CAUSE_ZH[kind] as EventCause), known: true };
  }
  return {
    label: `${EVENT_CAUSE_UNKNOWN.label}（${displayText(kind, 64, "?")}）`,
    cause: EVENT_CAUSE_UNKNOWN.cause,
    known: false,
  };
}

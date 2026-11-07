import {
  RUN_HISTORY_CURSOR_EXPIRED,
  RunGetOutputSchema,
  type RunHistoryPage,
} from "../../schemas/run-engine/rpc";
import { type EngineState, engineGetState } from "./view";

/**
 * What the Runs page keeps for one (host, run): the last answer it could show, plus the older
 * history pages the user asked for. `run.get` may answer `unchanged`, which carries no run; the view
 * must keep showing the last ready state instead of flashing to an empty progress (AC22). Pure: no
 * I/O, no timers, so the merge rules are testable without a renderer.
 */
export type EngineSession = {
  state: EngineState | null;
  /** Older history pages, newest page first (the order `buildEngineModel` expects). */
  older: readonly RunHistoryPage[];
};

export const EMPTY_SESSION: EngineSession = { state: null, older: [] };

export type SessionStep = {
  session: EngineSession;
  /** True when the answer cannot be shown and the caller must ask again without `knownRevision`. */
  needFull: boolean;
};

function readyRevision(state: EngineState | null): number | null {
  return state?.kind === "ready" ? state.run.revision : null;
}

function sameNotices(held: EngineState | null, next: EngineState): boolean {
  if (held?.kind !== "ready" || next.kind !== "ready") return false;
  return (
    held.notices.length === next.notices.length &&
    held.notices.every((notice, index) => notice === next.notices[index])
  );
}

/** A normal refresh: `run.get` with the revision the caller currently shows. */
export function applyRefresh(session: EngineSession, raw: unknown): SessionStep {
  const next = engineGetState(raw);
  if (next.kind === "unchanged") {
    // Only trust "unchanged" against the revision we actually hold. Anything else means the
    // caller's idea of the revision is stale or lost, so it must fetch the full view.
    if (readyRevision(session.state) === next.revision) return { session, needFull: false };
    return { session, needFull: true };
  }
  if (next.kind === "ready") {
    const sameRevision = readyRevision(session.state) === next.run.revision;
    const sameRun = session.state?.kind === "ready" && session.state.run.runId === next.run.runId;
    // The same Run at the revision already shown: nothing changed, so nothing repaints. Reconnecting,
    // or a full answer asked for after an `unchanged` that did not line up, lands here.
    if (sameRun && sameRevision && sameNotices(session.state, next)) {
      return { session, needFull: false };
    }
    // The first page is always the newest 50. Older pages loaded before are only contiguous with
    // it while nothing was appended, so any new revision drops them and the user pages again.
    return {
      session: { state: next, older: sameRun && sameRevision ? session.older : [] },
      needFull: false,
    };
  }
  // missing / corrupt / unknown-version / refresh-plugin replace what was shown: a run that can no
  // longer be read must not keep presenting its last good numbers as current.
  return { session: { state: next, older: [] }, needFull: false };
}

/** Result of `run.get` with a `historyCursor`. */
export function applyOlder(session: EngineSession, raw: unknown): SessionStep {
  const parsed = RunGetOutputSchema.safeParse(raw);
  if (!parsed.success || parsed.data.status !== "ready") {
    // Could not read an older page: keep what is shown. The caller surfaces its own error.
    return { session, needFull: false };
  }
  const expired = parsed.data.issues.some((issue) => issue.code === RUN_HISTORY_CURSOR_EXPIRED);
  if (expired) {
    // The server restarted paging at the newest page; that page is now the base, loaded pages go.
    const next = engineGetState(raw);
    return { session: { state: next, older: [] }, needFull: false };
  }
  const current = session.state;
  if (current?.kind !== "ready" || current.run.runId !== parsed.data.run.runId) {
    return { session, needFull: true };
  }
  if (current.run.revision !== parsed.data.run.revision) {
    // The run moved while paging; the page may not line up with what is shown.
    return { session, needFull: true };
  }
  return {
    session: { state: current, older: [...session.older, parsed.data.history] },
    needFull: false,
  };
}

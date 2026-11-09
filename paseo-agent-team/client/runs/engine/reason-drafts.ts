import { useMemo, useRef, useState } from "react";

/**
 * The reasons a person types on the Runs page (a new plan, cancelling the Run), kept where a poll
 * cannot take them away. A poll that cannot show the Run (the read failed, the page was offline,
 * an `unchanged` answer that did not line up) draws the controls off the screen, text box included;
 * the words must still be there when the Run comes back. The boxes stay uncontrolled (`ImeTextInput`
 * seeds them once and never gets a `value`), so a CJK composition is never interrupted.
 *
 * A draft belongs to one Run: the key holds the Run's id, so another Run never sees it.
 */
export type ReasonField = "replan" | "cancel-run";

export type ReasonDrafts = {
  /** What the box is seeded with when it is drawn. */
  initial(field: ReasonField): string;
  /** Changes when the draft is dropped, or for another Run, so a box still on the screen is drawn again. */
  revision(field: ReasonField): string;
  /** What the person has written so far: what a press on the button sends. */
  read(field: ReasonField): string;
  write(field: ReasonField, text: string): void;
  /** The server took the reason: nothing is kept, and the box is empty. */
  clear(field: ReasonField): void;
};

const SEPARATOR = "\u0000";

export function createReasonDrafts(
  runId: string,
  texts: Map<string, string>,
  clears: Map<string, number>,
  onClear: () => void,
): ReasonDrafts {
  const key = (field: ReasonField) => `${runId}${SEPARATOR}${field}`;
  return {
    initial: (field) => texts.get(key(field)) ?? "",
    revision: (field) => `${runId}:${clears.get(key(field)) ?? 0}`,
    read: (field) => texts.get(key(field)) ?? "",
    write: (field, text) => {
      texts.set(key(field), text);
    },
    clear: (field) => {
      texts.delete(key(field));
      clears.set(key(field), (clears.get(key(field)) ?? 0) + 1);
      onClear();
    },
  };
}

/** The drafts of the Run the pane shows. They live in the pane, which a poll never unmounts. */
export function useReasonDrafts(runId: string): ReasonDrafts {
  const texts = useRef(new Map<string, string>());
  const clears = useRef(new Map<string, number>());
  const [, redraw] = useState(0);
  return useMemo(
    () => createReasonDrafts(runId, texts.current, clears.current, () => redraw((n) => n + 1)),
    [runId],
  );
}

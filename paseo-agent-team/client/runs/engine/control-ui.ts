import { useMemo, useState } from "react";
import type { ControlsView } from "../../../shared/domain/run-engine/controls";

/**
 * What a person has half-done on the controls of a Run, kept where a poll cannot take it away: the
 * number of turns typed for a seat, and the confirmation that is open. A poll that cannot show the
 * Run draws the controls off the screen; the box would come back showing 4 and the confirmation would
 * be gone, and the person might think it was sent. Like `reason-drafts.ts` it lives in the pane,
 * which a poll never unmounts, and it belongs to one Run (every key holds the Run's id).
 *
 * The number box stays uncontrolled (`ImeTextInput` seeds it once). The open confirmation is held as
 * ids (not as the offer) so what it says is read from the Run as it is now; a confirmation whose
 * offer is gone is dropped (`stillOffered`).
 */
export const BUDGET_DEFAULT = "4";

export type OpenConfirm =
  | { kind: "retry"; decisionId: string }
  | { kind: "cancel-task"; decisionId: string }
  | { kind: "budget"; seatId: string; by: number }
  | { kind: "cancel-run" };

export type ControlUi = {
  /** What the turns box of a seat is seeded with when it is drawn. */
  budgetInitial(seatId: string): string;
  /** Changes for another Run, so a box still on the screen is drawn again. */
  budgetRevision(seatId: string): string;
  /** What the person has typed so far: what a press on the button reads. */
  budgetRead(seatId: string): string;
  budgetWrite(seatId: string, text: string): void;
  /** The confirmation that is open for this Run, if any. The same object until it changes. */
  open(): OpenConfirm | null;
  ask(confirm: OpenConfirm): void;
  close(): void;
  /** For `useSyncExternalStore`: the controls draw again when the open confirmation changes. */
  subscribe(listener: () => void): () => void;
};

export type ControlUiStore = {
  texts: Map<string, string>;
  open: Map<string, OpenConfirm>;
  listeners: Set<() => void>;
};

export function newControlUiStore(): ControlUiStore {
  return { texts: new Map(), open: new Map(), listeners: new Set() };
}

const SEPARATOR = "\u0000";

export function createControlUi(runId: string, store: ControlUiStore): ControlUi {
  const budgetKey = (seatId: string) => `${runId}${SEPARATOR}budget${SEPARATOR}${seatId}`;
  const changed = () => {
    for (const listener of [...store.listeners]) listener();
  };
  return {
    budgetInitial: (seatId) => store.texts.get(budgetKey(seatId)) ?? BUDGET_DEFAULT,
    budgetRevision: (seatId) => `${runId}:${seatId}`,
    budgetRead: (seatId) => store.texts.get(budgetKey(seatId)) ?? BUDGET_DEFAULT,
    budgetWrite: (seatId, text) => {
      store.texts.set(budgetKey(seatId), text);
    },
    open: () => store.open.get(runId) ?? null,
    ask: (confirm) => {
      store.open.set(runId, confirm);
      changed();
    },
    close: () => {
      if (store.open.delete(runId)) changed();
    },
    subscribe: (listener) => {
      store.listeners.add(listener);
      return () => {
        store.listeners.delete(listener);
      };
    },
  };
}

/** The half-done controls of the Run the pane shows. They live in the pane, which a poll never unmounts. */
export function useControlUi(runId: string): ControlUi {
  const [store] = useState(newControlUiStore);
  return useMemo(() => createControlUi(runId, store), [runId, store]);
}

/** Whether what the confirmation is about is still on offer in the Run as the page now reads it. */
export function stillOffered(view: ControlsView, confirm: OpenConfirm): boolean {
  switch (confirm.kind) {
    case "retry":
      return view.retries.some((offer) => offer.decisionId === confirm.decisionId);
    case "cancel-task":
      return view.cancels.some((offer) => offer.decisionId === confirm.decisionId);
    case "budget":
      return view.budgets.some((offer) => offer.seatId === confirm.seatId);
    case "cancel-run":
      return view.cancelRun;
  }
}

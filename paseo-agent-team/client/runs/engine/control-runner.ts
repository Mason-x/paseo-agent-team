import {
  type ActionNotice,
  type BudgetOffer,
  budgetNotice,
  type CancelOffer,
  cancelRunNotice,
  decideNotice,
  kickNotice,
  pauseNotice,
  type RetryOffer,
  replanNotice,
  resumeNotice,
  transportNotice,
} from "../../../shared/domain/run-engine/controls";
import { RUN_CONTRACT_VERSION } from "../../../shared/schemas/run-engine/rpc";
import type {
  RunBudgetInput,
  RunBudgetOutput,
  RunCancelInput,
  RunCancelOutput,
  RunDecideInput,
  RunDecideOutput,
  RunKickInput,
  RunKickOutput,
  RunLifecycleInput,
  RunLifecycleOutput,
  RunReplanInput,
  RunReplanOutput,
} from "../../../shared/schemas/run-engine/rpc-actions";
import { runEngineZh as zh } from "../../../shared/zh/run-engine";

/**
 * The state machine behind the Runs page controls, apart from React so it can be tested.
 *
 *  - One control at a time. A second press while one is in flight does nothing (the buttons are also
 *    disabled; this is the guard for two presses in the same frame).
 *  - A request id is made once per request and kept until the server answered, so asking again after
 *    a transport error is the same request and cannot act twice (`replayed` says so). The id is tied
 *    to what was asked: another reason, or another revision, is another request.
 *  - Whatever the server answered, the Run is read again; a `revision-conflict` therefore ends with
 *    the page showing the newer Run and a sentence asking the person to look and try again.
 *  - A transport error is not an answer: the server may have acted, and the page is not refreshed on
 *    its account.
 */

/** The most a reason may carry: what the request holds, and what the reason boxes let be typed. */
export const REASON_MAX_LENGTH = 600;

export type ControlKey =
  | "replan"
  | "kick"
  | "pause"
  | "resume"
  | "cancel"
  | `budget:${string}`
  | `decide:${string}`;

export type ControlState = {
  pending: ControlKey | null;
  notice: ActionNotice | null;
  /**
   * The control whose answer `notice` is, so the page can say it next to that control's button: the
   * controls are a long column and a sentence at the end of it is below the screen for the person who
   * pressed a button near the top. Absent until a control has been pressed.
   */
  noticeFrom?: ControlKey;
};

export type ControlDeps = {
  runId: string;
  replan(input: RunReplanInput): Promise<RunReplanOutput>;
  decide(input: RunDecideInput): Promise<RunDecideOutput>;
  kick(input: RunKickInput): Promise<RunKickOutput>;
  pause(input: RunLifecycleInput): Promise<RunLifecycleOutput>;
  cancel(input: RunCancelInput): Promise<RunCancelOutput>;
  budget(input: RunBudgetInput): Promise<RunBudgetOutput>;
  resume(input: RunLifecycleInput): Promise<RunLifecycleOutput>;
  /** Reads the Run again. A failure here is the page's own error, not the control's. */
  refresh(): Promise<void>;
  /**
   * The server took a reason a person wrote (applied, or the same request answered again), so the page
   * may drop its draft. A refusal or a transport error is not this: the words are kept for another try.
   */
  accepted?(field: "replan" | "cancel-run"): void;
  newId(): string;
};

export function createControlRunner(deps: ControlDeps, onChange: (state: ControlState) => void) {
  let state: ControlState = { pending: null, notice: null };
  const requestIds = new Map<string, string>();

  const set = (next: ControlState) => {
    state = next;
    onChange(state);
  };

  function requestIdFor(signature: string): string {
    const known = requestIds.get(signature);
    if (known !== undefined) return known;
    const made = deps.newId();
    requestIds.set(signature, made);
    return made;
  }

  async function run(
    key: ControlKey,
    signature: string | null,
    call: () => Promise<ActionNotice>,
  ): Promise<boolean> {
    if (state.pending !== null) return false;
    set({ pending: key, notice: null });
    let notice: ActionNotice;
    try {
      notice = await call();
      if (signature !== null) requestIds.delete(signature);
    } catch {
      notice = transportNotice();
    }
    set({ pending: null, notice, noticeFrom: key });
    if (notice.refresh) {
      try {
        await deps.refresh();
      } catch {
        // The page shows its own read error; the control's answer stands.
      }
    }
    return true;
  }

  return {
    get state(): ControlState {
      return state;
    },

    replan(reason: string, expectedRevision: number): Promise<boolean> {
      const text = reason.trim();
      if (text === "") return Promise.resolve(false);
      const signature = `replan:${expectedRevision}:${text}`;
      return run("replan", signature, async () => {
        const output = await deps.replan({
          runContractVersion: RUN_CONTRACT_VERSION,
          runId: deps.runId,
          requestId: requestIdFor(signature),
          expectedRevision,
          reason: text.slice(0, REASON_MAX_LENGTH),
        });
        if (output.status !== "rejected") deps.accepted?.("replan");
        return replanNotice(output);
      });
    },

    retry(offer: RetryOffer, expectedRevision: number): Promise<boolean> {
      const signature = `decide:${offer.decisionId}:${expectedRevision}`;
      return run(`decide:${offer.decisionId}`, signature, async () =>
        decideNotice(
          await deps.decide({
            runContractVersion: RUN_CONTRACT_VERSION,
            runId: deps.runId,
            requestId: requestIdFor(signature),
            expectedRevision,
            reason: offer.reason,
            decisionId: offer.decisionId,
            answer: { action: "retry" },
          }),
        ),
      );
    },

    cancelTask(offer: CancelOffer, expectedRevision: number): Promise<boolean> {
      const signature = `cancel:${offer.decisionId}:${expectedRevision}`;
      return run(`decide:${offer.decisionId}`, signature, async () =>
        decideNotice(
          await deps.decide({
            runContractVersion: RUN_CONTRACT_VERSION,
            runId: deps.runId,
            requestId: requestIdFor(signature),
            expectedRevision,
            reason: offer.reason,
            decisionId: offer.decisionId,
            answer: { action: "cancel" },
          }),
        ),
      );
    },

    /** The reason is written here, not typed: pausing is one press, with no text box. */
    pause(expectedRevision: number): Promise<boolean> {
      const signature = `pause:${expectedRevision}`;
      return run("pause", signature, async () =>
        pauseNotice(
          await deps.pause({
            runContractVersion: RUN_CONTRACT_VERSION,
            runId: deps.runId,
            requestId: requestIdFor(signature),
            expectedRevision,
            reason: zh.controls.pause.reason,
          }),
        ),
      );
    },

    /** The whole Run, with a reason the person wrote. Finished later, once the running turns have ended. */
    cancelRun(reason: string, expectedRevision: number): Promise<boolean> {
      const text = reason.trim();
      if (text === "") return Promise.resolve(false);
      const signature = `cancel-run:${expectedRevision}:${text}`;
      return run("cancel", signature, async () => {
        const output = await deps.cancel({
          runContractVersion: RUN_CONTRACT_VERSION,
          runId: deps.runId,
          requestId: requestIdFor(signature),
          expectedRevision,
          reason: text.slice(0, REASON_MAX_LENGTH),
        });
        if (output.status !== "rejected") deps.accepted?.("cancel-run");
        return cancelRunNotice(output);
      });
    },

    /** More turns for one seat; the reason is written by the page. */
    addBudget(offer: BudgetOffer, by: number, expectedRevision: number): Promise<boolean> {
      if (!Number.isInteger(by) || by < 1 || by > 64) return Promise.resolve(false);
      const signature = `budget:${offer.seatId}:${by}:${expectedRevision}`;
      return run(`budget:${offer.seatId}`, signature, async () =>
        budgetNotice(
          await deps.budget({
            runContractVersion: RUN_CONTRACT_VERSION,
            runId: deps.runId,
            requestId: requestIdFor(signature),
            expectedRevision,
            reason: offer.reason,
            seatId: offer.seatId,
            by,
          }),
        ),
      );
    },

    resume(expectedRevision: number): Promise<boolean> {
      const signature = `resume:${expectedRevision}`;
      return run("resume", signature, async () =>
        resumeNotice(
          await deps.resume({
            runContractVersion: RUN_CONTRACT_VERSION,
            runId: deps.runId,
            requestId: requestIdFor(signature),
            expectedRevision,
            reason: zh.controls.resume.reason,
          }),
        ),
      );
    },

    kick(): Promise<boolean> {
      return run("kick", null, async () =>
        kickNotice(
          await deps.kick({ runContractVersion: RUN_CONTRACT_VERSION, runId: deps.runId }),
        ),
      );
    },

    dismiss(): void {
      if (state.notice !== null) set({ pending: state.pending, notice: null });
    },
  };
}

export type ControlRunner = ReturnType<typeof createControlRunner>;

/** A UUID for one control press; prefer platform randomness when it is available. */
export function newRequestId(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto?.getRandomValues === "function") crypto.getRandomValues(bytes);
  else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

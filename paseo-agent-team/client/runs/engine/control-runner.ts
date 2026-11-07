import {
  type ActionNotice,
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
 *  - A transport error is not an answer: the notice says the request did not arrive and the page is
 *    not refreshed on its account.
 */

export type ControlKey = "replan" | "kick" | "pause" | "resume" | "cancel" | `decide:${string}`;

export type ControlState = {
  pending: ControlKey | null;
  notice: ActionNotice | null;
};

export type ControlDeps = {
  runId: string;
  replan(input: RunReplanInput): Promise<RunReplanOutput>;
  decide(input: RunDecideInput): Promise<RunDecideOutput>;
  kick(input: RunKickInput): Promise<RunKickOutput>;
  pause(input: RunLifecycleInput): Promise<RunLifecycleOutput>;
  cancel(input: RunCancelInput): Promise<RunCancelOutput>;
  resume(input: RunLifecycleInput): Promise<RunLifecycleOutput>;
  /** Reads the Run again. A failure here is the page's own error, not the control's. */
  refresh(): Promise<void>;
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
    set({ pending: null, notice });
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
      return run("replan", signature, async () =>
        replanNotice(
          await deps.replan({
            runContractVersion: RUN_CONTRACT_VERSION,
            runId: deps.runId,
            requestId: requestIdFor(signature),
            expectedRevision,
            reason: text.slice(0, 600),
          }),
        ),
      );
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
      return run("cancel", signature, async () =>
        cancelRunNotice(
          await deps.cancel({
            runContractVersion: RUN_CONTRACT_VERSION,
            runId: deps.runId,
            requestId: requestIdFor(signature),
            expectedRevision,
            reason: text.slice(0, 600),
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
      if (state.notice !== null) set({ ...state, notice: null });
    },
  };
}

export type ControlRunner = ReturnType<typeof createControlRunner>;

/** A request id for one control press: a UUID where the platform has one, a random string where not. */
export function newRequestId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  const part = () => Math.random().toString(16).slice(2, 10).padEnd(8, "0");
  return `req-${Date.now().toString(16)}-${part()}${part()}`;
}

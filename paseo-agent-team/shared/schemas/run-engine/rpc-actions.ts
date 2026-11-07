import { z } from "zod";
import { RunIdSchema } from "./ledger";
import { RUN_CONTRACT_VERSION, RunIssueViewSchema } from "./rpc";

/**
 * The three Run Engine controls P06 ships: `replan`, `decide` and `kick` (plan section 8, point 33).
 *
 * They are new, narrow RPCs on purpose. The shape-only `RunControlInput` / `RunApproveInput` /
 * `RunReconcileInput` in `rpc.ts` stay as they are for the later controls (pause, cancel, approval,
 * diagnosis): none of them can say "ask the coordinator for a new plan" or "answer decision X with
 * retry", and widening a pinned whitelist is a contract change that these do not need.
 *
 * Inputs are strict. Outputs are non-strict objects built from explicit fields, so nothing stored
 * (nonces, prompts, outbox arguments) can come out through them. A refusal is an answer, not a throw:
 * `status: "rejected"` with one error issue whose `code` is one of `RUN_ACTION_CODES`.
 */

const ContractShape = { runContractVersion: z.literal(RUN_CONTRACT_VERSION) };
const Text = (max: number) => z.string().min(1).max(max);

/** The names `capabilities.supportedControls` may carry for the controls that exist. */
export const RUN_ACTION_CONTROLS = ["replan", "decide", "kick", "pause", "resume"] as const;
export type RunActionControl = (typeof RUN_ACTION_CONTROLS)[number];

/**
 * Stable refusal codes (lower-case, hyphenated, like the other issue codes). `params` carries only
 * strings, numbers and booleans: `current` (the revision now), `lifecycle`, `category`, `reason`.
 */
export const RUN_ACTION_CODES = [
  // the Run
  "run-missing",
  "run-corrupt",
  "run-unknown-version",
  // the request
  "revision-conflict",
  "request-id-reused",
  // replan
  "replan-not-allowed",
  "plan-request-missing",
  "delivery-unresolved",
  "plan-unbuildable",
  // decide
  "decision-missing",
  "decision-answered",
  "decision-not-answerable",
  "action-unsupported",
  "task-not-releasable",
  "run-not-active",
  // pause and resume
  "lifecycle-not-allowed",
  // anything the ledger itself refuses
  "ledger-refused",
] as const;
export type RunActionCode = (typeof RUN_ACTION_CODES)[number];

export const RunActionStatusSchema = z.enum(["applied", "replayed", "rejected"]);
export type RunActionStatus = z.infer<typeof RunActionStatusSchema>;

const WriteShape = {
  ...ContractShape,
  runId: RunIdSchema,
  /** Chosen by the caller, kept per request: the same id again is the same request. */
  requestId: Text(128),
  /** The revision the caller last read. A different revision now is `revision-conflict`. */
  expectedRevision: z.number().int().nonnegative(),
  reason: Text(600),
};

// --- run.replan -----------------------------------------------------------------------------

export const RunReplanInputSchema = z.strictObject(WriteShape);
export type RunReplanInput = z.input<typeof RunReplanInputSchema>;

export const RunReplanOutputSchema = z.object({
  ...ContractShape,
  status: RunActionStatusSchema,
  /** The Run's revision after the call (the current one when rejected). */
  revision: z.number().int().nonnegative(),
  /** Which plan request this is: 1 is the launch's own, 2 the first replan. `null` when rejected. */
  epoch: z.number().int().min(2).nullable(),
  issues: z.array(RunIssueViewSchema).max(100),
});
export type RunReplanOutput = z.infer<typeof RunReplanOutputSchema>;

// --- run.decide -----------------------------------------------------------------------------

/** What a person can answer a decision with today. The other actions of the ledger come later. */
export const RUN_DECIDE_ACTIONS = ["retry", "cancel"] as const;
export const RunDecideAnswerSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("retry") }),
  z.strictObject({ action: z.literal("cancel") }),
]);
export type RunDecideAnswer = z.infer<typeof RunDecideAnswerSchema>;

export const RunDecideInputSchema = z.strictObject({
  ...WriteShape,
  decisionId: z.string().uuid(),
  answer: RunDecideAnswerSchema,
});
export type RunDecideInput = z.input<typeof RunDecideInputSchema>;

export const RunDecideOutputSchema = z.object({
  ...ContractShape,
  status: RunActionStatusSchema,
  revision: z.number().int().nonnegative(),
  decisionId: z.string().uuid(),
  /** The task the decision was about, when there is one. */
  taskId: Text(64).nullable(),
  /** For `cancel`: the task and every task that depended on it, now cancelled. */
  cancelledTaskIds: z.array(Text(64)).max(64).optional(),
  issues: z.array(RunIssueViewSchema).max(100),
});
export type RunDecideOutput = z.infer<typeof RunDecideOutputSchema>;

// --- run.pause / run.resume ------------------------------------------------------------------

/** Both take the same request: pause and resume differ only in the RPC they are sent to. */
export const RunLifecycleInputSchema = z.strictObject(WriteShape);
export type RunLifecycleInput = z.input<typeof RunLifecycleInputSchema>;

export const RunLifecycleOutputSchema = z.object({
  ...ContractShape,
  status: RunActionStatusSchema,
  /** The Run's revision after the call (the current one when rejected). */
  revision: z.number().int().nonnegative(),
  /** The lifecycle after the call; null when the Run cannot be read. */
  lifecycle: Text(32).nullable(),
  issues: z.array(RunIssueViewSchema).max(100),
});
export type RunLifecycleOutput = z.infer<typeof RunLifecycleOutputSchema>;

// --- run.kick -------------------------------------------------------------------------------

/** No `requestId` and no `expectedRevision`: a kick changes nothing a repeat would change again. */
export const RunKickInputSchema = z.strictObject({
  ...ContractShape,
  runId: RunIdSchema,
});
export type RunKickInput = z.input<typeof RunKickInputSchema>;

export const RUN_KICK_OUTCOMES = [
  /** Nothing was due: no work to send, nothing to settle. */
  "idle",
  "dispatched",
  /** A task is waiting for a seat. */
  "waiting",
  /** A task could not be sent; `reason` says why (a dirty tree, a lock, a budget). */
  "blocked",
  "finished",
  /** The Run is not live (finished, cancelled, paused or still waiting for its plan). */
  "not-active",
] as const;

export const RunKickOutputSchema = z.object({
  ...ContractShape,
  status: z.enum(["ok", "rejected"]),
  outcome: z.enum(RUN_KICK_OUTCOMES).nullable(),
  /** How many messages this kick sent to members. */
  dispatched: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  /** A short code such as `dispatch-blocked:workspace-dirty`; never a prompt or a nonce. */
  reason: Text(200).nullable(),
  issues: z.array(RunIssueViewSchema).max(100),
});
export type RunKickOutput = z.infer<typeof RunKickOutputSchema>;

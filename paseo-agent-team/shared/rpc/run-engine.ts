import { defineRpc } from "@getpaseo/plugin";
import {
  RunGetInputSchema,
  RunGetOutputSchema,
  RunListInputSchema,
  RunListOutputSchema,
} from "../schemas/run-engine/rpc";
import {
  RunCancelInputSchema,
  RunCancelOutputSchema,
  RunDecideInputSchema,
  RunDecideOutputSchema,
  RunKickInputSchema,
  RunKickOutputSchema,
  RunLifecycleInputSchema,
  RunLifecycleOutputSchema,
  RunReplanInputSchema,
  RunReplanOutputSchema,
} from "../schemas/run-engine/rpc-actions";

/**
 * Read-only Run Engine RPCs: list and get. Handlers must never dispatch, create, cancel or advance a
 * task; the contract has no input that could ask them to. The writing ones are below.
 */
export const runListRpc = defineRpc({
  name: "agent-team.run.list",
  input: RunListInputSchema,
  output: RunListOutputSchema,
});

export const runGetRpc = defineRpc({
  name: "agent-team.run.get",
  input: RunGetInputSchema,
  output: RunGetOutputSchema,
});

/**
 * Writing RPCs (P06). Each one changes a Run through the ledger and nothing else: none of them sends
 * a message from the handler itself, and none can say "done" for a task. Every refusal comes back as
 * an answer with a code, never as a thrown error.
 */
export const runReplanRpc = defineRpc({
  name: "agent-team.run.replan",
  input: RunReplanInputSchema,
  output: RunReplanOutputSchema,
});

export const runDecideRpc = defineRpc({
  name: "agent-team.run.decide",
  input: RunDecideInputSchema,
  output: RunDecideOutputSchema,
});

export const runPauseRpc = defineRpc({
  name: "agent-team.run.pause",
  input: RunLifecycleInputSchema,
  output: RunLifecycleOutputSchema,
});

export const runResumeRpc = defineRpc({
  name: "agent-team.run.resume",
  input: RunLifecycleInputSchema,
  output: RunLifecycleOutputSchema,
});

export const runCancelRpc = defineRpc({
  name: "agent-team.run.cancel",
  input: RunCancelInputSchema,
  output: RunCancelOutputSchema,
});

export const runKickRpc = defineRpc({
  name: "agent-team.run.kick",
  input: RunKickInputSchema,
  output: RunKickOutputSchema,
});

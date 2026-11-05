import { defineRpc } from "@getpaseo/plugin";
import {
  RunGetInputSchema,
  RunGetOutputSchema,
  RunListInputSchema,
  RunListOutputSchema,
} from "../schemas/run-engine/rpc";

/**
 * Read-only Run Engine RPCs. Handlers must never dispatch, create, cancel or advance a task; the
 * contract has no input that could ask them to.
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

import { defineRpc } from "@getpaseo/plugin";
import {
  DesignCancelInputSchema,
  DesignCancelOutputSchema,
  DesignContinueInputSchema,
  DesignContinueOutputSchema,
  DesignMarkSavedInputSchema,
  DesignMarkSavedOutputSchema,
  DesignPrepareSaveInputSchema,
  DesignPrepareSaveOutputSchema,
  DesignResultInputSchema,
  DesignResultOutputSchema,
  DesignSaveFailedInputSchema,
  DesignSaveFailedOutputSchema,
  DesignStartInputSchema,
  DesignStartOutputSchema,
  DesignStatusInputSchema,
  DesignStatusOutputSchema,
} from "../schemas/design";

/**
 * The eight design RPCs. Method names are wire-visible and fixed by the 08 contract: the prefix is
 * `agent-team.design.`; multi-word methods use kebab-case because the plugin SDK rejects uppercase.
 *
 * The main shared/rpc.ts re-export is owned by the 5A integration owner; see the handoff list.
 */
export const designStartRpc = defineRpc({
  name: "agent-team.design.start",
  input: DesignStartInputSchema,
  output: DesignStartOutputSchema,
});

export const designStatusRpc = defineRpc({
  name: "agent-team.design.status",
  input: DesignStatusInputSchema,
  output: DesignStatusOutputSchema,
});

export const designResultRpc = defineRpc({
  name: "agent-team.design.result",
  input: DesignResultInputSchema,
  output: DesignResultOutputSchema,
});

export const designPrepareSaveRpc = defineRpc({
  name: "agent-team.design.prepare-save",
  input: DesignPrepareSaveInputSchema,
  output: DesignPrepareSaveOutputSchema,
});

export const designMarkSavedRpc = defineRpc({
  name: "agent-team.design.mark-saved",
  input: DesignMarkSavedInputSchema,
  output: DesignMarkSavedOutputSchema,
});

export const designSaveFailedRpc = defineRpc({
  name: "agent-team.design.save-failed",
  input: DesignSaveFailedInputSchema,
  output: DesignSaveFailedOutputSchema,
});

export const designCancelRpc = defineRpc({
  name: "agent-team.design.cancel",
  input: DesignCancelInputSchema,
  output: DesignCancelOutputSchema,
});

export const designContinueRpc = defineRpc({
  name: "agent-team.design.continue",
  input: DesignContinueInputSchema,
  output: DesignContinueOutputSchema,
});
